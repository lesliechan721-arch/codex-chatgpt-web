import { expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";

/** Rule tests must never cross a Git, Node, Bun, or shell process boundary. */
export function processFreeTest(name: string, run: () => unknown | Promise<unknown>) {
  test(name, async () => {
    const attempts: string[] = [];
    const reject = (method: string) => (..._args: any[]): never => {
      attempts.push(method);
      throw new Error(`Rule test started an external process through ${method}.`);
    };
    const guards = [
      spyOn(Bun, "spawn").mockImplementation(reject("Bun.spawn") as any),
      spyOn(Bun, "spawnSync").mockImplementation(reject("Bun.spawnSync") as any),
      ...(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
        .map(method => spyOn(childProcess, method).mockImplementation(reject(`child_process.${method}`) as any)),
    ];
    try {
      await run();
      expect(attempts).toEqual([]);
    } finally {
      for (const guard of guards) guard.mockRestore();
      if (process.env.CGW_PERFORMANCE_RULE_LOG) appendFileSync(process.env.CGW_PERFORMANCE_RULE_LOG,
        JSON.stringify({ name, externalProcessCalls: attempts.length }) + "\n");
    }
  });
}
