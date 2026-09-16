const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyNetworkProxyEnvironment,
  captureProxyEnvironment,
  electronProxyConfiguration,
  networkProxyAuthentication,
  mergeNoProxy,
  normalizeNetworkProxyUrl,
} = require("../electron/network-proxy-config.cjs");

test("network proxy URL accepts HTTP(S), trims input, and canonicalizes the root URL", () => {
  assert.equal(normalizeNetworkProxyUrl("  http://127.0.0.1:7890  "), "http://127.0.0.1:7890/");
  assert.equal(normalizeNetworkProxyUrl("https://proxy.example:8443"), "https://proxy.example:8443/");
  assert.equal(normalizeNetworkProxyUrl("HTTP://PROXY.EXAMPLE:8080"), "http://proxy.example:8080/");
  assert.equal(normalizeNetworkProxyUrl(""), null);
  assert.equal(normalizeNetworkProxyUrl("   "), null);
  assert.equal(normalizeNetworkProxyUrl(null), null);
});

test("network proxy URL accepts and decodes credentials exactly once", () => {
  assert.equal(
    normalizeNetworkProxyUrl("https://user:p%40ss@Proxy.EXAMPLE:443"),
    "https://user:p%40ss@proxy.example/",
  );
  assert.deepEqual(networkProxyAuthentication("http://name:@[2001:DB8::1]"), {
    username: "name",
    password: "",
    host: "2001:db8::1",
    port: 80,
  });
  assert.deepEqual(networkProxyAuthentication("https://u%2525:p%2540@proxy.example:8443"), {
    username: "u%25",
    password: "p%40",
    host: "proxy.example",
    port: 8443,
  });
  assert.equal(networkProxyAuthentication("http://proxy.example"), null);
});

test("network proxy URL rejects unsupported or ambiguous proxy endpoints", () => {
  assert.throws(() => normalizeNetworkProxyUrl("socks5://127.0.0.1:1080"), /http:\/\/ or https:\/\//);
  assert.throws(() => normalizeNetworkProxyUrl("http://:secret@127.0.0.1:7890"), /username/);
  assert.throws(() => normalizeNetworkProxyUrl("http://user:%ZZ@127.0.0.1:7890"), /percent-encoding/);
  assert.throws(() => normalizeNetworkProxyUrl("http://us%ZZer@127.0.0.1:7890"), /percent-encoding/);
  assert.throws(() => normalizeNetworkProxyUrl("http://user:p@ss@127.0.0.1:7890"), /percent-encoding/);
  assert.throws(() => normalizeNetworkProxyUrl("http://user:pa:ss@127.0.0.1:7890"), /percent-encoding/);
  assert.throws(() => normalizeNetworkProxyUrl("http://127.0.0.1:7890/path"), /path, query, or fragment/);
  assert.throws(() => normalizeNetworkProxyUrl("http://127.0.0.1:7890/?x=1"), /path, query, or fragment/);
  assert.throws(() => normalizeNetworkProxyUrl("not a url"), /invalid|http:\/\/ or https:\/\//);
  assert.throws(() => normalizeNetworkProxyUrl({}), /must be a string/);
  assert.throws(() => normalizeNetworkProxyUrl("http://proxy.example\n"), /invalid/);
  assert.throws(() => normalizeNetworkProxyUrl(`http://${"x".repeat(2_048)}`), /too long/);
});

test("network proxy URL requires exact HTTP(S) authority syntax", () => {
  for (const value of [
    "http:/proxy.example",
    "https:/proxy.example",
    "http:///proxy.example",
    "https:////proxy.example",
    "http:\\proxy.example",
    "http://\\proxy.example",
    "http://proxy.example\\path",
    "http://proxy.example?",
    "http://proxy.example#",
    "http://proxy.example?query",
    "http://proxy.example#fragment",
  ]) {
    assert.throws(() => normalizeNetworkProxyUrl(value), /http:\/\/ or https:\/\/|invalid|path, query, or fragment/, value);
  }
});

test("network proxy URL rejects raw paths before WHATWG dot-segment normalization", () => {
  for (const suffix of [
    "/.",
    "/%2e",
    "/%2E",
    "/a/..",
    "/a/%2e%2e",
    "/../",
    "/%2e%2e",
    "/%2E%2e/",
  ]) {
    for (const authority of [
      "proxy.example:8080",
      "user:p%40ss@proxy.example:8080",
      "user:p%40ss@[2001:db8::1]:8080",
    ]) {
      const value = `http://${authority}${suffix}`;
      assert.throws(
        () => normalizeNetworkProxyUrl(value),
        /path, query, or fragment/,
        value,
      );
    }
  }
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
  assert.deepEqual(electronProxyConfiguration("https://user:secret@Proxy.EXAMPLE:443"), {
    mode: "fixed_servers",
    proxyRules: "https://proxy.example/",
    proxyBypassRules: "localhost;127.0.0.1;[::1]",
  });
});

test("authenticated proxy URL remains in the process environment", () => {
  const environment = {};
  const proxy = applyNetworkProxyEnvironment(
    environment,
    captureProxyEnvironment(environment),
    "http://user:p%40ss@proxy.example:80",
  );
  assert.equal(proxy, "http://user:p%40ss@proxy.example/");
  assert.equal(environment.HTTP_PROXY, proxy);
});
