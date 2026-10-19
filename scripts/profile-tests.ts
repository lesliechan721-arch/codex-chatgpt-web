import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectPerformanceReports } from "./test-performance-reports";
import { performanceSource } from "./test-performance-source";
import { finalizeFileTimings, prepareTimingHistory, repositoryTestFiles, targetTestFiles, timingCompatibility, timingMetadata } from "./test-timing-history";

const root = resolve(import.meta.dir, "..");
export function profileOptions(args: string[]) {
  let workers = process.env.CGW_TEST_WORKERS || "2";
  let mode: "full" | "timing" = "full";
  let isolation: "default" | "isolate" | "shared" = "default";
  let bail: number | undefined;
  const files: string[] = [], filters: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--parallel=")) workers = arg.slice("--parallel=".length);
    else if (arg.startsWith("--mode=")) {
      const value = arg.slice(7);
      if (value !== "full" && value !== "timing") throw new Error("--mode must be full or timing.");
      mode = value;
    } else if (arg.startsWith("--isolation=")) {
      const value = arg.slice(12);
      if (value !== "default" && value !== "isolate" && value !== "shared") throw new Error("--isolation must be default, isolate or shared.");
      isolation = value;
    } else if (arg.startsWith("--bail=")) {
      const value = arg.slice(7);
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--bail must be a positive safe integer.");
      bail = Number(value);
    } else if (arg.startsWith("--test-name-pattern=")) filters.push(arg);
    else if (arg.startsWith("-")) throw new Error(`Unsupported option ${arg}; use --parallel=1|2, --mode=full|timing, --isolation=default|isolate|shared, --bail=N or --test-name-pattern=REGEX.`);
    else files.push(arg);
  }
  if (workers !== "1" && workers !== "2") throw new Error("CGW_TEST_WORKERS / --parallel must be 1 or 2.");
  return { workers: Number(workers) as 1 | 2, mode, isolation, bail, files, filters };
}

export function profileEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("CGW_PERFORMANCE_") || key.startsWith("CGW_TEST_TIMING_")
      || key === "CGW_RUNTIME_PERFORMANCE_DIR" || key === "BUN_TEST_WORKER_ID") delete clean[key];
  }
  return clean;
}

const elapsed = (start: bigint) => Number(process.hrtime.bigint() - start) / 1_000_000;
const digestFile = (file: string | undefined) => {
  try { return file ? createHash("sha256").update(readFileSync(file)).digest("hex") : null; } catch { return null; }
};

/** Bound only post-exit pipe draining. It does not claim to detect or stop worker crashes. */
export async function finishProfileLogs(drains: Promise<unknown>, cancel: () => void, timeoutMs = 5_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      drains.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => { cancel(); resolve(false); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function profileTests(args: string[]): Promise<number> {
  const entry = process.hrtime.bigint();
  const { workers, mode, isolation, bail, files, filters } = profileOptions(args);
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output", "test-performance"));
  let run: string | undefined, reports: string | undefined;
  const diagnosticErrors = new Set<string>();
  try {
    mkdirSync(output, { recursive: true });
    run = mkdtempSync(join(output, `workers-${workers}-`));
    if (mode === "full") { reports = join(run, "processes"); mkdirSync(reports); }
  } catch {
    reports = undefined;
    diagnosticErrors.add("report-directory-unavailable");
    console.warn("[test-performance] Report directory unavailable; running tests without reports.");
  }
  const runId = randomUUID(), processId = randomUUID();
  const source = performanceSource(root);
  const executableDigest = digestFile(process.execPath);
  const compatibility = timingCompatibility({ workers, mode, isolation });
  const metadata = timingMetadata(root, source.revision, source.patchDigest);
  const expectedFiles = repositoryTestFiles(root);
  const targetFiles = targetTestFiles(root, files, expectedFiles);
  const history = run ? await prepareTimingHistory({ root, runDirectory: run, compatibility, files: expectedFiles })
    : { scheduling: { source: "cold" as const, reason: "report-directory-unavailable", lookupMs: 0, inputDigest: null, from: null } };
  const command = [process.execPath, "test", "--timeout", "30000",
    ...(reports ? ["--preload", join(root, "scripts", "test-performance-preload.ts")] : []),
    ...(run ? ["--timings", join(run, "file-timings.json"), ...(history.input ? ["--timings", history.input] : []), "--update-timings"] : []),
    ...(workers === 2 ? ["--parallel=2"] : []),
    ...(isolation === "isolate" ? ["--isolate"] : isolation === "shared" ? ["--no-isolate"] : []),
    ...(bail !== undefined ? [`--bail=${bail}`] : []), ...filters, ...(files.length ? files : ["./tests"])];
  const startedAt = new Date().toISOString();
  let exitCode = 1, rootPid: number | null = null, signal: string | null = null;
  let spawnError: string | null = null;
  let wallMs = 0, logDrainMs = 0;
  console.info(`[test-performance] workers=${workers}; mode=${mode}; isolation=${isolation}; reports=${run ?? "unavailable"}`);
  let stderr = "";
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const copy = async (stream: ReadableStream<Uint8Array>, name: string, sink: NodeJS.WriteStream) => {
    let logAvailable = run !== undefined;
    const save = (value: Uint8Array | string, initial = false) => {
      if (!logAvailable || !run) return;
      try {
        if (initial) writeFileSync(join(run, name), value);
        else appendFileSync(join(run, name), value);
      } catch { logAvailable = false; diagnosticErrors.add(`log-write-failed:${name}`); }
    };
    save("", true);
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        save(value);
        const chunk = decoder.decode(value, { stream: true });
        if (name === "stderr.log") stderr += chunk;
        try { sink.write(chunk); } catch { diagnosticErrors.add(`log-forward-failed:${name}`); }
      }
      if (name === "stderr.log") stderr += decoder.decode();
    } catch { diagnosticErrors.add(`log-read-failed:${name}`); }
    finally { reader.releaseLock(); }
  };
  const env = profileEnvironment(process.env);
  if (reports) Object.assign(env, { CGW_RUNTIME_PERFORMANCE_DIR: reports, CGW_PERFORMANCE_RUN_ID: runId,
    CGW_PERFORMANCE_PROCESS_ID: processId, CGW_PERFORMANCE_ROOT_PROCESS_ID: processId, CGW_PERFORMANCE_CONTEXT: "" });
  const prepareMs = elapsed(entry), start = process.hrtime.bigint();
  try {
    const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "pipe", stderr: "pipe", env });
    rootPid = child.pid;
    const drains = Promise.allSettled([copy(child.stdout, "stdout.log", process.stdout), copy(child.stderr, "stderr.log", process.stderr)]);
    exitCode = await child.exited;
    wallMs = elapsed(start);
    signal = child.signalCode ?? null;
    const drainStart = process.hrtime.bigint();
    if (!await finishProfileLogs(drains, () => {
      for (const reader of readers) void reader.cancel().catch(() => {});
    })) diagnosticErrors.add("log-drain-timeout");
    logDrainMs = elapsed(drainStart);
  } catch (error) {
    wallMs = elapsed(start);
    spawnError = error instanceof Error ? error.message : String(error);
    diagnosticErrors.add("root-start-or-wait-failed");
    console.warn(`[test-performance] Test process failed: ${spawnError}`);
  }
  const reportStart = process.hrtime.bigint();
  try {
    if (!run) throw new Error("Report directory unavailable");
    const after = performanceSource(root);
    const sourceStable = source.known && source.revision === after.revision && source.patchDigest === after.patchDigest && source.toolDigest === after.toolDigest;
    const { fileTiming, historyPublication } = finalizeFileTimings({ root, runDirectory: run, compatibility, metadata,
      expectedFiles: targetFiles, stderr, exitCode, signal, spawnError,
      fullSuiteRequested: filters.length === 0 && bail === undefined && (files.length === 0 || files.length === 1 && resolve(root, files[0]!) === join(root, "tests")),
      logsComplete: !diagnosticErrors.has("log-drain-timeout") && !diagnosticErrors.has("log-read-failed:stderr.log"), sourceStable,
      artifactDirectory: process.env.CGW_TEST_TIMING_ARTIFACT_DIR });
    let metrics: ReturnType<typeof collectPerformanceReports> = { snapshots: 0, legacySnapshots: 0, invalidReports: [],
      incompleteReasons: [], complete: false, totals: {}, contexts: [], children: [], childResultIssues: [], unassignedParameterTests: 0 };
    if (mode === "full") {
      try {
        if (!reports) throw new Error("Process report directory unavailable");
        metrics = collectPerformanceReports(reports, runId, processId, rootPid);
      } catch (error) {
        diagnosticErrors.add("report-collection-failed");
        console.warn(`[test-performance] Could not collect performance reports; preserving test exit=${exitCode}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    metrics.incompleteReasons.push(...diagnosticErrors);
    const counts = Object.fromEntries(["pass", "skip", "fail"].map(kind => {
      const matches = [...stderr.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, "g"))];
      return [kind, matches.length ? Number(matches.at(-1)![1]) : kind === "skip" || kind === "fail" ? 0 : null];
    }));
    const wallInvalidReasons = [...diagnosticErrors];
    if (!sourceStable) wallInvalidReasons.push("unknown-or-changed-source");
    if (counts.pass === null) wallInvalidReasons.push("missing-test-result-counts");
    if (rootPid === null) wallInvalidReasons.push("missing-root-process");
    metrics.incompleteReasons.push(...wallInvalidReasons.filter(reason => !metrics.incompleteReasons.includes(reason)));
    metrics.complete &&= metrics.incompleteReasons.length === 0;
    // Bun counts worker exits as failures too; aggregate counts cannot establish the cause.
    const testResult = spawnError ? "spawn-failed" : signal ? "signal" : exitCode === 0 ? "success" : "nonzero-exit";
    const reportMs = elapsed(reportStart);
    const summary = { version: 4, runId, platform: process.platform, arch: process.arch, bunVersion: Bun.version,
      nodeCompatibilityVersion: process.versions.node, runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
      ...source, workers, mode, isolation, bail: bail ?? null, command, cwd: root,
      executable: { path: process.execPath, sha256: executableDigest,
        embeddedBunSha256: digestFile(process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN),
        usesEmbeddedBun: process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN ? resolve(process.execPath) === resolve(process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN) : null },
      dependencyDigest: digestFile(join(root, "bun.lock")),
      scheduling: history.scheduling, fileTiming, historyPublication,
      startedAt, endedAt: new Date().toISOString(), rootPid, signal, spawnError, exitCode, testResult, wallMs,
      wallValid: wallInvalidReasons.length === 0, wallInvalidReasons,
      segments: { prepareMs, executionMs: wallMs, logDrainMs, reportMs, totalMs: elapsed(entry) },
      counts, ...metrics, collection: { status: mode === "timing" ? "not-requested" : metrics.complete ? "complete" : "incomplete" },
      timingCompletion: "completion.json",
      timingSemantics: "wallMs is root process execution only. These segments stop at aggregation; completion.json includes summary serialization, persistence and status output. Only a supervising process can measure wrapper exit. Parent operations include children; do not add nested or parallel durations." };
    writeFileSync(join(run, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    console.info(`[test-performance] wall=${(wallMs / 1000).toFixed(2)}s; exit=${exitCode}; snapshots=${metrics.snapshots}; collection=${summary.collection.status}`);
    if (mode === "full" && !metrics.complete || diagnosticErrors.size) console.warn(`[test-performance] Incomplete metrics: ${metrics.incompleteReasons.join(", ")}; invalid=${metrics.invalidReports.length}`);
    // Keep this final record small. Rewriting the full summary would add another
    // unmeasured serialization and write of every operation/context snapshot.
    const completion = { version: 1, runId,
      segments: { prepareMs, executionMs: wallMs, logDrainMs, reportMs: elapsed(reportStart), totalMs: elapsed(entry) },
      endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"] };
    writeFileSync(join(run, "completion.json"), JSON.stringify(completion, null, 2) + "\n");
  } catch (error) {
    console.warn(`[test-performance] Could not collect performance reports; preserving test exit=${exitCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return exitCode;
}
if (import.meta.main) process.exitCode = await profileTests(process.argv.slice(2));
