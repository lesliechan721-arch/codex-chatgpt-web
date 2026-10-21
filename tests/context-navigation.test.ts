import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import type { BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";

const body = (result: BrokerToolResult): any => result.structuredContent;
const snapshotOf = (input: unknown[]) => createContextSnapshot(parseRequest({ model: "gpt-6", input }));
describe("context navigation", () => {
  test("UTF-8 pages exactly restore Chinese, emoji, escapes, long lines and empty text", () => {
    const original = '中文😀🧭\\"\n'.repeat(750) + "single long line".repeat(80);
    const snapshot = snapshotOf([{ role: "user", content: original }, { role: "user", content: "" }]);
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", limits: { readBytes: 5000, readTokens: 1800 } });
    const target = snapshot.targets[0]!;
    let cursor: string | undefined, recovered = "", byteEnd = 0, pages = 0;
    do {
      const args = { context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref!, ...(cursor ? { cursor } : {}) }] };
      const result = navigator.read(args); expect(result.isError).not.toBe(true);
      const parsed = parseContextTextReadResult(result), page = parsed.metadata.items[0]!, text = parsed.bodies[0]!; expect(page.range.start).toBe(byteEnd);
      expect(page.range.end_exclusive).toBe(byteEnd + Buffer.byteLength(text));
      expect(text).not.toContain("�"); expect(text.length).toBeGreaterThan(0);
      // Stable retry: repeated transmission costs resources but does not alter page bytes/cursor.
      if (pages === 0) expect(body(navigator.read(args))).toEqual(parsed.metadata);
      recovered += text; byteEnd = page.range.end_exclusive;
      cursor = page.next_cursor ?? undefined; pages++;
      expect(pages).toBeLessThan(200);
    } while (cursor);
    expect(recovered).toBe(original); expect(byteEnd).toBe(Buffer.byteLength(original)); expect(pages).toBeGreaterThan(1);
    const empty = parseContextTextReadResult(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[1]!.read_ref! }] }));
    expect(empty).toMatchObject({ bodies: [""], metadata: { items: [{ range: { start: 0, end_exclusive: 0 }, has_more: false, next_cursor: null }] } });
  });

  test("filters are intersections; namespace null and strict source range do not leak another source", () => {
    const snapshot = snapshotOf([
      { type: "function_call", call_id: "a", name: "exec", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "exec", namespace: "ns", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: "outside-secret" },
      { type: "function_call_output", call_id: "a", output: "inside" },
    ]);
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", limits: { listEntries: 1 } });
    const noNamespace = body(navigator.list({ context_id: snapshot.context_id, view: "entries", kind: "tool_arguments", tool_name: "exec", namespace: null }));
    expect(noNamespace.entries).toHaveLength(1); expect(noNamespace.entries[0].call_id).toBe("a");
    const conflicting = body(navigator.list({ context_id: snapshot.context_id, view: "entries", kind: "tool_arguments", namespace: null, call_id: "b" }));
    expect(conflicting.entries).toHaveLength(0);
    const range = { start: 1, end_exclusive: 2 };
    const page = navigator.list({ context_id: snapshot.context_id, view: "entries", call_id: "b", source_range: range });
    expect(body(page).entries[0].kind).toBe("tool_arguments");
    expect(JSON.stringify(page)).not.toContain(snapshot.targets.find(t => t.call_id === "b" && t.kind === "tool_result")!.read_ref!);
    expect(JSON.stringify(page)).not.toContain("outside-secret"); expect(JSON.stringify(page)).not.toContain("locator");
    expect(body(navigator.search({ context_id: snapshot.context_id, query: "outside-secret", source_range: range })).hits).toHaveLength(0);
    expect(navigator.list({ context_id: snapshot.context_id, view: "entries", source_range: { start: 0, end_exclusive: 2 } }).isError).toBe(true);
    expect(navigator.list({ context_id: snapshot.context_id, view: "entries", source_range: { start: 1, end_exclusive: snapshot.sources.length + 2 } }).isError).toBe(true);
    // Range is a query boundary, not a restriction on a later authorized query.
    expect(parseContextTextReadResult(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets.find(t => t.call_id === "b" && t.kind === "tool_result")!.read_ref! }] })).bodies[0]).toBe("outside-secret");
  });

  test("literal case-sensitive search returns stable hit order and a dedicated read cursor", () => {
    const original = "头😀 needle Needle needle\n" + "x".repeat(200) + "needle";
    const snapshot = snapshotOf([{ role: "user", content: original }]);
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", limits: { searchHits: 1 } });
    const args = { context_id: snapshot.context_id, query: "needle" };
    const first = body(navigator.search(args)); expect(first.hits).toHaveLength(1); expect(first.has_more).toBe(true);
    expect(body(navigator.search(args))).toEqual(first);
    expect(first.hits[0].range.start).toBe(Buffer.byteLength("头😀 "));
    const read = parseContextTextReadResult(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: first.hits[0].read_ref, cursor: first.hits[0].read_cursor }] }));
    expect(read.bodies[0]).toBe(Buffer.from(original).subarray(first.hits[0].snippet.start).toString("utf8"));
    const offsets = [first.hits[0].range.start]; let cursor = first.next_cursor;
    while (cursor) { const page = body(navigator.search({ ...args, cursor })); offsets.push(...page.hits.map((h: any) => h.range.start)); cursor = page.next_cursor; }
    expect(offsets).toHaveLength(3); expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(body(navigator.search({ context_id: snapshot.context_id, query: "[.*]" })).hits).toHaveLength(0);
  });

  test("rejects cursors across tools, scope, context, reference and normalized filters", () => {
    const snapshot = snapshotOf([{ role: "user", content: "needle".repeat(1000) }, { role: "user", content: "needle".repeat(1000) }]);
    const options = { snapshot, purpose: "normal" as const, limits: { listEntries: 1, searchHits: 1, readBytes: 5000, readTokens: 1800 } };
    const navigator = new ContextNavigator({ ...options, scopeId: "a", limits: { ...options.limits, maxErrorResponses: 12 } });
    const listCursor = body(navigator.list({ context_id: snapshot.context_id, view: "entries" })).next_cursor;
    const searchPage = body(navigator.search({ context_id: snapshot.context_id, query: "needle" }));
    const readCursor = body(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] })).items[0].next_cursor;
    expect(listCursor).toBeString(); expect(readCursor).toBeString();
    const invalid = [
      navigator.search({ context_id: snapshot.context_id, query: "needle", cursor: listCursor }),
      navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref!, cursor: searchPage.next_cursor }] }),
      navigator.list({ context_id: snapshot.context_id, view: "entries", kind: "message_text", cursor: listCursor }),
      navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[1]!.read_ref!, cursor: readCursor }] }),
      new ContextNavigator({ ...options, scopeId: "b" }).list({ context_id: snapshot.context_id, view: "entries", cursor: listCursor }),
      navigator.read({ context_id: "context_" + "0".repeat(32), reads: [{ read_ref: snapshot.targets[0]!.read_ref!, cursor: readCursor }] }),
      navigator.list({ context_id: snapshot.context_id, view: "entries", cursor: listCursor.slice(0, -1) + (listCursor.endsWith("a") ? "b" : "a") }),
    ];
    expect(invalid.every(r => r.isError === true)).toBe(true);
    const other = snapshotOf([{ role: "user", content: "needle" }]);
    expect(new ContextNavigator({ scopeId: "a", snapshot: other, purpose: "normal" }).list({ context_id: other.context_id, view: "entries", cursor: listCursor }).isError).toBe(true);
    expect(navigator.read({ context_id: snapshot.context_id, extra: "bad", reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] }).isError).toBe(true);
  });

  test("overview distinguishes sources/calls/results and keeps live readiness out of stable pages", () => {
    const snapshot = snapshotOf([{ type: "function_call", call_id: "a", name: "exec", arguments: "{}" }, { type: "function_call_output", call_id: "a", output: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]);
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal" });
    const a = body(navigator.list({ context_id: snapshot.context_id, view: "overview" }, { context_ready: false, delivered_images: 0 }));
    const b = body(navigator.list({ context_id: snapshot.context_id, view: "overview" }, { context_ready: true, delivered_images: 1 }));
    expect(a.counts).toEqual({ sources: 2, targets: 3, calls: 1, results: 1, images: 0 }); expect(b.counts).toEqual(a.counts);
    expect(a.live.context_ready).toBe(false); expect(b.live.context_ready).toBe(true);
    const entries = navigator.list({ context_id: snapshot.context_id, view: "entries" }, { context_ready: false });
    expect(JSON.stringify(entries)).not.toContain("context_ready");
    navigator.retire(); expect(navigator.list({ context_id: snapshot.context_id, view: "overview" }).isError).toBe(true);
  });

  test("all blocks of one multi-image tool result are independently discoverable without multiplying source counts", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const snapshot = snapshotOf([
      { type: "function_call", call_id: "images", name: "inspect", namespace: "vision", arguments: "{}" },
      { type: "function_call_output", call_id: "images", output: [
        { type: "text", text: "first" }, { type: "input_image", image_url: `data:image/png;base64,${png}` },
        { type: "text", text: "" }, { type: "input_image", image_url: `data:image/png;base64,${png}` },
      ] },
    ]);
    const navigator = new ContextNavigator({ scopeId: "images", snapshot, purpose: "normal", limits: { listEntries: 1 } });
    const found: any[] = []; let cursor: string | undefined;
    do { const page = body(navigator.list({ context_id: snapshot.context_id, view: "entries", kind: "image", tool_name: "inspect", namespace: "vision", call_id: "images", ...(cursor ? { cursor } : {}) }));
      found.push(...page.entries); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(found).toHaveLength(2); expect(found.map(t => t.target_index)).toEqual([2, 4]);
    for (const entry of found) { expect(entry.required).toBe(false); expect(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: entry.read_ref }] }).isError).not.toBe(true); }
    expect(body(navigator.list({ context_id: snapshot.context_id, view: "overview" })).counts).toEqual({ sources: 2, targets: 5, calls: 1, results: 1, images: 2 });
  });
});
