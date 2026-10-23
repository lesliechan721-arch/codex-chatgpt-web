import { estimateTokens } from "../../lib/token-estimate";
import type { BrokerToolResult } from "./turn-broker";
import type { ContextRemainingBudget } from "./context-types";

/** Effective local ceilings, not claims about ChatGPT platform limits. Spec §7's
 * suggested text ceilings are used. Wire reserve covers the outer MCP framing.
 * Image limits allow the measured small PNGs; larger client limits are unproven.
 * Time is active processing time only, never time between authorized calls. */
export const CONTEXT_LIMITS = Object.freeze({
  listEntries: 50, searchHits: 10, listBytes: 48 * 1024, searchBytes: 12 * 1024,
  readBytes: 64 * 1024, listTokens: 6_000, searchTokens: 1_500, readTokens: 8_000,
  wireReserveBytes: 128, tokenReserve: 32, labelChars: 120, snippetChars: 160,
  maxImageBytes: 4 * 1024 * 1024, imageWireBytes: 6 * 1024 * 1024,
  imageMetadataTokens: 1_500, maxImageReads: 64, maxTotalImageBytes: 32 * 1024 * 1024,
  callProcessingMs: 2_000, totalProcessingMs: 20_000,
  maxStorageBytes: 32 * 1024 * 1024, maxQueryBytes: 512, maxArgumentBytes: 8 * 1024,
  // Three bounded corrective replies have a separate finite reserve. Success pages cannot
  // consume unused reply slots; errors never borrow required-media or summary reserves.
  maxErrorResponses: 3, errorResponseTokens: 128, errorResponseBytes: 512,
});
export type ContextLimits = { readonly [K in keyof typeof CONTEXT_LIMITS]: number };
export type ContextLimitOverrides = { -readonly [K in keyof ContextLimits]?: number };
/** The numeric protocol requires a finite allowance even when no cumulative ceiling applies.
 * Production scopes supply their shared page token allowance; wire bytes remain diagnostic. */
export const UNLIMITED_CONTEXT_ALLOWANCE = Number.MAX_SAFE_INTEGER;

export const CONTEXT_BUDGET_PROFILES = Object.freeze({
  expanded: Object.freeze({ readBytes: 64 * 1024, readTokens: 8_000, listBytes: 48 * 1024, listTokens: 6_000, listEntries: 50 }),
  conservative: Object.freeze({ readBytes: 24 * 1024, readTokens: 2_500, listBytes: 12 * 1024, listTokens: 1_500, listEntries: 20 }),
});
export type ContextBudgetProfile = keyof typeof CONTEXT_BUDGET_PROFILES;
/** Read once at new-plan admission, never from an active navigator. */
export function configuredContextBudgetProfile(): ContextBudgetProfile {
  const value = process.env.CODEX_CONTEXT_BUDGET_PROFILE ?? "expanded";
  if (value !== "expanded" && value !== "conservative") throw new Error("Invalid CODEX_CONTEXT_BUDGET_PROFILE");
  return value;
}
/** Trusted preparation configuration. Existing scopes never read mutable configuration. */
export function contextBudgetProfileLimits(profile: ContextBudgetProfile = "expanded"): ContextLimitOverrides {
  const limits = CONTEXT_BUDGET_PROFILES[profile];
  if (!limits) throw new Error("Invalid context budget profile");
  return { ...limits };
}
/** Broker-issued ASCII credentials and their one property fit within this allowance. */
export const CONTEXT_CREDENTIAL_ARGUMENT_BYTES = 1024;

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
  if (result.errorResponseBytes < result.wireReserveBytes + 128 || result.errorResponseTokens < result.tokenReserve + 32) throw new Error("Context budget cannot reserve bounded corrective replies");
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
/** Diagnostic visible-field estimates only. Hard admission continues to measure the
 * full serialized result, including metadata copies and framing reserves. */
export function measureContextVisibleResponse(result: BrokerToolResult): { content_text_tokens: number; structured_tokens: number; total_tokens: number } {
  const contentTextTokens = result.content.reduce<number>((sum, block) => sum + (block && typeof block === "object"
    && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
    ? estimateTokens((block as { text: string }).text) : 0), 0);
  const structuredTokens = result.structuredContent === undefined ? 0 : estimateTokens(JSON.stringify(result.structuredContent));
  return { content_text_tokens: contentTextTokens, structured_tokens: structuredTokens, total_tokens: contentTextTokens + structuredTokens };
}
export function measureContextResponse(result: BrokerToolResult, options: {
  wireReserveBytes?: number; tokenReserve?: number; visualTokens?: number;
  /** Trusted directory admission: cover a future scope binding and cursor signature. */
  boundCursorTokens?: boolean;
  /** Fit checks only: return a conservative token bound when it fits this total
   * ceiling. Omit for usage accounting; tighter ceilings still use the tokenizer. */
  tokenCeiling?: number;
} = {}): ContextResponseCost {
  const json = JSON.stringify(result);
  const wireBytes = Buffer.byteLength(json, "utf8") + (options.wireReserveBytes ?? CONTEXT_LIMITS.wireReserveBytes);
  const visual = options.visualTokens ?? 0;
  if (!Number.isSafeInteger(visual) || visual < 0) throw new Error("Invalid visual token reserve");
  // Base64 is part of wire size, but is not model text or a visual token estimate.
  const textResult = { ...result, content: result.content.map(block => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const { data: _data, ...metadata } = block as Record<string, unknown>;
      return metadata;
    }
    return block;
  }) };
  const serializedText = JSON.stringify(textResult);
  // Byte-level tokens cannot outnumber UTF-8 bytes. This also bounds cursor
  // fragments and signatures without changing any near-limit admission decision.
  const tokenBound = Buffer.byteLength(serializedText, "utf8") + (options.tokenReserve ?? CONTEXT_LIMITS.tokenReserve);
  if (options.tokenCeiling !== undefined && tokenBound + visual <= options.tokenCeiling) {
    return { wire_bytes: wireBytes, text_tokens: tokenBound, visual_tokens: visual, total_tokens: tokenBound + visual };
  }
  const cursors = new Set<string>();
  const collectCursors = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["cursor", "next_cursor", "read_cursor"].includes(key) && typeof entry === "string" && entry) cursors.add(entry);
      else if (entry && typeof entry === "object") collectCursors(entry);
    }
  };
  if (options.boundCursorTokens) collectCursors(result.structuredContent);
  // Fixed cursor payloads retain their real token cost. Only the scope binding and
  // HMAC vary in a future navigator. Bound their base64 characters by one token per
  // byte, and tokenize adjacent fragments separately. Unknown cursor forms use the
  // full ASCII bound. This also covers nested bootstrap and search cursors.
  const boundCursorCost = (cursor: string): number => {
    const parts = cursor.split(".");
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) return Buffer.byteLength(cursor);
    try {
      const raw = Buffer.from(parts[0]!, "base64url").toString("utf8");
      const parsed = JSON.parse(raw);
      const match = /"b":"[a-f0-9]{64}"/.exec(raw);
      if (parsed.v !== 1 || !match || Object.keys(parsed).sort().join(",") !== "b,k,n,q,t,v") return Buffer.byteLength(cursor);
      const begin = match.index + 5;
      const number = /"n":([0-9]+)/.exec(raw);
      if (!number) return Buffer.byteLength(cursor);
      const intervals = [[Math.floor(begin / 3) * 4, Math.ceil((begin + 64) / 3) * 4],
        [Math.floor((number.index + 4) / 3) * 4, Math.ceil((number.index + 4 + number[1]!.length) / 3) * 4]];
      let position = 0, cost = 0;
      for (const [first, last] of intervals) {
        cost += estimateTokens(parts[0]!.slice(position, first)) + last! - first!;
        position = last!;
      }
      return cost + estimateTokens(parts[0]!.slice(position) + ".") + parts[1]!.length;
    } catch { return Buffer.byteLength(cursor); }
  };
  let fragments = [serializedText], cursorTokens = 0;
  for (const cursor of cursors) fragments = fragments.flatMap(fragment => {
    const pieces = fragment.split(cursor);
    cursorTokens += (pieces.length - 1) * boundCursorCost(cursor);
    return pieces;
  });
  const textTokens = fragments.reduce((sum, fragment) => sum + estimateTokens(fragment), 0) + cursorTokens
    + (options.tokenReserve ?? CONTEXT_LIMITS.tokenReserve);
  return { wire_bytes: wireBytes,
    text_tokens: textTokens, visual_tokens: visual, total_tokens: textTokens + visual };
}
