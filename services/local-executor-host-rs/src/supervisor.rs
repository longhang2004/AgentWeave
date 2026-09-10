use crate::config::HostAgentConfig;
use std::collections::HashMap;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::sleep;

pub const ESCALATION_GRACE_MS: u64 = 5_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KillTrigger {
    WallTime,
    InvocationDeadline,
    Shutdown,
}

impl KillTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WallTime => "wall_time",
            Self::InvocationDeadline => "invocation_deadline",
            Self::Shutdown => "shutdown",
        }
    }
}

#[derive(Debug)]
pub enum ProcessOutcome {
    Succeeded {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    Failed {
        exit_code: i32,
        stdout: String,
        stderr: String,
    },
    SpawnFailed {
        message: String,
    },
    Killed {
        trigger: KillTrigger,
        final_signal: &'static str,
        stdout: String,
        stderr: String,
    },
    OutputLimit {
        stream: &'static str,
        stdout: String,
        stderr: String,
    },
}

pub fn compose_argv(profile: &HostAgentConfig, requested_model_id: Option<&str>) -> Vec<String> {
    match (requested_model_id, profile.model_argv_prefix.as_ref()) {
        (Some(model), Some(prefix)) if !prefix.is_empty() => {
            let mut argv = profile.args.clone();
            argv.extend(prefix.iter().cloned());
            argv.push(model.to_string());
            argv
        }
        _ => profile.args.clone(),
    }
}

pub async fn supervise_process(
    profile: &HostAgentConfig,
    env: &HashMap<String, String>,
    input: &serde_json::Value,
    requested_model_id: Option<&str>,
    cwd: &std::path::Path,
    mut shutdown: watch::Receiver<bool>,
    invocation_deadline_at: Option<&str>,
    on_spawn: impl FnOnce(u32),
    escalation_grace: Duration,
) -> ProcessOutcome {
    let argv = compose_argv(profile, requested_model_id);
    let mut command = Command::new(&profile.command);
    command
        .args(&argv)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // ponytail: no_new_privs is the Linux sandbox floor. Landlock/seccomp
            // + cgroup memory are the upgrade path once this host is default and
            // Linux CI can exercise it.
            #[cfg(target_os = "linux")]
            {
                libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
            }
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProcessOutcome::SpawnFailed {
                message: error.to_string(),
            };
        }
    };
    let pid = child.id().unwrap_or(0);
    if pid != 0 {
        on_spawn(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let payload = serde_json::to_vec(input).unwrap_or_else(|_| b"null".to_vec());
        let _ = stdin.write_all(&payload).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_limit = profile.max_stdout_bytes;
    let stderr_limit = profile.max_stderr_bytes;
    let (limit_tx, mut limit_rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
    let stdout_tx = limit_tx.clone();
    let stdout_task = tokio::spawn(async move {
        let result = read_bounded(stdout.take(), stdout_limit).await;
        if result.1 {
            let _ = stdout_tx.send("stdout");
        }
        result
    });
    let stderr_task = tokio::spawn(async move {
        let result = read_bounded(stderr.take(), stderr_limit).await;
        if result.1 {
            let _ = limit_tx.send("stderr");
        }
        result
    });

    let (kill_at, mut trigger) = kill_deadline(profile.wall_time_ms, invocation_deadline_at);
    let mut escalated = false;
    let mut limit_hit = None;
    if *shutdown.borrow() {
        trigger = KillTrigger::Shutdown;
        begin_escalate(pid, escalation_grace);
        escalated = true;
    }

    loop {
        let wait_for_kill = kill_at.saturating_duration_since(Instant::now());
        tokio::select! {
            status = child.wait() => {
                let (stdout, stdout_over) = stdout_task.await.unwrap_or_else(|_| (Vec::new(), false));
                let (stderr, stderr_over) = stderr_task.await.unwrap_or_else(|_| (Vec::new(), false));
                if pid != 0 {
                    kill_group(pid, libc::SIGKILL);
                }
                let stream = limit_hit.or_else(|| {
                    if stdout_over {
                        Some("stdout")
                    } else if stderr_over {
                        Some("stderr")
                    } else {
                        None
                    }
                });
                if let Some(stream) = stream {
                    return limit(stream, stdout, stderr);
                }
                return settle(status, trigger, stdout, stderr);
            }
            _ = sleep(wait_for_kill), if !escalated => {
                if Instant::now() < kill_at && !*shutdown.borrow() {
                    continue;
                }
                if *shutdown.borrow() {
                    trigger = KillTrigger::Shutdown;
                }
                escalated = true;
                begin_escalate(pid, escalation_grace);
            }
            Some(stream) = limit_rx.recv(), if limit_hit.is_none() => {
                limit_hit = Some(stream);
                kill_group(pid, libc::SIGKILL);
            }
            Ok(()) = shutdown.changed() => {
                if *shutdown.borrow() && !escalated {
                    trigger = KillTrigger::Shutdown;
                    escalated = true;
                    begin_escalate(pid, escalation_grace);
                }
            }
        }
    }
}

async fn read_bounded<R: AsyncReadExt + Unpin>(
    mut stream: Option<R>,
    limit: usize,
) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let Some(stream) = stream.as_mut() else {
        return (buf, false);
    };
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) => return (buf, false),
            Ok(n) => {
                if buf.len() + n > limit {
                    let take = limit.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..take.min(n)]);
                    return (buf, true);
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => return (buf, false),
        }
    }
}

fn kill_deadline(wall_time_ms: u64, invocation_deadline_at: Option<&str>) -> (Instant, KillTrigger) {
    let wall = Instant::now() + Duration::from_millis(wall_time_ms);
    if let Some(raw) = invocation_deadline_at {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
            let now = chrono::Utc::now().timestamp_millis();
            let target = parsed.with_timezone(&chrono::Utc).timestamp_millis();
            let inv = Instant::now() + Duration::from_millis(target.saturating_sub(now).max(0) as u64);
            if inv <= wall {
                return (inv, KillTrigger::InvocationDeadline);
            }
        }
    }
    (wall, KillTrigger::WallTime)
}

fn begin_escalate(pid: u32, grace: Duration) {
    if pid == 0 {
        return;
    }
    kill_group(pid, libc::SIGTERM);
    tokio::spawn(async move {
        sleep(grace).await;
        kill_group(pid, libc::SIGKILL);
    });
}

fn settle(
    status: Result<std::process::ExitStatus, std::io::Error>,
    trigger: KillTrigger,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> ProcessOutcome {
    match status {
        Ok(status) if status.success() => ProcessOutcome::Succeeded {
            exit_code: 0,
            stdout: lossy(&stdout),
            stderr: lossy(&stderr),
        },
        Ok(status) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                if let Some(signal) = status.signal() {
                    return ProcessOutcome::Killed {
                        trigger,
                        final_signal: if signal == libc::SIGKILL {
                            "SIGKILL"
                        } else {
                            "SIGTERM"
                        },
                        stdout: lossy(&stdout),
                        stderr: lossy(&stderr),
                    };
                }
            }
            ProcessOutcome::Failed {
                exit_code: status.code().unwrap_or(-1),
                stdout: lossy(&stdout),
                stderr: lossy(&stderr),
            }
        }
        Err(error) => ProcessOutcome::SpawnFailed {
            message: error.to_string(),
        },
    }
}

fn limit(stream: &'static str, stdout: Vec<u8>, stderr: Vec<u8>) -> ProcessOutcome {
    ProcessOutcome::OutputLimit {
        stream,
        stdout: lossy(&stdout),
        stderr: lossy(&stderr),
    }
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn kill_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HostAgentConfig;
    use std::path::PathBuf;
    use tokio::sync::watch;

    fn profile(args: Vec<String>, wall_time_ms: u64, max_stdout: usize) -> HostAgentConfig {
        HostAgentConfig {
            agent: "test".into(),
            command: PathBuf::from("/bin/echo"),
            args,
            cwd: std::env::temp_dir(),
            env: HashMap::new(),
            secrets: HashMap::new(),
            wall_time_ms,
            max_stdout_bytes: max_stdout,
            max_stderr_bytes: 65_536,
            port: 1,
            bearer_token_env: "X".into(),
            connection_id: None,
            config_hash: None,
            runtime_kind: None,
            structured_result: false,
            model_argv_prefix: None,
            require_execution_workspace: false,
        }
    }

    #[tokio::test]
    async fn captures_stdout_on_success() {
        let profile = profile(vec!["hello-stdout".into()], 5_000, 65_536);
        let (_tx, rx) = watch::channel(false);
        let outcome = supervise_process(
            &profile,
            &HashMap::new(),
            &serde_json::json!({"hello":"world"}),
            None,
            &profile.cwd,
            rx,
            None,
            |_| {},
            Duration::from_millis(200),
        )
        .await;
        match outcome {
            ProcessOutcome::Succeeded { stdout, .. } => {
                assert!(stdout.contains("hello-stdout"), "{stdout}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn argv_metacharacters_stay_literal() {
        let mut profile = profile(vec![], 5_000, 65_536);
        profile.args = vec![";".into(), "|".into(), "&&".into()];
        let (_tx, rx) = watch::channel(false);
        let outcome = supervise_process(
            &profile,
            &HashMap::new(),
            &serde_json::json!({}),
            None,
            &profile.cwd,
            rx,
            None,
            |_| {},
            Duration::from_millis(200),
        )
        .await;
        match outcome {
            ProcessOutcome::Succeeded { stdout, .. } => {
                assert!(stdout.contains(';'));
                assert!(stdout.contains('|'));
                assert!(stdout.contains("&&"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn output_limit_kills() {
        let profile = profile(vec!["abcdefghijklmnopqrstuvwxyz".into()], 5_000, 4);
        let (_tx, rx) = watch::channel(false);
        let outcome = supervise_process(
            &profile,
            &HashMap::new(),
            &serde_json::json!({}),
            None,
            &profile.cwd,
            rx,
            None,
            |_| {},
            Duration::from_millis(200),
        )
        .await;
        assert!(
            matches!(outcome, ProcessOutcome::OutputLimit { stream: "stdout", .. }),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn wall_time_kills_sleep() {
        let mut profile = profile(vec!["10".into()], 200, 65_536);
        profile.command = PathBuf::from("/bin/sleep");
        let (_tx, rx) = watch::channel(false);
        let outcome = supervise_process(
            &profile,
            &HashMap::new(),
            &serde_json::json!({}),
            None,
            &profile.cwd,
            rx,
            None,
            |_| {},
            Duration::from_millis(50),
        )
        .await;
        assert!(
            matches!(
                outcome,
                ProcessOutcome::Killed {
                    trigger: KillTrigger::WallTime,
                    ..
                }
            ),
            "{outcome:?}"
        );
    }
}
