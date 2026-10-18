import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePerformanceContext, runtimePerformanceSnapshotId, measureRuntimeOperation, markRuntimePerformanceIncomplete, flushRuntimePerformance } from "../src/runtime-performance";

let installed = false;
let expectedExitCodes: readonly number[] = [];

/** Declare only the children started by this synchronous call; assertions still check their results. */
export function expectTestChildExit<T>(exitCodes: readonly number[], run: () => T): T {
  if (!Array.isArray(exitCodes) || exitCodes.length === 0
    || exitCodes.some(code => !Number.isSafeInteger(code) || code <= 0)
    || new Set(exitCodes).size !== exitCodes.length) throw new Error("Expected child exits must be a nonempty list of distinct positive integers.");
  const previous = expectedExitCodes;
  expectedExitCodes = [...exitCodes];
  try { return run(); }
  finally { expectedExitCodes = previous; }
}

/** Only the explicit profiler enables tracking; commands, bodies and native process identities stay private. */
export function trackTestChildren(): void {
  const directory = process.env.CGW_RUNTIME_PERFORMANCE_DIR;
  if (!directory || installed) return;
  installed = true;
  for (const method of ["spawn", "spawnSync"] as const) {
    const original = Bun[method].bind(Bun) as (...args: any[]) => any;
    (Bun as any)[method] = (...args: any[]) => {
      const objectForm = !Array.isArray(args[0]);
      const options = { ...(objectForm ? args[0] : args[1] ?? {}) };
      const command: string[] = [...(objectForm ? options.cmd : args[0])];
      const id = randomUUID();
      const isRuntime = command[0] === process.execPath;
      const isolatedDiagnostics = options.env?.CGW_RUNTIME_PERFORMANCE_DIR !== undefined && options.env.CGW_RUNTIME_PERFORMANCE_DIR !== directory;
      const expectsReport = isRuntime && !isolatedDiagnostics && !command.slice(1).some(arg => ["--version", "-v", "--help", "-h"].includes(arg));
      const preload = join(import.meta.dir, command[1] === "test" ? "test-performance-preload.ts" : "runtime-performance-preload.ts");
      // Keep explicit subcommands first. A leading --preload makes `bun test`
      // resolve the package's `test` script and adds an observable child process.
      if (expectsReport) command.splice(["test", "run"].includes(command[1] ?? "") ? 2 : 1, 0, "--preload", preload);
      if (!isolatedDiagnostics) options.env = { ...(options.env ?? process.env), CGW_RUNTIME_PERFORMANCE_DIR: directory,
        CGW_PERFORMANCE_RUN_ID: process.env.CGW_PERFORMANCE_RUN_ID,
        CGW_PERFORMANCE_PROCESS_ID: id,
        CGW_PERFORMANCE_ROOT_PROCESS_ID: id,
        CGW_PERFORMANCE_CONTEXT: JSON.stringify(runtimePerformanceContext()) };
      // A native child is a new process, including a separately profiled diagnostic fixture.
      if (isRuntime) delete options.env.BUN_TEST_WORKER_ID;
      const record = { version: 3, kind: "child", runId: process.env.CGW_PERFORMANCE_RUN_ID ?? null,
        id, parentId: process.env.CGW_PERFORMANCE_PROCESS_ID ?? null, pid: null as number | null,
        parentSnapshotId: runtimePerformanceSnapshotId(), expectedExitCodes: [...expectedExitCodes],
        context: runtimePerformanceContext(), expectsReport, isolatedDiagnostics, status: "starting", exitCode: null as number | null,
        spawnErrorCode: null as string | null,
        signal: null as string | number | null };
      const save = () => {
        try { writeFileSync(join(directory, `${id}.child.json`), JSON.stringify(record)); }
        catch { markRuntimePerformanceIncomplete("child-ledger-write-failed"); }
      };
      save();
      try {
        if (objectForm) options.cmd = command;
        const child = measureRuntimeOperation("process.start", () => original(...(objectForm ? [options] : [command, options])));
        // A later signal must not leave a ledger whose matching counter was never saved.
        flushRuntimePerformance();
        record.pid = child.pid;
        if (method === "spawnSync") {
          record.status = "exited"; record.exitCode = child.exitCode; record.signal = child.signalCode ?? null; save();
        } else {
          record.status = "running"; save();
          void child.exited.then((exitCode: number) => {
            record.status = "exited"; record.exitCode = exitCode; record.signal = child.signalCode ?? null; save();
          }, () => { record.status = "unknown"; save(); });
        }
        return child;
      } catch (error) {
        record.status = "spawn-failed";
        const code = (error as { code?: unknown })?.code;
        record.spawnErrorCode = typeof code === "string" ? code : null;
        save(); flushRuntimePerformance(); throw error;
      }
    };
  }
}
