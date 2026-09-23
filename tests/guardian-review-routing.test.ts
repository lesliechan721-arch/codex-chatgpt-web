import { expect, test } from "bun:test";
import { isCodexGuardianReviewRequestFromBody } from "../src/adapters/chatgpt-web/environment";
import { apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { upstreamApiKeyDigest, type UpstreamProviderRuntime } from "../src/upstream-provider";

const localKey = `cgw_${"a".repeat(43)}`;
const providerKey = "provider-key";

function guardianBody(
  model: string,
  metadata: Record<string, unknown> = {
    request_kind: "turn",
    thread_source: "guardian_review",
    turn_trigger: "guardian_review",
  },
) {
  return {
    model,
    stream: false,
    reasoning: { effort: "low" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify(metadata),
    },
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "Review this approval request" }],
    }],
  };
}

function request(body: unknown, authorization = "Bearer codex-oauth-token") {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function nativeModel(slug: string, visibility = "list") {
  return {
    slug,
    display_name: slug,
    description: slug,
    visibility,
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    default_reasoning_level: "low",
    tool_mode: "code_mode_only",
    context_window: 100_000,
    max_context_window: 100_000,
    auto_compact_token_limit: 80_000,
  };
}

async function routeGuardian(
  models: ReturnType<typeof nativeModel>[],
  model = "chatgpt-web/high",
  config = defaultConfig(),
) {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const response = await responseRequest(
    request(guardianBody(model)),
    config,
    () => { throw new Error("Web adapter must not start for Guardian review"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        const path = new URL(upstream.url).pathname;
        if (upstream.method === "GET" && path === "/backend-api/codex/models") {
          requests.push({ path, method: upstream.method });
          return Response.json({ models });
        }
        if (upstream.method === "POST" && path === "/backend-api/codex/responses") {
          requests.push({
            path,
            method: upstream.method,
            body: await upstream.clone().json() as Record<string, unknown>,
          });
          return Response.json({ status: "completed", output: [] });
        }
        throw new Error(`Unexpected native request: ${upstream.method} ${path}`);
      },
    },
  );
  return { response, requests };
}

test("Guardian review prefers codex-auto-review and bypasses the Web adapter", async () => {
  const { response, requests } = await routeGuardian([
    nativeModel("gpt-6-luna"),
    nativeModel("codex-auto-review", "hide"),
  ]);

  expect(response.status).toBe(200);
  expect(requests.map(item => [item.method, item.path])).toEqual([
    ["GET", "/backend-api/codex/models"],
    ["POST", "/backend-api/codex/responses"],
  ]);
  expect(requests[1]!.body?.model).toBe("codex-auto-review");
});

test("Guardian review falls back to Luna when codex-auto-review is absent", async () => {
  const { response, requests } = await routeGuardian([
    nativeModel("gpt-6-luna"),
  ]);

  expect(response.status).toBe(200);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.body?.model).toBe("gpt-6-luna");
});

test("Guardian review rejects when neither review model exists", async () => {
  const { response, requests } = await routeGuardian([
    nativeModel("gpt-5.6-sol"),
  ]);

  expect(response.status).toBe(400);
  expect(requests).toHaveLength(1);
  expect((await response.json() as { error?: { code?: string } }).error?.code)
    .toBe("model_not_supported");
});

test("Guardian review rejects unknown Web routes before model discovery", async () => {
  const { response, requests } = await routeGuardian(
    [nativeModel("gpt-6-luna")],
    "chatgpt-web/not-enabled",
  );

  expect(response.status).toBe(400);
  expect(requests).toHaveLength(0);
  expect((await response.json() as { error?: { message?: string } }).error?.message)
    .toContain("ChatGPT web model is not enabled");
});

test("Guardian review rejects Web routes unavailable in the current browser mode before discovery", async () => {
  const { response, requests } = await routeGuardian(
    [nativeModel("gpt-6-luna")],
    "chatgpt-web/high",
    { ...defaultConfig(), browserInteractionMode: "manual" },
  );

  expect(response.status).toBe(400);
  expect(requests).toHaveLength(0);
  expect((await response.json() as { error?: { message?: string } }).error?.message)
    .toContain("not available while Zero Risk is enabled");
});

test("Guardian review preserves native models without model discovery", async () => {
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const response = await responseRequest(
    request(guardianBody("gpt-5.6-sol")),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for Guardian review"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        const path = new URL(upstream.url).pathname;
        requests.push({
          path,
          method: upstream.method,
          body: upstream.method === "POST"
            ? await upstream.clone().json() as Record<string, unknown>
            : undefined,
        });
        return Response.json({ status: "completed", output: [] });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(requests.map(item => [item.method, item.path])).toEqual([
    ["POST", "/backend-api/codex/responses"],
  ]);
  expect(requests[0]!.body?.model).toBe("gpt-5.6-sol");
});

test("Guardian review uses the same interception in API-key mode", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "codex-auto-review" }, { id: "gpt-6-luna" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const response = await responseRequest(
    request(guardianBody("chatgpt-web/high"), `Bearer ${localKey}`),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for Guardian review"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async upstream => {
        const entry: { method: string; url: string; body?: Record<string, unknown> } = {
          method: upstream.method,
          url: upstream.url,
        };
        if (upstream.method === "POST") {
          entry.body = await upstream.clone().json() as Record<string, unknown>;
        }
        seen.push(entry);
        if (upstream.method === "GET") {
          return Response.json({
            object: "list",
            data: [{ id: "codex-auto-review" }, { id: "gpt-6-luna" }],
          });
        }
        return Response.json({ status: "completed", output: [] });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(seen.map(item => [item.method, item.url])).toEqual([
    ["GET", "https://provider.example/openai/v1/models"],
    ["POST", "https://provider.example/openai/v1/responses"],
  ]);
  expect(seen[1]!.body?.model).toBe("codex-auto-review");
});

test("Guardian review preserves supported native models in API-key mode", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-6-luna" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const response = await responseRequest(
    request(guardianBody("gpt-6-luna"), `Bearer ${localKey}`),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for Guardian review"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async upstream => {
        seen.push({
          method: upstream.method,
          url: upstream.url,
          body: upstream.method === "POST"
            ? await upstream.clone().json() as Record<string, unknown>
            : undefined,
        });
        return Response.json({ status: "completed", output: [] });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(seen.map(item => [item.method, item.url])).toEqual([
    ["POST", "https://provider.example/openai/v1/responses"],
  ]);
  expect(seen[0]!.body?.model).toBe("gpt-6-luna");
});

test("Guardian review rejects unsupported native models in API-key mode without discovery", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-6-luna" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  const response = await responseRequest(
    request(guardianBody("gpt-5.6-sol"), `Bearer ${localKey}`),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for Guardian review"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async () => {
        throw new Error("Unsupported native Guardian review must not reach the upstream provider");
      },
    },
  );

  expect(response.status).toBe(400);
  expect((await response.json() as { error?: { code?: string } }).error?.code)
    .toBe("model_not_supported");
});

test("Guardian review detection accepts current turn_trigger and thread_source metadata", () => {
  expect(isCodexGuardianReviewRequestFromBody(guardianBody("chatgpt-web/high", {
    request_kind: "turn",
    thread_source: "system",
    turn_trigger: "guardian_review",
  }))).toBe(true);
  expect(isCodexGuardianReviewRequestFromBody(guardianBody("chatgpt-web/high", {
    request_kind: "turn",
    thread_source: "guardian_review",
  }))).toBe(true);
  expect(isCodexGuardianReviewRequestFromBody(guardianBody("chatgpt-web/high", {
    request_kind: "compaction",
    thread_source: "guardian_review",
    turn_trigger: "guardian_review",
  }))).toBe(false);
});
