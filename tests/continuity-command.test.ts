import { $ } from "bun";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harmlessContinuityCommand } from "./helpers/continuity-command";

test("the real continuity command preserves quoted paths and exact output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-command-"));
  const counter = join(directory, "count with spaces ' $ ( )");
  const output = "Accepted result with 'quotes', $variables, and \\backslashes.\n";
  try {
    const command = harmlessContinuityCommand(counter, output);
    const result = await $`${{ raw: command }}`.quiet().nothrow();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe(output);
    expect(readFileSync(counter, "utf8")).toBe("x");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
