import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defaultBrokerEndpoint } from "../src/config";
import { TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { completeRecoveryWork, recoveryDigest, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { observeResourceBrokerControl, resourceSuccessorControlEvidence, resourceSuccessorRevisionEvidence, summarizeResourceTaskUpdateJournal } from "../scripts/unified-task-continuity-resource-control";
import { inspectOldLiveFencingEvidence } from "../scripts/validate-unified-task-continuity-resources";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("successor oracle rejects ACK before delivery and binds the final session identity", () => {
  const identity = { workDigest: digest("B"), traceDigest: digest("synthetic-final-trace"), tokenDigest: digest("synthetic-current-token"), attempt: 1, epoch: 1 };
  const prepared = { ...identity, observationSequence: 1, selected: true };
  const send = { ...identity, observationSequence: 2, kind: "accepted-receipt" };
  // Pure oracle fixtures; these do not claim a real Send or a Broker delivery observation.
  const returned = { ...identity, origin: "connector", observationSequence: 3, stage: "broker-returned", methodBoundary: "broker-wire-dispatch",
    method: "native_operation_start", delivery: { protocolVersion: 1, deliveryDigest: digest("synthetic-delivery"), throughRevision: 1 } };
  const ack = { ...identity, origin: "connector", observationSequence: 4, stage: "broker-returned", methodBoundary: "broker-wire-dispatch",
    method: "task_update_ack", deliveryDigest: digest("synthetic-delivery"), acknowledgedRevision: 1, acceptedRevision: 1 };
  const inspect = (events: any[], expected = identity, plan = prepared, sent = send) =>
    resourceSuccessorControlEvidence(events, digest("synthetic-old-token"), 1, expected, plan, sent);
  // The original membership-only implementation incorrectly accepts this exact inverse order.
  expect(inspect([ack, returned]).passed).toBe(false);
  expect(inspect([returned, ack]).passed).toBe(true);
  expect(inspect([{ ...returned, observationSequence: 5 }, ack]).passed).toBe(false);
  for (const changed of [{ attempt: 2 }, { epoch: 2 }, { traceDigest: digest("another-trace") }, { tokenDigest: digest("another-token") }]) {
    expect(inspect([returned, ack], { ...identity, ...changed }).passed).toBe(false);
    expect(inspect([{ ...returned, ...changed }, ack]).passed).toBe(false);
    expect(inspect([returned, { ...ack, ...changed }]).passed).toBe(false);
  }
  expect(inspect([returned, ack], identity, { ...prepared, observationSequence: 3 }).passed).toBe(false);
  expect(inspect([returned, ack], identity, prepared, { ...send, observationSequence: 4 }).passed).toBe(false);
  expect(inspect([returned, ack], identity, { ...prepared, traceDigest: digest("another-trace") }).passed).toBe(false);
  expect(inspect([returned, ack], identity, prepared, { ...send, traceDigest: digest("another-trace") }).passed).toBe(false);
});

test("real durable Broker/MCP observes successor delivery and ACK without dispatching another business call", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-resource-observe-"));
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory), owner = continuityProcessInstance();
  const thread = "1".repeat(64), scope = "2".repeat(64);
  store.admitWork({ thread, scope, owner, logicalWorkId: "A", instructionIdentity: "synthetic-original", workPayloadDigest: "3".repeat(64),
    snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true });
  const environment = { authorityMode: "delegated" as const, threadId: "resource-observe-thread", turnId: "resource-observe-turn", tools: [{
    name: "unified_resource_receipt", description: "Inert receipt", parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  }] };
  const old = TurnBroker.forSocket(defaultBrokerEndpoint(join(directory, "old"))), next = TurnBroker.forSocket(defaultBrokerEndpoint(join(directory, "next")));
  const events: Record<string, any>[] = [], secrets: string[] = [];
  let observationSequence = 0;
  const nextObservation = () => ++observationSequence;
  const actualNextAck = next.acknowledgeTaskUpdate, syncAckReturns: ReturnType<typeof next.acknowledgeTaskUpdate>[] = [];
  next.acknowledgeTaskUpdate = function(...args) { const result = actualNextAck.apply(this, args); syncAckReturns.push(result); return result; };
  const originalOldDispatch = (old as any).dispatch, originalNextAck = next.acknowledgeTaskUpdate;
  const restoreOld = observeResourceBrokerControl(old, row => events.push(row), value => secrets.push(value), () => ({ origin: "connector" }), nextObservation);
  const restoreNext = observeResourceBrokerControl(next, row => events.push(row), value => secrets.push(value), () => ({ origin: "connector" }), nextObservation);
  const clients: Client[] = [];
  const connect = async (broker: TurnBroker) => {
    const client = new Client({ name: "resource-observation-test", version: "1" }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", "native", "--broker-socket", broker.socketPath], cwd: process.cwd(), stderr: "pipe" }));
    return client;
  };
  try {
    const token = await old.register(environment, undefined, "synthetic-old", { recovery: { directory, thread, logicalWorkId: "A", attempt: 0 }, taskUpdateProtocol: 1 });
    const source = await connect(old);
    const executing = source.callTool({ name: "codex_tool_call", arguments: { turn_token: token, operation_id: 1, task_revision: 0,
      wire_name: "unified_resource_receipt", arguments: {} } });
    const [call] = await old.nextToolBatch(token, undefined, { taskRevision: 0, expectedDriverGeneration: 0 });
    expect(call!.wireName).toBe("unified_resource_receipt"); expect(call!.arguments).toEqual({});
    const body = "Synthetic accepted constraint remains in force.";
    const update = { revision: 1, sourceMessageId: "synthetic-update", content: body, payloadDigest: recoveryDigest(body) };
    const result: BrokerToolResult = { content: [{ type: "text", text: "INERTRECEIPT" }] };
    const outer = { type: "function_call_output", call_id: call!.callId, output: "INERTRECEIPT" };
    const transfer = { transferId: "synthetic-transfer", payloadDigest: "synthetic-transfer-payload", expectedDriverGeneration: 0, expectedRevision: 0,
      environment, updates: [update], results: [{ callId: call!.callId, result }], batchFingerprint: "synthetic-batch", mode: "continuity" as const,
      recovery: { logicalWorkId: "B", instructionIdentity: "synthetic-update", nativeTurnId: environment.turnId, workPayloadDigest: "5".repeat(64),
        snapshotDigest: "6".repeat(64), localSessionId: "synthetic-old", localTaskRevision: 1,
        results: [{ callId: call!.callId, resultType: outer.type, resultDigest: recoveryResultDigest(outer) }] } };
    await old.reserveTaskUpdate(token, transfer.transferId, transfer.payloadDigest, { taskRevision: 0, expectedDriverGeneration: 0 }, true);
    expect(await old.acceptTaskUpdate(token, transfer)).toMatchObject({ status: "committed" });
    const first = await executing, oldDelivery = (first.structuredContent as any).task_update;
    expect((first.structuredContent as any).native_result).toEqual(result);
    expect(events.some(row => row.stage === "broker-returned" && row.delivery?.deliveryDigest === digest(oldDelivery.deliveryId))).toBe(true);
    const before = store.get(thread)!; expect(Object.keys(before.calls)).toHaveLength(1);
    store.retireAttempt(thread, { scope }, "B", 0);
    store.reserveRecovery(thread, { scope }, { logicalWorkId: "B", owner, snapshotDigest: "6".repeat(64) });
    const successorToken = await next.register(environment, undefined, "synthetic-successor", { recovery: { directory, thread, logicalWorkId: "B", attempt: 1 },
      taskUpdateProtocol: 1, recoveryTaskUpdateSources: [update] });
    const successor = await connect(next);
    const rejectedOld = await source.callTool({ name: "codex_task_update_ack", arguments: { turn_token: token,
      delivery_id: oldDelivery.deliveryId, through_revision: 1 } }); expect(rejectedOld.isError).toBe(true);
    const knownRevision = next.taskUpdateState(successorToken)!.acknowledgedRevision; expect(knownRevision).toBe(0);
    const identity = { workDigest: digest("B"), traceDigest: digest("synthetic-successor"), tokenDigest: digest(successorToken), attempt: 1, epoch: 1 };
    // Only ordering-oracle lower bounds are synthetic here. All delivery/ACK events below
    // are observed from the original Broker through real MCP. This test sends no model message.
    const prepared = { ...identity, selected: true, observationSequence: nextObservation() };
    const send = { ...identity, kind: "accepted-receipt", observationSequence: nextObservation() };
    const inventory = await successor.callTool({ name: "codex_tool_inventory", arguments: { turn_token: successorToken, operation_id: 2, task_revision: knownRevision } });
    const currentDelivery = (inventory.structuredContent as any).task_update;
    expect(currentDelivery).toMatchObject({ protocolVersion: 1, fromRevision: 1, throughRevision: 1, updates: [update] });
    expect(currentDelivery.deliveryId).not.toBe(oldDelivery.deliveryId);
    expect(() => next.beginFinalOutput(successorToken, { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 0 })).toThrow();
    expect(store.get(thread)!.works.B!.taskUpdateJournal!.acknowledgedRevision).toBe(0);
    const rejectedHistorical = await successor.callTool({ name: "codex_task_update_ack", arguments: { turn_token: successorToken,
      delivery_id: oldDelivery.deliveryId, through_revision: 1 } }); expect(rejectedHistorical.isError).toBe(true);
    const ack = await successor.callTool({ name: "codex_task_update_ack", arguments: { turn_token: successorToken,
      delivery_id: currentDelivery.deliveryId, through_revision: currentDelivery.throughRevision } });
    expect(ack.structuredContent).toEqual({ acceptedRevision: 1, acknowledgedRevision: 1 });
    const restoreBroken = observeResourceBrokerControl(next, () => { throw new Error("synthetic broken sink"); }, () => { throw new Error("synthetic collector failure"); });
    try {
      const synchronous = next.acknowledgeTaskUpdate(successorToken, currentDelivery.deliveryId, 1, "native");
      expect(synchronous).toBe(syncAckReturns.at(-1)!); expect(synchronous instanceof Promise).toBe(false);
    } finally { restoreBroken(); }
    const newReturn = events.find(row => row.stage === "broker-returned" && row.delivery?.deliveryDigest === digest(currentDelivery.deliveryId));
    expect(newReturn).toMatchObject({ method: "native_operation_start", entry: "codex_tool_inventory", tokenDigest: digest(successorToken), epoch: 1, attempt: 1 });
    expect(newReturn!.delivery).toMatchObject({ protocolVersion: 1, fromRevision: 1, throughRevision: 1, updateCount: 1 });
    expect(newReturn!.delivery.updates).toEqual([{ revision: 1, sourceDigest: digest(update.sourceMessageId), payloadDigest: update.payloadDigest, bodyDigest: digest(body) }]);
    expect(events.some(row => row.stage === "broker-returned" && row.method === "task_update_ack" && row.deliveryDigest === digest(currentDelivery.deliveryId)
      && row.acknowledgedRevision === 1 && row.tokenDigest === digest(successorToken))).toBe(true);
    expect(events.some(row => row.stage === "broker-rejected" && row.method === "task_update_ack")).toBe(true);
    expect(events.some(row => row.stage === "mcp-sent" || row.modelReceived === true)).toBe(false);
    expect(resourceSuccessorControlEvidence(events, digest(token), 1, identity, prepared, send)).toMatchObject({ passed: true, preparedSendBound: true, ordered: true,
      brokerReturnedCurrentDelivery: true, actualCurrentAckReturned: true, traceDigest: identity.traceDigest, epoch: 1, attempt: 1 });
    expect(resourceSuccessorControlEvidence(events.filter(row => row.delivery?.deliveryDigest !== digest(currentDelivery.deliveryId)), digest(token), 1, identity, prepared, send).passed).toBe(false);
    expect(resourceSuccessorControlEvidence(events.filter(row => row.method !== "task_update_ack"), digest(token), 1, identity, prepared, send).passed).toBe(false);
    expect(resourceSuccessorControlEvidence(events.map(row => ({ ...row, origin: "obsolete-runner-probe" })), digest(token), 1, identity, prepared, send).passed).toBe(false);
    const serialized = JSON.stringify(events);
    for (const secret of [token, successorToken, oldDelivery.deliveryId, currentDelivery.deliveryId, body, update.sourceMessageId, directory]) expect(serialized).not.toContain(secret);
    expect(secrets).toContain(token); expect(secrets).toContain(successorToken); expect(secrets).toContain(currentDelivery.deliveryId);
    expect(next.beginFinalOutput(successorToken, { expectedDriverGeneration: 1, taskRevision: 1, acknowledgedRevision: 1 }).taskRevision).toBe(1);
    completeRecoveryWork({ directory, thread, logicalWorkId: "B", attempt: 1 }, "RESOURCEDONE1");
    const after = store.get(thread)!;
    expect(Object.keys(after.calls)).toEqual(Object.keys(before.calls));
    expect(after.calls[call!.callId]!.firstResultDigest).toBe(before.calls[call!.callId]!.firstResultDigest);
    expect(after.works.B!.taskUpdateJournal!.acknowledgedRevision).toBe(1);
    const journalSummary = summarizeResourceTaskUpdateJournal(after.works.B!.taskUpdateJournal);
    expect(journalSummary).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1, pendingSources: [], observationBoundary: "durable-journal", modelReadConfirmed: false });
    expect(journalSummary!.deliveries).toContainEqual({ deliveryDigest: digest(currentDelivery.deliveryId), fromRevision: 1, throughRevision: 1, epoch: 1, attempt: 1, acknowledged: true });
    expect(JSON.stringify(journalSummary)).not.toContain(currentDelivery.deliveryId);
    // Actual production acceptance starts work A at logical revision 1 and appends B
    // at logical revision 2, while one control update has protocol revision 1.
    expect(before.works.B!.acceptedTaskRevision).toBe(2);
    expect(after.works.B!.acceptedTaskRevision).toBe(2);
    expect(after.works.B!.state).toBe("completed");
    const connectorAck = events.findLast(row => row.stage === "broker-returned" && row.methodBoundary === "broker-ack-method"
      && row.tokenDigest === digest(successorToken) && row.deliveryDigest === digest(currentDelivery.deliveryId)
      && row.workDigest === digest("B") && row.traceDigest === digest("synthetic-successor") && row.attempt === 1 && row.epoch === 1);
    expect(connectorAck).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1 });
    const revisions = resourceSuccessorRevisionEvidence(after.works.B!.acceptedTaskRevision, before.works.B!.acceptedTaskRevision,
      journalSummary, connectorAck);
    expect(revisions).toEqual({ logicalWorkAcceptedTaskRevision: 2, retiredLogicalWorkAcceptedTaskRevision: 2,
      connectorAcceptedRevision: 1, connectorAcknowledgedRevision: 1, protocolAcceptedRevision: 1, protocolAcknowledgedRevision: 1 });
    const evidence = { pending: { real: true, throughRevision: currentDelivery.throughRevision,
      beforeAcknowledgedRevision: knownRevision, afterOldProbesAcknowledgedRevision: knownRevision },
      probes: ["tool", "ACK", "final"].map(boundary => ({ boundary, rejected: true, obsolete: true, presentBefore: true, presentAfter: true })),
      successor: { originalTarget: "synthetic-old", target: "synthetic-new", oldPresentAtCompletion: true,
        revisions,
        state: after.works.B!.state, stopped: false, newWork: false, historyCleared: false, epochChanged: true, oldWorkAbsent: false, preparedProtocolFresh: false },
      closeFault: { controlled: true, attempts: 3, state: "failed" } };
    // Physical probes are oracle fixtures; revisions are actual Broker/MCP/journal facts.
    expect(inspectOldLiveFencingEvidence(evidence).passed).toBe(false);
    const inspectRevisions = (facts: typeof revisions) => inspectOldLiveFencingEvidence({ ...evidence, successor: { ...evidence.successor, revisions: facts } }).passed;
    for (const field of ["connectorAcceptedRevision", "connectorAcknowledgedRevision", "protocolAcceptedRevision", "protocolAcknowledgedRevision"] as const) {
      expect(inspectRevisions({ ...revisions, [field]: null })).toBe(false);
      expect(inspectRevisions({ ...revisions, [field]: 2 })).toBe(false);
    }
    expect(inspectRevisions(resourceSuccessorRevisionEvidence(after.works.B!.acceptedTaskRevision, before.works.B!.acceptedTaskRevision,
      undefined, connectorAck))).toBe(false);
    expect(inspectRevisions(resourceSuccessorRevisionEvidence(after.works.B!.acceptedTaskRevision, before.works.B!.acceptedTaskRevision,
      journalSummary, undefined))).toBe(false);
    expect(inspectRevisions({ ...revisions, logicalWorkAcceptedTaskRevision: 1 })).toBe(false);
    expect(inspectRevisions({ ...revisions, retiredLogicalWorkAcceptedTaskRevision: null })).toBe(false);
    expect((next as any).channels.get(successorToken).queuedCallIds).toHaveLength(0);
    expect((next as any).channels.get(successorToken).invocations.size).toBe(0);
    restoreOld(); restoreNext(); restoreOld();
    expect((old as any).dispatch).toBe(originalOldDispatch); expect(next.acknowledgeTaskUpdate).toBe(originalNextAck);
  } finally {
    restoreOld(); restoreNext();
    for (const client of clients) await client.close().catch(() => {});
    await old.close(); await next.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test("observer preserves original promise, synchronous ACK value, error identity and restoration when its sinks fail", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-resource-semantics-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  const actualAck = broker.acknowledgeTaskUpdate, actualDispatch = (broker as any).dispatch;
  let observedReturn: unknown, observedError: unknown;
  broker.acknowledgeTaskUpdate = function(...args) {
    try { observedReturn = actualAck.apply(this, args); return observedReturn as ReturnType<typeof actualAck>; }
    catch (error) { observedError = error; throw error; }
  };
  (broker as any).dispatch = function(...args: any[]) { observedReturn = actualDispatch.apply(this, args); return observedReturn; };
  const baselineAck = broker.acknowledgeTaskUpdate, baselineDispatch = (broker as any).dispatch;
  const restore = observeResourceBrokerControl(broker, () => { throw new Error("broken observer sink"); }, () => { throw new Error("broken private collector"); });
  try {
    try { broker.acknowledgeTaskUpdate("turn_" + "T".repeat(32), "delivery_" + "D".repeat(32), 1, "native"); throw new Error("must reject"); }
    catch (error) { expect(error).toBe(observedError); }
    const returned = (broker as any).dispatch({ id: "synthetic-wire-request", method: "native_operation_wait", token: "turn_" + "T".repeat(32),
      contract: "native", nativeWaitProtocol: 1, operationId: 1, waitMs: 1 });
    expect(returned).toBe(observedReturn); await expect(returned).rejects.toThrow("invalid");
    // A real no-update ACK cannot succeed, so its exact rejection is the synchronous contract.
    expect(broker.acknowledgeTaskUpdate).not.toBe(baselineAck);
    restore(); restore();
    expect(broker.acknowledgeTaskUpdate).toBe(baselineAck); expect((broker as any).dispatch).toBe(baselineDispatch);
    const newer = () => {}; broker.acknowledgeTaskUpdate = newer as any; restore(); expect<unknown>(broker.acknowledgeTaskUpdate).toBe(newer);
  } finally { restore(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});
