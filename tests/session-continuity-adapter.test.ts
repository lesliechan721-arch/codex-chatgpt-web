import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { cancelStructuredCompactionNativeTurn, existingStructuredCompactionRun } from "../src/adapters/chatgpt-web/compaction-handoff";
import { isAcceptedCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, type ContinuityClaim, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { cancelAbandonedContinuityCreation, leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptCurrentInstructionIndex, chatGptCurrentInstructionRevision, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint, defaultConfig } from "../src/config";
import * as configuration from "../src/config";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { COMPACT_PROMPT, decodeCompactionSummary, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest, routeChatGptWebRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  chatGptTurnSessions.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(manual = false, options: { codexHome?: string; threadId?: string } = {}) {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-cont-adapter-"));
  const statePath = join(root, "continuity");
  const registrations = new ContinuityRegistrationStore(statePath);
  registrations.initialize();
  const pages = new Map<string, { continuity: ContinuityLease; state: "ready" | "running" }>();
  const submissions: Array<{ prompt: string; claim: ContinuityClaim; key: string; reused: boolean }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/turn/continuity-capacity") {
        controls.onCapacityQuery?.();
        return Response.json({ ok: true, available: controls.capacityAvailable });
      }
      const body = await request.json() as { conversationKey: string; expected: ContinuityLease };
      const page = pages.get(body.conversationKey);
      const matches = page && JSON.stringify(page.continuity) === JSON.stringify(body.expected);
      if (new URL(request.url).pathname === "/v1/turn/release") {
        if (matches) pages.delete(body.conversationKey);
        return Response.json({ ok: true, released: matches ? 1 : 0 });
      }
      return matches ? Response.json({ ok: true, ...page }) : Response.json({ ok: false }, { status: 409 });
    },
  });
  cleanups.push(async () => {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });
  const descriptorPath = join(root, "launcher.json");
  const descriptor = {
    version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    features: [CONTINUITY_FEATURE], endpoint: `http://127.0.0.1:${server.port}`,
    control: { endpoint: `http://127.0.0.1:${server.port}`, token: "a".repeat(43) },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString(),
  };
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `fixture://${root}`,
    chatgptWeb: {
      browserInteractionMode: manual ? "manual" : "automatic",
      browserHost: "launcher", browserHostDescriptorPath: descriptorPath,
      appName: manual ? ZERO_RISK_CHATGPT_CONNECTOR_NAME : CHATGPT_CONNECTOR_NAME,
      brokerSocketPath: defaultBrokerEndpoint(root), continuityStateDirectory: statePath,
      localToolsEnabled: true, solAvailable: !manual, proAvailable: false, extraHighAvailable: false,
      toolAuthorityMode: "delegated", zeroRiskRequireSentConfirmation: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const compatible = spyOn(worker, "assertContinuityCompatible").mockResolvedValue();
  const controls = {
    capacityAvailable: true,
    emitReviewCommentary: false,
    reviewWireName: "exec_command",
    onCapacityQuery: undefined as (() => void) | undefined,
    preLeaseFailures: 0,
    loseStartAcknowledgementOnce: false,
    failHandoffSettlement: false,
    endFailure: false, deferCompletion: false, safeToken: "", started: false,
    handoffSummary: "Verified checkpoint.", invokeSourceTools: false, singleSourceTool: false, parallelSourceTools: false,
    pauseAfterToolResults: false, repeatManualSourceTool: false,
    sourceToken: "", toolResults: [] as BrokerToolResult[], modelTask: undefined as Promise<void> | undefined,
    releaseDeferredCompletion: undefined as (() => void) | undefined,
    releaseAfterToolResults: undefined as (() => void) | undefined,
};
  const sourceTools = async (token: string) => {
    controls.sourceToken = token;
    const claim = await callTurnBroker<{ bindingId: string; activityId?: string; environment: { registryGeneration: number } }>(
      provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token, ...(manual ? { contract: "safe" } : {}) });
    const invoke = () => callTurnBroker<BrokerToolResult>(provider.chatgptWeb!.brokerSocketPath!, {
      method: "invoke", bindingId: claim.bindingId, wireName: controls.reviewWireName, freeform: false,
      registryGeneration: claim.environment.registryGeneration,
      arguments: { cmd: "fixture-command-not-executed-by-this-test" },
    }, null);
    if (!manual && controls.parallelSourceTools && !controls.singleSourceTool) {
      controls.toolResults.push(...await Promise.all([invoke(), invoke()]));
    } else {
      controls.toolResults.push(await invoke());
      if ((!manual || controls.repeatManualSourceTool) && !controls.singleSourceTool) controls.toolResults.push(await invoke());
    }
    if (claim.activityId) await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "activity_complete", token, activityId: claim.activityId,
    });
  };
  const accept = (key: string, claim: ContinuityClaim, traceId: string, required: boolean | undefined) => {
    const previous = pages.get(key);
    if (claim.expected) {
      expect(required).toBe(true);
      expect(previous).toEqual({ continuity: claim.expected, state: "ready" });
    } else if (previous) {
      // An exact retry may arrive after Launcher created the page but its start acknowledgement
      // was lost. The same owner/trace reuses that provisional page instead of allocating one.
      expect(previous.continuity.owner).toBe(claim.owner);
      expect(previous.continuity.traceId).toBe(traceId);
    }
    const continuity: ContinuityLease = {
      owner: claim.owner, leaseId: previous?.continuity.leaseId ?? "1".repeat(32), traceId,
    };
    pages.set(key, { continuity, state: "running" });
    return continuity;
  };
  const automatic = spyOn(worker, "run").mockImplementation(async (turn: BrowserTurn) => {
    if (manual) throw new Error("Zero Risk must not use the automatic worker");
    if (controls.preLeaseFailures > 0) {
      controls.preLeaseFailures--;
      throw continuityError("continuity_resource_capacity", "Launcher rejected the turn before creating a page");
    }
    const hadPage = pages.has(turn.conversationKey!);
    const lease = accept(turn.conversationKey!, turn.continuity!, turn.traceId, turn.requireRetainedConversation);
    if (controls.loseStartAcknowledgementOnce && !hadPage && !turn.continuity!.expected) {
      controls.loseStartAcknowledgementOnce = false;
      expect(accept(turn.conversationKey!, turn.continuity!, turn.traceId, turn.requireRetainedConversation)).toEqual(lease);
    }
    turn.onContinuityLease!(lease);
    const compiled = await (turn.requireRetainedConversation ? turn.prepareResume!() : turn.prepare());
    submissions.push({ prompt: compiled.text, claim: turn.continuity!, key: turn.conversationKey!, reused: Boolean(turn.requireRetainedConversation) });
    if (turn.nativeConnector) {
      const token = compiled.text.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
      const handoffId = compiled.text.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
      expect(token).toBeDefined();
      expect(handoffId).toBeDefined();
      const aborted = new Promise<void>(resolve => {
        if (turn.abortSignal?.aborted) resolve();
        else turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
        method: "submit_compaction_handoff", token, handoffId, summary: controls.handoffSummary,
      });
      await aborted;
      expect(turn.retainConversation).toBe(true);
      if (controls.failHandoffSettlement) {
        pages.delete(turn.conversationKey!);
        throw new Error("The accepted handoff has no proven physical settlement");
      }
      pages.get(turn.conversationKey!)!.state = "ready";
      return "";
    }
    if (controls.emitReviewCommentary) turn.onCommentary?.("Checking the source before continuing.");
    await turn.onSubmitted?.();
    if (controls.deferCompletion) {
      controls.started = true;
      await new Promise<void>(resolve => { controls.releaseDeferredCompletion = resolve; });
      controls.releaseDeferredCompletion = undefined;
    }
    if (controls.invokeSourceTools) {
      const token = compiled.text.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)?.[1];
      expect(token).toBeDefined();
      const calls = sourceTools(token!);
      void calls.catch(() => {});
      // The real worker captures the current answer before acknowledging a delivered batch.
      // This fixture has no DOM, but must still cross the same causal boundary.
      let progress = turn.externalProgress!.snapshot();
      while (progress.lastToolBatchRevision === 0) {
        progress = await turn.externalProgress!.waitForChange(progress.revision, turn.abortSignal);
      }
      await turn.externalProgress!.acknowledgeToolBatch(progress.lastToolBatchRevision);
      await calls;
      if (controls.pauseAfterToolResults) {
        await new Promise<void>(resolve => { controls.releaseAfterToolResults = resolve; });
        controls.releaseAfterToolResults = undefined;
      }
    }
    const answer = controls.invokeSourceTools ? "Stopped at the accepted tool boundary." : `Completed response ${submissions.length}.`;
    turn.onTextDelta(answer);
    expect(turn.retainConversation).toBe(true);
    pages.get(turn.conversationKey!)!.state = "ready";
    return answer;
  });
  const manualControl: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      if (controls.preLeaseFailures > 0) {
        controls.preLeaseFailures--;
        throw continuityError("continuity_resource_capacity", "Launcher rejected the turn before creating a page");
      }
      const hadPage = pages.has(activity.conversationKey!);
      const continuity = accept(activity.conversationKey!, activity.continuity!, activity.traceId, activity.requireRetainedConversation);
      const prompt = activity.requireRetainedConversation ? activity.resumePrompt! : activity.prompt;
      if (activity.continuity!.expected || !hadPage) {
        submissions.push({ prompt, claim: activity.continuity!, key: activity.conversationKey!, reused: Boolean(activity.requireRetainedConversation) });
        controls.safeToken = JSON.parse(prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id;
      }
      if (controls.loseStartAcknowledgementOnce && !hadPage && !activity.continuity!.expected) {
        controls.loseStartAcknowledgementOnce = false;
        expect(accept(activity.conversationKey!, activity.continuity!, activity.traceId, activity.requireRetainedConversation)).toEqual(continuity);
      }
      return { continuity };
    },
    async waitSent() { broker.startSafeTurn(controls.safeToken); },
    waitTerminal: () => new Promise<never>(() => {}),
    async markStarted() {
      controls.started = true;
      if (controls.invokeSourceTools) {
        const token = controls.safeToken;
        controls.modelTask = sourceTools(token).then(() => { broker.completeSafeTurn(token, controls.handoffSummary); });
        void controls.modelTask.catch(() => {});
      } else if (!controls.deferCompletion) broker.completeSafeTurn(controls.safeToken, `Completed response ${submissions.length}.`);
    },
    async end(_path, activity) {
      for (const page of pages.values()) if (page.continuity.traceId === activity.traceId) page.state = "ready";
      if (controls.endFailure) throw new Error("Lost end acknowledgement");
    },
    async cancel() {},
  };
  cleanups.push(async () => {
    controls.releaseDeferredCompletion?.();
    controls.releaseAfterToolResults?.();
    automatic.mockRestore(); compatible.mockRestore();
    await broker.close();
    await controls.modelTask?.catch(() => {});
  });
  const threadId = options.threadId ?? `thread-${root}`;
  const request = (text = "First continuity instruction.", turnId = "turn-first", input?: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({
      model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : "gpt-5.6-sol", stream: false,
      reasoning: { effort: "low" }, tools: [{
        type: "function", name: "exec_command", description: "Fixture command; Native execution is simulated by the test.",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
      input: input ?? [{ type: "message", id: `msg-${turnId}`, role: "user", content: text,
        internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
    });
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const next = (previous: CodexParsedRequest, turnId = "turn-next", answer = "Completed response 1.") => request("", turnId, [
    ...(previous._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] },
    { type: "message", role: "user", id: `msg-${turnId}`, content: "Next continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: turnId } },
  ]);
  const adapter = () => createChatGptWebAdapter(provider, { broker, zeroRiskManualControl: manualControl, codexHome: options.codexHome });
  const run = async (parsed: CodexParsedRequest) => {
    const current = adapter();
    const events: AdapterEvent[] = [];
    await current.preflight!(parsed, { headers: new Headers() });
    await current.runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    return events;
  };
  return { provider, request, next, adapter, run, registrations, statePath, threadId, pages, submissions, compatible, automatic, descriptor, descriptorPath, controls, broker };
}

function httpFixture(manual = false) {
  const f = fixture(manual);
  const config = {
    ...defaultConfig("full"), browserHost: "launcher" as const,
    browserInteractionMode: manual ? "manual" as const : "automatic" as const,
    solAvailable: !manual,
  };
  const body: Record<string, unknown> & { model: string; stream: boolean; input: unknown[] } = {
    ...(f.request()._rawBody as Record<string, unknown>),
    input: (f.request()._rawBody as { input: unknown[] }).input,
    model: `chatgpt-web-continuity/${manual ? "zero-risk" : "gpt-5.6-sol"}`,
    reasoning: { effort: manual ? "low" : "medium" },
    stream: false,
  };
  const send = (value: unknown, compact = false, rememberState = false, signal?: AbortSignal) => {
    const request = new Request(`http://127.0.0.1/v1/responses${compact ? "/compact" : ""}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
      ...(signal ? { signal } : {}),
    });
    return compact ? compactRequest(request, config, () => f.adapter())
      : responseRequest(request, config, () => f.adapter(), { rememberState });
  };
  return { ...f, config, body, send };
}

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse().map(([key, child]) => [key, reverseJsonObjectKeys(child)]));
}

// Observed with Codex 0.158.0 against an isolated Responses stub: response-only
// status and output_text annotations are not serialized back into input history.
function codexRoundtrippedOutput(output: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return output.map(({ status: _status, ...item }) => {
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content = item.content.map(({ annotations: _annotations, ...part }) => part);
    }
    return item;
  });
}

for (const manual of [false, true]) for (const stream of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} ${stream ? "streamed" : "JSON"} accepts Codex-roundtripped tool output without repeating work`, async () => {
  const f = httpFixture(manual);
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
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject(manual
      ? { httpStatus: format === "v1" ? 400 : 200, error: { code: "continuity_manual_handoff_required" },
        ...(format === "v1" ? {} : { status: "failed", retryable: false }) }
      : { httpStatus: 200 });
    expect(f.submissions).toHaveLength(manual ? 1 : 2);
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
  const legacy = f.next(f.request());
  legacy._conversationPolicy = "recoverable";
  await expect(f.adapter().preflight!(legacy, { headers: new Headers() }))
    .rejects.toThrow("Finish or explicitly cancel the current continuity work");

  const cancelled = chatGptTurnSessions.cancelNativeTurn(f.threadId, "turn-first", new Error("Explicit test cancellation"));
  expect(cancelled.cancelled).toBe(1);
  await cancelled.settlement;
  await f.adapter().preflight!(legacy, { headers: new Headers() });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("lost");
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
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
  expect(retry.status).toBe(200);
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
  const f = httpFixture(manual);
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
  const repeated = await f.send(body);
  expect(repeated.status).toBe(409);
  expect((await repeated.json()).error.code).toBe("continuity_session_lost");
  expect(f.submissions).toHaveLength(2);
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
        expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
        expect(f.pages.size).toBe(0);
        return Response.json({ id: "native-fixture-response", status: "completed", output: [] });
      },
    });
    expect({ httpStatus: response.status, ...await response.json() }).toMatchObject({ httpStatus: 200, status: "completed" });
    expect(forwarded).toBe(1);
    expect((await f.send(f.body)).status).toBe(409);
    expect(f.submissions).toHaveLength(1);
  } finally { provider.mockRestore(); }
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} strictly resumes one leased page and exact reconnect does not submit again`, async () => {
  const f = fixture(manual);
  const first = f.request();
  const firstEvents = await f.run(first);
  expect(firstEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const second = f.next(first);
  second._continuityHistoryRevision = 999;
  const secondEvents = await f.run(second);
  expect(second._continuityHistoryRevision).toBe(0);
  expect(secondEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[0]!.key).toBe(f.submissions[1]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("First continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
  const repeated = await f.run(second);
  expect(repeated.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  if (manual) { expect(f.automatic).not.toHaveBeenCalled(); expect(f.compatible).not.toHaveBeenCalled(); }
});

test("first input preflight rejects the actual over-limit prompt before registration or page creation", async () => {
  const f = fixture();
  await expect(f.run(f.request("oversized ".repeat(100_000)))).rejects.toMatchObject({ code: "continuity_input_limit", retryable: false });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.submissions).toHaveLength(0);
  expect(f.pages.size).toBe(0);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} capacity rejection preserves the unused first-creation right`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.capacityAvailable = false;
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_resource_capacity", retryable: false });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(0);
  f.controls.capacityAvailable = true;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  f.controls.capacityAvailable = false;
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page launcher rejection keeps the claimed creation transaction retryable`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(0);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} retryable initial creation keeps its first accepted payload and prompt`, async () => {
  const payload = fixture(manual);
  const first = payload.request();
  payload.controls.preLeaseFailures = 1;
  expect((await payload.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  await expect(payload.run(payload.request("Changed current instruction.", "turn-first")))
    .rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(payload.submissions).toHaveLength(0);

  const history = fixture(manual);
  const original = history.request("", "turn-first", [
    { type: "message", role: "user", id: "msg-history", content: "Original initial history.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-history" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Historical answer." }] },
    { type: "message", role: "user", id: "msg-turn-first", content: "First continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  history.controls.preLeaseFailures = 1;
  expect((await history.run(original)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const changedHistory = structuredClone(original);
  const changedInput = (changedHistory._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput[0]!.content = "Changed initial history.";
  expect((await history.run(changedHistory)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(history.submissions).toHaveLength(1);
  expect(history.submissions[0]!.prompt).toContain("Original initial history.");
  expect(history.submissions[0]!.prompt).not.toContain("Changed initial history.");
});

for (const manual of [false, true]) for (const retryable of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${retryable ? "creating" : "completed"} initial replay ignores completed ID-only history and removed turn metadata`, async () => {
  const f = fixture(manual);
  const first = f.request("", "turn-first", [
    { type: "message", role: "user", id: "old-with-turn", content: "Original completed history.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "assistant", content: "Old answer." },
    { type: "message", role: "user", id: "old-without-turn", content: "Original ID-only history." },
    { type: "message", role: "assistant", content: "Other old answer." },
    { type: "message", role: "user", id: "msg-turn-first", content: "Current instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  f.controls.preLeaseFailures = retryable ? 1 : 0;
  const accepted = await f.run(first);
  const input = structuredClone((first._rawBody as { input: Array<Record<string, unknown>> }).input);
  delete input[0]!.internal_chat_message_metadata_passthrough;
  input[0]!.content = "Changed completed history.";
  input[2]!.content = "Changed ID-only history.";
  const replay = await f.run(f.request("", "turn-first", input));
  expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
  if (!retryable) expect(replay).toEqual(accepted);
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[0]!.prompt).toContain("Original ID-only history.");
  expect(f.submissions[0]!.prompt).not.toContain("Changed ID-only history.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume rejects an unowned completed instruction before submitting`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", id: "completed-external", content: "Old external instruction." },
    { type: "message", role: "assistant", content: "Completed external response." },
    { type: "message", role: "user", id: "msg-turn-next", content: "Current next instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume retains adjacent ID-only and tagged current instructions`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", id: "current-constraint", content: "Keep this current constraint." },
    { type: "message", role: "user", id: "msg-turn-next", content: "Current next instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  const accepted = await f.run(next);
  expect(f.submissions[1]!.prompt).toContain("Keep this current constraint.");
  expect(f.submissions[1]!.prompt).toContain("Current next instruction.");
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  const changed = structuredClone(next);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === "current-constraint")!.content = "Changed current constraint.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) for (const terminal of ["interrupt", "mode-exit", "lost"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${terminal} releases the captured input of failed initial creation`, async () => {
  const f = fixture(manual);
  f.controls.preLeaseFailures = 1;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("creating");
  expect(binding.initialAcceptedInput).toBeDefined();
  expect(binding.initialInstructionPayloadDigest).toBeDefined();
  if (terminal === "interrupt") expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-first")).toBe(true);
  else if (terminal === "mode-exit") await leaveContinuityMode(f.statePath, f.threadId);
  else bindings.lose(binding, binding.executionKey);
  expect(binding.state).toBe(terminal === "lost" ? "lost" : "ended");
  expect(binding.initialAcceptedInput).toBeUndefined();
  expect(binding.initialInstructionPayloadDigest).toBeUndefined();
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(0);
});

for (const manual of [false, true]) for (const checkpoint of [false, true]) for (const tagged of [false, true]) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${checkpoint ? "checkpoint" : "ordinary"} increment keeps ${tagged ? "tagged" : "ID-only"} ${trailing ? "trailing" : "leading"} current system and developer constraints`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = checkpoint;
  f.controls.singleSourceTool = true;
  const first = f.request("", "turn-first", [
    { type: "message", role: "system", content: "OLD_SYSTEM_CONTEXT.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "developer", content: "OLD_DEVELOPER_CONTEXT.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    ...(f.request()._rawBody as { input: unknown[] }).input,
  ]);
  await f.run(first);
  let base: unknown[] = [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
  ];
  if (checkpoint) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Actual checkpoint source result." },
    ]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    base = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
    f.controls.invokeSourceTools = false;
  }
  const envelopes = (["system", "developer"] as const).map(role => ({
      type: "message", role, id: `current-${role}`, content: `CURRENT_${role.toUpperCase()}_CONSTRAINT.`,
      ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } } : {}),
    }));
  const next = f.request("", "turn-next", [
    ...base,
    ...(!trailing ? envelopes : []),
    { type: "message", role: "user", id: "msg-turn-next", content: "Current work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    ...(trailing ? envelopes : []),
  ]);
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  expect(prompt).toContain("CURRENT_SYSTEM_CONSTRAINT.");
  expect(prompt).toContain("CURRENT_DEVELOPER_CONSTRAINT.");
  expect(prompt).not.toContain("OLD_SYSTEM_CONTEXT.");
  expect(prompt).not.toContain("OLD_DEVELOPER_CONTEXT.");
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  for (const role of ["system", "developer"] as const) {
    const changed = structuredClone(next);
    (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === `current-${role}`)!.content = "Conflicting current constraint.";
    await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const role of ["system", "developer"] as const) for (const tagged of [false, true]) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} failed first creation rejects changed ${tagged ? "tagged" : "untagged"} ${trailing ? "trailing" : "leading"} ${role} constraint`, async () => {
  const f = fixture(manual);
  const envelope = { type: "message", role, id: "current-envelope", content: "Accepted current constraint.",
    ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}) };
  const first = f.request("", "turn-first", [
    ...(!trailing ? [envelope] : []),
    ...(f.request()._rawBody as { input: unknown[] }).input,
    ...(trailing ? [envelope] : []),
  ]);
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const changed = structuredClone(first);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === "current-envelope")!.content = "Conflicting current constraint.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(0);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) for (const retainSource of [false, true]) for (const tagged of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint-only keeps ${tagged ? "tagged" : "untagged"} trailing constraints with source ${retainSource ? "retained" : "recovered"}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint source result." },
  ]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const continuation = f.request("", "turn-first", [
    ...(retainSource ? (first._rawBody as { input: unknown[] }).input : []),
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(["system", "developer"] as const).map(role => ({
      type: "message", role, id: `tail-${role}`, content: `CURRENT_CHECKPOINT_${role.toUpperCase()}.`,
      ...(tagged ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } } : {}),
    })),
  ]);
  const accepted = await f.run(continuation);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions.at(-1)!.prompt).toContain("CURRENT_CHECKPOINT_SYSTEM.");
  expect(f.submissions.at(-1)!.prompt).toContain("CURRENT_CHECKPOINT_DEVELOPER.");
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(continuation))).toEqual(accepted);
  for (const role of ["system", "developer"] as const) {
    const changed = structuredClone(continuation);
    (changed._rawBody as { input: Array<Record<string, unknown>> }).input.find(item => item.id === `tail-${role}`)!.content = "Changed checkpoint constraint.";
    await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${entry} keeps a ${trailing ? "trailing" : "leading"} prior-turn abort notice contextual`, async () => {
  const f = fixture(manual);
  const first = f.request();
  let base: unknown[] = [];
  if (entry !== "initial") {
    f.controls.invokeSourceTools = entry === "checkpoint";
    f.controls.singleSourceTool = manual;
    await f.run(first);
    base = [...(first._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: "Completed response 1." }];
    if (entry === "checkpoint") {
      const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
      const compact = f.request("", "turn-first", [
        ...(first._rawBody as { input: unknown[] }).input,
        { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
      ]);
      compact._compactionRequest = true;
      const summary = (await f.run(compact)).find(event => event.type === "text_delta");
      if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
      base = [...(first._rawBody as { input: unknown[] }).input,
        { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
      f.controls.invokeSourceTools = false;
    }
  }
  const notice = { type: "message", role: "user", ...(trailing ? { id: "prior-notice" } : {}),
    content: "<turn_aborted>The previous turn was interrupted.</turn_aborted>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-prior" } };
  const current = { type: "message", role: "user", id: "current-task", content: "Current valid task.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } };
  const request = f.request("", "turn-next", [...base, ...(trailing ? [current, notice] : [notice, current])]);
  const submissions = f.submissions.length;
  const accepted = await f.run(request);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.prompt).toContain("Current valid task.");
  if (entry !== "initial") expect(f.submissions.at(-1)!.prompt).not.toContain("previous turn was interrupted");
  expect(await f.run(structuredClone(request))).toEqual(accepted);
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} current-turn abort literal remains work while an anonymous notice rejects`, async () => {
  const f = fixture(manual);
  const literal = "<turn_aborted>Explain this tag.</turn_aborted>";
  const first = f.request(literal);
  const accepted = await f.run(first);
  expect(f.submissions[0]!.prompt).toContain(literal);
  const anonymous = f.next(first);
  ((anonymous._rawBody as { input: unknown[] }).input).push({
    type: "message", role: "user", content: "<turn_aborted>Unknown ownership.</turn_aborted>",
  });
  await expect(f.run(anonymous)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect(await f.run(structuredClone(first))).toEqual(accepted);
});

for (const manual of [false, true]) for (const parentFirst of [false, true]) for (const checkpointOnly of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${checkpointOnly ? "checkpoint-only" : "initial"} current native role change rejects after ${parentFirst ? "parent" : "human"} input`, async () => {
  const f = fixture(manual);
  const raw = structuredClone(f.request("Same current text.")._rawBody) as {
    client_metadata: Record<string, string>; input: Array<Record<string, unknown>>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: f.threadId, turn_id: "turn-first", subagent_kind: "thread_spawn", request_kind: "turn",
    parent_thread_id: "thread-parent", agent_name: "/root/child",
  });
  const human = raw.input[0]!;
  const parent = { ...human, type: "agent_message", author: "/root", recipient: "/root/child" };
  delete (parent as Record<string, unknown>).role;
  let checkpoint: unknown[] = [];
  const request = (item: Record<string, unknown>) => {
    const parsed = parseRequest({ ...raw, input: [item, ...checkpoint] });
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const firstItem = parentFirst ? parent : human;
  const first = request(firstItem);
  f.controls.invokeSourceTools = checkpointOnly;
  f.controls.singleSourceTool = manual;
  let accepted = await f.run(first);
  if (checkpointOnly) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = parseRequest({ ...raw, input: [firstItem,
      { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." }] });
    compact._conversationPolicy = "continuity-first";
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
    checkpoint = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
    f.controls.invokeSourceTools = false;
    accepted = await f.run(request(firstItem));
  }
  await expect(f.run(request(parentFirst ? human : parent))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(await f.run(request(firstItem))).toEqual(accepted);
  expect(f.submissions).toHaveLength(checkpointOnly ? manual ? 2 : 3 : 1);
});

for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${entry} rejects ${trailing ? "trailing" : "leading"} anonymous current instruction before submitting`, async () => {
  const f = fixture(manual);
  const first = f.request();
  let base: unknown[] = [];
  if (entry !== "initial") {
    f.controls.invokeSourceTools = entry === "checkpoint";
    f.controls.singleSourceTool = manual;
    await f.run(first);
    base = [...(first._rawBody as { input: unknown[] }).input,
      { type: "message", role: "assistant", content: "Completed response 1." }];
    if (entry === "checkpoint") {
      const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
      const compact = f.request("", "turn-first", [
        ...(first._rawBody as { input: unknown[] }).input,
        { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
      ]);
      compact._compactionRequest = true;
      const summary = (await f.run(compact)).find(event => event.type === "text_delta");
      if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
      base = [...(first._rawBody as { input: unknown[] }).input,
        { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }];
      f.controls.invokeSourceTools = false;
    }
  }
  const anonymous = { type: "message", role: "user", content: "Required current constraint without identity." };
  const current = { type: "message", role: "user", id: "current-task", content: "Current task.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } };
  const input = [...base, ...(trailing ? [current, anonymous] : [anonymous, current])];
  const submissions = f.submissions.length;
  await expect(f.run(f.request("", "turn-next", input))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const changed = input.map(item => item === anonymous ? { ...anonymous, content: "Conflicting anonymous constraint." } : item);
  await expect(f.run(f.request("", "turn-next", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(f.request("", "turn-next", [...base, current]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.pages.size).toBe(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} anonymous completed history does not enter the current payload`, async () => {
  const f = fixture(manual);
  const first = f.request("", "turn-first", [
    { type: "message", role: "user", content: "Old anonymous completed task." },
    { type: "message", role: "assistant", content: "Old completed answer." },
    ...(f.request()._rawBody as { input: unknown[] }).input,
  ]);
  const accepted = await f.run(first);
  const changed = structuredClone(first);
  (changed._rawBody as { input: Array<Record<string, unknown>> }).input[0]!.content = "Changed completed history.";
  expect(await f.run(changed)).toEqual(accepted);
  expect((await f.run(f.next(changed))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).not.toContain("anonymous completed task");
  expect(f.submissions[1]!.prompt).not.toContain("Changed completed history");
});

test("Automatic reclaimed result replay rejects without retiring the current owner", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
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
  const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const lease = { ...binding.lease! };
  for (let index = 0; index < 510; index++) source.completeRound(`completed-capacity-probe-${index}`);
  expect(source.continuityToolResultRoundKey(result)).toBe("tool-batch:1");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const predecessor = source.runExclusive(async () => {
    await gate;
    source.completeRound("causal-round-completed-before-replay");
  });
  const retry = structuredClone(result);
  const adapter = f.adapter();
  await adapter.preflight!(retry, { headers: new Headers() });
  let queued!: () => void;
  const enqueued = new Promise<void>(resolve => { queued = resolve; });
  const runExclusive = source.runExclusive.bind(source);
  const exclusive = spyOn(source, "runExclusive").mockImplementation(<T>(task: () => Promise<T>) => {
    queued();
    return runExclusive(task);
  });
  const replay = adapter.runTurn!(retry, { headers: new Headers() }, () => {}).catch(error => error);
  await enqueued;
  exclusive.mockRestore();
  release();
  await predecessor;
  expect(await replay).toMatchObject({ code: "continuity_source_unproven" });
  expect(source.roundEvents("tool-batch:1")).toEqual([]);
  expect(source.roundCompleted("tool-batch:1")).toBe(false);
  expect(binding.state).toBe("running");
  expect(binding.lease).toEqual(lease);
  expect(source.outstanding()[0]!.callId).toBe(currentCall);
  expect(f.controls.toolResults).toHaveLength(1);
  expect((await f.run(f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: currentCall, output: "Accepted current result." },
  ]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} anonymous current steering is rejected instead of replaying old work`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const steering = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    { type: "message", role: "user", content: "New steering without native identity." },
  ]);
  await expect(f.run(steering)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(f.next(first))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same-turn steering excludes explicitly foreign-turn work and constraints`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." },
    ...(["system", "developer", "user"] as const).map(role => ({
      type: "message", role, id: `foreign-${role}`, content: `OLD_FOREIGN_${role.toUpperCase()}_WORK.`,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" },
    })),
    { type: "message", role: "assistant", content: "Completed old work." },
    { type: "message", role: "user", id: "current-steering", content: "Current steering instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions[1]!.prompt).toContain("Current steering instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("OLD_FOREIGN_");
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent initial preflights reject a conflicting payload and preserve the accepted retry`, async () => {
  const f = fixture(manual);
  const requests = [f.request("First payload."), f.request("Conflicting payload.")];
  const adapters = requests.map(() => f.adapter());
  let capacityQueries = 0;
  f.controls.onCapacityQuery = () => { capacityQueries += 1; };
  const outcomes = await Promise.allSettled(requests.map((parsed, index) => (
    adapters[index]!.preflight!(parsed, { headers: new Headers() })
  )));
  expect(capacityQueries).toBe(2);
  expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.find(outcome => outcome.status === "rejected"))
    .toMatchObject({ reason: { code: "continuity_source_unproven" } });
  const acceptedIndex = outcomes.findIndex(outcome => outcome.status === "fulfilled");
  const accepted = requests[acceptedIndex]!;
  f.controls.preLeaseFailures = 1;
  const events: AdapterEvent[] = [];
  await adapters[acceptedIndex]!.runTurn!(accepted, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect((await f.run(structuredClone(accepted))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[0]!.prompt).toContain(accepted.context.messages[0]!.content as string);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent initial preflights with changed history share the first captured prompt`, async () => {
  const f = fixture(manual);
  const requests = ["Initial history A.", "Initial history B."].map(content => f.request("", "turn-first", [
    { type: "message", role: "user", id: "old-instruction", content,
      internal_chat_message_metadata_passthrough: { turn_id: "turn-old" } },
    { type: "message", role: "assistant", content: "Completed old answer." },
    { type: "message", role: "user", id: "msg-turn-first", content: "Current instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]));
  const adapters = requests.map(() => f.adapter());
  const accepted: number[] = [];
  await Promise.all(requests.map(async (parsed, index) => {
    await adapters[index]!.preflight!(parsed, { headers: new Headers() });
    accepted.push(index);
  }));
  const events: AdapterEvent[] = [];
  const laterIndex = accepted[1]!;
  await adapters[laterIndex]!.runTurn!(requests[laterIndex]!, { headers: new Headers() }, event => events.push(event));
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0]!.prompt).toContain(requests[accepted[0]!]!.context.messages[0]!.content as string);
  expect(f.submissions[0]!.prompt).not.toContain(requests[laterIndex]!.context.messages[0]!.content as string);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page creation failure can be abandoned by leaving continuity`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  const legacy = structuredClone(first);
  legacy._conversationPolicy = "recoverable";
  await f.adapter().preflight!(legacy, { headers: new Headers() });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_session_lost" });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} pre-page creation failure can be abandoned by native interrupt`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.preLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(0);
  expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-other")).toBe(false);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-first")).toBe(true);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  const legacy = structuredClone(first);
  legacy._conversationPolicy = "recoverable";
  await f.adapter().preflight!(legacy, { headers: new Headers() });
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_session_lost" });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} lost initial start acknowledgement reconciles the exact provisional page`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.loseStartAcknowledgementOnce = true;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

test("a missing physical page permanently rejects the registered thread instead of creating a replacement", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  f.pages.clear();
  await expect(f.run(f.next(first))).rejects.toMatchObject({ code: "continuity_session_lost", retryable: false });
  await expect(f.run(f.next(first))).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(1);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("lost");
});

test("disconnect during initial capacity preflight does not consume registration or start a page", async () => {
  const f = fixture();
  const first = f.request();
  const controller = new AbortController();
  f.controls.onCapacityQuery = () => controller.abort();
  await expect(f.adapter().preflight!(first, { headers: new Headers(), abortSignal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  expect(f.submissions).toHaveLength(0);
  f.controls.onCapacityQuery = undefined;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
});

test("an uninitialized store, old launcher, and conflicting configuration fail before creating a page", async () => {
  const f = fixture();
  f.provider.chatgptWeb!.experimentalBiggerContext = true;
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  delete f.provider.chatgptWeb!.experimentalBiggerContext;
  writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor, features: [] }));
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  rmSync(f.statePath, { recursive: true, force: true });
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(f.submissions).toHaveLength(0);
});

test("summary-only, compaction, and tool-result continuations cannot claim the initial creation right", async () => {
  const f = fixture();
  const summary = { type: "compaction", encrypted_content: encodeCompactionSummary("Inherited checkpoint") };
  const onlySummary = f.request("", "turn-first", [summary]);
  await expect(f.run(onlySummary)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const compact = f.request(); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const tool = f.request("", "turn-first", [
    ...(f.request()._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: "unowned-call", output: "finished" },
  ]);
  await expect(f.run(tool)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.registrations.get(continuityDigest(f.threadId))).toBeUndefined();
  const valid = f.request("", "turn-first", [summary, ...(f.request()._rawBody as { input: unknown[] }).input]);
  await f.run(valid);
  expect(f.submissions).toHaveLength(1);
});

test("changed completed assistant history does not block a clear new native instruction", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const changed = f.next(first, "turn-next", "Invented final answer");
  expect((await f.run(changed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Invented final answer");
});

test("an invented checkpoint cannot advance revision even when a clear current instruction follows", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const changed = f.next(first);
  (changed._rawBody as { input: unknown[] }).input.unshift({ type: "compaction", encrypted_content: encodeCompactionSummary("Invented checkpoint") });
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

test("ordinary resume ignores completed foreign history before a clear new instruction", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const repeated = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Foreign tool result." },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next", content: "Next continuity instruction.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  expect((await f.run(repeated)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Foreign execution record.");
  expect(f.submissions[1]!.prompt).not.toContain("Foreign tool result.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary resume keeps every new current-turn instruction item`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next-constraint", content: "Constraint: keep both new items.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    { type: "message", role: "user", id: "msg-turn-next", content: "Execute the next task.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Constraint: keep both new items.");
  expect(f.submissions[1]!.prompt).toContain("Execute the next task.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} cross-turn resume excludes an old item-ID-only instruction before explicit current work`, async () => {
  const f = fixture(manual);
  const first = f.request("Historical instruction A.", "turn-a");
  await f.run(first);
  const history = structuredClone((first._rawBody as { input: unknown[] }).input);
  delete (history[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const next = f.request("", "turn-b", [
    ...history,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-b", content: "Current instruction B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-b" } },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.prompt).toContain("Current instruction B.");
  expect(f.submissions[1]!.prompt).not.toContain("Historical instruction A.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} replay binds every instruction item in the accepted current work set`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.request("", "turn-next", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-next-constraint", content: "Constraint A.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
    { type: "message", role: "user", id: "msg-turn-next", content: "Stable task B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await f.run(next);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const acceptedInput = source.canonicalInput();
  const changed = structuredClone(next);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.id === "msg-turn-next-constraint")!.content = "Changed constraint A'.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
  expect(source.canonicalInput()).toEqual(acceptedInput);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same native instruction identity cannot replace its accepted current payload`, async () => {
  const f = fixture(manual);
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const changed = f.request("Changed current instruction.", "turn-first");
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} settled replay cannot replace the owned canonical input`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const foreignReplay = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unowned execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  await expect(f.run(foreignReplay)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  const next = f.next(first);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} detached final locks canonical input before the first reconnect`, async () => {
  const f = fixture(manual);
  f.controls.deferCompletion = true;
  const parsed = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const namespace = chatGptWebExecutionNamespace(f.provider);
  const source = chatGptTurnSessions.find(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)!;
  if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  else f.controls.releaseDeferredCompletion!();
  expect(await source.browserOutcome).toEqual({ type: "final", answer: "Completed response 1." });
  await source.physicalSettlement;
  const foreignReplay = f.request("", "turn-first", [
    ...(parsed._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
    { type: "function_call_output", call_id: "foreign-call", output: "Unowned tool result." },
  ]);
  const foreignCompact = structuredClone(foreignReplay);
  foreignCompact._compactionRequest = true;
  await expect(f.run(foreignCompact)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  await expect(f.run(foreignReplay)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect((await f.run(parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} completed historical assistant changes replay the accepted result round`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Actual completed tool result: 42." },
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const canonical = [...(next._rawBody as { input: unknown[] }).input];
  expect(source.canonicalInput()).toEqual(canonical);
  const foreignReplay = f.request("", "turn-first", [
    ...canonical,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Foreign execution record." }] },
  ]);
  expect((await f.run(foreignReplay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} accepted local tool result payload cannot be replaced by a retry`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const accepted = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "Accepted result A." },
  ]);
  expect((await f.run(accepted)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
  const changed = structuredClone(accepted);
  const changedInput = (changed._rawBody as { input: Array<Record<string, unknown>> }).input;
  changedInput.find(item => item.type === "function_call_output")!.output = "Conflicting result B.";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.controls.toolResults).toHaveLength(1);
  expect(f.submissions).toHaveLength(1);
});

for (const mutation of ["tools", "status"] as const) test(`Automatic accepted tool_search_output ${mutation} cannot change before its result round completes`, async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = "tool_search";
  const initialRaw = structuredClone(f.request()._rawBody) as Record<string, unknown> & {
    input: unknown[];
    tools: Array<Record<string, unknown>>;
  };
  const functionSpec = initialRaw.tools[0]!;
  initialRaw.tools = [{
    type: "tool_search",
    description: "Fixture search, no external service is called",
    parameters: functionSpec.parameters,
  }];
  const first = parseRequest(initialRaw);
  first._conversationPolicy = "continuity-first";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;

  const acceptedRaw = structuredClone(initialRaw);
  acceptedRaw.input = [
    ...initialRaw.input,
    { type: "tool_search_call", call_id: call.callId, arguments: { query: "fixture" } },
    { type: "tool_search_output", call_id: call.callId, tools: [], status: "completed" },
  ];
  const accepted = parseRequest(acceptedRaw);
  accepted._conversationPolicy = "continuity-first";
  f.controls.pauseAfterToolResults = true;
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(accepted, { headers: new Headers() });
  const interrupted = adapter.runTurn!(accepted, { headers: new Headers(), abortSignal: abort.signal }, () => {})
    .catch(error => error);
  while (!f.controls.releaseAfterToolResults) await Bun.sleep(1);
  expect(f.controls.toolResults).toHaveLength(1);
  expect(source.roundCompleted(source.continuityRoundKey(accepted))).toBeFalse();
  abort.abort();
  expect(await interrupted).toMatchObject({ name: "AbortError" });

  const changedRaw = structuredClone(acceptedRaw);
  const changedResult = changedRaw.input.find(item => (
    item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).type === "tool_search_output"
  )) as Record<string, unknown>;
  if (mutation === "tools") {
    changedResult.tools = [{ type: "function", name: "loaded_tool", description: "Loaded fixture tool", parameters: { type: "object" } }];
  } else {
    changedResult.status = "failed";
  }
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "continuity-first";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });

  f.controls.pauseAfterToolResults = false;
  f.controls.releaseAfterToolResults!();
  expect((await f.run(accepted)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
});

test("Automatic local parallel result batch accepts reordered results once", async () => {
  const f = fixture();
  f.controls.invokeSourceTools = true;
  f.controls.parallelSourceTools = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const calls = source.outstanding();
  expect(calls).toHaveLength(2);
  const results = calls.map((call, index) => ({
    type: "function_call_output", call_id: call.callId, output: `Parallel result ${index + 1}.`,
  })).reverse();
  const next = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    ...results,
  ]);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
  expect(source.outstanding()).toHaveLength(0);
  expect((await f.run(structuredClone(next))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const invalid of ["incomplete", "duplicate", "wrong-type", "unknown"] as const) {
  test(`Automatic local parallel result batch rejects ${invalid} current results before delivery`, async () => {
    const f = fixture();
    f.controls.invokeSourceTools = true;
    f.controls.parallelSourceTools = true;
    const first = f.request();
    expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: false });
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const calls = source.outstanding();
    expect(calls).toHaveLength(2);
    const valid = calls.map((call, index) => ({
      type: "function_call_output", call_id: call.callId, output: `Parallel result ${index + 1}.`,
    }));
    const results: unknown[] = invalid === "incomplete" ? [valid[0]]
      : invalid === "duplicate" ? [valid[0], structuredClone(valid[0])]
      : invalid === "wrong-type" ? [{ ...valid[0], type: "custom_tool_call_output" }, valid[1]]
      : [...valid, { type: "function_call_output", call_id: "unknown-current-call", output: "Foreign result." }];
    const next = f.request("", "turn-first", [
      ...(first._rawBody as { input: unknown[] }).input,
      ...results,
    ]);
    await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.controls.toolResults).toHaveLength(0);
    expect(source.outstanding()).toHaveLength(2);
    expect(f.submissions).toHaveLength(1);
  });
}

test("a lost manual end acknowledgement preserves the accepted answer but ends continuity", async () => {
  const f = fixture(true);
  f.controls.endFailure = true;
  const first = f.request();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("lost");
  await expect(f.run(f.next(first))).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(1);
});

test("a manual HTTP observer disconnect does not cancel the retained execution", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const parsed = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const namespace = chatGptWebExecutionNamespace(f.provider);
  expect(chatGptTurnSessions.find(`${namespace}:${chatGptTurnExecutionKey(parsed)}`)?.isActive()).toBe(true);
  f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  expect((await f.run(parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  const document = JSON.parse(readFileSync(join(f.statePath, "threads.json"), "utf8"));
  const stored = document.entries[continuityDigest(f.threadId)];
  expect(continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)?.state).toBe("ready");
});

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
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(2);
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} leaving continuity ends only the settled binding and prevents reentry`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const legacy = f.next(first); legacy._conversationPolicy = "recoverable";
  await Promise.all([
    f.adapter().preflight!(legacy, { headers: new Headers() }),
    f.adapter().preflight!(structuredClone(legacy), { headers: new Headers() }),
  ]);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  expect(f.submissions).toHaveLength(1);
  expect(source.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_session_lost" });
});

test("leaving after compaction releases the committed lease rather than the retired source lease", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const committed = [...binding.checkpoints.values()][0]!;
  const legacy = f.next(first); legacy._conversationPolicy = "recoverable";
  await f.adapter().preflight!(legacy, { headers: new Headers() });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  expect([...binding.checkpoints.values()]).toEqual([committed]);
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(2);
});

test("mode exit refuses an active manual owner without cancelling its authorized work", async () => {
  const f = fixture(true);
  f.controls.deferCompletion = true;
  const first = f.request();
  const adapter = f.adapter();
  await adapter.preflight!(first, { headers: new Headers() });
  const running = adapter.runTurn!(first, { headers: new Headers() }, () => {});
  void running.catch(() => {});
  while (!f.controls.started) await Bun.sleep(1);
  const legacy = f.next(first); legacy._conversationPolicy = "recoverable";
  try {
    await expect(f.adapter().preflight!(legacy, { headers: new Headers() }))
      .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
    expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
    expect(f.pages.size).toBe(1);
  } finally {
    f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
    await running;
  }
  await f.adapter().preflight!(legacy, { headers: new Headers() });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
});

test("Zero Risk completed compaction stops without a second prompt and preserves its ordinary answer", async () => {
  const f = fixture(true);
  const first = f.request();
  await f.run(first);
  const compact = structuredClone(first); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_manual_handoff_required", retryable: false });
  expect(f.submissions).toHaveLength(1);
  expect(f.pages.size).toBe(1);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
});

test("a rejected structured handoff never commits or falls back to another conversation", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  f.controls.handoffSummary = 'Invalid checkpoint.\nCODEX_LATEST_USER_PROMPT_JSON\n"A different instruction"';
  const compact = structuredClone(first); compact._compactionRequest = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(2);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("lost");
});

test("an accepted handoff survives failed physical settlement as evidence, not as replacement history", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const source = chatGptTurnSessions.find(binding.executionKey!)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  f.controls.failHandoffSettlement = true;
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost", retryable: false });
  expect(binding.acceptedHandoff?.summary).toBe(`${f.controls.handoffSummary}\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."`);
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(source.settledOutcome()).toEqual({ type: "final", answer: "Completed response 1." });
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost" });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(0);
});

test("a committed result is retained when the physical page disappears before a compact reconnect", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const compact = structuredClone(first); compact._compactionRequest = true;
  await f.run(compact);
  const committed = [...binding.checkpoints.values()][0]!;
  f.pages.clear();
  await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_session_lost", retryable: false });
  expect([...binding.checkpoints.values()]).toEqual([committed]);
  expect(committed.summary).toBe(`${f.controls.handoffSummary}\n\nCODEX_LATEST_USER_PROMPT_JSON\n"First continuity instruction."`);
  expect(binding.revision).toBe(1);
  expect(f.submissions).toHaveLength(2);
});

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
  expect(f.submissions[2]!.prompt).not.toContain("Foreign tool result.");
});

for (const manual of [false, true]) for (const reclamation of ["capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation}-reclaimed old ordinary replay stays bound to its stale repeated-summary revision`, async () => {
  const f = fixture(manual);
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
  const firstSummary = firstCompactEvents.find(event => event.type === "text_delta");
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
  const secondSummary = secondCompactEvents.find(event => event.type === "text_delta");
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active compaction preserves delivered tool results and resumes with fresh authority on the same page`, async () => {
  const f = fixture(manual);
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
  const f = fixture(manual);
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
  const f = fixture(manual);
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
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });

  const newerCanonical = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    structuredClone(toolCall),
    { type: "function_call_output", call_id: call.callId, output: "Canonical tool result B." },
  ]);
  expect((await f.run(newerCanonical)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(source.canonicalInput()).toEqual((newerCanonical._rawBody as { input: unknown[] }).input);

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  const submissions = f.submissions.length;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
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
  await compactAdapter.preflight!(staleCompact, { headers: new Headers() });

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
  expect(source.canonicalInput()).toEqual((newerCanonical._rawBody as { input: unknown[] }).input);
  expect(source.outstanding()).toHaveLength(1);
  expect(source.outstanding()[0]?.callId).not.toBe(firstCall.callId);

  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  expect(binding.state).toBe("running");
  const submissions = f.submissions.length;
  await expect(compactAdapter.runTurn!(staleCompact, { headers: new Headers() }, () => {}))
    .rejects.toMatchObject({ code: "continuity_source_unproven", retryable: false });
  expect(binding.state).toBe("running");
  expect(binding.revision).toBe(0);
  expect(binding.checkpoints.size).toBe(0);
  expect(binding.acceptedHandoff).toBeUndefined();
  expect(source.outstanding()).toHaveLength(1);
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
  const handoff = f.run(compact).catch(error => error);
  const stored = f.registrations.get(continuityDigest(f.threadId))!;
  const binding = continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), stored.scope)!;
  // Compaction validation is serialized behind the active ordinary owner. It must not claim
  // the compaction state until the source lock can prove which local work actually won.
  expect(binding.state).toBe("running");
  f.broker.completeSafeTurn(f.controls.safeToken, "Ordinary final wins.");
  expect((await ordinary).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await handoff).toMatchObject({ code: "continuity_manual_handoff_required" });
  expect(binding.revision).toBe(0);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(first)).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Ordinary final wins.", phase: "final_answer" });
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} new native turn rejects an old instruction without a committed transition`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const stale = f.request("", "turn-without-new-instruction", structuredClone((first._rawBody as { input: unknown[] }).input));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} new native turn rejects an already-consumed item-ID-only instruction`, async () => {
  const f = fixture(manual);
  const input = structuredClone((f.request()._rawBody as { input: unknown[] }).input);
  delete (input[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const first = f.request("", "turn-first", input);
  await f.run(first);
  const stale = f.request("", "turn-without-new-instruction", structuredClone(input));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} old item-ID-only instruction cannot revive after a newer ordinary execution`, async () => {
  const f = fixture(manual);
  const inputA = structuredClone((f.request("Instruction A.", "turn-a")._rawBody as { input: unknown[] }).input);
  delete (inputA[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const a = f.request("", "turn-a", inputA);
  await f.run(a);

  const b = f.next(a, "turn-b");
  const inputB = (b._rawBody as { input: unknown[] }).input;
  delete (inputB.at(-1) as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  await f.run(b);
  expect(f.submissions).toHaveLength(2);

  const namespace = chatGptWebExecutionNamespace(f.provider);
  const aKey = `${namespace}:${chatGptTurnExecutionKey(a)}`;
  if (reclamation === "capacity") {
    const capacity = chatGptTurnSessions as unknown as { maxEntries: number };
    const originalMaxEntries = capacity.maxEntries;
    capacity.maxEntries = 2;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "capacity-consumed-instruction-probe");
    } finally {
      capacity.maxEntries = originalMaxEntries;
    }
  } else if (reclamation === "ttl") {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    try { chatGptTurnSessions.activeCount(); }
    finally { clock.mockRestore(); }
  }
  if (reclamation === "retained") expect(chatGptTurnSessions.find(aKey)).toBeDefined();
  else expect(chatGptTurnSessions.find(aKey)).toBeUndefined();

  const stale = f.request("", "turn-c", structuredClone(inputA));
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const masked = f.next(b, "turn-c");
  const maskedInput = (masked._rawBody as { input: Array<Record<string, unknown>> }).input;
  maskedInput.at(-1)!.id = "msg-turn-a";
  maskedInput.at(-1)!.content = "Changed work under a consumed instruction ID.";
  maskedInput.push({ type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" } });
  await expect(f.run(masked)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
  const valid = f.next(b, "turn-d");
  ((valid._rawBody as { input: unknown[] }).input).push(maskedInput.at(-1));
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed foreign work.");
});

for (const manual of [false, true]) for (const reclamation of ["retained", "tombstone"] as const) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint resume rejects a ${reclamation} consumed item-ID-only instruction`, async () => {
  const f = fixture(manual);
  const inputA = structuredClone((f.request("Instruction A.", "turn-a")._rawBody as { input: unknown[] }).input);
  delete (inputA[0] as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  const a = f.request("", "turn-a", inputA);
  await f.run(a);

  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const b = f.next(a, "turn-b");
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-b", [
    ...(b._rawBody as { input: unknown[] }).input,
    { type: "function_call", name: call.wireName, call_id: call.callId, arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
    { type: "function_call_output", call_id: call.callId, output: "The completed original result." },
  ]);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing accepted checkpoint");
  f.controls.invokeSourceTools = false;

  const aKey = `${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(a)}`;
  if (reclamation === "tombstone") {
    const registry = chatGptTurnSessions as unknown as { maxEntries: number; entries: Map<string, unknown> };
    const originalMaxEntries = registry.maxEntries;
    registry.maxEntries = registry.entries.size;
    try {
      chatGptTurnSessions.assertContinuityThreadAvailable(f.threadId, "checkpoint-consumed-instruction-probe");
    } finally {
      registry.maxEntries = originalMaxEntries;
    }
    expect(chatGptTurnSessions.find(aKey)).toBeUndefined();
    const binding = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
    expect(binding.ordinaryReplayTombstones.get(aKey)).toMatchObject({
      instructionIdentity: "msg-turn-a", nativeTurnId: "turn-a",
    });
  } else expect(chatGptTurnSessions.find(aKey)).toBeDefined();

  const submissions = f.submissions.length;
  const stale = f.request("", "turn-c", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...structuredClone(inputA),
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  ((stale._rawBody as { input: unknown[] }).input).push({
    type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" },
  });
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  const valid = f.request("", "turn-d", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-turn-d", content: "Valid new checkpoint work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-d" } },
    { type: "message", role: "user", id: "foreign-tail", content: "Completed foreign work.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-foreign" } },
  ]);
  expect((await f.run(valid)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
  expect(f.submissions.at(-1)!.prompt).not.toContain("Completed foreign work.");
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ordinary replay rejects changed top-level instructions`, async () => {
  const f = fixture(manual);
  const request = (instructions: string) => {
    const raw = structuredClone(f.request()._rawBody) as Record<string, unknown>;
    raw.instructions = instructions;
    const parsed = parseRequest(raw);
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const first = request("Instruction A.");
  await f.run(first);
  await expect(f.run(request("Instruction B."))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(request("Instruction A."))).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Completed response 1.", phase: "final_answer" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} unowned terminal results are rejected before a new ordinary submission`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  const next = f.next(first);
  const input = structuredClone((next._rawBody as { input: unknown[] }).input);
  input.push({ type: "function_call_output", call_id: "unissued-current-call", output: "unowned result" });
  const invalid = f.request("", "turn-next", input);
  await expect(f.run(invalid)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} active delegated source content conflict retires the source owner`, async () => {
  const f = fixture(manual);
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
  expect(binding.state).toBe("lost");
  await expect(callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
    method: "claim", token, ...(manual ? { contract: "safe" } : {}),
  })).rejects.toThrow();
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} committed compaction replay rejects changed accepted tool-result payload`, async () => {
  const f = fixture(manual);
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
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same native turn old instruction cannot revive after steering and checkpoint`, async () => {
  const f = fixture(manual);
  const a = f.request("Instruction A.", "turn-first");
  await f.run(a);
  if (manual) {
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
  }
  const b = f.request("", "turn-first", [
    ...(a._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", id: "msg-turn-b", content: "Instruction B.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } },
  ]);
  expect((await f.run(b)).at(-1)).toMatchObject({ type: "done", endTurn: !manual });
  const compact = manual ? (() => {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(b)}`)!;
    const call = source.outstanding()[0]!;
    return f.request("", "turn-first", [
      ...(b._rawBody as { input: unknown[] }).input,
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Completed B result." },
    ]);
  })() : structuredClone(b);
  compact._compactionRequest = true;
  const compactEvents = await f.run(compact);
  const summary = compactEvents.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  const submissions = f.submissions.length;
  const stale = f.request("", "turn-first", [
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    ...(a._rawBody as { input: unknown[] }).input,
  ]);
  await expect(f.run(stale)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
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
  compact._conversationPolicy = "continuity-first";
  expect((await f.run(compact)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const changedRaw = structuredClone(compactRaw);
  (changedRaw.input.at(-1) as { content: string }).content += "\nChanged control payload.";
  const changed = parseRequest(changedRaw);
  changed._conversationPolicy = "continuity-first";
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} repeated-summary checkpoint-only transition follows the second active source`, async () => {
  const f = fixture(manual);
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint resume excludes old item-ID-only instructions and binds only new work`, async () => {
  const f = fixture(manual);
  const old = { type: "message", role: "user", id: "historical-a", content: "Historical instruction A." };
  const current = { type: "message", role: "user", id: "current-b", content: "Source instruction B.",
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
      { type: "function_call", name: call.wireName, call_id: call.callId,
        arguments: '{"cmd":"fixture-command-not-executed-by-this-test"}' },
      { type: "function_call_output", call_id: call.callId, output: "Accepted result." },
    ]);
  }
  compact._compactionRequest = true;
  const events = await f.run(compact);
  const summary = events.find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing checkpoint summary");
  f.controls.invokeSourceTools = false;
  const next = f.request("", "turn-next", [old, current,
    { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "current-c", content: "New instruction C.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } },
  ]);
  await f.run(next);
  expect(f.submissions.at(-1)!.prompt).toContain("New instruction C.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Historical instruction A.");
  expect(f.submissions.at(-1)!.prompt).not.toContain("Source instruction B.");
  const replayRaw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  replayRaw.input[0]!.content = "Changed old instruction.";
  const replay = parseRequest(replayRaw);
  replay._conversationPolicy = "continuity-first";
  const submissions = f.submissions.length;
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) for (const reclamation of ["retained", "capacity", "ttl"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${reclamation} cached compaction binds all source instructions after steering`, async () => {
  const f = fixture(manual);
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
  changed._conversationPolicy = "continuity-first";
  changed._compactionRequest = true;
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const historicalRaw = structuredClone(compact._rawBody) as { input: Array<Record<string, unknown>> };
  historicalRaw.input[0]!.content = "Changed earlier steering history.";
  const historicalReplay = parseRequest(historicalRaw);
  historicalReplay._conversationPolicy = "continuity-first";
  historicalReplay._compactionRequest = true;
  expect((await f.run(historicalReplay)).find(event => event.type === "text_delta")).toEqual(summary);
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(results);
  expect(source.canonicalInput()).toEqual(snapshot);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} concurrent compaction rejects changed results before initial acceptance`, async () => {
  const f = fixture(manual);
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

for (const manual of [false, true]) test(`HTTP ${manual ? "Zero Risk" : "Automatic"} missing instruction predecessor returns a continuity conflict`, async () => {
  const f = httpFixture(manual);
  expect((await f.send(f.body)).status).toBe(200);
  const response = await f.send({
    ...f.body,
    input: [{ type: "message", role: "user", id: "next-only", content: "New instruction with missing predecessor.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next" }) },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "continuity_source_unproven" } });
  expect(f.submissions).toHaveLength(1);
  expect((await f.send(f.body)).status).toBe(200);
});

for (const manual of [false, true]) for (const sameTurn of [false, true]) for (const retainPredecessor of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} moved checkpoint rejects ambiguous ${sameTurn ? "same-turn" : "ID-only"} history with predecessor ${retainPredecessor ? "before checkpoint" : "absent"}`, async () => {
  const f = fixture(manual);
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
  const f = fixture(manual);
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
    const result=await f.run(retry).then(events=>({accepted:true,events}),error=>({accepted:false,code:error.code,message:error.message}));
    expect(restoredAliases).toBe(1);
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
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
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
  const f=fixture(true);
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
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-checkpoint", [
    ...(first._rawBody as { input: unknown[] }).input,
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

for (const mutation of ["namespace", "identity", "foreign-turn", "payload", "call-id"] as const) test(`Round 7: malformed native delegation cannot start ordinary work: ${mutation}`, async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const delegation: Record<string, unknown> = {
    type: "function_call_output", id: "fco-current", name: "send_message_to_thread", namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>Current task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
  };
  if (mutation === "namespace") delegation.namespace = "foreign";
  if (mutation === "identity") delete delegation.id;
  if (mutation === "foreign-turn") delegation.internal_chat_message_metadata_passthrough = { turn_id: "foreign" };
  if (mutation === "payload") delegation.output = "<codex_delegation>unproven</codex_delegation>";
  if (mutation === "call-id") delegation.call_id = "foreign-call";
  const next = f.request("", "turn-current", [
    ...(first._rawBody as { input: unknown[] }).input,
    { type: "message", role: "assistant", content: "Completed response 1." }, delegation,
  ]);
  await expect(f.run(next)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
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

for (const manual of [false, true]) test(`Round 7: approved tool discovery remains usable on ordinary work ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const discovered = { type: "function", name: "discovered_command", description: "Locally discovered fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Current fixture discovery", parameters: { type: "object" } }];
  raw.input.push({ type: "additional_tools", tools: [{ ...discovered, name: "inline_command" }] });
  const first = parseRequest(raw);
  first._conversationPolicy = "continuity-first";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const searchResult = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [discovered] };
  const resultRaw = { ...raw, input: [...raw.input, { type: "tool_search_call", call_id: call.callId, arguments: {} }, searchResult] };
  const result = parseRequest(resultRaw);
  result._conversationPolicy = "continuity-first";
  expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(result.context.tools?.map(tool => tool.name)).toContain("discovered_command");
  expect(result.context.tools?.map(tool => tool.name)).toContain("inline_command");
  // The locally accepted definition remains authoritative even if its historical copy changes.
  const historical = structuredClone(searchResult);
  historical.tools[0]!.parameters = { type: "object", properties: { forbidden: { type: "string" } }, required: ["forbidden"] } as unknown as typeof discovered.parameters;
  const nextRaw = { ...raw, input: [...raw.input, historical,
    { type: "message", role: "assistant", content: "Completed source." },
    { type: "message", role: "user", id: "msg-discovery-next", content: "Use the approved discovered tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-discovery-next" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-discovery-next" }) } };
  const next = parseRequest(nextRaw);
  next._conversationPolicy = "continuity-first";
  f.controls.reviewWireName = "discovered_command";
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const nextSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  expect(nextSource.outstanding()[0]?.wireName).toBe("discovered_command");
  expect(next.context.tools?.find(tool => tool.name === "discovered_command")?.parameters).toEqual(discovered.parameters);
  const nextCall = nextSource.outstanding()[0]!;
  const terminal = parseRequest({ ...nextRaw, input: [...nextRaw.input,
    { type: "function_call_output", call_id: nextCall.callId, output: "Approved discovered result." }] });
  terminal._conversationPolicy = "continuity-first";
  await f.run(terminal);
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const manual of [false, true]) test(`Round 7: approved discovery survives checkpoint and current registry removal ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const spec = { type: "function", name: "discovered_checkpoint_tool", description: "Approved fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const first = parseRequest(raw);
  first._conversationPolicy = "continuity-first";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const search = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [spec] };
  const compact = parseRequest({ ...raw, input: [...raw.input, search],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-search-compact" }) } });
  compact._conversationPolicy = "continuity-first";
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  const nextRaw = { ...raw, input: [search, { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) },
    { type: "message", role: "user", id: "msg-after-search-checkpoint", content: "Use the approved checkpoint tool.",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-after-search-checkpoint" } }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: "turn-after-search-checkpoint" }) } };
  const next = parseRequest(nextRaw);
  next._conversationPolicy = "continuity-first";
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
  removed._conversationPolicy = "continuity-first";
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
  later._conversationPolicy = "continuity-first";
  await f.run(later);
  expect(later.context.tools).toEqual([]);
});

for (const manual of [false, true]) test(`Round 8: historical result collision outside current native instruction ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const prior = { type: "function_call_output", call_id: "completed-historical-call", output: "Completed historical result." };
  const first = f.request("", "turn-first", [prior, ...(f.request()._rawBody as { input: unknown[] }).input]);
  await f.run(first);
  const session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = session.outstanding()[0]!;
  const resultInput = [...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Current real result." }];
  const result = f.request("", "turn-first", resultInput);
  const cleanOutcome = await f.run(result);
  const submissions = f.submissions.length;
  const delivered = f.controls.toolResults.length;
  expect(cleanOutcome.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const historyChanged = structuredClone(resultInput);
  (historyChanged[0] as { call_id: string }).call_id = call.callId;
  const retry = f.request("", "turn-first", historyChanged);
  session.assertCanonicalReplayInput(retry);
  const outcome = await f.run(retry).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code, message: error.message }));
  expect(outcome).toMatchObject({ accepted: true, events: cleanOutcome });
  expect(f.submissions).toHaveLength(submissions);
  expect(f.controls.toolResults).toHaveLength(delivered);
});

for (const manual of [false, true]) for (const content of ["New task B.", "Source A."]) test(`Round 8: accepted same-turn source echo cannot mask new instruction ${manual} ${content}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request("Source A.", "turn-first");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(e => e.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const newTask = { type: "message", role: "user", id: "msg-new-same-turn", content, internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const prefix = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, ...(first._rawBody as { input: unknown[] }).input, newTask];
  const tail = [...prefix, ...(first._rawBody as { input: unknown[] }).input];
  const request = f.request("", "turn-first", tail);
  const count = f.submissions.length;
  const result = await f.run(request).then(events => ({ accepted: true, events }), error => ({ accepted: false, code: error.code, message: error.message }));
  const control = f.request("", "turn-first", prefix);
  const controlResult = await f.run(control);
  expect(controlResult.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(count + 1);
  expect(result).toMatchObject({ accepted: true, events: controlResult });
  expect(chatGptCurrentInstructionRevision(request)?.itemId).toBe("msg-new-same-turn");
  expect(f.submissions.at(-1)?.prompt).toContain(content);
});

for (const manual of [false, true]) test(`Round 8: older accepted discovery cannot restore removed tools during compaction ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.repeatManualSourceTool = manual;
  f.controls.invokeSourceTools = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as Record<string, unknown> & { input: unknown[]; tools: unknown[] };
  raw.tools = [{ type: "tool_search", description: "Fixture search", parameters: { type: "object" } }];
  const parse = (body: unknown) => {
    const parsed = parseRequest(body);
    parsed._conversationPolicy = "continuity-first";
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
  expect((await f.run(parse({ ...raw, tools: [], input: [...raw.input,
    { type: "tool_search_output", call_id: secondCall.callId, status: "completed", tools: [] }],
  }))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const binding = source.runtime.continuityBinding!;
  expect(binding.discoveredTools).toEqual([]);
  const compact = parse({ ...raw, tools: [], input: [...raw.input, search] });
  compact._compactionRequest = true;
  let marker: unknown;
  if (manual) {
    await expect(f.run(compact)).rejects.toMatchObject({ code: "continuity_manual_handoff_required" });
  } else {
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing summary");
    marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  }
  expect(binding.discoveredTools).toEqual([]);
  const prefix = manual ? [...raw.input, search, { type: "message", role: "assistant", content: "Completed source." }]
    : [search, marker];
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
  const token = manual ? f.controls.safeToken : f.submissions.at(-1)!.prompt.match(/turn_token (turn_[A-Za-z0-9_-]{32})/)![1]!;
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
  const codexHome = mkdtempSync("/tmp/cgw-cont-alias-home-");
  cleanups.push(async () => { rmSync(codexHome, { recursive: true, force: true }); });
  const f = fixture(manual, { codexHome, threadId: "019cbcc7-31b2-7028-a632-7f8118410711" });
  const turnId = "019cbcc7-31b2-7028-a632-7f8118410712";
  mkdirSync(join(codexHome, "sessions", "2026", "09", "30"), { recursive: true });
  const rolloutPath = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T09-00-00-${f.threadId}.jsonl`);
  const append = (items: unknown[]) => writeFileSync(rolloutPath,
    readFileSync(rolloutPath, "utf8") + items.map(item => JSON.stringify(item)).join("\n") + "\n");
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: f.threadId, source: "vscode" } },
    { type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp", workspace_roots: ["/tmp"], approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n");
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  const request = (input: unknown[]): CodexParsedRequest => {
    const parsed = parseRequest({ ...f.request("", turnId, input)._rawBody as object,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: f.threadId, turn_id: turnId,
        agent_name: "/root", sandbox_mode: "danger-full-access", workspaces: { "/tmp": {} } }) },
    });
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const sourceItem = { type: "message", role: "user", id: "msg-canonical-source", content: "Source instruction.",
    internal_chat_message_metadata_passthrough: { turn_id: turnId } };
  const nativeSource = aliasedSource ? { ...sourceItem, id: "msg-initial-alias" } : sourceItem;
  if (aliasedSource) append([{ type: "response_item", payload: sourceItem },
    { type: "compacted", payload: { replacement_history: [nativeSource] } }]);
  const first = request([nativeSource]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  if (aliasedSource) expect(first._chatGptMessageIdAliases).toEqual({ "msg-initial-alias": sourceItem.id });
  const compact = request([nativeSource, { type: "function_call_output", call_id: call.callId, output: "Accepted source result." }]);
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

for (const manual of [false, true]) for (const checkpoint of [false, true]) for (const grouped of [false, true]) test(`Round 9: current ${grouped ? "grouped preamble" : "prefix constraints"} survives ${checkpoint ? "checkpoint" : "ordinary"} boundary ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = checkpoint;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  let base = (f.next(first)._rawBody as { input: unknown[] }).input;
  if (checkpoint) {
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
    compact._compactionRequest = true;
    const summary = (await f.run(compact)).find(event => event.type === "text_delta");
    if (summary?.type !== "text_delta") throw new Error("Missing summary");
    base = [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) }, base.at(-1)];
    f.controls.invokeSourceTools = false;
  }
  const owner = { turn_id: "turn-next" };
  const prefix = grouped ? [{ type: "message", role: "user", id: "current-native-preamble", content: [
    { type: "input_text", text: "<recommended_plugins>Current example plugin</recommended_plugins>" },
    { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>CURRENT_GROUP_CONSTRAINT.</INSTRUCTIONS>" },
    { type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>\n<shell>zsh</shell>\n</environment_context>" },
  ], internal_chat_message_metadata_passthrough: owner }] : (["system", "developer"] as const).map(role => ({
    type: "message", role, id: `current-prefix-${role}`, content: `CURRENT_PREFIX_${role.toUpperCase()}.`,
    internal_chat_message_metadata_passthrough: owner,
  }));
  const input = grouped ? [...base.slice(0, -1), ...prefix, base.at(-1)] : [...prefix, ...base];
  const next = f.request("", "turn-next", input);
  const accepted = await f.run(next);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  if (grouped) {
    expect(prompt).toContain("CURRENT_GROUP_CONSTRAINT.");
    expect(prompt).toContain("<recommended_plugins>");
    expect(prompt.match(/CURRENT_GROUP_CONSTRAINT\./g)).toHaveLength(1);
  } else {
    expect(prompt).toContain("CURRENT_PREFIX_SYSTEM.");
    expect(prompt).toContain("CURRENT_PREFIX_DEVELOPER.");
  }
  const submissions = f.submissions.length;
  expect(await f.run(structuredClone(next))).toEqual(accepted);
  for (const id of grouped ? ["current-native-preamble"] : ["current-prefix-system", "current-prefix-developer"]) {
    const changed = structuredClone(input) as Array<Record<string, unknown>>;
    const item = changed.find(item => item.id === id)!;
    if (grouped) (item.content as Array<{ text: string }>)[1]!.text = "# AGENTS.md instructions\n<INSTRUCTIONS>Changed current constraint.</INSTRUCTIONS>";
    else item.content = "Changed current constraint.";
    await expect(f.run(f.request("", "turn-next", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  }
  expect(f.submissions).toHaveLength(submissions);
});

for (const manual of [false, true]) test(`Round 9: first checkpoint transition accepts structured source key order ${manual}`, async () => {
  const f = fixture(manual);
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
    { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
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

for (const manual of [false, true]) for (const parentFirst of [false, true]) for (const change of ["role", "content", "turn"] as const) test(`Round 9: first checkpoint transition rejects changed source ${change} ${manual} parent ${parentFirst}`, async () => {
  const f = fixture(manual);
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
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const first = parse([firstItem]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([firstItem, { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
  compact._compactionRequest = true;
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing summary");
  f.controls.invokeSourceTools = false;
  const marker = { type: "compaction", encrypted_content: encodeCompactionSummary(summary.text) };
  const changed = change === "role" ? parentFirst ? human : parent : change === "content"
    ? { ...firstItem, content: "Changed source content." }
    : { ...firstItem, internal_chat_message_metadata_passthrough: { turn_id: "changed-source-turn" } };
  const submissions = f.submissions.length;
  await expect(f.run(parse([changed, marker]))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(submissions);
  expect((await f.run(parse([firstItem, marker]))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions + 1);
});

for (const manual of [false, true]) for (const field of ["author", "recipient"] as const) test(`Round 9: first checkpoint transition rejects changed parent ${field} ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const raw = structuredClone(f.request("Parent source content.")._rawBody) as { client_metadata: Record<string, string> };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-first",
    request_kind: "turn", subagent_kind: "thread_spawn", parent_thread_id: "parent-thread", agent_name: "/root/child" });
  const parent = { type: "agent_message", id: "parent-source", author: "/root", recipient: "/root/child",
    content: "Parent source content.", internal_chat_message_metadata_passthrough: { turn_id: "turn-first" } };
  const parse = (input: unknown[]) => {
    const parsed = parseRequest({ ...raw, input });
    parsed._conversationPolicy = "continuity-first";
    return parsed;
  };
  const first = parse([parent]);
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = parse([parent, { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
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

for (const manual of [false, true]) test(`Round 9: foreign call echoes cannot hide malformed current results ${manual}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const result = { type: "function_call_output", call_id: call.callId, output: "Current source result." };
  const prefix = (first._rawBody as { input: unknown[] }).input;
  for (const type of ["function_call", "custom_tool_call", "tool_search_call"]) for (const invalid of [result,
    { ...result, call_id: "unowned-current-result" }, { ...result, type: "custom_tool_call_output" }]) {
    const request = f.request("", "turn-first", [...prefix, invalid,
      { type, call_id: "unowned-call-echo", name: "decorative-name", arguments: "{}" }, result]);
    await expect(f.run(request)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.controls.toolResults).toHaveLength(0);
    expect(source.outstanding()[0]!.callId).toBe(call.callId);
  }
  const accepted = await f.run(f.request("", "turn-first", [...prefix, result]));
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.controls.toolResults).toHaveLength(1);
});

for (const manual of [false, true]) for (const retainSource of [false, true]) test(`Round 9: checkpoint-only grouped instructions preserve source payload ${manual} retained ${retainSource}`, async () => {
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request("Original source work.");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const sourceInput = (first._rawBody as { input: unknown[] }).input;
  const compact = f.request("", "turn-first", [...sourceInput,
    { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
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
  const f = fixture(manual);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const prefix = (first._rawBody as { input: unknown[] }).input;
  const result = { type: "function_call_output", call_id: call.callId, output: "Accepted source result." };
  const compact = f.request("", "turn-first", [...prefix, result]);
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
  const f = fixture(manual);
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
    { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
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

for (const manual of [false, true]) test(`Round 10: cached compact codecs do not retain rewritten historical source evidence ${manual}`, async () => {
  const f = httpFixture(manual);
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
  const result = call ? [{ type: "function_call_output", call_id: call.call_id, output: "Accepted parent source result." }] : [];
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
});
