import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertColdShardEnvironment, parseTestShard, type TestShard } from "./test-shards";

const root = resolve(import.meta.dir, "..");
export function verifyOptions(args: string[]) {
  let testMode: "full" | "timing" = "full";
  let testShard: TestShard | undefined;
  for (const arg of args) {
    if (arg.startsWith("--test-shard=")) {
      if (testShard) throw new Error("Duplicate --test-shard option.");
      testShard = parseTestShard(arg.slice(13));
      continue;
    }
    if (!arg.startsWith("--test-mode=")) throw new Error(`Unsupported verify option: ${arg}`);
    const value = arg.slice(12);
    if (value !== "full" && value !== "timing") throw new Error("--test-mode must be full or timing.");
    testMode = value;
  }
  return { testMode, ...(testShard ? { testShard } : {}) };
}

export function verificationCommands(testMode: "full" | "timing", scratch: string, testShard?: TestShard) {
  return [
    ["run", "check-version"], ["run", "audit"], ["run", "launcher:audit"], ["run", "typecheck"],
    ["run", "launcher:typecheck"], ["run", "launcher:test"], ["run", "test", `--mode=${testMode}`, ...(testShard ? [`--shard=${testShard.index}/${testShard.total}`] : [])], ["run", "launcher:build"],
    ["run", "scripts/build-runtime-bundle.ts", join(scratch, "runtime")],
    ["run", "scripts/generate-third-party-notices.ts", join(scratch, "THIRD_PARTY_NOTICES.txt"), "--include-launcher"],
    ["run", "scripts/smoke-release.ts", join(scratch, "runtime")],
  ];
}

export async function verify(args: string[]) {
  const { testMode, testShard } = verifyOptions(args);
  if (testShard) {
    if (testShard.index !== 1) throw new Error("verify --test-shard is reserved for shard 1; run other shards with bun run test.");
    assertColdShardEnvironment(process.env);
  }
  const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output", "test-performance"));
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const stages: { command: string[]; elapsedMs: number; wrapperExitMs: number | null; exitCode: number | null; error: string | null }[] = [];
  let failure: string | null = null;

  async function run(args: string[]): Promise<void> {
    const start = process.hrtime.bigint();
    const stage = { command: [process.execPath, ...args], elapsedMs: 0, wrapperExitMs: null as number | null, exitCode: null as number | null, error: null as string | null };
    stages.push(stage);
    console.info(`[verify] start: bun ${args.join(" ")}`);
    try {
      const child = Bun.spawn(stage.command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      stage.exitCode = await child.exited;
      if (args[0] === "run" && args[1] === "test") stage.wrapperExitMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (stage.exitCode !== 0) throw new Error(`Verification command failed (${stage.exitCode}): bun ${args.join(" ")}`);
    } catch (error) {
      stage.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      stage.elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      console.info(`[verify] finish: bun ${args.join(" ")}; elapsed=${(stage.elapsedMs / 1000).toFixed(2)}s; exit=${stage.exitCode}`);
    }
  }

  // Only summaries created by this invocation belong to its verification result.
  const priorRuns = new Set<string>();
  try { for (const entry of readdirSync(output)) priorRuns.add(entry); } catch { /* First run. */ }
  try {
    for (const command of verificationCommands(testMode, scratch, testShard)) await run(command);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    process.exitCode = stages.at(-1)?.exitCode || 1;
    console.error(`[verify] ${failure}`);
  } finally {
    try {
      mkdirSync(output, { recursive: true });
      const profiles = readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory() && !priorRuns.has(entry.name)).flatMap(entry => {
        try {
          const reportPath = join(output, entry.name, "summary.json");
          const summary = JSON.parse(readFileSync(reportPath, "utf8"));
          let completion: unknown = null;
          try {
            const value = JSON.parse(readFileSync(join(output, entry.name, "completion.json"), "utf8"));
            if (value.version === 1 && value.runId === summary.runId) completion = value;
          } catch { /* A missing completion stays visible in the verification report. */ }
          return [{ reportPath, runId: summary.runId, shard: summary.shard ?? null, summaryVersion: summary.version, mode: summary.mode ?? "full", collection: summary.collection ?? null,
            counts: summary.counts ?? null, fileTiming: summary.fileTiming ?? null, historyPublication: summary.historyPublication ?? null,
            scheduling: summary.scheduling ?? null, segments: summary.segments ?? null, completion,
            completionStatus: completion ? "available" : "missing", testResult: summary.testResult ?? null }];
        } catch { return []; }
      });
      const report = { version: testShard ? 2 : 1, ...(testShard ? { fullSuite: false, testShard,
          serverScope: "shard-only; remaining server files run in another job", scratch, workflowRun: { id: process.env.GITHUB_RUN_ID ?? null,
            attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, repository: process.env.GITHUB_REPOSITORY ?? null } } : {}),
        startedAt, endedAt: new Date().toISOString(), success: failure === null, failure, testMode,
        totalMs: Number(process.hrtime.bigint() - start) / 1_000_000, stages, profiles,
        profileStatus: profiles.length ? "available" : "missing-or-tests-not-started" };
      const reportPath = join(output, "verify-summary.json");
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
      if (process.env.GITHUB_STEP_SUMMARY) {
        const artifact = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["## Verification", "", `Result: ${report.success ? "passed" : "failed"}`,
          `Report: \`${reportPath}\`${artifact ? ` — [run artifacts](${artifact})` : ""}`, "",
          "| Command | Seconds | Exit |", "| --- | ---: | ---: |",
          ...stages.map(stage => `| bun ${stage.command.slice(1).join(" ")} | ${(stage.elapsedMs / 1000).toFixed(2)} | ${stage.exitCode ?? "start failed"} |`), "",
          `Test reports: ${report.profileStatus}`, ...profiles.map(profile => `Mode: ${profile.mode}; collection: ${profile.collection?.status ?? "unknown"}; file timing: ${JSON.stringify(profile.fileTiming)}; history publication: ${JSON.stringify(profile.historyPublication)}; scheduling: ${JSON.stringify(profile.scheduling)}; aggregation phases (ms): ${JSON.stringify(profile.segments)}; completion: ${JSON.stringify(profile.completion)}`), "", ""].join("\n"));
      }
    } catch (error) {
      console.warn(`[verify] Could not save summary; preserving verification result: ${error instanceof Error ? error.message : String(error)}`);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await verify(process.argv.slice(2)); }
  catch (error) { console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
