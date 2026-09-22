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
const { acquireModelCatalogCommandLock } = require("../electron/model-catalog-command-lock.cjs");
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
  const modelCatalogPendingPath = path.join(coreHome, "api-key-models-refresh-pending.json");
  const config = { port: 17841, controlToken: "c".repeat(43) };
  const state = { configured: true, owner: "launcher", effective: { version: 1, mode: "openai" },
    effectiveUpstream: null,
    active: 0, operation: null, stopped: false, stopError: false, startError: false, cleanupError: false,
    stops: 0, starts: 0, commands: [], clipboard: "", timer: null, timerSchedules: 0, ...options };
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
      if (args[1] === "refresh-models" && state.refreshError) throw new Error("model catalog refresh failed");
      if (args[1] === "codex-config" && state.exportStale) {
        state.effectiveUpstream = null;
        throw new Error("upstream runtime changed");
      }
      if (args[1] === "refresh-models") {
        const externalClient = runOptions.environment?.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG?.trim() === "1"
          || Boolean(runOptions.environment?.CODEX_CHATGPT_WEB_PUBLIC_BASE_URL?.trim());
        if (externalClient) fs.writeFileSync(modelCatalogPendingPath, '{"version":2,"state":"export-required"}\n');
        else fs.rmSync(modelCatalogPendingPath, { force: true });
      }
      if (args[1] === "codex-config") fs.rmSync(modelCatalogPendingPath, { force: true });
      if (typeof state.afterRun === "function") await state.afterRun(args, { coreHome, modelCatalogPendingPath });
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
    onModeCommitted: options.onModeCommitted,
    onModeSettled: options.onModeSettled,
    confirmChange: () => { throw new Error("mode changes no longer require a second confirmation"); },
    clipboard: { readText: () => state.clipboard, writeText: text => { state.clipboard = text; }, clear: () => { state.clipboard = ""; } },
    setTimer: fn => { state.timer = fn; state.timerSchedules++; return { unref() {} }; }, clearTimer: () => { state.timer = null; },
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
test("API access mode transition hooks run only when the saved mode changes", async t => {
  const events = [];
  const f = fixture(t, {
    onModeCommitted: change => events.push(["committed", change]),
    onModeSettled: change => events.push(["settled", change]),
  });

  await f.apply();
  await f.apply("api-key", undefined);
  await f.apply("openai", undefined);

  assert.deepEqual(events, [
    ["committed", { previousMode: "openai", mode: "api-key" }],
    ["settled", { previousMode: "openai", mode: "api-key" }],
    ["committed", { previousMode: "api-key", mode: "openai" }],
    ["settled", { previousMode: "api-key", mode: "openai" }],
  ]);
});
test("mode transition hook failures do not interrupt committed reconciliation or settle", async t => {
  const events = [];
  const f = fixture(t, {
    onModeCommitted: () => {
      events.push("committed");
      throw new Error("state persistence failed");
    },
    onModeSettled: () => {
      events.push("settled");
      throw new Error("settle notification failed");
    },
  });

  const result = await f.apply();

  assert.equal(result.status.configuredMode, "api-key");
  assert.equal(result.status.runtimeState, "in-sync");
  assert.equal(f.state.stops, 1);
  assert.equal(f.state.starts, 1);
  assert.deepEqual(events, ["committed", "settled"]);
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
test("manual server mode records export-required after refresh until explicit export", async t => {
  const previous = process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
  process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
    else process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = previous;
  });
  const f = fixture(t); await f.apply();
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");

  const refreshed = await f.controller.refreshModelCatalog();
  assert.equal(refreshed.modelCatalogState, "export-required");
  assert.equal(fs.existsSync(pendingPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath, "utf8")), { version: 2, state: "export-required" });
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
  const schedulesBeforeRestart = f.state.timerSchedules;

  f.controller.dispose();
  const restarted = f.create(); t.after(() => restarted.dispose());
  assert.equal((await restarted.status()).modelCatalogState, "export-required");
  assert.equal(f.state.timerSchedules, schedulesBeforeRestart);

  await restarted.exportConfig();
  assert.equal(fs.existsSync(pendingPath), false);
  assert.equal((await restarted.status()).modelCatalogState, "ready");
});
test("Launcher does not overwrite a newer external catalog marker transition", async t => {
  const previous = process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
  process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
    else process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = previous;
  });
  const f = fixture(t); await f.apply();
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");

  f.state.afterRun = async (args, context) => {
    if (args[1] === "refresh-models") fs.rmSync(context.modelCatalogPendingPath, { force: true });
  };
  const refreshed = await f.controller.refreshModelCatalog();
  assert.equal(refreshed.modelCatalogState, "ready");
  assert.equal(fs.existsSync(pendingPath), false);

  fs.writeFileSync(pendingPath, '{"version":2,"state":"export-required"}\n');
  f.state.afterRun = async (args, context) => {
    if (args[1] === "codex-config") {
      fs.writeFileSync(context.modelCatalogPendingPath, '{"version":2,"state":"export-required"}\n');
    }
  };
  await f.controller.exportConfig();
  assert.equal((await f.controller.status()).modelCatalogState, "export-required");
  assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath, "utf8")), { version: 2, state: "export-required" });
});
test("Launcher waits for an older catalog command before publishing a newer pending marker", async t => {
  const previous = process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
  process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG;
    else process.env.CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG = previous;
  });
  const f = fixture(t); await f.apply();
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");
  const release = await acquireModelCatalogCommandLock(pendingPath);
  let released = false;
  try {
    let settled = false;
    const refreshing = f.controller.refreshModelCatalog().then(result => {
      settled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal(fs.existsSync(pendingPath), false);
    // Simulate the older export's final marker cleanup while it still owns the command lock.
    fs.rmSync(pendingPath, { force: true });
    release(); released = true;
    const refreshed = await refreshing;
    assert.equal(refreshed.modelCatalogState, "export-required");
    assert.deepEqual(JSON.parse(fs.readFileSync(pendingPath, "utf8")), { version: 2, state: "export-required" });
    assert.equal(f.state.lastRunOptions.timeoutMs, 30_000);
  } finally {
    if (!released) release();
  }
});
test("upstream save rechecks its revision after waiting for the catalog command lock", async t => {
  const f = fixture(t); await f.apply();
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");
  const upstreamPath = path.join(f.coreHome, "upstream-provider.json");
  const expectedRevision = (await f.controller.status()).revision;
  const release = await acquireModelCatalogCommandLock(pendingPath);
  let released = false;
  try {
    const saving = f.controller.saveUpstream({
      expectedRevision,
      baseUrl: "https://stale.example/v1",
      apiKey: UPSTREAM_KEY,
      proxy: { mode: "direct" },
      models: [],
      supportsOpenAiServerCompaction: false,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const external = {
      version: 2,
      baseUrl: "https://external.example/v1/",
      apiKeySha256: "d".repeat(64),
      proxy: { mode: "direct" },
      models: [],
      supportsOpenAiServerCompaction: false,
    };
    fs.writeFileSync(upstreamPath, `${JSON.stringify(external, null, 2)}\n`);
    release(); released = true;

    await assert.rejects(saving, /stale-settings/);
    assert.deepEqual(JSON.parse(fs.readFileSync(upstreamPath, "utf8")), external);
    assert.equal(fs.existsSync(pendingPath), false);
  } finally {
    if (!released) release();
  }
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
  assert.equal(f.state.lastRunOptions.timeoutMs, 30_000);
});
test("upstream settings persist no plaintext key and expose the key only to the daemon environment", async t => {
  const f = fixture(t); await f.apply();
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" },
    models: [],
    supportsOpenAiServerCompaction: true,
  });
  const saved = JSON.parse(fs.readFileSync(path.join(f.coreHome, "upstream-provider.json"), "utf8"));
  assert.equal(saved.baseUrl, "http://127.0.0.1:11434/v1/");
  assert.deepEqual(saved.models, []);
  assert.equal(saved.supportsOpenAiServerCompaction, true);
  assert.ok(!JSON.stringify(saved).includes(UPSTREAM_KEY));
  assert.deepEqual(f.controller.daemonEnvironment(), { CODEX_CHATGPT_WEB_UPSTREAM_API_KEY: UPSTREAM_KEY });
  assert.equal(result.status.upstream.keyAvailable, true);
  assert.equal(result.status.upstream.runtimeAvailable, true);
  assert.equal(result.status.upstream.metadataSchema.type, "object");
  assert.ok(result.status.upstream.metadataSchema.properties.display_name);
  assert.ok(result.status.upstream.protectedMetadataFields.includes("model_messages"));
  assert.ok(result.status.upstream.protectedMetadataFields.includes("slug"));
  assert.equal(result.status.runtimeState, "in-sync");
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
  assert.equal(f.state.lastRunOptions.env.CODEX_CHATGPT_WEB_API_KEY, KEY);
  assert.equal(f.state.lastRunOptions.sensitiveOutput, undefined);
  assert.equal(f.state.lastRunOptions.timeoutMs, 30_000);
});

test("failed automatic model-catalog refresh stays visible and can be retried", async t => {
  const f = fixture(t, { refreshError: true }); await f.apply();
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");
  assert.equal(result.status.runtimeState, "in-sync");
  assert.equal(result.status.modelCatalogState, "failed");
  assert.equal(fs.existsSync(pendingPath), true);

  f.state.refreshError = false;
  const retried = await f.controller.apply({ mode: "api-key", expectedRevision: result.status.revision });
  assert.equal(retried.status.modelCatalogState, "ready");
  assert.equal(fs.existsSync(pendingPath), false);
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
});

test("runtime model-profile changes can request an API-key model-catalog refresh", async t => {
  const f = fixture(t); await f.apply();
  const refreshesBefore = f.state.commands.filter(args => args[1] === "refresh-models").length;
  const status = await f.controller.refreshModelCatalog();
  assert.equal(status.modelCatalogState, "ready");
  assert.equal(f.state.commands.filter(args => args[1] === "refresh-models").length, refreshesBefore + 1);
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
});

test("export reports restart-required when the runtime changes after its preflight", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  f.state.exportStale = true;
  await assert.rejects(f.controller.exportConfig(), /restart-required/);
});

test("legacy v1 upstream cleanup clears the old vault before a new v2 key can be saved or reused", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [], supportsOpenAiServerCompaction: false,
  });
  const upstreamFile = path.join(f.coreHome, "upstream-provider.json");
  const upstreamVault = path.join(f.coreHome, "secrets", "upstream-api-key.json");
  assert.equal(fs.existsSync(upstreamVault), true);
  fs.writeFileSync(upstreamFile, `${JSON.stringify({
    version: 1,
    baseUrl: "https://legacy.example/v1/",
    apiKeySha256: "a".repeat(64),
    proxy: { mode: "global" },
    modelFilter: { mode: "regex", pattern: "^legacy-" },
    supportsOpenAiServerCompaction: false,
  })}\n`);

  const reset = await f.controller.status();
  assert.equal(reset.upstream.configured, false);
  assert.equal(reset.upstream.resetReason, "legacy-v1-removed");
  assert.equal(fs.existsSync(upstreamFile), false);
  assert.equal(fs.existsSync(upstreamVault), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.coreHome, "upstream-provider-reset.json"), "utf8")), {
    version: 1,
    reason: "legacy-v1-removed",
  });
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: reset.revision,
    baseUrl: "https://provider.example/v1",
    proxy: { mode: "direct" }, models: [], supportsOpenAiServerCompaction: false,
  }), /upstream-key-required/);

  const replacementKey = "replacement-provider-key";
  const saved = await f.controller.saveUpstream({
    expectedRevision: reset.revision,
    baseUrl: "https://provider.example/v1", apiKey: replacementKey,
    proxy: { mode: "direct" }, models: [], supportsOpenAiServerCompaction: false,
  });
  assert.equal(saved.status.upstream.resetReason, undefined);
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider-reset.json")), false);
  assert.deepEqual(f.controller.daemonEnvironment(), { CODEX_CHATGPT_WEB_UPSTREAM_API_KEY: replacementKey });
});

test("legacy v1 vault cleanup failure stays fail-closed and exposes an actionable status code", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [], supportsOpenAiServerCompaction: false,
  });
  const upstreamFile = path.join(f.coreHome, "upstream-provider.json");
  const upstreamVault = path.join(f.coreHome, "secrets", "upstream-api-key.json");
  fs.writeFileSync(upstreamFile, `${JSON.stringify({
    version: 1,
    baseUrl: "https://legacy.example/v1/",
    apiKeySha256: "a".repeat(64),
    proxy: { mode: "global" },
    modelFilter: { mode: "all" },
    supportsOpenAiServerCompaction: false,
  })}\n`);
  fs.rmSync(upstreamVault, { force: true });
  fs.mkdirSync(upstreamVault);

  const status = await f.controller.status();
  assert.equal(status.configuredMode, "invalid");
  assert.equal(status.runtimeState, "invalid");
  assert.equal(status.canApply, false);
  assert.equal(status.errorCode, "upstream-legacy-cleanup-failed");
  assert.equal(fs.existsSync(upstreamFile), false);
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider-reset.json")), true);
});

test("persisted-invalid custom metadata round-trips on unrelated saves but must validate when edited", async t => {
  const f = fixture(t); await f.apply();
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: "gpt-live", display_name: "Live model" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const initial = await f.controller.status();
  await f.controller.fetchUpstreamModels({
    expectedRevision: initial.revision,
    baseUrl, apiKey: UPSTREAM_KEY, proxy: { mode: "direct" }, models: [],
  });
  await f.controller.saveUpstream({
    expectedRevision: initial.revision,
    baseUrl, apiKey: UPSTREAM_KEY, proxy: { mode: "direct" },
    models: [{ id: "gpt-live", metadata: {
      mode: "custom", baseMode: "fallback", overrides: { display_name: "Valid custom" },
    } }],
    supportsOpenAiServerCompaction: false,
  });

  const upstreamFile = path.join(f.coreHome, "upstream-provider.json");
  const persisted = JSON.parse(fs.readFileSync(upstreamFile, "utf8"));
  persisted.models[0].metadata.overrides = { unknown_field: "persisted-invalid" };
  fs.writeFileSync(upstreamFile, `${JSON.stringify(persisted, null, 2)}\n`);
  const degraded = await f.controller.status();
  assert.equal(degraded.upstream.metadata[0].configuredMode, "custom");
  assert.equal(degraded.upstream.metadata[0].customInvalid, true);
  assert.equal(degraded.upstream.metadata[0].effectiveMode, "fallback");

  await f.controller.saveUpstream({
    expectedRevision: degraded.revision,
    baseUrl, proxy: { mode: "direct" },
    models: persisted.models,
    supportsOpenAiServerCompaction: true,
  });
  const roundTripped = JSON.parse(fs.readFileSync(upstreamFile, "utf8"));
  assert.deepEqual(roundTripped.models[0].metadata, persisted.models[0].metadata);
  assert.equal(roundTripped.supportsOpenAiServerCompaction, true);

  const latest = await f.controller.status();
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: latest.revision,
    baseUrl, proxy: { mode: "direct" },
    models: [{ id: "gpt-live", metadata: {
      mode: "custom", baseMode: "fallback", overrides: { unknown_field: "edited-invalid" },
    } }],
    supportsOpenAiServerCompaction: true,
  }), /invalid-upstream-metadata/);
});

test("stale upstream health stays pending when the old daemon still reports its provider available", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  const refreshesBefore = f.state.commands.filter(args => args[1] === "refresh-models").length;
  f.state.active = 1;
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1",
    proxy: { mode: "global" }, models: [],
    supportsOpenAiServerCompaction: true,
  });
  assert.equal(result.status.runtimeState, "restart-required");
  assert.equal(result.status.modelCatalogState, "pending");
  assert.equal(result.status.upstream.runtimeAvailable, false);
  assert.equal(f.state.commands.filter(args => args[1] === "refresh-models").length, refreshesBefore);
  const exportsBefore = f.state.commands.filter(args => args[1] === "codex-config").length;
  await assert.rejects(f.controller.exportConfig(), /restart-required/);
  assert.equal(f.state.commands.filter(args => args[1] === "codex-config").length, exportsBefore);
  const retry = f.state.timer;
  assert.equal(typeof retry, "function");
  f.state.active = 0;
  await retry();
  const applied = await f.controller.status();
  assert.equal(applied.runtimeState, "in-sync");
  assert.equal(applied.modelCatalogState, "ready");
  assert.equal(f.state.commands.filter(args => args[1] === "refresh-models").length, refreshesBefore + 1);
});

test("pending model refresh does not restart a runtime when the saved upstream key is unavailable", async t => {
  const safeStorage = encryption();
  const f = fixture(t, { safeStorage }); await f.apply();
  f.state.active = 1;
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  assert.equal(result.status.modelCatalogState, "pending");
  f.controller.dispose();
  safeStorage.decryptString = () => { throw new Error("locked"); };
  const restarted = f.create(); t.after(() => restarted.dispose());
  const stopsBefore = f.state.stops;
  const startsBefore = f.state.starts;
  const retry = f.state.timer;
  assert.equal(typeof retry, "function");
  f.state.active = 0;
  await retry();
  const status = await restarted.status();
  assert.equal(status.upstream.keyAvailable, false);
  assert.equal(status.modelCatalogState, "failed");
  assert.equal(f.state.stops, stopsBefore);
  assert.equal(f.state.starts, startsBefore);
});

test("pending model refresh stops automatic retries after a managed runtime restart fails", async t => {
  const f = fixture(t); await f.apply();
  f.state.active = 1;
  const result = await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  assert.equal(result.status.modelCatalogState, "pending");
  const retry = f.state.timer;
  const schedulesBefore = f.state.timerSchedules;
  const stopsBefore = f.state.stops;
  const startsBefore = f.state.starts;
  f.state.active = 0;
  f.state.startError = true;
  await retry();
  const status = await f.controller.status();
  assert.equal(status.modelCatalogState, "failed");
  assert.equal(f.state.stops, stopsBefore + 1);
  assert.equal(f.state.starts, startsBefore + 1);
  assert.equal(f.state.timerSchedules, schedulesBefore);
});

test("unconfigured runtimes keep a pending model refresh alive until runtime initialization", async t => {
  const f = fixture(t, { configured: false }); await f.apply();
  const pending = await f.controller.refreshModelCatalog();
  assert.equal(pending.runtimeState, "unconfigured");
  assert.equal(pending.modelCatalogState, "pending");
  const firstRetry = f.state.timer;
  const schedulesBefore = f.state.timerSchedules;
  await firstRetry();
  assert.equal(f.state.timerSchedules, schedulesBefore + 1);
  const secondRetry = f.state.timer;
  f.state.configured = true;
  f.state.effective = JSON.parse(fs.readFileSync(f.file, "utf8"));
  await secondRetry();
  const refreshed = await f.controller.status();
  assert.equal(refreshed.runtimeState, "in-sync");
  assert.equal(refreshed.modelCatalogState, "ready");
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
});

test("external runtimes keep checking a pending model refresh until they become synchronized", async t => {
  const f = fixture(t, { owner: "external" }); await f.apply();
  const pending = await f.controller.refreshModelCatalog();
  assert.equal(pending.modelCatalogState, "pending");
  const retry = f.state.timer;
  assert.equal(typeof retry, "function");
  f.state.effective = JSON.parse(fs.readFileSync(f.file, "utf8"));
  await retry();
  const refreshed = await f.controller.status();
  assert.equal(refreshed.runtimeState, "in-sync");
  assert.equal(refreshed.modelCatalogState, "ready");
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
  assert.equal(f.state.stops, 0);
  assert.equal(f.state.starts, 0);
});

test("OS-encrypted upstream key is recoverable by a restarted Launcher controller", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
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
      proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
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
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  const pendingPath = path.join(f.coreHome, "api-key-models-refresh-pending.json");
  const upstreamPath = path.join(f.coreHome, "upstream-provider.json");
  const release = await acquireModelCatalogCommandLock(pendingPath);
  let released = false;
  let result;
  try {
    let settled = false;
    const deleting = f.controller.deleteUpstream({
      expectedRevision: (await f.controller.status()).revision,
    }).then(value => {
      settled = true;
      return value;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal(fs.existsSync(upstreamPath), true);
    release(); released = true;
    result = await deleting;
  } finally {
    if (!released) release();
  }
  assert.equal(result.status.upstream.configured, false);
  assert.equal(fs.existsSync(upstreamPath), false);
  assert.equal(fs.existsSync(path.join(f.coreHome, "secrets", "upstream-api-key.json")), false);
  assert.deepEqual(f.controller.daemonEnvironment(), {});
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "refresh-models"]);
});

test("saved upstream settings do not affect OpenAI forwarding mode or its daemon environment", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
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
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
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

test("invalid upstream model configuration and stale revisions cannot overwrite provider settings", async t => {
  const f = fixture(t); await f.apply(); const revision = (await f.controller.status()).revision;
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [{ id: "chatgpt-web/high" }], supportsOpenAiServerCompaction: false,
  }), /invalid-upstream-models/);
  assert.equal(fs.existsSync(path.join(f.coreHome, "upstream-provider.json")), false);
  await f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
  });
  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: revision, baseUrl: "https://other.example/v1",
    proxy: { mode: "global" }, models: [], supportsOpenAiServerCompaction: false,
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
    expectedRevision: before.revision,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" },
  });
  assert.deepEqual(result.models, ["gpt-one", "gpt-two"]);
  const after = await f.controller.status();
  assert.equal(after.revision, before.revision);
  assert.equal(after.upstream.configured, false);
});

test("new upstream models require current discovery before save", async t => {
  const f = fixture(t); await f.apply();
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "gpt-discovered" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const revision = (await f.controller.status()).revision;

  await assert.rejects(f.controller.saveUpstream({
    expectedRevision: revision,
    baseUrl, apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [{ id: "gpt-discovered" }],
    supportsOpenAiServerCompaction: false,
  }), /upstream-discovery-required/);

  const fetched = await f.controller.fetchUpstreamModels({
    expectedRevision: revision,
    baseUrl, apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [],
  });
  assert.deepEqual(fetched.models, ["gpt-discovered"]);
  const saved = await f.controller.saveUpstream({
    expectedRevision: revision,
    baseUrl, apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [{ id: "gpt-discovered" }],
    supportsOpenAiServerCompaction: false,
  });
  assert.deepEqual(saved.status.upstream.models.map(model => model.id), ["gpt-discovered"]);
});

test("manual model discovery only needs requestable IDs from Codex-style model rows", () => {
  assert.deepEqual(extractModelIds({
    object: "list",
    data: [{ id: "gpt-standard" }],
    models: [{ slug: "gpt-slug-only" }],
  }), ["gpt-standard", "gpt-slug-only"]);
  assert.deepEqual(extractModelIds({ models: [{ slug: "gpt-slug-only" }] }), ["gpt-slug-only"]);
  assert.throws(() => extractModelIds({ models: "not-an-array" }), /upstream-fetch-failed/);
});

test("manual model discovery accepts OpenAI-compatible data arrays without an object marker", () => {
  assert.deepEqual(extractModelIds({ data: [{ id: "gpt-standard" }] }), ["gpt-standard"]);
  assert.throws(() => extractModelIds({ object: "unexpected", data: [{ id: "gpt-standard" }] }), /upstream-fetch-failed/);
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
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "http://models-target.invalid/v1",
    apiKey: UPSTREAM_KEY,
    proxy: { mode: "global" },
  });
  assert.deepEqual(result.models, ["gpt-via-proxy"]);
  assert.match(proxyAuthorization, /^Basic /);
});

test("manual model discovery can reuse the saved provider key", async t => {
  const f = fixture(t); await f.apply();
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${UPSTREAM_KEY}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "gpt-live" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl, apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false,
  });
  const baseline = (await f.controller.status()).revision;
  const fetched = await f.controller.fetchUpstreamModels({
    expectedRevision: baseline, baseUrl, proxy: { mode: "direct" },
  });
  assert.deepEqual(fetched.models, ["gpt-live"]);
  assert.deepEqual((await f.controller.status()).upstream.models, []);
});

test("manual model discovery never reuses a saved key for another Base URL", async t => {
  const f = fixture(t); await f.apply();
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: "https://saved-provider.example/v1", apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false,
  });
  const baseline = (await f.controller.status()).revision;
  await assert.rejects(f.controller.fetchUpstreamModels({
    expectedRevision: baseline,
    baseUrl: "https://other-provider.example/v1",
    proxy: { mode: "direct" },
  }), /upstream-key-required/);
});

test("stale model discovery cannot reuse a key saved by an external update", async t => {
  const f = fixture(t); await f.apply();
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "should-not-load" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const staleBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  await f.controller.saveUpstream({
    expectedRevision: (await f.controller.status()).revision,
    baseUrl: staleBaseUrl, apiKey: UPSTREAM_KEY,
    proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false,
  });
  const staleRevision = (await f.controller.status()).revision;
  await f.controller.saveUpstream({
    expectedRevision: staleRevision,
    baseUrl: "https://provider-b.example/v1", apiKey: "provider-b-key",
    proxy: { mode: "direct" }, models: [],
    supportsOpenAiServerCompaction: false,
  });
  await assert.rejects(f.controller.fetchUpstreamModels({
    expectedRevision: staleRevision,
    baseUrl: staleBaseUrl,
    proxy: { mode: "direct" },
  }), /stale-settings/);
  assert.equal(requests, 0);
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
