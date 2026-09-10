import { TenvyrApiError } from "./errors.ts";
import type {
  ActiveAuthFlowV1,
  ApiResponse,
  RuntimeKind,
  RuntimeOnboardingStatusV1,
  WorkbenchConnectionCardV1,
  ConnectionTemplateV1,
  WorkbenchWorkspaceV1,
  TeamTemplateV1,
  StartTeamRunRequest,
  WorkbenchCommandResultV1,
  WorkbenchExecutionSummaryV1,
  WorkbenchExecutionProjectionV1,
  AttentionViewV1,
  CoordinationConfigV1,
  CapsuleSummaryV1,
  AuditItemV1,
  Pipeline,
  LegacyExecution,
  ConnectionTestResultV1,
  ModelSourceV1,
  ModelCatalogSnapshotV1,
  ProviderDiscoveryV1,
  RuntimeModelsRefreshV1,
  ProviderAuthMethodsV1,
  TestTargetEvidenceV1,
  OpenCodeAuthBeginV1,
} from "./types.ts";

// Internal loopback default (server-side rendering / node clients) — IPv4
// explicit so it never depends on localhost address-family resolution.
export const GATEWAY_API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== "undefined" ? "" : "http://127.0.0.1:3000");

export class TenvyrApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = GATEWAY_API_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          ...(options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...options.headers,
        },
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new TenvyrApiError(
        `Failed to reach Tenvyr Gateway at ${this.baseUrl}: ${message}`,
        0,
        "NETWORK_ERROR",
        { path, originalError: message },
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw new TenvyrApiError(
          `Gateway returned HTTP ${response.status} ${response.statusText}`,
          response.status,
          `HTTP_${response.status}`,
        );
      }
      return null as unknown as T;
    }

    if (!response.ok) {
      throw TenvyrApiError.fromResponse(response.status, data);
    }

    return data as T;
  }

  // Health
  async getHealth(): Promise<ApiResponse<{ status: string; service: string }>> {
    return this.request("/health");
  }

  // Runtime Onboarding
  async getRuntimeOnboarding(
    kind: RuntimeKind | string,
  ): Promise<{ status: RuntimeOnboardingStatusV1 }> {
    return this.request(
      `/api/workbench/onboarding/${encodeURIComponent(kind)}`,
    );
  }

  async onboardRuntime(
    runtimeKind: RuntimeKind | string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ connectionId: string }>>> {
    return this.request("/api/workbench/commands/onboard-runtime", {
      method: "POST",
      body: { runtimeKind, idempotencyKey },
    });
  }

  // Runtime Connections
  async getWorkbenchConnections(): Promise<{
    cards: WorkbenchConnectionCardV1[];
    serverTime: string;
  }> {
    return this.request("/api/workbench/connections");
  }

  async getConnectionTemplates(): Promise<ApiResponse<ConnectionTemplateV1[]>> {
    return this.request("/api/connections/templates");
  }

  async getConnections(): Promise<ApiResponse<unknown[]>> {
    return this.request("/api/connections");
  }

  async getConnection(connectionId: string): Promise<ApiResponse<unknown>> {
    return this.request(`/api/connections/${encodeURIComponent(connectionId)}`);
  }

  async createConnection(
    connectionId: string,
    profile: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<unknown>> {
    return this.request("/api/connections", {
      method: "POST",
      body: { connectionId, profile, idempotencyKey },
    });
  }

  async reviseConnection(
    connectionId: string,
    profile: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<unknown>> {
    return this.request(
      `/api/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: { profile, idempotencyKey },
      },
    );
  }

  async testConnection(
    connectionId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<ConnectionTestResultV1>> {
    return this.request(
      `/api/connections/${encodeURIComponent(connectionId)}/test`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  async revokeConnection(
    connectionId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<unknown>> {
    return this.request(
      `/api/connections/${encodeURIComponent(connectionId)}/revoke`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  // Workspaces
  async getWorkspaces(): Promise<{ workspaces: WorkbenchWorkspaceV1[] }> {
    return this.request("/api/workbench/workspaces");
  }

  async createWorkspace(
    data: { name?: string; path: string },
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ workspace: WorkbenchWorkspaceV1 }>>> {
    return this.request("/api/workbench/commands/create-workspace", {
      method: "POST",
      body: { ...data, idempotencyKey },
    });
  }

  // Team Templates & Team Run
  async getTeamTemplates(): Promise<{ templates: TeamTemplateV1[] }> {
    return this.request("/api/workbench/commands/team-templates");
  }

  async startTeamRun(
    request: StartTeamRunRequest,
  ): Promise<
    ApiResponse<WorkbenchCommandResultV1<{ executionId: string; workspace?: string }>>
  > {
    return this.request("/api/workbench/commands/start-team-run", {
      method: "POST",
      body: request,
    });
  }

  async releaseExecutionWorkspace(
    workspaceExecutionId: string,
    idempotencyKey: string = crypto.randomUUID(),
    reason?: string,
  ): Promise<
    ApiResponse<
      WorkbenchCommandResultV1<{
        workspaceExecutionId: string;
        state: string;
      }>
    >
  > {
    return this.request(
      `/api/workbench/commands/workspaces/${encodeURIComponent(workspaceExecutionId)}/release`,
      {
        method: "POST",
        body: { idempotencyKey, ...(reason ? { reason } : {}) },
      },
    );
  }

  // Model Sources
  async getModelSources(): Promise<ApiResponse<ModelSourceV1[]>> {
    return this.request("/api/model-sources");
  }

  async createModelSource(
    source: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ source: ModelSourceV1 }>>> {
    return this.request("/api/model-sources", {
      method: "POST",
      body: { idempotencyKey, source },
    });
  }

  async updateModelSource(
    sourceId: string,
    patch: unknown,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ source: ModelSourceV1 }>>> {
    return this.request(`/api/model-sources/${encodeURIComponent(sourceId)}`, {
      method: "PATCH",
      body: { idempotencyKey, patch },
    });
  }

  async deleteModelSource(
    sourceId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1>> {
    return this.request(`/api/model-sources/${encodeURIComponent(sourceId)}`, {
      method: "DELETE",
      body: { idempotencyKey },
    });
  }

  /** Test Model Source (endpoint/auth/catalog — never inference). */
  async testModelSource(
    sourceId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ source: ModelSourceV1 }>>> {
    return this.request(
      `/api/model-sources/${encodeURIComponent(sourceId)}/test`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  /** Refresh Models: bounded on-demand catalog projection. */
  async refreshModelSource(
    sourceId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<
    ApiResponse<
      WorkbenchCommandResultV1<{ source: ModelSourceV1; catalog: ModelCatalogSnapshotV1 }>
    >
  > {
    return this.request(
      `/api/model-sources/${encodeURIComponent(sourceId)}/refresh`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  // P2 closure round 2: CONNECTION-SCOPED provider/model discovery. The
  // backend resolves the connection's CURRENT revision and uses its fixed
  // profile — the frontend never supplies executables/cwd/env/runtimeKind.

  async discoverRuntimeProviders(
    connectionId: string,
  ): Promise<ApiResponse<ProviderDiscoveryV1>> {
    return this.request("/api/provider-discovery/discover", {
      method: "POST",
      body: { connectionId },
    });
  }

  async refreshRuntimeModels(
    connectionId: string,
    providerId?: string,
  ): Promise<ApiResponse<RuntimeModelsRefreshV1>> {
    return this.request("/api/provider-discovery/refresh-models", {
      method: "POST",
      body: { connectionId, ...(providerId ? { providerId } : {}) },
    });
  }

  async getRuntimeProviderAuthMethods(
    connectionId: string,
    providerId: string,
  ): Promise<ApiResponse<ProviderAuthMethodsV1>> {
    return this.request("/api/provider-discovery/auth-methods", {
      method: "POST",
      body: { connectionId, providerId },
    });
  }

  /** Audited: a SMALL BOUNDED REAL invocation through the connection.
   *  May consume provider credits/tokens. */
  async testRuntimeTarget(
    connectionId: string,
    modelId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ evidence: TestTargetEvidenceV1 }>>> {
    return this.request("/api/provider-discovery/commands/test-target", {
      method: "POST",
      body: { idempotencyKey, connectionId, modelId },
    });
  }

  /** Audited: BEGIN the runtime-owned OpenCode auth flow with the SELECTED
   *  METHOD INDEX plus its expected fingerprint (type + label) from the
   *  selection UI. Idempotent BEFORE external side effects: an existing
   *  compatible flow is returned unchanged; a reordered/changed method
   *  fails closed. The same live management session completes the flow;
   *  Tenvyr never sees tokens. */
  async openCodeOauthBegin(
    connectionId: string,
    providerId: string,
    methodIndex: number,
    expected?: { type: "oauth" | "api"; label: string },
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<OpenCodeAuthBeginV1>>> {
    return this.request("/api/provider-discovery/commands/oauth-begin", {
      method: "POST",
      body: {
        idempotencyKey,
        connectionId,
        providerId,
        methodIndex,
        ...(expected ? { expectedMethodType: expected.type, expectedMethodLabel: expected.label } : {}),
      },
    });
  }

  /** Post-PP1 hardening: browser-reload resume read — the active unexpired
   *  auth flow(s) for a connection (optionally one provider). Bounded
   *  non-secret data only (authFlowId, method identity, authorization URL,
   *  instructions, expiry); never the management-server password/token. */
  async getActiveAuthFlows(
    connectionId: string,
    providerId?: string,
  ): Promise<ApiResponse<ActiveAuthFlowV1[]>> {
    const params = new URLSearchParams({ connectionId });
    if (providerId) params.set("providerId", providerId);
    return this.request(
      `/api/provider-discovery/auth-flows/active?${params.toString()}`,
    );
  }

  /** Audited: COMPLETE the flow through the same live session. The bounded
   *  code (code flow only) is sent once and never logged/persisted. */
  async openCodeOauthComplete(
    authFlowId: string,
    code?: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ connected: boolean }>>> {
    return this.request("/api/provider-discovery/commands/oauth-complete", {
      method: "POST",
      body: { idempotencyKey, authFlowId, ...(code !== undefined ? { code } : {}) },
    });
  }

  /** Cancel an in-flight auth flow (closes its management session). */
  async openCodeOauthCancel(authFlowId: string): Promise<ApiResponse<{ cancelled: boolean }>> {
    return this.request("/api/provider-discovery/commands/oauth-cancel", {
      method: "POST",
      body: { authFlowId },
    });
  }

  // Workbench Executions & Supervision
  async getWorkbenchExecutions(page: number = 1): Promise<{
    items: WorkbenchExecutionSummaryV1[];
    serverTime: string;
    page: number;
    truncated: boolean;
  }> {
    return this.request(
      `/api/workbench/executions?page=${encodeURIComponent(page)}`,
    );
  }

  async getWorkbenchExecution(
    executionId: string,
  ): Promise<WorkbenchExecutionProjectionV1> {
    return this.request(
      `/api/workbench/executions/${encodeURIComponent(executionId)}`,
    );
  }

  /** PP1 Slice B: exception-driven Attention queue (READ projection). */
  async getAttention(): Promise<AttentionViewV1> {
    return this.request(`/api/workbench/attention`);
  }

  async resolveWait(
    runId: string,
    approve: boolean,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1>> {
    return this.request(
      `/api/workbench/commands/waits/${encodeURIComponent(runId)}`,
      {
        method: "POST",
        body: { approve, idempotencyKey },
      },
    );
  }

  async cancelWorkbenchExecution(
    executionId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1>> {
    return this.request(
      `/api/workbench/commands/executions/${encodeURIComponent(executionId)}/cancel`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  async replayWorkbenchExecution(
    executionId: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ executionId: string }>>> {
    return this.request(
      `/api/workbench/commands/executions/${encodeURIComponent(executionId)}/replay`,
      {
        method: "POST",
        body: { idempotencyKey },
      },
    );
  }

  /** PP1 Slice C: continue a TERMINAL run on a NEW runtime team (bounded
   *  HandoffBundle as initial context, exclusive workspace transfer). */
  async continueWorkbenchExecution(
    executionId: string,
    request: {
      idempotencyKey: string;
      config: CoordinationConfigV1;
    },
  ): Promise<
    ApiResponse<
      WorkbenchCommandResultV1<{
        executionId: string;
        runId: string;
        bundleHash: string;
        sourceExecutionId: string;
      }>
    >
  > {
    return this.request(
      `/api/workbench/commands/executions/${encodeURIComponent(executionId)}/continue`,
      {
        method: "POST",
        body: request,
      },
    );
  }

  // Capsule, Compare, Audit
  async getCapsule(
    executionId: string,
  ): Promise<{ capsule: CapsuleSummaryV1 }> {
    return this.request(
      `/api/workbench/executions/${encodeURIComponent(executionId)}/capsule`,
    );
  }

  async compareExecutions(
    executionA: string,
    executionB: string,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<ApiResponse<WorkbenchCommandResultV1<{ comparison: unknown }>>> {
    return this.request("/api/workbench/commands/compare", {
      method: "POST",
      body: { executionA, executionB, idempotencyKey },
    });
  }

  async getAuditTrail(
    action?: string,
  ): Promise<{ items: AuditItemV1[]; truncated: boolean; serverTime: string }> {
    const query = action ? `?action=${encodeURIComponent(action)}` : "";
    return this.request(`/api/workbench/commands/audit${query}`);
  }

  // Legacy Pipelines
  async getPipelines(): Promise<ApiResponse<Pipeline[]>> {
    return this.request("/api/pipelines");
  }

  async getPipeline(id: string): Promise<ApiResponse<Pipeline>> {
    return this.request(`/api/pipelines/${encodeURIComponent(id)}`);
  }

  async createPipeline(body: unknown): Promise<ApiResponse<Pipeline>> {
    return this.request("/api/pipelines", {
      method: "POST",
      body,
    });
  }

  async getLegacyExecutions(): Promise<ApiResponse<LegacyExecution[]>> {
    return this.request("/api/executions");
  }

  async getLegacyExecution(id: string): Promise<ApiResponse<LegacyExecution>> {
    return this.request(`/api/executions/${encodeURIComponent(id)}`);
  }

  async triggerLegacyExecution(body: {
    pipelineId: string;
    input?: unknown;
  }): Promise<ApiResponse<LegacyExecution>> {
    return this.request("/api/executions", {
      method: "POST",
      body,
    });
  }

  async cancelLegacyExecution(id: string): Promise<ApiResponse<unknown>> {
    return this.request(`/api/executions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  }
}

export const tenvyrApi = new TenvyrApiClient();
