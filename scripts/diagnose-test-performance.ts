import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { profileEnvironment } from "./profile-tests";
import { performanceSource } from "./test-performance-source";

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
export function diagnosticOptions(args: string[]) {
  let suite = "continuity", repetitions = 3;
  let condition = "all", history = "cold", pattern = "";
  for (const arg of args) {
    if (arg.startsWith("--suite=")) suite = arg.slice(8);
    else if (arg.startsWith("--condition=")) condition = arg.slice(12);
    else if (arg.startsWith("--history=")) history = arg.slice(10);
    else if (arg.startsWith("--test-name-pattern=")) pattern = arg.slice(20);
    else if (arg.startsWith("--repetitions=")) {
      const value = arg.slice(14);
      if (!["1", "2", "3", "10"].includes(value)) throw new Error("--repetitions must be 1, 2, 3 or 10.");
      repetitions = Number(value);
    } else throw new Error(`Unsupported diagnostic option: ${arg}`);
  }
  if (!Object.hasOwn(suites, suite)) throw new Error(`--suite must be one of ${Object.keys(suites).join(", ")}.`);
  const conditions = condition === "all" ? diagnosticConditions : diagnosticConditions.filter(item => item.name === condition);
  if (!conditions.length) throw new Error("Unknown diagnostic condition.");
  if (history !== "cold" && history !== "restore") throw new Error("--history must be cold or restore.");
  if (history === "restore" && (suite !== "all" || pattern || condition === "all")) {
    throw new Error("History restoration requires the full suite, one condition and no test filter.");
  }
  if (repetitions === 10 && suite !== "cli" && suite !== "continuity-source") throw new Error("Ten repetitions are reserved for CLI and source regression suites.");
  if (pattern) new RegExp(pattern);
  return { suite, repetitions, files: suites[suite]!, conditions, history, pattern };
}

/** Timing credentials reach only the wrapper; profileTests removes them before spawning tests. */
export function diagnosticEnvironment(env: NodeJS.ProcessEnv, history: string, runOutput: string): NodeJS.ProcessEnv {
  return { ...profileEnvironment(env), CGW_TEST_PROFILE_DIR: runOutput,
    CGW_TEST_TIMING_ARTIFACT_DIR: env.CGW_TEST_TIMING_ARTIFACT_DIR,
    ...(history === "restore" ? { CGW_TEST_TIMING_RESTORE: "1", CGW_TEST_TIMING_TOKEN: env.CGW_TEST_TIMING_TOKEN } : {}),
    CGW_API_KEY_CLI_DIAGNOSTICS: "1", CGW_CONTINUITY_SOURCE_DIAGNOSTICS: "1" };
}

/** Diagnostic repetitions retain failures; no successful repetition replaces an earlier exit. */
export async function diagnoseTestPerformance(args: string[]) {
  const { suite, repetitions, files, conditions, history, pattern } = diagnosticOptions(args);
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output/test-performance"));
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "diagnostic-"));
  const source = performanceSource(root);
  const runs: unknown[] = [];
  let failed = false;
  const save = () => writeFileSync(join(directory, "diagnostic.json"), JSON.stringify({ version: 1, source,
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, executable: process.execPath,
    suite, files, repetitions, conditions, history, pattern, runs,
    limitations: ["The continuity pair is selected for diagnosis; the historical adjacent-file order is unknown.",
      "Requested workers are not proof that two workers executed. Inspect process ledgers in full mode; timing mode does not collect worker identities.",
      "No crash-only termination policy is enabled. Exit code 3 and log text are not trusted crash signals.",
      "History is cold unless explicitly requested. Check each summary for actual restoration and source identity.",
      "Failed runs are diagnostic samples, not performance evidence."],
  }, null, 2) + "\n");
  for (let round = 1; round <= repetitions; round++) {
    for (const condition of round % 2 ? conditions : [...conditions].reverse()) {
      const runOutput = join(directory, `round-${round}-${condition.name}`);
      mkdirSync(runOutput);
      const command = [process.execPath, join(root, "scripts/profile-tests.ts"), `--parallel=${condition.workers}`,
        `--mode=${condition.mode}`, `--isolation=${condition.isolation}`, ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...files];
      const start = process.hrtime.bigint();
      let exitCode: number | null = null, signal: string | null = null, error: string | null = null;
      try {
        const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
          env: diagnosticEnvironment(process.env, history, runOutput) });
        exitCode = await child.exited;
        signal = child.signalCode ?? null;
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      let summary: unknown = null;
      try {
        const dirs = readdirSync(runOutput, { withFileTypes: true }).filter(entry => entry.isDirectory());
        if (dirs.length === 1) summary = JSON.parse(readFileSync(join(runOutput, dirs[0]!.name, "summary.json"), "utf8"));
      } catch { /* The original status is retained even when collection fails. */ }
      failed ||= exitCode !== 0 || signal !== null || summary === null;
      runs.push({ round, condition, command, exitCode, signal, error, wrapperWallMs: Number(process.hrtime.bigint() - start) / 1_000_000, summary });
      save();
    }
  }
  console.info(`[test-performance] diagnostics=${directory}; failed=${failed}`);
  return failed ? 1 : 0;
}
if (import.meta.main) process.exitCode = await diagnoseTestPerformance(process.argv.slice(2));
