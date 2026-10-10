import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { atomicWriteFile } from "../../config";
import { continuityError } from "./continuity-errors";
import { moveContinuityLockWithoutReplacement } from "./continuity-lock-windows";

export const MAX_CONTINUITY_RECOVERY_BYTES = 24 * 1024 * 1024;
export const MAX_CONTINUITY_RECOVERY_ITEM_BYTES = 2 * 1024 * 1024;
export const MAX_CONTINUITY_RECOVERY_CHECKPOINTS = 256;
export const MAX_CONTINUITY_RECOVERY_TOMBSTONES = 256;
export const MAX_CONTINUITY_RECOVERY_ROUNDS = 512;
export const CONTINUITY_RECOVERY_RETRY_WINDOW_MS = 30 * 60_000;
export const MAX_CONTINUITY_RECOVERY_RETRIES = 3;
const MAX_THREADS = 10_000;
const WORK_TERMINAL_RESERVE = 2048;
const CALL_TERMINAL_RESERVE = 256;
const CHECKPOINT_COMMIT_RESERVE = 2048;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@+-]{1,256}$/;

type WorkState = "prepared" | "send-possible" | "active" | "completed" | "stopped";
export type RecoveryAttemptStage = "prepared" | "page-possible" | "page-acquired" | "send-possible" | "accepted" | "interrupted-settled" | "completed" | "stopped";
export interface ContinuityProcessInstance { id: string; pid: number; startIdentity: string }
export interface ContinuityLauncherInstance { instanceId: string; pid: number; startIdentity: string }
export interface RecoveryAttemptRecord {
  attempt: number; epoch: number; historyRevision: number; snapshotVersion: number; snapshotDigest: string;
  stage: RecoveryAttemptStage; dispatchProtocolComplete: boolean; writerRetired: boolean;
  pageReceiptId?: string; transactionId?: string; transactionVersion?: number;
  launcherInstance?: ContinuityLauncherInstance;
}
export interface RecoveryRetryBudget { attempts: number; startedAt: number; lastFailureAt?: number }
/** The accepted boundary used to select the current instruction payload. No input positions or bodies. */
export interface RecoveryInstructionPrevious {
  instructionIdentity: string;
  nativeTurnId?: string;
  checkpointDigest?: string;
}
export interface RecoveryWorkRecord {
  logicalWorkId: string; instructionIdentity: string; nativeTurnId?: string; workPayloadDigest: string;
  purpose: "ordinary" | "compaction"; state: WorkState; workLineageId: string; acceptedTaskRevision: number;
  predecessorLogicalWorkId?: string; attempts: RecoveryAttemptRecord[]; retryBudget?: RecoveryRetryBudget;
  terminalReceiptId?: string; terminalDigest?: string; stopReason?: "user-stop" | "mode-exit" | "page-close" | "native-interrupt";
  compactionTargetId?: string;
  instructionPrevious?: RecoveryInstructionPrevious;
  allowRetainedSourceFallback?: boolean;
  activationState?: "shadow" | "active";
}
export interface RecoveryLineageRecord {
  rootLogicalWorkId: string; headLogicalWorkId: string; acceptedTaskRevision: number; toolBatchHeadSequence: number;
  taskMappings: Record<string, number>; batchMappings: Record<string, number>;
}
export interface RecoveryCallRecord {
  callId: string; operationId: string; expectedResultType: string; logicalWorkId: string; workLineageId: string;
  attempt: number; batchSequence: number; state: "queued" | "delivery-possible" | "settled" | "cancelled-before-delivery";
  firstResultDigest?: string;
  resultBodyBytes?: number; resultBodyOwner?: ContinuityProcessInstance;
}
export interface RecoveryCompactionTarget {
  compactionTargetId: string; sourceLogicalWorkId: string; workLineageId: string; acceptedTaskRevision: number;
  sourceHistoryRevision: number; sourceToolBatchHeadSequence: number; sourceIdentity: string;
  representationDigests: string[]; checkpointBytes: number;
}
export interface RecoveryCheckpointRecord extends RecoveryCompactionTarget {
  commitId: string; targetHistoryRevision: number; summaryDigest: string; coveredCallIds: string[]; retainedBodyBytes: number;
  ordinaryFinalReceiptId?: string; continuation: { state: "available" | "consumed"; nativeTurnId?: string; consumerLogicalWorkId?: string };
}
export interface RecoveryTransactionRecord {
  transactionId: string; version: number; sourceEpoch: number; targetEpoch: number; logicalWorkId: string;
  attempt: number; snapshotVersion: number; snapshotDigest: string; stage: RecoveryAttemptStage;
  writerRetired: boolean; toolsSettled: boolean; pageReceiptId?: string;
  launcherInstance?: ContinuityLauncherInstance;
}
export interface RecoveryPreparationIdentity { owner: ContinuityProcessInstance; transaction: RecoveryTransactionRecord }
export interface RecoveryPendingPreparation {
  preparationId: string; expected: RecoveryPreparationIdentity; target: RecoveryPreparationIdentity;
}
export interface RecoveryThreadRecord {
  thread: string; scope: string; version: number; epoch: number; historyRevision: number;
  owner: ContinuityProcessInstance; state: "creating" | "running" | "ready" | "compacting" | "unverified" | "lost" | "recovering" | "stopped";
  legacyUnproven: boolean; currentWorkId?: string; transaction?: RecoveryTransactionRecord;
  pendingPreparation?: RecoveryPendingPreparation;
  preparationReceipt?: { preparationId: string; target: RecoveryPreparationIdentity };
  retiredPreparation?: RecoveryPendingPreparation;
  works: Record<string, RecoveryWorkRecord>; lineages: Record<string, RecoveryLineageRecord>;
  calls: Record<string, RecoveryCallRecord>; compactionTargets: Record<string, RecoveryCompactionTarget>;
  checkpoints: Record<string, RecoveryCheckpointRecord>;
}
interface RecoveryDocument { version: 2; installation: string; threads: Record<string, RecoveryThreadRecord> }
export interface RecoveryGuard { scope: string; expectedVersion?: number; expectedEpoch?: number; expectedOwner?: string }
export interface AdmitRecoveryWorkInput {
  thread: string; scope: string; owner: ContinuityProcessInstance; logicalWorkId: string; instructionIdentity: string;
  nativeTurnId?: string; workPayloadDigest: string; snapshotDigest: string; purpose?: "ordinary" | "compaction";
  predecessorLogicalWorkId?: string; continuationCommitId?: string; compactionTargetId?: string;
  localSessionId?: string; localTaskRevision?: number; createPage?: boolean; dispatchProtocolComplete: boolean;
  instructionPrevious?: RecoveryInstructionPrevious; allowRetainedSourceFallback?: boolean;
  /** A healthy compaction control is recorded without replacing its source writer. */
  activate?: boolean;
}
export interface RecoveryCompactionActivationIdentity {
  attempt: number; snapshotVersion: number; transactionId: string; transactionVersion: number;
}
export interface RecoveryStoreOptions {
  now?: () => number;
  limits?: { totalBytes?: number; itemBytes?: number; checkpoints?: number; tombstones?: number; rounds?: number };
  /** Failure injection is synchronous and runs before the atomic replacement. */
  beforeWrite?: () => void;
  /** Models an uncertain commit after rename, before the containing directory is synced. */
  afterAtomicReplace?: () => void;
}
function invalid(reason: string): Error { return continuityError("continuity_configuration_conflict", reason); }
function unproven(reason: string): Error { return continuityError("continuity_source_unproven", reason); }
function capacity(reason: string): Error { return continuityError("continuity_resource_capacity", reason); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function size(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!isObject(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw invalid("Continuity recovery record has an invalid schema.");
}
function identity(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value)) throw invalid("Continuity recovery identity is invalid."); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) throw invalid("Continuity recovery digest is invalid."); }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid("Continuity recovery sequence is invalid."); }
function oneOf(value: unknown, values: string[]): void { if (typeof value !== "string" || !values.includes(value)) throw invalid("Continuity recovery state is invalid."); }
function boolean(value: unknown): void { if (typeof value !== "boolean") throw invalid("Continuity recovery evidence is invalid."); }
function optionalIdentity(value: unknown): void { if (value !== undefined) identity(value); }
function optionalHash(value: unknown): void { if (value !== undefined) hash(value); }
function validateInstructionPrevious(value: unknown): void {
  if (value === undefined) return;
  exact(value, ["instructionIdentity"], ["nativeTurnId", "checkpointDigest"]);
  identity(value.instructionIdentity); optionalIdentity(value.nativeTurnId); optionalHash(value.checkpointDigest);
}
function sameInstructionSelection(left: { instructionPrevious?: RecoveryInstructionPrevious; allowRetainedSourceFallback?: boolean }, right: { instructionPrevious?: RecoveryInstructionPrevious; allowRetainedSourceFallback?: boolean }): boolean {
  const previous = (selection: RecoveryInstructionPrevious | undefined) => selection
    ? [selection.instructionIdentity ?? null, selection.nativeTurnId ?? null, selection.checkpointDigest ?? null] : null;
  return JSON.stringify(previous(left.instructionPrevious)) === JSON.stringify(previous(right.instructionPrevious))
    && (left.allowRetainedSourceFallback ?? false) === (right.allowRetainedSourceFallback ?? false);
}
function sameProcess(left: ContinuityProcessInstance | undefined, right: ContinuityProcessInstance | undefined): boolean {
  return left?.id === right?.id && left?.pid === right?.pid && left?.startIdentity === right?.startIdentity;
}
function sameLauncher(left: ContinuityLauncherInstance | undefined, right: ContinuityLauncherInstance | undefined): boolean {
  return left?.instanceId === right?.instanceId && left?.pid === right?.pid && left?.startIdentity === right?.startIdentity;
}
function sameTransaction(left: RecoveryTransactionRecord | undefined, right: RecoveryTransactionRecord | undefined, authorizationOnly = false): boolean {
  if (!left || !right) return left === right;
  const fields = ["transactionId", "version", "sourceEpoch", "targetEpoch", "logicalWorkId", "attempt", "snapshotVersion", "snapshotDigest"] as const;
  return fields.every(field => left[field] === right[field]) && sameLauncher(left.launcherInstance, right.launcherInstance)
    && (authorizationOnly || left.stage === right.stage && left.writerRetired === right.writerRetired && left.toolsSettled === right.toolsSettled && left.pageReceiptId === right.pageReceiptId);
}
function noPendingPreparation(record: RecoveryThreadRecord): void {
  if (record.pendingPreparation) throw continuityError("continuity_unverified", "The exact previous and target preparation still require coordination before any new execution.");
}
function dictionary(value: unknown): asserts value is Record<string, unknown> { if (!isObject(value)) throw invalid("Continuity recovery index is invalid."); }
function mapping(value: unknown): void { dictionary(value); for (const [key, number] of Object.entries(value)) { identity(key); integer(number); } }
export function continuityProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (start && /^\d+$/.test(start) && /^[a-f0-9-]{36}$/.test(boot)) return `linux:${boot}:${start}`;
    } else if (process.platform === "darwin") {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      if (start) return `darwin:${start}`;
    } else if (process.platform === "win32") {
      // Preserve the OS creation time as integer FILETIME ticks, independent of locale.
      const start = execFileSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)`],
        { encoding: "utf8", timeout: 5000, maxBuffer: 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (/^[1-9]\d{0,18}$/.test(start)) return `win32:${start}`;
    }
  } catch { /* An unreadable identity is not proof of exit. */ }
  return null;
}
function knownProcessStart(value: string): boolean {
  return /^linux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d+$/.test(value)
    || /^darwin:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)
    || /^win32:[1-9]\d{0,18}$/.test(value);
}
function validateLauncherInstance(value: unknown): asserts value is ContinuityLauncherInstance {
  exact(value, ["instanceId", "pid", "startIdentity"]);
  validateProcess({ id: value.instanceId, pid: value.pid, startIdentity: value.startIdentity });
}
export function continuityLauncherInstanceStatus(instance: ContinuityLauncherInstance): "live" | "exited" | "unverified" {
  validateLauncherInstance(instance);
  return continuityProcessInstanceStatus({ id: instance.instanceId, pid: instance.pid, startIdentity: instance.startIdentity });
}
function validateProcess(value: unknown): asserts value is ContinuityProcessInstance {
  exact(value, ["id", "pid", "startIdentity"]); hash(value.id); integer(value.pid);
  if (Number(value.pid) < 1 || Number(value.pid) > 2147483647 || typeof value.startIdentity !== "string"
    || (value.startIdentity !== "unverified" && !knownProcessStart(value.startIdentity))) throw invalid("Continuity process instance is invalid.");
}
const localStart = continuityProcessStartIdentity(process.pid) ?? "unverified";
export function continuityProcessInstance(id = randomBytes(32).toString("hex")): ContinuityProcessInstance {
  hash(id); return { id, pid: process.pid, startIdentity: localStart };
}
export function continuityProcessInstanceStatus(instance: ContinuityProcessInstance): "live" | "exited" | "unverified" {
  validateProcess(instance);
  if (!knownProcessStart(instance.startIdentity)) return "unverified";
  try { process.kill(instance.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "unverified"; }
  const current = continuityProcessStartIdentity(instance.pid);
  return current === null ? "unverified" : current === instance.startIdentity ? "live" : "exited";
}
function safeFile(path: string, maxBytes: number): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw invalid("Continuity recovery file is unsafe or oversized.");
  const encoded = readFileSync(path);
  if (encoded.byteLength > maxBytes) throw invalid("Continuity recovery file is oversized.");
  return JSON.parse(encoded.toString("utf8"));
}
function removeLockOwner(directory: string, owner: string): void {
  try { unlinkSync(join(directory, owner)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { rmdirSync(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
}
/** A nonempty directory is published atomically; an unknown or live owner is never removed. */
export function withContinuityStorageLock<T>(lock: string, operation: () => T): T {
  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const staging = `${lock}.${owner}`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeFileSync(join(staging, owner), JSON.stringify(continuityProcessInstance()), { mode: 0o600, flag: "wx" });
    let acquired = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let stat;
      // Inspect existing evidence before attempting publication. On Windows the
      // publication itself must also refuse replacements during this window.
      try { stat = lstatSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!stat) {
        try {
          if (process.platform === "win32") moveContinuityLockWithoutReplacement(staging, lock);
          else renameSync(staging, lock);
          acquired = true; break;
        }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? "";
          const windowsDenied = process.platform === "win32" && ["EPERM", "EACCES"].includes(code);
          if (!windowsDenied && !["ENOTEMPTY", "EEXIST", "ENOTDIR", "EISDIR"].includes(code)) throw error;
          // Another process can publish between inspection and rename. Only treat
          // access errors as contention when an existing lock can be inspected.
          try { stat = lstatSync(lock); }
          catch (readError) {
            if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
            if (windowsDenied) throw error;
            continue;
          }
        }
      }
      if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0) || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw invalid("Continuity storage is busy or its lock is unsafe.");
      let entries;
      try { entries = readdirSync(lock); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (entries.length !== 1 || !/^[1-9]\d*-[a-f0-9]{32}$/.test(entries[0]!)) throw invalid("Continuity storage is busy or its lock is unverified.");
      const previous = entries[0]!;
      let instance;
      try { instance = safeFile(join(lock, previous), 1024); validateProcess(instance); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw invalid("Continuity storage lock owner cannot be verified."); }
      if (instance.pid !== Number(previous.split("-")[0]) || continuityProcessInstanceStatus(instance) !== "exited") throw invalid("Continuity storage is busy; the lock owner has not verifiably exited.");
      removeLockOwner(lock, previous);
    }
    if (!acquired) throw invalid("Continuity storage is busy; ownership changed during acquisition.");
    try { return operation(); } finally { removeLockOwner(lock, owner); }
  } finally { removeLockOwner(staging, owner); }
}
function syncStoredFile(path: string): void {
  // Windows FlushFileBuffers requires write access; r+ preserves existing bytes.
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") { const directoryFd = openSync(join(path, ".."), "r"); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } }
}
function durableWrite(path: string, encoded: string, afterAtomicReplace?: () => void): void {
  atomicWriteFile(path, encoded, { durable: true });
  afterAtomicReplace?.();
  // The rename and its containing directory must survive a machine interruption too.
  if (process.platform !== "win32") { const fd = openSync(join(path, ".."), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
}
function validateAttempt(value: unknown): asserts value is RecoveryAttemptRecord {
  exact(value, ["attempt", "epoch", "historyRevision", "snapshotVersion", "snapshotDigest", "stage", "dispatchProtocolComplete", "writerRetired"], ["pageReceiptId", "transactionId", "transactionVersion", "launcherInstance"]);
  for (const key of ["attempt", "epoch", "historyRevision", "snapshotVersion"]) integer(value[key]); hash(value.snapshotDigest);
  oneOf(value.stage, ["prepared", "page-possible", "page-acquired", "send-possible", "accepted", "interrupted-settled", "completed", "stopped"]);
  boolean(value.dispatchProtocolComplete); boolean(value.writerRetired); optionalIdentity(value.pageReceiptId); optionalIdentity(value.transactionId);
  if (value.transactionVersion !== undefined) integer(value.transactionVersion);
  if (value.launcherInstance !== undefined) validateLauncherInstance(value.launcherInstance);
}
function validateTarget(value: unknown, checkpoint = false): asserts value is RecoveryCompactionTarget {
  exact(value, ["compactionTargetId", "sourceLogicalWorkId", "workLineageId", "acceptedTaskRevision", "sourceHistoryRevision", "sourceToolBatchHeadSequence", "sourceIdentity", "representationDigests", "checkpointBytes", ...(checkpoint ? ["commitId", "targetHistoryRevision", "summaryDigest", "coveredCallIds", "continuation", "retainedBodyBytes"] : [])], checkpoint ? ["ordinaryFinalReceiptId"] : []);
  for (const key of ["compactionTargetId", "sourceLogicalWorkId", "workLineageId", "sourceIdentity"]) identity(value[key]);
  for (const key of ["acceptedTaskRevision", "sourceHistoryRevision", "sourceToolBatchHeadSequence"]) integer(value[key]);
  integer(value.checkpointBytes);
  if (!Array.isArray(value.representationDigests) || value.representationDigests.length > 512) throw invalid("Continuity compaction representations are invalid.");
  value.representationDigests.forEach(hash);
  if (checkpoint) {
    identity(value.commitId); integer(value.targetHistoryRevision); hash(value.summaryDigest); optionalIdentity(value.ordinaryFinalReceiptId); integer(value.retainedBodyBytes);
    if (!Array.isArray(value.coveredCallIds)) throw invalid("Continuity checkpoint coverage is invalid."); value.coveredCallIds.forEach(identity);
    exact(value.continuation, ["state"], ["nativeTurnId", "consumerLogicalWorkId"]); oneOf(value.continuation.state, ["available", "consumed"]);
    optionalIdentity(value.continuation.nativeTurnId); optionalIdentity(value.continuation.consumerLogicalWorkId);
    if ((value.continuation.state === "consumed") !== (value.continuation.consumerLogicalWorkId !== undefined)) throw invalid("Continuity continuation consumer is invalid.");
  }
}
function validateTransaction(value: unknown): asserts value is RecoveryTransactionRecord {
  exact(value, ["transactionId", "version", "sourceEpoch", "targetEpoch", "logicalWorkId", "attempt", "snapshotVersion", "snapshotDigest", "stage", "writerRetired", "toolsSettled"], ["pageReceiptId", "launcherInstance"]);
  for (const field of ["transactionId", "logicalWorkId"]) identity(value[field]); optionalIdentity(value.pageReceiptId); hash(value.snapshotDigest);
  for (const field of ["version", "sourceEpoch", "targetEpoch", "attempt", "snapshotVersion"]) integer(value[field]);
  oneOf(value.stage, ["prepared", "page-possible", "page-acquired", "send-possible", "accepted", "interrupted-settled", "completed", "stopped"]);
  boolean(value.writerRetired); boolean(value.toolsSettled); if (value.launcherInstance !== undefined) validateLauncherInstance(value.launcherInstance);
}
function validatePreparation(value: unknown): asserts value is RecoveryPendingPreparation {
  exact(value, ["preparationId", "expected", "target"]); hash(value.preparationId);
  for (const tag of [value.expected, value.target]) { exact(tag, ["owner", "transaction"]); validateProcess(tag.owner); validateTransaction(tag.transaction); }
  const pending = value as unknown as RecoveryPendingPreparation;
  const before = pending.expected.transaction; const target = pending.target.transaction;
  if (!["prepared", "page-possible", "page-acquired"].includes(before.stage) || before.writerRetired || !before.launcherInstance
    || target.transactionId !== before.transactionId || target.logicalWorkId !== before.logicalWorkId || target.attempt !== before.attempt
    || target.sourceEpoch !== before.sourceEpoch || target.targetEpoch !== before.targetEpoch
    || target.version !== before.version + 1 || target.snapshotVersion !== before.snapshotVersion + 1 || target.stage !== "prepared"
    || target.writerRetired || !target.toolsSettled || target.pageReceiptId !== undefined || !sameLauncher(before.launcherInstance, target.launcherInstance)) throw invalid("Preparation must retain one exact previous authorization and one adjacent unsent target.");
}
function validateThread(value: unknown): asserts value is RecoveryThreadRecord {
  exact(value, ["thread", "scope", "version", "epoch", "historyRevision", "owner", "state", "legacyUnproven", "works", "lineages", "calls", "compactionTargets", "checkpoints"], ["currentWorkId", "transaction", "pendingPreparation", "preparationReceipt", "retiredPreparation"]);
  hash(value.thread); hash(value.scope); validateProcess(value.owner); boolean(value.legacyUnproven);
  for (const key of ["version", "epoch", "historyRevision"]) integer(value[key]); optionalIdentity(value.currentWorkId);
  oneOf(value.state, ["creating", "running", "ready", "compacting", "unverified", "lost", "recovering", "stopped"]);
  for (const key of ["works", "lineages", "calls", "compactionTargets", "checkpoints"]) dictionary(value[key]);
  for (const [key, work] of Object.entries(value.works as Record<string, unknown>)) {
    identity(key); exact(work, ["logicalWorkId", "instructionIdentity", "workPayloadDigest", "purpose", "state", "workLineageId", "acceptedTaskRevision", "attempts"], ["nativeTurnId", "predecessorLogicalWorkId", "retryBudget", "terminalReceiptId", "terminalDigest", "stopReason", "compactionTargetId", "instructionPrevious", "allowRetainedSourceFallback", "activationState"]);
    for (const field of ["logicalWorkId", "instructionIdentity", "workLineageId"]) identity(work[field]); hash(work.workPayloadDigest); integer(work.acceptedTaskRevision);
    if (key !== work.logicalWorkId) throw invalid("Continuity work index does not match.");
    for (const field of ["nativeTurnId", "predecessorLogicalWorkId", "terminalReceiptId", "compactionTargetId"]) optionalIdentity(work[field]); optionalHash(work.terminalDigest);
    oneOf(work.purpose, ["ordinary", "compaction"]); oneOf(work.state, ["prepared", "send-possible", "active", "completed", "stopped"]);
    validateInstructionPrevious(work.instructionPrevious); if (work.allowRetainedSourceFallback !== undefined) boolean(work.allowRetainedSourceFallback);
    if (work.activationState !== undefined) {
      oneOf(work.activationState, ["shadow", "active"]);
      if (work.purpose !== "compaction") throw invalid("Only compaction may have a shadow activation state.");
    }
    if (work.stopReason !== undefined) oneOf(work.stopReason, ["user-stop", "mode-exit", "page-close", "native-interrupt"]);
    if (!Array.isArray(work.attempts) || work.attempts.length === 0 || work.attempts.length > 512) throw invalid("Continuity work attempts are invalid.");
    work.attempts.forEach((attempt, i) => { validateAttempt(attempt); if (attempt.attempt !== i) throw invalid("Continuity attempt sequence is invalid."); });
    if (work.retryBudget !== undefined) { exact(work.retryBudget, ["attempts", "startedAt"], ["lastFailureAt"]); integer(work.retryBudget.attempts); integer(work.retryBudget.startedAt); if (work.retryBudget.lastFailureAt !== undefined) integer(work.retryBudget.lastFailureAt); }
  }
  for (const [key, lineage] of Object.entries(value.lineages as Record<string, unknown>)) {
    identity(key); exact(lineage, ["rootLogicalWorkId", "headLogicalWorkId", "acceptedTaskRevision", "toolBatchHeadSequence", "taskMappings", "batchMappings"]);
    identity(lineage.rootLogicalWorkId); identity(lineage.headLogicalWorkId); integer(lineage.acceptedTaskRevision); integer(lineage.toolBatchHeadSequence); mapping(lineage.taskMappings); mapping(lineage.batchMappings);
  }
  for (const [key, call] of Object.entries(value.calls as Record<string, unknown>)) {
    identity(key); exact(call, ["callId", "operationId", "expectedResultType", "logicalWorkId", "workLineageId", "attempt", "batchSequence", "state"], ["firstResultDigest", "resultBodyBytes", "resultBodyOwner"]);
    for (const field of ["callId", "operationId", "expectedResultType", "logicalWorkId", "workLineageId"]) identity(call[field]); integer(call.attempt); integer(call.batchSequence);
    if (key !== call.callId) throw invalid("Continuity call index does not match.");
    oneOf(call.state, ["queued", "delivery-possible", "settled", "cancelled-before-delivery"]); optionalHash(call.firstResultDigest);
    if ((call.state === "settled") !== (call.firstResultDigest !== undefined)) throw invalid("Continuity call settlement receipt is invalid.");
    if (call.resultBodyBytes !== undefined || call.resultBodyOwner !== undefined) {
      integer(call.resultBodyBytes); validateProcess(call.resultBodyOwner);
      if (call.resultBodyBytes === 0 || call.state !== "settled") throw invalid("Optional result body accounting requires a settled real result and positive bytes.");
    }
  }
  for (const [key, target] of Object.entries(value.compactionTargets as Record<string, unknown>)) { validateTarget(target); if (target.compactionTargetId !== key) throw invalid("Continuity target index does not match."); }
  for (const [key, checkpoint] of Object.entries(value.checkpoints as Record<string, unknown>)) { validateTarget(checkpoint, true); if ((checkpoint as unknown as RecoveryCheckpointRecord).commitId !== key) throw invalid("Continuity commit index does not match."); }
  if (value.transaction !== undefined) validateTransaction(value.transaction);
  const thread = value as unknown as RecoveryThreadRecord;
  for (const work of Object.values(thread.works)) {
    const lineage = thread.lineages[work.workLineageId];
    if (!lineage || !thread.works[lineage.rootLogicalWorkId] || !thread.works[lineage.headLogicalWorkId]
      || work.acceptedTaskRevision > lineage.acceptedTaskRevision || !thread.works[work.predecessorLogicalWorkId ?? work.logicalWorkId]
      || work.attempts.some(attempt => attempt.epoch > thread.epoch || attempt.historyRevision > thread.historyRevision)) throw invalid("Continuity work lineage is incomplete.");
    if (work.activationState === "shadow" && (!work.compactionTargetId || !thread.compactionTargets[work.compactionTargetId]
      || work.attempts.length !== 1 || !work.attempts[0]!.transactionId || work.attempts[0]!.transactionVersion === undefined
      || thread.currentWorkId === work.logicalWorkId || thread.transaction?.logicalWorkId === work.logicalWorkId)) throw invalid("A shadow compaction cannot own the current writer or page transaction.");
  }
  for (const call of Object.values(thread.calls)) {
    const work = thread.works[call.logicalWorkId];
    if (!work || work.workLineageId !== call.workLineageId || !work.attempts[call.attempt]
      || call.batchSequence > thread.lineages[call.workLineageId]!.toolBatchHeadSequence) throw invalid("Continuity issued-call relation is incomplete.");
  }
  const operationIds = new Set<string>();
  for (const call of Object.values(thread.calls)) {
    const key = JSON.stringify([call.logicalWorkId, call.attempt, call.operationId]);
    if (operationIds.has(key)) throw invalid("Continuity operation has multiple issued-call admissions."); operationIds.add(key);
  }
  for (const checkpoint of Object.values(thread.checkpoints)) {
    if (!thread.compactionTargets[checkpoint.compactionTargetId] || checkpoint.targetHistoryRevision > thread.historyRevision
      || checkpoint.targetHistoryRevision <= checkpoint.sourceHistoryRevision
      || checkpoint.coveredCallIds.some(id => thread.calls[id]?.state !== "settled" || thread.calls[id]?.workLineageId !== checkpoint.workLineageId)
      || checkpoint.continuation.consumerLogicalWorkId && !thread.works[checkpoint.continuation.consumerLogicalWorkId]) throw invalid("Continuity checkpoint relation is incomplete.");
  }
  if (thread.currentWorkId && !thread.works[thread.currentWorkId]) throw invalid("Continuity current work is missing.");
  if (thread.transaction) {
    const tx = thread.transaction; const attempt = thread.works[tx.logicalWorkId]?.attempts[tx.attempt];
    if (!attempt || tx.targetEpoch !== attempt.epoch || tx.snapshotVersion !== attempt.snapshotVersion || tx.snapshotDigest !== attempt.snapshotDigest
      || tx.stage !== attempt.stage || tx.transactionId !== attempt.transactionId || tx.version !== attempt.transactionVersion
      || !sameLauncher(tx.launcherInstance, attempt.launcherInstance)) throw invalid("Continuity transaction and snapshot do not match.");
  }
  if (thread.pendingPreparation) {
    const pending = thread.pendingPreparation; validatePreparation(pending);
    const before = pending.expected.transaction; const target = pending.target.transaction; const work = thread.works[before.logicalWorkId];
    if (!work || thread.currentWorkId !== before.logicalWorkId || !sameProcess(thread.owner, pending.expected.owner)
      || !sameTransaction(thread.transaction, before, true) || before.attempt !== work.attempts.length - 1
      || !["prepared", "page-possible", "page-acquired", "stopped"].includes(work.attempts.at(-1)!.stage)
      || target.targetEpoch !== thread.epoch) throw invalid("Pending preparation must retain the exact previous authorization and one adjacent unsent target.");
  }
  if (thread.preparationReceipt) {
    const receipt = thread.preparationReceipt; exact(receipt, ["preparationId", "target"]); hash(receipt.preparationId);
    exact(receipt.target, ["owner", "transaction"]); validateProcess(receipt.target.owner); validateTransaction(receipt.target.transaction);
    const target = receipt.target.transaction; const attempt = thread.works[target.logicalWorkId]?.attempts[target.attempt];
    if (!attempt || target.targetEpoch !== attempt.epoch || target.transactionId !== attempt.transactionId
      || target.version > attempt.transactionVersion! || target.snapshotVersion > attempt.snapshotVersion
      || target.stage !== "prepared" || target.writerRetired || !target.toolsSettled || target.pageReceiptId !== undefined
      || !target.launcherInstance) throw invalid("Preparation completion receipt has no retained unsent authorization.");
  }
  if (thread.retiredPreparation) {
    const retired = thread.retiredPreparation; validatePreparation(retired);
    const before = retired.expected.transaction; const work = thread.works[before.logicalWorkId]; const attempt = work?.attempts[before.attempt];
    if (work?.state !== "stopped" || !attempt || !attempt.writerRetired || before.targetEpoch !== attempt.epoch
      || before.transactionId !== attempt.transactionId || before.version !== attempt.transactionVersion
      || before.snapshotVersion !== attempt.snapshotVersion || before.snapshotDigest !== attempt.snapshotDigest
      || !sameLauncher(before.launcherInstance, attempt.launcherInstance)) throw invalid("Retired preparation must preserve its exact stopped work identity.");
  }
}
function terminal(work: RecoveryWorkRecord): boolean { return work.state === "completed" || work.state === "stopped"; }
function currentCompactionSource(record: RecoveryThreadRecord, work: RecoveryWorkRecord, allowCommittedCurrent = false): RecoveryWorkRecord {
  const target = work.compactionTargetId ? record.compactionTargets[work.compactionTargetId] : undefined;
  const source = target ? record.works[target.sourceLogicalWorkId] : undefined;
  const lineage = source ? record.lineages[source.workLineageId] : undefined;
  const current = record.currentWorkId ? record.works[record.currentWorkId] : undefined;
  const committed = current?.terminalReceiptId ? record.checkpoints[current.terminalReceiptId] : undefined;
  const currentSource = current?.logicalWorkId === source?.logicalWorkId || allowCommittedCurrent && current?.purpose === "compaction"
    && current.state === "completed" && committed?.sourceLogicalWorkId === source?.logicalWorkId
    && committed?.workLineageId === source?.workLineageId && committed?.targetHistoryRevision === record.historyRevision;
  if (!target || !source || !lineage || work.purpose !== "compaction" || source.purpose !== "ordinary" || source.state === "stopped"
    || !currentSource || lineage.headLogicalWorkId !== source.logicalWorkId
    || work.workLineageId !== source.workLineageId || work.acceptedTaskRevision !== target.acceptedTaskRevision
    || target.acceptedTaskRevision !== source.acceptedTaskRevision || target.sourceHistoryRevision !== record.historyRevision
    || target.sourceToolBatchHeadSequence !== lineage.toolBatchHeadSequence) throw unproven("The shadow compaction does not own the current accepted source and stable target boundary.");
  return source;
}
function proveCompactionActivation(record: RecoveryThreadRecord, work: RecoveryWorkRecord): void {
  currentCompactionSource(record, work);
  const activatedAttempt = work.attempts.at(-1)!;
  if (activatedAttempt.epoch !== record.epoch || activatedAttempt.historyRevision !== record.historyRevision) throw unproven("The shadow compaction attempt belongs to an old page or history version.");
  for (const related of Object.values(record.works)) {
    if (related.workLineageId !== work.workLineageId) continue;
    if (related.attempts.some(attempt => !attempt.dispatchProtocolComplete || attempt !== activatedAttempt && !attempt.writerRetired)) throw unproven("Compaction activation requires all previous lineage writers to be proved retired.");
  }
  if (Object.values(record.calls).some(call => call.workLineageId === work.workLineageId && !["settled", "cancelled-before-delivery"].includes(call.state))) throw unproven("Compaction activation requires real settlement of every issued source tool call.");
}
function transition(previous: RecoveryThreadRecord, next: RecoveryThreadRecord): void {
  if (previous.thread !== next.thread || previous.scope !== next.scope || next.epoch < previous.epoch || next.historyRevision < previous.historyRevision
    || previous.legacyUnproven && !next.legacyUnproven) throw unproven("Durable identity or unproved legacy evidence cannot be replaced.");
  const pending = previous.pendingPreparation;
  if (pending) {
    if (next.pendingPreparation) {
      if (JSON.stringify(next.pendingPreparation) !== JSON.stringify(pending) || !sameProcess(previous.owner, next.owner)
        || !sameTransaction(previous.transaction, next.transaction, true) || next.epoch !== previous.epoch || next.historyRevision !== previous.historyRevision
        || Object.keys(next.works).length !== Object.keys(previous.works).length) throw unproven("Pending preparation must retain both exact authorizations until confirmed or stopped.");
      const before = previous.works[pending.expected.transaction.logicalWorkId]!.attempts.at(-1)!;
      const after = next.works[pending.expected.transaction.logicalWorkId]!.attempts.at(-1)!;
      if (after.stage !== before.stage && after.stage !== "stopped") throw unproven("Pending preparation cannot acquire, send or gain new execution authority.");
    } else {
      const retired = JSON.stringify(next.retiredPreparation) === JSON.stringify(pending) && next.works[pending.expected.transaction.logicalWorkId]!.state === "stopped"
        && sameProcess(previous.owner, next.owner) && sameTransaction(previous.transaction, next.transaction);
      if (!retired && (!sameProcess(next.owner, pending.target.owner) || !sameTransaction(next.transaction, pending.target.transaction)
        || next.preparationReceipt?.preparationId !== pending.preparationId)) throw unproven("Only exact target preparation confirmation or stopped retirement may resolve pending authorization.");
    }
  } else if (next.pendingPreparation && (!sameProcess(previous.owner, next.owner) || !sameTransaction(previous.transaction, next.transaction))) throw unproven("Preparation reservation cannot replace the only previous authorization.");
  if (JSON.stringify(previous.preparationReceipt) !== JSON.stringify(next.preparationReceipt)
    && (!pending || next.pendingPreparation || next.preparationReceipt?.preparationId !== pending.preparationId)) throw unproven("Preparation receipt may advance only with its exact pending target confirmation.");
  if (JSON.stringify(previous.retiredPreparation) !== JSON.stringify(next.retiredPreparation)
    && (!pending || next.pendingPreparation || JSON.stringify(next.retiredPreparation) !== JSON.stringify(pending))) throw unproven("Retired preparation receipt must preserve the complete stopped migration.");
  if (next.historyRevision > previous.historyRevision) {
    const commits = Object.values(next.checkpoints).filter(commit => !previous.checkpoints[commit.commitId]);
    if (commits.length !== 1 || next.historyRevision !== previous.historyRevision + 1 || commits[0]!.targetHistoryRevision !== next.historyRevision) throw unproven("Only one successful checkpoint can advance historyRevision.");
  }
  for (const [id, old] of Object.entries(previous.works)) {
    const work = next.works[id];
    if (!work) throw unproven("A retained work identity cannot be removed to obtain new execution rights.");
    for (const field of ["logicalWorkId", "instructionIdentity", "nativeTurnId", "workPayloadDigest", "purpose", "workLineageId", "acceptedTaskRevision", "predecessorLogicalWorkId", "compactionTargetId"] as const) {
      if (old[field] !== work[field]) throw unproven("The current accepted work payload or lineage conflicts with its durable identity.");
    }
    if (!sameInstructionSelection(old, work)) throw unproven("The accepted instruction source selection cannot be replaced.");
    if (old.activationState !== work.activationState) {
      if (old.activationState !== "shadow" || work.activationState !== "active") throw unproven("Compaction shadow activation cannot be reset or invented.");
      proveCompactionActivation(previous, old);
    }
    if (old.activationState === "shadow" && work.activationState === "shadow" && work.state === "completed") throw unproven("An unactivated shadow control cannot commit a checkpoint or ordinary final receipt.");
    if (terminal(old) && JSON.stringify(old) !== JSON.stringify(work)) throw unproven("A completed or stopped work cannot be revived or changed.");
    if (work.attempts.length < old.attempts.length) throw unproven("Attempt evidence cannot be removed.");
    old.attempts.forEach((before, i) => {
      const after = work.attempts[i]!;
      if (before.epoch !== after.epoch || before.historyRevision !== after.historyRevision || before.attempt !== after.attempt
        || before.dispatchProtocolComplete && !after.dispatchProtocolComplete || before.writerRetired && !after.writerRetired) throw unproven("Attempt evidence cannot be weakened.");
      const sent = ["send-possible", "accepted", "interrupted-settled", "completed", "stopped"].includes(before.stage);
      if (sent && (before.snapshotDigest !== after.snapshotDigest || before.snapshotVersion !== after.snapshotVersion
        || ["prepared", "page-possible", "page-acquired"].includes(after.stage))) throw unproven("A possibly sent snapshot cannot be rebound.");
      if (["interrupted-settled", "completed", "stopped"].includes(before.stage) && JSON.stringify(before) !== JSON.stringify(after)) throw unproven("A retired physical attempt cannot be changed.");
      if (after.snapshotVersion < before.snapshotVersion || before.snapshotDigest !== after.snapshotDigest && after.snapshotVersion !== before.snapshotVersion + 1) throw unproven("Snapshot rebinding requires a new monotonically increasing version.");
      if (!sameLauncher(before.launcherInstance, after.launcherInstance)) {
        if (before.launcherInstance && (after.launcherInstance || after.snapshotVersion !== before.snapshotVersion + 1 || sent)
          || !before.launcherInstance && after.launcherInstance && !["prepared", "page-possible"].includes(before.stage)) throw unproven("Launcher acquisition identity cannot be invented after acquisition or replaced on an existing snapshot.");
      }
    });
  }
  for (const [id, before] of Object.entries(previous.calls)) {
    const after = next.calls[id];
    if (!after) throw unproven("Issued-call evidence cannot be removed.");
    for (const field of ["callId", "operationId", "expectedResultType", "logicalWorkId", "workLineageId", "attempt", "batchSequence"] as const) if (before[field] !== after[field]) throw unproven("Issued-call identity cannot be reassigned.");
    if (before.firstResultDigest !== undefined && before.firstResultDigest !== after.firstResultDigest) throw unproven("The first accepted tool result cannot be replaced.");
    if (before.state === "delivery-possible" && ["queued", "cancelled-before-delivery"].includes(after.state)
      || before.state === "queued" && after.state === "settled"
      || ["settled", "cancelled-before-delivery"].includes(before.state) && JSON.stringify({ ...before, resultBodyBytes: undefined, resultBodyOwner: undefined }) !== JSON.stringify({ ...after, resultBodyBytes: undefined, resultBodyOwner: undefined })) throw unproven("An issued tool call cannot be replayed or treated as undelivered.");
    if (before.resultBodyOwner && !sameProcess(before.resultBodyOwner, after.resultBodyOwner)
      && after.resultBodyOwner && continuityProcessInstanceStatus(before.resultBodyOwner) !== "exited") throw unproven("A live or unverified result cache owner cannot be replaced.");
  }
  for (const [id, call] of Object.entries(next.calls)) {
    if (previous.calls[id]) continue;
    if (previous.pendingPreparation || next.pendingPreparation) throw unproven("Pending preparation cannot dispatch new calls.");
    const work = next.works[call.logicalWorkId]!; const attempt = work.attempts[call.attempt]!;
    if (work.purpose !== "ordinary" || terminal(work) || attempt.writerRetired || !attempt.dispatchProtocolComplete
      || attempt.epoch !== next.epoch || call.attempt !== work.attempts.length - 1 || !["queued", "delivery-possible"].includes(call.state)) throw unproven("A new issued call requires the current complete dispatch authority.");
  }
  for (const [id, before] of Object.entries(previous.checkpoints)) {
    const after = next.checkpoints[id];
    if (!after || JSON.stringify({ ...before, continuation: undefined, retainedBodyBytes: undefined }) !== JSON.stringify({ ...after, continuation: undefined, retainedBodyBytes: undefined })
      || after.retainedBodyBytes > before.retainedBodyBytes
      || before.continuation.state === "consumed" && JSON.stringify(before.continuation) !== JSON.stringify(after.continuation)) throw unproven("A checkpoint or consumed continuation cannot be replaced.");
  }
  for (const [id, before] of Object.entries(previous.lineages)) {
    const after = next.lineages[id];
    if (!after || after.rootLogicalWorkId !== before.rootLogicalWorkId || after.acceptedTaskRevision < before.acceptedTaskRevision
      || after.toolBatchHeadSequence < before.toolBatchHeadSequence) throw unproven("Lineage sequences cannot be reset.");
    for (const name of ["taskMappings", "batchMappings"] as const) for (const [key, number] of Object.entries(before[name])) if (after[name][key] !== number) throw unproven("A local-to-durable sequence mapping cannot be replaced.");
  }
  for (const [id, before] of Object.entries(previous.compactionTargets)) {
    const after = next.compactionTargets[id];
    if (!after || JSON.stringify({ ...before, representationDigests: undefined }) !== JSON.stringify({ ...after, representationDigests: undefined })
      || before.representationDigests.some(representation => !after.representationDigests.includes(representation))) throw unproven("A stable compaction target or its accepted representation cannot be replaced.");
  }
}

/** Content-free recovery admission evidence. This store never creates or revives Native operations. */
export class ContinuityRecoveryStore {
  private readonly file: string;
  private readonly marker: string;
  private readonly lock: string;
  private readonly now: () => number;
  private readonly limits: Required<NonNullable<RecoveryStoreOptions["limits"]>>;
  constructor(readonly directory: string, private readonly options: RecoveryStoreOptions = {}) {
    this.file = join(directory, "recovery.json"); this.marker = join(directory, "recovery-initialized.json"); this.lock = join(directory, "recovery.write.lock");
    this.now = options.now ?? Date.now;
    this.limits = { totalBytes: MAX_CONTINUITY_RECOVERY_BYTES, itemBytes: MAX_CONTINUITY_RECOVERY_ITEM_BYTES,
      checkpoints: MAX_CONTINUITY_RECOVERY_CHECKPOINTS, tombstones: MAX_CONTINUITY_RECOVERY_TOMBSTONES, rounds: MAX_CONTINUITY_RECOVERY_ROUNDS, ...options.limits };
  }
  /** Controlled setup/upgrade only. v1 registrations are retained as legacy-unproven. */
  initialize(): void {
    if (arguments.length) throw invalid("Continuity migration must read its complete registration snapshot under its own lock.");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    withContinuityStorageLock(join(this.directory, "write.lock"), () => this.exclusive(() => {
      const installation = this.installation();
      const registrationMarker = safeFile(join(this.directory, "initialized.json"), 1024) as { version: 1; installation: string; recoveryVersion?: 2 };
      const registry = safeFile(join(this.directory, "threads.json"), 4 * 1024 * 1024);
      exact(registry, ["version", "installation", "entries"]); dictionary(registry.entries);
      if (registry.version !== 1 || registry.installation !== installation || Object.keys(registry.entries).length > MAX_THREADS) throw invalid("Continuity registration installation is invalid.");
      for (const [thread, entry] of Object.entries(registry.entries)) {
        hash(thread); exact(entry, ["scope", "owner", "state"], ["epoch", "transactionId"]);
        hash(entry.scope); hash(entry.owner); oneOf(entry.state, ["entered", "lost", "ended"]);
        if (entry.epoch !== undefined) integer(entry.epoch); optionalHash(entry.transactionId);
      }
      if (existsSync(this.marker)) {
        this.read();
        if (registrationMarker.recoveryVersion !== 2) { this.options.beforeWrite?.(); durableWrite(join(this.directory, "initialized.json"), JSON.stringify({ ...registrationMarker, recoveryVersion: 2 })); }
        return;
      }
      if (existsSync(this.file)) throw invalid("Continuity recovery initialization is incomplete; existing evidence was not replaced.");
      if (registrationMarker.recoveryVersion === 2) throw invalid("Previously initialized recovery evidence is missing; it was not reset.");
      const document: RecoveryDocument = { version: 2, installation, threads: {} };
      for (const [thread, value] of Object.entries(registry.entries)) {
        const entry = value as { scope: string; owner: string; state: string };
        hash(thread); hash(entry.scope); hash(entry.owner);
        document.threads[thread] = { thread, scope: entry.scope, version: 0, epoch: 0, historyRevision: 0,
          owner: { id: entry.owner, pid: process.pid, startIdentity: "unverified" }, state: entry.state === "ended" ? "stopped" : "lost",
          legacyUnproven: true, works: {}, lineages: {}, calls: {}, compactionTargets: {}, checkpoints: {} };
      }
      this.checkCapacity(document);
      // Persist migration intent in the original format marker first. Any crash or
      // loss of the later journal files must remain an incomplete upgrade, never v1.
      this.options.beforeWrite?.(); durableWrite(join(this.directory, "initialized.json"), JSON.stringify({ ...registrationMarker, recoveryVersion: 2 }));
      this.options.beforeWrite?.();
      durableWrite(this.marker, JSON.stringify({ version: 2, installation }));
      this.write(document);
    }));
  }
  installationId(): string { this.read(); return this.installation(); }
  get(thread: string): RecoveryThreadRecord | undefined { hash(thread); return this.read().threads[thread]; }
  /** Confirm an exact read-back commit after an uncertain rename/sync or lost write receipt. */
  confirmDurable(thread: string, guard: RecoveryGuard): RecoveryThreadRecord {
    hash(thread); hash(guard.scope);
    return this.exclusive(() => {
      const record = this.read().threads[thread]; if (!record) throw unproven("The uncertain commit has no retained thread identity.");
      this.guard(record, guard);
      try { syncStoredFile(this.file); }
      catch { throw invalid("Continuity recovery commit durability remains unverified; no new side effect is permitted."); }
      return structuredClone(record);
    });
  }
  /** Reserve both exact tags before the host CAS; current authority remains the previous tag. */
  beginPreparation(thread: string, guard: RecoveryGuard, input: { logicalWorkId: string; owner: ContinuityProcessInstance; snapshotDigest: string; launcherInstance: ContinuityLauncherInstance }): RecoveryThreadRecord {
    validateProcess(input.owner); hash(input.snapshotDigest); validateLauncherInstance(input.launcherInstance);
    return this.transact(thread, guard, record => {
      const work = this.activeWork(record, input.logicalWorkId); const attempt = work.attempts.at(-1)!; const transaction = record.transaction;
      if (record.pendingPreparation) {
        const target = record.pendingPreparation.target;
        if (target.transaction.logicalWorkId !== input.logicalWorkId || !sameProcess(target.owner, input.owner)
          || target.transaction.snapshotDigest !== input.snapshotDigest || !sameLauncher(target.transaction.launcherInstance, input.launcherInstance)) throw unproven("The previous preparation must complete before a different target can be reserved.");
        return;
      }
      if (record.legacyUnproven || record.currentWorkId !== work.logicalWorkId || !transaction || transaction.logicalWorkId !== work.logicalWorkId
        || transaction.attempt !== attempt.attempt || attempt.writerRetired || !["prepared", "page-possible", "page-acquired"].includes(attempt.stage)
        || !sameLauncher(attempt.launcherInstance, input.launcherInstance)) throw unproven("Preparation coordination requires the exact current unsent page and Launcher instance.");
      if (!sameProcess(record.owner, input.owner) && continuityProcessInstanceStatus(record.owner) !== "exited") throw unproven("The previous preparation owner is still live or cannot be verified retired.");
      this.requireRetired(record, work.workLineageId, attempt); this.requireSettled(record, work.workLineageId);
      const targetTransaction = structuredClone(transaction);
      targetTransaction.version++; targetTransaction.snapshotVersion++; targetTransaction.snapshotDigest = input.snapshotDigest;
      targetTransaction.stage = "prepared"; targetTransaction.writerRetired = false; targetTransaction.toolsSettled = true; delete targetTransaction.pageReceiptId;
      record.pendingPreparation = { preparationId: randomBytes(32).toString("hex"), expected: { owner: structuredClone(record.owner), transaction: structuredClone(transaction) },
        target: { owner: structuredClone(input.owner), transaction: targetTransaction } };
    });
  }
  /** The caller verifies the authenticated exact target/predecessor receipt before completing. */
  completePreparation(thread: string, guard: RecoveryGuard, preparationId: string): RecoveryThreadRecord {
    hash(thread); hash(preparationId);
    return this.exclusive(() => {
      const document = this.read(); const record = document.threads[thread]; if (!record) throw unproven("The preparation thread is not retained."); this.guard(record, guard);
      const pending = record.pendingPreparation;
      if (!pending) {
        const receipt = record.preparationReceipt;
        if (!receipt || receipt.preparationId !== preparationId || !sameProcess(record.owner, receipt.target.owner)
          || !sameTransaction(record.transaction, receipt.target.transaction, true)) throw unproven("The preparation completion receipt does not match current authorization.");
        return structuredClone(record);
      }
      if (pending.preparationId !== preparationId) throw unproven("The preparation completion belongs to another reserved migration.");
      const previous = structuredClone(record); const work = this.activeWork(record, pending.expected.transaction.logicalWorkId); const attempt = work.attempts.at(-1)!;
      if (attempt.writerRetired || !["prepared", "page-possible", "page-acquired"].includes(attempt.stage)) throw unproven("A stopped, retired or possibly sent preparation cannot receive target authority.");
      const target = pending.target.transaction;
      attempt.snapshotVersion = target.snapshotVersion; attempt.snapshotDigest = target.snapshotDigest; attempt.transactionVersion = target.version;
      attempt.stage = target.stage; delete attempt.pageReceiptId;
      if (target.launcherInstance) attempt.launcherInstance = structuredClone(target.launcherInstance); else delete attempt.launcherInstance;
      record.owner = structuredClone(pending.target.owner); record.transaction = structuredClone(target); work.state = "prepared"; record.state = "recovering";
      record.preparationReceipt = { preparationId, target: structuredClone(pending.target) }; delete record.pendingPreparation;
      record.version++; validateThread(record); transition(previous, record); this.write(document); return structuredClone(record);
    });
  }
  /** After exact host retirement, clear a stopped migration fence while retaining both tags. */
  retirePreparation(thread: string, guard: RecoveryGuard, preparationId: string): RecoveryThreadRecord {
    hash(preparationId);
    return this.transact(thread, guard, record => {
      const pending = record.pendingPreparation;
      if (!pending) { if (record.retiredPreparation?.preparationId === preparationId) return; throw unproven("The stopped preparation retirement has no matching migration."); }
      if (pending.preparationId !== preparationId) throw unproven("The preparation retirement belongs to another migration.");
      const work = this.work(record, pending.expected.transaction.logicalWorkId);
      if (work.state !== "stopped" || !work.attempts.at(-1)!.writerRetired) throw unproven("Only an explicitly stopped preparation may resolve by physical retirement.");
      this.requireRetired(record, work.workLineageId); this.requireSettled(record, work.workLineageId);
      record.retiredPreparation = structuredClone(pending); delete record.pendingPreparation;
    });
  }
  /** Import only an exact, still-live local v1 owner's actual in-memory journal.
   * The caller must collect every dispatch entrance before this controlled migration.
   * No empty record or foreign-process assertion can stand in for that evidence.
   */
  adoptLegacyEvidence(thread: string, guard: RecoveryGuard, evidence: RecoveryThreadRecord): RecoveryThreadRecord {
    validateThread(evidence);
    return this.exclusive(() => {
      const document = this.read(); const previous = document.threads[thread];
      if (!previous) throw unproven("The legacy registration is not retained."); this.guard(previous, guard);
      if (!previous.legacyUnproven || evidence.legacyUnproven || evidence.thread !== previous.thread || evidence.scope !== previous.scope
        || evidence.owner.id !== previous.owner.id || evidence.owner.pid !== process.pid || evidence.owner.startIdentity !== localStart
        || continuityProcessInstanceStatus(evidence.owner) !== "live" || !Object.keys(evidence.works).length
        || Object.values(evidence.works).some(work => work.attempts.some(attempt => !attempt.dispatchProtocolComplete))) throw unproven("Legacy admission requires the exact verifiable live local owner and its complete actual dispatch journal.");
      const record = structuredClone(evidence); record.version = previous.version + 1;
      document.threads[thread] = record; this.write(document); return structuredClone(record);
    });
  }
  transact(thread: string, guard: RecoveryGuard, mutate: (record: RecoveryThreadRecord) => void): RecoveryThreadRecord {
    hash(thread); hash(guard.scope);
    return this.exclusive(() => {
      const document = this.read(); const record = document.threads[thread];
      if (!record) throw unproven("The thread has no durable admission evidence."); this.guard(record, guard);
      const previous = structuredClone(record);
      const result: unknown = mutate(record);
      if (result && typeof (result as unknown as { then?: unknown }).then === "function") throw invalid("Continuity recovery transactions must be synchronous.");
      record.version = previous.version + 1; validateThread(record); transition(previous, record); this.write(document);
      return structuredClone(record);
    });
  }
  admitWork(input: AdmitRecoveryWorkInput): RecoveryThreadRecord {
    this.validateAdmission(input);
    return this.exclusive(() => {
      const document = this.read(); let record = document.threads[input.thread]; const previous = record && structuredClone(record);
      if (!record) {
        if (Object.keys(document.threads).length >= MAX_THREADS) throw capacity("Continuity recovery capacity is 10,000 threads.");
        record = { thread: input.thread, scope: input.scope, version: 0, epoch: 0, historyRevision: 0, owner: input.owner, state: "creating", legacyUnproven: false,
          works: {}, lineages: {}, calls: {}, compactionTargets: {}, checkpoints: {} };
        document.threads[input.thread] = record;
      }
      this.guard(record, { scope: input.scope }); this.admit(record, input);
      record.version++; validateThread(record); if (previous) transition(previous, record); this.write(document); return structuredClone(record);
    });
  }
  issueBatch(thread: string, guard: RecoveryGuard, input: { logicalWorkId: string; attempt: number; calls: Array<{ callId: string; operationId: string; expectedResultType: string }>; localSessionId?: string; localBatchId?: string }): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.activeWork(record, input.logicalWorkId); const attempt = this.attempt(work, input.attempt);
      if (attempt.writerRetired || !attempt.dispatchProtocolComplete || work.purpose === "compaction") throw unproven("This attempt has no business tool dispatch authority.");
      if (!input.calls.length) throw invalid("A durable batch must contain a call.");
      const lineage = record.lineages[work.workLineageId]!;
      const key = input.localSessionId && input.localBatchId ? this.mappingKey(input.localSessionId, input.localBatchId) : undefined;
      const oldCalls = input.calls.map(call => record.calls[call.callId]);
      if (oldCalls.some(Boolean)) {
        if (!oldCalls.every((old, i) => old && old.operationId === input.calls[i]!.operationId && old.expectedResultType === input.calls[i]!.expectedResultType
          && old.logicalWorkId === work.logicalWorkId && old.attempt === attempt.attempt)) throw unproven("The issued operation or call identity conflicts with its first admission.");
        return;
      }
      const rounds = new Set(Object.values(record.calls).filter(call => call.logicalWorkId === work.logicalWorkId).map(call => call.batchSequence)).size;
      if (rounds >= this.limits.rounds) throw capacity("The current work has reached 512 tool rounds.");
      if (key && lineage.batchMappings[key] !== undefined) throw unproven("A local batch mapping already belongs to a different durable batch.");
      const batch = ++lineage.toolBatchHeadSequence; if (key) lineage.batchMappings[key] = batch;
      const operations = new Set(Object.values(record.calls).map(call => call.operationId));
      for (const call of input.calls) {
        identity(call.callId); identity(call.operationId); identity(call.expectedResultType);
        if (record.calls[call.callId] || operations.has(call.operationId)) throw unproven("An operation cannot receive a second execution admission."); operations.add(call.operationId);
        record.calls[call.callId] = { ...call, logicalWorkId: work.logicalWorkId, workLineageId: work.workLineageId, attempt: attempt.attempt, batchSequence: batch, state: "queued" };
      }
    });
  }
  markDeliveryPossible(thread: string, guard: RecoveryGuard, callIds: string[]): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      for (const id of callIds) {
        const call = this.call(record, id); const work = this.activeWork(record, call.logicalWorkId); const attempt = this.attempt(work, call.attempt);
        if (attempt.writerRetired || !attempt.dispatchProtocolComplete) throw unproven("The old writer no longer has delivery authority.");
        if (call.state === "queued") call.state = "delivery-possible";
        else if (call.state !== "delivery-possible") throw unproven("A settled or cancelled call cannot be delivered again.");
      }
    });
  }
  acceptResult(thread: string, guard: RecoveryGuard, input: { callId: string; resultType: string; resultDigest: string }): RecoveryThreadRecord {
    hash(input.resultDigest);
    return this.transact(thread, guard, record => {
      const call = this.call(record, input.callId);
      if (call.expectedResultType !== input.resultType) throw unproven("The tool result type does not match its issued call.");
      if (call.firstResultDigest) { if (call.firstResultDigest !== input.resultDigest) throw unproven("The tool result conflicts with the first accepted result."); return; }
      if (call.state !== "delivery-possible") throw unproven("No potentially delivered issued call matches this result.");
      call.state = "settled"; call.firstResultDigest = input.resultDigest;
    });
  }
  /** Reserve optional in-memory result bytes in the same budget as durable terminal evidence. */
  setResultBodyBytes(thread: string, guard: RecoveryGuard, callId: string, bytes: number, owner: ContinuityProcessInstance): boolean {
    integer(bytes); validateProcess(owner);
    if (bytes === 0) throw invalid("A retained result body must have positive byte accounting.");
    try {
      this.transact(thread, guard, record => {
        const call = this.call(record, callId);
        if (call.state !== "settled" || !call.firstResultDigest) throw unproven("Only a real accepted terminal result can retain optional recovery body bytes.");
        if (call.resultBodyOwner && !sameProcess(call.resultBodyOwner, owner)
          && continuityProcessInstanceStatus(call.resultBodyOwner) !== "exited") throw unproven("Another live or unverified process retains this optional result body.");
        call.resultBodyBytes = bytes; call.resultBodyOwner = structuredClone(owner);
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "continuity_resource_capacity") return false;
      throw error;
    }
  }
  /** The caller deletes its real cache entries first. Failed writes retain a conservative charge. */
  releaseResultBodyBytes(thread: string, guard: RecoveryGuard, callIds: string[], owner: ContinuityProcessInstance): RecoveryThreadRecord {
    validateProcess(owner);
    return this.transact(thread, guard, record => {
      for (const id of callIds) {
        const call = this.call(record, id);
        if (!call.resultBodyOwner) continue;
        if (!sameProcess(call.resultBodyOwner, owner)
          && continuityProcessInstanceStatus(call.resultBodyOwner) !== "exited") throw unproven("Only the exact cache owner or a proved exited instance may release result body accounting.");
        delete call.resultBodyBytes; delete call.resultBodyOwner;
      }
    });
  }
  /** Process exit proves its optional memory bodies no longer exist; unknown instances keep their charge. */
  releaseExitedResultBodies(): void {
    this.exclusive(() => {
      const document = this.read(); let changed = false;
      const instances = new Map<string, ReturnType<typeof continuityProcessInstanceStatus>>();
      for (const record of Object.values(document.threads)) {
        const previous = structuredClone(record); let released = false;
        for (const call of Object.values(record.calls)) {
          if (!call.resultBodyOwner) continue;
          const ownerKey = JSON.stringify([call.resultBodyOwner.id, call.resultBodyOwner.pid, call.resultBodyOwner.startIdentity]);
          if (!instances.has(ownerKey)) instances.set(ownerKey, continuityProcessInstanceStatus(call.resultBodyOwner));
          if (instances.get(ownerKey) !== "exited") continue;
          delete call.resultBodyBytes; delete call.resultBodyOwner; released = true;
        }
        if (released) { record.version++; validateThread(record); transition(previous, record); changed = true; }
      }
      if (changed) this.write(document);
    });
  }
  stopWork(thread: string, guard: RecoveryGuard, logicalWorkId: string, reason: NonNullable<RecoveryWorkRecord["stopReason"]>): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      const source = this.work(record, logicalWorkId);
      for (const work of Object.values(record.works)) {
        if (work.workLineageId !== source.workLineageId || terminal(work)) continue;
        work.state = "stopped"; work.stopReason = reason; delete work.retryBudget;
        const attempt = work.attempts.at(-1)!;
        if (!["interrupted-settled", "completed", "stopped"].includes(attempt.stage)) { attempt.stage = "stopped"; attempt.writerRetired = true; this.syncTransaction(record, work, attempt); }
      }
      for (const call of Object.values(record.calls)) if (call.workLineageId === source.workLineageId && call.state === "queued") call.state = "cancelled-before-delivery";
      if (record.currentWorkId && record.works[record.currentWorkId]!.workLineageId === source.workLineageId) record.state = "stopped";
    });
  }
  completeWork(thread: string, guard: RecoveryGuard, logicalWorkId: string, receipt: { receiptId: string; digest: string }): RecoveryThreadRecord {
    identity(receipt.receiptId); hash(receipt.digest);
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.work(record, logicalWorkId);
      if (work.purpose !== "ordinary") throw unproven("A compaction control can complete only through its durable checkpoint commit.");
      if (work.state === "completed") { if (work.terminalReceiptId !== receipt.receiptId || work.terminalDigest !== receipt.digest) throw unproven("The terminal receipt conflicts with its first commit."); return; }
      if (work.state === "stopped") throw unproven("A stopped work cannot complete or resume.");
      this.requireSettled(record, work.workLineageId);
      for (const related of Object.values(record.works)) {
        if (related.workLineageId !== work.workLineageId || related.purpose !== "ordinary" || terminal(related)) continue;
        related.state = "completed"; related.terminalReceiptId = receipt.receiptId; related.terminalDigest = receipt.digest; delete related.retryBudget;
        const attempt = related.attempts.at(-1)!;
        if (attempt.stage !== "interrupted-settled") { attempt.stage = "completed"; attempt.writerRetired = true; this.syncTransaction(record, related, attempt); }
      }
      if (record.currentWorkId && record.works[record.currentWorkId]!.workLineageId === work.workLineageId) record.state = "ready";
    });
  }
  markAttempt(thread: string, guard: RecoveryGuard, input: { logicalWorkId: string; attempt: number; stage: RecoveryAttemptStage; pageReceiptId?: string; transactionVersion?: number; launcherInstance?: ContinuityLauncherInstance }): RecoveryThreadRecord {
    if (input.launcherInstance) validateLauncherInstance(input.launcherInstance);
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.activeWork(record, input.logicalWorkId); const attempt = this.attempt(work, input.attempt);
      if (attempt.attempt !== work.attempts.length - 1 || attempt.epoch !== record.epoch || attempt.writerRetired) throw unproven("A late observer cannot authorize the current attempt.");
      if (input.transactionVersion !== undefined && input.transactionVersion !== attempt.transactionVersion) throw unproven("The page receipt belongs to an old transaction version.");
      const stages: RecoveryAttemptStage[] = ["prepared", "page-possible", "page-acquired", "send-possible", "accepted"];
      if (!stages.includes(input.stage) || stages.indexOf(input.stage) < stages.indexOf(attempt.stage)) throw unproven("Creation or send evidence cannot move backwards.");
      if (work.activationState === "shadow") {
        currentCompactionSource(record, work);
        const sourceInstanceOnly = input.stage === "prepared" && input.launcherInstance !== undefined;
        if ((!sourceInstanceOnly && !["send-possible", "accepted"].includes(input.stage)) || input.pageReceiptId) throw unproven("A shadow control cannot acquire or authorize a replacement page.");
      }
      if (input.launcherInstance) {
        if (attempt.launcherInstance && !sameLauncher(attempt.launcherInstance, input.launcherInstance)) throw unproven("The acquisition receipt belongs to another Launcher instance.");
        if (!attempt.launcherInstance && !["prepared", "page-possible"].includes(attempt.stage)) throw unproven("Launcher identity must be persisted before actual acquisition.");
        attempt.launcherInstance = structuredClone(input.launcherInstance);
      }
      attempt.stage = input.stage; if (input.pageReceiptId) { identity(input.pageReceiptId); attempt.pageReceiptId = input.pageReceiptId; }
      if (input.stage === "send-possible") work.state = "send-possible"; if (input.stage === "accepted") work.state = "active";
      this.syncTransaction(record, work, attempt);
      if (work.activationState !== "shadow") record.state = work.purpose === "compaction" ? "compacting" : "running";
    });
  }
  retireAttempt(thread: string, guard: RecoveryGuard, logicalWorkId: string, number: number): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.work(record, logicalWorkId); const attempt = this.attempt(work, number);
      if (["completed", "stopped", "interrupted-settled"].includes(attempt.stage)) return;
      attempt.writerRetired = true;
      for (const call of Object.values(record.calls)) if (call.logicalWorkId === logicalWorkId && call.attempt === number && call.state === "queued") call.state = "cancelled-before-delivery";
      // Retirement is recorded even while externally delivered tools still need real results.
      if (this.isSettled(record, work.workLineageId)) attempt.stage = "interrupted-settled";
      this.syncTransaction(record, work, attempt); if (work.activationState !== "shadow") record.state = "lost";
    });
  }
  /** Transfer a settled source's authority to its already admitted control; no new attempt or retry. */
  activateCompaction(thread: string, guard: RecoveryGuard, logicalWorkId: string, observed: RecoveryCompactionActivationIdentity): RecoveryThreadRecord {
    integer(observed.attempt); integer(observed.snapshotVersion); identity(observed.transactionId); integer(observed.transactionVersion);
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.activeWork(record, logicalWorkId); const attempt = work.attempts.at(-1)!;
      if (work.purpose !== "compaction" || attempt.attempt !== observed.attempt || attempt.snapshotVersion !== observed.snapshotVersion
        || attempt.transactionId !== observed.transactionId || attempt.transactionVersion !== observed.transactionVersion) throw unproven("The compaction activation receipt belongs to a different admitted attempt or snapshot version.");
      if (work.activationState === "active") {
        if (record.currentWorkId !== logicalWorkId || record.transaction?.transactionId !== observed.transactionId
          || record.transaction.version !== observed.transactionVersion) throw unproven("An old compaction cannot regain current writer authority.");
        return;
      }
      if (work.activationState !== "shadow") throw unproven("This compaction has no admitted shadow control to activate.");
      proveCompactionActivation(record, work);
      work.activationState = "active"; record.currentWorkId = work.logicalWorkId; record.state = attempt.writerRetired ? "lost" : "compacting";
      record.transaction = { transactionId: observed.transactionId, version: observed.transactionVersion, sourceEpoch: attempt.epoch, targetEpoch: attempt.epoch,
        logicalWorkId: work.logicalWorkId, attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion, snapshotDigest: attempt.snapshotDigest,
        stage: attempt.stage, writerRetired: attempt.writerRetired, toolsSettled: this.isSettled(record, work.workLineageId),
        ...(attempt.launcherInstance ? { launcherInstance: structuredClone(attempt.launcherInstance) } : {}),
        ...(attempt.pageReceiptId ? { pageReceiptId: attempt.pageReceiptId } : {}) };
    });
  }
  reserveRecovery(thread: string, guard: RecoveryGuard, input: { logicalWorkId: string; owner: ContinuityProcessInstance; snapshotDigest: string }): RecoveryThreadRecord {
    validateProcess(input.owner); hash(input.snapshotDigest);
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      if (record.legacyUnproven) throw unproven("The old v1 registration has no complete dispatch or stop evidence.");
      const work = this.activeWork(record, input.logicalWorkId); const before = work.attempts.at(-1)!;
      if (record.currentWorkId !== work.logicalWorkId || work.purpose === "ordinary" && record.lineages[work.workLineageId]!.headLogicalWorkId !== work.logicalWorkId) throw unproven("Only the current accepted lineage head can reserve a recovery attempt.");
      if (!before.writerRetired && record.transaction?.logicalWorkId === work.logicalWorkId && ["prepared", "page-possible", "page-acquired"].includes(before.stage)) {
        this.requireRetired(record, work.workLineageId, before);
        if (record.owner.id !== input.owner.id) throw unproven("The existing creation transaction still requires explicit owner coordination."); return;
      }
      if (!before.writerRetired || !before.dispatchProtocolComplete) throw unproven("The old writer or complete dispatch coverage is not proved retired.");
      this.requireRetired(record, work.workLineageId);
      this.requireSettled(record, work.workLineageId);
      if (before.stage !== "interrupted-settled") before.stage = "interrupted-settled";
      this.retry(work); record.owner = structuredClone(input.owner); const sourceEpoch = record.epoch; record.epoch++;
      const next: RecoveryAttemptRecord = { attempt: work.attempts.length, epoch: record.epoch, historyRevision: record.historyRevision,
        snapshotVersion: before.snapshotVersion + 1, snapshotDigest: input.snapshotDigest, stage: "prepared", dispatchProtocolComplete: true, writerRetired: false };
      const previousTransaction = record.transaction?.logicalWorkId === work.logicalWorkId ? record.transaction : undefined;
      work.attempts.push(next); work.state = "prepared"; record.currentWorkId = work.logicalWorkId; record.state = "recovering";
      this.newTransaction(record, work, next, sourceEpoch, previousTransaction);
    });
  }
  rebindSnapshot(thread: string, guard: RecoveryGuard, logicalWorkId: string, snapshotDigest: string): RecoveryThreadRecord {
    hash(snapshotDigest);
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.activeWork(record, logicalWorkId); const attempt = work.attempts.at(-1)!;
      if (!["prepared", "page-possible", "page-acquired"].includes(attempt.stage)) throw unproven("A possibly sent snapshot cannot be rebound.");
      if (work.activationState === "shadow") currentCompactionSource(record, work);
      attempt.snapshotVersion++; attempt.snapshotDigest = snapshotDigest; delete attempt.pageReceiptId; delete attempt.launcherInstance; attempt.stage = "prepared";
      if (record.transaction?.logicalWorkId === logicalWorkId) {
        record.transaction.version++; attempt.transactionVersion = record.transaction.version;
      } else if (work.activationState === "shadow") attempt.transactionVersion = attempt.transactionVersion! + 1;
      this.syncTransaction(record, work, attempt);
    });
  }
  recordFailure(thread: string, guard: RecoveryGuard, logicalWorkId: string): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      const work = this.activeWork(record, logicalWorkId); const now = this.now();
      work.retryBudget ??= { attempts: 1, startedAt: now };
      if (work.retryBudget.attempts === 1 && work.retryBudget.lastFailureAt === undefined) work.retryBudget.startedAt = now;
      work.retryBudget.lastFailureAt = now;
    });
  }
  registerCompactionTarget(thread: string, guard: RecoveryGuard, input: { sourceLogicalWorkId: string; sourceIdentity: string; acceptedTaskRevision?: number; sourceHistoryRevision?: number; sourceToolBatchHeadSequence?: number; representationDigests?: string[]; checkpointBytes?: number }): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const work = this.work(record, input.sourceLogicalWorkId); const lineage = record.lineages[work.workLineageId]!;
      const acceptedTaskRevision = input.acceptedTaskRevision ?? work.acceptedTaskRevision;
      const sourceHistoryRevision = input.sourceHistoryRevision ?? record.historyRevision;
      const sourceToolBatchHeadSequence = input.sourceToolBatchHeadSequence ?? lineage.toolBatchHeadSequence;
      if (acceptedTaskRevision > lineage.acceptedTaskRevision || sourceHistoryRevision > record.historyRevision || sourceToolBatchHeadSequence > lineage.toolBatchHeadSequence) throw unproven("The compaction source is not an accepted durable boundary.");
      const compactionTargetId = digest([work.logicalWorkId, work.workLineageId, acceptedTaskRevision, sourceHistoryRevision, sourceToolBatchHeadSequence]);
      const existing = record.compactionTargets[compactionTargetId];
      if (existing) { if (existing.sourceIdentity !== input.sourceIdentity) throw unproven("The compaction source identity conflicts with its first target."); existing.representationDigests = [...new Set([...existing.representationDigests, ...(input.representationDigests ?? [])])]; return; }
      record.compactionTargets[compactionTargetId] = { compactionTargetId, sourceLogicalWorkId: work.logicalWorkId, workLineageId: work.workLineageId,
        acceptedTaskRevision, sourceHistoryRevision, sourceToolBatchHeadSequence, sourceIdentity: input.sourceIdentity, representationDigests: input.representationDigests ?? [], checkpointBytes: input.checkpointBytes ?? this.limits.itemBytes };
    });
  }
  commitCheckpoint(thread: string, guard: RecoveryGuard, input: { logicalWorkId: string; commitId: string; compactionTargetId: string; summaryDigest: string; coveredCallIds: string[]; ordinaryFinalReceiptId?: string; nativeTurnId?: string; retainedBodyBytes?: number }): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      noPendingPreparation(record);
      const existing = record.checkpoints[input.commitId];
      if (existing) { if (existing.compactionTargetId !== input.compactionTargetId || existing.summaryDigest !== input.summaryDigest) throw unproven("The committed checkpoint conflicts with its first result."); return; }
      if (Object.values(record.checkpoints).some(commit => commit.compactionTargetId === input.compactionTargetId)) throw unproven("This compaction target already has a successful commit.");
      const work = this.activeWork(record, input.logicalWorkId); const target = record.compactionTargets[input.compactionTargetId];
      if (work.purpose !== "compaction" || work.activationState === "shadow" || record.currentWorkId !== work.logicalWorkId
        || !target || work.compactionTargetId !== input.compactionTargetId || target.sourceHistoryRevision !== record.historyRevision) throw unproven("The checkpoint does not match an activated compaction at the selected current history target.");
      const attempt = work.attempts.at(-1)!;
      if (!attempt.writerRetired) throw unproven("Checkpoint success requires physical writer settlement first.");
      this.requireSettled(record, target.workLineageId);
      const coveredCallIds = [...new Set(input.coveredCallIds)];
      if (coveredCallIds.some(id => record.calls[id]?.state !== "settled" || record.calls[id]?.workLineageId !== target.workLineageId || record.calls[id]!.batchSequence > target.sourceToolBatchHeadSequence)) throw unproven("Checkpoint coverage contains an unproved or unsettled tool result.");
      record.historyRevision++;
      record.checkpoints[input.commitId] = { ...structuredClone(target), commitId: input.commitId, targetHistoryRevision: record.historyRevision, summaryDigest: input.summaryDigest, coveredCallIds, retainedBodyBytes: input.retainedBodyBytes ?? 0,
        ...(input.ordinaryFinalReceiptId ? { ordinaryFinalReceiptId: input.ordinaryFinalReceiptId } : {}), continuation: { state: "available", ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}) } };
      work.state = "completed"; work.terminalReceiptId = input.commitId; work.terminalDigest = input.summaryDigest; delete work.retryBudget;
      // An already retired attempt is immutable. The checkpoint is its logical terminal receipt.
      if (attempt.stage !== "interrupted-settled") { attempt.stage = "completed"; this.syncTransaction(record, work, attempt); }
      record.state = "ready";
    });
  }
  consumeContinuation(thread: string, guard: RecoveryGuard, commitId: string, input: AdmitRecoveryWorkInput): RecoveryThreadRecord {
    this.validateAdmission(input);
    return this.transact(thread, guard, record => {
      if (input.thread !== record.thread || input.scope !== record.scope) throw unproven("The continuation consumer belongs to another thread or scope.");
      const checkpoint = record.checkpoints[commitId]; if (!checkpoint) throw unproven("The requested continuation commit is not retained.");
      if (checkpoint.continuation.nativeTurnId && checkpoint.continuation.nativeTurnId !== input.nativeTurnId) throw unproven("The continuation native turn does not match.");
      if (checkpoint.continuation.state === "consumed" && checkpoint.continuation.consumerLogicalWorkId !== input.logicalWorkId) throw unproven("A checkpoint continuation can have only one consumer.");
      this.admit(record, { ...input, continuationCommitId: commitId });
      checkpoint.continuation = { ...checkpoint.continuation, state: "consumed", consumerLogicalWorkId: input.logicalWorkId };
    });
  }
  releaseCheckpointBodies(thread: string, guard: RecoveryGuard, commitIds: string[]): RecoveryThreadRecord {
    return this.transact(thread, guard, record => {
      for (const id of commitIds) { const checkpoint = record.checkpoints[id]; if (!checkpoint) throw unproven("The checkpoint body reservation is not retained."); checkpoint.retainedBodyBytes = 0; }
    });
  }
  requiredCalls(thread: string, logicalWorkId: string, commitId?: string): RecoveryCallRecord[] {
    const record = this.get(thread); if (!record || record.legacyUnproven) throw unproven("Complete durable recovery call membership is unavailable.");
    const work = this.work(record, logicalWorkId);
    if (Object.values(record.works).some(candidate => candidate.workLineageId === work.workLineageId && candidate.attempts.some(attempt => !attempt.dispatchProtocolComplete))) throw unproven("Some dispatch entrances are not covered by durable evidence.");
    const commit = commitId ? record.checkpoints[commitId] : undefined;
    if (commitId && (!commit || commit.workLineageId !== work.workLineageId)) throw unproven("The checkpoint does not cover this recovery lineage.");
    const covered = new Set(commit?.coveredCallIds ?? []);
    return Object.values(record.calls).filter(call => call.workLineageId === work.workLineageId && ["delivery-possible", "settled"].includes(call.state) && !covered.has(call.callId));
  }
  private validateAdmission(input: AdmitRecoveryWorkInput): void {
    hash(input.thread); hash(input.scope); validateProcess(input.owner); identity(input.logicalWorkId); identity(input.instructionIdentity);
    hash(input.workPayloadDigest); hash(input.snapshotDigest); boolean(input.dispatchProtocolComplete);
    optionalIdentity(input.nativeTurnId); optionalIdentity(input.predecessorLogicalWorkId); optionalIdentity(input.continuationCommitId); optionalIdentity(input.compactionTargetId);
    validateInstructionPrevious(input.instructionPrevious); if (input.allowRetainedSourceFallback !== undefined) boolean(input.allowRetainedSourceFallback);
    if (input.activate !== undefined) boolean(input.activate);
    if (input.activate === false && (input.purpose !== "compaction" || input.createPage !== false || input.predecessorLogicalWorkId || input.continuationCommitId
      || !input.compactionTargetId || !input.dispatchProtocolComplete)) throw unproven("Shadow admission is restricted to a proved, tool-free compaction on the current source page.");
  }
  private admit(record: RecoveryThreadRecord, input: AdmitRecoveryWorkInput): void {
    noPendingPreparation(record);
    if (record.legacyUnproven) throw unproven("The old v1 registration has no complete dispatch, submission or stop evidence.");
    const checkpoint = input.continuationCommitId ? record.checkpoints[input.continuationCommitId] : undefined;
    if (input.continuationCommitId && !checkpoint) throw unproven("The continuation commit cannot be proved.");
    if (checkpoint) {
      const source = this.work(record, checkpoint.sourceLogicalWorkId);
      const continuationTurn = checkpoint.continuation.nativeTurnId ?? source.nativeTurnId;
      if (source.purpose !== "ordinary" || (input.purpose ?? "ordinary") !== "ordinary" || input.compactionTargetId !== undefined
        || input.predecessorLogicalWorkId !== undefined || input.instructionIdentity !== source.instructionIdentity
        || input.workPayloadDigest !== source.workPayloadDigest || input.nativeTurnId !== continuationTurn) throw unproven("The checkpoint continuation must preserve its real source instruction identity, payload and recorded native turn.");
      if (checkpoint.continuation.state === "consumed") {
        if (checkpoint.continuation.consumerLogicalWorkId !== input.logicalWorkId) throw unproven("A checkpoint continuation can have only one consumer.");
        if (!record.works[input.logicalWorkId]) throw unproven("The recorded continuation consumer is missing.");
      } else {
        if (record.works[input.logicalWorkId]) throw unproven("A first checkpoint continuation requires a new logical work identity.");
        if (terminal(source) || checkpoint.ordinaryFinalReceiptId) throw unproven("A completed or stopped source cannot allocate a new checkpoint continuation consumer.");
        const current = record.currentWorkId ? record.works[record.currentWorkId] : undefined;
        if (record.lineages[source.workLineageId]!.headLogicalWorkId !== source.logicalWorkId
          || current?.logicalWorkId !== source.logicalWorkId && (current?.purpose !== "compaction" || current.terminalReceiptId !== checkpoint.commitId)) throw unproven("The checkpoint continuation no longer represents the current unfinished instruction.");
        this.requireRetired(record, source.workLineageId); this.requireSettled(record, source.workLineageId);
      }
    }
    const existing = record.works[input.logicalWorkId];
    if (existing) {
      if (existing.instructionIdentity !== input.instructionIdentity || existing.nativeTurnId !== input.nativeTurnId
        || existing.workPayloadDigest !== input.workPayloadDigest || existing.purpose !== (input.purpose ?? "ordinary")
        || existing.compactionTargetId !== input.compactionTargetId || !sameInstructionSelection(existing, input)) throw unproven("The current instruction payload or source selection conflicts with its first acceptance.");
      return;
    }
    const sameIdentity = Object.values(record.works).find(work => work.instructionIdentity === input.instructionIdentity && work.nativeTurnId === input.nativeTurnId
      && work.purpose === (input.purpose ?? "ordinary") && work.compactionTargetId === input.compactionTargetId);
    if (sameIdentity && !checkpoint) throw unproven("An accepted instruction identity cannot obtain another logical work ID.");
    const head = record.currentWorkId ? record.works[record.currentWorkId] : undefined;
    const target = input.compactionTargetId ? record.compactionTargets[input.compactionTargetId] : undefined;
    const predecessor = input.predecessorLogicalWorkId ? this.activeWork(record, input.predecessorLogicalWorkId) : undefined;
    if (input.purpose === "compaction" && !target) throw unproven("Compaction admission requires a retained stable target.");
    if (input.activate === false && record.owner.id !== input.owner.id) throw unproven("A shadow control cannot change the current source owner.");
    if (head && !terminal(head) && !predecessor && !target && !checkpoint) throw unproven("Another current logical work must settle before new admission.");
    if (predecessor && (head?.logicalWorkId !== predecessor.logicalWorkId || record.lineages[predecessor.workLineageId]?.headLogicalWorkId !== predecessor.logicalWorkId)) throw unproven("Append admission must name the actual accepted predecessor head.");
    if (input.createPage && head) {
      const retirementLineage = target?.workLineageId ?? checkpoint?.workLineageId ?? head.workLineageId;
      this.requireRetired(record, retirementLineage); this.requireSettled(record, retirementLineage);
      record.epoch++;
    }
    if (record.owner.id !== input.owner.id) {
      for (const work of Object.values(record.works)) this.requireRetired(record, work.workLineageId);
      for (const work of Object.values(record.works)) this.requireSettled(record, work.workLineageId);
      record.owner = structuredClone(input.owner);
    }
    let lineageId = predecessor?.workLineageId ?? target?.workLineageId ?? checkpoint?.workLineageId ?? input.logicalWorkId;
    let lineage = record.lineages[lineageId];
    if (!lineage) { lineage = { rootLogicalWorkId: input.logicalWorkId, headLogicalWorkId: input.logicalWorkId, acceptedTaskRevision: 0, toolBatchHeadSequence: 0, taskMappings: {}, batchMappings: {} }; record.lineages[lineageId] = lineage; }
    let revision: number;
    if (target) revision = target.acceptedTaskRevision;
    else if (checkpoint) revision = checkpoint.acceptedTaskRevision;
    else revision = ++lineage.acceptedTaskRevision;
    if (input.localSessionId !== undefined && input.localTaskRevision !== undefined) {
      integer(input.localTaskRevision); const key = this.mappingKey(input.localSessionId, String(input.localTaskRevision));
      if (lineage.taskMappings[key] !== undefined && lineage.taskMappings[key] !== revision) throw unproven("The local task revision already maps to another durable acceptance."); lineage.taskMappings[key] = revision;
    }
    const attempt: RecoveryAttemptRecord = { attempt: 0, epoch: record.epoch, historyRevision: record.historyRevision, snapshotVersion: 0,
      snapshotDigest: input.snapshotDigest, stage: "prepared", dispatchProtocolComplete: input.dispatchProtocolComplete, writerRetired: false };
    if (predecessor && input.createPage === false && predecessor.attempts.at(-1)!.launcherInstance) attempt.launcherInstance = structuredClone(predecessor.attempts.at(-1)!.launcherInstance);
    const work: RecoveryWorkRecord = { logicalWorkId: input.logicalWorkId, instructionIdentity: input.instructionIdentity,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}), workPayloadDigest: input.workPayloadDigest,
      purpose: input.purpose ?? "ordinary", state: "prepared", workLineageId: lineageId, acceptedTaskRevision: revision,
      ...(predecessor ? { predecessorLogicalWorkId: predecessor.logicalWorkId } : checkpoint ? { predecessorLogicalWorkId: checkpoint.sourceLogicalWorkId } : {}),
      ...(input.compactionTargetId ? { compactionTargetId: input.compactionTargetId } : {}), attempts: [attempt], retryBudget: { attempts: 1, startedAt: this.now() } };
    if (input.instructionPrevious) work.instructionPrevious = structuredClone(input.instructionPrevious);
    if (input.allowRetainedSourceFallback !== undefined) work.allowRetainedSourceFallback = input.allowRetainedSourceFallback;
    if (work.purpose === "compaction") work.activationState = input.activate === false ? "shadow" : "active";
    if (input.activate === false) {
      currentCompactionSource(record, work);
      if (Object.values(record.works).some(other => other.purpose === "compaction" && !terminal(other) && other.attempts.some(otherAttempt => !otherAttempt.writerRetired))) throw unproven("Another admitted compaction control has not retired.");
      attempt.transactionId = randomBytes(32).toString("hex"); attempt.transactionVersion = 0;
      record.works[work.logicalWorkId] = work;
      return;
    }
    if (work.purpose === "compaction") {
      currentCompactionSource(record, work, true);
      this.requireRetired(record, work.workLineageId); this.requireSettled(record, work.workLineageId);
    }
    record.works[work.logicalWorkId] = work;
    // Compaction does not replace the chain's last actual user acceptance.
    if (!target) lineage.headLogicalWorkId = work.logicalWorkId;
    record.currentWorkId = work.logicalWorkId; record.state = input.purpose === "compaction" ? "compacting" : "running";
    if (input.createPage || !head) record.state = "creating";
    this.newTransaction(record, work, attempt, input.createPage && head ? record.epoch - 1 : record.epoch);
    if (checkpoint) checkpoint.continuation = { ...checkpoint.continuation, state: "consumed", consumerLogicalWorkId: work.logicalWorkId };
  }
  private work(record: RecoveryThreadRecord, id: string): RecoveryWorkRecord { identity(id); const work = record.works[id]; if (!work) throw unproven("The logical work is not retained."); return work; }
  private activeWork(record: RecoveryThreadRecord, id: string): RecoveryWorkRecord {
    const work = this.work(record, id); if (terminal(work)) throw unproven("A completed or stopped logical work cannot receive new execution rights."); return work;
  }
  private attempt(work: RecoveryWorkRecord, number: number): RecoveryAttemptRecord { integer(number); const attempt = work.attempts[number]; if (!attempt) throw unproven("The physical attempt is not retained."); return attempt; }
  private call(record: RecoveryThreadRecord, id: string): RecoveryCallRecord { identity(id); const call = record.calls[id]; if (!call) throw unproven("The result does not match a durably issued call."); return call; }
  private mappingKey(session: string, revision: string): string { identity(session); identity(revision); return digest([session, revision]); }
  private guard(record: RecoveryThreadRecord, guard: RecoveryGuard): void {
    if (record.scope !== guard.scope || guard.expectedVersion !== undefined && record.version !== guard.expectedVersion
      || guard.expectedEpoch !== undefined && record.epoch !== guard.expectedEpoch || guard.expectedOwner !== undefined && record.owner.id !== guard.expectedOwner) throw unproven("The durable installation, scope, owner, epoch or transaction observation is stale.");
  }
  private isSettled(record: RecoveryThreadRecord, lineageId: string): boolean {
    return !record.legacyUnproven && Object.values(record.works).every(work => work.workLineageId !== lineageId || work.attempts.every(attempt => attempt.dispatchProtocolComplete))
      && Object.values(record.calls).every(call => call.workLineageId !== lineageId || ["settled", "cancelled-before-delivery"].includes(call.state));
  }
  private requireSettled(record: RecoveryThreadRecord, lineageId: string): void { if (!this.isSettled(record, lineageId)) throw unproven("A delivered or queued tool has no proved terminal result; no replacement attempt may start."); }
  private requireRetired(record: RecoveryThreadRecord, lineageId: string, attachedAttempt?: RecoveryAttemptRecord): void {
    if (Object.values(record.works).some(work => work.workLineageId === lineageId && work.attempts.some(attempt => !attempt.dispatchProtocolComplete || attempt !== attachedAttempt && !attempt.writerRetired))) throw unproven("The old lineage writer or complete dispatch coverage is not proved retired.");
  }
  private retry(work: RecoveryWorkRecord): void {
    const budget = work.retryBudget ?? { attempts: 1, startedAt: this.now() };
    // A long-running initial turn has not spent any recovery window before its first failure.
    if (budget.attempts === 1 && budget.lastFailureAt === undefined) budget.startedAt = this.now();
    if (budget.attempts >= MAX_CONTINUITY_RECOVERY_RETRIES + 1 || this.now() - budget.startedAt > CONTINUITY_RECOVERY_RETRY_WINDOW_MS) throw continuityError("continuity_retry_exhausted");
    budget.attempts++; work.retryBudget = budget;
  }
  private newTransaction(record: RecoveryThreadRecord, work: RecoveryWorkRecord, attempt: RecoveryAttemptRecord, sourceEpoch: number, previous?: RecoveryTransactionRecord): void {
    attempt.transactionId = previous?.transactionId ?? randomBytes(32).toString("hex"); attempt.transactionVersion = previous ? previous.version + 1 : 0;
    record.transaction = { transactionId: attempt.transactionId, version: attempt.transactionVersion, sourceEpoch, targetEpoch: attempt.epoch, logicalWorkId: work.logicalWorkId,
      attempt: attempt.attempt, snapshotVersion: attempt.snapshotVersion, snapshotDigest: attempt.snapshotDigest, stage: attempt.stage,
      writerRetired: attempt.writerRetired, toolsSettled: this.isSettled(record, work.workLineageId),
      ...(attempt.launcherInstance ? { launcherInstance: structuredClone(attempt.launcherInstance) } : {}) };
  }
  private syncTransaction(record: RecoveryThreadRecord, work: RecoveryWorkRecord, attempt: RecoveryAttemptRecord): void {
    const transaction = record.transaction;
    if (!transaction || transaction.logicalWorkId !== work.logicalWorkId || transaction.attempt !== attempt.attempt) return;
    attempt.transactionVersion = transaction.version;
    transaction.stage = attempt.stage; transaction.snapshotVersion = attempt.snapshotVersion; transaction.snapshotDigest = attempt.snapshotDigest;
    transaction.writerRetired = attempt.writerRetired; transaction.toolsSettled = this.isSettled(record, work.workLineageId);
    if (attempt.pageReceiptId) transaction.pageReceiptId = attempt.pageReceiptId; else delete transaction.pageReceiptId;
    if (attempt.launcherInstance) transaction.launcherInstance = structuredClone(attempt.launcherInstance); else delete transaction.launcherInstance;
  }
  private installation(): string {
    try { const marker = safeFile(join(this.directory, "initialized.json"), 1024); exact(marker, ["version", "installation"], ["recoveryVersion"]); if (marker.version !== 1 || marker.recoveryVersion !== undefined && marker.recoveryVersion !== 2) throw new Error(); hash(marker.installation); return marker.installation; }
    catch { throw invalid("Continuity registration storage is missing, unreadable or invalid; it was not reset."); }
  }
  private read(): RecoveryDocument {
    if (!existsSync(this.marker)) throw invalid("Continuity recovery storage is not initialized; run controlled setup or upgrade.");
    try {
      const marker = safeFile(this.marker, 1024); exact(marker, ["version", "installation"]); hash(marker.installation);
      const document = safeFile(this.file, MAX_CONTINUITY_RECOVERY_BYTES); exact(document, ["version", "installation", "threads"]); dictionary(document.threads);
      if (marker.version !== 2 || document.version !== 2 || document.installation !== marker.installation || document.installation !== this.installation()
        || Object.keys(document.threads).length > MAX_THREADS) throw new Error("invalid installation");
      for (const [thread, record] of Object.entries(document.threads)) { validateThread(record); if (record.thread !== thread) throw new Error("invalid thread index"); }
      this.checkCapacity(document as unknown as RecoveryDocument); return document as unknown as RecoveryDocument;
    } catch (error) {
      if ((error as { code?: string }).code === "continuity_resource_capacity") throw error;
      throw invalid("Continuity recovery storage is missing, unreadable or invalid; it was not reset.");
    }
  }
  private checkCapacity(document: RecoveryDocument): void {
    let reserve = 0; let checkpointCount = 0;
    for (const record of Object.values(document.threads)) {
      if (Object.keys(record.works).length > this.limits.tombstones) throw capacity("Continuity terminal identity capacity is 256 per thread, including reserved active identities.");
      checkpointCount += Object.keys(record.compactionTargets).length;
      for (const work of Object.values(record.works)) {
        const calls = Object.values(record.calls).filter(call => call.logicalWorkId === work.logicalWorkId);
        const workReserve = terminal(work) ? 0 : WORK_TERMINAL_RESERVE;
        const callReserve = calls.filter(call => call.state === "queued" || call.state === "delivery-possible").length * CALL_TERMINAL_RESERVE;
        const bodyBytes = calls.reduce((bytes, call) => bytes + (call.resultBodyBytes ?? 0), 0);
        const preparationBytes = (record.pendingPreparation?.expected.transaction.logicalWorkId === work.logicalWorkId ? size(record.pendingPreparation) : 0)
          + (record.preparationReceipt?.target.transaction.logicalWorkId === work.logicalWorkId ? size(record.preparationReceipt) : 0)
          + (record.retiredPreparation?.expected.transaction.logicalWorkId === work.logicalWorkId ? size(record.retiredPreparation) : 0);
        if (size({ work, calls }) + workReserve + callReserve + bodyBytes + preparationBytes > this.limits.itemBytes) throw capacity("Continuity recovery item capacity is 2 MiB including optional results and terminal reservations.");
        if (new Set(calls.map(call => call.batchSequence)).size > this.limits.rounds) throw capacity("The current work has reached 512 tool rounds.");
        reserve += workReserve + callReserve + bodyBytes;
      }
      for (const target of Object.values(record.compactionTargets)) {
        if (Object.values(record.checkpoints).some(checkpoint => checkpoint.compactionTargetId === target.compactionTargetId)) continue;
        const covered = Object.values(record.calls).filter(call => call.workLineageId === target.workLineageId && call.batchSequence <= target.sourceToolBatchHeadSequence).map(call => call.callId);
        const minimumCommit = CHECKPOINT_COMMIT_RESERVE + size(covered) + size(target);
        if (target.checkpointBytes > this.limits.itemBytes || target.checkpointBytes < minimumCommit) throw capacity("Continuity checkpoint reservation must fit the complete item within 2 MiB."); reserve += target.checkpointBytes;
      }
      for (const checkpoint of Object.values(record.checkpoints)) {
        if (size(checkpoint) + checkpoint.retainedBodyBytes > checkpoint.checkpointBytes || checkpoint.checkpointBytes > this.limits.itemBytes) throw capacity("Continuity checkpoint item capacity is 2 MiB including retained bodies and metadata.");
        reserve += checkpoint.retainedBodyBytes;
      }
    }
    if (checkpointCount > this.limits.checkpoints) throw capacity("Continuity checkpoint capacity is 256.");
    if (size(document) + reserve > this.limits.totalBytes) throw capacity("Continuity recovery and checkpoint capacity is 24 MiB including terminal reservations.");
  }
  private write(document: RecoveryDocument): void {
    this.checkCapacity(document);
    let replaced = false;
    try {
      this.options.beforeWrite?.(); durableWrite(this.file, JSON.stringify(document), () => { replaced = true; this.options.afterAtomicReplace?.(); });
    } catch {
      throw Object.assign(invalid("Continuity recovery evidence could not be confirmed as saved; no new side effect is permitted."), { writeMayHaveCommitted: replaced });
    }
  }
  private exclusive<T>(operation: () => T): T {
    if (!existsSync(join(this.directory, "initialized.json"))) throw invalid("Continuity registration storage is not initialized; run controlled setup or upgrade.");
    return withContinuityStorageLock(this.lock, operation);
  }
}
