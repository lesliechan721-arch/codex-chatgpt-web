const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { acquireModelCatalogCommandLock } = require("./model-catalog-command-lock.cjs");
const { createApiKeyVault } = require("./api-key-vault.cjs");
const { createUpstreamApiKeyVault, validUpstreamApiKey } = require("./upstream-api-key-vault.cjs");
const {
  clearResetMarker,
  readUpstreamConfig,
  upstreamKeyDigest,
  validateUpstreamChange,
} = require("./upstream-provider-config.cjs");
const { fetchUpstreamModelCatalog } = require("./upstream-provider-network.cjs");
const modelMetadata = require("./codex-model-metadata.cjs");
const { mergeNoProxy, PROXY_ENV_KEYS } = require("./network-proxy-config.cjs");

// Mirrors the version-1 core wire format. Conformance is covered by the core/Bun test.
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const OPENAI_POLICY = Object.freeze({ version: 1, mode: "openai" });
const MAX_POLICY_BYTES = 4096;
const PUBLIC_BASE_URL_ENV = "CODEX_CHATGPT_WEB_PUBLIC_BASE_URL";
const CLIENT_PORT_ENV = "CODEX_CHATGPT_WEB_CLIENT_PORT";
const MANUAL_CODEX_CONFIG_ENV = "CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG";
const MODEL_CATALOG_RETRY_MS = 1_000;
const MODEL_CATALOG_WAIT_RETRY_MS = 5_000;
const MODEL_CATALOG_COMMAND_TIMEOUT_MS = 30_000;
const ERROR_CODES = new Set([
  "invalid-policy", "invalid-input", "invalid-key", "key-required", "control-key-reuse",
  "stale-settings", "runtime-busy", "external-runtime", "dev-profile", "not-configured",
  "restart-required",
  "api-mode-required", "stop-failed", "apply-failed-restored", "saved-runtime-unverified",
  "recovery-failed", "export-failed", "unavailable", "untrusted-sender",
  "save-failed", "key-unavailable",
  "invalid-upstream-config", "invalid-upstream-models", "invalid-upstream-metadata", "invalid-upstream-proxy",
  "invalid-upstream-key", "upstream-key-required", "upstream-fetch-failed",
  "upstream-discovery-required", "upstream-metadata-unavailable", "upstream-legacy-cleanup-failed",
]);

class ApiAccessSettingsError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ApiAccessSettingsError(code); };

function clientBaseUrl(config, environment = process.env) {
  if (!config) return null;
  const configured = environment[PUBLIC_BASE_URL_ENV]?.trim();
  if (!configured) {
    const rawClientPort = environment[CLIENT_PORT_ENV]?.trim();
    const clientPort = rawClientPort ? Number(rawClientPort) : config.port;
    if (!Number.isSafeInteger(clientPort) || clientPort <= 0 || clientPort > 65_535) {
      return fail("invalid-policy");
    }
    return `http://127.0.0.1:${clientPort}/v1`;
  }
  let url;
  try { url = new URL(configured); } catch { return fail("invalid-policy"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return fail("invalid-policy");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) return fail("invalid-policy");
  return `${url.origin}${pathname}`;
}

function parsePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid-policy");
  const keys = Object.keys(value);
  if (value.version === 1 && value.mode === "openai"
    && keys.every(key => key === "version" || key === "mode")) return OPENAI_POLICY;
  if (value.version === 1 && value.mode === "api-key"
    && typeof value.keySha256 === "string" && /^[a-f0-9]{64}$/.test(value.keySha256)
    && keys.every(key => ["version", "mode", "keySha256"].includes(key))) {
    return { version: 1, mode: "api-key", keySha256: value.keySha256 };
  }
  return fail("invalid-policy");
}

function keyPolicy(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) return fail("invalid-key");
  return { version: 1, mode: "api-key", keySha256: createHash("sha256").update(key).digest("hex") };
}

function policyRevision(policy, controlToken) {
  // HMAC, not the stored key digest: safe to expose as non-credential health evidence.
  return createHmac("sha256", controlToken)
    .update(`codex-web-api-access:v1\0${policy.mode}\0${policy.mode === "api-key" ? policy.keySha256 : ""}`)
    .digest("hex");
}

function upstreamProviderRevision(config, controlToken) {
  return createHmac("sha256", controlToken)
    .update(`codex-web-upstream-provider:v2\0${JSON.stringify(config)}`)
    .digest("hex");
}

function readPolicyFile(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) {
    if (error.code === "ENOENT") return { policy: OPENAI_POLICY, bytes: null };
    return fail("invalid-policy");
  }
  if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) return fail("invalid-policy");
  try {
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > MAX_POLICY_BYTES) return fail("invalid-policy");
    return { policy: parsePolicy(JSON.parse(bytes.toString("utf8"))), bytes };
  } catch { return fail("invalid-policy"); }
}

function validateChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Object.keys(input).every(key => ["mode", "key", "expectedRevision"].includes(key))
    || !["openai", "api-key"].includes(input.mode)
    || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || (input.key !== undefined && typeof input.key !== "string")
    || (input.mode === "openai" && input.key !== undefined)) return fail("invalid-input");
  if (input.key !== undefined) keyPolicy(input.key);
  return input;
}

/** Main-process only. Persist user intent first; runtime availability is not a save precondition. */
function createApiAccessSettings({
  coreHome, runtimeHost, supervisor, browserHost,
  clipboard, setTimer = setTimeout, clearTimer = clearTimeout, safeStorage,
  resolveProxy, getNetworkProxyUrl, onModeCommitted, onModeSettled,
}) {
  if (safeStorage === undefined) {
    try { safeStorage = require("electron").safeStorage; } catch { /* Node tests / headless host. */ }
  }
  const vault = createApiKeyVault({ coreHome, safeStorage });
  const upstreamVault = createUpstreamApiKeyVault({ coreHome, safeStorage });
  const filePath = path.join(coreHome, "api-access.json");
  const upstreamFilePath = path.join(coreHome, "upstream-provider.json");
  const routingPendingPath = path.join(coreHome, "api-access-routing-pending.json");
  const modelCatalogPendingPath = path.join(coreHome, "api-key-models-refresh-pending.json");
  const revisionSecret = randomBytes(32);
  let clipboardSecret = null;
  let clipboardTimer = null;
  let modelCatalogRetryTimer = null;
  let modelCatalogRefreshFailed = false;
  let disposed = false;
  let applying = false;
  let cleanupPending = false;
  let routingPending = false;
  let lastUpstreamDiscovery = null;
  const upstreamSnapshotForPolicy = policy => {
    let snapshot;
    try { snapshot = readUpstreamConfig(upstreamFilePath); }
    catch (error) {
      if (policy.mode !== "api-key" && error?.message === "invalid-upstream-config") {
        return { config: null, bytes: null, resetReason: null };
      }
      throw error;
    }
    if (snapshot.resetReason) {
      try { upstreamVault.clearStrict(); }
      catch { fail("upstream-legacy-cleanup-failed"); }
    }
    return policy.mode === "api-key"
      ? snapshot
      : { config: null, bytes: null, resetReason: snapshot.resetReason ?? null };
  };
  const revisionOf = (snapshot, upstreamSnapshot = upstreamSnapshotForPolicy(snapshot.policy)) => createHmac("sha256", revisionSecret)
    .update(snapshot.bytes ?? "absent-policy-file")
    .update("\0")
    .update(upstreamSnapshot.bytes ?? "absent-upstream-provider-file")
    .digest("hex");
  const upstreamRuntimeApplied = (policy, upstreamConfig, health, config) => policy.mode !== "api-key" || !upstreamConfig
    || Boolean(config && health
      && health.upstream_provider_revision === upstreamProviderRevision(upstreamConfig, config.controlToken)
      && health.upstream_provider_key_matches === true
      && health.upstream_provider_available === true);
  const shellType = () => runtimeSnapshot().config?.mode === "full" ? "unified_exec" : "disabled";
  const emptyDiscovery = () => ({
    ids: [], upstreamMetadata: new Map(), richIds: new Set(), sources: { data: false, models: false },
  });
  const discoveryIdentityFromDigest = (baseUrl, proxy, keySha256) => JSON.stringify({
    baseUrl,
    proxy,
    keySha256,
  });
  const discoveryIdentity = (baseUrl, proxy, key) => discoveryIdentityFromDigest(
    baseUrl,
    proxy,
    upstreamKeyDigest(key),
  );
  const bundledModels = new Set(modelMetadata.bundledModelIds());
  const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  function discoveryFor(input, key) {
    const identity = discoveryIdentity(input.baseUrl, input.proxy, key);
    return lastUpstreamDiscovery?.identity === identity ? lastUpstreamDiscovery.discovery : null;
  }
  function validateModelChanges(beforeConfig, input, key) {
    const beforeModels = new Map((beforeConfig?.models ?? []).map(model => [model.id, model]));
    const discovery = discoveryFor(input, key);
    for (const model of input.models) {
      const previous = beforeModels.get(model.id);
      if (!previous && !discovery?.ids.includes(model.id)) fail("upstream-discovery-required");
      if (previous && sameJson(previous.metadata, model.metadata)) continue;
      const configured = model.metadata;
      if (!configured) continue;
      if (configured.mode === "upstream" && !discovery?.richIds.has(model.id)) fail("upstream-metadata-unavailable");
      if (configured.mode === "default" && !bundledModels.has(model.id)) fail("upstream-metadata-unavailable");
      if (configured.mode === "custom") {
        if (configured.baseMode === "upstream" && !discovery?.richIds.has(model.id)) fail("upstream-metadata-unavailable");
        if (configured.baseMode === "default" && !bundledModels.has(model.id)) fail("upstream-metadata-unavailable");
        try {
          modelMetadata.resolveModelMetadata(
            model.id,
            configured,
            discovery ?? emptyDiscovery(),
            shellType(),
            { strictCustom: true },
          );
        } catch { fail("invalid-upstream-metadata"); }
      }
    }
  }
  const assertProduction = () => {
    if (runtimeHost.launcherProfile === "development") fail("dev-profile");
  };
  function runtimeSnapshot() {
    try { return runtimeHost.runtimeConfigSnapshot(); }
    catch { return { configured: false, owner: "none" }; }
  }
  async function readHealth(config) {
    if (!config) return null;
    try {
      const health = await supervisor.proxyHealthPayload(config);
      return health?.service === "codex-chatgpt-web" && health.status === "ok" ? health : null;
    } catch { return null; }
  }
  async function status() {
    assertProduction();
    let saved;
    let upstreamSaved;
    try {
      saved = readPolicyFile(filePath);
      upstreamSaved = upstreamSnapshotForPolicy(saved.policy);
    }
    catch (error) { return { configuredMode: "invalid",
      ...(error?.message === "upstream-legacy-cleanup-failed" ? { errorCode: "upstream-legacy-cleanup-failed" } : {}),
      effectiveMode: null, revision: null,
      keyConfigured: false, keyAvailable: false, keyStorage: "unavailable",
      runtimeState: "invalid", modelCatalogState: "ready", baseUrl: null, canApply: false, cleanupPending }; }
    const runtime = runtimeSnapshot();
    const config = runtime.config;
    const health = await readHealth(config);
    const effectiveMode = ["openai", "api-key"].includes(health?.access_mode) ? health.access_mode : null;
    const matches = Boolean(config && health && health.api_access_revision
      && health.api_access_revision === policyRevision(saved.policy, config.controlToken));
    const key = vault.info(saved.policy.mode === "api-key" ? saved.policy.keySha256 : undefined);
    const upstreamKey = upstreamSaved.config
      ? upstreamVault.info(upstreamSaved.config.apiKeySha256)
      : { available: false, storage: "unavailable" };
    const upstreamApplied = upstreamSaved.config
      ? upstreamKey.available && upstreamRuntimeApplied(saved.policy, upstreamSaved.config, health, config)
      : upstreamRuntimeApplied(saved.policy, upstreamSaved.config, health, config);
    const manualCodexConfig = process.env[MANUAL_CODEX_CONFIG_ENV]?.trim() === "1";
    const modelCatalogMarker = saved.policy.mode === "api-key" ? modelCatalogMarkerState() : "ready";
    const currentDiscovery = upstreamSaved.config
      && lastUpstreamDiscovery?.identity === discoveryIdentityFromDigest(
        upstreamSaved.config.baseUrl,
        upstreamSaved.config.proxy,
        upstreamSaved.config.apiKeySha256,
      )
      ? lastUpstreamDiscovery.discovery
      : emptyDiscovery();
    return {
      configuredMode: saved.policy.mode,
      effectiveMode,
      revision: revisionOf(saved, upstreamSaved),
      keyConfigured: saved.policy.mode === "api-key",
      keyAvailable: key.available,
      keyStorage: key.storage,
      runtimeState: !runtime.configured ? "unconfigured"
        : !health ? "stopped"
          : matches && upstreamApplied && health.accepting_turns === true
            ? "in-sync" : "restart-required",
      baseUrl: clientBaseUrl(config),
      modelCatalogState: modelCatalogMarker === "export-required"
        ? "export-required"
        : modelCatalogMarker === "pending"
          ? modelCatalogRefreshFailed ? "failed" : "pending"
          : "ready",
      canApply: true,
      upstream: upstreamSaved.config ? {
        configured: true,
        baseUrl: upstreamSaved.config.baseUrl,
        proxy: upstreamSaved.config.proxy,
        models: upstreamSaved.config.models,
        metadata: modelMetadata.metadataPreview(
          upstreamSaved.config.models,
          currentDiscovery,
          shellType(),
        ),
        supportsOpenAiServerCompaction: upstreamSaved.config.supportsOpenAiServerCompaction,
        keyAvailable: upstreamKey.available,
        keyStorage: upstreamKey.storage,
        runtimeAvailable: upstreamApplied,
        resetReason: upstreamSaved.resetReason ?? undefined,
        metadataSchema: modelMetadata.customMetadataSchema(),
        protectedMetadataFields: modelMetadata.protectedMetadataFields(),
      } : {
        configured: false,
        keyAvailable: false,
        keyStorage: "unavailable",
        runtimeAvailable: false,
        resetReason: upstreamSaved.resetReason ?? undefined,
        metadataSchema: modelMetadata.customMetadataSchema(),
        protectedMetadataFields: modelMetadata.protectedMetadataFields(),
      },
      routingPending: saved.policy.mode === "openai"
        && (routingPending || fs.existsSync(routingPendingPath)),
      cleanupPending: !manualCodexConfig && saved.policy.mode === "api-key" && (cleanupPending
        || fs.existsSync(path.join(coreHome, "codex", "integration-journal.json"))
        || fs.existsSync(path.join(coreHome, "codex", "integration-journal.recovery.json"))),
    };
  }
  function assertUnchanged(revision) {
    const current = readPolicyFile(filePath);
    const upstream = upstreamSnapshotForPolicy(current.policy);
    if (revisionOf(current, upstream) !== revision) fail("stale-settings");
    return { ...current, upstream };
  }
  function reveal() {
    assertProduction();
    const saved = readPolicyFile(filePath).policy;
    if (saved.mode !== "api-key") fail("api-mode-required");
    const key = vault.read(saved.keySha256);
    if (!key) fail("key-unavailable");
    return key;
  }
  async function reconcile(name) {
    // Cleanup is independent of browser activity. A busy setup process defers the operation,
    // not the already committed policy. CLI serve/setup also reconcile on their next entry.
    const configured = readPolicyFile(filePath).policy;
    const manualCodexConfig = process.env[MANUAL_CODEX_CONFIG_ENV]?.trim() === "1";
    cleanupPending = configured.mode === "api-key" && !manualCodexConfig;
    routingPending = configured.mode === "openai" && runtimeSnapshot().configured;
    if (routingPending) {
      try { writePrivateFileAtomic(routingPendingPath, '{"version":1}\n'); } catch {}
    } else {
      try { fs.rmSync(routingPendingPath, { force: true }); } catch {}
    }
    let restartFailed = false;
    if (runtimeHost.currentOperation()) return restartFailed;
    await runtimeHost.runLifecycleOperation(name, async () => {
      if (configured.mode === "api-key" && !manualCodexConfig) {
        try {
          await runtimeHost.run(name, ["api-key", "cleanup"], {
            embedded: true, timeoutMs: 15_000,
            message: "Removing project-owned Codex injection",
            successMessage: "Codex API configuration remains manual",
          });
          cleanupPending = false;
        } catch { /* Keep intent saved and expose cleanupPending; never guess ownership. */ }
      }
      const runtime = runtimeSnapshot();
      if (configured.mode === "openai" && runtime.configured) {
        try {
          await runtimeHost.run(name, ["api-key", "reconnect"], {
            embedded: true, timeoutMs: 15_000,
            message: "Restoring the OpenAI forwarding integration",
            successMessage: "OpenAI forwarding integration configured",
          });
          routingPending = false;
          try { fs.rmSync(routingPendingPath, { force: true }); } catch {}
        } catch { /* Conflicting user routes are not force-replaced. */ }
      }
      if (!runtime.configured || runtime.owner === "external") return;
      const health = await readHealth(runtime.config);
      const savedPolicy = readPolicyFile(filePath).policy;
      const savedUpstream = savedPolicy.mode === "api-key" ? readUpstreamConfig(upstreamFilePath).config : null;
      if (health?.accepting_turns === true
        && health.api_access_revision === policyRevision(savedPolicy, runtime.config.controlToken)
        && upstreamRuntimeApplied(savedPolicy, savedUpstream, health, runtime.config)) return;
      if (browserHost?.activeTraceId || browserHost?.currentOperation()
        || (health && (health.active_http_turns > 0 || health.active_browser_turns > 0))) return;
      // Restart only supervised runtimes after their existing atomic idle/drain check. No app
      // relaunch and no forced turn cancellation; failed stops/starts leave the saved intent intact.
      try {
        await supervisor.stopForSetup();
        await supervisor.startIfConfigured();
      } catch {
        restartFailed = true;
        /* status() reports pending/unreachable, never "applied" by inference. */
      }
    });
    return restartFailed;
  }
  async function apply(raw) {
    assertProduction();
    const input = validateChange(raw);
    if (applying) fail("runtime-busy");
    applying = true;
    try {
      const before = assertUnchanged(input.expectedRevision);
      let key = input.key;
      if (input.mode === "api-key" && key === undefined && before.policy.mode !== "api-key") {
        key = vault.read() ?? undefined;
        if (key === undefined) fail("key-required");
      }
      const next = input.mode === "openai" ? OPENAI_POLICY
        : key !== undefined ? keyPolicy(key) : before.policy;
      const modeChanged = before.policy.mode !== next.mode;
      const controlToken = runtimeSnapshot().config?.controlToken;
      if (next.mode === "api-key" && typeof controlToken === "string"
        && createHash("sha256").update(controlToken).digest("hex") === next.keySha256) fail("control-key-reuse");
      // No await between optimistic concurrency check and atomic write.
      assertUnchanged(input.expectedRevision);
      try { writePrivateFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`); }
      catch { return fail("save-failed"); }
      if (modeChanged) {
        try { onModeCommitted?.({ previousMode: before.policy.mode, mode: next.mode }); }
        catch { /* Post-commit notifications must not skip runtime reconciliation. */ }
      }
      clearOwnedClipboard();
      // An external CLI rotation must not make disabling/re-enabling resurrect an old GUI key.
      if (input.mode === "openai" && before.policy.mode === "api-key") {
        vault.retainOnly(before.policy.keySha256);
        vault.allowReuse(before.policy.keySha256);
      }
      if (key !== undefined) vault.store(key);
      try {
        if (next.mode === "api-key") {
          return { cancelled: false, status: await reconcileModelCatalog("api-access-settings") };
        }
        cancelModelCatalogRetry();
        try { await reconcile("api-access-settings"); } catch { /* Saved policy is authoritative. */ }
        return { cancelled: false, status: await status() };
      } finally {
        if (modeChanged) {
          try { onModeSettled?.({ previousMode: before.policy.mode, mode: next.mode }); }
          catch { /* Saved policy remains authoritative even if a notification fails. */ }
        }
      }
    } finally { applying = false; }
  }
  async function saveUpstream(raw) {
    assertProduction();
    if (readPolicyFile(filePath).policy.mode !== "api-key") fail("api-mode-required");
    let input;
    try { input = validateUpstreamChange(raw); }
    catch (error) { return fail(ERROR_CODES.has(error?.message) ? error.message : "invalid-input"); }
    if (applying) fail("runtime-busy");
    applying = true;
    try {
      const before = assertUnchanged(input.expectedRevision);
      let key = input.apiKey;
      if (key !== undefined && !validUpstreamApiKey(key)) fail("invalid-upstream-key");
      if (key === undefined) {
        key = before.upstream.config
          ? upstreamVault.read(before.upstream.config.apiKeySha256)
          : null;
        if (!key) fail("upstream-key-required");
      }
      validateModelChanges(before.upstream.config, input, key);
      const next = {
        version: 2,
        baseUrl: input.baseUrl,
        apiKeySha256: upstreamKeyDigest(key),
        proxy: input.proxy,
        models: input.models,
        supportsOpenAiServerCompaction: input.supportsOpenAiServerCompaction,
      };
      try {
        await withModelCatalogCommandLock(async () => {
          // The await above can let another settings writer win. Re-check before committing.
          assertUnchanged(input.expectedRevision);
          if (before.upstream.resetReason) {
            try { clearResetMarker(upstreamFilePath); }
            catch { return fail("upstream-legacy-cleanup-failed"); }
          }
          markModelCatalogPending();
          writePrivateFileAtomic(upstreamFilePath, `${JSON.stringify(next, null, 2)}\n`);
        });
      } catch (error) {
        if (error instanceof ApiAccessSettingsError) throw error;
        return fail("save-failed");
      }
      if (input.apiKey !== undefined) upstreamVault.store(key);
      return { status: await reconcileModelCatalog("api-access-upstream-settings") };
    } finally { applying = false; }
  }
  async function deleteUpstream(raw) {
    assertProduction();
    if (readPolicyFile(filePath).policy.mode !== "api-key") fail("api-mode-required");
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 1
      || typeof raw.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(raw.expectedRevision)) fail("invalid-input");
    if (applying) fail("runtime-busy");
    applying = true;
    try {
      const before = assertUnchanged(raw.expectedRevision);
      try {
        await withModelCatalogCommandLock(async () => {
          assertUnchanged(raw.expectedRevision);
          markModelCatalogPending();
          fs.rmSync(upstreamFilePath, { force: true });
        });
      } catch (error) {
        if (error instanceof ApiAccessSettingsError) throw error;
        return fail("save-failed");
      }
      try {
        upstreamVault.clearStrict();
        if (before.upstream.resetReason) clearResetMarker(upstreamFilePath);
      } catch { return fail("upstream-legacy-cleanup-failed"); }
      lastUpstreamDiscovery = null;
      return { status: await reconcileModelCatalog("api-access-upstream-settings") };
    } finally { applying = false; }
  }
  async function fetchUpstreamModels(raw) {
    assertProduction();
    if (readPolicyFile(filePath).policy.mode !== "api-key") fail("api-mode-required");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || !Object.keys(raw).every(key => ["expectedRevision", "baseUrl", "apiKey", "proxy", "models"].includes(key))
      || typeof raw.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(raw.expectedRevision)) fail("invalid-input");
    let draft;
    try {
      draft = validateUpstreamChange({
        expectedRevision: raw.expectedRevision,
        baseUrl: raw.baseUrl,
        ...(raw.apiKey !== undefined && raw.apiKey !== "" ? { apiKey: raw.apiKey } : {}),
        proxy: raw.proxy,
        models: raw.models ?? [],
        supportsOpenAiServerCompaction: false,
      });
    } catch (error) { return fail(ERROR_CODES.has(error?.message) ? error.message : "invalid-input"); }
    let key = draft.apiKey;
    if (key !== undefined && !validUpstreamApiKey(key)) fail("invalid-upstream-key");
    if (!key) {
      const saved = assertUnchanged(draft.expectedRevision).upstream.config;
      if (!saved || saved.baseUrl !== draft.baseUrl) fail("upstream-key-required");
      key = upstreamVault.read(saved.apiKeySha256);
      if (!key) fail("upstream-key-required");
    }
    const identity = discoveryIdentity(draft.baseUrl, draft.proxy, key);
    try {
      const fetched = await fetchUpstreamModelCatalog({
        baseUrl: draft.baseUrl,
        apiKey: key,
        proxy: draft.proxy,
        resolveProxy,
        globalProxyUrl: typeof getNetworkProxyUrl === "function" ? getNetworkProxyUrl() : null,
      });
      lastUpstreamDiscovery = {
        identity,
        discovery: fetched.discovery,
      };
      const candidatePreview = modelMetadata.metadataPreview(
        fetched.discovery.ids.map(id => ({ id })),
        fetched.discovery,
        shellType(),
      );
      return {
        models: fetched.discovery.ids,
        candidates: candidatePreview.map(item => ({
          id: item.id,
          hasUpstreamMetadata: item.hasUpstreamMetadata,
          hasBundledMetadata: item.hasBundledMetadata,
          availableModes: item.availableModes,
          automaticMode: item.automaticMode,
        })),
        preview: modelMetadata.metadataPreview(draft.models, fetched.discovery, shellType()),
        sources: fetched.discovery.sources,
      };
    } catch {
      if (lastUpstreamDiscovery?.identity === identity) lastUpstreamDiscovery = null;
      return fail("upstream-fetch-failed");
    }
  }
  function daemonEnvironment() {
    try {
      if (readPolicyFile(filePath).policy.mode !== "api-key") return {};
    } catch { return {}; }
    let saved;
    try {
      const snapshot = readUpstreamConfig(upstreamFilePath);
      if (snapshot.resetReason) upstreamVault.clearStrict();
      saved = snapshot.config;
    }
    catch { return {}; }
    if (!saved) return {};
    const key = upstreamVault.read(saved.apiKeySha256);
    return key ? { CODEX_CHATGPT_WEB_UPSTREAM_API_KEY: key } : {};
  }
  function localClientEnvironment() {
    const environment = { ...process.env };
    for (const key of PROXY_ENV_KEYS) delete environment[key];
    const networkProxyUrl = typeof getNetworkProxyUrl === "function" ? getNetworkProxyUrl() : null;
    if (networkProxyUrl) {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        environment[key] = networkProxyUrl;
      }
    }
    const noProxy = mergeNoProxy(process.env.NO_PROXY, process.env.no_proxy);
    environment.NO_PROXY = noProxy;
    environment.no_proxy = noProxy;
    return environment;
  }
  function cancelModelCatalogRetry() {
    if (modelCatalogRetryTimer) clearTimer(modelCatalogRetryTimer);
    modelCatalogRetryTimer = null;
  }
  function modelCatalogMarkerState() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(modelCatalogPendingPath, "utf8")); }
    catch (error) {
      return error?.code === "ENOENT" ? "ready" : "pending";
    }
    return raw && typeof raw === "object" && !Array.isArray(raw) && raw.state === "export-required"
      ? "export-required"
      : "pending";
  }
  function markModelCatalogPending() {
    writePrivateFileAtomic(modelCatalogPendingPath, '{"version":2,"state":"pending"}\n');
    modelCatalogRefreshFailed = false;
  }
  async function withModelCatalogCommandLock(action) {
    const release = await acquireModelCatalogCommandLock(modelCatalogPendingPath);
    try { return await action(); }
    finally { release(); }
  }
  function scheduleModelCatalogRetry(delayMs = MODEL_CATALOG_RETRY_MS) {
    if (disposed || modelCatalogRetryTimer || modelCatalogMarkerState() !== "pending") return;
    modelCatalogRetryTimer = setTimer(() => {
      modelCatalogRetryTimer = null;
      return retryModelCatalogRefresh();
    }, delayMs);
    modelCatalogRetryTimer?.unref?.();
  }
  async function reconcileModelCatalog(name) {
    let restartFailed = false;
    try { restartFailed = await reconcile(name); }
    catch { restartFailed = true; }
    if (restartFailed) {
      modelCatalogRefreshFailed = fs.existsSync(modelCatalogPendingPath);
      cancelModelCatalogRetry();
      return await status();
    }
    return await refreshModelCatalogIfReady();
  }
  async function retryModelCatalogRefresh() {
    if (disposed || modelCatalogMarkerState() !== "pending") return;
    if (applying || runtimeHost.currentOperation()) {
      scheduleModelCatalogRetry();
      return;
    }
    let configured;
    try { configured = readPolicyFile(filePath).policy; }
    catch { return; }
    if (configured.mode !== "api-key") return;
    const runtime = runtimeSnapshot();
    if (!runtime.configured) {
      scheduleModelCatalogRetry(MODEL_CATALOG_WAIT_RETRY_MS);
      return;
    }
    const snapshot = await status();
    if (snapshot.upstream?.configured && !snapshot.upstream.keyAvailable) {
      modelCatalogRefreshFailed = true;
      return;
    }
    const health = await readHealth(runtime.config);
    if (browserHost?.activeTraceId || browserHost?.currentOperation()
      || (health && (health.active_http_turns > 0 || health.active_browser_turns > 0))) {
      scheduleModelCatalogRetry();
      return;
    }
    if (runtime.owner === "external") {
      if (snapshot.runtimeState === "in-sync") await refreshModelCatalogIfReady();
      else scheduleModelCatalogRetry(MODEL_CATALOG_WAIT_RETRY_MS);
      return;
    }
    await reconcileModelCatalog("api-access-upstream-settings");
  }
  async function refreshModelCatalogIfReady() {
    const snapshot = await status();
    const markerState = modelCatalogMarkerState();
    if (markerState === "ready" || markerState === "export-required") return snapshot;
    if (snapshot.runtimeState !== "in-sync") {
      modelCatalogRefreshFailed = false;
      scheduleModelCatalogRetry();
      return snapshot;
    }
    const policy = readPolicyFile(filePath).policy;
    const localKey = policy.mode === "api-key" ? vault.read(policy.keySha256) : null;
    if (!localKey) {
      modelCatalogRefreshFailed = true;
      return await status();
    }
    try {
      await runtimeHost.runLifecycleOperation("api-access-model-catalog-refresh", async () => {
        await runtimeHost.run("api-access-model-catalog-refresh", ["api-key", "refresh-models"], {
          embedded: true,
          message: "Refreshing API key model catalog",
          successMessage: "API key model catalog refreshed",
          timeoutMs: MODEL_CATALOG_COMMAND_TIMEOUT_MS,
          environment: localClientEnvironment(),
          env: { CODEX_CHATGPT_WEB_API_KEY: localKey },
        });
      });
      // The core CLI owns the post-command marker transition. Reading its result here avoids
      // overwriting a newer external CLI refresh/export that completed after this child process.
      if (modelCatalogMarkerState() === "export-required") cancelModelCatalogRetry();
    } catch {
      const latest = await status();
      if (latest.runtimeState !== "in-sync") {
        modelCatalogRefreshFailed = false;
        scheduleModelCatalogRetry();
        return latest;
      }
      modelCatalogRefreshFailed = true;
    }
    return await status();
  }
  async function refreshModelCatalog() {
    assertProduction();
    if (readPolicyFile(filePath).policy.mode !== "api-key") return await status();
    if (applying) fail("runtime-busy");
    applying = true;
    try {
      try { await withModelCatalogCommandLock(async () => { markModelCatalogPending(); }); }
      catch { return fail("save-failed"); }
      return await refreshModelCatalogIfReady();
    } finally { applying = false; }
  }
  function clearOwnedClipboard() {
    if (clipboardTimer) clearTimer(clipboardTimer);
    clipboardTimer = null;
    if (clipboardSecret !== null) {
      try { if (clipboard.readText() === clipboardSecret) clipboard.clear(); } catch {}
    }
    clipboardSecret = null;
  }
  function copyKey(key) {
    assertProduction();
    keyPolicy(key);
    clearOwnedClipboard();
    clipboard.writeText(key);
    clipboardSecret = key;
    clipboardTimer = setTimer(clearOwnedClipboard, 60_000);
    clipboardTimer?.unref?.();
    return true;
  }
  async function copyBaseUrl() {
    const snapshot = await status();
    if (!snapshot.baseUrl) fail("not-configured");
    clearOwnedClipboard();
    clipboard.writeText(snapshot.baseUrl);
    return true;
  }
  async function exportConfig() {
    assertProduction();
    const configuredPolicy = readPolicyFile(filePath).policy;
    if (configuredPolicy.mode !== "api-key") fail("api-mode-required");
    if (!runtimeHost.runtimeConfigSnapshot().configured) fail("not-configured");
    if (runtimeHost.currentOperation()) fail("runtime-busy");
    const current = await status();
    if (current.upstream?.configured && current.runtimeState !== "in-sync") fail("restart-required");
    const localKey = vault.read(configuredPolicy.keySha256);
    if (!localKey) fail("key-unavailable");
    return runtimeHost.runLifecycleOperation("api-access-export", async () => {
      try {
        const result = await runtimeHost.run("api-access-export", ["api-key", "codex-config", "--json"], {
          embedded: true,
          message: "Exporting sensitive API key client configuration",
          successMessage: "API key client configuration exported",
          timeoutMs: MODEL_CATALOG_COMMAND_TIMEOUT_MS,
          sensitiveOutput: true,
          environment: localClientEnvironment(),
          env: { CODEX_CHATGPT_WEB_API_KEY: localKey },
        });
        const exported = JSON.parse(result.stdout);
        if (!exported || typeof exported.config !== "string" || !exported.config.includes('requires_openai_auth = false')
          || !exported.config.includes("experimental_bearer_token") || exported.config.includes("env_key =")
          || typeof exported.catalog !== "string" || typeof exported.catalogPath !== "string"
          || !exported.environment || typeof exported.environment !== "object" || Array.isArray(exported.environment)) fail("export-failed");
        clearOwnedClipboard();
        clipboard.writeText(exported.config);
        return {
          config: exported.config,
          environment: exported.environment,
          catalogPath: exported.catalogPath,
          catalog: exported.catalog,
        };
      } catch {
        const latest = await status();
        if (latest.upstream?.configured && latest.runtimeState !== "in-sync") return fail("restart-required");
        return fail("export-failed");
      }
    });
  }
  scheduleModelCatalogRetry();
  return {
    status, apply, reveal, copyKey, copyBaseUrl, exportConfig,
    saveUpstream, deleteUpstream, fetchUpstreamModels, daemonEnvironment, refreshModelCatalog,
    generate: () => { assertProduction(); return `cgw_${randomBytes(32).toString("base64url")}`; },
    dispose: () => {
      disposed = true;
      cancelModelCatalogRetry();
      clearOwnedClipboard();
      vault.dispose();
      upstreamVault.dispose();
    },
  };
}

module.exports = {
  ApiAccessSettingsError, ERROR_CODES, createApiAccessSettings,
  keyPolicy, parsePolicy, policyRevision, upstreamProviderRevision, readPolicyFile, validateChange,
};
