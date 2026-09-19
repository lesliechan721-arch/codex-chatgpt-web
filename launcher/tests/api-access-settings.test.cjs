const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createCipheriv, createDecipheriv } = require("node:crypto");
const {
  createApiAccessSettings,
  keyPolicy,
  parsePolicy,
  policyRevision,
  upstreamProviderRevision,
  validateChange,
} = require("../electron/api-access-settings.cjs");
const { normalizeBaseUrl } = require("../electron/upstream-provider-config.cjs");
const { extractModelIds } = require("../electron/upstream-provider-network.cjs");
const KEY = "cgw_" + "a".repeat(43);
const NEXT = "cgw_" + "b".repeat(43);
const UPSTREAM_KEY = "provider key / punctuation !@#$%^&*()";
const ROOT = path.resolve(__dirname, "../..");

function apiKeyCli(home, args) {
  return spawnSync("bun", [path.join(ROOT, "src", "cli.ts"), "--home", home, "api-key", ...args], {
    cwd: ROOT,
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: path.join(home, "codex") },
    encoding: "utf8",
  });
}

function encryption() {
  const secret = Buffer.alloc(32, 7);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: text => {
      const cipher = createCipheriv("aes-256-gcm", secret, Buffer.alloc(12, 8));
      const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([cipher.getAuthTag(), data]);
    },
    decryptString: bytes => {
      const cipher = createDecipheriv("aes-256-gcm", secret, Buffer.alloc(12, 8));
      cipher.setAuthTag(bytes.subarray(0, 16));
      return Buffer.concat([cipher.update(bytes.subarray(16)), cipher.final()]).toString("utf8");
    },
  };
}
function fixture(t, options = {}) {
  const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "api-access-test-"));
  t.after(() => fs.rmSync(coreHome, { recursive: true, force: true }));
  const file = path.join(coreHome, "api-access.json");
  const config = { port: 17841, controlToken: "c".repeat(43) };
  const state = { configured: true, owner: "launcher", effective: { version: 1, mode: "openai" },
    effectiveUpstream: null,
    active: 0, operation: null, stopped: false, stopError: false, startError: false, cleanupError: false,
    stops: 0, starts: 0, commands: [], clipboard: "", timer: null, ...options };
  const host = {
    launcherProfile: state.profile ?? "production",
    currentOperation: () => state.operation,
    runtimeConfigSnapshot: () => ({ configured: state.configured, owner: state.owner, ...(state.configured ? { config } : {}) }),
    runLifecycleOperation: async (name, action) => {
      assert.equal(state.operation, null); state.operation = name;
      try { return await action(); } finally { state.operation = null; }
    },
    run: async (name, args, runOptions = {}) => {
      assert.equal(state.operation, name); state.commands.push(args);
      state.lastRunOptions = runOptions;
      if (args[1] === "reconnect" && state.reconnectError) throw new Error("route conflict");
      if (args[1] === "cleanup" && state.cleanupError) throw new Error("private arbitrary error");
      return { stdout: args[1] === "codex-config"
        ? `${JSON.stringify({
          config: `requires_openai_auth = false\nexperimental_bearer_token = ${JSON.stringify(runOptions.env?.CODEX_CHATGPT_WEB_API_KEY)}\n`,
          catalogPath: path.join(coreHome, "api-key-models.json"),
          catalog: '{"models":[]}\n',
          environment: { NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" },
        })}\n` : '{"changed":false}\n' };
    },
  };
  const supervisor = {
    proxyHealthPayload: async () => state.stopped ? null : ({
      service: "codex-chatgpt-web", status: "ok", accepting_turns: true,
      access_mode: state.effective.mode, api_access_revision: policyRevision(state.effective, config.controlToken),
      upstream_provider_revision: state.effectiveUpstream ? upstreamProviderRevision(state.effectiveUpstream, config.controlToken) : null,
      upstream_provider_key_matches: state.upstreamKeyMatches ?? Boolean(state.effectiveUpstream),
      upstream_provider_available: state.upstreamAvailable ?? Boolean(state.effectiveUpstream),
      active_http_turns: state.active, active_browser_turns: 0,
    }),
    stopForSetup: async () => {
      state.stops++; assert.ok(fs.existsSync(file), "policy is saved BEFORE stopping");
      if (state.stopError) throw new Error("stop failed"); state.stopped = true;
    },
    startIfConfigured: async () => {
      state.starts++; if (state.startError) throw new Error("start failed");
      state.effective = JSON.parse(fs.readFileSync(file, "utf8")); state.stopped = false;
      const upstreamFile = path.join(coreHome, "upstream-provider.json");
      state.effectiveUpstream = fs.existsSync(upstreamFile) ? JSON.parse(fs.readFileSync(upstreamFile, "utf8")) : null;
      return { status: "ready" };
    },
  };
  const safeStorage = options.safeStorage ?? encryption();
  const create = () => createApiAccessSettings({ coreHome, runtimeHost: host, supervisor,
    safeStorage, browserHost: { get activeTraceId() { return state.browserActive ? "trace" : null; }, currentOperation: () => null },
    resolveProxy: async () => "DIRECT",
    getNetworkProxyUrl: () => state.networkProxyUrl ?? null,
    confirmChange: () => { throw new Error("mode changes no longer require a second confirmation"); },
    clipboard: { readText: () => state.clipboard, writeText: text => { state.clipboard = text; }, clear: () => { state.clipboard = ""; } },
    setTimer: fn => { state.timer = fn; return { unref() {} }; }, clearTimer: () => { state.timer = null; },
  });
  const controller = create(); t.after(() => controller.dispose());
  const apply = async (mode = "api-key", key = KEY) => controller.apply({ mode,
    ...(key !== undefined && mode === "api-key" ? { key } : {}), expectedRevision: (await controller.status()).revision });
  return { controller, apply, state, file, coreHome, create, config };
}

test("mode/key are saved first, then the supervised runtime restarts", async t => {
  const f = fixture(t); const result = await f.apply();
  assert.equal(result.status.configuredMode, "api-key"); assert.equal(result.status.runtimeState, "in-sync");
  assert.equal(f.state.stops, 1); assert.equal(f.state.starts, 1);
  assert.deepEqual(f.state.commands[0], ["api-key", "cleanup"]);
  assert.equal(result.status.keyAvailable, true); assert.equal(f.controller.reveal(), KEY);
  const status = JSON.stringify(await f.controller.status()); assert.ok(!status.includes(KEY));
  assert.ok(!status.includes(keyPolicy(KEY).keySha256));
});
test("manual server mode GUI apply leaves old Codex ownership files byte-for-byte unchanged", async t => {
  const previous = process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
  process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
    else process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = previous;
  });
  const f = fixture(t);
  const codexHome = path.join(f.coreHome, "codex");
  fs.mkdirSync(codexHome, { recursive: true });
  const files = [
    [path.join(codexHome, "config.toml"), Buffer.from('model_provider = "user-owned"\n')],
    [path.join(codexHome, "integration-journal.json"), Buffer.from('{"version":1,"sentinel":"old-owner"}\n')],
    [path.join(codexHome, "models.json"), Buffer.from('{"sentinel":"user-cache"}\n')],
  ];
  for (const [file, bytes] of files) fs.writeFileSync(file, bytes);
  const before = files.map(([file]) => fs.readFileSync(file));

  const result = await f.apply();

  assert.equal(result.status.configuredMode, "api-key");
  assert.equal(result.status.cleanupPending, false);
  assert.equal(f.state.commands.some(args => args[0] === "api-key" && args[1] === "cleanup"), false);
  files.forEach(([file], index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});
test("server host port override is used for the Launcher client Base URL fallback", async t => {
  const previous = process.env.CODEX_CHATGPT_WEB_CLIENT_PORT;
  process.env.CODEX_CHATGPT_WEB_CLIENT_PORT = "27841";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_CLIENT_PORT;
    else process.env.CODEX_CHATGPT_WEB_CLIENT_PORT = previous;
  });
  const f = fixture(t);
  assert.equal((await f.controller.status()).baseUrl, "http://127.0.0.1:27841/v1");
});
test("missing key prevents first enable, without any write or restart", async t => {
  const f = fixture(t);
  await assert.rejects(f.controller.apply({ mode: "api-key", expectedRevision: (await f.controller.status()).revision }), /key-required/);
  assert.equal(fs.existsSync(f.file), false); assert.equal(f.state.stops, 0);
});
for (const scenario of ["stopError", "startError", "browserActive"]) {
  test(`${scenario} does not roll back or reject a saved mode`, async t => {
    const f = fixture(t, { [scenario]: true }); const result = await f.apply();
    assert.equal(JSON.parse(fs.readFileSync(f.file)).mode, "api-key");
    assert.notEqual(result.status.runtimeState, "in-sync"); assert.equal(f.controller.reveal(), KEY);
  });
}
test("active HTTP turns defer restart, not saving; retry applies the same key", async t => {
  const f = fixture(t, { active: 1 }); const first = await f.apply();
  assert.equal(first.status.runtimeState, "restart-required"); assert.equal(f.state.stops, 0);
  f.state.active = 0;
  const result = await f.controller.apply({ mode: "api-key", expectedRevision: first.status.revision });
  assert.equal(result.status.runtimeState, "in-sync"); assert.equal(f.controller.reveal(), KEY);
});
test("another launcher operation does not prevent saving", async t => {
  const f = fixture(t, { operation: "mcp-setup" }); const result = await f.apply();
  assert.equal(result.status.configuredMode, "api-key"); assert.equal(result.status.cleanupPending, true);
  assert.equal(f.state.stops, 0); assert.equal(f.state.commands.length, 0);
});
test("failed cleanup is visible but neither saving nor restarting is cancelled", async t => {
  const f = fixture(t, { cleanupError: true }); const result = await f.apply();
  assert.equal(result.status.cleanupPending, true); assert.equal(result.status.runtimeState, "in-sync");
});
test("first-time and externally managed runtime accept saved preferences", async t => {
  for (const option of [{ configured: false }, { owner: "external" }]) {
    const f = fixture(t, option); assert.equal((await f.apply()).status.configuredMode, "api-key");
    assert.equal(f.state.stops, 0);
  }
});
test("key reset replaces authentication digest and survives a Launcher restart encrypted", async t => {
  const f = fixture(t); await f.apply(); await f.apply("api-key", NEXT);
  assert.equal(f.state.effective.keySha256, keyPolicy(NEXT).keySha256);
  assert.equal(f.controller.reveal(), NEXT); f.controller.dispose();
  const next = f.create(); t.after(() => next.dispose()); assert.equal(next.reveal(), NEXT);
  const disk = fs.readFileSync(path.join(f.coreHome, "secrets", "api-client-key.json"), "utf8");
  assert.ok(!disk.includes(NEXT)); assert.ok(!disk.includes(KEY));
});
test("disable and re-enable can reuse the sealed key without requiring a new key", async t => {
  const f = fixture(t); await f.apply(); await f.apply("openai");
  assert.equal((await f.controller.status()).keyAvailable, true);
  await assert.rejects(async () => f.controller.reveal(), /api-mode-required/);
  const result = await f.controller.apply({ mode: "api-key", expectedRevision: (await f.controller.status()).revision });
  assert.equal(result.status.runtimeState, "in-sync"); assert.equal(f.controller.reveal(), KEY);
});
test("CLI rotation and disable cannot reactivate the revoked GUI key", async t => {
  const f = fixture(t); await f.apply();
  const rotated = apiKeyCli(f.coreHome, ["rotate", "--generate"]);
  assert.equal(rotated.status, 0, rotated.stderr || rotated.error?.message);
  const disabled = apiKeyCli(f.coreHome, ["disable"]);
  assert.equal(disabled.status, 0, disabled.stderr || disabled.error?.message);
  const status = await f.controller.status();
  assert.equal(status.configuredMode, "openai");
  assert.equal(status.keyAvailable, false);
  await assert.rejects(f.controller.apply({ mode: "api-key", expectedRevision: status.revision }), /key-required/);
});
test("digest-only keys still authenticate but are not fabricated by reveal", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify(keyPolicy(KEY)));
  assert.equal((await f.controller.status()).keyConfigured, true); assert.equal((await f.controller.status()).keyAvailable, false);
  assert.throws(() => f.controller.reveal(), /key-unavailable/);
  await f.apply("api-key", NEXT); assert.equal(f.controller.reveal(), NEXT);
});
test("a CLI-rotated digest cannot reveal the previously sealed key", async t => {
  const f = fixture(t); await f.apply(); fs.writeFileSync(f.file, JSON.stringify(keyPolicy(NEXT)));
  assert.equal((await f.controller.status()).keyAvailable, false); assert.throws(() => f.controller.reveal(), /key-unavailable/);
});
test("unavailable OS encryption is session-only, never plaintext on disk", async t => {
  const f = fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  assert.equal((await f.apply()).status.keyStorage, "session"); assert.equal(f.controller.reveal(), KEY);
  assert.equal(fs.existsSync(path.join(f.coreHome, "secrets", "api-client-key.json")), false);
  f.controller.dispose(); assert.throws(() => f.controller.reveal(), /key-unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).keySha256, keyPolicy(KEY).keySha256);
});
test("stale forms and management-token reuse cannot replace a key", async t => {
  const f = fixture(t); const before = await f.controller.status(); await f.apply();
  await assert.rejects(f.controller.apply({ mode: "api-key", key: NEXT, expectedRevision: before.revision }), /stale-settings/);
  await assert.rejects(f.apply("api-key", f.config.controlToken), /control-key-reuse/);
  assert.equal(f.controller.reveal(), KEY);
});
test("malformed policy fails closed and does not leak rejected data", async t => {
  const f = fixture(t); fs.writeFileSync(f.file, KEY);
  assert.equal((await f.controller.status()).configuredMode, "invalid");
  assert.throws(() => parsePolicy({ version: 1, mode: "api-key", key: KEY }), /invalid-policy/);
  assert.throws(() => validateChange({ mode: "api-key", key: KEY, expectedRevision: "invalid" }), /invalid-input/);
});
test("secret clipboard expires conditionally and is cleared on rotation", async t => {
  const f = fixture(t); await f.apply(); f.controller.copyKey(KEY); const expire = f.state.timer;
  f.state.clipboard = "unrelated"; expire(); assert.equal(f.state.clipboard, "unrelated");
  f.controller.copyKey(KEY); await f.apply("api-key", NEXT); assert.equal(f.state.clipboard, "");
});
test("export is an explicit sensitive action that embeds only the local key and separates process environment", async t => {
  const f = fixture(t); await f.apply(); const result = await f.controller.exportConfig();
  assert.ok(result.config.includes("requires_openai_auth = false")); assert.ok(result.config.includes(KEY));
  assert.ok(!result.config.includes(UPSTREAM_KEY));
  assert.equal(result.catalog, '{"models":[]}\n');
  assert.equal(result.catalogPath, path.join(f.coreHome, "api-key-models.json"));
  assert.equal(result.environment.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "codex-config", "--json"]);
  assert.equal(f.state.lastRunOptions.sensitiveOutput, true);
  assert.equal(f.state.lastRunOptions.env.CODEX_CHATGPT_WEB_API_KEY, KEY);
});
test("upstream settings persist no plaintext key and expose the key only to the daemon environment", async t => {
  const f = fixture(t); await f.apply();
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" },
    modelFilter: { mode: "selected", models: ["gpt-b", "gpt-b", "gpt-a"] },
    supportsOpenAiServerCompaction: true,
  });
  const saved = JSON.parse(fs.readFileSync(path.join(f.coreHome, "upstream-provider.json"), "utf8"));
  assert.equal(saved.baseUrl, "http://127.0.0.1:11434/v1/");
  assert.deepEqual(saved.modelFilter, { mode: "selected", models: ["gpt-b", "gpt-a"] });
  assert.equal(saved.supportsOpenAiServerCompaction, true);
  assert.ok(!JSON.stringify(saved).includes(UPSTREAM_KEY));
  assert.deepEqual(f.controller.daemonEnvironment(), { CODEX_CHATGPT_WEB_UPSTREAM_API_KEY: UPSTREAM_KEY });
  assert.equal(result.status.upstream.keyAvailable, true);
  assert.equal(result.status.upstream.runtimeAvailable, true);
  assert.equal(result.status.runtimeState, "in-sync");
});

test("stale upstream health stays pending when the old daemon still reports its provider available", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  f.state.active = 1;
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1",
    proxy: { mode: "global" }, modelFilter: { mode: "regex", pattern: "^gpt-next$" },
    supportsOpenAiServerCompaction: false,
  });
  assert.equal(result.status.runtimeState, "restart-required");
  assert.equal(result.status.upstream.runtimeAvailable, false);
});

test("OS-encrypted upstream key is recoverable by a restarted Launcher controller", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  f.controller.dispose();
  const restarted = f.create(); t.after(() => restarted.dispose());
  assert.equal((await restarted.status()).upstream.keyStorage, "os");
  assert.deepEqual(restarted.daemonEnvironment(), { CODEX_CHATGPT_WEB_UPSTREAM_API_KEY: UPSTREAM_KEY });
  const disk = fs.readFileSync(path.join(f.coreHome, "secrets", "upstream-api-key.json"), "utf8");
  assert.ok(!disk.includes(UPSTREAM_KEY));
});

for (const [scenario, breakDecrypt] of [
  ["decrypt failure", safeStorage => { safeStorage.decryptString = () => { throw new Error("locked"); }; }],
  ["decrypted key digest mismatch", safeStorage => { safeStorage.decryptString = () => `${UPSTREAM_KEY}-different`; }],
]) {
  test(`unreadable OS-encrypted upstream key is unavailable after ${scenario}`, async t => {
    const safeStorage = encryption();
    const f = fixture(t, { safeStorage }); await f.apply();
    await f.controller.saveUpstream({
      expectedRevision: (await f.controller.status()).revision,
      baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
      proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
    });
    f.controller.dispose();
    breakDecrypt(safeStorage);
    const restarted = f.create(); t.after(() => restarted.dispose());
    const status = await restarted.status();
    assert.equal(status.upstream.keyAvailable, false);
    assert.equal(status.upstream.keyStorage, "unavailable");
    assert.equal(status.upstream.runtimeAvailable, false);
    assert.equal(status.runtimeState, "restart-required");
    assert.deepEqual(restarted.daemonEnvironment(), {});
  });
}

test("deleting upstream settings clears both provider intent and recoverable key", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  const result = await f.controller.deleteUpstream({ expectedRevision: (await f.controller.status()).revision });
  assert.equal(result.status.upstream.configured, false);
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider.json")), false);
  assert.equal(fs.existsSync(path.join(f.coreHome, "secrets", "upstream-api-key.json")), false);
  assert.deepEqual(f.controller.daemonEnvironment(), {});
});

test("saved upstream settings do not affect OpenAI forwarding mode or its daemon environment", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  const result = await f.controller.apply({ mode: "openai", expectedRevision: (await f.controller.status()).revision });
  assert.equal(result.status.configuredMode, "openai");
  assert.equal(result.status.runtimeState, "in-sync");
  assert.deepEqual(f.controller.daemonEnvironment(), {});
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider.json")), true);
});

test("upstream key is session-only when OS encryption is unavailable", async t => {
  const f = fixture(t, { safeStorage: { isEncryptionAvailable: () => false } }); await f.apply();
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  assert.equal(result.status.upstream.keyStorage, "session");
  assert.equal(fs.existsSync(path.join(f.coreHome, "secrets", "upstream-api-key.json")), false);
  f.controller.dispose();
  f.state.upstreamKeyMatches = false;
  f.state.upstreamAvailable = false;
  const restarted = f.create(); t.after(() => restarted.dispose());
  const status = await restarted.status();
  assert.equal(status.upstream.configured, true);
  assert.equal(status.upstream.keyAvailable, false);
  assert.equal(status.upstream.runtimeAvailable, false);
  assert.equal(status.runtimeState, "restart-required");
  assert.deepEqual(restarted.daemonEnvironment(), {});
  const stops = f.state.stops;
  const retried = await restarted.apply({ mode: "api-key", expectedRevision: status.revision });
  assert.equal(f.state.stops, stops + 1);
  assert.equal(retried.status.runtimeState, "restart-required");
});

test("OpenAI forwarding ignores a malformed inactive upstream configuration", async t => {
  const f = fixture(t);
  const upstreamFile = path.join(f.coreHome, "upstream-provider.json");
  fs.writeFileSync(upstreamFile, "{malformed\n");
  const status = await f.controller.status();
  assert.equal(status.configuredMode, "openai");
  assert.equal(status.runtimeState, "in-sync");
  assert.equal(status.canApply, true);
  assert.ok(status.revision);
  const result = await f.controller.apply({ mode: "openai", expectedRevision: status.revision });
  assert.equal(result.status.configuredMode, "openai");
  assert.equal(result.status.runtimeState, "in-sync");
  assert.equal(fs.readFileSync(upstreamFile, "utf8"), "{malformed\n");
});

test("invalid upstream filters and stale revisions cannot overwrite provider settings", async t => {
  const f = fixture(t); await f.apply(); const revision = (await f.controller.status()).revision;
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "regex", pattern: "[" }, supportsOpenAiServerCompaction: false,
  }), /invalid-upstream-filter/);
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider.json")), false);
  await f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  });
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://other.example/v1",
    proxy: { mode: "global" }, modelFilter: { mode: "all" }, supportsOpenAiServerCompaction: false,
  }), /stale-settings/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.coreHome, "upstream-provider.json"), "utf8")).baseUrl,
    "https://provider.example/v1/");
});

test("upstream Base URL rejects empty query and fragment delimiters", () => {
  for (const value of [
    "http://127.0.0.1:9999/v1?",
    "http://127.0.0.1:9999/v1#",
    "http://127.0.0.1:9999/v1?#",
  ]) {
    assert.throws(() => normalizeBaseUrl(value), /invalid-upstream-config/);
  }
});

test("Codex export uses only the configured global proxy and keeps loopback in NO_PROXY", async t => {
  const f = fixture(t, { networkProxyUrl: "http://proxy.example:8080/" }); await f.apply();
  await f.controller.exportConfig();
  const environment = f.state.lastRunOptions.environment;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    assert.equal(environment[key], f.state.networkProxyUrl);
  }
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.ok(environment.NO_PROXY.includes(host));
});

test("manual model discovery uses draft settings and does not persist provider intent", async t => {
  const f = fixture(t); await f.apply();
  const before = await f.controller.status();
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/models");
    assert.equal(request.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      object: "list",
      data: [{ id: "gpt-one" }, { id: "gpt-one" }, { id: "chatgpt-web/high" }],
      models: [{
        slug: "gpt-two",
        display_name: "GPT Two",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: null,
        context_window: 128000,
      }],
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await f.controller.fetchUpstreamModels({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" },
  });
  assert.deepEqual(result.models, ["gpt-one", "gpt-two"]);
  const after = await f.controller.status();
  assert.equal(after.revision, before.revision);
  assert.equal(after.upstream.configured, false);
});

test("manual model discovery rejects slug-only incompatible Codex rich rows", () => {
  assert.throws(() => extractModelIds({
    object: "list",
    data: [{ id: "gpt-standard" }],
    models: [{ slug: "gpt-slug-only" }],
  }), /upstream-fetch-failed/);
});

test("manual model discovery reuses the authenticated Launcher global proxy", async t => {
  let proxyAuthorization = null;
  const proxy = http.createServer((request, response) => {
    proxyAuthorization = request.headers["proxy-authorization"] || null;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-via-proxy" }] }));
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const proxyUrl = new URL(`http://127.0.0.1:${address.port}`);
  proxyUrl.username = "proxy-user";
  proxyUrl.password = "proxy-pass";
  const f = fixture(t, { networkProxyUrl: proxyUrl.href }); await f.apply();
  const result = await f.controller.fetchUpstreamModels({
    baseUrl: "http://models-target.invalid/v1",
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" },
  });
  assert.deepEqual(result.models, ["gpt-via-proxy"]);
  assert.match(proxyAuthorization, /^Basic /);
});

test("manual model discovery can reuse the saved provider key", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://saved-provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, modelFilter: { mode: "selected", models: ["gpt-saved"] },
    supportsOpenAiServerCompaction: false,
  });
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-live" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const fetched = await f.controller.fetchUpstreamModels({
    baseUrl: `http://127.0.0.1:${address.port}/v1`, proxy: { mode: "direct" },
  });
  assert.deepEqual(fetched.models, ["gpt-live"]);
  assert.deepEqual((await f.controller.status()).upstream.modelFilter, { mode: "selected", models: ["gpt-saved"] });
});
test("DEV profile cannot change production API access", async t => {
  const f = fixture(t, { profile: "development" }); await assert.rejects(f.controller.status(), /dev-profile/);
});

test("OpenAI switch restores only forwarding integration and persists through a route conflict", async t => {
  const f = fixture(t); await f.apply(); f.state.reconnectError = true;
  const result = await f.apply("openai");
  assert.equal(result.status.configuredMode, "openai"); assert.equal(result.status.routingPending, true);
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "reconnect"]);
  assert.equal(result.status.runtimeState, "in-sync");
});
test("a failed OpenAI reconnect remains pending after the controller restarts", async t => {
  const f = fixture(t); await f.apply(); f.state.reconnectError = true;
  await f.apply("openai"); f.controller.dispose();
  const pending = path.join(f.coreHome, "api-access-routing-pending.json");
  assert.equal(fs.existsSync(pending), true);
  const restarted = f.create(); t.after(() => restarted.dispose());
  assert.equal((await restarted.status()).routingPending, true);
  f.state.reconnectError = false;
  const result = await restarted.apply({ mode: "openai", expectedRevision: (await restarted.status()).revision });
  assert.equal(result.status.routingPending, false);
  assert.equal(fs.existsSync(pending), false);
});
test("disabling after an external key rotation does not reactivate a revoked GUI key", async t => {
  const f = fixture(t); await f.apply(); fs.writeFileSync(f.file, JSON.stringify(keyPolicy(NEXT)));
  await f.apply("openai");
  assert.equal((await f.controller.status()).keyAvailable, false);
  await assert.rejects(f.controller.apply({ mode: "api-key", expectedRevision: (await f.controller.status()).revision }), /key-required/);
});
