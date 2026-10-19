const { validLauncherInstance, sameLauncherInstance, launcherProcessInstanceStatus, launcherInstance,
  knownProcessStart } = require("./continuity-process-instance.cjs");
const RECOVERY_FEATURE = "session-continuity-recovery-v4";
const MAX_RECOVERY_THREADS = 10_000;
const MAX_RECEIPTS = 256;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (code = "continuity_source_unproven") => require("./continuity-lease.cjs").continuityFailure(code);
const { EXECUTION_PROTOCOL, assertExecutionAuthority, assertExecutionIsolation, hasIdleExecutionAuthority } = require("./continuity-execution-authority.cjs");
const { cleanupTurnPage, cleanupReceipts, cleanupState } = require("./continuity-page-cleanup.cjs");
const { randomBytes } = require("node:crypto");
const unsentCapacityCandidates = new WeakMap();
const knownUnsentFailures = new WeakMap();
const validRequestId = value => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);

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
function exactRecord(host, recovery, allowMissing = false) {
  validateRecovery(recovery);
  const current = tables(host).get(threadKey(recovery));
  if (current && sameRecovery(current.identity, recovery)) return current;
  // Old observations can query their own receipt, but cannot mutate the current owner.
  const previous = host.continuityTransactionReceipts.get(`${threadKey(recovery)}:${recovery.transactionId}`);
  if (previous && sameRecovery(previous.identity, recovery)) return previous;
  if (current && (!allowMissing || current.identity.epoch === recovery.epoch)) throw failure();
  return undefined;
}
/** UI removal is not physical destruction. Closing documents retain their frozen identity. */
function physicalTurnTabs(host) {
  const active = [...host.turnTabs.values()].filter(tab => !tab.view?.webContents?.isDestroyed?.());
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
/** Called only at an actual capacity boundary before page allocation or prompt exposure. */
function acquisitionCapacityFailure(host, claim) {
  const error = failure("continuity_resource_capacity");
  if (!claim?.recovery || claim.expected) return error;
  const record = tables(host).get(threadKey(claim.recovery));
  if (record && sameRecovery(record.identity, claim.recovery) && record.state === "creating"
    && validRequestId(record.acquisitionRequestId) && !record.acquisitionEffects && !record.result
    && !record.retirementRequested && !hasPhysicalWriter(host, record.identity)) {
    unsentCapacityCandidates.set(error, { host, record, requestId: record.acquisitionRequestId,
      recovery: structuredClone(record.identity) });
  }
  return error;
}
function noteAcquisitionEffect(host, claim) {
  if (!claim?.recovery) return;
  const record = tables(host).get(threadKey(claim.recovery));
  if (record && sameRecovery(record.identity, claim.recovery)) {
    record.acquisitionEffects = true;
    record.unsentReceipt = undefined;
  }
}
function finalizeUnsentFailure(host, record, error) {
  const candidate = unsentCapacityCandidates.get(error);
  if (error?.code !== "continuity_resource_capacity" || !candidate || candidate.host !== host || candidate.record !== record
    || candidate.requestId !== record.acquisitionRequestId || !sameRecovery(candidate.recovery, record.identity)
    || tables(host).get(threadKey(record.identity)) !== record || record.state !== "missing"
    || record.pending || record.result || record.acquisitionEffects || record.retirementRequested
    || hasPhysicalWriter(host, record.identity)) return;
  knownUnsentFailures.set(error, candidate);
}
/** HTTP failure receipts are bound to this request; a missing/query receipt cannot manufacture one. */
function acquisitionKnownUnsentReceipt(host, error, recovery, traceId, helperPid, requestId) {
  const candidate = knownUnsentFailures.get(error);
  const record = candidate?.record;
  const currentInstance = launcherInstance(host);
  if (error?.code !== "continuity_resource_capacity" || !candidate || candidate.host !== host || !validRequestId(requestId) || candidate.requestId !== requestId
    || record.acquisitionRequestId !== requestId || record.traceId !== traceId || record.helperPid !== helperPid
    || !sameRecovery(candidate.recovery, recovery) || !sameLauncherInstance(recovery.launcherInstance, currentInstance)
    || tables(host).get(threadKey(recovery)) !== record || record.state !== "missing" || record.pending
    || record.result || record.acquisitionEffects || record.retirementRequested || hasPhysicalWriter(host, recovery)) return undefined;
  if (record.unsentReceipt?.requestId === requestId && sameRecovery(record.unsentReceipt.recovery, recovery)) {
    return structuredClone(record.unsentReceipt);
  }
  record.unsentReceipt = { schemaVersion: 1, receiptId: randomBytes(16).toString("hex"), state: "known-unsent",
    executionProtocol: EXECUTION_PROTOCOL, sendState: "not-started", requestId, traceId, helperPid,
    recovery: structuredClone(recovery), launcherInstance: currentInstance };
  return structuredClone(record.unsentReceipt);
}
function receipt(host, record, recovery = record?.identity) {
  const currentInstance = launcherInstance(host);
  if (!record) return missingReceipt(host, recovery);
  const tab = host.turnTabs.get(record.tabId);
  const live = tab && ["ready", "running"].includes(tab.status) && sameRecovery(tab.continuityRecovery, record.identity)
    && !tab.continuityInvalidated && !tab.view.webContents.isDestroyed()
    && !require("./continuity-lease.cjs").continuityExpired(tab);
  const state = !live && ["prepared", "send-possible"].includes(record.state) ? "missing" : record.state;
  return {
    recovery: structuredClone(record.identity), state,
    writerRetired: record.executionIsolated === true || record.writerRetired === true && !hasPhysicalWriter(host, record.identity) && !acquisitionPending(record), toolsSettled: false,
    executionProtocol: EXECUTION_PROTOCOL, executionIsolated: record.executionIsolated === true,
    physicalCleanup: acquisitionPending(record) || record.physicalTargetUnknown && cleanupReceipts(host, record.identity).length === 0
      ? "pending" : cleanupState(host, record.identity), cleanup: cleanupReceipts(host, record.identity),
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
  const sameHost = old && sameLauncherInstance(old, current);
  let durableIsolation = false;
  if (sameHost && currentVerified) {
    try { assertExecutionIsolation(host, recovery); durableIsolation = true; } catch {}
  }
  const oldExited = old && knownProcessStart(old.startIdentity) && !sameHost
    && launcherProcessInstanceStatus(old) === "exited";
  const isolated = Boolean(durableIsolation || hostNoWriter && currentVerified && oldExited);
  return { recovery: structuredClone(recovery), state: hostNoWriter && currentVerified ? "missing" : "unknown",
    writerRetired: isolated, toolsSettled: false,
    executionProtocol: EXECUTION_PROTOCOL, executionIsolated: isolated,
    physicalCleanup: oldExited && hostNoWriter ? "destroyed"
      : cleanupReceipts(host, recovery).length === 0 ? "pending" : cleanupState(host, recovery), cleanup: cleanupReceipts(host, recovery),
    launcherInstance: current, hostNoWriter };
}
function queryContinuityTransaction(host, recovery) { return receipt(host, exactRecord(host, recovery, true), recovery); }

/** Reserve synchronously, before an async Electron allocation. Caller disconnect never cancels it. */
function reserve(host, claim, traceId, helperPid, conversationKey, mode) {
  if (host.destroyed) throw failure("continuity_unverified");
  const identity = claim.recovery;
  validateRecovery(identity);
  assertExecutionAuthority(host, identity);
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
    const retained = claim.expected && sameRecovery(claim.expected.recovery, previous)
      && record.state === "completed" && identity.epoch === previous.epoch;
    if (!retained) {
      let previousAuthorized = false;
      try { assertExecutionAuthority(host, previous); previousAuthorized = true; } catch {}
      if (identity.epoch === previous.epoch || previousAuthorized) throw failure("continuity_execution_unsettled");
      // Current durable authority already revoked the old generation. Close its
      // exact documents; their physical slots remain occupied until destroyed.
      for (const tab of physicalTurnTabs(host).filter(tab => tab.continuityRecovery
        && threadKey(tab.continuityRecovery) === key && !sameRecovery(tab.continuityRecovery, identity))) {
        tab.continuityInvalidated = true;
        try { host.removeTurnTab(tab, true); } catch {}
        cleanupTurnPage(host, tab, { executionIsolated: true });
      }
      record.retirementRequested = true; record.executionIsolated = true; record.writerRetired = true; record.state = "retired";
    }
    remember(host, record);
  } else {
    if (records.size >= MAX_RECOVERY_THREADS) throw failure("continuity_resource_capacity");
    if (hasPhysicalWriter(host, identity)) throw failure("continuity_execution_unsettled");
    for (const tab of physicalTurnTabs(host).filter(tab => tab.continuityRecovery
      && threadKey(tab.continuityRecovery) === key && !sameRecovery(tab.continuityRecovery, identity))) {
      let previousAuthorized = false;
      try { assertExecutionAuthority(host, tab.continuityRecovery); previousAuthorized = true; } catch {}
      if (previousAuthorized) throw failure("continuity_execution_unsettled");
      tab.continuityInvalidated = true;
      try { host.removeTurnTab(tab, true); } catch {}
      cleanupTurnPage(host, tab, { executionIsolated: true });
    }
  }
  record = { identity: structuredClone(identity), owner: claim.owner, traceId, helperPid,
    conversationKey, mode, state: "creating", writerRetired: false };
  records.set(key, record);
  return record;
}
function finishAcquisition(host, record, result) {
  let authorized = true;
  try { assertExecutionAuthority(host, record.identity); } catch { authorized = false; }
  if (!authorized || tables(host).get(threadKey(record.identity)) !== record || record.retirementRequested || record.state === "retired") {
    // A cancelled acquisition may create its exact page only after the retirement request.
    // Close that late page too; its destruction must still be confirmed before recovery.
    for (const tab of [...host.turnTabs.values()]) {
      if (sameRecovery(tab.continuityRecovery, record.identity)) {
        try { host.removeTurnTab(tab, true); } catch {}
        cleanupTurnPage(host, tab, { executionIsolated: record.executionIsolated === true });
      }
    }
    record.pending = undefined;
    record.writerRetired = record.executionIsolated === true || !hasPhysicalWriter(host, record.identity);
    throw failure();
  }
  const tab = [...host.turnTabs.values()].find(item => item.traceId === record.traceId);
  if (!tab || !sameRecovery(tab.continuityRecovery, record.identity)) throw failure("continuity_unverified");
  record.tabId = tab.id;
  // A visible manual prompt can already have been sent. Do not claim it is still editable.
  record.state = record.mode === "manual" ? "send-possible" : "prepared";
  record.result = { ...result, executionProtocol: EXECUTION_PROTOCOL, continuity: require("./continuity-lease.cjs").continuityLease(tab) };
  record.pending = undefined;
  return structuredClone(record.result);
}
function failAcquisition(host, record) {
  record.pending = undefined;
  if (record.state === "creating") record.state = "missing";
  record.writerRetired = record.executionIsolated === true || !hasPhysicalWriter(host, record.identity);
}
function acquireContinuityTransaction(host, claim, traceId, helperPid, conversationKey, mode, create, requestId) {
  const record = reserve(host, claim, traceId, helperPid, conversationKey, mode);
  if (record.pending) return record.pending;
  if (record.result) {
    const observed = receipt(host, record);
    if (!observed.continuity) throw failure("continuity_session_lost");
    return structuredClone(record.result);
  }
  if (record.state === "missing") { record.state = "creating"; record.writerRetired = false; }
  record.acquisitionRequestId = requestId;
  try {
    const result = create();
    if (result && typeof result.then === "function") {
      record.pending = result.then(value => {
        try { return finishAcquisition(host, record, value); }
        catch (error) { failAcquisition(host, record); throw error; }
      }, error => { failAcquisition(host, record); finalizeUnsentFailure(host, record, error); throw error; });
      return record.pending;
    }
    return finishAcquisition(host, record, result);
  } catch (error) { failAcquisition(host, record); finalizeUnsentFailure(host, record, error); throw error; }
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
  assertExecutionAuthority(host, recovery);
  const record = currentRecord(host, recovery);
  if (record.retirementRequested || record.executionIsolated) throw failure();
  if (tab) {
    if (tab.helperPid !== helperPid || !sameRecovery(tab.continuityRecovery, recovery)) throw failure();
    return;
  }
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
  assertExecutionAuthority(host, expected, { preparation: true });
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
  assertExecutionAuthority(host, recovery);
  if (!["prepared", "send-possible"].includes(record.state)) throw failure("continuity_execution_unsettled");
  const observed = receipt(host, record);
  if (!observed.continuity) throw failure("continuity_session_lost");
  const sendAuthorized = record.state === "prepared";
  record.state = "send-possible";
  return { ...receipt(host, record), sendAuthorized };
}
/** Idempotent confirmation of a journal fence at the page owner. It cannot revoke a Send. */
function terminateContinuityPreparation(host, recovery) {
  const termination = require("./continuity-execution-authority.cjs").preparationTermination(host, recovery);
  const { assertContinuityLease, continuityLease } = require("./continuity-lease.cjs");
  const matches = [...host.turnTabs.values()].filter(tab => tab.continuityLeaseId === termination.lease.leaseId
    && tab.continuityOwner === termination.lease.owner);
  if (matches.length !== 1) throw failure("continuity_session_lost");
  const tab = matches[0];
  assertContinuityLease(tab, termination.lease);
  if (tab.authenticationRequired || host.userCancelledTurnOwners?.has(termination.traceId)
    || tab.failedAt !== undefined || tab.closing) throw failure("continuity_session_lost");
  // A pre-publication manual failure still refers to the previous ready lease.
  // An acquired helper preparation owns the current running trace and helper.
  const acquired = sameRecovery(tab.continuityRecovery, recovery);
  if (acquired && (tab.traceId !== termination.traceId || tab.helperPid !== termination.helperPid)) throw failure();
  if (!acquired && tab.status !== "ready") throw failure("continuity_execution_unsettled");
  let record = acquired ? exactRecord(host, recovery, true) : undefined;
  if (!record && acquired) {
    if (tables(host).has(threadKey(recovery)) || tables(host).size >= MAX_RECOVERY_THREADS) throw failure("continuity_unverified");
    record = { identity: structuredClone(recovery), owner: tab.continuityOwner, traceId: tab.traceId,
      helperPid: tab.helperPid, conversationKey: tab.conversationKey, mode: tab.interactionMode,
      tabId: tab.id, state: "prepared", writerRetired: false,
      result: { continuity: continuityLease(tab), ...(tab.surfaceId ? { surfaceId: tab.surfaceId } : {}) } };
    tables(host).set(threadKey(recovery), record);
  }
  if (record && acquired) {
    if (!["prepared", "completed"].includes(record.state) || record.preparationTerminated && record.preparationTerminated !== termination.receiptId) throw failure("continuity_execution_unsettled");
    record.state = "completed";
    record.preparationTerminated = termination.receiptId;
  }
  tab.status = "ready"; tab.approvalPending = false; tab.turnProgress = undefined;
  tab.activity = undefined; tab.loading = false;
  tab.message = "Preparation failed. The conversation is retained; correct the input and retry.";
  if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling?.(true);
  host.syncPowerSaveBlocker?.(); host.publishState?.(host.snapshot()); host.writeDescriptor?.();
  return { recovery: structuredClone(recovery), requestId: termination.requestId, receiptId: termination.receiptId,
    traceId: termination.traceId, helperPid: termination.helperPid, state: "preparation-terminated", continuity: continuityLease(tab) };
}
async function retireContinuityWriter(host, recovery) {
  let existing;
  try { existing = exactRecord(host, recovery, true); } catch { /* A successor owns the current table. */ }
  if (!existing) {
    const missing = missingReceipt(host, recovery);
    try { assertExecutionIsolation(host, recovery); } catch { return missing; }
    if (tables(host).size >= MAX_RECOVERY_THREADS) throw failure("continuity_resource_capacity");
    // An authenticated durable fence can restore the target's lost local cleanup record.
    existing = { identity: structuredClone(recovery), state: "retired", writerRetired: true, executionIsolated: true, physicalTargetUnknown: true };
    if (!tables(host).has(threadKey(recovery))) tables(host).set(threadKey(recovery), existing);
  }
  assertExecutionIsolation(host, recovery);
  const record = existing;
  // Durable execution isolation is independent of a physical destroyed receipt.
  record.retirementRequested = true;
  record.state = "retired";
  record.writerRetired = true;
  record.executionIsolated = true;
  const tabs = physicalTurnTabs(host).filter(tab => sameRecovery(tab.continuityRecovery, recovery));
  for (const tab of tabs) {
    tab.continuityInvalidated = true;
    if (!tab.closing) {
      try { host.removeTurnTab(tab, true); } catch {}
    }
    cleanupTurnPage(host, tab, { executionIsolated: true });
  }
  return receipt(host, record);
}
async function retryContinuityCleanup(host, recovery, retryId) {
  if (typeof retryId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(retryId)) throw failure();
  const record = exactRecord(host, recovery);
  if (!record || !record.executionIsolated) throw failure("continuity_unverified");
  for (const tab of physicalTurnTabs(host).filter(tab => sameRecovery(tab.continuityRecovery, recovery))) {
    cleanupTurnPage(host, tab, { executionIsolated: true, retryId });
  }
  return receipt(host, record);
}
function completeContinuityTransaction(host, tab, completed) {
  if (!tab.continuityRecovery) return;
  const record = tables(host).get(threadKey(tab.continuityRecovery));
  if (!record || !sameRecovery(record.identity, tab.continuityRecovery) || record.retirementRequested) return;
  record.tabId = tab.id;
  if (completed) record.state = "completed";
}
function removedContinuityTab(host, tab, contents = tab.view?.webContents) {
  if (!tab.continuityRecovery || !contents) return;
  if (contents.isDestroyed()) {
    let removed;
    try { removed = require("./continuity-page-store.cjs").removeDestroyedPage(host, tab.continuityRecovery, tab, contents); }
    catch (error) {
      host.logger?.warn?.("browser.page_task_cleanup_pending", { reason: error.message });
      tab.continuityStoreCleanupAttempts = (tab.continuityStoreCleanupAttempts ?? 0) + 1;
      if (tab.continuityStoreCleanupAttempts < 100) {
        const retry = setTimeout(() => removedContinuityTab(host, tab, contents), 50); retry.unref?.();
      }
      return;
    }
    const key = threadKey(tab.continuityRecovery);
    const belongsToDestroyedPage = identity => sameRecovery(identity, tab.continuityRecovery)
      || removed && identity.installationId === tab.continuityRecovery.installationId
        && identity.threadKey === tab.continuityRecovery.threadKey && identity.epoch === tab.continuityRecovery.epoch;
    const current = tables(host).get(key);
    if (current && belongsToDestroyedPage(current.identity)) tables(host).delete(key);
    for (const [receiptKey, item] of host.continuityTransactionReceipts) {
      if (belongsToDestroyedPage(item.identity)) host.continuityTransactionReceipts.delete(receiptKey);
    }
    return;
  }
  const record = tables(host).get(threadKey(tab.continuityRecovery));
  if (!record || !sameRecovery(record.identity, tab.continuityRecovery)) return;
  record.tabId = tab.id;
  record.writerRetired = record.executionIsolated === true || !hasPhysicalWriter(host, record.identity) && !acquisitionPending(record);
  if (!["creating", "retired", "completed"].includes(record.state)) record.state = "missing";
}

function isSafelyReclaimableTurnTab(host, tab) {
  if (tab.closing || tab.status === "running" || tab.initializingSurface || tab.expiryCancellation
    || tab.pendingBusinessDispatch || tab.unsettledOperations || tab.unknownSend
    || tab.checkpointPending || tab.taskTransferPending) return false;
  const terminal = tab.failedAt !== undefined || tab.interactionMode === "manual" && tab.status === "error"
    && ["timed-out", "failed", "cancelled"].includes(tab.manualState);
  if (tab.status !== "ready" && !terminal) return false;
  if (tab.continuityRecovery) {
    const record = tables(host).get(threadKey(tab.continuityRecovery));
    if (!record || !sameRecovery(record.identity, tab.continuityRecovery) || acquisitionPending(record)
      || record.retirementRequested || !["completed", "missing"].includes(record.state)) return false;
    // Missing after a possible Send is not proof that business activity settled.
    if (record.state === "missing" && record.result) return false;
    if (host.continuityAuthorityDirectories?.has(tab.continuityRecovery.installationId)
      && !hasIdleExecutionAuthority(host, tab.continuityRecovery)) return false;
  }
  return true;
}

module.exports = { RECOVERY_FEATURE, validRecovery, sameRecovery, validateRecovery,
  acquisitionCapacityFailure, noteAcquisitionEffect, acquisitionKnownUnsentReceipt,
  assertContinuityActivity, physicalTurnTabs, isSafelyReclaimableTurnTab,
  acquireContinuityTransaction, queryContinuityTransaction, updateContinuityPreparation,
  markContinuitySendPossible, terminateContinuityPreparation, retireContinuityWriter, retryContinuityCleanup, completeContinuityTransaction, removedContinuityTab };
