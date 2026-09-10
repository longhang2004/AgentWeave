---
title: "Attention Queue"
status: current
audience:
  - developer
  - operator
last_verified: 2026-09-10
sources:
  - services/orchestrator/src/domain/attention.ts
  - services/orchestrator/src/services/attention.service.ts
  - services/orchestrator/src/workbench.controller.ts
  - frontend/src/app/attention/page.tsx
---

# Attention Queue

The default supervision experience: an **exception-driven READ
projection** — "which run needs you now?" instead of watching healthy
activity.

## Semantics

- **NOT a second authority system.** Items are derived from existing
  durable rows and exist exactly while the underlying condition exists.
  Nothing is persisted for attention; nothing resolves authority.
- **Deterministic ids** (`attention:<kind>:<id>`): polling can never
  duplicate items, and a resolved condition deterministically removes its
  item.
- **Resolution = the existing authoritative commands**: approval
  (`resolveWait` / approval requests), cancel, workspace release. An item
  disappearing never marks authority complete.

## Classes (only what Tenvyr can prove)

| Kind | Durable source signal | Severity | Action route |
| --- | --- | --- | --- |
| `HUMAN_APPROVAL_REQUIRED` | run phase `WAITING_FOR_HUMAN`; `approval_requests` PENDING | critical / warning | `/runs/<id>` / `/approvals` |
| `RUN_FAILED` | execution status `FAILED` (operator CANCELLED needs no attention) | warning | `/runs/<id>` |
| `LIMIT_REACHED` | run phase `LIMIT_REACHED` | warning | `/runs/<id>` |
| `WORKSPACE_REQUIRES_ATTENTION` | preserved git-worktree lease with `hasUncommittedWork = true` | info | `/runs/<id>` / `/workspaces` |

No "blocked" or "conflict" states are manufactured from guesses. The
projection performs **no durable state transition and no filesystem
mutation** — it is a pure READ projection over existing durable rows.
Terminal-run leases become `PRESERVED` via the authoritative
run-completion path (`preserveExecutionWorkspaceForRun` inside the
coordination transaction), not via lazy `GET /workbench/attention`
polling; continuation/preservation does not depend on Attention polling.
Crash-reconciliation for workspace lifecycles, if needed, lives in an
explicit lifecycle/recovery mechanism, not in the read projection.

## Surfaces

- `GET /workbench/attention` → `{ items, serverTime }` (bounded ≤ 200).
- `/attention` page: NEEDS YOU first (critical), then warnings, then
  workspace follow-up, with inline Approve & Continue / Deny for run-level
  waits and Review links for everything else.
- Dashboard: a NEEDS YOU banner summarizing the current items.
- The legacy `/approvals` page remains a filtered approval view; approval
  authority is untouched.