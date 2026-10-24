import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { performanceSource } from "./test-performance-source";
import { parseTimingData, repositoryTestFiles } from "./test-timing-history";
import { coldShardFiles, testFileSetDigest, testLogResult } from "./test-shards";
import { verificationCommands } from "./verify";
import { validateShardSelection, type ShardSelection } from "./select-test-shard-artifacts";

export type ShardEvidence = {
  directory: string; summary: any; completion: any; timings: string | null; stdout: string | null; stderr: string | null;
};
export type ShardAggregationInput = {
  files: string[]; shards: ShardEvidence[]; verify: any; jobResults: Record<string, unknown>; skipEvidence?: any; selection?: ShardSelection;
  expected: { revision: string; runId: string; attempt: string; repository: string;
    patchDigest?: string; toolDigest?: string; dependencyDigest?: string; launcherDependencyDigest?: string;
    platform?: string; arch?: string; mode?: "full" | "timing"; isolation?: "default" | "isolate"; workers?: 1 | 2 };
};
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sameFiles = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length
  && a.every(file => typeof file === "string") && new Set(a).size === a.length && equal([...a].sort(), [...b].sort());
const hash = (value: unknown, length: number) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const duration = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const segmentKeys = ["prepareMs", "executionMs", "logDrainMs", "reportMs", "totalMs"] as const;
const validSegments = (segments: any) => segmentKeys.every(key => duration(segments?.[key]))
  && segments.totalMs + 0.001 >= segments.prepareMs + segments.executionMs + segments.logDrainMs + segments.reportMs;

function validShardCommand(summary: any): boolean {
  if (!Array.isArray(summary.command) || !summary.command.every((argument: unknown) => typeof argument === "string")
    || typeof summary.cwd !== "string" || typeof summary.executable?.path !== "string") return false;
  const command = summary.command.map((argument: string) => argument.replaceAll("\\", "/"));
  if (command.shift() !== summary.executable.path.replaceAll("\\", "/") || command.shift() !== "test"
    || command.shift() !== "--timeout" || command.shift() !== "30000") return false;
  if (summary.mode === "full" && (command.shift() !== "--preload"
    || command.shift() !== `${summary.cwd.replaceAll("\\", "/").replace(/\/$/, "")}/scripts/test-performance-preload.ts`)) return false;
  if (command.shift() !== "--timings" || !command.shift()?.endsWith("/file-timings.json") || command.shift() !== "--update-timings") return false;
  if (summary.workers > 1 && command.shift() !== `--parallel=${summary.workers}`) return false;
  if (command.shift() !== `--shard=${summary.shard.index}/${summary.shard.total}`) return false;
  if (summary.isolation === "isolate" && command.shift() !== "--isolate") return false;
  return equal(command, ["./tests"]) && summary.bail === null;
}

/** A separate multi-job gate. It never creates a single-process summary or timing history. */
export function aggregateShardEvidence(input: ShardAggregationInput) {
  const reasons: string[] = [];
  const require = (condition: unknown, reason: string) => { if (!condition) reasons.push(reason); };
  const files = [...input.files].sort();
  require(files.length > 0 && new Set(files).size === files.length, "invalid-repository-file-set");
  require(input.shards.length === 2, "missing-or-extra-shards");
  for (const job of ["shard1", "shard2", "package"]) require(input.jobResults[job] === "success", `job-not-success:${job}`);
  const expected = input.expected;
  require(hash(expected.revision, 40) && /^[1-9]\d*$/.test(expected.runId) && /^[1-9]\d*$/.test(expected.attempt)
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository), "missing-expected-workflow-identity");
  const attempts = new Map<number, string>();
  if (input.selection !== undefined) {
    try {
      validateShardSelection(input.selection, { repository: expected.repository, runId: expected.runId,
        revision: expected.revision, gateAttempt: expected.attempt });
      for (const shard of input.selection.shards) attempts.set(shard.index, shard.attempt);
    } catch { reasons.push("invalid-shard-artifact-selection"); }
  }
  const workflowRun = (index: number) => ({ id: expected.runId, attempt: attempts.get(index) ?? expected.attempt, repository: expected.repository });
  const indexes = new Set<number>(), runIds = new Set<string>(), executed: string[] = [], skipped: string[] = [];
  let common: unknown;
  let shardOne: any;
  for (const evidence of input.shards) {
    const summary = evidence.summary;
    const label = `shard-${summary?.shard?.index ?? "unknown"}`;
    if (summary?.version !== 5 || summary.fullSuite !== false || summary.shard?.total !== 2
      || ![1, 2].includes(summary.shard?.index)) { reasons.push(`${label}:invalid-shard-schema`); continue; }
    const index = summary.shard.index;
    require(!indexes.has(index), `${label}:duplicate-shard`); indexes.add(index);
    require(typeof summary.runId === "string" && summary.runId.length > 0 && !runIds.has(summary.runId), `${label}:duplicate-or-missing-run-id`);
    runIds.add(summary.runId);
    if (index === 1) shardOne = summary;
    const target = coldShardFiles(files, { index, total: 2 });
    require(target.length > 0, `${label}:empty-shard`);
    require(sameFiles(summary.shard.repositoryFiles, files) && summary.shard.repositoryFilesDigest === testFileSetDigest(files), `${label}:repository-file-set-mismatch`);
    require(sameFiles(summary.shard.expectedFiles, target), `${label}:expected-file-set-mismatch`);
    require(summary.known === true && hash(summary.revision, 40) && hash(summary.patchDigest, 64) && hash(summary.toolDigest, 64)
      && hash(summary.dependencyDigest, 64) && hash(summary.launcherDependencyDigest, 64), `${label}:unknown-source`);
    require(summary.revision === expected.revision && summary.workflowRevision === expected.revision, `${label}:source-revision-mismatch`);
    require(equal(summary.workflowRun, workflowRun(index)), `${label}:workflow-attempt-mismatch`);
    for (const key of ["patchDigest", "toolDigest", "dependencyDigest", "launcherDependencyDigest"] as const) {
      if (expected[key] !== undefined) require(summary[key] === expected[key], `${label}:${key}-mismatch`);
    }
    for (const key of ["platform", "arch", "mode", "isolation", "workers"] as const) {
      if (expected[key] !== undefined) require(summary[key] === expected[key], `${label}:unexpected-${key}`);
    }
    require([1, 2].includes(summary.workers) && ["default", "isolate"].includes(summary.isolation)
      && ["full", "timing"].includes(summary.mode) && summary.bunVersion === "1.4.3" && hash(summary.executable?.sha256, 64), `${label}:unsupported-execution-configuration`);
    const identity = { revision: summary.revision, patchDigest: summary.patchDigest, toolDigest: summary.toolDigest,
      workflowRevision: summary.workflowRevision, dependencyDigest: summary.dependencyDigest, launcherDependencyDigest: summary.launcherDependencyDigest,
      workflowRun: { id: summary.workflowRun?.id, repository: summary.workflowRun?.repository },
      platform: summary.platform, arch: summary.arch, bunVersion: summary.bunVersion,
      executableDigest: summary.executable?.sha256, workers: summary.workers, isolation: summary.isolation, mode: summary.mode };
    if (common === undefined) common = identity;
    else require(equal(common, identity), `${label}:different-source-or-execution-input`);
    require(summary.scheduling?.source === "cold" && summary.scheduling.reason === "shard-cold-only"
      && summary.scheduling.inputDigest === null && summary.scheduling.from === null, `${label}:non-cold-scheduling`);
    require(summary.historyPublication?.status === "not-requested" && summary.historyPublication.localPath === null
      && summary.historyPublication.artifactPath === null, `${label}:history-publication-forbidden`);
    require(summary.exitCode === 0 && summary.signal === null && summary.spawnError === null && summary.testResult === "success"
      && summary.wallValid === true && summary.counts?.fail === 0 && Number.isSafeInteger(summary.counts?.pass) && summary.counts.pass > 0,
    `${label}:test-execution-unsuccessful`);
    require(validShardCommand(summary), `${label}:invalid-command-scope`);
    const timing = summary.fileTiming;
    require(timing?.version === 3 && timing.complete === true && timing.fullSuite === false && timing.logsComplete === true
      && timing.sourceStable === true && timing.outputWriteError === null && equal(timing.reasons, [])
      && sameFiles(timing.targetFiles, target) && sameFiles(timing.executedFiles, target) && sameFiles(timing.measuredFiles, target)
      && timing.reportedFiles === target.length, `${label}:incomplete-file-evidence`);
    require(equal(summary.evidence, { summary: "summary.json", completion: "completion.json", stdout: "stdout.log", stderr: "stderr.log", timings: "file-timings.json" }), `${label}:missing-evidence-locations`);
    require(typeof evidence.stdout === "string" && typeof evidence.stderr === "string", `${label}:missing-logs`);
    if (typeof evidence.stderr === "string") {
      const logs = testLogResult(evidence.stderr);
      require(sameFiles(logs.executedFiles, target) && logs.reportedFiles === target.length && equal(logs.counts, summary.counts), `${label}:log-result-mismatch`);
      require(equal(logs.skipIdentities, summary.skipIdentities) && logs.skipIdentities.length === logs.counts.skip, `${label}:skip-identities-mismatch`);
      executed.push(...logs.executedFiles); skipped.push(...logs.skipIdentities);
    }
    try {
      if (evidence.timings === null) throw new Error();
      const keys = [...evidence.timings.matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(match => JSON.parse(match[1]!).replaceAll("\\", "/"));
      if (new Set(keys).size !== keys.length) throw new Error();
      const timings = parseTimingData(JSON.parse(evidence.timings));
      require(sameFiles(Object.keys(timings.files), target), `${label}:timing-file-set-mismatch`);
    } catch { reasons.push(`${label}:invalid-or-missing-timings`); }
    const segments = summary.segments;
    require(validSegments(segments) && duration(summary.wallMs) && Math.abs(segments.executionMs - summary.wallMs) <= 0.001,
      `${label}:invalid-summary-segments`);
    const completion = evidence.completion;
    require(completion?.version === 1 && completion.runId === summary.runId && completion.endPoint === "after-summary-and-status-output"
      && equal(completion.excludes, ["completion-write", "process-shutdown"]) && validSegments(completion.segments)
      && ["prepareMs", "executionMs", "logDrainMs"].every(key => completion.segments[key] === segments?.[key])
      && completion.segments.reportMs >= segments?.reportMs && completion.segments.totalMs >= segments?.totalMs,
    `${label}:invalid-or-missing-completion`);
  }
  require(indexes.size === 2, "missing-shard-index");
  require(sameFiles(executed, files), "incomplete-or-duplicate-suite-coverage");
  const skipEvidence = input.skipEvidence;
  if (skipped.length || skipEvidence !== undefined) {
    require(skipEvidence?.version === 1 && equal(skipEvidence.source, common && {
      revision: (common as any).revision, patchDigest: (common as any).patchDigest, toolDigest: (common as any).toolDigest }), "invalid-skip-evidence-source");
    const entries = skipEvidence?.entries;
    require(Array.isArray(entries) && entries.every(entry => files.includes(entry?.file) && typeof entry?.name === "string" && entry.name.length > 0
      && typeof entry?.reason === "string" && entry.reason.trim().length > 0)
      && sameFiles(entries.map(entry => `${entry.file}::${entry.name}`), skipped), "unreviewed-or-mismatched-skips");
  }
  const verify = input.verify;
  require(verify?.version === 2 && verify.success === true && verify.failure === null && verify.fullSuite === false
    && equal(verify.testShard, { index: 1, total: 2 }) && equal(verify.workflowRun, workflowRun(1)),
  "invalid-or-missing-verify-summary");
  if (verify?.version === 2 && typeof verify.scratch === "string" && Array.isArray(verify.stages)) {
    const commands = verificationCommands(shardOne?.mode, verify.scratch.replaceAll("\\", "/"), { index: 1, total: 2 })
      .map(command => command.map(argument => argument.replaceAll("\\", "/")));
    require(verify.stages.length === commands.length && verify.stages.every((stage: any, i: number) => stage?.exitCode === 0 && stage.error === null
      && duration(stage.elapsedMs) && Array.isArray(stage.command)
      && equal(stage.command.slice(1).map((argument: unknown) => typeof argument === "string" ? argument.replaceAll("\\", "/") : argument), commands[i])), "incomplete-non-server-verification");
    require(Array.isArray(verify.profiles) && verify.profiles.length === 1 && verify.profiles[0]?.runId === shardOne?.runId
      && verify.profiles[0]?.summaryVersion === 5 && verify.profiles[0]?.testResult === "success"
      && verify.profiles[0]?.completionStatus === "available", "verify-profile-binding-mismatch");
  } else reasons.push("missing-verify-stage-evidence");
  return { version: 1, kind: "test-shard-aggregate", success: reasons.length === 0, fullSuite: reasons.length === 0,
    source: common ?? null, repositoryFiles: files, repositoryFilesDigest: testFileSetDigest(files), executedFiles: [...executed].sort(),
    skipIdentities: [...skipped].sort(), skipEvidence: skipEvidence ?? null, jobResults: input.jobResults,
    selection: input.selection ?? null, reasons: [...new Set(reasons)],
    shards: input.shards.map(evidence => ({ directory: evidence.directory, runId: evidence.summary?.runId ?? null,
      workflowRun: evidence.summary?.workflowRun ?? null,
      shard: evidence.summary?.shard ?? null, runnerImage: evidence.summary?.runnerImage ?? null, runnerImageVersion: evidence.summary?.runnerImageVersion ?? null })),
    historyPublication: "forbidden", createdAt: new Date().toISOString() };
}

function json(path: string) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function contents(path: string) { try { return readFileSync(path, "utf8"); } catch { return null; } }

/** Explicit skip identities authorize reuse; the historical revision is only provenance. */
export function loadSkipPolicy(root: string, path: string, files: string[], source: { revision: string; patchDigest: string; toolDigest: string }) {
  const bytes = readFileSync(path), policy = JSON.parse(bytes.toString("utf8"));
  if (policy?.version !== 1 || !hash(policy.reviewedSource?.revision, 40)
    || !hash(policy.reviewedSource?.patchDigest, 64) || !hash(policy.reviewedSource?.toolDigest, 64)) {
    throw new Error("Invalid skip policy version or review provenance.");
  }
  const entries = policy.entries;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every(entry => files.includes(entry?.file)
    && typeof entry?.name === "string" && entry.name.trim().length > 0
    && typeof entry?.reason === "string" && entry.reason.trim().length > 0)
    || new Set(entries.map(entry => `${entry.file}::${entry.name}`)).size !== entries.length) {
    throw new Error("Skip policy requires unique known test identities and nonempty reasons.");
  }
  if (!hash(source.revision, 40) || !hash(source.patchDigest, 64) || !hash(source.toolDigest, 64)) throw new Error("Unknown skip policy gate source.");
  return { version: 1, source: { revision: source.revision, patchDigest: source.patchDigest, toolDigest: source.toolDigest }, entries,
    policy: { version: policy.version, path: relative(root, path).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"), reviewedSource: policy.reviewedSource } };
}

export function loadShardArtifacts(directory: string) {
  const summaries: string[] = [], verifies: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === "summary.json") summaries.push(file);
      else if (entry.isFile() && entry.name === "verify-summary.json") verifies.push(file);
    }
  };
  try { visit(directory); }
  catch { summaries.length = 0; verifies.length = 0; }
  return { shards: summaries.map(path => {
    const directory = dirname(path);
    return { directory, summary: json(path), completion: json(join(directory, "completion.json")), timings: contents(join(directory, "file-timings.json")),
      stdout: contents(join(directory, "stdout.log")), stderr: contents(join(directory, "stderr.log")) };
  }), verify: verifies.length === 1 ? json(verifies[0]!) : null };
}

export function aggregateShardOptions(args: string[]) {
  const options: Record<string, string> = {};
  for (const argument of args) {
    const match = /^--(artifacts|job-results|output|selection|skip-evidence|skip-policy|mode|platform|arch)=(.+)$/.exec(argument);
    if (!match || options[match[1]!]) throw new Error(`Invalid or duplicate aggregation option: ${argument}`);
    options[match[1]!] = ["mode", "platform", "arch"].includes(match[1]!) ? match[2]! : resolve(match[2]!);
  }
  if (!options.artifacts || !options["job-results"] || !options.output) throw new Error("Required: --artifacts=DIR --job-results=PATH --output=PATH [--selection=PATH] [--mode=full|timing] [--platform=win32|darwin] [--arch=x64] [--skip-evidence=PATH | --skip-policy=PATH]");
  if (options["skip-evidence"] && options["skip-policy"]) throw new Error("--skip-evidence and --skip-policy are mutually exclusive.");
  if (options.mode !== undefined && options.mode !== "full" && options.mode !== "timing") throw new Error("Aggregation mode must be full or timing.");
  if (options.platform !== undefined && options.platform !== "win32" && options.platform !== "darwin") throw new Error("Aggregation platform must be win32 or darwin.");
  if (options.arch !== undefined && options.arch !== "x64") throw new Error("Aggregation architecture must be x64.");
  return { ...options, mode: options.mode ?? "full", platform: options.platform ?? "win32", arch: options.arch ?? "x64" } as Record<string, string> & { mode: "full" | "timing" };
}

if (import.meta.main) {
  let options: ReturnType<typeof aggregateShardOptions> | undefined;
  try {
    options = aggregateShardOptions(process.argv.slice(2));
    const root = resolve(import.meta.dir, "..");
    const workers = process.env.CGW_TEST_WORKERS || "2";
    if (workers !== "1" && workers !== "2") throw new Error("Shard gate requires CGW_TEST_WORKERS=1|2 (default 2).");
    // Bind code and tools to the gate checkout, independently of its host platform.
    const source = performanceSource(root);
    if (!source.known || source.revision !== process.env.GITHUB_SHA) throw new Error("Unknown or different gate checkout source.");
    const digest = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
    const files = repositoryTestFiles(root);
    const skipEvidence = options["skip-policy"] ? loadSkipPolicy(root, options["skip-policy"], files, {
      revision: source.revision!, patchDigest: source.patchDigest!, toolDigest: source.toolDigest!,
    }) : options["skip-evidence"] ? json(options["skip-evidence"]) : undefined;
    const result = aggregateShardEvidence({ files, ...loadShardArtifacts(options.artifacts!),
      ...(options.selection ? { selection: json(options.selection) } : {}),
      jobResults: json(options["job-results"]!) ?? {}, ...(skipEvidence !== undefined ? { skipEvidence } : {}),
      expected: { revision: process.env.GITHUB_SHA ?? "", runId: process.env.GITHUB_RUN_ID ?? "", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
        repository: process.env.GITHUB_REPOSITORY ?? "", patchDigest: source.patchDigest!, toolDigest: source.toolDigest!,
        dependencyDigest: digest("bun.lock"), launcherDependencyDigest: digest("launcher/bun.lock"),
        platform: options.platform, arch: options.arch, mode: options.mode, isolation: "default", workers: Number(workers) as 1 | 2 } });
    mkdirSync(dirname(options.output!), { recursive: true });
    writeFileSync(options.output!, JSON.stringify(result, null, 2) + "\n");
    console.info(`[test-shards] ${result.success ? "passed" : "failed"}: ${result.reasons.join(", ")}`);
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (options?.output) {
      try {
        mkdirSync(dirname(options.output), { recursive: true });
        writeFileSync(options.output, JSON.stringify({ version: 1, kind: "test-shard-aggregate", success: false, fullSuite: false, reasons: [reason] }, null, 2) + "\n");
      } catch { /* Keep the failed gate result when the report destination is unavailable. */ }
    }
    console.error(`[test-shards] ${reason}`); process.exitCode = 1;
  }
}
