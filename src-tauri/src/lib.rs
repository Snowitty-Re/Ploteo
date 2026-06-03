use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.ploteo.desktop";
const CREATE_TASK_PATH: &str = "/api/v3/contents/generations/tasks";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProfile {
    name: String,
    capability: String,
    adapter: String,
    base_url: String,
    model: String,
    secret_ref: String,
    has_secret: bool,
    defaults: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoRequest {
    profile: ModelProfile,
    prompt: String,
    params: VideoParams,
    image_refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct AgentRequest {
    profile: ModelProfile,
    prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoParams {
    duration: i32,
    resolution: String,
    ratio: String,
    generate_audio: bool,
    watermark: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterResponse {
    task_id: String,
    raw: Value,
}

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn db(app: &AppHandle) -> Result<Connection, String> {
    let connection =
        Connection::open(app_dir(app)?.join("ploteo.sqlite")).map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS app_snapshot (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS scripts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS episodes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS model_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS generation_tasks (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS episode_versions (id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS diagnostics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .map_err(|error| error.to_string())?;
    Ok(connection)
}

fn redact(message: &str) -> String {
    let mut output = message.to_string();
    for marker in ["Bearer ", "sk-", "AKLT"] {
        if let Some(start) = output.find(marker) {
            let suffix = &output[start + marker.len()..];
            let len = suffix.find(char::is_whitespace).unwrap_or(suffix.len());
            output.replace_range(start + marker.len()..start + marker.len() + len, "***");
        }
    }
    output
}

fn log(app: &AppHandle, level: &str, message: &str) {
    if let Ok(connection) = db(app) {
        let _ = connection.execute(
            "INSERT INTO diagnostics(level, message) VALUES (?1, ?2)",
            params![level, redact(message)],
        );
    }
}

fn entry(secret_ref: &str) -> Result<keyring::Entry, String> {
    #[cfg(target_os = "windows")]
    {
        keyring::Entry::new_with_target(&format!("{SERVICE}:{secret_ref}"), SERVICE, secret_ref)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        keyring::Entry::new(SERVICE, secret_ref).map_err(|error| error.to_string())
    }
}

fn missing_secret_message(secret_ref: &str) -> String {
    format!("密钥引用 {secret_ref} 尚未写入系统密钥链")
}

fn has_stored_secret(secret_ref: &str) -> Result<bool, String> {
    match entry(secret_ref)?.get_password() {
        Ok(secret) => Ok(!secret.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(format!(
            "无法读取系统密钥链中的密钥引用 {secret_ref}：{error}"
        )),
    }
}

fn get_secret(secret_ref: &str) -> Result<String, String> {
    match entry(secret_ref)?.get_password() {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret),
        Ok(_) => Err(format!("密钥引用 {secret_ref} 为空，请重新保存密钥")),
        Err(keyring::Error::NoEntry) => Err(missing_secret_message(secret_ref)),
        Err(error) => Err(format!(
            "无法读取系统密钥链中的密钥引用 {secret_ref}：{error}"
        )),
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn validate_video_params(params: &VideoParams) -> Result<(), String> {
    if params.duration != -1 && !(4..=15).contains(&params.duration) {
        return Err("Seedance 时长必须为自适应 -1 或 4~15 秒".into());
    }
    if params.resolution.trim().is_empty() || params.ratio.trim().is_empty() {
        return Err("分辨率和画幅不能为空".into());
    }
    Ok(())
}

fn with_defaults(mut body: Value, defaults: &Value) -> Value {
    if let (Some(body), Some(defaults)) = (body.as_object_mut(), defaults.as_object()) {
        for (key, value) in defaults {
            body.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    body
}

async fn post_profile_json(
    app: &AppHandle,
    profile: &ModelProfile,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let secret = get_secret(&profile.secret_ref)?;
    let url = endpoint(&profile.base_url, path);
    log(app, "info", &format!("POST {url} model={}", profile.model));
    let response = Client::new()
        .post(url)
        .bearer_auth(secret)
        .json(&with_defaults(body, &profile.defaults))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    if status.is_success() {
        Ok(raw)
    } else {
        log(
            app,
            "error",
            &format!("provider request failed status={status} body={raw}"),
        );
        Err(format!("模型请求失败：HTTP {status}"))
    }
}

#[tauri::command]
fn load_snapshot(app: AppHandle) -> Result<Option<String>, String> {
    let connection = db(&app)?;
    let mut statement = connection
        .prepare("SELECT payload FROM app_snapshot WHERE id = 1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    Ok(rows
        .next()
        .map_err(|error| error.to_string())?
        .map(|row| row.get(0))
        .transpose()
        .map_err(|error| error.to_string())?)
}

#[tauri::command]
fn save_snapshot(app: AppHandle, snapshot: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&snapshot).map_err(|error| error.to_string())?;
    db(&app)?
        .execute(
            "INSERT INTO app_snapshot(id, payload) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = CURRENT_TIMESTAMP",
            [snapshot],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn generate_text(app: AppHandle, request: AgentRequest) -> Result<String, String> {
    if request.profile.capability != "text" {
        return Err("当前配置不是文本模型".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("文本 Prompt 不能为空".into());
    }
    let (path, body) = if request.profile.adapter == "openai-responses" {
        (
            "/responses",
            json!({ "model": request.profile.model, "input": request.prompt }),
        )
    } else {
        (
            "/chat/completions",
            json!({
                "model": request.profile.model,
                "messages": [
                    { "role": "system", "content": "你是短剧编剧 Agent。只输出完整可拍摄剧本，不解释过程。" },
                    { "role": "user", "content": request.prompt }
                ]
            }),
        )
    };
    let raw = post_profile_json(&app, &request.profile, path, body).await?;
    raw.pointer("/choices/0/message/content")
        .or_else(|| raw.get("output_text"))
        .or_else(|| raw.pointer("/output/0/content/0/text"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("文本模型响应中缺少内容".into())
}

#[tauri::command]
async fn generate_image(app: AppHandle, request: AgentRequest) -> Result<String, String> {
    if request.profile.capability != "image" {
        return Err("当前配置不是图片模型".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("图片 Prompt 不能为空".into());
    }
    let body = json!({ "model": request.profile.model, "prompt": request.prompt, "n": 1 });
    let raw = post_profile_json(&app, &request.profile, "/images/generations", body).await?;
    if let Some(url) = raw.pointer("/data/0/url").and_then(Value::as_str) {
        return Ok(url.to_string());
    }
    if let Some(base64) = raw.pointer("/data/0/b64_json").and_then(Value::as_str) {
        return Ok(format!("data:image/png;base64,{base64}"));
    }
    Err("图片模型响应中缺少图片 URL 或 base64 数据".into())
}

#[tauri::command]
fn store_secret(app: AppHandle, secret_ref: String, secret: String) -> Result<bool, String> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("密钥不能为空".into());
    }
    entry(&secret_ref)?
        .set_password(secret)
        .map_err(|error| error.to_string())?;
    let stored = get_secret(&secret_ref)?;
    if stored != secret {
        return Err(format!(
            "密钥引用 {secret_ref} 写入后读回内容不一致，请重新保存"
        ));
    }
    log(
        &app,
        "info",
        &format!("updated and verified keychain reference {secret_ref}"),
    );
    Ok(true)
}

#[tauri::command]
fn has_secret(secret_ref: String) -> Result<bool, String> {
    has_stored_secret(&secret_ref)
}

#[tauri::command]
fn validate_profile(profile: ModelProfile) -> Result<String, String> {
    url::Url::parse(&profile.base_url).map_err(|_| "Base URL 必须是有效 URL")?;
    if profile.model.trim().is_empty() {
        return Err("模型名不能为空".into());
    }
    if profile.adapter == "volcengine-seedance" {
        let default_duration = profile
            .defaults
            .get("duration")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if default_duration != -1 && !(4..=15).contains(&default_duration) {
            return Err("Seedance 默认时长必须为 -1 或 4~15 秒".into());
        }
    }
    let secret_state = if profile.has_secret {
        "密钥引用已记录"
    } else {
        "尚未写入密钥"
    };
    Ok(format!(
        "{} 配置格式有效：{} / {}，{}。示例请求校验通过。",
        profile.name, profile.capability, profile.model, secret_state
    ))
}

#[tauri::command]
async fn create_seedance_task(
    app: AppHandle,
    request: VideoRequest,
) -> Result<AdapterResponse, String> {
    validate_video_params(&request.params)?;
    if request.prompt.trim().is_empty() {
        return Err("视频 Prompt 不能为空".into());
    }
    if request.profile.adapter != "volcengine-seedance" {
        return Err("当前配置不是 Seedance 适配器".into());
    }
    let secret = get_secret(&request.profile.secret_ref)?;
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    content.extend(
        request
            .image_refs
            .into_iter()
            .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
    );
    let body = json!({
        "model": request.profile.model,
        "content": content,
        "duration": request.params.duration,
        "resolution": request.params.resolution,
        "ratio": request.params.ratio,
        "generate_audio": request.params.generate_audio,
        "watermark": request.params.watermark,
    });
    let url = endpoint(&request.profile.base_url, CREATE_TASK_PATH);
    log(
        &app,
        "info",
        &format!("POST {url} model={}", request.profile.model),
    );
    let response = Client::new()
        .post(url)
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let raw: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        log(
            &app,
            "error",
            &format!("create task failed status={status} body={raw}"),
        );
        return Err(format!("Seedance 创建任务失败：HTTP {status}"));
    }
    let task_id = raw
        .get("id")
        .or_else(|| raw.get("task_id"))
        .and_then(Value::as_str)
        .ok_or("Seedance 响应中缺少任务 ID")?
        .to_string();
    Ok(AdapterResponse { task_id, raw })
}

#[tauri::command]
async fn query_seedance_task(profile: ModelProfile, task_id: String) -> Result<Value, String> {
    let secret = get_secret(&profile.secret_ref)?;
    let url = endpoint(&profile.base_url, &format!("{CREATE_TASK_PATH}/{task_id}"));
    let response = Client::new()
        .get(url)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    if status.is_success() {
        Ok(raw)
    } else {
        Err(format!("查询任务失败：HTTP {status}"))
    }
}

#[tauri::command]
async fn cancel_seedance_task(profile: ModelProfile, task_id: String) -> Result<(), String> {
    let secret = get_secret(&profile.secret_ref)?;
    let url = endpoint(&profile.base_url, &format!("{CREATE_TASK_PATH}/{task_id}"));
    let status = Client::new()
        .delete(url)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("取消任务失败：HTTP {status}"))
    }
}

#[tauri::command]
async fn download_result(
    app: AppHandle,
    url: String,
    destination: String,
) -> Result<String, String> {
    let response = Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("下载视频失败：HTTP {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let path = expand_home(&destination);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| error.to_string())?;
    log(
        &app,
        "info",
        &format!("downloaded result to {}", path.display()),
    );
    Ok(path.display().to_string())
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    Path::new(path).to_path_buf()
}

#[tauri::command]
fn open_project_directory(directory: String) -> Result<(), String> {
    if directory.trim().is_empty() {
        return Err("尚未选择项目目录".into());
    }
    let path = expand_home(&directory);
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    opener::open(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn select_project_directory() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("选择 Ploteo 项目目录")
        .pick_folder()
        .map(|path| path.display().to_string())
}

#[tauri::command]
fn export_diagnostics(app: AppHandle) -> Result<String, String> {
    let directory = app_dir(&app)?;
    let target = directory.join("ploteo-diagnostics.log");
    let connection = db(&app)?;
    let mut statement = connection
        .prepare("SELECT created_at, level, message FROM diagnostics ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(format!(
                "{} [{}] {}\n",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut contents = String::new();
    for row in rows {
        contents.push_str(&row.map_err(|error| error.to_string())?);
    }
    fs::write(&target, contents).map_err(|error| error.to_string())?;
    Ok(format!("诊断日志已导出：{}", target.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            save_snapshot,
            generate_text,
            generate_image,
            store_secret,
            has_secret,
            validate_profile,
            create_seedance_task,
            query_seedance_task,
            cancel_seedance_task,
            download_result,
            open_project_directory,
            select_project_directory,
            export_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ploteo");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_removes_authorization_values() {
        assert_eq!(
            redact("Authorization: Bearer sk-secret path"),
            "Authorization: Bearer *** path"
        );
        assert_eq!(redact("token=AKLT123456 next"), "token=AKLT*** next");
    }

    #[test]
    fn seedance_duration_is_strict() {
        let params = |duration| VideoParams {
            duration,
            resolution: "1080p".into(),
            ratio: "9:16".into(),
            generate_audio: true,
            watermark: false,
        };
        assert!(validate_video_params(&params(-1)).is_ok());
        assert!(validate_video_params(&params(4)).is_ok());
        assert!(validate_video_params(&params(15)).is_ok());
        assert!(validate_video_params(&params(3)).is_err());
        assert!(validate_video_params(&params(16)).is_err());
    }

    #[test]
    fn provider_defaults_do_not_override_explicit_values() {
        assert_eq!(
            with_defaults(
                json!({ "model": "demo", "temperature": 0.2 }),
                &json!({ "temperature": 0.8, "max_tokens": 400 }),
            ),
            json!({ "model": "demo", "temperature": 0.2, "max_tokens": 400 })
        );
    }

    #[test]
    fn missing_secret_message_includes_reference() {
        assert_eq!(
            missing_secret_message("text-default"),
            "密钥引用 text-default 尚未写入系统密钥链"
        );
    }
}
