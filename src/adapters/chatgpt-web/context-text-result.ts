import { createHash } from "node:crypto";
import type { BrokerToolResult } from "./turn-broker";
import type { ContextCompleteness, ContextPurpose } from "./context-types";

export const CONTEXT_TEXT_READ_FORMAT = "context-text-read-v2";
export interface ContextTextReadMetadata {
  format: typeof CONTEXT_TEXT_READ_FORMAT;
  context_id: string;
  purpose: ContextPurpose;
  read_ref: string;
  source: Record<string, unknown>;
  encoding: "utf-8" | "deterministic-json";
  source_completeness: ContextCompleteness;
  /** Complete fixed source length, not this page's length. */
  utf8_bytes: number;
  range: { start: number; end_exclusive: number };
  has_more: boolean;
  next_cursor: string | null;
  body_content_index: 1;
  remaining_budget?: Record<string, unknown>;
}

/** Content-free facts obtained by checking the actual supported-transport result. */
export interface ContextTextReadReceipt {
  format: typeof CONTEXT_TEXT_READ_FORMAT;
  content_blocks: 2;
  body_content_index: 1;
  metadata_consistent: true;
  utf8_bytes: number;
  range: { start: number; end_exclusive: number };
  body_utf8_bytes: number;
  result_digest: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function invalid(): never { throw new Error("Invalid context-text-read-v2 result"); }

/** New scopes accept only v2. Missing blocks and malformed pages are never empty text. */
export function parseContextTextReadResult(value: unknown): { metadata: ContextTextReadMetadata; body: string } {
  if (!object(value) || value.isError === true || !Array.isArray(value.content) || value.content.length !== 2
    || Object.keys(value).some(key => !["content", "structuredContent", "isError"].includes(key))
    || value.isError !== undefined && value.isError !== false || !object(value.structuredContent)) invalid();
  const [header, bodyBlock] = value.content;
  if (!object(header) || header.type !== "text" || typeof header.text !== "string"
    || !object(bodyBlock) || bodyBlock.type !== "text" || typeof bodyBlock.text !== "string"
    || Object.keys(header).some(key => !["type", "text"].includes(key))
    || Object.keys(bodyBlock).some(key => !["type", "text"].includes(key))) invalid();
  let metadata: unknown;
  try { metadata = JSON.parse(header.text); } catch { invalid(); }
  if (!object(metadata) || canonical(metadata) !== canonical(value.structuredContent)
    || metadata.format !== CONTEXT_TEXT_READ_FORMAT || metadata.body_content_index !== 1
    || Object.keys(metadata).some(key => !["format", "context_id", "purpose", "read_ref", "source", "encoding",
      "source_completeness", "utf8_bytes", "range", "has_more", "next_cursor", "body_content_index", "remaining_budget"].includes(key))
    || !identity(metadata.context_id) || !identity(metadata.read_ref) || !["normal", "compaction"].includes(String(metadata.purpose))
    || !object(metadata.source) || !identity(metadata.source.source_id) || !identity(metadata.source.target_id)
    || !integer(metadata.source.source_index) || metadata.source.source_index < 1
    || !integer(metadata.source.target_index) || metadata.source.target_index < 1
    || Object.keys(metadata.source).some(key => !["source_id", "source_index", "target_id", "target_index", "source_kind", "original_role", "origin", "provenance", "author", "recipient"].includes(key))
    || !["system", "user", "developer", "skill", "summary", "assistant", "tool", "agent_message", "delegation"].includes(String(metadata.source.source_kind))
    || typeof metadata.source.original_role !== "string" || !metadata.source.original_role
    || metadata.source.origin !== null && typeof metadata.source.origin !== "string"
    || !["parsed", "verified_raw", "verified_restoration"].includes(String(metadata.source.provenance))
    || ["author", "recipient"].some(key => {
      const entry = (metadata.source as Record<string, unknown>)[key];
      return entry !== undefined && entry !== null && typeof entry !== "string";
    })
    || !["utf-8", "deterministic-json"].includes(String(metadata.encoding))
    || !["complete", "truncated", "unknown"].includes(String(metadata.source_completeness))
    || !integer(metadata.utf8_bytes) || !object(metadata.range)
    || Object.keys(metadata.range).some(key => !["start", "end_exclusive"].includes(key))
    || !integer(metadata.range.start) || !integer(metadata.range.end_exclusive)
    || metadata.range.start > metadata.range.end_exclusive || metadata.range.end_exclusive > metadata.utf8_bytes
    || typeof metadata.has_more !== "boolean" || metadata.has_more !== (metadata.range.end_exclusive < metadata.utf8_bytes)
    || (metadata.has_more ? typeof metadata.next_cursor !== "string" || !metadata.next_cursor || metadata.next_cursor.length > 4096 : metadata.next_cursor !== null)
    || (metadata.range.start === metadata.range.end_exclusive && metadata.range.end_exclusive !== metadata.utf8_bytes)
    || Buffer.byteLength(bodyBlock.text, "utf8") !== metadata.range.end_exclusive - metadata.range.start) invalid();
  if (metadata.remaining_budget !== undefined) {
    const budget = metadata.remaining_budget;
    if (metadata.purpose !== "compaction" || !object(budget) || !integer(budget.tokens) || !integer(budget.wire_bytes)
      || Object.entries(budget).some(([key, entry]) => key === "stop_hint" ? typeof entry !== "string" || entry.length > 240
        : !["tokens", "wire_bytes", "reserved_tokens", "reserved_wire_bytes", "image_reads", "reserved_image_reads", "image_bytes", "reserved_image_bytes"].includes(key) || !integer(entry))) invalid();
  }
  return { metadata: metadata as unknown as ContextTextReadMetadata, body: bodyBlock.text };
}

export function createContextTextReadResult(metadata: Omit<ContextTextReadMetadata, "format" | "body_content_index">, body: string): BrokerToolResult {
  const full = { format: CONTEXT_TEXT_READ_FORMAT, ...metadata, body_content_index: 1 };
  const result = { content: [{ type: "text", text: JSON.stringify(full) }, { type: "text", text: body }], structuredContent: full };
  parseContextTextReadResult(result);
  return result;
}

export function contextTextReadReceipt(result: unknown): ContextTextReadReceipt {
  const { metadata, body } = parseContextTextReadResult(result);
  return { format: CONTEXT_TEXT_READ_FORMAT, content_blocks: 2, body_content_index: 1, metadata_consistent: true,
    utf8_bytes: metadata.utf8_bytes, range: { ...metadata.range }, body_utf8_bytes: Buffer.byteLength(body, "utf8"),
    result_digest: createHash("sha256").update(canonical(result)).digest("hex") };
}

export function isContextTextReadReceipt(value: unknown): value is ContextTextReadReceipt {
  return object(value) && value.format === CONTEXT_TEXT_READ_FORMAT && value.content_blocks === 2
    && Object.keys(value).every(key => ["format", "content_blocks", "body_content_index", "metadata_consistent", "utf8_bytes", "range", "body_utf8_bytes", "result_digest"].includes(key))
    && value.body_content_index === 1 && value.metadata_consistent === true && integer(value.utf8_bytes)
    && object(value.range) && integer(value.range.start) && integer(value.range.end_exclusive)
    && Object.keys(value.range).every(key => ["start", "end_exclusive"].includes(key))
    && value.range.start <= value.range.end_exclusive && value.range.end_exclusive <= value.utf8_bytes
    && (value.range.start !== value.range.end_exclusive || value.range.end_exclusive === value.utf8_bytes)
    && integer(value.body_utf8_bytes) && value.body_utf8_bytes === value.range.end_exclusive - value.range.start
    && typeof value.result_digest === "string" && /^[a-f0-9]{64}$/.test(value.result_digest);
}

export function contextTextReadReceiptsEqual(expected: ContextTextReadReceipt, actual: unknown): actual is ContextTextReadReceipt {
  return isContextTextReadReceipt(actual) && canonical(expected) === canonical(actual);
}
