---
title: Local Executor Host
status: current
audience:
  - developer
  - operator
last_verified: 2026-09-10
sources:
  - services/local-executor-host/src/config.ts
  - services/local-executor-host/src/supervisor.ts
  - services/local-executor-host/src/state.ts
  - services/local-executor-host/src/main.ts
  - services/local-executor-host-rs/src/supervisor.rs
  - services/local-executor-host-rs/src/host.rs
  - packages/worker/src
---

# Local Executor Host (M3-S3)

## Purpose

`@tenvyr/local-executor-host` runs FIXED operator-configured commands as a
trusted-code-only local process executor. The pipeline selects only a logical
agent name; the host resolves that name to a preconfigured executable. It
implements the canonical HTTP Worker protocol (via the reviewed
`@tenvyr/worker` SDK), so the Orchestrator treats it as an ordinary HTTP
executor: M3 descriptor pinning, profile-rotation safe failure, and
cancel-capability evidence all apply unchanged.

The host is **trusted-code-only**: operator deployment configuration is the
trust boundary. The default TypeScript host has no OS sandbox. The additive
Rust host (`TENVYR_EXECUTOR_HOST=rust`) uses the same HTTP Worker protocol
and spawn contract, plus a new process group and Linux `no_new_privs`;
Landlock/seccomp/cgroup memory remain the upgrade path.

## Safety contract

- **Fixed commands**: `command` must be an absolute path from
  `EXECUTOR_HOST_AGENTS`; the pipeline can never supply a path, command, or
  argument.
- **No shell**: argv array, never a shell. The TypeScript host uses
  `child_process.spawn` with `shell: false`; the Rust host uses
  `Command` with `env_clear` and no shell. Metacharacters in arguments
  stay literal (tested in both).
- **Allowlisted working root**: every `cwd` must resolve inside
  `EXECUTOR_HOST_ALLOWED_ROOT`; both paths are canonicalized.
- **PP1 workspace execution**: when an invocation carries the reserved
  `metadata.tenvyr.executionWorkspace` member, the child spawns at that
  validated path (absolute, existing directory, realpath inside
  `EXECUTOR_HOST_ALLOWED_ROOT` — no traversal, no symlink escape; the
  spawn uses the resolved real path). Agents may declare
  `requireExecutionWorkspace: true` — workspace-less invocations are
  refused before spawn (fail closed). Absent member → the static
  configured `cwd` (backward compatible). See
  [workspace execution / isolation](../workspace-execution.md). Both hosts
  canonicalize through the filesystem, so traversal and symlink escapes are
  rejected at startup.
- **Environment allowlist**: the child environment is EXACTLY the configured
  `env` (child var -> host env var) plus resolved `secrets` references. No
  inherited environment. Secret VALUES are resolved at spawn time and never
  logged, persisted, or echoed by the host.
- **Bounded input**: the canonical invocation is delivered on the child's
  stdin as opaque JSON (bounded by the HTTP request body bound). Artifact
  URIs are never interpreted as local paths.
- **Bounded output**: stdout/stderr are capped by actual UTF-8 bytes (not
  JavaScript character count); exceeding a bound kills the process group
  immediately.
- **Process-group deadline/cancel**: the child runs detached in its own
  process group. At the earlier of the invocation `deadlineAt` and
  `wallTimeMs`, the group receives SIGTERM, then SIGKILL after a 5s grace;
  the escalation outcome is recorded in the canonical failure result.
  Worker shutdown (abort signal) escalates the same way.
- **Idempotency/correlation**: the Worker SDK's idempotency store deduplicates
  by invocation id; the canonical result carries Tenvyr identity fields.
- **Restart/orphan policy**: while a run is active, `<stateDir>/<agent>.json`
  records the CHILD pid. On host restart, a live recorded process group is
  terminated (never adopted, never re-spawned — the Orchestrator times the
  abandoned attempt out and workflow retry creates a new invocation).
- **One result per run**: the host materializes exactly one canonical
  `AgentResultV1` per invocation.

## Result materialization

| Child outcome                    | Result                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------ |
| exit 0                           | `succeeded`, output `{ exitCode: 0, stdout }`                                  |
| non-zero exit                    | `failed`, `EXECUTOR_HOST_PROCESS_FAILED`, stderr tail (retryable false)        |
| unspawnable command              | `failed`, `EXECUTOR_HOST_SPAWN_FAILED` (retryable false)                       |
| deadline/wall-time/shutdown kill | `failed`, `EXECUTOR_HOST_DEADLINE` / `EXECUTOR_HOST_SHUTDOWN` (retryable true) |
| stdout/stderr over the bound     | `failed`, `EXECUTOR_HOST_OUTPUT_LIMIT` (retryable false)                       |

## Rust host (additive)

Set `TENVYR_EXECUTOR_HOST=rust` before `pnpm dev` to run
`services/local-executor-host-rs` instead of the Node host. Same env vars,
same `/v1/runs` + signed callback contract, same fail-closed cwd/binding
rules. Default remains the TypeScript host.

```bash
cargo test --manifest-path services/local-executor-host-rs/Cargo.toml
```

Limitations versus the TypeScript host: AgentEvents/heartbeats are not
emitted yet (the result callback remains terminal authority); Landlock,
seccomp, and cgroup memory bounds are not wired; macOS has process-group
kill + `env_clear` only.

## Configuration

See [operations/configuration.md](../../operations/configuration.md). One
`TenvyrWorker` instance runs per configured agent, each on its own port, with
concurrency 1 and a bounded queue.

## Verification

- Unit: config bounds/traversal/hostile names, no-shell argv, output limits,
  wall-time/invocation-deadline/shutdown kills, SIGKILL escalation, stdin
  delivery, orphan termination (including grandchildren).
- Rust host: HMAC conformance vectors, cwd containment, argv literal
  metacharacters, stdout byte cap, live/auth HTTP probes
  (`cargo test --manifest-path services/local-executor-host-rs/Cargo.toml`).
- Integration (real processes): signed canonical callback with HMAC
  verification, secret redaction in host logs, failure materialization,
  deadline kill.
- Orchestrator loopback: real `HttpAgentAdapter` -> real host -> real child ->
  real signed callback verified by the real callback controller
  (`local-executor-host.loopback.spec.ts`, gated on `EXECUTOR_HOST_MAIN`).
