import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { apiKeyMatches, apiKeyPolicy } from "../src/api-access";
import { loadApiAccessPolicy, openAiRoutingPendingPath } from "../src/api-access-config";
import { defaultConfig } from "../src/config";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cgw-api-key-cli-"));
  try { run(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function cli(home: string, args: string[], input?: string, environment: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/cli.ts"),
    "--home", home, "api-key", ...args], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, "codex"), ...environment },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("CLI generates once, reports redacted status, rotates and explicitly disables", () => withHome(home => {
  const enabled = cli(home, ["enable", "--generate"]);
  assert.equal(enabled.code, 0, enabled.err);
  const first = enabled.out.trim();
  assert.match(first, /^cgw_[A-Za-z0-9_-]{43}$/);
  assert.ok(!enabled.err.includes(first));
  const status = cli(home, ["status"]);
  assert.equal(status.code, 0, status.err);
  assert.equal(JSON.parse(status.out).configured_mode, "api-key");
  assert.ok(!status.out.includes(first));
  assert.ok(!status.out.includes("keySha256"));
  assert.ok(!readFileSync(join(home, "api-access.json"), "utf8").includes(first));
  const next = cli(home, ["rotate", "--generate"]);
  assert.equal(next.code, 0, next.err);
  assert.ok(!apiKeyMatches(first, loadApiAccessPolicy(home)));
  assert.ok(apiKeyMatches(next.out.trim(), loadApiAccessPolicy(home)));
  const disabled = cli(home, ["disable"]);
  assert.equal(disabled.code, 0, disabled.err);
  assert.equal(loadApiAccessPolicy(home).mode, "openai");
}));

test("CLI stdin import never echoes the key and rejects ambiguous options", () => withHome(home => {
  const key = "test_imported_key_" + "k".repeat(32);
  const imported = cli(home, ["enable", "--key-stdin"], `${key}\r\n`);
  assert.equal(imported.code, 0, imported.err);
  assert.equal(imported.out, "");
  assert.ok(!imported.err.includes(key));
  assert.deepEqual(loadApiAccessPolicy(home), apiKeyPolicy(key));
  assert.notEqual(cli(home, ["rotate", "--generate", "--key-stdin"]).code, 0);
  assert.notEqual(cli(home, ["enable", "--generate"]).code, 0);
  const invalid = cli(home, ["rotate", "--key-stdin"], "short-secret\n");
  assert.notEqual(invalid.code, 0);
  assert.ok(!invalid.err.includes("short-secret"));
}));

test("CLI fails closed for damaged policy; only explicit disable recovers", () => withHome(home => {
  writeFileSync(join(home, "api-access.json"), "{");
  assert.notEqual(cli(home, ["status"]).code, 0);
  assert.notEqual(cli(home, ["enable", "--generate"]).code, 0);
  assert.equal(cli(home, ["disable"]).code, 0);
  assert.equal(loadApiAccessPolicy(home).mode, "openai");
}));

test("successful CLI reconnect clears the persisted OpenAI routing warning", () => withHome(home => {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = openAiRoutingPendingPath(home);
  writeFileSync(pending, '{"version":1}\n');
  const result = cli(home, ["reconnect"]);
  assert.equal(result.code, 0, result.err);
  assert.equal(existsSync(pending), false);
}));

test("CLI Codex export requires the current local key and emits sensitive TOML plus separate proxy environment", () => withHome(home => {
  const localKey = "cgw_" + "q".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const missing = cli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: undefined });
  assert.notEqual(missing.code, 0);
  assert.ok(!missing.err.includes(localKey));
  const wrong = "cgw_" + "z".repeat(43);
  const mismatched = cli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: wrong });
  assert.notEqual(mismatched.code, 0);
  assert.ok(!mismatched.err.includes(wrong));
  const exported = cli(home, ["codex-config", "--json"], undefined, {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://proxy.example:8080",
    ALL_PROXY: "http://proxy.example:8080",
    NO_PROXY: "internal.example",
  });
  assert.equal(exported.code, 0, exported.err);
  const payload = JSON.parse(exported.out);
  assert.ok(payload.config.includes(`experimental_bearer_token = "${localKey}"`));
  assert.ok(!payload.config.includes("env_key ="));
  assert.equal(payload.environment.HTTP_PROXY, "http://proxy.example:8080");
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.ok(payload.environment.NO_PROXY.includes(host));
}));

test("CLI Codex export uses saved server-compaction intent for provider naming without exporting the upstream key", () => withHome(home => {
  const localKey = "cgw_" + "m".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify({
    version: 1,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: "a".repeat(64),
    proxy: { mode: "global" },
    modelFilter: { mode: "all" },
    supportsOpenAiServerCompaction: true,
  })}\n`);
  const exported = cli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.equal(exported.code, 0, exported.err);
  const text = JSON.parse(exported.out).config;
  assert.ok(text.includes('name = "OpenAI"'));
  assert.ok(text.includes(localKey));
  assert.ok(!text.includes("a".repeat(64)));
}));
