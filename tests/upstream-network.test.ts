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
    version: 2,
    baseUrl: "http://provider.invalid/v1/",
    apiKeySha256: "a".repeat(64),
    proxy,
    models: [{ id: "gpt-test" }],
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

// Keep proxy variables out of the test runner's shared native HTTP client state.
async function fetchWithProxyEnvironment(
  requests: Array<{ url: string; proxy: UpstreamProxyConfig }>,
  environment: Record<string, string>,
): Promise<string[]> {
  const child = Bun.spawn([process.execPath, "-e", `
    import { fetchUpstreamProvider } from ${JSON.stringify(new URL("../src/upstream-network.ts", import.meta.url).href)};
    const keys = ${JSON.stringify(proxyEnvKeys)};
    const snapshot = () => Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const before = snapshot();
    const texts = await Promise.all(${JSON.stringify(requests)}.map(async ({ url, proxy }) =>
      (await fetchUpstreamProvider(new Request(url), { ...${JSON.stringify(config({ mode: "direct" }))}, proxy })).text()));
    console.log(JSON.stringify({ texts, before, after: snapshot() }));
  `], {
    env: { ...process.env, ...Object.fromEntries(proxyEnvKeys.map(key => [key, undefined])), ...environment },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const result = JSON.parse(stdout);
  expect(result.before).toMatchObject(environment);
  expect(result.after).toEqual(result.before);
  return result.texts;
}

test("direct upstream transport ignores process proxy variables without changing them", async () => {
  let proxyCalls = 0;
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { proxyCalls++; return new Response("proxy"); } });
  let targetCalls = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetCalls++; return new Response("direct"); } });
  try {
    const texts = await fetchWithProxyEnvironment([{ url: `${target.url.origin}/responses`, proxy: { mode: "direct" } }], {
      HTTP_PROXY: proxy.url.origin, HTTPS_PROXY: proxy.url.origin, ALL_PROXY: proxy.url.origin,
    });
    expect(texts).toEqual(["direct"]);
    expect({ targetCalls, proxyCalls }).toEqual({ targetCalls: 1, proxyCalls: 0 });
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
  try {
    const proxyUrl = new URL(selected.url.origin);
    proxyUrl.username = "proxy-user";
    proxyUrl.password = "proxy-pass";
    const texts = await fetchWithProxyEnvironment([
      { url: "http://custom-upstream.invalid/responses", proxy: { mode: "custom", url: proxyUrl.href } },
    ], { HTTP_PROXY: global.url.origin, HTTPS_PROXY: global.url.origin });
    expect(texts).toEqual(["custom"]);
    expect(selectedCalls).toBe(1);
    expect(globalCalls).toBe(0);
    expect(proxyAuthorization).toMatch(/^Basic /);
  } finally {
    selected.stop(true);
    global.stop(true);
  }
});

test("direct and custom requests can run concurrently without changing global proxy state", async () => {
  const directTarget = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("direct"); } });
  const customProxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("custom"); } });
  try {
    const texts = await fetchWithProxyEnvironment([
      { url: `${directTarget.url.origin}/responses`, proxy: { mode: "direct" } },
      { url: "http://custom-target.invalid/responses", proxy: { mode: "custom", url: customProxy.url.origin } },
    ], { HTTP_PROXY: "http://global.invalid:8123", HTTPS_PROXY: "http://global.invalid:8123" });
    expect(texts).toEqual(["direct", "custom"]);
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
