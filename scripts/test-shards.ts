import { createHash } from "node:crypto";

export type TestShard = { index: number; total: number };

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

/** Bun 1.4.3 cold sharding sorts paths, then assigns their zero-based index modulo n. */
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
