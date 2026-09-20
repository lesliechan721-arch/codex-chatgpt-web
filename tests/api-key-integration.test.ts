import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { defaultConfig, saveConfig } from "../src/config";
import { apiAccessRevision, apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { saveApiAccessPolicy } from "../src/api-access-config";
import { buildApiKeyExportModelCatalog } from "../src/api-key-cli";
import { buildStandaloneModelCatalog } from "../src/standalone-model-catalog";
import { installCodexIntegration, getCodexConfigPath, getCodexJournalPath } from "../src/codex-integration";
import { cleanupApiKeyCodexIntegration } from "../src/api-key-integration";
import { renderApiKeyCodexConfig } from "../src/api-key-codex-config";
import { installCompatibilityV1Features } from "../src/codex-integration-document";
import { codexInterruptHookCommand } from "../src/codex-interrupt-hook";
import { preflightSetup } from "../src/setup";
import { upstreamApiKeyDigest, upstreamProviderRevision, type UpstreamProviderConfig } from "../src/upstream-provider";

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
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 1,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    modelFilter: { mode: "selected", models: ["gpt-rich", "gpt-standard"] },
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
    return Response.json({
      object: "list",
      data: [{ id: "gpt-standard", object: "model" }],
      models: [{
        slug: "gpt-rich", display_name: "Rich upstream", visibility: "list", supported_in_api: true,
        supported_reasoning_levels: [], tool_mode: null, context_window: 128_000,
      }],
    }, { headers: {
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(policy, config.controlToken),
      "x-codex-chatgpt-web-upstream-provider-revision": upstreamProviderRevision(upstream, config.controlToken),
    } });
  });
  expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/healthz", "/v1/models"]);
  expect(requests[0]?.headers.get("authorization")).toBeNull();
  expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${localKey}`);
  expect(catalog.models.some(model => model.slug === "gpt-rich")).toBe(true);
  expect(catalog.models.some(model => model.slug === "gpt-standard")).toBe(false);
});

test("API-key export catalog refuses metadata from a stale upstream runtime", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 1,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    modelFilter: { mode: "selected", models: ["gpt-rich"] },
    supportsOpenAiServerCompaction: false,
  };
  let requests = 0;
  const catalog = await buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async () => {
    requests++;
    return Response.json({
      status: "ok",
      service: "codex-chatgpt-web",
      access_mode: "api-key",
      api_access_revision: apiAccessRevision(policy, config.controlToken),
      upstream_provider_available: true,
      upstream_provider_revision: "0".repeat(64),
    });
  });
  expect(requests).toBe(1);
  expect(catalog.models.every(model => String(model.slug).startsWith("chatgpt-web/"))).toBe(true);
});

test("API-key export catalog times out a stalled health request and returns the local catalog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const config = defaultConfig();
    const localKey = "cgw_" + "a".repeat(43);
    const policy = apiKeyPolicy(localKey);
    const upstream: UpstreamProviderConfig = {
      version: 1,
      baseUrl: "https://provider.example/v1/",
      apiKeySha256: upstreamApiKeyDigest("provider-key"),
      proxy: { mode: "direct" },
      modelFilter: { mode: "all" },
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
      version: 1,
      baseUrl: "https://provider.example/v1/",
      apiKeySha256: upstreamApiKeyDigest("provider-key"),
      proxy: { mode: "direct" },
      modelFilter: { mode: "all" },
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

test("API-key export catalog refuses models from a daemon swapped after health validation", async () => {
  const config = defaultConfig();
  const localKey = "cgw_" + "a".repeat(43);
  const policy = apiKeyPolicy(localKey);
  const upstream: UpstreamProviderConfig = {
    version: 1,
    baseUrl: "https://provider.example/v1/",
    apiKeySha256: upstreamApiKeyDigest("provider-key"),
    proxy: { mode: "direct" },
    modelFilter: { mode: "all" },
    supportsOpenAiServerCompaction: false,
  };
  let requests = 0;
  const catalog = await buildApiKeyExportModelCatalog(config, policy, localKey, upstream, async () => {
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
  });
  expect(requests).toBe(2);
  expect(catalog).toEqual(buildStandaloneModelCatalog(config));
});
