import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { measureContextResponse, measureContextVisibleResponse } from "../src/adapters/chatgpt-web/context-budget";

function fixture(text: string, purpose: "normal" | "compaction" = "normal") {
  const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: [{ role: "user", content: text }] }));
  const args = { context_id: snapshot.context_id, read_ref: snapshot.targets[0]!.read_ref! };
  const navigator = new ContextNavigator({ scopeId: "v2-source", snapshot, purpose });
  return { snapshot, args, result: navigator.read(args) };
}
describe("context-text-read-v2 public result", () => {
  test("body occurs in one exact block, including JSON-looking text, CRLF, whitespace and empty pages", () => {
    for (const text of ['{ "fragment": "sole-private-body-marker\\n" }\r\n\t  \n\n', "", "OK", "中文😀e\u0301"]) {
      const { result } = fixture(text);
      const page = parseContextTextReadResult(result);
      expect(page.body).toBe(text);
      expect(result.content).toHaveLength(2);
      expect(result.content[1]).toEqual({ type: "text", text });
      expect(result.structuredContent).not.toHaveProperty("content");
      expect(result).not.toHaveProperty("_meta");
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(page.metadata);
      expect(page.metadata).toMatchObject({ format: "context-text-read-v2", body_content_index: 1,
        utf8_bytes: Buffer.byteLength(text), range: { start: 0, end_exclusive: Buffer.byteLength(text) }, has_more: false, next_cursor: null });
      expect(measureContextVisibleResponse(result).total_tokens).toBeGreaterThanOrEqual(0);
      expect(measureContextResponse(result).text_tokens).toBeGreaterThan(measureContextVisibleResponse(result).total_tokens);
    }
  });
  test("strict parser rejects old or unknown versions, wrong indexes, missing blocks, mismatch and invalid ranges", () => {
    const { result } = fixture("中文😀");
    const changeMetadata = (change: (metadata: any) => void) => {
      const altered = structuredClone(result); change(altered.structuredContent);
      (altered.content[0] as { text: string }).text = JSON.stringify(altered.structuredContent); return altered;
    };
    const bad = [
      { ...result, content: result.content.slice(0, 1) },
      { ...result, content: [...result.content, { type: "text", text: "third copy" }] },
      { ...result, content: [result.content[0], { type: "image", data: "", mimeType: "image/png" }] },
      { ...result, content: [result.content[0], { type: "text", text: "" }] },
      { ...result, content: [{ type: "text", text: "not JSON" }, result.content[1]] },
      { ...result, structuredContent: { ...(result.structuredContent as Record<string, unknown>), body_content_index: 0 } },
      { ...result, _meta: { content: "中文😀" } },
      { ...result, isError: true },
      changeMetadata(m => { delete m.format; m.content = "中文😀"; }),
      changeMetadata(m => { m.format = "context-text-read-v3"; }),
      changeMetadata(m => { m.body_content_index = 0; }),
      changeMetadata(m => { m.content = "duplicate body"; }),
      changeMetadata(m => { m.source.content = "duplicate body"; }),
      changeMetadata(m => { m.range.end_exclusive--; }),
      changeMetadata(m => { m.range.start = -1; }),
      changeMetadata(m => { m.utf8_bytes = 1; }),
      changeMetadata(m => { m.has_more = true; m.next_cursor = ""; }),
      changeMetadata(m => { m.has_more = false; m.next_cursor = "unexpected cursor"; }),
    ];
    for (const value of bad) expect(() => parseContextTextReadResult(value)).toThrow("Invalid context-text-read-v2 result");
    // Metadata equivalence is semantic, independent of object key order.
    const reordered = { ...result, structuredContent: Object.fromEntries(Object.entries(result.structuredContent!).reverse()) };
    expect(parseContextTextReadResult(reordered).body).toBe("中文😀");
  });
  for (const purpose of ["normal", "compaction"] as const) test(`${purpose} reconstructs all pages with charged retries and stable core ranges`, () => {
    const text = ('"\\\n\t中文😀\r\n'.repeat(350));
    const { snapshot, args } = fixture(text, purpose);
    let navigator: ContextNavigator;
    navigator = new ContextNavigator({ scopeId: "paged-v2", snapshot, purpose, limits: { readBytes: 3200, readTokens: 1000 },
      ...(purpose === "compaction" ? { remainingBudget: () => ({ tokens: 90000 - navigator.usage().text_tokens,
        wire_bytes: 1000000 - navigator.usage().wire_bytes, reserved_tokens: 700, reserved_wire_bytes: 1000 }) } : {}) });
    let restored = "", position = 0, cursor: string | undefined, pages = 0;
    do {
      const current = { ...args, ...(cursor ? { cursor } : {}) };
      const first = navigator.read(current); const page = parseContextTextReadResult(first), used = navigator.usage();
      const repeated = navigator.read(current), retry = parseContextTextReadResult(repeated);
      expect(retry.body).toBe(page.body);
      expect({ ...retry.metadata, remaining_budget: undefined }).toEqual({ ...page.metadata, remaining_budget: undefined });
      const cost = measureContextResponse(repeated);
      expect(navigator.usage().wire_bytes - used.wire_bytes).toBe(cost.wire_bytes);
      expect(navigator.usage().text_tokens - used.text_tokens).toBe(cost.text_tokens);
      expect(cost.wire_bytes).toBeLessThanOrEqual(3200); expect(cost.text_tokens).toBeLessThanOrEqual(1000);
      expect(page.metadata.range.start).toBe(position);
      expect(page.body).not.toContain("�"); expect(page.body.length).toBeGreaterThan(0);
      if (purpose === "compaction") {
        expect(page.metadata.remaining_budget?.reserved_tokens).toBe(700);
        expect(retry.metadata.remaining_budget?.tokens).toBeLessThan(page.metadata.remaining_budget!.tokens as number);
      }
      restored += page.body; position = page.metadata.range.end_exclusive; cursor = page.metadata.next_cursor ?? undefined;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(restored).toBe(text); expect(position).toBe(Buffer.byteLength(text)); expect(pages).toBeGreaterThan(1);
  });
  test("a pending text page requires its actual v2 result receipt; cancellation and retirement never credit it", () => {
    const { snapshot, args } = fixture("fixed original body");
    const scope = new ContextScope("receipt-binding", { snapshot, planId: "v2", manifestDigest: "v2", deliveryByTarget: {} }, "normal", () => {}, () => {});
    scope.markEntryDelivered();
    try {
      const noShape = scope.prepare("read", args);
      expect(() => scope.assertPending(noShape.receiptId)).toThrow("transported text result");
      expect(scope.finish(noShape.receiptId, true)).toBeUndefined();
      const mismatched = scope.prepare("read", args);
      const receipt = contextTextReadReceipt(mismatched.result);
      expect(scope.finish(mismatched.receiptId, true, { ...receipt, result_digest: "f".repeat(64) })).toBeUndefined();
      const cancelled = scope.prepare("read", args);
      expect(scope.finish(cancelled.receiptId, false, contextTextReadReceipt(cancelled.result))).toBeUndefined();
      const successful = scope.prepare("read", args), actual = contextTextReadReceipt(successful.result);
      expect(() => scope.assertPending(successful.receiptId, actual)).not.toThrow();
      expect(scope.finish(successful.receiptId, true, actual)).toEqual({ method: "read", textRead: actual });
      expect(scope.finish(successful.receiptId, true, actual)).toBeUndefined();
      const retired = scope.prepare("read", args); scope.retire();
      expect(scope.finish(retired.receiptId, true, contextTextReadReceipt(retired.result))).toBeUndefined();
    } finally { scope.retire(); }
  });
});
