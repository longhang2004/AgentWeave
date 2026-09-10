use crate::config::HostAgentConfig;
use crate::protocol::model_id_ok;
use serde_json::Value;

pub fn validate_invocation_binding(profile: &HostAgentConfig, invocation: &Value) -> Option<String> {
    let invocation_id = invocation
        .get("invocationId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let carried = invocation.get("connection");
    match (&profile.connection_id, &profile.config_hash, carried) {
        (Some(connection_id), Some(_config_hash), None) => Some(format!(
            "Invocation {invocation_id} carries no connection reference but agent \"{}\" is bound to connection \"{connection_id}\" — refusing to run (fail closed)",
            profile.agent
        )),
        (Some(connection_id), Some(config_hash), Some(carried)) => {
            let id = carried.get("connectionId").and_then(|v| v.as_str());
            let hash = carried.get("configHash").and_then(|v| v.as_str());
            if id != Some(connection_id.as_str()) {
                return Some(format!(
                    "Invocation {invocation_id} selects connection \"{}\" but agent \"{}\" is bound to \"{connection_id}\" — refusing to run (fail closed)",
                    id.unwrap_or(""),
                    profile.agent
                ));
            }
            if hash != Some(config_hash.as_str()) {
                return Some(format!(
                    "Invocation {invocation_id} selects connection revision hash \"{}\" but agent \"{}\" is configured for hash \"{config_hash}\" — refusing to run (fail closed)",
                    hash.unwrap_or(""),
                    profile.agent
                ));
            }
            None
        }
        (None, None, Some(carried)) => Some(format!(
            "Invocation {invocation_id} carries connection \"{}\" but agent \"{}\" declares no connection binding — refusing to run (fail closed)",
            carried.get("connectionId").and_then(|v| v.as_str()).unwrap_or(""),
            profile.agent
        )),
        _ => None,
    }
    .or_else(|| validate_model(profile, invocation, invocation_id))
}

fn validate_model(
    profile: &HostAgentConfig,
    invocation: &Value,
    invocation_id: &str,
) -> Option<String> {
    let Some(model) = invocation.get("requestedModelId") else {
        return None;
    };
    if profile
        .model_argv_prefix
        .as_ref()
        .map(|p| p.is_empty())
        .unwrap_or(true)
    {
        return Some(format!(
            "Invocation {invocation_id} requests model \"{model}\" but agent \"{}\" declares no modelArgvPrefix — refusing to run (fail closed)",
            profile.agent
        ));
    }
    match model.as_str() {
        Some(id) if model_id_ok(id) => None,
        _ => Some(format!(
            "Invocation {invocation_id} requests an invalid model id — refusing to run (fail closed)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn profile() -> HostAgentConfig {
        HostAgentConfig {
            agent: "echo".into(),
            command: PathBuf::from("/bin/echo"),
            args: vec![],
            cwd: PathBuf::from("/tmp"),
            env: HashMap::new(),
            secrets: HashMap::new(),
            wall_time_ms: 1000,
            max_stdout_bytes: 1024,
            max_stderr_bytes: 1024,
            port: 1,
            bearer_token_env: "X".into(),
            connection_id: Some("conn-1".into()),
            config_hash: Some("hash-1".into()),
            runtime_kind: None,
            structured_result: false,
            model_argv_prefix: None,
            require_execution_workspace: false,
        }
    }

    #[test]
    fn refuses_missing_connection_when_bound() {
        let invocation = serde_json::json!({"invocationId": "inv-1"});
        let error = validate_invocation_binding(&profile(), &invocation).unwrap();
        assert!(error.contains("carries no connection reference"));
    }

    #[test]
    fn accepts_matching_connection() {
        let invocation = serde_json::json!({
            "invocationId": "inv-1",
            "connection": {
                "connectionId": "conn-1",
                "revisionNumber": 1,
                "configHash": "hash-1"
            }
        });
        assert_eq!(validate_invocation_binding(&profile(), &invocation), None);
    }
}
