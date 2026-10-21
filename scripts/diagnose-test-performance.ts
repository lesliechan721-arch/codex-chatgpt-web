import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finishProfileLogs, profileEnvironment } from "./profile-tests";
import { performanceSource } from "./test-performance-source";
import { repositoryTestFiles } from "./test-timing-history";

const root = resolve(import.meta.dir, "..");
const suites: Record<string, string[]> = {
  continuity: ["./tests/continuity-task-update.test.ts", "./tests/session-continuity-compaction.test.ts"],
  "continuity-task": ["./tests/continuity-task-update.test.ts"],
  "continuity-adapter": ["./tests/continuity-task-update.test.ts", "./tests/session-continuity-adapter.test.ts"],
  "continuity-source": ["./tests/session-continuity-compaction.test.ts"],
  cli: ["./tests/api-key-cli.test.ts"],
  all: ["./tests"],
};
const diagnosticConditions = [
  { name: "original-1", workers: 1, mode: "full", isolation: "default" },
  { name: "original-2", workers: 2, mode: "full", isolation: "default" },
  { name: "isolated-full-1", workers: 1, mode: "full", isolation: "isolate" },
  { name: "isolated-full-2", workers: 2, mode: "full", isolation: "isolate" },
  { name: "isolated-timing-1", workers: 1, mode: "timing", isolation: "isolate" },
  { name: "isolated-timing-2", workers: 2, mode: "timing", isolation: "isolate" },
];
const modePairConditions = [
  { name: "default-full-2", workers: 2, mode: "full", isolation: "default" },
  { name: "default-timing-2", workers: 2, mode: "timing", isolation: "default" },
];
export const diagnosticClock = { protocolVersion: 2, clock: "node:process.hrtime.bigint",
  boundary: "before-wrapper-spawn-to-observed-exit" } as const;
export function diagnosticOptions(args: string[]) {
  let suite = "continuity", repetitions = 3;
  let condition = "all", history = "cold", pattern = "";
  let skipEvidencePath: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("--suite=")) suite = arg.slice(8);
    else if (arg.startsWith("--condition=")) condition = arg.slice(12);
    else if (arg.startsWith("--history=")) history = arg.slice(10);
    else if (arg.startsWith("--test-name-pattern=")) pattern = arg.slice(20);
    else if (arg.startsWith("--skip-evidence=")) {
      if (!arg.slice(16)) throw new Error("--skip-evidence requires a file path.");
      skipEvidencePath = resolve(arg.slice(16));
    }
    else if (arg.startsWith("--repetitions=")) {
      const value = arg.slice(14);
      if (!["1", "2", "3", "10"].includes(value)) throw new Error("--repetitions must be 1, 2, 3 or 10.");
      repetitions = Number(value);
    } else throw new Error(`Unsupported diagnostic option: ${arg}`);
  }
  if (!Object.hasOwn(suites, suite)) throw new Error(`--suite must be one of ${Object.keys(suites).join(", ")}.`);
  const modePair = condition === "mode-pair";
  if (skipEvidencePath && !modePair) throw new Error("--skip-evidence is only available with --condition=mode-pair.");
  const conditions = modePair ? modePairConditions : condition === "all" ? diagnosticConditions : diagnosticConditions.filter(item => item.name === condition);
  if (!conditions.length) throw new Error("Unknown diagnostic condition.");
  if (history !== "cold" && history !== "restore") throw new Error("--history must be cold or restore.");
  if (modePair && (suite !== "all" || history !== "cold" || pattern)) {
    throw new Error("--condition=mode-pair requires --suite=all, --history=cold and no test filter.");
  }
  if (history === "restore" && (suite !== "all" || pattern || condition === "all")) {
    throw new Error("History restoration requires the full suite, one condition and no test filter.");
  }
  if (repetitions === 10 && suite !== "cli" && suite !== "continuity-source") throw new Error("Ten repetitions are reserved for CLI and source regression suites.");
  if (pattern) new RegExp(pattern);
  return { suite, repetitions, files: suites[suite]!, conditions, history, pattern, modePair, skipEvidencePath };
}

/** Timing credentials reach only the wrapper; profileTests removes them before spawning tests. */
export function diagnosticEnvironment(env: NodeJS.ProcessEnv, history: string, runOutput: string, modePair = false): NodeJS.ProcessEnv {
  const clean = profileEnvironment(env);
  if (modePair) {
    delete clean.CGW_API_KEY_CLI_DIAGNOSTICS;
    delete clean.CGW_CONTINUITY_SOURCE_DIAGNOSTICS;
  }
  return { ...clean, CGW_TEST_PROFILE_DIR: runOutput,
    CGW_TEST_TIMING_ARTIFACT_DIR: modePair ? undefined : env.CGW_TEST_TIMING_ARTIFACT_DIR,
    ...(history === "restore" ? { CGW_TEST_TIMING_RESTORE: "1", CGW_TEST_TIMING_TOKEN: env.CGW_TEST_TIMING_TOKEN } : {}),
    ...(!modePair ? { CGW_API_KEY_CLI_DIAGNOSTICS: "1", CGW_CONTINUITY_SOURCE_DIAGNOSTICS: "1" } : {}) };
}

const digest = (file: string) => { try { return createHash("sha256").update(readFileSync(file)).digest("hex"); } catch { return null; } };
const elapsed = (start: bigint) => Number(process.hrtime.bigint() - start) / 1_000_000;
const sameFiles = (a: string[], b: string[]) => {
  const sorted = [...b].sort();
  return a.length === b.length && [...a].sort().every((file, i) => file === sorted[i]);
};
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string") && new Set(value).size === value.length;
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

function diagnosticInputs() {
  return { source: performanceSource(root), dependencies: { root: digest(join(root, "bun.lock")), launcher: digest(join(root, "launcher/bun.lock")) },
    driverDigest: digest(import.meta.path), executable: { path: process.execPath, sha256: digest(process.execPath), bunVersion: Bun.version,
      embeddedBunSha256: process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN ? digest(process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN) : null },
    files: repositoryTestFiles(root) };
}
type Inputs = ReturnType<typeof diagnosticInputs>;
export type ModePairSample = {
  round: number; condition: { name: string; workers: number; mode: string; isolation: string }; command: string[];
  exitCode: number | null; signal: string | number | null; error: string | null; wrapperWallMs: number | null;
  parentLogDrainMs: number; logIssues: string[]; summary: Record<string, any> | null; completion: Record<string, any> | null;
  before: Inputs; after: Inputs; environmentDigest: string;
  runner: { instance: string; category: string; image: string | null; imageVersion: string | null; platform: string; arch: string };
  skips: { count: number | null; entries: { file: string; name: string; reason: string | null }[]; complete: boolean;
    evidence?: { path: string; sha256: string | null; issues: string[] } };
  cleanup: { status: string; error: string | null };
};

function inputIssues(before: Inputs, after: Inputs) {
  const issues: string[] = [];
  if (!before.source.known || !after.source.known) issues.push("unknown-source");
  if (!before.driverDigest || !before.executable.sha256 || !before.dependencies.root || !before.dependencies.launcher) issues.push("unknown-tool-or-dependencies");
  if (JSON.stringify(before) !== JSON.stringify(after)) issues.push("changed-inputs-during-execution");
  return issues;
}

/** Full operation completeness is deliberately independent of wall-clock eligibility. */
export function modePairSampleIssues(run: ModePairSample, expectedFiles: string[]) {
  const issues = inputIssues(run.before, run.after), summary = run.summary;
  if (run.exitCode !== 0 || run.signal !== null || run.error !== null) issues.push("wrapper-did-not-succeed");
  if (run.wrapperWallMs === null || !Number.isFinite(run.wrapperWallMs) || run.wrapperWallMs <= 0) issues.push("invalid-external-clock");
  if (run.logIssues.length) issues.push("incomplete-wrapper-logs");
  if (run.cleanup.status !== "removed") issues.push("temporary-cleanup-not-complete");
  issues.push(...run.skips.evidence?.issues ?? []);
  if (!summary || summary.version !== 4 || summary.fileTiming?.version !== 2) return [...issues, "missing-or-unsupported-summary"];
  if (summary.testResult !== "success" || summary.exitCode !== 0 || summary.signal !== null || summary.spawnError !== null || summary.wallValid !== true) issues.push("tests-did-not-succeed-or-invalid-wall");
  if (summary.mode !== run.condition.mode || summary.workers !== 2 || summary.isolation !== "default" || summary.bail !== null) issues.push("different-execution-condition");
  if (run.condition.mode === "timing" && (summary.collection?.status !== "not-requested" || Array.isArray(summary.command) && summary.command.includes("--preload"))) issues.push("timing-collected-operation-profiler");
  if (!Array.isArray(summary.command) || !summary.command.includes("--parallel=2")
    || summary.command.includes("--isolate") || summary.command.includes("--no-isolate")
    || summary.command.some((arg: unknown) => typeof arg !== "string" || /^(?:--bail|--test-name-pattern|--shard|--only|--changed)/.test(arg))
    || summary.command.at(-1) !== "./tests") issues.push("different-test-command");
  if (!["revision", "patchDigest", "toolDigest"].every(key => summary[key] === run.before.source[key as keyof Inputs["source"]])
    || summary.executable?.sha256 !== run.before.executable.sha256 || summary.bunVersion !== run.before.executable.bunVersion
    || summary.dependencyDigest !== run.before.dependencies.root) issues.push("different-summary-identity");
  const timing = summary.fileTiming;
  if (!timing.complete || !timing.fullSuite || timing.logsComplete !== true || timing.sourceStable !== true
    || ![timing.targetFiles, timing.executedFiles, timing.measuredFiles].every(files => stringList(files) && sameFiles(files, expectedFiles))
    || timing.reportedFiles !== expectedFiles.length || !sameFiles(run.before.files, expectedFiles)) issues.push("incomplete-target-execution-or-measurement");
  if (summary.scheduling?.source !== "cold" || summary.scheduling?.inputDigest !== null) issues.push("non-cold-scheduling-input");
  if (!record(summary.counts) || !Number.isSafeInteger(summary.counts.pass) || summary.counts.pass <= 0
    || !Number.isSafeInteger(summary.counts.skip) || summary.counts.skip < 0 || summary.counts.fail !== 0) issues.push("missing-or-failed-test-counts");
  if (!run.skips.complete || run.skips.count !== summary.counts?.skip) issues.push("unknown-skips");
  if (run.skips.entries.some(entry => entry.reason === null)) issues.push("skip-reasons-unverified");
  if (!run.completion || run.completion.runId !== summary.runId || run.completion.version !== 1) issues.push("missing-wrapper-completion");
  return issues;
}

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { values, median: sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null,
    range: sorted.length ? [sorted[0]!, sorted.at(-1)!] : null };
}

export function compareModePairs(runs: ModePairSample[], repetitions: number, expectedFiles: string[]) {
  const pairs = Array.from({ length: repetitions }, (_, i) => {
    const round = i + 1, pair = runs.filter(run => run.round === round);
    const full = pair.find(run => run.condition.mode === "full"), timing = pair.find(run => run.condition.mode === "timing");
    const issues = pair.flatMap(run => modePairSampleIssues(run, expectedFiles).map(issue => `${run.condition.mode}:${issue}`));
    if (!full || !timing || pair.length !== 2) issues.push("missing-or-duplicate-pair-side");
    if (full && timing) {
      if (JSON.stringify(full.before) !== JSON.stringify(timing.before)) issues.push("different-pair-inputs");
      if (JSON.stringify(full.runner) !== JSON.stringify(timing.runner)) issues.push("different-runner-instance");
      if (full.environmentDigest !== timing.environmentDigest) issues.push("different-environment");
      if (["pass", "skip", "fail"].some(kind => full.summary?.counts?.[kind] !== timing.summary?.counts?.[kind])
        || JSON.stringify(full.skips.entries) !== JSON.stringify(timing.skips.entries)) issues.push("different-test-results-or-skips");
      if (JSON.stringify(pair.map(run => run.condition.mode)) !== JSON.stringify(round % 2 ? ["full", "timing"] : ["timing", "full"])) issues.push("different-planned-order");
    }
    const valid = issues.length === 0;
    const rawDifferenceMs = full?.wrapperWallMs !== null && timing?.wrapperWallMs !== null
      && typeof full?.wrapperWallMs === "number" && typeof timing?.wrapperWallMs === "number" ? full.wrapperWallMs - timing.wrapperWallMs : null;
    const absoluteSavingMs = valid ? full!.wrapperWallMs! - timing!.wrapperWallMs! : null;
    return { round, order: pair.map(run => run.condition.mode), fullWrapperWallMs: full?.wrapperWallMs ?? null,
      timingWrapperWallMs: timing?.wrapperWallMs ?? null, valid, issues,
      rawDifferenceMs, rawRelativeDifference: rawDifferenceMs !== null && full!.wrapperWallMs! > 0 ? rawDifferenceMs / full!.wrapperWallMs! : null,
      absoluteSavingMs, relativeSaving: valid ? absoluteSavingMs! / full!.wrapperWallMs! : null };
  });
  const validPairs = pairs.filter(pair => pair.valid), issues: string[] = [];
  if (validPairs.length < 3) issues.push("fewer-than-three-valid-pairs");
  if (pairs.some(pair => !pair.valid)) issues.push("failed-or-incomplete-pairs-retained");
  if (validPairs.some(pair => pair.absoluteSavingMs! <= 0)) issues.push("no-net-benefit-in-every-valid-pair");
  // Across rounds the instance may differ, but its runner class and image must match.
  const environments = runs.map(run => JSON.stringify({ ...run.runner, instance: undefined, environmentDigest: run.environmentDigest }));
  if (new Set(environments).size > 1) issues.push("different-runner-class-image-or-environment");
  if (runs.some(run => run.runner.platform === "win32" && (!run.runner.image || !run.runner.imageVersion))) issues.push("unknown-windows-runner-image");
  if (new Set(runs.map(run => JSON.stringify(run.before))).size > 1) issues.push("changed-experiment-inputs");
  const didFail = (run: ModePairSample) => run.exitCode !== 0 || run.signal !== null || run.error !== null || run.summary?.testResult !== "success";
  const failedRuns = runs.filter(didFail).length;
  return { conclusion: issues.length ? "insufficient-evidence" : "timing-switch-candidate", issues, validPairs: validPairs.length,
    plannedPairs: repetitions, pairs, fullWrapperWallMs: statistics(validPairs.map(pair => pair.fullWrapperWallMs!)),
    timingWrapperWallMs: statistics(validPairs.map(pair => pair.timingWrapperWallMs!)),
    absoluteSavingMs: statistics(validPairs.map(pair => pair.absoluteSavingMs!)), relativeSaving: statistics(validPairs.map(pair => pair.relativeSaving!)),
    failures: { numerator: failedRuns, denominator: runs.length },
    failuresByMode: ["full", "timing"].map(mode => { const samples = runs.filter(run => run.condition.mode === mode);
      return { mode, numerator: samples.filter(didFail).length, denominator: samples.length }; }),
    invalidSamples: { numerator: runs.filter(run => modePairSampleIssues(run, expectedFiles).length > 0).length, denominator: runs.length },
    limitations: ["Small samples do not establish a reliable p95 or failure rate.", "This conclusion does not authorize a CI configuration change.",
      "Bun logs identify skipped tests but do not emit structured reasons. Missing reasons are unverified, not unequal. Candidate qualification requires reviewed reason evidence bound to the frozen source and every skipped test."] };
}

/** The clock stops before signal inspection, pipe draining or report parsing. */
export async function observeDiagnosticWrapper(command: string[], output: string, env: NodeJS.ProcessEnv) {
  const logIssues: string[] = [], readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const copy = async (stream: ReadableStream<Uint8Array>, name: string, sink: NodeJS.WriteStream) => {
    const reader = stream.getReader(); readers.push(reader);
    let writable = true;
    try {
      try { writeFileSync(join(output, name), ""); } catch { writable = false; logIssues.push(`log-write-failed:${name}`); }
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (writable) try { appendFileSync(join(output, name), value); } catch { writable = false; logIssues.push(`log-write-failed:${name}`); }
        try { sink.write(value); } catch { logIssues.push(`log-forward-failed:${name}`); }
      }
    } catch { logIssues.push(`log-read-failed:${name}`); }
    finally { reader.releaseLock(); }
  };
  let exitCode: number | null = null, signal: string | number | null = null, error: string | null = null, wrapperWallMs: number | null = null, parentLogDrainMs = 0, exitedAt: string | null = null;
  const startedAt = new Date().toISOString(), start = process.hrtime.bigint();
  try {
    const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "pipe", stderr: "pipe", env });
    const drains = Promise.allSettled([copy(child.stdout, "wrapper-stdout.log", process.stdout), copy(child.stderr, "wrapper-stderr.log", process.stderr)]);
    exitCode = await child.exited;
    wrapperWallMs = elapsed(start);
    exitedAt = new Date().toISOString();
    signal = child.signalCode ?? null;
    const drainStart = process.hrtime.bigint();
    if (!await finishProfileLogs(drains, () => { for (const reader of readers) void reader.cancel().catch(() => {}); })) logIssues.push("log-drain-timeout");
    parentLogDrainMs = elapsed(drainStart);
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  return { exitCode, signal, error, wrapperWallMs, parentLogDrainMs, logIssues, startedAt, exitedAt,
    stdout: join(output, "wrapper-stdout.log"), stderr: join(output, "wrapper-stderr.log") };
}

type SkipReasonDocument = { version: 1; source: Pick<Inputs["source"], "revision" | "patchDigest" | "toolDigest">;
  entries: { file: string; name: string; reason: string }[] };
type SkipReasonEvidence = { path: string; sha256: string | null; document: SkipReasonDocument | null; issues: string[] };

/** Invalid review evidence limits the conclusion; it never changes which tests run. */
export function readSkipReasonEvidence(path: string | undefined): SkipReasonEvidence | null {
  if (!path) return null;
  const result: SkipReasonEvidence = { path, sha256: null, document: null, issues: [] };
  let bytes: Buffer;
  try { bytes = readFileSync(path); result.sha256 = createHash("sha256").update(bytes).digest("hex"); }
  catch { result.issues.push("skip-evidence-unreadable"); return result; }
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!record(value) || value.version !== 1 || !record(value.source) || !Array.isArray(value.entries)
      || !["revision", "patchDigest", "toolDigest"].every(key => typeof value.source[key] === "string"
        && new RegExp(`^[a-f0-9]{${key === "revision" ? 40 : 64}}$`).test(value.source[key]))
      || !value.entries.every(entry => record(entry) && [entry.file, entry.name, entry.reason].every(text => typeof text === "string" && text.trim().length > 0))) {
      result.issues.push("invalid-skip-evidence-schema"); return result;
    }
    const keys = value.entries.map(entry => JSON.stringify([entry.file, entry.name]));
    if (new Set(keys).size !== keys.length) { result.issues.push("duplicate-skip-evidence-entry"); return result; }
    result.document = value as SkipReasonDocument;
  } catch { result.issues.push("invalid-skip-evidence-json"); }
  return result;
}

export function applySkipReasonEvidence(observed: ModePairSample["skips"], evidence: SkipReasonEvidence | null,
  source: Inputs["source"], hashes: { before: string | null; after: string | null }): ModePairSample["skips"] {
  if (!evidence) return observed;
  const issues = [...evidence.issues], document = evidence.document;
  if (evidence.sha256 !== hashes.before || evidence.sha256 !== hashes.after) issues.push("skip-evidence-changed");
  if (document) {
    if (!source.known || !["revision", "patchDigest", "toolDigest"].every(key => document.source[key as keyof typeof document.source] === source[key as keyof typeof source])) issues.push("skip-evidence-source-mismatch");
    const key = (entry: { file: string; name: string }) => JSON.stringify([entry.file, entry.name]);
    const actual = observed.entries.map(key), expected = document.entries.map(key);
    if (!observed.complete || actual.length !== new Set(actual).size || !sameFiles(actual, expected)) issues.push("skip-evidence-scope-mismatch");
  }
  const reasons = new Map(document?.entries.map(entry => [JSON.stringify([entry.file, entry.name]), entry.reason]));
  return { ...observed, entries: observed.entries.map(entry => ({ ...entry,
    reason: issues.length ? entry.reason : reasons.get(JSON.stringify([entry.file, entry.name])) ?? null })),
    evidence: { path: evidence.path, sha256: evidence.sha256, issues } };
}

export function readDiagnosticSkips(summary: Record<string, any> | null, reportDirectory: string | null) {
  const entries: ModePairSample["skips"]["entries"] = [];
  const count = Number.isSafeInteger(summary?.counts?.skip) ? summary!.counts.skip as number : null;
  if (!reportDirectory) return { count, entries, complete: false };
  try {
    let file = "";
    for (const line of readFileSync(join(reportDirectory, "stderr.log"), "utf8").replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").split("\n")) {
      // Bun repeats skipped names in its final list, without their file headers.
      if (/^\d+ tests? skipped:\s*$/.test(line)) break;
      const normalized = line.replace(/^::group::/, "").replaceAll("\\", "/").replace(/^\.\//, "");
      if (normalized.endsWith(":")) file = normalized.slice(0, -1);
      const match = line.match(/^\(skip\) (.+)$/);
      if (match) entries.push({ file, name: match[1]!, reason: null });
    }
    entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { count, entries, complete: count !== null && count === entries.length && entries.every(entry => entry.file.startsWith("tests/")) };
  } catch { return { count, entries, complete: false }; }
}

/** Diagnostic repetitions retain failures; no successful repetition replaces an earlier exit. */
export async function diagnoseTestPerformance(args: string[]) {
  const { suite, repetitions, files, conditions, history, pattern, modePair, skipEvidencePath } = diagnosticOptions(args);
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output/test-performance"));
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "diagnostic-"));
  const source = performanceSource(root);
  const expectedFiles = repositoryTestFiles(root);
  const skipReasons = readSkipReasonEvidence(skipEvidencePath);
  const runs: ModePairSample[] = [];
  let failed = false;
  const runner = { instance: `${process.env.GITHUB_RUN_ID ?? "local"}:${process.env.GITHUB_RUN_ATTEMPT ?? "1"}:${process.env.RUNNER_NAME ?? process.pid}`,
    category: process.env.CGW_TEST_RUNNER_CLASS ?? "local", image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null,
    platform: process.platform, arch: process.arch };
  const preparation = { installation: "Dependencies are installed before this driver; root and launcher lockfile digests are recorded for every attempt.",
    warmup: "No separate warmup; all rounds use the same policy.", history: modePair ? "Cold on both sides; no previous output is restored." : history,
    cache: "No explicit OS/runtime cache clearing; AB/BA/AB balances order but does not prove cold OS caches.",
    cleanup: "Each mode-pair attempt uses a new empty temporary directory, removed after wrapper exit; no fixture state is shared.",
    temporaryRoot: tmpdir(), scheduling: "No supplied timing history in cold mode." };
  let parentReportTotalMs = 0;
  const reportErrors: string[] = [];
  const save = () => {
    const reportStart = process.hrtime.bigint();
    try {
    writeFileSync(join(directory, "diagnostic.json"), JSON.stringify({ version: 2, source,
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, executable: process.execPath,
    suite, files, expectedFiles, repetitions, conditions, history, pattern, modePair, skipReasonEvidence: skipReasons, runner, preparation, clock: diagnosticClock, runs,
    parentReportTotalMs, reportErrors, comparison: modePair ? compareModePairs(runs, repetitions, expectedFiles) : null,
    limitations: ["The continuity pair is selected for diagnosis; the historical adjacent-file order is unknown.",
      "Requested workers are not proof that two workers executed. Inspect process ledgers in full mode; timing mode does not collect worker identities.",
      "No crash-only termination policy is enabled. Exit code 3 and log text are not trusted crash signals.",
      "History is cold unless explicitly requested. Check each summary for actual restoration and source identity.",
      "Failed runs are diagnostic samples, not performance evidence."],
    timingSemantics: "wrapperWallMs stops immediately when wrapper exit is observed. Parent log draining, input checks, report parsing, cleanup and total-report writing are excluded and reported separately. Wrapper summary segments retain their own meanings.",
  }, null, 2) + "\n");
    } catch (error) {
      reportErrors.push(error instanceof Error ? error.message : String(error));
      failed = true;
      console.warn(`[test-performance] Could not save diagnostics; preserving recorded test exits: ${reportErrors.at(-1)}`);
    }
    parentReportTotalMs += elapsed(reportStart);
  };
  save();
  for (let round = 1; round <= repetitions; round++) {
    for (const condition of round % 2 ? conditions : [...conditions].reverse()) {
      const runOutput = join(directory, `round-${round}-${condition.name}`);
      mkdirSync(runOutput);
      const command = [process.execPath, join(root, "scripts/profile-tests.ts"), `--parallel=${condition.workers}`,
        `--mode=${condition.mode}`, `--isolation=${condition.isolation}`, ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files];
      let temporaryDirectory: string | null = null, preparationError: string | null = null;
      if (modePair) try { temporaryDirectory = mkdtempSync(join(tmpdir(), "cgw-mode-pair-")); }
      catch (error) { preparationError = error instanceof Error ? error.message : String(error); }
      const env = diagnosticEnvironment(process.env, history, runOutput, modePair);
      if (temporaryDirectory) Object.assign(env, { TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory });
      // Paths vary per attempt by design. Hash the remaining environment without exposing credentials.
      const environmentDigest = createHash("sha256").update(JSON.stringify(Object.entries(env)
        .filter(([key]) => !["CGW_TEST_PROFILE_DIR", "TMPDIR", "TMP", "TEMP"].includes(key)).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
      const before = diagnosticInputs();
      const skipEvidenceBefore = skipEvidencePath ? digest(skipEvidencePath) : null;
      const observed = preparationError ? { exitCode: null, signal: null, error: `preparation-failed:${preparationError}`, wrapperWallMs: null,
        parentLogDrainMs: 0, logIssues: [], startedAt: new Date().toISOString(), exitedAt: null,
        stdout: join(runOutput, "wrapper-stdout.log"), stderr: join(runOutput, "wrapper-stderr.log") }
        : await observeDiagnosticWrapper(command, runOutput, env);
      const reportStart = process.hrtime.bigint();
      const after = diagnosticInputs();
      let summary: Record<string, any> | null = null, completion: Record<string, any> | null = null;
      let reportDirectory: string | null = null, reportError: string | null = null;
      try {
        const dirs = readdirSync(runOutput, { withFileTypes: true }).filter(entry => entry.isDirectory());
        if (dirs.length !== 1) throw new Error("Expected one wrapper report directory.");
        reportDirectory = join(runOutput, dirs[0]!.name);
        const value: unknown = JSON.parse(readFileSync(join(reportDirectory, "summary.json"), "utf8"));
        if (!record(value)) throw new Error("Invalid wrapper summary.");
        summary = value;
        const final: unknown = JSON.parse(readFileSync(join(reportDirectory, "completion.json"), "utf8"));
        if (record(final)) completion = final;
      } catch (caught) { reportError = caught instanceof Error ? caught.message : String(caught); }
      const skips = applySkipReasonEvidence(readDiagnosticSkips(summary, reportDirectory), skipReasons, before.source,
        { before: skipEvidenceBefore, after: skipEvidencePath ? digest(skipEvidencePath) : null });
      const workers = Array.isArray(summary?.children) ? summary.children.filter(child => child?.kind === "worker" && Number.isSafeInteger(child.pid) && child.pid > 0) : [];
      const parentReportMs = elapsed(reportStart), cleanupStart = process.hrtime.bigint();
      let cleanupStatus = temporaryDirectory ? "removed" : preparationError ? "preparation-failed" : "not-requested", cleanupError: string | null = null;
      if (temporaryDirectory) try { rmSync(temporaryDirectory, { recursive: true, force: true }); }
      catch (caught) { cleanupStatus = "failed"; cleanupError = caught instanceof Error ? caught.message : String(caught); }
      failed ||= observed.exitCode !== 0 || observed.signal !== null || summary === null;
      const run = { round, condition, command, ...observed, before, after, environmentDigest, runner, summary, completion, skips,
        parentReportMs, parentCleanupMs: elapsed(cleanupStart), reportError,
        environment: { CI: env.CI ?? null, extraCliDiagnostics: env.CGW_API_KEY_CLI_DIAGNOSTICS ?? null,
          extraContinuityDiagnostics: env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS ?? null, NODE_OPTIONS: env.NODE_OPTIONS ?? null, BUN_OPTIONS: env.BUN_OPTIONS ?? null },
        temporaryDirectory, cleanup: { status: cleanupStatus, error: cleanupError },
        reportPath: reportDirectory ? join(reportDirectory, "summary.json") : null,
        completionPath: reportDirectory ? join(reportDirectory, "completion.json") : null,
        workerEvidence: { requested: condition.workers, verification: workers.length ? "observed-processes" : "unverified",
          observedPids: [...new Set(workers.map(child => child.pid))],
          limitation: "Observed worker processes do not prove exact simultaneous concurrency; requested workers are configuration only." },
        wrapperSegments: completion?.segments ?? summary?.segments ?? null,
        result: { status: summary?.testResult ?? (observed.error ? "spawn-or-wait-failed" : observed.signal ? "signal" : "missing-summary"),
          counts: summary?.counts ?? null, operationCollection: summary?.collection ?? null,
          logDrainComplete: !observed.logIssues.length, completionStatus: completion ? "available" : "missing" },
      };
      runs.push(run);
      save();
    }
  }
  try {
    writeFileSync(join(directory, "diagnostic-completion.json"), JSON.stringify({ version: 1, parentReportTotalMs, reportErrors,
      endPoint: "after-final-diagnostic-report-write", excludes: ["diagnostic-completion-write", "process-shutdown"] }, null, 2) + "\n");
  } catch (error) { failed = true; console.warn(`[test-performance] Could not save diagnostic completion: ${error instanceof Error ? error.message : String(error)}`); }
  console.info(`[test-performance] diagnostics=${directory}; failed=${failed}`);
  return failed ? 1 : 0;
}
if (import.meta.main) process.exitCode = await diagnoseTestPerformance(process.argv.slice(2));
