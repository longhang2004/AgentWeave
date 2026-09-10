#!/usr/bin/env node

import { isDeepStrictEqual } from "node:util";

const EXIT_HEALTH = 1;
const EXIT_SEED = 2;
const EXIT_TRIGGER = 3;
const EXIT_EXECUTION = 4;
const EXIT_TIMEOUT = 5;
const EXIT_PREREQ = 7;

// Internal defaults target services bound to explicit IPv4 loopback;
// overrides preserved for non-default topologies.
const GATEWAY = process.env.SMOKE_GATEWAY_URL || "http://127.0.0.1:3000";
const ORCHESTRATOR =
  process.env.SMOKE_ORCHESTRATOR_URL || "http://127.0.0.1:3001";
const CODE_REVIEWER =
  process.env.SMOKE_CODE_REVIEWER_URL || "http://localhost:3002";
const OBSERVABILITY =
  process.env.SMOKE_OBSERVABILITY_URL || "http://localhost:3003";
const RUNNER = process.env.SMOKE_RUNNER_URL || "http://localhost:8085";
const PYTHON_WORKER =
  process.env.SMOKE_PYTHON_WORKER_URL || "http://127.0.0.1:8080";
const FRONTEND = process.env.SMOKE_FRONTEND_URL || "http://localhost:4000";

const POLL_INTERVAL_MS = Number(process.env.SMOKE_POLL_INTERVAL_MS || 1000);
const POLL_TIMEOUT_MS = Number(process.env.SMOKE_POLL_TIMEOUT_MS || 120_000);
const READINESS_TIMEOUT_MS = Number(
  process.env.SMOKE_READINESS_TIMEOUT_MS || 180_000,
);

const SHOWCASE_PIPELINE = {
  name: "Tenvyr Supervised Pipeline",
  version: "1.0.0",
  description:
    "Offline golden path across a Python Worker and Java-backed quality gate",
  steps: [
    {
      id: "analyze-input",
      agent: "echo-analyzer",
      input: {
        message: "{{ pipeline.input.message }}",
        mode: "{{ pipeline.input.mode }}",
      },
      timeout: "10s",
      retries: 1,
      onFailure: "retry",
      metadata: {
        runtime: "python",
        language: "python",
        transport: "http",
      },
    },
    {
      id: "quality-gate",
      agent: "code-reviewer",
      dependsOn: ["analyze-input"],
      input: {
        code: "{{ pipeline.input.code }}",
        language: "{{ pipeline.input.language }}",
      },
      timeout: "90s",
      onFailure: "stop",
      metadata: {
        runtime: "typescript",
        language: "typescript",
        transport: "kafka",
        runnerRuntime: "java",
      },
    },
  ],
};

const RUN_INPUT = {
  message: "Inspect the sample input before the quality gate",
  code: "const query = 'SELECT * FROM users WHERE id=' + id;",
  language: "typescript",
};

class SmokeFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function log(message) {
  console.log(`[showcase] ${message}`);
}

function requireCondition(condition, code, message) {
  if (!condition) throw new SmokeFailure(code, message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    const raw = await response.text();
    let json;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        return {
          ok: response.ok,
          status: response.status,
          raw,
          jsonError: true,
        };
      }
    }
    return { ok: response.ok, status: response.status, raw, json };
  } catch (error) {
    return {
      networkError: error instanceof Error ? error.message : String(error),
    };
  }
}

const HEALTH_TARGETS = [
  {
    name: "gateway",
    url: `${GATEWAY}/health`,
    valid: (body) => body?.success === true && body?.data?.status === "UP",
  },
  {
    name: "orchestrator",
    url: `${ORCHESTRATOR}/health`,
    valid: (body) => body?.success === true && body?.data?.status === "UP",
  },
  {
    name: "code-reviewer",
    url: `${CODE_REVIEWER}/health`,
    valid: (body) => body?.success === true && body?.data?.status === "UP",
  },
  {
    name: "observability",
    url: `${OBSERVABILITY}/health`,
    valid: (body) => body?.success === true && body?.data?.status === "UP",
  },
  {
    name: "agent-runner",
    url: `${RUNNER}/health`,
    valid: (body) => body?.success === true && body?.data?.status === "UP",
  },
  {
    name: "python-worker",
    url: `${PYTHON_WORKER}/health/ready`,
    valid: (body) => body?.status === "ok",
  },
  {
    name: "frontend",
    url: `${FRONTEND}/`,
    json: false,
    valid: () => true,
  },
  {
    name: "frontend dashboard",
    url: `${FRONTEND}/dashboard`,
    json: false,
    valid: () => true,
  },
];

async function healthFailure(target) {
  const result = await request(target.url);
  if (result.networkError) return `${target.name}: ${result.networkError}`;
  if (!result.ok) return `${target.name}: HTTP ${result.status}`;
  if (target.json !== false && result.jsonError)
    return `${target.name}: invalid JSON`;
  if (!target.valid(result.json)) return `${target.name}: unexpected response`;
  return undefined;
}

async function waitForHealth() {
  log("Waiting for showcase readiness...");
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let failures = [];
  while (Date.now() < deadline) {
    const results = await Promise.all(
      HEALTH_TARGETS.map(async (target) => ({
        target,
        failure: await healthFailure(target),
      })),
    );
    failures = results.filter(({ failure }) => failure);
    if (failures.length === 0) {
      for (const { target } of results) log(`PASS health ${target.name}`);
      return;
    }
    await sleep(2000);
  }
  throw new SmokeFailure(
    EXIT_HEALTH,
    `readiness timed out:\n  - ${failures.map(({ failure }) => failure).join("\n  - ")}`,
  );
}

async function gatewayApi(path, options, exitCode) {
  const url = `${GATEWAY}${path}`;
  const result = await request(url, options);
  requireCondition(
    !result.networkError,
    exitCode,
    `${url}: ${result.networkError}`,
  );
  requireCondition(result.ok, exitCode, `${url}: HTTP ${result.status}`);
  requireCondition(!result.jsonError, exitCode, `${url}: invalid JSON`);
  requireCondition(
    result.json?.success === true,
    exitCode,
    `${url}: ${result.json?.error || result.raw}`,
  );
  return result.json.data;
}

async function seedPipeline() {
  const pipelines = await gatewayApi("/api/pipelines", undefined, EXIT_SEED);
  requireCondition(
    Array.isArray(pipelines),
    EXIT_SEED,
    "pipeline list is not an array",
  );
  const existing = pipelines.find(
    (pipeline) =>
      pipeline.name === SHOWCASE_PIPELINE.name &&
      pipeline.version === SHOWCASE_PIPELINE.version &&
      isDeepStrictEqual(pipeline.steps, SHOWCASE_PIPELINE.steps),
  );
  if (existing) {
    log(`PASS seed reused pipeline ${existing.id}`);
    return existing.id;
  }

  const created = await gatewayApi(
    "/api/pipelines",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SHOWCASE_PIPELINE),
    },
    EXIT_SEED,
  );
  requireCondition(created?.id, EXIT_SEED, "pipeline response omitted id");
  log(`PASS seed created pipeline ${created.id}`);
  return created.id;
}

async function triggerExecution(pipelineId, mode) {
  const execution = await gatewayApi(
    "/api/executions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineId,
        input: { ...RUN_INPUT, mode },
      }),
    },
    EXIT_TRIGGER,
  );
  requireCondition(
    execution?.id,
    EXIT_TRIGGER,
    "execution response omitted id",
  );
  log(`Started ${mode} execution ${execution.id}`);
  return execution.id;
}

async function pollExecution(executionId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const execution = await gatewayApi(
      `/api/executions/${executionId}`,
      undefined,
      EXIT_EXECUTION,
    );
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)) {
      return execution;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new SmokeFailure(
    EXIT_TIMEOUT,
    `execution ${executionId} did not finish within ${POLL_TIMEOUT_MS}ms`,
  );
}

function providerMetadata(step) {
  return step?.output?._tenvyr?.metadata;
}

function validatePipelineMetadata(pipeline = SHOWCASE_PIPELINE) {
  const analyze = pipeline.steps?.find((step) => step.id === "analyze-input");
  const quality = pipeline.steps?.find((step) => step.id === "quality-gate");
  requireCondition(
    analyze?.metadata?.runtime === "python" &&
      analyze.metadata.language === "python" &&
      analyze.metadata.transport === "http",
    EXIT_SEED,
    "analyze-input must declare the Python HTTP hop",
  );
  requireCondition(
    quality?.metadata?.runtime === "typescript" &&
      quality.metadata.language === "typescript" &&
      quality.metadata.transport === "kafka" &&
      quality.metadata.runnerRuntime === "java",
    EXIT_SEED,
    "quality-gate must declare the TypeScript Kafka agent and Java runner hops",
  );
  return { analyze: analyze.metadata, quality: quality.metadata };
}

function validateExecution(
  execution,
  expectedAnalyzeAttempt,
  expectedProvider = "mock",
  expectedFailureMode = "",
) {
  requireCondition(
    execution.status === "COMPLETED",
    EXIT_EXECUTION,
    `execution ${execution.id} ended ${execution.status}: ${JSON.stringify(execution.output)}`,
  );
  requireCondition(
    Array.isArray(execution.steps) && execution.steps.length === 2,
    EXIT_EXECUTION,
    `execution ${execution.id} did not expose exactly two steps`,
  );

  const analyze = execution.steps.find(
    (step) => step.stepId === "analyze-input",
  );
  const quality = execution.steps.find(
    (step) => step.stepId === "quality-gate",
  );
  requireCondition(
    analyze?.agent === "echo-analyzer",
    EXIT_EXECUTION,
    "Python step agent mismatch",
  );
  requireCondition(
    analyze?.status === "COMPLETED",
    EXIT_EXECUTION,
    "Python step did not complete",
  );
  requireCondition(
    analyze?.attempt === expectedAnalyzeAttempt,
    EXIT_EXECUTION,
    `Python step attempt was ${analyze?.attempt}, expected ${expectedAnalyzeAttempt}`,
  );
  requireCondition(
    analyze?.maxAttempts === 2,
    EXIT_EXECUTION,
    "Python step maxAttempts mismatch",
  );
  requireCondition(
    analyze?.output?._tenvyr?.runtime === "python",
    EXIT_EXECUTION,
    "Python runtime metadata missing",
  );
  requireCondition(
    analyze?.output?._tenvyr?.language === "python",
    EXIT_EXECUTION,
    "Python language metadata missing",
  );
  requireCondition(
    analyze?.output?._tenvyr?.transport === "http",
    EXIT_EXECUTION,
    "Python transport metadata missing",
  );

  requireCondition(
    quality?.agent === "code-reviewer",
    EXIT_EXECUTION,
    "Java-backed quality gate agent mismatch",
  );
  requireCondition(
    quality?.status === "COMPLETED",
    EXIT_EXECUTION,
    "Java-backed quality gate did not complete",
  );
  requireCondition(
    quality?.attempt === 1,
    EXIT_EXECUTION,
    "quality gate attempt mismatch",
  );

  const provider = providerMetadata(quality);
  requireCondition(
    provider && typeof provider === "object",
    EXIT_EXECUTION,
    "Java quality-gate provider metadata is missing",
  );
  requireCondition(
    typeof provider.provider === "string" && provider.provider.length > 0,
    EXIT_EXECUTION,
    "provider metadata is invalid",
  );
  requireCondition(
    typeof provider.model === "string" && provider.model.length > 0,
    EXIT_EXECUTION,
    "model metadata is invalid",
  );
  requireCondition(
    typeof provider.fallbackUsed === "boolean",
    EXIT_EXECUTION,
    "fallbackUsed metadata is invalid",
  );
  if (expectedProvider === "mock") {
    requireCondition(
      provider.provider === "mock" && provider.fallbackUsed === true,
      EXIT_EXECUTION,
      "default mock provider metadata must report provider=mock and fallbackUsed=true",
    );
  } else if (provider.provider === "mock" && expectedFailureMode === "mock") {
    requireCondition(
      provider.requestedProvider === expectedProvider &&
        provider.fallbackUsed === true,
      EXIT_EXECUTION,
      `mock fallback metadata must identify requestedProvider=${expectedProvider}`,
    );
  } else {
    requireCondition(
      provider.provider === expectedProvider && provider.fallbackUsed === false,
      EXIT_EXECUTION,
      `provider metadata must report provider=${expectedProvider} and fallbackUsed=false`,
    );
  }
  return { analyze, quality, provider };
}

function printUrls(executionIds = []) {
  console.log(`Dashboard: ${FRONTEND}/dashboard`);
  console.log(`Gateway API: ${GATEWAY}/api`);
  console.log(`Orchestrator API: ${ORCHESTRATOR}`);
  for (const executionId of executionIds) {
    console.log(`Execution API: ${GATEWAY}/api/executions/${executionId}`);
  }
}

async function runSmoke() {
  const expectedProvider = (process.env.LLM_PROVIDER || "mock")
    .trim()
    .toLowerCase();
  const expectedFailureMode = (process.env.LLM_FAILURE_MODE || "")
    .trim()
    .toLowerCase();
  const hops = validatePipelineMetadata();
  await waitForHealth();
  const pipelineId = await seedPipeline();
  const successId = await triggerExecution(pipelineId, "success");
  const success = validateExecution(
    await pollExecution(successId),
    1,
    expectedProvider,
    expectedFailureMode,
  );
  log(
    `PASS success: ${hops.analyze.language}/${hops.analyze.transport} -> ${hops.quality.language}/${hops.quality.transport} -> ${hops.quality.runnerRuntime} runner`,
  );

  const retryId = await triggerExecution(pipelineId, "retry-once");
  const retry = validateExecution(
    await pollExecution(retryId),
    2,
    expectedProvider,
    expectedFailureMode,
  );
  log(
    `PASS retry-once: analyze-input completed on attempt ${retry.analyze.attempt}`,
  );
  log(
    `PASS provider metadata ${retry.provider.provider}/${retry.provider.model}; fallbackUsed=${retry.provider.fallbackUsed}`,
  );
  printUrls([successId, retryId]);
  log("SUCCESS offline showcase smoke passed");
}

async function main() {
  requireCondition(
    typeof fetch === "function",
    EXIT_PREREQ,
    "Node.js global fetch is unavailable",
  );
  const mode = process.argv[2];
  requireCondition(
    !mode || mode === "--health" || mode === "--seed",
    EXIT_PREREQ,
    `unknown option ${mode}`,
  );
  if (mode === "--health") {
    await waitForHealth();
    printUrls();
    return;
  }
  if (mode === "--seed") {
    await waitForHealth();
    const pipelineId = await seedPipeline();
    log(`Pipeline API: ${GATEWAY}/api/pipelines/${pipelineId}`);
    printUrls();
    return;
  }
  await runSmoke();
}

if (process.argv[1]?.endsWith("smoke-e2e.mjs")) {
  main().catch((error) => {
    const code = error instanceof SmokeFailure ? error.code : EXIT_EXECUTION;
    console.error(
      `[showcase] FAILURE: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = code;
  });
}

export {
  SHOWCASE_PIPELINE,
  providerMetadata,
  validateExecution,
  validatePipelineMetadata,
};
