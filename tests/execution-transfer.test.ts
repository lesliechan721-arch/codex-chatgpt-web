import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { beginRecoverySend, settleRecoverySend, beginRecoveryAcquisition, settleRecoveryKnownUnsent, acceptRecoveryResults, assertRecoveryWriter, completeRecoveryWork, recoveryIdentity, recordRecoveryAppend } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { retainedTaskFixture } from "./helpers/retained-compaction-fixture";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { LauncherKnownUnsentReceiptError } from "../src/launcher-browser-host";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { defaultBrokerEndpoint } from "../src/config";

const thread = "1".repeat(64), scope = "2".repeat(64);
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "cgw-fence-"));
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory);
  const owner = continuityProcessInstance();
  const record = store.admitWork({ thread, scope, owner, logicalWorkId: "work", instructionIdentity: "instruction",
    workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true });
  const ref = { directory, thread, logicalWorkId: "work", attempt: 0, ownerId: owner.id };
  return { directory, store, owner, record, ref };
}

test("completed owner readback requires the original durable final identity without restoring a writer", async () => {
  const f = setup(), broker = TurnBroker.forSocket(defaultBrokerEndpoint(f.directory));
  const context = { expectedDriverGeneration: 0, taskRevision: 0 };
  try {
    const token = await broker.registerSafe({ authorityMode: "delegated", threadId: "thread", turnId: "turn", tools: [] },
      "terminal-read-surface-123456789", undefined, "terminal-read", { recovery: f.ref, taskUpdateProtocol: 1, requireSentConfirmation: false });
    broker.startSafeTurn(token);
    broker.completeSafeTurn(token, "accepted final answer", 0);
    completeRecoveryWork(f.ref, "accepted final answer");
    const file = join(f.directory, "recovery.json"), baseline = readFileSync(file, "utf8");
    expect(await broker.nextToolBatch(token, undefined, context)).toEqual([]);
    const observed = await broker.waitForTaskUpdateState(token, 0);
    expect(observed.state).toMatchObject({ finalOutputRevision: 0, acknowledgedRevision: 0 });
    expect(await broker.waitForTaskUpdateState(token, observed.revision)).toEqual(observed);
    expect(readFileSync(file, "utf8")).toBe(baseline);
    expect(() => assertRecoveryWriter(f.ref)).toThrow("obsolete");
    await expect(broker.nextToolBatch(token)).rejects.toThrow("driver generation");
    const mutations: Array<(record: any) => void> = [
      record => { record.owner.id = "7".repeat(64); },
      record => { record.epoch += 1; },
      record => { record.works.work.terminalDigest = "8".repeat(64); },
      record => { record.works.work.terminalReceiptId = "different-final"; },
      record => { record.works.work.state = "stopped"; record.state = "stopped"; },
      record => { record.works.work.attempts.push({ ...record.works.work.attempts[0], attempt: 1 }); },
    ];
    for (const mutate of mutations) {
      const document = JSON.parse(baseline); mutate(document.threads[thread]);
      writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
      await expect(broker.nextToolBatch(token, undefined, context)).rejects.toThrow();
      expect(() => broker.waitForTaskUpdateState(token, observed.revision)).toThrow();
    }
    writeFileSync(file, baseline, { mode: 0o600 });
    f.store.admitWork({ thread, scope, owner: f.owner, logicalWorkId: "new-work", instructionIdentity: "next", workPayloadDigest: "5".repeat(64), snapshotDigest: "6".repeat(64), dispatchProtocolComplete: true });
    await expect(broker.nextToolBatch(token, undefined, context)).rejects.toThrow("original final receipt");
    expect(() => broker.waitForTaskUpdateState(token, observed.revision)).toThrow("original final receipt");
  } finally { await broker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("retirement preserves unknown Send and cannot authorize a replacement", () => {
  const f = setup();
  try {
    f.store.markAttempt(thread, { scope }, { logicalWorkId: "work", attempt: 0, stage: "send-possible" });
    const retired = f.store.retireAttempt(thread, { scope }, "work", 0);
    expect(retired.works.work!.attempts[0]).toMatchObject({ writerRetired: true, stage: "send-possible" });
    expect(() => f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "work", owner: f.owner, snapshotDigest: "4".repeat(64) })).toThrow("Send is still unknown");
    expect(() => completeRecoveryWork(f.ref, "late answer")).toThrow("obsolete execution");
    expect(f.store.get(thread)!.works.work!.attempts).toHaveLength(1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("v2 migration preserves facts, promotes atomically, and rejects a conflicting scope alias", () => {
  const f = setup();
  try {
    const path = join(f.directory, "recovery.json");
    const v2 = JSON.parse(readFileSync(path, "utf8")); v2.version = 2;
    writeFileSync(path, JSON.stringify(v2), { mode: 0o600 });
    f.store.initialize();
    const v3 = JSON.parse(readFileSync(path, "utf8"));
    expect(v3.version).toBe(4); expect(v3.threads).toEqual(v2.threads);
    const aliased = f.store.bindCanonicalScope(thread, { expectedScope: scope, canonicalScope: "5".repeat(64) });
    expect(aliased.scope).toBe(scope); expect(aliased.works).toEqual(f.record.works);
    expect(() => f.store.bindCanonicalScope(thread, { expectedScope: scope, canonicalScope: "6".repeat(64) })).toThrow("another identity");
    expect(() => f.store.bindCanonicalScope(thread, { expectedScope: "7".repeat(64), canonicalScope: "5".repeat(64) })).toThrow("not been proved");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("page command enqueue and durable revocation use the same authority lock", () => {
  const f = setup();
  try {
    const identity = recoveryIdentity(f.record, f.store.installationId());
    let sends = 0;
    f.store.withExecutionAuthority(identity, () => { sends++; });
    f.store.retireAttempt(thread, { scope }, "work", 0);
    expect(() => f.store.withExecutionAuthority(identity, () => { sends++; })).toThrow("obsolete");
    expect(sends).toBe(1);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

for (const deliveredBeforeFence of [false, true]) test(`live child Broker cannot dispatch after durable revocation (prior delivery=${deliveredBeforeFence})`, async () => {
  const f = setup();
  const socket = defaultBrokerEndpoint(f.directory), ready = join(f.directory, "ready.json");
  const module = new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href;
  const configModule = new URL("../src/config.ts", import.meta.url).href;
  // File existence is the readiness signal; publish only the complete token.
  const source = `import {atomicWriteFile} from ${JSON.stringify(configModule)};
    import {TurnBroker} from ${JSON.stringify(module)};
    const broker=TurnBroker.forSocket(${JSON.stringify(socket)});
    const token=await broker.register({authorityMode:'delegated',threadId:'thread',turnId:'turn',tools:[{type:'function',name:'echo',parameters:{type:'object',properties:{},additionalProperties:false}}]},undefined,'fence-child',{recovery:${JSON.stringify(f.ref)}});
    atomicWriteFile(${JSON.stringify(ready)},JSON.stringify({token}));
    await new Promise(resolve=>process.stdin.once('data',resolve)); await broker.close();`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let invocation: Promise<unknown> | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(ready)) throw new Error(await new Response(child.stderr).text());
    const { token } = JSON.parse(readFileSync(ready, "utf8"));
    const claim = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
    invocation = callTurnBroker(socket, { method: "invoke", bindingId: claim.bindingId, wireName: "echo", freeform: false, arguments: {} }, null).catch(error => error);
    let calls: Array<{ callId: string }> = [];
    if (deliveredBeforeFence) calls = (await callTurnBroker<{ requests: Array<{ callId: string }> }>(socket, { method: "owner_next", token })).requests;
    else await Bun.sleep(30); // Leave the old instance's queued invocation in memory.
    f.store.retireAttempt(thread, { scope }, "work", 0);
    process.kill(child.pid, 0); // The old Broker is demonstrably still alive.
    await expect(callTurnBroker(socket, { method: "owner_next", token })).rejects.toThrow("obsolete execution");
    await expect(callTurnBroker(socket, { method: "invoke", bindingId: claim.bindingId, wireName: "echo", freeform: false, arguments: {} })).rejects.toThrow("obsolete execution");
    await expect(callTurnBroker(socket, { method: "resolve", bindingId: claim.bindingId })).rejects.toThrow("obsolete execution");
    expect(Object.keys(f.store.get(thread)!.calls)).toHaveLength(deliveredBeforeFence ? 1 : 0);
    if (deliveredBeforeFence) {
      const item = { type: "function_call_output", call_id: calls[0]!.callId, output: { session_id: 42, running: true } };
      acceptRecoveryResults(f.ref, [item]);
      expect(f.store.get(thread)!.calls[calls[0]!.callId]!.state).toBe("settled");
      expect(() => acceptRecoveryResults(f.ref, [{ ...item, output: "invented different result" }])).toThrow("conflicts");
      expect(() => assertRecoveryWriter(f.ref)).toThrow("obsolete execution");
    }
  } finally {
    child.kill(); await child.exited; await invocation;
    rmSync(f.directory, { recursive: true, force: true });
  }
}, 10000);


test("durable fencing rejects old reads, ACK, final publication and compaction handoff", async () => {
  const f = setup(); const socket = defaultBrokerEndpoint(f.directory); const broker = TurnBroker.forSocket(socket);
  const ownerContext = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
  try {
    const token = await broker.register({ authorityMode: "delegated", threadId: "thread", turnId: "turn", tools: [] },
      undefined, "fence-controls", { recovery: f.ref, taskUpdateProtocol: 1 });
    const snapshot = createContextSnapshot(parseRequest({ model: "gpt-5", input: [{ role: "user", content: "A private source value." }] }));
    const plan = { snapshot, planId: "source-plan", manifestDigest: "source-manifest",
      deliveryByTarget: Object.fromEntries(snapshot.targets.map(target => [target.target_id, { delivery: "inline" as const, required: false }])) };
    broker.registerContextPlan(token, plan, ownerContext); broker.selectContextPlan(token, plan.planId, ownerContext);
    broker.markContextPlanSent(token, plan.planId, ownerContext);
    const query = { method: "context_query" as const, token, contract: "native" as const, credentialKind: "ordinary" as const,
      contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "list" as const, contextArgs: { context_id: snapshot.context_id, view: "overview" as const } };
    const pending = await callTurnBroker<{ receiptId: string }>(socket, query);
    const transaction = await broker.beginCompactionTransaction("fence-compaction");
    const compaction = broker.registerCompactionContext({ snapshot, recovery: f.ref, contract: "native",
      transactionToken: transaction.token, handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "generation-0", expiresAt: Date.now() + 60000 });
    f.store.retireAttempt(thread, { scope }, "work", 0);
    await expect(callTurnBroker(socket, query)).rejects.toThrow("obsolete execution");
    await expect(callTurnBroker(socket, { ...query, token: compaction.compactionToken, credentialKind: "compaction" })).rejects.toThrow("obsolete execution");
    await expect(callTurnBroker(socket, { method: "task_update_ack", token, contract: "native", taskUpdateProtocol: 1,
      deliveryId: "old-delivery", throughRevision: 0 })).rejects.toThrow("obsolete execution");
    expect(() => broker.beginFinalOutput(token, ownerContext)).toThrow("obsolete execution");
    await expect(callTurnBroker(socket, { method: "submit_compaction_handoff", token: transaction.token,
      handoffId: transaction.handoffId, summary: "late fabricated summary" })).rejects.toThrow("obsolete execution");
    // The old in-flight return may settle transport accounting, never renew read authority.
    await callTurnBroker(socket, { method: "context_return", token, contract: "native", credentialKind: "ordinary", contextProtocol: CONTEXT_PROTOCOL_VERSION,
      receiptId: pending.receiptId, sent: true });
    await expect(callTurnBroker(socket, query)).rejects.toThrow("obsolete execution");
  } finally { await broker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});


test("same-page authority follows only the accepted ordinary append chain and stops at its current fence", () => {
  const f = setup();
  try {
    const identity = recoveryIdentity(f.record, f.store.installationId());
    recordRecoveryAppend(f.ref, { logicalWorkId: "work-next", instructionIdentity: "next-instruction", nativeTurnId: "next-turn",
      workPayloadDigest: "6".repeat(64), snapshotDigest: "7".repeat(64), localSessionId: "same-page-session", localTaskRevision: 1, results: [] });
    expect(f.store.get(thread)!.works.work!.attempts[0]!.writerRetired).toBe(true);
    expect(() => f.store.assertExecutionAuthority(identity)).not.toThrow();
    f.store.retireAttempt(thread, { scope }, "work-next", 0);
    expect(() => f.store.assertExecutionAuthority(identity)).toThrow("obsolete");
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("a failed v2 format promotion leaves original facts intact for retry", () => {
  const f = setup();
  try {
    const path = join(f.directory, "recovery.json"); const document = JSON.parse(readFileSync(path, "utf8")); document.version = 2;
    writeFileSync(path, JSON.stringify(document), { mode: 0o600 }); const original = readFileSync(path, "utf8");
    const failing = new ContinuityRecoveryStore(f.directory, { beforeWrite: () => { throw new Error("disk refused"); } });
    expect(() => failing.initialize()).toThrow("saved"); expect(readFileSync(path, "utf8")).toBe(original);
    f.store.initialize(); expect(f.store.get(thread)).toEqual(f.record);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("takeover notice survives successor admission and is consumed once after real submission", () => {
  const f = setup();
  try {
    f.store.retireAttempt(thread, { scope }, "work", 0);
    f.store.transact(thread, { scope }, record => { record.takeoverNoticePending = true; record.takeoverNoticeEpoch = 0; });
    f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "work", owner: f.owner, snapshotDigest: "4".repeat(64) });
    expect(new ContinuityRecoveryStore(f.directory).get(thread)!.takeoverNoticePending).toBe(true);
    expect(f.store.consumeTakeoverNotice(thread, scope)).toBe(true);
    expect(new ContinuityRecoveryStore(f.directory).consumeTakeoverNotice(thread, scope)).toBe(false);
    expect(f.store.get(thread)!.takeoverNoticeEpoch).toBe(0);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("a live original process settles its delayed Send after cross-process durable retirement", async () => {
  const f = setup(); const ready = join(f.directory, "send-ready.json");
  const module = new URL("../src/adapters/chatgpt-web/continuity-recovery-runtime.ts", import.meta.url).href;
  const original = recoveryIdentity(f.record, f.store.installationId());
  const source = `import {writeFileSync} from 'node:fs'; import {beginRecoverySend,settleRecoverySend} from ${JSON.stringify(module)};
    const ref=beginRecoverySend(${JSON.stringify(f.ref)},${JSON.stringify(original)});
    writeFileSync(${JSON.stringify(ready)},JSON.stringify(ref));
    await new Promise(resolve=>process.stdin.once('data',resolve));
    const result=settleRecoverySend(ref); const repeated=settleRecoverySend(ref);
    process.stdout.write(JSON.stringify({currentWriter:result.currentWriter,attempt:repeated.record.works.work.attempts[0]}));`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    if (!existsSync(ready)) throw new Error(await new Response(child.stderr).text());
    f.store.retireAttempt(thread, { scope }, "work", 0); process.kill(child.pid, 0);
    expect(() => f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "work", owner: f.owner, snapshotDigest: "4".repeat(64) })).toThrow("Send is still unknown");
    child.stdin.write("settle"); child.stdin.end();
    expect(await child.exited).toBe(0);
    const settled = JSON.parse(await new Response(child.stdout).text());
    expect(settled.currentWriter).toBe(false);
    expect(settled.attempt).toMatchObject({ stage: "accepted", writerRetired: true, sendEvidence: { status: "accepted" } });
    expect(() => assertRecoveryWriter(f.ref)).toThrow("obsolete");
    const next = f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "work", owner: f.owner, snapshotDigest: "4".repeat(64) });
    expect(next.works.work!.attempts[1]).toMatchObject({ stage: "prepared", writerRetired: false });
    expect(next.works.work!.attempts[1]!.sendEvidence).toBeUndefined();
    const replay = settleRecoverySend(JSON.parse(readFileSync(ready, "utf8")));
    expect(replay.currentWriter).toBe(false); expect(replay.record.works.work!.attempts).toHaveLength(2);
  } finally { child.kill(); await child.exited; rmSync(f.directory, { recursive: true, force: true }); }
});

test("Send settlement rejects missing authorization and every mismatched original identity", () => {
  const f = setup();
  try {
    const original = recoveryIdentity(f.record, f.store.installationId());
    expect(() => f.store.settleSendReceipt(thread, { scope }, original, "missing-auth")).toThrow();
    expect(() => beginRecoverySend(f.ref, { ...original, snapshotDigest: "8".repeat(64) })).toThrow();
    const captured = beginRecoverySend(f.ref, original);
    f.store.retireAttempt(thread, { scope }, "work", 0);
    for (const [key, value] of Object.entries({ installationId: "9".repeat(64), threadKey: "8".repeat(64), logicalWorkId: "wrong-work", attempt: 1,
      epoch: 8, transactionId: "wrong-transaction", transactionVersion: 9, snapshotVersion: 8, snapshotDigest: "8".repeat(64), ownerProcess: { pid: 1, startIdentity: "unverified" } })) {
      expect(() => settleRecoverySend({ ...captured, identity: { ...captured.identity, [key]: value } })).toThrow();
    }
    expect(() => settleRecoverySend({ ...captured, authorizationId: "wrong-auth" })).toThrow();
    expect(f.store.get(thread)!.works.work!.attempts[0]!.stage).toBe("send-possible");
    expect(settleRecoverySend(captured).currentWriter).toBe(false);
    expect(() => f.store.markAttempt(thread, { scope }, { logicalWorkId: "work", attempt: 0, stage: "accepted" })).toThrow();
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("exact known-unsent receipt keeps one transaction and rejects generic or stale capacity errors", () => {
  const f = setup();
  try {
    const launcherInstance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "a".repeat(64) };
    const record = f.store.markAttempt(thread, { scope }, { logicalWorkId: "work", attempt: 0, stage: "page-possible", launcherInstance });
    const original = recoveryIdentity(record, f.store.installationId());
    const requestId = "request_".repeat(4);
    beginRecoveryAcquisition(f.ref, original, requestId);
    const originalSend = beginRecoverySend(f.ref, original, requestId);
    const error = new LauncherKnownUnsentReceiptError({ schemaVersion: 1, receiptId: "b".repeat(32), state: "known-unsent",
      recovery: original, launcherInstance, traceId: "trace-test", helperPid: process.pid, requestId, executionProtocol: 1, sendState: "not-started" });
    expect(settleRecoveryKnownUnsent(f.ref, Object.assign(new Error("capacity"), { code: "continuity_resource_capacity" }))).toBe(false);
    expect(f.store.get(thread)!.works.work!.attempts[0]!.stage).toBe("send-possible");
    expect(settleRecoveryKnownUnsent(f.ref, error)).toBe(true);
    expect(() => settleRecoverySend(originalSend)).toThrow();
    const unsent = f.store.get(thread)!;
    expect(unsent.works.work!.attempts).toHaveLength(1);
    expect(unsent.works.work!.attempts[0]).toMatchObject({ stage: "prepared", writerRetired: false, sendEvidence: { status: "not-sent" } });
    expect(unsent.transaction!.transactionId).toBe(record.transaction!.transactionId);
    expect(unsent.works.work!.retryBudget).toEqual(record.works.work!.retryBudget);
    beginRecoveryAcquisition(f.ref, original, "next_request_".repeat(3));
    expect(() => settleRecoveryKnownUnsent(f.ref, error)).toThrow();
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test("public Full Launcher adapter settles retired original Send without marking context delivered", async () => {
  const f = retainedTaskFixture(); const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const run = worker.run.bind(worker); let settlements = 0;
  worker.run = turn => run({ ...turn, onSubmitted: async () => {
    const identity = turn.continuity!.recovery!;
    f.store.retireAttempt(identity.threadKey, { scope: f.store.get(identity.threadKey)!.scope }, identity.logicalWorkId, identity.attempt);
    await turn.onSubmitted?.(); settlements++;
  } });
  try {
    const response = await f.send(f.body); await response.text();
    const record = f.store.get(continuityDigest(f.threadId))!;
    expect(settlements).toBe(1); expect(f.submissions).toHaveLength(1);
    expect(record.works[record.currentWorkId!]!.attempts[0]).toMatchObject({ stage: "accepted", writerRetired: true, sendEvidence: { status: "accepted" } });
    expect(record.contextCoverage?.some(entry => entry.metadata.delivered) ?? false).toBe(false);
    expect(record.works[record.currentWorkId!]!.state).not.toBe("completed");
  } finally { await f.dispose(); }
});


test("a delayed original Send receipt after stop records its fact without reviving stopped work", () => {
  const f = setup();
  try {
    const captured = beginRecoverySend(f.ref, recoveryIdentity(f.record, f.store.installationId()));
    f.store.stopWork(thread, { scope }, "work", "native-interrupt");
    const settled = settleRecoverySend(captured);
    expect(settled.currentWriter).toBe(false);
    expect(settled.record.works.work).toMatchObject({ state: "stopped", attempts: [{ stage: "stopped", writerRetired: true, sendEvidence: { status: "accepted" } }] });
    expect(() => completeRecoveryWork(f.ref, "late answer")).toThrow();
    expect(() => f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "work", owner: f.owner, snapshotDigest: "4".repeat(64) })).toThrow();
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});


test("completed replay: retired writer reason survives real Broker RPC without error wording", async () => {
  const f = setup(), broker = TurnBroker.forSocket(defaultBrokerEndpoint(f.directory));
  const capability = { authorityMode: "delegated" as const, threadId: "thread", turnId: "turn", tools: [] };
  const context = { expectedDriverGeneration: 0, taskRevision: 0 };
  let update: ReturnType<typeof spyOn> | undefined;
  try {
    const token = await broker.registerSafe(capability, "terminal-read-surface-123456789", undefined, "typed-retirement",
      { recovery: f.ref, taskUpdateProtocol: 1, requireSentConfirmation: false });
    broker.startSafeTurn(token);
    broker.completeSafeTurn(token, "accepted final answer", 0);
    completeRecoveryWork(f.ref, "accepted final answer");
    const file = join(f.directory, "recovery.json"), baseline = readFileSync(file, "utf8");
    const original = broker.updateEnvironment.bind(broker);
    update = spyOn(broker, "updateEnvironment").mockImplementation((...args) => {
      try { original(...args); } catch (error) {
        if (error instanceof Error) error.message = "A different diagnostic wording.";
        throw error;
      }
    });
    const request = { method: "owner_update" as const, token, environment: capability, ownerContext: context };
    const retired = await callTurnBroker(broker.socketPath, request).catch(error => error);
    expect(retired).toMatchObject({ reason: "writer_retired", message: "A different diagnostic wording." });
    expect(retired).not.toHaveProperty("code");
    expect(retired).not.toHaveProperty("status");
    let local: unknown;
    try { assertRecoveryWriter(f.ref); } catch (error) { local = error; }
    expect(local).toMatchObject({ code: "continuity_source_unproven", status: 409, retryable: false, reason: "writer_retired" });
    update.mockImplementation(() => { throw continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt."); });
    const lookalike = await callTurnBroker(broker.socketPath, request).catch(error => error);
    expect(lookalike).toBeInstanceOf(Error);
    expect(lookalike).toMatchObject({ message: expect.stringContaining("obsolete execution") });
    expect(lookalike).not.toHaveProperty("reason");
    expect(readFileSync(file, "utf8")).toBe(baseline);
  } finally { update?.mockRestore(); await broker.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
