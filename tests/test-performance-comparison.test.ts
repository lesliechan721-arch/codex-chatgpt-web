import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTestPerformance, comparisonOptions } from "../scripts/compare-test-performance";

function summary(workers: number, exitCode = 0) {
  return { version: 1, platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    revision: process.env.GITHUB_SHA ?? null, workers, exitCode, wallMs: workers === 1 ? 20 : 10,
    snapshots: 1, invalidReports: [], totals: { "recovery.write": { count: 1, errors: 0, totalMs: 2, maxMs: 2, totalBytes: 7 } } };
}

function save(output: string, report: unknown) {
  const run = join(output, "workers-random");
  mkdirSync(run);
  writeFileSync(join(run, "summary.json"), JSON.stringify(report));
}

test("comparison alternates worker order and preserves separate original reports", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-"));
  const order: number[] = [];
  try {
    const result = await compareTestPerformance(["./tests/example.test.ts"], { output, runner: async (workers, path, files) => {
      order.push(workers);
      expect(files).toEqual(["./tests/example.test.ts"]);
      save(path, summary(workers));
      return 0;
    } });
    expect(order).toEqual([1, 2, 2, 1]);
    expect(result.exitCode).toBe(0);
    expect(result.report.valid).toBe(true);
    expect(typeof result.report.workingTreeDirty).toBe("boolean");
    expect(result.report.speedup).toBe(2);
    expect(result.report.groups.map(group => group.failures)).toEqual([0, 0]);
    expect(new Set(result.report.runs.map(run => run.summaryPath)).size).toBe(4);
    for (const run of result.report.runs) expect(JSON.parse(readFileSync(run.summaryPath!, "utf8")).totals["recovery.write"].totalBytes).toBe(7);
    expect(JSON.parse(readFileSync(result.reportPath, "utf8")).valid).toBe(true);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("comparison continues after test failures and preserves every exit code", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-fail-"));
  const exits = [23, 0, 7, 0];
  let calls = 0;
  try {
    const result = await compareTestPerformance([], { output, runner: async (workers, path) => {
      const exitCode = exits[calls++]!;
      save(path, summary(workers, exitCode));
      return exitCode;
    } });
    expect(calls).toBe(4);
    expect(result.report.runs.map(run => run.exitCode)).toEqual(exits);
    expect(result.report.groups.map(group => group.failures)).toEqual([1, 1]);
    expect(result.report.groups.map(group => group.failureRate)).toEqual([0.5, 0.5]);
    expect(result.exitCode).toBe(1);
    expect(result.report.valid).toBe(false);
    expect(result.report.speedup).toBeNull();
  } finally { rmSync(output, { recursive: true, force: true }); }
});

for (const defect of ["missing", "json", "snapshots", "invalidReports", "wallMs", "workers", "exitCode", "counter", "version", "bunVersion"]) {
  test(`comparison rejects ${defect} reports and continues`, async () => {
    const output = mkdtempSync(join(tmpdir(), "cgw-comparison-invalid-"));
    let calls = 0;
    try {
      const result = await compareTestPerformance(["--repetitions=1"], { output, runner: async (workers, path) => {
        calls++;
        if (calls === 1) {
          const report = summary(workers);
          if (defect === "missing") return 0;
          if (defect === "json") { mkdirSync(join(path, "run")); writeFileSync(join(path, "run", "summary.json"), "{"); return 0; }
          if (defect === "snapshots") report.snapshots = 0;
          if (defect === "invalidReports") (report.invalidReports as string[]).push("bad.json");
          if (defect === "wallMs") report.wallMs = -1;
          if (defect === "workers") report.workers = 2;
          if (defect === "exitCode") report.exitCode = 3;
          if (defect === "counter") report.totals["recovery.write"].totalBytes = -1;
          if (defect === "version") report.version = 2;
          if (defect === "bunVersion") report.bunVersion = "different";
          save(path, report);
        } else save(path, summary(workers));
        return 0;
      } });
      expect(calls).toBe(2);
      expect(result.exitCode).toBe(1);
      expect(result.report.valid).toBe(false);
      expect(result.report.speedup).toBeNull();
      expect(result.report.runs[0]!.exitCode).toBe(0);
      expect(result.report.runs[0]!.error).toBeString();
      expect(result.report.runs[1]!.error).toBeNull();
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

test("comparison records spawn failure and still runs the remaining measurements", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-spawn-"));
  let calls = 0;
  try {
    const result = await compareTestPerformance(["--repetitions=1"], { output, runner: async (workers, path) => {
      if (++calls === 1) throw new Error("spawn failed");
      save(path, summary(workers));
      return 0;
    } });
    expect(calls).toBe(2);
    expect(result.report.runs[0]).toMatchObject({ exitCode: null, error: "spawn failed" });
    expect(result.exitCode).toBe(1);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("comparison accepts only one to three repetitions", () => {
  expect(comparisonOptions([]).repetitions).toBe(2);
  for (const count of [1, 2, 3]) expect(comparisonOptions([`--repetitions=${count}`]).repetitions).toBe(count);
  for (const arg of ["--repetitions=0", "--repetitions=4", "--repetitions=01", "--parallel=2"]) {
    expect(() => comparisonOptions([arg])).toThrow();
  }
});
