import { chatGptWebTraceId, createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  beginCancelStructuredCompactionTrace,
} from "./adapters/chatgpt-web/compaction-handoff";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
  extractChatGptCompactionSourceRevision,
  isCodexGuardianReviewRequestFromBody,
  isCodexThreadTitleRequestFromBody,
} from "./adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "./adapters/chatgpt-web/compaction-continuation";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import { buildStandaloneModelCatalog } from "./standalone-model-catalog";
import { loadApiAccessPolicy } from "./api-access-config";
import {
  OPENAI_ACCESS,
  MODEL_CATALOG_STATUS_HEADER,
  adapterRequestHeaders,
  apiAccessError,
  apiKeyMatches,
  authenticateApiRequest,
  guardApiRequest,
  parseApiAccessPolicy,
  apiAccessRevision,
  requireWebModelInApiKeyMode,
  type ApiAccessPolicy,
} from "./api-access";
import { loadUpstreamProviderRuntime } from "./upstream-provider-config";
import {
  upstreamModelAllowed,
  upstreamProviderRevision,
  type UpstreamProviderRuntime,
} from "./upstream-provider";
import {
  mergeUpstreamModelCatalog,
  upstreamMetadataRepairCount,
} from "./upstream-model-catalog";
import {
  forwardUpstreamProviderRequest,
  type UpstreamFetch,
} from "./upstream-passthrough";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import {
  forwardNativeCodexRequest,
  observeNativeResponsesLifecycle,
  type NativeFetch,
  type NativeImageEndpoint,
} from "./native-passthrough";
import { fetchNativeCodex } from "./native-network";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";
import { NativeTurnIdleRegistry } from "./native-turn-idle";
import { remoteTurnIdleTimeoutSec, responsesListenHost } from "./server-remote-config";

type HttpTrackedEndpoint = "models" | "responses" | "compact" | "search" | "unspecified" | NativeImageEndpoint;

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

function safeStreamErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function streamFailureEvidence(
  error: unknown,
  httpTurnId: number,
  endpoint: HttpTrackedEndpoint,
  reader: HttpStreamFailureEvidence["reader"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureEvidence {
  const candidate = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    httpTurnId,
    endpoint,
    reader,
    platform,
    chunks,
    bytes,
    errorName: safeStreamErrorField(candidate.name, "Error"),
    errorCode: safeStreamErrorField(candidate.code, "unknown"),
  };
}

const reportHttpStreamFailure: HttpStreamFailureReporter = evidence => {
  console.warn(`[codex-chatgpt-web] http_stream_failed ${JSON.stringify(evidence)}`);
};

function emitHttpStreamFailure(
  reporter: HttpStreamFailureReporter,
  evidence: HttpStreamFailureEvidence,
): void {
  try {
    reporter(evidence);
  } catch {
    // Diagnostics are a side channel: they must never replace the source stream error or retain
    // HTTP turn ownership after the client has already observed that failure.
  }
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    release?: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  constructor(private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
      turn.release?.();
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
    abortTransport = true,
  ): { cancelled: number; settlement: Promise<void> } {
    if (abortTransport) this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (abortTransport && !turn.abort.signal.aborted) turn.abort.abort(reason);
      turn.release?.();
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    endpoint: HttpTrackedEndpoint = "unspecified",
    onClientDisconnect?: (identity: NativeCodexTurnIdentity, reason: unknown) => void,
  ): Promise<Response> {
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      release?: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    let clientDisconnected = false;
    let clientDisconnectReason: unknown;
    let clientDisconnectNotified = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    tracked.release = release;
    const notifyClientDisconnect = () => {
      if (!clientDisconnected || clientDisconnectNotified || !tracked.identity || !onClientDisconnect) return;
      clientDisconnectNotified = true;
      onClientDisconnect(tracked.identity, clientDisconnectReason);
    };
    clientAbortListener = () => {
      clientDisconnected = true;
      clientDisconnectReason = clientSignal?.reason ?? new DOMException("HTTP client disconnected", "AbortError");
      if (!abort.signal.aborted) abort.abort(clientDisconnectReason);
      release();
      notifyClientDisconnect();
    };
    if (clientSignal?.aborted) clientAbortListener();
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = identity;
        notifyClientDisconnect();
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        const reportStreamFailure = this.reportStreamFailure;
        let chunks = 0;
        let bytes = 0;
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              chunks += 1;
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            } catch (error) {
              if (!abort.signal.aborted) {
                emitHttpStreamFailure(reportStreamFailure, streamFailureEvidence(
                  error,
                  id,
                  endpoint,
                  "client",
                  platform,
                  chunks,
                  bytes,
                ));
              }
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      let chunks = 0;
      let bytes = 0;
      streamAbortListener = () => {
        void Promise.allSettled([
          reader.cancel(abort.signal.reason),
          clientBody.cancel(abort.signal.reason),
        ]).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks += 1;
            bytes += chunk.value.byteLength;
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            emitHttpStreamFailure(this.reportStreamFailure, streamFailureEvidence(
              error,
              id,
              endpoint,
              "windows_lifecycle",
              platform,
              chunks,
              bytes,
            ));
          }
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** Explicit HTTP policy; internal DEV callers retain their existing in-process behavior. */
  accessPolicy?: ApiAccessPolicy;
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent, context: { compaction: boolean }) => void;
  /** Observe proven native-turn progress at its source, before replay or output buffering. */
  onTurnProgress?: () => void;
  /** Observe a client-delivered progress item once per native turn, so request replay cannot renew the lease. */
  onTurnInputProgress?: (identity: NativeCodexTurnIdentity, progressKey: string) => void;
  /** Release the remote native-turn lease after authoritative logical completion. */
  onTurnComplete?: () => void;
  /** Check remote-turn admission before constructing the Web adapter, without creating its idle lease. */
  onTurnAdmission?: (
    identity: NativeCodexTurnIdentity,
    options?: { remoteIdleTimeout: boolean },
  ) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (
    identity: NativeCodexTurnIdentity,
    options?: { remoteIdleTimeout: boolean },
  ) => AbortSignal | void;
  /** Startup snapshot for the optional API-key-mode custom upstream. */
  upstreamRuntime?: UpstreamProviderRuntime;
  /** Test seam for the custom upstream transport. */
  fetchUpstreamProvider?: UpstreamFetch;
  /** Test seam for native ChatGPT Codex passthrough. */
  fetchNative?: NativeFetch;
  /** Check only routed Web work; native upstream requests do not use the local broker. */
  brokerAvailable?: () => Promise<boolean>;
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config, parsed.options.reasoning);
  if (route.interactionMode === "automatic" && route.modelFamily) parsed._chatgptModelFamily = route.modelFamily;
  else delete parsed._chatgptModelFamily;
  parsed.modelId = route.backendModel;
  // Zero Risk preserves a distinct backend identity. Its immutable Codex effort is only a
  // protocol/catalog value; the manual adapter must never reinterpret it as a ChatGPT selection.
  parsed.options.reasoning = route.interactionMode === "automatic"
    ? route.adapterEffort
    : route.codexEffort;
  return route;
}

interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

function adapterErrorResponse(error: ChatGptWebAdapterError): Response {
  return Response.json({
    error: {
      message: error.message,
      type: error.errorType,
      code: error.code,
    },
    retryable: error.retryable,
  }, { status: error.status });
}

function nativeToolResultProgressKeys(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const input = (raw as { input?: unknown }).input;
  if (!Array.isArray(input)) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as { type?: unknown; call_id?: unknown };
    if (item.type !== "function_call_output"
      && item.type !== "custom_tool_call_output"
      && item.type !== "tool_search_output") continue;
    if (typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    const key = `tool-result:${item.call_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

const UPSTREAM_MODEL_CATALOG_TIMEOUT_MS = 15_000;

function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return { stage, ...(typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { code } : {}) };
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  accessPolicyOrFailure: ApiAccessPolicy | ((failure: ModelCatalogFailure) => void) = OPENAI_ACCESS,
  onFailure?: (failure: ModelCatalogFailure) => void,
  upstreamRuntime?: UpstreamProviderRuntime,
  fetchCustomUpstream?: UpstreamFetch,
): Promise<Response> {
  const accessPolicy = typeof accessPolicyOrFailure === "function" ? OPENAI_ACCESS : accessPolicyOrFailure;
  const reportFailure = typeof accessPolicyOrFailure === "function" ? accessPolicyOrFailure : onFailure;
  const denied = authenticateApiRequest(req, accessPolicy);
  if (denied) return denied;
  if (accessPolicy.mode === "api-key") {
    const local = buildStandaloneModelCatalog(config);
    const catalogHeaders = {
      "cache-control": "no-store",
      [MODEL_CATALOG_STATUS_HEADER]: "complete",
      "x-codex-chatgpt-web-api-access-revision": apiAccessRevision(accessPolicy, config.controlToken),
      ...(upstreamRuntime?.config ? {
        "x-codex-chatgpt-web-upstream-provider-revision":
          upstreamProviderRevision(upstreamRuntime.config, config.controlToken),
      } : {}),
    };
    const fallbackHeaders = { ...catalogHeaders, [MODEL_CATALOG_STATUS_HEADER]: "fallback" };
    if (!upstreamRuntime?.available || !upstreamRuntime.config) {
      return Response.json(local, { headers: upstreamRuntime?.config ? fallbackHeaders : catalogHeaders });
    }
    let upstream: Response;
    const timeout = new AbortController();
    const timeoutError = Object.assign(
      new Error("Upstream model catalog request timed out"),
      { code: "UpstreamModelCatalogTimeout" },
    );
    const timer = setTimeout(() => timeout.abort(timeoutError), UPSTREAM_MODEL_CATALOG_TIMEOUT_MS);
    const signal = AbortSignal.any([req.signal, timeout.signal]);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error("Upstream model catalog request aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      upstream = await Promise.race([
        forwardUpstreamProviderRequest(
          new Request(req, { signal }),
          "models",
          upstreamRuntime,
          fetchCustomUpstream,
        ),
        aborted,
      ]);
    } catch (error) {
      reportFailure?.(modelCatalogFailure("transport", error));
      return Response.json(local, { headers: fallbackHeaders });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    if (!upstream.ok) {
      reportFailure?.({ stage: "upstream" });
      return Response.json(local, { headers: fallbackHeaders });
    }
    try {
      const raw = await upstream.json();
      return Response.json(mergeUpstreamModelCatalog(
        local,
        raw,
        upstreamRuntime.config,
        config.mode === "full" ? "unified_exec" : "disabled",
      ), {
        headers: catalogHeaders,
      });
    } catch (error) {
      reportFailure?.(modelCatalogFailure("catalog", error));
      return Response.json(local, { headers: fallbackHeaders });
    }
  }
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", input => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    reportFailure?.(modelCatalogFailure(sent ? "transport" : "request", error));
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    reportFailure?.({ stage: "upstream" });
    return upstream;
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    reportFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

async function nativeImagesRequest(
  req: Request,
  endpoint: NativeImageEndpoint,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    return formatErrorResponse(401, "authentication_error", "Native image requests require incoming Codex Bearer authorization");
  }
  try {
    return await forwardNativeCodexRequest(req, endpoint, fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

function jsonRequestWithBody(request: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
}

async function directResponsesRequest(
  request: Request,
  raw: Record<string, unknown>,
  upstreamModel: string,
  accessPolicy: ApiAccessPolicy,
  options: ResponseRequestOptions,
  apiKeyModelError: string,
): Promise<Response> {
  if (accessPolicy.mode === "api-key") {
    const runtime = options.upstreamRuntime;
    if (!runtime?.config || !upstreamModelAllowed(upstreamModel, runtime.config)) {
      return apiAccessError(400, "model_not_supported", apiKeyModelError);
    }
  }

  let turnIdleSignal: AbortSignal | undefined;
  let turnBound = false;
  let turnCompleted = false;
  const terminalIdleError = (): ChatGptWebAdapterError | undefined => (
    turnIdleSignal?.aborted && turnIdleSignal.reason instanceof ChatGptWebAdapterError
      ? turnIdleSignal.reason
      : undefined
  );
  const completeBoundTurn = (): void => {
    if (!turnBound || turnCompleted) return;
    turnCompleted = true;
    options.onTurnComplete?.();
  };
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      const nativeIdentity = { threadId: identity.threadId, turnId: identity.turnId };
      const signal = options.onTurnIdentity?.(nativeIdentity, { remoteIdleTimeout: true });
      turnBound = true;
      if (signal) turnIdleSignal = signal;
      for (const progressKey of nativeToolResultProgressKeys(raw)) {
        options.onTurnInputProgress?.(nativeIdentity, progressKey);
      }
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  const forwardedBody = raw.model === upstreamModel ? raw : { ...raw, model: upstreamModel };
  const lifecycleRequest = turnIdleSignal
    ? new Request(request, { signal: AbortSignal.any([request.signal, turnIdleSignal]) })
    : request;
  const forwardedRequest = raw.model === upstreamModel
    ? lifecycleRequest
    : jsonRequestWithBody(lifecycleRequest, forwardedBody);
  try {
    let upstream: Response;
    if (accessPolicy.mode === "api-key") {
      upstream = await forwardUpstreamProviderRequest(
        forwardedRequest,
        "responses",
        options.upstreamRuntime!,
        options.fetchUpstreamProvider,
        forwardedBody,
      );
    } else {
      upstream = await forwardNativeCodexRequest(
        forwardedRequest,
        "responses",
        options.fetchNative ?? fetchNativeCodex,
        forwardedBody,
      );
    }
    const terminalError = terminalIdleError();
    if (terminalError) {
      await upstream.body?.cancel(terminalError).catch(() => {});
      return adapterErrorResponse(terminalError);
    }
    if (!upstream.ok) {
      completeBoundTurn();
      return upstream;
    }
    return observeNativeResponsesLifecycle(upstream, {
      onProgress: options.onTurnProgress,
      onFinalResponse: completeBoundTurn,
      onTerminalFailure: completeBoundTurn,
      terminalSignal: turnIdleSignal,
    });
  } catch (error) {
    const terminalError = terminalIdleError();
    if (terminalError) return adapterErrorResponse(terminalError);
    completeBoundTurn();
    return formatErrorResponse(
      502,
      "upstream_error",
      accessPolicy.mode === "api-key"
        ? "Configured upstream request failed"
        : error instanceof Error ? error.message : String(error),
    );
  }
}

async function threadTitleRequest(
  request: Request,
  raw: Record<string, unknown>,
  requestedModel: string,
  config: AppConfig,
  accessPolicy: ApiAccessPolicy,
  options: ResponseRequestOptions,
): Promise<Response> {
  const webModel = isChatGptWebModelSlug(requestedModel);
  if (webModel) {
    try {
      requireChatGptWebModelRoute(requestedModel, config);
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const upstreamModel = webModel ? CODEX_UPSTREAM_LUNA_MODEL : requestedModel;
  return directResponsesRequest(
    request,
    raw,
    upstreamModel,
    accessPolicy,
    options,
    "Thread title generation requires a model enabled by the configured upstream provider",
  );
}

const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";
const CODEX_UPSTREAM_LUNA_MODEL = "gpt-6-luna";

async function guardianReviewModel(
  request: Request,
  config: AppConfig,
  accessPolicy: ApiAccessPolicy,
  options: ResponseRequestOptions,
): Promise<string | Response> {
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("content-type");
  const catalogUrl = new URL(request.url);
  catalogUrl.pathname = "/v1/models";
  catalogUrl.search = "";
  const catalogResponse = await modelsRequest(
    new Request(catalogUrl, { method: "GET", headers, signal: request.signal }),
    config,
    options.fetchNative,
    undefined,
    accessPolicy,
    undefined,
    options.upstreamRuntime,
    options.fetchUpstreamProvider,
  );
  if (!catalogResponse.ok) return catalogResponse;

  let catalog: unknown;
  try {
    catalog = await catalogResponse.json();
  } catch (error) {
    return formatErrorResponse(
      502,
      "invalid_response_error",
      "Could not read the model catalog for Codex approval review: "
        + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
    || !Array.isArray((catalog as { models?: unknown }).models)) {
    return formatErrorResponse(
      502,
      "invalid_response_error",
      "Model catalog for Codex approval review is missing a models array",
    );
  }
  const slugs = new Set(
    ((catalog as { models: unknown[] }).models).flatMap(model => (
      model && typeof model === "object" && !Array.isArray(model)
        && typeof (model as { slug?: unknown }).slug === "string"
        ? [(model as { slug: string }).slug]
        : []
    )),
  );
  if (slugs.has(CODEX_AUTO_REVIEW_MODEL)) return CODEX_AUTO_REVIEW_MODEL;
  if (slugs.has(CODEX_UPSTREAM_LUNA_MODEL)) return CODEX_UPSTREAM_LUNA_MODEL;
  return apiAccessError(
    400,
    "model_not_supported",
    "Codex approval review requires codex-auto-review or gpt-6-luna",
  );
}

async function guardianReviewRequest(
  request: Request,
  raw: Record<string, unknown>,
  requestedModel: string,
  config: AppConfig,
  accessPolicy: ApiAccessPolicy,
  options: ResponseRequestOptions,
): Promise<Response> {
  if (!isChatGptWebModelSlug(requestedModel)) {
    return directResponsesRequest(
      request,
      raw,
      requestedModel,
      accessPolicy,
      options,
      "Codex approval review requires a model enabled by the configured upstream provider",
    );
  }
  try {
    requireChatGptWebModelRoute(requestedModel, config);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const model = await guardianReviewModel(request, config, accessPolicy, options);
  if (model instanceof Response) return model;
  return directResponsesRequest(
    request,
    raw,
    model,
    accessPolicy,
    options,
    "Codex approval review requires codex-auto-review or gpt-6-luna enabled by the configured upstream provider",
  );
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const accessPolicy = options.accessPolicy ?? OPENAI_ACCESS;
  const denied = authenticateApiRequest(req, accessPolicy);
  if (denied) return denied;
  const nativeRequest = req.clone();
  let turnIdleSignal: AbortSignal | undefined;
  let boundTurnIdentity: NativeCodexTurnIdentity | undefined;
  const bindTurnIdentity = (identity: NativeCodexTurnIdentity, remoteIdleTimeout: boolean): void => {
    if (boundTurnIdentity
      && (boundTurnIdentity.threadId !== identity.threadId || boundTurnIdentity.turnId !== identity.turnId)) {
      throw new Error("A Responses request cannot change its native Codex turn identity");
    }
    boundTurnIdentity = identity;
    const signal = options.onTurnIdentity?.(identity, { remoteIdleTimeout });
    if (signal) turnIdleSignal = signal;
  };
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  const threadTitle = isCodexThreadTitleRequestFromBody(raw);
  const guardianReview = isCodexGuardianReviewRequestFromBody(raw);
  if (!threadTitle && !guardianReview) {
    const rejectedModel = requireWebModelInApiKeyMode(requestedModel, accessPolicy, options.upstreamRuntime);
    if (rejectedModel) return rejectedModel;
  }
  if (threadTitle) {
    if (typeof requestedModel !== "string" || !requestedModel) {
      return apiAccessError(400, "model_not_supported", "Thread title generation requires a model");
    }
    return await threadTitleRequest(
      nativeRequest,
      raw as Record<string, unknown>,
      requestedModel,
      config,
      accessPolicy,
      options,
    );
  }
  if (guardianReview) {
    if (typeof requestedModel !== "string" || !requestedModel) {
      return apiAccessError(400, "model_not_supported", "Codex approval review requires a model");
    }
    return await guardianReviewRequest(
      nativeRequest,
      raw as Record<string, unknown>,
      requestedModel,
      config,
      accessPolicy,
      options,
    );
  }
  const requestedWebModel = typeof requestedModel === "string" && isChatGptWebModelSlug(requestedModel);
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId && !requestedWebModel) {
      const nativeIdentity = { threadId: identity.threadId, turnId: identity.turnId };
      bindTurnIdentity(nativeIdentity, true);
      for (const progressKey of nativeToolResultProgressKeys(raw)) {
        options.onTurnInputProgress?.(nativeIdentity, progressKey);
      }
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    const forwardedRequest = turnIdleSignal
      ? new Request(nativeRequest, { signal: AbortSignal.any([req.signal, turnIdleSignal]) })
      : nativeRequest;
    try {
      let upstream: Response;
      if (accessPolicy.mode === "api-key") {
        upstream = await forwardUpstreamProviderRequest(
          forwardedRequest,
          "responses",
          options.upstreamRuntime!,
          options.fetchUpstreamProvider,
          raw,
        );
      } else {
        upstream = await forwardNativeCodexRequest(
          forwardedRequest,
          "responses",
          options.fetchNative ?? fetchNativeCodex,
          raw,
        );
      }
      const terminalError = turnIdleSignal?.aborted && turnIdleSignal.reason instanceof ChatGptWebAdapterError
        ? turnIdleSignal.reason
        : undefined;
      if (terminalError) {
        await upstream.body?.cancel(terminalError).catch(() => {});
        return adapterErrorResponse(terminalError);
      }
      if (!upstream.ok) {
        if (boundTurnIdentity) options.onTurnComplete?.();
        return upstream;
      }
      return observeNativeResponsesLifecycle(upstream, {
        onProgress: options.onTurnProgress,
        onFinalResponse: options.onTurnComplete,
        onTerminalFailure: options.onTurnComplete,
        terminalSignal: turnIdleSignal,
      });
    } catch (error) {
      const terminalError = turnIdleSignal?.aborted && turnIdleSignal.reason instanceof ChatGptWebAdapterError
        ? turnIdleSignal.reason
        : undefined;
      if (terminalError instanceof ChatGptWebAdapterError) return adapterErrorResponse(terminalError);
      if (boundTurnIdentity) options.onTurnComplete?.();
      if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
      return formatErrorResponse(
        502,
        "upstream_error",
        accessPolicy.mode === "api-key"
          ? "Configured upstream request failed"
          : error instanceof Error ? error.message : String(error),
      );
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT Web cannot read this encrypted cross-backend subagent payload. "
        + "Start a new Compatibility V1 task, or delegate from a Web model whose collaboration call uses the plaintext-delivery marker.",
    );
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  const compactionItem = compaction
    && parsed._compactionOutput !== "message"
    && parsed._compactionResponseFormat !== "message";
  const rememberCompletedResponse = (response: Record<string, unknown>): void => {
    if (!compaction) {
      if (options.rememberState !== false) rememberResponseState(parsed._rawBody, response, { force: true });
      return;
    }
    if (response.status !== "completed") return;
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId || !Array.isArray(response.output)) return;
    const items = response.output.filter(item => item?.type === (compactionItem ? "compaction" : "message"));
    if (items.length !== 1 || (compactionItem && response.output.length !== 1)) return;
    const item = items[0];
    const summary = compactionItem
      ? (typeof item?.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null)
      : (item?.role === "assistant" && Array.isArray(item.content)
         ? item.content.filter((part: { type?: string; text?: unknown }) => part.type === "output_text" && typeof part.text === "string")
           .map((part: { text: string }) => part.text).join("")
         : null);
    if (!summary) return;
    const source = extractChatGptCompactionSourceRevision(parsed);
    const body = parsed._rawBody as { input?: unknown[] };
    // v1 installs the bounded user-message output, whereas v2 retains the original source.
    // Authenticate both exact producer-defined representations, never arbitrary rewrites.
    const v1Source = extractChatGptCompactionSourceRevision({
      ...parsed,
      _rawBody: { ...body, input: buildCompactV1Output(extractCompactUserMessages(
        parsed._compactionOutput === "message" ? body.input?.slice(0, -1) : body.input,
      ), summary) },
    });
    rememberCompactionContinuation(parsed, identity, [source, v1Source], summary);
  };
  if (compaction && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    if (parsed._compactionOutput !== "message") {
      parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
    }
  }

  const provider = providerConfig(config);
  let traceId: string | undefined;
  try {
    traceId = chatGptWebTraceId(provider, parsed);
  } catch (error) {
    // A cancelled browser session can only exist after the adapter accepted canonical native
    // turn identity and user-revision metadata. Requests without that identity have no matching
    // trace tombstone; preserve the adapter's existing strict validation/error path below.
    const message = error instanceof Error ? error.message : String(error);
    if (message === CHATGPT_TURN_REVISION_CONFLICT_MESSAGE) {
      // Codex can reopen an interrupted task with only refreshed developer/skill context under a
      // new turn_id. Its last human prompt still belongs to the stopped turn and must not be
      // replayed as new work. HTTP 400 makes that malformed recovery request terminal instead of
      // allowing Codex to retry it as an upstream 502.
      return formatErrorResponse(400, "invalid_request_error", message);
    }
    if (!message.includes("requires native Codex turn_id metadata")
      && !message.includes("requires a current-turn user message")) throw error;
  }
  const cancelledError = traceId ? chatGptTurnSessions.cancelledError(traceId) : undefined;
  if (cancelledError) {
    // Codex retries unknown streamed response.failed codes. A replay after the user explicitly
    // closed the only browser document is instead a terminal client state: repeating that exact
    // request is invalid and must not recreate the DOM. Codex maps HTTP 400 to its non-retryable
    // InvalidRequest category while the body preserves the real client_cancelled classification.
    return new Response(JSON.stringify({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: cancelledError.message,
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (options.brokerAvailable && !await options.brokerAvailable()) {
    return formatErrorResponse(503, "server_error", "ChatGPT web turn broker is unavailable; restart the runtime before submitting new Web work");
  }
  let webTurnIdentity: NativeCodexTurnIdentity | undefined;
  try {
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      webTurnIdentity = { threadId: identity.threadId, turnId: identity.turnId };
      if (options.onTurnAdmission) options.onTurnAdmission(webTurnIdentity, { remoteIdleTimeout: true });
      else bindTurnIdentity(webTurnIdentity, true);
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const adapter = adapterFactory(provider);
  const abort = new AbortController();
  const forwardAbort = (signal: AbortSignal): void => {
    if (signal.aborted) abort.abort(signal.reason);
    else signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
  };
  forwardAbort(req.signal);
  const incoming = {
    headers: adapterRequestHeaders(req.headers, accessPolicy),
    abortSignal: abort.signal,
    onProgress: options.onTurnProgress,
  };
  const adapterErrorEvent = (error: unknown): Extract<AdapterEvent, { type: "error" }> => ({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof ChatGptWebAdapterError ? {
      status: error.status, errorType: error.errorType, code: error.code, retryable: error.retryable,
    } : {}),
  });
  const environmentFailureResponse = (event: AdapterEvent | undefined): Response | undefined => {
    if (event?.type !== "error"
      || (event.code !== "missing_trusted_codex_environment" && event.code !== "invalid_trusted_codex_environment")
      || event.status !== 400 || event.retryable !== false) return undefined;
    return Response.json({ error: {
      message: event.message, type: event.errorType, code: event.code,
    } }, { status: 400 });
  };
  if (adapter.preflight) {
    try {
      await adapter.preflight(parsed, incoming);
    } catch (error) {
      const event = adapterErrorEvent(error);
      options.onAdapterEvent?.(event, { compaction });
      const rejected = environmentFailureResponse(event);
      if (rejected) return rejected;
      if (error instanceof ChatGptWebAdapterError) {
        return Response.json({ error: {
          message: error.message, type: error.errorType, code: error.code,
        } }, { status: error.status });
      }
      return formatErrorResponse(500, "server_error", event.message);
    }
  }
  try {
    if (webTurnIdentity && options.onTurnAdmission) {
      bindTurnIdentity(webTurnIdentity, true);
      if (turnIdleSignal) forwardAbort(turnIdleSignal);
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const queue = new AsyncEventQueue<AdapterEvent>();
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, incoming, event => {
        options.onAdapterEvent?.(event, { compaction });
        queue.push(event);
      });
    } catch (error) {
      const terminalError = turnIdleSignal?.aborted
        && turnIdleSignal.reason instanceof ChatGptWebAdapterError
        ? turnIdleSignal.reason
        : error;
      const event = adapterErrorEvent(terminalError);
      options.onAdapterEvent?.(event, { compaction });
      queue.push(event);
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(provider.chatgptWeb?.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: provider.chatgptWeb.stallTimeoutSec }
          : {}),
        ...(compactionItem ? { compaction: true } : {}),
        onCompletedResponse: rememberCompletedResponse,
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const rejected = environmentFailureResponse(events[0]);
  if (rejected) return rejected;
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compactionItem ? { compaction: true } : {}),
  });
  rememberCompletedResponse(json);
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: Pick<
    ResponseRequestOptions,
    "onTurnAdmission" | "onTurnIdentity" | "onAdapterEvent" | "onTurnProgress" | "accessPolicy" | "upstreamRuntime" | "fetchUpstreamProvider" | "brokerAvailable"
  > = {},
): Promise<Response> {
  const accessPolicy = options.accessPolicy ?? OPENAI_ACCESS;
  const denied = authenticateApiRequest(req, accessPolicy);
  if (denied) return denied;
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const rejectedModel = requireWebModelInApiKeyMode(raw.model, accessPolicy, options.upstreamRuntime);
  if (rejectedModel) return rejectedModel;
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  let turnIdleSignal: AbortSignal | undefined;
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId
      && (typeof raw.model !== "string" || !isChatGptWebModelSlug(raw.model))) {
      const signal = options.onTurnIdentity?.(
        { threadId: identity.threadId, turnId: identity.turnId },
        { remoteIdleTimeout: true },
      );
      if (signal) turnIdleSignal = signal;
    }
  } catch (error) {
    if (error instanceof ChatGptWebAdapterError) return adapterErrorResponse(error);
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    const forwardedRequest = turnIdleSignal
      ? new Request(nativeRequest, { signal: AbortSignal.any([req.signal, turnIdleSignal]) })
      : nativeRequest;
    try {
      let upstream: Response;
      if (accessPolicy.mode === "api-key") {
        upstream = await forwardUpstreamProviderRequest(
          forwardedRequest,
          "responses/compact",
          options.upstreamRuntime!,
          options.fetchUpstreamProvider,
          raw,
        );
      } else {
        upstream = await forwardNativeCodexRequest(forwardedRequest, "responses/compact", undefined, raw);
      }
      return observeNativeResponsesLifecycle(upstream, {
        onProgress: options.onTurnProgress,
        terminalSignal: turnIdleSignal,
      });
    } catch (error) {
      const terminalError = turnIdleSignal?.aborted && turnIdleSignal.reason instanceof ChatGptWebAdapterError
        ? turnIdleSignal.reason
        : error;
      if (terminalError instanceof ChatGptWebAdapterError) return adapterErrorResponse(terminalError);
      return formatErrorResponse(
        502,
        "upstream_error",
        accessPolicy.mode === "api-key"
          ? "Configured upstream request failed"
          : error instanceof Error ? error.message : String(error),
      );
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: turnIdleSignal ? AbortSignal.any([req.signal, turnIdleSignal]) : req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, options);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: {
    fetchUpstream?: NativeFetch;
    fetchUpstreamProvider?: UpstreamFetch;
    adapterFactory?: ChatGptWebAdapterFactory;
    accessPolicy?: ApiAccessPolicy;
    upstreamRuntime?: UpstreamProviderRuntime;
  } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  // Snapshot before opening a socket/broker. Rotation or mode changes require a controlled restart.
  const accessPolicy = parseApiAccessPolicy(dependencies.accessPolicy ?? loadApiAccessPolicy());
  const upstreamRuntime: UpstreamProviderRuntime = accessPolicy.mode === "api-key"
    ? dependencies.upstreamRuntime ?? loadUpstreamProviderRuntime()
    : { available: false, keyMatches: false };
  const upstreamMetadataRepairs = upstreamRuntime.config
    ? upstreamMetadataRepairCount(
        upstreamRuntime.config,
        config.mode === "full" ? "unified_exec" : "disabled",
      )
    : 0;
  if (apiKeyMatches(config.controlToken, accessPolicy)) {
    throw new Error("Client API key must not be the daemon control token");
  }
  const startedAt = Date.now();
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  const brokerStarted = turnBroker?.listen().then(() => true, error => {
    console.error(
      `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  });
  const brokerAvailable = async (): Promise<boolean> => !turnBroker
    || Boolean(await brokerStarted) && await turnBroker.checkHealth();
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let modelCatalogRequests = 0;
  let lastModelCatalogResult: {
    request: number; at: string; status: number; failure?: ModelCatalogFailure;
  } | null = null;
  const httpTurns = new HttpTurnCounter();
  const remoteIdleTimeoutSec = remoteTurnIdleTimeoutSec();
  let turnIdleLeases: NativeTurnIdleRegistry | undefined;
  const beginNativeTurnCancellation = (
    identity: NativeCodexTurnIdentity,
    reason: Error,
    abortHttpTransport = true,
  ) => {
    const browserCancellation = chatGptTurnSessions.cancelNativeTurn(
      identity.threadId,
      identity.turnId,
      reason,
    );
    const compactionCancellation = cancelStructuredCompactionNativeTurn(
      identity.threadId,
      identity.turnId,
      reason,
    );
    const httpCancellation = httpTurns.beginCancelTurn(identity, reason, abortHttpTransport);
    return {
      cancelledHttpTurns: httpCancellation.cancelled,
      cancelledBrowserTurns: browserCancellation.cancelled,
      cancelledCompactionRuns: compactionCancellation.cancelled,
      settlement: Promise.allSettled([
        browserCancellation.settlement,
        compactionCancellation.settlement,
        httpCancellation.settlement,
      ]),
    };
  };
  const logNativeTurnCleanup = (
    label: string,
    cancellation: ReturnType<typeof beginNativeTurnCancellation>,
  ): void => {
    void cancellation.settlement.then(results => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            `[chatgpt-web] ${label} cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    });
  };
  if (remoteIdleTimeoutSec !== undefined) {
    turnIdleLeases = new NativeTurnIdleRegistry(remoteIdleTimeoutSec, (identity, reason) => {
      // The idle signal already aborts the adapter. Release HTTP ownership immediately, but keep
      // the still-connected response transport writable long enough to send its terminal timeout.
      const cancellation = beginNativeTurnCancellation(identity, reason, false);
      logNativeTurnCleanup("remote turn idle-timeout", cancellation);
    });
  }
  const cancelDisconnectedRemoteTurn = (identity: NativeCodexTurnIdentity, reason: unknown): void => {
    if (!turnIdleLeases) return;
    const disconnectReason = reason instanceof Error
      ? reason
      : new DOMException("Remote Codex client disconnected", "AbortError");
    turnIdleLeases.terminate(identity, disconnectReason);
    const cancellation = beginNativeTurnCancellation(identity, disconnectReason);
    logNativeTurnCleanup("remote client disconnect", cancellation);
  };
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const listenHost = responsesListenHost(config.host, accessPolicy);
  const server = Bun.serve({
    hostname: listenHost,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const denied = guardApiRequest(req, accessPolicy, upstreamRuntime);
      if (denied) return denied;
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        const available = turnBroker ? await brokerAvailable() : null;
        const healthy = available !== false;
        return Response.json({
          status: healthy ? "ok" : "degraded",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          access_mode: accessPolicy.mode,
          api_access_revision: apiAccessRevision(accessPolicy, config.controlToken),
          upstream_provider_configured: Boolean(upstreamRuntime.config),
          upstream_provider_available: upstreamRuntime.available,
          upstream_provider_key_matches: upstreamRuntime.keyMatches,
          upstream_provider_revision: upstreamRuntime.config
            ? upstreamProviderRevision(upstreamRuntime.config, config.controlToken)
            : null,
          upstream_metadata_repair_count: upstreamMetadataRepairs,
          pid: process.pid,
          port: config.port,
          listen_host: listenHost,
          remote_turn_idle_timeout_sec: remoteIdleTimeoutSec ?? null,
          active_remote_turn_idle_leases: turnIdleLeases?.count() ?? 0,
          remote_turn_idle_epoch: turnIdleLeases?.epoch() ?? null,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining && healthy,
          broker_available: available,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          model_catalog_requests: modelCatalogRequests,
          last_model_catalog_result: lastModelCatalogResult,
          ...activity(),
        }, { status: healthy ? 200 : 503 });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        if (url.pathname === "/admin/resume" && !await brokerAvailable()) {
          turnBroker?.setExternalOwnersAccepted(false);
          return Response.json({
            status: "degraded", accepting_turns: false, broker_available: false, ...activity(),
          }, { status: 503 });
        }
        draining = url.pathname === "/admin/drain";
        turnBroker?.setExternalOwnersAccepted(!draining);
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let traceId: string;
        let leaseFailure: "browser_surface_bootstrap_timeout" | "helper_heartbeat_expired" | undefined;
        try {
          const body = await req.json() as { traceId?: unknown; reason?: unknown };
          traceId = typeof body?.traceId === "string" ? body.traceId : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
          if (body.reason !== undefined) {
            if (body.reason !== "browser_surface_bootstrap_timeout" && body.reason !== "helper_heartbeat_expired") {
              throw new Error("Browser turn cancellation reason is invalid");
            }
            leaseFailure = body.reason;
          }
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = leaseFailure
          ? new ChatGptWebAdapterError(
            leaseFailure === "browser_surface_bootstrap_timeout"
              ? "The ChatGPT browser turn did not finish browser setup before its lease expired. The turn was stopped."
              : "The ChatGPT browser helper stopped reporting progress and its lease expired. The turn was stopped.",
            { status: 504, errorType: "server_error", code: leaseFailure, retryable: false },
          )
          : chatGptBrowserTabClosedError();
        // Revoke the owner first. This prevents a compaction callback that observes its retained
        // source being cancelled below from starting a fresh fallback during operator shutdown.
        const compactionCancellation = beginCancelStructuredCompactionTrace(traceId, reason);
        const browserCancellation = chatGptTurnSessions.beginCancelTrace(traceId, reason);
        const cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
        const settlement = Promise.all([browserCancellation.settlement, compactionCancellation.settlement]);
        // Explicit tab close acknowledges revoked authority, then destroys its document. Waiting
        // for that document's helper first can deadlock the UI behind a stalled browser operation.
        // Lease cleanup still requires physical settlement before declaring the runtime idle.
        if (leaseFailure) await settlement;
        else void settlement.catch(error => console.error(`[chatgpt-web] cancelled turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
        return Response.json({
          status: "ok",
          trace_id: traceId,
          cancelled_browser_turns: browserCancellation.cancelled,
          cancelled_broker_turns: cancelledBrokerTurns,
          cancelled_compaction_runs: compactionCancellation.cancelled,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let identity: NativeCodexTurnIdentity;
        try {
          const body = await req.json() as { threadId?: unknown; turnId?: unknown };
          const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
          const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
            throw new Error("native Codex threadId or turnId is invalid");
          }
          identity = { threadId, turnId };
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = new DOMException("Codex turn interrupted", "AbortError");
        turnIdleLeases?.terminate(identity, reason);
        const cancellation = beginNativeTurnCancellation(identity, reason);
        logNativeTurnCleanup("interrupted turn", cancellation);
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancellation.cancelledHttpTurns,
          cancelled_browser_turns: cancellation.cancelledBrowserTurns,
          cancelled_compaction_runs: cancellation.cancelledCompactionRuns,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const reason = new Error("Active turn cancelled by launcher");
        // Abort shared compaction owners before clearing their retained source sessions. The
        // owner signal is the only cancellation boundary for a fresh fallback not in the session
        // registry.
        const compactionCancellation = cancelAllStructuredCompactions(reason);
        const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
        const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
          httpTurns.cancelAll(reason),
          compactionCancellation,
        ]);
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancelledHttpTurns,
          cancelled_browser_turns: cancelledBrowserTurns,
          cancelled_compaction_runs: cancelledCompactionRuns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async signal => {
          const request = ++modelCatalogRequests;
          const started = Date.now();
          const recordResult = (response: Response, failure?: ModelCatalogFailure): Response => {
            const result = { request, at: new Date().toISOString(), status: response.status, ...(failure ? { failure } : {}) };
            // An older, slower request must not replace a newer completed result.
            if (!lastModelCatalogResult || request > lastModelCatalogResult.request) lastModelCatalogResult = result;
            if (!response.ok || failure) {
              try {
                console.warn(`[codex-chatgpt-web] model_catalog_failed ${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}`);
              } catch { /* Logging must not replace the catalog result. */ }
            }
            return response;
          };
          let catalogConfig: AppConfig;
          try {
            catalogConfig = {
              ...config,
              subagentProtocol: accessPolicy.mode === "api-key"
                ? config.subagentProtocol
                : readCodexSubagentProtocol(config.subagentProtocol),
            };
          } catch (error) {
            return recordResult(formatErrorResponse(
              500,
              "server_error",
              `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
            ), modelCatalogFailure("config", error));
          }
          let failure: ModelCatalogFailure | undefined;
          const response = await modelsRequest(
            new Request(req, { signal }),
            catalogConfig,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
            accessPolicy,
            value => { failure = value; },
            upstreamRuntime,
            dependencies.fetchUpstreamProvider,
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return recordResult(response, failure);
        }, req.signal, process.platform, "models");
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        let boundIdentity: NativeCodexTurnIdentity | undefined;
        let remoteManaged = false;
        return httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            {
              onTurnAdmission: (identity, options) => {
                if (options?.remoteIdleTimeout === true && turnIdleLeases) {
                  turnIdleLeases.assertCanSignal(identity);
                }
              },
              onTurnIdentity: (identity, options) => {
                boundIdentity = identity;
                remoteManaged = options?.remoteIdleTimeout === true && turnIdleLeases !== undefined;
                const idleSignal = remoteManaged ? turnIdleLeases!.signal(identity) : undefined;
                if (idleSignal?.aborted && idleSignal.reason instanceof ChatGptWebAdapterError) {
                  throw idleSignal.reason;
                }
                bindIdentity(identity);
                return idleSignal;
              },
              onTurnProgress: () => {
                if (remoteManaged && boundIdentity) turnIdleLeases?.touch(boundIdentity);
              },
              onTurnInputProgress: (identity, progressKey) => {
                if (remoteManaged) turnIdleLeases?.touchProgressOnce(identity, progressKey);
              },
              onTurnComplete: () => {
                if (remoteManaged && boundIdentity) turnIdleLeases?.release(boundIdentity);
              },
              onAdapterEvent: (event, context) => {
                if (!remoteManaged || !boundIdentity || !turnIdleLeases) return;
                if (!context.compaction && event.type === "done" && event.endTurn === true) {
                  turnIdleLeases.release(boundIdentity);
                }
              },
              accessPolicy,
              upstreamRuntime,
              fetchUpstreamProvider: dependencies.fetchUpstreamProvider,
              brokerAvailable,
            },
          ),
          req.signal,
          process.platform,
          "responses",
          (identity, reason) => {
            if (remoteManaged) cancelDisconnectedRemoteTurn(identity, reason);
          },
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        let boundIdentity: NativeCodexTurnIdentity | undefined;
        let remoteManaged = false;
        return httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            {
              onTurnAdmission: (identity, options) => {
                if (options?.remoteIdleTimeout === true && turnIdleLeases) {
                  turnIdleLeases.assertCanSignal(identity);
                }
              },
              onTurnIdentity: (identity, options) => {
                boundIdentity = identity;
                remoteManaged = options?.remoteIdleTimeout === true && turnIdleLeases !== undefined;
                const idleSignal = remoteManaged ? turnIdleLeases!.signal(identity) : undefined;
                if (idleSignal?.aborted && idleSignal.reason instanceof ChatGptWebAdapterError) {
                  throw idleSignal.reason;
                }
                bindIdentity(identity);
                return idleSignal;
              },
              onTurnProgress: () => {
                if (remoteManaged && boundIdentity) turnIdleLeases?.touch(boundIdentity);
              },
              accessPolicy,
              upstreamRuntime,
              fetchUpstreamProvider: dependencies.fetchUpstreamProvider,
              brokerAvailable,
            },
          ),
          req.signal,
          process.platform,
          "compact",
          (identity, reason) => {
            if (remoteManaged) cancelDisconnectedRemoteTurn(identity, reason);
          },
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          async signal => {
            const request = new Request(req, { signal });
            if (accessPolicy.mode !== "api-key") return nativeSearchRequest(request, dependencies.fetchUpstream);
            try {
              return await forwardUpstreamProviderRequest(
                request,
                "alpha/search",
                upstreamRuntime,
                dependencies.fetchUpstreamProvider,
              );
            } catch {
              return formatErrorResponse(502, "upstream_error", "Configured upstream request failed");
            }
          },
          req.signal,
          process.platform,
          "search",
        );
      }
      if (req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        const endpoint: NativeImageEndpoint = url.pathname === "/v1/images/generations"
          ? "images/generations"
          : "images/edits";
        return httpTurns.track(
          async signal => {
            const request = new Request(req, { signal });
            if (accessPolicy.mode !== "api-key") return nativeImagesRequest(request, endpoint, dependencies.fetchUpstream);
            try {
              return await forwardUpstreamProviderRequest(
                request,
                endpoint,
                upstreamRuntime,
                dependencies.fetchUpstreamProvider,
              );
            } catch {
              return formatErrorResponse(502, "upstream_error", "Configured upstream request failed");
            }
          },
          req.signal,
          process.platform,
          endpoint,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    turnIdleLeases?.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
