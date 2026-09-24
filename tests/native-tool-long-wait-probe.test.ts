import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  DEV_NATIVE_LONG_WAIT_MCP_CONTRACT,
  DEV_NATIVE_LONG_WAIT_TOOL_NAME,
} from "../src/native-tool-long-wait-probe";

const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-long-wait-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function endpoint(name: string): string {
  return defaultBrokerEndpoint(join(root, name));
}

function capability() {
  return {
    authorityMode: "delegated" as const,
    threadId: "thread-long-wait-probe",
    turnId: "turn-long-wait-probe",
    tools: [{
      name: DEV_NATIVE_LONG_WAIT_TOOL_NAME,
      description: "DEV inert delayed result",
      parameters: {
        type: "object",
        properties: { operation_id: { type: "integer" } },
        required: ["operation_id"],
        additionalProperties: false,
      },
    }],
  };
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

describe("DEV Native long-wait probe", () => {
  test("publishes the isolated operation_id and wait ABI", async () => {
    const socketPath = endpoint("abi");
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(capability(), 60_000, "long-wait-probe-abi");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", DEV_NATIVE_LONG_WAIT_MCP_CONTRACT, "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "long-wait-probe-abi-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual(["codex_exec", "codex_tool_wait"]);
      const exec = listed.tools.find(tool => tool.name === "codex_exec")!;
      const wait = listed.tools.find(tool => tool.name === "codex_tool_wait")!;
      expect(exec.inputSchema.required).toEqual(expect.arrayContaining(["turn_token", "operation_id", "cmd"]));
      expect(wait.inputSchema.required).toEqual(expect.arrayContaining(["turn_token", "operation_id"]));
      expect(exec.description).toContain("Allocate operation_id before the first call");
      expect(wait.description).toContain("never creates or re-dispatches");
      expect(client.getInstructions()).toContain("next positive integer operation_id");
      expect(token).toStartWith("turn_");
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 15_000);

  test("public codex_exec replays one completed operation and rejects a conflicting retry", async () => {
    const socketPath = endpoint("public-call");
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(capability(), 60_000, "long-wait-probe-public-call");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--contract", DEV_NATIVE_LONG_WAIT_MCP_CONTRACT, "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "long-wait-probe-public-call-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const first = client.callTool({
        name: "codex_exec",
        arguments: { turn_token: token, operation_id: 1, cmd: "inert probe" },
      });
      const [call] = await broker.nextToolBatch(token);
      expect(call).toMatchObject({
        wireName: DEV_NATIVE_LONG_WAIT_TOOL_NAME,
        arguments: { operation_id: 1 },
      });
      broker.completeTool(token, call!.callId, toolResult({ output: "public result" }));
      expect((await first).structuredContent).toEqual({ output: "public result" });

      const replay = await client.callTool({
        name: "codex_exec",
        arguments: { turn_token: token, operation_id: 1, cmd: "inert probe" },
      });
      expect(replay.structuredContent).toEqual({ output: "public result" });

      const conflict = await client.callTool({
        name: "codex_exec",
        arguments: { turn_token: token, operation_id: 1, cmd: "different inert probe" },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.stringify(conflict.content)).toContain("already bound to another request");
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 15_000);

  test("retries and waits reuse one Broker call while a new operation_id creates a new call", async () => {
    const socketPath = endpoint("identity");
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(capability(), 60_000, "long-wait-probe-identity");
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token,
      contract: "native",
    });
    await callTurnBroker(socketPath, {
      method: "activity_complete",
      token,
      activityId: claimed.activityId,
    });
    try {
      const firstStart = callTurnBroker<{ kind: string; operation_id: number; next_tool?: string }>(socketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: 1,
        fingerprint: "a".repeat(64),
        waitMs: 5,
      }, 1_000);
      const [firstCall] = await broker.nextToolBatch(token);
      expect(firstCall).toMatchObject({
        wireName: DEV_NATIVE_LONG_WAIT_TOOL_NAME,
        arguments: { operation_id: 1 },
      });
      await expect(firstStart).resolves.toEqual({
        kind: "pending",
        operation_id: 1,
        next_tool: "codex_tool_wait",
      });

      await expect(callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: 1,
        fingerprint: "a".repeat(64),
        waitMs: 1,
      }, 1_000)).resolves.toMatchObject({ kind: "pending", operation_id: 1 });
      await expect(callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: 1,
        fingerprint: "b".repeat(64),
        waitMs: 1,
      }, 1_000)).rejects.toThrow("already bound to another request");

      broker.completeTool(token, firstCall!.callId, toolResult({ output: "probe complete" }));
      await expect(callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_wait",
        bindingId: claimed.bindingId,
        operationId: 1,
        waitMs: 1,
      }, 1_000)).resolves.toMatchObject({
        kind: "result",
        operation_id: 1,
        result: { structuredContent: { output: "probe complete" } },
      });
      await expect(callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: 1,
        fingerprint: "a".repeat(64),
        waitMs: 1,
      }, 1_000)).resolves.toMatchObject({ kind: "result", operation_id: 1 });

      const secondStart = callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_start",
        bindingId: claimed.bindingId,
        operationId: 2,
        fingerprint: "a".repeat(64),
        waitMs: 5,
      }, 1_000);
      const [secondCall] = await broker.nextToolBatch(token);
      expect(secondCall).toMatchObject({
        wireName: DEV_NATIVE_LONG_WAIT_TOOL_NAME,
        arguments: { operation_id: 2 },
      });
      expect(secondCall!.callId).not.toBe(firstCall!.callId);
      await expect(secondStart).resolves.toMatchObject({ kind: "pending", operation_id: 2 });
    } finally {
      broker.revoke(token);
      await broker.close();
    }
  }, 15_000);

  test("wait cannot create an unknown operation", async () => {
    const socketPath = endpoint("unknown");
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(capability(), 60_000, "long-wait-probe-unknown");
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token,
      contract: "native",
    });
    await callTurnBroker(socketPath, {
      method: "activity_complete",
      token,
      activityId: claimed.activityId,
    });
    try {
      await expect(callTurnBroker(socketPath, {
        method: "dev_long_wait_probe_wait",
        bindingId: claimed.bindingId,
        operationId: 9,
        waitMs: 1,
      }, 1_000)).rejects.toThrow("operation_id is unknown");
    } finally {
      broker.revoke(token);
      await broker.close();
    }
  });
});
