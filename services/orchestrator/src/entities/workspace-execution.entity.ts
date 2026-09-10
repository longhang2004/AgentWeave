import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import type {
  WorkspaceExecutionModeV1,
  WorkspaceExecutionStateV1,
} from "../domain/workspace-execution";

/**
 * PP1: Tenvyr-owned execution workspace lease for one Team Run.
 *
 * The concrete path every local coding-runtime child of the run executes
 * against (source workspace itself for `shared`; an isolated Git worktree
 * for `git-worktree`), with a durable recoverable lifecycle. External Git
 * mutations are NEVER transactionally atomic with PostgreSQL: the ALLOCATING
 * row commits BEFORE any `git worktree` mutation, READY is only ever written
 * after the worktree demonstrably exists, and reconciliation fails
 * interrupted allocations closed. UNIQUE(ownerRunId) makes concurrent
 * ownership of the same lease impossible at the database level.
 */
@Entity("workspace_executions")
@Unique("UQ_workspace_execution_owner_run", ["ownerRunId"])
@Index("IDX_workspace_execution_state", ["state"])
@Index("IDX_workspace_execution_source", ["sourceWorkspaceId"])
export class WorkspaceExecutionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /** The operator-selected source workspace this execution derives from. */
  @Column({ type: "varchar", length: 255 })
  sourceWorkspaceId: string;

  /** Canonical source workspace path (provenance). */
  @Column({ type: "varchar", length: 4096 })
  sourcePath: string;

  @Column({ type: "varchar", length: 32 })
  mode: WorkspaceExecutionModeV1;

  /** The authoritative execution path; null until the lease is READY. */
  @Column({ type: "varchar", length: 4096, nullable: true })
  executionPath: string | null;

  /** Frozen source branch the worktree was created from. */
  @Column({ type: "varchar", length: 255, nullable: true })
  baseBranch: string | null;

  /** Frozen source HEAD the worktree was created from. */
  @Column({ type: "char", length: 40, nullable: true })
  baseHeadSha: string | null;

  /** Exclusive lease owner (coordination run id); UNIQUE. */
  @Column({ type: "uuid", nullable: true })
  ownerRunId: string | null;

  /** Optional command idempotency key used during allocation. */
  @Column({ type: "varchar", length: 255, nullable: true })
  @Index("IDX_workspace_execution_allocation_key")
  allocationKey: string | null;

  @Column({ type: "varchar", length: 32, default: "ALLOCATING" })
  state: WorkspaceExecutionStateV1;

  /** Deterministic failure code when state is FAILED (never READY). */
  @Column({ type: "varchar", length: 64, nullable: true })
  failureCode: string | null;

  /** Captured ONCE at IN_USE → PRESERVED for git-worktree mode; null when
   *  not measured (shared mode). */
  @Column({ type: "boolean", nullable: true })
  hasUncommittedWork: boolean | null;

  /** PP1: exact active correlation for release ownership.
   *  Holds the OperatorAction id only while the target is RELEASE_REQUESTED.
   *  Terminal finalization retires it atomically with the release lock; audit
   *  history remains in OperatorAction. Legacy RELEASE_REQUESTED without it
   *  fails closed (RELEASE_UNAUTHORIZED). */
  @Column({ type: "varchar", length: 36, nullable: true })
  releaseOperationId: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
