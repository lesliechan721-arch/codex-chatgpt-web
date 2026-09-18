import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpstreamProviderConfig, loadUpstreamProviderRuntime } from "../src/upstream-provider-config";
import {
  UPSTREAM_API_KEY_ENV,
  normalizeUpstreamBaseUrl,
  normalizeUpstreamModelFilter,
  normalizeUpstreamProxyUrl,
  parseUpstreamProviderConfig,
  upstreamApiKeyDigest,
  upstreamApiKeyMatches,
  upstreamEndpoint,
  upstreamModelAllowed,
  upstreamProviderRevision,
  validateUpstreamApiKey,
} from "../src/upstream-provider";

const KEY = "upstream-secret-not-openai-format";
const base = () => ({
  version: 1 as const,
  baseUrl: "https://example.test/v1/",
  apiKeySha256: upstreamApiKeyDigest(KEY),
  proxy: { mode: "global" as const },
  modelFilter: { mode: "all" as const },
  supportsOpenAiServerCompaction: false,
});

test("upstream URLs are normalized without changing the configured path prefix", () => {
  assert.equal(normalizeUpstreamBaseUrl("https://example.test/openai/v1"), "https://example.test/openai/v1/");
  const config = parseUpstreamProviderConfig({ ...base(), baseUrl: "http://127.0.0.1:11434/openai/v1" });
  assert.equal(upstreamEndpoint(config, "responses/compact"), "http://127.0.0.1:11434/openai/v1/responses/compact");
  for (const invalid of ["example.test/v1", "ftp://example.test/v1", "https://user:pw@example.test/v1",
    "https://example.test/v1?secret=x", "https://example.test/v1#fragment", "https://example.test/v1?",
    "https://example.test/v1#", "https://example.test/v1?#", " https://example.test/v1"]) {
    assert.throws(() => normalizeUpstreamBaseUrl(invalid));
  }
});

test("upstream API keys accept provider punctuation but reject header-breaking or oversized values", () => {
  const providerToken = "token with spaces:/+=?._-!@#$%^&*()";
  assert.equal(validateUpstreamApiKey(providerToken), providerToken);
  assert.equal(upstreamApiKeyMatches(providerToken, upstreamApiKeyDigest(providerToken)), true);
  for (const invalid of ["", "line\nbreak", "carriage\rreturn", "nul\0byte", "x".repeat(4097)]) {
    assert.throws(() => validateUpstreamApiKey(invalid));
  }
});

test("custom proxy validation matches the launcher HTTP and HTTPS proxy contract", () => {
  assert.equal(normalizeUpstreamProxyUrl("http://user:p%40ss@proxy.example:8080"), "http://user:p%40ss@proxy.example:8080/");
  assert.equal(normalizeUpstreamProxyUrl("https://proxy.example"), "https://proxy.example/");
  for (const invalid of ["socks5://proxy.example:1080", "http://proxy.example/path", "http://proxy.example?q=1",
    "http://:pw@proxy.example", "http://user:p@ss@proxy.example"]) {
    assert.throws(() => normalizeUpstreamProxyUrl(invalid));
  }
});

test("model filters compile before save, dedupe selected ids, and never allow the Web namespace", () => {
  assert.deepEqual(normalizeUpstreamModelFilter({ mode: "selected", models: ["alpha", "alpha", "beta"] }), {
    mode: "selected", models: ["alpha", "beta"],
  });
  assert.throws(() => normalizeUpstreamModelFilter({ mode: "regex", pattern: "[" }));
  assert.throws(() => normalizeUpstreamModelFilter({ mode: "selected", models: ["chatgpt-web/high"] }));
  const regex = parseUpstreamProviderConfig({ ...base(), modelFilter: { mode: "regex", pattern: "^gpt-[0-9]+$" } });
  assert.equal(upstreamModelAllowed("gpt-7", regex), true);
  assert.equal(upstreamModelAllowed("GPT-7", regex), false);
  assert.equal(upstreamModelAllowed("chatgpt-web/high", regex), false);
});

test("old provider files default server compaction to false and unknown fields fail closed", () => {
  const old = { ...base() } as Record<string, unknown>;
  delete old.supportsOpenAiServerCompaction;
  assert.equal(parseUpstreamProviderConfig(old).supportsOpenAiServerCompaction, false);
  assert.throws(() => parseUpstreamProviderConfig({ ...base(), secret: KEY }));
  assert.ok(!JSON.stringify(parseUpstreamProviderConfig(base())).includes(KEY));
});

test("runtime provider is available only when the explicit daemon key matches the saved digest", () => {
  const home = mkdtempSync(join(tmpdir(), "cgw-upstream-provider-"));
  try {
    assert.deepEqual(loadUpstreamProviderRuntime(home, {}), { available: false, keyMatches: false });
    writeFileSync(join(home, "upstream-provider.json"), `${JSON.stringify(base())}\n`);
    assert.deepEqual(loadUpstreamProviderConfig(home), base());
    const missing = loadUpstreamProviderRuntime(home, {});
    assert.equal(missing.available, false);
    assert.equal(missing.config?.baseUrl, base().baseUrl);
    const matching = loadUpstreamProviderRuntime(home, { [UPSTREAM_API_KEY_ENV]: KEY });
    assert.equal(matching.available, true);
    assert.equal(matching.apiKey, KEY);
    assert.equal(loadUpstreamProviderRuntime(home, { [UPSTREAM_API_KEY_ENV]: "wrong" }).available, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("provider revision changes with model filtering and server-compaction capability", () => {
  const token = "control-token-for-revision-test";
  const first = parseUpstreamProviderConfig(base());
  const regex = parseUpstreamProviderConfig({ ...base(), modelFilter: { mode: "regex", pattern: "^gpt-" } });
  const selected = parseUpstreamProviderConfig({ ...base(), modelFilter: { mode: "selected", models: ["gpt-one"] } });
  const compaction = parseUpstreamProviderConfig({ ...base(), supportsOpenAiServerCompaction: true });
  const revisions = [first, regex, selected, compaction].map(config => upstreamProviderRevision(config, token));
  assert.equal(new Set(revisions).size, revisions.length);
});
