const { randomBytes } = require("node:crypto");
const { launcherInstance, sameLauncherInstance } = require("./continuity-process-instance.cjs");
const MAX_CLEANUP_ATTEMPTS = 3;
// Three bounded waits fit the existing 15-second Launcher end-control timeout.
const CLEANUP_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_CLEANUP_RECEIPTS = 256;

function receipt(record) {
  return { cleanupId: record.cleanupId, tabId: record.tabId, physicalPageId: record.physicalPageId,
    launcherInstance: structuredClone(record.launcherInstance),
    ...(record.creation ? { creation: structuredClone(record.creation) } : {}),
    state: record.state, attempts: record.attempts, executionIsolated: record.executionIsolated,
    ...(record.reason ? { reason: record.reason } : {}) };
}
function observeDestroyed(host, record) {
  if (!record.contents.isDestroyed()) return false;
  if (record.state === "destroyed") return true;
  if (record.timer) clearTimeout(record.timer);
  record.timer = undefined;
  record.state = "destroyed";
  host.closingTurnTabs?.delete(record.contents);
  host.logger?.info?.("browser.page_cleanup_destroyed", receipt(record));
  return true;
}
function attemptClose(host, record) {
  if (observeDestroyed(host, record) || record.state === "failed") return;
  if (!sameLauncherInstance(record.launcherInstance, launcherInstance(host))) {
    record.state = "failed"; record.reason = "launcher-instance-mismatch"; return;
  }
  record.attempts++;
  record.state = "closing";
  try { record.contents.close(); } catch { record.reason = "close-request-failed"; }
  if (observeDestroyed(host, record)) return;
  record.timer = setTimeout(() => {
    record.timer = undefined;
    if (observeDestroyed(host, record)) return;
    if (record.attempts >= MAX_CLEANUP_ATTEMPTS) {
      record.state = "failed";
      record.reason ??= "destroyed-receipt-timeout";
      host.logger?.warn?.("browser.page_cleanup_failed", receipt(record));
      host.publishState?.(host.snapshot());
      return;
    }
    attemptClose(host, record);
  }, host.continuityCleanupAttemptTimeoutMs ?? CLEANUP_ATTEMPT_TIMEOUT_MS);
  record.timer.unref?.();
}

/** A webContents reference and its frozen creation identity are never replaced by a UI ordinal. */
function cleanupTurnPage(host, tab, { executionIsolated = false, retryId,
  contents = tab.view?.webContents } = {}) {
  if (!contents) throw require("./continuity-lease.cjs").continuityFailure("continuity_unverified");
  host.continuityPageCleanups ??= new Map();
  let record = host.continuityPageCleanups.get(contents);
  if (!record) {
    record = { cleanupId: randomBytes(16).toString("hex"), tabId: tab.id,
      physicalPageId: tab.physicalPageId ??= randomBytes(24).toString("hex"), contents,
      launcherInstance: launcherInstance(host),
      creation: tab.continuityCreationRecovery ? structuredClone(tab.continuityCreationRecovery)
        : tab.continuityRecovery ? structuredClone(tab.continuityRecovery) : undefined,
      recovery: tab.continuityRecovery ? structuredClone(tab.continuityRecovery) : undefined,
      state: "pending", attempts: 0, retryIds: new Set(), executionIsolated };
    host.continuityPageCleanups.set(contents, record);
    contents.once?.("destroyed", () => observeDestroyed(host, record));
    // Live/failed pages are never evicted from the evidence table.
    for (const [key, item] of host.continuityPageCleanups) {
      if (host.continuityPageCleanups.size <= MAX_CLEANUP_RECEIPTS) break;
      if (item.state === "destroyed") host.continuityPageCleanups.delete(key);
    }
  }
  record.executionIsolated ||= executionIsolated;
  if (observeDestroyed(host, record)) return receipt(record);
  if (retryId && record.state === "failed" && !record.retryIds.has(retryId)) {
    if (record.retryIds.size >= MAX_CLEANUP_RECEIPTS) throw require("./continuity-lease.cjs").continuityFailure("continuity_resource_capacity");
    record.retryIds.add(retryId);
    record.state = "pending"; record.attempts = 0; record.reason = undefined;
  }
  if (record.state === "pending") attemptClose(host, record);
  return receipt(record);
}
/** Admission observes one existing cleanup; it never starts another close budget. */
function waitForTurnPageDestroyed(host, contents) {
  const record = host.continuityPageCleanups?.get(contents);
  if (!record || record.contents !== contents) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false, poll, deadline;
    const finish = destroyed => {
      if (done) return;
      done = true;
      clearTimeout(poll); clearTimeout(deadline);
      contents.removeListener?.("destroyed", check);
      resolve(destroyed);
    };
    const check = () => {
      if (done) return;
      clearTimeout(poll);
      if (host.destroyed || host.continuityPageCleanups.get(contents) !== record
        || !sameLauncherInstance(record.launcherInstance, launcherInstance(host))) return finish(false);
      if (observeDestroyed(host, record)) return finish(true);
      if (record.state === "failed") return finish(false);
      // A lost destroyed notification still needs actual isDestroyed evidence.
      poll = setTimeout(check, 25);
    };
    contents.on?.("destroyed", check);
    // Independent of the background three-attempt cleanup and of wall-clock changes.
    deadline = setTimeout(() => finish(false), CLEANUP_ATTEMPT_TIMEOUT_MS);
    check();
  });
}
function cleanupReceipts(host, recovery) {
  const { sameRecovery } = require("./continuity-recovery.cjs");
  return [...(host.continuityPageCleanups?.values() ?? [])]
    .filter(record => sameRecovery(record.recovery, recovery))
    .map(record => { observeDestroyed(host, record); return receipt(record); });
}
function cleanupState(host, recovery) {
  const receipts = cleanupReceipts(host, recovery);
  return receipts.some(item => item.state === "failed") ? "failed"
    : receipts.some(item => item.state !== "destroyed")
      || require("./continuity-recovery.cjs").physicalTurnTabs(host).some(tab => require("./continuity-recovery.cjs").sameRecovery(tab.continuityRecovery, recovery))
      ? "pending" : "destroyed";
}
module.exports = { MAX_CLEANUP_ATTEMPTS, CLEANUP_ATTEMPT_TIMEOUT_MS, cleanupTurnPage,
  cleanupReceipts, cleanupState, observeDestroyed, waitForTurnPageDestroyed };
