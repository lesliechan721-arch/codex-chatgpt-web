import { createHash } from "node:crypto";
import type { BrokerToolResult } from "./turn-broker";
import type { ContextCompleteness, ContextLocator, ContextPurpose, ContextReadItem, ContextRequiredRead, ContextTarget } from "./context-types";

export const CONTEXT_TEXT_READ_FORMAT = "context-text-batch-v1";
type TextSource = Pick<ContextTarget, "source_id" | "source_index" | "target_id" | "target_index" | "source_kind" | "original_role" | "origin" | "provenance" | "author" | "recipient">;
export interface ContextTextReadItem {
  request_index: number;
  read_ref: string;
  source: TextSource;
  kind: Exclude<ContextTarget["kind"], "image">;
  locator: Readonly<ContextLocator>;
  content_digest: string;
  required: boolean;
  encoding: "utf-8" | "deterministic-json";
  source_completeness: ContextCompleteness;
  utf8_bytes: number;
  range: { start: number; end_exclusive: number };
  has_more: boolean;
  next_cursor: string | null;
  body_content_index: number;
}
export interface ContextTextReadMetadata {
  format: typeof CONTEXT_TEXT_READ_FORMAT;
  context_id: string;
  purpose: ContextPurpose;
  items: ContextTextReadItem[];
  remaining_reads: ContextReadItem[];
  required_step?: { plan_id: string; index: number; next_required_read: ContextRequiredRead | null };
  remaining_budget?: Record<string, unknown>;
}
/** Content-free facts checked at the actual supported-transport boundary. */
export interface ContextTextReadReceipt {
  format: typeof CONTEXT_TEXT_READ_FORMAT;
  content_blocks: number;
  metadata_consistent: true;
  items: { request_index: number; read_ref: string; target_id: string; body_content_index: number;
    utf8_bytes: number; range: { start: number; end_exclusive: number }; body_utf8_bytes: number }[];
  result_digest: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const stringEnum = (value: unknown, allowed: readonly string[]): value is string => typeof value === "string" && allowed.includes(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function invalid(): never { throw new Error("Invalid context-text-batch-v1 result"); }
function readItem(value: unknown): value is ContextReadItem {
  return object(value) && keys(value, ["read_ref", "cursor"]) && identity(value.read_ref)
    && (value.cursor === undefined || typeof value.cursor === "string" && value.cursor.length > 0 && value.cursor.length <= 2048);
}
function readArgs(value: unknown): boolean {
  return object(value) && keys(value, ["context_id", "reads"]) && identity(value.context_id)
    && Array.isArray(value.reads) && value.reads.length > 0 && value.reads.length <= 8 && value.reads.every(readItem)
    && new Set(value.reads.map(item => item.read_ref)).size === value.reads.length;
}
function rangeValid(range: unknown, length: unknown): range is { start: number; end_exclusive: number } {
  return integer(length) && object(range) && keys(range, ["start", "end_exclusive"])
    && integer(range.start) && integer(range.end_exclusive) && range.start <= range.end_exclusive && range.end_exclusive <= length
    && (range.start !== range.end_exclusive || range.end_exclusive === length);
}
function sourceValid(source: unknown): source is TextSource {
  return object(source) && keys(source, ["source_id", "source_index", "target_id", "target_index", "source_kind", "original_role", "origin", "provenance", "author", "recipient"])
    && identity(source.source_id) && identity(source.target_id) && integer(source.source_index) && source.source_index >= 1
    && integer(source.target_index) && source.target_index >= 1
    && stringEnum(source.source_kind, ["system", "user", "developer", "skill", "summary", "assistant", "tool", "agent_message", "delegation"])
    && typeof source.original_role === "string" && source.original_role.length > 0
    && (source.origin === null || typeof source.origin === "string")
    && stringEnum(source.provenance, ["parsed", "verified_raw", "verified_restoration"])
    && ["author", "recipient"].every(key => source[key] === undefined || source[key] === null || typeof source[key] === "string");
}
function locatorValid(locator: unknown): locator is ContextLocator {
  if (!object(locator) || !keys(locator, ["field", "system_index", "message_index", "content_index", "raw_input_index", "raw_content_index", "text_start", "text_end_exclusive"])
    || !stringEnum(locator.field, ["systemPrompt", "content", "arguments", "input", "output", "thinking"])) return false;
  if (Object.entries(locator).some(([key, value]) => key !== "field" && !integer(value))) return false;
  return (locator.text_start === undefined) === (locator.text_end_exclusive === undefined)
    && (locator.text_start === undefined || (locator.text_start as number) <= (locator.text_end_exclusive as number));
}
/** All body blocks belong to a validated nonempty request prefix. No v2 fallback. */
export function parseContextTextReadResult(value: unknown): { metadata: ContextTextReadMetadata; bodies: string[] } {
  if (!object(value) || !keys(value, ["content", "structuredContent", "isError"]) || value.isError !== undefined && value.isError !== false
    || !Array.isArray(value.content) || value.content.length < 2 || value.content.length > 9 || !object(value.structuredContent)) invalid();
  const blocks = value.content;
  if (blocks.some(block => !object(block) || !keys(block, ["type", "text"]) || block.type !== "text" || typeof block.text !== "string")) invalid();
  let metadata: unknown;
  try { metadata = JSON.parse(blocks[0].text); } catch { invalid(); }
  if (!object(metadata) || canonical(metadata) !== canonical(value.structuredContent)
    || !keys(metadata, ["format", "context_id", "purpose", "items", "remaining_reads", "required_step", "remaining_budget"])
    || metadata.format !== CONTEXT_TEXT_READ_FORMAT || !identity(metadata.context_id) || !stringEnum(metadata.purpose, ["normal", "compaction"])
    || !Array.isArray(metadata.items) || metadata.items.length !== blocks.length - 1
    || !Array.isArray(metadata.remaining_reads) || metadata.remaining_reads.length > 8 || !metadata.remaining_reads.every(readItem)) invalid();
  const targetIds = new Set<string>(), refs = new Set<string>();
  metadata.items.forEach((item: unknown, index: number) => {
    if (!object(item) || !keys(item, ["request_index", "read_ref", "source", "kind", "locator", "content_digest", "required", "encoding", "source_completeness", "utf8_bytes", "range", "has_more", "next_cursor", "body_content_index"])
      || item.request_index !== index || item.body_content_index !== index + 1 || !identity(item.read_ref) || !sourceValid(item.source)
      || !stringEnum(item.kind, ["message_text", "tool_arguments", "tool_result"]) || !locatorValid(item.locator)
      || typeof item.content_digest !== "string" || !/^[a-f0-9]{64}$/.test(item.content_digest) || typeof item.required !== "boolean"
      || !stringEnum(item.encoding, ["utf-8", "deterministic-json"]) || !stringEnum(item.source_completeness, ["complete", "truncated", "unknown"])
      || !rangeValid(item.range, item.utf8_bytes) || typeof item.has_more !== "boolean" || item.has_more !== (item.range.end_exclusive < (item.utf8_bytes as number))
      || (item.has_more ? typeof item.next_cursor !== "string" || !item.next_cursor || item.next_cursor.length > 2048 : item.next_cursor !== null)
      || item.has_more && index !== (metadata as Record<string, any>).items.length - 1
      || Buffer.byteLength(blocks[index + 1].text, "utf8") !== item.range.end_exclusive - item.range.start
      || targetIds.has(item.source.target_id) || refs.has(item.read_ref)) invalid();
    targetIds.add(item.source.target_id); refs.add(item.read_ref);
  });
  const items = metadata.items as unknown as ContextTextReadItem[], remaining = metadata.remaining_reads as ContextReadItem[];
  const last = items[items.length - 1]!;
  if (items.length + remaining.length - (last.has_more ? 1 : 0) > 8
    || new Set(remaining.map(item => item.read_ref)).size !== remaining.length
    || remaining.some((item, index) => refs.has(item.read_ref) && !(index === 0 && last.has_more && item.read_ref === last.read_ref))
    || last.has_more && (remaining[0]?.read_ref !== last.read_ref || remaining[0]?.cursor !== last.next_cursor)) invalid();
  if (metadata.required_step !== undefined) {
    const step = metadata.required_step;
    if (metadata.purpose !== "normal" || !object(step) || !keys(step, ["plan_id", "index", "next_required_read"]) || !identity(step.plan_id) || !integer(step.index)
      || step.next_required_read !== null && (!object(step.next_required_read) || !keys(step.next_required_read, ["tool", "arguments"])
        || step.next_required_read.tool !== "codex_context_read" || !readArgs(step.next_required_read.arguments)
        || (step.next_required_read.arguments as Record<string, unknown>).context_id !== metadata.context_id)) invalid();
  }
  if (metadata.remaining_budget !== undefined) {
    const budget = metadata.remaining_budget;
    if (metadata.purpose !== "compaction" || !object(budget) || !integer(budget.tokens) || !integer(budget.wire_bytes)
      || Object.entries(budget).some(([key, entry]) => key === "stop_hint" ? typeof entry !== "string" || entry.length > 240
        : !["tokens", "wire_bytes", "reserved_tokens", "reserved_wire_bytes", "image_reads", "reserved_image_reads", "image_bytes", "reserved_image_bytes"].includes(key) || !integer(entry))) invalid();
  }
  return { metadata: metadata as unknown as ContextTextReadMetadata, bodies: blocks.slice(1).map(block => block.text) };
}
export function createContextTextReadResult(metadata: Omit<ContextTextReadMetadata, "format">, bodies: string[]): BrokerToolResult {
  const full = { format: CONTEXT_TEXT_READ_FORMAT, ...metadata };
  const result = { content: [{ type: "text", text: JSON.stringify(full) }, ...bodies.map(text => ({ type: "text", text }))], structuredContent: full };
  parseContextTextReadResult(result);
  return result;
}
export function contextTextReadReceipt(result: unknown): ContextTextReadReceipt {
  const { metadata, bodies } = parseContextTextReadResult(result);
  return { format: CONTEXT_TEXT_READ_FORMAT, content_blocks: bodies.length + 1, metadata_consistent: true,
    items: metadata.items.map((item, index) => ({ request_index: item.request_index, read_ref: item.read_ref, target_id: item.source.target_id,
      body_content_index: item.body_content_index, utf8_bytes: item.utf8_bytes, range: { ...item.range }, body_utf8_bytes: Buffer.byteLength(bodies[index]!, "utf8") })),
    result_digest: createHash("sha256").update(canonical(result)).digest("hex") };
}
export function isContextTextReadReceipt(value: unknown): value is ContextTextReadReceipt {
  if (!object(value) || !keys(value, ["format", "content_blocks", "metadata_consistent", "items", "result_digest"])
    || value.format !== CONTEXT_TEXT_READ_FORMAT || value.metadata_consistent !== true || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8
    || value.content_blocks !== value.items.length + 1 || typeof value.result_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.result_digest)) return false;
  return Array.from(value.items).every((item, index) => object(item) && keys(item, ["request_index", "read_ref", "target_id", "body_content_index", "utf8_bytes", "range", "body_utf8_bytes"])
    && item.request_index === index && item.body_content_index === index + 1 && identity(item.read_ref) && identity(item.target_id)
    && rangeValid(item.range, item.utf8_bytes) && integer(item.body_utf8_bytes) && item.body_utf8_bytes === item.range.end_exclusive - item.range.start)
    && new Set(value.items.map(item => item.target_id)).size === value.items.length && new Set(value.items.map(item => item.read_ref)).size === value.items.length;
}
export function contextTextReadReceiptsEqual(expected: ContextTextReadReceipt, actual: unknown): actual is ContextTextReadReceipt {
  return isContextTextReadReceipt(actual) && canonical(expected) === canonical(actual);
}
