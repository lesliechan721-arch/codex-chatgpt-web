import { test } from "bun:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { defaultConfig, type AppConfig } from "../src/config";
import { availableChatGptWebModelRoutes } from "../src/chatgpt-web-models";
import { buildStandaloneModelCatalog } from "../src/standalone-model-catalog";
import { apiAccessRevision, apiKeyPolicy, generateApiKey, OPENAI_ACCESS } from "../src/api-access";
import { compactRequest, modelsRequest, responseRequest, startServer } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { NativeFetch } from "../src/native-passthrough";
import {
  upstreamApiKeyDigest,
  upstreamProviderRevision,
  type UpstreamModelConfig,
  type UpstreamProviderRuntime,
} from "../src/upstream-provider";

const key = "cgw_" + "a".repeat(43);
const accessPolicy = apiKeyPolicy(key);
const providerKey = "provider-key.with punctuation/value";
const upstream = (models: UpstreamModelConfig[] = [{ id: "gpt-upstream" }, { id: "gpt-rich" }]): UpstreamProviderRuntime => ({
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models,
      supportsOpenAiServerCompaction: false,
    },
  });
const config = (): AppConfig => ({ ...defaultConfig(), mode: "browser-only", solAvailable: true });
const jsonRequest = (path: string, body: unknown, authorized = true) => new Request(`http://127.0.0.1${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});

const silentAdapter = (): ProviderAdapter => ({
  name: "test-no-browser",
  async runTurn(_parsed, _incoming, emit) {
    emit({ type: "text_delta", text: "test checkpoint or answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  },
});

test("standalone catalog contains exactly the eligible Web routes and no template/native row", () => {
  for (const patch of [{}, { mode: "full" as const, proAvailable: true, extraHighAvailable: true },
    { solAvailable: false }, { mode: "full" as const, browserInteractionMode: "manual" as const, zeroRiskProEnabled: true }]) {
    const cfg = { ...config(), ...patch };
    const catalog = buildStandaloneModelCatalog(cfg);
    const routes = availableChatGptWebModelRoutes(cfg);
    assert.deepEqual(catalog.models.map(model => model.slug), routes.map(route => route.slug));
    assert.deepEqual(catalog.data.map(model => model.id), routes.map(route => route.slug));
    assert.ok(catalog.models.length > 0);
    for (const model of catalog.models) {
      assert.ok(String(model.slug).startsWith("chatgpt-web/"));
      assert.equal(model.supported_in_api, true);
      assert.equal(model.tool_mode, null);
      assert.equal(typeof model.context_window, "number");
      assert.ok(Number(model.context_window) > 0);
      assert.ok(Array.isArray(model.supported_reasoning_levels));
      assert.ok(!Object.hasOwn(model, "comp_hash"));
      assert.deepEqual(model.service_tiers, []);
    }
  }
});

test("API-key model catalog never calls upstream or the installed OAuth catalog override", async () => {
  let forwarded = 0;
  const upstream: NativeFetch = async () => { forwarded++; throw new Error("Unexpected upstream request"); };
  const response = await modelsRequest(new Request("http://127.0.0.1/v1/models", {
    headers: { authorization: `Bearer ${key}` },
  }), config(), upstream, () => { throw new Error("Unexpected native config read"); }, accessPolicy);
  assert.equal(response.status, 200);
  assert.equal(forwarded, 0);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.ok((payload as { models: unknown[] }).models.length > 0);
});

test("API-key model catalog publishes only selected discovered upstream rows and keeps the local Web namespace", async () => {
  const runtime = upstream();
  const cfg = config();
  let forwarded: Request | undefined;
  const response = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}`, cookie: "private=1" } }),
    cfg,
    undefined,
    undefined,
    accessPolicy,
    undefined,
    runtime,
    async request => {
      forwarded = request;
      return Response.json({
        object: "list",
        data: [
          { id: "gpt-upstream", object: "model" },
          { id: "claude-filtered", object: "model" },
          { id: "chatgpt-web/high", object: "model", owned_by: "must-not-win" },
        ],
        models: [
          { slug: "gpt-rich", display_name: "Rich upstream", visibility: "list", supported_in_api: true,
            supported_reasoning_levels: [], tool_mode: null, context_window: 128_000 },
          { slug: "other-filtered", display_name: "Filtered", visibility: "list", supported_in_api: true,
            supported_reasoning_levels: [], tool_mode: null, context_window: 128_000 },
        ],
      });
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-codex-chatgpt-web-api-access-revision"),
    apiAccessRevision(accessPolicy, cfg.controlToken));
  assert.equal(response.headers.get("x-codex-chatgpt-web-upstream-provider-revision"),
    upstreamProviderRevision(runtime.config!, cfg.controlToken));
  assert.equal(forwarded?.url, "https://provider.example/openai/v1/models");
  assert.equal(forwarded?.headers.get("authorization"), `Bearer ${providerKey}`);
  assert.equal(forwarded?.headers.get("cookie"), null);
  const payload = await response.json() as { data: Array<{ id: string; owned_by?: string }>; models: Array<{ slug: string }> };
  assert.equal(payload.data.filter(row => row.id === "chatgpt-web/high").length, 1);
  assert.ok(payload.data.some(row => row.id === "gpt-upstream"));
  assert.ok(!payload.data.some(row => row.id === "claude-filtered"));
  assert.ok(payload.models.some(row => row.slug === "gpt-rich"));
  assert.ok(!payload.models.some(row => row.slug === "other-filtered"));
});

test("API-key model catalog accepts OpenAI-compatible data arrays without an object marker", async () => {
  const response = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
    config(), undefined, undefined, accessPolicy, undefined, upstream(),
    async () => Response.json({ data: [{ id: "gpt-upstream", object: "model" }] }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json() as { data: Array<{ id: string }> };
  assert.ok(payload.data.some(row => row.id === "gpt-upstream"));
});

test("upstream catalog failures return the complete local catalog without stale data", async () => {
  let failure: unknown;
  const response = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
    config(),
    undefined,
    undefined,
    accessPolicy,
    value => { failure = value; },
    upstream(),
    async () => { throw new Error("PRIVATE provider host should not escape diagnostics"); },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), buildStandaloneModelCatalog(config()));
  assert.deepEqual(failure, { stage: "transport" });
});

test("upstream catalog timeout returns the fresh local catalog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let failure: { stage: string; code?: string } | undefined;
    const pending = modelsRequest(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
      config(),
      undefined,
      undefined,
      accessPolicy,
      value => { failure = value; },
      upstream(),
      async () => await new Promise<Response>(() => {}),
    );
    mock.timers.tick(20_000);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), buildStandaloneModelCatalog(config()));
    assert.deepEqual(failure, { stage: "transport", code: "UpstreamModelCatalogTimeout" });
  } finally {
    mock.timers.reset();
  }
});

test("upstream catalog HTTP and whole-schema failures also fall back to a fresh local catalog", async () => {
  const local = buildStandaloneModelCatalog(config());
  for (const [upstreamResponse, stage] of [
    [new Response("provider rejected", { status: 503 }), "upstream"],
    [new Response("{", { status: 200, headers: { "content-type": "application/json" } }), "catalog"],
    [Response.json({ object: "unexpected", data: [] }), "catalog"],
    [Response.json({ data: "invalid", models: "invalid" }), "catalog"],
  ] as const) {
    let failure: { stage: string } | undefined;
    const response = await modelsRequest(
      new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
      config(), undefined, undefined, accessPolicy, value => { failure = value; }, upstream(),
      async () => upstreamResponse.clone(),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), local);
    assert.equal(failure?.stage, stage);
  }
});

test("upstream discovery sources fail independently and partial metadata is normalized safely", async () => {
  const modelsOnly = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
    config(), undefined, undefined, accessPolicy, undefined, upstream([{ id: "gpt-rich" }]),
    async () => Response.json({
      object: "unexpected",
      data: [{ id: "ignored-data" }],
      models: [{
        slug: "gpt-rich",
        display_name: "Partial upstream name",
        context_window: "invalid",
        model_messages: { instructions_template: "untrusted" },
      }],
    }),
  );
  assert.equal(modelsOnly.status, 200);
  const modelsOnlyBody = await modelsOnly.json() as { models: Array<Record<string, unknown>> };
  const rich = modelsOnlyBody.models.find(model => model.slug === "gpt-rich");
  assert.equal(rich?.display_name, "Partial upstream name");
  assert.notEqual((rich?.model_messages as { instructions_template?: string } | undefined)?.instructions_template, "untrusted");
  assert.notEqual(rich?.context_window, "invalid");

  const dataOnly = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
    config(), undefined, undefined, accessPolicy, undefined, upstream([{ id: "gpt-upstream" }]),
    async () => Response.json({ data: [{ id: "gpt-upstream" }], models: "invalid" }),
  );
  assert.equal(dataOnly.status, 200);
  const dataOnlyBody = await dataOnly.json() as { data: Array<{ id: string }>; models: Array<{ slug: string }> };
  assert.ok(dataOnlyBody.data.some(model => model.id === "gpt-upstream"));
  assert.ok(dataOnlyBody.models.some(model => model.slug === "gpt-upstream"));
});

test("unauthorized requests stop before JSON parsing, model fetch or adapter construction", async () => {
  const adapter = () => { throw new Error("Adapter must not start"); };
  const body = () => new Request("http://127.0.0.1/v1/responses", { method: "POST", body: "not json" });
  assert.equal((await responseRequest(body(), config(), adapter, { accessPolicy })).status, 401);
  assert.equal((await compactRequest(body(), config(), adapter, { accessPolicy })).status, 401);
  assert.equal((await modelsRequest(new Request("http://127.0.0.1/v1/models"), config(),
    async () => { throw new Error("Upstream must not run"); }, undefined, accessPolicy)).status, 401);
});

test("native model requests are terminal client errors for both Responses contracts", async () => {
  const adapter = () => { throw new Error("Adapter must not start"); };
  for (const model of ["native-model", undefined, null, ""]) {
    const body = { model, input: "hello", stream: false };
    for (const response of [
      await responseRequest(jsonRequest("/v1/responses", body), config(), adapter, { accessPolicy }),
      await compactRequest(jsonRequest("/v1/responses/compact", body), config(), adapter, { accessPolicy }),
    ]) {
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: { code: string } }).error.code, "model_not_supported");
    }
  }
});

test("allowed non-Web responses and compaction use the configured upstream bearer and base URL", async () => {
  const runtime = upstream();
  const seen: Array<{ url: string; authorization: string | null; localKey: string | null; body: unknown }> = [];
  const fetchUpstreamProvider = async (request: Request) => {
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      localKey: request.headers.get("x-api-key"),
      body: request.headers.get("content-type")?.includes("json") ? await request.clone().json() : null,
    });
    return Response.json({ ok: true });
  };
  for (const [path, handler] of [
    ["/v1/responses", responseRequest] as const,
    ["/v1/responses/compact", compactRequest] as const,
  ]) {
    const request = jsonRequest(path, {
      model: "gpt-upstream",
      input: [{ role: "user", content: "hello" }, { type: "compaction_trigger" }],
    });
    request.headers.set("x-api-key", "client-secret-header");
    request.headers.set("openai-project", "client-project");
    const response = handler === responseRequest
      ? await responseRequest(request, config(), () => { throw new Error("Web adapter must not run"); }, {
        accessPolicy, upstreamRuntime: runtime, fetchUpstreamProvider,
      })
      : await compactRequest(request, config(), () => { throw new Error("Web adapter must not run"); }, {
        accessPolicy, upstreamRuntime: runtime, fetchUpstreamProvider,
      });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(seen.map(item => item.url), [
    "https://provider.example/openai/v1/responses",
    "https://provider.example/openai/v1/responses/compact",
  ]);
  for (const item of seen) {
    assert.equal(item.authorization, `Bearer ${providerKey}`);
    assert.equal(item.localKey, null);
  }
});

test("allowed non-Web responses and compaction opt into the remote native-turn idle lease", async () => {
  const runtime = upstream();
  for (const [path, handler] of [
    ["/v1/responses", responseRequest] as const,
    ["/v1/responses/compact", compactRequest] as const,
  ]) {
    let remoteIdleTimeout: boolean | undefined;
    const request = jsonRequest(path, {
      model: "gpt-upstream",
      input: [{ role: "user", content: "hello" }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_remote", turn_id: "turn_remote" }),
      },
    });
    const options = {
      accessPolicy,
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async () => Response.json({ ok: true }),
      onTurnIdentity: (_identity: { threadId: string; turnId: string }, binding?: { remoteIdleTimeout: boolean }) => {
        remoteIdleTimeout = binding?.remoteIdleTimeout;
      },
    };
    const response = handler === responseRequest
      ? await responseRequest(request, config(), () => { throw new Error("Web adapter must not run"); }, options)
      : await compactRequest(request, config(), () => { throw new Error("Web adapter must not run"); }, options);
    assert.equal(response.status, 200);
    assert.equal(remoteIdleTimeout, true);
  }
});

test("the v2 model allowlist is enforced before any custom upstream request", async () => {
  let calls = 0;
  const options = {
    accessPolicy,
    upstreamRuntime: upstream([{ id: "gpt-allowed" }]),
    fetchUpstreamProvider: async () => { calls++; return Response.json({}); },
  };
  const denied = await responseRequest(jsonRequest("/v1/responses", {
    model: "gpt-blocked", input: "hello", stream: false,
  }), config(), () => { throw new Error("Web adapter must not run"); }, options);
  assert.equal(denied.status, 400);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, "model_not_supported");
  assert.equal(calls, 0);
});

test("selected models missing from the current catalog are not invented but remain routable", async () => {
  const runtime = upstream([{ id: "gpt-selected" }]);
  const catalog = await modelsRequest(
    new Request("http://127.0.0.1/v1/models", { headers: { authorization: `Bearer ${key}` } }),
    config(), undefined, undefined, accessPolicy, undefined, runtime,
    async () => Response.json({ object: "list", data: [{ id: "gpt-other" }] }),
  );
  const catalogBody = await catalog.json() as { data: Array<{ id: string }> };
  assert.ok(!catalogBody.data.some(row => row.id === "gpt-selected"));
  let forwarded = 0;
  const response = await responseRequest(jsonRequest("/v1/responses", {
    model: "gpt-selected", input: "hello", stream: false,
  }), config(), () => { throw new Error("Web adapter must not run"); }, {
    accessPolicy,
    upstreamRuntime: runtime,
    fetchUpstreamProvider: async () => { forwarded++; return Response.json({ ok: true }); },
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded, 1);
});

test("Web models remain local when a custom upstream is available", async () => {
  let forwarded = 0;
  const response = await responseRequest(jsonRequest("/v1/responses", {
    model: "chatgpt-web/high",
    input: [{ role: "user", content: "hello" }, { type: "compaction_trigger" }],
    stream: false,
  }), config(), silentAdapter, {
    accessPolicy,
    upstreamRuntime: upstream([]),
    fetchUpstreamProvider: async () => { forwarded++; throw new Error("must stay local"); },
    rememberState: false,
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded, 0);
});

test("unavailable Web slugs are rejected instead of falling back to another model", async () => {
  const response = await responseRequest(jsonRequest("/v1/responses", {
    model: "chatgpt-web/not-a-real-model", input: "hello", stream: false,
  }), config(), () => { throw new Error("Adapter must not start"); }, { accessPolicy });
  assert.equal(response.status, 400);
});

test("authenticated JSON and SSE responses retain the adapter contract without forwarding credentials", async () => {
  for (const stream of [false, true]) {
    let called = 0;
    const adapter = (): ProviderAdapter => ({ name: "test", async runTurn(_parsed, incoming, emit) {
      called++;
      assert.equal(incoming.headers.get("authorization"), null);
      assert.equal(incoming.headers.get("cookie"), null);
      emit({ type: "text_delta", text: "answer-without-upstream" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } });
    const req = jsonRequest("/v1/responses", { model: "chatgpt-web/high", input: "hello", stream });
    req.headers.set("cookie", "not-for-browser=secret");
    const response = await responseRequest(req, config(), adapter, { accessPolicy, rememberState: false });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(called, 1);
    assert.ok(text.includes("answer-without-upstream"));
    assert.ok(!text.includes(key));
    if (stream) assert.ok(text.includes("response.completed"));
  }
});

test("local compaction v1 and v2 continue through the existing summary bridge", async () => {
  const base = { model: "chatgpt-web/high", stream: false,
    input: [{ role: "user", content: "Summarize this task" }] };
  const v1 = await compactRequest(jsonRequest("/v1/responses/compact", base), config(), silentAdapter, { accessPolicy });
  assert.equal(v1.status, 200);
  assert.ok(Array.isArray((await v1.json() as { output: unknown[] }).output));
  const v2 = await responseRequest(jsonRequest("/v1/responses", {
    ...base, input: [...base.input, { type: "compaction_trigger" }],
  }), config(), silentAdapter, { accessPolicy, rememberState: false });
  assert.equal(v2.status, 200);
  const output = (await v2.json() as { output: Array<{ type: string }> }).output;
  assert.equal(output.length, 1);
  assert.equal(output[0]?.type, "compaction");
});

test("legacy models still use the native passthrough response", async () => {
  let calls = 0;
  const upstream: NativeFetch = async () => { calls++; return new Response("upstream rejected", { status: 401 }); };
  const response = await modelsRequest(new Request("http://127.0.0.1/v1/models", {
    headers: { authorization: "Bearer original-oauth-token" },
  }), config(), upstream, undefined, OPENAI_ACCESS);
  assert.equal(calls, 1);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "upstream rejected");
});

test("HTTP dispatcher blocks all native endpoints and keeps admin authority separate", async () => {
  const cfg = { ...config(), port: 0, controlToken: generateApiKey() };
  const beforeInt = new Set(process.listeners("SIGINT"));
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  let forwarded = 0;
  const server = startServer(cfg, { accessPolicy, fetchUpstream: async () => { forwarded++; throw new Error("Unexpected upstream"); } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits", "/v1/chat/completions"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" });
      assert.equal(response.status, 404);
      await response.text();
    }
    assert.equal(forwarded, 0);
    const deniedAdmin = await fetch(`${base}/admin/drain`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    assert.equal(deniedAdmin.status, 401);
    await deniedAdmin.text();
    const health = await (await fetch(`${base}/healthz`)).text();
    assert.ok(health.includes('"access_mode":"api-key"'));
    assert.ok(!health.includes(key));
    assert.ok(!health.includes("keySha256"));
    const wrong = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${cfg.controlToken}` } });
    assert.equal(wrong.status, 401);
    await wrong.text();
    const websocket = await fetch(`${base}/v1/responses`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(websocket.status, 426);
    await websocket.text();
  } finally {
    await server.stop(true);
    for (const listener of process.listeners("SIGINT")) if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
  }
});

test("HTTP dispatcher exposes search and images only through an available custom upstream", async () => {
  const cfg = { ...config(), port: 0, controlToken: generateApiKey() };
  const runtime = upstream([]);
  const beforeInt = new Set(process.listeners("SIGINT"));
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const server = startServer(cfg, {
    accessPolicy,
    upstreamRuntime: runtime,
    fetchUpstreamProvider: async request => {
      seen.push({ url: request.url, authorization: request.headers.get("authorization") });
      return Response.json({ forwarded: true });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const path of ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(seen.map(item => item.url), [
      "https://provider.example/openai/v1/alpha/search",
      "https://provider.example/openai/v1/images/generations",
      "https://provider.example/openai/v1/images/edits",
    ]);
    for (const item of seen) assert.equal(item.authorization, `Bearer ${providerKey}`);
    const unauthorized = await fetch(`${base}/v1/images/generations`, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    await unauthorized.text();
    const unsupported = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}",
    });
    assert.equal(unsupported.status, 404);
    await unsupported.text();
    const health = await (await fetch(`${base}/healthz`)).text();
    assert.ok(health.includes('"upstream_provider_configured":true'));
    assert.ok(health.includes('"upstream_provider_available":true'));
    assert.ok(health.includes('"upstream_provider_key_matches":true'));
    assert.ok(!health.includes(providerKey));
    assert.ok(!health.includes("provider.example"));
  } finally {
    await server.stop(true);
    for (const listener of process.listeners("SIGINT")) if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
  }
});

test("health reports persisted invalid custom metadata without exposing its contents", async () => {
  const cfg = { ...config(), port: 0, controlToken: generateApiKey() };
  const runtime = upstream([{
    id: "gpt-upstream",
    metadata: {
      mode: "custom",
      baseMode: "fallback",
      overrides: { removed_schema_field: "private-metadata-value" },
    },
  }]);
  const beforeInt = new Set(process.listeners("SIGINT"));
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  const server = startServer(cfg, { accessPolicy, upstreamRuntime: runtime });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    assert.equal(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assert.equal(health.upstream_metadata_repair_count, 1);
    const text = JSON.stringify(health);
    assert.ok(!text.includes("removed_schema_field"));
    assert.ok(!text.includes("private-metadata-value"));
    assert.ok(!text.includes("provider.example"));
    assert.ok(!text.includes(providerKey));
  } finally {
    await server.stop(true);
    for (const listener of process.listeners("SIGINT")) if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
  }
});

test("custom upstream failures are returned without falling back to official native forwarding", async () => {
  const cfg = { ...config(), port: 0, controlToken: generateApiKey() };
  const beforeInt = new Set(process.listeners("SIGINT"));
  const beforeTerm = new Set(process.listeners("SIGTERM"));
  let nativeCalls = 0;
  let customCalls = 0;
  const server = startServer(cfg, {
    accessPolicy,
    upstreamRuntime: upstream([{ id: "gpt-upstream" }]),
    fetchUpstream: async () => { nativeCalls++; return new Response("native fallback", { status: 200 }); },
    fetchUpstreamProvider: async () => {
      customCalls++;
      return Response.json({ error: { message: "provider rejected" } }, { status: 429 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const [path, body] of [
      ["/v1/responses", { model: "gpt-upstream", input: "hello", stream: false }],
      ["/v1/alpha/search", { query: "hello" }],
      ["/v1/images/generations", { prompt: "hello" }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 429);
      await response.text();
    }
    assert.equal(customCalls, 3);
    assert.equal(nativeCalls, 0);
  } finally {
    await server.stop(true);
    for (const listener of process.listeners("SIGINT")) if (!beforeInt.has(listener)) process.removeListener("SIGINT", listener);
    for (const listener of process.listeners("SIGTERM")) if (!beforeTerm.has(listener)) process.removeListener("SIGTERM", listener);
  }
});

test("service refuses a client key that is also the admin control token", () => {
  assert.throws(() => startServer({ ...config(), controlToken: key }, { accessPolicy }), /must not be the daemon control token/);
});
