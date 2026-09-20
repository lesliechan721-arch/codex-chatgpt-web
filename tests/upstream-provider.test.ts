import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpstreamProviderConfig, loadUpstreamProviderRuntime } from "../src/upstream-provider-config";
import {
  UPSTREAM_API_KEY_ENV,
  normalizeUpstreamBaseUrl,
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
  version: 2 as const,
  baseUrl: "https://example.test/v1/",
  apiKeySha256: upstreamApiKeyDigest(KEY),
  proxy: { mode: "global" as const },
  models: [{ id: "gpt-one" }],
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

test("v2 model configuration dedupes identical rows and is the only upstream routing allowlist", () => {
  const config = parseUpstreamProviderConfig({
    ...base(),
    models: [{ id: "beta" }, { id: "alpha" }, { id: "alpha" }],
  });
  assert.deepEqual(config.models, [{ id: "alpha" }, { id: "beta" }]);
  assert.equal(upstreamModelAllowed("alpha", config), true);
  assert.equal(upstreamModelAllowed("other", config), false);
  assert.equal(upstreamModelAllowed("chatgpt-web/high", config), false);
  assert.throws(() => parseUpstreamProviderConfig({ ...base(), models: [{ id: "chatgpt-web/high" }] }));
  assert.throws(() => parseUpstreamProviderConfig({
    ...base(),
    models: [{ id: "alpha" }, { id: "alpha", metadata: { mode: "fallback" } }],
  }));
});

test("v2 provider files default server compaction to false and unknown fields fail closed", () => {
  const old = { ...base() } as Record<string, unknown>;
  delete old.supportsOpenAiServerCompaction;
  assert.equal(parseUpstreamProviderConfig(old).supportsOpenAiServerCompaction, false);
  assert.throws(() => parseUpstreamProviderConfig({ ...base(), secret: KEY }));
  assert.ok(!JSON.stringify(parseUpstreamProviderConfig(base())).includes(KEY));
});

for (const modelFilter of [
  { mode: "selected", models: ["gpt-one"] },
  { mode: "all" },
  { mode: "regex", pattern: "^gpt-" },
]) {
  test(`legacy v1 ${modelFilter.mode} provider configuration is deleted, marked, and never executed`, () => {
    const home = mkdtempSync(join(tmpdir(), "cgw-upstream-provider-v1-"));
    try {
      const path = join(home, "upstream-provider.json");
      writeFileSync(path, `${JSON.stringify({
        version: 1,
        baseUrl: "https://example.test/v1/",
        apiKeySha256: upstreamApiKeyDigest(KEY),
        proxy: { mode: "global" },
        modelFilter,
        supportsOpenAiServerCompaction: false,
      })}\n`);
      assert.equal(loadUpstreamProviderConfig(home), undefined);
      assert.equal(existsSync(path), false);
      assert.deepEqual(JSON.parse(readFileSync(join(home, "upstream-provider-reset.json"), "utf8")), {
        version: 1,
        reason: "legacy-v1-removed",
      });
      assert.deepEqual(loadUpstreamProviderRuntime(home, { [UPSTREAM_API_KEY_ENV]: KEY }), {
        available: false,
        keyMatches: false,
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

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

test("provider revision changes with selected models, metadata, and server-compaction capability", () => {
  const token = "control-token-for-revision-test";
  const first = parseUpstreamProviderConfig(base());
  const selected = parseUpstreamProviderConfig({ ...base(), models: [{ id: "gpt-two" }] });
  const metadata = parseUpstreamProviderConfig({
    ...base(), models: [{ id: "gpt-one", metadata: { mode: "fallback" } }],
  });
  const compaction = parseUpstreamProviderConfig({ ...base(), supportsOpenAiServerCompaction: true });
  const revisions = [first, selected, metadata, compaction].map(config => upstreamProviderRevision(config, token));
  assert.equal(new Set(revisions).size, revisions.length);
});
