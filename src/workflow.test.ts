import { describe, expect, it } from "vitest";
import { initialState } from "./domain";
import {
  acceptEpisode,
  coverage,
  episodeRisks,
  makeDemoState,
  markRemoteTask,
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
});
