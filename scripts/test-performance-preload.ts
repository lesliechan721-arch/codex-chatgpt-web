import { afterAll } from "bun:test";
import { flushRuntimePerformance, markRuntimePerformanceIncomplete } from "../src/runtime-performance";
import { trackTestChildren } from "./test-performance-children";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Parallel workers discard each file's global. Flush before that happens; exit
// also covers child processes that do not load the test runner or this preload.
const directory = process.env.CGW_RUNTIME_PERFORMANCE_DIR;
const parentId = process.env.CGW_PERFORMANCE_ROOT_PROCESS_ID ?? process.env.CGW_PERFORMANCE_PROCESS_ID;
const worker = process.env.BUN_TEST_WORKER_ID;
const workerId = parentId && worker ? `${parentId}:worker:${process.pid}` : undefined;
const saveWorker = (complete: boolean) => {
  if (!directory || !workerId) return;
  try { writeFileSync(join(directory, `${workerId.replaceAll(":", "-")}.child.json`), JSON.stringify({
    version: 2, kind: "worker", runId: process.env.CGW_PERFORMANCE_RUN_ID, id: workerId, parentId,
    pid: process.pid, workerId: worker, complete, expectsReport: true,
  })); } catch { markRuntimePerformanceIncomplete("worker-ledger-write-failed"); }
};
if (workerId) process.env.CGW_PERFORMANCE_PROCESS_ID = workerId;
saveWorker(false);
trackTestChildren();
afterAll(() => { flushRuntimePerformance(true); saveWorker(true); });
