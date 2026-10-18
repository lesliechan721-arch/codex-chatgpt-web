import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { performanceSource } from "./test-performance-source";
import { validCounter } from "./test-performance-reports";

const root = resolve(import.meta.dir, "..");
export type Workers = 1 | 2;
export type MeasurementSettings = { mode: "full" | "timing"; isolation: "default" | "isolate" | "shared" };
type Runner = (workers: Workers, output: string, files: string[], settings: MeasurementSettings) => Promise<number>;
type SummaryScope = MeasurementSettings & { files: string[]; cwd?: string };

export function comparisonOptions(args: string[]) {
  let repetitions = 2;
  let mode: MeasurementSettings["mode"] = "full", isolation: MeasurementSettings["isolation"] = "isolate";
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--repetitions=")) {
      const value = arg.slice("--repetitions=".length);
      if (!["1", "2", "3"].includes(value)) throw new Error("--repetitions must be 1, 2 or 3.");
      repetitions = Number(value);
    } else if (arg.startsWith("--mode=")) {
      const value = arg.slice(7);
      if (value !== "full" && value !== "timing") throw new Error("--mode must be full or timing.");
      mode = value;
    } else if (arg.startsWith("--isolation=")) {
      const value = arg.slice(12);
      if (value !== "default" && value !== "isolate" && value !== "shared") throw new Error("--isolation must be default, isolate or shared.");
      isolation = value;
    } else if (arg.startsWith("-")) throw new Error(`Unsupported option ${arg}; use [--repetitions=1|2|3] [--mode=full|timing] [--isolation=default|isolate|shared] [test files or directories].`);
    else files.push(arg);
  }
  return { repetitions, files, mode, isolation };
}

const runProfiler: Runner = async (workers, output, files, settings) => {
  const child = Bun.spawn([process.execPath, join(root, "scripts", "profile-tests.ts"), `--parallel=${workers}`,
    `--mode=${settings.mode}`, `--isolation=${settings.isolation}`, ...files], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CGW_TEST_PROFILE_DIR: output },
  });
  return await child.exited;
};

export class InvalidSummary extends Error {
  constructor(readonly path: string, readonly summary: any, readonly reasons: string[]) {
    super(`Incomplete or invalid profile summary: ${reasons.join(", ")}.`);
  }
}

// Ignore only the per-run output path. Every test option and historical timing
// input must still describe the requested experiment.
function commandScope(command: unknown, workers: Workers, scope: SummaryScope, run: string, legacy: boolean) {
  const cwd = scope.cwd ?? root;
  if (!Array.isArray(command) || command.some(value => typeof value !== "string")) throw new Error("invalid-command");
  const actual = [...command] as string[];
  if (actual.shift() !== (legacy ? "bun" : process.execPath) || actual.shift() !== "test"
    || actual.shift() !== "--timeout" || actual.shift() !== "30000") throw new Error("different-command");
  if (scope.mode === "full" && (actual.shift() !== "--preload"
    || actual.shift() !== (legacy ? "scripts/test-performance-preload.ts" : join(cwd, "scripts/test-performance-preload.ts")))) throw new Error("different-preload");
  const timings: string[] = [];
  while (actual[0] === "--timings") {
    actual.shift();
    const path = actual.shift();
    if (!path || path.startsWith("-")) throw new Error("invalid-timings-input");
    timings.push(path);
  }
  if (timings.shift() !== (legacy ? "file-timings.json" : join(run, "file-timings.json"))
    || actual.shift() !== "--update-timings") throw new Error("different-timings-output");
  if (workers === 2 && actual.shift() !== "--parallel=2") throw new Error("different-workers-command");
  const isolation = scope.isolation === "isolate" ? "--isolate" : scope.isolation === "shared" ? "--no-isolate" : null;
  if (isolation && actual.shift() !== isolation) throw new Error("different-isolation-command");
  const files = scope.files.length ? scope.files : ["./tests"];
  if (JSON.stringify(actual) !== JSON.stringify(files)) throw new Error("different-command-scope");
  return timings.map(path => ({ path: resolve(cwd, path), digest: createHash("sha256").update(readFileSync(resolve(cwd, path))).digest("hex") }));
}

export function readPerformanceSummary(output: string, workers: Workers, exitCode: number,
  source: ReturnType<typeof performanceSource>, scope: SummaryScope = { mode: "full", isolation: "default", files: [] }) {
  const candidates = readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (candidates.length !== 1) throw new Error("Expected exactly one profile run directory.");
  const run = join(output, candidates[0]!.name), path = join(run, "summary.json");
  let summary: any;
  try { summary = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new InvalidSummary(path, null, [error instanceof Error ? error.message : String(error)]); }
  const reasons: string[] = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new InvalidSummary(path, summary, ["invalid-summary"]);
  if (summary.version !== 2 && summary.version !== 3) reasons.push("unsupported-summary-version");
  if (summary.known !== true || summary.revision !== source.revision || summary.patchDigest !== source.patchDigest
    || summary.toolDigest !== source.toolDigest || summary.nodeVersion !== source.nodeVersion
    || JSON.stringify(summary.measurementFiles) !== JSON.stringify(source.measurementFiles)) reasons.push("different-or-unknown-source");
  if (summary.workers !== workers || summary.exitCode !== exitCode || summary.platform !== process.platform
    || summary.arch !== process.arch || summary.bunVersion !== Bun.version) reasons.push("different-execution-environment");
  if (!Number.isFinite(summary.wallMs) || summary.wallMs < 0) reasons.push("invalid-wall-clock");
  if (!summary.counts || ![summary.counts.pass, summary.counts.skip, summary.counts.fail]
    .every(value => Number.isInteger(value) && value >= 0)) reasons.push("invalid-test-counts");
  const full = () => {
    if (summary.complete !== true || !Array.isArray(summary.incompleteReasons) || summary.incompleteReasons.length !== 0
      || !Number.isInteger(summary.snapshots) || summary.snapshots < 1
      || !Array.isArray(summary.invalidReports) || summary.invalidReports.length !== 0
      || !summary.totals || typeof summary.totals !== "object" || Array.isArray(summary.totals)
      || Object.keys(summary.totals).length === 0) reasons.push("incomplete-operation-collection");
    else for (const counter of Object.values(summary.totals)) {
      if (!counter || typeof counter !== "object" || Array.isArray(counter) || !validCounter(counter)) {
        reasons.push("invalid-profile-counter"); break;
      }
    }
  };
  let schedulingInputs: { path: string; digest: string }[] = [];
  let completionPath: string | null = null;
  if (summary.version === 2) {
    // v2 has no proof of a controlled isolation or timing-only run.
    if (scope.mode !== "full" || scope.isolation !== "default") reasons.push("legacy-summary-requires-full-default");
    full();
    // Early v2 synthetic reports omitted command. Preserve that old contract.
    if (summary.command !== undefined) {
      try { schedulingInputs = commandScope(summary.command, workers, scope, run, true); }
      catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
    }
  } else if (summary.version === 3) {
    if (summary.mode !== scope.mode || summary.isolation !== scope.isolation) reasons.push("different-measurement-mode-or-isolation");
    if (summary.testResult !== "success" || exitCode !== 0 || summary.counts?.fail !== 0) reasons.push("tests-did-not-succeed");
    if (summary.wallValid !== true || !Array.isArray(summary.wallInvalidReasons) || summary.wallInvalidReasons.length !== 0) reasons.push("invalid-wall-clock-status");
    const segments = summary.segments;
    if (!segments || !["prepareMs", "executionMs", "logDrainMs", "reportMs", "totalMs"].every(key => Number.isFinite(segments[key]) && segments[key] >= 0)
      || Math.abs(segments.executionMs - summary.wallMs) > 0.001
      || segments.totalMs + 0.001 < segments.prepareMs + segments.executionMs + segments.logDrainMs + segments.reportMs) reasons.push("invalid-time-segments");
    if (scope.mode === "full") {
      full();
      if (summary.collection?.status !== "complete") reasons.push("incomplete-operation-collection");
      if (!Array.isArray(summary.childResultIssues) || summary.childResultIssues.length !== 0) reasons.push("unexpected-child-results");
    } else if (summary.collection?.status !== "not-requested" || summary.complete !== false
      || summary.snapshots !== 0 || !summary.totals || typeof summary.totals !== "object" || Array.isArray(summary.totals)
      || Object.keys(summary.totals).length !== 0) reasons.push("invalid-timing-collection-status");
    try { schedulingInputs = commandScope(summary.command, workers, scope, run, false); }
    catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
    if (schedulingInputs.length > 1) reasons.push("invalid-scheduling-inputs");
    else if (schedulingInputs.length === 1) {
      if (summary.scheduling?.source !== "restored") reasons.push("different-scheduling-source");
      if (summary.scheduling?.inputDigest !== schedulingInputs[0]!.digest) reasons.push("different-scheduling-input-digest");
    } else {
      if (summary.scheduling?.source !== "cold") reasons.push("different-scheduling-source");
      if (summary.scheduling?.inputDigest != null) reasons.push("different-scheduling-input-digest");
    }
    completionPath = join(run, "completion.json");
    try {
      const completion = JSON.parse(readFileSync(completionPath, "utf8")), final = completion?.segments;
      if (completion?.version !== 1 || typeof summary.runId !== "string" || !summary.runId
        || completion.runId !== summary.runId) reasons.push("different-completion-run");
      if (completion?.endPoint !== "after-summary-and-status-output"
        || JSON.stringify(completion.excludes) !== JSON.stringify(["completion-write", "process-shutdown"])) reasons.push("invalid-completion-boundary");
      if (!final || !["prepareMs", "executionMs", "logDrainMs", "reportMs", "totalMs"].every(key => Number.isFinite(final[key]) && final[key] >= 0)
        || !segments || !["prepareMs", "executionMs", "logDrainMs"].every(key => final[key] === segments[key])
        || final.reportMs < segments.reportMs || final.totalMs < segments.totalMs
        || final.totalMs + 0.001 < final.prepareMs + final.executionMs + final.logDrainMs + final.reportMs) reasons.push("invalid-completion-segments");
      summary.completion = completion;
    } catch { reasons.push("missing-or-invalid-completion"); }
  }
  if (reasons.length) throw new InvalidSummary(path, summary, [...new Set(reasons)]);
  return { path, summary, schedulingInputs, completionPath };
}

export function durationStatistics(wallMs: number[]) {
  const sorted = [...wallMs].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { wallMs, totalWallMs: wallMs.reduce((sum, value) => sum + value, 0),
    meanWallMs: wallMs.length ? wallMs.reduce((sum, value) => sum + value, 0) / wallMs.length : null,
    medianWallMs: sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null,
    rangeWallMs: sorted.length ? { min: sorted[0]!, max: sorted.at(-1)! } : null };
}

export async function compareTestPerformance(args: string[], options: { output?: string; runner?: Runner } = {}) {
  const { repetitions, files, mode, isolation } = comparisonOptions(args), settings = { mode, isolation };
  const output = resolve(options.output ?? process.env.CGW_TEST_PROFILE_DIR ?? join(root, "output", "test-performance"));
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "comparison-"));
  const source = performanceSource(root);
  const runs: { round: number; workers: Workers; output: string; exitCode: number | null; wallMs: number | null; summaryPath: string | null;
    wrapperExitMs: number | null; completionPath: string | null; completion: unknown;
    counts: unknown; collection: string | null; invalidReasons: string[]; summaryVersion: number | null;
    schedulingInputs: { path: string; digest: string }[] | null; error: string | null }[] = [];
  for (let round = 1; round <= repetitions; round++) {
    const order: Workers[] = round % 2 ? [1, 2] : [2, 1];
    for (const workers of order) {
      const runOutput = join(directory, `run-${runs.length + 1}-workers-${workers}`);
      mkdirSync(runOutput);
      const run = { round, workers, output: runOutput, exitCode: null as number | null, wallMs: null as number | null,
        summaryPath: null as string | null, counts: null as unknown, collection: null as string | null,
        wrapperExitMs: null as number | null, completionPath: null as string | null, completion: null as unknown,
        invalidReasons: [] as string[], summaryVersion: null as number | null,
        schedulingInputs: null as { path: string; digest: string }[] | null, error: null as string | null };
      try {
        const wrapperStart = process.hrtime.bigint();
        try { run.exitCode = await (options.runner ?? runProfiler)(workers, runOutput, files, settings); }
        finally { run.wrapperExitMs = Number(process.hrtime.bigint() - wrapperStart) / 1_000_000; }
        const { path, summary, schedulingInputs, completionPath } = readPerformanceSummary(runOutput, workers, run.exitCode, source, { ...settings, files });
        run.wallMs = summary.wallMs; run.counts = summary.counts; run.schedulingInputs = schedulingInputs;
        run.summaryVersion = summary.version;
        run.completion = summary.completion ?? null; run.completionPath = completionPath ? relative(directory, completionPath) : null;
        run.collection = summary.version === 2 ? "legacy-complete" : summary.collection.status;
        run.summaryPath = relative(directory, path);
      } catch (error) {
        run.error = error instanceof Error ? error.message : String(error);
        if (error instanceof InvalidSummary) {
          run.summaryPath = relative(directory, error.path); run.counts = error.summary?.counts ?? null;
          run.collection = error.summary?.collection?.status ?? null; run.invalidReasons = error.reasons;
        } else run.invalidReasons = [run.error];
      }
      run.output = relative(directory, runOutput); runs.push(run);
    }
  }
  const after = performanceSource(root), reasons: string[] = [];
  if (!source.known || !after.known || source.revision !== after.revision || source.patchDigest !== after.patchDigest || source.toolDigest !== after.toolDigest) reasons.push("unknown-or-changed-source");
  if (runs.some(run => run.exitCode !== 0 || run.error !== null || run.wallMs === null)) reasons.push("failed-or-incomplete-samples");
  if (new Set(runs.map(run => JSON.stringify(run.counts))).size !== 1) reasons.push("different-test-coverage-counts");
  if (new Set(runs.map(run => JSON.stringify(run.summaryVersion === 3 ? run.schedulingInputs?.map(input => input.digest) : run.schedulingInputs))).size !== 1) reasons.push("different-scheduling-inputs");
  const valid = reasons.length === 0;
  const groups = ([1, 2] as const).map(workers => {
    const group = runs.filter(run => run.workers === workers);
    const wrapper = durationStatistics(group.flatMap(run => run.wrapperExitMs === null ? [] : [run.wrapperExitMs]));
    return { workers, runs: group.length, failures: group.filter(run => run.exitCode !== 0).length,
      failureRate: group.filter(run => run.exitCode !== 0).length / group.length,
      invalidReports: group.filter(run => run.error !== null).length,
      wrapperExitMs: wrapper.wallMs, medianWrapperExitMs: wrapper.medianWallMs, rangeWrapperExitMs: wrapper.rangeWallMs,
      ...durationStatistics(group.flatMap(run => run.wallMs === null ? [] : [run.wallMs])) };
  });
  const serial = groups[0]!.medianWallMs, parallel = groups[1]!.medianWallMs;
  const report = { version: 3, mode: "workers", measurementMode: mode, isolation,
    timingBoundaries: { wallMs: "Test root process execution.", wrapperExitMs: "Parent clock from invoking the profiler through its process exit.",
      completion: "After summary and status output; excludes completion writing and process shutdown." },
    interpretation: isolation === "default" ? "Original serial/parallel invocation; file isolation can differ." : "Worker count comparison with the same explicit file isolation.",
    platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    ...source, repetitions, files, valid, reasons, runs, groups,
    speedup: valid && parallel !== null && parallel > 0 && serial !== null ? serial / parallel : null };
  const reportPath = join(directory, "comparison.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.info(`[test-performance] comparison=${reportPath}; valid=${valid}`);
  return { exitCode: valid ? 0 : 1, reportPath, report };
}

if (import.meta.main) process.exitCode = (await compareTestPerformance(process.argv.slice(2))).exitCode;
