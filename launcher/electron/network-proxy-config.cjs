const PROXY_ENV_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "TUNNEL_CLIENT_HTTP_PROXY",
  "CONTROL_PLANE_HTTP_PROXY",
  "MCP_HTTP_PROXY",
  "HARPOON_HTTP_PROXY",
]);

const LOOPBACK_BYPASS_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
const ELECTRON_PROXY_BYPASS_RULES = "localhost;127.0.0.1;[::1]";
const MAX_PROXY_URL_CHARS = 2_048;

function normalizeNetworkProxyUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Network proxy URL must be a string");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PROXY_URL_CHARS || /[\r\n\0]/.test(trimmed)) {
    throw new Error("Network proxy URL is invalid or too long");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Network proxy URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Network proxy must use http:// or https://");
  }
  if (!parsed.hostname) throw new Error("Network proxy URL requires a host");
  if (parsed.username || parsed.password) {
    throw new Error("Authenticated proxy URLs are not supported by the embedded Chromium session");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Network proxy URL must not contain a path, query, or fragment");
  }
  return parsed.href;
}

function captureProxyEnvironment(environment = process.env) {
  return Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, environment[key]]));
}

function restoreProxyEnvironment(environment, baseline) {
  for (const key of PROXY_ENV_KEYS) {
    const value = baseline?.[key];
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
}

function mergeNoProxy(...values) {
  const entries = [];
  const seen = new Set();
  for (const value of [...values, LOOPBACK_BYPASS_HOSTS.join(",")]) {
    if (typeof value !== "string") continue;
    for (const raw of value.split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const identity = entry.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push(entry);
    }
  }
  return entries.join(",");
}

function applyNetworkProxyEnvironment(environment, baseline, rawProxyUrl) {
  const proxyUrl = normalizeNetworkProxyUrl(rawProxyUrl);
  restoreProxyEnvironment(environment, baseline);
  if (!proxyUrl) return null;

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
    environment[key] = proxyUrl;
  }
  const noProxy = mergeNoProxy(baseline?.NO_PROXY, baseline?.no_proxy);
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
  return proxyUrl;
}

function electronProxyConfiguration(rawProxyUrl) {
  const proxyUrl = normalizeNetworkProxyUrl(rawProxyUrl);
  return proxyUrl
    ? {
        mode: "fixed_servers",
        proxyRules: proxyUrl,
        proxyBypassRules: ELECTRON_PROXY_BYPASS_RULES,
      }
    : { mode: "system" };
}

module.exports = {
  ELECTRON_PROXY_BYPASS_RULES,
  LOOPBACK_BYPASS_HOSTS,
  MAX_PROXY_URL_CHARS,
  PROXY_ENV_KEYS,
  applyNetworkProxyEnvironment,
  captureProxyEnvironment,
  electronProxyConfiguration,
  mergeNoProxy,
  normalizeNetworkProxyUrl,
  restoreProxyEnvironment,
};
