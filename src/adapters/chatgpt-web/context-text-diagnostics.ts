import { createHash } from "node:crypto";
import { CONTEXT_TEXT_READ_FORMAT, isContextTextReadReceipt, type ContextTextReadReceipt } from "./context-text-result";

/** Persistent observation facts. This value cannot be used as a transport receipt. */
export interface ContextTextReadDiagnostic {
  format: typeof CONTEXT_TEXT_READ_FORMAT;
  content_blocks: number;
  metadata_consistent: true;
  items: { request_index: number; read_ref_digest: string; target_id_digest: string; body_content_index: number;
    utf8_bytes: number; range: { start: number; end_exclusive: number }; body_utf8_bytes: number }[];
  result_digest: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function contextTextReadDiagnostic(receipt: ContextTextReadReceipt): ContextTextReadDiagnostic {
  if (!isContextTextReadReceipt(receipt)) throw new Error("Invalid context transport receipt for diagnostics");
  return { format: receipt.format, content_blocks: receipt.content_blocks, metadata_consistent: true,
    items: receipt.items.map(item => ({ request_index: item.request_index, read_ref_digest: hash(item.read_ref),
      target_id_digest: hash(item.target_id), body_content_index: item.body_content_index, utf8_bytes: item.utf8_bytes,
      range: { start: item.range.start, end_exclusive: item.range.end_exclusive }, body_utf8_bytes: item.body_utf8_bytes })),
    result_digest: receipt.result_digest };
}

export function isContextTextReadDiagnostic(value: unknown): value is ContextTextReadDiagnostic {
  if (!object(value) || !keys(value, ["format", "content_blocks", "metadata_consistent", "items", "result_digest"])
    || value.format !== CONTEXT_TEXT_READ_FORMAT || value.metadata_consistent !== true || !digest(value.result_digest)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 8 || value.content_blocks !== value.items.length + 1) return false;
  const items = Array.from(value.items);
  return items.every((item, index) => object(item)
    && keys(item, ["request_index", "read_ref_digest", "target_id_digest", "body_content_index", "utf8_bytes", "range", "body_utf8_bytes"])
    && item.request_index === index && item.body_content_index === index + 1 && digest(item.read_ref_digest) && digest(item.target_id_digest)
    && integer(item.utf8_bytes) && object(item.range) && keys(item.range, ["start", "end_exclusive"])
    && integer(item.range.start) && integer(item.range.end_exclusive) && item.range.start <= item.range.end_exclusive
    && item.range.end_exclusive <= item.utf8_bytes && (item.range.start !== item.range.end_exclusive || item.range.end_exclusive === item.utf8_bytes)
    && integer(item.body_utf8_bytes) && item.body_utf8_bytes === item.range.end_exclusive - item.range.start)
    && new Set(items.map(item => item.read_ref_digest)).size === items.length
    && new Set(items.map(item => item.target_id_digest)).size === items.length;
}
