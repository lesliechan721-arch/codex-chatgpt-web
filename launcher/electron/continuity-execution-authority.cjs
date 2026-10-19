const fs = require("node:fs");
const path = require("node:path");
const EXECUTION_FENCING_FEATURE = "execution-generation-fencing-v1";
const EXECUTION_PROTOCOL = 1;
const MAX_AUTHORITY_BYTES = 24 * 1024 * 1024;
const failure = () => require("./continuity-lease.cjs").continuityFailure("continuity_unverified");

function readDocument(directory) {
  const file = path.join(directory, "recovery.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES
    || process.platform !== "win32" && (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw failure();
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_AUTHORITY_BYTES) throw failure();
  const document = JSON.parse(bytes.toString("utf8"));
  if (document.version !== 4 || !document.threads || typeof document.threads !== "object") throw failure();
  return document;
}

/** Only the authenticated control channel binds a directory. The model never chooses it. */
function bindExecutionAuthority(host, recovery, directory) {
  require("./continuity-recovery.cjs").validateRecovery(recovery);
  host.continuityAuthorityDirectories ??= new Map();
  const existing = host.continuityAuthorityDirectories.get(recovery.installationId);
  if (directory === undefined) {
    if (!existing && !host.continuityAuthorityReader) throw failure();
    return;
  }
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw failure();
  const resolved = fs.realpathSync(directory);
  if (existing && existing !== resolved) throw failure();
  const document = readDocument(resolved);
  if (document.installation !== recovery.installationId) throw failure();
  host.continuityAuthorityDirectories.set(recovery.installationId, resolved);
}

function matchesAttempt(attempt, recovery) {
  return ["epoch", "snapshotVersion", "snapshotDigest", "transactionId", "transactionVersion"]
    .every(key => attempt[key] === recovery[key]);
}

/** A stopped CAS reservation proves cleanup authority, never execution authority. */
function stoppedPreparationTarget(record, work, attempt, recovery) {
  if (work.state !== "stopped" || work.attempts.at(-1) !== attempt || attempt.writerRetired !== true) return false;
  const { validRecovery, sameRecovery } = require("./continuity-recovery.cjs");
  const { sameLauncherInstance } = require("./continuity-process-instance.cjs");
  const tagIdentity = tag => {
    const transaction = tag.transaction;
    return { schemaVersion: recovery.schemaVersion, installationId: recovery.installationId, threadKey: recovery.threadKey,
      epoch: transaction.targetEpoch, transactionId: transaction.transactionId, transactionVersion: transaction.version,
      logicalWorkId: transaction.logicalWorkId, attempt: transaction.attempt, snapshotVersion: transaction.snapshotVersion,
      snapshotDigest: transaction.snapshotDigest, ownerProcess: { pid: tag.owner?.pid, startIdentity: tag.owner?.startIdentity },
      launcherInstance: transaction.launcherInstance };
  };
  return [record.pendingPreparation, record.retiredPreparation].some(pending => {
    const before = pending?.expected?.transaction;
    const target = pending?.target?.transaction;
    if (!before || !target || !/^[a-f0-9]{64}$/.test(pending.preparationId)
      || !["prepared", "page-possible", "page-acquired"].includes(before.stage) || before.writerRetired !== false
      || target.stage !== "prepared" || target.writerRetired !== false || target.toolsSettled !== true || target.pageReceiptId !== undefined
      || ["transactionId", "logicalWorkId", "attempt", "sourceEpoch", "targetEpoch"].some(key => target[key] !== before[key])
      || target.version !== before.version + 1 || target.snapshotVersion !== before.snapshotVersion + 1
      || !sameLauncherInstance(before.launcherInstance, target.launcherInstance)
      || !sameLauncherInstance(attempt.launcherInstance, before.launcherInstance)) return false;
    const expectedIdentity = tagIdentity(pending.expected);
    return validRecovery(expectedIdentity) && matchesAttempt(attempt, expectedIdentity)
      && sameRecovery(recovery, tagIdentity(pending.target));
  });
}

function authority(host, recovery, { isolation = false } = {}) {
  // Tests may supply an in-memory reader; production always uses the bound private journal.
  if (host.continuityAuthorityReader) return host.continuityAuthorityReader(recovery);
  try {
    const directory = host.continuityAuthorityDirectories?.get(recovery.installationId);
    if (!directory) throw failure();
    const document = readDocument(directory);
    if (document.installation !== recovery.installationId) throw failure();
    const record = document.threads[recovery.threadKey];
    const work = record?.works?.[recovery.logicalWorkId];
    const attempt = work?.attempts?.find(item => item.attempt === recovery.attempt);
    if (!record || !work || !attempt || record.legacyUnproven
      || !matchesAttempt(attempt, recovery) && !(isolation && stoppedPreparationTarget(record, work, attempt, recovery))) throw failure();
    return { record, work, attempt };
  } catch { throw failure(); }
}

function assertExecutionAuthority(host, recovery, { preparation = false } = {}) {
  require("./continuity-recovery.cjs").validateRecovery(recovery);
  const { record, work, attempt } = authority(host, recovery);
  if (record.epoch !== recovery.epoch
    || record.owner?.pid !== recovery.ownerProcess.pid || record.owner?.startIdentity !== recovery.ownerProcess.startIdentity
    || work.attempts.at(-1) !== attempt
    || record.state === "stopped" || !preparation && record.pendingPreparation) throw failure();
  let current = record.works[record.currentWorkId];
  if (!current || ["completed", "stopped"].includes(current.state) || current.attempts.at(-1)?.writerRetired
    || current.attempts.at(-1)?.epoch !== recovery.epoch) throw failure();
  if (current === work && (attempt.writerRetired || ["completed", "stopped"].includes(work.state))) throw failure();
  const seen = new Set();
  while (current.logicalWorkId !== recovery.logicalWorkId) {
    if (seen.has(current.logicalWorkId) || current.purpose !== "ordinary" || work.purpose !== "ordinary"
      || current.workLineageId !== work.workLineageId || current.attempts.at(-1)?.epoch !== recovery.epoch
      || !current.predecessorLogicalWorkId) throw failure();
    seen.add(current.logicalWorkId);
    current = record.works[current.predecessorLogicalWorkId];
    if (!current) throw failure();
  }
}

function assertExecutionIsolation(host, recovery) {
  require("./continuity-recovery.cjs").validateRecovery(recovery);
  // An absent/replaced generation has no project execution authority. Cleanup is
  // still allowed for that exact physical identity, without recreating its journal.
  if (!host.continuityAuthorityReader) {
    const directory = host.continuityAuthorityDirectories?.get(recovery.installationId);
    if (!directory) throw failure();
    const document = readDocument(directory);
    if (document.installation !== recovery.installationId) throw failure();
    const current = document.threads[recovery.threadKey];
    const oldAttempt = current?.works?.[recovery.logicalWorkId]?.attempts?.[recovery.attempt];
    if (!current || current.epoch !== recovery.epoch || !oldAttempt) return;
  }
  const { record, attempt } = authority(host, recovery, { isolation: true });
  if (attempt.writerRetired !== true) throw failure();
  const current = record.works[record.currentWorkId];
  if (record.epoch === recovery.epoch && record.owner?.pid === recovery.ownerProcess.pid
    && record.owner?.startIdentity === recovery.ownerProcess.startIdentity
    && current?.attempts.at(-1)?.writerRetired !== true) throw failure();
}

/** Read the durable fence, never infer an unsent turn from an aborted HTTP request. */
function preparationTermination(host, recovery) {
  const { record, work, attempt } = authority(host, recovery);
  const termination = attempt.preparationTermination;
  if (!termination || !require("./continuity-recovery.cjs").sameRecovery(termination.recovery, recovery)
    || !attempt.writerRetired || attempt.sendEvidence && attempt.sendEvidence.status !== "not-sent"
    || record.pendingPreparation || record.currentWorkId !== work.logicalWorkId || work.attempts.at(-1) !== attempt
    || ["completed", "stopped"].includes(work.state) || record.state === "stopped" || record.epoch !== recovery.epoch
    || record.owner?.pid !== recovery.ownerProcess.pid || record.owner?.startIdentity !== recovery.ownerProcess.startIdentity) throw failure();
  return termination;
}

function hasUnsettledSend(host, recovery) {
  try {
    assertExecutionAuthority(host, recovery);
    return authority(host, recovery).attempt.sendEvidence?.status === "possible";
  } catch { return false; }
}

function hasIdleExecutionAuthority(host, recovery) {
  try {
    const { record, work } = authority(host, recovery);
    const current = record.works[record.currentWorkId];
    return !record.pendingPreparation && !["creating", "recovering", "compacting"].includes(record.state)
      && ["completed", "stopped"].includes(current?.state)
      && Object.values(record.calls ?? {}).every(call => call.workLineageId !== work.workLineageId
        || !["queued", "delivery-possible"].includes(call.state));
  } catch { return false; }
}

module.exports = { EXECUTION_FENCING_FEATURE, EXECUTION_PROTOCOL, bindExecutionAuthority,
  assertExecutionAuthority, assertExecutionIsolation, hasIdleExecutionAuthority, preparationTermination, hasUnsettledSend };
