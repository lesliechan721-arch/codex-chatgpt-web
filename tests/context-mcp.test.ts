import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { defaultBrokerEndpoint } from "../src/config";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { TurnBroker, RemoteTurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import { BRIDGE_TOOL_NAMES, planNativeTool } from "../src/adapters/chatgpt-web/native-tool-contract";
import { observeMcpToolCalls } from "../src/adapters/chatgpt-web/mcp-observation";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { ContextScope } from "../src/adapters/chatgpt-web/context-runtime";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
async function fixture(contract: "native" | "safe", publishOrdinary = true, requireSentConfirmation = false) {
  const root = mkdtempSync(join(tmpdir(), "context-mcp-")); const socket = defaultBrokerEndpoint(root); const broker = TurnBroker.forSocket(socket);
  await broker.listen(); const env = { authorityMode: "delegated" as const, threadId: "mcp-context-thread", turnId: "mcp-context-turn", tools: [] };
  const token = contract === "safe" ? await broker.registerSafe(env, "mcp-context-surface-12345678", undefined, "context-mcp-test", { requireSentConfirmation }) : await broker.register(env);
  const client = new Client({ name: "context-mcp-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  // Drain diagnostic output and retain a bounded tail for failed stdio requests.
  let diagnostics = "";
  const recordDiagnostic = (message: string) => { diagnostics = (diagnostics + message).slice(-16_384); };
  transport.stderr?.on("data", chunk => recordDiagnostic(chunk.toString()));
  client.onerror = error => recordDiagnostic(`[context-mcp-test] client error: ${error.message}\n`);
  try {
    await client.connect(transport, { timeout: 10_000 });
  } catch (error) {
    console.error(`[context-mcp-test] connection failed\n${diagnostics}`);
    await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const snapshot = createContextSnapshot(parseRequest({ model: "gpt-5", input: [{ role: "user", content: [{ type: "input_text", text: "独有片段 marker-zeta" }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }] }));
  if (publishOrdinary) { broker.registerContextPlan(token, { snapshot, planId: "selected", manifestDigest: "manifest-selected", deliveryByTarget: Object.fromEntries(snapshot.targets.map(t => [t.target_id, t.kind === "image" ? { delivery: "mcp", media_route: "mcp", required: true } : { delivery: "inline", required: false }])) });
  broker.selectContextPlan(token, "selected"); }
  const reference = contract === "safe" ? { request_id: token } : { turn_token: token };
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { ...reference, context_id: snapshot.context_id, ...args } });
  return { broker, client, snapshot, token, call, reference, diagnostics: () => diagnostics,
    async close() { await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const contract of ["native", "safe"] as const) describe(`stdio ${contract} context protocol`, () => {
  test("publishes all read tools with exclusive credentials and sends one fixed image without duplicate base64", async () => {
    const f = await fixture(contract);
    try {
      const catalog = await f.client.listTools(); const contexts = catalog.tools.filter(t => t.name.startsWith("codex_context_"));
      expect(contexts.map(t => t.name).sort()).toEqual(["codex_context_list", "codex_context_read", "codex_context_search"]);
      for (const tool of contexts) {
        expect(tool.inputSchema.properties).not.toHaveProperty("operation_id");
        expect(tool.inputSchema.properties).toHaveProperty("compaction_token");
        expect(tool.inputSchema.properties).not.toHaveProperty(contract === "safe" ? "turn_token" : "request_id");
        expect(tool.inputSchema).toHaveProperty("oneOf");
      }
      expect((await f.call("codex_context_list", { view: "overview" })).isError).toBe(true);
      if (contract === "safe") await f.client.callTool({ name: "codex_turn_start", arguments: f.reference }); else f.broker.markContextPlanSent(f.token, "selected");
      expect((await f.call("codex_context_list", { view: "overview", operation_id: 1 })).isError).toBe(true);
      expect((await f.call("codex_context_list", { view: "overview", compaction_token: "compaction_fake1234567890123456" })).isError).toBe(true);
      const list = await f.call("codex_context_list", { view: "entries" }); expect(list.isError).not.toBe(true);
      const listed = (list.structuredContent as { entries: Array<{ kind: string; read_ref: string }> }).entries;
      const imageRef = listed.find(t => t.kind === "image")!.read_ref;
      const read = await f.call("codex_context_read", { read_ref: imageRef });
      expect(read.isError).not.toBe(true);
      const blocks = read.content as Array<{ type: string; data?: string; text?: string; mimeType?: string }>;
      expect(blocks.filter(t => t.type === "image")).toEqual([expect.objectContaining({ type: "image", data: png, mimeType: "image/png" })]);
      expect(JSON.stringify(read.structuredContent)).not.toContain(png);
      expect(blocks.filter(t => t.type === "text").map(t => t.text).join("")).not.toContain(png);
      // A following query observes the transport receipt after the previous send completes.
      const overview = await f.call("codex_context_list", { view: "overview" }); expect(overview.isError).not.toBe(true);
      expect(f.broker.contextStatus(f.token)?.context_ready).toBe(true);
      const search = await f.call("codex_context_search", { query: "marker-zeta" }); expect(search.isError).not.toBe(true); expect(JSON.stringify(search)).toContain("marker-zeta");
      const repeat = await f.call("codex_context_read", { read_ref: imageRef }); expect(repeat.content).toEqual(read.content);
      const textRef = listed.find(t => t.kind !== "image")!.read_ref;
      const textResult = await f.call("codex_context_read", { read_ref: textRef });
      expect(parseContextTextReadResult(textResult).body).toBe("独有片段 marker-zeta");
      expect(textResult.structuredContent).not.toHaveProperty("content");
      expect((await f.call("codex_context_search", { query: "" })).isError).toBe(true);
      const oversized = await f.call("codex_context_list", { view: "entries", ["unknown".repeat(2000)]: true });
      expect(oversized.isError).toBe(true); expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(2048);
    } finally { await f.close(); }
  });
  test("independent compaction reads bypass the business interceptor but cannot submit or use ordinary credentials", async () => {
    const f = await fixture(contract);
    try {
      if (contract === "safe") await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
      const transaction = contract === "native" ? await f.broker.beginCompactionTransaction("stdio-compaction") : undefined;
      const handle = f.broker.registerCompactionContext({ snapshot: f.snapshot, contract, ...(transaction ? { transactionToken: transaction.token } : { turnToken: f.token }), handoffId: transaction?.handoffId ?? "safe-handoff", historyRevision: 0, ownerGeneration: "writer-one", expiresAt: Date.now() + 30_000 });
      if (contract === "safe") {
        f.broker.requestCompaction(f.token, { content: [{ type: "text", text: `compaction entry ${handle.compactionToken} context_id=${handle.contextId}` }] });
        const blocked = await f.client.callTool({ name: "codex_context_list", arguments: { compaction_token: handle.compactionToken, context_id: handle.contextId, view: "overview" } });
        expect(blocked.isError).toBe(true);
        const control = await f.client.callTool({ name: "codex_tool_inventory", arguments: { ...f.reference, operation_id: 1 } });
        expect(JSON.stringify(control)).toContain(handle.compactionToken);
      } else f.broker.markCompactionContextDelivered(handle.compactionToken);
      const readArgs = { compaction_token: handle.compactionToken, context_id: handle.contextId };
      const result = await f.client.callTool({ name: "codex_context_search", arguments: { ...readArgs, query: "marker-zeta" } });
      expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).toContain("marker-zeta");
      const textResult = await f.client.callTool({ name: "codex_context_read", arguments: { ...readArgs, read_ref: f.snapshot.targets.find(t => t.kind !== "image")!.read_ref! } });
      expect(parseContextTextReadResult(textResult)).toMatchObject({ body: "独有片段 marker-zeta", metadata: { purpose: "compaction", format: "context-text-read-v2" } });
      expect((await f.client.callTool({ name: "codex_context_list", arguments: { ...readArgs, view: "overview", ...f.reference } })).isError).toBe(true);
      expect((await f.client.callTool({ name: "codex_tool_inventory", arguments: { compaction_token: handle.compactionToken, operation_id: 1 } })).isError).toBe(true);
      const submitted = contract === "native"
        ? await f.client.callTool({ name: "codex_tool_call", arguments: { turn_token: transaction!.token, wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: transaction!.handoffId, summary: "Chosen partial evidence marker-zeta" } } })
        : await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "Chosen partial evidence marker-zeta" } });
      expect(submitted.isError).not.toBe(true);
      expect((await f.client.callTool({ name: "codex_context_list", arguments: { ...readArgs, view: "overview" } })).isError).toBe(true);
    } finally { await f.close(); }
  });
});

test("transport send failure records no delivery and bridge navigation cannot enter the Native gateway", async () => {
  const settled: boolean[] = [];
  const base = { send: async () => { throw new Error("broken pipe"); }, start: async () => {}, close: async () => {} } as Transport;
  const observed = observeMcpToolCalls(base, BRIDGE_TOOL_NAMES, () => {}, (_id, sent) => { settled.push(sent); });
  await expect(observed.send({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "image", data: png, mimeType: "image/png" }] } })).rejects.toThrow("broken pipe");
  expect(settled).toEqual([false]);
  for (const name of ["codex_context_list", "tools__codex_context_read", "apps__codex_context_search"]) expect(() => planNativeTool("codex_tool_call", { wire_name: name, arguments: {} }, { tools: [], registryGeneration: 1 }, "native")).toThrow();
});

test("transport observers bind the actual outgoing v2 result; malformed, cancelled and failed sends form no receipt", async () => {
  const source = createContextSnapshot(parseRequest({ model: "gpt-6", input: "transport-only secret marker" }));
  const scope = new ContextScope("transport-result", { snapshot: source, planId: "transport", manifestDigest: "transport", deliveryByTarget: {} },
    "normal", () => {}, () => {});
  scope.markEntryDelivered();
  try {
    for (const mode of ["valid", "malformed", "changed_after_check", "cancelled", "failed"] as const) {
      const reply = scope.prepare("read", { context_id: source.context_id, read_ref: source.targets[0]!.read_ref! });
      const wire = structuredClone(reply.result);
      if (mode === "malformed") (wire.content[1] as { text: string }).text = "wrong body";
      const sentMessages: unknown[] = [], credits: unknown[] = [];
      const transport = { start: async () => {}, close: async () => {}, send: async (message: unknown) => {
        if (mode === "failed") throw new Error("broken pipe");
        sentMessages.push(message);
        // Same byte length and valid metadata: only binding the actual body catches this.
        if (mode === "changed_after_check") (wire.content[1] as { text: string }).text = "transport-only forged marker";
      } } as Transport;
      const observed = observeMcpToolCalls(transport, BRIDGE_TOOL_NAMES, () => {}, (_id, sent, actual) => {
        let proof;
        try { if (sent) proof = contextTextReadReceipt(actual); } catch { sent = false; }
        credits.push(scope.finish(reply.receiptId, sent && mode !== "cancelled", proof));
      }, (_id, actual) => {
        if (mode === "cancelled") throw new DOMException("Context return aborted", "AbortError");
        scope.assertPending(reply.receiptId, contextTextReadReceipt(actual));
      });
      const send = observed.send({ jsonrpc: "2.0", id: 1, result: wire as never });
      if (mode === "malformed" || mode === "cancelled" || mode === "failed") await expect(send).rejects.toThrow();
      else await send;
      if (mode === "valid") {
        expect(credits).toEqual([{ method: "read", textRead: contextTextReadReceipt(reply.result) }]);
        expect(sentMessages).toHaveLength(1);
      } else expect(credits).toEqual([undefined]);
      if (mode === "malformed" || mode === "cancelled") expect(sentMessages).toHaveLength(0);
      expect(scope.inFlight).toBe(0);
    }
  } finally { scope.retire(); }
});


test("fresh manual Zero Risk compaction keeps original start, Sent and source delivery boundaries", async () => {
  const f = await fixture("safe", false, true);
  try {
    const handle = f.broker.registerCompactionContext({ snapshot: f.snapshot, contract: "safe", explicitManual: true,
      turnToken: f.token, handoffId: "fresh-manual-handoff", historyRevision: 0, ownerGeneration: "writer-manual", expiresAt: Date.now() + 30_000 });
    const query = () => f.client.callTool({ name: "codex_context_list", arguments: { compaction_token: handle.compactionToken, context_id: handle.contextId, view: "overview" } });
    expect((await query()).isError).toBe(true);
    expect(() => f.broker.markCompactionContextDelivered(handle.compactionToken)).toThrow("original Zero Risk start");
    await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
    expect((await query()).isError).toBe(true);
    f.broker.confirmSafeTurnSent(f.token, "mcp-context-surface-12345678");
    expect((await query()).isError).toBe(true);
    f.broker.markCompactionContextDelivered(handle.compactionToken);
    expect((await query()).isError).not.toBe(true);
    const business = await f.client.callTool({ name: "codex_tool_inventory", arguments: { ...f.reference, operation_id: 1 } });
    expect(business.isError).toBe(true); expect(JSON.stringify(business)).toContain("CONTEXT_COMPACTION_READ_ONLY");
    const complete = await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "Manual summary without full source reads" } });
    expect(complete.isError).not.toBe(true);
    expect((await query()).isError).toBe(true);
  } finally { await f.close(); }
});


test("navigation denial exhaustion returns protocol errors and preserves the shared MCP connection and compaction submission", async () => {
  const f = await fixture("native");
  let stage = "register compaction context";
  const requestOptions = { timeout: 5_000 };
  try {
    f.broker.markContextPlanSent(f.token, "selected");
    const transaction = await f.broker.beginCompactionTransaction("finite-navigation-errors");
    const handle = f.broker.registerCompactionContext({ snapshot: f.snapshot, contract: "native", transactionToken: transaction.token,
      handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "writer-errors", expiresAt: Date.now() + 30_000,
      remainingBudget: { tokens: 2_000, reserved_tokens: 500, wire_bytes: 20_000, reserved_wire_bytes: 1000 } });
    f.broker.markCompactionContextDelivered(handle.compactionToken);
    const invalid = () => f.client.callTool({ name: "codex_context_list", arguments: { compaction_token: handle.compactionToken,
      context_id: handle.contextId, view: "entries", cursor: "invalid" } }, undefined, requestOptions);
    for (let count = 0; count < 3; count++) {
      stage = `navigation denial ${count + 1}`;
      const result = await invalid(); expect(result.isError).toBe(true);
      if (count === 2) expect(result.structuredContent).toMatchObject({ error: { navigation_stopped: true } });
    }
    stage = "exhausted navigation protocol error";
    // Await subprocess I/O before entering Bun's synchronous promise matcher.
    // On Windows, .rejects can block the pipe callback that settles this request.
    const rejection = await invalid().then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(McpError);
    expect(rejection).toMatchObject({ code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("CONTEXT_NAVIGATION_STOPPED") });
    stage = "shared connection tool catalog";
    expect((await f.client.listTools(undefined, requestOptions)).tools.some(tool => tool.name === "codex_context_list")).toBe(true);
    stage = "ordinary context after compaction navigation stopped";
    expect((await f.client.callTool({ name: "codex_context_list", arguments: { ...f.reference,
      context_id: f.snapshot.context_id, view: "overview" } }, undefined, requestOptions)).isError).not.toBe(true);
    stage = "compaction handoff submission";
    const submitted = await f.client.callTool({ name: "codex_tool_call", arguments: { turn_token: transaction.token,
      wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: transaction.handoffId, summary: "Stopped reading; preserved summary reserve" } } }, undefined, requestOptions);
    expect(submitted.isError).not.toBe(true);
  } catch (error) {
    console.error(`[context-mcp-test] failed at ${stage}\n${f.diagnostics()}`);
    throw error;
  } finally { await f.close(); }
});

for (const contract of ["native", "safe"] as const) test(`stdio ${contract} verification records only six successful receipts and never grants business or submission rights`, async () => {
  const f = await fixture(contract, false, contract === "safe");
  const owner = new RemoteTurnBroker(f.broker.socketPath);
  const source = createContextSnapshot(parseRequest({ model: "gpt-5", input: "fixed connector marker-lambda" }));
  const normal = { snapshot: source, planId: "connector-verification", manifestDigest: "connector-verification",
    deliveryByTarget: Object.fromEntries(source.targets.map(target => [target.target_id, { delivery: "on_demand", required: false }])) };
  try {
    const handle = await owner.armContextVerification(f.token, { normal, compactionSnapshot: source, expiresAt: Date.now() + 30_000 });
    const invoke = (name: string, args: Record<string, unknown>, compaction = false) => f.client.callTool({ name, arguments: {
      ...(compaction ? { compaction_token: handle.compactionToken } : f.reference), context_id: source.context_id, ...args } });
    expect((await invoke("codex_context_list", { view: "overview" })).isError).toBe(true);
    if (contract === "safe") {
      await expect(owner.markContextVerificationDelivered(handle.pairToken)).rejects.toThrow();
      await f.broker.confirmSafeTurnSent(f.token, "mcp-context-surface-12345678");
      await owner.markContextVerificationDelivered(handle.pairToken);
      expect((await invoke("codex_context_list", { view: "overview" }, true)).isError).toBe(true);
      await f.client.callTool({ name: "codex_turn_start", arguments: f.reference });
    } else await owner.markContextVerificationDelivered(handle.pairToken);
    const cancelled = await callTurnBroker<ContextPreparedReply>(f.broker.socketPath, { method: "context_query", token: f.token, contract, credentialKind: "ordinary",
      contextProtocol: 2, contextMethod: "list", contextArgs: { context_id: source.context_id, view: "overview" } });
    await callTurnBroker(f.broker.socketPath, { method: "context_return", token: f.token, contract, credentialKind: "ordinary", contextProtocol: 2,
      receiptId: cancelled.receiptId, sent: false });
    expect((await owner.contextVerificationStatus(handle.pairToken))?.ordinary.list).toBe(false);
    expect((await invoke("codex_context_list", { view: "entries", cursor: "invalid" }, true)).isError).toBe(true);
    expect((await owner.contextVerificationStatus(handle.pairToken))?.compaction.list).toBe(false);
    for (const compaction of [false, true]) {
      const binding = { token: compaction ? handle.compactionToken : f.token, contract,
        credentialKind: compaction ? "compaction" as const : "ordinary" as const, contextProtocol: 2 };
      const args = { context_id: source.context_id, read_ref: source.targets[0]!.read_ref! };
      await expect(callTurnBroker(f.broker.socketPath, { method: "context_query", ...binding, contextProtocol: 1,
        contextMethod: "read", contextArgs: args })).rejects.toMatchObject({ code: "CONTEXT_INVALID" });
      const read = () => callTurnBroker<ContextPreparedReply>(f.broker.socketPath, { method: "context_query", ...binding,
        contextMethod: "read", contextArgs: args });
      const noShape = await read();
      await callTurnBroker(f.broker.socketPath, { method: "context_return", ...binding, receiptId: noShape.receiptId, sent: true });
      const wrongShape = await read();
      await callTurnBroker(f.broker.socketPath, { method: "context_return", ...binding, receiptId: wrongShape.receiptId, sent: true,
        textReadReceipt: { ...contextTextReadReceipt(wrongShape.result), result_digest: "0".repeat(64) } });
      const cancelledRead = await read();
      await callTurnBroker(f.broker.socketPath, { method: "context_return", ...binding, receiptId: cancelledRead.receiptId, sent: false,
        textReadReceipt: contextTextReadReceipt(cancelledRead.result) });
      const status = await owner.contextVerificationStatus(handle.pairToken);
      expect(status?.[compaction ? "compaction" : "ordinary"].read).toBe(false);
      expect(status?.[compaction ? "compaction" : "ordinary"].text_read).toBeUndefined();
    }
    for (const compaction of [false, true]) {
      expect((await invoke("codex_context_list", { view: "entries" }, compaction)).isError).not.toBe(true);
      expect((await invoke("codex_context_read", { read_ref: source.targets[0]!.read_ref }, compaction)).isError).not.toBe(true);
      expect((await invoke("codex_context_search", { query: "marker-lambda" }, compaction)).isError).not.toBe(true);
    }
    // A subsequent private round trip sees the preceding transport receipt.
    let status = await owner.contextVerificationStatus(handle.pairToken);
    for (let attempt = 0; !status?.completed && attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5)); status = await owner.contextVerificationStatus(handle.pairToken);
    }
    expect(status).toMatchObject({ completed: true, ordinary: { list: true, read: true, search: true }, compaction: { list: true, read: true, search: true } });
    for (const name of ["codex_tool_inventory", "codex_tool_wait"]) {
      const denied = await f.client.callTool({ name, arguments: { ...f.reference, operation_id: 1, ...(name === "codex_tool_inventory" ? { task_revision: 0 } : {}) } });
      expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain("CONTEXT_VERIFICATION_ONLY");
    }
    if (contract === "safe") expect((await f.client.callTool({ name: "codex_turn_complete", arguments: { ...f.reference, final_answer: "forbidden", task_revision: 0 } })).isError).toBe(true);
    else expect((await f.client.callTool({ name: "codex_tool_call", arguments: { turn_token: handle.compactionToken,
      wire_name: "codex.control.compaction_handoff", arguments: { handoff_id: "forbidden", summary: "forbidden" } } })).isError).toBe(true);
    for (const method of ["native_operation_start", "native_operation_wait", "safe_complete", "submit_compaction_handoff", "task_update_ack"] as const) {
      await expect(callTurnBroker(f.broker.socketPath, { method, token: f.token, contract, nativeWaitProtocol: 1, operationId: 1,
        entry: "codex_tool_inventory", nativeInput: {}, finalAnswer: "forbidden", summary: "forbidden" })).rejects.toMatchObject({ code: "CONTEXT_VERIFICATION_ONLY" });
    }
    await expect(callTurnBroker(f.broker.socketPath, { method: "submit_compaction_handoff", token: handle.compactionToken, summary: "forbidden" })).rejects.toMatchObject({ code: "CONTEXT_VERIFICATION_ONLY" });
    await owner.revokeContextVerification(handle.pairToken);
    expect(await owner.contextVerificationStatus(handle.pairToken)).toBeUndefined();
    expect((await invoke("codex_context_list", { view: "overview" })).isError).toBe(true);
    expect((await invoke("codex_context_list", { view: "overview" }, true)).isError).toBe(true);
  } finally { await f.close(); }
});
