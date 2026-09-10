import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";

/**
 * Post-PP1 hardening closure — REAL Gateway route test for the
 * browser-reload resume proxy:
 *
 *   frontend-style GET /api/provider-discovery/auth-flows/active?...
 *     -> Gateway AppModule (real)
 *     -> fixture Orchestrator upstream
 *     -> exact bounded active-flow JSON returned unchanged.
 *
 * Covers query forwarding, empty results, and upstream error propagation.
 */

type UpstreamCall = { path: string | undefined };

const startUpstream = (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number; calls: UpstreamCall[] }> =>
  new Promise((resolve) => {
    const calls: UpstreamCall[] = [];
    const server = http.createServer((req, res) => {
      calls.push({ path: req.url });
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, calls });
    });
  });

const get = (base: string, path: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      })
      .on("error", reject);
  });

describe("Post-PP1 hardening: Gateway active-flow resume proxy (real route)", () => {
  jest.setTimeout(30_000);
  let app: INestApplication;
  let upstream: Awaited<ReturnType<typeof startUpstream>>;

  const bootGateway = async (upstreamPort: number): Promise<INestApplication> => {
    process.env.ORCHESTRATOR_URL = `http://127.0.0.1:${upstreamPort}`;
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const application = moduleRef.createNestApplication();
    await application.listen(0, "127.0.0.1");
    return application;
  };

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined as unknown as INestApplication;
    }
    if (upstream) {
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      upstream = undefined as unknown as typeof upstream;
    }
    delete process.env.ORCHESTRATOR_URL;
  });

  it("forwards bounded query params and returns the exact active-flow projection unchanged", async () => {
    const activeFlow = {
      success: true,
      data: [
        {
          authFlowId: "b".repeat(32),
          connectionId: "conn:opencode",
          connectionRevision: 3,
          providerId: "openai",
          methodIndex: 0,
          methodType: "oauth",
          methodLabel: "OAuth",
          url: "https://provider.example/authorize?state=abc",
          authorizationMethod: "auto",
          instructions: "Complete authorization in the provider window.",
          expiresAt: 1755000000000,
        },
      ],
    };
    upstream = await startUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(activeFlow));
    });
    app = await bootGateway(upstream.port);
    const base = await app.getUrl();

    const res = await get(
      base,
      "/api/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode&providerId=openai",
    );
    // The Orchestrator bounded projection is returned UNCHANGED — same
    // authFlowId, URL, instructions, expiry; nothing added or dropped.
    expect(res.status).toBe(200);
    expect(res.body).toEqual(activeFlow);
    // Query forwarding: exactly connectionId + providerId reach upstream.
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].path).toBe(
      "/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode&providerId=openai",
    );

    // Narrowed call without providerId forwards only connectionId.
    await get(base, "/api/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode");
    expect(upstream.calls[1].path).toBe(
      "/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode",
    );
    // No params at all -> no query string.
    await get(base, "/api/provider-discovery/auth-flows/active");
    expect(upstream.calls[2].path).toBe("/provider-discovery/auth-flows/active");
  });

  it("returns an EMPTY result unchanged when no flow is active (expired or none)", async () => {
    upstream = await startUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [] }));
    });
    app = await bootGateway(upstream.port);
    const base = await app.getUrl();

    const res = await get(
      base,
      "/api/provider-discovery/auth-flows/active?connectionId=conn%3Aexpired",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  it("propagates upstream failure as the Gateway error envelope (never a fabricated flow)", async () => {
    upstream = await startUpstream((req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "orchestrator unavailable" }));
    });
    app = await bootGateway(upstream.port);
    const base = await app.getUrl();

    const res = await get(
      base,
      "/api/provider-discovery/auth-flows/active?connectionId=conn%3Ax",
    );
    expect(res.status).toBe(200); // Gateway envelopes upstream failures
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeNull();
    expect(String(res.body.error)).toContain("orchestrator unavailable");
  });
});
