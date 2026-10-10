export const CONTINUITY_IDLE_TTL_MS = 86_400_000;
export const CONTINUITY_FEATURE = "session-continuity-v1";
export const CONTINUITY_RECOVERY_FEATURE = "session-continuity-recovery-v3";

export interface ContinuityLauncherInstance {
  pid: number;
  startIdentity: string;
  instanceId: string;
}

export function isContinuityLauncherInstance(value: unknown): value is ContinuityLauncherInstance {
  if (!object(value)) return false;
  return Object.keys(value).sort().join(",") === "instanceId,pid,startIdentity"
    && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number(value.pid) <= 2147483647
    && typeof value.instanceId === "string" && /^[a-f0-9]{64}$/.test(value.instanceId)
    && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && value.startIdentity.length <= 256;
}

export function sameContinuityLauncherInstance(a: ContinuityLauncherInstance | undefined, b: ContinuityLauncherInstance | undefined): boolean {
  return Boolean(a && b && a.pid === b.pid && a.startIdentity === b.startIdentity && a.instanceId === b.instanceId);
}

export function isVerifiableContinuityLauncherInstance(value: ContinuityLauncherInstance): boolean {
  return /^linux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d+$/.test(value.startIdentity)
    || /^darwin:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value.startIdentity)
    || /^win32:[1-9]\d{0,18}$/.test(value.startIdentity);
}

/** Public acquisition identity. It contains no prompt, tool result or capability. */
export interface ContinuityRecoveryIdentity {
  schemaVersion: 2;
  installationId: string;
  threadKey: string;
  epoch: number;
  transactionId: string;
  transactionVersion: number;
  logicalWorkId: string;
  attempt: number;
  snapshotVersion: number;
  snapshotDigest: string;
  ownerProcess: { pid: number; startIdentity: string };
  /** Absent only before any acquisition was made possible, or in an older unproven record. */
  launcherInstance?: ContinuityLauncherInstance;
}

export interface ContinuityTransactionReceipt {
  recovery: ContinuityRecoveryIdentity;
  state: "creating" | "prepared" | "send-possible" | "completed" | "retired" | "missing" | "unknown";
  writerRetired: boolean;
  /** A page lease can never prove that an external tool has finished. */
  toolsSettled: false;
  launcherInstance?: ContinuityLauncherInstance;
  hostNoWriter?: boolean;
  /** The exact predecessor of the latest prepared-input CAS, including its former owner. */
  preparationExpected?: ContinuityRecoveryIdentity;
  continuity?: ContinuityLease;
  surfaceId?: string;
  tabId?: string;
}

export interface ContinuityLease {
  owner: string;
  leaseId: string;
  traceId: string;
  recovery?: ContinuityRecoveryIdentity;
}

export interface ContinuityClaim {
  owner: string;
  expected?: ContinuityLease;
  recovery?: ContinuityRecoveryIdentity;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isContinuityRecoveryIdentity(value: unknown): value is ContinuityRecoveryIdentity {
  if (!object(value) || value.schemaVersion !== 2 || !object(value.ownerProcess)) return false;
  const hashes = [value.installationId, value.threadKey, value.snapshotDigest];
  return Object.keys(value).filter(key => key !== "launcherInstance").sort().join(",") === "attempt,epoch,installationId,logicalWorkId,ownerProcess,schemaVersion,snapshotDigest,snapshotVersion,threadKey,transactionId,transactionVersion"
    && (value.launcherInstance === undefined || isContinuityLauncherInstance(value.launcherInstance))
    && hashes.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item))
    && [value.transactionId, value.logicalWorkId].every(item => typeof item === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(item))
    && [value.epoch, value.transactionVersion, value.attempt, value.snapshotVersion].every(item => Number.isSafeInteger(item) && Number(item) >= 0)
    && Object.keys(value.ownerProcess).sort().join(",") === "pid,startIdentity"
    && Number.isSafeInteger(value.ownerProcess.pid) && Number(value.ownerProcess.pid) > 0
    && typeof value.ownerProcess.startIdentity === "string" && value.ownerProcess.startIdentity.length > 0
    && value.ownerProcess.startIdentity.length <= 256;
}

export function sameContinuityRecoveryIdentity(a: ContinuityRecoveryIdentity, b: ContinuityRecoveryIdentity): boolean {
  return a.schemaVersion === b.schemaVersion && a.installationId === b.installationId && a.threadKey === b.threadKey
    && a.epoch === b.epoch && a.transactionId === b.transactionId && a.transactionVersion === b.transactionVersion
    && a.logicalWorkId === b.logicalWorkId && a.attempt === b.attempt && a.snapshotVersion === b.snapshotVersion
    && a.snapshotDigest === b.snapshotDigest && a.ownerProcess.pid === b.ownerProcess.pid
    && a.ownerProcess.startIdentity === b.ownerProcess.startIdentity
    && ((!a.launcherInstance && !b.launcherInstance) || sameContinuityLauncherInstance(a.launcherInstance, b.launcherInstance));
}

export function isContinuityLease(value: unknown): value is ContinuityLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return (Object.keys(lease).sort().join(",") === "leaseId,owner,traceId"
      || (Object.keys(lease).sort().join(",") === "leaseId,owner,recovery,traceId" && isContinuityRecoveryIdentity(lease.recovery)))
    && typeof lease.owner === "string" && /^[a-f0-9]{64}$/.test(lease.owner)
    && typeof lease.leaseId === "string" && /^[a-f0-9]{32}$/.test(lease.leaseId)
    && typeof lease.traceId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(lease.traceId);
}

export function isContinuityClaim(value: unknown): value is ContinuityClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.owner === "string" && /^[a-f0-9]{64}$/.test(claim.owner)
    && Object.keys(claim).every(key => ["owner", "expected", "recovery"].includes(key))
    && (claim.expected === undefined || (isContinuityLease(claim.expected) && claim.expected.owner === claim.owner))
    && (claim.recovery === undefined || isContinuityRecoveryIdentity(claim.recovery));
}
