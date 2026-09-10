import { DataSource, type DataSourceOptions } from "typeorm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import * as http from "node:http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { databaseOptions } from "./database/database.provider";
import { RuntimeConnectionService } from "./services/runtime-connection.service";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";
import { ProviderDiscoveryController } from "./provider-discovery.controller";
import { WorkbenchCommandService } from "./services/workbench-command.service";

/**
 * Post-PP1 hardening closure — ONE cross-layer reload-resume integration
 * covering the ACTUAL Workbench browser path (no browser automation):
 *
 *   create RuntimeConnection (real authority row, fake opencode CLI)
 *     -> Begin OAuth  via REAL Gateway route  /api/provider-discovery/commands/oauth-begin
 *     -> LiveFlow stored in Orchestrator memory with URL X
 *     -> simulate frontend state loss (browser F5)
 *     -> GET REAL Gateway route /api/provider-discovery/auth-flows/active?...
 *     -> SAME authFlowId + SAME URL X + same instructions/expiry
 *     -> Complete using the RESUMED authFlowId (same retained session)
 *     -> provider discovery proves connected.
 *
 * Asserts: authorize count EXACTLY 1, resumed URL identical to original,
 * no management password/token in any returned JSON, flow removed after
 * Complete. PostgreSQL-gated (disposable database required).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
/** The REAL Gateway is booted from its BUILT entry (services/gateway/dist/main.js)
 *  — actual main.ts bootstrap, boundary policy, and proxy in the loop.
 *  Run `pnpm --filter gateway build` first; the spec skips (with reason)
 *  when the artifact or database is absent. */
const GATEWAY_DIST_MAIN = path.resolve(
  __dirname,
  "../../../services/gateway/dist/main.js",
);
const describeWithStack =
  TEST_DATABASE_URL && fs.existsSync(GATEWAY_DIST_MAIN) ? describe : describe.skip;

const assertDisposableTarget = (url: string | undefined): void => {
  const configured = String(databaseOptions().database);
  if (!url) return;
  const db = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
  if (!db || db.toLowerCase() === configured.toLowerCase()) {
    throw new Error("TEST_DATABASE_URL must name a disposable database");
  }
};

/** Fake `opencode serve`: counts session starts, issues UNIQUE authorize
 *  URLs, honors the real basic-auth contract, instance-local pending. */
const FAKE_SERVER_SCRIPT = `
const http = require("node:http");
const fs = require("node:fs");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const fixturePath = process.env.OPENCODE_FAKE_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
fs.appendFileSync(fixturePath + ".starts", process.pid + "\\n");
let pending = null;
let authorizeCount = 0;
const record = (name, body) => {
  try { fs.appendFileSync(fixturePath + "." + name, JSON.stringify(body) + "\\n"); } catch {}
};
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401); res.end(); return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
  const url = req.url || "/";
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url === "/provider") return send(200, fixture.providers);
  if (req.method === "GET" && url === "/provider/auth") return send(200, fixture.authMethods);
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/authorize")) {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    record("authorize", body);
    pending = body;
    authorizeCount += 1;
    return send(200, { url: "https://provider.example/authorize?state=" + process.pid + "-" + authorizeCount, method: "auto", instructions: "Complete authorization in the provider window." });
  }
  if (req.method === "POST" && url.startsWith("/provider/") && url.endsWith("/oauth/callback")) {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    record("callback", body);
    if (pending === null) return send(200, false);
    pending = null;
    return send(200, true);
  }
  send(404, { error: "not found" });
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

type Json = Record<string, unknown>;

const gatewayRequest = (
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers:
          body !== undefined ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });

describeWithStack("Post-PP1 hardening: reload-resume across the REAL Gateway route", () => {
  jest.setTimeout(90_000);
  let dataSource: DataSource;
  let fixtureDir: string;
  let orchApp: INestApplication;
  let gatewayChild: import("node:child_process").ChildProcess | undefined;
  let gatewayPort: number;
  let gatewayBase: string;
  let connectionId: string;

  beforeAll(async () => {
    assertDisposableTarget(TEST_DATABASE_URL);
    dataSource = new DataSource({
      ...databaseOptions(),
      type: "postgres" as const,
      url: TEST_DATABASE_URL,
    } as DataSourceOptions);
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    await dataSource.runMigrations();

    // Fake opencode management server (unique authorize URLs, start counter).
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenvyr-reload-resume-"));
    const fixturePath = path.join(fixtureDir, "fixture.json");
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        providers: { all: [{ id: "openai" }], default: {}, connected: ["openai"] },
        authMethods: { openai: [{ type: "oauth", label: "OAuth" }] },
      }),
    );
    const fakeServer = path.join(fixtureDir, "fake-opencode.cjs");
    // Standalone executable: OpenCodeManagementSession spawns
    // `<cli.command> serve --port N --hostname 127.0.0.1`, so the fake IS
    // the command (shebang entry) and parses the same argv contract.
    fs.writeFileSync(fakeServer, `#!/usr/bin/env node\n${FAKE_SERVER_SCRIPT}`, {
      mode: 0o755,
    });
    (globalThis as any).__reloadResumeFixturePath = fixturePath;
    // The connection's envAllowlist resolves this HOST variable at spawn.
    process.env.OPENCODE_FAKE_FIXTURE = fixturePath;

    // REAL RuntimeConnection row whose frozen profile runs the fake server.
    const connections = new RuntimeConnectionService(dataSource);
    connectionId = "conn:reload-resume";
    await connections.createConnection(connectionId, {
      name: "Reload Resume Opencode",
      runtimeKind: "opencode",
      executorId: "local-host",
      credentialRefs: [],
      declaredCapabilities: { invocation: { supported: true, source: "configured" } },
      cli: {
        command: fakeServer,
        args: [],
        envAllowlist: { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" },
        probe: { args: ["--version"] },
      },
    });

    // REAL services: discovery authority + audited operator commands.
    const discovery = new ProviderDiscoveryService(dataSource);
    const commands = new WorkbenchCommandService(
      dataSource,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      discovery,
    );

    // Fixture Orchestrator surface hosting the REAL production controller.
    const orchModule = await Test.createTestingModule({
      controllers: [ProviderDiscoveryController],
      providers: [
        { provide: ProviderDiscoveryService, useValue: discovery },
        { provide: WorkbenchCommandService, useValue: commands },
      ],
    }).compile();
    orchApp = orchModule.createNestApplication();
    await orchApp.listen(0, "127.0.0.1");
    const orchPort = (orchApp.getHttpAdapter().getHttpServer().address() as AddressInfo).port;

    // REAL Gateway as a REAL PROCESS (built dist main.js): actual
    // bootstrap boundary, proxy controller, and Socket.IO gateway.
    const { spawn } = await import("node:child_process");
    const freePort = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    gatewayChild = spawn(process.execPath, [GATEWAY_DIST_MAIN], {
      env: {
        ...process.env,
        ORCHESTRATOR_URL: `http://127.0.0.1:${orchPort}`,
        GATEWAY_PORT: String(freePort),
        GATEWAY_HOST: "127.0.0.1",
      },
      stdio: "ignore",
    });
    gatewayPort = freePort;
    gatewayBase = `http://127.0.0.1:${freePort}`;
    // Wait for the real /health endpoint.
    for (let i = 0; i < 100; i++) {
      try {
        const health = await gatewayRequest(gatewayBase, "GET", "/health");
        if (health.status === 200) break;
      } catch {
        // not up yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });

  afterAll(async () => {
    if (gatewayChild) {
      gatewayChild.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        gatewayChild!.once("exit", () => resolve());
        setTimeout(() => {
          try {
            gatewayChild?.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 2_000);
      });
    }
    if (orchApp) await orchApp.close().catch(() => {});
    delete process.env.ORCHESTRATOR_URL;
    delete process.env.OPENCODE_FAKE_FIXTURE;
    delete (globalThis as any).__reloadResumeFixturePath;
    await dataSource?.destroy().catch(() => {});
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("Begin -> F5 resume through Gateway -> Complete on the SAME retained session", async () => {
    const fixturePath = path.join(fixtureDir, "fixture.json");

    // Step 1: Begin OAuth through the REAL Gateway proxy (audited command).
    const beginRes = await gatewayRequest(gatewayBase, "POST", "/api/provider-discovery/commands/oauth-begin", {
      idempotencyKey: `reload-resume-${Date.now()}`,
      connectionId,
      providerId: "openai",
      methodIndex: 0,
      expectedMethodType: "oauth",
      expectedMethodLabel: "OAuth",
    });
    expect([200, 201]).toContain(beginRes.status);
    expect(beginRes.json.success).toBe(true);
    const begun = ((beginRes.json.data as Json).result as Json);
    expect(begun.resumed).toBe(false);
    const authFlowId = begun.authFlowId as string;
    const originalUrl = begun.url as string;
    expect(authFlowId).toMatch(/^[0-9a-f]{32}$/);

    // Step 2: browser F5 — ALL frontend state lost; the Runtimes page
    // calls the Gateway active-flow route.
    const resumeRes = await gatewayRequest(
      gatewayBase,
      "GET",
      `/api/provider-discovery/auth-flows/active?connectionId=${encodeURIComponent(connectionId)}`,
    );
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.json.success).toBe(true);
    const flows = resumeRes.json.data as Json[];
    expect(flows).toHaveLength(1);
    const resumed = flows[0];
    // SAME flow identity, SAME exact stored authorization URL.
    expect(resumed.authFlowId).toBe(authFlowId);
    expect(resumed.url).toBe(originalUrl);
    expect(resumed.instructions).toBe("Complete authorization in the provider window.");
    expect(typeof resumed.expiresAt).toBe("number");
    // Bounded NON-SECRET projection: never a management password/token.
    const serialized = JSON.stringify(flows);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/OPENCODE_SERVER_PASSWORD/);
    expect(Object.keys(resumed).sort()).toEqual(
      [
        "authFlowId",
        "authorizationMethod",
        "connectionId",
        "connectionRevision",
        "expiresAt",
        "instructions",
        "methodIndex",
        "methodLabel",
        "methodType",
        "providerId",
        "url",
      ].sort(),
    );

    // Step 3: Complete using the RESUMED authFlowId — the callback MUST
    // hit the SAME retained management session (instance-local pending).
    const completeRes = await gatewayRequest(gatewayBase, "POST", "/api/provider-discovery/commands/oauth-complete", {
      idempotencyKey: `reload-resume-complete-${Date.now()}`,
      authFlowId,
    });
    expect([200, 201]).toContain(completeRes.status);
    const completed = ((completeRes.json.data as Json).result as Json);
    expect(completed.connected).toBe(true);
    expect(completed.providerId).toBe("openai");

    // Step 4: side-effect truth — EXACTLY one server start, EXACTLY one
    // authorize; the callback landed on that same live instance.
    const starts = fs.readFileSync(`${fixturePath}.starts`, "utf8").trim().split("\n");
    expect(starts).toHaveLength(1);
    const authorizes = fs.readFileSync(`${fixturePath}.authorize`, "utf8").trim().split("\n");
    expect(authorizes).toHaveLength(1);
    const callbacks = fs.readFileSync(`${fixturePath}.callback`, "utf8").trim().split("\n");
    expect(callbacks).toHaveLength(1);
    expect(JSON.parse(callbacks[0])).toEqual({ method: 0 });

    // Step 5: provider discovery proves connected THROUGH the Gateway.
    const discoverRes = await gatewayRequest(gatewayBase, "POST", "/api/provider-discovery/discover", {
      connectionId,
    });
    expect([200, 201]).toContain(discoverRes.status);
    const discovered = discoverRes.json.data as Json;
    const providers = discovered.providers as Array<Json>;
    expect(providers.find((p) => p.providerId === "openai")).toMatchObject({
      authenticated: true,
    });

    // Step 6: the flow is REMOVED after Complete — a second resume finds
    // nothing (fresh Begin would be required).
    const afterComplete = await gatewayRequest(
      gatewayBase,
      "GET",
      `/api/provider-discovery/auth-flows/active?connectionId=${encodeURIComponent(connectionId)}`,
    );
    expect(afterComplete.json.data).toEqual([]);
  });
});
