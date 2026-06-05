import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const executable = resolve(
  process.argv[2]
    ?? `src-tauri/binaries/ploteo-pi-agent${process.platform === "win32" ? ".exe" : ""}`,
);
if (!existsSync(executable)) throw new Error(`Pi Agent sidecar 不存在：${executable}`);

const result = spawnSync(executable, ["--healthcheck"], {
  encoding: "utf8",
  timeout: 30_000,
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(result.stderr || `Pi Agent sidecar 退出码：${result.status}`);
}
const response = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
if (!response.ok || response.runtime !== "pi-agent") {
  throw new Error(`Pi Agent sidecar 健康检查失败：${result.stdout}`);
}
console.log(`Pi Agent sidecar healthcheck passed: ${executable}`);
