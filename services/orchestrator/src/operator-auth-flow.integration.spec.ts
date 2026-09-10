import { DataSource, type DataSourceOptions } from "typeorm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import * as http from "node:http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { databaseOptions } from "./database/database.provider";
import { RuntimeConnectionEntity } from "./entities/runtime-connection.entity";
import { ConnectionRevisionEntity } from "./entities/connection-revision.entity";
import {
  RuntimeConnectionService,
} from "./services/runtime-connection.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-adapters/agent-transport-config.service";
import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { startHostWorkers, type HostConfig } from "../../local-executor-host/src/main";

/**
 * Post-PP1 hardening closure — ONE focused operator-flow integration:
 *
 *   runtime auth required (probe exits the documented auth code)
 *     -> AUTH_REQUIRED projection (the run picker renders it DISABLED
 *        with "Sign in on Runtimes" — frontend matrix in
 *        frontend picker-readiness.test.mjs)
 *     -> the EXTERNAL fake runtime "signs in" (flag file appears)
 *     -> Check Again (bounded re-probe)
 *     -> connection test -> AVAILABLE -> selectable run target
 *     -> existing Dynamic Local Runtime Bridge dispatch succeeds.
 *
 * No real provider credentials; the runtime is a bounded fake CLI.
 * Postgres-gated like every integration suite (disposable DB required).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  const configured = String(databaseOptions().database);
  if (!url) return;
  const db = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!db || db.toLowerCase() === configured.toLowerCase()) {
    throw new Error("TEST_DATABASE_URL must name a disposable database");
  }
};

const availablePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describeWithPostgres("Post-PP1 hardening: operator auth flow (AUTH_REQUIRED -> ready -> AVAILABLE -> Dynamic Local Runtime Bridge dispatch)", () => {
  jest.setTimeout(90_000);
  let dataSource: DataSource;
  let fixtureDir: string;
  let orchPort: number;
  let hostPort: number;
  let hostWorkers: Awaited<ReturnType<typeof startHostWorkers>> = [];
  let app: INestApplication | undefined;
  let adapter: HttpAgentAdapter | undefined;
  // The adapter registers handlers ONCE; the single dispatch of this suite
  // resolves through this capture channel.
  let capturedResolve: (v: any) => void = () => undefined;
  let capturedPromise = new Promise<any>((resolve) => {
    capturedResolve = resolve;
  });

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    orchPort = await availablePort();
    hostPort = await availablePort();
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-operator-flow-"));
    const { spawnSync } = await import("node:child_process");
    const manifestJson = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildManifest } from ${JSON.stringify(path.resolve(__dirname, "../../../scripts/dev.mjs"))}; const m = buildManifest({ ORCHESTRATOR_PORT: ${JSON.stringify(String(orchPort))}, EXECUTOR_HOST_PORT: ${JSON.stringify(String(hostPort))} }); console.log(JSON.stringify({ services: m.services.map(s=>({name:s.name, env:s.env})) }));`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (manifestJson.status !== 0) throw new Error(`buildManifest spawn failed: ${manifestJson.stderr}`);
    const manifest = JSON.parse(manifestJson.stdout.trim());
    const orch = manifest.services.find((s: any) => s.name === "orchestrator");
    const host = manifest.services.find((s: any) => s.name === "host");
    if (!orch || !host) throw new Error("buildManifest did not produce orchestrator/host");
    const manifestOrchEnv = orch.env as Record<string, string>;
    const manifestHostEnv = host.env as Record<string, string>;

    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    // Consume buildManifest env for Host + Orchestrator transport truth.
    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    process.env.EXECUTOR_HOST_BEARER_TOKEN = manifestHostEnv.EXECUTOR_HOST_BEARER_TOKEN;
    process.env.HTTP_AGENT_BEARER_TOKEN = manifestOrchEnv.HTTP_AGENT_BEARER_TOKEN;
    process.env.HTTP_AGENT_CALLBACK_SECRET = manifestOrchEnv.HTTP_AGENT_CALLBACK_SECRET;
    process.env.LOOPBACK_CALLBACK_SECRET = manifestOrchEnv.LOOPBACK_CALLBACK_SECRET ?? manifestOrchEnv.HTTP_AGENT_CALLBACK_SECRET;
    process.env.EXECUTOR_HOST_CALLBACK_KEYS = manifestHostEnv.EXECUTOR_HOST_CALLBACK_KEYS;
    process.env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS = manifestHostEnv.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS;
    process.env.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE = manifestHostEnv.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE ?? "true";
    process.env.HTTP_AGENT_CALLBACK_BASE_URL = manifestOrchEnv.HTTP_AGENT_CALLBACK_BASE_URL;
    process.env.HTTP_AGENT_ALLOW_INSECURE = manifestOrchEnv.HTTP_AGENT_ALLOW_INSECURE ?? "true";
    process.env.LOCAL_EXECUTOR_HOST_URL = manifestOrchEnv.LOCAL_EXECUTOR_HOST_URL;
    process.env.EXECUTOR_HOST_URL = manifestOrchEnv.EXECUTOR_HOST_URL;

    // Boot Host with the DYNAMIC bridge (no static agents).
    const hostConfig: HostConfig = {
      agents: [],
      allowedRoot: fixtureDir,
      stateDir: path.join(fixtureDir, "host-state"),
      callbackAllowedOrigins: manifestHostEnv.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS.split(",").map((s: string) => s.trim()).filter(Boolean),
      callbackKeys: JSON.parse(manifestHostEnv.EXECUTOR_HOST_CALLBACK_KEYS),
      callbackAllowInsecure: (manifestHostEnv.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE ?? "true") === "true",
      port: hostPort,
      bearerTokenEnv: "EXECUTOR_HOST_BEARER_TOKEN",
      dynamicBridge: true,
    };
    hostWorkers = await startHostWorkers(hostConfig);
    expect(hostWorkers.length).toBe(1);

    // Boot the Orchestrator callback surface with generated env only.
    const parsed = parseAgentTransportConfiguration(manifestOrchEnv);
    const transportConfig = new AgentTransportConfigService(parsed);
    const moduleRef = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController],
      providers: [
        { provide: AgentTransportConfigService, useValue: transportConfig },
        HttpAgentAdapter,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(orchPort, "127.0.0.1");
    adapter = moduleRef.get(HttpAgentAdapter);
    await adapter!.start({
      result: async (msg: any) => capturedResolve(msg),
      event: async () => undefined,
    });
  });

  afterAll(async () => {
    if (adapter) await adapter.stop().catch(() => {});
    if (app) await app.close().catch(() => {});
    for (const w of hostWorkers) await w.stop().catch(() => {});
    await dataSource?.destroy().catch(() => {});
    if (fixtureDir && fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("auth-required fake runtime -> sign-in happens externally -> Check Again -> AVAILABLE -> bridge dispatch", async () => {
    const authFlag = path.join(fixtureDir, "signed-in.flag");
    const evidenceFile = path.join(fixtureDir, "evidence.log");

    // Bounded fake CLI: --version exits the documented AUTH exit code until
    // the operator "signs in" (flag file exists); the run child records
    // evidence and emits a structured result.
    const scriptPath = path.join(fixtureDir, "fake-runtime.cjs");
    fs.writeFileSync(
      scriptPath,
      `
const fs = require("node:fs");
const [,, sub] = process.argv;
if (sub === "--version") {
  if (fs.existsSync(${JSON.stringify(authFlag)})) {
    process.stdout.write("fake-runtime 1.0.0\\n");
    process.exit(0);
  }
  // Documented auth-status contract: this exit code == auth required.
  process.exit(2);
}
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const inv = JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(evidenceFile)}, inv.invocationId + "\\n");
  process.stdout.write(JSON.stringify({ ok: true, hello: "operator-flow" }));
});
`,
      "utf8",
    );

    const connections = new RuntimeConnectionService(dataSource);
    const connectionId = "conn:operator-flow";
    await connections.createConnection(connectionId, {
      name: "Operator Flow Fake Runtime",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: { invocation: { supported: true, source: "configured" } },
      cli: {
        command: process.execPath,
        args: [scriptPath],
        // The probe spawns command + probe.args verbatim.
        probe: { args: [scriptPath, "--version"], authExitCodes: [2] },
      },
    });

    // Step 1: first probe -> AUTH_REQUIRED (runtime-owned sign-in missing).
    const before = await connections.testConnection(connectionId);
    expect(before.state).toBe("AUTH_REQUIRED");
    expect(before.reasonCode).toBe("auth-required");

    // The run picker would render this card DISABLED ("Sign in on
    // Runtimes"); backend authority agrees: a claim still resolves but the
    // card is not an AVAILABLE target yet.

    // Step 2: the EXTERNAL runtime signs in (outside Tenvyr).
    fs.writeFileSync(authFlag, "ok");

    // Step 3: Check Again (rate-limited bounded re-probe).
    await new Promise((resolve) => setTimeout(resolve, 5_100)); // PROBE_MIN_INTERVAL_MS
    const receipt = await connections.testConnection(connectionId);
    expect(receipt.state).toBe("AVAILABLE");
    expect(receipt.reasonCode).toBe("none");

    // Step 4: AVAILABLE + not revoked == selectable run target; freeze the
    // exact revision the dispatch will carry.
    const row = await dataSource
      .getRepository(RuntimeConnectionEntity)
      .findOne({ where: { connectionId } });
    expect(row?.statusState).toBe("AVAILABLE");
    const revisionNumber = row!.currentRevisionNumber;
    const connRev = await dataSource
      .getRepository(ConnectionRevisionEntity)
      .findOne({ where: { connectionId, revisionNumber } } as any);
    expect(connRev).not.toBeNull();
    const configHash = (connRev as any).configHash as string;

    // Step 5: existing Dynamic Local Runtime Bridge dispatch through the
    // frozen revision (LOCAL_EXECUTOR_HOST_URL -> Host resolves revision ->
    // fake CLI -> signed callback accepted by the Orchestrator surface).
    const invocation: AgentInvocationV1 = {
      schemaVersion: "1",
      invocationId: `inv-${Date.now()}`,
      executionId: `exec-${Date.now()}`,
      stepExecutionId: `step-${Date.now()}`,
      stepId: "step1",
      target: { agent: "conn__operator-flow" },
      input: { task: "operator-auth-flow-e2e" },
      attempt: 1,
      createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      trace: { traceId: `exec-${Date.now()}`, correlationId: `inv-${Date.now()}` },
      connection: { connectionId, revisionNumber, configHash },
      metadata: {
        tenvyr: {
          executionWorkspace: {
            schemaVersion: 1 as const,
            workspaceExecutionId: "test-ws-exec-operator-flow",
            path: fixtureDir,
            mode: "shared" as const,
            sourceWorkspaceId: "ws-operator-flow",
            baseHeadSha: null,
          },
        },
      } as any,
    };
    const dispatchReceipt = await adapter!.invoke(invocation);
    expect(dispatchReceipt.adapter).toBe("http");
    expect(dispatchReceipt.invocationId).toBe(invocation.invocationId);

    const captured = await Promise.race([
      capturedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("callback timeout")), 20_000),
      ),
    ]);
    expect(captured.result).toMatchObject({
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      status: "succeeded",
    });
    expect(JSON.stringify(captured.result.output)).toContain("operator-flow");
    expect(fs.existsSync(evidenceFile)).toBe(true);
    expect(fs.readFileSync(evidenceFile, "utf8")).toContain(invocation.invocationId);
  });
});
