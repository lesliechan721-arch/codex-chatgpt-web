import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { compareTestPerformance, comparisonOptions } from "../scripts/compare-test-performance";
import { performanceSource, measurementFingerprint, MEASUREMENT_FILES } from "../scripts/test-performance-source";

function summary(workers: number, exitCode = 0) {
  return { version: 2, platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    ...performanceSource(join(import.meta.dir, "..")), complete: true, incompleteReasons: [] as string[], workers, exitCode, wallMs: workers === 1 ? 20 : 10,
    counts: { pass: 1, skip: 0, fail: 0 },
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
    for (const run of result.report.runs) expect(JSON.parse(readFileSync(join(dirname(result.reportPath), run.summaryPath!), "utf8")).totals["recovery.write"].totalBytes).toBe(7);
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

for (const defect of ["missing", "json", "snapshots", "invalidReports", "wallMs", "workers", "exitCode", "counter", "version", "bunVersion", "complete", "incompleteReasons", "revision", "patchDigest", "toolDigest", "measurementFiles", "known"]) {
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
          if (defect === "version") report.version = 1;
          if (defect === "bunVersion") report.bunVersion = "different";
          if (defect === "complete") report.complete = false;
          if (defect === "incompleteReasons") report.incompleteReasons.push("missing-child-report");
          if (defect === "revision") report.revision = "0".repeat(40);
          if (defect === "patchDigest") report.patchDigest = "0".repeat(64);
          if (defect === "toolDigest") report.toolDigest = "0".repeat(64);
          if (defect === "measurementFiles") report.measurementFiles = [];
          if (defect === "known") report.known = false;
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

test("measurement fingerprint includes every production and fixture probe file", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-measurement-patch-"));
  try {
    for (const file of MEASUREMENT_FILES) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), readFileSync(resolve(import.meta.dir, "..", file)));
    }
    const original = measurementFingerprint(directory);
    expect(original.measurementFiles.map(entry => entry.file)).toEqual([...MEASUREMENT_FILES]);
    for (const file of ["src/adapters/chatgpt-web/continuity-recovery-store.ts", "src/adapters/chatgpt-web/recovery-durability.ts",
      "tests/session-continuity-adapter.test.ts", "tests/helpers/session-continuity-fixture.ts",
      "tests/helpers/retained-compaction-fixture.ts", "tests/helpers/retained-fixture-cleanup.ts"]) {
      const contents = readFileSync(join(directory, file));
      writeFileSync(join(directory, file), Buffer.concat([contents, Buffer.from("\n// different measurement patch\n")]));
      expect(measurementFingerprint(directory).toolDigest).not.toBe(original.toolDigest);
      writeFileSync(join(directory, file), contents);
    }
    expect(measurementFingerprint(directory).toolDigest).toBe(original.toolDigest);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
