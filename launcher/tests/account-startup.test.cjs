const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createAccountStore } = require("../electron/accounts.cjs");

const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

test("a pending account path failure restores the loaded account once, then opens management", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { kind: "production", coreHome: path.join(root, "core"),
    userData: path.join(root, "launcher"), codexHome: path.join(root, "codex"),
    browserPartition: "persist:codex-web-gpt-chatgpt" };
  const store = createAccountStore({ profile });
  store.commitLoaded("default");
  const target = store.add({ name: "Invalid local directory" });
  const targetHome = store.context(target.id).coreHome;
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.dirname(targetHome), { recursive: true });
  fs.symlinkSync(outside, targetHome, process.platform === "win32" ? "junction" : "dir");
  store.setPending(target.id);
  const handlerSource = mainSource.slice(mainSource.indexOf("void start().catch("));

  for (const expectedId of ["default", null]) {
    let exited;
    const complete = new Promise(resolve => { exited = resolve; });
    const events = [];
    const sandbox = {
      accountStore: store, ACCOUNT_CONTEXT: null, startupFailed: false,
      networkProxyController: null, runtimeSupervisor: null, browserHost: null, browserControl: null,
      fs: { appendFileSync() {} }, path,
      process: { argv: ["electron", "launcher", "--hidden"] },
      restoreLaunchEnvironment: () => events.push("restore environment"),
      start: async () => { sandbox.ACCOUNT_CONTEXT = store.context(); },
      app: { getPath: () => root, relaunch: () => events.push("relaunch"), exit: exited },
      dialog: { showMessageBox() { assert.fail("Valid registry recovery must not require a startup dialog"); } },
    };
    vm.runInNewContext(handlerSource, sandbox);
    assert.equal(await complete, 1);
    assert.equal(store.snapshot().currentId, expectedId);
    assert.equal(store.snapshot().pendingId, null);
    assert.equal(store.snapshot().recoveryAttempted, true);
    assert.match(store.snapshot().recoveryError, /symbolic links/);
    assert.deepEqual(events, ["restore environment", "relaunch"]);
    if (expectedId === "default") {
      fs.renameSync(profile.coreHome, path.join(root, "failed-core"));
      fs.symlinkSync(outside, profile.coreHome, process.platform === "win32" ? "junction" : "dir");
    }
  }
  assert.equal(store.context(), null, "the next start can open account management without resolving a broken account");
});

test("a saved runtime configuration suppresses the unready listener only when the runtime is ready", async () => {
  const source = mainSource.slice(mainSource.indexOf("async function ensureNotReadyListener()"),
    mainSource.indexOf("function restoreLaunchEnvironment()"));
  for (const ready of [false, true]) {
    let listeners = 0;
    const config = { port: 17841 };
    const sandbox = { IS_DEV_PROFILE: false, notReadyListener: null, exitCommitted: false,
      proxyReady: true, APPLICATION_HOME: "/application", runtimeHost: { runtimeConfigSnapshot: () => ({ configured: true, config }) },
      runtimeSupervisor: { ownedRuntimeReady: async value => { assert.equal(value, config); return ready; } },
      listenAccountNotReady: async () => { listeners++; return {}; } };
    vm.runInNewContext(source, sandbox);
    await sandbox.ensureNotReadyListener();
    assert.equal(listeners, ready ? 0 : 1);
  }
});

test("repeated account management startup failures require manual retry instead of automatic relaunch", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-management-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = { kind: "production", coreHome: path.join(root, "core"),
    userData: path.join(root, "launcher"), codexHome: path.join(root, "codex"),
    browserPartition: "persist:codex-web-gpt-chatgpt" };
  const store = createAccountStore({ profile });
  store.beginRemoval("default");
  await store.remove("default", { clearBrowserStorage: async () => {} });
  const source = mainSource.slice(mainSource.indexOf("void start().catch("));
  const createStateStore = require("../electron/state.cjs").createStateStore;
  for (const exhausted of [false, true]) {
    if (exhausted) store.failPending("The account recovery attempt failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      let exited;
      const complete = new Promise(resolve => { exited = resolve; });
      const events = [];
      vm.runInNewContext(source, {
        accountStore: store, ACCOUNT_CONTEXT: null, startupFailed: false, quitting: false, mainWindow: null,
        runtimeSupervisor: null, networkProxyController: null, browserHost: null, browserControl: null,
        fs: { appendFileSync() {} }, path, createStateStore, showMainWindow() {},
        process: { argv: ["electron", "launcher"] },
        start: async () => { throw new Error("Account management renderer could not load"); },
        restoreLaunchEnvironment: () => events.push("restore"),
        nativeCopyFor: () => ({ startupTitle: "Startup error", startupDetail: "Retry manually or quit",
          startupCleanupFailed: "Cleanup failed", retry: "Retry", quit: "Quit" }),
        app: { getPath: () => profile.userData, whenReady: async () => {},
          relaunch: () => events.push("relaunch"), exit: exited },
        dialog: { showMessageBox: async options => {
          assert.match(options.message, /Account management renderer could not load/);
          assert.deepEqual(Array.from(options.buttons), ["Retry", "Quit"]);
          events.push("dialog");
          return { response: 1 };
        } },
      });
      assert.equal(await complete, 1);
      assert.deepEqual(events, ["dialog"]);
      assert.equal(store.snapshot().currentId, null);
      assert.equal(store.snapshot().pendingId, null);
      assert.equal(store.snapshot().recoveryAttempted, exhausted);
    }
  }
});
