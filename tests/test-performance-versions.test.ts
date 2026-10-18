import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { compareTestVersions, externalWallClock, versionComparisonOptions } from "../scripts/compare-test-versions";
import { MEASUREMENT_FILES, performanceSource } from "../scripts/test-performance-source";

function checkouts(candidateTest?: string) {
  const directory = mkdtempSync(join(tmpdir(), "cgw-versions-"));
  const A = join(directory, "A"), B = join(directory, "B"), output = join(directory, "output");
  for (const [version, cwd] of [["A", A], ["B", B]] as const) {
    mkdirSync(cwd);
    for (const args of [["init", "-q"], ["-c", "user.name=Performance Test", "-c", "user.email=performance@example.invalid", "commit", "-q", "--allow-empty", "-m", "test fixture"]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    }
    for (const file of MEASUREMENT_FILES) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), "export {};\n");
    }
    mkdirSync(join(cwd, "launcher"), { recursive: true });
    writeFileSync(join(cwd, "bun.lock"), "fixed root dependencies\n");
    writeFileSync(join(cwd, "launcher/bun.lock"), "fixed launcher dependencies\n");
    writeFileSync(join(cwd, "tests/equivalent.test.ts"), version === "B" && candidateTest ? candidateTest :
      `import { test, expect } from "bun:test";\ntest("${version} scenario", () => expect(1 + 1).toBe(2));\n`);
    writeFileSync(join(cwd, "tests/second.test.ts"), 'import { test, expect } from "bun:test"; test("second scenario", () => expect(true).toBe(true));\n');
  }
  const files = ["./tests/equivalent.test.ts", "./tests/second.test.ts"];
  const mapPath = join(directory, "coverage.json");
  const map = { version: 1, sources: { A: performanceSource(A), B: performanceSource(B) }, files: { A: files, B: files },
    expectedCounts: { A: { pass: 2, skip: 0 }, B: { pass: 2, skip: 0 } },
    scenarios: [{ id: "equivalent behavior", A: ["equivalent.test.ts: A scenario"], B: ["equivalent.test.ts: B scenario"] },
      { id: "second behavior", A: ["second.test.ts: second scenario"], B: ["second.test.ts: second scenario"] }] };
  const saveMap = () => writeFileSync(mapPath, JSON.stringify(map));
  saveMap();
  return { directory, A, B, output, files, map, mapPath, saveMap,
    args: [`--baseline=${A}`, `--candidate=${B}`], clean: () => rmSync(directory, { recursive: true, force: true }) };
}

test("cross-version wall clocks require explicit coverage bound to source and scope", async () => {
  const fixture = checkouts();
  try {
    const missing = await compareTestVersions([...fixture.args, "--wall-clock"], fixture.output);
    expect(missing.report.reasons).toContain("missing-coverage-map");
    expect(missing.report.runs).toHaveLength(0);
    fixture.map.sources.B.patchDigest = "0".repeat(64); fixture.saveMap();
    const mismatch = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(mismatch.report.reasons).toContain("coverage-source-mismatch-B");
    fixture.map.sources.B = performanceSource(fixture.B); fixture.saveMap();
    const scope = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`, "./tests/another.test.ts"], fixture.output);
    expect(scope.report.reasons).toContain("coverage-scope-mismatch-A");
  } finally { fixture.clean(); }
});

test("coverage maps require finite reviewed pass and skip counts for each source", async () => {
  const fixture = checkouts();
  try {
    for (const counts of [null, { pass: 0, skip: 0 }, { pass: 2, skip: -1 }, { pass: 2.5, skip: 0 }, { pass: 2, skip: Infinity }]) {
      writeFileSync(fixture.mapPath, JSON.stringify({ ...fixture.map, expectedCounts: { A: fixture.map.expectedCounts.A, B: counts } }));
      const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
      expect(result.report.reasons).toContain("invalid-expected-counts-B");
      expect(result.report.runs).toHaveLength(0);
    }
  } finally { fixture.clean(); }
});

test("external driver runs AB BA AB with different fixture tools and equivalent split scenarios", async () => {
  const fixture = checkouts('import { test, expect } from "bun:test"; test("B split one", () => expect(1).toBe(1)); test("B split two", () => expect(2).toBe(2));\n');
  try {
    writeFileSync(join(fixture.B, "tests/helpers/session-continuity-fixture.ts"), "// candidate fixture implementation\n");
    fixture.map.sources.B = performanceSource(fixture.B);
    fixture.map.scenarios[0]!.B = ["equivalent.test.ts: B split one", "equivalent.test.ts: B split two"];
    fixture.map.expectedCounts.B.pass = 3;
    fixture.saveMap();
    const full = await compareTestVersions(fixture.args, fixture.output);
    expect(full.report.reasons).toContain("different-measurement-tools");
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(0);
    expect(result.report.order).toEqual(["A", "B", "B", "A", "A", "B"]);
    expect(result.report.runs.map(run => run.pair)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(result.report.runs.filter(run => run.version === "A").every(run => (run.counts as any).pass === 2)).toBe(true);
    expect(result.report.runs.filter(run => run.version === "B").every(run => (run.counts as any).pass === 3)).toBe(true);
    expect(result.report.differences.business.map(change => change.file)).toContain("tests/helpers/session-continuity-fixture.ts");
    expect(result.report.groups.every(group => group.wallMs.length === 3 && group.medianWallMs! > 0 && group.rangeWallMs!.min > 0)).toBe(true);
    for (const run of result.report.runs) {
      const raw = JSON.parse(readFileSync(join(dirname(result.reportPath), run.summary!), "utf8"));
      expect(raw.command).toEqual([process.execPath, "test", "--timeout", "30000", "--parallel=2", "--isolate", ...fixture.files]);
      expect(raw.collection.status).toBe("not-requested");
    }
  } finally { fixture.clean(); }
});

test("wall clocks reject candidate skips outside the reviewed coverage counts", async () => {
  const fixture = checkouts('import { test } from "bun:test"; test.skip("B omitted scenario", () => {});\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").every(run => run.invalidReasons.includes("unexpected-test-coverage-counts"))).toBe(true);
  } finally { fixture.clean(); }
});

test("wall clocks reject coverage changes between repeated runs of one version", async () => {
  const fixture = checkouts(`import { test } from "bun:test";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const marker = "../candidate-run-count.txt";
    const count = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    writeFileSync(marker, String(count + 1));
    test("B scenario", () => {});
    if (count === 0) test("B intermittent scenario", () => {});
  `);
  try {
    fixture.map.expectedCounts.B.pass = 3; fixture.saveMap();
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("unstable-test-coverage-counts-B");
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").map(run => (run.counts as any).pass)).toEqual([3, 2, 2]);
  } finally { fixture.clean(); }
});

test("external wall clocks reject source changes during execution", async () => {
  const fixture = checkouts('import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("changes source", () => writeFileSync("changed-source.txt", "modified during test"));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("changed-source-B");
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.some(run => run.error === "changed-source-B" && run.summary !== null)).toBe(true);
  } finally { fixture.clean(); }
});

test("a removed coverage map invalidates the result and preserves every measured sample", async () => {
  const fixture = checkouts('import { test } from "bun:test"; import { rmSync } from "node:fs"; test("removes coverage", () => rmSync("../coverage.json", { force: true }));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.reasons).toContain("changed-coverage-map");
    expect(result.report.runs).toHaveLength(6);
    expect(result.report.runs.every(run => run.summary !== null)).toBe(true);
    expect(JSON.parse(readFileSync(result.reportPath, "utf8")).runs).toHaveLength(6);
  } finally { fixture.clean(); }
});

test("external wall clocks preserve nonzero results and reject success-path speedups", async () => {
  const fixture = checkouts('import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));\n');
  try {
    const result = await compareTestVersions([...fixture.args, "--wall-clock", `--coverage-map=${fixture.mapPath}`], fixture.output);
    expect(result.exitCode).toBe(1);
    expect(result.report.speedup).toBeNull();
    expect(result.report.runs.filter(run => run.version === "B").every(run => run.exitCode !== 0 && run.invalidReasons.includes("tests-did-not-succeed") && run.summary !== null)).toBe(true);
    expect(result.report.conclusion).toBe("invalid");
  } finally { fixture.clean(); }
});

test("a broken wall-clock log destination still drains large child output and preserves its exit", async () => {
  const fixture = checkouts();
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), `import { test } from "bun:test";
      import { writeSync } from "node:fs";
      test("large output", () => { const chunk = Buffer.alloc(4096, 120); for (let i = 0; i < 1024; i++) writeSync(1, chunk); });
    `);
    mkdirSync(fixture.output, { recursive: true });
    mkdirSync(join(fixture.output, "stdout.log"));
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 2, skip: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.valid).toBe(false);
    expect(result.invalidReasons).toContain("log-write-failed:stdout.log");
    expect(result.counts).toEqual({ pass: 2, skip: 0, fail: 0 });
    expect(JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8")).exitCode).toBe(0);
  } finally { fixture.clean(); }
});

test("wall-clock test roots and their children receive no timing credentials or controls", async () => {
  const fixture = checkouts();
  const variables = { CGW_TEST_TIMING_TOKEN: "synthetic-test-token", CGW_TEST_TIMING_RESTORE: "1",
    CGW_TEST_TIMING_ARTIFACT_DIR: "/synthetic/artifacts", CGW_TEST_TIMING_HISTORY: "/synthetic/history.json" };
  const previous = new Map(Object.keys(variables).map(key => [key, process.env[key]]));
  try {
    writeFileSync(join(fixture.A, "tests/equivalent.test.ts"), `import { test, expect } from "bun:test";
      test("root environment", () => {
        expect(Object.keys(process.env).filter(key => key.startsWith("CGW_TEST_TIMING_"))).toEqual([]);
        console.log("root timing environment clean");
      });
      test("spawned child environment", () => {
        const child = Bun.spawnSync([process.execPath, "-e", 'const keys = Object.keys(process.env).filter(key => key.startsWith("CGW_TEST_TIMING_")); console.log(JSON.stringify(keys)); process.exit(keys.length ? 23 : 0)'], { stdout: "pipe", stderr: "pipe" });
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(child.stdout.toString())).toEqual([]);
        console.log("child timing environment clean");
      });
    `);
    mkdirSync(fixture.output, { recursive: true });
    for (const [key, value] of Object.entries(variables)) process.env[key] = value;
    const result = await externalWallClock(fixture.A, fixture.output, fixture.files, { pass: 3, skip: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.valid).toBe(true);
    expect(result.counts).toEqual({ pass: 3, skip: 0, fail: 0 });
    const stdout = readFileSync(join(fixture.output, "stdout.log"), "utf8"), stderr = readFileSync(join(fixture.output, "stderr.log"), "utf8");
    expect(stdout + stderr).toContain("root timing environment clean");
    expect(stdout + stderr).toContain("child timing environment clean");
    expect(stderr).toContain("3 pass");
    expect(JSON.parse(readFileSync(join(fixture.output, "wall-clock.json"), "utf8")).exitCode).toBe(0);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fixture.clean();
  }
});

test("version options keep wall-clock coverage opt-in", () => {
  expect(() => versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--coverage-map=/tmp/map"])).toThrow();
  expect(versionComparisonOptions(["--baseline=/tmp/A", "--candidate=/tmp/B", "--wall-clock"]).wallClock).toBe(true);
});
