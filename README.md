# Ploteo

Ploteo 是一个 local-first 桌面短剧生成编排器。它使用确定性工作流管理完整剧本、自然拆集、核心角色素材确认、最多 5 集一批的视频任务，以及逐集采用和重新生成。

## Beta 范围

- Tauri 2 + React + TypeScript 桌面应用
- SQLite 本地快照和完整核心实体表
- 系统密钥链保存供应商密钥，SQLite 只保存引用
- 文本、图片和视频模型配置入口
- OpenAI-compatible Chat / Responses 文本生成与 Images-compatible 图片生成
- 火山方舟 Seedance 2.0 创建、查询、取消和下载适配器
- 日志脱敏与诊断导出
- 应用重启后恢复本地状态

视频适配器默认使用 `POST /api/v3/contents/generations/tasks`。每集限制为 `4~15` 秒，适配器也接受供应商自适应时长 `-1`。界面默认启用同步音频生成意图。

## 本地运行

```bash
pnpm install
pnpm test
pnpm build
pnpm tauri dev
```

浏览器预览模式使用 `localStorage` 保存快照，密钥只保存在当前浏览器会话。Tauri 桌面模式使用 SQLite 和系统密钥链。

## GitHub Actions 发布

仓库包含两个 workflow：

- `Desktop CI`：在 `main`、PR 和手动触发时运行前端测试、前端构建，以及 macOS / Windows Rust 测试。
- `Release Desktop Apps`：手动触发或推送 `v*` / `ploteo-v*` tag 时构建 Windows 10+ 与 macOS 包，并上传到 GitHub Release。

手动发布时，在 GitHub 的 Actions 页面运行 `Release Desktop Apps`。默认会创建 draft prerelease，确认产物后再发布。推送 tag 时会直接按 tag 创建 Release：

```bash
git tag ploteo-v0.1.0
git push origin ploteo-v0.1.0
```

当前 Beta 构建未做 Windows 代码签名，也未做 macOS 公证。

## 工作流

1. 首次启动进入项目管理器。可以载入演示项目，或手动选择本地目录并创建空白项目。
2. 在“剧本拆集”中导入完整剧本并自然拆集。
3. 在“视觉素材”中确认核心角色素材。
4. 在“批次工作台”准备下一批。单批最多并行 5 集。
5. 审校通过后提交批次，在“生成结果”逐集采用或重生成。
6. 当前批次全部采用后，再准备下一批。

侧边栏中的“切换项目”可随时返回项目管理器，在本地工作区与内置 Demo 之间切换。

未配置供应商密钥时，演示项目使用本地任务版本，便于离线验证完整流程。桌面端配置密钥后，编剧 Agent 可以根据创意生成完整剧本，图片 Agent 可以重新生成素材候选。视频批次提交会调用真实 Seedance 创建任务接口，并持久化远端任务 ID。应用会持续轮询未完成任务，重启后自动恢复查询，成功后将视频下载到项目目录。单集重生成、取消和历史版本切换保持独立。
