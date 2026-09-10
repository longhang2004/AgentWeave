---
title: Tenvyr User Manual
status: current
audience:
  - developer
  - operator
  - product
last_verified: 2026-09-10
sources:
  - package.json
  - README.md
  - docs/operations/local-development.md
  - docs/operations/configuration.md
  - docs/operations/self-hosted.md
  - docs/showcase/demo-guide.md
  - docs/showcase/using-model-providers.md
  - docs/architecture/overview.md
  - docker-compose.yml
---

# Tenvyr User Manual

This manual is the operator- and developer-facing guide to installing, running,
and using Tenvyr. It complements the [documentation index](README.md): the
manual explains **how**, the linked reference pages explain **why**. Where this
manual and the executable contracts or code disagree, code and tests win.

A complete Vietnamese translation is available in the
[Sổ tay người dùng Tenvyr](user-manual.vi.md).

## 1. What Tenvyr is

Tenvyr is a supervised coding-agent control plane: run Codex, Claude Code,
OpenCode, and other runtime-owned agent harnesses as a team — without
babysitting terminals. Tenvyr controls execution authority, workspace
boundaries (shared or isolated git worktrees), supervision, attention,
approval, provenance, and evidence; the runtimes keep their intelligence.
Tenvyr also runs Python, TypeScript, and Java-backed agents as persisted
steps with standardized results, retries, timeouts, idempotency, callback
security, and one dashboard for inspecting what happened.

Tenvyr owns **when** work runs, **which runtime and transport** execute it, and
**how** the workflow records success or failure. Agent applications keep
ownership of prompts, tools, reasoning, frameworks, and model-provider calls.

Tenvyr is **not** a model router, prompt playground, credential vault, or
sandbox. Local execution is trusted-code-only, Runtime Connections store
credential _references_ (never values), and administration stays
local/self-hosted behind the External Production Exposure Gate.

## 2. Core concepts

| Concept             | Meaning                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline            | A YAML-declared workflow: steps, dependencies, conditions, timeouts, retries.                                                                                                                   |
| Execution           | One run of a pipeline, persisted end to end.                                                                                                                                                    |
| Step                | One unit of work inside an execution (for example `analyze-input`).                                                                                                                             |
| Attempt             | One execution of a step. Retries create new attempts; the dashboard shows `attempt N/M`.                                                                                                        |
| Runtime             | What executes the work: Python Worker, TypeScript Worker, Java-backed agent, or a configured CLI runtime (Codex, Claude, OpenCode, Generic CLI).                                                |
| Transport           | How work is delivered: HTTP adapter v1 (signed callbacks) or Kafka runtime v1.                                                                                                                  |
| Worker              | An application built with `@tenvyr/worker` (TypeScript) or `tenvyr-worker` (Python) that receives invocations, does work, and returns a canonical result.                                       |
| `AgentInvocationV1` | The canonical, versioned work request sent to an agent.                                                                                                                                         |
| `AgentResultV1`     | The canonical, versioned result returned by an agent. `AgentResult` is the **only terminal authority** for an attempt.                                                                          |
| `AgentEventV1`      | Optional operational events (`accepted`, `progress`, `log`, `heartbeat`, `artifact`, `completed`, `failed`) that become durable evidence — they can never terminalize an attempt by themselves. |
| Runtime Connection  | An operator-configured, probed, freezeable connection to a CLI runtime (M8).                                                                                                                    |
| Workbench           | The operator UI for supervised team runs: planner, verifier, workers, budget limits, approvals.                                                                                                 |
| Capsule             | The terminal execution summary (M7): an immutable export of what happened.                                                                                                                      |

Architecture in one line: **Dashboard → Gateway → Orchestrator → persisted
pipeline state**, with two execution paths — Kafka → specialized agents →
Java Runner, and HTTP → Python/TypeScript Workers → signed callback. See the
[system overview](architecture/overview.md) for the full picture.

## 3. Requirements

- Node.js 22+ with Corepack and pnpm 9 (pinned by package metadata)
- Python 3.11+ (for the Python Worker SDK and example)
- JDK 17 and Maven (for the Java Agent Runner)
- Docker with Docker Compose v2 (the `no-host-ports` override needs Compose 2.24+)

```bash
corepack enable
```

## 4. Installation

```bash
pnpm install --frozen-lockfile
pnpm setup:check        # validates toolchain and environment
```

Optional, for the Python example worker:

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'sdks/python-worker[dev]'
```

## 5. Quick start: the offline showcase

The showcase is the shortest complete local run. It is **offline and
deterministic** — the default mock provider requires no API key.

```bash
pnpm showcase:up        # builds and starts the showcase stack
pnpm showcase:smoke     # seeds demo data, runs success + retry-once, verifies results
```

Then open **http://localhost:4000/dashboard**.

What `showcase:smoke` does: it seeds **Tenvyr Supervised Pipeline**
automatically (the seed is idempotent — run `pnpm showcase:seed` separately
only to pre-seed), runs a successful Python-to-Java-backed flow, then runs
`retry-once` and verifies the Python step completed on its second attempt. The
dashboard exposes step status, runtime, transport, attempts, duration, safe
input/output previews, and provider metadata when present.

![Tenvyr dashboard showing a completed retry-once execution](showcase/images/tenvyr-dashboard-showcase.png)

Stop only the showcase resources:

```bash
pnpm showcase:down
```

**Provider note:** `showcase:up` activates a real provider only when
`LLM_PROVIDER` is explicitly exported in the invoking shell. A value that
Compose only auto-loads from `.env` never opts the showcase into a live call.
With a real provider exported and `LLM_FAILURE_MODE` unset, provider errors
derive `fail` — an invalid key can never silently become a successful
real-provider result. Export `LLM_FAILURE_MODE=mock` only for a deliberate,
labeled fallback. See [using model providers](showcase/using-model-providers.md).

For a scripted 5–10 minute demo flow, follow the
[demo guide](showcase/demo-guide.md).

## 6. Running the full development stack

The one-command dev stack starts the infrastructure (Postgres, Redis,
Zookeeper, Kafka, Kafka UI) plus the operational services — orchestrator,
gateway, Local Executor Host, and frontend — in parallel watch mode:

```bash
pnpm dev
```

Stop everything with `Ctrl-C` — the watch services **and** the Compose stack
are shut down (named volumes are kept, so dev data survives). Run
`pnpm dev:infra:down` only after a hard kill (SIGKILL), which bypasses the
cleanup. If you previously started the full Compose stack
(`pnpm dev:infra`), stop it first (`pnpm dev:infra:down`) — its app containers
hold the host ports the watch services need.

`pnpm dev` covers the HTTP Worker path (orchestrator + gateway + Local Executor Host + dashboard).
The default host is TypeScript; `TENVYR_EXECUTOR_HOST=rust pnpm dev` launches the additive Rust host instead (requires Cargo). See [local executor host](architecture/executors/local-executor-host.md).
The Kafka-path agents (`pnpm dev:reviewer`, `pnpm dev:observability`) are not
included because a host-run Kafka client cannot reach the Compose broker (it
advertises its docker-internal hostname) — run those agents inside the full
Compose stack instead. To start everything in Docker, or to develop the
individual services in separate terminals:

```bash
pnpm dev:infra           # starts every service in the default Compose file
pnpm dev:orchestrator    # :3001
pnpm dev:gateway         # :3000
pnpm dev:host            # :3002 (Local Executor Host — Dynamic Local Runtime Bridge)
pnpm dev:frontend        # :4000
```

Java Agent Runner outside Compose:

```bash
cd services/agent-runner
mvn spring-boot:run      # :8085
```

If Postgres, Redis, or Kafka host ports are already occupied, the checked-in
override removes those host publications while preserving container-to-container
access:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml up -d --build
```

### Local ports

| Component           | Default host port |
| ------------------- | ----------------: |
| Gateway             |              3000 |
| Orchestrator        |              3001 |
| Local Executor Host |              3002 |
| Frontend            |              4000 |
| Java Agent Runner   |              8085 |
| Worker examples     |              8080 |
| Postgres / Redis    |       5432 / 6379 |
| Kafka host listener |             29092 |
| Kafka UI            |              8090 |

Shut down with `pnpm dev:infra:down` (use the same `-f` arguments if you
started with override files). Full details:
[local development](operations/local-development.md).

## 7. Using the dashboard

1. Open **http://localhost:4000/dashboard**.
2. **List executions** — every run appears with its pipeline and terminal
   state. Select one to inspect it.
3. **Step detail** — per step you see status, runtime, transport, attempt
   count (`attempt N/M`), duration, and safe input/output previews.
4. **Live updates** — the Gateway broadcasts `execution-update` over
   Socket.IO; the frontend also polls a selected running execution every two
   seconds as a fallback.
5. **Events and supervision** — Workers can emit `AgentEventV1` events
   (`accepted`, `progress`, `log`, `heartbeat`, `artifact`, `completed`,
   `failed`) over the same signed callback channel or Kafka event topics.
   They are stored as durable evidence per attempt and exposed through
   `GET /executions/:id/events`. Events are evidence only: `AgentResult`
   remains the sole terminal authority.

The frontend can register a YAML pipeline, trigger a run, and show step
input/output/error state. It is not an observability/provenance dashboard:
traces, artifact lineage, and policy controls are not implemented.

## 8. Using the Workbench (supervised team runs)

The Workbench is the operator surface for running a supervised coding team:
a planner, a verifier, and workers, coordinated in iterations with visible
hard limits and operator approval boundaries.

1. Open **http://localhost:4000/workbench**. The page states the
   trusted-operator/loopback-only limitation.
2. **Launch a team run** — fill the launch form (goal, planner/verifier/
   workers, hard limits) and press **Launch run**. This goes through the real
   idempotent command surface (`POST /api/workbench/commands/start-team-run`).
3. **Watch the loop** — the execution detail shows phase, iteration N of max,
   workers with required/optional statuses, the Verifier decision, and the
   remaining deadline. The deterministic demo includes one Worker FAILURE
   (evidence, not a stranded DAG) and one WAIT that the operator approves.
4. **Terminal outcome** — ACCEPTED releases the completion hold; the
   Execution completes.
5. **Inspect** — artifact references (labeled references, never bytes),
   delegation counts, the Execution Capsule summary, run comparison, and the
   operator action audit trail.

The demo contract: at least two iterations, one Worker failure, one approval
boundary, and a Capsule — all from PostgreSQL truth; refresh or reconnect
reconstructs the same view. Full recipe:
[supervised coding team runs](operations/supervised-coding-team.md).

## 9. Runtimes

The `http://localhost:4000/runtimes` page has two tabs.

- **Agent Runtimes** — guided runtime cards for Codex, Claude Code, and
  OpenCode: Installed / Version / Authentication / Connection status /
  Default Model, with **Test Runtime**, **Models**, and **Manage** actions.
  Each card expands into the runtime's **Provider Connections** (section
  10). Sign-in is a guided official flow — the page renders `Run: <command>`
  with **Copy Command** and **Check Again**; the operator runs the command
  in their own terminal. Tenvyr never collects provider credentials and
  never executes the login itself:

  ```bash
  codex login          # Codex
  claude auth login    # Claude Code
  opencode auth login  # OpenCode
  ```

- **Advanced Catalogs** — see the next section.

### Runtime Connections (CLI runtimes)

Runtime Connections let an operator configure, detect, health-check, revoke,
and freeze Codex, Claude, OpenCode, Generic CLI, HTTP Worker, and Kafka Worker
connections.

- **Probing** is operator-initiated, rate-limited, and bounded. Probes are
  documented, non-billable version/auth checks (for example `codex login
status`, `claude --version` + `claude auth status`, `opencode --version`).
- **Freezing**: every claimed attempt freezes a secret-free connection
  revision (connection ID, revision number, runtime kind, config hash,
  conservative capabilities) into the attempt's `executorSnapshot`. Pending
  delivery of a REVOKED connection fails deterministically with
  `EXECUTOR_CONNECTION_REVOKED` and never falls back.
- **Roles**: planner/verifier connection roles need a routing agent; step
  agents resolve as `agent ?? name`.
- **Health status is projection, never dispatch authority** — only REVOKED
  denies.

Onboarding recipe, revocation, and gotchas:
[runtime connections](architecture/executors/runtime-connections.md) and the
[self-hosted runbook](operations/self-hosted-runbooks.md#runtime-connections).

## 10. Provider Connections

Providers are **runtime-owned**: a provider exists only as a projection of
what is authenticated and available THROUGH an Agent Runtime. Provider rows
appear under each runtime card, and Tenvyr never stores provider
credentials. A Provider Connection does NOT mean Tenvyr routes inference
traffic — the chain stays `Tenvyr -> Executor -> Agent Runtime -> Provider`.

- **OpenCode** — first-class provider management. One row per provider
  (provider id, Connected / Not connected, **Models** / **Test** per
  connected provider). A not-connected provider offers **[Connect]**:

  - **OAuth-capable methods** — pick the auth method, **Start
    Authorization**: Tenvyr opens the provider's own authorization page.
    Complete it in that provider window, then **Complete** in the SAME
    session: Tenvyr asks the runtime to prove the connection and refreshes
    the row to Connected. Beginning twice returns the SAME flow and URL
    (no duplicate authorizations); a browser reload restores the pending
    flow with its exact URL until it expires — but only while the
    connection is still current and not revoked: revoking the connection
    or revising it invalidates the pending flow (start again). An
    Orchestrator process restart fails closed — start the flow again.
  - **API-key methods** — the dialog copies the official
    `opencode auth login --provider <id>` command with **Copy Command** /
    **Check Again** — credentials never pass through Tenvyr; the auth file
    is never read and raw auth output is never persisted.
- **Codex** — a single implied provider (OpenAI); auth status from the
  runtime onboarding probe, sign-in via `codex login`.
- **Claude Code** — a single implied provider (Anthropic); auth status
  from `claude auth status`, sign-in via `claude auth login`.
- **API-key providers** (for example DeepSeek via OpenCode) — represented
  through the runtime that can invoke them; Tenvyr stores only an
  environment-variable NAME reference, never a value. Catalog visibility
  NEVER equals execution compatibility: a model is selectable only when the
  selected runtime can actually invoke its provider.

### Advanced Catalogs

The **Advanced Catalogs** tab holds generic OpenAI-compatible endpoints
(base URL + optional credential env-var NAME reference) for catalog
discovery only — bounded on-demand projections, never persisted, never
authoritative. An existing 9Router instance is just such an endpoint:
9Router inspired the provider-management UX but is NOT a Tenvyr product
concept. Tenvyr performs no routing, fallback, or account rotation.

## 11. Team Run: choosing models

In the **Launch a supervised team run** form, each role has a model picker:

- **Planner / Worker / Verifier** — pick a Runtime Target per role: a
  connection plus an optional model. **Runtime default** means no model
  argument — the runtime's own default applies.
- The review step shows the exact target (connection + model, or Runtime
  default) that is frozen into the run.

Model selection is execution provenance:

- The chosen model is frozen into every attempt as `requestedModelId` (the
  identifier exactly as selected); a retry reuses the frozen descriptor and
  never silently switches models.
- A later catalog refresh never rewrites historical attempts.
- The observed model is shown only when the runtime itself reports it —
  never fabricated.

## 12. Writing your first Worker

Workers own prompts, tools, and provider calls; Tenvyr owns dispatch,
timeout, retry, and result delivery.

### TypeScript worker

```ts
import { createWorker, defineAgent } from "@tenvyr/worker";

const agent = defineAgent({
  async execute(context, value) {
    context.raiseIfCancelled();
    return context.success({ output: { echo: value } });
  },
});

createWorker({ agent, port: 8080 }).start();
```

### Python worker

```python
from tenvyr_worker import create_worker, define_agent


@define_agent
async def execute(context, value):
    context.raise_if_cancelled()
    return context.success(output={"echo": value})


create_worker(agent=execute, port=8080).start()
```

Run the checked-in examples after building/installing:

```bash
cp examples/typescript-http-worker/.env.example examples/typescript-http-worker/.env
pnpm --filter @tenvyr/example-typescript-http-worker build
set -a && source examples/typescript-http-worker/.env && set +a
node examples/typescript-http-worker/dist/index.js
```

```bash
cp examples/python-http-worker/.env.example examples/python-http-worker/.env
set -a && source examples/python-http-worker/.env && set +a
.venv/bin/python examples/python-http-worker/src/main.py
```

Example env vars (values are references — never commit populated `.env`
files):

| Variable                                    | Meaning                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `TENVYR_WORKER_TOKEN`                       | Required bearer token for admission.                                   |
| `TENVYR_CALLBACK_KEY_ID`                    | Required callback signing key ID.                                      |
| `TENVYR_CALLBACK_SECRET`                    | Required callback HMAC secret.                                         |
| `TENVYR_CALLBACK_ORIGIN`                    | Required exact callback origin.                                        |
| `TENVYR_ALLOW_INSECURE_HTTP`                | Optional; only exact `true` permits HTTP callbacks.                    |
| `TENVYR_WORKER_HOST` / `TENVYR_WORKER_PORT` | Optional; defaults `0.0.0.0` (TS) / `127.0.0.1` (Python), port `8080`. |

How the HTTP lifecycle, HMAC signing, and replay protection work:
[HTTP adapter v1](architecture/transports/http-agent-adapter-v1.md),
[TypeScript SDK](architecture/workers/typescript-worker-sdk.md),
[Python SDK](architecture/workers/python-worker-sdk.md),
[agent protocol v1](architecture/contracts/agent-protocol-v1.md).

## 13. Model providers

Provider calls belong in the Java Runner or in Worker application code — the
control plane is provider-neutral.

### Pattern A: Java Agent Runner

From `services/agent-runner`:

```bash
# Deterministic mock (default)
LLM_PROVIDER=mock LLM_FAILURE_MODE=mock mvn spring-boot:run

# OpenAI
export LLM_PROVIDER=openai OPENAI_API_KEY='<key>' OPENAI_MODEL='<model>'
unset LLM_FAILURE_MODE
mvn spring-boot:run

# Anthropic
export LLM_PROVIDER=anthropic ANTHROPIC_API_KEY='<key>' ANTHROPIC_MODEL='<model>'
unset LLM_FAILURE_MODE
mvn spring-boot:run

# Ollama
export LLM_PROVIDER=ollama OLLAMA_API_URL='http://localhost:11434' OLLAMA_MODEL='<model>'
unset LLM_FAILURE_MODE
mvn spring-boot:run
```

Runner results include `provider`, `model`, `fallbackUsed`, and
`usageSource=estimated` (token counts are estimates, not provider billing).

### Pattern B: provider inside a Worker

Install any provider SDK as an **application** dependency (never as a
dependency of the Worker core packages), call it inside your `execute`
handler, and attach provider metadata to the success output. Gemini, Azure
OpenAI, Bedrock, Vertex AI, vLLM, and OpenAI-compatible endpoints follow the
same pattern but are not first-class v0.1.0 integrations.

Full snippets: [using model providers](showcase/using-model-providers.md).

## 14. Configuration reference (summary)

The authoritative table is the [configuration reference](operations/configuration.md).
Key facts:

- **Orchestrator** reads `ORCHESTRATOR_PORT` (default `3001`), not generic
  `PORT`. Postgres defaults: `localhost:5432`, `postgres/postgres`.
  `KAFKA_BROKERS` defaults to `localhost:9092`. `AGENT_TRANSPORT_CONFIG` is a
  JSON map of agent name → `kafka` or `http`; blank means every agent uses
  Kafka. HTTP entries carry submit URL, limits, and env-var _names_ for
  bearer/callback secrets.
- **Gateway** reads `GATEWAY_PORT` (default `3000`) and `ORCHESTRATOR_URL`
  (default `http://localhost:3001`).
- **HTTP callback security**: `HTTP_AGENT_CALLBACK_BASE_URL` (required when
  HTTP is used), `HTTP_AGENT_ALLOW_INSECURE` (only exact `true` permits
  HTTP), `HTTP_AGENT_CALLBACK_MAX_SKEW_SECONDS` (default `300`),
  `HTTP_AGENT_REPLAY_TTL_MS`, `HTTP_AGENT_REPLAY_MAX_ENTRIES` (default `10000`).
- **Secrets are references, never values**: compose consumes env var names;
  live values live outside the repository.

## 15. Self-hosted deployment

The supported production profile is `docker-compose.self-hosted.yml`: one
owner, one host, PostgreSQL (loopback `127.0.0.1:5433`) + Orchestrator
(`127.0.0.1:3001`) + Gateway (`127.0.0.1:3000`), pinned to an exact release
git tag (`TENVYR_VERSION`) with the proven source SHA (`TENVYR_SOURCE_REVISION`).

```bash
pnpm self-hosted:preflight            # validates host, ports, config refs — writes nothing
pnpm self-hosted:backup               # VERIFIED backup: manifest anchors computed from an isolated restore of the dump
pnpm self-hosted:restore <backup> --drill     # deep integrity check, never touches the active DB
pnpm self-hosted:restore <backup> --promote  # crash-safe authority swap with automatic rollback
pnpm self-hosted:restore <backup> --reconcile # inspect/reconcile durable recovery state
pnpm self-hosted:upgrade <vX.Y.Z>     # proven source identity → verified backup → fail-closed build/recreate
pnpm self-hosted:health               # curl http://127.0.0.1:3001/health
```

Operational rules that matter:

- **Maintenance mutual exclusion**: every backup/restore takes an exclusive
  lock (`backups/.maintenance.lock`). A second concurrent operation fails
  fast. A lock whose owner PID is dead is **never auto-reclaimed** — the
  owner's docker/DB descendants may still be alive. Clear it explicitly with
  `node scripts/self-hosted/maintenance.mjs --clear-stale-lock` only after
  confirming no maintenance process or descendant is running.
- **Backups are verified before they are labeled backups**: a PASS means the
  manifest was proven against an isolated restore of that exact dump.
- **Restore `--promote` never deletes the original silently**: the safety
  copy is kept until every post-swap gate passes, and a crash at any phase is
  reconciled by the next invocation (durable journal + `--reconcile`).
- **Upgrade proves provenance**: the target must be a real git tag, HEAD must
  be that commit, the tree must be clean; any failure leaves `deploy.env`
  truthful and the backup preserved.

Full protocol, decision table, and runbooks:
[self-hosted deployment](operations/self-hosted.md),
[self-hosted runbooks](operations/self-hosted-runbooks.md).

## 16. Security model

- **Signed callbacks**: HTTP results are HMAC-signed, replay-checked
  (bounded skew window and replay cache), and correlated to persisted steps.
- **Secrets as references**: Runtime Connections store credential references,
  never values; compose consumes env var names whose values live outside the
  repo. `openssl rand -hex 32` is the documented generator for keys.
- **Frozen execution descriptors**: a claimed attempt freezes its executor
  selection; rotating `AGENT_TRANSPORT_CONFIG` mid-flight cannot silently
  reroute a pending outbox. A rotated/missing profile fails deterministically
  (`EXECUTOR_PROFILE_MISMATCH`), never falls back.
- **Local execution is trusted-code-only**: not a sandbox. The Local Executor
  Host runs only commands you trust, under an allowlisted working root, with
  process-group kill at the deadline.
- **Health endpoints return safe reason codes**: never secrets or raw errors.
- **Boundaries**: no multi-user authorization, no SaaS tenancy; the External
  Production Exposure Gate keeps administration local/self-hosted.

## 17. Troubleshooting

| Symptom                                                    | Cause → Fix                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host ports already occupied                                | Only Postgres taken (e.g. another project's dev DB): parameterize it — `TENVYR_POSTGRES_PORT=5433 pnpm dev` (`pnpm dev` sources `.env` and propagates the port to compose and the watch services; standalone services read `POSTGRES_PORT` from the shell). Other ports: use the no-host-ports override `docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml up -d --build`. |
| Smoke test fails                                           | Check `SMOKE_*` overrides and readiness/polling timeouts in the configuration reference; confirm the stack reached readiness.                                                                                                                                                                                                                                                                     |
| Worker callbacks rejected                                  | `TENVYR_CALLBACK_*` in the Worker must match the orchestrator's `HTTP_AGENT_CALLBACK_KEYS`/`HTTP_AGENT_CALLBACK_BASE_URL`; HTTP callbacks need the exact `true` insecure flags on both sides, and the callback origin must match exactly.                                                                                                                                                         |
| Attempt fails with `EXECUTOR_CONNECTION_REVOKED`           | The connection was revoked after the attempt was queued; reconfigure or recreate the run (no automatic fallback by design).                                                                                                                                                                                                                                                                       |
| `EXECUTOR_PROFILE_MISMATCH`                                | The agent's transport profile was rotated after the claim; workflow retry creates a fresh attempt with a new descriptor.                                                                                                                                                                                                                                                                          |
| "maintenance operation already active"                     | Another backup/restore holds the exclusive maintenance lock; wait for it or (after confirming no live descendants) run `node scripts/self-hosted/maintenance.mjs --clear-stale-lock`.                                                                                                                                                                                                             |
| Interrupted promotion                                      | Run `pnpm self-hosted:restore <backup> --reconcile` first — never resume blindly.                                                                                                                                                                                                                                                                                                                 |
| Migration error at startup                                 | Check `TENVYR_DB_MIGRATIONS` and `TENVYR_DB_SYNCHRONIZE` (sync is disposable-development only, exact `true` and `NODE_ENV=development` required); inspect `/health` reason codes.                                                                                                                                                                                                                 |
| Real-provider run fails                                    | Missing/placeholder key or provider error derives `fail` (visible, by design). Export the key and model correctly, or use `LLM_FAILURE_MODE=mock` for a labeled fallback.                                                                                                                                                                                                                         |
| Kafka agents crash-loop with `getaddrinfo ENOTFOUND kafka` | Pre-existing host-run limitation: the Compose broker advertises its docker-internal hostname. Run the Kafka-path agents inside the full Compose stack (`pnpm dev:infra`); the HTTP Worker path (`pnpm dev`) does not need them.                                                                                                                                                                   |

## 18. Current limitations

- Worker idempotency, queues, callback delivery state, and replay tracking are
  process-local; there is no crash-durable Worker outbox.
- Cancellation is cooperative; remote cancellation is not implemented.
- Java Runner token usage is estimated (`usageSource=estimated`).
- Health status is projection, never dispatch authority; only REVOKED denies.
- Local execution is trusted-code-only, not a sandbox.
- No multi-user authorization, HA, zero-downtime upgrades, or exactly-once
  runtime execution guarantees.
- Protocol v1 retains compatibility identifiers documented in the
  [identity record](product/identity.md) — do not rename them as branding
  cleanup.

The living ledger of what is implemented, partial, or planned:
[implementation status](reference/implementation-status.md).

## 19. Glossary

- **Agent**: a program that receives `AgentInvocationV1` and returns
  `AgentResultV1`. Runtimes: Python/TypeScript Workers, Java-backed agents,
  CLI runtimes.
- **Control plane**: the Orchestrator + Gateway + persisted state that own
  dispatch, supervision, and terminal outcomes.
- **Coordinator loop**: the planner/verifier/worker iteration engine behind
  supervised team runs ([coordination loop](architecture/coordination-loop.md)).
- **Outbox**: durable dispatch state that survives orchestrator restarts.
- **Showcase**: the offline, deterministic demo stack (`pnpm showcase:up`).
- **Workbench**: the operator UI for team runs ([Workbench](architecture/workbench.md)).
- **Capsule**: the terminal execution summary export.

## 20. Further reading

- [Documentation index](README.md)
- [System overview](architecture/overview.md) · [Control plane](architecture/control-plane.md)
- [Local development](operations/local-development.md) · [Configuration reference](operations/configuration.md)
- [Self-hosted deployment](operations/self-hosted.md) · [Runbooks](operations/self-hosted-runbooks.md)
- [Agent protocol v1](architecture/contracts/agent-protocol-v1.md)
- [HTTP adapter v1](architecture/transports/http-agent-adapter-v1.md) · [Kafka runtime v1](architecture/transports/kafka-runtime-v1.md)
- [Runtime connections](architecture/executors/runtime-connections.md) · [Local executor host](architecture/executors/local-executor-host.md)
- [TypeScript SDK](architecture/workers/typescript-worker-sdk.md) · [Python SDK](architecture/workers/python-worker-sdk.md)
- [Demo guide](showcase/demo-guide.md) · [Case study](showcase/case-study.md)
- [Testing and verification](operations/testing-and-verification.md)
