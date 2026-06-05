import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))
  ?.slice("--target=".length);
const requestedOutput = process.argv.find((argument) => argument.startsWith("--outfile="))
  ?.slice("--outfile=".length);

if (!requestedTarget && process.platform !== "win32" && process.platform !== "darwin") {
  throw new Error(`Ploteo 桌面端不支持在 ${process.platform} 上生成 sidecar`);
}
if (!requestedTarget && process.platform === "win32" && process.arch === "arm64") {
  throw new Error("Ploteo 不生成或支持 Windows ARM64 安装包");
}
const nativeTarget = process.platform === "win32"
  ? "bun-windows-x64-baseline"
  : process.arch === "arm64"
    ? "bun-darwin-arm64"
    : "bun-darwin-x64";
const target = requestedTarget ?? nativeTarget;

if (target === "bun-windows-arm64") {
  throw new Error("Ploteo 不生成或支持 Windows ARM64 安装包");
}

const extension = target.startsWith("bun-windows-") ? ".exe" : "";
const output = resolve(requestedOutput ?? `src-tauri/binaries/ploteo-pi-agent${extension}`);
mkdirSync(dirname(output), { recursive: true });

const args = [
  "build",
  "--compile",
  `--target=${target}`,
  "scripts/pi-agent-sidecar.mjs",
  "--outfile",
  output,
];
if (process.platform === "win32" && target.startsWith("bun-windows-")) {
  args.splice(2, 0, "--windows-hide-console");
}

const result = spawnSync("bun", args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piRequire = createRequire(piEntry);
const photonWasm = piRequire.resolve("@silvia-odwyer/photon-node/photon_rs_bg.wasm");
copyFileSync(photonWasm, resolve(dirname(output), "photon_rs_bg.wasm"));
