import { Injectable } from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PROFILE_TEMPLATES } from "../executors/runtime-profiles";
import type { RuntimeKind } from "../executors/runtime-connection";
import { runCliProbe } from "./cli-probe";

/**
 * Product Phase 1: guided runtime onboarding ("Installed / Version / Auth /
 * Connect / Test") for the supported CLI runtimes. Detection NEVER reads
 * credentials or runtime-owned session files; it only:
 *   - resolves the executable on PATH (bounded);
 *   - runs the documented version/auth probe (bounded, no output sniffing);
 *   - reports the ready-to-connect payload.
 * Authentication stays owned by the runtime; Tenvyr only displays readiness.
 */

const ONBOARDING_KINDS = ["codex", "claude", "opencode"] as const;
export type OnboardingRuntimeKind = (typeof ONBOARDING_KINDS)[number];

/** Bounded candidate executable names per runtime (PATH lookup only). */
const EXECUTABLE_CANDIDATES: Record<OnboardingRuntimeKind, string[]> = {
  codex: ["codex"],
  claude: ["claude"],
  opencode: ["opencode"],
};

const PROBE_BOUNDS = {
  wallTimeMs: 15_000,
  maxOutputBytes: 8192,
} as const;

/** Resolves a command on PATH (bounded, no shell). Returns null when not
 *  found. */
export function resolveExecutableOnPath(name: string): string | null {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate)) {
        const probe = spawnSync("test", ["-x", candidate], { shell: false });
        if (probe.status === 0) return candidate;
      }
    } catch {
      // keep scanning
    }
  }
  return null;
}

export type RuntimeOnboardingStatus = {
  runtimeKind: OnboardingRuntimeKind;
  pinnedVersion: string;
  /** Bounded detection result. */
  detected: boolean;
  /** Resolved executable path when detected. */
  executable: string | null;
  /** Bounded version probe result when the template declares a version
   *  probe (claude/opencode); null when the runtime documents none
   *  (codex — auth-status is the primary probe). */
  version: string | null;
  /** Bounded auth readiness: null when no documented auth probe exists
   *  (opencode provider auth is runtime-owned and not probed), otherwise
   *  true/false from the documented exit-code contract. */
  authReady: boolean | null;
  /** P2: the official runtime-owned login command for the guided Sign-in
   *  action (never a Tenvyr credential flow). */
  loginCommand: string;
  /** P2: fixed model-argument argv prefix documented for the runtime
   *  (e.g. ["--model"]); the host agent config mirrors it. */
  modelArgvPrefix: string[];
  /** Bounded guidance, never credential instructions. */
  guidance: string[];
  /** Authoritative installation documentation URL from runtime template. */
  docUrl: string;
  /** Ready-to-submit connect payload (executable + template defaults). */
  connectPayload: {
    runtimeKind: OnboardingRuntimeKind;
    executable: string;
    version?: string;
  } | null;
};

@Injectable()
export class RuntimeOnboardingService {
  /** Bounded detection + probe for a supported runtime. */
  async status(
    runtimeKind: OnboardingRuntimeKind,
  ): Promise<RuntimeOnboardingStatus> {
    const template = RUNTIME_PROFILE_TEMPLATES[runtimeKind];
    const guidance: string[] = [];
    let executable: string | null = null;
    for (const candidate of EXECUTABLE_CANDIDATES[runtimeKind]) {
      executable = resolveExecutableOnPath(candidate);
      if (executable) break;
    }
    if (executable === null) {
      guidance.push(
        `"${runtimeKind}" was not found on PATH — install the official ${runtimeKind} CLI first; Tenvyr never downloads runtimes.`,
      );
      return {
        runtimeKind,
        pinnedVersion: template.pinnedVersion,
        detected: false,
        executable: null,
        version: null,
        authReady: null,
        loginCommand: template.loginCommand,
        modelArgvPrefix: template.modelArgvPrefix,
        guidance,
        docUrl: template.sourceUrl,
        connectPayload: null,
      };
    }
    guidance.push(`Detected executable: ${executable}`);
    // Version probe (documented where the CLI documents one).
    let version: string | null = null;
    if (template.probe.expectsVersion === true) {
      const probe = await runCliProbe(
        {
          command: executable,
          args: template.probe.args,
          probe: {
            ...template.probe,
            wallTimeMs: PROBE_BOUNDS.wallTimeMs,
            maxOutputBytes: PROBE_BOUNDS.maxOutputBytes,
          },
        },
        process.env,
      );
      version = probe.ok ? (probe.version ?? null) : null;
      if (!probe.ok) {
        guidance.push(
          `Version probe did not complete (${probe.reasonCode}) — the operator-declared pinned version ${template.pinnedVersion} is assumed.`,
        );
      }
    }
    // Auth probe: the documented auth-status contract is either the
    // template's dedicated authProbe (claude) or the primary probe itself
    // when it carries auth exit semantics (codex `login status`:
    // authAnyNonZero). Exit-code mapping only — never output inference.
    let authReady: boolean | null = null;
    const authProbe =
      template.authProbe ??
      (template.probe.authAnyNonZero === true ||
      (template.probe.authExitCodes?.length ?? 0) > 0
        ? template.probe
        : null);
    if (authProbe) {
      const auth = await runCliProbe(
        {
          command: executable,
          args: authProbe.args,
          probe: {
            ...authProbe,
            wallTimeMs: PROBE_BOUNDS.wallTimeMs,
            maxOutputBytes: PROBE_BOUNDS.maxOutputBytes,
          },
        },
        process.env,
      );
      authReady = auth.ok;
      guidance.push(
        auth.ok
          ? "Authentication: ready (runtime-owned)."
          : `Authentication required (${auth.reasonCode}) — run the official ${runtimeKind} login command; Tenvyr does not collect provider credentials.`,
      );
    } else {
      guidance.push(
        "Authentication is runtime-owned and not probed (no documented auth-status contract); the connection test is the readiness check.",
      );
    }
    return {
      runtimeKind,
      pinnedVersion: template.pinnedVersion,
      detected: true,
      executable,
      version,
      authReady,
      loginCommand: template.loginCommand,
      modelArgvPrefix: template.modelArgvPrefix,
      guidance,
      docUrl: template.sourceUrl,
      connectPayload: {
        runtimeKind,
        executable,
        ...(version ? { version } : {}),
      },
    };
  }

  /** Bounded kinds this onboarding supports. */
  static kinds(): readonly OnboardingRuntimeKind[] {
    return ONBOARDING_KINDS;
  }
}

/** Type guard for onboarding kinds. */
export function isOnboardingRuntimeKind(
  value: string,
): value is OnboardingRuntimeKind {
  return (ONBOARDING_KINDS as readonly string[]).includes(value);
}

/** Kept for type-level symmetry with RuntimeKind consumers. */
export type { RuntimeKind };
