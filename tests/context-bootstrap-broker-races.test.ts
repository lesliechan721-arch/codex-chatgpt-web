import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { appendFixedContextRecords, createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { CONTEXT_PROTOCOL_VERSION, type ContextPlanRegistration, type ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import type { ContextReadArgs } from "../src/adapters/chatgpt-web/context-types";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import type { TaskUpdateAckResult, TaskUpdateTransfer } from "../src/adapters/chatgpt-web/task-update-protocol";

const nonce = "bootstrap-races-surface-123456789";
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const context = (revision: number, acknowledgedRevision = revision) => ({ expectedDriverGeneration: revision, taskRevision: revision, acknowledgedRevision });
const actual: BrokerToolResult = { content: [{ type: "text", text: "original pending operation completed" }] };

async function fixture(contract: "native" | "safe", requireSent = false) {
  const directory = mkdtempSync(join(tmpdir(), "ctx-boot-race-")), socket = defaultBrokerEndpoint(directory);
  const broker = TurnBroker.forSocket(socket); await broker.listen();
  const owner = new RemoteTurnBroker(socket);
  const environment = { authorityMode: "delegated" as const, threadId: "bootstrap-races-thread", turnId: "bootstrap-races-turn", tools: [{
    name: "exec_command", description: "Execute", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  }] };
  const token = contract === "safe" ? await owner.registerSafe(environment, nonce, undefined, "bootstrap-races", {
    taskUpdateProtocol: 1, requireSentConfirmation: requireSent }) : await owner.register(environment, undefined, "bootstrap-races", { taskUpdateProtocol: 1 });
  const request = { token, contract, credentialKind: "ordinary" as const, contextProtocol: CONTEXT_PROTOCOL_VERSION, contextBootstrapProtocol: "context-bootstrap-v1" };
  const start = () => callTurnBroker<any>(socket, { method: "safe_start", ...request });
  const query = (plan: ContextPlanRegistration, args?: ContextReadArgs) => callTurnBroker<ContextPreparedReply>(socket, {
    method: "context_query", ...request, contextMethod: args ? "read" : "list",
    contextArgs: args ?? { context_id: plan.snapshot.context_id, view: "overview" },
  });
  const finish = async (reply: ContextPreparedReply) => {
    const textReadReceipt = !reply.result.isError && (reply.result.content[1] as { type?: string } | undefined)?.type === "text"
      ? contextTextReadReceipt(reply.result) : undefined;
    await callTurnBroker(socket, { method: "context_return_check", ...request, receiptId: reply.receiptId, textReadReceipt });
    return callTurnBroker(socket, { method: "context_return", ...request, receiptId: reply.receiptId, textReadReceipt, sent: true });
  };
  const operation = (operationId: number, taskRevision: number) => callTurnBroker<NativeOperationReply>(socket, {
    method: "native_operation_start", token, contract, nativeWaitProtocol: 1, taskUpdateProtocol: 1,
    operationId, taskRevision, entry: "codex_exec", nativeInput: { cmd: `operation-${operationId}` }, waitMs: 1,
  });
  const wait = (operationId: number) => callTurnBroker<NativeOperationReply>(socket, {
    method: "native_operation_wait", token, contract, nativeWaitProtocol: 1, operationId, waitMs: 1,
  });
  const ack = (deliveryId: string, throughRevision: number) => callTurnBroker<TaskUpdateAckResult>(socket, {
    method: "task_update_ack", token, contract, taskUpdateProtocol: 1, deliveryId, throughRevision,
  });
  const transfer = (name: string, revision: number, results: TaskUpdateTransfer["results"], mode: TaskUpdateTransfer["mode"] = "results"): TaskUpdateTransfer => ({
    transferId: `transfer-${name}`, payloadDigest: `payload-${name}`, expectedDriverGeneration: revision, expectedRevision: revision,
    environment, updates: [{ revision: revision + 1, sourceMessageId: `message-${name}`, payloadDigest: `message-digest-${name}`,
      content: `Exact user addition ${name} 中文😀  \n` }], results, mode, batchFingerprint: "original-batch",
  });
  const accept = async (value: TaskUpdateTransfer) => {
    await owner.reserveTaskUpdate(token, value.transferId, value.payloadDigest, context(value.expectedRevision));
    return owner.acceptTaskUpdate(token, value);
  };
  const complete = (revision: number) => callTurnBroker(socket, { method: "safe_complete", token,
    finalAnswer: "complete required context", taskRevision: revision, taskUpdateProtocol: 1 });
  return { broker, owner, socket, token, start, query, finish, operation, wait, ack, transfer, accept, complete,
    close: async () => { await owner.revokeTrusted(token); await broker.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function plan(withImages: boolean): ContextPlanRegistration {
  const base = createContextSnapshot(parseRequest({ model: "gpt-6", input: withImages ? [{ role: "user", content: [
    { type: "input_image", image_url: `data:image/png;base64,${image}` },
    { type: "input_image", image_url: `data:image/png;base64,${image}` },
  ] }] : [] }));
  const snapshot = appendFixedContextRecords(base, [{ text: "Required original instruction 中文😀. ".repeat(180) + "LAST_REQUIRED_RULE",
    encoding: "utf-8", origin: "context_bootstrap_payload" }]);
  return { snapshot, planId: "races-plan", manifestDigest: "races-manifest", startupProtocol: "context-bootstrap-v1",
    limits: { readBytes: 4000, readTokens: 1500 }, deliveryByTarget: Object.fromEntries(snapshot.targets.map(target => [target.target_id,
      target.kind === "image" ? { delivery: target.target_id === "t_1" ? "on_demand" : "attachment", required: true,
        media_route: target.target_id === "t_1" ? "mcp" : "attachment" } : { delivery: "source_required", required: true }])) };
}
async function select(f: Awaited<ReturnType<typeof fixture>>, value: ContextPlanRegistration, contract: "native" | "safe") {
  await f.owner.registerContextPlan(f.token, value, context(0));
  await f.owner.selectContextPlan(f.token, value.planId, context(0));
  if (contract === "native") await f.owner.markContextPlanSent(f.token, value.planId, context(0));
}
async function readAll(f: Awaited<ReturnType<typeof fixture>>, value: ContextPlanRegistration) {
  let pages = 0;
  for (;;) {
    const status = (await f.owner.contextStatus(f.token))!;
    if (status.context_ready) return pages;
    expect(status.next_required_read).not.toBeNull();
    const reply = await f.query(value, status.next_required_read!.arguments);
    expect(reply.result.isError).not.toBe(true); await f.finish(reply);
    expect(++pages).toBeLessThan(100);
  }
}

for (const mode of [{ contract: "native", sent: false }, { contract: "safe", sent: false }, { contract: "safe", sent: true }] as const)
test(`bootstrap mixed text/MCP/attachments remain independent (${mode.contract}, Sent=${mode.sent})`, async () => {
  const f = await fixture(mode.contract, mode.sent), value = plan(true);
  try {
    await select(f, value, mode.contract);
    if (mode.contract === "safe") {
      await expect(f.query(value)).rejects.toBeDefined();
      const first = await f.start();
      expect(first.context_bootstrap).toMatchObject({ plan_id: value.planId, manifest_digest: value.manifestDigest,
        read_state: mode.sent ? "waiting" : "readable" });
      if (mode.sent) {
        const usage = await f.owner.contextUsage(f.token);
        expect(await f.start()).toMatchObject({ duplicate: true, context_bootstrap: { read_state: "waiting" } });
        expect((await f.owner.contextUsage(f.token))?.usage).toEqual(usage?.usage);
        await expect(f.query(value)).rejects.toBeDefined();
        await f.owner.confirmSafeTurnSent(f.token, nonce);
        expect(await f.start()).toMatchObject({ duplicate: true, context_bootstrap: { read_state: "readable" } });
      }
    }
    const text = value.snapshot.targets.find(t => t.kind !== "image")!;
    const page = await f.query(value, { context_id: value.snapshot.context_id, read_ref: text.read_ref! });
    expect(parseContextTextReadResult(page.result).metadata.has_more).toBe(true); await f.finish(page);
    expect(await f.owner.contextStatus(f.token)).toMatchObject({ text_ready: false, images_ready: false, delivered_images: 0 });
    const before = (await f.owner.contextStatus(f.token))!;
    expect(before.next_required_read!.arguments.read_ref).toBe(value.snapshot.targets[0]!.read_ref!);
    await f.finish(await f.query(value, before.next_required_read!.arguments));
    expect(await f.owner.contextStatus(f.token)).toMatchObject({ delivered_images: 1, images_ready: false, text_ready: false });
    await expect(f.owner.confirmContextAttachments(f.token, { planId: value.planId, manifestDigest: "wrong" }, context(0)))
      .rejects.toMatchObject({ code: "CONTEXT_INVALID" });
    await f.owner.confirmContextAttachments(f.token, { planId: value.planId, manifestDigest: value.manifestDigest }, context(0));
    expect(await f.owner.contextStatus(f.token)).toMatchObject({ delivered_images: 2, images_ready: true, text_ready: false, context_ready: false });
    if (mode.contract === "safe") await expect(f.complete(0)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    else await expect(f.owner.beginFinalOutput(f.token, context(0))).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    expect(await readAll(f, value)).toBeGreaterThan(0);
    if (mode.contract === "safe") expect(await f.complete(0)).toMatchObject({ completed: true });
    else {
      const fence = await f.owner.beginCompletionFence(f.token, context(0));
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(0))).toBe(true);
    }
  } finally { await f.close(); }
});

for (const contract of ["native", "safe"] as const)
test(`bootstrap keeps fixed source receipts separate from real update/ACK/final locks (${contract})`, async () => {
  const f = await fixture(contract), value = plan(false);
  try {
    if (contract === "safe") await f.start();
    // A retained operation may settle while a new source entry is being delivered.
    expect(await f.operation(1, 0)).toMatchObject({ kind: "pending" });
    const [previous] = await f.owner.nextToolBatch(f.token, undefined, context(0));
    await select(f, value, contract);
    const first = f.transfer("before-read", 0, [{ callId: previous!.callId, result: actual }]);
    expect(await f.accept(first)).toMatchObject({ status: "committed" });
    const delivery1 = (await f.wait(1)).taskUpdate!;
    expect(delivery1).toMatchObject({ throughRevision: 1, updates: [{ content: first.updates[0]!.content }] });
    const text = value.snapshot.targets[0]!;
    const inFlight = await f.query(value, { context_id: value.snapshot.context_id, read_ref: text.read_ref! });
    const fixedPage = parseContextTextReadResult(inFlight.result);
    const during = f.transfer("during-read", 1, [], "continuity");
    expect(await f.accept(during)).toMatchObject({ status: "committed", state: { acceptedRevision: 2, acknowledgedRevision: 0 } });
    await f.finish(inFlight);
    expect(await f.owner.taskUpdateState(f.token)).toMatchObject({ acceptedRevision: 2, acknowledgedRevision: 0 });
    expect(await f.owner.contextStatus(f.token)).toMatchObject({ text_ready: false, delivered_text_bytes: fixedPage.metadata.range.end_exclusive });
    const manifest = await f.query(value); await f.finish(manifest);
    expect(manifest.result.structuredContent).toMatchObject({ context_id: value.snapshot.context_id, plan_id: value.planId,
      manifest_digest: value.manifestDigest, revision: 2, acknowledged_revision: 0 });
    const ack1 = await f.ack(delivery1.deliveryId, 1);
    expect(ack1).toMatchObject({ acknowledgedRevision: 1, acceptedRevision: 2, taskUpdate: { throughRevision: 2 } });
    expect(await f.ack(ack1.taskUpdate!.deliveryId, 2)).toMatchObject({ acknowledgedRevision: 2, acceptedRevision: 2 });
    expect(await f.owner.contextStatus(f.token)).toMatchObject({ text_ready: false });
    if (contract === "safe") await expect(f.complete(2)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    else await expect(f.owner.beginFinalOutput(f.token, context(2))).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await readAll(f, value);
    expect(await f.operation(2, 2)).toMatchObject({ kind: "pending" });
    const [next] = await f.owner.nextToolBatch(f.token, undefined, context(2));
    expect(await f.accept(f.transfer("after-read", 2, [{ callId: next!.callId, result: actual }]))).toMatchObject({ status: "committed" });
    const delivery3 = (await f.wait(2)).taskUpdate!;
    const stale = context(3, 2);
    await expect(f.owner.beginCompletionFence(f.token, stale)).rejects.toMatchObject({ code: "task_update_unacknowledged" });
    await f.ack(delivery3.deliveryId, 3);
    await expect(f.owner.beginFinalOutput(f.token, stale)).rejects.toMatchObject({ code: "task_update_unacknowledged" });
    expect(await f.owner.beginFinalOutput(f.token, context(3))).toMatchObject({ kind: "output_started", taskRevision: 3 });
    expect(await f.ack(delivery3.deliveryId, 3)).toMatchObject({ ignored: "final_output_started" });
    const late = f.transfer("after-final", 3, [], "continuity");
    await expect(f.owner.reserveTaskUpdate(f.token, late.transferId, late.payloadDigest, context(3)))
      .rejects.toMatchObject({ code: "task_update_final_output_started" });
    expect(await f.owner.taskUpdateState(f.token)).toMatchObject({ finalOutputRevision: 3, acknowledgedRevision: 3 });
    if (contract === "safe") expect(await f.complete(3)).toMatchObject({ completed: true });
    else {
      const fence = await f.owner.beginCompletionFence(f.token, context(3));
      expect(await f.owner.commitCompletionFence(f.token, fence!, context(3))).toBe(true);
    }
  } finally { await f.close(); }
});
