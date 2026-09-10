import { Inject, Injectable } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { CoordinationRunEntity } from "../entities/coordination-run.entity";
import { ExecutionEntity } from "../entities/execution.entity";
import { ApprovalRequestEntity } from "../entities/approval-request.entity";
import { WorkspaceExecutionEntity } from "../entities/workspace-execution.entity";
import {
  deriveAttentionItems,
  type AttentionItemV1,
} from "../domain/attention";
import { WorkspaceExecutionService } from "./workspace-execution.service";

/**
 * PP1 Slice B — Attention Queue V1 (READ PROJECTION).
 *
 * Derives exception-driven attention from existing durable authority rows;
 * nothing is persisted and nothing resolves authority. No durable state
 * transition and no filesystem mutation is performed here. Terminal-run
 * leases become PRESERVED via the authoritative run-completion path
 * (preserveExecutionWorkspaceForRun inside the coordination transaction),
 * not via lazy Attention polling. Deterministic ids → polling cannot
 * duplicate items; an item exists exactly while its durable source
 * condition exists. Continuation/preservation does not depend on Attention.
 */
@Injectable()
export class AttentionService {
  constructor(
    @Inject("DATA_SOURCE") private readonly dataSource: DataSource,
    workspaceExecutions?: WorkspaceExecutionService,
  ) {
    this.workspaceExecutions =
      workspaceExecutions ?? new WorkspaceExecutionService(this.dataSource);
  }

  private readonly workspaceExecutions: WorkspaceExecutionService;

  async attention(): Promise<{ items: AttentionItemV1[]; serverTime: string }> {

    const runs = await this.dataSource
      .getRepository(CoordinationRunEntity)
      .find();
    const runIds = runs.map((run) => run.id);
    const executions = await this.dataSource.getRepository(ExecutionEntity).find({
      where: { id: In(runs.map((run) => run.executionId)) },
    });
    const approvalRequests = await this.dataSource
      .getRepository(ApprovalRequestEntity)
      .find({ where: { status: "PENDING" } });
    const workspaceExecutions = await this.dataSource
      .getRepository(WorkspaceExecutionEntity)
      .find({ where: { state: "PRESERVED" } });

    const executionSet = new Map(
      executions.map((execution) => [execution.id, execution]),
    );
    const runByExecution = new Map(runs.map((run) => [run.executionId, run]));
    const executionByRun = new Map(
      runs.map((run) => [run.id, { executionId: run.executionId }]),
    );

    const items = deriveAttentionItems({
      runs: runs.map((run) => ({
        id: run.id,
        executionId: run.executionId,
        phase: run.phase,
        waitReason: run.waitReason,
        updatedAt: run.updatedAt,
        createdAt: run.createdAt,
      })),
      executions: runs
        .map((run) => executionSet.get(run.executionId))
        .filter((execution): execution is ExecutionEntity => Boolean(execution))
        .map((execution) => ({
          id: execution.id,
          status: execution.status,
          terminationReason: execution.terminationReason,
          updatedAt: execution.updatedAt,
          createdAt: execution.createdAt,
        })),
      approvalRequests: approvalRequests.map((request) => ({
        proposalId: request.proposalId,
        actionType: request.actionType,
        targetAgent: request.targetAgent,
        targetExecutor: request.targetExecutor,
        status: request.status,
        createdAt: request.createdAt,
      })),
      workspaceExecutions: workspaceExecutions.map((lease) => ({
        id: lease.id,
        ownerRunId: lease.ownerRunId,
        state: lease.state,
        hasUncommittedWork: lease.hasUncommittedWork,
        updatedAt: lease.updatedAt,
        createdAt: lease.createdAt,
      })),
      runByExecution,
      executionByRun,
    });
    return { items, serverTime: new Date().toISOString() };
  }
}