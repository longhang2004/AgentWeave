import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
} from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SocketGateway } from "./socket.gateway";

const WORKBENCH_PAGE = readFileSync(
  join(__dirname, "workbench-page.html"),
  "utf8",
);

@Controller()
export class AppController {
  private orchestratorUrl: string;

  constructor(private socketGateway: SocketGateway) {
    // Internal loopback default — never depend on localhost address-family
    // resolution; explicit ORCHESTRATOR_URL override is preserved.
    this.orchestratorUrl =
      process.env.ORCHESTRATOR_URL || "http://127.0.0.1:3001";
  }

  @Get("health")
  getHealth() {
    return {
      success: true,
      data: {
        status: "UP",
        service: "gateway",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post("api/webhooks/execution-update")
  async handleExecutionWebhook(@Body() body: { executionId: string }) {
    const { executionId } = body;
    console.log(`Received execution webhook event for run: ${executionId}`);

    try {
      // Fetch full updated state from Orchestrator
      const data = await this.forwardToOrchestrator(
        `/executions/${executionId}`,
      );
      if (data.success) {
        this.socketGateway.broadcastExecutionUpdate(executionId, data.data);
      }
      return { success: true };
    } catch (err) {
      const message = this.getErrorMessage(err);
      console.error(
        `Failed to handle execution update for ${executionId}:`,
        message,
      );
      return { success: false, error: message };
    }
  }

  @Post("api/pipelines")
  async createPipeline(@Body() body: any) {
    return this.forwardToOrchestrator("/pipelines", {
      method: "POST",
      body,
    });
  }

  @Get("api/connections")
  async getConnections() {
    return this.forwardToOrchestrator("/connections");
  }

  /** M8-S4/S6: version-pinned runtime templates for the onboarding form.
   *  Declared before the `:connectionId` route (literal segment wins). */
  @Get("api/connections/templates")
  async getConnectionTemplates() {
    return this.forwardToOrchestrator("/connections/templates");
  }

  /** M8-S6: local operator create (revision 1). */
  @Post("api/connections")
  async createConnection(@Body() body: any) {
    return this.forwardToOrchestrator("/connections", {
      method: "POST",
      body,
    });
  }

  /** M8-S6: local operator revise (append immutable revision N+1). */
  @Patch("api/connections/:connectionId")
  async reviseConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}`,
      { method: "PATCH", body },
    );
  }

  @Get("api/connections/:connectionId")
  async getConnection(@Param("connectionId") connectionId: string) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}`,
    );
  }

  @Get("api/workbench/connections")
  async getWorkbenchConnections() {
    return this.forwardToOrchestrator("/workbench/connections");
  }

  @Get("api/workbench/onboarding/:runtimeKind")
  async getWorkbenchOnboarding(@Param("runtimeKind") runtimeKind: string) {
    return this.forwardToOrchestrator(
      `/workbench/onboarding/${encodeURIComponent(runtimeKind)}`,
    );
  }

  // P2: Model Sources — single-owner operator surface (same exposure
  // stance as connections; External Production Exposure Gate stays open).

  @Get("api/model-sources")
  async getModelSources() {
    return this.forwardToOrchestrator("/model-sources");
  }

  @Post("api/model-sources")
  async createModelSource(@Body() body: any) {
    return this.forwardToOrchestrator("/model-sources", {
      method: "POST",
      body,
    });
  }

  @Patch("api/model-sources/:sourceId")
  async updateModelSource(
    @Param("sourceId") sourceId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/model-sources/${encodeURIComponent(sourceId)}`,
      { method: "PATCH", body },
    );
  }

  @Delete("api/model-sources/:sourceId")
  async deleteModelSource(
    @Param("sourceId") sourceId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/model-sources/${encodeURIComponent(sourceId)}`,
      { method: "DELETE", body },
    );
  }

  @Post("api/model-sources/:sourceId/test")
  async testModelSource(
    @Param("sourceId") sourceId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/model-sources/${encodeURIComponent(sourceId)}/test`,
      { method: "POST", body },
    );
  }

  @Post("api/model-sources/:sourceId/refresh")
  async refreshModelSource(
    @Param("sourceId") sourceId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/model-sources/${encodeURIComponent(sourceId)}/refresh`,
      { method: "POST", body },
    );
  }

  @Post("api/provider-discovery/discover")
  async discoverProviders(@Body() body: any) {
    return this.forwardToOrchestrator("/provider-discovery/discover", {
      method: "POST",
      body,
    });
  }

  @Post("api/provider-discovery/refresh-models")
  async refreshRuntimeModels(@Body() body: any) {
    return this.forwardToOrchestrator("/provider-discovery/refresh-models", {
      method: "POST",
      body,
    });
  }

  @Post("api/provider-discovery/auth-methods")
  async providerAuthMethods(@Body() body: any) {
    return this.forwardToOrchestrator("/provider-discovery/auth-methods", {
      method: "POST",
      body,
    });
  }

  /** Post-PP1 hardening: browser-reload resume proxy. Forwards ONLY the
   *  bounded query params (connectionId, providerId) to the Orchestrator's
   *  active-flow read endpoint and returns its bounded non-secret
   *  projection unchanged (authFlowId, method identity, authorization URL,
   *  instructions, expiry — never a management password/token). */
  @Get("api/provider-discovery/auth-flows/active")
  async getActiveAuthFlow(
    @Query("connectionId") connectionId?: string,
    @Query("providerId") providerId?: string,
  ) {
    const params = new URLSearchParams();
    if (connectionId) params.set("connectionId", connectionId);
    if (providerId) params.set("providerId", providerId);
    const query = params.toString();
    return this.forwardToOrchestrator(
      `/provider-discovery/auth-flows/active${query ? `?${query}` : ""}`,
    );
  }

  @Post("api/provider-discovery/commands/test-target")
  async testRuntimeTarget(@Body() body: any) {
    return this.forwardToOrchestrator("/provider-discovery/commands/test-target", {
      method: "POST",
      body,
    });
  }

  @Post("api/provider-discovery/commands/oauth-begin")
  async openCodeOauthBegin(@Body() body: any) {
    return this.forwardToOrchestrator(
      "/provider-discovery/commands/oauth-begin",
      { method: "POST", body },
    );
  }

  @Post("api/provider-discovery/commands/oauth-complete")
  async openCodeOauthComplete(@Body() body: any) {
    return this.forwardToOrchestrator(
      "/provider-discovery/commands/oauth-complete",
      { method: "POST", body },
    );
  }

  @Post("api/provider-discovery/commands/oauth-cancel")
  async openCodeOauthCancel(@Body() body: any) {
    return this.forwardToOrchestrator(
      "/provider-discovery/commands/oauth-cancel",
      { method: "POST", body },
    );
  }

  @Get("api/workbench/workspaces")
  async getWorkbenchWorkspaces() {
    return this.forwardToOrchestrator("/workbench/workspaces");
  }

  @Post("api/workbench/commands/onboard-runtime")
  async onboardRuntime(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/onboard-runtime", {
      method: "POST",
      body,
    });
  }

  @Post("api/workbench/commands/create-workspace")
  async createWorkspace(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/create-workspace", {
      method: "POST",
      body,
    });
  }

  @Get("api/workbench/commands/team-templates")
  async teamTemplates() {
    return this.forwardToOrchestrator("/workbench/commands/team-templates");
  }

  @Get("api/workbench/executions")
  async getWorkbenchExecutions(@Query("page") page?: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions${page ? `?page=${encodeURIComponent(page)}` : ""}`,
    );
  }

  @Get("api/workbench/executions/:executionId")
  async getWorkbenchExecution(@Param("executionId") executionId: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions/${encodeURIComponent(executionId)}`,
    );
  }

  @Post("api/workbench/commands/start-team-run")
  async startTeamRun(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/start-team-run", {
      method: "POST",
      body,
    });
  }

  @Post("api/workbench/commands/waits/:runId")
  async resolveWait(@Param("runId") runId: string, @Body() body: any) {
    return this.forwardToOrchestrator(
      `/workbench/commands/waits/${encodeURIComponent(runId)}`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/executions/:executionId/cancel")
  async workbenchCancelExecution(
    @Param("executionId") executionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/workbench/commands/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/executions/:executionId/replay")
  async workbenchReplayExecution(
    @Param("executionId") executionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/workbench/commands/executions/${encodeURIComponent(executionId)}/replay`,
      { method: "POST", body },
    );
  }

  @Post("api/workbench/commands/compare")
  async workbenchCompare(@Body() body: any) {
    return this.forwardToOrchestrator("/workbench/commands/compare", {
      method: "POST",
      body,
    });
  }

  @Get("api/workbench/executions/:executionId/capsule")
  async getWorkbenchCapsule(@Param("executionId") executionId: string) {
    return this.forwardToOrchestrator(
      `/workbench/executions/${encodeURIComponent(executionId)}/capsule`,
    );
  }

  @Post("api/workbench/commands/workspaces/:workspaceExecutionId/release")
  async workbenchReleaseWorkspace(
    @Param("workspaceExecutionId") workspaceExecutionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/workbench/commands/workspaces/${encodeURIComponent(workspaceExecutionId)}/release`,
      { method: "POST", body },
    );
  }

  @Get("api/workbench/commands/audit")
  async workbenchAudit(@Query("action") action?: string) {
    return this.forwardToOrchestrator(
      `/workbench/commands/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`,
    );
  }

  @Post("api/connections/:connectionId/test")
  async testConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}/test`,
      { method: "POST", body },
    );
  }

  @Post("api/connections/:connectionId/revoke")
  async revokeConnection(
    @Param("connectionId") connectionId: string,
    @Body() body: any,
  ) {
    return this.forwardToOrchestrator(
      `/connections/${encodeURIComponent(connectionId)}/revoke`,
      { method: "POST", body },
    );
  }

  @Get("api/pipelines")
  async getPipelines() {
    return this.forwardToOrchestrator("/pipelines");
  }

  @Get("api/pipelines/:id")
  async getPipeline(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/pipelines/${id}`);
  }

  @Post("api/executions")
  async triggerExecution(@Body() body: any) {
    return this.forwardToOrchestrator("/executions", {
      method: "POST",
      body,
    });
  }

  @Get("api/executions")
  async getExecutions() {
    return this.forwardToOrchestrator("/executions");
  }

  @Get("api/executions/:id")
  async getExecution(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/executions/${id}`);
  }

  @Get("api/executions/:id/events")
  async getExecutionEvents(
    @Param("id") id: string,
    @Query("stepAttemptId") stepAttemptId?: string,
    @Query("type") type?: string,
    @Query("limit") limit?: string,
    @Query("afterReceivedAt") afterReceivedAt?: string,
    @Query("afterId") afterId?: string,
  ) {
    const params = new URLSearchParams();
    if (stepAttemptId) params.set("stepAttemptId", stepAttemptId);
    if (type) params.set("type", type);
    if (limit) params.set("limit", limit);
    if (afterReceivedAt) params.set("afterReceivedAt", afterReceivedAt);
    if (afterId) params.set("afterId", afterId);
    const query = params.toString();
    return this.forwardToOrchestrator(
      `/executions/${id}/events${query ? `?${query}` : ""}`,
    );
  }

  @Post("api/executions/:id/cancel")
  async cancelExecution(@Param("id") id: string) {
    return this.forwardToOrchestrator(`/executions/${id}/cancel`, {
      method: "POST",
    });
  }

  private async forwardToOrchestrator(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ) {
    try {
      const response = await fetch(`${this.orchestratorUrl}${path}`, {
        method: options.method || "GET",
        headers:
          options.body !== undefined
            ? { "Content-Type": "application/json" }
            : undefined,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

      const data = await response.json();
      if (!response.ok) {
        return {
          success: false,
          data: null,
          error:
            data.message ||
            data.error ||
            `Orchestrator returned HTTP ${response.status}`,
        };
      }
      return data;
    } catch (err) {
      return { success: false, data: null, error: this.getErrorMessage(err) };
    }
  }

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  @Get("workbench")
  getWorkbench(@Res() response: any) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.send(WORKBENCH_PAGE);
  }

  @Get()
  getRoot() {
    return {
      success: true,
      data: {
        message: "Welcome to Tenvyr Gateway API",
      },
      error: null,
      meta: {
        timestamp: new Date().toISOString(),
      },
    };
  }
}
