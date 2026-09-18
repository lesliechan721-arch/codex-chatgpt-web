import * as http from "node:http";
import * as https from "node:https";
import { Readable } from "node:stream";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { fetchNativeCodex } from "./native-network";
import type { UpstreamProviderConfig } from "./upstream-provider";

async function fetchWithNodeTransport(request: Request, proxyUrl?: string): Promise<Response> {
  const url = new URL(request.url);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  const agent = proxyUrl
    ? url.protocol === "https:"
      ? new HttpsProxyAgent(proxyUrl)
      : new HttpProxyAgent(proxyUrl)
    : undefined;
  return await new Promise<Response>((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const outgoing = client.request(url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(agent ? { agent } : {}),
      signal: request.signal,
    }, incoming => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers.append(name, value);
      }
      resolve(new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
        status: incoming.statusCode ?? 502,
        statusText: incoming.statusMessage,
        headers,
      }));
    });
    outgoing.once("error", reject);
    if (body) outgoing.end(body);
    else outgoing.end();
  });
}

function withoutFetchDecodedContentEncoding(response: Response): Response {
  const contentEncoding = response.headers.get("content-encoding");
  if (!contentEncoding) return response;
  const decodedByBun = new Set(["gzip", "x-gzip", "br", "deflate"]);
  const encodings = contentEncoding.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (encodings.length === 0 || encodings.some(encoding => !decodedByBun.has(encoding))) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Global keeps the existing Launcher/system policy. Direct/custom never mutate or consult process proxy state. */
export async function fetchUpstreamProvider(request: Request, config: UpstreamProviderConfig): Promise<Response> {
  if (config.proxy.mode === "global") {
    // Bun fetch exposes decoded gzip/br/deflate bytes while retaining the upstream encoding header.
    return withoutFetchDecodedContentEncoding(await fetchNativeCodex(request));
  }
  if (config.proxy.mode === "direct") return fetchWithNodeTransport(request);
  return fetchWithNodeTransport(request, config.proxy.url);
}
