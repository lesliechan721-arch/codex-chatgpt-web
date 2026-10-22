import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigationStoppedError, ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { assertContextNavigationBudget, CONTEXT_LIMITS, contextErrorReserve, contextLimits, contextBudgetProfileLimits, measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const snapshotOf = (input: unknown[]) => createContextSnapshot(parseRequest({ model: "gpt-6", input }));
describe("complete context response budgets", () => {
  test("fit checks use a safe byte bound and fall back to exact costs at token boundaries", () => {
    const body = { text: '"\\\n中文😀'.repeat(20), next_cursor: "opaque-future-cursor" };
    const result = { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
    const wireReserveBytes = 137, tokenReserve = 41, visualTokens = 257;
    const bound = Buffer.byteLength(JSON.stringify(result)) + tokenReserve + visualTokens;
    for (const boundCursorTokens of [false, true]) {
      const options = { wireReserveBytes, tokenReserve, visualTokens, boundCursorTokens };
      const exact = measureContextResponse(result, options);
      const fast = measureContextResponse(result, { ...options, tokenCeiling: bound });
      expect(fast).toEqual({ wire_bytes: Buffer.byteLength(JSON.stringify(result)) + wireReserveBytes,
        text_tokens: bound - visualTokens, visual_tokens: visualTokens, total_tokens: bound });
      expect(fast.total_tokens).toBeGreaterThanOrEqual(exact.total_tokens);
      for (const tokenCeiling of [bound - 1, exact.total_tokens, exact.total_tokens - 1]) {
        expect(measureContextResponse(result, { ...options, tokenCeiling })).toEqual(exact);
      }
    }
  });

  test("fit bounds exclude image data from text but retain wire and visual costs", () => {
    const metadata = { type: "image", mimeType: "image/png" };
    const result = { content: [{ ...metadata, data: png }] };
    const tokenReserve = 37, visualTokens = 512;
    const textBound = Buffer.byteLength(JSON.stringify({ content: [metadata] })) + tokenReserve;
    const options = { tokenReserve, visualTokens, tokenCeiling: textBound + visualTokens };
    const cost = measureContextResponse(result, options);
    expect(cost).toEqual({ wire_bytes: Buffer.byteLength(JSON.stringify(result)) + CONTEXT_LIMITS.wireReserveBytes,
      text_tokens: textBound, visual_tokens: visualTokens, total_tokens: textBound + visualTokens });
    expect(measureContextResponse(result, { ...options, tokenCeiling: cost.total_tokens - 1 }))
      .toEqual(measureContextResponse(result, { tokenReserve, visualTokens }));
    expect(() => measureContextResponse(result, { ...options, visualTokens: -1 })).toThrow("Invalid visual token reserve");
  });

  test("trusted profiles freeze the published expanded and conservative ceilings", () => {
    expect(contextLimits()).toMatchObject({ readBytes: 65536, readTokens: 8000, listBytes: 49152, listTokens: 6000, listEntries: 50,
      searchHits: 10, searchBytes: 12288, searchTokens: 1500 });
    const configured = contextBudgetProfileLimits("conservative"), frozen = contextLimits(configured);
    expect(frozen).toMatchObject({ readBytes: 24576, readTokens: 2500, listBytes: 12288, listTokens: 1500, listEntries: 20 });
    configured.readTokens = 8000;
    expect(frozen.readTokens).toBe(2500); expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => contextBudgetProfileLimits("untrusted" as never)).toThrow();
  });
  test("escaped text and duplicated structured/text metadata fit complete JSON budgets", () => {
    const snapshot = snapshotOf([{ role: "user", content: '\\"\n\t中文😀'.repeat(700) }]);
    const limits = { readBytes: 5000, readTokens: 1800 };
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", limits });
    let cursor: string | undefined, restored = "", count = 0;
    do {
      const result = navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref!, ...(cursor ? { cursor } : {}) }] });
      expect(result.isError).not.toBe(true);
      const cost = measureContextResponse(result);
      expect(cost.wire_bytes).toBe(Buffer.byteLength(JSON.stringify(result)) + CONTEXT_LIMITS.wireReserveBytes);
      expect(cost.wire_bytes).toBeLessThanOrEqual(limits.readBytes); expect(cost.text_tokens).toBeLessThanOrEqual(limits.readTokens);
      const page = parseContextTextReadResult(result); restored += page.bodies[0]!; cursor = page.metadata.items[0]!.next_cursor ?? undefined;
      expect(++count).toBeLessThan(200);
    } while (cursor);
    expect(restored).toBe(snapshot.getText(snapshot.targets[0]!.read_ref!)!);
  });

  test("list/search shrink real structures and a smallest page failure stays bounded", () => {
    const snapshot = snapshotOf(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `source ${i} needle ` + '"\\😀'.repeat(50) })));
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", limits: { listBytes: 5000, listTokens: 1000, searchBytes: 4500, searchTokens: 1500 } });
    let cursor: string | undefined; const seen: string[] = [];
    do {
      const result = navigator.list({ context_id: snapshot.context_id, view: "entries", ...(cursor ? { cursor } : {}) });
      expect(result.isError).not.toBe(true);
      expect(measureContextResponse(result).wire_bytes).toBeLessThanOrEqual(5000); expect(measureContextResponse(result).text_tokens).toBeLessThanOrEqual(1000);
      const page = result.structuredContent as any; seen.push(...page.entries.map((e: any) => e.target_id)); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(snapshot.targets.map(t => t.target_id));
    const search = navigator.search({ context_id: snapshot.context_id, query: "needle" }); expect(search.isError).not.toBe(true);
    expect(measureContextResponse(search).wire_bytes).toBeLessThanOrEqual(4500); expect(measureContextResponse(search).text_tokens).toBeLessThanOrEqual(1500);
    const small = new ContextNavigator({ scopeId: "small", snapshot, purpose: "normal", limits: { listBytes: 512, readBytes: 512, searchBytes: 512 } });
    const errors = [small.list({ context_id: snapshot.context_id, view: "entries" }), small.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] }), small.search({ context_id: snapshot.context_id, query: "needle" })];
    for (const error of errors) { expect(error.isError).toBe(true); expect(JSON.stringify(error)).toContain("BUDGET_EXCEEDED"); expect(measureContextResponse(error).wire_bytes).toBeLessThanOrEqual(512); }
  });

  test("fixed original images have one block, metadata-only structured content and real repeat cost", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "original" }] }]);
    const target = snapshot.targets[0]!;
    expect(target.visual_token_reserve).toBe(8192); // Preserve raw original detail despite parser's high normalization.
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", deliveryByTarget: { [target.target_id]: { delivery: "mcp", media_route: "mcp", required: true } } });
    const args = { context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref! }] };
    const result = navigator.read(args); expect(result.isError).not.toBe(true);
    expect(result.content.filter((c: any) => c.type === "image")).toEqual([{ type: "image", mimeType: "image/png", data: png }]);
    expect(JSON.stringify(result.structuredContent)).not.toContain(png); expect(JSON.stringify(result.content[0])).not.toContain(png);
    const first = navigator.usage(); expect(first.image_reads).toBe(1); expect(first.visual_token_reserve).toBe(target.visual_token_reserve!);
    expect(navigator.read(args)).toEqual(result);
    const second = navigator.usage(); expect(second.image_reads).toBe(2); expect(second.image_bytes).toBe(first.image_bytes * 2);
    expect(second.wire_bytes).toBe(first.wire_bytes * 2); expect(second.text_tokens).toBe(first.text_tokens * 2); expect(second.visual_token_reserve).toBe(first.visual_token_reserve * 2);
    const list = navigator.list({ context_id: snapshot.context_id, view: "entries" }); expect(JSON.stringify(list)).not.toContain("data:image"); expect(JSON.stringify(list)).not.toContain(png);
    expect(navigator.search({ context_id: snapshot.context_id, query: "x", read_ref: target.read_ref! }).isError).toBe(true);
  });

  test("unknown remote images and attachment routes have no usable MCP reference", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: "https://unfetched.invalid/a" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }]);
    const fixed = snapshot.targets[1]!;
    const navigator = new ContextNavigator({ scopeId: "scope", snapshot, purpose: "normal", deliveryByTarget: { [fixed.target_id]: { delivery: "attachment", media_route: "attachment", reason: "Supported attachment fallback" } }, limits: { listTokens: 5000 } });
    const entries = (navigator.list({ context_id: snapshot.context_id, view: "entries" }).structuredContent as any).entries;
    expect(entries).toHaveLength(2); expect(entries.every((e: any) => e.read_ref === null)).toBe(true);
    expect(entries.map((e: any) => e.media_route)).toEqual(["unavailable", "attachment"]);
    expect(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: fixed.read_ref! }] }).isError).toBe(true);
    expect(() => new ContextNavigator({ scopeId: "compaction", snapshot, purpose: "compaction" })).toThrow("fully readable");
  });

  test("cumulative image and shared remaining budgets reject before charging image delivery", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] }]);
    const target = snapshot.targets[0]!;
    const limited = new ContextNavigator({ scopeId: "limited", snapshot, purpose: "normal", limits: { maxImageReads: 1 } });
    const args = { context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref! }] };
    expect(limited.read(args).isError).not.toBe(true); const before = limited.usage();
    expect(limited.read(args).isError).toBe(true); expect(limited.usage().image_reads).toBe(1); expect(limited.usage().image_bytes).toBe(before.image_bytes);
    expect(limited.usage().wire_bytes).toBeGreaterThan(before.wire_bytes); // Error transport is real cost too.
    const seen: string[] = [];
    const reserved = new ContextNavigator({ scopeId: "reserve", snapshot, purpose: "normal", remainingBudget: image => {
      if (image) seen.push(image[0]!.target_id); return { tokens: 5384, wire_bytes: 10000, reserved_tokens: image ? 0 : 5000 };
    } });
    expect(reserved.list({ context_id: snapshot.context_id, view: "overview" }).isError).toBe(true);
    expect(reserved.read(args).isError).not.toBe(true); expect(seen).toEqual([target.target_id]);
  });

  test("compaction has no required-media gate and idle time does not expire snapshots", async () => {
    const snapshot = snapshotOf([{ role: "user", content: "summary source" }]);
    const navigator = new ContextNavigator({ scopeId: "compaction", snapshot, purpose: "compaction", remainingBudget: () => ({ tokens: 4000, wire_bytes: 10000, reserved_tokens: 500 }) });
    const overview = navigator.list({ context_id: snapshot.context_id, view: "overview" }); expect((overview.structuredContent as any).remaining_budget.reserved_tokens).toBe(500);
    const elapsed = navigator.usage().processing_ms;
    await new Promise(resolve => setTimeout(resolve, 15)); expect(navigator.usage().processing_ms).toBe(elapsed);
    const read = navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] }); expect(read.isError).not.toBe(true);
    expect((read.structuredContent as any).remaining_budget.stop_hint).toBeString();
    const entries = (navigator.list({ context_id: snapshot.context_id, view: "entries" }).structuredContent as any).entries;
    expect(entries[0]).toMatchObject({ delivery: "source_on_demand", required: false });
  });

  test("a terminal text page fits its exact complete byte and token ceiling", () => {
    const snapshot = snapshotOf([{ role: "user", content: "a".repeat(100) }]);
    const args = { context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] };
    const complete = new ContextNavigator({ scopeId: "measure", snapshot, purpose: "normal" }).read(args);
    const cost = measureContextResponse(complete);
    const exact = new ContextNavigator({ scopeId: "exact", snapshot, purpose: "normal", limits: { readBytes: cost.wire_bytes, readTokens: cost.text_tokens } });
    expect(exact.read(args)).toEqual(complete);
    const small = new ContextNavigator({ scopeId: "below", snapshot, purpose: "normal", limits: { readBytes: cost.wire_bytes - 1 } });
    const result = small.read(args); expect(result.isError).toBe(true);
    expect(measureContextResponse(result).wire_bytes).toBeLessThanOrEqual(CONTEXT_LIMITS.errorResponseBytes);
    const agent = snapshotOf([{ type: "agent_message", author: "author".repeat(100), recipient: "recipient".repeat(100), content: "short" }]);
    const read = new ContextNavigator({ scopeId: "agent", snapshot: agent, purpose: "normal" }).read({ context_id: agent.context_id, reads: [{ read_ref: agent.targets[0]!.read_ref! }] });
    expect(read.isError).not.toBe(true); expect(parseContextTextReadResult(read).bodies[0]).toBe("short");
  });

  test("corrective replies are finite, fully measured and do not consume summary reserves", () => {
    const snapshot = snapshotOf([{ role: "user", content: "summary source" }]);
    const reserve = contextErrorReserve(contextLimits()); expect(reserve).toEqual({ tokens: 384, wire_bytes: 1536 });
    const summaryTokens = 500, summaryWire = 700;
    let navigator: ContextNavigator;
    navigator = new ContextNavigator({ scopeId: "summary", snapshot, purpose: "compaction", remainingBudget: () => ({
      tokens: summaryTokens + reserve.tokens + 1 - navigator.usage().text_tokens,
      wire_bytes: summaryWire + reserve.wire_bytes + 1 - navigator.usage().wire_bytes,
      reserved_tokens: summaryTokens, reserved_wire_bytes: summaryWire,
    }) });
    let chargedTokens = 0, chargedBytes = 0;
    for (let index = 0; index < 3; index++) {
      const result = navigator.list({ context_id: snapshot.context_id, view: "overview" });
      expect(result.isError).toBe(true);
      const cost = measureContextResponse(result); chargedTokens += cost.text_tokens; chargedBytes += cost.wire_bytes;
      expect(cost.text_tokens).toBeLessThanOrEqual(128); expect(cost.wire_bytes).toBeLessThanOrEqual(512);
      expect((result.structuredContent as any).error.navigation_stopped).toBe(index === 2 ? true : undefined);
    }
    expect(navigator.usage()).toMatchObject({ error_responses: 3, navigation_stopped: true, text_tokens: chargedTokens, wire_bytes: chargedBytes });
    expect(chargedTokens).toBeLessThanOrEqual(reserve.tokens); expect(chargedBytes).toBeLessThanOrEqual(reserve.wire_bytes);
    const before = navigator.usage();
    expect(() => navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] })).toThrow(ContextNavigationStoppedError);
    expect(navigator.usage()).toEqual(before);
    expect(snapshot.getText(snapshot.targets[0]!.read_ref!)).toBe("summary source");
  });

  test("an overview rejection protects required image tokens and wire while its read credits only its own reserve", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }] }]);
    const target = snapshot.targets[0]!, args = { context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref! }] };
    const image = new ContextNavigator({ scopeId: "measure", snapshot, purpose: "normal" }).read(args);
    const imageCost = measureContextResponse(image, { visualTokens: target.visual_token_reserve! }), reserve = contextErrorReserve();
    let navigator: ContextNavigator;
    navigator = new ContextNavigator({ scopeId: "required", snapshot, purpose: "normal", remainingBudget: source => ({
      tokens: imageCost.total_tokens + reserve.tokens + 1 - navigator.usage().text_tokens - navigator.usage().visual_token_reserve,
      wire_bytes: imageCost.wire_bytes + reserve.wire_bytes + 1 - navigator.usage().wire_bytes,
      reserved_tokens: source?.[0]?.target_id === target.target_id ? 0 : imageCost.total_tokens,
      reserved_wire_bytes: source?.[0]?.target_id === target.target_id ? 0 : imageCost.wire_bytes,
    }) });
    expect(navigator.list({ context_id: snapshot.context_id, view: "overview" }).isError).toBe(true);
    expect(navigator.usage().text_tokens).toBeGreaterThan(0); expect(navigator.usage().wire_bytes).toBeGreaterThan(0);
    expect(navigator.read(args)).toEqual(image); expect(navigator.usage().image_reads).toBe(1);
    // Tight wire protection independently rejects a page even with ample model tokens.
    let wireOnly: ContextNavigator;
    wireOnly = new ContextNavigator({ scopeId: "wire", snapshot, purpose: "normal", remainingBudget: source => ({
      tokens: 100000 - wireOnly.usage().text_tokens - wireOnly.usage().visual_token_reserve,
      wire_bytes: imageCost.wire_bytes + reserve.wire_bytes + 1 - wireOnly.usage().wire_bytes,
      reserved_wire_bytes: source?.[0]?.target_id === target.target_id ? 0 : imageCost.wire_bytes,
    }) });
    expect(wireOnly.list({ context_id: snapshot.context_id, view: "overview" }).isError).toBe(true);
    expect(wireOnly.read(args).isError).not.toBe(true);
  });

  test("publication rejects budgets without the finite error pool and malformed wire allowances", () => {
    const reserve = contextErrorReserve();
    expect(() => assertContextNavigationBudget({ tokens: 4462, reserved_tokens: 4461, wire_bytes: 10000 })).toThrow();
    expect(() => assertContextNavigationBudget({ tokens: 10000, wire_bytes: reserve.wire_bytes - 1 })).toThrow();
    expect(() => assertContextNavigationBudget({ tokens: 10000, wire_bytes: -1 })).toThrow();
    expect(() => contextLimits({ errorResponseBytes: 256 })).toThrow("corrective reply");
    expect(() => contextLimits({ listBytes: 256 })).toThrow("corrective reply");
    const snapshot = snapshotOf([{ role: "user", content: "source" }]);
    const navigator = new ContextNavigator({ scopeId: "unpublished", snapshot, purpose: "normal", remainingBudget: () => ({ tokens: 501, reserved_tokens: 500, wire_bytes: 10000 }) });
    expect(() => navigator.list({ context_id: snapshot.context_id, view: "overview" })).toThrow(ContextNavigationStoppedError);
    expect(navigator.usage()).toMatchObject({ text_tokens: 0, wire_bytes: 0, navigation_stopped: true });
  });

  test("verified attachment delivery remains visible when its snapshot has no MCP image reference", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: "https://unfetched.invalid/attachment" }] }]);
    const target = snapshot.targets[0]!;
    const navigator = new ContextNavigator({ scopeId: "attachment", snapshot, purpose: "normal", deliveryByTarget: { [target.target_id]: { delivery: "attachment", media_route: "attachment", required: true } } });
    const result = navigator.list({ context_id: snapshot.context_id, view: "entries" });
    expect((result.structuredContent as any).entries[0]).toMatchObject({ media_route: "attachment", read_ref: null, required: true });
  });

  test("optional image reads cannot consume protected required raw bytes or read counts", () => {
    const snapshot = snapshotOf([{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png}` }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }]);
    const [optional, required] = snapshot.targets;
    for (const dimension of ["image_reads", "image_bytes"] as const) {
      let navigator: ContextNavigator;
      navigator = new ContextNavigator({ scopeId: dimension, snapshot, purpose: "normal", remainingBudget: target => ({
        tokens: 20000 - navigator.usage().text_tokens - navigator.usage().visual_token_reserve,
        wire_bytes: 20000 - navigator.usage().wire_bytes,
        ...(dimension === "image_reads" ? { image_reads: 1 - navigator.usage().image_reads, reserved_image_reads: target?.[0]?.target_id === required!.target_id ? 0 : 1 }
          : { image_bytes: required!.image_bytes! - navigator.usage().image_bytes, reserved_image_bytes: target?.[0]?.target_id === required!.target_id ? 0 : required!.image_bytes! }),
      }) });
      expect(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: optional!.read_ref! }] }).isError).toBe(true);
      expect(navigator.usage().image_bytes).toBe(0); expect(navigator.usage().image_reads).toBe(0);
      expect(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: required!.read_ref! }] }).isError).not.toBe(true);
      expect(navigator.usage().image_reads).toBe(1);
    }
    expect(() => assertContextNavigationBudget({ tokens: 10000, wire_bytes: 10000, image_reads: 0, reserved_image_reads: 1 })).toThrow();
    expect(() => assertContextNavigationBudget({ tokens: 10000, wire_bytes: 10000, reserved_image_bytes: 1 })).toThrow();
  });

  test("single-target preflight uses real response limits without charging full-source cumulative reads", () => {
    const snapshot = snapshotOf([{ role: "user", content: "汉😀".repeat(3000) }]);
    const navigator = new ContextNavigator({ scopeId: "prepare", snapshot, purpose: "compaction", limits: { readBytes: 5000, readTokens: 1800 } });
    const args = { context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] }, before = navigator.usage();
    const first = navigator.preflightRead(args);
    expect(first.isError).not.toBe(true); expect(measureContextResponse(first).wire_bytes).toBeLessThanOrEqual(5000);
    expect(navigator.preflightRead(args)).toEqual(first);
    expect(navigator.usage()).toEqual(before);
    expect(parseContextTextReadResult(first).bodies[0]).not.toContain("�");
    const tooSmall = new ContextNavigator({ scopeId: "small", snapshot, purpose: "compaction", limits: { readBytes: 512 } });
    expect(tooSmall.preflightRead(args).isError).toBe(true); expect(tooSmall.usage().error_responses).toBe(0);
  });
});
