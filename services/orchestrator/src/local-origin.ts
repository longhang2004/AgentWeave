/**
 * Post-PP1 hardening: ONE explicit local-origin policy shared by the HTTP
 * bootstrap and the Socket.IO gateway of this service.
 *
 * A byte-identical twin lives in the other service
 * (services/gateway/src/local-origin.ts or
 * services/orchestrator/src/local-origin.ts); the hardening specs assert
 * the twins never drift.
 *
 * Contract:
 * - services default-bind IPv4 loopback (127.0.0.1);
 * - CORS_ORIGIN is a bounded comma-separated allow-list of explicit origins;
 * - a literal "*" fails closed (throws) and is NEVER passed to Nest or
 *   Socket.IO;
 * - unset CORS_ORIGIN = HTTP: no CORS at all (the Workbench same-origin
 *   proxy needs none); WebSocket: loopback browser origins only.
 */

export const LOOPBACK_HOSTNAMES: readonly string[] = [
  "127.0.0.1",
  "localhost",
  "[::1]",
];

/** Bounded explicit allow-list; wildcard fails closed. */
export function parseCorsAllowList(raw: string): string[] {
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.includes("*")) {
    throw new Error(
      `CORS_ORIGIN "${raw}" rejected: wildcard "*" is not allowed; list explicit origins, comma-separated`,
    );
  }
  return origins;
}

/** HTTP bootstrap: `false` = do not enable CORS at all. */
export function httpCorsOrigins(raw: string | undefined): string[] | false {
  return raw ? parseCorsAllowList(raw) : false;
}

function isLoopbackWebOrigin(origin: string | undefined): boolean {
  // Non-browser clients (curl, server-to-server) send no Origin header.
  if (!origin) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return (
      (protocol === "http:" || protocol === "https:") &&
      LOOPBACK_HOSTNAMES.includes(hostname)
    );
  } catch {
    return false;
  }
}

export type SocketIoOriginOption =
  | string[]
  | ((origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => void);

/** Socket.IO cors.origin: an explicit bounded allow-list when CORS_ORIGIN
 *  is set; otherwise any loopback browser origin (default local operation).
 *  A wildcard input throws — "*" never reaches Socket.IO. */
export function socketIoCorsOrigin(raw: string | undefined): SocketIoOriginOption {
  if (raw) return parseCorsAllowList(raw);
  return (origin, callback) => callback(null, isLoopbackWebOrigin(origin));
}

/** HTTP bootstrap boundary: loopback bind by default, explicit host/port
 *  override, and the shared no-wildcard CORS decision. */
export function resolveHttpBoundary(
  opts: { hostEnv: string; portEnv: string; defaultPort: number },
  env: Record<string, string | undefined>,
): { host: string; port: number; corsOrigin: string[] | false } {
  return {
    host: env[opts.hostEnv] || "127.0.0.1",
    port: Number(env[opts.portEnv]) || opts.defaultPort,
    corsOrigin: httpCorsOrigins(env.CORS_ORIGIN),
  };
}
