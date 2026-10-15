import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { collectPerformanceReports } from "../scripts/test-performance-reports";

const modulePath = resolve(import.meta.dir, "../src/runtime-performance.ts");
const counter = { count: 1, errors: 0, totalMs: 4, maxMs: 4, totalBytes: 11 };
function snapshot() {
  return { version: 2, snapshotId: "root-snapshot", runId: "run", processId: "root", pid: 123, complete: true, contexts: [], counters: { "recovery.write": counter } };
}
function collectFixture(action: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "cgw-report-"));
  try { action(directory); return collectPerformanceReports(directory, "run", "root", 123); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("runtime metrics await promises, use an independent clock, and replace repeated snapshots", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-metrics-"));
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { measureRuntimeOperation as sync, measureRuntimeAsync as asyncMeasure, withRuntimePerformanceContext as context, flushRuntimePerformance as flush } from ${JSON.stringify(modulePath)};
      Date.now = () => 1; performance.now = () => 1;
      await context({ file: "tests/static.test.ts", scenarioId: "static-case", parameterId: "variant", fixtureMode: "minimal" }, async () => {
        await asyncMeasure("request.total", async () => {
          sync("recovery.write", () => {}, 11);
          await new Promise(resolve => setTimeout(resolve, 35));
        });
        try { await asyncMeasure("fixture.cleanup", async () => { await Promise.resolve(); throw Error("expected"); }); } catch {}
      });
      flush(true); flush(true);
    `], { env: { ...process.env, CGW_RUNTIME_PERFORMANCE_DIR: directory, CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const files = readdirSync(directory).filter(file => !file.endsWith(".child.json"));
    expect(files).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(directory, files[0]!), "utf8"));
    expect(report.complete).toBe(true);
    expect(report.counters["request.total"].totalMs).toBeGreaterThanOrEqual(25);
    expect(report.counters["recovery.write"]).toMatchObject({ count: 1, totalBytes: 11 });
    expect(report.counters["fixture.cleanup"]).toMatchObject({ count: 1, errors: 1 });
    expect(report.contexts[0].context).toEqual({ file: "tests/static.test.ts", scenarioId: "static-case", parameterId: "variant", fixtureMode: "minimal" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("disabled diagnostics and failed report writes preserve application results", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-diagnostics-"));
  try {
    for (const reportDirectory of ["", join(directory, "missing", "reports")]) {
      const child = Bun.spawnSync([process.execPath, "-e", `
        import { measureRuntimeOperation, flushRuntimePerformance } from ${JSON.stringify(modulePath)};
        if (measureRuntimeOperation("recovery.write", () => 7) !== 7) process.exit(9);
        flushRuntimePerformance(true);
      `], { env: { ...process.env, CGW_RUNTIME_PERFORMANCE_DIR: reportDirectory }, stdout: "pipe", stderr: "pipe" });
      expect(child.exitCode).toBe(0);
    }
    expect(readdirSync(directory)).toHaveLength(0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a completed root with no operations is a complete snapshot", () => {
  const report = collectFixture(directory => writeFileSync(join(directory, "root.json"), JSON.stringify(snapshot())));
  expect(report.complete).toBe(true);
  expect(report.totals["recovery.write"]?.count).toBe(1);
});
for (const defect of ["missing-root", "corrupt", "unfinished", "wrong-origin", "bad-counter", "bad-context", "missing-child", "killed-child", "running-child", "unknown-parent", "duplicate-snapshot", "missing-ledger"]) {
  test(`report collection rejects ${defect} evidence`, () => {
    const result = collectFixture(directory => {
      const report: any = snapshot();
      if (defect === "unfinished") report.complete = false;
      if (defect === "wrong-origin") report.runId = "other";
      if (defect === "missing-ledger") report.counters["process.start"] = counter;
      if (defect === "bad-counter") report.counters["recovery.write"] = { ...counter, errors: 2 };
      if (defect === "bad-context") report.contexts = [{ context: {}, counters: { "recovery.write": { ...counter, totalMs: -1 } } }];
      if (defect !== "missing-root") writeFileSync(join(directory, "root.json"), defect === "corrupt" ? "{" : JSON.stringify(report));
      if (defect === "duplicate-snapshot") writeFileSync(join(directory, "duplicate.json"), JSON.stringify(report));
      if (defect.endsWith("child") || defect === "unknown-parent") {
        writeFileSync(join(directory, "child.child.json"), JSON.stringify({ version: 2, kind: "child", runId: "run",
          id: "child", parentId: defect === "unknown-parent" ? "unknown" : "root", pid: 456, expectsReport: true,
          status: defect === "running-child" ? "running" : "exited", exitCode: defect === "killed-child" ? 137 : 0,
          signal: defect === "killed-child" ? "SIGKILL" : null }));
      }
    });
    expect(result.complete).toBe(false);
  });
}

test("legacy reports keep old metrics and leave new fields unknown", () => {
  const result = collectFixture(directory => writeFileSync(join(directory, "old.json"), JSON.stringify({ version: 1, counters: { "recovery.write": counter } })));
  expect(result.totals["recovery.write"]?.totalBytes).toBe(11);
  expect(result.totals["recovery.proofRemember"]).toBeNull();
  expect(result.complete).toBe(false);
  expect(result.incompleteReasons).toContain("legacy-origin-and-new-metrics-unknown");
});

test("completed native child ledgers match their parent's start counter", () => {
  const result = collectFixture(directory => {
    const report: any = snapshot();
    report.counters["process.start"] = counter;
    writeFileSync(join(directory, "root.json"), JSON.stringify(report));
    writeFileSync(join(directory, "child.child.json"), JSON.stringify({ version: 2, kind: "child", runId: "run",
      id: "child", parentId: "root", pid: 456, expectsReport: false, status: "exited", exitCode: 0, signal: null }));
  });
  expect(result.complete).toBe(true);
});

test("failed child ledger writes preserve results and make recovered reports incomplete", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-child-ledger-"));
  const tracker = resolve(import.meta.dir, "../scripts/test-performance-children.ts");
  try {
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { renameSync } from "node:fs";
      import { trackTestChildren } from ${JSON.stringify(tracker)};
      import { flushRuntimePerformance } from ${JSON.stringify(modulePath)};
      trackTestChildren();
      const directory = process.env.CGW_RUNTIME_PERFORMANCE_DIR;
      renameSync(directory, directory + ".held");
      const result = Bun.spawnSync([process.execPath, "--version"], { stdout: "pipe", stderr: "pipe" });
      renameSync(directory + ".held", directory);
      if (result.exitCode !== 0) process.exit(9);
      flushRuntimePerformance(true);
    `], { env: { ...process.env, CGW_RUNTIME_PERFORMANCE_DIR: directory, CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const result = collectPerformanceReports(directory, "run", "root", child.pid);
    expect(result.complete).toBe(false);
    expect(result.children).toHaveLength(0);
    expect(result.totals["process.start"]?.count).toBe(1);
    expect(result.incompleteReasons).toContain("diagnostic-error:child-ledger-write-failed");
    expect(result.incompleteReasons).toContain("child-start-ledger-mismatch:root");
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(directory + ".held", { recursive: true, force: true }); }
});

test("profiled Bun test children keep native process identities and bypass package scripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-test-child-"));
  const tracker = resolve(import.meta.dir, "../scripts/test-performance-children.ts");
  try {
    const reports = join(directory, "reports"); mkdirSync(reports);
    writeFileSync(join(directory, "package.json"), JSON.stringify({ scripts: { test: "exit 73" } }));
    writeFileSync(join(directory, "pid.test.ts"), `import { test } from "bun:test";
      test("actual process", () => console.info("ACTUAL_PID", process.pid));`);
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CGW_RUNTIME_PERFORMANCE_DIR: reports,
      CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root", CGW_PERFORMANCE_ROOT_PROCESS_ID: "root", CGW_PERFORMANCE_CONTEXT: "" };
    delete env.BUN_TEST_WORKER_ID;
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { trackTestChildren } from ${JSON.stringify(tracker)};
      trackTestChildren();
      for (const objectForm of [false, true]) {
        const command = [process.execPath, "test", "./pid.test.ts"];
        const options = { stdout: "pipe", stderr: "pipe" };
        const sync = objectForm ? Bun.spawnSync({ ...options, cmd: command }) : Bun.spawnSync(command, options);
        if (sync.exitCode !== 0 || Number(sync.stdout.toString().match(/ACTUAL_PID (\\d+)/)?.[1]) !== sync.pid) throw Error(sync.stderr.toString() || "sync child PID changed");
        const asyncChild = objectForm ? Bun.spawn({ ...options, cmd: command }) : Bun.spawn(command, options);
        const [stdout, stderr, exitCode] = await Promise.all([new Response(asyncChild.stdout).text(), new Response(asyncChild.stderr).text(), asyncChild.exited]);
        if (exitCode !== 0 || Number(stdout.match(/ACTUAL_PID (\\d+)/)?.[1]) !== asyncChild.pid) throw Error(stderr || "async child PID changed");
      }
    `], { cwd: directory, env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0);
    const metrics = collectPerformanceReports(reports, "run", "root", child.pid);
    expect({ complete: metrics.complete, reasons: metrics.incompleteReasons, invalid: metrics.invalidReports }).toEqual({ complete: true, reasons: [], invalid: [] });
    expect(metrics.totals["process.start"]?.count).toBe(4);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("performance test registration preserves modifiers, row arguments and done completion", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-registration-"));
  const wrapper = resolve(import.meta.dir, "helpers/performance-test.ts");
  try {
    const file = join(directory, "registration.test.ts");
    writeFileSync(file, `import { expect, afterAll } from "bun:test";
      import { performanceTest } from ${JSON.stringify(wrapper)};
      import { flushRuntimePerformance } from ${JSON.stringify(modulePath)};
      const test = performanceTest(import.meta.path);
      test("ordinary", () => expect(2 + 2).toBe(4));
      test.each([1, 2])("table %i", value => expect(value).toBeGreaterThan(0));
      test.skipIf(false)("enabled condition", () => expect(true).toBe(true));
      test.if(true)("true condition", () => expect(true).toBe(true));
      test.skipIf(true)("existing skip", () => { throw Error("not run"); });
      test.failingIf(true)("expected failure", () => { throw Error("expected"); });
      test("callback", done => setTimeout(() => { expect(typeof done).toBe("function"); done(); }, 30));
      test.each([1, 2])("table callback %i", (value, done) => setTimeout(() => { expect(value).toBeGreaterThan(0); done(); }, 10));
      test.each([() => 7])("function row", value => expect(value()).toBe(7));
      test.each([7n])("BigInt row", value => expect(value).toBe(7n));
      const cyclic = {}; cyclic.self = cyclic;
      test.each([cyclic])("cyclic row", value => expect(value.self).toBe(value));
      const mutable = { calls: 0, toJSON() { this.calls++; return {}; } };
      test.each([mutable])("toJSON row", value => expect(value.calls).toBe(0));
      const guarded = { get privateValue() { throw Error("parameter getter executed"); } };
      test.each([guarded])("object getter row", value => expect(typeof Object.getOwnPropertyDescriptor(value,"privateValue").get).toBe("function"));
      let rowReads = 0;
      const row = []; Object.defineProperty(row, "0", { get() { rowReads++; return 7; } });
      test.each([row])("array getter row", value => expect(value).toBe(7));
      const supplied = () => 42;
      test.each([[1], [1, supplied]])("varied row", (...args) => {
        expect(args[0]).toBe(1); if (args.length === 2) expect(args[1]).toBe(supplied);
      });
      test.each([[1], [1, supplied]])("varied callback row", (value, middle, last) => {
        expect(value).toBe(1); if (last) expect(middle).toBe(supplied);
        const done = last ?? middle; setTimeout(() => done(), 5);
      });
      afterAll(() => { console.info("ROW_READS", rowReads); flushRuntimePerformance(true); });
    `);
    const reads: string[] = [];
    for (const enabled of [false, true]) {
      const reports = join(directory, enabled ? "enabled" : "disabled");
      mkdirSync(reports);
      const child = Bun.spawnSync([process.execPath, "test", file], {
        env: { ...process.env, NO_COLOR: "1", CGW_RUNTIME_PERFORMANCE_DIR: enabled ? reports : "",
          CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root" }, stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toContain("19 pass");
      expect(child.stderr.toString()).toContain("1 skip");
      reads.push(child.stdout.toString().match(/ROW_READS (\d+)/)![1]!);
      if (enabled) {
        const result = collectPerformanceReports(reports, "run", "root", child.pid);
        expect(result.complete).toBe(true);
        expect(result.totals["test.total"]?.count).toBe(19);
        expect(result.unassignedParameterTests).toBe(1);
        const label = `${relative(resolve(import.meta.dir, ".."), realpathSync(file)).replaceAll("\\", "/")}:callback`;
        const callback = result.contexts.find(bucket => (bucket.context as any).scenarioId === createHash("sha256").update(label).digest("hex"));
        expect(callback?.counters["test.total"]?.totalMs).toBeGreaterThanOrEqual(25);
        for (const label of ["varied row", "varied callback row"]) {
          const scenario = createHash("sha256").update(`${relative(resolve(import.meta.dir, ".."), realpathSync(file)).replaceAll("\\", "/")}:${label}`).digest("hex");
          const ids = result.contexts.filter(bucket => (bucket.context as any).scenarioId === scenario).map(bucket => (bucket.context as any).parameterId);
          expect(new Set(ids).size).toBe(2);
          expect(ids).not.toContain(null);
        }
      } else expect(readdirSync(reports)).toHaveLength(0);
    }
    expect(reads[0]).toBe(reads[1]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const failRelease of [false, true]) test(`retained cleanup attributes both actual page releases (failure=${failRelease})`, () => {
  // defaultConfig uses Bun.main for the service command. Keep this generated
  // entry in the checkout so the real durable-command check also works on Linux.
  const fixtures = resolve(import.meta.dir, "../output/runtime-performance-fixtures");
  mkdirSync(fixtures, { recursive: true });
  const directory = mkdtempSync(join(fixtures, "cgw-release-metrics-"));
  const helper = resolve(import.meta.dir, "helpers/retained-compaction-fixture.ts");
  const preload = resolve(import.meta.dir, "../scripts/test-performance-preload.ts");
  try {
    const file = join(directory, "release.test.ts"), reports = join(directory, "reports"); mkdirSync(reports);
    writeFileSync(file, `import { expect,test } from "bun:test";
      import { retainedTaskFixture } from ${JSON.stringify(helper)};
      const native = globalThis.fetch;
      let releases = 0;
      test("actual checkpoint cleanup", async () => {
        globalThis.fetch = async (...args) => {
          if (String(args[0]).includes("/v1/turn/release")) {
            releases++;
            if (releases === 2) {
              await new Promise(resolve => setTimeout(resolve, 25));
              ${failRelease ? 'throw Error("injected checkpoint release failure");' : ""}
            }
          }
          return native(...args);
        };
        const fixture = retainedTaskFixture();
        try {
          const source = await fixture.send(fixture.body); expect(source.status).toBe(200);
          const original = await source.json();
          const checkpoint = await fixture.send({ ...fixture.body, input: [...fixture.body.input, ...original.output] }, true);
          expect(checkpoint.status).toBe(200);
        } finally {
          try { ${failRelease ? 'await expect(fixture.dispose()).rejects.toThrow("Retained fixture cleanup failed");' : "await fixture.dispose();"} }
          finally { globalThis.fetch = native; }
        }
        expect(releases).toBe(2);
      });
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CGW_RUNTIME_PERFORMANCE_DIR: reports,
      CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root", CGW_PERFORMANCE_ROOT_PROCESS_ID: "root", CGW_PERFORMANCE_CONTEXT: "" };
    delete env.BUN_TEST_WORKER_ID;
    const child = Bun.spawnSync([process.execPath, "test", "--preload", preload, file], { env,
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(child.exitCode, `${child.stdout.toString()}\n${child.stderr.toString()}`).toBe(0);
    const metrics = collectPerformanceReports(reports, "run", "root", child.pid);
    expect({ complete: metrics.complete, reasons: metrics.incompleteReasons, invalid: metrics.invalidReports }).toEqual({ complete: true, reasons: [], invalid: [] });
    expect(metrics.totals["cleanup.release"]?.count).toBe(2);
    expect(metrics.totals["cleanup.release"]?.errors).toBe(Number(failRelease));
    expect(metrics.totals["cleanup.release"]?.totalMs).toBeGreaterThanOrEqual(20);
    expect(metrics.totals["fixture.http"]?.count).toBe(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const mode of ["error", "timeout"]) test(`performance test callbacks preserve ${mode} behavior`, () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-callback-"));
  const wrapper = resolve(import.meta.dir, "helpers/performance-test.ts");
  try {
    const file = join(directory, "callback.test.ts");
    writeFileSync(file, `import { afterAll } from "bun:test";
      import { performanceTest } from ${JSON.stringify(wrapper)};
      import { flushRuntimePerformance } from ${JSON.stringify(modulePath)};
      const test = performanceTest(import.meta.path);
      test("callback boundary", done => {
        ${mode === "error" ? 'setTimeout(() => done(Error("original done error")), 5);' : "void done;"}
      }, 20);
      afterAll(() => flushRuntimePerformance(true));
    `);
    for (const enabled of [false, true]) {
      const reports = join(directory, enabled ? "enabled" : "disabled"); mkdirSync(reports);
      const child = Bun.spawnSync([process.execPath, "test", file], {
        env: { ...process.env, NO_COLOR: "1", CGW_RUNTIME_PERFORMANCE_DIR: enabled ? reports : "",
          CGW_PERFORMANCE_RUN_ID: "run", CGW_PERFORMANCE_PROCESS_ID: "root" }, stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain(mode === "error" ? "original done error" : "timed out");
      if (enabled) {
        const result = collectPerformanceReports(reports, "run", "root", child.pid);
        if (mode === "error") expect(result.totals["test.total"]?.errors).toBe(1);
        else expect(result.complete).toBe(false);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
