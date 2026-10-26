const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { physicalTurnTabs } = require("../electron/continuity-recovery.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

function fixture(mode = "automatic", ready = 5) {
  let host, allocations = 0, copies = 0;
  const events = [], originals = [];
  const instance = { pid: process.pid, startIdentity: "local-capacity-test", instanceId: "0".repeat(64) };
  const filename = require.resolve("../electron/browser-host.cjs"), realRequire = Module.createRequire(filename);
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.require = name => name === "electron" ? { WebContentsView: class {
    constructor() {
      allocations++;
      events.push({ kind: "allocated", physical: physicalTurnTabs(host).length });
      this.webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, setZoomFactor() {} });
    }
  } } : realRequire(name);
  loaded._compile(fs.readFileSync(filename, "utf8"), filename);
  const { BrowserHost } = loaded.exports;
  host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), closingTurnTabs: new Map(), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    continuityLauncherInstance: instance, selectedTabId: "home", state: { zoomFactor: 1 },
    window: { contentView: { removeChildView() {}, addChildView() {} } },
    logger: { info() {}, warn() {}, error() {} }, syncPowerSaveBlocker() {}, syncViewVisibility() {},
    snapshot: () => ({}), writeDescriptor() {}, presentTurnView() {}, bindShellZoomShortcuts() {},
    bindTurnContents() {}, bindManualTurnContents() {}, initializeTurnTab: async () => {}, initializeManualTurnTab: async () => {},
    manualCompletionSignals: new Map(), manualTerminalSignals: new Map(), showWindow() {}, show() {},
    writeManualPrompt() { copies++; }, bindManualContextPlan() {}, armManualTurnDeadline() {},
  });
  for (let index = 1; index <= 5; index++) {
    let destroyed = false, closes = 0;
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, close() { closes++; } });
    const tab = { id: `original-${index}`, traceId: `original-trace-${index}`, helperPid: process.pid, ordinal: index,
      status: index <= ready ? "ready" : "running", interactionMode: mode, manualState: "completed",
      continuityLastSuccessAt: index, view: { webContents: contents } };
    host.turnTabs.set(tab.id, tab);
    originals.push({ contents, tab, closes: () => closes, destroy(notify = true) {
      destroyed = true; events.push({ kind: "destroyed", physical: physicalTurnTabs(host).length });
      if (notify) contents.emit("destroyed");
    } });
  }
  const start = (trace = "sixth", claim = { owner: "a".repeat(64) }, signal) => mode === "manual"
    ? host.beginManualTurn(trace, process.pid, "synthetic prompt", undefined, undefined, false, true, true, claim)
    : host.createTurnTab(trace, process.pid, undefined, undefined, signal, claim);
  return { host, instance, originals, events, start, allocations: () => allocations, copies: () => copies };
}

const flush = async () => { for (let count = 0; count < 6; count++) await Promise.resolve(); };
function authorizedClaim(f) {
  f.instance.startIdentity = "darwin:Sat Oct 10 00:00:00 2026";
  const recovery = { schemaVersion: 2, installationId: "b".repeat(64), threadKey: "c".repeat(64),
    transactionId: "synthetic-transaction", transactionVersion: 0, epoch: 0, logicalWorkId: "synthetic-work", attempt: 0,
    snapshotVersion: 0, snapshotDigest: "d".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "synthetic-owner" }, launcherInstance: f.instance };
  const attempt = { ...recovery, writerRetired: false }, work = { logicalWorkId: recovery.logicalWorkId, purpose: "ordinary",
    workLineageId: recovery.logicalWorkId, state: "active", attempts: [attempt] };
  const record = { epoch: 0, owner: recovery.ownerProcess, currentWorkId: recovery.logicalWorkId, works: { [recovery.logicalWorkId]: work }, calls: {} };
  f.host.continuityAuthorityReader = () => ({ record, work, attempt });
  f.host.browserInteractionMode = () => f.originals[0].tab.interactionMode;
  return { claim: { owner: "a".repeat(64), recovery }, work, attempt };
}

for (const mode of ["automatic", "manual"]) test(`${mode} waits for the exact old page destruction before allocating the sixth page`, async () => {
  const f = fixture(mode);
  let settled = false;
  const pending = Promise.resolve(f.start()).finally(() => { settled = true; }); pending.catch(() => {});
  await flush();
  assert.equal(settled, false, "normal asynchronous close must not become a capacity error");
  assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0); assert.equal(physicalTurnTabs(f.host).length, 5);
  assert.equal(f.originals[0].closes(), 1); assert.equal(f.originals.slice(1).some(item => item.closes()), false);
  f.originals[0].destroy();
  await pending;
  assert.equal(f.allocations(), 1); assert.equal(f.copies(), mode === "manual" ? 1 : 0);
  assert.equal(physicalTurnTabs(f.host).length, 5);
  assert.deepEqual(f.events.map(event => event.kind), ["destroyed", "allocated"]);
  assert.equal(f.events[1].physical, 4);
  assert.equal(f.host.userCancelledTurnOwners.size, 0);
});

for (const mode of ["automatic", "manual"]) for (const throwingClose of [false, true]) test(`${mode} admission times out without restarting the three close attempts (throw=${throwingClose})`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(mode, 1);
  if (throwingClose) {
    const close = f.originals[0].contents.close;
    f.originals[0].contents.close = () => { close(); throw new Error("synthetic close failure"); };
  }
  const pending = Promise.resolve(f.start()); pending.catch(() => {});
  await flush();
  assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0);
  t.mock.timers.tick(5000); await flush();
  await assert.rejects(pending, { code: "continuity_resource_capacity" });
  assert.equal(physicalTurnTabs(f.host).length, 5);
  t.mock.timers.tick(5000); t.mock.timers.tick(5000); await flush();
  const cleanup = f.host.continuityPageCleanups.get(f.originals[0].contents);
  assert.equal(cleanup.state, "failed"); assert.equal(cleanup.attempts, 3); assert.equal(f.originals[0].closes(), 3);
  for (let count = 0; count < 3; count++) await assert.rejects(Promise.resolve(f.start()), { code: "continuity_resource_capacity" });
  t.mock.timers.tick(20000); assert.equal(f.originals[0].closes(), 3);
  assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0); assert.equal(physicalTurnTabs(f.host).length, 5);
  assert.equal(f.originals[0].contents.listenerCount("destroyed"), 2, "admission listener is removed, frozen cleanup listeners remain");
});

test("a missing destroyed event needs actual physical destruction, and a late duplicate cannot remove the replacement", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const pending = f.start(); pending.catch(() => {});
  await flush();
  f.originals[0].destroy(false);
  t.mock.timers.tick(25); await pending;
  assert.equal(f.allocations(), 1); assert.equal(f.host.closingTurnTabs.size, 0);
  const current = [...f.host.turnTabs.values()].find(tab => tab.traceId === "sixth");
  assert.equal(current.ordinal, 1);
  f.originals[0].contents.emit("destroyed");
  assert.equal(f.host.turnTabs.get(current.id), current); assert.equal(physicalTurnTabs(f.host).length, 5);
});

for (const mode of ["automatic", "manual"]) test(`${mode} an unrelated freed slot cannot turn the selected page's timeout into successful eviction`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(mode);
  const pending = Promise.resolve(f.start()); pending.catch(() => {}); await flush();
  // The selected oldest page stays physically alive; a different page finishes destruction.
  f.originals[1].destroy();
  assert.equal(physicalTurnTabs(f.host).length, 4);
  t.mock.timers.tick(5000); await flush();
  try {
    await assert.rejects(pending, { code: "continuity_resource_capacity" });
    assert.equal(f.originals[0].contents.isDestroyed(), false);
    assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0);
    assert.equal(physicalTurnTabs(f.host).length, 4);
    assert.equal(f.host.continuityPageCleanups.get(f.originals[0].contents).attempts, 2);
    assert.equal(f.originals[1].closes(), 0);
  } finally { f.originals[0].destroy(); }
});

for (const mode of ["automatic", "manual"]) test(`${mode} concurrent allocations recheck capacity before synchronous slot reservation`, async () => {
  const f = fixture(mode, 2);
  const first = Promise.resolve(f.start("sixth")), second = Promise.resolve(f.start("seventh"));
  first.catch(() => {}); second.catch(() => {}); await flush();
  assert.equal(f.originals[0].closes(), 1); assert.equal(f.originals[1].closes(), 1);
  assert.equal(physicalTurnTabs(f.host).length, 5);
  f.originals[1].destroy(); await second;
  assert.equal(physicalTurnTabs(f.host).length, 5); assert.equal(f.allocations(), 1);
  f.originals[0].destroy(); await first;
  assert.equal(physicalTurnTabs(f.host).length, 5); assert.equal(f.allocations(), 2);
  assert.equal(f.events.filter(event => event.kind === "allocated").every(event => event.physical === 4), true);
});

for (const mode of ["automatic", "manual"]) test(`${mode} an intervening allocation cannot lend its occupied slot to a waiting request`, async () => {
  const f = fixture(mode, 1);
  const waiting = Promise.resolve(f.start("waiting")); waiting.catch(() => {}); await flush();
  f.originals[0].destroy();
  const competing = Promise.resolve(f.start("competing"));
  await competing; await assert.rejects(waiting, { code: "continuity_resource_capacity" });
  assert.equal(f.allocations(), 1); assert.equal(physicalTurnTabs(f.host).length, 5);
  assert.equal([...f.host.turnTabs.values()].some(tab => tab.traceId === "waiting"), false);
});

for (const mode of ["automatic", "manual"]) test(`${mode} rechecks durable execution authority after the destruction wait`, async () => {
  const f = fixture(mode), { claim, work, attempt } = authorizedClaim(f);
  const waiting = Promise.resolve(f.start("sixth", claim)); waiting.catch(() => {}); await flush();
  work.state = "stopped"; attempt.writerRetired = true;
  f.originals[0].destroy();
  await assert.rejects(waiting, { code: "continuity_unverified" });
  assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0); assert.equal(work.state, "stopped");
});

for (const mode of ["automatic", "manual"]) test(`${mode} identical recovery observers share one waiting acquisition and one page`, async () => {
  const f = fixture(mode), { claim } = authorizedClaim(f);
  const start = requestId => mode === "manual"
    ? f.host.beginManualTurn("same", process.pid, "synthetic prompt", "e".repeat(64), undefined, false, true, true, claim, false, undefined, requestId)
    : f.host.beginTurn("same", false, process.pid, "e".repeat(64), "synthetic connector", false, undefined, claim, requestId);
  const first = start("synthetic-request-0001"), second = start("synthetic-request-0002");
  first.catch(() => {}); second.catch(() => {}); await flush();
  assert.equal(f.originals[0].closes(), 1); assert.equal(f.allocations(), 0);
  f.originals[0].destroy();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.tabId, two.tabId); assert.equal(f.allocations(), 1);
  const transaction = f.host.continuityTransactions.get(`${claim.recovery.installationId}:${claim.recovery.threadKey}`);
  assert.equal(transaction.acquisitionRequestId, "synthetic-request-0001");
  assert.equal(transaction.pending, undefined); assert.equal(physicalTurnTabs(f.host).length, 5);
});

for (const boundary of ["host-destroyed", "launcher-changed", "aborted"]) test(`waiting admission refuses ${boundary} before a new page effect`, async () => {
  const f = fixture(); const controller = new AbortController();
  const pending = f.start("sixth", undefined, controller.signal); pending.catch(() => {});
  await flush();
  if (boundary === "host-destroyed") f.host.destroyed = true;
  if (boundary === "launcher-changed") f.host.continuityLauncherInstance = { ...f.instance, instanceId: "1".repeat(64) };
  if (boundary === "aborted") controller.abort(new Error("synthetic cancellation"));
  f.originals[0].destroy();
  await assert.rejects(pending);
  assert.equal(f.allocations(), 0); assert.equal(f.copies(), 0);
});

test("Manual HTTP start awaits the real async lease and carries its eventual typed error", async () => {
  for (const reject of [false, true]) {
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
    const host = { browserInteractionMode: () => "manual", async beginManualTurn() {
      entered(); await gate;
      if (reject) throw Object.assign(new Error("synthetic capacity failure"), { code: "continuity_resource_capacity" });
      return { tabId: "synthetic-tab", reused: false, state: "awaiting-user", deadlineAt: null, sentConfirmationRequired: true };
    } };
    const server = await new BrowserControlServer({ logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}) }).start();
    try {
      const { endpoint, token } = server.descriptor();
      let settled = false;
      const request = fetch(`${endpoint}/v1/manual/start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "synthetic-http", helperPid: process.pid, prompt: "synthetic prompt", sentConfirmationRequired: true }) }).finally(() => { settled = true; });
      await started; await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "control must not serialize an unresolved Promise as a successful empty lease");
      release();
      const response = await request, body = await response.json();
      assert.equal(response.status, reject ? 409 : 200);
      if (reject) assert.equal(body.code, "continuity_resource_capacity"); else assert.equal(body.tabId, "synthetic-tab");
    } finally { release(); await server.close(); }
  }
});
