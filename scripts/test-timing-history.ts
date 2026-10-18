import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HistoryFetch } from "./test-timing-history-rest";

export const HISTORY_MAX_BYTES = 1_048_576;
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const HISTORY_WORKFLOWS = [".github/workflows/release.yml", ".github/workflows/windows-performance.yml"] as const;
export type TimingCompatibility = {
  platform: string; arch: string; bunVersion: string; runnerClass: string;
  workers: 1 | 2; isolation: "default" | "isolate" | "shared"; mode: "full" | "timing"; timingVersion: 1;
};
export type TimingData = { version: 1; files: Record<string, number> };
export type TimingMetadata = {
  revision: string | null; patchDigest: string | null; repository: string | null; runId: string | null; workflow: string | null;
  runnerImage: string | null; runnerImageVersion: string | null;
  dependencyDigests: { root: string | null; launcher: string | null }; createdAt: string;
};
export type TimingHistory = {
  version: 1; compatibility: TimingCompatibility; source: TimingMetadata;
  execution: { complete: true; result: "success"; fullSuite: true; files: string[] };
  timings: TimingData;
};
export type TimingScheduling = {
  source: "cold" | "restored"; reason: string; lookupMs: number; inputDigest: string | null;
  from: { kind: "local" | "artifact"; runId: string | null; artifactId: number | null; revision: string | null; workflow: string | null } | null;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const nullableText = (value: unknown) => value === null || typeof value === "string" && value.length <= 300;
const sameFiles = (a: string[], b: string[]) => {
  const sorted = [...b].sort();
  return a.length === b.length && [...a].sort().every((file, index) => file === sorted[index]);
};
const testName = (name: string) => /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(name);
function validPath(path: string): boolean {
  return path.startsWith("tests/") && path.length < 500 && !/[\\\x00-\x1f:]/.test(path)
    && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..")
    && testName(path.split("/").at(-1)!);
}
function fail(reason: string): never { throw new Error(reason); }

export function timingCompatibility(options: Pick<TimingCompatibility, "workers" | "mode" | "isolation">, env = process.env): TimingCompatibility {
  return { platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    runnerClass: env.CGW_TEST_RUNNER_CLASS || "local", workers: options.workers, isolation: options.isolation, mode: options.mode, timingVersion: 1 };
}
export function timingHistoryFilename(compatibility: TimingCompatibility) {
  return `history-${createHash("sha256").update(JSON.stringify(compatibility)).digest("hex")}.json`;
}
export function timingMetadata(root: string, revision: string | null, patchDigest: string | null, env = process.env): TimingMetadata {
  const digest = (file: string) => {
    try { return createHash("sha256").update(readFileSync(join(root, file))).digest("hex"); } catch { return null; }
  };
  const workflow = env.GITHUB_WORKFLOW_REF?.split("/.github/workflows/")[1]?.split("@")[0];
  return { revision, patchDigest, repository: env.GITHUB_REPOSITORY ?? null, runId: env.GITHUB_RUN_ID ?? null,
    workflow: workflow ? `.github/workflows/${workflow}` : null,
    runnerImage: env.ImageOS ?? null, runnerImageVersion: env.ImageVersion ?? null,
    dependencyDigests: { root: digest("bun.lock"), launcher: digest("launcher/bun.lock") }, createdAt: new Date().toISOString() };
}

/** Only repository test paths and finite, nonnegative measurements can reach Bun. */
export function parseTimingData(value: unknown): TimingData {
  if (!record(value) || value.version !== 1 || !record(value.files)
    || Object.keys(value).some(key => key !== "version" && key !== "files")) fail("invalid-timing-schema");
  const entries = Object.entries(value.files);
  if (entries.length > 10_000) fail("too-many-timing-files");
  const files: Record<string, number> = Object.create(null);
  for (const [file, duration] of entries) {
    if (!validPath(file) || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > Number.MAX_SAFE_INTEGER) fail("invalid-timing-entry");
    files[file] = duration;
  }
  return { version: 1, files };
}
export function parseTimingHistory(bytes: Uint8Array | string, compatibility: TimingCompatibility, now = Date.now()): TimingHistory {
  if (typeof bytes === "string" ? Buffer.byteLength(bytes) > HISTORY_MAX_BYTES : bytes.byteLength > HISTORY_MAX_BYTES) fail("history-too-large");
  let value: unknown;
  try { value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("invalid-history-json"); }
  if (!record(value) || value.version !== 1 || !record(value.compatibility) || !record(value.source) || !record(value.execution)) fail("invalid-history-schema");
  const actual = value.compatibility;
  if (Object.keys(actual).length !== Object.keys(compatibility).length
    || Object.entries(compatibility).some(([key, expected]) => actual[key] !== expected)) fail("incompatible-history");
  const source = value.source;
  if (!hash(source.revision, 40) || !hash(source.patchDigest, 64)
    || !nullableText(source.repository) || source.repository !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.repository))
    || !(source.runId === null || typeof source.runId === "string" && /^[1-9]\d{0,19}$/.test(source.runId))
    || !nullableText(source.workflow) || source.workflow !== null && !HISTORY_WORKFLOWS.some(workflow => workflow === source.workflow)
    || !nullableText(source.runnerImage) || !nullableText(source.runnerImageVersion) || !record(source.dependencyDigests)
    || !hash(source.dependencyDigests.root, 64) || !hash(source.dependencyDigests.launcher, 64)
    || typeof source.createdAt !== "string" || !Number.isFinite(Date.parse(source.createdAt))) fail("invalid-history-source");
  const age = now - Date.parse(source.createdAt);
  if (age > HISTORY_MAX_AGE_MS || age < -300_000) fail("expired-history");
  const execution = value.execution;
  const timings = parseTimingData(value.timings);
  if (execution.complete !== true || execution.result !== "success" || execution.fullSuite !== true
    || !Array.isArray(execution.files) || execution.files.length === 0 || execution.files.length > 10_000
    || !execution.files.every(file => typeof file === "string" && validPath(file))
    || new Set(execution.files).size !== execution.files.length || !sameFiles(execution.files, Object.keys(timings.files))) fail("incomplete-history");
  return { version: 1, compatibility, source: source as TimingMetadata, execution: execution as TimingHistory["execution"], timings };
}

export function repositoryTestFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && testName(entry.name) && validPath(path)) files.push(path);
    }
  };
  visit("tests");
  return files.sort();
}

export async function prepareTimingHistory(options: {
  root: string; runDirectory: string; compatibility: TimingCompatibility; files: string[];
  env?: NodeJS.ProcessEnv; fetch?: HistoryFetch; budgetMs?: number;
}): Promise<{ scheduling: TimingScheduling; input?: string }> {
  const started = process.hrtime.bigint(), env = options.env ?? process.env;
  const scheduling: TimingScheduling = { source: "cold", reason: "no-history-input", lookupMs: 0, inputDigest: null, from: null };
  try {
    let history: TimingHistory | undefined;
    if (env.CGW_TEST_TIMING_HISTORY) {
      const path = resolve(env.CGW_TEST_TIMING_HISTORY);
      if (statSync(path).size > HISTORY_MAX_BYTES) fail("history-too-large");
      history = parseTimingHistory(readFileSync(path), options.compatibility);
      scheduling.from = { kind: "local", runId: history.source.runId, artifactId: null, revision: history.source.revision, workflow: history.source.workflow };
    } else if (env.CGW_TEST_TIMING_RESTORE === "1") {
      const { restoreArtifactHistory } = await import("./test-timing-history-rest");
      const restored = await restoreArtifactHistory({ compatibility: options.compatibility, env, fetch: options.fetch, budgetMs: options.budgetMs });
      history = restored.history;
      scheduling.from = restored.from;
    }
    if (history) {
      const existing = new Set(options.files);
      const files = Object.fromEntries(Object.entries(history.timings.files).filter(([file]) => existing.has(file)));
      if (Object.keys(files).length === 0) fail("no-current-history-files");
      const input = join(options.runDirectory, "history-input.json");
      const serialized = JSON.stringify({ version: 1, files }) + "\n";
      writeFileSync(input, serialized, { flag: "wx", mode: 0o444 });
      chmodSync(input, 0o444);
      scheduling.source = "restored";
      scheduling.reason = "compatible-history";
      scheduling.inputDigest = createHash("sha256").update(serialized).digest("hex");
      return { scheduling, input };
    }
  } catch (error) {
    scheduling.reason = error instanceof Error && /^[a-z0-9:-]+$/.test(error.message) ? error.message : "history-unavailable";
    scheduling.from = null;
  } finally { scheduling.lookupMs = Number(process.hrtime.bigint() - started) / 1_000_000; }
  return { scheduling };
}

/** The file gate is independent of operation reports and their completeness. */
export function finalizeFileTimings(options: {
  root: string; runDirectory: string; compatibility: TimingCompatibility; metadata: TimingMetadata; expectedFiles: string[];
  stderr: string; exitCode: number; signal: string | null; spawnError: string | null; fullSuiteRequested: boolean;
  logsComplete: boolean; sourceStable: boolean; artifactDirectory?: string;
}) {
  const reasons: string[] = [];
  const stderr = options.stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  const known = new Set(options.expectedFiles);
  const executed = [...new Set(stderr.split("\n").filter(line => line.endsWith(":"))
    .map(line => line.slice(0, -1).replaceAll("\\", "/").replace(/^\.\//, "")).filter(file => known.has(file)))].sort();
  const fileCounts = [...stderr.matchAll(/(?:^|\n)Ran \d+ tests? across (\d+) files?\./g)];
  const reportedFiles = fileCounts.length ? Number(fileCounts.at(-1)![1]) : null;
  if (options.exitCode !== 0 || options.signal !== null || options.spawnError !== null) reasons.push("test-execution-unsuccessful");
  if (!options.fullSuiteRequested) reasons.push("partial-test-request");
  if (!options.logsComplete) reasons.push("incomplete-test-logs");
  if (!options.sourceStable) reasons.push("unknown-or-changed-source");
  if (executed.length === 0 || reportedFiles !== executed.length || !sameFiles(executed, options.expectedFiles)) reasons.push("incomplete-file-execution");
  let timings: TimingData = { version: 1, files: {} };
  try {
    const path = join(options.runDirectory, "file-timings.json");
    if (statSync(path).size > HISTORY_MAX_BYTES) fail("timings-too-large");
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (record(data) && record(data.files)) data.files = Object.fromEntries(Object.entries(data.files).map(([file, duration]) => [file.replaceAll("\\", "/"), duration]));
    const raw = parseTimingData(data);
    // Bun merges untouched historical entries into its output. Those are not measurements from this run.
    timings.files = Object.fromEntries(executed.filter(file => Object.hasOwn(raw.files, file)).map(file => [file, raw.files[file]!]));
    if (!sameFiles(Object.keys(timings.files), executed)) reasons.push("missing-file-measurements");
    writeFileSync(path, JSON.stringify(timings, null, 2) + "\n");
  } catch { reasons.push("invalid-or-missing-file-timings"); }
  let complete = reasons.length === 0;
  let published = false;
  if (complete) {
    const history: TimingHistory = { version: 1, compatibility: options.compatibility, source: options.metadata,
      execution: { complete: true, result: "success", fullSuite: true, files: executed }, timings };
    try {
      const serialized = JSON.stringify(history, null, 2) + "\n";
      parseTimingHistory(serialized, options.compatibility);
      writeFileSync(join(options.runDirectory, "history.json"), serialized);
      if (options.artifactDirectory) {
        mkdirSync(options.artifactDirectory, { recursive: true });
        const target = join(options.artifactDirectory, timingHistoryFilename(options.compatibility));
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, serialized);
        renameSync(temporary, target);
        published = true;
      }
    } catch { reasons.push("history-publication-failed"); complete = false; }
  }
  return { complete, fullSuite: options.fullSuiteRequested, measuredFiles: Object.keys(timings.files), executedFiles: executed,
    reportedFiles, reasons, published };
}
