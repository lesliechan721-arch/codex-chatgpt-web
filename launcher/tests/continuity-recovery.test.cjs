const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once, EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { bindContinuityTab, continuityLease } = require("../electron/continuity-lease.cjs");
const { queryContinuityTransaction, updateContinuityPreparation, markContinuitySendPossible,
  retireContinuityWriter } = require("../electron/continuity-recovery.cjs");
const { launcherInstance, knownProcessStart, launcherProcessInstanceStatus } = require("../electron/continuity-process-instance.cjs");

const recovery = overrides => ({ schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64),
  epoch: 0, transactionId: "c".repeat(64), transactionVersion: 0, logicalWorkId: "d".repeat(64), attempt: 0,
  snapshotVersion: 0, snapshotDigest: "e".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "verified-test-instance" }, launcherInstance: instance, ...overrides });
const instance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) };
const owner = "f".repeat(64);
function fixture(manual = false) {
  let allocations = 0;
  let copies = 0;
  let wait;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    continuityLauncherInstance: instance, turnTabs: new Map(), logger: { info() {}, warn() {}, error() {} },
    browserInteractionMode: () => manual ? "manual" : "automatic",
    removeTurnTab(tab) { tab.view.webContents.close(); this.turnTabs.delete(tab.id); },
    beginTurnAcquisition: async (traceId, reveal, helperPid, conversationKey, connectorIdentity, retained, signal, claim) => {
      assert.equal(signal, undefined, "an observer's abort cannot cancel a reserved acquisition");
      const tab = allocate(traceId, helperPid, conversationKey, claim);
      if (wait) await wait;
      return { surfaceId: tab.surfaceId, tabId: tab.id, reused: false, connectorBound: false, continuity: continuityLease(tab) };
    },
    beginManualTurnAcquisition: (traceId, helperPid, prompt, conversationKey, resume, compact, policy, expected, claim) => {
      const tab = allocate(traceId, helperPid, conversationKey, claim);
      copies++;
      return { tabId: tab.id, reused: false, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        state: "awaiting-user", sentConfirmationRequired: true, continuity: continuityLease(tab) };
    },
  });
  function allocate(traceId, helperPid, conversationKey, claim) {
    allocations++;
    let destroyed = false;
    const tab = { id: `tab-${allocations}`, surfaceId: "s".repeat(32), traceId, helperPid, conversationKey,
      status: "running", interactionMode: manual ? "manual" : "automatic",
      view: { webContents: { isDestroyed: () => destroyed, close: () => { destroyed = true; },
        executeJavaScript: () => { throw new Error("Recovery must not inspect DOM"); } } } };
    bindContinuityTab(tab, claim);
    host.turnTabs.set(tab.id, tab);
    return tab;
  }
  return { host, allocations: () => allocations, copies: () => copies, hold: promise => { wait = promise; } };
}
function start(f, identity, trace = "first-trace", pid = process.pid) {
  return f.host.beginTurn(trace, false, pid, "1".repeat(64), "connector", false, new AbortController().signal,
    { owner, recovery: identity });
}

for (const manual of [false, true]) test(`Windows creation identity admits the first Launcher transaction manual=${manual}`, async () => {
  const f = fixture(manual);
  const windows = { ...instance, startIdentity: "win32:134045280001234567" };
  f.host.continuityLauncherInstance = windows;
  const identity = recovery({ launcherInstance: windows });
  assert.equal(knownProcessStart(windows.startIdentity), true);
  const acquired = manual
    ? await f.host.beginManualTurn("first-windows", process.pid, "Actual prompt", "1".repeat(64), false, false,
      undefined, false, { owner, recovery: identity })
    : await start(f, identity, "first-windows");
  assert.deepEqual(acquired.continuity.recovery.launcherInstance, windows);
  assert.equal(markContinuitySendPossible(f.host, identity).sendAuthorized, !manual);
  assert.equal(f.allocations(), 1);
  assert.equal(f.copies(), manual ? 1 : 0);
});

function useActualDeferredRemoval(f, tab) {
  Object.assign(f.host, { removeTurnTab: BrowserHost.prototype.removeTurnTab, closedTurnOwners: new Map(),
    selectedTabId: "home", window: { contentView: { removeChildView() {} } },
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {}, snapshot: () => ({}) });
  let destroyed = false;
  let closes = 0;
  const contents = new EventEmitter();
  contents.isDestroyed = () => destroyed;
  contents.close = () => { closes++; };
  tab.view.webContents = contents;
  return { contents, closes: () => closes,
    destroy: (notify = true) => { destroyed = true; if (notify) contents.emit("destroyed"); } };
}

test("actual remove keeps asynchronous closing writers visible to repeated retirement and admission", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const old = f.host.turnTabs.get(acquired.tabId);
  const closing = useActualDeferredRemoval(f, old);
  markContinuitySendPossible(f.host, identity);
  for (let index = 0; index < 3; index++) {
    await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
    const observed = queryContinuityTransaction(f.host, identity);
    assert.equal(observed.writerRetired, false);
    assert.equal(observed.hostNoWriter, false);
  }
  assert.equal(f.host.turnTabs.size, 0);
  assert.equal(closing.closes(), 1);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  await assert.rejects(start(f, next, "blocked-next"), { code: "continuity_execution_unsettled" });
  assert.equal(f.allocations(), 1);
  closing.destroy();
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  await start(f, next, "after-actual-destroy");
  assert.equal(f.allocations(), 2);
  assert.equal(markContinuitySendPossible(f.host, next).sendAuthorized, true);
  assert.equal(markContinuitySendPossible(f.host, next).sendAuthorized, false);
});

test("a lost transaction table cannot hide a closing physical writer", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const old = f.host.turnTabs.get(acquired.tabId);
  const closing = useActualDeferredRemoval(f, old);
  f.host.removeTurnTab(old, true);
  f.host.continuityTransactions.clear();
  const observed = queryContinuityTransaction(f.host, identity);
  assert.equal(observed.state, "unknown");
  assert.equal(observed.hostNoWriter, false);
  assert.equal(observed.writerRetired, false);
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, false);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  await assert.rejects(start(f, next), { code: "continuity_execution_unsettled" });
  closing.destroy();
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  await start(f, next);
  assert.equal(f.allocations(), 2);
});

test("a late destroyed event and old tab removal cannot retire a newer transaction", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const old = f.host.turnTabs.get(acquired.tabId);
  const closing = useActualDeferredRemoval(f, old);
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  closing.destroy(false);
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  const acquiredNext = await start(f, next, "new-trace");
  const current = f.host.turnTabs.get(acquiredNext.tabId);
  f.host.turnTabs.delete(current.id);
  current.id = old.id;
  f.host.turnTabs.set(current.id, current);
  f.host.continuityTransactions.get(`${next.installationId}:${next.threadKey}`).tabId = current.id;
  closing.contents.emit("destroyed");
  f.host.removeTurnTab(old, true);
  assert.equal(f.host.turnTabs.get(current.id), current);
  const observed = queryContinuityTransaction(f.host, next);
  assert.equal(observed.writerRetired, false);
  assert.equal(observed.hostNoWriter, false);
  assert.equal(observed.state, "prepared");
});

test("creating retirement waits for the acquisition and exact physical destruction", async () => {
  const f = fixture();
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const identity = recovery();
  const acquiring = start(f, identity);
  const old = [...f.host.turnTabs.values()][0];
  const closing = useActualDeferredRemoval(f, old);
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  closing.destroy();
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, false);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  await assert.rejects(start(f, next), { code: "continuity_execution_unsettled" });
  release();
  await assert.rejects(acquiring, { code: "continuity_source_unproven" });
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  await start(f, next, "after-creating-settled");
  assert.equal(f.allocations(), 2);
});

test("closing eviction occupies the fifth physical slot for automatic and manual allocation", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const old = f.host.turnTabs.get(acquired.tabId);
  old.ordinal = 1;
  const closing = useActualDeferredRemoval(f, old);
  for (let index = 2; index <= 5; index++) {
    const lease = await start(f, recovery({ threadKey: String(index).repeat(64), transactionId: String(index).repeat(64) }), `other-${index}`);
    f.host.turnTabs.get(lease.tabId).ordinal = index;
  }
  old.status = "ready";
  delete old.continuityOwner;
  assert.equal(f.host.hasContinuityCapacity(), true);
  assert.throws(() => f.host.createManualTurnTab("sixth-manual", process.pid, "6".repeat(64), "prompt", 1000, true,
    { owner }), { code: "continuity_resource_capacity" });
  assert.equal(f.host.hasContinuityCapacity(), false);
  await assert.rejects(f.host.createTurnTab("sixth-auto", process.pid, "6".repeat(64), "connector", undefined,
    { owner }), { code: "continuity_resource_capacity" });
  assert.equal(f.allocations(), 5);
  assert.equal(closing.closes(), 1);
  closing.destroy();
  assert.equal(f.host.hasContinuityCapacity(), true);
  assert.equal(f.host.hasContinuityCapacity(), true);
  assert.equal(f.host.turnTabs.size, 4);
});

test("a failed close request cannot grant retirement before physical destruction", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const old = f.host.turnTabs.get(acquired.tabId);
  const closing = useActualDeferredRemoval(f, old);
  closing.contents.close = () => { throw new Error("Local close request failed"); };
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  assert.equal(queryContinuityTransaction(f.host, identity).hostNoWriter, false);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  await assert.rejects(start(f, next), { code: "continuity_execution_unsettled" });
  closing.destroy();
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  await start(f, next, "after-close-failure-settled");
  assert.equal(f.allocations(), 2);
});

test("retiring a pending allocator cannot grant a page before its late physical entity is destroyed", async () => {
  const f = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.host.beginTurnAcquisition;
  let closing;
  f.host.beginTurnAcquisition = async (...args) => {
    await gate;
    const result = original(...args);
    if (args[0] === "first-trace") closing = useActualDeferredRemoval(f, [...f.host.turnTabs.values()][0]);
    return result;
  };
  const identity = recovery();
  const acquiring = start(f, identity);
  assert.equal(f.allocations(), 0);
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, false);
  assert.equal(queryContinuityTransaction(f.host, identity).hostNoWriter, false);
  const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 });
  await assert.rejects(start(f, next), { code: "continuity_execution_unsettled" });
  release();
  await assert.rejects(acquiring, { code: "continuity_source_unproven" });
  assert.equal(f.host.turnTabs.size, 0);
  assert.equal(closing.closes(), 1);
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, false);
  assert.equal(queryContinuityTransaction(f.host, identity).hostNoWriter, false);
  await assert.rejects(start(f, next), { code: "continuity_execution_unsettled" });
  closing.destroy();
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  await start(f, next, "after-late-entity-destroyed");
  assert.equal(f.allocations(), 2);
});

test("whole-host destruction shares closing evidence and cannot create another page", async () => {
  const f = fixture();
  const identity = recovery();
  const acquired = await start(f, identity);
  const closing = useActualDeferredRemoval(f, f.host.turnTabs.get(acquired.tabId));
  Object.assign(f.host, { shellZoomShortcutBindings: new Map(), closeAuthView() {}, clearHomeNavigationTimeout() {},
    powerSaveBlockerId: null });
  f.host.window.off = () => {};
  f.host.destroy();
  assert.equal(f.host.turnTabs.size, 0);
  assert.equal(closing.closes(), 1);
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, false);
  assert.equal(queryContinuityTransaction(f.host, identity).hostNoWriter, false);
  await assert.rejects(start(f, recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 })),
    { code: "continuity_unverified" });
  closing.destroy();
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, true);
  assert.equal(queryContinuityTransaction(f.host, identity).hostNoWriter, true);
});

test("real automatic entry shares one concurrent transaction and reconciles its lost response", async () => {
  const f = fixture();
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const identity = recovery();
  const first = start(f, identity);
  const second = start(f, identity);
  assert.equal(f.allocations(), 1);
  assert.equal(queryContinuityTransaction(f.host, identity).state, "creating");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.deepEqual(await start(f, identity), a);
  assert.equal(f.allocations(), 1);
  assert.equal(queryContinuityTransaction(f.host, identity).state, "prepared");
  await assert.rejects(start(f, identity, "bypass-trace"), { code: "continuity_execution_unsettled" });
});

test("prepared snapshot CAS updates one page and freezes input before Send", async () => {
  const f = fixture();
  const before = recovery();
  await start(f, before);
  const after = recovery({ transactionVersion: 1, snapshotVersion: 1, snapshotDigest: "2".repeat(64) });
  assert.equal(updateContinuityPreparation(f.host, before, after).state, "prepared");
  assert.deepEqual(queryContinuityTransaction(f.host, after).preparationExpected, before);
  assert.equal(updateContinuityPreparation(f.host, before, after).recovery.snapshotVersion, 1);
  assert.throws(() => updateContinuityPreparation(f.host, { ...before, snapshotDigest: "9".repeat(64) }, after),
    { code: "continuity_source_unproven" });
  assert.equal(f.allocations(), 1);
  assert.throws(() => markContinuitySendPossible(f.host, before), { code: "continuity_source_unproven" });
  assert.equal(markContinuitySendPossible(f.host, after).sendAuthorized, true);
  assert.equal(markContinuitySendPossible(f.host, after).sendAuthorized, false);
  const next = recovery({ transactionVersion: 2, snapshotVersion: 2 });
  assert.throws(() => updateContinuityPreparation(f.host, after, next), { code: "continuity_execution_unsettled" });
  await assert.rejects(start(f, { ...next, attempt: 1, epoch: 1 }), { code: "continuity_execution_unsettled" });
  assert.equal(f.allocations(), 1);
});

test("creating retains its exact predecessor until the same acquisition becomes prepared", async () => {
  const f = fixture();
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const before = recovery();
  const after = recovery({ transactionVersion: 1, snapshotVersion: 1,
    ownerProcess: { pid: process.pid, startIdentity: "new-backend-instance" } });
  const acquiring = start(f, before);
  const server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  const { endpoint, token } = server.descriptor();
  const post = (action, body) => fetch(`${endpoint}/v1/turn/continuity-${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await (await post("query", { recovery: before })).json()).state, "creating");
    assert.equal((await post("prepare", { expected: before, recovery: after })).status, 409);
    assert.equal((await (await post("query", { recovery: before })).json()).state, "creating");
    assert.equal((await post("query", { recovery: after })).status, 409);
    assert.equal(f.allocations(), 1);
    release();
    await acquiring;
    assert.equal((await (await post("query", { recovery: before })).json()).state, "prepared");
    const migrated = await (await post("prepare", { expected: before, recovery: after })).json();
    assert.equal(migrated.state, "prepared");
    assert.deepEqual(migrated.recovery, after);
    assert.deepEqual(migrated.preparationExpected, before);
    assert.equal(f.allocations(), 1);
  } finally { release(); await acquiring.catch(() => {}); await server.close(); }
});

test("actual prepared CAS reconciles handler-before failure and an applied response loss exactly once", async () => {
  const f = fixture();
  const before = recovery();
  const after = recovery({ transactionVersion: 1, snapshotVersion: 1,
    snapshotDigest: "2".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "new-backend-instance" } });
  await start(f, before);
  let hostReady = false;
  const server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}),
    getBrowserHost: () => hostReady ? f.host : undefined }).start();
  const { endpoint, token } = server.descriptor();
  const post = (action, body) => fetch(`${endpoint}/v1/turn/continuity-${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post("prepare", { expected: before, recovery: after })).status, 503);
    assert.deepEqual(queryContinuityTransaction(f.host, before).recovery, before);
    hostReady = true;
    let drop = true;
    server.server.prependListener("request", (request, response) => {
      if (request.url === "/v1/turn/continuity-prepare" && drop) {
        drop = false;
        response.end = () => { response.socket.destroy(); return response; };
      }
    });
    await assert.rejects(post("prepare", { expected: before, recovery: after }));
    assert.equal((await post("query", { recovery: before })).status, 409);
    const observed = await (await post("query", { recovery: after })).json();
    assert.equal(observed.state, "prepared");
    assert.deepEqual(observed.preparationExpected, before);
    const replay = await (await post("prepare", { expected: before, recovery: after })).json();
    assert.deepEqual(replay, observed);
    assert.equal((await post("prepare", { expected: { ...before, snapshotDigest: "9".repeat(64) }, recovery: after })).status, 409);
    const second = recovery({ transactionVersion: 2, snapshotVersion: 2, snapshotDigest: "3".repeat(64),
      ownerProcess: { pid: process.pid, startIdentity: "another-backend-instance" } });
    const next = await (await post("prepare", { expected: after, recovery: second })).json();
    assert.deepEqual(next.preparationExpected, after);
    assert.equal((await post("prepare", { expected: before, recovery: after })).status, 409);
    assert.equal(f.allocations(), 1);
    assert.equal(f.host.turnTabs.size, 1);
    assert.equal((await (await post("send-possible", { recovery: second })).json()).sendAuthorized, true);
    assert.equal((await (await post("send-possible", { recovery: second })).json()).sendAuthorized, false);
  } finally { await server.close(); }
});

test("retirement removes only the target thread while its owner process remains alive", async () => {
  const f = fixture();
  const before = recovery();
  await start(f, before);
  await start(f, recovery({ threadKey: "3".repeat(64), transactionId: "4".repeat(64) }), "other-trace");
  markContinuitySendPossible(f.host, before);
  const retired = await retireContinuityWriter(f.host, before);
  assert.equal(retired.state, "retired");
  assert.equal(retired.writerRetired, true);
  assert.equal(retired.toolsSettled, false);
  assert.equal(f.host.turnTabs.size, 1);
  process.kill(process.pid, 0);
  const next = recovery({ epoch: 1, attempt: 1, transactionVersion: 1, snapshotVersion: 1 });
  await start(f, next, "recovered-trace");
  assert.equal(f.allocations(), 3);
  assert.throws(() => markContinuitySendPossible(f.host, before), { code: "continuity_source_unproven" });
});

test("late acquisition cannot bind after its transaction was retired", async () => {
  const f = fixture();
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const identity = recovery();
  const pending = start(f, identity);
  await assert.rejects(retireContinuityWriter(f.host, identity), { code: "continuity_unverified" });
  assert.equal(queryContinuityTransaction(f.host, identity).writerRetired, false);
  release();
  await assert.rejects(pending, { code: "continuity_source_unproven" });
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, true);
  assert.equal(f.host.turnTabs.size, 0);
});

test("real manual entry preserves the new prompt's manual confirmation and cannot rebind an exposed input", () => {
  const f = fixture(true);
  const identity = recovery();
  const lease = f.host.beginManualTurn("manual-trace", process.pid, "new prompt", "1".repeat(64), undefined,
    false, true, true, { owner, recovery: identity });
  assert.equal(lease.state, "awaiting-user");
  assert.equal(lease.sentConfirmationRequired, true);
  assert.equal(queryContinuityTransaction(f.host, identity).state, "send-possible");
  assert.deepEqual(f.host.beginManualTurn("manual-trace", process.pid, "new prompt", "1".repeat(64), undefined,
    false, true, true, { owner, recovery: identity }), lease);
  assert.equal(f.copies(), 1);
  assert.throws(() => updateContinuityPreparation(f.host, identity,
    recovery({ transactionVersion: 1, snapshotVersion: 1 })), { code: "continuity_execution_unsettled" });
});

test("the exact host with no thread writer proves a missing receipt without declaring tool settlement", () => {
  const observed = queryContinuityTransaction(fixture().host, recovery());
  assert.deepEqual(observed, { recovery: recovery(), state: "missing", writerRetired: true, toolsSettled: false, launcherInstance: instance, hostNoWriter: true });
});

test("actual authenticated control endpoints query, CAS, freeze and retire one page", async () => {
  const f = fixture();
  const server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  const { endpoint, token } = server.descriptor();
  const post = (action, body, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/turn/${action}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const identity = recovery();
  try {
    assert.equal((await post("continuity-query", { recovery: identity }, "Bearer invalid")).status, 401);
    assert.equal((await post("start", { traceId: "control-trace", helperPid: process.pid, conversationKey: "1".repeat(64), continuity: { owner, recovery: identity } })).status, 200);
    assert.equal((await (await post("continuity-query", { recovery: identity })).json()).state, "prepared");
    const after = recovery({ transactionVersion: 1, snapshotVersion: 1 });
    assert.equal((await post("continuity-prepare", { expected: identity, recovery: after })).status, 200);
    // The trace and helper can remain the same across a prepared-input CAS. Version proof is
    // still mandatory before a late observer is allowed to heartbeat or release this page.
    assert.equal((await post("heartbeat", { traceId: "control-trace", helperPid: process.pid, recovery: identity })).status, 409);
    assert.equal((await post("end", { traceId: "control-trace", helperPid: process.pid, recovery: identity, status: "failed" })).status, 409);
    assert.equal(f.host.turnTabs.size, 1);
    assert.equal((await post("continuity-send-possible", { recovery: identity })).status, 409);
    assert.equal((await (await post("continuity-send-possible", { recovery: after })).json()).sendAuthorized, true);
    const retired = await (await post("continuity-retire", { recovery: after })).json();
    assert.equal(retired.writerRetired, true);
    assert.equal(retired.toolsSettled, false);
    assert.equal(f.allocations(), 1);
  } finally { await server.close(); }
});

test("an unconfirmed page destruction cannot grant a subsequent attempt", async () => {
  const f = fixture();
  const before = recovery();
  await start(f, before);
  f.host.removeTurnTab = () => {};
  await assert.rejects(retireContinuityWriter(f.host, before), { code: "continuity_unverified" });
  await assert.rejects(start(f, recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 })),
    { code: "continuity_execution_unsettled" });
  assert.equal(f.allocations(), 1);
});

test("the real healthy-page acquisition accepts the next work without increasing its epoch or allocating a page", async () => {
  const f = fixture();
  const first = recovery();
  const initial = await start(f, first);
  Object.assign(f.host, { userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, publishState() {}, snapshot: () => ({}), writeDescriptor() {} });
  const tab = f.host.turnTabs.get(initial.tabId);
  tab.connectorIdentity = "connector";
  tab.view.webContents.setBackgroundThrottling = () => {};
  await f.host.endTurn("first-trace", process.pid, "completed", false, undefined, true, true);
  assert.equal(queryContinuityTransaction(f.host, first).state, "completed");
  const next = recovery({ transactionId: "5".repeat(64), logicalWorkId: "6".repeat(64) });
  delete f.host.beginTurnAcquisition;
  const lease = await f.host.beginTurn("next-work-trace", false, process.pid, "1".repeat(64), "connector", true,
    undefined, { owner, expected: initial.continuity, recovery: next });
  assert.equal(lease.reused, true);
  assert.equal(lease.continuity.recovery.epoch, 0);
  assert.equal(lease.continuity.recovery.transactionId, next.transactionId);
  assert.equal(f.allocations(), 1);
  assert.equal(f.host.turnTabs.size, 1);
});

async function oldLauncherProcess() {
  const child = spawn(process.execPath, ["-e", `
    const {launcherInstance}=require(${JSON.stringify(require.resolve("../electron/continuity-process-instance.cjs"))});
    process.stdout.write(JSON.stringify(launcherInstance({}))+"\\n");
    setInterval(()=>{},1000);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const data = await once(child.stdout, "data");
  const identity = JSON.parse(data[0].toString().trim());
  return { child, identity, close: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "close"); } } };
}

test("authenticated missing receipts require old Launcher instance exit and no surviving thread writer", async t => {
  const old = await oldLauncherProcess();
  const f = fixture();
  f.host.continuityLauncherInstance = launcherInstance({});
  const server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  const { endpoint, token } = server.descriptor();
  const post = async (action, identity) => {
    const response = await fetch(`${endpoint}/v1/turn/continuity-${action}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ recovery: identity }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    if (!knownProcessStart(old.identity.startIdentity) || !knownProcessStart(f.host.continuityLauncherInstance.startIdentity)) {
      t.skip("OS process start identity is unavailable in this test sandbox"); return;
    }
    const before = recovery({ launcherInstance: old.identity });
    assert.equal(launcherProcessInstanceStatus(old.identity), "live");
    const live = await post("query", before);
    assert.equal(live.state, "missing");
    assert.equal(live.hostNoWriter, true);
    assert.equal(live.writerRetired, false);
    assert.equal((await post("retire", before)).writerRetired, false);
    const unknown = recovery({ launcherInstance: { ...old.identity, startIdentity: "unverified" } });
    assert.equal((await post("query", unknown)).writerRetired, false);
    assert.equal((await post("retire", recovery({ launcherInstance: undefined }))).writerRetired, false);
    await old.close();
    assert.equal(launcherProcessInstanceStatus(old.identity), "exited");
    const exited = await post("query", before);
    assert.equal(exited.writerRetired, true);
    assert.equal(exited.toolsSettled, false);
    assert.equal((await post("retire", before)).writerRetired, true);
    assert.deepEqual(exited.launcherInstance, f.host.continuityLauncherInstance);
    const next = recovery({ epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1,
      launcherInstance: f.host.continuityLauncherInstance });
    await start(f, next, "after-launcher-restart");
    assert.equal(markContinuitySendPossible(f.host, next).sendAuthorized, true);
    assert.equal(markContinuitySendPossible(f.host, next).sendAuthorized, false);
    assert.equal(f.allocations(), 1);
    // A live same-thread page blocks every missing-old-transaction shortcut.
    await assert.rejects(post("query", before), /Expected values/);
  } finally { await old.close(); await server.close(); }
});

test("an actual surviving same-thread page prevents empty-table retirement proof", async () => {
  const f = fixture();
  const identity = recovery();
  await start(f, identity);
  f.host.continuityTransactions.clear();
  const observed = queryContinuityTransaction(f.host, identity);
  assert.equal(observed.state, "unknown");
  assert.equal(observed.hostNoWriter, false);
  assert.equal(observed.writerRetired, false);
  assert.equal((await retireContinuityWriter(f.host, identity)).writerRetired, false);
  await assert.rejects(start(f, recovery({ attempt: 1, snapshotVersion: 1, transactionVersion: 1 })), { code: "continuity_execution_unsettled" });
  assert.equal(f.allocations(), 1);
});
