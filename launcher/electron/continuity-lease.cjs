const { createHash, randomBytes } = require("node:crypto");
const { validRecovery, sameRecovery } = require("./continuity-recovery.cjs");

const CONTINUITY_IDLE_TTL_MS = 86_400_000;
const CONTINUITY_FEATURE = "session-continuity-v1";
function continuityFailure(code = "continuity_session_lost") {
  const error = new Error(code === "continuity_resource_capacity"
    ? "The browser has no free capacity. Close an existing page before starting another task; healthy continuity pages were not evicted"
    : code === "continuity_source_unproven"
    ? "The exact continuity owner or source head cannot be proved; no new page was created"
    : code === "continuity_unverified"
    ? "The continuity page cannot currently be verified; retry its original transaction"
    : code === "continuity_execution_unsettled"
    ? "The prior continuity execution must be coordinated before another Send"
    : "The continuity conversation is unavailable; recovery requires retirement and tool settlement evidence");
  error.code = code;
  return error;
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validLease(lease) {
  return object(lease) && (Object.keys(lease).sort().join(",") === "leaseId,owner,traceId"
    || (Object.keys(lease).sort().join(",") === "leaseId,owner,recovery,traceId" && validRecovery(lease.recovery)))
    && typeof lease.owner === "string" && /^[a-f0-9]{64}$/.test(lease.owner)
    && typeof lease.leaseId === "string" && /^[a-f0-9]{32}$/.test(lease.leaseId)
    && typeof lease.traceId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(lease.traceId);
}
function validateContinuityClaim(claim) {
  if (claim === undefined) return;
  if (!object(claim) || typeof claim.owner !== "string" || !/^[a-f0-9]{64}$/.test(claim.owner)
    || Object.keys(claim).some(key => !["owner", "expected", "recovery"].includes(key))
    || (claim.expected !== undefined && (!validLease(claim.expected) || claim.expected.owner !== claim.owner))
    || (claim.recovery !== undefined && !validRecovery(claim.recovery))) {
    throw continuityFailure("continuity_source_unproven");
  }
}
function claimDigest(claim) {
  return createHash("sha256").update(JSON.stringify([
    claim.owner, claim.expected?.leaseId ?? null, claim.expected?.traceId ?? null,
    claim.recovery ?? null,
  ])).digest("hex");
}
function continuityLease(tab) {
  return tab.continuityOwner ? {
    owner: tab.continuityOwner, leaseId: tab.continuityLeaseId, traceId: tab.traceId,
    ...(tab.continuityRecovery ? { recovery: structuredClone(tab.continuityRecovery) } : {}),
  } : undefined;
}
function continuityExpired(tab, now = Date.now()) {
  return Boolean(tab.continuityOwner) && tab.status === "ready"
    && (!Number.isFinite(tab.continuityLastSuccessAt) || now - tab.continuityLastSuccessAt >= CONTINUITY_IDLE_TTL_MS);
}
function assertContinuityLease(tab, expected) {
  if (!validLease(expected) || !tab || !tab.continuityOwner
    || tab.continuityOwner !== expected.owner || tab.continuityLeaseId !== expected.leaseId
    || ((tab.continuityRecovery || expected.recovery) && !sameRecovery(tab.continuityRecovery, expected.recovery))
    || tab.traceId !== expected.traceId || tab.continuityInvalidated || tab.view.webContents.isDestroyed()
    || continuityExpired(tab) || !["ready", "running"].includes(tab.status)) throw continuityFailure();
}

/** Called synchronously before creating a page, copying a prompt, or mutating a retained owner. */
function assertContinuityStart(tab, claim, traceId, helperPid) {
  validateContinuityClaim(claim);
  if (!claim) {
    if (tab?.continuityOwner) throw continuityFailure("continuity_source_unproven");
    return;
  }
  if (tab?.continuityRecovery && !claim.recovery) throw continuityFailure("continuity_configuration_conflict");
  if (!tab) {
    if (claim.expected) throw continuityFailure();
    return;
  }
  const exactRetry = tab.traceId === traceId && tab.helperPid === helperPid
    && tab.continuityOwner === claim.owner && tab.continuityClaimDigest === claimDigest(claim);
  if (exactRetry && tab.status === "running" && !tab.initializingSurface && !tab.continuityInvalidated
    && !tab.view.webContents.isDestroyed()) return;
  if (!claim.expected) throw continuityFailure("continuity_source_unproven");
  assertContinuityLease(tab, claim.expected);
  if (tab.status !== "ready") throw continuityFailure("continuity_source_unproven");
}

function bindContinuityTab(tab, claim) {
  if (!claim) return;
  validateContinuityClaim(claim);
  tab.continuityOwner = claim.owner;
  tab.continuityLeaseId ??= randomBytes(16).toString("hex");
  tab.continuityClaimDigest = claimDigest(claim);
  if (claim.recovery) tab.continuityRecovery = structuredClone(claim.recovery);
}

function inspectContinuityConversation(host, conversationKey, expected) {
  const matches = [...host.turnTabs.values()].filter(tab => tab.conversationKey === conversationKey);
  if (matches.length !== 1) throw continuityFailure();
  const tab = matches[0];
  assertContinuityLease(tab, expected);
  return { continuity: continuityLease(tab), state: tab.status };
}

module.exports = {
  CONTINUITY_IDLE_TTL_MS, CONTINUITY_FEATURE, continuityFailure, continuityLease, continuityExpired,
  validateContinuityClaim, assertContinuityLease, assertContinuityStart, bindContinuityTab,
  inspectContinuityConversation,
};
