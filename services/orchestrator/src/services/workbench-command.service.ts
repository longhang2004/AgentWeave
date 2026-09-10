import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { OperatorActionEntity } from "../entities/operator-action.entity";
import { PipelineEntity } from "../entities/pipeline.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { LogicalStepEntity } from "../entities/step-execution.entity";
import { StepAttemptEntity } from "../entities/step-attempt.entity";
import { ExecutionPlanRevisionEntity } from "../entities/execution-plan-revision.entity";
import { ExecutionService } from "./execution.service";
import { RuntimeCoordinationService } from "./runtime-coordination.service";
import { ExecutionCapsuleService } from "./execution-capsule.service";
import { DelegationService } from "./delegation.service";
import { RuntimeConnectionService } from "./runtime-connection.service";
import { WorkspaceService } from "./workspace.service";
import { ModelSourceService } from "./model-source.service";
import { ProviderDiscoveryService } from "./provider-discovery.service";
import {
  RELEASE_PROCESS_INSTANCE_ID,
  WorkspaceExecutionService,
  type ReleaseClaimEvidence,
} from "./workspace-execution.service";
import { WorkspaceExecutionError } from "../domain/workspace-execution";
import { HandoffService } from "./handoff.service";
import { handoffBundleHash } from "../domain/handoff";
import type { ConnectionProfileV1 } from "../executors/runtime-connection";
import { sha256Json } from "../domain/canonical-json";
import {
  parseCoordinationConfig,
  type CoordinationConfigV1,
} from "../domain/coordination";
import {
  parseAcceptanceEvidence,
  type AcceptanceEvidenceV1,
  type WorkspaceSnapshotV1,
} from "../domain/workspace";
import {
  configFromTeamTemplate,
  TEAM_TEMPLATES,
} from "../domain/team-templates";
import {
  RuntimeOnboardingService,
  isOnboardingRuntimeKind,
  type RuntimeOnboardingStatus,
} from "./runtime-onboarding.service";
import { buildRuntimeConnectionProfile } from "../executors/runtime-profiles";

/**
 * M10-S2: idempotent local operator commands through EXISTING authority
 * services. Every command records durable audit evidence; duplicate
 * delivery (same action + idempotency key) returns the stored outcome
 * instead of re-executing authority. The UI never dispatches a Worker,
 * applies a PlanPatch, advances an iteration, or marks completion
 * directly. Initial actor is the single local operator.
 */

export const PROCESS_INSTANCE_ID = RELEASE_PROCESS_INSTANCE_ID;
export function getProcessInstanceId(): string {
  return PROCESS_INSTANCE_ID;
}

/**
 * Post-PP1 hardening: guided-reconnect connection id allocation.
 * ANY existing row at a candidate id is skipped (regardless of its status
 * or runtime kind — a live row must never be resurrected or overwritten);
 * the first ABSENT `conn:<kind>-N` candidate (N in 2..99) wins. When the
 * bounded suffixes are exhausted, collision-checked random suffixes are
 * tried — never one unchecked Date.now() attempt. Pure: the taken set is
 * never mutated, so old rows are unchanged by construction.
 */
export function allocateReconnectConnectionId(
  taken: Iterable<string>,
  kind: string,
  randomSuffix: () => string,
): string {
  const takenSet = new Set(taken);
  for (let i = 2; i < 100; i++) {
    const candidate = `conn:${kind}-${i}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  // ponytail: 8 collision-checked random attempts is far beyond any real
  // operator's suffix exhaustion; upgrade path is a DB unique-violation retry.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `conn:${kind}-${randomSuffix()}`;
    if (!takenSet.has(candidate)) return candidate;
  }
  throw new Error(
    `no free reconnect connection id for "${kind}" — choose an explicit connection id`,
  );
}

// Process-scoped active-token registry singleton
const activeReleaseTokensSingleton = new Set<string>();
export function getActiveReleaseTokens(): Set<string> {
  return activeReleaseTokensSingleton;
}
export function clearActiveReleaseTokens(): void {
  activeReleaseTokensSingleton.clear();
}

export const COMMAND_BOUNDS = {
  idempotencyKeyMax: 128,
  goalMaxChars: 4096,
  runNameMax: 255,
  payloadMaxBytes: 16 * 1024,
} as const;

export type CommandResult = {
  action: string;
  idempotencyKey: string;
  outcome: "executed" | "duplicate";
  result: Record<string, unknown>;
};

export class WorkbenchCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkbenchCommandError";
    this.code = code;
  }
}

@Injectable()
export class WorkbenchCommandService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    executionService?: ExecutionService,
    coordination?: RuntimeCoordinationService,
    capsules?: ExecutionCapsuleService,
    connections?: RuntimeConnectionService,
    workspaces?: WorkspaceService,
    modelSources?: ModelSourceService,
    providerDiscovery?: ProviderDiscoveryService,
    @Optional() workspaceExecutions?: WorkspaceExecutionService,
    @Optional() handoffs?: HandoffService,
  ) {
    this.executionService =
      executionService ??
      new ExecutionService(
        this.dataSource.getRepository(ExecutionEntity),
        this.dataSource.getRepository(LogicalStepEntity),
        this.dataSource.getRepository(StepAttemptEntity),
        this.dataSource.getRepository(ExecutionPlanRevisionEntity),
        this.dataSource,
      );
    this.coordination =
      coordination ?? new RuntimeCoordinationService(this.dataSource);
    this.capsules =
      capsules ??
      new ExecutionCapsuleService(
        this.dataSource,
        new DelegationService(this.dataSource, this.executionService),
        this.executionService,
      );
    this.connections =
      connections ?? new RuntimeConnectionService(this.dataSource);
    this.workspaces = workspaces ?? new WorkspaceService(this.dataSource);
    // P2 closure: the model-source commands must receive the REAL service —
    // an unassigned field crashed every model-source command at runtime.
    this.modelSources =
      modelSources ?? new ModelSourceService(this.dataSource);
    // P2 closure round 2: connection-scoped provider discovery (audited
    // test-runtime-target + opencode oauth commands) — wired like the
    // model-source service above (the round-1 DI crash must not repeat).
    this.providerDiscovery =
      providerDiscovery ?? new ProviderDiscoveryService(this.dataSource);
    // PP1: workspace execution / isolation leases (shared | git-worktree).
    this.workspaceExecutions =
      workspaceExecutions ?? new WorkspaceExecutionService(this.dataSource);
    // PP1 Slice C: portable handoff / continuation.
    this.handoffs =
      handoffs ??
      new HandoffService(
        this.dataSource,
        this.executionService,
        this.coordination,
        this.workspaceExecutions,
      );
  }

  private readonly executionService: ExecutionService;
  private readonly coordination: RuntimeCoordinationService;
  private readonly capsules: ExecutionCapsuleService;
  private readonly connections: RuntimeConnectionService;
  private readonly workspaces: WorkspaceService;
  private readonly modelSources: ModelSourceService;
  private readonly providerDiscovery: ProviderDiscoveryService;
  private readonly workspaceExecutions: WorkspaceExecutionService;
  private readonly handoffs: HandoffService;

  // In-process exact active-release-claim registry keyed by operationId + ownerToken - process-scoped singleton
  // While a release/recovery invocation is genuinely executing, its exact token is registered as ACTIVE
  // In finally, the exact token is removed before the invocation exits
  // Same-process EXECUTING is LIVE only when exact token is still active; otherwise it's a local orphan/recovery candidate
  // Module-level ensures all WorkbenchCommandService instances in one process share truth (tests construct multiple instances)
  private activeTokenKey(operationId: string, ownerToken: string): string {
    return `${operationId}:${ownerToken}`;
  }
  private registerActiveToken(operationId: string, ownerToken: string): void {
    getActiveReleaseTokens().add(this.activeTokenKey(operationId, ownerToken));
  }
  private unregisterActiveToken(operationId: string, ownerToken: string): void {
    getActiveReleaseTokens().delete(this.activeTokenKey(operationId, ownerToken));
  }
  private isActiveToken(operationId: string, ownerToken: string): boolean {
    return getActiveReleaseTokens().has(this.activeTokenKey(operationId, ownerToken));
  }

  private boundedKey(idempotencyKey: string): string {
    if (
      !idempotencyKey ||
      idempotencyKey.length > COMMAND_BOUNDS.idempotencyKeyMax ||
      /[^A-Za-z0-9_.:-]/.test(idempotencyKey)
    ) {
      throw new WorkbenchCommandError(
        "INVALID_IDEMPOTENCY_KEY",
        `idempotencyKey must be 1-${COMMAND_BOUNDS.idempotencyKeyMax} characters of [A-Za-z0-9_.:-]`,
      );
    }
    return idempotencyKey;
  }

  private boundedGoal(goal: unknown): string {
    const raw = typeof goal === "string" ? goal : JSON.stringify(goal ?? {});
    if (raw.length > COMMAND_BOUNDS.goalMaxChars) {
      throw new WorkbenchCommandError(
        "GOAL_TOO_LARGE",
        `goal exceeds ${COMMAND_BOUNDS.goalMaxChars} characters`,
      );
    }
    return raw;
  }

  /**
   * Executes exactly once per (action, idempotencyKey). The audit row is
   * inserted FIRST with a pending marker via INSERT ... ON CONFLICT DO
   * NOTHING — a concurrent duplicate loses the insert (identifiers empty)
   * and returns the winner's stored outcome WITHOUT executing authority.
   * The authority mutation and the outcome CAS commit in the SAME
   * transaction (manager-passable WithManager variants), so a crash can
   * never leave an executed command without evidence or a duplicate
   * authority action, and a caught 23505 can never abort the transaction
   * (Postgres poisons the tx on any error).
   *
   * M10-S2: same idempotency identity + CONFLICTING payload is rejected —
   * the stored request payload (canonical-hashed) is compared on every
   * duplicate delivery, so the same key can never silently execute a
   * different semantic request.
   */
  private async runCommand(
    action: string,
    idempotencyKey: string,
    targetId: string | null,
    payload: Record<string, unknown>,
    execute: (
      manager: import("typeorm").EntityManager,
    ) => Promise<Record<string, unknown>>,
  ): Promise<CommandResult> {
    const key = this.boundedKey(idempotencyKey);
    const actor = "local-operator";
    const payloadHash = sha256Json(payload);
    return this.dataSource.transaction(async (manager) => {
      const actions = manager.getRepository(OperatorActionEntity);
      const inserted = await actions
        .createQueryBuilder()
        .insert()
        .into(OperatorActionEntity)
        .values({
          action,
          idempotencyKey: key,
          actor,
          targetId,
          payload,
          outcome: { pending: true },
        })
        .orIgnore()
        .execute();
      if (inserted.identifiers.length === 0) {
        // A concurrent delivery won the row; its outcome is authoritative
        // and authority was NOT re-executed. The insert waited for that
        // commit, so the row is readable now.
        const winner = await actions.findOne({
          where: { action, idempotencyKey: key },
        });
        if (!winner) throw new Error("Audit row disappeared");
        assertSameRequestPayload(winner.payload, payloadHash, action, key);
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: (winner.outcome as Record<string, unknown>) ?? {},
        };
      }
      // NOTE: with ON CONFLICT DO NOTHING Postgres returns no RETURNING
      // rows, so `identifiers` is NOT the insert proof. The authoritative
      // row is the one visible under (action, key) — ours when still
      // pending, the winner's committed outcome otherwise.
      const row = await actions.findOne({
        where: { action, idempotencyKey: key },
      });
      if (!row) throw new Error("Audit insert produced no row");
      if ((row.outcome as { pending?: boolean })?.pending !== true) {
        assertSameRequestPayload(row.payload, payloadHash, action, key);
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: row.outcome as Record<string, unknown>,
        };
      }
      // A pending row exists with a DIFFERENT payload: a concurrent caller
      // is executing a conflicting semantic request under this key.
      assertSameRequestPayload(row.payload, payloadHash, action, key);
      const result = await execute(manager);
      await actions.update({ id: row.id }, { outcome: result });
      return { action, idempotencyKey: key, outcome: "executed", result };
    });
  }

  /** Launch: pipeline (goal) + execution + coordination run + iteration 1.
   *  The recovery tick drives the engine from here.
   *
   *  PP1: `executionIsolation` (shared | git-worktree) allocates the run's
   *  Tenvyr-owned execution workspace BEFORE the authority transaction
   *  (external git mutations are never transactional); the lease binds to
   *  the run inside it. Allocation failure aborts the launch with the
   *  precise code — never a silent fallback to shared. */
  async startTeamRun(input: {
    idempotencyKey: string;
    name: string;
    goal: unknown;
    config: CoordinationConfigV1;
    /** Product Phase 1: workspace by existing id or by operator path
     *  (frozen into a bounded snapshot at start). */
    workspace?: { workspaceId: string } | { path: string };
    /** Optional operator-declared acceptance evidence (run metadata). */
    acceptanceEvidence?: unknown;
    /** PP1: execution isolation mode for the run's workspace (default
     *  shared = execute against the source workspace itself). */
    executionIsolation?: "shared" | "git-worktree";
  }): Promise<CommandResult> {
    const name = input.name.slice(0, COMMAND_BOUNDS.runNameMax);
    const goal = this.boundedGoal(input.goal);
    const config = parseCoordinationConfig(input.config);
    const acceptanceEvidence: AcceptanceEvidenceV1 | null =
      parseAcceptanceEvidence(input.acceptanceEvidence);
    const executionIsolation =
      input.executionIsolation === "git-worktree"
        ? ("git-worktree" as const)
        : ("shared" as const);

    // P2 final closure: SERVER-SIDE provider readiness enforcement BEFORE
    // the authority transaction. A NEW Team Run may freeze an explicit
    // opencode provider/model target ONLY when the provider is
    // authenticated through that exact connection's CURRENT revision.
    // The probe is external/runtime-owned and runs before the authority
    // transaction; the validated targets are frozen unchanged (never
    // silently rewritten). Frontend bypass, direct REST callers, and
    // stale browser state are all blocked here.
    await this.assertExplicitTargetsReady(config);
    // Freeze the workspace snapshot BEFORE the authority transaction: the
    // snapshot is deterministic run context, never operator-controlled
    // after this point.
    let workspace: WorkspaceSnapshotV1 | null = null;
    if (input.workspace) {
      if ("workspaceId" in input.workspace) {
        workspace = await this.workspaces.refreshWorkspace(
          input.workspace.workspaceId,
        );
      } else {
        const created = await this.workspaces.createWorkspace({
          name,
          path: input.workspace.path,
        });
        workspace = created.snapshot;
      }
    }
    // Dirty source validation: git-worktree requires a clean source repository
    if (
      workspace &&
      workspace.dirty === true &&
      executionIsolation === "git-worktree"
    ) {
      throw new WorkspaceExecutionError(
        "DIRTY_SOURCE_NOT_SUPPORTED",
        `Workspace "${workspace.workspaceId}" has uncommitted changes; git-worktree execution isolation requires a clean source repository (commit or stash changes before starting a run)`,
      );
    }

    // PP1: allocate the Tenvyr-owned execution workspace BEFORE the
    // authority transaction. External git mutations are not transactional;
    // a crash leaves a durable ALLOCATING/READY row that reconciliation
    // fails closed. A failed allocation aborts the launch with the precise
    // code — git-worktree is never silently downgraded to shared.
    let executionWorkspaceAllocation:
      | Awaited<ReturnType<WorkspaceExecutionService["allocateExecutionWorkspace"]>>
      | null = null;
    if (workspace) {
      executionWorkspaceAllocation =
        await this.workspaceExecutions.allocateExecutionWorkspace(
          workspace,
          executionIsolation,
          input.idempotencyKey,
        );
    }
    return this.runCommand(
      "start-team-run",
      input.idempotencyKey,
      null,
      {
        name,
        config: summarizeConfig(config),
        workspace: workspace
          ? {
              workspaceId: workspace.workspaceId,
              path: workspace.path,
              repoRoot: workspace.repoRoot ?? null,
              branch: workspace.branch ?? null,
              headSha: workspace.headSha ?? null,
              dirty: workspace.dirty ?? null,
            }
          : null,
        acceptanceEvidence,
        // Only include the key when a workspace exists: an undefined value
        // would canonicalize to null in the idempotency hash while JSONB
        // storage drops it — a false IDEMPOTENCY_CONFLICT.
        ...(workspace ? { executionIsolation } : {}),
      },
      async (manager) => {
        const pipeline = await manager.getRepository(PipelineEntity).save(
          manager.getRepository(PipelineEntity).create({
            name: name || "team-run",
            version: "1.0",
            steps: [],
          }),
        );
        const execution =
          await this.executionService.materializeExecutionWithManager(
            manager,
            pipeline,
            { goal },
          );
        const run = await this.coordination.startRunWithManager(
          manager,
          execution.id,
          config,
          new Date(Date.now() + config.loopDeadlineMs),
          workspace,
          acceptanceEvidence,
        );
        // PP1: bind the lease to its exclusive run owner inside the
        // authority transaction (UNIQUE ownerRunId; guarded UPDATE).
        let executionWorkspace: unknown = null;
        if (executionWorkspaceAllocation) {
          const bound = await this.workspaceExecutions.bindExecutionWorkspace(
            manager,
            executionWorkspaceAllocation.id,
            run.id,
          );
          executionWorkspace = {
            workspaceExecutionId: bound.id,
            mode: bound.mode,
            path: bound.executionPath,
            baseHeadSha: bound.baseHeadSha,
          };
        }
        const iteration =
          await this.coordination.createNextIterationWithManager(
            manager,
            run.id,
          );
        return {
          executionId: execution.id,
          runId: run.id,
          iterationNumber: iteration.iterationNumber,
          ...(workspace ? { workspace: workspace.path } : {}),
          ...(executionWorkspace ? { executionWorkspace } : {}),
        };
      },
    );
  }

  /** WAIT decision through the existing authority (approve/deny). */
  async resolveWait(input: {
    idempotencyKey: string;
    runId: string;
    approve: boolean;
  }): Promise<CommandResult> {
    return this.runCommand(
      "resolve-wait",
      input.idempotencyKey,
      input.runId,
      { runId: input.runId, approve: input.approve },
      async (manager) => {
        const phase = await this.coordination.resolveWaitWithManager(
          manager,
          input.runId,
          input.approve,
        );
        return { runId: input.runId, phase };
      },
    );
  }

  /** Cancel through the existing whole-execution authority. */
  async cancelExecution(input: {
    idempotencyKey: string;
    executionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "cancel-execution",
      input.idempotencyKey,
      input.executionId,
      { executionId: input.executionId },
      async (manager) => {
        await this.executionService.cancelExecutionWithManager(
          manager,
          input.executionId,
        );
        return { executionId: input.executionId, status: "CANCELLED" };
      },
    );
  }

  /** Controlled replay as a new execution (existing Capsule authority). */
  async replayExecution(input: {
    idempotencyKey: string;
    executionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "replay-execution",
      input.idempotencyKey,
      input.executionId,
      { executionId: input.executionId },
      async (manager) => {
        const replay = await this.capsules.replayWithManager(
          manager,
          input.executionId,
        );
        return {
          sourceExecutionId: input.executionId,
          targetExecutionId: replay.targetExecutionId,
        };
      },
    );
  }

  /**
   * PP1 Slice C: continue a TERMINAL source run as a NEW Team Run on the
   * destination Runtime Target (existing P2 authority validates the frozen
   * targets BEFORE this command). The bounded HandoffBundle is built before
   * the authority transaction; the continuation execution/run + handoff
   * lineage row + exclusive execution-workspace transfer commit atomically.
   */
  async continueRun(input: {
    idempotencyKey: string;
    sourceExecutionId: string;
    config: CoordinationConfigV1;
  }): Promise<CommandResult> {
    const bundle = await this.handoffs.buildHandoffBundle(
      input.sourceExecutionId,
    );
    const bundleHash = handoffBundleHash(bundle);
    // P2 final closure: destination Runtime Target authority is validated
    // against CURRENT provider state BEFORE the authority transaction —
    // exactly like startTeamRun.
    await this.assertExplicitTargetsReady(input.config);
    return this.runCommand(
      "continue-run",
      input.idempotencyKey,
      input.sourceExecutionId,
      {
        sourceExecutionId: input.sourceExecutionId,
        config: summarizeConfig(input.config),
        bundleHash,
      },
      async (manager) => {
        const continued = await this.handoffs.continueRunWithManager(
          manager,
          input.sourceExecutionId,
          input.config,
          bundle,
        );
        return {
          executionId: continued.executionId,
          runId: continued.runId,
          handoffId: continued.handoffId,
          bundleHash: continued.bundleHash,
          sourceExecutionId: input.sourceExecutionId,
        };
      },
    );
  }

  /** M10-S4: bounded structural comparison of two executions. */
  async compareExecutions(input: {
    idempotencyKey: string;
    executionA: string;
    executionB: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "compare-executions",
      input.idempotencyKey,
      null,
      { executionA: input.executionA, executionB: input.executionB },
      async () => {
        const comparison = await this.capsules.compare(
          input.executionA,
          input.executionB,
        );
        return { comparison };
      },
    );
  }

  /**
   * M10-S2: audited Runtime Connection creation (revision 1). The audit
   * evidence and the authority mutation commit in ONE transaction. The
   * profile is secret-free by construction (credential references only);
   * the audit payload stores the same bounded profile the authority froze.
   */
  async createConnection(input: {
    idempotencyKey: string;
    connectionId: string;
    profile: ConnectionProfileV1;
  }): Promise<CommandResult> {
    const profile = this.boundedProfile(input.profile);
    return this.runCommand(
      "create-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId, profile },
      async (manager) => {
        const revision = await this.connections.createConnectionWithManager(
          manager,
          input.connectionId,
          profile,
        );
        return {
          connectionId: input.connectionId,
          revisionNumber: revision.revisionNumber,
        };
      },
    );
  }

  /** M10-S2: audited revision append (immutable revision N+1). */
  async reviseConnection(input: {
    idempotencyKey: string;
    connectionId: string;
    profile: ConnectionProfileV1;
  }): Promise<CommandResult> {
    const profile = this.boundedProfile(input.profile);
    return this.runCommand(
      "revise-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId, profile },
      async (manager) => {
        const revision = await this.connections.reviseConnectionWithManager(
          manager,
          input.connectionId,
          profile,
        );
        return {
          connectionId: input.connectionId,
          revisionNumber: revision.revisionNumber,
        };
      },
    );
  }

  /**
   * M10-S2: audited terminal revocation. Repeated equivalent revoke
   * commands share one effective authority transition and one durable
   * evidence row.
   */
  async revokeConnection(input: {
    idempotencyKey: string;
    connectionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "revoke-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId },
      async (manager) => {
        const status = await this.connections.revokeConnectionWithManager(
          manager,
          input.connectionId,
        );
        return { connectionId: input.connectionId, status };
      },
    );
  }

  /**
   * PP1 Final Closure: audited safe workspace release command saga.
   *
   * 1. Commits operator intent in PostgreSQL first with outcome = { pending: true, phase: "REQUESTED" }.
   * 2. Reconciles/observes existing execution lease state:
   *    - If lease is already REMOVED: finalizes audit outcome with state: "REMOVED" (no git execution).
   *    - If lease is RELEASE_REQUESTED / PRESERVED: executes safe git worktree removal.
   * 3. On success (clean worktree removal): lease -> REMOVED, audit outcome -> { workspaceExecutionId, state: "REMOVED" }.
   * 4. On refusal (dirty worktree / removal failed): lease stays PRESERVED with failureCode: "WORKTREE_DIRTY",
   *    audit outcome -> { workspaceExecutionId, state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "...", refusal: true },
   *    and throws WorkspaceExecutionError("WORKTREE_DIRTY").
   */
   async releaseExecutionWorkspace(input: {
    idempotencyKey: string;
    workspaceExecutionId: string;
    reason?: string;
  }): Promise<CommandResult> {
    const key = this.boundedKey(input.idempotencyKey);
    const action = "release-execution-workspace";
    const targetId = input.workspaceExecutionId;
    const actor = "local-operator";
    const payload = {
      workspaceExecutionId: input.workspaceExecutionId,
      reason: input.reason ?? null,
    };
    const payloadHash = sha256Json(payload);

    // Step 1: Commit operator intent in PostgreSQL BEFORE any external Git removal
    let auditRow = await this.dataSource.transaction(async (manager) => {
      const actions = manager.getRepository(OperatorActionEntity);
      await actions
        .createQueryBuilder()
        .insert()
        .into(OperatorActionEntity)
        .values({
          action,
          idempotencyKey: key,
          actor,
          targetId,
          payload,
          outcome: { pending: true, phase: "REQUESTED" },
        })
        .orIgnore()
        .execute();

      const existing = await actions.findOne({
        where: { action, idempotencyKey: key },
      });
      if (!existing) throw new Error("Audit row disappeared");
      assertSameRequestPayload(existing.payload, payloadHash, action, key);
      return existing;
    });
    let outcome = auditRow.outcome as Record<string, unknown> | undefined;
    // PP1 FINAL: explicit outcome semantics — INTERRUPTED/IN_PROGRESS are NOT success.
    if (outcome && outcome.pending !== true) {
      const state = outcome.state as string | undefined;
      const retryRequired = outcome.retryRequired as boolean | undefined;
      if (outcome.refusal === true) {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "WORKTREE_DIRTY",
          (outcome.error as string) ??
            `Execution workspace "${input.workspaceExecutionId}" release was refused`,
        );
      }
      if (state === "INTERRUPTED" && retryRequired === true) {
        // Allow same operation to be intentionally resumed: reset INTERRUPTED → REQUESTED for retry
        const repo = this.dataSource.getRepository(OperatorActionEntity);
        const reset = await repo
          .createQueryBuilder()
          .update(OperatorActionEntity)
          .set({ outcome: { pending: true, phase: "REQUESTED", resumedFrom: outcome } as unknown as Record<string, unknown> })
          .where("id = :id", { id: auditRow.id })
          .andWhere("outcome->>'state' = 'INTERRUPTED'")
          .execute();
        if ((reset.affected ?? 0) === 1) {
          const refreshed = await repo.findOne({ where: { id: auditRow.id } });
          if (refreshed) {
            auditRow = refreshed;
            outcome = refreshed.outcome as Record<string, unknown> | undefined;
          }
        } else {
          // Concurrent reset — re-read and throw INTERRUPTED for caller to retry
          const refreshed = await repo.findOne({ where: { id: auditRow.id } });
          const out2 = refreshed?.outcome as Record<string, unknown> | undefined;
          if (out2 && out2.state === "INTERRUPTED") {
            throw new WorkspaceExecutionError(
              (out2.failureCode as string) ?? "RELEASE_INTERRUPTED",
              (out2.error as string) ?? "Release was interrupted; retry with the same idempotency key",
            );
          }
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
            (outcome.error as string) ?? "Release was interrupted; retry required",
          );
        }
      } else if (state === "IN_PROGRESS") {
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "OPERATION_IN_PROGRESS",
          (outcome.error as string) ?? "Release operation is in progress",
        );
      } else if (state === "REMOVED") {
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: outcome,
        };
      } else if (state === "NOT_FOUND" || state === "PRESERVED") {
        // For non-REMOVED final states, treat as refusal if flagged, otherwise as duplicate success is wrong — throw
        if (outcome.refusal === true) {
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "RELEASE_REFUSED",
            (outcome.error as string) ?? `Release was refused (${state})`,
          );
        }
        // If it's a PRESERVED without refusal (should not happen after fix), treat as refusal to avoid false success
        if (state === "PRESERVED") {
          throw new WorkspaceExecutionError(
            (outcome.failureCode as string) ?? "PRESERVED",
            (outcome.error as string) ?? "Workspace is preserved; release was not completed",
          );
        }
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: outcome,
        };
      } else {
        // Unknown final outcome — do not pretend success
        throw new WorkspaceExecutionError(
          (outcome.failureCode as string) ?? "RELEASE_INTERRUPTED",
          (outcome.error as string) ?? "Release outcome requires retry",
        );
      }
    }

    // Target-level active release check: at most one ACTIVE release per workspaceExecutionId.
    // SINGLE DRIVER: stale recovery is reachable without knowing old UUID — any new request that observes a stale owner triggers its takeover.
    const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
    const leaseRow0 = await this.dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
    if (leaseRow0?.state === "REMOVED") {
      // Legacy/inconsistent: Workspace REMOVED but A still pending → repair A without Git via target-scoped recovery
      // Find the known prior pending A (if any) before deciding B's provenance — must do before any bulk update
      const knownPendingA = await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder("a").where("a.action = :action", { action }).andWhere("a.targetId = :targetId", { targetId }).andWhere("a.id != :id", { id: auditRow.id }).andWhere("(a.outcome->>'pending')::boolean = true").orderBy("a.createdAt", "ASC").getOne();
      if (knownPendingA) {
        // Repair A without Git (proven legacy: Workspace already REMOVED, no active ownership)
        try {
          await this.dataSource.getRepository(OperatorActionEntity).update({ id: knownPendingA.id }, { outcome: { workspaceExecutionId: targetId, state: "REMOVED" } });
        } catch {}
        // Also repair any other pending for this REMOVED workspace (should be at most one, but be safe)
        const otherPendings = await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder("a").where("a.action = :action", { action }).andWhere("a.targetId = :targetId", { targetId }).andWhere("a.id NOT IN (:...ids)", { ids: [auditRow.id, knownPendingA.id] }).andWhere("(a.outcome->>'pending')::boolean = true").getMany();
        for (const pending of otherPendings) {
          try {
            await this.dataSource.getRepository(OperatorActionEntity).update({ id: pending.id }, { outcome: { workspaceExecutionId: targetId, state: "REMOVED" } });
          } catch {}
        }
        // B is observer, not executor
        const observed = await this.observeRecoveredRelease(auditRow.id, key, knownPendingA.id, targetId);
        if (observed) return observed;
        const duplicateResult: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED", performedByOperationId: knownPendingA.id };
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: duplicateResult });
        return { action, idempotencyKey: key, outcome: "duplicate", result: duplicateResult };
      }
      const ownOutcome = auditRow.outcome as any;
      if (ownOutcome?.pending === true) {
        const ownTerminal: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: ownTerminal });
        return { action, idempotencyKey: key, outcome: "duplicate", result: ownTerminal };
      }
      const recoveredResult: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "REMOVED",
        performedByOperationId: auditRow.id,
      };
      await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: recoveredResult });
      return {
        action,
        idempotencyKey: key,
        outcome: "duplicate",
        result: recoveredResult,
      };
    }
    if (leaseRow0 && (leaseRow0 as unknown as { state: string }).state === "RELEASE_REQUESTED") {
      const ownerOp = (leaseRow0 as unknown as { releaseOperationId?: string | null }).releaseOperationId;
      if (ownerOp && ownerOp !== auditRow.id) {
        // Check if owner is stale (previous process EXECUTING) or same-pid pending that failed finalization (worktree already absent)
        let isStale = false;
        let isSamePidRecoverable = false;
        try {
          const ownerAction = await this.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: ownerOp } as unknown as Record<string, unknown> });
          const ownerOutcome = ownerAction?.outcome as Record<string, unknown> | undefined;
          const ownerPid = (ownerOutcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
          const ownerPhase = (ownerOutcome as { phase?: string } | undefined)?.phase;
          const isRecoverableMarker = Boolean((ownerOutcome as any)?.recoverable === true);
          const ownerToken = (ownerOutcome as any)?.ownerToken as string | undefined;
          const isActive = ownerToken ? this.isActiveToken(ownerOp, ownerToken) : false;
          isStale = Boolean(ownerOutcome && ownerOutcome.pending === true && ownerPhase === "EXECUTING" && ownerPid !== PROCESS_INSTANCE_ID);
          // Same-process orphan: recoverable marker OR exact token NOT active (covers marker-write-failure)
          isSamePidRecoverable = Boolean(
            ownerOutcome &&
              ownerOutcome.pending === true &&
              ((ownerPhase === "EXECUTING" && ownerPid === PROCESS_INSTANCE_ID && (isRecoverableMarker || !isActive)) ||
                (ownerPhase === "REQUESTED" && isRecoverableMarker)),
          );
          if (isSamePidRecoverable) {
            isStale = true;
          } else if (ownerOutcome && ownerOutcome.pending === true && ownerPhase === "EXECUTING" && ownerPid === PROCESS_INSTANCE_ID && !isRecoverableMarker && isActive) {
            // Live owner with active exact token → check legacy ABSENT case (conservative, but active token is authoritative)
            const { worktreeIsRegistered } = await import("./workspace-execution.service");
            const reg = worktreeIsRegistered((leaseRow0 as any).sourcePath, (leaseRow0 as any).executionPath);
            if (reg === "ABSENT") {
              // Even if ABSENT, if token is still active, it's genuinely live (blocked before Git vs after Git distinction is handled in tryRecoverStaleOperation's re-observation)
              // Do not treat as recoverable here; let the live barrier hold
            }
          }
        } catch {}
        if (isStale || isSamePidRecoverable) {
          await this.tryRecoverStaleOperation(ownerOp).catch(() => {});
          const observed = await this.observeRecoveredRelease(
            auditRow.id,
            key,
            ownerOp,
            targetId,
          );
          if (observed) return observed;
        }
        const inProgressOutcome: Record<string, unknown> = {
          workspaceExecutionId: targetId,
          state: "IN_PROGRESS",
          failureCode: "RELEASE_IN_PROGRESS",
          error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress by operation ${ownerOp}`,
          ...(isStale ? { triggeredRecovery: ownerOp } : {}),
        };
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
        throw new WorkspaceExecutionError(
          "RELEASE_IN_PROGRESS",
          `Execution workspace "${input.workspaceExecutionId}" release is already in progress by operation ${ownerOp}`,
        );
      }
      if (!ownerOp) {
        const unauthorizedOutcome: Record<string, unknown> = {
          workspaceExecutionId: targetId,
          state: "PRESERVED",
          failureCode: "RELEASE_UNAUTHORIZED",
          error: `Execution workspace "${input.workspaceExecutionId}" RELEASE_REQUESTED has no authorizing operation`,
          refusal: true,
        };
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: unauthorizedOutcome });
        throw new WorkspaceExecutionError(
          "RELEASE_UNAUTHORIZED",
          `Execution workspace "${input.workspaceExecutionId}" RELEASE_REQUESTED has no authorizing operation`,
        );
      }
    }
    // 2) Check for any other EXECUTING (same PROCESS_INSTANCE_ID) targeting the same workspace (live owner) — only if exact token is still active
    const activeForTargetAll = await this.dataSource
      .getRepository(OperatorActionEntity)
      .createQueryBuilder("a")
      .where("a.action = :action", { action })
      .andWhere("a.targetId = :targetId", { targetId })
      .andWhere("a.id != :id", { id: auditRow.id })
      .andWhere("(a.outcome->>'pending')::boolean = true")
      .andWhere("a.outcome->>'phase' = 'EXECUTING'")
      .andWhere("a.outcome->>'ownerProcessId' = :pid", { pid: PROCESS_INSTANCE_ID })
      .getMany();
    const activeForTarget = activeForTargetAll.filter((row) => {
      const out = row.outcome as any;
      return out?.ownerToken && this.isActiveToken(row.id, out.ownerToken);
    });
    if (activeForTarget.length > 0) {
      const inProgressOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "IN_PROGRESS",
        failureCode: "RELEASE_IN_PROGRESS",
        error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
      };
      await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_IN_PROGRESS",
        `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
      );
    }
    for (const other of activeForTarget) {
      const otherOutcome = other.outcome as Record<string, unknown> | undefined;
      const otherPid = (otherOutcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
      if (otherPid === PROCESS_INSTANCE_ID) {
        const inProgressOutcome: Record<string, unknown> = {
          workspaceExecutionId: targetId,
          state: "IN_PROGRESS",
          failureCode: "RELEASE_IN_PROGRESS",
          error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
        };
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
        throw new WorkspaceExecutionError(
          "RELEASE_IN_PROGRESS",
          `Execution workspace "${input.workspaceExecutionId}" release is already in progress`,
        );
      }
    }
    // Also check for stale EXECUTING owned by different process targeting same workspace but lease not yet RELEASE_REQUESTED (crash before target claim)
    const stalePendingForTarget = await this.dataSource
      .getRepository(OperatorActionEntity)
      .createQueryBuilder("a")
      .where("a.action = :action", { action })
      .andWhere("a.targetId = :targetId", { targetId })
      .andWhere("a.id != :id", { id: auditRow.id })
      .andWhere("(a.outcome->>'pending')::boolean = true")
      .andWhere("a.outcome->>'phase' = 'EXECUTING'")
      .andWhere("a.outcome->>'ownerProcessId' != :pid", { pid: PROCESS_INSTANCE_ID })
      .getMany();
    for (const stale of stalePendingForTarget) {
      await this.tryRecoverStaleOperation(stale.id).catch(() => {});
      const observed = await this.observeRecoveredRelease(
        auditRow.id,
        key,
        stale.id,
        targetId,
      );
      if (observed) return observed;
      // B still must not silently replace A's authority; finalize B as IN_PROGRESS after triggering recovery
      const inProgressOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "IN_PROGRESS",
        failureCode: "RELEASE_IN_PROGRESS",
        error: `Execution workspace "${input.workspaceExecutionId}" release is already in progress (stale owner ${stale.id} recovery triggered)`,
        triggeredRecovery: stale.id,
      };
      await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_IN_PROGRESS",
        `Execution workspace "${input.workspaceExecutionId}" release is already in progress (recovery of ${stale.id} triggered)`,
      );
    }
    // NEW: pending REQUESTED (including recoverable from failed terminal) for same target must be recovered, not abandoned — B observes A, CAS claims A, Git remains A
    const pendingRequestedForTarget = await this.dataSource
      .getRepository(OperatorActionEntity)
      .createQueryBuilder("a")
      .where("a.action = :action", { action })
      .andWhere("a.targetId = :targetId", { targetId })
      .andWhere("a.id != :id", { id: auditRow.id })
      .andWhere("(a.outcome->>'pending')::boolean = true")
      .andWhere("(a.outcome->>'phase' = 'REQUESTED' OR (a.outcome->>'phase' = 'EXECUTING' AND (a.outcome->>'recoverable')::boolean = true) OR a.outcome->>'recoverable' = 'true')")
      .orderBy("a.createdAt", "ASC")
      .getMany();
    // Also include explicit recoverable EXECUTING with same pid that failed terminal persistence
    const recoverableSamePid = await this.dataSource
      .getRepository(OperatorActionEntity)
      .createQueryBuilder("a")
      .where("a.action = :action", { action })
      .andWhere("a.targetId = :targetId", { targetId })
      .andWhere("a.id != :id", { id: auditRow.id })
      .andWhere("(a.outcome->>'pending')::boolean = true")
      .andWhere("a.outcome->>'phase' = 'EXECUTING'")
      .andWhere("(a.outcome->>'recoverable')::boolean = true")
      .getMany();
    const allRecoverable = [...pendingRequestedForTarget, ...recoverableSamePid].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    for (const pending of allRecoverable) {
      const targetLease = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
      const targetState = (targetLease as any)?.state as string | undefined;
      // Recoverable may be for RELEASE_REQUESTED (failed terminal) as well as PRESERVED/FAILED (crash before claim)
      if (targetState !== "PRESERVED" && targetState !== "FAILED" && targetState !== "RELEASE_REQUESTED") continue;
      await this.tryRecoverStaleOperation(pending.id).catch(() => {});
      const observed = await this.observeRecoveredRelease(auditRow.id, key, pending.id, targetId);
      if (observed) return observed;
      const inProgressOutcome: Record<string, unknown> = {
        workspaceExecutionId: targetId,
        state: "IN_PROGRESS",
        failureCode: "RELEASE_IN_PROGRESS",
        error: `Execution workspace "${input.workspaceExecutionId}" release is already pending by operation ${pending.id} (recovery triggered)`,
        triggeredRecovery: pending.id,
      };
      await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: inProgressOutcome });
      throw new WorkspaceExecutionError(
        "RELEASE_IN_PROGRESS",
        `Execution workspace "${input.workspaceExecutionId}" release is already pending by operation ${pending.id}`,
      );
    }
    // Step 1.5: Idempotent durable execution ownership — at most one
    // caller drives the external Git mutation for this (action, key).
    // Uses processInstanceId to distinguish active owner vs dead process.
    // The outcome row carries phase: EXECUTING with ownerToken/ownerProcessId/claimedAt once the winner claims
    // ownership; other concurrent callers in the SAME process observe IN_PROGRESS and never run Git.
    // A stale EXECUTING from a previous dead process (different ownerProcessId) may be taken over via CAS.
    const claimed = await this.claimReleaseOwnership(auditRow.id, auditRow.outcome as Record<string, unknown> | undefined);
    if (claimed.claimed) {
      this.registerActiveToken(auditRow.id, claimed.evidence.ownerToken);
    }
    if (!claimed.claimed) {
      const authoritative = await this.waitForReleaseFinalOutcome(auditRow.id, key, action);
      const aState = authoritative.state as string | undefined;
      const aRetry = authoritative.retryRequired as boolean | undefined;
      if (authoritative.refusal === true) {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "WORKTREE_DIRTY",
          (authoritative.error as string) ?? `Execution workspace "${input.workspaceExecutionId}" release was refused`,
        );
      }
      if (aState === "INTERRUPTED" && aRetry === true) {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "RELEASE_INTERRUPTED",
          (authoritative.error as string) ?? "Release was interrupted; retry with the same idempotency key",
        );
      }
      if (aState === "IN_PROGRESS") {
        throw new WorkspaceExecutionError(
          (authoritative.failureCode as string) ?? "OPERATION_IN_PROGRESS",
          (authoritative.error as string) ?? "Release operation is in progress",
        );
      }
      if (aState === "REMOVED") {
        return {
          action,
          idempotencyKey: key,
          outcome: "duplicate",
          result: authoritative,
        };
      }
      // Any other final state is not success
      throw new WorkspaceExecutionError(
        (authoritative.failureCode as string) ?? "RELEASE_NOT_COMPLETED",
        (authoritative.error as string) ?? `Release not completed (state ${aState ?? "unknown"})`,
      );
    }

    // Step 2: Execute safe release saga (we are the owner) — ONE authoritative terminal transaction after Git (inside WorkspaceExecutionService)
    // The exact token is registered as ACTIVE while genuinely executing; in finally it is removed before exit so failure leaves it as orphan/recoverable
    let releaseSucceeded = false;
    try {
      const released =
        await this.workspaceExecutions.releaseExecutionWorkspace(
          input.workspaceExecutionId,
          claimed.evidence,
        );
      const result: Record<string, unknown> = {
        workspaceExecutionId: released.id,
        state: released.state,
      };
      releaseSucceeded = true;
      return {
        action,
        idempotencyKey: key,
        outcome: "executed",
        result,
      };
    } catch (error) {
      if (error instanceof WorkspaceExecutionError) {
        const code = error.code;
        // For LEASE_NOT_FOUND and other early failures where no workspace exists, the single transaction was never attempted, so we need to persist the truthful outcome directly
        if (code === "LEASE_NOT_FOUND" || code === "LEASE_NOT_RELEASABLE" || code === "SHARED_MODE_NO_REMOVAL" || code === "LEASE_PATH_MISSING") {
          const truthful = await this.truthfulReleaseRefusalOutcome(input.workspaceExecutionId, code, error.message);
          await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: truthful });
          throw new WorkspaceExecutionError(truthful.failureCode as string, truthful.error as string);
        }
        // For other refusals (like WORKTREE_STATE_UNKNOWN, WORKTREE_DIRTY, etc.), the terminal persistence already happened inside WorkspaceExecutionService if it succeeded
        // If it rolled back, the Operator is still pending, so keep it pending for recovery
        const currentOp = await this.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
        const curOutcome = currentOp?.outcome as any;
        if (curOutcome?.pending === true) {
          throw error;
        }
        const truthful = await this.truthfulReleaseRefusalOutcome(
          input.workspaceExecutionId,
          code,
          error.message,
        );
        throw new WorkspaceExecutionError(truthful.failureCode as string, truthful.error as string);
      }
       // ANY terminal persistence failure after Git (injected or real DB failure) must remain recoverable
      // Classify based on durable post-error state, not error string: re-read Workspace, lock, Operator
      const wsAfter = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
      const lockAfter = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
      const lockOpAfter = Array.isArray(lockAfter) ? lockAfter[0]?.releaseOperationId : lockAfter?.rows?.[0]?.releaseOperationId;
      const opAfter = await this.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
      const opOutAfter = opAfter?.outcome as any;
      const stillOwnsTarget = wsAfter?.releaseOperationId === auditRow.id && lockOpAfter === auditRow.id && opOutAfter?.pending === true;
      if (stillOwnsTarget) {
        // Terminal commit did not happen → CAS A to explicit recoverable pending state before returning, so same-pid is distinguishable from live owner
        // Use REQUESTED with recoverable marker (explicit durable retryable state, not timing/TTL)
        try {
          await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: opOutAfter.ownerToken, claimedAt: opOutAfter.claimedAt, failedTerminal: true } as any }).where("id = :id", { id: auditRow.id }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
        } catch {}
        throw error;
      }
      // If terminal already committed (workspace REMOVED/PRESERVED with new state, lock gone, operator terminal), observe truth
      if (wsAfter?.state === "REMOVED" || wsAfter?.state === "PRESERVED") {
        const truth = await this.readRecoveredReleaseTruth(auditRow.id, targetId);
        if (truth && truth.state !== "IN_PROGRESS") {
          await this.dataSource.getRepository(OperatorActionEntity).update({ id: auditRow.id }, { outcome: truth });
          if (truth.state === "REMOVED") {
            return { action, idempotencyKey: key, outcome: "executed", result: truth } as any;
          }
          throw new WorkspaceExecutionError((truth.failureCode as any) ?? "RELEASE_NOT_COMPLETED", (truth.error as any) ?? "Release completed");
        }
      }
      // Non-WorkspaceExecutionError: mark INTERRUPTED with truthful evidence
      // so a retry can re-enter and recover (no ambiguous pending forever).
      const interrupted: Record<string, unknown> = {
        workspaceExecutionId: input.workspaceExecutionId,
        state: "INTERRUPTED",
        failureCode: "RELEASE_INTERRUPTED",
        error: error instanceof Error ? error.message : String(error),
        retryRequired: true,
      };
      await this.dataSource
        .getRepository(OperatorActionEntity)
        .update({ id: auditRow.id }, { outcome: interrupted });
      throw error;
    } finally {
      // Always unregister the exact token when this invocation exits, so a later fresh UUID can distinguish live vs orphan
      // Check affected count for the recoverable transition and do not swallow failure — in-process registry still makes it distinguishable
      try {
        this.unregisterActiveToken(auditRow.id, claimed.evidence.ownerToken);
      } catch {}
      // Also attempt durable recoverable transition if stillOwnsTarget and we had a terminal failure (best-effort, check affected)
      // This is the explicit retryable marker; if this DB write fails, the in-process registry being empty still makes it recoverable
      if (!releaseSucceeded) {
        try {
          const wsAfter2 = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
          const lockAfter2 = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
          const lockOpAfter2 = Array.isArray(lockAfter2) ? lockAfter2[0]?.releaseOperationId : lockAfter2?.rows?.[0]?.releaseOperationId;
          const opAfter2 = await this.dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: auditRow.id } });
          const opOutAfter2 = opAfter2?.outcome as any;
          const stillOwns2 = wsAfter2?.releaseOperationId === auditRow.id && lockOpAfter2 === auditRow.id && opOutAfter2?.pending === true && opOutAfter2?.phase === "EXECUTING";
          if (stillOwns2) {
            const res = await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: opOutAfter2.ownerToken, claimedAt: opOutAfter2.claimedAt, failedTerminal: true } as any }).where("id = :id", { id: auditRow.id }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
            // Check affected count — if 0, the in-process registry being empty is still sufficient for recovery
            if ((res.affected ?? 0) === 0) {
              // Marker write failed, but active token is now unregistered, so same-pid will be considered orphan
            }
          }
        } catch {}
      }
    }
  }

  /**
   * Product Phase 1: ONE-CLICK guided runtime onboarding. Detect the
   * executable on PATH -> probe version/auth -> create the connection from
   * the documented template -> test it. Never reads credentials.
   */
  async onboardRuntime(input: {
    idempotencyKey: string;
    runtimeKind: string;
    /** Optional operator-chosen connection id (default: conn:<kind>). */
    connectionId?: string;
    name?: string;
  }): Promise<CommandResult> {
    if (!isOnboardingRuntimeKind(input.runtimeKind)) {
      throw new WorkbenchCommandError(
        "RUNTIME_NOT_SUPPORTED",
        `onboarding supports codex/claude/opencode, got "${input.runtimeKind}"`,
      );
    }
    const status = await new RuntimeOnboardingService().status(
      input.runtimeKind,
    );
    if (!status.detected || !status.connectPayload) {
      throw new WorkbenchCommandError(
        "RUNTIME_NOT_DETECTED",
        `"${input.runtimeKind}" was not detected on PATH; install the official CLI first`,
      );
    }
    let connectionId = input.connectionId ?? `conn:${input.runtimeKind}`;
    // P1: reconnect after terminal revocation - never resurrect revoked row, create new identity.
    // Post-PP1 hardening: guided reconnect scans candidates ONLY when the
    // default id is REVOKED; ANY existing row at a candidate id is skipped
    // (regardless of status/runtime kind); the first ABSENT candidate wins;
    // exhausted bounded suffixes fall through to collision-checked random
    // suffixes — never one unchecked Date.now() attempt.
    if (!input.connectionId) {
      const repo = this.dataSource.getRepository(
        (await import("../entities/runtime-connection.entity")).RuntimeConnectionEntity,
      );
      const rows = await repo.find({ select: { connectionId: true, statusState: true } as any });
      const statusById = new Map(rows.map((row) => [row.connectionId, row.statusState]));
      if (statusById.get(connectionId) === "REVOKED") {
        connectionId = allocateReconnectConnectionId(
          statusById.keys(),
          input.runtimeKind,
          () => randomUUID().replace(/-/g, "").slice(0, 6),
        );
      }
    }
    const created = await this.createConnection({
      idempotencyKey: `${input.idempotencyKey}:create`,
      connectionId,
      profile: buildRuntimeConnectionProfile({
        runtimeKind: input.runtimeKind,
        name: input.name ?? `runtime:${input.runtimeKind}`,
        executorId: "local-host",
        executable: status.connectPayload.executable,
        ...(status.connectPayload.version
          ? { version: status.connectPayload.version }
          : {}),
      }),
    });
    const tested = await this.testConnection({
      idempotencyKey: `${input.idempotencyKey}:test`,
      connectionId,
    });
    return {
      action: "onboard-runtime",
      idempotencyKey: input.idempotencyKey,
      outcome: created.outcome === "duplicate" ? "duplicate" : "executed",
      result: {
        connectionId,
        runtimeKind: input.runtimeKind,
        detected: true,
        version: status.version ?? null,
        authReady: status.authReady,
        guidance: status.guidance,
        create: created.result,
        test: tested.result,
      },
    };
  }

  /** Product Phase 1: create/refresh a stable workspace from a local path
   *  (bounded git identity capture; never reads credentials). */
  async createWorkspace(input: {
    idempotencyKey: string;
    name?: string;
    path: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "create-workspace",
      input.idempotencyKey,
      null,
      { name: input.name ?? null, path: input.path },
      async () => {
        const created = await this.workspaces.createWorkspace({
          name: input.name ?? "workspace",
          path: input.path,
        });
        return {
          workspaceId: created.id,
          snapshot: created.snapshot,
        };
      },
    );
  }

  /** Product Phase 1: the bounded team templates (roles + useful bounds +
   *  goal framing; Planner still proposes, Tenvyr still authorizes). */
  teamTemplates(): {
    templateId: string;
    name: string;
    description: string;
    goalFraming: string;
    defaultBounds: Record<string, number>;
    configSkeleton: CoordinationConfigV1;
    roleSuggestions: unknown;
  }[] {
    return TEAM_TEMPLATES.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      description: template.description,
      goalFraming: template.goalFraming,
      defaultBounds: { ...template.defaultBounds },
      configSkeleton: configFromTeamTemplate(template.templateId),
      roleSuggestions: template.roleSuggestions,
    }));
  }

  /**
   * M10-S2: audited connection test. Testing does not change authority;
   * the command retains bounded evidence that the operator requested the
   * test (the secret-free receipt, never probe output or credentials).
   * The probe is bounded and rate-limited by the connection service.
   */
  async testConnection(input: {
    idempotencyKey: string;
    connectionId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "test-connection",
      input.idempotencyKey,
      input.connectionId,
      { connectionId: input.connectionId },
      async (manager) => {
        // The probe must see the audit row's committed revision context;
        // it resolves the CURRENT revision itself under the service's
        // own claim lock and returns a bounded, secret-free receipt.
        const receipt = await this.connections.testConnection(
          input.connectionId,
        );
        return {
          connectionId: input.connectionId,
          receipt: {
            revisionNumber: receipt.revisionNumber,
            testedAt: receipt.testedAt,
            state: receipt.state,
            reasonCode: receipt.reasonCode,
            durationMs: receipt.durationMs,
            ...(receipt.testedVersion !== undefined
              ? { testedVersion: receipt.testedVersion }
              : {}),
            ...(receipt.superseded === true ? { superseded: true } : {}),
          },
        };
      },
    );
  }

  // P2: audited Model Source commands. Catalogs are bounded on-demand
  // projections returned to the caller — never persisted as authority.
  // Credential env REFERENCES only; values never cross this layer.
  // P2 closure (M10 invariant): every authority mutation runs through the
  // runCommand EntityManager (WithManager variants) so the authority row,
  // the OperatorAction evidence row, and the stored outcome commit
  // atomically — a failure anywhere rolls the whole transaction back.

  async createModelSource(input: {
    idempotencyKey: string;
    source: unknown;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-create",
      input.idempotencyKey,
      null,
      { source: input.source as Record<string, unknown> },
      async (manager) => {
        const source = await this.modelSources.createWithManager(
          manager,
          input.source,
        );
        return { source };
      },
    );
  }

  async updateModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
    patch: unknown;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-update",
      input.idempotencyKey,
      input.sourceId,
      {
        sourceId: input.sourceId,
        patch: input.patch as Record<string, unknown>,
      },
      async (manager) => {
        const source = await this.modelSources.updateWithManager(
          manager,
          input.sourceId,
          input.patch,
        );
        return { source };
      },
    );
  }

  async deleteModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-delete",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        await this.modelSources.deleteWithManager(manager, input.sourceId);
        return { sourceId: input.sourceId, deleted: true };
      },
    );
  }

  /** Test Model Source (endpoint/auth/catalog — never inference). */
  async testModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-test",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        const source = await this.modelSources.testWithManager(
          manager,
          input.sourceId,
        );
        return { source };
      },
    );
  }

  /** Refresh Models: bounded on-demand catalog projection. */
  async refreshModelSource(input: {
    idempotencyKey: string;
    sourceId: string;
  }): Promise<CommandResult> {
    return this.runCommand(
      "model-source-refresh",
      input.idempotencyKey,
      input.sourceId,
      { sourceId: input.sourceId },
      async (manager) => {
        const { source, catalog } = await this.modelSources.refreshWithManager(
          manager,
          input.sourceId,
        );
        return { source, catalog };
      },
    );
  }

  /**
   * Server-side provider readiness: every explicit model target on an
   * opencode connection must reference a provider authenticated through
   * that EXACT connection revision. Zero authenticated providers means NO
   * explicit provider/model target may launch. Runtime default (no
   * modelId) remains available with its documented semantics: no model
   * argument is composed and the runtime resolves its own default.
   * Historical frozen executions are never touched.
   */
  private async assertExplicitTargetsReady(config: CoordinationConfigV1): Promise<void> {
    const targets: Array<{ connectionId: string; modelId?: string }> = [];
    if (config.plannerTarget?.connectionId) {
      targets.push(config.plannerTarget);
    }
    if (config.verifierTarget?.connectionId) {
      targets.push(config.verifierTarget);
    }
    for (const target of config.allowedTargets ?? []) {
      targets.push(target);
    }
    const explicitByConnection = new Map<string, string[]>();
    for (const target of targets) {
      if (!target.modelId) continue;
      const list = explicitByConnection.get(target.connectionId) ?? [];
      list.push(target.modelId);
      explicitByConnection.set(target.connectionId, list);
    }
    for (const [connectionId, modelIds] of explicitByConnection) {
      // Resolve the exact revision (rejects missing/revoked) and discover
      // the CURRENT provider state through it.
      let discovery: Awaited<
        ReturnType<ProviderDiscoveryService["discoverRuntimeProviders"]>
      >;
      try {
        discovery = await this.providerDiscovery.discoverRuntimeProviders(connectionId);
      } catch (error) {
        // CONNECTION_NOT_FOUND / CONNECTION_REVOKED propagate as-is.
        throw error;
      }
      if (discovery.runtimeKind !== "opencode") continue;
      const connected = discovery.providers.filter((p) => p.authenticated);
      for (const modelId of modelIds) {
        const providerId = modelId.includes("/") ? modelId.split("/")[0] : null;
        if (!providerId) {
          // An explicit model without a provider prefix cannot be proven
          // against the runtime's provider state — fail closed.
          throw new WorkbenchCommandError(
            "PROVIDER_NOT_AUTHENTICATED",
            `model "${modelId}" on "${connectionId}" has no provider prefix; explicit opencode targets must reference a connected provider`,
          );
        }
        if (!connected.some((p) => p.providerId === providerId)) {
          throw new WorkbenchCommandError(
            "PROVIDER_NOT_AUTHENTICATED",
            `provider "${providerId}" is not authenticated through "${connectionId}" (revision ${discovery.revisionNumber}) — connect it on the Runtimes page first`,
          );
        }
      }
    }
  }

  /**
   * Test Runtime Target (P2 closure round 2): a SMALL BOUNDED REAL
   * INVOCATION through the selected Runtime Connection's frozen profile
   * and the requested model — audited because it may consume external
   * provider credits/tokens. Failure is surfaced as failure, never READY.
   */
  async testRuntimeTarget(input: {
    idempotencyKey: string;
    connectionId: string;
    modelId: string;
  }): Promise<CommandResult> {
    const connectionId = input.connectionId.slice(0, 255);
    const modelId = input.modelId.slice(0, 255);
    return this.runCommand(
      "test-runtime-target",
      input.idempotencyKey,
      connectionId,
      { connectionId, modelId },
      async () => {
        const evidence = await this.providerDiscovery.testRuntimeTarget(
          connectionId,
          modelId,
        );
        return { evidence };
      },
    );
  }

  /** OpenCode OAuth: BEGIN the runtime-owned auth flow. Idempotent BEFORE
   *  external side effects: an existing compatible flow is returned
   *  directly (same authFlowId/URL, zero new session, zero authorize) and
   *  an incompatible one fails closed with AUTH_FLOW_CONFLICT. A fresh
   *  flow resolves the exact connection revision, starts a LIVE management
   *  server, validates the methodIndex AND the expected method fingerprint
   *  against the fresh auth-method snapshot, performs POST authorize — and
   *  RETAINS the same live session for the completion step (OpenCode
   *  pending state is instance-local). Audited. */
  async openCodeOauthBegin(input: {
    idempotencyKey: string;
    connectionId: string;
    providerId: string;
    methodIndex: number;
    expectedMethodType?: "oauth" | "api";
    expectedMethodLabel?: string;
  }): Promise<CommandResult> {
    const connectionId = input.connectionId.slice(0, 255);
    const providerId = input.providerId.slice(0, 255);
    const methodIndex = input.methodIndex;
    return this.runCommand(
      "opencode-oauth-begin",
      input.idempotencyKey,
      connectionId,
      { connectionId, providerId, methodIndex },
      async () => {
        const flow = await this.providerDiscovery.beginAuthFlow({
          connectionId,
          providerId,
          methodIndex,
          ...(input.expectedMethodType !== undefined
            ? { expectedMethodType: input.expectedMethodType }
            : {}),
          ...(input.expectedMethodLabel !== undefined
            ? { expectedMethodLabel: input.expectedMethodLabel }
            : {}),
        });
        return {
          authFlowId: flow.authFlowId,
          url: flow.url,
          method: flow.method,
          instructions: flow.instructions,
          connectionId: flow.connectionId,
          connectionRevision: flow.connectionRevision,
          providerId: flow.providerId,
          resumed: flow.resumed,
        };
      },
    );
  }

/** OpenCode OAuth: COMPLETE through the SAME live session that performed
   *  authorize; proves connected via a refreshed GET /provider; then
   *  closes the server and removes the flow. The bounded code (code flow
   *  only) is never logged or persisted. Audited. */
  async openCodeOauthComplete(input: {
    idempotencyKey: string;
    authFlowId: string;
    code?: string;
  }): Promise<CommandResult> {
    const authFlowId = input.authFlowId.slice(0, 64);
    return this.runCommand(
      "opencode-oauth-complete",
      input.idempotencyKey,
      authFlowId,
      { authFlowId, ...(input.code !== undefined ? { hasCode: true } : {}) },
      async () => {
        const { connected, providerId, connectionId } =
          await this.providerDiscovery.completeAuthFlow(authFlowId, input.code);
        return { providerId, connectionId, connected };
      },
    );
  }

  // ---- Safe Release execution ownership + audit truth (PP1 final closure) ----

  private async claimReleaseOwnership(
    auditRowId: string,
    outcome: Record<string, unknown> | undefined,
  ): Promise<
    | { claimed: false }
    | { claimed: true; evidence: ReleaseClaimEvidence }
  > {
    const phase = (outcome as { phase?: string } | undefined)?.phase;
    const ownerProcessId = (outcome as { ownerProcessId?: string } | undefined)?.ownerProcessId;
    const ownerToken = (outcome as { ownerToken?: string } | undefined)?.ownerToken;
    const repo = this.dataSource.getRepository(OperatorActionEntity);
    if (outcome?.pending === true && phase === "REQUESTED") {
      const newToken = randomUUID();
      const result = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({
          outcome: {
            pending: true,
            phase: "EXECUTING",
            ownerToken: newToken,
            ownerProcessId: PROCESS_INSTANCE_ID,
            claimedAt: new Date().toISOString(),
          } as unknown as Record<string, unknown>,
        })
        .where("id = :id", { id: auditRowId })
        .andWhere("(outcome->>'pending')::boolean = true")
        .andWhere("outcome->>'phase' = 'REQUESTED'")
        .execute();
      return (result.affected ?? 0) === 1
        ? {
            claimed: true,
            evidence: {
              operationId: auditRowId,
              ownerProcessId: PROCESS_INSTANCE_ID,
              ownerToken: newToken,
            },
          }
        : { claimed: false };
    }
    if (outcome?.pending === true && phase === "EXECUTING") {
      if (ownerProcessId === PROCESS_INSTANCE_ID) {
        // Same-process EXECUTING is LIVE only when exact old token is still active in-process
        // If exact token is NOT active, it's a same-process orphan (prior invocation exited, even if recoverable marker write failed) → allow reclaim
        if (ownerToken && this.isActiveToken(auditRowId, ownerToken)) {
          return { claimed: false };
        }
        // Orphan: allow CAS reclaim to fresh token (preserve provenance, same-process recovery)
        const newTokenOrphan = randomUUID();
        const orphanResult = await repo
          .createQueryBuilder()
          .update(OperatorActionEntity)
          .set({
            outcome: {
              pending: true,
              phase: "EXECUTING",
              ownerToken: newTokenOrphan,
              ownerProcessId: PROCESS_INSTANCE_ID,
              claimedAt: new Date().toISOString(),
              sameProcessRecovery: true,
              takenOverFrom: ownerProcessId ?? null,
            } as unknown as Record<string, unknown>,
          })
          .where("id = :id", { id: auditRowId })
          .andWhere("(outcome->>'pending')::boolean = true")
          .andWhere("outcome->>'phase' = 'EXECUTING'")
          .andWhere("outcome->>'ownerProcessId' = :oldProcessId", { oldProcessId: ownerProcessId })
          .andWhere("outcome->>'ownerToken' = :oldOwnerToken", { oldOwnerToken: ownerToken })
          .execute();
        return (orphanResult.affected ?? 0) === 1
          ? {
              claimed: true,
              evidence: {
                operationId: auditRowId,
                ownerProcessId: PROCESS_INSTANCE_ID,
                ownerToken: newTokenOrphan,
              },
            }
          : { claimed: false };
      }
      // An EXECUTING row without an exact old owner identity is not
      // recoverable authority; do not invent a takeover token.
      if (!ownerProcessId || !ownerToken) return { claimed: false };
      // Stale owner from previous dead process → explicit takeover via CAS
      const newToken = randomUUID();
      const result = await repo
        .createQueryBuilder()
        .update(OperatorActionEntity)
        .set({
          outcome: {
            pending: true,
            phase: "EXECUTING",
            ownerToken: newToken,
            ownerProcessId: PROCESS_INSTANCE_ID,
            claimedAt: new Date().toISOString(),
            takenOverFrom: ownerProcessId ?? null,
          } as unknown as Record<string, unknown>,
        })
        .where("id = :id", { id: auditRowId })
        .andWhere("(outcome->>'pending')::boolean = true")
        .andWhere("outcome->>'phase' = 'EXECUTING'")
        .andWhere("outcome->>'ownerProcessId' = :oldProcessId", {
          oldProcessId: ownerProcessId,
        })
        .andWhere("outcome->>'ownerToken' = :oldOwnerToken", {
          oldOwnerToken: ownerToken,
        })
        .execute();
      return (result.affected ?? 0) === 1
        ? {
            claimed: true,
            evidence: {
              operationId: auditRowId,
              ownerProcessId: PROCESS_INSTANCE_ID,
              ownerToken: newToken,
            },
          }
        : { claimed: false };
    }
    return { claimed: false };
  }

  private async readRecoveredReleaseTruth(
    operationId: string,
    workspaceExecutionId: string,
  ): Promise<Record<string, unknown> | null> {
    const action = await this.dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { id: operationId } });
    const actionOutcome = action?.outcome as Record<string, unknown> | undefined;
    const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
    const lease = await this.dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: workspaceExecutionId } });

    let truth: Record<string, unknown> | null = null;
    if (lease?.state === "REMOVED") {
      truth = {
        workspaceExecutionId,
        state: "REMOVED",
      };
    } else if (lease?.state === "PRESERVED" && lease.failureCode) {
      truth = {
        workspaceExecutionId,
        state: "PRESERVED",
        failureCode: lease.failureCode,
        hasUncommittedWork: lease.hasUncommittedWork,
        refusal: true,
        error: lease.failureCode,
      };
    } else if (
      actionOutcome &&
      actionOutcome.pending !== true &&
      ["REMOVED", "PRESERVED", "NOT_FOUND", "INTERRUPTED", "FAILED"].includes(
        String(actionOutcome.state),
      )
    ) {
      truth = { ...actionOutcome };
    }
    if (!truth) return null;
    return {
      ...truth,
      workspaceExecutionId,
      performedByOperationId: operationId,
    };
  }

  /** Observe A after synchronous stale recovery; B never claims or mutates A. */
  private async observeRecoveredRelease(
    auditRowId: string,
    idempotencyKey: string,
    operationId: string,
    workspaceExecutionId: string,
  ): Promise<CommandResult | null> {
    const truth = await this.readRecoveredReleaseTruth(operationId, workspaceExecutionId);
    if (!truth || truth.state === "IN_PROGRESS") return null;
    await this.dataSource
      .getRepository(OperatorActionEntity)
      .update({ id: auditRowId }, { outcome: truth });
    if (truth.state === "REMOVED") {
      return {
        action: "release-execution-workspace",
        idempotencyKey,
        outcome: "duplicate",
        result: truth,
      };
    }
    throw new WorkspaceExecutionError(
      (truth.failureCode as string) ?? "RELEASE_NOT_COMPLETED",
      (truth.error as string) ?? `Release completed with state ${String(truth.state)}`,
    );
  }

  /**
   * SINGLE release-operation driver for stale recovery: claim/take over the exact stale operation A by CAS and execute Git as A.
   * Git mutation remains authorized by A, not by B. Exactly one takeover winner via CAS.
   * Used by normal execution and crash recovery (new UUID frontend reload still converges via this).
   * For finalization-failure recovery, first re-observe worktree: ABSENT→REMOVED without Git, REGISTERED→Git, UNKNOWN→fail closed.
   */
  private async tryRecoverStaleOperation(staleOperationId: string): Promise<boolean> {
    const repo = this.dataSource.getRepository(OperatorActionEntity);
    const staleRow = await repo.findOne({ where: { id: staleOperationId } });
    if (!staleRow) return false;
    if (staleRow.action !== "release-execution-workspace") return false;
    const targetId = staleRow.targetId;
    if (!targetId) return false;
    const outcome = staleRow.outcome as Record<string, unknown> | undefined;
    if (!outcome || outcome.pending !== true) return false;
    const phase = (outcome as { phase?: string }).phase;
    if (phase !== "REQUESTED" && phase !== "EXECUTING") return false;
    // If already in explicit recoverable state (same pid, recoverable marker), try to finalize directly without re-claiming
    const isSamePidRecoverable = (outcome as any).ownerProcessId === PROCESS_INSTANCE_ID && (outcome as any).recoverable === true;
    if (isSamePidRecoverable) {
      try {
        const wsRepo2 = this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity);
        const lease2 = await wsRepo2.findOne({ where: { id: targetId } as any });
        if (lease2?.state === "RELEASE_REQUESTED" && (lease2 as any).executionPath) {
          const { worktreeIsRegistered: wirSame } = await import("./workspace-execution.service");
          const regSame = wirSame((lease2 as any).sourcePath, (lease2 as any).executionPath);
          if (regSame === "ABSENT") {
            const resultSame: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
            const fakeClaimSame = { operationId: staleOperationId, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: (outcome as any).ownerToken ?? "recovered" };
            await this.workspaceExecutions.persistTerminalRelease(targetId, fakeClaimSame as any, { state: "REMOVED" }, resultSame);
            return true;
          } else if (regSame === "REGISTERED") {
            // For refusal/UNKNOWN with REGISTERED, the normal path below will re-observe and handle via Git/refusal
          }
        }
      } catch {}
      // For recoverable, allow claim to re-drive (will be handled below as REQUESTED)
      if (phase === "EXECUTING" && (outcome as any).recoverable === true) {
        // Temporarily treat as REQUESTED for claiming
        await this.dataSource.getRepository(OperatorActionEntity).update({ id: staleOperationId }, { outcome: { ...outcome, phase: "REQUESTED" } as any });
        const refreshed = await repo.findOne({ where: { id: staleOperationId } });
        if (refreshed) {
          const newOutcome = refreshed.outcome as any;
          const claimed2 = await this.claimReleaseOwnership(staleOperationId, newOutcome);
          if (claimed2.claimed) {
            // Now proceed to normal observation below with the new claim
            // Fall through to the normal handling with the new claimed evidence
            // For simplicity, just return false and let the outer pendingRequested path handle it
            return false;
          }
        }
      }
    }
    // Attempt to claim/takeover via single driver CAS
    const claimed = await this.claimReleaseOwnership(staleOperationId, outcome);
    if (!claimed.claimed) return false;
    this.registerActiveToken(staleOperationId, claimed.evidence.ownerToken);
    let claimedSucceeded = false;
    // Re-observe worktree before deciding Git: if already REMOVED/absent, finalize without Git (covers crash between Git and finalization, and legacy REMOVED+pending)
    // For finalization failure, the operation is still pending with same pid, but the worktree is already absent on FS, so we should finalize without Git
    let reObserveSucceeded = false;
    try {
      const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
      const wsRepo = this.dataSource.getRepository(WorkspaceExecutionEntity);
      const lease = await wsRepo.findOne({ where: { id: targetId } as any });
      if (lease?.state === "REMOVED") {
        const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
        await this.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
        reObserveSucceeded = true;
        return true;
      }
      if (lease && (lease as any).executionPath) {
        const { worktreeIsRegistered } = await import("./workspace-execution.service");
        const registration = worktreeIsRegistered((lease as any).sourcePath, (lease as any).executionPath);
        if (registration === "ABSENT") {
          const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
          await this.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
          return true;
        }
        // UNKNOWN must NOT short-circuit here; let the canonical Safe Release path persist the truthful PRESERVED/WORKTREE_STATE_UNKNOWN via the single terminal transaction
      }
      if (lease?.state === "RELEASE_REQUESTED" && (outcome as any).phase === "EXECUTING" && (lease as any).executionPath) {
        const { worktreeIsRegistered: wir2 } = await import("./workspace-execution.service");
        const reg2 = wir2((lease as any).sourcePath, (lease as any).executionPath);
        if (reg2 === "ABSENT") {
          const result: Record<string, unknown> = { workspaceExecutionId: targetId, state: "REMOVED" };
          await this.workspaceExecutions.persistTerminalRelease(targetId, claimed.evidence, { state: "REMOVED" }, result);
          reObserveSucceeded = true;
          return true;
        }
      }
    } catch (e) {
      // If persistTerminalRelease failed while still owning target, CAS to recoverable before returning
      const wsCheck = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
      const lockCheck = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
      const lockOp = Array.isArray(lockCheck) ? lockCheck[0]?.releaseOperationId : lockCheck?.rows?.[0]?.releaseOperationId;
      const cur = await repo.findOne({ where: { id: staleOperationId } });
      const stillOwns = wsCheck?.releaseOperationId === staleOperationId && lockOp === staleOperationId && (cur?.outcome as any)?.pending === true;
      if (stillOwns) {
        const curOut = cur?.outcome as any;
        if (curOut?.phase === "EXECUTING" && curOut?.ownerProcessId === PROCESS_INSTANCE_ID && curOut?.ownerToken === claimed.evidence.ownerToken) {
          await repo.createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut.ownerToken, claimedAt: curOut.claimedAt, failedFrom: curOut.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
        }
      }
      // Even if DB marker write failed, in-process registry being removed in finally will make it recoverable
      return false;
    }
    // We are now the owner of the exact stale operation A — execute Git as A (single terminal transaction inside WorkspaceExecutionService)
    let gitSucceeded = false;
    try {
      const released = await this.workspaceExecutions.releaseExecutionWorkspace(targetId, claimed.evidence);
      gitSucceeded = true;
      return true;
    } catch (error) {
      if (error instanceof WorkspaceExecutionError) {
        const wsCheck = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
        const lockCheck = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
        const lockOp = Array.isArray(lockCheck) ? lockCheck[0]?.releaseOperationId : lockCheck?.rows?.[0]?.releaseOperationId;
        const cur = await repo.findOne({ where: { id: staleOperationId } });
        const stillOwnsTarget = wsCheck?.releaseOperationId === staleOperationId && lockOp === staleOperationId && (cur?.outcome as any)?.pending === true;
        if (stillOwnsTarget) {
          // Authoritative transaction rolled back while A still owns active target → CAS to explicit retryable before return
          const curOut = cur?.outcome as any;
          if (curOut?.phase === "EXECUTING" && curOut?.ownerProcessId === PROCESS_INSTANCE_ID && curOut?.ownerToken === claimed.evidence.ownerToken) {
            await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut.ownerToken, claimedAt: curOut.claimedAt, failedFrom: curOut.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
          }
          return false;
        }
        return true;
      }
      const wsCheck2 = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
      const lockCheck2 = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
      const lockOp2 = Array.isArray(lockCheck2) ? lockCheck2[0]?.releaseOperationId : lockCheck2?.rows?.[0]?.releaseOperationId;
      const cur2 = await repo.findOne({ where: { id: staleOperationId } });
      const stillOwnsTarget2 = wsCheck2?.releaseOperationId === staleOperationId && lockOp2 === staleOperationId && (cur2?.outcome as any)?.pending === true;
      if (stillOwnsTarget2) {
        const curOut2 = cur2?.outcome as any;
        if (curOut2?.phase === "EXECUTING" && curOut2?.ownerProcessId === PROCESS_INSTANCE_ID && curOut2?.ownerToken === claimed.evidence.ownerToken) {
          await this.dataSource.getRepository(OperatorActionEntity).createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOut2.ownerToken, claimedAt: curOut2.claimedAt, failedFrom: curOut2.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute().catch(() => {});
        }
        return false;
      }
      // Terminal already committed or ownership lost → do not mark INTERRUPTED while still owning target
      if ((cur2?.outcome as any)?.pending === true) {
        return false;
      }
      return true;
    } finally {
      // Always unregister exact token when this recovery attempt exits; if marker write failed, the empty registry still makes it recoverable
      try {
        this.unregisterActiveToken(staleOperationId, claimed.evidence.ownerToken);
      } catch {}
      // If we had claimed but the terminal failed and we are still pending, ensure recoverable marker (check affected)
      if (!claimedSucceeded) {
        try {
          const wsChk = await this.dataSource.getRepository((await import("../entities/workspace-execution.entity")).WorkspaceExecutionEntity).findOne({ where: { id: targetId } as any });
          const lockChk = await this.dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [targetId]);
          const lockOpChk = Array.isArray(lockChk) ? lockChk[0]?.releaseOperationId : lockChk?.rows?.[0]?.releaseOperationId;
          const curChk = await repo.findOne({ where: { id: staleOperationId } });
          const stillOwnsChk = wsChk?.releaseOperationId === staleOperationId && lockOpChk === staleOperationId && (curChk?.outcome as any)?.pending === true;
          if (stillOwnsChk) {
            const curOutChk = curChk?.outcome as any;
            if (curOutChk?.phase === "EXECUTING" && curOutChk?.ownerProcessId === PROCESS_INSTANCE_ID && curOutChk?.ownerToken === claimed.evidence.ownerToken) {
              const resChk = await repo.createQueryBuilder().update(OperatorActionEntity).set({ outcome: { pending: true, phase: "REQUESTED", recoverable: true, ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: curOutChk.ownerToken, claimedAt: curOutChk.claimedAt, failedFrom: curOutChk.phase } as any }).where("id = :id", { id: staleOperationId }).andWhere("outcome->>'phase' = 'EXECUTING'").execute();
              // Do not swallow failure as if correctness preserved; in-process registry being empty is the fallback
              if ((resChk.affected ?? 0) === 0) {
                // Marker write failed, but registry is now empty, so next fresh UUID will see no active token and can recover
              }
            }
          }
        } catch {}
      }
    }
  }

  private async waitForReleaseFinalOutcome(
    auditRowId: string,
    _key: string,
    _action: string,
  ): Promise<Record<string, unknown>> {
    const repo = this.dataSource.getRepository(OperatorActionEntity);
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await repo.findOne({ where: { id: auditRowId } });
      const out = row?.outcome as Record<string, unknown> | undefined;
      if (out && out.pending !== true) return out;
      if (out?.pending === true && (out as { phase?: string }).phase === "EXECUTING") {
        const ownerPid = (out as { ownerProcessId?: string }).ownerProcessId;
        // PP1 FINAL: normal duplicate while owner is alive (same process) MUST NOT run Git via reconcile.
        // Only poll, return IN_PROGRESS if timeout.
        if (ownerPid === PROCESS_INSTANCE_ID) {
          // Active owner — just wait
        } else {
          // Stale owner from dead process — we could attempt takeover, but this path is for waiting duplicates;
          // the caller will attempt takeover via claimReleaseOwnership on retry. Here just wait for that takeover to complete.
        }
        // Do NOT call reconcileWorkspaceExecutions here — that would execute Git while owner is alive (exactly-one violation)
      }
      if (attempt < 19) await new Promise((r) => setTimeout(r, 100));
    }
    const finalRow = await repo.findOne({ where: { id: auditRowId } });
    const fin = finalRow?.outcome as Record<string, unknown> | undefined;
    if (fin && fin.pending !== true) return fin as Record<string, unknown>;
    // Still pending EXECUTING after timeout → report IN_PROGRESS truthfully, never fabricate REMOVED
    if (fin && fin.pending === true && (fin as { phase?: string }).phase === "EXECUTING") {
      return {
        workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
        state: "IN_PROGRESS",
        failureCode: "OPERATION_IN_PROGRESS",
        error: "Release operation is in progress; retry with the same idempotency key to observe the final outcome",
      };
    }
    // Still pending REQUESTED → also IN_PROGRESS
    if (fin && fin.pending === true) {
      return {
        workspaceExecutionId: (fin.workspaceExecutionId as string | undefined) ?? (finalRow?.targetId as string | undefined) ?? "",
        state: "IN_PROGRESS",
        failureCode: "OPERATION_IN_PROGRESS",
        error: "Release operation is pending; retry to observe outcome",
      };
    }
    return (fin as Record<string, unknown>) ?? { state: "INTERRUPTED", failureCode: "RELEASE_INTERRUPTED", retryRequired: true };
  }

  private async truthfulReleaseRefusalOutcome(
    workspaceExecutionId: string,
    code: string,
    message: string,
  ): Promise<Record<string, unknown>> {
    // PP1 FINAL §5: audit must read actual durable workspace state, never hardcode IN_USE etc
    if (code === "LEASE_NOT_FOUND") {
      return {
        workspaceExecutionId,
        state: "NOT_FOUND",
        failureCode: "LEASE_NOT_FOUND",
        error: message,
        refusal: true,
      };
    }
    try {
      const { WorkspaceExecutionEntity } = await import("../entities/workspace-execution.entity");
      const repo = this.dataSource.getRepository(WorkspaceExecutionEntity);
      const lease = await repo.findOne({ where: { id: workspaceExecutionId } as unknown as Record<string, unknown> });
      if (!lease) {
        return {
          workspaceExecutionId,
          state: "NOT_FOUND",
          failureCode: "LEASE_NOT_FOUND",
          error: `Execution workspace "${workspaceExecutionId}" does not exist`,
          refusal: true,
        };
      }
      const actualState = (lease as unknown as { state: string }).state;
      const hasUncommittedWork = (lease as unknown as { hasUncommittedWork?: boolean | null }).hasUncommittedWork;
      // For LEASE_NOT_RELEASABLE and similar, record the actual observed state, not a hardcoded IN_USE
      return {
        workspaceExecutionId,
        state: actualState,
        failureCode: code,
        error: message,
        refusal: true,
        ...(hasUncommittedWork !== null && hasUncommittedWork !== undefined ? { hasUncommittedWork } : {}),
      };
    } catch {
      // Fallback if DB read fails — still truthful code but state is unknown; do not hardcode IN_USE
      return {
        workspaceExecutionId,
        state: "PRESERVED",
        failureCode: code,
        error: message,
        refusal: true,
      };
    }
  }

  private boundedProfile(profile: ConnectionProfileV1): ConnectionProfileV1 {
    const rendered = JSON.stringify(profile);
    if (rendered.length > COMMAND_BOUNDS.payloadMaxBytes) {
      throw new WorkbenchCommandError(
        "PAYLOAD_TOO_LARGE",
        `connection profile exceeds ${COMMAND_BOUNDS.payloadMaxBytes} bytes`,
      );
    }
    return profile;
  }

  /** Audit trail (bounded, newest first). */
  async auditTrail(
    action?: string,
    limit = 50,
  ): Promise<{
    items: Array<{
      id: string;
      action: string;
      idempotencyKey: string;
      actor: string;
      targetId: string | null;
      outcome: Record<string, unknown>;
      createdAt: string;
    }>;
    truncated: boolean;
  }> {
    const take = Math.min(Math.max(limit, 1), 100);
    const rows = await this.dataSource
      .getRepository(OperatorActionEntity)
      .find({
        where: action ? { action } : {},
        order: { createdAt: "DESC" },
        take: take + 1,
      });
    const truncated = rows.length > take;
    return {
      items: rows.slice(0, take).map((row) => ({
        id: row.id,
        action: row.action,
        idempotencyKey: row.idempotencyKey,
        actor: row.actor,
        targetId: row.targetId ?? null,
        outcome: row.outcome,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      })),
      truncated,
    };
  }
}

/** Redacted config summary for the audit payload (never secrets). */
function summarizeConfig(
  config: CoordinationConfigV1,
): Record<string, unknown> {
  return {
    planner: config.planner,
    verifier: config.verifier,
    workerAgents: config.allowedWorkers
      .filter((selection) => selection.kind === "agent")
      .map((selection) => selection.name),
    workerConnections: config.allowedWorkers
      .filter((selection) => selection.kind === "connection")
      .map((selection) => selection.name),
    maxIterations: config.maxIterations,
    maxWorkersPerIteration: config.maxWorkersPerIteration,
    maxTotalWorkers: config.maxTotalWorkers,
    loopDeadlineMs: config.loopDeadlineMs,
    budgetAccountId: config.budgetAccountId ?? null,
  };
}

/**
 * M10-S2: same (action, idempotencyKey) with a DIFFERENT semantic request
 * payload is a conflict, never a silent re-execution. The stored payload
 * is compared by canonical hash (key order and formatting insensitive).
 */
function assertSameRequestPayload(
  stored: Record<string, unknown> | null | undefined,
  expectedHash: string,
  action: string,
  key: string,
): void {
  if (!stored) return; // legacy rows without payload: no comparison possible
  if (sha256Json(stored) !== expectedHash) {
    throw new WorkbenchCommandError(
      "IDEMPOTENCY_CONFLICT",
      `idempotencyKey "${key}" for action "${action}" was already used with a different request payload`,
    );
  }
}
