import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadShardArtifacts } from "./aggregate-test-shards";
import { balanceShardPlan, parseShardPlan, testFileSetDigest, testLogResult, type TestShardPlan } from "./test-shards";
import { parseTimingData, repositoryTestFiles } from "./test-timing-history";

/** Historical reports estimate cost; the independent gate still proves current coverage. */
export function planTestShards(root: string, artifacts: string): TestShardPlan {
  const shards = loadShardArtifacts(artifacts).shards.filter(shard => shard.summary?.platform === "win32");
  const firstEvidence = shards.find(shard => shard.summary?.shard?.index === 1);
  const first = firstEvidence?.summary;
  if (shards.length !== 2 || !first || new Set(shards.map(shard => shard.summary?.shard?.index)).size !== 2) {
    throw new Error("Planning requires reports from both Windows shards.");
  }
  const verify = JSON.parse(readFileSync(resolve(firstEvidence!.directory, "../verify-summary.json"), "utf8"));
  const timings: Record<string, number> = {};
  for (const evidence of shards) {
    const summary = evidence.summary;
    if (![1, 2].includes(summary?.shard?.index) || summary.shard.total !== 2 || summary.platform !== "win32"
      || summary.arch !== "x64" || !["1.4.3", "1.4.4"].includes(summary.bunVersion)
      || summary.bunVersion !== first.bunVersion || summary.workers !== first.workers
      || summary.revision !== first.revision || summary.patchDigest !== first.patchDigest || summary.toolDigest !== first.toolDigest
      || summary.workflowRun?.id !== first.workflowRun?.id || summary.workflowRun?.repository !== first.workflowRun?.repository
      || summary.testResult !== "success" || summary.exitCode !== 0 || summary.wallValid !== true
      || summary.fileTiming?.complete !== true || evidence.timings === null || evidence.stderr === null) {
      throw new Error("Planning requires successful, complete Windows reports from the same source and workflow run.");
    }
    const measured = parseTimingData(JSON.parse(evidence.timings)).files;
    const targetDigest = testFileSetDigest(summary.shard.expectedFiles);
    if (testFileSetDigest(Object.keys(measured)) !== targetDigest
      || testFileSetDigest(testLogResult(evidence.stderr).executedFiles) !== targetDigest) throw new Error("Incomplete planning file evidence.");
    for (const [file, ms] of Object.entries(measured)) {
      if (file in timings) throw new Error(`Duplicate measured file: ${file}`);
      timings[file] = ms;
    }
  }
  const current = repositoryTestFiles(root);
  if (current.some(file => !(file in timings))) throw new Error("Current test files are missing measurements. Run both shards before rebalancing.");
  if (verify?.success !== true || verify.workflowRun?.id !== first.workflowRun.id
    || verify.workflowRun?.attempt !== first.workflowRun.attempt || !Array.isArray(verify.stages)
    || verify.stages.length === 0 || verify.stages.some((stage: any) => stage.exitCode !== 0 || !Number.isFinite(stage.elapsedMs) || stage.elapsedMs < 0)
    || verify.profiles?.[0]?.runId !== first.runId) throw new Error("Planning requires shard 1's successful verification report.");
  const overheadMs = [Math.ceil(verify.stages.filter((stage: any) => stage.command?.[2] !== "test")
    .reduce((sum: number, stage: any) => sum + stage.elapsedMs, 0)), 0];
  return parseShardPlan({ version: 1, platform: "win32", bunVersion: first.bunVersion, workers: first.workers,
    source: { runId: first.workflowRun.id, revision: first.revision, repository: first.workflowRun.repository }, overheadMs,
    shards: balanceShardPlan(Object.fromEntries(current.map(file => [file, timings[file]!])), first.workers, overheadMs) });
}

if (import.meta.main) {
  try {
    const options: Record<string, string> = {};
    for (const arg of process.argv.slice(2)) {
      const match = /^--(artifacts|output)=(.+)$/.exec(arg);
      if (!match || options[match[1]!]) throw new Error(`Invalid or duplicate planning option: ${arg}`);
      options[match[1]!] = resolve(match[2]!);
    }
    if (!options.artifacts || !options.output) throw new Error("Required: --artifacts=DIR --output=PATH");
    const plan = planTestShards(resolve(import.meta.dir, ".."), options.artifacts);
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, JSON.stringify(plan, null, 2) + "\n");
    for (const [index, shard] of plan.shards.entries()) {
      const ms = Object.values(shard.files).reduce((sum, cost) => sum + cost, 0) / plan.workers + plan.overheadMs[index]!;
      console.info(`[test-shards] shard ${index + 1}: ${Object.keys(shard.files).length} files; estimated work/worker + verify=${(ms / 1000).toFixed(2)}s`);
    }
  } catch (error) {
    console.error(`[test-shards] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
