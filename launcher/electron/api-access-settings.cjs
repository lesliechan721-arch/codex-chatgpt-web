const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { createApiKeyVault } = require("./api-key-vault.cjs");

// Mirrors the version-1 core wire format. Conformance is covered by the core/Bun test.
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const OPENAI_POLICY = Object.freeze({ version: 1, mode: "openai" });
const MAX_POLICY_BYTES = 4096;
const ERROR_CODES = new Set([
  "invalid-policy", "invalid-input", "invalid-key", "key-required", "control-key-reuse",
  "stale-settings", "runtime-busy", "external-runtime", "dev-profile", "not-configured",
  "api-mode-required", "stop-failed", "apply-failed-restored", "saved-runtime-unverified",
  "recovery-failed", "export-failed", "unavailable", "untrusted-sender",
  "save-failed", "key-unavailable",
]);

class ApiAccessSettingsError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ApiAccessSettingsError(code); };

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
}) {
  if (safeStorage === undefined) {
    try { safeStorage = require("electron").safeStorage; } catch { /* Node tests / headless host. */ }
  }
  const vault = createApiKeyVault({ coreHome, safeStorage });
  const filePath = path.join(coreHome, "api-access.json");
  const revisionSecret = randomBytes(32);
  let clipboardSecret = null;
  let clipboardTimer = null;
  let applying = false;
  let cleanupPending = false;
  let routingPending = false;
  const revisionOf = snapshot => createHmac("sha256", revisionSecret)
    .update(snapshot.bytes ?? "absent-policy-file").digest("hex");
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
    try { saved = readPolicyFile(filePath); }
    catch { return { configuredMode: "invalid", effectiveMode: null, revision: null,
      keyConfigured: false, keyAvailable: false, keyStorage: "unavailable",
      runtimeState: "invalid", baseUrl: null, canApply: false, cleanupPending }; }
    const runtime = runtimeSnapshot();
    const config = runtime.config;
    const health = await readHealth(config);
    const effectiveMode = ["openai", "api-key"].includes(health?.access_mode) ? health.access_mode : null;
    const matches = Boolean(config && health && health.api_access_revision
      && health.api_access_revision === policyRevision(saved.policy, config.controlToken));
    const key = vault.info(saved.policy.mode === "api-key" ? saved.policy.keySha256 : undefined);
    return {
      configuredMode: saved.policy.mode,
      effectiveMode,
      revision: revisionOf(saved),
      keyConfigured: saved.policy.mode === "api-key",
      keyAvailable: key.available,
      keyStorage: key.storage,
      runtimeState: !runtime.configured ? "unconfigured"
        : !health ? "stopped" : matches && health.accepting_turns === true ? "in-sync" : "restart-required",
      baseUrl: config ? `http://127.0.0.1:${config.port}/v1` : null,
      canApply: true,
      routingPending: saved.policy.mode === "openai" && routingPending,
      cleanupPending: saved.policy.mode === "api-key" && (cleanupPending
        || fs.existsSync(path.join(coreHome, "codex", "integration-journal.json"))
        || fs.existsSync(path.join(coreHome, "codex", "integration-journal.recovery.json"))),
    };
  }
  function assertUnchanged(revision) {
    const current = readPolicyFile(filePath);
    if (revisionOf(current) !== revision) fail("stale-settings");
    return current;
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
    cleanupPending = configured.mode === "api-key";
    routingPending = configured.mode === "openai" && runtimeSnapshot().configured;
    if (runtimeHost.currentOperation()) return;
    await runtimeHost.runLifecycleOperation(name, async () => {
      if (configured.mode === "api-key") {
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
        } catch { /* Conflicting user routes are not force-replaced. */ }
      }
      if (!runtime.configured || runtime.owner === "external") return;
      const health = await readHealth(runtime.config);
      if (health?.accepting_turns === true
        && health.api_access_revision === policyRevision(readPolicyFile(filePath).policy, runtime.config.controlToken)) return;
      if (browserHost?.activeTraceId || browserHost?.currentOperation()
        || (health && (health.active_http_turns > 0 || health.active_browser_turns > 0))) return;
      // Restart only supervised runtimes after their existing atomic idle/drain check. No app
      // relaunch and no forced turn cancellation; failed stops/starts leave the saved intent intact.
      try {
        await supervisor.stopForSetup();
        await supervisor.startIfConfigured();
      } catch { /* status() reports pending/unreachable, never "applied" by inference. */ }
    });
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
      const controlToken = runtimeSnapshot().config?.controlToken;
      if (next.mode === "api-key" && typeof controlToken === "string"
        && createHash("sha256").update(controlToken).digest("hex") === next.keySha256) fail("control-key-reuse");
      // No await between optimistic concurrency check and atomic write.
      assertUnchanged(input.expectedRevision);
      try { writePrivateFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`); }
      catch { return fail("save-failed"); }
      clearOwnedClipboard();
      // An external CLI rotation must not make disabling/re-enabling resurrect an old GUI key.
      if (input.mode === "openai" && before.policy.mode === "api-key") vault.retainOnly(before.policy.keySha256);
      if (key !== undefined) vault.store(key);
      try { await reconcile("api-access-settings"); } catch { /* Saved policy is authoritative. */ }
      return { cancelled: false, status: await status() };
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
    if (readPolicyFile(filePath).policy.mode !== "api-key") fail("api-mode-required");
    if (!runtimeHost.runtimeConfigSnapshot().configured) fail("not-configured");
    if (runtimeHost.currentOperation()) fail("runtime-busy");
    return runtimeHost.runLifecycleOperation("api-access-export", async () => {
      try {
        const result = await runtimeHost.run("api-access-export", ["api-key", "codex-config"], {
          embedded: true,
          message: "Exporting API key client configuration (no secret)",
          successMessage: "API key client configuration exported",
          timeoutMs: 15_000,
        });
        if (!result.stdout.includes('requires_openai_auth = false')
          || !result.stdout.includes('env_key = "CODEX_CHATGPT_WEB_API_KEY"')) fail("export-failed");
        clearOwnedClipboard();
        clipboard.writeText(result.stdout);
        return { config: result.stdout, catalogPath: path.join(coreHome, "api-key-models.json") };
      } catch { return fail("export-failed"); }
    });
  }
  return {
    status, apply, reveal, copyKey, copyBaseUrl, exportConfig,
    generate: () => { assertProduction(); return `cgw_${randomBytes(32).toString("base64url")}`; },
    dispose: () => { clearOwnedClipboard(); vault.dispose(); },
  };
}

module.exports = {
  ApiAccessSettingsError, ERROR_CODES, createApiAccessSettings,
  keyPolicy, parsePolicy, policyRevision, readPolicyFile, validateChange,
};
