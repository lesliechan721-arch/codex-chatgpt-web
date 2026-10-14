import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const profiler = fileURLToPath(new URL("../scripts/profile-tests.ts", import.meta.url));
const metrics = new URL("../src/runtime-performance.ts", import.meta.url).href;

for (const workers of [1, 2]) test(`test profiling preserves counters across files and reports failures (workers=${workers})`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-test-profile-"));
  const reports = join(root, "reports");
  try {
    const first = join(root, "first.test.ts"), second = join(root, "second.test.ts");
    writeFileSync(first, `import {expect,test} from "bun:test";
      import {measureRuntimeOperation} from ${JSON.stringify(metrics)};
      test("return value",()=>expect(measureRuntimeOperation("fsync.file",()=>42)).toBe(42));`);
    writeFileSync(second, `import {expect,test} from "bun:test";
      import {measureRuntimeOperation} from ${JSON.stringify(metrics)};
      test("original exception",()=>{
        const original=new Error("expected failure");
        try { measureRuntimeOperation("rename.retryWait",()=>{throw original;}); }
        catch(error) { expect(error).toBe(original); }
        expect(process.env.PROFILE_EXPECT_FAILURE).not.toBe("1");
      });`);
    for (const failure of [false, true]) {
      const child = spawnSync(process.execPath, [profiler, `--parallel=${workers}`, first, second], {
        encoding: "utf8", timeout: 15_000,
        env: { ...process.env, CGW_TEST_PROFILE_DIR: reports, PROFILE_EXPECT_FAILURE: failure ? "1" : "0" },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(failure ? 1 : 0);
      const summaries = readdirSync(reports).map(name => JSON.parse(readFileSync(join(reports, name, "summary.json"), "utf8")));
      const summary = summaries.find(value => value.exitCode === (failure ? 1 : 0));
      expect(summary).toMatchObject({ workers, exitCode: failure ? 1 : 0, invalidReports: [],
        totals: { "fsync.file": { count: 1, errors: 0 }, "rename.retryWait": { count: 1, errors: 1 } } });
      expect(summary.snapshots).toBeGreaterThan(0);
      expect(summary.wallMs).toBeGreaterThan(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const exitCode of [0, 23]) test(`a lost report directory preserves the test exit code (${exitCode})`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-io-"));
  try {
    const fixture = join(root, "report-io.test.ts");
    writeFileSync(fixture, `import {test} from "bun:test";
      import {rmSync,writeFileSync} from "node:fs";
      test("report destination fails",()=>{
        const reports=process.env.CGW_RUNTIME_PERFORMANCE_DIR;
        rmSync(reports,{recursive:true,force:true}); writeFileSync(reports,"not a directory");
        if (${exitCode}) process.exit(${exitCode});
      });`);
    const child = spawnSync(process.execPath, [profiler, "--parallel=1", fixture], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: join(root, "reports") },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exitCode);
    expect(child.stderr).toContain(`Could not collect performance reports; preserving test exit=${exitCode}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
