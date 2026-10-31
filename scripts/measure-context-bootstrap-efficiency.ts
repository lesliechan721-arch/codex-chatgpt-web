import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { bootstrapEfficiencyFixture } from "../tests/helpers/context-bootstrap-efficiency";
import { parseRequest } from "../src/responses/parser";
import { CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { planContextDelivery } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import type { ContextRequiredTextBatch } from "../src/adapters/chatgpt-web/context-types";

// Offline only. An optional private rollout stays at its original path and is never printed.
const path = process.argv.find(arg => arg.startsWith("--rollout="))?.slice(10);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const samples = path ? (() => {
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), "c8f1711f9c9d7383e91a1a8e5c27a47eb5d3b70c541baca39efe6bedc7eb024b", "Spec rollout hash");
  const lines = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  return [299, 597].map(end => ({ name: `rollout-lines-1-${end}`, shape: "rollout response_item reconstruction; NOT HTTP",
    canonical: parseRequest({ model: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, reasoning: { effort: "low" },
      instructions: lines.find(line => line.type === "session_meta").payload.base_instructions.text,
      input: lines.slice(0, end).filter(line => line.type === "response_item").map(line => line.payload) }) }));
})() : ([46, 105] as const).map(pairs => ({ name: `synthetic-${pairs}-pairs`, shape: "fixed synthetic parser input; NOT HTTP",
  canonical: bootstrapEfficiencyFixture(pairs) }));
const rows = [];
for (const sample of samples) for (const readTokens of [8000, 16000]) {
  const started = performance.now();
  const plan = planContextDelivery({ canonical: sample.canonical, candidate: sample.canonical,
    snapshot: createContextSnapshot(sample.canonical), capabilities: { localToolsEnabled: true, solAvailable: true,
      extraHighAvailable: true, proAvailable: true }, turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true,
    compileOptions: { manualControl: true, taskUpdateProtocol: 1 }, limits: { readTokens },
    inlineToolFields: !process.argv.includes("--no-inline-tools") });
  assert(plan.registration);
  const scope = new ContextScope("efficiency-offline", plan.registration, "normal", () => {}, () => {});
  let calls = 0, wire = 0, tokens = 0, maxWire = 0, maxTokens = 0;
  const restored = new Map<string, string>();
  try {
    scope.markEntryDelivered();
    while (scope.status().next_required_read) {
      assert(calls < 1000, "finite required chain");
      const reply = scope.prepare("read", scope.status().next_required_read!.arguments);
      assert(!reply.result.isError);
      const page = parseContextTextReadResult(reply.result);
      const cost = measureContextResponse(reply.result, { ...plan.limits, boundCursorTokens: true });
      const fixed: ContextRequiredTextBatch = plan.registration.requiredTextBatches![calls]!;
      assert(cost.wire_bytes <= fixed.wire_bytes && cost.total_tokens <= fixed.tokens);
      assert(cost.wire_bytes <= plan.limits.readBytes && cost.total_tokens <= readTokens);
      for (const [index, item] of page.metadata.items.entries()) {
        const previous = restored.get(item.read_ref) ?? "";
        assert.equal(item.range.start, Buffer.byteLength(previous));
        const body = page.bodies[index]!;
        assert.equal(body, Buffer.from(plan.snapshot.getText(item.read_ref)!).subarray(item.range.start, item.range.end_exclusive).toString("utf8"));
        restored.set(item.read_ref, previous + body);
      }
      assert(scope.finish(reply.receiptId, true, contextTextReadReceipt(reply.result)));
      calls++; wire += cost.wire_bytes; tokens += cost.total_tokens;
      maxWire = Math.max(maxWire, cost.wire_bytes); maxTokens = Math.max(maxTokens, cost.total_tokens);
    }
    const overview = scope.prepare("list", { context_id: plan.snapshot.context_id, view: "overview" });
    assert(!overview.result.isError); scope.finish(overview.receiptId, true);
    assert(scope.status().context_ready);
    for (const target of plan.snapshot.targets.filter(target => plan.registration!.deliveryByTarget[target.target_id]?.required)) {
      assert.equal(restored.get(target.read_ref!), plan.snapshot.getText(target.read_ref!));
    }
    const payloadTarget = plan.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!;
    const payload = JSON.parse(plan.snapshot.getText(payloadTarget.read_ref!)!);
    const recovered = structuredClone(payload.payload);
    for (const position of payload.external_positions) {
      let owner = recovered;
      for (const key of position.path.slice(0, -1)) owner = owner[key];
      const body = plan.snapshot.getText(position.read_ref)!;
      owner[position.path.at(-1)] = position.value_encoding === "json" ? JSON.parse(body) : body;
    }
    assert.deepEqual(recovered, plan.compiled.bootstrapContent!.payload);
    rows.push({ sample: sample.name, shape: sample.shape, input_sha256: sha(JSON.stringify(sample.canonical._rawBody)),
      model: sample.canonical.modelId, mode: "Zero Risk offline", provider_feature: "not captured; original metadata retained",
      read_tokens: readTokens, read_bytes: plan.limits.readBytes, text_calls: calls,
      control_calls_planned: 2, overview_calls_executed: 1, image_calls: 0,
      prompt_serialized_bytes: plan.costs.promptJsonBytes, prompt_conservative_tokens: plan.costs.promptTokens,
      tool_fields: plan.snapshot.targets.filter(target => target.kind === "tool_arguments" || target.kind === "tool_result").length,
      required_body_bytes: [...restored.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      inlined_tool_fields: plan.costs.selection?.inlinedToolFields ?? 0, external_positions: payload.external_positions.length, external_position_bytes: Buffer.byteLength(JSON.stringify(payload.external_positions)),
      message_skeleton_bytes: Buffer.byteLength(JSON.stringify(payload.payload.messages)),
      total_wire_bytes: wire, total_conservative_tokens: tokens, max_wire_bytes: maxWire, max_tokens: maxTokens,
      control_wire_reserve: plan.costs.discoveryReserveWireBytes, control_token_reserve: plan.costs.discoveryReserveTokens,
      repeats: 0, retries: 0, business_reads: null, elapsed_ms: performance.now() - started,
      exact_body_ranges: true, payload_restored: true, receipts_verified: true, context_ready: true });
  } finally { scope.retire(); }
}
const implementation = ["context-planner", "context-navigator", "context-budget", "context-bootstrap-plan", "context-snapshot", "context-reuse-plan", "context-send"]
  .map(name => readFileSync(new URL(`../src/adapters/chatgpt-web/${name}.ts`, import.meta.url)));
console.log(JSON.stringify({ kind: "offline-bootstrap-efficiency", runtime: `bun ${Bun.version}`,
  implementation_sha256: sha(Buffer.concat(implementation)),
  limitations: ["No real transport, browser startup, model, or business execution measured.",
    "Compares 64 KiB/8k with the default 64 KiB/16k budget. Token estimates are not billing tokens.",
    "Control costs are complete preflight reserves; text costs include framing and duplicate metadata."], rows }, null, 2));
