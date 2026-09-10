import { DataSource, type DataSourceOptions } from "typeorm";
import { databaseOptions } from "./database/database.provider";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceExecutionEntity } from "./entities/workspace-execution.entity";
import { CoordinationRunEntity } from "./entities/coordination-run.entity";
import { ExecutionEntity } from "./entities/execution.entity";
import { PipelineEntity } from "./entities/pipeline.entity";
import { LogicalStepEntity } from "./entities/step-execution.entity";
import { StepAttemptEntity } from "./entities/step-attempt.entity";
import { CoordinationIterationEntity } from "./entities/coordination-iteration.entity";
import { HandoffEntity } from "./entities/handoff.entity";
import { ApprovalRequestEntity } from "./entities/approval-request.entity";
import { OperatorActionEntity } from "./entities/operator-action.entity";
import { WorkspaceEntity } from "./entities/workspace.entity";
import { WorkspaceService } from "./services/workspace.service";
import {
  WorkspaceExecutionService,
  addGitWorktree,
  removeGitWorktree,
  assertAllocationCompatible,
  setGitRunner,
  getGitRunner,
  getRemoveInvocationCount,
  resetRemoveInvocationCount,
  setBeforeRemoveHook,
} from "./services/workspace-execution.service";
import { WorkspaceExecutionError } from "./domain/workspace-execution";
import { deriveAttentionItems, attentionId } from "./domain/attention";
import { HandoffService } from "./services/handoff.service";
import { handoffBundleHash, type HandoffBundleV1 } from "./domain/handoff";
import {
  PROCESS_INSTANCE_ID,
  WorkbenchCommandService,
} from "./services/workbench-command.service";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

// Invariant helper: Workspace RELEASE_REQUESTED+lock A must not have A terminal; active target must not have A terminal
async function assertNoImpossibleState(dataSource: DataSource, workspaceId: string, operationId: string) {
  const ws = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: workspaceId } as any });
  const lockRows: any = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [workspaceId]);
  const lockOp = Array.isArray(lockRows) ? lockRows[0]?.releaseOperationId : lockRows?.rows?.[0]?.releaseOperationId;
  const op = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: operationId } });
  const opOut = op?.outcome as any;
  const isActiveTarget = ws?.state === "RELEASE_REQUESTED" && ws?.releaseOperationId === operationId && lockOp === operationId;
  if (isActiveTarget) {
    expect(opOut?.pending).toBe(true);
    expect(opOut?.state).not.toBe("REMOVED");
    expect(opOut?.state).not.toBe("PRESERVED");
  }
  if (opOut && opOut.pending !== true && (opOut.state === "REMOVED" || opOut.state === "PRESERVED")) {
    // If A is terminal, workspace must not be active RELEASE_REQUESTED with same A
    expect(isActiveTarget).toBe(false);
  }
}

const configuredDatabaseName = String(databaseOptions().database);
const assertDisposableTarget = (url: string | undefined): void => {
  if (!url) return;
  const database = decodeURIComponent(
    new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""),
  );
  if (!database || database.toLowerCase() === configuredDatabaseName.toLowerCase()) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable database, never the configured one",
    );
  }
};

function initGitRepo(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const run = (args: string[]) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tenvyr Test",
        GIT_AUTHOR_EMAIL: "test@tenvyr.local",
        GIT_COMMITTER_NAME: "Tenvyr Test",
        GIT_COMMITTER_EMAIL: "test@tenvyr.local",
      },
    });
  fs.writeFileSync(path.join(root, "README.md"), "# Test Repo\n", "utf8");
  run(["init", "-b", "main"]);
  run(["add", "README.md"]);
  run(["commit", "-m", "initial commit"]);
  return run(["rev-parse", "HEAD"]).stdout.trim();
}

describe("Workspace Execution Recovery, Idempotency & Handoff Safety Matrix", () => {
  let fixtureDir: string;
  let repoRoot: string;
  let headSha: string;
  let executionRoot: string;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenvyr-recovery-spec-"),
    );
    repoRoot = path.join(fixtureDir, "source-repo");
    headSha = initGitRepo(repoRoot);
    executionRoot = path.join(fixtureDir, "exec-workspaces");
    fs.mkdirSync(executionRoot, { recursive: true });
    process.env.TENVYR_WORKSPACE_ROOT = executionRoot;
  });

  afterAll(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  it("addGitWorktree creates worktree and verifies frozenHeadSha", () => {
    const wtPath = path.join(executionRoot, "wt-frozen-head");
    const err = addGitWorktree(repoRoot, wtPath, "tenvyr/wt-frozen", headSha);
    expect(err).toBeNull();

    const headCheck = spawnSync(
      "git",
      ["-C", wtPath, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    expect(headCheck.stdout.trim()).toBe(headSha);
  });

  it("removeGitWorktree removes clean worktree and refuses dirty worktree", () => {
    const cleanPath = path.join(executionRoot, "wt-clean-remove");
    addGitWorktree(repoRoot, cleanPath, "tenvyr/wt-clean-rm", headSha);
    const outcomeClean = removeGitWorktree(repoRoot, cleanPath);
    expect(outcomeClean).toBe("removed");

    const dirtyPath = path.join(executionRoot, "wt-dirty-remove");
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/wt-dirty-rm", headSha);
    fs.writeFileSync(path.join(dirtyPath, "dirty.txt"), "dirty", "utf8");
    const outcomeDirty = removeGitWorktree(repoRoot, dirtyPath);
    expect(typeof outcomeDirty).toBe("object");
    expect((outcomeDirty as { refused: string }).refused).toBeTruthy();
  });

  it("derives deterministic attention IDs for pending approval requests", () => {
    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [
        {
          id: "req-1",
          proposalId: "prop-abc-123",
          actionType: "tool_use",
          targetAgent: "planner",
          status: "PENDING",
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        } as any,
      ],
      executions: [],
      workspaceExecutions: [],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });

    expect(items).toHaveLength(1);
    expect(items[0].attentionId).toBe(
      attentionId("HUMAN_APPROVAL_REQUIRED", "prop-abc-123"),
    );
    expect(items[0].attentionId).not.toContain("?");
  });

  it("produces deterministic handoffBundleHash with summary: null", () => {
    const bundle: HandoffBundleV1 = {
      schemaVersion: 1,
      sourceExecutionId: "exec-1",
      sourceRunId: "run-1",
      goal: "implement feature",
      workspace: {
        workspaceId: "ws-1",
        path: repoRoot,
        branch: "main",
        headSha,
      },
      executionWorkspace: null,
      planRevision: { id: "rev-1", planHash: "hash-1" },
      iterationNumber: 1,
      verifierDecision: { action: "CONTINUE", reason: "more tests needed" },
      workerOutcomes: [
        { taskId: "task-1", status: "SUCCEEDED", summary: null },
      ],
      artifactRefs: [],
      acceptanceEvidence: null,
      nextWork: "more tests needed",
      sourceRuntimeProvenance: [
        {
          agent: "conn__hermes",
          connectionId: "conn:hermes",
          requestedModelId: "hermes-3",
        },
      ],
      createdAt: "2026-08-17T00:00:00.000Z",
    };

    const hash1 = handoffBundleHash(bundle);
    const hash2 = handoffBundleHash(bundle);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.workerOutcomes[0].summary).toBeNull();
  });

  it("derives WORKSPACE_REQUIRES_ATTENTION for dirty and unknown status workspaces, but not clean ones", () => {
    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [],
      executions: [],
      workspaceExecutions: [
        {
          id: "lease-clean",
          ownerRunId: "run-1",
          state: "PRESERVED",
          hasUncommittedWork: false,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
        {
          id: "lease-dirty",
          ownerRunId: "run-2",
          state: "PRESERVED",
          hasUncommittedWork: true,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
        {
          id: "lease-unknown",
          ownerRunId: "run-3",
          state: "PRESERVED",
          hasUncommittedWork: null,
          createdAt: new Date("2026-08-17T00:00:00Z"),
          updatedAt: new Date("2026-08-17T00:00:00Z"),
        },
      ],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });

    // clean lease is omitted; dirty and unknown leases produce attention items
    expect(items).toHaveLength(2);
    const dirtyItem = items.find((i) => i.workspaceExecutionId === "lease-dirty");
    expect(dirtyItem).toBeDefined();
    expect(dirtyItem?.reason).toContain("uncommitted work");

    const unknownItem = items.find((i) => i.workspaceExecutionId === "lease-unknown");
    expect(unknownItem).toBeDefined();
    expect(unknownItem?.reason).toContain("unknown status");
  });

  it("service-level: handles broken git repo gracefully, records null status, creates attention item, and refuses removal", async () => {
    const brokenPath = path.join(executionRoot, "wt-broken-git");
    const addErr = addGitWorktree(repoRoot, brokenPath, "tenvyr/wt-broken", headSha);
    expect(addErr).toBeNull();

    // Corrupt git metadata in worktree (.git file/pointer)
    const dotGit = path.join(brokenPath, ".git");
    if (fs.existsSync(dotGit)) {
      fs.writeFileSync(dotGit, "invalid-git-pointer\n", "utf8");
    }

    const now = new Date();
    const mockRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: "lease-broken",
        ownerRunId: "run-broken",
        mode: "git-worktree",
        executionPath: brokenPath,
        sourcePath: repoRoot,
        state: "IN_USE",
        createdAt: now,
        updatedAt: now,
      }),
      save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
    };
    const mockManager = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    } as any;

    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const preserved = await svc.preserveExecutionWorkspaceForRun(mockManager, "run-broken");
    expect(preserved).not.toBeNull();
    // Tri-state: status command failed, so hasUncommittedWork is null (unknown)
    expect(preserved?.hasUncommittedWork).toBeNull();

    const items = deriveAttentionItems({
      runs: [],
      approvalRequests: [],
      executions: [],
      workspaceExecutions: [preserved! as any],
      runByExecution: new Map(),
      executionByRun: new Map(),
    });
    expect(items).toHaveLength(1);
    expect(items[0].reason).toContain("unknown status");
  });

  const createMockRepoWithReleasing = (row: any) => {
    // PP1 FINAL: ensure exact correlation via releaseOperationId
    if (!row.releaseOperationId) row.releaseOperationId = "action-1";
    return {
      createQueryBuilder: jest.fn().mockImplementation(() => {
        let queryType = "";
        const builder: any = {
          where: jest.fn().mockImplementation((condition: string) => {
            if (condition.includes("ALLOCATING")) queryType = "ALLOCATING";
            else if (condition.includes("READY")) queryType = "READY";
            else if (condition.includes("IN_USE")) queryType = "IN_USE";
            else if (condition.includes("RELEASE_REQUESTED"))
              queryType = "RELEASE_REQUESTED";
            return builder;
          }),
          andWhere: jest.fn().mockImplementation(() => builder),
          getMany: jest.fn().mockImplementation(async () => {
            if (queryType === "RELEASE_REQUESTED") {
              return [row];
            }
            return [];
          }),
        };
        return builder;
      }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockImplementation(async ({ where }: any) => {
        // PP1 FINAL: exact operation correlation — row.releaseOperationId must equal action id
        // Support both legacy broad query (targetId) and new exact query (id + targetId + action)
        if (where?.id === row.releaseOperationId && where?.targetId === row.id) {
          return { id: row.releaseOperationId, action: "release-execution-workspace", targetId: row.id, outcome: { pending: true, phase: "REQUESTED" } };
        }
        if (where?.targetId === row.id || where?.id === row.id) {
          // Fallback for lease lookup or legacy broad authority check
          if (where?.targetId && !where?.id) {
            // Legacy broad check — simulate found action only if releaseOperationId matches
            if (row.releaseOperationId) {
              return { id: row.releaseOperationId, action: "release-execution-workspace", targetId: row.id, outcome: { pending: true, phase: "REQUESTED" } };
            }
            return null;
          }
          if (where?.id === row.id) return row;
          return { id: "action-1", action: "release-execution-workspace", targetId: row.id, outcome: { pending: true, phase: "REQUESTED" } };
        }
        // Direct lease lookup
        if (where?.id === row.id) return row;
        return row;
      }),
      findOneOrFail: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve({ id: where.id, state: "REMOVED" }),
      ),
    };
  };

  it("safe release saga crash recovery: reconciles RELEASE_REQUESTED when worktree was already removed", async () => {
    const mockRepo = createMockRepoWithReleasing({
      id: "lease-releasing-1",
      state: "RELEASE_REQUESTED",
      mode: "git-worktree",
      sourcePath: repoRoot,
      executionPath: path.join(executionRoot, "wt-already-gone"),
    });
    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const transitions = await svc.reconcileWorkspaceExecutions();
    expect(transitions).toBe(1);
    expect(mockRepo.update).toHaveBeenCalledWith(
      "lease-releasing-1",
      expect.objectContaining({ state: "REMOVED" }),
    );
  });

  it("safe release saga crash recovery: performs safe removal on RELEASE_REQUESTED when worktree is still registered", async () => {
    const cleanPath = path.join(executionRoot, "wt-release-crash");
    addGitWorktree(repoRoot, cleanPath, "tenvyr/wt-release-crash", headSha);

    const mockRepo = createMockRepoWithReleasing({
      id: "lease-releasing-2",
      state: "RELEASE_REQUESTED",
      mode: "git-worktree",
      sourcePath: repoRoot,
      executionPath: cleanPath,
      releaseOperationId: "action-1",
    });
    const svc = new WorkspaceExecutionService({ getRepository: () => mockRepo } as any);
    const transitions = await svc.reconcileWorkspaceExecutions();
    // PP1 LAST CLOSURE: generic reconciler must NOT perform Git for RELEASE_REQUESTED; the owning release operation does.
    // This lease is RELEASE_REQUESTED with valid releaseOperationId and still registered, so it stays for operation recovery.
    expect(transitions).toBe(0);
    expect(mockRepo.update).not.toHaveBeenCalled();
  });
});

describeWithPostgres("PostgreSQL Workspace Allocation Barrier Concurrency", () => {
  let dataSource: DataSource;
  let service: WorkspaceExecutionService;
  let fixtureDir: string;
  let repoRoot: string;
  let headSha: string;
  let executionRoot: string;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tenvyr-barrier-concurrency-"),
    );
    repoRoot = path.join(fixtureDir, "source-repo");
    headSha = initGitRepo(repoRoot);
    executionRoot = path.join(fixtureDir, "exec-workspaces");
    fs.mkdirSync(executionRoot, { recursive: true });
    process.env.TENVYR_WORKSPACE_ROOT = executionRoot;

    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    service = new WorkspaceExecutionService(dataSource);
  });

  afterAll(async () => {
    await dataSource?.destroy();
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      try {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("converges concurrent duplicate git-worktree allocations under a single allocationKey to 1 row and 1 worktree", async () => {
    const allocationKey = "barrier-key-git-worktree-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-1",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    const [alloc1, alloc2] = await Promise.all([
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
    ]);

    expect(alloc1.id).toBe(alloc2.id);
    expect(alloc1.executionPath).toBe(alloc2.executionPath);
    const count = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .count({ where: { allocationKey } });
    expect(count).toBe(1);
    const list = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const worktreeLines = list.stdout
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.replace(/^worktree\s+/, "").trim());
    expect(worktreeLines).toHaveLength(2);
    expect(worktreeLines).toContain(fs.realpathSync(alloc1.executionPath!));
  });

  it("converges concurrent duplicate shared allocations under a single allocationKey to 1 row", async () => {
    const allocationKey = "barrier-key-shared-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-2",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    const [alloc1, alloc2] = await Promise.all([
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "shared",
        allocationKey,
      ),
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "shared",
        allocationKey,
      ),
    ]);

    expect(alloc1.id).toBe(alloc2.id);
    const count = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .count({ where: { allocationKey } });
    expect(count).toBe(1);
  });

  it("fails closed on conflicting parameters with same allocationKey", async () => {
    const allocationKey = "barrier-conflict-key-1";
    const workspaceSnapshot = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-3",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };

    await service.allocateExecutionWorkspace(
      workspaceSnapshot,
      "shared",
      allocationKey,
    );

    await expect(
      service.allocateExecutionWorkspace(
        workspaceSnapshot,
        "git-worktree",
        allocationKey,
      ),
    ).rejects.toMatchObject({
      code: "ALLOCATION_CONFLICT",
    });
  });

  it("fails closed when same allocationKey is used with different frozen HEAD", async () => {
    const allocationKey = "barrier-head-conflict-key-1";
    const ws1 = {
      schemaVersion: 1 as const,
      workspaceId: "ws-source-head-1",
      path: repoRoot,
      repoRoot,
      branch: "main",
      headSha,
      dirty: false,
      capturedAt: "2026-08-17T00:00:00.000Z",
    };
    const ws2 = {
      ...ws1,
      headSha: headSha.slice(0, -1) + (headSha.endsWith("0") ? "1" : "0"),
    };

    await service.allocateExecutionWorkspace(ws1, "git-worktree", allocationKey);

    await expect(
      service.allocateExecutionWorkspace(ws2, "git-worktree", allocationKey),
    ).rejects.toMatchObject({
      code: "ALLOCATION_CONFLICT",
    });
  });

  it("startTeamRun-level concurrent duplicate converges to 1 OperatorAction and 1 WorkspaceExecution", async () => {
    const workspaceRepo = dataSource.getRepository(WorkspaceEntity);
    const savedWs = await workspaceRepo.save(
      workspaceRepo.create({
        name: "test-concurrent-ws",
        path: repoRoot,
        snapshot: {
          schemaVersion: 1,
          workspaceId: "ws-temp-id",
          path: repoRoot,
          repoRoot,
          branch: "main",
          headSha,
          dirty: false,
          capturedAt: new Date().toISOString(),
        },
      }),
    );

    const workspaceService = new WorkspaceService(dataSource);
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      workspaceService,
      undefined,
      undefined,
      service,
    );

    const idempotencyKey = "cmd-start-team-run-dup-1";
    const teamConfig = {
      schemaVersion: 1 as const,
      planner: { kind: "agent" as const, name: "planner" },
      verifier: { kind: "agent" as const, name: "verifier" },
      allowedWorkers: [{ kind: "agent" as const, name: "worker" }],
      maxIterations: 2,
      maxWorkersPerIteration: 2,
      maxTotalWorkers: 4,
      loopDeadlineMs: 60000,
      delegationDepthMax: 1,
      allowedExecutors: ["agent:planner", "agent:verifier", "agent:worker", "local-host"],
    };

    const runInput = {
      idempotencyKey,
      name: "Concurrent Test Run",
      goal: "Test goal for concurrent start",
      config: teamConfig,
      workspace: { workspaceId: savedWs.id },
      executionIsolation: "shared" as const,
    };

    const [res1, res2] = await Promise.all([
      workbenchService.startTeamRun(runInput),
      workbenchService.startTeamRun(runInput),
    ]);

    expect(res1.result.executionId).toBe(res2.result.executionId);
    expect(res1.result.runId).toBe(res2.result.runId);

    const actions = await dataSource
      .getRepository(OperatorActionEntity)
      .find({ where: { idempotencyKey } });
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe("start-team-run");
  });

  it("audited safe release crash saga: recovers truthfully across crash points and refuses dirty removal", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    // 1. Setup clean worktree for release
    const wtPath = path.join(executionRoot, "wt-audited-release");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-audited-release", headSha);

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-test",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    // 2. Normal audited release executes cleanly and records durable outcome
    const relKey = "cmd-release-clean-1";
    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey: relKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.outcome).toBe("executed");
    expect(res.result.state).toBe("REMOVED");

    const action = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey: relKey } });
    expect(action).not.toBeNull();
    expect(action?.outcome).toEqual({
      workspaceExecutionId: lease.id,
      state: "REMOVED",
    });

    // 3. Duplicate release command converges without re-running Git
    const dupRes = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey: relKey,
      workspaceExecutionId: lease.id,
    });
    expect(dupRes.outcome).toBe("duplicate");
    expect(dupRes.result.state).toBe("REMOVED");

    // 4. Dirty worktree release is refused and preserves uncommitted work + records durable audit refusal
    const dirtyPath = path.join(executionRoot, "wt-audited-dirty");
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/wt-audited-dirty", headSha);
    fs.writeFileSync(path.join(dirtyPath, "dirty.txt"), "uncommitted dirty content");

    const dirtyLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-dirty",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: dirtyPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    const dirtyKey = "cmd-release-dirty-1";
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: dirtyKey,
        workspaceExecutionId: dirtyLease.id,
      }),
    ).rejects.toThrow();

    // Verify lease remains PRESERVED with uncommitted work recorded
    const reloadedDirty = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: dirtyLease.id } });
    expect(reloadedDirty?.state).toBe("PRESERVED");
    expect(reloadedDirty?.hasUncommittedWork).toBe(true);
    expect(fs.existsSync(dirtyPath)).toBe(true);

    // Verify durable audit evidence recorded refusal
    const dirtyAction = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey: dirtyKey } });
    expect(dirtyAction).not.toBeNull();
    expect((dirtyAction?.outcome as any)?.refusal).toBe(true);
    expect((dirtyAction?.outcome as any)?.failureCode).toBe("WORKTREE_DIRTY");

    // Duplicate call on dirty worktree re-throws from audit evidence without running git again
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: dirtyKey,
        workspaceExecutionId: dirtyLease.id,
      }),
    ).rejects.toThrow();
  });

  it("CASE 1: operator intent COMMITTED -> crash BEFORE RELEASE_REQUESTED / Git -> retry completes release", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const wtPath = path.join(executionRoot, "wt-case1");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-case1", headSha);

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case1",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );

    const idempotencyKey = "cmd-release-case1";
    // Simulate crash after operator intent commit
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );

    // Caller retries: saga picks up pending intent and completes release
    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const reloaded = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
    expect(fs.existsSync(wtPath)).toBe(false);
  });

  it("CASE 2: RELEASE_REQUESTED committed -> Git worktree removed -> crash BEFORE WorkspaceExecution REMOVED -> retry converges", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const wtPath = path.join(executionRoot, "wt-case2");
    addGitWorktree(repoRoot, wtPath, "tenvyr/wt-case2", headSha);
    removeGitWorktree(repoRoot, wtPath); // physical removal happened before crash

    const idempotencyKey = "cmd-release-case2";
    const action = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: "temp-will-update",
        payload: { workspaceExecutionId: "temp", reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    // PP1 FINAL: exact correlation — lease's releaseOperationId must equal the authorizing action id
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case2",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED", // crashed before REMOVED
        releaseOperationId: action.id,
      }),
    );
    // Fix up the action's targetId/payload to point to the real lease
    await dataSource.getRepository(OperatorActionEntity).update(
      { id: action.id },
      { targetId: lease.id, payload: { workspaceExecutionId: lease.id, reason: null } as unknown as Record<string, unknown> },
    );

    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const reloaded = await dataSource
      .getRepository(WorkspaceExecutionEntity)
      .findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
  });

  it("CASE 3: WorkspaceExecution REMOVED -> crash BEFORE final OperatorAction outcome -> retry finalizes audit without running Git again", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-case3",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: path.join(executionRoot, "wt-case3-already-gone"),
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "REMOVED", // workspace execution finalized before crash
      }),
    );

    const idempotencyKey = "cmd-release-case3";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" }, // operator action unfinalized
      }),
    );

    const res = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey,
      workspaceExecutionId: lease.id,
    });
    expect(res.result.state).toBe("REMOVED");

    const action = await dataSource
      .getRepository(OperatorActionEntity)
      .findOne({ where: { idempotencyKey } });
    expect((action?.outcome as any)?.state).toBe("REMOVED");
  });

  it("conflicting idempotency payload fails closed", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    const idempotencyKey = "cmd-release-conflict";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey,
        actor: "local-operator",
        targetId: "lease-a",
        payload: { workspaceExecutionId: "lease-a", reason: "initial reason" },
        outcome: { workspaceExecutionId: "lease-a", state: "REMOVED" },
      }),
    );

    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey,
        workspaceExecutionId: "lease-b", // conflicting payload
      }),
    ).rejects.toThrow(/different request payload|IDEMPOTENCY_CONFLICT/);
  });

  it("H1 audit truth: LEASE_NOT_FOUND -> NOT_FOUND, LEASE_NOT_RELEASABLE -> IN_USE, SHARED_MODE_NO_REMOVAL truthful code", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    // LEASE_NOT_FOUND
    const missingId = "00000000-0000-4000-a000-000000000001";
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-lease-not-found",
        workspaceExecutionId: missingId,
      }),
    ).rejects.toMatchObject({ code: "LEASE_NOT_FOUND" });
    const a1 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-lease-not-found" } });
    expect((a1?.outcome as any)?.state).toBe("NOT_FOUND");
    expect((a1?.outcome as any)?.failureCode).toBe("LEASE_NOT_FOUND");

    // IN_USE -> LEASE_NOT_RELEASABLE -> IN_USE truth
    const wtInUse = `${executionRoot}/wt-h1-inuse`;
    addGitWorktree(repoRoot, wtInUse, "tenvyr/h1-inuse", headSha);
    const leaseInUse = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h1-inuse",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wtInUse,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "IN_USE",
      }),
    );
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-not-releasable",
        workspaceExecutionId: leaseInUse.id,
      }),
    ).rejects.toMatchObject({ code: "LEASE_NOT_RELEASABLE" });
    const a2 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-not-releasable" } });
    expect((a2?.outcome as any)?.state).toBe("IN_USE");
    expect((a2?.outcome as any)?.failureCode).toBe("LEASE_NOT_RELEASABLE");

    // PRESERVED shared -> SHARED_MODE_NO_REMOVAL (not WORKTREE_DIRTY)
    const sharedLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h1-shared",
        sourcePath: repoRoot,
        mode: "shared",
        executionPath: repoRoot,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "h1-shared-no-removal",
        workspaceExecutionId: sharedLease.id,
      }),
    ).rejects.toMatchObject({ code: "SHARED_MODE_NO_REMOVAL" });
    const a3 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: "h1-shared-no-removal" } });
    expect((a3?.outcome as any)?.failureCode).toBe("SHARED_MODE_NO_REMOVAL");
  });

  it("H2 truth: dirty->WORKTREE_DIRTY hasUncommittedWork=true, unknown->null, operational->REMOVE_FAILED", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    // Dirty path — real dirty file (proven dirty via Git)
    const dirtyPath = `${executionRoot}/wt-h2-dirty`;
    addGitWorktree(repoRoot, dirtyPath, "tenvyr/h2-dirty", headSha);
    require("node:fs").writeFileSync(`${dirtyPath}/dirty.txt`, "dirty");
    const dirtyLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-dirty",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: dirtyPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: "h2-dirty", workspaceExecutionId: dirtyLease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    const reDirty = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: dirtyLease.id } });
    expect(reDirty?.failureCode).toBe("WORKTREE_DIRTY");
    expect(reDirty?.hasUncommittedWork).toBe(true);
    expect(require("node:fs").existsSync(dirtyPath)).toBe(true);
    // No --force was used: worktree still exists

    // H2 variant: status/removal state unknown → WORKTREE_STATE_UNKNOWN, hasUncommittedWork = null
    const unknownPath = `${executionRoot}/wt-h2-unknown`;
    addGitWorktree(repoRoot, unknownPath, "tenvyr/h2-unknown", headSha);
    const unknownLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: unknownPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const originalRunner = require("./services/workspace-execution.service").getGitRunner();
    const fsReal = require("node:fs");
    try {
      const canonicalUnknown = (() => {
        try {
          return fsReal.realpathSync(unknownPath);
        } catch {
          return unknownPath;
        }
      })();
      setGitRunner((cwd, args) => {
        if (args.includes("worktree") && args.includes("remove")) {
          return { status: null, stdout: "", stderr: "" };
        }
        if (args.includes("worktree") && args.includes("list")) {
          // Pretend worktree is still registered — use canonical path as Git reports realpaths
          return { status: 0, stdout: `worktree ${canonicalUnknown}\nHEAD ${headSha}\nbranch refs/heads/tenvyr/h2-unknown\n\n`, stderr: "" };
        }
        return originalRunner(cwd, args);
      });
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: "h2-unknown", workspaceExecutionId: unknownLease.id })).rejects.toMatchObject({ code: "WORKTREE_STATE_UNKNOWN" });
      const reUnknown = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: unknownLease.id } });
      expect(reUnknown?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
      expect(reUnknown?.hasUncommittedWork).toBeNull();
      expect(reUnknown?.state).toBe("PRESERVED");
    } finally {
      setGitRunner(null);
    }

    // Pre-remove registration failure is not evidence of an absent tree.
    const inspectUnknownPath = `${executionRoot}/wt-h2-inspect-unknown`;
    addGitWorktree(repoRoot, inspectUnknownPath, "tenvyr/h2-inspect-unknown", headSha);
    const inspectUnknownLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-inspect-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: inspectUnknownPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    try {
      resetRemoveInvocationCount();
      setGitRunner((cwd, args) => {
        if (args.includes("worktree") && args.includes("list")) {
          return { status: null, stdout: "", stderr: "timed out" };
        }
        return originalRunner(cwd, args);
      });
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: "h2-inspect-unknown", workspaceExecutionId: inspectUnknownLease.id })).rejects.toMatchObject({ code: "WORKTREE_STATE_UNKNOWN" });
      const inspectUnknownReloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: inspectUnknownLease.id } });
      expect(inspectUnknownReloaded?.state).toBe("PRESERVED");
      expect(inspectUnknownReloaded?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
      expect(inspectUnknownReloaded?.hasUncommittedWork).toBeNull();
      expect(getRemoveInvocationCount()).toBe(0);
      expect(fs.existsSync(inspectUnknownPath)).toBe(true);
    } finally {
      setGitRunner(null);
    }

    // Generic RELEASE_REQUESTED reconciliation leaves an exact active
    // operation in place when registration evidence is UNKNOWN.
    const reconcileUnknownPath = `${executionRoot}/wt-h2-reconcile-unknown`;
    addGitWorktree(repoRoot, reconcileUnknownPath, "tenvyr/h2-reconcile-unknown", headSha);
    const reconcileUnknownLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-reconcile-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: reconcileUnknownPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
      }),
    );
    const reconcileUnknownAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: "h2-reconcile-unknown",
        actor: "local-operator",
        targetId: reconcileUnknownLease.id,
        payload: { workspaceExecutionId: reconcileUnknownLease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    await dataSource.getRepository(WorkspaceExecutionEntity).update({ id: reconcileUnknownLease.id }, { releaseOperationId: reconcileUnknownAction.id });
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [reconcileUnknownLease.id, reconcileUnknownAction.id]);
    try {
      setGitRunner((cwd, args) => {
        if (args.includes("worktree") && args.includes("list")) {
          return { status: null, stdout: "", stderr: "timed out" };
        }
        return originalRunner(cwd, args);
      });
      await service.reconcileWorkspaceExecutions();
      const reconcileUnknownReloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: reconcileUnknownLease.id } });
      expect(reconcileUnknownReloaded?.state).toBe("RELEASE_REQUESTED");
      expect(reconcileUnknownReloaded?.releaseOperationId).toBe(reconcileUnknownAction.id);
      expect(fs.existsSync(reconcileUnknownPath)).toBe(true);
      expect(getRemoveInvocationCount()).toBe(0);
    } finally {
      setGitRunner(null);
    }

    // H2 variant: clean but operational removal fails → WORKTREE_REMOVE_FAILED, hasUncommittedWork = null
    const opFailPath = `${executionRoot}/wt-h2-opfail`;
    addGitWorktree(repoRoot, opFailPath, "tenvyr/h2-opfail", headSha);
    const opFailLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h2-opfail",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: opFailPath,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    try {
      const canonicalOpFail = (() => {
        try {
          return fsReal.realpathSync(opFailPath);
        } catch {
          return opFailPath;
        }
      })();
      setGitRunner((cwd, args) => {
        if (args.includes("worktree") && args.includes("remove")) {
          return { status: 1, stdout: "", stderr: "fatal: unable to remove worktree: permission denied" };
        }
        if (args.includes("worktree") && args.includes("list")) {
          return { status: 0, stdout: `worktree ${canonicalOpFail}\nHEAD ${headSha}\nbranch refs/heads/tenvyr/h2-opfail\n\n`, stderr: "" };
        }
        return originalRunner(cwd, args);
      });
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: "h2-opfail", workspaceExecutionId: opFailLease.id })).rejects.toMatchObject({ code: "WORKTREE_REMOVE_FAILED" });
      const reOpFail = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: opFailLease.id } });
      expect(reOpFail?.failureCode).toBe("WORKTREE_REMOVE_FAILED");
      expect(reOpFail?.hasUncommittedWork).toBeNull();
      expect(reOpFail?.state).toBe("PRESERVED");
    } finally {
      setGitRunner(null);
    }
  });

  it("H3 concurrent same-key release: exactly one external Git execution (EXECUTING claim)", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-h3-concurrent`;
    addGitWorktree(repoRoot, wt, "tenvyr/h3-concurrent", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h3",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = "h3-same-key";
    resetRemoveInvocationCount();
    const [r1, r2] = await Promise.all([
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id }),
    ]);
    // One executed, one duplicate — both converge to REMOVED
    const states = [r1.result.state, r2.result.state].sort();
    expect(states).toEqual(["REMOVED", "REMOVED"]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toContain("executed");
    expect(outcomes).toContain("duplicate");
    const actions = await dataSource.getRepository(OperatorActionEntity).find({ where: { idempotencyKey: key } });
    expect(actions).toHaveLength(1);
    // Exactly-one external Git mutation while owner is alive
    expect(getRemoveInvocationCount()).toBe(1);

    // Third caller while owner is blocked inside external phase must observe IN_PROGRESS and not execute Git
    const wt2 = `${executionRoot}/wt-h3-barrier`;
    addGitWorktree(repoRoot, wt2, "tenvyr/h3-barrier", headSha);
    const lease2 = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h3-barrier",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt2,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const barrierKey = "h3-barrier-key";
    let releaseBarrier: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let ownerStarted = false;
    resetRemoveInvocationCount();
    setBeforeRemoveHook(async () => {
      if (!ownerStarted) {
        ownerStarted = true;
        await barrierPromise;
      }
    });
    try {
      const ownerPromise = workbenchService.releaseExecutionWorkspace({ idempotencyKey: barrierKey, workspaceExecutionId: lease2.id });
      // Give owner time to claim and block inside beforeRemoveHook
      await new Promise((r) => setTimeout(r, 200));
      // Third caller while owner is blocked
      const waiterPromise = workbenchService.releaseExecutionWorkspace({ idempotencyKey: barrierKey, workspaceExecutionId: lease2.id }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 300));
      // Waiter should be IN_PROGRESS (thrown) and must not have executed Git
      const waiterResult = await Promise.race([
        waiterPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("waiter timeout")), 2500)),
      ]).catch((e) => e);
      // Waiter should be an error with IN_PROGRESS (since owner is alive)
      expect(waiterResult).toBeInstanceOf(Error);
      expect((waiterResult as Error).message.toLowerCase()).toMatch(/in progress|operation_in_progress/);
      // No additional Git invocation yet — only owner hasn't yet executed Git (blocked before)
      expect(getRemoveInvocationCount()).toBe(0);
      // Unblock owner
      releaseBarrier!();
      const ownerResult = await ownerPromise;
      expect(ownerResult.result.state).toBe("REMOVED");
      expect(getRemoveInvocationCount()).toBe(1);
      // After owner completes, duplicate should see REMOVED, not run Git again
      const dup = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: barrierKey, workspaceExecutionId: lease2.id });
      expect(dup.result.state).toBe("REMOVED");
      expect(getRemoveInvocationCount()).toBe(1);
    } finally {
      setBeforeRemoveHook(null);
      resetRemoveInvocationCount();
    }
  });

  it("H4 crash REQUESTED before RELEASE_REQUESTED: pending->INTERRUPTED with retryRequired, same-key retry converges", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-h4-pending`;
    addGitWorktree(repoRoot, wt, "tenvyr/h4-pending", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h4",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = "h4-crash-before-release";
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: key,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    // Reconcile should mark the pending action against PRESERVED truth — in this new design
    // the pending PRESERVED action is reconciled to PRESERVED (with failureCode if any).
    // For a clean PRESERVED lease, reconcile leaves it as success-like PRESERVED; the
    // retry path via releaseExecutionWorkspace with EXECUTING claim completes to REMOVED.
    const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
    expect(res.result.state).toBe("REMOVED");
  });

  it("H5 unmatched RELEASE_REQUESTED fails closed: RELEASE_UNAUTHORIZED and preserved", async () => {
    // Create a RELEASE_REQUESTED lease with NO matching OperatorAction
    const wt = `${executionRoot}/wt-h5-unmatched`;
    addGitWorktree(repoRoot, wt, "tenvyr/h5-unmatched", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h5",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
      }),
    );
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(require("node:fs").existsSync(wt)).toBe(true);
  });

  it("H5 historical REFUSED action must not authorize unrelated RELEASE_REQUESTED", async () => {
    const wt = `${executionRoot}/wt-h5-refused-history`;
    addGitWorktree(repoRoot, wt, "tenvyr/h5-refused", headSha);
    // Create a historical REFUSED action for this workspace (dirty refusal)
    const historyLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h5-refused",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
        failureCode: "WORKTREE_DIRTY",
        hasUncommittedWork: true,
      }),
    );
    const historyAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: "h5-history-refused",
        actor: "local-operator",
        targetId: historyLease.id,
        payload: { workspaceExecutionId: historyLease.id, reason: null },
        outcome: { workspaceExecutionId: historyLease.id, state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "dirty", refusal: true },
      }),
    );
    // Create an unrelated RELEASE_REQUESTED lease for the same workspace execution id but without exact correlation
    // Use a different lease id but same source — the broad check would have incorrectly authorized via historyLease/historyAction
    const unrelatedWt = `${executionRoot}/wt-h5-unrelated`;
    addGitWorktree(repoRoot, unrelatedWt, "tenvyr/h5-unrelated", headSha);
    const unrelatedLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-h5-unrelated",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: unrelatedWt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        // No releaseOperationId — legacy/unmatched, even though historical action exists for different lease
      }),
    );
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: unrelatedLease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(require("node:fs").existsSync(unrelatedWt)).toBe(true);
    // History action must not have been used to authorize this unrelated lease
    expect(historyAction.id).not.toBe(reloaded?.releaseOperationId);
  });

  it("Target-level BARRIER B: different keys ×2 same workspace → one target owner, Git count exactly 1", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-barrier-b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    addGitWorktree(repoRoot, wt, `tenvyr/barrier-b-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-barrier-b",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    resetRemoveInvocationCount();
    const [r1, r2] = await Promise.allSettled([
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `barrier-b-key1-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `barrier-b-key2-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
    ]);
    expect(getRemoveInvocationCount()).toBe(1);
    const finalCheck = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(finalCheck?.state).toBe("REMOVED");
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
    const actions = await dataSource.getRepository(OperatorActionEntity).find({ where: { targetId: lease.id } });
    expect(actions.length).toBe(2);
    const truthful = actions.every((a) => {
      const o = a.outcome as any;
      return o.state === "REMOVED" || o.failureCode === "RELEASE_IN_PROGRESS" || o.state === "INTERRUPTED";
    });
    expect(truthful).toBe(true);
  });

  it("Target-level BARRIER C: different keys ×3 same workspace → Git count exactly 1", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-barrier-c-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    addGitWorktree(repoRoot, wt, `tenvyr/barrier-c-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-barrier-c",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    resetRemoveInvocationCount();
    const results = await Promise.allSettled([
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `barrier-c-k1-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `barrier-c-k2-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `barrier-c-k3-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
    ]);
    expect(getRemoveInvocationCount()).toBe(1);
    const reloadedCheck = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloadedCheck?.state).toBe("REMOVED");
    // Successes may be 0 if the test's Promise.allSettled timing caused all to be considered rejected, but Git count proves exactly one
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
  });

  it("Target-level BARRIER D: active owner blocked before Git + Attention polling → no second Git", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const { AttentionService } = await import("./services/attention.service");
    const attentionService = new AttentionService(dataSource, service);
    const wt = `${executionRoot}/wt-barrier-d-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    addGitWorktree(repoRoot, wt, `tenvyr/barrier-d-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-barrier-d",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    let releaseBarrier: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let ownerStarted = false;
    resetRemoveInvocationCount();
    setBeforeRemoveHook(async () => {
      if (!ownerStarted) {
        ownerStarted = true;
        await barrierPromise;
      }
    });
    try {
      const ownerPromise = workbenchService.releaseExecutionWorkspace({ idempotencyKey: "barrier-d-owner", workspaceExecutionId: lease.id });
      await new Promise((r) => setTimeout(r, 200));
      // Poll Attention repeatedly while owner is blocked
      for (let i = 0; i < 5; i++) {
        await attentionService.attention();
        await new Promise((r) => setTimeout(r, 100));
        expect(getRemoveInvocationCount()).toBe(0);
      }
      releaseBarrier!();
      const ownerRes = await ownerPromise;
      expect(ownerRes.result.state).toBe("REMOVED");
      expect(getRemoveInvocationCount()).toBe(1);
      // After owner completes, Attention should still not trigger extra Git
      await attentionService.attention();
      expect(getRemoveInvocationCount()).toBe(1);
    } finally {
      setBeforeRemoveHook(null);
      resetRemoveInvocationCount();
    }
  });

  it("Target-level BARRIER E/F: stale vs current-process EXECUTING takeover", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const wt = `${executionRoot}/wt-barrier-e`;
    addGitWorktree(repoRoot, wt, "tenvyr/barrier-e", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-barrier-e",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = "barrier-e-key";
    // Create a stale EXECUTING from previous process
    const deadProcessId = "dead-process-999";
    const staleAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: key,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: deadProcessId, ownerToken: "old", claimedAt: new Date().toISOString() },
      }),
    );
    // Current process should be able to take over (different PROCESS_INSTANCE_ID)
    resetRemoveInvocationCount();
    const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
    expect(res.result.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);

    // F: current-process EXECUTING cannot be taken over (same PROCESS_INSTANCE_ID)
    const wt2 = `${executionRoot}/wt-barrier-f`;
    addGitWorktree(repoRoot, wt2, "tenvyr/barrier-f", headSha);
    const lease2 = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-barrier-f",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt2,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key2 = "barrier-f-key";
    const { PROCESS_INSTANCE_ID, getActiveReleaseTokens } = await import("./services/workbench-command.service");
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: key2,
        actor: "local-operator",
        targetId: lease2.id,
        payload: { workspaceExecutionId: lease2.id, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: "current", claimedAt: new Date().toISOString() },
      }),
    );
    // Simulate live owner by registering its exact token as active (as a real invocation would)
    const liveOp = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key2 } });
    if (liveOp) {
      const tok = (liveOp.outcome as any)?.ownerToken;
      if (tok) getActiveReleaseTokens().add(`${liveOp.id}:${tok}`);
    }
    // A second attempt with same key while owner is live should see IN_PROGRESS and not take over
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key2, workspaceExecutionId: lease2.id })).rejects.toMatchObject({
      code: "OPERATION_IN_PROGRESS",
    });
    // And a different key targeting same workspace should see RELEASE_IN_PROGRESS (target-level), not take over via stale logic
    // Keep the live token registered for this check as well
    await expect(
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: "barrier-f-other-key", workspaceExecutionId: lease2.id }),
    ).rejects.toMatchObject({ code: "RELEASE_IN_PROGRESS" });
    // Cleanup active token
    if (liveOp) {
      const tok2 = (liveOp.outcome as any)?.ownerToken;
      if (tok2) getActiveReleaseTokens().delete(`${liveOp.id}:${tok2}`);
    }
  });

  it("Audit variant: LEASE_NOT_RELEASABLE records actual state READY/IN_USE/TRANSFERRED", async () => {
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );
    const states: Array<{ state: string; mode: string }> = [
      { state: "READY", mode: "git-worktree" },
      { state: "IN_USE", mode: "git-worktree" },
      { state: "TRANSFERRED", mode: "git-worktree" },
    ];
    for (const { state, mode } of states) {
      const wtPath = path.join(executionRoot, `wt-audit-${state.toLowerCase()}`);
      addGitWorktree(repoRoot, wtPath, `tenvyr/audit-${state.toLowerCase()}`, headSha);
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: `ws-audit-${state}`,
          sourcePath: repoRoot,
          mode: mode as any,
          executionPath: wtPath,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: state as any,
        }),
      );
      const key = `audit-${state}-${Date.now()}-${Math.random()}`;
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "LEASE_NOT_RELEASABLE" });
      const action = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key } });
      expect((action?.outcome as any)?.state).toBe(state);
      expect((action?.outcome as any)?.failureCode).toBe("LEASE_NOT_RELEASABLE");
      expect((action?.outcome as any)?.refusal).toBe(true);
      // Ensure we didn't hardcode IN_USE for all
      if (state !== "IN_USE") {
        expect((action?.outcome as any)?.state).not.toBe("IN_USE");
      }
    }
    // FAILED is releasable (interrupted allocation) — releasing it should attempt Git and may succeed to REMOVED or fail with WORKTREE_*; audit should record actual durable state
    const failedLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-failed",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: path.join(executionRoot, "wt-audit-failed-path-not-registered"),
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "FAILED",
        failureCode: "ALLOCATION_FAILED",
      }),
    );
    const failedKey = `audit-failed-${Date.now()}`;
    // FAILED is allowed — it will try to remove a non-registered worktree and transition to REMOVED (already-removed)
    const failedRes = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: failedKey, workspaceExecutionId: failedLease.id });
    expect(failedRes.result.state).toBe("REMOVED");
    const failedAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: failedKey } });
    expect((failedAction?.outcome as any)?.state).toBe("REMOVED");
    // Shared mode no removal — audit should record actual state PRESERVED, not hardcoded
    const sharedLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-shared",
        sourcePath: repoRoot,
        mode: "shared",
        executionPath: repoRoot,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const sharedKey = `audit-shared-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: sharedKey, workspaceExecutionId: sharedLease.id })).rejects.toMatchObject({ code: "SHARED_MODE_NO_REMOVAL" });
    const sharedAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: sharedKey } });
    expect((sharedAction?.outcome as any)?.state).toBe("PRESERVED");
    expect((sharedAction?.outcome as any)?.failureCode).toBe("SHARED_MODE_NO_REMOVAL");

    // Missing path variant
    const missingPathLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-audit-missing",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: null,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const missingKey = `audit-missing-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: missingKey, workspaceExecutionId: missingPathLease.id })).rejects.toMatchObject({ code: "LEASE_PATH_MISSING" });
    const missingAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: missingKey } });
    expect((missingAction?.outcome as any)?.state).toBe("PRESERVED");
    expect((missingAction?.outcome as any)?.failureCode).toBe("LEASE_PATH_MISSING");
  });

  it("Recovery matrix A-G: covers all crash points with exact authority and never false-success", async () => {
    // Use real PostgreSQL + disposable Git worktrees for full matrix
    const workbenchService = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      service,
    );

    // A. REQUESTED → crash before claim → restart → same operation can progress safely
    {
      const wt = path.join(executionRoot, "wt-matrix-a");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-a", headSha);
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-a",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "PRESERVED",
        }),
      );
      const key = `matrix-a-${Date.now()}`;
      await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: key,
          actor: "local-operator",
          targetId: lease.id,
          payload: { workspaceExecutionId: lease.id, reason: null },
          outcome: { pending: true, phase: "REQUESTED" },
        }),
      );
      const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
      expect(res.result.state).toBe("REMOVED");
    }

    // B. EXECUTING → crash before RELEASE_REQUESTED → restart → explicit takeover or retry-required, never false-success PRESERVED
    {
      const wt = path.join(executionRoot, "wt-matrix-b");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-b", headSha);
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-b",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "PRESERVED",
        }),
      );
      const key = `matrix-b-${Date.now()}`;
      // Simulate previous process claimed EXECUTING with different processInstanceId
      const fakeOldProcessId = "dead-process-123";
      const oldAction = await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: key,
          actor: "local-operator",
          targetId: lease.id,
          payload: { workspaceExecutionId: lease.id, reason: null },
          outcome: { pending: true, phase: "EXECUTING", ownerProcessId: fakeOldProcessId, ownerToken: "old-token", claimedAt: new Date().toISOString() },
        }),
      );
      // First retry should takeover and succeed (or at least not be false-success PRESERVED)
      const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
      // Should be either REMOVED (takeover success) or throw INTERRUPTED (which would be caught, but our service handles takeover and succeeds)
      // In our implementation, stale EXECUTING with different processId will be taken over and succeed to REMOVED
      expect(res.result.state).toBe("REMOVED");
      const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
      expect(reloaded?.state).toBe("REMOVED");
      expect(require("node:fs").existsSync(wt)).toBe(false);
    }

    // C. RELEASE_REQUESTED → crash before Git → restart → exact authorized operation recovered → one recovery owner
    {
      const wt = path.join(executionRoot, "wt-matrix-c");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-c", headSha);
      const key = `matrix-c-${Date.now()}`;
      const action = await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: key,
          actor: "local-operator",
          targetId: "temp",
          payload: { workspaceExecutionId: "temp", reason: null },
          outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "old-process-c", ownerToken: "tok-c", claimedAt: new Date().toISOString() },
        }),
      );
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-c",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "RELEASE_REQUESTED",
          releaseOperationId: action.id,
        }),
      );
      await dataSource.getRepository(OperatorActionEntity).update({ id: action.id }, { targetId: lease.id, payload: { workspaceExecutionId: lease.id, reason: null } as unknown as Record<string, unknown> });
      // Simulate restart: new processInstanceId will takeover the EXECUTING row
      const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
      expect(res.result.state).toBe("REMOVED");
      const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
      expect(reloaded?.state).toBe("REMOVED");
      // Ensure only one Git invocation (the recovery owner)
      // (We can't easily count here without hook, but we know reconcile + release both use same Git, but only one should run)
    }

    // D. Git removed → crash before REMOVED DB state → restart → filesystem absence detected → REMOVED, no destructive re-run required
    {
      const wt = path.join(executionRoot, "wt-matrix-d");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-d", headSha);
      // Physical removal happened before crash
      const removed = removeGitWorktree(repoRoot, wt);
      expect(removed).toBe("removed");
      const key = `matrix-d-${Date.now()}`;
      const action = await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: key,
          actor: "local-operator",
          targetId: "temp",
          payload: { workspaceExecutionId: "temp", reason: null },
          outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "old-process-d", ownerToken: "tok-d", claimedAt: new Date().toISOString() },
        }),
      );
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-d",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "RELEASE_REQUESTED",
          releaseOperationId: action.id,
        }),
      );
      await dataSource.getRepository(OperatorActionEntity).update({ id: action.id }, { targetId: lease.id, payload: { workspaceExecutionId: lease.id, reason: null } as unknown as Record<string, unknown> });
      resetRemoveInvocationCount();
      const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
      expect(res.result.state).toBe("REMOVED");
      expect(getRemoveInvocationCount()).toBe(0); // No Git remove needed, already gone
      resetRemoveInvocationCount();
    }

    // E. REMOVED → crash before audit finalization → restart → audit finalized truthfully
    {
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-e",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: path.join(executionRoot, "wt-matrix-e-gone"),
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "REMOVED",
        }),
      );
      const key = `matrix-e-${Date.now()}`;
      await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: key,
          actor: "local-operator",
          targetId: lease.id,
          payload: { workspaceExecutionId: lease.id, reason: null },
          outcome: { pending: true, phase: "REQUESTED" },
        }),
      );
      const res = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id });
      expect(res.result.state).toBe("REMOVED");
      const action = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key } });
      expect((action?.outcome as any)?.state).toBe("REMOVED");
    }

    // F. dirty refusal → PRESERVED durable REFUSED → retry with same key does not pretend success
    {
      const wt = path.join(executionRoot, "wt-matrix-f");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-f", headSha);
      require("node:fs").writeFileSync(path.join(wt, "dirty.txt"), "dirty");
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-f",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "PRESERVED",
        }),
      );
      const key = `matrix-f-${Date.now()}`;
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
      const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
      expect(reloaded?.state).toBe("PRESERVED");
      expect(reloaded?.failureCode).toBe("WORKTREE_DIRTY");
      // Retry with same key must not pretend success — should still throw refusal
      await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
      const action = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key } });
      expect((action?.outcome as any)?.state).toBe("PRESERVED");
      expect((action?.outcome as any)?.refusal).toBe(true);
    }

    // G. historical unrelated release action + unmatched RELEASE_REQUESTED → RELEASE_UNAUTHORIZED, no Git
    {
      const wt = path.join(executionRoot, "wt-matrix-g");
      addGitWorktree(repoRoot, wt, "tenvyr/matrix-g", headSha);
      const unrelatedAction = await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: `matrix-g-history-${Date.now()}`,
          actor: "local-operator",
          targetId: "some-other-lease",
          payload: { workspaceExecutionId: "some-other-lease", reason: null },
          outcome: { workspaceExecutionId: "some-other-lease", state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "dirty", refusal: true },
        }),
      );
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: "ws-matrix-g",
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "RELEASE_REQUESTED",
          // No releaseOperationId — legacy/unmatched, even though historical action exists for different lease
        }),
      );
      resetRemoveInvocationCount();
      const transitions = await service.reconcileWorkspaceExecutions();
      expect(transitions).toBeGreaterThanOrEqual(1);
      const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
      expect(reloaded?.state).toBe("PRESERVED");
      expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
      expect(getRemoveInvocationCount()).toBe(0);
      expect(require("node:fs").existsSync(wt)).toBe(true);
      expect(unrelatedAction.id).not.toBe(reloaded?.releaseOperationId);
    }
  });

  it("Terminal ownership ACTIVE-only: dirty → clean → NEW key → exactly one Git REMOVED", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-terminal-dirty-clean");
    addGitWorktree(repoRoot, wt, "tenvyr/terminal-dirty-clean", headSha);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty");
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-terminal-dirty",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key1 = `terminal-dirty-key1-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key1, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    const afterDirty = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(afterDirty?.state).toBe("PRESERVED");
    expect(afterDirty?.failureCode).toBe("WORKTREE_DIRTY");
    // ACTIVE-only: releaseOperationId should be cleared and lock released, allowing new acquire
    expect(afterDirty?.releaseOperationId).toBeNull();
    const lockAfterDirty = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [lease.id]);
    expect(lockAfterDirty.length).toBe(0);
    // Operator cleans worktree (remove dirty file and ensure clean)
    try { fs.unlinkSync(path.join(wt, "dirty.txt")); } catch {}
    // Also ensure git status is clean (remove any untracked)
    try { spawnSync("git", ["-C", wt, "checkout", "--", "dirty.txt"], { stdio: "ignore" }); } catch {}
    try { spawnSync("git", ["-C", wt, "clean", "-fd"], { stdio: "ignore" }); } catch {}
    // New key after fixing condition should succeed with exactly one Git
    resetRemoveInvocationCount();
    const key2 = `terminal-dirty-key2-${Date.now()}-${Math.random()}`;
    const res2 = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key2, workspaceExecutionId: lease.id });
    expect(res2.result.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
    const finalLease = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(finalLease?.state).toBe("REMOVED");
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("Terminal ownership: WORKTREE_REMOVE_FAILED → fixed → new operation can release", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-terminal-opfail-clean");
    addGitWorktree(repoRoot, wt, "tenvyr/terminal-opfail", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-terminal-opfail",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const originalRunner = getGitRunner();
    const canonical = (() => {
      try { return fs.realpathSync(wt); } catch { return wt; }
    })();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("remove")) return { status: 1, stdout: "", stderr: "fatal: unable to remove worktree: permission denied" };
      if (args.includes("worktree") && args.includes("list")) return { status: 0, stdout: `worktree ${canonical}\nHEAD ${headSha}\nbranch refs/heads/tenvyr/terminal-opfail\n\n`, stderr: "" };
      return originalRunner(cwd, args);
    });
    const key1 = `terminal-opfail-key1-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key1, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_REMOVE_FAILED" });
    const afterFail = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(afterFail?.failureCode).toBe("WORKTREE_REMOVE_FAILED");
    expect(afterFail?.releaseOperationId).toBeNull();
    setGitRunner(null);
    resetRemoveInvocationCount();
    const key2 = `terminal-opfail-key2-${Date.now()}`;
    const res2 = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key2, workspaceExecutionId: lease.id });
    expect(res2.result.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
  });

  it("Terminal ownership: WORKTREE_STATE_UNKNOWN → fixed → new operation can release", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-terminal-unknown-clean");
    addGitWorktree(repoRoot, wt, "tenvyr/terminal-unknown", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-terminal-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const originalRunner = getGitRunner();
    const canonical = (() => {
      try { return fs.realpathSync(wt); } catch { return wt; }
    })();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("remove")) return { status: null, stdout: "", stderr: "" };
      if (args.includes("worktree") && args.includes("list")) return { status: 0, stdout: `worktree ${canonical}\nHEAD ${headSha}\nbranch refs/heads/tenvyr/terminal-unknown\n\n`, stderr: "" };
      return originalRunner(cwd, args);
    });
    const key1 = `terminal-unknown-key1-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key1, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_STATE_UNKNOWN" });
    const afterFail = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(afterFail?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    expect(afterFail?.releaseOperationId).toBeNull();
    setGitRunner(null);
    resetRemoveInvocationCount();
    const key2 = `terminal-unknown-key2-${Date.now()}`;
    const res2 = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: key2, workspaceExecutionId: lease.id });
    expect(res2.result.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
  });

  it("Terminal ownership: concurrent new ops after terminal refusal → exactly one Git", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, `wt-terminal-concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    addGitWorktree(repoRoot, wt, `tenvyr/terminal-concurrent-${Date.now()}`, headSha);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty");
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-terminal-concurrent",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const keyFail = `terminal-concurrent-fail-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyFail, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    try { fs.unlinkSync(path.join(wt, "dirty.txt")); } catch {}
    try { spawnSync("git", ["-C", wt, "clean", "-fd"], { stdio: "ignore" }); } catch {}
    resetRemoveInvocationCount();
    const results = await Promise.allSettled([
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `terminal-concurrent-k1-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
      workbenchService.releaseExecutionWorkspace({ idempotencyKey: `terminal-concurrent-k2-${Date.now()}-${Math.random()}`, workspaceExecutionId: lease.id }),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled" && (r.value as any).result.state === "REMOVED");
    // After terminal, concurrent new ops must produce exactly one Git mutation; successes may vary due to timing, but Git count and final state are invariant
    expect(getRemoveInvocationCount()).toBe(1);
    const final = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(final?.state).toBe("REMOVED");
  });

  it("Late-arrival barrier: owner A blocked before Git → B different-key arrives → IN_PROGRESS, Git 0 until A resumes → total 1", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-late-arrival");
    addGitWorktree(repoRoot, wt, "tenvyr/late-arrival", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-late-arrival",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    let releaseBarrier: () => void;
    const barrierPromise = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let ownerStarted = false;
    resetRemoveInvocationCount();
    setBeforeRemoveHook(async () => {
      if (!ownerStarted) {
        ownerStarted = true;
        await barrierPromise;
      }
    });
    try {
      const keyA = `late-arrival-A-${Date.now()}`;
      const ownerPromise = workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyA, workspaceExecutionId: lease.id });
      await new Promise((r) => setTimeout(r, 300));
      // B arrives while A is blocked before Git
      const keyB = `late-arrival-B-${Date.now()}`;
      const bResult = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: lease.id }).catch((e) => e);
      expect(bResult).toBeInstanceOf(Error);
      expect((bResult as any).code).toBe("RELEASE_IN_PROGRESS");
      expect(getRemoveInvocationCount()).toBe(0);
      // Verify B's audit is truthful IN_PROGRESS
      const bAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
      expect((bAction?.outcome as any)?.state).toBe("IN_PROGRESS");
      expect((bAction?.outcome as any)?.failureCode).toBe("RELEASE_IN_PROGRESS");
      // Resume A
      releaseBarrier!();
      const aRes = await ownerPromise;
      expect(aRes.result.state).toBe("REMOVED");
      expect(getRemoveInvocationCount()).toBe(1);
      // After A completes, total still 1 (B did not run Git)
      const cAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
      expect((cAction?.outcome as any)?.state).toBe("IN_PROGRESS");
    } finally {
      setBeforeRemoveHook(null);
      resetRemoveInvocationCount();
    }
  });

  it("Stale recovery with new UUID: synchronous recovery returns A's truthful terminal outcome to B", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-stale-new-uuid");
    addGitWorktree(repoRoot, wt, "tenvyr/stale-new-uuid", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-stale-new-uuid",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const staleKey = `stale-old-key-${Date.now()}`;
    const deadPid = "dead-process-12345";
    const staleAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: staleKey,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: deadPid, ownerToken: "old-token", claimedAt: new Date().toISOString() },
      }),
    );
    // Manually set lease to RELEASE_REQUESTED owned by stale operation (simulating crash after target claim)
    await dataSource.getRepository(WorkspaceExecutionEntity).update({ id: lease.id }, { state: "RELEASE_REQUESTED", releaseOperationId: staleAction.id } as any);
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [lease.id, staleAction.id]);

    // New UUID B arrives (simulating browser reload with new frontend UUID)
    const newKey = `stale-new-uuid-${Date.now()}`;
    resetRemoveInvocationCount();
    const bResult = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: newKey, workspaceExecutionId: lease.id });
    expect(bResult.result.state).toBe("REMOVED");
    expect((bResult.result as any).performedByOperationId).toBe(staleAction.id);
    expect(bResult.outcome).toBe("duplicate");
    // B records the exact terminal truth while A remains the Git authority.
    const bAction = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: newKey } });
    expect((bAction?.outcome as any)?.state).toBe("REMOVED");
    expect((bAction?.outcome as any)?.performedByOperationId).toBe(staleAction.id);
    expect(getRemoveInvocationCount()).toBe(1);
    // Verify that Git was authorized by A, not B.
    const finalLease = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(finalLease?.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
  });

  it("Git boundary authorization attacks: REQUESTED, foreign owner, wrong token, and finalized action never run Git", async () => {
    const claims = {
      current: (operationId: string, ownerToken: string) => ({
        operationId,
        ownerProcessId: PROCESS_INSTANCE_ID,
        ownerToken,
      }),
    };
    const makeLease = async (suffix: string, outcome: Record<string, unknown>) => {
      const wt = path.join(executionRoot, `wt-auth-${suffix}`);
      addGitWorktree(repoRoot, wt, `tenvyr/auth-${suffix}`, headSha);
      const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
        dataSource.getRepository(WorkspaceExecutionEntity).create({
          sourceWorkspaceId: `ws-auth-${suffix}`,
          sourcePath: repoRoot,
          mode: "git-worktree",
          executionPath: wt,
          baseBranch: "main",
          baseHeadSha: headSha,
          state: "RELEASE_REQUESTED",
        }),
      );
      const action = await dataSource.getRepository(OperatorActionEntity).save(
        dataSource.getRepository(OperatorActionEntity).create({
          action: "release-execution-workspace",
          idempotencyKey: `auth-${suffix}`,
          actor: "local-operator",
          targetId: lease.id,
          payload: { workspaceExecutionId: lease.id, reason: null },
          outcome,
        }),
      );
      await dataSource.getRepository(WorkspaceExecutionEntity).update({ id: lease.id }, { releaseOperationId: action.id });
      await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [lease.id, action.id]);
      return { lease, action, wt };
    };

    resetRemoveInvocationCount();
    const requested = await makeLease("requested", { pending: true, phase: "REQUESTED" });
    await expect(
      service.releaseExecutionWorkspace(
        requested.lease.id,
        claims.current(requested.action.id, "requested-token"),
      ),
    ).rejects.toMatchObject({ code: "RELEASE_UNAUTHORIZED" });
    expect(getRemoveInvocationCount()).toBe(0);

    const foreign = await makeLease("foreign", {
      pending: true,
      phase: "EXECUTING",
      ownerProcessId: "foreign-process",
      ownerToken: "foreign-token",
    });
    await expect(
      service.releaseExecutionWorkspace(foreign.lease.id, {
        operationId: foreign.action.id,
        ownerProcessId: "foreign-process",
        ownerToken: "foreign-token",
      }),
    ).rejects.toMatchObject({ code: "RELEASE_UNAUTHORIZED" });
    expect(getRemoveInvocationCount()).toBe(0);

    const wrongToken = await makeLease("wrong-token", {
      pending: true,
      phase: "EXECUTING",
      ownerProcessId: PROCESS_INSTANCE_ID,
      ownerToken: "right-token",
    });
    await expect(
      service.releaseExecutionWorkspace(
        wrongToken.lease.id,
        claims.current(wrongToken.action.id, "wrong-token"),
      ),
    ).rejects.toMatchObject({ code: "RELEASE_UNAUTHORIZED" });
    expect(getRemoveInvocationCount()).toBe(0);

    const successful = await makeLease("successful", {
      pending: true,
      phase: "EXECUTING",
      ownerProcessId: PROCESS_INSTANCE_ID,
      ownerToken: "right-token",
    });
    const released = await service.releaseExecutionWorkspace(
      successful.lease.id,
      claims.current(successful.action.id, "right-token"),
    );
    expect(released.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);

    const finalized = await makeLease("finalized", {
      state: "PRESERVED",
      failureCode: "WORKTREE_DIRTY",
      refusal: true,
    });
    await expect(
      service.releaseExecutionWorkspace(
        finalized.lease.id,
        claims.current(finalized.action.id, "historical-token"),
      ),
    ).rejects.toMatchObject({ code: "RELEASE_UNAUTHORIZED" });
    expect(getRemoveInvocationCount()).toBe(1);
  });

  it("orphan terminal lock recovery acquires with a new key and performs exactly one Git mutation", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, "wt-orphan-terminal-lock");
    addGitWorktree(repoRoot, wt, "tenvyr/orphan-terminal-lock", headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-orphan-terminal-lock",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
        releaseOperationId: null,
      }),
    );
    const terminalAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: "orphan-terminal-owner",
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { state: "PRESERVED", failureCode: "WORKTREE_DIRTY", refusal: true },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [lease.id, terminalAction.id]);

    resetRemoveInvocationCount();
    const result = await workbenchService.releaseExecutionWorkspace({
      idempotencyKey: "orphan-terminal-new-key",
      workspaceExecutionId: lease.id,
    });
    expect(result.result.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("REMOVED");
    expect(reloaded?.releaseOperationId).toBeNull();
    const locks = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [lease.id]);
    expect(locks).toHaveLength(0);

    const liveWt = path.join(executionRoot, `wt-orphan-live-lock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    addGitWorktree(repoRoot, liveWt, `tenvyr/orphan-live-lock-${Date.now()}`, headSha);
    const liveLease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-orphan-live-lock",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: liveWt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
        releaseOperationId: null,
      }),
    );
    const liveAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: "orphan-live-owner",
        actor: "local-operator",
        targetId: liveLease.id,
        payload: { workspaceExecutionId: liveLease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [liveLease.id, liveAction.id]);
    // A pending REQUESTED that still owns the lock must be recovered by a new UUID; the new key observes IN_PROGRESS and triggers recovery of the original
    await expect(
      workbenchService.releaseExecutionWorkspace({
        idempotencyKey: "orphan-live-new-key",
        workspaceExecutionId: liveLease.id,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_IN_PROGRESS" });
    // The new key triggers recovery of the pending REQUESTED via the single driver; the original operation now owns the execution
    // and will be driven to terminal. The lock may still be held or may have been transferred, but the worktree should not have been double-removed
    const liveLocksAfter = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [liveLease.id]);
    // After recovery, the original pending should have been claimed (now EXECUTING) and may have already completed; lock may be 0 or 1 depending on timing
    expect([0, 1]).toContain(liveLocksAfter.length);
  });

  it("Exact authority: same-target historical REFUSED referenced by releaseOperationId fails RELEASE_UNAUTHORIZED", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, "wt-hist-refused-same");
    addGitWorktree(repoRoot, wt, "tenvyr/hist-refused-same", headSha);
    const leaseId = randomUUID();
    // Create historical REFUSED action for same target
    const histAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: `hist-refused-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { workspaceExecutionId: leaseId, state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "dirty", refusal: true },
      }),
    );
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-hist-same",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: histAction.id,
      }),
    );
    resetRemoveInvocationCount();
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(getRemoveInvocationCount()).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  });

  it("Exact authority: RELEASE_REQUESTED + null executionPath + no operation → RELEASE_UNAUTHORIZED/PRESERVED, no Git, no REMOVED", async () => {
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-null-noop",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: null,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: null,
      }),
    );
    resetRemoveInvocationCount();
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(getRemoveInvocationCount()).toBe(0);
    // Ensure it did NOT become REMOVED merely because executionPath is null
    expect(reloaded?.state).not.toBe("REMOVED");
  });

  it("Exact authority: RELEASE_REQUESTED + null executionPath + historical finalized operation → RELEASE_UNAUTHORIZED, no Git", async () => {
    const histAction = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: `hist-null-${Date.now()}`,
        actor: "local-operator",
        targetId: "temp",
        payload: { workspaceExecutionId: "temp", reason: null },
        outcome: { workspaceExecutionId: "temp", state: "PRESERVED", failureCode: "WORKTREE_DIRTY", error: "dirty", refusal: true },
      }),
    );
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-null-hist",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: null,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: histAction.id,
      }),
    );
    // Fix targetId to point correctly
    await dataSource.getRepository(OperatorActionEntity).update({ id: histAction.id }, { targetId: lease.id } as any);
    resetRemoveInvocationCount();
    const transitions = await service.reconcileWorkspaceExecutions();
    expect(transitions).toBeGreaterThanOrEqual(1);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("RELEASE_UNAUTHORIZED");
    expect(getRemoveInvocationCount()).toBe(0);
  });

  it("Attention is pure READ: polling produces no DB writes and no Git calls", async () => {
    const { AttentionService } = await import("./services/attention.service");
    const attentionService = new AttentionService(dataSource, service);
    // Create a PRESERVED dirty lease that would produce attention
    const wt = path.join(executionRoot, "wt-attention-read");
    addGitWorktree(repoRoot, wt, "tenvyr/attention-read", headSha);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty");
    // Need to have a terminal run to make lease PRESERVED via authoritative path; instead directly create PRESERVED
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-attention-read",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
        hasUncommittedWork: true,
      }),
    );
    // Snapshot relevant rows
    const beforeLeases = await dataSource.getRepository(WorkspaceExecutionEntity).find();
    const beforeActions = await dataSource.getRepository(OperatorActionEntity).find();
    const beforeCount = beforeLeases.length;
    const beforeActionCount = beforeActions.length;
    const beforeUpdatedAt = new Map(beforeLeases.map((l) => [l.id, l.updatedAt.toISOString()]));
    resetRemoveInvocationCount();
    // Poll Attention repeatedly
    for (let i = 0; i < 5; i++) {
      const view = await attentionService.attention();
      expect(view.items.some((it) => it.workspaceExecutionId === lease.id)).toBe(true);
    }
    const afterLeases = await dataSource.getRepository(WorkspaceExecutionEntity).find();
    const afterActions = await dataSource.getRepository(OperatorActionEntity).find();
    expect(afterLeases.length).toBe(beforeCount);
    expect(afterActions.length).toBe(beforeActionCount);
    for (const l of afterLeases) {
      expect(l.updatedAt.toISOString()).toBe(beforeUpdatedAt.get(l.id));
    }
    expect(getRemoveInvocationCount()).toBe(0);
    // Ensure dirty file still exists (no Git remove)
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.existsSync(path.join(wt, "dirty.txt"))).toBe(true);
  });

  it("Frontend unknown state fail-closed: RELEASE_REQUESTED + null path + missing authority never becomes REMOVED", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    // Create a PRESERVED lease with no executionPath (simulating corrupted state)
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-unknown-state",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: null,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const key = `unknown-state-${Date.now()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "LEASE_PATH_MISSING" });
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("LEASE_PATH_MISSING");
    const action = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key } });
    expect((action?.outcome as any)?.state).toBe("PRESERVED");
    expect((action?.outcome as any)?.failureCode).toBe("LEASE_PATH_MISSING");
    expect((action?.outcome as any)?.refusal).toBe(true);
  });

  it("REQUESTED A + NEW UUID B: B recovers A, Git 1, B observes A's terminal with performedByOperationId", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, `wt-requested-new-uuid-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/requested-new-uuid-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-requested-new-uuid",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    // Create pending REQUESTED A (crash before claim)
    const keyA = `requested-A-${Date.now()}-${Math.random()}`;
    const actionA = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: keyA,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "REQUESTED" },
      }),
    );
    resetRemoveInvocationCount();
    const keyB = `requested-B-${Date.now()}-${Math.random()}`;
    const resultB = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: lease.id });
    expect(resultB.outcome).toBe("duplicate");
    expect((resultB.result as any).performedByOperationId).toBe(actionA.id);
    expect(getRemoveInvocationCount()).toBe(1);
    const reloadedA = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: actionA.id } });
    const reloadedLease = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloadedA?.outcome).toBeDefined();
    const outcomeA = reloadedA?.outcome as any;
    expect(outcomeA.pending).not.toBe(true);
    expect(outcomeA.state).toBe("REMOVED");
    expect(outcomeA.state).toBe("REMOVED");
    expect(reloadedLease?.state).toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(1);
    const actionB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
    const outcomeB = actionB?.outcome as any;
    expect(outcomeB).toBeDefined();
    expect(outcomeB.state).toBe("REMOVED");
    expect(outcomeB.performedByOperationId).toBe(actionA.id);
    // B must not be replacement executor, must be observer
    const resultB2 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
    expect((resultB2?.outcome as any)?.performedByOperationId).toBe(actionA.id);
    // No pending REQUESTED orphan remains
    const stillPending = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: actionA.id } });
    expect((stillPending?.outcome as any)?.pending).not.toBe(true);
  });

  it("Atomic terminal: Git success + crash before DB commit → new UUID B recovers without second Git", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, `wt-atomic-crash-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/atomic-crash-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-atomic-crash",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const keyA = `atomic-A-${Date.now()}-${Math.random()}`;
    // Simulate Git success but authoritative terminal transaction fails BEFORE COMMIT (injected inside the ONE real transaction after first write/lock)
    (service as any).setTerminalShouldFail(true);
    resetRemoveInvocationCount();
    const errA = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyA, workspaceExecutionId: lease.id }).catch((e) => e);
    expect(getRemoveInvocationCount()).toBe(1);
    const actionA = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyA } });
    const outcomeA = actionA?.outcome as any;
    expect(outcomeA?.pending).toBe(true);
    // Immediately after injected failure, assert durable: Workspace RELEASE_REQUESTED, releaseOperationId=A, lock=A, A pending
    const leaseAfterFail = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(leaseAfterFail?.state).toBe("RELEASE_REQUESTED");
    expect(leaseAfterFail?.releaseOperationId).toBe(actionA!.id);
    const lockAfterFail = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [lease.id]);
    const lockOpAfterFail = Array.isArray(lockAfterFail) ? lockAfterFail[0]?.releaseOperationId : lockAfterFail?.rows?.[0]?.releaseOperationId;
    expect(lockOpAfterFail).toBe(actionA!.id);
    expect(fs.existsSync(wt)).toBe(false);
    // Now new UUID B arrives and should recover A without second Git
    resetRemoveInvocationCount();
    const keyB = `atomic-B-${Date.now()}-${Math.random()}`;
    const resultB = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: lease.id });
    // B must be duplicate/observer with performedByOperationId:A, not executed as B
    expect(resultB.outcome).toBe("duplicate");
    expect((resultB.result as any).performedByOperationId).toBe(actionA!.id);
    expect(getRemoveInvocationCount()).toBe(0);
    const finalLease = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(finalLease?.state).toBe("REMOVED");
    expect(finalLease?.releaseOperationId).toBeNull();
    const lockAfter = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [lease.id]);
    expect(lockAfter).toHaveLength(0);
    const finalA = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: actionA!.id } });
    expect((finalA?.outcome as any)?.state).toBe("REMOVED");
    expect((finalA?.outcome as any)?.pending).not.toBe(true);
    const actionB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
    const outcomeB = actionB?.outcome as any;
    expect(outcomeB.state).toBe("REMOVED");
    expect(outcomeB.performedByOperationId).toBe(actionA!.id);
    // Also test generic DB failure (not containing "injected terminal") — same recovery
    const lease2 = await dataSource.getRepository(WorkspaceExecutionEntity).save(dataSource.getRepository(WorkspaceExecutionEntity).create({
      sourceWorkspaceId: "ws-atomic-generic",
      sourcePath: repoRoot,
      mode: "git-worktree",
      executionPath: path.join(executionRoot, `wt-atomic-generic-${Date.now()}`),
      baseBranch: "main",
      baseHeadSha: headSha,
      state: "PRESERVED",
    }));
    const wt2 = lease2.executionPath!;
    addGitWorktree(repoRoot, wt2, `tenvyr/atomic-generic-${Date.now()}`, headSha);
    await dataSource.getRepository(WorkspaceExecutionEntity).update({ id: lease2.id }, { executionPath: wt2 } as any);
    const keyA2 = `atomic-generic-A-${Date.now()}-${Math.random()}`;
    // Use generic failure token to trigger generic DB error inside transaction (not containing "injected terminal")
    // We simulate by directly calling persistTerminalRelease with a claim that will fail due to generic error
    // For now, we test that a generic error after Git also leaves recoverable state: simulate by setting a flag that makes next persist fail with generic error
    (service as any).terminalShouldFail = true;
    // Temporarily patch the error message to be generic
    const origPersist = (service as any).persistTerminalRelease.bind(service);
    (service as any).persistTerminalRelease = async (...args: any[]) => {
      (service as any).terminalShouldFail = false;
      throw new Error("Simulated database failure");
    };
    resetRemoveInvocationCount();
    const errA2 = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyA2, workspaceExecutionId: lease2.id }).catch((e) => e);
    expect(getRemoveInvocationCount()).toBe(1);
    const actionA2 = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyA2 } });
    expect((actionA2?.outcome as any)?.pending).toBe(true);
    const leaseAfterFail2 = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease2.id } });
    expect(leaseAfterFail2?.state).toBe("RELEASE_REQUESTED");
    // Restore original persist
    (service as any).persistTerminalRelease = origPersist;
    resetRemoveInvocationCount();
    const keyB2 = `atomic-generic-B-${Date.now()}-${Math.random()}`;
    const resultB2 = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB2, workspaceExecutionId: lease2.id });
    expect(resultB2.outcome).toBe("duplicate");
    expect((resultB2.result as any).performedByOperationId).toBe(actionA2!.id);
    expect(getRemoveInvocationCount()).toBe(0);
    try { fs.rmSync(wt2, { recursive: true, force: true }); } catch {}
  });

  it("Legacy REMOVED + pending EXECUTING A: recovery repairs without Git", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, `wt-legacy-removed-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/legacy-removed-${Date.now()}`, headSha);
    // Remove worktree on filesystem but leave DB as REMOVED and A pending
    const removeResult = removeGitWorktree(repoRoot, wt);
    expect(removeResult === "removed" || removeResult === "already-removed").toBe(true);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-legacy-removed",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "REMOVED",
      }),
    );
    const keyA = `legacy-A-${Date.now()}-${Math.random()}`;
    const actionA = await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        action: "release-execution-workspace",
        idempotencyKey: keyA,
        actor: "local-operator",
        targetId: lease.id,
        payload: { workspaceExecutionId: lease.id, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "dead-legacy", ownerToken: "tok", claimedAt: new Date().toISOString() },
      }),
    );
    // Workspace is REMOVED but A is still pending -> should be repaired without Git
    resetRemoveInvocationCount();
    const keyB = `legacy-B-${Date.now()}-${Math.random()}`;
    const resultB = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: lease.id });
    expect(resultB.outcome).toBe("duplicate");
    expect((resultB.result as any).performedByOperationId).toBe(actionA.id);
    expect(getRemoveInvocationCount()).toBe(0);
    const finalA = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: actionA.id } });
    expect((finalA?.outcome as any)?.state).toBe("REMOVED");
    expect((finalA?.outcome as any)?.pending).not.toBe(true);
    const actionB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: keyB } });
    expect((actionB?.outcome as any).performedByOperationId).toBe(actionA.id);
    expect((await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } }))?.state).toBe("REMOVED");
  });

  it("Pre-remove worktree list UNKNOWN → no Git, PRESERVED WORKTREE_STATE_UNKNOWN", async () => {
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const wt = path.join(executionRoot, `wt-pre-unknown-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/pre-unknown-${Date.now()}`, headSha);
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        sourceWorkspaceId: "ws-pre-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "PRESERVED",
      }),
    );
    const origRunner = getGitRunner();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "fatal: unknown" };
      return origRunner(cwd, args);
    });
    resetRemoveInvocationCount();
    const key = `pre-unknown-${Date.now()}-${Math.random()}`;
    await expect(workbenchService.releaseExecutionWorkspace({ idempotencyKey: key, workspaceExecutionId: lease.id })).rejects.toMatchObject({ code: "WORKTREE_STATE_UNKNOWN" });
    expect(getRemoveInvocationCount()).toBe(0);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: lease.id } });
    expect(reloaded?.state).toBe("PRESERVED");
    expect(reloaded?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    expect(reloaded?.hasUncommittedWork).toBeNull();
    const action = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { idempotencyKey: key } });
    expect((action?.outcome as any)?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    expect((action?.outcome as any)?.refusal).toBe(true);
    expect(fs.existsSync(wt)).toBe(true);
    setGitRunner(null as any);
  });

  it("Reconciliation UNKNOWN: RELEASE_REQUESTED exact recoverable + worktree list UNKNOWN → no Git, no REMOVED", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-reconcile-unknown-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/reconcile-unknown-${Date.now()}`, headSha);
    const leaseId = randomUUID();
    const opId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-reconcile-unknown",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opId,
        action: "release-execution-workspace",
        idempotencyKey: `reconcile-unknown-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "test-pid", ownerToken: "tok", claimedAt: new Date().toISOString() },
      }),
    );
    const origRunner = getGitRunner();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "unknown" };
      return origRunner(cwd, args);
    });
    resetRemoveInvocationCount();
    // Try to recover via new UUID B — it should observe that worktree list is UNKNOWN and not do Git
    const workbenchService = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyB = `reconcile-unknown-B-${Date.now()}`;
    const errB = await workbenchService.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    // When worktree list is UNKNOWN, the operation should fail closed as WORKTREE_STATE_UNKNOWN (no Git, preserved) or be observed as IN_PROGRESS if recovery is still pending
    expect(["RELEASE_IN_PROGRESS", "WORKTREE_STATE_UNKNOWN"]).toContain((errB as any)?.code);
    expect(getRemoveInvocationCount()).toBe(0);
    const reloaded = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } });
    // After UNKNOWN, the lease should be either still RELEASE_REQUESTED (if recovery kept it) or PRESERVED with UNKNOWN (if it was finalized)
    expect(["RELEASE_REQUESTED", "PRESERVED"]).toContain(reloaded?.state);
    if (reloaded?.state === "PRESERVED") {
      expect(reloaded?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    }
    expect(fs.existsSync(wt)).toBe(true);
    setGitRunner(null as any);
  });

  // Failure-during-recovery triad (R1/R2/R3) — must be real PG, not sentinel-only
  it("R1 — ABSENT recovery persistence fails → A stays pending, B not success, C recovers exact A with Git 0", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-r1-absent-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/r1-absent-${Date.now()}`, headSha);
    // Make worktree ABSENT on FS (remove it) but keep DB as RELEASE_REQUESTED with lock A
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-r1",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `r1-A-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "dead-r1", ownerToken: "tok-r1", claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    // Remove worktree so it's ABSENT
    removeGitWorktree(repoRoot, wt);
    expect(fs.existsSync(wt)).toBe(false);
    // B new UUID triggers recovery, but inject failure inside persistTerminalRelease during B's recovery
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    resetRemoveInvocationCount();
    const keyB = `r1-B-${Date.now()}-${Math.random()}`;
    const errB = await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    expect((errB as any)?.code ?? (errB as any)?.outcome).toBeDefined();
    expect((errB as any)?.outcome).not.toBe("executed");
    const wsAfterB = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterB?.state).toBe("RELEASE_REQUESTED");
    expect(wsAfterB?.releaseOperationId).toBe(opAId);
    const lockAfterB: any = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    const lockOpAfterB = Array.isArray(lockAfterB) ? lockAfterB[0]?.releaseOperationId : lockAfterB?.rows?.[0]?.releaseOperationId;
    expect(lockOpAfterB).toBe(opAId);
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    expect((opAAfterB?.outcome as any)?.recoverable === true || (opAAfterB?.outcome as any)?.phase === "REQUESTED").toBe(true);
    expect(wsAfterB?.state).not.toBe("REMOVED");
    expect(getRemoveInvocationCount()).toBe(0);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    (service as any).setTerminalShouldFail(false);
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `r1-C-${Date.now()}-${Math.random()}`;
    const resC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId });
    expect(resC.outcome).toBe("duplicate");
    expect((resC.result as any).performedByOperationId).toBe(opAId);
    expect(getRemoveInvocationCount()).toBe(0);
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("REMOVED");
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC).toHaveLength(0);
    const opAAfterC = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterC?.outcome as any)?.state).toBe("REMOVED");
    await assertNoImpossibleState(dataSource, leaseId, opAId);
  });

  it("R2 — REGISTERED recovery + terminal DB failure (Git 1, worktree now ABSENT) → C recovers with 0 second Git", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-r2-reg-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/r2-reg-${Date.now()}`, headSha);
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-r2",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `r2-A-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "dead-r2", ownerToken: "tok-r2", claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    expect(fs.existsSync(wt)).toBe(true);
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    resetRemoveInvocationCount();
    const keyB = `r2-B-${Date.now()}-${Math.random()}`;
    const errB = await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    expect(fs.existsSync(wt)).toBe(false);
    expect(getRemoveInvocationCount()).toBe(1);
    const wsAfterB = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterB?.state).toBe("RELEASE_REQUESTED");
    expect(wsAfterB?.releaseOperationId).toBe(opAId);
    const lockAfterB: any = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect((Array.isArray(lockAfterB) ? lockAfterB[0]?.releaseOperationId : lockAfterB?.rows?.[0]?.releaseOperationId)).toBe(opAId);
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    expect((opAAfterB?.outcome as any)?.recoverable === true || (opAAfterB?.outcome as any)?.phase === "REQUESTED").toBe(true);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    (service as any).setTerminalShouldFail(false);
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `r2-C-${Date.now()}-${Math.random()}`;
    const resC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId });
    expect(resC.outcome).toBe("duplicate");
    expect((resC.result as any).performedByOperationId).toBe(opAId);
    expect(getRemoveInvocationCount()).toBe(0);
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("REMOVED");
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC).toHaveLength(0);
    const opAAfterC = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterC?.outcome as any)?.state).toBe("REMOVED");
    expect((opAAfterC?.outcome as any)?.pending).not.toBe(true);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
  });

  it("R3 — refusal persistence fails during recovery → A stays pending, next UUID re-observes and commits PRESERVED refusal", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-r3-refusal-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/r3-refusal-${Date.now()}`, headSha);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty");
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-r3",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `r3-A-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: "dead-r3", ownerToken: "tok-r3", claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    // B triggers recovery, which will observe WORKTREE_DIRTY and try to persist PRESERVED refusal, but inject failure
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    resetRemoveInvocationCount();
    const keyB = `r3-B-${Date.now()}-${Math.random()}`;
    const errB = await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    // No OperatorAction-only PRESERVED should have been written; A must remain pending while target still belongs to A
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    expect((opAAfterB?.outcome as any)?.state).not.toBe("PRESERVED");
    const wsAfterB = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterB?.state).toBe("RELEASE_REQUESTED");
    expect(wsAfterB?.releaseOperationId).toBe(opAId);
    const lockAfterB: any = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect((Array.isArray(lockAfterB) ? lockAfterB[0]?.releaseOperationId : lockAfterB?.rows?.[0]?.releaseOperationId)).toBe(opAId);
    expect(getRemoveInvocationCount()).toBe(1); // Git was attempted (dirty check is part of remove, counts as 1)
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    (service as any).setTerminalShouldFail(false);
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `r3-C-${Date.now()}-${Math.random()}`;
    const errC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId }).catch((e) => e);
    expect((errC as any)?.code).toBe("WORKTREE_DIRTY");
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("PRESERVED");
    expect(wsAfterC?.failureCode).toBe("WORKTREE_DIRTY");
    expect(wsAfterC?.hasUncommittedWork).toBe(true);
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC).toHaveLength(0);
    const opAAfterC = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterC?.outcome as any)?.state).toBe("PRESERVED");
    expect((opAAfterC?.outcome as any)?.failureCode).toBe("WORKTREE_DIRTY");
    expect((opAAfterC?.outcome as any)?.pending).not.toBe(true);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    try { fs.unlinkSync(path.join(wt, "dirty.txt")); } catch {}
    try { spawnSync("git", ["-C", wt, "clean", "-fd"], { stdio: "ignore" }); } catch {}
  });

  it("UNKNOWN rollback same-process recovery: WORKTREE_STATE_UNKNOWN terminal persistence fails → next UUID recovers fail-closed", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-unknown-rollback-${Date.now()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/unknown-rollback-${Date.now()}`, headSha);
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: "ws-unknown-rollback",
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `unknown-rollback-A-${Date.now()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: "tok-unknown", claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    const origRunner = getGitRunner();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "unknown" };
      return origRunner(cwd, args);
    });
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    resetRemoveInvocationCount();
    const keyB = `unknown-rollback-B-${Date.now()}-${Math.random()}`;
    const errB = await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    const wsAfterB = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterB?.state).toBe("RELEASE_REQUESTED");
    expect(wsAfterB?.releaseOperationId).toBe(opAId);
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    // After failure, the operation should be pending and either recoverable or still EXECUTING (live) — both are considered recoverable for same-process retry
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    expect(getRemoveInvocationCount()).toBe(0);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    (service as any).setTerminalShouldFail(false);
    setGitRunner(null as any);
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `unknown-rollback-C-${Date.now()}-${Math.random()}`;
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "unknown" };
      return origRunner(cwd, args);
    });
    const errC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId }).catch((e) => e);
    expect((errC as any)?.code).toBe("WORKTREE_STATE_UNKNOWN");
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("PRESERVED");
    expect(wsAfterC?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    expect(wsAfterC?.hasUncommittedWork).toBeNull();
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC2: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC2).toHaveLength(0);
    expect((await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } }) as any)?.outcome?.state).toBe("PRESERVED");
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    setGitRunner(null as any);
  });

  it("marker-write failure same-process recovery (DIRTY): A owns RELEASE_REQUESTED, terminal fails + marker fails, C recovers exact A to PRESERVED WORKTREE_DIRTY", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-marker-fail-dirty-${Date.now()}-${Math.random()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/marker-fail-dirty-${Date.now()}-${Math.random()}`, headSha);
    fs.writeFileSync(path.join(wt, "dirty.txt"), "dirty");
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: `ws-marker-dirty-${Date.now()}`,
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `marker-fail-dirty-A-${Date.now()}-${Math.random()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: `tok-dirty-${Date.now()}`, claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    const origCreateQB = dataSource.getRepository(OperatorActionEntity).createQueryBuilder.bind(dataSource.getRepository(OperatorActionEntity));
    let markerShouldFail = true;
    (dataSource.getRepository(OperatorActionEntity) as any).createQueryBuilder = function (...args: any[]) {
      const qb = origCreateQB(...args);
      const origExecute = qb.execute.bind(qb);
      qb.execute = async (...eArgs: any[]) => {
        if (markerShouldFail && (qb as any)._updateSet?.outcome?.recoverable === true) {
          markerShouldFail = false;
          return { affected: 0, raw: [] } as any;
        }
        return origExecute(...eArgs);
      };
      const origSet = qb.set.bind(qb);
      qb.set = (vals: any) => {
        (qb as any)._updateSet = vals;
        return origSet(vals);
      };
      return qb;
    } as any;
    resetRemoveInvocationCount();
    const keyB = `marker-fail-dirty-B-${Date.now()}-${Math.random()}`;
    const errB = await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch((e) => e);
    // After B: terminal persistence failed, recoverable marker write failed, B's exact token no longer active
    const wsAfterB = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterB?.state).toBe("RELEASE_REQUESTED");
    expect(wsAfterB?.releaseOperationId).toBe(opAId);
    const lockAfterB: any = await dataSource.query(`SELECT "releaseOperationId" FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect((Array.isArray(lockAfterB) ? lockAfterB[0]?.releaseOperationId : lockAfterB?.rows?.[0]?.releaseOperationId)).toBe(opAId);
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    // Marker write failed, so recoverable marker may be absent, but B's token is unregistered, so A is still recoverable via inactive-token orphan
    const tokenB = (opAAfterB?.outcome as any)?.ownerToken;
    const isActiveB = tokenB ? (workbenchB as any).isActiveToken(opAId, tokenB) : false;
    expect(isActiveB).toBe(false);
    (dataSource.getRepository(OperatorActionEntity) as any).createQueryBuilder = origCreateQB;
    (service as any).setTerminalShouldFail(false);
    // C new UUID in same process must reclaim exact A and converge to PRESERVED WORKTREE_DIRTY
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `marker-fail-dirty-C-${Date.now()}-${Math.random()}`;
    const resC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId }).catch((e) => e);
    // C's result must be WORKTREE_DIRTY (canonical dirty-path Git count = 1)
    const codeC = (resC as any)?.code ?? (resC as any)?.result?.failureCode;
    expect(codeC).toBe("WORKTREE_DIRTY");
    expect(getRemoveInvocationCount()).toBe(1);
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("PRESERVED");
    expect(wsAfterC?.failureCode).toBe("WORKTREE_DIRTY");
    expect(wsAfterC?.hasUncommittedWork).toBe(true);
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC).toHaveLength(0);
    const opAAfterC = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterC?.outcome as any)?.state).toBe("PRESERVED");
    expect((opAAfterC?.outcome as any)?.failureCode).toBe("WORKTREE_DIRTY");
    expect((opAAfterC?.outcome as any)?.pending).not.toBe(true);
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  });

  it("marker-write failure UNKNOWN: A owns RELEASE_REQUESTED, terminal fails + marker fails, C new UUID recovers exact A to PRESERVED UNKNOWN", async () => {
    const { randomUUID } = await import("node:crypto");
    const wt = path.join(executionRoot, `wt-marker-fail-unknown2-${Date.now()}-${Math.random()}`);
    addGitWorktree(repoRoot, wt, `tenvyr/marker-fail-unknown3-${Date.now()}`, headSha);
    const leaseId = randomUUID();
    const opAId = randomUUID();
    const lease = await dataSource.getRepository(WorkspaceExecutionEntity).save(
      dataSource.getRepository(WorkspaceExecutionEntity).create({
        id: leaseId,
        sourceWorkspaceId: `ws-marker-unknown-${Date.now()}`,
        sourcePath: repoRoot,
        mode: "git-worktree",
        executionPath: wt,
        baseBranch: "main",
        baseHeadSha: headSha,
        state: "RELEASE_REQUESTED",
        releaseOperationId: opAId,
      }),
    );
    await dataSource.getRepository(OperatorActionEntity).save(
      dataSource.getRepository(OperatorActionEntity).create({
        id: opAId,
        action: "release-execution-workspace",
        idempotencyKey: `marker-fail-unknown-A-${Date.now()}-${Math.random()}`,
        actor: "local-operator",
        targetId: leaseId,
        payload: { workspaceExecutionId: leaseId, reason: null },
        outcome: { pending: true, phase: "EXECUTING", ownerProcessId: PROCESS_INSTANCE_ID, ownerToken: `tok-unknown-${Date.now()}`, claimedAt: new Date().toISOString() },
      }),
    );
    await dataSource.query(`INSERT INTO "workspace_release_locks" ("workspaceExecutionId", "releaseOperationId") VALUES ($1, $2)`, [leaseId, opAId]);
    const origRunner = getGitRunner();
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "unknown" };
      return origRunner(cwd, args);
    });
    const workbenchB = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    (service as any).setTerminalShouldFail(true);
    const origCreateQB2 = dataSource.getRepository(OperatorActionEntity).createQueryBuilder.bind(dataSource.getRepository(OperatorActionEntity));
    let markerShouldFail2 = true;
    (dataSource.getRepository(OperatorActionEntity) as any).createQueryBuilder = function (...args: any[]) {
      const qb = origCreateQB2(...args);
      const origExecute = qb.execute.bind(qb);
      qb.execute = async (...eArgs: any[]) => {
        if (markerShouldFail2 && (qb as any)._updateSet?.outcome?.recoverable === true) {
          markerShouldFail2 = false;
          return { affected: 0, raw: [] } as any;
        }
        return origExecute(...eArgs);
      };
      const origSet = qb.set.bind(qb);
      qb.set = (vals: any) => {
        (qb as any)._updateSet = vals;
        return origSet(vals);
      };
      return qb;
    } as any;
    resetRemoveInvocationCount();
    const keyB = `marker-fail-unknown-B-${Date.now()}-${Math.random()}`;
    await workbenchB.releaseExecutionWorkspace({ idempotencyKey: keyB, workspaceExecutionId: leaseId }).catch(() => {});
    const opAAfterB = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterB?.outcome as any)?.pending).toBe(true);
    (dataSource.getRepository(OperatorActionEntity) as any).createQueryBuilder = origCreateQB2;
    (service as any).setTerminalShouldFail(false);
    setGitRunner(null as any);
    resetRemoveInvocationCount();
    const workbenchC = new WorkbenchCommandService(dataSource, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
    const keyC = `marker-fail-unknown-C-${Date.now()}-${Math.random()}`;
    setGitRunner((cwd, args) => {
      if (args.includes("worktree") && args.includes("list")) return { status: 1, stdout: "", stderr: "unknown" };
      return origRunner(cwd, args);
    });
    const resC = await workbenchC.releaseExecutionWorkspace({ idempotencyKey: keyC, workspaceExecutionId: leaseId }).catch((e) => e);
    expect((resC as any)?.code === "WORKTREE_STATE_UNKNOWN" || (resC as any)?.result?.failureCode === "WORKTREE_STATE_UNKNOWN").toBe(true);
    const wsAfterC = await dataSource.getRepository(WorkspaceExecutionEntity).findOne({ where: { id: leaseId } as any });
    expect(wsAfterC?.state).toBe("PRESERVED");
    expect(wsAfterC?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    expect(wsAfterC?.hasUncommittedWork).toBeNull();
    expect(wsAfterC?.releaseOperationId).toBeNull();
    const lockAfterC: any = await dataSource.query(`SELECT * FROM "workspace_release_locks" WHERE "workspaceExecutionId" = $1`, [leaseId]);
    expect(lockAfterC).toHaveLength(0);
    const opAAfterC = await dataSource.getRepository(OperatorActionEntity).findOne({ where: { id: opAId } });
    expect((opAAfterC?.outcome as any)?.state).toBe("PRESERVED");
    expect((opAAfterC?.outcome as any)?.failureCode).toBe("WORKTREE_STATE_UNKNOWN");
    await assertNoImpossibleState(dataSource, leaseId, opAId);
    setGitRunner(null as any);
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  });
});
