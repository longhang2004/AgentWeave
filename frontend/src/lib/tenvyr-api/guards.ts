/**
 * Runtime guards for authoritative Gateway/Orchestrator DTOs.
 *
 * Policy: authority/health states are NEVER defaulted optimistically. A
 * missing or malformed server field is an error (the UI shows
 * "Unknown / malformed response"), never a fabricated readiness literal.
 * Status enums are exhaustive; an unknown state string maps to "UNKNOWN",
 * not to "READY".
 */
import {
  CONNECTION_STATUS_REASON_CODES,
  CONNECTION_STATUS_STATES,
  type ActiveAuthFlowV1,
  type ConnectionStatusReasonCode,
  type ConnectionStatusState,
  type ConnectionTestReceiptV1,
  type ConnectionTestResultV1,
  type OpenCodeAuthBeginV1,
  type OpenCodeAuthMethodV1,
  type ProviderAuthMethodsV1,
  type ProviderDiscoveryV1,
  type RuntimeModelsRefreshV1,
  type RuntimeProviderV1,
  type TestTargetEvidenceV1,
  type WorkbenchCommandResultV1,
} from "./types.ts";

export class MalformedResponseError extends Error {
  public readonly path: string;

  constructor(path: string) {
    super(`Unknown / malformed response (invalid field: ${path})`);
    this.name = "MalformedResponseError";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isConnectionStatusState(
  value: unknown,
): value is ConnectionStatusState {
  return (
    typeof value === "string" &&
    (CONNECTION_STATUS_STATES as readonly string[]).includes(value)
  );
}

export function isConnectionStatusReasonCode(
  value: unknown,
): value is ConnectionStatusReasonCode {
  return (
    typeof value === "string" &&
    (CONNECTION_STATUS_REASON_CODES as readonly string[]).includes(value)
  );
}

/** Bounded strict parse of the connection-test receipt (backend
 *  `TestConnectionReceipt`). Every field is checked; unknown fields are
 *  rejected so a changed server shape cannot be silently coerced. */
export function parseConnectionTestReceipt(
  value: unknown,
): ConnectionTestReceiptV1 {
  if (!isRecord(value)) throw new MalformedResponseError("receipt");
  if (!isNonEmptyString(value.connectionId))
    throw new MalformedResponseError("receipt.connectionId");
  if (!isFiniteNumber(value.revisionNumber) || value.revisionNumber < 1) {
    throw new MalformedResponseError("receipt.revisionNumber");
  }
  if (!isNonEmptyString(value.testedAt))
    throw new MalformedResponseError("receipt.testedAt");
  if (!isConnectionStatusState(value.state)) {
    throw new MalformedResponseError(
      `receipt.state (got ${String(value.state)})`,
    );
  }
  if (!isConnectionStatusReasonCode(value.reasonCode)) {
    throw new MalformedResponseError(
      `receipt.reasonCode (got ${String(value.reasonCode)})`,
    );
  }
  if (!isFiniteNumber(value.durationMs) || value.durationMs < 0) {
    throw new MalformedResponseError("receipt.durationMs");
  }
  const receipt: ConnectionTestReceiptV1 = {
    connectionId: value.connectionId,
    revisionNumber: value.revisionNumber,
    testedAt: value.testedAt,
    state: value.state,
    reasonCode: value.reasonCode,
    durationMs: value.durationMs,
  };
  if (value.testedVersion !== undefined) {
    if (!isNonEmptyString(value.testedVersion)) {
      throw new MalformedResponseError("receipt.testedVersion");
    }
    receipt.testedVersion = value.testedVersion;
  }
  if (value.superseded !== undefined) {
    if (typeof value.superseded !== "boolean") {
      throw new MalformedResponseError("receipt.superseded");
    }
    receipt.superseded = value.superseded;
  }
  return receipt;
}

/**
 * Strict parse of the Workbench command envelope returned by
 * `POST /api/connections/:id/test`. The receipt is nested under
 * `result.receipt`; a response without it is malformed and must surface as
 * an error — it must never fall through to a fabricated "READY".
 */
export function parseConnectionTestResult(
  value: unknown,
): ConnectionTestResultV1 {
  if (!isRecord(value))
    throw new MalformedResponseError("test-connection result");
  if (value.action !== "test-connection") {
    throw new MalformedResponseError(`action (got ${String(value.action)})`);
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    throw new MalformedResponseError("idempotencyKey");
  }
  if (
    value.outcome !== "executed" &&
    value.outcome !== "duplicate" &&
    value.outcome !== "rejected"
  ) {
    throw new MalformedResponseError(`outcome (got ${String(value.outcome)})`);
  }
  if (!isRecord(value.result)) throw new MalformedResponseError("result");
  if (!isNonEmptyString(value.result.connectionId)) {
    throw new MalformedResponseError("result.connectionId");
  }
  return {
    action: "test-connection",
    idempotencyKey: value.idempotencyKey,
    outcome: value.outcome,
    result: {
      connectionId: value.result.connectionId,
      receipt: parseConnectionTestReceipt(value.result.receipt),
    },
  };
}

/**
 * Strict parse of the audited Workbench COMMAND envelope that the gateway
 * passes through verbatim: `{ action, idempotencyKey, outcome, result? }`.
 *
 * The gateway/orchestrator response is `{ success, data: <envelope> }`;
 * consumers MUST parse `data` with this guard — the previous class of bug
 * read `outcome` at the wrong nesting level and fell into the error branch
 * for every command (the AUTH_REQUIRED -> READY pattern). A malformed
 * envelope is an error, never an optimistic default.
 */
export function parseWorkbenchCommandResult<T = unknown>(
  value: unknown,
): WorkbenchCommandResultV1<T> {
  if (!isRecord(value)) throw new MalformedResponseError("workbench command result");
  if (!isNonEmptyString(value.action)) {
    throw new MalformedResponseError(`action (got ${String(value.action)})`);
  }
  if (!isNonEmptyString(value.idempotencyKey)) {
    throw new MalformedResponseError("idempotencyKey");
  }
  if (
    value.outcome !== "executed" &&
    value.outcome !== "duplicate" &&
    value.outcome !== "rejected"
  ) {
    throw new MalformedResponseError(`outcome (got ${String(value.outcome)})`);
  }
  const result: WorkbenchCommandResultV1<T> = {
    action: value.action,
    idempotencyKey: value.idempotencyKey,
    outcome: value.outcome,
  };
  if (value.result !== undefined) {
    if (!isRecord(value.result)) {
      throw new MalformedResponseError("result");
    }
    result.result = value.result as T;
  }
  if (value.error !== undefined) {
    if (
      !isRecord(value.error) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string"
    ) {
      throw new MalformedResponseError("error");
    }
    result.error = {
      code: value.error.code,
      message: value.error.message,
    };
  }
  return result;
}

/**
 * P2 closure round 2: strict guards for CONNECTION-SCOPED provider
 * discovery. Same policy as every authority/health DTO: missing or
 * malformed server fields are errors, never optimistic defaults.
 */
export function parseProviderDiscovery(value: unknown): ProviderDiscoveryV1 {
  if (!isRecord(value)) throw new MalformedResponseError("provider discovery");
  const { connectionId, revisionNumber, runtimeKind, providers } = value;
  if (!isNonEmptyString(connectionId)) throw new MalformedResponseError("provider discovery connectionId");
  if (typeof revisionNumber !== "number" || !Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new MalformedResponseError("provider discovery revisionNumber");
  }
  if (!isNonEmptyString(runtimeKind)) throw new MalformedResponseError("provider discovery runtimeKind");
  if (!Array.isArray(providers)) throw new MalformedResponseError("provider discovery providers");
  const parsed: RuntimeProviderV1[] = [];
  for (const entry of providers) {
    if (!isRecord(entry) || !isNonEmptyString(entry.providerId)) {
      throw new MalformedResponseError("provider entry");
    }
    if (typeof entry.authenticated !== "boolean") {
      throw new MalformedResponseError("provider authenticated");
    }
    parsed.push({
      providerId: entry.providerId,
      authenticated: entry.authenticated,
      loginCommand: typeof entry.loginCommand === "string" ? entry.loginCommand : "",
    });
  }
  return { connectionId, revisionNumber, runtimeKind, providers: parsed };
}

export function parseRuntimeModelsRefresh(value: unknown): RuntimeModelsRefreshV1 {
  if (!isRecord(value) || !isRecord(value.catalog)) {
    throw new MalformedResponseError("runtime models refresh");
  }
  if (!isNonEmptyString(value.connectionId)) throw new MalformedResponseError("models connectionId");
  const models = Array.isArray(value.catalog.models) ? value.catalog.models : [];
  if (!models.every((m) => isRecord(m) && typeof m.modelId === "string")) {
    throw new MalformedResponseError("models entries");
  }
  return {
    connectionId: value.connectionId,
    revisionNumber:
      typeof value.revisionNumber === "number" ? value.revisionNumber : 0,
    runtimeKind: typeof value.runtimeKind === "string" ? value.runtimeKind : "",
    catalog: {
      sourceId: typeof value.catalog.sourceId === "string" ? value.catalog.sourceId : "",
      discoveredAt:
        typeof value.catalog.discoveredAt === "string"
          ? value.catalog.discoveredAt
          : "",
      models: models.map((m) => ({
        modelId: String(m.modelId),
        ...(typeof m.providerId === "string" ? { providerId: m.providerId } : {}),
        ...(typeof m.source === "string" ? { source: m.source } : { source: "opencode" }),
      })),
      ...(value.catalog.truncated === true ? { truncated: true } : {}),
    },
  };
}

export function parseProviderAuthMethods(value: unknown): ProviderAuthMethodsV1 {
  if (!isRecord(value) || !Array.isArray(value.methods)) {
    throw new MalformedResponseError("provider auth methods");
  }
  const methods: OpenCodeAuthMethodV1[] = [];
  for (const entry of value.methods) {
    if (!isRecord(entry)) throw new MalformedResponseError("auth method entry");
    if (typeof entry.methodIndex !== "number" || !Number.isInteger(entry.methodIndex)) {
      throw new MalformedResponseError("auth method methodIndex");
    }
    if (entry.type !== "oauth" && entry.type !== "api") {
      throw new MalformedResponseError(`auth method type (got ${String(entry.type)})`);
    }
    if (typeof entry.label !== "string" || entry.label.length === 0) {
      throw new MalformedResponseError("auth method label");
    }
    methods.push({
      methodIndex: entry.methodIndex,
      type: entry.type,
      label: entry.label,
      requiresPrompt: entry.requiresPrompt === true,
    });
  }
  return {
    connectionId: String(value.connectionId ?? ""),
    revisionNumber: typeof value.revisionNumber === "number" ? value.revisionNumber : 0,
    runtimeKind: typeof value.runtimeKind === "string" ? value.runtimeKind : "",
    providerId: String(value.providerId ?? ""),
    methods,
  };
}

/** P2 final closure: strict parse of the BEGIN result — url validated,
 *  method exhaustive auto|code (unknown is malformed, never optimistic),
 *  bounded instructions. */
export function parseOpenCodeAuthBegin(value: unknown): OpenCodeAuthBeginV1 {
  if (!isRecord(value)) throw new MalformedResponseError("oauth begin");
  if (typeof value.authFlowId !== "string" || !/^[0-9a-f]{32}$/.test(value.authFlowId)) {
    throw new MalformedResponseError("authFlowId");
  }
  if (typeof value.url !== "string" || !isSafeHttpUrl(value.url)) {
    throw new MalformedResponseError("authorization url");
  }
  if (value.method !== "auto" && value.method !== "code") {
    throw new MalformedResponseError(`authorization method (got ${String(value.method)})`);
  }
  return {
    authFlowId: value.authFlowId,
    url: value.url,
    method: value.method,
    instructions: typeof value.instructions === "string" ? value.instructions : null,
    connectionId: String(value.connectionId ?? ""),
    connectionRevision: typeof value.connectionRevision === "number" ? value.connectionRevision : 0,
    providerId: String(value.providerId ?? ""),
  };
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

/** Post-PP1 hardening: strict parse of the browser-reload resume surface —
 *  bounded non-secret fields only; a malformed entry is dropped, never
 *  optimistically rendered. */
export function parseActiveAuthFlows(value: unknown): ActiveAuthFlowV1[] {
  if (!Array.isArray(value)) throw new MalformedResponseError("active auth flows");
  const flows: ActiveAuthFlowV1[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (
      typeof entry.authFlowId !== "string" ||
      !/^[0-9a-f]{32}$/.test(entry.authFlowId)
    ) {
      continue;
    }
    if (typeof entry.url !== "string" || !isSafeHttpUrl(entry.url)) continue;
    if (entry.authorizationMethod !== "auto" && entry.authorizationMethod !== "code") {
      continue;
    }
    if (
      entry.methodType !== "oauth" &&
      entry.methodType !== "api"
    ) {
      continue;
    }
    flows.push({
      authFlowId: entry.authFlowId,
      connectionId: String(entry.connectionId ?? ""),
      connectionRevision:
        typeof entry.connectionRevision === "number" ? entry.connectionRevision : 0,
      providerId: String(entry.providerId ?? ""),
      methodIndex: typeof entry.methodIndex === "number" ? entry.methodIndex : 0,
      methodType: entry.methodType,
      methodLabel: typeof entry.methodLabel === "string" ? entry.methodLabel : "",
      url: entry.url,
      authorizationMethod: entry.authorizationMethod,
      instructions: typeof entry.instructions === "string" ? entry.instructions : null,
      expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : 0,
    });
  }
  return flows;
}

/** Post-PP1 hardening: truthful run-picker readiness. Core filtering is
 *  accepted backend authority; this only labels it. REVOKED is never
 *  selectable; AUTH_REQUIRED points at the Runtimes sign-in; UNAVAILABLE
 *  carries its reason; DEGRADED stays selectable but visibly warned. */
export function pickerReadiness(c: {
  revoked: boolean;
  status: string;
  reasonCode: string | null;
}): { selectable: boolean; reason: string | null } {
  if (c.revoked || c.status === "REVOKED") {
    return { selectable: false, reason: "Revoked" };
  }
  switch (c.status) {
    case "AVAILABLE":
      return { selectable: true, reason: null };
    case "DEGRADED":
      return { selectable: true, reason: "Degraded — may fail" };
    case "AUTH_REQUIRED":
      return { selectable: false, reason: "Sign in on Runtimes" };
    case "UNAVAILABLE":
      return {
        selectable: false,
        reason: c.reasonCode ? `Unavailable (${c.reasonCode})` : "Unavailable",
      };
    case "DRAFT":
      return { selectable: false, reason: "Not tested yet" };
    default:
      return { selectable: false, reason: "Status unknown" };
  }
}

export function parseTestTargetEvidence(value: unknown): TestTargetEvidenceV1 {
  if (!isRecord(value)) throw new MalformedResponseError("test target evidence");
  if (value.status !== "ok" && value.status !== "failed") {
    // NEVER fabricate readiness from an unknown status.
    throw new MalformedResponseError(`test target status (got ${String(value.status)})`);
  }
  return {
    connectionId: String(value.connectionId ?? ""),
    revisionNumber: typeof value.revisionNumber === "number" ? value.revisionNumber : 0,
    runtimeKind: typeof value.runtimeKind === "string" ? value.runtimeKind : "",
    requestedModelId:
      typeof value.requestedModelId === "string" ? value.requestedModelId : null,
    status: value.status,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
    outputTruncated: value.outputTruncated === true,
  };
}

/**
 * A provider is a selectable Team Run target IFF the runtime reports it
 * AUTHENTICATED. Catalog visibility never equals execution compatibility.
 */
export function selectableProviders(
  discovery: ProviderDiscoveryV1 | null,
): RuntimeProviderV1[] {
  if (!discovery) return [];
  return discovery.providers.filter((provider) => provider.authenticated);
}

/** State identity for per-connection provider UI state: two connections
 *  with the same providerId must never share expanded/catalog/testing
 *  state. */
export function providerStateKey(connectionId: string, providerId: string): string {
  return `${connectionId}::${providerId}`;
}
