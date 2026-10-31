import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot, restoreContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { contextTextReadReceipt, isContextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { CONTEXT_CREDENTIAL_ARGUMENT_BYTES, contextBudgetProfileLimits, contextLimits, measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { measureBootstrapRequiredCosts } from "../src/adapters/chatgpt-web/context-bootstrap-plan";
import type { ContextReadArgs } from "../src/adapters/chatgpt-web/context-types";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function snapshotOf(texts: string[]) {
  const wire = createContextSnapshot(parseRequest({ model: "gpt-6", input: texts.map(content => ({ role: "user", content })) })).toWire();
  // The fixture owns the complete original inputs and supplies trusted completeness.
  for (const source of wire.sources) source.source_completeness = "complete";
  for (const target of wire.targets) target.source_completeness = "complete";
  return restoreContextSnapshot(wire);
}
function fixture(texts: string[], limits = {}) {
  const snapshot = snapshotOf(texts);
  const args = { context_id: snapshot.context_id, reads: snapshot.targets.map(target => ({ read_ref: target.read_ref! })) };
  const navigator = new ContextNavigator({ scopeId: "batch", snapshot, purpose: "normal", limits });
  return { snapshot, args, navigator };
}

describe("context text batches", () => {
  test("validates the complete array, including an unreturned invalid suffix", () => {
    const { snapshot, args } = fixture(["private prefix ".repeat(1000), ...Array.from({ length: 7 }, (_, index) => String(index))]);
    const invalid = [
      { ...args, reads: [] }, { ...args, reads: [...args.reads, args.reads[0]] },
      { ...args, reads: [args.reads[0], args.reads[0]] },
      { ...args, reads: [{ ...args.reads[0], extra: 1 }] }, { ...args, reads: [null] },
      { ...args, reads: [{ read_ref: "" }] }, { ...args, reads: "wrong" },
      { context_id: snapshot.context_id, read_ref: args.reads[0]!.read_ref },
      { ...args, cursor: "old" }, { ...args, extra: true },
      { ...args, reads: [args.reads[0], { read_ref: "not-a-current-reference" }] },
      { ...args, reads: [args.reads[0], { ...args.reads[1], cursor: "not-a-current-cursor" }] },
    ];
    for (const input of invalid) {
      const navigator = new ContextNavigator({ scopeId: "strict", snapshot, purpose: "normal" });
      const result = navigator.read(input);
      expect(result.isError).toBe(true); expect(result.content).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private prefix");
      expect(navigator.usage().read_returned_items).toBe(0);
    }
    // A real eight-target request is accepted; a duplicate target cannot stand in for item 8.
    const eight = snapshotOf(Array.from({ length: 8 }, (_, i) => `${i}`));
    const result = new ContextNavigator({ scopeId: "eight", snapshot: eight, purpose: "normal" }).read({ context_id: eight.context_id,
      reads: eight.targets.map(target => ({ read_ref: target.read_ref! })) });
    expect(result.isError).not.toBe(true); expect(parseContextTextReadResult(result).bodies).toHaveLength(8);
  });

  test("one result carries independent exact bodies and incurs one complete response charge", () => {
    const texts = ['{ "json": "\\n" }\r\n', "中文😀e\u0301", "", "last item contains REQUIRED-TAIL"];
    const { args, navigator } = fixture(texts);
    const result = navigator.read(args), page = parseContextTextReadResult(result), cost = measureContextResponse(result);
    expect(page.bodies).toEqual(texts); expect(result.content).toHaveLength(texts.length + 1);
    expect(page.metadata.items.map(item => item.request_index)).toEqual([0, 1, 2, 3]);
    expect(page.metadata.items.map(item => item.body_content_index)).toEqual([1, 2, 3, 4]);
    expect(page.metadata.remaining_reads).toEqual([]); expect(page.metadata.required_step).toBeUndefined();
    expect(navigator.usage()).toMatchObject({ read_calls: 1, read_requested_items: 4, read_returned_items: 4,
      wire_bytes: cost.wire_bytes, text_tokens: cost.text_tokens });
    const receipt = contextTextReadReceipt(result); expect(isContextTextReadReceipt(receipt)).toBe(true);
    expect(receipt.content_blocks).toBe(5); expect(receipt.items).toHaveLength(4);
    expect(receipt.items[2]).toMatchObject({ range: { start: 0, end_exclusive: 0 }, body_utf8_bytes: 0 });
    const changed = structuredClone(result); (changed.content[4] as { text: string }).text = texts[3]!.replace("TAIL", "FAIL");
    expect(contextTextReadReceipt(changed).result_digest).not.toBe(receipt.result_digest);
  });

  test("a partial middle source retains its continuation and the unchanged suffix", () => {
    const texts = ["first", "中文😀e\u0301\\\n".repeat(1200) + "MIDDLE-END", "final-required-info"];
    const { snapshot, args, navigator } = fixture(texts, { readBytes: 6500, readTokens: 8000 });
    let current = args, count = 0;
    const recovered = new Map<string, string>();
    do {
      const result = navigator.read(current), page = parseContextTextReadResult(result);
      expect(result.isError).not.toBe(true);
      if (count === 0) {
        expect(page.bodies[0]).toBe("first"); expect(page.metadata.items).toHaveLength(2);
        expect(page.metadata.remaining_reads[1]).toEqual(args.reads[2]);
        expect(page.metadata.remaining_reads[0]).toEqual({ read_ref: args.reads[1]!.read_ref, cursor: page.metadata.items[1]!.next_cursor! });
        expect(navigator.read(current)).toEqual(result);
      }
      for (const [index, item] of page.metadata.items.entries()) {
        expect(page.bodies[index]).not.toContain("�");
        const previous = recovered.get(item.read_ref) ?? "";
        expect(item.range.start).toBe(Buffer.byteLength(previous));
        recovered.set(item.read_ref, previous + page.bodies[index]);
      }
      current = { context_id: snapshot.context_id, reads: page.metadata.remaining_reads };
      expect(++count).toBeLessThan(100);
    } while (current.reads.length);
    expect(args.reads.map(read => recovered.get(read.read_ref))).toEqual(texts);
    const eof = parseContextTextReadResult(navigator.read(navigator.readArgsAt(snapshot.targets[1]!.target_id, Buffer.byteLength(texts[1]!))));
    expect(eof.bodies).toEqual([""]); expect(eof.metadata.items[0]!.range).toEqual({ start: Buffer.byteLength(texts[1]!), end_exclusive: Buffer.byteLength(texts[1]!) });
  });

  test("whole batches reject mixed images and preserve the original one-image result", () => {
    const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: [{ role: "user", content: [
      { type: "input_text", text: "must not leak" }, { type: "input_image", image_url: `data:image/png;base64,${png}` },
      { type: "input_image", image_url: `data:image/png;base64,${png}` },
    ] }] }));
    const navigator = new ContextNavigator({ scopeId: "images", snapshot, purpose: "normal" });
    const image = snapshot.targets.find(target => target.kind === "image")!;
    const result = navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: image.read_ref! }] });
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: png });
    expect(result.structuredContent).not.toHaveProperty("format");
    for (const targets of [snapshot.targets.slice(0, 2), snapshot.targets.filter(target => target.kind === "image")]) {
      const rejected = navigator.read({ context_id: snapshot.context_id, reads: targets.map(target => ({ read_ref: target.read_ref! })) });
      expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).not.toContain("must not leak");
    }
    expect(navigator.usage().image_reads).toBe(1);
  });

  test("byte and token ceilings include metadata, continuations, and credential allowance", () => {
    for (const [limits, hit] of [[{ readBytes: 5000, readTokens: 8000 }, "read_bytes"],
      [{ readBytes: 65536, readTokens: 1800 }, "read_tokens"]] as const) {
      const { args, navigator } = fixture(["中文😀 ".repeat(3000)], limits);
      const result = navigator.read(args), cost = measureContextResponse(result);
      expect(result.isError).not.toBe(true); expect(parseContextTextReadResult(result).metadata.items[0]!.has_more).toBe(true);
      expect(cost.wire_bytes).toBeLessThanOrEqual(limits.readBytes); expect(cost.total_tokens).toBeLessThanOrEqual(limits.readTokens);
      expect(navigator.usage().budget_hits[hit]).toBe(1);
    }
    const { snapshot, args } = fixture(["body"]);
    const bytes = Buffer.byteLength(JSON.stringify(args)) + CONTEXT_CREDENTIAL_ARGUMENT_BYTES;
    const exact = new ContextNavigator({ scopeId: "exact", snapshot, purpose: "normal", limits: { maxArgumentBytes: bytes } });
    expect(exact.read(args).isError).not.toBe(true);
    const small = new ContextNavigator({ scopeId: "small", snapshot, purpose: "normal", limits: { maxArgumentBytes: bytes - 1 } });
    expect(small.read(args).isError).toBe(true); expect(small.usage().budget_hits.argument_bytes).toBe(1);
    const wrapper = new ContextNavigator({ scopeId: "wrapper", snapshot, purpose: "normal", limits: { readBytes: 512 } });
    expect(wrapper.read(args).isError).toBe(true);
    const noProgress = fixture(["x".repeat(10000)], { readTokens: 1000 });
    expect(noProgress.navigator.read(noProgress.args).isError).toBe(true);
  });

  test("the parser checks every item, locator, continuation and required-step structure", () => {
    const { args, navigator } = fixture(["AA", "BB"]), result = navigator.read(args);
    const changes = [
      (m: any) => { m.format = "context-text-read-v2"; },
      (m: any) => { m.items[1].body_content_index = 1; }, (m: any) => { m.items[1].request_index = 0; },
      (m: any) => { m.items[1].source = m.items[0].source; }, (m: any) => { m.items[1].source.secret = true; },
      (m: any) => { m.items[1].locator.unsafe_path = "/tmp"; }, (m: any) => { m.items[1].locator.message_index = -1; },
      (m: any) => { m.items[1].content_digest = "unknown"; }, (m: any) => { delete m.items[1].required; },
      (m: any) => { m.remaining_reads = [args.reads[0]]; }, (m: any) => { m.remaining_reads = [{ read_ref: "future", unknown: 1 }]; },
      (m: any) => { m.required_step = { plan_id: "p", index: -1, next_required_read: null }; },
      (m: any) => { m.required_step = { plan_id: "p", index: 0, next_required_read: { tool: "codex_context_read", arguments: { context_id: m.context_id, read_ref: "old" } } }; },
    ];
    for (const change of changes) {
      const altered = structuredClone(result); change(altered.structuredContent); (altered.content[0] as { text: string }).text = JSON.stringify(altered.structuredContent);
      expect(() => parseContextTextReadResult(altered)).toThrow();
    }
    expect(() => parseContextTextReadResult({ ...result, content: [...result.content, { type: "text", text: "unreferenced" }] })).toThrow();
  });
});

describe("fixed bootstrap batch chains", () => {
  for (const count of [1, 8, 9]) test(`${count} sources retain partial successors, empty blocks and exact UTF-8 tails`, () => {
    const texts = Array.from({ length: count }, (_, index) => index === count - 1
      ? "中文🙂\\n\t  \n".repeat(3000) : index % 2 ? "" : `source-${index}`);
    const snapshot = snapshotOf(texts), limits = contextLimits();
    const deliveryByTarget = Object.fromEntries(snapshot.targets.map(target => [target.target_id, { delivery: "mcp", required: true }]));
    const planned = measureBootstrapRequiredCosts({ snapshot, planId: "tails", manifestDigest: "digest", limits,
      deliveryByTarget, started: performance.now() });
    const nav = new ContextNavigator({ scopeId: "tails", snapshot, purpose: "normal", limits, deliveryByTarget,
      bootstrap: { planId: "tails", manifestDigest: "digest", requiredTextBatches: planned.batches } });
    const restored = new Map<string, string>();
    expect(planned.batches.length).toBeGreaterThan(1);
    expect(planned.batches.length).toBeLessThan(100);
    for (const [index, batch] of planned.batches.entries()) {
      const args = nav.requiredReadArgs(index), reply = nav.read(args);
      expect(nav.read(args)).toEqual(reply);
      const cost = measureContextResponse(reply, { boundCursorTokens: true }), page = parseContextTextReadResult(reply);
      expect(cost.total_tokens).toBeLessThanOrEqual(batch.tokens);
      expect(cost.wire_bytes).toBeLessThanOrEqual(batch.wire_bytes);
      expect(cost.total_tokens).toBeLessThanOrEqual(limits.readTokens);
      expect(cost.wire_bytes).toBeLessThanOrEqual(limits.readBytes);
      for (const [bodyIndex, item] of page.metadata.items.entries()) {
        const previous = restored.get(item.read_ref) ?? "";
        expect(item.range.start).toBe(Buffer.byteLength(previous));
        restored.set(item.read_ref, previous + page.bodies[bodyIndex]);
      }
      expect(page.metadata.required_step!.next_required_read?.arguments ?? null)
        .toEqual(index + 1 < planned.batches.length ? nav.requiredReadArgs(index + 1) : null);
    }
    expect(snapshot.targets.map(target => restored.get(target.read_ref!))).toEqual(texts);
  });

  for (const profile of ["expanded", "conservative"] as const) test(`${profile} merges 24 required sources and re-signs one finite chain without entries`, () => {
    const texts = Array.from({ length: 24 }, (_, index) => `${index}:` + "short ".repeat(63) + (index === 23 ? "REQUIRED-LAST-ITEM" : ""));
    const snapshot = snapshotOf(texts), limits = contextLimits(contextBudgetProfileLimits(profile));
    const deliveryByTarget = Object.fromEntries(snapshot.targets.map(target => [target.target_id, { delivery: "mcp", required: true }]));
    const planned = measureBootstrapRequiredCosts({ snapshot, planId: "fixed-plan", manifestDigest: "fixed-digest", limits,
      deliveryByTarget, started: performance.now() });
    expect(planned.batches.length).toBeLessThan(24); expect(planned.batches.some(batch => batch.ranges.length >= 2)).toBe(true);
    expect(planned.control.count).toBe(2);
    expect(planned.discovery.total_tokens).toBe(planned.control.start.tokens + planned.control.overview.tokens);
    expect(planned.control.overview.tokens).toBeLessThan(limits.listTokens);
    const bodiesByScope: string[][] = [];
    for (const scopeId of ["first", "second"]) {
      const nav = new ContextNavigator({ scopeId, snapshot, purpose: "normal", deliveryByTarget, limits,
        bootstrap: { planId: "fixed-plan", manifestDigest: "fixed-digest", requiredTextBatches: planned.batches } });
      let current: ContextReadArgs | undefined = nav.requiredReadArgs(0), index = 0;
      const restored = new Map<string, string>(), bodies: string[] = [];
      const overview = nav.list({ context_id: snapshot.context_id, view: "overview" }, { context_ready: false,
        next_required_read: { tool: "codex_context_read", arguments: current } });
      expect(overview.structuredContent).toMatchObject({ manifest_version: 3, text_read_format: "context-text-batch-v1", required_discovery: "batch-metadata" });
      expect(overview.structuredContent).not.toHaveProperty("required_targets"); expect(overview.structuredContent).not.toHaveProperty("next_required_list");
      const before = nav.usage();
      while (current) {
        expect(Buffer.byteLength(JSON.stringify({ ...current, turn_token: "t".repeat(256) }))).toBeLessThanOrEqual(8192);
        const preflight = nav.preflightRead(current), result = nav.read(current);
        expect(result).toEqual(preflight);
        const parsed = parseContextTextReadResult(result), cost = measureContextResponse(result), batch = planned.batches[index]!;
        expect(cost.total_tokens).toBeLessThanOrEqual(batch.tokens); expect(cost.wire_bytes).toBeLessThanOrEqual(batch.wire_bytes);
        expect(parsed.metadata.items.map(item => ({ target_id: item.source.target_id, ...item.range }))).toEqual(batch.ranges);
        expect(parsed.metadata.required_step?.index).toBe(index);
        for (const [bodyIndex, item] of parsed.metadata.items.entries()) restored.set(item.read_ref, (restored.get(item.read_ref) ?? "") + parsed.bodies[bodyIndex]);
        bodies.push(...parsed.bodies); current = parsed.metadata.required_step!.next_required_read?.arguments; index++;
      }
      expect(index).toBe(planned.batches.length); expect(snapshot.targets.map(target => restored.get(target.read_ref!))).toEqual(texts);
      const final = nav.list({ context_id: snapshot.context_id, view: "overview" }, { context_ready: true, next_required_read: null });
      expect(final.structuredContent).toMatchObject({ next_required_read: null, live: { context_ready: true } });
      expect(nav.usage().read_calls - before.read_calls).toBe(planned.batches.length);
      expect(nav.usage().budget_hits.list_entries).toBeUndefined(); bodiesByScope.push(bodies);
    }
    expect(bodiesByScope[0]).toEqual(bodiesByScope[1]);
  });

  test("a 65 KiB source and dense UTF-8 have finite stable boundaries and terminal information", () => {
    for (const text of ["a".repeat(65 * 1024) + "LAST-PAGE-INFO", "中文😀e\u0301\\\n".repeat(3000) + "DENSE-TAIL"]) {
      const snapshot = snapshotOf([text, "", "AFTER-LONG-SOURCE"]), limits = contextLimits();
      const deliveryByTarget = Object.fromEntries(snapshot.targets.map(target => [target.target_id, { delivery: "mcp", required: true }]));
      const costs = measureBootstrapRequiredCosts({ snapshot, planId: "long", manifestDigest: "digest", limits, deliveryByTarget,
        started: performance.now() });
      const nav = new ContextNavigator({ scopeId: "long", snapshot, purpose: "normal", deliveryByTarget,
        bootstrap: { planId: "long", manifestDigest: "digest", requiredTextBatches: costs.batches } });
      const restored = new Map<string, string>();
      for (let index = 0; index < costs.batches.length; index++) {
        const args = nav.requiredReadArgs(index), first = nav.preflightRead(args), page = parseContextTextReadResult(first);
        expect(nav.preflightRead(args)).toEqual(first);
        for (const [bodyIndex, item] of page.metadata.items.entries()) {
          expect(page.bodies[bodyIndex]).not.toContain("�");
          restored.set(item.read_ref, (restored.get(item.read_ref) ?? "") + page.bodies[bodyIndex]);
        }
      }
      expect(snapshot.targets.map(target => restored.get(target.read_ref!))).toEqual([text, "", "AFTER-LONG-SOURCE"]);
      expect(costs.retry.tokens).toBe(Math.max(...costs.batches.map(batch => batch.tokens)));
      expect(costs.retry.wire_bytes).toBe(Math.max(...costs.batches.map(batch => batch.wire_bytes)));
    }
  });
});
