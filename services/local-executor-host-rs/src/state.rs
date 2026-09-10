use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tokio::time::sleep;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub invocation_id: String,
    pub pid: u32,
    pub started_at: String,
    pub kill_at: String,
}

pub const ORPHAN_TERMINATION_GRACE_MS: u64 = 5_000;

fn state_file(state_dir: &Path, agent: &str) -> PathBuf {
    state_dir.join(format!("{agent}.json"))
}

pub fn read_run_state(state_dir: &Path, agent: &str) -> Option<RunState> {
    let raw = fs::read_to_string(state_file(state_dir, agent)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn write_run_state(state_dir: &Path, agent: &str, state: &RunState) {
    let _ = fs::create_dir_all(state_dir);
    let file = state_file(state_dir, agent);
    let temporary = file.with_extension("json.tmp");
    if fs::write(&temporary, serde_json::to_vec(state).unwrap_or_default()).is_ok() {
        let _ = fs::rename(temporary, file);
    }
}

pub fn clear_run_state(state_dir: &Path, agent: &str) {
    let _ = fs::remove_file(state_file(state_dir, agent));
}

pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

pub fn kill_process_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, signal);
    }
}

pub async fn terminate_orphan(state_dir: &Path, agent: &str) -> Option<String> {
    let state = read_run_state(state_dir, agent)?;
    if !is_process_alive(state.pid) {
        clear_run_state(state_dir, agent);
        return None;
    }
    let recorded_ms = chrono::DateTime::parse_from_rfc3339(&state.started_at)
        .ok()
        .map(|dt| dt.timestamp_millis());
    if recorded_ms.is_none() || !process_start_time_matches(state.pid, recorded_ms.unwrap()) {
        eprintln!(
            "Skipping orphan termination: recorded pid identity cannot be verified agent={} invocationId={} pid={}",
            agent, state.invocation_id, state.pid
        );
        clear_run_state(state_dir, agent);
        return None;
    }
    kill_process_group(state.pid, libc::SIGTERM);
    sleep(Duration::from_millis(ORPHAN_TERMINATION_GRACE_MS)).await;
    if is_process_alive(state.pid) {
        kill_process_group(state.pid, libc::SIGKILL);
    }
    let id = state.invocation_id.clone();
    clear_run_state(state_dir, agent);
    Some(id)
}

fn process_start_time_matches(pid: u32, recorded_ms: i64) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let live_ms = chrono::NaiveDateTime::parse_from_str(&text, "%a %b %e %H:%M:%S %Y")
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
        .or_else(|| {
            chrono::DateTime::parse_from_rfc2822(&text)
                .ok()
                .map(|dt| dt.timestamp_millis())
        });
    match live_ms {
        Some(live) => (live - recorded_ms).abs() <= 2_000,
        None => false,
    }
}
