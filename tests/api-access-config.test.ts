import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  apiAccessConfigPath,
  apiKeyReuseMarkerPath,
  loadApiAccessPolicy,
  saveApiAccessPolicy,
} from "../src/api-access-config";
import { OPENAI_ACCESS, apiKeyMatches, apiKeyPolicy, generateApiKey } from "../src/api-access";

function inHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cgw-api-access-"));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("absent policy alone retains the legacy mode", () => inHome(home => {
  assert.deepEqual(loadApiAccessPolicy(home), OPENAI_ACCESS);
}));

test("policy is stored atomically as private digest-only JSON", () => inHome(home => {
  const key = generateApiKey();
  const policy = apiKeyPolicy(key);
  saveApiAccessPolicy(policy, home);
  assert.deepEqual(loadApiAccessPolicy(home), policy);
  assert.ok(!readFileSync(apiAccessConfigPath(home), "utf8").includes(key));
  if (process.platform !== "win32") {
    assert.equal(statSync(apiAccessConfigPath(home)).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  }
}));

test("corrupt, oversized and unexpected policies do not fall back", () => inHome(home => {
  for (const text of ["{", "x".repeat(4097), '{"version":1,"mode":"typo"}',
    '{"version":1,"mode":"api-key"}', '{"version":1,"mode":"openai","secret":"do-not-echo"}']) {
    writeFileSync(apiAccessConfigPath(home), text);
    assert.throws(() => loadApiAccessPolicy(home), error => error instanceof Error && !error.message.includes("do-not-echo"));
  }
}));

test("unreadable directory in place of a policy fails closed", () => inHome(home => {
  mkdirSync(apiAccessConfigPath(home));
  assert.throws(() => loadApiAccessPolicy(home));
}));

test("a dangling policy symlink is not an absent configuration", () => inHome(home => {
  if (process.platform === "win32") return; // Creating symlinks can require elevated Windows privileges.
  symlinkSync(join(home, "missing.json"), apiAccessConfigPath(home));
  assert.throws(() => loadApiAccessPolicy(home));
}));

test("rotation and explicit disable are persisted without changing an existing snapshot", () => inHome(home => {
  const first = generateApiKey();
  const second = generateApiKey();
  saveApiAccessPolicy(apiKeyPolicy(first), home);
  const snapshot = loadApiAccessPolicy(home);
  saveApiAccessPolicy(apiKeyPolicy(second), home);
  assert.ok(apiKeyMatches(first, snapshot));
  assert.ok(!apiKeyMatches(first, loadApiAccessPolicy(home)));
  assert.ok(apiKeyMatches(second, loadApiAccessPolicy(home)));
  saveApiAccessPolicy(OPENAI_ACCESS, home);
  assert.deepEqual(loadApiAccessPolicy(home), OPENAI_ACCESS);
}));

test("an external policy save revokes GUI-only key reuse", () => inHome(home => {
  const marker = apiKeyReuseMarkerPath(home);
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(marker, '{"version":1,"digest":"' + "a".repeat(64) + '"}\n');
  saveApiAccessPolicy(OPENAI_ACCESS, home);
  assert.equal(existsSync(marker), false);
}));
