export type TaskStatus =
  | "draft"
  | "ready"
  | "queued"
  | "generating"
  | "review"
  | "accepted"
  | "failed"
  | "canceled";

export type Capability = "text" | "image" | "video";
export type Adapter =
  | "openai-chat"
  | "openai-responses"
  | "openai-images"
  | "volcengine-images"
  | "volcengine-seedance"
  | "mock";

export interface ModelProfile {
  id: string;
  name: string;
  capability: Capability;
  adapter: Adapter;
  baseUrl: string;
  model: string;
  secretRef: string;
  hasSecret: boolean;
  defaults: Record<string, string | number | boolean>;
}

export interface Asset {
  id: string;
  name: string;
  kind: "character" | "scene" | "style";
  prompt: string;
  preview: string;
  source: "generated" | "uploaded";
  confirmed: boolean;
  containsRealFace: boolean;
}

export interface EpisodeVersion {
  id: string;
  createdAt: string;
  prompt: string;
  params: VideoParams;
  taskId: string;
  status: TaskStatus;
  resultUrl?: string;
  localPath?: string;
  error?: string;
}

export interface Episode {
  id: string;
  number: number;
  title: string;
  sourceText: string;
  summary: string;
  scene: string;
  characters: string[];
  dialogue: string;
  rhythm: string;
  continuity: string;
  duration: number;
  prompt: string;
  status: TaskStatus;
  batchId?: string;
  versions: EpisodeVersion[];
  activeVersionId?: string;
}

export interface VideoParams {
  duration: number;
  resolution: string;
  ratio: string;
  generateAudio: boolean;
  watermark: boolean;
}

export interface Batch {
  id: string;
  number: number;
  episodeIds: string[];
  status: "ready" | "generating" | "review" | "completed";
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  idea: string;
  script: string;
  style: string;
  targetEpisodes: number;
  contentLength: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  at: string;
  message: string;
  tone: "info" | "success" | "warning";
}

export interface ProjectWorkspace {
  project: Project;
  episodes: Episode[];
  assets: Asset[];
  batches: Batch[];
  activity: Activity[];
}

export interface AppState {
  onboardingComplete: boolean;
  project: Project;
  episodes: Episode[];
  assets: Asset[];
  batches: Batch[];
  workspaces: ProjectWorkspace[];
  profiles: ModelProfile[];
  activity: Activity[];
}

export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

export const defaultProfiles: ModelProfile[] = [
  {
    id: "text-default",
    name: "文本编排 · OpenAI Compatible",
    capability: "text",
    adapter: "openai-chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-1-6",
    secretRef: "text-default",
    hasSecret: false,
    defaults: { temperature: 0.7 },
  },
  {
    id: "image-default",
    name: "角色图 · 火山方舟",
    capability: "image",
    adapter: "volcengine-images",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-4-0",
    secretRef: "image-default",
    hasSecret: false,
    defaults: { size: "2048x2048" },
  },
  {
    id: "video-default",
    name: "视频 · Seedance 2.0",
    capability: "video",
    adapter: "volcengine-seedance",
    baseUrl: "https://ark.cn-beijing.volces.com",
    model: "doubao-seedance-2-0",
    secretRef: "video-default",
    hasSecret: false,
    defaults: {
      duration: -1,
      resolution: "1080p",
      ratio: "9:16",
      generateAudio: true,
      watermark: false,
    },
  },
];

export const emptyProject = (directory = ""): Project => ({
  id: uid("project"),
  name: "",
  directory,
  idea: "",
  script: "",
  style: "都市电影感，克制自然光，真实表演",
  targetEpisodes: 8,
  contentLength: "中等篇幅，每集 4~15 秒，整体适合内部测试短剧生成",
  createdAt: now(),
  updatedAt: now(),
});
export const initialState = (): AppState => ({
  onboardingComplete: false,
  project: emptyProject(),
  episodes: [],
  assets: [],
  batches: [],
  workspaces: [],
  profiles: defaultProfiles,
  activity: [],
});
