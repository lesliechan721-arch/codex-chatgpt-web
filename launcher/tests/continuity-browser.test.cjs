const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const {
  bindContinuityTab, continuityLease, inspectContinuityConversation, assertContinuityStart,
} = require("../electron/continuity-lease.cjs");

function fixture(manual = false, established = true) {
  let marks = 0;
  const terminal = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, setWindowOpenHandler() {}, getURL: () => tab.url,
    executeJavaScript() { throw new Error("This lease check must not inspect the DOM"); },
  });
  const tab = {
    id: "test-tab", traceId: "test-trace", helperPid: process.pid,
    conversationKey: "a".repeat(64), status: established ? "ready" : "running",
    interactionMode: manual ? "manual" : "automatic",
    manualState: established ? "completed" : "sent", manualConversationReused: false,
    url: "https://chatgpt.com/c/first", view: { webContents: contents },
  };
  bindContinuityTab(tab, { owner: "b".repeat(64) });
  if (established) tab.continuityLastSuccessAt = Date.now();
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), logger: { info() {}, warn() {}, error() {} },
    getBrowserInteractionMode: () => manual ? "manual" : "automatic",
    snapshot: () => ({}), syncViewVisibility() {}, syncPowerSaveBlocker() {},
    markTurnTabSurface: async () => { marks++; },
    signalManualTerminal: (_tab, state) => terminal.push(state),
  });
  if (manual) host.bindManualTurnContents(tab);
  else host.bindTurnContents(tab);
  return { host, tab, contents, terminal, marks: () => marks };
}

for (const manual of [false, true]) {
  for (const navigation of ["reload", "path", "page-event"]) {
    test(`${manual ? "manual" : "automatic"} continuity rejects ${navigation} without re-marking the document`, async () => {
      const f = fixture(manual);
      const key = f.tab.conversationKey;
      const lease = continuityLease(f.tab);
      if (navigation === "page-event") {
        f.contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/c/other", true);
      } else {
        f.contents.emit("did-start-navigation", {}, navigation === "reload" ? f.tab.url : "https://chatgpt.com/c/other",
          navigation !== "reload", true);
      }
      assert.equal(f.tab.continuityInvalidated, true);
      assert.equal(f.tab.status, "error");
      assert.throws(() => inspectContinuityConversation(f.host, key, lease), { code: "continuity_session_lost" });
      f.contents.emit("did-finish-load");
      await Promise.resolve();
      assert.equal(f.marks(), 0);
      // Neither a late heartbeat nor an exact retry may revive the replaced document.
      assert.throws(() => f.host.heartbeatTurn(f.tab.traceId, process.pid));
      f.tab.status = "running";
      assert.throws(() => assertContinuityStart(f.tab, { owner: lease.owner }, lease.traceId, process.pid));
    });
  }
  test(`${manual ? "manual" : "automatic"} continuity allows anchor changes but never renews idle time`, () => {
    const f = fixture(manual);
    const key = f.tab.conversationKey;
    const lease = continuityLease(f.tab);
    const lastSuccess = f.tab.continuityLastSuccessAt;
    f.contents.emit("did-start-navigation", {}, "https://example.com/frame", false, false);
    f.contents.emit("did-start-navigation", {}, `${f.tab.url}#answer`, true, true);
    f.contents.emit("did-navigate-in-page", {}, f.tab.url, true);
    assert.equal(inspectContinuityConversation(f.host, key, lease).state, "ready");
    assert.equal(f.tab.continuityLastSuccessAt, lastSuccess);
  });
}

test("initial manual provisional navigation remains allowed, but a changed conversation after MCP starts fails", () => {
  const f = fixture(true, false);
  const key = f.tab.conversationKey;
  f.contents.emit("did-start-navigation", {}, "https://chatgpt.com/c/settled", true, true);
  assert.equal(f.tab.conversationKey, key);
  assert.deepEqual(f.terminal, []);
  f.tab.manualState = "running";
  f.contents.emit("did-start-navigation", {}, "https://chatgpt.com/c/other", true, true);
  assert.equal(f.tab.status, "error");
  assert.equal(f.tab.continuityInvalidated, true);
  assert.deepEqual(f.terminal, ["failed"]);
});

test("initial Automatic creation and old recoverable pages keep their existing navigation contract", () => {
  for (const oldMode of [false, true]) {
    const f = fixture(false, oldMode);
    if (oldMode) delete f.tab.continuityOwner;
    const key = f.tab.conversationKey;
    f.contents.emit("did-start-navigation", {}, "https://chatgpt.com/c/created", false, true);
    assert.equal(f.tab.conversationKey, key);
    assert.equal(f.tab.continuityInvalidated, undefined);
  }
});

test("five healthy continuity pages refuse both creation paths before allocation or clipboard writes", async () => {
  const f = fixture();
  for (let index = 1; index < 5; index++) f.host.turnTabs.set(`tab-${index}`, { ...f.tab, id: `tab-${index}` });
  f.host.removeTurnTab = () => { throw new Error("A healthy continuity page must not be evicted"); };
  f.host.writeManualPrompt = () => { throw new Error("Capacity must be checked before copying a prompt"); };
  assert.equal(f.host.hasContinuityCapacity(), false);
  await assert.rejects(f.host.createTurnTab("next-trace", process.pid, "c".repeat(64), "connector", undefined,
    { owner: "b".repeat(64) }), { code: "continuity_resource_capacity" });
  assert.throws(() => f.host.createManualTurnTab("next-trace", process.pid, "c".repeat(64), "prompt", 1000, true,
    { owner: "b".repeat(64) }), { code: "continuity_resource_capacity" });
  assert.equal(f.host.turnTabs.size, 5);
  delete f.host.turnTabs.get("tab-4").continuityOwner;
  assert.equal(f.host.hasContinuityCapacity(), true);
  assert.equal(f.host.turnTabs.size, 5);
});

test("a busy launcher rejects initial continuity as pre-mutation capacity on both creation paths", async () => {
  const claim = { owner: "d".repeat(64) };
  const automatic = fixture(false);
  automatic.host.manualOperation = "ChatGPT login";
  await assert.rejects(automatic.host.beginTurn(
    "new-auto-trace", false, process.pid, "e".repeat(64), "connector", false, undefined, claim,
  ), { code: "continuity_resource_capacity" });
  assert.equal(automatic.host.turnTabs.size, 1);

  const manual = fixture(true);
  manual.host.manualOperation = "ChatGPT login";
  assert.throws(() => manual.host.beginManualTurn(
    "new-manual-trace", process.pid, "prompt", "f".repeat(64), undefined, false, true, true, claim, false,
  ), { code: "continuity_resource_capacity" });
  assert.equal(manual.host.turnTabs.size, 1);
});

test("the authenticated capacity query is read-only and works without Zero Risk browser inspection", async () => {
  const f = fixture(true);
  for (let index = 1; index < 5; index++) f.host.turnTabs.set(`tab-${index}`, { ...f.tab, id: `tab-${index}` });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getPreferences: () => ({}), getBrowserHost: () => f.host,
  }).start();
  const { endpoint, token } = server.descriptor();
  const query = authorization => fetch(`${endpoint}/v1/turn/continuity-capacity`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}",
  });
  try {
    assert.equal((await query("Bearer wrong")).status, 401);
    const before = f.tab.continuityLastSuccessAt;
    const full = await query(`Bearer ${token}`);
    assert.equal(full.status, 200);
    assert.deepEqual(await full.json(), { ok: true, available: false });
    assert.equal(f.tab.continuityLastSuccessAt, before);
    assert.equal(f.host.turnTabs.size, 5);
    f.host.turnTabs.delete("tab-4");
    assert.deepEqual(await (await query(`Bearer ${token}`)).json(), { ok: true, available: true });
  } finally { await server.close(); }
});
