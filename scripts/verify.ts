import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-verify-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<void> {
  const start = performance.now();
  console.info(`[verify] start: bun ${args.join(" ")}`);
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  console.info(`[verify] finish: bun ${args.join(" ")}; elapsed=${((performance.now() - start) / 1000).toFixed(2)}s; exit=${exitCode}`);
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "typecheck"]);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", process.env.CGW_TEST_PROFILE_DIR ? "test:profile" : "test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
