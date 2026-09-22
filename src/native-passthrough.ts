import { readJsonRequestBody } from "./http-body";
import {
  BRIDGE_COMPACTION_PREFIX,
  SUMMARY_PREFIX,
  decodeCompactionSummary,
} from "./responses/compaction";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";
import { fetchNativeCodex } from "./native-network";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const FIRST_PARTY_CODEX_ORIGINATORS = new Set([
  "codex_cli_rs",
  "codex-tui",
  "codex_vscode",
  "codex_atlas",
  "codex_chatgpt_desktop",
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeFetch = (request: Request) => Promise<Response>;
export type NativeImageEndpoint = "images/generations" | "images/edits";
export type NativeCodexEndpoint = "models" | "responses" | "responses/compact" | "alpha/search" | NativeImageEndpoint;

export interface NativeResponsesLifecycleObserver {
  onProgress?: () => void;
  onFinalResponse?: () => void;
  onTerminalFailure?: () => void;
  terminalSignal?: AbortSignal;
}

type JsonObject = Record<string, unknown>;
type BridgeCompactionItem = JsonObject & { type: "compaction"; encrypted_content: string };

function firstPartyCodexOriginator(value: string): boolean {
  return FIRST_PARTY_CODEX_ORIGINATORS.has(value)
    || /^Codex [A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value);
}

/**
 * Current Codex clients identify themselves as `<originator>/<cargo semver> (...)`. The models
 * backend requires the release-only `major.minor.patch` value even when the client is an alpha.
 * Derive it only from the documented first-party Codex prefix; an arbitrary browser or proxy
 * User-Agent is not evidence of a Codex version and leaves the original request untouched.
 */
export function codexClientVersionFromUserAgent(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  const separator = userAgent.indexOf("/");
  if (separator < 1) return undefined;
  const originator = userAgent.slice(0, separator);
  if (!firstPartyCodexOriginator(originator)) return undefined;
  const version = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/
    .exec(userAgent.slice(separator + 1));
  return version ? `${version[1]}.${version[2]}.${version[3]}` : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeDiagnosticId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function isBridgeReasoningItem(value: unknown): value is JsonObject {
  if (!isObject(value) || value.type !== "reasoning") return false;
  const encrypted = value.encrypted_content;
  if (typeof encrypted === "string" && encrypted.startsWith(BRIDGE_REASONING_PREFIX)) return true;
  return typeof value.id === "string"
    && /^rs_[0-9a-f]{32}$/i.test(value.id)
    && (encrypted === undefined || encrypted === null)
    && (Array.isArray(value.summary) || Array.isArray(value.content));
}

function isBridgeCompactionItem(value: unknown): value is BridgeCompactionItem {
  return isObject(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(BRIDGE_COMPACTION_PREFIX);
}

/**
 * Response item ids are scoped to the backend that created them. A ChatGPT Web response is
 * generated locally, so replaying its `rs_*` id after switching back to native Codex makes the
 * official backend try to load an item it has never stored. The same boundary applies to local
 * `ocx1:` compaction checkpoints: preserve their decoded summary as a normal input message rather
 * than asking the official backend to decrypt a bridge-owned envelope. Once either artifact proves
 * that the history crossed providers, send the complete item content without provider-local ids.
 */
export function scrubBridgeArtifactsForNative(value: unknown): { value: unknown; changed: boolean } {
  if (!isObject(value)
    || !Array.isArray(value.input)
    || !value.input.some(item => isBridgeReasoningItem(item) || isBridgeCompactionItem(item))) {
    return { value, changed: false };
  }

  const input = value.input.flatMap(item => {
    if (!isObject(item)) return [item];
    const clean = { ...item };
    delete clean.id;
    if (isBridgeCompactionItem(clean)) {
      const summary = decodeCompactionSummary(clean.encrypted_content);
      if (summary === null) throw new Error("Invalid ChatGPT Web compaction checkpoint");
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
      }];
    }
    if (clean.type !== "reasoning") return [clean];

    if (typeof clean.encrypted_content === "string"
      && clean.encrypted_content.startsWith(BRIDGE_REASONING_PREFIX)) {
      delete clean.encrypted_content;
    } else if (clean.encrypted_content === null) {
      delete clean.encrypted_content;
    }

    const hasSummary = Array.isArray(clean.summary) && clean.summary.length > 0;
    const hasContent = Array.isArray(clean.content) && clean.content.length > 0;
    const hasNativeEncryptedContent = typeof clean.encrypted_content === "string";
    return hasSummary || hasContent || hasNativeEncryptedContent ? [clean] : [];
  });
  const clean: JsonObject = { ...value, input };
  delete clean.previous_response_id;
  return { value: clean, changed: true };
}

export function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

/** Terminator every Responses SSE stream ends with; nothing after it carries meaning. */
const SSE_TERMINATOR = "data: [DONE]";

/**
 * ChatGPT's backend routinely resets the native Codex connection instead of closing it cleanly,
 * which Bun surfaces as ECONNRESET while reading the body. Passed through untouched that reaches
 * Codex as a truncated HTTP body and the opaque "error decoding response body".
 *
 * A reset that arrives after the stream already delivered `data: [DONE]` is an unclean TCP close on
 * a turn that finished: every byte the protocol defines has been forwarded, so the stream is closed
 * normally rather than failed. A reset before that genuinely truncated the turn and is still raised,
 * because inventing a terminal event there would tell Codex a turn ended when it did not.
 */
export function withUncleanCloseTolerance(
  body: ReadableStream<Uint8Array>,
  isEventStream: boolean,
  onUncleanClose?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  if (!isEventStream) return body;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let lineBuffer = "";
  let completed = false;
  let bytes = 0;
  const inspectLines = (text: string): void => {
    lineBuffer += text;
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line === SSE_TERMINATOR) completed = true;
      newline = lineBuffer.indexOf("\n");
    }
  };
  const inspectTrailingLine = (): void => {
    // A reset can arrive before the final line separator. Treat only an exact unterminated
    // terminator line as complete; text embedded in a JSON data payload must not qualify.
    if (lineBuffer.replace(/\r$/, "") === SSE_TERMINATOR) completed = true;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          inspectLines(decoder.decode());
          inspectTrailingLine();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        inspectLines(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      } catch (error) {
        inspectTrailingLine();
        if (!completed) {
          controller.error(error);
          return;
        }
        onUncleanClose?.(bytes);
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function nativeToolCallItem(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  return value.type === "function_call"
    || value.type === "custom_tool_call"
    || value.type === "tool_search_call"
    || value.type === "web_search_call"
    || value.type === "computer_call"
    || value.type === "local_shell_call"
    || value.type === "mcp_call";
}

function nativeBusinessProgress(type: string, payload: JsonObject): boolean {
  if (type.endsWith(".delta")) {
    return typeof payload.delta !== "string" || payload.delta.length > 0;
  }
  if (type === "response.output_item.added" || type === "response.output_item.done") return true;
  return type.startsWith("response.function_call_")
    || type.startsWith("response.custom_tool_call_")
    || type.startsWith("response.tool_search_call_")
    || type.startsWith("response.compaction.");
}

function terminalSignalError(signal: AbortSignal | undefined): {
  message: string;
  type: string;
  code: string;
  retryable: boolean;
} | undefined {
  if (!signal?.aborted || !(signal.reason instanceof Error)) return undefined;
  const reason = signal.reason as Error & {
    errorType?: unknown;
    code?: unknown;
    retryable?: unknown;
  };
  if (typeof reason.errorType !== "string" || typeof reason.code !== "string") return undefined;
  return {
    message: reason.message,
    type: reason.errorType,
    code: reason.code,
    retryable: reason.retryable === true,
  };
}

/**
 * Observe native Responses output without consuming or rewriting normal upstream bytes. Only
 * semantic Responses events renew the remote-turn lease; transport chunks and heartbeat events do
 * not. A final response releases the logical turn only when it does not hand control back for a
 * tool call.
 */
export function observeNativeResponsesLifecycle(
  response: Response,
  observer: NativeResponsesLifecycleObserver,
): Response {
  if (!response.body || !response.ok) return response;
  const isEventStream = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let jsonBuffer = "";
  const jsonChunks: Uint8Array[] = [];
  let sawToolCall = false;
  let finalReported = false;
  let failureReported = false;
  let terminalReported = false;

  const reportTerminalFailure = (): void => {
    if (finalReported || failureReported) return;
    failureReported = true;
    observer.onTerminalFailure?.();
  };

  const inspectPayload = (value: unknown, eventName?: string): void => {
    if (!isObject(value)) return;
    const type = typeof value.type === "string" ? value.type : eventName;
    if (type && nativeBusinessProgress(type, value)) observer.onProgress?.();
    if ((type === "response.output_item.added" || type === "response.output_item.done")
      && nativeToolCallItem(value.item)) {
      sawToolCall = true;
    }

    const response = isObject(value.response) ? value.response : value;
    const status = typeof response.status === "string" ? response.status : undefined;
    if (type === "response.failed" || type === "response.incomplete"
      || status === "failed" || status === "incomplete") {
      reportTerminalFailure();
      return;
    }
    const completed = type === "response.completed" || value.status === "completed";
    if (!completed || failureReported) return;
    observer.onProgress?.();
    const completedResponse = response;
    const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
    const requiresToolContinuation = sawToolCall || output.some(nativeToolCallItem);
    const endTurn = completedResponse.end_turn;
    if (!finalReported && (endTurn === true || (endTurn !== false && !requiresToolContinuation))) {
      finalReported = true;
      observer.onFinalResponse?.();
    }
  };

  const inspectSse = (text: string, flush = false): void => {
    sseBuffer += text;
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(sseBuffer);
      if (!boundary) break;
      const frame = sseBuffer.slice(0, boundary.index);
      sseBuffer = sseBuffer.slice(boundary.index + boundary[0].length);
      const lines = frame.split(/\r?\n/);
      const eventName = lines.find(line => line.startsWith("event:"))?.slice("event:".length).trim();
      const data = lines.filter(line => line.startsWith("data:"))
        .map(line => line.slice("data:".length).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { inspectPayload(JSON.parse(data), eventName); } catch { /* Preserve malformed upstream bytes verbatim. */ }
    }
    if (!flush || !sseBuffer.trim()) return;
    const lines = sseBuffer.split(/\r?\n/);
    const eventName = lines.find(line => line.startsWith("event:"))?.slice("event:".length).trim();
    const data = lines.filter(line => line.startsWith("data:"))
      .map(line => line.slice("data:".length).trimStart()).join("\n");
    if (data && data !== "[DONE]") {
      try { inspectPayload(JSON.parse(data), eventName); } catch { /* Preserve malformed upstream bytes verbatim. */ }
    }
    sseBuffer = "";
  };

  const emitTerminalTimeout = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    const error = terminalSignalError(observer.terminalSignal);
    if (!error || terminalReported) return false;
    terminalReported = true;
    if (isEventStream) {
      controller.enqueue(encoder.encode(
        `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: { status: "failed", error, retryable: error.retryable },
        })}\n\ndata: [DONE]\n\n`,
      ));
    } else {
      controller.enqueue(encoder.encode(JSON.stringify({
        object: "response",
        status: "failed",
        output: [],
        error,
        last_error: error,
        retryable: error.retryable,
      })));
    }
    controller.close();
    return true;
  };

  const readChunkOrTerminal = async () => {
    const signal = observer.terminalSignal;
    if (!signal) return await reader.read();
    if (signal.aborted) return undefined;
    let onAbort: (() => void) | undefined;
    const terminal = new Promise<undefined>(resolve => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([reader.read(), terminal]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (observer.terminalSignal?.aborted) {
            void reader.cancel(observer.terminalSignal.reason).catch(() => {});
            if (emitTerminalTimeout(controller)) return;
            throw observer.terminalSignal.reason ?? new Error("Native Responses stream aborted");
          }
          const chunk = await readChunkOrTerminal();
          if (!chunk) {
            void reader.cancel(observer.terminalSignal?.reason).catch(() => {});
            if (emitTerminalTimeout(controller)) return;
            throw observer.terminalSignal?.reason ?? new Error("Native Responses stream aborted");
          }
          if (observer.terminalSignal?.aborted) {
            void reader.cancel(observer.terminalSignal.reason).catch(() => {});
            if (emitTerminalTimeout(controller)) return;
            throw observer.terminalSignal.reason ?? new Error("Native Responses stream aborted");
          }
          if (chunk.done) {
            const tail = decoder.decode();
            if (isEventStream) inspectSse(tail, true);
            else {
              jsonBuffer += tail;
              if (jsonBuffer) {
                try { inspectPayload(JSON.parse(jsonBuffer)); } catch { /* Preserve invalid upstream JSON. */ }
              }
              for (const buffered of jsonChunks) controller.enqueue(buffered);
            }
            controller.close();
            return;
          }
          const text = decoder.decode(chunk.value, { stream: true });
          if (isEventStream) {
            inspectSse(text);
            controller.enqueue(chunk.value);
            return;
          }
          jsonBuffer += text;
          jsonChunks.push(chunk.value);
        }
      } catch (error) {
        if (emitTerminalTimeout(controller)) return;
        reportTerminalFailure();
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const headers = new Headers(response.headers);
  if (!isEventStream) headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetchNativeCodex,
  decodedBody?: unknown,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  if (endpoint === "models" && !incomingUrl.searchParams.has("client_version")) {
    const clientVersion = codexClientVersionFromUserAgent(request.headers.get("user-agent"));
    if (clientVersion) incomingUrl.searchParams.set("client_version", clientVersion);
  }
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  const imageRequest = endpoint === "images/generations" || endpoint === "images/edits";
  let compactionRequest = endpoint === "responses/compact";
  let model: string | undefined;
  let body: BodyInit | undefined;
  if (imageRequest) {
    // Standalone image requests use their own schema; never interpret them as Responses history.
    body = await request.arrayBuffer();
  } else if (method === "POST") {
    const parseRequest = decodedBody === undefined ? request.clone() : undefined;
    const originalBody = await request.arrayBuffer();
    const parsedBody = decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody;
    if (isObject(parsedBody)) {
      if (typeof parsedBody.model === "string" && /^[A-Za-z0-9_./:-]{1,128}$/.test(parsedBody.model)) {
        model = parsedBody.model;
      }
      const tail = Array.isArray(parsedBody.input) ? parsedBody.input.at(-1) : undefined;
      compactionRequest ||= endpoint === "responses" && isObject(tail) && tail.type === "compaction_trigger";
    }
    const scrubbed = scrubBridgeArtifactsForNative(parsedBody);
    if (scrubbed.changed) {
      headers.delete("content-encoding");
      body = JSON.stringify(scrubbed.value);
    } else {
      body = originalBody;
    }
  }
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
    // Images create work: preserve redirects as responses instead of replaying a POST or
    // forwarding account headers to a redirect destination.
    redirect: imageRequest ? "manual" : "follow",
  });
  const upstream = await fetchUpstream(upstreamRequest);
  if (compactionRequest && !upstream.ok) {
    console.warn(`[codex-chatgpt-web] native_compaction_upstream_failed ${JSON.stringify({
      endpoint, model, status: upstream.status,
      requestId: nativeDiagnosticId(upstream.headers.get("x-request-id")),
      cfRay: nativeDiagnosticId(upstream.headers.get("cf-ray")),
    })}`);
  }
  const responseHeaders = endToEndHeaders(upstream.headers);
  // fetch exposes decompressed image JSON; retaining gzip/br would make Codex decode it twice.
  if (imageRequest) responseHeaders.delete("content-encoding");
  const isEventStream = (upstream.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  return new Response(
    upstream.body
      ? withUncleanCloseTolerance(upstream.body, isEventStream, bytes => {
        console.warn(
          `[codex-chatgpt-web] native_upstream_unclean_close endpoint=${endpoint} bytes=${bytes}`
          + " (turn had already completed; closing the client stream normally)",
        );
      })
      : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}
