import { expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextSnapshot, restoreContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import type { ChatGptMcpContract } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { createContinuityMcpClient, type ContinuityMcpTransport } from "./helpers/continuity-mcp-client";

async function fixture(contract: ChatGptMcpContract, transport: ContinuityMcpTransport) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-mcp-contract-"));
  const brokerSocketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(brokerSocketPath);
  let connection: Awaited<ReturnType<typeof createContinuityMcpClient>> | undefined;
  const close = async () => {
    try { await connection?.close(); } finally {
      try { await broker.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
  };
  try {
    const environment = {
      authorityMode: "delegated" as const, threadId: "mcp-contract-thread", turnId: "mcp-contract-turn",
      tools: [{ name: "exec_command", description: "Outer harness command", parameters: {
        type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false,
      } }],
    };
    const token = contract === "native" ? await broker.register(environment)
      : await broker.registerSafe(environment, "mcp-contract-surface-12345678", undefined, "mcp-contract", { requireSentConfirmation: false });
    connection = await createContinuityMcpClient({ brokerSocketPath, contract, transport });
    return { broker, token, client: connection.client, close, closeConnection: connection.close,
      reference: contract === "native" ? { turn_token: token } : { request_id: token } };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const contract of ["native", "safe"] as const) {
  test(`${contract} stdio and in-process preserve validation, authorization, Native results and replay`, async () => {
    const transcripts: unknown[] = [];
    for (const transport of ["stdio", "in-process"] as const) {
      const f = await fixture(contract, transport);
      try {
        const catalog = await f.client.listTools();
        expect(catalog.tools.some(tool => tool.name === "codex_turn_start")).toBe(contract === "safe");
        const missingId = await f.client.callTool({ name: "codex_exec", arguments: { ...f.reference, cmd: "never dispatched" } });
        expect(missingId.isError).toBe(true);
        expect(JSON.stringify(missingId)).toContain("operation_id");
        const wrongCredential = await f.client.callTool({ name: "codex_exec", arguments: {
          [contract === "native" ? "request_id" : "turn_token"]: f.token, operation_id: 1, cmd: "never dispatched",
        } });
        expect(wrongCredential.isError).toBe(true);
        const invalidCapability = await f.client.callTool({ name: "codex_exec", arguments: {
          [contract === "native" ? "turn_token" : "request_id"]: "invalid-capability-123456789", operation_id: 1, cmd: "never dispatched",
        } });
        expect(invalidCapability.isError).toBe(true);
        expect(f.broker.beginCompletionFence(f.token)).toBeNumber();

        let beforeStart, started, duplicateStart;
        if (contract === "safe") {
          beforeStart = await f.client.callTool({ name: "codex_exec", arguments: { ...f.reference, operation_id: 1, cmd: "never dispatched" } });
          expect(beforeStart.isError).toBe(true);
          expect(JSON.stringify(beforeStart)).toContain("codex_turn_start");
          started = await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
          duplicateStart = await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
          expect(started.structuredContent).toEqual({ started: true, duplicate: false });
          expect(duplicateStart.structuredContent).toEqual({ started: true, duplicate: true });
        }
        const denied = await f.client.callTool({ name: "codex_tool_call", arguments: {
          ...f.reference, operation_id: 2, wire_name: "not_admitted", arguments: {},
        } });
        expect(denied).toMatchObject({ isError: true, structuredContent: { code: "codex_tool_admission_rejected" } });
        expect(f.broker.beginCompletionFence(f.token)).toBeNumber();

        const executing = f.client.callTool({ name: "codex_exec", arguments: { ...f.reference, operation_id: 3, cmd: "inert command label" } });
        const [request] = await f.broker.nextToolBatch(f.token);
        expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: "inert command label" } });
        const original = { content: [{ type: "text" as const, text: "unchanged harness result" }],
          structuredContent: { harness_value: 27 }, isError: false, _meta: { preserved: true } };
        f.broker.completeTool(f.token, request!.callId, original);
        const result = await executing;
        expect(result).toEqual(original);
        const retry = await f.client.callTool({ name: "codex_exec", arguments: { ...f.reference, operation_id: 3, cmd: "inert command label" } });
        expect(retry).toEqual(result);
        const replay = await f.client.callTool({ name: "codex_tool_wait", arguments: { ...f.reference, operation_id: 3 } });
        expect(replay).toEqual(result);
        const unknown = await f.client.callTool({ name: "codex_tool_wait", arguments: { ...f.reference, operation_id: 4 } });
        expect(unknown).toMatchObject({ isError: true, structuredContent: { code: "codex_tool_operation_unknown" } });
        expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
        transcripts.push({ catalog, instructions: f.client.getInstructions(), missingId, wrongCredential, invalidCapability,
          beforeStart, started, duplicateStart, denied, result, retry, replay, unknown });
      } finally { await f.close(); }
    }
    expect(transcripts[1]).toEqual(transcripts[0]);
  }, 15_000);

  test(`${contract} stdio and in-process retain context receipts and source refusals`, async () => {
    const transcripts: unknown[] = [];
    const source = createContextSnapshot(parseRequest({ model: "gpt-6", input: "Fixed source marker.\n保留原文。" })).toWire();
    for (const transport of ["stdio", "in-process"] as const) {
      const f = await fixture(contract, transport);
      try {
        const snapshot = restoreContextSnapshot(source);
        f.broker.registerContextPlan(f.token, { snapshot, planId: "selected", manifestDigest: "manifest", deliveryByTarget: {} });
        f.broker.selectContextPlan(f.token, "selected");
        if (contract === "safe") await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
        else f.broker.markContextPlanSent(f.token, "selected");
        const args = { ...f.reference, context_id: snapshot.context_id };
        const list = await f.client.callTool({ name: "codex_context_list", arguments: { ...args, view: "entries" } });
        expect(list.isError).not.toBe(true);
        const read = await f.client.callTool({ name: "codex_context_read", arguments: { ...args, reads: [{ read_ref: snapshot.targets[0]!.read_ref! }] } });
        expect(parseContextTextReadResult(read).bodies).toEqual(["Fixed source marker.\n保留原文。"]);
        const overview = await f.client.callTool({ name: "codex_context_list", arguments: { ...args, view: "overview" } });
        expect(overview.isError).not.toBe(true);
        expect(f.broker.contextStatus(f.token)?.context_ready).toBe(true);
        const wrongSource = await f.client.callTool({ name: "codex_context_read", arguments: { ...args, reads: [{ read_ref: "unavailable-source" }] } });
        expect(wrongSource.isError).toBe(true);
        const wrongScope = await f.client.callTool({ name: "codex_context_list", arguments: { ...args, context_id: "another-context", view: "overview" } });
        expect(wrongScope.isError).toBe(true);
        expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
        transcripts.push({ list, read, overview, wrongSource, wrongScope });
      } finally { await f.close(); }
    }
    expect(transcripts[1]).toEqual(transcripts[0]);
  }, 15_000);
}

test("in-process navigation exhaustion keeps protocol errors and leaves other scopes connected", async () => {
  const f = await fixture("native", "in-process");
  try {
    const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: "Source for a finite navigation budget" }));
    const transaction = await f.broker.beginCompactionTransaction("in-process-navigation");
    const handle = f.broker.registerCompactionContext({ snapshot, contract: "native", transactionToken: transaction.token,
      handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "writer", expiresAt: Date.now() + 30_000,
      remainingBudget: { tokens: 2_000, reserved_tokens: 500, wire_bytes: 20_000, reserved_wire_bytes: 1_000 } });
    f.broker.markCompactionContextDelivered(handle.compactionToken);
    const invalid = () => f.client.callTool({ name: "codex_context_list", arguments: {
      compaction_token: handle.compactionToken, context_id: handle.contextId, view: "entries", cursor: "invalid",
    } });
    for (let count = 0; count < 3; count++) expect((await invalid()).isError).toBe(true);
    const rejection = await invalid().then(() => undefined, error => error);
    expect(rejection).toBeInstanceOf(McpError);
    expect(rejection).toMatchObject({ code: ErrorCode.InvalidRequest, message: expect.stringContaining("CONTEXT_NAVIGATION_STOPPED") });
    expect((await f.client.listTools()).tools.some(tool => tool.name === "codex_context_list")).toBe(true);
    const submitted = await f.client.callTool({ name: "codex_tool_call", arguments: { turn_token: transaction.token,
      wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: transaction.handoffId, summary: "Preserved summary" } } });
    expect(submitted.structuredContent).toEqual({ submitted: true });
  } finally { await f.close(); }
});

test("in-process fixture clients are independent and a closed client cannot send more requests", async () => {
  const first = await fixture("safe", "in-process");
  let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    second = await fixture("safe", "in-process");
    expect(first.client).not.toBe(second.client);
    await first.closeConnection();
    await first.closeConnection();
    const rejection = await first.client.listTools().then(() => undefined, error => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((await second.client.callTool({ name: "codex_turn_start", arguments: second.reference })).structuredContent)
      .toEqual({ started: true, duplicate: false });
  } finally {
    try { await first.close(); } finally { await second?.close(); }
  }
});
