import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { durationStatistics, InvalidSummary, readPerformanceSummary } from "./compare-test-performance";
import { MEASUREMENT_FILES, performanceSource } from "./test-performance-source";
import { repositoryTestFiles, targetTestFiles } from "./test-timing-history";

type Version = "A" | "B";
type Source = ReturnType<typeof performanceSource>;
type ExpectedCounts = { pass: number; skip: number };
type Settings = { mode: "full" | "timing"; isolation: "default" | "isolate" | "shared" };
export const versionTimerProtocol = { protocolVersion: 2, clock: "node:process.hrtime.bigint", boundary: "before-wrapper-spawn-to-observed-exit" } as const;
// These files define the measurement, rather than the business scenarios. A
// fixture or a probe's containing business file can change only with a reviewed
// per-file explanation; collector and wrapper changes cannot use that exception.
const commonToolFiles = MEASUREMENT_FILES.filter(file => file.startsWith("scripts/")
  || file === "src/runtime-performance.ts" || file === "tests/helpers/performance-test.ts");
const order: Version[] = ["A", "B", "B", "A", "A", "B"];

/** The formal comparison always runs three alternating pairs, including failures. */
export async function scheduleVersionSamples<T>(sample: (slot: { pair: number; version: Version; index: number }) => Promise<T>) {
  const results: T[] = [];
  for (const [index, version] of order.entries()) results.push(await sample({ pair: Math.floor(index / 2) + 1, version, index }));
  return results;
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const safeDigest = (path: string) => { try { return digest(path); } catch { return null; } };

export function versionComparisonOptions(args: string[]) {
  let baseline: string | undefined, candidate: string | undefined, coverageMap: string | undefined, measurementManifest: string | undefined;
  let mode: Settings["mode"] | undefined, isolation: Settings["isolation"] | undefined;
  let wallClock = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--baseline=")) baseline = resolve(arg.slice(11));
    else if (arg.startsWith("--candidate=")) candidate = resolve(arg.slice(12));
    else if (arg === "--wall-clock") wallClock = true;
    else if (arg.startsWith("--coverage-map=")) coverageMap = resolve(arg.slice(15));
    else if (arg.startsWith("--measurement-manifest=")) measurementManifest = resolve(arg.slice(23));
    else if (arg.startsWith("--mode=")) {
      const value = arg.slice(7);
      if (value !== "full" && value !== "timing") throw new Error("--mode must be full or timing.");
      mode = value;
    } else if (arg.startsWith("--isolation=")) {
      const value = arg.slice(12);
      if (value !== "default" && value !== "isolate" && value !== "shared") throw new Error("--isolation must be default, isolate or shared.");
      isolation = value;
    }
    else if (arg.startsWith("-")) throw new Error("Use --baseline=CHECKOUT --candidate=CHECKOUT [--wall-clock --coverage-map=PATH] [test files or directories]. Workers stay fixed at 2.");
    else files.push(arg);
  }
  if (!baseline || !candidate || baseline === candidate) throw new Error("Provide two different prepared checkouts, with frozen dependencies.");
  if (coverageMap && !wallClock) throw new Error("--coverage-map requires --wall-clock; full operation comparisons keep identical measurement tools.");
  if ((mode !== undefined || isolation !== undefined || measurementManifest) && (!wallClock || !mode || !isolation)) {
    throw new Error("Wrapper wall clocks require --wall-clock, --mode and --isolation together.");
  }
  return { baseline, candidate, files, wallClock, coverageMap, measurementManifest, settings: mode && isolation ? { mode, isolation } : null };
}
const locks = (cwd: string) => {
  try { return createHash("sha256").update(readFileSync(join(cwd, "bun.lock"))).update(readFileSync(join(cwd, "launcher/bun.lock"))).digest("hex"); }
  catch { return null; }
};
const sameSource = (a: Source, b: Source) => a.known && b.known && a.revision === b.revision
  && a.patchDigest === b.patchDigest && a.toolDigest === b.toolDigest && a.nodeVersion === b.nodeVersion;
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.every(item => typeof item === "string" && item.trim().length > 0 && !item.startsWith("-"))
  && new Set(value).size === value.length;

/** The map attests equivalent scenarios, including intentional test splitting.
 * Counts alone cannot provide that evidence. Its identities and targets are exact. */
function readCoverageMap(path: string | undefined, sources: Record<Version, Source>, files: string[]) {
  if (!path) throw new Error("missing-coverage-map");
  const contents = readFileSync(path), map = JSON.parse(contents.toString("utf8"));
  if (map.version !== 1 || !map.sources || !map.files || !Array.isArray(map.scenarios) || map.scenarios.length === 0) throw new Error("invalid-coverage-map");
  for (const version of ["A", "B"] as const) {
    if (!["revision", "patchDigest", "toolDigest"].every(key => map.sources[version]?.[key] === sources[version][key as keyof Source])) throw new Error(`coverage-source-mismatch-${version}`);
    if (!stringList(map.files[version]) || (files.length && JSON.stringify(map.files[version]) !== JSON.stringify(files))) throw new Error(`coverage-scope-mismatch-${version}`);
    const counts = map.expectedCounts?.[version];
    if (!counts || !Number.isSafeInteger(counts.pass) || counts.pass <= 0
      || !Number.isSafeInteger(counts.skip) || counts.skip < 0) throw new Error(`invalid-expected-counts-${version}`);
  }
  const ids = new Set<string>();
  for (const scenario of map.scenarios) {
    if (!scenario || typeof scenario.id !== "string" || !scenario.id.trim() || ids.has(scenario.id)
      || !stringList(scenario.A) || !stringList(scenario.B)) throw new Error("invalid-coverage-scenarios");
    ids.add(scenario.id);
  }
  const measurementChanges = map.measurementChanges ?? [];
  if (!Array.isArray(measurementChanges) || measurementChanges.some(change => !change || typeof change.file !== "string"
    || typeof change.reason !== "string" || !change.reason.trim() || !stringList(change.scenarioIds)
    || change.scenarioIds.some((id: string) => !ids.has(id)))
    || new Set(measurementChanges.map(change => change.file)).size !== measurementChanges.length) throw new Error("invalid-measurement-change-explanations");
  for (const file of MEASUREMENT_FILES) {
    const A = sources.A.measurementFiles?.find(entry => entry.file === file)?.digest;
    const B = sources.B.measurementFiles?.find(entry => entry.file === file)?.digest;
    if (A !== B && !measurementChanges.some(change => change.file === file)) throw new Error(`unexplained-measurement-change:${file}`);
  }
  return { path, digest: createHash("sha256").update(contents).digest("hex"), map };
}

/** Persist this value before fixture migration and reuse it with --measurement-manifest. */
export function freezeVersionMeasurementTools(cwd: string) {
  return { version: 1, timer: versionTimerProtocol, bunVersion: Bun.version, executableSha256: digest(process.execPath),
    driverSha256: digest(import.meta.path), files: commonToolFiles.map(file => ({ file, digest: digest(join(cwd, file)) })) };
}

function validateCommonTools(manifest: ReturnType<typeof freezeVersionMeasurementTools>, cwd: string) {
  const expected = freezeVersionMeasurementTools(cwd);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error("different-frozen-measurement-tools");
}

const sameFiles = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
// Windows can report long, short and case aliases for one filesystem object.
// Keep the executable digest check as well as its filesystem identity.
function sameFilesystemEntry(left: unknown, right: string) {
  if (typeof left !== "string") return false;
  try {
    const a = statSync(left, { bigint: true }), b = statSync(right, { bigint: true });
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
      && a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile();
  } catch { return false; }
}

function expectedExecutionFiles(cwd: string, targets: string[]) {
  const all = repositoryTestFiles(cwd);
  const files = targetTestFiles(cwd, targets, all);
  if (!files.length || files.some(file => !all.includes(file))) throw new Error("unknown-test-scope");
  return files;
}

function readTestResults(cwd: string, output: string, files: string[], expectedCounts: ExpectedCounts, expectedSkips: unknown, reasons: string[]) {
  try {
    const stderr = readFileSync(join(output, "stderr.log"), "utf8").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const count = (kind: string) => [...stderr.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, "g"))].at(-1)?.[1];
    const counts = { pass: count("pass") === undefined ? null : Number(count("pass")), skip: Number(count("skip") ?? 0), fail: Number(count("fail") ?? 0) };
    const expected = expectedExecutionFiles(cwd, files), executed = new Set<string>(), skips: string[] = [];
    let current = "";
    for (const line of stderr.split("\n")) {
      // The final skip list repeats results already associated with real files.
      if (/^\d+ tests? skipped:\s*$/.test(line)) break;
      const file = line.replace(/^::group::/, "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/:$/, "");
      // Parallel results repeat the file header when output switches workers.
      if (expected.includes(file) && line.endsWith(":")) { current = file; executed.add(file); }
      const skip = /^\(skip\) (.+)$/.exec(line);
      if (skip) skips.push(`${current}: ${skip[1]}`);
    }
    const reportedFiles = Number([...stderr.matchAll(/(?:^|\n)Ran \d+ tests? across (\d+) files?\./g)].at(-1)?.[1] ?? NaN);
    const executedFiles = [...executed].sort();
    if (!sameFiles(executedFiles, expected) || reportedFiles !== expected.length) reasons.push("incomplete-test-file-execution");
    if (counts.pass === null || counts.fail !== 0) reasons.push("missing-or-failed-test-results");
    if (counts.pass !== expectedCounts.pass || counts.skip !== expectedCounts.skip) reasons.push("unexpected-test-coverage-counts");
    if (counts.skip > 0) {
      if (!Array.isArray(expectedSkips) || expectedSkips.length !== counts.skip || expectedSkips.some(skip => !skip || typeof skip.test !== "string"
        || typeof skip.reason !== "string" || !skip.reason.trim()) || !sameFiles(skips, expectedSkips.map(skip => skip.test))) reasons.push("unknown-or-different-skips");
    }
    return { counts, expectedFiles: expected, executedFiles, skips, reportedFiles: Number.isFinite(reportedFiles) ? reportedFiles : null };
  } catch { reasons.push("missing-test-log-or-scope"); return { counts: null, expectedFiles: [], executedFiles: [], skips: [], reportedFiles: null }; }
}

function changedFiles(baseline: string, candidate: string) {
  const files = (cwd: string) => {
    const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8" });
    if (result.status !== 0 || result.error) throw new Error("unknown-file-differences");
    return result.stdout.split("\0").filter(Boolean);
  };
  const changes: { tools: { file: string; A: string | null; B: string | null }[]; business: { file: string; A: string | null; B: string | null }[];
    other: { file: string; A: string | null; B: string | null }[] } = { tools: [], business: [], other: [] };
  const fileDigest = (cwd: string, file: string) => { try { return digest(join(cwd, file)); } catch { return null; } };
  for (const file of [...new Set([...files(baseline), ...files(candidate)])].sort()) {
    const A = fileDigest(baseline, file), B = fileDigest(candidate, file);
    if (A === B) continue;
    const kind = /^(?:scripts\/(?:profile-tests|test-performance-|runtime-performance-|compare-test-)|src\/runtime-performance\.ts|tests\/helpers\/performance-test\.ts)/.test(file)
      ? "tools" : /^(?:src|tests)\//.test(file) ? "business" : "other";
    changes[kind].push({ file, A, B });
  }
  return changes;
}

async function observeCommand(cwd: string, output: string, command: string[], wrapper: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CGW_PERFORMANCE_") || key.startsWith("CGW_TEST_TIMING_")
      || ["CGW_RUNTIME_PERFORMANCE_DIR", "BUN_TEST_WORKER_ID", "BUN_OPTIONS", "NODE_OPTIONS"].includes(key)) delete env[key];
  }
  const fixedEnvironment = { ...env };
  for (const key of ["CGW_TEST_PROFILE_DIR", ...(wrapper ? ["TMPDIR", "TMP", "TEMP"] : [])]) delete fixedEnvironment[key];
  const environmentDigest = createHash("sha256").update(JSON.stringify(Object.entries(fixedEnvironment).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  if (wrapper) env.CGW_TEST_PROFILE_DIR = output;
  const temporaryDirectory = wrapper ? mkdtempSync(join(tmpdir(), "cgw-versions-")) : null;
  if (temporaryDirectory) Object.assign(env, { TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory });
  const invalidReasons: string[] = [];
  let exitCode: number | null = null, signal: string | null = null, wallMs: number | null = null, logDrainMs = 0;
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const copy = async (stream: ReadableStream<Uint8Array>, name: string) => {
    const reader = stream.getReader(); readers.push(reader);
    let logWritable = true;
    const save = (value: string | Uint8Array, initial = false) => {
      if (!logWritable) return;
      try {
        if (initial) writeFileSync(join(output, name), value);
        else appendFileSync(join(output, name), value);
      } catch { logWritable = false; invalidReasons.push(`log-write-failed:${name}`); }
    };
    try {
      save("", true);
      // A failed log destination must not leave the child blocked on its pipe.
      while (true) { const { done, value } = await reader.read(); if (done) break; save(value); }
    } catch { invalidReasons.push(`log-read-failed:${name}`); }
    finally { reader.releaseLock(); }
  };
  const start = process.hrtime.bigint();
  try {
    const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "pipe", stderr: "pipe", env });
    const drains = Promise.allSettled([copy(child.stdout, "stdout.log"), copy(child.stderr, "stderr.log")]);
    exitCode = await child.exited;
    wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    signal = child.signalCode ?? null;
    const drainStart = process.hrtime.bigint();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([drains, new Promise<void>(resolve => { timer = setTimeout(() => {
        invalidReasons.push("log-drain-timeout");
        for (const reader of readers) void reader.cancel().catch(() => {});
        resolve();
      }, 5_000); })]);
    } finally { clearTimeout(timer); }
    logDrainMs = Number(process.hrtime.bigint() - drainStart) / 1_000_000;
  } catch (error) { invalidReasons.push(`spawn-or-exit-failed:${error instanceof Error ? error.message : String(error)}`); }
  if (exitCode !== 0 || signal !== null) invalidReasons.push("tests-did-not-succeed");
  return { command, cwd, exitCode, signal, measuredExitMs: wallMs, parentLogDrainMs: logDrainMs, invalidReasons, environmentDigest, temporaryDirectory };
}

export async function externalWallClock(cwd: string, output: string, files: string[], expectedCounts: ExpectedCounts, expectedSkips?: unknown) {
  const command = [process.execPath, "test", "--timeout", "30000", "--parallel=2", "--isolate", ...files];
  const observed = await observeCommand(cwd, output, command, false), reportStart = process.hrtime.bigint();
  const results = readTestResults(cwd, output, files, expectedCounts, expectedSkips, observed.invalidReasons);
  const result = { protocolVersion: 2, timer: { ...versionTimerProtocol, boundary: "before-test-spawn-to-observed-exit" },
    ...observed, wallMs: observed.measuredExitMs, logDrainMs: observed.parentLogDrainMs, ...results, expectedCounts,
    parentReportMs: Number(process.hrtime.bigint() - reportStart) / 1_000_000,
    valid: observed.invalidReasons.length === 0, collection: { status: "not-requested" },
    stdout: "stdout.log", stderr: "stderr.log" };
  try { writeFileSync(join(output, "wall-clock.json"), JSON.stringify(result, null, 2) + "\n"); }
  catch { result.invalidReasons.push("measurement-write-failed"); result.valid = false; }
  return result;
}

/** Validate persisted wrapper evidence against the actual files and runtime objects. */
export function qualifyVersionSample(cwd: string, output: string, files: string[], expectedCounts: ExpectedCounts,
  expectedSkips: unknown, settings: Settings, source: Source, executableDigest: string | null,
  observed: { exitCode: number | null; invalidReasons: string[] }) {
  let summary: any = null, summaryPath: string | null = null, completion: any = null, completionPath: string | null = null;
  const reasons = observed.invalidReasons;
  const results = readTestResults(cwd, output, files, expectedCounts, expectedSkips, reasons);
  try {
    const directories = readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (directories.length !== 1) throw new Error("Expected exactly one profile run directory.");
    const run = join(output, directories[0]!.name);
    summaryPath = join(run, "summary.json");
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    if (summary?.version !== 4) reasons.push("wrapper-requires-v4-file-measurement-semantics");
    if (summary?.known !== true || !["revision", "patchDigest", "toolDigest", "nodeVersion"].every(key => summary[key] === source[key as keyof Source])
      || JSON.stringify(summary.measurementFiles) !== JSON.stringify(source.measurementFiles)) reasons.push("different-or-unknown-source");
    if (summary?.workers !== 2 || summary.mode !== settings.mode || summary.isolation !== settings.isolation
      || summary.exitCode !== observed.exitCode || summary.platform !== process.platform || summary.arch !== process.arch
      || summary.bunVersion !== Bun.version || !sameFilesystemEntry(summary.cwd, cwd) || summary.executable?.sha256 !== executableDigest
      || !sameFilesystemEntry(summary.executable?.path, process.execPath) || summary.dependencyDigest !== safeDigest(join(cwd, "bun.lock"))) reasons.push("different-execution-environment");
    if (summary?.testResult !== "success" || summary.signal !== null || summary.spawnError !== null || summary.counts?.fail !== 0
      || JSON.stringify(summary.counts) !== JSON.stringify(results.counts)) reasons.push("tests-did-not-succeed");
    if (summary?.wallValid !== true || !Array.isArray(summary.wallInvalidReasons) || summary.wallInvalidReasons.length
      || !Number.isFinite(summary.wallMs) || summary.wallMs < 0) reasons.push("invalid-root-wall-clock");
    const expectedCommand = [process.execPath, "test", "--timeout", "30000",
      ...(settings.mode === "full" ? ["--preload", join(cwd, "scripts/test-performance-preload.ts")] : []),
      "--timings", join(run, "file-timings.json"), "--update-timings", "--parallel=2",
      ...(settings.isolation === "isolate" ? ["--isolate"] : settings.isolation === "shared" ? ["--no-isolate"] : []), ...files];
    const pathArguments = new Set([0, ...expectedCommand.flatMap((arg, index) => arg === "--preload" || arg === "--timings" ? [index + 1] : [])]);
    if (!Array.isArray(summary?.command) || summary.command.length !== expectedCommand.length
      || expectedCommand.some((arg, index) => pathArguments.has(index)
        ? !sameFilesystemEntry(summary.command[index], arg) : summary.command[index] !== arg)) reasons.push("different-command-scope");
    if (summary?.scheduling?.source !== "cold" || summary.scheduling.inputDigest !== null) reasons.push("different-scheduling-inputs");
    const timing = summary?.fileTiming;
    if (timing?.version !== 2 || timing.complete !== true || timing.logsComplete !== true || timing.sourceStable !== true
      || !Array.isArray(timing.reasons) || timing.reasons.length || !Array.isArray(timing.targetFiles)
      || !Array.isArray(timing.executedFiles) || !Array.isArray(timing.measuredFiles)
      || !sameFiles(timing.targetFiles, results.expectedFiles) || !sameFiles(timing.executedFiles, results.expectedFiles)
      || !sameFiles(timing.measuredFiles, results.expectedFiles) || timing.reportedFiles !== results.expectedFiles.length) reasons.push("incomplete-file-measurement");
    const data = JSON.parse(readFileSync(join(run, "file-timings.json"), "utf8"));
    if (data?.version !== 1 || !data.files || !sameFiles(Object.keys(data.files), results.expectedFiles)
      || Object.values(data.files).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) reasons.push("invalid-file-measurements");
    if (settings.mode === "timing" && summary?.collection?.status !== "not-requested") reasons.push("different-collection-mode");
    if (settings.mode === "full" && !["complete", "incomplete"].includes(summary?.collection?.status)) reasons.push("different-collection-mode");
    completionPath = join(run, "completion.json");
    completion = JSON.parse(readFileSync(completionPath, "utf8"));
    const segments = summary?.segments, final = completion?.segments;
    if (completion?.version !== 1 || typeof summary?.runId !== "string" || completion.runId !== summary.runId
      || completion.endPoint !== "after-summary-and-status-output"
      || JSON.stringify(completion.excludes) !== JSON.stringify(["completion-write", "process-shutdown"])
      || !segments || !final || !["prepareMs", "executionMs", "logDrainMs", "reportMs", "totalMs"].every(key =>
        Number.isFinite(segments[key]) && segments[key] >= 0 && Number.isFinite(final[key]) && final[key] >= segments[key])
      || !["prepareMs", "executionMs", "logDrainMs"].every(key => final[key] === segments[key])
      || Math.abs(segments.executionMs - summary.wallMs) > 0.001
      || final.totalMs + 0.001 < final.prepareMs + final.executionMs + final.logDrainMs + final.reportMs) reasons.push("invalid-completion-segments");
  } catch (error) { reasons.push(`missing-or-invalid-wrapper-report:${error instanceof Error ? error.message : String(error)}`); }
  return { ...results, summary, summaryPath, completion, completionPath, invalidReasons: reasons };
}

/** One real wrapper execution. This does not change the formal six-sample plan. */
export async function executeVersionSample(cwd: string, output: string, files: string[], expectedCounts: ExpectedCounts,
  expectedSkips: unknown, settings: Settings, source: Source, executableDigest: string | null) {
  const command = [process.execPath, join(cwd, "scripts/profile-tests.ts"), "--parallel=2", `--mode=${settings.mode}`, `--isolation=${settings.isolation}`, ...files];
  const observed = await observeCommand(cwd, output, command, true), reportStart = process.hrtime.bigint();
  const qualified = qualifyVersionSample(cwd, output, files, expectedCounts, expectedSkips, settings, source, executableDigest, observed);
  const { summary, summaryPath, completion, completionPath, invalidReasons: reasons, ...results } = qualified;
  const parentReportMs = Number(process.hrtime.bigint() - reportStart) / 1_000_000, cleanupStart = process.hrtime.bigint();
  let cleanupStatus = "removed";
  try { if (observed.temporaryDirectory) rmSync(observed.temporaryDirectory, { recursive: true, force: true }); }
  catch { cleanupStatus = "failed"; reasons.push("temporary-directory-cleanup-failed"); }
  const observedWorkerPids: number[] = Array.isArray(summary?.children) ? [...new Set<number>(summary.children
    .filter((child: any) => child?.kind === "worker" && Number.isSafeInteger(child.pid) && child.pid > 0).map((child: any) => child.pid))] : [];
  const result = { protocolVersion: 2, timer: versionTimerProtocol, ...observed, ...results, expectedCounts,
    wrapperExitMs: observed.measuredExitMs, wallMs: Number.isFinite(summary?.wallMs) ? summary.wallMs as number : null,
    summaryPath, summary, completionPath, completion, parentReportMs, observedWorkerPids, cleanupStatus,
    parentCleanupMs: Number(process.hrtime.bigint() - cleanupStart) / 1_000_000,
    valid: reasons.length === 0, stdout: "stdout.log", stderr: "stderr.log" };
  try { writeFileSync(join(output, "wall-clock.json"), JSON.stringify(result, null, 2) + "\n"); }
  catch { result.invalidReasons.push("measurement-write-failed"); result.valid = false; }
  return result;
}

/** Check preparation, coverage and frozen tools before any wrapper can start. */
export function prepareVersionComparison(args: string[], outputOverride?: string) {
  const { baseline, candidate, files, wallClock, coverageMap, settings, measurementManifest } = versionComparisonOptions(args);
  const sources = { A: performanceSource(baseline), B: performanceSource(candidate) };
  const lockDigests = { A: locks(baseline), B: locks(candidate) };
  const output = resolve(outputOverride ?? process.env.CGW_TEST_PROFILE_DIR ?? "output/test-performance");
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "versions-")), reasons: string[] = [];
  if (!sources.A.known || !sources.B.known) reasons.push("unknown-source");
  if (!wallClock && (!sources.A.toolDigest || sources.A.toolDigest !== sources.B.toolDigest)) reasons.push("different-measurement-tools");
  if (!lockDigests.A || lockDigests.A !== lockDigests.B) reasons.push("different-or-unknown-lockfiles");
  let coverage: ReturnType<typeof readCoverageMap> | null = null;
  if (wallClock) try { coverage = readCoverageMap(coverageMap, sources, files); }
  catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  if (settings && !["installation", "warmup", "cache", "cleanup"].every(key => typeof coverage?.map.preparation?.[key] === "string"
    && coverage.map.preparation[key].trim())) reasons.push("missing-or-invalid-preparation-policy");
  const driver = { version: 2, file: import.meta.path, digest: safeDigest(import.meta.path), executable: process.execPath, executableDigest: safeDigest(process.execPath) };
  if (wallClock && (!driver.digest || !driver.executableDigest)) reasons.push("unknown-external-driver");
  let commonTools: ReturnType<typeof freezeVersionMeasurementTools> | null = null;
  let manifestDigest: string | null = null;
  if (settings) try {
    commonTools = measurementManifest ? JSON.parse(readFileSync(measurementManifest, "utf8")) : freezeVersionMeasurementTools(baseline);
    validateCommonTools(commonTools!, baseline); validateCommonTools(commonTools!, candidate);
    if (measurementManifest) manifestDigest = digest(measurementManifest);
    writeFileSync(join(directory, "measurement-tools.json"), JSON.stringify(commonTools, null, 2) + "\n");
  } catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); }
  const targets = coverage ? coverage.map.files as Record<Version, string[]> : { A: files, B: files };
  const differences = changedFiles(baseline, candidate);
  return { baseline, candidate, files, wallClock, coverageMap, settings, measurementManifest, sources, lockDigests, directory, reasons,
    driver, commonTools, manifestDigest, coverage, targets, differences };
}

export function versionSampleResult(slot: { pair: number; version: Version }) {
  return { pair: slot.pair, version: slot.version, exitCode: null as number | null, signal: null as string | null, wallMs: null as number | null,
    wrapperExitMs: null as number | null, completionPath: null as string | null, completion: null as unknown,
    summaryVersion: null as number | null, schedulingInputs: null as { path: string; digest: string }[] | null,
    summary: null as string | null, counts: null as unknown, invalidReasons: [] as string[], error: null as string | null,
    parentReportMs: null as number | null, parentLogDrainMs: null as number | null, command: null as string[] | null,
    collection: null as unknown, measurement: null as string | null, actualFiles: [] as string[], skips: [] as string[],
    environmentDigest: null as string | null,
    observedWorkerPids: [] as number[], temporaryDirectory: null as string | null, parentCleanupMs: null as number | null, cleanupStatus: null as string | null,
    workerEvidence: "Requested 2; actual worker count unverified. No operation profiler is injected to establish worker count." };
}

/** Aggregate every planned result, including invalid, failed and signalled slots. */
export function summarizeVersionSamples(runs: ReturnType<typeof versionSampleResult>[], wallClock: boolean,
  settings: Settings | null, initialReasons: string[] = []) {
  const reasons = [...initialReasons];
  if (wallClock && new Set(runs.flatMap(run => run.environmentDigest ? [run.environmentDigest] : [])).size > 1) reasons.push("different-execution-environments");
  if (runs.length !== order.length || runs.some(run => run.exitCode !== 0 || run.signal !== null || run.error || run.wallMs === null || settings && run.wrapperExitMs === null)) reasons.push("failed-or-incomplete-samples");
  if (!wallClock && runs.length && new Set(runs.map(run => JSON.stringify(run.counts))).size !== 1) reasons.push("different-test-coverage-counts");
  if (!wallClock) {
    const current = runs.filter(run => run.summaryVersion !== null && run.summaryVersion >= 3);
    if (new Set(current.map(run => JSON.stringify(run.schedulingInputs?.map(input => input.digest)))).size > 1) reasons.push("different-scheduling-inputs");
  }
  if (wallClock) for (const version of ["A", "B"] as const) {
    if (new Set(runs.filter(run => run.version === version).map(run => JSON.stringify(run.counts))).size > 1) reasons.push(`unstable-test-coverage-counts-${version}`);
  }
  const groups = (["A", "B"] as const).map(version => {
    const group = runs.filter(run => run.version === version), wrapper = durationStatistics(group.flatMap(run => run.wrapperExitMs === null ? [] : [run.wrapperExitMs]));
    return { version, attempts: group.length, failedAttempts: group.filter(run => run.exitCode !== 0 || run.signal !== null).length,
      invalidAttempts: group.filter(run => run.error !== null).length,
      wrapperExitMs: wrapper.wallMs, medianWrapperExitMs: wrapper.medianWallMs, rangeWrapperExitMs: wrapper.rangeWallMs,
      ...durationStatistics(group.flatMap(run => run.wallMs === null ? [] : [run.wallMs])) };
  });
  const valid = reasons.length === 0, a = groups[0]!, b = groups[1]!;
  const pairs = [1, 2, 3].map(pair => {
    const A = runs.find(run => run.pair === pair && run.version === "A"), B = runs.find(run => run.pair === pair && run.version === "B");
    const baselineMs = (settings ? A?.wrapperExitMs : A?.wallMs) ?? null, candidateMs = (settings ? B?.wrapperExitMs : B?.wallMs) ?? null;
    const valid = !!A && !!B && A.exitCode === 0 && B.exitCode === 0 && A.signal === null && B.signal === null
      && !A.error && !B.error && baselineMs !== null && candidateMs !== null;
    const absoluteDifferenceMs = valid ? baselineMs! - candidateMs! : null;
    return { pair, order: order.slice((pair - 1) * 2, pair * 2), valid, baselineMs, candidateMs, absoluteDifferenceMs,
      relativeDifference: valid && baselineMs! > 0 ? absoluteDifferenceMs! / baselineMs! : null,
      speedup: valid && candidateMs! > 0 ? baselineMs! / candidateMs! : null };
  });
  const repeatable = valid && pairs.every(pair => pair.absoluteDifferenceMs !== null && pair.absoluteDifferenceMs > 0);
  const differencesMs = durationStatistics(pairs.flatMap(pair => pair.absoluteDifferenceMs === null ? [] : [pair.absoluteDifferenceMs]));
  const relativeDifferences = durationStatistics(pairs.flatMap(pair => pair.relativeDifference === null ? [] : [pair.relativeDifference]));
  const medianA = settings ? a.medianWrapperExitMs : a.medianWallMs, medianB = settings ? b.medianWrapperExitMs : b.medianWallMs;
  return { valid, reasons: [...new Set(reasons)], groups, pairs,
    pairedStatistics: { metric: settings ? "wrapperExitMs" : "wallMs", absoluteDifferenceMs: { median: differencesMs.medianWallMs, range: differencesMs.rangeWallMs },
      relativeDifference: { median: relativeDifferences.medianWallMs, range: relativeDifferences.rangeWallMs } },
    conclusion: !valid ? "invalid" : repeatable ? "candidate-faster-in-all-pairs" : "insufficient-evidence",
    speedup: valid && medianA !== null && medianB !== null && medianB > 0 ? medianA / medianB : null };
}

/** Checkouts are already installed and use the same warmup and cache policy. */
export async function compareTestVersions(args: string[], outputOverride?: string) {
  const { baseline, candidate, files, wallClock, settings, measurementManifest, sources, lockDigests, directory, reasons,
    driver, commonTools, manifestDigest, coverage, targets, differences } = prepareVersionComparison(args, outputOverride);
  const runs = !reasons.length ? await scheduleVersionSamples(async slot => {
    const { version, index } = slot, cwd = version === "A" ? baseline : candidate;
    const runOutput = join(directory, `run-${index + 1}-${version}`); mkdirSync(runOutput);
    const run = versionSampleResult(slot);
    try {
      if (!sameSource(sources[version], performanceSource(cwd)) || locks(cwd) !== lockDigests[version]) throw new Error(`changed-source-${version}`);
      if (wallClock) {
        if (digest(driver.file) !== driver.digest || digest(driver.executable) !== driver.executableDigest) throw new Error("changed-external-driver");
        if (settings) {
          validateCommonTools(commonTools!, cwd);
          if (measurementManifest && safeDigest(measurementManifest) !== manifestDigest) throw new Error("changed-measurement-manifest");
          const result = await executeVersionSample(cwd, runOutput, targets[version], coverage!.map.expectedCounts[version],
            coverage!.map.expectedSkips?.[version], settings, sources[version], driver.executableDigest);
          run.exitCode = result.exitCode; run.signal = result.signal; run.wallMs = result.wallMs; run.wrapperExitMs = result.wrapperExitMs;
          run.environmentDigest = result.environmentDigest;
          run.temporaryDirectory = result.temporaryDirectory; run.parentCleanupMs = result.parentCleanupMs; run.cleanupStatus = result.cleanupStatus;
          run.observedWorkerPids = result.observedWorkerPids;
          if (result.observedWorkerPids.length) run.workerEvidence = "Worker process identities observed in existing ledgers; these do not prove exact simultaneous concurrency.";
          run.counts = result.counts; run.invalidReasons = result.invalidReasons; run.parentReportMs = result.parentReportMs;
          run.parentLogDrainMs = result.parentLogDrainMs; run.command = result.command; run.actualFiles = result.executedFiles; run.skips = result.skips;
          run.summary = result.summaryPath ? relative(directory, result.summaryPath) : null; run.summaryVersion = result.summary?.version ?? null;
          run.collection = result.summary?.collection ?? null; run.completion = result.completion;
          run.completionPath = result.completionPath ? relative(directory, result.completionPath) : null;
          if (!result.valid) run.error = result.invalidReasons.join(", ");
        } else {
          const result = await externalWallClock(cwd, runOutput, targets[version], coverage!.map.expectedCounts[version], coverage!.map.expectedSkips?.[version]);
          run.exitCode = result.exitCode; run.signal = result.signal; run.wallMs = result.wallMs; run.counts = result.counts; run.invalidReasons = result.invalidReasons;
          run.environmentDigest = result.environmentDigest;
          run.parentReportMs = result.parentReportMs; run.parentLogDrainMs = result.parentLogDrainMs; run.command = result.command;
          run.actualFiles = result.executedFiles; run.skips = result.skips; run.collection = result.collection;
          run.summary = relative(directory, join(runOutput, "wall-clock.json"));
          if (!result.valid) run.error = result.invalidReasons.join(", ");
        }
        run.measurement = relative(directory, join(runOutput, "wall-clock.json"));
      } else {
        const wrapperStart = process.hrtime.bigint();
        try {
          const child = Bun.spawn([process.execPath, join(cwd, "scripts/profile-tests.ts"), "--parallel=2", ...files], {
            cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, CGW_TEST_PROFILE_DIR: runOutput },
          });
          run.exitCode = await child.exited;
          run.wrapperExitMs = Number(process.hrtime.bigint() - wrapperStart) / 1_000_000;
          run.signal = child.signalCode ?? null;
        } finally { run.wrapperExitMs ??= Number(process.hrtime.bigint() - wrapperStart) / 1_000_000; }
        const readStart = process.hrtime.bigint();
        const { path, summary, completionPath, schedulingInputs } = readPerformanceSummary(runOutput, 2, run.exitCode, sources[version], { mode: "full", isolation: "default", files, cwd });
        run.parentReportMs = Number(process.hrtime.bigint() - readStart) / 1_000_000;
        run.wallMs = summary.wallMs; run.summary = relative(directory, path); run.counts = summary.counts;
        run.summaryVersion = summary.version; run.schedulingInputs = schedulingInputs;
        run.completion = summary.completion ?? null; run.completionPath = completionPath ? relative(directory, completionPath) : null;
      }
      if (!sameSource(sources[version], performanceSource(cwd)) || locks(cwd) !== lockDigests[version]) throw new Error(`changed-source-${version}`);
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      if (error instanceof InvalidSummary) {
        run.summary = relative(directory, error.path); run.counts = error.summary?.counts ?? null;
        run.invalidReasons.push(...error.reasons);
      } else run.invalidReasons.push(run.error);
    }
    return run;
  }) : [];
  for (const version of ["A", "B"] as const) {
    const cwd = version === "A" ? baseline : candidate;
    if (!sameSource(sources[version], performanceSource(cwd))) reasons.push(`changed-source-${version}`);
    if (locks(cwd) !== lockDigests[version]) reasons.push(`changed-lockfiles-${version}`);
  }
  if (wallClock && (safeDigest(driver.file) !== driver.digest || safeDigest(driver.executable) !== driver.executableDigest)) reasons.push("changed-external-driver");
  if (measurementManifest && safeDigest(measurementManifest) !== manifestDigest) reasons.push("changed-measurement-manifest");
  if (coverage && safeDigest(coverage.path) !== coverage.digest) reasons.push("changed-coverage-map");
  const aggregation = summarizeVersionSamples(runs, wallClock, settings, reasons);
  const report = { version: 4, mode: wallClock ? settings ? "versions-wrapper-wall-clock" : "versions-wall-clock" : "versions", workers: 2,
    measurementMode: settings?.mode ?? (wallClock ? "direct-bun" : "full"), isolation: settings?.isolation ?? (wallClock ? "isolate" : "default"), order,
    timer: settings ? versionTimerProtocol : { ...versionTimerProtocol, boundary: wallClock ? "before-test-spawn-to-observed-exit" : versionTimerProtocol.boundary },
    timingBoundaries: { wallMs: "Test root process execution.", wrapperExitMs: "Parent clock from invoking the profiler through its process exit; absent for direct wall-clock runs.",
      parentReportMs: "Parent report read and validation after observed exit and log draining; excludes comparison serialization.",
      parentCleanupMs: "Removal of the sample's private temporary directory after wrapper exit; excluded from wrapper time.",
      completion: "After summary and status output; excludes completion writing and process shutdown." },
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, sources, lockDigests, differences,
    environment: { runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null, temporaryRoot: tmpdir(),
      history: wallClock ? "cold" : "validated-per-summary", digestExcludes: ["CGW_TEST_PROFILE_DIR", ...(settings ? ["TMPDIR", "TMP", "TEMP"] : [])] },
    driver: wallClock ? driver : null, commonTools, measurementManifest: settings ? { path: measurementManifest ?? join(directory, "measurement-tools.json"), digest: manifestDigest ?? safeDigest(join(directory, "measurement-tools.json")) } : null,
    coverage, coverageVerification: "Map structure, identities, counts, files and skips are checked. Independently review original and candidate assertions and real system boundaries; JSON validation is not semantic equivalence proof.",
    allowedChanges: wallClock ? { sourceRevisionAndPatch: true, mappedScenariosAndTestCounts: true,
      measurementChanges: coverage?.map.measurementChanges ?? [], frozenMeasurementTools: settings !== null,
      fixed: ["dependency lockfiles", "Bun version and executable", "workers=2", "isolation", "collection mode", "cold scheduling", "inputs during execution"] } : null,
    files: targets, runs, ...aggregation,
    interpretation: settings ? "Fixed wrapper mode and isolation; operation completeness is reported separately from successful wall-clock eligibility."
      : wallClock ? "Direct Bun test with explicit isolate, no full/timing wrapper; this is not evidence for daily CI wrapper performance." : "Strict full operation comparison.",
    preparation: coverage?.map.preparation ?? null,
    preparationVerification: "Policies are declared by the operator; the driver checks source, lockfile and environment identities, starts separate processes and uses distinct output directories. It does not install dependencies, warm caches or share fixtures/build outputs." };
  const reportPath = join(directory, "comparison.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.info(`[test-performance] comparison=${reportPath}; conclusion=${report.conclusion}`);
  return { exitCode: aggregation.valid ? 0 : 1, reportPath, report };
}
if (import.meta.main) process.exitCode = (await compareTestVersions(process.argv.slice(2))).exitCode;
