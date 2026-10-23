import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { planContextDelivery, type ContextDeliveryPlan } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { measureContextResponse, measureContextVisibleResponse } from "../src/adapters/chatgpt-web/context-budget";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import type { BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

/** Offline replay: real compiler, planner and navigator; no browser or model calls. */
export function measureContextRendering() {
  const sourceRoot = join(import.meta.dir, "..", "src");
  const sourceHash = createHash("sha256");
  for (const path of readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()) {
    sourceHash.update(path.slice(sourceRoot.length + 1)).update("\0").update(readFileSync(path)).update("\0");
  }
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };
  const turnToken = `turn_${"a".repeat(32)}`;
  const samples = [
    { name: "code", body: 'const item = {"path":"C:\\\\work\\\\source.ts","value":"quoted"};\n'.repeat(600) },
    { name: "markdown", body: '# Recorded result\n- [source](https://example.invalid/a?x=1)\n```ts\nconst value = "ok";\n```\n'.repeat(400) },
    { name: "json-text", body: JSON.stringify(Array.from({ length: 600 }, (_, id) => ({ id, path: `C:\\work\\source-${id}.ts`, value: '"quoted"' }))) },
    { name: "short-result", body: "OK" },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const sample of samples) {
    const canonical: CodexParsedRequest = { modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
      context: { systemPrompt: ["Use recorded evidence without repeating its action."], messages: [
        { role: "user", content: "Inspect the saved tool result.", timestamp: 1 },
        { role: "toolResult", toolName: "recorded_log", toolCallId: "recorded-call", isError: false, content: sample.body, timestamp: 2 },
        { role: "user", content: "Extract the needed source text. Do not execute the recorded action.", timestamp: 3 },
      ] } };
    const snapshot = createContextSnapshot(canonical);
    for (const contextRendering of ["legacy-json", "codex-context-text-v1", "auto"] as const) {
      const started = performance.now();
      const common = { canonical, candidate: canonical, snapshot, capabilities, turnToken,
        compileOptions: { contextRendering } };
      const inline = planContextDelivery({ ...common, contextToolsAvailable: false });
      const plan = planContextDelivery({ ...common, contextToolsAvailable: true });
      if (contextRendering !== "auto") {
        assert.equal(inline.compiled.contextFormat, contextRendering, "Forced inline candidate must not fall back");
        assert.equal(plan.compiled.contextFormat, contextRendering, "Forced projected candidate must not fall back");
      }
      const planningMs = performance.now() - started;
      for (const reading of ["partial", "complete"] as const) {
        const replay = replayReads(plan, sample.body, reading);
        rows.push({ sample: sample.name, source_utf8_bytes: Buffer.byteLength(sample.body),
          source_sha256: createHash("sha256").update(sample.body).digest("hex"), requested: contextRendering,
          inline_format: inline.costs.contextFormat, selected_format: plan.costs.contextFormat, reading,
          raw_whitespace_policy: "unverified; default JSON fallback", navigation: plan.navigationEnabled,
          inline_visible_bytes: inline.costs.promptBytes, inline_json_bytes: inline.costs.promptJsonBytes,
          inline_tokens: inline.costs.promptTokens, selected_visible_bytes: plan.costs.promptBytes,
          selected_editor_characters: plan.costs.promptCharacters, selected_json_bytes: plan.costs.promptJsonBytes,
          selected_tokens: plan.costs.promptTokens,
          navigation_entry_bytes: plan.costs.navigationPromptBytes, attachment_bytes: plan.costs.attachmentBytes,
          image_visual_reserve: plan.costs.attachmentVisualTokens + plan.costs.requiredMcpTokens,
          ...replay, total_estimated_tokens: plan.costs.promptTokens + replay.mcp_conservative_tokens,
          total_wire_bytes: plan.costs.promptJsonBytes + replay.mcp_wire_bytes,
          net_tokens_saved_against_inline: inline.costs.promptTokens - plan.costs.promptTokens - replay.mcp_conservative_tokens,
          planning_ms: planningMs, actual_model_input_tokens: null });
      }
    }
  }
  return { kind: "offline-context-rendering-replay", generated_at: new Date().toISOString(),
    runtime: `bun ${Bun.version}`, source_sha256: sourceHash.digest("hex"),
    model: CHATGPT_WEB_MODEL_ID, effort: "high", mcp_format: "context-text-batch-v1",
    limits: ["No browser, model, network or semantic-quality measurement.",
      "Forced legacy/new candidates and automatic selection all use the current batch-v1 MCP navigator; this does not compare old and new MCP contracts.",
      "Source bytes are identical between variants. Runtime identifiers are sampled by the real planner.",
      "Complete-reading rows include one intentional repeated first page. Hard token estimates include reserves.",
      "Diagnostic visible-field tokens do not replace hard budgets. Actual model input counts are unknown."], rows };
}

function replayReads(plan: ContextDeliveryPlan, source: string, reading: "partial" | "complete") {
  const started = performance.now();
  let listCalls = 0, readCalls = 0, wire = 0, hardTokens = 0, diagnosticTokens = 0, uniqueBytes = 0, repeatedBytes = 0;
  if (plan.registration) {
    const { snapshot, deliveryByTarget, limits } = plan.registration;
    const navigator = new ContextNavigator({ scopeId: `offline-${reading}`, snapshot, purpose: "normal", deliveryByTarget, limits });
    const account = (result: BrokerToolResult): BrokerToolResult => {
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const cost = measureContextResponse(result);
      wire += cost.wire_bytes; hardTokens += cost.total_tokens;
      diagnosticTokens += measureContextVisibleResponse(result).total_tokens;
      return result;
    };
    account(navigator.list({ context_id: snapshot.context_id, view: "overview" })); listCalls++;
    let listCursor: string | undefined, readRef: string | undefined;
    do {
      const result = account(navigator.list({ context_id: snapshot.context_id, view: "entries", ...(listCursor ? { cursor: listCursor } : {}) }));
      listCalls++;
      const page = result.structuredContent as { entries: Array<{ kind: string; read_ref: string | null }>; next_cursor: string | null };
      readRef ??= page.entries.find(entry => entry.kind === "tool_result")?.read_ref ?? undefined;
      listCursor = page.next_cursor ?? undefined;
    } while (!readRef && listCursor);
    assert.ok(readRef, "Recorded source must be discoverable");
    let cursor: string | undefined, restored = "", firstBody = "";
    do {
      const result = account(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: readRef, ...(cursor ? { cursor } : {}) }] }));
      const { metadata, bodies } = parseContextTextReadResult(result);
      assert.equal(metadata.items.length, 1);
      const item = metadata.items[0]!, body = bodies[0]!;
      assert.equal(item.range.start, uniqueBytes);
      if (readCalls === 0) firstBody = body;
      readCalls++; restored += body; uniqueBytes += Buffer.byteLength(body);
      cursor = metadata.remaining_reads[0]?.cursor;
    } while (reading === "complete" && cursor);
    assert.equal(restored, Buffer.from(source).subarray(0, uniqueBytes).toString("utf8"));
    if (reading === "complete") assert.equal(restored, source);
    const repeated = account(navigator.read({ context_id: snapshot.context_id, reads: [{ read_ref: readRef }] })); readCalls++;
    const repeatBody = parseContextTextReadResult(repeated).bodies[0]!;
    assert.equal(repeatBody, firstBody); repeatedBytes = Buffer.byteLength(repeatBody);
    assert.equal(navigator.usage().wire_bytes, wire);
  }
  return { list_calls: listCalls, search_calls: 0, read_calls: readCalls, repeated_reads: readCalls ? 1 : 0,
    unique_read_bytes: uniqueBytes, repeated_read_bytes: repeatedBytes, error_calls: 0,
    mcp_wire_bytes: wire, mcp_conservative_tokens: hardTokens, mcp_diagnostic_visible_tokens: diagnosticTokens,
    replay_ms: performance.now() - started };
}

if (import.meta.main) console.log(JSON.stringify(measureContextRendering(), null, 2));
