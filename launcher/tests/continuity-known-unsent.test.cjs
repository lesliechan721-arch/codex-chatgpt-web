const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { noteAcquisitionEffect } = require("../electron/continuity-recovery.cjs");
const { bindContinuityTab, continuityLease } = require("../electron/continuity-lease.cjs");

async function fixture(t, manual) {
  const instance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) };
  const recovery = { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64),
    epoch: 0, transactionId: "creation", transactionVersion: 0, logicalWorkId: "work", attempt: 0,
    snapshotVersion: 0, snapshotDigest: "c".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "test-owner" }, launcherInstance: instance };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-unsent-"));
  fs.chmodSync(directory, 0o700);
  const work = { logicalWorkId: "work", purpose: "ordinary", workLineageId: "lineage", state: "send-possible",
    attempts: [{ ...recovery, stage: "send-possible", writerRetired: false }] };
  fs.writeFileSync(path.join(directory, "recovery.json"), JSON.stringify({ version: 4, installation: recovery.installationId,
    threads: { [recovery.threadKey]: { epoch: 0, owner: recovery.ownerProcess, currentWorkId: "work", state: "running",
      legacyUnproven: false, works: { work }, calls: {} } } }), { mode: 0o600 });
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), continuityLauncherInstance: instance, manualCompletionSignals: new Map(), manualTerminalSignals: new Map(),
    userCancelledTurnOwners: new Map(), browserInteractionMode: () => manual ? "manual" : "automatic",
    logger: { info() {}, warn() {}, error() {} }, writeManualPrompt() { throw new Error("A capacity refusal must not copy the prompt"); },
  });
  for (let index = 1; index <= 5; index++) host.turnTabs.set(`busy-${index}`, {
    id: `busy-${index}`, traceId: `busy-trace-${index}`, ordinal: index, status: "running",
    view: { webContents: { isDestroyed: () => false, close() { throw new Error("Active pages must remain"); } } },
  });
  const server = await new BrowserControlServer({ logger: host.logger, getPreferences: () => ({}), getBrowserHost: () => host }).start();
  t.after(async () => { await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const descriptor = server.descriptor();
  const body = requestId => ({ traceId: "capacity-trace", helperPid: process.pid, conversationKey: "d".repeat(64),
    connectorIdentity: "connector", continuity: { owner: "e".repeat(64), recovery }, recoveryStoreDirectory: directory,
    ...(manual ? { prompt: "The selected exact prompt", sentConfirmationRequired: true } : {}),
    ...(requestId ? { requestId } : {}) });
  const post = async (input, route = manual ? "/v1/manual/start" : "/v1/turn/start", authorization = `Bearer ${descriptor.token}`) => {
    const response = await fetch(`${descriptor.endpoint}${route}`, { method: "POST",
      headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  return { host, recovery, instance, server, body, post };
}

for (const manual of [true, false]) {
  test(`actual ${manual ? "manual" : "automatic"} allocation capacity failure has one exact authenticated known-unsent receipt`, async t => {
    const f = await fixture(t, manual);
    const requestId = "request_before_page_0001";
    const rejected = await f.post(f.body(requestId));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "continuity_resource_capacity");
    const receipt = rejected.body.sendUnsentReceipt;
    assert.match(receipt.receiptId, /^[a-f0-9]{32}$/);
    assert.deepEqual({ ...receipt, receiptId: "opaque" }, {
      schemaVersion: 1, receiptId: "opaque", state: "known-unsent", executionProtocol: 1, sendState: "not-started",
      requestId, traceId: "capacity-trace", helperPid: process.pid, recovery: f.recovery, launcherInstance: f.instance,
    });
    const record = f.host.continuityTransactions.get(`${f.recovery.installationId}:${f.recovery.threadKey}`);
    assert.equal(record.pending, undefined);
    assert.equal(record.result, undefined);
    assert.equal(record.acquisitionEffects, undefined);
    assert.equal(f.host.turnTabs.size, 5);
    const repeated = await f.post(f.body(requestId));
    assert.deepEqual(repeated.body.sendUnsentReceipt, receipt, "retrying the same HTTP request replays its first failure receipt");
    const next = await f.post(f.body("request_before_page_0002"));
    assert.equal(next.body.sendUnsentReceipt.requestId, "request_before_page_0002");
    assert.deepEqual(next.body.sendUnsentReceipt.recovery, receipt.recovery, "capacity waiting keeps the same business attempt");
    const query = await f.post({ recovery: f.recovery, recoveryStoreDirectory: f.body().recoveryStoreDirectory }, "/v1/turn/continuity-query");
    assert.equal(query.body.sendUnsentReceipt, undefined, "queries cannot manufacture an HTTP failure fact");
    assert.equal((await f.post(f.body(requestId), undefined, "Bearer invalid")).status, 401);
  });

  test(`the ${manual ? "manual" : "automatic"} busy refusal is known-unsent only before any acquisition effect`, async t => {
    const f = await fixture(t, manual);
    f.host.manualOperation = "ChatGPT sign in";
    const rejected = await f.post(f.body("request_busy_page_0001"));
    assert.equal(rejected.body.sendUnsentReceipt?.state, "known-unsent");
    assert.equal(f.host.turnTabs.size, 5);
  });

  test(`${manual ? "manual" : "automatic"} generic capacity errors and allocation attempts cannot claim known-unsent`, async t => {
    const f = await fixture(t, manual);
    const key = manual ? "beginManualTurnAcquisition" : "beginTurnAcquisition";
    const original = f.host[key];
    f.host[key] = () => { const error = new Error("Capacity without boundary evidence"); error.code = "continuity_resource_capacity"; throw error; };
    const generic = await f.post(f.body("request_unknown_page_0001"));
    assert.equal(generic.body.code, "continuity_resource_capacity");
    assert.equal(generic.body.sendUnsentReceipt, undefined);
    f.host[key] = function (...args) {
      noteAcquisitionEffect(this, manual ? args[8] : args[7]);
      return original.apply(this, args);
    };
    const afterEffect = await f.post(f.body("request_started_page_0002"));
    assert.equal(afterEffect.body.code, "continuity_resource_capacity");
    assert.equal(afterEffect.body.sendUnsentReceipt, undefined);
  });

  test(`${manual ? "manual" : "automatic"} legacy missing request IDs and bad recovery bindings have no unsent proof`, async t => {
    const f = await fixture(t, manual);
    assert.equal((await f.post(f.body())).body.sendUnsentReceipt, undefined);
    const wrong = f.body("request_wrong_page_0001");
    wrong.continuity.recovery = { ...f.recovery, snapshotDigest: "f".repeat(64) };
    assert.equal((await f.post(wrong)).body.sendUnsentReceipt, undefined);
    const badId = f.body("short");
    assert.equal((await f.post(badId)).status, 400);
  });
}

test("a pending acquisition does not lend its known-unsent failure to a concurrent request ID", async t => {
  const f = await fixture(t, false);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstEntered;
  const entered = new Promise(resolve => { firstEntered = resolve; });
  let secondEntered;
  const coalesced = new Promise(resolve => { secondEntered = resolve; });
  const originalBegin = f.host.beginTurn;
  let starts = 0;
  f.host.beginTurn = function (...args) { if (++starts === 2) secondEntered(); return originalBegin.apply(this, args); };
  f.host.beginTurnAcquisition = async function (traceId, reveal, helperPid, conversationKey, connectorIdentity, retained, signal, claim) {
    firstEntered(); await gate;
    return this.createTurnTab(traceId, helperPid, conversationKey, connectorIdentity, signal, claim);
  };
  const first = f.post(f.body("request_pending_page_0001"));
  await entered;
  const second = f.post(f.body("request_pending_page_0002"));
  await coalesced;
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.body.sendUnsentReceipt?.requestId, "request_pending_page_0001");
  assert.equal(b.body.code, "continuity_resource_capacity");
  assert.equal(b.body.sendUnsentReceipt, undefined, "different HTTP requests cannot borrow the first request's failure proof");
});

test("a lost capacity error response remains unknown and query cannot recreate its proof", async t => {
  const f = await fixture(t, true);
  let drop = true;
  f.server.server.prependListener("request", (request, response) => {
    if (request.url === "/v1/manual/start" && drop) { drop = false; response.end = () => { response.socket.destroy(); return response; }; }
  });
  await assert.rejects(f.post(f.body("request_lost_page_0001")));
  const query = await f.post({ recovery: f.recovery, recoveryStoreDirectory: f.body().recoveryStoreDirectory }, "/v1/turn/continuity-query");
  assert.equal(query.status, 200);
  assert.equal(query.body.sendUnsentReceipt, undefined);
});
