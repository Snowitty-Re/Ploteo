import { describe, expect, it } from "vitest";
import { initialState } from "./domain";
import {
  acceptEpisode,
  buildPlannerPrompt,
  buildWriterPrompt,
  coverage,
  createWorkspace,
  deleteWorkspace,
  episodeRisks,
  makeDemoState,
  markRemoteTask,
  openWorkspace,
  parseEpisodePlan,
  parseWriterDraft,
  prepareNextBatch,
  queueActiveBatch,
  queueEpisodeRegeneration,
  regenerateEpisode,
  splitScript,
  submitActiveBatch,
} from "./workflow";

const confirmedDemo = () => {
  const state = makeDemoState(initialState());
  return {
    ...state,
    assets: state.assets.map((asset) =>
      asset.kind === "character" ? { ...asset, confirmed: true } : asset,
    ),
  };
};

describe("deterministic episode workflow", () => {
  it("splits the complete script without limiting total episode count", () => {
    const state = makeDemoState(initialState());
    expect(state.episodes).toHaveLength(8);
    expect(coverage(state)).toMatchObject({ complete: true });
    expect(state.episodes.every((episode) => episode.duration >= 4 && episode.duration <= 15)).toBe(true);
  });

  it("prepares no more than five episodes in a batch and gates the next batch", () => {
    const state = confirmedDemo();
    const first = prepareNextBatch(state);
    expect(first.batches[0].episodeIds).toHaveLength(5);
    const blocked = prepareNextBatch(first);
    expect(blocked.batches).toHaveLength(1);

    const submitted = submitActiveBatch(first);
    const accepted = submitted.batches[0].episodeIds.reduce(acceptEpisode, submitted);
    const second = prepareNextBatch(accepted);
    expect(second.batches[1].episodeIds).toHaveLength(3);
  });

  it("regenerates one episode without changing sibling versions", () => {
    const submitted = submitActiveBatch(prepareNextBatch(confirmedDemo()));
    const [target, sibling] = submitted.episodes;
    const regenerated = regenerateEpisode(submitted, target.id);
    expect(regenerated.episodes[0].versions).toHaveLength(2);
    expect(regenerated.episodes.find((episode) => episode.id === sibling.id)?.versions).toHaveLength(1);
  });

  it("persists remote task ids and advances a recovered task into review", () => {
    const queued = queueActiveBatch(prepareNextBatch(confirmedDemo()));
    const episode = queued.episodes[0];
    const version = episode.versions[0];
    const generating = markRemoteTask(queued, episode.id, version.id, {
      taskId: "remote-task-1",
      status: "generating",
    });
    const reviewed = markRemoteTask(generating, episode.id, version.id, {
      status: "review",
      resultUrl: "https://example.com/result.mp4",
      localPath: "/tmp/result.mp4",
    });
    expect(reviewed.episodes[0].versions[0]).toMatchObject({
      taskId: "remote-task-1",
      status: "review",
      localPath: "/tmp/result.mp4",
    });
  });

  it("queues remote regeneration for only one episode", () => {
    const submitted = submitActiveBatch(prepareNextBatch(confirmedDemo()));
    const next = queueEpisodeRegeneration(submitted, submitted.episodes[0].id);
    expect(next.episodes[0].versions).toHaveLength(2);
    expect(next.episodes[0].versions[1].status).toBe("queued");
    expect(next.episodes[1].versions).toHaveLength(1);
  });

  it("blocks unconfirmed and real-face character assets before submission", () => {
    const state = makeDemoState(initialState());
    expect(episodeRisks(state, state.episodes[0])).toContain("核心角色素材尚未全部确认");
    const withRealFace = {
      ...state,
      assets: state.assets.map((asset) => ({ ...asset, confirmed: true, containsRealFace: true })),
    };
    expect(episodeRisks(withRealFace, withRealFace.episodes[0])).toContain(
      "Seedance 2.0 不支持直接上传含真人人脸的参考素材",
    );
  });

  it("preserves every source fragment in user-provided scripts", () => {
    const script = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 个剧情节点。`).join("\n\n");
    const episodes = splitScript(script);
    expect(episodes).toHaveLength(12);
    expect(episodes.map((episode) => episode.sourceText).join("").replace(/\s/g, "")).toBe(
      script.replace(/\s/g, ""),
    );
  });

  it("keeps local workspaces when switching to the demo and back", () => {
    const local = createWorkspace(initialState(), "本地项目", "/tmp/ploteo-local");
    const withIdea = {
      ...local,
      project: { ...local.project, idea: "本地创意" },
    };
    const demo = makeDemoState(withIdea);
    expect(demo.project.id).toBe("demo-project");
    expect(demo.project.directory).toBe("");
    const reopened = openWorkspace(demo, withIdea.project.id);
    expect(reopened.project).toMatchObject({
      name: "本地项目",
      directory: "/tmp/ploteo-local",
      idea: "本地创意",
    });
  });

  it("deletes a local workspace without deleting other projects", () => {
    const first = createWorkspace(initialState(), "项目 A", "/tmp/a");
    const second = createWorkspace(first, "项目 B", "/tmp/b");
    const deleted = deleteWorkspace(second, first.project.id);
    expect(deleted.workspaces.some((workspace) => workspace.project.id === first.project.id)).toBe(false);
    expect(deleted.project.name).toBe("项目 B");
  });

  it("builds writer and planner prompts with explicit production constraints", () => {
    const state = createWorkspace(initialState(), "测试项目", "/tmp/ploteo");
    const project = {
      ...state.project,
      idea: "少女在废弃剧院发现会说话的紫色星尘",
      targetEpisodes: 12,
      contentLength: "短篇，节奏快，每集强钩子",
      style: "二次元紫色幻想",
      script: "完整剧本正文",
    };
    expect(buildWriterPrompt(project)).toContain("目标短集数：12 集");
    expect(buildWriterPrompt(project)).toContain("二次元紫色幻想");
    expect(buildPlannerPrompt(project)).toContain("只输出 JSON");
    expect(buildPlannerPrompt(project)).toContain("shotList");
  });

  it("parses structured planner JSON into professional episode records", () => {
    const episodes = parseEpisodePlan(JSON.stringify({
      episodes: [
        {
          number: 1,
          title: "开场",
          sourceBeatIds: ["beat-001"],
          sourceText: "少女走进剧院。",
          summary: "少女发现紫色星尘。",
          scene: "废弃剧院",
          characters: ["少女", "星尘"],
          dialogue: "星尘：别开灯。",
          rhythm: "悬念开场",
          continuity: "建立剧院与星尘",
          duration: 9,
          shotList: ["推门近景", "星尘漂浮特写"],
          prompt: "竖屏镜头，少女推门，星尘漂浮，同步环境音。",
        },
      ],
    }), ["beat-001"]);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      title: "开场",
      scene: "废弃剧院",
      duration: 9,
      characters: ["少女", "星尘"],
      sourceBeatIds: ["beat-001"],
      status: "draft",
    });
    expect(episodes[0].prompt).toContain("同步环境音");
  });

  it("parses writer beats and rejects incomplete planner coverage", () => {
    const draft = parseWriterDraft(JSON.stringify({
      title: "紫尘剧院",
      premise: "星尘会回应人的秘密",
      beats: [
        {
          beatId: "beat-001",
          scene: "废弃剧院",
          characters: ["少女"],
          action: "少女推开剧院大门",
          dialogue: "有人吗？",
          hook: "紫色星尘突然亮起",
        },
        {
          beatId: "beat-002",
          scene: "剧院舞台",
          characters: ["少女", "星尘"],
          action: "星尘聚成人形",
          dialogue: "别开灯。",
          hook: "后台传来脚步声",
        },
      ],
    }));
    expect(draft.beats.map((beat) => beat.id)).toEqual(["beat-001", "beat-002"]);
    expect(draft.script).toContain("[beat-001]");
    expect(() => parseEpisodePlan(JSON.stringify({
      episodes: [{
        sourceBeatIds: ["beat-001"],
        sourceText: "少女推门。",
        duration: 8,
      }],
    }), draft.beats.map((beat) => beat.id))).toThrow("未覆盖剧情节点：beat-002");
  });
});
