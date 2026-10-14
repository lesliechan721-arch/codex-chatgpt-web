import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { performanceSource } from "./test-performance-source";
import { validCounter } from "./test-performance-reports";

const root = resolve(import.meta.dir, "..");
type Workers = 1 | 2;
type Runner = (workers: Workers, output: string, files: string[]) => Promise<number>;

export function comparisonOptions(args: string[]) {
  let repetitions = 2;
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--repetitions=")) {
      const value = arg.slice("--repetitions=".length);
      if (!["1", "2", "3"].includes(value)) throw new Error("--repetitions must be 1, 2 or 3.");
      repetitions = Number(value);
    } else if (arg.startsWith("-")) throw new Error(`Unsupported option ${arg}; use [--repetitions=1|2|3] [test files or directories].`);
    else files.push(arg);
  }
  return { repetitions, files };
}

const runProfiler: Runner = async (workers, output, files) => {
  const child = Bun.spawn([process.execPath, join(root, "scripts", "profile-tests.ts"), `--parallel=${workers}`, ...files], {
    cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, CGW_TEST_PROFILE_DIR: output },
  });
  return await child.exited;
};

export function readPerformanceSummary(output: string, workers: Workers, exitCode: number, source: ReturnType<typeof performanceSource>) {
  const candidates = readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory());
  if (candidates.length !== 1) throw new Error("Expected exactly one profile run directory.");
  const path = join(output, candidates[0]!.name, "summary.json");
  const summary = JSON.parse(readFileSync(path, "utf8"));
  if (summary.version !== 2 || summary.complete !== true || summary.known !== true || summary.workers !== workers || summary.exitCode !== exitCode
    || summary.platform !== process.platform || summary.arch !== process.arch || summary.bunVersion !== Bun.version
    || summary.revision !== source.revision || summary.patchDigest !== source.patchDigest || summary.toolDigest !== source.toolDigest || summary.nodeVersion !== source.nodeVersion
    || JSON.stringify(summary.measurementFiles) !== JSON.stringify(source.measurementFiles)
    || !Array.isArray(summary.incompleteReasons) || summary.incompleteReasons.length !== 0
    || !Number.isFinite(summary.wallMs) || summary.wallMs < 0
    || !Number.isInteger(summary.snapshots) || summary.snapshots < 1
    || !summary.counts || ![summary.counts.pass, summary.counts.skip, summary.counts.fail]
      .every(value => Number.isInteger(value) && value >= 0)
    || !Array.isArray(summary.invalidReports) || summary.invalidReports.length !== 0
    || !summary.totals || typeof summary.totals !== "object" || Array.isArray(summary.totals)
    || Object.keys(summary.totals).length === 0) throw new Error("Incomplete or invalid profile summary.");
  for (const counter of Object.values(summary.totals) as Record<string, unknown>[]) {
    if (!counter || typeof counter !== "object" || Array.isArray(counter)
      || !validCounter(counter)) {
      throw new Error("Invalid profile counter.");
    }
  }
  return { path, summary };
}

export async function compareTestPerformance(args: string[], options: { output?: string; runner?: Runner } = {}) {
  const { repetitions, files } = comparisonOptions(args);
  const output = resolve(options.output ?? process.env.CGW_TEST_PROFILE_DIR ?? join(root, "output", "test-performance"));
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "comparison-"));
  const source = performanceSource(root);
  const runs: { round: number; workers: Workers; output: string; exitCode: number | null; wallMs: number | null; summaryPath: string | null; counts: unknown; error: string | null }[] = [];
  for (let round = 1; round <= repetitions; round++) {
    const order: Workers[] = round % 2 ? [1, 2] : [2, 1];
    for (const workers of order) {
      const runOutput = join(directory, `run-${runs.length + 1}-workers-${workers}`);
      mkdirSync(runOutput);
      const run = { round, workers, output: runOutput, exitCode: null as number | null, wallMs: null as number | null,
        summaryPath: null as string | null, counts: null as unknown, error: null as string | null };
      try {
        run.exitCode = await (options.runner ?? runProfiler)(workers, runOutput, files);
        const { path, summary } = readPerformanceSummary(runOutput, workers, run.exitCode, source);
        run.wallMs = summary.wallMs;
        run.counts = summary.counts;
        run.summaryPath = relative(directory, path);
      } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
      run.output = relative(directory, runOutput);
      runs.push(run);
    }
  }
  const after = performanceSource(root);
  const valid = source.known && source.revision === after.revision && source.patchDigest === after.patchDigest && source.toolDigest === after.toolDigest
    && runs.every(run => run.exitCode === 0 && run.error === null && run.wallMs !== null)
    && new Set(runs.map(run => JSON.stringify(run.counts))).size === 1;
  const groups = [1, 2].map(workers => {
    const group = runs.filter(run => run.workers === workers);
    const durations = group.flatMap(run => run.wallMs === null ? [] : [run.wallMs]);
    return { workers, runs: group.length, failures: group.filter(run => run.exitCode !== 0).length,
      failureRate: group.filter(run => run.exitCode !== 0).length / group.length,
      invalidReports: group.filter(run => run.error !== null).length,
      wallMs: durations, totalWallMs: durations.reduce((sum, value) => sum + value, 0),
      meanWallMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null };
  });
  const serial = groups[0]!.meanWallMs, parallel = groups[1]!.meanWallMs;
  const report = { version: 2, mode: "workers", platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    ...source, repetitions, files, valid, runs, groups,
    speedup: valid && parallel !== null && parallel > 0 && serial !== null ? serial / parallel : null };
  const reportPath = join(directory, "comparison.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.info(`[test-performance] comparison=${reportPath}; valid=${valid}`);
  return { exitCode: valid ? 0 : 1, reportPath, report };
}

if (import.meta.main) process.exitCode = (await compareTestPerformance(process.argv.slice(2))).exitCode;
