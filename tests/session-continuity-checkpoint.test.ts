import { ContinuityRecoveryStore, continuityProcessInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recordRecoveryAppend, recoveryDigest, recoveryIdentity, recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as recoveryRuntime from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { afterEach, expect, spyOn } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { createChatGptWebAdapter as createVerifiedChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { runContextCapabilityVerification } from "../src/adapters/chatgpt-web/context-capability-verification";
import { extractChatGptTurnIdentity, continuityCheckpointSiblingGroup, CONTINUITY_CHECKPOINT_SIBLING_PROOF } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultConfig } from "../src/config";
import * as configuration from "../src/config";
import { COMPACT_PROMPT, decodeCompactionSummary, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { actualCheckpoint, observeCheckpointResponse, checkpointContinuationBody, compactionBody, observeCompactionHandoff } from "../scripts/validate-unified-task-continuity-transitions";
import { createLiveRequestBody } from "../scripts/validate-context-rendering";
import { performanceTest } from "./helpers/performance-test";
import { createSessionContinuityFixtures, recordedCall, taskEnvelope, reverseJsonObjectKeys, codexRoundtrippedOutput } from "./helpers/session-continuity-fixture";

const test = performanceTest(import.meta.path);
const { cleanups, disposeTestFixtures, fixture, httpFixture } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const format of ["encrypted", "readable", "summary-only"] as const) test(`${format} checkpoint replays a completed ordinary answer without resubmission and then resumes new work`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summaryEvent = compactEvents.find(event => event.type === "text_delta");
  if (summaryEvent?.type !== "text_delta") throw new Error("Missing checkpoint answer");
  const marker = format === "readable"
    ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summaryEvent.text}` }
    : { type: "compaction", encrypted_content: encodeCompactionSummary(summaryEvent.text) };
  const resumed = f.request("", "turn-first", [
    ...(format === "summary-only" ? [] : (first._rawBody as { input: unknown[] }).input), marker,
  ]);
  const resumedEvents = await f.run(resumed);
  expect(resumed._continuityHistoryRevision).toBe(1);
  expect(resumedEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(resumedEvents.filter(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual([{ type: "text_delta", text: "Completed response 1.", phase: "final_answer" }]);
  expect(f.submissions).toHaveLength(2);
  const compactReplay = await f.run(compact);
  expect(compactReplay.find(event => event.type === "text_delta")).toEqual(summaryEvent);
  expect(f.submissions).toHaveLength(2);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const next = f.next(resumed, "turn-after-checkpoint");
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.reused).toBe(true);
  expect(f.submissions[2]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[2]!.prompt).not.toContain("Verified checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("First continuity instruction.");
  expect(f.submissions[2]!.prompt).toContain("Next continuity instruction.");
});

for (const format of ["encrypted", "readable", "summary-only"] as const) test(`${format} checkpoint can move across completed foreign history when a clear new instruction follows`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summaryEvent = compactEvents.find(event => event.type === "text_delta");
  if (summaryEvent?.type !== "text_delta") throw new Error("Missing checkpoint answer");
  const marker = format === "readable"
    ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summaryEvent.text}` }
    : { type: "compaction", encrypted_content: encodeCompactionSummary(summaryEvent.text) };
  const moved = f.request("", "turn-after-checkpoint", [
    ...(format === "summary-only" ? [] : (first._rawBody as { input: unknown[] }).input),
    marker,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Foreign tool result." },
    structuredClone(marker),
    { type: "message", role: "user", id: "msg-turn-after-checkpoint", content: "New work after checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-checkpoint" } },
  ]);
  expect((await f.run(moved)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(moved._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.prompt).toContain("New work after checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("Foreign execution record.");
  expect(JSON.stringify(taskEnvelope(f.submissions[2]!.prompt))).not.toContain("Foreign tool result.");
});

for (const manual of [false, true]) for (const reclamation of ["capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation}-reclaimed old ordinary replay stays bound to its stale repeated-summary revision`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const repeatedInstruction = "Repeat the same continuity instruction.";
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const compactSource = async (source: CodexParsedRequest, turnId: string) => {
    if (!manual) {
      const compact = structuredClone(source); compact._compactionRequest = true;
      return f.run(compact);
    }
    const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(source)}`;
    const session = chatGptTurnSessions.find(sourceKey)!;
    const call = session.outstanding()[0]!;
    const compact = f.request("", turnId, [
      ...(source._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
    ]);
    compact._compactionRequest = true;
    return f.run(compact);
  };
  const first = f.request(repeatedInstruction);
  await f.run(first);
  const firstCompactEvents = await compactSource(first, "turn-first");
  const firstSummary = firstCompactEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (firstSummary?.type !== "text_delta") throw new Error("Missing first repeated checkpoint");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(firstSummary.text) };
  const userItem = (turnId: string) => ({
    type: "message", role: "user", id: `msg-${turnId}`, content: repeatedInstruction,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });

  const a = f.request("", "turn-repeat-a", [structuredClone(marker), userItem("turn-repeat-a")]);
  const aEvents = await f.run(a);
  const aAnswer = aEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (aAnswer?.type !== "text_delta") throw new Error("Missing repeated ordinary answer A");
  const namespace = chatGptWebExecutionNamespace(f.provider);
  const aKey = `${namespace}:${chatGptTurnExecutionKey(a)}`;

  const b = f.request("", "turn-repeat-b", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: aAnswer.text }] },
    userItem("turn-repeat-b"),
  ]);
  if (manual) f.controls.invokeSourceTools = true;
  await f.run(b);
  const secondCompactEvents = await compactSource(b, "turn-repeat-b");
  f.controls.invokeSourceTools = false;
  const secondSummary = secondCompactEvents.find(event => event.type === "text_delta" && event.phase === "final_answer");
  if (secondSummary?.type !== "text_delta") throw new Error("Missing second repeated checkpoint");
  expect(secondSummary.text).toBe(firstSummary.text);

  if (reclamation === "capacity") {
    const capacity = chatGptTurnSessions as unknown as { maxEntries: number };
    const originalMaxEntries = capacity.maxEntries;
    capacity.maxEntries = 2;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "capacity-reclamation-probe");
    } finally {
      capacity.maxEntries = originalMaxEntries;
    }
  } else {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  expect(chatGptTurnSessions.find(aKey)).toBeUndefined();
  const submissions = f.submissions.length;

  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.ordinaryReplayTombstones.get(aKey)).toMatchObject({ revision: 1 });

  await expect(f.run(a)).rejects.toMatchObject({ status: 409, code: "continuity_source_unproven", retryable: false });
  expect(f.submissions).toHaveLength(submissions);

  const current = f.request("", "turn-current-revision", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(secondSummary.text) },
    { type: "message", role: "user", id: "msg-current-revision", content: "Fresh work on revision 2.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-current-revision" } },
  ]);
  expect((await f.run(current)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
});

test("a new instruction immediately after a checkpoint sends only its increment and supports a second same-page checkpoint", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const firstEvents = await f.run(compact);
  const summary = firstEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing first checkpoint");
  const next = f.request("", "turn-new", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-new", content: "New task after checkpoint.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-new" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions[2]!.prompt).toContain("New task after checkpoint.");
  expect(f.submissions[2]!.prompt).not.toContain("Verified checkpoint.");
  f.controls.handoffSummary = "Second verified checkpoint.";
  const secondCompact = structuredClone(next); secondCompact._compactionRequest = true;
  expect((await f.run(secondCompact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(4);
  expect(new Set(f.submissions.map(item => item.key)).size).toBe(1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} repeated-summary checkpoint-only transition follows the second active source`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const compactActive = async (ordinary: CodexParsedRequest, turnId: string) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", turnId, [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "The completed original result." },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
    return summary.text;
  };
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const firstSummary = await compactActive(first, "turn-first");
  const secondInstruction = { type: "message", role: "user", id: "msg-second-source", content: "First continuity instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-second" } };
  const second = f.request("", "turn-second", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(firstSummary) },
    secondInstruction,
  ]);
  expect((await f.run(second)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const secondSummary = await compactActive(second, "turn-second");
  expect(secondSummary).toBe(firstSummary);
  f.controls.invokeSourceTools = false;
  const continued = f.request("", "turn-second", [
    secondInstruction,
    { type: "compaction", encrypted_content: encodeCompactionSummary(secondSummary) },
  ]);
  expect((await f.run(continued)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.revision).toBe(2);
  expect(continued._continuityHistoryRevision).toBe(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same-turn identical source text and summary select the explicitly retained source`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const compactActive = async (ordinary: CodexParsedRequest) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", "turn-first", [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output: "Accepted exact source result." },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing committed checkpoint");
    return { compact, summary: summary.text };
  };
  const a = f.request();
  await f.run(a);
  const first = await compactActive(a);
  const bItem = { type: "message", role: "user", id: "same-turn-source-b", content: "First continuity instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const b = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
    ...(a._rawBody as { input: unknown[] }).input, bItem,
  ]);
  await f.run(b);
  const second = await compactActive(b);
  expect(second.summary).toBe(first.summary);
  f.controls.invokeSourceTools = false;
  const continued = f.request("", "turn-first", [bItem,
    { type: "compaction", encrypted_content: encodeCompactionSummary(second.summary) },
  ]);
  bindContinuityRequestScope(continued, chatGptWebExecutionNamespace(f.provider));
  expect(recoverCompactionInstruction(continued, extractChatGptTurnIdentity(continued))?.source.itemId).toBe(bItem.id);
  const before = f.submissions.length;
  const [accepted, concurrentRetry] = await Promise.all([f.run(continued), f.run(structuredClone(continued))]);
  expect(concurrentRetry).toEqual(accepted);
  expect(continued._continuityHistoryRevision).toBe(2);
  expect(await f.run(structuredClone(continued))).toEqual(accepted);
  expect(f.submissions).toHaveLength(before + 1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.checkpoints.size).toBe(2);
  expect([...binding.checkpoints.values()].find(checkpoint => checkpoint.revision === 2)?.continuationExecutionKey)
    .toBe(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(continued)}`);
  expect(await f.run(structuredClone(first.compact))).toEqual(await f.run(first.compact));
  const stale = f.request("", "turn-first", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const ambiguous = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(first.summary) },
  ]);
  await expect(f.run(ambiguous)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(before + 1);
  const next = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(second.summary) }, bItem,
    { type: "message", role: "user", id: "same-turn-current-c", content: "Distinct work after both checkpoints.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next._continuityHistoryRevision).toBe(2);
  expect(f.submissions).toHaveLength(before + 2);
});

test("real Codex captured active and completed checkpoint-only requests reuse product commits with a fake page", async () => {
  // This replays real client request structure. Launcher, ChatGPT, and Native execution use the fixture.
  const captured = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol-active.json"), "utf8")) as {
    captured: Array<{ label: string; replay?: boolean; body: { input: Array<Record<string, unknown>>; client_metadata: Record<string, string> };
      response: { output: Array<{ type: string; encrypted_content?: string }> } }>;
  };
  const f = fixture();
  const checkpointContents = new Map<string, string>();
  const load = (record: typeof captured.captured[number]) => {
    const body = structuredClone(record.body);
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]!);
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ ...metadata, thread_id: f.threadId });
    for (const item of body.input) if (typeof item.encrypted_content === "string" && checkpointContents.has(item.encrypted_content)) {
      item.encrypted_content = checkpointContents.get(item.encrypted_content)!;
    }
    const parsed = parseRequest({ ...body, model: "gpt-5.6-sol", stream: false });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const ordinary = captured.captured.find(record => record.label === "ordinary" && !record.replay)!;
  const activeCompact = captured.captured.find(record => record.label === "active-compact")!;
  const activeContinuation = captured.captured.find(record => record.label === "ordinary"
    && record.body.input.some(item => item.type === "compaction"))!;
  f.controls.invokeSourceTools = true;
  f.controls.sourceArguments = JSON.parse(activeCompact.body.input.find(item => item.type === "function_call")!.arguments as string);
  const first = load(ordinary);
  const initial = await f.run(first);
  expect(initial.at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(await f.run(load(ordinary))).toEqual(initial);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = load(activeCompact);
  const raw = compact._rawBody as { input: Array<Record<string, unknown>> };
  const callId = source.outstanding()[0]!.callId;
  for (const item of raw.input) if (item.call_id) item.call_id = callId;
  // Reparse after mapping the fake capture's call ID to the local product Broker call.
  const localCompact = parseRequest({ ...compact._rawBody as object, model: compact.modelId });
  localCompact._conversationPolicy = "task";
  f.controls.handoffSummary = decodeCompactionSummary(activeCompact.response.output[0]!.encrypted_content!)!;
  const activeSummary = await f.run(localCompact);
  expect(activeSummary.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const activeSummaryText = activeSummary.find(event => event.type === "text_delta");
  if (activeSummaryText?.type !== "text_delta") throw new Error("Missing product checkpoint");
  // The product adds its existing latest-user codec appendix; use that committed encoding.
  checkpointContents.set(activeCompact.response.output[0]!.encrypted_content!, encodeCompactionSummary(activeSummaryText.text));
  f.controls.invokeSourceTools = false;
  const continued = load(activeContinuation);
  const activeResult = await f.run(continued);
  expect(activeResult.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(load(activeContinuation))).toEqual(activeResult);
  expect(f.submissions.at(-1)!.prompt).toContain("SYSTEM_MARKER");
  expect(f.submissions.at(-1)!.prompt).toContain("DEVELOPER_MARKER");
  expect(f.submissions.at(-1)!.prompt).toContain("# AGENTS.md instructions");
  expect(f.submissions.at(-1)!.prompt).not.toContain("ORDINARY_MARKER");
  const next = load(captured.captured.find(record => record.label === "new-turn")!);
  const nextResult = await f.run(next);
  const completedCompact = captured.captured.find(record => record.label === "compact")!;
  f.controls.handoffSummary = decodeCompactionSummary(completedCompact.response.output[0]!.encrypted_content!)!;
  const completedSummary = await f.run(load(completedCompact));
  expect(completedSummary.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const completedSummaryText = completedSummary.find(event => event.type === "text_delta");
  if (completedSummaryText?.type !== "text_delta") throw new Error("Missing completed product checkpoint");
  checkpointContents.set(completedCompact.response.output[0]!.encrypted_content!, encodeCompactionSummary(completedSummaryText.text));
  const before = f.submissions.length;
  const checkpointOnly = captured.captured.find(record => record.label === "checkpoint-only")!;
  const finalReplay = await f.run(load(checkpointOnly));
  expect(finalReplay.filter(event => event.type === "text_delta")).toEqual(nextResult.filter(event => event.type === "text_delta"));
  expect(await f.run(load(checkpointOnly))).toEqual(finalReplay);
  expect(f.submissions).toHaveLength(before);
  expect(f.controls.toolResults).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.revision).toBe(2);
  expect(binding.checkpoints.size).toBe(2);
});

test("Automatic repeated-summary continuation replays the old result round for the same native instruction", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const compactCurrent = async (ordinary: CodexParsedRequest, output: string) => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(ordinary)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", "turn-first", [
      ...(ordinary._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    compact._compactionRequest = true;
    const events = await f.run(compact);
    const summary = events.find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    return summary.text;
  };
  const summary = await compactCurrent(first, "Original source result.");
  const continuation = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }]);
  await f.run(continuation);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(continuation)}`)!;
  const call = source.outstanding()[0]!;
  const result = f.request("", "turn-first", [
    ...(continuation._rawBody as { input: unknown[] }).input,
    recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Accepted continuation result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const priorBatch = snapshot.lastToolBatchRevision;
  const next = f.run(result);
  while (snapshot.lastToolBatchRevision === priorBatch) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  const accepted = await next;
  expect(await compactCurrent(result, "Next continuation result.")).toBe(summary);
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const retry = structuredClone(result);
  expect(await f.run(retry)).toEqual(accepted);
  expect(retry._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
});

for (const manual of [false, true]) test(`Round 9: first checkpoint transition accepts structured source key order ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const original = { type: "message", role: "user", id: "source-instruction", content: [
    { type: "input_text", text: "Original source instruction." },
    { type: "input_text", text: "Keep the ordered second part." },
  ], internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [original]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [original,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const reordered = reverseJsonObjectKeys(original);
  const submissions = f.submissions.length;
  const accepted = await f.run(f.request("", "turn-first", [marker, reordered]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(f.request("", "turn-first", [marker, original]))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions + 1);
  for (const content of [[...original.content].reverse(), [
    { ...original.content[0], text: "Changed source instruction." }, original.content[1],
  ]]) {
    await expect(f.run(f.request("", "turn-first", [marker, { ...original, content }]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions + 1);
});

for (const manual of [false, true]) for (const parentFirst of [false, true]) test(`Round 9: first checkpoint transition rejects changed source representations ${manual} parent ${parentFirst}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const raw = structuredClone(f.request("Original source content.")._rawBody) as {
    input: Array<Record<string, unknown>>; client_metadata: Record<string, string>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
    request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" });
  const human = raw.input[0]!;
  const parent = { ...human, type: "agent_message", author: "/root", recipient: "/root/child" };
  delete (parent as Record<string, unknown>).role;
  const firstItem = parentFirst ? parent : human;
  const parse = (input: unknown[]) => {
    const parsed = parseRequest({ ...raw, input });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse([firstItem]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([firstItem, recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const submissions = f.submissions.length;
  for (const change of ["role", "content", "turn"] as const) {
    const changed = change === "role" ? parentFirst ? human : parent : change === "content"
      ? { ...firstItem, content: "Changed source content." }
      : { ...firstItem, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } };
    await expect(f.run(parse([changed, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.submissions).toHaveLength(submissions);
  }
  expect((await f.run(parse([firstItem, marker]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
});

for (const manual of [false, true]) for (const field of ["author", "recipient"] as const) test(`Round 9: first checkpoint transition rejects changed parent ${field} ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const raw = structuredClone(f.request("Parent source content.")._rawBody) as { client_metadata: Record<string, string> };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
    request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" });
  const parent = { type: "agent_message", id: "parent-source", author: "/root", recipient: "/root/child",
    content: "Parent source content.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const parse = (input: unknown[]) => {
    const parsed = parseRequest({ ...raw, input });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse([parent]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([parent, recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const submissions = f.submissions.length;
  await expect(f.run(parse([{ ...parent, [field]: "/root/other" }, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(parse([parent, marker]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
});

for (const manual of [false, true]) for (const retainSource of [false, true]) test(`Round 9: checkpoint-only grouped instructions preserve source payload ${manual} retained ${retainSource}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request("Original source work.");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const sourceInput = (first._rawBody as { input: unknown[] }).input;
  const compact = f.request("", "turn-first", [...sourceInput,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const group = { type: "message", role: "user", id: "current-native-preamble", content: [
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Current checkpoint constraint.</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context><cwd>/tmp</cwd><shell>zsh</shell></environment_context>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const input = [group, ...(retainSource ? sourceInput : []), marker];
  const accepted = await f.run(f.request("", "turn-first", input));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt.match(/Current checkpoint constraint\./g)).toHaveLength(1);
  const submissions = f.submissions.length;
  const environmentChanged = structuredClone(group);
  environmentChanged.content[1]!.text = "<environment_context><cwd>/tmp/changed</cwd><shell>zsh</shell></environment_context>";
  expect(await f.run(f.request("", "turn-first", [environmentChanged, ...input.slice(1)]))).toEqual(accepted);
  const changed = structuredClone(group);
  changed.content[0]!.text = "# AGENTS.md instructions\n<INSTRUCTIONS>Changed checkpoint constraint.</INSTRUCTIONS>";
  await expect(f.run(f.request("", "turn-first", [changed, ...input.slice(1)]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  if (retainSource) {
    const changedSource = { ...(sourceInput[0] as object), content: "Changed source work." };
    await expect(f.run(f.request("", "turn-first", [group, changedSource, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) test(`Round 9: committed compaction replay rejects malformed result groups across echoes ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const prefix = (first._rawBody as { input: unknown[] }).input;
  const result = { type: "function_call_output", call_id: call.callId, output: "Accepted source result." };
  const compact = f.request("", "turn-first", [...prefix, recordedCall(call), result]);
  compact._compactionRequest = true;
  const accepted = await f.run(compact);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  for (const invalid of [result, { ...result, call_id: "unowned-current-result" }, { ...result, type: "custom_tool_call_output" }]) {
    const retry = f.request("", "turn-first", [...prefix, invalid,
      { type: "function_call", call_id: "unowned-call-echo", name: "decorative-name", arguments: "{}" }, result]);
    retry._compactionRequest = true;
    await expect(f.run(retry)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(await f.run(structuredClone(compact))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(delivered);
});

for (const manual of [false, true]) for (const retained of [false, true]) for (const idOnly of [false, true]) test(`Round 10: checkpoint-only continuation ignores completed prefix ${manual} retained ${retained} ID-only ${idOnly}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const oldUser = { type: "message", role: "user", content: "Completed historical request.",
    ...(idOnly ? { id: "historical-display-id" } : {}) };
  const oldAnswer = { type: "message", role: "assistant", content: "Completed historical answer." };
  const sourceItem = { type: "message", role: "user", id: "checkpoint-source", content: "Current source work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const constraint = { type: "message", role: "developer", content: "Keep this current constraint.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const items = [constraint, oldUser, oldAnswer, ...(retained ? [sourceItem] : []), marker];
  const continuation = f.request("", "turn-first", items);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  const accepted = await f.run(continuation);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).toContain("Keep this current constraint.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed historical request.");
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  const changedHistory = f.request("", "turn-first", [constraint, { ...oldUser, content: "Changed old history." },
    oldAnswer, ...(retained ? [sourceItem] : []), marker]);
  expect(await f.run(changedHistory)).toEqual(accepted);
  await expect(f.run(f.request("", "turn-first", [...items, { type: "message", role: "user", content: "Unidentified new task." }])))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  await expect(f.run(f.request("", "turn-first", [{ ...constraint, content: "Changed current constraint." }, ...items.slice(1)])))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  if (retained) {
    for (const changedSource of [{ ...sourceItem, content: "Changed current source." },
      { ...sourceItem, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } },
      { ...sourceItem, role: "assistant" }]) {
      await expect(f.run(f.request("", "turn-first", [constraint, oldUser, oldAnswer, changedSource, marker])))
        .rejects.toMatchObject({ code: "continuity_source_unproven" });
    }
  }
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.controls.toolResults).toHaveLength(delivered);
  expect(f.pages.size).toBe(1);
});

for (const retained of [false, true]) for (const idOnly of [false, true]) test(`Round 10: completed-source checkpoint preserves final with old prefix retained ${retained} ID-only ${idOnly}`, async () => {
  const f = fixture();
  const oldUser = { type: "message", role: "user", content: "Completed historical request.",
    ...(idOnly ? { id: "historical-display-id" } : {}) };
  const oldAnswer = { type: "message", role: "assistant", content: "Completed historical answer." };
  const sourceItem = { type: "message", role: "user", id: "completed-checkpoint-source", content: "Current source work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const first = f.request("", "turn-first", [oldUser, oldAnswer, sourceItem]);
  const original = await f.run(first);
  const compact = structuredClone(first);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const continuation = f.request("", "turn-first", [oldUser, oldAnswer, ...(retained ? [sourceItem] : []), marker]);
  const submissions = f.submissions.length;
  const accepted = await f.run(continuation);
  expect(accepted.filter(event => event.type === "text_delta")).toEqual(original.filter(event => event.type === "text_delta"));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.pages.size).toBe(1);
});

async function verifiedManualHttpFixture(taskUpdates = false) {
  const f = fixture(true, { taskUpdates });
  const config = { ...defaultConfig("full"), browserHost: "launcher" as const,
    browserInteractionMode: "manual" as const, appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME, solAvailable: false, toolAuthorityMode: "delegated" as const,
    browserHostDescriptorPath: f.descriptorPath, brokerSocketPath: f.provider.chatgptWeb!.brokerSocketPath!,
    runtimeCommand: [process.execPath, resolve("src/cli.ts")], zeroRiskRequireSentConfirmation: true };
  config.manualTunnel = { binaryPath: "/fixed/local-verification-client", tunnelId: `tunnel_${"a".repeat(32)}`,
    runtimeKeyFile: "/private/local-test-key", profileDir: join(f.root, "manual"), profileName: "manual", alias: "manual" };
  config.tunnel = config.manualTunnel;
  f.provider.chatgptWeb!.threadEnvironmentStatePath = join(f.root, "runtime", "thread-environments.json");
  writeFileSync(join(f.root, "config.json"), JSON.stringify(config));
  await f.broker.listen();
  const client = new Client({ name: "ended-manual-profile-verification", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", config.brokerSocketPath], stderr: "pipe" }));
  let prompt = "";
  try {
    const evidence = await runContextCapabilityVerification(config, { home: f.root, broker: f.broker, timeoutMs: 10_000,
      manualControl: {
        async start(_descriptor, activity) { prompt = activity.prompt; return { tabId: "local-verification", reused: false,
          deadlineAt: null, state: "awaiting-user", sentConfirmationRequired: true }; },
        async waitSent() {
          const start = /First call codex_turn_start with (\{.*?\})\./.exec(prompt)!;
          expect((await client.callTool({ name: "codex_turn_start", arguments: JSON.parse(start[1]!) })).isError).not.toBe(true);
          return { sentAt: new Date().toISOString() };
        },
        async started() {
          for (const line of prompt.split("\n").filter(line => line.startsWith("Call "))) {
            const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(line)!;
            expect((await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) })).isError).not.toBe(true);
          }
        },
        waitTerminal(_descriptor, _owner, options) { return new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener("abort", () => reject(new Error("Local verification scope closed")), { once: true });
        }); },
        async end() { return { cancelledByUser: false }; },
      } });
    expect(evidence.receipts.ordinary.text_read).toBeDefined();
    expect(evidence.receipts.compaction.text_read).toBeDefined();
  } finally { await client.close(); }
  const body = { ...(f.request()._rawBody as Record<string, unknown>), model: "chatgpt-web/zero-risk", stream: false,
    input: (f.request()._rawBody as { input: unknown[] }).input };
  const send = (value: unknown, compact = false) => {
    const request = new Request(`http://127.0.0.1/v1/responses${compact ? "/compact" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const factory = () => createVerifiedChatGptWebAdapter(f.provider, { broker: f.broker, zeroRiskManualControl: f.manualControl });
    return compact ? compactRequest(request, config, factory) : responseRequest(request, config, factory);
  };
  return { ...f, config, body, send };
}

test("public ended ZeroRisk compact waits for a new manual Sent and keeps the ordinary final", async () => {
  const f = await verifiedManualHttpFixture();
  const ordinary = await f.send(f.body);
  expect(ordinary.status).toBe(200);
  const originalAnswer = await ordinary.json();
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const source = Object.values(store.get(thread)!.works).find(work => work.purpose === "ordinary")!;
  let releaseSent!: () => void;
  const sent = new Promise<void>(resolveSent => { releaseSent = resolveSent; });
  const originalWaitSent = f.manualControl.waitSent;
  f.manualControl.waitSent = async (...args) => { await sent; return originalWaitSent(...args); };
  f.controls.started = false;
  const pending = f.send(f.body, true);
  let concurrent: Promise<Response> | undefined;
  let settled = false; void pending.finally(() => { settled = true; });
  for (let i = 0; i < 500 && f.submissions.length < 2 && !settled; i++) await Bun.sleep(2);
  try {
    expect(settled).toBe(false);
    expect(f.submissions).toHaveLength(2);
    expect(f.controls.started).toBe(false);
    const before = store.get(thread)!;
    const work = Object.values(before.works).find(work => work.purpose === "compaction")!;
    expect(work).toBeDefined();
    expect(work.attempts).toHaveLength(1);
    expect(work.attempts[0]!.stage).toBe("send-possible");
    expect(work.logicalWorkId).not.toBe(source.logicalWorkId);
    expect(before.works[source.logicalWorkId]!.terminalReceiptId).toBe(source.terminalReceiptId);
    expect(Object.values(before.checkpoints)).toHaveLength(0);
    expect(f.controls.toolResults).toHaveLength(0);
    expect(f.submissions[1]!.prompt).toContain("codex_context_read");
    expect(f.submissions[1]!.prompt).toContain("Stop business work");
    expect(f.submissions[1]!.claim.expected).toBeUndefined();
    expect(f.submissions[1]!.claim.recovery!.logicalWorkId).toBe(work.logicalWorkId);
    concurrent = f.send(f.body, true);
    await Bun.sleep(10);
    expect(f.submissions).toHaveLength(2);
    const attached = store.get(thread)!.works[work.logicalWorkId]!;
    expect(attached.attempts).toEqual(work.attempts);
    expect(attached.retryBudget).toEqual(work.retryBudget);
  } finally { releaseSent(); }
  const compact = await pending;
  expect(compact.status).toBe(200);
  const compactAnswer = await compact.json();
  expect((await concurrent!).status).toBe(200);
  expect(compactAnswer.output.at(-1)).toMatchObject({ type: "message", role: "user" });
  expect(compactAnswer.output.at(-1).content[0].text).toStartWith(SUMMARY_PREFIX);
  const after = store.get(thread)!;
  expect(Object.values(after.checkpoints)).toHaveLength(1);
  expect(after.works[source.logicalWorkId]!.terminalReceiptId).toBe(source.terminalReceiptId);
  expect(after.works[source.logicalWorkId]!.terminalDigest).toBe(source.terminalDigest);
  expect((await f.send(f.body)).status).toBe(200);
  const ordinaryReplay = await (await f.send(f.body)).json();
  const outputWithoutIds = (output: Array<Record<string, unknown>>) => output.map(({ id: _id, ...item }) => item);
  expect(outputWithoutIds(ordinaryReplay.output)).toEqual(outputWithoutIds(originalAnswer.output));
  expect(await (await f.send(f.body, true)).json()).toMatchObject({ output: compactAnswer.output });
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.toolResults).toHaveLength(0);
}, 30_000);

for (const format of ["local", "v2"] as const) test(`public ended ZeroRisk ${format} compact reads its accepted tool source without issuing business work`, async () => {
  const f = await verifiedManualHttpFixture(format === "local");
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true;
  const opening = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = opening.output.find(item => item.type === "function_call")!;
  expect(call).toBeDefined();
  const tail = "MANUAL_COMPACTION_SOURCE_TAIL_59B7";
  const result = { type: "function_call_output", call_id: call.call_id, output: "Accepted source record.\n".repeat(4_000) + tail };
  const acceptedBody = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(opening.output), result] };
  const ordinaryFinal = await (await f.send(acceptedBody)).json();
  expect(ordinaryFinal.status).toBe("completed");
  expect(f.controls.toolResults).toHaveLength(1);
  f.controls.invokeSourceTools = false;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const original = store.get(thread)!, source = original.works[original.currentWorkId!]!;
  const compactBody = format === "local" ? { ...acceptedBody, input: [...acceptedBody.input,
    { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
      request_kind: "compaction", compaction: { implementation: "responses", phase: "standalone_turn", strategy: "memento" } }) } }
    : { ...acceptedBody, input: [...acceptedBody.input, { type: "compaction_trigger" }] };
  const client = new Client({ name: "ended-manual-source-reader", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
  let successfulReads = 0;
  let readStep = "awaiting start";
  f.manualControl.markStarted = async () => {
    readStep = "list";
    const prompt = f.submissions.at(-1)!.prompt;
    const sourceInstruction = (taskEnvelope(prompt) as { messages: Array<{ content: string }> }).messages[0]!.content;
    const entry = JSON.parse(/<codex_context_navigation_json>\n([^\n]+)/.exec(sourceInstruction)![1]!);
    expect((await client.callTool(entry.first_call)).isError).not.toBe(true);
    readStep = "search";
    const credential = { compaction_token: entry.first_call.arguments.compaction_token, context_id: entry.context_id };
    const search = await client.callTool({ name: "codex_context_search", arguments: { ...credential, query: tail } });
    expect(search.isError).not.toBe(true);
    readStep = "read";
    const match = (search.structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> }).hits[0]!;
    const read = await client.callTool({ name: "codex_context_read", arguments: { ...credential,
      read_ref: match.read_ref, cursor: match.read_cursor } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.content)).toContain(tail); successfulReads++;
    readStep = "complete";
    expect((await client.callTool({ name: "codex_turn_complete", arguments: { request_id: f.controls.safeToken,
      task_revision: 0, final_answer: `Checkpoint preserves accepted source ${tail}.` } })).isError).not.toBe(true);
    readStep = "completed";
  };
  try {
    const response = await f.send(compactBody);
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.status, JSON.stringify({ error: body.error, readStep })).toBe("completed");
    expect(successfulReads).toBe(1);
    const after = store.get(thread)!;
    const checkpoint = Object.values(after.checkpoints)[0]!;
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    expect(checkpoint.coveredCallIds).toEqual([call.call_id as string]);
    expect(checkpoint.ordinaryFinalReceiptId).toBe(source.terminalReceiptId);
    expect(checkpoint.acceptedTaskRevision).toBe(source.acceptedTaskRevision);
    expect(after.works[source.logicalWorkId]!.taskUpdateJournal).toEqual(source.taskUpdateJournal);
    expect(after.calls[String(call.call_id)]!.firstResultDigest).toBe(recoveryResultDigest(result));
    expect(after.calls).toEqual(original.calls);
    expect(after.works[source.logicalWorkId]!.terminalDigest).toBe(source.terminalDigest);
    const replay = await (await f.send(compactBody)).json();
    expect(replay.status).toBe("completed"); expect(successfulReads).toBe(1);
    expect(f.submissions).toHaveLength(2); expect(f.controls.toolResults).toHaveLength(1);
  } finally { await client.close(); }
}, 30_000);

test("public ended ZeroRisk compact uses a fresh target after an unsent acquisition loses its page", async () => {
  const f = await verifiedManualHttpFixture();
  expect((await f.send(f.body)).status).toBe(200);
  f.controls.preLeaseFailures = 1;
  const rejected = await f.send(f.body, true);
  expect(rejected.status).not.toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!, work = Object.values(before.works).find(value => value.purpose === "compaction")!;
  expect(work.attempts).toHaveLength(1);
  expect(work.attempts[0]).toMatchObject({ stage: "prepared", writerRetired: false, acquisitionEvidence: { status: "not-acquired" } });
  expect(Object.values(before.checkpoints)).toHaveLength(0);
  let release!: () => void; const sent = new Promise<void>(resolveSent => { release = resolveSent; });
  const waitSent = f.manualControl.waitSent;
  f.manualControl.waitSent = async (...args) => { await sent; return waitSent(...args); };
  const pending = f.send(f.body, true);
  for (let i = 0; i < 500 && f.submissions.length < 2; i++) await Bun.sleep(2);
  try {
    const current = store.get(thread)!;
    const retry = Object.values(current.works).find(value => value.purpose === "compaction")!;
    expect(current.epoch).not.toBe(before.epoch);
    expect(current.works[work.logicalWorkId]).toBeUndefined();
    expect(retry.attempts).toHaveLength(1);
    expect(retry.attempts[0]!.attempt).toBe(0);
    expect(retry.compactionTargetId).not.toBe(work.compactionTargetId);
    expect(current.calls).toEqual({});
  } finally { release(); }
  expect((await pending).status).toBe(200);
  expect(Object.values(store.get(thread)!.checkpoints)).toHaveLength(1);
  expect(f.submissions).toHaveLength(2);
}, 30_000);

for (const boundary of ["unknown-send", "stopped", "changed-source", "missing-verification"] as const) test(`public ended ZeroRisk compact validates ${boundary} against the actual page`, async () => {
  const f = await verifiedManualHttpFixture();
  expect((await f.send(f.body)).status).toBe(200);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  let compactBody: unknown = f.body;
  if (boundary === "unknown-send") {
    f.controls.unknownPreLeaseFailures = 1;
    expect((await f.send(f.body, true)).status).not.toBe(200);
  } else if (boundary === "stopped") {
    f.controls.preLeaseFailures = 1;
    expect((await f.send(f.body, true)).status).not.toBe(200);
    const current = store.get(thread)!;
    store.stopWork(thread, { scope: current.scope }, current.currentWorkId!, "user-stop");
  } else if (boundary === "changed-source") {
    compactBody = { ...f.body, input: [{ ...f.body.input[0] as Record<string, unknown>, content: "Conflicting current source instruction." }] };
  } else rmSync(configuration.getContextCapabilityEvidencePath(f.root));
  const before = store.get(thread)!;
  const response = await f.send(compactBody, true), body = await response.json();
  if (boundary === "unknown-send" || boundary === "stopped") {
    expect(response.status, JSON.stringify(body.error)).toBe(200);
    expect(body.output[0].type).toBe("message");
    expect(body.output.at(-1).content[0].text).toContain(SUMMARY_PREFIX);
    expect(body.output.at(-1).content[0].text).toContain("Completed response 2.");
    const after = store.get(thread)!;
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.works[before.currentWorkId!]).toBeUndefined();
    expect(after.calls).toEqual({});
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } else {
    expect(response.status).not.toBe(200);
    expect(body.error.code).toBe(boundary === "changed-source" ? "continuity_source_unproven" : "upstream_server_error");
    if (boundary === "missing-verification") expect(body.error.message).toContain("not verified");
    const after = store.get(thread)!;
    expect(after.epoch).toBe(before.epoch);
    expect(after.calls).toEqual(before.calls);
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.works[before.currentWorkId!]).toEqual(before.works[before.currentWorkId!]);
    expect(f.submissions).toHaveLength(1);
  }
  expect(f.controls.toolResults).toHaveLength(0);
}, 30_000);

async function firstLossNativeCompactionFixture() {
  const f = httpFixture(false, true);
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  const opening = await (await f.send(f.body)).json() as {
    status: string; end_turn: boolean; output: Array<Record<string, unknown>>;
  };
  expect(opening.status).toBe("completed");
  expect(opening.end_turn).toBe(false);
  const call = opening.output.find(item => item.type === "function_call")!;
  expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id,
    output: "The actual outer return of the issued fixture gate." };
  const metadata = JSON.parse((f.body.client_metadata as Record<string, string>)["x-codex-turn-metadata"]!);
  const compactBody = { ...structuredClone(f.body),
    client_metadata: { ...f.body.client_metadata as Record<string, string>,
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "compaction",
        compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" } }) },
    input: [...structuredClone(f.body.input), ...codexRoundtrippedOutput(opening.output), result,
      { type: "message", role: "user", content: COMPACT_PROMPT }],
  };
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!;
  const store = bindings.recoveryStore, before = store.get(thread)!;
  expect(binding.state).toBe("running");
  expect(before.calls[String(call.call_id)]).toMatchObject({ state: "delivery-possible" });
  expect(before.calls[String(call.call_id)]!.firstResultDigest).toBeUndefined();
  expect(before.works[before.currentWorkId!]!.attempts.at(-1)).toMatchObject({ stage: "accepted", writerRetired: false });
  return { ...f, compactBody, call, result, bindings, thread, binding, store, before };
}

for (const boundary of ["healthy", "lost"] as const) test(`repair12: overlapping ${boundary} preview preserves the current completed compaction`, async () => {
  const f = await firstLossNativeCompactionFixture();
  const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  let entered!: () => void, release!: () => void;
  const previewEntered = new Promise<void>(resolve => { entered = resolve; });
  const heldPreview = new Promise<void>(resolve => { release = resolve; });
  let previews = 0;
  source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (++previews === 1) { entered(); await heldPreview; }
  };
  const pending = f.send(f.compactBody);
  try {
    expect(await Promise.race([previewEntered.then(() => true), pending.then(() => false)])).toBe(true);
    if (boundary === "lost") {
      f.pages.clear();
      expect(recoveryRuntime.settleRecoveryFailure(f.binding.recovery!)).toBe(true);
      f.bindings.lose(f.binding, f.binding.executionKey);
    }
    const completed = await f.send(structuredClone(f.compactBody));
    const completedBody = await completed.json() as any;
    expect(completed.status, JSON.stringify(completedBody.error)).toBe(200);
    expect(completedBody.status).toBe("completed");
    const committed = f.store.get(f.thread)!;
    expect(Object.values(committed.checkpoints)).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
    release();
    const observer = await pending, observerBody = await observer.json() as any;
    expect(f.store.get(f.thread)).toEqual(committed);
    expect(f.submissions).toHaveLength(2);
    if (boundary === "lost") {
      expect(observer.status).toBe(409);
      expect(observerBody.error.code).toBe("continuity_source_unproven");
      expect(committed.works[f.before.currentWorkId!]).toBeUndefined();
      expect(committed.calls).toEqual({});
      return;
    }
    expect(observer.status, JSON.stringify(observerBody.error)).toBe(200);
    expect(observerBody.status).toBe("completed");
    const finalContent = (body: any) => body.output.filter((item: any) => item.phase === "final_answer").map((item: any) => item.content);
    expect(finalContent(observerBody)).toHaveLength(1);
    expect(finalContent(observerBody)).toEqual(finalContent(completedBody));
  } finally { release(); await pending; source.runtime.syncContextUsage = sync; }
}, 30_000);

for (const loss of ["before-preview", "during-preview", "after-usage-wait"] as const) test(`repair12: native compaction creates a fresh context source after loss ${loss}`, async () => {
  const f = await firstLossNativeCompactionFixture();
  const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  let losses = 0;
  const lose = () => {
    losses++;
    f.pages.clear();
    expect(recoveryRuntime.settleRecoveryFailure(f.binding.recovery!)).toBe(true);
    f.bindings.lose(f.binding, f.binding.executionKey);
  };
  if (loss === "before-preview") lose();
  else source.runtime.syncContextUsage = async () => {
    await sync?.call(source.runtime);
    if (loss === "after-usage-wait") queueMicrotask(() => queueMicrotask(lose));
    else lose();
  };
  try {
    const response = await f.send(f.compactBody), body = await response.json() as any;
    expect(response.status, JSON.stringify(body.error)).toBe(200);
    expect(body.status, JSON.stringify(body.error)).toBe("completed");
    const after = f.store.get(f.thread)!;
    expect(losses).toBe(1);
    expect(Object.values(after.compactionTargets)).toHaveLength(1);
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    const compaction = Object.values(after.works).filter(work => work.purpose === "compaction");
    expect(compaction).toHaveLength(1);
    expect(compaction[0]!.attempts).toHaveLength(1);
    expect(after.calls).toEqual({});
    expect(after.works[f.before.currentWorkId!]).toBeUndefined();
    expect(after.epoch).not.toBe(f.before.epoch);
    expect(f.submissions).toHaveLength(2);
    const replay = await f.send(f.compactBody);
    expect(replay.status).toBe(200);
    expect(f.submissions).toHaveLength(2);
    expect(Object.values(f.store.get(f.thread)!.checkpoints)).toHaveLength(1);
  } finally { source.runtime.syncContextUsage = sync; }
}, 30000);

for (const changed of ["stopped", "lease", "source", "durable-owner", "attempt", "binding", "new-work", "missing-recovery"] as const) {
  const unconfirmed = ["lease", "missing-recovery", "durable-owner", "attempt", "binding"].includes(changed);
  test(`repair12: a preview interrupted by ${changed} ${unconfirmed ? "recovers its unconfirmed page from the current request" : "cannot retire or replace that execution"}`, async () => {
    const f = await firstLossNativeCompactionFixture();
    const source = chatGptTurnSessions.find(f.binding.executionKey!)!;
    const sync = source.runtime.syncContextUsage;
    if (changed === "missing-recovery") delete f.binding.lease!.recovery;
    let changedRecord: ReturnType<typeof f.store.get>;
    source.runtime.syncContextUsage = async () => {
      await sync?.call(source.runtime);
      if (changed === "stopped") f.store.stopWork(f.thread, { scope: f.before.scope }, f.before.currentWorkId!, "user-stop");
      if (changed === "lease") f.binding.lease = { ...f.binding.lease!, traceId: "competing-physical-owner" };
      if (changed === "source") f.binding.executionKey = "competing-logical-source";
      if (changed === "durable-owner") f.store.transact(f.thread, { scope: f.before.scope }, record => {
        record.owner = { ...record.owner, id: recoveryDigest("competing-runtime-owner") };
      });
      if (changed === "new-work") {
        const previous = f.before.works[f.before.currentWorkId!]!;
        const journal = previous.taskUpdateJournal;
        const revision = (journal?.acceptedRevision ?? 0) + 1;
        const task = { id: "preview-new-work", content: "A newer accepted instruction." };
        recordRecoveryAppend(f.binding.recovery!, { logicalWorkId: recoveryDigest(task.id), instructionIdentity: task.id,
          nativeTurnId: previous.nativeTurnId!, workPayloadDigest: recoveryDigest(task), snapshotDigest: recoveryDigest(task.content),
          localSessionId: "preview-append-session", localTaskRevision: revision,
          results: [{ callId: String(f.call.call_id), resultType: f.result.type, resultDigest: recoveryResultDigest(f.result) }] },
          journal ? [{ revision, sourceMessageId: task.id, content: task.content, payloadDigest: recoveryDigest(task.content) }] : undefined,
          journal ? journal.driverGeneration + 1 : undefined);
      }
      if (changed === "attempt" || changed === "binding") {
        recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
        let record = f.store.get(f.thread)!;
        const work = record.works[record.currentWorkId!]!;
        record = f.store.retireAttempt(f.thread, { scope: record.scope, expectedVersion: record.version }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
        record = f.store.reserveRecovery(f.thread, { scope: record.scope, expectedVersion: record.version }, {
          logicalWorkId: work.logicalWorkId, owner: record.owner, snapshotDigest: work.attempts.at(-1)!.snapshotDigest });
        if (changed === "binding") f.bindings.installRecovered(record, f.binding.executionKey!, continuityDigest(""), "turn-first");
      } else f.bindings.lose(f.binding, f.binding.executionKey);
      changedRecord = f.store.get(f.thread);
    };
    try {
      const response = await f.send(f.compactBody), body = await response.json() as any;
      if (unconfirmed) {
        expect(response.status, JSON.stringify(body.error)).toBe(200);
        expect(body.status).toBe("completed");
        const after = f.store.get(f.thread)!;
        expect(after.epoch).not.toBe(f.before.epoch);
        if (changedRecord) expect(after.epoch).not.toBe(changedRecord.epoch);
        expect(after.works[f.before.currentWorkId!]).toBeUndefined();
        expect(after.calls).toEqual({});
        expect(Object.values(after.checkpoints)).toHaveLength(1);
        expect(f.submissions).toHaveLength(2);
        return;
      }
      expect(changedRecord).toBeDefined();
      expect(response.status).toBe(409);
      expect(body.error.code).toBe(changed === "stopped" ? "continuity_stopped" : "continuity_source_unproven");
      expect(f.store.get(f.thread)).toEqual(changedRecord!);
      expect(f.submissions).toHaveLength(1);
      expect(Object.values(changedRecord!.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
      expect(Object.values(changedRecord!.checkpoints)).toHaveLength(0);
    } finally { source.runtime.syncContextUsage = sync; }
  }, 30000);
}

test("native compaction lifecycle: the current native memento after page loss creates a new generation and commits once", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear(); // The old tool call remains context and has no dispatch authority in the new page.
  const response = await f.send(f.compactBody), envelope = await response.json();
  const after = f.store.get(f.thread)!;
  console.log(JSON.stringify({ case: "repair9-first-native-memento", httpStatus: response.status,
    outcome: envelope.status ?? "rejected", code: envelope.error?.code,
    fixtureBrowserRuns: f.submissions.length, targets: Object.keys(after.compactionTargets).length,
    compactionWorks: Object.values(after.works).filter(work => work.purpose === "compaction").length,
    checkpoints: Object.keys(after.checkpoints).length }));
  expect(response.status).toBe(200);
  expect(envelope.status).toBe("completed");
  const finals = envelope.output.filter((item: { type: string; phase?: string }) => item.type === "message" && item.phase === "final_answer");
  expect(finals).toHaveLength(1);
  expect(finals[0]).toMatchObject({ type: "message", role: "assistant" });
  expect(finals[0].content[0].text).toContain(f.controls.handoffSummary);
  const structurePath = join(f.root, "checkpoint-response-structure.json");
  const checkpointResponse = actualCheckpoint(observeCheckpointResponse(envelope, structure => {
    writeFileSync(structurePath, JSON.stringify(structure));
  }));
  const structure = JSON.parse(readFileSync(structurePath, "utf8"));
  expect(structure.outputCount).toBe(envelope.output.length);
  expect(structure.items.find((item: { phase: string }) => item.phase === "final_answer").canonicalTextDigest)
    .toBe(Object.values(after.checkpoints)[0]!.summaryDigest);
  expect(readFileSync(structurePath, "utf8")).not.toContain(f.controls.handoffSummary);
  expect(readFileSync(structurePath, "utf8")).not.toContain(f.controls.sourceToken);
  expect(checkpointResponse.format).toBe("native-text");
  expect(checkpointResponse.summary).toBe(finals[0].content.map((part: { text: string }) => part.text).join(""));
  expect(Object.values(after.checkpoints)[0]!.summaryDigest).toBe(continuityDigest(checkpointResponse.summary));
  expect(after.calls).toEqual({});
  expect(after.epoch).not.toBe(f.before.epoch);
  expect(after.works[f.before.currentWorkId!]).toBeUndefined();
  const targets = Object.values(after.compactionTargets), checkpoints = Object.values(after.checkpoints);
  const compactions = Object.values(after.works).filter(work => work.purpose === "compaction");
  expect(targets).toHaveLength(1); expect(compactions).toHaveLength(1); expect(checkpoints).toHaveLength(1);
  expect(targets[0]!.sourceLogicalWorkId).not.toBe(f.before.currentWorkId);
  expect(targets[0]).toMatchObject({ sourceToolBatchHeadSequence: 0, sourceHistoryRevision: 0 });
  expect(checkpoints[0]).toMatchObject({ compactionTargetId: targets[0]!.compactionTargetId,
    coveredCallIds: [] });
  expect(compactions[0]).toMatchObject({ state: "completed", compactionTargetId: targets[0]!.compactionTargetId });
  expect(compactions[0]!.attempts).toHaveLength(1);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.claim.expected).toBeUndefined();
  expect(f.automatic.mock.calls[1]![0]).toMatchObject({ compaction: true, nativeConnector: true,
    capabilities: { localToolsEnabled: false } });
  const replay = await (await f.send(f.compactBody)).json();
  const withoutIds = (items: Array<Record<string, unknown>>) => items.map(({ id: _id, ...item }) => item);
  expect(withoutIds(replay.output.filter((item: { phase?: string }) => item.phase === "final_answer"))).toEqual(withoutIds(finals));
  expect(f.store.get(f.thread)!.checkpoints).toEqual(after.checkpoints);
  expect(f.submissions).toHaveLength(2);
}, 30_000);

function firstLossInspection(f: ReturnType<typeof httpFixture>, observe: () => void | Promise<void>) {
  const fetch = globalThis.fetch;
  let observed = false;
  return spyOn(globalThis, "fetch").mockImplementation((async (...args: Parameters<typeof fetch>) => {
    if (!observed && String(args[0]) === `${f.descriptor.control.endpoint}/v1/turn/continuity`) {
      observed = true;
      await observe();
    }
    return fetch(...args);
  }) as typeof globalThis.fetch);
}

test("native compaction lifecycle: concurrent first-loss native memento requests share the original target, deadline and checkpoint", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolveEntered => { started = resolveEntered; });
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier; });
  const run = f.automatic.getMockImplementation()!;
  f.automatic.mockImplementation(async turn => {
    if (turn.nativeConnector) { started(); await barrier; }
    return run(turn);
  });
  const first = f.send(f.compactBody);
  const raced = await Promise.race([entered.then(() => true), first.then(() => false)]);
  expect(raced).toBe(true);
  const admitted = f.store.get(f.thread)!;
  const work = Object.values(admitted.works).find(value => value.purpose === "compaction")!;
  const target = Object.values(admitted.compactionTargets)[0]!;
  expect(work.attempts).toHaveLength(1);
  expect(work.retryBudget!.attempts).toBe(1);
  expect(work.retryBudget!.deadlineAt).toBeNumber();
  expect(work.retryBudget!.startedAt).toBeNumber();
  expect(work.retryBudget!.deadlineAt).toBeGreaterThan(work.retryBudget!.startedAt);
  let observedSecond!: () => void;
  const secondObserved = new Promise<void>(resolveObserved => { observedSecond = resolveObserved; });
  const get = ContinuityRecoveryStore.prototype.get;
  const observation = spyOn(ContinuityRecoveryStore.prototype, "get").mockImplementation(function (this: ContinuityRecoveryStore, thread) {
    const record = get.call(this, thread);
    if (thread === f.thread && record?.currentWorkId === work.logicalWorkId) observedSecond();
    return record;
  });
  const second = f.send(f.compactBody);
  try {
    expect(await Promise.race([secondObserved.then(() => true), second.then(() => false)])).toBe(true);
    const attached = f.store.get(f.thread)!;
    expect(attached.works[work.logicalWorkId]!.attempts).toEqual(work.attempts);
    expect(attached.works[work.logicalWorkId]!.retryBudget).toEqual(work.retryBudget);
    expect(Object.values(attached.compactionTargets)).toEqual([target]);
    expect(Object.values(attached.checkpoints)).toHaveLength(0);
    expect(f.submissions).toHaveLength(1);
  } finally { observation.mockRestore(); release(); }
  for (const response of await Promise.all([first, second])) {
    expect(response.status).toBe(200); expect((await response.json()).status).toBe("completed");
  }
  const completed = f.store.get(f.thread)!;
  const { representationDigests, ...targetIdentity } = target;
  expect(Object.values(completed.compactionTargets)).toHaveLength(1);
  expect(Object.values(completed.compactionTargets)[0]).toMatchObject(targetIdentity);
  expect(Object.values(completed.compactionTargets)[0]!.representationDigests).toEqual(expect.arrayContaining(representationDigests));
  expect(Object.values(completed.checkpoints)).toHaveLength(1);
  expect(completed.works[work.logicalWorkId]!.attempts).toHaveLength(1);
  expect(completed.works[work.logicalWorkId]!.retryBudget).toBeUndefined();
  expect(f.submissions).toHaveLength(2);
}, 30_000);

for (const boundary of ["missing-result", "conflicting-result", "stopped", "abort"] as const) {
  test(`native compaction lifecycle: a live page preserves the ${boundary} barrier`, async () => {
    const f = await firstLossNativeCompactionFixture();
    const controller = new AbortController();
    if (boundary === "missing-result") f.compactBody.input = f.compactBody.input.filter(item => item !== f.result);
    if (boundary === "conflicting-result") {
      recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
      f.result.output = "Conflicting outer return.";
    }

    const inspection = firstLossInspection(f, () => {
      if (boundary === "stopped") {
        const current = f.store.get(f.thread)!;
        f.store.stopWork(f.thread, { scope: current.scope }, current.currentWorkId!, "user-stop");
      }
      if (boundary === "abort") controller.abort();
    });
    try {
      const response = await f.send(f.compactBody, false, false, controller.signal), body = await response.json();
      expect(response.status).not.toBe(200);
      if (boundary !== "abort") expect(body.error.code).toBe(boundary === "missing-result"
        ? "continuity_source_unproven" : boundary === "conflicting-result" ? "continuity_result_conflict"
          : boundary === "stopped" ? "continuity_stopped" : "continuity_unverified");
      const after = f.store.get(f.thread)!;
      expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(0);
      expect(Object.values(after.checkpoints)).toHaveLength(0);
      expect(after.epoch).toBe(f.before.epoch);
      expect(f.submissions).toHaveLength(1);
      if (boundary === "stopped") expect(after.works[f.before.currentWorkId!]!).toMatchObject({ state: "stopped", stopReason: "user-stop" });
      if (boundary === "conflicting-result") expect(after.calls[String(f.call.call_id)]!.firstResultDigest)
        .toBe(recoveryResultDigest({ ...f.result, output: "The actual outer return of the issued fixture gate." }));
    } finally { inspection.mockRestore(); }
  }, 30_000);
}

for (const replaceBinding of [true, false]) test(`native compaction lifecycle: exact cleanup cannot retire a competing prepared attempt (bindingReplaced=${replaceBinding})`, async () => {
  const f = await firstLossNativeCompactionFixture();
  const oldIdentity = recoveryIdentity(f.before, f.store.installationId());
  recoveryRuntime.acceptRecoveryResults(f.binding.recovery!, [f.result]);
  let record = f.store.get(f.thread)!;
  const work = record.works[record.currentWorkId!]!;
  record = f.store.retireAttempt(f.thread, { scope: record.scope, expectedVersion: record.version }, work.logicalWorkId, work.attempts.at(-1)!.attempt);
  record = f.store.reserveRecovery(f.thread, { scope: record.scope, expectedVersion: record.version }, {
    logicalWorkId: work.logicalWorkId, owner: record.owner, snapshotDigest: work.attempts.at(-1)!.snapshotDigest });
  if (replaceBinding) f.bindings.installRecovered(record, f.binding.executionKey!, continuityDigest(""), "turn-first");
  const registration = f.bindings.registrations.get(f.thread);
  expect(() => f.bindings.forgetPage(f.binding, f.binding.executionKey,
    { ownerId: f.before.owner.id, identity: oldIdentity })).toThrow();
  expect(f.store.get(f.thread)).toEqual(record);
  expect(f.bindings.registrations.get(f.thread)).toEqual(registration);
  if (replaceBinding) expect(f.bindings.observed(f.thread)).not.toBe(f.binding);
  else expect(f.bindings.observed(f.thread)).toBe(f.binding);
  expect(f.submissions).toHaveLength(1);
}, 30_000);

test("native compaction lifecycle: an old inspection cannot remove a newly confirmed live page", async () => {
  const f = await firstLossNativeCompactionFixture();
  let replacement: ReturnType<typeof f.store.get>;
  let currentBinding: ReturnType<typeof f.bindings.observed>;
  const inspection = firstLossInspection(f, () => {
    const old = f.store.get(f.thread)!;
    expect(f.store.removePage(f.thread, old)).toBe(true);
    replacement = f.store.admitWork({ thread: f.thread, scope: old.scope, owner: old.owner,
      logicalWorkId: recoveryDigest("new-current-live-work"), instructionIdentity: "new-current-instruction",
      nativeTurnId: "new-current-turn", workPayloadDigest: recoveryDigest("A newer task on the live page."),
      snapshotDigest: recoveryDigest("new-current-input"), createPage: true, dispatchProtocolComplete: true,
      initialEpoch: old.epoch + 100 });
    currentBinding = f.bindings.installRecovered(replacement, "new-current-execution", continuityDigest("new-current-input"), "new-current-turn");
    currentBinding.conversation = f.binding.conversation;
    currentBinding.lease = { owner: old.owner.id, leaseId: "2".repeat(32), traceId: "new-current-trace",
      recovery: recoveryIdentity(replacement, f.store.installationId()) };
    f.pages.set(currentBinding.conversation!.key, { continuity: currentBinding.lease, state: "ready" });
    currentBinding.state = "ready";
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(replacement).toBeDefined();
    expect(response.status, JSON.stringify(body.error)).toBe(409);
    expect(f.store.get(f.thread)).toEqual(replacement!);
    expect(f.bindings.observed(f.thread)).toBe(currentBinding!);
    expect(f.pages.get(currentBinding!.conversation!.key)!.continuity).toEqual(currentBinding!.lease!);
    expect(f.submissions).toHaveLength(1);
  } finally { inspection.mockRestore(); }
}, 30_000);

test("native compaction lifecycle: an unknown page recovers without historical settlement proof", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const inspection = firstLossInspection(f, () => {
    throw Object.assign(new Error("Untrusted inspection failure"), { code: "continuity_session_lost" });
  });
  try {
    const response = await f.send(f.compactBody), body = await response.json();
    expect(response.status, JSON.stringify(body.error)).toBe(200);
    expect(body.status).toBe("completed");
    const after = f.store.get(f.thread)!;
    expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(1);
    expect(Object.values(after.checkpoints)).toHaveLength(1);
    expect(after.epoch).not.toBe(f.before.epoch);
    expect(after.works[f.before.currentWorkId!]).toBeUndefined();
    expect(after.calls).toEqual({});
    expect(f.submissions).toHaveLength(2);
  } finally { inspection.mockRestore(); }
}, 30_000);

for (const advanceAttempt of [false, true]) test(`native compaction lifecycle: stale cleanup preserves a real child commit (advanceAttempt=${advanceAttempt})`, async () => {
  const f = await firstLossNativeCompactionFixture();
  const registration = f.bindings.registrations.get(f.thread);
  const script = `
    import { ContinuityRecoveryStore } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
    import { acceptRecoveryResults } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-runtime.ts"))};
    const store = new ContinuityRecoveryStore(${JSON.stringify(f.statePath)});
    const thread = ${JSON.stringify(f.thread)};
    acceptRecoveryResults(${JSON.stringify(f.binding.recovery)}, [${JSON.stringify(f.result)}]);
    let record = store.get(thread);
    if (${advanceAttempt}) {
      const work = record.works[record.currentWorkId];
      record = store.retireAttempt(thread, { scope: record.scope, expectedVersion: record.version },
        work.logicalWorkId, work.attempts.at(-1).attempt);
      record = store.reserveRecovery(thread, { scope: record.scope, expectedVersion: record.version }, {
        logicalWorkId: work.logicalWorkId, owner: record.owner,
        snapshotDigest: work.attempts.at(-1).snapshotDigest,
      });
    }
    console.log(JSON.stringify(record));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const committed = JSON.parse(child.stdout.toString().trim());
  expect(committed.version).toBeGreaterThan(f.before.version);
  expect(f.store.removePage(f.thread, f.before)).toBe(false);
  expect(f.store.get(f.thread)).toEqual(committed);
  expect(f.bindings.registrations.get(f.thread)).toEqual(registration);
  expect(f.bindings.observed(f.thread)).toBe(f.binding);
  expect(committed.calls[String(f.call.call_id)].firstResultDigest).toBe(recoveryResultDigest(f.result));
  expect(committed.works[committed.currentWorkId].attempts).toHaveLength(advanceAttempt ? 2 : 1);
  expect(f.submissions).toHaveLength(1);
}, 30_000);

test("native compaction lifecycle: a lost legacy lease cannot make its missing identity a new-request gate", async () => {
  const f = await firstLossNativeCompactionFixture();
  f.pages.clear();
  const { recovery: _recovery, ...legacyLease } = f.binding.lease!;
  f.binding.lease = legacyLease;
  const registration = f.bindings.registrations.get(f.thread);
  const response = await f.send(f.compactBody), body = await response.json();
  expect(response.status, JSON.stringify(body.error)).toBe(200);
  expect(body.status).toBe("completed");
  const after = f.store.get(f.thread)!;
  expect(after.epoch).not.toBe(f.before.epoch);
  expect(after.works[f.before.currentWorkId!]).toBeUndefined();
  expect(after.calls).toEqual({});
  expect(Object.values(after.checkpoints)).toHaveLength(1);
  expect(f.bindings.registrations.get(f.thread)).not.toEqual(registration);
  expect(f.bindings.observed(f.thread)).not.toBe(f.binding);
  expect(f.submissions).toHaveLength(2);
}, 30_000);

function repair11VerifiedAuthority(f: ReturnType<typeof httpFixture>) {
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  // Isolate the verified environment dependency, as the existing alias tests do.
  // The public request, compaction, durable journal and process exit remain real.
  const resolver = spyOn(ChatGptThreadEnvironmentStore.prototype, "resolveWithRolloutPublicationRetry").mockImplementation(async parsed => ({
    cwd: "/tmp", roots: ["/tmp"], writableRoots: ["/tmp"],
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp"], networkAccess: true },
    tools: structuredClone(parsed.context.tools ?? []),
  }));
  cleanups.push(async () => { resolver.mockRestore(); });
}

async function repair11CheckpointFixture(marker = false, options: { root?: string; threadId?: string; singleInstruction?: boolean; turnOnlyPrimary?: boolean } = {}) {
  const f = httpFixture(false, !options.turnOnlyPrimary, options);
  if (options.turnOnlyPrimary) repair11VerifiedAuthority(f);
  f.controls.invokeSourceTools = true;
  f.controls.nativeSourceTools = true;
  f.controls.singleSourceTool = true;
  const live = createLiveRequestBody({ case: "mcp-partial", bodies: [],
    expected: { fragments: [], priority: "", call_pairs: [] }, task: "Continue the exact accepted task." },
  { purpose: "ordinary", model: f.body.model, cwd: process.cwd(), threadId: f.threadId, turnId: "turn-1" });
  f.body.input = live.input;
  if (options.singleInstruction) f.body.input = f.body.input.filter((item: any) => item.id !== "msg_live_turn-1_1");
  if (options.turnOnlyPrimary) delete (f.body.input.find((item: any) => item.id === "msg_live_turn-1_2") as any).id;
  f.body.client_metadata = live.client_metadata;
  const openingResponse = await f.send(f.body);
  expect(openingResponse.status).toBe(200);
  const opening = await openingResponse.json() as any;
  const call = opening.output.find((item: any) => item.type === "function_call");
  expect(call).toBeDefined();
  const result = { type: "function_call_output", call_id: call.call_id, output: "Original real return." };
  const sourceBody = { ...structuredClone(f.body), input: [...f.body.input, ...opening.output, result] };
  const handoffs: any[] = [];
  const restore = observeCompactionHandoff(f.broker, continuityDigest(f.threadId), event => handoffs.push(event));
  let compactResponse: Response;
  try { compactResponse = await f.send(compactionBody(sourceBody, COMPACT_PROMPT)); } finally { restore(); }
  const compact = await compactResponse.json() as any;
  expect(compactResponse.status, JSON.stringify(compact.error)).toBe(200);
  const { summary } = actualCheckpoint(compact);
  const store = continuityBindingsFor(f.statePath).recoveryStore, thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  expect(Object.keys(before.checkpoints)).toHaveLength(1);
  const checkpoint = Object.values(before.checkpoints)[0]!;
  expect(checkpoint.summaryDigest).toBe(continuityDigest(summary));
  expect(handoffs).toEqual([]); // The live retained handoff does not use a cold recovery registration.
  const continuation = marker ? { ...structuredClone(sourceBody), input: [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }, ...structuredClone(sourceBody.input)] }
    : checkpointContinuationBody(sourceBody, compact);
  f.controls.invokeSourceTools = false;
  return { ...f, store, thread, before, checkpoint, sourceBody, continuation, summary };
}

for (const marker of [false, true]) for (const lost of [true, false]) test(`checkpoint lifecycle: accepted sibling instructions continue after checkpoint marker=${marker} lost=${lost}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  if (lost) f.pages.clear();
  const sends = f.submissions.length;
  const response = await f.send(f.continuation);
  const envelope = await response.json() as any;
  expect(response.status, JSON.stringify(envelope.error)).toBe(200);
  expect(envelope.status).toBe("completed");
  const after = f.store.get(f.thread)!;
  const expectedSends = sends + (lost ? 1 : 0);
  expect(f.submissions).toHaveLength(expectedSends);
  if (lost) {
    expect(after.checkpoints).toEqual({});
    expect(after.calls).toEqual({});
    expect(after.works[f.checkpoint.sourceLogicalWorkId]).toBeUndefined();
    expect(after.epoch).not.toBe(f.before.epoch);
    expect(f.submissions.at(-1)!.prompt).toContain("Original real return.");
  } else {
    expect(after.checkpoints[f.checkpoint.commitId]).toBeDefined();
    expect(after.calls).toEqual(f.before.calls);
    expect(after.epoch).toBe(f.before.epoch);
  }
  const replay = await f.send(f.continuation);
  expect(replay.status).toBe(200);
  expect((await replay.json() as any).output.map(({ id, ...item }: any) => item))
    .toEqual(envelope.output.map(({ id, ...item }: any) => item));
  expect(f.submissions).toHaveLength(expectedSends);
  expect(f.store.get(f.thread)!.checkpoints).toEqual(after.checkpoints);
}, 30000);

for (const marker of [false, true]) {
  test(`checkpoint lifecycle: checkpoint refuses changed source before execution marker=${marker}`, async () => {
    const f = await repair11CheckpointFixture(marker);
    // Every rejection must preserve this committed baseline, so the mutations can
    // share its expensive setup. Clone each request and check for state pollution.
    for (const mutation of ["payload", "identity", "role", "turn", "forged", "primary", "scope", "duplicate", "identity-role-payload", "removed"] as const) {
      const changed = structuredClone(f.continuation) as any;
      const sibling = changed.input.find((item: any) => item.id === "msg_live_turn-1_1");
      if (mutation === "payload") sibling.content = "A different instruction.";
      if (mutation === "identity") sibling.id = "forged-sibling-id";
      if (mutation === "role") sibling.role = "assistant";
      if (mutation === "turn") sibling.internal_chat_message_metadata_passthrough.turn_id = "different-turn";
      if (mutation === "forged") changed.input.splice(changed.input.indexOf(sibling), 0, { ...structuredClone(sibling), id: "new-before-old", content: "Injected older instruction." });
      if (mutation === "duplicate") changed.input.splice(changed.input.indexOf(sibling), 0, structuredClone(sibling));
      if (mutation === "removed") changed.input.splice(changed.input.indexOf(sibling), 1);
      if (mutation === "identity-role-payload") Object.assign(sibling, { id: "new-developer-id", role: "developer", content: "Changed developer directive." });
      if (mutation === "primary") changed.input.find((item: any) => item.id === "msg_live_turn-1_2").content = "Changed primary.";
      if (mutation === "scope") changed.reasoning = { effort: "high" };
      const before = f.store.get(f.thread)!, sends = f.submissions.length;
      const response = await f.send(changed);
      expect(response.status, mutation).toBe(409);
      expect(f.submissions, mutation).toHaveLength(sends);
      const after = f.store.get(f.thread)!;
      expect(after.checkpoints, mutation).toEqual(before.checkpoints);
      expect(after.calls, mutation).toEqual(before.calls);
      expect(Object.keys(after.works), mutation).toEqual(Object.keys(before.works));
      expect(after.currentWorkId, mutation).toBe(before.currentWorkId);
      expect(after, `durable baseline changed after ${mutation}`).toEqual(f.before);
    }
    const sends = f.submissions.length;
    const valid = await f.send(f.continuation);
    expect(valid.status).toBe(200);
    expect((await valid.json() as any).status).toBe("completed");
    expect(f.submissions).toHaveLength(sends);
  }, 30000);
}

for (const marker of [false, true]) test(`checkpoint lifecycle: older single-source checkpoint continues without inventing sibling proof marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker, { singleInstruction: true });
  // Reconstruct the pre-repair11 durable representation set. Keep its actual
  // source payload, primary representation, calls, summary and commit intact.
  const added = new Set([CONTINUITY_CHECKPOINT_SIBLING_PROOF, continuityCheckpointSiblingGroup([])]);
  const legacyPath = join(f.statePath, "recovery.json");
  const legacyDocument = JSON.parse(readFileSync(legacyPath, "utf8"));
  {
    const record = legacyDocument.threads[f.thread];
    record.compactionTargets[f.checkpoint.compactionTargetId]!.representationDigests =
      record.compactionTargets[f.checkpoint.compactionTargetId]!.representationDigests.filter((value: string) => !added.has(value));
    record.checkpoints[f.checkpoint.commitId]!.representationDigests =
      record.checkpoints[f.checkpoint.commitId]!.representationDigests.filter((value: string) => !added.has(value));
  }
  // Load an old-format fixture; a production transaction must never remove proof.
  writeFileSync(legacyPath, JSON.stringify(legacyDocument));
  const before = f.store.get(f.thread)!, sends = f.submissions.length;
  const forged = structuredClone(f.continuation) as any;
  const primary = forged.input.find((item: any) => item.id === "msg_live_turn-1_2");
  forged.input.splice(forged.input.indexOf(primary), 0, { ...structuredClone(primary), id: "unproven-old-sibling" });
  expect((await f.send(forged)).status).toBe(409);
  expect(f.submissions).toHaveLength(sends);
  expect(f.store.get(f.thread)).toEqual(before);
  const response = await f.send(f.continuation);
  expect(response.status).toBe(200);
  expect((await response.json() as any).status).toBe("completed");
  expect(f.submissions).toHaveLength(sends);
  const after = f.store.get(f.thread)!;
  expect(after.calls).toEqual(before.calls);
  expect(after.checkpoints[f.checkpoint.commitId]!.representationDigests).toEqual(before.checkpoints[f.checkpoint.commitId]!.representationDigests);
  expect(after.checkpoints[f.checkpoint.commitId]!.continuation).toEqual(before.checkpoints[f.checkpoint.commitId]!.continuation);
}, 30000);

for (const marker of [false, true]) test(`checkpoint lifecycle: concurrent checkpoint observers share one consumer marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  f.pages.clear();
  f.controls.deferCompletion = true;
  const sends = f.submissions.length;
  const first = f.send(f.continuation);
  let retries = 0;
  while (!f.controls.releaseDeferredCompletion && retries++ < 200) await Bun.sleep(5);
  expect(f.controls.releaseDeferredCompletion).toBeDefined();
  const binding = continuityBindingsFor(f.statePath).observed(f.thread)!;
  const session = chatGptTurnSessions.find(binding.executionKey!)!;
  let attached!: () => void;
  const observerAttached = new Promise<void>(resolve => { attached = resolve; });
  const originalExclusive = session.runExclusive.bind(session);
  const observe = spyOn(session, "runExclusive").mockImplementation(<T>(task: () => Promise<T>): Promise<T> => {
    const pending = originalExclusive(task);
    attached();
    return pending;
  });
  const second = f.send(structuredClone(f.continuation));
  try {
    expect(await Promise.race([observerAttached.then(() => true), second.then(() => false)])).toBe(true);
    f.controls.releaseDeferredCompletion!();
    for (const response of await Promise.all([first, second])) {
      expect(response.status).toBe(200);
      const envelope = await response.json() as any;
      expect(envelope.status, JSON.stringify(envelope.error)).toBe("completed");
    }
  } finally {
    f.controls.releaseDeferredCompletion?.();
    await Promise.all([first, second]);
    observe.mockRestore();
  }
  expect(f.submissions).toHaveLength(sends + 1);
  const after = f.store.get(f.thread)!;
  expect(Object.values(after.works).filter(work => work.purpose === "ordinary")).toHaveLength(1);
  expect(after.checkpoints).toEqual({});
  expect(after.calls).toEqual({});
}, 30000);

for (const marker of [false, true]) test(`checkpoint lifecycle: a new instruction after checkpoint remains new work marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  const first = await f.send(f.continuation);
  expect((await first.json() as any).status).toBe("completed");
  const before = f.store.get(f.thread)!;
  const body = structuredClone(f.continuation) as any;
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "new-turn" });
  body.input.push({ type: "message", role: "user", id: "new-after-checkpoint", content: "A new accepted task.",
    internal_chat_message_metadata_passthrough: { turn_id: "new-turn" } });
  f.pages.clear();
  const response = await f.send(body);
  expect(response.status).toBe(200);
  expect((await response.json() as any).status).toBe("completed");
  const after = f.store.get(f.thread)!;
  expect(after.works[after.currentWorkId!]!.instructionIdentity).toBe("new-after-checkpoint");
  expect(after.checkpoints).toEqual({});
  expect(after.calls).toEqual({});
  expect(after.works[before.currentWorkId!]).toBeUndefined();
}, 30000);

for (const marker of [false, true]) test(`checkpoint lifecycle: compaction retry cannot add a new sibling proof marker=${marker}`, async () => {
  const f = await repair11CheckpointFixture(marker);
  const changed = structuredClone(f.sourceBody) as any;
  changed.input.find((item: any) => item.id === "msg_live_turn-1_1").id = "retry-forged-sibling";
  const before = f.store.get(f.thread)!, sends = f.submissions.length;
  const response = await f.send(compactionBody(changed, COMPACT_PROMPT));
  expect(response.status).toBe(409);
  expect(f.store.get(f.thread)!.compactionTargets).toEqual(before.compactionTargets);
  expect(f.store.get(f.thread)!.checkpoints).toEqual(before.checkpoints);
  expect(f.submissions).toHaveLength(sends);
}, 30000);

test("checkpoint lifecycle: handoff observer preserves dispatch return identity, failures, bounds and restoration", async () => {
  const f = await repair11CheckpointFixture();
  const ref = { directory: f.statePath, thread: f.thread,
    logicalWorkId: `compaction:${f.checkpoint.compactionTargetId}`, attempt: 0 };
  const secret = "private-summary-and-error-text";
  const error = Object.assign(new Error(secret), { code: `continuity_${secret}` });
  for (const mode of ["sync", "promise", "throw", "reject"] as const) {
    const returned = { submitted: true };
    const promise = mode === "reject" ? Promise.reject(error) : Promise.resolve(returned);
    void promise.catch(() => {});
    let calls = 0;
    const receiver = {};
    const request = { method: "submit_compaction_handoff", token: "private-control-token", handoffId: "private-handoff-id", summary: secret };
    const original = function(this: unknown, ...args: unknown[]) {
      calls++; expect(this).toBe(receiver); expect(args[0]).toBe(request);
      if (mode === "throw") throw error;
      return mode === "sync" ? returned : promise;
    };
    const fake = { dispatch: original, compactionContextBindings: new Map([[request.token, { readToken: "read" }]]),
      compactionContexts: new Map([["read", { registration: { recovery: ref } }]]) };
    const events: any[] = [];
    const restore = observeCompactionHandoff(fake as unknown as TurnBroker, f.thread, event => events.push(event));
    try {
      if (mode === "throw") { try { fake.dispatch.call(receiver, request); throw new Error("Expected original error"); } catch (caught) { expect(caught).toBe(error); } }
      else {
        const actual = fake.dispatch.call(receiver, request);
        expect(actual).toBe(mode === "sync" ? returned : promise);
        if (mode !== "sync") await promise.catch(caught => { expect(caught).toBe(error); });
      }
      expect(calls).toBe(1);
      expect(events.map(event => event.stage)).toEqual(["arrived", mode === "throw" || mode === "reject" ? "rejected" : "returned"]);
      const encoded = JSON.stringify(events);
      for (const value of [secret, request.token, request.handoffId, error.code]) expect(encoded).not.toContain(value);
      if (mode === "throw" || mode === "reject") expect(events[1].code).toBeNull();
      for (let i = 0; i < 20; i++) { try { fake.dispatch.call(receiver, request); } catch {} }
      await Promise.resolve();
      expect(events.length).toBe(32);
    } finally { restore(); }
    expect(fake.dispatch).toBe(original);
    const restoreAgain = observeCompactionHandoff(fake as unknown as TurnBroker, f.thread, () => { throw new Error("Observer failed"); });
    const replacement = () => returned;
    fake.dispatch = replacement;
    restoreAgain();
    expect(fake.dispatch).toBe(replacement);
  }
}, 30000);

test.skipIf(!process.env.REPAIR11_CHECKPOINT_SEED_ROOT)("repair11 child checkpoint seed", async () => {
  const root = process.env.REPAIR11_CHECKPOINT_SEED_ROOT!;
  const f = await repair11CheckpointFixture(process.env.REPAIR11_CHECKPOINT_SEED_MARKER === "1", { root, threadId: "repair11-restarted-checkpoint",
    turnOnlyPrimary: process.env.REPAIR11_CHECKPOINT_SEED_TURN_ONLY === "1" });
  writeFileSync(join(root, "seed.json"), JSON.stringify({ continuation: f.continuation, checkpoint: f.checkpoint, before: f.before }));
}, 30000);

for (const marker of [false, true]) for (const turnOnly of [false, true]) test(`checkpoint lifecycle: actual backend exit restores the request without old checkpoint proof marker=${marker} turnOnly=${turnOnly}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "repair11-restarted-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const log = Bun.file(join(root, "child.log"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^repair11 child checkpoint seed$"], {
    env: { ...process.env, REPAIR11_CHECKPOINT_SEED_ROOT: root, REPAIR11_CHECKPOINT_SEED_MARKER: marker ? "1" : "0",
      REPAIR11_CHECKPOINT_SEED_TURN_ONLY: turnOnly ? "1" : "0" },
    stdout: log, stderr: log,
  });
  expect(await child.exited, await log.text()).toBe(0);
  const seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
  expect(["exited", "unverified"]).toContain(continuityProcessInstanceStatus(seed.before.owner));
  const f = httpFixture(false, !turnOnly, { root, threadId: "repair11-restarted-checkpoint" });
  if (turnOnly) repair11VerifiedAuthority(f);
  expect(continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))).toBeUndefined();
  const current = structuredClone(seed.continuation);
  if (turnOnly) current.input.find((value: any) => value.role === "user" && !value.id
    && value.internal_chat_message_metadata_passthrough?.turn_id === "turn-1").content = "Current task after backend exit.";
  const response = await f.send(current);
  const envelope = await response.json() as any;
  expect(response.status, JSON.stringify(envelope.error)).toBe(200);
  expect(envelope.status, JSON.stringify(envelope.error)).toBe("completed");
  const after = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(after.checkpoints).toEqual({});
  expect(after.calls).toEqual({});
  expect(after.works[seed.checkpoint.sourceLogicalWorkId]).toBeUndefined();
  expect(after.epoch).not.toBe(seed.before.epoch);
  expect(f.submissions).toHaveLength(1);
  if (turnOnly) expect(f.submissions[0]!.prompt).toContain("Current task after backend exit.");
  expect(f.submissions[0]!.prompt).toContain("Original real return.");
}, 30000);

test("repair12: overlapping healthy preview attaches to its in-flight compaction", async () => {
  const f = fixture(); const first = f.request(); await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  const sync = source.runtime.syncContextUsage;
  const automatic = f.automatic.getMockImplementation()!;
  let enteredPreview!: () => void, releasePreview!: () => void, enteredSend!: () => void, releaseSend!: () => void;
  const preview = new Promise<void>(r => { enteredPreview = r; });
  const holdPreview = new Promise<void>(r => { releasePreview = r; });
  const send = new Promise<void>(r => { enteredSend = r; });
  const holdSend = new Promise<void>(r => { releaseSend = r; });
  let calls = 0;
  source.runtime.syncContextUsage = async () => { await sync?.call(source.runtime); if (++calls === 1) { enteredPreview(); await holdPreview; } };
  f.automatic.mockImplementation(async turn => {
    if (turn.nativeConnector) {
      const activated = turn.onSendActivated;
      turn.onSendActivated = async () => { await activated?.(); enteredSend(); await holdSend; };
    }
    return automatic(turn);
  });
  const pending = f.run(compact).catch(error => ({ diagnosticError: (error as { code?: string }).code ?? String(error) }));
  let second: Promise<AdapterEvent[] | { diagnosticError: string }> | undefined;
  try {
    expect(await Promise.race([preview.then(() => true), pending.then(() => false)])).toBe(true);
    second = f.run(structuredClone(compact)).catch(error => ({ diagnosticError: (error as { code?: string }).code ?? String(error) }));
    expect(await Promise.race([send.then(() => true), second.then(() => false)])).toBe(true);
    const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
    const inFlight = bindings.recoveryStore.get(thread)!;
    expect(Object.keys(inFlight.checkpoints)).toHaveLength(0);
    expect(inFlight.works[inFlight.currentWorkId!]!.purpose).toBe("compaction");
    releasePreview();
    const early = await Promise.race([pending.then(result => ({ settled: true, error: Array.isArray(result) ? null : result.diagnosticError })),
      Bun.sleep(100).then(() => ({ settled: false, error: null }))]);
    releaseSend();
    const [observer, owner] = await Promise.all([pending, second]);
    const after = bindings.recoveryStore.get(thread)!;
    expect(early.settled).toBe(false);
    expect(Object.keys(after.compactionTargets)).toHaveLength(1);
    expect(Object.values(after.works).filter(work => work.purpose === "compaction")).toHaveLength(1);
    expect(Array.isArray(owner)).toBe(true);
    expect(f.submissions).toHaveLength(2);
    expect(Object.keys(after.checkpoints)).toHaveLength(1);
    expect(Array.isArray(observer), "An identical in-flight observer must attach to the existing healthy run.").toBe(true);
    if (Array.isArray(observer)) expect(observer.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally { releasePreview(); releaseSend(); await Promise.all([pending, second]); source.runtime.syncContextUsage = sync; f.automatic.mockImplementation(automatic); }
}, 30000);
