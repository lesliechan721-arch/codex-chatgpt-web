import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForChildReady } from "./helpers/child-readiness";

for (const exitsEarly of [false, true]) {
  test(`child readiness reports failure and settles the child (early exit=${exitsEarly})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cgw-ready-"));
    const child = Bun.spawn([process.execPath, "-e", `
      process.stderr.write('startup diagnostic');
      process.stdout.write('started');
      ${exitsEarly ? "process.exit(7);" : "setInterval(() => {}, 1000);"}
    `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      // Separate cold startup from the intentionally short readiness deadline.
      const reader = child.stdout.getReader();
      try { expect((await reader.read()).done).toBe(false); }
      finally { reader.releaseLock(); }
      const error = await waitForChildReady(child, join(directory, "ready.json"), 1_000)
        .then(() => undefined, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(exitsEarly ? "exit=7" : "readiness deadline exceeded");
      expect(error.message).toContain("startup diagnostic");
      if (exitsEarly) expect(child.exitCode).toBe(7);
      else expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
