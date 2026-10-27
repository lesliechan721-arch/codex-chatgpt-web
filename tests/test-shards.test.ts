import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateShardEvidence, aggregateShardOptions, loadShardArtifacts, loadSkipPolicy, type ShardAggregationInput } from "../scripts/aggregate-test-shards";
import { readPerformanceSummary } from "../scripts/compare-test-performance";
import { profileOptions } from "../scripts/profile-tests";
import { assertColdShardEnvironment, balanceShardPlan, coldShardFiles, loadShardPlan, parseShardPlan, parseTestShard, plannedShardFiles, testFileSetDigest, testLogResult, type TestShardPlan } from "../scripts/test-shards";
import { planTestShards } from "../scripts/plan-test-shards";
import { finalizeFileTimings, repositoryTestFiles, timingCompatibility, timingMetadata } from "../scripts/test-timing-history";
import { verificationCommands, verifyOptions } from "../scripts/verify";

const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/nested/c.test.ts", "tests/z.test.ts"];
const revision = "a".repeat(40), patchDigest = "b".repeat(64), toolDigest = "c".repeat(64);
function gateFixture(mode: "full" | "timing" = "full", planned = false): ShardAggregationInput {
  const workflowRun = { id: "42", attempt: "2", repository: "owner/repo" };
  const targets = planned ? [[files[0]!, files[1]!], [files[2]!, files[3]!]] : [[files[0]!, files[2]!], [files[1]!, files[3]!]];
  const plan = { path: ".github/windows-test-shards.json", digest: "1".repeat(64), plan: {
    version: 1, platform: "win32", bunVersion: "1.4.3", workers: 2, source: { runId: "41", revision, repository: "owner/repo" },
    overheadMs: [10, 0], shards: targets.map(target => ({ files: Object.fromEntries(target.map(file => [file, 1])) })),
  } as TestShardPlan };
  const shards = targets.map((target, i) => {
    const stderr = target.map(file => `${file}:\n(pass) a case [1ms]\n`).join("") + `\n ${target.length} pass\n 0 fail\nRan ${target.length} tests across ${target.length} files.\n`;
    const summary = { version: planned ? 6 : 5, fullSuite: false, runId: `run-${i + 1}`, known: true, revision, patchDigest, toolDigest,
      dependencyDigest: "d".repeat(64), launcherDependencyDigest: "e".repeat(64), workflowRevision: revision, workflowRun,
      shard: { index: i + 1, total: 2, repositoryFiles: files, repositoryFilesDigest: testFileSetDigest(files), expectedFiles: target,
        ...(planned ? { plan: { path: plan.path, digest: plan.digest } } : {}) },
      workers: 2, isolation: "default", mode, platform: "win32", arch: "x64", bunVersion: "1.4.3", executable: { path: "C:\\bun\\bun.exe", sha256: "f".repeat(64) }, cwd: "C:\\checkout",
      scheduling: planned ? { source: "plan", reason: "committed-shard-plan", lookupMs: 0, inputDigest: plan.digest, from: { path: plan.path } }
        : { source: "cold", reason: "shard-cold-only", inputDigest: null, from: null },
      historyPublication: { status: "not-requested", localPath: null, artifactPath: null },
      exitCode: 0, signal: null, spawnError: null, testResult: "success", wallValid: true, wallMs: 10,
      segments: { prepareMs: 1, executionMs: 10, logDrainMs: 0, reportMs: 1, totalMs: 12 },
      counts: { pass: 2, skip: 0, fail: 0 }, skipIdentities: [], bail: null,
      command: ["C:\\bun\\bun.exe", "test", "--timeout", "30000", ...(mode === "full" ? ["--preload", "C:\\checkout\\scripts\\test-performance-preload.ts"] : []),
        "--timings", `C:\\reports\\run-${i + 1}\\file-timings.json`, "--update-timings", "--parallel=2",
        ...(planned ? target.map(file => `./${file}`) : [`--shard=${i + 1}/2`, "./tests"])],
      fileTiming: { version: 3, complete: true, fullSuite: false, logsComplete: true, sourceStable: true, outputWriteError: null, reasons: [],
        targetFiles: target, executedFiles: target, measuredFiles: target, reportedFiles: 2 },
      evidence: { summary: "summary.json", completion: "completion.json", stdout: "stdout.log", stderr: "stderr.log", timings: "file-timings.json" } };
    return { directory: `artifact-${i + 1}`, summary, stdout: "bun test v1.4.3", stderr,
      timings: JSON.stringify({ version: 1, files: Object.fromEntries(target.map(file => [file, 1])) }),
      completion: { version: 1, runId: summary.runId, endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"],
        segments: { prepareMs: 1, executionMs: 10, logDrainMs: 0, reportMs: 2, totalMs: 13 } } };
  });
  const verify = { version: 2, success: true, failure: null, fullSuite: false, testShard: { index: 1, total: 2 }, workflowRun, scratch: "/scratch",
    stages: verificationCommands(mode, "/scratch", { index: 1, total: 2 }, planned ? plan.path : undefined).map(command => ({ command: ["bun", ...command], exitCode: 0, error: null, elapsedMs: 1 })),
    profiles: [{ runId: "run-1", summaryVersion: planned ? 6 : 5, testResult: "success", completionStatus: "available" }] };
  return { files: [...files], shards, verify, ...(planned ? { plan } : {}), jobResults: { shard1: "success", shard2: "success", package: "success" },
    expected: { revision, runId: "42", attempt: "2", repository: "owner/repo", patchDigest, toolDigest,
      dependencyDigest: "d".repeat(64), launcherDependencyDigest: "e".repeat(64), platform: "win32", workers: 2, mode, isolation: "default" } };
}

test("shard options reject ambiguous scope and preserve default full runs and workers 1/2", () => {
  expect(parseTestShard("1/2")).toEqual({ index: 1, total: 2 });
  expect(profileOptions([]).workers).toBe(2);
  for (const workers of [1, 2]) expect(profileOptions([`--parallel=${workers}`, "--shard=2/2"])).toMatchObject({ workers, shard: { index: 2, total: 2 } });
  expect(() => profileOptions(["--parallel=4", "--shard=2/2"])).toThrow();
  expect(profileOptions([]).shard).toBeUndefined();
  for (const value of ["0/2", "3/2", "1/1", "01/2", "1/02", "1.0/2", "1/2/3", "1/9007199254740992"]) expect(() => parseTestShard(value)).toThrow();
  for (const args of [["--shard=1/2", "--shard=2/2"], ["--shard=1/2", "./tests"], ["--shard=1/2", "--bail=1"], ["--shard=1/2", "--test-name-pattern=name"]]) expect(() => profileOptions(args)).toThrow();
  for (const key of ["CGW_TEST_TIMING_HISTORY", "CGW_TEST_TIMING_RESTORE", "CGW_TEST_TIMING_ARTIFACT_DIR", "CGW_TEST_TIMING_TOKEN"]) {
    expect(() => assertColdShardEnvironment({ [key]: "" })).toThrow("cold scheduling");
  }
  expect(() => assertColdShardEnvironment({ CGW_TEST_WORKERS: "2" })).not.toThrow();
});

test("weighted plans reserve verify time and keep assignments stable when files change", () => {
  const timings = { [files[0]!]: 80, [files[1]!]: 60, [files[2]!]: 40, [files[3]!]: 20 };
  const shards = balanceShardPlan(timings, 2, [20, 0]);
  // File work 80 + 40 worker-ms overhead balances file work 120.
  expect(shards.map(shard => Object.keys(shard.files))).toEqual([[files[1], files[3]], [files[0], files[2]]]);
  const plan = parseShardPlan({ version: 1, platform: "win32", bunVersion: "1.4.3", workers: 2,
    source: { runId: "41", revision, repository: "owner/repo" }, overheadMs: [20, 0], shards });
  const expanded = ["tests/0-new.test.ts", ...files, "tests/zz-new.test.ts"];
  const combined: string[] = [];
  for (const index of [1, 2]) {
    const original = plannedShardFiles(files, { index, total: 2 }, plan);
    const current = plannedShardFiles(expanded, { index, total: 2 }, plan);
    expect(current.filter(file => files.includes(file))).toEqual(original);
    expect(plannedShardFiles(expanded.filter(file => file !== files[0]), { index, total: 2 }, plan)).toEqual(current.filter(file => file !== files[0]));
    combined.push(...current);
  }
  expect(combined.sort()).toEqual([...expanded].sort());
  expect(new Set(combined).size).toBe(expanded.length);
  expect(() => plannedShardFiles(files, { index: 1, total: 3 }, plan)).toThrow("count");
  const duplicate = structuredClone(plan); duplicate.shards[1]!.files[files[1]!] = 1;
  expect(() => parseShardPlan(duplicate)).toThrow("Duplicate");
  const unsafe = structuredClone(plan); unsafe.shards[0]!.files["tests/../escape.test.ts"] = 1;
  expect(() => parseShardPlan(unsafe)).toThrow();
});

test("planned coverage is bound to the gate plan, exact commands and verify profile", () => {
  const fixture = gateFixture("timing", true);
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, fullSuite: true, plan: { digest: fixture.plan!.digest } });
  for (const change of [
    (input: ShardAggregationInput) => { input.plan!.digest = "2".repeat(64); },
    (input: ShardAggregationInput) => { input.shards[0]!.summary.shard.plan.path = "other.json"; },
    (input: ShardAggregationInput) => { input.shards[1]!.summary.command.push("./tests/unknown.test.ts"); },
    (input: ShardAggregationInput) => { input.shards[1]!.summary.command.pop(); },
    (input: ShardAggregationInput) => { input.shards[0]!.summary.command.push("--shard=1/2"); },
    (input: ShardAggregationInput) => { input.shards[0]!.summary.command.push("--timings", "/foreign.json"); },
    (input: ShardAggregationInput) => { input.shards[0]!.summary.scheduling.inputDigest = "2".repeat(64); },
    (input: ShardAggregationInput) => { input.verify.profiles[0].summaryVersion = 5; },
    (input: ShardAggregationInput) => { input.verify.stages.find((stage: any) => stage.command[2] === "test").command.pop(); },
    (input: ShardAggregationInput) => { input.shards[1]!.summary.version = 5; },
    (input: ShardAggregationInput) => { delete input.plan; },
  ]) {
    const altered = structuredClone(fixture); change(altered);
    expect(aggregateShardEvidence(altered).success).toBe(false);
  }
  for (const [name, change] of defects) {
    if (["restored history", "position-filtered command", "undeclared history command"].includes(name)) continue;
    const altered = structuredClone(fixture); change(altered);
    expect(aggregateShardEvidence(altered).success, name).toBe(false);
  }
});

test("planning reads successful Windows artifacts and pins the resulting plan bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-plan-artifacts-"));
  try {
    const fixture = gateFixture("timing"), artifacts = join(root, "artifacts");
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "fixture test source");
    }
    for (const [index, evidence] of fixture.shards.entries()) {
      const parent = join(artifacts, `shard-${index + 1}`), run = join(parent, "run");
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, "summary.json"), JSON.stringify(evidence.summary));
      writeFileSync(join(run, "file-timings.json"), evidence.timings!);
      writeFileSync(join(run, "stderr.log"), evidence.stderr!);
      if (index === 0) writeFileSync(join(parent, "verify-summary.json"), JSON.stringify(fixture.verify));
    }
    const plan = planTestShards(root, artifacts);
    expect(plan).toMatchObject({ source: { runId: "42", revision }, overheadMs: [11, 0] });
    expect(plan.shards.flatMap(shard => Object.keys(shard.files)).sort()).toEqual(files);
    const path = "plan.json"; writeFileSync(join(root, path), JSON.stringify(plan));
    const loaded = loadShardPlan(root, path);
    expect(loaded.plan).toEqual(plan);
    expect(loaded.digest).toBe(createHash("sha256").update(readFileSync(join(root, path))).digest("hex"));
    expect(() => loadShardPlan(root, "../outside.json")).toThrow("inside the checkout");
    fixture.shards[0]!.summary.testResult = "nonzero-exit";
    writeFileSync(join(artifacts, "shard-1/run/summary.json"), JSON.stringify(fixture.shards[0]!.summary));
    expect(() => planTestShards(root, artifacts)).toThrow("successful");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("aggregation options select full/timing and one explicit skip source", () => {
  const required = ["--artifacts=artifacts", "--job-results=jobs.json", "--output=gate.json"];
  expect(aggregateShardOptions(required).mode).toBe("full");
  expect(aggregateShardOptions(required)).toMatchObject({ platform: "win32", arch: "x64" });
  expect(aggregateShardOptions([...required, "--platform=darwin", "--arch=x64"])).toMatchObject({ platform: "darwin", arch: "x64" });
  expect(aggregateShardOptions([...required, "--mode=timing", "--skip-policy=.github/windows-test-skips.json"])).toMatchObject({
    mode: "timing", "skip-policy": join(process.cwd(), ".github/windows-test-skips.json"),
  });
  expect(aggregateShardOptions([...required, "--mode=full"]).mode).toBe("full");
  for (const extra of [["--mode=other"], ["--mode=timing", "--mode=timing"], ["--mode="],
    ["--platform=linux"], ["--arch=arm64"], ["--platform=darwin", "--platform=darwin"],
    ["--skip-evidence=old.json", "--skip-policy=new.json"], ["--skip-policy=a.json", "--skip-policy=b.json"]]) {
    expect(() => aggregateShardOptions([...required, ...extra])).toThrow();
  }
});

test("verify sends a valid shard only to server tests and keeps all other stages", () => {
  expect(verifyOptions(["--test-shard=1/2"])).toEqual({ testMode: "full", testShard: { index: 1, total: 2 } });
  const commands = verificationCommands("full", "/scratch", { index: 1, total: 2 });
  expect(commands.filter(command => command.includes("--shard=1/2"))).toEqual([["run", "test", "--mode=full", "--shard=1/2"]]);
  expect(commands.filter(command => command[1] !== "test")).toEqual(verificationCommands("full", "/scratch").filter(command => command[1] !== "test"));
  expect(() => verifyOptions(["--test-shard=1/2", "--test-shard=1/2"])).toThrow("Duplicate");
  expect(verifyOptions(["--test-shard=1/2", "--shard-plan=plan.json"])).toMatchObject({ shardPlan: "plan.json" });
  expect(verificationCommands("timing", "/scratch", { index: 1, total: 2 }, "plan.json").find(command => command[1] === "test"))
    .toEqual(["run", "test", "--mode=timing", "--shard=1/2", "--shard-plan=plan.json"]);
  expect(profileOptions(["--shard=2/2", "--shard-plan=plan.json"])).toMatchObject({ shardPlan: "plan.json" });
  for (const args of [["--shard-plan=plan.json"], ["--shard=1/2", "--shard-plan="], ["--shard=1/2", "--shard-plan=a", "--shard-plan=b"]]) {
    expect(() => profileOptions(args)).toThrow();
  }
  expect(() => verifyOptions(["--shard-plan=plan.json"])).toThrow();
});

test("a complete independent two-job result is the only report that claims full-suite coverage", () => {
  const fixture = gateFixture();
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, fullSuite: true, reasons: [], historyPublication: "forbidden" });
  expect(fixture.shards.every(shard => shard.summary.fullSuite === false)).toBe(true);
  // Collection may be incomplete while the independently checked file and wall evidence remain valid.
  fixture.shards[0]!.summary.collection = { status: "incomplete" };
  expect(aggregateShardEvidence(fixture).success).toBe(true);
});

test("Windows and Intel gates accept selected mixed attempts and bind verify to shard 1", () => {
  for (const platform of ["win32", "darwin"]) for (const attempts of [["2", "1"], ["1", "2"], ["1", "1"]]) {
    const fixture = gateFixture("timing");
    fixture.expected.platform = platform;
    fixture.selection = { version: 1, repository: "owner/repo", runId: "42", revision, runHeadRevision: "f".repeat(40), gateAttempt: "2",
      shards: attempts.map((attempt, i) => ({ index: i + 1, attempt, jobId: i + 10, artifactId: i + 20,
        artifactName: `test-performance-shard-${i + 1}-of-2-attempt-${attempt}` })) };
    for (const [i, shard] of fixture.shards.entries()) {
      shard.summary.platform = platform;
      shard.summary.workflowRun = { ...shard.summary.workflowRun, attempt: attempts[i] };
    }
    fixture.verify.workflowRun = { ...fixture.verify.workflowRun, attempt: attempts[0] };
    expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, reasons: [], selection: fixture.selection });
    const altered = structuredClone(fixture);
    altered.verify.workflowRun.attempt = attempts[0] === "1" ? "2" : "1";
    expect(aggregateShardEvidence(altered).reasons).toContain("invalid-or-missing-verify-summary");
    for (const change of [
      (input: ShardAggregationInput) => { input.shards[1]!.summary.workflowRun.attempt = "3"; },
      (input: ShardAggregationInput) => { input.shards[1]!.summary.workflowRun.id = "41"; },
      (input: ShardAggregationInput) => { input.selection!.shards[0]!.attempt = "3"; },
      (input: ShardAggregationInput) => { input.selection!.runId = "41"; },
      (input: ShardAggregationInput) => { input.selection!.revision = "f".repeat(40); },
      (input: ShardAggregationInput) => { input.shards[1]!.summary.revision = "f".repeat(40); },
      (input: ShardAggregationInput) => { input.selection!.runHeadRevision = "invalid"; },
      (input: ShardAggregationInput) => { input.selection!.gateAttempt = "1"; },
      (input: ShardAggregationInput) => { input.selection!.shards.pop(); },
      (input: ShardAggregationInput) => { input.jobResults.shard2 = "failure"; },
    ]) {
      const invalid = structuredClone(fixture); change(invalid);
      expect(aggregateShardEvidence(invalid).success).toBe(false);
    }
  }
});

test("Intel aggregation accepts macOS evidence and rejects Windows or ARM substitution", () => {
  const fixture = gateFixture("timing");
  fixture.expected = { ...fixture.expected, platform: "darwin", arch: "x64" };
  for (const shard of fixture.shards) {
    shard.summary.platform = "darwin";
    shard.summary.cwd = "/Users/runner/work/repo";
    shard.summary.executable.path = "/Users/runner/.bun/bin/bun";
    shard.summary.command[0] = shard.summary.executable.path;
    shard.summary.command[5] = `${shard.directory}/file-timings.json`;
  }
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, fullSuite: true, reasons: [] });
  for (const [key, value] of [["platform", "win32"], ["arch", "arm64"]]) {
    const altered = structuredClone(fixture);
    for (const shard of altered.shards) shard.summary[key!] = value;
    expect(aggregateShardEvidence(altered).reasons).toContain(`shard-1:unexpected-${key}`);
  }
});

test("two timing shards require a timing request and commands without the full preload", () => {
  const fixture = gateFixture("timing");
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, fullSuite: true, reasons: [] });
  fixture.expected.mode = "full";
  expect(aggregateShardEvidence(fixture).reasons).toContain("shard-1:unexpected-mode");
  fixture.expected.mode = "timing";
  fixture.shards[0]!.summary.command.splice(4, 0, "--preload", "C:\\checkout\\scripts\\test-performance-preload.ts");
  expect(aggregateShardEvidence(fixture).reasons).toContain("shard-1:invalid-command-scope");
});

test("the gate accepts supported workers 1/2 and rejects worker 4", () => {
  for (const workers of [1, 2, 4]) {
    const fixture = gateFixture();
    for (const shard of fixture.shards) {
      shard.summary.workers = workers;
      shard.summary.command = shard.summary.command.filter((argument: string) => !argument.startsWith("--parallel="));
      if (workers > 1) shard.summary.command.splice(-2, 0, `--parallel=${workers}`);
    }
    fixture.expected.workers = workers as 1 | 2;
    expect(aggregateShardEvidence(fixture).success).toBe(workers !== 4);
  }
});

const defects: [string, (input: ShardAggregationInput) => void][] = [
  ["one missing file with equal count", input => { input.shards[0]!.summary.fileTiming.executedFiles = [files[0], files[0]]; }],
  ["duplicate timing key", input => { input.shards[0]!.timings = `{"version":1,"files":{"${files[0]}":1,"${files[0]}":1}}`; }],
  ["cross-source patch", input => { input.shards[1]!.summary.patchDigest = "f".repeat(64); }],
  ["matching patches from another checkout", input => { for (const shard of input.shards) shard.summary.patchDigest = "f".repeat(64); }],
  ["cross-source revision", input => { input.shards[1]!.summary.revision = "f".repeat(40); }],
  ["matching tools from another checkout", input => { for (const shard of input.shards) shard.summary.toolDigest = "f".repeat(64); }],
  ["matching dependencies from another checkout", input => { for (const shard of input.shards) shard.summary.dependencyDigest = "f".repeat(64); }],
  ["different tool contents", input => { input.shards[1]!.summary.toolDigest = "f".repeat(64); }],
  ["different dependencies", input => { input.shards[1]!.summary.dependencyDigest = "f".repeat(64); }],
  ["missing dependency digest", input => { input.shards[1]!.summary.launcherDependencyDigest = null; }],
  ["different runtime", input => { input.shards[1]!.summary.executable.sha256 = "a".repeat(64); }],
  ["different workflow revision", input => { input.shards[1]!.summary.workflowRevision = "f".repeat(40); }],
  ["illegal worker count", input => { input.shards[1]!.summary.workers = 3; }],
  ["incorrect requested worker", input => { for (const shard of input.shards) shard.summary.workers = 1; }],
  ["unknown source", input => { input.shards[1]!.summary.known = false; }],
  ["cross-attempt", input => { input.shards[1]!.summary.workflowRun = { ...input.shards[1]!.summary.workflowRun, attempt: "1" }; }],
  ["cross-run", input => { input.shards[1]!.summary.workflowRun = { ...input.shards[1]!.summary.workflowRun, id: "41" }; }],
  ["missing shard", input => { input.shards.pop(); }],
  ["duplicate shard", input => { input.shards[1] = structuredClone(input.shards[0]!); }],
  ["failed shard", input => { input.jobResults.shard1 = "failure"; }],
  ["cancelled shard", input => { input.jobResults.shard2 = "cancelled"; }],
  ["skipped shard", input => { input.jobResults.shard2 = "skipped"; }],
  ["missing package", input => { delete input.jobResults.package; }],
  ["failed package", input => { input.jobResults.package = "failure"; }],
  ["unknown executed path", input => { input.shards[0]!.stderr = input.shards[0]!.stderr!.replace(files[0]!, "tests/unknown.test.ts"); }],
  ["unknown timing path", input => { input.shards[0]!.timings = JSON.stringify({ version: 1, files: { "tests/unknown.test.ts": 1, [files[2]!]: 2 } }); }],
  ["missing timings", input => { input.shards[0]!.timings = null; }],
  ["missing stdout", input => { input.shards[0]!.stdout = null; }],
  ["missing stderr", input => { input.shards[0]!.stderr = null; }],
  ["missing completion", input => { input.shards[0]!.completion = null; }],
  ["wrong completion identity", input => { input.shards[0]!.completion.runId = "other-run"; }],
  ["missing verify", input => { input.verify = null; }],
  ["missing non-server stage", input => { input.verify.stages.splice(2, 1); }],
  ["failed non-server stage", input => { input.verify.stages[2].exitCode = 1; }],
  ["wrong verify test run", input => { input.verify.profiles[0].runId = "another-run"; }],
  ["legacy full summary", input => { input.shards[0]!.summary.version = 4; }],
  ["old full timing semantics", input => { input.shards[0]!.summary.fileTiming.version = 2; }],
  ["full-suite shard claim", input => { input.shards[0]!.summary.fileTiming.fullSuite = true; }],
  ["restored history", input => { input.shards[0]!.summary.scheduling.source = "restored"; }],
  ["undeclared history command", input => { input.shards[0]!.summary.command.splice(8, 0, "--timings", "C:/reports/history.json"); }],
  ["position-filtered command", input => { input.shards[0]!.summary.command[input.shards[0]!.summary.command.length - 1] = "tests/a.test.ts"; }],
  ["history publication", input => { input.shards[0]!.summary.historyPublication.status = "succeeded"; }],
  ["signal", input => { input.shards[0]!.summary.signal = "SIGTERM"; }],
  ["test failure", input => { input.shards[0]!.summary.exitCode = 1; }],
  ["empty shard", input => { input.files = []; }],
  ["invalid evidence location", input => { input.shards[0]!.summary.evidence.stderr = "elsewhere.log"; }],
  ["missing runtime digest", input => { input.shards[0]!.summary.executable.sha256 = null; }],
  ["changed current test set", input => { input.files.push("tests/new.test.ts"); }],
  ["empty shard subset", input => { input.shards[1]!.summary.shard.expectedFiles = []; }],
  ["incomplete persisted file evidence", input => { input.shards[1]!.summary.fileTiming.outputWriteError = "unavailable"; }],
];
for (const [name, change] of defects) test(`the independent gate rejects ${name}`, () => {
  const fixture = gateFixture(); change(fixture);
  expect(aggregateShardEvidence(fixture).success).toBe(false);
});

function skippedFixture() {
  const fixture = gateFixture(), evidence = fixture.shards[0]!;
  evidence.stderr = evidence.stderr!.replace("(pass) a case [1ms]", "(skip) a case").replace(" 2 pass", " 1 pass\n 1 skip");
  evidence.summary.counts = { pass: 1, skip: 1, fail: 0 };
  evidence.summary.skipIdentities = [`${files[0]}::a case`];
  fixture.skipEvidence = { version: 1, source: { revision, patchDigest, toolDigest }, entries: [{ file: files[0], name: "a case", reason: "Requires another platform" }] };
  return fixture;
}
test("reviewed skips are exact, reasoned and bound to source", () => {
  expect(aggregateShardEvidence(skippedFixture()).success).toBe(true);
  for (const change of [
    (input: ShardAggregationInput) => { delete input.skipEvidence; },
    (input: ShardAggregationInput) => { input.skipEvidence.source.revision = "f".repeat(40); },
    (input: ShardAggregationInput) => { input.skipEvidence.source.patchDigest = "f".repeat(64); },
    (input: ShardAggregationInput) => { input.skipEvidence.source.toolDigest = "f".repeat(64); },
    (input: ShardAggregationInput) => { input.skipEvidence.entries[0].reason = " "; },
    (input: ShardAggregationInput) => { input.skipEvidence.entries.push(input.skipEvidence.entries[0]); },
    (input: ShardAggregationInput) => { input.skipEvidence.entries = []; },
    (input: ShardAggregationInput) => { input.skipEvidence.entries[0].file = "tests/unknown.test.ts"; },
  ]) { const fixture = skippedFixture(); change(fixture); expect(aggregateShardEvidence(fixture).success).toBe(false); }
});

function skipPolicyFixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-skip-policy-"));
  const path = join(root, "policy.json"), file = files[0]!;
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, file), "reviewed test source\n");
  const policy = { version: 1, reviewedSource: { revision, patchDigest, toolDigest },
    entries: [{ file, name: "a case", reason: "Requires another platform" }] };
  writeFileSync(path, JSON.stringify(policy));
  return { root, path, policy };
}

test("persistent skip policy preserves explicit skips across source changes and gate revisions", () => {
  const { root, path } = skipPolicyFixture();
  try {
    writeFileSync(join(root, files[0]!), "changed test source\n");
    for (const currentRevision of [revision, "f".repeat(40)]) {
      const fixture = skippedFixture();
      fixture.expected.revision = currentRevision;
      for (const shard of fixture.shards) { shard.summary.revision = currentRevision; shard.summary.workflowRevision = currentRevision; }
      fixture.skipEvidence = loadSkipPolicy(root, path, files, { revision: currentRevision, patchDigest, toolDigest });
      expect(fixture.skipEvidence.source.revision).toBe(currentRevision);
      expect(fixture.skipEvidence.policy.reviewedSource.revision).toBe(revision);
      expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, reasons: [] });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const policyDefects: [string, (fixture: ReturnType<typeof skipPolicyFixture>) => void][] = [
  ["unknown version", fixture => { fixture.policy.version = 2; }],
  ["blank reason", fixture => { fixture.policy.entries[0]!.reason = " "; }],
  ["blank test name", fixture => { fixture.policy.entries[0]!.name = " "; }],
  ["duplicate identity", fixture => { fixture.policy.entries.push(fixture.policy.entries[0]!); }],
  ["unknown test file", fixture => { fixture.policy.entries[0]!.file = "tests/unknown.test.ts"; }],
];
for (const [name, change] of policyDefects) test(`persistent skip policy rejects ${name}`, () => {
  const fixture = skipPolicyFixture();
  try {
    change(fixture);
    writeFileSync(fixture.path, JSON.stringify(fixture.policy));
    expect(() => loadSkipPolicy(fixture.root, fixture.path, files, { revision, patchDigest, toolDigest })).toThrow();
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const policy of ["windows-test-skips.json", "macos-intel-test-skips.json"]) test(`the repository ${policy} loads current reviewed test sources`, () => {
  const root = join(import.meta.dir, "..");
  const evidence = loadSkipPolicy(root, join(root, ".github", policy), repositoryTestFiles(root), { revision, patchDigest, toolDigest });
  expect(evidence.entries.length).toBeGreaterThan(0);
  expect(evidence.source).toEqual({ revision, patchDigest, toolDigest });
  expect(evidence.policy.path).toBe(`.github/${policy}`);
});

for (const heading of ["ordinary", "GitHub Actions"] as const) test(`reviewed shard skips accept the final repeated skip footer with ${heading} file headings`, () => {
  const fixture = skippedFixture(), shard = fixture.shards[0]!;
  if (heading === "GitHub Actions") shard.stderr = shard.stderr!.replace(/^(tests\/.+\.test\.ts:)$/gm, "::group::$1");
  shard.stderr += "\n1 test skipped:\n(skip) a case\n";
  expect(testLogResult(shard.stderr!).skipIdentities).toEqual([`${files[0]}::a case`]);
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, reasons: [] });
});

test("a repeated skip in the test body is rejected even when a final footer repeats it again", () => {
  const fixture = skippedFixture(), shard = fixture.shards[0]!;
  shard.stderr = shard.stderr!.replace("(skip) a case", "(skip) a case\n(skip) a case") + "\n1 test skipped:\n(skip) a case\n";
  expect(testLogResult(shard.stderr).skipIdentities).toEqual([`${files[0]}::a case`, `${files[0]}::a case`]);
  expect(aggregateShardEvidence(fixture).success).toBe(false);
});

const completionDefects: [string, (shard: ShardAggregationInput["shards"][number]) => void][] = [
  ["missing exclusions", shard => { delete shard.completion.excludes; }],
  ["incorrect exclusions", shard => { shard.completion.excludes = ["process-shutdown", "completion-write"]; }],
  ["missing summary segment", shard => { delete shard.summary.segments.prepareMs; }],
  ["negative summary segment", shard => { shard.summary.segments.logDrainMs = -1; }],
  ["nonfinite summary segment", shard => { shard.summary.segments.reportMs = Infinity; }],
  ["summary execution differs from wall", shard => { shard.summary.segments.executionMs = 9; }],
  ["summary total below segment sum", shard => { shard.summary.segments.totalMs = 11.5; }],
  ["changed completion preparation", shard => { shard.completion.segments.prepareMs = 2; shard.completion.segments.totalMs = 14; }],
  ["changed completion execution", shard => { shard.completion.segments.executionMs = 9; }],
  ["changed completion drain", shard => { shard.completion.segments.logDrainMs = 1; shard.completion.segments.totalMs = 14; }],
  ["completion report moves backwards", shard => { shard.completion.segments.reportMs = 0; }],
  ["completion total moves backwards", shard => { shard.completion.segments.totalMs = 11.5; }],
  ["completion total below segment sum", shard => { shard.completion.segments.totalMs = 12.5; }],
];
for (const [name, change] of completionDefects) test(`shard timing evidence rejects ${name}`, () => {
  const fixture = gateFixture();
  change(fixture.shards[0]!);
  expect(aggregateShardEvidence(fixture).success).toBe(false);
});

test("shard timing evidence keeps the existing 0.001 ms tolerance for wall and segment sums", () => {
  const fixture = gateFixture(), shard = fixture.shards[0]!;
  shard.summary.wallMs += 0.0005;
  shard.summary.segments.totalMs -= 0.0005;
  shard.completion.segments.totalMs -= 0.0005;
  expect(aggregateShardEvidence(fixture)).toMatchObject({ success: true, reasons: [] });
});

test("Linux aggregation checks Windows verify paths and independent requested configuration", () => {
  const fixture = gateFixture();
  fixture.verify.scratch = "C:\\runner\\verify";
  fixture.verify.stages = verificationCommands("full", "C:/runner/verify", { index: 1, total: 2 }).map(command => ({
    command: ["C:\\bun\\bun.exe", ...command.map(argument => argument.replaceAll("/", "\\"))], exitCode: 0, error: null, elapsedMs: 1,
  }));
  // The slash in i/n is a CLI value, not a Windows path separator.
  const serverStage = fixture.verify.stages.find((stage: { command: string[] }) => stage.command[2] === "test")!;
  serverStage.command = ["C:\\bun\\bun.exe", "run", "test", "--mode=full", "--shard=1/2"];
  fixture.expected = { ...fixture.expected, platform: "win32", workers: 2, mode: "full", isolation: "default" };
  expect(aggregateShardEvidence(fixture).success).toBe(true);
  for (const [key, value] of [["platform", "linux"], ["workers", 4], ["mode", "timing"], ["isolation", "isolate"]]) {
    const altered = structuredClone(fixture);
    for (const shard of altered.shards) shard.summary[key as string] = value;
    expect(aggregateShardEvidence(altered).success).toBe(false);
  }
});

test("Bun 1.4.3 runs both cold shards with exactly the dynamically discovered files and timings", () => {
  expect(Bun.version).toBe("1.4.3");
  const root = mkdtempSync(join(tmpdir(), "cgw-native-shards-"));
  try {
    mkdirSync(join(root, "tests/nested"), { recursive: true });
    // These literal subsets are independent expectations for native Bun's documented cold rule.
    const discovered = ["tests/A.test.ts", "tests/a.spec.ts", "tests/nested/b_test.ts", "tests/nested/c.test.js", "tests/z.test.ts", "tests/\u{10000}.test.ts", "tests/\ue000.test.ts"];
    for (const file of discovered) writeFileSync(join(root, file), 'import {test,expect} from "bun:test"; test("native coverage",()=>expect(1+1).toBe(2));');
    expect(repositoryTestFiles(root)).toEqual(discovered);
    const expected = [[discovered[0], discovered[2], discovered[4], discovered[5]], [discovered[1], discovered[3], discovered[6]]];
    const all: string[] = [];
    for (const index of [1, 2]) {
      const run = join(root, `shard-${index}`); mkdirSync(run);
      const child = spawnSync(process.execPath, ["test", "--parallel=2", `--shard=${index}/2`, "--timings", join(run, "file-timings.json"), "--update-timings", "./tests"],
        { cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, NO_COLOR: "1" } });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
      const logs = testLogResult(child.stderr);
      expect(logs.executedFiles).toEqual(expected[index - 1]);
      expect(coldShardFiles(repositoryTestFiles(root), { index, total: 2 })).toEqual(expected[index - 1] as string[]);
      const result = finalizeFileTimings({ root, runDirectory: run, expectedFiles: expected[index - 1] as string[], compatibility: timingCompatibility({ workers: 2, mode: "timing", isolation: "default" }),
        metadata: timingMetadata(root, revision, patchDigest, {}), stderr: child.stderr, exitCode: child.status!, signal: null, spawnError: null,
        fullSuiteRequested: true, logsComplete: true, sourceStable: true, shard: true });
      expect(result.fileTiming).toMatchObject({ version: 3, complete: true, fullSuite: false, reasons: [] });
      all.push(...result.fileTiming.executedFiles);
      const timings = JSON.parse(readFileSync(join(run, "file-timings.json"), "utf8"));
      expect(Object.keys(timings.files).sort()).toEqual(expected[index - 1]);
    }
    expect(all.sort()).toEqual(discovered);
    expect(new Set(all).size).toBe(discovered.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("artifact discovery preserves two directories and exposes missing evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-shard-artifacts-"));
  try {
    for (const directory of ["first/run", "second/run"]) {
      mkdirSync(join(root, directory), { recursive: true }); writeFileSync(join(root, directory, "summary.json"), "{\"version\":5}");
    }
    const loaded = loadShardArtifacts(root);
    expect(loaded.shards).toHaveLength(2);
    expect(loaded.shards.every(shard => shard.completion === null && shard.timings === null && shard.stderr === null)).toBe(true);
    expect(loaded.verify).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an existing full-run reader rejects a v5 shard instead of interpreting it as a full run", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-shard-legacy-reader-"));
  try {
    mkdirSync(join(root, "run"));
    const summary = gateFixture().shards[0]!.summary;
    writeFileSync(join(root, "run/summary.json"), JSON.stringify(summary));
    expect(() => readPerformanceSummary(root, 2, 0, summary)).toThrow("unsupported-summary-version");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the aggregation CLI saves a failed gate when artifacts are absent or worker input is invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-shard-cli-"));
  try {
    const jobs = join(root, "jobs.json"), output = join(root, "gate.json");
    const checkout = join(import.meta.dir, "..");
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).stdout.trim();
    writeFileSync(jobs, JSON.stringify({ shard1: "success", shard2: "success", package: "success" }));
    for (const workers of ["2", "4"]) {
      const child = spawnSync(process.execPath, [join(import.meta.dir, "../scripts/aggregate-test-shards.ts"), `--artifacts=${join(root, "absent")}`, `--job-results=${jobs}`, `--output=${output}`],
        { encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_WORKERS: workers, GITHUB_SHA: sha,
          GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2", GITHUB_REPOSITORY: "owner/repo" } });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result).toMatchObject({ kind: "test-shard-aggregate", success: false, fullSuite: false });
      expect(result.reasons.length).toBeGreaterThan(0);
      if (workers === "2") expect(result.reasons).toContain("missing-or-extra-shards");
      else expect(result.reasons.join(" ")).toContain("requires CGW_TEST_WORKERS=1|2");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
