import {
  type AppState,
  type Asset,
  type Batch,
  type Episode,
  type EpisodeVersion,
  type ProjectWorkspace,
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
      sourceText,
      summary: sourceText,
      scene,
      characters: index === 0 ? ["林夏"] : ["林夏", "周屿"],
      dialogue,
      rhythm: index % 2 === 0 ? "悬念建立，结尾留钩子" : "快速推进，动作收束",
      continuity,
      duration: clampDuration(sourceText),
      prompt: buildPrompt(sourceText, scene, dialogue, continuity),
      status: "draft",
      versions: [],
    };
  });
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
