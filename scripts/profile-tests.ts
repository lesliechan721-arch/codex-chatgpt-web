import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectPerformanceReports } from "./test-performance-reports";
import { performanceSource } from "./test-performance-source";

const root = resolve(import.meta.dir, "..");
export async function profileTests(args: string[]): Promise<number> {
  let workers = process.env.CGW_TEST_WORKERS || "1";
  const files: string[] = [], filters: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--parallel=")) workers = arg.slice("--parallel=".length);
    else if (arg.startsWith("--test-name-pattern=")) filters.push(arg);
    else if (arg.startsWith("-")) throw new Error(`Unsupported option ${arg}; use [--parallel=1|2] [--test-name-pattern=REGEX] [test files or directories].`);
    else files.push(arg);
  }
  if (workers !== "1" && workers !== "2") throw new Error("CGW_TEST_WORKERS / --parallel must be 1 or 2.");
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output", "test-performance"));
  let run: string | undefined, reports: string | undefined;
  const diagnosticErrors = new Set<string>();
  try {
    mkdirSync(output, { recursive: true });
    run = mkdtempSync(join(output, `workers-${workers}-`));
    reports = join(run, "processes");
    mkdirSync(reports);
  } catch {
    reports = undefined;
    diagnosticErrors.add("report-directory-unavailable");
    console.warn("[test-performance] Report directory unavailable; running tests without reports.");
  }
  const runId = randomUUID(), processId = randomUUID();
  const source = performanceSource(root);
  const command = [process.execPath, "test", "--timeout", "30000",
    ...(reports && run ? ["--preload", join(root, "scripts", "test-performance-preload.ts"),
      "--timings", join(run, "file-timings.json"), "--update-timings"] : []),
    ...(workers === "2" ? ["--parallel=2"] : []), ...filters, ...(files.length ? files : ["./tests"])];
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  let exitCode = 1, rootPid: number | null = null, wallMs: number | undefined;
  console.info(`[test-performance] workers=${workers}; reports=${run ?? "unavailable"}`);
  let stderr = "";
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
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CGW_RUNTIME_PERFORMANCE_DIR: reports ?? "",
      CGW_PERFORMANCE_RUN_ID: runId, CGW_PERFORMANCE_PROCESS_ID: processId, CGW_PERFORMANCE_ROOT_PROCESS_ID: processId,
      CGW_PERFORMANCE_CONTEXT: "" };
    delete env.BUN_TEST_WORKER_ID;
    const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "pipe", stderr: "pipe", env });
    rootPid = child.pid;
    const drains = Promise.allSettled([copy(child.stdout, "stdout.log", process.stdout), copy(child.stderr, "stderr.log", process.stderr)]);
    exitCode = await child.exited;
    wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    await drains;
    return exitCode;
  } finally {
    wallMs ??= Number(process.hrtime.bigint() - start) / 1_000_000;
    try {
      if (!reports || !run) throw new Error("Report directory unavailable");
      const metrics = collectPerformanceReports(reports, runId, processId, rootPid);
      metrics.incompleteReasons.push(...diagnosticErrors);
      const after = performanceSource(root);
      const counts = Object.fromEntries(["pass", "skip", "fail"].map(kind => {
        const matches = [...stderr.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, "g"))];
        return [kind, matches.length ? Number(matches.at(-1)![1]) : kind === "skip" || kind === "fail" ? 0 : null];
      }));
      if (!source.known || source.revision !== after.revision || source.patchDigest !== after.patchDigest || source.toolDigest !== after.toolDigest) metrics.incompleteReasons.push("unknown-or-changed-source");
      if (counts.pass === null) metrics.incompleteReasons.push("missing-test-result-counts");
      if (exitCode !== 0) metrics.incompleteReasons.push("tests-did-not-succeed");
      metrics.complete &&= metrics.incompleteReasons.length === 0;
      const summary = { version: 2, runId, platform: process.platform, arch: process.arch, bunVersion: Bun.version,
        nodeCompatibilityVersion: process.versions.node, runnerImage: process.env.ImageOS ?? null, runnerImageVersion: process.env.ImageVersion ?? null,
        ...source, workers: Number(workers), command: ["bun", "test", "--timeout", "30000", "--preload", "scripts/test-performance-preload.ts",
          "--timings", "file-timings.json", "--update-timings", ...(workers === "2" ? ["--parallel=2"] : []), ...filters, ...(files.length ? files : ["./tests"])],
        startedAt, endedAt: new Date().toISOString(), exitCode, wallMs, counts, ...metrics,
        timingSemantics: "Parent totals include child operations. Bytes are supplied bytes, including failed attempts. Do not add nested or parallel durations." };
      writeFileSync(join(run, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      console.info(`[test-performance] wall=${(wallMs / 1000).toFixed(2)}s; exit=${exitCode}; snapshots=${metrics.snapshots}; complete=${metrics.complete}`);
      if (!metrics.complete) console.warn(`[test-performance] Incomplete metrics: ${metrics.incompleteReasons.join(", ")}; invalid=${metrics.invalidReports.length}`);
    } catch (error) {
      console.warn(`[test-performance] Could not collect performance reports; preserving test exit=${exitCode}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
if (import.meta.main) process.exitCode = await profileTests(process.argv.slice(2));
