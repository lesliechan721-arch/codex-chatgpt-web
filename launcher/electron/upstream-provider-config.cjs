const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { normalizeNetworkProxyUrl } = require("./network-proxy-config.cjs");

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_REGEX_CHARS = 512;
const MAX_MODEL_ID_CHARS = 256;

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value) || value.includes("?") || value.includes("#")) {
    throw new Error("invalid-upstream-config");
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid-upstream-config"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || parsed.search || parsed.hash) throw new Error("invalid-upstream-config");
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

function normalizeModelId(value) {
  if (typeof value !== "string" || !value || value.length > MAX_MODEL_ID_CHARS || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith("chatgpt-web/")) {
    throw new Error("invalid-upstream-filter");
  }
  return value;
}

function normalizeFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-upstream-filter");
  if (value.mode === "all" && Object.keys(value).every(key => key === "mode")) return { mode: "all" };
  if (value.mode === "regex" && Object.keys(value).every(key => key === "mode" || key === "pattern")) {
    if (typeof value.pattern !== "string" || value.pattern.length > MAX_REGEX_CHARS
      || /[\u0000-\u001f\u007f]/.test(value.pattern)) throw new Error("invalid-upstream-filter");
    try { new RegExp(value.pattern); } catch { throw new Error("invalid-upstream-filter"); }
    return { mode: "regex", pattern: value.pattern };
  }
  if (value.mode === "selected" && Object.keys(value).every(key => key === "mode" || key === "models")
    && Array.isArray(value.models)) {
    const models = [];
    const seen = new Set();
    for (const raw of value.models) {
      const model = normalizeModelId(raw);
      if (!seen.has(model)) { seen.add(model); models.push(model); }
    }
    return { mode: "selected", models };
  }
  throw new Error("invalid-upstream-filter");
}

function normalizeProxy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-upstream-proxy");
  if ((value.mode === "global" || value.mode === "direct") && Object.keys(value).every(key => key === "mode")) {
    return { mode: value.mode };
  }
  if (value.mode === "custom" && Object.keys(value).every(key => key === "mode" || key === "url")) {
    const url = normalizeNetworkProxyUrl(value.url);
    if (!url) throw new Error("invalid-upstream-proxy");
    return { mode: "custom", url };
  }
  throw new Error("invalid-upstream-proxy");
}

function parseUpstreamConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-upstream-config");
  const allowed = ["version", "baseUrl", "apiKeySha256", "proxy", "modelFilter", "supportsOpenAiServerCompaction"];
  if (value.version !== 1 || Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.apiKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.apiKeySha256)
    || (value.supportsOpenAiServerCompaction !== undefined && typeof value.supportsOpenAiServerCompaction !== "boolean")) {
    throw new Error("invalid-upstream-config");
  }
  return {
    version: 1,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiKeySha256: value.apiKeySha256,
    proxy: normalizeProxy(value.proxy),
    modelFilter: normalizeFilter(value.modelFilter),
    supportsOpenAiServerCompaction: value.supportsOpenAiServerCompaction === true,
  };
}

function readUpstreamConfig(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error();
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > MAX_CONFIG_BYTES) throw new Error();
    return { config: parseUpstreamConfig(JSON.parse(bytes.toString("utf8"))), bytes };
  } catch (error) {
    if (error?.code === "ENOENT") return { config: null, bytes: null };
    throw new Error("invalid-upstream-config");
  }
}

function upstreamKeyDigest(key) {
  return createHash("sha256").update(key).digest("hex");
}

function validateUpstreamChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Object.keys(input).every(key => ["expectedRevision", "baseUrl", "apiKey", "proxy", "modelFilter", "supportsOpenAiServerCompaction"].includes(key))
    || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || (input.apiKey !== undefined && typeof input.apiKey !== "string")
    || typeof input.supportsOpenAiServerCompaction !== "boolean") throw new Error("invalid-input");
  return {
    expectedRevision: input.expectedRevision,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    proxy: normalizeProxy(input.proxy),
    modelFilter: normalizeFilter(input.modelFilter),
    supportsOpenAiServerCompaction: input.supportsOpenAiServerCompaction,
  };
}

module.exports = {
  MAX_CONFIG_BYTES,
  normalizeBaseUrl,
  normalizeFilter,
  normalizeModelId,
  normalizeProxy,
  parseUpstreamConfig,
  readUpstreamConfig,
  upstreamKeyDigest,
  validateUpstreamChange,
};
