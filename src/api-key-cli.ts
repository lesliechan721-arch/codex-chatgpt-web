import { stdin, stdout, stderr } from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir, getConfigPath, loadConfig } from "./config";
import { API_KEY_ENV, OPENAI_ACCESS, apiKeyMatches, apiKeyPolicy, generateApiKey } from "./api-access";
import { apiAccessConfigPath, loadApiAccessPolicy, saveApiAccessPolicy } from "./api-access-config";
import { availableChatGptWebModelRoutes } from "./chatgpt-web-models";
import { buildStandaloneModelCatalog } from "./standalone-model-catalog";
import { installCodexIntegration } from "./codex-integration";
import { cleanupApiKeyCodexIntegration } from "./api-key-integration";
import { renderApiKeyCodexConfig } from "./api-key-codex-config";

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
    // Imported secrets are never echoed, and status/config export never reveals any secret/hash.
    if (generated) stdout.write(`${key}\n`);
    try { cleanupApiKeyCodexIntegration(); }
    catch { stderr.write("Saved, but recorded Codex injection needs manual conflict resolution; run api-key cleanup.\n"); }
    stderr.write(`API key mode saved. Restart the service/Launcher to apply it; an already-running process keeps its previous policy.\n`);
    stderr.write(`Set ${API_KEY_ENV} in the Codex client environment. Browser ChatGPT login and Full-mode tunnel credentials remain separate.\n`);
    return;
  }
  if (args.length) throw new Error(`api-key ${action} does not accept additional arguments`);
  if (action === "disable") {
    // Explicit recovery command can replace malformed policy files without an insecure runtime fallback.
    saveApiAccessPolicy(OPENAI_ACCESS);
    stderr.write("OpenAI passthrough mode saved. Restart the service/Launcher and restore your previous Codex provider configuration to apply it.\n");
    return;
  }
  const policy = loadApiAccessPolicy();
  if (action === "reconnect") {
    if (policy.mode !== "openai") throw new Error("API Key mode never installs Codex configuration");
    installCodexIntegration(loadConfig());
    stdout.write(`${JSON.stringify({ installed: true })}\n`);
    return;
  }
  if (action === "cleanup") {
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
  const config = loadConfig();
  const route = availableChatGptWebModelRoutes(config)[0];
  if (!route) throw new Error("No ChatGPT Web models are available in the current account/mode configuration");
  const catalogPath = join(getConfigDir(), "api-key-models.json");
  const catalog = buildStandaloneModelCatalog(config);
  atomicWriteFile(catalogPath, `${JSON.stringify({ models: catalog.models }, null, 2)}\n`);
  stdout.write(renderApiKeyCodexConfig({
    port: config.port,
    catalogPath,
    model: route.slug,
    reasoningEffort: route.codexEffort,
    subagentProtocol: config.subagentProtocol,
    runtimeCommand: config.runtimeCommand,
  }));
  stderr.write("Local model catalog exported. Re-export after account capabilities, browser mode or context settings change.\n");
}
