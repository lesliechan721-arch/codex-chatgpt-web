const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");
const { bindExecutionAuthority, assertExecutionAuthority } = require("../electron/continuity-execution-authority.cjs");
const { bindContinuityTab, continuityLease, inspectContinuityConversation } = require("../electron/continuity-lease.cjs");
const { terminateContinuityPreparation, queryContinuityTransaction } = require("../electron/continuity-recovery.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-preparation-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recovery = { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64), epoch: 0,
    transactionId: "preparation", transactionVersion: 0, logicalWorkId: "work", attempt: 0,
    snapshotVersion: 0, snapshotDigest: "c".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "test-owner" },
    launcherInstance: { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "d".repeat(64) } };
  const tab = { id: "same-page", traceId: "preparation-trace", helperPid: process.pid, status: "running",
    interactionMode: "automatic", conversationKey: "e".repeat(64), connectorBound: true, bootstrapReady: true,
    continuityLastSuccessAt: Date.now() - 1000, view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } } };
  bindContinuityTab(tab, { owner: "f".repeat(64), recovery });
  const lease = continuityLease(tab);
  const termination = { recovery, lease, requestId: "preparation-request-001", traceId: tab.traceId,
    helperPid: process.pid, receiptId: "1".repeat(32), status: "pending" };
  const attempt = { ...recovery, stage: "page-acquired", writerRetired: true, preparationTermination: termination };
  const work = { logicalWorkId: "work", purpose: "ordinary", workLineageId: "work", state: "prepared", attempts: [attempt] };
  const record = { epoch: 0, owner: recovery.ownerProcess, state: "running", currentWorkId: "work", legacyUnproven: false,
    works: { work }, calls: {} };
  const write = () => fs.writeFileSync(path.join(directory, "recovery.json"), JSON.stringify({ version: 4,
    installation: recovery.installationId, threads: { [recovery.threadKey]: record } }), { mode: 0o600 });
  write();
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]), userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
    continuityLauncherInstance: recovery.launcherInstance, continuityTransactions: new Map(),
    logger: { info() {}, warn() {}, error() {} }, snapshot: () => ({}), publishState() {},
    writeDescriptor() {}, syncPowerSaveBlocker() {}, removeTurnTab() { throw new Error("The healthy retained page must remain"); },
  });
  host.continuityTransactions.set(`${recovery.installationId}:${recovery.threadKey}`, { identity: recovery, tabId: tab.id,
    traceId: tab.traceId, helperPid: process.pid, owner: lease.owner, conversationKey: tab.conversationKey,
    mode: "automatic", state: "prepared", result: { continuity: lease } });
  bindExecutionAuthority(host, recovery, directory);
  return { directory, host, tab, lease, recovery, termination, attempt, record, write };
}

for (const status of ["failed", "aborted"]) test(`a fenced ${status} preparation retains its healthy lease and last success time`, async t => {
  const f = fixture(t), successAt = f.tab.continuityLastSuccessAt;
  const end = await f.host.endTurn(f.tab.traceId, process.pid, status, false, "Original local error");
  assert.equal(end.preparationTermination.receiptId, f.termination.receiptId);
  assert.equal(f.tab.status, "ready"); assert.equal(f.tab.failedAt, undefined);
  assert.equal(f.tab.connectorBound, true); assert.equal(f.tab.continuityLastSuccessAt, successAt);
  assert.deepEqual(inspectContinuityConversation(f.host, f.tab.conversationKey, f.lease), { continuity: f.lease, state: "ready" });
  assert.equal(queryContinuityTransaction(f.host, f.recovery).state, "completed");
  assert.throws(() => assertExecutionAuthority(f.host, f.recovery), { code: "continuity_unverified" });
});

test("lost termination replies can be queried after control reconnect and receipt table loss", async t => {
  const f = fixture(t);
  terminateContinuityPreparation(f.host, f.recovery);
  f.host.continuityTransactions.clear();
  let server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  t.after(async () => server.close());
  const post = async () => {
    const descriptor = server.descriptor();
    const response = await fetch(`${descriptor.endpoint}/v1/turn/continuity-terminate-preparation`, { method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ recovery: f.recovery, recoveryStoreDirectory: f.directory }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await post();
  await server.close();
  server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  assert.deepEqual(await post(), first);
  assert.equal(first.receiptId, f.termination.receiptId);
  assert.deepEqual(first.continuity, f.lease);
});

test("the actual end endpoint accepts only the fenced preparation terminal after writer retirement", async t => {
  const f = fixture(t);
  const server = await new BrowserControlServer({ logger: f.host.logger, getPreferences: () => ({}), getBrowserHost: () => f.host }).start();
  t.after(async () => server.close());
  const descriptor = server.descriptor();
  const response = await fetch(`${descriptor.endpoint}/v1/turn/end`, { method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ traceId: f.tab.traceId, helperPid: process.pid, status: "aborted", recovery: f.recovery, recoveryStoreDirectory: f.directory }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).preparationTermination.receiptId, f.termination.receiptId);
  assert.equal(f.tab.status, "ready");
});

for (const change of ["stop", "successor", "closed", "error"]) test(`a ${change} page cannot claim a healthy preparation receipt`, t => {
  const f = fixture(t);
  if (change === "stop") { f.record.works.work.state = "stopped"; f.record.state = "stopped"; f.write(); }
  if (change === "successor") { f.record.owner = { pid: process.pid, startIdentity: "successor-owner" }; f.write(); }
  if (change === "closed") f.tab.view.webContents.isDestroyed = () => true;
  if (change === "error") f.tab.status = "error";
  assert.throws(() => terminateContinuityPreparation(f.host, f.recovery));
  if (change === "error") assert.equal(queryContinuityTransaction(f.host, f.recovery).continuity, undefined);
});

test("a healthy possibly sent page preserves its unknown Send instead of failing its lease", async t => {
  const f = fixture(t);
  delete f.attempt.preparationTermination; f.attempt.writerRetired = false; f.attempt.stage = "send-possible";
  f.attempt.sendEvidence = { status: "possible" }; f.record.works.work.state = "send-possible"; f.write();
  const transaction = f.host.continuityTransactions.get(`${f.recovery.installationId}:${f.recovery.threadKey}`);
  transaction.state = "send-possible";
  const result = await f.host.endTurn(f.tab.traceId, process.pid, "failed", false, "Original transport error");
  assert.equal(result.sendState, "unknown"); assert.equal(f.tab.status, "running");
  assert.equal(f.tab.failedAt, undefined); assert.equal(queryContinuityTransaction(f.host, f.recovery).state, "send-possible");
  assert.throws(() => terminateContinuityPreparation(f.host, f.recovery));
});
