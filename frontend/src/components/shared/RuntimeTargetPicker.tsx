"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, AlertTriangle, Zap } from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import {
  parseProviderDiscovery,
  parseRuntimeModelsRefresh,
  parseTestTargetEvidence,
  parseWorkbenchCommandResult,
  pickerReadiness,
  selectableProviders,
  providerStateKey,
} from "../../lib/tenvyr-api/guards.ts";
import type {
  ModelCatalogEntryV1,
  ProviderDiscoveryV1,
  RuntimeTargetV1,
  TestTargetEvidenceV1,
  WorkbenchConnectionCardV1,
} from "../../lib/tenvyr-api/types.ts";

/**
 * P2 closure round 2: Runtime Target picker — Runtime -> Provider -> Model.
 *
 * Everything is CONNECTION-SCOPED: providers/models come from the SELECTED
 * connection's current revision (never a global PATH lookup, never another
 * connection's state). A provider is selectable IFF the runtime reports it
 * AUTHENTICATED (catalog visibility never equals execution compatibility).
 * [Test Target] runs a SMALL BOUNDED REAL INVOCATION through the actual
 * runtime adapter with a credit warning. A refresh never silently changes
 * a frozen target; an unavailable target is flagged, never auto-replaced.
 */

export type RuntimeTargetPickerProps = {
  connections: WorkbenchConnectionCardV1[];
  value: RuntimeTargetV1 | null;
  onChange: (target: RuntimeTargetV1 | null) => void;
  disabled?: boolean;
  placeholder?: string;
};

const MODEL_LIMIT = 4000;

export function RuntimeTargetPicker({
  connections,
  value,
  onChange,
  disabled = false,
  placeholder = "Select runtime…",
}: RuntimeTargetPickerProps) {
  const [discovery, setDiscovery] = useState<ProviderDiscoveryV1 | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalogEntryV1[] | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogAt, setCatalogAt] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [manualModel, setManualModel] = useState("");
  const [testing, setTesting] = useState(false);
  const [testEvidence, setTestEvidence] = useState<TestTargetEvidenceV1 | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const selectedConnection = useMemo(
    () => connections.find((c) => c.connectionId === value?.connectionId) ?? null,
    [connections, value],
  );

  const runtimeKind = selectedConnection?.runtimeKind ?? "";
  // Structured provider discovery exists for OpenCode (server API);
  // Codex best-effort models; Claude/generic: manual entry only.
  const providerDiscoverySupported = runtimeKind === "opencode";
  const modelDiscoverySupported = runtimeKind === "opencode" || runtimeKind === "codex";

  const loadProviders = useCallback(async (connectionId: string) => {
    setLoading(true);
    setCatalogError(null);
    try {
      const res = await tenvyrApi.discoverRuntimeProviders(connectionId);
      if (!res.success) {
        setCatalogError(res.error || "Provider discovery failed");
        setDiscovery(null);
        return;
      }
      setDiscovery(parseProviderDiscovery(res.data));
    } catch (err: unknown) {
      setCatalogError(err instanceof Error ? err.message : String(err));
      setDiscovery(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadModels = useCallback(
    async (connectionId: string, providerId?: string) => {
      setLoading(true);
      setCatalogError(null);
      try {
        const res = await tenvyrApi.refreshRuntimeModels(connectionId, providerId);
        if (!res.success) {
          setCatalogError(res.error || "Model refresh failed");
          setCatalog(null);
          return;
        }
        const parsed = parseRuntimeModelsRefresh(res.data);
        setCatalog(parsed.catalog.models ?? []);
        setCatalogAt(parsed.catalog.discoveredAt ?? null);
      } catch (err: unknown) {
        setCatalogError(err instanceof Error ? err.message : String(err));
        setCatalog(null);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setSearch("");
    setManualMode(false);
    setSelectedProvider(null);
    setTestEvidence(null);
    setTestError(null);
    if (selectedConnection) {
      if (providerDiscoverySupported) {
        loadProviders(selectedConnection.connectionId);
      } else {
        setDiscovery(null);
      }
      if (modelDiscoverySupported) {
        loadModels(selectedConnection.connectionId);
      } else {
        setCatalog(null);
        setCatalogAt(null);
      }
    } else {
      setDiscovery(null);
      setCatalog(null);
      setCatalogAt(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.connectionId, selectedConnection?.connectionId]);

  // Connected-only: unauthenticated providers are visible in setup but are
  // NEVER selectable as executable targets.
  const selectable = useMemo(
    () => selectableProviders(discovery),
    [discovery],
  );
  const unauthenticated = useMemo(
    () => (discovery ? discovery.providers.filter((p) => !p.authenticated) : []),
    [discovery],
  );

  /** Models scoped to the selected provider — and ONLY to providers the
   *  runtime reports AUTHENTICATED. Models from unauthenticated providers
   *  never appear as selectable options. */
  const scopedModels = useMemo(() => {
    if (!catalog) return [];
    if (selectable.length > 0) {
      const connectedIds = new Set(selectable.map((p) => p.providerId));
      const filtered = catalog.filter(
        (entry) => entry.providerId === undefined || connectedIds.has(entry.providerId),
      );
      if (selectedProvider) {
        return filtered.filter((entry) => entry.providerId === selectedProvider);
      }
      return filtered;
    }
    // No structured providers (codex best-effort): show the whole catalog.
    return selectedProvider
      ? catalog.filter((entry) => entry.providerId === selectedProvider)
      : catalog;
  }, [catalog, selectable, selectedProvider]);

  const models = useMemo(() => {
    if (!scopedModels) return [];
    const needle = search.trim().toLowerCase();
    const list = needle
      ? scopedModels.filter(
          (entry) =>
            entry.modelId.toLowerCase().includes(needle) ||
            (entry.providerId ?? "").toLowerCase().includes(needle),
        )
      : scopedModels;
    return list.slice(0, MODEL_LIMIT);
  }, [scopedModels, search]);

  const modelOptions = useMemo(() => {
    const groups = new Map<string, ModelCatalogEntryV1[]>();
    for (const entry of models) {
      const group = entry.providerId ?? "Other";
      const bucket = groups.get(group) ?? [];
      bucket.push(entry);
      groups.set(group, bucket);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [models]);

  const handleConnectionChange = (connectionId: string) => {
    const connection = connections.find((c) => c.connectionId === connectionId);
    if (!connection) {
      onChange(null);
      return;
    }
    // Keep the previous model ONLY when it still belongs to the SAME
    // connection (never silently pick a different model).
    const keepModel =
      value?.connectionId === connectionId ? value.modelId : undefined;
    onChange({ connectionId, ...(keepModel ? { modelId: keepModel } : {}) });
  };

  const selectModel = (modelId: string | undefined) => {
    if (!selectedConnection) return;
    setTestEvidence(null);
    setTestError(null);
    onChange({
      connectionId: selectedConnection.connectionId,
      ...(modelId ? { modelId } : {}),
    });
  };

  const currentModelId = value?.modelId;
  const currentModelUnavailable =
    currentModelId !== undefined &&
    discovery !== null &&
    selectable.length > 0 &&
    !catalogHasCurrent();

  function catalogHasCurrent(): boolean {
    if (manualMode) return true;
    if (!catalog) return true;
    return catalog.some((entry) => entry.modelId === currentModelId);
  }

  const stale =
    catalogAt !== null &&
    Date.now() - Date.parse(catalogAt) > 5 * 60 * 1000 &&
    catalog !== null &&
    catalog.length > 0;

  const impliedProvider =
    runtimeKind === "codex"
      ? "OpenAI"
      : runtimeKind === "claude"
        ? "Anthropic"
        : null;

  /** Manual entry never bypasses connection/provider authorization: for
   *  runtimes with authoritative provider discovery (opencode), the manual
   *  provider/model target must reference a provider AUTHENTICATED through
   *  this exact connection. */
  const manualModelIsAllowed = (): boolean => {
    const modelId = manualModel.trim();
    if (!modelId) return false;
    if (providerDiscoverySupported && selectable.length > 0) {
      const providerId = modelId.includes("/") ? modelId.split("/")[0] : null;
      if (!providerId) return false;
      return selectable.some((p) => p.providerId === providerId);
    }
    // No authoritative provider discovery (codex/claude/generic): manual
    // entry remains available; the backend still authorizes the target.
    return true;
  };

  /** Audited Test Runtime Target: a SMALL BOUNDED REAL INVOCATION through
   *  the selected connection + model. May consume provider credits. */
  const handleTestTarget = async () => {
    if (!selectedConnection || !currentModelId) return;
    if (
      !window.confirm(
        "Test Runtime Target will run a REAL invocation through this runtime and model. This test may consume provider credits/tokens. Continue?",
      )
    ) {
      return;
    }
    setTesting(true);
    setTestError(null);
    setTestEvidence(null);
    try {
      const res = await tenvyrApi.testRuntimeTarget(
        selectedConnection.connectionId,
        currentModelId,
      );
      const command = parseWorkbenchCommandResult<{ evidence: TestTargetEvidenceV1 }>(
        res.data,
      );
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setTestEvidence(parseTestTargetEvidence(command.result?.evidence));
      } else {
        setTestError(command.error?.message || "Test target failed");
      }
    } catch (err: unknown) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {/* Runtime select */}
      <select
        value={value?.connectionId ?? ""}
        onChange={(e) => handleConnectionChange(e.target.value)}
        disabled={disabled}
        className="form-select"
        aria-label="Runtime"
      >
        <option value="">{placeholder}</option>
        {connections.map((c) => {
          // Post-PP1 hardening: truthful entries — unavailable connections
          // are disabled with their reason; DEGRADED selectable but warned.
          const readiness = pickerReadiness(c);
          return (
            <option key={c.connectionId} value={c.connectionId} disabled={!readiness.selectable}>
              {c.name} ({c.runtimeKind})
              {readiness.selectable && readiness.reason ? ` — ⚠ ${readiness.reason}` : ""}
              {!readiness.selectable && readiness.reason ? ` — ${readiness.reason}` : ""}
            </option>
          );
        })}
      </select>

      {selectedConnection ? (
        <>
          {/* Provider select — connected providers are selectable;
          unauthenticated ones are visible but DISABLED (never executable
          targets). */}
          {providerDiscoverySupported ? (
            <select
              value={selectedProvider ?? ""}
              onChange={(e) => setSelectedProvider(e.target.value || null)}
              disabled={disabled}
              className="form-select"
              aria-label="Provider"
            >
              <option value="">
                {selectable.length > 0
                  ? `Provider: all connected (${selectable.length})`
                  : "Provider: none connected"}
              </option>
              {selectable.map((provider) => (
                <option key={providerStateKey(selectedConnection.connectionId, provider.providerId)} value={provider.providerId}>
                  {provider.providerId} · Connected
                </option>
              ))}
              {unauthenticated.map((provider) => (
                <option
                  key={providerStateKey(selectedConnection.connectionId, provider.providerId)}
                  value={provider.providerId}
                  disabled
                >
                  {provider.providerId} · Not connected (connect on Runtimes)
                </option>
              ))}
            </select>
          ) : impliedProvider ? (
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Provider: <span style={{ fontWeight: 600 }}>{impliedProvider}</span>
            </div>
          ) : null}

          {/* Model select */}
          {modelDiscoverySupported ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <Search size={12} style={{ color: "var(--text-muted)" }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="form-input"
                  placeholder="Search models…"
                  style={{ flex: 1, padding: "0.3rem 0.5rem", fontSize: "0.8rem" }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    selectedConnection &&
                    loadModels(selectedConnection.connectionId, selectedProvider ?? undefined)
                  }
                  disabled={loading || disabled}
                  title="Refresh model catalog"
                >
                  <RefreshCw size={12} style={{ animation: loading ? "spin 1s linear infinite" : "none" }} />
                  <span>Refresh</span>
                </button>
              </div>

              {stale && !loading && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.72rem", color: "var(--accent-amber)" }}>
                  <AlertTriangle size={11} />
                  <span>Stale catalog (fetched {new Date(catalogAt!).toLocaleTimeString()}) — refresh for the latest models.</span>
                </div>
              )}
              {catalogError && (
                <div style={{ fontSize: "0.72rem", color: "var(--accent-red)" }}>{catalogError}</div>
              )}

              {loading ? (
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>Loading providers & models…</div>
              ) : selectable.length === 0 && providerDiscoverySupported ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.35rem",
                    fontSize: "0.75rem",
                    color: "var(--accent-amber)",
                  }}
                >
                  <div>
                    No providers connected through this runtime. Zero authenticated
                    providers means NO explicit provider/model target can launch —
                    connect a provider on the Runtimes page first. Only &quot;Runtime
                    default&quot; (no model argument) is available.
                  </div>
                </div>
              ) : catalog && catalog.length > 0 ? (
                <>
                  <select
                    value={currentModelId ?? "__default__"}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "__default__") selectModel(undefined);
                      else if (val === "__manual__") setManualMode(true);
                      else selectModel(val);
                    }}
                    disabled={disabled}
                    className="form-select"
                    aria-label="Model"
                  >
                    <option value="__default__">Runtime default</option>
                    {modelOptions.map(([group, entries]: [string, ModelCatalogEntryV1[]]) => (
                      <optgroup key={group} label={group}>
                        {entries.map((entry) => (
                          <option key={entry.modelId} value={entry.modelId}>
                            {entry.modelId}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <option value="__manual__">+ Enter model ID manually…</option>
                  </select>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    No model catalog available for this connection.
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setManualMode(true)}
                    disabled={disabled}
                  >
                    Enter model ID manually
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              <select
                value={currentModelId ?? "__default__"}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "__default__") selectModel(undefined);
                  else if (val === "__manual__") setManualMode(true);
                  else selectModel(val);
                }}
                disabled={disabled}
                className="form-select"
                aria-label="Model"
              >
                <option value="__default__">Runtime default</option>
                <option value="__manual__">+ Enter model ID manually…</option>
              </select>
              <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                No dynamic discovery for this runtime — enter an official model ID manually.
              </div>
            </div>
          )}

          {manualMode && (
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input
                type="text"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                className="form-input"
                placeholder="e.g. claude-sonnet-5"
                style={{ flex: 1, padding: "0.3rem 0.5rem", fontSize: "0.8rem", fontFamily: "var(--font-mono)" }}
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!manualModel.trim() || disabled || !manualModelIsAllowed()}
                onClick={() => {
                  selectModel(manualModel.trim());
                  setManualMode(false);
                }}
              >
                Use
              </button>
            </div>
          )}

          {currentModelId !== undefined && currentModelUnavailable && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.72rem", color: "var(--accent-amber)" }}>
              <AlertTriangle size={11} />
              <span>
                The selected model &quot;{currentModelId}&quot; is no longer offered by a
                connected provider — the frozen selection is preserved (refresh never
                rewrites it); launch will be blocked until you change it.
              </span>
            </div>
          )}

          {/* Test Runtime Target: bounded REAL invocation, credit warning */}
          {currentModelId !== undefined && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleTestTarget}
                disabled={testing || disabled}
                style={{ justifyContent: "flex-start" }}
              >
                <Zap size={12} />
                <span>{testing ? "Testing…" : "Test Target"}</span>
              </button>
              {testEvidence && (
                <div
                  style={{
                    fontSize: "0.72rem",
                    fontFamily: "var(--font-mono)",
                    color:
                      testEvidence.status === "ok" ? "var(--accent-green)" : "var(--accent-red)",
                  }}
                >
                  Test Target: {testEvidence.status === "ok" ? "OK" : "FAILED"} · exit{" "}
                  {testEvidence.exitCode ?? "?"} · {testEvidence.durationMs}ms
                  {testEvidence.outputTruncated ? " · output truncated" : ""}
                </div>
              )}
              {testError && (
                <div style={{ fontSize: "0.72rem", color: "var(--accent-red)" }}>{testError}</div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
