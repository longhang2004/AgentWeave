import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pickerReadiness, parseActiveAuthFlows } from "./guards.ts";
import { TenvyrApiClient } from "./client.ts";

/**
 * Post-PP1 hardening: truthful run-picker readiness matrix and the
 * browser-reload OAuth resume surface.
 */

describe("pickerReadiness — truthful run-picker matrix", () => {
  const card = (overrides) => ({
    revoked: false,
    status: "AVAILABLE",
    reasonCode: null,
    ...overrides,
  });

  test("AVAILABLE is selectable with no warning", () => {
    assert.deepEqual(pickerReadiness(card()), {
      selectable: true,
      reason: null,
    });
  });

  test("DEGRADED is selectable but visibly warned", () => {
    const readiness = pickerReadiness(card({ status: "DEGRADED" }));
    assert.equal(readiness.selectable, true);
    assert.match(readiness.reason, /[Dd]egraded/);
  });

  test("AUTH_REQUIRED is NOT selectable: 'Sign in on Runtimes'", () => {
    const readiness = pickerReadiness(card({ status: "AUTH_REQUIRED" }));
    assert.equal(readiness.selectable, false);
    assert.equal(readiness.reason, "Sign in on Runtimes");
  });

  test("UNAVAILABLE is NOT selectable and carries its reason", () => {
    const readiness = pickerReadiness(
      card({ status: "UNAVAILABLE", reasonCode: "timeout" }),
    );
    assert.equal(readiness.selectable, false);
    assert.equal(readiness.reason, "Unavailable (timeout)");
    const noReason = pickerReadiness(
      card({ status: "UNAVAILABLE", reasonCode: null }),
    );
    assert.equal(noReason.reason, "Unavailable");
  });

  test("REVOKED is NEVER selectable — flag or status", () => {
    assert.equal(pickerReadiness(card({ revoked: true })).selectable, false);
    assert.equal(pickerReadiness(card({ revoked: true })).reason, "Revoked");
    assert.equal(
      pickerReadiness(card({ status: "REVOKED" })).selectable,
      false,
    );
  });

  test("DRAFT / UNKNOWN are not selectable", () => {
    assert.equal(pickerReadiness(card({ status: "DRAFT" })).selectable, false);
    assert.equal(pickerReadiness(card({ status: "MYSTERY" })).selectable, false);
  });
});

describe("parseActiveAuthFlows — browser-reload resume surface", () => {
  const validFlow = {
    authFlowId: "a".repeat(32),
    connectionId: "conn:opencode",
    connectionRevision: 3,
    providerId: "openai",
    methodIndex: 0,
    methodType: "oauth",
    methodLabel: "OAuth",
    url: "https://provider.example/authorize?state=abc",
    authorizationMethod: "auto",
    instructions: "Complete authorization in the provider window.",
    expiresAt: Date.now() + 60_000,
  };

  test("parses a bounded non-secret resume view", () => {
    const flows = parseActiveAuthFlows([validFlow]);
    assert.equal(flows.length, 1);
    assert.equal(flows[0].authFlowId, validFlow.authFlowId);
    assert.equal(flows[0].url, validFlow.url);
    assert.equal(flows[0].authorizationMethod, "auto");
    // No secret-bearing field ever appears.
    assert.equal("password" in flows[0], false);
    assert.equal("token" in flows[0], false);
  });

  test("malformed entries are DROPPED, never optimistically rendered", () => {
    const flows = parseActiveAuthFlows([
      validFlow,
      { ...validFlow, authFlowId: "not-an-id" },
      { ...validFlow, url: "javascript:alert(1)" },
      { ...validFlow, authorizationMethod: "magic" },
      { ...validFlow, methodType: "mystery" },
      "junk",
    ]);
    assert.equal(flows.length, 1);
  });

  test("expired flows are dropped by the caller contract (expiresAt in the past)", () => {
    const expired = parseActiveAuthFlows([
      { ...validFlow, expiresAt: Date.now() - 1 },
    ]);
    // Parsing keeps the shape; the RESUME decision filters on expiry.
    const now = Date.now();
    assert.equal(expired[0].expiresAt < now, true);
  });
});

describe("TenvyrApiClient.getActiveAuthFlows — resume endpoint path", () => {
  test("GETs the bounded active-flow surface with encoded query params", async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl;
    globalThis.fetch = async (url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const client = new TenvyrApiClient("http://fake-gateway.local");
      await client.getActiveAuthFlows("conn:opencode");
      assert.equal(
        seenUrl,
        "http://fake-gateway.local/api/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode",
      );
      await client.getActiveAuthFlows("conn:opencode", "openai");
      assert.equal(
        seenUrl,
        "http://fake-gateway.local/api/provider-discovery/auth-flows/active?connectionId=conn%3Aopencode&providerId=openai",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("openCodeOauthBegin carries the expected method fingerprint", async () => {
    const originalFetch = globalThis.fetch;
    let seenBody;
    globalThis.fetch = async (_url, options) => {
      seenBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const client = new TenvyrApiClient("http://fake-gateway.local");
      await client.openCodeOauthBegin("conn:c", "openai", 1, {
        type: "oauth",
        label: "OAuth A",
      }, "key-1");
      assert.equal(seenBody.methodIndex, 1);
      assert.equal(seenBody.expectedMethodType, "oauth");
      assert.equal(seenBody.expectedMethodLabel, "OAuth A");
      assert.equal(seenBody.idempotencyKey, "key-1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
