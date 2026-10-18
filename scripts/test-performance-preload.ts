import { afterAll, beforeAll } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Parallel workers discard each file's global. Flush before that happens; exit
// also covers child processes that do not load the test runner or this preload.
const directory = process.env.CGW_RUNTIME_PERFORMANCE_DIR;
const parentId = process.env.CGW_PERFORMANCE_ROOT_PROCESS_ID ?? process.env.CGW_PERFORMANCE_PROCESS_ID;
const worker = process.env.BUN_TEST_WORKER_ID;
const workerId = parentId && worker ? `${parentId}:worker:${process.pid}` : undefined;
// Module initialization writes the first snapshot, so assign its identity first.
if (workerId) process.env.CGW_PERFORMANCE_PROCESS_ID = workerId;
const { flushRuntimePerformance, runtimePerformanceSnapshotId, markRuntimePerformanceIncomplete } = await import("../src/runtime-performance");
const { trackTestChildren } = await import("./test-performance-children");
const snapshotId = runtimePerformanceSnapshotId();
const processId = workerId ?? process.env.CGW_PERFORMANCE_PROCESS_ID;
const saveGlobal = (complete: boolean) => {
  if (!directory || !snapshotId) return;
  try { writeFileSync(join(directory, `${snapshotId}.global.json`), JSON.stringify({
    version: 3, kind: "global", runId: process.env.CGW_PERFORMANCE_RUN_ID,
    snapshotId, processId, pid: process.pid, complete,
  })); } catch { markRuntimePerformanceIncomplete("global-ledger-write-failed"); }
};
const saveWorker = (complete: boolean) => {
  if (!directory || !workerId) return;
  try { writeFileSync(join(directory, `${workerId.replaceAll(":", "-")}.child.json`), JSON.stringify({
    version: 3, kind: "worker", runId: process.env.CGW_PERFORMANCE_RUN_ID, id: workerId, parentId,
    pid: process.pid, workerId: worker, complete, expectsReport: true,
  })); } catch { markRuntimePerformanceIncomplete("worker-ledger-write-failed"); }
};
saveGlobal(false);
saveWorker(false);
trackTestChildren();
// In --no-isolate mode these hooks wrap each file in the same global.
beforeAll(() => { saveGlobal(false); saveWorker(false); });
afterAll(() => { flushRuntimePerformance(true, "afterAll"); saveGlobal(true); saveWorker(true); });
