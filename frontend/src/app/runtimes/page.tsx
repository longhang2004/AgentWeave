"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Check,
  Play,
  ExternalLink,
  Copy,
  LogIn,
  Database,
  Server,
  Trash2,
} from "lucide-react";
import { tenvyrApi } from "../../lib/tenvyr-api/client.ts";
import {
  MalformedResponseError,
  parseActiveAuthFlows,
  parseConnectionTestResult,
  parseOpenCodeAuthBegin,
  parseProviderAuthMethods,
  parseProviderDiscovery,
  parseWorkbenchCommandResult,
} from "../../lib/tenvyr-api/guards.ts";
import type {
  RuntimeKind,
  RuntimeOnboardingStatusV1,
  WorkbenchConnectionCardV1,
  ConnectionTemplateV1,
  ModelSourceV1,
  ModelCatalogSnapshotV1,
  ModelCatalogEntryV1,
  RuntimeProviderV1,
  OpenCodeAuthMethodV1,
  OpenCodeAuthBeginV1,
} from "../../lib/tenvyr-api/types.ts";
import { StatusBadge } from "../../components/shared/StatusBadge.tsx";
import { LoadingSpinner } from "../../components/shared/LoadingSpinner.tsx";
import { DirectoryInput } from "../../components/shared/DirectoryInput.tsx";

const ONBOARDING_KINDS: Array<{
  kind: RuntimeKind;
  title: string;
  desc: string;
}> = [
  {
    kind: "codex",
    title: "Codex CLI",
    desc: "OpenAI Codex CLI runtime template. Version-pinned execution.",
  },
  {
    kind: "claude",
    title: "Claude Code",
    desc: "Anthropic Claude Code CLI runtime. Requires runtime-owned login.",
  },
  {
    kind: "opencode",
    title: "OpenCode",
    desc: "OpenCode CLI runtime with multi-provider model integration.",
  },
];

export default function RuntimesPage() {
  const [tab, setTab] = useState<"runtimes" | "sources">("runtimes");
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [onboardingStatuses, setOnboardingStatuses] = useState<
    Record<string, RuntimeOnboardingStatusV1>
  >({});
  const [connections, setConnections] = useState<WorkbenchConnectionCardV1[]>(
    [],
  );
  const [templates, setTemplates] = useState<ConnectionTemplateV1[]>([]);
  const [connectingKind, setConnectingKind] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info" | "warning";
    message: string;
  } | null>(null);

  // P2: Model Sources tab state
  const [sources, setSources] = useState<ModelSourceV1[]>([]);
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const [refreshingSourceId, setRefreshingSourceId] = useState<string | null>(
    null,
  );
  const [showAddSource, setShowAddSource] = useState<boolean>(false);
  const [srcName, setSrcName] = useState<string>("OpenAI-compatible endpoint");
  const [srcBaseUrl, setSrcBaseUrl] = useState<string>("https://example.com/v1");
  const [srcCredentialRef, setSrcCredentialRef] = useState<string>("");
  const [savingSource, setSavingSource] = useState<boolean>(false);
  // P2 closure round 2: runtime-owned provider projections PER CONNECTION
  // (never keyed by runtimeKind or providerId alone — two same-kind
  // connections must never share provider state).
  const [providersByConnection, setProvidersByConnection] = useState<
    Record<string, RuntimeProviderV1[]>
  >({});
  // Guided sign-in state per runtime kind
  const [signInKind, setSignInKind] = useState<string | null>(null);
  const [copiedKind, setCopiedKind] = useState<string | null>(null);
  // P2 closure round 2: per-provider state keyed by `connectionId::providerId`
  // — the same providerId on two connections keeps INDEPENDENT state.
  const [providerCatalog, setProviderCatalog] = useState<
    Record<string, ModelCatalogEntryV1[]>
  >({});
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  // OAuth connect flow per connection::provider — the SELECTED auth method
  // travels by its stable method index; the flow keeps ONE live management
  // session from begin to complete/cancel.
  const [connectFlow, setConnectFlow] = useState<{
    connectionId: string;
    providerId: string;
    step: "choose" | "begin" | "completed";
    error: string | null;
    authMethods: OpenCodeAuthMethodV1[];
    loading: boolean;
    selectedMethodIndex: number | null;
    authFlowId: string | null;
    url: string | null;
    method: "auto" | "code" | null;
    instructions: string | null;
    codeInput: string;
  } | null>(null);
  // Resume guard: loadData must never clobber an in-flight connect flow.
  const connectFlowRef = useRef(connectFlow);
  useEffect(() => {
    connectFlowRef.current = connectFlow;
  }, [connectFlow]);

  // Advanced Connection Form state
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [editingConnId, setEditingConnId] = useState<string | null>(null);
  const [advConnectionId, setAdvConnectionId] = useState<string>("conn:custom");
  const [advName, setAdvName] = useState<string>("Custom CLI");
  const [advKind, setAdvKind] = useState<string>("generic-cli");
  const [advCommand, setAdvCommand] = useState<string>("");
  const [advArgs, setAdvArgs] = useState<string>("");
  const [advCwd, setAdvCwd] = useState<string>("");
  const [advSecrets, setAdvSecrets] = useState<string>("");
  const [advProbeArgs, setAdvProbeArgs] = useState<string>("--version");
  const [savingAdv, setSavingAdv] = useState<boolean>(false);

  const loadData = useCallback(async () => {
    try {
      const [connRes, templRes, srcRes] = await Promise.allSettled([
        tenvyrApi.getWorkbenchConnections(),
        tenvyrApi.getConnectionTemplates(),
        tenvyrApi.getModelSources(),
      ]);

      if (connRes.status === "fulfilled") {
        setConnections(connRes.value?.cards ?? []);
      }
      if (templRes.status === "fulfilled" && templRes.value?.success) {
        setTemplates(templRes.value?.data ?? []);
      }
      if (srcRes.status === "fulfilled" && srcRes.value?.success) {
        setSources(srcRes.value?.data ?? []);
      }

      const statuses: Record<string, RuntimeOnboardingStatusV1> = {};
      await Promise.all(
        ONBOARDING_KINDS.map(async ({ kind }) => {
          try {
            const res = await tenvyrApi.getRuntimeOnboarding(kind);
            if (res?.status) {
              statuses[kind] = res.status;
            }
          } catch {
            // best-effort
          }
        }),
      );
      setOnboardingStatuses(statuses);

      // P2 closure round 2: CONNECTION-scoped provider projections. The
      // backend resolves each connection's CURRENT revision — two
      // same-kind connections never share provider state.
      const providerMap: Record<string, RuntimeProviderV1[]> = {};
      const providerCards = connRes.status === "fulfilled" ? (connRes.value?.cards ?? []) : [];
      await Promise.all(
        providerCards
          .filter((card) => card.runtimeKind === "opencode")
          .map(async (card) => {
            try {
              const res = await tenvyrApi.discoverRuntimeProviders(card.connectionId);
              if (res.success) {
                providerMap[card.connectionId] =
                  parseProviderDiscovery(res.data).providers;
              }
            } catch {
              // best-effort — the card still renders without providers
            }
          }),
      );
      setProvidersByConnection(providerMap);

      // Post-PP1 hardening: browser-reload resume. For any opencode
      // connection with an ACTIVE UNEXPIRED auth flow, restore the connect
      // panel with the SAME authFlowId/URL/instructions from the retained
      // session — Complete/Cancel continue through that exact session.
      // An expired flow returns nothing here; the operator starts fresh.
      if (!connectFlowRef.current) {
        for (const card of providerCards.filter((c) => c.runtimeKind === "opencode")) {
          try {
            const res = await tenvyrApi.getActiveAuthFlows(card.connectionId);
            if (!res.success) continue;
            const flows = parseActiveAuthFlows(res.data);
            const active = flows[0];
            if (active) {
              setConnectFlow({
                connectionId: active.connectionId,
                providerId: active.providerId,
                step: "begin",
                error: null,
                authMethods: [],
                loading: false,
                selectedMethodIndex: active.methodIndex,
                authFlowId: active.authFlowId,
                url: active.url,
                method: active.authorizationMethod,
                instructions: active.instructions,
                codeInput: "",
              });
              break;
            }
          } catch {
            // best-effort resume
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to load runtimes data",
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleConnect = async (kind: RuntimeKind) => {
    setConnectingKind(kind);
    setNotice(null);
    try {
      const res = await tenvyrApi.onboardRuntime(kind);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ connectionId: string }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: `Runtime "${kind}" connected successfully (${command.result?.connectionId ?? `conn:${kind}`}).`,
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message:
            command.error?.message ||
            `Failed to connect runtime: ${JSON.stringify(command)}`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Connection failed" });
    } finally {
      setConnectingKind(null);
    }
  };

  const handleTest = async (connectionId: string) => {
    setTestingId(connectionId);
    setNotice(null);
    try {
      const res = await tenvyrApi.testConnection(connectionId);
      if (!res.success) {
        setNotice({
          type: "error",
          message: res.error || `Connection test failed for "${connectionId}"`,
        });
        return;
      }
      // The receipt is nested under the Workbench command result
      // (data.result.receipt). Server state is authoritative and is NEVER
      // defaulted to a fabricated readiness literal: a missing or malformed
      // receipt renders as an error.
      const result = parseConnectionTestResult(res.data);
      const receipt = result.result.receipt;
      const versionStr = receipt.testedVersion
        ? ` (v${receipt.testedVersion})`
        : "";
      const supersededStr = receipt.superseded
        ? " — superseded by a newer revision"
        : "";
      const noticeType =
        receipt.state === "AVAILABLE"
          ? "success"
          : receipt.state === "AUTH_REQUIRED" || receipt.state === "DEGRADED"
            ? "warning"
            : "error";
      setNotice({
        type: noticeType,
        message: `Connection "${connectionId}" test result: ${receipt.state}${versionStr}${supersededStr}`,
      });
      await loadData();
    } catch (err: unknown) {
      if (err instanceof MalformedResponseError) {
        setNotice({ type: "error", message: err.message });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setNotice({ type: "error", message: message || "Test request failed" });
      }
    } finally {
      setTestingId(null);
    }
  };
  const handleRevoke = async (connectionId: string) => {
    if (
      !window.confirm(
        `Revoke connection "${connectionId}"? Revocation is terminal and prevents future execution claims.`,
      )
    ) {
      return;
    }
    try {
      const res = await tenvyrApi.revokeConnection(connectionId);
      if (res.success) {
        setNotice({
          type: "info",
          message: `Connection "${connectionId}" revoked.`,
        });
        await loadData();
      } else {
        setNotice({ type: "error", message: res.error || "Revocation failed" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Revocation failed" });
    }
  };

  const handleSaveAdvanced = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAdv(true);
    setNotice(null);

    const splitList = (val: string) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

    try {
      let profile: Record<string, unknown>;
      if (advKind === "generic-cli") {
        const secrets = splitList(advSecrets);
        profile = {
          name: advName.trim(),
          executorId: "local-host",
          runtimeKind: "generic-cli",
          version: "0.1.0",
          credentialRefs: secrets.map((name) => ({ kind: "env", name })),
          declaredCapabilities: {
            invocation: { supported: true, source: "configured" },
            structuredResult: { supported: true, source: "configured" },
            localProcessTermination: { supported: true, source: "configured" },
          },
          cli: {
            command: advCommand.trim(),
            args: splitList(advArgs),
            ...(advCwd.trim() ? { cwd: advCwd.trim() } : {}),
            ...(secrets.length
              ? { secrets: Object.fromEntries(secrets.map((n) => [n, n])) }
              : {}),
            probe: { args: splitList(advProbeArgs), expectsVersion: true },
          },
        };
      } else {
        const template = templates.find((t) => t.runtimeKind === advKind);
        if (!template) throw new Error(`Unknown runtime template "${advKind}"`);
        profile = {
          name: advName.trim(),
          executorId: "local-host",
          runtimeKind: advKind,
          version: template.pinnedVersion,
          credentialRefs: template.credentialEnvRefs.map((name) => ({
            kind: "env",
            name,
          })),
          declaredCapabilities: template.declaredCapabilities,
          cli: {
            command: advCommand.trim(),
            args: template.runArgs,
            probe: template.probe,
            ...(template.authProbe ? { authProbe: template.authProbe } : {}),
          },
        };
      }

      if (editingConnId) {
        await tenvyrApi.reviseConnection(editingConnId, profile);
        setNotice({
          type: "success",
          message: `Connection "${editingConnId}" revision saved.`,
        });
      } else {
        await tenvyrApi.createConnection(advConnectionId.trim(), profile);
        setNotice({
          type: "success",
          message: `Connection "${advConnectionId}" created.`,
        });
      }

      setEditingConnId(null);
      setShowAdvanced(false);
      await loadData();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to save connection",
      });
    } finally {
      setSavingAdv(false);
    }
  };

  const openReviseForm = (card: WorkbenchConnectionCardV1) => {
    setEditingConnId(card.connectionId);
    setAdvConnectionId(card.connectionId);
    setAdvName(card.name);
    setAdvKind(card.runtimeKind);
    setAdvCommand("");
    setShowAdvanced(true);
  };

  // P2: Model Source actions

  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSource(true);
    setNotice(null);
    try {
      // P2 closure: the advanced catalog surface is the generic
      // OpenAI-compatible endpoint only. Provider state is runtime-owned
      // (OpenCode CLI discovery) — never a standalone source row, and
      // 9Router is not a Tenvyr product kind.
      const source: Record<string, unknown> = {
        sourceId: `src:${
          srcName
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_.:-]+/g, "-") || "source"
        }`,
        kind: "openai-compatible",
        displayName: srcName.trim(),
        baseUrl: srcBaseUrl.trim(),
      };
      if (srcCredentialRef.trim()) {
        source.credentialEnvRef = srcCredentialRef.trim();
      }
      const res = await tenvyrApi.createModelSource(source);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "success",
          message: `Catalog endpoint "${String(source.sourceId)}" created.`,
        });
        setShowAddSource(false);
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Failed to create catalog endpoint",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Failed to create model source",
      });
    } finally {
      setSavingSource(false);
    }
  };

  const handleTestSource = async (sourceId: string) => {
    setTestingSourceId(sourceId);
    setNotice(null);
    try {
      const res = await tenvyrApi.testModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const source = command.result?.source;
        const count = source?.modelCount
          ? ` (${source.modelCount} models)`
          : "";
        setNotice({
          type: source?.status === "AVAILABLE" ? "success" : "warning",
          message: `Catalog endpoint "${sourceId}" test result: ${source?.status ?? "UNKNOWN"}${count}`,
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || `Endpoint test failed for "${sourceId}"`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Source test request failed",
      });
    } finally {
      setTestingSourceId(null);
    }
  };

  const handleRefreshSource = async (sourceId: string) => {
    setRefreshingSourceId(sourceId);
    setNotice(null);
    try {
      const res = await tenvyrApi.refreshModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult<{ source: ModelSourceV1; catalog: ModelCatalogSnapshotV1 }>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const catalog = command.result?.catalog;
        setNotice({
          type: "success",
          message: `Catalog refreshed for "${sourceId}": ${catalog?.models?.length ?? 0} models${catalog?.truncated ? " (truncated at bound)" : ""}.`,
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || `Refresh failed for "${sourceId}"`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({
        type: "error",
        message: message || "Refresh request failed",
      });
    } finally {
      setRefreshingSourceId(null);
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    if (
      !window.confirm(
        `Delete model source "${sourceId}"? This removes the operator configuration (catalogs are never stored).`,
      )
    ) {
      return;
    }
    try {
      const res = await tenvyrApi.deleteModelSource(sourceId);
      // P2 closure: the command envelope is nested under res.data.
      const command = parseWorkbenchCommandResult(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setNotice({
          type: "info",
          message: `Model source "${sourceId}" deleted.`,
        });
        await loadData();
      } else {
        setNotice({
          type: "error",
          message: command.error?.message || "Delete failed",
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Delete request failed" });
    }
  };

  const handleCopyLogin = async (command: string, kind: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedKind(kind);
      setTimeout(() => setCopiedKind(null), 2000);
    } catch {
      setNotice({ type: "info", message: `Run in your terminal: ${command}` });
    }
  };

  /** Key per-connection::provider state identity. */
  const providerKey = (connectionId: string, providerId: string): string =>
    `${connectionId}::${providerId}`;

  /** Per-provider [Models]: model enumeration for THIS connection/provider
   *  (documented CLI through the exact connection profile). */
  const handleProviderModels = async (
    connectionId: string,
    providerId: string,
  ) => {
    const key = providerKey(connectionId, providerId);
    if (expandedProvider === key) {
      setExpandedProvider(null);
      return;
    }
    if (!providerCatalog[key]) {
      try {
        const res = await tenvyrApi.refreshRuntimeModels(connectionId, providerId);
        const models = res.success ? (res.data?.catalog?.models ?? []) : [];
        setProviderCatalog((current) => ({ ...current, [key]: models }));
      } catch {
        setProviderCatalog((current) => ({ ...current, [key]: [] }));
      }
    }
    setExpandedProvider(key);
  };

  /** Check Authentication: structured runtime/provider state — answers
   *  ONLY "is this provider connected per the runtime?". Never claims
   *  inference usability. */
  const handleCheckAuth = async (connectionId: string) => {
    setTestingProvider(providerKey(connectionId, "*"));
    setNotice(null);
    try {
      const res = await tenvyrApi.discoverRuntimeProviders(connectionId);
      if (res.success) {
        const discovery = parseProviderDiscovery(res.data);
        const connected = discovery.providers.filter((p) => p.authenticated);
        setProvidersByConnection((current) => ({
          ...current,
          [connectionId]: discovery.providers,
        }));
        setNotice({
          type: connected.length > 0 ? "success" : "warning",
          message:
            connected.length > 0
              ? `Authentication: ${connected.map((p) => p.providerId).join(", ")} connected through ${connectionId}.`
              : `Authentication: no providers connected through ${connectionId}.`,
        });
      } else {
        setNotice({ type: "error", message: res.error || "Auth check failed" });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Auth check failed" });
    } finally {
      setTestingProvider(null);
    }
  };

  /** Refresh Models: enumerate models for THIS connection/provider. */
  const handleRefreshProviderModels = async (
    connectionId: string,
    providerId: string,
  ) => {
    setTestingProvider(providerKey(connectionId, providerId));
    setNotice(null);
    try {
      const res = await tenvyrApi.refreshRuntimeModels(connectionId, providerId);
      const count = res.success ? (res.data?.catalog?.models?.length ?? 0) : 0;
      setNotice({
        type: res.success ? "success" : "error",
        message: res.success
          ? `Provider "${providerId}" through ${connectionId}: ${count} models enumerated.`
          : res.error || "Model refresh failed",
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setNotice({ type: "error", message: message || "Model refresh failed" });
    } finally {
      setTestingProvider(null);
    }
  };

  /** Connect Provider: runtime-owned flow. OAuth providers use the official
   *  Server API (authorize -> operator completes in the provider's own UI
   *  -> callback). API-key methods stay runtime-owned: guided official
   *  command only (Tenvyr never receives raw keys). */
  const handleConnectProvider = async (connectionId: string, providerId: string) => {
    setConnectFlow({
      connectionId,
      providerId,
      step: "choose",
      error: null,
      authMethods: [],
      loading: true,
      selectedMethodIndex: null,
      authFlowId: null,
      url: null,
      method: null,
      instructions: null,
      codeInput: "",
    });
    try {
      const res = await tenvyrApi.getRuntimeProviderAuthMethods(connectionId, providerId);
      const methods = res.success ? parseProviderAuthMethods(res.data).methods : [];
      setConnectFlow((current) =>
        current ? { ...current, authMethods: methods, loading: false } : current,
      );
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Begin: start the flow with the SELECTED method index AND its expected
   *  fingerprint (type + label) from the snapshot the operator actually
   *  saw — a reordered/changed fresh snapshot fails closed server-side.
   *  One live session retained. */
  const handleOauthBegin = async (connectionId: string, providerId: string) => {
    const flow = connectFlow;
    if (!flow || flow.selectedMethodIndex === null) return;
    const selectedMethod = flow.authMethods.find(
      (m) => m.methodIndex === flow.selectedMethodIndex,
    );
    setConnectFlow({ ...flow, step: "begin", error: null, loading: true });
    try {
      const res = await tenvyrApi.openCodeOauthBegin(
        connectionId,
        providerId,
        flow.selectedMethodIndex,
        selectedMethod ? { type: selectedMethod.type, label: selectedMethod.label } : undefined,
      );
      const command = parseWorkbenchCommandResult<OpenCodeAuthBeginV1>(res.data);
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        const begun = parseOpenCodeAuthBegin(command.result);
        setConnectFlow((current) =>
          current
            ? {
                ...current,
                step: "begin",
                authFlowId: begun.authFlowId,
                url: begun.url,
                method: begun.method,
                instructions: begun.instructions,
                loading: false,
              }
            : current,
        );
      } else {
        setConnectFlow((current) =>
          current
            ? { ...current, loading: false, error: command.error?.message || "Authorization failed" }
            : current,
        );
      }
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Complete through the SAME live session; the bounded code (code flow)
   *  is sent once, never logged. */
  const handleOauthComplete = async () => {
    const flow = connectFlow;
    if (!flow || !flow.authFlowId) return;
    setConnectFlow({ ...flow, loading: true, error: null });
    try {
      const res = await tenvyrApi.openCodeOauthComplete(
        flow.authFlowId,
        flow.method === "code" && flow.codeInput.trim() ? flow.codeInput.trim() : undefined,
      );
      const command = parseWorkbenchCommandResult<{ connected: boolean }>(res.data);
      const connected = command.result?.connected === true;
      if (command.outcome === "executed" || command.outcome === "duplicate") {
        setConnectFlow((current) =>
          current ? { ...current, loading: false, step: "completed" } : current,
        );
        setNotice({
          type: connected ? "success" : "warning",
          message: connected
            ? `Provider "${flow.providerId}" connected through ${flow.connectionId}.`
            : `Provider "${flow.providerId}" is still not connected according to ${flow.connectionId}.`,
        });
        // Refresh the connection's provider projection.
        const res2 = await tenvyrApi.discoverRuntimeProviders(flow.connectionId);
        if (res2.success) {
          const discovery = parseProviderDiscovery(res2.data);
          setProvidersByConnection((current) => ({
            ...current,
            [flow.connectionId]: discovery.providers,
          }));
        }
      } else {
        setConnectFlow((current) =>
          current
            ? {
                ...current,
                loading: false,
                error: command.error?.message || "OAuth completion failed",
              }
            : current,
        );
      }
    } catch (err: unknown) {
      setConnectFlow((current) =>
        current
          ? {
              ...current,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  /** Cancel: deterministic cleanup of the live management session. */
  const handleOauthCancel = async () => {
    const flow = connectFlow;
    if (!flow) return;
    if (flow.authFlowId) {
      try {
        await tenvyrApi.openCodeOauthCancel(flow.authFlowId);
      } catch {
        // best-effort cleanup
      }
    }
    setConnectFlow(null);
  };

  /** Key per-connection::provider state identity. */
  return (
    <div className="page-container">
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
            Runtimes
          </h1>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Agent runtimes own intelligence and authentication. Tenvyr owns
            execution supervision, bounds, and model selection authority.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="btn btn-secondary btn-sm"
          disabled={refreshing}
        >
          <RefreshCw
            size={14}
            style={{
              animation: refreshing ? "spin 1s linear infinite" : "none",
            }}
          />
          <span>Refresh</span>
        </button>
      </div>

      {/* Tabs: Agent Runtimes | Model Sources */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          margin: "1rem 0",
          borderBottom: "1px solid var(--border-color)",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => setTab("runtimes")}
          className={`btn btn-sm ${tab === "runtimes" ? "btn-primary" : "btn-secondary"}`}
        >
          <Server size={14} />
          <span>Agent Runtimes</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("sources")}
          className={`btn btn-sm ${tab === "sources" ? "btn-primary" : "btn-secondary"}`}
        >
          <Database size={14} />
          <span>Advanced Catalogs</span>
        </button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.type}`}>
          {notice.type === "success" ? (
            <CheckCircle2 size={16} />
          ) : notice.type === "error" ? (
            <XCircle size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <div>{notice.message}</div>
        </div>
      )}

      {tab === "sources" ? (
        /* ============ Model Sources tab ============ */
        <section aria-labelledby="sources-heading">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.75rem",
            }}
          >
            <div>
              <h2 id="sources-heading" style={{ fontSize: "1.1rem" }}>
                Advanced Catalogs
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                Generic OpenAI-compatible catalog endpoints (advanced operator
                surface). Provider state is runtime-owned — providers
                authenticated through a runtime appear under the runtime card.
                Catalogs are bounded on-demand projections — never stored,
                never execution authority.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowAddSource(!showAddSource)}
            >
              {showAddSource ? "Hide Form" : "+ Add Catalog Endpoint"}
            </button>
          </div>

          {showAddSource && (
            <form
              onSubmit={handleAddSource}
              style={{
                backgroundColor: "var(--bg-surface)",
                padding: "1.25rem",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-color)",
                marginBottom: "1.25rem",
                display: "flex",
                flexDirection: "column",
                gap: "1rem",
              }}
            >
              <h3 style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                Add Catalog Endpoint
              </h3>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                Generic OpenAI-compatible endpoint (kind is fixed). Provider
                state is runtime-owned — an existing 9Router instance is
                represented exactly like any other OpenAI-compatible endpoint.
              </p>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Display Name</label>
                <input
                  type="text"
                  value={srcName}
                  onChange={(e) => setSrcName(e.target.value)}
                  required
                  className="form-input"
                />
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "1rem",
                }}
              >
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    Base URL (http/https, no credentials in URL)
                  </label>
                  <input
                    type="text"
                    value={srcBaseUrl}
                    onChange={(e) => setSrcBaseUrl(e.target.value)}
                    required
                    className="form-input"
                    placeholder="https://example.com/v1"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">
                    Credential Env Var Name (optional, name only)
                  </label>
                  <input
                    type="text"
                    value={srcCredentialRef}
                    onChange={(e) => setSrcCredentialRef(e.target.value)}
                    className="form-input"
                    placeholder="MY_API_KEY"
                  />
                  <p
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--text-muted)",
                      marginTop: "0.25rem",
                    }}
                  >
                    Only the NAME is stored; the value is resolved at request
                    time on the server.
                  </p>
                </div>
              </div>
              <p
                style={{
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                Catalogs are discovery projections only — a catalog entry
                never creates execution authority.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
                  onClick={() => setShowAddSource(false)}
                  className="btn btn-secondary btn-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingSource}
                  className="btn btn-primary btn-sm"
                >
                  {savingSource ? "Saving…" : "Create Source"}
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <LoadingSpinner text="Loading model sources…" />
          ) : sources.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "2rem 1rem",
                color: "var(--text-muted)",
              }}
            >
              No catalog endpoints configured. Add a generic
              OpenAI-compatible endpoint (advanced), or connect providers
              through the Agent Runtime cards.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                gap: "1.25rem",
              }}
            >
              {sources.map((source) => (
                <div
                  key={source.sourceId}
                  className="card"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                  }}
                >
                  <div
                    className="card-header"
                    style={{ marginBottom: 0, paddingBottom: "0.6rem" }}
                  >
                    <div>
                      <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
                        {source.displayName}
                      </h3>
                      <p
                        style={{
                          fontSize: "0.7rem",
                          color: "var(--text-muted)",
                          fontFamily: "var(--font-mono)",
                        }}
                      >
                        {source.sourceId} · {source.kind}
                      </p>
                    </div>
                    <StatusBadge status={source.status} />
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.35rem",
                      fontSize: "0.8rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Endpoint:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.baseUrl ?? "CLI catalog"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Credential ref:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.credentialEnvRef ?? "none"}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Models:
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                        }}
                      >
                        {source.modelCount ?? 0}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span style={{ color: "var(--text-secondary)" }}>
                        Last refreshed:
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)" }}>
                        {source.lastCatalogRefreshAt
                          ? `${Math.max(1, Math.round((Date.now() - Date.parse(source.lastCatalogRefreshAt)) / 60000))}m ago`
                          : "never"}
                      </span>
                    </div>
                    {source.reasonCode !== "none" && (
                      <div
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--accent-amber)",
                        }}
                      >
                        reason: {source.reasonCode}
                      </div>
                    )}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      marginTop: "auto",
                    }}
                  >
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleRefreshSource(source.sourceId)}
                      disabled={refreshingSourceId === source.sourceId}
                      style={{ flex: 1 }}
                    >
                      <RefreshCw
                        size={12}
                        style={{
                          animation:
                            refreshingSourceId === source.sourceId
                              ? "spin 1s linear infinite"
                              : "none",
                        }}
                      />
                      <span>
                        {refreshingSourceId === source.sourceId
                          ? "Refreshing…"
                          : "Refresh Models"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleTestSource(source.sourceId)}
                      disabled={testingSourceId === source.sourceId}
                    >
                      <Play size={12} />
                      <span>
                        {testingSourceId === source.sourceId
                          ? "Testing…"
                          : "Test Source"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDeleteSource(source.sourceId)}
                      aria-label={`Delete ${source.sourceId}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Guided Runtime Cards */}
          <section aria-labelledby="guided-heading">
            <div style={{ marginBottom: "0.75rem" }}>
              <h2 id="guided-heading" style={{ fontSize: "1.1rem" }}>
                Guided Runtimes
              </h2>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>
                Automatic CLI detection and verified templates. Authentication
                stays runtime-owned.
              </p>
            </div>

            {loading ? (
              <LoadingSpinner text="Probing runtimes…" />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                  gap: "1.25rem",
                }}
              >
                {ONBOARDING_KINDS.map(({ kind, title, desc }) => {
                  const status = onboardingStatuses[kind];
                  const conn = connections.find(
                    (c) => c.runtimeKind === kind && !c.revoked,
                  );
                  const isConnecting = connectingKind === kind;
                  const isTesting =
                    testingId === (conn?.connectionId || `conn:${kind}`);

                  return (
                    <div
                      key={kind}
                      className="card"
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1rem",
                      }}
                    >
                      <div
                        className="card-header"
                        style={{ marginBottom: 0, paddingBottom: "0.75rem" }}
                      >
                        <div>
                          <h3 style={{ fontSize: "1rem", fontWeight: 700 }}>
                            {title}
                          </h3>
                          <p
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--text-muted)",
                              marginTop: "0.15rem",
                            }}
                          >
                            {desc}
                          </p>
                        </div>
                        {conn ? (
                          <StatusBadge status={conn.status} />
                        ) : status?.detected ? (
                          status.authReady === false ? (
                            <span className="badge badge-warning">
                              Auth Required
                            </span>
                          ) : (
                            <span className="badge badge-neutral">
                              Detected
                            </span>
                          )
                        ) : (
                          <span className="badge badge-failed">Not Found</span>
                        )}
                      </div>

                      {/* Status checklist */}
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.4rem",
                          backgroundColor: "var(--bg-surface)",
                          padding: "0.75rem",
                          borderRadius: "var(--radius-md)",
                          fontSize: "0.8rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Installed:
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {status?.detected ? (
                              <span
                                style={{ color: "var(--accent-green)" }}
                                title={status.executable || undefined}
                              >
                                ✓ Yes
                              </span>
                            ) : (
                              <span style={{ color: "var(--accent-red)" }}>
                                ✕ Not on PATH
                              </span>
                            )}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Version:
                          </span>
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            {status?.version ||
                              (status?.pinnedVersion
                                ? `${status.pinnedVersion} (pinned)`
                                : "—")}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Authentication:
                          </span>
                          <span>
                            {status?.authReady === null ? (
                              <span style={{ color: "var(--text-muted)" }}>
                                Runtime-owned
                              </span>
                            ) : status?.authReady ? (
                              <span
                                style={{
                                  color: "var(--accent-green)",
                                  fontWeight: 600,
                                }}
                              >
                                Ready
                              </span>
                            ) : (
                              <span
                                style={{
                                  color: "var(--accent-amber)",
                                  fontWeight: 600,
                                }}
                              >
                                Sign-in required
                              </span>
                            )}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Connection:
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {conn ? conn.status : "—"}
                          </span>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ color: "var(--text-secondary)" }}>
                            Default Model:
                          </span>
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            Runtime default
                          </span>
                        </div>
                      </div>

                      {/* P2 closure: runtime-owned providers. OpenCode is the
                      first-class provider experience: every provider the
                      runtime knows appears here with its own status, official
                      Connect command, Models and Test. Codex/Claude expose a
                      single implied provider (OpenAI/Anthropic) whose auth is
                      the runtime onboarding status above. */}
                      {/* P2 closure round 2: runtime-owned providers of THIS
                      connection. OpenCode is the first-class provider
                      experience: every provider the runtime knows appears
                      here with its own connection status, Check Auth,
                      Refresh Models, Models, and a runtime-owned Connect
                      flow. Codex/Claude expose a single implied provider
                      (OpenAI/Anthropic) whose auth is the runtime
                      onboarding status below. */}
                      {conn &&
                        (providersByConnection[conn.connectionId]?.length ?? 0) > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.4rem",
                            backgroundColor: "rgba(0, 0, 0, 0.2)",
                            padding: "0.6rem 0.75rem",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border-color)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <span
                              style={{
                                color: "var(--text-secondary)",
                                fontSize: "0.8rem",
                              }}
                            >
                              Providers
                            </span>
                            <span
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                              }}
                            >
                              {providersByConnection[conn.connectionId].filter((p) => p.authenticated).length}{" "}
                              connected
                            </span>
                          </div>
                          {providersByConnection[conn.connectionId].map((provider) => {
                            const key = providerKey(conn.connectionId, provider.providerId);
                            return (
                            <div
                              key={key}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                fontSize: "0.78rem",
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontWeight: 600,
                                  flex: 1,
                                }}
                              >
                                {provider.providerId}
                              </span>
                              <span
                                style={{
                                  color: provider.authenticated
                                    ? "var(--accent-green)"
                                    : "var(--accent-amber)",
                                  fontSize: "0.72rem",
                                }}
                              >
                                {provider.authenticated ? "Connected" : "Not connected"}
                              </span>
                              {provider.authenticated ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleProviderModels(conn.connectionId, provider.providerId)
                                    }
                                  >
                                    Models
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleCheckAuth(conn.connectionId)
                                    }
                                    disabled={testingProvider === providerKey(conn.connectionId, "*")}
                                  >
                                    {testingProvider === providerKey(conn.connectionId, "*")
                                      ? "Checking…"
                                      : "Check Auth"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleRefreshProviderModels(conn.connectionId, provider.providerId)
                                    }
                                    disabled={testingProvider === key}
                                  >
                                    {testingProvider === key ? "Refreshing…" : "Refresh Models"}
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() =>
                                    handleConnectProvider(conn.connectionId, provider.providerId)
                                  }
                                >
                                  Connect
                                </button>
                              )}
                            </div>
                            );
                          })}
                          {expandedProvider &&
                            (providerCatalog[expandedProvider] ?? []).length > 0 && (
                              <div
                                style={{
                                  fontSize: "0.72rem",
                                  fontFamily: "var(--font-mono)",
                                  maxHeight: "120px",
                                  overflowY: "auto",
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "0.15rem",
                                }}
                              >
                                {(providerCatalog[expandedProvider] ?? []).map(
                                  (entry) => (
                                    <span key={entry.modelId}>{entry.modelId}</span>
                                  ),
                                )}
                              </div>
                            )}
                          {/* Connect flow: runtime-owned OAuth via the official
                          Server API; api-key methods stay guided official
                          commands (Tenvyr never receives raw keys). */}
                          {connectFlow &&
                            connectFlow.connectionId === conn.connectionId && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.45rem",
                                borderTop: "1px solid var(--border-color)",
                                paddingTop: "0.5rem",
                              }}
                            >
                              <div style={{ fontSize: "0.78rem", fontWeight: 600 }}>
                                Connect provider: {connectFlow.providerId}
                              </div>
                              {connectFlow.loading && (
                                <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                                  Loading…
                                </div>
                              )}
                              {connectFlow.error && (
                                <div style={{ fontSize: "0.72rem", color: "var(--accent-red)" }}>
                                  {connectFlow.error}
                                </div>
                              )}
                              {!connectFlow.loading &&
                                connectFlow.step === "choose" &&
                                connectFlow.authMethods.length === 0 && (
                                  <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                                    The runtime reports no auth methods for this provider.
                                  </div>
                                )}
                              {!connectFlow.loading && connectFlow.step === "choose" && (
                                <>
                                  {/* Auth method selection: the REAL contract is
                                  {type,label} identified by stable list index. */}
                                  <select
                                    value={connectFlow.selectedMethodIndex ?? ""}
                                    onChange={(e) =>
                                      setConnectFlow((current) =>
                                        current
                                          ? {
                                              ...current,
                                              selectedMethodIndex:
                                                e.target.value === ""
                                                  ? null
                                                  : Number(e.target.value),
                                            }
                                          : current,
                                      )
                                    }
                                    className="form-select"
                                    aria-label="Auth method"
                                  >
                                    <option value="">Select auth method…</option>
                                    {connectFlow.authMethods.map((method) => (
                                      <option key={method.methodIndex} value={method.methodIndex}>
                                        {method.label} ({method.type})
                                        {method.requiresPrompt ? " — unsupported prompt" : ""}
                                      </option>
                                    ))}
                                  </select>
                                  {(() => {
                                    const selectedMethod = connectFlow.authMethods.find(
                                      (m) => m.methodIndex === connectFlow.selectedMethodIndex,
                                    );
                                    const loginCommand = providersByConnection[
                                      connectFlow.connectionId
                                    ]?.find(
                                      (p) => p.providerId === connectFlow.providerId,
                                    )?.loginCommand ?? "";
                                    if (!selectedMethod) return null;
                                    if (selectedMethod.requiresPrompt) {
                                      return (
                                        <>
                                          <div
                                            style={{
                                              fontSize: "0.7rem",
                                              color: "var(--text-muted)",
                                            }}
                                          >
                                            This method requires prompt inputs Tenvyr does not
                                            drive (fail closed). Authentication stays
                                            runtime-owned — run the official command:
                                          </div>
                                          <code
                                            style={{
                                              fontFamily: "var(--font-mono)",
                                              fontSize: "0.75rem",
                                              padding: "0.3rem 0.5rem",
                                              backgroundColor: "var(--bg-surface)",
                                              borderRadius: "var(--radius-sm)",
                                              overflowWrap: "anywhere",
                                            }}
                                          >
                                            {loginCommand}
                                          </code>
                                          <div style={{ display: "flex", gap: "0.5rem" }}>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() =>
                                                handleCopyLogin(
                                                  loginCommand,
                                                  providerKey(
                                                    connectFlow.connectionId,
                                                    connectFlow.providerId,
                                                  ),
                                                )
                                              }
                                            >
                                              <Copy size={12} />
                                              <span>
                                                {copiedKind ===
                                                providerKey(
                                                  connectFlow.connectionId,
                                                  connectFlow.providerId,
                                                )
                                                  ? "Copied"
                                                  : "Copy Command"}
                                              </span>
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() => {
                                                setConnectFlow(null);
                                                handleCheckAuth(connectFlow.connectionId);
                                              }}
                                            >
                                              <RefreshCw size={12} />
                                              <span>Check Again</span>
                                            </button>
                                          </div>
                                        </>
                                      );
                                    }
                                    if (selectedMethod.type === "api") {
                                      // API-key methods MUST NOT call
                                      // /oauth/authorize: authentication is
                                      // managed by OpenCode; Tenvyr never
                                      // collects raw provider keys.
                                      return (
                                        <>
                                          <div
                                            style={{
                                              fontSize: "0.72rem",
                                              color: "var(--text-secondary)",
                                            }}
                                          >
                                            API Key — authentication is managed by OpenCode.
                                            Run the official command in your terminal (Tenvyr
                                            never receives raw keys):
                                          </div>
                                          <code
                                            style={{
                                              fontFamily: "var(--font-mono)",
                                              fontSize: "0.75rem",
                                              padding: "0.3rem 0.5rem",
                                              backgroundColor: "var(--bg-surface)",
                                              borderRadius: "var(--radius-sm)",
                                              overflowWrap: "anywhere",
                                            }}
                                          >
                                            {loginCommand}
                                          </code>
                                          <div style={{ display: "flex", gap: "0.5rem" }}>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() =>
                                                handleCopyLogin(
                                                  loginCommand,
                                                  providerKey(
                                                    connectFlow.connectionId,
                                                    connectFlow.providerId,
                                                  ),
                                                )
                                              }
                                            >
                                              <Copy size={12} />
                                              <span>
                                                {copiedKind ===
                                                providerKey(
                                                  connectFlow.connectionId,
                                                  connectFlow.providerId,
                                                )
                                                  ? "Copied"
                                                  : "Copy Command"}
                                              </span>
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn-secondary btn-sm"
                                              onClick={() => {
                                                setConnectFlow(null);
                                                handleCheckAuth(connectFlow.connectionId);
                                              }}
                                            >
                                              <RefreshCw size={12} />
                                              <span>Check Again</span>
                                            </button>
                                          </div>
                                        </>
                                      );
                                    }
                                    // type === "oauth" without prompts
                                    return (
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={() =>
                                          handleOauthBegin(
                                            connectFlow.connectionId,
                                            connectFlow.providerId,
                                          )
                                        }
                                      >
                                        Start Authorization
                                      </button>
                                    );
                                  })()}
                                </>
                              )}

                              {!connectFlow.loading &&
                                connectFlow.step === "begin" &&
                                connectFlow.url && (
                                  <>
                                    <div style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                                      {connectFlow.instructions ||
                                        "Complete authorization in the provider&apos;s own window, then come back."}
                                    </div>
                                    <a
                                      href={connectFlow.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="btn btn-secondary btn-sm"
                                      style={{ overflowWrap: "anywhere" }}
                                    >
                                      <ExternalLink size={12} />
                                      <span>Open authorization page</span>
                                    </a>
                                    {connectFlow.method === "auto" && (
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={handleOauthComplete}
                                      >
                                        I&apos;ve completed authorization
                                      </button>
                                    )}
                                    {connectFlow.method === "code" && (
                                      <>
                                        <input
                                          type="text"
                                          value={connectFlow.codeInput}
                                          onChange={(e) =>
                                            setConnectFlow((current) =>
                                              current
                                                ? { ...current, codeInput: e.target.value }
                                                : current,
                                            )
                                          }
                                          className="form-input"
                                          placeholder="Authorization code"
                                          style={{
                                            padding: "0.3rem 0.5rem",
                                            fontSize: "0.8rem",
                                            fontFamily: "var(--font-mono)",
                                          }}
                                        />
                                        <button
                                          type="button"
                                          className="btn btn-primary btn-sm"
                                          disabled={!connectFlow.codeInput.trim()}
                                          onClick={handleOauthComplete}
                                        >
                                          Submit Code
                                        </button>
                                      </>
                                    )}
                                  </>
                                )}
                              {!connectFlow.loading &&
                                connectFlow.step === "completed" && (
                                  <div style={{ fontSize: "0.75rem", color: "var(--accent-green)" }}>
                                    Flow completed — check the provider row above for the
                                    refreshed connection state.
                                  </div>
                                )}
                              {!connectFlow.loading &&
                                connectFlow.step === "begin" && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={handleOauthCancel}
                                  >
                                    Cancel
                                  </button>
                                )}

                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  if (connectFlow?.authFlowId) {
                                    // Never silently abandon a live flow:
                                    // backend cancel first (closes the
                                    // management session), then dismiss.
                                    handleOauthCancel();
                                  } else {
                                    setConnectFlow(null);
                                  }
                                }}
                              >
                                {connectFlow?.authFlowId ? "Cancel Flow" : "Close"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* P2: guided official login — Tenvyr never collects provider
                      credentials; it only shows the runtime's OWN command. */}
                      {/* P2 closure round 2: auth repair is available for
                      EXISTING connections too — a Runtime Connection and
                      runtime authentication are SEPARATE states; an
                      AUTH_REQUIRED connection must not require
                      revoke/recreate to repair. The Sign-in flow stays
                      runtime-owned. */}
                      {(status?.authReady === false ||
                        conn?.status === "AUTH_REQUIRED") &&
                        status.loginCommand && (
                          <div
                            style={{
                              backgroundColor: "rgba(0, 0, 0, 0.2)",
                              padding: "0.6rem 0.75rem",
                              borderRadius: "var(--radius-md)",
                              border: "1px solid var(--border-color)",
                              display: "flex",
                              flexDirection: "column",
                              gap: "0.5rem",
                            }}
                          >
                            {signInKind === kind ? (
                              <>
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "var(--text-secondary)",
                                  }}
                                >
                                  Run the official sign-in in your own terminal
                                  (Tenvyr never sees your credentials):
                                </div>
                                <code
                                  style={{
                                    fontFamily: "var(--font-mono)",
                                    fontSize: "0.8rem",
                                    padding: "0.4rem 0.6rem",
                                    backgroundColor: "var(--bg-surface)",
                                    borderRadius: "var(--radius-sm)",
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {status.loginCommand}
                                </code>
                                <div style={{ display: "flex", gap: "0.5rem" }}>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() =>
                                      handleCopyLogin(status.loginCommand, kind)
                                    }
                                  >
                                    <Copy size={12} />
                                    <span>
                                      {copiedKind === kind
                                        ? "Copied"
                                        : "Copy Command"}
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={async () => {
                                      setSignInKind(null);
                                      await loadData();
                                      // P1: Check Again completes the login loop — if auth is now ready, revalidate the existing connection
                                      try {
                                        const freshStatus = await tenvyrApi.getRuntimeOnboarding(kind);
                                        if (freshStatus?.status?.authReady) {
                                          const existing = connections.find((c) => c.runtimeKind === kind && !c.revoked);
                                          if (existing) {
                                            await handleTest(existing.connectionId);
                                          }
                                        }
                                      } catch {}
                                      await loadData();
                                    }}
                                  >
                                    <RefreshCw size={12} />
                                    <span>Check Again</span>
                                  </button>
                                </div>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => setSignInKind(kind)}
                              >
                                <LogIn size={12} />
                                <span>Sign in</span>
                              </button>
                            )}
                          </div>
                        )}

                      {/* Guidance block */}
                      {status?.guidance && status.guidance.length > 0 && (
                        <div
                          style={{
                            backgroundColor: "rgba(0, 0, 0, 0.2)",
                            padding: "0.6rem 0.75rem",
                            borderRadius: "var(--radius-md)",
                            border: "1px solid var(--border-color)",
                            fontSize: "0.75rem",
                            color: "var(--text-secondary)",
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {status.guidance.map((line, idx) => (
                            <p
                              key={idx}
                              style={{
                                marginBottom:
                                  idx < status.guidance.length - 1
                                    ? "0.3rem"
                                    : 0,
                              }}
                            >
                              {line}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "0.5rem",
                          marginTop: "auto",
                        }}
                      >
                        {conn ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleTest(conn.connectionId)}
                              disabled={isTesting}
                              className="btn btn-secondary btn-sm"
                              style={{ flex: 1 }}
                            >
                              <Play size={12} />
                              <span>
                                {isTesting ? "Testing…" : "Test Runtime"}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openReviseForm(conn)}
                              className="btn btn-secondary btn-sm"
                            >
                              Revise
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRevoke(conn.connectionId)}
                              className="btn btn-danger btn-sm"
                            >
                              Revoke
                            </button>
                          </>
                        ) : status?.detected ? (
                          <button
                            type="button"
                            onClick={() => handleConnect(kind)}
                            disabled={isConnecting}
                            className="btn btn-primary btn-sm"
                            style={{ width: "100%" }}
                          >
                            <Check size={14} />
                            <span>
                              {isConnecting
                                ? "Connecting…"
                                : `Connect ${title}`}
                            </span>
                          </button>
                        ) : (
                          <a
                            href={status?.docUrl || "https://github.com"}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-secondary btn-sm"
                            style={{ width: "100%" }}
                          >
                            <ExternalLink size={12} />
                            <span>Installation Instructions</span>
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Active Connections Catalog */}
          <section
            aria-labelledby="connections-heading"
            style={{ marginTop: "1.5rem" }}
          >
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 id="connections-heading" className="card-title">
                    All Runtime Connections
                  </h2>
                  <p
                    style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}
                  >
                    Audited immutable connection profiles & capability records
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingConnId(null);
                    setAdvConnectionId("conn:custom");
                    setAdvName("Custom CLI");
                    setAdvKind("generic-cli");
                    setAdvCommand("");
                    setShowAdvanced(!showAdvanced);
                  }}
                  className="btn btn-secondary btn-sm"
                >
                  {showAdvanced
                    ? "Hide Configuration Form"
                    : "+ Add Custom Connection"}
                </button>
              </div>

              {/* Advanced / Custom Connection Form */}
              {showAdvanced && (
                <form
                  onSubmit={handleSaveAdvanced}
                  style={{
                    backgroundColor: "var(--bg-surface)",
                    padding: "1.25rem",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-color)",
                    marginBottom: "1.5rem",
                    display: "flex",
                    flexDirection: "column",
                    gap: "1rem",
                  }}
                >
                  <h3 style={{ fontSize: "0.9rem", fontWeight: 700 }}>
                    {editingConnId
                      ? `Revise Connection: ${editingConnId}`
                      : "Create Custom Connection"}
                  </h3>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Connection ID</label>
                      <input
                        type="text"
                        value={advConnectionId}
                        onChange={(e) => setAdvConnectionId(e.target.value)}
                        disabled={Boolean(editingConnId)}
                        required
                        className="form-input"
                        placeholder="conn:custom"
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Display Name</label>
                      <input
                        type="text"
                        value={advName}
                        onChange={(e) => setAdvName(e.target.value)}
                        required
                        className="form-input"
                        placeholder="Custom CLI Runtime"
                      />
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "1rem",
                    }}
                  >
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Runtime Kind</label>
                      <select
                        value={advKind}
                        onChange={(e) => setAdvKind(e.target.value)}
                        className="form-select"
                      >
                        <option value="generic-cli">Generic CLI</option>
                        <option value="codex">Codex CLI Template</option>
                        <option value="claude">Claude Code Template</option>
                        <option value="opencode">OpenCode Template</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">
                        Executable Absolute Path
                      </label>
                      <input
                        type="text"
                        value={advCommand}
                        onChange={(e) => setAdvCommand(e.target.value)}
                        required
                        className="form-input"
                        placeholder="/usr/local/bin/codex"
                      />
                    </div>
                  </div>

                  {advKind === "generic-cli" && (
                    <>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "1rem",
                        }}
                      >
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">
                            Arguments (comma separated)
                          </label>
                          <input
                            type="text"
                            value={advArgs}
                            onChange={(e) => setAdvArgs(e.target.value)}
                            className="form-input"
                            placeholder="exec, --json"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">
                            Working Directory (optional)
                          </label>
                          <DirectoryInput
                            value={advCwd}
                            onChange={setAdvCwd}
                            placeholder="/srv/work"
                          />
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: "1rem",
                        }}
                      >
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">
                            Secret Environment Variable Names (names only)
                          </label>
                          <input
                            type="text"
                            value={advSecrets}
                            onChange={(e) => setAdvSecrets(e.target.value)}
                            className="form-input"
                            placeholder="OPENAI_API_KEY, ANTHROPIC_API_KEY"
                          />
                        </div>
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <label className="form-label">Probe Arguments</label>
                          <input
                            type="text"
                            value={advProbeArgs}
                            onChange={(e) => setAdvProbeArgs(e.target.value)}
                            className="form-input"
                            placeholder="--version"
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(false)}
                      className="btn btn-secondary btn-sm"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingAdv}
                      className="btn btn-primary btn-sm"
                    >
                      {savingAdv
                        ? "Saving…"
                        : editingConnId
                          ? "Save Revision"
                          : "Create Connection"}
                    </button>
                  </div>
                </form>
              )}

              {connections.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "2rem 1rem",
                    color: "var(--text-muted)",
                  }}
                >
                  No runtime connections configured. Click &ldquo;Connect&rdquo;
                  above on Codex, Claude Code, or OpenCode.
                </div>
              ) : (
                <div className="table-container">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Connection ID</th>
                        <th>Name</th>
                        <th>Kind</th>
                        <th>Status</th>
                        <th>Tested Version</th>
                        <th>Last Tested</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {connections.map((c) => (
                        <tr key={c.connectionId}>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                            }}
                          >
                            {c.connectionId}
                          </td>
                          <td>{c.name}</td>
                          <td>
                            <span className="badge badge-neutral">
                              {c.runtimeKind}
                            </span>
                          </td>
                          <td>
                            <StatusBadge status={c.status} />
                          </td>
                          <td
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "0.75rem",
                            }}
                          >
                            {c.testedVersion || "—"}
                          </td>
                          <td
                            style={{
                              color: "var(--text-muted)",
                              fontSize: "0.75rem",
                            }}
                          >
                            {c.testedAt
                              ? new Date(c.testedAt).toLocaleTimeString()
                              : "Never"}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: "0.35rem" }}>
                              {!c.revoked && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleTest(c.connectionId)}
                                    disabled={testingId === c.connectionId}
                                    className="btn btn-secondary btn-sm"
                                  >
                                    Test
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openReviseForm(c)}
                                    className="btn btn-secondary btn-sm"
                                  >
                                    Revise
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRevoke(c.connectionId)}
                                    className="btn btn-danger btn-sm"
                                  >
                                    Revoke
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
