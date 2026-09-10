/**
 * Public bounded Workbench and Operator DTOs for the Next.js Frontend.
 * These types match the current Gateway and Orchestrator APIs.
 */

export type ApiResponse<T> = {
  success: boolean;
  data: T;
  error?: string | null;
  meta?: {
    timestamp: string;
  };
};

export type RuntimeKind = "generic-cli" | "codex" | "claude" | "opencode";

/**
 * Exhaustive connection status states (mirrors
 * `CONNECTION_STATUS_STATES` in the orchestrator's runtime-connection
 * domain). Unknown server values must map to "UNKNOWN" — never to a
 * fabricated readiness literal.
 */
export const CONNECTION_STATUS_STATES = [
  "DRAFT",
  "AVAILABLE",
  "AUTH_REQUIRED",
  "UNAVAILABLE",
  "DEGRADED",
  "REVOKED",
] as const;
export type ConnectionStatusState = (typeof CONNECTION_STATUS_STATES)[number];

export const CONNECTION_STATUS_REASON_CODES = [
  "none",
  "missing-executable",
  "unsupported-version",
  "auth-required",
  "timeout",
  "malformed-output",
  "capability-mismatch",
  "command-failed",
  "revoked",
] as const;
export type ConnectionStatusReasonCode =
  (typeof CONNECTION_STATUS_REASON_CODES)[number];

export type RuntimeOnboardingStatusV1 = {
  runtimeKind: RuntimeKind;
  detected: boolean;
  executable: string | null;
  version: string | null;
  pinnedVersion: string;
  authReady: boolean | null;
  loginCommand: string;
  modelArgvPrefix: string[];
  guidance: string[];
  docUrl: string;
};

export type ConnectionCapability = {
  key: string;
  supported: boolean;
  source: string;
};

export type WorkbenchConnectionCardV1 = {
  connectionId: string;
  name: string;
  runtimeKind: string;
  executorId: string;
  testedVersion: string | null;
  status: ConnectionStatusState | "UNKNOWN";
  reasonCode: string | null;
  testedAt: string | null;
  capabilities: ConnectionCapability[];
  revoked: boolean;
};

/**
 * Bounded connection-test receipt as produced by the orchestrator's
 * Workbench command layer (`data.result.receipt`). The receipt state is
 * authoritative: the UI must display it verbatim and must NEVER invent a
 * readiness literal when server state is absent or malformed.
 */
export type ConnectionTestReceiptV1 = {
  connectionId: string;
  revisionNumber: number;
  testedAt: string;
  testedVersion?: string;
  state: ConnectionStatusState;
  reasonCode: ConnectionStatusReasonCode;
  durationMs: number;
  superseded?: boolean;
};

/** Typed result of `POST /api/connections/:id/test` (Workbench command
 *  envelope: the receipt is nested under `result.receipt`). */
export type ConnectionTestResultV1 = {
  action: "test-connection";
  idempotencyKey: string;
  outcome: "executed" | "duplicate" | "rejected";
  result: {
    connectionId: string;
    receipt: ConnectionTestReceiptV1;
  };
};

export type ConnectionTemplateV1 = {
  runtimeKind: string;
  name: string;
  pinnedVersion: string;
  loginCommand: string;
  modelArgvPrefix: string[];
  runArgs: string[];
  probe: { args: string[]; expectsVersion: boolean };
  authProbe?: { args: string[]; expectsExitZero: boolean };
  credentialEnvRefs: string[];
  declaredCapabilities: Record<string, { supported: boolean; source: string }>;
  sourceUrl: string;
};

export type WorkspaceSnapshotV1 = {
  path: string;
  repoRoot?: string;
  branch?: string;
  headSha?: string;
  dirty?: boolean;
  note?: string;
};

export type WorkbenchWorkspaceV1 = {
  workspaceId: string;
  name: string;
  path: string;
  snapshot?: WorkspaceSnapshotV1;
  createdAt: string;
  updatedAt: string;
};

export type TeamBoundsV1 = {
  maxIterations: number;
  maxWorkersPerIteration: number;
  maxTotalWorkers: number;
  loopDeadlineMs: number;
};

export type TeamTemplateV1 = {
  templateId: string;
  name: string;
  description: string;
  goalFraming: string;
  roles: {
    planner: { kind: "agent" | "connection"; defaultName: string };
    verifier: { kind: "agent" | "connection"; defaultName: string };
    workers: Array<{ kind: "agent" | "connection"; defaultName: string }>;
  };
  defaultBounds: TeamBoundsV1;
};

export type CoordinatorSelectionV1 = {
  kind: "agent" | "connection";
  name: string;
  agent?: string;
};

/**
 * P2: a usable Runtime Target — connection + optional model. The model is
 * DATA (bounded identifier), never argv or shell input. Absent model =
 * Runtime default.
 */
export type RuntimeTargetV1 = {
  connectionId: string;
  modelId?: string;
};

export type CoordinationConfigV1 = {
  schemaVersion: 1;
  planner: CoordinatorSelectionV1;
  verifier: CoordinatorSelectionV1;
  allowedWorkers: CoordinatorSelectionV1[];
  /** P2: frozen Planner Runtime Target (connection-kind planners). */
  plannerTarget?: RuntimeTargetV1;
  /** P2: frozen Verifier Runtime Target (connection-kind verifiers). */
  verifierTarget?: RuntimeTargetV1;
  /** P2: worker Runtime Target allowlist — the ONLY models a Planner may
   *  select (connectionId + modelId pairs). */
  allowedTargets?: RuntimeTargetV1[];
  maxIterations: number;
  maxWorkersPerIteration: number;
  maxTotalWorkers: number;
  loopDeadlineMs: number;
  budgetAccountId?: string;
  delegationDepthMax: number;
  allowedExecutors: string[];
};

/**
 * P2 closure: `model_sources` is the GENERIC catalog-discovery
 * configuration (advanced operator surface) — OpenAI-compatible endpoints
 * only. Provider state is RUNTIME-OWNED: providers authenticated through
 * a runtime are discovered via the runtime's official CLI (OpenCode
 * `auth list` / `models`) and are never standalone source rows. 9Router is
 * NOT a Tenvyr product concept (it inspired the provider-management UX
 * only); an existing 9Router instance connects as a generic
 * OpenAI-compatible endpoint.
 */
export const MODEL_SOURCE_KINDS = ["openai-compatible"] as const;
export type ModelSourceKind = (typeof MODEL_SOURCE_KINDS)[number];

/**
 * P2 closure: runtime-owned Provider Connection projection. A provider is
 * a projection of the RUNTIME's own state (official CLI discovery) — never
 * standalone Tenvyr configuration, never routing authority. `loginCommand`
 * is the OFFICIAL runtime-owned auth command; Tenvyr never collects
 * credentials.
 */
export type RuntimeProviderV1 = {
  providerId: string;
  /** True when the runtime reports the provider authenticated. */
  authenticated: boolean;
  /** Official runtime-owned login command for the guided Sign-in flow. */
  loginCommand: string;
};

/**
 * P2 closure round 2: CONNECTION-SCOPED provider discovery results. The
 * response is bound to the connection's CURRENT revision — two same-kind
 * connections never share provider state.
 */
export type ProviderDiscoveryV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  providers: RuntimeProviderV1[];
};

/** Connection-scoped model enumeration (documented CLI through the exact
 *  connection profile). Catalogs are projections, never authority. */
export type RuntimeModelsRefreshV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  catalog: ModelCatalogSnapshotV1;
};

/** P2 final closure: OpenCode auth method — the REAL contract is
 *  `{ type: "oauth" | "api", label }`; a method is identified by its
 *  STABLE LIST INDEX within the discovery snapshot, never a synthesized
 *  string id. `requiresPrompt` marks methods Tenvyr will not drive (fail
 *  closed -> guided official login command). */
export type OpenCodeAuthMethodV1 = {
  methodIndex: number;
  type: "oauth" | "api";
  label: string;
  requiresPrompt: boolean;
};

/** Auth methods for ONE provider of ONE connection (OpenCode Server API). */
export type ProviderAuthMethodsV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  providerId: string;
  methods: OpenCodeAuthMethodV1[];
};

/** Bounded result of BEGINNING the runtime-owned auth flow. The same live
 *  management session completes the flow. `resumed` marks an idempotent
 *  Begin that returned an EXISTING compatible flow (no new session, no new
 *  authorize). */
export type OpenCodeAuthBeginV1 = {
  authFlowId: string;
  url: string;
  method: "auto" | "code";
  instructions: string | null;
  connectionId: string;
  connectionRevision: number;
  providerId: string;
  resumed?: boolean;
};

/** Post-PP1 hardening: bounded NON-SECRET view of one active unexpired
 *  auth flow — the browser-reload resume surface. NEVER carries the
 *  management-server password/token. */
export type ActiveAuthFlowV1 = {
  authFlowId: string;
  connectionId: string;
  connectionRevision: number;
  providerId: string;
  methodIndex: number;
  methodType: "oauth" | "api";
  methodLabel: string;
  url: string;
  authorizationMethod: "auto" | "code";
  instructions: string | null;
  expiresAt: number;
};

/** Bounded evidence of a REAL runtime invocation for a target. "ok" only
 *  on a bounded successful invocation — never a fabricated READY. */
export type TestTargetEvidenceV1 = {
  connectionId: string;
  revisionNumber: number;
  runtimeKind: string;
  requestedModelId: string | null;
  status: "ok" | "failed";
  exitCode: number | null;
  durationMs: number;
  outputTruncated: boolean;
};

export const MODEL_SOURCE_STATUS_STATES = [
  "UNKNOWN",
  "AVAILABLE",
  "AUTH_REQUIRED",
  "UNAVAILABLE",
  "DEGRADED",
] as const;
export type ModelSourceStatusState =
  (typeof MODEL_SOURCE_STATUS_STATES)[number];

export type ModelSourceV1 = {
  sourceId: string;
  kind: ModelSourceKind;
  displayName: string;
  baseUrl?: string;
  credentialEnvRef?: string;
  status: ModelSourceStatusState;
  reasonCode: string;
  lastTestedAt?: string;
  lastCatalogRefreshAt?: string;
  modelCount?: number;
  createdAt: string;
  updatedAt: string;
};

/** Bounded catalog entry — discovery data only, never execution authority. */
export type ModelCatalogEntryV1 = {
  modelId: string;
  displayName?: string;
  providerId?: string;
  source: string;
};

/** Bounded non-authoritative catalog snapshot (never persisted). */
export type ModelCatalogSnapshotV1 = {
  sourceId: string;
  discoveredAt: string;
  models: ModelCatalogEntryV1[];
  truncated?: boolean;
};

export type AcceptanceEvidenceV1 = {
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  requiredArtifacts?: string[];
};

export type StartTeamRunRequest = {
  idempotencyKey: string;
  name?: string;
  goal: string;
  config: CoordinationConfigV1;
  workspace?: { workspaceId?: string; path?: string };
  acceptanceEvidence?: AcceptanceEvidenceV1;
  /** PP1: execution isolation mode for the run's workspace (git-worktree =
   *  isolated Tenvyr-owned worktree; shared = run against the source tree).
   *  Only meaningful with a workspace. */
  executionIsolation?: "shared" | "git-worktree";
};

export type WorkbenchCommandResultV1<T = unknown> = {
  outcome: "executed" | "duplicate" | "rejected";
  action: string;
  /** P2 closure: the command envelope carries the idempotency key verbatim
   *  (parsed strictly by parseWorkbenchCommandResult — never optimistic). */
  idempotencyKey?: string;
  targetId?: string;
  result?: T;
  error?: {
    code: string;
    message: string;
  };
};

/** PP1 Slice B: exception-driven Attention queue (READ projection —
 *  items exist exactly while their durable source condition exists;
 *  deterministic ids; resolution goes through existing authority
 *  commands). */
export type AttentionItemV1 = {
  attentionId: string;
  kind:
    | "HUMAN_APPROVAL_REQUIRED"
    | "RUN_FAILED"
    | "LIMIT_REACHED"
    | "WORKSPACE_REQUIRES_ATTENTION"
    | string;
  severity: "critical" | "warning" | "info";
  executionId: string | null;
  runId: string | null;
  reason: string;
  createdAt: string;
  updatedAt: string;
  actionRoute: string;
  workspaceExecutionId?: string;
};

export type AttentionViewV1 = {
  items: AttentionItemV1[];
  serverTime: string;
};

export type WorkbenchExecutionSummaryV1 = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  terminationReason: string | null;
  coordinationPhase: string | null;
  iterationNumber: number | null;
  stepCount: number;
};

export type PlannedTaskV1 = {
  taskId: string;
  agent: string;
  connectionId?: string;
  required: boolean;
  dependsOn: string[];
  reason: string;
};

export type PlannedBatchV1 = {
  reason: string;
  tasks: PlannedTaskV1[];
};

export type IterationWorkerV1 = {
  taskId: string;
  logicalStepId: string;
  required: boolean;
  status: string;
};

export type DecisionRecommendationV1 = {
  reason: string;
  focus: string[];
};

export type ProjectedIterationV1 = {
  iterationNumber: number;
  plannerStepId: string | null;
  plannerProposal: PlannedBatchV1 | null;
  workerManifest: IterationWorkerV1[];
  verifierStepId: string | null;
  decisionAction:
    | "ACCEPT"
    | "CONTINUE"
    | "FAIL"
    | "WAIT_FOR_HUMAN"
    | string
    | null;
  decisionReason: string | null;
  decisionRecommendation: DecisionRecommendationV1 | null;
  decisionHash: string | null;
  outcome: string | null;
};

export type CoordinationRunViewV1 = {
  runId: string;
  phase:
    | "PLANNING"
    | "BATCH_VALIDATION"
    | "WORKING"
    | "VERIFYING"
    | "DECIDING"
    | "WAITING_FOR_HUMAN"
    | "ACCEPTED"
    | "FAILED"
    | "CANCELLED"
    | "LIMIT_REACHED"
    | string;
  currentIterationNumber: number;
  cumulativeWorkers: number;
  maxIterations: number;
  maxWorkersPerIteration: number;
  maxTotalWorkers: number;
  remainingDeadlineMs: number;
  budgetAccountId: string | null;
  waitReason: string | null;
  workspace: WorkspaceSnapshotV1 | null;
  acceptanceEvidence: AcceptanceEvidenceV1 | null;
  /** PP1: the run's Tenvyr-owned execution workspace lease (where every
   *  runtime child actually executed); null for runs without one. */
  executionWorkspace: {
    workspaceExecutionId: string;
    mode: "shared" | "git-worktree" | string;
    path: string;
    baseBranch: string | null;
    baseHeadSha: string | null;
    state: string;
    hasUncommittedWork: boolean | null;
  } | null;
};

export type AttemptSummaryV1 = {
  stepId: string;
  attemptNumber: number;
  status: string;
  terminalAt: string | null;
  error: string | null;
  /** P2: frozen requested model for this attempt (absent = Runtime
   *  default). Exact execution provenance. */
  requestedModelId?: string;
  /** P2: bounded observed model ONLY when the runtime/worker itself
   *  reported it inside the attempt result — never fabricated. */
  observedModelId?: string;
  /** P3: bounded immutable efficiency evidence when the attempt recorded
   *  one (hashes/sizes/counts/ids + observed usage only). Absent =
   *  pre-P3 row or no projection. */
  efficiency?: WorkbenchAttemptEfficiencyV1;
};

/** P3: bounded attempt-level efficiency projection. */
export type WorkbenchAttemptEfficiencyV1 = {
  contextBundleHash: string | null;
  contextBundleReused: boolean | null;
  projectedBytes: number | null;
  projectedCharacters: number | null;
  selectedContextItemCount: number | null;
  selectedArtifactCount: number | null;
  sessionMode: string;
  usageReported: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  connectionId?: string;
  workspaceId?: string;
};

/** P3: bounded execution-level efficiency aggregate (real data only —
 *  absent bundles/usage are counted, never invented). */
export type WorkbenchEfficiencyAggregateV1 = {
  attemptCount: number;
  bundleAttempts: number;
  bundlesReused: number;
  bundlesBuilt: number;
  projectedTotalBytes: number;
  providerCacheEvidenceAttempts: number;
  providerCacheHitAttempts: number;
  runtimeDurationMs: number | null;
  truncated: boolean;
};

export type ArtifactRefV1 = {
  artifactId: string;
  descriptorOrdinal: number;
  descriptorHash: string;
};

export type WorkbenchExecutionProjectionV1 = {
  schemaVersion: 1;
  serverTime: string;
  execution: {
    id: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    terminationReason: string | null;
    goal: { preview: string; truncated: boolean };
    planRevisionCount: number;
    activePlanRevisionId: string | null;
  };
  coordination: {
    run: CoordinationRunViewV1;
    iterations: ProjectedIterationV1[];
    truncated: boolean;
  } | null;
  attempts: AttemptSummaryV1[];
  attemptsTruncated: boolean;
  /** P3: bounded execution-level efficiency aggregate (real data only). */
  efficiency: WorkbenchEfficiencyAggregateV1;
  approvals: { pending: number; decided: number };
  artifacts: ArtifactRefV1[];
  artifactsTruncated: boolean;
  delegation: {
    supervisedTotal: number;
    observedTotal: number;
    truncated: boolean;
  };
  capsule: { contentHash: string | null } | null;
  bounds: {
    maxExecutionsPerPage: number;
    maxGoalChars: number;
    maxIterations: number;
    maxWorkersPerIteration: number;
    maxAttemptsPerExecution: number;
    maxArtifactRefs: number;
    maxReasonChars: number;
    maxNameChars: number;
  };
};

export type CapsuleSummaryV1 = {
  schemaVersion: number;
  pointInTime: string;
  sourceStatus: string;
  contentHash: string;
  header: {
    stepCount: number;
    revisionCount: number;
    attemptCount: number;
    budget?: unknown;
    policy?: unknown;
    approvals?: unknown;
    delegation?: unknown;
    artifacts?: unknown;
  };
  coordination: {
    run: CoordinationRunViewV1;
    iterations: unknown[];
  } | null;
  evidenceCompleteness: string[];
};

export type AuditItemV1 = {
  id: string;
  action: string;
  targetId: string | null;
  idempotencyKey: string;
  createdAt: string;
  outcome: unknown;
};

/* Legacy Pipeline types */
export type PipelineStep = {
  id: string;
  agent?: string;
  dependsOn?: string[];
  condition?: string;
  input?: Record<string, unknown>;
  timeout?: string;
  retries?: number;
  onFailure?: string;
  metadata?: Record<string, unknown>;
};

export type Pipeline = {
  id: string;
  name: string;
  version: string;
  description?: string;
  steps?: PipelineStep[];
};

export type StepAttempt = {
  id: string;
  attemptNumber: number;
  status: string;
  invocationId: string;
  dispatchedAt?: string;
  startTime?: string;
  terminalAt?: string;
  error?: string | null;
};

export type StepExecution = {
  id: string;
  stepId: string;
  agent: string;
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  errorCode?: string;
  failureCode?: string;
  attempt?: number;
  maxAttempts?: number;
  startTime?: string;
  endTime?: string;
  attempts?: StepAttempt[];
};

export type LegacyExecution = {
  id: string;
  pipelineId: string;
  status: string;
  startTime: string;
  endTime?: string;
  terminationReason?: string | null;
  steps?: StepExecution[];
};
