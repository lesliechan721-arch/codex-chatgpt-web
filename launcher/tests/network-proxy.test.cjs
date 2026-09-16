const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyNetworkProxyEnvironment,
  captureProxyEnvironment,
  electronProxyConfiguration,
  mergeNoProxy,
  normalizeNetworkProxyUrl,
} = require("../electron/network-proxy-config.cjs");

test("network proxy URL accepts HTTP(S), trims input, and canonicalizes the root URL", () => {
  assert.equal(normalizeNetworkProxyUrl("  http://127.0.0.1:7890  "), "http://127.0.0.1:7890/");
  assert.equal(normalizeNetworkProxyUrl("https://proxy.example:8443"), "https://proxy.example:8443/");
  assert.equal(normalizeNetworkProxyUrl(""), null);
  assert.equal(normalizeNetworkProxyUrl("   "), null);
  assert.equal(normalizeNetworkProxyUrl(null), null);
});

test("network proxy URL rejects unsupported or ambiguous proxy endpoints", () => {
  assert.throws(() => normalizeNetworkProxyUrl("socks5://127.0.0.1:1080"), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeNetworkProxyUrl("http://user:secret@127.0.0.1:7890"), /Authenticated proxy URLs/);
  assert.throws(() => normalizeNetworkProxyUrl("http://127.0.0.1:7890/path"), /path, query, or fragment/);
  assert.throws(() => normalizeNetworkProxyUrl("http://127.0.0.1:7890/?x=1"), /path, query, or fragment/);
  assert.throws(() => normalizeNetworkProxyUrl("not a url"), /invalid/);
  assert.throws(() => normalizeNetworkProxyUrl({}), /must be a string/);
});

test("global proxy environment covers daemon and tunnel traffic while bypassing loopback", () => {
  const environment = {
    HTTPS_PROXY: "http://inherited.example:8080",
    NO_PROXY: "internal.example,localhost",
    OTHER: "kept",
  };
  const baseline = captureProxyEnvironment(environment);
  const proxy = applyNetworkProxyEnvironment(environment, baseline, "http://127.0.0.1:7890");
  assert.equal(proxy, "http://127.0.0.1:7890/");
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "TUNNEL_CLIENT_HTTP_PROXY",
    "CONTROL_PLANE_HTTP_PROXY",
    "MCP_HTTP_PROXY",
    "HARPOON_HTTP_PROXY",
  ]) {
    assert.equal(environment[key], proxy, key);
  }
  assert.equal(environment.NO_PROXY, "internal.example,localhost,127.0.0.1,::1");
  assert.equal(environment.no_proxy, environment.NO_PROXY);
  assert.equal(environment.OTHER, "kept");

  applyNetworkProxyEnvironment(environment, baseline, null);
  assert.equal(environment.HTTPS_PROXY, "http://inherited.example:8080");
  assert.equal(environment.NO_PROXY, "internal.example,localhost");
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.TUNNEL_CLIENT_HTTP_PROXY, undefined);
  assert.equal(environment.OTHER, "kept");
});

test("NO_PROXY merging is stable and de-duplicates loopback hosts", () => {
  assert.equal(
    mergeNoProxy("localhost,example.test", "127.0.0.1,EXAMPLE.test"),
    "localhost,example.test,127.0.0.1,::1",
  );
});

test("Electron proxy configuration switches between fixed and system modes", () => {
  assert.deepEqual(electronProxyConfiguration(null), { mode: "system" });
  assert.deepEqual(electronProxyConfiguration("http://127.0.0.1:7890"), {
    mode: "fixed_servers",
    proxyRules: "http://127.0.0.1:7890/",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  });
});
