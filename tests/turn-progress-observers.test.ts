import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { ChatGptTraceFeed } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";

test("generation progress preserves trace text and does not replay queued content as new progress", () => {
  const feed = new ChatGptTraceFeed();
  feed.push({ kind: "reasoning", text: "previous reasoning" });
  let contentChanges = 0;
  let progressChanges = 0;
  const stopContent = feed.observe(() => { contentChanges += 1; });
  const stopProgress = feed.observeProgress(() => { progressChanges += 1; });
  expect(contentChanges).toBe(1);
  expect(progressChanges).toBe(0);

  feed.recordProgress();
  expect(progressChanges).toBe(1);
  expect(contentChanges).toBe(1);
  expect(feed.drain()).toEqual([{ kind: "reasoning", text: "previous reasoning" }]);
  feed.push({ kind: "commentary", text: "  " });
  expect(progressChanges).toBe(1);
  expect(contentChanges).toBe(1);
  expect(feed.drain()).toEqual([]);

  feed.push({ kind: "commentary", text: " new text " });
  expect(progressChanges).toBe(2);
  expect(contentChanges).toBe(2);
  expect(feed.drain()).toEqual([{ kind: "commentary", text: "new text" }]);
  stopContent();
  stopProgress();
  feed.recordProgress();
  feed.push({ kind: "commentary", text: "after release" });
  expect(progressChanges).toBe(2);
  expect(contentChanges).toBe(2);
});

test("generation progress does not wake a waiter for trace text", async () => {
  const feed = new ChatGptTraceFeed();
  let contentReady = false;
  const waiting = feed.wait().then(() => { contentReady = true; });
  feed.recordProgress();
  await Promise.resolve();
  expect(contentReady).toBeFalse();
  expect(feed.drain()).toEqual([]);
  feed.push({ kind: "reasoning", text: "visible text" });
  await waiting;
  expect(contentReady).toBeTrue();
});

test("Native compaction progress keeps operation identity, real results and owner context", async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-progress-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const ownerContext = { expectedDriverGeneration: 0, taskRevision: 0 };
  let progress = 0;
  try {
    const token = await broker.register({
      authorityMode: "delegated", threadId: "progress-thread", turnId: "progress-turn",
      tools: [{ name: "exec_command", description: "Execute in Native", parameters: { type: "object" } }],
    }, undefined, "progress-test", { taskUpdateProtocol: 1 });
    const start = (operationId: number) => callTurnBroker<NativeOperationReply>(socket, {
      method: "native_operation_start", token, contract: "native", nativeWaitProtocol: 1,
      taskUpdateProtocol: 1, taskRevision: 0, operationId, entry: "codex_exec",
      nativeInput: { cmd: `inert-${operationId}` }, waitMs: 1,
    });
    const wait = (operationId: number) => callTurnBroker<NativeOperationReply>(socket, {
      method: "native_operation_wait", token, contract: "native", nativeWaitProtocol: 1, operationId, waitMs: 1,
    });
    expect(await start(1)).toMatchObject({ kind: "pending", operation_id: 1 });
    const [current] = await broker.nextToolBatch(token, undefined, ownerContext);
    expect(current).toMatchObject({ arguments: { cmd: "inert-1" } });
    expect(await start(2)).toMatchObject({ kind: "pending", operation_id: 2 });
    const compactionResult: BrokerToolResult = { content: [{ type: "text", text: "compact now" }], isError: true };
    expect(() => broker.requestCompaction(token, compactionResult,
      { expectedDriverGeneration: 1, taskRevision: 0 }, () => { progress += 1; }))
      .toThrow("The task update driver generation is missing or stale");
    expect(progress).toBe(0);
    expect(broker.requestCompaction(token, compactionResult, ownerContext, () => { progress += 1; })).toBe(1);
    expect(progress).toBe(1);

    const realResult: BrokerToolResult = { content: [{ type: "text", text: "real result" }], structuredContent: { done: true } };
    broker.completeTool(token, current!.callId, realResult, ownerContext);
    expect(await wait(1)).toMatchObject({ kind: "result", result: realResult });
    const queuedControl = await wait(2);
    expect(queuedControl).toMatchObject({ kind: "result", result: {
      content: compactionResult.content, _meta: { "codex/native-control": { kind: "compaction" } },
    } });
    expect(progress).toBe(1);
    const laterControl = await start(3);
    expect(laterControl).toMatchObject({ kind: "result", result: {
      content: compactionResult.content, _meta: { "codex/native-control": { kind: "compaction" } },
    } });
    expect(progress).toBe(2);
    expect(await start(3)).toEqual(laterControl);
    expect(await wait(3)).toEqual(laterControl);
    expect(progress).toBe(2);
    expect(broker.compactionDeliveryCount(token)).toBe(2);
    broker.revoke(token, undefined, ownerContext);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("remote compaction reports only confirmed queued delivery after owner validation (queued=%s)", async queued => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-remote-progress-"));
  const socket = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socket);
  const owner = new RemoteTurnBroker(socket);
  let progress = 0;
  try {
    const token = await broker.register({
      authorityMode: "delegated", threadId: "progress-thread", turnId: "progress-turn",
      tools: [{ name: "exec_command", description: "Execute in Native", parameters: { type: "object" } }],
    }, undefined, "progress-test", { taskUpdateProtocol: 1 });
    if (queued) {
      await callTurnBroker<NativeOperationReply>(socket, {
        method: "native_operation_start", token, contract: "native", nativeWaitProtocol: 1,
        taskUpdateProtocol: 1, taskRevision: 0, operationId: 1, entry: "codex_exec",
        nativeInput: { cmd: "inert" }, waitMs: 1,
      });
    }
    const result: BrokerToolResult = { content: [{ type: "text", text: "compact now" }], isError: true };
    await expect(owner.requestCompaction(token, result,
      { expectedDriverGeneration: 1, taskRevision: 0 }, () => { progress += 1; }))
      .rejects.toMatchObject({ code: "task_update_driver_stale" });
    expect(progress).toBe(0);
    expect(await owner.requestCompaction(token, result,
      { expectedDriverGeneration: 0, taskRevision: 0 }, () => { progress += 1; })).toBe(queued ? 1 : 0);
    expect(progress).toBe(queued ? 1 : 0);
    if (queued) {
      expect(await callTurnBroker<NativeOperationReply>(socket, {
        method: "native_operation_wait", token, contract: "native", nativeWaitProtocol: 1, operationId: 1, waitMs: 1,
      })).toMatchObject({ kind: "result", result: {
        content: result.content, _meta: { "codex/native-control": { kind: "compaction" } },
      } });
    }
    expect(progress).toBe(queued ? 1 : 0);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
