---
title: Implementation Status
status: current
audience:
  - product
  - developer
last_verified: 2026-09-10
sources:
  - docs/reference/implementation-status.json
  - services
  - packages
  - contracts
---

# Implementation status

This is the human-readable summary of current repository behavior. The
[machine-readable ledger](implementation-status.json) is authoritative for the
exact source, test, documentation, and limitation paths of every capability.
Historical plans and implementation reports are evidence, not current API
contracts.

## Implemented internal capabilities

| Capability                                                | Status      | Current boundary                                                                              |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| Contracts v1, JSON numeric interoperability               | implemented | Schema version 1; post-v1 negotiation is not implemented                                      |
| Kafka and HTTP agent adapters                             | implemented | HTTP callback replay/dispatch state remains process-local                                     |
| TypeScript and Python Worker SDKs                         | implemented | Runtime queues/idempotency are process-local; Python cancellation is cooperative              |
| Java runner and example agents                            | implemented | Example/runtime packages, not a general framework integration layer                           |
| Gateway, frontend, readiness, showcase                    | implemented | General external APIs remain behind the open production-exposure gate                         |
| AgentEvents and deterministic supervision                 | implemented | Events are evidence/liveness input, never execution authority                                 |
| Executor descriptors and local executor host              | implemented | Default TypeScript host is trusted-code-only; opt-in Rust host (`TENVYR_EXECUTOR_HOST=rust`) speaks the same HTTP Worker protocol with process-group isolation (Linux `no_new_privs`; Landlock/cgroup not wired) |
| Runtime Connections (M8)                                  | implemented | Immutable secret-free revisions, linearizable claim/revoke under the authority-row lock, frozen attempt identity, bounded probes and test receipts, audited local create/revise/test/revoke commands; runtime profiles pinned 2026-08-12 (codex 0.147.0, claude 2.1.228, opencode 1.18.16); live gates opt-in |
| Supervised agent team execution (M9)                      | implemented | Deterministic Coordinator loop with exact iteration identity, Planner-attempt ownership, strict baseRevision (stale proposals activate nothing; no silent rebase), concurrent-start convergence, and role/executor allowlist enforcement on every run-creation path |
| Operator Workbench (M10)                                  | implemented | Bounded read projections; idempotent audited command surface including Runtime Connection operations (create/revise/test/revoke); deterministic offline demo; loopback/private trusted-operator surface |
| Single-owner self-hosted (M11)                            | implemented | Numeric semver upgrade with fail-closed target verification and truthful metadata; verified backup; restore explicitly separated into --drill (isolated verification) and --promote (deep integrity checks, bounded safety copy, atomic promotion, post-recovery write proof); references-only bootstrap |
| Budget ledger and hierarchy                               | implemented | Budgets are opt-in; operator adjustments are not idempotency-keyed                            |
| Policy decisions, approvals, and WAITING                  | implemented | Internal authority services; no public approval administration API                            |
| PlanPatch, proposals, policy, and planner trigger         | implemented | Restricted additive/replacement patch model; service-level activation                         |
| Observed and supervised delegation                        | implemented | Observed data is an assertion; supervised requests create bounded child executions            |
| Execution Capsule, export, replay, comparison, provenance | implemented | Service-level only; replay is a new execution and does not promise deterministic model output |
| W3C context propagation                                   | implemented | Outbound `traceparent` only; no trusted inbound parentage or `tracestate`                     |
| Product identity and package verification                 | implemented | Publication remains separately blocked                                                        |
| Runtime Target model selection (P2)                       | implemented | Models freeze into execution provenance: allowedTargets authorization (MODEL_NOT_ALLOWED otherwise), deterministic single-model resolution, step metadata.tenvyrModelId -> ExecutorDescriptorV1.requestedModelId -> invocation -> fixed host argv (--model <id>); retries keep the model; catalog changes never rewrite history; observedModelId only when the runtime reports it; no Tenvyr-side fallback engine |
| Provider Connections (P2, final closure)                | implemented | Runtime-owned provider projections through the STRUCTURED OpenCode Server API (opencode serve: GET /provider, /provider/auth, OAuth authorize/callback — TUI output never parsed, auth file never read) + `opencode models`; Codex login status; Claude auth status; model_sources is the GENERIC OpenAI-compatible catalog endpoint configuration only (advanced surface, credential env REFERENCES, bounded on-demand catalogs never persisted); 9Router is NOT a first-class concept (UX inspiration only; an existing instance connects as a generic endpoint); audited source commands run inside the runCommand transaction (M10 atomicity: authority + OperatorAction + outcome commit together); frontend parses the real command envelope with strict guards (never optimistic); no routing/fallback/quota/rotation/alias logic anywhere |
| Invocation efficiency / context projection baseline (P3) | implemented | Bounded ContextBundle identity + projection metrics + immutable per-attempt efficiency evidence + ONE deterministic optimization (Context Projection Reuse, in-memory, fail-closed, never authority); session strategy vocabulary (fresh/reused/resumed/unknown — all current invocations are single-shot FRESH); provider cache-token fields supported in AgentResultV1.usage (absent = not reported, never zero); Workbench "Efficiency" tab + Capsule reconstruction; no result cache, no memory system, no provider KV cache ownership, no full session reuse, no LLM summarization |
| Workspace execution / isolation (PP1)                    | implemented | Pivot invariant 1: the run's workspace determines every runtime child's cwd via the reserved `metadata.tenvyr.executionWorkspace` member; host validates path containment inside EXECUTOR_HOST_ALLOWED_ROOT (realpath trusted-code-only checks — spawn uses the real path, no traversal/symlink bypass); durable workspace_executions lease lifecycle (ALLOCATING→READY→IN_USE→PRESERVED→REMOVED/TRANSFERRED, fail-closed reconciliation, UNIQUE ownerRunId); shared | git-worktree modes; preservation-first cleanup (no --force) + Safe Release truthful audit + crash recovery (see status JSON); Capsule/Workbench execution-workspace projection; no sandbox, no remote clones, no auto merge/push |
| Attention queue (PP1)                                     | implemented | Exception-driven READ projection (HUMAN_APPROVAL_REQUIRED / RUN_FAILED / LIMIT_REACHED / WORKSPACE_REQUIRES_ATTENTION) over durable authority rows; deterministic ids (no polling duplicates); resolution only through existing authority commands; GET /workbench/attention + /attention page + dashboard NEEDS YOU; no attention table, no second authority system |
| Portable handoff (PP1)                                    | implemented | Bounded strictly-parsed HandoffBundleV1 (references only — goal, plan ref, verifier decision, worker summaries, artifact refs, acceptance evidence, next-work, source runtime/model provenance); audited continue-run with existing P2 destination-target authority; terminal-source requirement; exclusive preserved-worktree transfer (source lease TRANSFERRED, destination new lease); handoffs lineage table + destination Capsule lineage; source Capsule/history never rewritten |

## Partial capabilities

| Capability                   | Status  | Current boundary                                                                                                                               |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator pipeline engine | partial | Durable internal M0–M7 authority exists; public authn/authz, ownership, and multi-tenant exposure do not                                       |
| OpenTelemetry                | partial | Bounded non-authoritative OTLP-shaped mapper exists; no wired exporter or real timing capture                                                  |
| Artifact store               | partial | Immutable reference identity, producer/exposure lineage, and bounded projection; no byte ownership, URI verification, retention, or public API |
| Execution state              | partial | Bounded versioned mutable state, controlled writes, and snapshot projection; no event-sourced history, public API, or historical state replay  |

## Planned or blocked capabilities

| Capability             | Status  | Current boundary                                                        |
| ---------------------- | ------- | ----------------------------------------------------------------------- |
| CLI adapter            | planned | Trusted local execution exists, but no dedicated CLI transport contract |
| Framework integrations | planned | No LangGraph/provider-specific helper packages                          |
| Durable Worker outbox  | planned | Worker runtime state remains process-local                              |
| Public package release | blocked | Registry, legal, repository, security, and approval gates remain open   |

## Closure records

- [M2 independent closure](../archive/reviews/2026-08-11-m2-independent-closure.md)
- [M3–M7 independent closure](../archive/reviews/2026-08-12-m3-m7-independent-closure.md)
- [Current control-plane architecture](../architecture/control-plane.md)

The complete numbered M0–M7 roadmap is closed. That is an internal technical
milestone claim, not an external production-readiness or public-release claim.

M8–M11 are IMPLEMENTED and READY FOR INDEPENDENT TECH LEAD VERIFICATION
(implementer status only — closure is the independent reviewer's decision).
Their accepted planning authority remains
[docs/plans/active/tenvyr-productization-roadmap/ROADMAP.md](../plans/active/tenvyr-productization-roadmap/ROADMAP.md).
