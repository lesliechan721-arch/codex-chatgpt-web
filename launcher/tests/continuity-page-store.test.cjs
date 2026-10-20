const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { bindContinuityTab } = require("../electron/continuity-lease.cjs");
const { removedContinuityTab, physicalTurnTabs } = require("../electron/continuity-recovery.cjs");
const { removeDestroyedPage } = require("../electron/continuity-page-store.cjs");
const { cleanupTurnPage, cleanupReceipts } = require("../electron/continuity-page-cleanup.cjs");
const { assertExecutionAuthority } = require("../electron/continuity-execution-authority.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-destroyed-page-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const creation = { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64), epoch: 1,
    transactionId: "physical-creation", transactionVersion: 0, logicalWorkId: "original", attempt: 0,
    snapshotVersion: 0, snapshotDigest: "c".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "physical-owner" } };
  let destroyed = true;
  const tab = { id: "physical-tab", continuityLeaseId: "1".repeat(32),
    view: { webContents: { isDestroyed: () => destroyed } } };
  bindContinuityTab(tab, { owner: "d".repeat(64), recovery: creation });
  const attempt = { ...creation, pageReceiptId: tab.continuityLeaseId, writerRetired: true };
  const record = { epoch: creation.epoch, owner: creation.ownerProcess, currentWorkId: "compact", state: "ready",
    transaction: { transactionId: "compact-transaction", version: 0 },
    works: { original: { logicalWorkId: "original", purpose: "ordinary", state: "completed", attempts: [attempt] },
      compact: { logicalWorkId: "compact", purpose: "compaction", state: "completed", attempts: [] } }, calls: {} };
  const journalFile = path.join(directory, "recovery.json"), registryFile = path.join(directory, "threads.json");
  const document = { version: 4, installation: creation.installationId, threads: { [creation.threadKey]: record } };
  const registry = { version: 1, installation: creation.installationId, entries: {
    [creation.threadKey]: { scope: "e".repeat(64), owner: "d".repeat(64), state: "entered", epoch: record.epoch, transactionId: record.transaction.transactionId },
  } };
  const write = () => {
    fs.writeFileSync(journalFile, JSON.stringify(document), { mode: 0o600 });
    fs.writeFileSync(registryFile, JSON.stringify(registry), { mode: 0o600 });
  };
  write();
  const host = { continuityAuthorityDirectories: new Map([[creation.installationId, directory]]),
    continuityTransactions: new Map(), continuityTransactionReceipts: new Map() };
  return { host, tab, creation, attempt, record, document, registry, journalFile, registryFile, write,
    live() { destroyed = false; }, destroy() { destroyed = true; } };
}

test("destroyed callback clears page storage after WebContentsView loses its webContents getter", t => {
  const f = fixture(t), key = `${f.creation.installationId}:${f.creation.threadKey}`;
  const compact = { ...f.creation, transactionId: "compact-transaction", logicalWorkId: "compact" };
  f.host.continuityTransactions.set(key, { identity: compact });
  f.host.continuityTransactionReceipts.set(`${key}:compact`, { identity: compact });
  const contents = Object.assign(new EventEmitter(), f.tab.view.webContents);
  let attached = true;
  Object.defineProperty(f.tab.view, "webContents", { get: () => attached ? contents : undefined });
  f.live();
  BrowserHost.prototype.trackClosingTurnTab.call(f.host, f.tab);
  attached = false;
  f.destroy();
  assert.doesNotThrow(() => contents.emit("destroyed"));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)).entries, {});
  assert.equal(f.host.closingTurnTabs.size, 0);
  assert.equal(f.host.continuityTransactions.size, 0);
  assert.equal(f.host.continuityTransactionReceipts.size, 0);
});

for (const interactionMode of ["automatic", "manual"]) {
  for (const status of ["running", "ready", "error"]) {
    test(`external ${interactionMode} ${status} destruction clears the exact physical page and its durable receipts`, t => {
      const f = fixture(t), key = `${f.creation.installationId}:${f.creation.threadKey}`;
      const compact = { ...f.creation, transactionId: "compact-transaction", logicalWorkId: "compact" };
      f.host.continuityTransactions.set(key, { identity: compact });
      f.host.continuityTransactionReceipts.set(`${key}:compact`, { identity: compact });
      let closes = 0, attached = true;
      const contents = Object.assign(new EventEmitter(), f.tab.view.webContents, {
        setWindowOpenHandler() {}, close() { closes++; },
      });
      Object.defineProperty(f.tab.view, "webContents", { get: () => attached ? contents : undefined });
      Object.assign(f.tab, { interactionMode, status, traceId: "destroyed-trace", helperPid: process.pid });
      const live = { id: "other-page", status: "running", view: { webContents: { isDestroyed: () => false } } };
      const terminals = [];
      Object.setPrototypeOf(f.host, BrowserHost.prototype);
      Object.assign(f.host, {
        turnTabs: new Map([[f.tab.id, f.tab], [live.id, live]]), closedTurnOwners: new Map(),
        selectedTabId: f.tab.id, window: { contentView: { removeChildView() {} } },
        logger: { info() {}, warn() {} }, syncViewVisibility() {}, writeDescriptor() {},
        signalManualTerminal(_tab, state) { terminals.push(state); },
      });
      f.live();
      if (interactionMode === "manual") f.host.bindManualTurnContents(f.tab);
      else f.host.bindTurnContents(f.tab);
      attached = false;
      f.destroy();
      assert.doesNotThrow(() => contents.emit("destroyed"));
      assert.deepEqual(physicalTurnTabs(f.host), [live]);
      const [receipt] = cleanupReceipts(f.host, f.creation);
      assert.equal(receipt.state, "destroyed");
      assert.equal(receipt.attempts, 0, "an observed destroyed page needs no close attempt");
      assert.equal(receipt.physicalPageId, f.tab.physicalPageId);
      assert.equal(f.host.continuityPageCleanups.get(contents).contents, contents);
      assert.equal(closes, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {});
      assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)).entries, {});
      assert.equal(f.host.continuityTransactions.size, 0);
      assert.equal(f.host.continuityTransactionReceipts.size, 0);
      assert.deepEqual(terminals, interactionMode === "manual" ? ["failed"] : []);
      contents.emit("destroyed");
      assert.equal(f.host.turnTabs.get(live.id), live);
      assert.equal(cleanupReceipts(f.host, f.creation)[0].cleanupId, receipt.cleanupId);
    });
  }
}

test("unavailable webContents without a captured destruction observation cannot clear page storage", t => {
  const f = fixture(t), key = `${f.creation.installationId}:${f.creation.threadKey}`;
  f.host.continuityTransactions.set(key, { identity: f.creation });
  Object.defineProperty(f.tab.view, "webContents", { get: () => undefined });
  assert.doesNotThrow(() => removedContinuityTab(f.host, f.tab));
  assert.throws(() => cleanupTurnPage(f.host, f.tab), { code: "continuity_unverified" });
  assert.equal(f.host.continuityPageCleanups, undefined, "missing contents cannot manufacture a destroyed receipt");
  assert.equal(removeDestroyedPage(f.host, f.creation, f.tab), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)), f.document);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)), f.registry);
  assert.equal(f.host.continuityTransactions.has(key), true);
});

test("destroyed physical creation clears advanced same-page receipts while old writer authority stays revoked", t => {
  const f = fixture(t), key = `${f.creation.installationId}:${f.creation.threadKey}`;
  const compact = { ...f.creation, transactionId: "compact-transaction", logicalWorkId: "compact" };
  f.host.continuityTransactions.set(key, { identity: compact });
  f.host.continuityTransactionReceipts.set(`${key}:original`, { identity: f.creation });
  f.host.continuityTransactionReceipts.set(`${key}:compact`, { identity: compact });
  assert.throws(() => assertExecutionAuthority(f.host, f.creation), { code: "continuity_unverified" });
  assert.equal(removeDestroyedPage(f.host, f.creation), false, "a historical writer tag is insufficient");
  for (const tab of [{ ...f.tab, continuityLeaseId: "2".repeat(32) },
    { ...f.tab, continuityCreationRecovery: { ...f.creation, transactionId: "another-page" } },
    { ...f.tab, continuityCreationRecovery: { ...f.creation, epoch: 2 } },
    { ...f.tab, view: { webContents: { isDestroyed: () => false } } }]) {
    assert.equal(removeDestroyedPage(f.host, f.creation, tab), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads[f.creation.threadKey], f.record);
  }
  removedContinuityTab(f.host, f.tab);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)).entries, {});
  assert.equal(f.host.continuityTransactions.size, 0);
  assert.equal(f.host.continuityTransactionReceipts.size, 0);
  assert.throws(() => assertExecutionAuthority(f.host, f.creation), { code: "continuity_unverified" });
});

test("same physical creation survives an adjacent preparation owner and snapshot change", t => {
  const f = fixture(t);
  const target = { ...f.creation, transactionVersion: 1, snapshotVersion: 1, snapshotDigest: "f".repeat(64),
    ownerProcess: { pid: process.pid, startIdentity: "prepared-owner" } };
  Object.assign(f.attempt, target);
  delete f.attempt.pageReceiptId; // The adjacent preparation has not received its acknowledgement yet.
  f.record.owner = target.ownerProcess;
  f.record.transaction = { transactionId: target.transactionId, version: target.transactionVersion };
  f.write();
  f.tab.continuityRecovery = target;
  assert.deepEqual(f.tab.continuityCreationRecovery, f.creation, "the physical creation tag remains frozen");
  assert.equal(removeDestroyedPage(f.host, f.creation), false);
  assert.equal(removeDestroyedPage(f.host, target, f.tab), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {});
});

for (const successor of [false, true]) test(`destroyed-page registry cleanup retries after a partial write without deleting a successor=${successor}`, t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t), key = `${f.creation.installationId}:${f.creation.threadKey}`;
  if (process.platform === "win32") {
    // A directory is an invalid task file on every platform.
    fs.unlinkSync(f.registryFile); fs.mkdirSync(f.registryFile);
  } else fs.chmodSync(f.registryFile, 0o644);
  removedContinuityTab(f.host, f.tab);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {}, "journal deletion precedes the registry failure");
  Object.defineProperty(f.tab.view, "webContents", { get: () => undefined });
  if (process.platform === "win32") fs.rmdirSync(f.registryFile);
  else fs.chmodSync(f.registryFile, 0o600);
  if (successor) {
    const identity = { ...f.creation, epoch: 2, transactionId: "successor-page" };
    f.record.epoch = 2; f.record.transaction = { transactionId: identity.transactionId, version: 0 };
    f.registry.entries[f.creation.threadKey].epoch = 2;
    f.registry.entries[f.creation.threadKey].transactionId = identity.transactionId;
    f.host.continuityTransactions.set(key, { identity });
    f.host.continuityTransactionReceipts.set(`${key}:successor`, { identity });
    f.write();
  } else fs.writeFileSync(f.registryFile, JSON.stringify(f.registry), { mode: 0o600 });
  t.mock.timers.tick(50);
  if (successor) {
    assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)), f.document);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)), f.registry);
    assert.equal(f.host.continuityTransactions.get(key).identity.epoch, 2);
    assert.equal(f.host.continuityTransactionReceipts.size, 1);
  } else {
    assert.deepEqual(JSON.parse(fs.readFileSync(f.journalFile)).threads, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(f.registryFile)).entries, {});
  }
});
