import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  OPENAI_ACCESS, adapterRequestHeaders, apiKeyMatches, apiKeyPolicy, authenticateApiRequest,
  generateApiKey, guardApiRequest, parseApiAccessPolicy, requireWebModelInApiKeyMode,
} from "../src/api-access";
import { renderApiKeyCodexConfig } from "../src/api-key-codex-config";

const key = "cgw_" + "a".repeat(43);
const policy = apiKeyPolicy(key);
const request = (path = "/v1/models", authorization: string | null = `Bearer ${key}`, method = "GET") =>
  new Request(`http://127.0.0.1${path}`, { method, headers: authorization ? { authorization } : {} });

test("generated keys have 256 random bits and only their digest is persisted", () => {
  const first = generateApiKey();
  const second = generateApiKey();
  assert.match(first, /^cgw_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(apiKeyMatches(first, apiKeyPolicy(first)), true);
  assert.equal(JSON.stringify(apiKeyPolicy(first)).includes(first), false);
});

test("imported keys enforce bounded ASCII format without echoing rejected values", () => {
  for (const invalid of ["short-secret", " ".repeat(40), "a".repeat(257), "中".repeat(40), "a".repeat(40) + "\n"]) {
    assert.throws(() => apiKeyPolicy(invalid), error => error instanceof Error && !error.message.includes(invalid));
  }
  for (const valid of ["a".repeat(32), "Z_-9".repeat(64)]) assert.equal(apiKeyMatches(valid, apiKeyPolicy(valid)), true);
});

test("policy validation fails closed on malformed, unknown or cleartext configurations", () => {
  for (const invalid of [null, [], {}, { version: 1, mode: "api-key" },
    { version: 2, mode: "openai" }, { version: 1, mode: "typo" },
    { ...policy, apiKey: key }, { ...policy, keySha256: "x".repeat(64) },
    { version: 1, mode: "openai", apiKey: key }]) {
    assert.throws(() => parseApiAccessPolicy(invalid), /refusing to fall back/);
  }
  assert.deepEqual(parseApiAccessPolicy(OPENAI_ACCESS), OPENAI_ACCESS);
  assert.deepEqual(parseApiAccessPolicy(policy), policy);
});

test("key rotation rejects the previous key", () => {
  const replacement = generateApiKey();
  const next = apiKeyPolicy(replacement);
  assert.equal(apiKeyMatches(key, next), false);
  assert.equal(apiKeyMatches(replacement, next), true);
  assert.equal(apiKeyMatches(key, OPENAI_ACCESS), false);
});

test("Bearer auth accepts the correct key and a case-insensitive scheme", () => {
  assert.equal(authenticateApiRequest(request(), policy), undefined);
  assert.equal(authenticateApiRequest(request("/v1/models", `bearer ${key}`), policy), undefined);
});

test("missing, incorrect, malformed and coalesced duplicate credentials are rejected", async () => {
  for (const auth of [null, "", `Basic ${key}`, `Bearer ${"b".repeat(43)}`,
    `Bearer  ${key}`, `Bearer ${key}, Bearer ${key}`, `Bearer ${key} other`]) {
    const response = authenticateApiRequest(request("/v1/models", auth), policy);
    assert.equal(response?.status, 401);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.ok(response?.headers.get("www-authenticate"));
    const body = await response!.text();
    assert.ok(!body.includes(key));
    assert.ok(!body.includes(policy.mode === "api-key" ? policy.keySha256 : "impossible"));
  }
});

test("query strings and x-api-key are not alternative authorization channels", () => {
  const req = new Request(`http://127.0.0.1/v1/models?api_key=${key}`, { headers: { "x-api-key": key } });
  assert.equal(guardApiRequest(req, policy)?.status, 401);
});

test("known Responses API methods are allowed after authentication", () => {
  for (const [path, method] of [["/v1/models", "GET"], ["/v1/responses", "GET"],
    ["/v1/responses", "POST"], ["/v1/responses/compact", "POST"]]) {
    assert.equal(guardApiRequest(request(path, `Bearer ${key}`, method), policy), undefined);
  }
});

test("native search, image, chat-completion and unknown paths never enter dispatch", () => {
  for (const path of ["/v1", "/v1/alpha/search", "/v1/images/generations", "/v1/images/edits",
    "/v1/chat/completions", "/v1/unknown", "/v1/models/"]) {
    assert.equal(guardApiRequest(request(path, `Bearer ${key}`, "POST"), policy)?.status, 404);
    assert.equal(guardApiRequest(request(path, "", "POST"), policy)?.status, 401);
  }
});

test("unsupported methods return 405 rather than falling through", () => {
  const response = guardApiRequest(request("/v1/models", `Bearer ${key}`, "POST"), policy);
  assert.equal(response?.status, 405);
  assert.equal(response?.headers.get("allow"), "GET");
});

test("health and admin remain outside client-key authority", () => {
  assert.equal(guardApiRequest(request("/healthz", ""), policy), undefined);
  assert.equal(guardApiRequest(request("/admin/shutdown", "", "POST"), policy), undefined);
  // Their existing dedicated handlers, not this guard, own authorization.
});

test("legacy mode does not change authentication, models or endpoint routing", () => {
  assert.equal(authenticateApiRequest(request("/v1/models", ""), OPENAI_ACCESS), undefined);
  assert.equal(guardApiRequest(request("/v1/images/edits", "", "POST"), OPENAI_ACCESS), undefined);
  assert.equal(requireWebModelInApiKeyMode("native-model", OPENAI_ACCESS), undefined);
});

test("only the Web namespace can reach model eligibility validation", () => {
  for (const model of [undefined, null, 123, "", "gpt-native", "chatgpt-web", "ChatGPT-Web/high"]) {
    assert.equal(requireWebModelInApiKeyMode(model, policy)?.status, 400);
  }
  assert.equal(requireWebModelInApiKeyMode("chatgpt-web/high", policy), undefined);
});

test("adapter headers drop secrets but preserve canonical turn metadata", () => {
  const incoming = new Headers({ authorization: `Bearer ${key}`, "proxy-authorization": "Basic secret",
    "x-api-key": key, cookie: "session=secret", "chatgpt-account-id": "account",
    "openai-organization": "org", "openai-project": "project", "x-codex-turn-metadata": "metadata" });
  const outgoing = adapterRequestHeaders(incoming, policy);
  assert.deepEqual([...outgoing.keys()], ["x-codex-turn-metadata"]);
  assert.equal(outgoing.get("x-codex-turn-metadata"), "metadata");
  assert.equal(incoming.get("authorization"), `Bearer ${key}`);
  assert.equal(adapterRequestHeaders(incoming, OPENAI_ACCESS).get("authorization"), `Bearer ${key}`);
});

test("Codex export uses a separate provider and environment key, not OAuth", () => {
  const text = renderApiKeyCodexConfig({ port: 17841, catalogPath: "C:\\Local Data\\models.json",
    model: "chatgpt-web/high", reasoningEffort: "high" });
  assert.ok(text.includes('requires_openai_auth = false'));
  assert.ok(text.includes('env_key = "CODEX_CHATGPT_WEB_API_KEY"'));
  assert.ok(text.includes('model_provider = "chatgpt_web"'));
  assert.ok(text.includes('supports_websockets = false'));
  assert.ok(text.includes('wire_api = "responses"'));
  assert.ok(text.includes('web_search = "disabled"'));
  assert.ok(text.includes('C:\\\\Local Data\\\\models.json'));
  assert.ok(!text.includes(key));
});

test("Codex export validates the endpoint and model", () => {
  const base = { port: 17841, catalogPath: "/models.json", model: "chatgpt-web/high", reasoningEffort: "high" };
  for (const port of [0, -1, 65536, 1.5, NaN]) assert.throws(() => renderApiKeyCodexConfig({ ...base, port }));
  assert.throws(() => renderApiKeyCodexConfig({ ...base, model: "native-model" }));
});
