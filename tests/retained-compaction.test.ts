import { expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
  existingStructuredCompactionRun,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
  withCompactionAbort,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CompactionSourceCoverage } from "../src/adapters/chatgpt-web/compaction-context";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../src/chatgpt-web-models";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import { rememberCompactionContinuation, recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import {
  chatGptWebExecutionNamespace,
  createChatGptWebAdapter,
} from "./helpers/chatgpt-web-adapter";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { extractChatGptTurnIdentity, extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnExecutionKey,
  chatGptTurnRoundKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  CODEX_ACTIVE_COMPACTION_REQUEST_MARKER,
  structuredCompactionHandoffInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { NativeTurnIdleRegistry } from "../src/native-turn-idle";
import { retainedTaskFixture } from "./helpers/retained-compaction-fixture";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";

/**
 * These fixtures hand the turn broker a Unix socket under their temp root. macOS puts TMPDIR at
 * /var/folders/<32 chars>/T, which pushes `<root>/runtime/turn-broker.sock` past the 104-byte
 * sun_path limit, and listen() then fails with nothing but "Failed to listen". Root them somewhere
 * short so the socket is bindable.
 */
function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{ type: "message", role: "user", content: "Original task" },
      { type: "message", role: "assistant", content: "Work completed" }, {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

function deliveredCoverage(parsed: CodexParsedRequest): CompactionSourceCoverage {
  const value = new CompactionSourceCoverage();
  value.prepare(createContextSnapshot(parsed), { historyRevision: parsed._continuityHistoryRevision ?? 0,
    pageGeneration: "test-page", planId: "test-selected", bodyDigest: "test-body", manifestDigest: "test-images",
    pageTokens: 2_000, externalizedTargetIds: [] });
  value.markDelivered("test-selected");
  return value;
}
const mockSourceCapability = {
  registerCompactionContext: ({ snapshot }: { snapshot: { context_id: string } }) => ({
    contextId: snapshot.context_id, compactionToken: "compaction_test_source",
  }),
  markCompactionContextDelivered() {},
  guardCompactionContextCommit() {},
  revokeCompactionContext() {},
};
const compactionCapabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (turn_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`Missing compaction control binding: ${instruction}`);
  return { token, handoffId };
}

test("one browser conversation spans native turns and rotates only at compaction", () => {
  const before = request(false);
  const sameTurn = structuredClone(before);
  (sameTurn._rawBody as { input: unknown[] }).input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Same native turn revision" }],
  });
  const nextTurn = structuredClone(before);
  (nextTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_next",
    }),
  };
  const afterCompact = structuredClone(before);
  (afterCompact._rawBody as { input: unknown[] }).input.unshift({
    type: "compaction",
    encrypted_content: "ocx1:checkpoint",
  });

  expect(chatGptConversationKey(sameTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(nextTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(afterCompact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherModel = structuredClone(before);
  otherModel.modelId = "chatgpt-web/pro";
  expect(chatGptConversationKey(otherModel, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherEffort = structuredClone(before);
  otherEffort.options.reasoning = "medium";
  expect(chatGptConversationKey(otherEffort, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherThread = structuredClone(before);
  (otherThread._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_other",
      turn_id: "turn_source",
    }),
  };
  expect(chatGptConversationKey(otherThread, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  expect(retainedConversationResumeRequest(before)?.context.messages).toEqual([
    { role: "user", content: "Continue with the next step", timestamp: 3 },
  ]);

  const v1Compact = structuredClone(before);
  (v1Compact._rawBody as { input: unknown[] }).input.unshift({
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\ncheckpoint` }],
  });
  expect(chatGptConversationKey(v1Compact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
});

test("ordinary checkpoint recovery remains isolated from continuity commit authority", () => {
  const compact = request(true);
  const identity = extractChatGptTurnIdentity(compact);
  const source = extractChatGptCompactionSourceRevision(compact);
  const summary = "Ordinary retained source checkpoint.";
  rememberCompactionContinuation(compact, identity, [source], summary);
  const continued = { ...compact, _compactionRequest: false, _rawBody: {
    ...compact._rawBody as object, input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
  } };
  expect(recoverCompactionInstruction(continued, identity)?.source).toEqual(source);
  const continuity = { ...continued, _conversationPolicy: "task" as const, _continuityScope: "uncommitted-continuity-scope" };
  rememberCompactionContinuation({ ...compact, ...continuity, _compactionRequest: true }, identity, [source], summary);
  expect(recoverCompactionInstruction(continuity, identity)).toBeUndefined();
  expect(recoverCompactionInstruction(continued, identity)?.source).toEqual(source);
});

test("continuity retains its physical key but partitions execution and round replay by verified revision", () => {
  const first = request();
  first._conversationPolicy = "task";
  first._continuityHistoryRevision = 0;
  const next = structuredClone(first);
  next._continuityHistoryRevision = 1;
  (next._rawBody as { input: unknown[] }).input.unshift({
    type: "message", role: "user", content: `${SUMMARY_PREFIX}\naccepted checkpoint`,
  });
  expect(chatGptConversationKey(next, "provider")).toBe(chatGptConversationKey(first, "provider"));
  expect(chatGptTurnExecutionKey(next)).not.toBe(chatGptTurnExecutionKey(first));
  const sameInput = { ...first, _continuityHistoryRevision: 1 };
  expect(chatGptTurnRoundKey(sameInput)).not.toBe(chatGptTurnRoundKey(first));
  expect(chatGptTurnExecutionKey({ ...first, _chatgptModelFamily: "6" }))
    .not.toBe(chatGptTurnExecutionKey({ ...first, _chatgptModelFamily: "5.6" }));
  expect(chatGptConversationKey({ ...first, _conversationPolicy: "recoverable" }, "provider"))
    .not.toBe(chatGptConversationKey(first, "provider"));
  expect(() => chatGptTurnExecutionKey({ ...first, _continuityHistoryRevision: undefined })).toThrow();
  expect(() => chatGptTurnRoundKey({ ...first, _continuityHistoryRevision: -1 })).toThrow();
});

test("compaction capability is one-shot and structurally bound to its handoff id", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace_compaction", 1_000);
  expect(() => store.submit(transaction.token, "handoff_wrong", "checkpoint")).toThrow("does not match");
  store.submit(transaction.token, transaction.handoffId, "  exact checkpoint  ");
  await expect(store.wait(transaction.token)).resolves.toBe("exact checkpoint");
  expect(() => store.submit(transaction.token, transaction.handoffId, "again")).toThrow("invalid, expired, or consumed");
  store.close();
});

test("retained compaction provides one exact same-agent control binding", () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "turn_11111111111111111111111111111111",
    handoffId: "handoff_22222222222222222222222222222222",
  }, { appName: "Codex app" });
  expect(prompt).toContain('selected ChatGPT plugin "Codex app"');
  expect(prompt).not.toContain("Codex Native");
  expect(prompt).toContain("Automatic Codex context compaction has started.");
  expect(prompt).toContain("Stop ordinary task work");
  expect(prompt).toContain("turn_token turn_11111111111111111111111111111111");
  expect(prompt).toContain("wire_name codex.control.compaction_handoff");
  expect(prompt).toContain('"handoff_id":"handoff_22222222222222222222222222222222"');
  expect(prompt).toContain("do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool");
  expect(prompt).toContain("submitted=true");
});

test("a compaction control token cannot claim the ordinary Codex tool environment", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-capability-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace_capability", 1_000);
    await expect(callTurnBroker(broker.socketPath, {
      method: "claim",
      token: transaction.token,
    })).rejects.toThrow("turn token is invalid");
    await callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Bound checkpoint",
    });
    await expect(broker.waitForCompactionHandoff(transaction.token)).resolves.toBe("Bound checkpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained compaction submits through the published MCP contract with no ordinary tool authority", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-mcp-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const client = new Client({ name: "compaction-contract-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--broker-socket", broker.socketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await client.connect(transport);
    const run = async (turn: BrowserTurn) => {
      const prepared = await turn.prepare();
      try {
        const { token, handoffId } = controlBinding(prepared.text);
        await turn.onSubmitted?.();
        const result = await client.callTool({ name: "codex_tool_call", arguments: {
          turn_token: token, wire_name: "codex.control.compaction_handoff",
          arguments: { handoff_id: handoffId, summary: "Complete checkpoint sent through MCP" },
        } });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return "Checkpoint submitted.";
      } finally { prepared.release(); }
    };
    const summary = await requestRetainedCompactionHandoff(
      { appName: "Codex app", run } as never, request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_mcp_handoff",
    );
    expect(summary).toBe("Complete checkpoint sent through MCP");

    const transaction = await broker.beginCompactionTransaction("trace_mcp_boundaries", 30_000);
    for (const [name, args] of [
      ["codex_exec", { cmd: "echo must-not-run" }],
      ["codex_tool_inventory", {}],
      ["codex_tool_call", { wire_name: "exec_command", arguments: { cmd: "echo must-not-run" } }],
    ] as const) {
      const denied = await client.callTool({ name, arguments: { turn_token: transaction.token, operation_id: 1, ...args } });
      expect(denied.isError).toBeTrue();
      expect(JSON.stringify(denied.content)).toMatch(/turn token is invalid|codex_tool_operation_retired/);
    }
    const submit = (token: string, handoffId: string) => client.callTool({ name: "codex_tool_call", arguments: {
      turn_token: token, wire_name: "codex.control.compaction_handoff",
      arguments: { handoff_id: handoffId, summary: "Bound checkpoint" },
    } });
    const wrong = await submit(transaction.token, "handoff_wrong");
    expect(wrong.isError).toBeTrue();
    expect(JSON.stringify(wrong.content)).toContain("does not match");
    const ordinary = await broker.register({ cwd: root, roots: [root], writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" }, tools: [] }, 30_000);
    expect((await submit(ordinary, transaction.handoffId)).isError).toBeTrue();
    expect((await submit(transaction.token, transaction.handoffId)).isError).not.toBeTrue();
    expect(await broker.waitForCompactionHandoff(transaction.token)).toBe("Bound checkpoint");
    expect((await submit(transaction.token, transaction.handoffId)).isError).toBeTrue();
    const aborted = await broker.beginCompactionTransaction("trace_mcp_aborted", 30_000);
    broker.abortCompactionTransaction(aborted.token);
    expect((await submit(aborted.token, aborted.handoffId)).isError).toBeTrue();
  } finally {
    await client.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

// Allow for Windows named-pipe scheduling and broker cleanup across these round trips.
test("active compaction delivers the current result and converts every later MCP call into the checkpoint request", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-active-compaction-gate-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    // The assertion exercises compaction routing, not expiry. Leave enough lease headroom for
    // Windows named-pipe scheduling under the full parallel test suite.
    }, 30_000, "trace_active_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const current = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    });
    const [request] = await broker.nextToolBatch(token);
    let progressEvents = 0;
    broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    }, undefined, () => { progressEvents++; });
    expect(progressEvents).toBe(0);
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "current result" }],
    });
    await expect(current).resolves.toMatchObject({
      content: [{ type: "text", text: "current result" }],
    });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "git status --short" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
    expect(progressEvents).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("active compaction drains an MCP call already queued without an outer Codex waiter", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-queued-before-compaction-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_prequeued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    await Bun.sleep(25);
    const interrupted = broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(interrupted).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
    broker.revoke(token);
    expect(() => broker.compactionDeliveryCount(token)).toThrow("turn capability retired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.each(["5.6", "6"] as const)("a retained %s checkpoint preserves model selection and physically retires its browser", async family => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(5 * 60_000);
  const sourceRequest = { ...request(false), _chatgptModelFamily: family };
  const compactRequest = { ...request(true), _chatgptModelFamily: family };
  const customCompactPrompt = "CUSTOM_COMPACT_PROMPT retain database migration and rollback steps.";
  compactRequest._compactionOutput = "message";
  compactRequest.context.messages.push({ role: "user", content: customCompactPrompt, timestamp: 4 });
  const conversationKey = chatGptConversationKey(sourceRequest, "provider")!;
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey,
    cancel() {},
  });
  let captured: BrowserTurn | undefined;
  let browserRetired = false;
  let transactionAborted = false;
  let transactionTtl = 0;
  const broker = {
    ...mockSourceCapability,
    beginCompactionTransaction: async (_traceId: string, ttlMs: number) => {
      transactionTtl = ttlMs;
      return {
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
      };
    },
    waitForCompactionHandoff: async () => "Retained agent checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async (turn: BrowserTurn): Promise<string> => {
      captured = turn;
      const prepared = await turn.prepareResume!();
      expect(prepared.text).toContain('selected ChatGPT plugin "Codex app"');
      expect(prepared.text).toContain("wire_name codex.control.compaction_handoff");
      expect(prepared.text).toContain(customCompactPrompt);
      prepared.release();
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = () => {
          browserRetired = true;
          reject(new DOMException("retained handoff browser closed", "AbortError"));
        };
        if (turn.abortSignal?.aborted) onAbort();
        else turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    compactRequest,
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_handoff",
    undefined,
    60 * 60_000,
  )).resolves.toBe("Retained agent checkpoint");
  expect(captured?.modelFamily).toBe(family);
  expect(captured?.conversationKey).toBe(conversationKey);
  expect(captured?.requireRetainedConversation).toBeTrue();
  expect(captured?.compaction).toBeTrue();
  expect(captured?.nativeConnector).toBeTrue();
  expect(captured?.capabilities.localToolsEnabled).toBeFalse();
  expect(browserRetired).toBeTrue();
  expect(captured?.abortSignal?.reason).toBeInstanceOf(ChatGptCompactionHandoffAccepted);
  expect(transactionAborted).toBeTrue();
  expect(transactionTtl).toBe(MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
});

test("completed retained compaction never treats ordinary assistant text as a handoff", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  const broker = {
    ...mockSourceCapability,
    beginCompactionTransaction: async () => ({
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => { throw new Error("structured handoff missing"); },
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async () => '{"checkpoint":"must never be parsed"}',
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_no_text_fallback",
  )).rejects.toThrow("structured handoff missing");
});

test("a settled browser response without a checkpoint reports the missing handoff immediately", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-handoff-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  const abort = new AbortController();
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(requestRetainedCompactionHandoff(
      { appName: "Codex app", run: async () => {
        // Observe the settled response; broker startup and source preparation precede it.
        guard = setTimeout(() => abort.abort(new Error("test observation guard")), 1000);
        return "The requested tool call did not run.";
      } } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_missing_handoff", abort.signal,
    )).rejects.toMatchObject({ code: "compaction_handoff_missing", retryable: false });
    expect(guard).toBeDefined();
  } finally {
    clearTimeout(guard);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkpoint submitted before browser completion wins the terminal response race", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-handoff-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await expect(requestRetainedCompactionHandoff(
      { appName: "Codex app", run: async (turn: BrowserTurn) => {
        const prepared = await turn.prepare();
        const token = prepared.text.match(/turn_token (turn_\w+)/)![1]!;
        const handoffId = prepared.text.match(/handoff_id (handoff_\w+)/)![1]!;
        turn.onSubmitted?.();
        await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary: "Exact summary" });
        prepared.release();
        return "Checkpoint submitted.";
      } } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_handoff_race",
    )).resolves.toBe("Exact summary");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained compaction deadline bounds browser settlement after the control handoff succeeds", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  let transactionAborted = false;
  const broker = {
    ...mockSourceCapability,
    beginCompactionTransaction: async () => ({
      token: "turn_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => "Already submitted checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    appName: "Codex app",
    run: async () => new Promise<string>(() => {}),
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_deadline",
    undefined,
    25,
  )).rejects.toThrow("timed out after 25ms");
  expect(transactionAborted).toBeTrue();
});

test("a rejected exact compaction run is evicted while a successful run remains replayable", async () => {
  const key = `exact-retry-${Date.now()}-${Math.random()}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] };
  let starts = 0;
  await expect(runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    throw new Error("first handoff failed");
  })).rejects.toThrow("first handoff failed");
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  const retry = runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    return "recovered checkpoint";
  });
  expect(runStructuredCompactionOnce(key, owner, async () => "must not start")).toBe(retry);
  await expect(retry).resolves.toBe("recovered checkpoint");
  await expect(existingStructuredCompactionRun(key)).resolves.toBe("recovered checkpoint");
  expect(starts).toBe(2);
});

test("an exact oversized compaction replays its size error instead of uploading the same parts again", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-size-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://oversized-${crypto.randomUUID()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      experimentalBiggerContext: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let browserStarts = 0;
  worker.run = async turn => {
    browserStarts++;
    const prepared = await turn.prepare();
    prepared.release();
    throw new ChatGptWebAdapterError("The submitted message is too long", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
    });
  };
  const adapter = createChatGptWebAdapter(provider);
  const compact = (family: "5.6" | "6" = "5.6"): CodexParsedRequest => ({
    ...request(true), _chatgptModelFamily: family,
  });
  const observe = async (input: CodexParsedRequest) => {
    const sourceRequest = structuredClone(input);
    sourceRequest._compactionRequest = false;
    (sourceRequest._rawBody as any).client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: "thread_retained_compaction", turn_id: "turn_source" });
    const key = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(sourceRequest)}`;
    chatGptTurnSessions.getOrCreate(key, () => ({ mode: "read-only", browser: Promise.resolve("source complete"),
      physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), cancel() {} }));
    await chatGptTurnSessions.find(key)!.browserOutcome;
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(input, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({
      type: "error", status: 400, code: "context_length_exceeded", retryable: false,
    });
    expect(events.some(event => event.type === "done")).toBeFalse();
  };
  try {
    await observe(compact());
    await Bun.sleep(0);
    await observe(compact());
    expect(browserStarts).toBe(1);

    // Both actual model families share the same routed modelId.
    await observe(compact("6"));
    expect(browserStarts).toBe(2);
    await observe(compact("6"));
    expect(browserStarts).toBe(2);

    // Changed input and effort must also reach the browser again.
    const revised = compact();
    revised.context.messages.at(-1)!.content = "Continue";
    (revised._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input.at(-1)!.content[0]!.text = "Continue";
    await observe(revised);
    expect(browserStarts).toBe(3);
    const otherMode = compact();
    otherMode.options.reasoning = "max";
    await observe(otherMode);
    expect(browserStarts).toBe(4);
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator cancellation aborts the shared structured compaction owner", async () => {
  const key = `operator-cancel-${Date.now()}-${Math.random()}`;
  const traceId = `trace-${key}`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [traceId] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );
  await Bun.sleep(0);
  expect(await cancelStructuredCompactionTrace(traceId, new Error("operator cancelled"))).toBe(1);
  await expect(run).rejects.toThrow("operator cancelled");
  expect(aborted).toBeTrue();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
});

for (const registration of ["run", "cache"] as const) for (const target of ["native", "trace"] as const) {
  test(`shared compaction ${registration} retry registers its ${target} cancellation identity`, async () => {
    const key = `shared-cancel-${registration}-${target}-${Date.now()}-${Math.random()}`;
    const owner = {
      ownerKey: `owner-${key}`, traceIds: [`trace-original-${key}`],
      nativeThreadId: `thread-${key}`, nativeTurnId: `turn-original-${key}`, requestDigest: "same-control",
    };
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const run = runStructuredCompactionOnce(key, owner, signal => new Promise<string>((_resolve, reject) => {
      started();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const outcome = run.catch(error => error);
    await ready;
    const retryOwner = { ...owner, traceIds: [`trace-retry-${key}`], nativeTurnId: `turn-retry-${key}` };
    const retry = registration === "run"
      ? runStructuredCompactionOnce(key, retryOwner, async () => "must not start")
      : existingStructuredCompactionRun(key, retryOwner.requestDigest, retryOwner);
    expect(retry).toBe(run);
    const reason = new DOMException("Cancel shared retry", "AbortError");
    const cancelled = target === "native" ? (() => {
      const cancellation = cancelStructuredCompactionNativeTurn(owner.nativeThreadId, retryOwner.nativeTurnId, reason);
      return cancellation.settlement.then(() => cancellation.cancelled);
    })() : cancelStructuredCompactionTrace(retryOwner.traceIds[0]!, reason);
    expect(await cancelled).toBe(1);
    expect(await outcome).toBe(reason);
  });
}

test("shared compaction rejects an already-interrupted retry identity without cancelling its owner", async () => {
  const key = `shared-interrupted-retry-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`, traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`, nativeTurnId: `turn-original-${key}`, requestDigest: "same-control",
  };
  let finish!: () => void;
  const run = runStructuredCompactionOnce(key, owner, () => new Promise<string>(resolve => {
    finish = () => resolve("original checkpoint");
  }));
  await Bun.sleep(0);
  const retryOwner = { ...owner, nativeTurnId: `turn-interrupted-${key}` };
  const reason = new Error("Retry was interrupted before registration");
  const cancellation = cancelStructuredCompactionNativeTurn(owner.nativeThreadId, retryOwner.nativeTurnId, reason);
  await cancellation.settlement;
  await expect(runStructuredCompactionOnce(key, retryOwner, async () => "must not start")).rejects.toBe(reason);
  expect(() => existingStructuredCompactionRun(key, owner.requestDigest, retryOwner)).toThrow(reason.message);
  finish();
  await expect(run).resolves.toBe("original checkpoint");
});

test("shared compaction cancellation identities are bounded without discarding accepted identities", async () => {
  const key = `shared-identity-capacity-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`, traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`, nativeTurnId: `turn-original-${key}`, requestDigest: "same-control",
  };
  const run = runStructuredCompactionOnce(key, owner, signal => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const outcome = run.catch(error => error);
  await Bun.sleep(0);
  const retryOwner = { ...owner, nativeTurnId: `turn-retry-${key}` };
  expect(existingStructuredCompactionRun(key, owner.requestDigest, retryOwner)).toBe(run);
  expect(() => existingStructuredCompactionRun(key, owner.requestDigest, {
    ...owner, nativeTurnId: `turn-overflow-${key}`, traceIds: Array.from({ length: 256 }, (_, index) => `trace-extra-${key}-${index}`),
  })).toThrow("cancellation identity registry is full");
  const reason = new Error("Cancel an accepted identity after capacity rejection");
  const cancellation = cancelStructuredCompactionNativeTurn(owner.nativeThreadId, retryOwner.nativeTurnId, reason);
  await cancellation.settlement;
  expect(cancellation.cancelled).toBe(1);
  expect(await outcome).toBe(reason);
});

test("completed compaction observers do not consume cancellation identity capacity", async () => {
  const key = `completed-identity-capacity-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`, traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`, nativeTurnId: `turn-original-${key}`, requestDigest: "same-control",
  };
  let finish!: () => void;
  let starts = 0;
  const run = runStructuredCompactionOnce(key, owner, () => new Promise<string>(resolve => {
    starts++;
    finish = () => resolve("original checkpoint");
  }));
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key, owner.requestDigest, {
    ...owner, traceIds: [...owner.traceIds, ...Array.from({ length: 254 }, (_, index) => `trace-fill-${key}-${index}`)],
  })).toBe(run);
  expect(() => existingStructuredCompactionRun(key, owner.requestDigest, {
    ...owner, nativeTurnId: `turn-active-overflow-${key}`,
  })).toThrow("cancellation identity registry is full");
  finish();
  await expect(run).resolves.toBe("original checkpoint");
  await cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, new Error("Confirm physical settlement")).settlement;
  for (let index = 0; index < 300; index++) {
    const observer = { ...owner, traceIds: [`trace-observer-${key}-${index}`], nativeTurnId: `turn-observer-${key}-${index}` };
    expect(existingStructuredCompactionRun(key, owner.requestDigest, observer)).toBe(run);
    expect(runStructuredCompactionOnce(key, observer, async () => { starts++; return "must not start"; })).toBe(run);
  }
  expect(() => existingStructuredCompactionRun(key, "different-control", owner)).toThrow("payload conflicts");
  expect(() => existingStructuredCompactionRun(key, owner.requestDigest, { ...owner, ownerKey: "foreign-owner" }))
    .toThrow("cannot be proved");
  expect(starts).toBe(1);
});

test("conflicting shared compaction payloads do not register cancellation identities", async () => {
  const key = `shared-conflicting-identity-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`, traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`, nativeTurnId: `turn-original-${key}`, requestDigest: "accepted-control",
  };
  const run = runStructuredCompactionOnce(key, owner, signal => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const outcome = run.catch(error => error);
  await Bun.sleep(0);
  const retryOwner = { ...owner, nativeTurnId: `turn-conflict-${key}`, requestDigest: "conflicting-control" };
  expect(() => existingStructuredCompactionRun(key, retryOwner.requestDigest, retryOwner)).toThrow("payload conflicts");
  await expect(runStructuredCompactionOnce(key, retryOwner, async () => "must not start"))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  const rejectedCancellation = cancelStructuredCompactionNativeTurn(owner.nativeThreadId, retryOwner.nativeTurnId, new Error("Rejected retry"));
  await rejectedCancellation.settlement;
  expect(rejectedCancellation.cancelled).toBe(0);
  const reason = new Error("Cleanup accepted owner");
  const cleanup = cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, reason);
  await cleanup.settlement;
  expect(await outcome).toBe(reason);
});

test("native interruption before registration prevents the detached compaction from starting", async () => {
  const key = `interrupt-before-registration-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const reason = new DOMException("Codex turn interrupted", "AbortError");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    reason,
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;
  const duplicateCancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new Error("duplicate interrupt must not replace the first reason"),
  );
  expect(duplicateCancellation.cancelled).toBe(0);
  await duplicateCancellation.settlement;
  const unrelatedSettlements: Promise<void>[] = [];
  for (let index = 0; index < 1_025; index += 1) {
    const unrelated = cancelStructuredCompactionNativeTurn(
      `thread-unrelated-${key}-${index}`,
      `turn-unrelated-${key}-${index}`,
      new Error(`unrelated interrupt ${index}`),
    );
    unrelatedSettlements.push(unrelated.settlement);
  }
  await Promise.all(unrelatedSettlements);

  let started = false;
  const run = runStructuredCompactionOnce(key, owner, async () => {
    started = true;
    return "must not start";
  });

  await expect(run).rejects.toBe(reason);
  expect(started).toBeFalse();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  let unrelatedStarted = false;
  await expect(runStructuredCompactionOnce(
    `${key}-unrelated`,
    {
      ...owner,
      ownerKey: `${owner.ownerKey}-unrelated`,
      nativeTurnId: `${owner.nativeTurnId}-unrelated`,
    },
    async () => {
      unrelatedStarted = true;
      return "unrelated checkpoint";
    },
  )).resolves.toBe("unrelated checkpoint");
  expect(unrelatedStarted).toBeTrue();
});

test("a completed exact compaction remains replayable after a later native interruption", async () => {
  const key = `completed-before-interrupt-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const completed = runStructuredCompactionOnce(key, owner, async () => "canonical checkpoint");
  await expect(completed).resolves.toBe("canonical checkpoint");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;

  let restarted = false;
  const replay = runStructuredCompactionOnce(key, owner, async () => {
    restarted = true;
    return "must not replace canonical checkpoint";
  });
  expect(replay).toBe(completed);
  await expect(replay).resolves.toBe("canonical checkpoint");
  expect(restarted).toBeFalse();
});

test("a duplicate native interruption refreshes its lifetime without replacing its reason", async () => {
  const originalNow = Date.now;
  const key = `duplicate-interrupt-refresh-${originalNow()}-${Math.random()}`;
  const initialNow = 1_000_000_000;
  let now = initialNow;
  Date.now = () => now;
  try {
    const owner = {
      ownerKey: `owner-${key}`,
      traceIds: [`trace-${key}`],
      nativeThreadId: `thread-${key}`,
      nativeTurnId: `turn-${key}`,
    };
    const originalReason = new DOMException("first Codex turn interruption", "AbortError");
    cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, originalReason);

    now = initialNow + (29 * 60_000) + 59_000;
    cancelStructuredCompactionNativeTurn(
      owner.nativeThreadId,
      owner.nativeTurnId,
      new Error("duplicate reason must not become authoritative"),
    );

    now = initialNow + (30 * 60_000) + 1_000;
    let started = false;
    const run = runStructuredCompactionOnce(key, owner, async () => {
      started = true;
      return "must not start";
    });
    await expect(run).rejects.toBe(originalReason);
    expect(started).toBeFalse();
  } finally {
    Date.now = originalNow;
  }
});

test("structured compaction rejects incomplete native interruption identities", () => {
  const reason = new DOMException("Codex turn interrupted", "AbortError");
  expect(() => cancelStructuredCompactionNativeTurn(" ", "turn_valid", reason))
    .toThrow("non-empty native thread and turn ids");
  expect(() => runStructuredCompactionOnce(
    `incomplete-native-owner-${Date.now()}-${Math.random()}`,
    { ownerKey: "incomplete-native-owner", traceIds: [], nativeThreadId: "thread_valid" },
    async () => "must not start",
  )).toThrow("non-empty native thread and turn ids");
});

test("active compaction settles canonical tool results before the separate retained handoff", async () => {
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  const compactionTokens: string[] = [];
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  const broker = {
    requestCompaction: (token: string) => { compactionTokens.push(token); return 0; },
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
      if (callId === "call_two") {
        finishBrowser("Ordinary final after canonical results.");
      }
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active"),
    externalProgress: {
      recordToolResult() {},
    } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false },
    { callId: "call_two", wireName: "exec_command", freeform: false },
  ]);
  const parsed = request(true);
  parsed.context.messages.push(
    { role: "toolResult", toolCallId: "call_one", toolName: "exec_command", content: "one", isError: false, timestamp: 4 },
    { role: "toolResult", toolCallId: "call_two", toolName: "exec_command", content: "two", isError: false, timestamp: 5 },
  );

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Ordinary final after canonical results.",
    compactionInstructionDelivered: false,
  });
  expect(compactionTokens).toEqual(["turn_active"]);
  expect(completed.map(entry => entry.callId)).toEqual(["call_one", "call_two"]);
  expect(JSON.stringify(completed[0])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain("codex.control.compaction_handoff");
  expect(completed[1]!.result.content).toEqual([{ type: "text", text: "two" }]);
});

test("active compaction distinguishes a later intercepted tool from an ordinary post-result final", async () => {
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let compactionDeliveries = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => compactionDeliveries,
    completeTool: async (_token: string, _callId: string, result: BrokerToolResult) => {
      expect(result.content).toEqual([{ type: "text", text: "canonical result" }]);
      compactionDeliveries = 1;
      finishBrowser("Stopped after the bridge rejected a later tool call.");
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active_later_tool"),
    externalProgress: { recordToolResult() {} } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([{
    callId: "call_current",
    wireName: "exec_command",
    freeform: false,
  }]);
  const parsed = request(true);
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: "call_current",
    toolName: "exec_command",
    content: "canonical result",
    isError: false,
    timestamp: 4,
  });

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Stopped after the bridge rejected a later tool call.",
    compactionInstructionDelivered: true,
  });
});

test("active compaction waits for an ordinary response with no available tool boundary", async () => {
  const browser = Promise.resolve("The ordinary response reached its terminal boundary.");
  let requested = 0;
  const broker = {
    requestCompaction: () => { requested += 1; return 0; },
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_without_boundary"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
    answer: "The ordinary response reached its terminal boundary.",
    compactionInstructionDelivered: false,
  });
  expect(requested).toBe(1);
});

test("active compaction aborts its source when the shared handoff deadline expires", async () => {
  const controller = new AbortController();
  const deadlineError = new Error("shared compaction deadline expired");
  const browser = new Promise<string>(() => {});
  let cancellations = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_deadline"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  });
  setTimeout(() => controller.abort(deadlineError), 10);

  await expect(settleActiveCompactionSource(
    request(true),
    source,
    broker,
    controller.signal,
  )).rejects.toThrow("shared compaction deadline expired");
  expect(cancellations).toBe(1);
});

test.each([false, true])(
  "active compaction reports real generation/trace/text progress while settling (Zero Risk=%s)",
  async zeroRisk => {
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    let finishBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
    const source = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(zeroRisk ? "turn_zero_risk_progress" : "turn_active_progress"),
      externalProgress: { recordToolResult() {} } as never,
      ...(zeroRisk ? { manualControl: { surfaceNonce: "p".repeat(24) } } : {}),
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace,
      text,
      usageInput: request(false), compactionSourceCoverage: deliveredCoverage(request(false)),
      cancel() {},
    });
    source.setOutstanding([{ callId: "call_progress", wireName: "exec_command", freeform: false }]);
    const parsed = request(true);
    parsed.context.messages.push({
      role: "toolResult",
      toolCallId: "call_progress",
      toolName: "exec_command",
      content: "canonical result",
      isError: false,
      timestamp: 4,
    });
    (parsed._rawBody as { input: unknown[] }).input.push({ type: "function_call_output", call_id: "call_progress", output: "canonical result" });
    const broker = {
      ...mockSourceCapability,
      requestCompaction: () => 0,
      compactionDeliveryCount: () => 0,
      completeTool: async () => {
        setTimeout(() => trace.recordProgress(), 5);
        setTimeout(() => trace.push({ kind: "reasoning", text: "reasoning delta" }), 10);
        setTimeout(() => text.push("summary delta"), 20);
        setTimeout(() => finishBrowser(zeroRisk ? "Zero Risk checkpoint" : "ordinary final"), 30);
      },
      revoke() {},
    } as unknown as TurnBroker;
    let progress = 0;

    if (zeroRisk) {
      expect(await settleActiveZeroRiskCompactionSource(
        parsed,
        source,
        broker,
        undefined,
        () => { progress += 1; },
        undefined, false, compactionCapabilities,
      )).toBe("Zero Risk checkpoint");
    } else {
      await expect(settleActiveCompactionSource(
        parsed,
        source,
        broker,
        undefined,
        () => { progress += 1; },
      )).resolves.toEqual({
        answer: "ordinary final",
        compactionInstructionDelivered: false,
      });
    }
    expect(progress).toBeGreaterThanOrEqual(4);
  },
);

test("Zero Risk active compaction returns through its explicit completion control", async () => {
  const completed: BrokerToolResult[] = [];
  const broker = {
    ...mockSourceCapability,
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, _callId: string, result: BrokerToolResult) => {
      completed.push(result);
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active_zero_risk"),
    externalProgress: { recordToolResult() {} } as never,
    manualControl: { surfaceNonce: "n".repeat(24) },
    browser: Promise.resolve("Zero Risk checkpoint"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: request(false), compactionSourceCoverage: deliveredCoverage(request(false)),
    cancel() {},
  });
  source.setOutstanding([{ callId: "call_one", wireName: "exec_command", freeform: false }]);
  const parsed = request(true);
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: "call_one",
    toolName: "exec_command",
    content: "one",
    isError: false,
    timestamp: 4,
  });

  (parsed._rawBody as { input: unknown[] }).input.push({ type: "function_call_output", call_id: "call_one", output: "one" });
  expect(await settleActiveZeroRiskCompactionSource(parsed, source, broker, undefined, undefined, undefined, false, compactionCapabilities))
    .toBe("Zero Risk checkpoint");
  expect(JSON.stringify(completed)).toContain("Return only the complete checkpoint summary to Codex with codex_turn_complete");
  expect(JSON.stringify(completed)).not.toContain("CODEX_ACTIVE_COMPACTION_CHECKPOINT_");
});

test("active compaction interrupts a queued MCP call that Codex never started waiting for", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-queued-call-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_queued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const queuedInvocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    const browser = queuedInvocation.then(result => {
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result.content)).toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
      expect(JSON.stringify(result.content)).toContain("The tool was not executed");
      expect(JSON.stringify(result.content)).not.toContain("codex.control.compaction_handoff");
      return "Stopped for the retained compaction handoff";
    });
    const source = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(token),
      externalProgress: {
        recordToolResult() {},
      } as never,
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      retireCapability: () => broker.revoke(token),
      cancel() {},
    });

    await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
      answer: "Stopped for the retained compaction handoff",
      compactionInstructionDelivered: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later native message waits for the current response and its physical settlement without preempting it", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishClient!: (answer: string) => void;
  let settlePhysical!: () => void;
  const clientOutcome = new Promise<string>(resolve => { finishClient = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let cancellations = 0;
  sessions.getOrCreate("old", () => ({
    mode: "read-only",
    browser: clientOutcome,
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  }), "old_trace", "same_owner");
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "same_owner", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("new"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() {},
    };
  });

  await Bun.sleep(0);
  expect(starts).toBe(0);
  expect(cancellations).toBe(0);
  finishClient("old complete");
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
  sessions.clear();
});

test("a later native message still waits when logical completion happened before ownership lookup", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  const completed = sessions.getOrCreate("old-completed", () => ({
    mode: "read-only",
    browser: Promise.resolve("logical result"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  }), "old_trace", "same_owner_after_result");
  await completed.browserOutcome;

  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement(
    "new-after-result",
    "same_owner_after_result",
    () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("new"),
        physicalSettlement: Promise.resolve(),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel() {},
      };
    },
  );
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  sessions.clear();
});

test("retained conversation release waits for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let releases = 0;
  sessions.getOrCreate("retained", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "a".repeat(64),
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  const retirement = sessions.retireConversationAndWait("a".repeat(64));
  await Bun.sleep(0);
  expect(releases).toBe(0);
  settlePhysical();
  expect(await retirement).toBe(1);
  expect(releases).toBe(1);
});

test("a repeated compaction waits for the previous conversation retirement", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "c".repeat(64);
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  sessions.getOrCreate("retained-repeating", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => {},
    cancel() {},
  }));

  const retirement = sessions.retireConversationAndWait(conversationKey);
  let waited = false;
  const nextCompaction = sessions.waitForConversationRetirement(conversationKey).then(() => {
    waited = true;
  });
  await Bun.sleep(0);
  expect(waited).toBeFalse();
  settlePhysical();
  await retirement;
  await nextCompaction;
  expect(waited).toBeTrue();
});

test("retained compaction can close its browser epoch while preserving an ordinary final response", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "b".repeat(64);
  const text = new ChatGptTextFeed();
  text.push("ordinary final answer");
  let releases = 0;
  let replacementStarts = 0;
  const source = sessions.getOrCreate("ordinary-final", () => ({
    mode: "read-only",
    browser: Promise.resolve("ordinary final answer"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await source.browserOutcome;
  await source.physicalSettlement;

  expect(await sessions.retireConversationPreservingFinalResponse(
    conversationKey,
    source,
    "compacted-ordinary-final",
  )).toBe(1);
  expect(releases).toBe(1);
  expect(source.conversationKey()).toBeUndefined();
  expect(sessions.findConversationHead(conversationKey)).toBeUndefined();
  expect(sessions.find("ordinary-final")).toBeUndefined();
  expect(sessions.find("compacted-ordinary-final")).toBe(source);
  expect(sessions.getOrCreate("compacted-ordinary-final", () => {
    replacementStarts += 1;
    throw new Error("the committed final response must be replayed, not replaced");
  })).toBe(source);
  expect(replacementStarts).toBe(0);
  sessions.clear();
});

test.each([false, true])("adapter retained checkpoint preserves the ordinary final (Bigger Context=%s)", async experimentalBiggerContext => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-adapter-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retained-compact-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      experimentalBiggerContext,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  sourceRequest._chatgptModelFamily = "6";
  const sourceCoverage = deliveredCoverage(sourceRequest);
  if (experimentalBiggerContext) {
    sourceCoverage.prepare(createContextSnapshot(sourceRequest), { historyRevision: 0,
      pageGeneration: "bigger-page", planId: "bigger-selected", bodyDigest: "bigger-body", manifestDigest: "bigger-images",
      pageTokens: 150_000, externalizedTargetIds: [] });
    sourceCoverage.markDelivered("bigger-selected");
  }
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: sourceCoverage,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    if (experimentalBiggerContext) {
      const entry = JSON.parse(prepared.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
      expect(entry.overview.remaining_tokens).toBeGreaterThan(80_000 - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
      expect(entry.overview.remaining_tokens).toBeLessThan(90_000 - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
    }
    turn.onSubmitted?.();
    expect(turn.nativeConnector).toBeTrue();
    expect(turn.capabilities.localToolsEnabled).toBeFalse();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Adapter retained checkpoint",
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const compactSourceMessage = (compact._rawBody as { input: Array<{
    content: Array<{ type: string; text: string }>;
  }> }).input.at(-1)!;
  compactSourceMessage.content = [{
    type: "input_text",
    text: "Provider-normalized current task revision",
  }];
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_compact",
    }),
  };
  expect(chatGptConversationKey(compact, namespace)).toBe(conversationKey);
  const compactedSourceKey = `${namespace}:${chatGptCompactionSourceExecutionKey(compact)}`;
  expect(compactedSourceKey).not.toBe(sourceKey);
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    const text = events
      .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(text).toContain("Adapter retained checkpoint");
    expect(text).toContain("CODEX_LATEST_USER_PROMPT_JSON");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
    expect(chatGptTurnSessions.find(compactedSourceKey)).toBeDefined();
    expect(chatGptTurnSessions.find(compactedSourceKey)!.conversationKey()).toBeUndefined();
    expect(chatGptTurnSessions.findConversationHead(conversationKey)).toBeUndefined();
    expect(releases).toBe(1);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("real adapter active-source compaction keeps a 1s idle lease alive with 300ms text progress", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-active-compact-idle-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://active-compact-idle-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  const token = await broker.register({
    cwd: root,
    roots: [root],
    writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" },
    tools: [{
      name: "exec_command",
      description: "Run one command",
      parameters: { type: "object" },
    }],
  }, 10_000, "trace_active_compact_idle");
  const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
    method: "claim",
    token,
  });
  const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
    method: "invoke",
    bindingId: claimed.bindingId,
    wireName: "exec_command",
    arguments: { cmd: "synthetic" },
  });
  const outstanding = await broker.nextToolBatch(token);
  expect(outstanding).toHaveLength(1);
  const trace = new ChatGptTraceFeed();
  const text = new ChatGptTextFeed();
  const browser = invocation.then(async result => {
    expect(result.content).toEqual([{ type: "text", text: "canonical result" }]);
    for (const chunk of ["a", "b", "c", "d", "e"]) {
      await Bun.sleep(300);
      text.push(chunk);
    }
    return "abcde";
  });
  const source = chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "tools",
    token: Promise.resolve(token),
    externalProgress: { recordToolResult() {} } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace,
    text,
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey,
    cancel() {},
  }));
  source.setOutstanding(outstanding);
  const compact = request(true);
  compact.context.messages.push({ role: "assistant", content: [{ type: "toolCall", id: outstanding[0]!.callId,
    name: "exec_command", arguments: { cmd: "synthetic" } }], timestamp: 4 });
  (compact._rawBody as { input: unknown[] }).input.push({ type: "function_call", call_id: outstanding[0]!.callId,
    name: "exec_command", arguments: '{"cmd":"synthetic"}' });
  compact.context.messages.push({
    role: "toolResult",
    toolCallId: outstanding[0]!.callId,
    toolName: "exec_command",
    content: "canonical result",
    isError: false,
    timestamp: 4,
  });
  (compact._rawBody as { input: unknown[] }).input.push({ type: "function_call_output", call_id: outstanding[0]!.callId, output: "canonical result" });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    turn.onSubmitted?.();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Remote idle checkpoint",
    });
    return "Checkpoint submitted through MCP";
  };
  const identity = { threadId: "thread_retained_compaction", turnId: "turn_compact" };
  let expirations = 0;
  const idle = new NativeTurnIdleRegistry(1, () => { expirations += 1; });
  const idleSignal = idle.signal(identity);
  const events: AdapterEvent[] = [];
  const startedAt = Date.now();
  try {
    await createChatGptWebAdapter(provider, { broker }).runTurn!(
      compact,
      {
        headers: new Headers(),
        abortSignal: idleSignal,
        onProgress: () => { idle.touch(identity); },
      },
      event => events.push(event),
    );
    expect(Date.now() - startedAt).toBeGreaterThan(1_000);
    expect(expirations).toBe(0);
    expect(idleSignal.aborted).toBeFalse();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    idle.release(identity);
    idle.clear();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compact HTTP observer can reconnect without sending a second retained-chat message", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compact-reconnect-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-reconnect-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserMessages = 0;
  let messageStarted!: () => void;
  const started = new Promise<void>(resolve => { messageStarted = resolve; });
  let finishMessage!: () => void;
  const finish = new Promise<void>(resolve => { finishMessage = resolve; });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    turn.onSubmitted?.();
    prepared.release();
    messageStarted();
    await finish;
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Reconnect-safe checkpoint",
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_compact_reconnect",
    }),
  };
  const adapter = createChatGptWebAdapter(provider);
  const disconnect = new AbortController();
  try {
    const first = adapter.runTurn!(
      compact,
      { headers: new Headers(), abortSignal: disconnect.signal },
      () => {},
    );
    await started;
    disconnect.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const events: AdapterEvent[] = [];
    const reconnect = adapter.runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    finishMessage();
    await reconnect;
    expect(browserMessages).toBe(1);
    expect(releases).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Reconnect-safe checkpoint"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("structured compact rejects missing source coverage before sending (Bigger Context=%s)", async experimentalBiggerContext => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://missing-retained-${Date.now()}`,
    chatgptWeb: {
      experimentalBiggerContext,
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    expect(turn.requireRetainedConversation).toBeUndefined();
    expect(turn.conversationKey).toBeUndefined();
    expect(turn.compaction).toBeTrue();
    const prepared = await turn.prepare();
    const contextText = prepared.multipart?.parts.join("\n") ?? prepared.text;
    expect(contextText).toContain("Original task");
    expect(contextText).toContain("Continue with the next step");
    if (experimentalBiggerContext) {
      expect(prepared.multipart!.parts).toHaveLength(6);
      expect(prepared.trimmedCompactionMessages).toBeUndefined();
      const lastRecord = prepared.multipart!.parts.flatMap(part => JSON.parse(part).records).at(-1);
      expect(lastRecord.message.content).toBe(compact.context.messages.at(-1)!.content);
    }
    prepared.release();
    return "Fallback checkpoint from canonical Codex context";
  };
  const compact = request(true);
  const events: AdapterEvent[] = [];
  if (experimentalBiggerContext) compact.context.messages.at(-1)!.content += "x".repeat(160_000);
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBeLessThanOrEqual(1);
    expect(events.some(event => event.type === "text_delta")).toBeFalse();
    expect(events.at(-1)).toMatchObject({ type: "error", code: "continuity_source_unproven", retryable: false });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("configured fresh compaction waits for cleanup and preserves committed final=%s", async committed => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-fresh-owner-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://fresh-owner-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true,
      experimentalFreshConversationPerTurn: true },
  };
  const compact = request(true);
  const sourceKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptCompactionSourceExecutionKey(compact)}`;
  let finishSource!: (answer: string) => void;
  let releaseSource!: () => void;
  let cancelled = false;
  const cleanup = new Promise<void>(resolve => { releaseSource = resolve; });
  const source = chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only", browser: new Promise<string>(resolve => { finishSource = resolve; }),
    physicalSettlement: cleanup, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: request(false), compactionSourceCoverage: deliveredCoverage(request(false)),
    cancel: () => { cancelled = true; finishSource("retired source"); },
  }));
  if (committed) {
    finishSource("committed final");
    await source.browserOutcome;
  }
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async turn => { starts += 1; const prepared = await turn.prepare(); turn.onSubmitted?.(); prepared.release(); return "Fresh checkpoint"; };
  const events: AdapterEvent[] = [];
  let pending: Promise<void> | undefined;
  try {
    pending = createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cancelled).toBe(!committed);
    expect(starts).toBe(0);
    releaseSource();
    await pending;
    expect(starts).toBe(1);
    expect(chatGptTurnSessions.find(sourceKey)).toBe(committed ? source : undefined);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    finishSource("cleanup");
    releaseSource();
    await pending;
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("fresh compaction sends one bounded entry within the original phase budget with fresh mode=%s", async freshConversation => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-phased-fallback-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://phased-fallback-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 400,
      experimentalFreshConversationPerTurn: freshConversation,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.traceId.endsWith(freshConversation ? "_fresh" : "_fallback")).toBeTrue();
    const prepared = await turn.prepare();
    expect(prepared.multipart).toBeUndefined();
    expect(prepared.text).toContain("codex_context_navigation_json");
    turn.onSubmitted!();
    mock.timers.tick(250);
    expect(turn.abortSignal?.aborted).toBeFalse();
    prepared.release();
    return "Fallback checkpoint after separately bounded phases";
  };
  const sourceRequest = request(false);
  const sourceKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({ mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), cancel() {} }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;
  const events: AdapterEvent[] = [];
  // Keep deadline checks and timers on the same clock for this simulated phase.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after separately bounded phases"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    clockNow.mockRestore();
    mock.timers.reset();
    chatGptTurnSessions.clear();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction survives process suspension but still expires after awake inactivity", async () => {
  for (const completeAfterWake of [true, false]) {
    const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-suspension-"));
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://compaction-suspension-${root}`,
      chatgptWeb: {
        browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
        brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
        solAvailable: true, extraHighAvailable: true, proAvailable: true,
      },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let finish!: (summary: string) => void;
    const browser = new Promise<string>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    let browserStarts = 0;
    worker.run = async turn => {
      browserStarts++;
      signal = turn.abortSignal;
      const prepared = await turn.prepare();
      prepared.release();
      await turn.onSubmitted?.();
      started();
      return browser;
    };
    const sourceRequest = request(false);
    const sourceKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptTurnExecutionKey(sourceRequest)}`;
    chatGptTurnSessions.getOrCreate(sourceKey, () => ({ mode: "read-only", browser: Promise.resolve("source complete"),
      physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest), cancel() {} }));
    await chatGptTurnSessions.find(sourceKey)!.browserOutcome;
    const events: AdapterEvent[] = [];
    // No interval ticks run during the jump: both processes were frozen in #863.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const time = spyOn(performance, "now").mockImplementation(() => Date.now());
    const run = createChatGptWebAdapter(provider).runTurn!(
      request(true), { headers: new Headers() }, event => events.push(event),
    );
    try {
      await ready;
      mock.timers.tick(600_000);
      await Bun.sleep(1);
      expect(signal?.aborted).toBeFalse();
      expect(events.some(event => event.type === "error")).toBeFalse();
      expect(browserStarts).toBe(1);
      if (!completeAfterWake) {
        // The process is awake again, but ChatGPT produces no activity.
        for (let i = 0; i < 300; i++) {
          chatGptSuspensionClock.tick(performance.now());
          mock.timers.tick(1_000);
        }
        await Bun.sleep(1);
        expect(signal?.aborted).toBeTrue();
        expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_handoff_timeout" });
      }
      finish("Checkpoint completed after the process resumed");
      await run;
      if (completeAfterWake) {
        expect(events.some(event => event.type === "text_delta"
          && event.text.includes("Checkpoint completed after the process resumed"))).toBeTrue();
        expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      }
    } finally {
      finish("test cleanup");
      await run;
      time.mockRestore();
      mock.timers.reset();
      worker.run = originalRun;
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("cancel-all waits for physical settlement of a fresh compaction fallback", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-cancel-fresh-compaction-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://cancel-fresh-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let fallbackStarted!: () => void;
  const fallbackReady = new Promise<void>(resolve => { fallbackStarted = resolve; });
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let cancelObserved = false;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.requireRetainedConversation).toBeUndefined();
    fallbackStarted();
    turn.abortSignal?.addEventListener("abort", () => { cancelObserved = true; }, { once: true });
    await physicalSettlement;
    return "cancelled fallback";
  };

  const adapterRun = createChatGptWebAdapter(provider).runTurn!(
    request(true),
    { headers: new Headers() },
    () => {},
  );
  try {
    await fallbackReady;
    const cancellation = cancelAllStructuredCompactions(new Error("operator cancelled"));
    let cancellationSettled = false;
    void cancellation.then(() => { cancellationSettled = true; });
    await Bun.sleep(10);
    expect(cancelObserved).toBeTrue();
    expect(cancellationSettled).toBeFalse();
    releasePhysical();
    await expect(cancellation).resolves.toBe(1);
    await adapterRun;
  } finally {
    releasePhysical();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out fresh compaction retains its owner until helper cleanup completes", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-timeout-cleanup-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://timeout-cleanup-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 40,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let browserStarts = 0;
  let cancelled = false;
  let fallbackTrace = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    fallbackTrace = turn.traceId;
    await turn.onMultipartStageAcknowledged?.(1);
    turn.onGenerationProgress?.();
    started();
    turn.abortSignal!.addEventListener("abort", () => { cancelled = true; }, { once: true });
    await physicalSettlement;
    return "Browser released after cancellation";
  };
  const adapter = createChatGptWebAdapter(provider);
  const events: AdapterEvent[] = [];
  const runs: Promise<void>[] = [];
  const observe = () => {
    const run = adapter.runTurn!(request(true), { headers: new Headers() }, event => events.push(event));
    runs.push(run);
    return run;
  };
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  try {
    void observe();
    await ready;
    mock.timers.tick(41);
    await Bun.sleep(5);
    expect(cancelled).toBeTrue();
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
    const timeoutLog = warnings.mock.calls.map(([line]) => String(line))
      .find(line => line.startsWith("[chatgpt-web] compaction_timeout "))!;
    expect(JSON.parse(timeoutLog.slice(timeoutLog.indexOf("{")))).toMatchObject({
      phase: "fresh_compaction",
      timeoutMs: 40,
      lastActivity: "generation",
      acknowledgedParts: 1,
      elapsedMs: expect.any(Number),
      idleMs: expect.any(Number),
    });
    await observe();
    let cleanupSettled = false;
    const cleanup = cancelStructuredCompactionTrace(fallbackTrace, new Error("wait for timeout cleanup"))
      .then(count => { cleanupSettled = true; return count; });
    await Bun.sleep(5);
    expect(browserStarts).toBe(1);
    expect(cleanupSettled).toBeFalse();
    releasePhysical();
    expect(await cleanup).toBe(1);
    await Promise.all(runs);
    expect(events.filter(event => event.type === "error")).toHaveLength(2);
    expect(events.some(event => event.type === "done")).toBeFalse();
    await observe();
    expect(browserStarts).toBe(2);
    // This worker deliberately skipped prepare/Send; a later plain answer cannot turn
    // the cancelled attempt into a checkpoint without a delivered source entry.
    expect(events.at(-1)).toMatchObject({ type: "error", code: "continuity_source_unproven" });
  } finally {
    releasePhysical();
    await Promise.allSettled(runs);
    clockNow.mockRestore();
    mock.timers.reset();
    warnings.mockRestore();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("structured compact rebuild after retained browser loss preserves rate limit=%s", async rateLimited => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
    const prepared = await turn.prepare();
    expect(prepared.text).toContain("codex_context_navigation_json");
    expect(prepared.text).not.toContain("Original task");
    turn.onSubmitted?.();
    prepared.release();
    if (rateLimited) throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests.", {
      status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    });
    return "Fallback checkpoint after retained browser loss";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(2);
    if (rateLimited) {
      expect(events.at(-1)).toMatchObject({
        type: "error", status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded",
        retryable: false, message: "ChatGPT rate limit: too many requests.",
      });
      expect(events.some(event => event.type === "done")).toBeFalse();
      return;
    }
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after retained browser loss"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disappeared retained source cannot leave its fresh compaction rebuild past the shared deadline", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-deadline-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-deadline-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 25,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  let releaseBrowser: (() => void) | undefined;
  let fallbackTrace = "";
  let fallbackStarted!: () => void;
  const fallbackReady = new Promise<void>(resolve => { fallbackStarted = resolve; });
  let fallbackSignal: AbortSignal | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
    fallbackTrace = turn.traceId;
    fallbackSignal = turn.abortSignal;
    fallbackStarted();
    return new Promise<string>(resolve => { releaseBrowser = () => resolve("browser cleanup completed"); });
  };
  const events: AdapterEvent[] = [];
  let pending: Promise<void> | undefined;
  let clockNow: ReturnType<typeof spyOn> | undefined;
  try {
    // Start the socket with real timers before controlling the compaction deadline.
    const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
    const setup = await broker.beginCompactionTransaction("deadline-test-setup");
    broker.abortCompactionTransaction(setup.token);
    // Keep credential expiry and elapsed inactivity on the controlled clock.
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
    pending = createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    await Promise.race([fallbackReady, pending.then(() => { throw new Error("Compaction ended before its fallback started"); })]);
    expect(browserStarts).toBe(2);
    mock.timers.tick(24);
    expect(fallbackSignal?.aborted).toBeFalse();
    expect(events.some(event => event.type === "error" || event.type === "done")).toBeFalse();
    mock.timers.tick(1);
    await pending;
    expect(fallbackSignal?.aborted).toBeTrue();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "compaction_handoff_timeout",
      retryable: false,
      message: "ChatGPT compaction had no observed activity for 25ms",
    });
  } finally {
    releaseBrowser?.();
    clockNow?.mockRestore();
    mock.timers.reset();
    await cancelStructuredCompactionTrace(fallbackTrace, new Error("test cleanup"));
    await pending;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-aborted compaction wait observes an already rejected source promise", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Compaction was cancelled before waiting", "AbortError");
  controller.abort(reason);
  await expect(withCompactionAbort(Promise.reject(new Error("Source stopped")), controller.signal)).rejects.toBe(reason);
  await Bun.sleep(0);
});

test("finishing the previous response does not consume the retained checkpoint's time budget", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-retained-phases-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://retained-phases-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: true, turnTimeoutMs: 400 },
  };
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  let finishSource!: (text: string) => void;
  const browser = new Promise<string>(resolve => { finishSource = resolve; });
  chatGptTurnSessions.getOrCreate(`${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`, () => ({
    mode: "read-only", browser, physicalSettlement: browser.then(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), usageInput: sourceRequest, compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, namespace), cancel: () => finishSource("cancelled"),
  }));
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  await broker.listen();
  worker.run = async turn => {
    mock.timers.tick(250);
    expect(turn.abortSignal?.aborted).toBeFalse();
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    turn.onSubmitted?.();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff", token: binding.token,
      handoffId: binding.handoffId, summary: "Checkpoint after previous response settled",
    });
    return "Checkpoint submitted";
  };
  const events: AdapterEvent[] = [];
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  let run: Promise<void> | undefined;
  try {
    run = createChatGptWebAdapter(provider).runTurn!(request(true), { headers: new Headers() }, event => events.push(event));
    await new Promise<void>(resolve => setImmediate(resolve));
    mock.timers.tick(250);
    finishSource("Previous response finished");
    await run;
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.some(event => event.type === "text_delta" && event.text.includes("Checkpoint after previous"))).toBeTrue();
  } finally {
    finishSource("cleanup");
    await run;
    clockNow.mockRestore();
    mock.timers.reset();
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("compaction source progress renews waiting, but silent source still expires (%s)", async live => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-retained-progress-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://retained-phases-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true,
      solAvailable: true, extraHighAvailable: true, proAvailable: true, turnTimeoutMs: 40 },
  };
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  let finishSource!: (text: string) => void;
  const browser = new Promise<string>(resolve => { finishSource = resolve; });
  const sourceTrace = new ChatGptTraceFeed();
  chatGptTurnSessions.getOrCreate(`${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`, () => ({
    mode: "read-only", browser, physicalSettlement: browser.then(() => {}),
    trace: sourceTrace, text: new ChatGptTextFeed(), usageInput: sourceRequest,
    compactionSourceCoverage: deliveredCoverage(sourceRequest),
    conversationKey: chatGptConversationKey(sourceRequest, namespace), cancel: () => finishSource("cancelled"),
  }));
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  await broker.listen();
  worker.run = async turn => {
    mock.timers.tick(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    turn.onSubmitted?.();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff", token: binding.token,
      handoffId: binding.handoffId, summary: "Checkpoint after previous response settled",
    });
    return "Checkpoint submitted";
  };
  const events: AdapterEvent[] = [];
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const clockNow = spyOn(performance, "now").mockImplementation(() => Date.now());
  let run: Promise<void> | undefined;
  try {
    run = createChatGptWebAdapter(provider).runTurn!(request(true), { headers: new Headers() }, event => events.push(event));
    await new Promise<void>(resolve => setImmediate(resolve));
    for (let step = 0; step < 4; step++) {
      mock.timers.tick(25);
      if (live) sourceTrace.recordProgress();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (live) {
      expect(events.some(event => event.type === "error")).toBeFalse();
      finishSource("Previous response finished");
      await run;
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } else {
      await run;
      expect(events.at(-1)).toMatchObject({ type: "error", code: "compaction_handoff_timeout" });
    }
  } finally {
    finishSource("cleanup");
    await run;
    clockNow.mockRestore();
    mock.timers.reset();
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("public Full Launcher task commits a retained checkpoint once and preserves its final (Bigger Context=%s)", async experimentalBiggerContext => {
  const f = retainedTaskFixture(experimentalBiggerContext);
  try {
    const source = await f.send(f.body);
    expect(source.status).toBe(200);
    const original = await source.json() as { status: string; output: unknown[] };
    expect(original.status).toBe("completed");
    expect(JSON.stringify(original.output)).toContain(f.ordinaryFinal);
    const before = f.store.get(continuityDigest(f.threadId))!;
    expect(before.legacyUnproven).toBe(false);
    expect(before.contextCoverage!.some(entry => entry.metadata.delivered)).toBe(true);
    const sourceWork = before.works[before.currentWorkId!]!;
    expect(sourceWork.state).toBe("completed");
    expect(sourceWork.attempts[0]!.stage).toBe("completed");

    const compactBody = { ...f.body, input: [...f.body.input, ...original.output] };
    const compact = await f.send(compactBody, true);
    expect(compact.status).toBe(200);
    const compacted = await compact.json() as { output: unknown[] };
    expect(JSON.stringify(compacted.output)).toContain(f.summary);
    const committed = f.store.get(continuityDigest(f.threadId))!;
    expect(committed.historyRevision).toBe(1);
    expect(Object.keys(committed.checkpoints)).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.turn.requireRetainedConversation).toBe(true);
    expect(f.submissions[1]!.turn.conversationKey).toBe(f.submissions[0]!.turn.conversationKey);
    expect(f.pages.size).toBe(1);

    const replay = await f.send(compactBody, true);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { output: unknown[] }).output).toEqual(compacted.output);
    const finalReplay = await f.send(f.body);
    expect(finalReplay.status).toBe(200);
    const replayedFinal = await finalReplay.json() as { status: string; output: Array<{ content: unknown }> };
    expect(replayedFinal.status).toBe("completed");
    expect(replayedFinal.output.map(item => item.content)).toEqual(original.output.map(item => (item as { content: unknown }).content));
    expect(f.submissions).toHaveLength(2);
    const after = f.store.get(continuityDigest(f.threadId))!;
    expect(after.historyRevision).toBe(1);
    expect(Object.keys(after.checkpoints)).toHaveLength(1);
    expect(sourceWork.terminalReceiptId).toBeDefined();
    expect(after.works[sourceWork.logicalWorkId]!.terminalReceiptId).toBe(sourceWork.terminalReceiptId);
    expect(after.works[sourceWork.logicalWorkId]!.terminalDigest).toBe(sourceWork.terminalDigest);
  } finally { await f.dispose(); }
});

test("public Full Launcher task recovers a v1 registration from the current request when no page is confirmed", async () => {
  const f = retainedTaskFixture();
  try {
    const parsed = parseRequest(f.body);
    routeChatGptWebRequest(parsed, f.config);
    bindContinuityRequestScope(parsed, chatGptWebExecutionNamespace(f.provider));
    const thread = continuityDigest(f.threadId);
    f.registrations.claim(thread, parsed._continuityScope!, "b".repeat(64));
    // Recreate the actual v1 storage shape: registration exists, but no recovery journal.
    // Migration does not invent old dispatch evidence. Unknown pages admit the current request.
    const marker = JSON.parse(readFileSync(join(f.statePath, "initialized.json"), "utf8"));
    delete marker.recoveryVersion;
    writeFileSync(join(f.statePath, "initialized.json"), JSON.stringify(marker));
    rmSync(join(f.statePath, "recovery.json"));
    rmSync(join(f.statePath, "recovery-initialized.json"));
    f.registrations.initialize();
    const before = f.store.get(thread)!;
    expect(before.legacyUnproven).toBe(true);
    expect(before.works).toEqual({});

    const recovered = await f.send(f.body);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: "completed" });
    expect(f.submissions).toHaveLength(1);
    expect(f.pages.size).toBe(1);
    const after = f.store.get(thread)!;
    expect(after.legacyUnproven).toBe(false);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.owner.id).not.toBe(before.owner.id);
    expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  } finally { await f.dispose(); }
});
