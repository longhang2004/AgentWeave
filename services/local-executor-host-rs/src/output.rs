use crate::config::HostAgentConfig;
use crate::supervisor::ProcessOutcome;
use serde_json::Value;

pub enum NativeOutput {
    Success { output: Value },
    Failure {
        code: &'static str,
        message: String,
        retryable: bool,
    },
}

pub fn adapt_native_runtime_output(
    outcome: &ProcessOutcome,
    profile: &HostAgentConfig,
) -> NativeOutput {
    match outcome {
        ProcessOutcome::Failed { exit_code, stderr, .. } => NativeOutput::Failure {
            code: "EXECUTOR_HOST_PROCESS_FAILED",
            message: {
                let tail = bounded_tail(stderr, 1024);
                if tail.is_empty() {
                    format!("Process exited with code {exit_code}")
                } else {
                    tail
                }
            },
            retryable: false,
        },
        ProcessOutcome::SpawnFailed { message } => NativeOutput::Failure {
            code: "EXECUTOR_HOST_SPAWN_FAILED",
            message: message.clone(),
            retryable: false,
        },
        ProcessOutcome::Killed {
            trigger,
            final_signal,
            ..
        } => NativeOutput::Failure {
            code: if *trigger == crate::supervisor::KillTrigger::Shutdown {
                "EXECUTOR_HOST_SHUTDOWN"
            } else {
                "EXECUTOR_HOST_DEADLINE"
            },
            message: format!("Process group {final_signal} after {}", trigger.as_str()),
            retryable: true,
        },
        ProcessOutcome::OutputLimit { stream, .. } => NativeOutput::Failure {
            code: "EXECUTOR_HOST_OUTPUT_LIMIT",
            message: format!(
                "{stream} exceeded the configured byte bound for agent \"{}\"",
                profile.agent
            ),
            retryable: false,
        },
        ProcessOutcome::Succeeded { exit_code, stdout, .. } => {
            if !profile.structured_result {
                return NativeOutput::Success {
                    output: serde_json::json!({ "exitCode": exit_code, "stdout": stdout }),
                };
            }
            adapt_structured(stdout.trim(), profile)
        }
    }
}

fn adapt_structured(stdout: &str, profile: &HostAgentConfig) -> NativeOutput {
    if stdout.is_empty() {
        return NativeOutput::Failure {
            code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
            message: format!(
                "Runtime \"{}\" exited 0 but produced empty stdout",
                profile.agent
            ),
            retryable: false,
        };
    }
    match profile.runtime_kind.as_deref().unwrap_or("generic-cli") {
        "codex" => adapt_codex(stdout, &profile.agent),
        "opencode" => adapt_opencode(stdout, &profile.agent),
        "claude" => adapt_claude(stdout, &profile.agent),
        _ => match serde_json::from_str::<Value>(stdout) {
            Ok(parsed) => NativeOutput::Success { output: parsed },
            Err(error) => NativeOutput::Failure {
                code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
                message: format!(
                    "Structured result from \"{}\" is not valid JSON: {error}",
                    profile.agent
                ),
                retryable: false,
            },
        },
    }
}

fn adapt_codex(stdout: &str, agent: &str) -> NativeOutput {
    adapt_jsonl(stdout, agent, "Codex", |event, last, single| {
        if event.get("type").and_then(|v| v.as_str()) == Some("item.completed") {
            if let Some(item) = event.get("item") {
                if item.get("type").and_then(|v| v.as_str()) == Some("agent_message") {
                    if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                        *last = Some(text.to_string());
                    }
                }
            }
        }
        if event.get("type").is_none() && event.get("item").is_none() {
            *single = Some(event.clone());
        }
    })
}

fn adapt_opencode(stdout: &str, agent: &str) -> NativeOutput {
    adapt_jsonl(stdout, agent, "OpenCode", |event, last, single| {
        if event.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(part) = event.get("part") {
                if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        *last = Some(text.to_string());
                    }
                }
            }
        }
        if event.get("type").is_none() && event.get("part").is_none() {
            *single = Some(event.clone());
        }
    })
}

fn adapt_jsonl(
    stdout: &str,
    agent: &str,
    kind: &str,
    inspect: impl Fn(&Value, &mut Option<String>, &mut Option<Value>),
) -> NativeOutput {
    let lines: Vec<&str> = stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut last = None;
    let mut single = None;
    for (index, line) in lines.iter().enumerate() {
        let event: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                return NativeOutput::Failure {
                    code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
                    message: format!(
                        "{kind} stream line {} from \"{agent}\" is not valid JSON: {}",
                        index + 1,
                        line.chars().take(100).collect::<String>()
                    ),
                    retryable: false,
                };
            }
        };
        inspect(&event, &mut last, &mut single);
    }
    if lines.len() == 1 {
        if let Some(single) = single {
            return NativeOutput::Success { output: single };
        }
    }
    match last {
        Some(text) => parse_final_payload(&text),
        None => NativeOutput::Failure {
            code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
            message: format!("{kind} stream from \"{agent}\" did not emit a completed text event"),
            retryable: false,
        },
    }
}

fn adapt_claude(stdout: &str, agent: &str) -> NativeOutput {
    let parsed: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(error) => {
            return NativeOutput::Failure {
                code: "EXECUTOR_HOST_INVALID_STRUCTURED_RESULT",
                message: format!("Claude output from \"{agent}\" is not valid JSON: {error}"),
                retryable: false,
            };
        }
    };
    if let Some(object) = parsed.as_object() {
        if let Some(text) = object.get("result").and_then(|v| v.as_str()) {
            return parse_final_payload(text);
        }
        if object.get("result").map(|v| v.is_object()).unwrap_or(false) {
            return NativeOutput::Success {
                output: object["result"].clone(),
            };
        }
        if let Some(text) = object.get("output").and_then(|v| v.as_str()) {
            return parse_final_payload(text);
        }
    }
    NativeOutput::Success { output: parsed }
}

fn parse_final_payload(text: &str) -> NativeOutput {
    let trimmed = text.trim();
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return NativeOutput::Success { output: parsed };
    }
    if let Some(start) = trimmed.find("```") {
        let rest = &trimmed[start + 3..];
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        if let Some(end) = rest.find("```") {
            if let Ok(parsed) = serde_json::from_str::<Value>(rest[..end].trim()) {
                return NativeOutput::Success { output: parsed };
            }
        }
    }
    NativeOutput::Success {
        output: serde_json::json!({ "text": trimmed }),
    }
}

fn bounded_tail(value: &str, max_length: usize) -> String {
    if value.len() <= max_length {
        value.to_string()
    } else {
        format!("...{}", &value[value.len() - max_length..])
    }
}
