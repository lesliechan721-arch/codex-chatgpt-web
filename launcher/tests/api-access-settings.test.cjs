const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCipheriv, createDecipheriv } = require("node:crypto");
const { createApiAccessSettings, keyPolicy, parsePolicy, policyRevision, validateChange } = require("../electron/api-access-settings.cjs");
const KEY = "cgw_" + "a".repeat(43);
const NEXT = "cgw_" + "b".repeat(43);

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
    run: async (name, args) => {
      assert.equal(state.operation, name); state.commands.push(args);
      if (args[1] === "reconnect" && state.reconnectError) throw new Error("route conflict");
      if (args[1] === "cleanup" && state.cleanupError) throw new Error("private arbitrary error");
      return { stdout: args[1] === "codex-config"
        ? 'requires_openai_auth = false\nenv_key = "CODEX_CHATGPT_WEB_API_KEY"\n' : '{"changed":false}\n' };
    },
  };
  const supervisor = {
    proxyHealthPayload: async () => state.stopped ? null : ({
      service: "codex-chatgpt-web", status: "ok", accepting_turns: true,
      access_mode: state.effective.mode, api_access_revision: policyRevision(state.effective, config.controlToken),
      active_http_turns: state.active, active_browser_turns: 0,
    }),
    stopForSetup: async () => {
      state.stops++; assert.ok(fs.existsSync(file), "policy is saved BEFORE stopping");
      if (state.stopError) throw new Error("stop failed"); state.stopped = true;
    },
    startIfConfigured: async () => {
      state.starts++; if (state.startError) throw new Error("start failed");
      state.effective = JSON.parse(fs.readFileSync(file, "utf8")); state.stopped = false;
      return { status: "ready" };
    },
  };
  const safeStorage = options.safeStorage ?? encryption();
  const create = () => createApiAccessSettings({ coreHome, runtimeHost: host, supervisor,
    safeStorage, browserHost: { get activeTraceId() { return state.browserActive ? "trace" : null; }, currentOperation: () => null },
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
test("export is a separate explicit CLI action and never includes a key", async t => {
  const f = fixture(t); await f.apply(); const result = await f.controller.exportConfig();
  assert.ok(result.config.includes("requires_openai_auth = false")); assert.ok(!result.config.includes(KEY));
  assert.deepEqual(f.state.commands.at(-1), ["api-key", "codex-config"]);
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
test("disabling after an external key rotation does not reactivate a revoked GUI key", async t => {
  const f = fixture(t); await f.apply(); fs.writeFileSync(f.file, JSON.stringify(keyPolicy(NEXT)));
  await f.apply("openai");
  assert.equal((await f.controller.status()).keyAvailable, false);
  await assert.rejects(f.controller.apply({ mode: "api-key", expectedRevision: (await f.controller.status()).revision }), /key-required/);
});
