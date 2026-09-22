import { expect, test } from "bun:test";
import { apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { upstreamApiKeyDigest, type UpstreamProviderRuntime } from "../src/upstream-provider";

const localKey = `cgw_${"a".repeat(43)}`;
const providerKey = "provider-key";

function titleBody(model: string, requestKind = "turn") {
  return {
    model,
    stream: false,
    reasoning: { effort: "low" },
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: requestKind,
        thread_source: "thread_title",
      }),
    },
    input: [{ role: "user", content: [{ type: "input_text", text: "Generate a title" }] }],
  };
}

function request(body: unknown, authorization = "Bearer codex-oauth-token") {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("thread_title forwards a native model directly without model discovery", async () => {
  const seen: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const response = await responseRequest(
    request(titleBody("gpt-5.6-sol")),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        const entry: { method: string; url: string; body?: Record<string, unknown> } = {
          method: upstream.method,
          url: upstream.url,
        };
        if (upstream.method === "POST") entry.body = await upstream.clone().json() as Record<string, unknown>;
        seen.push(entry);
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(seen.map(item => [item.method, new URL(item.url).pathname])).toEqual([
    ["POST", "/backend-api/codex/responses"],
  ]);
  expect(seen[0]!.body?.model).toBe("gpt-5.6-sol");
  expect(seen[0]!.body?.reasoning).toEqual({ effort: "low" });
});

test("thread_title maps chatgpt-web models to Luna and forwards directly", async () => {
  const bodies: Record<string, unknown>[] = [];
  const response = await responseRequest(
    request(titleBody("chatgpt-web/zero-risk-pro")),
    { ...defaultConfig(), browserInteractionMode: "manual", zeroRiskProEnabled: true, proAvailable: true },
    () => { throw new Error("Zero Risk adapter must not start for thread_title"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        expect(upstream.method).toBe("POST");
        bodies.push(await upstream.clone().json() as Record<string, unknown>);
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(bodies).toHaveLength(1);
  expect(bodies[0]!.model).toBe("gpt-5.6-luna");
  expect(bodies[0]!.reasoning).toEqual({ effort: "low" });
});

test("thread_title direct routing binds and completes the remote idle lifecycle for native and Web models", async () => {
  for (const model of ["gpt-5.6-sol", "chatgpt-web/zero-risk"] as const) {
    const body = titleBody(model);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      request_kind: "turn",
      thread_source: "thread_title",
      thread_id: `thread_${model}`,
      turn_id: `turn_${model}`,
    });
    const idle = new AbortController();
    let bound = 0;
    let completed = 0;
    let forwardedSignal: AbortSignal | undefined;
    const response = await responseRequest(
      request(body),
      { ...defaultConfig(), browserInteractionMode: "manual" },
      () => { throw new Error("Web adapter must not start for thread_title"); },
      {
        accessPolicy: OPENAI_ACCESS,
        onTurnIdentity: (identity, options) => {
          bound += 1;
          expect(identity).toEqual({ threadId: `thread_${model}`, turnId: `turn_${model}` });
          expect(options).toEqual({ remoteIdleTimeout: true });
          return idle.signal;
        },
        onTurnComplete: () => { completed += 1; },
        fetchNative: async upstream => {
          forwardedSignal = upstream.signal;
          return Response.json({ status: "completed", output: [] });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(bound).toBe(1);
    expect(completed).toBe(0);
    expect(await response.json()).toEqual({ status: "completed", output: [] });
    expect(completed).toBe(1);
    expect(forwardedSignal?.aborted).toBe(false);
    idle.abort();
    expect(forwardedSignal?.aborted).toBe(true);
  }
});

test("thread_title terminal upstream errors complete the remote idle lifecycle", async () => {
  for (const scenario of ["http-error", "transport-error"] as const) {
    const body = titleBody("gpt-5.6-sol");
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      request_kind: "turn",
      thread_source: "thread_title",
      thread_id: `thread_${scenario}`,
      turn_id: `turn_${scenario}`,
    });
    let bound = 0;
    let completed = 0;
    const response = await responseRequest(
      request(body),
      defaultConfig(),
      undefined,
      {
        accessPolicy: OPENAI_ACCESS,
        onTurnIdentity: () => {
          bound += 1;
          return new AbortController().signal;
        },
        onTurnComplete: () => { completed += 1; },
        fetchNative: async () => {
          if (scenario === "transport-error") throw new Error("upstream transport failed");
          return Response.json({ error: { message: "rate limited" } }, { status: 429 });
        },
      },
    );

    expect(response.status).toBe(scenario === "http-error" ? 429 : 502);
    await response.text();
    expect(bound).toBe(1);
    expect(completed).toBe(1);
  }
});

test("thread_title 2xx failed and incomplete responses complete the remote idle lifecycle", async () => {
  for (const status of ["failed", "incomplete"] as const) {
    const body = titleBody("gpt-5.6-sol");
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      request_kind: "turn",
      thread_source: "thread_title",
      thread_id: `thread_${status}`,
      turn_id: `turn_${status}`,
    });
    let completed = 0;
    const response = await responseRequest(
      request(body),
      defaultConfig(),
      undefined,
      {
        accessPolicy: OPENAI_ACCESS,
        onTurnIdentity: () => new AbortController().signal,
        onTurnComplete: () => { completed += 1; },
        fetchNative: async () => Response.json({ status, output: [] }),
      },
    );

    expect(response.status).toBe(200);
    expect(completed).toBe(0);
    expect((await response.json() as { status?: string }).status).toBe(status);
    expect(completed).toBe(1);
  }
});

test("thread_title rejects an invalid Web slug before forwarding", async () => {
  let calls = 0;
  const response = await responseRequest(
    request(titleBody("chatgpt-web/not-a-real-model")),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

test("thread_title rejects a Web slug unavailable in the current browser mode", async () => {
  let calls = 0;
  const response = await responseRequest(
    request(titleBody("chatgpt-web/high")),
    { ...defaultConfig(), browserInteractionMode: "manual" },
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(400);
  expect(calls).toBe(0);
});

test("thread_title returns the native upstream error without model discovery", async () => {
  const response = await responseRequest(
    request(titleBody("gpt-not-supported-upstream")),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        expect(upstream.method).toBe("POST");
        return Response.json(
          { error: { type: "invalid_request_error", code: "model_not_supported", message: "unsupported model" } },
          { status: 400 },
        );
      },
    },
  );

  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("model_not_supported");
});

test("thread_title Web routing uses the configured API-key model selection without discovery", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-5.6-luna" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  const seen: Request[] = [];
  const response = await responseRequest(
    request(titleBody("chatgpt-web/zero-risk"), `Bearer ${localKey}`),
    { ...defaultConfig(), browserInteractionMode: "manual" },
    () => { throw new Error("Zero Risk adapter must not start for thread_title"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async upstream => {
        seen.push(upstream.clone());
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(seen.map(item => [item.method, item.url])).toEqual([
    ["POST", "https://provider.example/openai/v1/responses"],
  ]);
  expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${providerKey}`);
  expect((await seen[0]!.json() as { model: string }).model).toBe("gpt-5.6-luna");
});

test("thread_title rejects an API-key Web route when mapped Luna is not selected", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-other" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  let calls = 0;
  const response = await responseRequest(
    request(titleBody("chatgpt-web/zero-risk"), `Bearer ${localKey}`),
    { ...defaultConfig(), browserInteractionMode: "manual" },
    () => { throw new Error("Zero Risk adapter must not start for thread_title"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("model_not_supported");
  expect(calls).toBe(0);
});

test("thread_title passes through an API-key upstream rejection for a selected model", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: true,
    keyMatches: true,
    apiKey: providerKey,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-selected" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  const response = await responseRequest(
    request(titleBody("gpt-selected"), `Bearer ${localKey}`),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async upstream => {
        expect(upstream.method).toBe("POST");
        return Response.json(
          { error: { type: "invalid_request_error", code: "model_not_supported", message: "unsupported model" } },
          { status: 400 },
        );
      },
    },
  );

  expect(response.status).toBe(400);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("model_not_supported");
});

test("thread_title selected API-key model reports provider unavailability instead of model_not_supported", async () => {
  const runtime: UpstreamProviderRuntime = {
    available: false,
    keyMatches: false,
    config: {
      version: 2,
      baseUrl: "https://provider.example/openai/v1/",
      apiKeySha256: upstreamApiKeyDigest(providerKey),
      proxy: { mode: "direct" },
      models: [{ id: "gpt-selected" }],
      supportsOpenAiServerCompaction: false,
    },
  };
  let calls = 0;
  const response = await responseRequest(
    request(titleBody("gpt-selected"), `Bearer ${localKey}`),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for thread_title"); },
    {
      accessPolicy: apiKeyPolicy(localKey),
      upstreamRuntime: runtime,
      fetchUpstreamProvider: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(502);
  expect((await response.json() as { error: { code: string } }).error.code).not.toBe("model_not_supported");
  expect(calls).toBe(0);
});

test("thread_title source alone does not activate the title route", async () => {
  const seen: Request[] = [];
  const response = await responseRequest(
    request(titleBody("gpt-5.6-sol", "compaction")),
    defaultConfig(),
    () => { throw new Error("Web adapter must not start for native models"); },
    {
      accessPolicy: OPENAI_ACCESS,
      fetchNative: async upstream => {
        seen.push(upstream.clone());
        return Response.json({ ok: true });
      },
    },
  );

  expect(response.status).toBe(200);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.method).toBe("POST");
  expect(new URL(seen[0]!.url).pathname).toBe("/backend-api/codex/responses");
});
