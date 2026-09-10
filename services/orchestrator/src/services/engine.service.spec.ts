import { ContextProjectionError } from "../domain/context-snapshot";
import { EngineService } from "./engine.service";

const execution = {
  id: "execution-1",
  pipelineId: "pipeline-1",
  status: "RUNNING",
  input: { repository: "tenvyr" },
  activePlanRevisionId: "revision-1",
};

const stepConfig = {
  id: "review",
  agent: "code-reviewer",
  input: { code: "const safe = true;" },
  timeout: "30s",
  retries: 2,
  onFailure: "stop" as const,
};

const stepExecution = {
  id: "step-execution-1",
  executionId: "execution-1",
  stepId: "review",
  agent: "code-reviewer",
  status: "RUNNING",
  input: stepConfig.input,
  output: null,
  error: null,
  attempt: 1,
  maxAttempts: 3,
};

describe("EngineService behavior", () => {
  let pipelineService: any;
  let executionService: any;
  let transport: any;
  let outbox: any;
  let service: EngineService;

  beforeEach(() => {
    pipelineService = {
      findOne: jest.fn().mockResolvedValue({
        id: "pipeline-1",
        name: "review pipeline",
        steps: [stepConfig],
      }),
    };
    executionService = {
      getStepExecution: jest.fn().mockResolvedValue(stepExecution),
      getStepExecutions: jest
        .fn()
        .mockResolvedValue([
          { ...stepExecution, status: "COMPLETED", output: { score: 100 } },
        ]),
      updateStepStatus: jest.fn().mockResolvedValue(undefined),
      getExecution: jest.fn().mockResolvedValue(execution),
      getExecutionPlanSteps: jest.fn().mockResolvedValue([stepConfig]),
      updateExecutionStatus: jest
        .fn()
        .mockImplementation(async (_id, status, output) => ({
          ...execution,
          status,
          output,
        })),
      // M9-S2: non-coordinated executions are never held.
      isCoordinationCompletionHeld: jest.fn().mockResolvedValue(false),
      // M9-S4: no coordination run in the generic engine tests.
      reconcileCoordination: jest.fn().mockResolvedValue(false),
      isCoordinationVerifierStep: jest.fn().mockResolvedValue(false),
      buildVerifierInput: jest.fn().mockResolvedValue({}),
      createStepExecution: jest.fn().mockResolvedValue(stepExecution),
      claimRunnableStep: jest.fn().mockResolvedValue({
        disposition: "claimed",
        logicalStep: stepExecution,
        attempt: { id: "attempt-1", invocationId: "step-execution-1:1" },
      }),
      createSkippedLogicalStep: jest.fn().mockResolvedValue(undefined),
      reconcileExecution: jest
        .fn()
        .mockResolvedValue({ promoted: false, backfilled: 0, advanced: 0 }),
    };
    transport = {
      kind: "kafka",
      invoke: jest.fn().mockResolvedValue({
        adapter: "kafka",
        invocationId: "step-execution-1:1",
        dispatchedAt: "2026-07-26T00:00:00.100Z",
        messageKey: "execution-1",
      }),
      sendTask: jest.fn().mockResolvedValue(undefined),
    };
    outbox = {
      dispatchNext: jest.fn().mockResolvedValue({ outcome: "dispatched" }),
      dispatchAttempt: jest.fn().mockResolvedValue({ outcome: "dispatched" }),
      notifyCancel: jest
        .fn()
        .mockResolvedValue({ notified: 0, unsupported: 0, unreachable: 0 }),
    };
    service = new EngineService(
      pipelineService,
      executionService,
      transport,
      outbox as any,
    );
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as any;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("applies a successful result and completes the execution", async () => {
    await service.handleStepCompletion(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
      1,
    );

    expect(executionService.updateStepStatus).toHaveBeenCalledWith(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
    );
    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "COMPLETED",
      {
        review: { score: 100 },
      },
    );
  });

  it("applies a failed result through the existing stop policy", async () => {
    await service.handleStepCompletion(
      "execution-1",
      "review",
      "FAILED",
      undefined,
      "runner unavailable",
      1,
    );

    expect(executionService.updateStepStatus).toHaveBeenCalledWith(
      "execution-1",
      "review",
      "FAILED",
      undefined,
      "runner unavailable",
    );
    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "FAILED",
      expect.objectContaining({
        failedStep: "review",
        error: "runner unavailable",
      }),
    );
  });

  it("ignores a duplicate terminal result", async () => {
    executionService.getStepExecution.mockResolvedValue({
      ...stepExecution,
      status: "COMPLETED",
    });

    await service.handleStepCompletion(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
      1,
    );

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it("ignores a late result from an older attempt", async () => {
    executionService.getStepExecution.mockResolvedValue({
      ...stepExecution,
      attempt: 2,
    });

    await service.handleStepCompletion(
      "execution-1",
      "review",
      "COMPLETED",
      { score: 100 },
      undefined,
      1,
    );

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it("ignores a result for an unknown step", async () => {
    executionService.getStepExecution.mockResolvedValue(null);

    await service.handleStepCompletion(
      "execution-1",
      "missing",
      "COMPLETED",
      {},
      undefined,
      1,
    );

    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it("does not terminally fail an attempt when durable dispatch remains recoverable", async () => {
    executionService.getStepExecution
      .mockResolvedValueOnce(null)
      .mockResolvedValue(stepExecution);
    executionService.getStepExecutions.mockResolvedValue([]);
    const outbox = {
      dispatchNext: jest.fn().mockResolvedValue({ outcome: "idle" }),
      dispatchAttempt: jest
        .fn()
        .mockRejectedValue(new Error("producer unavailable")),
    };
    service = new EngineService(
      pipelineService,
      executionService,
      transport,
      outbox as any,
    );

    await (service as any).triggerStep(execution, {
      ...stepConfig,
      timeout: undefined,
    });

    expect(outbox.dispatchAttempt).toHaveBeenCalledWith("attempt-1");
    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it("delegates dispatch exclusively to the durable outbox", async () => {
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.getStepExecutions.mockResolvedValue([]);

    await (service as any).triggerStep(execution, stepConfig);

    // Claim-specific dispatch targets the attempt that was just claimed —
    // never the global oldest outbox row.
    expect(outbox.dispatchAttempt).toHaveBeenCalledWith("attempt-1");
    expect(outbox.dispatchNext).not.toHaveBeenCalled();
    // The engine never invokes the executor transport directly; the outbox
    // owns dispatch after the committed claim.
    expect(transport.invoke).not.toHaveBeenCalled();
    expect(transport.sendTask).not.toHaveBeenCalled();
  });

  it("leaves attempt state ownership to the durable dispatcher", async () => {
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.getStepExecutions.mockResolvedValue([]);

    await (service as any).triggerStep(execution, {
      ...stepConfig,
      timeout: undefined,
    });

    expect(outbox.dispatchAttempt).toHaveBeenCalledTimes(1);
    expect(transport.invoke).not.toHaveBeenCalled();
    expect(executionService.updateStepStatus).not.toHaveBeenCalled();
  });

  it("projects a terminal result to the Gateway even when progression never runs", async () => {
    executionService.getExecution.mockResolvedValue({
      ...execution,
      status: "FAILED",
    });

    await service.resumeAfterResult("execution-1", "review");

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/webhooks/execution-update",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ executionId: "execution-1" }),
      }),
    );
    // The terminal execution is left untouched by progression: the pass bails
    // before loading plan steps, and the best-effort projection is the only
    // side effect of resumeAfterResult.
    expect(executionService.reconcileExecution).toHaveBeenCalledWith(
      "execution-1",
    );
    expect(executionService.getExecutionPlanSteps).not.toHaveBeenCalled();
    expect(outbox.dispatchAttempt).not.toHaveBeenCalled();
  });

  it("reconciles a due READY step through the claim + outbox primitive", async () => {
    const stepRows: any[] = [
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ];
    executionService.getStepExecutions.mockResolvedValue(stepRows);
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.claimRunnableStep.mockImplementation(async () => {
      // Mirror the durable claim: the step leaves the schedulable set.
      stepRows[0].status = "RUNNING";
      return {
        disposition: "claimed",
        logicalStep: stepRows[0],
        attempt: { id: "attempt-1", invocationId: "logical-1:1" },
      };
    });

    await service.reconcileExecution("execution-1");

    expect(executionService.reconcileExecution).toHaveBeenCalledWith(
      "execution-1",
    );
    expect(executionService.claimRunnableStep).toHaveBeenCalledTimes(1);
    expect(executionService.claimRunnableStep).toHaveBeenCalledWith(
      "execution-1",
      stepConfig,
      stepConfig.input,
      3,
      expect.any(Date),
    );
    // The immediate dispatch targets the just-claimed attempt's own row.
    expect(outbox.dispatchAttempt).toHaveBeenCalledWith("attempt-1");
    expect(outbox.dispatchNext).not.toHaveBeenCalled();
    // The engine never invokes the executor transport directly.
    expect(transport.invoke).not.toHaveBeenCalled();
    // Progress was made, so the Gateway projection runs.
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/webhooks/execution-update",
      expect.anything(),
    );
  });

  it("routes a ContextProjectionError into the deterministic failure policy with no outbox (M2C)", async () => {
    const stepRows: any[] = [
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ];
    executionService.getStepExecutions.mockResolvedValue(stepRows);
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.claimRunnableStep.mockRejectedValue(
      new ContextProjectionError("TENVYR_CTX_MISSING_STATE_KEY"),
    );

    await service.reconcileExecution("execution-1");

    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "FAILED",
      expect.objectContaining({
        failedStep: "review",
        error: "Context projection failed: TENVYR_CTX_MISSING_STATE_KEY",
      }),
    );
    // A projection failure never creates a dispatch hand-off.
    expect(outbox.dispatchAttempt).not.toHaveBeenCalled();
    expect(outbox.dispatchNext).not.toHaveBeenCalled();
    expect(transport.invoke).not.toHaveBeenCalled();
  });

  it("never logs state values, result output, or artifact URIs (M2F LOG-001)", async () => {
    // Hostile values flow through the failure path; captured logs/errors may
    // contain only stable codes and identifiers, never the values themselves.
    const hostileStateValue = "super-secret-state-value";
    const hostileUri = "s3://bucket/secret-uri-key";
    const stepRows: any[] = [
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ];
    executionService.getStepExecutions.mockResolvedValue(stepRows);
    executionService.getStepExecution.mockResolvedValue(null);
    executionService.claimRunnableStep.mockRejectedValue(
      new ContextProjectionError("TENVYR_CTX_ENVELOPE_TOO_LARGE"),
    );
    executionService.updateExecutionStatus.mockImplementation(
      async (_id, status, output) => ({
        ...execution,
        status,
        output: {
          ...output,
          hostileStateValue,
          hostileUri,
        },
      }),
    );
    const captured: string[] = [];
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation((message?: unknown) => {
        captured.push(String(message));
      });
    const logSpy = jest
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => {
        captured.push(String(message));
      });
    try {
      await service.reconcileExecution("execution-1");
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
    const all = captured.join("\n");
    // Hostile values never reach logs/errors.
    expect(all).not.toContain("super-secret-state-value");
    expect(all).not.toContain("secret-uri-key");
    // The stable code is the durable diagnostic (persisted, not logged).
    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "FAILED",
      expect.objectContaining({
        error: "Context projection failed: TENVYR_CTX_ENVELOPE_TOO_LARGE",
      }),
    );
  });

  it("detects completion from durable step state without any step context", async () => {
    executionService.getStepExecutions.mockResolvedValue([
      { ...stepExecution, status: "COMPLETED", output: { score: 100 } },
    ]);

    await service.reconcileExecution("execution-1");

    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "COMPLETED",
      { review: { score: 100 } },
    );
    expect(outbox.dispatchAttempt).not.toHaveBeenCalled();
  });

  it("holds completion while a coordination loop is live (M9-S2)", async () => {
    executionService.getStepExecutions.mockResolvedValue([
      { ...stepExecution, status: "COMPLETED", output: { score: 100 } },
    ]);
    (executionService.isCoordinationCompletionHeld as jest.Mock).mockResolvedValue(
      true,
    );

    await service.reconcileExecution("execution-1");

    // The Execution is NOT marked COMPLETED; the loop owns completion.
    expect(executionService.updateExecutionStatus).not.toHaveBeenCalled();
  });

  it("fails the execution when input template resolution fails before any claim", async () => {
    executionService.getStepExecutions.mockResolvedValue([
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ]);
    // A poisoned input makes template materialization throw at the
    // scheduling boundary, before the attempt claim exists.
    executionService.getExecution.mockResolvedValue(
      Object.defineProperty({ ...execution }, "input", {
        get() {
          throw new Error("unresolvable context");
        },
      }),
    );

    await service.reconcileExecution("execution-1");

    expect(executionService.updateExecutionStatus).toHaveBeenCalledWith(
      "execution-1",
      "FAILED",
      expect.objectContaining({
        failedStep: "review",
        error: expect.stringContaining("Input resolution failed"),
      }),
    );
    expect(executionService.claimRunnableStep).not.toHaveBeenCalled();
    expect(outbox.dispatchAttempt).not.toHaveBeenCalled();
  });

  it("settles a committed terminal dispatch failure within reconciliation", async () => {
    executionService.getStepExecutions.mockResolvedValue([
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ]);
    // The outbox service committed the stop-policy failure; the next pass
    // observes the execution as FAILED and stops.
    executionService.getExecution
      .mockResolvedValueOnce({ ...execution, status: "RUNNING" })
      .mockResolvedValue({ ...execution, status: "FAILED" });
    outbox.dispatchAttempt.mockResolvedValue({
      outcome: "terminal_failure",
      executionId: "execution-1",
    });

    await service.reconcileExecution("execution-1");

    expect(executionService.claimRunnableStep).toHaveBeenCalledTimes(1);
    expect(outbox.dispatchAttempt).toHaveBeenCalledTimes(1);
    expect(outbox.dispatchNext).not.toHaveBeenCalled();
    // The terminal failure was projected.
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/webhooks/execution-update",
      expect.anything(),
    );
  });

  it("reconciles the execution that actually owns a committed terminal dispatch failure", async () => {
    const stepRows: any[] = [
      { ...stepExecution, status: "READY", eligibleAt: null, attempt: 0 },
    ];
    executionService.getStepExecutions.mockResolvedValue(stepRows);
    executionService.claimRunnableStep.mockImplementation(async () => {
      stepRows[0].status = "RUNNING";
      return {
        disposition: "claimed",
        logicalStep: stepRows[0],
        attempt: { id: "attempt-1", invocationId: "logical-1:1" },
      };
    });
    // The dispatcher reports the failure belongs to ANOTHER execution (a
    // compatibility path); the local execution stays RUNNING.
    executionService.getExecution
      .mockResolvedValueOnce({ ...execution, status: "RUNNING" })
      .mockResolvedValueOnce({ ...execution, status: "RUNNING" })
      .mockResolvedValue({ id: "execution-other", status: "FAILED" });
    outbox.dispatchAttempt.mockResolvedValue({
      outcome: "terminal_failure",
      executionId: "execution-other",
    });

    await service.reconcileExecution("execution-1");

    // The affected execution — not the local one — is reconciled and projected.
    expect(executionService.reconcileExecution).toHaveBeenCalledWith(
      "execution-other",
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/webhooks/execution-update",
      expect.anything(),
    );
  });

  it("advances dependents after a condition skip within the same reconciliation", async () => {
    const configA = { id: "a", agent: "alpha" };
    const configB = { id: "b", agent: "beta", dependsOn: ["a"] };
    executionService.getExecutionPlanSteps.mockResolvedValue([
      configA,
      configB,
    ]);
    const stepA: any = {
      ...stepExecution,
      id: "logical-a",
      stepId: "a",
      status: "READY",
      eligibleAt: null,
      attempt: 0,
    };
    const stepB: any = {
      ...stepExecution,
      id: "logical-b",
      stepId: "b",
      status: "PENDING",
      attempt: 0,
    };
    const logicalSteps: any[] = [stepA, stepB];
    executionService.getStepExecutions.mockImplementation(async () => [
      ...logicalSteps,
    ]);
    // Pass 1 claims A (skipped); pass 2's low-level reconcile advances B to
    // READY once its dependency is terminal, mirroring the durable state.
    executionService.reconcileExecution.mockImplementation(async () => {
      if (stepA.status === "SKIPPED" && stepB.status === "PENDING") {
        stepB.status = "READY";
        stepB.eligibleAt = new Date();
      }
      return { promoted: false, backfilled: 0, advanced: 0 };
    });
    executionService.claimRunnableStep
      .mockImplementationOnce(async () => {
        // Mirror the durable skip: the gate decision is persisted.
        stepA.status = "SKIPPED";
        return { disposition: "skipped", logicalStep: stepA };
      })
      .mockImplementationOnce(async () => {
        stepB.status = "RUNNING";
        return {
          disposition: "claimed",
          logicalStep: stepB,
          attempt: { id: "attempt-b", invocationId: "logical-b:1" },
        };
      });

    await service.reconcileExecution("execution-1");

    expect(executionService.claimRunnableStep).toHaveBeenCalledTimes(2);
    expect(executionService.claimRunnableStep).toHaveBeenNthCalledWith(
      1,
      "execution-1",
      configA,
      {},
      1,
      undefined,
    );
    expect(executionService.claimRunnableStep).toHaveBeenNthCalledWith(
      2,
      "execution-1",
      configB,
      {},
      1,
      undefined,
    );
    expect(outbox.dispatchAttempt).toHaveBeenCalledTimes(1);
  });

  it("commits cancellation first, then best-effort notifies the executor", async () => {
    executionService.cancelExecution = jest
      .fn()
      .mockResolvedValue({
        ...execution,
        status: "CANCELLED",
        terminationReason: "Execution cancelled by request",
      });

    const cancelled = await service.cancelExecution("execution-1");

    expect(executionService.cancelExecution).toHaveBeenCalledWith(
      "execution-1",
    );
    // The executor notification is post-commit, best-effort, and uses the
    // committed termination reason.
    expect(outbox.notifyCancel).toHaveBeenCalledWith(
      "execution-1",
      "Execution cancelled by request",
    );
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("never lets an executor notification failure reverse a committed cancellation", async () => {
    executionService.cancelExecution = jest
      .fn()
      .mockResolvedValue({ ...execution, status: "CANCELLED" });
    outbox.notifyCancel = jest
      .fn()
      .mockRejectedValue(new Error("unexpected notify bug"));

    const cancelled = await service.cancelExecution("execution-1");

    // The commit already happened; the notification failure is only warned.
    expect(cancelled.status).toBe("CANCELLED");
    expect(executionService.cancelExecution).toHaveBeenCalledTimes(1);
  });
});
