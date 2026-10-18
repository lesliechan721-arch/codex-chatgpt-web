import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");
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
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "typecheck"]);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run(["run", "scripts/generate-third-party-notices.ts", join(scratch, "THIRD_PARTY_NOTICES.txt"), "--include-launcher"]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
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
        return [{ reportPath, mode: summary.mode ?? "full", collection: summary.collection ?? null,
          scheduling: summary.scheduling ?? null, segments: summary.segments ?? null, completion,
          completionStatus: completion ? "available" : "missing", testResult: summary.testResult ?? null }];
      } catch { return []; }
    });
    const report = { version: 1, startedAt, endedAt: new Date().toISOString(), success: failure === null, failure,
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
        `Test reports: ${report.profileStatus}`, ...profiles.map(profile => `Mode: ${profile.mode}; collection: ${profile.collection?.status ?? "unknown"}; scheduling: ${JSON.stringify(profile.scheduling)}; aggregation phases (ms): ${JSON.stringify(profile.segments)}; completion: ${JSON.stringify(profile.completion)}`), "", ""].join("\n"));
    }
  } catch (error) {
    console.warn(`[verify] Could not save summary; preserving verification result: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(scratch, { recursive: true, force: true });
}
