"use client";

import React, { useState, useEffect, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  PlayCircle,
  FolderGit2,
  Users,
  Shield,
  FileCheck2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from "lucide-react";
import { tenvyrApi } from "../../../lib/tenvyr-api/client.ts";
import {
  parseProviderDiscovery,
  parseWorkbenchCommandResult,
  pickerReadiness,
} from "../../../lib/tenvyr-api/guards.ts";
import type {
  TeamTemplateV1,
  WorkbenchWorkspaceV1,
  WorkbenchConnectionCardV1,
  CoordinatorSelectionV1,
  RuntimeTargetV1,
  StartTeamRunRequest,
  ProviderDiscoveryV1,
} from "../../../lib/tenvyr-api/types.ts";
import { LoadingSpinner } from "../../../components/shared/LoadingSpinner.tsx";
import { DirectoryInput } from "../../../components/shared/DirectoryInput.tsx";
import { RuntimeTargetPicker } from "../../../components/shared/RuntimeTargetPicker.tsx";

function NewTeamRunContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialWorkspaceId = searchParams.get("workspaceId") || "";
  /** PP1 Slice C: when set, this launch is a CONTINUATION of a terminal
   *  source run (bounded HandoffBundle as initial context; source runtime
   *  identity never rewritten). */
  const continueFrom = searchParams.get("continueFrom") || "";

  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Available catalogs
  const [templates, setTemplates] = useState<TeamTemplateV1[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkbenchWorkspaceV1[]>([]);
  /** PP1: execution isolation mode for the run's workspace (git-worktree
   *  = isolated Tenvyr-owned worktree; shared = execute against the source
   *  tree). */
  const [executionIsolation, setExecutionIsolation] = useState<
    "shared" | "git-worktree"
  >("shared");
  const [connections, setConnections] = useState<WorkbenchConnectionCardV1[]>(
    [],
  );

  // Step 1: Goal & Name
  const [goal, setGoal] = useState<string>("");
  const [runName, setRunName] = useState<string>("team-run");

  // Step 2: Workspace
  const [selectedWorkspaceId, setSelectedWorkspaceId] =
    useState<string>(initialWorkspaceId);
  const [customWorkspacePath, setCustomWorkspacePath] = useState<string>("");
  /** PP1: a workspace is selected when a registered workspace OR a direct
   *  path is present (isolation only applies to real workspaces). */
  const hasWorkspaceSelection = Boolean(
    selectedWorkspaceId || customWorkspacePath.trim(),
  );
  const selectedWorkspaceSnapshot =
    workspaces.find((ws) => ws.workspaceId === selectedWorkspaceId)
      ?.snapshot ?? null;

  // Step 3: Template & Team Roles
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    "software-engineering",
  );
  const [plannerSelection, setPlannerSelection] =
    useState<CoordinatorSelectionV1>({
      kind: "agent",
      name: "planner",
    });
  const [verifierSelection, setVerifierSelection] =
    useState<CoordinatorSelectionV1>({
      kind: "agent",
      name: "verifier",
    });
  const [workerAgents, setWorkerAgents] = useState<string>("implementation");
  // P2: frozen Runtime Targets — connection + model per role.
  const [plannerTarget, setPlannerTarget] = useState<RuntimeTargetV1 | null>(
    null,
  );
  const [verifierTarget, setVerifierTarget] = useState<RuntimeTargetV1 | null>(
    null,
  );
  const [workerTargets, setWorkerTargets] = useState<RuntimeTargetV1[]>([]);

  // Step 4: Guardrails
  const [maxIterations, setMaxIterations] = useState<number>(3);
  const [maxWorkersPerIteration, setMaxWorkersPerIteration] =
    useState<number>(4);
  const [maxTotalWorkers, setMaxTotalWorkers] = useState<number>(20);
  const [loopDeadlineMinutes, setLoopDeadlineMinutes] = useState<number>(60);
  const [budgetAccountId, setBudgetAccountId] = useState<string>("");
  const [showAdvancedGuardrails, setShowAdvancedGuardrails] =
    useState<boolean>(false);

  // Step 5: Acceptance Evidence
  const [testCommand, setTestCommand] = useState<string>("");
  const [buildCommand, setBuildCommand] = useState<string>("");
  const [lintCommand, setLintCommand] = useState<string>("");
  const [typecheckCommand, setTypecheckCommand] = useState<string>("");
  const [requiredArtifacts, setRequiredArtifacts] = useState<string>("");

  const applyTemplate = useCallback((template: TeamTemplateV1) => {
    setSelectedTemplateId(template.templateId);
    setGoal((current) => (current.trim() ? current : template.goalFraming));
    setMaxIterations(template.defaultBounds.maxIterations);
    setMaxWorkersPerIteration(template.defaultBounds.maxWorkersPerIteration);
    setMaxTotalWorkers(template.defaultBounds.maxTotalWorkers);
    setLoopDeadlineMinutes(
      Math.round(template.defaultBounds.loopDeadlineMs / 60000),
    );
  }, []);

  const loadCatalogs = useCallback(async () => {
    try {
      const [templRes, wsRes, connRes] = await Promise.allSettled([
        tenvyrApi.getTeamTemplates(),
        tenvyrApi.getWorkspaces(),
        tenvyrApi.getWorkbenchConnections(),
      ]);

      if (templRes.status === "fulfilled") {
        const list: TeamTemplateV1[] = templRes.value?.templates ?? [];
        setTemplates(list);
        if (list.length > 0) {
          const se =
            list.find(
              (t: TeamTemplateV1) => t.templateId === "software-engineering",
            ) || list[0];
          applyTemplate(se);
        }
      }
      if (wsRes.status === "fulfilled") {
        const list = wsRes.value?.workspaces ?? [];
        setWorkspaces(list);
        if (!selectedWorkspaceId && list.length > 0) {
          setSelectedWorkspaceId(list[0].workspaceId);
        }
      }
      if (connRes.status === "fulfilled") {
        setConnections(connRes.value?.cards ?? []);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || "Failed to load team launch prerequisites");
    } finally {
      setLoading(false);
    }
  }, [applyTemplate, selectedWorkspaceId]);

  useEffect(() => {
    loadCatalogs();
  }, [loadCatalogs]);

  const handleTemplateChange = (templateId: string) => {
    const found = templates.find((t) => t.templateId === templateId);
    if (found) {
      applyTemplate(found);
    } else {
      setSelectedTemplateId(templateId);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) {
      setErrorMsg("Goal is required");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    // Build worker list & executors allowlist
    const splitList = (val: string) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    const allowedWorkers: CoordinatorSelectionV1[] = [
      ...splitList(workerAgents).map((name) => ({
        kind: "agent" as const,
        name,
      })),
      ...workerTargets.map((target) => ({
        kind: "connection" as const,
        name: target.connectionId,
      })),
    ];

    const executors = new Set<string>(["local-host"]);
    for (const sel of [
      plannerSelection,
      verifierSelection,
      ...allowedWorkers,
    ]) {
      if (sel.kind === "agent") {
        executors.add(`agent:${sel.name}`);
      } else {
        const found = connections.find((c) => c.connectionId === sel.name);
        if (found?.executorId) executors.add(found.executorId);
      }
    }

    const payload: StartTeamRunRequest = {
      idempotencyKey: crypto.randomUUID(),
      name: runName.trim() || "team-run",
      goal: goal.trim(),
      config: {
        schemaVersion: 1,
        planner: plannerSelection,
        verifier: verifierSelection,
        allowedWorkers,
        // P2: freeze the exact Runtime Targets (connection + model).
        ...(plannerSelection.kind === "connection" && plannerTarget
          ? {
              plannerTarget: {
                ...plannerTarget,
                connectionId: plannerSelection.name,
              },
            }
          : {}),
        ...(verifierSelection.kind === "connection" && verifierTarget
          ? {
              verifierTarget: {
                ...verifierTarget,
                connectionId: verifierSelection.name,
              },
            }
          : {}),
        ...(workerTargets.length > 0 ? { allowedTargets: workerTargets } : {}),
        maxIterations: Number(maxIterations),
        maxWorkersPerIteration: Number(maxWorkersPerIteration),
        maxTotalWorkers: Number(maxTotalWorkers),
        loopDeadlineMs: Number(loopDeadlineMinutes) * 60 * 1000,
        delegationDepthMax: 2,
        allowedExecutors: Array.from(executors),
        ...(budgetAccountId.trim()
          ? { budgetAccountId: budgetAccountId.trim() }
          : {}),
      },
    };

    if (selectedWorkspaceId) {
      payload.workspace = { workspaceId: selectedWorkspaceId };
    } else if (customWorkspacePath.trim()) {
      payload.workspace = { path: customWorkspacePath.trim() };
    }
    // PP1: the launch freezes the run's execution isolation mode (only for
    // runs with a workspace).
    if (hasWorkspaceSelection) {
      payload.executionIsolation = executionIsolation;
    }

    if (
      testCommand ||
      buildCommand ||
      lintCommand ||
      typecheckCommand ||
      requiredArtifacts
    ) {
      payload.acceptanceEvidence = {
        ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
        ...(buildCommand.trim() ? { buildCommand: buildCommand.trim() } : {}),
        ...(lintCommand.trim() ? { lintCommand: lintCommand.trim() } : {}),
        ...(typecheckCommand.trim()
          ? { typecheckCommand: typecheckCommand.trim() }
          : {}),
        ...(requiredArtifacts.trim()
          ? { requiredArtifacts: splitList(requiredArtifacts) }
          : {}),
      };
    }

    try {
      // P2 closure round 2: BLOCK launch when a previously selected target
      // became unavailable — providers must still be AUTHENTICATED through
      // their exact connection at launch time. Never silently auto-selects
      // another provider/model; explains exactly what changed.
      const frozenTargets = [
        ...(plannerTarget ? [plannerTarget] : []),
        ...(verifierTarget ? [verifierTarget] : []),
        ...workerTargets,
      ];
      const targetConnections = new Set(
        frozenTargets.map((target) => target.connectionId),
      );
      const discoveryByConnection = new Map<string, ProviderDiscoveryV1 | null>();
      await Promise.all(
        Array.from(targetConnections).map(async (connectionId) => {
          try {
            const res = await tenvyrApi.discoverRuntimeProviders(connectionId);
            discoveryByConnection.set(
              connectionId,
              res.success ? parseProviderDiscovery(res.data) : null,
            );
          } catch {
            discoveryByConnection.set(connectionId, null);
          }
        }),
      );
      const unavailable: string[] = [];
      for (const target of frozenTargets) {
        if (!target.modelId) continue; // Runtime default needs no provider
        const discovery = discoveryByConnection.get(target.connectionId);
        if (!discovery) {
          unavailable.push(
            `${target.connectionId} · ${target.modelId} (provider state unavailable)`,
          );
          continue;
        }
        const providerId = target.modelId.includes("/")
          ? target.modelId.split("/")[0]
          : null;
        if (providerId && discovery.providers.length === 0) {
          // Authoritative provider discovery (opencode) with ZERO connected
          // providers: no explicit provider/model target may launch.
          unavailable.push(
            `${target.connectionId} · ${providerId} — no providers connected through this runtime`,
          );
          continue;
        }
        const connected = discovery.providers.filter((p) => p.authenticated);
        if (
          providerId &&
          !connected.some((p) => p.providerId === providerId)
        ) {
          unavailable.push(
            `${target.connectionId} · ${providerId} is no longer connected`,
          );
        }
      }
      if (unavailable.length > 0) {
        setErrorMsg(
          `Launch blocked — these targets changed since selection:\n${unavailable.join("\n")}\n\nReturn to the picker and choose a connected provider/model.`,
        );
        setSubmitting(false);
        return;
      }

      const res = continueFrom
        ? await tenvyrApi.continueWorkbenchExecution(continueFrom, {
            idempotencyKey: payload.idempotencyKey,
            config: payload.config,
          })
        : await tenvyrApi.startTeamRun(payload);
      const command = parseWorkbenchCommandResult<{ executionId: string; workspace?: string }>(res.data);
      if (command.outcome === "executed" && command.result?.executionId) {
        router.push(`/runs/${encodeURIComponent(command.result.executionId)}`);
      } else if (command.outcome === "duplicate" && command.result?.executionId) {
        router.push(`/runs/${encodeURIComponent(command.result.executionId)}`);
      } else {
        setErrorMsg(
          command.error?.message || `Launch rejected: ${JSON.stringify(res)}`,
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || "Failed to start team run");
    } finally {
      setSubmitting(false);
    }
  };

  // Post-PP1 hardening: truthful picker. Core filtering is accepted
  // backend authority — this only makes it VISIBLE: unavailable /
  // AUTH_REQUIRED connections render as disabled entries with the reason,
  // DEGRADED stays selectable but visibly warned, REVOKED never selectable.
  const pickerEntries = connections.map((c) => ({
    card: c,
    ...pickerReadiness(c),
  }));
  const selectableConnections = pickerEntries.filter((e) => e.selectable);

  /** One <option> per connection: selectable entries carry a degraded
   *  marker when warned; the rest are disabled with their exact reason. */
  const connectionOptions = pickerEntries.map(({ card, selectable, reason }) => (
    <option
      key={card.connectionId}
      value={`conn:${card.connectionId}`}
      disabled={!selectable}
    >
      {card.name} ({card.connectionId})
      {selectable && reason ? ` — ⚠ ${reason}` : ""}
      {!selectable && reason ? ` — ${reason}` : ""}
    </option>
  ));

  const activeConnections = selectableConnections.map((e) => e.card);

  return (
    <div className="page-container" style={{ maxWidth: "840px" }}>
      {continueFrom && (
        <div className="notice notice-info" style={{ marginBottom: "1rem" }}>
          <div>
            <strong>Continuation run</strong> — this launch continues
            terminal run <code>{continueFrom.slice(0, 8)}…</code> with a NEW
            runtime team. A bounded HandoffBundle (goal, verifier decision,
            worker summaries, artifact refs, acceptance criteria) is supplied
            as the initial context; the source run&apos;s runtime/model
            identity is never rewritten, and a preserved execution workspace
            transfers under exclusive ownership.
          </div>
        </div>
      )}
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>
            Launch Supervised Team Run
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Delegate a high-level goal to Planner, Workers, and Verifier under
            strict Tenvyr supervision.
          </p>
        </div>
      </div>

      {errorMsg && (
        <div className="notice notice-error">
          <XCircle size={16} />
          <div>{errorMsg}</div>
        </div>
      )}

      {loading ? (
        <LoadingSpinner text="Loading run options…" />
      ) : (
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
        >
          {/* Step 1: Goal */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <Sparkles size={16} color="var(--accent-blue)" />
                <h2 className="card-title">1. Objective & Goal</h2>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">
                What do you want the team to accomplish?
              </label>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                required
                rows={4}
                className="form-textarea"
                placeholder="Inspect the authentication module, fix the race condition, update tests, and verify the result."
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">
                Run Name (optional identifier)
              </label>
              <input
                type="text"
                value={runName}
                onChange={(e) => setRunName(e.target.value)}
                className="form-input"
                placeholder="auth-race-fix"
              />
            </div>
          </div>

          {/* Step 2: Workspace */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <FolderGit2 size={16} color="var(--accent-blue)" />
                <h2 className="card-title">2. Target Workspace</h2>
              </div>
              <Link href="/workspaces" style={{ fontSize: "0.75rem" }}>
                + Add Workspace
              </Link>
            </div>

            <div className="form-group">
              <label className="form-label">Select Workspace</label>
              <select
                value={selectedWorkspaceId}
                onChange={(e) => {
                  setSelectedWorkspaceId(e.target.value);
                  if (e.target.value) setCustomWorkspacePath("");
                }}
                className="form-select"
              >
                <option value="">
                  — None / Run without registered workspace —
                </option>
                {workspaces.map((ws) => (
                  <option key={ws.workspaceId} value={ws.workspaceId}>
                    {ws.name} ({ws.path})
                    {ws.snapshot?.branch ? ` · ${ws.snapshot.branch}` : ""}
                  </option>
                ))}
              </select>
            </div>

            {!selectedWorkspaceId && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  Or direct absolute path to repository
                </label>
                <DirectoryInput
                  value={customWorkspacePath}
                  onChange={setCustomWorkspacePath}
                  placeholder="/Users/username/repos/project"
                />
              </div>
            )}

            {hasWorkspaceSelection && (
              <>
                <div className="form-group" style={{ marginBottom: "0.5rem" }}>
                  <label className="form-label">Execution isolation</label>
                  <div
                    style={{
                      display: "flex",
                      gap: "1.25rem",
                      alignItems: "center",
                    }}
                  >
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="radio"
                        name="executionIsolation"
                        checked={executionIsolation === "git-worktree"}
                        onChange={() => setExecutionIsolation("git-worktree")}
                      />
                      <span>
                        <strong>Git worktree</strong> — isolated
                        Tenvyr-owned worktree
                      </span>
                    </label>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        fontSize: "0.85rem",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="radio"
                        name="executionIsolation"
                        checked={executionIsolation === "shared"}
                        onChange={() => setExecutionIsolation("shared")}
                      />
                      <span>
                        <strong>Shared working tree</strong> — run against
                        the source workspace
                      </span>
                    </label>
                  </div>
                </div>
                {selectedWorkspaceSnapshot?.branch ||
                selectedWorkspaceSnapshot?.headSha ? (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--text-muted)",
                      marginTop: "-0.25rem",
                    }}
                  >
                    Base{" "}
                    <code>
                      {selectedWorkspaceSnapshot.branch ?? "HEAD"} @{" "}
                      {selectedWorkspaceSnapshot.headSha?.slice(0, 7) ?? "—"}
                    </code>
                    {selectedWorkspaceSnapshot.dirty
                      ? " · dirty source tree"
                      : ""}
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Step 3: Team Configuration */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <Users size={16} color="var(--accent-blue)" />
                <h2 className="card-title">3. Team Roles</h2>
              </div>
            </div>

            {/* Template Selection Pills */}
            <div className="form-group">
              <label className="form-label">Team Template</label>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {templates.map((tpl) => (
                  <button
                    key={tpl.templateId}
                    type="button"
                    onClick={() => handleTemplateChange(tpl.templateId)}
                    className={`btn btn-sm ${selectedTemplateId === tpl.templateId ? "btn-primary" : "btn-secondary"}`}
                  >
                    {tpl.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSelectedTemplateId("custom")}
                  className={`btn btn-sm ${selectedTemplateId === "custom" ? "btn-primary" : "btn-secondary"}`}
                >
                  Custom
                </button>
              </div>
            </div>

            {/* Role Selectors */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
              }}
            >
              {/* Planner Role */}
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.85rem",
                    marginBottom: "0.5rem",
                  }}
                >
                  Planner
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  <select
                    value={
                      plannerSelection.kind === "connection"
                        ? `conn:${plannerSelection.name}`
                        : `agent:${plannerSelection.name}`
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val.startsWith("conn:")) {
                        const name = val.replace("conn:", "");
                        setPlannerSelection({
                          kind: "connection",
                          name,
                          agent: name,
                        });
                      } else {
                        setPlannerSelection({
                          kind: "agent",
                          name: val.replace("agent:", ""),
                        });
                      }
                      setPlannerTarget(null);
                    }}
                    className="form-select"
                  >
                    <optgroup label="Runtime Connections">
                      {connectionOptions}
                    </optgroup>
                    <optgroup label="Local Agent Adapters">
                      <option value="agent:planner">Local Planner</option>
                      <option value="agent:claude">Claude Adapter</option>
                      <option value="agent:codex">Codex Adapter</option>
                    </optgroup>
                  </select>
                  {plannerSelection.kind === "connection" && (
                    <div style={{ marginTop: "0.5rem" }}>
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                          marginBottom: "0.3rem",
                        }}
                      >
                        Model (frozen into every Planner attempt)
                      </div>
                      <RuntimeTargetPicker
                        connections={activeConnections.filter(
                          (c) => c.connectionId === plannerSelection.name,
                        )}
                        value={plannerTarget}
                        onChange={setPlannerTarget}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Verifier Role */}
              <div
                style={{
                  backgroundColor: "var(--bg-surface)",
                  padding: "0.75rem",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-color)",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "0.85rem",
                    marginBottom: "0.5rem",
                  }}
                >
                  Verifier
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                  }}
                >
                  <select
                    value={
                      verifierSelection.kind === "connection"
                        ? `conn:${verifierSelection.name}`
                        : `agent:${verifierSelection.name}`
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val.startsWith("conn:")) {
                        const name = val.replace("conn:", "");
                        setVerifierSelection({
                          kind: "connection",
                          name,
                          agent: name,
                        });
                      } else {
                        setVerifierSelection({
                          kind: "agent",
                          name: val.replace("agent:", ""),
                        });
                      }
                      setVerifierTarget(null);
                    }}
                    className="form-select"
                  >
                    <optgroup label="Runtime Connections">
                      {connectionOptions}
                    </optgroup>
                    <optgroup label="Local Agent Adapters">
                      <option value="agent:verifier">Local Verifier</option>
                      <option value="agent:claude">Claude Adapter</option>
                    </optgroup>
                  </select>
                  {verifierSelection.kind === "connection" && (
                    <div style={{ marginTop: "0.5rem" }}>
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--text-muted)",
                          marginBottom: "0.3rem",
                        }}
                      >
                        Model (frozen into every Verifier attempt)
                      </div>
                      <RuntimeTargetPicker
                        connections={activeConnections.filter(
                          (c) => c.connectionId === verifierSelection.name,
                        )}
                        value={verifierTarget}
                        onChange={setVerifierTarget}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Workers Pool */}
            <div style={{ marginTop: "1rem" }}>
              <label className="form-label">Worker Runtime Targets</label>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                  marginBottom: "0.5rem",
                }}
              >
                Each target freezes an allowed connection + model pair. The
                Planner may only assign workers to these exact targets.
              </p>
              {workerTargets.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.5rem",
                    marginBottom: "0.5rem",
                  }}
                >
                  {workerTargets.map((target, idx) => (
                    <div
                      key={`${target.connectionId}-${idx}`}
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        alignItems: "flex-start",
                        backgroundColor: "var(--bg-surface)",
                        padding: "0.6rem",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--border-color)",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <RuntimeTargetPicker
                          connections={connections}
                          value={target}
                          onChange={(next) => {
                            const updated = [...workerTargets];
                            updated[idx] = next ?? {
                              connectionId: target.connectionId,
                            };
                            setWorkerTargets(
                              updated.filter((t) => t.connectionId),
                            );
                          }}
                        />
                      </div>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() =>
                          setWorkerTargets(
                            workerTargets.filter((_, i) => i !== idx),
                          )
                        }
                        aria-label={`Remove target ${target.connectionId}`}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    const first = activeConnections[0];
                    if (first) {
                      setWorkerTargets([
                        ...workerTargets,
                        { connectionId: first.connectionId },
                      ]);
                    }
                  }}
                  disabled={activeConnections.length === 0}
                >
                  + Add Worker Target
                </button>

              <div
                className="form-group"
                style={{ marginBottom: 0, marginTop: "0.75rem" }}
              >
                <label className="form-label" style={{ fontSize: "0.75rem" }}>
                  Worker Agents (comma separated adapter names, no model)
                </label>
                <input
                  type="text"
                  value={workerAgents}
                  onChange={(e) => setWorkerAgents(e.target.value)}
                  className="form-input"
                  placeholder="implementation, reviewer"
                />
              </div>
            </div>
          </div>

          {/* Step 4: Guardrails & Hard Limits */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <Shield size={16} color="var(--accent-blue)" />
                <h2 className="card-title">
                  4. Supervision Limits & Guardrails
                </h2>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
                gap: "1rem",
              }}
            >
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Max Iterations</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value))}
                  required
                  className="form-input"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Workers / Iteration</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={maxWorkersPerIteration}
                  onChange={(e) =>
                    setMaxWorkersPerIteration(Number(e.target.value))
                  }
                  required
                  className="form-input"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Deadline (minutes)</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={loopDeadlineMinutes}
                  onChange={(e) =>
                    setLoopDeadlineMinutes(Number(e.target.value))
                  }
                  required
                  className="form-input"
                />
              </div>
            </div>

            {/* Advanced Guardrails Toggle */}
            <div style={{ marginTop: "1rem" }}>
              <button
                type="button"
                onClick={() =>
                  setShowAdvancedGuardrails(!showAdvancedGuardrails)
                }
                className="btn btn-secondary btn-sm"
                style={{ fontSize: "0.75rem" }}
              >
                {showAdvancedGuardrails ? (
                  <ChevronUp size={12} />
                ) : (
                  <ChevronDown size={12} />
                )}
                <span>Advanced Guardrails</span>
              </button>

              {showAdvancedGuardrails && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    padding: "0.75rem",
                    backgroundColor: "var(--bg-surface)",
                    borderRadius: "var(--radius-md)",
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "1rem",
                  }}
                >
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">
                      Max Total Cumulative Workers
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={maxTotalWorkers}
                      onChange={(e) =>
                        setMaxTotalWorkers(Number(e.target.value))
                      }
                      className="form-input"
                    />
                  </div>
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">
                      Budget Account ID (optional)
                    </label>
                    <input
                      type="text"
                      value={budgetAccountId}
                      onChange={(e) => setBudgetAccountId(e.target.value)}
                      placeholder="acct:team-engineering"
                      className="form-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Step 5: Acceptance Evidence */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <FileCheck2 size={16} color="var(--accent-blue)" />
                <h2 className="card-title">
                  5. Acceptance Evidence (Optional Run Metadata)
                </h2>
              </div>
            </div>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--text-secondary)",
                marginBottom: "1rem",
              }}
            >
              Evidence commands are injected into the Verifier context for
              verification auditing (never executed automatically by the
              orchestrator).
            </p>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "1rem",
              }}
            >
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Test Command</label>
                <input
                  type="text"
                  value={testCommand}
                  onChange={(e) => setTestCommand(e.target.value)}
                  className="form-input"
                  placeholder="pnpm test"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Build Command</label>
                <input
                  type="text"
                  value={buildCommand}
                  onChange={(e) => setBuildCommand(e.target.value)}
                  className="form-input"
                  placeholder="pnpm build"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Lint Command</label>
                <input
                  type="text"
                  value={lintCommand}
                  onChange={(e) => setLintCommand(e.target.value)}
                  className="form-input"
                  placeholder="pnpm lint"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Typecheck Command</label>
                <input
                  type="text"
                  value={typecheckCommand}
                  onChange={(e) => setTypecheckCommand(e.target.value)}
                  className="form-input"
                  placeholder="pnpm typecheck"
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  Required Artifacts (comma separated)
                </label>
                <input
                  type="text"
                  value={requiredArtifacts}
                  onChange={(e) => setRequiredArtifacts(e.target.value)}
                  className="form-input"
                  placeholder="dist/index.js, coverage/lcov.info"
                />
              </div>
            </div>
          </div>

          {/* Review: exact frozen targets */}
          <div className="card">
            <div className="card-header">
              <div
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <Shield size={16} color="var(--accent-blue)" />
                <h2 className="card-title">6. Review — Exact Frozen Targets</h2>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                fontSize: "0.85rem",
              }}
            >
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <span style={{ color: "var(--text-secondary)", width: "90px" }}>
                  Planner
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {plannerSelection.kind === "connection"
                    ? `${plannerSelection.name} · ${plannerTarget?.modelId ?? "Runtime default"}`
                    : `agent:${plannerSelection.name}`}
                </span>
              </div>
              {workerTargets.map((target, idx) => (
                <div
                  key={`review-${target.connectionId}-${idx}`}
                  style={{ display: "flex", gap: "0.75rem" }}
                >
                  <span
                    style={{ color: "var(--text-secondary)", width: "90px" }}
                  >
                    {idx === 0 ? "Workers" : ""}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    ✓ {target.connectionId} ·{" "}
                    {target.modelId ?? "Runtime default"}
                  </span>
                </div>
              ))}
              {workerAgents.trim()
                ? workerAgents
                    .split(",")
                    .map((name) => name.trim())
                    .filter(Boolean)
                    .map((name) => (
                      <div
                        key={`review-agent-${name}`}
                        style={{ display: "flex", gap: "0.75rem" }}
                      >
                        <span
                          style={{
                            color: "var(--text-secondary)",
                            width: "90px",
                          }}
                        >
                          {""}
                        </span>
                        <span style={{ fontFamily: "var(--font-mono)" }}>
                          agent:{name}
                        </span>
                      </div>
                    ))
                : null}
              <div style={{ display: "flex", gap: "0.75rem" }}>
                <span style={{ color: "var(--text-secondary)", width: "90px" }}>
                  Verifier
                </span>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {verifierSelection.kind === "connection"
                    ? `${verifierSelection.name} · ${verifierTarget?.modelId ?? "Runtime default"}`
                    : `agent:${verifierSelection.name}`}
                </span>
              </div>
            </div>
          </div>

          {/* Launch Action */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "1rem 0",
            }}
          >
            <Link href="/dashboard" className="btn btn-secondary">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting || !goal.trim()}
              className="btn btn-primary"
              style={{ padding: "0.75rem 2rem", fontSize: "0.95rem" }}
            >
              <PlayCircle size={18} />
              <span>
                {submitting ? "Starting Team Run…" : "Start Team Run"}
              </span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function NewTeamRunPage() {
  return (
    <Suspense fallback={<LoadingSpinner text="Loading run setup…" />}>
      <NewTeamRunContent />
    </Suspense>
  );
}
