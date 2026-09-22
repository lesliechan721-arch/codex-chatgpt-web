import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { upstreamModelAllowed, type UpstreamProviderRuntime } from "./upstream-provider";

/** HTTP access is orthogonal to browser-only/full and automatic/manual execution. */
export type ApiAccessPolicy =
  | { version: 1; mode: "openai" }
  | { version: 1; mode: "api-key"; keySha256: string };

export const OPENAI_ACCESS: ApiAccessPolicy = Object.freeze({ version: 1, mode: "openai" });
export const API_KEY_ENV = "CODEX_CHATGPT_WEB_API_KEY";
export const MODEL_CATALOG_STATUS_HEADER = "x-codex-chatgpt-web-model-catalog-status";
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export function generateApiKey(): string {
  return `cgw_${randomBytes(32).toString("base64url")}`;
}

export function apiKeyPolicy(key: string): ApiAccessPolicy {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("API key must contain 32–256 ASCII letters, digits, underscores or hyphens");
  }
  return { version: 1, mode: "api-key", keySha256: createHash("sha256").update(key).digest("hex") };
}

/** Never include a rejected configuration value (which may contain a secret) in an error. */
export function parseApiAccessPolicy(value: unknown): ApiAccessPolicy {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (raw.version === 1 && raw.mode === "openai" && keys.every(key => key === "version" || key === "mode")) {
      return OPENAI_ACCESS;
    }
    if (raw.version === 1 && raw.mode === "api-key"
      && typeof raw.keySha256 === "string" && /^[a-f0-9]{64}$/.test(raw.keySha256)
      && keys.every(key => key === "version" || key === "mode" || key === "keySha256")) {
      return Object.freeze({ version: 1, mode: "api-key", keySha256: raw.keySha256 });
    }
  }
  throw new Error("Invalid API access configuration; refusing to fall back to OpenAI passthrough");
}

export function apiKeyMatches(key: string, policy: ApiAccessPolicy): boolean {
  if (policy.mode !== "api-key" || !KEY_PATTERN.test(key)) return false;
  const actual = createHash("sha256").update(key).digest();
  const expected = Buffer.from(policy.keySha256, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function apiAccessError(status: number, code: string, message: string): Response {
  return Response.json({ error: {
    type: status === 401 ? "authentication_error" : "invalid_request_error",
    code,
    message,
  } }, { status, headers: {
    "cache-control": "no-store",
    ...(status === 401 ? { "www-authenticate": 'Bearer realm="codex-chatgpt-web"' } : {}),
  } });
}

export function authenticateApiRequest(req: Request, policy: ApiAccessPolicy): Response | undefined {
  if (policy.mode !== "api-key") return undefined;
  // Reject duplicate/coalesced headers, whitespace inside tokens and non-Bearer credentials.
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(req.headers.get("authorization") ?? "");
  if (match && apiKeyMatches(match[1]!, policy)) return undefined;
  return apiAccessError(401, "invalid_api_key", "A valid local API key is required");
}

/** Authenticate before parsing bodies or dispatching any public API endpoint. */
export function guardApiRequest(
  req: Request,
  policy: ApiAccessPolicy,
  upstream?: UpstreamProviderRuntime,
): Response | undefined {
  const path = new URL(req.url).pathname;
  if (policy.mode !== "api-key" || (path !== "/v1" && !path.startsWith("/v1/"))) return undefined;
  const denied = authenticateApiRequest(req, policy);
  if (denied) return denied;
  const methods = path === "/v1/models" ? ["GET"]
    : path === "/v1/responses" ? ["GET", "POST"]
      : path === "/v1/responses/compact" ? ["POST"]
        : upstream?.available && ["/v1/alpha/search", "/v1/images/generations", "/v1/images/edits"].includes(path)
          ? ["POST"] : undefined;
  if (!methods) {
    return apiAccessError(404, "endpoint_not_supported", "API key mode only exposes ChatGPT Web models and Responses endpoints");
  }
  if (!methods.includes(req.method)) {
    const response = apiAccessError(405, "method_not_allowed", "Method not allowed for this endpoint");
    response.headers.set("allow", methods.join(", "));
    return response;
  }
  return undefined;
}

export function requireWebModelInApiKeyMode(
  model: unknown,
  policy: ApiAccessPolicy,
  upstream?: UpstreamProviderRuntime,
): Response | undefined {
  if (policy.mode !== "api-key") return undefined;
  // Exact account/mode eligibility remains owned by requireChatGptWebModelRoute. This guard
  // closes the native passthrough branch before parsing can start any adapter or continuation.
  if (typeof model === "string" && model.startsWith("chatgpt-web/")) return undefined;
  if (upstream?.available && upstream.config && upstreamModelAllowed(model, upstream.config)) return undefined;
  return apiAccessError(400, "model_not_supported", "API key mode requires a chatgpt-web/* model or a model allowed by the configured upstream provider");
}

/** Client authentication must not reach the browser, connector, traces or any upstream. */
export function adapterRequestHeaders(headers: Headers, policy: ApiAccessPolicy): Headers {
  const result = new Headers(headers);
  if (policy.mode === "api-key") {
    for (const name of ["authorization", "proxy-authorization", "x-api-key", "cookie",
      "chatgpt-account-id", "openai-organization", "openai-project"]) result.delete(name);
  }
  return result;
}

/** Non-credential evidence that the daemon loaded the exact configured policy at startup. */
export function apiAccessRevision(policy: ApiAccessPolicy, controlToken: string): string {
  return createHmac("sha256", controlToken)
    .update(`codex-web-api-access:v1\0${policy.mode}\0${policy.mode === "api-key" ? policy.keySha256 : ""}`)
    .digest("hex");
}
