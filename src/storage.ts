import { invoke } from "@tauri-apps/api/core";
import type { AppState, ModelProfile, VideoParams } from "./domain";

const KEY = "ploteo.beta.snapshot";

export const inTauri = () => "__TAURI_INTERNALS__" in window;

export interface RemoteTaskState {
  status: "queued" | "generating" | "review" | "failed" | "canceled";
  resultUrl?: string;
  error?: string;
}

export async function loadSnapshot(): Promise<AppState | null> {
  if (inTauri()) {
    const snapshot = await invoke<string | null>("load_snapshot");
    return snapshot ? (JSON.parse(snapshot) as AppState) : null;
  }
  const snapshot = localStorage.getItem(KEY);
  return snapshot ? (JSON.parse(snapshot) as AppState) : null;
}

export async function saveSnapshot(state: AppState): Promise<void> {
  const snapshot = JSON.stringify(state);
  if (inTauri()) {
    await invoke("save_snapshot", { snapshot });
    return;
  }
  localStorage.setItem(KEY, snapshot);
}

export async function saveSecret(secretRef: string, secret: string): Promise<void> {
  if (inTauri()) {
    await invoke("store_secret", { secretRef, secret });
    return;
  }
  sessionStorage.setItem(`ploteo.secret.${secretRef}`, secret);
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

export async function createSeedanceTask(
  profile: ModelProfile,
  prompt: string,
  params: VideoParams,
  imageRefs: string[],
): Promise<string> {
  const response = await invoke<{ taskId: string }>("create_seedance_task", {
    request: { profile, prompt, params, imageRefs },
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
  if (["failed", "error"].includes(status)) return { status: "failed", error };
  if (["canceled", "cancelled"].includes(status)) return { status: "canceled", error };
  return { status: status === "queued" ? "queued" : "generating" };
}

export async function cancelSeedanceTask(profile: ModelProfile, taskId: string): Promise<void> {
  await invoke("cancel_seedance_task", { profile, taskId });
}

export async function downloadResult(url: string, destination: string): Promise<string> {
  return invoke<string>("download_result", { url, destination });
}

export async function generateText(profile: ModelProfile, prompt: string): Promise<string> {
  return invoke<string>("generate_text", { request: { profile, prompt } });
}

export async function generateImage(profile: ModelProfile, prompt: string): Promise<string> {
  return invoke<string>("generate_image", { request: { profile, prompt } });
}
