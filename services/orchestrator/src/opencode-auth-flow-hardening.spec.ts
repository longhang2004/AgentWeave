import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeConnectionProfile } from "./executors/runtime-profiles";
import type { ConnectionRevisionV1 } from "./executors/runtime-connection";
import { ProviderDiscoveryController } from "./provider-discovery.controller";
import {
  ProviderDiscoveryService,
} from "./services/provider-discovery.service";
import { OpenCodeAuthFlowService } from "./services/opencode-auth-flow.service";

/**
 * Post-PP1 hardening closure — OpenCode OAuth Begin/Resume regressions
 * against a FAKE management server that COUNTS external side effects:
 *
 * - every `opencode serve` start appends a marker to `<fixture>.starts`;
 * - every POST /oauth/authorize appends to `<fixture>.authorize` and gets
 *   a UNIQUE url (state counter) so "same URL" can only mean "no second
 *   authorize happened".
 *
 * Proven here:
 * 1. duplicate compatible Begin is idempotent BEFORE any side effect
 *    (ONE server start, ONE authorize, SAME authFlowId, SAME original URL);
 * 2. incompatible Begin fails closed with AUTH_FLOW_CONFLICT before any
 *    new server / authorize;
 * 3. an expired flow is gone: a fresh Begin starts a NEW flow;
 * 4. a reordered/changed method snapshot fails closed AUTH_METHOD_INVALID
 *    with ZERO authorize;
 * 5. an existing flow stays idempotently retrievable AT CAPACITY;
 * 6. GET /provider-discovery/auth-flows/active returns bounded non-secret
 *    resume data including the EXACT stored authorization URL.
 */

/** Fake `opencode serve` with SIDE-EFFECT COUNTERS + unique authorize urls. */
const HARDENED_FAKE_SERVER = `
const http = require("node:http");
const fs = require("node:fs");
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const fixturePath = process.env.OPENCODE_FAKE_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const password = process.env.OPENCODE_SERVER_PASSWORD;
const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
fs.writeFileSync(fixturePath + ".pid", String(process.pid));
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
    return send(200, fixture.authorization ?? {
      url: "https://provider.example/authorize?state=unique-" + process.pid + "-" + authorizeCount,
      method: "auto",
      instructions: "Complete authorization in the provider window.",
    });
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

function hardenedFixture(
  name: string,
  methods: unknown[],
): { executable: string; fixturePath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `tenvyr-harden-${name}-`));
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      providers: {
        all: [{ id: "openai" }],
        default: {},
        // Same contract as the P2 fake: a successful callback proves
        // connected via refreshed GET /provider.
        connected: ["openai"],
      },
      authMethods: { openai: methods },
    }),
  );
  const scriptDir = mkdtempSync(join(tmpdir(), `tenvyr-harden-bin-${name}-`));
  const executable = join(scriptDir, "fixture.cjs");
  writeFileSync(executable, `#!/usr/bin/env node\n${HARDENED_FAKE_SERVER}`, {
    mode: 0o755,
  });
  return { executable, fixturePath, dir };
}

function openCodeRevision(
  connectionId: string,
  executable: string,
  envAllowlist?: Record<string, string>,
  revisionNumber = 1,
): ConnectionRevisionV1 {
  const profile = buildRuntimeConnectionProfile({
    runtimeKind: "opencode",
    name: connectionId,
    executorId: "local-host",
    executable,
  });
  profile.cli = { ...profile.cli!, ...(envAllowlist ? { envAllowlist } : {}) };
  return {
    schemaVersion: "1",
    connectionId,
    revisionNumber,
    createdAt: new Date().toISOString(),
    profile,
    configHash: "test-hash",
    capabilities: {
      invocation: { supported: true, source: "configured" },
      structuredResult: { supported: true, source: "configured" },
    },
  };
}

function service(
  revisions: Map<string, ConnectionRevisionV1>,
): ProviderDiscoveryService {
  const connections = {
    claimRevision: async (connectionId: string): Promise<ConnectionRevisionV1> => {
      const revision = revisions.get(connectionId);
      if (!revision) throw new Error(`no revision for ${connectionId}`);
      return revision;
    },
  } as unknown as ProviderDiscoveryService["connections"];
  const discovery = {
    discoverCodexModels: async (): Promise<never> => {
      throw new Error("not used");
    },
  } as unknown as ProviderDiscoveryService["discovery"];
  return new ProviderDiscoveryService({} as never, connections, discovery);
}

const TWO_OAUTH_METHODS = [
  { type: "oauth", label: "OAuth A" },
  { type: "oauth", label: "OAuth B" },
];

describe("Post-PP1 hardening: idempotent OAuth Begin BEFORE external side effects", () => {
  test("duplicate compatible Begin returns the EXISTING flow: same id, same ORIGINAL url, ONE server, ONE authorize", async () => {
    const fx = hardenedFixture("idempotent", TWO_OAUTH_METHODS);
    const svc = service(
      new Map([["conn:h", openCodeRevision("conn:h", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const first = await svc.beginAuthFlow({
        connectionId: "conn:h",
        providerId: "openai",
        methodIndex: 0,
        expectedMethodType: "oauth",
        expectedMethodLabel: "OAuth A",
      });
      expect(first.resumed).toBe(false);

      const second = await svc.beginAuthFlow({
        connectionId: "conn:h",
        providerId: "openai",
        methodIndex: 0,
        expectedMethodType: "oauth",
        expectedMethodLabel: "OAuth A",
      });
      expect(second.resumed).toBe(true);
      expect(second.authFlowId).toBe(first.authFlowId);
      // The EXACT stored URL of the retained session — never one from a
      // discarded session.
      expect(second.url).toBe(first.url);
      expect(second.instructions).toBe(first.instructions);

      // External side-effect truth: exactly ONE server start, exactly ONE
      // authorize.
      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(1);

      // The resumed flow still completes through the SAME retained session.
      const completed = await svc.completeAuthFlow(first.authFlowId);
      expect(completed.connected).toBe(true);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("incompatible active flow -> AUTH_FLOW_CONFLICT with ZERO new server and ZERO authorize", async () => {
    const fx = hardenedFixture("conflict", TWO_OAUTH_METHODS);
    const svc = service(
      new Map([["conn:hc", openCodeRevision("conn:hc", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const first = await svc.beginAuthFlow({
        connectionId: "conn:hc",
        providerId: "openai",
        methodIndex: 0,
      });
      await expect(
        svc.beginAuthFlow({
          connectionId: "conn:hc",
          providerId: "openai",
          methodIndex: 1, // different method on the same target
        }),
      ).rejects.toMatchObject({ code: "AUTH_FLOW_CONFLICT" });

      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(1);
      // Original flow untouched and completable.
      expect((await svc.completeAuthFlow(first.authFlowId)).connected).toBe(true);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("an existing flow stays idempotently retrievable AT MAX_ACTIVE_FLOWS capacity", async () => {
    const fx = hardenedFixture("capacity", [{ type: "oauth", label: "OAuth A" }]);
    const svc = service(
      new Map([["conn:hcap", openCodeRevision("conn:hcap", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const flowService = new OpenCodeAuthFlowService(60_000, 1); // capacity 1
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      const first = await svc.beginAuthFlow({
        connectionId: "conn:hcap",
        providerId: "openai",
        methodIndex: 0,
      });
      // At capacity (1/1), a duplicate compatible Begin must STILL return
      // the existing flow — never AUTH_FLOW_LIMIT.
      const again = await svc.beginAuthFlow({
        connectionId: "conn:hcap",
        providerId: "openai",
        methodIndex: 0,
      });
      expect(again.resumed).toBe(true);
      expect(again.authFlowId).toBe(first.authFlowId);
      expect(flowService.activeCount()).toBe(1);
    } finally {
      svcAny.authFlows = original;
      await flowService.onModuleDestroy();
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("EXPIRED flow is gone: a fresh Begin starts a NEW server and NEW authorize", async () => {
    const fx = hardenedFixture("expiry", [{ type: "oauth", label: "OAuth A" }]);
    const svc = service(
      new Map([["conn:hexp", openCodeRevision("conn:hexp", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const flowService = new OpenCodeAuthFlowService(150); // short TTL
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      const first = await svc.beginAuthFlow({
        connectionId: "conn:hexp",
        providerId: "openai",
        methodIndex: 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 250)); // let it expire
      const second = await svc.beginAuthFlow({
        connectionId: "conn:hexp",
        providerId: "openai",
        methodIndex: 0,
      });
      expect(second.resumed).toBe(false);
      expect(second.authFlowId).not.toBe(first.authFlowId);
      // Unique-per-authorize urls prove a REAL new authorize happened.
      expect(second.url).not.toBe(first.url);
      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(2);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(2);
    } finally {
      svcAny.authFlows = original;
      await flowService.onModuleDestroy();
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("METHOD REORDER fail-closed: fresh snapshot moved a different OAuth method to the index -> AUTH_METHOD_INVALID, ZERO authorize", async () => {
    const fx = hardenedFixture("reorder", TWO_OAUTH_METHODS);
    const svc = service(
      new Map([["conn:hro", openCodeRevision("conn:hro", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      // First flow against the ORIGINAL snapshot, then cancel it so only
      // the reorder path is exercised.
      const first = await svc.beginAuthFlow({
        connectionId: "conn:hro",
        providerId: "openai",
        methodIndex: 0,
        expectedMethodType: "oauth",
        expectedMethodLabel: "OAuth A",
      });
      await svc.cancelAuthFlow(first.authFlowId);

      // The runtime's NEXT discovery snapshot REORDERS its methods:
      // index 0 now carries "OAuth B".
      writeFileSync(
        fx.fixturePath,
        JSON.stringify({
          providers: { all: [{ id: "openai" }], default: {}, connected: [] },
          authMethods: {
            openai: [
              { type: "oauth", label: "OAuth B" },
              { type: "oauth", label: "OAuth A" },
            ],
          },
        }),
      );

      await expect(
        svc.beginAuthFlow({
          connectionId: "conn:hro",
          providerId: "openai",
          methodIndex: 0,
          expectedMethodType: "oauth",
          expectedMethodLabel: "OAuth A",
        }),
      ).rejects.toMatchObject({ code: "AUTH_METHOD_INVALID" });

      // Exactly ONE authorize ever happened (the cancelled first flow).
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(1);
      const bodies = authorizes.map((line) => JSON.parse(line));
      expect(bodies[0]).toEqual({ method: 0 }); // never authorized the moved method blindly

      // The CORRECT fingerprint still works after re-selection.
      const fixed = await svc.beginAuthFlow({
        connectionId: "conn:hro",
        providerId: "openai",
        methodIndex: 1,
        expectedMethodType: "oauth",
        expectedMethodLabel: "OAuth A",
      });
      expect(fixed.resumed).toBe(false);
      await svc.cancelAuthFlow(fixed.authFlowId);
      const authorizesAfter = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizesAfter).toHaveLength(2);
      expect(JSON.parse(authorizesAfter[1])).toEqual({ method: 1 });
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });
});

describe("Post-PP1 hardening: CONCURRENT Begin idempotency (Promise.all barrier)", () => {
  test("3 concurrent compatible Begins: ONE authFlowId, ONE url, EXACTLY 1 server start, EXACTLY 1 authorize", async () => {
    const fx = hardenedFixture("concurrent-same", [{ type: "oauth", label: "OAuth A" }]);
    const svc = service(
      new Map([["conn:hcc", openCodeRevision("conn:hcc", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const target = {
        connectionId: "conn:hcc",
        providerId: "openai",
        methodIndex: 0,
        expectedMethodType: "oauth" as const,
        expectedMethodLabel: "OAuth A",
      };
      const begun = await Promise.all([
        svc.beginAuthFlow(target),
        svc.beginAuthFlow(target),
        svc.beginAuthFlow(target),
      ]);
      // All callers receive the SAME exact flow.
      expect(new Set(begun.map((b) => b.authFlowId)).size).toBe(1);
      expect(new Set(begun.map((b) => b.url)).size).toBe(1);
      // Exactly one caller performed the fresh flow; the rest resumed it.
      expect(begun.filter((b) => b.resumed === false)).toHaveLength(1);
      expect(begun.filter((b) => b.resumed === true)).toHaveLength(2);

      // External side-effect truth: EXACTLY one management session start
      // and EXACTLY one /oauth/authorize across all three callers.
      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(1);

      // Exactly ONE LiveFlow exists.
      const flows = await svc.getActiveAuthFlows("conn:hcc");
      expect(flows).toHaveLength(1);

      // The retained session still completes.
      const completed = await svc.completeAuthFlow(begun[0].authFlowId);
      expect(completed.connected).toBe(true);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("concurrent INCOMPATIBLE methods: one exact method wins, loser gets AUTH_FLOW_CONFLICT, EXACTLY 1 start + 1 authorize", async () => {
    const fx = hardenedFixture("concurrent-conflict", TWO_OAUTH_METHODS);
    const svc = service(
      new Map([["conn:hcx", openCodeRevision("conn:hcx", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const outcomes = await Promise.allSettled([
        svc.beginAuthFlow({
          connectionId: "conn:hcx",
          providerId: "openai",
          methodIndex: 0,
          expectedMethodType: "oauth",
          expectedMethodLabel: "OAuth A",
        }),
        svc.beginAuthFlow({
          connectionId: "conn:hcx",
          providerId: "openai",
          methodIndex: 1,
          expectedMethodType: "oauth",
          expectedMethodLabel: "OAuth B",
        }),
      ]);
      // The FIRST caller wins (FIFO per-target lock); its method is the
      // authorized one. The loser is rejected with AUTH_FLOW_CONFLICT.
      expect(outcomes[0].status).toBe("fulfilled");
      expect(outcomes[1].status).toBe("rejected");
      const rejection = (outcomes[1] as PromiseRejectedResult).reason as { code?: string };
      expect(rejection.code).toBe("AUTH_FLOW_CONFLICT");
      const winner = (outcomes[0] as PromiseFulfilledResult<{ resumed: boolean; url: string }>).value;
      expect(winner.resumed).toBe(false);

      // Side-effect truth: EXACTLY one management session start, EXACTLY
      // one authorize — and it carried the WINNING method index. The
      // losing method was NEVER authorized.
      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8")
        .trim()
        .split("\n");
      expect(authorizes).toHaveLength(1);
      expect(JSON.parse(authorizes[0])).toEqual({ method: 0 });

      // Exactly ONE LiveFlow exists (the winner's).
      expect(await svc.getActiveAuthFlows("conn:hcx")).toHaveLength(1);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });
});

describe("Post-PP1 authority fence: OAuth flow bound to CURRENT non-revoked revision", () => {
  /** Mutable authority fixture: claimRevision re-reads the map EVERY call
   *  (never a snapshot), supports revocation, and an optional promise gate
   *  that parks the FIRST claim inside the Begin lock (deterministic
   *  cross-revision barrier — no sleeps). */
  function fencedService() {
    const revisions = new Map<string, ConnectionRevisionV1>();
    let revoked = false;
    let gate: Promise<void> | null = null;
    let releaseGate: (() => void) | null = null;
    let firstClaimEntered: (() => void) | null = null;
    const firstClaimEnteredPromise = new Promise<void>((resolve) => {
      firstClaimEntered = resolve;
    });
    let claims = 0;
    const connections = {
      claimRevision: async (id: string): Promise<ConnectionRevisionV1> => {
        if (revoked) {
          throw Object.assign(
            new Error(`Runtime connection "${id}" was revoked`),
            { code: "CONNECTION_REVOKED" },
          );
        }
        const revision = revisions.get(id);
        if (!revision) {
          throw Object.assign(new Error(`missing connection "${id}"`), {
            code: "CONNECTION_NOT_FOUND",
          });
        }
        claims += 1;
        if (claims === 1 && gate) {
          firstClaimEntered!();
          await gate;
        }
        // Re-read AFTER any gate: the CURRENT map value is authoritative.
        return revisions.get(id)!;
      },
    };
    const discovery = {
      discoverCodexModels: async (): Promise<never> => {
        throw new Error("not used");
      },
    } as unknown as ProviderDiscoveryService["discovery"];
    return {
      svc: new ProviderDiscoveryService(
        {} as never,
        connections as unknown as ProviderDiscoveryService["connections"],
        discovery,
      ),
      revisions,
      revoke: () => {
        revoked = true;
      },
      parkFirstClaimInsideLock: () => {
        gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        return firstClaimEnteredPromise;
      },
      releaseGateNow: () => releaseGate?.(),
    };
  }

  test("A. revoke after Begin: resume returns NOTHING, Complete denied CONNECTION_REVOKED, callback count 0, flow destroyed", async () => {
    const fx = hardenedFixture("fence-revoke", [{ type: "oauth", label: "OAuth A" }]);
    const fence = fencedService();
    fence.revisions.set(
      "conn:hfence",
      openCodeRevision("conn:hfence", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" }),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const begun = await fence.svc.beginAuthFlow({
        connectionId: "conn:hfence",
        providerId: "openai",
        methodIndex: 0,
      });
      expect((await fence.svc.getActiveAuthFlows("conn:hfence"))).toHaveLength(1);

      // The operator revokes the connection.
      fence.revoke();

      // Lazy fail-closed cleanup on COMPLETE (no prior resume): the
      // authority check fires BEFORE any provider callback.
      await expect(
        fence.svc.completeAuthFlow(begun.authFlowId),
      ).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });

      // Resume surface: empty — and the stale flow was destroyed.
      expect(await fence.svc.getActiveAuthFlows("conn:hfence")).toEqual([]);
      expect(await fence.svc.getActiveAuthFlows("conn:hfence")).toEqual([]);

      // No provider callback ever happened; a second Complete finds no flow.
      expect(existsSync(`${fx.fixturePath}.callback`)).toBe(false);
      await expect(fence.svc.completeAuthFlow(begun.authFlowId)).rejects.toMatchObject({
        code: "AUTH_FLOW_NOT_FOUND",
      });
      expect(existsSync(`${fx.fixturePath}.callback`)).toBe(false);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("B. revision update after Begin: old flow STALE (no callback), resume empty, fresh Begin uses revision 2", async () => {
    const fx = hardenedFixture("fence-revise", [{ type: "oauth", label: "OAuth A" }]);
    const fence = fencedService();
    fence.revisions.set(
      "conn:hrev",
      openCodeRevision("conn:hrev", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" }, 1),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      const f1 = await fence.svc.beginAuthFlow({
        connectionId: "conn:hrev",
        providerId: "openai",
        methodIndex: 0,
      });
      expect(f1.connectionRevision).toBe(1);

      // The connection is revised: current revision becomes 2.
      fence.revisions.set(
        "conn:hrev",
        openCodeRevision("conn:hrev", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" }, 2),
      );

      // Complete F1 FIRST: stale → AUTH_FLOW_STALE with ZERO callbacks.
      await expect(fence.svc.completeAuthFlow(f1.authFlowId)).rejects.toMatchObject({
        code: "AUTH_FLOW_STALE",
      });
      expect(existsSync(`${fx.fixturePath}.callback`)).toBe(false);

      // Resume returns nothing (stale flow destroyed, session closed).
      expect(await fence.svc.getActiveAuthFlows("conn:hrev")).toEqual([]);

      // Fresh Begin runs under revision 2: NEW authFlowId, new authorize.
      const f2 = await fence.svc.beginAuthFlow({
        connectionId: "conn:hrev",
        providerId: "openai",
        methodIndex: 0,
      });
      expect(f2.resumed).toBe(false);
      expect(f2.connectionRevision).toBe(2);
      expect(f2.authFlowId).not.toBe(f1.authFlowId);
      expect(f2.url).not.toBe(f1.url); // unique-per-authorize urls

      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(2); // one per revision, never reused across
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8").trim().split("\n");
      expect(authorizes).toHaveLength(2);
      // The old retained session was closed at eviction/complete-fence:
      // completing F2 works through the NEW live session only.
      const completed = await fence.svc.completeAuthFlow(f2.authFlowId);
      expect(completed.connected).toBe(true);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });

  test("C. cross-revision CONCURRENT Begin barrier: exactly ONE start + ONE authorize under the CURRENT revision", async () => {
    const fx = hardenedFixture("fence-race", [{ type: "oauth", label: "OAuth A" }]);
    const fence = fencedService();
    fence.revisions.set(
      "conn:hrace",
      openCodeRevision("conn:hrace", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" }, 1),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    try {
      // Park B1 INSIDE the lock, before its authoritative revision resolve
      // completes — deterministic barrier, no sleeps.
      const parked = fence.parkFirstClaimInsideLock();
      const target = {
        connectionId: "conn:hrace",
        providerId: "openai",
        methodIndex: 0,
        expectedMethodType: "oauth" as const,
        expectedMethodLabel: "OAuth A",
      };
      const b1 = fence.svc.beginAuthFlow(target);
      const b2 = fence.svc.beginAuthFlow(target); // waits on the SAME mutex
      await parked;

      // Revision transition happens while B1 holds the lock, before its
      // side effects. B1 must therefore authorize under N+1 — never N.
      fence.revisions.set(
        "conn:hrace",
        openCodeRevision("conn:hrace", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" }, 2),
      );
      fence.releaseGateNow();

      const [r1, r2] = await Promise.all([b1, b2]);
      // Both callers receive the SAME flow, created under revision 2.
      expect(r1.authFlowId).toBe(r2.authFlowId);
      expect(r1.url).toBe(r2.url);
      expect(r1.resumed).toBe(false);
      expect(r2.resumed).toBe(true);
      const flows = await fence.svc.getActiveAuthFlows("conn:hrace");
      expect(flows).toHaveLength(1);
      expect(flows[0].connectionRevision).toBe(2);

      // Under NO interleaving may there be two authorizes.
      const starts = readFileSync(`${fx.fixturePath}.starts`, "utf8").trim().split("\n");
      expect(starts).toHaveLength(1);
      const authorizes = readFileSync(`${fx.fixturePath}.authorize`, "utf8").trim().split("\n");
      expect(authorizes).toHaveLength(1);
    } finally {
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });
});

describe("Post-PP1 hardening: browser-reload resume endpoint (bounded, non-secret)", () => {
  test("GET auth-flows/active returns the SAME flow with its stored URL; nothing secret; expired -> no resume", async () => {
    const fx = hardenedFixture("resume", [{ type: "oauth", label: "OAuth A" }]);
    const svc = service(
      new Map([["conn:hres", openCodeRevision("conn:hres", fx.executable, { OPENCODE_FAKE_FIXTURE: "OPENCODE_FAKE_FIXTURE" })]]),
    );
    process.env.OPENCODE_FAKE_FIXTURE = fx.fixturePath;
    const controller = new ProviderDiscoveryController(svc, {} as never);
    const flowService = new OpenCodeAuthFlowService(200);
    const svcAny = svc as unknown as { authFlows: OpenCodeAuthFlowService };
    const original = svcAny.authFlows;
    svcAny.authFlows = flowService;
    try {
      // No flow yet -> empty resume surface.
      const before = await controller.activeAuthFlow("conn:hres");
      expect(before).toEqual({ success: true, data: [] });

      const begun = await svc.beginAuthFlow({
        connectionId: "conn:hres",
        providerId: "openai",
        methodIndex: 0,
      });

      const after = await controller.activeAuthFlow("conn:hres");
      expect(after.success).toBe(true);
      const flows = after.data as Array<Record<string, unknown>>;
      expect(flows).toHaveLength(1);
      const view = flows[0];
      expect(view.authFlowId).toBe(begun.authFlowId);
      expect(view.url).toBe(begun.url); // exact stored authorization URL
      expect(view.connectionId).toBe("conn:hres");
      expect(view.providerId).toBe("openai");
      expect(view.methodIndex).toBe(0);
      expect(view.methodType).toBe("oauth");
      expect(view.methodLabel).toBe("OAuth A");
      expect(view.authorizationMethod).toBe("auto");
      expect(typeof view.expiresAt).toBe("number");
      // Bounded NON-SECRET projection: no session/password/token material.
      expect(Object.keys(view).sort()).toEqual(
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

      // Narrowing by provider works; unknown provider yields nothing.
      const narrowed = await controller.activeAuthFlow("conn:hres", "openai");
      expect((narrowed.data as unknown[]).length).toBe(1);
      const other = await controller.activeAuthFlow("conn:hres", "anthropic");
      expect(other.data).toEqual([]);

      // Expiry -> NO resume; operator starts a new flow.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const expired = await controller.activeAuthFlow("conn:hres");
      expect(expired.data).toEqual([]);
      expect(flowService.activeCount()).toBe(0);
    } finally {
      svcAny.authFlows = original;
      await flowService.onModuleDestroy();
      delete process.env.OPENCODE_FAKE_FIXTURE;
    }
  });
});
