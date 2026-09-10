---
title: Agent Rules and Mechanics
status: current
audience:
  - developer
last_verified: 2026-09-10
sources:
  - AGENTS.md
  - CLAUDE.md
  - package.json
  - scripts/codegraph-init.sh
  - scripts/install-skills.sh
  - scripts/rtk-compress.sh
  - services/local-executor-host-rs/Cargo.toml
---

# Agent rules and mechanics

This file supplements the repository's root agent instructions for AI agents
working in the **Tenvyr** monorepo. It records mechanics and verification
expectations; the active agent environment and root instruction files remain
authoritative for tool-specific behavior.

---

## 🧭 Core Directives (Karpathy-Inspired)

AI agents are prone to failure modes such as "hallucination loops", "context overflow amnesia", and "mass file rewrites". To mitigate this:

### 1. The "Think-Before-Code" Ceremony

- **Rule:** Before modifying any file, the agent must declare its design assumptions, trace the affected dependencies, and check if the change requires updating databases or configurations.
- **Action:** Write a brief structured paragraph in your thoughts detailing:
  - What function/class is being edited.
  - Where its dependencies are defined (linked using markdown file links).
  - What side effects are expected.

### 2. Surgical, Contiguous Edits

- **Rule:** Never rewrite entire source code files if you are only changing a few lines or a single block.
- **Action:** Prefer the active agent environment's patch/edit operation for surgical changes. Do not overwrite a source file merely to change one block.

### 3. Verification Protocol

- **Rule:** Every code modification must be verified for syntax and run-time validity.
- **Action:** Run local linters or build commands (`pnpm build`, `mvn clean compile`) to confirm changes do not break the project.

### 4. Rule-Documentation Loop (Mechanic Registration)

- **Rule:** Whenever a new "mechanic" (a new agent, a new Kafka consumer, a new data store adapter, or a helper tool integration) is added to Tenvyr, the agent **MUST** update this file to document the new mechanic's rules.

---

## 🛠️ Registering a New Mechanic Checklist

Every time you add a new service, agent, or major architectural feature, you must perform these steps:

1.  **Update `CLAUDE.md`:** Add ports, glossary terms, or Kafka topic patterns introduced by the new feature.
2.  **Add System Rules to `docs/development/agent-rules.md`:** Add a section under "Registered Mechanics" explaining how the feature works, what interfaces it exposes, and guidelines for editing it.
3.  **Create Helper Scripts (if applicable):** Create automated tools in the `scripts/` directory to simplify setup, data fetching, or testing.
4.  **Refresh optional CodeGraph state:** If the external tool is available, run `scripts/codegraph-init.sh`. CodeGraph availability is not a build or merge requirement.

---

## Optional local agent-support tooling

These tools may improve a developer-agent workflow, but they are not Tenvyr runtime integrations:

- [CodeGraph](tooling/codegraph.md) builds an ignored local structural index for the languages in `codegraph.config.json`. Its `npx` initializer may require network access.
- [Local agent skills](tooling/agent-skills.md) are downloaded or generated instruction files. No inspected Agent Runner code loads them automatically.
- [Persistent memory](tooling/persistent-memory.md) may be provided by a third-party local agent tool. Gateway and Orchestrator do not expose a production memory adapter.
- [Output compression](tooling/output-compression.md) is optional. Its no-RTK fallback preserves output and the wrapped command's exit status; `pnpm test:rtk` covers that dependency-free behavior. Run acceptance gates directly when complete diagnostics are required.

---

## Registered Mechanics

### Event-Driven Pipeline Runtime

- **Purpose:** The orchestrator persists pipeline definitions/executions in PostgreSQL, dispatches step tasks to Kafka topics, consumes agent result topics, and pushes execution updates to the Gateway webhook for Socket.IO broadcast.
- **Interfaces:** Task topics follow `agentweave.agent.<agent>.task`; result topics follow `agentweave.agent.<agent>.result`; dashboard clients receive `execution-update` over the Gateway WebSocket endpoint.
- **Compatibility:** Every retained Kafka topic, consumer group, and client ID is a legacy runtime-v1 identifier, not active Tenvyr branding. Do not rename, alias, or dual-publish it during product-identity work.
- **Rules:** Keep `steps.<stepId>.result.<field>` template semantics stable, preserve the v1 `invocationId` and `stepExecutionId` correlation fields for retry safety, and update `ORCHESTRATOR_AGENT_NAMES` when adding Kafka-backed agents.
- **Verification:** Build the touched NestJS services with `pnpm --filter <service> run build`; compile the Java runner with `mvn clean compile`; use a sample YAML pipeline to verify status transitions and WebSocket updates.

### Agent Invocation Contracts v1

- **Purpose:** Defines the transport-independent, versioned invocation, result, and event payloads shared by the Orchestrator and Kafka-native agents.
- **Interfaces:** Canonical draft 2020-12 schemas are in `contracts/schemas`; TypeScript consumers import types, parsers, structured validation errors, and legacy normalizers from `@tenvyr/contracts`.
- **Rules:** New writers emit only schema version `"1"`; Kafka readers continue to normalize legacy tasks/results; top-level extension fields are forbidden and additions belong under `metadata`; never generate random compatibility IDs or change Kafka topic/agent names while editing v1.
- **Verification:** Run `pnpm --filter @tenvyr/contracts test`, the Kafka service specs for the Orchestrator and both specialized agents, then `pnpm -r build`.

### AgentAdapter Boundary

- **Purpose:** Keeps orchestration state, retries, timeouts, and DAG progression independent from Kafka transport details.
- **Interfaces:** `EngineService` injects `AGENT_ADAPTER`; `KafkaAgentAdapter` implements dispatch/result delivery over the low-level `KafkaService`; `AgentResultService` applies canonical results through the existing Engine state-transition boundary.
- **Rules:** Application services must not import Kafka infrastructure; only the composition root binds the adapter; adapters must not create invocation IDs, update the database, or decide orchestration retries.
- **Verification:** Run the Orchestrator adapter/result/architecture specs and confirm `services/orchestrator/src/architecture.spec.ts` rejects direct Kafka dependencies.

### Asynchronous HTTP Agent Transport

- **Purpose:** Lets exact operator-configured agents receive canonical invocations through `POST /v1/runs` and return canonical results through a signed callback, while all other agents remain Kafka-backed.
- **Interfaces:** `AgentAdapterRouter` selects transport only from `invocation.target.agent`; `HttpAgentAdapter` requires `202 HttpAgentRunAcceptedV1`; callbacks use `POST /internal/agent-callbacks/http/:agent` with HMAC-SHA256 over `<timestamp>.<deliveryId>.<rawBody>`.
- **Rules:** URLs and secret references come only from startup configuration; never route from pipeline input, log secrets/signatures/raw bodies, add automatic fallback, or bypass `AgentResultService`. Keep `AgentAdapterLifecycle` as the sole lifecycle owner.
- **Verification:** Run the HTTP contract, configuration, HMAC, router, callback, architecture, and loopback integration specs; the loopback specs require permission to bind ephemeral `127.0.0.1` ports.

### TypeScript Worker SDK

- **Purpose:** Hosts a typed HTTP agent through `@tenvyr/worker`, using bounded local concurrency, FIFO queuing, in-memory idempotency, cooperative deadlines, and HMAC callback retry.
- **Interfaces:** Consumers use only the package root API; the worker exposes `POST /v1/runs`, `GET /health/live`, and `GET /health/ready`; wire behavior is shared through `contracts/conformance`.
- **Rules:** Keep the package dependent only on the public `@tenvyr/contracts` API and Node primitives. Preserve raw direct handler returns, exact callback-origin checks, bearer-before-body processing, one-shot lifecycle, serialized-once callback bytes, special JSON keys, and the guarantee that `stop()` resolves only after tracked callback work and retry sleeps settle. Canonical fingerprinting is SDK-local rather than a wire requirement. Do not add framework, Orchestrator, Kafka, database, model SDK, signal-handler, or persistent-store dependencies.
- **Packaging:** Both packages are MIT-licensed and stay private until the owner completes registry, legal, and publication gates. Root exports are the only public imports. Run `pnpm verify:package-packs`; never publish from this repository or deep-import `dist` internals.
- **Verification:** Run contracts conformance, Worker unit/integration/stress/open-handle/architecture/public-consumer suites, package pack/install smoke, the example smoke test, and the Orchestrator loopback integration spec. Port-binding tests require permission for ephemeral `127.0.0.1` listeners.

### Python Worker SDK

- **Purpose:** Hosts Python 3.11+ agents through the same asynchronous HTTP contracts using `tenvyr-worker` and the root import `tenvyr_worker`.
- **Interfaces:** Consumers import only the 12 names in `tenvyr_worker.__all__`. The concrete runtime, schema loaders, authentication, callback, and scheduling modules remain under underscore namespaces. The Worker exposes only `POST /v1/runs`, `GET /health/live`, and `GET /health/ready`.
- **Rules:** Keep runtime dependencies limited to `aiohttp` and `jsonschema[format-nongpl]`; load the five tracked schemas only with `importlib.resources`; preserve exact-origin callback policy, finite JSON, FIFO capacity, duplicate-before-capacity behavior, serialized-once callback bytes, and one terminal result. The SDK installs no signal handlers. Threads and cancellation-suppressing coroutines may outlive Worker ownership but must never send a late callback.
- **Packaging:** Version `0.1.0` is MIT-licensed, private, and must not be uploaded to PyPI. Wheels and sdists use explicit allowlists, include the license text, `py.typed`, and exactly five schemas, and must rebuild outside the monorepo without reading `../../contracts`.
- **Verification:** Run the four pytest categories, Ruff, strict mypy, `scripts/sync-python-worker-schemas.py check`, `scripts/verify-python-worker-package.py`, the example smoke, and the explicit Orchestrator loopback with `TENVYR_PYTHON_EXECUTABLE`. Never claim Python-version or loopback results that were not run.

### Product Identity and Observability Roadmap

- **Purpose:** Records future OpenTelemetry, W3C propagation, provenance, privacy, cost, dashboard, instrumentation, and framework-adoption direction without making telemetry a source of execution truth.
- **Rules:** The Tenvyr identity is approved for local repository
  implementation, but registry, domain, legal, repository, and publication
  reservations remain owner gates. Observability remains a projection;
  provider dependencies and optional proxy work stay outside Worker core. Do
  not implement roadmap features as incidental hardening.
- **References:** Follow the [product principles](../product/principles.md) and [observability and provenance roadmap](../roadmap/observability-provenance.md).

### Node Test Setup

- **Purpose:** Provides a per-service Jest + ts-jest runner for the four NestJS services (`gateway`, `orchestrator`, `agent-code-reviewer`, `agent-observability`) so the Workspace_Test_Command `pnpm -r test` passes. `agent-code-reviewer` additionally carries `fast-check` for property-based tests (it is the only service hosting property tests).
- **Interfaces:** Run a single service's tests with `pnpm --filter <service> run test`; run every service's tests with `pnpm -r test`. Each service owns a self-contained `jest.config.js` (`preset: 'ts-jest'`, `testEnvironment: 'node'`, `rootDir: 'src'`, `testRegex: '.*\\.spec\\.ts$'`). Tests build a NestJS `TestingModule` with mocked providers only — no Postgres, Kafka, or Socket.IO bootstrap occurs.
- **Rules:** Adding test (or any) devDependencies to a service `package.json` invalidates `pnpm-lock.yaml`, so you MUST refresh the lockfile with a normal `pnpm install` at the repo root afterward; this keeps the later `pnpm install --frozen-lockfile` verification step passing.
- **Verification:** `pnpm -r test` exits `0` with passing suites reported for all four services.

### Docker Host-Port Override (Port_Override_Mechanism)

- **Purpose:** Lets you run the full stack when host ports `5432` (Postgres), `6379` (Redis), or `9092` (Kafka) are already occupied, without editing `docker-compose.yml`.
- **Interfaces:** Default (unchanged) startup is `docker compose up -d --build`. To disable infra host publishing, layer the override file: `docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml up -d --build`. The override file sets `ports: !reset []` on the `postgres`, `redis`, and `kafka` services, removing host publishing while the containers remain reachable to other services over the preserved internal Compose network.
- **Rules:** Requires Docker Compose v2.24+ (for the `!reset` merge tag). Do not modify `docker-compose.yml`; the default `docker compose up -d --build` developer experience must remain unchanged.
- **Verification:** `docker compose -f docker-compose.yml -f docker-compose.no-host-ports.yml config` shows the `postgres`, `redis`, and `kafka` services with no published host ports.

### Smoke / End-to-End Verification (Smoke_Verification)

- **Purpose:** Provides a repeatable black-box end-to-end check that the running stack drives a sample pipeline all the way to a `COMPLETED` terminal state.
- **Interfaces:** Run `pnpm run smoke:e2e` (an alias for `node scripts/smoke-e2e.mjs`); requires Node 18+ for the built-in global `fetch`. The script health-checks gateway `:3000`, orchestrator `:3001`, code-reviewer `:3002`, observability `:3003`, and agent-runner `:8085` (all via `/health`), plus the frontend `:4000/` and `:4000/dashboard` routes, then creates a sample pipeline, triggers an execution, and polls to a terminal state with a bounded 120s timeout. It exits `0` only on `COMPLETED`, with distinct non-zero exit codes for health, create, trigger, `FAILED`, and timeout failures. Base URLs can be overridden via `SMOKE_*_URL` environment variables.
- **Rules:** Run against an already-started stack (use the Port_Override_Mechanism above if infra host ports are occupied). Stop and remove any temporary containers afterward with `docker compose ... down`.
- **Verification:** With the stack up, `pnpm run smoke:e2e` prints `COMPLETED` and exits `0`.

### Additive Rust local executor host

- **Purpose:** Optional process-isolation host that speaks the same HTTP Worker protocol as `@tenvyr/local-executor-host`. Does not replace Orchestrator, Gateway, Frontend, or Worker SDKs.
- **Interfaces:** `POST /v1/runs`, `GET /health/live`, `GET /health/ready`; HMAC v1 callback headers; same `EXECUTOR_HOST_*` environment. Launch via `TENVYR_EXECUTOR_HOST=rust pnpm dev` or `cargo run --manifest-path services/local-executor-host-rs/Cargo.toml`.
- **Rules:** Keep it behind the adapter boundary. Do not import Orchestrator internals. Preserve fail-closed cwd/binding checks, no-shell argv, env_clear, process-group kill. Do not emit a second terminal result. Landlock/seccomp/cgroup are explicit follow-ups, not drive-by additions.
- **Verification:** `cargo test --manifest-path services/local-executor-host-rs/Cargo.toml`; `node --test scripts/dev-ux.test.mjs`.
