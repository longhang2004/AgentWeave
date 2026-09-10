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
import { RuntimeConnectionService } from "./services/runtime-connection.service";
import { HttpAgentAdapter } from "./agent-adapters/http-agent.adapter";
import { HttpAgentCallbackController } from "./agent-adapters/http-agent-callback.controller";
import {
  AgentTransportConfigService,
  parseAgentTransportConfiguration,
} from "./agent-adapters/agent-transport-config.service";
import type { AgentInvocationV1 } from "@tenvyr/contracts";
import { startHostWorkers, type HostConfig } from "../../local-executor-host/src/main";

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

describeWithPostgres("Dynamic Bridge callback acceptance (buildManifest → LOCAL_EXECUTOR_HOST_URL → Host resolves revision → fake CLI → signed callback)", () => {
  jest.setTimeout(60_000);
  let dataSource: DataSource;
  let fixtureDir: string;
  let orchPort: number;
  let hostPort: number;
  let manifestOrchEnv: Record<string, string>;
  let manifestHostEnv: Record<string, string>;
  let hostWorkers: Awaited<ReturnType<typeof startHostWorkers>> = [];
  let app: INestApplication;
  let adapter: HttpAgentAdapter;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    orchPort = await availablePort();
    hostPort = await availablePort();
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
    manifestOrchEnv = orch.env as Record<string, string>;
    manifestHostEnv = host.env as Record<string, string>;

    // URLs and secrets come only from buildManifest.
    expect(manifestOrchEnv.HTTP_AGENT_CALLBACK_BASE_URL).toBeDefined();
    expect(manifestOrchEnv.LOCAL_EXECUTOR_HOST_URL).toBeDefined();
    expect(manifestOrchEnv.EXECUTOR_HOST_URL).toBeDefined();
    expect(manifestHostEnv.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS).toBeTruthy();
    expect(manifestOrchEnv.HTTP_AGENT_BEARER_TOKEN).toBeDefined();
    expect(manifestOrchEnv.HTTP_AGENT_CALLBACK_SECRET).toBeDefined();
    expect(manifestHostEnv.EXECUTOR_HOST_BEARER_TOKEN).toBe(manifestOrchEnv.EXECUTOR_HOST_BEARER_TOKEN);
    expect(manifestHostEnv.EXECUTOR_HOST_CALLBACK_KEYS).toBeDefined();
    // Prohibited legacy config must not be used
    expect(manifestOrchEnv.AGENT_TRANSPORT_CONFIG).toBeUndefined();
    expect(manifestHostEnv.EXECUTOR_HOST_AGENTS).toBeUndefined();

    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();
  });

  afterAll(async () => {
    if (adapter) await adapter.stop().catch(() => {});
    if (app) await app.close().catch(() => {});
    for (const w of hostWorkers) await w.stop().catch(() => {});
    await dataSource?.destroy().catch(() => {});
    if (fixtureDir && fs.existsSync(fixtureDir)) fs.rmSync(fixtureDir, { recursive: true, force: true });
    // Clean up env we set
    delete process.env.EVIDENCE_FILE;
  });

  it("buildManifest env → dynamic RuntimeConnection → dispatch via LOCAL_EXECUTOR_HOST_URL → Host resolves ConnectionRevision → bounded fake CLI → signed callback via generated keys → Orchestrator accepts", async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-dynamic-bridge-"));
    const evidenceFile = path.join(fixtureDir, "evidence.log");
    const scriptPath = path.join(fixtureDir, "fake-cli.js");
    // Bounded fake CLI: reads invocation JSON on stdin, appends invocationId to evidence, outputs single JSON object
    const fakeCli = `
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const inv = JSON.parse(raw);
  const fs = require("node:fs");
  fs.appendFileSync(${JSON.stringify(evidenceFile)}, inv.invocationId + "\\n");
  // Structured result: single JSON object on stdout
  process.stdout.write(JSON.stringify({ ok: true, echoedInvocationId: inv.invocationId, hello: "dynamic-bridge" }));
});
`;
    fs.writeFileSync(scriptPath, fakeCli, "utf8");

    const connService = new RuntimeConnectionService(dataSource);
    const connectionId = "conn:dynamic-bridge-test";
    await connService.createConnection(connectionId, {
      name: "Dynamic Bridge Test Runtime",
      runtimeKind: "generic-cli",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: { invocation: { supported: true, source: "configured" } },
      cli: { command: process.execPath, args: [scriptPath], probe: { args: ["--version"] } },
    });
    await dataSource.getRepository(RuntimeConnectionEntity).update({ connectionId }, { statusState: "AVAILABLE", statusReasonCode: "none" });
    const revRow = await dataSource.getRepository(RuntimeConnectionEntity).findOne({ where: { connectionId } });
    expect(revRow).not.toBeNull();
    const revisionNumber = revRow!.currentRevisionNumber;
    const connRev = await dataSource.getRepository(ConnectionRevisionEntity).findOne({
      where: { connectionId, revisionNumber },
    } as any);
    expect(connRev).not.toBeNull();
    const configHash = (connRev as any).configHash as string;
    expect(configHash).toBeDefined();

    // Consume buildManifest env to boot Host (dynamic bridge) and Orchestrator
    // Set Database URL for Host's DB pool to resolve revisions dynamically
    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    process.env.TEST_DATABASE_URL = TEST_DATABASE_URL!;
    // Propagate generated secrets/urls into process.env for Host and Orchestrator
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

    // Boot Host with dynamic bridge (no static EXECUTOR_HOST_AGENTS) — uses generated env
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
    expect(hostWorkers[0].agent).toBe("*");

    // Boot Orchestrator callback server using generated env (never invent URL/secret)
    const parsed = parseAgentTransportConfiguration(manifestOrchEnv);
    const transportConfig = new AgentTransportConfigService(parsed);

    const moduleRef = await Test.createTestingModule({
      controllers: [HttpAgentCallbackController],
      providers: [{ provide: AgentTransportConfigService, useValue: transportConfig }, HttpAgentAdapter],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(orchPort, "127.0.0.1");
    adapter = moduleRef.get(HttpAgentAdapter);
    let resolveCaptured: (v: any) => void;
    const capturedPromise = new Promise<{ result: any; transport: any }>((resolve) => {
      resolveCaptured = resolve;
    });
    const resultHandler = jest.fn(async (msg: any) => {
      resolveCaptured(msg);
    });
    await adapter.start({ result: resultHandler, event: async () => undefined });

    // Build invocation that targets the dynamic connection via LOCAL_EXECUTOR_HOST_URL
    // Dynamic bridge requires a valid execution workspace (requireExecutionWorkspace: true)
    const workspaceIdentity = {
      schemaVersion: 1 as const,
      workspaceExecutionId: "test-ws-exec-1",
      path: fixtureDir,
      mode: "shared" as const,
      sourceWorkspaceId: "ws-test",
      baseHeadSha: null,
    };
    const invocation: AgentInvocationV1 = {
      schemaVersion: "1",
      invocationId: `inv-${Date.now()}`,
      executionId: `exec-${Date.now()}`,
      stepExecutionId: `step-${Date.now()}`,
      stepId: "step1",
      target: { agent: "conn__dynamic-bridge-test" },
      input: { task: "dynamic-bridge-e2e" },
      attempt: 1,
      createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      trace: { traceId: `exec-${Date.now()}`, correlationId: `inv-${Date.now()}` },
      connection: { connectionId, revisionNumber, configHash },
      metadata: { tenvyr: { executionWorkspace: workspaceIdentity } } as any,
    };

    // Dispatch through generated LOCAL_EXECUTOR_HOST_URL (orchestrator → host)
    const receipt = await adapter.invoke(invocation);
    expect(receipt.adapter).toBe("http");
    expect(receipt.invocationId).toBe(invocation.invocationId);

    // Callback timeout is a test failure: evidence alone is not integration proof.
    const captured = await Promise.race([
      capturedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("callback timeout")), 15_000),
      ),
    ]);
    expect(resultHandler).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(evidenceFile)).toBe(true);
    const evidence = fs.readFileSync(evidenceFile, "utf8");
    expect(evidence).toContain(invocation.invocationId);

    const finalConnRev = await dataSource.getRepository(ConnectionRevisionEntity).findOne({ where: { connectionId, revisionNumber } } as any);
    expect(finalConnRev).not.toBeNull();

    const res = captured.result;
    expect(res).toMatchObject({
      schemaVersion: "1",
      invocationId: invocation.invocationId,
      status: "succeeded",
    });
    expect(JSON.stringify(res.output)).toContain("dynamic-bridge");
    expect(captured.transport).toMatchObject({ adapter: "http" });
    expect(captured.transport.keyId).toBeDefined();
  });
});
