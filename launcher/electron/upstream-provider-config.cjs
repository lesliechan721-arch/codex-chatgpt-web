const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { normalizeNetworkProxyUrl } = require("./network-proxy-config.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const modelMetadata = require("./codex-model-metadata.cjs");

const MAX_CONFIG_BYTES = 128 * 1024;
const RESET_REASON = "legacy-v1-removed";

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
  try { return modelMetadata.normalizeModelId(value); }
  catch { throw new Error("invalid-upstream-models"); }
}

function normalizeModels(value) {
  if (!Array.isArray(value)) throw new Error("invalid-upstream-models");
  const result = new Map();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).some(key => !["id", "metadata"].includes(key))) {
      throw new Error("invalid-upstream-models");
    }
    const id = normalizeModelId(candidate.id);
    let metadata;
    try { metadata = modelMetadata.normalizeMetadataConfig(candidate.metadata); }
    catch { throw new Error("invalid-upstream-metadata"); }
    const normalized = { id, ...(metadata ? { metadata } : {}) };
    if (result.has(id) && JSON.stringify(result.get(id)) !== JSON.stringify(normalized)) {
      throw new Error("invalid-upstream-models");
    }
    if (!result.has(id)) result.set(id, normalized);
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
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
  const allowed = ["version", "baseUrl", "apiKeySha256", "proxy", "models", "supportsOpenAiServerCompaction"];
  if (value.version !== 2 || Object.keys(value).some(key => !allowed.includes(key))
    || typeof value.apiKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.apiKeySha256)
    || (value.supportsOpenAiServerCompaction !== undefined && typeof value.supportsOpenAiServerCompaction !== "boolean")) {
    throw new Error("invalid-upstream-config");
  }
  return {
    version: 2,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiKeySha256: value.apiKeySha256,
    proxy: normalizeProxy(value.proxy),
    models: normalizeModels(value.models),
    supportsOpenAiServerCompaction: value.supportsOpenAiServerCompaction === true,
  };
}

function resetMarkerPath(filePath) {
  return path.join(path.dirname(filePath), "upstream-provider-reset.json");
}

function readResetMarker(filePath) {
  const markerPath = resetMarkerPath(filePath);
  try {
    const value = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return value && value.version === 1 && value.reason === RESET_REASON
      && Object.keys(value).every(key => key === "version" || key === "reason") ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("invalid-upstream-reset");
  }
}

function clearResetMarker(filePath) {
  try { fs.rmSync(resetMarkerPath(filePath), { force: true }); }
  catch { throw new Error("upstream-legacy-cleanup-failed"); }
}

function removeLegacyV1(filePath) {
  try {
    writePrivateFileAtomic(resetMarkerPath(filePath), `${JSON.stringify({ version: 1, reason: RESET_REASON }, null, 2)}\n`);
  } catch { throw new Error("upstream-legacy-cleanup-failed"); }
  try { fs.rmSync(filePath); }
  catch { throw new Error("upstream-legacy-cleanup-failed"); }
}

function readUpstreamConfig(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error();
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > MAX_CONFIG_BYTES) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.version === 1) {
      removeLegacyV1(filePath);
      return { config: null, bytes: null, resetReason: RESET_REASON };
    }
    return { config: parseUpstreamConfig(parsed), bytes, resetReason: readResetMarker(filePath)?.reason ?? null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { config: null, bytes: null, resetReason: readResetMarker(filePath)?.reason ?? null };
    }
    if (["upstream-legacy-cleanup-failed", "invalid-upstream-reset"].includes(error?.message)) throw error;
    throw new Error("invalid-upstream-config");
  }
}

function upstreamKeyDigest(key) {
  return createHash("sha256").update(key).digest("hex");
}

function validateUpstreamChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Object.keys(input).every(key => ["expectedRevision", "baseUrl", "apiKey", "proxy", "models", "supportsOpenAiServerCompaction"].includes(key))
    || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
    || (input.apiKey !== undefined && typeof input.apiKey !== "string")
    || typeof input.supportsOpenAiServerCompaction !== "boolean") throw new Error("invalid-input");
  return {
    expectedRevision: input.expectedRevision,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    proxy: normalizeProxy(input.proxy),
    models: normalizeModels(input.models),
    supportsOpenAiServerCompaction: input.supportsOpenAiServerCompaction,
  };
}

module.exports = {
  MAX_CONFIG_BYTES,
  RESET_REASON,
  clearResetMarker,
  normalizeBaseUrl,
  normalizeModelId,
  normalizeModels,
  normalizeProxy,
  parseUpstreamConfig,
  readResetMarker,
  readUpstreamConfig,
  resetMarkerPath,
  upstreamKeyDigest,
  validateUpstreamChange,
};
