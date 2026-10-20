import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultBrokerEndpoint } from "../src/config";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

const ownerContext = { expectedDriverGeneration: 0, taskRevision: 0, acknowledgedRevision: 0 };
const nonce = "bootstrap-integration-surface-123456";
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false };

for (const contract of ["native", "safe"] as const) test(`short startup ${contract}: real MCP body receipts gate inventory and direct completion`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-boot-"));
  const socket = defaultBrokerEndpoint(root), broker = TurnBroker.forSocket(socket);
  const owner = new RemoteTurnBroker(socket);
  // This suite preserves the complete v1 short-start contract; reuse has its own integration suite.
  const reuseCapability = spyOn(owner, "contextReuseAvailable").mockResolvedValue(false);
  const client = new Client({ name: "bootstrap-integration", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", contract, "--broker-socket", socket], cwd: process.cwd(), stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  await broker.listen();
  let send: ContextSend | undefined;
  try {
    expect(await owner.contextBootstrapAvailable()).toBe(true);
    const environment = { authorityMode: "delegated" as const, threadId: "bootstrap-thread", turnId: "bootstrap-turn", tools: [] };
    const token = contract === "safe"
      ? await owner.registerSafe(environment, nonce, undefined, "bootstrap-test", { requireSentConfirmation: true, taskUpdateProtocol: 1 })
      : await owner.register(environment, undefined, "bootstrap-test", { taskUpdateProtocol: 1 });
    const canonical: CodexParsedRequest = { modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" }, context: {
      systemPrompt: ["Preserve all of this context. ".repeat(1_100)],
      messages: [{ role: "user", content: "Read the complete source, including final detail: 末页证据😀  \n", timestamp: 1 }],
    } };
    send = new ContextSend(canonical, owner, capabilities, "bootstrap-page", undefined, ownerContext);
    const plan = await send.prepare(canonical, token, { taskUpdateProtocol: 1, ...(contract === "safe" ? { manualControl: true } : {}) });
    expect(plan.registration?.startupProtocol).toBe("context-bootstrap-v1");
    expect(Array.from(plan.compiled.text).length).toBeLessThanOrEqual(8_000);
    await send.select(token, plan);
    await client.connect(transport, { timeout: 10_000 });
    const credential = contract === "safe" ? { request_id: token } : { turn_token: token };
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: { ...credential, ...args } });
    if (contract === "safe") {
      const waiting = await call("codex_turn_start");
      expect(waiting.structuredContent).toMatchObject({ started: true, duplicate: false,
        context_bootstrap: { startup_protocol: "context-bootstrap-v1", read_state: "waiting" } });
      const before = await owner.contextUsage(token);
      const duplicate = await call("codex_turn_start");
      expect(duplicate.structuredContent).toMatchObject({ duplicate: true, context_bootstrap: { read_state: "waiting" } });
      expect((await owner.contextUsage(token))?.usage).toEqual(before?.usage);
      await owner.confirmSafeTurnSent(token, nonce);
      expect((await call("codex_turn_start")).structuredContent).toMatchObject({ duplicate: true, context_bootstrap: { read_state: "readable" } });
      expect((await call("codex_turn_complete", { final_answer: "too early", task_revision: 0 })).isError).toBe(true);
    } else {
      await send.sent();
      await expect(owner.beginCompletionFence(token, ownerContext)).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    }
    const early = await call("codex_tool_inventory", { operation_id: 1, task_revision: 0 });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early)).toContain("CONTEXT_NOT_READY");
    await expect(callTurnBroker(socket, { method: "context_query", token, contract, credentialKind: "ordinary",
      contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "list", contextArgs: { context_id: plan.registration!.snapshot.context_id, view: "overview" } }))
      .rejects.toMatchObject({ code: "CONTEXT_INCOMPATIBLE" });
    const bodies = new Map<string, string>();
    let ready = false;
    for (let count = 0; count < 100; count++) {
      const overview = await call("codex_context_list", { context_id: plan.registration!.snapshot.context_id, view: "overview" });
      expect(overview.isError).not.toBe(true);
      const manifest = overview.structuredContent as { live: { context_ready: boolean }; next_required_read: {
        tool: string; arguments: { read_ref: string; [key: string]: unknown };
      } | null };
      if (manifest.live.context_ready) { ready = true; break; }
      expect(manifest.next_required_read).not.toBeNull();
      const next = manifest.next_required_read!;
      const page = parseContextTextReadResult(await call(next.tool, next.arguments));
      bodies.set(next.arguments.read_ref, (bodies.get(next.arguments.read_ref) ?? "") + page.body);
    }
    expect(ready).toBe(true);
    const payload = [...bodies.values()].find(body => body.includes("末页证据"));
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!).payload.messages[0].content).toBe(canonical.context.messages[0]!.content);
    expect(await call("codex_tool_inventory", { operation_id: 1, task_revision: 0 })).toEqual(early);
    expect((await call("codex_tool_inventory", { operation_id: 2, task_revision: 0 })).isError).not.toBe(true);
    if (contract === "safe") expect((await call("codex_turn_complete", { final_answer: "all required text delivered", task_revision: 0 })).isError).not.toBe(true);
    else {
      const fence = await owner.beginCompletionFence(token, ownerContext);
      expect(fence).toBeDefined();
      expect(await owner.commitCompletionFence(token, fence!, ownerContext)).toBe(true);
    }
  } finally {
    await client.close();
    reuseCapability.mockRestore(); send?.retire();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
