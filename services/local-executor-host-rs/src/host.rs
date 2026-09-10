use crate::binding::validate_invocation_binding;
use crate::config::{
    resolve_execution_cwd, resolved_environment, ExecutionWorkspacePathError, HostAgentConfig,
    HostConfig,
};
use crate::output::{adapt_native_runtime_output, NativeOutput};
use crate::protocol::{
    authenticate_bearer, compact_json, create_callback_signature, failed_result, parse_run_request,
    request_fingerprint, rfc3339_now, succeeded_result, validate_callback_url, ProtocolError,
    HEADER_DELIVERY_ID, HEADER_KEY_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, MAX_REQUEST_BYTES,
};
use crate::state::{clear_run_state, terminate_orphan, write_run_state, RunState};
use crate::supervisor::supervise_process;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bytes::Bytes as HyperBytes;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Semaphore, watch};
use uuid::Uuid;

struct App {
    agent_name: String,
    bearer_token: String,
    config: HostConfig,
    profile: Option<HostAgentConfig>,
    environment: HashMap<String, String>,
    idempotency: Mutex<HashMap<String, IdempotencyRecord>>,
    slots: Arc<Semaphore>,
    shutdown: watch::Sender<bool>,
}

struct IdempotencyRecord {
    fingerprint: String,
    run_id: String,
    accepted_at: String,
}

pub async fn start_host(config: HostConfig) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let environment: HashMap<String, String> = std::env::vars().collect();
    if config.agents.is_empty() {
        let token = environment
            .get(&config.bearer_token_env)
            .cloned()
            .or_else(|| environment.get("HTTP_AGENT_BEARER_TOKEN").cloned())
            .ok_or("missing bearer token")?;
        bind_one("*".into(), config.port, None, config, token, environment, 4).await?;
        return Ok(());
    }
    let mut tasks = Vec::new();
    for profile in config.agents.clone() {
        if let Some(orphan) = terminate_orphan(&config.state_dir, &profile.agent).await {
            eprintln!(
                "Terminated orphaned process from a previous host run agent={} invocationId={orphan}",
                profile.agent
            );
        }
        let token = environment
            .get(&profile.bearer_token_env)
            .cloned()
            .ok_or_else(|| format!("missing bearer {}", profile.bearer_token_env))?;
        let cfg = config.clone();
        let env = environment.clone();
        tasks.push(tokio::spawn(async move {
            bind_one(
                profile.agent.clone(),
                profile.port,
                Some(profile),
                cfg,
                token,
                env,
                1,
            )
            .await
        }));
    }
    for task in tasks {
        task.await??;
    }
    Ok(())
}

async fn bind_one(
    agent_name: String,
    port: u16,
    profile: Option<HostAgentConfig>,
    config: HostConfig,
    bearer_token: String,
    environment: HashMap<String, String>,
    concurrency: usize,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (shutdown, _) = watch::channel(false);
    let app = Arc::new(App {
        agent_name: agent_name.clone(),
        bearer_token,
        config,
        profile,
        environment,
        idempotency: Mutex::new(HashMap::new()),
        slots: Arc::new(Semaphore::new(if agent_name == "*" {
            4
        } else {
            concurrency
        })),
        shutdown,
    });
    let shutdown_tx = app.shutdown.clone();
    let router = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/v1/runs", post(submit))
        .with_state(app);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!(
        "Local executor host agent listening agent={agent_name} host=127.0.0.1 port={port}"
    );
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = shutdown_tx.send(true);
        })
        .await?;
    Ok(())
}

async fn live() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn ready() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn submit(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !authenticate_bearer(
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        &app.bearer_token,
    ) {
        return error(401, "UNAUTHORIZED", "Bearer authentication failed");
    }
    if body.len() > MAX_REQUEST_BYTES {
        return error(413, "REQUEST_TOO_LARGE", "Request body exceeded the configured limit");
    }
    let value: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return error(400, "INVALID_JSON", "Request body must be valid JSON"),
    };
    let request = match parse_run_request(&value) {
        Ok(request) => request,
        Err(err) => return protocol_error(err),
    };
    let target = request
        .invocation
        .get("target")
        .and_then(|v| v.get("agent"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if app.agent_name != "*" && target != app.agent_name {
        return error(404, "AGENT_NOT_FOUND", "Target agent is not hosted by this Worker");
    }
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let invocation_id = request
        .invocation
        .get("invocationId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if idempotency_key.is_empty() || idempotency_key != invocation_id {
        return error(
            400,
            "INVALID_IDEMPOTENCY_KEY",
            "Idempotency-Key must equal invocationId",
        );
    }
    if !app
        .config
        .callback_keys
        .contains_key(&request.result_delivery.authentication.key_id)
    {
        return error(400, "UNKNOWN_CALLBACK_KEY", "Callback key ID is not configured");
    }
    if let Err(err) = validate_callback_url(
        &request.result_delivery.callback_url,
        &app.config.callback_allowed_origins,
        app.config.callback_allow_insecure,
    ) {
        return protocol_error(err);
    }

    let fingerprint = request_fingerprint(&value, idempotency_key);
    {
        let store = app.idempotency.lock().await;
        if let Some(existing) = store.get(&invocation_id) {
            if existing.fingerprint == fingerprint {
                return (
                    StatusCode::ACCEPTED,
                    Json(json!({
                        "schemaVersion": "1",
                        "invocationId": invocation_id,
                        "runId": existing.run_id,
                        "status": "accepted",
                        "acceptedAt": existing.accepted_at
                    })),
                )
                    .into_response();
            }
            return error(
                409,
                "IDEMPOTENCY_CONFLICT",
                "Invocation ID was already used by another request",
            );
        }
    }
    let permit = match app.slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return error(429, "QUEUE_FULL", "Worker run queue is full"),
    };
    let run_id = Uuid::new_v4().to_string();
    let accepted_at = rfc3339_now();
    app.idempotency.lock().await.insert(
        invocation_id.clone(),
        IdempotencyRecord {
            fingerprint,
            run_id: run_id.clone(),
            accepted_at: accepted_at.clone(),
        },
    );
    let app_clone = app.clone();
    tokio::spawn(async move {
        execute_run(app_clone, request).await;
        drop(permit);
    });
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "schemaVersion": "1",
            "invocationId": invocation_id,
            "runId": run_id,
            "status": "accepted",
            "acceptedAt": accepted_at
        })),
    )
        .into_response()
}

async fn execute_run(app: Arc<App>, request: crate::protocol::RunRequest) {
    let result = run_once(&app, &request).await;
    let body = compact_json(&Value::Object(result));
    let key_id = request.result_delivery.authentication.key_id.clone();
    let secret = app
        .config
        .callback_keys
        .get(&key_id)
        .cloned()
        .unwrap_or_default();
    deliver_callback(&request.result_delivery.callback_url, &key_id, &secret, &body).await;
}

async fn run_once(app: &App, request: &crate::protocol::RunRequest) -> serde_json::Map<String, Value> {
    let invocation = &request.invocation;
    let profile = match resolve_profile(app, invocation).await {
        Ok(profile) => profile,
        Err((code, message, retryable)) => {
            return failed_result(invocation, code, &message, retryable);
        }
    };
    if let Some(message) = validate_invocation_binding(&profile, invocation) {
        return failed_result(invocation, "EXECUTOR_HOST_CONNECTION_MISMATCH", &message, false);
    }
    let member = crate::config::execution_workspace_from_invocation(invocation).ok().flatten();
    let mut authorized_roots = Vec::new();
    if member
        .as_ref()
        .map(|m| m.mode == "shared")
        .unwrap_or(false)
    {
        if let Some(id) = member.as_ref().map(|m| m.source_workspace_id.as_str()) {
            if let Some(path) = resolve_workspace_path(id).await {
                authorized_roots.push(path);
            }
        }
    }
    let cwd = match resolve_execution_cwd(
        &profile,
        invocation,
        &app.config.allowed_root,
        &authorized_roots,
    ) {
        Ok(cwd) => cwd,
        Err(ExecutionWorkspacePathError(message)) => {
            return failed_result(
                invocation,
                "EXECUTOR_HOST_WORKSPACE_PATH_INVALID",
                &message,
                false,
            );
        }
    };
    let started_at = rfc3339_now();
    let env = resolved_environment(&profile, &app.environment);
    let requested_model = invocation
        .get("requestedModelId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let deadline = invocation
        .get("deadlineAt")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let state_dir = app.config.state_dir.clone();
    let agent = profile.agent.clone();
    let outcome = supervise_process(
        &profile,
        &env,
        invocation,
        requested_model.as_deref(),
        &cwd,
        app.shutdown.subscribe(),
        deadline.as_deref(),
        |pid| {
            write_run_state(
                &state_dir,
                &agent,
                &RunState {
                    invocation_id: invocation
                        .get("invocationId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    pid,
                    started_at: started_at.clone(),
                    kill_at: rfc3339_now(),
                },
            );
        },
        Duration::from_millis(5_000),
    )
    .await;
    clear_run_state(&app.config.state_dir, &profile.agent);
    match adapt_native_runtime_output(&outcome, &profile) {
        NativeOutput::Success { output } => succeeded_result(invocation, output),
        NativeOutput::Failure {
            code,
            message,
            retryable,
        } => failed_result(invocation, code, &message, retryable),
    }
}

async fn resolve_profile(
    app: &App,
    invocation: &Value,
) -> Result<HostAgentConfig, (&'static str, String, bool)> {
    if let Some(profile) = &app.profile {
        return Ok(profile.clone());
    }
    let connection = invocation.get("connection").ok_or((
        "EXECUTOR_HOST_CONNECTION_REQUIRED",
        "Dynamic local executor bridge requires an immutable connection reference".into(),
        false,
    ))?;
    let connection_id = connection
        .get("connectionId")
        .and_then(|v| v.as_str())
        .ok_or((
            "EXECUTOR_HOST_CONNECTION_REQUIRED",
            "Dynamic local executor bridge requires an immutable connection reference".into(),
            false,
        ))?;
    let revision = connection
        .get("revisionNumber")
        .and_then(|v| v.as_i64())
        .ok_or((
            "EXECUTOR_HOST_CONNECTION_REQUIRED",
            "Dynamic local executor bridge requires an immutable connection reference".into(),
            false,
        ))?;
    let config_hash = connection
        .get("configHash")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let (profile_json, stored_hash) = lookup_revision(connection_id, revision)
        .await
        .map_err(|message| ("EXECUTOR_HOST_DATABASE_ERROR", message, true))?
        .ok_or((
            "EXECUTOR_HOST_CONNECTION_NOT_FOUND",
            format!("Connection \"{connection_id}\" revision {revision} not found"),
            false,
        ))?;
    if stored_hash != config_hash {
        return Err((
            "EXECUTOR_HOST_CONNECTION_MISMATCH",
            format!(
                "Invocation selects revision hash \"{config_hash}\" but revision {revision} has hash \"{stored_hash}\""
            ),
            false,
        ));
    }
    let cli = profile_json.get("cli").ok_or((
        "EXECUTOR_HOST_CLI_NOT_CONFIGURED",
        format!("Connection \"{connection_id}\" does not declare a CLI profile"),
        false,
    ))?;
    let command = cli
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or((
            "EXECUTOR_HOST_CLI_NOT_CONFIGURED",
            format!("Connection \"{connection_id}\" does not declare a CLI profile"),
            false,
        ))?;
    let args = cli
        .get("args")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let model_argv_prefix = cli.get("modelArgvPrefix").and_then(|v| match v {
        Value::Array(items) => Some(
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect(),
        ),
        Value::String(s) => Some(vec![s.clone()]),
        _ => None,
    });
    let cwd = cli
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|cwd| app.config.allowed_root.join(cwd))
        .unwrap_or_else(|| app.config.allowed_root.clone());
    let env = object_string_map(cli.get("envAllowlist"));
    let secrets = object_string_map(cli.get("secrets"));
    Ok(HostAgentConfig {
        agent: invocation
            .get("target")
            .and_then(|v| v.get("agent"))
            .and_then(|v| v.as_str())
            .unwrap_or(connection_id)
            .to_string(),
        command: std::path::PathBuf::from(command),
        args,
        cwd,
        env,
        secrets,
        wall_time_ms: 300_000,
        max_stdout_bytes: 16 * 1024 * 1024,
        max_stderr_bytes: 16 * 1024 * 1024,
        port: app.config.port,
        bearer_token_env: app.config.bearer_token_env.clone(),
        connection_id: Some(connection_id.to_string()),
        config_hash: Some(config_hash.to_string()),
        runtime_kind: profile_json
            .get("runtimeKind")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        structured_result: profile_json
            .get("declaredCapabilities")
            .and_then(|v| v.get("structuredResult"))
            .and_then(|v| v.get("supported"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        model_argv_prefix,
        require_execution_workspace: true,
    })
}

fn object_string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(|v| v.as_object())
        .map(|object| {
            object
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn postgres_url() -> String {
    std::env::var("DATABASE_URL")
        .or_else(|_| std::env::var("TEST_DATABASE_URL"))
        .unwrap_or_else(|_| {
            format!(
                "postgres://{}:{}@{}:{}/{}",
                std::env::var("POSTGRES_USER").unwrap_or_else(|_| "postgres".into()),
                std::env::var("POSTGRES_PASSWORD").unwrap_or_else(|_| "postgres".into()),
                std::env::var("POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
                std::env::var("POSTGRES_PORT")
                    .or_else(|_| std::env::var("TENVYR_POSTGRES_PORT"))
                    .unwrap_or_else(|_| "5432".into()),
                std::env::var("POSTGRES_DB").unwrap_or_else(|_| "tenvyr".into()),
            )
        })
}

async fn lookup_revision(
    connection_id: &str,
    revision: i64,
) -> Result<Option<(Value, String)>, String> {
    let url = postgres_url();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let row = client
        .query_opt(
            r#"SELECT "profile"::text, "configHash" FROM "connection_revisions" WHERE "connectionId" = $1 AND "revisionNumber" = $2"#,
            &[&connection_id, &(revision as i32)],
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(match row {
        Some(row) => {
            let profile: String = row.get(0);
            let hash: String = row.get(1);
            Some((serde_json::from_str(&profile).unwrap_or(Value::Null), hash))
        }
        None => None,
    })
}

async fn resolve_workspace_path(source_workspace_id: &str) -> Option<std::path::PathBuf> {
    let url = postgres_url();
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .ok()?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let row = client
        .query_opt(
            r#"SELECT "path" FROM "workspaces" WHERE "id" = $1 LIMIT 1"#,
            &[&source_workspace_id],
        )
        .await
        .ok()??;
    let path: String = row.get(0);
    Some(std::path::PathBuf::from(path))
}

async fn deliver_callback(url: &str, key_id: &str, secret: &str, raw_body: &[u8]) {
    let client = Client::builder(TokioExecutor::new()).build_http();
    let delivery_id = Uuid::new_v4().to_string();
    let mut delay = Duration::from_millis(500);
    for _attempt in 1..=8 {
        let timestamp = (chrono::Utc::now().timestamp()).to_string();
        let signature = create_callback_signature(secret, &timestamp, &delivery_id, raw_body);
        let Ok(request) = hyper::Request::builder()
            .method(hyper::Method::POST)
            .uri(url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header(HEADER_KEY_ID, key_id)
            .header(HEADER_TIMESTAMP, &timestamp)
            .header(HEADER_DELIVERY_ID, &delivery_id)
            .header(HEADER_SIGNATURE, signature)
            .header("User-Agent", "Tenvyr-Worker/0.1.0")
            .body(Full::new(HyperBytes::copy_from_slice(raw_body)))
        else {
            return;
        };
        match tokio::time::timeout(Duration::from_secs(10), client.request(request)).await {
            Ok(Ok(response)) if response.status().is_success() => return,
            Ok(Ok(response))
                if response.status().as_u16() == 408
                    || response.status().as_u16() == 429
                    || response.status().is_server_error() => {}
            Ok(Ok(_)) => return,
            _ => {}
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

fn error(status: u16, code: &'static str, message: &str) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn protocol_error(err: ProtocolError) -> Response {
    error(err.status, err.code, &err.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_app(root: &std::path::Path, command: &std::path::Path) -> Router {
        let allowed = root.to_path_buf();
        let profile = HostAgentConfig {
            agent: "echo".into(),
            command: command.to_path_buf(),
            args: vec!["ok".into()],
            cwd: allowed.clone(),
            env: HashMap::new(),
            secrets: HashMap::new(),
            wall_time_ms: 5_000,
            max_stdout_bytes: 65_536,
            max_stderr_bytes: 65_536,
            port: 1,
            bearer_token_env: "TOKEN".into(),
            connection_id: None,
            config_hash: None,
            runtime_kind: None,
            structured_result: false,
            model_argv_prefix: None,
            require_execution_workspace: false,
        };
        let (shutdown, _) = watch::channel(false);
        let app = Arc::new(App {
            agent_name: "echo".into(),
            bearer_token: "token".into(),
            config: HostConfig {
                agents: vec![profile.clone()],
                allowed_root: allowed,
                state_dir: root.join("state"),
                callback_allowed_origins: vec!["http://127.0.0.1:9".into()],
                callback_keys: HashMap::from([("host-v1".into(), "secret".into())]),
                callback_allow_insecure: true,
                port: 1,
                bearer_token_env: "TOKEN".into(),
                dynamic_bridge: false,
            },
            profile: Some(profile),
            environment: HashMap::new(),
            idempotency: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(1)),
            shutdown,
        });
        Router::new()
            .route("/health/live", get(live))
            .route("/v1/runs", post(submit))
            .with_state(app)
    }

    #[tokio::test]
    async fn health_live_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let app = test_app(tmp.path(), std::path::Path::new("/bin/echo"));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_missing_bearer() {
        let tmp = tempfile::tempdir().unwrap();
        let app = test_app(tmp.path(), std::path::Path::new("/bin/echo"));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/runs")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}
