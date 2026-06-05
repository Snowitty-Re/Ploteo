use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

const CREATE_TASK_PATH: &str = "/api/v3/contents/generations/tasks";
const PROJECT_MARKER: &str = ".ploteo-project.json";
const PI_AGENT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProfile {
    id: String,
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
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    profile: ModelProfile,
    prompt: String,
    project_id: Option<String>,
    agent_kind: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageGenerationResponse {
    preview_url: String,
    local_path: Option<String>,
    remote_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PiAgentResponse {
    ok: bool,
    text: Option<String>,
    error: Option<String>,
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
        .busy_timeout(Duration::from_secs(10))
        .map_err(|error| error.to_string())?;
    let legacy_entities = connection
        .prepare("PRAGMA table_info(episodes)")
        .and_then(|mut statement| {
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(!columns.is_empty() && !columns.iter().any(|column| column == "position"))
        })
        .unwrap_or(false);
    if legacy_entities {
        connection
            .execute_batch(
                "DROP TABLE IF EXISTS generation_tasks;
                 DROP TABLE IF EXISTS episode_versions;
                 DROP TABLE IF EXISTS agent_profiles;
                 DROP TABLE IF EXISTS model_profiles;
                 DROP TABLE IF EXISTS assets;
                 DROP TABLE IF EXISTS batches;
                 DROP TABLE IF EXISTS episodes;
                 DROP TABLE IF EXISTS scripts;
                 DROP TABLE IF EXISTS projects;",
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS app_snapshot (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS app_metadata (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                onboarding_complete INTEGER NOT NULL DEFAULT 0,
                active_project_id TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                directory TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS scripts (
                project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS episodes (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS batches (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS model_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS credentials (
                secret_ref TEXT PRIMARY KEY,
                secret TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS episode_versions (
                id TEXT PRIMARY KEY,
                episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS generation_tasks (
                id TEXT PRIMARY KEY,
                episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
                version_id TEXT REFERENCES episode_versions(id) ON DELETE CASCADE,
                remote_task_id TEXT,
                status TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS activities (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                agent_kind TEXT NOT NULL,
                model_profile_id TEXT,
                prompt TEXT NOT NULL,
                response TEXT,
                status TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS provider_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                capability TEXT NOT NULL,
                model_profile_id TEXT,
                endpoint TEXT NOT NULL,
                request_payload TEXT NOT NULL,
                response_payload TEXT,
                remote_task_id TEXT,
                status TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS deleted_projects (
                id TEXT PRIMARY KEY,
                deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
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

fn missing_secret_message(secret_ref: &str) -> String {
    format!("密钥引用 {secret_ref} 尚未写入 Ploteo 本地数据库")
}

fn read_secret(app: &AppHandle, secret_ref: &str) -> Result<Option<String>, String> {
    db(app)?
        .query_row(
            "SELECT secret FROM credentials WHERE secret_ref = ?1",
            [secret_ref],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn has_stored_secret(app: &AppHandle, secret_ref: &str) -> Result<bool, String> {
    Ok(read_secret(app, secret_ref)?.is_some_and(|secret| !secret.trim().is_empty()))
}

fn get_secret(app: &AppHandle, secret_ref: &str) -> Result<String, String> {
    match read_secret(app, secret_ref)? {
        Some(secret) if !secret.trim().is_empty() => Ok(secret),
        Some(_) => Err(format!("密钥引用 {secret_ref} 为空，请重新保存密钥")),
        None => Err(missing_secret_message(secret_ref)),
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), path)
}

fn pi_agent_command(app: &AppHandle) -> Result<Command, String> {
    let executable_name = if cfg!(target_os = "windows") {
        "ploteo-pi-agent.exe"
    } else {
        "ploteo-pi-agent"
    };
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("binaries")
        .join(executable_name);
    if bundled.exists() {
        let mut command = Command::new(bundled);
        configure_background_process(&mut command);
        return Ok(command);
    }
    if cfg!(debug_assertions) {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("无法定位项目目录")?
            .join("scripts/pi-agent-sidecar.mjs");
        let mut command = Command::new("node");
        command.arg(script);
        configure_background_process(&mut command);
        return Ok(command);
    }
    Err("Pi Agent sidecar 未打包，请重新安装 Ploteo".into())
}

#[cfg(target_os = "windows")]
fn configure_background_process(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_background_process(_command: &mut Command) {}

async fn run_pi_agent(app: &AppHandle, request: &AgentRequest) -> Result<String, String> {
    let secret = get_secret(app, &request.profile.secret_ref)?;
    let payload = json!({
        "id": format!("run-{}", chrono_timestamp()),
        "profile": request.profile,
        "secret": secret,
        "prompt": request.prompt,
        "agentKind": request.agent_kind.as_deref().unwrap_or("coordinator"),
    });
    let connection = db(app)?;
    connection
        .execute(
            "INSERT INTO provider_requests(project_id, capability, model_profile_id, endpoint, request_payload, status)
             VALUES (?1, 'text', ?2, 'pi-agent-sidecar', ?3, 'running')",
            params![
                request.project_id.as_deref(),
                &request.profile.id,
                json!({
                    "profileId": request.profile.id,
                    "model": request.profile.model,
                    "agentKind": request.agent_kind,
                    "prompt": request.prompt,
                })
                .to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    let provider_request_id = connection.last_insert_rowid();

    let mut command = pi_agent_command(app)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Pi Agent sidecar：{error}"))?;
    let mut stdin = child.stdin.take().ok_or("无法打开 Pi Agent 输入流")?;
    stdin
        .write_all(format!("{payload}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    drop(stdin);
    let output = timeout(PI_AGENT_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "Pi Agent 请求超过 180 秒，已终止本次运行".to_string())?
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let response_line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!("Pi Agent 未返回有效响应：{}", redact(stderr.trim()))
        })?;
    let response: PiAgentResponse =
        serde_json::from_str(response_line).map_err(|error| error.to_string())?;
    if response.ok {
        let text = response
            .text
            .filter(|text| !text.trim().is_empty())
            .ok_or("Pi Agent 返回内容为空")?;
        connection
            .execute(
                "UPDATE provider_requests SET status = 'completed', response_payload = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![json!({ "text": text }).to_string(), provider_request_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(text)
    } else {
        let error = response.error.unwrap_or_else(|| "Pi Agent 请求失败".into());
        connection
            .execute(
                "UPDATE provider_requests SET status = 'failed', error = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![redact(&error), provider_request_id],
            )
            .map_err(|db_error| db_error.to_string())?;
        Err(error)
    }
}

fn chrono_timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
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
    project_id: Option<&str>,
) -> Result<Value, String> {
    let secret = get_secret(app, &profile.secret_ref)?;
    let url = endpoint(&profile.base_url, path);
    let body = with_defaults(body, &profile.defaults);
    let connection = db(app)?;
    connection
        .execute(
            "INSERT INTO provider_requests(project_id, capability, model_profile_id, endpoint, request_payload, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
            params![
                project_id,
                profile.capability,
                profile.id,
                url,
                body.to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    let request_id = connection.last_insert_rowid();
    log(app, "info", &format!("POST {url} model={}", profile.model));
    let response = match Client::new()
        .post(url)
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            let _ = connection.execute(
                "UPDATE provider_requests SET status = 'failed', error = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![redact(&message), request_id],
            );
            return Err(message);
        }
    };
    let status = response.status();
    let raw = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    if status.is_success() {
        connection
            .execute(
                "UPDATE provider_requests SET status = 'completed', response_payload = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![raw.to_string(), request_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(raw)
    } else {
        connection
            .execute(
                "UPDATE provider_requests SET status = 'failed', response_payload = ?1, error = ?2, completed_at = CURRENT_TIMESTAMP WHERE id = ?3",
                params![raw.to_string(), format!("HTTP {status}"), request_id],
            )
            .map_err(|error| error.to_string())?;
        log(
            app,
            "error",
            &format!("provider request failed status={status} body={raw}"),
        );
        Err(format!("模型请求失败：HTTP {status}"))
    }
}

fn json_id(value: &Value) -> Result<&str, String> {
    value
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "持久化对象缺少 id".to_string())
}

fn insert_workspace(transaction: &Transaction<'_>, workspace: &Value) -> Result<(), String> {
    let project = workspace
        .get("project")
        .ok_or_else(|| "项目工作区缺少 project".to_string())?;
    let project_id = json_id(project)?;
    let deleted = transaction
        .query_row(
            "SELECT 1 FROM deleted_projects WHERE id = ?1",
            [project_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if deleted {
        return Ok(());
    }
    let directory = project
        .get("directory")
        .and_then(Value::as_str)
        .unwrap_or_default();
    transaction
        .execute(
            "INSERT INTO projects(id, directory, payload) VALUES (?1, ?2, ?3)",
            params![project_id, directory, project.to_string()],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO scripts(project_id, payload) VALUES (?1, ?2)",
            params![
                project_id,
                project
                    .get("script")
                    .cloned()
                    .unwrap_or(Value::String(String::new()))
                    .to_string()
            ],
        )
        .map_err(|error| error.to_string())?;

    for (position, episode) in workspace
        .get("episodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let episode_id = json_id(episode)?;
        transaction
            .execute(
                "INSERT INTO episodes(id, project_id, position, payload) VALUES (?1, ?2, ?3, ?4)",
                params![episode_id, project_id, position as i64, episode.to_string()],
            )
            .map_err(|error| error.to_string())?;
        for (version_position, version) in episode
            .get("versions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let version_id = json_id(version)?;
            transaction
                .execute(
                    "INSERT INTO episode_versions(id, episode_id, position, payload) VALUES (?1, ?2, ?3, ?4)",
                    params![version_id, episode_id, version_position as i64, version.to_string()],
                )
                .map_err(|error| error.to_string())?;
            let status = version
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("draft");
            let remote_task_id = version.get("taskId").and_then(Value::as_str);
            if remote_task_id.is_some() || status != "draft" {
                transaction
                    .execute(
                        "INSERT INTO generation_tasks(id, episode_id, version_id, remote_task_id, status, payload)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            format!("task:{version_id}"),
                            episode_id,
                            version_id,
                            remote_task_id,
                            status,
                            version.to_string()
                        ],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    for (table, key) in [
        ("assets", "assets"),
        ("batches", "batches"),
        ("activities", "activity"),
    ] {
        for (position, item) in workspace
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            transaction
                .execute(
                    &format!(
                        "INSERT INTO {table}(id, project_id, position, payload) VALUES (?1, ?2, ?3, ?4)"
                    ),
                    params![json_id(item)?, project_id, position as i64, item.to_string()],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn persist_state(app: &AppHandle, snapshot: &str) -> Result<(), String> {
    let state: Value = serde_json::from_str(snapshot).map_err(|error| error.to_string())?;
    let current_project_id = state.pointer("/project/id").and_then(Value::as_str);
    let onboarding_complete = state
        .get("onboardingComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut workspaces: HashMap<String, Value> = HashMap::new();
    for workspace in state
        .get("workspaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = workspace.pointer("/project/id").and_then(Value::as_str) {
            workspaces.insert(id.to_string(), workspace.clone());
        }
    }
    if let Some(project) = state.get("project") {
        let named = project
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        let directory = project
            .get("directory")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        if let Some(current_project_id) = current_project_id.filter(|_| named || directory) {
            let workspace = json!({
                "project": project,
                "episodes": state.get("episodes").cloned().unwrap_or_else(|| json!([])),
                "assets": state.get("assets").cloned().unwrap_or_else(|| json!([])),
                "batches": state.get("batches").cloned().unwrap_or_else(|| json!([])),
                "activity": state.get("activity").cloned().unwrap_or_else(|| json!([])),
            });
            workspaces.insert(current_project_id.to_string(), workspace);
        }
    }

    let mut connection = db(app)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(
            "DELETE FROM generation_tasks;
             DELETE FROM episode_versions;
             DELETE FROM activities;
             DELETE FROM assets;
             DELETE FROM batches;
             DELETE FROM episodes;
             DELETE FROM scripts;
             DELETE FROM projects;
             DELETE FROM model_profiles;",
        )
        .map_err(|error| error.to_string())?;
    for workspace in workspaces.values() {
        insert_workspace(&transaction, workspace)?;
    }
    for profile in state
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        transaction
            .execute(
                "INSERT INTO model_profiles(id, payload) VALUES (?1, ?2)",
                params![json_id(profile)?, profile.to_string()],
            )
            .map_err(|error| error.to_string())?;
    }
    let active_project_id = current_project_id.filter(|id| workspaces.contains_key(*id));
    transaction
        .execute(
            "INSERT INTO app_metadata(id, onboarding_complete, active_project_id)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET
                onboarding_complete = excluded.onboarding_complete,
                active_project_id = excluded.active_project_id,
                updated_at = CURRENT_TIMESTAMP",
            params![onboarding_complete, active_project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM app_snapshot", [])
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

fn load_payloads(
    connection: &Connection,
    sql: &str,
    project_id: &str,
) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let payload = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&payload).map_err(|error| error.to_string())
    })
    .collect()
}

fn load_normalized_state(app: &AppHandle) -> Result<Option<String>, String> {
    let connection = db(app)?;
    let project_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if project_count == 0 {
        let profiles = load_payloads(
            &connection,
            "SELECT payload FROM model_profiles WHERE ?1 = ?1 ORDER BY id",
            "",
        )?;
        if profiles.is_empty() {
            return Ok(None);
        }
        return Ok(Some(
            json!({
                "onboardingComplete": false,
                "workspaces": [],
                "profiles": profiles,
            })
            .to_string(),
        ));
    }
    let metadata = connection
        .query_row(
            "SELECT onboarding_complete, active_project_id FROM app_metadata WHERE id = 1",
            [],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or((false, None));
    let mut statement = connection
        .prepare("SELECT id, payload FROM projects ORDER BY updated_at DESC, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut workspaces = Vec::new();
    for row in rows {
        let (project_id, payload) = row.map_err(|error| error.to_string())?;
        let project: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        workspaces.push(json!({
            "project": project,
            "episodes": load_payloads(&connection, "SELECT payload FROM episodes WHERE project_id = ?1 ORDER BY position", &project_id)?,
            "assets": load_payloads(&connection, "SELECT payload FROM assets WHERE project_id = ?1 ORDER BY position", &project_id)?,
            "batches": load_payloads(&connection, "SELECT payload FROM batches WHERE project_id = ?1 ORDER BY position", &project_id)?,
            "activity": load_payloads(&connection, "SELECT payload FROM activities WHERE project_id = ?1 ORDER BY position", &project_id)?,
        }));
    }
    let active_index = metadata
        .1
        .as_deref()
        .and_then(|active_id| {
            workspaces.iter().position(|workspace| {
                workspace.pointer("/project/id").and_then(Value::as_str) == Some(active_id)
            })
        })
        .unwrap_or(0);
    let active = workspaces[active_index].clone();
    let profiles = load_payloads(
        &connection,
        "SELECT payload FROM model_profiles WHERE ?1 = ?1 ORDER BY id",
        "",
    )?;
    Ok(Some(
        json!({
            "onboardingComplete": metadata.0,
            "project": active.get("project").cloned().unwrap_or_else(|| json!({})),
            "episodes": active.get("episodes").cloned().unwrap_or_else(|| json!([])),
            "assets": active.get("assets").cloned().unwrap_or_else(|| json!([])),
            "batches": active.get("batches").cloned().unwrap_or_else(|| json!([])),
            "activity": active.get("activity").cloned().unwrap_or_else(|| json!([])),
            "workspaces": workspaces,
            "profiles": profiles,
        })
        .to_string(),
    ))
}

#[tauri::command]
fn load_snapshot(app: AppHandle) -> Result<Option<String>, String> {
    if let Some(state) = load_normalized_state(&app)? {
        return Ok(Some(state));
    }
    let connection = db(&app)?;
    let mut statement = connection
        .prepare("SELECT payload FROM app_snapshot WHERE id = 1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    rows.next()
        .map_err(|error| error.to_string())?
        .map(|row| row.get(0))
        .transpose()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_snapshot(app: AppHandle, snapshot: String) -> Result<(), String> {
    persist_state(&app, &snapshot)
}

#[tauri::command]
async fn generate_text(app: AppHandle, request: AgentRequest) -> Result<String, String> {
    if request.profile.capability != "text" {
        return Err("当前配置不是文本模型".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("文本 Prompt 不能为空".into());
    }
    let connection = db(&app)?;
    connection
        .execute(
            "INSERT INTO agent_runs(project_id, agent_kind, model_profile_id, prompt, status)
             VALUES (?1, ?2, ?3, ?4, 'running')",
            params![
                request.project_id.as_deref(),
                request.agent_kind.as_deref().unwrap_or("text"),
                &request.profile.id,
                &request.prompt
            ],
        )
        .map_err(|error| error.to_string())?;
    let run_id = connection.last_insert_rowid();
    let content = match run_pi_agent(&app, &request).await {
        Ok(content) => content,
        Err(error) => {
            let _ = connection.execute(
                "UPDATE agent_runs SET status = 'failed', error = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![redact(&error), run_id],
            );
            return Err(error);
        }
    };
    connection
        .execute(
            "UPDATE agent_runs SET status = 'completed', response = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![&content, run_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(content)
}

#[tauri::command]
async fn generate_image(
    app: AppHandle,
    request: AgentRequest,
) -> Result<ImageGenerationResponse, String> {
    if request.profile.capability != "image" {
        return Err("当前配置不是图片模型".into());
    }
    if request.prompt.trim().is_empty() {
        return Err("图片 Prompt 不能为空".into());
    }
    let body = if request.profile.adapter == "volcengine-images" {
        json!({
            "model": request.profile.model,
            "prompt": request.prompt,
            "response_format": "url",
            "watermark": false
        })
    } else {
        json!({ "model": request.profile.model, "prompt": request.prompt, "n": 1 })
    };
    let raw = post_profile_json(
        &app,
        &request.profile,
        "/images/generations",
        body,
        request.project_id.as_deref(),
    )
    .await?;
    if let Some(url) = raw.pointer("/data/0/url").and_then(Value::as_str) {
        let response = Client::new()
            .get(url)
            .send()
            .await
            .map_err(|error| format!("图片已生成但下载失败：{error}"))?;
        if !response.status().is_success() {
            return Err(format!("图片已生成但下载失败：HTTP {}", response.status()));
        }
        let extension = match response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
        {
            value if value.contains("png") => "png",
            value if value.contains("webp") => "webp",
            value if value.contains("gif") => "gif",
            _ => "jpg",
        };
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        let directory = app_dir(&app)?.join("generated-images");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let path = directory.join(format!("image-{}.{}", chrono_timestamp(), extension));
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        return Ok(ImageGenerationResponse {
            preview_url: url.to_string(),
            local_path: Some(path.display().to_string()),
            remote_url: Some(url.to_string()),
        });
    }
    if let Some(base64) = raw.pointer("/data/0/b64_json").and_then(Value::as_str) {
        return Ok(ImageGenerationResponse {
            preview_url: format!("data:image/png;base64,{base64}"),
            local_path: None,
            remote_url: None,
        });
    }
    Err("图片模型响应中缺少图片 URL 或 base64 数据".into())
}

#[tauri::command]
fn load_image_reference(path: String) -> Result<String, String> {
    let path = expand_home(&path);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 30 * 1024 * 1024 {
        return Err("参考图片必须小于 30 MB".into());
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let mime = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/jpeg",
    };
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[tauri::command]
fn store_secret(app: AppHandle, secret_ref: String, secret: String) -> Result<bool, String> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err("密钥不能为空".into());
    }
    db(&app)?
        .execute(
            "INSERT INTO credentials(secret_ref, secret) VALUES (?1, ?2)
             ON CONFLICT(secret_ref) DO UPDATE SET
                secret = excluded.secret,
                updated_at = CURRENT_TIMESTAMP",
            params![secret_ref, secret],
        )
        .map_err(|error| error.to_string())?;
    let stored = get_secret(&app, &secret_ref)?;
    if stored != secret {
        return Err(format!(
            "密钥引用 {secret_ref} 写入后读回内容不一致，请重新保存"
        ));
    }
    log(
        &app,
        "info",
        &format!("updated and verified SQLite credential reference {secret_ref}"),
    );
    Ok(true)
}

#[tauri::command]
fn has_secret(app: AppHandle, secret_ref: String) -> Result<bool, String> {
    has_stored_secret(&app, &secret_ref)
}

#[tauri::command]
async fn validate_profile(app: AppHandle, profile: ModelProfile) -> Result<String, String> {
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
    if !has_stored_secret(&app, &profile.secret_ref)? {
        return Err(missing_secret_message(&profile.secret_ref));
    }
    let secret = get_secret(&app, &profile.secret_ref)?;
    let models_path = if profile.adapter == "volcengine-seedance"
        && !profile.base_url.trim_end_matches('/').ends_with("/api/v3")
    {
        "/api/v3/models"
    } else {
        "/models"
    };
    let url = endpoint(&profile.base_url, models_path);
    let response = Client::new()
        .get(&url)
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|error| format!("连接测试失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        log(
            &app,
            "error",
            &format!("profile validation failed status={status} body={body}"),
        );
        return Err(format!("连接测试失败：HTTP {status}"));
    }
    Ok(format!(
        "{} 连接成功：{} / {}。模型列表请求校验通过。",
        profile.name, profile.capability, profile.model
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
    let secret = get_secret(&app, &request.profile.secret_ref)?;
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    content.extend(request.image_refs.into_iter().map(|url| {
        json!({
            "type": "image_url",
            "image_url": { "url": url },
            "role": "reference_image"
        })
    }));
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
    let connection = db(&app)?;
    connection
        .execute(
            "INSERT INTO provider_requests(project_id, capability, model_profile_id, endpoint, request_payload, status)
             VALUES (?1, 'video', ?2, ?3, ?4, 'running')",
            params![
                request.project_id.as_deref(),
                &request.profile.id,
                &url,
                body.to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    let provider_request_id = connection.last_insert_rowid();
    log(
        &app,
        "info",
        &format!("POST {url} model={}", request.profile.model),
    );
    let response = match Client::new()
        .post(url)
        .bearer_auth(secret)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            let message = error.to_string();
            let _ = connection.execute(
                "UPDATE provider_requests SET status = 'failed', error = ?1, completed_at = CURRENT_TIMESTAMP WHERE id = ?2",
                params![redact(&message), provider_request_id],
            );
            return Err(message);
        }
    };
    let status = response.status();
    let raw: Value = response.json().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        connection
            .execute(
                "UPDATE provider_requests SET status = 'failed', response_payload = ?1, error = ?2, completed_at = CURRENT_TIMESTAMP WHERE id = ?3",
                params![raw.to_string(), format!("HTTP {status}"), provider_request_id],
            )
            .map_err(|error| error.to_string())?;
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
    connection
        .execute(
            "UPDATE provider_requests SET status = 'completed', response_payload = ?1, remote_task_id = ?2, completed_at = CURRENT_TIMESTAMP WHERE id = ?3",
            params![raw.to_string(), &task_id, provider_request_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(AdapterResponse { task_id, raw })
}

#[tauri::command]
async fn query_seedance_task(
    app: AppHandle,
    profile: ModelProfile,
    task_id: String,
) -> Result<Value, String> {
    let secret = get_secret(&app, &profile.secret_ref)?;
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
async fn cancel_seedance_task(
    app: AppHandle,
    profile: ModelProfile,
    task_id: String,
) -> Result<(), String> {
    let secret = get_secret(&app, &profile.secret_ref)?;
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

fn canonical_home() -> Option<PathBuf> {
    dirs::home_dir().and_then(|home| home.canonicalize().ok())
}

fn validate_project_root(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("项目目录不能为空".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("无法解析项目目录：{error}"))?;
    if canonical.parent().is_none() {
        return Err("拒绝使用磁盘根目录作为项目目录".into());
    }
    if canonical_home().is_some_and(|home| canonical == home) {
        return Err("拒绝使用用户主目录作为项目目录".into());
    }
    Ok(canonical)
}

fn marker_path(project_root: &Path) -> PathBuf {
    project_root.join(PROJECT_MARKER)
}

fn read_project_marker(project_root: &Path) -> Result<String, String> {
    let marker = fs::read_to_string(marker_path(project_root))
        .map_err(|_| "项目目录缺少 Ploteo 所有权标记，只允许删除项目记录".to_string())?;
    let marker: Value =
        serde_json::from_str(&marker).map_err(|_| "项目目录所有权标记无效".to_string())?;
    marker
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "项目目录所有权标记缺少项目 ID".to_string())
}

fn validate_deletion_target(path: &Path, project_id: &str) -> Result<PathBuf, String> {
    let canonical = validate_project_root(path)?;
    if read_project_marker(&canonical)? != project_id {
        return Err("项目目录所有权标记与当前项目不匹配，只允许删除项目记录".into());
    }
    Ok(canonical)
}

#[tauri::command]
fn initialize_project_directory(project_id: String, directory: String) -> Result<String, String> {
    if project_id.trim().is_empty() {
        return Err("项目 ID 不能为空".into());
    }
    let requested = expand_home(directory.trim());
    if !requested.is_absolute() {
        return Err("项目目录必须是绝对路径，请使用“选择目录”按钮".into());
    }
    fs::create_dir_all(&requested).map_err(|error| format!("无法创建项目目录：{error}"))?;
    let root = validate_project_root(&requested)?;
    let marker = marker_path(&root);
    if marker.exists() {
        if read_project_marker(&root)? != project_id {
            return Err("该目录已属于另一个 Ploteo 项目".into());
        }
        return Ok(requested.display().to_string());
    }
    let mut entries = fs::read_dir(&root).map_err(|error| error.to_string())?;
    if entries
        .next()
        .transpose()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Err("请选择空目录作为项目目录，避免删除项目时误删已有文件".into());
    }
    let marker_payload = json!({
        "format": 1,
        "projectId": project_id,
        "createdBy": "Ploteo"
    });
    fs::write(
        marker,
        serde_json::to_vec_pretty(&marker_payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("无法写入项目目录标记：{error}"))?;
    Ok(requested.display().to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteProjectResponse {
    file_warning: Option<String>,
}

#[tauri::command]
fn delete_project(
    app: AppHandle,
    project_id: String,
    delete_files: bool,
) -> Result<DeleteProjectResponse, String> {
    let mut connection = db(&app)?;
    let directory = connection
        .query_row(
            "SELECT directory FROM projects WHERE id = ?1",
            [&project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(directory) = directory else {
        return Ok(DeleteProjectResponse { file_warning: None });
    };
    let deletion_target = if delete_files {
        let target = expand_home(&directory);
        Some(validate_deletion_target(&target, &project_id)?)
    } else {
        None
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO deleted_projects(id) VALUES (?1)",
            [&project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM projects WHERE id = ?1", [&project_id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE app_metadata SET
                onboarding_complete = CASE WHEN active_project_id = ?1 THEN 0 ELSE onboarding_complete END,
                active_project_id = CASE WHEN active_project_id = ?1 THEN NULL ELSE active_project_id END,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = 1",
            [&project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;

    let file_warning = if let Some(target) = deletion_target {
        if target.exists() {
            fs::remove_dir_all(&target)
                .err()
                .map(|error| format!("项目记录已删除，但目录删除失败：{error}"))
        } else {
            None
        }
    } else {
        None
    };
    log(
        &app,
        "info",
        &format!("deleted project {project_id}, delete_files={delete_files}"),
    );
    Ok(DeleteProjectResponse { file_warning })
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
            load_image_reference,
            store_secret,
            has_secret,
            validate_profile,
            create_seedance_task,
            query_seedance_task,
            cancel_seedance_task,
            download_result,
            open_project_directory,
            select_project_directory,
            initialize_project_directory,
            delete_project,
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
            "密钥引用 text-default 尚未写入 Ploteo 本地数据库"
        );
    }

    #[test]
    fn deletion_target_rejects_root_and_home() {
        assert!(validate_project_root(Path::new("/")).is_err());
        if let Some(home) = dirs::home_dir() {
            assert!(validate_project_root(&home).is_err());
        }
    }

    #[test]
    fn deletion_target_requires_matching_marker() {
        let root = std::env::temp_dir().join(format!("ploteo-delete-test-{}", chrono_timestamp()));
        fs::create_dir_all(&root).unwrap();
        assert!(validate_deletion_target(&root, "project-a").is_err());
        fs::write(
            marker_path(&root),
            json!({ "projectId": "project-a" }).to_string(),
        )
        .unwrap();
        assert!(validate_deletion_target(&root, "project-b").is_err());
        assert_eq!(
            validate_deletion_target(&root, "project-a").unwrap(),
            root.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
