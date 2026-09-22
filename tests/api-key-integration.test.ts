import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { defaultConfig, saveConfig } from "../src/config";
import { apiAccessRevision, apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { saveApiAccessPolicy } from "../src/api-access-config";
import { buildApiKeyExportModelCatalog, buildApiKeyRefreshModelCatalog } from "../src/api-key-cli";
import { buildStandaloneModelCatalog } from "../src/standalone-model-catalog";
import {
  installCodexIntegration,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "../src/codex-integration";
import { cleanupApiKeyCodexIntegration } from "../src/api-key-integration";
import { renderApiKeyCodexConfig } from "../src/api-key-codex-config";
import { installCompatibilityV1Features } from "../src/codex-integration-document";
import { codexInterruptHookCommand } from "../src/codex-interrupt-hook";
import { preflightSetup } from "../src/setup";
import { upstreamApiKeyDigest, upstreamProviderRevision, type UpstreamProviderConfig } from "../src/upstream-provider";
import codexModelMetadata from "../launcher/electron/codex-model-metadata.cjs";

let home: string;
let oldCore: string | undefined;
let oldCodex: string | undefined;
beforeEach(() => {
  oldCore = process.env.CODEX_CHATGPT_WEB_HOME; oldCodex = process.env.CODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "api-manual-config-"));
  process.env.CODEX_CHATGPT_WEB_HOME = join(home, "core"); process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
});
afterEach(() => {
  if (oldCore === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = oldCore;
  if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  rmSync(home, { recursive: true, force: true });
});
const api = () => saveApiAccessPolicy(apiKeyPolicy("a".repeat(40)));
function injected() {
  saveApiAccessPolicy(OPENAI_ACCESS);
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = defaultConfig(); saveConfig(config); installCodexIntegration(config);
  api(); return config;
}

function clientFileSnapshot(): Array<{ path: string; bytes: string | null }> {
  return [
    getCodexConfigPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => ({
    path,
    bytes: existsSync(path) ? readFileSync(path).toString("base64") : null,
  }));
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test port reservation has no TCP address");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
  });
  return port;
}

function cli(args: string[]) {
  return Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", process.env.CODEX_CHATGPT_WEB_HOME!, ...args],
    {
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}
test("API cleanup removes recorded routes/features/hooks but retains the user's provider", () => {
  injected(); expect(cleanupApiKeyCodexIntegration().changed).toBe(true);
  const parsed = Bun.TOML.parse(readFileSync(getCodexConfigPath(), "utf8")) as any;
  expect(parsed.model_provider).toBe("custom"); expect(parsed.model_providers.custom.name).toBe("Own provider");
  expect(parsed.openai_base_url).toBeUndefined(); expect(parsed.experimental_realtime_webrtc_call_base_url).toBeUndefined();
  expect(parsed.hooks?.Interrupt).toBeUndefined(); expect(existsSync(getCodexJournalPath())).toBe(false);
  expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
});
test("later manual API-provider changes survive cleanup of the old injection", () => {
  injected(); const file = getCodexConfigPath();
  const updated = readFileSync(file, "utf8").replace('model_provider = "custom"',
    'model_provider = "chatgpt_web"\nmodel_catalog_json = "/manual/catalog.json"');
  writeFileSync(file, updated); cleanupApiKeyCodexIntegration();
  const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  expect(parsed.model_provider).toBe("chatgpt_web"); expect(parsed.model_catalog_json).toBe("/manual/catalog.json");
});
test("without ownership journal manually copied settings are byte-for-byte untouched", () => {
  api(); const text = 'model_provider = "chatgpt_web"\n[features]\nmulti_agent = true\n';
  writeFileSync(getCodexConfigPath(), text); expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(text);
});
test("dry run never edits or removes recorded injection", () => {
  injected(); const before = readFileSync(getCodexConfigPath(), "utf8");
  cleanupApiKeyCodexIntegration(true); expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(before);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("missing config is not recreated to clean a stale journal", () => {
  injected(); rmSync(getCodexConfigPath()); cleanupApiKeyCodexIntegration();
  expect(existsSync(getCodexConfigPath())).toBe(false); expect(existsSync(getCodexJournalPath())).toBe(false);
});
test("modified hook is a conflict and never overwritten", () => {
  injected(); const file = getCodexConfigPath();
  const text = readFileSync(file, "utf8").replace('timeout = 3', 'timeout = 7'); writeFileSync(file, text);
  expect(() => cleanupApiKeyCodexIntegration()).toThrow(); expect(readFileSync(file, "utf8")).toBe(text);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("OpenAI forwarding is not cleaned by an API-only operation", () => {
  injected(); saveApiAccessPolicy(OPENAI_ACCESS); expect(cleanupApiKeyCodexIntegration().changed).toBe(false);
  expect(existsSync(getCodexJournalPath())).toBe(true);
});
test("API preflight accepts manual providers and creates no Codex injection", () => {
  api(); preflightSetup({ mode: "browser-only", browserHostDescriptorPath: join(home, "browser.json"), acknowledgedUnofficial: true });
  expect(existsSync(getCodexConfigPath())).toBe(false); expect(existsSync(getCodexJournalPath())).toBe(false);
});
test("manual server mode leaves recorded Codex client files byte-for-byte unchanged on API enable, rotate and serve", async () => {
  const port = await unusedPort();
  saveApiAccessPolicy(OPENAI_ACCESS);
  writeFileSync(getCodexConfigPath(), '# User config\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Own provider"\n');
  const config = { ...defaultConfig(), port };
  saveConfig(config);
  installCodexIntegration(config);
  const before = clientFileSnapshot();

  const enabled = cli(["api-key", "enable", "--generate"]);
  expect(enabled.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const rotated = cli(["api-key", "rotate", "--generate"]);
  expect(rotated.exitCode).toBe(0);
  expect(clientFileSnapshot()).toEqual(before);

  const cleanup = cli(["api-key", "cleanup"]);
  expect(cleanup.exitCode).toBe(0);
  expect(JSON.parse(cleanup.stdout.toString())).toEqual({ changed: false, manualConfigurationRequired: true });
  expect(clientFileSnapshot()).toEqual(before);

  const serve = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", process.env.CODEX_CHATGPT_WEB_HOME!, "serve"],
    {
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await Bun.sleep(20);
    }
    expect(healthy).toBeTrue();
    expect(clientFileSnapshot()).toEqual(before);
  } finally {
    serve.kill();
    await serve.exited;
  }
});
test("export shares V1 feature defaults and Interrupt command but omits conflicting auth/voice/trust", () => {
  const config = defaultConfig();
  const text = renderApiKeyCodexConfig({ port: 17841, catalogPath: "/catalog.json", model: "chatgpt-web/high",
    reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: config.subagentProtocol, runtimeCommand: config.runtimeCommand });
  const parsed = Bun.TOML.parse(text) as any;
  const defaults = Bun.TOML.parse(installCompatibilityV1Features("").text) as any;
  expect(text).not.toContain("Managed by codex-chatgpt-web");
  expect(parsed.features).toEqual(defaults.features); expect(parsed.agents).toEqual(defaults.agents);
  expect(parsed.hooks.Interrupt[0].hooks[0].command).toBe(codexInterruptHookCommand(config));
  expect(parsed.hooks.state).toBeUndefined(); expect(parsed.openai_base_url).toBeUndefined();
  expect(parsed.experimental_realtime_webrtc_call_base_url).toBeUndefined();
  expect(parsed.model_providers.chatgpt_web.requires_openai_auth).toBe(false);
  expect(existsSync(getCodexConfigPath())).toBe(false);
});
test("native subagent export does not inject Compatibility V1 feature overrides", () => {
  const parsed = Bun.TOML.parse(renderApiKeyCodexConfig({ port: 17841, catalogPath: "/catalog.json",
    model: "chatgpt-web/high", reasoningEffort: "high", apiKey: "cgw_" + "a".repeat(43), subagentProtocol: "native" })) as any;
  expect(parsed.features).toBeUndefined(); expect(parsed.agents).toBeUndefined();
});

test("API-key export catalog includes only validated rich models from the current upstream runtime", async () => {
  const config = defaultConfig();
  const localCatalog = buildStandaloneModelCatalog(config);
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [{ id: "gpt-rich" }, { id: "gpt-standard" }],
    supportsOpenAiServerCompaction: false,
  };
  const requests: Request[] = [];
  const catalog = await buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).pathname === "/healthz") {
      return Response.json({
        status: "degraded",
        service: "codex-chatgpt-web",
        access_mode: "api-key",
        api_access_revision: apiAccessRevision(policy, config.controlToken),
        upstream_provider_available: true,
        upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
      }, { status: 503 });
    }
    const responseCatalog = {
      object: "list",
      data: [
        ...localCatalog.data,
        { id: "gpt-standard", object: "model", created: 0, owned_by: "configured-upstream" },
      ],
      models: [...localCatalog.models, {
        slug: "gpt-standard",
        display_name: "Normalized standard row",
        supported_reasoning_levels: [],
        shell_type: "disabled",
        visibility: "list",
        supported_in_api: true,
        priority: 99,
        support_verbosity: false,
        truncation_policy: { mode: "bytes", limit: 10_000 },
        experimental_supported_tools: [],
        model_messages: { instructions_template: "Project-owned instructions" },
      }],
    };
    return Response.json(responseCatalog, { headers: {
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
      "x-codex-chatgpt-web-upstream-provider-revision": upstreamProviderRevision(upstream, config.controlToken),
    } });
  });
  expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/healthz", "/v1/models"]);
  expect(requests[0]?.headers.get("authorization")).toBeNull();
  expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${localKey}`);
  expect(catalog.data).toHaveLength(localCatalog.data.length + 1);
  expect(catalog.models).toHaveLength(localCatalog.models.length + 1);
  expect(catalog.models.some(model => model.slug === "gpt-standard")).toBe(true);
  expect(catalog.models.map(model => codexModelMetadata.finalModelError(model))).toEqual(
    Array(catalog.models.length).fill(null),
  );
});

test("API-key export catalog rejects a loopback catalog with an invalid final ModelInfo row", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [{ id: "gpt-standard" }],
    supportsOpenAiServerCompaction: false,
  };
  const catalog = await buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async (input) => {
    if (new URL(String(input)).pathname === "/healthz") {
      return Response.json({
        status: "degraded",
        service: "codex-chatgpt-web",
        access_mode: "api-key",
        api_access_revision: apiAccessRevision(policy, config.controlToken),
        upstream_provider_available: true,
        upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
      });
    }
    return Response.json({
      object: "list",
      data: [{ id: "gpt-standard", object: "model", created: 0, owned_by: "configured-upstream" }],
      models: [{ slug: "gpt-standard", display_name: "Incomplete final row" }],
    }, { headers: {
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
      "x-codex-chatgpt-web-upstream-provider-revision": upstreamProviderRevision(upstream, config.controlToken),
    } });
  });
  expect(catalog).toEqual(buildStandaloneModelCatalog(config));
});

test("API-key export catalog refuses metadata from a stale upstream runtime", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [{ id: "gpt-rich" }],
    supportsOpenAiServerCompaction: false,
  };
  let requests = 0;
  await expect(buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async () => {
    requests++;
    return Response.json({
      status: "ok",
      service: "codex-chatgpt-web",
      access_mode: "api-key",
      api_access_revision: apiAccessRevision(policy, config.controlToken),
      upstream_provider_available: true,
      upstream_provider_revision: "0".repeat(64),
    });
  })).rejects.toThrow("Upstream provider runtime is not synchronized");
  expect(requests).toBe(1);
});

test("API-key export catalog times out a stalled health request and returns the local catalog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = defaultConfig();
    const localKey = "cgw_" + "a".repeat(43);
    const policy = apiKeyPolicy(localKey);
    const upstream: UpstreamProviderConfig = {
      version: 2,
      baseUrl: "https://provider.example/v1/",
      apiKeySha256: upstreamApiKeyDigest("provider-key"),
      proxy: { mode: "direct" },
      models: [],
      supportsOpenAiServerCompaction: false,
    };
    const pending = buildApiKeyExportModelCatalog(
      config,
      policy,
      localKey,
      upstream,
      async () => await new Promise<Response>(() => {}),
    );
    mock.timers.tick(30_000);
    const catalog = await pending;
    expect(catalog).toEqual(buildStandaloneModelCatalog(config));
  } finally {
    mock.timers.reset();
  }
});

test("API-key export catalog times out a stalled models request and returns the local catalog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = defaultConfig();
    const localKey = "cgw_" + "a".repeat(43);
    const policy = apiKeyPolicy(localKey);
    const upstream: UpstreamProviderConfig = {
      version: 2,
      baseUrl: "https://provider.example/v1/",
      apiKeySha256: upstreamApiKeyDigest("provider-key"),
      proxy: { mode: "direct" },
      models: [],
      supportsOpenAiServerCompaction: false,
    };
    let requests = 0;
    const pending = buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async () => {
      requests++;
      if (requests === 1) {
        return Response.json({
          service: "codex-chatgpt-web",
          access_mode: "api-key",
          api_access_revision: apiAccessRevision(policy, config.controlToken),
          upstream_provider_available: true,
          upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
        });
      }
      return await new Promise<Response>(() => {});
    });
    while (requests < 2) await Promise.resolve();
    mock.timers.tick(30_000);
    const catalog = await pending;
    expect(catalog).toEqual(buildStandaloneModelCatalog(config));
  } finally {
    mock.timers.reset();
  }
});

test("API-key model refresh fails instead of replacing the previous catalog with a local fallback", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [],
    supportsOpenAiServerCompaction: false,
  };
  await expect(buildApiKeyRefreshModelCatalog(config, policy, localKey, upstream, async () => {
    throw new Error("temporary loopback failure");
  })).rejects.toThrow("Upstream model catalog refresh failed");
});

test("API-key model refresh rejects a successful loopback response that reports upstream fallback", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [],
    supportsOpenAiServerCompaction: false,
  };
  let requests = 0;
  await expect(buildApiKeyRefreshModelCatalog(config, policy, localKey, upstream, async () => {
    requests++;
    if (requests === 1) {
      return Response.json({
        service: "codex-chatgpt-web",
        access_mode: "api-key",
        api_access_revision: apiAccessRevision(policy, config.controlToken),
        upstream_provider_available: true,
        upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
      });
    }
    return Response.json(buildStandaloneModelCatalog(config), { headers: {
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
      "x-codex-chatgpt-web-upstream-provider-revision": upstreamProviderRevision(upstream, config.controlToken),
      "x-codex-chatgpt-web-model-catalog-status": "fallback",
    } });
  })).rejects.toThrow("Upstream model catalog refresh failed");
  expect(requests).toBe(2);
});

test("API-key export catalog refuses models from a daemon swapped after health validation", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 2,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    models: [{ id: "gpt-rich" }],
    supportsOpenAiServerCompaction: false,
  };
  let requests = 0;
  await expect(buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async () => {
    requests++;
    if (requests === 1) {
      return Response.json({
        service: "codex-chatgpt-web",
        access_mode: "api-key",
        api_access_revision: apiAccessRevision(policy, config.controlToken),
        upstream_provider_available: true,
        upstream_provider_revision: upstreamProviderRevision(upstream, config.controlToken),
      });
    }
    return Response.json({
      object: "list",
      data: [{ id: "gpt-rich", object: "model" }],
      models: [{
        slug: "gpt-rich", display_name: "Swapped daemon", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [], tool_mode: null, context_window: 128_000,
      }],
    }, { headers: {
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
      "x-codex-chatgpt-web-upstream-provider-revision": "0".repeat(64),
    } });
  })).rejects.toThrow("Upstream provider runtime is not synchronized");
  expect(requests).toBe(2);
});
