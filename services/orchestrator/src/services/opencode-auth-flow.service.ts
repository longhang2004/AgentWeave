/**
 * P2 final closure: bounded OpenCode AUTH FLOW — ONE live management
 * session retained across begin -> operator completes -> complete.
 *
 * OpenCode stores the pending OAuth result in INSTANCE-LOCAL in-memory
 * state: the callback MUST target the same live `opencode serve` instance
 * that performed authorize. The flow owns the session lifecycle:
 *
 *   begin (classify existing flow FIRST — compatible reuse / conflict with
 *         ZERO new server and ZERO authorize — then resolve revision ->
 *         start server -> fetch methods -> validate methodIndex +
 *         expected fingerprint -> POST authorize {method} -> RETAIN
 *         session + stored authorization URL)
 *     -> bounded { authFlowId, url, method: auto|code, instructions }
 *   operator completes provider-owned flow
 *   complete (SAME session -> POST callback {method, code?} -> GET
 *         /provider -> prove connected -> close server -> remove flow)
 *   resume (browser reload -> bounded read endpoint returns the SAME
 *         authFlowId/url/instructions from the retained session)
 *
 * Bounds: cryptographically random opaque authFlowId, short TTL, max
 * active flows, one flow per (connection revision, provider), cancel
 * endpoint, deterministic cleanup, process cleanup on timeout. On process
 * restart in-memory flows fail closed (the OpenCode pending state is
 * gone) — the operator must start authentication again. The server stays
 * 127.0.0.1 with a random password; passwords/tokens/codes are never
 * returned, logged, or persisted.
 */
import { randomBytes } from "node:crypto";
import { OnModuleDestroy } from "@nestjs/common";
import {
  OpenCodeManagementSession,
  type OpenCodeManagementProfile,
} from "./opencode-management.service";
import { OpenCodeServerError } from "../executors/opencode-server";

export type OpenCodeAuthFlowV1 = {
  authFlowId: string;
  connectionId: string;
  connectionRevision: number;
  providerId: string;
  methodIndex: number;
  /** Exact identity of the authorized method (fingerprint retained so a
   *  reordered fresh snapshot can never silently reuse this flow). */
  methodType: "oauth" | "api";
  methodLabel: string;
  /** The authorization URL returned by the RETAINED session's authorize —
   *  a resumed flow returns exactly this URL, never one from a discarded
   *  session. Bounded, non-secret. */
  url: string;
  authorizationMethod: "auto" | "code";
  instructions: string | null;
  expiresAt: number;
};

export class OpenCodeAuthFlowError extends Error {
  constructor(
    readonly code:
      | "AUTH_FLOW_NOT_FOUND"
      | "AUTH_FLOW_EXPIRED"
      | "AUTH_FLOW_LIMIT"
      | "AUTH_FLOW_CONFLICT"
      | "AUTH_METHOD_INVALID"
      | "AUTH_METHOD_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeAuthFlowError";
  }
}

/**
 * Post-PP1 hardening: process-local keyed mutex. Serializes OAuth Begin
 * per exact target (connectionId + connectionRevision + providerId) so
 * CONCURRENT duplicate Begins classify-then-authorize exactly once —
 * no second management session, no second /oauth/authorize, ever.
 * Chains are FIFO per key; every chain self-removes after release, so
 * the map never grows with completed targets and never leaks when Begin
 * throws (release runs in finally).
 */
export class BoundedKeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => acquired);
    this.chains.set(key, chain);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      void chain.then(() => {
        if (this.chains.get(key) === chain) this.chains.delete(key);
      });
    }
  }

  /** Test/observability surface: number of keys with pending chains. */
  pendingKeys(): number {
    return this.chains.size;
  }
}

type LiveFlow = OpenCodeAuthFlowV1 & {
  session: OpenCodeManagementSession;
  /** Deterministic expiry timer (unref'd — never keeps the process alive).
   *  On fire the flow is REMOVED atomically and the session closed. */
  expiryTimer: NodeJS.Timeout;
};

export class OpenCodeAuthFlowService implements OnModuleDestroy {
  static readonly FLOW_TTL_MS = 5 * 60_000;
  static readonly MAX_ACTIVE_FLOWS = 8;

  private readonly flows = new Map<string, LiveFlow>();

  constructor(
    private readonly ttlMs: number = OpenCodeAuthFlowService.FLOW_TTL_MS,
    private readonly maxFlows: number = OpenCodeAuthFlowService.MAX_ACTIVE_FLOWS,
  ) {}

  /**
   * Deterministic expiry: every flow gets a REAL timer at registration.
   * On fire, the flow is removed atomically and its management session is
   * closed — no sweep needs another auth operation to trigger it. The
   * timer is unref'd so idle flows never keep the process alive.
   * Race-safe: remove-then-close plus the session's idempotent close()
   * means complete/cancel/closeAll/expiry close a session at most once
   * and never resurrect a flow.
   */
  private expire(authFlowId: string): void {
    const flow = this.flows.get(authFlowId);
    if (!flow) return;
    this.flows.delete(authFlowId);
    clearTimeout(flow.expiryTimer);
    void flow.session.close();
  }

  private removeFlow(authFlowId: string): LiveFlow | undefined {
    const flow = this.flows.get(authFlowId);
    if (!flow) return undefined;
    this.flows.delete(authFlowId);
    clearTimeout(flow.expiryTimer);
    return flow;
  }

  /**
   * Post-PP1 hardening: classify an existing flow for the EXACT target
   * BEFORE any external side effect (no management session, no authorize).
   * Compatible = same connectionId + providerId + current connectionRevision
   * + methodIndex + expected method fingerprint. Same connection/provider
   * with any other identity is a CONFLICT (fail closed). Everything else
   * is "none" — the caller may start a fresh flow.
   */
  classifyExisting(input: {
    connectionId: string;
    connectionRevision: number;
    providerId: string;
    methodIndex: number;
    expectedType?: string;
    expectedLabel?: string;
  }):
    | { kind: "compatible"; flow: OpenCodeAuthFlowV1 }
    | { kind: "conflict"; message: string }
    | { kind: "none" } {
    for (const existing of this.flows.values()) {
      if (
        existing.connectionId !== input.connectionId ||
        existing.providerId !== input.providerId
      ) {
        continue;
      }
      const sameMethod =
        existing.methodIndex === input.methodIndex &&
        existing.connectionRevision === input.connectionRevision &&
        (input.expectedType === undefined || existing.methodType === input.expectedType) &&
        (input.expectedLabel === undefined || existing.methodLabel === input.expectedLabel);
      if (!sameMethod) {
        return {
          kind: "conflict",
          message: `an auth flow for ${input.providerId} on ${input.connectionId} is already active with a different target (revision ${existing.connectionRevision}, method ${existing.methodIndex} "${existing.methodLabel}") — cancel it first`,
        };
      }
      // Compatible active flow: refresh the bounded expiry so an operator
      // who re-opens the page keeps the SAME retained session alive.
      clearTimeout(existing.expiryTimer);
      const newExpiry = setTimeout(() => this.expire(existing.authFlowId), this.ttlMs);
      newExpiry.unref?.();
      existing.expiryTimer = newExpiry;
      existing.expiresAt = Date.now() + this.ttlMs;
      return { kind: "compatible", flow: this.toBounded(existing) };
    }
    return { kind: "none" };
  }

  private toBounded(flow: LiveFlow): OpenCodeAuthFlowV1 {
    return {
      authFlowId: flow.authFlowId,
      connectionId: flow.connectionId,
      connectionRevision: flow.connectionRevision,
      providerId: flow.providerId,
      methodIndex: flow.methodIndex,
      methodType: flow.methodType,
      methodLabel: flow.methodLabel,
      url: flow.url,
      authorizationMethod: flow.authorizationMethod,
      instructions: flow.instructions,
      expiresAt: flow.expiresAt,
    };
  }

  /**
   * Register a flow bound to the EXACT (connection revision, provider,
   * method fingerprint) with the LIVE session that performed authorize.
   * Fails closed when the method index is out of range or the method
   * requires prompt inputs Tenvyr will not drive.
   *
   * Ordering guarantee (post-PP1 hardening): the compatible-flow lookup
   * and conflict rejection run BEFORE the MAX_ACTIVE_FLOWS check, so an
   * existing flow stays idempotently retrievable even at capacity.
   */
  begin(input: {
    connectionId: string;
    connectionRevision: number;
    providerId: string;
    methodIndex: number;
    methods: Array<{
      methodIndex: number;
      type: "oauth" | "api";
      label: string;
      requiresPrompt: boolean;
    }>;
    session: OpenCodeManagementSession;
    authorization: {
      url: string;
      method: "auto" | "code";
      instructions: string | null;
    };
  }): OpenCodeAuthFlowV1 {
    const method = input.methods.find(
      (candidate) => candidate.methodIndex === input.methodIndex,
    );
    if (!method) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_METHOD_INVALID",
        `method index ${input.methodIndex} is not in the auth-method snapshot`,
      );
    }
    if (method.requiresPrompt) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_METHOD_UNSUPPORTED",
        `auth method "${method.label}" requires prompt inputs Tenvyr does not drive — use the official login command instead`,
      );
    }
    // Idempotent Begin / conflict detection FIRST — at capacity too.
    const classified = this.classifyExisting({
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      providerId: input.providerId,
      methodIndex: input.methodIndex,
      expectedType: method.type,
      expectedLabel: method.label,
    });
    if (classified.kind === "compatible") {
      // A competing session/authorize just happened on the losing side of
      // a race; close it and keep the ORIGINAL retained session.
      void input.session.close();
      return classified.flow;
    }
    if (classified.kind === "conflict") {
      void input.session.close();
      throw new OpenCodeAuthFlowError("AUTH_FLOW_CONFLICT", classified.message);
    }
    if (this.flows.size >= this.maxFlows) {
      void input.session.close();
      throw new OpenCodeAuthFlowError(
        "AUTH_FLOW_LIMIT",
        `too many active auth flows (max ${this.maxFlows})`,
      );
    }
    const authFlowId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + this.ttlMs;
    const expiryTimer = setTimeout(() => this.expire(authFlowId), this.ttlMs);
    expiryTimer.unref?.();
    const flow: LiveFlow = {
      authFlowId,
      connectionId: input.connectionId,
      connectionRevision: input.connectionRevision,
      providerId: input.providerId,
      methodIndex: input.methodIndex,
      methodType: method.type,
      methodLabel: method.label,
      url: input.authorization.url,
      authorizationMethod: input.authorization.method,
      instructions: input.authorization.instructions,
      expiresAt,
      session: input.session,
      expiryTimer,
    };
    this.flows.set(authFlowId, flow);
    return this.toBounded(flow);
  }

  /** Complete the flow through the SAME live session; on any failure the
   *  flow is closed (fail closed — the pending state cannot be resumed). */
  async complete(
    authFlowId: string,
    code?: string,
  ): Promise<{ connected: boolean; providerId: string; connectionId: string }> {
    const flow = this.removeFlow(authFlowId);
    if (!flow) {
      throw new OpenCodeAuthFlowError(
        "AUTH_FLOW_NOT_FOUND",
        "auth flow is missing or expired — start authentication again",
      );
    }
    try {
      const completed = await flow.session.completeOauth(
        flow.providerId,
        flow.methodIndex,
        code,
      );
      if (!completed) {
        return {
          connected: false,
          providerId: flow.providerId,
          connectionId: flow.connectionId,
        };
      }
      const list = await flow.session.providers();
      return {
        connected: list.connected.includes(flow.providerId),
        providerId: flow.providerId,
        connectionId: flow.connectionId,
      };
    } catch (error) {
      if (error instanceof OpenCodeServerError) {
        return {
          connected: false,
          providerId: flow.providerId,
          connectionId: flow.connectionId,
        };
      }
      throw error;
    } finally {
      await flow.session.close();
    }
  }

  /** Cancel: close the management session and drop the flow. Cleanup
   *  only — deliberately requires NO connection authority, so a stale
   *  flow can always be destroyed (never executed). */
  async cancel(authFlowId: string): Promise<boolean> {
    const flow = this.removeFlow(authFlowId);
    if (!flow) return false;
    await flow.session.close();
    return true;
  }

  /** Bounded non-secret read for authority fencing (null when absent). */
  getFlow(authFlowId: string): OpenCodeAuthFlowV1 | null {
    const flow = this.flows.get(authFlowId);
    return flow ? this.toBounded(flow) : null;
  }

  /** Authority-fencing destroy: close the retained session and remove the
   *  flow because it is stale (connection revoked or revised) — never a
   *  provider callback. */
  async destroy(authFlowId: string): Promise<boolean> {
    return this.cancel(authFlowId);
  }

  /** Post-PP1 authority fence: remove every flow for (connection,
   *  provider) bound to an OLD revision. Each retained management session
   *  is closed immediately; no provider callback occurs. Only the CURRENT
   *  revision may hold a live flow. */
  async evictStaleFor(
    connectionId: string,
    providerId: string,
    currentRevision: number,
  ): Promise<number> {
    let evicted = 0;
    for (const flow of Array.from(this.flows.values())) {
      if (
        flow.connectionId === connectionId &&
        flow.providerId === providerId &&
        flow.connectionRevision !== currentRevision
      ) {
        await this.cancel(flow.authFlowId);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Deterministic process cleanup — wired into the Nest lifecycle
   *  (OnModuleDestroy), so a graceful Orchestrator shutdown terminates
   *  every live management session and clears every timer. */
  async closeAll(): Promise<void> {
    const flows = Array.from(this.flows.values());
    for (const flow of flows) {
      clearTimeout(flow.expiryTimer);
    }
    this.flows.clear();
    await Promise.all(flows.map((flow) => flow.session.close()));
  }

  /** Graceful application shutdown: every live management session is
   *  terminated and every timer cleared. */
  async onModuleDestroy(): Promise<void> {
    await this.closeAll();
  }

  activeCount(): number {
    return this.flows.size;
  }

  // Resume after reload: return compatible active flow for (connection, provider) if exists and not expired
  getActiveFlowFor(connectionId: string, providerId: string): OpenCodeAuthFlowV1 | null {
    for (const flow of this.flows.values()) {
      if (flow.connectionId === connectionId && flow.providerId === providerId) {
        if (flow.expiresAt > Date.now()) {
          return this.toBounded(flow);
        }
        // Expired - clean up
        this.expire(flow.authFlowId);
        return null;
      }
    }
    return null;
  }

  // List all active flows (bounded, non-secret — resume surface)
  listActiveFlows(): OpenCodeAuthFlowV1[] {
    const now = Date.now();
    const result: OpenCodeAuthFlowV1[] = [];
    for (const flow of this.flows.values()) {
      if (flow.expiresAt > now) {
        result.push(this.toBounded(flow));
      }
    }
    return result;
  }
}

export function openCodeManagementProfileOf(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
): OpenCodeManagementProfile {
  return { command, cwd, env };
}
