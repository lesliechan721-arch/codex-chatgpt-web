import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readPerformanceSummary } from "./compare-test-performance";
import { performanceSource } from "./test-performance-source";

export function versionComparisonOptions(args: string[]) {
  let baseline: string | undefined, candidate: string | undefined;
  const files: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--baseline=")) baseline = resolve(arg.slice(11));
    else if (arg.startsWith("--candidate=")) candidate = resolve(arg.slice(12));
    else if (arg.startsWith("-")) throw new Error("Use --baseline=CHECKOUT --candidate=CHECKOUT [test files or directories]. Workers stay fixed at 2.");
    else files.push(arg);
  }
  if (!baseline || !candidate || baseline === candidate) throw new Error("Provide two different prepared checkouts, with the same measurement tools and frozen dependencies.");
  return { baseline, candidate, files };
}
const locks = (cwd: string) => {
  try { return createHash("sha256").update(readFileSync(join(cwd, "bun.lock"))).update(readFileSync(join(cwd, "launcher/bun.lock"))).digest("hex"); }
  catch { return null; }
};

/** A and B must already include the accepted clock repair and identical profiling support. */
export async function compareTestVersions(args: string[], outputOverride?: string) {
  const { baseline, candidate, files } = versionComparisonOptions(args);
  const sources = { A: performanceSource(baseline), B: performanceSource(candidate) };
  const lockDigests = { A: locks(baseline), B: locks(candidate) };
  const output = resolve(outputOverride ?? process.env.CGW_TEST_PROFILE_DIR ?? "output/test-performance");
  mkdirSync(output, { recursive: true });
  const directory = mkdtempSync(join(output, "versions-"));
  const reasons: string[] = [];
  if (!sources.A.known || !sources.B.known) reasons.push("unknown-source");
  if (!sources.A.toolDigest || sources.A.toolDigest !== sources.B.toolDigest) reasons.push("different-measurement-tools");
  if (!lockDigests.A || lockDigests.A !== lockDigests.B) reasons.push("different-or-unknown-lockfiles");
  const runs: { version: "A" | "B"; exitCode: number | null; wallMs: number | null; summary: string | null; counts: unknown; error: string | null }[] = [];
  if (!reasons.length) for (const version of ["A", "B", "B", "A"] as const) {
    const cwd = version === "A" ? baseline : candidate;
    const runOutput = join(directory, `run-${runs.length + 1}-${version}`);
    mkdirSync(runOutput);
    const run = { version, exitCode: null as number | null, wallMs: null as number | null,
      summary: null as string | null, counts: null as unknown, error: null as string | null };
    try {
      const child = Bun.spawn([process.execPath, join(cwd, "scripts/profile-tests.ts"), "--parallel=2", ...files], {
        cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, CGW_TEST_PROFILE_DIR: runOutput },
      });
      run.exitCode = await child.exited;
      const { path, summary } = readPerformanceSummary(runOutput, 2, run.exitCode, sources[version]);
      run.wallMs = summary.wallMs; run.summary = relative(directory, path); run.counts = summary.counts;
    } catch (error) { run.error = error instanceof Error ? error.message : String(error); }
    runs.push(run);
  }
  for (const version of ["A", "B"] as const) {
    const after = performanceSource(version === "A" ? baseline : candidate);
    if (after.revision !== sources[version].revision || after.patchDigest !== sources[version].patchDigest) reasons.push(`changed-source-${version}`);
  }
  if (runs.length !== 4 || runs.some(run => run.exitCode !== 0 || run.error || run.wallMs === null)) reasons.push("failed-or-incomplete-samples");
  if (runs.length && new Set(runs.map(run => JSON.stringify(run.counts))).size !== 1) reasons.push("different-test-coverage-counts");
  const groups = (["A", "B"] as const).map(version => {
    const wallMs = runs.filter(run => run.version === version).flatMap(run => run.wallMs === null ? [] : [run.wallMs]);
    return { version, wallMs, meanWallMs: wallMs.length ? wallMs.reduce((sum, value) => sum + value, 0) / wallMs.length : null };
  });
  const valid = reasons.length === 0;
  const a = groups[0]!, b = groups[1]!;
  const repeatable = valid && Math.max(...b.wallMs) < Math.min(...a.wallMs);
  const report = { version: 2, mode: "versions", workers: 2, order: ["A", "B", "B", "A"], platform: process.platform,
    arch: process.arch, bunVersion: Bun.version, sources, lockDigests, files, valid, reasons, runs, groups,
    conclusion: !valid ? "invalid" : repeatable ? "candidate-faster-in-both-samples" : "insufficient-evidence",
    speedup: valid && a.meanWallMs !== null && b.meanWallMs !== null && b.meanWallMs > 0 ? a.meanWallMs / b.meanWallMs : null,
    preparation: "Use the same install, warmup and cache policy in both prepared checkouts. This driver does not install dependencies or share fixtures/build outputs." };
  const reportPath = join(directory, "comparison.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.info(`[test-performance] comparison=${reportPath}; conclusion=${report.conclusion}`);
  return { exitCode: valid ? 0 : 1, reportPath, report };
}
if (import.meta.main) process.exitCode = (await compareTestVersions(process.argv.slice(2))).exitCode;
