import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Include every probe site, not only the collector. Whole-file equality is
// conservative: a business edit in one of these files needs a separately
// reviewed comparison, rather than silently changing the measured work.
export const MEASUREMENT_FILES = [
  "src/runtime-performance.ts", "src/config.ts",
  "src/adapters/chatgpt-web/continuity-recovery-store.ts", "src/adapters/chatgpt-web/recovery-durability.ts",
  "scripts/profile-tests.ts", "scripts/test-shards.ts", "scripts/aggregate-test-shards.ts", "scripts/verify.ts",
  "scripts/test-performance-preload.ts", "scripts/test-performance-source.ts",
  "scripts/test-performance-reports.ts", "scripts/test-performance-children.ts", "scripts/runtime-performance-preload.ts",
  "scripts/test-timing-history.ts", "scripts/test-timing-history-rest.ts",
  "scripts/compare-test-performance.ts", "scripts/compare-test-versions.ts", "tests/helpers/performance-test.ts",
  "tests/helpers/retained-fixture-cleanup.ts", "tests/helpers/retained-compaction-fixture.ts",
  "tests/helpers/session-continuity-fixture.ts", "tests/session-continuity-adapter.test.ts",
  "tests/helpers/continuity-source-diagnostics.ts",
  "tests/session-continuity-http.test.ts", "tests/session-continuity-compaction.test.ts",
  "tests/session-continuity-recovery.test.ts", "tests/session-continuity-checkpoint.test.ts",
  "tests/server-lifecycle.test.ts", "tests/continuity-recovery-compaction.test.ts",
] as const;
export function measurementFingerprint(cwd: string) {
  const tool = createHash("sha256");
  const measurementFiles = MEASUREMENT_FILES.map(file => {
    const digest = createHash("sha256").update(readFileSync(join(cwd, file))).digest("hex");
    tool.update(file).update("\0").update(digest).update("\0");
    return { file, digest };
  });
  return { toolDigest: tool.digest("hex"), measurementFiles };
}

export function performanceSource(cwd: string) {
  const git = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const revision = git(["rev-parse", "HEAD"]);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = git(["diff", "HEAD", "--binary"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const top = git(["rev-parse", "--show-toplevel"]);
  const node = spawnSync("node", ["--version"], { cwd, encoding: "utf8" });
  let patchDigest: string | null = null;
  let toolDigest: string | null = null;
  let measurementFiles: { file: string; digest: string }[] | null = null;
  try {
    if ([status, diff, untracked, top].some(result => result.status !== 0 || result.error)) throw new Error("Unknown source root");
    // Git and the runtime can spell the same Windows directory differently
    // (including 8.3 temporary paths). Compare filesystem identity, not spelling.
    const directory = statSync(cwd, { bigint: true }), root = statSync(top.stdout.trim(), { bigint: true });
    if (!directory.isDirectory() || directory.dev !== root.dev || directory.ino !== root.ino) throw new Error("Unknown source root");
    const patch = createHash("sha256").update(diff.stdout);
    for (const file of untracked.stdout.split("\0").filter(Boolean).sort()) {
      patch.update(file).update("\0").update(readFileSync(join(cwd, file))).update("\0");
    }
    patchDigest = patch.digest("hex");
    ({ toolDigest, measurementFiles } = measurementFingerprint(cwd));
  } catch { /* Unidentified source is not accepted as a performance comparison. */ }
  const sha = revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
  return { revision: sha, workflowRevision: process.env.GITHUB_SHA ?? null,
    nodeVersion: node.status === 0 && /^v[\d.]+$/.test(node.stdout.trim()) ? node.stdout.trim() : null,
    workingTreeDirty: status.status === 0 && !status.error ? status.stdout.length > 0 : null,
    patchDigest, toolVersion: 3, toolDigest, measurementFiles,
    known: sha !== null && patchDigest !== null && toolDigest !== null };
}
