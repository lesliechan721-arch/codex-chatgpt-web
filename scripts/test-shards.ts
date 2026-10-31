import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseTimingData } from "./test-timing-history";

export type TestShard = { index: number; total: number };
export type TestShardPlan = {
  version: 1; platform: "win32"; bunVersion: "1.4.3" | "1.4.4"; workers: 1 | 2;
  source: { runId: string; revision: string; repository: string };
  overheadMs: number[];
  shards: { files: Record<string, number> }[];
};
export type LoadedShardPlan = { path: string; digest: string; plan: TestShardPlan };

export function parseShardPlan(value: any): TestShardPlan {
  // This version describes historical measurements, not the runtime required by the release gate.
  if (value?.version !== 1 || value.platform !== "win32" || !["1.4.3", "1.4.4"].includes(value.bunVersion)
    || ![1, 2].includes(value.workers) || !/^[1-9]\d*$/.test(value.source?.runId)
    || !/^[a-f0-9]{40}$/.test(value.source?.revision)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.source?.repository)
    || !Array.isArray(value.shards) || value.shards.length !== 2
    || !Array.isArray(value.overheadMs) || value.overheadMs.length !== 2
    || !value.overheadMs.every((ms: unknown) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) {
    throw new Error("Invalid Windows test shard plan.");
  }
  const seen = new Set<string>();
  for (const shard of value.shards) {
    const timings = parseTimingData({ version: 1, files: shard?.files });
    if (Object.keys(timings.files).length === 0) throw new Error("Shard plan has an empty shard.");
    for (const file of Object.keys(timings.files)) {
      if (seen.has(file)) throw new Error(`Duplicate shard plan file: ${file}`);
      seen.add(file);
    }
  }
  return value;
}

export function loadShardPlan(root: string, path: string): LoadedShardPlan {
  const absolute = resolve(root, path), name = relative(root, absolute).replaceAll("\\", "/");
  if (name === ".." || name.startsWith("../") || isAbsolute(name)) throw new Error("Shard plan must be inside the checkout.");
  const bytes = readFileSync(absolute);
  return { path: name, digest: createHash("sha256").update(bytes).digest("hex"), plan: parseShardPlan(JSON.parse(bytes.toString("utf8"))) };
}

/** Recorded assignments stay fixed. New paths do not move existing tests. */
export function plannedShardFiles(files: string[], shard: TestShard, plan: TestShardPlan): string[] {
  if (shard.total !== plan.shards.length) throw new Error("Shard count does not match the plan.");
  const assignments = new Map(plan.shards.flatMap((entry, index) => Object.keys(entry.files).map(file => [file, index + 1] as const)));
  return [...files].sort().filter(file => {
    const index = assignments.get(file) ?? createHash("sha256").update(file).digest().readUInt32BE(0) % shard.total + 1;
    return index === shard.index;
  });
}

/** Place long files first, charging serial verify work to every worker on shard 1. */
export function balanceShardPlan(timings: Record<string, number>, workers: 1 | 2, overheadMs: number[]) {
  const shards = overheadMs.map(() => ({ files: {} as Record<string, number> }));
  const loads = overheadMs.map(ms => ms * workers);
  const entries = Object.entries(timings).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  for (const [position, [file, ms]] of entries.entries()) {
    const empty = shards.findIndex(shard => Object.keys(shard.files).length === 0);
    const index = position === entries.length - 1 && empty !== -1 ? empty : loads[0]! <= loads[1]! ? 0 : 1;
    shards[index]!.files[file] = ms;
    loads[index]! += ms;
  }
  for (const shard of shards) shard.files = Object.fromEntries(Object.entries(shard.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return shards;
}

export function parseTestShard(value: string): TestShard {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]), total = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 2 || index > total) {
    throw new Error("--shard / --test-shard must be i/n with safe integers, 1 <= i <= n and n >= 2.");
  }
  return { index, total };
}

export function assertColdShardEnvironment(env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some(key => key.startsWith("CGW_TEST_TIMING_") && env[key] !== undefined)) {
    throw new Error("Shards require cold scheduling; explicit CGW_TEST_TIMING_* history variables are not supported.");
  }
}

export const testFileSetDigest = (files: string[]) => createHash("sha256").update(JSON.stringify([...files].sort())).digest("hex");

/** Bun 1.4.4 cold sharding sorts paths, then assigns their zero-based index modulo n. */
export function coldShardFiles(files: string[], shard: TestShard): string[] {
  // Bun compares UTF-8 path bytes. UTF-16 String.sort changes the order of supplementary characters.
  return [...files].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .filter((_, index) => index % shard.total === shard.index - 1);
}

export function testSkipIdentities(stderr: string): string[] {
  let file = "";
  const skips: string[] = [];
  for (const line of stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").split("\n")) {
    // Bun's final list repeats skip results already attached to their test files.
    if (/^\d+ tests? skipped:\s*$/.test(line)) break;
    if (/\.(?:[cm]?[jt]sx?):$/.test(line)) file = line.slice(0, -1).replace(/^::group::/, "").replaceAll("\\", "/").replace(/^\.\//, "");
    const match = /^\(skip\) (.+)$/.exec(line);
    if (match) skips.push(`${file}::${match[1]}`);
  }
  return skips.sort();
}

export function testLogResult(stderr: string) {
  const clean = stderr.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
  const headers = clean.split("\n").filter(line => line.endsWith(":"))
    .map(line => line.slice(0, -1).replace(/^::group::/, "").replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter(file => /[._](?:test|spec)\.[cm]?[jt]sx?$/.test(file));
  const fileCounts = [...clean.matchAll(/(?:^|\n)Ran \d+ tests? across (\d+) files?\./g)];
  const counts = Object.fromEntries(["pass", "skip", "fail"].map(kind => {
    const matches = [...clean.matchAll(new RegExp(`(?:^|\\n)\\s*(\\d+) ${kind}(?:\\s|$)`, "g"))];
    return [kind, matches.length ? Number(matches.at(-1)![1]) : kind === "pass" ? null : 0];
  }));
  return { executedFiles: [...new Set(headers)].sort(), reportedFiles: fileCounts.length ? Number(fileCounts.at(-1)![1]) : null,
    counts, skipIdentities: testSkipIdentities(clean) };
}
