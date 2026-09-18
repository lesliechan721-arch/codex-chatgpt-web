import { readJsonRequestBody } from "./http-body";
import {
  endToEndHeaders,
  scrubBridgeArtifactsForNative,
  withUncleanCloseTolerance,
  type NativeImageEndpoint,
} from "./native-passthrough";
import { fetchUpstreamProvider } from "./upstream-network";
import {
  upstreamEndpoint,
  type UpstreamProviderRuntime,
} from "./upstream-provider";

export type UpstreamEndpoint = "models" | "responses" | "responses/compact" | "alpha/search" | NativeImageEndpoint;
export type UpstreamFetch = (request: Request) => Promise<Response>;

const CLIENT_ONLY_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "chatgpt-account-id",
  "openai-organization",
  "openai-project",
] as const;

function upstreamHeaders(source: Headers, apiKey: string): Headers {
  const headers = endToEndHeaders(source);
  for (const name of CLIENT_ONLY_HEADERS) headers.delete(name);
  headers.delete("content-length");
  headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

export async function forwardUpstreamProviderRequest(
  request: Request,
  endpoint: UpstreamEndpoint,
  runtime: UpstreamProviderRuntime,
  fetchUpstream?: UpstreamFetch,
  decodedBody?: unknown,
): Promise<Response> {
  if (!runtime.available || !runtime.config || !runtime.apiKey) {
    throw Object.assign(new Error("Configured upstream provider is unavailable"), { code: "UpstreamProviderUnavailable" });
  }
  const method = endpoint === "models" ? "GET" : "POST";
  const imageRequest = endpoint === "images/generations" || endpoint === "images/edits";
  const headers = upstreamHeaders(request.headers, runtime.apiKey);
  if (endpoint === "models") {
    headers.delete("if-none-match");
    headers.set("accept-encoding", "identity");
  }
  let body: BodyInit | undefined;
  if (method === "POST") {
    const original = await request.arrayBuffer();
    if (imageRequest || endpoint === "alpha/search") {
      body = original;
    } else {
      const parsed = decodedBody === undefined
        ? await readJsonRequestBody(new Request(request, { body: original }))
        : decodedBody;
      const scrubbed = scrubBridgeArtifactsForNative(parsed);
      if (scrubbed.changed) {
        headers.delete("content-encoding");
        headers.set("content-type", "application/json");
        body = JSON.stringify(scrubbed.value);
      } else body = original;
    }
  }
  const target = new Request(upstreamEndpoint(runtime.config, endpoint), {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: request.signal,
    redirect: "manual",
  });
  const upstream = await (fetchUpstream ?? (input => fetchUpstreamProvider(input, runtime.config!)))(target);
  const responseHeaders = endToEndHeaders(upstream.headers);
  const isEventStream = (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  return new Response(
    upstream.body ? withUncleanCloseTolerance(upstream.body, isEventStream) : upstream.body,
    { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders },
  );
}
