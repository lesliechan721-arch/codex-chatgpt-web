import { afterEach, expect, spyOn, test } from "bun:test";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import type { ContextRequiredRead } from "../src/adapters/chatgpt-web/context-types";
import type { ContextDeliveryPlan } from "../src/adapters/chatgpt-web/context-planner";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";
import { isChatGptWebZeroRiskBackendModel } from "../src/chatgpt-web-models";
import { continuityDigest, existingContinuityBindings } from "../src/adapters/chatgpt-web/continuity-binding";
import { createSessionContinuityFixtures, type ContinuityContextModelInput } from "./helpers/session-continuity-fixture";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

function rules(request: CodexParsedRequest, instructions: string): CodexParsedRequest {
  const next = parseRequest({ ...request._rawBody as object, instructions,
    reasoning: { effort: isChatGptWebZeroRiskBackendModel(request.modelId) ? "low" : "high" } });
  next._conversationPolicy = "task";
  return next;
}

type Manifest = { manifest_version: number; live: { context_ready: boolean; text_ready: boolean };
  next_required_read: ContextRequiredRead | null };

/** Read through the public MCP transport. The fixture never manufactures a receipt. */
async function readCurrentContext(input: ContinuityContextModelInput,
  prior = { calls: 0, wireBytes: 0, manifestCalls: 0, startupManifestWireBytes: 0 }, byRef = new Map<string, string>()) {
  const bootstrap = JSON.parse(input.prompt.match(/<codex_bootstrap_json>\n([^\n]+)\n/)![1]!);
  const credential = input.manual ? { request_id: input.token } : { turn_token: input.token };
  let calls = prior.calls, wireBytes = prior.wireBytes;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await input.client.callTool({ name, arguments: { ...credential, ...args } });
    calls++; wireBytes += Buffer.byteLength(JSON.stringify(result));
    expect(result.isError).not.toBe(true);
    return result;
  };
  const first = await call(bootstrap.first_call.name, bootstrap.first_call.arguments);
  let manifest = (input.manual ? (first.structuredContent as { context_bootstrap: Manifest }).context_bootstrap
    : first.structuredContent) as Manifest;
  expect(manifest.manifest_version).toBe(3);
  expect(manifest).not.toHaveProperty("required_targets");
  let next = manifest.next_required_read;
  for (let batches = 0; next; batches++) {
    expect(batches).toBeLessThan(200);
    const page = parseContextTextReadResult(await call(next.tool, { ...next.arguments }));
    for (const [index, item] of page.metadata.items.entries()) {
      const previous = byRef.get(item.read_ref) ?? "";
      expect(item.range.start).toBe(Buffer.byteLength(previous));
      byRef.set(item.read_ref, previous + page.bodies[index]!);
    }
    expect(page.metadata.required_step).toBeDefined();
    next = page.metadata.required_step!.next_required_read;
  }
  const bodies = [...byRef.values()], readRefs = [...byRef.keys()];
  manifest = (await call("codex_context_list", { context_id: bootstrap.context_id, view: "overview" })).structuredContent as Manifest;
  expect(manifest.live.context_ready).toBe(true);
  // The transport may deliver the response before its receipt IPC settles.
  // Wait on the production output-admission check; never manufacture coverage.
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      input.broker.checkFinalOutputCandidate(input.token, { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 });
      break;
    } catch (error) {
      if (!["CONTEXT_BUSY", "task_update_tools_pending"].includes(String((error as { code?: string }).code)) || Date.now() >= deadline) throw error;
      await Bun.sleep(1);
    }
  }
  const observed = input.broker.contextUsage(input.token)!.reuse_diagnostics!;
  expect(observed.returned_calls).toBe(calls);
  expect(observed.returned_wire_bytes).toBe(wireBytes);
  expect(observed.startup_manifest_wire_bytes).toBe(prior.startupManifestWireBytes || Buffer.byteLength(JSON.stringify(first)));
  expect(observed.manifest_calls).toBe(prior.manifestCalls + 2);
  expect(observed.directory_calls).toBe(0);
  expect(observed.actual_model_input_tokens).toBeNull();
  return { bootstrap, bodies, readRefs, calls, wireBytes, manifest };
}

for (const manual of [false, true]) test(`reuse ${manual ? "Zero Risk" : "Automatic"}: 20 healthy physical turns deliver stable originals once`, async () => {
  const stable = "STABLE_RULE_BODY_7f14: preserve every exact rule.\n".repeat(700);
  expect(Array.from(stable).length).toBeGreaterThanOrEqual(30_000);
  const observations: Awaited<ReturnType<typeof readCurrentContext>>[] = [];
  const plans = new Map<string, ContextDeliveryPlan>();
  const original = ContextSend.prototype.prepare;
  const prepare = spyOn(ContextSend.prototype, "prepare").mockImplementation(async function(this: ContextSend, ...args) {
    const plan = await original.apply(this, args);
    if (plan.planId) plans.set(plan.planId, plan);
    return plan;
  });
  const f = fixture(manual, { zeroRiskPro: manual, taskUpdates: true, mcpTransport: "in-process", contextModel: async input => {
    const read = await readCurrentContext(input);
    observations.push(read);
    const plan = plans.get(read.bootstrap.plan_id)!;
    expect(plan).toBeDefined();
    if (process.env.CONTEXT_REUSE_METRICS === "1") console.info(JSON.stringify({ mode: manual ? "safe" : "native",
      turn: observations.length, costs: plan.costs, returnedCalls: read.calls, returnedWireBytes: read.wireBytes,
      requiredBodyBytes: read.bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0) }));
    expect(Array.from(input.prompt).length).toBeLessThanOrEqual(8_000);
    if (observations.length > 1) {
      expect(input.prompt).not.toContain("STABLE_RULE_BODY_7f14");
      for (const body of read.bodies) expect(body).not.toContain("STABLE_RULE_BODY_7f14");
      expect(plan.costs.retainedTokens).toBeGreaterThan(0);
    }
  } });
  f.provider.chatgptWeb!.maxComposerCodePoints = 8_000;
  f.provider.chatgptWeb!.experimentalBiggerContext = !manual;
  try {
    let request = rules(f.request("继续"), stable);
    const contextIds = new Set<string>();
    const firstCalls = new Set<string>();
    for (let turn = 1; turn <= 20; turn++) {
      const events = await f.run(request);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(f.pages.size).toBe(1);
      expect(f.submissions.at(-1)!.reused).toBe(turn > 1);
      const observed = observations.at(-1)!;
      expect(contextIds.has(observed.bootstrap.context_id)).toBe(false);
      contextIds.add(observed.bootstrap.context_id);
      const credential = JSON.stringify(observed.bootstrap.first_call.arguments);
      expect(firstCalls.has(credential)).toBe(false);
      firstCalls.add(credential);
      if (turn > 2) expect(observed.bodies).toEqual([]);
      if (turn < 20) {
        const next = f.next(request, `turn-reuse-${turn}`, `Completed response ${turn}.`);
        const raw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
        raw.input.at(-1)!.content = "继续";
        request = rules(parseRequest(raw), stable);
      }
    }
    expect(observations).toHaveLength(20);
    expect(observations[0]!.bodies.join("\n")).toContain("STABLE_RULE_BODY_7f14");
    expect(observations.slice(1).flatMap(value => value.bodies).join("\n")).not.toContain("STABLE_RULE_BODY_7f14");
  } finally { prepare.mockRestore(); }
}, 120_000);

for (const manual of [false, true]) test(`reuse ${manual ? "Zero Risk" : "Automatic"}: the default page budget still causes a complete cold send`, async () => {
  const stable = "BUDGET_RULE_f734 " + "x".repeat(30_000);
  const observations: Awaited<ReturnType<typeof readCurrentContext>>[] = [];
  const f = fixture(manual, { taskUpdates: true, mcpTransport: "in-process", contextModel: async input => {
    observations.push(await readCurrentContext(input));
  } });
  f.provider.chatgptWeb!.maxComposerCodePoints = 8_000;
  let request = rules(f.request("continue"), stable);
  let fellBack = false;
  for (let turn = 1; turn <= 20; turn++) {
    expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    if (turn > 1 && !f.submissions.at(-1)!.reused) {
      expect(observations.at(-1)!.bodies.join("\n")).toContain("BUDGET_RULE_f734");
      fellBack = true;
      break;
    }
    if (turn > 1) expect(observations.at(-1)!.bodies.join("\n")).not.toContain("BUDGET_RULE_f734");
    request = rules(f.next(request, `budget-${turn}`, `Completed response ${turn}.`), stable);
  }
  expect(fellBack).toBe(true);
}, 120_000);

for (const manual of [false, true]) for (const changed of ["page_identity", "predecessor"] as const)
test(`reuse ${manual ? "Zero Risk" : "Automatic"}: diagnoses stale ${changed} and compaction at their lifecycle gates`, async () => {
  const messages: string[] = [];
  const logging = spyOn(console, "info").mockImplementation((message: unknown) => { messages.push(String(message)); });
  const f = fixture(manual, { taskUpdates: true, mcpTransport: "in-process", contextModel: async input => {
    await readCurrentContext(input);
  } });
  f.provider.chatgptWeb!.maxComposerCodePoints = 8_000;
  try {
    const request = rules(f.request("first"), "Private diagnostic rule: keep exact events.");
    expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    const bindings = existingContinuityBindings(f.statePath)!;
    const binding = bindings.observed(continuityDigest(f.threadId))!;
    expect(binding.contextReuseBaseline).toBeDefined();
    // Inject stale cache metadata. The actual page, source and recovery authority stay intact.
    binding.contextReuseBaseline![changed] = "stale-test-identity";
    expect((await f.run(rules(f.next(request), "Private diagnostic rule: keep exact events."))).at(-1))
      .toMatchObject({ type: "done", endTurn: true });
    const reason = changed === "page_identity" ? "page_changed" : "predecessor_changed";
    const selections = messages.filter(message => message.startsWith("[chatgpt-web] context_reuse_selection "))
      .map(message => JSON.parse(message.slice(message.indexOf("{") )));
    expect(selections).toContainEqual({ stage: "preflight", candidate: "resume", reason });
    expect(selections).toContainEqual({ stage: "prepare", candidate: "resume", reason });
    const current = bindings.observed(continuityDigest(f.threadId))!;
    bindings.beginCompaction(current, "diagnostic-compaction", current.executionKey!);
    bindings.abandonUndeliveredCompaction(current, "diagnostic-compaction", current.executionKey!);
    expect(messages).toContain('[chatgpt-web] context_reuse_selection {"stage":"begin_compaction","reason":"compaction"}');
    const prepared = messages.find(message => message.startsWith("[chatgpt-web] context_prepared "))!;
    const record = JSON.parse(prepared.slice(prepared.indexOf("{")));
    expect(record.prompt_serialized_bytes).toBeGreaterThan(0);
    expect(record.budget.context_window_tokens).toBeGreaterThan(record.budget.total_tokens);
    expect(record.budget.total_tokens).toBe(record.budget.retained_tokens + record.budget.platform_reserve_tokens + record.budget.current_plan_tokens);
    expect(record.actual_model_input_tokens).toBeNull();
    expect(prepared).not.toContain("Private diagnostic rule");
  } finally { logging.mockRestore(); }
}, 60_000);

for (const manual of [false, true]) test(`reuse ${manual ? "Zero Risk" : "Automatic"}: changed rules and a long new request are delivered completely`, async () => {
  const stable = "OLD_RULE_12aa " + "a".repeat(30_000);
  const changed = "NEW_RULE_94dd " + "b".repeat(30_000);
  const observations: Awaited<ReturnType<typeof readCurrentContext>>[] = [];
  const f = fixture(manual, { zeroRiskPro: manual, taskUpdates: true, mcpTransport: "in-process", contextModel: async input => {
    observations.push(await readCurrentContext(input));
  } });
  f.provider.chatgptWeb!.maxComposerCodePoints = 8_000;
  f.provider.chatgptWeb!.experimentalBiggerContext = !manual;
  let request = rules(f.request("first"), stable);
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  request = rules(f.next(request), changed);
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(observations[1]!.bodies.join("\n")).toContain("NEW_RULE_94dd");
  expect(observations[1]!.bodies.join("\n")).not.toContain("OLD_RULE_12aa");
  const next = f.next(request, "long-next", "Completed response 2.");
  const raw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  raw.input.at(-1)!.content = "本轮新请求🙂".repeat(2_000) + "TAIL_REQUEST_1c82  \n";
  request = rules(parseRequest(raw), changed);
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(observations[2]!.bodies.join("\n")).toContain("TAIL_REQUEST_1c82");
  expect(observations[2]!.bodies.join("\n")).not.toContain("NEW_RULE_94dd");
}, 60_000);

for (const manual of [false, true]) test(`reuse ${manual ? "Zero Risk" : "Automatic"}: a missing new request page blocks new work and completion`, async () => {
  let turn = 0;
  let old: Awaited<ReturnType<typeof readCurrentContext>> | undefined;
  const f = fixture(manual, { taskUpdates: true, mcpTransport: "in-process", contextModel: async input => {
    if (++turn === 1) { old = await readCurrentContext(input); return; }
    const bootstrap = JSON.parse(input.prompt.match(/<codex_bootstrap_json>\n([^\n]+)\n/)![1]!);
    const credential = manual ? { request_id: input.token } : { turn_token: input.token };
    const prior = { calls: 0, wireBytes: 0, manifestCalls: 0, startupManifestWireBytes: 0 };
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await input.client.callTool({ name, arguments: { ...credential, ...args } });
      if (!result.isError && (name.startsWith("codex_context_") || name === bootstrap.first_call.name)) {
        const bytes = Buffer.byteLength(JSON.stringify(result));
        prior.calls++; prior.wireBytes += bytes;
        if (name === bootstrap.first_call.name || name === "codex_context_list" && args.view === "overview") {
          prior.manifestCalls++;
          prior.startupManifestWireBytes ||= bytes;
        }
      }
      return result;
    };
    const first = await call(bootstrap.first_call.name, bootstrap.first_call.arguments);
    let manifest = (manual ? (first.structuredContent as { context_bootstrap: Manifest }).context_bootstrap : first.structuredContent) as Manifest;
    let missingPage = false;
    const byRef = new Map<string, string>();
    for (let sources = 0; sources < 20; sources++) {
      expect(manifest.next_required_read).not.toBeNull();
      const next = manifest.next_required_read!;
      const page = parseContextTextReadResult(await call(next.tool, { ...next.arguments }));
      for (const [index, item] of page.metadata.items.entries()) {
        const previous = byRef.get(item.read_ref) ?? "";
        expect(item.range.start).toBe(Buffer.byteLength(previous));
        byRef.set(item.read_ref, previous + page.bodies[index]!);
      }
      if (page.metadata.items.some(item => item.has_more)) { missingPage = true; break; }
      expect(page.metadata.required_step).toBeDefined();
      manifest = { ...manifest, next_required_read: page.metadata.required_step!.next_required_read };
    }
    expect(missingPage).toBe(true);
    const early = await call("codex_tool_inventory", { operation_id: 1, task_revision: 0 });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early)).toContain("CONTEXT_NOT_READY");
    if (manual) {
      const done = await call("codex_turn_complete", { final_answer: "missing page", task_revision: 0 });
      expect(done.isError).toBe(true);
      expect(JSON.stringify(done)).toContain("CONTEXT_NOT_READY");
    } else expect(() => input.broker.checkFinalOutputCandidate(input.token,
      { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 })).toThrow();
    const previousCredential = old!.bootstrap.first_call.arguments;
    const retired = await input.client.callTool({ name: "codex_context_read", arguments: {
      ...(manual ? { request_id: previousCredential.request_id } : { turn_token: previousCredential.turn_token }),
      context_id: old!.bootstrap.context_id, reads: [{ read_ref: old!.readRefs[0] }],
    } });
    expect(retired.isError).toBe(true);
    const completed = await readCurrentContext(input, prior, byRef);
    expect(completed.bodies.join("\n")).toContain("REQUIRED_TAIL_a3f0");
    expect(await call("codex_tool_inventory", { operation_id: 1, task_revision: 0 })).toEqual(early);
    expect((await call("codex_tool_inventory", { operation_id: 2, task_revision: 0 })).isError).not.toBe(true);
  } });
  f.provider.chatgptWeb!.maxComposerCodePoints = 8_000;
  const first = rules(f.request("first"), "Keep the exact stable rule.");
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const next = f.next(first);
  const raw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  raw.input.at(-1)!.content = "Long current event. ".repeat(4_000) + "REQUIRED_TAIL_a3f0";
  expect((await f.run(rules(parseRequest(raw), "Keep the exact stable rule."))).at(-1)).toMatchObject({ type: "done", endTurn: true });
}, 60_000);
