const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NETWORK_PROXY_FATAL_MESSAGE,
  createNetworkProxyController,
} = require("../electron/network-proxy.cjs");
const { redactText } = require("../electron/logging.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const os = require("node:os");
const path = require("node:path");

function harness({
  beforeMutation,
  browserHost: suppliedBrowserHost,
  clearFailures = [],
  closeFailures = [],
  environment: initialEnvironment = { OTHER: "kept" },
  failStateUpdate = false,
  initialProxy = null,
  restartResults = [{ status: "ready" }],
  runtimeOperation = null,
  setFailures = [],
  supervisor: suppliedSupervisor,
} = {}) {
  let state = {
    version: 1,
    onboardingComplete: true,
    networkProxyUrl: initialProxy,
  };
  const applied = [];
  const connectionsClosed = [];
  const published = [];
  const logs = [];
  const handlers = new Map();
  const events = [];
  const fatalMessages = [];
  let restartIndex = 0;
  let clearIndex = 0;
  let closeIndex = 0;
  let setIndex = 0;
  let activeRuntimeOperation = runtimeOperation;
  const environment = { ...initialEnvironment };
  const supervisor = suppliedSupervisor || {
    readConfig: () => ({ mode: "full" }),
    stopForAccountSwitch: async () => ({ status: "stopped" }),
    startIfConfigured: async () => restartResults[Math.min(restartIndex++, restartResults.length - 1)],
  };
  const browserHost = suppliedBrowserHost || Object.assign(Object.create(BrowserHost.prototype), { turnTabs: new Map() });
  const browserSession = {
    clearAuthCache: async () => {
      events.push("clear");
      clearIndex += 1;
      if (clearFailures.includes(clearIndex)) throw new Error("clear failed at http://secret:pw@proxy.example:8123");
    },
    setProxy: async config => {
      events.push("set");
      setIndex += 1;
      if (setFailures.includes(setIndex)) throw new Error("set failed at http://secret:pw@proxy.example:8123");
      applied.push(config);
    },
    closeAllConnections: async () => {
      events.push("close");
      closeIndex += 1;
      if (closeFailures.includes(closeIndex)) throw new Error("close failed at http://secret:pw@proxy.example:8123");
      connectionsClosed.push(true);
    },
  };
  const controller = createNetworkProxyController({
    beforeMutation,
    browserPartition: "persist:test-chatgpt",
    environment,
    fatal: async message => fatalMessages.push(message),
    getBrowserHost: () => browserHost,
    getRuntimeHost: () => ({
      currentOperation: () => activeRuntimeOperation,
      runLifecycleOperation: async (name, action) => {
        if (activeRuntimeOperation) {
          throw new Error(`Another launcher operation is active: ${activeRuntimeOperation}`);
        }
        activeRuntimeOperation = name;
        try {
          return await action();
        } finally {
          activeRuntimeOperation = null;
        }
      },
    }),
    getRuntimeSupervisor: () => supervisor,
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
    logger: {
      error: (event, detail) => logs.push({ event, detail }),
      info: (event, detail) => logs.push({ event, detail }),
    },
    publishState: next => published.push(next),
    sessionApi: {
      fromPartition(partition) {
        assert.equal(partition, "persist:test-chatgpt");
        return browserSession;
      },
    },
    stateStore: {
      read: () => structuredClone(state),
      update: patch => {
        if (failStateUpdate) throw new Error("state write failed");
        state = { ...state, ...patch };
        return structuredClone(state);
      },
    },
  });
  return {
    applied,
    browserSession,
    browserHost,
    connectionsClosed,
    controller,
    environment,
    events,
    fatalMessages,
    handlers,
    logs,
    published,
    readState: () => structuredClone(state),
    restartCount: () => restartIndex,
  };
}

function drainingSupervisor(activity) {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false }, logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(), coreHome: os.tmpdir(), browserDescriptorPath: path.join(os.tmpdir(), "proxy-test-browser.json"),
  });
  const daemon = { pid: process.pid, exitCode: null, signalCode: null };
  supervisor.daemon = daemon;
  supervisor.readConfig = () => ({ mode: "browser-only", releaseVersion: "0.2.0" });
  supervisor.readState = () => null;
  supervisor.clearState = () => {};
  supervisor.tryWriteState = () => true;
  supervisor.proxyHealth = async () => true;
  supervisor.proxyIdentity = async () => true;
  supervisor.waitForChildExit = async () => {};
  supervisor.waitForPortRelease = async () => {};
  let accepting = true;
  supervisor.control = async (_config, action) => {
    accepting = action === "resume";
    return { status: "ok", accepting_turns: accepting, active_http_turns: 0,
      active_browser_turns: 0, active_remote_turn_idle_leases: 0, ...activity };
  };
  supervisor.startIfConfigured = async () => {
    supervisor.daemon = daemon; accepting = true;
    return { status: "ready" };
  };
  return { supervisor, accepting: () => accepting, stopped: () => supervisor.daemon === null };
}

for (const field of ["active_http_turns", "active_remote_turn_idle_leases"]) {
  test(`busy proxy changes preserve environment, authentication and connections: ${field}`, async () => {
    const runtime = drainingSupervisor({ [field]: 1 });
    const fixture = harness({ supervisor: runtime.supervisor, initialProxy: "http://old:pw@proxy.example" });
    await fixture.controller.applySaved();
    const environment = { ...fixture.environment };
    const events = [...fixture.events];
    const state = fixture.readState();
    await assert.rejects(fixture.controller.setProxy("http://new:pw@other.example"), /active|idle|stop/i);
    assert.deepEqual(fixture.environment, environment);
    assert.deepEqual(fixture.events, events);
    assert.deepEqual(fixture.readState(), state);
    assert.deepEqual(loginAttempt(fixture.controller, fixture.browserSession, {
      host: "proxy.example", port: 80, isProxy: true, scheme: "basic",
    }).credentials, ["old", "pw"]);
    assert.equal(runtime.accepting(), true);
    assert.equal(runtime.stopped(), false);
    assert.equal(fixture.browserHost.accountAdmissionClosed, false);
  });
}

test("proxy drain closes browser admission before a concurrent turn can begin or network state can change", { timeout: 2000 }, async () => {
  const runtime = drainingSupervisor({});
  const fixture = harness({ supervisor: runtime.supervisor, initialProxy: "http://old:pw@proxy.example" });
  await fixture.controller.applySaved();
  const events = [...fixture.events];
  const environment = { ...fixture.environment };
  let drained;
  const draining = new Promise(resolve => { drained = resolve; });
  let release;
  const originalControl = runtime.supervisor.control;
  runtime.supervisor.control = async (config, action) => {
    const result = await originalControl(config, action);
    if (action === "drain") { drained(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const updating = fixture.controller.setProxy("http://new:pw@other.example");
  await draining;
  await assert.rejects(fixture.browserHost.beginTurn("concurrent-request"), { code: "account_admission_closed" });
  assert.throws(() => fixture.browserHost.beginManualTurn("concurrent-request"), { code: "account_admission_closed" });
  assert.deepEqual(fixture.events, events);
  assert.deepEqual(fixture.environment, environment);
  assert.equal(runtime.accepting(), false);
  release();
  await updating;
  assert.equal(fixture.readState().networkProxyUrl, "http://new:pw@other.example/");
  assert.equal(fixture.browserHost.accountAdmissionClosed, false);
  assert.equal(runtime.accepting(), true);
});

test("proxy updates preserve a previously closed admission gate after success and rollback", async () => {
  for (const failStateUpdate of [false, true]) {
    const browserHost = Object.assign(Object.create(BrowserHost.prototype), { turnTabs: new Map(), accountAdmissionClosed: true });
    const fixture = harness({ browserHost, failStateUpdate, initialProxy: "http://old:pw@proxy.example" });
    await fixture.controller.applySaved();
    const update = fixture.controller.setProxy("http://new:pw@other.example");
    if (failStateUpdate) await assert.rejects(update, /could not be saved/);
    else await update;
    assert.equal(browserHost.accountAdmissionClosed, true);
  }
});

test("proxy controller applies persisted proxy before runtime startup", async () => {
  const testHarness = harness({ initialProxy: "http://127.0.0.1:7890/" });
  await testHarness.controller.applySaved();
  assert.deepEqual(testHarness.applied, [{
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:7890",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  }]);
  assert.equal(testHarness.environment.HTTPS_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.environment.TUNNEL_CLIENT_HTTP_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.restartCount(), 0);
  assert.equal(testHarness.connectionsClosed.length, 1);
});

test("relaunch restores the launch proxy baseline before the next account selects system defaults", async () => {
  const launchEnvironment = { OTHER: "kept", HTTP_PROXY: "http://system.example:8123", no_proxy: "intranet" };
  const accountA = harness({ environment: launchEnvironment, initialProxy: "http://user:secret@account-a.example:8124" });
  await accountA.controller.applySaved();
  assert.equal(accountA.environment.HTTP_PROXY, "http://user:secret@account-a.example:8124/");
  await accountA.controller.restoreLaunchEnvironment();
  assert.deepEqual(accountA.environment, launchEnvironment);
  assert.equal(accountA.readState().networkProxyUrl, "http://user:secret@account-a.example:8124");
  assert.equal(accountA.controller.handleLogin({ preventDefault() { assert.fail("Authentication was cleared"); } },
    { session: accountA.browserSession }, { isProxy: true, host: "account-a.example", port: 8124 }, () => {}), false);
  assert.deepEqual(accountA.events.slice(-2), ["clear", "close"]);

  const accountB = harness({ environment: accountA.environment });
  await accountB.controller.applySaved();
  assert.deepEqual(accountB.applied, [{ mode: "system" }]);
  assert.equal(accountB.environment.HTTP_PROXY, launchEnvironment.HTTP_PROXY);
  assert.equal(accountB.environment.HTTPS_PROXY, undefined);
  assert.equal(accountB.environment.TUNNEL_CLIENT_HTTP_PROXY, undefined);
});

test("proxy changes consume the account mutation check before touching network state", async () => {
  let checks = 0;
  const fixture = harness({ beforeMutation: () => { checks++; throw new Error("Account admission is closed"); } });
  await assert.rejects(fixture.controller.setProxy("http://account.example:8124"), /Account admission is closed/);
  assert.equal(checks, 1);
  assert.deepEqual(fixture.events, []);
  assert.equal(fixture.restartCount(), 0);
  assert.equal(fixture.readState().networkProxyUrl, null);
});

test("failed relaunch connection cleanup still restores the original process environment", async () => {
  const fixture = harness({ initialProxy: "http://account.example:8124", closeFailures: [2] });
  await fixture.controller.applySaved();
  await assert.rejects(fixture.controller.restoreLaunchEnvironment(), /browser proxy connections/);
  assert.deepEqual(fixture.environment, { OTHER: "kept" });
});

test("proxy controller registers inherited, previous, and candidate endpoints for delayed diagnostics", async () => {
  const testHarness = harness({
    environment: { HTTP_PROXY: "http://inherited.private.example:8101" },
    initialProxy: "http://previous.private.example:8102",
  });
  await testHarness.controller.applySaved();
  await testHarness.controller.setProxy("http://candidate.private.example:8103");
  for (const key of Object.keys(testHarness.environment)) {
    if (/proxy/i.test(key)) delete testHarness.environment[key];
  }

  const delayed = redactText(
    "http://inherited.private.example:8101 inherited.private.example:8101 "
      + "previous.private.example:8102 candidate.private.example port 8103 "
      + "http://unrelated.public.example:9100/health",
  );
  assert.doesNotMatch(delayed, /inherited\.private|previous\.private|candidate\.private|8101|8102|8103/);
  assert.match(delayed, /http:\/\/unrelated\.public\.example:9100\/health/);
});

test("proxy IPC updates Electron, restarts managed runtime, and publishes state", async () => {
  const testHarness = harness();
  const handler = testHarness.handlers.get("launcher:network-proxy");
  assert.equal(typeof handler, "function");
  const next = await handler({}, "http://localhost:8888");
  assert.equal(next.networkProxyUrl, "http://localhost:8888/");
  assert.equal(testHarness.readState().networkProxyUrl, "http://localhost:8888/");
  assert.equal(testHarness.environment.HTTP_PROXY, "http://localhost:8888/");
  assert.equal(testHarness.restartCount(), 1);
  assert.equal(testHarness.published.length, 1);
  assert.deepEqual(testHarness.logs.at(-1), {
    event: "network.proxy_updated",
    detail: { customProxy: true },
  });
});

test("proxy controller restores the prior proxy when runtime restart fails", async () => {
  const testHarness = harness({
    initialProxy: "http://127.0.0.1:7890/",
    restartResults: [
      { status: "needs-setup", detail: "runtime failed" },
      { status: "ready" },
    ],
  });
  await testHarness.controller.applySaved();
  await assert.rejects(
    testHarness.controller.setProxy("http://localhost:9999"),
    /Managed runtimes could not restart/,
  );
  assert.equal(testHarness.readState().networkProxyUrl, "http://127.0.0.1:7890/");
  assert.equal(testHarness.environment.HTTPS_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.restartCount(), 2);
  assert.deepEqual(testHarness.applied.at(-1), {
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:7890",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  });
});

test("proxy controller restores the prior proxy when state persistence fails", async () => {
  const testHarness = harness({ failStateUpdate: true });
  await assert.rejects(
    testHarness.controller.setProxy("http://localhost:9999"),
    /could not be saved/,
  );
  assert.equal(testHarness.readState().networkProxyUrl, null);
  assert.equal(testHarness.environment.HTTPS_PROXY, undefined);
  assert.equal(testHarness.restartCount(), 2);
  assert.deepEqual(testHarness.applied.at(-1), { mode: "system" });
});

test("proxy controller refuses changes while a runtime lifecycle operation is active", async () => {
  const testHarness = harness({ runtimeOperation: "doctor" });
  await assert.rejects(
    testHarness.controller.setProxy("http://127.0.0.1:7890"),
    /Another launcher operation is active: doctor/,
  );
  assert.equal(testHarness.applied.length, 0);
  assert.equal(testHarness.connectionsClosed.length, 0);
  assert.equal(testHarness.restartCount(), 0);
  assert.equal(testHarness.environment.HTTP_PROXY, undefined);
});

test("proxy IPC failures are written to launcher activity", async () => {
  const testHarness = harness();
  const handler = testHarness.handlers.get("launcher:network-proxy");
  await assert.rejects(handler({}, "socks5://127.0.0.1:1080"), /http:\/\/ or https:\/\//);
  assert.deepEqual(testHarness.logs.at(-1), {
    event: "launcher.ipc_failed",
    detail: {
      channel: "launcher:network-proxy",
      message: "Network proxy must use http:// or https://",
    },
  });
});

test("proxy controller refuses changes while a ChatGPT turn is active", async () => {
  let state = { networkProxyUrl: null };
  const handlers = new Map();
  const controller = createNetworkProxyController({
    browserPartition: "persist:test-chatgpt",
    environment: {},
    getBrowserHost: () => ({ activeTraceId: "trace_active", currentOperation: () => "browser turn" }),
    getRuntimeSupervisor: () => null,
    ipc: { handle: (channel, handler) => handlers.set(channel, handler) },
    sessionApi: { fromPartition: () => ({ clearAuthCache: async () => {}, setProxy: async () => {}, closeAllConnections: async () => {} }) },
    stateStore: {
      read: () => structuredClone(state),
      update: patch => (state = { ...state, ...patch }),
    },
  });
  await assert.rejects(controller.setProxy("http://127.0.0.1:7890"), /Finish or cancel active ChatGPT turns/);
  assert.equal(state.networkProxyUrl, null);
});

function loginAttempt(controller, session, authInfo) {
  let prevented = false;
  let credentials = null;
  const handled = controller.handleLogin(
    { preventDefault: () => { prevented = true; } },
    session ? { session } : null,
    authInfo,
    (username, password) => { credentials = [username, password]; },
  );
  return { credentials, handled, prevented };
}

test("proxy authentication handles only matching Basic challenges from the target partition", async () => {
  const testHarness = harness({ initialProxy: "https://u%2540:p%40ss@Proxy.EXAMPLE:443" });
  await testHarness.controller.applySaved();
  const matching = {
    host: "PROXY.EXAMPLE",
    port: 443,
    isProxy: true,
    scheme: "basic",
  };
  assert.deepEqual(loginAttempt(testHarness.controller, testHarness.browserSession, matching), {
    handled: true,
    prevented: true,
    credentials: ["u%40", "p@ss"],
  });
  for (const [webSession, authInfo] of [
    [null, matching],
    [{}, matching],
    [testHarness.browserSession, { ...matching, isProxy: false }],
    [testHarness.browserSession, { ...matching, scheme: "digest" }],
    [testHarness.browserSession, { ...matching, host: "other.example" }],
    [testHarness.browserSession, { ...matching, port: 444 }],
  ]) {
    assert.deepEqual(loginAttempt(testHarness.controller, webSession, authInfo), {
      handled: false,
      prevented: false,
      credentials: null,
    });
  }

  await testHarness.controller.setProxy("https://port-user:pw@proxy.example:8443");
  assert.deepEqual(loginAttempt(testHarness.controller, testHarness.browserSession, {
    host: "proxy.example", port: 8443, isProxy: true, scheme: "basic",
  }).credentials, ["port-user", "pw"]);
  assert.equal(loginAttempt(testHarness.controller, testHarness.browserSession, {
    host: "proxy.example", port: 443, isProxy: true, scheme: "basic",
  }).handled, false);
});

test("switching and clearing replace the credentials and preserve proxy operation order", async () => {
  const testHarness = harness({ initialProxy: "http://old:pw@proxy.example:80" });
  await testHarness.controller.applySaved();
  await testHarness.controller.setProxy("https://new:@[2001:DB8::1]:443");
  assert.deepEqual(testHarness.events, ["clear", "set", "close", "clear", "set", "close"]);
  assert.equal(loginAttempt(testHarness.controller, testHarness.browserSession, {
    host: "proxy.example", port: 80, isProxy: true, scheme: "basic",
  }).handled, false);
  assert.deepEqual(loginAttempt(testHarness.controller, testHarness.browserSession, {
    host: "2001:db8::1", port: 443, isProxy: true, scheme: "basic",
  }).credentials, ["new", ""]);

  await testHarness.controller.setProxy(null);
  assert.deepEqual(testHarness.events.slice(-3), ["clear", "set", "close"]);
  assert.equal(loginAttempt(testHarness.controller, testHarness.browserSession, {
    host: "2001:db8::1", port: 443, isProxy: true, scheme: "basic",
  }).handled, false);
});

test("switching disables old credentials before cache clear and enables new credentials before connection close", async () => {
  let state = { networkProxyUrl: "http://old:pw@old.example" };
  let controller;
  let blockClear = false;
  let blockSet = false;
  let blockClose = false;
  let releaseClear;
  let releaseSet;
  let releaseClose;
  let clearStarted;
  let setStarted;
  let closeStarted;
  const clearStartedPromise = new Promise(resolve => { clearStarted = resolve; });
  const setStartedPromise = new Promise(resolve => { setStarted = resolve; });
  const closeStartedPromise = new Promise(resolve => { closeStarted = resolve; });
  const browserSession = {
    clearAuthCache: async () => {
      if (blockClear) {
        clearStarted();
        await new Promise(resolve => { releaseClear = resolve; });
      }
    },
    setProxy: async () => {
      if (blockSet) {
        setStarted();
        await new Promise(resolve => { releaseSet = resolve; });
      }
    },
    closeAllConnections: async () => {
      if (blockClose) {
        closeStarted();
        await new Promise(resolve => { releaseClose = resolve; });
      }
    },
  };
  controller = createNetworkProxyController({
    browserPartition: "persist:test-chatgpt",
    environment: {},
    getBrowserHost: () => ({ activeTraceId: null, currentOperation: () => null }),
    getRuntimeSupervisor: () => null,
    ipc: { handle: () => {} },
    sessionApi: { fromPartition: () => browserSession },
    stateStore: {
      read: () => structuredClone(state),
      update: patch => (state = { ...state, ...patch }),
    },
  });
  await controller.applySaved();

  blockClear = true;
  blockSet = true;
  blockClose = true;
  const switching = controller.setProxy("https://new:pw@new.example");
  await clearStartedPromise;
  assert.equal(loginAttempt(controller, browserSession, {
    host: "old.example", port: 80, isProxy: true, scheme: "basic",
  }).handled, false);

  blockClear = false;
  releaseClear();
  await setStartedPromise;
  assert.equal(loginAttempt(controller, browserSession, {
    host: "new.example", port: 443, isProxy: true, scheme: "basic",
  }).handled, false);
  blockSet = false;
  releaseSet();
  await closeStartedPromise;
  assert.deepEqual(loginAttempt(controller, browserSession, {
    host: "new.example", port: 443, isProxy: true, scheme: "basic",
  }).credentials, ["new", "pw"]);
  blockClose = false;
  releaseClose();
  await switching;
});

test("rollback restores old credentials, while rollback failure leaves credentials disabled", async () => {
  const restored = harness({
    failStateUpdate: true,
    initialProxy: "http://old:pw@proxy.example",
  });
  await restored.controller.applySaved();
  await assert.rejects(restored.controller.setProxy("http://new:pw@new.example"), /could not be saved/);
  assert.deepEqual(restored.events, [
    "clear", "set", "close",
    "clear", "set", "close",
    "clear", "set", "close",
  ]);
  assert.deepEqual(loginAttempt(restored.controller, restored.browserSession, {
    host: "proxy.example", port: 80, isProxy: true, scheme: "basic",
  }).credentials, ["old", "pw"]);

  const failed = harness({
    initialProxy: "http://old:pw@proxy.example",
    setFailures: [2, 3],
  });
  await failed.controller.applySaved();
  await assert.rejects(
    failed.controller.setProxy("http://new:pw@new.example"),
    /previous network proxy could not be restored/i,
  );
  assert.equal(loginAttempt(failed.controller, failed.browserSession, {
    host: "proxy.example", port: 80, isProxy: true, scheme: "basic",
  }).handled, false);
});

for (const scenario of [
  { name: "first apply", initialProxy: "http://old:pw@proxy.example", clearFailures: [1], action: h => h.controller.applySaved() },
  { name: "authenticated switch", initialProxy: "http://old:pw@proxy.example", clearFailures: [2], action: h => h.controller.setProxy("http://new:pw@new.example") },
  { name: "clear", initialProxy: "http://old:pw@proxy.example", clearFailures: [2], action: h => h.controller.setProxy(null) },
  {
    name: "rollback",
    initialProxy: "http://old:pw@proxy.example",
    clearFailures: [3],
    restartResults: [{ status: "needs-setup", detail: "http://secret:pw@proxy.example" }],
    action: h => h.controller.setProxy("http://new:pw@new.example"),
  },
]) {
  test(`clearAuthCache failure is fail-closed during ${scenario.name}`, async () => {
    const initialEnvironment = {
      HTTP_PROXY: "http://inherited.example:8080",
      no_proxy: "internal.example",
      OTHER: "kept",
    };
    const testHarness = harness({ ...scenario, environment: initialEnvironment });
    if (scenario.name !== "first apply") await testHarness.controller.applySaved();
    const snapshot = { ...testHarness.environment };
    const stateBefore = testHarness.readState();
    const eventsBefore = testHarness.events.length;
    await assert.rejects(scenario.action(testHarness), new RegExp(NETWORK_PROXY_FATAL_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.deepEqual(testHarness.environment, snapshot);
    assert.deepEqual(testHarness.readState(), stateBefore);
    assert.deepEqual(testHarness.fatalMessages, [NETWORK_PROXY_FATAL_MESSAGE]);
    assert.equal(testHarness.events.slice(eventsBefore).at(-1), "clear");
    assert.equal(loginAttempt(testHarness.controller, testHarness.browserSession, {
      host: "proxy.example", port: 80, isProxy: true, scheme: "basic",
    }).handled, false);
  });
}

test("proxy failures expose only fixed safe messages to IPC and logs", async () => {
  const testHarness = harness({
    initialProxy: "http://old:pw@old.example",
    restartResults: [
      { status: "needs-setup", detail: "http://secret:pw@private.example:8123" },
      { status: "ready" },
    ],
  });
  await testHarness.controller.applySaved();
  const handler = testHarness.handlers.get("launcher:network-proxy");
  await assert.rejects(handler({}, "http://new:pw@new.example:9123"), /Managed runtimes could not restart/);
  const exposed = JSON.stringify(testHarness.logs);
  assert.doesNotMatch(exposed, /secret|private\.example|new\.example|9123|http:/);
});
