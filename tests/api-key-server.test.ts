import { test } from "bun:test";
import assert from "node:assert/strict";
import { defaultConfig, type AppConfig } from "../src/config";
import { availableChatGptWebModelRoutes } from "../src/chatgpt-web-models";
import { buildStandaloneModelCatalog } from "../src/standalone-model-catalog";
import { apiKeyPolicy, generateApiKey, OPENAI_ACCESS } from "../src/api-access";
import { compactRequest, modelsRequest, responseRequest, startServer } from "../src/server";
import type { ProviderAdapter } from "../src/adapters/base";
import type { NativeFetch } from "../src/native-passthrough";

const key = "cgw_" + "a".repeat(43);
const accessPolicy = apiKeyPolicy(key);
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

test("service refuses a client key that is also the admin control token", () => {
  assert.throws(() => startServer({ ...config(), controlToken: key }, { accessPolicy }), /must not be the daemon control token/);
});
