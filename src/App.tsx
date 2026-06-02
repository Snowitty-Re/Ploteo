import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  type AppState,
  type Asset,
  type Episode,
  type ModelProfile,
  initialState,
  now,
} from "./domain";
import {
  acceptEpisode,
  addActivity,
  coverage,
  createWorkspace,
  episodeRisks,
  isDemoWorkspace,
  listWorkspaces,
  makeDemoState,
  markRemoteTask,
  openWorkspace,
  prepareNextBatch,
  queueActiveBatch,
  queueEpisodeRegeneration,
  regenerateEpisode,
  splitScript,
  submitActiveBatch,
  switchVersion,
} from "./workflow";
import {
  cancelSeedanceTask,
  createSeedanceTask,
  downloadResult,
  exportDiagnostics,
  generateImage,
  generateText,
  inTauri,
  loadSnapshot,
  openProjectDirectory,
  querySeedanceTask,
  saveSecret,
  saveSnapshot,
  selectProjectDirectory,
  validateProfile,
} from "./storage";

type Tab = "overview" | "script" | "assets" | "batch" | "results" | "settings";
type SetAppState = Dispatch<SetStateAction<AppState>>;

const tabs: { id: Tab; label: string; hint: string }[] = [
  { id: "overview", label: "项目总览", hint: "01" },
  { id: "script", label: "剧本拆集", hint: "02" },
  { id: "assets", label: "视觉素材", hint: "03" },
  { id: "batch", label: "批次工作台", hint: "04" },
  { id: "results", label: "生成结果", hint: "05" },
  { id: "settings", label: "模型设置", hint: "06" },
];

const formatTime = (at: string) =>
  new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(at));

function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "ghost" | "quiet" | "danger";
}) {
  return (
    <button className={`button ${variant}`} {...props}>
      {children}
    </button>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress">
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

function ProjectManager({
  state,
  canClose,
  onClose,
  onCreate,
  onDemo,
  onOpen,
}: {
  state: AppState;
  canClose: boolean;
  onClose: () => void;
  onCreate: (name: string, directory: string) => void;
  onDemo: () => void;
  onOpen: (projectId: string) => void;
}) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const workspaces = listWorkspaces(state).filter((workspace) => !isDemoWorkspace(workspace));
  const pickDirectory = async () => {
    const selected = await selectProjectDirectory();
    if (selected) setDirectory(selected);
  };
  const create = () => {
    if (!name.trim() || !directory.trim()) return;
    onCreate(name, directory);
  };
  return (
    <main className="onboarding">
      <section className="onboarding-card manager-card">
        <div className="manager-head">
          <div>
            <div className="brand-mark">P</div>
            <p className="eyebrow">PLOTEO · PROJECT MANAGER</p>
            <h1>选择一个本地项目。</h1>
            <p className="lede">项目内容保存在本地快照中，生成的视频落入你选择的目录。</p>
          </div>
          {canClose && <Button variant="quiet" onClick={onClose}>返回当前项目</Button>}
        </div>
        <section className="manager-layout">
          <div className="manager-projects">
            <p className="eyebrow">AVAILABLE PROJECTS</p>
            <button className="project-choice demo-choice" onClick={onDemo}>
              <div><strong>雨夜录音机</strong><small>内置 Demo · 8 集短剧</small></div><span>打开 Demo →</span>
            </button>
            {workspaces.map((workspace) => (
              <button className="project-choice" key={workspace.project.id} onClick={() => onOpen(workspace.project.id)}>
                <div><strong>{workspace.project.name}</strong><small>{workspace.project.directory}</small></div>
                <span>{workspace.episodes.length} 集 →</span>
              </button>
            ))}
            {workspaces.length === 0 && <p className="manager-empty">还没有本地项目。先在右侧选择目录并创建一个。</p>}
          </div>
          <div className="new-project panel">
            <p className="eyebrow">NEW LOCAL PROJECT</p>
            <h2>创建空白项目</h2>
            <label>项目名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：码头来信" /></label>
            <label>本地目录
              <div className="directory-input">
                <input value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="请选择一个本地目录" />
                <Button variant="ghost" onClick={() => void pickDirectory()}>选择目录</Button>
              </div>
            </label>
            <Button disabled={!name.trim() || !directory.trim()} onClick={create}>创建并进入项目</Button>
            <small>视频结果将下载到该目录下的 `episodes` 文件夹。</small>
          </div>
        </section>
        <div className="manager-foot">
          <span>LOCAL-FIRST</span>
          <span>密钥仅写入系统密钥链</span>
          <span>每批最多并行 5 集</span>
        </div>
      </section>
    </main>
  );
}

function Overview({ state, setTab }: { state: AppState; setTab: (tab: Tab) => void }) {
  const accepted = state.episodes.filter((episode) => episode.status === "accepted").length;
  const ready = state.episodes.filter((episode) => episode.status === "review").length;
  const assets = state.assets.filter((asset) => asset.kind === "character" && asset.confirmed).length;
  const totalAssets = state.assets.filter((asset) => asset.kind === "character").length;
  const completion = state.episodes.length ? Math.round((accepted / state.episodes.length) * 100) : 0;
  return (
    <>
      <header className="hero">
        <div>
          <p className="eyebrow">CURRENT PROJECT</p>
          <h1>{state.project.name || "未命名短剧"}</h1>
          <p>{state.project.idea || "从创意开始，生成或导入完整剧本。"}</p>
        </div>
        <div className="hero-progress">
          <strong>{completion}%</strong>
          <span>全剧已采用</span>
          <Progress value={completion} />
        </div>
      </header>

      <section className="stat-grid">
        <article><span>短集总数</span><strong>{state.episodes.length}</strong><small>每集 4~15 秒</small></article>
        <article><span>待审结果</span><strong>{ready}</strong><small>逐集采用或重生成</small></article>
        <article><span>角色素材</span><strong>{assets}/{totalAssets}</strong><small>核心角色需确认</small></article>
        <article><span>已完成批次</span><strong>{state.batches.filter((batch) => batch.status === "completed").length}</strong><small>每批最多并行 5 集</small></article>
      </section>

      <section className="two-column">
        <article className="panel workflow-map">
          <div className="section-title"><div><p className="eyebrow">DETERMINISTIC FLOW</p><h2>生成流程</h2></div></div>
          {[
            ["01", "剧本与自然拆集", state.episodes.length ? "已完成" : "待处理", "script"],
            ["02", "核心角色视觉确认", `${assets}/${totalAssets} 已确认`, "assets"],
            ["03", "批次生成与审校", `${state.batches.length} 个批次`, "batch"],
            ["04", "逐集采用结果", `${accepted}/${state.episodes.length} 已采用`, "results"],
          ].map(([index, label, detail, tab]) => (
            <button className="flow-row" key={index} onClick={() => setTab(tab as Tab)}>
              <b>{index}</b><span>{label}</span><small>{detail}</small><i>→</i>
            </button>
          ))}
        </article>
        <article className="panel">
          <div className="section-title"><div><p className="eyebrow">ACTIVITY</p><h2>项目动态</h2></div></div>
          <div className="activity-list">
            {state.activity.length === 0 && <p className="empty">尚无项目动态。</p>}
            {state.activity.map((item) => (
              <div className="activity" key={item.id}>
                <span className={`dot ${item.tone}`} />
                <p>{item.message}<small>{formatTime(item.at)}</small></p>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function ScriptWorkspace({ state, setState }: { state: AppState; setState: SetAppState }) {
  const [generating, setGenerating] = useState(false);
  const result = coverage(state);
  const textProfile = state.profiles.find((profile) => profile.capability === "text");
  const split = () => {
    const episodes = splitScript(state.project.script);
    setState(addActivity({ ...state, episodes, batches: [] }, `已按剧情自然拆分为 ${episodes.length} 集`, "success"));
  };
  const updateEpisode = (id: string, patch: Partial<Episode>) =>
    setState({ ...state, episodes: state.episodes.map((episode) => episode.id === id ? { ...episode, ...patch } : episode) });
  const importScript = async (file?: File) => {
    if (!file) return;
    const script = await file.text();
    setState(
      addActivity(
        { ...state, project: { ...state.project, script, updatedAt: now() }, episodes: [], batches: [] },
        `已导入剧本文件 ${file.name}`,
        "success",
      ),
    );
  };
  const generateDraft = async () => {
    if (!textProfile?.hasSecret || !inTauri()) {
      setState(addActivity(state, "编剧 Agent 需要在桌面端配置文本模型密钥", "warning"));
      return;
    }
    if (!state.project.idea.trim()) {
      setState(addActivity(state, "请先填写故事创意", "warning"));
      return;
    }
    setGenerating(true);
    try {
      const script = await generateText(
        textProfile,
        `请根据以下创意创作一份完整短剧剧本。情节紧凑，适合自然拆成多个 4~15 秒短集，明确场景、动作和对白。\n\n创意：${state.project.idea}`,
      );
      setState((current) =>
        addActivity(
          { ...current, project: { ...current.project, script, updatedAt: now() }, episodes: [], batches: [] },
          "编剧 Agent 已生成完整剧本，请确认后自然拆集",
          "success",
        ),
      );
    } catch (error) {
      setState((current) => addActivity(current, `编剧 Agent 请求失败：${error instanceof Error ? error.message : String(error)}`, "warning"));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">SCRIPT PLANNER</p><h1>剧本与自然拆集</h1><p>完整剧本是唯一来源。拆集结果可编辑，并持续检查覆盖完整性。</p></div>
        <div className="button-row"><Button variant="ghost" disabled={generating} onClick={() => void generateDraft()}>{generating ? "正在生成..." : "编剧 Agent 生成"}</Button><label className="upload-button">导入文本剧本<input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(event) => void importScript(event.target.files?.[0])} /></label><Button onClick={split}>重新自然拆集</Button></div>
      </header>
      <section className="script-layout">
        <article className="panel script-editor">
          <div className="section-title"><h2>完整剧本</h2><Badge tone={state.project.script ? "success" : "warning"}>{state.project.script ? "已导入" : "待输入"}</Badge></div>
          <label className="idea-field">故事创意<input value={state.project.idea} onChange={(event) => setState({ ...state, project: { ...state.project, idea: event.target.value, updatedAt: now() } })} placeholder="一句话描述故事核心冲突" /></label>
          <textarea value={state.project.script} onChange={(event) => setState({ ...state, project: { ...state.project, script: event.target.value, updatedAt: now() } })} placeholder="输入创意生成的剧本，或在此粘贴完整剧本..." />
          <div className="coverage">
            <div><span>覆盖检查</span><strong>{result.complete ? "完整覆盖" : "需要重新拆集"}</strong></div>
            <Progress value={result.sourceChars ? result.coveredChars / result.sourceChars * 100 : 0} />
            <small>{result.coveredChars} / {result.sourceChars} 个非空白字符</small>
          </div>
        </article>
        <section className="episode-stack">
          {state.episodes.map((episode) => (
            <article className="panel episode-card" key={episode.id}>
              <div className="episode-head"><b>{String(episode.number).padStart(2, "0")}</b><div><h3>{episode.title}</h3><small>{episode.scene} · {episode.rhythm}</small></div><Badge tone={episode.duration >= 4 && episode.duration <= 15 ? "success" : "warning"}>{episode.duration} 秒</Badge></div>
              <textarea value={episode.summary} onChange={(event) => updateEpisode(episode.id, { summary: event.target.value })} />
              <div className="compact-grid"><label>时长<input type="number" min="4" max="15" value={episode.duration} onChange={(event) => updateEpisode(episode.id, { duration: Number(event.target.value) })} /></label><label>场景<input value={episode.scene} onChange={(event) => updateEpisode(episode.id, { scene: event.target.value })} /></label></div>
            </article>
          ))}
        </section>
      </section>
    </>
  );
}

function AssetsWorkspace({ state, setState }: { state: AppState; setState: SetAppState }) {
  const [generating, setGenerating] = useState("");
  const imageProfile = state.profiles.find((profile) => profile.capability === "image");
  const update = (id: string, patch: Partial<Asset>) =>
    setState({ ...state, assets: state.assets.map((asset) => asset.id === id ? { ...asset, ...patch } : asset) });
  const uploadAsset = (asset: Asset, file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => update(asset.id, { preview: String(reader.result), source: "uploaded", confirmed: false });
    reader.readAsDataURL(file);
  };
  const generateCandidate = async (asset: Asset) => {
    if (!imageProfile?.hasSecret || !inTauri()) {
      setState(addActivity(state, "图片 Agent 需要在桌面端配置图片模型密钥", "warning"));
      return;
    }
    setGenerating(asset.id);
    try {
      const preview = await generateImage(imageProfile, asset.prompt);
      setState((current) => ({
        ...current,
        assets: current.assets.map((item) =>
          item.id === asset.id ? { ...item, preview, source: "generated", confirmed: false } : item,
        ),
      }));
    } catch (error) {
      setState((current) => addActivity(current, `图片 Agent 请求失败：${error instanceof Error ? error.message : String(error)}`, "warning"));
    } finally {
      setGenerating("");
    }
  };
  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">VISUAL BIBLE</p><h1>核心角色与复用素材</h1><p>角色必须由用户确认。场景和风格默认由视觉统筹维护，也可以替换。</p></div>
        <Badge tone="warning">真人参考素材受限</Badge>
      </header>
      <div className="notice">Seedance 2.0 提交前会阻止直接上传含真人人脸的参考图或视频。请使用平台允许的虚拟人像或合规来源素材。</div>
      <section className="asset-grid">
        {state.assets.map((asset) => (
          <article className="asset-card panel" key={asset.id}>
            <div className="asset-preview" style={{ background: asset.preview }}><span>{asset.name.slice(0, 1)}</span><small>{asset.kind.toUpperCase()}</small></div>
            <div className="asset-body">
              <div className="section-title"><h3>{asset.name}</h3><Badge tone={asset.confirmed ? "success" : "warning"}>{asset.confirmed ? "已确认" : "待确认"}</Badge></div>
              <p>{asset.prompt}</p>
              <label className="checkbox"><input type="checkbox" checked={asset.containsRealFace} onChange={(event) => update(asset.id, { containsRealFace: event.target.checked })} /> 含真人人脸参考</label>
              <div className="button-row"><Button onClick={() => update(asset.id, { confirmed: !asset.confirmed })}>{asset.confirmed ? "取消确认" : "采用此素材"}</Button><Button variant="quiet" disabled={generating === asset.id} onClick={() => void generateCandidate(asset)}>{generating === asset.id ? "生成中..." : "生成候选"}</Button><label className="upload-button quiet">上传素材<input type="file" accept="image/*" onChange={(event) => uploadAsset(asset, event.target.files?.[0])} /></label></div>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

function BatchWorkspace({ state, setState }: { state: AppState; setState: SetAppState }) {
  const [submitting, setSubmitting] = useState(false);
  const batch = state.batches.find((item) => item.status !== "completed");
  const episodes = batch ? state.episodes.filter((episode) => batch.episodeIds.includes(episode.id)) : [];
  const videoProfile = state.profiles.find((profile) => profile.capability === "video");
  const updatePrompt = (id: string, prompt: string) =>
    setState({ ...state, episodes: state.episodes.map((episode) => episode.id === id ? { ...episode, prompt } : episode) });
  const submit = async () => {
    if (!videoProfile?.hasSecret || !inTauri()) {
      setState(submitActiveBatch(state));
      return;
    }
    if (!state.project.directory.trim()) {
      setState(addActivity(state, "请先在项目管理器中创建带本地目录的项目", "warning"));
      return;
    }
    if (episodes.some((episode) => episodeRisks(state, episode).length)) {
      setState(queueActiveBatch(state));
      return;
    }
    const queued = queueActiveBatch(state);
    setState(queued);
    setSubmitting(true);
    const imageRefs = state.assets
      .filter((asset) => asset.confirmed && /^https?:/.test(asset.preview))
      .map((asset) => asset.preview);
    await Promise.all(
      episodes.map(async (episode) => {
        const queuedEpisode = queued.episodes.find((item) => item.id === episode.id)!;
        const version = queuedEpisode.versions.find((item) => item.id === queuedEpisode.activeVersionId)!;
        try {
          const taskId = await createSeedanceTask(videoProfile, version.prompt, version.params, imageRefs);
          setState((current) => markRemoteTask(current, episode.id, version.id, { taskId, status: "generating" }));
        } catch (error) {
          setState((current) =>
            markRemoteTask(current, episode.id, version.id, {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }),
    );
    setSubmitting(false);
  };
  return (
    <>
      <header className="page-header">
        <div><p className="eyebrow">BATCH DESK</p><h1>批次工作台</h1><p>普通代码控制队列。审校只返回风险，不直接替用户提交。</p></div>
        {!batch ? <Button onClick={() => setState(prepareNextBatch(state))}>准备下一批</Button> : batch.status === "ready" ? <Button disabled={submitting} onClick={submit}>{submitting ? "正在提交..." : "确认并行提交"}</Button> : <Badge tone="success">{batch.status === "generating" ? "远端生成中" : "等待逐集采用"}</Badge>}
      </header>
      {!batch ? (
        <article className="empty-stage panel"><strong>没有进行中的批次</strong><p>系统会选取下一组最多 5 集。上一批全部采用后才能继续。</p></article>
      ) : (
        <>
          <div className="batch-strip"><div><span>第 {batch.number} 批</span><strong>{episodes.length} / 5</strong><small>并行任务槽位</small></div><Badge tone={batch.status === "ready" ? "warning" : "success"}>{batch.status}</Badge></div>
          <section className="batch-list">
            {episodes.map((episode) => {
              const risks = episodeRisks(state, episode);
              return (
                <article className="panel batch-episode" key={episode.id}>
                  <div className="episode-head"><b>{String(episode.number).padStart(2, "0")}</b><div><h3>{episode.title}</h3><small>{episode.summary}</small></div><Badge tone={risks.length ? "warning" : "success"}>{risks.length ? `${risks.length} 项风险` : "审校通过"}</Badge></div>
                  <textarea value={episode.prompt} onChange={(event) => updatePrompt(episode.id, event.target.value)} />
                  <div className="param-row"><span>{episode.duration} 秒</span><span>1080p</span><span>9:16</span><span>同步声音</span><span>无水印</span></div>
                  {risks.map((risk) => <p className="risk" key={risk}>! {risk}</p>)}
                </article>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}

function ResultsWorkspace({ state, setState }: { state: AppState; setState: SetAppState }) {
  const episodes = state.episodes.filter((episode) => episode.versions.length);
  const videoProfile = state.profiles.find((profile) => profile.capability === "video");
  const cancel = async (episode: Episode) => {
    const version = episode.versions.find((item) => item.id === episode.activeVersionId);
    if (!videoProfile || !version?.taskId) return;
    await cancelSeedanceTask(videoProfile, version.taskId);
    setState((current) => markRemoteTask(current, episode.id, version.id, { status: "canceled" }));
  };
  const regenerate = async (episode: Episode) => {
    if (!videoProfile?.hasSecret || !inTauri()) {
      setState(regenerateEpisode(state, episode.id));
      return;
    }
    const queued = queueEpisodeRegeneration(state, episode.id);
    const queuedEpisode = queued.episodes.find((item) => item.id === episode.id)!;
    const version = queuedEpisode.versions.find((item) => item.id === queuedEpisode.activeVersionId)!;
    setState(queued);
    try {
      const taskId = await createSeedanceTask(videoProfile, version.prompt, version.params, []);
      setState((current) => markRemoteTask(current, episode.id, version.id, { taskId, status: "generating" }));
    } catch (error) {
      setState((current) =>
        markRemoteTask(current, episode.id, version.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    <>
      <header className="page-header"><div><p className="eyebrow">EPISODE REVIEW</p><h1>逐集结果</h1><p>每次生成单独保存。采用、重生成和切换历史版本不会影响其他短集。</p></div><Button variant="ghost" disabled={!state.project.directory} onClick={() => openProjectDirectory(state.project.directory)}>打开项目目录</Button></header>
      {!episodes.length ? <article className="empty-stage panel"><strong>尚无视频结果</strong><p>在批次工作台提交第一批后，结果会按短集独立出现。</p></article> :
        <section className="result-grid">{episodes.map((episode) => {
          const active = episode.versions.find((version) => version.id === episode.activeVersionId) ?? episode.versions[0];
          return <article className="result-card panel" key={episode.id}>
            <div className="video-placeholder"><span>▶</span><small>{episode.duration}s · 9:16</small></div>
            <div className="result-body">
              <div className="section-title"><div><h3>{episode.title}</h3><small>任务 {active.taskId || "提交中"}</small></div><Badge tone={episode.status === "accepted" ? "success" : "warning"}>{episode.status === "accepted" ? "已采用" : episode.status}</Badge></div>
              <p>{episode.summary}</p>
              <select value={active.id} onChange={(event) => setState(switchVersion(state, episode.id, event.target.value))}>{episode.versions.map((version, index) => <option value={version.id} key={version.id}>版本 {index + 1} · {formatTime(version.createdAt)}</option>)}</select>
              <div className="button-row">{episode.status === "review" || episode.status === "accepted" ? <Button onClick={() => setState(acceptEpisode(state, episode.id))}>采用结果</Button> : null}<Button variant="quiet" onClick={() => void regenerate(episode)}>重新生成</Button>{episode.status === "generating" ? <Button variant="danger" onClick={() => void cancel(episode)}>取消任务</Button> : null}</div>
            </div>
          </article>;
        })}</section>}
    </>
  );
}

function SettingsWorkspace({ state, setState }: { state: AppState; setState: SetAppState }) {
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState("");
  const [active, setActive] = useState(state.profiles[2]?.id ?? "");
  const profile = state.profiles.find((item) => item.id === active) ?? state.profiles[0];
  const update = (patch: Partial<ModelProfile>) =>
    setState({ ...state, profiles: state.profiles.map((item) => item.id === profile.id ? { ...item, ...patch } : item) });
  const persistSecret = async () => {
    if (!secret.trim()) return setMessage("请输入密钥。");
    await saveSecret(profile.secretRef, secret);
    update({ hasSecret: true });
    setSecret("");
    setMessage("密钥已写入系统密钥链。");
  };
  const validate = async () => {
    try { setMessage(await validateProfile(profile)); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <>
      <header className="page-header"><div><p className="eyebrow">MODEL PROFILES</p><h1>适配器与密钥</h1><p>密钥只写入系统密钥链。项目文件、SQLite 和日志仅保存密钥引用。</p></div><Button variant="ghost" onClick={async () => setMessage(await exportDiagnostics())}>导出诊断日志</Button></header>
      <section className="settings-layout">
        <aside className="panel profile-list">{state.profiles.map((item) => <button className={item.id === profile.id ? "active" : ""} onClick={() => setActive(item.id)} key={item.id}><span>{item.capability.toUpperCase()}</span><strong>{item.name}</strong><small>{item.adapter}</small></button>)}</aside>
        <article className="panel settings-form">
          <div className="section-title"><div><p className="eyebrow">{profile.capability.toUpperCase()} ADAPTER</p><h2>{profile.name}</h2></div><Badge tone={profile.hasSecret ? "success" : "warning"}>{profile.hasSecret ? "密钥已配置" : "缺少密钥"}</Badge></div>
          <label>显示名称<input value={profile.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <label>协议适配器<select value={profile.adapter} onChange={(event) => update({ adapter: event.target.value as ModelProfile["adapter"] })}><option value="openai-chat">OpenAI-compatible Chat</option><option value="openai-responses">OpenAI-compatible Responses</option><option value="openai-images">OpenAI Images-compatible</option><option value="volcengine-images">火山方舟图片生成</option><option value="volcengine-seedance">火山方舟 Seedance 2.0</option></select></label>
          <label>Base URL<input value={profile.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label>
          <label>模型名<input value={profile.model} onChange={(event) => update({ model: event.target.value })} /></label>
          <label>密钥<input type="password" placeholder="写入后不会显示" value={secret} onChange={(event) => setSecret(event.target.value)} /></label>
          <div className="button-row"><Button onClick={persistSecret}>保存到密钥链</Button><Button variant="ghost" onClick={validate}>校验示例请求</Button></div>
          {message && <div className="form-message">{message}</div>}
          {profile.capability === "video" && <div className="advanced"><strong>Seedance 默认参数</strong><div className="param-row"><span>duration = -1 自适应</span><span>generate_audio = true</span><span>POST /api/v3/contents/generations/tasks</span></div></div>}
        </article>
      </section>
    </>
  );
}

export function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [showProjectManager, setShowProjectManager] = useState(false);

  useEffect(() => { loadSnapshot().then((stored) => { if (stored) setState(stored); setReady(true); }); }, []);
  useEffect(() => { if (ready) void saveSnapshot(state); }, [state, ready]);
  useEffect(() => {
    if (!ready || !inTauri()) return;
    const profile = state.profiles.find((item) => item.capability === "video" && item.hasSecret);
    if (!profile) return;
    const pending = state.episodes.flatMap((episode) =>
      episode.versions
        .filter((version) => version.taskId && (version.status === "queued" || version.status === "generating"))
        .map((version) => ({ episode, version })),
    );
    if (!pending.length) return;
    let disposed = false;
    const poll = () => {
      void Promise.all(
        pending.map(async ({ episode, version }) => {
          try {
            const remote = await querySeedanceTask(profile, version.taskId);
            if (disposed) return;
            if (remote.status === "review" && remote.resultUrl) {
              const localPath = await downloadResult(
                remote.resultUrl,
                `${state.project.directory}/episodes/episode-${episode.number}-${version.id}.mp4`,
              );
              if (disposed) return;
              setState((current) =>
                addActivity(
                  markRemoteTask(current, episode.id, version.id, { ...remote, localPath }),
                  `${episode.title}已下载到本地项目目录`,
                  "success",
                ),
              );
            } else if (remote.status !== version.status) {
              setState((current) => markRemoteTask(current, episode.id, version.id, remote));
            }
          } catch (error) {
            if (!disposed) {
              setState((current) =>
                addActivity(
                  current,
                  `${episode.title}远端状态查询失败，将继续重试：${error instanceof Error ? error.message : String(error)}`,
                  "warning",
                ),
              );
            }
          }
        }),
      );
    };
    const timer = window.setInterval(poll, 5000);
    poll();
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [ready, state.episodes, state.profiles, state.project.directory]);
  const activeBatch = useMemo(() => state.batches.find((batch) => batch.status !== "completed"), [state.batches]);

  if (!ready) return <div className="loading">正在恢复本地项目...</div>;
  if (!state.onboardingComplete || showProjectManager) {
    return (
      <ProjectManager
        state={state}
        canClose={state.onboardingComplete}
        onClose={() => setShowProjectManager(false)}
        onDemo={() => {
          setState(makeDemoState(state));
          setShowProjectManager(false);
          setTab("overview");
        }}
        onCreate={(name, directory) => {
          setState(createWorkspace(state, name, directory));
          setShowProjectManager(false);
          setTab("overview");
        }}
        onOpen={(projectId) => {
          setState(openWorkspace(state, projectId));
          setShowProjectManager(false);
          setTab("overview");
        }}
      />
    );
  }

  const content = {
    overview: <Overview state={state} setTab={setTab} />,
    script: <ScriptWorkspace state={state} setState={setState} />,
    assets: <AssetsWorkspace state={state} setState={setState} />,
    batch: <BatchWorkspace state={state} setState={setState} />,
    results: <ResultsWorkspace state={state} setState={setState} />,
    settings: <SettingsWorkspace state={state} setState={setState} />,
  }[tab];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="logo"><b>P</b><div><strong>Ploteo</strong><small>短剧编排器</small></div></div>
        <button className="project-switcher" onClick={() => setShowProjectManager(true)}><small>PROJECTS</small><span>切换项目</span></button>
        <nav>{tabs.map((item) => <button className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} key={item.id}><small>{item.hint}</small><span>{item.label}</span>{item.id === "batch" && activeBatch && <i />}</button>)}</nav>
        <div className="sidebar-foot"><span>LOCAL PROJECT</span><strong>{state.project.name || "未命名项目"}</strong><small>{state.project.directory || "尚未选择项目目录"}</small></div>
      </aside>
      <main className="content">{content}</main>
    </div>
  );
}
