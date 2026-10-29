import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const profiler = fileURLToPath(new URL("../scripts/profile-tests.ts", import.meta.url));
const metrics = new URL("../src/runtime-performance.ts", import.meta.url).href;

for (const outcome of ["worker-exit", "assertion", "success"] as const) test(`parallel profiling classifies ${outcome} from root status without inferring a failure cause`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-result-"));
  const reports = join(root, "reports");
  const crashOutput = "panic(main thread): Segmentation fault at address 0x6\n✗ tests\\continuity-task-update.test.ts (worker crashed: exit code 3)";
  try {
    const files = ["first", "second"].map(name => join(root, `${name}.test.ts`));
    for (const [index, fixture] of files.entries()) {
      writeFileSync(fixture, `import {expect,test} from "bun:test";
        import {existsSync,writeFileSync} from "node:fs";
        test("parallel result ${index}",async()=>{
          writeFileSync(${JSON.stringify(join(root, `worker-${index}.json`))},JSON.stringify({pid:process.pid,worker:process.env.BUN_TEST_WORKER_ID}));
          const deadline=Date.now()+3000;
          while(!existsSync(${JSON.stringify(join(root, `worker-${1 - index}.json`))})) {
            if(Date.now()>deadline) throw new Error("Sibling worker did not start");
            await new Promise(resolve=>setTimeout(resolve,5));
          }
          ${index === 0 && outcome === "worker-exit" ? "process.exit(3);" : ""}
          ${index === 0 && outcome === "assertion" ? "expect(1).toBe(2);" : ""}
          ${index === 0 && outcome === "success" ? `console.error(${JSON.stringify(crashOutput)});` : ""}
        });`);
    }
    const child = spawnSync(process.execPath, [profiler, "--parallel=2", "--isolation=isolate", ...files], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: reports },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(outcome === "success" ? 0 : 1);
    const run = join(reports, readdirSync(reports)[0]!);
    const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ workers: 2, isolation: "isolate", signal: null, spawnError: null,
      exitCode: child.status, testResult: outcome === "success" ? "success" : "nonzero-exit",
      counts: { pass: outcome === "success" ? 2 : 1, skip: 0, fail: outcome === "success" ? 0 : 1 } });
    const identities = [0, 1].map(index => JSON.parse(readFileSync(join(root, `worker-${index}.json`), "utf8")));
    expect(new Set(identities.map(value => value.pid)).size).toBe(2);
    expect(identities.every(value => value.pid !== summary.rootPid && value.worker !== undefined)).toBe(true);
    if (outcome === "success") expect(readFileSync(join(run, "stderr.log"), "utf8")).toContain(crashOutput);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    expect(child.stderr).toContain("report-directory-unavailable");
    const run = readdirSync(join(root, "reports"))[0]!;
    const summary = JSON.parse(readFileSync(join(root, "reports", run, "summary.json"), "utf8"));
    expect(summary.exitCode).toBe(exitCode);
    expect(summary.complete).toBe(false);
    expect(summary.incompleteReasons).toContain("report-directory-unavailable");
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

for (const workers of [1, 2]) test(`timing mode clears inherited collection and preserves outcomes (workers=${workers})`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-timing-"));
  try {
    const fixture = join(root, "timing.test.ts"), reports = join(root, "reports"), inherited = join(root, "inherited");
    writeFileSync(fixture, `import {test,expect} from "bun:test";
      test("no inherited profiler",()=>{
        expect(process.env.CGW_RUNTIME_PERFORMANCE_DIR).toBeUndefined();
        expect(process.env.CGW_PERFORMANCE_RUN_ID).toBeUndefined();
        expect(process.env.CGW_TEST_TIMING_TOKEN).toBeUndefined();
        expect(process.env.CGW_TEST_TIMING_ARTIFACT_DIR).toBeUndefined();
        expect(process.env.CGW_TEST_TIMING_RESTORE).toBeUndefined();
        const child=Bun.spawnSync([process.execPath,"-e","if(process.env.CGW_RUNTIME_PERFORMANCE_DIR)process.exit(9)"],{stdout:"pipe",stderr:"pipe"});
        expect(child.exitCode).toBe(0);
      });`);
    const child = spawnSync(process.execPath, [profiler, `--parallel=${workers}`, "--mode=timing", "--isolation=isolate", fixture], {
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CGW_TEST_PROFILE_DIR: reports, CGW_RUNTIME_PERFORMANCE_DIR: inherited,
        CGW_PERFORMANCE_RUN_ID: "foreign-run", CGW_PERFORMANCE_PROCESS_ID: "foreign-process",
        CGW_TEST_TIMING_TOKEN: "fixture-token", CGW_TEST_TIMING_ARTIFACT_DIR: join(root, "history-artifacts") },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const run = join(reports, readdirSync(reports)[0]!);
    const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ version: 4, mode: "timing", isolation: "isolate", testResult: "success",
      snapshots: 0, complete: false, collection: { status: "not-requested" }, counts: { pass: 1, skip: 0, fail: 0 } });
    expect(summary.command).not.toContain("--preload");
    if (workers > 1) expect(summary.command).toContain(`--parallel=${workers}`);
    expect(summary.segments.executionMs).toBe(summary.wallMs);
    expect(summary.segments.totalMs).toBeGreaterThanOrEqual(summary.wallMs);
    expect(readdirSync(run)).toContain("file-timings.json");
    expect(readdirSync(root)).not.toContain("inherited");
    expect(readdirSync(run)).not.toContain("processes");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const planned of [false, true]) test(`the real wrapper writes complete ${planned ? "planned v6" : "cold v5"} shard reports without changing full runs`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-shard-wrapper-"));
  try {
    for (const directory of ["scripts", "src", "tests"]) mkdirSync(join(root, directory));
    const repository = fileURLToPath(new URL("..", import.meta.url));
    for (const file of ["scripts/profile-tests.ts", "scripts/optional-browser-tests.ts", "scripts/test-performance-source.ts", "scripts/test-performance-reports.ts",
      "scripts/test-timing-history.ts", "scripts/test-shards.ts", "src/runtime-performance.ts"]) copyFileSync(join(repository, file), join(root, file));
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, "tests", `${name}.test.ts`), `import {test} from "bun:test";
      test("actual shard test",()=>{}); ${name === "a" ? 'test.skip("declared skip",()=>{});' : ""}`);
    const plan = { version: 1, platform: "win32", bunVersion: "1.4.3", workers: 2,
      source: { runId: "41", revision: "a".repeat(40), repository: "owner/repo" }, overheadMs: [100, 0],
      shards: [{ files: { "tests/a.test.ts": 10, "tests/b.test.ts": 20 } }, { files: { "tests/c.test.ts": 30 } }] };
    writeFileSync(join(root, "plan.json"), JSON.stringify(plan));
    const env = { ...process.env, CGW_TEST_PROFILE_DIR: join(root, "output"), GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "3", GITHUB_REPOSITORY: "owner/repo",
      CHATGPT_DOM_TEST_BROWSER: "configured", LAUNCHER_TEST_ELECTRON: "" };
    for (const key of Object.keys(env)) if (key.startsWith("CGW_TEST_TIMING_")) delete env[key as keyof typeof env];
    for (const index of [1, 2]) {
      const child = spawnSync(process.execPath, [join(root, "scripts/profile-tests.ts"), "--mode=timing", `--shard=${index}/2`, ...(planned ? ["--shard-plan=plan.json"] : [])], { encoding: "utf8", timeout: 15_000, env });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    }
    const runs = readdirSync(join(root, "output"));
    expect(runs).toHaveLength(2);
    const summaries = runs.map(run => JSON.parse(readFileSync(join(root, "output", run, "summary.json"), "utf8"))).sort((a, b) => a.shard.index - b.shard.index);
    for (const [index, summary] of summaries.entries()) {
      expect(summary).toMatchObject({ version: planned ? 6 : 5, fullSuite: false, shard: { index: index + 1, total: 2 },
        optionalBrowserRuntimes: { CHATGPT_DOM_TEST_BROWSER: true, LAUNCHER_TEST_ELECTRON: false },
        workflowRun: { id: "42", attempt: "3", repository: "owner/repo" }, fileTiming: { version: 3, complete: true, fullSuite: false },
        scheduling: planned ? { source: "plan", from: { path: "plan.json" } } : { source: "cold", inputDigest: null, from: null },
        historyPublication: { status: "not-requested" } });
      expect(summary.command.filter((value: string) => value === "--timings")).toHaveLength(1);
      if (planned) expect(summary.command.some((value: string) => value.startsWith("--shard="))).toBe(false);
    }
    expect(summaries[0].fileTiming.executedFiles).toEqual(planned ? ["tests/a.test.ts", "tests/b.test.ts"] : ["tests/a.test.ts", "tests/c.test.ts"]);
    expect(summaries[1].fileTiming.executedFiles).toEqual(planned ? ["tests/c.test.ts"] : ["tests/b.test.ts"]);
    expect(summaries[0].skipIdentities).toEqual(["tests/a.test.ts::declared skip"]);
    expect(summaries[1].skipIdentities).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("wrapper uses a fixed history snapshot as its second timings argument and preserves partial scope", async () => {
  const { timingCompatibility, timingMetadata } = await import("../scripts/test-timing-history");
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-history-"));
  try {
    const fixture = join(root, "history.test.ts"), input = join(root, "input.json"), reports = join(root, "reports");
    writeFileSync(fixture, 'import {test} from "bun:test"; test("history wrapper",()=>{});');
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const compatibility = timingCompatibility({ workers: 2, mode: "timing", isolation: "default" });
    writeFileSync(input, JSON.stringify({ version: 1, compatibility,
      source: timingMetadata(repository, "a".repeat(40), "b".repeat(64), {}),
      execution: { complete: true, result: "success", fullSuite: true, files: ["tests/runtime-performance.test.ts"] },
      timings: { version: 1, files: { "tests/runtime-performance.test.ts": 42 } } }));
    const child = spawnSync(process.execPath, [profiler, "--mode=timing", fixture], { encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CGW_TEST_PROFILE_DIR: reports, CGW_TEST_TIMING_HISTORY: input } });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    const run = join(reports, readdirSync(reports)[0]!);
    const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
    expect(summary.scheduling).toMatchObject({ source: "restored", reason: "compatible-history", from: { kind: "local" } });
    expect(summary.scheduling.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    const index = summary.command.indexOf("--timings");
    expect(summary.command.slice(index, index + 5)).toEqual(["--timings", join(run, "file-timings.json"), "--timings", join(run, "history-input.json"), "--update-timings"]);
    expect(summary.fileTiming).toMatchObject({ version: 2, complete: false, fullSuite: false });
    expect(summary.historyPublication).toMatchObject({ status: "not-requested", remoteUpload: "not-observed" });
    expect(JSON.parse(readFileSync(join(run, "history-input.json"), "utf8"))).toEqual({ version: 1, files: { "tests/runtime-performance.test.ts": 42 } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile options reject ambiguous bail and mode values before starting tests", async () => {
  const { profileOptions } = await import("../scripts/profile-tests");
  expect(profileOptions(["--bail=2", "--mode=timing", "--isolation=isolate"]).bail).toBe(2);
  for (const arg of ["--bail", "--bail=0", "--bail=-1", "--bail=1.5", "--bail=01", "--bail=Infinity", "--bail=9007199254740992", "--mode=fast", "--isolation=unknown"]) {
    expect(() => profileOptions([arg])).toThrow();
  }
});

test("a name-filtered run can measure its target completely without claiming full-suite coverage", () => {
  const output = mkdtempSync(join(tmpdir(), "cgw-profile-filtered-"));
  try {
    const child = spawnSync(process.execPath, [profiler, "--parallel=1", "--mode=timing",
      "--test-name-pattern=runtime metrics await promises", "./tests/runtime-performance.test.ts"], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, CGW_TEST_PROFILE_DIR: output },
    });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    const summary = JSON.parse(readFileSync(join(output, readdirSync(output)[0]!, "summary.json"), "utf8"));
    expect(summary.fileTiming).toMatchObject({ version: 2, complete: true, fullSuite: false,
      targetFiles: ["tests/runtime-performance.test.ts"], executedFiles: ["tests/runtime-performance.test.ts"],
      measuredFiles: ["tests/runtime-performance.test.ts"], reasons: [] });
    expect(summary.collection.status).toBe("not-requested");
  } finally { rmSync(output, { recursive: true, force: true }); }
});

for (const exitCode of [0, 23]) test(`a failed summary write preserves the original test exit (${exitCode})`, () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-summary-io-"));
  try {
    const fixture = join(root, "one.test.ts"), driver = join(root, "write-failure.ts");
    writeFileSync(fixture, `import {test} from "bun:test"; test("original exit",()=>{ if (${exitCode}) process.exit(${exitCode}); });`);
    writeFileSync(driver, `import * as fs from "node:fs"; import {spyOn} from "bun:test";
      import {profileTests} from ${JSON.stringify(profiler)};
      const original=fs.writeFileSync;
      const spy=spyOn(fs,"writeFileSync").mockImplementation((...args)=>{
        if(String(args[0]).endsWith("summary.json")) throw Error("summary destination failed");
        return original(...args);
      });
      try { process.exitCode=await profileTests(["--parallel=1","--mode=timing",${JSON.stringify(fixture)}]); }
      finally { spy.mockRestore(); }`);
    const child = spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CGW_TEST_PROFILE_DIR: join(root, "reports") } });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(exitCode);
    expect(child.stderr).toContain(`preserving test exit=${exitCode}: summary destination failed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("post-exit log collection has a bounded deadline without changing the test result", async () => {
  const { finishProfileLogs } = await import("../scripts/profile-tests");
  let cancelled = false;
  expect(await finishProfileLogs(new Promise(() => {}), () => { cancelled = true; }, 10)).toBe(false);
  expect(cancelled).toBe(true);
  cancelled = false;
  expect(await finishProfileLogs(Promise.resolve(), () => { cancelled = true; }, 100)).toBe(true);
  expect(cancelled).toBe(false);
});

test("completion timing includes the final summary write and identifies its remaining exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-completion-"));
  try {
    const fixture = join(root, "one.test.ts"), driver = join(root, "delayed-summary.ts"), output = join(root, "reports");
    writeFileSync(fixture, 'import {test,expect} from "bun:test"; test("one",()=>expect(1).toBe(1));');
    writeFileSync(driver, `import * as fs from "node:fs";
      import {spyOn} from "bun:test";
      import {profileTests} from ${JSON.stringify(profiler)};
      const original=fs.writeFileSync;
      const spy=spyOn(fs,"writeFileSync").mockImplementation((...args)=>{
        if(String(args[0]).endsWith("summary.json")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
        return original(...args);
      });
      try { process.exitCode=await profileTests(["--mode=timing",${JSON.stringify(fixture)}]); }
      finally { spy.mockRestore(); }`);
    const child = spawnSync(process.execPath, [driver], { encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CGW_TEST_PROFILE_DIR: output } });
    expect(child.status).toBe(0);
    const run = join(output, readdirSync(output)[0]!);
    const summary = JSON.parse(readFileSync(join(run, "summary.json"), "utf8"));
    const completion = JSON.parse(readFileSync(join(run, "completion.json"), "utf8"));
    expect(completion).toMatchObject({ version: 1, runId: summary.runId,
      endPoint: "after-summary-and-status-output", excludes: ["completion-write", "process-shutdown"] });
    expect(completion.segments.reportMs - summary.segments.reportMs).toBeGreaterThanOrEqual(140);
    expect(completion.segments.totalMs - summary.segments.totalMs).toBeGreaterThanOrEqual(140);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
