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

function validateRawProxyCredentials(value) {
  const authorityStart = value.indexOf("//") + 2;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = authorityEndOffset === -1 ? value.length : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const separator = authority.lastIndexOf("@");
  if (separator === -1) return;
  const userInfo = authority.slice(0, separator);
  const passwordSeparator = userInfo.indexOf(":");
  const username = passwordSeparator === -1 ? userInfo : userInfo.slice(0, passwordSeparator);
  const password = passwordSeparator === -1 ? "" : userInfo.slice(passwordSeparator + 1);
  const encodedComponent = /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})*$/;
  if (!encodedComponent.test(username) || !encodedComponent.test(password)) {
    throw new Error("Network proxy credential special characters must use percent-encoding");
  }
  if (!username && password) throw new Error("Network proxy credentials require a username");
}

function normalizeNetworkProxyUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Network proxy URL must be a string");
  if (value.length > MAX_PROXY_URL_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Network proxy URL is invalid or too long");
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error("Network proxy must use http:// or https://");
  }
  if (trimmed.includes("\\")) throw new Error("Network proxy URL is invalid");
  const authorityStart = trimmed.indexOf("//") + 2;
  const endpoint = trimmed.slice(authorityStart);
  const suffixOffset = endpoint.search(/[/?#]/);
  const rawAuthority = suffixOffset === -1 ? endpoint : endpoint.slice(0, suffixOffset);
  const rawSuffix = suffixOffset === -1 ? "" : endpoint.slice(suffixOffset);
  if (!rawAuthority
    || (rawSuffix !== "" && rawSuffix !== "/")
    || trimmed.includes("?")
    || trimmed.includes("#")) {
    throw new Error("Network proxy URL must not contain a path, query, or fragment");
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
  validateRawProxyCredentials(trimmed);
  if (!parsed.hostname) throw new Error("Network proxy URL requires a host");
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error("Network proxy credentials contain invalid percent-encoding");
  }
  if (!parsed.username && parsed.password) {
    throw new Error("Network proxy credentials require a username");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Network proxy URL must not contain a path, query, or fragment");
  }
  return parsed.href;
}

function normalizedProxyHost(host) {
  return String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
}

function networkProxyAuthentication(rawProxyUrl) {
  const proxyUrl = normalizeNetworkProxyUrl(rawProxyUrl);
  if (!proxyUrl) return null;
  const parsed = new URL(proxyUrl);
  if (!parsed.username) return null;
  return {
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: normalizedProxyHost(parsed.hostname),
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
  };
}

function proxyAuthenticationMatches(authentication, authInfo) {
  if (!authentication || !authInfo || authInfo.isProxy !== true) return false;
  if (String(authInfo.scheme || "").toLowerCase() !== "basic") return false;
  return normalizedProxyHost(authInfo.host) === authentication.host
    && Number(authInfo.port) === authentication.port;
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
  let electronProxyUrl = proxyUrl;
  if (electronProxyUrl) {
    const parsed = new URL(electronProxyUrl);
    electronProxyUrl = `${parsed.protocol}//${parsed.host}`;
  }
  return proxyUrl
    ? {
        mode: "fixed_servers",
        proxyRules: electronProxyUrl,
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
  networkProxyAuthentication,
  normalizeNetworkProxyUrl,
  proxyAuthenticationMatches,
  restoreProxyEnvironment,
};
