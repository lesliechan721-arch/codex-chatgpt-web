import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { CONTINUITY_FEATURE, type ContinuityClaim, type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { cancelAbandonedContinuityCreation } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultBrokerEndpoint, defaultConfig } from "../src/config";
import * as configuration from "../src/config";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { COMPACT_PROMPT, decodeCompactionSummary, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  chatGptTurnSessions.clear();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture(manual = false) {
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
    handoffSummary: "Verified checkpoint.", invokeSourceTools: false, singleSourceTool: false,
    sourceToken: "", toolResults: [] as BrokerToolResult[], modelTask: undefined as Promise<void> | undefined,
    releaseDeferredCompletion: undefined as (() => void) | undefined,
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
    controls.toolResults.push(await invoke());
    if (!manual && !controls.singleSourceTool) controls.toolResults.push(await invoke());
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
    automatic.mockRestore(); compatible.mockRestore();
    await broker.close();
    await controls.modelTask?.catch(() => {});
  });
  const threadId = `thread-${root}`;
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
  const adapter = () => createChatGptWebAdapter(provider, { broker, zeroRiskManualControl: manualControl });
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

test("a changed completed source or invented checkpoint cannot authorize a retained prompt suffix", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  await expect(f.run(f.next(first, "turn-next", "Invented final answer"))).rejects.toMatchObject({ code: "continuity_source_unproven" });
  const changed = f.next(first);
  (changed._rawBody as { input: unknown[] }).input.unshift({ type: "compaction", encrypted_content: encodeCompactionSummary("Invented checkpoint") });
  await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

test("ordinary resume rejects foreign execution hidden before a repeated copy of the owned final", async () => {
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
  await expect(f.run(repeated)).rejects.toMatchObject({ code: "continuity_source_unproven" });
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} owned tool-result rounds advance canonical input without accepting foreign records`, async () => {
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
  await expect(f.run(foreignReplay)).rejects.toMatchObject({ code: "continuity_source_unproven" });
});

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

for (const format of ["encrypted", "readable", "summary-only"] as const) test(`${format} checkpoint rejects a repeated legal marker moved after foreign execution`, async () => {
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
  await expect(f.run(moved)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(2);
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
  expect(binding.ordinaryReplayTombstones.get(aKey)).toBe(1);

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
  const deadline = Date.now() + 1000;
  while (binding.state !== "compacting" && Date.now() < deadline) await Bun.sleep(1);
  expect(binding.state).toBe("compacting");
  f.broker.completeSafeTurn(f.controls.safeToken, "Ordinary final wins.");
  expect((await ordinary).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await handoff).toMatchObject({ code: "continuity_manual_handoff_required" });
  expect(binding.revision).toBe(0);
  expect(binding.state).toBe("ready");
  expect(f.submissions).toHaveLength(1);
  expect((await f.run(first)).find(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual({ type: "text_delta", text: "Ordinary final wins.", phase: "final_answer" });
});
