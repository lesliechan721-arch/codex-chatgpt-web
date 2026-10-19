import { ContinuityRecoveryStore } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryIdentity } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import * as recoveryRuntime from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { afterEach, expect, spyOn } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { ContinuityTaskInputStore } from "../src/adapters/chatgpt-web/continuity-task-input-store";
import { taskUpdateDigest } from "../src/adapters/chatgpt-web/task-update-source";
import { leaveContinuityMode, stopDurableContinuity } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import * as configuration from "../src/config";
import { COMPACT_PROMPT, decodeCompactionSummary, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest, routeChatGptWebRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";
import { performanceTest } from "./helpers/performance-test";
import { createSessionContinuityFixtures, launcherRecovery, reverseJsonObjectKeys, codexRoundtrippedOutput } from "./helpers/session-continuity-fixture";

const test = performanceTest(import.meta.path);
const { cleanups, disposeTestFixtures, fixture, httpFixture } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

function repair6SourceHelper(f: ReturnType<typeof httpFixture>, boundary: "response" | "dom" | "unknown-send" | "unknown-send-healthy", fault: string): void {
  const script = join(f.root, "page-loss-helper.ts");
  writeFileSync(script, `
    import { existsSync, writeFileSync } from "node:fs";
    import { ChatGptBrowserWorker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-worker.ts"))};
    import { callTurnBroker } from ${JSON.stringify(resolve("src/adapters/chatgpt-web/turn-broker.ts"))};
    ChatGptBrowserWorker.prototype.runBrowserTurn = async function(turn) {
      const compiled = await turn.prepare();
      await turn.onSendActivated();
      if (${JSON.stringify(boundary)}.startsWith("unknown-send")) {
        writeFileSync(${JSON.stringify(`${fault}.send-possible`)}, "ready");
        while (!existsSync(${JSON.stringify(fault)})) await new Promise(resolve => setTimeout(resolve, 5));
        if (${JSON.stringify(boundary)} === "unknown-send-healthy") throw new Error("fixture submission confirmation unavailable");
        this.activeComposer = async () => ({ locator: () => ({ locator: () => ({ waitFor: async () => {} }) }) });
        return this.sendAttachedPrompt({ isClosed: () => true }, {});
      }
      await turn.onSubmitted();
      const token = compiled.turnToken;
      const claim = await callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, { method: "claim", token });
      const result = callTurnBroker(${JSON.stringify(f.provider.chatgptWeb!.brokerSocketPath)}, {
        method: "invoke", bindingId: claim.bindingId, registryGeneration: claim.environment.registryGeneration,
        wireName: "exec_command", freeform: false, arguments: { cmd: "inert-page-loss-source" },
      }, null);
      void result.catch(() => {});
      await Promise.race([result.then(() => { throw new Error("Source unexpectedly completed without an outer result"); }), (async () => {
        let progress = turn.externalProgress.snapshot();
        while (!progress.lastToolBatchRevision) progress = await turn.externalProgress.waitForChange(progress.revision, turn.abortSignal);
        await turn.externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      })()]);
      while (!existsSync(${JSON.stringify(fault)})) await new Promise(resolve => setTimeout(resolve, 5));
      const page = { isClosed: () => true };
      if (${JSON.stringify(boundary)} === "dom") return this.responseDomSnapshot({
        evaluate: async () => { throw new Error("fixture renderer crashed"); }, page: () => page,
      });
      return this.waitForNewAssistantTurn(page, {}, Date.now() + 1000);
    };
    await import(${JSON.stringify(resolve("src/adapters/chatgpt-web/browser-helper-main.ts"))});
  `);
  f.provider.chatgptWeb!.browserHelperScriptPath = script;
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
  cleanups.push(async () => { taskUpdates.mockRestore(); await (worker as unknown as { launcherHelper?: { close(): Promise<void> } }).launcherHelper?.close(); });
}

for (const taskUpdates of [false, true]) test(`page lifetime: closed helper with pending update restores without old ACK taskUpdates=${taskUpdates}`, async () => {
  const f = httpFixture(false, taskUpdates);
  f.controls.invokeSourceTools = true; f.controls.nativeSourceTools = taskUpdates; f.controls.singleSourceTool = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!, ref = structuredClone(binding.recovery!);
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const oldIdentity = recoveryIdentity(bindings.recoveryStore.get(thread)!, bindings.recoveryStore.installationId());
  f.pages.clear(); bindings.forgetPage(binding, binding.executionKey);
  expect(bindings.observed(thread)).toBeUndefined(); expect(chatGptTurnSessions.find(binding.executionKey!)).toBeUndefined();
  expect(recoveryRuntime.settleRecoveryFailure(ref)).toBe(false);
  f.controls.invokeSourceTools = false;
  const result = { type: "function_call_output", call_id: call.call_id, output: "Current request carries the real result." };
  const response = await f.send({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result,
    { type: "message", role: "user", id: "current-after-page-close", content: "Complete the current task. Do not repeat the old call.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } }] });
  expect(response.status, await response.clone().text()).toBe(200); expect((await response.json()).status).toBe("completed");
  expect(() => bindings.recoveryStore.assertExecutionAuthority(oldIdentity)).toThrow();
  expect(recoveryRuntime.settleRecoveryFailure(ref, "page-close")).toBe(false);
  expect(Object.keys(bindings.recoveryStore.get(thread)!.calls)).toHaveLength(0);
  expect(f.submissions).toHaveLength(2); expect(f.controls.toolResults).toHaveLength(0);
  await source.physicalSettlement;
});

for (const boundary of ["response", "dom"] as const) for (const userClosed of [false, true]) {
  test(`repair6: public HTTP waits for actual helper ${boundary} page-loss settlement before source recovery (user-close=${userClosed})`, async () => {
    const f = httpFixture();
    f.body.model = "chatgpt-web/gpt-6-sol-instant"; f.body.reasoning = { effort: "low" };
    const fault = join(f.root, "renderer-crashed");
    repair6SourceHelper(f, boundary, fault);
    const response = await f.send(f.body);
    expect(response.status).toBe(200);
    const first = await response.json() as { output: Array<Record<string, unknown>> };
    const call = first.output.find(item => item.type === "function_call")!;
    expect(call).toBeDefined();
    const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
    const original = store.get(thread)!;
    expect(original.calls[String(call.call_id)]!.state).toBe("delivery-possible");
    const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
    f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "physical page absent");
    await source.browserOutcome; await source.physicalSettlement;
    expect(f.controls.helperStarts).toBe(1); expect(f.controls.helperEnds).toBe(1);
    expect(store.get(thread)).toBeUndefined();
    expect(continuityBindingsFor(f.statePath).observed(thread)).toBeUndefined();
    expect(chatGptTurnSessions.find(source.runtime.continuityBinding!.executionKey!)).toBeUndefined();
    // Return to the successor fixture only after the actual helper IPC settles.
    delete f.provider.chatgptWeb!.browserHelperScriptPath;
    f.controls.invokeSourceTools = false;
    const result = { type: "function_call_output", call_id: call.call_id, output: "Actual settled page-loss source result." };
    const continuation = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
    const recovered = await f.send(continuation);
    expect(recovered.status, await recovered.clone().text()).toBe(200); expect((await recovered.json()).status).toBe("completed");
    const after = store.get(thread)!;
    expect(after.currentWorkId).not.toBe(original.currentWorkId);
    expect(after.epoch).not.toBe(original.epoch);
    expect(after.works[after.currentWorkId!]!.attempts).toHaveLength(1);
    expect(Object.keys(after.calls)).toHaveLength(0);
    expect(f.submissions).toHaveLength(1); expect(f.submissions[0]!.reused).toBe(false);
    expect((await (await f.send(continuation)).json()).status).toBe("completed");
    expect(f.submissions).toHaveLength(1);
  }, 30_000);
}

for (const closedBeforeHelperTerminal of [false, true]) test(`repair6: public helper page loss revokes unknown Send and accepts the current request (closed-before-terminal=${closedBeforeHelperTerminal})`, async () => {
  const f = httpFixture(), fault = join(f.root, "unknown-send-fault");
  repair6SourceHelper(f, closedBeforeHelperTerminal ? "unknown-send" : "unknown-send-healthy", fault);
  const pending = f.send(f.body); void pending.catch(() => {});
  for (let i = 0; i < 1000 && !await Bun.file(`${fault}.send-possible`).exists(); i++) await Bun.sleep(10);
  expect(await Bun.file(`${fault}.send-possible`).exists()).toBe(true);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const binding = continuityBindingsFor(f.statePath).observed(thread)!, lease = structuredClone(binding.lease!);
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const original = store.get(thread)!;
  expect(original.works[original.currentWorkId!]!.attempts[0]!.sendEvidence?.status).toBe("possible");
  const closeOriginalPage = () => {
    // Model the Launcher losing this exact physical page, without removing a successor.
    const key = binding.conversation!.key;
    expect(f.pages.get(key)?.continuity).toEqual(lease);
    expect(source.traceId).toBe(lease.traceId);
    expect(f.pages.delete(key)).toBe(true);
  };
  if (closedBeforeHelperTerminal) closeOriginalPage();
  // The helper cannot observe its closed Page until the matching Launcher page is absent.
  writeFileSync(fault, closedBeforeHelperTerminal ? "physical page absent" : "healthy page; submission unresolved");
  const response = await pending;
  expect(response.status).toBe(200); expect((await response.json()).status).toBe("failed");
  await source.physicalSettlement;
  delete f.provider.chatgptWeb!.browserHelperScriptPath;
  if (!closedBeforeHelperTerminal) {
    expect(f.pages.get(binding.conversation!.key)?.continuity).toEqual(lease);
    expect(store.get(thread)!.works[original.currentWorkId!]!.attempts[0]!.sendEvidence?.status).toBe("possible");
    const unresolved = await f.send(f.body);
    expect(unresolved.status).toBe(200); expect((await unresolved.json()).status).toBe("failed");
    expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
    closeOriginalPage();
  }
  const recovered = await f.send(f.body);
  expect(recovered.status, await recovered.clone().text()).toBe(200); expect((await recovered.json()).status).toBe("completed");
  expect(store.get(thread)!.epoch).not.toBe(original.epoch);
  expect(store.get(thread)!.works[store.get(thread)!.currentWorkId!]!.attempts).toHaveLength(1);
  expect(f.controls.helperStarts).toBe(1); expect(f.controls.helperEnds).toBe(1); expect(f.submissions).toHaveLength(1);
}, 30_000);

for (const target of ["same-work", "new-work"] as const) for (const userClosed of [false, true]) test(`repair6: late original helper failure cannot mutate a ${target} successor (user-close=${userClosed})`, async () => {
  const f = httpFixture(), fault = join(f.root, "late-old-helper-fault");
  repair6SourceHelper(f, "response", fault);
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!, work = before.works[before.currentWorkId!]!;
  const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
  const result = { type: "function_call_output", call_id: call.call_id, output: "Original outer result settled before withdrawal." };
  const parsed = parseRequest({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] });
  routeChatGptWebRequest(parsed, f.config);
  expect(source.acceptContinuityToolResults(parsed)).toHaveLength(1);
  expect(store.get(thread)!.calls[String(call.call_id)]!.state).toBe("settled");
  let successor;
  if (target === "same-work") {
    store.retireAttempt(thread, { scope: before!.scope }, work.logicalWorkId, 0);
    successor = store.reserveRecovery(thread, { scope: before!.scope }, {
      logicalWorkId: work.logicalWorkId, owner: before!.owner, snapshotDigest: work.attempts[0]!.snapshotDigest,
    });
  } else {
    source.cancel();
    successor = store.admitWork({ thread, scope: before!.scope, owner: before!.owner,
      logicalWorkId: "new-task-after-interrupt", nativeTurnId: "new-native-turn", instructionIdentity: "new-native-instruction",
      workPayloadDigest: "1".repeat(64), snapshotDigest: "2".repeat(64), createPage: true, dispatchProtocolComplete: true });
  }
  f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "old page absent after withdrawal");
  await source.browserOutcome; await source.physicalSettlement;
  expect(store.get(thread)).toEqual(successor);
  expect(store.get(thread)!.works[successor.currentWorkId!]!.state).toBe("prepared");
  expect(store.get(thread)!.works[successor.currentWorkId!]!.attempts).toHaveLength(target === "same-work" ? 2 : 1);
  if (target === "new-work") expect(store.get(thread)!.works[work.logicalWorkId]!.state).toBe("stopped");
  expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
}, 30_000);

test("repair6: native Interrupt stops the original task before a late physical loss", async () => {
  const f = httpFixture(), fault = join(f.root, "interrupted-helper-fault");
  repair6SourceHelper(f, "response", fault);
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  // These are the ordered durable-stop and exact native cancellation used by /admin/interrupt-turn.
  expect(stopDurableContinuity(f.statePath, f.threadId, "turn-first", "native-interrupt")).toBe(true);
  const cancellation = chatGptTurnSessions.cancelNativeTurn(f.threadId, "turn-first", new DOMException("Codex turn interrupted", "AbortError"));
  expect(cancellation.cancelled).toBe(1);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), stopped = store.get(thread)!;
  expect(stopped.works[stopped.currentWorkId!]!.stopReason).toBe("native-interrupt");
  writeFileSync(fault, "page absent after interrupt");
  await source.browserOutcome; await source.physicalSettlement; await cancellation.settlement;
  expect(store.get(thread)).toEqual(stopped);
  delete f.provider.chatgptWeb!.browserHelperScriptPath;
  const recovered = await f.send({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
    { type: "function_call_output", call_id: first.output.find(item => item.type === "function_call")!.call_id, output: "Real stopped call result." }] });
  expect(recovered.status).toBe(200); expect((await recovered.json()).status).toBe("completed");
  expect(store.get(thread)!.works[stopped.currentWorkId!]).toBeUndefined();
  expect(f.submissions).toHaveLength(1);
}, 30_000);

for (const target of ["same-work", "new-work"] as const) for (const userClosed of [false, true]) {
  test(`repair6: cross-process retirement after the error guard preserves the ${target} successor (user-close=${userClosed})`, async () => {
    const f = httpFixture(), fault = join(f.root, "cross-process-old-helper-fault");
    repair6SourceHelper(f, "response", fault);
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const call = first.output.find(item => item.type === "function_call")!;
    const thread = continuityDigest(f.threadId), store = new ContinuityRecoveryStore(f.statePath);
    const before = store.get(thread)!, work = before.works[before.currentWorkId!]!;
    const source = chatGptTurnSessions.find(continuityBindingsFor(f.statePath).observed(thread)!.executionKey!)!;
    const parsed = parseRequest({ ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
      { type: "function_call_output", call_id: call.call_id, output: "Actual result settled before cross-process retirement." }] });
    routeChatGptWebRequest(parsed, f.config);
    expect(source.acceptContinuityToolResults(parsed)).toHaveLength(1);
    let successor: ReturnType<ContinuityRecoveryStore["get"]>;
    let swaps = 0;
    const removePage = ContinuityRecoveryStore.prototype.removePage;
    const check = spyOn(ContinuityRecoveryStore.prototype, "removePage").mockImplementation(function (this: ContinuityRecoveryStore, observedThread, expected) {
      if (observedThread !== thread || swaps) return removePage.call(this, observedThread, expected);
      swaps++;
      const code = `import {ContinuityRecoveryStore} from ${JSON.stringify(resolve("src/adapters/chatgpt-web/continuity-recovery-store.ts"))};
        const store=new ContinuityRecoveryStore(${JSON.stringify(f.statePath)}),thread=${JSON.stringify(thread)},scope=${JSON.stringify(before.scope)};
        ${target === "same-work" ? `store.retireAttempt(thread,{scope},${JSON.stringify(work.logicalWorkId)},0);
          store.reserveRecovery(thread,{scope},{logicalWorkId:${JSON.stringify(work.logicalWorkId)},owner:${JSON.stringify(before.owner)},snapshotDigest:${JSON.stringify(work.attempts[0]!.snapshotDigest)}});`
          : `store.stopWork(thread,{scope},${JSON.stringify(work.logicalWorkId)},"native-interrupt");
          store.admitWork({thread,scope,owner:${JSON.stringify(before.owner)},logicalWorkId:"new-task-after-child-interrupt",nativeTurnId:"new-child-turn",instructionIdentity:"new-child-instruction",workPayloadDigest:"1".repeat(64),snapshotDigest:"2".repeat(64),createPage:true,dispatchProtocolComplete:true});`}`;
      const child = Bun.spawnSync([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode) throw new Error(`Cross-process fixture failed: ${child.stderr.toString()}`);
      successor = store.get(thread)!;
      return removePage.call(this, observedThread, expected);
    });
    cleanups.push(async () => { check.mockRestore(); });
    f.controls.helperUserClosed = userClosed; f.pages.clear(); writeFileSync(fault, "old page physically absent");
    await source.browserOutcome; await source.physicalSettlement;
    expect(swaps).toBe(1);
    expect(store.get(thread)).toEqual(successor);
    expect(store.get(thread)!.works[successor!.currentWorkId!]!.state).toBe("prepared");
    expect(f.controls.helperStarts).toBe(1); expect(f.submissions).toHaveLength(0);
  }, 30_000);
}

for (const manual of [false, true]) for (const stream of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} ${stream ? "streamed" : "JSON"} accepts Codex-roundtripped tool output without repeating work`, async () => {
  const f = httpFixture(manual, false, { mcpTransport: "in-process" });
  f.body.stream = stream;
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.emitReviewCommentary = true;
  const readResponse = async (response: Response): Promise<{ output: Array<Record<string, unknown>> }> => {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) return await response.json();
    const events = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    expect(events.some(event => event.type === "response.failed")).toBe(false);
    const completed = events.find(event => event.type === "response.completed");
    expect(completed).toBeDefined();
    return completed.response;
  };
  const response = await f.send(f.body);
  const first = await readResponse(response);
  const call = first.output.find(item => item.type === "function_call")!;
  expect(call.status).toBe("completed");
  const nextBody = { ...f.body, input: [
    ...f.body.input, ...codexRoundtrippedOutput(first.output),
    { type: "function_call_output", call_id: call.call_id, output: "Actual accepted result 42." },
  ] };
  const next = await f.send(nextBody);
  expect({ httpStatus: next.status, ...await readResponse(next) }).toMatchObject({ httpStatus: 200, status: "completed" });
  const replay = await f.send(nextBody);
  expect({ httpStatus: replay.status, ...await readResponse(replay) }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} accepts Codex-roundtripped final output on the next user turn`, async () => {
  const f = httpFixture(manual);
  f.controls.emitReviewCommentary = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const next = await f.send({
    ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output),
      { type: "message", role: "user", id: "roundtripped-next", content: "Continue authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-roundtripped-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-roundtripped-next" }) },
  });
  expect({ httpStatus: next.status, ...await next.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) for (const format of ["local", "v1", "v2"] as const) {
  test(`HTTP ${manual ? "Zero Risk" : "Automatic"} ${format} compaction recognizes Codex-roundtripped owned output`, async () => {
    const f = httpFixture(manual);
    f.controls.emitReviewCommentary = true;
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const history = [...f.body.input, ...codexRoundtrippedOutput(first.output)];
    const body = format === "local" ? {
      ...f.body, input: [...history, { type: "message", role: "user", content: COMPACT_PROMPT }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
        compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
      }) },
    } : { ...f.body, input: [...history, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
    const response = await f.send(body, format === "v1");
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200 });
    expect(f.submissions).toHaveLength(2);
    expect(f.pages.size).toBe(1);
  });
}

test("Zero Risk rejected current result can be explicitly cancelled before leaving continuity without a restart", async () => {
  const f = httpFixture(true);
  f.controls.invokeSourceTools = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const output = codexRoundtrippedOutput(first.output);
  const call = output.find(item => item.type === "function_call")!;
  const rejected = await f.send({ ...f.body, input: [
    ...f.body.input, ...output,
    { type: "function_call_output", call_id: "unknown-current-call", output: "Must not be delivered." },
  ] });
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).error.code).toBe("continuity_source_unproven");
  expect(f.controls.toolResults).toHaveLength(0);
  expect(() => leaveContinuityMode(f.statePath, f.threadId))
    .toThrow("Finish or explicitly cancel the current continuity work");

  const cancelled = chatGptTurnSessions.cancelNativeTurn(f.threadId, "turn-first", new Error("Explicit test cancellation"));
  expect(cancelled.cancelled).toBe(1);
  await cancelled.settlement;
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.pages.size).toBe(0);
  f.controls.invokeSourceTools = false;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const changed of ["call_id", "name", "namespace", "arguments", "text", "phase", "status", "annotations"] as const) {
  test(`HTTP Codex-roundtripped history ignores changed echoed ${changed} while keeping the local result identity`, async () => {
    const f = httpFixture();
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
    f.controls.emitReviewCommentary = true;
    const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
    const output = codexRoundtrippedOutput(first.output);
    const call = output.find(item => item.type === "function_call")!;
    const message = output.find(item => item.type === "message")!;
    const originalCallId = call.call_id;
    if (changed === "text" || changed === "annotations") {
      (message.content as Array<Record<string, unknown>>)[0]![changed] = changed === "text" ? "Unowned text." : [{ type: "unowned_annotation" }];
    } else if (changed === "phase") message.phase = "final_answer";
    else call[changed] = changed === "status" ? "in_progress" : "unowned";
    const response = await f.send({ ...f.body, input: [
      ...f.body.input, ...output,
      { type: "function_call_output", call_id: originalCallId, output: "Actual completed tool result: 42." },
    ] });
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
    expect(f.controls.toolResults).toHaveLength(1);
    expect(JSON.stringify(f.controls.toolResults[0])).toContain("Actual completed tool result: 42.");
    expect(f.submissions).toHaveLength(1);
  });
}

for (const selectors of ["explicit", "omitted"] as const) test(`HTTP native compact verifies ${selectors} source selectors while keeping control-only execution`, async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  const output = await ordinary.json() as { output: Array<{ type: string }> };
  expect(output.output.some(item => item.type === "function_call")).toBe(false);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  expect(source.runtime.usageInput!.options).toMatchObject({ toolChoice: "none", parallelToolCalls: false });
  const body: Record<string, unknown> = { ...original };
  if (selectors === "omitted") { delete body.tool_choice; delete body.parallel_tool_calls; }
  const adapter = f.adapter();
  const preflight = adapter.preflight!.bind(adapter);
  let controlInput: CodexParsedRequest | undefined;
  let hadToolRegistry = false;
  adapter.preflight = async (parsed, ...args) => {
    controlInput = parsed; hadToolRegistry = parsed.context.tools !== undefined;
    return preflight(parsed, ...args);
  };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), f.config, () => adapter);
  expect(compact.status, await compact.clone().text()).toBe(200);
  await compact.text();
  expect(controlInput!.options.toolChoice).toBeUndefined();
  expect(controlInput!.options.parallelToolCalls).toBeUndefined();
  expect(hadToolRegistry).toBe(false);
  expect(f.automatic.mock.calls[1]![0].nativeConnector).toBe(true);
  expect(f.submissions).toHaveLength(2);
  expect(binding.checkpoints.size).toBe(1);
});

for (const selector of ["tool_choice", "parallel_tool_calls"] as const) test(`HTTP native compact rejects changed source ${selector}`, async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  await ordinary.text();
  const changed = { ...original, [selector]: selector === "tool_choice" ? "auto" : true };
  const compact = await f.send(changed, true);
  expect({ httpStatus: compact.status, ...await compact.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  // The ordinary accepted instruction remains immutable under the same identity.
  const replay = await f.send(changed);
  expect({ httpStatus: replay.status, ...await replay.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(1);
});

test("HTTP native compact refuses omitted source selectors when the real source options are unavailable", async () => {
  const f = httpFixture();
  const original = { ...f.body, tool_choice: "none", parallel_tool_calls: false };
  const ordinary = await f.send(original);
  expect(ordinary.status).toBe(200);
  await ordinary.text();
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  // Preserve its accepted digest and identity while removing the complete source object.
  source.runtime.usageInput = undefined;
  const compact = await f.send(f.body, true);
  expect({ httpStatus: compact.status, ...await compact.json() }).toMatchObject({ httpStatus: 409, error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(1);
  expect(binding.checkpoints.size).toBe(0);
});

for (const format of ["local", "v1", "v2"] as const) test(`HTTP ${format} compact installs one checkpoint and continues on the same page`, async () => {
  const f = httpFixture();
  const firstResponse = await f.send(f.body);
  expect({ httpStatus: firstResponse.status, ...await firstResponse.clone().json() }).toMatchObject({ httpStatus: 200, status: "completed" });
  expect((await firstResponse.json()).status).toBe("completed");
  const originalInput = f.body.input as unknown[];
  const compactBody = format === "local" ? {
    ...f.body, input: [...originalInput, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  } : { ...f.body, input: [...originalInput, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
  const response = await f.send(compactBody, format === "v1");
  expect(response.status).toBe(200);
  const compacted = await response.json() as { output: Array<{ type: string; encrypted_content?: string; content?: Array<{ text?: string }> }> };
  const item = format === "v1" ? compacted.output.at(-1)
    : compacted.output.find(value => value.type === (format === "local" ? "message" : "compaction"));
  expect(item).toBeDefined();
  const text = item!.content?.map(part => part.text ?? "").join("") ?? "";
  if (format === "v1") {
    expect(compacted.output.every(value => value.type === "message")).toBe(true);
    expect(text.startsWith(`${SUMMARY_PREFIX}\n`)).toBe(true);
  }
  const summary = format === "v2" ? decodeCompactionSummary(item!.encrypted_content!)
    : format === "v1" ? text.slice(SUMMARY_PREFIX.length + 1) : text;
  expect(summary).toBe('Verified checkpoint.\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."');
  const retry = await f.send(compactBody, format === "v1");
  expect(retry.status, await retry.clone().text()).toBe(200);
  await retry.text();
  expect(f.submissions).toHaveLength(2);
  const input = format === "v1" ? compacted.output : [...originalInput, ...(format === "local"
    ? [{ type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }]
    : compacted.output)];
  const continued = await f.send({ ...f.body, input });
  expect(continued.status).toBe(200);
  const completed = await continued.json();
  expect(completed.status).toBe("completed");
  expect(completed.output.at(-1)?.content).toEqual([{ type: "output_text", text: "Completed response 1.", annotations: [] }]);
  expect(f.submissions).toHaveLength(2);
  const next = await f.send({
    ...f.body, input: [...input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
      { type: "message", role: "user", id: "next-http-message", content: "Continue new authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-http-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-http-next" }) },
  });
  expect(next.status).toBe(200);
  expect((await next.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.prompt).toContain("Continue new authorized work.");
  expect(f.submissions[2]!.prompt).not.toContain("First continuity instruction.");
  expect(new Set(f.submissions.map(value => value.key)).size).toBe(1);
});

for (const format of ["local", "v1", "v2"] as const) test(`HTTP completed ${format} compaction accepts the bridge's returned output history`, async () => {
  const f = httpFixture();
  const firstResponse = await f.send(f.body);
  const completed = await firstResponse.json() as { status: string; output: unknown[] };
  expect(completed.status).toBe("completed");
  const fullHistory = [...f.body.input, ...completed.output];
  const compactBody = format === "local" ? {
    ...f.body, input: [...fullHistory, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" },
    }) },
  } : { ...f.body, input: [...fullHistory, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
  const response = await f.send(compactBody, format === "v1");
  expect(response.status).toBe(200);
  await response.text();
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
});

test("HTTP tool continuation accepts the bridge's commentary and tool output exactly once", async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.emitReviewCommentary = true;
  const response = await f.send(f.body);
  const result = await response.json() as { output: Array<Record<string, unknown>> };
  const call = result.output.find(item => item.type === "function_call")!;
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary")).toBe(true);
  const continuation = await f.send({ ...f.body, input: [
    ...f.body.input, ...result.output,
    { type: "function_call_output", call_id: call.call_id, output: "Actual completed fixture result: 42." },
  ] });
  expect(continuation.status).toBe(200);
  await continuation.text();
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP next user turn accepts the bridge's complete commentary and final output", async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  const response = await f.send(f.body);
  const result = await response.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(result.status).toBe("completed");
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary")).toBe(true);
  const next = await f.send({
    ...f.body, input: [...f.body.input, ...result.output,
      { type: "message", role: "user", id: "review-next-message", content: "Continue new authorized work.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-review-next" } },
    ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-review-next" }) },
  });
  expect(next.status).toBe(200);
  await next.text();
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} replays an earlier accepted tool round after the canonical head advances`, async () => {
  const f = httpFixture(manual, false, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const initial = await (await f.send(f.body)).json() as { status: string; output: Array<Record<string, unknown>> };
  const call = initial.output.find(item => item.type === "function_call")!;
  const nextBody = { ...f.body, input: [
    ...f.body.input, ...initial.output,
    { type: "function_call_output", call_id: call.call_id, output: "Actual accepted result 42" },
  ] };
  const next = await (await f.send(nextBody)).json() as { status: string };
  expect(next.status).toBe("completed");
  expect(f.controls.toolResults).toHaveLength(1);

  const replay = await f.send(f.body);
  expect(replay.status).toBe(200);
  const replayBody = await replay.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(replayBody.status).toBe("completed");
  expect(replayBody.output.find(item => item.type === "function_call")?.call_id).toBe(call.call_id);
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP streamed replay of an earlier accepted tool round completes after the canonical head advances", async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  await (await f.send({ ...f.body, input: [
    ...f.body.input, ...first.output,
    { type: "function_call_output", call_id: call.call_id, output: "Accepted result 42" },
  ] })).text();

  const response = await f.send({ ...f.body, stream: true });
  const events = await response.text();
  expect(events).toContain("event: response.completed");
  expect(events).not.toContain("event: response.failed");
  expect(f.controls.toolResults).toHaveLength(1);
});

test("Automatic original ordinary replay keeps its first tool batch after round journal reclamation", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  const initial = await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const result = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Accepted first result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const priorBatch = snapshot.lastToolBatchRevision;
  const next = f.run(result);
  while (snapshot.lastToolBatchRevision === priorBatch) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  await next;
  const currentCall = source.outstanding()[0]!.callId;
  // Exercise the journal cap without issuing hundreds of simulated Native calls.
  for (let index = 0; index < 511; index += 1) source.completeRound(`completed-capacity-probe-${index}`);
  expect((source as unknown as { rounds: Map<string, unknown> }).rounds.size).toBe(512);
  expect(await f.run(structuredClone(first))).toEqual(initial);
  expect(source.outstanding()[0]!.callId).toBe(currentCall);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
  await expect(f.run(structuredClone(result))).rejects.toMatchObject({ code: "continuity_source_unproven" });
});

for (const changedEcho of [false, true]) test(`Automatic current results with ${changedEcho ? "changed" : "original"} call echoes survive older batch reclamation`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const oldCall = source.outstanding()[0]!;
  const oldResult = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: oldCall.callId, output: "Accepted earlier result." },
  ]);
  if (source.runtime.mode !== "tools") throw new Error("Missing fixture tool runtime");
  const progress = source.runtime.externalProgress;
  let snapshot = progress.snapshot();
  const revision = snapshot.lastToolBatchRevision;
  const next = f.run(oldResult);
  while (snapshot.lastToolBatchRevision === revision) snapshot = await progress.waitForChange(snapshot.revision);
  await progress.acknowledgeToolBatch(snapshot.lastToolBatchRevision);
  await next;
  const current = source.outstanding()[0]!;
  const base = [...(oldResult._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Next tool batch." },
    { type: "function_call", call_id: changedEcho ? "decorative-call-echo" : current.callId,
      name: changedEcho ? "changed-display-name" : current.wireName,
      arguments: changedEcho ? '{"cmd":"changed-display-only"}' : JSON.stringify(current.arguments) }];
  const result = { type: "function_call_output", call_id: current.callId, output: "Accepted current result." };
  const full = f.request("", "turn-first", [...base, result]);
  expect(source.continuityToolResultRoundKey(full)).toBe("tool-batch:2");
  for (let index = 0; index < 511; index++) source.completeRound(`completed-capacity-probe-${index}`);
  await expect(f.run(structuredClone(oldResult))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const unknown = { type: "function_call_output", call_id: "unknown-current-result", output: "Unowned result." };
  for (const results of [[unknown, result], [result, unknown], [result, result]]) {
    await expect(f.run(f.request("", "turn-first", [...base, ...results]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(source.outstanding()[0]!.callId).toBe(current.callId);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(source.continuityToolResultRoundKey(full)).toBe("tool-batch:2");
  const accepted = await f.run(full);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(full))).toEqual(accepted);
  expect(f.controls.toolResults).toHaveLength(2);
  expect(f.submissions).toHaveLength(1);
});

test("HTTP completed compaction replay remains readable after later work on the same revision", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const compactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
  expect(compact.status).toBe("completed");

  const next = await f.send({
    ...f.body,
    input: [...history, ...compact.output,
      { type: "message", role: "user", id: "next-work-after-checkpoint", content: "Perform the next authorized task.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-next-after-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next-after-checkpoint" }) },
  });
  expect(next.status).toBe(200);
  expect((await next.json()).status).toBe("completed");

  const replay = await f.send(compactBody);
  expect(replay.status).toBe(200);
  expect((await replay.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(3);
  expect(f.pages.size).toBe(1);
});

test("HTTP completed compaction replay remains readable while later work is still running", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const compactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
  expect(compact.status).toBe("completed");

  const nextBody = {
    ...f.body,
    input: [...history, ...compact.output,
      { type: "message", role: "user", id: "running-work-after-checkpoint", content: "Keep this work running.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-running-after-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-running-after-checkpoint" }) },
  };
  f.controls.deferCompletion = true;
  f.controls.started = false;
  const running = f.send(nextBody);
  while (!f.controls.started) await Bun.sleep(1);
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const runningExecutionKey = binding.executionKey;
  const lastUsedAt = binding.lastUsedAt;
  const submissions = f.submissions.length;
  try {
    const replay = await f.send(compactBody);
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe("completed");
    expect(binding.state).toBe("running");
    expect(binding.executionKey).toBe(runningExecutionKey);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    expect(f.submissions).toHaveLength(submissions);
  } finally {
    f.controls.releaseDeferredCompletion?.();
  }
  expect((await (await running).json()).status).toBe("completed");
});

test("HTTP consecutive owned compactions may commit the same summary without confusing their transactions", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { output: unknown[] };
  const history = [...f.body.input, ...first.output];
  const firstCompactBody = { ...f.body, input: [...history, { type: "compaction_trigger" }] };
  const firstCompact = await (await f.send(firstCompactBody)).json() as { status: string; output: unknown[] };
  expect(firstCompact.status).toBe("completed");

  const nextBody = {
    ...f.body,
    input: [...history, ...firstCompact.output,
      { type: "message", role: "user", id: "repeat-original-instruction", content: "First continuity instruction.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-repeat-instruction" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-repeat-instruction" }) },
  };
  const next = await (await f.send(nextBody)).json() as { status: string; output: unknown[] };
  expect(next.status).toBe("completed");
  const secondSourceHistory = [...nextBody.input, ...next.output];
  const secondCompactBody = { ...nextBody, input: [...secondSourceHistory, { type: "compaction_trigger" }] };
  const secondCompact = await f.send(secondCompactBody);
  expect(secondCompact.status).toBe(200);
  const secondCompactResult = await secondCompact.json() as { status: string; output: unknown[] };
  expect(secondCompactResult.status).toBe("completed");

  const third = await f.send({
    ...nextBody,
    input: [...secondSourceHistory, ...secondCompactResult.output,
      { type: "message", role: "user", id: "work-after-repeated-checkpoint", content: "Continue after the repeated checkpoint.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-after-repeated-checkpoint" } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-repeated-checkpoint" }) },
  });
  expect(third.status).toBe(200);
  expect((await third.json()).status).toBe("completed");

  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("ready");
  expect(binding.revision).toBe(2);
  expect([...binding.checkpoints.values()].map(checkpoint => [checkpoint.sourceRevision, checkpoint.revision]))
    .toEqual([[0, 1], [1, 2]]);
  expect(f.pages.size).toBe(1);
  const currentExecutionKey = binding.executionKey;
  const submissions = f.submissions.length;
  expect((await (await f.send(firstCompactBody)).json()).status).toBe("completed");
  expect((await (await f.send(secondCompactBody)).json()).status).toBe("completed");
  expect(binding.revision).toBe(2);
  expect(binding.executionKey).toBe(currentExecutionKey);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.pages.size).toBe(1);
});

test("HTTP exact compaction replay accepts reordered structured JSON without a second submission", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { status: string; output: unknown[] };
  expect(first.status).toBe("completed");
  const compactBody = { ...f.body, input: [...f.body.input, ...first.output, { type: "compaction_trigger" }] };
  const compact = await f.send(compactBody);
  expect(compact.status).toBe(200);
  expect((await compact.json()).status).toBe("completed");
  const submissions = f.submissions.length;
  const reordered = reverseJsonObjectKeys(compactBody);
  expect(reordered).toEqual(compactBody);

  const replay = await f.send(reordered);
  expect(replay.status).toBe(200);
  expect((await replay.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(submissions);
});

test("HTTP reordered reconnect replays commentary already journaled before observer disconnect", async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  f.controls.deferCompletion = true;
  const abort = new AbortController();
  const first = await f.send({ ...f.body, stream: true }, false, false, abort.signal);
  expect(first.status).toBe(200);
  const reader = first.body!.getReader();
  const decoder = new TextDecoder();
  let observed = "";
  while (!observed.includes("Checking the source before continuing.")) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(2_000).then(() => { throw new Error("Timed out waiting for streamed commentary"); }),
    ]);
    if (chunk.done) throw new Error("Stream ended before commentary was delivered");
    observed += decoder.decode(chunk.value, { stream: true });
  }
  abort.abort();
  await reader.cancel().catch(() => {});
  while (!f.controls.releaseDeferredCompletion) await Bun.sleep(1);
  f.controls.releaseDeferredCompletion();

  const reorderedInput = reverseJsonObjectKeys(f.body.input) as unknown[];
  expect(reorderedInput).toEqual(f.body.input);
  const replay = await f.send({ ...f.body, stream: false, input: reorderedInput });
  expect(replay.status).toBe(200);
  const result = await replay.json() as { status: string; output: Array<Record<string, unknown>> };
  expect(result.status).toBe("completed");
  expect(result.output.some(item => item.type === "message" && item.phase === "commentary"
    && JSON.stringify(item).includes("Checking the source before continuing."))).toBe(true);
  expect(f.submissions).toHaveLength(1);
});

for (const kind of ["ordinary", "checkpoint"] as const) test(`HTTP ${kind} resume accepts structurally identical input history with reordered JSON object keys`, async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body)).json() as { status: string; output: unknown[] };
  expect(first.status).toBe("completed");
  const sourceHistory = [...f.body.input, ...first.output];
  let input: unknown[];
  if (kind === "ordinary") {
    const reordered = reverseJsonObjectKeys(f.body.input) as unknown[];
    expect(reordered).toEqual(f.body.input);
    input = [...reordered, ...first.output];
  } else {
    const compactBody = { ...f.body, input: [...sourceHistory, { type: "compaction_trigger" }] };
    const compact = await (await f.send(compactBody)).json() as { status: string; output: unknown[] };
    expect(compact.status).toBe("completed");
    const reordered = reverseJsonObjectKeys(sourceHistory) as unknown[];
    expect(reordered).toEqual(sourceHistory);
    input = [...reordered, ...compact.output];
  }
  const turnId = `turn-reordered-${kind}-input`;
  const response = await f.send({
    ...f.body,
    input: [...input,
      { type: "message", role: "user", id: `msg-${turnId}`, content: "Continue after canonical JSON normalization.",
        internal_chat_message_metadata_passthrough: { turn_id: turnId } },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: turnId }) },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("completed");
  expect(f.pages.size).toBe(1);
});

for (const kind of ["tool-round", "next-turn", "compaction"] as const) test(`HTTP ${kind} accepts structurally identical output with reordered JSON object keys`, async () => {
  const f = httpFixture();
  f.controls.emitReviewCommentary = true;
  if (kind === "tool-round") {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const first = await (await f.send(f.body)).json() as { output: Array<Record<string, unknown>> };
  const output = first.output.map(item => Object.fromEntries(Object.entries(item).reverse()));
  expect(output).toEqual(first.output);

  const body = kind === "tool-round"
    ? { ...f.body, input: [...f.body.input, ...output,
      { type: "function_call_output", call_id: first.output.find(item => item.type === "function_call")!.call_id, output: "Accepted real fixture result" },
    ] }
    : kind === "next-turn"
      ? { ...f.body, input: [...f.body.input, ...output,
        { type: "message", id: "reordered-next-message", role: "user", content: "Continue the next authorized work.",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-reordered-next" } },
      ], client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-reordered-next" }) } }
      : { ...f.body, input: [...f.body.input, ...output, { type: "compaction_trigger" }] };
  const response = await f.send(body);
  expect(response.status).toBe(200);
  expect((await response.json()).status).toBe("completed");
});

for (const kind of ["namespaced", "tool_search"] as const) test(`HTTP ${kind} native output round-trips under continuity`, async () => {
  const f = httpFixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = kind === "namespaced" ? "review_tools__exec_command" : "tool_search";
  const spec = (f.body.tools as Array<Record<string, unknown>>)[0]!;
  f.body.tools = kind === "namespaced"
    ? [{ type: "namespace", name: "review_tools", tools: [spec] }]
    : [{ type: "tool_search", description: "Fixture search, no external service is called", parameters: spec.parameters }];
  const first = await f.send(f.body);
  const result = await first.json() as { output: Array<Record<string, unknown>> };
  const callType = kind === "namespaced" ? "function_call" : "tool_search_call";
  const call = result.output.find(item => item.type === callType)!;
  if (kind === "namespaced") expect(call).toMatchObject({ name: "exec_command", namespace: "review_tools" });
  const continuation = await f.send({ ...f.body, input: [
    ...f.body.input, ...result.output,
    kind === "namespaced"
      ? { type: "function_call_output", call_id: call.call_id, output: "Actual fixture tool result: 42." }
      : { type: "tool_search_output", call_id: call.call_id, tools: [], status: "completed" },
  ] });
  expect(continuation.status).toBe(200);
  await continuation.text();
  expect(f.controls.toolResults).toHaveLength(1);
});

test("HTTP expired previous_response_id rejects partial input, then a full canonical resend uses the retained page", async () => {
  const f = httpFixture();
  const first = await (await f.send(f.body, false, true)).json();
  expect(first.status).toBe("completed");
  const next: Record<string, unknown> = {
    ...(f.next(parseRequest(f.body))._rawBody as Record<string, unknown>), model: f.body.model, reasoning: f.body.reasoning,
  };
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 61 * 60_000);
  try {
    const partial = await f.send({ ...next, previous_response_id: first.id, input: (next.input as unknown[]).slice(-1) });
    expect(partial.status).toBe(409);
    expect(await partial.text()).toContain("previous_response_id");
    expect(f.pages.size).toBe(1);
    expect(f.submissions).toHaveLength(1);
    const full = await f.send(next);
    expect(full.status).toBe(200);
    expect((await full.json()).status).toBe("completed");
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  } finally { clock.mockRestore(); }
});

test("HTTP streamed compaction failure preserves its deterministic code and never emits a completed checkpoint", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  f.controls.handoffSummary = 'Invalid checkpoint.\nCODEX_LATEST_USER_PROMPT_JSON\n"A different instruction"';
  const body = { ...f.body, stream: true, input: [...f.body.input as unknown[], { type: "compaction_trigger" }] };
  const response = await f.send(body);
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('"type":"response.failed"');
  expect(stream).toContain('"code":"continuity_source_unproven"');
  expect(stream).not.toContain('"type":"response.completed"');
  const thread = continuityDigest(f.threadId);
  const before = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const initialWork = Object.values(before.works).find(work => work.purpose === "compaction")!;
  expect(initialWork).toBeDefined();
  const targetId = initialWork.compactionTargetId!;
  expect(Object.keys(before.compactionTargets)).toEqual([targetId]);
  expect(Object.keys(before.checkpoints)).toHaveLength(0);
  expect(initialWork.attempts.at(-1)).toMatchObject({ stage: "interrupted-settled", writerRetired: true });
  const repeated = await f.send(body);
  expect(repeated.status).toBe(200);
  const repeatedStream = await repeated.text();
  expect(repeatedStream).toContain('"type":"response.failed"');
  expect(repeatedStream).toContain('"code":"continuity_source_unproven"');
  expect(repeatedStream).not.toContain('"type":"response.completed"');
  const after = new ContinuityRecoveryStore(f.statePath).get(thread)!;
  const retriedWork = Object.values(after.works).find(work => work.purpose === "compaction")!;
  expect(after.works[initialWork.logicalWorkId]).toBeUndefined();
  expect(Object.keys(after.compactionTargets)).toEqual([retriedWork.compactionTargetId!]);
  expect(retriedWork.compactionTargetId).not.toBe(targetId);
  expect(retriedWork.attempts).toHaveLength(1);
  expect(retriedWork.attempts[0]).toMatchObject({ attempt: 0, stage: "interrupted-settled", writerRetired: true });
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.historyRevision).toBe(0);
  expect(Object.keys(after.checkpoints)).toHaveLength(0);
  expect(after.calls).toEqual(before.calls);
  expect(f.controls.toolResults).toHaveLength(0);
  expect(f.automatic.mock.calls.at(-1)![0]).toMatchObject({
    compaction: true, nativeConnector: true, capabilities: { localToolsEnabled: false },
  });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.key).not.toBe(f.submissions[1]!.key);
  expect(f.submissions[2]!.reused).toBe(false);
});

test("an ordinary Native route observes mode exit before forwarding upstream", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  const provider = spyOn(configuration, "providerConfig").mockReturnValue(f.provider);
  let forwarded = 0;
  try {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { authorization: "Bearer continuity-native-test-only", "content-type": "application/json" },
      body: JSON.stringify({ ...f.body, model: "gpt-native-fixture" }),
    }), f.config, () => { throw new Error("Native selection must not start a Web adapter"); }, {
      fetchNative: async () => {
        forwarded++;
        expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
        expect(f.pages.size).toBe(0);
        return Response.json({ id: "native-fixture-response", status: "completed", output: [] });
      },
    });
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
    expect(forwarded).toBe(1);
    const replay = await f.send(f.body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe("completed");
    expect(f.pages.size).toBe(1);
    expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
    expect(f.submissions).toHaveLength(2);
  } finally { provider.mockRestore(); }
});

// V3 uses explicit new-turn ownership; locating completed predecessors is no longer required.
for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} owned new-turn input continues without its completed predecessor`, async () => {
  const f = httpFixture(manual);
  expect((await f.send(f.body)).status).toBe(200);
  const response = await f.send({
    ...f.body,
    input: [{ type: "message", role: "user", id: "next-only", content: "New instruction with missing predecessor.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next" }) },
  });
  expect(response.status).toBe(200);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions.at(-1)!.prompt).toContain("New instruction with missing predecessor.");
  const unowned = await f.send({
    ...f.body,
    input: [{ type: "message", role: "user", id: "unowned-next", content: "Unowned new instruction." }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-unowned" }) },
  });
  expect(unowned.status).toBe(409);
  expect(await unowned.json()).toMatchObject({ error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(2);
  expect((await f.send(f.body)).status).toBe(200);
});

for (const route of [
  { source: "chatgpt-web/gpt-6-sol-instant", successor: "chatgpt-web/gpt-6-sol-instant" },
  { source: "chatgpt-web/gpt-5.6-sol-instant", successor: "chatgpt-web/gpt-5.6-sol-instant" },
]) test(`repair4: HTTP public routed source echo recovers through its actual new navigation entry (${route.source} -> ${route.successor})`, async () => {
  const f = httpFixture();
  f.body.model = route.source;
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.failAfterToolsOnce = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const calls = first.output.filter(item => item.type === "function_call");
  expect(calls).toHaveLength(1);
  const callId = calls[0]!.call_id as string;
  const tail = "SYNTHETIC_UNREAD_TAIL_74D3B1";
  const log = "Original public response tool source line.\n".repeat(60_000) + tail;
  const result = { type: "function_call_output", call_id: callId, output: log };
  const continuation = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  const work = before.works[before.currentWorkId!]!;
  const failedResponse = await f.send(continuation);
  const failed = await failedResponse.json() as { status: string; error?: { code?: string } };
  expect(failed.status).toBe("failed");
  expect(failed.error?.code).toBeDefined();
  expect(store.get(thread)).toBeUndefined();
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.pages.size).toBe(0);
  f.controls.invokeSourceTools = false;
  let readBody = "";
  let selectedPlan = false;
  f.automatic.mockImplementationOnce(async turn => {
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "b".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.contextPlan).toBeDefined();
    expect(compiled.text).not.toContain(tail);
    expect(compiled.text.length).toBeLessThan(log.length);
    await turn.onContextPlanSelected!(compiled.contextPlan!.planId);
    selectedPlan = true;
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const active = store.get(thread)!;
    const successor = active.works[active.currentWorkId!]!;
    expect(successor.logicalWorkId).not.toBe(work.logicalWorkId);
    expect(successor.workLineageId).not.toBe(work.workLineageId);
    expect(successor.attempts).toHaveLength(1);
    expect(active.calls).toEqual({});
    const entry = JSON.parse(compiled.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.turn_token, contract: "native", credentialKind: "ordinary", contextProtocol: 2,
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.turn_token,
        contract: "native", credentialKind: "ordinary", contextProtocol: 2, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const found = (await query("search", { query: tail })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    readBody = parseContextTextReadResult(read).body;
    expect(readBody).toContain(tail);
    f.pages.get(turn.conversationKey!)!.state = "ready";
    turn.onTextDelta("Completed from the actual stored public source.");
    return "Completed from the actual stored public source.";
  });
  const recoveryBody = { ...continuation, model: route.successor };
  const recoveredResponse = await f.send(recoveryBody);
  const recovered = await recoveredResponse.json() as { status: string; output: Array<Record<string, unknown>>; error?: { code?: string; message?: string } };
  expect({ httpStatus: recoveredResponse.status, code: recovered.error?.code }).toEqual({ httpStatus: 200, code: undefined });
  expect(recovered.status).toBe("completed");
  expect(recovered.output.some(item => item.type === "function_call")).toBe(false);
  expect(selectedPlan).toBe(true);
  expect(readBody).toContain(tail);
  const after = store.get(thread)!;
  expect(after.epoch).not.toBe(before.epoch);
  expect(after.historyRevision).toBe(0);
  expect(after.works[work.logicalWorkId]).toBeUndefined();
  expect(after.works[after.currentWorkId!]!.state).toBe("completed");
  expect(after.calls).toEqual({});
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(f.submissions[0]!.key);
  expect(f.controls.toolResults).toHaveLength(1);
  const replayResponse = await f.send(recoveryBody);
  expect(replayResponse.status).toBe(200);
  expect((await replayResponse.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(2);
  expect(f.controls.toolResults).toHaveLength(1);
}, 30_000);

test("repair4: HTTP public live page preserves instruction, first-result and model-scope rejection barriers", async () => {
  const f = httpFixture();
  f.body.model = "chatgpt-web/gpt-6-sol-instant";
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = false;
  f.controls.failAfterToolsKeepPage = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const call = first.output.find(item => item.type === "function_call")!;
  const result = { type: "function_call_output", call_id: call.call_id, output: "The actual first accepted result." };
  const body = { ...f.body, input: [...f.body.input, ...codexRoundtrippedOutput(first.output), result] };
  const failedResponse = await f.send(body);
  expect((await failedResponse.json()).status).toBe("completed");
  f.controls.invokeSourceTools = false;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  const before = store.get(thread)!;
  for (const alteration of ["instruction", "first-result", "model-scope"] as const) {
    const changed = structuredClone(body);
    if (alteration === "instruction") (changed.input[0] as { content: unknown }).content = "Changed source under the same native ID.";
    else if (alteration === "first-result") (changed.input.at(-1) as { output: string }).output = "Conflicting accepted result.";
    else changed.model = "chatgpt-web/gpt-5.6-sol-instant";
    const response = await f.send(changed);
    const rejected = await response.json() as { error: { code: string } };
    expect(response.status, alteration).toBe(409);
    expect(rejected.error.code).toBe(alteration === "model-scope" ? "continuity_configuration_conflict" : "continuity_source_unproven");
    expect(store.get(thread)).toEqual(before);
    expect(f.submissions).toHaveLength(1);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.pages.size).toBe(1);
  }
}, 30_000);

test("repair4: HTTP public uncommitted compaction retry starts a new generation after page loss and commits the actual tail once", async () => {
  const f = httpFixture();
  f.body.model = "chatgpt-web/gpt-6-sol-instant";
  f.body.reasoning = { effort: "low" };
  f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; f.controls.failAfterToolsOnce = true;
  const firstResponse = await f.send(f.body);
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as { output: Array<Record<string, unknown>> };
  const callId = first.output.find(item => item.type === "function_call")!.call_id as string;
  const head = "SYNTHETIC_PUBLIC_COMPACT_HEAD_1042";
  const tail = "SYNTHETIC_PUBLIC_COMPACT_TAIL_971E";
  const log = `${head}\n` + "Original issued tool line for public compaction.\n".repeat(50_000) + tail;
  const result = { type: "function_call_output", call_id: callId, output: log };
  const sourceInput = [...f.body.input, ...codexRoundtrippedOutput(first.output), result];
  const failedSource = await f.send({ ...f.body, input: sourceInput });
  expect((await failedSource.json()).error.code).toBeDefined();
  f.controls.invokeSourceTools = false;
  const compactBody = { ...f.body, input: [...sourceInput, { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first", request_kind: "compaction",
      compaction: { implementation: "responses", trigger: "manual", phase: "standalone_turn", strategy: "memento" } }) } };
  const encodedBody = JSON.stringify(compactBody);
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId);
  let compactStarts = 0;
  let headBody = "", tailBody = "";
  let preCommit: ReturnType<ContinuityRecoveryStore["get"]>;
  let failedCompaction: NonNullable<ReturnType<ContinuityRecoveryStore["get"]>>;
  f.automatic.mockImplementation(async turn => {
    compactStarts++;
    expect(turn.compaction).toBe(true);
    expect(turn.capabilities.localToolsEnabled).toBe(false);
    expect(turn.continuity!.expected).toBeUndefined();
    const lease = { owner: turn.continuity!.owner, leaseId: "c".repeat(32), traceId: turn.traceId,
      recovery: turn.continuity!.recovery };
    f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
    turn.onContinuityLease!(lease);
    const compiled = await turn.prepare();
    expect(compiled.text).not.toContain(tail);
    if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
    f.submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: false });
    await turn.onSendActivated!(); await turn.onSubmitted!();
    const entry = JSON.parse(compiled.text.match(/<codex_context_navigation_json>\n([^\n]+)\n/)![1]!);
    const credential = entry.first_call.arguments;
    const query = async (method: "search" | "read", args: Record<string, unknown>) => {
      const reply = await callTurnBroker<{ result: BrokerToolResult; receiptId: string }>(f.provider.chatgptWeb!.brokerSocketPath!, {
        method: "context_query", token: credential.compaction_token, contract: "native", credentialKind: "compaction", contextProtocol: 2,
        contextMethod: method, contextArgs: { context_id: credential.context_id, ...args } as import("../src/adapters/chatgpt-web/context-runtime").ContextArgs,
      });
      expect(reply.result.isError).not.toBe(true);
      const { contextTextReadReceipt } = await import("../src/adapters/chatgpt-web/context-text-result");
      await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "context_return", token: credential.compaction_token,
        contract: "native", credentialKind: "compaction", contextProtocol: 2, receiptId: reply.receiptId, sent: true,
        ...(method === "read" ? { textReadReceipt: contextTextReadReceipt(reply.result) } : {}) });
      return reply.result;
    };
    const marker = compactStarts === 1 ? head : tail;
    const found = (await query("search", { query: marker })).structuredContent as { hits: Array<{ read_ref: string; read_cursor: string }> };
    expect(found.hits).toHaveLength(1);
    const read = await query("read", { read_ref: found.hits[0]!.read_ref, cursor: found.hits[0]!.read_cursor });
    const { parseContextTextReadResult } = await import("../src/adapters/chatgpt-web/context-text-result");
    const body = parseContextTextReadResult(read).body;
    expect(body).toContain(marker);
    if (compactStarts === 1) {
      headBody = body;
      expect(body).not.toContain(tail);
      failedCompaction = store.get(thread)!;
      f.pages.delete(turn.conversationKey!);
      throw continuityError("continuity_session_lost", "Synthetic compaction page fault after the confirmed head return.");
    }
    tailBody = body;
    preCommit = store.get(thread)!;
    expect(Object.values(preCommit.checkpoints)).toHaveLength(0);
    const token = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
    const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
    await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, { method: "submit_compaction_handoff", token, handoffId,
      summary: `Checkpoint from the actual read: ${body.slice(body.indexOf(tail))}` });
    await new Promise<void>(resolve => {
      if (turn.abortSignal?.aborted) resolve(); else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    f.pages.get(turn.conversationKey!)!.state = "ready";
    return "Compaction handoff physically settled.";
  });
  const firstCompact = await f.send(compactBody);
  const failed = await firstCompact.json() as { status: string };
  expect(failed.status).toBe("failed");
  expect(headBody).toContain(head);
  expect(headBody).not.toContain(tail);
  expect(store.get(thread)).toBeUndefined();
  const beforeRetry = failedCompaction!;
  expect(Object.values(beforeRetry.checkpoints)).toHaveLength(0);
  const work = Object.values(beforeRetry.works).find(value => value.purpose === "compaction")!;
  expect(work.retryBudget!.deadlineAt).toBeGreaterThan(work.retryBudget!.startedAt);
  expect(JSON.stringify(compactBody)).toBe(encodedBody);
  const retry = await f.send(compactBody);
  expect(retry.status).toBe(200);
  const completed = await retry.json() as { status: string; output: Array<{ content?: Array<{ text?: string }> }> };
  expect(completed.status).toBe("completed");
  expect(completed.output.flatMap(item => item.content ?? []).map(part => part.text ?? "").join("")).toContain(tail);
  expect(tailBody).toContain(tail);
  const active = Object.values(preCommit!.works).find(value => value.purpose === "compaction")!;
  expect(active.state).toBe("active");
  expect(active.logicalWorkId).not.toBe(work.logicalWorkId);
  expect(active.compactionTargetId).not.toBe(work.compactionTargetId);
  expect(preCommit!.epoch).not.toBe(beforeRetry.epoch);
  expect(active.attempts).toHaveLength(1);
  const after = store.get(thread)!;
  expect(after.works[work.logicalWorkId]).toBeUndefined();
  const final = after.works[active.logicalWorkId]!;
  expect(final.state).toBe("completed");
  expect(final.retryBudget).toBeUndefined();
  expect(final.attempts.at(-1)!.attempt).toBe(active.attempts.at(-1)!.attempt);
  expect(final.attempts.at(-1)!.epoch).toBe(active.attempts.at(-1)!.epoch);
  const checkpoints = Object.values(after.checkpoints);
  expect(checkpoints).toHaveLength(1);
  expect(final.terminalReceiptId).toBe(checkpoints[0]!.commitId);
  expect(checkpoints[0]!.coveredCallIds).toEqual([]);
  expect(after.calls).toEqual({});
  expect(compactStarts).toBe(2);
  expect(f.controls.toolResults).toHaveLength(1);
  const replay = await f.send(compactBody);
  const replayBody = await replay.json();
  expect(replay.status, JSON.stringify(replayBody.error)).toBe(200);
  expect(replayBody.status).toBe("completed");
  expect(compactStarts).toBe(2);
  expect(Object.values(store.get(thread)!.checkpoints)).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
}, 30_000);

for (const manual of [false, true]) test(`page lifetime: HTTP stopped and cancelled ${manual ? "Zero Risk" : "Automatic"} request prepares a new page`, async () => {
  const f = httpFixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = await f.send(f.body);
  expect(first.status).toBe(200);
  const firstBody = await first.json() as { output: Array<Record<string, unknown>> };
  expect(firstBody.output.some(item => item.type === "function_call")).toBe(true);
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  const old = bindings.observed(thread)!;
  const source = chatGptTurnSessions.find(old.executionKey!)!;
  stopDurableContinuity(f.statePath, f.threadId, "turn-first");
  source.cancel(Object.assign(new Error("The user closed the old page."), { code: "client_cancelled" }));
  await source.physicalSettlement;
  // Keep a stale cancellation receipt visible at the public cache boundary.
  const cancelledLookup = chatGptTurnSessions.cancelledError.bind(chatGptTurnSessions);
  const cached = Object.assign(new Error("Old cancellation"), { code: "client_cancelled" });
  const cancellation = spyOn(chatGptTurnSessions, "cancelledError").mockImplementation(trace => trace === source.traceId ? cached : cancelledLookup(trace));
  cleanups.push(async () => cancellation.mockRestore());
  f.pages.clear();
  f.controls.invokeSourceTools = false;
  const response = await f.send(f.body);
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.claim.expected).toBeUndefined();
  expect(bindings.observed(thread)).not.toBe(old);
  expect(bindings.recoveryStore.get(thread)!.works[old.recovery!.logicalWorkId]).toBeUndefined();
  expect(Object.keys(bindings.recoveryStore.get(thread)!.calls)).toHaveLength(0);
});

for (const history of ["completed", "unknown-tools", "unknown-send", "unknown-launcher", "legacy", "damaged", "missing"] as const) {
  test(`page lifetime: HTTP recovery ignores ${history} old task evidence`, async () => {
    const f = httpFixture();
    if (history === "unknown-tools") { f.controls.invokeSourceTools = true; f.controls.singleSourceTool = true; }
    if (history === "unknown-send") f.controls.failAfterSendOnce = true;
    await (await f.send(f.body)).text();
    const store = new ContinuityRecoveryStore(f.statePath);
    const thread = continuityDigest(f.threadId);
    const before = store.get(thread);
    const previousIdentity = before ? recoveryIdentity(before, store.installationId()) : f.submissions[0]!.claim.recovery!;
    f.pages.clear();
    f.controls.invokeSourceTools = false;
    if (history === "unknown-launcher") f.controls.inspectFailures = 1;
    if (history === "legacy") {
      const document = JSON.parse(readFileSync(join(f.statePath, "recovery.json"), "utf8"));
      document.version = 2;
      document.threads[thread] = { thread, scope: before!.scope, version: 0, epoch: 0, historyRevision: 0,
        owner: before!.owner, state: "lost", legacyUnproven: true, works: {}, lineages: {}, calls: {}, compactionTargets: {}, checkpoints: {} };
      writeFileSync(join(f.statePath, "recovery.json"), JSON.stringify(document), { mode: 0o600 });
    }
    if (history === "damaged") writeFileSync(join(f.statePath, "recovery.json"), "{broken", { mode: 0o600 });
    if (history === "missing") rmSync(join(f.statePath, "recovery.json"));
    const response = await f.send({ ...f.body, input: [...f.body.input,
      { type: "function_call", call_id: "historical-call", name: "exec_command", arguments: '{"cmd":"must-not-run"}' },
      { type: "function_call_output", call_id: "historical-call", output: "Historical completed output." },
    ] });
    expect(response.status, await response.clone().text()).toBe(200);
    const responseBody = await response.json();
    expect(responseBody.status, JSON.stringify(responseBody)).toBe("completed");
    expect(f.submissions).toHaveLength(2);
    expect(f.controls.toolResults).toHaveLength(0);
    expect(() => store.assertExecutionAuthority(previousIdentity)).toThrow();
    expect(Object.keys(store.get(thread)!.works)).toHaveLength(1);
  });
}

for (const history of ["damaged", "missing"] as const) for (const retired of [false, true]) {
  test(`page lifetime: HTTP ${history} recovery preserves the ${retired ? "retired" : "accepted"} inbox fence`, async () => {
    const f = httpFixture();
    await (await f.send(f.body)).text();
    const recovery = new ContinuityRecoveryStore(f.statePath);
    const thread = continuityDigest(f.threadId);
    const identity = { thread, scope: recovery.get(thread)!.scope, taskId: `task_${taskUpdateDigest([thread, "turn-first"])}` };
    const inbox = new ContinuityTaskInputStore(f.statePath);
    inbox.receive(identity, [{ messageId: "saved-input", text: "Retain this accepted instruction." }]);
    if (retired) inbox.deleteTask(identity);
    const journal = join(f.statePath, "recovery.json"), original = readFileSync(journal);
    const payloadDirectory = join(f.statePath, "task-input-payloads");
    const payloads = readdirSync(payloadDirectory).map(file => ({ file, body: readFileSync(join(payloadDirectory, file)) }));
    expect(payloads).toHaveLength(retired ? 0 : 1);
    f.pages.clear();
    if (history === "damaged") writeFileSync(journal, "{broken", { mode: 0o600 });
    else rmSync(journal);
    try {
      const response = await f.send(f.body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("continuity_configuration_conflict");
      expect(f.submissions).toHaveLength(1);
      expect(existsSync(payloadDirectory)).toBe(true);
      expect(readdirSync(payloadDirectory)).toEqual(payloads.map(payload => payload.file));
      for (const payload of payloads) expect(readFileSync(join(payloadDirectory, payload.file))).toEqual(payload.body);
      if (history === "damaged") expect(readFileSync(journal, "utf8")).toBe("{broken");
      else expect(existsSync(journal)).toBe(false);
    } finally {
      // Restore only the test fault so fixture disposal can inspect its records.
      writeFileSync(journal, original, { mode: 0o600 });
    }
  });
}

test("page lifetime: retired HTTP source cannot inspect or retire its healthy successor", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  const recovery = new ContinuityRecoveryStore(f.statePath);
  const thread = continuityDigest(f.threadId);
  const identity = { thread, scope: recovery.get(thread)!.scope, taskId: `task_${taskUpdateDigest([thread, "turn-first"])}` };
  const inbox = new ContinuityTaskInputStore(f.statePath);
  inbox.receive(identity, [{ messageId: "old-input", text: "Retire this task source." }]);
  inbox.deleteTask(identity);
  const next = { ...(f.next(parseRequest(f.body))._rawBody as Record<string, unknown>), model: f.body.model, reasoning: f.body.reasoning };
  const successorResponse = await f.send(next);
  expect(successorResponse.status, await successorResponse.clone().text()).toBe(200);
  expect((await successorResponse.json()).status).toBe("completed");
  const successor = recovery.get(thread)!;
  expect(successor.works[successor.currentWorkId!]!.nativeTurnId).toBe("turn-next");
  const registrations = readFileSync(join(f.statePath, "threads.json"), "utf8");
  const pages = [...f.pages.keys()];
  f.controls.inspectFailures = 1;
  try {
    const response = await f.send(f.body);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("continuity_stopped");
    expect(f.controls.inspectFailures).toBe(1);
    expect(recovery.get(thread)).toEqual(successor);
    expect(readFileSync(join(f.statePath, "threads.json"), "utf8")).toBe(registrations);
    expect([...f.pages.keys()]).toEqual(pages);
    expect(f.submissions).toHaveLength(2);
  } finally { f.controls.inspectFailures = 0; }
});

test("page lifetime: concurrent identical HTTP recovery sends once and live payload conflicts stay rejected", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  f.pages.clear();
  const responses = await Promise.all([f.send(f.body), f.send(f.body), f.send(f.body)]);
  for (const response of responses) {
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).status).toBe("completed");
  }
  expect(f.submissions).toHaveLength(2);
  const changed = structuredClone(f.body);
  (changed.input[0] as { content: string }).content = "Conflicting current payload.";
  const rejected = await f.send(changed);
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).error.code).toBe("continuity_source_unproven");
  expect(f.submissions).toHaveLength(2);
});

test("page lifetime: closed HTTP compaction uses current source without an old checkpoint journal", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  f.pages.clear();
  const response = await f.send(f.body, true);
  expect(response.status, await response.clone().text()).toBe(200);
  const result = await response.json();
  expect(result.output.some((item: { type: string }) => ["compaction", "message"].includes(item.type))).toBe(true);
  expect(JSON.stringify(result)).toContain("Verified checkpoint.");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
});

for (const manual of [false, true]) for (const layout of ["marker", "summary"] as const) test(`page lifetime: closed ${layout} continuation restores current instruction manual=${manual}`, async () => {
  const f = httpFixture(manual);
  await (await f.send(f.body)).text();
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const old = binding.recovery!;
  f.pages.clear();
  continuityBindingsFor(f.statePath).forgetPage(binding, binding.executionKey);
  expect(new ContinuityRecoveryStore(f.statePath).get(old.thread)).toBeUndefined();
  const summary = "Current task summary: preserve the accepted output and complete the current request.";
  const checkpoint = layout === "marker" ? { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }
    : { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` };
  const response = await f.send({ ...f.body, input: [checkpoint,
    { type: "message", role: "user", id: "carried-current-instruction", content: "Complete the task from the current summary.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } }] });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("Complete the task from the current summary.");
  const next = new ContinuityRecoveryStore(f.statePath).get(old.thread)!;
  expect(next.works[old.logicalWorkId]).toBeUndefined();
  expect(Object.keys(next.checkpoints)).toHaveLength(0);
});

test("page lifetime: Launcher destroyed removes only its exact page generation", async () => {
  const f = httpFixture();
  await (await f.send(f.body)).text();
  const bindings = continuityBindingsFor(f.statePath), thread = continuityDigest(f.threadId);
  const binding = bindings.observed(thread)!, store = bindings.recoveryStore;
  const identity = recoveryIdentity(store.get(thread)!, store.installationId());
  const host = { continuityAuthorityDirectories: new Map([[identity.installationId, f.statePath]]), turnTabs: new Map(),
    continuityTransactions: new Map(), continuityTransactionReceipts: new Map() };
  const tab = { id: "destroyed-original", continuityRecovery: identity, view: { webContents: { isDestroyed: () => true } } };
  launcherRecovery.removedContinuityTab(host, tab);
  expect(store.get(thread)).toBeUndefined(); expect(bindings.registrations.get(thread)).toBeUndefined();
  expect(() => store.assertExecutionAuthority(identity)).toThrow();
  f.pages.clear();
  const response = await f.send(f.body); expect(response.status).toBe(200); expect((await response.json()).status).toBe("completed");
  const successor = store.get(thread)!;
  launcherRecovery.removedContinuityTab(host, tab);
  expect(store.get(thread)).toEqual(successor);
  expect(bindings.registrations.get(thread)?.epoch).toBe(successor.epoch);
  bindings.lose(binding, binding.executionKey);
  expect(store.get(thread)).toEqual(successor);
});

for (const taskUpdates of [false, true]) for (const variant of ["identical", "changed-result", "unknown-result", "changed-instruction"] as const) {
  test(`page lifetime: pending cold HTTP creation handles ${variant} carried result history taskUpdates=${taskUpdates}`, async () => {
    const f = httpFixture(false, taskUpdates);
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
    f.controls.nativeSourceTools = taskUpdates;
    const source = await (await f.send(f.body)).json();
    const call = source.output.find((item: { type: string }) => item.type === "function_call");
    expect(call).toBeDefined();
    const body = structuredClone(f.body);
    body.input.push(...source.output, { type: "function_call_output", call_id: call.call_id, output: "Original inert outer result." });
    f.pages.clear();
    f.controls.invokeSourceTools = false;
    let release!: () => void, entered!: () => void, preparations = 0;
    const holdFirst = new Promise<void>(resolve => { release = resolve; });
    const firstPrepared = new Promise<void>(resolve => { entered = resolve; });
    const factory = () => {
      const adapter = f.adapter();
      return { ...adapter, async preflight(...args: Parameters<NonNullable<typeof adapter.preflight>>) {
        await adapter.preflight!(...args);
        if (++preparations === 1) { entered(); await holdFirst; }
      } };
    };
    const send = (value: unknown) => responseRequest(new Request("http://fixture.invalid/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    }), f.config, factory, { rememberState: false });
    const first = send(body);
    await firstPrepared;
    const other = structuredClone(body);
    if (variant === "changed-result") (other.input.at(-1) as { output: string }).output = "Changed inert outer result.";
    if (variant === "unknown-result") other.input.push({ type: "function_call_output", call_id: "unowned-call", output: "Unowned result." });
    if (variant === "changed-instruction") (other.input[0] as { content: string }).content = "Conflicting current instruction.";
    let originalResponse: Response | undefined;
    try {
      const response = await send(other);
      const result = await response.json();
      if (variant === "identical") {
        expect(response.status, JSON.stringify(result.error)).toBe(200);
        expect(result.status, JSON.stringify(result.error)).toBe("completed");
      } else {
        expect(response.status).toBe(409);
        expect(result.error.code).toBe("continuity_source_unproven");
      }
    } finally { release(); originalResponse = await first; }
    const response = originalResponse!;
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("completed");
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1]!.prompt).toContain("Original inert outer result.");
    expect(f.submissions[1]!.prompt).not.toContain("Changed inert outer result.");
  }, 30_000);
}
