import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { contextErrorReserve, measureContextResponse } from "../src/adapters/chatgpt-web/context-budget";
import { ContextScope, type ContextPreparedReply, type ContextPlanRegistration } from "../src/adapters/chatgpt-web/context-runtime";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";

const ownerContext = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
const nonce = "context-test-surface-1234567890";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function snapshot() { return createContextSnapshot(parseRequest({ model: "gpt-5", input: [{ role: "user", content: [
  { type: "input_text", text: "Read source marker 独有证据." }, { type: "input_image", image_url: `data:image/png;base64,${image}` },
] }] })); }
function plan(id = "selected", required = true): ContextPlanRegistration {
  const source = snapshot();
  return { snapshot: source, planId: id, manifestDigest: `manifest-${id}`,
    deliveryByTarget: Object.fromEntries(source.targets.map(t => [t.target_id, t.kind === "image" ? { delivery: "on_demand", media_route: "mcp", required } : { delivery: "inline", required: false }])) };
}
async function fixture(remote: boolean, safe = false, sent = false) {
  const root = mkdtempSync(join(tmpdir(), "context-broker-")); const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const owner = remote ? new RemoteTurnBroker(socket) : broker;
  const environment = { authorityMode: "delegated" as const, threadId: "context-thread", turnId: "context-turn", tools: [{ name: "exec_command", description: "Execute", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }] };
  const token = safe ? await owner.registerSafe(environment, nonce, undefined, "context-test", { taskUpdateProtocol: 1, requireSentConfirmation: sent })
    : await owner.register(environment, undefined, "context-test", { taskUpdateProtocol: 1 });
  const contract = safe ? "safe" as const : "native" as const;
  const query = (registration: ContextPlanRegistration, read = true, options: Record<string, unknown> = {}) => callTurnBroker<ContextPreparedReply>(socket, {
    method: "context_query", token, contract, credentialKind: "ordinary", contextProtocol: CONTEXT_PROTOCOL_VERSION,
    contextMethod: read ? "read" : "list", contextArgs: read ? { context_id: registration.snapshot.context_id, reads: [{ read_ref: registration.snapshot.targets.find(t => t.kind === "image")!.read_ref! }] } : { context_id: registration.snapshot.context_id, view: "entries" }, ...options,
  });
  const finish = (reply: ContextPreparedReply, sent = true) => callTurnBroker(socket, { method: "context_return", token, contract, credentialKind: "ordinary", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: reply.receiptId, sent });
  const start = (id: number, cmd = "echo test") => callTurnBroker<NativeOperationReply>(socket, { method: "native_operation_start", token, contract, nativeWaitProtocol: 1, taskUpdateProtocol: 1, operationId: id, taskRevision: 0, entry: "codex_exec", nativeInput: { cmd }, waitMs: 1 });
  return { root, socket, broker, owner, token, contract, query, finish, start,
    close: async () => { await broker.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const remote of [false, true]) describe(`${remote ? "Remote" : "Local"} context owner`, () => {
  test("discarding unselected navigation candidates permits fast completion without authorizing old references", async () => {
    const f = await fixture(remote, true, true); const resume = plan("resume-navigation");
    try {
      await f.owner.registerContextPlan(f.token, resume, ownerContext);
      await f.owner.discardUnselectedContextPlans(f.token, ownerContext);
      await callTurnBroker(f.socket, { method: "safe_start", token: f.token });
      await f.owner.confirmSafeTurnSent(f.token, nonce);
      await expect(f.query(resume)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
      expect(await f.owner.contextStatus(f.token)).toBeUndefined(); expect(await f.owner.contextUsage(f.token)).toBeUndefined();
      await expect(Promise.resolve().then(() => f.owner.discardUnselectedContextPlans(f.token, ownerContext))).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
      expect(await callTurnBroker(f.socket, { method: "safe_complete", token: f.token, finalAnswer: "fast complete", taskRevision: 0, taskUpdateProtocol: 1 })).toMatchObject({ completed: true });
    } finally { await f.close(); }
  });
  test("a selected navigation plan cannot be discarded before or after sending", async () => {
    const f = await fixture(remote); const selected = plan();
    try {
      await f.owner.registerContextPlan(f.token, selected, ownerContext); await f.owner.selectContextPlan(f.token, selected.planId, ownerContext);
      await expect(Promise.resolve().then(() => f.owner.discardUnselectedContextPlans(f.token, ownerContext))).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
      await f.owner.markContextPlanSent(f.token, selected.planId, ownerContext);
      await expect(Promise.resolve().then(() => f.owner.discardUnselectedContextPlans(f.token, ownerContext))).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    } finally { await f.close(); }
  });
  test("requires selected and sent plan; transport coverage gates deterministic operation replay and final output", async () => {
    const f = await fixture(remote); const a = plan(); const b = plan("unselected");
    try {
      await f.owner.registerContextPlan(f.token, a, ownerContext); await f.owner.registerContextPlan(f.token, b, ownerContext);
      await expect(f.query(a)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
      await f.owner.selectContextPlan(f.token, a.planId, ownerContext);
      await expect(f.query(a)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
      await f.owner.markContextPlanSent(f.token, a.planId, ownerContext);
      await expect(f.query(b)).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
      await expect(f.query(a, true, { contract: "safe" })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
      const first = await f.start(1); expect(first.kind).toBe("result");
      expect((first as { result: BrokerToolResult }).result.structuredContent).toMatchObject({ code: "CONTEXT_NOT_READY", remaining_images: 1 });
      const reply = await f.query(a); expect(reply.result.content.some((b: any) => b.type === "image")).toBe(true);
      expect((await f.owner.contextStatus(f.token))?.context_ready).toBe(false);
      await f.finish(reply, false); expect((await f.owner.contextStatus(f.token))?.context_ready).toBe(false);
      const successful = await f.query(a); await f.finish(successful);
      expect((await f.owner.contextStatus(f.token))?.context_ready).toBe(true);
      expect(await f.start(1)).toEqual(first);
      await expect(f.start(1, "different")).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      expect((await f.start(2)).kind).toBe("pending");
      const [request] = await f.owner.nextToolBatch(f.token, undefined, ownerContext);
      await f.owner.completeTool(f.token, request!.callId, { content: [{ type: "text", text: "actual" }] }, ownerContext);
      await callTurnBroker(f.socket, { method: "native_operation_wait", token: f.token, contract: f.contract, nativeWaitProtocol: 1, operationId: 2, waitMs: 1 });
      const pending = await f.query(a, false);
      await expect(Promise.resolve().then(() => f.owner.beginFinalOutput(f.token, ownerContext))).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
      await f.finish(pending);
      const fence = await f.owner.beginCompletionFence(f.token, ownerContext);
      expect(await f.owner.commitCompletionFence(f.token, fence!, ownerContext)).toBe(true);
      await expect(f.query(a)).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    } finally { await f.close(); }
  });
  for (const sent of [false, true]) test(`Zero Risk start, Sent=${sent} and manifest confirmation stay separate`, async () => {
    const f = await fixture(remote, true, sent); const a = plan();
    const imageTarget = a.snapshot.targets.find(t => t.kind === "image")!;
    a.deliveryByTarget = { ...a.deliveryByTarget, [imageTarget.target_id]: { delivery: "attachment", media_route: "attachment", required: true } };
    try {
      await f.owner.registerContextPlan(f.token, a, ownerContext); await f.owner.selectContextPlan(f.token, a.planId, ownerContext);
      await expect(f.query(a, false)).rejects.toThrow();
      await callTurnBroker(f.socket, { method: "safe_start", token: f.token });
      if (sent) { await expect(f.query(a, false)).rejects.toThrow(); await f.owner.confirmSafeTurnSent(f.token, nonce); }
      const listing = await f.query(a, false); await f.finish(listing);
      expect((await f.owner.contextStatus(f.token))?.context_ready).toBe(false);
      await expect(Promise.resolve().then(() => f.owner.confirmContextAttachments(f.token, { planId: a.planId, manifestDigest: "wrong" }, ownerContext))).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
      await expect(callTurnBroker(f.socket, { method: "safe_complete", token: f.token, finalAnswer: "done", taskRevision: 0, taskUpdateProtocol: 1 })).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
      await f.owner.confirmContextAttachments(f.token, { planId: a.planId, manifestDigest: a.manifestDigest }, ownerContext);
      expect(await callTurnBroker(f.socket, { method: "safe_complete", token: f.token, finalAnswer: "done", taskRevision: 0, taskUpdateProtocol: 1 })).toMatchObject({ completed: true });
    } finally { await f.close(); }
  });
});

test("compaction submission rejects pending, undelivered, revoked and cross-purpose reads, without requiring full reads", async () => {
  const f = await fixture(true); const a = plan();
  try {
    const tx = await f.owner.beginCompactionTransaction("context-compaction-test");
    const h = await f.owner.registerCompactionContext({ snapshot: a.snapshot, contract: "native", transactionToken: tx.token, handoffId: tx.handoffId, historyRevision: 0, ownerGeneration: "writer-1", expiresAt: Date.now() + 30_000 });
    const query = () => f.query(a, false, { token: h.compactionToken, credentialKind: "compaction" });
    const submit = () => callTurnBroker(f.socket, { method: "submit_compaction_handoff", token: tx.token, handoffId: tx.handoffId, summary: "summary without all reads" });
    await expect(query()).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await expect(submit()).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await f.owner.markCompactionContextDelivered(h.compactionToken);
    await expect(f.query(a, false, { token: tx.token, credentialKind: "compaction" })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    await expect(f.query(a, false, { token: h.compactionToken })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    const reading = await query(); await expect(submit()).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
    await callTurnBroker(f.socket, { method: "context_return", token: h.compactionToken, contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: reading.receiptId, sent: true });
    await submit(); expect(await f.broker.waitForCompactionHandoff(tx.token)).toBe("summary without all reads");
    await expect(query()).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    const revoked = await f.owner.beginCompactionTransaction("context-compaction-revoked");
    const revokedRead = await f.owner.registerCompactionContext({ snapshot: a.snapshot, contract: "native", transactionToken: revoked.token, handoffId: revoked.handoffId, historyRevision: 0, ownerGeneration: "writer-1", expiresAt: Date.now() + 30_000 });
    await f.owner.markCompactionContextDelivered(revokedRead.compactionToken); await f.owner.revokeCompactionContext(revokedRead.compactionToken);
    await expect(callTurnBroker(f.socket, { method: "submit_compaction_handoff", token: revoked.token, handoffId: revoked.handoffId, summary: "late" })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    await f.owner.abortCompactionTransaction(revoked.token);
  } finally { await f.close(); }
});

test("ready contexts have no idle or business deadline", () => {
  const a = plan(); let failed: Error | undefined; const now = Date.now; let time = now();
  Date.now = () => time;
  const scope = new ContextScope("scope", a, "normal", () => {}, error => { failed = error; });
  try {
    scope.markEntryDelivered(); scope.openReads();
    const reply = scope.prepare("read", { context_id: a.snapshot.context_id, reads: [{ read_ref: a.snapshot.targets.find(t => t.kind === "image")!.read_ref! }] });
    scope.finish(reply.receiptId, true); time += 24 * 60 * 60 * 1000;
    expect(scope.status().context_ready).toBe(true); expect(scope.isLive).toBe(true); expect(failed).toBeUndefined();
    const listing = scope.prepare("list", { context_id: a.snapshot.context_id, view: "overview" }); expect(listing.result.isError).not.toBe(true);
    scope.finish(listing.receiptId, true);
  } finally { scope.retire(); Date.now = now; }
});

test("navigation never extends the required-image no-progress deadline", () => {
  const a = plan(); const now = Date.now; const setTimer = globalThis.setTimeout; const clearTimer = globalThis.clearTimeout;
  let time = 1_000; let failed: Error | undefined;
  const timers = new Map<object, { callback: () => void; delay: number }>();
  Date.now = () => time;
  globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = { unref() {} }; timers.set(id, { callback, delay }); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: object) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const scope = new ContextScope("deadline-scope", a, "normal", () => {}, error => { failed = error; });
  try {
    scope.markEntryDelivered(); scope.openReads(); expect([...timers.values()].at(-1)?.delay).toBe(45_000);
    time += 20_000;
    const reply = scope.prepare("list", { context_id: a.snapshot.context_id, view: "overview" }); scope.finish(reply.receiptId, true);
    const readiness = [...timers.values()].at(-1)!; expect(readiness.delay).toBe(25_000);
    readiness.callback(); expect(failed).toMatchObject({ code: "CONTEXT_NOT_READY" });
  } finally { scope.retire(); Date.now = now; globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer; }
});

test("compaction budget rejection allows stopping, while permanent source failure forbids success", () => {
  const a = plan("compaction-budget", false);
  const scope = new ContextScope("compaction-budget", { ...a, remainingBudget: { tokens: 2_000, reserved_tokens: 1_000, wire_bytes: 64 * 1024 * 1024 } }, "compaction", () => {}, () => {});
  try {
    scope.markEntryDelivered();
    const imageRef = a.snapshot.targets.find(t => t.kind === "image")!.read_ref!;
    const refused = scope.prepare("read", { context_id: a.snapshot.context_id, reads: [{ read_ref: imageRef }] });
    expect(refused.result.isError).toBe(true); expect(refused.result.structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } });
    scope.finish(refused.receiptId, true); expect(() => scope.guardCommit()).not.toThrow();
    const originalRead = scope.navigator.read.bind(scope.navigator);
    scope.navigator.read = () => ({ isError: true, content: [{ type: "text", text: "Source unavailable" }], structuredContent: { error: { code: "IMAGE_UNAVAILABLE" } } });
    const failed = scope.prepare("read", { context_id: a.snapshot.context_id, reads: [{ read_ref: imageRef }] }); scope.finish(failed.receiptId, true);
    scope.navigator.read = originalRead;
    expect(() => scope.guardCommit()).toThrow("permanent read failure");
  } finally { scope.retire(); }
});

test("original compaction transaction expiry releases source capacity immediately", async () => {
  const f = await fixture(false); const a = plan("expiry-source", false);
  try {
    // The source's later expiry must not retain any of the sixteen active-scope slots.
    for (let index = 0; index < 18; index++) {
      const transaction = await f.broker.beginCompactionTransaction(`expiry-${index}`, 40);
      const handle = f.broker.registerCompactionContext({ snapshot: a.snapshot, contract: "native", transactionToken: transaction.token,
        handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "writer", expiresAt: Date.now() + 30_000 });
      await expect(f.broker.waitForCompactionHandoff(transaction.token)).rejects.toThrow("timed out");
      expect(() => f.broker.markCompactionContextDelivered(handle.compactionToken)).toThrow("no longer active");
    }
  } finally { await f.close(); }
});


test("overview refusals preserve complete required-image token and wire reserves", () => {
  const registration = plan("protected-image");
  const target = registration.snapshot.targets.find(target => target.kind === "image")!;
  const probe = new ContextScope("image-cost-probe", registration, "normal", () => {}, () => {});
  probe.markEntryDelivered();
  const sampled = probe.prepare("read", { context_id: registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
  const cost = measureContextResponse(sampled.result, { visualTokens: target.visual_token_reserve! });
  probe.finish(sampled.receiptId, true); probe.retire();
  const errors = contextErrorReserve();
  const scope = new ContextScope("protected-image", { ...registration,
    requiredImageTokenReserves: { [target.target_id]: cost.total_tokens }, requiredImageWireReserves: { [target.target_id]: cost.wire_bytes },
    remainingBudget: { tokens: cost.total_tokens + errors.tokens + 501, reserved_tokens: 500,
      wire_bytes: cost.wire_bytes + errors.wire_bytes + 101, reserved_wire_bytes: 100 } }, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    const rejected = scope.prepare("list", { context_id: registration.snapshot.context_id, view: "overview" });
    expect(rejected.result.isError).toBe(true); scope.finish(rejected.receiptId, true);
    const errorCost = scope.navigator.usage(); expect(errorCost.wire_bytes).toBeGreaterThan(0); expect(errorCost.text_tokens).toBeGreaterThan(0);
    const read = scope.prepare("read", { context_id: registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
    expect(read.result.isError).not.toBe(true); scope.finish(read.receiptId, true);
    expect(scope.status().context_ready).toBe(true);
    const usage = scope.navigator.usage();
    expect(usage.error_responses).toBe(1); expect(usage.wire_bytes).toBe(cost.wire_bytes + errorCost.wire_bytes); expect(usage.text_tokens).toBe(cost.text_tokens + errorCost.text_tokens);
    expect(usage.wire_bytes).toBeLessThanOrEqual(cost.wire_bytes + errors.wire_bytes + 1);
    expect(usage.text_tokens + usage.visual_token_reserve).toBeLessThanOrEqual(cost.total_tokens + errors.tokens + 1);
  } finally { scope.retire(); }
});

test("shared context capacity protects required images without charging work twice", () => {
  const registration = plan("local-required-reserve");
  const target = registration.snapshot.targets.find(target => target.kind === "image")!;
  const probe = new ContextScope("local-cost-probe", registration, "normal", () => {}, () => {});
  probe.markEntryDelivered();
  const sampled = probe.prepare("read", { context_id: registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
  const cost = measureContextResponse(sampled.result, { visualTokens: target.visual_token_reserve! });
  probe.finish(sampled.receiptId, true); probe.retire();
  const errors = contextErrorReserve();
  const scope = new ContextScope("local-required-reserve", { ...registration,
    requiredImageTokenReserves: { [target.target_id]: cost.total_tokens }, requiredImageWireReserves: { [target.target_id]: cost.wire_bytes },
    remainingBudget: { tokens: cost.total_tokens + errors.tokens + 20_001, reserved_tokens: 20_000,
      wire_bytes: cost.wire_bytes + errors.wire_bytes + 20_001, reserved_wire_bytes: 20_000 } }, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    const rejected = scope.prepare("list", { context_id: registration.snapshot.context_id, view: "overview" });
    expect(rejected.result.isError).toBe(true); scope.finish(rejected.receiptId, true);
    const image = scope.prepare("read", { context_id: registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
    expect(image.result.isError).not.toBe(true); scope.finish(image.receiptId, true);
    expect(scope.status().context_ready).toBe(true);
  } finally { scope.retire(); }
});

test("finite compaction refusals retire only navigation and preserve summary token and wire reserves", () => {
  const registration = plan("protected-summary", false); const errors = contextErrorReserve();
  expect(() => new ContextScope("invalid-publication", { ...registration, remainingBudget: { tokens: 501, reserved_tokens: 500, wire_bytes: 64 * 1024 * 1024 } }, "compaction", () => {}, () => {})).toThrow();
  const scope = new ContextScope("protected-summary", { ...registration,
    remainingBudget: { tokens: errors.tokens + 501, reserved_tokens: 500, wire_bytes: errors.wire_bytes + 101, reserved_wire_bytes: 100 } }, "compaction", () => {}, () => {});
  try {
    scope.markEntryDelivered();
    for (let count = 0; count < 3; count++) {
      const rejected = scope.prepare("list", { context_id: registration.snapshot.context_id, view: "overview" });
      expect(rejected.result.isError).toBe(true); scope.finish(rejected.receiptId, true);
      expect(() => scope.guardCommit()).not.toThrow();
    }
    expect(scope.navigator.usage().navigation_stopped).toBe(true);
    const before = scope.navigator.usage();
    expect(() => scope.prepare("list", { context_id: registration.snapshot.context_id, view: "overview" })).toThrow("navigation capability is retired");
    expect(scope.navigator.usage()).toEqual(before); expect(scope.isLive).toBe(true);
    expect(() => scope.guardCommit()).not.toThrow();
  } finally { scope.retire(); }
});

for (const dimension of ["count", "bytes"] as const) for (const firstRequired of [false, true]) {
  test(`${dimension} reserves keep an unread required image available after ${firstRequired ? "delivered required" : "optional"} image repeats`, () => {
    const source = createContextSnapshot(parseRequest({ model: "gpt-5", input: [{ role: "user", content: [
      { type: "input_image", image_url: `data:image/png;base64,${image}` },
      { type: "input_image", image_url: `data:image/png;base64,${image}` },
    ] }] }));
    const [first, required] = source.targets.filter(target => target.kind === "image");
    let failed: Error | undefined;
    const scope = new ContextScope(`reserve-${dimension}-${firstRequired}`, {
      snapshot: source, planId: "bounded-images", manifestDigest: "bounded-images",
      deliveryByTarget: { [first!.target_id]: { delivery: "on_demand", media_route: "mcp", required: firstRequired },
        [required!.target_id]: { delivery: "on_demand", media_route: "mcp", required: true } },
      limits: dimension === "count" ? { maxImageReads: 2 } : { maxTotalImageBytes: first!.image_bytes! + required!.image_bytes! },
    }, "normal", () => {}, error => { failed = error; });
    try {
      scope.markEntryDelivered();
      const read = (read_ref: string) => scope.prepare("read", { context_id: source.context_id, reads: [{ read_ref }] });
      const firstReturn = read(first!.read_ref!); expect(firstReturn.result.isError).not.toBe(true);
      scope.finish(firstReturn.receiptId, true);
      const duplicate = read(first!.read_ref!); expect(duplicate.result.structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } });
      scope.finish(duplicate.receiptId, true); expect(failed).toBeUndefined();
      const requiredReturn = read(required!.read_ref!); expect(requiredReturn.result.isError).not.toBe(true);
      expect(scope.status().context_ready).toBe(false);
      scope.finish(requiredReturn.receiptId, true); expect(scope.status().context_ready).toBe(true);
      expect(scope.navigator.usage().image_reads).toBe(2);
      expect(scope.navigator.usage().image_bytes).toBe(first!.image_bytes! + required!.image_bytes!);
      expect(failed).toBeUndefined();
    } finally { scope.retire(); }
  });
}

test("in-flight required images spend their reserve once and gain coverage only after successful receipts", () => {
  const source = createContextSnapshot(parseRequest({ model: "gpt-5", input: [{ role: "user", content: [
    { type: "input_image", image_url: `data:image/png;base64,${image}` },
    { type: "input_image", image_url: `data:image/png;base64,${image}` },
  ] }] }));
  const targets = source.targets.filter(target => target.kind === "image");
  const registration: ContextPlanRegistration = { snapshot: source, planId: "in-flight-images", manifestDigest: "in-flight-images",
    deliveryByTarget: Object.fromEntries(targets.map(target => [target.target_id, { delivery: "on_demand", media_route: "mcp", required: true }])),
    limits: { maxImageReads: 2, maxTotalImageBytes: targets.reduce((sum, target) => sum + target.image_bytes!, 0) } };
  expect(() => new ContextScope("impossible-images", { ...registration, limits: { maxImageReads: 1 } }, "normal", () => {}, () => {})).toThrow();
  const scope = new ContextScope("in-flight-images", registration, "normal", () => {}, error => { throw error; });
  try {
    scope.markEntryDelivered();
    const read = (index: number) => scope.prepare("read", { context_id: source.context_id, reads: [{ read_ref: targets[index]!.read_ref! }] });
    const first = read(0); expect(first.result.isError).not.toBe(true);
    const usage = scope.navigator.usage();
    expect(() => read(0)).toThrow("in-flight return"); expect(scope.navigator.usage()).toEqual(usage);
    const second = read(1); expect(second.result.isError).not.toBe(true);
    expect(scope.status().delivered_images).toBe(0);
    scope.finish(first.receiptId, true); expect(scope.status().delivered_images).toBe(1);
    scope.finish(second.receiptId, false); expect(scope.status().delivered_images).toBe(1);
    expect(scope.status().context_ready).toBe(false); expect(scope.inFlight).toBe(0);
  } finally { scope.retire(); }
});

for (const remote of [false, true]) test(`${remote ? "Remote" : "Local"} owner usage stays monotonic across cancelled returns and source retirement`, async () => {
  const f = await fixture(remote); const registration = plan("usage-settlement");
  const target = registration.snapshot.targets.find(target => target.kind === "image")!;
  const probe = new ContextScope("usage-cost", registration, "normal", () => {}, () => {});
  probe.markEntryDelivered();
  const sampled = probe.prepare("read", { context_id: registration.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
  const cost = measureContextResponse(sampled.result, { visualTokens: target.visual_token_reserve! });
  probe.finish(sampled.receiptId, true); probe.retire();
  registration.requiredImageTokenReserves = { [target.target_id]: cost.total_tokens };
  try {
    await f.owner.registerContextPlan(f.token, registration, ownerContext);
    await f.owner.selectContextPlan(f.token, registration.planId, ownerContext);
    await f.owner.markContextPlanSent(f.token, registration.planId, ownerContext);
    const first = await f.query(registration); await f.finish(first, false);
    const cancelled = (await f.owner.contextUsage(f.token))!;
    expect(cancelled.final).toBe(false); expect(cancelled.reserved_tokens_used).toBe(cost.total_tokens);
    expect(cancelled.usage.image_reads).toBe(1); expect(cancelled.usage.wire_bytes).toBe(cost.wire_bytes);
    const second = await f.query(registration); await f.finish(second, true);
    const repeated = (await f.owner.contextUsage(f.token))!;
    expect(repeated.reserved_tokens_used).toBe(cost.total_tokens); expect(repeated.usage.image_reads).toBe(2);
    expect(repeated.usage.text_tokens + repeated.usage.visual_token_reserve).toBe(cost.total_tokens * 2);
    const error = await f.query(registration, false, { contextArgs: { context_id: registration.snapshot.context_id, view: "entries", cursor: "invalid" } });
    await f.finish(error, true);
    const current = (await f.owner.contextUsage(f.token))!;
    expect(current.usage.text_tokens).toBeGreaterThan(repeated.usage.text_tokens); expect(current.usage.error_responses).toBe(1);
    await f.owner.revoke(f.token, new Error("usage settlement test"), ownerContext);
    const final = await f.owner.contextUsage(f.token);
    expect(final!.reuse_diagnostics!.elapsed_ms).toBeGreaterThanOrEqual(current.reuse_diagnostics!.elapsed_ms);
    expect(final).toEqual({ ...current, final: true,
      reuse_diagnostics: { ...current.reuse_diagnostics!, elapsed_ms: final!.reuse_diagnostics!.elapsed_ms } });
    expect(await f.owner.contextStatus(f.token)).toBeUndefined();
    await expect(callTurnBroker(f.socket, { method: "owner_context_usage", token: f.token, contextProtocol: 999 })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    await f.owner.releaseContextUsage(f.token); expect(await f.owner.contextUsage(f.token)).toBeUndefined();
  } finally { await f.close(); }
});

test("verification arming failure retires the unpublished ordinary capability", async () => {
  const f = await fixture(true); const normal = plan("invalid-verification", false);
  try {
    await expect(f.owner.armContextVerification(f.token, { normal, compactionSnapshot: normal.snapshot, expiresAt: Date.now() + 600_000 }, ownerContext)).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    await expect(f.start(1)).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
  } finally { await f.close(); }
});

test("verification expiry retires both source credentials", async () => {
  const f = await fixture(true); const normal = plan("expiring-verification", false);
  try {
    const pair = await f.owner.armContextVerification(f.token, { normal, compactionSnapshot: normal.snapshot, expiresAt: Date.now() + 100 }, ownerContext);
    await f.owner.markContextVerificationDelivered(pair.pairToken);
    await new Promise(resolve => setTimeout(resolve, 130));
    expect(await f.owner.contextVerificationStatus(pair.pairToken)).toBeUndefined();
    await expect(f.query(normal)).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
    await expect(callTurnBroker(f.socket, { method: "context_query", token: pair.compactionToken, contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION,
      contextMethod: "list", contextArgs: { context_id: pair.compactionContextId, view: "overview" } })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
  } finally { await f.close(); }
});
