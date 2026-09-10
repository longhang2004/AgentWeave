import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import {
  httpCorsOrigins,
  parseCorsAllowList,
  resolveHttpBoundary,
  socketIoCorsOrigin,
} from "./local-origin";

/**
 * Post-PP1 hardening closure — Gateway bootstrap host/CORS + Socket.IO
 * origin policy, verified against a REAL listening Nest app:
 *
 * - default loopback bind + explicit GATEWAY_HOST override;
 * - NO HTTP CORS by default; explicit bounded allow-list when configured;
 * - CORS_ORIGIN=* rejected fail-closed (never reaches Nest/Socket.IO);
 * - engine.io handshake: loopback browser origins allowed by default,
 *   arbitrary origins get NO Access-Control-Allow-Origin (browsers block
 *   them), an explicit allow-list REPLACES the default.
 */

const handshake = (
  base: string,
  origin?: string,
): Promise<{ status: number; acaoHeader: string | undefined; open: boolean }> =>
  new Promise((resolve, reject) => {
    const req = http.get(
      `${base}/socket.io/?EIO=4&transport=polling&t=harden-${Date.now()}`,
      origin ? { headers: { Origin: origin } } : {},
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            acaoHeader: res.headers["access-control-allow-origin"] as
              | string
              | undefined,
            // Engine.io v4 open packet starts with "0{...}".
            open: body.startsWith("0{"),
          }),
        );
      },
    );
    req.on("error", reject);
  });

describe("Post-PP1 hardening: Gateway local-boundary contract", () => {
  it("default bind is IPv4 loopback; explicit host override is preserved", () => {
    expect(
      resolveHttpBoundary(
        { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
        {},
      ),
    ).toMatchObject({ host: "127.0.0.1", port: 3000 });
    expect(
      resolveHttpBoundary(
        { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
        { GATEWAY_HOST: "192.168.1.50" },
      ).host,
    ).toBe("192.168.1.50");
  });

  it("NO HTTP CORS by default; explicit trusted allow-list passes; '*' is REJECTED", () => {
    expect(httpCorsOrigins(undefined)).toBe(false);
    expect(httpCorsOrigins("http://localhost:4000")).toEqual([
      "http://localhost:4000",
    ]);
    expect(() => parseCorsAllowList("*")).toThrow(/wildcard/i);
    expect(() => socketIoCorsOrigin("*")).toThrow(/wildcard/i);
  });

  it("the orchestrator twin of the shared origin policy never drifts", () => {
    const here = readFileSync(join(__dirname, "local-origin.ts"), "utf8");
    const twin = readFileSync(
      join(__dirname, "..", "..", "orchestrator", "src", "local-origin.ts"),
      "utf8",
    );
    expect(twin).toBe(here);
  });

  describe("REAL Socket.IO handshake against the listening gateway app", () => {
    jest.setTimeout(30_000);
    let app: INestApplication | undefined;

    const boot = async (): Promise<INestApplication> => {
      const { AppModule } = await import("./app.module");
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const application = moduleRef.createNestApplication();
      await application.listen(0, "127.0.0.1");
      return application;
    };

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
      delete process.env.CORS_ORIGIN;
    });

    it("default policy: loopback browser origin connects; arbitrary origin gets no CORS grant", async () => {
      delete process.env.CORS_ORIGIN;
      jest.resetModules();
      app = await boot();
      const base = await app.getUrl();

      // Loopback browser origin (the dev Workbench on :4000) — allowed.
      const loopback = await handshake(base, "http://localhost:4000");
      expect(loopback.open).toBe(true);
      expect(loopback.acaoHeader).toBe("http://localhost:4000");

      // Arbitrary browser origin — NO Access-Control-Allow-Origin, so
      // browsers refuse the connection.
      const evil = await handshake(base, "https://evil.example");
      expect(evil.acaoHeader).toBeUndefined();

      // Non-browser client (no Origin header) — allowed.
      const serverToServer = await handshake(base);
      expect(serverToServer.open).toBe(true);
    });

    it("explicit CORS_ORIGIN allow-list REPLACES the default loopback policy", async () => {
      process.env.CORS_ORIGIN = "https://trusted.example";
      jest.resetModules();
      app = await boot();
      const base = await app.getUrl();

      const trusted = await handshake(base, "https://trusted.example");
      expect(trusted.open).toBe(true);
      expect(trusted.acaoHeader).toBe("https://trusted.example");

      // The default loopback grant is gone once an explicit list exists.
      const loopback = await handshake(base, "http://localhost:4000");
      expect(loopback.acaoHeader).toBeUndefined();
    });
  });
});
