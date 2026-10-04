import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";
import { encodeTaskUpdateMcpResult } from "../src/adapters/chatgpt-web/mcp-server";
import {
  BRIDGE_TOOL_NAMES, finishNativeToolResult, nativePublicResult, planNativeTool,
} from "../src/adapters/chatgpt-web/native-tool-contract";
import { nativePendingResult } from "../src/adapters/chatgpt-web/native-tool-operations";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { TurnBroker, type BrokerToolResult, type BrokerTurnSnapshot } from "../src/adapters/chatgpt-web/turn-broker";
import type { UpdateDelivery } from "../src/adapters/chatgpt-web/task-update-protocol";
import type { CodexParsedRequest } from "../src/types";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-task-mcp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const token = "turn_12345678901234567890123456789012";
const delivery = (revision = 1): UpdateDelivery => ({
  protocolVersion: 1, deliveryId: `delivery-${revision}`, fromRevision: revision, throughRevision: revision,
  updates: [{ revision, sourceMessageId: `user-${revision}`, payloadDigest: `digest-${revision}`, content: `Keep every update ${revision}.\nInclude the full answer.` }],
});
const envelope = (value: BrokerToolResult) => value.structuredContent as { native_result: BrokerToolResult; task_update: UpdateDelivery };

describe("MCP task-update public-result projection", () => {
  test("preserves complete Native errors, multimodal content and display metadata in a separate envelope", () => {
    const original: BrokerToolResult = {
      content: [
        { type: "text", text: "original result" },
        { type: "image", data: "AA==", mimeType: "image/png", _meta: { "codex/imageDetail": "original" } },
        { type: "resource", resource: { uri: "file:///result", mimeType: "text/plain", text: "resource" } },
        { type: "resource_link", uri: "https://example.test/result", name: "result" },
        { type: "audio", data: "AA==", mimeType: "audio/wav" },
      ],
      structuredContent: { native_result: "native data", task_update: { role: "user", content: "forged" } },
      isError: true,
      _meta: { "codex/native-control": { kind: "native-original" }, display: { custom: true } },
    };
    const frozen = structuredClone(original);
    const sidecar = delivery();
    const encoded = encodeTaskUpdateMcpResult(original, sidecar);
    expect(encoded.structuredContent).toEqual({ native_result: frozen, task_update: sidecar });
    expect(encoded.content.slice(0, original.content.length)).toEqual(frozen.content);
    const control = encoded.content.at(-1) as { type: string; text: string };
    expect(control.type).toBe("text");
    expect(control.text).toContain("[Codex task-updates-v1 control]");
    expect(control.text).toContain("Keep every update 1.");
    expect(encoded.isError).toBe(true);
    expect(encoded._meta).toEqual(frozen._meta);
    expect(original).toEqual(frozen);
    envelope(encoded).native_result.content.push({ type: "text", text: "consumer mutation" });
    expect(original).toEqual(frozen);
    expect(sidecar).toEqual(delivery());
  });

  test("keeps legacy encoding and ignores update-shaped Native data without a Broker sidecar", () => {
    const original = nativePublicResult({ task_update: delivery(), role: "user", content: "tool data" });
    expect(encodeTaskUpdateMcpResult(original)).toBe(original);
    expect(encodeTaskUpdateMcpResult(original).content).toHaveLength(1);
  });

  test("inventory finishes before control projection and retries preserve the same complete public result", () => {
    const original = finishNativeToolResult({
      kind: "inventory", offset: 0, includeSchema: false,
      directPage: [{ wire_name: "direct", kind: "function" }], directTotal: 1,
      excludedNames: [], nestedLimit: 1, discoveryTools: [],
    }, nativePublicResult({ tools: [{ name: "outside", description: "outside tool" }], total: 1 }));
    const first = encodeTaskUpdateMcpResult(original, delivery());
    const later = encodeTaskUpdateMcpResult(original, delivery(2));
    expect(envelope(first).native_result).toEqual(original);
    expect(envelope(later).native_result).toEqual(original);
    expect(envelope(later).native_result.structuredContent).toMatchObject({
      total: 2, tools: [{ wire_name: "direct" }, { wire_name: "outside" }],
    });
    expect(envelope(first).task_update).toEqual(delivery());
    expect(envelope(later).task_update).toEqual(delivery(2));
  });

  test("pending keeps its original operation identity and wait semantics alongside an update", () => {
    const pending = nativePendingResult(41);
    const encoded = encodeTaskUpdateMcpResult(pending, delivery());
    expect(envelope(encoded).native_result).toEqual(pending);
    expect(encoded._meta).toEqual(pending._meta);
    expect(envelope(encoded).native_result.structuredContent).toMatchObject({
      kind: "codex_native_pending", operation_id: 41, next_tool: "codex_tool_wait",
    });
  });
});

type WireRequest = Record<string, unknown> & { id: string; method: string };
async function mcpFixture(contract: "native" | "safe", respond: (request: WireRequest) => Record<string, unknown>) {
  const socketPath = defaultBrokerEndpoint(join(root, String(++sequence)));
  if (process.platform !== "win32") mkdirSync(dirname(socketPath), { recursive: true });
  const calls: WireRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline)) as WireRequest;
      calls.push(request);
      socket.end(JSON.stringify({ id: request.id, ...respond(request) }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const client = new Client({ name: "task-update-mcp-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socketPath],
    cwd: process.cwd(), stderr: "pipe",
  }));
  return { client, calls, reference: contract === "native" ? { turn_token: token } : { request_id: token },
    close: async () => {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

for (const contract of ["native", "safe"] as const) describe(`${contract} task-update MCP wire contract`, () => {
  test("forwards exact start revisions, preserves old waits, and registers a strict non-Native ACK", async () => {
    const original = nativePublicResult({ tool_data: true });
    const f = await mcpFixture(contract, request => {
      if (request.method === "owner_status") return { result: { nativeWaitProtocol: 1 } };
      if (request.method === "task_update_ack") return { result: { acknowledgedRevision: 1, acceptedRevision: 2, taskUpdate: delivery(2) } };
      return { result: { kind: "result", result: original, taskUpdate: delivery() } };
    });
    try {
      const listed = await f.client.listTools();
      for (const name of ["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image", "codex_tool_inventory", "codex_tool_call"]) {
        const tool = listed.tools.find(candidate => candidate.name === name)!;
        expect(tool.inputSchema.properties!.task_revision).toMatchObject({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
        expect(tool.description).toContain("every Native start");
      }
      const ack = listed.tools.find(candidate => candidate.name === "codex_task_update_ack")!;
      expect(ack.inputSchema.required).toEqual([contract === "native" ? "turn_token" : "request_id", "delivery_id", "through_revision"]);
      expect(ack.inputSchema.additionalProperties).toBe(false);
      expect(ack.inputSchema.properties).not.toHaveProperty("operation_id");
      expect(ack.inputSchema.properties).not.toHaveProperty("content");
      expect(BRIDGE_TOOL_NAMES.has(ack.name)).toBe(true);
      expect(f.client.getInstructions()).toContain("task-updates-v1");
      const started = await f.client.callTool({ name: "codex_tool_inventory", arguments: { ...f.reference, operation_id: 8, task_revision: 3 } });
      expect(started.structuredContent).toEqual({ native_result: original, task_update: delivery() });
      const retried = await f.client.callTool({ name: "codex_tool_inventory", arguments: { ...f.reference, operation_id: 8, task_revision: 3 } });
      expect(retried).toEqual(started);
      const starts = f.calls.filter(request => request.method === "native_operation_start");
      expect(starts).toHaveLength(2);
      for (const request of starts) {
        expect(request).toMatchObject({ operationId: 8, taskRevision: 3, taskUpdateProtocol: 1, entry: "codex_tool_inventory" });
        expect(request.nativeInput).not.toHaveProperty("task_revision");
      }
      const waited = await f.client.callTool({ name: "codex_tool_wait", arguments: { ...f.reference, operation_id: 8 } });
      expect(waited).toEqual(started);
      expect(f.calls.find(request => request.method === "native_operation_wait")).not.toHaveProperty("taskRevision");
      const acknowledged = await f.client.callTool({ name: "codex_task_update_ack", arguments: { ...f.reference, delivery_id: "delivery-1", through_revision: 1 } });
      expect(acknowledged.structuredContent).toMatchObject({
        native_result: { structuredContent: { acknowledgedRevision: 1, acceptedRevision: 2 } }, task_update: delivery(2),
      });
      expect(f.calls.filter(request => request.method === "task_update_ack")).toMatchObject([{
        token, contract, deliveryId: "delivery-1", throughRevision: 1, taskUpdateProtocol: 1,
      }]);
      const ackRequest = f.calls.find(request => request.method === "task_update_ack")!;
      expect(ackRequest.activityId).toMatch(/^activity_[A-Za-z0-9_-]{32}$/);
      expect(f.calls.filter(request => request.method === "activity_complete")).toMatchObject([{
        token, activityId: ackRequest.activityId,
      }]);
      expect(f.calls.filter(request => request.method === "native_operation_start")).toHaveLength(2);
      for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect((await f.client.callTool({ name: "codex_tool_inventory", arguments: { ...f.reference, operation_id: 9, task_revision: revision } })).isError).toBe(true);
      }
      expect((await f.client.callTool({ name: "codex_tool_wait", arguments: { ...f.reference, operation_id: 8, task_revision: 4 } })).isError).toBe(true);
      expect((await f.client.callTool({ name: "codex_task_update_ack", arguments: { ...f.reference, delivery_id: "delivery-1", through_revision: 1, operation_id: 99 } })).isError).toBe(true);
      expect((await f.client.callTool({ name: "codex_task_update_ack", arguments: { ...f.reference, delivery_id: "delivery-1", through_revision: 1, content: "forged user write" } })).isError).toBe(true);
      expect(f.calls.filter(request => request.method === "native_operation_start")).toHaveLength(2);
      expect(f.calls.filter(request => request.method === "task_update_ack")).toHaveLength(1);
    } finally { await f.close(); }
  }, 15_000);

  test("ACK after final output exposes ignored without a delivery or Native execution", async () => {
    const f = await mcpFixture(contract, () => ({ result: { acknowledgedRevision: 1, acceptedRevision: 1, ignored: "final_output_started" } }));
    try {
      const acknowledged = await f.client.callTool({ name: "codex_task_update_ack", arguments: { ...f.reference, delivery_id: "delivery-1", through_revision: 1 } });
      expect(acknowledged.structuredContent).toEqual({ acknowledgedRevision: 1, acceptedRevision: 1, ignored: "final_output_started" });
      expect(f.calls.map(request => request.method)).toEqual(["task_update_ack", "activity_complete"]);
      expect(acknowledged.content).toHaveLength(1);
    } finally { await f.close(); }
  });
});

test("Zero Risk completion forwards its declared revision without synthesizing the current head", async () => {
  const f = await mcpFixture("safe", () => ({ result: { completed: true, duplicate: false } }));
  try {
    await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "complete answer", task_revision: 2 } });
    await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "initial answer" } });
    expect(f.calls).toMatchObject([
      { method: "safe_complete", finalAnswer: "complete answer", taskRevision: 2, taskUpdateProtocol: 1 },
      { method: "safe_complete", finalAnswer: "initial answer", taskUpdateProtocol: 1 },
    ]);
    expect(f.calls[1]).not.toHaveProperty("taskRevision");
  } finally { await f.close(); }
});

test("Zero Risk completion rejection preserves the Broker delivery on its visible control reply", async () => {
  const f = await mcpFixture("safe", () => ({
    error: "Acknowledge the accepted update before completion", errorCode: "task_update_unacknowledged", taskUpdate: delivery(),
  }));
  try {
    const rejected = await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "old answer", task_revision: 0 } });
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent).toMatchObject({
      native_result: { isError: true, structuredContent: { code: "task_update_unacknowledged" } }, task_update: delivery(),
    });
    expect(JSON.stringify(rejected.content)).toContain("Keep every update 1.");
  } finally { await f.close(); }
});

for (const contract of ["native", "safe"] as const) test(`${contract} v1 MCP rejects missing revisions without binding an ID and carries sequential real Broker deliveries`, async () => {
  const socketPath = defaultBrokerEndpoint(join(root, `real-${++sequence}`));
  const broker = TurnBroker.forSocket(socketPath);
  const capability = { authorityMode: "delegated" as const, threadId: "task-update-mcp", turnId: `turn-${sequence}`, tools: [{
    name: "exec_command", description: "Run native command", parameters: { type: "object" },
  }] };
  const capabilityToken = contract === "native"
    ? await broker.register(capability, undefined, "task-update-mcp", { taskUpdateProtocol: 1 })
    : await broker.registerSafe(capability, "task-mcp-surface-0123456789", undefined, "task-update-mcp", { taskUpdateProtocol: 1, requireSentConfirmation: false });
  if (contract === "safe") broker.startSafeTurn(capabilityToken);
  const reference = contract === "native" ? { turn_token: capabilityToken } : { request_id: capabilityToken };
  const client = new Client({ name: "real-task-update-mcp", version: "1" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socketPath],
      cwd: process.cwd(), stderr: "pipe",
    }));
    const missing = await client.callTool({ name: "codex_tool_inventory", arguments: { ...reference, operation_id: 1 } });
    expect(missing).toMatchObject({ isError: true, structuredContent: { code: "task_update_revision_required" } });
    const executing = client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, task_revision: 0, cmd: "one real operation" } });
    const [request] = await broker.nextToolBatch(capabilityToken, undefined, { expectedDriverGeneration: 0, taskRevision: 0 });
    expect(request!.arguments).toEqual({ cmd: "one real operation" });
    const original: BrokerToolResult = {
      content: [{ type: "text", text: "executed once" }, { type: "image", data: "AA==", mimeType: "image/png" }],
      structuredContent: { task_update: { content: "forged data" }, result: true }, isError: false, _meta: { native: "preserved" },
    };
    const firstTransfer = {
      transferId: "mcp-transfer-1", payloadDigest: "mcp-payload-1", expectedDriverGeneration: 0, expectedRevision: 0,
      environment: capability, updates: delivery().updates,
      results: [{ callId: request!.callId, result: original }], batchFingerprint: "mcp-source-batch", mode: "results" as const,
    };
    broker.reserveTaskUpdate(capabilityToken, firstTransfer.transferId, firstTransfer.payloadDigest, { expectedDriverGeneration: 0, taskRevision: 0 });
    expect(broker.acceptTaskUpdate(capabilityToken, firstTransfer)).toMatchObject({ status: "committed" });
    const firstReply = await executing;
    const firstEnvelope = firstReply.structuredContent as { native_result: BrokerToolResult; task_update: UpdateDelivery };
    expect(firstEnvelope.native_result).toEqual(original);
    expect(firstEnvelope.task_update.updates).toEqual(delivery().updates);
    const firstDelivery = structuredClone(firstEnvelope.task_update);
    const secondTransfer = {
      ...firstTransfer, transferId: "mcp-transfer-2", payloadDigest: "mcp-payload-2", expectedDriverGeneration: 1, expectedRevision: 1,
      updates: delivery(2).updates, mode: "replay" as const,
    };
    broker.reserveTaskUpdate(capabilityToken, secondTransfer.transferId, secondTransfer.payloadDigest, { expectedDriverGeneration: 1, taskRevision: 1 });
    expect(broker.acceptTaskUpdate(capabilityToken, secondTransfer)).toMatchObject({ status: "committed" });
    const beforeAck = await client.callTool({ name: "codex_tool_wait", arguments: { ...reference, operation_id: 1 } });
    expect(beforeAck).toEqual(firstReply);
    const firstAck = await client.callTool({ name: "codex_task_update_ack", arguments: { ...reference,
      delivery_id: firstDelivery.deliveryId, through_revision: firstDelivery.throughRevision,
    } });
    const nextEnvelope = firstAck.structuredContent as { native_result: BrokerToolResult; task_update: UpdateDelivery };
    expect(nextEnvelope.native_result.structuredContent).toEqual({ acknowledgedRevision: 1, acceptedRevision: 2 });
    expect(nextEnvelope.task_update.updates).toEqual(delivery(2).updates);
    const secondDelivery = structuredClone(nextEnvelope.task_update);
    const premature = await client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 2, task_revision: 2, cmd: "new decision" } });
    expect((premature.structuredContent as { native_result: BrokerToolResult }).native_result.structuredContent)
      .toMatchObject({ code: "task_update_not_executed", reason: "unacknowledged" });
    const secondAck = await client.callTool({ name: "codex_task_update_ack", arguments: { ...reference,
      delivery_id: secondDelivery.deliveryId, through_revision: secondDelivery.throughRevision,
    } });
    expect(secondAck.structuredContent).toEqual({ acknowledgedRevision: 2, acceptedRevision: 2 });
    expect<unknown>(await client.callTool({ name: "codex_tool_wait", arguments: { ...reference, operation_id: 1 } })).toEqual(original);
    expect<unknown>(await client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, task_revision: 0, cmd: "one real operation" } })).toEqual(original);
    const conflict = await client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, task_revision: 2, cmd: "one real operation" } });
    expect(conflict).toMatchObject({ isError: true, structuredContent: { code: "codex_tool_operation_conflict" } });
    const oldStart = await client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 3, task_revision: 0, cmd: "late old call" } });
    expect(oldStart).toMatchObject({ isError: true, structuredContent: { code: "task_update_not_executed", reason: "revision_mismatch" } });
    const rejectedRetry = await client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 2, task_revision: 2, cmd: "new decision" } });
    expect(rejectedRetry).toMatchObject({ isError: true, structuredContent: { code: "task_update_not_executed", reason: "unacknowledged" } });
    if (contract === "safe") {
      const oldAnswer = await client.callTool({ name: "codex_turn_complete", arguments: { ...reference, final_answer: "must not upgrade this answer" } });
      expect(oldAnswer).toMatchObject({ isError: true, structuredContent: { code: "task_update_unacknowledged" } });
      const completed = await client.callTool({ name: "codex_turn_complete", arguments: { ...reference, task_revision: 2, final_answer: "full current answer" } });
      expect(completed.structuredContent).toEqual({ completed: true, duplicate: false });
    } else {
      broker.beginFinalOutput(capabilityToken, { expectedDriverGeneration: 2, taskRevision: 2 });
      const ignored = await client.callTool({ name: "codex_task_update_ack", arguments: { ...reference, delivery_id: firstDelivery.deliveryId, through_revision: 1 } });
      expect(ignored.structuredContent).toEqual({ acknowledgedRevision: 2, acceptedRevision: 2, ignored: "final_output_started" });
    }
    expect(firstDelivery.updates).toEqual(delivery().updates);
  } finally {
    await client.close().catch(() => {});
    await broker.close();
  }
}, 15_000);

test("initial protocol is opt in and keeps tool results below user instructions and higher priorities", () => {
  const parsed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
    context: { systemPrompt: ["system priority"], messages: [{ role: "user", content: "task", timestamp: 1 }] },
  };
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { taskUpdateProtocol: 1 });
  expect(compiled.text).toContain('"protocol":"task-updates-v1","task_revision":0');
  expect(compiled.text).toContain("verified user-level task requirements");
  expect(compiled.text).toContain("original system/developer priority");
  expect(compiled.text).toContain("First process the original native_result");
  expect(compiled.text).toContain("identical start retry keeps its original");
  expect(compiled.text).toContain("normal streaming");
  expect(compiled.text).toContain("Once the final answer starts, call no ACK or other tool");
  expect(compileChatGptWebPrompt(parsed, capabilities, token).text).not.toContain("task-updates-v1");
  expect(() => compileChatGptWebPrompt(parsed, capabilities, token, { taskUpdateProtocol: 1, retainedContinuity: true })).toThrow("new ordinary Full Native execution");
  expect(() => compileChatGptWebPrompt({ ...parsed, _compactionRequest: true }, capabilities, token, { taskUpdateProtocol: 1 })).toThrow("new ordinary Full Native execution");
});

test("ACK controls and their Zero Risk namespace cannot become Native gateway tools", async () => {
  const snapshot = { tools: [
    { name: "codex_task_update_ack", parameters: {}, description: "bridge control" },
    { name: "codex_task_update_ack", namespace: "mcp__own", parameters: {}, description: "own bridge" },
    { name: "shadow", namespace: "mcp__own", parameters: {}, description: "own namespace" },
    { name: "outside", parameters: {}, description: "available Native tool" },
  ] } as BrokerTurnSnapshot;
  for (const contract of ["native", "safe"] as const) {
    for (const wireName of ["codex_task_update_ack", "mcp__own__codex_task_update_ack"]) {
      expect(() => planNativeTool("codex_tool_call", { wire_name: wireName, arguments: {} }, snapshot, contract)).toThrow("Bridge control tools");
    }
  }
  const plan = planNativeTool("codex_tool_inventory", {}, snapshot, "safe");
  expect(plan).toMatchObject({ result: { structuredContent: { total: 1, tools: [{ wire_name: "outside" }] } } });
  const rawSnapshot = { tools: [{ name: "exec", freeform: true, parameters: {}, description: "gateway" }] } as BrokerTurnSnapshot;
  const rawPlan = planNativeTool("codex_tool_call", { wire_name: "exec", input: "await tools.mcp__own__codex_task_update_ack({});" }, rawSnapshot, "native");
  if (!("tool" in rawPlan)) throw new Error("expected gateway plan");
  let dispatched = 0;
  const evaluate = new Function("tools", "ALL_TOOLS", `return (async () => { ${rawPlan.payload.input} })();`);
  await expect(evaluate({ mcp__own__codex_task_update_ack: () => { dispatched += 1; } }, [{ name: "mcp__own__codex_task_update_ack" }]))
    .rejects.toThrow("bridge query");
  expect(dispatched).toBe(0);
});
