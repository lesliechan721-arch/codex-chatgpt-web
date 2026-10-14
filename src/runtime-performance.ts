import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNTIME_PERFORMANCE_OPERATIONS = [
  "processIdentity", "fsync.file", "fsync.directory", "rename.retryWait",
  "recovery.write", "recovery.noop", "recovery.confirm", "recovery.reuse",
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
const reportPath = directory ? join(directory, `${process.pid}-${randomUUID()}.json`) : undefined;
const counters: Partial<Record<RuntimePerformanceOperation, RuntimePerformanceCounter>> = {};
const clock = process.hrtime.bigint;

export function measureRuntimeOperation<T>(operation: RuntimePerformanceOperation, action: () => T, bytes = 0): T {
  if (!reportPath) return action();
  const start = clock();
  let failed = false;
  try { return action(); }
  catch (error) { failed = true; throw error; }
  finally {
    const duration = Number(clock() - start) / 1_000_000;
    const counter = counters[operation] ??= { count: 0, errors: 0, totalMs: 0, maxMs: 0, totalBytes: 0 };
    counter.count++;
    counter.errors += Number(failed);
    counter.totalMs += duration;
    counter.maxMs = Math.max(counter.maxMs, duration);
    counter.totalBytes += bytes;
  }
}

export function flushRuntimePerformance(): void {
  if (!reportPath) return;
  try {
    // No paths, process start identities, request content or credentials enter the report.
    // Replace this global's snapshot so afterAll + exit cannot count it twice.
    writeFileSync(reportPath, JSON.stringify({ version: 1, pid: process.pid, platform: process.platform, counters }));
  } catch { /* Diagnostic output must not change application or test behavior. */ }
}

if (reportPath) process.on("exit", flushRuntimePerformance);
