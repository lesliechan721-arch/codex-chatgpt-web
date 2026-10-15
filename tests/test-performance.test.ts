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
      test("return value",()=>{
        expect(measureRuntimeOperation("fsync.file",()=>42)).toBe(42);
        expect(measureRuntimeOperation("recovery.write",()=>42,7)).toBe(42);
        measureRuntimeOperation("recovery.noop",()=>{});
        measureRuntimeOperation("recovery.confirm",()=>{},3);
        measureRuntimeOperation("recovery.reuse",()=>{});
      });`);
    writeFileSync(second, `import {expect,test} from "bun:test";
      import {measureRuntimeOperation} from ${JSON.stringify(metrics)};
      test("original exception",()=>{
        const original=new Error("expected failure");
        try { measureRuntimeOperation("rename.retryWait",()=>{throw original;}); }
        catch(error) { expect(error).toBe(original); }
        expect(()=>measureRuntimeOperation("recovery.write",()=>{throw original;},11)).toThrow(original);
        measureRuntimeOperation("recovery.confirm",()=>{},5);
        measureRuntimeOperation("recovery.reuse",()=>{});
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
        totals: {
          "fsync.file": { count: 1, errors: 0, totalBytes: 0 },
          "rename.retryWait": { count: 1, errors: 1, totalBytes: 0 },
          "recovery.write": { count: 2, errors: 1, totalBytes: 18 },
          "recovery.noop": { count: 1, errors: 0, totalBytes: 0 },
          "recovery.confirm": { count: 2, errors: 0, totalBytes: 8 },
          "recovery.reuse": { count: 2, errors: 0, totalBytes: 0 },
        } });
      expect(summary.snapshots).toBeGreaterThan(0);
      expect(summary.wallMs).toBeGreaterThan(0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profiling accepts old reports and rejects invalid byte counts without partial aggregation", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-compatibility-"));
  try {
    const fixture = join(root, "compatibility.test.ts");
    writeFileSync(fixture, `import {test} from "bun:test";
      import {writeFileSync} from "node:fs";
      import {join} from "node:path";
      test("report compatibility",()=>{
        const directory=process.env.CGW_RUNTIME_PERFORMANCE_DIR;
        const counter={count:2,errors:0,totalMs:4,maxMs:3};
        const save=(name,counters)=>writeFileSync(join(directory,name+".json"),JSON.stringify({version:1,counters}));
        save("legacy",{"recovery.write":counter});
        save("current",{"recovery.write":{...counter,totalBytes:9}});
        for (const [name,totalBytes] of [["negative",-1],["null",null],["string","9"]]) {
          save(name,{"fsync.file":counter,"recovery.write":{...counter,totalBytes}});
        }
      });`);
    const reports = join(root, "reports");
    const child = spawnSync(process.execPath, [profiler, "--parallel=1", fixture], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: reports },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const run = readdirSync(reports)[0]!;
    const summary = JSON.parse(readFileSync(join(reports, run, "summary.json"), "utf8"));
    expect(summary.invalidReports.sort()).toEqual(["negative.json", "null.json", "string.json"]);
    expect(summary.totals["recovery.write"]).toEqual({ count: 4, errors: 0, totalMs: 8, maxMs: 3, totalBytes: 9 });
    expect(summary.totals["fsync.file"].count).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disabled metrics preserve return values and original exceptions without creating reports", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-disabled-"));
  try {
    const fixture = join(root, "disabled.ts");
    writeFileSync(fixture, `import {measureRuntimeOperation,flushRuntimePerformance} from ${JSON.stringify(metrics)};
      const result={value:42}, original=new Error("original");
      if(measureRuntimeOperation("recovery.write",()=>result,7)!==result) throw new Error("Changed return value");
      let caught=false;
      try { measureRuntimeOperation("recovery.write",()=>{throw original;},11); }
      catch(error) { if(error!==original) throw new Error("Changed exception"); caught=true; }
      if(!caught) throw new Error("Missing exception");
      flushRuntimePerformance();`);
    const env = { ...process.env };
    delete env.CGW_RUNTIME_PERFORMANCE_DIR;
    const child = spawnSync(process.execPath, [fixture], { encoding: "utf8", timeout: 15_000, env });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(readdirSync(root)).toEqual(["disabled.ts"]);
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

test("failed log writes keep waiting for the successful test and reject its metrics", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-log-"));
  try {
    const fixture = join(root, "log-io.test.ts");
    writeFileSync(fixture, `import {test} from "bun:test";
      import {renameSync,writeFileSync} from "node:fs";
      import {dirname,join} from "node:path";
      test("log destination fails", async()=>{
        const run=dirname(process.env.CGW_RUNTIME_PERFORMANCE_DIR), held=run+".held";
        renameSync(run,held);
        console.info("stdout while destination is missing");
        console.error("stderr while destination is missing");
        await new Promise(resolve=>setTimeout(resolve,60));
        writeFileSync(${JSON.stringify(join(root, "finished"))},"completed");
        renameSync(held,run);
      });`);
    const reports = join(root, "reports");
    const child = spawnSync(process.execPath, [profiler, fixture], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: reports },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(readFileSync(join(root, "finished"), "utf8")).toBe("completed");
    const summary = JSON.parse(readFileSync(join(reports, readdirSync(reports)[0]!, "summary.json"), "utf8"));
    expect(summary.counts).toEqual({ pass: 1, skip: 0, fail: 0 });
    expect(summary.complete).toBe(false);
    expect(summary.incompleteReasons).toContain("log-write-failed:stdout.log");
    expect(summary.incompleteReasons).toContain("log-write-failed:stderr.log");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unavailable profiling output directory still runs the test", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-setup-"));
  try {
    const fixture = join(root, "setup-io.test.ts"), output = join(root, "not-a-directory");
    writeFileSync(output, "blocked");
    writeFileSync(fixture, 'import {test,expect} from "bun:test"; test("actual test",()=>expect(2+2).toBe(4));');
    const child = spawnSync(process.execPath, [profiler, fixture], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: output },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toContain("1 pass");
    expect(child.stderr).toContain("preserving test exit=0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
