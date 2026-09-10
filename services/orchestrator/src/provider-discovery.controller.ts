import { Body, Controller, Get, HttpException, HttpStatus, Post, Query } from "@nestjs/common";
import { ProviderDiscoveryService } from "./services/provider-discovery.service";
import { WorkbenchCommandService } from "./services/workbench-command.service";
import { RuntimeConnectionError } from "./services/runtime-connection.service";

/**
 * P2 closure (round 2): CONNECTION-SCOPED provider/model discovery.
 *
 * Everything here resolves the Runtime Connection by id, rejects
 * missing/revoked connections, and uses the CURRENT revision's fixed
 * secret-free profile — the frontend never supplies executables, cwd,
 * env, or runtimeKind.
 *
 * - discover / refresh-models / auth-methods: read-only runtime probes.
 * - test-target / oauth-authorize / oauth-callback: audited Workbench
 *   commands (operator actions with external side effects).
 */
@Controller("provider-discovery")
export class ProviderDiscoveryController {
  constructor(
    private readonly discovery: ProviderDiscoveryService,
    private readonly commands: WorkbenchCommandService,
  ) {}

  private withMapping<T>(fn: () => Promise<T>) {
    return fn().catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      const code = String((error as { code?: string }).code ?? "");
      const message = String((error as Error).message ?? "provider discovery failed");
      if (code === "CONNECTION_NOT_FOUND" || code === "CONNECTION_REVOKED") {
        throw new HttpException({ success: false, error: { code, message } }, HttpStatus.BAD_REQUEST);
      }
      if (
        code === "RUNTIME_NOT_SUPPORTED" ||
        code === "MODEL_NOT_SUPPORTED" ||
        code === "INVALID_MODEL_ID" ||
        code === "INVALID_OAUTH_URL" ||
        code === "INVALID_METHOD_INDEX" ||
        code === "AUTH_METHOD_INVALID" ||
        code === "AUTH_METHOD_UNSUPPORTED" ||
        code === "AUTH_METHOD_NOT_OAUTH" ||
        code === "PROVIDER_NOT_AUTHENTICATED" ||
        code === "AUTH_FLOW_NOT_FOUND" ||
        code === "AUTH_FLOW_EXPIRED" ||
        code === "AUTH_FLOW_LIMIT" ||
        code === "AUTH_FLOW_CONFLICT" ||
        code === "AUTH_FLOW_STALE" ||
        code === "OPENCODE_SERVER_FAILED"
      ) {
        throw new HttpException({ success: false, error: { code, message } }, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (error instanceof RuntimeConnectionError) {
        throw new HttpException(
          { success: false, error: { code: error.code, message: error.message } },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new HttpException(
        { success: false, error: { code: "PROVIDER_DISCOVERY_FAILED", message } },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    });
  }

  @Post("discover")
  async discover(@Body() body: { connectionId: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.discoverRuntimeProviders(body.connectionId);
      return { success: true, data };
    });
  }

  @Post("refresh-models")
  async refreshModels(@Body() body: { connectionId: string; providerId?: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.refreshRuntimeModels(
        body.connectionId,
        body.providerId,
      );
      return { success: true, data };
    });
  }

  @Post("auth-methods")
  async authMethods(@Body() body: { connectionId: string; providerId: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.getRuntimeProviderAuthMethods(
        body.connectionId,
        body.providerId,
      );
      return { success: true, data };
    });
  }

  /** Post-PP1 hardening: bounded browser-reload resume read. Returns the
   *  active unexpired auth flow(s) for a connection (optionally one
   *  provider) — authFlowId, method identity, authorization URL,
   *  instructions, expiry. NEVER the management-server password/token. */
  @Get("auth-flows/active")
  async activeAuthFlow(
    @Query("connectionId") connectionId?: string,
    @Query("providerId") providerId?: string,
  ) {
    return this.withMapping(async () => {
      const data = await this.discovery.getActiveAuthFlows(
        (connectionId ?? "").slice(0, 255),
        providerId ? providerId.slice(0, 255) : undefined,
      );
      return { success: true, data };
    });
  }

  @Post("commands/test-target")
  async testTarget(
    @Body() body: { idempotencyKey: string; connectionId: string; modelId: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.testRuntimeTarget({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        modelId: body.modelId,
      });
      return { success: true, data };
    });
  }

  @Post("commands/oauth-begin")
  async oauthBegin(
    @Body()
    body: {
      idempotencyKey: string;
      connectionId: string;
      providerId: string;
      methodIndex: number;
      expectedMethodType?: "oauth" | "api";
      expectedMethodLabel?: string;
    },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.openCodeOauthBegin({
        idempotencyKey: body.idempotencyKey,
        connectionId: body.connectionId,
        providerId: body.providerId,
        methodIndex: body.methodIndex,
        ...(body.expectedMethodType !== undefined
          ? { expectedMethodType: body.expectedMethodType }
          : {}),
        ...(body.expectedMethodLabel !== undefined
          ? { expectedMethodLabel: body.expectedMethodLabel }
          : {}),
      });
      return { success: true, data };
    });
  }

  @Post("commands/oauth-complete")
  async oauthComplete(
    @Body() body: { idempotencyKey: string; authFlowId: string; code?: string },
  ) {
    return this.withMapping(async () => {
      const data = await this.commands.openCodeOauthComplete({
        idempotencyKey: body.idempotencyKey,
        authFlowId: body.authFlowId,
        ...(body.code !== undefined ? { code: body.code } : {}),
      });
      return { success: true, data };
    });
  }

  @Post("commands/oauth-cancel")
  async oauthCancel(@Body() body: { authFlowId: string }) {
    return this.withMapping(async () => {
      const data = await this.discovery.cancelAuthFlow(body.authFlowId);
      return { success: true, data };
    });
  }

}
