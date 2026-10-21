import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRequest } from "../src/responses/parser";
import { defaultBrokerEndpoint } from "../src/config";
import { CompactionSourceCoverage, captureCompactionSource, captureRetainedCompactionSource, assertCompactionReadable, compactionAvailableTokens, prepareFreshCompactionSource, registerCompactionSource } from "../src/adapters/chatgpt-web/compaction-context";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { requestRetainedCompactionHandoff, settleActiveZeroRiskCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession, chatGptTurnRoundKey, TASK_UPDATE_SESSION_JOURNAL_BYTES, TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ContextPreparedReply } from "../src/adapters/chatgpt-web/context-runtime";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ContextSend } from "../src/adapters/chatgpt-web/context-send";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";
import { contextLimits } from "../src/adapters/chatgpt-web/context-budget";

// Keep these retained-capacity cases on the existing inline/on-demand path.
const capabilities = { maxComposerCodePoints: 2_000_000, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };

for (const remote of [false, true]) test(`fresh Native summary closes reads atomically (remote=${remote})`, async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-fresh-context-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  await broker.listen();
  const owner = remote ? new RemoteTurnBroker(broker.socketPath) : broker;
  let fresh: Awaited<ReturnType<typeof prepareFreshCompactionSource>> | undefined;
  try {
    const parsed = input(); parsed._compactionRequest = true;
    const ledger = coverage(parsed); ledger.markDelivered("selected");
    fresh = await prepareFreshCompactionSource(parsed, owner, capabilities, {
      historyRevision: 0, ownerGeneration: "fresh-page", traceId: "fresh-context", sourceCoverage: ledger,
    });
    const entry = JSON.parse(fresh.instruction.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = () => callTurnBroker<ContextPreparedReply>(broker.socketPath, { method: "context_query",
      token: credential.compaction_token, contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION,
      contextMethod: "search", contextArgs: { context_id: credential.context_id, query: "UNIQUE_DATABASE_MARKER" } });
    await expect(fresh.acceptSummary("undelivered summary")).rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await fresh.markDelivered();
    const pending = await query();
    await expect(fresh.acceptSummary("read still pending")).rejects.toMatchObject({ code: "CONTEXT_BUSY" });
    // A rejected commit leaves the source available for correction and receipt settlement.
    await callTurnBroker(broker.socketPath, { method: "context_return", token: credential.compaction_token,
      contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: pending.receiptId, sent: true });
    await expect(fresh.acceptSummary("supported fresh checkpoint")).resolves.toBe("supported fresh checkpoint");
    await expect(query()).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
  } finally { await fresh?.cleanup(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("fresh Native summary does not admit a read between owner validation and closure", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-fresh-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  await broker.listen();
  const owner = new RemoteTurnBroker(broker.socketPath);
  let fresh: Awaited<ReturnType<typeof prepareFreshCompactionSource>> | undefined;
  let admittedBetweenGuardAndClosure = false;
  let readRejectedBeforeSummaryReturned = false;
  try {
    const parsed = input(); parsed._compactionRequest = true;
    const ledger = coverage(parsed); ledger.markDelivered("selected");
    // Force the old two-RPC sequence to expose its gap. The atomic owner operation
    // must not use this separate guard RPC when it accepts a fresh summary.
    const originalGuard = owner.guardCompactionContextCommit.bind(owner);
    owner.guardCompactionContextCommit = async token => {
      await originalGuard(token);
      const entry = JSON.parse(fresh!.instruction.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
      await callTurnBroker(broker.socketPath, { method: "context_query", token, contract: "native",
        credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "list",
        contextArgs: { context_id: entry.first_call.arguments.context_id, view: "overview" } });
      admittedBetweenGuardAndClosure = true;
    };
    const originalCommit = owner.commitCompactionContext.bind(owner);
    owner.commitCompactionContext = async token => {
      await originalCommit(token);
      // Try a new read after owner admission but before acceptSummary receives
      // its successful response. Closure must already be effective.
      const entry = JSON.parse(fresh!.instruction.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
      await expect(callTurnBroker(broker.socketPath, { method: "context_query", token, contract: "native",
        credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "list",
        contextArgs: { context_id: entry.first_call.arguments.context_id, view: "overview" } }))
        .rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
      readRejectedBeforeSummaryReturned = true;
    };
    fresh = await prepareFreshCompactionSource(parsed, owner, capabilities, {
      historyRevision: 0, ownerGeneration: "fresh-page", traceId: "fresh-race", sourceCoverage: ledger,
    });
    await fresh.markDelivered();
    await expect(fresh.acceptSummary("supported fresh checkpoint")).resolves.toBe("supported fresh checkpoint");
    expect(admittedBetweenGuardAndClosure).toBeFalse();
    expect(readRejectedBeforeSummaryReturned).toBeTrue();
  } finally { await fresh?.cleanup(); await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});
function input(log = "unread evidence UNIQUE_DATABASE_MARKER", extra = "") {
  return parseRequest({ model: "gpt-5.6-sol", input: [
    { role: "user", content: "Summarize the migration" },
    { type: "function_call", call_id: "call-1", name: "exec_command", arguments: '{"cmd":"check migration"}' },
    { type: "function_call_output", call_id: "call-1", output: log },
    ...(extra ? [{ role: "user", content: extra }] : []),
  ] });
}
function coverage(parsed = input(), planId = "selected") {
  const snapshot = createContextSnapshot(parsed);
  const ledger = new CompactionSourceCoverage();
  ledger.prepare(snapshot, { historyRevision: 0, pageGeneration: "page-1", planId,
    bodyDigest: "a".repeat(64), manifestDigest: "b".repeat(64), pageTokens: 2_000,
    externalizedTargetIds: snapshot.targets.filter(t => t.kind === "tool_result").map(t => t.target_id) });
  return ledger;
}

test("retained reading capacity uses the selected Bigger Context window", async () => {
  const parsed = input(); parsed._chatgptModelFamily = "6";
  const snapshot = createContextSnapshot(parsed);
  const ordinary = compactionAvailableTokens(parsed, capabilities, 150_000);
  const bigger = compactionAvailableTokens(parsed, { ...capabilities, experimentalBiggerContext: true }, 150_000);
  expect(ordinary).toBe(0);
  expect(bigger).toBe(90_000 - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
  await expect(assertCompactionReadable(snapshot, ordinary)).rejects.toMatchObject({ code: "continuity_input_limit" });
  await expect(assertCompactionReadable(snapshot, bigger)).resolves.toBeUndefined();
});

for (const bigger of [false, true]) test(`compaction protects platform capacity once across physical sends (bigger=${bigger})`, async () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Summarize this source" }] });
  parsed._chatgptModelFamily = "6";
  const selectedCapabilities = { ...capabilities, experimentalBiggerContext: bigger };
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-platform-capacity-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  const reuseCapability = spyOn(broker, "contextReuseAvailable").mockReturnValue(false);
  const options = bigger ? { experimentalMultipartParts: 2 as const } : {};
  const token = "capacity-test-token";
  const first = new ContextSend(parsed, broker, capabilities, "capacity-page");
  const baseline = await first.prepare(parsed, token, options);
  const pageWindow = baseline.costs.contextWindowTokens;
  const retained = pageWindow - 32_000 - baseline.costs.promptTokens - baseline.costs.workReserveTokens;
  const selected = await first.prepare(parsed, token, options, retained);
  await first.select(token, selected); await first.sent();
  expect(first.coverage.pageTokenReserve()).toBe(pageWindow - 32_000);
  expect(compactionAvailableTokens(parsed, selectedCapabilities, first.coverage.pageTokenReserve()))
    .toBe(32_000 - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
  const transaction = await broker.beginCompactionTransaction("capacity-test", 30_000);
  const registration = spyOn(broker, "registerCompactionContext");
  const instruction = "Summarize this fixed source and submit the checkpoint";
  const sourceInput = { snapshot: first.snapshot, contract: "native" as const, transactionToken: transaction.token,
    handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "capacity-page", expiresAt: Date.now() + 30_000 };
  try {
    const available = compactionAvailableTokens(parsed, selectedCapabilities, first.coverage.pageTokenReserve());
    const control = await registerCompactionSource(broker, { ...sourceInput, availableTokens: available }, instruction);
    const registered = registration.mock.calls[0]![0];
    expect(registered.remainingBudget!.tokens).toBe(available - estimateTokens(instruction) - 4_096);
    expect(registered.remainingBudget!.reserved_tokens).toBe(8_192);
    expect(control.instruction).toContain("codex_context");
    await broker.revokeCompactionContext(control.token);
    const second = new ContextSend(parsed, broker, capabilities, "capacity-page", first.coverage);
    const next = await second.prepare(parsed, token, options, first.coverage.pageTokenReserve());
    await second.select(token, next); await second.sent();
    expect(second.coverage.pageTokenReserve()).toBe(first.coverage.pageTokenReserve() + next.costs.promptTokens + next.costs.workReserveTokens);
    expect(compactionAvailableTokens(parsed, selectedCapabilities, second.coverage.pageTokenReserve()))
      .toBe(pageWindow - second.coverage.pageTokenReserve() - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
    const boundary = new ContextSend(parsed, broker, capabilities, "capacity-page", second.coverage);
    const nearLimit = await boundary.prepare(parsed, token, options,
      pageWindow - 18_000 - baseline.costs.promptTokens - baseline.costs.workReserveTokens);
    expect(nearLimit.costs.requiredTotalTokens).toBe(pageWindow - 18_000 + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
    await boundary.select(token, nearLimit); await boundary.sent();
    const remaining = compactionAvailableTokens(parsed, selectedCapabilities, boundary.coverage.pageTokenReserve());
    expect(remaining).toBe(9_808);
    registration.mockClear();
    await expect(registerCompactionSource(broker, { ...sourceInput, snapshot: boundary.snapshot, availableTokens: remaining }, instruction))
      .rejects.toMatchObject({ code: "continuity_input_limit" });
    expect(registration).not.toHaveBeenCalled();
    await first.retire(); await second.retire(); await boundary.retire();
  } finally {
    registration.mockRestore(); reuseCapability.mockRestore(); await broker.abortCompactionTransaction(transaction.token);
    await broker.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("source coverage separates selected preparation from delivery and retains versions across rounds", () => {
  const first = input(); const ledger = coverage(first);
  expect(() => captureCompactionSource(first, ledger)).toThrow("pending");
  ledger.markDelivered("selected");
  const second = input(undefined, "Continue safely");
  const next = ledger.fork();
  next.prepare(createContextSnapshot(second), { historyRevision: 0, pageGeneration: "page-1", planId: "next",
    bodyDigest: "c".repeat(64), manifestDigest: "d".repeat(64), pageTokens: 2_500, externalizedTargetIds: [] });
  expect(() => captureCompactionSource(second, next)).toThrow("pending");
  next.markDelivered("next");
  expect(captureCompactionSource(second, next).targets.length).toBe(4);
  expect(() => captureCompactionSource(input("changed result", "Continue safely"), next)).toThrow("source version");
  expect(() => captureCompactionSource(second, new CompactionSourceCoverage())).toThrow("coverage evidence");
  expect(JSON.stringify(next.metadata())).not.toContain("UNIQUE_DATABASE_MARKER");
  expect(JSON.stringify(next.metadata())).not.toContain("context_");
  const restored = CompactionSourceCoverage.restoreVerifiedSource(createContextSnapshot(second), next.metadata(), 0);
  expect(restored.metadata()).toEqual(next.metadata());
  expect(() => CompactionSourceCoverage.restoreVerifiedSource(createContextSnapshot(input("changed", "Continue safely")), next.metadata(), 0)).toThrow("source version");
  next.checkpointCommitted(0);
  expect(next.metadata()).toEqual([]);
});

test("compaction rejects unavailable images and inadequate reading capacity before control publication", async () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: [
    { type: "input_text", text: "Use the original image" }, { type: "input_image", image_url: "https://unavailable.invalid/image.png" },
  ] }] });
  const ledger = coverage(parsed); ledger.markDelivered("selected");
  expect(() => captureCompactionSource(parsed, ledger)).toThrow("fixed readable bytes");
  await expect(assertCompactionReadable(createContextSnapshot(input()), 8_192)).rejects.toThrow("reading allowance");
  await expect(assertCompactionReadable(createContextSnapshot(input()), 8_192 + 384)).rejects.toThrow("overview");
  await expect(assertCompactionReadable(createContextSnapshot(input()), 20_000, { maxTotalWireBytes: 1_536 })).rejects.toThrow("overview");
});

for (const terminal of [false, true]) test(`compaction rejects an oversized later directory entry before publishing control (terminal=${terminal})`, async () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
    { role: "user", content: "Short source" },
    { type: "function_call", call_id: "c".repeat(999), name: "t".repeat(999), namespace: "n".repeat(999), arguments: "{}" },
    ...(terminal ? [] : [{ role: "user", content: "Later source" }]),
  ] });
  const snapshot = createContextSnapshot(parsed);
  const limits = { listBytes: 12_288, listTokens: 1_500, listEntries: 20 };
  const navigator = new ContextNavigator({ scopeId: "directory-regression", snapshot, purpose: "compaction", limits });
  const first = navigator.list({ context_id: snapshot.context_id, view: "entries" });
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({ entries: [{ kind: "message_text" }], has_more: true });
  const firstPage = first.structuredContent as { next_cursor: string };
  const second = navigator.list({ context_id: snapshot.context_id, view: "entries", cursor: firstPage.next_cursor });
  expect(second.structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED" } });
  expect(navigator.preflightRead({ context_id: snapshot.context_id, reads: [{ read_ref: snapshot.targets[1]!.read_ref! }] }).isError).not.toBe(true);
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-directory-admission-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  const registration = spyOn(broker, "registerCompactionContext");
  const transaction = await broker.beginCompactionTransaction("directory-regression", 30_000);
  try {
    await expect(registerCompactionSource(broker, { snapshot, contract: "native", transactionToken: transaction.token,
      handoffId: transaction.handoffId, historyRevision: 0, ownerGeneration: "directory-page",
      expiresAt: Date.now() + 30_000, availableTokens: 96_000, limits }, "Summarize the original source"))
      .rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(registration).not.toHaveBeenCalled();
  } finally {
    registration.mockRestore(); await broker.abortCompactionTransaction(transaction.token);
    await broker.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("compaction directory admission protects future signed cursor token costs", async () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [
    ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `Source ${index}` })),
    { type: "function_call", call_id: "c".repeat(236), name: "t".repeat(236), namespace: "n".repeat(236), arguments: "{}" },
    { role: "user", content: "Continue" },
  ] });
  await expect(assertCompactionReadable(createContextSnapshot(parsed), 96_000,
    { listBytes: 12_288, listTokens: 1_500, listEntries: 20 })).rejects.toMatchObject({ code: "continuity_source_unproven" });
});

test("navigation usage is monotone, idempotent and credits only the selected required-media reserve", () => {
  const ledger = new CompactionSourceCoverage();
  ledger.prepare(createContextSnapshot(input()), { historyRevision: 0, pageGeneration: "page", planId: "usage",
    bodyDigest: "a".repeat(64), manifestDigest: "b".repeat(64), pageTokens: 2_000,
    navigationReservedTokens: 500, externalizedTargetIds: [] });
  ledger.markDelivered("usage");
  ledger.recordNavigationUsage("usage", { tokens: 1_000, wireBytes: 8_000, reservedTokensUsed: 500 });
  expect(ledger.pageTokenReserve()).toBe(2_500);
  ledger.recordNavigationUsage("usage", { tokens: 1_000, wireBytes: 8_000, reservedTokensUsed: 500 });
  expect(ledger.pageTokenReserve()).toBe(2_500);
  ledger.recordNavigationUsage("usage", { tokens: 20_000, wireBytes: 80_000, reservedTokensUsed: 500 });
  expect(ledger.pageTokenReserve()).toBe(21_500);
  const before = ledger.metadata();
  expect(() => ledger.recordNavigationUsage("usage", { tokens: 19_999, wireBytes: 80_000, reservedTokensUsed: 500 })).toThrow("backwards");
  expect(() => ledger.recordNavigationUsage("usage", { tokens: 20_000, wireBytes: 80_000, reservedTokensUsed: 501 })).toThrow("selected source plan");
  expect(ledger.metadata()).toEqual(before);
});

test("compaction admission checks thousands of targets while yielding and respecting its processing deadline", async () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: Array.from({ length: 3_000 }, (_, index) => ({
    role: "user", content: `${index}: ${"complete original source ".repeat(40)}` })) });
  const snapshot = createContextSnapshot(parsed);
  let timerObserved = false; let timerDelay = Infinity;
  const started = performance.now();
  const timer = setTimeout(() => { timerObserved = true; timerDelay = performance.now() - started; }, 0);
  try { await assertCompactionReadable(snapshot, 96_000); }
  finally { clearTimeout(timer); }
  expect(snapshot.targets).toHaveLength(3_000);
  expect(timerObserved).toBeTrue();
  expect(timerDelay).toBeLessThan(1_000);
  expect(performance.now() - started).toBeLessThan(contextLimits().totalProcessingMs);
  let now = 0;
  const clock = spyOn(performance, "now").mockImplementation(() => now += 2);
  try {
    await expect(assertCompactionReadable(snapshot, 96_000, { totalProcessingMs: 1 })).rejects.toThrow("processing deadline");
  } finally { clock.mockRestore(); }
}, 30_000);

test("source evidence includes actual calls, delivered results and accepted task updates after the initial send", () => {
  const initial = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Summarize the migration" }] });
  const ledger = coverage(initial); ledger.markDelivered("selected");
  ledger.recordIssuedCalls([{ callId: "call-1", wireName: "exec_command", freeform: false, arguments: { cmd: "check migration" } }]);
  const current = input();
  ledger.prepareToolResults(current, ["call-1"]); ledger.markToolResultDelivered("call-1");
  expect(() => captureCompactionSource(initial, ledger)).toThrow("tool result");
  expect(captureCompactionSource(current, ledger).targets.length).toBe(3);
  const update = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Preserve the rollback instruction" }] });
  ledger.recordTaskUpdate(createContextSnapshot(update));
  expect(() => captureCompactionSource(current, ledger)).toThrow("task update");
  expect(captureCompactionSource(input(undefined, "Preserve the rollback instruction"), ledger).targets.length).toBe(4);
});

test("retained actual calls deduplicate HTTP echoes and preserve object argument provenance", () => {
  const initial = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "original complete instruction" }] });
  const ledger = coverage(initial); ledger.markDelivered("selected");
  const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve("test-source"),
    browser: new Promise(() => {}), physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    externalProgress: { recordToolResult() {} } as never, usageInput: initial, compactionSourceCoverage: ledger, cancel() {} });
  source.setOutstanding([{ callId: "actual-call", wireName: "exec_command", arguments: { z: 1, a: 2 }, freeform: false }]);
  const compact = parseRequest({ model: "gpt-5.6-sol", input: [
    { type: "function_call", id: "http-response-id", call_id: "actual-call", name: "exec_command", arguments: '{"z":1,"a":2}' },
    { type: "function_call_output", call_id: "actual-call", output: "actual result" }] });
  source.prepareCompactionToolResults(compact, ["actual-call"]);
  const snapshot = captureRetainedCompactionSource(compact, source);
  const calls = snapshot.targets.filter(target => target.kind === "tool_arguments");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ provenance: "verified_restoration", encoding: "deterministic-json" });
  expect(snapshot.getText(calls[0]!.read_ref!)).toBe('{"a":2,"z":1}');
  expect(snapshot.targets.some(target => snapshot.getText(target.read_ref ?? "") === "original complete instruction")).toBeTrue();
});

test("source coverage mutations reserve the existing session evidence limit before publication", () => {
  const parsed = parseRequest({ model: "gpt-6.1-sol", input: [{ type: "message", id: "source", role: "user", content: "Keep the original source",
    internal_chat_message_metadata_passthrough: { turn_id: "capacity-turn", content_item_kinds: ["user.text"] } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "capacity-thread", turn_id: "capacity-turn" }) } });
  const ledger = coverage(parsed); ledger.markDelivered("selected");
  let persisted = 0; ledger.bindPersistence(() => { persisted++; });
  const session = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve("test-capacity"),
    browser: new Promise(() => {}), physicalSettlement: new Promise(() => {}),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), taskUpdates: { protocolVersion: 1 },
    externalProgress: { recordToolResult() {} } as never, compactionSourceCoverage: ledger, cancel() {} },
    undefined, undefined, "capacity-turn", "capacity-thread");
  expect(session.initializeTaskUpdates(parsed, { capabilityIdentity: {}, executionConfig: {} })).toBeTrue();
  const sourceBytes = Buffer.byteLength(JSON.stringify((parsed._rawBody as { input: unknown[] }).input));
  const coverageBytes = Buffer.byteLength(JSON.stringify(ledger.metadata()));
  const emptyEventBytes = Buffer.byteLength(JSON.stringify([{ type: "text_delta", text: "" }]));
  const room = TASK_UPDATE_SESSION_JOURNAL_BYTES - sourceBytes - coverageBytes - TASK_UPDATE_SESSION_ERROR_TERMINAL_BYTES;
  session.appendRoundEvents(chatGptTurnRoundKey(parsed), [{ type: "text_delta", text: "x".repeat(room - emptyEventBytes) }]);
  const before = ledger.metadata(); const writes = persisted;
  expect(() => session.setOutstanding([{ callId: "new-call", wireName: "exec_command", freeform: false, arguments: { cmd: "true" } }])).toThrow("capacity");
  expect(ledger.metadata()).toEqual(before); expect(persisted).toBe(writes);
  expect(session.hasOutstanding("new-call")).toBeFalse();
});

test("Zero Risk delivers the source entry beside the unchanged real result and completes in the same reply", async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-context-safe-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  try {
    const token = await broker.registerSafe({ authorityMode: "delegated", threadId: "safe-thread", turnId: "safe-turn",
      tools: [{ name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    }, "context-safe-surface-123456789", undefined, "safe-compaction", { requireSentConfirmation: false });
    await callTurnBroker(broker.socketPath, { method: "safe_start", token });
    await callTurnBroker(broker.socketPath, { method: "native_operation_start", token, contract: "safe", nativeWaitProtocol: 1,
      taskUpdateProtocol: 1, taskRevision: 0, operationId: 1, entry: "codex_exec", nativeInput: { cmd: "check migration" }, waitMs: 1 });
    const requests = await broker.nextToolBatch(token);
    const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Summarize the migration" },
      { type: "function_call", call_id: requests[0]!.callId, name: "exec_command", arguments: '{"cmd":"check migration"}' },
      { type: "function_call_output", call_id: requests[0]!.callId, output: "actual completed result UNIQUE_SAFE_MARKER" },
    ] });
    parsed._compactionRequest = true;
    const original = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "Summarize the migration" }] });
    const ledger = coverage(original); ledger.markDelivered("selected");
    const browser = broker.waitForSafeCompletion(token);
    const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve(token), browser,
      physicalSettlement: browser.then(() => undefined), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
      externalProgress: { recordToolResult() {} } as never, usageInput: original, compactionSourceCoverage: ledger,
      manualControl: { surfaceNonce: "context-safe-surface-123456789" }, cancel() {} });
    source.setOutstanding(requests);
    const settled = settleActiveZeroRiskCompactionSource(parsed, source, broker, undefined, undefined, undefined, false, capabilities);
    const reply = await callTurnBroker<{ kind: string; result: { content: Array<{ type: string; text: string }> }; contextControlReceipt: string }>(broker.socketPath, {
      method: "native_operation_wait", token, contract: "safe", nativeWaitProtocol: 1, taskUpdateProtocol: 1,
      operationId: 1, waitMs: 10_000,
    });
    expect(reply.result.content[0]).toEqual({ type: "text", text: "actual completed result UNIQUE_SAFE_MARKER" });
    const text = reply.result.content[1]!.text;
    const entry = JSON.parse(text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const args = entry.first_call.arguments;
    await expect(callTurnBroker(broker.socketPath, { method: "safe_complete", token, finalAnswer: "early", taskRevision: 0, taskUpdateProtocol: 1 }))
      .rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
    await callTurnBroker(broker.socketPath, { method: "context_control_return", token, contract: "safe", contextProtocol: CONTEXT_PROTOCOL_VERSION,
      receiptId: reply.contextControlReceipt, sent: true });
    const found = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { method: "context_query", token: args.compaction_token,
      contract: "safe", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "search",
      contextArgs: { context_id: args.context_id, query: "UNIQUE_SAFE_MARKER" } });
    expect(JSON.stringify(found.result)).toContain("UNIQUE_SAFE_MARKER");
    await callTurnBroker(broker.socketPath, { method: "context_return", token: args.compaction_token, contract: "safe",
      credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: found.receiptId, sent: true });
    await callTurnBroker(broker.socketPath, { method: "safe_complete", token, finalAnswer: "same reply checkpoint", taskRevision: 0, taskUpdateProtocol: 1 });
    expect(await settled).toBe("same reply checkpoint");
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const read of [false, true]) test(`retained control exposes an independent bounded entry and allows partial reading=${read}`, async () => {
  const directory = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-context-compact-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(directory));
  // Larger than one ordinary web message. Only a bounded portion is needed by the test model.
  const parsed = input("z ".repeat(550_000) + "UNIQUE_DATABASE_MARKER");
  parsed._compactionRequest = true;
  const ledger = coverage(parsed); ledger.markDelivered("selected");
  const source = new ChatGptTurnSession({ mode: "read-only", browser: Promise.resolve("accepted ordinary answer"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: parsed, conversationKey: "retained-context", compactionSourceCoverage: ledger, cancel() {} });
  let entry: { first_call: { arguments: { compaction_token: string; context_id: string } } } | undefined;
  try {
    const worker = { run: async (turn: BrowserTurn) => {
      const prepared = await turn.prepare();
      expect(prepared.text.length).toBeLessThan(20_000);
      expect(prepared.text).not.toContain("UNIQUE_DATABASE_MARKER");
      entry = JSON.parse(prepared.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
      const credential = entry!.first_call.arguments;
      const control = prepared.text.match(/turn_token (control_\w+)/)![1]!;
      const handoffId = prepared.text.match(/handoff_id (handoff_\w+)/)![1]!;
      await expect(callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token: control, handoffId, summary: "too early" }))
        .rejects.toMatchObject({ code: "CONTEXT_NOT_READY" });
      turn.onSubmitted?.();
      if (read) {
        const reply = await callTurnBroker<ContextPreparedReply>(broker.socketPath, { method: "context_query",
          token: credential.compaction_token, contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION,
          contextMethod: "search", contextArgs: { context_id: credential.context_id, query: "UNIQUE_DATABASE_MARKER" } });
        expect(JSON.stringify(reply.result)).toContain("UNIQUE_DATABASE_MARKER");
        await expect(callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token: control, handoffId, summary: "raced read" }))
          .rejects.toMatchObject({ code: "CONTEXT_BUSY" });
        await callTurnBroker(broker.socketPath, { method: "context_return", token: credential.compaction_token,
          contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, receiptId: reply.receiptId, sent: true });
      }
      await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token: control, handoffId, summary: "supported checkpoint" });
      prepared.release();
      return "";
    } };
    await expect(requestRetainedCompactionHandoff(worker as never, parsed, source, broker, capabilities, "context-test"))
      .resolves.toBe("supported checkpoint");
    expect(source.settledOutcome()).toEqual({ type: "final", answer: "accepted ordinary answer" });
    await expect(callTurnBroker(broker.socketPath, { method: "context_query", token: entry!.first_call.arguments.compaction_token,
      contract: "native", credentialKind: "compaction", contextProtocol: CONTEXT_PROTOCOL_VERSION, contextMethod: "list",
      contextArgs: { context_id: entry!.first_call.arguments.context_id, view: "overview" } })).rejects.toMatchObject({ code: "CONTEXT_RETIRED" });
  } finally { await broker.close(); rmSync(directory, { recursive: true, force: true }); }
});
