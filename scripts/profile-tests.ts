import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RuntimePerformanceCounter, RuntimePerformanceOperation } from "../src/runtime-performance";

const operations: RuntimePerformanceOperation[] = ["processIdentity", "fsync.file", "fsync.directory", "rename.retryWait"];
const root = resolve(import.meta.dir, "..");

export async function profileTests(args: string[]): Promise<number> {
  let workers = process.env.CGW_TEST_WORKERS || "1";
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--parallel=")) workers = arg.slice("--parallel=".length);
    else if (arg.startsWith("-")) throw new Error(`Unsupported option ${arg}; use [--parallel=1|2] [test files or directories].`);
    else files.push(arg);
  }
  if (workers !== "1" && workers !== "2") throw new Error("CGW_TEST_WORKERS / --parallel must be 1 or 2.");
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output", "test-performance"));
  mkdirSync(output, { recursive: true });
  const run = mkdtempSync(join(output, `workers-${workers}-`));
  const reports = join(run, "processes");
  mkdirSync(reports);
  const command = [process.execPath, "test", "--timeout", "30000",
    "--preload", join(root, "scripts", "test-performance-preload.ts"),
    "--timings", join(run, "file-timings.json"), "--update-timings",
    ...(workers === "2" ? ["--parallel=2"] : []),
    ...(files.length ? files : ["./tests"])];
  console.info(`[test-performance] workers=${workers}; reports=${run}`);
  const start = performance.now();
  let exitCode = 1;
  try {
    const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, CGW_RUNTIME_PERFORMANCE_DIR: reports } });
    exitCode = await child.exited;
    return exitCode;
  } finally {
    const wallMs = performance.now() - start;
    try {
      const totals = Object.fromEntries(operations.map(name => [name, { count: 0, errors: 0, totalMs: 0, maxMs: 0 }])) as
        Record<RuntimePerformanceOperation, RuntimePerformanceCounter>;
      let snapshots = 0;
      const invalidReports: string[] = [];
      for (const file of readdirSync(reports)) {
        if (!file.endsWith(".json")) continue;
        try {
          const report = JSON.parse(readFileSync(join(reports, file), "utf8"));
          if (report.version !== 1 || !report.counters || typeof report.counters !== "object") throw new Error("Invalid report");
          for (const operation of operations) {
            const counter = report.counters[operation];
            if (counter === undefined) continue;
            if (![counter.count, counter.errors, counter.totalMs, counter.maxMs].every(value => Number.isFinite(value) && value >= 0)) {
              throw new Error("Invalid counter");
            }
          }
          for (const operation of operations) {
            const counter = report.counters[operation];
            if (!counter) continue;
            totals[operation].count += counter.count;
            totals[operation].errors += counter.errors;
            totals[operation].totalMs += counter.totalMs;
            totals[operation].maxMs = Math.max(totals[operation].maxMs, counter.maxMs);
          }
          snapshots++;
        } catch { invalidReports.push(file); }
      }
      const summary = { version: 1, platform: process.platform, arch: process.arch, bunVersion: Bun.version,
        revision: process.env.GITHUB_SHA ?? null, workers: Number(workers), exitCode, wallMs, snapshots, invalidReports, totals };
      writeFileSync(join(run, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      console.info(`[test-performance] wall=${(wallMs / 1000).toFixed(2)}s; exit=${exitCode}; snapshots=${snapshots}`);
      for (const operation of operations) {
        const counter = totals[operation];
        console.info(`[test-performance] ${operation}: count=${counter.count}; total=${counter.totalMs.toFixed(2)}ms; max=${counter.maxMs.toFixed(2)}ms; errors=${counter.errors}`);
      }
      if (!snapshots || invalidReports.length) console.warn("[test-performance] Incomplete metric reports; inspect summary.json before comparing runs.");
    } catch (error) {
      console.warn(`[test-performance] Could not collect performance reports; preserving test exit=${exitCode}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (import.meta.main) process.exitCode = await profileTests(process.argv.slice(2));
