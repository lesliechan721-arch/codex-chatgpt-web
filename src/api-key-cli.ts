import { stdin, stdout, stderr } from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig, type AppConfig } from "./config";
import {
  API_KEY_ENV,
  OPENAI_ACCESS,
  apiAccessRevision,
  apiKeyMatches,
  apiKeyPolicy,
  generateApiKey,
  type ApiAccessPolicy,
} from "./api-access";
import {
  apiAccessConfigPath,
  clearOpenAiRoutingPending,
  loadApiAccessPolicy,
  saveApiAccessPolicy,
} from "./api-access-config";
import { availableChatGptWebModelRoutes } from "./chatgpt-web-models";
import { buildStandaloneModelCatalog } from "./standalone-model-catalog";
import codexModelMetadata from "../launcher/electron/codex-model-metadata.cjs";
import { installCodexIntegration } from "./codex-integration";
import { cleanupApiKeyCodexIntegration } from "./api-key-integration";
import { codexProxyEnvironment, renderApiKeyCodexConfig } from "./api-key-codex-config";
import { loadUpstreamProviderConfig } from "./upstream-provider-config";
import {
  clientBaseUrl,
  clientCatalogPath,
  manualCodexConfigurationOnly,
} from "./server-remote-config";
import { upstreamProviderRevision, type UpstreamProviderConfig } from "./upstream-provider";

type FetchLike = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
const LOOPBACK_EXPORT_REQUEST_TIMEOUT_MS = 5_000;
const API_ACCESS_REVISION_HEADER = "x-codex-chatgpt-web-api-access-revision";
const UPSTREAM_PROVIDER_REVISION_HEADER = "x-codex-chatgpt-web-upstream-provider-revision";

async function withLoopbackExportTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new Error("Loopback export request timed out");
  const timer = setTimeout(() => controller.abort(timeoutError), LOOPBACK_EXPORT_REQUEST_TIMEOUT_MS);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason ?? timeoutError);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function buildApiKeyExportModelCatalog(
  config: AppConfig,
  policy: ApiAccessPolicy,
  localApiKey: string,
  upstream: UpstreamProviderConfig | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<ReturnType<typeof buildStandaloneModelCatalog>> {
  const local = buildStandaloneModelCatalog(config);
  if (!upstream) return local;
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const expectedApiAccessRevision = apiAccessRevision(policy, config.controlToken);
  const expectedUpstreamRevision = upstreamProviderRevision(upstream, config.controlToken);
  try {
    const health = await withLoopbackExportTimeout(async signal => {
      const response = await fetchImpl(`${baseUrl}/healthz`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal,
      });
      return await response.json() as Record<string, unknown>;
    });
    if (health.service !== "codex-chatgpt-web" || health.access_mode !== "api-key"
      || health.api_access_revision !== expectedApiAccessRevision
      || health.upstream_provider_available !== true
      || health.upstream_provider_revision !== expectedUpstreamRevision) {
      return local;
    }
    const upstreamCatalog = await withLoopbackExportTimeout(async signal => {
      const response = await fetchImpl(`${baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${localApiKey}`, accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok
        || response.headers.get(API_ACCESS_REVISION_HEADER) !== expectedApiAccessRevision
        || response.headers.get(UPSTREAM_PROVIDER_REVISION_HEADER) !== expectedUpstreamRevision) {
        return undefined;
      }
      return await response.json();
    });
    if (upstreamCatalog === undefined || !upstreamCatalog || typeof upstreamCatalog !== "object"
      || Array.isArray(upstreamCatalog)) return local;
    const raw = upstreamCatalog as Record<string, unknown>;
    if (raw.object !== "list" || !Array.isArray(raw.data) || !Array.isArray(raw.models)) return local;
    if (raw.models.some(model => codexModelMetadata.finalModelError(model) !== null)) return local;
    return raw as ReturnType<typeof buildStandaloneModelCatalog>;
  } catch {
    return local;
  }
}

async function readKeyFromStdin(): Promise<string> {
  if (stdin.isTTY) throw new Error("--key-stdin requires piped input; use --generate for a random key");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 258) throw new Error("API key input is too large");
    chunks.push(buffer);
  }
  // Permit one line terminator from a password manager or file, not arbitrary whitespace.
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

export async function runApiKeyCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  if (!["enable", "rotate", "disable", "status", "codex-config", "cleanup", "reconnect"].includes(action)) {
    throw new Error("API key command must be enable, rotate, disable, status, codex-config, cleanup or reconnect");
  }
  if (action === "enable" || action === "rotate") {
    if (args.length !== 1 || (args[0] !== "--generate" && args[0] !== "--key-stdin")) {
      throw new Error(`api-key ${action} requires exactly one of --generate or --key-stdin (never put a key in command arguments)`);
    }
    const current = loadApiAccessPolicy();
    if (action === "rotate" && current.mode !== "api-key") throw new Error("Enable API key mode before rotating its key");
    if (action === "enable" && current.mode === "api-key") throw new Error("API key mode is already configured; use rotate to replace its key");
    const generated = args[0] === "--generate";
    const key = generated ? generateApiKey() : await readKeyFromStdin();
    const policy = apiKeyPolicy(key);
    if (existsSync(getConfigPath()) && apiKeyMatches(loadConfig().controlToken, policy)) {
      throw new Error("Client API key must not be the daemon control token");
    }
    saveApiAccessPolicy(policy);
    // stdout contains only the newly generated secret, so callers can capture it without parsing.
    // Imported secrets are never echoed by enable/rotate or status. codex-config is an explicit
    // sensitive export action and includes the current local client key.
    if (generated) stdout.write(`${key}\n`);
    if (!manualCodexConfigurationOnly()) {
      try { cleanupApiKeyCodexIntegration(); }
      catch { stderr.write("Saved, but recorded Codex injection needs manual conflict resolution; run api-key cleanup.\n"); }
    }
    stderr.write(`API key mode saved. Restart the service/Launcher to apply it; an already-running process keeps its previous policy.\n`);
    stderr.write(`Keep ${API_KEY_ENV} available to API clients and for explicit api-key codex-config export. Browser ChatGPT login and Full-mode tunnel credentials remain separate.\n`);
    return;
  }
  const jsonExport = action === "codex-config" && args.length === 1 && args[0] === "--json";
  if (args.length && !jsonExport) throw new Error(`api-key ${action} does not accept additional arguments`);
  if (action === "disable") {
    // Explicit recovery command can replace malformed policy files without an insecure runtime fallback.
    saveApiAccessPolicy(OPENAI_ACCESS);
    stderr.write("OpenAI passthrough mode saved. Restart the service/Launcher and restore your previous Codex provider configuration to apply it.\n");
    return;
  }
  const policy = loadApiAccessPolicy();
  if (action === "reconnect") {
    if (policy.mode !== "openai") throw new Error("API Key mode never installs Codex configuration");
    if (manualCodexConfigurationOnly()) {
      clearOpenAiRoutingPending();
      stdout.write(`${JSON.stringify({ installed: false, manualConfigurationRequired: true })}\n`);
      return;
    }
    installCodexIntegration(loadConfig());
    clearOpenAiRoutingPending();
    stdout.write(`${JSON.stringify({ installed: true })}\n`);
    return;
  }
  if (action === "cleanup") {
    if (manualCodexConfigurationOnly()) {
      stdout.write(`${JSON.stringify({ changed: false, manualConfigurationRequired: true })}\n`);
      return;
    }
    stdout.write(`${JSON.stringify(cleanupApiKeyCodexIntegration())}\n`);
    return;
  }
  if (action === "status") {
    stdout.write(`${JSON.stringify({
      configured_mode: policy.mode,
      api_key_configured: policy.mode === "api-key",
      config_path: apiAccessConfigPath(),
      applies_on: "service restart",
    }, null, 2)}\n`);
    return;
  }
  if (policy.mode !== "api-key") throw new Error("Enable API key mode before exporting its Codex configuration");
  const localApiKey = process.env[API_KEY_ENV];
  if (!localApiKey || !apiKeyMatches(localApiKey, policy)) {
    throw new Error(`${API_KEY_ENV} must contain the current local API key before export`);
  }
  const config = loadConfig();
  const route = availableChatGptWebModelRoutes(config)[0];
  if (!route) throw new Error("No ChatGPT Web models are available in the current account/mode configuration");
  const localCatalogPath = join(getConfigDir(), "api-key-models.json");
  const clientRoute = clientBaseUrl(config.port);
  const externalClient = clientRoute.remote || manualCodexConfigurationOnly();
  const catalogPath = clientCatalogPath(localCatalogPath, externalClient);
  const upstream = loadUpstreamProviderConfig();
  const catalog = await buildApiKeyExportModelCatalog(config, policy, localApiKey, upstream);
  const catalogText = `${JSON.stringify({ models: catalog.models }, null, 2)}\n`;
  if (!externalClient) atomicWriteFile(localCatalogPath, catalogText);
  const rendered = renderApiKeyCodexConfig({
    port: config.port,
    baseUrl: clientRoute.baseUrl,
    catalogPath,
    model: route.slug,
    reasoningEffort: route.codexEffort,
    apiKey: localApiKey,
    supportsOpenAiServerCompaction: upstream?.supportsOpenAiServerCompaction === true,
    subagentProtocol: config.subagentProtocol,
    runtimeCommand: externalClient ? undefined : config.runtimeCommand,
  });
  const environment = codexProxyEnvironment();
  if (jsonExport) {
    stdout.write(`${JSON.stringify({
      config: rendered,
      catalogPath,
      catalog: catalogText,
      baseUrl: clientRoute.baseUrl,
      environment,
    })}\n`);
  } else {
    stdout.write(rendered);
    stderr.write(`Codex process environment: ${JSON.stringify(environment)}\n`);
    if (externalClient) {
      stderr.write(`Copy the exported model catalog to ${catalogPath}; use --json to retrieve its content.\n`);
    }
  }
  stderr.write("Sensitive client configuration exported. Re-export after account capabilities, browser mode or context settings change.\n");
}
