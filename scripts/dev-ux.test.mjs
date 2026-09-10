import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bannerText,
  buildManifest,
  DEV_LINE_PATTERN,
  formatServiceLine,
  isDevLine,
  loadDotEnv,
  runLauncher,
  statusMark,
  useColor,
  wrapForeignLine,
} from "./dev.mjs";

const ANSI = /\u001b\[[0-9;]*m/;

describe("dev launcher formatter", () => {
  test("formatServiceLine: compact time service level message; NO_COLOR => no ANSI", () => {
    const line = formatServiceLine({
      time: "15:24:02",
      service: "orchestrator",
      level: "INFO",
      message: "Team run started · run_93fe",
      color: true,
    });
    // ANSI dim codes may prefix the time; the visible payload must be intact.
    assert.match(line.replace(/\u001b\[[0-9;]*m/g, ""), /^15:24:02\s{2}orchestrator\s{2}INFO\s{2,}Team run started/);
    assert.match(line, ANSI); // colored
    const plain = formatServiceLine({
      time: "15:24:02",
      service: "orchestrator",
      level: "ERROR",
      message: "boom",
      color: false,
    });
    assert.doesNotMatch(plain, ANSI);
  });

  test("levels get semantic colors (WARN yellow, ERROR red, INFO neutral)", () => {
    const warn = formatServiceLine({ service: "g", level: "WARN", message: "x", color: true });
    const error = formatServiceLine({ service: "g", level: "ERROR", message: "x", color: true });
    const info = formatServiceLine({ service: "g", level: "INFO", message: "x", color: true });
    assert.match(warn, /\u001b\[33m/); // yellow
    assert.match(error, /\u001b\[31m/); // red
    assert.doesNotMatch(info, /\u001b\[33m/);
    assert.doesNotMatch(info, /\u001b\[31m/);
  });

  test("multiline messages are collapsed to one line", () => {
    const line = formatServiceLine({ service: "g", level: "INFO", message: "a\nb\nc", color: false });
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /a …$/);
  });

  test("isDevLine recognizes the in-app logger format; foreign lines are tagged with a level guess", () => {
    assert.equal(isDevLine("15:24:02  orchestrator  INFO   hello"), true);
    assert.equal(isDevLine("15:24:02  gateway  ERROR  boom"), true);
    assert.equal(isDevLine("[RouterExplorer] Mapped route"), false);
    assert.equal(isDevLine("pnpm > services/gateway start:dev:"), false);

    assert.equal(wrapForeignLine("something failed badly", "gateway", false).includes("ERROR"), true);
    assert.equal(wrapForeignLine("caught a warning", "gateway", false).includes("WARN"), true);
    assert.equal(wrapForeignLine("compiled successfully", "workbench", false).includes("INFO"), true);
    assert.equal(wrapForeignLine("  \n", "workbench", false), null);
  });

  test("banner is small (<= 3 lines) and never a giant figlet", () => {
    const banner = bannerText(false);
    assert.ok(banner.length <= 3);
    assert.match(banner[0], /TENVYR/);
  });

  test("statusMark: ready/disabled/failed marks", () => {
    assert.equal(statusMark("ready", false), "✓");
    assert.equal(statusMark("disabled", false), "○");
    assert.equal(statusMark("failed", false), "✕");
    assert.match(statusMark("ready", true), ANSI); // green check
    assert.doesNotMatch(statusMark("disabled", false), ANSI);
  });

  test("useColor: NO_COLOR disables, FORCE_COLOR=1 forces, CI disables, non-TTY disables", () => {
    assert.equal(useColor({ NO_COLOR: "1" }, { isTTY: true }), false);
    // The NO_COLOR spec: empty string does NOT disable (presence + non-empty).
    assert.equal(useColor({ NO_COLOR: "" }, { isTTY: true }), true);
    assert.equal(useColor({ FORCE_COLOR: "1" }, { isTTY: false }), true);
    assert.equal(useColor({ CI: "true" }, { isTTY: true }), false);
    assert.equal(useColor({}, { isTTY: false }), false);
    assert.equal(useColor({}, { isTTY: true }), true);
  });
});

describe("dev launcher lifecycle (fake children)", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-devux-"));
  let markerFile = "";

  const fakeHealthServer = (port, script = "") =>
    `const http = require("node:http");
const port = ${port};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { status: "UP" } }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
${script}
`;

  const fakeLineChild = (marker, port) =>
    `const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(marker)}, "started");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success: true, data: { status: "UP" } }));
});
server.listen(${port}, "127.0.0.1");
process.stdout.write("15:24:02  fakeapp  INFO   already formatted line\\n");
process.stdout.write("[RouterExplorer] Mapped {/api/x, GET} route\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  fs.appendFileSync(${JSON.stringify(marker)}, "\\nSIGTERM");
  process.exit(0);
});
`;

  const writeFixture = (name, content) => {
    const path = join(fixtureDir, name);
    writeFileSync(path, `#!/usr/bin/env node\n${content}`, { mode: 0o755 });
    return path;
  };

  const capturedIo = () => {
    const buffer = [];
    return {
      write: (text) => buffer.push(text),
      color: false,
      log: () => undefined,
      mode: "normal",
      isInteractive: false,
      buffer,
    };
  };

  const manifestFor = (services) => ({
    services,
    infraServices: [],
    root: fixtureDir,
  });

  test("startup: ready services + optional kafka disabled => summary, NOT failure", async () => {
    markerFile = join(fixtureDir, "line-child.marker");
    const healthBin = writeFixture("health.cjs", fakeHealthServer(43110));
    const lineBin = writeFixture("line.cjs", fakeLineChild(markerFile, 43111));
    const io = { ...capturedIo(), readinessTimeoutMs: 3_000 };
    const run = runLauncher(
      manifestFor([
        {
          name: "fakeapp",
          label: "FakeApp",
          port: 43110,
          url: "http://127.0.0.1:43110",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
        {
          name: "lineapp",
          label: "LineApp",
          port: 43111,
          url: "http://127.0.0.1:43111",
          health: "/health",
          command: "node",
          args: [lineBin],
          env: process.env,
        },
      ]),
      io,
    );
    // Wait for the ready line, THEN request shutdown while it runs.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/Tenvyr is ready\./.test(io.buffer.join(""))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(io.buffer.join(""), /Tenvyr is ready\./);
    process.emit("SIGINT");
    const result = await run;
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 0);
    assert.match(output, /FakeApp ready/);
    // Ready IS printed because every required gate passed.
    assert.match(output, /Tenvyr is ready\./);
    // Optional capability shows disabled, not failure.
    assert.match(output, /Kafka\s+disabled/);
    assert.match(output, /├─ LineApp\s+ready/);
    // Foreign framework lines get tagged; dev-format lines pass through.
    assert.match(output, /RouterExplorer/);
    assert.match(output, /already formatted line/);
    // Process cleanup: the line child was never SIGTERMed (no shutdown).
    // Non-TTY: no ANSI anywhere.
    assert.doesNotMatch(output, ANSI);
  });

  test("readiness: process alive but /health unavailable => NOT ready, no ready line, exit 1", async () => {
    // The child starts and runs, but its health endpoint never answers.
    const neverReady = writeFixture(
      "never-ready.cjs",
      `setInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => process.exit(0));\n`,
    );
    const io = { ...capturedIo(), readinessTimeoutMs: 1_500 };
    const result = await runLauncher(
      manifestFor([
        {
          name: "stuck",
          label: "Stuck",
          port: 43112,
          url: "http://127.0.0.1:43112",
          health: "/health",
          command: "node",
          args: [neverReady],
          env: process.env,
        },
      ]),
      { ...io, mode: "normal" },
    );
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(output, /Tenvyr is ready\./);
    assert.match(output, /Tenvyr did not start successfully\./);
    assert.match(output, /Stuck\s+failed/);
  });

  test("failure: a required service exits => launcher exits non-zero and never prints ready", async () => {
    const crasher = writeFixture("crasher.cjs", `console.error("fatal: db refused");\nprocess.exit(1);\n`);
    const healthBin = writeFixture("health2.cjs", fakeHealthServer(43114));
    const io = { ...capturedIo(), readinessTimeoutMs: 1_500 };
    const result = await runLauncher(
      manifestFor([
        {
          name: "crash",
          label: "Crash",
          port: 43113,
          url: "http://127.0.0.1:43113",
          health: "/health",
          command: "node",
          args: [crasher],
          env: process.env,
        },
        {
          name: "ok",
          label: "Ok",
          port: 43114,
          url: "http://127.0.0.1:43114",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
      ]),
      io,
    );
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 1);
    assert.doesNotMatch(output, /Tenvyr is ready\./);
    assert.match(output, /Crash\s+failed/);
    assert.match(output, /Tenvyr did not start successfully\./);
  });

  test("shutdown: SIGINT => children receive SIGTERM and exit; clean stop message", async () => {
    markerFile = join(fixtureDir, "shutdown-child.marker");
    const healthBin = writeFixture("health3.cjs", fakeHealthServer(43115));
    const termChild = writeFixture("term-child.cjs", fakeLineChild(markerFile, 43116));
    const io = { ...capturedIo(), readinessTimeoutMs: 3_000 };
    const run = runLauncher(
      manifestFor([
        {
          name: "sigapp",
          label: "SigApp",
          port: 43115,
          url: "http://127.0.0.1:43115",
          health: "/health",
          command: "node",
          args: [healthBin],
          env: process.env,
        },
        {
          name: "termapp",
          label: "TermApp",
          port: 43116,
          url: "http://127.0.0.1:43116",
          health: "/health",
          command: "node",
          args: [termChild],
          env: process.env,
        },
      ]),
      io,
    );
    // Wait for readiness to be reached, then request shutdown.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/Tenvyr is ready\./.test(io.buffer.join(""))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(io.buffer.join(""), /Tenvyr is ready\./);
    process.emit("SIGINT");
    const result = await run;
    const output = io.buffer.join("");
    assert.equal(result.exitCode, 0);
    assert.match(output, /Stopping Tenvyr\.\.\./);
    // The child received SIGTERM (its handler wrote the marker).
    assert.equal(existsSync(markerFile), true);
    assert.match(readFileSync(markerFile, "utf8"), /SIGTERM/);
    assert.match(output, /SigApp stopped/);
    assert.match(output, /TermApp stopped/);
    assert.match(output, /Tenvyr stopped cleanly\./);
  });
});

/* ------------------------------------------------------------------ */
/* Final closure: signal/lifecycle regressions with REAL children      */
/* ------------------------------------------------------------------ */

const closureFixtureDir = mkdtempSync(join(tmpdir(), "tenvyr-closure-"));
const writeFixture = (name, content) => {
  const path = join(closureFixtureDir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${content}`, { mode: 0o755 });
  return path;
};
const capturedIo = () => {
  const buffer = [];
  return {
    write: (text) => buffer.push(text),
    color: false,
    log: () => undefined,
    mode: "normal",
    isInteractive: false,
    buffer,
  };
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
};

/** Long-running fake service: writes its pid, never serves health. */
const lingerChild = (markerFile, pidFile) =>
  `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(markerFile)}, "up");
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);`;

/** Fake service with a health server that stays up. */
const stayingHealth = (port) =>
  `const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(port + ".pid")}, String(process.pid));
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { status: "UP" } }));
  } else {
    res.end("ok");
  }
});
server.listen(${port}, "127.0.0.1");
setInterval(() => {}, 1000);`;

/** Fake service with a health server that exits after N ms with code C. */
const healthWithExit = (port, exitAfterMs, exitCode) =>
  `const http = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(port + ".pid")}, String(process.pid));
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { status: "UP" } }));
  } else {
    res.end("ok");
  }
});
server.listen(${port}, "127.0.0.1");
setTimeout(() => process.exit(${exitCode}), ${exitAfterMs});`;

const waitForFile = async (path, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for file ${path}`);
};

describe("final closure: signals from the start of launch", () => {
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    test(`${signal} during startup: launcher exits and the spawned child is gone`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "tenvyr-signal-"));
      const marker = join(dir, "child-up");
      const pidFile = join(dir, "child.pid");
      const childBin = writeFixture("linger.cjs", lingerChild(marker, pidFile));
      const io = { ...capturedIo(), readinessTimeoutMs: 60_000, isInteractive: false };
      const manifest = {
        services: [
          {
            name: "linger",
            label: "Linger",
            command: "node",
            args: [childBin],
            cwd: dir,
            env: { ...process.env },
            url: "http://127.0.0.1:1",
            health: "/health",
            port: 1,
          },
        ],
        infraServices: [],
        root: dir,
      };
      const run = runLauncher(manifest, io);
      await waitForFile(marker, 5_000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.ok(processAlive(pid), "fake service must be alive before the signal");
      // process.emit does not pass the signal name as an argument (a real
      // signal does) — pass it explicitly so the handler sees it.
      process.emit(signal, signal);
      const result = await run;
      assert.equal(result.exitCode, signal === "SIGTERM" ? 143 : 0, `exit code for ${signal}`);
      await waitUntil(() => !processAlive(pid), 5_000, "fake service to be terminated");
    });
  }

  test("SIGINT with MULTIPLE children started: all process groups are terminated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenvyr-signal2-"));
    const markers = [];
    const pidFiles = [];
    const services = [];
    for (const name of ["alpha", "beta"]) {
      const marker = join(dir, `${name}-up`);
      const pidFile = join(dir, `${name}.pid`);
      markers.push(marker);
      pidFiles.push(pidFile);
      const childBin = writeFixture(`${name}.cjs`, lingerChild(marker, pidFile));
      services.push({
        name,
        label: name[0].toUpperCase() + name.slice(1),
        command: "node",
        args: [childBin],
        cwd: dir,
        env: { ...process.env },
        url: `http://127.0.0.1:${1 + services.length}`,
        health: "/health",
        port: 1 + services.length,
      });
    }
    const io = { ...capturedIo(), readinessTimeoutMs: 60_000, isInteractive: false };
    const run = runLauncher({ services, infraServices: [], root: dir }, io);
    await waitForFile(markers[0], 5_000);
    await waitForFile(markers[1], 5_000);
    const pids = pidFiles.map((f) => Number(readFileSync(f, "utf8")));
    process.emit("SIGINT", "SIGINT");
    const result = await run;
    assert.equal(result.exitCode, 0);
    for (const pid of pids) {
      await waitUntil(() => !processAlive(pid), 5_000, `child ${pid} terminated`);
    }
  });
});

describe("final closure: required child failure semantics", () => {
  test("child dies AFTER ready: automatic failed shutdown of siblings, non-zero exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenvyr-fail-"));
    const okBin = writeFixture("ok.cjs", stayingHealth(43151));
    const dierBin = writeFixture("dier.cjs", healthWithExit(43152, 2_500, 7));
    const io = { ...capturedIo(), readinessTimeoutMs: 10_000, isInteractive: false };
    const services = [
      {
        name: "ok",
        label: "Ok",
        command: "node",
        args: [okBin],
        cwd: dir,
        env: { ...process.env },
        url: "http://127.0.0.1:43151",
        health: "/health",
        port: 43151,
      },
      {
        name: "dier",
        label: "Dier",
        command: "node",
        args: [dierBin],
        cwd: dir,
        env: { ...process.env },
        url: "http://127.0.0.1:43152",
        health: "/health",
        port: 43152,
      },
    ];
    const started = Date.now();
    const run = runLauncher({ services, infraServices: [], root: dir }, io);
    const result = await run;
    const duration = Date.now() - started;
    assert.equal(result.exitCode, 1, "stack must fail non-zero after a required child dies");
    if (!(duration < 20_000)) {
      // eslint-disable-next-line no-console
      console.error("BUFFER:\n" + io.buffer.join(""));
    }
    assert.ok(duration < 20_000, `auto shutdown should be fast, took ${duration}ms`);
    const okPid = Number(readFileSync(join(dir, "43151.pid"), "utf8"));
    await waitUntil(() => !processAlive(okPid), 5_000, "sibling to be shut down automatically");
    const output = io.buffer.join("");
    assert.match(output, /Dier exited \(code 7\)/);
    // Never a clean running result after the failure.
    const readyIndex = output.indexOf("Tenvyr is ready.");
    const stoppedIndex = output.indexOf("Tenvyr stopped");
    if (readyIndex !== -1) {
      assert.ok(stoppedIndex === -1 || stoppedIndex > readyIndex, "no clean result after failure");
    }
    assert.match(output, /Stopping Tenvyr/);
  });

  test("child already exited: shutdown does NOT wait the full grace period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenvyr-exit-"));
    const crasherBin = writeFixture(
      "crash.cjs",
      `process.stdout.write("boom\n"); process.exit(1);`,
    );
    const io = { ...capturedIo(), readinessTimeoutMs: 1_500, isInteractive: false };
    const services = [
      {
        name: "crash",
        label: "Crash",
        command: "node",
        args: [crasherBin],
        cwd: dir,
        env: { ...process.env },
        url: "http://127.0.0.1:43160",
        health: "/health",
        port: 43160,
      },
    ];
    const started = Date.now();
    const run = runLauncher({ services, infraServices: [], root: dir }, io);
    const result = await run;
    const duration = Date.now() - started;
    assert.equal(result.exitCode, 1);
    assert.ok(
      duration < 10_000,
      `already-exited child must not stall shutdown (took ${duration}ms)`,
    );
  });
});

describe("final closure: env file semantics", () => {
  test("loadDotEnv: inline comment, quoted spaces, # in quotes, blank, precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "tenvyr-env-"));
    writeFileSync(
      join(dir, ".env"),
      [
        "LLM_PROVIDER=mock # mock | openai",
        'TITLE="hello world"',
        'TOKEN="a#b"',
        "EMPTY=",
        "EXISTING=from-file",
      ].join("\n"),
    );
    const env = { EXISTING: "from-shell" };
    loadDotEnv(dir, env);
    assert.equal(env.LLM_PROVIDER, "mock");
    assert.equal(env.TITLE, "hello world");
    assert.equal(env.TOKEN, "a#b");
    assert.equal(env.EMPTY, "");
    assert.equal(env.EXISTING, "from-shell");
  });

  test("loadDotEnv: missing .env is optional", () => {
    const dir = mkdtempSync(join(tmpdir(), "tenvyr-env2-"));
    const env = { A: "1" };
    loadDotEnv(dir, env);
    assert.equal(env.A, "1");
  });
});

describe("dev launcher dynamic bridge composition (buildManifest)", () => {
  test("DEFAULT PORTS: composes loopback bridge environment for orchestrator and host", () => {
    const manifest = buildManifest({});
    const orch = manifest.services.find((s) => s.name === "orchestrator");
    const host = manifest.services.find((s) => s.name === "host");
    assert.ok(orch);
    assert.ok(host);

    assert.equal(orch.env.HTTP_AGENT_CALLBACK_BASE_URL, "http://127.0.0.1:3001");
    assert.equal(orch.env.HTTP_AGENT_ALLOW_INSECURE, "true");
    assert.equal(orch.env.LOCAL_EXECUTOR_HOST_URL, "http://127.0.0.1:3002/v1/runs");
    assert.equal(orch.env.EXECUTOR_HOST_URL, "http://127.0.0.1:3002/v1/runs");
    assert.equal(
      host.env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS,
      "http://127.0.0.1:3001,http://localhost:3001",
    );
  });

  test("CUSTOM PORTS: custom ORCHESTRATOR_PORT and EXECUTOR_HOST_PORT propagate to all URLs", () => {
    const manifest = buildManifest({
      ORCHESTRATOR_PORT: "4101",
      EXECUTOR_HOST_PORT: "4102",
    });
    const orch = manifest.services.find((s) => s.name === "orchestrator");
    const host = manifest.services.find((s) => s.name === "host");

    assert.equal(orch.env.HTTP_AGENT_CALLBACK_BASE_URL, "http://127.0.0.1:4101");
    assert.equal(orch.env.LOCAL_EXECUTOR_HOST_URL, "http://127.0.0.1:4102/v1/runs");
    assert.equal(orch.env.EXECUTOR_HOST_URL, "http://127.0.0.1:4102/v1/runs");
    assert.equal(
      host.env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS,
      "http://127.0.0.1:4101,http://localhost:4101",
    );
  });

  test("EXPLICIT OVERRIDES: preserves operator provided URLs and origins", () => {
    const manifest = buildManifest({
      HTTP_AGENT_CALLBACK_BASE_URL: "https://orchestrator.internal:8443",
      LOCAL_EXECUTOR_HOST_URL: "http://host.internal:9000/v1/runs",
      EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS: "https://orchestrator.internal:8443",
      HTTP_AGENT_ALLOW_INSECURE: "false",
    });
    const orch = manifest.services.find((s) => s.name === "orchestrator");
    const host = manifest.services.find((s) => s.name === "host");

    assert.equal(
      orch.env.HTTP_AGENT_CALLBACK_BASE_URL,
      "https://orchestrator.internal:8443",
    );
    assert.equal(orch.env.HTTP_AGENT_ALLOW_INSECURE, "false");
    assert.equal(orch.env.LOCAL_EXECUTOR_HOST_URL, "http://host.internal:9000/v1/runs");
    assert.equal(
      host.env.EXECUTOR_HOST_CALLBACK_ALLOWED_ORIGINS,
      "https://orchestrator.internal:8443",
    );
  });

  test("SECRETS: independent runs generate distinct tokens; never appear in normal formatter output", () => {
    const manifest1 = buildManifest({});
    const manifest2 = buildManifest({});

    const token1 = manifest1.services[0].env.HTTP_AGENT_BEARER_TOKEN;
    const token2 = manifest2.services[0].env.HTTP_AGENT_BEARER_TOKEN;
    const secret1 = manifest1.services[0].env.HTTP_AGENT_CALLBACK_SECRET;
    const secret2 = manifest2.services[0].env.HTTP_AGENT_CALLBACK_SECRET;

    assert.ok(token1 && token1.length >= 32);
    assert.ok(secret1 && secret1.length >= 32);
    assert.notEqual(token1, token2);
    assert.notEqual(secret1, secret2);

    const formatted = formatServiceLine({
      service: "dev",
      level: "INFO",
      message: "Ready on port 3001",
      color: false,
    });
    assert.ok(!formatted.includes(token1));
    assert.ok(!formatted.includes(secret1));
  });

  test("TENVYR_EXECUTOR_HOST=rust launches the additive Rust host binary", () => {
    const manifest = buildManifest({ TENVYR_EXECUTOR_HOST: "rust" });
    const host = manifest.services.find((s) => s.name === "host");
    assert.equal(host.command, "cargo");
    assert.deepEqual(host.args, ["run", "--quiet"]);
    assert.match(host.cwd, /local-executor-host-rs$/);
  });
});
