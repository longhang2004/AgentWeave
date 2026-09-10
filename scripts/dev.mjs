#!/usr/bin/env node
/**
 * Tenvyr development launcher (`pnpm dev`).
 *
 * A bounded supervisor for the local development stack: starts the Compose
 * infrastructure (PostgreSQL, Redis, Kafka), then the orchestrator,
 * gateway and workbench watch services, polls REAL readiness endpoints
 * (a live process is NOT readiness), prints a compact startup summary,
 * formats every service line as `time service LEVEL message`, and
 * coordinates graceful shutdown.
 *
 * Shutdown semantics:
 * - SIGINT/SIGTERM are registered BEFORE any infrastructure or child work
 *   begins; at ANY phase they enter ONE idempotent shutdown path that
 *   stops every already-created child (process-group SIGTERM so Nest
 *   shutdown hooks run — including the P2 OpenCodeAuthFlow closeAll),
 *   tears down launcher-owned Compose infrastructure, and returns the
 *   correct exit code. No orphaned detached process groups.
 * - An unexpected exit of a REQUIRED child at any phase marks the stack
 *   FAILED and triggers the same automatic shutdown; launcher-initiated
 *   shutdown exits are expected and never treated as failures.
 * - Child exit promises are attached at SPAWN time, so an already-exited
 *   child never makes shutdown wait out the grace deadline.
 *
 * State model: starting -> ready | failed -> shutting_down -> stopped.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ANSI = { dim: "\u001b[2m", reset: "\u001b[0m", red: "\u001b[31m", yellow: "\u001b[33m", green: "\u001b[32m" };

const INFRA_SERVICES = ["postgres", "redis", "zookeeper", "kafka", "kafka-ui"];
const SHUTDOWN_GRACE_MS = 15_000;

const DEFAULT_SERVICES = [
  { name: "orchestrator", dir: "services/orchestrator", script: "start:dev", portEnv: "ORCHESTRATOR_PORT", defaultPort: 3001, health: "/health" },
  { name: "gateway", dir: "services/gateway", script: "start:dev", portEnv: "GATEWAY_PORT", defaultPort: 3000, health: "/health" },
  { name: "host", dir: "services/local-executor-host", script: "start:dev", portEnv: "EXECUTOR_HOST_PORT", defaultPort: 3002, health: "/health/live" },
  { name: "workbench", dir: "frontend", script: "dev", portEnv: "PORT", defaultPort: 4000, health: "/" },
];

function hostServiceSpec(env = process.env) {
  if ((env.TENVYR_EXECUTOR_HOST ?? "").trim() === "rust") {
    return {
      name: "host",
      dir: "services/local-executor-host-rs",
      command: "cargo",
      args: ["run", "--quiet"],
      portEnv: "EXECUTOR_HOST_PORT",
      defaultPort: 3002,
      health: "/health/live",
    };
  }
  return DEFAULT_SERVICES.find((s) => s.name === "host");
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                               */
/* ------------------------------------------------------------------ */

export function useColor(env = process.env, stdout = process.stdout) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return true;
  if (env.CI !== undefined) return false;
  return Boolean(stdout.isTTY);
}

export function statusMark(state, color) {
  if (!color)
    return state === "ready" || state === "stopped"
      ? "✓"
      : state === "disabled"
        ? "○"
        : state === "failed"
          ? "✕"
          : state === "warn"
            ? "!"
            : "?";
  return state === "ready"
    ? `${ANSI.green}✓${ANSI.reset}`
    : state === "stopped"
      ? `${ANSI.green}✓${ANSI.reset}`
      : state === "disabled"
        ? `${ANSI.dim}○${ANSI.reset}`
        : state === "failed"
          ? `${ANSI.red}✕${ANSI.reset}`
          : state === "warn"
            ? `${ANSI.yellow}!${ANSI.reset}`
            : "?";
}

export function bannerText(color) {
  const logo = "  ◈ TENVYR";
  const tagline = "  Agent Execution Control Plane";
  if (!color) return [logo, tagline];
  return [`  ${ANSI.green}◈${ANSI.reset} TENVYR`, tagline];
}

/** Compact single-line formatter: `15:24:02  service  INFO   message`. */
export function formatServiceLine({ time, service, level, message, color }) {
  const t = time ?? new Date().toTimeString().slice(0, 8);
  const text = String(message ?? "");
  const firstBreak = text.indexOf("\n");
  const single = firstBreak === -1 ? text : text.slice(0, firstBreak) + " …";
  const withContext = single;
  const levelColor = { ERROR: ANSI.red, WARN: ANSI.yellow, INFO: "", DEBUG: ANSI.dim }[level] ?? "";
  const levelCol = String(level ?? "INFO").padEnd(5);
  const serviceCol = String(service ?? "").padEnd(11);
  if (!color) return `${t}  ${serviceCol}  ${levelCol}  ${withContext}`;
  return `${ANSI.dim}${t}${ANSI.reset}  ${serviceCol}  ${levelColor}${levelCol}${ANSI.reset}  ${withContext}`;
}

const DEV_LINE_PATTERN = /^\d{2}:\d{2}:\d{2}\s{2}\S+\s{2}(INFO|WARN|ERROR|DEBUG|TRACE)\s{2}/;
export { DEV_LINE_PATTERN };

/** True when a child line is already in the app's dev format (passthrough). */
export function isDevLine(line) {
  return DEV_LINE_PATTERN.test(line.replace(/\u001b\[[0-9;]*m/g, ""));
}

/** Wrap a foreign (framework/watcher) line with the service tag. */
export function wrapForeignLine(line, service, color) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const cleanError = /(^|\s)(0|no) errors?([.\s]|$)/.test(lower);
  const level = !cleanError && /error|fail|exception/.test(lower)
    ? "ERROR"
    : /warn/.test(lower)
      ? "WARN"
      : "INFO";
  return formatServiceLine({ service, level, message: trimmed, color });
}

export function summaryBlock({ mode, services, kafkaState, color }) {
  const lines = [];
  lines.push("");
  lines.push("  Runtime");
  lines.push(`  ├─ Mode       ${mode}`);
  for (const service of services) {
    const url = service.url ? ` ${ANSI.dim}· ${service.url}${ANSI.reset}` : "";
    lines.push(`  ├─ ${service.label.padEnd(11)} ${service.state}${color ? url : url.replace(/\u001b\[[0-9;]*m/g, "")}`);
  }
  lines.push(`  ├─ Database   PostgreSQL · ${kafkaState.database}`);
  lines.push(`  └─ Kafka      ${kafkaState.broker}`);
  lines.push("");
  if (color) {
    lines.push(`  ${ANSI.green}Tenvyr is ready.${ANSI.reset}`);
  } else {
    lines.push("  Tenvyr is ready.");
  }
  lines.push("");
  lines.push("  Workbench → http://localhost:4000");
  lines.push("");
  lines.push("  Ctrl+C to stop · `pnpm dev:verbose` for framework logs");
  return lines;
}

function servicePort(services, name) {
  const service = services.find((s) => s.name === name);
  return service ? service.port : "4000";
}

/* ------------------------------------------------------------------ */
/* Environment                                                        */
/* ------------------------------------------------------------------ */

/**
 * Load .env KEY=VALUE lines with the NATIVE Node env-file grammar
 * (util.parseEnv — the same parser as `node --env-file`): inline
 * comments, quotes, escapes and blank values are handled correctly.
 * Values are NEVER printed. Existing environment takes precedence.
 * .env is optional.
 */
export function loadDotEnv(root, env = process.env) {
  try {
    const content = readFileSync(join(root, ".env"), "utf8");
    const parsed = parseEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    // no .env — defaults apply
  }
  return env;
}

/* ------------------------------------------------------------------ */
/* Supervisor                                                         */
/* ------------------------------------------------------------------ */

function envWith(env, extra) {
  return { ...env, ...extra };
}

async function waitFor(predicate, timeoutMs, label, log, shouldAbort) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort()) return false;
    const p = await predicate();
    if (p) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!shouldAbort()) {
    log("ERROR", `${label} did not become ready within ${Math.round(timeoutMs / 1000)}s`);
  }
  return false;
}

async function fetchReady(url, timeoutMs, jsonHealth = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    if (!jsonHealth) return true; // any 2xx (e.g. the workbench page)
    const body = await res.json().catch(() => null);
    const status = body?.data?.status ?? body?.status ?? "";
    const statusText = String(status).toUpperCase();
    return statusText.includes("UP") || statusText.includes("OK") || statusText.includes("READY");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one child with piped stdio; forward formatted lines. The exit
 * promise is attached AT SPAWN so an already-exited child never stalls
 * shutdown waiting for a listener that would never fire.
 */
function startChild(child, io) {
  const { command, args, env, name } = child;
  const process_ = spawn(command, args, {
    env,
    cwd: child.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // Detached so shutdown can signal the WHOLE tree (pnpm -> nest -> app):
    // the app process receives SIGTERM and its Nest shutdown hooks run
    // (P2 closeAll semantics preserved).
    detached: true,
  });
  process_.name = name;
  process_.label = child.label;
  process_.exitPromise = new Promise((resolve) => {
    process_.once("exit", (code, signal) => resolve({ code, signal }));
  });
  process_.on("exit", (code, signal) => {
    // NOTE: `child` here is the manifest object; the lifecycle callback is
    // assigned onto the returned ChildProcess (process_.onExit) by the
    // caller — read it from process_ so the assignment is visible.
    process_.onExit?.(code, signal);
  });
  const emit = (chunk, isStderr) => {
    let text = String(chunk)
      // Watcher CLIs (nest start --watch) emit full-screen clears that
      // would wipe the launcher's own summary in a real terminal —
      // neutralize them (well-defined ANSI, not a text-content filter).
      .replace(/\u001b\[[0-9;]*[HJ]/g, "")
      .replace(/\u001b\[\?[0-9]*[hl]/g, "");
    if (!io.color) {
      // Non-interactive / NO_COLOR / CI: strip framework ANSI (e.g. the
      // nest CLI's own gray timestamps) so redirects stay deterministic
      // and searchable.
      text = text.replace(/\u001b\[[0-9;]*m/g, "");
    }
    for (const rawLine of text.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line) continue;
      if (isDevLine(line)) {
        io.write(line + "\n"); // already formatted by the app logger
      } else {
        const wrapped = wrapForeignLine(line, name, io.color);
        if (wrapped) io.write(wrapped + "\n");
      }
    }
  };
  process_.stdout?.on("data", (chunk) => emit(chunk, false));
  process_.stderr?.on("data", (chunk) => emit(chunk, true));
  return process_;
}

/** Build the child manifest from repo truth. */
export function buildManifest(env = process.env) {
  const portOf = (service) => Number(env[service.portEnv] ?? service.defaultPort);
  const orchestratorService = DEFAULT_SERVICES.find((s) => s.name === "orchestrator");
  const hostService = DEFAULT_SERVICES.find((s) => s.name === "host");

  const orchestratorPort = orchestratorService ? portOf(orchestratorService) : 3001;
  const hostPort = hostService ? portOf(hostService) : 3002;

  const bearerToken =
    env.HTTP_AGENT_BEARER_TOKEN ??
    env.EXECUTOR_HOST_BEARER_TOKEN ??
    randomBytes(32).toString("hex");
  const callbackSecret =
    env.HTTP_AGENT_CALLBACK_SECRET ??
    env.LOOPBACK_CALLBACK_SECRET ??
    randomBytes(32).toString("hex");

  const callbackBaseUrl =
    env.HTTP_AGENT_CALLBACK_BASE_URL ?? `http://127.0.0.1:${orchestratorPort}`;
  const allowInsecure =
    env.HTTP_AGENT_ALLOW_INSECURE ?? "true";
  const localExecutorHostUrl =
    env.LOCAL_EXECUTOR_HOST_URL ??
    env.EXECUTOR_HOST_URL ??
    `http://127.0.0.1:${hostPort}/v1/runs`;
  const callbackAllowedOrigins =
    env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS ??
    `http://127.0.0.1:${orchestratorPort},http://localhost:${orchestratorPort}`;

  const sharedDevEnv = {
    ...env,
    TENVYR_LOG_LEVEL: env.TENVYR_LOG_LEVEL ?? "normal",
    HTTP_AGENT_BEARER_TOKEN: bearerToken,
    EXECUTOR_HOST_BEARER_TOKEN: bearerToken,
    HTTP_AGENT_CALLBACK_SECRET: callbackSecret,
    LOOPBACK_CALLBACK_SECRET: callbackSecret,
    EXECUTOR_HOST_CALLBACK_KEYS:
      env.EXECUTOR_HOST_CALLBACK_KEYS ??
      JSON.stringify({
        "host-callback-v1": callbackSecret,
        "host-loopback-v1": callbackSecret,
      }),
    EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE:
      env.EXECUTOR_HOST_CALLBACK_ALLOW_INSECURE ?? "true",
    HTTP_AGENT_CALLBACK_BASE_URL: callbackBaseUrl,
    HTTP_AGENT_ALLOW_INSECURE: allowInsecure,
    LOCAL_EXECUTOR_HOST_URL: localExecutorHostUrl,
    EXECUTOR_HOST_URL: localExecutorHostUrl,
    EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS: callbackAllowedOrigins,
  };

  const services = DEFAULT_SERVICES.map((service) => {
    const spec = service.name === "host" ? hostServiceSpec(env) ?? service : service;
    const port = portOf(spec);
    return {
      ...spec,
      port,
      label: spec.name[0].toUpperCase() + spec.name.slice(1),
      // Internal addressing is explicit IPv4 loopback — never dependent on
      // localhost resolving to the same address family. Human-facing
      // summaries may still display localhost.
      url: `http://127.0.0.1:${port}`,
      command: spec.command ?? "pnpm",
      args: spec.args ?? ["run", spec.script],
      cwd: join(ROOT, spec.dir),
      env: sharedDevEnv,
    };
  });
  return { services, infraServices: INFRA_SERVICES, root: ROOT };
}

function composeContainerNames(root) {
  try {
    const config = spawnSync("docker", ["compose", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (config.status !== 0) return {};
    const parsed = JSON.parse(config.stdout);
    const names = {};
    for (const [service, spec] of Object.entries(parsed.services ?? {})) {
      names[service] = spec.container_name ?? service;
    }
    return names;
  } catch {
    return {};
  }
}

function containerRunning(name) {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

/** Start an existing but stopped container (bounded, best-effort). */
function startContainer(name) {
  spawnSync("docker", ["start", name], { stdio: "ignore", timeout: 60_000 });
}

/** Real launcher entry. Exported for the deterministic tests. */
export async function runLauncher(
  manifest,
  io = {
    write: (text) => process.stdout.write(text),
    color: useColor(),
    mode: process.env.TENVYR_LOG_LEVEL ?? "normal",
    isInteractive: process.stdout.isTTY && !process.env.CI,
  },
) {
  const color = io.color;
  const mode = io.mode;
  const log = (level, message) => {
    io.write(formatServiceLine({ service: "dev", level, message, color }) + "\n");
  };

  // State machine: starting -> ready | failed -> shutting_down -> stopped.
  let state = "starting";
  let failed = false;
  let terminationSignal = null;
  let shutdownStarted = false;
  const children = [];
  const states = new Map();
  const serviceByName = new Map(manifest.services.map((s) => [s.name, s]));
  const abort = () => shutdownStarted;

  // Shutdown is registered BEFORE any infrastructure or child work: at ANY
  // phase a signal enters the ONE idempotent shutdown path (defect 1).
  let shutdownResolve;
  const shutdownPromise = new Promise((resolve) => {
    shutdownResolve = resolve;
  });
  const finish = async () => {
    io.write("\n  Stopping Tenvyr...\n\n");
    for (const child of children) {
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          // Signal the whole tree so the Nest app receives SIGTERM and its
          // shutdown hooks (P2 closeAll) run before the watchers exit.
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    for (const child of children) {
      const remaining = Math.max(1, deadline - Date.now());
      // exitPromise was attached at spawn — an already-exited child
      // resolves immediately and never waits out the deadline (defect 3).
      const exited = await Promise.race([
        child.exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), remaining)),
      ]);
      if (!exited) {
        io.write(
          `  ${statusMark("warn", color)} ${child.label ?? child.name} did not exit within 15s — terminating\n`,
        );
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        await Promise.race([
          child.exitPromise.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 3_000)),
        ]);
      } else {
        io.write(`  ${statusMark("stopped", color)} ${child.label ?? child.name} stopped\n`);
      }
    }
    // Infra teardown (parity with the legacy dev.sh).
    if ((manifest.infraServices ?? []).length > 0) {
      spawnSync("docker", ["compose", "down"], { cwd: manifest.root, stdio: "ignore", timeout: 60_000 });
    }
    io.write(
      failed
        ? color
          ? `\n  ${ANSI.red}Tenvyr stopped with failures.${ANSI.reset}\n`
          : "\n  Tenvyr stopped with failures.\n"
        : color
          ? `\n  ${ANSI.green}Tenvyr stopped cleanly.${ANSI.reset}\n`
          : "\n  Tenvyr stopped cleanly.\n",
    );
    state = "stopped";
  };
  const exitCodeFor = () => (failed ? 1 : terminationSignal === "SIGTERM" ? 143 : 0);
  const requestShutdown = async (reason, signal) => {
    if (shutdownStarted) return; // idempotent — ONE shutdown path
    shutdownStarted = true;
    if (signal) terminationSignal = signal;
    if (reason === "failure") failed = true;
    state = "shutting_down";
    try {
      await finish();
    } finally {
      shutdownResolve();
    }
  };
  const onSignal = (signal) => {
    void requestShutdown("user", signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const printFailureSummary = () => {
    io.write("\n");
    for (const service of manifest.services) {
      const state_ = states.get(service.name);
      io.write(
        `  ${statusMark(state_, color)} ${service.label.padEnd(12)} ${state_ === "ready" ? "ready" : state_ === "starting" ? "starting" : "failed"}\n`,
      );
    }
    io.write(
      color
        ? `\n  ${ANSI.red}Tenvyr did not start successfully.${ANSI.reset}\n\n  Run: pnpm dev:verbose\n`
        : "\n  Tenvyr did not start successfully.\n\n  Run: pnpm dev:verbose\n",
    );
  };
  const abortReturn = () => {
    if (failed) printFailureSummary();
    return { exitCode: exitCodeFor(), ready: false };
  };

  try {
    if (io.isInteractive) {
      for (const line of bannerText(color)) io.write(line + "\n");
      io.write("\n  Starting development environment...\n\n");
    }

    /* --- infrastructure --- */
    const infraServices = manifest.infraServices ?? [];
    if (infraServices.length > 0) {
      log("INFO", "Starting infrastructure (docker compose)...");
      const compose = spawnSync(
        "docker",
        ["compose", "up", "-d", ...infraServices],
        { cwd: manifest.root, stdio: "ignore", timeout: 120_000 },
      );
      if (compose.status !== 0) {
        // Idempotent dev UX: `pnpm dev` with infra already running (e.g. a
        // container renamed by the backup tooling, or a previous session)
        // must not fail. The postgres container NAME can be held by a
        // renamed sibling (backup tooling), which fails the whole compose
        // up atomically — bring up the REST of the infra without postgres
        // (postgres is probed separately below).
        const rest = infraServices.filter((service) => service !== "postgres");
        if (rest.length > 0) {
          spawnSync("docker", ["compose", "up", "-d", ...rest], {
            cwd: manifest.root,
            stdio: "ignore",
            timeout: 120_000,
          });
        }
        // Probe the declared container names; only fail when required
        // containers are genuinely missing.
        const names = composeContainerNames(manifest.root);
        const unavailable = infraServices.filter((service) => {
          const name = names[service] ?? service;
          if (containerRunning(name)) return false;
          // The container exists but is stopped (e.g. compose up conflicts
          // with a renamed sibling, or a previous `compose down`) — start it.
          startContainer(name);
          return !containerRunning(name);
        });
        if (unavailable.length === 0) {
          log("INFO", "Infrastructure already present — reusing it");
        } else {
          log("ERROR", `docker compose up failed; unavailable: ${unavailable.join(", ")}`);
          await requestShutdown("failure");
          return { exitCode: exitCodeFor(), ready: false };
        }
      }
      if (abort()) return abortReturn();
    }

    /* --- PostgreSQL readiness (real probe, not process liveness) --- */
    let databaseReady = false;
    if (infraServices.includes("postgres")) {
      const containerName = composeContainerNames(manifest.root).postgres ?? "postgres";
      const probe = () => {
        const result = spawnSync(
          "docker",
          ["compose", "exec", "-T", "postgres", "pg_isready"],
          { cwd: manifest.root, stdio: "ignore", timeout: 10_000 },
        );
        if (result.status === 0) return true;
        // compose exec can fail when the container is not part of this
        // project (renamed by tooling) — probe the container directly.
        // (docker exec has no -T flag; that is compose exec syntax.)
        const direct = spawnSync(
          "docker",
          ["exec", containerName, "pg_isready"],
          { stdio: "ignore", timeout: 10_000 },
        );
        return direct.status === 0;
      };
      databaseReady = await waitFor(probe, 90_000, "PostgreSQL", log, abort);
      if (abort()) return abortReturn();
      if (!databaseReady) {
        log("ERROR", "PostgreSQL did not become ready");
        failed = true;
      } else {
        log("INFO", "PostgreSQL ready");
      }
    }

    /* --- start children --- */
    for (const service of manifest.services) {
      if (abort()) return abortReturn();
      const child = startChild(
        {
          ...service,
          env: envWith(service.env, {
            ...(service.portEnv ? { [service.portEnv]: String(service.port) } : {}),
          }),
        },
        io,
      );
      // An unexpected exit of a REQUIRED child at ANY phase fails the stack
      // and triggers automatic shutdown (defect 2). Exits during
      // launcher-initiated shutdown are expected and ignored.
      child.onExit = (code, signal) => {
        const expected = state === "shutting_down" || state === "stopped";
        log(
          expected ? "INFO" : "ERROR",
          `${child.label ?? child.name} exited (${signal ? `signal ${signal}` : `code ${code}`})`,
        );
        if (!expected) {
          failed = true;
          states.set(child.name, "failed");
          void requestShutdown("failure");
        }
      };
      children.push(child);
      states.set(service.name, "starting");
    }

    /* --- readiness gates: a live process is NOT readiness --- */
    const readinessTimeoutMs = io.readinessTimeoutMs ?? 180_000;
    for (const service of manifest.services) {
      if (abort()) return abortReturn();
      const url = `${service.url}${service.health}`;
      const jsonHealth = service.health !== "/";
      const ready = await waitFor(
        () => fetchReady(url, 3_000, jsonHealth),
        readinessTimeoutMs,
        service.label,
        log,
        abort,
      );
      if (abort()) return abortReturn();
      states.set(service.name, ready ? "ready" : "failed");
      if (ready) {
        log("INFO", `${service.label} ready · ${service.url}`);
      } else {
        failed = true;
      }
    }

    /* --- Kafka: proven fact from the compose state --- */
    let kafkaBroker = "disabled";
    if (infraServices.includes("kafka") && !abort()) {
      try {
        const kafkaUp = spawnSync("docker", ["compose", "ps", "-q", "kafka"], {
          cwd: manifest.root,
          encoding: "utf8",
          timeout: 15_000,
        });
        const containerId = (kafkaUp.stdout ?? "").trim();
        const running =
          containerId.length > 0
            ? spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", containerId], {
                encoding: "utf8",
                timeout: 15_000,
              })
            : { status: 1, stdout: "" };
        kafkaBroker =
          kafkaUp.status === 0 &&
          containerId.length > 0 &&
          running.status === 0 &&
          (running.stdout ?? "").trim() === "true"
            ? "started"
            : "disabled";
      } catch {
        kafkaBroker = "disabled";
      }
    }

    /* --- summary --- */
    if (!failed) {
      for (const line of summaryBlock({
        mode,
        services: manifest.services.map((s) => ({
          label: s.label,
          state: states.get(s.name),
          url: states.get(s.name) === "ready" ? s.url : undefined,
        })),
        kafkaState: { database: databaseReady ? "ready" : "failed", broker: kafkaBroker },
        color,
      })) {
        io.write(line + "\n");
      }
    } else {
      printFailureSummary();
    }

    /* --- run / wait for shutdown --- */
    if (!failed) {
      state = "ready";
      await shutdownPromise;
    } else {
      // Give the failure summary a beat to be read, then tear down
      // (requestShutdown is idempotent — a child-triggered shutdown may
      // already be in flight).
      await new Promise((resolve) => setTimeout(resolve, 400));
      await requestShutdown("failure");
      await shutdownPromise;
    }

    return { exitCode: exitCodeFor(), ready: state === "ready" && !failed };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadDotEnv(ROOT);
  // Parity with the legacy dev.sh: TENVYR_POSTGRES_PORT drives POSTGRES_PORT.
  if (process.env.POSTGRES_PORT === undefined) {
    process.env.POSTGRES_PORT = process.env.TENVYR_POSTGRES_PORT ?? "5432";
  }
  const manifest = buildManifest();
  runLauncher(manifest).then(({ exitCode }) => {
    process.exitCode = exitCode;
  });
}
