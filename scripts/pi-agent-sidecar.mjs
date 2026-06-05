import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const ROLE_PROMPTS = {
  coordinator:
    "你是 Ploteo 文本工作流协调 Agent。只协调结构化文本工作，不管理文件、图片、视频或任务队列。",
  writer:
    "你是 Ploteo 编剧 Agent。严格遵守用户约束，输出完整、可拍摄、可被策划 Agent 解析的剧本。",
  planner:
    "你是 Ploteo 短剧策划 Agent。把完整剧本拆成专业短集，严格输出用户要求的 JSON，不要输出 Markdown。",
  reviewer:
    "你是 Ploteo 审校 Agent。检查结构、覆盖、时长与连续性，只输出修正结果和风险。",
  director:
    "你是 Ploteo 单集导演 Agent。生成可直接提交给视频模型的完整 Prompt，并保持跨集连续性。",
};

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

if (process.argv.includes("--healthcheck")) {
  send({ ok: true, runtime: "pi-agent", version: 1 });
  process.exit(0);
}

function createIsolatedLoader(systemPrompt, settingsManager) {
  const isolatedDir = join(tmpdir(), "ploteo-pi-isolated");
  return new DefaultResourceLoader({
    cwd: isolatedDir,
    agentDir: isolatedDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
}

async function run(request) {
  const { profile, secret, prompt, agentKind = "coordinator" } = request;
  if (!profile || !secret || !prompt) {
    throw new Error("Pi Agent 请求缺少模型配置、密钥或 Prompt");
  }

  const provider = `ploteo-${profile.id}`;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(provider, secret);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const api = profile.adapter === "openai-responses"
    ? "openai-responses"
    : "openai-completions";
  modelRegistry.registerProvider(provider, {
    name: profile.name,
    baseUrl: profile.baseUrl.replace(/\/+$/, ""),
    apiKey: secret,
    api,
    authHeader: true,
    models: [
      {
        id: profile.model,
        name: profile.model,
        api,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: Number(profile.defaults?.maxTokens ?? 8192),
      },
    ],
  });
  const model = modelRegistry.find(provider, profile.model);
  if (!model) throw new Error(`Pi Agent 无法注册模型 ${profile.model}`);

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = createIsolatedLoader(
    ROLE_PROMPTS[agentKind] ?? ROLE_PROMPTS.coordinator,
    settingsManager,
  );
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    model,
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    noTools: "all",
    thinkingLevel: "off",
  });

  let text = "";
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update"
      && event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(prompt);
    if (!text.trim()) {
      const last = [...session.messages].reverse().find((message) => message.role === "assistant");
      text = last?.content
        ?.filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n") ?? "";
    }
    if (!text.trim()) throw new Error("Pi Agent 没有返回文本内容");
    return text;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    send({ id: request.id, ok: true, text: await run(request) });
  } catch (error) {
    send({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    input.close();
  }
});
