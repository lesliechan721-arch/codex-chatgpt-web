const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore } = require("../electron/accounts.cjs");
const { createAccountController } = require("../electron/account-controller.cjs");

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-controller-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { kind: "production", coreHome: path.join(root, "core"), userData: path.join(root, "launcher"), codexHome: path.join(root, "codex"), browserPartition: "persist:codex-web-gpt-chatgpt" };
  const store = createAccountStore({ profile });
  const target = store.add({ name: "B" });
  const calls = [];
  const browser = {
    accountAdmissionClosed: false,
    currentOperation: () => null,
    closeAccountAdmission() { this.accountAdmissionClosed = true; calls.push("gate"); },
    resumeAccountAdmission() { this.accountAdmissionClosed = false; calls.push("resume"); },
    persistSession: async () => calls.push("persist"), destroy: () => calls.push("destroy"),
  };
  const supervisor = {
    stopForAccountSwitch: async () => { calls.push("stop"); return { status: "stopped" }; },
    startIfConfigured: async () => calls.push("start"),
  };
  const controller = createAccountController({
    store, context: store.context(), getBrowserHost: () => browser,
    getSupervisor: () => supervisor,
    getRuntimeHost: () => ({ currentOperation: () => null, runLifecycleOperation: (_name, action) => action() }),
    confirmSwitch: async () => true, confirmRemoval: async () => true,
    clearBrowserStorage: async () => {}, restart: async () => calls.push("restart"),
    ...overrides,
  });
  return { root, store, target, controller, calls, supervisor, browser };
}

test("an active launcher action blocks switching without saving a deferred target", async t => {
  const f = fixture(t);
  let finish;
  const active = f.controller.runAction(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(f.controller.switchAccount(f.target.id), /Finish the current/);
  assert.equal(f.store.snapshot().pendingId, null);
  assert.deepEqual(f.calls, []);
  finish(); await active;
  assert.equal(f.store.snapshot().currentId, "default");
  assert.equal(f.store.snapshot().pendingId, null);
});

test("the transition closes admission before stopping and rejects racing actions", async t => {
  const f = fixture(t);
  let finishStop, enteredStop;
  const entered = new Promise(resolve => { enteredStop = resolve; });
  f.supervisor.stopForAccountSwitch = () => { enteredStop(); return new Promise(resolve => { finishStop = resolve; }); };
  const switching = f.controller.switchAccount(f.target.id);
  await entered;
  assert.equal(f.browser.accountAdmissionClosed, true);
  await assert.rejects(f.controller.runAction(() => assert.fail("racing action executed")), /in progress/);
  assert.equal(f.store.snapshot().pendingId, null);
  finishStop({ status: "stopped" });
  await switching;
  assert.equal(f.store.snapshot().pendingId, f.target.id);
  assert.deepEqual(f.calls, ["gate", "persist", "restart"]);
});

test("busy drain and restart failure restore the old account and admission", async t => {
  const f = fixture(t, { restart: async () => { throw new Error("restart failed"); } });
  f.supervisor.stopForAccountSwitch = async () => { throw new Error("busy drain"); };
  await assert.rejects(f.controller.switchAccount(f.target.id), /busy drain/);
  assert.equal(f.browser.accountAdmissionClosed, false);
  f.supervisor.stopForAccountSwitch = async () => ({ status: "stopped" });
  await assert.rejects(f.controller.switchAccount(f.target.id), /restart failed/);
  assert.equal(f.store.snapshot().pendingId, null);
  assert.equal(f.store.snapshot().currentId, "default");
  assert.equal(f.browser.accountAdmissionClosed, false);
  assert.ok(f.calls.includes("start"));
});

test("removal failure disables only the source and can be retried", async t => {
  let failCleanup = true;
  const f = fixture(t, { clearBrowserStorage: async () => { if (failCleanup) throw new Error("locked storage"); } });
  await assert.rejects(f.controller.remove(f.target.id), /locked storage/);
  assert.equal(f.store.snapshot().accounts.find(item => item.id === f.target.id).status, "removal-failed");
  assert.equal(f.store.snapshot().currentId, "default");
  failCleanup = false;
  await f.controller.remove(f.target.id);
  assert.equal(f.store.snapshot().accounts.length, 1);
  assert.equal(f.browser.accountAdmissionClosed, false);
});

test("last-account removal stops execution and returns to empty management", async t => {
  const f = fixture(t);
  await f.controller.remove(f.target.id);
  f.calls.length = 0;
  await f.controller.remove("default");
  assert.equal(f.store.snapshot().currentId, null);
  assert.equal(f.store.snapshot().accounts.length, 0);
  assert.deepEqual(f.calls, ["gate", "stop", "persist", "destroy", "restart"]);
});
