import { mock as timerMock } from "node:test";
import { ChatGptSuspensionClock, chatGptSuspensionClock } from "../src/adapters/chatgpt-web/suspension-clock";
import { ContinuityRecoveryStore, continuityProcessInstance, continuityProcessInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryResultDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { afterEach, expect, spyOn } from "bun:test";
import { controlledClock } from "./helpers/controlled-clock";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelStructuredCompactionNativeTurn, existingStructuredCompactionRun, canonicalizeCompactionHandoff, LATEST_USER_PROMPT_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { compactionSourceWasDelegation, isAcceptedCompactionContinuation, isDurableCompactionSourceIdentity, recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import { continuityBindingsFor, continuityCheckpoint, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { chatGptCurrentInstructionIndex, chatGptCurrentInstructionRevision, extractChatGptTurnIdentity, extractChatGptTurnUserRevision, extractChatGptCompactV1SourceRevision, extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { chatGptContinuityInstructionPayloadDigest, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { buildCompactV1Output, COMPACT_PROMPT, encodeCompactionSummary, extractCompactUserMessages, SUMMARY_PREFIX } from "../src/responses/compaction";
import { routeChatGptWebRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";
import { performanceTest } from "./helpers/performance-test";
import { createSessionContinuityFixtures, recordedCall } from "./helpers/session-continuity-fixture";
import { withContinuitySourceDiagnostics } from "./helpers/continuity-source-diagnostics";
import * as launcherHost from "../src/launcher-browser-host";

const test = performanceTest(import.meta.path);
const { cleanups, disposeTestFixtures, fixture, httpFixture } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

test("healthy continuity compaction retains its remaining budget after ten minutes of process suspension", async () => {
  await compactionBudgetScenario(compactionBudgetCases[0], 0, 601_000);
});

const compactionBudgetCases = [
  { name: "completes source settlement and checkpoint within the original budget", sourceDelay: 300, checkpointDelay: 300, succeeds: true },
  { name: "preserves the original deadline across source settlement and checkpoint", sourceDelay: 700, checkpointDelay: 700, succeeds: false },
  { name: "still times out during source settlement", sourceDelay: 1600, checkpointDelay: 0, succeeds: false },
  { name: "still times out during the checkpoint", sourceDelay: 0, checkpointDelay: 1600, succeeds: false },
] as const;

async function compactionBudgetScenario({ sourceDelay, checkpointDelay, succeeds }: typeof compactionBudgetCases[number], preparationDelayMs = 0, suspensionMs = 0): Promise<void> {
  const f = fixture(false, { turnTimeoutMs: suspensionMs ? 10_000 : 1000, waitForRetirement: true });
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const ordinary = f.automatic.getMockImplementation()!;
  let compactionStarted!: () => void;
  const started = new Promise<void>(resolve => { compactionStarted = resolve; });
  const beginCompaction = bindings.beginCompaction.bind(bindings);
  const begin = spyOn(bindings, "beginCompaction").mockImplementation((...args) => {
    const claim = beginCompaction(...args);
    compactionStarted();
    return claim;
  });
  let settleSource!: () => void;
  Object.defineProperty(source, "physicalSettlement", { value: new Promise<void>(resolve => { settleSource = resolve; }) });
  let checkpoint: Promise<string> | undefined;
  const clock = suspensionMs ? (() => {
    timerMock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const elapsed = spyOn(performance, "now").mockImplementation(() => Date.now());
    return { tick: (ms: number) => timerMock.timers.tick(ms), restore() { elapsed.mockRestore(); timerMock.timers.reset(); } };
  })() : controlledClock();
  const suspension = new ChatGptSuspensionClock(1_000, 5_000, () => performance.now(), () => Date.now());
  const suspensionSpies = suspensionMs ? [
    spyOn(chatGptSuspensionClock, "start").mockImplementation(() => {}),
    spyOn(chatGptSuspensionClock, "suspendedMs").mockImplementation(() => suspension.suspendedMs()),
    spyOn(chatGptSuspensionClock, "recentSuspension").mockImplementation(() => suspension.recentSuspension()),
  ] : [];
  f.automatic.mockImplementation(turn => {
    if (!turn.nativeConnector) return ordinary(turn);
    checkpoint = (async () => {
      clock.tick(checkpointDelay);
      turn.abortSignal?.throwIfAborted();
      return ordinary(turn);
    })();
    return checkpoint;
  });
  const compact = structuredClone(first);
  compact._compactionRequest = true;
  // Deadline arithmetic and timer delivery must share the same clock; real I/O
  // must not consume the simulated budget or grant the checkpoint a fresh one.
  let run: Promise<AdapterEvent[]> | undefined;
  try {
    run = f.run(compact);
    void run.catch(() => {});
    await Promise.race([
      started,
      run.then(() => { throw new Error("Compaction finished before source settlement"); }),
    ]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(binding.state).toBe("compacting");
    if (preparationDelayMs) {
      const realStart = process.hrtime.bigint();
      const wallStart = Date.now();
      const monotonicStart = performance.now();
      await Bun.sleep(preparationDelayMs);
      expect(Number(process.hrtime.bigint() - realStart) / 1e6).toBeGreaterThan(1_000);
      expect(Date.now()).toBe(wallStart);
      expect(performance.now()).toBe(monotonicStart);
    }
    if (suspensionMs) clock.tick(suspensionMs);
    clock.tick(sourceDelay);
    settleSource();
    if (!succeeds) {
      await expect(run).rejects.toMatchObject({ code: "continuity_session_lost", message: expect.stringContaining("The handoff exceeded its original deadline.") });
      expect(binding.state).toBe("lost");
      if (sourceDelay > 1000) expect(checkpoint).toBeUndefined();
      else expect(checkpoint).toBeDefined();
      return;
    }
    const events = await run;
    expect(events.find(event => event.type === "text_delta")).toMatchObject({
      type: "text_delta", text: expect.stringContaining(f.controls.handoffSummary),
    });
    expect(binding.state).toBe("ready");
    expect(f.submissions).toHaveLength(2);
  } finally {
    for (const spy of suspensionSpies.reverse()) spy.mockRestore();
    clock.restore();
    settleSource();
    await run?.catch(() => {});
    await source.physicalSettlement;
    await checkpoint?.catch(() => {});
    begin.mockRestore();
    await disposeTestFixtures();
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
}

for (const scenario of compactionBudgetCases) {
  test(`continuity compaction ${scenario.name}`, () => compactionBudgetScenario(scenario));
  test(`controlled clock slow source settlement: ${scenario.name}`, () => compactionBudgetScenario(scenario, 1_100));
}

test("Automatic completed compaction retains the exact page and concurrent retries share one structured handoff", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const [left, right] = await Promise.all([f.run(compact), f.run(structuredClone(compact))]);
  expect(left.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(right.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(left.find(event => event.type === "text_delta")).toEqual(right.find(event => event.type === "text_delta"));
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.pages.size).toBe(1);
  expect([...f.pages.values()][0]?.state).toBe("ready");
  const replay = await f.run(structuredClone(compact));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`);
  expect(source?.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  expect(source?.conversationKey()).toBeUndefined();
  f.pages.clear();
  expect((await f.run(structuredClone(compact))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(3);
});

for (const withTools of [false, true]) test(`durable retained compaction forwards its authenticated directory through the original Helper guard (tool results=${withTools})`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = withTools;
  f.controls.parallelSourceTools = withTools;
  const first = f.request();
  await f.run(first);
  let completed = first;
  if (withTools) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const calls = source.outstanding();
    expect(calls).toHaveLength(2);
    completed = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      ...calls.flatMap((call, index) => [recordedCall(call), {
        type: "function_call_output", call_id: call.callId, output: `Accepted source result ${index}.`,
      }])]);
    expect((await f.run(completed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  }
  const helper = new LauncherBrowserHelperClient({} as never);
  const internal = helper as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; turn?: { recoveryStoreDirectory?: string } }): Promise<void>;
  };
  // The external child boundary is controlled; the original run() directory guard is intact.
  internal.ensureChild = async () => {};
  helper.assertContinuityCompatible = async () => {};
  const atHelperPipe = new Error("Controlled external Helper pipe boundary");
  const frames: Array<{ type: string; turn?: { recoveryStoreDirectory?: string } }> = [];
  internal.send = async frame => { frames.push(frame); throw atHelperPipe; };
  const ordinary = f.automatic.getMockImplementation()!;
  f.automatic.mockImplementation(async turn => {
    if (!turn.compaction) return ordinary(turn);
    expect(turn.continuity?.recovery).toBeDefined();
    expect(turn.onSendActivated).toBeFunction();
    expect(turn.nativeConnector).toBe(true);
    expect(turn.capabilities.localToolsEnabled).toBe(false);
    const submissions = f.submissions.length;
    await expect(helper.run({ ...turn, recoveryStoreDirectory: undefined })).rejects.toMatchObject({
      code: "continuity_configuration_conflict",
      message: expect.stringContaining("Recovery requires the authenticated durable state directory in the browser helper."),
    });
    expect(frames).toHaveLength(0);
    expect(f.submissions).toHaveLength(submissions);
    try { await helper.run(turn); throw new Error("The controlled Helper pipe did not run"); }
    catch (error) { if (error !== atHelperPipe) throw error; }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "run", turn: { recoveryStoreDirectory: f.registrations.directory } });
    expect(turn.recoveryStoreDirectory).toBe(f.registrations.directory);
    // Continue through the fixture's original durable lease, Send receipt and handoff.
    return ordinary(turn);
  });
  try {
    const compact = structuredClone(completed); compact._compactionRequest = true;
    const events = await f.run(compact);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events.find(event => event.type === "text_delta" && event.phase === "final_answer"))
      .toMatchObject({ text: expect.stringContaining(f.controls.handoffSummary) });
    const journal = new ContinuityRecoveryStore(f.registrations.directory).get(continuityDigest(f.threadId))!;
    expect(journal.historyRevision).toBe(1);
    expect(Object.values(journal.checkpoints)).toHaveLength(1);
    expect(Object.values(journal.checkpoints)[0]!.coveredCallIds).toHaveLength(withTools ? 2 : 0);
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
    expect((await f.run(structuredClone(compact))).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(frames).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } finally { await helper.close(); }
});

test("Automatic shared compaction is cancelled by a later request's native turn identity", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  let release!: () => void;
  const gate = source.runExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await Bun.sleep(0);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const pending = f.run(compact).catch(error => error);
  const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(compact)}`;
  while (!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  const retry = f.request("", "turn-compaction-retry", (first._rawBody as { input: unknown[] }).input);
  retry._compactionRequest = true;
  const adapter = f.adapter();
  await adapter.preflight!(retry, { headers: new Headers() });
  const retried = adapter.runTurn!(retry, { headers: new Headers() }, () => {}).catch(error => error);
  const cancellation = cancelStructuredCompactionNativeTurn(f.threadId, "turn-compaction-retry", new DOMException("User interrupted compaction", "AbortError"));
  release();
  await gate;
  const [left, right] = await Promise.all([pending, retried]);
  await cancellation.settlement;
  expect(cancellation.cancelled).toBe(1);
  expect(left).toBeInstanceOf(Error);
  expect(right).toBeInstanceOf(Error);
  expect(f.submissions).toHaveLength(1);
});

test("completed compaction rejects canonical history with unowned execution records", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unowned execution record." }] },
    { type: "function_call", name: "exec_command", call_id: "foreign-call", arguments: '{"cmd":"not-owned"}' },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
});

test("leaving after compaction clears the committed physical page and checkpoint", async () => {
  const f = fixture(), first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(bindings.recoveryStore.get(thread)).toBeUndefined();
  expect(bindings.observed(thread)).toBeUndefined();
  expect(f.pages.size).toBe(0);
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
});

test("Zero Risk completed explicit compaction prepares a manual checkpoint and preserves its ordinary answer", async () => {
  const f = fixture(true);
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
});

test("a rejected structured handoff on an unavailable page retries current input in a new generation", async () => {
  const f = fixture(), first = f.request(); await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  f.controls.handoffSummary = 'Invalid checkpoint.\nCODEX_LATEST_USER_PROMPT_JSON\n"A different instruction"';
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), old = store.get(thread)!;
  f.controls.handoffSummary = "Current retry checkpoint.";
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const current = store.get(thread)!;
  expect(current.epoch).not.toBe(old.epoch);
  for (const key of Object.keys(old.works)) expect(current.works[key]).toBeUndefined();
  expect(Object.values(current.checkpoints)).toHaveLength(1);
  expect(f.submissions).toHaveLength(3);
  expect(f.controls.toolResults).toHaveLength(0);
});

test("an accepted handoff with failed page settlement does not authorize replay on a new page", async () => {
  const f = fixture(), first = f.request(); await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  f.controls.failHandoffSettlement = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost" });
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), old = store.get(thread)!;
  f.controls.failHandoffSettlement = false;
  f.controls.handoffSummary = "Summary produced by the current page.";
  const events = await f.run(compact);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.find(event => event.type === "text_delta" && event.phase === "final_answer")).toMatchObject({ text: expect.stringContaining("Summary produced by the current page.") });
  expect(store.get(thread)!.epoch).not.toBe(old.epoch);
  const replay = await f.run(compact);
  expect(replay.find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual(events.find(event => event.type === "text_delta" && event.phase === "final_answer"));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
});

test("a committed compaction is cleared with its page before a compact reconnect", async () => {
  const f = fixture(), first = f.request(); await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), old = store.get(thread)!;
  f.pages.clear(); f.controls.handoffSummary = "Replacement page checkpoint.";
  const events = await f.run(compact);
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(events.find(event => event.type === "text_delta" && event.phase === "final_answer")).toMatchObject({ text: expect.stringContaining("Replacement page checkpoint.") });
  const current = store.get(thread)!;
  expect(current.epoch).not.toBe(old.epoch);
  for (const key of Object.keys(old.checkpoints)) expect(current.checkpoints[key]).toBeUndefined();
  expect(f.submissions).toHaveLength(3);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active compaction preserves delivered tool results and resumes with fresh authority on the same page`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  expect(call.wireName).toBe("exec_command");
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(source.outstanding()).toHaveLength(0);
  expect(JSON.stringify(f.controls.toolResults[0])).toContain("Actual completed tool result: 42.");
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 2);
  if (!manual) expect(f.controls.toolResults[1]?.isError).toBe(true);
  expect(source.supersededError).toMatchObject({ code: "continuity_source_unproven" });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing active handoff");
  const token = f.controls.sourceToken;
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-first", [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }]);
  expect((await f.run(resumed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(resumed._continuityHistoryRevision).toBe(1);
  expect(f.submissions).toHaveLength(manual ? 2 : 3);
  const prompt = f.submissions.at(-1)!.prompt;
  expect(prompt).not.toContain("Verified checkpoint.");
  expect(prompt).not.toContain("Actual completed tool result: 42.");
  expect(prompt).not.toContain(token);
  expect(prompt).toContain("continue only unfinished authorized work");
  expect(new Set(f.submissions.map(submission => submission.key)).size).toBe(1);
  expect(f.pages.size).toBe(1);
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) }))
    .rejects.toThrow();
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active compaction rejects foreign execution records before checkpoint commit`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const owned = [
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ];
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...owned,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call", name: "exec_command", call_id: "foreign-call", arguments: '{"cmd":"not-owned"}' },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  const valid = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...owned,
  ]);
  valid._compactionRequest = true;
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} compaction rejects source history superseded after preflight`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const toolCall = {
    type: "function_call", name: call.wireName, call_id: call.callId,
    arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}',
  };
  const staleCompact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    toolCall,
    { type: "function_call_output", call_id: call.callId, output: "Preflight tool result A." },
  ]);
  staleCompact._compactionRequest = true;
  const compactAdapter = f.adapter();
  const sourceCoverage = source.runtime.compactionSourceCoverage!;
  const canonicalBeforePreflight = structuredClone(source.canonicalInput());
  const coverageBeforePreflight = sourceCoverage.metadata();
  const recoveryStore = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const durableBeforePreflight = recoveryStore.get(thread)!;
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });
  expect(source.canonicalInput()).toEqual(canonicalBeforePreflight);
  expect(sourceCoverage.metadata()).toEqual(coverageBeforePreflight);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(durableBeforePreflight.contextCoverage);
  expect(recoveryStore.get(thread)!.calls[call.callId]!.firstResultDigest).toBeUndefined();

  const newerCanonical = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    structuredClone(toolCall),
    { type: "function_call_output", call_id: call.callId, output: "Canonical tool result B." },
  ]);
  expect((await f.run(newerCanonical)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(source.canonicalInput()).toEqual((newerCanonical._rawBody as { input: unknown[] }).input);
  expect(recoveryStore.get(thread)!.calls[call.callId]!.firstResultDigest)
    .toBe(recoveryResultDigest({ type: "function_call_output", call_id: call.callId, output: "Canonical tool result B." }));

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const submissions = f.submissions.length;
  const acceptedCoverage = sourceCoverage.metadata();
  const acceptedDurableCoverage = recoveryStore.get(thread)!.contextCoverage;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(sourceCoverage.metadata()).toEqual(acceptedCoverage);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(acceptedDurableCoverage);
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  expect(f.submissions).toHaveLength(submissions);
});

test("Automatic stale compaction CAS failure preserves an active running source", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const firstCall = source.outstanding()[0]!;
  const toolCall = {
    type: "function_call", name: firstCall.wireName, call_id: firstCall.callId,
    arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}',
  };
  const staleCompact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    toolCall,
    { type: "function_call_output", call_id: firstCall.callId, output: "Preflight tool result A." },
  ]);
  staleCompact._compactionRequest = true;
  const compactAdapter = f.adapter();
  const sourceCoverage = source.runtime.compactionSourceCoverage!;
  const canonicalBeforePreflight = structuredClone(source.canonicalInput());
  const coverageBeforePreflight = sourceCoverage.metadata();
  const recoveryStore = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const durableBeforePreflight = recoveryStore.get(thread)!;
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });
  expect(source.canonicalInput()).toEqual(canonicalBeforePreflight);
  expect(sourceCoverage.metadata()).toEqual(coverageBeforePreflight);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(durableBeforePreflight.contextCoverage);
  expect(recoveryStore.get(thread)!.calls[firstCall.callId]!.firstResultDigest).toBeUndefined();

  const newerCanonical = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    structuredClone(toolCall),
    { type: "function_call_output", call_id: firstCall.callId, output: "Canonical tool result B." },
  ]);
  const previousBatchRevision = source.runtime.mode === "tools"
    ? source.runtime.externalProgress.snapshot().lastToolBatchRevision
    : 0;
  const newerRun = f.run(newerCanonical);
  const deadline = Date.now() + 1_000;
  let nextBatchRevision = previousBatchRevision;
  while (nextBatchRevision === previousBatchRevision && Date.now() < deadline) {
    await Bun.sleep(1);
    if (source.runtime.mode === "tools") {
      nextBatchRevision = source.runtime.externalProgress.snapshot().lastToolBatchRevision;
    }
  }
  if (source.runtime.mode === "tools") {
    await source.runtime.externalProgress.acknowledgeToolBatch(nextBatchRevision);
  }
  expect((await newerRun).at(-1)).toMatchObject({ type: "done", endTurn: false });
  expect(recoveryStore.get(thread)!.calls[firstCall.callId]!.firstResultDigest)
    .toBe(recoveryResultDigest({ type: "function_call_output", call_id: firstCall.callId, output: "Canonical tool result B." }));
  expect(source.outstanding()).toHaveLength(1);
  expect(source.outstanding()[0]?.callId).not.toBe(firstCall.callId);
  const acceptedCanonical = structuredClone(source.canonicalInput());
  expect(acceptedCanonical).toEqual([
    ...(newerCanonical._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!),
  ]);

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  expect(binding.state).toBe("running");
  const submissions = f.submissions.length;
  const acceptedCoverage = sourceCoverage.metadata();
  const acceptedDurableCoverage = recoveryStore.get(thread)!.contextCoverage;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(sourceCoverage.metadata()).toEqual(acceptedCoverage);
  expect(recoveryStore.get(thread)!.contextCoverage).toEqual(acceptedDurableCoverage);
  expect(binding.state).toBe("running");
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  expect(source.outstanding()).toHaveLength(1);
  expect(source.canonicalInput()).toEqual(acceptedCanonical);
  expect(f.submissions).toHaveLength(submissions);
  source.cancel(continuityError("continuity_session_lost"));
});

test("an active Zero Risk ordinary final that wins before control delivery is preserved without a second prompt", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const first = f.request();
  const ordinary = f.run(first);
  while (!f.controls.started) await Bun.sleep(1);
  const compact = structuredClone(first); compact._compactionRequest = true;
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const sync = source.runtime.syncContextUsage;
  let entered!: () => void, release!: () => void;
  const preview = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  source.runtime.syncContextUsage = async () => { await sync?.call(source.runtime); entered(); await held; };
  const handoff = f.run(compact).catch(error => error);
  await preview;
  // Compaction validation is serialized behind the active ordinary owner. It must not claim
  // the compaction state until the source lock can prove which local work actually won.
  expect(binding.state).toBe("running");
  f.broker.completeSafeTurn(f.controls.safeToken, "Ordinary final wins.");
  expect((await ordinary).at(-1)).toMatchObject({ type: "done", endTurn: true });
  release(); source.runtime.syncContextUsage = sync;
  expect(await handoff).toMatchObject({ code: "continuity_manual_handoff_required" });
  expect(binding.revision).toBe(0);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(first)).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Ordinary final wins.", phase: "final_answer" });
});

test("completed delegated compaction retry rejects changed source content under the same source identity", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const changed = f.request("A different source instruction."); changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active delegated source content conflict preserves the accepted source owner`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  expect(source.outstanding()).toHaveLength(1);
  const token = f.controls.sourceToken;
  const changed = f.request("Changed delegated source content.", "turn-first");
  changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("running");
  expect(source.isActive()).toBe(true);
  expect(source.supersededError).toBeUndefined();
  expect(source.outstanding()).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(0);
  const claim = await callTurnBroker<{ bindingId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "claim", token, ...(manual ? { contract: "safe" } : {}),
  });
  expect(claim.bindingId).toBeDefined();
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} committed compaction replay rejects changed accepted tool-result payload`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId,
      arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Accepted compact result A." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
  ]);
  await f.run(resumed);
  await f.run(f.next(resumed, "turn-after-compaction-result"));
  if (reclamation === "capacity") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "compaction-result-replay-capacity-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(sourceKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const changed = structuredClone(compact);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.type === "function_call_output")!.output = "Conflicting compact result B.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_result_conflict", retryable: false });
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
});

test("completed local compaction retry rejects a changed control payload", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const raw = structuredClone(first._rawBody) as Record<string, unknown> & { input: unknown[] };
  const compactRaw = {
    ...raw,
    input: [...raw.input, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  };
  const compact = parseRequest(compactRaw);
  compact._conversationPolicy = "task";
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const changedRaw = structuredClone(compactRaw);
  (changedRaw.input.at(-1) as { content: string }).content += "\nChanged control payload.";
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "task";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} cached compaction binds all source instructions after steering`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const prior = f.request("Earlier steering instruction.");
  await f.run(prior);
  const a = { type: "message", role: "user", id: "constraint-a", content: "Accepted constraint A.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const b = { type: "message", role: "user", id: "task-b", content: "Stable task B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = f.request("", "turn-first", [...(prior._rawBody as { input: unknown[] }).input, a, b]);
  await f.run(first);
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  let compact = structuredClone(first);
  if (manual) {
    const call = source.outstanding()[0]!;
    compact = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  expect(compactEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-after-compact", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "next-task", content: "New work after compaction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-compact" } },
  ]);
  await f.run(next);
  if (reclamation === "capacity") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      // Admission can reclaim the earlier steering execution before this source.
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "source-payload-capacity-probe");
      registry.maxEntries = registry.entries.size;
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "source-payload-capacity-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(sourceKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
  const submissions = f.submissions.length;
  const results = f.controls.toolResults.length;
  const snapshot = source.canonicalInput();
  const changedRaw = structuredClone(compact._rawBody) as { input: Array<Record<string, unknown>> };
  changedRaw.input.find(item => item.id === "constraint-a")!.content = "Conflicting constraint A'.";
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "task";
  changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const historicalRaw = structuredClone(compact._rawBody) as { input: Array<Record<string, unknown>> };
  historicalRaw.input[0]!.content = "Changed earlier steering history.";
  const historicalReplay = parseRequest(historicalRaw);
  historicalReplay._conversationPolicy = "task";
  historicalReplay._compactionRequest = true;
  expect((await f.run(historicalReplay)).find(event => event.type === "text_delta")).toEqual(summary);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
  expect(source.canonicalInput()).toEqual(snapshot);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent compaction rejects changed results before initial acceptance`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const sourceKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`;
  const source = chatGptTurnSessions.find(sourceKey)!;
  const call = source.outstanding()[0]!;
  const makeCompact = (output: string) => {
    const parsed = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    parsed._compactionRequest = true;
    return parsed;
  };
  const a = makeCompact("Result A");
  const b = makeCompact("Result B");
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lock = source.runExclusive(async () => { entered(); await gate; });
  await enteredPromise;
  try {
    const runA = f.run(a).then(events => ({ ok: true as const, events }), error => ({ ok: false as const, error }));
    let cached: Promise<string> | undefined;
    for (let i = 0; i < 200; i++) {
      if (a._continuityHistoryRevision !== undefined) {
        const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(a)}`;
        cached = existingStructuredCompactionRun<string>(key);
      }
      if (cached) break;
      await Bun.sleep(5);
    }
    expect(cached).toBeDefined();
    const resultB = await f.run(b).then(events => ({ ok: true as const, events }), error => ({ ok: false as const, error }));
    expect(resultB.ok).toBe(false);
    release();
    const resultA = await runA;
    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(false);
    if (!resultB.ok) expect(resultB.error).toMatchObject({ code: "continuity_source_unproven" });
    if (resultA.ok) {
      expect(resultA.events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(f.submissions).toHaveLength(manual ? 1 : 2);
    }
  } finally {
    release();
    await lock;
  }
});

for (const manual of [false, true]) for (const sameTurn of [false, true]) for (const retainPredecessor of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} moved checkpoint rejects ambiguous ${sameTurn ? "same-turn" : "ID-only"} history with predecessor ${retainPredecessor ? "before checkpoint" : "absent"}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const old = { type: "message", role: "user", id: "old-a", content: "Old instruction A.",
    ...(sameTurn ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}) };
  const current = { type: "message", role: "user", id: "source-b", content: "Source instruction B.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = f.request("", "turn-first", [old, current]);
  await f.run(first);
  let compact = structuredClone(first);
  if (manual) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call = source.outstanding()[0]!;
    compact = f.request("", "turn-first", [old, current,
      { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const submissions = f.submissions.length;
  const turnId = sameTurn ? "turn-first" : "turn-next";
  const next = f.request("", turnId, [
    ...(retainPredecessor ? [current] : []),
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, old,
    { type: "message", role: "user", id: "new-c", content: "New instruction C.", internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  const proved = f.request("", turnId, [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, old, current,
    { type: "message", role: "user", id: "proved-new", content: "Proved new work.",
      internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ]);
  expect((await f.run(proved)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt).toContain("Proved new work.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Old instruction A.");
});

for (const manual of [false, true]) test(`Round 7: accepted foreign-source tail cannot mask consumed current instruction ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const a = f.request("Consumed instruction A.", "turn-a");
  await f.run(a);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = false;
  const b = f.next(a, "turn-b");
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-c", [
    ...(b._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Completed B result." },
  ]);
  compact._compactionRequest = true;
  const events = await f.run(compact);
  const summary = events.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const originalB = structuredClone((b._rawBody as { input: unknown[] }).input.at(-1));
  const masked = f.request("", "turn-c", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-turn-a", content: "Changed work under consumed instruction A ID.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-c" } },
    originalB,
  ]);
  const before = f.submissions.length;
  const unmasked = f.request("", "turn-c", (masked._rawBody as { input: unknown[] }).input.slice(0,-1));
  await expect(f.run(unmasked)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(chatGptCurrentInstructionIndex(masked)).toBe(1);
  expect(chatGptCurrentInstructionRevision(masked)?.itemId).toBe("msg-turn-a");
  const result = await f.run(masked).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code }));
  expect(result).toMatchObject({ accepted: false, code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(before);
});

test("Round 7: accepted source tail cannot mask new instruction after completed-source checkpoint", async () => {
  const f=fixture();
  const source = f.request("Source A.", "turn-a");
  await f.run(source);
  const compact=f.request("", "turn-b", (source._rawBody as {input: unknown[]}).input);
  compact._compactionRequest=true;
  const events=await f.run(compact);
  const summary=events.find(event=>event.type==="text_delta");
  if(summary?.type!=="text_delta") throw new Error("Missing summary");
  const next=f.request("", "turn-b", [
    {type:"compaction", encrypted_content:encodeCompactionSummary(summary.text)},
    {type:"message",role:"user",id:"msg-turn-new",content:"A new current task.",internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}},
    ...(source._rawBody as {input: unknown[]}).input,
  ]);
  const before=f.submissions.length;
  const result=await f.run(next).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code}));
  expect(result).toMatchObject({ accepted: true });
  expect(f.submissions).toHaveLength(before + 1);
  expect(f.submissions.at(-1)?.prompt).toContain("A new current task.");
});

for (const manual of [false,true]) test(`Round 7: current native cross-task instruction remains usable on ordinary resume ${manual}`, async () => {
  const f=fixture(manual);
  const first=f.request("Original task.","turn-a");
  await f.run(first);
  const delegation={type:"function_call_output",id:"fco-delegation-current",name:"send_message_to_thread",namespace:"codex_app",
    output:"<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Perform the new delegated task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}};
  const next=f.request("","turn-b",[
    ...(first._rawBody as {input:unknown[]}).input,
    {type:"message",role:"assistant",content:"Completed response 1."},delegation,
  ]);
  const before=f.submissions.length;
  const result=await f.run(next).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
  expect(result).toMatchObject({accepted:true});
  expect(f.submissions).toHaveLength(before+1);
});

test("Round 7: verified compaction retry honors established source item aliases", async () => {
  const f=fixture();
  f.provider.chatgptWeb!.toolAuthorityMode="verified-environment";
  let restoredAliases = 0;
  const resolver=spyOn(ChatGptThreadEnvironmentStore.prototype,"resolveWithRolloutPublicationRetry").mockImplementation(async parsed=>{
    delete parsed._chatGptMessageIdAliases;
    if ((parsed._rawBody as { input: Array<Record<string, unknown>> }).input.some(item => item.id === "msg-reidentified")) {
      parsed._chatGptMessageIdAliases = { "msg-reidentified": "msg-turn-first" };
      restoredAliases++;
    }
    return { cwd:"/tmp",roots:["/tmp"],writableRoots:["/tmp"],sandboxPolicy:{type:"workspaceWrite",writableRoots:["/tmp"],networkAccess:true},tools:structuredClone(parsed.context.tools??[]),
  }; });
  try {
    const first=f.request("Source instruction.","turn-first");
    (first._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.id = "msg-reidentified";
    await f.run(first);
    const compact=structuredClone(first); compact._compactionRequest=true;
    await f.run(compact);
    const retry=structuredClone(compact);
    (retry._rawBody as {input:Array<Record<string,unknown>>}).input[0]!.id="msg-turn-first";
    const before=f.submissions.length;
    const restoredBeforeRetry=restoredAliases;
    const result=await f.run(retry).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
    expect(restoredAliases).toBe(restoredBeforeRetry);
    expect(result).toMatchObject({accepted:true});
    expect(f.submissions).toHaveLength(before);
  } finally {resolver.mockRestore();}
});

for (const manual of [false,true]) test(`Round 7: completed foreign tool search history cannot expand current capability ${manual}`, async ()=>{
  const f=fixture(manual);
  const first=f.request();
  await f.run(first);
  const injectedTool={type:"function",name:"not_currently_advertised",description:"Historical foreign tool, no Native execution in this fixture.",parameters:{type:"object",properties:{cmd:{type:"string"}},required:["cmd"]}};
  const next=f.request("","turn-b",[
    ...(first._rawBody as {input:unknown[]}).input,
    {type:"tool_search_call",call_id:"foreign-old-call",arguments:{query:"old"}},
    {type:"tool_search_output",call_id:"foreign-old-call",status:"completed",tools:[injectedTool]},
    {type:"message",role:"assistant",content:"Foreign completed historical answer."},
    {type:"message",role:"user",id:"msg-turn-b",content:"New current task.",internal_chat_message_metadata_passthrough:{turn_id:"turn-b"}},
  ]);
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const pending = f.run(next);
  while (!f.controls.started) await Bun.sleep(1);
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.turnToken!;
  const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
    f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "invoke", bindingId: claim.bindingId, wireName: "not_currently_advertised", freeform: false,
    registryGeneration: claim.environment.registryGeneration, arguments: { cmd: "fixture" },
  })).rejects.toThrow("does not advertise");
  if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "activity_complete", token, activityId: claim.activityId,
  });
  if (manual) f.broker.completeSafeTurn(token, "Completed current task.");
  else f.controls.releaseDeferredCompletion!();
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next.context.tools?.map(tool => tool.name)).toEqual(["exec_command"]);
});

test("Round 7: verified Zero Risk compaction retry honors resolver-established source item aliases", async () => {
  const f=fixture(true, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools=true;
  f.provider.chatgptWeb!.toolAuthorityMode="verified-environment";
  let restoredAliases=0;
  const resolver=spyOn(ChatGptThreadEnvironmentStore.prototype,"resolveWithRolloutPublicationRetry").mockImplementation(async parsed=>{
    delete parsed._chatGptMessageIdAliases;
    const input=(parsed._rawBody as {input:Array<Record<string,unknown>>}).input;
    if (input.some(item=>item.id==="msg-reidentified")) {
      parsed._chatGptMessageIdAliases={"msg-reidentified":"msg-turn-first"};
      restoredAliases++;
    }
    return {cwd:"/tmp",roots:["/tmp"],writableRoots:["/tmp"],sandboxPolicy:{type:"workspaceWrite",writableRoots:["/tmp"],networkAccess:true},tools:structuredClone(parsed.context.tools??[])};
  });
  try {
    const first=f.request("Source instruction.","turn-first");
    await f.run(first);
    const source=chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call=source.outstanding()[0]!;
    const compact=f.request("","turn-compaction",[
      ...(first._rawBody as {input:unknown[]}).input,
      {type:"function_call",name:call.wireName,call_id:call.callId,arguments:'{"cmd":"fixture-command-not-executed-by-this-test"}'},
      {type:"function_call_output",call_id:call.callId,output:"Completed source result."},
    ]); compact._compactionRequest=true;
    await f.run(compact);
    const retry=structuredClone(compact);
    (retry._rawBody as {input:Array<Record<string,unknown>>}).input[0]!.id="msg-reidentified";
    const before=f.submissions.length;
    const result=await f.run(retry).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
    expect(restoredAliases).toBe(1);
    expect(result).toMatchObject({accepted:true});
    expect(f.submissions).toHaveLength(before);
  } finally {resolver.mockRestore();}
});

for (const manual of [false, true]) test(`Round 7: queued active-source compaction cancellation has no unhandled rejection ${manual}`, async () => {
  const f=fixture(manual); f.controls.invokeSourceTools=true; f.controls.singleSourceTool=true;
  const first=f.request(); await f.run(first);
  const source=chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call=source.outstanding()[0]!;
  const compact=f.request('', 'turn-compaction',[...(first._rawBody as {input:unknown[]}).input,{type:'function_call_output',call_id:call.callId,output:'Genuine source result.'}]);
  compact._compactionRequest=true;
  let release!:()=>void;
  const gate=source.runExclusive(()=>new Promise<void>(resolve=>{release=resolve;}));
  await Bun.sleep(0);
  compact._continuityHistoryRevision=0;
  const pending=f.run(compact).catch(error=>error);
  while (compact._continuityPageGeneration === undefined) await Bun.sleep(1);
  const key=`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(compact)}`;
  while(!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  const reason=new DOMException('Cancel queued active-source compaction','AbortError');
  const cancellation=cancelStructuredCompactionNativeTurn(f.threadId,'turn-compaction',reason);
  release(); await gate;
  expect(await pending).toBeInstanceOf(Error); await cancellation.settlement;
  expect(cancellation.cancelled).toBe(1);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.submissions).toHaveLength(1);
  expect(source.isActive()).toBe(true);
  expect(source.supersededError).toBeUndefined();
  await Bun.sleep(5);
});

for (const manual of [false, true]) test(`Round 7: current native cross-task instruction resumes after checkpoint ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-checkpoint", [
    ...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Completed source result." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-delegation", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "function_call_output", id: "fco-checkpoint-delegation", name: "send_message_to_thread", namespace: "codex_app",
      output: "<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Perform the checkpoint delegated task.</input></codex_delegation>",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-delegation" } },
  ]);
  const before = f.submissions.length;
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(before + 1);
  expect(f.submissions.at(-1)?.prompt).toContain("Perform the checkpoint delegated task.");
  await f.run(next);
  expect(f.submissions).toHaveLength(before + 1);
});

for (const manual of [false, true]) test(`Round 7: conflicting queued compaction result cannot register cancellation authority ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const make = (turnId: string, output: string) => {
    const parsed = f.request("", turnId, [
      ...(first._rawBody as { input: unknown[] }).input,
      recordedCall(call),
      { type: "function_call_output", call_id: call.callId, output },
    ]);
    parsed._compactionRequest = true;
    return parsed;
  };
  let release!: () => void;
  const gate = source.runExclusive(() => new Promise<void>(resolve => { release = resolve; }));
  await Bun.sleep(0);
  const original = make("compact-original", "Accepted result A.");
  const conflict = make("compact-conflict", "Conflicting result B.");
  const pending = f.run(original);
  original._continuityHistoryRevision = 0;
  while (original._continuityPageGeneration === undefined) await Bun.sleep(1);
  const key = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`;
  while (!existingStructuredCompactionRun(key)) await Bun.sleep(1);
  await expect(f.run(conflict)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const cancelled = cancelStructuredCompactionNativeTurn(f.threadId, "compact-conflict", new Error("Cancel unaccepted request"));
  expect(cancelled.cancelled).toBe(0);
  await cancelled.settlement;
  release();
  await gate;
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 2);
  expect(JSON.stringify(f.controls.toolResults[0])).toContain("Accepted result A.");
});

for (const manual of [false, true]) test(`Round 7: approved discovery survives checkpoint and current registry removal ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const spec = { type: "function", name: "discovered_checkpoint_tool", description: "Approved fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const first = parseRequest(raw);
  first._conversationPolicy = "task";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const search = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [spec] };
  const compact = parseRequest({ ...raw, input: [...raw.input, recordedCall(call), search],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-search-compact" }) } });
  compact._conversationPolicy = "task";
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  const nextRaw = { ...raw, input: [search, { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-after-search-checkpoint", content: "Use the approved checkpoint tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-search-checkpoint" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-search-checkpoint" }) } };
  const next = parseRequest(nextRaw);
  next._conversationPolicy = "task";
  f.controls.reviewWireName = "discovered_checkpoint_tool";
  f.controls.singleSourceTool = true;
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const current = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const nextCall = current.outstanding()[0]!;
  expect(nextCall.wireName).toBe("discovered_checkpoint_tool");
  // A currently removed tool still delivers its already admitted result exactly once.
  const removedRaw = { ...nextRaw, tools: [], input: [...nextRaw.input.slice(1),
    { type: "function_call_output", call_id: nextCall.callId, output: "Result from the previously admitted call." }] };
  const removed = parseRequest(removedRaw);
  removed._conversationPolicy = "task";
  expect((await f.run(removed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(removed.context.tools).toEqual([]);
  const binding = current.runtime.continuityBinding!;
  expect(binding.discoveredTools).toEqual([]);
  const count = f.controls.toolResults.length;
  await f.run(removed);
  expect(f.controls.toolResults).toHaveLength(count);
  // An old discovery copy cannot restore a permission that the current registry removed.
  f.controls.invokeSourceTools = false;
  const later = parseRequest({ ...raw, tools: [], input: [search,
    ...removedRaw.input.slice(0, -1), { type: "message", role: "assistant", content: "Completed previous work." },
    { type: "message", role: "user", id: "msg-after-removal", content: "Continue after removal.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-removal" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-removal" }) } });
  later._conversationPolicy = "task";
  await f.run(later);
  expect(later.context.tools).toEqual([]);
});

for (const manual of [false, true]) test(`Round 8: older accepted discovery cannot restore removed tools during compaction ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.repeatManualSourceTool = manual;
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as Record<string, unknown> & { input: unknown[]; tools: unknown[] };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const parse = (body: unknown) => {
    const parsed = parseRequest(body);
    parsed._conversationPolicy = "task";
    return parsed;
  };
  const first = parse(raw);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const firstCall = source.outstanding()[0]!;
  const spec = { type: "function", name: "removed_discovery_tool", description: "Removed fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  const search = { type: "tool_search_output", call_id: firstCall.callId, status: "completed", tools: [spec] };
  const resultRun = f.run(parse({ ...raw, input: [...raw.input, search] }));
  if (!manual && source.runtime.mode === "tools") {
    const progress = source.runtime.externalProgress;
    let snapshot = progress.snapshot();
    const prior = snapshot.lastToolBatchRevision;
    while (snapshot.lastToolBatchRevision === prior) snapshot = await progress.waitForChange(snapshot.revision);
    await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  }
  expect((await resultRun).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const secondCall = source.outstanding()[0]!;
  const removal = { type: "tool_search_output", call_id: secondCall.callId, status: "completed", tools: [] };
  const acceptedHistory = [...raw.input, recordedCall(firstCall), search, recordedCall(secondCall), removal];
  expect((await f.run(parse({ ...raw, tools: [], input: [...raw.input, removal] }))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = source.runtime.continuityBinding!;
  expect(binding.discoveredTools).toEqual([]);
  const compact = parse({ ...raw, tools: [], input: acceptedHistory });
  compact._compactionRequest = true;
  let marker: unknown;
  {
    if (manual) f.controls.invokeSourceTools = false;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing summary");
    marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  }
  expect(binding.discoveredTools).toEqual([]);
  const prefix = [search, marker];
  const next = parse({ ...raw, tools: [], input: [...prefix,
    { type: "message", role: "user", id: "msg-after-removal", content: "Continue with current tools.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-removal" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-removal" }) },
  });
  f.controls.invokeSourceTools = false;
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const pending = f.run(next);
  while (!f.controls.started) await Bun.sleep(1);
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.turnToken!;
  const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
    f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "invoke", bindingId: claim.bindingId, wireName: "removed_discovery_tool", freeform: false,
    registryGeneration: claim.environment.registryGeneration, arguments: { cmd: "fixture" },
  })).rejects.toThrow("does not advertise");
  if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "activity_complete", token, activityId: claim.activityId,
  });
  if (manual) f.broker.completeSafeTurn(token, "Completed current work.");
  else f.controls.releaseDeferredCompletion!();
  expect((await pending).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(next.context.tools).toEqual([]);
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const manual of [false, true]) for (const aliasedSource of (manual ? [false, true] : [false])) test(`Round 8: real verified source alias replays checkpoint continuation ${manual} original alias ${aliasedSource}`, async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-cont-alias-home-"));
  cleanups.push(async () => { rmSync(codexHome, { recursive: true, force: true }); });
  const f = fixture(manual, { mcpTransport: "in-process", codexHome, threadId: "019cbcc7-31b2-7028-a632-7f8118410711" });
  const turnId = "019cbcc7-31b2-7028-a632-7f8118410712";
  mkdirSync(join(codexHome, "sessions", "2026", "09", "30"), { recursive: true });
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T09-00-00-${f.threadId}.jsonl`);
  const append = (items: unknown[]) => writeFileSync(rolloutPath,
    readFileSync(rolloutPath, "utf8") + items.map(item => JSON.stringify(item)).join("\n") + "\n");
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: f.threadId, source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp", workspace_roots: ["/tmp"], approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  const request = (input: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({ ...f.request("", turnId, input)._rawBody as object,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: f.threadId, turn_id: turnId,
        agent_name: "/root", sandbox_mode: "danger-full-access", workspaces: { "/tmp": {} } }) },
    });
    parsed._conversationPolicy = "task";
    return parsed;
  };
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const sourceItem = { type: "message", role: "user", id: "msg-canonical-source", content: "Source instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } };
  const nativeSource = aliasedSource ? { ...sourceItem, id: "msg-initial-alias" } : sourceItem;
  // Both paths prove their original human source before compaction; turn permissions alone
  // cannot authenticate the canonical message. The aliased path also publishes its replacement.
  append([{ type: "response_item", payload: sourceItem }]);
  if (aliasedSource) append([{ type: "compacted", payload: { replacement_history: [nativeSource] } }]);
  const first = request([nativeSource]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  if (aliasedSource) expect(first._chatGptMessageIdAliases).toEqual({ "msg-initial-alias": sourceItem.id });
  const compact = request([nativeSource, recordedCall(call), { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const accepted = await f.run(request([marker, sourceItem]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const submissions = f.submissions.length;
  const renamed = { ...sourceItem, id: "msg-reidentified" };
  append([{ type: "response_item", payload: sourceItem }, { type: "compacted", payload: { replacement_history: [marker, renamed] } }]);
  const alias = request([marker, renamed]);
  expect(await f.run(alias)).toEqual(accepted);
  expect(alias._chatGptMessageIdAliases).toEqual({ "msg-reidentified": sourceItem.id });
  expect(f.submissions).toHaveLength(submissions);
  const conflicting = request([marker, { ...renamed, content: "Different current work." }]);
  await expect(f.run(conflicting)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
});

// Allow slower CI runners to complete all 600 sequential compaction requests.
for (const manual of [false, true]) test(`Round 10: cached compact codecs do not retain rewritten historical source evidence ${manual}`, async () => {
  const f = httpFixture(manual, false, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = manual;
  f.controls.singleSourceTool = manual;
  const parent = { type: "agent_message", id: "parent-current", author: "/root", recipient: "/root/child",
    content: "Current parent task.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const oldUser = (index: number) => ({ type: "message", role: "user", id: "old-user",
    content: [{ type: "input_text", text: `Older human text ${index}.` }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-older" } });
  const metadata = { thread_id: f.threadId, turn_id: "turn-first", subagent_kind: "thread_spawn", request_kind: "turn",
    parent_thread_id: "thread-parent", agent_name: "/root/child" };
  const body = { ...f.body, input: [oldUser(0), parent],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const first = await (await f.send(body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call");
  const result = call ? [call, { type: "function_call_output", call_id: call.call_id, output: "Accepted parent source result." }] : [];
  let checkpoint: unknown;
  let v1Output: unknown[] = [];
  for (let index = 0; index < 600; index += 1) {
    const format = index % 3;
    const compactBody = { ...body, input: [oldUser(index), parent, ...result,
      ...(format === 0 ? [{ type: "compaction_trigger" }]
        : format === 2 ? [{ type: "message", role: "user", content: COMPACT_PROMPT }] : [])],
      ...(format === 2 ? { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata,
        request_kind: "compaction", compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
      }) } } : {}),
    };
    const response = await f.send(compactBody, format === 1);
    expect(response.status).toBe(200);
    const output = (await response.json() as { output: unknown[] }).output;
    if (index === 0) checkpoint = output[0];
    if (index === 1) v1Output = output;
  }
  const probe = parseRequest({ ...body, input: [checkpoint] });
  routeChatGptWebRequest(probe, f.config);
  bindContinuityRequestScope(probe, chatGptWebExecutionNamespace(f.provider));
  const identity = extractChatGptTurnIdentity(probe);
  expect(isAcceptedCompactionContinuation(probe, identity, {
    itemId: parent.id, turnId: "turn-first", content: parent.content,
    instructionEnvelope: { role: "agent_message", author: parent.author, recipient: parent.recipient },
  })).toBe(true);
  for (let index = 0; index < 600; index += 1) {
    expect(isAcceptedCompactionContinuation(probe, identity, { itemId: "old-user", turnId: "turn-older",
      content: oldUser(index).content, instructionEnvelope: { role: "user" },
    })).toBe(index === 0);
  }
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), probe._continuityScope!)!;
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
  expect(f.submissions).toHaveLength(manual ? 1 : 2);
  expect(f.controls.toolResults).toHaveLength(manual ? 1 : 0);
  // A later codec replay can change its wire output, but it cannot enlarge committed evidence.
  expect(JSON.stringify(v1Output)).toContain("Older human text 1.");
}, 30_000);

for (const format of ["v1", "v2"] as const) test(`${format} task checkpoint preserves the delegated source when native history retains an older human instruction`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const previous = { type: "message", role: "user", id: "msg-older-human", content: [{ type: "input_text", text: "Earlier human task." }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-older-human" } };
  const delegation = { type: "function_call_output", id: "fco-current-delegation", name: "send_message_to_thread", namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Finish the delegated audit.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-delegation" } };
  const source = f.request("", "turn-delegation", [previous, delegation]);
  await f.run(source);
  const active = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(source)}`)!;
  const call = active.outstanding()[0]!;
  const compact = f.request("", "turn-checkpoint", [previous, delegation, recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Completed audit input." }]);
  compact._compactionRequest = true;
  const events = await f.run(compact);
  const summary = events.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing delegated checkpoint");
  const installed = format === "v1"
    ? buildCompactV1Output(extractCompactUserMessages([previous, delegation]), summary.text)
    : [previous, { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
  f.controls.invokeSourceTools = false;
  const resumed = f.request("", "turn-checkpoint", installed);
  bindContinuityRequestScope(resumed, chatGptWebExecutionNamespace(f.provider));
  expect(extractChatGptTurnUserRevision(resumed)).toBe(delegation.output);
  expect(chatGptCurrentInstructionRevision(resumed)?.itemId).toBe(delegation.id);
  expect(recoverCompactionInstruction(resumed, extractChatGptTurnIdentity(resumed))?.sourceWasDelegation).toBe(true);
  expect((await f.run(resumed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);

  // Producer extraction reads retained human bytes even when the summary repeats.
  const repeated = f.request("", "turn-checkpoint", installed);
  repeated._compactionRequest = true;
  bindContinuityRequestScope(repeated, chatGptWebExecutionNamespace(f.provider));
  expect(extractChatGptCompactV1SourceRevision(repeated, summary.text).itemId).toBe(previous.id);
  expect((await f.run(repeated)).find(event => event.type === "text_delta")).toEqual(summary);
  expect(f.submissions).toHaveLength(4);
  const steering = f.request("", "turn-new-scope", [...installed, {
    type: "message", role: "user", id: "msg-new-steering", content: "Use the new scope.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-new-scope" },
  }]);
  bindContinuityRequestScope(steering, chatGptWebExecutionNamespace(f.provider));
  expect(extractChatGptTurnUserRevision(steering)).toBe("Use the new scope.");
  expect((await f.run(steering)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(5);
  expect(f.submissions.at(-1)?.prompt).toContain("Use the new scope.");
});

async function seedDelegationCheckpoint(f: ReturnType<typeof fixture>, format: "v1" | "v2") {
  f.controls.invokeSourceTools = true;
  const human = { type: "message", role: "user", id: "older-human", content: [{ type: "input_text", text: "Earlier human task." }],
    internal_chat_message_metadata_passthrough: { turn_id: "older-human-turn" } };
  const delegation = { type: "function_call_output", id: "delegated-task", name: "send_message_to_thread", namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>Complete delegated work.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "delegated-turn" } };
  const original = f.request("", "delegated-turn", [human, delegation]);
  await f.run(original);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "consumer-turn", [human, delegation, recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Accepted delegated result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing delegated summary");
  const installed = format === "v1"
    ? buildCompactV1Output(extractCompactUserMessages([human, delegation]), summary.text)
    : [human, { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
  f.controls.invokeSourceTools = false;
  expect((await f.run(f.request("", "consumer-turn", installed))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(record, "The seed process must persist its checkpoint before exit.").toBeDefined();
  expect(record.historyRevision).toBe(1);
  expect(Object.values(record.checkpoints).some(checkpoint => checkpoint.summaryDigest === continuityDigest(summary.text)
    && checkpoint.sourceIdentity === delegation.id && checkpoint.continuation.state === "consumed"
    && checkpoint.continuation.consumerLogicalWorkId === record.currentWorkId)).toBe(true);
  return { installed, summary: summary.text, owner: record.owner, epoch: record.epoch,
    consumerId: record.currentWorkId, sourceId: Object.values(record.checkpoints)[0]!.sourceLogicalWorkId, pages: [...f.pages] };
}

for (const cleanupMode of ["release-page", "backend-exit"] as const) test(`delegation checkpoint fixture cleanup mode=${cleanupMode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-cleanup-"));
  const f = fixture(false, { root, threadId: "delegation-backend-restart", cleanupMode });
  let observed: ReturnType<typeof spyOn> | undefined;
  try {
    const seed = await seedDelegationCheckpoint(f, "v1");
    const bindings = continuityBindingsFor(f.statePath);
    const binding = bindings.observed(continuityDigest(f.threadId))!;
    const executionKey = binding.executionKey!;
    const consumer = chatGptTurnSessions.find(executionKey)!;
    await consumer.physicalSettlement;
    await consumer.waitForLogicalSettlement();
    const before = bindings.recoveryStore.get(binding.thread)!;
    const releases: Promise<number>[] = [];
    const release = launcherHost.releaseLauncherRetainedConversation;
    observed = spyOn(launcherHost, "releaseLauncherRetainedConversation").mockImplementation((...args) => {
      const result = release(...args);
      if (args[0] === f.descriptorPath) releases.push(result);
      return result;
    });
    cleanups.push(async () => {
      // clear() schedules release after physical settlement. Drain its real RPC
      // before stopping Launcher so the deletion cannot depend on socket timing.
      await Promise.resolve();
      await Promise.all(releases);
    });
    await disposeTestFixtures();
    await expect(fetch(f.descriptor.endpoint)).rejects.toThrow();
    if (cleanupMode === "release-page") {
      expect(releases.length).toBeGreaterThan(0);
      expect(f.pages.size).toBe(0);
      expect(bindings.recoveryStore.get(before.thread)).toBeUndefined();
    } else {
      const after = bindings.recoveryStore.get(before.thread);
      expect(after, "Backend exit must preserve its committed checkpoint.").toBeDefined();
      expect(after).toEqual(before);
      expect(releases).toHaveLength(0);
      expect([...f.pages]).toEqual(seed.pages);
      expect(bindings.observed(before.thread)).toBeUndefined();
      expect(chatGptTurnSessions.find(executionKey)).toBeUndefined();
    }
  } finally {
    observed?.mockRestore();
    await disposeTestFixtures();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend exit fixture cleanup rejects unfinished continuity work", async () => {
  const f = fixture(false, { cleanupMode: "backend-exit" });
  f.controls.invokeSourceTools = true;
  await f.run(f.request());
  const failure = await disposeTestFixtures().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.some(error => error instanceof Error
    && error.message === "Backend exit cleanup requires completed continuity work.")).toBe(true);
});

test.skipIf(!process.env.DELEGATION_RESTART_ROOT)("delegation restart child seed", async () => {
  const root = process.env.DELEGATION_RESTART_ROOT!;
  const launcherInstance = JSON.parse(process.env.DELEGATION_RESTART_LAUNCHER!);
  const f = fixture(false, { root, threadId: "delegation-backend-restart", launcherInstance, cleanupMode: "backend-exit" });
  const seed = await seedDelegationCheckpoint(f, process.env.DELEGATION_RESTART_FORMAT as "v1" | "v2");
  writeFileSync(join(root, "delegation-seed.json"), JSON.stringify(seed));
}, 30000);

async function repeatDelegationCheckpoint(f: ReturnType<typeof fixture>, seed: any, format: "v1" | "v2", round: number, scenario: string) {
  const bindings = continuityBindingsFor(f.statePath);
  const before = bindings.recoveryStore.get(continuityDigest(f.threadId))!;
  const submissions = f.submissions.length;
  for (const change of ["human", "source", "summary", "payload", "steering"] as const) {
    const input = structuredClone(seed.installed);
    if (change === "human") input[0].content = [{ type: "input_text", text: "Changed retained human task." }];
    if (change === "source") input[0].id = "foreign-source";
    if (change === "summary") {
      if (format === "v2") input.at(-1).encrypted_content = encodeCompactionSummary(`${seed.summary}\nChanged accepted summary.`);
      else input.at(-1).content = [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${seed.summary}\nChanged accepted summary.` }];
    }
    if (change === "steering") input.push({ type: "message", role: "user", id: "new-steering", content: "Stop the delegated task.",
      internal_chat_message_metadata_passthrough: { turn_id: "consumer-turn" } });
    const invalid = f.request("", "consumer-turn", input);
    invalid._compactionRequest = true;
    if (change === "payload") (invalid._rawBody as Record<string, unknown>).instructions = "Changed current execution constraints.";
    if (change === "steering") expect(extractChatGptTurnUserRevision(invalid)).toBe("Stop the delegated task.");
    await expect(withContinuitySourceDiagnostics(invalid, { scenario, format, round, change, statePath: f.statePath,
      threadId: f.threadId, submissions: () => f.submissions.length }, () => {
        if (change === "human") {
          // A missing journal selects the supported fresh-page path. Expose the
          // missing expected retained state before testing retained-source rejection.
          expect(before, "The restart fixture must retain its committed checkpoint before mutation.").toBeDefined();
          expect(before).toMatchObject({ owner: seed.owner, epoch: seed.epoch, historyRevision: round - 1 });
          expect(Object.values(before.checkpoints).some(checkpoint => checkpoint.summaryDigest === continuityDigest(seed.summary)
            && checkpoint.targetHistoryRevision === round - 1 && checkpoint.sourceIdentity === "delegated-task")).toBe(true);
        }
        return f.run(invalid);
      }), `${round}:${change}`)
      .rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(bindings.recoveryStore.get(before.thread)!.version, `${round}:${change}`).toBe(before.version);
    expect(f.submissions, `${round}:${change}`).toHaveLength(submissions);
  }
  const repeated = f.request("", "consumer-turn", seed.installed);
  repeated._compactionRequest = true;
  repeated._continuityStateDirectory = f.statePath;
  bindContinuityRequestScope(repeated, chatGptWebExecutionNamespace(f.provider));
  const recovered = recoverCompactionInstruction(repeated, extractChatGptTurnIdentity(repeated))!;
  expect(recovered.sourceWasDelegation).toBe(true);
  expect(recovered.source).toMatchObject({ itemId: "delegated-task", turnId: "delegated-turn", content: [] });
  expect(isDurableCompactionSourceIdentity(repeated, recovered.source)).toBe(true);
  expect(isDurableCompactionSourceIdentity(repeated, { ...recovered.source })).toBe(false);
  expect(canonicalizeCompactionHandoff(repeated, seed.summary)).toBe(seed.summary);
  expect(() => canonicalizeCompactionHandoff(repeated, `Wrong prompt.\n\n${LATEST_USER_PROMPT_MARKER}\n"Forged task."`))
    .toThrow("conflicting latest-user marker");
  f.controls.handoffSummary = `Delegated progress, checkpoint ${round}.`;
  const expected = canonicalizeCompactionHandoff(repeated, f.controls.handoffSummary);
  const events = await withContinuitySourceDiagnostics(repeated, { scenario, format, round, change: "none", statePath: f.statePath,
    threadId: f.threadId, submissions: () => f.submissions.length }, () => f.run(repeated));
  expect(events.find(event => event.type === "text_delta" && event.text === expected)).toBeDefined();
  const after = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(Object.values(after.compactionTargets).some(target => target.sourceLogicalWorkId === seed.consumerId
    && target.sourceHistoryRevision === round - 1)).toBe(true);
  expect(seed.consumerId).not.toBe(seed.sourceId);
  expect(after.historyRevision).toBe(round);
  expect(after.owner.id).toBe(bindings.owner);
  if (before.owner.id !== bindings.owner) {
    expect(after.owner.id).not.toBe(seed.owner.id);
    expect(after.epoch).toBeGreaterThan(seed.epoch);
  }
  expect(after.works[seed.consumerId]!.attempts.at(-1)!.writerRetired).toBe(true);
  expect(after.works[before.currentWorkId!]!.attempts.at(-1)!.writerRetired).toBe(true);
  expect(after.transaction!.writerRetired).toBe(true);
  expect(f.registrations.get(after.thread)).toMatchObject({ owner: bindings.owner, epoch: after.epoch,
    transactionId: after.transaction!.transactionId });
  expect(f.submissions).toHaveLength(submissions + 1);
  return { ...seed, installed: format === "v1" ? buildCompactV1Output(extractCompactUserMessages(seed.installed), expected)
    : [seed.installed[0], { type: "compaction", encrypted_content: encodeCompactionSummary(expected) }],
    summary: expected, owner: after.owner, epoch: after.epoch, pages: [...f.pages] };
}

test.skipIf(!process.env.DELEGATION_RESTART_ROOT)("delegation restart child repeat", async () => {
  const root = process.env.DELEGATION_RESTART_ROOT!;
  const seed = JSON.parse(readFileSync(join(root, "delegation-seed.json"), "utf8"));
  const launcherInstance = JSON.parse(process.env.DELEGATION_RESTART_LAUNCHER!);
  const f = fixture(false, { root, threadId: "delegation-backend-restart", launcherInstance, cleanupMode: "backend-exit" });
  for (const [key, page] of seed.pages) f.pages.set(key, page);
  f.controls.queryIncludesContinuity = true;
  expect(continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))).toBeUndefined();
  const next = await repeatDelegationCheckpoint(f, seed, process.env.DELEGATION_RESTART_FORMAT as "v1" | "v2", 2, "restart-child-repeat");
  writeFileSync(join(root, "delegation-next.json"), JSON.stringify(next));
}, 30000);

for (const format of ["v1", "v2"] as const) for (const restartAgain of [false, true]) test(`${format} delegated continuation can compact again after the backend process exits; second exit=${restartAgain}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-restart-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const launcher = continuityProcessInstance();
  const launcherInstance = { pid: launcher.pid, startIdentity: launcher.startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : launcher.startIdentity, instanceId: "a".repeat(64) };
  const log = Bun.file(join(root, "child.log"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^delegation restart child seed$"], {
    env: { ...process.env, DELEGATION_RESTART_ROOT: root, DELEGATION_RESTART_FORMAT: format,
      DELEGATION_RESTART_LAUNCHER: JSON.stringify(launcherInstance) }, stdout: log, stderr: log,
  });
  expect(await child.exited, await log.text()).toBe(0);
  let seed = JSON.parse(readFileSync(join(root, "delegation-seed.json"), "utf8"));
  expect(["exited", "unverified"]).toContain(continuityProcessInstanceStatus(seed.owner));
  if (restartAgain) {
    const nextLog = Bun.file(join(root, "repeat-child.log"));
    const nextChild = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^delegation restart child repeat$"], {
      env: { ...process.env, DELEGATION_RESTART_ROOT: root, DELEGATION_RESTART_FORMAT: format,
        DELEGATION_RESTART_LAUNCHER: JSON.stringify(launcherInstance) }, stdout: nextLog, stderr: nextLog,
    });
    expect(await nextChild.exited, await nextLog.text()).toBe(0);
    const next = JSON.parse(readFileSync(join(root, "delegation-next.json"), "utf8"));
    expect(["exited", "unverified"]).toContain(continuityProcessInstanceStatus(next.owner));
    expect(next.owner.id).not.toBe(seed.owner.id);
    seed = next;
  }
  const f = fixture(false, { root, threadId: "delegation-backend-restart", launcherInstance });
  for (const [key, page] of seed.pages) f.pages.set(key, page);
  f.controls.queryIncludesContinuity = true;
  const bindings = continuityBindingsFor(f.statePath);
  expect(bindings.observed(continuityDigest(f.threadId))).toBeUndefined();
  if (!restartAgain) seed = await repeatDelegationCheckpoint(f, seed, format, 2, `recompact:second-exit=${restartAgain}`);
  await repeatDelegationCheckpoint(f, seed, format, 3, `recompact:second-exit=${restartAgain}`);
}, 30000);

for (const manual of [false, true]) for (const checkpoint of [false, true]) for (const olderPrefix of [false, true]) test(`native AGENTS refresh reaches the healthy increment: manual=${manual} checkpoint=${checkpoint} older-prefix=${olderPrefix}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = checkpoint;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  let base = (f.next(first)._rawBody as { input: unknown[] }).input;
  if (checkpoint) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const call = source.outstanding()[0]!;
    const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      recordedCall(call), { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing source summary");
    base = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, base.at(-1)];
    f.controls.invokeSourceTools = false;
  }
  const refresh = { type: "message", role: "user", id: "agents-refresh", content: [
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>KEEP_NEW_AGENTS_RULE.</INSTRUCTIONS>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: olderPrefix ? "turn-created-earlier" : "turn-next",
    content_item_kinds: ["agents_md.instructions"] } };
  const input = olderPrefix ? checkpoint ? [base[0], refresh, base.at(-1)] : [refresh, ...base]
    : [...base.slice(0, -1), refresh, base.at(-1)];
  const next = f.request("", "turn-next", input);
  expect(chatGptCurrentInstructionRevision(next)?.itemId).toBe("msg-turn-next");
  const changed = structuredClone(input) as Array<Record<string, any>>;
  changed.find(item => item.id === refresh.id)!.content[0].text = "# AGENTS.md instructions\n<INSTRUCTIONS>CHANGED_AGENTS_RULE.</INSTRUCTIONS>";
  const changedRequest = f.request("", "turn-next", changed);
  const previous = checkpoint ? { instructionIdentity: "msg-turn-first", nativeTurnId: "turn-first",
    checkpointDigest: continuityCheckpoint(next).digest } : undefined;
  expect(chatGptContinuityInstructionPayloadDigest(next, previous))
    .not.toBe(chatGptContinuityInstructionPayloadDigest(changedRequest, previous));
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions.at(-1)!.prompt.match(/KEEP_NEW_AGENTS_RULE\./g)).toHaveLength(1);
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  await expect(f.run(changedRequest)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
});

for (const format of ["v1", "v2"] as const) for (const ownership of ["item", "turn", "window"] as const) test(`${format} recovered delegation checkpoint admits a new ordinary task; ownership=${ownership}`, async () => {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-r3-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const launcher = continuityProcessInstance();
  expect(launcher.startIdentity).not.toBe("unverified");
  const launcherInstance = { pid: launcher.pid, startIdentity: launcher.startIdentity, instanceId: "a".repeat(64) };
  const log = Bun.file(join(root, "child.log"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^delegation restart child seed$"], {
    env: { ...process.env, DELEGATION_RESTART_ROOT: root, DELEGATION_RESTART_FORMAT: format,
      DELEGATION_RESTART_LAUNCHER: JSON.stringify(launcherInstance) },
    stdout: log, stderr: log,
  });
  expect(await child.exited, await log.text()).toBe(0);
  const seed = JSON.parse(readFileSync(join(root, "delegation-seed.json"), "utf8"));
  expect(continuityProcessInstanceStatus(seed.owner)).toBe("exited");
  const f = fixture(false, { root, threadId: "delegation-backend-restart", launcherInstance });
  for (const [key, page] of seed.pages) f.pages.set(key, page);
  f.controls.queryIncludesContinuity = true;
  const bindings = continuityBindingsFor(f.statePath);
  expect(bindings.observed(continuityDigest(f.threadId))).toBeUndefined();
  const current = await repeatDelegationCheckpoint(f, seed, format, 2, `new-ordinary:ownership=${ownership}`);
  const binding = bindings.observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("ready");
  expect(binding.executionKey).toBeUndefined();
  expect([...binding.checkpoints.values()].every(checkpoint => checkpoint.sourceInstructionReplay === undefined)).toBe(true);
  const newUser = { type: "message", role: "user", id: "new-ordinary-task", content: [
    { type: "input_text", text: "Review the second component after recovery." },
  ], internal_chat_message_metadata_passthrough: { turn_id: "new-ordinary-turn", content_item_kinds: ["user.text"] } };
  const nativeUser: Record<string, unknown> = { ...newUser };
  if (ownership === "turn") delete nativeUser.id;
  if (ownership === "window") delete nativeUser.internal_chat_message_metadata_passthrough;
  const instructionIdentity = ownership === "turn" ? "turn:new-ordinary-turn" : newUser.id;
  const agents = { type: "message", role: "user", id: "new-ordinary-agents", content: [
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>KEEP_RECOVERED_TASK_RULE.</INSTRUCTIONS>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: "new-ordinary-turn", content_item_kinds: ["agents_md.instructions"] } };
  const environment = { type: "message", role: "user", id: "new-ordinary-environment", content: [
    { type: "input_text", text: "<environment_context><cwd>/tmp/recovered-workspace</cwd><shell>zsh</shell></environment_context>" },
  ], internal_chat_message_metadata_passthrough: { turn_id: "new-ordinary-turn", content_item_kinds: ["environments.environment_context"] } };
  const context = ownership === "window"
    ? [{ type: "message", role: "user", id: agents.id, content: [...agents.content, ...environment.content] }]
    : [agents, environment];
  const input = [...current.installed, ...context, nativeUser];
  const before = bindings.recoveryStore.get(binding.thread)!;
  const sends = f.submissions.length;
  for (const change of ["stale", "request-turn", "message-turn", "summary-turn", "source", "source-text", "source-turn", "sibling"] as const) {
    const invalidInput = structuredClone(input);
    if (change === "stale") invalidInput.splice(0, current.installed.length, ...structuredClone(seed.installed));
    if (change === "request-turn") invalidInput.at(-1).internal_chat_message_metadata_passthrough = newUser.internal_chat_message_metadata_passthrough;
    if (change === "message-turn") invalidInput.at(-1).internal_chat_message_metadata_passthrough = { turn_id: "foreign-turn", content_item_kinds: ["user.text"] };
    if (change === "summary-turn") invalidInput[current.installed.length - 1].internal_chat_message_metadata_passthrough = { turn_id: "foreign-turn" };
    if (change === "source") invalidInput[0].id = "foreign-source";
    if (change === "source-text") invalidInput[0].content[0].text += " Changed retained human.";
    if (change === "source-turn") invalidInput[0].internal_chat_message_metadata_passthrough.turn_id = "foreign-turn";
    if (change === "sibling") invalidInput.splice(1, 0, { type: "message", role: "user", id: "unaccepted-sibling", content: "A different old task.",
      internal_chat_message_metadata_passthrough: { turn_id: "consumer-turn" } });
    await expect(f.run(f.request("", change === "request-turn" ? "foreign-request-turn" : "new-ordinary-turn", invalidInput)), change)
      .rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(bindings.recoveryStore.get(binding.thread)!.version, change).toBe(before.version);
    expect(f.submissions, change).toHaveLength(sends);
  }
  const next = f.request("", "new-ordinary-turn", input);
  expect(chatGptCurrentInstructionRevision(next)?.itemId).toBe(ownership === "turn" ? undefined : newUser.id);
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(sends + 1);
  expect(f.submissions.at(-1)!.reused).toBe(true);
  expect(f.submissions.at(-1)!.prompt).toContain(newUser.content[0]!.text);
  expect(f.submissions.at(-1)!.prompt.match(/KEEP_RECOVERED_TASK_RULE\./g)).toHaveLength(1);
  expect(f.submissions.at(-1)!.prompt).toContain("/tmp/recovered-workspace");
  const after = bindings.recoveryStore.get(binding.thread)!;
  expect(after.owner.id).toBe(bindings.owner);
  expect(after.epoch).toBe(before.epoch);
  expect(after.historyRevision).toBe(2);
  const work = after.works[after.currentWorkId!]!;
  expect(work).toMatchObject({ instructionIdentity, nativeTurnId: "new-ordinary-turn", purpose: "ordinary", state: "completed" });
  expect(work.allowRetainedSourceFallback).toBe(false);
  expect(work.workLineageId).not.toBe(after.works[current.consumerId]!.workLineageId);
  expect(after.works[before.currentWorkId!]!.attempts.at(-1)!.writerRetired).toBe(true);
  expect(f.registrations.get(after.thread)).toMatchObject({ owner: bindings.owner, epoch: after.epoch, transactionId: before.transaction!.transactionId });
  expect(f.submissions.at(-1)!.claim.recovery).toMatchObject({ logicalWorkId: work.logicalWorkId,
    transactionId: after.transaction!.transactionId, epoch: after.epoch });
  expect(await f.run(f.request("", "new-ordinary-turn", structuredClone(input)))).toEqual(accepted);
  expect(bindings.recoveryStore.get(after.thread)!.version).toBe(after.version);
  for (const change of ["text", "agents"] as const) {
    const changed = structuredClone(input);
    const target = change === "text" ? changed.at(-1) : changed.find(item => item.id === agents.id);
    target.content[0].text += " Changed accepted payload.";
    await expect(f.run(f.request("", "new-ordinary-turn", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(bindings.recoveryStore.get(after.thread)!.version).toBe(after.version);
    expect(f.submissions).toHaveLength(sends + 1);
  }
  for (const change of ["stale", "text", "agents", "source", "message-turn", "sibling"] as const) {
    const changed = structuredClone(input);
    if (change === "stale") changed.splice(0, current.installed.length, ...structuredClone(seed.installed));
    if (change === "text") changed.at(-1).content[0].text += " Changed compaction source.";
    if (change === "agents") changed.find(item => item.id === agents.id).content[0].text += " Changed compaction rules.";
    if (change === "source") changed.at(-1).id = "different-compaction-source";
    if (change === "message-turn") changed.at(-1).internal_chat_message_metadata_passthrough = {
      turn_id: "foreign-turn", content_item_kinds: ["user.text"] };
    if (change === "sibling") changed.splice(changed.length - 1, 0, { type: "message", role: "user", id: "new-unaccepted-sibling",
      content: "An unaccepted current task.", internal_chat_message_metadata_passthrough: { turn_id: "new-ordinary-turn" } });
    const invalid = f.request("", "new-ordinary-turn", changed);
    invalid._compactionRequest = true;
    await expect(f.run(invalid), change).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(bindings.recoveryStore.get(after.thread)!.version, change).toBe(after.version);
    expect(f.submissions, change).toHaveLength(sends + 1);
  }
  f.controls.handoffSummary = "Checkpoint of the new ordinary task.";
  const compact = f.request("", "new-ordinary-turn", input);
  compact._compactionRequest = true;
  bindContinuityRequestScope(compact, chatGptWebExecutionNamespace(f.provider));
  const newSource = extractChatGptCompactionSourceRevision(compact);
  expect(newSource).toMatchObject({ content: newUser.content });
  expect(compactionSourceWasDelegation(compact, newSource)).toBe(false);
  expect(isDurableCompactionSourceIdentity(compact, newSource)).toBe(false);
  const events = await f.run(compact);
  const summary = events.filter(event => event.type === "text_delta").at(-1);
  if (summary?.type !== "text_delta") throw new Error("Missing new ordinary checkpoint");
  expect(summary.text).toContain(JSON.stringify(newUser.content[0]!.text));
  expect(summary.text).not.toContain("Complete delegated work.");
  expect(f.submissions).toHaveLength(sends + 2);
  const committed = bindings.recoveryStore.get(after.thread)!;
  expect(committed.owner.id).toBe(bindings.owner);
  expect(committed.transaction!.writerRetired).toBe(true);
  expect(f.registrations.get(committed.thread)).toMatchObject({ owner: bindings.owner, epoch: committed.epoch,
    transactionId: ownership === "item" ? before.transaction!.transactionId : committed.transaction!.transactionId });
  // Delegated retained-source selection requires both item and native-turn metadata.
  // Its existing fresh-page fallback still compacts the real new task when either is absent.
  const retainedCompaction = ownership === "item";
  const revision = retainedCompaction ? 3 : 1;
  expect(committed.historyRevision).toBe(revision);
  const checkpoint = Object.values(committed.checkpoints).find(value => value.targetHistoryRevision === revision
    && value.sourceIdentity === instructionIdentity)!;
  expect(checkpoint).toBeDefined();
  expect(committed.works[`compaction:${checkpoint.compactionTargetId}`]!.attempts.at(-1)!.writerRetired).toBe(true);
  expect(committed.works[checkpoint.sourceLogicalWorkId]).toMatchObject({ instructionIdentity, nativeTurnId: "new-ordinary-turn" });
  if (retainedCompaction) expect(checkpoint.sourceLogicalWorkId).toBe(work.logicalWorkId);
  else expect(checkpoint.sourceLogicalWorkId).not.toBe(work.logicalWorkId);
  const installed = format === "v1" ? buildCompactV1Output(extractCompactUserMessages(input), summary.text)
    : [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
  const probe = f.request("", "new-ordinary-turn", installed);
  bindContinuityRequestScope(probe, chatGptWebExecutionNamespace(f.provider));
  const recovered = recoverCompactionInstruction(probe, extractChatGptTurnIdentity(probe))!;
  expect(recovered.sourceWasDelegation).toBe(false);
  expect(recovered.source).toMatchObject({ ...(ownership === "turn" ? {} : { itemId: newUser.id }),
    ...(ownership === "window" ? {} : { turnId: "new-ordinary-turn" }), content: newUser.content });
  expect(isDurableCompactionSourceIdentity(probe, recovered.source)).toBe(false);
}, 30000);
