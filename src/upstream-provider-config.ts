import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";
import {
  UPSTREAM_API_KEY_ENV,
  parseUpstreamProviderConfig,
  upstreamApiKeyMatches,
  type UpstreamProviderConfig,
  type UpstreamProviderRuntime,
} from "./upstream-provider";

const MAX_CONFIG_BYTES = 128 * 1024;

export function upstreamProviderConfigPath(home = getConfigDir()): string {
  return join(home, "upstream-provider.json");
}

export function loadUpstreamProviderConfig(home = getConfigDir()): UpstreamProviderConfig | undefined {
  const path = upstreamProviderConfigPath(home);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot inspect upstream provider configuration");
  }
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error("Invalid upstream provider configuration");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Invalid upstream provider configuration"); }
  return parseUpstreamProviderConfig(parsed);
}

export function saveUpstreamProviderConfig(config: UpstreamProviderConfig, home = getConfigDir()): void {
  const validated = parseUpstreamProviderConfig(config);
  atomicWriteFile(upstreamProviderConfigPath(home), `${JSON.stringify(validated, null, 2)}\n`);
}

export function loadUpstreamProviderRuntime(
  home = getConfigDir(),
  environment: NodeJS.ProcessEnv = process.env,
): UpstreamProviderRuntime {
  const config = loadUpstreamProviderConfig(home);
  if (!config) return { available: false, keyMatches: false };
  const candidate = environment[UPSTREAM_API_KEY_ENV];
  const keyMatches = upstreamApiKeyMatches(candidate, config.apiKeySha256);
  return {
    config,
    ...(keyMatches ? { apiKey: candidate } : {}),
    available: keyMatches,
    keyMatches,
  };
}
