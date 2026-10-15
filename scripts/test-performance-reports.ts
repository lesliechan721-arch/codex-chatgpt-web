import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_PERFORMANCE_OPERATIONS, type RuntimePerformanceCounter } from "../src/runtime-performance";

const legacy = new Set(["processIdentity", "fsync.file", "fsync.directory", "rename.retryWait",
  "recovery.write", "recovery.noop", "recovery.confirm", "recovery.reuse"]);
export function validCounter(value: unknown): value is RuntimePerformanceCounter {
  const c = value as RuntimePerformanceCounter | null;
  return !!c && !Array.isArray(c) && [c.count, c.errors, c.totalMs, c.maxMs, c.totalBytes === undefined ? 0 : c.totalBytes]
    .every(number => typeof number === "number" && Number.isFinite(number) && number >= 0)
    && Number.isInteger(c.count) && Number.isInteger(c.errors) && c.errors <= c.count && c.maxMs <= c.totalMs;
}
const empty = (): RuntimePerformanceCounter => ({ count: 0, errors: 0, totalMs: 0, maxMs: 0, totalBytes: 0 });
function merge(target: RuntimePerformanceCounter, c: RuntimePerformanceCounter): void {
  target.count += c.count; target.errors += c.errors; target.totalMs += c.totalMs;
  target.maxMs = Math.max(target.maxMs, c.maxMs); target.totalBytes += c.totalBytes ?? 0;
}
export function collectPerformanceReports(directory: string, runId: string, rootProcessId: string, rootPid: number | null) {
  const totals = Object.fromEntries(RUNTIME_PERFORMANCE_OPERATIONS.map(name => [name, empty()])) as Record<string, RuntimePerformanceCounter | null>;
  const contexts = new Map<string, { context: unknown; counters: Record<string, RuntimePerformanceCounter> }>();
  const invalidReports: string[] = [], incompleteReasons: string[] = [];
  const reports: any[] = [], children: any[] = [];
  const snapshotIds = new Set<string>(), childIds = new Set<string>();
  let legacySnapshots = 0;
  for (const file of readdirSync(directory).filter(name => name.endsWith(".json"))) {
    try {
      const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
      if (file.endsWith(".child.json")) {
        if (report.version !== 2 || !["child", "worker"].includes(report.kind) || report.runId !== runId || typeof report.id !== "string"
          || typeof report.parentId !== "string" || typeof report.expectsReport !== "boolean") throw new Error("Invalid child ledger");
        if (childIds.has(report.id)) throw new Error("Duplicate child ledger");
        childIds.add(report.id);
        children.push(report); continue;
      }
      if (![1, 2].includes(report.version) || !report.counters || typeof report.counters !== "object" || Array.isArray(report.counters)
        || Object.values(report.counters).some(counter => !validCounter(counter))) throw new Error("Invalid counters");
      if (report.version === 2 && (report.runId !== runId || typeof report.processId !== "string"
        || typeof report.snapshotId !== "string" || snapshotIds.has(report.snapshotId)
        || !Number.isInteger(report.pid) || report.pid < 1 || typeof report.complete !== "boolean" || !Array.isArray(report.contexts))) throw new Error("Invalid report origin");
      if (report.version === 1) legacySnapshots++;
      else {
        snapshotIds.add(report.snapshotId);
        if (!report.complete) incompleteReasons.push(`unfinished-global:${file}`);
        if (report.diagnosticErrors !== undefined && (!Array.isArray(report.diagnosticErrors)
          || report.diagnosticErrors.some((reason: unknown) => typeof reason !== "string"))) throw new Error("Invalid diagnostic errors");
        for (const reason of report.diagnosticErrors ?? []) incompleteReasons.push(`diagnostic-error:${reason}`);
        for (const bucket of report.contexts) {
          if (!bucket.context || !bucket.counters || typeof bucket.counters !== "object"
            || Object.values(bucket.counters).some(counter => !validCounter(counter))) throw new Error("Invalid context counters");
        }
      }
      reports.push(report);
    } catch { invalidReports.push(file); }
  }
  const expected = new Map<string, number | null>([[rootProcessId, rootPid]]);
  for (const child of children) {
    expected.set(child.id, child.pid);
    if (child.kind === "worker" ? !child.complete : child.status !== "exited" || !Number.isInteger(child.exitCode) || child.exitCode !== 0 || child.signal != null) incompleteReasons.push(`child-not-normal:${child.id}`);
    if (child.expectsReport && !reports.some(report => report.version === 2 && report.processId === child.id && report.pid === child.pid)) incompleteReasons.push(`missing-child-report:${child.id}`);
  }
  if (!reports.some(report => report.version === 2 && report.processId === rootProcessId && report.pid === rootPid)
    && !children.some(child => child.kind === "worker" && child.parentId === rootProcessId)) incompleteReasons.push("missing-root-report");
  for (const child of children) if (!expected.has(child.parentId)) incompleteReasons.push(`unknown-child-parent:${child.id}`);
  const starts = new Map<string, number>();
  for (const report of reports) if (report.version === 2) {
    starts.set(report.processId, (starts.get(report.processId) ?? 0) + (report.counters["process.start"]?.count ?? 0));
  }
  const recordedStarts = new Map<string, number>();
  for (const child of children) if (child.kind === "child") {
    recordedStarts.set(child.parentId, (recordedStarts.get(child.parentId) ?? 0) + 1);
  }
  for (const id of new Set([...starts.keys(), ...recordedStarts.keys()])) {
    if ((starts.get(id) ?? 0) !== (recordedStarts.get(id) ?? 0)) incompleteReasons.push(`child-start-ledger-mismatch:${id}`);
  }
  for (const report of reports) {
    if (report.version === 2 && expected.get(report.processId) !== report.pid) incompleteReasons.push("untracked-process-report");
    for (const name of RUNTIME_PERFORMANCE_OPERATIONS) {
      if (report.version === 1 && !legacy.has(name)) { totals[name] = null; continue; }
      const counter = report.counters[name];
      if (counter && totals[name]) merge(totals[name]!, counter);
    }
    for (const bucket of report.contexts ?? []) {
      const key = JSON.stringify({ ...bucket.context, pid: report.pid, workerId: report.workerId ?? null });
      const target = contexts.get(key) ?? { context: JSON.parse(key), counters: {} as Record<string, RuntimePerformanceCounter> };
      contexts.set(key, target);
      for (const [name, counter] of Object.entries(bucket.counters)) {
        merge(target.counters[name] ??= empty(), counter as RuntimePerformanceCounter);
      }
    }
  }
  if (legacySnapshots) incompleteReasons.push("legacy-origin-and-new-metrics-unknown");
  const unassignedParameterTests = [...contexts.values()].reduce((count, bucket) => {
    const context = bucket.context as { file?: unknown; parameterId?: unknown };
    return count + (typeof context.file === "string" && context.parameterId === null ? bucket.counters["test.total"]?.count ?? 0 : 0);
  }, 0);
  return { snapshots: reports.length, legacySnapshots, invalidReports, incompleteReasons: [...new Set(incompleteReasons)],
    complete: reports.length > 0 && invalidReports.length === 0 && incompleteReasons.length === 0,
    totals, contexts: [...contexts.values()], children, unassignedParameterTests };
}
