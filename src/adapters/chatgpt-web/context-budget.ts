import { estimateTokens } from "../../lib/token-estimate";
import type { BrokerToolResult } from "./turn-broker";
import type { ContextRemainingBudget } from "./context-types";

/** Effective local ceilings, not claims about ChatGPT platform limits. Spec §7's
 * suggested text ceilings are used. Wire reserve covers the outer MCP framing.
 * Image limits allow the measured small PNGs; larger client limits are unproven.
 * Time is active processing time only, never time between authorized calls. */
export const CONTEXT_LIMITS = Object.freeze({
  listEntries: 20, searchHits: 10, listBytes: 12 * 1024, searchBytes: 12 * 1024,
  readBytes: 24 * 1024, listTokens: 1_500, searchTokens: 1_500, readTokens: 2_500,
  wireReserveBytes: 128, tokenReserve: 32, labelChars: 120, snippetChars: 160,
  maxImageBytes: 4 * 1024 * 1024, imageWireBytes: 6 * 1024 * 1024,
  imageMetadataTokens: 1_500, maxImageReads: 64, maxTotalImageBytes: 32 * 1024 * 1024,
  maxTotalWireBytes: 64 * 1024 * 1024, maxTotalTokens: 96_000,
  callProcessingMs: 2_000, totalProcessingMs: 20_000,
  maxStorageBytes: 32 * 1024 * 1024, maxQueryBytes: 512, maxArgumentBytes: 8 * 1024,
  // Three bounded corrective replies have a separate finite reserve. Success pages cannot
  // consume unused reply slots; errors never borrow required-media or summary reserves.
  maxErrorResponses: 3, errorResponseTokens: 128, errorResponseBytes: 512,
});
export type ContextLimits = typeof CONTEXT_LIMITS;
export type ContextLimitOverrides = { [K in keyof ContextLimits]?: number };

export function contextLimits(overrides: ContextLimitOverrides = {}): ContextLimits {
  const result = { ...CONTEXT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!(key in CONTEXT_LIMITS) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("Invalid context budget limits");
    }
  }
  for (const key of ["listEntries", "searchHits", "maxImageReads", "maxArgumentBytes", "maxQueryBytes", "callProcessingMs", "totalProcessingMs", "maxErrorResponses"] as const) {
    if (result[key] < 1) throw new Error("Invalid context budget limits");
  }
  // A correct bounded error must fit even when the smallest data page does not.
  for (const key of ["listBytes", "searchBytes", "readBytes", "imageWireBytes"] as const) {
    if (result[key] < result.wireReserveBytes + 128) throw new Error("Context budget cannot carry an error");
  }
  for (const key of ["listTokens", "searchTokens", "readTokens", "imageMetadataTokens"] as const) {
    if (result[key] < result.tokenReserve + 32) throw new Error("Context budget cannot carry an error");
  }
  if (result.errorResponseBytes < result.wireReserveBytes + 128 || result.errorResponseTokens < result.tokenReserve + 32
    || result.maxErrorResponses * result.errorResponseTokens > result.maxTotalTokens
    || result.maxErrorResponses * result.errorResponseBytes > result.maxTotalWireBytes) throw new Error("Context budget cannot reserve bounded corrective replies");
  // Validate actual complete duplicated error structures, including the final stop
  // hint. Custom framing/reserve ceilings must not admit an untransmittable reply.
  for (const code of ["CONTEXT_EXPIRED", "INVALID_ARGUMENT", "INVALID_REFERENCE", "INVALID_CURSOR", "IMAGE_UNAVAILABLE", "UNSUPPORTED_TYPE", "BUDGET_EXCEEDED", "PROCESSING_BUDGET_EXCEEDED"]) {
    const body = { error: { code, navigation_stopped: true, stop_hint: "Stop context navigation" } };
    const cost = measureContextResponse({ isError: true, content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body }, result);
    if (cost.wire_bytes > result.errorResponseBytes || cost.text_tokens > result.errorResponseTokens
      || [result.listBytes, result.searchBytes, result.readBytes, result.imageWireBytes].some(bytes => bytes < cost.wire_bytes)
      || [result.listTokens, result.searchTokens, result.readTokens, result.imageMetadataTokens].some(tokens => tokens < cost.text_tokens)) throw new Error("Context budget cannot carry a bounded corrective reply");
  }
  return Object.freeze(result) as ContextLimits;
}

export function contextErrorReserve(overrides: ContextLimitOverrides = {}): { tokens: number; wire_bytes: number } {
  const limits = contextLimits(overrides);
  return { tokens: limits.maxErrorResponses * limits.errorResponseTokens, wire_bytes: limits.maxErrorResponses * limits.errorResponseBytes };
}

/** Call before publishing a navigation capability, with all required media protected.
 * The callback used during reads may refer to the already constructed runtime navigator. */
export function assertContextNavigationBudget(budget: ContextRemainingBudget, overrides: ContextLimitOverrides = {}): void {
  for (const value of [budget.tokens, budget.wire_bytes, budget.reserved_tokens ?? 0, budget.reserved_wire_bytes ?? 0, budget.image_reads ?? 0, budget.reserved_image_reads ?? 0, budget.image_bytes ?? 0, budget.reserved_image_bytes ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid context navigation budget");
  }
  const reserve = contextErrorReserve(overrides);
  if (budget.tokens - (budget.reserved_tokens ?? 0) < reserve.tokens
    || budget.wire_bytes - (budget.reserved_wire_bytes ?? 0) < reserve.wire_bytes) throw new Error("Context navigation budget cannot protect required sources and corrective replies");
  if (budget.reserved_image_reads !== undefined && budget.image_reads === undefined || budget.reserved_image_bytes !== undefined && budget.image_bytes === undefined
    || (budget.image_reads ?? 0) < (budget.reserved_image_reads ?? 0) || (budget.image_bytes ?? 0) < (budget.reserved_image_bytes ?? 0)) throw new Error("Context navigation budget cannot protect required image reads and bytes");
}

export interface ContextResponseCost { wire_bytes: number; text_tokens: number; visual_tokens: number; total_tokens: number }
export function measureContextResponse(result: BrokerToolResult, options: {
  wireReserveBytes?: number; tokenReserve?: number; visualTokens?: number;
  /** Trusted directory admission: cover a future scope binding and cursor signature. */
  boundCursorTokens?: boolean;
} = {}): ContextResponseCost {
  const json = JSON.stringify(result);
  // Base64 is part of wire size, but is not model text or a visual token estimate.
  const textResult = { ...result, content: result.content.map(block => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const { data: _data, ...metadata } = block as Record<string, unknown>;
      return metadata;
    }
    return block;
  }) };
  const serializedText = JSON.stringify(textResult);
  const cursor = options.boundCursorTokens ? (result.structuredContent as { next_cursor?: unknown } | undefined)?.next_cursor : undefined;
  // A signed cursor is ASCII. At most one token per byte covers any future binding
  // and signature of this length. Tokenize the other fragments separately so no
  // cross-boundary merge is assumed. Both wire copies of the cursor are included.
  const fragments = typeof cursor === "string" && cursor ? serializedText.split(cursor) : [serializedText];
  const textTokens = fragments.reduce((sum, fragment) => sum + estimateTokens(fragment), 0)
    + (fragments.length - 1) * (typeof cursor === "string" ? Buffer.byteLength(cursor) : 0)
    + (options.tokenReserve ?? CONTEXT_LIMITS.tokenReserve);
  const visual = options.visualTokens ?? 0;
  if (!Number.isSafeInteger(visual) || visual < 0) throw new Error("Invalid visual token reserve");
  return { wire_bytes: Buffer.byteLength(json, "utf8") + (options.wireReserveBytes ?? CONTEXT_LIMITS.wireReserveBytes),
    text_tokens: textTokens, visual_tokens: visual, total_tokens: textTokens + visual };
}
