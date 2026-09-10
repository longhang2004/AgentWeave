---
title: Configuration Reference
status: current
audience:
  - developer
  - operator
last_verified: 2026-09-10
sources:
  - .env.example
  - docker-compose.yml
  - scripts/dev.mjs
  - services/local-executor-host-rs/src/host.rs
  - services/gateway/src/main.ts
  - services/gateway/src/app.controller.ts
  - services/gateway/src/local-origin.ts
  - services/orchestrator/src/main.ts
  - services/orchestrator/src/local-origin.ts
  - services/orchestrator/src/agent-adapters/agent-transport-config.service.ts
  - services/orchestrator/src/database/database.provider.ts
  - services/orchestrator/src/database/data-source.ts
  - services/orchestrator/src/services/kafka.service.ts
  - services/agent-runner/src/main/resources/application.yml
  - services/agent-runner/src/main/java/com/agentweave/runner/service/LlmService.java
  - docker-compose.showcase.yml
  - examples/typescript-http-worker/src/index.ts
  - examples/python-http-worker/src/main.py
---

# Configuration reference

Values below are variable names and source defaults, never production secret values. `.env.example` is a convenience template; production source code and Compose remain authoritative when it differs.

## Orchestrator

| Variable                             | Requirement and default                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `ORCHESTRATOR_PORT`                  | Optional; defaults to `3001`. The service does not read generic `PORT`.                                     |
| `ORCHESTRATOR_HOST`                  | Optional; defaults to `127.0.0.1` (IPv4 loopback). Compose/self-hosted set `0.0.0.0` so published ports and sibling containers can reach the process; host-side publish stays loopback. |
| `CORS_ORIGIN`                        | Optional comma-separated allow-list of explicit origins shared with the WebSocket policy. Unset means NO HTTP CORS (the Workbench same-origin proxy needs none). A literal `*` is REJECTED and fails startup — never a wildcard. |
| `POSTGRES_HOST`, `POSTGRES_PORT`     | Optional; default `localhost`, `5432`.                                                                      |
| `POSTGRES_USER`, `POSTGRES_PASSWORD` | Optional; both default to `postgres` for local development. Supply secrets outside source control.          |
| `POSTGRES_DB`                        | Optional; uses the persistent compatibility default recorded in `.env.example`.                             |
| `TENVYR_DB_MIGRATIONS`               | Optional; migrations run by default. Exact `false` disables startup migration execution.                    |
| `TENVYR_DB_SYNCHRONIZE`              | Disposable development only; exact `true` works only with `NODE_ENV=development`. Always off in production. |
| `KAFKA_BROKERS`                      | Optional comma-separated brokers; defaults to `localhost:9092`.                                             |
| `KAFKA_CLIENT_ID`                    | Optional; legacy compatibility default `agentweave-orchestrator`.                                           |
| `GATEWAY_URL`                        | Optional; defaults to `http://127.0.0.1:3000` (explicit IPv4 loopback; never localhost address-family dependent). |
| `ORCHESTRATOR_AGENT_NAMES`           | Optional; defaults to `code-reviewer,observability`.                                                        |
| `ORCHESTRATOR_RESULT_TOPICS`         | Optional comma-separated additional result topics; empty by default.                                        |

HTTP agent transport is disabled when `AGENT_TRANSPORT_CONFIG` is absent or blank. When present, it must be a JSON object keyed by exact agent name. Each entry selects `kafka` or `http`; HTTP entries contain the submit URL, time/size limits, and names of environment variables holding bearer/callback secrets.

M8 Runtime Connections: an agent entry may also declare `connectionId`
(`conn:...`). At claim time the Orchestrator then freezes the connection's
current immutable revision (connection ID, revision number, runtime kind,
config hash, conservative capabilities — never secret values) into the
attempt's `executorSnapshot`; pending delivery of a REVOKED connection fails
with a deterministic `EXECUTOR_CONNECTION_REVOKED` and never falls back.

M3 executor descriptors: at claim time the Orchestrator freezes a bounded,
versioned, secret-free executor descriptor (executor kind, HTTP routing
profile, capability flags, config hash) into the attempt's `executorSnapshot`.
Every dispatch/redelivery consumes that frozen selection; rotation of
`AGENT_TRANSPORT_CONFIG` after a claim can never silently reroute a pending
outbox. Secret values (`tokenEnv`, `secretEnv`) are still resolved from the
live environment for the exact pinned profile. A rotated/missing profile
(agent removed or moved to another executor kind) is a deterministic
non-retryable dispatch failure (`EXECUTOR_PROFILE_MISMATCH`), never an
automatic fallback; workflow retry creates a new attempt with a fresh
descriptor. Pre-M3 attempts with `{ agent }` snapshots keep routing from live
configuration (Kafka default) and are never rewritten.

## Local executor host (M3-S3)

`@tenvyr/local-executor-host` is a trusted-code-only local process executor
(no sandbox; run only commands you trust). Point an agent's
`AGENT_TRANSPORT_CONFIG` entry at its `http://127.0.0.1:<port>/v1/runs`
submit URL with a bearer token and shared callback key/secret, exactly like
any other HTTP agent.

| Variable                                       | Requirement and default                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `EXECUTOR_HOST_AGENTS`                         | Required JSON: agent name -> `{ command, args?, cwd?, env?, secrets?, wallTimeMs, maxStdoutBytes, maxStderrBytes, port, bearerTokenEnv }`. `command` must be an absolute path; `cwd` must resolve inside the allowlisted root; `env`/`secrets` map child variable names to host environment names (secret VALUES are never configured or logged). |
| `EXECUTOR_HOST_ALLOWED_ROOT`                   | Required absolute working-root allowlist.                                                                      |
| `EXECUTOR_HOST_STATE_DIR`                      | Required directory for per-agent run state files (orphan termination on restart).                              |
| `EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS`       | Required comma-separated callback origins (the Orchestrator callback base URL).                                |
| `EXECUTOR_HOST_CALLBACK_KEYS`                  | Required JSON `{ keyId: secret }` matching the agent's `callbackAuthentication`.                               |
| `EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE`        | Optional; only exact `true` permits HTTP callback URLs. Default HTTPS-only.                                    |
| `TENVYR_EXECUTOR_HOST`                         | Optional. Exact `rust` makes `pnpm dev` launch `services/local-executor-host-rs` instead of the Node host. Default remains TypeScript. |

The child environment is exactly the configured `env` allowlist plus
resolved `secrets` (include `PATH` if the command needs it). The process
group is killed at the earlier of the invocation deadline and `wallTimeMs`
(SIGTERM, then SIGKILL after 5s). See
[docs/architecture/executors/local-executor-host.md](../architecture/executors/local-executor-host.md).

| Variable                                     | Requirement and default                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AGENT_TRANSPORT_CONFIG`                     | Optional JSON; blank means every agent uses Kafka.                                                                      |
| `HTTP_AGENT_CALLBACK_BASE_URL`               | Required when any configured agent uses HTTP.                                                                           |
| `HTTP_AGENT_ALLOW_INSECURE`                  | Optional; only exact `true` permits HTTP URLs. Default is HTTPS-only.                                                   |
| `HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS`       | Optional positive integer; default `300`.                                                                               |
| `HTTP_AGENT_REPLAY_TTL_MS`                   | Optional positive integer; defaults to the clock-skew window in milliseconds and cannot be shorter.                     |
| `HTTP_AGENT_REPLAY_MAX_ENTRIES`              | Optional positive integer; default `10000`.                                                                             |
| Names selected by `tokenEnv` and `secretEnv` | Required only for the corresponding HTTP agent; values are resolved indirectly and must contain the configured secrets. |

## Gateway

| Variable           | Requirement and default                                                 |
| ------------------ | ----------------------------------------------------------------------- |
| `GATEWAY_PORT`     | Optional; defaults to `3000`. The service does not read generic `PORT`. |
| `GATEWAY_HOST`     | Optional; defaults to `127.0.0.1` (IPv4 loopback). Compose/self-hosted set `0.0.0.0` so Docker published ports work; host-side publish stays loopback. |
| `CORS_ORIGIN`      | Optional comma-separated allow-list of explicit origins; shared with the Orchestrator semantics. Unset means NO HTTP CORS. A literal `*` is REJECTED and fails startup. |
| `ORCHESTRATOR_URL` | Optional; defaults to `http://127.0.0.1:3001` (explicit IPv4 loopback). |

### Local boundary and CORS (Gateway + Orchestrator)

Both services default-bind IPv4 loopback (`127.0.0.1`) and share ONE
explicit local-origin policy (`local-origin.ts`, byte-identical twins in
each service, drift-checked by tests):

- Default local operation accepts no arbitrary browser origins: HTTP has no
  CORS at all, and the Socket.IO/WebSocket endpoint grants only loopback
  browser origins (`127.0.0.1`/`localhost`/`[::1]`, any port).
- `CORS_ORIGIN=a,b` sets a bounded explicit allow-list for BOTH HTTP and
  WebSocket; listing it replaces the default loopback WebSocket grant.
- A literal `*` anywhere in `CORS_ORIGIN` fails closed at startup — it is
  never passed to Nest or Socket.IO.
- The Workbench same-origin proxy keeps working with no configuration.
- Human-facing summaries may display `localhost`; internal defaults are
  always explicit `127.0.0.1`.
- Container profiles (`docker-compose.yml`, self-hosted, compose.dev) set
  `GATEWAY_HOST`/`ORCHESTRATOR_HOST` to `0.0.0.0` so Docker published ports
  and sibling containers can reach `/health`. Host-side publish stays
  loopback (`127.0.0.1:port:port`).

The current Gateway source does not consume the `JWT_*`, Redis, or Postgres values listed under the Gateway heading in `.env.example`. They are not current Gateway API configuration.

## Kafka agents

Both `agent-code-reviewer` and `agent-observability` read:

| Variable           | Requirement and default                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `PORT`             | Optional; defaults to `3002` for code reviewer and `3003` for observability. |
| `KAFKA_BROKERS`    | Optional comma-separated brokers; defaults to `localhost:9092`.              |
| `AGENT_RUNNER_URL` | Optional; defaults to `http://localhost:8085`.                               |

Kafka topic, consumer-group, client-ID, database, Docker network, and Java package values retaining `agentweave` are protocol or deployment compatibility identifiers. Do not rename them as branding cleanup.

## Java Agent Runner

| Variable                              | Requirement and default                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `AGENT_RUNNER_PORT`                   | Optional; defaults to `8085`.                                                                                 |
| `KAFKA_BROKERS`                       | Optional; defaults to `localhost:9092`.                                                                       |
| `LLM_PROVIDER`                        | Optional; `mock`, `openai`, `anthropic`, or `ollama`; defaults to `mock`.                                     |
| `LLM_FAILURE_MODE`                    | Optional; `fail` or `mock`. Defaults to `mock` for mock provider and `fail` for a selected real provider.     |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Required and checked for placeholders when their provider is selected; empty by default.                      |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`     | Required nonblank model identifier for the selected provider. Source defaults exist but should be overridden. |
| `OLLAMA_API_URL`                      | Optional; source default `http://localhost:11434`; Compose uses the host bridge by default.                   |
| `OLLAMA_MODEL`                        | Required nonblank model identifier when Ollama is selected.                                                   |

Mock responses are deterministic and labeled with `provider=mock`,
`model=local-heuristic`, and `fallbackUsed=true`. Real-provider responses use
the configured provider/model and `fallbackUsed=false`. If explicit mock
fallback handles a real-provider error, metadata also records the requested
provider. Token counts are currently labeled `usageSource=estimated`.

## Worker examples

The TypeScript and Python examples share the following names:

| Variable                     | Requirement and default                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `TENVYR_WORKER_TOKEN`        | Required bearer token.                                             |
| `TENVYR_CALLBACK_KEY_ID`     | Required callback signing key ID.                                  |
| `TENVYR_CALLBACK_SECRET`     | Required callback HMAC secret.                                     |
| `TENVYR_CALLBACK_ORIGIN`     | Required exact callback origin.                                    |
| `TENVYR_ALLOW_INSECURE_HTTP` | Optional; only exact `true` permits HTTP callbacks.                |
| `TENVYR_WORKER_HOST`         | Optional; TypeScript defaults to `0.0.0.0`, Python to `127.0.0.1`. |
| `TENVYR_WORKER_PORT`         | Optional; defaults to `8080`; `0` requests an ephemeral port.      |

The package README uses `TENVYR_BEARER_TOKEN` as an illustrative application variable. The runnable examples use `TENVYR_WORKER_TOKEN`; neither name is automatically read by the SDK itself because applications construct SDK configuration explicitly.

## Docker Compose, showcase, and frontend

The default Compose file forwards provider selection, failure mode, credentials,
model IDs, and Ollama URL through environment interpolation. The root
`showcase:up` command supplies `mock` unless `LLM_PROVIDER` is explicitly
exported in the invoking shell; a provider value that Compose only auto-loads
from `.env` does not activate a real call. For an exported real provider, an
unset `LLM_FAILURE_MODE` derives `fail`; export `LLM_FAILURE_MODE=mock` only for
an intentional fallback. Never place a live key in a checked-in environment
file.

`docker-compose.showcase.yml` adds the Python Worker and its exact HTTP adapter
entry. `SHOWCASE_WORKER_TOKEN` and `SHOWCASE_CALLBACK_SECRET` have local-only
defaults for the named showcase project; override them for any non-local use.
The default showcase requires no provider credential.

The default Compose file sets generic `PORT` for Gateway and Orchestrator, while
current source reads `GATEWAY_PORT` and `ORCHESTRATOR_PORT`. Fixed container
values still match source defaults, but changing only `PORT` does not reconfigure
those services.

The frontend reads optional `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`; both
default to `http://localhost:3000`. The smoke script separately supports
`SMOKE_GATEWAY_URL`, `SMOKE_ORCHESTRATOR_URL`, `SMOKE_CODE_REVIEWER_URL`,
`SMOKE_OBSERVABILITY_URL`, `SMOKE_RUNNER_URL`, `SMOKE_PYTHON_WORKER_URL`, and
`SMOKE_FRONTEND_URL` overrides, plus readiness and polling timeouts.
