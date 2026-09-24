import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTurnBroker, RemoteTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { nativePublicResult, type NativeToolEntry } from "../src/adapters/chatgpt-web/native-tool-contract";
import { type NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import { defaultBrokerEndpoint } from "../src/config";
import type { CodexTool } from "../src/types";

const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-native-wait-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;

async function fixture(contract: "native" | "safe", tools: CodexTool[] = [{
  name: "exec_command", description: "Execute in the outer harness",
  parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
}]) {
  const socket = defaultBrokerEndpoint(join(root, String(++sequence)));
  const broker = TurnBroker.forSocket(socket);
  const capability = { authorityMode: "delegated" as const, threadId: "thread-native-wait", turnId: `turn-native-wait-${sequence}`, tools };
  const token = contract === "native"
    ? await broker.register(capability)
    : await broker.registerSafe(capability, "native-wait-surface-123456789", undefined, "native-wait-test", { requireSentConfirmation: false });
  if (contract === "safe") broker.startSafeTurn(token);
  const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(socket, { method: "claim", token, contract });
  await callTurnBroker(socket, { method: "activity_complete", token, activityId: claim.activityId });
  const invoke = (method: "native_operation_start" | "native_operation_wait", operationId: number, entry?: NativeToolEntry, nativeInput?: Record<string, unknown>, signal?: AbortSignal) => callTurnBroker<NativeOperationReply>(socket, {
    method, token, contract, nativeWaitProtocol: 1, operationId, waitMs: 1,
    ...(entry ? { entry, nativeInput: nativeInput ?? {} } : {}),
  }, 5_000, signal);
  return {
    socket, broker, token, capability, claim,
    start: (id: number, entry: NativeToolEntry, args: Record<string, unknown>) => invoke("native_operation_start", id, entry, args),
    wait: (id: number) => invoke("native_operation_wait", id),
    close: async () => { broker.revoke(token); await broker.close(); },
  };
}

for (const contract of ["native", "safe"] as const) describe(`${contract} Native waiting integration`, () => {
  test("one admitted call survives multiple waits, registry changes, and owner transport reconnect", async () => {
    const f = await fixture(contract);
    try {
      const observing = new RemoteTurnBroker(f.socket).waitForNativeWaiting(f.token, 0);
      expect(await f.start(1, "codex_exec", { cmd: "inert label" })).toMatchObject({ kind: "pending", operation_id: 1 });
      expect(await observing).toMatchObject({ activeOperations: 1 });
      const [request] = await f.broker.nextToolBatch(f.token);
      expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: "inert label" } });
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      expect(await f.start(1, "codex_exec", { cmd: "inert label" })).toMatchObject({ kind: "pending" });
      f.broker.updateEnvironment(f.token, { ...f.capability, tools: [] });
      expect((await f.broker.nextToolBatch(f.token)).map(call => call.callId)).toEqual([request!.callId]);
      const raw: BrokerToolResult = {
        content: [{ type: "text", text: "" }, { type: "image", data: "AA==", mimeType: "image/png" }],
        structuredContent: { operation_id: 777, kind: "codex_native_pending", answer: null },
        isError: false, _meta: { native: true },
      };
      f.broker.completeTool(f.token, request!.callId, raw);
      expect(f.broker.beginCompletionFence(f.token)).toBeUndefined();
      if (contract === "safe") expect(() => f.broker.completeSafeTurn(f.token, "too early")).toThrow("results have been delivered");
      expect(await f.wait(1)).toEqual({ kind: "result", result: raw });
      expect(await f.start(1, "codex_exec", { cmd: "inert label" })).toEqual({ kind: "result", result: raw });
      await expect(f.start(1, "codex_exec", { cmd: "another label" })).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      expect(await f.start(2, "codex_exec", { cmd: "inert label" })).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
      const revision = f.broker.beginCompletionFence(f.token);
      expect(revision).toBeNumber();
      if (contract === "safe") expect(f.broker.completeSafeTurn(f.token, "done")).toEqual({ completed: true, duplicate: false });
      else expect(f.broker.commitCompletionFence(f.token, revision!)).toBe(true);
    } finally { await f.close(); }
  });

  test("rejected starts retain identity after the registry becomes valid", async () => {
    const f = await fixture(contract, []);
    try {
      const rejected = await f.start(1, "codex_exec", { cmd: "inert" });
      f.broker.updateEnvironment(f.token, { ...f.capability, tools: [{ name: "exec_command", description: "now available", parameters: { type: "object" } }] });
      expect(await f.start(1, "codex_exec", { cmd: "inert" })).toEqual(rejected);
      expect(await f.wait(1)).toEqual(rejected);
      await expect(f.start(1, "codex_exec", { cmd: "different" })).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      expect(await f.start(2, "codex_exec", { cmd: "inert" })).toMatchObject({ kind: "pending" });
      const [request] = await f.broker.nextToolBatch(f.token);
      expect(request?.arguments).toEqual({ cmd: "inert" });
      f.broker.completeTool(f.token, request!.callId, nativePublicResult({ completed: true }));
      expect(await f.wait(2)).toMatchObject({ kind: "result" });
    } finally { await f.close(); }
  });

  test("invalid null parameters are rejected and are not normalized into an admissible default", async () => {
    const f = await fixture(contract);
    try {
      const rejected = await f.start(1, "codex_tool_inventory", { offset: null });
      expect(rejected).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
      expect(await f.start(1, "codex_tool_inventory", { offset: null })).toEqual(rejected);
      await expect(f.start(1, "codex_tool_inventory", {})).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
      expect(await f.start(2, "codex_tool_inventory", {})).toMatchObject({ kind: "result", result: { structuredContent: { total: 1 } } });
    } finally { await f.close(); }
  });

  test("the bridge wait control cannot be discovered or recursively dispatched through Native tools", async () => {
    const f = await fixture(contract, [
      { name: "codex_tool_wait", description: "not a Native tool", parameters: { type: "object" } },
      { name: "outside", description: "ordinary Native tool", parameters: { type: "object" } },
    ]);
    try {
      expect(await f.start(1, "codex_tool_inventory", {})).toMatchObject({ kind: "result", result: { structuredContent: { total: 1, tools: [{ wire_name: "outside" }] } } });
      expect(await f.start(2, "codex_tool_call", { wire_name: "codex_tool_wait", arguments: {} })).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
      expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
    } finally { await f.close(); }
  });

  test("explicit Native cancellation retains its public cause and clears only the cancelled capability", async () => {
    const f = await fixture(contract);
    try {
      const waiting = callTurnBroker(f.socket, { method: "native_operation_start", token: f.token, contract, nativeWaitProtocol: 1,
        operationId: 1, entry: "codex_exec", nativeInput: { cmd: "inert cancellation fixture" } }, 5_000).catch(error => error);
      const [request] = await f.broker.nextToolBatch(f.token);
      f.broker.revoke(f.token, new DOMException("private cancellation details", "AbortError"));
      expect(await waiting).toMatchObject({ code: "codex_tool_cancelled", message: "The Native turn was explicitly cancelled" });
      expect(() => f.broker.completeTool(f.token, request!.callId, nativePublicResult({ late: true }))).toThrow();
    } finally { await f.close(); }
  });

  test("gateway inventory finishes from its admitted discovery snapshot after its start handler returns pending", async () => {
    const f = await fixture(contract, [
      { name: "exec", description: "nested tool gateway", parameters: {}, freeform: true },
      { name: "tool_search", description: "Load additional tools", parameters: { type: "object" }, toolSearch: true },
    ]);
    try {
      expect(await f.start(1, "codex_tool_inventory", { query: "missing candidate" })).toMatchObject({ kind: "pending" });
      const [request] = await f.broker.nextToolBatch(f.token);
      expect(request?.wireName).toBe("exec");
      f.broker.updateEnvironment(f.token, { ...f.capability, tools: [] });
      f.broker.completeTool(f.token, request!.callId, nativePublicResult({ tools: [], total: 0 }));
      const publicResult = await f.wait(1);
      expect(publicResult).toMatchObject({ kind: "result", result: { structuredContent: {
        tools: [], total: 0, next_offset: null,
        discovery_tools: [{ wire_name: "tool_search", kind: "tool_search", parameters: { type: "object" } }],
      } } });
      expect(await f.start(1, "codex_tool_inventory", { query: "  MISSING CANDIDATE  ", offset: 0, limit: 20, include_schema: true })).toEqual(publicResult);
    } finally { await f.close(); }
  });

  test("queued inventory is a compaction control terminal, but handed-off work keeps its original result", async () => {
    const f = await fixture(contract, [{ name: "exec", description: "nested gateway", parameters: {}, freeform: true }]);
    try {
      expect(await f.start(1, "codex_tool_inventory", {})).toMatchObject({ kind: "pending" });
      const [waiting] = await f.broker.nextToolBatch(f.token);
      expect(await f.start(2, "codex_tool_inventory", {})).toMatchObject({ kind: "pending" });
      expect(f.broker.requestCompaction(f.token, nativePublicResult({ checkpoint: "control, not inventory" }))).toBe(1);
      const queued = await f.wait(2);
      expect(queued).toMatchObject({ kind: "result", result: { structuredContent: { checkpoint: "control, not inventory" }, _meta: { "codex/native-control": { kind: "compaction" } } } });
      expect(await f.wait(1)).toMatchObject({ kind: "pending" });
      f.broker.completeTool(f.token, waiting!.callId, nativePublicResult({ tools: [], total: 0 }));
      expect(await f.wait(1)).toMatchObject({ kind: "result", result: { structuredContent: { total: contract === "native" ? 1 : 0 } } });
      expect(await f.wait(2)).toEqual(queued);
      expect(f.broker.compactionDeliveryCount(f.token)).toBe(1);
    } finally { await f.close(); }
  });

  test("the public MCP contract exposes stable identities and a Broker-only wait tool", async () => {
    const f = await fixture(contract);
    const client = new Client({ name: "native-wait-public-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", f.socket],
      cwd: process.cwd(), stderr: "pipe",
    });
    const reference = contract === "native" ? { turn_token: f.token } : { request_id: f.token };
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const wait = listed.tools.find(tool => tool.name === "codex_tool_wait")!;
      expect(Object.keys(wait.inputSchema.properties!)).toEqual([contract === "native" ? "turn_token" : "request_id", "operation_id"]);
      for (const entry of ["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image", "codex_tool_inventory"]) {
        expect(listed.tools.find(tool => tool.name === entry)!.inputSchema.required).toContain("operation_id");
      }
      const callSchema = listed.tools.find(tool => tool.name === "codex_tool_call")!.inputSchema as Record<string, unknown>;
      if (contract === "safe") {
        expect(callSchema.required).toContain("operation_id");
      } else {
        const branches = callSchema.anyOf as Array<Record<string, unknown>>;
        expect(branches).toHaveLength(2);
        const ordinary = branches.find(branch => (branch.required as string[] | undefined)?.includes("operation_id"));
        expect(ordinary).toBeDefined();
        expect(ordinary).toMatchObject({
          not: {
            properties: { wire_name: { const: "codex.control.compaction_handoff" } },
            required: ["wire_name"],
          },
        });
        const control = branches.find(branch => (
          ((branch.properties as Record<string, unknown> | undefined)?.wire_name as Record<string, unknown> | undefined)?.const
          === "codex.control.compaction_handoff"
        ));
        expect(control).toBeDefined();
        expect((control!.required as string[] | undefined) ?? []).not.toContain("operation_id");
        expect(control).toMatchObject({ not: { required: ["operation_id"] } });

        const rejectedControl = await client.callTool({
          name: "codex_tool_call",
          arguments: {
            ...reference,
            operation_id: 2,
            wire_name: "codex.control.compaction_handoff",
            arguments: { handoff_id: "handoff-test", summary: "checkpoint" },
          },
        });
        expect(rejectedControl.isError).toBe(true);
        expect(JSON.stringify(rejectedControl)).toContain("operation_id");
      }
      expect(client.getInstructions()).toContain("before sending the original tool call");
      const missingCallId = await client.callTool({ name: "codex_tool_call", arguments: { ...reference, wire_name: "not-admitted", arguments: {} } });
      expect(missingCallId.isError).toBe(true);
      expect(JSON.stringify(missingCallId)).toContain("operation_id");
      const legacy = await client.callTool({ name: "codex_exec", arguments: { ...reference, cmd: "never admitted" } });
      expect(legacy.isError).toBe(true);
      expect(JSON.stringify(legacy)).toContain("operation_id");
      expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
      const executing = client.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, cmd: "inert label" } });
      const [request] = await f.broker.nextToolBatch(f.token);
      f.broker.completeTool(f.token, request!.callId, { content: [{ type: "text", text: "unchanged" }], isError: false, _meta: { preserved: true } });
      const result = await executing;
      expect(result).toMatchObject({ content: [{ type: "text", text: "unchanged" }], isError: false, _meta: { preserved: true } });
      expect(await client.callTool({ name: "codex_tool_wait", arguments: { ...reference, operation_id: 1 } })).toEqual(result);
      const unknown = await client.callTool({ name: "codex_tool_wait", arguments: { ...reference, operation_id: 2 } });
      expect(unknown).toMatchObject({ isError: true, structuredContent: { code: "codex_tool_operation_unknown" } });
    } finally { await client.close().catch(() => {}); await f.close(); }
  }, 15_000);
});

test("a legacy MCP process cannot claim Native dispatch authority", async () => {
  const f = await fixture("native");
  try {
    await expect(callTurnBroker(f.socket, { method: "claim", token: f.token, nativeWaitProtocol: 0 })).rejects.toMatchObject({ code: "codex_tool_upgrade_required" });
    expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
  } finally { await f.close(); }
});

test("both MCP contracts return pending at the real 30-second boundary and replay after connector replacement", async () => {
  await Promise.all((["native", "safe"] as const).map(async contract => {
    const f = await fixture(contract);
    const clients: Client[] = [];
    const connect = async () => {
      const client = new Client({ name: "native-wait-window-test", version: "1" });
      clients.push(client);
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", f.socket],
        cwd: process.cwd(), stderr: "pipe",
      }));
      return client;
    };
    const reference = contract === "native" ? { turn_token: f.token } : { request_id: f.token };
    try {
      const firstClient = await connect();
      const startedAt = performance.now();
      const starting = firstClient.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, cmd: "inert long-wait fixture" } });
      const [request] = await f.broker.nextToolBatch(f.token);
      const pending = await starting;
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(29_000);
      expect(performance.now() - startedAt).toBeLessThan(45_000);
      expect(pending).toMatchObject({
        structuredContent: { kind: "codex_native_pending", operation_id: 1, next_tool: "codex_tool_wait" },
        _meta: { "codex/native-control": { version: 1, kind: "pending" } },
      });
      expect(f.broker.beginCompletionFence(f.token)).toBeUndefined();
      await firstClient.close();
      const result = { content: [{ type: "text" as const, text: "Native denied approval" }], isError: true, _meta: { denial: true } };
      f.broker.completeTool(f.token, request!.callId, result);
      const reconnected = await connect();
      expect(await reconnected.callTool({ name: "codex_tool_wait", arguments: { ...reference, operation_id: 1 } })).toEqual(result);
      expect(await reconnected.callTool({ name: "codex_exec", arguments: { ...reference, operation_id: 1, cmd: "inert long-wait fixture" } })).toEqual(result);
      expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
    } finally {
      await Promise.all(clients.map(client => client.close().catch(() => {})));
      await f.close();
    }
  }));
}, 50_000);

test("losing an MCP process during its first query cannot cancel or duplicate the admitted operation", async () => {
  const f = await fixture("native");
  const client = new Client({ name: "native-wait-process-loss", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", f.socket], cwd: process.cwd(), stderr: "pipe" });
  try {
    await client.connect(transport);
    const lost = client.callTool({ name: "codex_exec", arguments: { turn_token: f.token, operation_id: 1, cmd: "only once" } }).catch(error => error);
    const [request] = await f.broker.nextToolBatch(f.token);
    await client.close();
    expect(await lost).toBeInstanceOf(Error);
    f.broker.completeTool(f.token, request!.callId, nativePublicResult({ originalCall: request!.callId }));
    expect(await f.start(1, "codex_exec", { cmd: "only once" })).toMatchObject({ kind: "result", result: { structuredContent: { originalCall: request!.callId } } });
    // Allow the closed socket's cleanup callback to settle; no separate MCP release is possible.
    for (let attempt = 0; attempt < 20 && f.broker.beginCompletionFence(f.token) === undefined; attempt += 1) await Bun.sleep(5);
    expect(f.broker.beginCompletionFence(f.token)).toBeNumber();
  } finally { await client.close().catch(() => {}); await f.close(); }
});

test("retiring queued, waiting, and unread operations never transfers them to a fresh capability", async () => {
  const f = await fixture("native");
  try {
    await f.start(1, "codex_exec", { cmd: "waiting" });
    await f.start(2, "codex_exec", { cmd: "ready" });
    const batch = await f.broker.nextToolBatch(f.token);
    const waiting = batch.find(call => call.arguments?.cmd === "waiting")!;
    const ready = batch.find(call => call.arguments?.cmd === "ready")!;
    f.broker.completeTool(f.token, ready.callId, nativePublicResult({ privateResult: true }));
    await f.start(3, "codex_exec", { cmd: "queued" });
    f.broker.revoke(f.token);
    expect(() => f.broker.completeTool(f.token, waiting!.callId, nativePublicResult({ late: true }))).toThrow();
    await expect(f.wait(2)).rejects.toMatchObject({ code: "codex_tool_operation_retired" });
    const freshToken = await f.broker.register(f.capability);
    try {
      await expect(callTurnBroker(f.socket, { method: "native_operation_wait", token: freshToken, contract: "native", nativeWaitProtocol: 1, operationId: 2, waitMs: 1 })).rejects.toMatchObject({ code: "codex_tool_operation_unknown" });
      expect(f.broker.beginCompletionFence(freshToken)).toBeNumber();
    } finally { f.broker.revoke(freshToken); }
  } finally { await f.close(); }
});
