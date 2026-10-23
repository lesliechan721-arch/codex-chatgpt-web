import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { appendFixedContextRecords, createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { CONTEXT_PROTOCOL_VERSION, ContextScope, type ContextPlanRegistration } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt } from "../src/adapters/chatgpt-web/context-text-result";
import { measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { boundedContextReuse, contextReuseBaseline, contextReuseMatches } from "../src/adapters/chatgpt-web/context-reuse-lifecycle";

function registration(delivery: "inline" | "required" | "reuse", text = "规则🙂\n".repeat(1800)): ContextPlanRegistration {
  const snapshot = appendFixedContextRecords(createContextSnapshot(parseRequest({ model: "gpt-6", input: "new request" })),
    [{ text, encoding: "utf-8", origin: "context_reuse_unit" }]);
  const target = snapshot.targets.at(-1)!;
  return { snapshot, planId: "reuse-runtime-plan", manifestDigest: "reuse-runtime-manifest", startupProtocol: "context-bootstrap-v1",
    deliveryByTarget: { [target.target_id]: { delivery: delivery === "required" ? "source_required" : "source_on_demand", required: delivery === "required" } },
    reuse: { protocol: "context-reuse-v1", payload_format: "context-bootstrap-payload-v3", mode: delivery === "reuse" ? "incremental" : "full",
      ...(delivery === "reuse" ? { dependency: { baseline_id: "baseline", page_identity: "page", predecessor: "previous",
        units: [{ unit_id: "rule", fingerprint: "fingerprint" }] } } : {}),
      units: [{ unit_id: "rule", fingerprint: "fingerprint", kind: "rule", role: "system", scope: "request", utf8_bytes: Buffer.byteLength(text), delivery, target_id: target.target_id }], snapshots: [] } };
}

test("reuse transport diagnostics separate the first manifest from later overview and directory returns", () => {
  const plan = registration("inline", "exact diagnostic rule");
  const scope = new ContextScope("diagnostics", plan, "normal", () => {}, () => {});
  try {
    scope.markEntryDelivered(); scope.openReads();
    const args = { context_id: plan.snapshot.context_id };
    const first = scope.prepare("list", { ...args, view: "overview" });
    expect(scope.usageEvidence().reuse_diagnostics!.returned_calls).toBe(0);
    scope.finish(first.receiptId, true);
    const second = scope.prepare("list", { ...args, view: "overview" });
    scope.finish(second.receiptId, true);
    const directory = scope.prepare("list", { ...args, view: "entries" });
    scope.finish(directory.receiptId, true);
    const bytes = (result: unknown) => Buffer.byteLength(JSON.stringify(result));
    scope.recordFirstWork();
    const observed = scope.usageEvidence().reuse_diagnostics!;
    expect(observed.returned_calls).toBe(3);
    expect(observed.startup_manifest_wire_bytes).toBe(bytes(first.result));
    expect(observed.manifest_wire_bytes).toBe(bytes(first.result) + bytes(second.result));
    expect(observed.directory_calls).toBe(1);
    expect(observed.directory_wire_bytes).toBe(bytes(directory.result));
    expect(observed.returned_wire_bytes).toBe(observed.manifest_wire_bytes + observed.directory_wire_bytes);
    expect(observed.before_first_work!.returned_wire_bytes).toBe(observed.returned_wire_bytes);
    expect(observed.actual_model_input_tokens).toBeNull();
  } finally { scope.retire(); }
});

test("reuse evidence requires actual inline entry delivery or complete successful current-scope pages", () => {
  for (const delivery of ["inline", "required"] as const) {
    const plan = registration(delivery);
    const scope = new ContextScope("current", plan, "normal", () => {}, () => {});
    try {
      expect(scope.status().text_ready).toBe(false);
      expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
      scope.markEntryDelivered();
      if (delivery === "required") {
        expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
        const first = scope.prepare("read", scope.status().next_required_read!.arguments);
        scope.finish(first.receiptId, false, contextTextReadReceipt(first.result));
        expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
        for (let count = 0; !scope.status().text_ready && count < 100; count++) {
          const page = scope.prepare("read", scope.status().next_required_read!.arguments);
          expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
          scope.finish(page.receiptId, true, contextTextReadReceipt(page.result));
        }
      }
      expect(scope.status().context_ready).toBe(true);
      expect(scope.usageEvidence().reuse_delivery?.units).toEqual([{ unit_id: "rule", fingerprint: "fingerprint", kind: "rule", role: "system", scope: "request", utf8_bytes: Buffer.byteLength("规则🙂\n".repeat(1800)) }]);
      const next = new ContextScope("new-scope", plan, "normal", () => {}, () => {});
      expect(next.usageEvidence().reuse_delivery).toBeUndefined(); next.retire();
      scope.retire(); expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
    } finally { scope.retire(); }
  }
});

test("fixed reuse dependencies are checked again after reads and before successful completion", () => {
  let valid = true;
  const scope = new ContextScope("current", registration("reuse"), "normal", () => {}, () => {}, undefined, () => valid);
  try {
    scope.markEntryDelivered();
    expect(scope.status()).toMatchObject({ context_ready: true, reuse_ready: true, required_texts: 0 });
    expect(scope.usageEvidence().reuse_delivery?.units).toHaveLength(1);
    const target = scope.registration.snapshot.targets.at(-1)!;
    const reread = scope.prepare("read", { context_id: scope.registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
    valid = false;
    scope.finish(reread.receiptId, true, contextTextReadReceipt(reread.result));
    expect(scope.status()).toMatchObject({ context_ready: false, text_ready: true, reuse_ready: false });
    expect(scope.notReady()?.structuredContent).toMatchObject({ code: "CONTEXT_NOT_READY", reuse_failure: "baseline_invalid", recovery_action: "recover_full_plan" });
    expect(() => scope.assertReady()).toThrow();
    expect(scope.usageEvidence().reuse_delivery).toBeUndefined();
  } finally { scope.retire(); }
});

test("baseline metadata is bounded and does not turn a different page, predecessor, or fingerprint into a hit", () => {
  const plan = registration("inline", "source");
  const scope = new ContextScope("current", plan, "normal", () => {}, () => {});
  scope.markEntryDelivered();
  const baseline = contextReuseBaseline(scope.usageEvidence().reuse_delivery!, "page", "previous")!;
  const dependency = { ...baseline, units: baseline.units.map(({ unit_id, fingerprint }) => ({ unit_id, fingerprint })) };
  expect(contextReuseMatches(baseline, dependency)).toBe(true);
  for (const change of [{ page_identity: "another" }, { predecessor: "another" }, { baseline_id: "invented" }, { units: [{ unit_id: "rule", fingerprint: "changed" }] }]) {
    expect(contextReuseMatches(baseline, { ...dependency, ...change })).toBe(false);
  }
  expect(boundedContextReuse({ units: Array.from({ length: 129 }, () => baseline.units[0]) })).toBe(false);
  expect(boundedContextReuse({ units: [{ body: "x".repeat(65_536) }] })).toBe(false);
  scope.retire();
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { TurnBroker, RemoteTurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptTurnSession, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import type { ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";

for (const manual of [false, true]) for (const followup of ["directory-after", "overview-after", "overview-before"] as const)
test(`late startup receipts retain startup identity and the original business boundary (${manual ? "safe" : "native"}, ${followup})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "reuse-observation-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory)); await broker.listen();
  const owner = new RemoteTurnBroker(broker.socketPath);
  const environment = { authorityMode: "delegated" as const, threadId: "diagnostic-thread", turnId: "diagnostic-turn", tools: [] };
  const token = manual ? await owner.registerSafe(environment, "surface-diagnostic-123456789", undefined, "diagnostic-test", { requireSentConfirmation: false })
    : await owner.register(environment, undefined, "diagnostic-test");
  const request = { token, contract: manual ? "safe" as const : "native" as const, credentialKind: "ordinary" as const,
    contextProtocol: CONTEXT_PROTOCOL_VERSION, contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1" };
  try {
    const plan = registration("inline", "Exact inline rule.");
    await owner.registerContextPlan(token, plan); await owner.selectContextPlan(token, plan.planId);
    let receiptId: string;
    let startupResult: ContextPreparedReply["result"];
    if (manual) {
      const { contextBootstrapReceipt, ...start } = await callTurnBroker<{ contextBootstrapReceipt: string }>(broker.socketPath, { ...request, method: "safe_start" });
      receiptId = contextBootstrapReceipt;
      startupResult = { content: [{ type: "text", text: JSON.stringify(start) }], structuredContent: start };
    } else {
      await owner.markContextPlanSent(token, plan.planId);
      const first = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { ...request, method: "context_query",
        contextMethod: "list", contextArgs: { context_id: plan.snapshot.context_id, view: "overview" } });
      receiptId = first.receiptId; startupResult = first.result;
    }
    const readFollowup = async () => {
      const later = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { ...request, method: "context_query",
        contextMethod: "list", contextArgs: { context_id: plan.snapshot.context_id, view: followup === "directory-after" ? "entries" : "overview" } });
      await callTurnBroker(broker.socketPath, { ...request, method: "context_return", receiptId: later.receiptId, sent: true });
      if (manual && followup !== "directory-after") expect(Buffer.byteLength(JSON.stringify(later.result))).not.toBe(Buffer.byteLength(JSON.stringify(startupResult)));
    };
    if (followup === "overview-before") await readFollowup();
    // The response reached the caller. Delay only its separate receipt IPC.
    const inventory = await callTurnBroker<{ kind: string }>(broker.socketPath, { ...request, method: "native_operation_start",
      nativeWaitProtocol: 1, operationId: 1, entry: "codex_tool_inventory", nativeInput: {} });
    expect(inventory.kind).toBe("result");
    const boundary = (await owner.contextUsage(token))!.reuse_diagnostics!.before_first_work!;
    expect(boundary.returned_calls).toBe(followup === "overview-before" ? 1 : 0);
    if (followup !== "overview-before") await readFollowup();
    await callTurnBroker(broker.socketPath, { ...request, method: "context_return", receiptId, sent: true });
    const observed = (await owner.contextUsage(token))!.reuse_diagnostics!;
    expect(observed.returned_calls).toBe(2);
    expect(observed.directory_calls).toBe(followup === "directory-after" ? 1 : 0);
    const startupCost = measureContextResponse(startupResult, { wireReserveBytes: 0, tokenReserve: 0 });
    expect(observed.startup_manifest_wire_bytes).toBe(Buffer.byteLength(JSON.stringify(startupResult)));
    expect(observed.startup_manifest_estimated_tokens).toBe(startupCost.total_tokens);
    expect(observed.before_first_work!.startup_manifest_wire_bytes).toBe(observed.startup_manifest_wire_bytes);
    expect(observed.before_first_work!.startup_manifest_estimated_tokens).toBe(startupCost.total_tokens);
    expect(observed.before_first_work!.returned_calls).toBe(followup === "overview-before" ? 2 : 1);
    expect(observed.before_first_work!.returned_wire_bytes).toBe(followup === "overview-before" ? observed.returned_wire_bytes : observed.startup_manifest_wire_bytes);
    expect(observed.before_first_work!.directory_calls).toBe(0);
    expect(observed.before_first_work!.elapsed_ms).toBe(boundary.elapsed_ms);
    await callTurnBroker(broker.socketPath, { ...request, method: "context_return", receiptId, sent: true });
    const duplicate = (await owner.contextUsage(token))!.reuse_diagnostics!;
    expect(duplicate.returned_wire_bytes).toBe(observed.returned_wire_bytes);
    expect(duplicate.before_first_work).toEqual(observed.before_first_work);
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("failed startup receipts do not replace or double count a later confirmed manifest", () => {
  const plan = registration("inline", "Exact inline rule.");
  const scope = new ContextScope("failed-startup", plan, "normal", () => {}, () => {});
  try {
    scope.markEntryDelivered(); scope.openReads();
    const failed = scope.prepareBootstrapReturn({ start: "different startup envelope" });
    const later = scope.prepare("list", { context_id: plan.snapshot.context_id, view: "overview" });
    scope.finish(later.receiptId, true);
    scope.recordFirstWork();
    const boundary = scope.usageEvidence().reuse_diagnostics!.before_first_work!;
    scope.finish(failed, false);
    scope.finish(failed, true);
    const observed = scope.usageEvidence().reuse_diagnostics!;
    expect(observed.returned_calls).toBe(1);
    expect(observed.startup_manifest_wire_bytes).toBe(Buffer.byteLength(JSON.stringify(later.result)));
    expect(observed.before_first_work).toEqual(boundary);
  } finally { scope.retire(); }
});

test("transported navigation errors retain their cost without becoming manifest or directory returns", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reuse-navigation-error-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory)); await broker.listen();
  const owner = new RemoteTurnBroker(broker.socketPath);
  const token = await owner.register({ authorityMode: "delegated", threadId: "error-thread", turnId: "error-turn", tools: [] }, undefined, "error-test");
  const request = { token, contract: "native" as const, credentialKind: "ordinary" as const,
    contextProtocol: CONTEXT_PROTOCOL_VERSION, contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1" };
  try {
    const plan = registration("inline", "Exact inline rule.");
    await owner.registerContextPlan(token, plan); await owner.selectContextPlan(token, plan.planId);
    await owner.markContextPlanSent(token, plan.planId);
    const query = (view: "overview" | "entries", cursor?: string) => callTurnBroker<ContextPreparedReply>(broker.socketPath, {
      ...request, method: "context_query", contextMethod: "list", contextArgs: {
        context_id: plan.snapshot.context_id, view, ...(cursor ? { cursor } : {}) } });
    const confirm = (reply: ContextPreparedReply) => callTurnBroker(broker.socketPath, {
      ...request, method: "context_return", receiptId: reply.receiptId, sent: true });
    const error = await query("overview", "oops"); expect(error.result.isError).toBe(true);
    await confirm(error);
    const overview = await query("overview"); expect(overview.result.isError).not.toBe(true);
    const inventory = await callTurnBroker<{ kind: string }>(broker.socketPath, { ...request, method: "native_operation_start",
      nativeWaitProtocol: 1, operationId: 1, entry: "codex_tool_inventory", nativeInput: {} });
    expect(inventory.kind).toBe("result");
    const boundary = (await owner.contextUsage(token))!.reuse_diagnostics!.before_first_work!;
    const entryError = await query("entries", "oops"); expect(entryError.result.isError).toBe(true); await confirm(entryError);
    const entries = await query("entries"); expect(entries.result.isError).not.toBe(true); await confirm(entries);
    await confirm(overview); await confirm(error);
    const observed = (await owner.contextUsage(token))!.reuse_diagnostics!;
    const bytes = (reply: ContextPreparedReply) => Buffer.byteLength(JSON.stringify(reply.result));
    const costs = [error, overview, entryError, entries].map(reply => measureContextResponse(reply.result, { wireReserveBytes: 0, tokenReserve: 0 }));
    expect(observed.returned_calls).toBe(4);
    expect(observed.returned_wire_bytes).toBe([error, overview, entryError, entries].reduce((sum, reply) => sum + bytes(reply), 0));
    expect(observed.returned_estimated_tokens).toBe(costs.reduce((sum, cost) => sum + cost.total_tokens, 0));
    expect(observed.manifest_calls).toBe(1); expect(observed.directory_calls).toBe(1);
    expect(observed.startup_manifest_wire_bytes).toBe(bytes(overview));
    expect(observed.startup_manifest_estimated_tokens).toBe(costs[1]!.total_tokens);
    expect(observed.manifest_wire_bytes).toBe(bytes(overview)); expect(observed.directory_wire_bytes).toBe(bytes(entries));
    expect(observed.before_first_work).toMatchObject({ returned_calls: 2,
      returned_wire_bytes: bytes(error) + bytes(overview), startup_manifest_wire_bytes: bytes(overview),
      startup_manifest_estimated_tokens: costs[1]!.total_tokens, manifest_calls: 1, directory_calls: 0, elapsed_ms: boundary.elapsed_ms });
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const manual of [false, true]) for (const outcome of ["normal", "revoked", "superseded"] as const)
test(`Broker reuse commit requires its own delivery, normal completion and current completed head (${manual ? "safe" : "native"}, ${outcome})`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "reuse-runtime-broker-"));
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory);
  const thread = "1".repeat(64), scope = "2".repeat(64), digest = "3".repeat(64), processOwner = continuityProcessInstance("4".repeat(64));
  const admit = (logicalWorkId: string, previous?: string) => store.admitWork({ thread, scope, owner: processOwner,
    logicalWorkId, instructionIdentity: `instruction-${logicalWorkId}`, nativeTurnId: `turn-${logicalWorkId}`,
    workPayloadDigest: digest, snapshotDigest: digest, createPage: !previous, dispatchProtocolComplete: true,
    ...(previous ? { instructionPrevious: { instructionIdentity: `instruction-${previous}`, nativeTurnId: `turn-${previous}` } } : {}) });
  admit("A");
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory)); await broker.listen();
  const owner = new RemoteTurnBroker(broker.socketPath);
  const environment = { authorityMode: "delegated" as const, threadId: "native-thread", turnId: "native-turn", tools: [] };
  const recovery = { directory, thread, logicalWorkId: "A", attempt: 0, ownerId: processOwner.id };
  const token = manual ? await owner.registerSafe(environment, "surface-reuse-1234567890123456", undefined, "reuse-test", { recovery, requireSentConfirmation: false })
    : await owner.register(environment, undefined, "reuse-test", { recovery });
  const request = { token, contract: manual ? "safe" as const : "native" as const, credentialKind: "ordinary" as const,
    contextProtocol: CONTEXT_PROTOCOL_VERSION, contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1" };
  try {
    expect(await owner.contextReuseAvailable()).toBe(true);
    const plan = registration("required", "exact stable rule🙂");
    await owner.registerContextPlan(token, plan); await owner.selectContextPlan(token, plan.planId);
    if (manual) {
      const started = await callTurnBroker<{ contextBootstrapReceipt: string }>(broker.socketPath, { ...request, method: "safe_start" });
      expect((await owner.contextUsage(token))?.reuse_diagnostics?.returned_calls).toBe(0);
      await callTurnBroker(broker.socketPath, { ...request, method: "context_return", receiptId: started.contextBootstrapReceipt, sent: true });
      expect((await owner.contextUsage(token))?.reuse_diagnostics?.returned_calls).toBe(1);
    }
    else await owner.markContextPlanSent(token, plan.planId);
    expect(await owner.commitContextReuse(token)).toBeUndefined();
    const page = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { ...request, method: "context_query", contextMethod: "read",
      contextArgs: (await owner.contextStatus(token))!.next_required_read!.arguments });
    expect(await owner.commitContextReuse(token)).toBeUndefined();
    await callTurnBroker(broker.socketPath, { ...request, method: "context_return", receiptId: page.receiptId, sent: true, textReadReceipt: contextTextReadReceipt(page.result) });
    expect(await owner.commitContextReuse(token)).toBeUndefined();
    expect((await owner.contextUsage(token))?.reuse_diagnostics?.returned_calls).toBe(manual ? 2 : 1);
    if (outcome === "revoked") await owner.revokeTrusted(token, new Error("cancelled"));
    else if (manual) await callTurnBroker(broker.socketPath, { ...request, method: "safe_complete", finalAnswer: "normal final" });
    else {
      const fence = await owner.beginCompletionFence(token);
      expect(await owner.commitCompletionFence(token, fence!)).toBe(true);
    }
    // Broker completion is not enough: durable normal final must also belong to this current page.
    expect(await owner.commitContextReuse(token)).toBeUndefined();
    store.completeWork(thread, { scope }, "A", { receiptId: "final-A", digest });
    if (outcome === "superseded") admit("B", "A");
    const baseline = await owner.commitContextReuse(token);
    if (outcome !== "normal") { expect(baseline).toBeUndefined(); return; }
    expect(baseline?.units).toHaveLength(1);
    expect(baseline?.predecessor).toBe("A");
    admit("B", "A");
    const next = await owner.register(environment, undefined, "reuse-next", { recovery: { ...recovery, logicalWorkId: "B" } });
    const reused = registration("reuse", "exact stable rule🙂");
    reused.reuse!.dependency = { baseline_id: baseline!.baseline_id, page_identity: baseline!.page_identity, predecessor: baseline!.predecessor,
      units: baseline!.units.map(({ unit_id, fingerprint }) => ({ unit_id, fingerprint })) };
    const forged = { ...reused, planId: "forged", reuse: { ...reused.reuse!, dependency: { ...reused.reuse!.dependency!, baseline_id: "invented" } } };
    await expect(owner.registerContextPlan(next, forged)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await owner.registerContextPlan(next, reused); await owner.selectContextPlan(next, reused.planId); await owner.markContextPlanSent(next, reused.planId);
    expect(await owner.contextStatus(next)).toMatchObject({ context_ready: true, reuse_ready: true });
    store.stopWork(thread, { scope }, "B", "user-stop");
    expect(await owner.contextStatus(next)).toMatchObject({ context_ready: false, reuse_ready: false });
    await expect(owner.beginCompletionFence(next)).rejects.toBeDefined();
    expect(await owner.commitContextReuse(next)).toBeUndefined();
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Session publishes reuse only after both normal final and physical settlement, never after supersession", async () => {
  for (const superseded of [false, true]) {
    let finish!: () => void, committed = 0;
    const session = new ChatGptTurnSession({ mode: "read-only", browser: Promise.resolve("normal final"),
      physicalSettlement: new Promise<void>(resolve => { finish = resolve; }), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      commitContextReuse: async () => { committed++; }, cancel() {} });
    await session.browserOutcome;
    expect(committed).toBe(0); expect(session.isPhysicallySettled()).toBe(false);
    if (superseded) session.supersededError = new Error("new page owns the head");
    finish(); await session.physicalSettlement;
    expect(committed).toBe(superseded ? 0 : 1); expect(session.isPhysicallySettled()).toBe(true);
  }
});
