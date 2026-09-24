import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { apiAccessRevision, apiKeyMatches, apiKeyPolicy, MODEL_CATALOG_STATUS_HEADER } from "../src/api-access";
import { loadApiAccessPolicy, openAiRoutingPendingPath } from "../src/api-access-config";
import { defaultConfig } from "../src/config";
import { buildStandaloneModelCatalog } from "../src/standalone-model-catalog";
import { upstreamProviderRevision } from "../src/upstream-provider";
import modelCatalogCommandLock from "../launcher/electron/model-catalog-command-lock.cjs";

const { processStartIdentity } = modelCatalogCommandLock as {
  processStartIdentity: (pid: number) => string | null;
};

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
function spawnCli(home: string, args: string[], environment: Record<string, string | undefined> = {}) {
  return Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"),
    "--home", home, "api-key", ...args], {
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: home, CODEX_HOME: join(home, "codex"), ...environment },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}
async function spawnedCliResult(process: ReturnType<typeof spawnCli>) {
  const code = await process.exited;
  return {
    code,
    out: await new Response(process.stdout).text(),
    err: await new Response(process.stderr).text(),
  };
}

function differentProcessStartIdentity(value: string): string {
  if (value.startsWith("linux:") || value.startsWith("win32:")) {
    const separator = value.lastIndexOf(":");
    return `${value.slice(0, separator + 1)}${BigInt(value.slice(separator + 1)) + 1n}`;
  }
  if (value.startsWith("darwin:")) {
    return value.replace(/\d{4}$/, year => year === "2000" ? "2001" : "2000");
  }
  throw new Error(`Unsupported process start identity: ${value}`);
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
  assert.equal(payload.catalogPath, join(home, "api-key-models.json"));
  assert.deepEqual(JSON.parse(payload.catalog), JSON.parse(readFileSync(payload.catalogPath, "utf8")));
  assert.equal(payload.environment.HTTP_PROXY, "http://proxy.example:8080");
  for (const host of ["localhost", "127.0.0.1", "::1"]) assert.ok(payload.environment.NO_PROXY.includes(host));
}));

test("CLI Codex export supports an external HTTPS client without server-local paths or Interrupt hook", () => withHome(home => {
  const localKey = "cgw_" + "r".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const clientCatalog = "/home/remote/.codex/api-key-models.json";
  const exported = cli(home, ["codex-config", "--json"], undefined, {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/v1/",
    CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH: clientCatalog,
  });
  assert.equal(exported.code, 0, exported.err);
  const payload = JSON.parse(exported.out);
  assert.equal(payload.baseUrl, "https://server.example.com/v1");
  assert.equal(payload.catalogPath, clientCatalog);
  assert.ok(payload.config.includes('base_url = "https://server.example.com/v1"'));
  assert.ok(payload.config.includes(`model_catalog_json = "${clientCatalog}"`));
  assert.ok(!payload.config.includes("[[hooks.Interrupt]]"));
  assert.ok(!payload.config.includes(home));
  assert.ok(Array.isArray(JSON.parse(payload.catalog).models));
  assert.equal(existsSync(join(home, "api-key-models.json")), false);
}));

test("CLI Codex export uses the host-mapped Responses port when public Base URL is empty", () => withHome(home => {
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
}));

test("CLI refresh-models rewrites only the model catalog", () => withHome(home => {
  const localKey = "cgw_" + "r".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = join(home, "api-key-models-refresh-pending.json");
  writeFileSync(pending, '{"version":1}\n');
  const refreshed = cli(home, ["refresh-models"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.equal(refreshed.code, 0, refreshed.err);
  const payload = JSON.parse(refreshed.out);
  assert.equal(payload.catalogPath, join(home, "api-key-models.json"));
  const catalog = JSON.parse(readFileSync(payload.catalogPath, "utf8"));
  assert.ok(Array.isArray(catalog.models));
  assert.ok(catalog.models.length > 0);
  assert.equal(existsSync(pending), false);
  assert.ok(!refreshed.out.includes(localKey));
}));

test("CLI manual remote refresh-models keeps catalog export pending until explicit Codex export", () => withHome(home => {
  const localKey = "cgw_" + "e".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = join(home, "api-key-models-refresh-pending.json");
  writeFileSync(pending, '{"version":1}\n');
  const clientCatalog = "/client/api-key-models.json";
  const environment = {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/v1/",
    CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH: clientCatalog,
  };

  const refreshed = cli(home, ["refresh-models"], undefined, environment);
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.equal(JSON.parse(refreshed.out).catalogPath, clientCatalog);
  assert.equal(existsSync(join(home, "api-key-models.json")), false);
  assert.equal(existsSync(pending), true);
  assert.deepEqual(JSON.parse(readFileSync(pending, "utf8")), { version: 2, state: "export-required" });

  const exported = cli(home, ["codex-config", "--json"], undefined, environment);
  assert.equal(exported.code, 0, exported.err);
  assert.ok(Array.isArray(JSON.parse(JSON.parse(exported.out).catalog).models));
  assert.equal(existsSync(pending), false);
}));

test("concurrent CLI catalog commands preserve the marker state of the later command", async () => {
  async function runRace(
    firstArgs: string[],
    secondArgs: string[],
    expectMarker: boolean,
  ): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "cgw-api-key-cli-race-"));
    const localKey = "cgw_" + "x".repeat(43);
    const policy = apiKeyPolicy(localKey);
    const config = defaultConfig("browser-only");
    const upstream = {
      version: 2 as const,
      baseUrl: "https://provider.example/v1/",
      apiKeySha256: "a".repeat(64),
      proxy: { mode: "direct" as const },
      models: [],
      supportsOpenAiServerCompaction: false,
    };
    let releaseFirstModels!: () => void;
    const firstModelsReleased = new Promise<void>(resolve => { releaseFirstModels = resolve; });
    let firstModelsStarted!: () => void;
    const firstModelsRequest = new Promise<void>(resolve => { firstModelsStarted = resolve; });
    let secondModelsStarted!: () => void;
    const secondModelsRequest = new Promise<void>(resolve => { secondModelsStarted = resolve; });
    let modelRequests = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") {
          return Response.json({
            service: "codex-chatgpt-web",
            access_mode: "api-key",
            api_access_revision: apiAccessRevision(policy, config.controlToken),
            upstream_provider_available: true,
            upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
          });
        }
        if (path === "/v1/models") {
          modelRequests += 1;
          if (modelRequests === 1) {
            firstModelsStarted();
            await firstModelsReleased;
          } else if (modelRequests === 2) {
            secondModelsStarted();
          }
          return Response.json(buildStandaloneModelCatalog(config), { headers: {
            "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
            "x-codex-chatgpt-web-upstream-provider-revision": upstreamProviderRevision(upstream, config.controlToken),
            [MODEL_CATALOG_STATUS_HEADER]: "complete",
          } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    config.port = server.port!;
    writeFileSync(join(home, "api-access.json"), `${JSON.stringify(policy)}\n`);
    writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
    writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify(upstream)}\n`);
    const pending = join(home, "api-key-models-refresh-pending.json");
    writeFileSync(pending, '{"version":2,"state":"export-required"}\n');
    const environment = {
      CODEX_CHATGPT_WEB_API_KEY: localKey,
      CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/v1",
      CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH: "/client/api-key-models.json",
    };
    let first: ReturnType<typeof spawnCli> | undefined;
    let second: ReturnType<typeof spawnCli> | undefined;
    try {
      first = spawnCli(home, firstArgs, environment);
      await Promise.race([
        firstModelsRequest,
        first.exited.then(() => { throw new Error("first catalog command exited before requesting models"); }),
      ]);
      second = spawnCli(home, secondArgs, environment);
      await Promise.race([secondModelsRequest, Bun.sleep(1_000)]);
      releaseFirstModels();
      const [firstResult, secondResult] = await Promise.all([
        spawnedCliResult(first), spawnedCliResult(second),
      ]);
      assert.equal(firstResult.code, 0, firstResult.err);
      assert.equal(secondResult.code, 0, secondResult.err);
      assert.equal(existsSync(pending), expectMarker);
      if (expectMarker) {
        assert.deepEqual(JSON.parse(readFileSync(pending, "utf8")), { version: 2, state: "export-required" });
      }
    } finally {
      releaseFirstModels();
      first?.kill();
      second?.kill();
      server.stop(true);
      rmSync(home, { recursive: true, force: true });
    }
  }

  await runRace(["codex-config", "--json"], ["refresh-models"], true);
  await runRace(["refresh-models"], ["codex-config", "--json"], false);
});

test("CLI recovers a stale model-catalog lock after the owner PID is reused", () => withHome(home => {
  const currentStart = processStartIdentity(process.pid);
  if (!currentStart) return;
  const localKey = "cgw_" + "r".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = join(home, "api-key-models-refresh-pending.json");
  const lockPath = `${pending}.lock`;
  const owner = `${process.pid}-${"a".repeat(32)}`;
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(join(lockPath, owner), JSON.stringify({
    processStart: differentProcessStartIdentity(currentStart),
  }), { mode: 0o600 });

  const refreshed = cli(home, ["refresh-models"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.equal(refreshed.code, 0, refreshed.err);
  assert.equal(existsSync(lockPath), false);
}));

test("CLI manual remote plain Codex config keeps export pending and preserves complete-refresh enforcement", () => withHome(home => {
  const localKey = "cgw_" + "u".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  writeFileSync(join(home, "config.json"), `${JSON.stringify(defaultConfig("browser-only"))}\n`);
  const pending = join(home, "api-key-models-refresh-pending.json");
  writeFileSync(pending, '{"version":2,"state":"export-required"}\n');
  const environment = {
    CODEX_CHATGPT_WEB_API_KEY: localKey,
    CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
    CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: "https://server.example.com/v1/",
    CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH: "/client/api-key-models.json",
  };

  const plain = cli(home, ["codex-config"], undefined, environment);
  assert.equal(plain.code, 0, plain.err);
  assert.equal(existsSync(pending), true);
  assert.match(plain.err, /use --json to retrieve its content/);

  writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify({
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: "a".repeat(64),
    proxy: { mode: "global" },
    models: [{ id: "gpt-upstream" }],
    supportsOpenAiServerCompaction: false,
  })}\n`);
  const json = cli(home, ["codex-config", "--json"], undefined, environment);
  assert.notEqual(json.code, 0);
  assert.equal(existsSync(pending), true);
}));

test("CLI refresh-models includes the Zero Risk Pro row after the profile is enabled", () => withHome(home => {
  const localKey = "cgw_" + "p".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  const config = defaultConfig("full");
  config.appName = "Codex Zero Risk2";
  config.browserHost = "launcher";
  config.browserInteractionMode = "manual";
  config.browserHostDescriptorPath = join(home, "launcher-browser.json");
  config.tunnel = {
    binaryPath: process.execPath,
    tunnelId: `tunnel_${"a".repeat(32)}`,
    runtimeKeyFile: join(home, "runtime.key"),
    profileDir: join(home, "tunnel-profile"),
    profileName: "manual-test",
    alias: "manual-test",
  };
  config.zeroRiskProEnabled = true;
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  const refreshed = cli(home, ["refresh-models"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.equal(refreshed.code, 0, refreshed.err);
  const payload = JSON.parse(refreshed.out);
  const catalog = JSON.parse(readFileSync(payload.catalogPath, "utf8"));
  assert.deepEqual(catalog.models.map((model: { slug: string }) => model.slug), [
    "chatgpt-web/zero-risk",
    "chatgpt-web/zero-risk-pro",
  ]);
}));

test("CLI Codex export uses saved server-compaction intent for provider naming without exporting the upstream key", () => withHome(home => {
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

test("CLI Codex export preserves a pending previous catalog when upstream refresh falls back", () => withHome(home => {
  const localKey = "cgw_" + "n".repeat(43);
  writeFileSync(join(home, "api-access.json"), `${JSON.stringify(apiKeyPolicy(localKey))}\n`);
  const config = defaultConfig("browser-only");
  config.port = 65534;
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config)}\n`);
  writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify({
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: "b".repeat(64),
    proxy: { mode: "global" },
    models: [{ id: "gpt-upstream" }],
    supportsOpenAiServerCompaction: false,
  })}\n`);
  const catalogPath = join(home, "api-key-models.json");
  const previousCatalog = { models: [{ slug: "gpt-upstream", display_name: "Previous valid row" }] };
  writeFileSync(catalogPath, `${JSON.stringify(previousCatalog)}\n`);
  const pendingPath = join(home, "api-key-models-refresh-pending.json");
  writeFileSync(pendingPath, '{"version":1}\n');

  const exported = cli(home, ["codex-config", "--json"], undefined, { CODEX_CHATGPT_WEB_API_KEY: localKey });
  assert.notEqual(exported.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(catalogPath, "utf8")), previousCatalog);
  assert.equal(existsSync(pendingPath), true);
}));
