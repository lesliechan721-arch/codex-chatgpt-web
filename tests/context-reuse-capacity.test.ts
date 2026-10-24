import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { planContextDelivery, type ContextDeliveryPlan } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { boundedContextReuse, contextReuseBaseline, contextReuseMatches } from "../src/adapters/chatgpt-web/context-reuse-lifecycle";
import { CONTEXT_REUSE_MAX_BYTES, CONTEXT_REUSE_MAX_UNITS, type ContextReuseBaseline } from "../src/adapters/chatgpt-web/context-reuse-types";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";

function request(manual: boolean, instructions: string | null = "Current producer rule") {
  return parseRequest({ model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : CHATGPT_WEB_MODEL_ID,
    reasoning: { effort: "high" }, instructions, input: [
      ...Array.from({ length: 130 }, (_, index) => ({ type: "message", id: `rule-${index}`, role: "developer", content: `Exact rule ${index}🙂  \n` })),
      { type: "message", id: "current-user", role: "user", content: "Continue current work.  \n" },
    ] });
}

function plan(manual: boolean, inline: boolean, baseline?: ContextReuseBaseline, instructions?: string | null, retainedTokens = 0) {
  const parsed = request(manual, instructions);
  return planContextDelivery({ canonical: parsed, candidate: parsed, snapshot: createContextSnapshot(parsed),
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: manual,
      maxComposerCodePoints: inline ? 500_000 : 8000 }, turnToken: `turn_${"7".repeat(32)}`,
    contextToolsAvailable: true, contextBootstrapAvailable: true, contextReuseAvailable: true, reuseBaseline: baseline,
    compileOptions: manual ? { manualControl: true } : {},
    // Historical page estimates do not limit delivery of these bounded units.
    budget: { retainedTokens, ...(!inline ? { contextWindowTokens: 1_000_000 } : {}) },
  });
}

function deliver(result: ContextDeliveryPlan, baseline?: ContextReuseBaseline) {
  const scope = new ContextScope("capacity-scope", result.registration!, "normal", () => {}, () => {}, undefined,
    () => !result.registration!.reuse!.dependency || contextReuseMatches(baseline, result.registration!.reuse!.dependency!)
      ? { ready: true } : { ready: false, failure: "baseline_invalid" });
  const current = new Map<string, string>();
  try {
    expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
    scope.markEntryDelivered();
    let next = scope.status().next_required_read;
    for (let count = 0; next; count++) {
      if (count > 2000) throw Error("Required sources did not complete");
      const page = scope.prepare("read", next.arguments);
      const parsed = parseContextTextReadResult(page.result);
      for (const [index, item] of parsed.metadata.items.entries()) {
        const previous = current.get(item.read_ref) ?? "";
        expect(item.range.start).toBe(Buffer.byteLength(previous));
        current.set(item.read_ref, previous + parsed.bodies[index]!);
      }
      expect(parsed.metadata.required_step).toBeDefined();
      next = parsed.metadata.required_step!.next_required_read;
      scope.finish(page.receiptId, true, contextTextReadReceipt(page.result));
    }
    const final = scope.prepare("list", { context_id: result.snapshot.context_id, view: "overview" });
    expect(final.result.structuredContent).toMatchObject({ live: { context_ready: true } });
    scope.finish(final.receiptId, true);
    for (const [readRef, text] of current) expect(text).toBe(result.snapshot.getText(readRef)!);
    expect(scope.status()).toMatchObject({ context_ready: true, text_ready: true, reuse_ready: true });
    const evidence = scope.usageEvidence().reuse_delivery;
    expect(evidence).toBeDefined();
    expect(boundedContextReuse(evidence!)).toBeTrue();
    const inline = result.compiled.text.match(/<codex_inline_context_json>\n```json\n([\s\S]*?)\n```\n<\/codex_inline_context_json>/)?.[1];
    const aggregate = result.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!;
    const payload = JSON.parse(inline ?? current.get(aggregate.read_ref!)!);
    const units = new Map<string, string>(payload.inline_units?.map((unit: any) => [unit.unit_id, unit.body]) ?? []);
    for (const reference of payload.references) if (reference.delivery !== "reuse" && !units.has(reference.unit_id)) {
      expect(current.has(reference.read_ref)).toBeTrue();
      units.set(reference.unit_id, current.get(reference.read_ref)!);
    }
    return { evidence: evidence!, payload, units };
  } finally { scope.retire(); }
}

function reconstruct(delivered: ReturnType<typeof deliver>, previous = new Map<string, string>()) {
  const payload = structuredClone(delivered.payload.payload);
  for (const position of delivered.payload.positions) {
    const reference = delivered.payload.references.find((unit: any) => unit.unit_id === position.unit_id);
    const body = (reference.delivery === "reuse" ? previous : delivered.units).get(position.unit_id);
    expect(body).toBeDefined();
    payload[position.path[0]][position.path[1]] = JSON.parse(body!);
  }
  return payload;
}

// Paged cases plan and deliver three complete scopes; allow headroom on Intel CI.
for (const [manual, inline] of [[false, false], [true, false]] as const) {
  test(`capacity fallback preserves real delivery, bounded evidence and the next scope: manual=${manual} inline=${inline}`, () => {
    const first = plan(manual, inline);
    const delivered = deliver(first);
    expect(reconstruct(delivered)).toEqual(first.compiled.bootstrapContent!.payload);
    const baseline = contextReuseBaseline(delivered.evidence, "a".repeat(64), "b".repeat(256));
    expect(baseline).toBeDefined();
    expect(boundedContextReuse(baseline!)).toBeTrue();
    const retainedTokens = first.costs.requiredTotalTokens - first.costs.workReserveTokens;
    const next = plan(manual, inline, baseline, undefined, retainedTokens);
    expect(next.costs.retainedTokens).toBe(retainedTokens);
    expect(next.registration!.reuse!.mode).toBe("incremental");
    expect(next.registration!.reuse!.units.length).toBeLessThanOrEqual(CONTEXT_REUSE_MAX_UNITS);
    expect(Buffer.byteLength(JSON.stringify(next.registration!.reuse))).toBeLessThanOrEqual(CONTEXT_REUSE_MAX_BYTES);
    expect(next.costs.reuse!.missReasons.cache_capacity).toBeGreaterThan(0);
    const nextDelivered = deliver(next, baseline);
    expect(reconstruct(nextDelivered, delivered.units)).toEqual(next.compiled.bootstrapContent!.payload);
    expect(contextReuseBaseline(nextDelivered.evidence, "a".repeat(64), "c".repeat(256))).toBeDefined();
    const removed = plan(manual, inline, baseline, null, retainedTokens);
    const removal = deliver(removed, baseline);
    expect(removal.payload.rule_replacements).toContainEqual({ domain: "responses.instructions/current/v1", state: "null",
      unit_ids: [], replaces: baseline!.snapshots[0]!.unit_ids });
    expect(reconstruct(removal, delivered.units)).toEqual(removed.compiled.bootstrapContent!.payload);
  }, inline ? 30_000 : 60_000);
}

// A reusable candidate is optional: its complete metadata can cost more than short rules.
test("many short rules remain inline when reuse metadata has no full-cost benefit", () => {
  const result = plan(false, true);
  expect(result.navigationEnabled).toBeFalse();
  expect(result.registration).toBeUndefined();
  expect(result.projected.context.messages).toHaveLength(131);
  expect(result.compiled.text).toContain("Exact rule 129");
});
