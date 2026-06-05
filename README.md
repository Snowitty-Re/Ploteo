# Ploteo

Ploteo 是一个 local-first 桌面短剧生成编排器。它使用确定性工作流管理完整剧本、自然拆集、核心角色素材确认、最多 5 集一批的视频任务，以及逐集采用和重新生成。

## Beta 范围

- Tauri 2 + React + TypeScript 桌面应用
- 支持 Windows 10/11 x64、macOS 11+ Intel 与 Apple Silicon
- 不生成、不发布且不支持 Windows ARM64
- SQLite 保存项目、剧本、短集、素材、模型配置、API Key、任务和 Agent 运行记录
- 项目删除支持仅删除数据库记录，或同时删除用户确认的项目目录
- Pi Agent sidecar 负责编剧、策划和审校等文本推理，不开放文件或命令工具
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

本地执行 `pnpm tauri build` 还需要安装 Bun，用于生成随应用打包的 Pi Agent sidecar。

浏览器预览模式使用 `localStorage` 保存界面状态，密钥只保存在当前浏览器会话。Tauri 桌面模式统一使用本地 SQLite。Beta 不使用系统钥匙串，API Key 以明文存入应用数据库，因此应限制本机账户和数据库文件访问权限。

## GitHub Actions 发布

仓库包含两个 workflow：

- `Desktop CI`：在 `main`、PR 和手动触发时构建并运行目标平台 sidecar、执行前端与 Rust 测试，并实际生成 Windows x64、macOS Intel 和 macOS Apple Silicon 安装包。
- `Release Desktop Apps`：先为目标平台编译 Pi Agent sidecar，再构建 Windows 10+ 与 macOS 包并上传到 GitHub Release。

手动发布时，在 GitHub 的 Actions 页面运行 `Release Desktop Apps`。默认会创建 draft prerelease，确认产物后再发布。推送 tag 时会直接按 tag 创建 Release：

```bash
git tag ploteo-v0.1.0
git push origin ploteo-v0.1.0
```

Windows 只发布 x64 包，不包含 Windows ARM64。当前 Beta 构建未做 Windows 代码签名，也未做 macOS 公证。

## 工作流

1. 首次启动进入项目管理器。可以载入演示项目，或手动选择本地目录并创建空白项目。
2. 在“剧本拆集”中生成或导入完整剧本。编剧 Agent 输出稳定剧情节点，策划与审校 Agent 生成分镜并验证完整覆盖。
3. 在“视觉素材”中确认核心角色素材。
4. 在“批次工作台”准备下一批。单批最多并行 5 集。
5. 审校通过后提交批次，在“生成结果”逐集采用或重生成。
6. 当前批次全部采用后，再准备下一批。

侧边栏中的“切换项目”可随时返回项目管理器，在本地工作区与内置 Demo 之间切换。

未配置供应商密钥时，演示项目使用本地任务版本，便于离线验证完整流程。桌面端配置密钥后，编剧 Agent 可以根据创意生成完整剧本，图片 Agent 可以重新生成素材候选。视频批次提交会调用真实 Seedance 创建任务接口，并持久化远端任务 ID。应用会持续轮询未完成任务，重启后自动恢复查询，成功后将视频下载到项目目录。单集重生成、取消和历史版本切换保持独立。
