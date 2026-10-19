import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { ContinuityRecoveryStore, type RecoveryStoreOptions } from "./continuity-recovery-store";
import { continuityError } from "./continuity-errors";
import { taskUpdateDigest, taskUpdateSourceError } from "./task-update-source";
import {
  MAX_TASK_INPUT_PENDING_BYTES, MAX_TASK_INPUT_PENDING_MESSAGES, findTaskInput, taskInputIdentityKey, taskInputReservedBytes, validateTaskInputIdentity,
  type ReserveTaskInputDelivery, type TaskInputCoverage, type TaskInputDelivery, type TaskInputGuard,
  type TaskInputIdentity, type TaskInputMessage, type TaskInputRecord, type TaskInputTaskRecord, type TaskInputUsage,
} from "./continuity-task-input-types";

export * from "./continuity-task-input-types";
export interface TaskInputStoreOptions {
  recoveryOptions?: RecoveryStoreOptions;
  /** Synchronous fault injection at the actual payload boundaries. No body is supplied. */
  beforePayloadWrite?: () => void;
  afterPayloadWrite?: () => void;
}
const ID = /^[A-Za-z0-9_.:@+-]{1,256}$/;
function validId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw taskUpdateSourceError("task_update_invalid", "Task input identity is invalid.");
}
function nonnegative(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw taskUpdateSourceError("task_update_invalid", "Task input version is invalid.");
}
function pending(message: TaskInputRecord): boolean { return !["completed", "discarded"].includes(message.status); }
function unavailable(): Error { return continuityError("continuity_context_missing", "The saved task input body is missing, damaged or unsafe. Resubmit the same message ID and original body, or discard it."); }
function stale(): Error { return taskUpdateSourceError("task_update_stale", "Task input state or execution intent has changed."); }
function capacity(): Error { return continuityError("continuity_resource_capacity", "A task can retain at most 128 pending messages and 1 MiB of pending text."); }
const taskKey = taskInputIdentityKey;
function checkGuard(task: TaskInputTaskRecord | undefined, guard: TaskInputGuard): void {
  if (guard.expectedVersion !== undefined && guard.expectedVersion !== task?.version
    || guard.expectedIntentGeneration !== undefined && guard.expectedIntentGeneration !== task?.intentGeneration) throw stale();
  authorize(guard);
}
function authorize(guard: TaskInputGuard): void {
  const result: unknown = guard.authorize?.();
  if (result && typeof (result as { then?: unknown }).then === "function") throw taskUpdateSourceError("task_update_invalid", "Task input authority checks must be synchronous.");
}
function checkPending(task: TaskInputTaskRecord): void {
  const messages = task.messages.filter(pending);
  if (messages.length > MAX_TASK_INPUT_PENDING_MESSAGES || messages.reduce((sum, message) => sum + message.bytes, 0) > MAX_TASK_INPUT_PENDING_BYTES) throw capacity();
}
function sameBinding(delivery: TaskInputDelivery, coverage: TaskInputCoverage): boolean {
  return (["physicalResponseId", "capabilityId", "workLineageId", "logicalWorkId", "acceptedRevision", "acceptedTaskRevision", "driverGeneration", "historyRevision"] as const)
    .every(key => delivery[key] === coverage[key]);
}
function safeStat(stat: Stats, directory = false): void {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || process.platform !== "win32" && (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw unavailable();
}

/** Durable input custody only. A saved inbox never grants browser or tool execution rights. */
export class ContinuityTaskInputStore {
  private readonly recovery: ContinuityRecoveryStore;
  private readonly payloadDirectory: string;
  constructor(readonly directory: string, private readonly options: TaskInputStoreOptions = {}) {
    this.recovery = new ContinuityRecoveryStore(directory, options.recoveryOptions);
    this.payloadDirectory = join(directory, "task-input-payloads");
  }
  get(identity: TaskInputIdentity): TaskInputTaskRecord | undefined {
    validateTaskInputIdentity(identity);
    return this.recovery.withTaskInputTransaction(index => {
      const task = findTaskInput(index, identity); return task && structuredClone(task);
    }, true);
  }
  list(identity: TaskInputIdentity): TaskInputRecord[] { return this.get(identity)?.messages ?? []; }
  listTasks(filter: { thread?: string; scope?: string } = {}): TaskInputTaskRecord[] {
    for (const value of [filter.thread, filter.scope]) if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw stale();
    return this.recovery.withTaskInputTransaction((index, commit) => {
      this.reclaimRetired(index, commit);
      return structuredClone(Object.values(index).filter(task =>
        (!filter.thread || task.thread === filter.thread) && (!filter.scope || task.scope === filter.scope || task.canonicalScope === filter.scope)));
    }, true);
  }
  /** Use only inside an existing recovery lock at the actual enqueue/commit boundary. */
  assertExecutionIntent(identity: TaskInputIdentity, intentGeneration: number): TaskInputTaskRecord {
    return this.recovery.assertTaskInputIntent(identity, intentGeneration);
  }
  withExecutionIntent<T>(identity: TaskInputIdentity, intentGeneration: number, action: () => T): T {
    validateTaskInputIdentity(identity); nonnegative(intentGeneration);
    return this.recovery.withTaskInputTransaction(index => {
      const task = findTaskInput(index, identity);
      if (!task || task.state !== "active" || task.intentGeneration !== intentGeneration) throw stale();
      return action();
    });
  }

  receive(identity: TaskInputIdentity, messages: readonly TaskInputMessage[], guard: TaskInputGuard = {}): TaskInputTaskRecord {
    validateTaskInputIdentity(identity);
    if (!messages.length) throw taskUpdateSourceError("task_update_invalid", "At least one task input message is required.");
    const seen = new Map<string, string>();
    const inputs: Array<TaskInputMessage & { digest: string; bytes: number }> = [];
    for (const message of messages) {
      validId(message.messageId);
      if (typeof message.text !== "string" || !message.text.trim() || Buffer.from(message.text).toString("utf8") !== message.text) throw taskUpdateSourceError("task_update_invalid", "Task input must contain valid user text.");
      const digest = taskUpdateDigest(message.text), previous = seen.get(message.messageId);
      if (previous !== undefined) {
        if (previous !== digest) throw taskUpdateSourceError("task_update_message_conflict", "A receive batch contains conflicting content for one message ID.");
        continue;
      }
      seen.set(message.messageId, digest);
      inputs.push({ ...message, digest, bytes: Buffer.byteLength(message.text) });
    }
    return this.recovery.withTaskInputTransaction((index, commit) => {
      this.reclaimRetired(index, commit);
      const existing = findTaskInput(index, identity), key = taskKey(existing ?? identity); checkGuard(existing, guard);
      if (existing?.retired) throw stale();
      const task: TaskInputTaskRecord = existing ?? { ...identity, version: 0, receivedSequence: 0, state: "active", intentGeneration: 0, messages: [], deliveries: [] };
      // Check the complete batch before reserving any identity or body bytes.
      for (const input of inputs) {
        const message = task.messages.find(value => value.messageId === input.messageId);
        if (message && (message.digest !== input.digest || message.bytes !== input.bytes)) throw taskUpdateSourceError("task_update_message_conflict", "This message ID already has different accepted content.");
        if (!message && task.state === "stopped") throw stale();
      }
      const draft = structuredClone(task);
      let added = false;
      for (const input of inputs) if (!draft.messages.some(message => message.messageId === input.messageId)) {
        draft.messages.push({ messageId: input.messageId, digest: input.digest, bytes: input.bytes, receivedSequence: ++draft.receivedSequence,
          status: "reserved", payload: "reserved", intentGeneration: draft.intentGeneration, deliveryIds: [] }); added = true;
      }
      if (added && draft.state === "completed") { draft.state = "active"; delete draft.sourceSettled; delete draft.retirementReadyAt; }
      checkPending(draft);
      // This directory is also a fail-closed marker: page-journal repair cannot erase inbox identities.
      this.ensurePayloadDirectory(true);
      let reserved = false;
      try {
        if (added) { draft.version++; index[key] = draft; commit(); reserved = true; }
        else index[key] = draft;
        let changed = false;
        for (const input of inputs) {
          const message = draft.messages.find(value => value.messageId === input.messageId)!;
          if (message.payload === "released") continue;
          try { this.loadBody(draft, message); }
          catch { this.saveBody(draft, message, input.text); changed = true; }
          if (message.payload !== "ready") { message.payload = "ready"; changed = true; }
          if (message.status === "reserved") { message.status = draft.state === "stopped" ? "stopped" : "accepted"; changed = true; }
        }
        authorize(guard);
        if (changed) { draft.version++; commit(); }
        return structuredClone(draft);
      } catch (error) {
        const uncertain = reserved || !!(error as { writeMayHaveCommitted?: boolean }).writeMayHaveCommitted
          || !!existing?.messages.some(message => inputs.some(input => input.messageId === message.messageId));
        throw Object.assign(error instanceof Error ? error : continuityError("continuity_unverified"), { receiveStatus: uncertain ? "unknown" : "not-received" });
      }
    }, true);
  }

  readBody(identity: TaskInputIdentity, messageId: string): string {
    validateTaskInputIdentity(identity); validId(messageId);
    return this.recovery.withTaskInputTransaction((index, commit) => {
      const task = findTaskInput(index, identity), message = task?.messages.find(value => value.messageId === messageId);
      if (!task || !message || message.payload === "released") throw unavailable();
      try { return this.loadBody(task, message); }
      catch {
        if (message.payload !== "missing") { message.payload = "missing"; task.version++; commit(); }
        throw unavailable();
      }
    });
  }

  reserveDelivery(identity: TaskInputIdentity, input: ReserveTaskInputDelivery, guard: TaskInputGuard = {}): TaskInputDelivery | undefined {
    validateTaskInputIdentity(identity); this.validateDelivery(input);
    return this.recovery.withTaskInputTransaction((index, commit) => {
      const task = findTaskInput(index, identity); checkGuard(task, guard);
      if (!task) return undefined;
      const old = task.deliveries.find(delivery => delivery.deliveryId === input.deliveryId);
      if (old) {
        if (old.cancelled) throw taskUpdateSourceError("task_update_transfer_conflict", "A cancelled delivery ID cannot be reused.");
        if (old.intentGeneration !== task.intentGeneration || task.state !== "active") throw stale();
        if (old.mode !== input.mode || old.baseAcceptedRevision !== input.acceptedRevision
          || !sameBinding(old, { ...input, acceptedRevision: old.acceptedRevision, messageIds: old.messageIds })
          || input.messageIds && JSON.stringify(input.messageIds) !== JSON.stringify(old.messageIds)) throw taskUpdateSourceError("task_update_transfer_conflict", "A delivery ID cannot be rebound.");
        return structuredClone(old);
      }
      if (task.state !== "active") throw stale();
      if (task.deliveries.some(delivery => !delivery.cancelled && delivery.intentGeneration === task.intentGeneration && delivery.mode === "active"
        && delivery.acknowledgedMessageIds.length < delivery.messageIds.length)) throw taskUpdateSourceError("task_update_transfer_pending", "The prior active delivery still requires its exact model acknowledgement.");
      const available = task.messages.filter(message => ["accepted", "reserved"].includes(message.status) && message.intentGeneration === task.intentGeneration
        && !message.deliveryIds.some(id => task.deliveries.some(delivery => !delivery.cancelled && delivery.deliveryId === id && delivery.intentGeneration === task.intentGeneration)));
      let bytes = 0;
      const selected: TaskInputRecord[] = [];
      for (const message of available) {
        if (selected.length >= (input.maxMessages ?? MAX_TASK_INPUT_PENDING_MESSAGES) || bytes + message.bytes > (input.maxBytes ?? MAX_TASK_INPUT_PENDING_BYTES)) break;
        selected.push(message); bytes += message.bytes;
      }
      if (input.messageIds) {
        if (!input.messageIds.length || JSON.stringify(input.messageIds) !== JSON.stringify(selected.slice(0, input.messageIds.length).map(message => message.messageId))) throw taskUpdateSourceError("task_update_source_conflict", "Delivery must select the next ordered input prefix.");
        selected.splice(input.messageIds.length);
      }
      if (!selected.length) return undefined;
      // A body problem blocks this ordered prefix; it must not silently skip ahead.
      for (const message of selected) {
        try { this.loadBody(task, message); }
        catch { if (message.payload !== "missing") { message.payload = "missing"; task.version++; commit(); } throw unavailable(); }
        if (message.payload !== "ready" || message.status !== "accepted") throw unavailable();
      }
      const delivery: TaskInputDelivery = {
        deliveryId: input.deliveryId, mode: input.mode, physicalResponseId: input.physicalResponseId,
        ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}), workLineageId: input.workLineageId,
        ...(input.logicalWorkId ? { logicalWorkId: input.logicalWorkId } : {}),
        acceptedRevision: input.mode === "active" ? input.acceptedRevision + selected.length : 0,
        baseAcceptedRevision: input.acceptedRevision, acceptedTaskRevision: input.acceptedTaskRevision,
        driverGeneration: input.driverGeneration, historyRevision: input.historyRevision, intentGeneration: task.intentGeneration,
        messageIds: selected.map(message => message.messageId), receivedSequences: selected.map(message => message.receivedSequence),
        modelRevisions: selected.map((_, i) => input.mode === "active" ? input.acceptedRevision + i + 1 : 0),
        deliveredMessageIds: [], acknowledgedMessageIds: [], completedMessageIds: [],
      };
      for (const message of selected) message.deliveryIds.push(input.deliveryId);
      task.deliveries.push(delivery); task.version++; authorize(guard); commit(); return structuredClone(delivery);
    });
  }

  markDelivered(identity: TaskInputIdentity, deliveryId: string, coverage: TaskInputCoverage, guard: TaskInputGuard = {}): TaskInputTaskRecord {
    return this.cover(identity, deliveryId, coverage, "deliveredMessageIds", guard);
  }
  /** The trusted caller must first prove downstream admission did not commit.
   * A timeout, absent reply or unrecorded Send is not that proof.
   */
  cancelReservedDelivery(identity: TaskInputIdentity, deliveryId: string, coverage: TaskInputCoverage, guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    validId(deliveryId); this.validateIds(coverage.messageIds);
    return this.mutate(identity, guard, task => {
      const delivery = task.deliveries.find(value => value.deliveryId === deliveryId);
      if (!delivery || !sameBinding(delivery, coverage) || JSON.stringify(delivery.messageIds) !== JSON.stringify(coverage.messageIds)
        || delivery.intentGeneration !== task.intentGeneration || delivery.deliveredMessageIds.length) throw stale();
      if (delivery.cancelled) return false;
      delivery.cancelled = true; return true;
    });
  }
  acknowledge(identity: TaskInputIdentity, deliveryId: string, coverage: TaskInputCoverage, guard: TaskInputGuard = {}): TaskInputTaskRecord {
    return this.cover(identity, deliveryId, coverage, "acknowledgedMessageIds", guard);
  }
  complete(identity: TaskInputIdentity, deliveryId: string, coverage: TaskInputCoverage, guard: TaskInputGuard = {}): TaskInputTaskRecord {
    return this.cover(identity, deliveryId, coverage, "completedMessageIds", guard);
  }
  setWaitReason(identity: TaskInputIdentity, reason: TaskInputTaskRecord["waitReason"], guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    return this.mutate(identity, guard, task => {
      if (task.waitReason === reason) return false;
      if (reason === undefined) delete task.waitReason; else task.waitReason = reason;
      return true;
    });
  }

  stop(identity: TaskInputIdentity, guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    return this.mutate(identity, guard, task => {
      if (task.state !== "active") return false;
      task.state = "stopped"; task.intentGeneration++;
      for (const message of task.messages.filter(pending)) message.status = "stopped";
      return true;
    });
  }
  discard(identity: TaskInputIdentity, messageId: string, guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    validId(messageId);
    return this.mutate(identity, guard, task => {
      const message = task.messages.find(value => value.messageId === messageId);
      if (!message) throw stale();
      if (message.status === "discarded") return false;
      if (message.deliveryIds.some(id => task.deliveries.some(delivery => delivery.deliveryId === id && !delivery.cancelled)) || message.status === "completed") throw taskUpdateSourceError("task_update_not_executed", "This input already crossed the delivery permission boundary and cannot be withdrawn.");
      message.status = "discarded"; return true;
    });
  }
  /** Only this explicit user action creates a new intent after stop. Original delivery facts remain. */
  retry(identity: TaskInputIdentity, messageIds: readonly string[], guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    this.validateIds(messageIds);
    return this.mutate(identity, guard, task => {
      const selected = messageIds.map(id => task.messages.find(message => message.messageId === id));
      if (selected.some(message => !message || message.status !== "stopped" || message.payload !== "ready") || task.state !== "stopped") throw stale();
      task.intentGeneration++; task.state = "active";
      for (const message of selected as TaskInputRecord[]) {
        this.loadBody(task, message); message.retryOfIntentGeneration = message.intentGeneration;
        message.intentGeneration = task.intentGeneration; message.status = "accepted";
      }
      return true;
    });
  }
  usage(identity?: TaskInputIdentity): TaskInputUsage {
    if (identity) validateTaskInputIdentity(identity);
    return this.recovery.withTaskInputTransaction(index => {
      const selected = identity && findTaskInput(index, identity);
      const tasks = identity ? (selected ? [selected] : []) : Object.values(index);
      const messages = tasks.flatMap(task => task.messages), pendingMessages = messages.filter(pending);
      const global = this.recovery.capacityUsage();
      return { tasks: tasks.length, messages: messages.length, pendingMessages: pendingMessages.length,
        pendingBytes: pendingMessages.reduce((sum, message) => sum + message.bytes, 0),
        bodyBytes: messages.reduce((sum, message) => sum + (message.payload === "released" ? 0 : message.bytes), 0),
        metadataBytes: Buffer.byteLength(JSON.stringify(tasks)),
        reservedBytes: taskInputReservedBytes(Object.fromEntries(tasks.map(task => [taskKey(task), task]))),
        globalUsedBytes: global.usedBytes, globalLimitBytes: global.limitBytes,
      };
    });
  }
  /** Explicit terminal-body reclamation. Pending and stopped inputs are retained without a TTL. */
  cleanup(identity: TaskInputIdentity, messageIds?: readonly string[], guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    if (messageIds) this.validateIds(messageIds);
    return this.mutate(identity, guard, task => {
      const selected = task.messages.filter(message => messageIds ? messageIds.includes(message.messageId) : !pending(message));
      if (selected.some(pending)) throw stale();
      let changed = false;
      for (const message of selected) if (message.payload !== "released") {
        this.removeBody(task, message); message.payload = "released"; changed = true;
      }
      return changed;
    });
  }
  /** Explicit permanent removal leaves a compact source fence, including after page deletion. */
  deleteTask(identity: TaskInputIdentity, guard: TaskInputGuard = {}): TaskInputTaskRecord | undefined {
    validateTaskInputIdentity(identity);
    return this.recovery.withTaskInputTransaction((index, commit) => {
      const task = findTaskInput(index, identity); checkGuard(task, guard); if (!task) return undefined;
      if (task.state !== "stopped") { task.state = "stopped"; task.intentGeneration++; }
      delete task.sourceSettled; delete task.retirementReadyAt;
      for (const message of task.messages) if (message.status !== "completed") message.status = "discarded";
      task.retired = { reason: "deleted", sequence: task.receivedSequence, compacted: false };
      task.version++; commit(); // Persist the source fence before deleting any body.
      this.reclaimRetired(index, commit);
      return structuredClone(task);
    });
  }
  /** Finish an already durable retirement. A crash can leave only over-accounted files. */
  private reclaimRetired(index: Record<string, TaskInputTaskRecord>, commit: () => void): void {
    let changed = false;
    for (const task of Object.values(index)) {
      if (!task.retired || task.retired.compacted) continue;
      for (const message of task.messages) this.removeBody(task, message);
      task.messages = []; task.deliveries = []; delete task.waitReason;
      task.retired.compacted = true; task.version++; changed = true;
    }
    if (changed) commit();
  }

  private cover(identity: TaskInputIdentity, deliveryId: string, coverage: TaskInputCoverage,
    field: "deliveredMessageIds" | "acknowledgedMessageIds" | "completedMessageIds", guard: TaskInputGuard): TaskInputTaskRecord {
    validId(deliveryId); this.validateIds(coverage.messageIds);
    const result = this.mutate(identity, guard, task => {
      const delivery = task.deliveries.find(value => value.deliveryId === deliveryId);
      if (!delivery || delivery.cancelled || !sameBinding(delivery, coverage) || delivery.intentGeneration !== task.intentGeneration || task.state === "stopped"
        || coverage.messageIds.some(id => !delivery.messageIds.includes(id))) throw stale();
      const prerequisite = field === "acknowledgedMessageIds" ? delivery.deliveredMessageIds
        : field === "completedMessageIds" ? (delivery.mode === "active" ? delivery.acknowledgedMessageIds : delivery.deliveredMessageIds) : delivery.messageIds;
      if (coverage.messageIds.some(id => !prerequisite.includes(id))) throw taskUpdateSourceError("task_update_unacknowledged", "Input coverage requires the exact delivered and acknowledged messages.");
      let changed = false;
      for (const id of coverage.messageIds) if (!delivery[field].includes(id)) {
        delivery[field].push(id); changed = true;
        if (field === "completedMessageIds") task.messages.find(message => message.messageId === id)!.status = "completed";
      }
      // This completion decision and receive use the same lock and task record.
      if (field === "completedMessageIds" && task.messages.every(message => !pending(message))) task.state = "completed";
      return changed;
    });
    if (!result) throw stale(); return result;
  }
  private mutate(identity: TaskInputIdentity, guard: TaskInputGuard, change: (task: TaskInputTaskRecord) => boolean): TaskInputTaskRecord | undefined {
    validateTaskInputIdentity(identity);
    return this.recovery.withTaskInputTransaction((index, commit) => {
      const task = findTaskInput(index, identity); checkGuard(task, guard); if (!task) return undefined;
      if (change(task)) { task.version++; checkPending(task); authorize(guard); commit(); }
      return structuredClone(task);
    });
  }
  private validateIds(ids: readonly string[]): void {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw taskUpdateSourceError("task_update_invalid", "An exact nonempty message ID set is required.");
    ids.forEach(validId);
  }
  private validateDelivery(input: ReserveTaskInputDelivery): void {
    for (const id of [input.deliveryId, input.physicalResponseId, input.workLineageId]) validId(id);
    for (const id of [input.capabilityId, input.logicalWorkId]) if (id !== undefined) validId(id);
    for (const number of [input.acceptedRevision, input.acceptedTaskRevision, input.driverGeneration, input.historyRevision]) nonnegative(number);
    if (!["initial", "active"].includes(input.mode) || input.mode === "initial" && (input.acceptedRevision !== 0 || input.driverGeneration !== 0)) throw stale();
    for (const limit of [input.maxMessages, input.maxBytes]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw stale();
    if (input.messageIds) this.validateIds(input.messageIds);
  }
  private ensurePayloadDirectory(create = false): void {
    if (create) {
      try {
        mkdirSync(this.payloadDirectory, { mode: 0o700 });
        if (process.platform !== "win32") { const fd = openSync(this.directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    safeStat(lstatSync(this.payloadDirectory), true);
  }
  private payloadPath(identity: TaskInputIdentity, message: TaskInputRecord): string {
    const id = createHash("sha256").update(JSON.stringify([taskKey(identity), message.messageId, message.digest])).digest("hex");
    return join(this.payloadDirectory, `${id}.txt`);
  }
  private loadBody(identity: TaskInputIdentity, message: TaskInputRecord): string {
    this.ensurePayloadDirectory();
    const path = this.payloadPath(identity, message); safeStat(lstatSync(path));
    const fd = openSync(path, (process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd); safeStat(stat);
      if (stat.size !== message.bytes || stat.size > MAX_TASK_INPUT_PENDING_BYTES) throw unavailable();
      const body = readFileSync(fd), text = body.toString("utf8");
      if (body.byteLength !== message.bytes || taskUpdateDigest(text) !== message.digest || Buffer.byteLength(text) !== message.bytes) throw unavailable();
      fsyncSync(fd); this.syncPayloadDirectory(); return text;
    } finally { closeSync(fd); }
  }
  private saveBody(identity: TaskInputIdentity, message: TaskInputRecord, text: string): void {
    this.ensurePayloadDirectory();
    const path = this.payloadPath(identity, message);
    // A reserved file is written in place. A crash leaves a detectable partial body,
    // never an unbudgeted temporary copy. Only matching-ID resubmission can repair it.
    let exists = false;
    try { safeStat(lstatSync(path)); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.options.beforePayloadWrite?.();
    const fd = openSync(path, (exists ? constants.O_WRONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { safeStat(fstatSync(fd)); ftruncateSync(fd, 0); writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    this.syncPayloadDirectory(); this.options.afterPayloadWrite?.();
  }
  private removeBody(identity: TaskInputIdentity, message: TaskInputRecord): void {
    try {
      this.ensurePayloadDirectory(); const path = this.payloadPath(identity, message); safeStat(lstatSync(path)); unlinkSync(path); this.syncPayloadDirectory();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private syncPayloadDirectory(): void {
    if (process.platform === "win32") return;
    const fd = openSync(this.payloadDirectory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
