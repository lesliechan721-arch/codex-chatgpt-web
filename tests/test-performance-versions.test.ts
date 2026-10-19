import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { compareTestVersions, executeVersionSample, externalWallClock, freezeVersionMeasurementTools, prepareVersionComparison,
  qualifyVersionSample, scheduleVersionSamples, summarizeVersionSamples, versionComparisonOptions, versionSampleResult, versionTimerProtocol } from "../scripts/compare-test-versions";
import { MEASUREMENT_FILES, performanceSource } from "../scripts/test-performance-source";

function checkouts(candidateTest?: string) {
  const directory = mkdtempSync(join(tmpdir(), "cgw-versions-"));
  const A = join(directory, "A"), B = join(directory, "B"), output = join(directory, "output");
  for (const [version, cwd] of [["A", A], ["B", B]] as const) {
    mkdirSync(cwd);
    for (const args of [["init", "-q"], ["-c", "user.name=Performance Test", "-c", "user.email=performance@example.invalid", "commit", "-q", "--allow-empty", "-m", "test fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    for (const file of MEASUREMENT_FILES) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), "export {};\n");
    }
    mkdirSync(join(cwd, "launcher"), { recursive: true });
    writeFileSync(join(cwd, "bun.lock"), "fixed root dependencies\n");
    writeFileSync(join(cwd, "launcher/bun.lock"), "fixed launcher dependencies\n");
    writeFileSync(join(cwd, "tests/equivalent.test.ts"), version === "B" && candidateTest ? candidateTest :
      `import { test, expect } from "bun:test";\ntest("${version} scenario", () => expect(1 + 1).toBe(2));\n`);
    writeFileSync(join(cwd, "tests/second.test.ts"), 'import { test, expect } from "bun:test"; test("second scenario", () => expect(true).toBe(true));\n');
  }
  const files = ["./tests/equivalent.test.ts", "./tests/second.test.ts"];
  const mapPath = join(directory, "coverage.json");
  const map = { version: 1, sources: { A: performanceSource(A), B: performanceSource(B) }, files: { A: files, B: files },
    expectedCounts: { A: { pass: 2, skip: 0 }, B: { pass: 2, skip: 0 } },
    measurementChanges: [] as { file: string; reason: string; scenarioIds: string[] }[],
    preparation: { installation: "Synthetic checkouts without package installation.", warmup: "No warmup.", cache: "Cold timing inputs on every run.", cleanup: "Independent per-test state and a new process per sample." },
    scenarios: [{ id: "equivalent behavior", A: ["equivalent.test.ts: A scenario"], B: ["equivalent.test.ts: B scenario"] },
      { id: "second behavior", A: ["second.test.ts: second scenario"], B: ["second.test.ts: second scenario"] }] };
  const saveMap = () => writeFileSync(mapPath, JSON.stringify(map));
  saveMap();
  return { directory, A, B, output, files, map, mapPath, saveMap,
    args: [`--baseline=${A}`, `--candidate=${B}`], failed: false, preserveOriginal: false,
    clean() {
      if (this.preserveOriginal) return;
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { if (this.failed) console.error("Fixture cleanup failed after the primary failure", error); else throw error; }
    } };
}

function prepareWrapper(fixture: ReturnType<typeof checkouts>) {
  const root = resolve(import.meta.dir, "..");
  for (const cwd of [fixture.A, fixture.B]) for (const { file } of freezeVersionMeasurementTools(root).files) {
    copyFileSync(join(root, file), join(cwd, file));
  }
  fixture.map.sources = { A: performanceSource(fixture.A), B: performanceSource(fixture.B) };
  fixture.saveMap();
  return [...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`];
}

// Report-rule inputs have private real path objects but do not claim a Git
// measurement. Real source discovery remains in the source/identity contracts.
function reportQualificationFixture() {
  const directory = mkdtempSync(join(tmpdir(), "cgw-report-rules-"));
  const A = join(directory, "A"), B = join(directory, "B");
  const files = ["./tests/equivalent.test.ts", "./tests/second.test.ts"];
  mkdirSync(join(A, "tests"), { recursive: true });
  mkdirSync(join(A, "scripts"));
  mkdirSync(B);
  for (const file of [...files, "scripts/test-performance-preload.ts"]) writeFileSync(join(A, file), "export {};\n");
  writeFileSync(join(A, "bun.lock"), "fixed root dependencies\n");
  const source: ReturnType<typeof performanceSource> = {
    revision: "1".repeat(40), workflowRevision: null, nodeVersion: "v0.0.0", workingTreeDirty: false,
    patchDigest: "2".repeat(64), toolVersion: 3, toolDigest: "3".repeat(64),
    measurementFiles: [{ file: "scripts/test-performance-preload.ts", digest: "4".repeat(64) }], known: true,
  };
  return { directory, A, B, files, source, failed: false, preserveOriginal: false,
    clean() {
      if (this.preserveOriginal) return;
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { if (this.failed) console.error("Fixture cleanup failed after the primary failure", error); else throw error; }
    } };
}

// These are rule inputs, not claims that a wrapper executed. Paths and Bun
// identity still use real private files and the current executable object.
function qualificationEvidence(fixture: Pick<ReturnType<typeof checkouts>, "A" | "directory" | "files">,
  settings: { mode: "full" | "timing"; isolation: "default" | "isolate" } = { mode: "full", isolation: "default" },
  source: ReturnType<typeof performanceSource> = performanceSource(fixture.A)) {
  const cwd = fixture.A, output = join(fixture.directory, "qualification"), run = join(output, "workers-rule");
  mkdirSync(run, { recursive: true });
  const files = ["tests/equivalent.test.ts", "tests/second.test.ts"];
  const executableDigest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const segments = { prepareMs: 1, executionMs: 10, logDrainMs: 1, reportMs: 1, totalMs: 13 };
  const summary = { ...source, version: 4, runId: "qualification-rule", workers: 2, ...settings,
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, cwd,
    executable: { path: process.execPath, sha256: executableDigest },
    dependencyDigest: createHash("sha256").update(readFileSync(join(cwd, "bun.lock"))).digest("hex"),
    exitCode: 0, signal: null, spawnError: null, testResult: "success", counts: { pass: 2, skip: 0, fail: 0 },
    wallValid: true, wallInvalidReasons: [] as string[], wallMs: 10, segments,
    collection: { status: "incomplete" }, scheduling: { source: "cold", inputDigest: null as string | null },
    command: [process.execPath, "test", "--timeout", "30000",
      ...(settings.mode === "full" ? ["--preload", join(cwd, "scripts/test-performance-preload.ts")] : []),
      "--timings", join(run, "file-timings.json"), "--update-timings", "--parallel=2",
      ...(settings.isolation === "isolate" ? ["--isolate"] : []), ...fixture.files],
    fileTiming: { version: 2, complete: true, fullSuite: false, logsComplete: true, sourceStable: true, reasons: [] as string[],
      targetFiles: files, executedFiles: files, measuredFiles: files, reportedFiles: 2 } };
  const completion = { version: 1, runId: summary.runId, segments: { ...segments, reportMs: 2, totalMs: 14 },
    endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"] };
  const save = () => {
    writeFileSync(join(run, "summary.json"), JSON.stringify(summary));
    writeFileSync(join(run, "completion.json"), JSON.stringify(completion));
  };
  writeFileSync(join(run, "file-timings.json"), JSON.stringify({ version: 1, files: Object.fromEntries(files.map(file => [file, 5])) }));
  const body = "tests/equivalent.test.ts:\n(pass) A scenario\ntests/second.test.ts:\n(pass) second scenario\n\n2 pass\n0 fail\nRan 2 tests across 2 files.\n";
  writeFileSync(join(output, "stderr.log"), body);
  save();
  const qualify = (expectedSkips?: unknown, expectedCounts = { pass: 2, skip: 0 }) => qualifyVersionSample(cwd, output, fixture.files,
    expectedCounts, expectedSkips, settings, source, executableDigest, { exitCode: 0, invalidReasons: [] });
  return { output, run, summary, completion, source, body, save, qualify };
}

async function singleWrapper(fixture: ReturnType<typeof checkouts>, version: "A" | "B", settings: { mode: "full" | "timing"; isolation: "default" | "isolate" }) {
  mkdirSync(fixture.output, { recursive: true });
  const cwd = fixture[version];
  return executeVersionSample(cwd, fixture.output, fixture.files, fixture.map.expectedCounts[version], undefined,
    settings, performanceSource(cwd), createHash("sha256").update(readFileSync(process.execPath)).digest("hex"));
}

function preserveComparisonFailure(fixture: Pick<ReturnType<typeof checkouts>, "directory" | "failed" | "preserveOriginal">, error: unknown): never {
  fixture.failed = true;
  const destination = join(process.env.CGW_TEST_PROFILE_DIR || join(tmpdir(), "cgw-version-regression-failures"), basename(fixture.directory));
  try {
    cpSync(fixture.directory, destination, { recursive: true });
    console.error(`Failed comparison fixture retained at ${destination}`);
  } catch (saveError) {
    fixture.preserveOriginal = true;
    console.error(`Could not copy failed comparison fixture; original retained at ${resolve(fixture.directory)}`, saveError);
  }
  throw error;
}

test("source identity accepts directory aliases but rejects a repository subdirectory", () => {
  const fixture = checkouts();
  try {
    // Missing measurement files must not mask a broken repository-root check.
    for (const file of MEASUREMENT_FILES) {
      mkdirSync(dirname(join(fixture.A, "tests", file)), { recursive: true });
      writeFileSync(join(fixture.A, "tests", file), "export {};\n");
    }
    const alias = join(fixture.directory, "alias");
    symlinkSync(fixture.A, alias, process.platform === "win32" ? "junction" : "dir");
    const original = performanceSource(fixture.A), aliased = performanceSource(alias);
    expect(original.known).toBe(true);
    expect(aliased).toEqual(original);
    expect(performanceSource(join(fixture.A, "tests")).known).toBe(false);
    if (process.platform === "win32") expect(performanceSource(fixture.A.toUpperCase())).toEqual(original);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("cross-version wall clocks require explicit coverage bound to source and scope", async () => {
  const fixture = checkouts();
  try {
    const missing = await compareTestVersions([...fixture.args, "--wall-clock"], fixture.output);
    expect(missing.report.reasons).toContain("missing-coverage-map");
    expect(missing.report.runs).toHaveLength(0);
    fixture.map.sources.B.patchDigest = "0".repeat(64); fixture.saveMap();
    const mismatch = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(mismatch.report.reasons).toContain("coverage-source-mismatch-B");
    fixture.map.sources.B = performanceSource(fixture.B); fixture.saveMap();
    const scope = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`, "./tests/another.test.ts"], fixture.output);
    expect(scope.report.reasons).toContain("coverage-scope-mismatch-A");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("coverage maps require finite reviewed pass and skip counts for each source", async () => {
  const fixture = checkouts();
  try {
    for (const counts of [null, { pass: 0, skip: 0 }, { pass: 2, skip: -1 }, { pass: 2.5, skip: 0 }, { pass: 2, skip: Infinity }]) {
      writeFileSync(fixture.mapPath, JSON.stringify({ ...fixture.map, expectedCounts: { A: fixture.map.expectedCounts.A, B: counts } }));
      const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
      expect(result.report.reasons).toContain("invalid-expected-counts-B");
      expect(result.report.runs).toHaveLength(0);
    }
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("external driver runs AB BA AB with different fixture tools and equivalent split scenarios", async () => {
  const fixture = checkouts('import { test, expect } from "bun:test"; test("B split one", () => expect(1).toBe(1)); test("B split two", () => expect(2).toBe(2));\n');
  try {
    writeFileSync(join(fixture.B, "tests/helpers/session-continuity-fixture.ts"), "// candidate fixture implementation\n");
    fixture.map.sources.B = performanceSource(fixture.B);
    fixture.map.scenarios[0]!.B = ["equivalent.test.ts: B split one", "equivalent.test.ts: B split two"];
    fixture.map.expectedCounts.B.pass = 3;
    fixture.map.measurementChanges = [{ file: "tests/helpers/session-continuity-fixture.ts", reason: "Candidate uses the mapped split scenarios with a cheaper fixture.", scenarioIds: ["equivalent behavior"] }];
    fixture.saveMap();
    const full = await compareTestVersions(fixture.args, fixture.output);
    expect(full.report.reasons).toContain("different-measurement-tools");
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(0);
    expect(result.report.order).toEqual(["A", "B", "B", "A", "A", "B"]);
    expect(result.report.runs.map(run => run.pair)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(result.report.runs.filter(run => run.version === "A").every(run => (run.counts as any).pass === 2)).toBe(true);
    expect(result.report.runs.filter(run => run.version === "B").every(run => (run.counts as any).pass === 3)).toBe(true);
    expect(result.report.differences.business.map(change => change.file)).toContain("tests/helpers/session-continuity-fixture.ts");
    expect(result.report.groups.every(group => group.wallMs.length === 3 && group.medianWallMs! > 0 && group.rangeWallMs!.min > 0)).toBe(true);
    for (const run of result.report.runs) {
      const raw = JSON.parse(readFileSync(join(dirname(result.reportPath), run.summary!), "utf8"));
      expect(raw.command).toEqual([process.execPath, "test", "--timeout", "30000", "--parallel=2", "--isolate", ...fixture.files]);
      expect(raw.collection.status).toBe("not-requested");
    }
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("wall clocks reject candidate skips outside the reviewed coverage counts", async () => {
  const fixture = checkouts('import { test } from "bun:test"; test.skip("B omitted scenario", () => {});\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").every(run => run.invalidReasons.includes("unexpected-test-coverage-counts"))).toBe(true);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("wall clocks reject coverage changes between repeated runs of one version", async () => {
  const fixture = checkouts(`import { test } from "bun:test";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const marker = "../candidate-run-count.txt";
    const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    writeFileSync(marker, String(count + 1));
    test("B scenario", () => {});
    if (count === 0) test("B intermittent scenario", () => {});
  `);
  try {
    fixture.map.expectedCounts.B.pass = 3; fixture.saveMap();
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("unstable-test-coverage-counts-B");
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").map(run => (run.counts as any).pass)).toEqual([3, 2, 2]);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("external wall clocks reject source changes during execution", async () => {
  const fixture = checkouts('import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("changes source", () => writeFileSync("changed-source.txt", "modified during test"));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("changed-source-B");
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.some(run => run.error === "changed-source-B" && run.summary !== null)).toBe(true);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("a removed coverage map invalidates the result and preserves every measured sample", async () => {
  const fixture = checkouts('import { test } from "bun:test"; import { rmSync } from "node:fs"; test("removes coverage", () => rmSync("../coverage.json", { force: true }));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("changed-coverage-map");
    expect(result.report.runs).toHaveLength(6);
    expect(result.report.runs.every(run => run.summary !== null)).toBe(true);
    expect(JSON.parse(readFileSync(result.reportPath, "utf8")).runs).toHaveLength(6);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("external wall clocks preserve nonzero results and reject success-path speedups", async () => {
  const fixture = checkouts('import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").every(run => run.exitCode !== 0 && run.invalidReasons.includes("tests-did-not-succeed") && run.summary !== null)).toBe(true);
    expect(result.report.conclusion).toBe("invalid");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("a broken wall-clock log destination still drains large child output and preserves its exit", async () => {
  const fixture = checkouts();
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), `import { test } from "bun:test";
      import { writeSync } from "node:fs";
      test("large output", () => { const chunk = Buffer.alloc(4096, 120); for (let i = 0; i < 1024; i++) writeSync(1, chunk); });
    `);
    mkdirSync(fixture.output, { recursive: true });
    mkdirSync(join(fixture.output, "stdout.log"));
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 2, skip: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("log-write-failed:stdout.log");
    expect(result.counts).toEqual({ pass: 2, skip: 0, fail: 0 });
    expect(JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8")).exitCode).toBe(0);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("wall-clock test roots and their children receive no timing credentials or controls", async () => {
  const fixture = checkouts();
  const variables = { CGW_TEST_TIMING_TOKEN: "synthetic-test-token", CGW_TEST_TIMING_RESTORE: "1",
    CGW_TEST_TIMING_ARTIFACT_DIR: "/synthetic/artifacts", CGW_TEST_TIMING_HISTORY: "/synthetic/history.json" };
  const previous = new Map(Object.keys(variables).map(key => [key, process.env[key]]));
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), `import { test, expect } from "bun:test";
      test("root environment", () => {
        expect(Object.keys(process.env).filter(key => key.startsWith("CGW_TEST_TIMING_"))).toEqual([]);
        console.log("root timing environment clean");
      });
      test("spawned child environment", () => {
        const child = Bun.spawnSync([process.execPath, "-e", 'const keys = Object.keys(process.env).filter(key => key.startsWith("CGW_TEST_TIMING_")); console.log(JSON.stringify(keys)); process.exit(keys.length ? 23 : 0)'], { stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(child.stdout.toString())).toEqual([]);
        console.log("child timing environment clean");
      });
    `);
    mkdirSync(fixture.output, { recursive: true });
    for (const [key, value] of Object.entries(variables)) process.env[key] = value;
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 3, skip: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.counts).toEqual({ pass: 3, skip: 0, fail: 0 });
    const stdout = readFileSync(join(fixture.output, "stdout.log"), "utf8"), stderr = readFileSync(join(fixture.output, "stderr.log"), "utf8");
    expect(stdout + stderr).toContain("root timing environment clean");
    expect(stdout + stderr).toContain("child timing environment clean");
    expect(stderr).toContain("3 pass");
    expect(JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8")).exitCode).toBe(0);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fixture.clean();
  }
});

test("version options keep wall-clock coverage opt-in", () => {
  expect(() => versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--coverage-map=/tmp/map"])).toThrow();
  expect(versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--wall-clock"]).wallClock).toBe(true);
  expect(() => versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--wall-clock", "--mode=timing"])).toThrow();
  expect(() => versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--mode=full", "--isolation=default"])).toThrow();
  expect(versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--wall-clock", "--mode=timing", "--isolation=default"]).settings)
    .toEqual({ mode: "timing", isolation: "default" });
});

test("wrapper wall clocks freeze common tools and measure fixed timing/default through actual exit", async () => {
  const fixture = checkouts();
  try {
    const args = prepareWrapper(fixture), manifest = join(fixture.directory, "frozen-measurement.json");
    writeFileSync(manifest, JSON.stringify(freezeVersionMeasurementTools(fixture.A)));
    const result = await compareTestVersions([...args, "--mode=timing", "--isolation=default", `--measurement-manifest=${manifest}`], fixture.output);
    expect(result.report.runs.flatMap(run => run.invalidReasons)).toEqual([]);
    expect(result.report.reasons).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.report.timer).toEqual(versionTimerProtocol);
    expect(result.report.measurementMode).toBe("timing");
    expect(result.report.isolation).toBe("default");
    expect(result.report.order).toEqual(["A", "B", "B", "A", "A", "B"]);
    expect(result.report.pairedStatistics.metric).toBe("wrapperExitMs");
    expect(result.report.commonTools).toEqual(JSON.parse(readFileSync(manifest, "utf8")));
    for (const run of result.report.runs) {
      expect(run.wrapperExitMs!).toBeGreaterThan(run.wallMs!);
      expect(run.parentReportMs!).toBeGreaterThan(0);
      expect(run.parentLogDrainMs!).toBeGreaterThanOrEqual(0);
      expect(run.command).toContain("--mode=timing");
      expect(run.command).toContain("--isolation=default");
      expect(run.workerEvidence).toContain("unverified");
      expect(run.actualFiles).toEqual(["tests/equivalent.test.ts", "tests/second.test.ts"]);
      const raw = JSON.parse(readFileSync(join(dirname(result.reportPath), run.summary!), "utf8"));
      expect(raw.command).not.toContain("--isolate");
      expect(raw.collection.status).toBe("not-requested");
      expect(raw.fileTiming.complete).toBe(true);
    }
    for (const pair of result.report.pairs) {
      expect(pair.baselineMs).toBe(result.report.runs.find(run => run.pair === pair.pair && run.version === "A")!.wrapperExitMs);
      expect(pair.absoluteDifferenceMs).toBe(pair.baselineMs! - pair.candidateMs!);
      expect(pair.relativeDifference).toBe(pair.absoluteDifferenceMs! / pair.baselineMs!);
    }
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

test("a fixture digest change requires a specific scenario explanation while a collector change remains forbidden", async () => {
  const fixture = checkouts();
  try {
    const args = prepareWrapper(fixture);
    writeFileSync(join(fixture.B, "tests/helpers/session-continuity-fixture.ts"), "// changed fixture\n");
    fixture.map.sources.B = performanceSource(fixture.B); fixture.saveMap();
    const unexplained = await compareTestVersions([...args, "--mode=timing", "--isolation=default"], fixture.output);
    expect(unexplained.report.reasons).toContain("unexplained-measurement-change:tests/helpers/session-continuity-fixture.ts");
    expect(unexplained.report.runs).toHaveLength(0);
    fixture.map.measurementChanges = [{ file: "tests/helpers/session-continuity-fixture.ts", reason: "Fixture preparation changes for the equivalent scenario.", scenarioIds: ["equivalent behavior"] }];
    fixture.saveMap();
    const explained = prepareVersionComparison([...args, "--mode=timing", "--isolation=default"], fixture.output);
    expect(explained.reasons).toEqual([]);
    expect(explained.coverage!.map.measurementChanges).toEqual(fixture.map.measurementChanges);
    const wrapper = join(fixture.B, "scripts/profile-tests.ts");
    writeFileSync(wrapper, readFileSync(wrapper, "utf8") + "\n// altered collector\n");
    fixture.map.sources.B = performanceSource(fixture.B);
    fixture.map.measurementChanges.push({ file: "scripts/profile-tests.ts", reason: "Attempted collector exemption.", scenarioIds: ["equivalent behavior"] });
    fixture.saveMap();
    const changed = await compareTestVersions([...args, "--mode=timing", "--isolation=default"], fixture.output);
    expect(changed.report.reasons).toContain("different-frozen-measurement-tools");
    expect(changed.report.runs).toHaveLength(0);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

test("wrapper preparation requires every declared policy and identical actual lockfiles", () => {
  const fixture = checkouts();
  try {
    const args = [...prepareWrapper(fixture), "--mode=timing", "--isolation=default"];
    fixture.map.preparation.cache = ""; fixture.saveMap();
    expect(prepareVersionComparison(args, fixture.output).reasons).toContain("missing-or-invalid-preparation-policy");
    fixture.map.preparation.cache = "Cold timing inputs on every run."; fixture.saveMap();
    writeFileSync(join(fixture.B, "bun.lock"), "different actual dependencies\n");
    expect(prepareVersionComparison(args, fixture.output).reasons).toContain("different-or-unknown-lockfiles");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

const qualificationCases: { name: string; reason: string; change: (e: ReturnType<typeof qualificationEvidence>, fixture: Pick<ReturnType<typeof checkouts>, "B">) => void }[] = [
  { name: "old wrapper semantics", reason: "wrapper-requires-v4-file-measurement-semantics", change: e => { e.summary.version = 3; } },
  { name: "unknown source", reason: "different-or-unknown-source", change: e => { e.summary.known = false; } },
  { name: "changed revision", reason: "different-or-unknown-source", change: e => { e.summary.revision = "0".repeat(40); } },
  { name: "changed tool file", reason: "different-or-unknown-source", change: e => { e.summary.measurementFiles = []; } },
  { name: "different actual root", reason: "different-execution-environment", change: (e, fixture) => { e.summary.cwd = fixture.B; } },
  { name: "different Bun version", reason: "different-execution-environment", change: e => { e.summary.bunVersion = "different"; } },
  { name: "different dependency digest", reason: "different-execution-environment", change: e => { e.summary.dependencyDigest = "0".repeat(64); } },
  { name: "failed summary result", reason: "tests-did-not-succeed", change: e => { e.summary.testResult = "nonzero-exit"; } },
  { name: "invalid root wall", reason: "invalid-root-wall-clock", change: e => { e.summary.wallValid = false; } },
  { name: "unrequested isolation", reason: "different-command-scope", change: e => { e.summary.command.push("--isolate"); } },
  { name: "changed worker command", reason: "different-command-scope", change: e => { e.summary.command[e.summary.command.indexOf("--parallel=2")] = "--parallel=1"; } },
  { name: "restored history", reason: "different-scheduling-inputs", change: e => { e.summary.scheduling.source = "restored"; } },
  { name: "cold history with digest", reason: "different-scheduling-inputs", change: e => { e.summary.scheduling.inputDigest = "0".repeat(64); } },
  { name: "missing measured file", reason: "incomplete-file-measurement", change: e => { e.summary.fileTiming.measuredFiles = ["tests/equivalent.test.ts"]; } },
  { name: "incomplete source stability", reason: "incomplete-file-measurement", change: e => { e.summary.fileTiming.sourceStable = false; } },
  { name: "incomplete logs", reason: "incomplete-file-measurement", change: e => { e.summary.fileTiming.logsComplete = false; } },
  { name: "unrequested full collection", reason: "different-collection-mode", change: e => { e.summary.collection.status = "not-requested"; } },
  { name: "different completion run", reason: "invalid-completion-segments", change: e => { e.completion.runId = "other"; } },
  { name: "completion moves execution time", reason: "invalid-completion-segments", change: e => { e.completion.segments.executionMs++; } },
];
for (const { name, reason, change } of qualificationCases) test(`wrapper report qualification rejects ${name}`, () => {
  const fixture = reportQualificationFixture();
  try {
    const evidence = qualificationEvidence(fixture, undefined, fixture.source);
    expect(evidence.qualify().invalidReasons).toEqual([]);
    change(evidence, fixture); evidence.save();
    expect(evidence.qualify().invalidReasons).toContain(reason);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("wrapper qualification validates actual timing files, body coverage and skip footer rules", () => {
  const fixture = checkouts();
  try {
    prepareWrapper(fixture);
    const evidence = qualificationEvidence(fixture), timingPath = join(evidence.run, "file-timings.json");
    const timing = readFileSync(timingPath);
    writeFileSync(timingPath, JSON.stringify({ version: 1, files: { "tests/equivalent.test.ts": -1 } }));
    expect(evidence.qualify().invalidReasons).toContain("invalid-file-measurements");
    writeFileSync(timingPath, timing);
    writeFileSync(join(evidence.output, "stderr.log"), evidence.body.replace("tests/second.test.ts:", "tests/unexpected.test.ts:"));
    expect(evidence.qualify().invalidReasons).toContain("incomplete-test-file-execution");
    writeFileSync(join(evidence.output, "stderr.log"), evidence.body.replace("2 pass", "3 pass"));
    expect(evidence.qualify().invalidReasons).toContain("unexpected-test-coverage-counts");
    evidence.summary.counts = { pass: 1, skip: 1, fail: 0 }; evidence.save();
    const body = "tests/equivalent.test.ts:\n(skip) platform contract\ntests/second.test.ts:\n(pass) second scenario\n";
    const footer = "\n1 test skipped:\n(skip) platform contract\n\n1 pass\n1 skip\n0 fail\nRan 2 tests across 2 files.\n";
    writeFileSync(join(evidence.output, "stderr.log"), body + footer);
    expect(evidence.qualify(undefined, { pass: 1, skip: 1 }).invalidReasons).toContain("unknown-or-different-skips");
    const skips = [{ test: "tests/equivalent.test.ts: platform contract", reason: "Existing platform exclusion." }];
    const known = evidence.qualify(skips, { pass: 1, skip: 1 });
    expect(known.invalidReasons).toEqual([]);
    expect(known.skips).toEqual([skips[0]!.test]);
    writeFileSync(join(evidence.output, "stderr.log"), body.replace("(skip) platform contract", "(skip) platform contract\n(skip) platform contract") + footer);
    const duplicate = evidence.qualify(skips, { pass: 1, skip: 1 });
    expect(duplicate.skips).toHaveLength(2);
    expect(duplicate.invalidReasons).toContain("unknown-or-different-skips");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("timing qualification rejects operation collection and accepts not-requested", () => {
  const fixture = checkouts();
  try {
    prepareWrapper(fixture);
    const evidence = qualificationEvidence(fixture, { mode: "timing", isolation: "default" });
    expect(evidence.qualify().invalidReasons).toContain("different-collection-mode");
    evidence.summary.collection.status = "not-requested"; evidence.save();
    expect(evidence.qualify().invalidReasons).toEqual([]);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

for (const outcome of ["success", "reversed", "failed-B", "failed-all", "signal-all", "identity-invalid", "incomplete"] as const) {
  test(`fixed six-slot scheduling and summary preserve ${outcome} results`, async () => {
    // Independent fixed expectations: AB=(120,100), BA=(90,110), AB=(130,110).
    const times = [120, 100, 90, 110, 130, 110], visits: string[] = [];
    const runs = await scheduleVersionSamples(async slot => {
      visits.push(`${slot.pair}:${slot.version}`);
      const run = versionSampleResult(slot);
      run.exitCode = 0; run.wallMs = 10; run.wrapperExitMs = times[slot.index]!;
      run.counts = { pass: 2, skip: 0, fail: 0 };
      if (outcome === "reversed" && slot.index === 1) run.wrapperExitMs = 140;
      if (outcome === "failed-all" || outcome === "signal-all" || outcome === "failed-B" && slot.version === "B") {
        run.exitCode = 1; run.error = `fixed-${slot.index}`;
        run.invalidReasons = ["tests-did-not-succeed"];
        if (outcome === "signal-all") run.signal = "SIGTERM";
      }
      if (outcome === "identity-invalid") {
        run.error = "different-execution-environment";
        run.invalidReasons = ["different-execution-environment", "different-command-scope"];
      }
      if (outcome === "incomplete" && slot.index === 2) run.wrapperExitMs = null;
      return run;
    });
    expect(visits).toEqual(["1:A", "1:B", "2:B", "2:A", "3:A", "3:B"]);
    expect(runs).toHaveLength(6);
    expect(runs.map(run => run.pair)).toEqual([1, 1, 2, 2, 3, 3]);
    const before = structuredClone(runs), result = summarizeVersionSamples(runs, true, { mode: "full", isolation: "default" });
    expect(runs).toEqual(before);
    expect(result.groups.map(group => group.attempts)).toEqual([3, 3]);
    expect(result.pairs.map(pair => pair.order)).toEqual([["A", "B"], ["B", "A"], ["A", "B"]]);
    if (outcome === "success" || outcome === "reversed") {
      expect(result.valid).toBe(true);
      expect(result.pairs.every(pair => pair.valid)).toBe(true);
      expect(result.pairs.map(pair => pair.absoluteDifferenceMs)).toEqual(outcome === "success" ? [20, 20, 20] : [-20, 20, 20]);
      expect(result.pairs.map(pair => pair.relativeDifference)).toEqual(outcome === "success" ? [20 / 120, 20 / 110, 20 / 130] : [-20 / 120, 20 / 110, 20 / 130]);
      expect(result.pairedStatistics.absoluteDifferenceMs).toEqual({ median: 20, range: { min: outcome === "success" ? 20 : -20, max: 20 } });
      expect(result.conclusion).toBe(outcome === "success" ? "candidate-faster-in-all-pairs" : "insufficient-evidence");
    } else {
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain("failed-or-incomplete-samples");
      expect(result.speedup).toBeNull();
      expect(result.conclusion).toBe("invalid");
      expect(result.groups.map(group => group.failedAttempts)).toEqual(outcome === "failed-all" || outcome === "signal-all" ? [3, 3] : outcome === "failed-B" ? [0, 3] : [0, 0]);
      if (outcome !== "incomplete") expect(result.pairs.every(pair => !pair.valid && pair.speedup === null)).toBe(true);
      else expect(result.pairs.map(pair => pair.valid)).toEqual([true, false, true]);
    }
  });
}

test("full wrapper wall clocks preserve incomplete operation collection without losing valid wall evidence", async () => {
  const fixture = checkouts();
  try {
    for (const [version, cwd] of [["A", fixture.A], ["B", fixture.B]]) {
      writeFileSync(join(cwd!, "tests/equivalent.test.ts"), `import { test } from "bun:test";
        import { markRuntimePerformanceIncomplete } from "../src/runtime-performance";
        test("${version} scenario", () => markRuntimePerformanceIncomplete("intentional-operation-gap"));\n`);
    }
    prepareWrapper(fixture);
    const result = await singleWrapper(fixture, "A", { mode: "full", isolation: "isolate" });
    expect(result.invalidReasons).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.command).toContain("--mode=full");
    expect(result.command).toContain("--isolation=isolate");
    expect(result.wrapperExitMs!).toBeGreaterThan(result.wallMs!);
    expect(result.parentReportMs).toBeGreaterThan(0);
    expect(result.parentLogDrainMs).toBeGreaterThanOrEqual(0);
    const raw = JSON.parse(readFileSync(result.summaryPath!, "utf8"));
    expect(raw.command).toContain("--isolate");
    expect(raw.command).toContain("--preload");
    expect(raw.collection.status).toBe("incomplete");
    expect(raw.incompleteReasons.join(",")).toContain("intentional-operation-gap");
    expect(raw.fileTiming.complete).toBe(true);
    expect(JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8")).valid).toBe(true);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

for (const identity of ["equivalent", "different"] as const) test(`wrapper command and runtime paths require ${identity} filesystem identities`, () => {
  const fixture = checkouts();
  try {
    prepareWrapper(fixture);
    const evidence = qualificationEvidence(fixture), alias = join(fixture.directory, "alias-A");
    const executableDirectory = join(fixture.directory, "runtime-alias"), executableAlias = join(executableDirectory, basename(process.execPath));
    symlinkSync(fixture.A, alias, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(dirname(process.execPath), executableDirectory, process.platform === "win32" ? "junction" : "dir");
    // Equal Bun bytes on another file object must still fail the identity check.
    const differentExecutable = join(fixture.directory, "different-bun");
    copyFileSync(process.execPath, differentExecutable);
    expect(createHash("sha256").update(readFileSync(differentExecutable)).digest("hex")).toBe(evidence.summary.executable.sha256);
    evidence.summary.cwd = alias;
    evidence.summary.executable.path = identity === "equivalent" ? executableAlias : differentExecutable;
    evidence.summary.command[0] = evidence.summary.executable.path;
    evidence.summary.command[evidence.summary.command.indexOf("--preload") + 1] = identity === "equivalent"
      ? join(alias, "scripts/test-performance-preload.ts") : join(fixture.A, "tests/second.test.ts");
    evidence.save();
    const result = evidence.qualify();
    if (identity === "equivalent") expect(result.invalidReasons).toEqual([]);
    else {
      expect(result.invalidReasons).toContain("different-execution-environment");
      expect(result.invalidReasons).toContain("different-command-scope");
    }
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("wrapper comparisons preserve each failed attempt and its original logs", async () => {
  const fixture = checkouts('import { test, expect } from "bun:test"; test("B fails", () => expect(1).toBe(2));\n');
  try {
    prepareWrapper(fixture);
    const result = await singleWrapper(fixture, "B", { mode: "timing", isolation: "default" });
    expect(result.valid).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.invalidReasons).toContain("tests-did-not-succeed");
    expect(result.wrapperExitMs!).toBeGreaterThan(0);
    const measured = JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8"));
    expect(measured.exitCode).toBe(result.exitCode);
    expect(measured.signal).toBe(result.signal);
    expect(readFileSync(join(fixture.output, measured.stderr), "utf8")).toContain("B fails");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

test("wall clocks require a known reason for each observed skip", async () => {
  const fixture = checkouts();
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), 'import { test } from "bun:test"; test.skip("platform contract", () => {});\n');
    const unknownOutput = join(fixture.directory, "unknown-skip"), knownOutput = join(fixture.directory, "known-skip");
    mkdirSync(unknownOutput); mkdirSync(knownOutput);
    const unknown = await externalWallClock(fixture.A, unknownOutput, fixture.files, { pass: 1, skip: 1 });
    expect(unknown.exitCode).toBe(0);
    expect(unknown.invalidReasons).toContain("unknown-or-different-skips");
    const known = await externalWallClock(fixture.A, knownOutput, fixture.files, { pass: 1, skip: 1 },
      [{ test: "tests/equivalent.test.ts: platform contract", reason: "The fixture deliberately declares this existing platform exclusion." }]);
    expect(known.valid).toBe(true);
    expect(known.skips).toEqual(["tests/equivalent.test.ts: platform contract"]);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
});

test("version skip parsing ignores the final Bun list without deduplicating body results", async () => {
  const fixture = checkouts(), originalSpawn = Bun.spawn.bind(Bun);
  let body = "tests/equivalent.test.ts:\n(skip) platform contract\ntests/second.test.ts:\n(pass) second scenario\n";
  const footer = "\n1 test skipped:\n(skip) platform contract\n\n1 pass\n1 skip\n0 fail\nRan 2 tests across 2 files.\n";
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: any) => {
    if (options?.cwd !== fixture.A || command[1] !== "test") return originalSpawn(command, options);
    return { exited: Promise.resolve(0), signalCode: null,
      stdout: new Blob([""]).stream(), stderr: new Blob([body + footer]).stream() };
  }) as typeof Bun.spawn);
  try {
    mkdirSync(fixture.output);
    const expected = [{ test: "tests/equivalent.test.ts: platform contract", reason: "Existing platform exclusion." }];
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 1, skip: 1 }, expected);
    expect(result.invalidReasons).toEqual([]);
    expect(result.skips).toEqual([expected[0]!.test]);
    body = body.replace("(skip) platform contract", "(skip) platform contract\n(skip) platform contract");
    const duplicate = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 1, skip: 1 }, expected);
    expect(duplicate.skips).toHaveLength(2);
    expect(duplicate.invalidReasons).toContain("unknown-or-different-skips");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { spawn.mockRestore(); fixture.clean(); }
});

for (const githubActions of [false, true]) test(`wall clocks accept repeated parallel file headers (${githubActions ? "GitHub Actions" : "ordinary"})`, async () => {
  const fixture = checkouts(), previousActions = process.env.GITHUB_ACTIONS;
  try {
    const evaluations = join(fixture.directory, "evaluations.log");
    for (const name of ["equivalent", "second"] as const) {
      writeFileSync(join(fixture.A, `tests/${name}.test.ts`), `import { test } from "bun:test";
        import { appendFileSync, existsSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const root = ${JSON.stringify(fixture.directory)}, name = ${JSON.stringify(name)};
        appendFileSync(${JSON.stringify(evaluations)}, name + "\\n");
        writeFileSync(join(root, name + "-ready"), "");
        for (let round = 0; round < 3; round++) test(name + "-" + round, async () => {
          const prerequisite = name === "equivalent" ? (round === 0 ? "second-ready" : "second-" + (round - 1)) : "equivalent-" + round;
          const deadline = Date.now() + 5_000;
          while (!existsSync(join(root, prerequisite))) {
            if (Date.now() >= deadline) throw Error("Parallel sibling did not reach " + prerequisite);
            await Bun.sleep(2);
          }
          await Bun.sleep(10);
          writeFileSync(join(root, name + "-" + round), "");
        });
        test.skip(name + " platform exclusion", () => {});
      `);
    }
    if (githubActions) process.env.GITHUB_ACTIONS = "true";
    else delete process.env.GITHUB_ACTIONS;
    mkdirSync(fixture.output);
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 6, skip: 2 },
      ["equivalent", "second"].map(name => ({ test: `tests/${name}.test.ts: ${name} platform exclusion`, reason: "Existing platform exclusion in the parallel fixture." })));
    const stderr = readFileSync(join(fixture.output, "stderr.log"), "utf8").replaceAll("\\", "/").replace(/\x1b\[[0-9;]*m/g, "");
    for (const name of ["equivalent", "second"]) {
      expect(stderr.split("\n").filter(line => line === `${githubActions ? "::group::" : ""}tests/${name}.test.ts:`).length).toBeGreaterThan(1);
    }
    expect(readFileSync(evaluations, "utf8").trim().split("\n").sort()).toEqual(["equivalent", "second"]);
    expect(result.exitCode).toBe(0);
    expect(result.invalidReasons).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.executedFiles).toEqual(["tests/equivalent.test.ts", "tests/second.test.ts"]);
    expect(result.reportedFiles).toBe(2);
    expect(result.skips.sort()).toEqual(["tests/equivalent.test.ts: equivalent platform exclusion", "tests/second.test.ts: second platform exclusion"]);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally {
    if (previousActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previousActions;
    fixture.clean();
  }
}, 30_000);

test("a signalled wrapper preserves its actual exit and measurement report", async () => {
  const fixture = checkouts();
  try {
    prepareWrapper(fixture);
    writeFileSync(join(fixture.A, "scripts/profile-tests.ts"), 'process.kill(process.pid, "SIGTERM");\n');
    const result = await singleWrapper(fixture, "A", { mode: "timing", isolation: "default" });
    expect(result.valid).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.invalidReasons).toContain("tests-did-not-succeed");
    if (process.platform !== "win32") expect(result.signal).toBe("SIGTERM");
    expect(result.wrapperExitMs!).toBeGreaterThan(0);
    const raw = JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8"));
    expect(raw.exitCode).toBe(result.exitCode);
    expect(raw.signal).toBe(result.signal);
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

test("one reversed pair prevents a speedup claim even when the median paired difference improves", async () => {
  const fixture = checkouts(`import { test } from "bun:test";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const marker = "../paired-run-count.txt";
    const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    writeFileSync(marker, String(count + 1));
    test("B scenario", async () => { await Bun.sleep(count === 0 ? 900 : 1); });\n`);
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), 'import { test } from "bun:test"; test("A scenario", async () => { await Bun.sleep(300); });\n');
    fixture.map.sources = { A: performanceSource(fixture.A), B: performanceSource(fixture.B) }; fixture.saveMap();
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(0);
    expect(result.report.pairs[0]!.absoluteDifferenceMs!).toBeLessThan(0);
    expect(result.report.pairs.slice(1).every(pair => pair.absoluteDifferenceMs! > 0)).toBe(true);
    expect(result.report.pairedStatistics.absoluteDifferenceMs.median!).toBeGreaterThan(0);
    expect(result.report.pairedStatistics.absoluteDifferenceMs.range!.min).toBeLessThan(0);
    expect(result.report.conclusion).toBe("insufficient-evidence");
  } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { fixture.clean(); }
}, 30_000);

for (const summaryVersion of [3, 4]) for (const history of ["same", "different"] as const) {
  test(`strict v${summaryVersion} version comparisons require ${history} history snapshots to agree`, async () => {
    const fixture = checkouts(), originalSpawn = Bun.spawn.bind(Bun);
    let attempt = 0;
    const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: any) => {
      const cwd = options?.cwd;
      if (!Array.isArray(command) || ![fixture.A, fixture.B].includes(cwd) || command[1] !== join(cwd, "scripts/profile-tests.ts")) {
        return originalSpawn(command, options);
      }
      const output = options.env.CGW_TEST_PROFILE_DIR, run = join(output, "workers-synthetic");
      mkdirSync(run);
      const input = join(run, "history-input.json"), files = ["tests/equivalent.test.ts"];
      attempt++;
      const contents = JSON.stringify({ version: 1, files: { [files[0]!]: history === "different" ? attempt : 1 } });
      writeFileSync(input, contents);
      const segments = { prepareMs: 1, executionMs: 10, logDrainMs: 1, reportMs: 1, totalMs: 13 };
      const summary = { ...performanceSource(cwd), version: summaryVersion, runId: `full-${attempt}`,
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, workers: 2,
        mode: "full", isolation: "default", exitCode: 0, wallMs: 10, testResult: "success", wallValid: true, wallInvalidReasons: [],
        counts: { pass: 1, skip: 0, fail: 0 }, snapshots: 1, complete: true, incompleteReasons: [], invalidReports: [], childResultIssues: [],
        totals: { "recovery.write": { count: 1, errors: 0, totalMs: 2, maxMs: 2, totalBytes: 7 } },
        collection: { status: "complete" }, segments,
        scheduling: { source: "restored", inputDigest: createHash("sha256").update(contents).digest("hex") },
        fileTiming: { version: 2, complete: true, fullSuite: false, targetFiles: files, executedFiles: files, measuredFiles: files,
          reportedFiles: 1, reasons: [], logsComplete: true, sourceStable: true },
        command: [process.execPath, "test", "--timeout", "30000", "--preload", join(cwd, "scripts/test-performance-preload.ts"),
          "--timings", join(run, "file-timings.json"), "--timings", input, "--update-timings", "--parallel=2", "./tests/equivalent.test.ts"] };
      writeFileSync(join(run, "summary.json"), JSON.stringify(summary));
      writeFileSync(join(run, "completion.json"), JSON.stringify({ version: 1, runId: summary.runId,
        segments: { ...segments, reportMs: 2, totalMs: 14 }, endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"] }));
      return { exited: Promise.resolve(0), signalCode: null };
    }) as typeof Bun.spawn);
    try {
      const result = await compareTestVersions([...fixture.args, "./tests/equivalent.test.ts"], fixture.output);
      expect(attempt).toBe(6);
      expect(result.report.runs).toHaveLength(6);
      expect(result.report.runs.every(run => run.summaryVersion === summaryVersion && run.error === null && run.invalidReasons.length === 0)).toBe(true);
      const inputs = result.report.runs.flatMap(run => run.schedulingInputs!);
      expect(new Set(inputs.map(input => input.path)).size).toBe(6);
      expect(new Set(inputs.map(input => input.digest)).size).toBe(history === "same" ? 1 : 6);
      expect(JSON.parse(readFileSync(result.reportPath, "utf8")).runs).toHaveLength(6);
      expect(result.report.valid).toBe(history === "same");
      expect(result.exitCode).toBe(history === "same" ? 0 : 1);
      if (history === "different") {
        expect(result.report.reasons).toEqual(["different-scheduling-inputs"]);
        expect(result.report.speedup).toBeNull();
      } else {
        expect(result.report.reasons).toEqual([]);
        expect(result.report.speedup).toBe(1);
      }
    } catch (error) { preserveComparisonFailure(fixture, error); }
  finally { spawn.mockRestore(); fixture.clean(); }
  }, 30_000);
}
