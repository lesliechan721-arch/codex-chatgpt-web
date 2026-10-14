import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBrokerEndpoint } from "../src/config";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recordRecoveryAppend, recoveryDigest, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { TurnBroker, RemoteTurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { restoreRecoveryTaskUpdates } from "../src/adapters/chatgpt-web/continuity-task-update-journal";
import type { TaskUpdateTransfer, UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";

const thread = "1".repeat(64), scope = "2".repeat(64);
const environment = { authorityMode: "delegated" as const, threadId: "thread", turnId: "turn", tools: [{ name: "exec_command", description: "Fixture executor",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false } }] };
const update = { revision: 1, sourceMessageId: "accepted-user-update", content: "Keep the already accepted constraint.", payloadDigest: recoveryDigest("Keep the already accepted constraint.") };

async function setup() {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-update-recovery-"));
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityRecoveryStore(directory), owner = continuityProcessInstance();
  store.admitWork({ thread, scope, owner, logicalWorkId: "A", instructionIdentity: "initial", workPayloadDigest: "3".repeat(64), snapshotDigest: "4".repeat(64), dispatchProtocolComplete: true });
  const sourceSocket = defaultBrokerEndpoint(join(directory, "old")), ready = join(directory, "ready");
  const module = new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "-e", `import {writeFileSync} from 'node:fs'; import {TurnBroker} from ${JSON.stringify(module)};
    const broker=TurnBroker.forSocket(${JSON.stringify(sourceSocket)}); await broker.listen(); writeFileSync(${JSON.stringify(ready)},'ready');
    await new Promise(resolve=>process.stdin.once('data',resolve)); await broker.close();`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  if (!existsSync(ready)) throw new Error(await new Response(child.stderr).text());
  const old = new RemoteTurnBroker(sourceSocket);
  const token = await old.register(environment, undefined, "original-live", { recovery: { directory, thread, logicalWorkId: "A", attempt: 0 }, taskUpdateProtocol: 1 });
  const start = (socket: string, token: string, id: number, revision: number) => callTurnBroker<{ kind: string; taskUpdate?: UpdateDelivery }>(socket,
    { method: "native_operation_start", token, contract: "native", nativeWaitProtocol: 1, taskUpdateProtocol: 1,
      operationId: id, taskRevision: revision, entry: "codex_exec", nativeInput: { cmd: "fixture-not-executed" }, waitMs: 1 });
  await start(sourceSocket, token, 1, 0);
  const [call] = await old.nextToolBatch(token, undefined, { taskRevision: 0, expectedDriverGeneration: 0 });
  const result = { type: "function_call_output", call_id: call!.callId, output: "observed outer executor result" };
  const append = async (settled = true) => {
    const transfer: TaskUpdateTransfer = { transferId: "original-transfer", payloadDigest: "exact-transfer-payload", expectedDriverGeneration: 0, expectedRevision: 0,
      environment, updates: [update], results: settled ? [{ callId: call!.callId, result: { content: [{ type: "text", text: result.output }] } }] : [],
      batchFingerprint: "exact-batch", mode: "continuity", recovery: { logicalWorkId: "B", instructionIdentity: "accepted-user-update", nativeTurnId: "turn",
        workPayloadDigest: "5".repeat(64), snapshotDigest: "6".repeat(64), localSessionId: "original-live", localTaskRevision: 1,
        results: settled ? [{ callId: call!.callId, resultType: result.type, resultDigest: recoveryResultDigest(result) }] : [] } };
    await old.reserveTaskUpdate(token, transfer.transferId, transfer.payloadDigest, { taskRevision: 0, expectedDriverGeneration: 0 }, true);
    expect(await old.acceptTaskUpdate(token, transfer)).toMatchObject({ status: "committed", state: { acceptedRevision: 1, acknowledgedRevision: 0 } });
    const delivery = (await callTurnBroker<{ taskUpdate?: UpdateDelivery }>(sourceSocket, { method: "native_operation_wait", token, contract: "native", nativeWaitProtocol: 1, operationId: 1, waitMs: 1 })).taskUpdate!;
    expect(delivery.updates).toEqual([update]); return { delivery, transfer };
  };
  const close = async () => { child.kill(); await child.exited; rmSync(directory, { recursive: true, force: true }); };
  return { directory, store, owner, old, token, child, sourceSocket, start, append, close };
  } catch (error) { child.kill(); await child.exited; rmSync(directory, { recursive: true, force: true }); throw error; }
}

for (const acknowledged of [false, true]) test(`live old Broker cannot ACK after takeover; successor restores original revision (already ACK=${acknowledged})`, async () => {
  const f = await setup(); let successor: TurnBroker | undefined;
  try {
    const { delivery, transfer } = await f.append();
    if (acknowledged) await callTurnBroker(f.sourceSocket, { method: "task_update_ack", token: f.token, contract: "native", taskUpdateProtocol: 1, deliveryId: delivery.deliveryId, throughRevision: 1 });
    const before = f.store.get(thread)!;
    f.store.retireAttempt(thread, { scope }, "B", 0);
    f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "B", owner: f.owner, snapshotDigest: "6".repeat(64) });
    process.kill(f.child.pid, 0);
    await expect(callTurnBroker(f.sourceSocket, { method: "task_update_ack", token: f.token, contract: "native", taskUpdateProtocol: 1, deliveryId: delivery.deliveryId, throughRevision: 1 })).rejects.toThrow("obsolete");
    // The old, exact committed transfer is still a replayable fact under protocol 13.
    expect(await f.old.acceptTaskUpdate(f.token, transfer)).toMatchObject({ status: "committed" });
    successor = TurnBroker.forSocket(defaultBrokerEndpoint(join(f.directory, "new")));
    const ref = { directory: f.directory, thread, logicalWorkId: "B", attempt: 1 };
    if (!acknowledged) {
      await expect(successor.register(environment, undefined, "missing", { recovery: ref, taskUpdateProtocol: 1 })).rejects.toThrow("missing or conflicting");
      await expect(successor.register(environment, undefined, "changed", { recovery: ref, taskUpdateProtocol: 1, recoveryTaskUpdateSources: [{ ...update, content: "changed" }] })).rejects.toThrow("missing or conflicting");
    }
    const token = await successor.register(environment, undefined, "successor", { recovery: ref, taskUpdateProtocol: 1, recoveryTaskUpdateSources: acknowledged ? [] : [update] });
    expect(successor.taskUpdateState(token)).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: acknowledged ? 1 : 0, driverGeneration: 1 });
    if (!acknowledged) {
      expect(() => successor!.beginFinalOutput(token, { expectedDriverGeneration: 1, taskRevision: 1 })).toThrow();
      const pending = (await f.start(successor.socketPath, token, 1, 0)).taskUpdate!;
      expect(pending).toMatchObject({ fromRevision: 1, throughRevision: 1, updates: [update] });
      expect(pending.deliveryId).not.toBe(delivery.deliveryId);
      expect(() => successor!.acknowledgeTaskUpdate(token, delivery.deliveryId, 1, "native")).toThrow();
      expect(successor!.acknowledgeTaskUpdate(token, pending.deliveryId, 1, "native")).toMatchObject({ acknowledgedRevision: 1, acceptedRevision: 1 });
    }
    const accepted = successor!.beginFinalOutput(token, { expectedDriverGeneration: 1, taskRevision: 1 });
    expect(accepted.taskRevision).toBe(1);
    const after = f.store.get(thread)!;
    expect(after.works.B!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 1 });
    expect(after.lineages).toEqual(before.lineages);
    expect(after.works.B!.taskUpdateJournal!.updates).toEqual([{ revision: 1, sourceMessageId: update.sourceMessageId, payloadDigest: update.payloadDigest }]);
    expect(readFileSync(join(f.directory, "recovery.json"), "utf8")).not.toContain(update.content);
    // A new process/read sees the ACK. Restart does not redeliver it.
    expect(restoreRecoveryTaskUpdates(ref).updates).toEqual([]);
  } finally { await successor?.close(); await f.close(); }
}, 15000);

test("unsettled real tool result and explicit stop still block pending-update takeover", async () => {
  const f = await setup();
  try {
    await f.append(false);
    f.store.retireAttempt(thread, { scope }, "B", 0);
    expect(() => f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "B", owner: f.owner, snapshotDigest: "6".repeat(64) })).toThrow("terminal result");
    f.store.stopWork(thread, { scope }, "B", "user-stop");
    expect(() => restoreRecoveryTaskUpdates({ directory: f.directory, thread, logicalWorkId: "B", attempt: 0 }, [update])).toThrow();
    expect(f.store.get(thread)!.works.B!.taskUpdateJournal).toMatchObject({ acceptedRevision: 1, acknowledgedRevision: 0 });
  } finally { await f.close(); }
});

test("legacy accepted append without durable ACK evidence cannot migrate to a zero or acknowledged head", async () => {
  const f = await setup();
  try {
    await f.append();
    f.store.retireAttempt(thread, { scope }, "B", 0);
    f.store.reserveRecovery(thread, { scope }, { logicalWorkId: "B", owner: f.owner, snapshotDigest: "6".repeat(64) });
    const file = join(f.directory, "recovery.json"), document = JSON.parse(readFileSync(file, "utf8"));
    document.version = 2;
    for (const work of Object.values(document.threads[thread].works) as Array<Record<string, unknown>>) delete work.taskUpdateJournal;
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    f.store.initialize();
    const migrated = readFileSync(file, "utf8");
    expect(() => restoreRecoveryTaskUpdates({ directory: f.directory, thread, logicalWorkId: "B", attempt: 1 }, [update])).toThrow("no durable acknowledgement evidence");
    expect(readFileSync(file, "utf8")).toBe(migrated);
    expect(f.store.get(thread)!.works.B!.acceptedTaskRevision).toBe(2);
    expect(f.store.get(thread)!.works.B!.taskUpdateJournal).toBeUndefined();
    await expect(f.old.register(environment, undefined, "legacy-without-protocol", { recovery: { directory: f.directory, thread, logicalWorkId: "B", attempt: 1 } })).rejects.toThrow("no durable acknowledgement evidence");
  } finally { await f.close(); }
});

test("same-work accepted suffix preserves durable revisions and driver generation", async () => {
  const f = await setup();
  try {
    const { transfer } = await f.append();
    const nextUpdate = { revision: 2, sourceMessageId: "second-source", content: "A second accepted constraint.", payloadDigest: recoveryDigest("A second accepted constraint.") };
    const next: TaskUpdateTransfer = { ...transfer, transferId: "same-work-transfer", payloadDigest: "same-work-payload", expectedDriverGeneration: 1, expectedRevision: 1,
      updates: [nextUpdate], results: [], recovery: { ...transfer.recovery!, results: [], localTaskRevision: 2 } };
    await f.old.reserveTaskUpdate(f.token, next.transferId, next.payloadDigest, { taskRevision: 1, expectedDriverGeneration: 1 }, true);
    expect(await f.old.acceptTaskUpdate(f.token, next)).toMatchObject({ status: "committed", state: { acceptedRevision: 2, driverGeneration: 2 } });
    expect(f.store.get(thread)!.works.B!.taskUpdateJournal).toMatchObject({ acceptedRevision: 2, acknowledgedRevision: 0, driverGeneration: 2 });
    expect(restoreRecoveryTaskUpdates({ directory: f.directory, thread, logicalWorkId: "B", attempt: 0 }, [update, nextUpdate]).updates).toEqual([update, nextUpdate]);
    expect(() => recordRecoveryAppend({ directory: f.directory, thread, logicalWorkId: "B", attempt: 0 }, { ...next.recovery!, localTaskRevision: 3 }, [{ ...update, revision: 3 }], 3)).toThrow("next durable task update range");
    expect(f.store.get(thread)!.works.B!.taskUpdateJournal!.acceptedRevision).toBe(2);
  } finally { await f.close(); }
});
