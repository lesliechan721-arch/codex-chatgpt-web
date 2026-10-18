import { expect, test } from "bun:test";
import { diagnosticEnvironment, diagnosticOptions } from "../scripts/diagnose-test-performance";

test("diagnostics preserve defaults and select reproducible file and condition scopes", () => {
  const defaults = diagnosticOptions([]);
  expect(defaults.history).toBe("cold");
  expect(defaults.conditions).toHaveLength(6);
  expect(defaults.files).toEqual(["./tests/continuity-task-update.test.ts", "./tests/session-continuity-compaction.test.ts"]);
  const selected = diagnosticOptions(["--suite=continuity-adapter", "--condition=isolated-full-2", "--repetitions=3", "--test-name-pattern=^A[89] "]);
  expect(selected.files).toEqual(["./tests/continuity-task-update.test.ts", "./tests/session-continuity-adapter.test.ts"]);
  expect(selected.conditions).toEqual([{ name: "isolated-full-2", workers: 2, mode: "full", isolation: "isolate" }]);
  expect(selected.pattern).toBe("^A[89] ");
  expect(diagnosticOptions(["--suite=continuity-task"]).files).toEqual(["./tests/continuity-task-update.test.ts"]);
  expect(diagnosticOptions(["--suite=continuity-source", "--repetitions=10"]).repetitions).toBe(10);
  for (const args of [["--condition=unknown"], ["--history=local"], ["--test-name-pattern=["], ["--suite=all", "--repetitions=10"]]) {
    expect(() => diagnosticOptions(args)).toThrow();
  }
});

test("cross-run history requires explicit full-suite scope and one condition", () => {
  const args = ["--suite=all", "--condition=original-2", "--repetitions=1", "--history=restore"];
  expect(diagnosticOptions(args)).toMatchObject({ files: ["./tests"], history: "restore", pattern: "" });
  for (const extra of ["--suite=cli", "--condition=all", "--test-name-pattern=source"]) {
    expect(() => diagnosticOptions([...args, extra])).toThrow();
  }
});

test("diagnostic timing controls are opt-in and cannot inherit a local history override", () => {
  const env = { CGW_TEST_TIMING_TOKEN: "test-only-token", CGW_TEST_TIMING_RESTORE: "1",
    CGW_TEST_TIMING_HISTORY: "/old/history.json", CGW_TEST_TIMING_ARTIFACT_DIR: "/output/artifact",
    CGW_RUNTIME_PERFORMANCE_DIR: "/old/reports", CGW_PERFORMANCE_RUN_ID: "old-run" };
  const cold = diagnosticEnvironment(env, "cold", "/new/reports");
  expect(cold.CGW_TEST_TIMING_TOKEN).toBeUndefined();
  expect(cold.CGW_TEST_TIMING_RESTORE).toBeUndefined();
  expect(cold.CGW_TEST_TIMING_HISTORY).toBeUndefined();
  expect(cold.CGW_RUNTIME_PERFORMANCE_DIR).toBeUndefined();
  expect(cold.CGW_PERFORMANCE_RUN_ID).toBeUndefined();
  const restored = diagnosticEnvironment(env, "restore", "/new/reports");
  expect(restored.CGW_TEST_TIMING_RESTORE).toBe("1");
  expect(restored.CGW_TEST_TIMING_TOKEN).toBe("test-only-token");
  expect(restored.CGW_TEST_TIMING_HISTORY).toBeUndefined();
  expect(restored.CGW_TEST_TIMING_ARTIFACT_DIR).toBe("/output/artifact");
  expect(restored.CGW_TEST_PROFILE_DIR).toBe("/new/reports");
  expect(env.CGW_TEST_TIMING_HISTORY).toBe("/old/history.json");
});
