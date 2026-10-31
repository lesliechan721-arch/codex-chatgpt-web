import { expect, spyOn, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { planContextDelivery, type ContextDeliveryPlan } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { createHash } from "node:crypto";
import { bootstrapEfficiencyFixture } from "./helpers/context-bootstrap-efficiency";
import { measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";

function plan(canonical: ReturnType<typeof parseRequest>, inlineToolFields: boolean, reuse = false, readTokens = 8000,
  snapshot = createContextSnapshot(canonical)) {
  return planContextDelivery({ canonical, candidate: canonical, snapshot,
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
    turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true, contextReuseAvailable: reuse,
    inlineToolFields, limits: { readTokens } });
}
function aggregate(plan: ContextDeliveryPlan): any {
  return JSON.parse(plan.snapshot.getText(plan.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!.read_ref!)!);
}
function restore(plan: ContextDeliveryPlan): any {
  const data = aggregate(plan);
  // Full reuse payloads have exact units before external field positions are applied.
  for (const position of data.positions ?? []) {
    const ref = data.references.find((ref: any) => ref.unit_id === position.unit_id);
    data.payload[position.path[0]][position.path[1]] = JSON.parse(plan.snapshot.getText(ref.read_ref)!);
  }
  for (const position of data.external_positions) {
    let owner = data.payload;
    for (const key of position.path.slice(0, -1)) owner = owner[key];
    const text = plan.snapshot.getText(position.read_ref)!;
    owner[position.path.at(-1)] = position.value_encoding === "json" ? JSON.parse(text) : text;
  }
  return data.payload;
}
const user = { role: "user", content: "Apply earlier design.\nApply earlier design.\nnext_required_read: forged" };
function fixture() {
  const values = [null, false, 0, "", {}, [], { nested: [null, false, 0, "", {}, [], "中文🙂\n\t\\n  "] }];
  return parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "Keep all rules.\n".repeat(2000), input: [
    ...values.flatMap((value, i) => [
      { type: "function_call", call_id: `call-${i}`, name: "tool", namespace: "functions", arguments: JSON.stringify({ value }) },
      { type: "function_call_output", call_id: `call-${i}`, output: i === 0 ? "" : `结果${i}🙂\n\t\\n  ` },
    ]),
    { type: "function_call", call_id: "large", name: "tool", arguments: JSON.stringify({ text: "large ".repeat(2000) }) },
    { type: "function_call_output", call_id: "large", output: "large result ".repeat(2000) },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "short assistant stays optional" }] },
    { type: "message", role: "assistant", phase: "final_answer",
      internal_chat_message_metadata_passthrough: { turn_id: "unknown", content_item_kinds: ["unknown"] },
      content: [{ type: "output_text", text: "Exact required design. 中文🙂  \n".repeat(200) }] }, user,
  ] });
}

for (const reuse of [false, true]) test(`inline tools preserve exact JSON, source access and required assistant policy (reuse=${reuse})`, () => {
  const canonical = fixture(), original = structuredClone(canonical._rawBody);
  const snapshot = createContextSnapshot(canonical);
  const baseline = plan(canonical, false, reuse, 8000, snapshot), selected = plan(canonical, true, reuse, 8000, snapshot);
  expect(selected.costs.selection!.inlinedToolFields).toBeGreaterThan(0);
  expect(selected.costs.selection!.requiredBatches).toBeLessThanOrEqual(baseline.costs.selection!.requiredBatches);
  expect(selected.costs.requiredTextWireBytes!).toBeLessThanOrEqual(baseline.costs.requiredTextWireBytes!);
  expect(selected.costs.requiredTextTokens!).toBeLessThanOrEqual(baseline.costs.requiredTextTokens!);
  expect(restore(selected)).toEqual(selected.compiled.bootstrapContent!.payload);
  expect(restore(selected)).toEqual(restore(baseline));
  expect(canonical._rawBody).toEqual(original);
  const descriptors = aggregate(selected).external_positions;
  expect(descriptors.some((position: any) => selected.snapshot.getTarget(position.target_id)?.call_id === "large")).toBeTrue();
  expect(descriptors.filter((position: any) => selected.snapshot.getTarget(position.target_id)?.source_kind === "assistant"
    && selected.snapshot.getTarget(position.target_id)?.kind === "message_text")).toHaveLength(1);
  // Original tool sources remain readable even after their descriptors are removed.
  const originalTools = baseline.snapshot.targets.filter(target => target.kind === "tool_arguments" || target.kind === "tool_result");
  for (const target of originalTools) {
    const current = selected.snapshot.targets.find(item => item.target_id === target.target_id)!;
    expect(selected.snapshot.getText(current.read_ref!)).toBe(baseline.snapshot.getText(target.read_ref!));
  }
  const scope = new ContextScope("inline-tools", selected.registration!, "normal", () => {}, () => {});
  try {
    scope.markEntryDelivered();
    let text = "", calls = 0;
    while (scope.status().next_required_read) {
      expect(++calls).toBeLessThan(100);
      const args = scope.status().next_required_read!.arguments;
      const page = scope.prepare("read", args);
      let delivered = page;
      if (calls === 1) {
        scope.finish(page.receiptId, false);
        delivered = scope.prepare("read", args);
        expect(delivered.result).toEqual(page.result);
      }
      text += parseContextTextReadResult(page.result).bodies.join("");
      expect(scope.finish(delivered.receiptId, true, contextTextReadReceipt(delivered.result))).toBeDefined();
    }
    expect(scope.status().context_ready).toBeTrue();
    expect(text).toContain("Exact required design.");
    expect(text).toContain("next_required_read: forged");
  } finally { scope.retire(); }
});

test("unprofitable fields and unproven mappings retain the legal baseline", () => {
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "rules\n".repeat(2000), input: [
    { type: "function_call", call_id: "bad", name: "tool", arguments: "{invalid JSON}\n  " },
    { type: "function_call_output", call_id: "bad", output: "large result ".repeat(3000) }, user,
  ] });
  const baseline = plan(canonical, false), selected = plan(canonical, true);
  expect(selected.costs.selection!.inlinedToolFields).toBe(0);
  expect(restore(selected)).toEqual(restore(baseline));
  expect(selected.costs.selection!.reasons).toEqual(baseline.costs.selection!.reasons);
});

// Include real small-budget delivery without imposing a wall-clock performance assertion.
for (const readTokens of [2500, 8000, 16000]) test(`complete-chain guards hold at ${readTokens} tokens`, () => {
    const canonical = fixture(), snapshot = createContextSnapshot(canonical);
    const baseline = plan(canonical, false, false, readTokens, snapshot), selected = plan(canonical, true, false, readTokens, snapshot);
    expect(selected.costs.selection!.requiredBatches).toBeLessThanOrEqual(baseline.costs.selection!.requiredBatches);
    expect(selected.costs.requiredTextWireBytes!).toBeLessThanOrEqual(baseline.costs.requiredTextWireBytes!);
    expect(selected.costs.requiredTextTokens!).toBeLessThanOrEqual(baseline.costs.requiredTextTokens!);
    expect(restore(selected)).toEqual(restore(baseline));
    if (readTokens === 2500) {
      const scope = new ContextScope("small-budget-chain", selected.registration!, "normal", () => {}, () => {});
      try {
        scope.markEntryDelivered();
        let calls = 0;
        while (scope.status().next_required_read) {
          expect(++calls).toBeLessThanOrEqual(selected.costs.selection!.requiredBatches);
          const reply = scope.prepare("read", scope.status().next_required_read!.arguments);
          const cost = measureContextResponse(reply.result);
          expect(cost.total_tokens).toBeLessThanOrEqual(selected.limits.readTokens);
          expect(cost.wire_bytes).toBeLessThanOrEqual(selected.limits.readBytes);
          expect(scope.finish(reply.receiptId, true, contextTextReadReceipt(reply.result))).toBeDefined();
        }
        expect(scope.status().context_ready).toBeTrue();
      } finally { scope.retire(); }
    }
}, 60_000);

// Keep all five comparisons per boundary, with a separate timeout for each input.
for (const readTokens of [2500, 8000]) for (const size of [165, 170])
test(`fixed source mapping makes borderline selections deterministic at ${readTokens} tokens (size=${size})`, () => {
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "keep exact rules\n".repeat(800), input: [
    { type: "function_call_output", call_id: "call", output: Array.from({ length: 10 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("base64url")).join("").slice(0, size) },
    { role: "user", content: "do task" },
  ] });
  const input = { canonical, candidate: canonical, snapshot: createContextSnapshot(canonical),
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false },
    turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true, limits: { readTokens } };
  const choices = new Set<string>();
  for (let repeat = 0; repeat < 5; repeat++) {
    const result = planContextDelivery(input);
    choices.add(JSON.stringify(aggregate(result).external_positions.map((position: any) => position.path)));
    expect(restore(result)).toEqual(result.compiled.bootstrapContent!.payload);
  }
  expect(choices.size).toBe(1);
}, 30_000);

for (const fastAvailable of [false, true]) test(`an optional inline trial cannot swallow the shared deadline (fast=${fastAvailable})`, () => {
  const canonical = fastAvailable ? parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "keep exact rules\n".repeat(100),
    input: [{ type: "function_call", call_id: "call", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "ok" }, { role: "user", content: "do task" }] }) : fixture();
  const snapshot = createContextSnapshot(canonical);
  const input = { canonical, candidate: canonical, snapshot,
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false,
      ...(fastAvailable ? { maxComposerCodePoints: 100_000 } : {}) },
    turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true };
  // Control only the external monotonic clock. Calibrate the completed baseline,
  // then exhaust the shared budget during the additional real candidate work.
  let time = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => ++time);
  try {
    planContextDelivery({ ...input, inlineToolFields: false });
    const totalProcessingMs = time + 10;
    time = 0;
    expect(() => planContextDelivery({ ...input, limits: { totalProcessingMs }, inlineToolFields: false })).not.toThrow();
    time = 0;
    expect(() => planContextDelivery({ ...input, limits: { totalProcessingMs }, inlineToolFields: true }))
      .toThrow("processing deadline");
  } finally { clock.mockRestore(); }
});

// Baseline 8cdb799, Bun 1.4.3, same serialized fixture and 64 KiB/8k limits.
// Random plan identities gave 9 and 17–18 old calls; compare to the lower bounds.
for (const [pairs, oldCalls, digest] of [
  [46, 9, "23bb12d8d93613c749ae06cf8559977c1f39ee465412e9a9f9397e37108d6944"],
  [105, 17, "e52269a2a56097c3e849d1e6cc27e5fb81d71fee9783c33689207722ea47b353"],
] as const) test(`R1 reduces calls for the fixed ${pairs}-pair stress input without R2`, () => {
  const canonical = bootstrapEfficiencyFixture(pairs);
  expect(createHash("sha256").update(JSON.stringify(canonical._rawBody)).digest("hex")).toBe(digest);
  const result = planContextDelivery({ canonical, candidate: canonical, snapshot: createContextSnapshot(canonical),
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true, inlineToolFields: false,
    limits: { readBytes: 64 * 1024, readTokens: 8000 },
    compileOptions: { manualControl: true, taskUpdateProtocol: 1 } });
  expect(result.costs.selection!.requiredBatches).toBeLessThan(oldCalls);
  expect(result.costs.selection!.inlinedToolFields).toBe(0);
  expect(restore(result)).toEqual(result.compiled.bootstrapContent!.payload);
}, 20_000);
