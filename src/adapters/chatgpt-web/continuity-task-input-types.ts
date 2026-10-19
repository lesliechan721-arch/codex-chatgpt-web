import { continuityError } from "./continuity-errors";
import { createHash } from "node:crypto";

export const MAX_TASK_INPUT_PENDING_MESSAGES = 128;
export const MAX_TASK_INPUT_PENDING_BYTES = 1024 * 1024;
/** The existing historical Session replay window, after a successful successor. */
export const TASK_INPUT_HISTORICAL_RETENTION_MS = 30 * 60_000;

export interface TaskInputIdentity { thread: string; scope: string; taskId: string }
export interface TaskInputGuard {
  expectedVersion?: number;
  expectedIntentGeneration?: number;
  /** Synchronous authority check. It runs inside the shared storage lock. */
  authorize?: () => void;
}
export interface TaskInputMessage { messageId: string; text: string }
export interface TaskInputRecord {
  messageId: string; digest: string; bytes: number; receivedSequence: number;
  status: "reserved" | "accepted" | "stopped" | "discarded" | "completed";
  payload: "reserved" | "ready" | "missing" | "released";
  intentGeneration: number;
  deliveryIds: string[];
  retryOfIntentGeneration?: number;
}
export interface TaskInputDeliveryBinding {
  physicalResponseId: string;
  capabilityId?: string;
  workLineageId: string;
  logicalWorkId?: string;
  acceptedRevision: number;
  acceptedTaskRevision: number;
  driverGeneration: number;
  historyRevision: number;
}
export interface ReserveTaskInputDelivery extends TaskInputDeliveryBinding {
  deliveryId: string;
  mode: "initial" | "active";
  maxMessages?: number;
  maxBytes?: number;
  /** If supplied, these must be the exact next ordered prefix. */
  messageIds?: string[];
}
export interface TaskInputDelivery extends TaskInputDeliveryBinding {
  deliveryId: string;
  mode: "initial" | "active";
  intentGeneration: number;
  /** M before this delivery. acceptedRevision is the committed M. */
  baseAcceptedRevision: number;
  messageIds: string[];
  receivedSequences: number[];
  modelRevisions: number[];
  deliveredMessageIds: string[];
  acknowledgedMessageIds: string[];
  completedMessageIds: string[];
  /** The caller independently proved this delivery was never committed downstream. */
  cancelled?: true;
}
export interface TaskInputCoverage extends TaskInputDeliveryBinding { messageIds: string[] }
export interface TaskInputTaskRecord extends TaskInputIdentity {
  /** Exact scope equivalence proved by the authenticated routing migration. */
  canonicalScope?: string;
  version: number;
  receivedSequence: number;
  state: "active" | "stopped" | "completed";
  waitReason?: "boundary" | "next-response" | "manual-send" | "observer" | "compaction" | "recovery";
  intentGeneration: number;
  messages: TaskInputRecord[];
  deliveries: TaskInputDelivery[];
  /** Exact source work/writer settlement survived removal of its page journal. */
  sourceSettled?: true;
  /** Source work/writers settled; retain ordinary final replay until this deadline. */
  retirementReadyAt?: number;
  /** Content-free source fence survives page cleanup and forbids new work from this task. */
  retired?: { reason: "completed" | "deleted"; sequence: number; compacted: boolean };
}
export type TaskInputIndex = Record<string, TaskInputTaskRecord>;
export interface TaskInputUsage {
  tasks: number; messages: number; pendingMessages: number; pendingBytes: number;
  bodyBytes: number; metadataBytes: number; reservedBytes: number;
  globalUsedBytes: number; globalLimitBytes: number;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:@+-]{1,256}$/;
function invalid(): never { throw continuityError("continuity_configuration_conflict", "Task input metadata has an invalid schema."); }
function object(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); }
function exact(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  object(value);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function id(value: unknown): asserts value is string { if (typeof value !== "string" || !ID.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) invalid(); }
function hash(value: unknown): asserts value is string { if (typeof value !== "string" || !HASH.test(value)) invalid(); }
function number(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); }
function strings(value: unknown): asserts value is string[] { if (!Array.isArray(value)) invalid(); value.forEach(id); if (new Set(value).size !== value.length) invalid(); }
function member(value: unknown, values: string[]): void { if (typeof value !== "string" || !values.includes(value)) invalid(); }
export function validateTaskInputIdentity(value: unknown): asserts value is TaskInputIdentity {
  object(value); hash(value.thread); hash(value.scope); id(value.taskId);
}
export function taskInputIdentityKey(identity: TaskInputIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.thread, identity.scope, identity.taskId])).digest("hex");
}
/** An alias never changes custody, payload paths or the task's original scope. */
export function findTaskInput(index: TaskInputIndex | undefined, identity: TaskInputIdentity): TaskInputTaskRecord | undefined {
  const matches = Object.values(index ?? {}).filter(task => task.thread === identity.thread && task.taskId === identity.taskId
    && (task.scope === identity.scope || task.canonicalScope === identity.scope));
  if (matches.length > 1) invalid();
  return matches[0];
}
export function validateTaskInputIndex(value: unknown): asserts value is TaskInputIndex {
  object(value);
  for (const [key, task] of Object.entries(value)) {
    hash(key);
    exact(task, ["thread", "scope", "taskId", "version", "receivedSequence", "state", "intentGeneration", "messages", "deliveries"], ["waitReason", "retired", "canonicalScope", "sourceSettled", "retirementReadyAt"]);
    validateTaskInputIdentity(task); number(task.version); number(task.receivedSequence); number(task.intentGeneration);
    if (task.canonicalScope !== undefined) hash(task.canonicalScope);
    if (task.sourceSettled !== undefined && (task.sourceSettled !== true || task.state !== "completed")) invalid();
    if (task.retirementReadyAt !== undefined) { number(task.retirementReadyAt); if (task.sourceSettled !== true) invalid(); }
    if (key !== taskInputIdentityKey(task)) invalid();
    member(task.state, ["active", "stopped", "completed"]);
    if (task.waitReason !== undefined) member(task.waitReason, ["boundary", "next-response", "manual-send", "observer", "compaction", "recovery"]);
    if (!Array.isArray(task.messages) || !Array.isArray(task.deliveries)) invalid();
    if (task.retired !== undefined) {
      exact(task.retired, ["reason", "sequence", "compacted"]);
      member(task.retired.reason, ["completed", "deleted"]); number(task.retired.sequence);
      if (typeof task.retired.compacted !== "boolean" || task.retired.sequence !== task.receivedSequence
        || task.state === "active" || task.retired.compacted && (task.messages.length || task.deliveries.length)) invalid();
    }
    let sequence = task.retired?.compacted ? Number(task.retired.sequence) : 0;
    const messages = new Map<string, TaskInputRecord>();
    for (const raw of task.messages) {
      exact(raw, ["messageId", "digest", "bytes", "receivedSequence", "status", "payload", "intentGeneration", "deliveryIds"], ["retryOfIntentGeneration"]);
      id(raw.messageId); hash(raw.digest); number(raw.bytes); number(raw.receivedSequence); number(raw.intentGeneration); strings(raw.deliveryIds);
      member(raw.status, ["reserved", "accepted", "stopped", "discarded", "completed"]); member(raw.payload, ["reserved", "ready", "missing", "released"]);
      if (task.retired && !["completed", "discarded"].includes(String(raw.status))) invalid();
      if (raw.retryOfIntentGeneration !== undefined) number(raw.retryOfIntentGeneration);
      if (raw.receivedSequence !== ++sequence || raw.intentGeneration > task.intentGeneration || messages.has(raw.messageId)
        || raw.bytes > MAX_TASK_INPUT_PENDING_BYTES || raw.payload === "released" && !["completed", "discarded"].includes(String(raw.status))) invalid();
      messages.set(raw.messageId, raw as unknown as TaskInputRecord);
    }
    if (sequence !== task.receivedSequence) invalid();
    const pending = [...messages.values()].filter(message => !["completed", "discarded"].includes(message.status));
    if (pending.length > MAX_TASK_INPUT_PENDING_MESSAGES || pending.reduce((sum, message) => sum + message.bytes, 0) > MAX_TASK_INPUT_PENDING_BYTES) invalid();
    const deliveries = new Set<string>();
    for (const raw of task.deliveries) {
      exact(raw, ["deliveryId", "mode", "physicalResponseId", "workLineageId", "acceptedRevision", "baseAcceptedRevision", "acceptedTaskRevision", "driverGeneration", "historyRevision", "intentGeneration", "messageIds", "receivedSequences", "modelRevisions", "deliveredMessageIds", "acknowledgedMessageIds", "completedMessageIds"], ["capabilityId", "logicalWorkId", "cancelled"]);
      for (const name of ["deliveryId", "physicalResponseId", "workLineageId"]) id(raw[name]);
      for (const name of ["capabilityId", "logicalWorkId"]) if (raw[name] !== undefined) id(raw[name]);
      for (const name of ["acceptedRevision", "baseAcceptedRevision", "acceptedTaskRevision", "driverGeneration", "historyRevision", "intentGeneration"]) number(raw[name]);
      member(raw.mode, ["initial", "active"]);
      strings(raw.messageIds); strings(raw.deliveredMessageIds); strings(raw.acknowledgedMessageIds); strings(raw.completedMessageIds);
      if (!Array.isArray(raw.receivedSequences) || !Array.isArray(raw.modelRevisions) || !raw.messageIds.length
        || raw.messageIds.length !== raw.receivedSequences.length || raw.messageIds.length !== raw.modelRevisions.length
        || Number(raw.intentGeneration) > task.intentGeneration || deliveries.has(String(raw.deliveryId))) invalid();
      const delivery = raw as unknown as TaskInputDelivery;
      if (raw.cancelled !== undefined && (raw.cancelled !== true || delivery.deliveredMessageIds.length || delivery.acknowledgedMessageIds.length || delivery.completedMessageIds.length)) invalid();
      deliveries.add(String(raw.deliveryId));
      raw.messageIds.forEach((messageId, i) => {
        const message = messages.get(messageId);
        if (!message || message.receivedSequence !== delivery.receivedSequences[i] || !message.deliveryIds.includes(String(raw.deliveryId))
          || i > 0 && delivery.receivedSequences[i]! <= delivery.receivedSequences[i - 1]!) invalid();
        number(delivery.modelRevisions[i]);
        if (raw.mode === "active" && delivery.modelRevisions[i] !== Number(raw.baseAcceptedRevision) + i + 1
          || raw.mode === "initial" && delivery.modelRevisions[i] !== 0) invalid();
      });
      if (raw.mode === "active" && raw.acceptedRevision !== Number(raw.baseAcceptedRevision) + raw.messageIds.length
        || raw.mode === "initial" && (raw.baseAcceptedRevision !== 0 || raw.acceptedRevision !== 0 || raw.driverGeneration !== 0)
        || delivery.deliveredMessageIds.some(messageId => !delivery.messageIds.includes(messageId))
        || delivery.acknowledgedMessageIds.some(messageId => !delivery.deliveredMessageIds.includes(messageId))
        || delivery.completedMessageIds.some(messageId => !(raw.mode === "active" ? delivery.acknowledgedMessageIds : delivery.deliveredMessageIds).includes(messageId))) invalid();
    }
    for (const message of messages.values()) if (message.deliveryIds.some(deliveryId => !deliveries.has(deliveryId))) invalid();
  }
}

/** Body reservations also cover an interrupted payload write. Metadata is charged by the recovery document. */
export function taskInputReservedBytes(index: TaskInputIndex | undefined): number {
  return Object.values(index ?? {}).reduce((sum, task) => {
    const bodies = task.messages.reduce((bytes, message) => bytes + (message.payload === "released" ? 0 : message.bytes), 0);
    // Reserve the first delivery and its stop, ACK and completion facts at receipt.
    const metadataReserve = Math.max(0, 1024 + task.messages.filter(message => message.payload !== "released").length * 8192 - Buffer.byteLength(JSON.stringify(task)));
    return sum + bodies + metadataReserve;
  }, 0);
}
