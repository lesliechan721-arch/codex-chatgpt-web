import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { appendFixedContextRecords, createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextScope, type ContextPlanRegistration, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { contextErrorReserve, contextLimits, measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { measureBootstrapRequiredCosts } from "../src/adapters/chatgpt-web/context-bootstrap-plan";
import type { ContextReadArgs } from "../src/adapters/chatgpt-web/context-types";

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function registration(texts: string[], withImage = false): ContextPlanRegistration {
  const base = createContextSnapshot(parseRequest({ model: "gpt-6", input: [{ role: "user", content: withImage ? [
    { type: "input_text", text: "optional history" }, { type: "input_image", image_url: `data:image/png;base64,${image}` },
  ] : "optional history" }] }));
  const snapshot = appendFixedContextRecords(base, texts.map(text => ({ text, encoding: "utf-8", origin: "context_bootstrap_payload" })));
  return { snapshot, planId: "bootstrap-plan", manifestDigest: "bootstrap-manifest", startupProtocol: "context-bootstrap-v1",
    limits: { readBytes: 12 * 1024, readTokens: 4_000 }, deliveryByTarget: Object.fromEntries(snapshot.targets.map(target => [target.target_id,
      target.origin === "context_bootstrap_payload" ? { delivery: "source_required", required: true }
        : target.kind === "image" ? { delivery: "on_demand", required: true, media_route: "mcp" } : { delivery: "source_on_demand" }])) };
}
function scopeOf(plan: ContextPlanRegistration, purpose: "normal" | "compaction" = "normal") {
  const scope = new ContextScope("bootstrap-scope", plan, purpose, () => {}, () => {});
  scope.markEntryDelivered(); return scope;
}
function finish(scope: ContextScope, reply: ContextPreparedReply, sent = true) {
  const receipt = !reply.result.isError && reply.result.content.length >= 2 && (reply.result.content[1] as { type?: string }).type === "text"
    ? contextTextReadReceipt(reply.result) : undefined;
  return scope.finish(reply.receiptId, sent, receipt);
}
function requiredText(plan: ContextPlanRegistration, index = 0) { return plan.snapshot.targets.filter(t => t.origin === "context_bootstrap_payload")[index]!; }
function read(scope: ContextScope, args?: ContextReadArgs) {
  return scope.prepare("read", args ?? scope.status().next_required_read!.arguments);
}

test("required UTF-8 coverage uses successful interval unions, including out-of-order, repeated, overlapping and empty pages", () => {
  const original = Array.from({ length: 2300 }, (_, index) => `item${index.toString().padStart(4, "0")} 中文😀\\\n`).join("");
  const plan = registration([original, ""]), scope = scopeOf(plan), target = requiredText(plan);
  try {
    const args = { context_id: plan.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] };
    const pages: ContextReadArgs[] = [];
    let current: ContextReadArgs = args;
    for (;;) {
      pages.push(current);
      const page = parseContextTextReadResult(scope.navigator.preflightRead(current)).metadata.items[0]!;
      if (!page.next_cursor) break;
      current = { ...args, reads: [{ ...args.reads[0]!, cursor: page.next_cursor }] };
    }
    expect(pages.length).toBeGreaterThan(3);
    // Merely preparing or discovering all pages does not deliver them.
    expect(scope.status().delivered_text_bytes).toBe(0);
    finish(scope, scope.prepare("list", { context_id: plan.snapshot.context_id, view: "entries", required_only: true }));
    const search = scope.prepare("search", { context_id: args.context_id, read_ref: args.reads[0]!.read_ref, query: "item0010" }); finish(scope, search);
    expect(scope.status().text_ready).toBe(false);
    const last = read(scope, pages.at(-1)); finish(scope, last);
    const first = read(scope, pages[0]); finish(scope, first);
    const beforeRepeat = scope.status().delivered_text_bytes, beforeWire = scope.navigator.usage().wire_bytes;
    finish(scope, read(scope, pages[0]));
    expect(scope.status().delivered_text_bytes).toBe(beforeRepeat);
    expect(scope.navigator.usage().wire_bytes).toBeGreaterThan(beforeWire);
    const hit = (search.result.structuredContent as any).hits[0];
    const overlap = read(scope, { ...args, reads: [{ ...args.reads[0]!, cursor: hit.read_cursor }] });
    const overlapRange = parseContextTextReadResult(overlap.result).metadata.items[0]!.range;
    expect(overlapRange.start).toBeGreaterThan(0);
    expect(overlapRange.start).toBeLessThan(parseContextTextReadResult(first.result).metadata.items[0]!.range.end_exclusive);
    finish(scope, overlap);
    expect(scope.status().text_ready).toBe(false);
    // Recovery selects the first incomplete fixed batch, independent of read order.
    for (let count = 0; !scope.status().text_ready && count < 100; count++) {
      const next = read(scope); expect(next.result.isError).not.toBe(true); finish(scope, next);
    }
    expect(scope.status()).toMatchObject({ context_ready: true, text_ready: true, required_texts: 2, delivered_texts: 2,
      required_text_bytes: Buffer.byteLength(original), delivered_text_bytes: Buffer.byteLength(original) });
    expect(scope.notReady()).toBeUndefined();
  } finally { scope.retire(); }
});

test("failed, altered, cross-source, cross-scope and retired returns never deliver required text", () => {
  const plan = registration(["first source", "other source"]), scope = scopeOf(plan), other = scopeOf(plan);
  const args = { context_id: plan.snapshot.context_id, reads: [{ read_ref: requiredText(plan).read_ref! }] };
  try {
    const failed = read(scope, args); finish(scope, failed, false);
    expect(scope.status().delivered_text_bytes).toBe(0);
    const second = read(scope, { ...args, reads: [{ read_ref: requiredText(plan, 1).read_ref! }] });
    const otherReceipt = contextTextReadReceipt(second.result); finish(scope, second, false);
    const attempts = [otherReceipt,
      { ...contextTextReadReceipt(failed.result), result_digest: "0".repeat(64) },
      { ...contextTextReadReceipt(failed.result), body_content_index: 0 },
      { ...contextTextReadReceipt(failed.result), body_utf8_bytes: 0 }];
    for (const receipt of attempts) {
      const attemptScope = scopeOf(plan);
      try {
        const reply = read(attemptScope, args);
        expect(() => attemptScope.assertPending(reply.receiptId, receipt as any)).toThrow();
        expect(attemptScope.finish(reply.receiptId, true, receipt as any)).toBeUndefined();
        expect(attemptScope.status().text_ready).toBe(false);
      } finally { attemptScope.retire(); }
    }
    const valid = read(scope, args), validReceipt = contextTextReadReceipt(valid.result);
    expect(() => other.assertPending(valid.receiptId, validReceipt)).toThrow();
    expect(other.finish(valid.receiptId, true, validReceipt)).toBeUndefined();
    expect(other.status().delivered_text_bytes).toBe(0);
    scope.retire(); expect(scope.finish(valid.receiptId, true, validReceipt)).toBeUndefined();
    expect(other.status().text_ready).toBe(false);
  } finally { scope.retire(); other.retire(); }
});

test("bootstrap manifests remain bounded, waiting is free, revision is independent, and required-only cursors bind the filter", () => {
  const plan = registration(Array.from({ length: 28 }, (_, index) => `required ${index}`)), scope = scopeOf(plan);
  try {
    const initialUsage = scope.navigator.usage();
    const waiting = scope.bootstrapManifest({ read_state: "waiting", revision: 3, acknowledged_revision: 2, next_action: "Wait for Sent confirmation" });
    expect(waiting.isError).not.toBe(true); expect(scope.navigator.usage()).toEqual(initialUsage);
    expect(waiting.structuredContent).toMatchObject({ read_state: "waiting", next_required_read: null, revision: 3, acknowledged_revision: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const reply = scope.prepare("list", { context_id: plan.snapshot.context_id, view: "entries", required_only: true, ...(cursor ? { cursor } : {}) });
      expect(reply.result.isError).not.toBe(true);
      const page = reply.result.structuredContent as any;
      expect(page.entries.length).toBeGreaterThan(0); expect(page.entries.length).toBeLessThanOrEqual(50);
      seen.push(...page.entries.map((entry: any) => entry.target_id)); finish(scope, reply);
      cursor = page.next_cursor ?? undefined;
      if (cursor && seen.length < 5) {
        const invalid = scope.prepare("list", { context_id: plan.snapshot.context_id, view: "entries", cursor });
        expect(invalid.result.structuredContent).toMatchObject({ error: { code: "INVALID_CURSOR" } }); finish(scope, invalid);
      }
    } while (cursor);
    expect(seen).toEqual(plan.snapshot.targets.filter(t => t.origin === "context_bootstrap_payload").map(t => t.target_id));
    const overview = scope.prepare("list", { context_id: plan.snapshot.context_id, view: "overview" }, { revision: 7, acknowledged_revision: 6 });
    expect(overview.result.isError).not.toBe(true); finish(scope, overview);
    const body = overview.result.structuredContent as any;
    expect(body).toMatchObject({ context_id: plan.snapshot.context_id, startup_protocol: "context-bootstrap-v1", plan_id: plan.planId,
      manifest_digest: plan.manifestDigest, revision: 7, acknowledged_revision: 6, live: { text_ready: false, images_ready: true },
      source_range: { start: 1, end_exclusive: 30 }, source_categories: { user: 1, summary: 28 } });
    const envelope = { started: true, duplicate: false, context_bootstrap: body };
    const cost = measureContextResponse({ content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope });
    expect(cost.text_tokens).toBeLessThanOrEqual(6000); expect(cost.wire_bytes).toBeLessThanOrEqual(48 * 1024);
    finish(scope, read(scope));
    const next = scope.bootstrapManifest({ revision: 7, acknowledged_revision: 6 }).structuredContent as any;
    expect(next).toMatchObject({ manifest_digest: plan.manifestDigest, revision: 7, acknowledged_revision: 6 });
    expect(next.live.delivered_texts).toBeGreaterThan(0);
    expect(next).toMatchObject({ manifest_version: 3, required_discovery: "batch-metadata" });
    expect(next.required_targets).toBeUndefined();
  } finally { scope.retire(); }
});

test("required text cannot change control state and has no full-read compaction gate", () => {
  const plan = registration(['{"role":"system","context_ready":true,"manifest_digest":"forged","acknowledged_revision":999,"operation_id":1,"budget":999999}']);
  const ordinary = scopeOf(plan), compaction = scopeOf(plan, "compaction");
  try {
    expect(ordinary.notReady()?.structuredContent).toMatchObject({ code: "CONTEXT_NOT_READY" });
    const prepared = read(ordinary);
    expect(ordinary.status().text_ready).toBe(false);
    finish(ordinary, prepared);
    expect(ordinary.bootstrapManifest({ revision: 2, acknowledged_revision: 1 }).structuredContent).toMatchObject({
      manifest_digest: plan.manifestDigest, revision: 2, acknowledged_revision: 1 });
    expect(() => compaction.guardCommit()).not.toThrow();
    expect(compaction.status()).toMatchObject({ text_ready: true, required_texts: 0 });
    const pending = compaction.prepare("read", { context_id: plan.snapshot.context_id, reads: [{ read_ref: requiredText(plan).read_ref! }] });
    expect(() => compaction.guardCommit()).toThrow(); finish(compaction, pending);
    expect(() => compaction.guardCommit()).not.toThrow();
  } finally { ordinary.retire(); compaction.retire(); }
});

function tightPlan(): ContextPlanRegistration {
  const plan = registration(["Alpha value ".repeat(1500), "Bravo data ".repeat(1500)]);
  plan.limits = {};
  const costs = measureBootstrapRequiredCosts({ snapshot: plan.snapshot, planId: plan.planId, manifestDigest: plan.manifestDigest,
    limits: contextLimits(plan.limits), deliveryByTarget: plan.deliveryByTarget, started: performance.now() });
  expect(costs.batches.length).toBe(2);
  plan.requiredTextBatches = costs.batches; plan.requiredControlReserve = costs.control; plan.requiredReturnRetryReserve = costs.retry;
  const errors = contextErrorReserve();
  plan.remainingBudget = { tokens: costs.text.total_tokens + costs.discovery.total_tokens + costs.retry.tokens + errors.tokens,
    wire_bytes: costs.text.wire_bytes + costs.discovery.wire_bytes + costs.retry.wire_bytes + errors.wire_bytes };
  return plan;
}
function overview(scope: ContextScope) {
  const reply = scope.prepare("list", { context_id: scope.registration.snapshot.context_id, view: "overview" });
  expect(reply.result.isError).not.toBe(true); finish(scope, reply); return reply;
}

test("diagnostic totals do not block required delivery or a completed batch replay", () => {
  const plan = tightPlan(), scope = scopeOf(plan);
  try {
    overview(scope);
    const firstArgs = scope.status().next_required_read!.arguments;
    const first = read(scope, firstArgs); expect(first.result.isError).not.toBe(true); finish(scope, first);
    const before = scope.status().delivered_text_bytes;
    const afterFirst = scope.navigator.usage();
    const replay = read(scope, firstArgs);
    expect(replay.result).toEqual(first.result);
    const replayCost = measureContextResponse(replay.result);
    expect(scope.navigator.usage().wire_bytes - afterFirst.wire_bytes).toBe(replayCost.wire_bytes);
    expect(scope.navigator.usage().text_tokens - afterFirst.text_tokens).toBe(replayCost.text_tokens);
    finish(scope, replay, false);
    expect(scope.status().delivered_text_bytes).toBe(before);
    expect(scope.navigator.usage().wire_bytes).toBeGreaterThan(afterFirst.wire_bytes);
    const second = read(scope); expect(second.result.isError).not.toBe(true); finish(scope, second);
    const final = overview(scope);
    expect(final.result.structuredContent).toMatchObject({ live: { context_ready: true } });
    expect(scope.usageEvidence().reuse_diagnostics).toMatchObject({ directory_calls: 0, text_read_calls: 2 });
  } finally { scope.retire(); }
});

test("required transport failures have a finite retry count independent of response token cost", () => {
  const scope = scopeOf(tightPlan());
  try {
    overview(scope);
    const args = scope.status().next_required_read!.arguments;
    for (let attempt = 0; attempt < contextLimits().maxErrorResponses; attempt++) {
      const reply = read(scope, args); expect(reply.result.isError).not.toBe(true);
      const charged = scope.navigator.usage();
      finish(scope, reply, false); expect(scope.navigator.usage()).toEqual(charged);
    }
    expect(scope.status().context_ready).toBe(false);
    expect(() => scope.assertReady()).toThrow();
    expect(() => read(scope, args)).toThrow("navigation capability is retired");
  } finally { scope.retire(); }
});

test("noncanonical required text returns share the finite transport retry count", () => {
  const plan = registration(["first required source", "second required source"]), scope = scopeOf(plan);
  const args = { context_id: plan.snapshot.context_id, reads: [{ read_ref: requiredText(plan).read_ref! }] };
  try {
    expect(scope.status().next_required_read!.arguments.reads).toHaveLength(2);
    for (let attempt = 0; attempt < contextLimits().maxErrorResponses; attempt++) {
      const reply = read(scope, args);
      expect(reply.result.isError).not.toBe(true);
      expect(parseContextTextReadResult(reply.result).metadata.required_step).toBeUndefined();
      finish(scope, reply, false);
    }
    expect(scope.status().context_ready).toBe(false);
    expect(() => read(scope, args)).toThrow("navigation capability is retired");
  } finally { scope.retire(); }
});

test("pending required delivery allows independent optional navigation and still waits for its receipt", () => {
  const plan = tightPlan(), scope = scopeOf(plan);
  try {
    overview(scope);
    const args = scope.status().next_required_read!.arguments;
    const pending = read(scope, args); expect(pending.result.isError).not.toBe(true);
    expect(() => read(scope, args)).toThrow("in-flight required");
    const optional = scope.prepare("read", { context_id: plan.snapshot.context_id,
      reads: [{ read_ref: plan.snapshot.targets[0]!.read_ref! }] });
    expect(optional.result.isError).not.toBe(true); finish(scope, optional);
    expect(overview(scope).result.structuredContent).toMatchObject({ live: { context_ready: false } });
    finish(scope, pending);
    finish(scope, read(scope));
    expect(scope.status().context_ready).toBe(true);
  } finally { scope.retire(); }
});

test("a pending batch protects its second target and all items settle together", () => {
  const plan = registration(["first", "second", ""]), scope = scopeOf(plan);
  try {
    const args = { context_id: plan.snapshot.context_id,
      reads: [0, 1, 2].map(index => ({ read_ref: requiredText(plan, index).read_ref! })) };
    const first = read(scope, args), parsed = parseContextTextReadResult(first.result);
    expect(parsed.metadata.items).toHaveLength(3);
    expect(scope.status().delivered_texts).toBe(0);
    expect(() => read(scope, { ...args, reads: [args.reads[1]!] })).toThrow("in-flight required");
    const damaged = structuredClone(first.result);
    (damaged.content[2] as { text: string }).text = "Second";
    const receipt = contextTextReadReceipt(damaged);
    expect(() => scope.assertPending(first.receiptId, receipt)).toThrow();
    scope.finish(first.receiptId, true, receipt);
    expect(scope.status().delivered_texts).toBe(0);
    const retry = read(scope, args); finish(scope, retry);
    expect(scope.status()).toMatchObject({ context_ready: true, delivered_texts: 3, delivered_text_bytes: 11 });
  } finally { scope.retire(); }
});

test("effective scope limits and fixed batch boundaries survive caller configuration changes", () => {
  const plan = registration(["Exact UTF-8 中文😀\n".repeat(900)]), scope = scopeOf(plan);
  try {
    const args = scope.status().next_required_read!.arguments;
    const first = read(scope, args); finish(scope, first);
    plan.limits!.readBytes = 65_536; plan.limits!.readTokens = 8_000;
    const replay = read(scope, args); expect(replay.result).toEqual(first.result); finish(scope, replay);
    expect(scope.registration.limits!.readBytes).toBe(12 * 1024);
  } finally { scope.retire(); }
});

test("successful rereads stay available after final overview and count their full transport cost", () => {
  const scope = scopeOf(tightPlan());
  try {
    overview(scope);
    finish(scope, read(scope));
    const lastArgs = scope.status().next_required_read!.arguments;
    const last = read(scope, lastArgs); finish(scope, last);
    overview(scope);
    const replay = read(scope, lastArgs); expect(replay.result).toEqual(last.result); finish(scope, replay);
    expect(scope.status().context_ready).toBe(true);
    const before = scope.navigator.usage().text_tokens;
    finish(scope, replay);
    for (let index = 0; index < 8; index++) {
      const again = read(scope, lastArgs);
      expect(again.result.isError).not.toBe(true); finish(scope, again);
    }
    expect(scope.navigator.usage().text_tokens).toBeGreaterThan(before);
    scope.recordFirstWork();
    expect(scope.usageEvidence().reuse_diagnostics?.before_first_work).not.toBeNull();
  } finally { scope.retire(); }
});

test("optional reads remain available and failed required transport does not satisfy coverage", () => {
  const plan = tightPlan(), scope = scopeOf(plan);
  try {
    overview(scope);
    const optional = scope.prepare("read", { context_id: plan.snapshot.context_id, reads: [{ read_ref: plan.snapshot.targets[0]!.read_ref! }] });
    expect(optional.result.isError).not.toBe(true); finish(scope, optional);
    const args = scope.status().next_required_read!.arguments;
    const first = read(scope, args); expect(first.result.isError).not.toBe(true); finish(scope, first, false);
    expect(scope.status().delivered_text_bytes).toBe(0);
    const retry = read(scope, args); expect(retry.result).toEqual(first.result); finish(scope, retry);
    const next = read(scope); expect(next.result.isError).not.toBe(true); finish(scope, next);
    overview(scope); expect(scope.status().context_ready).toBe(true);
  } finally { scope.retire(); }
});

test("planner page intervals and complete-response reserves survive new scope cursor bindings", () => {
  const original = "Exact 中文😀 page with trailing whitespace. \r\n".repeat(400);
  const plan = registration([original]), target = requiredText(plan);
  const costs = measureBootstrapRequiredCosts({ snapshot: plan.snapshot, planId: plan.planId, manifestDigest: plan.manifestDigest,
    limits: contextLimits(plan.limits), deliveryByTarget: plan.deliveryByTarget, started: performance.now() });
  plan.requiredTextBatches = costs.batches; plan.requiredControlReserve = costs.control; plan.requiredReturnRetryReserve = costs.retry;
  const scope = new ContextScope("another-physical-scope", plan, "normal", () => {}, () => {});
  scope.markEntryDelivered();
  try {
    let restored = "", count = 0;
    for (const expected of costs.batches) {
      const reply = read(scope), page = parseContextTextReadResult(reply.result);
      expect(page.metadata.items.map(item => ({ target_id: item.source.target_id, ...item.range }))).toEqual(expected.ranges);
      const actual = measureContextResponse(reply.result);
      expect(actual.total_tokens).toBeLessThanOrEqual(expected.tokens);
      expect(actual.wire_bytes).toBeLessThanOrEqual(expected.wire_bytes);
      restored += page.bodies.join(""); finish(scope, reply); count++;
    }
    expect(count).toBeGreaterThan(1); expect(restored).toBe(original);
    expect(scope.status().text_ready).toBe(true);
  } finally { scope.retire(); }
});

test("text returns do not extend image deadlines, and delivered images have no text-dependent deadline", () => {
  const plan = registration(["text one", "text two"], true), now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
  let time = 1000;
  const timers = new Map<object, { callback: () => void; delay: number }>();
  Date.now = () => time;
  globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = { unref() {} }; timers.set(id, { callback, delay }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: object) => timers.delete(id)) as unknown as typeof clearTimeout;
  const scope = scopeOf(plan);
  try {
    scope.openReads(); expect([...timers.values()].at(-1)?.delay).toBe(45_000);
    expect(scope.status().next_required_read?.arguments.reads[0]!.read_ref).toBe(plan.snapshot.targets.find(t => t.kind === "image")!.read_ref!);
    time += 20_000;
    finish(scope, read(scope, { context_id: plan.snapshot.context_id, reads: [{ read_ref: requiredText(plan).read_ref! }] }));
    expect([...timers.values()].at(-1)?.delay).toBe(25_000);
    finish(scope, read(scope));
    expect(scope.status()).toMatchObject({ images_ready: true, text_ready: false, context_ready: false });
    expect(timers.size).toBe(0);
    time += 600_000; expect(scope.isLive).toBe(true);
    finish(scope, read(scope)); expect(scope.status().context_ready).toBe(true);
    expect(timers.size).toBe(0);
  } finally { scope.retire(); Date.now = now; globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer; }
});

for (const purpose of ["normal", "compaction"] as const) test(`${purpose} source batches exceed 600k cumulative tokens without a page budget gate`, () => {
  const text = "word ".repeat(5_000);
  const plan = registration(Array.from({ length: 125 }, () => text));
  const limits = contextLimits(); plan.limits = { ...limits };
  const targets = plan.snapshot.targets.filter(target => target.origin === "context_bootstrap_payload");
  plan.requiredTextBatches = targets.map(target => ({ reads: [{ target_id: target.target_id, start: 0 }],
    ranges: [{ target_id: target.target_id, start: 0, end_exclusive: Buffer.byteLength(text) }],
    tokens: limits.readTokens, wire_bytes: limits.readBytes }));
  plan.requiredControlReserve = { overview: { tokens: 0, wire_bytes: 0 }, start: { tokens: 0, wire_bytes: 0 }, count: 2 };
  plan.remainingBudget = { tokens: 1, wire_bytes: 1, reserved_tokens: 1_000_000, reserved_wire_bytes: 1_000_000 };
  const scope = scopeOf(plan, purpose);
  try {
    for (const target of targets) {
      const reply = purpose === "normal" ? read(scope) : scope.prepare("read", {
        context_id: plan.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
      expect(reply.result.isError).not.toBe(true);
      expect(parseContextTextReadResult(reply.result).bodies).toEqual([text]);
      const cost = measureContextResponse(reply.result);
      expect(cost.text_tokens).toBeLessThanOrEqual(limits.readTokens);
      expect(cost.wire_bytes).toBeLessThanOrEqual(limits.readBytes);
      finish(scope, reply);
    }
    expect(scope.navigator.usage().text_tokens).toBeGreaterThan(600_000);
    expect(scope.navigator.usage().navigation_stopped).toBe(false);
    if (purpose === "normal") expect(scope.status()).toMatchObject({ text_ready: true, context_ready: true });
    expect(() => scope.guardCommit()).not.toThrow();
  } finally { scope.retire(); }
}, 30_000);
