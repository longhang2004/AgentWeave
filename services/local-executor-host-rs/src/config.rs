use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const HOST_CONFIG_BOUNDS: Bounds = Bounds {
    args_max_count: 64,
    arg_max_length: 1024,
    env_max_entries: 64,
    env_name_max_length: 255,
    command_max_length: 4096,
    wall_time_ms_max: 24 * 60 * 60 * 1000,
    io_byte_max: 16 * 1024 * 1024,
    port_max: 65535,
};

pub struct Bounds {
    pub args_max_count: usize,
    pub arg_max_length: usize,
    pub env_max_entries: usize,
    pub env_name_max_length: usize,
    pub command_max_length: usize,
    pub wall_time_ms_max: i64,
    pub io_byte_max: i64,
    pub port_max: i64,
}

#[derive(Clone, Debug)]
pub struct HostAgentConfig {
    pub agent: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub secrets: HashMap<String, String>,
    pub wall_time_ms: u64,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub port: u16,
    pub bearer_token_env: String,
    pub connection_id: Option<String>,
    pub config_hash: Option<String>,
    pub runtime_kind: Option<String>,
    pub structured_result: bool,
    pub model_argv_prefix: Option<Vec<String>>,
    pub require_execution_workspace: bool,
}

#[derive(Clone, Debug)]
pub struct HostConfig {
    pub agents: Vec<HostAgentConfig>,
    pub allowed_root: PathBuf,
    pub state_dir: PathBuf,
    pub callback_allowed_origins: Vec<String>,
    pub callback_keys: HashMap<String, String>,
    pub callback_allow_insecure: bool,
    pub port: u16,
    pub bearer_token_env: String,
    pub dynamic_bridge: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionWorkspace {
    pub workspace_execution_id: String,
    pub path: String,
    pub mode: String,
    pub source_workspace_id: String,
    pub base_head_sha: Option<String>,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Local executor host configuration error: {}", self.0)
    }
}
impl std::error::Error for ConfigError {}

#[derive(Debug)]
pub struct ExecutionWorkspacePathError(pub String);

impl std::fmt::Display for ExecutionWorkspacePathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for ExecutionWorkspacePathError {}

pub fn parse_host_config() -> Result<HostConfig, ConfigError> {
    parse_host_config_from(&env::vars().collect())
}

pub fn parse_host_config_from(
    environment: &HashMap<String, String>,
) -> Result<HostConfig, ConfigError> {
    let configured_root = environment
        .get("EXECUTOR_HOST_ALLOWED_ROOT")
        .or_else(|| environment.get("TENVYR_WORKSPACE_ROOT"))
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().display().to_string());
    let allowed_root = real_directory(&configured_root, "EXECUTOR_HOST_ALLOWED_ROOT")?;
    let raw_state_dir = environment
        .get("EXECUTOR_HOST_STATE_DIR")
        .cloned()
        .unwrap_or_else(|| {
            std::env::temp_dir()
                .join("tenvyr-host-state")
                .display()
                .to_string()
        });
    let state_dir = PathBuf::from(&raw_state_dir);
    fs::create_dir_all(&state_dir).ok();

    let allowed_origins_env = environment
        .get("EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS")
        .cloned()
        .unwrap_or_else(|| {
            "http://127.0.0.1:3001,http://localhost:3001,http://127.0.0.1:3000,http://localhost:3000"
                .into()
        });
    let callback_keys = parse_callback_keys(environment)?;
    let callback_allow_insecure = environment.get("EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE")
        == Some(&"true".to_string());
    let port = parse_port(environment.get("EXECUTOR_HOST_PORT").map(|s| s.as_str()).unwrap_or("3002"))?;
    let bearer_token_env = environment
        .get("EXECUTOR_HOST_BEARER_TOKEN_ENV")
        .cloned()
        .unwrap_or_else(|| "EXECUTOR_HOST_BEARER_TOKEN".into());

    let raw = environment.get("EXECUTOR_HOST_AGENTS").map(|s| s.trim());
    if raw.is_none() || raw == Some("") {
        if environment.get(&bearer_token_env).map(|s| s.as_str()).unwrap_or("").is_empty()
            && environment
                .get("HTTP_AGENT_BEARER_TOKEN")
                .map(|s| s.as_str())
                .unwrap_or("")
                .is_empty()
        {
            return Err(ConfigError(format!(
                "Bearer token environment value is missing ({bearer_token_env} or HTTP_AGENT_BEARER_TOKEN)"
            )));
        }
        if callback_keys.is_empty() {
            return Err(ConfigError(
                "Callback authentication keys are required (EXECUTOR_HOST_CALLBACK_KEYS or HTTP_AGENT_CALLBACK_SECRET)"
                    .into(),
            ));
        }
        return Ok(HostConfig {
            agents: vec![],
            allowed_root,
            state_dir,
            callback_allowed_origins: split_origins(&allowed_origins_env),
            callback_keys,
            callback_allow_insecure,
            port,
            bearer_token_env,
            dynamic_bridge: true,
        });
    }

    let value: Value = serde_json::from_str(raw.unwrap())
        .map_err(|_| ConfigError("EXECUTOR_HOST_AGENTS must be valid JSON".into()))?;
    let object = value
        .as_object()
        .ok_or_else(|| ConfigError("EXECUTOR_HOST_AGENTS must be an object".into()))?;
    let mut agents = Vec::new();
    for (agent, entry) in object {
        if agent.is_empty() || agent.len() > 255 {
            return Err(ConfigError(
                "Every EXECUTOR_HOST_AGENTS key must be a non-empty agent name of at most 255 characters"
                    .into(),
            ));
        }
        if !agent
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            return Err(ConfigError(format!(
                "Agent name \"{agent}\" contains characters outside [A-Za-z0-9_.-]"
            )));
        }
        agents.push(parse_agent_config(
            agent,
            entry,
            environment,
            &allowed_root,
            &callback_keys,
        )?);
    }
    if agents.is_empty() {
        return Err(ConfigError(
            "EXECUTOR_HOST_AGENTS must configure at least one agent".into(),
        ));
    }
    let mut ports: Vec<u16> = agents.iter().map(|a| a.port).collect();
    ports.sort();
    ports.dedup();
    if ports.len() != agents.len() {
        return Err(ConfigError(
            "Every EXECUTOR_HOST_AGENTS entry must use a distinct port".into(),
        ));
    }
    Ok(HostConfig {
        agents,
        allowed_root,
        state_dir,
        callback_allowed_origins: split_origins(&allowed_origins_env),
        callback_keys,
        callback_allow_insecure,
        port,
        bearer_token_env,
        dynamic_bridge: false,
    })
}

fn parse_agent_config(
    agent: &str,
    entry: &Value,
    environment: &HashMap<String, String>,
    allowed_root: &Path,
    callback_keys: &HashMap<String, String>,
) -> Result<HostAgentConfig, ConfigError> {
    let value = entry
        .as_object()
        .ok_or_else(|| ConfigError(format!("Agent \"{agent}\" configuration must be an object")))?;
    let command = bounded_string(
        value.get("command"),
        &format!("Agent \"{agent}\" command"),
        HOST_CONFIG_BOUNDS.command_max_length,
    )?;
    let command_path = PathBuf::from(&command);
    if !command_path.is_absolute() {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" command must be an absolute path (never pipeline-supplied)"
        )));
    }
    if !command_path.exists() {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" command does not exist: {command}"
        )));
    }
    let args = parse_args(agent, value.get("args"))?;
    let cwd = parse_cwd(agent, value.get("cwd"), allowed_root)?;
    let env_map = parse_env_map(agent, value.get("env"), "env allowlist")?;
    let secrets = parse_env_map(agent, value.get("secrets"), "secret references")?;
    let wall_time_ms = bounded_positive_integer(
        value.get("wallTimeMs"),
        &format!("Agent \"{agent}\" wallTimeMs"),
        HOST_CONFIG_BOUNDS.wall_time_ms_max,
    )? as u64;
    let max_stdout_bytes = bounded_positive_integer(
        value.get("maxStdoutBytes"),
        &format!("Agent \"{agent}\" maxStdoutBytes"),
        HOST_CONFIG_BOUNDS.io_byte_max,
    )? as usize;
    let max_stderr_bytes = bounded_positive_integer(
        value.get("maxStderrBytes"),
        &format!("Agent \"{agent}\" maxStderrBytes"),
        HOST_CONFIG_BOUNDS.io_byte_max,
    )? as usize;
    let port = bounded_positive_integer(
        value.get("port"),
        &format!("Agent \"{agent}\" port"),
        HOST_CONFIG_BOUNDS.port_max,
    )? as u16;
    let bearer_token_env = bounded_string(
        value.get("bearerTokenEnv"),
        &format!("Agent \"{agent}\" bearerTokenEnv"),
        HOST_CONFIG_BOUNDS.env_name_max_length,
    )?;
    if environment
        .get(&bearer_token_env)
        .map(|s| s.as_str())
        .unwrap_or("")
        .is_empty()
    {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" bearer token environment value is missing"
        )));
    }
    for secret_env_name in secrets.values() {
        if environment
            .get(secret_env_name)
            .map(|s| s.as_str())
            .unwrap_or("")
            .is_empty()
        {
            return Err(ConfigError(format!(
                "Agent \"{agent}\" secret reference environment value is missing: {secret_env_name}"
            )));
        }
    }
    if callback_keys.is_empty() {
        return Err(ConfigError(
            "EXECUTOR_HOST_CALLBACK_KEYS must contain at least one key".into(),
        ));
    }
    let connection_id = optional_bounded_string(
        value.get("connectionId"),
        &format!("Agent \"{agent}\" connectionId"),
    )?;
    let config_hash = optional_bounded_string(
        value.get("configHash"),
        &format!("Agent \"{agent}\" configHash"),
    )?;
    if connection_id.is_some() != config_hash.is_some() {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" must declare connectionId and configHash together (M8-S6 binding)"
        )));
    }
    let structured_result = match value.get("structuredResult") {
        None => false,
        Some(Value::Bool(v)) => *v,
        Some(_) => {
            return Err(ConfigError(format!(
                "Agent \"{agent}\" structuredResult must be a boolean"
            )))
        }
    };
    let require_execution_workspace = match value.get("requireExecutionWorkspace") {
        None => false,
        Some(Value::Bool(v)) => *v,
        Some(_) => {
            return Err(ConfigError(format!(
                "Agent \"{agent}\" requireExecutionWorkspace must be a boolean"
            )))
        }
    };
    let model_argv_prefix = if value.contains_key("modelArgvPrefix") {
        Some(parse_args(agent, value.get("modelArgvPrefix"))?)
    } else {
        None
    };
    Ok(HostAgentConfig {
        agent: agent.to_string(),
        command: command_path,
        args,
        cwd,
        env: env_map,
        secrets,
        wall_time_ms,
        max_stdout_bytes,
        max_stderr_bytes,
        port,
        bearer_token_env,
        connection_id,
        config_hash,
        runtime_kind: value
            .get("runtimeKind")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        structured_result,
        model_argv_prefix,
        require_execution_workspace,
    })
}

pub fn execution_workspace_from_invocation(
    invocation: &Value,
) -> Result<Option<ExecutionWorkspace>, ConfigError> {
    let Some(metadata) = invocation.get("metadata") else {
        return Ok(None);
    };
    if metadata.is_null() {
        return Ok(None);
    }
    let object = metadata
        .as_object()
        .ok_or_else(|| ConfigError("invocation metadata must be an object".into()))?;
    let Some(tenvyr) = object.get("tenvyr") else {
        return Ok(None);
    };
    let tenvyr = tenvyr
        .as_object()
        .ok_or_else(|| ConfigError("invocation metadata.tenvyr must be an object".into()))?;
    parse_execution_workspace_member(tenvyr.get("executionWorkspace"))
}

fn parse_execution_workspace_member(
    value: Option<&Value>,
) -> Result<Option<ExecutionWorkspace>, ConfigError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let source = value
        .as_object()
        .ok_or_else(|| ConfigError("metadata.tenvyr.executionWorkspace must be an object".into()))?;
    let allowed = [
        "schemaVersion",
        "workspaceExecutionId",
        "path",
        "mode",
        "sourceWorkspaceId",
        "baseHeadSha",
    ];
    if let Some(unknown) = source.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(ConfigError(format!(
            "executionWorkspace contains an unsupported field \"{unknown}\""
        )));
    }
    if source.get("schemaVersion") != Some(&Value::from(1)) {
        return Err(ConfigError(format!(
            "executionWorkspace schemaVersion \"{}\" is not supported",
            source
                .get("schemaVersion")
                .map(ToString::to_string)
                .unwrap_or_default()
        )));
    }
    let workspace_execution_id = bounded_string(
        source.get("workspaceExecutionId"),
        "executionWorkspace.workspaceExecutionId",
        255,
    )?;
    let member_path = bounded_string(source.get("path"), "executionWorkspace.path", 4096)?;
    let mode = source
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if mode != "shared" && mode != "git-worktree" {
        return Err(ConfigError(format!(
            "executionWorkspace mode \"{mode}\" is not supported"
        )));
    }
    let source_workspace_id = bounded_string(
        source.get("sourceWorkspaceId"),
        "executionWorkspace.sourceWorkspaceId",
        255,
    )?;
    let mut base_head_sha = None;
    if let Some(sha) = source.get("baseHeadSha") {
        if !sha.is_null() {
            let value = bounded_string(Some(sha), "executionWorkspace.baseHeadSha", 40)?;
            if value.len() != 40 || !value.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
                return Err(ConfigError(
                    "executionWorkspace.baseHeadSha must be 40 lowercase hex characters or null"
                        .into(),
                ));
            }
            base_head_sha = Some(value);
        }
    }
    Ok(Some(ExecutionWorkspace {
        workspace_execution_id,
        path: member_path,
        mode: mode.into(),
        source_workspace_id,
        base_head_sha,
    }))
}

pub fn resolve_execution_cwd(
    profile: &HostAgentConfig,
    invocation: &Value,
    allowed_root: &Path,
    authorized_roots: &[PathBuf],
) -> Result<PathBuf, ExecutionWorkspacePathError> {
    let member = execution_workspace_from_invocation(invocation).map_err(|e| {
        ExecutionWorkspacePathError(e.0)
    })?;
    let label = format!(
        "Invocation {}",
        invocation
            .get("invocationId")
            .and_then(|v| v.as_str())
            .unwrap_or("<unknown>")
    );
    let Some(member) = member else {
        if profile.require_execution_workspace {
            return Err(ExecutionWorkspacePathError(format!(
                "{label} carries no Tenvyr execution workspace but agent \"{}\" requires one — refusing to run (fail closed)",
                profile.agent
            )));
        }
        return Ok(profile.cwd.clone());
    };
    let path = PathBuf::from(&member.path);
    if !path.is_absolute() {
        return Err(ExecutionWorkspacePathError(format!(
            "{label} execution workspace path \"{}\" is not absolute — refusing to run (fail closed)",
            member.path
        )));
    }
    let Some(real) = real_directory_or_none(&path) else {
        return Err(ExecutionWorkspacePathError(format!(
            "{label} execution workspace path \"{}\" does not resolve to an existing directory — refusing to run (fail closed)",
            path.display()
        )));
    };
    let mut roots = vec![allowed_root.to_path_buf()];
    roots.extend(authorized_roots.iter().cloned());
    let authorized = roots.iter().any(|candidate| {
        let canonical = real_directory_or_none(candidate).unwrap_or_else(|| candidate.clone());
        real == canonical || real.starts_with(&canonical)
    });
    if !authorized {
        let canonical_root =
            real_directory_or_none(allowed_root).unwrap_or_else(|| allowed_root.to_path_buf());
        return Err(ExecutionWorkspacePathError(format!(
            "{label} execution workspace path \"{}\" resolves outside the allowlisted root \"{}\" — refusing to run (fail closed)",
            real.display(),
            canonical_root.display()
        )));
    }
    Ok(real)
}

pub fn resolved_environment(
    profile: &HostAgentConfig,
    environment: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (child, host) in &profile.env {
        out.insert(
            child.clone(),
            environment.get(host).cloned().unwrap_or_default(),
        );
    }
    for (child, host) in &profile.secrets {
        out.insert(
            child.clone(),
            environment.get(host).cloned().unwrap_or_default(),
        );
    }
    out
}

fn parse_callback_keys(
    environment: &HashMap<String, String>,
) -> Result<HashMap<String, String>, ConfigError> {
    if let Some(raw) = environment.get("EXECUTOR_HOST_CALLBACK_KEYS") {
        let value: Value = serde_json::from_str(raw)
            .map_err(|_| ConfigError("EXECUTOR_HOST_CALLBACK_KEYS must be valid JSON".into()))?;
        let object = value
            .as_object()
            .ok_or_else(|| ConfigError("EXECUTOR_HOST_CALLBACK_KEYS must be an object".into()))?;
        let mut result = HashMap::new();
        for (key_id, secret) in object {
            if key_id.is_empty() || key_id.len() > 255 {
                return Err(ConfigError(
                    "EXECUTOR_HOST_CALLBACK_KEYS key IDs must be 1-255 characters".into(),
                ));
            }
            let secret = secret.as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
                ConfigError(format!(
                    "EXECUTOR_HOST_CALLBACK_KEYS secret for \"{key_id}\" must be a non-empty string"
                ))
            })?;
            result.insert(key_id.clone(), secret.to_string());
        }
        return Ok(result);
    }
    let secret = environment
        .get("HTTP_AGENT_CALLBACK_SECRET")
        .or_else(|| environment.get("LOOPBACK_CALLBACK_SECRET"));
    Ok(match secret {
        Some(secret) if !secret.is_empty() => HashMap::from([
            ("host-callback-v1".into(), secret.clone()),
            ("host-loopback-v1".into(), secret.clone()),
        ]),
        _ => HashMap::new(),
    })
}

fn parse_args(agent: &str, value: Option<&Value>) -> Result<Vec<String>, ConfigError> {
    let Some(value) = value else {
        return Ok(vec![]);
    };
    let array = value.as_array().ok_or_else(|| {
        ConfigError(format!(
            "Agent \"{agent}\" args must be an array of at most {} strings",
            HOST_CONFIG_BOUNDS.args_max_count
        ))
    })?;
    if array.len() > HOST_CONFIG_BOUNDS.args_max_count {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" args must be an array of at most {} strings",
            HOST_CONFIG_BOUNDS.args_max_count
        )));
    }
    array
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            bounded_string(
                Some(arg),
                &format!("Agent \"{agent}\" args[{index}]"),
                HOST_CONFIG_BOUNDS.arg_max_length,
            )
        })
        .collect()
}

fn parse_cwd(agent: &str, value: Option<&Value>, allowed_root: &Path) -> Result<PathBuf, ConfigError> {
    let raw = bounded_string(
        value,
        &format!("Agent \"{agent}\" cwd"),
        HOST_CONFIG_BOUNDS.command_max_length,
    )?;
    let path = PathBuf::from(&raw);
    let resolved = if path.is_absolute() {
        path
    } else {
        allowed_root.join(path)
    };
    let real = real_directory(
        &resolved.display().to_string(),
        &format!("Agent \"{agent}\" cwd"),
    )?;
    if real != allowed_root && !real.starts_with(allowed_root) {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" cwd resolves outside the allowlisted root: {}",
            real.display()
        )));
    }
    Ok(real)
}

fn parse_env_map(
    agent: &str,
    value: Option<&Value>,
    what: &str,
) -> Result<HashMap<String, String>, ConfigError> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| ConfigError(format!("Agent \"{agent}\" {what} must be an object")))?;
    if object.len() > HOST_CONFIG_BOUNDS.env_max_entries {
        return Err(ConfigError(format!(
            "Agent \"{agent}\" {what} exceeds {} entries",
            HOST_CONFIG_BOUNDS.env_max_entries
        )));
    }
    let mut result = HashMap::new();
    for (name, env_name) in object {
        if name.is_empty()
            || name.len() > HOST_CONFIG_BOUNDS.env_name_max_length
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Err(ConfigError(format!(
                "Agent \"{agent}\" {what} contains an invalid child variable name: \"{name}\""
            )));
        }
        result.insert(
            name.clone(),
            bounded_string(
                Some(env_name),
                &format!("Agent \"{agent}\" {what} value for \"{name}\""),
                HOST_CONFIG_BOUNDS.env_name_max_length,
            )?,
        );
    }
    Ok(result)
}

fn real_directory(value: &str, field: &str) -> Result<PathBuf, ConfigError> {
    real_directory_or_none(Path::new(value))
        .ok_or_else(|| ConfigError(format!("{field} must be an existing directory")))
}

fn real_directory_or_none(value: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(value).ok()?;
    if real.is_dir() {
        Some(real)
    } else {
        None
    }
}

fn bounded_string(value: Option<&Value>, field: &str, max_length: usize) -> Result<String, ConfigError> {
    let Some(Value::String(text)) = value else {
        return Err(ConfigError(format!(
            "{field} must be a non-empty string of at most {max_length} characters"
        )));
    };
    if text.trim().is_empty() || text.len() > max_length {
        return Err(ConfigError(format!(
            "{field} must be a non-empty string of at most {max_length} characters"
        )));
    }
    Ok(text.clone())
}

fn optional_bounded_string(
    value: Option<&Value>,
    field: &str,
) -> Result<Option<String>, ConfigError> {
    match value {
        None => Ok(None),
        Some(_) => Ok(Some(bounded_string(
            value,
            field,
            HOST_CONFIG_BOUNDS.command_max_length,
        )?)),
    }
}

fn bounded_positive_integer(value: Option<&Value>, field: &str, max: i64) -> Result<i64, ConfigError> {
    let number = value.and_then(|v| v.as_i64()).filter(|n| *n > 0 && *n <= max);
    number.ok_or_else(|| ConfigError(format!("{field} must be an integer between 1 and {max}")))
}

fn parse_port(raw: &str) -> Result<u16, ConfigError> {
    raw.parse::<u16>()
        .map_err(|_| ConfigError("EXECUTOR_HOST_PORT must be a valid port".into()))
        .and_then(|port| {
            if port == 0 {
                Err(ConfigError("EXECUTOR_HOST_PORT must be a valid port".into()))
            } else {
                Ok(port)
            }
        })
}

fn split_origins(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rejects_cwd_outside_allowlisted_root() {
        let root = tempdir().unwrap();
        let env = base_env(root.path(), "cwd", "/etc");
        let err = parse_host_config_from(&env).unwrap_err();
        assert!(err.0.contains("outside the allowlisted root"), "{}", err.0);
    }

    #[test]
    fn parses_a_valid_agent() {
        let root = tempdir().unwrap();
        let env = base_env(root.path(), "cwd", &root.path().display().to_string());
        let config = parse_host_config_from(&env).unwrap();
        assert_eq!(config.agents.len(), 1);
        assert_eq!(config.agents[0].agent, "echo");
        assert_eq!(config.agents[0].port, 4101);
    }

    fn base_env(root: &Path, cwd_key: &str, cwd: &str) -> HashMap<String, String> {
        let command = std::env::current_exe()
            .ok()
            .filter(|p| p.exists())
            .unwrap_or_else(|| PathBuf::from("/bin/echo"));
        let agents = serde_json::json!({
            "echo": {
                "command": command,
                "args": ["ok"],
                cwd_key: cwd,
                "wallTimeMs": 30_000,
                "maxStdoutBytes": 65_536,
                "maxStderrBytes": 65_536,
                "port": 4101,
                "bearerTokenEnv": "HOST_TOKEN_1"
            }
        });
        HashMap::from([
            (
                "EXECUTOR_HOST_ALLOWED_ROOT".into(),
                root.display().to_string(),
            ),
            (
                "EXECUTOR_HOST_STATE_DIR".into(),
                root.join("state").display().to_string(),
            ),
            (
                "EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS".into(),
                "https://orchestrator.example".into(),
            ),
            (
                "EXECUTOR_HOST_CALLBACK_KEYS".into(),
                r#"{"host-v1":"callback-secret"}"#.into(),
            ),
            ("EXECUTOR_HOST_AGENTS".into(), agents.to_string()),
            ("HOST_TOKEN_1".into(), "host-token".into()),
        ])
    }

    #[test]
    fn workspace_member_must_be_inside_root() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path()).unwrap();
        let profile = HostAgentConfig {
            agent: "echo".into(),
            command: PathBuf::from("/bin/echo"),
            args: vec![],
            cwd: root.path().to_path_buf(),
            env: HashMap::new(),
            secrets: HashMap::new(),
            wall_time_ms: 1000,
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
            port: 1,
            bearer_token_env: "X".into(),
            connection_id: None,
            config_hash: None,
            runtime_kind: None,
            structured_result: false,
            model_argv_prefix: None,
            require_execution_workspace: false,
        };
        let invocation = serde_json::json!({
            "invocationId": "inv-1",
            "metadata": {
                "tenvyr": {
                    "executionWorkspace": {
                        "schemaVersion": 1,
                        "workspaceExecutionId": "ws-1",
                        "path": "/etc",
                        "mode": "shared",
                        "sourceWorkspaceId": "src-1",
                        "baseHeadSha": null
                    }
                }
            }
        });
        let err = resolve_execution_cwd(&profile, &invocation, root.path(), &[]).unwrap_err();
        assert!(err.0.contains("outside the allowlisted root"), "{}", err.0);
    }
}
