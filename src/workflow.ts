import {
  type AppState,
  type Asset,
  type Batch,
  type Episode,
  type EpisodeVersion,
  type Project,
  type ProjectWorkspace,
  type ScriptBeat,
  emptyProject,
  now,
  uid,
} from "./domain";

const sampleFragments = [
  "雨夜，林夏抱着一只旧纸箱冲进即将关门的便利店。她发现柜台后站着三年未见的周屿。",
  "周屿没有追问，只把热毛巾递给她。纸箱里传出一声轻响，里面是林夏父亲留下的旧录音机。",
  "停电突如其来。录音机却自己亮起，播出父亲最后一段录音：去旧码头，别相信穿灰色风衣的人。",
  "玻璃门外，一个灰色风衣的男人停下脚步。周屿拉住林夏，从便利店后门离开。",
  "两人跑进狭窄巷道。林夏质问周屿为什么知道后门，周屿承认这三年一直在替她父亲调查。",
  "他们来到旧码头仓库。录音机里第二段录音响起，提示钥匙藏在纸箱夹层。",
  "灰色风衣男人追到仓库，却只是把一封信放在地上。他说真正危险的人一直在林夏身边。",
  "林夏打开信，看见周屿与父亲的旧合照。周屿沉默片刻，转身锁上仓库门。",
];

export const demoScript = sampleFragments.join("\n\n");

const clampDuration = (text: string) =>
  Math.max(4, Math.min(15, Math.round(text.length / 12) + 4));

const buildPrompt = (
  summary: string,
  scene: string,
  dialogue: string,
  continuity: string,
) =>
  [
    `竖屏短剧镜头，${scene}。`,
    summary,
    `对白：${dialogue}`,
    `连续性：${continuity}`,
    "真实电影感表演，动作自然，镜头语言清晰。生成同步对白、环境音效和克制的背景音乐。",
  ].join("\n");

export function splitScript(script: string): Episode[] {
  const fragments = script
    .split(/\n\s*\n|\n|(?<=[。！？!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return fragments.map((sourceText, index) => {
    const scene = index < 3 ? "雨夜便利店" : index < 5 ? "潮湿巷道" : "旧码头仓库";
    const dialogue = sourceText.includes("：")
      ? sourceText.slice(sourceText.indexOf("：") + 1)
      : "以动作和短对白推进剧情";
    const continuity =
      index === 0
        ? "建立林夏、纸箱与雨夜状态"
        : `承接第 ${index} 集结尾动作、角色服装和关键道具位置`;
    return {
      id: uid("episode"),
      number: index + 1,
      title: `第 ${index + 1} 集`,
      sourceBeatIds: [],
      sourceText,
      summary: sourceText,
      scene,
      characters: index === 0 ? ["林夏"] : ["林夏", "周屿"],
      dialogue,
      rhythm: index % 2 === 0 ? "悬念建立，结尾留钩子" : "快速推进，动作收束",
      continuity,
      shotList: [],
      duration: clampDuration(sourceText),
      prompt: buildPrompt(sourceText, scene, dialogue, continuity),
      status: "draft",
      versions: [],
    };
  });
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] ?? raw;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("短剧策划 Agent 未返回 JSON 对象");
  }
  return JSON.parse(source.slice(start, end + 1));
}

export function buildWriterPrompt(project: Project): string {
  return [
    "你是 Ploteo 的编剧 Agent。请根据用户创意生成一份完整、可拍摄、可被后续短剧策划 Agent 结构化拆集的短剧剧本。",
    "",
    "硬性要求：",
    `- 目标短集数：${project.targetEpisodes || 8} 集。`,
    "- 每集最终视频时长为 4~15 秒，所以剧情节点必须短、明确、可视化。",
    `- 内容长短：${project.contentLength || "中等篇幅"}`,
    `- 统一风格：${project.style || "真实电影感"}`,
    "- 输出必须包含完整剧情，不要只给大纲。",
    "- 每个剧情节点必须有稳定且唯一的 beatId，格式 beat-001、beat-002……",
    "- 每个节点包含场景、人物、动作、关键对白和结尾钩子。",
    "- 只输出 JSON，不要 Markdown，不要解释。",
    "",
    "JSON Schema：",
    "{",
    '  "title": "剧名",',
    '  "premise": "世界观与故事前提",',
    '  "characters": [{"name":"角色名","description":"人物设定"}],',
    '  "beats": [',
    '    {"beatId":"beat-001","scene":"场景","characters":["角色"],"action":"可视化动作","dialogue":"关键对白","hook":"结尾钩子"}',
    "  ]",
    "}",
    "",
    `用户创意：${project.idea}`,
  ].join("\n");
}

export function parseWriterDraft(raw: string): {
  title: string;
  premise: string;
  beats: ScriptBeat[];
  script: string;
} {
  const parsed = extractJson(raw) as Record<string, unknown>;
  const rawBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
  if (!rawBeats.length) throw new Error("编剧 Agent 返回的 beats 为空");
  const seen = new Set<string>();
  const beats = rawBeats.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const id = asString(record.beatId, `beat-${String(index + 1).padStart(3, "0")}`);
    if (seen.has(id)) throw new Error(`编剧 Agent 返回了重复剧情节点 ${id}`);
    seen.add(id);
    return {
      id,
      scene: asString(record.scene, "未指定场景"),
      characters: Array.isArray(record.characters)
        ? record.characters.map((character) => asString(character)).filter(Boolean)
        : [],
      action: asString(record.action),
      dialogue: asString(record.dialogue, "无对白"),
      hook: asString(record.hook),
    };
  });
  if (beats.some((beat) => !beat.action)) {
    throw new Error("编剧 Agent 返回的剧情节点缺少可拍摄动作");
  }
  const title = asString(parsed.title, "未命名短剧");
  const premise = asString(parsed.premise);
  const script = [
    `剧名：${title}`,
    premise ? `故事前提：${premise}` : "",
    ...beats.map((beat) => [
      `[${beat.id}] ${beat.scene}`,
      `人物：${beat.characters.join("、") || "未指定"}`,
      `动作：${beat.action}`,
      `对白：${beat.dialogue}`,
      `钩子：${beat.hook || "自然承接下一节点"}`,
    ].join("\n")),
  ].filter(Boolean).join("\n\n");
  return { title, premise, beats, script };
}

export function buildPlannerPrompt(project: Project): string {
  return [
    "你是 Ploteo 的短剧策划 Agent。请把完整剧本自然拆成短集，并为每集生成导演可用的信息。",
    "",
    "硬性要求：",
    `- 目标短集数：尽量为 ${project.targetEpisodes || 8} 集；如果剧情自然需要，可以略微增减，但必须完整覆盖原始剧本。`,
    "- 每集 duration 必须是 4 到 15 秒之间的整数。",
    "- 每集必须包含 sourceBeatIds、sourceText、summary、scene、characters、dialogue、rhythm、continuity、shotList、prompt。",
    "- sourceBeatIds 只能引用下方剧情节点 ID；每个剧情节点必须至少被一集引用。",
    "- prompt 必须可直接给视频模型使用，包含镜头、角色、动作、对白、环境音、音效/配乐意图。",
    "- 不要本地剪辑思维，不要字幕文件，不要 TTS。声音由视频模型原生生成。",
    "- 只输出 JSON，不要 Markdown，不要解释。",
    "",
    "JSON Schema：",
    "{",
    '  "episodes": [',
    "    {",
    '      "number": 1,',
    '      "title": "第 1 集",',
    '      "sourceBeatIds": ["beat-001"],',
    '      "sourceText": "覆盖的原剧本文字",',
    '      "summary": "本集剧情",',
    '      "scene": "场景",',
    '      "characters": ["角色A"],',
    '      "dialogue": "对白或无对白说明",',
    '      "rhythm": "节奏和钩子",',
    '      "continuity": "与前后集的连续性要求",',
    '      "duration": 8,',
    '      "shotList": ["镜头1", "镜头2"],',
    '      "prompt": "视频生成 Prompt"',
    "    }",
    "  ]",
    "}",
    "",
    `统一风格：${project.style || "真实电影感"}`,
    `内容长短：${project.contentLength || "中等篇幅"}`,
    `剧情节点：${JSON.stringify(project.scriptBeats ?? [])}`,
    "",
    "完整剧本：",
    project.script,
  ].join("\n");
}

export function buildReviewerPrompt(project: Project, plannerOutput: string): string {
  return [
    "你是 Ploteo 审校 Agent。检查短剧策划结果并直接返回修正后的完整 JSON。",
    "硬性检查：",
    "- 每集 duration 为 4~15 秒整数。",
    "- sourceBeatIds 只能引用原始剧情节点，并且所有剧情节点至少覆盖一次。",
    "- 每集必须有场景、角色、对白、节奏、连续性、shotList 和可提交的视频 prompt。",
    "- 保持 JSON Schema 不变，只输出 JSON，不要解释。",
    `原始剧情节点：${JSON.stringify(project.scriptBeats ?? [])}`,
    "待审校策划结果：",
    plannerOutput,
  ].join("\n");
}

export function parseEpisodePlan(raw: string, expectedBeatIds: string[] = []): Episode[] {
  const parsed = extractJson(raw) as { episodes?: unknown[] };
  const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
  if (!episodes.length) {
    throw new Error("短剧策划 Agent 返回的 episodes 为空");
  }
  const planned = episodes.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const sourceText = asString(record.sourceText) || asString(record.summary, `第 ${index + 1} 集剧情`);
    const sourceBeatIds = Array.isArray(record.sourceBeatIds)
      ? record.sourceBeatIds.map((beatId) => asString(beatId)).filter(Boolean)
      : [];
    const summary = asString(record.summary, sourceText);
    const scene = asString(record.scene, "未指定场景");
    const characters = Array.isArray(record.characters)
      ? record.characters.map((character) => asString(character)).filter(Boolean)
      : [];
    const dialogue = asString(record.dialogue, "以动作和短对白推进剧情");
    const rhythm = asString(record.rhythm, "短促推进，结尾留钩子");
    const continuity = asString(record.continuity, index === 0 ? "建立角色、场景和核心道具" : `承接第 ${index} 集`);
    const shotList = Array.isArray(record.shotList)
      ? record.shotList.map((shot) => asString(shot)).filter(Boolean)
      : [];
    const duration = Math.max(4, Math.min(15, Math.round(asNumber(record.duration, 8))));
    const prompt = asString(record.prompt) || [
      `竖屏短剧镜头，${scene}。`,
      summary,
      shotList.length ? `分镜：${shotList.join("；")}` : "",
      `角色：${characters.join("、") || "按剧本角色"}`,
      `对白：${dialogue}`,
      `连续性：${continuity}`,
      "生成同步对白、环境音效和克制的背景音乐。",
    ].filter(Boolean).join("\n");
    const episode: Episode = {
      id: uid("episode"),
      number: Math.max(1, Math.round(asNumber(record.number, index + 1))),
      title: asString(record.title, `第 ${index + 1} 集`),
      sourceBeatIds,
      sourceText,
      summary,
      scene,
      characters,
      dialogue,
      rhythm,
      continuity,
      shotList,
      duration,
      prompt,
      status: "draft",
      versions: [],
    };
    return episode;
  }).sort((left, right) => left.number - right.number)
    .map((episode, index) => ({ ...episode, number: index + 1 }));
  if (expectedBeatIds.length) {
    const expected = new Set(expectedBeatIds);
    const referenced = new Set(planned.flatMap((episode) => episode.sourceBeatIds));
    const unknown = [...referenced].filter((beatId) => !expected.has(beatId));
    const missing = [...expected].filter((beatId) => !referenced.has(beatId));
    if (unknown.length) throw new Error(`短剧策划 Agent 引用了未知剧情节点：${unknown.join("、")}`);
    if (missing.length) throw new Error(`短剧策划 Agent 未覆盖剧情节点：${missing.join("、")}`);
  }
  return planned;
}

const preview = (hue: number) =>
  `linear-gradient(145deg, hsl(${hue} 38% 28%), hsl(${hue + 28} 48% 12%))`;

export function createDemoAssets(): Asset[] {
  return [
    {
      id: "asset-linxia",
      name: "林夏",
      kind: "character",
      prompt: "26 岁女性，利落短发，深色风衣，疲惫但警觉，电影角色定妆照",
      preview: preview(16),
      source: "generated",
      confirmed: false,
      containsRealFace: false,
    },
    {
      id: "asset-zhouyu",
      name: "周屿",
      kind: "character",
      prompt: "29 岁男性，浅色衬衫，克制沉静，略带秘密感，电影角色定妆照",
      preview: preview(198),
      source: "generated",
      confirmed: false,
      containsRealFace: false,
    },
    {
      id: "asset-store",
      name: "雨夜便利店",
      kind: "scene",
      prompt: "深夜街角便利店，雨水玻璃，室内暖色灯光，空旷安静",
      preview: preview(46),
      source: "generated",
      confirmed: true,
      containsRealFace: false,
    },
  ];
}

export function makeDemoState(state: AppState): AppState {
  const project = {
    ...emptyProject(),
    id: "demo-project",
    name: "雨夜录音机",
    idea: "一台旧录音机把久别重逢的两人卷入父亲留下的秘密。",
    script: demoScript,
    updatedAt: now(),
  };
  return {
    ...state,
    onboardingComplete: true,
    project,
    episodes: splitScript(demoScript),
    assets: createDemoAssets(),
    batches: [],
    workspaces: saveCurrentWorkspace(state).filter((workspace) => !isDemoWorkspace(workspace)),
    activity: [
      {
        id: uid("activity"),
        at: now(),
        message: "已创建演示项目并完成自然拆集",
        tone: "success",
      },
    ],
  };
}

export function isDemoWorkspace(workspace: ProjectWorkspace): boolean {
  return workspace.project.id === "demo-project"
    || (workspace.project.name === "雨夜录音机" && workspace.project.script === demoScript);
}

export function currentWorkspace(state: AppState): ProjectWorkspace {
  return {
    project: state.project,
    episodes: state.episodes,
    assets: state.assets,
    batches: state.batches,
    activity: state.activity,
  };
}

export function saveCurrentWorkspace(state: AppState): ProjectWorkspace[] {
  const current = currentWorkspace(state);
  if (!current.project.name.trim() && !current.project.directory.trim()) return state.workspaces;
  return [
    current,
    ...state.workspaces.filter((workspace) => workspace.project.id !== current.project.id),
  ];
}

export function listWorkspaces(state: AppState): ProjectWorkspace[] {
  return saveCurrentWorkspace(state);
}

export function openWorkspace(state: AppState, projectId: string): AppState {
  const workspaces = saveCurrentWorkspace(state);
  const workspace = workspaces.find((item) => item.project.id === projectId);
  if (!workspace) return state;
  return {
    ...state,
    onboardingComplete: true,
    ...workspace,
    workspaces,
  };
}

export function createWorkspace(state: AppState, name: string, directory: string): AppState {
  const project = {
    ...emptyProject(directory),
    name: name.trim(),
  };
  return {
    ...state,
    onboardingComplete: true,
    project,
    episodes: [],
    assets: [],
    batches: [],
    activity: [
      {
        id: uid("activity"),
        at: now(),
        message: "已创建本地项目",
        tone: "success",
      },
    ],
    workspaces: saveCurrentWorkspace(state),
  };
}

export function deleteWorkspace(state: AppState, projectId: string): AppState {
  const workspaces = saveCurrentWorkspace(state).filter((workspace) => workspace.project.id !== projectId);
  if (state.project.id !== projectId) {
    return addActivity({ ...state, workspaces }, "已从项目管理器移除项目", "success");
  }
  return {
    ...state,
    onboardingComplete: false,
    project: emptyProject(),
    episodes: [],
    assets: [],
    batches: [],
    workspaces,
    activity: [
      {
        id: uid("activity"),
        at: now(),
        message: "已删除当前项目，请选择或创建项目",
        tone: "success",
      },
    ],
  };
}

export function addActivity(
  state: AppState,
  message: string,
  tone: "info" | "success" | "warning" = "info",
): AppState {
  return {
    ...state,
    activity: [{ id: uid("activity"), at: now(), message, tone }, ...state.activity].slice(
      0,
      16,
    ),
  };
}

export function coverage(state: AppState) {
  const beatIds = state.project.scriptBeats?.map((beat) => beat.id) ?? [];
  if (beatIds.length) {
    const referenced = new Set(state.episodes.flatMap((episode) => episode.sourceBeatIds ?? []));
    const covered = beatIds.filter((beatId) => referenced.has(beatId)).length;
    return {
      complete: covered === beatIds.length,
      sourceChars: beatIds.length,
      coveredChars: covered,
    };
  }
  const source = state.project.script.replace(/\s/g, "");
  const episodes = state.episodes.map((episode) => episode.sourceText).join("").replace(/\s/g, "");
  return {
    complete: source.length > 0 && source === episodes,
    sourceChars: source.length,
    coveredChars: episodes.length,
  };
}

export function prepareNextBatch(state: AppState): AppState {
  const active = state.batches.find((batch) => batch.status !== "completed");
  if (active) return addActivity(state, "当前批次尚未全部采用，不能进入下一批", "warning");

  const episodeIds = state.episodes
    .filter((episode) => episode.status === "draft")
    .slice(0, 5)
    .map((episode) => episode.id);
  if (!episodeIds.length) return addActivity(state, "没有待准备的短集", "info");

  const batch: Batch = {
    id: uid("batch"),
    number: state.batches.length + 1,
    episodeIds,
    status: "ready",
    createdAt: now(),
  };
  return addActivity(
    {
      ...state,
      batches: [...state.batches, batch],
      episodes: state.episodes.map((episode) =>
        episodeIds.includes(episode.id)
          ? { ...episode, status: "ready", batchId: batch.id }
          : episode,
      ),
    },
    `已准备第 ${batch.number} 批，共 ${episodeIds.length} 集`,
    "success",
  );
}

export function episodeRisks(state: AppState, episode: Episode): string[] {
  const risks: string[] = [];
  if (episode.duration < 4 || episode.duration > 15) risks.push("时长必须在 4~15 秒之间");
  if (!episode.prompt.trim()) risks.push("视频 Prompt 不能为空");
  const characterAssets = state.assets.filter(
    (asset) => asset.kind === "character" && episode.characters.includes(asset.name),
  );
  if (characterAssets.some((asset) => !asset.confirmed)) risks.push("核心角色素材尚未全部确认");
  if (characterAssets.some((asset) => asset.containsRealFace))
    risks.push("Seedance 2.0 不支持直接上传含真人人脸的参考素材");
  return risks;
}

export function submitActiveBatch(state: AppState): AppState {
  const batch = state.batches.find((item) => item.status === "ready");
  if (!batch) return addActivity(state, "没有可提交的批次", "warning");

  const episodes = state.episodes.filter((episode) => batch.episodeIds.includes(episode.id));
  const risks = episodes.flatMap((episode) => episodeRisks(state, episode));
  if (risks.length) return addActivity(state, `提交前审校未通过：${risks[0]}`, "warning");

  const versions = new Map<string, EpisodeVersion>();
  episodes.forEach((episode) => {
    const version: EpisodeVersion = {
      id: uid("version"),
      createdAt: now(),
      prompt: episode.prompt,
      params: {
        duration: episode.duration,
        resolution: "1080p",
        ratio: "9:16",
        generateAudio: true,
        watermark: false,
      },
      taskId: uid("seedance"),
      status: "review",
    };
    versions.set(episode.id, version);
  });

  return addActivity(
    {
      ...state,
      batches: state.batches.map((item) =>
        item.id === batch.id ? { ...item, status: "review" } : item,
      ),
      episodes: state.episodes.map((episode) => {
        const version = versions.get(episode.id);
        return version
          ? {
              ...episode,
              status: "review",
              versions: [...episode.versions, version],
              activeVersionId: version.id,
            }
          : episode;
      }),
    },
    `第 ${batch.number} 批已并行提交 ${episodes.length} 个视频任务`,
    "success",
  );
}

export function queueActiveBatch(state: AppState): AppState {
  const batch = state.batches.find((item) => item.status === "ready");
  if (!batch) return addActivity(state, "没有可提交的批次", "warning");
  const episodes = state.episodes.filter((episode) => batch.episodeIds.includes(episode.id));
  const risks = episodes.flatMap((episode) => episodeRisks(state, episode));
  if (risks.length) return addActivity(state, `提交前审校未通过：${risks[0]}`, "warning");
  const versions = new Map<string, EpisodeVersion>();
  episodes.forEach((episode) => {
    versions.set(episode.id, {
      id: uid("version"),
      createdAt: now(),
      prompt: episode.prompt,
      params: {
        duration: episode.duration,
        resolution: "1080p",
        ratio: "9:16",
        generateAudio: true,
        watermark: false,
      },
      taskId: "",
      status: "queued",
    });
  });
  return addActivity(
    {
      ...state,
      batches: state.batches.map((item) =>
        item.id === batch.id ? { ...item, status: "generating" } : item,
      ),
      episodes: state.episodes.map((episode) => {
        const version = versions.get(episode.id);
        return version
          ? {
              ...episode,
              status: "queued",
              versions: [...episode.versions, version],
              activeVersionId: version.id,
            }
          : episode;
      }),
    },
    `第 ${batch.number} 批已进入远端提交队列`,
    "info",
  );
}

export function markRemoteTask(
  state: AppState,
  episodeId: string,
  versionId: string,
  patch: Partial<EpisodeVersion>,
): AppState {
  const episodes = state.episodes.map((episode) => {
    if (episode.id !== episodeId) return episode;
    const versions = episode.versions.map((version) =>
      version.id === versionId ? { ...version, ...patch } : version,
    );
    const active = versions.find((version) => version.id === episode.activeVersionId);
    return { ...episode, versions, status: active?.status ?? episode.status };
  });
  const batches = state.batches.map((batch) => {
    if (!batch.episodeIds.includes(episodeId)) return batch;
    const statuses = batch.episodeIds.map(
      (id) => episodes.find((episode) => episode.id === id)?.status,
    );
    return statuses.every((status) => status === "review" || status === "failed" || status === "canceled")
      ? { ...batch, status: "review" as const }
      : batch;
  });
  return { ...state, episodes, batches };
}

export function acceptEpisode(state: AppState, episodeId: string): AppState {
  const nextEpisodes = state.episodes.map((episode) =>
    episode.id === episodeId ? { ...episode, status: "accepted" as const } : episode,
  );
  const accepted = nextEpisodes.find((episode) => episode.id === episodeId);
  const batches = state.batches.map((batch) => {
    if (!batch.episodeIds.includes(episodeId)) return batch;
    const done = batch.episodeIds.every(
      (id) => nextEpisodes.find((episode) => episode.id === id)?.status === "accepted",
    );
    return done ? { ...batch, status: "completed" as const } : batch;
  });
  return addActivity(
    { ...state, episodes: nextEpisodes, batches },
    `${accepted?.title ?? "短集"}已采用`,
    "success",
  );
}

export function regenerateEpisode(state: AppState, episodeId: string): AppState {
  const episodes = state.episodes.map((episode) => {
    if (episode.id !== episodeId) return episode;
    const version: EpisodeVersion = {
      id: uid("version"),
      createdAt: now(),
      prompt: episode.prompt,
      params: {
        duration: episode.duration,
        resolution: "1080p",
        ratio: "9:16",
        generateAudio: true,
        watermark: false,
      },
      taskId: uid("seedance"),
      status: "review",
    };
    return {
      ...episode,
      status: "review" as const,
      versions: [...episode.versions, version],
      activeVersionId: version.id,
    };
  });
  return addActivity({ ...state, episodes }, "已为单集创建新的生成版本", "info");
}

export function queueEpisodeRegeneration(state: AppState, episodeId: string): AppState {
  const episodes = state.episodes.map((episode) => {
    if (episode.id !== episodeId) return episode;
    const version: EpisodeVersion = {
      id: uid("version"),
      createdAt: now(),
      prompt: episode.prompt,
      params: {
        duration: episode.duration,
        resolution: "1080p",
        ratio: "9:16",
        generateAudio: true,
        watermark: false,
      },
      taskId: "",
      status: "queued",
    };
    return {
      ...episode,
      status: "queued" as const,
      versions: [...episode.versions, version],
      activeVersionId: version.id,
    };
  });
  return addActivity({ ...state, episodes }, "单集重生成已进入远端提交队列", "info");
}

export function switchVersion(state: AppState, episodeId: string, versionId: string): AppState {
  return {
    ...state,
    episodes: state.episodes.map((episode) =>
      episode.id === episodeId ? { ...episode, activeVersionId: versionId } : episode,
    ),
  };
}
