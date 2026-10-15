const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { bindExecutionAuthority, assertExecutionAuthority, assertExecutionIsolation } = require("../electron/continuity-execution-authority.cjs");

function identity(overrides = {}) {
  return { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64),
    epoch: 0, transactionId: "creation", transactionVersion: 0, logicalWorkId: "original", attempt: 0,
    snapshotVersion: 0, snapshotDigest: "c".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "test-owner" }, ...overrides };
}
function documentFor(recovery) {
  const attempt = { ...recovery, writerRetired: false };
  const work = { logicalWorkId: recovery.logicalWorkId, purpose: "ordinary", workLineageId: "lineage", state: "active", attempts: [attempt] };
  return { version: 3, installation: recovery.installationId, threads: { [recovery.threadKey]: {
    epoch: recovery.epoch, owner: recovery.ownerProcess, currentWorkId: recovery.logicalWorkId, state: "running",
    legacyUnproven: false, works: { [work.logicalWorkId]: work }, calls: {},
  } } };
}
function journalFixture(t, recovery) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-fencing-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const document = documentFor(recovery);
  const write = () => {
    fs.writeFileSync(path.join(directory, "recovery.next"), JSON.stringify(document), { mode: 0o600 });
    fs.renameSync(path.join(directory, "recovery.next"), path.join(directory, "recovery.json"));
  };
  write();
  return { directory, document, write, record: document.threads[recovery.threadKey] };
}

function preparationFixture(t) {
  const instance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) };
  const original = identity({ launcherInstance: instance });
  const f = journalFixture(t, original);
  const transaction = { transactionId: original.transactionId, version: original.transactionVersion,
    sourceEpoch: original.epoch, targetEpoch: original.epoch, logicalWorkId: original.logicalWorkId, attempt: original.attempt,
    snapshotVersion: original.snapshotVersion, snapshotDigest: original.snapshotDigest, stage: "page-possible",
    writerRetired: false, toolsSettled: true, launcherInstance: instance };
  const target = { ...original, transactionVersion: 1, snapshotVersion: 1, snapshotDigest: "d".repeat(64),
    ownerProcess: { pid: process.pid, startIdentity: "target-owner" } };
  f.record.transaction = structuredClone(transaction);
  f.record.pendingPreparation = { preparationId: "e".repeat(64),
    expected: { owner: { id: "expected-owner", ...original.ownerProcess }, transaction },
    target: { owner: { id: "target-owner", ...target.ownerProcess }, transaction: { ...transaction, version: 1,
      snapshotVersion: 1, snapshotDigest: target.snapshotDigest, stage: "prepared" } } };
  const stop = () => {
    f.record.works.original.state = "stopped";
    f.record.works.original.attempts[0].writerRetired = true;
    f.record.works.original.attempts[0].stage = "stopped";
    f.record.transaction.stage = "stopped";
    f.record.transaction.writerRetired = true;
    f.record.state = "stopped";
    f.write();
  };
  f.write();
  return { ...f, original, target, instance, stop };
}

for (const archived of [false, true]) test(`a stopped preparation proves isolation for both exact tags archived=${archived}`, t => {
  const f = preparationFixture(t);
  const host = {};
  bindExecutionAuthority(host, f.original, f.directory);
  assert.throws(() => assertExecutionIsolation(host, f.target), { code: "continuity_unverified" }, "reservation alone cannot retire its target");
  f.stop();
  if (archived) {
    f.record.retiredPreparation = f.record.pendingPreparation;
    delete f.record.pendingPreparation;
    f.record.epoch++;
    f.record.owner = { pid: process.pid, startIdentity: "new-task-owner" };
    f.record.currentWorkId = "new-task";
    f.record.works["new-task"] = { logicalWorkId: "new-task", state: "active", attempts: [{ epoch: 1, writerRetired: false }] };
    f.record.state = "running";
    f.write();
  }
  assert.doesNotThrow(() => assertExecutionIsolation(host, f.original));
  assert.doesNotThrow(() => assertExecutionIsolation(host, f.target));
  assert.throws(() => assertExecutionAuthority(host, f.target), { code: "continuity_unverified" });
  assert.throws(() => assertExecutionAuthority(host, f.target, { preparation: true }), { code: "continuity_unverified" });
  for (const changed of [{ transactionVersion: 2 }, { snapshotVersion: 2 }, { snapshotDigest: "f".repeat(64) },
    { epoch: 1 }, { attempt: 1 }, { transactionId: "other" }, { logicalWorkId: "other" },
    { ownerProcess: f.original.ownerProcess }, { launcherInstance: { ...f.instance, instanceId: "1".repeat(64) } }]) {
    assert.throws(() => assertExecutionIsolation(host, { ...f.target, ...changed }), { code: "continuity_unverified" });
  }
});

test("a stopped preparation rejects a target whose retained predecessor no longer matches the retired attempt", t => {
  const f = preparationFixture(t);
  const host = {};
  bindExecutionAuthority(host, f.original, f.directory);
  f.stop();
  f.record.pendingPreparation.expected.transaction.snapshotDigest = "f".repeat(64);
  f.write();
  assert.throws(() => assertExecutionIsolation(host, f.target), { code: "continuity_unverified" });
});

test("an applied preparation target can be cleaned after durable stop without acquiring Send authority", async t => {
  const f = preparationFixture(t);
  const { acquireContinuityTransaction, updateContinuityPreparation, retireContinuityWriter,
    markContinuitySendPossible, queryContinuityTransaction } = require("../electron/continuity-recovery.cjs");
  const { bindContinuityTab, continuityLease } = require("../electron/continuity-lease.cjs");
  const host = { turnTabs: new Map(), continuityLauncherInstance: f.instance,
    removeTurnTab(tab) { this.turnTabs.delete(tab.id); } };
  bindExecutionAuthority(host, f.original, f.directory);
  // Allocate before the durable CAS reservation, then apply its exact target tag.
  const pending = f.record.pendingPreparation;
  delete f.record.pendingPreparation; f.write();
  const claim = { owner: "1".repeat(64), recovery: f.original };
  let destroyed = false;
  const tab = { id: "prepared-page", traceId: "prepared-trace", helperPid: process.pid, status: "running",
    view: { webContents: { isDestroyed: () => destroyed, close: () => { destroyed = true; } } } };
  acquireContinuityTransaction(host, claim, tab.traceId, tab.helperPid, "2".repeat(64), "automatic", () => {
    bindContinuityTab(tab, claim); host.turnTabs.set(tab.id, tab);
    return { tabId: tab.id, continuity: continuityLease(tab) };
  });
  f.record.pendingPreparation = pending; f.write();
  updateContinuityPreparation(host, f.original, f.target);
  assert.deepEqual(tab.continuityRecovery, f.target);
  await assert.rejects(retireContinuityWriter(host, f.target), { code: "continuity_unverified" });
  assert.throws(() => markContinuitySendPossible(host, f.target), { code: "continuity_unverified" });
  assert.equal(destroyed, false);
  f.stop();
  const retired = await retireContinuityWriter(host, f.target);
  assert.equal(retired.state, "retired");
  assert.equal(retired.executionIsolated, true);
  assert.equal(retired.writerRetired, true);
  assert.equal(retired.physicalCleanup, "destroyed");
  assert.deepEqual(retired.cleanup[0].creation, f.original, "physical cleanup retains the original creation identity");
  assert.equal(host.turnTabs.size, 0);
  assert.throws(() => markContinuitySendPossible(host, f.target), { code: "continuity_unverified" });
  f.record.retiredPreparation = pending; delete f.record.pendingPreparation; f.write();
  assert.equal((await retireContinuityWriter(host, f.target)).executionIsolated, true);
  assert.equal(queryContinuityTransaction(host, f.target).state, "retired");
  assert.equal(f.record.works.original.state, "stopped");
});

test("private durable authority preserves a verified ordinary append chain and rejects its revocation", t => {
  const original = identity();
  const f = journalFixture(t, original);
  const host = {};
  bindExecutionAuthority(host, original, f.directory);
  assertExecutionAuthority(host, original);
  const source = f.record.works.original;
  source.attempts[0].writerRetired = true;
  source.state = "completed";
  f.record.works.appended = { ...source, logicalWorkId: "appended", predecessorLogicalWorkId: "original", state: "active",
    attempts: [{ ...source.attempts[0], transactionId: undefined, writerRetired: false }] };
  f.record.currentWorkId = "appended";
  f.write();
  assert.doesNotThrow(() => assertExecutionAuthority(host, original), "page authority follows the actual accepted ordinary chain");
  assert.throws(() => assertExecutionIsolation(host, original), { code: "continuity_unverified" }, "retired predecessor does not isolate the live appended work");
  f.record.works.appended.attempts[0].writerRetired = true;
  f.write();
  assert.throws(() => assertExecutionAuthority(host, original), { code: "continuity_unverified" });
  assertExecutionIsolation(host, original);
});

test("authority rejects a different lineage, a compaction chain, pending preparation, and a foreign journal", t => {
  const original = identity();
  const f = journalFixture(t, original);
  const host = {};
  bindExecutionAuthority(host, original, f.directory);
  const source = f.record.works.original;
  for (const changed of [{ workLineageId: "other" }, { purpose: "compaction" }, { predecessorLogicalWorkId: "missing" }]) {
    f.record.works.current = { ...source, logicalWorkId: "current", predecessorLogicalWorkId: "original", ...changed };
    f.record.currentWorkId = "current"; f.write();
    assert.throws(() => assertExecutionAuthority(host, original), { code: "continuity_unverified" });
  }
  f.record.currentWorkId = "original";
  f.record.pendingPreparation = { preparationId: "pending" }; f.write();
  assert.throws(() => assertExecutionAuthority(host, original), { code: "continuity_unverified" });
  assert.doesNotThrow(() => assertExecutionAuthority(host, original, { preparation: true }));
  f.document.installation = "f".repeat(64); f.write();
  assert.throws(() => assertExecutionAuthority(host, original), { code: "continuity_unverified" });
  assert.throws(() => bindExecutionAuthority({}, original, f.directory), { code: "continuity_unverified" });
  assert.throws(() => bindExecutionAuthority({}, original), { code: "continuity_unverified" });
});

test("an empty Launcher table proves isolation only after durable revocation", async t => {
  const instance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) };
  const original = identity({ launcherInstance: instance });
  const f = journalFixture(t, original);
  const host = { turnTabs: new Map(), continuityLauncherInstance: instance };
  bindExecutionAuthority(host, original, f.directory);
  const { queryContinuityTransaction, retireContinuityWriter } = require("../electron/continuity-recovery.cjs");
  const missing = queryContinuityTransaction(host, original);
  assert.equal(missing.hostNoWriter, true);
  assert.equal(missing.writerRetired, false);
  assert.equal((await retireContinuityWriter(host, original)).executionIsolated, false);
  f.record.works.original.attempts[0].writerRetired = true; f.write();
  assert.equal(queryContinuityTransaction(host, original).executionIsolated, true);
  const restored = await retireContinuityWriter(host, original);
  assert.equal(restored.state, "retired");
  assert.equal(restored.writerRetired, true);
  assert.equal(host.continuityTransactions.size, 1);
});

function childLauncher() {
  const root = process.argv[1];
  const { EventEmitter } = require("node:events");
  const { BrowserHost } = require(root + "/browser-host.cjs");
  const { BrowserControlServer } = require(root + "/control-server.cjs");
  const { bindContinuityTab, continuityLease } = require(root + "/continuity-lease.cjs");
  let allocations = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    continuityLauncherInstance: { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) },
    turnTabs: new Map(), closingTurnTabs: new Map(), closedTurnOwners: new Map(), userCancelledTurnOwners: new Map(),
    continuityCleanupAttemptTimeoutMs: 2, selectedTabId: "home", window: { contentView: { removeChildView() {} } },
    logger: { info() {}, warn() {}, error() {} }, browserInteractionMode: () => "automatic",
    syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {}, snapshot: () => ({}), heartbeatTurn() {},
    beginTurnAcquisition(traceId, reveal, helperPid, conversationKey, connectorIdentity, retained, signal, claim) {
      allocations++;
      const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, close() {} });
      const tab = { id: `page-${allocations}`, surfaceId: `surface-${allocations}`, traceId, helperPid,
        conversationKey, ordinal: allocations, status: "running", view: { webContents: contents } };
      bindContinuityTab(tab, claim); this.turnTabs.set(tab.id, tab);
      return { tabId: tab.id, surfaceId: tab.surfaceId, reused: false, continuity: continuityLease(tab) };
    },
  });
  new BrowserControlServer({ logger: host.logger, getPreferences: () => ({}), getBrowserHost: () => host }).start()
    .then(server => process.stdout.write(JSON.stringify({ ...server.descriptor(), instance: host.continuityLauncherInstance }) + "\n"));
}

test("a live old Launcher rejects control and Send after another process commits revocation", async t => {
  const child = spawn(process.execPath, ["-e", `(${childLauncher.toString()})()`, path.resolve(__dirname, "../electron")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "close"); } });
  const [bytes] = await once(child.stdout, "data");
  const descriptor = JSON.parse(bytes.toString());
  const original = identity({ launcherInstance: descriptor.instance });
  const f = journalFixture(t, original);
  const post = async (route, recovery, extra = {}) => {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/${route}`, {
      method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ recovery, recoveryStoreDirectory: f.directory, ...extra }),
    });
    return { status: response.status, body: await response.json() };
  };
  const turn = recovery => ({ traceId: `trace-${recovery.attempt}`, helperPid: process.pid, conversationKey: "d".repeat(64), continuity: { owner: "e".repeat(64), recovery } });
  const started = await post("start", original, turn(original));
  assert.equal(started.status, 200);
  assert.equal(started.body.executionProtocol, 1);
  assert.equal((await post("heartbeat", original, { traceId: "trace-0", helperPid: process.pid })).status, 200);
  f.record.works.original.attempts[0].writerRetired = true; f.write();
  process.kill(child.pid, 0);
  assert.equal((await post("heartbeat", original, { traceId: "trace-0", helperPid: process.pid })).status, 503);
  assert.equal((await post("continuity-send-possible", original)).status, 503);
  const retired = await post("continuity-retire", original);
  assert.equal(retired.status, 200);
  assert.equal(retired.body.executionIsolated, true);
  assert.equal(retired.body.writerRetired, true);
  assert.equal(retired.body.physicalCleanup, "pending");
  let failed;
  const deadline = Date.now() + 1500;
  do {
    await new Promise(resolve => setTimeout(resolve, 5));
    failed = await post("continuity-query", original);
  } while (failed.body.physicalCleanup !== "failed" && Date.now() < deadline);
  assert.equal(failed.body.physicalCleanup, "failed");
  assert.equal(failed.body.cleanup[0].attempts, 3);
  const next = { ...original, epoch: 1, attempt: 1, snapshotVersion: 1, transactionVersion: 1 };
  f.record.epoch = 1;
  f.record.works.original.attempts.push({ ...next, writerRetired: false }); f.write();
  const successor = await post("start", next, turn(next));
  assert.equal(successor.status, 200, "failed physical cleanup does not block an available second slot");
  assert.equal((await post("heartbeat", original, { traceId: "trace-0", helperPid: process.pid })).status, 503);
  assert.equal((await post("continuity-send-possible", next)).body.sendAuthorized, true);
  assert.equal((await post("continuity-query", original)).body.cleanup[0].cleanupId, failed.body.cleanup[0].cleanupId);
  process.kill(child.pid, 0);
});
