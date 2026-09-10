import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  httpCorsOrigins,
  parseCorsAllowList,
  resolveHttpBoundary,
  socketIoCorsOrigin,
} from "./local-origin";
import { allocateReconnectConnectionId } from "./services/workbench-command.service";
import { RUNTIME_PROFILE_TEMPLATES } from "./executors/runtime-profiles";
import { RuntimeOnboardingService } from "./services/runtime-onboarding.service";

/**
 * Post-PP1 hardening closure — repository-truth regressions:
 *
 * 1. local-boundary contract: loopback default bind, explicit host
 *    override, NO HTTP CORS by default, bounded CORS_ORIGIN allow-list,
 *    literal "*" rejected fail-closed, Socket.IO never wildcard;
 * 2. revoke -> reconnect candidate allocation: ANY existing row at a
 *    candidate id is skipped; first ABSENT candidate wins;
 * 3. onboarding docUrl truth.
 */

describe("Post-PP1 hardening: HTTP/WS local-boundary contract", () => {
  it("default bind is IPv4 loopback for both services", () => {
    expect(
      resolveHttpBoundary(
        { hostEnv: "ORCHESTRATOR_HOST", portEnv: "ORCHESTRATOR_PORT", defaultPort: 3001 },
        {},
      ).host,
    ).toBe("127.0.0.1");
    expect(
      resolveHttpBoundary(
        { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
        {},
      ).host,
    ).toBe("127.0.0.1");
  });

  it("explicit host override is preserved", () => {
    expect(
      resolveHttpBoundary(
        { hostEnv: "ORCHESTRATOR_HOST", portEnv: "ORCHESTRATOR_PORT", defaultPort: 3001 },
        { ORCHESTRATOR_HOST: "192.168.1.10" },
      ).host,
    ).toBe("192.168.1.10");
    expect(
      resolveHttpBoundary(
        { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
        { GATEWAY_HOST: "0.0.0.0", GATEWAY_PORT: "8080" },
      ),
    ).toMatchObject({ host: "0.0.0.0", port: 8080 });
  });

  it("NO HTTP CORS by default (same-origin Workbench proxy)", () => {
    expect(httpCorsOrigins(undefined)).toBe(false);
    expect(httpCorsOrigins("")).toBe(false);
    expect(
      resolveHttpBoundary(
        { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
        {},
      ).corsOrigin,
    ).toBe(false);
  });

  it("explicit trusted CORS allow-list passes through bounded", () => {
    expect(httpCorsOrigins("http://localhost:4000, https://ops.example.com")).toEqual([
      "http://localhost:4000",
      "https://ops.example.com",
    ]);
  });

  it("CORS_ORIGIN=* is REJECTED fail-closed — never passed to Nest or Socket.IO", () => {
    expect(() => parseCorsAllowList("*")).toThrow(/wildcard/i);
    expect(() => httpCorsOrigins("*")).toThrow(/wildcard/i);
    expect(() => httpCorsOrigins("http://a.example,*,http://b.example")).toThrow(/wildcard/i);
    expect(() => socketIoCorsOrigin("*")).toThrow(/wildcard/i);
    // Even a single "*" among whitespace entries fails closed.
    expect(() => parseCorsAllowList(" , * , ")).toThrow(/wildcard/i);
  });

  it("Socket.IO default origin policy accepts loopback browser origins only", () => {
    const option = socketIoCorsOrigin(undefined);
    expect(typeof option).toBe("function");
    const decide = (origin?: string): boolean | undefined => {
      let result: boolean | undefined;
      (option as (o: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void)(
        origin,
        (_err, ok) => {
          result = ok;
        },
      );
      return result;
    };
    expect(decide("http://localhost:4000")).toBe(true);
    expect(decide("http://127.0.0.1:3000")).toBe(true);
    expect(decide(undefined)).toBe(true); // non-browser client
    expect(decide("https://evil.example")).toBe(false);
    expect(decide("ftp://127.0.0.1:3000")).toBe(false);
    expect(decide("not a url")).toBe(false);
  });

  it("Socket.IO explicit allow-list replaces the default and never contains '*'", () => {
    const option = socketIoCorsOrigin("https://ops.example.com");
    expect(option).toEqual(["https://ops.example.com"]);
  });

  it("the gateway twin of the shared origin policy never drifts", () => {
    const here = readFileSync(join(__dirname, "local-origin.ts"), "utf8");
    const twin = readFileSync(
      join(__dirname, "..", "..", "gateway", "src", "local-origin.ts"),
      "utf8",
    );
    expect(twin).toBe(here);
  });

  it("internal routing defaults stay explicit IPv4 loopback (never localhost)", () => {
    // Source regression: while services bind only IPv4 loopback, an
    // internal default pointing at "localhost" can resolve to ::1 and
    // silently miss the bind. Human-facing summaries may still say
    // localhost — these assertions pin DEFAULT ASSIGNMENTS only.
    const mustUseLoopbackDefault = [
      // Next.js same-origin proxy -> Gateway
      ["../../../frontend/next.config.js", 'process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3000"'],
      // Gateway -> Orchestrator
      ["../../gateway/src/app.controller.ts", 'process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3001"'],
      // Orchestrator -> Gateway webhook
      ["services/engine.service.ts", 'process.env.GATEWAY_URL || "http://127.0.0.1:3000"'],
      // Frontend API client SSR default -> Gateway
      ["../../../frontend/src/lib/tenvyr-api/client.ts", '"http://127.0.0.1:3000"'],
      // Dev manifest service URLs (health checks + internal addressing)
      ["../../../scripts/dev.mjs", "url: `http://127.0.0.1:${port}`"],
      // Smoke script internal defaults for IPv4-loopback-bound services
      // (Gateway, Orchestrator, Python worker example). Reviewer /
      // observability / runner / frontend targets keep localhost: those
      // services do not bind IPv4-only.
      ["../../../scripts/smoke-e2e.mjs", 'process.env.SMOKE_GATEWAY_URL || "http://127.0.0.1:3000"'],
      ["../../../scripts/smoke-e2e.mjs", 'process.env.SMOKE_ORCHESTRATOR_URL || "http://127.0.0.1:3001"'],
      ["../../../scripts/smoke-e2e.mjs", 'process.env.SMOKE_PYTHON_WORKER_URL || "http://127.0.0.1:8080"'],
    ] as const;
    for (const [relativePath, expectedDefault] of mustUseLoopbackDefault) {
      const source = readFileSync(join(__dirname, relativePath), "utf8");
      expect(source).toContain(expectedDefault);
    }
    // The legacy localhost defaults are gone from exactly these files.
    const noLocalhostDefaults = [
      "../../../frontend/next.config.js",
      "../../gateway/src/app.controller.ts",
      "services/engine.service.ts",
      "../../../frontend/src/lib/tenvyr-api/client.ts",
    ] as const;
    for (const relativePath of noLocalhostDefaults) {
      const source = readFileSync(join(__dirname, relativePath), "utf8");
      expect(source).not.toMatch(/http:\/\/localhost:(3000|3001|3002)/);
    }
  });
});

describe("Post-PP1 hardening: revoke -> reconnect candidate allocation", () => {
  it("skips an OCCUPIED non-revoked suffix and picks the first ABSENT candidate", () => {
    // default revoked; conn:codex-2 already occupied by a LIVE row ->
    // conn:codex-3 must be chosen; old rows are unchanged (pure input).
    const taken = ["conn:codex", "conn:codex-2"];
    const input = [...taken];
    const chosen = allocateReconnectConnectionId(taken, "codex", () => "zzz");
    expect(chosen).toBe("conn:codex-3");
    // Old rows unchanged by construction.
    expect(input).toEqual(taken);
  });

  it("never resurrects any existing row regardless of its status or kind", () => {
    const taken = [
      "conn:codex",
      "conn:codex-2",
      "conn:codex-3",
      "conn:codex-4",
      "conn:claude",
    ];
    expect(allocateReconnectConnectionId(taken, "codex", () => "rand1")).toBe(
      "conn:codex-5",
    );
  });

  it("falls back to COLLISION-CHECKED random suffixes when bounded suffixes are exhausted", () => {
    const taken = new Set<string>();
    for (let i = 2; i < 100; i++) taken.add(`conn:codex-${i}`);
    // Deterministic random: first two collide with taken ids, third is free.
    const suffixes = ["2", "77", "fresh"];
    const chosen = allocateReconnectConnectionId(taken, "codex", () => {
      const next = suffixes.shift() ?? "fallback";
      return next;
    });
    expect(chosen).toBe("conn:codex-fresh");
  });

  it("throws when no id can be allocated (no unchecked attempt ever ships)", () => {
    const taken = new Set<string>(["conn:codex"]);
    for (let i = 2; i < 100; i++) taken.add(`conn:codex-${i}`);
    // Every random attempt collides too.
    taken.add("conn:codex-always-taken");
    expect(() =>
      allocateReconnectConnectionId(taken, "codex", () => "always-taken"),
    ).toThrow(/no free reconnect connection id/);
  });
});

describe("Post-PP1 hardening: onboarding docUrl truth", () => {
  it("every supported runtime template declares a documentation URL and status surfaces it", async () => {
    const kinds = RuntimeOnboardingService.kinds();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const template = RUNTIME_PROFILE_TEMPLATES[kind];
      expect(typeof template.sourceUrl).toBe("string");
      expect(template.sourceUrl.startsWith("https://")).toBe(true);
      // Not-detected path still carries the authoritative docUrl.
      const originalPath = process.env.PATH;
      process.env.PATH = "/nonexistent-path-for-docurl-spec";
      try {
        const status = await new RuntimeOnboardingService().status(kind);
        expect(status.docUrl).toBe(template.sourceUrl);
      } finally {
        process.env.PATH = originalPath;
      }
    }
  });
});
