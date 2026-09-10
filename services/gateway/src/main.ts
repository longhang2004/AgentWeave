import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { selectBootstrapLogger, TenvyrDevLogger } from './dev-logger';
import { resolveHttpBoundary } from './local-origin';

async function bootstrap() {
  // Terminal-UX closure: the compact presenter is a DEVELOPMENT-only
  // presentation. Production and verbose use NATIVE Nest logging.
  const loggerMode = selectBootstrapLogger();
  const devLogger = loggerMode === 'dev-normal' ? new TenvyrDevLogger() : undefined;
  const app = await NestFactory.create(AppModule, {
    ...(devLogger ? { logger: devLogger } : {}),
  });
  if (devLogger) app.useLogger(devLogger);

  // P0 control-plane boundary: loopback-only by default, no wildcard CORS.
  const boundary = resolveHttpBoundary(
    { hostEnv: "GATEWAY_HOST", portEnv: "GATEWAY_PORT", defaultPort: 3000 },
    process.env,
  );
  if (boundary.corsOrigin) {
    app.enableCors({ origin: boundary.corsOrigin, credentials: true });
  }

  await app.listen(boundary.port, boundary.host);
  // Human-facing summary may say localhost; the bind is loopback IPv4.
  (devLogger ?? console).log(`Gateway listening on http://localhost:${boundary.port}`);
}
bootstrap();
