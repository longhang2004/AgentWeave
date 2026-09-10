import { Inject, Injectable } from "@nestjs/common";
import { AGENT_ADAPTER } from "../agent-adapters/agent-adapter";
import { AgentAdapterError } from "../agent-adapters/agent-adapter.errors";
import type { AgentAdapter } from "../agent-adapters/agent-adapter.types";
import { PipelineService } from "./pipeline.service";
import { ExecutionService } from "./execution.service";
import {
  ExecutionEntity,
  type ExecutionStatus,
} from "../entities/execution.entity";
import {
  LogicalStepEntity,
  type StepExecutionEntity,
  type StepStatus,
} from "../entities/step-execution.entity";
import type { PipelineStepConfig } from "../domain/pipeline-definition";
import { ContextProjectionError } from "../domain/context-snapshot";
import { DispatchOutboxService } from "./dispatch-outbox.service";

type TemplateContext = {
  pipeline: {
    input: unknown;
  };
  steps: Record<
    string,
    {
      result: unknown;
      output: unknown;
      status: StepStatus;
      error?: string;
      attempt?: number;
    }
  >;
};

const TERMINAL_STEP_STATUSES: StepStatus[] = [
  "COMPLETED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
];

const TERMINAL_EXECUTION_STATUSES: ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

// ponytail: hard ceiling on sequential claim waves inside one reconciliation.
// Each pass claims >= 1 step or makes a terminal transition; a pathological
// chain longer than the ceiling (requires retries >= 99 on a step) is picked
// up by the next recovery tick, which re-runs reconcileExecution.
const RECONCILE_PASS_LIMIT = 100;

export type ReconcileOptions = {
  /** Best-effort Gateway projection even when the execution is terminal. */
  projectTerminal?: boolean;
};

@Injectable()
export class EngineService {
  constructor(
    private pipelineService: PipelineService,
    /** M6-S2: the engine's execution service (delegation materializes
     *  children through it). */
    readonly executionService: ExecutionService,
    @Inject(AGENT_ADAPTER)
    private agentAdapter: AgentAdapter,
    private readonly dispatchOutbox: DispatchOutboxService,
  ) {}

  /**
   * Engine-level execution reconciliation. Given PostgreSQL's current
   * authoritative state, makes every currently legal autonomous orchestration
   * decision until no immediately actionable transition remains:
   *
   * - promotes recoverable PENDING startup state, backfills missing logical
   *   step rows, and advances dependency-resolved PENDING steps to READY;
   * - identifies due READY/RETRYING steps, materializes their input templates
   *   at this scheduling boundary, and claims them transactionally through
   *   the StepAttempt + DispatchOutbox primitive (freezing the spec on first
   *   claim and persisting condition-skip decisions);
   * - detects completion and stop-policy inability-to-continue from durable
   *   logical-step state alone — no caller-provided step context;
   * - pokes the dispatch outbox after committed claims, settling
   *   non-retryable transport failures per the workflow failure policy.
   *
   * Idempotent, and safe to call concurrently from multiple Orchestrator
   * replicas: claims use FOR UPDATE SKIP LOCKED and every transition is
   * guarded. Terminal executions are left untouched except for best-effort
   * projection when `projectTerminal` is set.
   */
  async reconcileExecution(
    executionId: string,
    options: ReconcileOptions = {},
  ): Promise<void> {
    let progressed = false;
    const affectedExecutions = new Set<string>();
    for (let pass = 0; pass < RECONCILE_PASS_LIMIT; pass++) {
      const madeProgress = await this.reconcilePass(
        executionId,
        affectedExecutions,
      );
      progressed = progressed || madeProgress;
      if (!madeProgress) break;
    }
    if (progressed) {
      await this.notifyGatewayUpdate(executionId);
    } else if (options.projectTerminal) {
      const execution = await this.executionService.getExecution(executionId);
      if (execution && TERMINAL_EXECUTION_STATUSES.includes(execution.status)) {
        await this.notifyGatewayUpdate(executionId);
      }
    }
    // Reconcile/project the executions that ACTUALLY own a terminal dispatch
    // failure committed during this reconciliation. With targeted dispatch
    // that is normally the current execution (already settled by the loop);
    // the set covers compatibility paths where the dispatcher reports a
    // different owner. // ponytail: one extra level only — deeper cross-
    // execution chains surface via the recovery tick, which reconciles each
    // candidate independently.
    for (const affected of affectedExecutions) {
      if (affected !== executionId) {
        await this.reconcileExecution(affected, { projectTerminal: true });
      }
    }
  }

  /**
   * @deprecated Kept for protocol/API compatibility only. Progression is
   * driven entirely by durable state: the ResultInbox commit is the trigger
   * and `reconcileExecution` derives all next work from PostgreSQL. The step
   * ID is not a source of scheduler truth.
   */
  async resumeAfterResult(executionId: string, _stepId: string): Promise<void> {
    await this.reconcileExecution(executionId, { projectTerminal: true });
  }

  async startExecution(
    pipelineId: string,
    input: unknown,
  ): Promise<ExecutionEntity> {
    const pipeline = await this.pipelineService.findOne(pipelineId);
    if (!pipeline) {
      throw new Error(`Pipeline with ID ${pipelineId} not found.`);
    }

    const execution = await this.executionService.createExecution(
      pipeline,
      input,
    );
    console.log(
      `Starting execution [${execution.id}] for pipeline [${pipeline.name}]`,
    );

    // Promotion to RUNNING, root-step advancement, claiming, and dispatch all
    // flow through the same durable reconciliation path; a crash anywhere
    // before or during it is repaired by runtime recovery.
    await this.reconcileExecution(execution.id);

    const reloaded = await this.executionService.getExecution(execution.id);
    if (!reloaded) return execution;
    if (reloaded.status === "PENDING") {
      return this.failExecution(execution.id, {
        error: "No initial steps found without dependencies.",
      });
    }
    return reloaded;
  }

  async cancelExecution(executionId: string): Promise<ExecutionEntity> {
    const execution = await this.executionService.cancelExecution(executionId);
    await this.notifyGatewayUpdate(executionId);
    // M3-S2: after Tenvyr cancellation is committed (attempts/execution
    // CANCELLED, outbox retired), best-effort executor notification for
    // dispatched attempts, gated by the frozen descriptor's cancel capability
    // and the adapter's optional cancel method. Outcomes are durable evidence
    // on the outbox rows; a failure here can never reverse or block the
    // committed cancellation (notifyCancel never throws, and this guard keeps
    // it that way even if a future bug surfaces).
    try {
      await this.dispatchOutbox.notifyCancel(
        executionId,
        execution.terminationReason ?? "Execution cancelled",
      );
    } catch (error) {
      console.warn("Best-effort executor cancel notification failed", {
        executionId,
        reason: this.getErrorMessage(error),
      });
    }
    return execution;
  }

  /**
   * @deprecated Compatibility/test helper only; not wired into the
   * authoritative AgentResult path. Canonical result application is
   * `ResultInboxService.apply` followed by `reconcileExecution`.
   */
  async handleStepCompletion(
    executionId: string,
    stepId: string,
    status: StepStatus,
    output?: unknown,
    error?: string,
    attempt?: number,
  ) {
    console.log(
      `Step [${stepId}] in execution [${executionId}] completed with status [${status}]`,
    );

    const currentStep = await this.executionService.getStepExecution(
      executionId,
      stepId,
    );
    if (!currentStep) {
      console.warn(
        `Ignoring result for unknown step [${stepId}] in execution [${executionId}]`,
      );
      return;
    }

    if (attempt !== undefined && currentStep.attempt !== attempt) {
      console.warn(
        `Ignoring stale result for step [${stepId}] in execution [${executionId}]. Received attempt ${attempt}, current attempt ${currentStep.attempt}.`,
      );
      return;
    }

    if (TERMINAL_STEP_STATUSES.includes(currentStep.status)) {
      console.warn(
        `Ignoring duplicate terminal update for step [${stepId}] in execution [${executionId}]`,
      );
      return;
    }

    await this.executionService.updateStepStatus(
      executionId,
      stepId,
      status,
      output,
      error,
    );
    await this.notifyGatewayUpdate(executionId);

    if (status === "CANCELLED") {
      await this.cancelExecution(executionId);
      return;
    }

    const execution = await this.executionService.getExecution(executionId);
    if (!execution || execution.status !== "RUNNING") return;

    const steps = await this.executionService.getExecutionPlanSteps(execution);
    const stepConfig = steps.find((step) => step.id === stepId);

    if (status === "FAILED") {
      const shouldContinue = await this.handleFailurePolicy(
        execution,
        stepConfig,
        error,
      );
      if (!shouldContinue) return;
    }

    await this.processExecutionProgress(execution, steps, stepId);
  }

  /**
   * One reconciliation pass over an execution: advance state, detect
   * terminal-worthy conditions from durable rows, then claim and dispatch
   * every due step. Returns whether any state transition happened.
   * `affectedExecutions` collects the execution IDs that actually own a
   * terminal dispatch failure committed during this pass (for targeted
   * dispatch that is always the execution being reconciled).
   */
  private async reconcilePass(
    executionId: string,
    affectedExecutions: Set<string>,
  ): Promise<boolean> {
    await this.executionService.reconcileExecution(executionId);
    // M9-S4: the deterministic Coordinator loop makes its autonomous
    // decisions from PostgreSQL (planner result -> batch, fan-in ->
    // VERIFYING, verifier result -> decision consume, terminal
    // propagation). True progress re-runs the pass so new work schedules.
    if (await this.executionService.reconcileCoordination(executionId)) {
      return true;
    }
    const execution = await this.executionService.getExecution(executionId);
    if (!execution || execution.status !== "RUNNING") return false;
    // Without an active plan revision there is nothing authoritative to
    // schedule against; leave the run for manual intervention instead of
    // throwing on every pass.
    if (!execution.activePlanRevisionId) return false;

    const steps = await this.executionService.getExecutionPlanSteps(execution);
    const logicalSteps =
      await this.executionService.getStepExecutions(executionId);

    // Stop-policy failure and cancellation leave nothing schedulable: the
    // execution must not stay RUNNING. The inbox and dispatch paths commit
    // these transitions atomically; this is the safety net for legacy entry
    // points and manual state edits.
    for (const step of logicalSteps) {
      if (step.status !== "FAILED") continue;
      const config = steps.find((candidate) => candidate.id === step.stepId);
      if (config?.onFailure === "continue") continue;
      await this.failExecution(execution.id, {
        failedStep: step.stepId,
        error: step.error ?? "Step failed with stop policy.",
        attempts: step.attempt,
        maxAttempts: step.maxAttempts,
      });
      return true;
    }
    if (logicalSteps.some((step) => step.status === "CANCELLED")) {
      await this.cancelExecution(execution.id);
      return true;
    }

    if (
      steps.length > 0 &&
      steps.every((config) => {
        const step = logicalSteps.find(
          (candidate) => candidate.stepId === config.id,
        );
        return step && TERMINAL_STEP_STATUSES.includes(step.status);
      })
    ) {
      // M9-S2 completion hold: a live coordination loop (or an unconsumed
      // Verifier decision) keeps the Execution from completing until the
      // Coordinator terminalizes. Non-coordinated executions are unaffected.
      if (await this.executionService.isCoordinationCompletionHeld(execution.id)) {
        return true;
      }
      const outputs: Record<string, unknown> = {};
      for (const step of logicalSteps) outputs[step.stepId] = step.output;
      await this.executionService.updateExecutionStatus(
        execution.id,
        "COMPLETED",
        outputs,
      );
      return true;
    }

    const now = new Date();
    const due = logicalSteps
      .filter(
        (step) =>
          (step.status === "READY" &&
            (step.eligibleAt === null ||
              step.eligibleAt === undefined ||
              step.eligibleAt <= now)) ||
          (step.status === "RETRYING" &&
            (step.nextAttemptAt === null ||
              step.nextAttemptAt === undefined ||
              step.nextAttemptAt <= now)),
      )
      .sort((a, b) =>
        a.createdAt < b.createdAt
          ? -1
          : a.createdAt > b.createdAt
            ? 1
            : a.id < b.id
              ? -1
              : 1,
      );

    let progressed = false;
    for (const logicalStep of due) {
      const config = steps.find(
        (candidate) => candidate.id === logicalStep.stepId,
      );
      if (!config) continue;

      // Template materialization happens at this scheduling boundary, before
      // the attempt claim. A failure here is an orchestration/configuration
      // failure of the run, not a step execution failure: the execution
      // FAILED and no onFailure retry/continue semantics apply (no fake
      // attempts are created to consume retry budgets).
      let resolvedInput: unknown;
      try {
        resolvedInput = this.resolveInputTemplates(
          config.input || {},
          execution.input,
          logicalSteps,
        );
        // M9-S4: a Coordinator-owned Verifier step receives the bounded
        // aggregation and typed VerifierInvocationInputV1 as its frozen input
        // (built at claim time — later outcomes can never change a frozen attempt).
        if (
          await this.executionService.isCoordinationVerifierStep(
            execution.id,
            config.id,
          )
        ) {
          const context = (await this.executionService.buildVerifierInput(
            execution.id,
            config.id,
          )) as import("../domain/coordination").VerifierContextV1;
          const execInput = (execution.input ?? {}) as Record<string, unknown>;
          const goal = typeof execInput.goal === "string" ? execInput.goal : "";
          resolvedInput = {
            schemaVersion: 1,
            role: "verifier",
            goal,
            iterationNumber: context.iterationNumber,
            context,
            ...(context.workspace ? { workspace: context.workspace } : {}),
            outputContract: {
              schema: "VerifierDecisionV1",
              instructions:
                'Evaluate the iteration outcome and return a VerifierDecisionV1 JSON object with schemaVersion: 1, iterationId, iterationNumber, action ("ACCEPT", "CONTINUE", or "FAIL"), reason, and evidenceRefs.',
            },
          };
        }
      } catch (err) {
        await this.failExecution(execution.id, {
          failedStep: config.id,
          error: `Input resolution failed: ${this.getErrorMessage(err)}`,
        });
        return true;
      }

      const maxAttempts = this.getMaxAttempts(config);
      const timeoutMs = this.parseDurationMs(config.timeout);
      const deadlineAt = timeoutMs
        ? new Date(Date.now() + timeoutMs)
        : undefined;
      const claim = await this.claimWithProjectionFailure(
        execution.id,
        config,
        resolvedInput,
        maxAttempts,
        deadlineAt,
      );
      if (!claim) continue; // a concurrent replica won this scheduling decision
      if (claim.disposition === "projection_failed") {
        // The claim transaction already persisted the failed pre-dispatch
        // attempt and applied retry/continue/stop. Reconcile again so a retry
        // or a dependent of an onFailure:continue step can advance.
        progressed = true;
        continue;
      }
      progressed = true;
      if (claim.disposition === "skipped") {
        console.log(
          `Step [${config.id}] condition evaluated to false. Skipping step.`,
        );
        continue;
      }
      if (
        claim.disposition === "budget_insufficient" ||
        claim.disposition === "policy_denied" ||
        claim.disposition === "approval_required" ||
        claim.disposition === "runtime_capability" ||
        claim.disposition === "authority_expired"
      ) {
        // The budget/policy/approval/capability outcome already
        // transitioned the attempt/step; nothing to dispatch.
        progressed = true;
        continue;
      }
      console.log(
        `Triggering step [${config.id}] for agent [${config.agent}] in execution [${execution.id}]`,
      );
      const affected = await this.dispatchClaimedStep(
        execution.id,
        claim.attempt.id,
        claim.logicalStep,
        config,
      );
      if (affected && affected !== execution.id) {
        affectedExecutions.add(affected);
      }
    }
    return progressed;
  }

  /**
   * Claim-specific dispatch: the immediate delivery targets the outbox row of
   * the StepAttempt that was JUST claimed, never a globally-older record of a
   * different execution. A retryable transport failure leaves the record
   * PENDING for a later tick or replica; a non-retryable failure has already
   * been committed per the workflow failure policy, and the execution ID that
   * ACTUALLY owns the failed attempt is returned so the caller can
   * reconcile/project it.
   */
  private async dispatchClaimedStep(
    executionId: string,
    stepAttemptId: string,
    logicalStep: LogicalStepEntity,
    stepConfig: PipelineStepConfig,
  ): Promise<string | null> {
    try {
      const disposition =
        await this.dispatchOutbox.dispatchAttempt(stepAttemptId);
      if (disposition.outcome === "terminal_failure") {
        console.error("Non-retryable dispatch failure committed", {
          executionId: disposition.executionId,
          stepExecutionId: logicalStep.id,
          stepId: stepConfig.id,
          attempt: logicalStep.attempt,
        });
        return disposition.executionId;
      }
    } catch (err) {
      const adapterError = err instanceof AgentAdapterError ? err : undefined;
      console.error(
        "Agent invocation dispatch failed (outbox remains pending)",
        {
          adapter: this.agentAdapter.kind,
          errorCode: adapterError?.code,
          retryable: adapterError?.retryable,
          invocationId: adapterError?.invocationId,
          executionId,
          stepExecutionId: logicalStep.id,
          agent: stepConfig.agent,
          attempt: logicalStep.attempt,
        },
      );
    }
    return null;
  }

  /**
   * Claim with M2C deterministic projection-failure routing. The normal claim
   * path persists a FAILED pre-dispatch attempt and applies the frozen step's
   * retry/continue/stop policy atomically without an outbox. The catch remains
   * a defensive fallback for a ContextProjectionError raised outside that
   * reviewed transaction path; any other error propagates.
   */
  private async claimWithProjectionFailure(
    executionId: string,
    stepConfig: PipelineStepConfig,
    resolvedInput: unknown,
    maxAttempts: number,
    deadlineAt?: Date,
  ) {
    try {
      return await this.executionService.claimRunnableStep(
        executionId,
        stepConfig,
        resolvedInput,
        maxAttempts,
        deadlineAt,
      );
    } catch (err) {
      if (err instanceof ContextProjectionError) {
        await this.failExecution(executionId, {
          failedStep: stepConfig.id,
          error: `Context projection failed: ${err.code}`,
        });
        return { disposition: "projection_failed" as const };
      }
      throw err;
    }
  }

  private async handleFailurePolicy(
    execution: ExecutionEntity,
    stepConfig: PipelineStepConfig | undefined,
    error?: string,
  ): Promise<boolean> {
    if (!stepConfig) {
      await this.failExecution(execution.id, {
        error:
          error ||
          "Step execution failed and step configuration was not found.",
      });
      return false;
    }

    const policy = stepConfig.onFailure || "stop";
    const currentStep = await this.executionService.getStepExecution(
      execution.id,
      stepConfig.id,
    );
    const maxAttempts = this.getMaxAttempts(stepConfig);

    if (
      policy === "retry" &&
      currentStep &&
      currentStep.attempt < maxAttempts
    ) {
      console.log(
        `Retrying step [${stepConfig.id}] in execution [${execution.id}] after failed attempt ${currentStep.attempt}/${maxAttempts}`,
      );
      await this.triggerStep(execution, stepConfig, { force: true });
      return false;
    }

    if (policy === "continue") {
      console.log(
        `Continuing execution [${execution.id}] after failed step [${stepConfig.id}]`,
      );
      return true;
    }

    await this.failExecution(execution.id, {
      failedStep: stepConfig.id,
      error: error || "Step execution failed.",
      attempts: currentStep?.attempt ?? 1,
      maxAttempts,
    });
    return false;
  }

  /**
   * @deprecated Legacy progression helper used only by `handleStepCompletion`;
   * the authoritative path is `reconcileExecution`.
   */
  private async processExecutionProgress(
    execution: ExecutionEntity,
    steps: PipelineStepConfig[],
    completedStepId: string,
  ): Promise<boolean> {
    const stepExecutions = await this.executionService.getStepExecutions(
      execution.id,
    );

    if (stepExecutions.some((step) => step.status === "CANCELLED")) {
      await this.cancelExecution(execution.id);
      return true;
    }

    const allStepsCompleted = steps.every((stepConfig) => {
      const stepExecution = stepExecutions.find(
        (step) => step.stepId === stepConfig.id,
      );
      return (
        stepExecution && TERMINAL_STEP_STATUSES.includes(stepExecution.status)
      );
    });

    if (allStepsCompleted) {
      console.log(
        `All steps completed. Completing execution [${execution.id}]`,
      );
      const outputs: Record<string, unknown> = {};
      for (const stepExecution of stepExecutions) {
        outputs[stepExecution.stepId] = stepExecution.output;
      }
      await this.executionService.updateExecutionStatus(
        execution.id,
        "COMPLETED",
        outputs,
      );
      await this.notifyGatewayUpdate(execution.id);
      return true;
    }

    const nextSteps = steps.filter((step) =>
      step.dependsOn?.includes(completedStepId),
    );

    let progressed = false;
    for (const nextStep of nextSteps) {
      const existingStep = await this.executionService.getStepExecution(
        execution.id,
        nextStep.id,
      );
      if (existingStep && existingStep.status !== "READY") continue;

      const dependenciesResolved = nextStep.dependsOn?.every((dependencyId) => {
        const dependencyExecution = stepExecutions.find(
          (step) => step.stepId === dependencyId,
        );
        return this.isDependencyResolved(dependencyExecution, steps);
      });

      if (!dependenciesResolved) continue;

      if (await this.triggerStep(execution, nextStep)) progressed = true;
    }
    return progressed;
  }

  private async triggerStep(
    execution: ExecutionEntity,
    stepConfig: PipelineStepConfig,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!options.force) {
      const existingStep = await this.executionService.getStepExecution(
        execution.id,
        stepConfig.id,
      );
      if (existingStep && existingStep.status !== "READY") return false;
    }

    console.log(
      `Triggering step [${stepConfig.id}] for agent [${stepConfig.agent}] in execution [${execution.id}]`,
    );

    const maxAttempts = this.getMaxAttempts(stepConfig);
    const timeoutMs = this.parseDurationMs(stepConfig.timeout);
    const deadlineAt = timeoutMs ? new Date(Date.now() + timeoutMs) : undefined;
    let resolvedInput: unknown;

    try {
      const stepExecutions = await this.executionService.getStepExecutions(
        execution.id,
      );
      resolvedInput = this.resolveInputTemplates(
        stepConfig.input || {},
        execution.input,
        stepExecutions,
      );
    } catch (err) {
      const message = this.getErrorMessage(err);
      await this.failExecution(execution.id, {
        failedStep: stepConfig.id,
        error: `Input resolution failed: ${message}`,
      });
      return true;
    }

    const claim = await this.claimWithProjectionFailure(
      execution.id,
      stepConfig,
      resolvedInput,
      maxAttempts,
      deadlineAt,
    );
    if (!claim) return false;
    if (claim.disposition === "projection_failed") {
      return true; // the execution already FAILED through the deterministic policy
    }
    if (
      claim.disposition === "budget_insufficient" ||
      claim.disposition === "policy_denied" ||
      claim.disposition === "approval_required" ||
      claim.disposition === "runtime_capability" ||
      claim.disposition === "authority_expired"
    ) {
      return true; // the attempt/step already transitioned deterministically
    }
    if (claim.disposition === "skipped") {
      console.log(
        `Step [${stepConfig.id}] condition evaluated to false. Skipping step.`,
      );
      await this.notifyGatewayUpdate(execution.id);
      const steps =
        await this.executionService.getExecutionPlanSteps(execution);
      await this.processExecutionProgress(execution, steps, stepConfig.id);
      return true;
    }
    const stepExecution = claim.logicalStep;
    await this.notifyGatewayUpdate(execution.id);
    try {
      // Claim-specific dispatch: deliver THIS attempt's own outbox row, and
      // reconcile/project the execution that actually owns a terminal
      // failure — never assume it is the local execution.
      const disposition = await this.dispatchOutbox.dispatchAttempt(
        claim.attempt.id,
      );
      if (disposition.outcome === "terminal_failure") {
        await this.reconcileExecution(disposition.executionId, {
          projectTerminal: true,
        });
      }
    } catch (err) {
      const message = this.getErrorMessage(err);
      const adapterError = err instanceof AgentAdapterError ? err : undefined;
      console.error("Agent invocation dispatch failed", {
        adapter: this.agentAdapter.kind,
        errorCode: adapterError?.code,
        retryable: adapterError?.retryable,
        invocationId: adapterError?.invocationId,
        executionId: execution.id,
        stepExecutionId: stepExecution.id,
        agent: stepConfig.agent,
        attempt: stepExecution.attempt,
      });
    }
    return true;
  }

  private isDependencyResolved(
    dependencyExecution: StepExecutionEntity | undefined,
    steps: PipelineStepConfig[],
  ): boolean {
    if (!dependencyExecution) return false;
    if (
      dependencyExecution.status === "COMPLETED" ||
      dependencyExecution.status === "SKIPPED"
    )
      return true;
    if (dependencyExecution.status !== "FAILED") return false;

    const dependencyConfig = steps.find(
      (step) => step.id === dependencyExecution.stepId,
    );
    return dependencyConfig?.onFailure === "continue";
  }

  private resolveInputTemplates(
    inputConfig: unknown,
    pipelineInput: unknown,
    stepExecutions: StepExecutionEntity[],
  ): unknown {
    return this.resolveTemplateValue(
      inputConfig,
      this.buildTemplateContext(pipelineInput, stepExecutions),
    );
  }

  private resolveTemplateValue(
    value: unknown,
    context: TemplateContext,
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.resolveTemplateValue(item, context));
    }

    if (value && typeof value === "object") {
      const resolvedObject: Record<string, unknown> = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        resolvedObject[key] = this.resolveTemplateValue(nestedValue, context);
      }
      return resolvedObject;
    }

    if (typeof value !== "string") return value;

    const exactMatch = value.match(/^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/);
    if (exactMatch) {
      const resolvedValue = this.resolveTemplateExpression(
        exactMatch[1],
        context,
      );
      return resolvedValue === undefined ? null : resolvedValue;
    }

    return value.replace(
      /\{\{\s*([^{}]+?)\s*\}\}/g,
      (_match, expression: string) => {
        const resolvedValue = this.resolveTemplateExpression(
          expression,
          context,
        );
        if (resolvedValue === undefined || resolvedValue === null) return "";
        if (typeof resolvedValue === "string") return resolvedValue;
        return JSON.stringify(resolvedValue);
      },
    );
  }

  private buildTemplateContext(
    pipelineInput: unknown,
    stepExecutions: StepExecutionEntity[],
  ): TemplateContext {
    const steps: TemplateContext["steps"] = {};

    for (const stepExecution of stepExecutions) {
      steps[stepExecution.stepId] = {
        result: stepExecution.output,
        output: stepExecution.output,
        status: stepExecution.status,
        error: stepExecution.error,
        attempt: stepExecution.attempt,
      };
    }

    return {
      pipeline: {
        input: pipelineInput,
      },
      steps,
    };
  }

  private resolveTemplateExpression(
    expression: string,
    context: TemplateContext,
  ): unknown {
    const path = expression.trim().split(".");
    return this.getValueFromPath(context, path);
  }

  private getValueFromPath(obj: unknown, pathParts: string[]): unknown {
    let current = obj as Record<string, unknown> | undefined | null;
    for (const part of pathParts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part] as
        | Record<string, unknown>
        | undefined
        | null;
    }
    return current;
  }

  private getMaxAttempts(stepConfig: PipelineStepConfig): number {
    const retries = Number(stepConfig.retries ?? 0);
    return Math.max(
      1,
      1 + (Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0),
    );
  }

  private parseDurationMs(
    duration: string | number | undefined,
  ): number | null {
    if (duration === undefined || duration === null) return null;
    if (typeof duration === "number") return duration > 0 ? duration : null;

    const match = duration.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
    if (!match) return null;

    const value = Number(match[1]);
    const unit = (match[2] || "ms").toLowerCase();
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60_000,
      h: 3_600_000,
    };

    return value * multipliers[unit];
  }

  private async failExecution(
    executionId: string,
    output: Record<string, unknown>,
  ): Promise<ExecutionEntity> {
    const failedExecution = await this.executionService.updateExecutionStatus(
      executionId,
      "FAILED",
      output,
    );
    await this.notifyGatewayUpdate(executionId);
    return failedExecution;
  }

  private async notifyGatewayUpdate(executionId: string) {
    try {
      // Internal loopback default — explicit IPv4, never localhost
      // address-family dependent; GATEWAY_URL override preserved.
      const gatewayUrl = process.env.GATEWAY_URL || "http://127.0.0.1:3000";
      const response = await fetch(
        `${gatewayUrl}/api/webhooks/execution-update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ executionId }),
        },
      );

      if (!response.ok) {
        console.warn(`Gateway update webhook returned HTTP ${response.status}`);
      }
    } catch (err) {
      console.warn(
        "Failed to push execution status update webhook to gateway:",
        this.getErrorMessage(err),
      );
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
