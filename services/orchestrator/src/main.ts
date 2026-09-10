import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { selectBootstrapLogger, TenvyrDevLogger } from './dev-logger';
import { resolveHttpBoundary } from './local-origin';

async function bootstrap() {
  const port = process.env.ORCHESTRATOR_PORT || 3001;
  // Terminal-UX closure: the compact presenter is a DEVELOPMENT-only
  // presentation. Production (NODE_ENV=production) and verbose
  // (TENVYR_LOG_LEVEL=verbose) use NATIVE Nest logging — lossless,
  // untruncated diagnostics; production semantics are never rewritten.
  const loggerMode = selectBootstrapLogger();
  const devLogger = loggerMode === 'dev-normal' ? new TenvyrDevLogger() : undefined;
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    ...(devLogger ? { logger: devLogger } : {}),
  });
  if (devLogger) app.useLogger(devLogger);

  // P0 control-plane boundary: loopback-only by default, no wildcard CORS.
  // Workbench proxies /api/* same-origin, so permissive CORS is not required.
  // Explicit override via ORCHESTRATOR_HOST if operator architecture needs it.
  const boundary = resolveHttpBoundary(
    { hostEnv: "ORCHESTRATOR_HOST", portEnv: "ORCHESTRATOR_PORT", defaultPort: 3001 },
    process.env,
  );
  if (boundary.corsOrigin) {
    app.enableCors({ origin: boundary.corsOrigin, credentials: true });
  }
  // No app.enableCors() wildcard by default.

  // P2 shutdown-lifecycle closure: Nest signal hooks so a graceful
  // SIGTERM/SIGINT runs onModuleDestroy (OpenCodeAuthFlowService.closeAll
  // terminates every live management session and clears every timer)
  // before the process exits.
  app.enableShutdownHooks();

  await app.listen(boundary.port, boundary.host);
  (devLogger ?? console).log(
    devLogger ? `Orchestrator listening on http://localhost:${port}` : `Nest application successfully started (orchestrator on :${port})`,
  );
}
bootstrap();
