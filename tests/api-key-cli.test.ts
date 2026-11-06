import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { apiKeyMatches, apiKeyPolicy } from "../src/api-access";
import { loadApiAccessPolicy, openAiRoutingPendingPath, saveApiAccessPolicy } from "../src/api-access-config";
import { defaultConfig } from "../src/config";
import { expectTestChildExit } from "../scripts/test-performance-children";

type CliDiagnostic = { scenario: string; command: string; durationMs: number; exitCode: number | null };
const homeDiagnostics = new Map<string, { scenario: string; launches: CliDiagnostic[] }>();

function recordCliExit(home: string, command: string, started: number, exitCode: number | null): void {
  const diagnostics = homeDiagnostics.get(home);
  diagnostics?.launches.push({ scenario: diagnostics.scenario, command, durationMs: performance.now() - started, exitCode });
}

function cleanupHome(home: string): void {
  let cleanup = "failed";
  try {
    rmSync(home, { recursive: true, force: true });
    cleanup = existsSync(home) ? "failed" : "removed";
  } finally {
    const diagnostics = homeDiagnostics.get(home);
    homeDiagnostics.delete(home);
    if (process.env.CGW_API_KEY_CLI_DIAGNOSTICS === "1") {
      for (const launch of diagnostics?.launches ?? []) {
        process.stderr.write(`[api-key-cli] ${JSON.stringify({ ...launch, cleanup })}\n`);
      }
    }
  }
}

function withHome(scenario: string, run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "cgw-api-key-cli-"));
  homeDiagnostics.set(home, { scenario, launches: [] });
  try { run(home); } finally { cleanupHome(home); }
}
function cli(home: string, args: string[], input?: string, environment: Record<string, string | undefined> = {}) {
  const started = performance.now();
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../src/cli.ts"),
    "--home", home, "api-key", ...args], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, "codex"), ...environment },
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe", stderr: "pipe",
  });
  recordCliExit(home, args[0]!, started, result.exitCode);
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
function rejectedCli(home: string, args: string[], input?: string, environment: Record<string, string | undefined> = {}) {
  return expectTestChildExit([1], () => cli(home, args, input, environment));
}
function spawnCli(home: string, args: string[], environment: Record<string, string | undefined> = {}) {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"),
    "--home", home, "api-key", ...args], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, "codex"), ...environment },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  void child.exited.then(code => recordCliExit(home, args[0]!, started, code));
  return child;
}
async function spawnedCliResult(process: ReturnType<typeof spawnCli>) {
  const code = await process.exited;
  return {
    code,
    out: await new Response(process.stdout).text(),
    err: await new Response(process.stderr).text(),
  };
}

// Four CLI startups share this timeout; allow for slower Windows CI runners.
test("CLI generates once, reports redacted status, rotates and explicitly disables", () => withHome("generate, status, rotate, disable", home => {
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
}), 15_000);

test("CLI stdin import never echoes or persists the plaintext key", () => withHome("stdin import", home => {
  const key = "test_imported_key_" + "k".repeat(32);
  const imported = cli(home, ["enable", "--key-stdin"], `${key}\r\n`);
  assert.equal(imported.code, 0, imported.err);
  assert.equal(imported.out, "");
  assert.ok(!imported.err.includes(key));
  assert.deepEqual(loadApiAccessPolicy(home), apiKeyPolicy(key));
  assert.ok(!readFileSync(join(home, "api-access.json"), "utf8").includes(key));
}), 15_000);

test("CLI rejects mutually exclusive generation and stdin options", () => withHome("ambiguous options", home => {
  const rejected = rejectedCli(home, ["rotate", "--generate", "--key-stdin"]);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.out, "");
  assert.match(rejected.err, /requires exactly one of --generate or --key-stdin/);
  assert.equal(existsSync(join(home, "api-access.json")), false);
}), 15_000);

test("CLI rejects enable when a key is already configured", () => withHome("already configured", home => {
  const policy = apiKeyPolicy("existing_key_" + "k".repeat(32));
  saveApiAccessPolicy(policy, home);
  const rejected = rejectedCli(home, ["enable", "--generate"]);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.out, "");
  assert.match(rejected.err, /already configured; use rotate/);
  assert.deepEqual(loadApiAccessPolicy(home), policy);
}), 15_000);

test("CLI rejects short stdin keys without echoing or replacing the current key", () => withHome("short stdin key", home => {
  const policy = apiKeyPolicy("existing_key_" + "k".repeat(32));
  saveApiAccessPolicy(policy, home);
  const rejected = rejectedCli(home, ["rotate", "--key-stdin"], "short-secret\n");
  assert.equal(rejected.code, 1);
  assert.equal(rejected.out, "");
  assert.match(rejected.err, /API key must contain 32–256/);
  assert.ok(!rejected.err.includes("short-secret"));
  assert.deepEqual(loadApiAccessPolicy(home), policy);
}), 15_000);

test("CLI fails closed for damaged policy; only explicit disable recovers", () => withHome("damaged policy recovery", home => {
  writeFileSync(join(home, "api-access.json"), "{");
  const status = rejectedCli(home, ["status"]);
  assert.equal(status.code, 1);
  assert.match(status.err, /Invalid API access JSON/);
  const enabled = rejectedCli(home, ["enable", "--generate"]);
  assert.equal(enabled.code, 1);
  assert.match(enabled.err, /Invalid API access JSON/);
  assert.equal(readFileSync(join(home, "api-access.json"), "utf8"), "{");
  assert.equal(cli(home, ["disable"]).code, 0);
  assert.equal(loadApiAccessPolicy(home).mode, "openai");
}), 15_000);

test("successful CLI reconnect clears the persisted OpenAI routing warning", () => withHome("reconnect clears warning", home => {
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = openAiRoutingPendingPath(home);
  writeFileSync(pending, '{"version":1}\n');
  const result = cli(home, ["reconnect"]);
  assert.equal(result.code, 0, result.err);
  assert.equal(existsSync(pending), false);
}));

test("CLI Codex export requires the current local key and emits sensitive TOML plus separate proxy environment", () => withHome("local Codex export", home => {
  const localKey = "cgw_" + "q".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  const config = { ...defaultConfig("browser-only"), runtimeCommand: [process.execPath, "retired-release-entry.js"] };
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  const missing = rejectedCli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: undefined });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /must contain the current local API key before export/);
  assert.ok(!missing.err.includes(localKey));
  const wrong = "cgw_" + "z".repeat(43);
  const mismatched = rejectedCli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: wrong });
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.err, /must contain the current local API key before export/);
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
  assert.equal((Bun.TOML.parse(payload.config) as { features: { instant_interrupt: boolean } }).features.instant_interrupt, false);
  assert.ok(!payload.config.includes("env_key ="));
  const hook = (Bun.TOML.parse(payload.config) as any).hooks.Interrupt[0].hooks[0];
  const script = join(home, "hooks", process.platform === "win32" ? "interrupt.cmd" : "interrupt.sh");
  assert.ok(hook.command.includes(script));
  assert.ok(existsSync(script));
  assert.ok(!readFileSync(script, "utf8").includes("retired-release-entry.js"));
  assert.ok(readFileSync(script, "utf8").includes("cli.ts"));
  assert.deepEqual(Object.keys(payload).sort(), ["baseUrl", "config", "environment"]);
  const parsed = Bun.TOML.parse(payload.config) as any;
  assert.equal(parsed.model_catalog_json, undefined);
  assert.equal(parsed.model_providers.chatgpt_web.model_catalog_url, `${payload.baseUrl}/models`);
  assert.equal(existsSync(join(home, "api-key-models.json")), false);
  assert.equal(existsSync(join(home, "api-key-models-refresh-pending.json")), false);
  assert.equal(payload.environment.HTTP_PROXY, "http://proxy.example:8080");
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.ok(payload.environment.NO_PROXY.includes(host));
}), 15_000);

test("CLI Codex export supports an external HTTPS client without server-local paths or Interrupt hook", () => withHome("external HTTPS Codex export", home => {
  const localKey = "cgw_" + "r".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const exported = cli(home, ["codex-config", "--json"], undefined, {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/service/v1/",
  });
  assert.equal(exported.code, 0, exported.err);
  const payload = JSON.parse(exported.out);
  assert.equal(payload.baseUrl, "https://server.example.com/service/v1");
  assert.ok(payload.config.includes('base_url = "https://server.example.com/service/v1"'));
  const parsed = Bun.TOML.parse(payload.config) as any;
  assert.equal(parsed.model_providers.chatgpt_web.model_catalog_url, "https://server.example.com/service/v1/models");
  assert.equal(parsed.model_catalog_json, undefined);
  assert.deepEqual(Object.keys(payload).sort(), ["baseUrl", "config", "environment"]);
  assert.equal((Bun.TOML.parse(payload.config) as { features: { instant_interrupt: boolean } }).features.instant_interrupt, false);
  assert.ok(!payload.config.includes("[[hooks.Interrupt]]"));
  assert.ok(!payload.config.includes(home));
  assert.equal(existsSync(join(home, "api-key-models.json")), false);
}));

test("CLI Codex export uses the host-mapped Responses port when public Base URL is empty", () => withHome("host-mapped Codex export", home => {
  const localKey = "cgw_" + "h".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const exported = cli(home, ["codex-config", "--json"], undefined, {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "",
    CODEX_CHATGPT_WEB_CLIENT_PORT: "27841",
  });
  assert.equal(exported.code, 0, exported.err);
  const payload = JSON.parse(exported.out);
  assert.equal(payload.baseUrl, "http://127.0.0.1:27841/v1");
  assert.ok(payload.config.includes('base_url = "http://127.0.0.1:27841/v1"'));
  assert.ok(payload.config.includes('model_catalog_url = "http://127.0.0.1:27841/v1/models"'));
}));

test("CLI Codex export uses saved server-compaction intent for provider naming without exporting the upstream key", () => withHome("server compaction Codex export", home => {
  const localKey = "cgw_" + "m".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  const config = defaultConfig("browser-only");
  config.port = 65534;
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify({
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: "a".repeat(64),
    proxy: { mode: "global" },
    models: [],
    supportsOpenAiServerCompaction: true,
  })}\n`);
  const exported = cli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.equal(exported.code, 0, exported.err);
  const text = JSON.parse(exported.out).config;
  assert.ok(text.includes('name = "OpenAI"'));
  assert.ok(text.includes(localKey));
  assert.ok(!text.includes("a".repeat(64)));
}));

test("CLI rejects the removed refresh-models command", () => withHome("removed refresh command", home => {
  const rejected = rejectedCli(home, ["refresh-models"]);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.out, "");
  assert.match(rejected.err, /API key command must be/);
  assert.equal(existsSync(join(home, "api-key-models.json")), false);
}));

test("CLI Codex export makes no service requests with an upstream provider configured", async () => {
  const home = mkdtempSync(join(tmpdir(), "cgw-api-key-cli-offline-"));
  homeDiagnostics.set(home, { scenario: "export without catalog requests", launches: [] });
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return new Response("service unavailable", { status: 503 });
  } });
  try {
    const localKey = "cgw_" + "o".repeat(43);
    writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
    writeFileSync(join(home, "config.json"), `${JSON.stringify({ ...defaultConfig("browser-only"), port: server.port! })}\n`);
    writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify({
      version: 2,
      baseUrl: "https://provider.invalid/v1/",
      apiKeySha256: "b".repeat(64),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-upstream" }],
      supportsOpenAiServerCompaction: false,
    })}\n`);
    const exported = await spawnedCliResult(spawnCli(home, ["codex-config", "--json"], {
      CODEX_CHATGPT_WEB_API_KEY: localKey,
      CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: undefined,
      CODEX_CHATGPT_WEB_CLIENT_PORT: undefined,
    }));
    assert.equal(exported.code, 0, exported.err);
    assert.equal(requests, 0);
    assert.deepEqual(Object.keys(JSON.parse(exported.out)).sort(), ["baseUrl", "config", "environment"]);
    assert.equal(existsSync(join(home, "api-key-models.json")), false);
    assert.equal(existsSync(join(home, "api-key-models-refresh-pending.json")), false);
    assert.ok(!exported.err.includes(localKey));
  } finally {
    await server.stop(true);
    cleanupHome(home);
  }
});
