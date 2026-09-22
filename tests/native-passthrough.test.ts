import { expect, spyOn, test } from "bun:test";
import { forwardNativeCodexRequest, observeNativeResponsesLifecycle } from "../src/native-passthrough";

test("forwards native Codex requests verbatim to the official backend", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","stream":true}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
      host: "127.0.0.1:17841",
      connection: "keep-alive",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return new Response("data: native\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", connection: "keep-alive" },
    });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(upstreamRequest).toBeDefined();
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(upstreamRequest!.headers.get("connection")).toBeNull();
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("connection")).toBeNull();
  expect(await response.text()).toBe("data: native\n\n");
});

test("forwards native Codex compaction requests to the official compact endpoint", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","input":[]}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses/compact", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return Response.json({ output: [] }, { status: 200 });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: [] });
});

test("native compaction failures record routing evidence without exposing request content or credentials", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const endpoint of ["responses/compact", "responses"] as const) {
      const body = JSON.stringify({ model: "gpt-5.6-sol", input: [
        { role: "user", content: "PRIVATE_PROMPT" },
        ...(endpoint === "responses" ? [{ type: "compaction_trigger" }] : []),
      ] });
      const request = new Request(`http://127.0.0.1:17841/v1/${endpoint}`, {
        method: "POST", body,
        headers: { authorization: "Bearer PRIVATE_TOKEN", "chatgpt-account-id": "PRIVATE_ACCOUNT" },
      });
      const response = await forwardNativeCodexRequest(request, endpoint, async forwarded => {
        expect(await forwarded.text()).toBe(body);
        return Response.json({ detail: "Not Found" }, {
          status: 404, headers: { "x-request-id": "request-123", "cf-ray": "ray-123-KBP" },
        });
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ detail: "Not Found" });
    }
    const logs = warnings.mock.calls.map(call => String(call[0]));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('"endpoint":"responses/compact"');
    expect(logs[1]).toContain('"endpoint":"responses"');
    for (const log of logs) {
      expect(log).toContain('"model":"gpt-5.6-sol"');
      expect(log).toContain('"status":404');
      expect(log).toContain('"requestId":"request-123"');
      expect(log).toContain('"cfRay":"ray-123-KBP"');
      expect(log).not.toContain("PRIVATE_");
    }
  } finally {
    warnings.mockRestore();
  }
});

test("forwards standalone Web Search through the authenticated native Codex route", async () => {
  const body = JSON.stringify({ query: "Codex Web Search passthrough" });
  const request = new Request("http://127.0.0.1:17841/v1/alpha/search?locale=en", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      host: "127.0.0.1:17841",
    },
    body,
  });
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "alpha/search", async input => {
    upstreamRequest = input;
    return Response.json({ results: [{ title: "result" }] });
  });

  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?locale=en");
  expect(upstreamRequest!.method).toBe("POST");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(await upstreamRequest!.text()).toBe(body);
  expect(await response.json()).toEqual({ results: [{ title: "result" }] });
});

test("removes ChatGPT Web item identities before native Codex compaction", async () => {
  const body = {
    model: "gpt-5.6-sol",
    store: false,
    previous_response_id: "resp_local_web_turn",
    input: [
      {
        type: "reasoning",
        id: "rs_2e94d82c29b14b14bb34eae3252fa756",
        summary: [{ type: "summary_text", text: "Pro thinking" }],
        content: null,
        encrypted_content: null,
      },
      {
        type: "reasoning",
        id: "rs_11111111111111111111111111111111",
        summary: [{ type: "summary_text", text: "Bridge envelope reasoning" }],
        encrypted_content: "ocxr1:eyJ0eHQiOiJoaWRkZW4ifQ==",
      },
      {
        type: "message",
        id: "msg_22222222222222222222222222222222",
        role: "assistant",
        content: [{ type: "output_text", text: "Visible answer", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_33333333333333333333333333333333",
        call_id: "call_keep_linkage",
        name: "exec_command",
        arguments: "{}",
      },
      { type: "compaction_trigger" },
    ],
  };
  const originalBody = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  }, body);

  expect(upstreamRequest!.headers.get("content-encoding")).toBeNull();
  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input.every(item => !("id" in item))).toBe(true);
  expect(forwarded.input.some(item => "encrypted_content" in item
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.startsWith("ocxr1:"))).toBe(false);
  expect(forwarded.input[0]).toMatchObject({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Pro thinking" }],
  });
  expect(forwarded.input[2]).toMatchObject({
    type: "message",
    role: "assistant",
  });
  expect(forwarded.input[3]).toMatchObject({
    type: "function_call",
    call_id: "call_keep_linkage",
  });
  expect(forwarded.input.at(-1)).toEqual({ type: "compaction_trigger" });
});

test("converts ChatGPT Web compaction checkpoints before switching back to native Codex", async () => {
  const summary = "Keep the verified repository state and continue from the failing test.";
  const body = {
    model: "gpt-5.6-sol",
    previous_response_id: "resp_local_web_compaction",
    input: [
      {
        type: "compaction",
        id: "cmp_11111111111111111111111111111111",
        encrypted_content: `ocx1:${Buffer.from(summary, "utf8").toString("base64")}`,
      },
      {
        type: "compaction",
        id: "cmp_22222222222222222222222222222222",
        encrypted_content: "gAAAAABnative-opaque-compaction",
      },
      {
        type: "message",
        id: "msg_33333333333333333333333333333333",
        role: "user",
        content: [{ type: "input_text", text: "Continue with native Sol." }],
      },
    ],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  }, body);

  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input.every(item => !("id" in item))).toBe(true);
  expect(forwarded.input[0]).toMatchObject({
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: expect.stringContaining(summary),
    }],
  });
  expect(forwarded.input[1]).toEqual({
    type: "compaction",
    encrypted_content: "gAAAAABnative-opaque-compaction",
  });
  expect(JSON.stringify(forwarded)).not.toContain("ocx1:");
});

test("keeps native encrypted reasoning requests byte-for-byte intact", async () => {
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{
      type: "reasoning",
      id: "rs_44444444444444444444444444444444",
      summary: [],
      encrypted_content: "gAAAAABnative-opaque-reasoning",
    }],
  });
  const originalBody = Bun.zstdCompressSync(Buffer.from(body));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  });

  expect(upstreamRequest!.headers.get("content-encoding")).toBe("zstd");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
});

test("native passthrough fails closed without Codex bearer authentication", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  await expect(forwardNativeCodexRequest(request, "responses")).rejects.toThrow(
    "Native Codex passthrough requires the incoming Bearer authorization",
  );
});

test("forwards native model discovery as GET and preserves the client version query", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=0.99.0", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "old-etag" },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.99.0");
  expect(upstreamRequest!.method).toBe("GET");
  expect(upstreamRequest!.headers.get("if-none-match")).toBeNull();
});

test("repairs a missing models client_version from an exact first-party Codex user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "codex_chatgpt_desktop/0.151.0-alpha.7.2 (Mac OS 15.6; arm64) Codex",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.151.0");
});

test("does not invent a models client version from an unrelated user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "Mozilla/5.0 Codex/999.999.999",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models");
});

/** A reset after `data: [DONE]` is a completed stream, while a reset before it is a truncation. */
function nativeRequest(): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: '{"model":"gpt-5.6-sol","stream":true}',
  });
}

function resettingEventStream(
  prefix: string[],
  contentType = "text/event-stream",
): Response {
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < prefix.length) {
        controller.enqueue(encoder.encode(prefix[sent]!));
        sent += 1;
        return;
      }
      const reset = new Error("The socket connection was closed unexpectedly");
      (reset as Error & { code?: string }).code = "ECONNRESET";
      controller.error(reset);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

test("an upstream reset after the turn completed closes the client stream normally", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream([
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  const body = await response.text();
  expect(body).toContain("response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("event-stream media type matching is case-insensitive", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream(
      ["data: [DONE]\n\n"],
      "Text/Event-Stream; Charset=UTF-8",
    ),
  );

  expect(await response.text()).toBe("data: [DONE]\n\n");
});

test("an upstream reset is not hidden by a [DONE] string inside JSON content", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream([
      'event: response.output_text.delta\ndata: {"delta":"literal data: [DONE] text"}\n\n',
    ]),
  );

  // The marker is part of the JSON string, not an SSE data line. The upstream reset therefore
  // truncated the turn and must remain visible to the native client.
  await expect(response.text()).rejects.toThrow();
});

test("an upstream reset that truncated the turn is still surfaced as a failure", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream(['event: response.output_text.delta\ndata: {"delta":"half"}\n\n']),
  );

  await expect(response.text()).rejects.toThrow();
});

test("a non-event-stream body is passed through untouched", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
  );

  expect(await response.text()).toBe('{"ok":true}');
});

test("native Responses lifecycle ignores heartbeats but observes text, reasoning and tool progress", async () => {
  const frames = [
    'event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"answer"}\n\n',
    'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"think"}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{}"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":"{}"}]}}\n\n',
    'data: [DONE]\n\n',
  ].join("");
  let progress = 0;
  let final = 0;
  const observed = observeNativeResponsesLifecycle(
    new Response(frames, { headers: { "content-type": "text/event-stream" } }),
    {
      onProgress: () => { progress += 1; },
      onFinalResponse: () => { final += 1; },
    },
  );

  expect(await observed.text()).toBe(frames);
  expect(progress).toBe(4);
  expect(final).toBe(0);
});

test("native Responses lifecycle reports semantic terminal failures without reporting final completion", async () => {
  const cases = [
    new Response(
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","output":[]}}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ),
    Response.json({ status: "incomplete", output: [] }),
  ];
  for (const response of cases) {
    let failures = 0;
    let final = 0;
    const observed = observeNativeResponsesLifecycle(response, {
      onTerminalFailure: () => { failures += 1; },
      onFinalResponse: () => { final += 1; },
    });

    await observed.text();
    expect(failures).toBe(1);
    expect(final).toBe(0);
  }
});

test("native Responses lifecycle reports a terminal failure when the upstream body fails", async () => {
  let failures = 0;
  const observed = observeNativeResponsesLifecycle(
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"completed"'));
        controller.error(new Error("upstream body failed"));
      },
    }), { headers: { "content-type": "application/json" } }),
    { onTerminalFailure: () => { failures += 1; } },
  );

  await expect(observed.text()).rejects.toThrow("upstream body failed");
  expect(failures).toBe(1);
});

test("native Responses lifecycle emits terminal timeout without waiting for a stalled upstream cancel", async () => {
  const terminal = new AbortController();
  const observed = observeNativeResponsesLifecycle(
    new Response(new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => {});
      },
    }), { headers: { "content-type": "application/json" } }),
    { terminalSignal: terminal.signal },
  );
  const reading = observed.json();
  await Bun.sleep(0);
  terminal.abort(Object.assign(new Error("remote turn idle timeout"), {
    errorType: "server_error",
    code: "client_turn_idle_timeout",
    retryable: false,
  }));

  await expect(reading).resolves.toMatchObject({
    status: "failed",
    error: { type: "server_error", code: "client_turn_idle_timeout" },
    retryable: false,
  });
});
