import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_PERFORMANCE_OPERATIONS = [
  "processIdentity", "fsync.file", "fsync.directory", "rename.retryWait",
  "recovery.write", "recovery.noop", "recovery.confirm", "recovery.reuse",
  "processIdentity.local", "processIdentity.localUse", "processIdentity.fresh", "recovery.lockWait", "recovery.transaction",
  "recovery.read", "recovery.parse", "recovery.validate", "recovery.proofRemember", "recovery.proofReuse",
  "test.total", "fixture.prepare", "fixture.store", "fixture.http", "fixture.broker", "fixture.mcp",
  "fixture.firstRequest", "request.total", "fixture.cleanup", "cleanup.sessions", "cleanup.release",
  "cleanup.broker", "cleanup.http", "cleanup.child", "process.start",
] as const;
export type RuntimePerformanceOperation = typeof RUNTIME_PERFORMANCE_OPERATIONS[number];
export interface RuntimePerformanceCounter {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  // Bytes supplied to the operation, including failed attempts; not bytes persisted.
  totalBytes: number;
}

// The test profiler creates this directory. Normal application runs collect nothing.
// Each isolated test global gets a separate report, including globals in one worker.
const directory = process.env.CGW_RUNTIME_PERFORMANCE_DIR;
const snapshotId = directory ? randomUUID() : undefined;
const reportPath = directory ? join(directory, `${process.pid}-${snapshotId}.json`) : undefined;
const counters: Partial<Record<RuntimePerformanceOperation, RuntimePerformanceCounter>> = {};
const clock = process.hrtime.bigint;
export interface RuntimePerformanceContext {
  file: string | null;
  scenarioId: string;
  parameterId: string | null;
  fixtureMode: string | null;
}
const contexts = new AsyncLocalStorage<RuntimePerformanceContext>();
let inherited: RuntimePerformanceContext | undefined;
try {
  const value = JSON.parse(process.env.CGW_PERFORMANCE_CONTEXT ?? "null");
  if (value && (value.file === null || typeof value.file === "string") && typeof value.scenarioId === "string"
    && (value.parameterId === null || typeof value.parameterId === "string") && (value.fixtureMode === null || typeof value.fixtureMode === "string")) inherited = value;
} catch { /* An invalid context stays unassigned. */ }
const unassigned: RuntimePerformanceContext = inherited ?? { file: null, scenarioId: "module-initialization", parameterId: null, fixtureMode: null };
const attributed = new Map<string, { context: RuntimePerformanceContext; counters: typeof counters }>();
const startedAt = new Date().toISOString();
let complete = false;
let completedBy: "flush" | "afterAll" | "exit" | null = null;
let inFlight = 0;
const diagnosticErrors = new Set<string>();

export function markRuntimePerformanceIncomplete(reason: string): void {
  if (reportPath) diagnosticErrors.add(reason);
}

export function runtimePerformanceEnabled(): boolean { return reportPath !== undefined; }
export function runtimePerformanceSnapshotId(): string | undefined { return snapshotId; }
export function runtimePerformanceContext(): RuntimePerformanceContext {
  return contexts.getStore() ?? unassigned;
}
export function withRuntimePerformanceContext<T>(context: RuntimePerformanceContext, action: () => T): T {
  return reportPath ? contexts.run(context, action) : action();
}
function record(operation: RuntimePerformanceOperation, start: bigint, failed: boolean, bytes: number, context: RuntimePerformanceContext): void {
  const duration = Number(clock() - start) / 1_000_000;
  const key = JSON.stringify(context);
  let bucket = attributed.get(key);
  if (!bucket) { bucket = { context, counters: {} }; attributed.set(key, bucket); }
  for (const target of [counters, bucket.counters]) {
    const counter = target[operation] ??= { count: 0, errors: 0, totalMs: 0, maxMs: 0, totalBytes: 0 };
    counter.count++;
    counter.errors += Number(failed);
    counter.totalMs += duration;
    counter.maxMs = Math.max(counter.maxMs, duration);
    counter.totalBytes += bytes;
  }
}

export function measureRuntimeOperation<T>(operation: RuntimePerformanceOperation, action: () => T, bytes = 0): T {
  if (!reportPath) return action();
  const start = clock();
  const context = runtimePerformanceContext();
  let failed = false;
  try { return action(); }
  catch (error) { failed = true; throw error; }
  finally {
    record(operation, start, failed, bytes, context);
  }
}

/** Finish once at the real Promise or callback completion boundary. */
export function beginRuntimeAsyncMeasurement(operation: RuntimePerformanceOperation, bytes = 0): (failed?: boolean) => void {
  if (!reportPath) return () => {};
  const start = clock();
  const context = runtimePerformanceContext();
  let finished = false;
  inFlight++;
  return (failed = false) => {
    if (finished) return;
    finished = true;
    inFlight--;
    record(operation, start, failed, bytes, context);
  };
}

export async function measureRuntimeAsync<T>(operation: RuntimePerformanceOperation, action: () => T | Promise<T>, bytes = 0): Promise<T> {
  if (!reportPath) return await action();
  const finish = beginRuntimeAsyncMeasurement(operation, bytes);
  let failed = false;
  try { return await action(); }
  catch (error) { failed = true; throw error; }
  finally { finish(failed); }
}

export function flushRuntimePerformance(finished = false, boundary: "flush" | "afterAll" | "exit" = "flush"): void {
  if (!reportPath) return;
  complete ||= finished;
  if (finished) completedBy = boundary;
  try {
    // No paths, process start identities, request content or credentials enter the report.
    // Replace this global's snapshot so afterAll + exit cannot count it twice.
    writeFileSync(reportPath, JSON.stringify({ version: 3, snapshotId, runId: process.env.CGW_PERFORMANCE_RUN_ID ?? null,
      processId: process.env.CGW_PERFORMANCE_PROCESS_ID ?? null, pid: process.pid,
      workerId: process.env.BUN_TEST_WORKER_ID ?? null, platform: process.platform, startedAt,
      complete: complete && inFlight === 0 && diagnosticErrors.size === 0,
      pendingOperations: inFlight, completedBy,
      diagnosticErrors: [...diagnosticErrors], counters, contexts: [...attributed.values()] }));
  } catch {
    if (!diagnosticErrors.has("snapshot-write-failed")) {
      try { console.warn("[test-performance] snapshot-write-failed"); } catch { /* Diagnostics must preserve the application result. */ }
    }
    markRuntimePerformanceIncomplete("snapshot-write-failed");
  }
}

if (reportPath) {
  // The initial snapshot lets the collector detect interrupted globals as well as bad final reports.
  flushRuntimePerformance();
  process.on("exit", () => flushRuntimePerformance(true, "exit"));
}
