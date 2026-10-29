import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPTIONAL_BROWSER_ENVIRONMENTS, validOptionalBrowserRules } from "./optional-browser-tests";
import { repositoryTestFiles } from "./test-timing-history";
import { testLogResult } from "./test-shards";

/** This job supplies both runtimes and requires every selected test to execute. */
export function runOptionalBrowserTests() {
  const root = resolve(import.meta.dir, "..");
  const policy = JSON.parse(readFileSync(resolve(root, ".github/windows-test-skips.json"), "utf8"));
  const rules: unknown = policy.optionalBrowsers;
  if (!validOptionalBrowserRules(rules, repositoryTestFiles(root)) || rules.length === 0) {
    throw new Error("Missing optional browser test rules.");
  }
  for (const environment of OPTIONAL_BROWSER_ENVIRONMENTS) {
    if (!process.env[environment] || !existsSync(process.env[environment])) throw new Error(`Missing browser executable: ${environment}`);
  }
  const files = [...new Set(rules.flatMap(rule => rule.files))].sort();
  const child = Bun.spawnSync([process.execPath, "test", "--timeout", "30000", ...files.map(file => `./${file}`)], {
    cwd: root, env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  const result = testLogResult(child.stderr.toString());
  if (child.exitCode !== 0 || child.signalCode || result.counts.fail !== 0 || result.counts.skip !== 0
    || !result.counts.pass || result.reportedFiles !== files.length
    || JSON.stringify(result.executedFiles) !== JSON.stringify(files)) {
    throw new Error("Optional browser tests require successful execution of every selected file with zero skips.");
  }
}

if (import.meta.main) runOptionalBrowserTests();
