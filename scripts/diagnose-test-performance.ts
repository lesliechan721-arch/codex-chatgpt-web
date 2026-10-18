import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { profileEnvironment } from "./profile-tests";
import { performanceSource } from "./test-performance-source";

const root = resolve(import.meta.dir, "..");
const suites: Record<string, string[]> = {
  continuity: ["./tests/continuity-task-update.test.ts", "./tests/session-continuity-compaction.test.ts"],
  cli: ["./tests/api-key-cli.test.ts"],
  all: ["./tests"],
};
export function diagnosticOptions(args: string[]) {
  let suite = "continuity", repetitions = 3;
  for (const arg of args) {
    if (arg.startsWith("--suite=")) suite = arg.slice(8);
    else if (arg.startsWith("--repetitions=")) {
      const value = arg.slice(14);
      if (!["1", "2", "3", "10"].includes(value)) throw new Error("--repetitions must be 1, 2, 3 or 10.");
      repetitions = Number(value);
    } else throw new Error(`Unsupported diagnostic option: ${arg}`);
  }
  if (!Object.hasOwn(suites, suite)) throw new Error("--suite must be continuity, cli or all.");
  if (repetitions === 10 && suite !== "cli") throw new Error("Ten repetitions are reserved for the CLI regression suite.");
  return { suite, repetitions, files: suites[suite]! };
}

/** Diagnostic repetitions retain failures; no successful repetition replaces an earlier exit. */
export async function diagnoseTestPerformance(args: string[]) {
  const { suite, repetitions, files } = diagnosticOptions(args);
  const output = resolve(process.env.CGW_TEST_PROFILE_DIR || join(root, "output/test-performance"));
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "diagnostic-"));
  const source = performanceSource(root);
  const conditions = [
    { name: "original-1", workers: 1, mode: "full", isolation: "default" },
    { name: "original-2", workers: 2, mode: "full", isolation: "default" },
    { name: "isolated-full-1", workers: 1, mode: "full", isolation: "isolate" },
    { name: "isolated-full-2", workers: 2, mode: "full", isolation: "isolate" },
    { name: "isolated-timing-1", workers: 1, mode: "timing", isolation: "isolate" },
    { name: "isolated-timing-2", workers: 2, mode: "timing", isolation: "isolate" },
  ];
  const runs: unknown[] = [];
  let failed = false;
  const save = () => writeFileSync(join(directory, "diagnostic.json"), JSON.stringify({ version: 1, source,
    platform: process.platform, arch: process.arch, bunVersion: Bun.version, executable: process.execPath,
    suite, files, repetitions, conditions, runs,
    limitations: ["The continuity pair is selected for diagnosis; the historical adjacent-file order is unknown.",
      "Requested workers are not proof that two workers executed. Inspect process ledgers in full mode; timing mode does not collect worker identities.",
      "No crash-only termination policy is enabled. Exit code 3 and log text are not trusted crash signals.",
      "All runs use cold timing inputs. Failed runs are diagnostic samples, not performance evidence."],
  }, null, 2) + "\n");
  for (let round = 1; round <= repetitions; round++) {
    for (const condition of round % 2 ? conditions : [...conditions].reverse()) {
      const runOutput = join(directory, `round-${round}-${condition.name}`);
      mkdirSync(runOutput);
      const command = [process.execPath, join(root, "scripts/profile-tests.ts"), `--parallel=${condition.workers}`,
        `--mode=${condition.mode}`, `--isolation=${condition.isolation}`, ...files];
      const start = process.hrtime.bigint();
      let exitCode: number | null = null, signal: string | null = null, error: string | null = null;
      try {
        const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit",
          env: { ...profileEnvironment(process.env), CGW_TEST_PROFILE_DIR: runOutput,
            CGW_TEST_TIMING_ARTIFACT_DIR: process.env.CGW_TEST_TIMING_ARTIFACT_DIR,
            CGW_API_KEY_CLI_DIAGNOSTICS: "1", CGW_CONTINUITY_SOURCE_DIAGNOSTICS: "1" } });
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
