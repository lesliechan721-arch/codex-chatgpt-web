import { afterEach, expect, test } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { fetchUpstreamProvider } from "../src/upstream-network";
import { forwardUpstreamProviderRequest } from "../src/upstream-passthrough";
import {
  upstreamApiKeyDigest,
  type UpstreamProviderConfig,
  type UpstreamProviderRuntime,
  type UpstreamProxyConfig,
} from "../src/upstream-provider";

const proxyEnvKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy",
  "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR"];
const saved = Object.fromEntries(proxyEnvKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of proxyEnvKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function config(proxy: UpstreamProxyConfig): UpstreamProviderConfig {
  return {
    version: 1,
    baseUrl: "http://provider.invalid/v1/",
    apiKeySha256: "a".repeat(64),
    proxy,
    modelFilter: { mode: "all" },
    supportsOpenAiServerCompaction: false,
  };
}

function runtime(baseUrl: string, proxy: UpstreamProxyConfig): UpstreamProviderRuntime {
  const apiKey = "provider-test-key";
  return {
    available: true,
    keyMatches: true,
    apiKey,
    config: {
      ...config(proxy),
      baseUrl,
      apiKeySha256: upstreamApiKeyDigest(apiKey),
    },
  };
}

test("direct upstream transport ignores process proxy variables without changing them", async () => {
  let proxyCalls = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxyCalls++; return new Response("proxy"); } });
  let targetCalls = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetCalls++; return new Response("direct"); } });
  process.env.HTTP_PROXY = proxy.url.origin;
  process.env.HTTPS_PROXY = proxy.url.origin;
  process.env.ALL_PROXY = proxy.url.origin;
  const before = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY };
  try {
    const response = await fetchUpstreamProvider(new Request(`${target.url.origin}/responses`), config({ mode: "direct" }));
    expect(await response.text()).toBe("direct");
    expect({ targetCalls, proxyCalls }).toEqual({ targetCalls: 1, proxyCalls: 0 });
    expect({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY }).toEqual(before);
  } finally {
    target.stop(true);
    proxy.stop(true);
  }
});

test("custom upstream transport uses only its explicit authenticated proxy", async () => {
  let selectedCalls = 0;
  let proxyAuthorization: string | null = null;
  const selected = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    selectedCalls++;
    proxyAuthorization = request.headers.get("proxy-authorization");
    return new Response("custom");
  } });
  let globalCalls = 0;
  const global = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { globalCalls++; return new Response("wrong"); } });
  process.env.HTTP_PROXY = global.url.origin;
  process.env.HTTPS_PROXY = global.url.origin;
  try {
    const proxyUrl = new URL(selected.url.origin);
    proxyUrl.username = "proxy-user";
    proxyUrl.password = "proxy-pass";
    const response = await fetchUpstreamProvider(
      new Request("http://custom-upstream.invalid/responses"),
      config({ mode: "custom", url: proxyUrl.href }),
    );
    expect(await response.text()).toBe("custom");
    expect(selectedCalls).toBe(1);
    expect(globalCalls).toBe(0);
    expect(proxyAuthorization).toMatch(/^Basic /);
    expect(process.env.HTTP_PROXY).toBe(global.url.origin);
  } finally {
    selected.stop(true);
    global.stop(true);
  }
});

test("direct and custom requests can run concurrently without changing global proxy state", async () => {
  const directTarget = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("direct"); } });
  const customProxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("custom"); } });
  process.env.HTTP_PROXY = "http://global.invalid:8123";
  process.env.HTTPS_PROXY = "http://global.invalid:8123";
  const before = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  try {
    const [direct, custom] = await Promise.all([
      fetchUpstreamProvider(new Request(`${directTarget.url.origin}/responses`), config({ mode: "direct" })),
      fetchUpstreamProvider(new Request("http://custom-target.invalid/responses"), config({ mode: "custom", url: customProxy.url.origin })),
    ]);
    expect(await direct.text()).toBe("direct");
    expect(await custom.text()).toBe("custom");
    expect({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }).toEqual(before);
  } finally {
    directTarget.stop(true);
    customProxy.stop(true);
  }
});

test("global upstream forwarding removes stale gzip/br content-encoding after Bun fetch decoding", async () => {
  for (const key of proxyEnvKeys) delete process.env[key];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/responses") {
        return new Response(Bun.gzipSync(Buffer.from('{"kind":"response"}')), {
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        });
      }
      if (path === "/v1/images/generations") {
        return new Response(brotliCompressSync(Buffer.from('{"kind":"image"}')), {
          headers: { "content-type": "application/json", "content-encoding": "br" },
        });
      }
      return new Response(Bun.gzipSync(Buffer.from('{"error":{"message":"denied"}}')), {
        status: 429,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    },
  });
  try {
    const provider = runtime(`${server.url.origin}/v1/`, { mode: "global" });
    for (const [endpoint, expectedStatus, expectedKind] of [
      ["responses", 200, "response"],
      ["images/generations", 200, "image"],
    ] as const) {
      const response = await forwardUpstreamProviderRequest(
        new Request("http://client.test/v1/" + endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: endpoint === "responses" ? JSON.stringify({ model: "gpt-test", input: "hello" }) : "{}",
        }),
        endpoint,
        provider,
      );
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect((await response.json() as { kind: string }).kind).toBe(expectedKind);
    }

    const error = await forwardUpstreamProviderRequest(
      new Request("http://client.test/v1/responses/compact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", input: [] }),
      }),
      "responses/compact",
      provider,
    );
    expect(error.status).toBe(429);
    expect(error.headers.get("content-encoding")).toBeNull();
    expect(await error.json()).toEqual({ error: { message: "denied" } });
  } finally {
    server.stop(true);
  }
});

test("direct and custom upstream transports keep encoded bytes paired with their content-encoding", async () => {
  const directBody = Bun.gzipSync(Buffer.from("direct-gzip"));
  const direct = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(directBody, { headers: { "content-encoding": "gzip" } });
    },
  });
  const customBody = brotliCompressSync(Buffer.from("custom-br"));
  const custom = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(customBody, { headers: { "content-encoding": "br" } });
    },
  });
  try {
    const directResponse = await fetchUpstreamProvider(
      new Request(`${direct.url.origin}/responses`),
      config({ mode: "direct" }),
    );
    expect(directResponse.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await directResponse.arrayBuffer())).toString()).toBe("direct-gzip");

    const customResponse = await fetchUpstreamProvider(
      new Request("http://provider.invalid/responses"),
      config({ mode: "custom", url: custom.url.origin }),
    );
    expect(customResponse.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await customResponse.arrayBuffer())).toString()).toBe("custom-br");
  } finally {
    direct.stop(true);
    custom.stop(true);
  }
});
