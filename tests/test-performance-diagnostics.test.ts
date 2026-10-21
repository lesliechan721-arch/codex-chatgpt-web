import { expect, spyOn, test } from "bun:test";
import { processFreeTest } from "./helpers/process-free-performance-test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySkipReasonEvidence, compareModePairs, diagnosticEnvironment, diagnosticOptions, modePairSampleIssues, observeDiagnosticWrapper, readDiagnosticSkips, readSkipReasonEvidence, type ModePairSample } from "../scripts/diagnose-test-performance";
import { verificationCommands, verifyOptions } from "../scripts/verify";

processFreeTest("diagnostics preserve defaults and select reproducible file and condition scopes", () => {
  const defaults = diagnosticOptions([]);
  expect(defaults.history).toBe("cold");
  expect(defaults.conditions).toHaveLength(6);
  expect(defaults.files).toEqual(["./tests/continuity-task-update.test.ts", "./tests/session-continuity-compaction.test.ts"]);
  const selected = diagnosticOptions(["--suite=continuity-adapter", "--condition=isolated-full-2", "--repetitions=3", "--test-name-pattern=^A[89] "]);
  expect(selected.files).toEqual(["./tests/continuity-task-update.test.ts", "./tests/session-continuity-adapter.test.ts"]);
  expect(selected.conditions).toEqual([{ name: "isolated-full-2", workers: 2, mode: "full", isolation: "isolate" }]);
  expect(selected.pattern).toBe("^A[89] ");
  expect(diagnosticOptions(["--suite=continuity-task"]).files).toEqual(["./tests/continuity-task-update.test.ts"]);
  expect(diagnosticOptions(["--suite=continuity-source", "--repetitions=10"]).repetitions).toBe(10);
  for (const args of [["--condition=unknown"], ["--history=local"], ["--test-name-pattern=["], ["--suite=all", "--repetitions=10"]]) {
    expect(() => diagnosticOptions(args)).toThrow();
  }
});

processFreeTest("cross-run history requires explicit full-suite scope and one condition", () => {
  const args = ["--suite=all", "--condition=original-2", "--repetitions=1", "--history=restore"];
  expect(diagnosticOptions(args)).toMatchObject({ files: ["./tests"], history: "restore", pattern: "" });
  for (const extra of ["--suite=cli", "--condition=all", "--test-name-pattern=source"]) {
    expect(() => diagnosticOptions([...args, extra])).toThrow();
  }
});

processFreeTest("diagnostic timing controls are opt-in and cannot inherit a local history override", () => {
  const env = { CGW_TEST_TIMING_TOKEN: "test-only-token", CGW_TEST_TIMING_RESTORE: "1",
    CGW_TEST_TIMING_HISTORY: "/old/history.json", CGW_TEST_TIMING_ARTIFACT_DIR: "/output/artifact",
    CGW_RUNTIME_PERFORMANCE_DIR: "/old/reports", CGW_PERFORMANCE_RUN_ID: "old-run" };
  const cold = diagnosticEnvironment(env, "cold", "/new/reports");
  expect(cold.CGW_TEST_TIMING_TOKEN).toBeUndefined();
  expect(cold.CGW_TEST_TIMING_RESTORE).toBeUndefined();
  expect(cold.CGW_TEST_TIMING_HISTORY).toBeUndefined();
  expect(cold.CGW_RUNTIME_PERFORMANCE_DIR).toBeUndefined();
  expect(cold.CGW_PERFORMANCE_RUN_ID).toBeUndefined();
  const restored = diagnosticEnvironment(env, "restore", "/new/reports");
  expect(restored.CGW_TEST_TIMING_RESTORE).toBe("1");
  expect(restored.CGW_TEST_TIMING_TOKEN).toBe("test-only-token");
  expect(restored.CGW_TEST_TIMING_HISTORY).toBeUndefined();
  expect(restored.CGW_TEST_TIMING_ARTIFACT_DIR).toBe("/output/artifact");
  expect(restored.CGW_TEST_PROFILE_DIR).toBe("/new/reports");
  expect(env.CGW_TEST_TIMING_HISTORY).toBe("/old/history.json");
});

processFreeTest("CI mode pairing selects only full and timing at the same default isolation and worker count", () => {
  const args = ["--suite=all", "--condition=mode-pair"];
  const selected = diagnosticOptions(args);
  expect(selected.conditions).toEqual([
    { name: "default-full-2", workers: 2, mode: "full", isolation: "default" },
    { name: "default-timing-2", workers: 2, mode: "timing", isolation: "default" },
  ]);
  expect(selected).toMatchObject({ modePair: true, repetitions: 3, history: "cold", files: ["./tests"] });
  expect(diagnosticOptions([...args, "--repetitions=1"]).repetitions).toBe(1);
  for (const extra of ["--suite=cli", "--history=restore", "--test-name-pattern=something", "--repetitions=10"]) {
    expect(() => diagnosticOptions([...args, extra])).toThrow();
  }
  const inherited = { CGW_API_KEY_CLI_DIAGNOSTICS: "1", CGW_CONTINUITY_SOURCE_DIAGNOSTICS: "1", CGW_TEST_TIMING_HISTORY: "/old.json", CGW_TEST_TIMING_ARTIFACT_DIR: "/artifact" };
  const paired = diagnosticEnvironment(inherited, "cold", "/new", true);
  expect(paired.CGW_API_KEY_CLI_DIAGNOSTICS).toBeUndefined();
  expect(paired.CGW_CONTINUITY_SOURCE_DIAGNOSTICS).toBeUndefined();
  expect(paired.CGW_TEST_TIMING_HISTORY).toBeUndefined();
  expect(paired.CGW_TEST_TIMING_ARTIFACT_DIR).toBeUndefined();
  expect(diagnosticEnvironment(inherited, "cold", "/new").CGW_API_KEY_CLI_DIAGNOSTICS).toBe("1");
});

const files = ["tests/a.test.ts", "tests/b.test.ts"];
function pairedSamples(): ModePairSample[] {
  const inputs: ModePairSample["before"] = {
    source: { revision: "a".repeat(40), workflowRevision: null, nodeVersion: "v22.0.0", workingTreeDirty: false,
      patchDigest: "b".repeat(64), toolVersion: 3, toolDigest: "c".repeat(64), measurementFiles: [], known: true },
    dependencies: { root: "d".repeat(64), launcher: "e".repeat(64) }, driverDigest: "f".repeat(64),
    executable: { path: "/bun", sha256: "1".repeat(64), bunVersion: "1.4.2", embeddedBunSha256: null }, files,
  };
  return ["full", "timing", "timing", "full", "full", "timing"].map((mode, index) => ({
    round: Math.floor(index / 2) + 1, condition: { name: `default-${mode}-2`, mode, isolation: "default", workers: 2 },
    command: ["/bun", "profile-tests.ts", "--parallel=2", `--mode=${mode}`, "--isolation=default", "./tests"],
    exitCode: 0, signal: null, error: null, wrapperWallMs: mode === "full" ? 1000 + index * 10 : 800 + index * 10,
    parentLogDrainMs: 0, logIssues: [], before: structuredClone(inputs), after: structuredClone(inputs), environmentDigest: "same",
    runner: { instance: "same-runner", category: "windows-latest", image: "win25", imageVersion: "1", platform: "win32", arch: "x64" },
    cleanup: { status: "removed", error: null },
    skips: { count: 0, entries: [], complete: true }, completion: { version: 1, runId: `run-${index}` },
    summary: { version: 4, runId: `run-${index}`, mode, workers: 2, isolation: "default", bail: null, exitCode: 0, signal: null, spawnError: null,
      command: ["/bun", "test", "--timeout", "30000", "--parallel=2", "./tests"], testResult: "success", wallValid: true,
      revision: inputs.source.revision, patchDigest: inputs.source.patchDigest, toolDigest: inputs.source.toolDigest,
      executable: inputs.executable, bunVersion: "1.4.2", dependencyDigest: inputs.dependencies.root,
      fileTiming: { version: 2, complete: true, fullSuite: true, logsComplete: true, sourceStable: true,
        targetFiles: files, executedFiles: files, measuredFiles: files, reportedFiles: 2 },
      counts: { pass: 4, skip: 0, fail: 0 }, scheduling: { source: "cold", inputDigest: null },
      collection: { status: mode === "full" ? "incomplete" : "not-requested" }, incompleteReasons: mode === "full" ? ["missing-child-report"] : [],
    },
  }));
}

processFreeTest("mode comparison retains raw pair values and requires every valid pair to improve", () => {
  const runs = pairedSamples();
  const report = compareModePairs(runs, 3, files);
  expect(report).toMatchObject({ conclusion: "timing-switch-candidate", validPairs: 3, failures: { numerator: 0, denominator: 6 } });
  expect(report.pairs[0]).toMatchObject({ order: ["full", "timing"], fullWrapperWallMs: 1000, timingWrapperWallMs: 810,
    absoluteSavingMs: 190, relativeSaving: 0.19 });
  expect(report.fullWrapperWallMs).toEqual({ values: [1000, 1030, 1040], median: 1030, range: [1000, 1040] });
  expect(report.absoluteSavingMs.median).toBe(190);
  // A positive median cannot hide a reverse result in one pair.
  runs[1]!.wrapperWallMs = 1100;
  expect(compareModePairs(runs, 3, files)).toMatchObject({ conclusion: "insufficient-evidence", validPairs: 3 });
  expect(compareModePairs(runs, 3, files).issues).toContain("no-net-benefit-in-every-valid-pair");
  expect(compareModePairs(runs.slice(0, 4), 2, files).conclusion).toBe("insufficient-evidence");
  expect(compareModePairs([...runs, structuredClone(runs[0]!)], 3, files).conclusion).toBe("insufficient-evidence");
});

processFreeTest("mode samples separate operation gaps from coverage, identity and result failures", () => {
  expect(modePairSampleIssues(pairedSamples()[0]!, files)).toEqual([]);
  expect(modePairSampleIssues(pairedSamples()[1]!, files)).toEqual([]);
  const mutations: ((run: ModePairSample) => void)[] = [
    run => { run.summary!.fileTiming.executedFiles = [files[0]]; },
    run => { run.summary!.fileTiming.sourceStable = false; },
    run => { run.summary!.version = 3; },
    run => { run.after.dependencies.root = "changed"; },
    run => { run.summary!.scheduling = { source: "restored", inputDigest: "history" }; },
    run => { run.skips = { count: 1, entries: [], complete: false }; },
    run => { run.completion = null; },
    run => { run.cleanup.status = "failed"; },
    run => { run.exitCode = 3; run.summary!.testResult = "nonzero-exit"; },
  ];
  for (const mutate of mutations) {
    const runs = pairedSamples(); mutate(runs[1]!);
    const result = compareModePairs(runs, 3, files);
    expect(result.conclusion).toBe("insufficient-evidence");
    expect(result.validPairs).toBe(2);
    expect(result.pairs[0]!.fullWrapperWallMs).toBe(1000);
    expect(result.pairs[0]!.timingWrapperWallMs).toBe(810);
  }
  const failed = pairedSamples(); failed[1]!.exitCode = 3;
  expect(compareModePairs(failed, 3, files).failures).toEqual({ numerator: 1, denominator: 6 });
  for (const change of [
    (run: ModePairSample) => { run.runner.instance = "different"; },
    (run: ModePairSample) => { run.environmentDigest = "different"; },
    (run: ModePairSample) => { run.summary!.counts.skip = 1; },
  ]) {
    const runs = pairedSamples(); change(runs[1]!);
    expect(compareModePairs(runs, 3, files).conclusion).toBe("insufficient-evidence");
  }
  const skipped = pairedSamples();
  for (const run of skipped) {
    run.summary!.counts.skip = 1;
    run.skips = { count: 1, entries: [{ file: files[0]!, name: "Windows platform scenario", reason: null }], complete: true };
  }
  const unverified = compareModePairs(skipped, 3, files);
  expect(unverified.conclusion).toBe("insufficient-evidence");
  expect(unverified.pairs[0]!.issues).toContain("full:skip-reasons-unverified");
  expect(unverified.pairs[0]!.issues).not.toContain("different-test-results-or-skips");
});

processFreeTest("reviewed skip reasons are bound to source and exactly cover the observed skipped tests", () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-skip-reasons-")), path = join(output, "reviewed.json");
  const runs = pairedSamples(), source = runs[0]!.before.source;
  const identity = { revision: source.revision, patchDigest: source.patchDigest, toolDigest: source.toolDigest };
  const entries = [{ file: files[0]!, name: "Windows platform scenario", reason: "Requires Linux process identity." }];
  const observed = { count: 1, entries: [{ file: files[0]!, name: entries[0]!.name, reason: null }], complete: true };
  const document = { version: 1, source: identity, entries };
  try {
    writeFileSync(path, JSON.stringify(document));
    expect(diagnosticOptions(["--suite=all", "--condition=mode-pair", `--skip-evidence=${path}`]).skipEvidencePath).toBe(path);
    expect(() => diagnosticOptions([`--skip-evidence=${path}`])).toThrow();
    const evidence = readSkipReasonEvidence(path)!;
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    for (const run of runs) {
      run.summary!.counts.skip = 1;
      run.skips = applySkipReasonEvidence(observed, evidence, run.before.source, { before: evidence.sha256, after: evidence.sha256 });
    }
    expect(observed.entries[0]!.reason).toBeNull();
    expect(runs[0]!.skips.entries).toEqual(entries);
    expect(compareModePairs(runs, 3, files).conclusion).toBe("timing-switch-candidate");
    for (const field of ["revision", "patchDigest", "toolDigest"] as const) {
      const wrongSource = { ...source, [field]: "9".repeat(field === "revision" ? 40 : 64) };
      expect(applySkipReasonEvidence(observed, evidence, wrongSource, { before: evidence.sha256, after: evidence.sha256 }).evidence?.issues).toContain("skip-evidence-source-mismatch");
    }
    expect(applySkipReasonEvidence(observed, evidence, source, { before: evidence.sha256, after: "changed" }).evidence?.issues).toContain("skip-evidence-changed");
    expect(applySkipReasonEvidence({ count: 2, entries: [...observed.entries, ...observed.entries], complete: true }, evidence,
      source, { before: evidence.sha256, after: evidence.sha256 }).evidence?.issues).toContain("skip-evidence-scope-mismatch");
    for (const invalid of [
      { ...document, entries: [] },
      { ...document, entries: [...entries, ...entries] },
      { ...document, entries: [...entries, { file: files[1], name: "Extra skipped test", reason: "Extra reason." }] },
      { ...document, entries: [{ ...entries[0], name: "Different skipped test" }] },
      { ...document, entries: [{ ...entries[0], reason: " " }] },
      { ...document, source: { ...identity, toolDigest: "changed" } },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      const bad = readSkipReasonEvidence(path)!;
      const result = applySkipReasonEvidence(observed, bad, source, { before: bad.sha256, after: bad.sha256 });
      expect(result.evidence?.issues.length).toBeGreaterThan(0);
      expect(result.entries[0]!.reason).toBeNull();
      const failed = pairedSamples();
      for (const run of failed) { run.summary!.counts.skip = 1; run.skips = result; }
      expect(compareModePairs(failed, 3, files).conclusion).toBe("insufficient-evidence");
      expect(compareModePairs(failed, 3, files).failures.denominator).toBe(6);
    }
    const missing = readSkipReasonEvidence(join(output, "missing.json"))!;
    const result = applySkipReasonEvidence(observed, missing, source, { before: null, after: null });
    expect(result.evidence?.issues).toContain("skip-evidence-unreadable");
    expect(result.entries).toEqual(observed.entries);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

processFreeTest("skip evidence ignores the final Bun skip list and preserves repeated body results", () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-skip-footer-"));
  const body = "::group::tests/a.test.ts:\n(skip) first exclusion\n::group::tests/b.test.ts:\n(skip) second exclusion\n";
  try {
    for (const footer of ["", "\n2 tests skipped:\n(skip) second exclusion\n(skip) first exclusion\n"]) {
      writeFileSync(join(output, "stderr.log"), body + footer + "\n2 skip\n0 fail\n");
      expect(readDiagnosticSkips({ counts: { skip: 2 } }, output)).toEqual({ count: 2, complete: true,
        entries: [{ file: "tests/a.test.ts", name: "first exclusion", reason: null },
          { file: "tests/b.test.ts", name: "second exclusion", reason: null }] });
    }
    writeFileSync(join(output, "stderr.log"), "tests/a.test.ts:\n(skip) repeated exclusion\n(skip) repeated exclusion\n1 test skipped:\n(skip) repeated exclusion\n");
    const duplicate = readDiagnosticSkips({ counts: { skip: 1 } }, output);
    expect(duplicate.entries).toHaveLength(2);
    expect(duplicate.complete).toBe(false);
  } finally { rmSync(output, { recursive: true, force: true }); }
});

test("external observation stops at actual exit before delayed log streams close", async () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-diagnostic-clock-"));
  const originalSpawn = Bun.spawn.bind(Bun);
  let releaseLogs!: () => void;
  const logsMayClose = new Promise<void>(resolve => { releaseLogs = resolve; });
  let reachedExit!: () => void;
  const exited = new Promise<void>(resolve => { reachedExit = resolve; });
  let now = 0n;
  const clock = spyOn(process.hrtime, "bigint").mockImplementation(() => now);
  const spawn = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: any) => {
    const child = originalSpawn(command, options);
    const observedExit = child.exited.then(code => { now = 10_000_000n; reachedExit(); return code; });
    const stdout = child.stdout.pipeThrough(new TransformStream({ async flush() { await logsMayClose; } }));
    return new Proxy(child, { get(target, key) { return key === "stdout" ? stdout : key === "exited" ? observedExit : Reflect.get(target, key, target); } });
  }) as typeof Bun.spawn);
  try {
    const observation = observeDiagnosticWrapper([process.execPath, "-e", 'console.log("wrapper output"); console.error("wrapper error"); process.exit(3)'], output, process.env);
    await exited;
    // Let the observer record exit while stdout still has an unfinished flush.
    await Promise.resolve();
    now = 260_000_000n;
    releaseLogs();
    const result = await observation;
    expect(result).toMatchObject({ exitCode: 3, signal: null, error: null, logIssues: [] });
    expect(result.wrapperWallMs).toBe(10);
    expect(result.parentLogDrainMs).toBe(250);
    expect(result.wrapperWallMs!).toBeLessThan(result.parentLogDrainMs);
    expect(readFileSync(result.stdout, "utf8")).toContain("wrapper output");
    expect(readFileSync(result.stderr, "utf8")).toContain("wrapper error");
  } finally { releaseLogs(); spawn.mockRestore(); clock.mockRestore(); rmSync(output, { recursive: true, force: true }); }
});

test("verify test mode defaults to full and reaches only server tests", () => {
  expect(verifyOptions([])).toEqual({ testMode: "full" });
  expect(verifyOptions(["--test-mode=timing"])).toEqual({ testMode: "timing" });
  const full = verificationCommands("full", "/scratch"), timing = verificationCommands("timing", "/scratch");
  expect(timing.filter(command => command.some(argument => argument.startsWith("--mode=")))).toEqual([["run", "test", "--mode=timing"]]);
  expect(full.filter(command => command[1] !== "test")).toEqual(timing.filter(command => command[1] !== "test"));
  const output = join(tmpdir(), `cgw-invalid-verify-${process.pid}-${Date.now()}`);
  const child = spawnSync(process.execPath, [join(import.meta.dir, "../scripts/verify.ts"), "--test-mode=unknown"], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, CGW_TEST_PROFILE_DIR: output },
  });
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toContain("--test-mode must be full or timing");
  expect(existsSync(output)).toBe(false);
});
