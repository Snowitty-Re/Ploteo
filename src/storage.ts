import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { initialState, type AppState, type ModelProfile, type VideoParams } from "./domain";

const KEY = "ploteo.beta.snapshot";

export const inTauri = () => "__TAURI_INTERNALS__" in window;

export interface RemoteTaskState {
  status: "queued" | "generating" | "review" | "failed" | "canceled";
  resultUrl?: string;
  error?: string;
}

function syncCurrentWorkspace(state: AppState): AppState {
  const workspaces = state.workspaces ?? [];
  if (!state.project.name.trim() && !state.project.directory.trim()) {
    return { ...state, workspaces };
  }
  return {
    ...state,
    workspaces: [
      {
        project: state.project,
        episodes: state.episodes,
        assets: state.assets,
        batches: state.batches,
        activity: state.activity,
      },
      ...workspaces.filter((workspace) => workspace.project.id !== state.project.id),
    ],
  };
}

function hydrateSnapshot(snapshot: string): AppState {
  const stored = JSON.parse(snapshot) as Partial<AppState>;
  const defaults = initialState();
  const normalizeWorkspace = (workspace: AppState["workspaces"][number]) => ({
    ...workspace,
    project: { ...defaults.project, ...workspace.project },
    episodes: workspace.episodes.map((episode) => ({
      ...episode,
      sourceBeatIds: episode.sourceBeatIds ?? [],
      shotList: episode.shotList ?? [],
    })),
  });
  return syncCurrentWorkspace({
    ...defaults,
    ...stored,
    project: { ...defaults.project, ...stored.project },
    episodes: (stored.episodes ?? []).map((episode) => ({
      ...episode,
      sourceBeatIds: episode.sourceBeatIds ?? [],
      shotList: episode.shotList ?? [],
    })),
    workspaces: (stored.workspaces ?? []).map(normalizeWorkspace),
  });
}

export async function loadSnapshot(): Promise<AppState | null> {
  if (inTauri()) {
    const snapshot = await invoke<string | null>("load_snapshot");
    return snapshot ? hydrateSnapshot(snapshot) : null;
  }
  const snapshot = localStorage.getItem(KEY);
  return snapshot ? hydrateSnapshot(snapshot) : null;
}

export async function saveSnapshot(state: AppState): Promise<void> {
  const snapshot = JSON.stringify(syncCurrentWorkspace(state));
  if (inTauri()) {
    await invoke("save_snapshot", { snapshot });
    return;
  }
  localStorage.setItem(KEY, snapshot);
}

export async function saveSecret(secretRef: string, secret: string): Promise<boolean> {
  if (inTauri()) {
    return invoke<boolean>("store_secret", { secretRef, secret });
  }
  sessionStorage.setItem(`ploteo.secret.${secretRef}`, secret);
  return true;
}

export async function hasSecret(secretRef: string): Promise<boolean> {
  if (inTauri()) {
    return invoke<boolean>("has_secret", { secretRef });
  }
  return Boolean(sessionStorage.getItem(`ploteo.secret.${secretRef}`));
}

export async function refreshProfileSecrets(profiles: ModelProfile[]): Promise<ModelProfile[]> {
  return Promise.all(
    profiles.map(async (profile) => ({
      ...profile,
      hasSecret: await hasSecret(profile.secretRef),
    })),
  );
}

export async function validateProfile(profile: ModelProfile): Promise<string> {
  if (inTauri()) {
    return invoke<string>("validate_profile", { profile });
  }
  if (!profile.baseUrl.startsWith("http")) throw new Error("Base URL 必须使用 http 或 https");
  if (!profile.model.trim()) throw new Error("模型名不能为空");
  return "配置格式有效。浏览器预览模式不执行远端连接。";
}

export async function exportDiagnostics(): Promise<string> {
  if (inTauri()) return invoke<string>("export_diagnostics");
  return "浏览器预览模式：诊断日志仅在桌面应用中导出。";
}

export async function openProjectDirectory(directory: string): Promise<void> {
  if (inTauri()) await invoke("open_project_directory", { directory });
}

export async function selectProjectDirectory(): Promise<string | null> {
  if (inTauri()) return invoke<string | null>("select_project_directory");
  return window.prompt("请输入本地项目目录")?.trim() || null;
}

export interface DeleteProjectResult {
  fileWarning?: string;
}

export async function deleteProject(
  projectId: string,
  deleteFiles: boolean,
): Promise<DeleteProjectResult> {
  if (inTauri()) {
    return invoke<DeleteProjectResult>("delete_project", { projectId, deleteFiles });
  }
  return {};
}

export async function createSeedanceTask(
  profile: ModelProfile,
  prompt: string,
  params: VideoParams,
  imageRefs: string[],
  projectId?: string,
): Promise<string> {
  const response = await invoke<{ taskId: string }>("create_seedance_task", {
    request: { profile, prompt, params, imageRefs, projectId },
  });
  return response.taskId;
}

export async function querySeedanceTask(
  profile: ModelProfile,
  taskId: string,
): Promise<RemoteTaskState> {
  const raw = await invoke<Record<string, unknown>>("query_seedance_task", { profile, taskId });
  const status = String(raw.status ?? "generating").toLowerCase();
  const content = (raw.content ?? raw.output ?? {}) as Record<string, unknown>;
  const resultUrl = String(content.video_url ?? content.videoUrl ?? raw.video_url ?? "");
  const error = String(raw.error ?? raw.message ?? "");
  if (["succeeded", "success", "completed"].includes(status)) {
    return { status: "review", resultUrl: resultUrl || undefined };
  }
  if (["failed", "error", "expired"].includes(status)) return { status: "failed", error };
  if (["canceled", "cancelled"].includes(status)) return { status: "canceled", error };
  return { status: status === "queued" ? "queued" : "generating" };
}

export async function cancelSeedanceTask(profile: ModelProfile, taskId: string): Promise<void> {
  await invoke("cancel_seedance_task", { profile, taskId });
}

export async function downloadResult(url: string, destination: string): Promise<string> {
  return invoke<string>("download_result", { url, destination });
}

export async function generateText(
  profile: ModelProfile,
  prompt: string,
  projectId?: string,
  agentKind?: string,
): Promise<string> {
  return invoke<string>("generate_text", {
    request: { profile, prompt, projectId, agentKind },
  });
}

export async function generateImage(
  profile: ModelProfile,
  prompt: string,
  projectId?: string,
): Promise<{ preview: string; localPath?: string; remoteUrl?: string }> {
  const result = await invoke<{
    previewUrl: string;
    localPath?: string;
    remoteUrl?: string;
  }>("generate_image", {
    request: { profile, prompt, projectId, agentKind: "visual" },
  });
  return {
    preview: result.localPath ? convertFileSrc(result.localPath) : result.previewUrl,
    localPath: result.localPath,
    remoteUrl: result.remoteUrl,
  };
}

export async function loadImageReference(path: string): Promise<string> {
  return invoke<string>("load_image_reference", { path });
}
