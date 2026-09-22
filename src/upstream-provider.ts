import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import metadata from "../launcher/electron/codex-model-metadata.cjs";
import type { MetadataBaseMode, ModelMetadataConfig } from "../launcher/electron/codex-model-metadata.cjs";

export const UPSTREAM_API_KEY_ENV = "CODEX_CHATGPT_WEB_UPSTREAM_API_KEY";
export const MAX_UPSTREAM_API_KEY_CHARS = 4_096;

export type UpstreamProxyConfig =
  | { mode: "global" }
  | { mode: "direct" }
  | { mode: "custom"; url: string };

export type { MetadataBaseMode, ModelMetadataConfig };

export interface UpstreamModelConfig {
  id: string;
  metadata?: ModelMetadataConfig;
}

export interface UpstreamProviderConfig {
  version: 2;
  baseUrl: string;
  apiKeySha256: string;
  proxy: UpstreamProxyConfig;
  models: UpstreamModelConfig[];
  supportsOpenAiServerCompaction: boolean;
}

export interface UpstreamProviderRuntime {
  config?: UpstreamProviderConfig;
  apiKey?: string;
  available: boolean;
  keyMatches: boolean;
}

function controls(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function normalizeUpstreamBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4_096 || controls(value) || value.trim() !== value
    || value.includes("?") || value.includes("#")) {
    throw new Error("Invalid upstream base URL");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Invalid upstream base URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid upstream base URL");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.href;
}

function validateRawProxyCredentials(value: string): void {
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
  if (!encodedComponent.test(username) || !encodedComponent.test(password) || (!username && password)) {
    throw new Error("Invalid upstream proxy URL");
  }
}

export function normalizeUpstreamProxyUrl(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 2_048 || controls(value) || value.trim() !== value
    || !/^https?:\/\//i.test(value) || value.includes("\\")) {
    throw new Error("Invalid upstream proxy URL");
  }
  validateRawProxyCredentials(value);
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Invalid upstream proxy URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname
    || parsed.pathname !== "/" || parsed.search || parsed.hash || (!parsed.username && parsed.password)) {
    throw new Error("Invalid upstream proxy URL");
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch { throw new Error("Invalid upstream proxy URL"); }
  return parsed.href;
}

export function validateUpstreamApiKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_UPSTREAM_API_KEY_CHARS
    || /[\r\n\u0000]/.test(value)) {
    throw new Error("Invalid upstream API key");
  }
  return value;
}

export function upstreamApiKeyDigest(value: string): string {
  return createHash("sha256").update(validateUpstreamApiKey(value)).digest("hex");
}

export function upstreamApiKeyMatches(value: unknown, digest: string): value is string {
  if (typeof value !== "string") return false;
  let actual: Buffer;
  try { actual = createHash("sha256").update(validateUpstreamApiKey(value)).digest(); }
  catch { return false; }
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  const expected = Buffer.from(digest, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function normalizeUpstreamModelId(value: unknown): string {
  return metadata.normalizeModelId(value);
}

export function normalizeModelMetadataConfig(value: unknown): ModelMetadataConfig | undefined {
  return metadata.normalizeMetadataConfig(value);
}

function normalizeUpstreamModels(value: unknown): UpstreamModelConfig[] {
  if (!Array.isArray(value)) throw new Error("Invalid upstream model configuration");
  const byId = new Map<string, UpstreamModelConfig>();
  for (const rawModel of value) {
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
      throw new Error("Invalid upstream model configuration");
    }
    const raw = rawModel as Record<string, unknown>;
    if (Object.keys(raw).some(key => key !== "id" && key !== "metadata")) {
      throw new Error("Invalid upstream model configuration");
    }
    const id = normalizeUpstreamModelId(raw.id);
    const normalizedMetadata = normalizeModelMetadataConfig(raw.metadata);
    const model = Object.freeze({ id, ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}) });
    if (!byId.has(id)) byId.set(id, model);
    else if (JSON.stringify(byId.get(id)) !== JSON.stringify(model)) {
      throw new Error("Duplicate upstream model configuration");
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function parseUpstreamProviderConfig(value: unknown): UpstreamProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid upstream provider configuration");
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["version", "baseUrl", "apiKeySha256", "proxy", "models", "supportsOpenAiServerCompaction"]);
  if (raw.version !== 2 || Object.keys(raw).some(key => !allowed.has(key))
    || typeof raw.apiKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.apiKeySha256)) {
    throw new Error("Invalid upstream provider configuration");
  }
  if (!raw.proxy || typeof raw.proxy !== "object" || Array.isArray(raw.proxy)) {
    throw new Error("Invalid upstream provider configuration");
  }
  const proxyRaw = raw.proxy as Record<string, unknown>;
  let proxy: UpstreamProxyConfig;
  if ((proxyRaw.mode === "global" || proxyRaw.mode === "direct")
    && Object.keys(proxyRaw).every(key => key === "mode")) proxy = { mode: proxyRaw.mode };
  else if (proxyRaw.mode === "custom" && Object.keys(proxyRaw).every(key => key === "mode" || key === "url")) {
    proxy = { mode: "custom", url: normalizeUpstreamProxyUrl(proxyRaw.url) };
  } else throw new Error("Invalid upstream provider configuration");
  if (raw.supportsOpenAiServerCompaction !== undefined && typeof raw.supportsOpenAiServerCompaction !== "boolean") {
    throw new Error("Invalid upstream provider configuration");
  }
  return Object.freeze({
    version: 2,
    baseUrl: normalizeUpstreamBaseUrl(raw.baseUrl),
    apiKeySha256: raw.apiKeySha256,
    proxy,
    models: normalizeUpstreamModels(raw.models),
    supportsOpenAiServerCompaction: raw.supportsOpenAiServerCompaction === true,
  });
}

export function upstreamModelAllowed(model: unknown, config: UpstreamProviderConfig): boolean {
  let normalized: string;
  try { normalized = normalizeUpstreamModelId(model); }
  catch { return false; }
  return config.models.some(candidate => candidate.id === normalized);
}

export function upstreamModelConfig(model: string, config: UpstreamProviderConfig): UpstreamModelConfig | undefined {
  return config.models.find(candidate => candidate.id === model);
}

export function upstreamEndpoint(config: UpstreamProviderConfig, endpoint: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(endpoint) || endpoint.startsWith("/")) {
    throw new Error("Invalid upstream endpoint");
  }
  return `${config.baseUrl}${endpoint}`;
}

export function upstreamProviderRevision(config: UpstreamProviderConfig, controlToken: string): string {
  return createHmac("sha256", controlToken)
    .update(`codex-web-upstream-provider:v2\0${JSON.stringify(config)}`)
    .digest("hex");
}
