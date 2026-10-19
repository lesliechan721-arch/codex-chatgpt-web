import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { compareTestPerformance, comparisonOptions, readPerformanceSummary } from "../scripts/compare-test-performance";
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
  const current = report as { version?: number; runId?: string; segments?: { reportMs: number; totalMs: number } };
  if ((current.version === 3 || current.version === 4) && current.segments) writeFileSync(join(run, "completion.json"), JSON.stringify({ version: 1,
    runId: current.runId, segments: { ...current.segments, reportMs: current.segments.reportMs + 1, totalMs: current.segments.totalMs + 1 },
    endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"] }));
}

function fullSummary(workers: number, output: string, files: string[]) {
  return { ...summary(workers), version: 3, runId: `full-workers-${workers}`, mode: "full", isolation: "isolate", testResult: "success",
    scheduling: { source: "cold", reason: "no-history-input", lookupMs: 0, inputDigest: null as string | null, from: null },
    wallValid: true, wallInvalidReasons: [] as string[], childResultIssues: [] as string[], collection: { status: "complete" },
    segments: { prepareMs: 1, executionMs: workers === 1 ? 20 : 10, logDrainMs: 1, reportMs: 1, totalMs: 30 },
    command: [process.execPath, "test", "--timeout", "30000", "--preload", resolve(import.meta.dir, "../scripts/test-performance-preload.ts"),
      "--timings", join(output, "workers-random", "file-timings.json"), "--update-timings", ...(workers === 2 ? ["--parallel=2"] : []),
      "--isolate", ...(files.length ? files : ["./tests"])] };
}

test("v4 readers keep publication independent while retaining strict operation and file gates", () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-summary-v4-"));
  const files = ["./tests/runtime-performance.test.ts"], targetFiles = ["tests/runtime-performance.test.ts"];
  try {
    const report = { ...fullSummary(1, output, files), version: 4,
      fileTiming: { version: 2, complete: true, fullSuite: false, targetFiles, executedFiles: targetFiles, measuredFiles: targetFiles,
        reportedFiles: 1, reasons: [], logsComplete: true, sourceStable: true },
      historyPublication: { status: "failed", stage: "artifact-staging", reasons: ["disk-full"], remoteUpload: "not-observed" } };
    save(output, report);
    const read = () => readPerformanceSummary(output, 1, 0, report, { mode: "full", isolation: "isolate", files });
    expect(read().summary.historyPublication).toEqual(report.historyPublication);
    report.fileTiming.measuredFiles = ["tests/test-performance.test.ts"];
    writeFileSync(join(output, "workers-random", "summary.json"), JSON.stringify(report));
    expect(read).toThrow("incomplete-file-measurements");
    report.fileTiming.measuredFiles = targetFiles;
    report.complete = false; report.collection.status = "incomplete";
    report.incompleteReasons = ["missing-child-report:worker"];
    writeFileSync(join(output, "workers-random", "summary.json"), JSON.stringify(report));
    expect(read).toThrow("incomplete-operation-collection");
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("legacy file timing failures retain their original meaning when read", () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-summary-legacy-timing-")), files = ["./tests/example.test.ts"];
  try {
    const report = { ...fullSummary(1, output, files), fileTiming: { complete: false, reasons: ["history-publication-failed"] } };
    save(output, report);
    const read = readPerformanceSummary(output, 1, 0, report, { mode: "full", isolation: "isolate", files });
    expect(read.summary.version).toBe(3);
    expect(read.summary.fileTiming).toEqual({ complete: false, reasons: ["history-publication-failed"] });
  } finally { rmSync(output, { recursive: true, force: true }); }
});

for (const history of ["same", "different"] as const) {
  test(`worker comparison handles ${history} history in separate run snapshots`, async () => {
    const output = mkdtempSync(join(tmpdir(), "cgw-comparison-history-"));
    try {
      const result = await compareTestPerformance(["--repetitions=1", "./tests/example.test.ts"], { output, runner: async (workers, path, files) => {
        const report = fullSummary(workers, path, files), input = join(path, "workers-random", "history-input.json");
        const contents = JSON.stringify({ version: 1, files: { "tests/example.test.ts": history === "different" ? workers * 10 : 10 } });
        report.scheduling.source = "restored";
        report.scheduling.inputDigest = createHash("sha256").update(contents).digest("hex");
        report.command.splice(report.command.indexOf("--update-timings"), 0, "--timings", input);
        save(path, report); writeFileSync(input, contents); return 0;
      } });
      expect(result.report.valid).toBe(history === "same");
      expect(result.report.runs.every(run => run.error === null)).toBe(true);
      const inputs = result.report.runs.flatMap(run => run.schedulingInputs as { path: string; digest: string }[]);
      expect(new Set(inputs.map(input => input.path)).size).toBe(2);
      if (history === "different") {
        expect(result.report.reasons).toContain("different-scheduling-inputs");
        expect(result.report.speedup).toBeNull();
      }
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

for (const defect of ["source", "digest", "multiple", "missing-input"] as const) {
  test(`v3 summaries reject ${defect} scheduling evidence`, () => {
    const output = mkdtempSync(join(tmpdir(), "cgw-scheduling-"));
    try {
      const files = ["./tests/example.test.ts"], report = fullSummary(1, output, files);
      const input = join(output, "workers-random", "history-input.json"), contents = '{"version":1,"files":{"tests/example.test.ts":10}}';
      report.scheduling.source = defect === "source" ? "cold" : "restored";
      report.scheduling.inputDigest = defect === "digest" ? "0".repeat(64) : createHash("sha256").update(contents).digest("hex");
      if (defect !== "missing-input") report.command.splice(report.command.indexOf("--update-timings"), 0, "--timings", input);
      if (defect === "multiple") report.command.splice(report.command.indexOf("--update-timings"), 0, "--timings", input);
      save(output, report); writeFileSync(input, contents);
      expect(() => readPerformanceSummary(output, 1, 0, report, { mode: "full", isolation: "isolate", files })).toThrow(/scheduling/);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

for (const defect of ["missing", "run", "boundary", "phase", "finite"] as const) {
  test(`v3 summaries reject ${defect} completion evidence`, () => {
    const output = mkdtempSync(join(tmpdir(), "cgw-completion-"));
    try {
      const files = ["./tests/example.test.ts"], report = fullSummary(1, output, files);
      save(output, report);
      const path = join(output, "workers-random", "completion.json"), completion = JSON.parse(readFileSync(path, "utf8"));
      if (defect === "missing") rmSync(path);
      else {
        if (defect === "run") completion.runId = "another-run";
        if (defect === "boundary") completion.endPoint = "before-summary";
        if (defect === "phase") completion.segments.executionMs += 1;
        if (defect === "finite") completion.segments.totalMs = null;
        writeFileSync(path, JSON.stringify(completion));
      }
      expect(() => readPerformanceSummary(output, 1, 0, report, { mode: "full", isolation: "isolate", files })).toThrow(/completion/);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

test("controlled worker comparison rejects v2 rather than inferring isolation", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-legacy-"));
  try {
    const result = await compareTestPerformance(["--repetitions=1"], { output, runner: async (workers, path) => {
      save(path, summary(workers)); return 0;
    } });
    expect(result.report.valid).toBe(false);
    expect(result.report.runs[0]!.invalidReasons).toContain("legacy-summary-requires-full-default");
  } finally { rmSync(output, { recursive: true, force: true }); }
});

for (const defect of ["none", "mode", "isolation", "scope", "collection", "child-results", "wall-status", "test-result", "exit"] as const) {
  test(`v3 full comparison validates ${defect} and keeps rejected reports`, async () => {
    const output = mkdtempSync(join(tmpdir(), "cgw-comparison-v3-"));
    try {
      const result = await compareTestPerformance(["--repetitions=1", "./tests/example.test.ts"], { output, runner: async (workers, path, files) => {
        const report = fullSummary(workers, path, files);
        if (workers === 1) {
          if (defect === "mode") report.mode = "timing";
          if (defect === "isolation") report.isolation = "shared";
          if (defect === "scope") report.command[report.command.length - 1] = "./tests/another.test.ts";
          if (defect === "collection") report.snapshots = 0;
          if (defect === "child-results") report.childResultIssues = ["unexpected-child-nonzero"];
          if (defect === "wall-status") report.wallValid = false;
          if (defect === "test-result") report.testResult = "assertion-failure";
          if (defect === "exit") report.exitCode = 17;
        }
        save(path, report); return report.exitCode;
      } });
      expect(result.report.valid).toBe(defect === "none");
      expect(result.report.runs[0]!.summaryPath).toBeString();
      if (defect !== "none") {
        expect(result.report.speedup).toBeNull();
        expect(result.report.runs[0]!.invalidReasons.length).toBeGreaterThan(0);
        expect(JSON.parse(readFileSync(join(dirname(result.reportPath), result.report.runs[0]!.summaryPath!), "utf8")).version).toBe(3);
      }
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
}

test("timing comparison accepts only successful v3 wall clocks and keeps collection unavailable", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-timing-"));
  try {
    const result = await compareTestPerformance(["--repetitions=1", "--mode=timing", "./tests/example.test.ts"], {
      output, runner: async (workers, path, files, settings) => {
        expect(settings).toEqual({ mode: "timing", isolation: "isolate" });
        const run = join(path, "workers-random");
        save(path, { ...summary(workers), version: 3, runId: `timing-workers-${workers}`, mode: "timing", isolation: "isolate",
          scheduling: { source: "cold", reason: "no-history-input", lookupMs: 0, inputDigest: null, from: null },
          complete: false, incompleteReasons: [], collection: { status: "not-requested" },
          snapshots: 0, totals: {}, testResult: "success", wallValid: true, wallInvalidReasons: [],
          segments: { prepareMs: 1, executionMs: workers === 1 ? 20 : 10, logDrainMs: 1, reportMs: 1, totalMs: 30 },
          command: [process.execPath, "test", "--timeout", "30000", "--timings", join(run, "file-timings.json"),
            "--update-timings", ...(workers === 2 ? ["--parallel=2"] : []), "--isolate", ...files] });
        return 0;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.report.speedup).toBe(2);
    expect(result.report.groups.map(group => group.medianWallMs)).toEqual([20, 10]);
    expect(result.report.runs.every(run => run.collection === "not-requested")).toBe(true);
    expect(result.report.runs.every(run => run.wrapperExitMs! > 0 && run.completionPath !== null)).toBe(true);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("comparison alternates worker order and preserves separate original reports", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-comparison-"));
  const order: number[] = [];
  try {
    const result = await compareTestPerformance(["--isolation=default", "./tests/example.test.ts"], { output, runner: async (workers, path, files) => {
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
    const result = await compareTestPerformance(["--isolation=default"], { output, runner: async (workers, path) => {
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
      const result = await compareTestPerformance(["--repetitions=1", "--isolation=default"], { output, runner: async (workers, path) => {
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
    const result = await compareTestPerformance(["--repetitions=1", "--isolation=default"], { output, runner: async (workers, path) => {
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
