---
title: Provider Connections and Runtime Targets
status: current
audience:
  - developer
  - operator
last_verified: 2026-09-10
sources:
  - services/orchestrator/src/executors/model-source.ts
  - services/orchestrator/src/services/model-source.service.ts
  - services/orchestrator/src/services/model-discovery.service.ts
  - services/orchestrator/src/services/opencode-auth-flow.service.ts
  - services/orchestrator/src/services/provider-discovery.service.ts
  - services/orchestrator/src/provider-discovery.controller.ts
  - services/orchestrator/src/domain/coordination.ts
  - services/orchestrator/src/executors/executor-descriptor.ts
  - services/local-executor-host/src/supervisor.ts
  - packages/contracts/src/types.ts
  - frontend/src/lib/tenvyr-api/guards.ts
---

# Provider Connections and Runtime Targets (P2)

> Round 2 closure (2026-08-16): ALL provider/model discovery is
> CONNECTION-SCOPED and uses the STRUCTURED OpenCode Server API — TUI
> output is never parsed. See the round-2 sections below; the round-1
> report is `docs/plans/active/tenvyr-productization-roadmap/P2-runtime-model-sources/IMPLEMENTATION_REPORT-2026-08-15.md` (superseded).

## Product model

Four distinct concepts, never conflated:

1. **Runtime Connection** — which agent runtime/executor executes the work
   (`conn:codex`, `conn:claude`, `conn:opencode`, generic CLI). Owned since
   M8; immutable revisions, secret-free.
2. **Provider Connection** — which provider/account/key is available
   THROUGH a runtime; is it authenticated; which models does it expose; can
   it be tested. Provider state is RUNTIME-OWNED: Tenvyr discovers it via
   the runtime's official CLI surfaces and NEVER stores provider
   credentials (environment REFERENCES only, and only for the generic
   advanced endpoint case). A Provider Connection does NOT mean Tenvyr
   routes inference traffic — the chain stays
   `Tenvyr -> Executor -> Agent Runtime -> Provider`.
3. **Model** — a bounded data identifier discovered through a provider of a
   runtime. Catalog visibility NEVER equals execution compatibility: a
   model is selectable only when the SELECTED runtime can actually invoke
   that provider/model (the picker only offers the runtime's own providers).
4. **Runtime Target** — the usable unit selected for Planner / Worker /
   Verifier roles: `{ connectionId, modelId? }` (absent model = Runtime
   default). Model selection authority stays Tenvyr.

## Provider-auth ownership rules

- **OpenCode (first-class provider management)**: official CLI only —
  `opencode auth login`, `opencode auth login --provider <id>`, `opencode
  Server API (`opencode serve`), `opencode models [provider]`, `opencode models --refresh`.
  The auth file is NEVER read; raw auth output is never persisted; Tenvyr
  never proxies credentials. The UI renders the official command with
  [Copy Command] / [Check Again].
- **Codex**: ONE provider (OpenAI). Auth state = `codex login status`;
  sign-in guidance = `codex login`. ChatGPT session credentials are never
  persisted.
- **Claude Code**: ONE provider (Anthropic). Auth state = `claude auth
  status`; sign-in guidance = `claude auth login`. No credential capture.
- **API-key providers (e.g. DeepSeek via OpenCode)**: the KEY is owned by
  the runtime (env reference such as `DEEPSEEK_API_KEY` resolved by the
  runtime at invocation). Tenvyr stores only environment-variable NAMES
  when a generic endpoint needs one. A provider is never selectable for a
  Runtime Target unless the selected runtime can actually invoke it.

## No routing / fallback / rotation

Tenvyr contains NO provider load balancing, priority order, failover,
quota-based switching, account rotation, subscription arbitrage, model
aliases, combos, protocol translation, or inference proxy. Agents/runtimes
own inference. Tenvyr chooses an authorized FROZEN Runtime Target.

9Router inspired the provider-management UX but is NOT a Tenvyr product
concept. An existing 9Router instance is connectable only as the generic
OpenAI-compatible endpoint (advanced surface); Tenvyr never copies 9Router's
routing, fallback, quota, combo/alias, or account machinery.

## model_sources table

`model_sources` keeps a GENERIC role: operator configuration for
OpenAI-compatible catalog endpoints (kind `openai-compatible` only) —
baseUrl (http/https, no userinfo, bounded) + optional credentialEnvRef
(environment variable NAME only). Catalogs are bounded on-demand
projections (≤ 5000 models, ≤ 1 MiB response, ≤ 256 chars per id, strict
10 s timeout, redirects re-validated per hop), NEVER persisted as
authority. Mutations go through the audited Workbench command layer with
the M10 atomicity invariant (authority row + OperatorAction evidence +
stored outcome commit in ONE transaction).

## Model selection is execution provenance

```text
operator selects model M through a provider of the runtime
  -> Tenvyr validates M against the frozen target/source (allowedTargets)
  -> M becomes frozen execution configuration (step metadata.tenvyrModelId)
  -> attempt claim freezes ExecutorDescriptorV1.requestedModelId
  -> invocation carries requestedModelId (wire contract)
  -> the executor host composes FIXED argv: [...args, ...modelArgvPrefix, M]
  -> Capsule/provenance can reconstruct requested M
```

- Retries reuse the frozen descriptor; catalog refreshes never rewrite
  historical attempts; `observedModelId` only when the runtime itself
  reports it; NO Tenvyr-side model fallback.

## Test semantics

- **Check Authentication**: provider account/key/session appears configured
  (auth-list / auth-status projections).
- **Refresh Models**: the provider/runtime can enumerate models.
- **Test Provider / Runtime Target**: explicit operator action using a
  bounded runtime-owned invocation (e.g. `opencode models <provider>`);
  never inference from the Orchestrator, never a chat-completions client.

## Security

Raw API keys never persisted/returned/logged; credential env refs only;
bounded remote responses; strict timeouts; no shell; URL validation
(http/https, no userinfo); redirects re-validated; SSRF documented
(single-owner operator feature, External Production Exposure Gate stays
open); no runtime credential files read; no OAuth proxy; model IDs are data
with fixed argv separation.


## Round 2: connection-scoped discovery via the structured OpenCode Server API

### Why `opencode auth list` parsing was removed

The `auth list` output is HUMAN-oriented (box-drawing decoration such as
`┌ Credentials ... │ ● OpenAI oauth └ 2 credentials`) — first-token
parsing returns an empty list and cannot be made safe with more regexes.
Provider state now comes from the OFFICIAL structured Server API
(`opencode serve`), contract verified 2026-08-16:

```text
GET  /provider                      -> { all: Provider[], default: {...}, connected: string[] }
GET  /provider/auth                 -> { [providerID: string]: ProviderAuthMethod[] }
POST /provider/{id}/oauth/authorize -> ProviderAuthAuthorization (validated url)
POST /provider/{id}/oauth/callback  -> boolean
```

### OpenCode management session

A bounded connection-scoped management adapter starts the EXACT selected
connection's executable (`profile.cli.command`) with the official
`serve` subcommand on `127.0.0.1`, an ephemeral port, and a
cryptographically random `OPENCODE_SERVER_PASSWORD` (env only — never
argv, never logged, never returned). Strict startup/API timeouts, bounded
response sizes, deterministic teardown (SIGTERM -> SIGKILL, all waits
raced), no mDNS, no public bind, no shell. The adapter is for
runtime/provider management ONLY — never an inference proxy, never a
credential vault; `auth.json` is never read.

### Connection-scoped contract

```text
discoverRuntimeProviders(connectionId)
refreshRuntimeModels(connectionId, providerId?)
getRuntimeProviderAuthMethods(connectionId, providerId)
```

The backend: connectionId -> load RuntimeConnection -> REJECT
missing/revoked -> load its CURRENT revision -> use THAT revision's fixed
secret-free profile (cli.command, cli.cwd, approved env/secret
REFERENCES) -> discover. The frontend never supplies executables, cwd,
env, or runtimeKind; two same-kind connections are fully independent.
Model enumeration uses the documented `opencode models [provider]` CLI
invoked through the exact connection profile (never a global PATH
lookup).

### Provider Connect (runtime-owned OAuth)

OAuth-capable providers: `POST oauth/authorize` -> validated authorization
URL surfaced to the operator -> the operator completes authorization in
the PROVIDER's own UI -> `POST oauth/callback` -> refresh `GET /provider`
-> connected. Tenvyr never persists tokens and never receives provider
passwords. API-key methods stay runtime-owned: guided official
`opencode auth login --provider <id>` command only (documented
limitation: Tenvyr stores no provider keys).

### Auth repair for EXISTING connections

A Runtime Connection and runtime authentication are SEPARATE states: an
existing AUTH_REQUIRED connection shows [Sign in] / [Check Again] /
[Advanced] exactly like a not-yet-connected runtime — no revoke/recreate
needed. The Sign-in flow remains runtime-owned.

### Connected-only Team Run targets

A provider is selectable IFF the runtime reports it AUTHENTICATED and the
selected connection can execute it. Unauthenticated providers are visible
in setup (with Connect) but never selectable; models from unauthenticated
providers never appear as options. If a previously selected target became
unavailable before launch, launch is BLOCKED with an exact explanation.
Historical frozen executions are unchanged.

### Test semantics

- **Check Authentication**: structured provider state only — "is this
  provider connected per the runtime?". Never claims inference usability.
- **Refresh Models**: enumeration for that connection/provider.
- **Test Runtime Target**: an explicit audited operator action running a
  SMALL BOUNDED REAL INVOCATION through the actual runtime adapter —
  `[command, ...revision cli.args, ...template modelArgvPrefix, modelId,
  prompt]` (stdin where the run args require it), 30s wall bound, 64KB
  output caps, no shell, no-workspace-impact prompt, UI credit warning
  ("may consume provider credits/tokens"), audited operator action.
  Catalog enumeration is never a successful test; runtime failure is
  surfaced as failure, never READY.


## Round 3 (final closure): OpenCode auth contract + target authority

### Auth method contract (OpenCode 1.18.16)

`GET /provider/auth` methods are `{ type: "oauth" | "api", label }` — there
is NO stable string id. A method is referenced by its STABLE LIST INDEX
(`methodIndex`) within the current discovery snapshot; Tenvyr never
synthesizes an identifier the runtime does not supply. `POST
/provider/{id}/oauth/authorize` carries `{ method: methodIndex }` and
returns `{ url, method: "auto" | "code", instructions }`; the callback
carries `{ method: methodIndex, code? }`.

### One live auth session across the flow

OpenCode keeps the pending OAuth result in INSTANCE-LOCAL memory — the
callback MUST target the same live `opencode serve` instance that
performed authorize. `OpenCodeAuthFlow` owns that lifecycle:

```text
begin (classify existing flow FIRST — compatible reuse / conflict with
       ZERO new server and ZERO authorize — then resolve exact revision ->
       start 127.0.0.1 server -> fetch methods -> validate methodIndex +
       expected type/label fingerprint + prompts -> POST authorize
       {method} -> RETAIN the session + its authorization URL)
  -> bounded { authFlowId, url, method: auto|code, instructions }
operator completes provider-owned flow
complete (SAME session -> POST callback {method, code?} -> GET /provider
       -> prove connected -> close server -> remove flow)
resume (browser reload -> GET /provider-discovery/auth-flows/active
       ?connectionId=...[&providerId=...] returns the SAME authFlowId,
       stored URL, method identity, instructions, expiry — bounded,
       non-secret; never the management-server password/token)
```

Post-PP1 hardening invariants:

- **OAuth flow authority is fenced to the CURRENT RuntimeConnection
  revision.** A flow is bound to exact connectionId + current revision +
  providerId, and the connection must not be REVOKED. Begin resolves the
  authoritative CURRENT state INSIDE the per-(connection, provider) mutex
  (never a pre-lock snapshot), so concurrent Begins that race a revision
  transition serialize and authorize exactly once under the current
  revision.
- **Stale flows fail closed.** A flow from an OLD revision is stale: its
  retained management session is closed and the flow removed at the next
  Resume/Complete/Begin — no provider callback ever fires against it, and
  the stale authorization URL is never exposed. Complete on a revoked
  connection fails `CONNECTION_REVOKED`; Complete across a revision change
  fails `AUTH_FLOW_STALE` — both with callback count 0.
- **Idempotent Begin before side effects** — a duplicate compatible Begin
  (same connectionId, current connectionRevision, providerId, methodIndex,
  expected method fingerprint) returns the EXISTING flow with its ORIGINAL
  URL: one server start, one authorize, ever — sequentially AND under
  `Promise.all` concurrency. An incompatible active flow fails closed with
  `AUTH_FLOW_CONFLICT` before any new server or authorize. The
  max-active-flows bound is enforced AFTER the compatible lookup, so an
  existing flow stays retrievable at capacity.
- **Method identity is revalidated** — Begin carries the selected method's
  expected `type` + `label` from the UI snapshot; a fresh snapshot that
  moved a different method to that index fails closed with
  `AUTH_METHOD_INVALID` and ZERO authorize calls.
- **Browser reload resume** — the Runtimes page restores an active
  unexpired flow on load (same URL/instructions; Complete/Cancel continue
  through the SAME retained session) ONLY while the connection is still
  current and non-revoked. Revoking or revising the connection invalidates
  the pending flow; an expired flow resumes as nothing: the operator starts
  fresh. Cancel remains pure cleanup and may destroy a stale flow without
  authority checks.

Bounds: cryptographically random opaque authFlowId, 5-minute TTL, max 8
active flows, one flow per (connection, provider), cancel endpoint,
deterministic cleanup (TTL timer closes the session), fail-closed on
process restart (the OpenCode pending state is gone — start again). The
server stays 127.0.0.1 with a random password; passwords, tokens, and
codes are never returned, logged, or persisted.

### auto vs code

- `method: "auto"` — show the instructions/URL; completion goes through
  the same live session per the runtime contract.
- `method: "code"` — the UI shows a bounded authorization-code input and
  completes with `{ method, code }`. The code is sent once, never logged
  or persisted. There is no universal "I've completed" button.

### Unsupported prompts fail closed

Auth methods declaring prompt inputs Tenvyr cannot safely drive are
refused BEFORE any authorize call (`AUTH_METHOD_UNSUPPORTED`): the guided
runtime-owned fallback is `opencode auth login --provider <id>` with
[Check Again]. Tenvyr is never a credential collector.

### Server-side target authority

`startTeamRun` validates every explicit opencode provider/model target
against the CURRENT runtime/provider state BEFORE the authority
transaction: the provider (model-id prefix before "/") must be
authenticated through that exact connection revision. Zero authenticated
providers means NO explicit provider/model target can launch (only
"Runtime default" remains, with its documented no-model-argument
semantics). Frontend bypass, direct REST callers, and stale browser state
are all blocked; validated targets are frozen unchanged and historical
frozen executions are never rewritten.


## Round 4 (final): real `prompts[]` contract, oauth/api separation, deterministic TTL

### Prompt contract

OpenCode 1.18.16 defines `prompts?: Prompt[]` on ProviderAuth methods —
the parser reads the REAL plural field; the singular `prompt` is NOT
supported as authoritative. Prompt-requiring methods fail closed
(`AUTH_METHOD_UNSUPPORTED`) before any authorize; Tenvyr never collects
prompt inputs.

### OAuth vs API methods

Only `type: "oauth"` methods belong in the `/oauth/authorize` flow.
`type: "api"` methods MUST NOT call authorize — `beginAuthFlow` rejects
them before any authorize (`AUTH_METHOD_NOT_OAUTH`, including direct REST
submission of an API method index). API-key authentication stays
runtime-owned: the UI shows "API Key — authentication is managed by
OpenCode. Run: `opencode auth login --provider <id>` [Copy Command]
[Check Again]"; Tenvyr never receives raw provider keys.

### Deterministic TTL and shutdown

Every auth flow gets a REAL expiry timer at registration (unref'd — idle
flows never keep the process alive). On fire, the flow is removed
atomically and its management session is closed — no subsequent auth
call is needed to trigger cleanup. complete/cancel/closeAll/expiry are
race-safe: remove-then-close plus the session's idempotent close() means
a session closes at most once and a flow is never resurrected.
`OpenCodeAuthFlowService` implements OnModuleDestroy: a graceful
Orchestrator shutdown calls closeAll(), terminating every live
management session and clearing every timer. Process restart continues
to fail closed (no durable OAuth resumption). The UI never silently
abandons a live flow: Close on an active flow invokes the backend cancel
first.
