const { validLauncherInstance, sameLauncherInstance, launcherProcessInstanceStatus, launcherInstance,
  knownProcessStart } = require("./continuity-process-instance.cjs");
const RECOVERY_FEATURE = "session-continuity-recovery-v3";
const MAX_RECOVERY_THREADS = 10_000;
const MAX_RECEIPTS = 256;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code = "continuity_source_unproven") => require("./continuity-lease.cjs").continuityFailure(code);

function validRecovery(value) {
  return object(value) && value.schemaVersion === 2 && object(value.ownerProcess)
    && Object.keys(value).filter(key => key !== "launcherInstance").sort().join(",") === "attempt,epoch,installationId,logicalWorkId,ownerProcess,schemaVersion,snapshotDigest,snapshotVersion,threadKey,transactionId,transactionVersion"
    && (value.launcherInstance === undefined || validLauncherInstance(value.launcherInstance))
    && [value.installationId, value.threadKey, value.snapshotDigest].every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
    && [value.transactionId, value.logicalWorkId].every(item => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(item))
    && [value.epoch, value.transactionVersion, value.attempt, value.snapshotVersion].every(item => Number.isSafeInteger(item) && item >= 0)
    && Object.keys(value.ownerProcess).sort().join(",") === "pid,startIdentity"
    && Number.isSafeInteger(value.ownerProcess.pid) && value.ownerProcess.pid > 0
    && typeof value.ownerProcess.startIdentity === "string" && value.ownerProcess.startIdentity.length > 0
    && value.ownerProcess.startIdentity.length <= 256;
}
function sameRecovery(a, b) {
  return validRecovery(a) && validRecovery(b)
    && ["schemaVersion", "installationId", "threadKey", "epoch", "transactionId", "transactionVersion", "logicalWorkId", "attempt", "snapshotVersion", "snapshotDigest"]
      .every(key => a[key] === b[key])
    && a.ownerProcess.pid === b.ownerProcess.pid && a.ownerProcess.startIdentity === b.ownerProcess.startIdentity
    && ((!a.launcherInstance && !b.launcherInstance) || sameLauncherInstance(a.launcherInstance, b.launcherInstance));
}
function validateRecovery(value) { if (!validRecovery(value)) throw failure(); }
function threadKey(recovery) { return `${recovery.installationId}:${recovery.threadKey}`; }
function tables(host) {
  host.continuityTransactions ??= new Map();
  host.continuityTransactionReceipts ??= new Map();
  return host.continuityTransactions;
}
function remember(host, record) {
  host.continuityTransactionReceipts.set(`${threadKey(record.identity)}:${record.identity.transactionId}`, record);
  while (host.continuityTransactionReceipts.size > MAX_RECEIPTS) host.continuityTransactionReceipts.delete(host.continuityTransactionReceipts.keys().next().value);
}
function exactRecord(host, recovery) {
  validateRecovery(recovery);
  const current = tables(host).get(threadKey(recovery));
  if (current && sameRecovery(current.identity, recovery)) return current;
  // Old observations can query their own receipt, but cannot mutate the current owner.
  const previous = host.continuityTransactionReceipts.get(`${threadKey(recovery)}:${recovery.transactionId}`);
  if (previous && sameRecovery(previous.identity, recovery)) return previous;
  if (current) throw failure();
  return undefined;
}
/** UI removal is not physical destruction. Closing documents retain their frozen identity. */
function physicalTurnTabs(host) {
  const active = [...host.turnTabs.values()];
  const closing = [];
  for (const [contents, tab] of host.closingTurnTabs ?? []) {
    if (contents.isDestroyed()) host.closingTurnTabs.delete(contents);
    else if (!active.some(item => item.view?.webContents === contents)) closing.push(tab);
  }
  return [...active, ...closing];
}
function hasPhysicalWriter(host, recovery, thread = false) {
  return physicalTurnTabs(host).some(tab => tab.continuityRecovery
    && (thread ? threadKey(tab.continuityRecovery) === threadKey(recovery) : sameRecovery(tab.continuityRecovery, recovery))
    && !tab.view.webContents.isDestroyed());
}
function acquisitionPending(record) { return Boolean(record.pending && !record.result); }
function receipt(host, record, recovery = record?.identity) {
  const currentInstance = launcherInstance(host);
  if (!record) return missingReceipt(host, recovery);
  const tab = host.turnTabs.get(record.tabId);
  const live = tab && sameRecovery(tab.continuityRecovery, record.identity)
    && !tab.continuityInvalidated && !tab.view.webContents.isDestroyed()
    && !require("./continuity-lease.cjs").continuityExpired(tab);
  const state = !live && ["prepared", "send-possible"].includes(record.state) ? "missing" : record.state;
  return {
    recovery: structuredClone(record.identity), state,
    writerRetired: record.writerRetired === true && !hasPhysicalWriter(host, record.identity) && !acquisitionPending(record), toolsSettled: false,
    launcherInstance: currentInstance, hostNoWriter: noThreadWriter(host, recovery),
    ...(record.preparationExpected ? { preparationExpected: structuredClone(record.preparationExpected) } : {}),
    ...(live ? { continuity: require("./continuity-lease.cjs").continuityLease(tab), tabId: tab.id,
      ...(tab.surfaceId ? { surfaceId: tab.surfaceId } : {}) } : {}),
  };
}
function noThreadWriter(host, recovery) {
  const key = threadKey(recovery);
  // An invalidated or expired document can still be alive. Missing receipt proof is about
  // the actual physical writer, not its ability to pass a healthy-lease inspection.
  if (hasPhysicalWriter(host, recovery, true)) return false;
  const record = tables(host).get(key);
  return !record || !acquisitionPending(record)
    && (record.writerRetired === true || ["missing", "completed", "retired"].includes(record.state));
}
function missingReceipt(host, recovery) {
  const current = launcherInstance(host);
  const hostNoWriter = noThreadWriter(host, recovery);
  // An authenticated missing table entry is evidence only for the exact host instance.
  // A different old host needs verifiable OS process exit, independent of backend exit.
  const old = recovery.launcherInstance;
  const currentVerified = knownProcessStart(current.startIdentity);
  const oldRetired = old && knownProcessStart(old.startIdentity)
    && (sameLauncherInstance(old, current) || launcherProcessInstanceStatus(old) === "exited");
  return { recovery: structuredClone(recovery), state: hostNoWriter && currentVerified ? "missing" : "unknown",
    writerRetired: Boolean(hostNoWriter && currentVerified && oldRetired), toolsSettled: false,
    launcherInstance: current, hostNoWriter };
}
function queryContinuityTransaction(host, recovery) { return receipt(host, exactRecord(host, recovery), recovery); }

/** Reserve synchronously, before an async Electron allocation. Caller disconnect never cancels it. */
function reserve(host, claim, traceId, helperPid, conversationKey, mode) {
  if (host.destroyed) throw failure("continuity_unverified");
  const identity = claim.recovery;
  validateRecovery(identity);
  const currentInstance = launcherInstance(host);
  if (!identity.launcherInstance || !sameLauncherInstance(identity.launcherInstance, currentInstance)
    || !knownProcessStart(currentInstance.startIdentity)) throw failure("continuity_configuration_conflict");
  const records = tables(host);
  const key = threadKey(identity);
  let record = records.get(key);
  if (record && sameRecovery(record.identity, identity)) {
    if (record.retirementRequested || physicalTurnTabs(host).some(tab => tab.closing && sameRecovery(tab.continuityRecovery, identity))) {
      throw failure("continuity_execution_unsettled");
    }
    if (record.preparationUpdated && record.state === "prepared" && record.conversationKey === conversationKey && record.mode === mode) {
      const tab = host.turnTabs.get(record.tabId);
      if (!tab || tab.view.webContents.isDestroyed() || tab.continuityInvalidated) throw failure("continuity_session_lost");
      record.owner = claim.owner;
      record.traceId = traceId;
      record.helperPid = helperPid;
      tab.traceId = traceId;
      tab.helperPid = helperPid;
      require("./continuity-lease.cjs").bindContinuityTab(tab, claim);
      record.result.continuity = require("./continuity-lease.cjs").continuityLease(tab);
      record.preparationUpdated = false;
    }
    if (record.conversationKey !== conversationKey || record.mode !== mode || record.owner !== claim.owner) throw failure();
    if (record.state === "retired" || record.state === "completed") throw failure("continuity_execution_unsettled");
    if (record.traceId !== traceId || record.helperPid !== helperPid) throw failure("continuity_execution_unsettled");
    return record;
  }
  if (record) {
    const previous = record.identity;
    const sameTransaction = previous.transactionId === identity.transactionId;
    const nextAttempt = sameTransaction && record.state === "retired" && record.writerRetired === true
      && identity.logicalWorkId === previous.logicalWorkId && identity.epoch >= previous.epoch
      && identity.attempt === previous.attempt + 1 && identity.snapshotVersion > previous.snapshotVersion
      && identity.transactionVersion > previous.transactionVersion;
    const newWork = !sameTransaction && ((record.state === "retired" && record.writerRetired === true && identity.epoch > previous.epoch)
      || (record.state === "completed" && identity.epoch === previous.epoch && claim.expected
        && sameRecovery(claim.expected.recovery, previous)));
    const healthyReuse = newWork && record.state === "completed" && identity.epoch === previous.epoch
      && !physicalTurnTabs(host).some(tab => tab.closing && tab.continuityRecovery && threadKey(tab.continuityRecovery) === key);
    if ((!nextAttempt && !newWork) || acquisitionPending(record)
      || (!healthyReuse && hasPhysicalWriter(host, identity, true))) throw failure("continuity_execution_unsettled");
    remember(host, record);
  } else {
    if (records.size >= MAX_RECOVERY_THREADS) throw failure("continuity_resource_capacity");
    // A new trace/transaction must not bypass a surviving page whose table entry was lost.
    if (hasPhysicalWriter(host, identity, true)) throw failure("continuity_execution_unsettled");
  }
  record = { identity: structuredClone(identity), owner: claim.owner, traceId, helperPid,
    conversationKey, mode, state: "creating", writerRetired: false };
  records.set(key, record);
  return record;
}
function finishAcquisition(host, record, result) {
  if (tables(host).get(threadKey(record.identity)) !== record || record.retirementRequested || record.state === "retired") {
    // A cancelled acquisition may create its exact page only after the retirement request.
    // Close that late page too; its destruction must still be confirmed before recovery.
    for (const tab of [...host.turnTabs.values()]) {
      if (sameRecovery(tab.continuityRecovery, record.identity)) host.removeTurnTab(tab, true);
    }
    record.pending = undefined;
    record.writerRetired = !hasPhysicalWriter(host, record.identity);
    throw failure();
  }
  const tab = [...host.turnTabs.values()].find(item => item.traceId === record.traceId);
  if (!tab || !sameRecovery(tab.continuityRecovery, record.identity)) throw failure("continuity_unverified");
  record.tabId = tab.id;
  // A visible manual prompt can already have been sent. Do not claim it is still editable.
  record.state = record.mode === "manual" ? "send-possible" : "prepared";
  record.result = { ...result, continuity: require("./continuity-lease.cjs").continuityLease(tab) };
  record.pending = undefined;
  return structuredClone(record.result);
}
function failAcquisition(host, record) {
  record.pending = undefined;
  if (record.state === "creating") record.state = "missing";
  record.writerRetired = !hasPhysicalWriter(host, record.identity);
}
function acquireContinuityTransaction(host, claim, traceId, helperPid, conversationKey, mode, create) {
  const record = reserve(host, claim, traceId, helperPid, conversationKey, mode);
  if (record.pending) return record.pending;
  if (record.result) {
    const observed = receipt(host, record);
    if (!observed.continuity) throw failure("continuity_session_lost");
    return structuredClone(record.result);
  }
  if (record.state === "missing") { record.state = "creating"; record.writerRetired = false; }
  try {
    const result = create();
    if (result && typeof result.then === "function") {
      record.pending = result.then(value => {
        try { return finishAcquisition(host, record, value); }
        catch (error) { failAcquisition(host, record); throw error; }
      }, error => { failAcquisition(host, record); throw error; });
      return record.pending;
    }
    return finishAcquisition(host, record, result);
  } catch (error) { failAcquisition(host, record); throw error; }
}
function currentRecord(host, recovery) {
  const record = exactRecord(host, recovery);
  if (!record || tables(host).get(threadKey(recovery)) !== record) throw failure();
  return record;
}
function assertContinuityActivity(host, traceId, helperPid, recovery) {
  const tab = [...(host.turnTabs?.values() ?? [])].find(item => item.traceId === traceId);
  if (!recovery && !tab?.continuityRecovery) return;
  validateRecovery(recovery);
  if (tab) {
    if (tab.helperPid !== helperPid || !sameRecovery(tab.continuityRecovery, recovery)) throw failure();
    return;
  }
  const record = currentRecord(host, recovery);
  if (record.traceId !== traceId || record.helperPid !== helperPid) throw failure();
}
function updateContinuityPreparation(host, expected, recovery) {
  validateRecovery(expected);
  validateRecovery(recovery);
  if (!sameLauncherInstance(expected.launcherInstance, launcherInstance(host))
    || !sameLauncherInstance(recovery.launcherInstance, launcherInstance(host))) throw failure("continuity_configuration_conflict");
  if (["installationId", "threadKey", "epoch", "transactionId", "logicalWorkId", "attempt"].some(key => expected[key] !== recovery[key])
    || recovery.transactionVersion !== expected.transactionVersion + 1 || recovery.snapshotVersion !== expected.snapshotVersion + 1) throw failure();
  const current = tables(host).get(threadKey(expected));
  // Reconcile a lost CAS reply without changing or reacquiring the target page.
  if (current && sameRecovery(current.identity, recovery)) {
    if (!sameRecovery(current.preparationExpected, expected)) throw failure();
    return receipt(host, current);
  }
  const record = currentRecord(host, expected);
  if (record.state !== "prepared" || record.pending && !record.result) throw failure("continuity_execution_unsettled");
  const tab = host.turnTabs.get(record.tabId);
  if (!tab || tab.view.webContents.isDestroyed() || tab.continuityInvalidated) throw failure("continuity_session_lost");
  record.identity = structuredClone(recovery);
  // Keep the predecessor after applying CAS. An interrupted backend can repeat the
  // same durable migration, while a different predecessor cannot borrow its receipt.
  record.preparationExpected = structuredClone(expected);
  record.preparationUpdated = true;
  tab.continuityRecovery = structuredClone(recovery);
  record.result.continuity = require("./continuity-lease.cjs").continuityLease(tab);
  // Rebinding does not allocate a page or renew the 24-hour lease.
  return receipt(host, record);
}
function markContinuitySendPossible(host, recovery) {
  const record = currentRecord(host, recovery);
  if (!["prepared", "send-possible"].includes(record.state)) throw failure("continuity_execution_unsettled");
  const observed = receipt(host, record);
  if (!observed.continuity) throw failure("continuity_session_lost");
  const sendAuthorized = record.state === "prepared";
  record.state = "send-possible";
  return { ...receipt(host, record), sendAuthorized };
}
async function retireContinuityWriter(host, recovery) {
  const existing = exactRecord(host, recovery);
  if (!existing) return missingReceipt(host, recovery);
  const record = currentRecord(host, recovery);
  // Revoke admission immediately, but retain physical references through asynchronous close.
  record.retirementRequested = true;
  record.state = "retired";
  record.writerRetired = false;
  const tabs = physicalTurnTabs(host).filter(tab => sameRecovery(tab.continuityRecovery, recovery));
  for (const tab of tabs) {
    tab.continuityInvalidated = true;
    if (!tab.closing) {
      try { host.removeTurnTab(tab, true); }
      catch { if (!tab.view.webContents.isDestroyed()) throw failure("continuity_unverified"); }
    }
  }
  if (hasPhysicalWriter(host, recovery) || acquisitionPending(record)) throw failure("continuity_unverified");
  record.state = "retired";
  record.writerRetired = true;
  return receipt(host, record);
}
function completeContinuityTransaction(host, tab, completed) {
  if (!tab.continuityRecovery) return;
  const record = tables(host).get(threadKey(tab.continuityRecovery));
  if (!record || !sameRecovery(record.identity, tab.continuityRecovery) || record.retirementRequested) return;
  record.tabId = tab.id;
  if (completed) record.state = "completed";
}
function removedContinuityTab(host, tab) {
  if (!tab.continuityRecovery) return;
  const record = tables(host).get(threadKey(tab.continuityRecovery));
  if (!record || !sameRecovery(record.identity, tab.continuityRecovery)) return;
  record.tabId = tab.id;
  record.writerRetired = !hasPhysicalWriter(host, record.identity) && !acquisitionPending(record);
  if (!["creating", "retired", "completed"].includes(record.state)) record.state = "missing";
}

module.exports = { RECOVERY_FEATURE, validRecovery, sameRecovery, validateRecovery,
  assertContinuityActivity, physicalTurnTabs,
  acquireContinuityTransaction, queryContinuityTransaction, updateContinuityPreparation,
  markContinuitySendPossible, retireContinuityWriter, completeContinuityTransaction, removedContinuityTab };
