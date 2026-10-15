import type { CodexParsedRequest } from "../../types";

/** Reparse raw source fields with the same model used by the Responses parser.
 * Routing changes execution modelId but never rewrites the canonical raw body. */
export function contextSourceParserModel(request: CodexParsedRequest): string {
  const raw = request._rawBody;
  const model = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model : undefined;
  return typeof model === "string" ? model : request.modelId;
}
