import type { ApiAccessPolicy } from "./api-access";

export const RESPONSES_BIND_HOST_ENV = "CODEX_CHATGPT_WEB_BIND_HOST";
export const PUBLIC_BASE_URL_ENV = "CODEX_CHATGPT_WEB_PUBLIC_BASE_URL";
export const CLIENT_PORT_ENV = "CODEX_CHATGPT_WEB_CLIENT_PORT";
export const CLIENT_CATALOG_PATH_ENV = "CODEX_CHATGPT_WEB_CLIENT_CATALOG_PATH";
export const REMOTE_TURN_IDLE_TIMEOUT_SEC_ENV = "CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC";
export const MANUAL_CODEX_CONFIG_ENV = "CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG";
const MAX_TIMER_SEC = Math.floor(0x7fffffff / 1_000);

export function manualCodexConfigurationOnly(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[MANUAL_CODEX_CONFIG_ENV]?.trim() === "1";
}

export function responsesListenHost(
  configuredHost: "127.0.0.1",
  accessPolicy: ApiAccessPolicy,
  environment: NodeJS.ProcessEnv = process.env,
): "127.0.0.1" | "0.0.0.0" {
  const requested = environment[RESPONSES_BIND_HOST_ENV]?.trim();
  if (!requested || requested === "127.0.0.1") return configuredHost;
  if (requested !== "0.0.0.0") {
    throw new Error(`${RESPONSES_BIND_HOST_ENV} must be 127.0.0.1 or 0.0.0.0`);
  }
  // A non-loopback listener is useful only for the server deployment. Do not expose the
  // unauthenticated OpenAI-forwarding surface if the persisted API policy has not switched yet.
  return accessPolicy.mode === "api-key" ? "0.0.0.0" : configuredHost;
}

export function clientBaseUrl(
  port: number,
  environment: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; remote: boolean } {
  const configured = environment[PUBLIC_BASE_URL_ENV]?.trim();
  if (!configured) {
    const rawClientPort = environment[CLIENT_PORT_ENV]?.trim();
    const clientPort = rawClientPort ? Number(rawClientPort) : port;
    if (!Number.isSafeInteger(clientPort) || clientPort <= 0 || clientPort > 65_535) {
      throw new Error(`${CLIENT_PORT_ENV} must be an integer between 1 and 65535`);
    }
    return { baseUrl: `http://127.0.0.1:${clientPort}/v1`, remote: false };
  }

  let url: URL;
  try { url = new URL(configured); }
  catch { throw new Error(`${PUBLIC_BASE_URL_ENV} must be an absolute HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${PUBLIC_BASE_URL_ENV} must be an HTTPS URL without credentials, query or fragment`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) {
    throw new Error(`${PUBLIC_BASE_URL_ENV} must end with /v1`);
  }
  return { baseUrl: `${url.origin}${pathname}`, remote: true };
}

export function clientCatalogPath(
  fallback: string,
  remote: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment[CLIENT_CATALOG_PATH_ENV]?.trim();
  if (configured) return configured;
  return remote ? "~/.codex/api-key-models.json" : fallback;
}

export function remoteTurnIdleTimeoutSec(
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = environment[REMOTE_TURN_IDLE_TIMEOUT_SEC_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_SEC) {
    throw new Error(
      `${REMOTE_TURN_IDLE_TIMEOUT_SEC_ENV} must be an integer between 1 and ${MAX_TIMER_SEC} seconds`,
    );
  }
  return value;
}
