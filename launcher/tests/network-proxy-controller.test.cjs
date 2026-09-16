const test = require("node:test");
const assert = require("node:assert/strict");
const { createNetworkProxyController } = require("../electron/network-proxy.cjs");

function harness({
  failStateUpdate = false,
  initialProxy = null,
  restartResults = [{ status: "ready" }],
  runtimeOperation = null,
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
  let restartIndex = 0;
  let activeRuntimeOperation = runtimeOperation;
  const environment = { OTHER: "kept" };
  const supervisor = {
    readConfig: () => ({ mode: "full" }),
    restart: async () => restartResults[Math.min(restartIndex++, restartResults.length - 1)],
  };
  const controller = createNetworkProxyController({
    browserPartition: "persist:test-chatgpt",
    environment,
    getBrowserHost: () => ({ activeTraceId: null, currentOperation: () => null }),
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
        return {
          setProxy: async config => applied.push(config),
          closeAllConnections: async () => connectionsClosed.push(true),
        };
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
    connectionsClosed,
    controller,
    environment,
    handlers,
    logs,
    published,
    readState: () => structuredClone(state),
    restartCount: () => restartIndex,
  };
}

test("proxy controller applies persisted proxy before runtime startup", async () => {
  const testHarness = harness({ initialProxy: "http://127.0.0.1:7890/" });
  await testHarness.controller.applySaved();
  assert.deepEqual(testHarness.applied, [{
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:7890/",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  }]);
  assert.equal(testHarness.environment.HTTPS_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.environment.TUNNEL_CLIENT_HTTP_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.restartCount(), 0);
  assert.equal(testHarness.connectionsClosed.length, 1);
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
    /runtime failed/,
  );
  assert.equal(testHarness.readState().networkProxyUrl, "http://127.0.0.1:7890/");
  assert.equal(testHarness.environment.HTTPS_PROXY, "http://127.0.0.1:7890/");
  assert.equal(testHarness.restartCount(), 2);
  assert.deepEqual(testHarness.applied.at(-1), {
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:7890/",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  });
});

test("proxy controller restores the prior proxy when state persistence fails", async () => {
  const testHarness = harness({ failStateUpdate: true });
  await assert.rejects(
    testHarness.controller.setProxy("http://localhost:9999"),
    /state write failed/,
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
    sessionApi: { fromPartition: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }) },
    stateStore: {
      read: () => structuredClone(state),
      update: patch => (state = { ...state, ...patch }),
    },
  });
  await assert.rejects(controller.setProxy("http://127.0.0.1:7890"), /Finish or cancel active ChatGPT turns/);
  assert.equal(state.networkProxyUrl, null);
});
