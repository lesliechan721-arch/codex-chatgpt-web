import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { HISTORY_MAX_AGE_MS, HISTORY_MAX_BYTES, finalizeFileTimings, parseTimingHistory, prepareTimingHistory,
  repositoryTestFiles, targetTestFiles, timingCompatibility, timingHistoryFilename, type TimingHistory, type TimingMetadata } from "../scripts/test-timing-history";
import { artifactTimingHistory, type HistoryFetch } from "../scripts/test-timing-history-rest";

const compatibility = timingCompatibility({ workers: 2, mode: "timing", isolation: "isolate" }, { CGW_TEST_RUNNER_CLASS: "fixture" });
const source: TimingMetadata = { revision: "a".repeat(40), patchDigest: "b".repeat(64), repository: "owner/repo", runId: "99",
  workflow: ".github/workflows/release.yml", runnerImage: "fixture-image", runnerImageVersion: "1",
  dependencyDigests: { root: "c".repeat(64), launcher: "d".repeat(64) }, createdAt: new Date().toISOString() };
function history(): TimingHistory {
  return { version: 1, compatibility: { ...compatibility }, source: { ...source, dependencyDigests: { ...source.dependencyDigests } },
    execution: { complete: true, result: "success", fullSuite: true, files: ["tests/slow.test.ts", "tests/deleted.test.ts"] },
    timings: { version: 1, files: { "tests/slow.test.ts": 800, "tests/deleted.test.ts": 10 } } };
}
async function temporary(action: (root: string) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "cgw-timing-history-"));
  try { return await action(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("history is strict numeric data with bounded size, compatible identity, and a complete file set", () => {
  expect(parseTimingHistory(JSON.stringify(history()), compatibility).timings.files["tests/slow.test.ts"]).toBe(800);
  const invalid = (change: (value: any) => void) => {
    const value = history(); change(value);
    expect(() => parseTimingHistory(JSON.stringify(value), compatibility)).toThrow();
  };
  for (const duration of [-1, null, "12", Infinity]) invalid(value => { value.timings.files["tests/slow.test.ts"] = duration; });
  for (const path of ["../tests/slow.test.ts", "/tests/slow.test.ts", "tests/../slow.test.ts", "tests\\slow.test.ts", "src/code.ts"])
    invalid(value => { value.timings.files[path] = 1; });
  invalid(value => { value.compatibility.platform = "different-os"; });
  invalid(value => { value.compatibility.workers = 1; });
  invalid(value => { value.execution.complete = false; });
  invalid(value => { value.execution.fullSuite = false; });
  invalid(value => { value.execution.files.push("tests/missing.test.ts"); });
  invalid(value => { value.source.dependencyDigests.launcher = null; });
  invalid(value => { value.source.createdAt = new Date(Date.now() - HISTORY_MAX_AGE_MS - 1000).toISOString(); });
  expect(() => parseTimingHistory("{", compatibility)).toThrow("invalid-history-json");
  expect(() => parseTimingHistory(" ".repeat(HISTORY_MAX_BYTES + 1), compatibility)).toThrow("history-too-large");
});

test("local restoration freezes an independent input, drops deleted files, and leaves new files unscheduled", () => temporary(async root => {
  const input = join(root, "history.json"), runDirectory = join(root, "run"); mkdirSync(runDirectory);
  writeFileSync(input, JSON.stringify(history()));
  const restored = await prepareTimingHistory({ root, runDirectory, compatibility,
    files: ["tests/slow.test.ts", "tests/new.test.ts"], env: { CGW_TEST_TIMING_HISTORY: input } });
  expect(restored.scheduling).toMatchObject({ source: "restored", reason: "compatible-history", from: { kind: "local", runId: "99", revision: source.revision } });
  expect(restored.scheduling.lookupMs).toBeGreaterThanOrEqual(0);
  expect(restored.input).not.toBe(input);
  expect(JSON.parse(readFileSync(restored.input!, "utf8"))).toEqual({ version: 1, files: { "tests/slow.test.ts": 800 } });
  writeFileSync(input, "bad replacement");
  expect(readFileSync(restored.input!, "utf8")).toContain("800");
}));

test("ordinary local runs never look up remote history; invalid inputs have an explicit cold reason", () => temporary(async root => {
  const runDirectory = join(root, "run"); mkdirSync(runDirectory);
  const input = join(root, "bad.json"); writeFileSync(input, "{");
  const request: HistoryFetch = async () => { throw new Error("Unexpected network access"); };
  const cold = await prepareTimingHistory({ root, runDirectory, compatibility, files: [], env: {}, fetch: request });
  expect(cold.scheduling).toMatchObject({ source: "cold", reason: "no-history-input" });
  const invalid = await prepareTimingHistory({ root, runDirectory, compatibility, files: [], env: { CGW_TEST_TIMING_HISTORY: input }, fetch: request });
  expect(invalid.scheduling).toMatchObject({ source: "cold", reason: "invalid-history-json" });
}));

test("repository file discovery follows Bun test/spec suffixes and excludes performance helpers", () => temporary(root => {
  mkdirSync(join(root, "tests/helpers"), { recursive: true });
  const included = ["a.test.ts", "b_test.ts", "c.spec.ts", "d_spec.ts"];
  for (const file of [...included, "helpers/performance-test.ts"])
    writeFileSync(join(root, "tests", file), 'import {test} from "bun:test"; test("discovery",()=>{});');
  const child = spawnSync(process.execPath, ["test", "./tests"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  expect(child.status).toBe(0);
  expect(child.stderr).toContain("Ran 4 tests across 4 files.");
  expect(child.stderr).not.toContain("helpers/performance-test.ts:");
  expect(repositoryTestFiles(root)).toEqual(included.map(file => `tests/${file}`).sort());
}));

for (const githubActions of [false, true]) test(`Bun 1.4.2 second round reads the measured first round and starts slow files before fast files (${githubActions ? "GitHub Actions" : "ordinary"} output)`, () => temporary(async root => {
  mkdirSync(join(root, "tests"));
  for (const [name, delay] of [["a-fast", 5], ["b-medium", 80], ["c-medium", 100], ["z-slow", 250]] as const) {
    writeFileSync(join(root, `tests/${name}.test.ts`), `import {test} from "bun:test"; import {appendFileSync, readFileSync} from "node:fs";
      test(${JSON.stringify(name)}, async()=> {
        appendFileSync(process.env.ORDER_LOG, ${JSON.stringify(name + "\n")});
        if (process.env.ORDER_BARRIER === "1") {
          const deadline = Date.now() + 5000;
          while (readFileSync(process.env.ORDER_LOG, "utf8").trim().split("\\n").length < 2) {
            if (Date.now() >= deadline) throw new Error("Second timing worker did not start");
            await Bun.sleep(5);
          }
        }
        await Bun.sleep(${delay});
      });`);
  }
  const files = repositoryTestFiles(root);
  const artifactDirectory = join(root, "artifacts");
  let input: string | undefined;
  for (const round of [1, 2]) {
    const runDirectory = join(root, `run-${round}`); mkdirSync(runDirectory);
    const prepared = await prepareTimingHistory({ root, runDirectory, compatibility, files,
      env: input ? { CGW_TEST_TIMING_HISTORY: input } : {} });
    expect(prepared.scheduling.source).toBe(round === 1 ? "cold" : "restored");
    const orderLog = join(root, `order-${round}`);
    const command = ["test", "--timings", join(runDirectory, "file-timings.json"),
      ...(prepared.input ? ["--timings", prepared.input] : []), "--update-timings", "--parallel=2", "--parallel-delay=0", "--isolate", "./tests"];
    const env: NodeJS.ProcessEnv = { ...process.env, ORDER_LOG: orderLog, ORDER_BARRIER: round === 2 ? "1" : "0" };
    if (githubActions) env.GITHUB_ACTIONS = "true";
    else delete env.GITHUB_ACTIONS;
    const child = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8", timeout: 10_000, env });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    expect(child.stderr.replaceAll("\\", "/").includes("::group::tests/")).toBe(githubActions);
    const result = finalizeFileTimings({ root, runDirectory, compatibility, metadata: source, expectedFiles: files,
      stderr: child.stderr, exitCode: child.status!, signal: child.signal, spawnError: null, fullSuiteRequested: true,
      logsComplete: true, sourceStable: true, artifactDirectory });
    expect(result.fileTiming).toMatchObject({ version: 2, complete: true, fullSuite: true, targetFiles: files, reportedFiles: 4, measuredFiles: files, executedFiles: files });
    expect(result.historyPublication).toMatchObject({ status: "succeeded", stage: null, remoteUpload: "not-observed" });
    input = join(runDirectory, "history.json");
    if (round === 2) {
      const order = readFileSync(orderLog, "utf8").trim().split("\n");
      const measured = (JSON.parse(readFileSync(join(root, "run-1/history.json"), "utf8")) as TimingHistory).timings;
      const slowest = Object.entries(measured.files).sort((a, b) => b[1] - a[1])[0]![0];
      // Workers start independently. The slowest measured file must start in
      // the first pair, before either worker can finish and take another file.
      expect(order.slice(0, 2)).toContain(slowest.replace(/^tests\//, "").replace(/\.test\.ts$/, ""));
      expect(readFileSync(prepared.input!, "utf8")).toBe(JSON.stringify(measured) + "\n");
    }
  }
  expect(readdirSync(artifactDirectory)).toEqual([timingHistoryFilename(compatibility)]);
}));

for (const prefix of ["", "::group::"]) test(`file headers normalize Windows paths with ${prefix || "ordinary"} output`, () => temporary(root => {
  writeFileSync(join(root, "file-timings.json"), JSON.stringify({ version: 1, files: { "tests\\slow.test.ts": 800 } }));
  const result = finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source,
    expectedFiles: ["tests/slow.test.ts"], stderr: `\x1b[1m${prefix}.\\tests\\slow.test.ts:\x1b[0m\r\nRan 1 test across 1 file. [1ms]\r\n`,
    exitCode: 0, signal: null, spawnError: null, fullSuiteRequested: true, logsComplete: true, sourceStable: true });
  expect(result.fileTiming).toMatchObject({ complete: true, executedFiles: ["tests/slow.test.ts"], measuredFiles: ["tests/slow.test.ts"] });
  expect(JSON.parse(readFileSync(join(root, "file-timings.json"), "utf8"))).toEqual({ version: 1, files: { "tests/slow.test.ts": 800 } });
}));

for (const githubActions of [false, true]) test(`parallel output repeats file context headers without repeating execution (${githubActions ? "GitHub Actions" : "ordinary"})`, () => temporary(root => {
  mkdirSync(join(root, "tests"));
  const evaluationLog = join(root, "evaluations.log");
  for (const name of ["first", "second"] as const) {
    writeFileSync(join(root, `tests/${name}.test.ts`), `import {test} from "bun:test";
      import {appendFileSync, existsSync, writeFileSync} from "node:fs";
      import {join} from "node:path";
      const root=${JSON.stringify(root)}, name=${JSON.stringify(name)};
      appendFileSync(${JSON.stringify(evaluationLog)}, name+"\\n");
      writeFileSync(join(root,name+"-ready"),"");
      for(let round=0;round<3;round++) test(name+"-"+round,async()=>{
        const prerequisite=name==="first" ? (round===0 ? "second-ready" : "second-"+(round-1)) : "first-"+round;
        const deadline=Date.now()+5000;
        while(!existsSync(join(root,prerequisite))) {
          if(Date.now()>=deadline) throw Error("Parallel sibling did not reach "+prerequisite);
          await Bun.sleep(2);
        }
        await Bun.sleep(10);
        writeFileSync(join(root,name+"-"+round),"");
      });`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  if (githubActions) env.GITHUB_ACTIONS = "true";
  else delete env.GITHUB_ACTIONS;
  const child = spawnSync(process.execPath, ["test", "--timings", join(root, "file-timings.json"), "--update-timings",
    "--parallel=2", "--parallel-delay=0", "./tests"], { cwd: root, encoding: "utf8", timeout: 10_000, env });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
  expect(readFileSync(evaluationLog, "utf8").trim().split("\n").sort()).toEqual(["first", "second"]);
  const stderr = child.stderr.replaceAll("\\", "/").replace(/\x1b\[[0-9;]*m/g, "");
  const files = ["tests/first.test.ts", "tests/second.test.ts"];
  for (const file of files) expect(stderr.split("\n").filter(line => line === `${githubActions ? "::group::" : ""}${file}:`).length).toBeGreaterThan(1);
  const result = finalizeFileTimings({ root, runDirectory: root,
    compatibility: timingCompatibility({ workers: 2, mode: "timing", isolation: "default" }), metadata: source, expectedFiles: files,
    stderr: child.stderr, exitCode: child.status!, signal: child.signal, spawnError: null,
    fullSuiteRequested: true, logsComplete: true, sourceStable: true });
  expect(result.fileTiming).toMatchObject({ complete: true, fullSuite: true, targetFiles: files,
    executedFiles: files, measuredFiles: files, reportedFiles: 2, reasons: [] });
}));

test("partial execution removes merged historical values and never publishes a whole-suite history", () => temporary(root => {
  writeFileSync(join(root, "file-timings.json"), JSON.stringify(history().timings));
  const result = finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source,
    expectedFiles: ["tests/slow.test.ts"], stderr: "\ntests/slow.test.ts:\n 1 pass\n 0 fail\nRan 1 test across 1 file. [1ms]\n",
    exitCode: 0, signal: null, spawnError: null, fullSuiteRequested: false, logsComplete: true, sourceStable: true, artifactDirectory: join(root, "artifacts") });
  expect(result.fileTiming).toMatchObject({ complete: true, fullSuite: false, targetFiles: ["tests/slow.test.ts"], measuredFiles: ["tests/slow.test.ts"], reasons: [] });
  expect(result.historyPublication).toMatchObject({ status: "ineligible", stage: "eligibility", reasons: ["not-full-suite"] });
  expect(JSON.parse(readFileSync(join(root, "file-timings.json"), "utf8"))).toEqual({ version: 1, files: { "tests/slow.test.ts": 800 } });
  expect(readdirSync(root)).toEqual(["file-timings.json"]);
}));

for (const fault of ["exit", "logs", "source", "count", "missing-header", "missing-timing"]) test(`whole-suite file publication rejects ${fault}`, () => temporary(root => {
  const value = history();
  if (fault === "missing-timing") delete value.timings.files["tests/slow.test.ts"];
  writeFileSync(join(root, "file-timings.json"), JSON.stringify(value.timings));
  const stderr = `\ntests/slow.test.ts:\n${fault === "missing-header" ? "" : "tests/deleted.test.ts:\n"} 2 pass\n 0 fail\nRan 2 tests across ${fault === "count" ? 1 : 2} files. [1ms]\n`;
  const result = finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source, expectedFiles: value.execution.files,
    stderr, exitCode: fault === "exit" ? 1 : 0, signal: null, spawnError: null, fullSuiteRequested: true,
    logsComplete: fault !== "logs", sourceStable: fault !== "source", artifactDirectory: join(root, "artifacts") });
  expect(result.fileTiming.complete).toBe(fault === "exit" || fault === "source");
  expect(result.historyPublication.status).toBe("ineligible");
}));

function measuredRun(root: string, changes: Partial<Parameters<typeof finalizeFileTimings>[0]> = {}) {
  writeFileSync(join(root, "file-timings.json"), JSON.stringify({ version: 1, files: { "tests/slow.test.ts": 12 } }));
  return finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source, expectedFiles: ["tests/slow.test.ts"],
    stderr: "tests/slow.test.ts:\nRan 1 test across 1 file.\n", exitCode: 0, signal: null, spawnError: null,
    fullSuiteRequested: true, logsComplete: true, sourceStable: true, ...changes });
}

test("ordinary CI keeps complete measurements without gaining trusted publication rights", () => temporary(root => {
  const metadata = { ...source, workflow: ".github/workflows/ci.yml" };
  const unrequested = measuredRun(root, { metadata });
  expect(unrequested.fileTiming).toMatchObject({ complete: true, fullSuite: true, reasons: [] });
  expect(unrequested.historyPublication).toMatchObject({ status: "not-requested", stage: null, remoteUpload: "not-observed" });
  const requested = measuredRun(root, { metadata, artifactDirectory: join(root, "artifacts") });
  expect(requested.fileTiming.complete).toBe(true);
  expect(requested.historyPublication).toMatchObject({ status: "ineligible", stage: "eligibility", reasons: ["untrusted-history-workflow"] });
  expect(readdirSync(root)).toEqual(["file-timings.json"]);
  const untrusted = history(); untrusted.source.workflow = metadata.workflow;
  expect(() => parseTimingHistory(JSON.stringify(untrusted), compatibility)).toThrow("invalid-history-source");
}));

for (const stage of ["validation", "local-history-write", "artifact-staging"] as const) {
  test(`history ${stage} failure preserves complete measurements and identifies the failed action`, () => temporary(root => {
    const artifactDirectory = join(root, "artifacts");
    if (stage === "local-history-write") mkdirSync(join(root, "history.json"));
    if (stage === "artifact-staging") writeFileSync(artifactDirectory, "blocked");
    const result = measuredRun(root, { artifactDirectory, metadata: stage === "validation" ? { ...source, revision: null } : source });
    expect(result.fileTiming).toMatchObject({ complete: true, reasons: [] });
    expect(result.historyPublication).toMatchObject({ status: "failed", stage, remoteUpload: "not-observed", artifactPath: null });
    expect(result.historyPublication.reasons.length).toBeGreaterThan(0);
    expect(result.historyPublication.localPath === null).toBe(stage !== "artifact-staging");
  }));
}

test("a sanitized timing-output write failure retains validated measurements and the original output", () => temporary(root => {
  measuredRun(root);
  const path = join(root, "file-timings.json"), original = readFileSync(path, "utf8"), write = fs.writeFileSync;
  const spy = spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === path) throw new Error("timing output unavailable");
    return write(...args);
  }) as typeof fs.writeFileSync);
  try {
    const result = finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source, expectedFiles: ["tests/slow.test.ts"],
      stderr: "tests/slow.test.ts:\nRan 1 test across 1 file.\n", exitCode: 23, signal: null, spawnError: null,
      fullSuiteRequested: true, logsComplete: true, sourceStable: true });
    expect(result.fileTiming).toMatchObject({ complete: true, reasons: [], outputWriteError: "timing output unavailable" });
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally { spy.mockRestore(); }
}));

for (const defect of ["different-file", "duplicate-target", "invalid-duration", "duplicate-duration", "normalized-duplicate"] as const) {
  test(`measurement integrity rejects ${defect} without trusting equal file counts`, () => temporary(root => {
    const changes: Partial<Parameters<typeof finalizeFileTimings>[0]> = {};
    if (defect === "different-file") changes.stderr = "tests/other.test.ts:\nRan 1 test across 1 file.\n";
    if (defect === "duplicate-target") changes.expectedFiles = ["tests/slow.test.ts", "tests/slow.test.ts"];
    measuredRun(root);
    if (defect === "invalid-duration") writeFileSync(join(root, "file-timings.json"), '{"version":1,"files":{"tests/slow.test.ts":-1}}');
    if (defect === "duplicate-duration") writeFileSync(join(root, "file-timings.json"), '{"version":1,"files":{"tests/slow.test.ts":1,"tests/slow.test.ts":2}}');
    if (defect === "normalized-duplicate") writeFileSync(join(root, "file-timings.json"), JSON.stringify({ version: 1, files: { "tests/slow.test.ts": 1, "tests\\slow.test.ts": 2 } }));
    const original = readFileSync(join(root, "file-timings.json"), "utf8");
    const result = finalizeFileTimings({ root, runDirectory: root, compatibility, metadata: source, expectedFiles: ["tests/slow.test.ts"],
      stderr: "tests/slow.test.ts:\nRan 1 test across 1 file.\n", exitCode: 0, signal: null, spawnError: null,
      fullSuiteRequested: true, logsComplete: true, sourceStable: true, ...changes });
    expect(result.fileTiming.complete).toBe(false);
    expect(result.fileTiming.reasons.length).toBeGreaterThan(0);
    if (["invalid-duration", "duplicate-duration", "normalized-duplicate"].includes(defect)) expect(readFileSync(join(root, "file-timings.json"), "utf8")).toBe(original);
  }));
}

test("positional file selection records the requested subset rather than the whole repository", () => temporary(root => {
  mkdirSync(join(root, "tests/nested"), { recursive: true });
  for (const file of ["tests/slow.test.ts", "tests/nested/fast.test.ts"]) writeFileSync(join(root, file), "");
  const all = repositoryTestFiles(root);
  expect(targetTestFiles(root, [], all)).toEqual(all);
  expect(targetTestFiles(root, ["./tests"], all)).toEqual(all);
  expect(targetTestFiles(root, ["./tests/nested"], all)).toEqual(["tests/nested/fast.test.ts"]);
  expect(targetTestFiles(root, ["slow"], all)).toEqual(["tests/slow.test.ts"]);
}));

function githubMock(change?: { run?: (run: any) => void; artifact?: (artifact: any) => void; history?: (history: TimingHistory) => void; denied?: boolean }) {
  const run: any = { id: 99, workflow_id: 7, head_sha: source.revision, status: "completed", conclusion: "failure",
    event: "push", path: source.workflow, created_at: source.createdAt,
    repository: { id: 1, full_name: "owner/repo" }, head_repository: { id: 1, full_name: "owner/repo" } };
  const value = history(); change?.history?.(value);
  const archive = zipSync({ [timingHistoryFilename(compatibility)]: new TextEncoder().encode(JSON.stringify(value)) });
  const artifact: any = { id: 55, name: "test-timings-fixture", expired: false, expires_at: new Date(Date.now() + 60_000).toISOString(),
    size_in_bytes: archive.byteLength, workflow_run: { id: 99, repository_id: 1, head_repository_id: 1, head_sha: source.revision } };
  change?.run?.(run); change?.artifact?.(artifact);
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: HistoryFetch = async (url, init) => {
    requests.push({ url, init });
    if (change?.denied) return new Response("denied", { status: 403 });
    const path = new URL(url).pathname;
    if (path.endsWith("/workflows/release.yml/runs")) return Response.json({ workflow_runs: [run] });
    if (path.endsWith("/workflows/windows-performance.yml/runs")) return Response.json({ workflow_runs: [] });
    if (path.endsWith("/runs/99")) return Response.json(run);
    if (path.endsWith("/runs/99/artifacts")) return Response.json({ artifacts: [artifact] });
    if (path.endsWith("/artifacts/55/zip")) return new Response(null, { status: 302, headers: { location: "https://results.githubusercontent.com/history.zip" } });
    if (url === "https://results.githubusercontent.com/history.zip") return new Response(archive);
    throw new Error("Unexpected mock request");
  };
  return { fetcher, requests };
}
const remoteEnv = { CGW_TEST_TIMING_RESTORE: "1", CGW_TEST_TIMING_TOKEN: "mock-read-token", GITHUB_REPOSITORY: "owner/repo", GITHUB_RUN_ID: "100" };

test("cross-run restoration pins the run and artifact; another matrix failure does not invalidate complete platform data", () => temporary(async root => {
  const mock = githubMock();
  const result = await prepareTimingHistory({ root, runDirectory: root, compatibility, files: history().execution.files, env: remoteEnv, fetch: mock.fetcher });
  expect(result.scheduling).toMatchObject({ source: "restored", from: { kind: "artifact", runId: "99", artifactId: 55, revision: source.revision, workflow: source.workflow } });
  expect(mock.requests.some(request => request.url.endsWith("/runs/99/artifacts?per_page=100"))).toBe(true);
  const download = mock.requests.find(request => request.url.startsWith("https://results.githubusercontent.com/"))!;
  expect(download.init?.headers).toBeUndefined();
  expect(mock.requests.filter(request => request.url.startsWith("https://api.github.com/")).every(request => new Headers(request.init?.headers).get("authorization") === "Bearer mock-read-token")).toBe(true);
}));

for (const [name, change] of [
  ["foreign workflow", { run: (run: any) => { run.path = ".github/workflows/untrusted.yml"; } }],
  ["foreign repository", { run: (run: any) => { run.repository.full_name = "elsewhere/repo"; } }],
  ["fork source", { run: (run: any) => { run.head_repository.id = 2; } }],
  ["artifact run mismatch", { artifact: (artifact: any) => { artifact.workflow_run.id = 98; } }],
  ["artifact SHA mismatch", { artifact: (artifact: any) => { artifact.workflow_run.head_sha = "f".repeat(40); } }],
  ["envelope run mismatch", { history: (value: TimingHistory) => { value.source.runId = "98"; } }],
  ["envelope SHA mismatch", { history: (value: TimingHistory) => { value.source.revision = "f".repeat(40); } }],
  ["expired artifact", { artifact: (artifact: any) => { artifact.expired = true; } }],
  ["permission denied", { denied: true }],
] as const) test(`remote ${name} produces a bounded cold start`, () => temporary(async root => {
  const mock = githubMock(change);
  const result = await prepareTimingHistory({ root, runDirectory: root, compatibility, files: history().execution.files, env: remoteEnv, fetch: mock.fetcher });
  expect(result.scheduling.source).toBe("cold"); expect(result.input).toBeUndefined();
  if (name === "permission denied") expect(result.scheduling.reason).toBe("http-403");
}));

test("remote lookup has one total deadline even if the external request never settles", () => temporary(async root => {
  const start = performance.now();
  const result = await prepareTimingHistory({ root, runDirectory: root, compatibility, files: [], env: remoteEnv,
    fetch: async () => new Promise(() => {}), budgetMs: 15 });
  expect(result.scheduling).toMatchObject({ source: "cold", reason: "history-lookup-timeout" });
  expect(performance.now() - start).toBeLessThan(1000);
}));

test("artifact extraction only reads the fixed compatible JSON name and caps decompressed bytes", () => {
  const encoded = new TextEncoder().encode(JSON.stringify(history()));
  expect(() => artifactTimingHistory(zipSync({ "../history.json": encoded }), compatibility)).toThrow("no-compatible-artifact-entry");
  expect(() => artifactTimingHistory(zipSync({ [timingHistoryFilename(compatibility)]: new Uint8Array(HISTORY_MAX_BYTES + 1) }), compatibility)).toThrow("invalid-archive-entry");
  expect(artifactTimingHistory(zipSync({ "do-not-run.js": new TextEncoder().encode("throw Error()"), [timingHistoryFilename(compatibility)]: encoded }), compatibility).source.runId).toBe("99");
});
