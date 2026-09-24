import { createHash } from "node:crypto";
import type { BrokerToolRequest, BrokerToolResult } from "./turn-broker";
import {
  finishNativeToolResult,
  nativePublicResult,
  NativeToolAdmissionError,
  normalizeNativeToolInput,
  type NativeResultContract,
  type NativeToolEntry,
} from "./native-tool-contract";

import { NATIVE_WAIT_PROTOCOL_VERSION, NATIVE_WAIT_WINDOW_MS, NATIVE_WAIT_LEASE_MS } from "./native-tool-wait-protocol";
export { NATIVE_WAIT_PROTOCOL_VERSION, NATIVE_WAIT_WINDOW_MS, NATIVE_WAIT_LEASE_MS } from "./native-tool-wait-protocol";
export const NATIVE_OPERATION_LIMIT = 1_024;
export const NATIVE_WAITER_LIMIT = 64;
export const NATIVE_CONTEXT_LIMIT_BYTES = 8 * 1_024 * 1_024;
export const NATIVE_CONTEXT_TOTAL_BYTES = 64 * 1_024 * 1_024;
export const NATIVE_RESULT_LIMIT_BYTES = 16 * 1_024 * 1_024;
export const NATIVE_RESULT_TOTAL_BYTES = 64 * 1_024 * 1_024;
// Each fixed unavailable terminal is below 1 KiB. Reserve room for every identity, including
// terminals produced after the normal result budget is full; never evict an earlier result.
const NATIVE_RESULT_ERROR_RESERVE_BYTES = NATIVE_OPERATION_LIMIT * 1_024;

export class NativeOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeOperationError";
  }
}

export interface NativeWaitingSnapshot {
  revision: number;
  activeOperations: number;
  unreadResults: number;
  remainingMs: number;
}

export type NativeOperationReply = { kind: "pending"; operation_id: number }
  | { kind: "result"; result: BrokerToolResult };

export type NativeOperationAdmission = {
  request: BrokerToolRequest;
  resultContract: NativeResultContract;
} | { result: BrokerToolResult; control?: boolean };

interface OperationWaiter {
  resolve: (reply: NativeOperationReply) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface NativeOperation {
  fingerprint: string;
  entry: NativeToolEntry;
  state: "queued" | "waiting" | "result-ready" | "result-delivered" | "retired";
  resultContract?: NativeResultContract;
  result?: BrokerToolResult;
  contextBytes: number;
  leaseUntil?: number;
  waiters: Set<OperationWaiter>;
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new NativeOperationError("codex_tool_resource_limit", "Native operation arguments exceed the nesting limit");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item, depth + 1)]));
  }
  return value;
}

function deepCanonicalFingerprint(value: unknown): string {
  type Frame = { kind: "value"; value: unknown; arrayItem: boolean }
    | { kind: "text"; value: string }
    | { kind: "exit"; value: object };
  const hash = createHash("sha256");
  const stack: Frame[] = [{ kind: "value", value, arrayItem: false }];
  const ancestors = new Set<object>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "text") {
      hash.update(frame.value);
      continue;
    }
    if (frame.kind === "exit") {
      ancestors.delete(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null) {
      hash.update("null");
      continue;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) {
        hash.update("\u0000cycle\u0000");
        continue;
      }
      ancestors.add(current);
      stack.push({ kind: "exit", value: current }, { kind: "text", value: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index], arrayItem: true });
        if (index > 0) stack.push({ kind: "text", value: "," });
      }
      stack.push({ kind: "text", value: "[" });
      continue;
    }
    if (typeof current === "object") {
      const object = current as Record<string, unknown>;
      if (ancestors.has(object)) {
        hash.update("\u0000cycle\u0000");
        continue;
      }
      ancestors.add(object);
      const keys = Object.keys(object)
        .filter(key => object[key] !== undefined && typeof object[key] !== "function" && typeof object[key] !== "symbol")
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      stack.push({ kind: "exit", value: object }, { kind: "text", value: "}" });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        stack.push(
          { kind: "value", value: object[key], arrayItem: false },
          { kind: "text", value: ":" },
          { kind: "text", value: JSON.stringify(key) },
        );
        if (index > 0) stack.push({ kind: "text", value: "," });
      }
      stack.push({ kind: "text", value: "{" });
      continue;
    }
    const encoded = JSON.stringify(current);
    hash.update(encoded ?? (frame.arrayItem ? "null" : ""));
  }
  return hash.digest("hex");
}

export function nativeOperationFailure(code: string, message: string, tool?: string): BrokerToolResult {
  return nativePublicResult({ code, message, retryable: false, ...(tool ? { tool } : {}) }, true);
}

export function nativeControlResult(kind: string, value: BrokerToolResult): BrokerToolResult {
  return { ...value, _meta: { ...value._meta as object, "codex/native-control": { version: NATIVE_WAIT_PROTOCOL_VERSION, kind } } };
}

export function nativePendingResult(operationId: number): BrokerToolResult {
  return nativeControlResult("pending", nativePublicResult({
    kind: "codex_native_pending", operation_id: operationId, next_tool: "codex_tool_wait",
    message: "The original Native operation is still pending. Call codex_tool_wait with this same operation_id. A start retry must reuse this ID; only a new logical operation uses a new ID. Do not submit a final answer yet.",
  }));
}

/** One store per Broker capability, independent of MCP sockets and Responses rounds. */
export class NativeToolOperations {
  private readonly operations = new Map<number, NativeOperation>();
  private revision = 0;
  private contextBytes = 0;
  private resultBytes = 0;
  private waiterCount = 0;
  private retired?: Error;
  private timer?: ReturnType<typeof setInterval>;
  private lastTick: number;
  private awakeAtTick = 0;

  constructor(
    private readonly onChange: () => void,
    private readonly onLeaseExpired: (reason: NativeOperationError) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.lastTick = clock();
  }

  start(
    operationId: number,
    entry: NativeToolEntry,
    input: Record<string, unknown>,
    admit: (normalized: Record<string, unknown>) => NativeOperationAdmission,
  ): { request?: BrokerToolRequest; created: boolean } {
    this.assertActive();
    this.assertId(operationId);
    const normalized = normalizeNativeToolInput(entry, input);
    const startDescription = { entry, parameters: normalized };
    let descriptionBytes: number;
    let fingerprint: string;
    let deterministicResourceError: NativeOperationError | undefined;
    try {
      const description = JSON.stringify(canonical(startDescription));
      descriptionBytes = Buffer.byteLength(description);
      fingerprint = createHash("sha256").update(description).digest("hex");
    } catch (error) {
      if (!(error instanceof NativeOperationError) || error.code !== "codex_tool_resource_limit") throw error;
      fingerprint = deepCanonicalFingerprint(startDescription);
      descriptionBytes = Number.POSITIVE_INFINITY;
      deterministicResourceError = error;
    }
    const previous = this.operations.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new NativeOperationError("codex_tool_operation_conflict", "operation_id is already bound to a different start request; use a new ID for a new logical operation");
      }
      return { created: false };
    }
    if (this.operations.size >= NATIVE_OPERATION_LIMIT) throw this.capacityError();
    // Admission and identity publication are synchronous. Unexpected infrastructure failures leave
    // no half-bound identity; deterministic rejections publish the same replayable terminal slot.
    let admission: NativeOperationAdmission;
    try {
      admission = deterministicResourceError
        ? { result: nativeOperationFailure(deterministicResourceError.code, deterministicResourceError.message, entry) }
        : descriptionBytes > NATIVE_CONTEXT_LIMIT_BYTES
        ? { result: nativeOperationFailure("codex_tool_resource_limit", "The Native start description exceeds the bounded argument budget", entry) }
        : admit(normalized);
    } catch (error) {
      if (!(error instanceof NativeToolAdmissionError)) throw error;
      admission = { result: nativeOperationFailure("codex_tool_admission_rejected", error.message, entry) };
    }
    let contextBytes = "request" in admission
      ? Buffer.byteLength(JSON.stringify(admission))
      : 0;
    if (contextBytes > NATIVE_CONTEXT_LIMIT_BYTES || this.contextBytes + contextBytes > NATIVE_CONTEXT_TOTAL_BYTES) {
      admission = { result: nativeOperationFailure("codex_tool_resource_limit", "The Native start exceeds the bounded admission context budget", entry) };
      contextBytes = 0;
    }
    const operation: NativeOperation = {
      fingerprint, entry, state: "queued", contextBytes, waiters: new Set(),
      ...("request" in admission ? { resultContract: structuredClone(admission.resultContract), leaseUntil: this.now() + NATIVE_WAIT_LEASE_MS } : {}),
    };
    this.operations.set(operationId, operation);
    this.contextBytes += contextBytes;
    if ("result" in admission) {
      this.cache(operation, admission.control ? nativeControlResult("compaction", admission.result) : admission.result);
    } else {
      this.ensureTimer();
      this.changed();
    }
    return { created: true, ...("request" in admission ? { request: admission.request } : {}) };
  }

  handoff(operationId: number): void {
    const operation = this.get(operationId);
    if (operation.state !== "queued") return;
    operation.state = "waiting";
    this.changed();
  }

  complete(operationId: number, raw: BrokerToolResult, control = false): void {
    const operation = this.get(operationId);
    if (operation.state !== "queued" && operation.state !== "waiting") {
      throw new NativeOperationError("codex_tool_operation_retired", "Native operation cannot accept another result");
    }
    let result: BrokerToolResult;
    try {
      result = control ? nativeControlResult("compaction", structuredClone(raw))
        : finishNativeToolResult(operation.resultContract!, raw);
    } catch {
      result = nativeOperationFailure("codex_tool_result_unavailable", "The Native result could not be converted to its public result", operation.entry);
    }
    this.cache(operation, result);
  }

  wait(operationId: number, signal?: AbortSignal, waitMs = NATIVE_WAIT_WINDOW_MS): Promise<NativeOperationReply> {
    const operation = this.get(operationId);
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > NATIVE_WAIT_WINDOW_MS) throw new Error("Invalid Native wait window");
    if (signal?.aborted) return Promise.reject(new DOMException("Native query aborted", "AbortError"));
    if (operation.result) return Promise.resolve(this.deliver(operation));
    if (this.waiterCount >= NATIVE_WAITER_LIMIT) throw this.capacityError();
    operation.leaseUntil = this.now() + NATIVE_WAIT_LEASE_MS;
    this.changed();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (operation.waiters.delete(waiter)) this.waiterCount -= 1;
      };
      const onAbort = () => { cleanup(); reject(new DOMException("Native query aborted", "AbortError")); };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "pending", operation_id: operationId });
      }, waitMs);
      const waiter: OperationWaiter = { resolve, reject, cleanup };
      operation.waiters.add(waiter);
      this.waiterCount += 1;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  hasOutstanding(): boolean {
    return [...this.operations.values()].some(operation => operation.state !== "result-delivered" && operation.state !== "retired");
  }

  snapshot(): NativeWaitingSnapshot {
    let activeOperations = 0;
    let unreadResults = 0;
    let remainingMs = NATIVE_WAIT_LEASE_MS;
    let leased = false;
    for (const operation of this.operations.values()) {
      if (operation.state === "queued" || operation.state === "waiting") activeOperations += 1;
      if (operation.state === "result-ready") unreadResults += 1;
      if (operation.leaseUntil !== undefined && operation.state !== "result-delivered") {
        leased = true;
        remainingMs = Math.min(remainingMs, Math.max(0, operation.leaseUntil - this.now()));
      }
    }
    return { revision: this.revision, activeOperations, unreadResults, remainingMs: leased ? remainingMs : 0 };
  }

  /** Match the browser's awake-time policy: a suspended process does not spend its lease asleep. */
  tick(now = this.clock()): void {
    const gap = Math.max(0, now - this.lastTick);
    this.awakeAtTick += gap >= 5_000 ? 1_000 : gap;
    this.lastTick = now;
    for (const operation of this.operations.values()) {
      if (operation.leaseUntil !== undefined && operation.state !== "result-delivered" && operation.leaseUntil <= this.awakeAtTick) {
        const error = new NativeOperationError("codex_tool_wait_lease_expired", "The Native waiting channel lost its authorized query consumer");
        this.onLeaseExpired(error);
        return;
      }
    }
    if (gap >= 5_000 && this.hasOutstanding()) this.changed();
  }

  retire(error: Error): void {
    if (this.retired) return;
    this.retired = error;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const operation of this.operations.values()) {
      operation.state = "retired";
      for (const waiter of [...operation.waiters]) { waiter.cleanup(); waiter.reject(error); }
    }
    this.operations.clear();
    this.contextBytes = 0;
    this.resultBytes = 0;
    this.changed();
  }

  private cache(operation: NativeOperation, value: BrokerToolResult): void {
    let result = value;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(result)); } catch { bytes = Infinity; }
    if (bytes > NATIVE_RESULT_LIMIT_BYTES || this.resultBytes + bytes > NATIVE_RESULT_TOTAL_BYTES - NATIVE_RESULT_ERROR_RESERVE_BYTES) {
      result = nativeOperationFailure("codex_tool_result_unavailable", "The Native result exceeds the bounded result cache; the operation will not be executed again", operation.entry);
      bytes = Buffer.byteLength(JSON.stringify(result));
    }
    operation.result = structuredClone(result);
    operation.resultContract = undefined;
    this.contextBytes -= operation.contextBytes;
    operation.contextBytes = 0;
    this.resultBytes += bytes;
    operation.state = "result-ready";
    this.changed();
    for (const waiter of [...operation.waiters]) { waiter.cleanup(); waiter.resolve(this.deliver(operation)); }
  }

  private deliver(operation: NativeOperation): NativeOperationReply {
    if (operation.state !== "result-delivered") {
      operation.state = "result-delivered";
      operation.leaseUntil = undefined;
      if (![...this.operations.values()].some(candidate => candidate.leaseUntil !== undefined)) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.changed();
    }
    return { kind: "result", result: structuredClone(operation.result!) };
  }

  private now(): number {
    const gap = Math.max(0, this.clock() - this.lastTick);
    return this.awakeAtTick + (gap >= 5_000 ? 1_000 : gap);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.awakeAtTick = this.now();
    this.lastTick = this.clock();
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref?.();
  }

  private changed(): void { this.revision += 1; this.onChange(); }
  private capacityError(): NativeOperationError { return new NativeOperationError("codex_tool_resource_limit", "The Native operation resource limit was reached; existing operations remain available"); }
  private assertActive(): void {
    if (!this.retired) this.tick();
    if (this.retired) throw this.retired;
  }
  private assertId(id: number): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new NativeOperationError("codex_tool_operation_id_required", "Allocate a positive safe integer operation_id before calling Native tools; refresh the connector to the current wait protocol");
  }
  private get(id: number): NativeOperation {
    this.assertActive();
    this.assertId(id);
    const operation = this.operations.get(id);
    if (!operation) throw new NativeOperationError("codex_tool_operation_unknown", "operation_id is unknown or expired in this capability");
    return operation;
  }
}
