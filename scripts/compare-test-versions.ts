import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { durationStatistics, InvalidSummary, readPerformanceSummary } from "./compare-test-performance";
import { performanceSource } from "./test-performance-source";

type Version = "A" | "B";
type Source = ReturnType<typeof performanceSource>;
type ExpectedCounts = { pass: number; skip: number };
const order: Version[] = ["A", "B", "B", "A", "A", "B"];
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const safeDigest = (path: string) => { try { return digest(path); } catch { return null; } };

export function versionComparisonOptions(args: string[]) {
  let baseline: string | undefined, candidate: string | undefined, coverageMap: string | undefined;
  let wallClock = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--baseline=")) baseline = resolve(arg.slice(11));
    else if (arg.startsWith("--candidate=")) candidate = resolve(arg.slice(12));
    else if (arg === "--wall-clock") wallClock = true;
    else if (arg.startsWith("--coverage-map=")) coverageMap = resolve(arg.slice(15));
    else if (arg.startsWith("-")) throw new Error("Use --baseline=CHECKOUT --candidate=CHECKOUT [--wall-clock --coverage-map=PATH] [test files or directories]. Workers stay fixed at 2.");
    else files.push(arg);
  }
  if (!baseline || !candidate || baseline === candidate) throw new Error("Provide two different prepared checkouts, with frozen dependencies.");
  if (coverageMap && !wallClock) throw new Error("--coverage-map requires --wall-clock; full operation comparisons keep identical measurement tools.");
  return { baseline, candidate, files, wallClock, coverageMap };
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
  return { path, digest: createHash("sha256").update(contents).digest("hex"), map };
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

export async function externalWallClock(cwd: string, output: string, files: string[], expectedCounts: ExpectedCounts) {
  const command = [process.execPath, "test", "--timeout", "30000", "--parallel=2", "--isolate", ...files];
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CGW_PERFORMANCE_") || key.startsWith("CGW_TEST_TIMING_")
      || ["CGW_RUNTIME_PERFORMANCE_DIR", "BUN_TEST_WORKER_ID", "BUN_OPTIONS", "NODE_OPTIONS"].includes(key)) delete env[key];
  }
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
    exitCode = await child.exited; signal = child.signalCode ?? null;
    wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
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
  let counts: { pass: number | null; skip: number; fail: number } | null = null;
  try {
    const stderr = readFileSync(join(output, "stderr.log"), "utf8");
    const count = (kind: string) => [...stderr.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, "g"))].at(-1)?.[1];
    counts = { pass: count("pass") === undefined ? null : Number(count("pass")), skip: Number(count("skip") ?? 0), fail: Number(count("fail") ?? 0) };
    if (counts.pass === null || counts.fail !== 0) invalidReasons.push("missing-or-failed-test-results");
    if (counts.pass !== expectedCounts.pass || counts.skip !== expectedCounts.skip) invalidReasons.push("unexpected-test-coverage-counts");
  } catch { invalidReasons.push("missing-test-log"); }
  const result = { protocolVersion: 1, command, cwd, exitCode, signal, wallMs, logDrainMs, counts, expectedCounts,
    valid: invalidReasons.length === 0, invalidReasons, collection: { status: "not-requested" },
    stdout: "stdout.log", stderr: "stderr.log" };
  writeFileSync(join(output, "wall-clock.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

/** Checkouts are already installed and use the same warmup and cache policy. */
export async function compareTestVersions(args: string[], outputOverride?: string) {
  const { baseline, candidate, files, wallClock, coverageMap } = versionComparisonOptions(args);
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
  const driver = { version: 1, file: import.meta.path, digest: safeDigest(import.meta.path), executable: process.execPath, executableDigest: safeDigest(process.execPath) };
  if (wallClock && (!driver.digest || !driver.executableDigest)) reasons.push("unknown-external-driver");
  const targets = coverage ? coverage.map.files as Record<Version, string[]> : { A: files, B: files };
  const differences = changedFiles(baseline, candidate);
  const runs: { pair: number; version: Version; exitCode: number | null; wallMs: number | null; wrapperExitMs: number | null;
    completionPath: string | null; completion: unknown; summary: string | null; counts: unknown; invalidReasons: string[];
    summaryVersion: number | null; schedulingInputs: { path: string; digest: string }[] | null; error: string | null }[] = [];
  if (!reasons.length) for (const version of order) {
    const cwd = version === "A" ? baseline : candidate;
    const runOutput = join(directory, `run-${runs.length + 1}-${version}`); mkdirSync(runOutput);
    const run = { pair: Math.floor(runs.length / 2) + 1, version, exitCode: null as number | null, wallMs: null as number | null,
      wrapperExitMs: null as number | null, completionPath: null as string | null, completion: null as unknown,
      summaryVersion: null as number | null, schedulingInputs: null as { path: string; digest: string }[] | null,
      summary: null as string | null, counts: null as unknown, invalidReasons: [] as string[], error: null as string | null };
    try {
      if (!sameSource(sources[version], performanceSource(cwd)) || locks(cwd) !== lockDigests[version]) throw new Error(`changed-source-${version}`);
      if (wallClock) {
        if (digest(driver.file) !== driver.digest || digest(driver.executable) !== driver.executableDigest) throw new Error("changed-external-driver");
        const result = await externalWallClock(cwd, runOutput, targets[version], coverage!.map.expectedCounts[version]);
        run.exitCode = result.exitCode; run.wallMs = result.wallMs; run.counts = result.counts; run.invalidReasons = result.invalidReasons;
        run.summary = relative(directory, join(runOutput, "wall-clock.json"));
        if (!result.valid) run.error = result.invalidReasons.join(", ");
      } else {
        const wrapperStart = process.hrtime.bigint();
        try {
          const child = Bun.spawn([process.execPath, join(cwd, "scripts/profile-tests.ts"), "--parallel=2", ...files], {
            cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, CGW_TEST_PROFILE_DIR: runOutput },
          });
          run.exitCode = await child.exited;
        } finally { run.wrapperExitMs = Number(process.hrtime.bigint() - wrapperStart) / 1_000_000; }
        const { path, summary, completionPath, schedulingInputs } = readPerformanceSummary(runOutput, 2, run.exitCode, sources[version], { mode: "full", isolation: "default", files, cwd });
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
    runs.push(run);
  }
  for (const version of ["A", "B"] as const) {
    const cwd = version === "A" ? baseline : candidate;
    if (!sameSource(sources[version], performanceSource(cwd))) reasons.push(`changed-source-${version}`);
    if (locks(cwd) !== lockDigests[version]) reasons.push(`changed-lockfiles-${version}`);
  }
  if (wallClock && (safeDigest(driver.file) !== driver.digest || safeDigest(driver.executable) !== driver.executableDigest)) reasons.push("changed-external-driver");
  if (coverage && safeDigest(coverage.path) !== coverage.digest) reasons.push("changed-coverage-map");
  if (runs.length !== order.length || runs.some(run => run.exitCode !== 0 || run.error || run.wallMs === null)) reasons.push("failed-or-incomplete-samples");
  if (!wallClock && runs.length && new Set(runs.map(run => JSON.stringify(run.counts))).size !== 1) reasons.push("different-test-coverage-counts");
  if (!wallClock) {
    const current = runs.filter(run => run.summaryVersion === 3);
    if (new Set(current.map(run => JSON.stringify(run.schedulingInputs?.map(input => input.digest)))).size > 1) reasons.push("different-scheduling-inputs");
  }
  if (wallClock) for (const version of ["A", "B"] as const) {
    if (new Set(runs.filter(run => run.version === version).map(run => JSON.stringify(run.counts))).size > 1) reasons.push(`unstable-test-coverage-counts-${version}`);
  }
  const groups = (["A", "B"] as const).map(version => {
    const group = runs.filter(run => run.version === version), wrapper = durationStatistics(group.flatMap(run => run.wrapperExitMs === null ? [] : [run.wrapperExitMs]));
    return { version, wrapperExitMs: wrapper.wallMs, medianWrapperExitMs: wrapper.medianWallMs, rangeWrapperExitMs: wrapper.rangeWallMs,
      ...durationStatistics(group.flatMap(run => run.wallMs === null ? [] : [run.wallMs])) };
  });
  const valid = reasons.length === 0, a = groups[0]!, b = groups[1]!;
  const pairs = [1, 2, 3].map(pair => {
    const A = runs.find(run => run.pair === pair && run.version === "A"), B = runs.find(run => run.pair === pair && run.version === "B");
    const valid = !!A && !!B && A.exitCode === 0 && B.exitCode === 0 && !A.error && !B.error && A.wallMs !== null && B.wallMs !== null;
    return { pair, valid, speedup: valid && B!.wallMs! > 0 ? A!.wallMs! / B!.wallMs! : null };
  });
  const repeatable = valid && pairs.every(pair => pair.speedup !== null && pair.speedup > 1) && Math.max(...b.wallMs) < Math.min(...a.wallMs);
  const report = { version: 3, mode: wallClock ? "versions-wall-clock" : "versions", workers: 2, isolation: wallClock ? "isolate" : "default", order,
    timingBoundaries: { wallMs: "Test root process execution.", wrapperExitMs: "Parent clock from invoking the profiler through its process exit; absent for direct wall-clock runs.",
      completion: "After summary and status output; excludes completion writing and process shutdown." },
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, sources, lockDigests, differences,
    driver: wallClock ? driver : null, coverage, files: targets, valid, reasons: [...new Set(reasons)], runs, groups, pairs,
    conclusion: !valid ? "invalid" : repeatable ? "candidate-faster-in-all-pairs" : "insufficient-evidence",
    speedup: valid && a.medianWallMs !== null && b.medianWallMs !== null && b.medianWallMs > 0 ? a.medianWallMs / b.medianWallMs : null,
    preparation: "Use the same install, warmup and cache policy in both prepared checkouts. This driver does not install dependencies or share fixtures/build outputs." };
  const reportPath = join(directory, "comparison.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.info(`[test-performance] comparison=${reportPath}; conclusion=${report.conclusion}`);
  return { exitCode: valid ? 0 : 1, reportPath, report };
}
if (import.meta.main) process.exitCode = (await compareTestVersions(process.argv.slice(2))).exitCode;
