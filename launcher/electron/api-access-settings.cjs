const fs = require("node:fs");
const path = require("node:path");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

// Mirrors the version-1 core wire format. Conformance is covered by the core/Bun test.
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const OPENAI_POLICY = Object.freeze({ version: 1, mode: "openai" });
const MAX_POLICY_BYTES = 4096;
const ERROR_CODES = new Set([
  "invalid-policy", "invalid-input", "invalid-key", "key-required", "control-key-reuse",
  "stale-settings", "runtime-busy", "external-runtime", "dev-profile", "not-configured",
  "api-mode-required", "stop-failed", "apply-failed-restored", "saved-runtime-unverified",
  "recovery-failed", "export-failed", "unavailable", "untrusted-sender",
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

/** Main-process only. No keys, hashes or request bodies enter logs, stateStore or broadcasts. */
function createApiAccessSettings({
  coreHome, runtimeHost, supervisor, browserHost, confirmChange,
  clipboard, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const filePath = path.join(coreHome, "api-access.json");
  const revisionSecret = randomBytes(32);
  let clipboardSecret = null;
  let clipboardTimer = null;
  const revisionOf = snapshot => createHmac("sha256", revisionSecret)
    .update(snapshot.bytes ?? "absent-policy-file").digest("hex");
  const assertProduction = () => {
    if (runtimeHost.launcherProfile === "development") fail("dev-profile");
  };
  const assertBrowserIdle = () => {
    if (browserHost?.activeTraceId || browserHost?.currentOperation()) fail("runtime-busy");
  };
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
      keyConfigured: false, runtimeState: "invalid", baseUrl: null, canApply: false }; }
    const runtime = runtimeHost.runtimeConfigSnapshot();
    const config = runtime.config;
    const health = await readHealth(config);
    const effectiveMode = ["openai", "api-key"].includes(health?.access_mode) ? health.access_mode : null;
    const matches = Boolean(config && health && health.api_access_revision
      && health.api_access_revision === policyRevision(saved.policy, config.controlToken));
    return {
      configuredMode: saved.policy.mode,
      effectiveMode,
      revision: revisionOf(saved),
      keyConfigured: saved.policy.mode === "api-key",
      runtimeState: !runtime.configured ? "unconfigured"
        : !health ? "stopped"
          : matches ? "in-sync" : "restart-required",
      baseUrl: config ? `http://127.0.0.1:${config.port}/v1` : null,
      canApply: runtime.owner !== "external",
    };
  }
  function assertUnchanged(revision) {
    const current = readPolicyFile(filePath);
    if (revisionOf(current) !== revision) fail("stale-settings");
    return current;
  }
  async function verify(policy, config) {
    const health = await readHealth(config);
    if (!health || health.accepting_turns !== true
      || health.api_access_revision !== policyRevision(policy, config.controlToken)) fail("unavailable");
  }
  async function apply(raw) {
    assertProduction();
    const input = validateChange(raw);
    const name = "api-access-settings";
    if (runtimeHost.currentOperation()) fail("runtime-busy");
    return runtimeHost.runLifecycleOperation(name, async () => {
      assertBrowserIdle();
      const before = assertUnchanged(input.expectedRevision);
      const runtime = runtimeHost.runtimeConfigSnapshot();
      if (runtime.owner === "external") fail("external-runtime");
      const next = input.mode === "openai" ? OPENAI_POLICY
        : input.key !== undefined ? keyPolicy(input.key)
          : before.policy.mode === "api-key" ? before.policy : fail("key-required");
      if (next.mode === "api-key" && runtime.config?.controlToken
        && keyPolicy(runtime.config.controlToken).keySha256 === next.keySha256) fail("control-key-reuse");
      const confirmed = await confirmChange({
        mode: next.mode,
        replacingKey: before.policy.mode === "api-key" && next.mode === "api-key"
          && before.policy.keySha256 !== next.keySha256,
        configured: runtime.configured,
      });
      if (!confirmed) return { cancelled: true, status: await status() };
      assertBrowserIdle();
      assertUnchanged(input.expectedRevision);
      const config = runtime.config;
      const health = await readHealth(config);
      if (health && (health.active_http_turns > 0 || health.active_browser_turns > 0)) fail("runtime-busy");
      if (runtime.configured) {
        try { await supervisor.stopForSetup(); }
        catch { return fail("stop-failed"); }
      }
      // A concurrent CLI write after the drain must not be overwritten.
      try { assertUnchanged(input.expectedRevision); }
      catch (error) {
        if (runtime.configured) {
          try { await supervisor.startIfConfigured(); } catch {}
        }
        throw error;
      }
      const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
      let written = false;
      try {
        writePrivateFileAtomic(filePath, bytes);
        written = true;
        if (runtime.configured) {
          const started = await supervisor.startIfConfigured();
          if (started.status !== "ready") fail("unavailable");
          await verify(next, config);
        }
        return { cancelled: false, status: await status() };
      } catch {
        // Never roll the file back while a replacement daemon could still be serving the new key.
        if (runtime.configured) {
          try { await supervisor.stopForSetup(); }
          catch { return fail(written ? "saved-runtime-unverified" : "recovery-failed"); }
        }
        try {
          const current = readPolicyFile(filePath);
          if (written && !current.bytes?.equals(bytes)) fail("stale-settings");
          if (!written && revisionOf(current) !== input.expectedRevision) fail("stale-settings");
          if (before.bytes === null) fs.rmSync(filePath, { force: true });
          else writePrivateFileAtomic(filePath, before.bytes);
          if (runtime.configured) {
            const recovered = await supervisor.startIfConfigured();
            if (recovered.status !== "ready") fail("unavailable");
            await verify(before.policy, config);
          }
        } catch { return fail("recovery-failed"); }
        return fail("apply-failed-restored");
      }
    });
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
    status, apply, copyKey, copyBaseUrl, exportConfig,
    generate: () => { assertProduction(); return `cgw_${randomBytes(32).toString("base64url")}`; },
    dispose: clearOwnedClipboard,
  };
}

module.exports = {
  ApiAccessSettingsError, ERROR_CODES, createApiAccessSettings,
  keyPolicy, parsePolicy, policyRevision, readPolicyFile, validateChange,
};
