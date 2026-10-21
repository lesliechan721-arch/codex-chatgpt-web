import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { recoveryDigest } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { afterEach, expect, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptToolTimeoutError } from "../src/adapters/chatgpt-web/adapter-error";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { type ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityError } from "../src/adapters/chatgpt-web/continuity-errors";
import { cancelAbandonedContinuityCreation, leaveContinuityMode } from "../src/adapters/chatgpt-web/continuity-lifecycle";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { chatGptCurrentInstructionRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { NativeOperationReply } from "../src/adapters/chatgpt-web/native-tool-operations";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { COMPACT_PROMPT, encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";
import { performanceTest } from "./helpers/performance-test";
import { createSessionContinuityFixtures, recordedCall, taskEnvelope } from "./helpers/session-continuity-fixture";

const test = performanceTest(import.meta.path);
const { cleanups, disposeTestFixtures, fixture } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);

for (const manual of [true, false]) test(`continuity: ${manual ? "Zero Risk" : "Automatic"} negotiated task updates allow successive ordinary turns on the same page`, async () => {
  const f = fixture(manual, { taskUpdates: true });
  let request = f.request();
  const tokens = new Set<string>();
  let lease: ContinuityLease | undefined;
  for (let turn = 1; turn <= 3; turn++) {
    const events = await f.run(request);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")
      .map(event => event.type === "text_delta" ? event.text : "").join("")).toBe(`Completed response ${turn}.`);
    expect(f.submissions).toHaveLength(turn);
    const submission = f.submissions.at(-1)!;
    expect(submission.reused).toBe(turn > 1);
    expect(submission.prompt).toContain('"protocol":"task-updates-v1","task_revision":0');
    const token = manual
      ? JSON.parse(submission.prompt.match(/<codex_zero_risk_request_json>\n([^\n]+)\n/)![1]!).request_id
      : submission.turnToken!;
    expect(tokens.has(token)).toBe(false);
    tokens.add(token);
    expect(f.broker.taskOutputReceipt(token)).toBeUndefined();
    const currentSession = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(request)}`)!;
    expect(currentSession.runtime.taskUpdates?.outputReceipt).toMatchObject({ kind: "completed", taskRevision: 0, driverGeneration: 0 });
    expect(f.pages.size).toBe(1);
    const page = [...f.pages.values()][0]!;
    expect(page.state).toBe("ready");
    if (lease) {
      expect(page.continuity.owner).toBe(lease.owner);
      expect(page.continuity.leaseId).toBe(lease.leaseId);
      expect(page.continuity.traceId).not.toBe(lease.traceId);
      expect(submission.claim.expected).toEqual(lease);
    }
    lease = { ...page.continuity };
    const registration = f.registrations.get(continuityDigest(f.threadId))!;
    expect(registration.state).toBe("entered");
    expect(continuityBindingsFor(f.statePath).lookup(continuityDigest(f.threadId), registration.scope)!.state).toBe("ready");
    request = f.next(request, `turn-next-${turn}`, `Completed response ${turn}.`);
  }
});

for (const manual of [false, true]) for (const replacement of ["empty", "removed"] as const) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} cached ordinary round applies ${replacement} tools before Native admission`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.nativeSourceTools = true;
  const first = f.request();
  const initial = await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const binding = source.runtime.continuityBinding!;
  const generation = source.continuityGenerationValue();
  const lastUsedAt = binding.lastUsedAt;
  const lease = structuredClone(binding.lease);
  const raw = structuredClone(first._rawBody) as { input: unknown[]; tools: unknown[] };
  raw.tools = replacement === "empty" ? [] : [{ type: "function", name: "remaining_fixture_tool",
    parameters: { type: "object", properties: {} } }];
  const replay = parseRequest(raw);
  replay._conversationPolicy = "task";
  expect(await f.run(replay)).toEqual(initial);
  expect(source.continuityGenerationValue()).toBe(generation);
  expect(binding.lastUsedAt).toBe(lastUsedAt);
  expect(binding.lease).toEqual(lease);
  expect(f.submissions).toHaveLength(1);
  const start = (operationId: number, cmd = "fixture-command-not-executed-by-this-test") => callTurnBroker<NativeOperationReply>(
    f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "native_operation_start", token: f.controls.sourceToken, contract: manual ? "safe" : "native",
      nativeWaitProtocol: 1, operationId, entry: "codex_exec", nativeInput: { cmd }, waitMs: 1,
    });
  expect(await start(2)).toMatchObject({ kind: "result", result: {
    isError: true, structuredContent: { code: "codex_tool_admission_rejected" },
  } });
  expect(await start(1)).toEqual({ kind: "pending", operation_id: 1 });
  await expect(start(1, "changed-start-description")).rejects.toMatchObject({ code: "codex_tool_operation_conflict" });
  expect(source.outstanding().map(request => request.callId)).toEqual([call.callId]);
  const delivery = spyOn(f.broker, "completeTool");
  try {
    const result = parseRequest({ ...raw, input: [...raw.input,
      { type: "function_call_output", call_id: call.callId, output: "Original admitted operation result." }] });
    result._conversationPolicy = "task";
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    await f.run(result);
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.controls.toolResults[0]?.content).toEqual([{ type: "text", text: "Original admitted operation result." }]);
    expect(f.submissions).toHaveLength(1);
  } finally { delivery.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} rejected current payload leaves the active registry unchanged`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const raw = structuredClone(first._rawBody) as { input: Array<Record<string, unknown>>; tools: unknown[] };
    raw.input[0]!.content = "Conflicting current instruction.";
    raw.tools = [];
    const rejected = parseRequest(raw);
    rejected._conversationPolicy = "task";
    await expect(f.run(rejected)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
    const claim = await callTurnBroker<{ activityId?: string; environment: { tools: Array<{ name: string }> } }>(
      f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token: f.controls.sourceToken, ...(manual ? { contract: "safe" } : {}) });
    expect(claim.environment.tools.map(tool => tool.name)).toEqual(["exec_command"]);
    if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "activity_complete", token: f.controls.sourceToken, activityId: claim.activityId,
    });
    const result = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: call.callId, output: "Accepted original result." }]);
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.controls.toolResults).toHaveLength(1);
  } finally { update.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} generating reconnect applies its tools without advancing work`, async () => {
  const f = fixture(manual);
  f.controls.deferCompletion = true;
  const first = f.request();
  const adapter = f.adapter();
  const abort = new AbortController();
  await adapter.preflight!(first, { headers: new Headers() });
  const detached = adapter.runTurn!(first, { headers: new Headers(), abortSignal: abort.signal }, () => {}).catch(error => error);
  while (!f.controls.started) await Bun.sleep(1);
  abort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const generation = source.continuityGenerationValue();
  const lastUsedAt = source.runtime.continuityBinding!.lastUsedAt;
  const raw = { ...first._rawBody as object, tools: [] };
  const retry = parseRequest(raw);
  retry._conversationPolicy = "task";
  await adapter.preflight!(retry, { headers: new Headers() });
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const pending = adapter.runTurn!(retry, { headers: new Headers() }, () => {});
    while (update.mock.calls.length === 0) await Bun.sleep(1);
    const token = manual ? f.controls.safeToken : f.submissions[0]!.turnToken!;
    expect(await callTurnBroker<NativeOperationReply>(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "native_operation_start", token, contract: manual ? "safe" : "native", nativeWaitProtocol: 1,
      operationId: 1, entry: "codex_exec", nativeInput: { cmd: "not-executed" }, waitMs: 1,
    })).toMatchObject({ kind: "result", result: { isError: true, structuredContent: { code: "codex_tool_admission_rejected" } } });
    expect(source.continuityGenerationValue()).toBe(generation);
    expect(source.runtime.continuityBinding!.lastUsedAt).toBe(lastUsedAt);
    expect(source.outstanding()).toEqual([]);
    if (manual) f.broker.completeSafeTurn(token, "Completed response 1.");
    else f.controls.releaseDeferredCompletion!();
    await pending;
    expect(f.submissions).toHaveLength(1);
  } finally { update.mockRestore(); }
});

for (const manual of [false, true]) test(`registry replay: ${manual ? "Zero Risk" : "Automatic"} old execution cannot replace the later owner's tools`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  const first = f.request();
  const oldEvents = await f.run(first);
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const next = f.next(first);
  await f.run(next);
  const current = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  const call = current.outstanding()[0]!;
  const binding = current.runtime.continuityBinding!;
  const owner = binding.executionKey;
  const generation = current.continuityGenerationValue();
  const lastUsedAt = binding.lastUsedAt;
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    const replay = parseRequest({ ...first._rawBody as object, tools: [] });
    replay._conversationPolicy = "task";
    expect(await f.run(replay)).toEqual(oldEvents);
    expect(update).not.toHaveBeenCalled();
    expect(binding.executionKey).toBe(owner);
    expect(current.continuityGenerationValue()).toBe(generation);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    const claim = await callTurnBroker<{ activityId?: string; environment: { tools: Array<{ name: string }> } }>(
      f.provider.chatgptWeb!.brokerSocketPath!, { method: "claim", token: f.controls.sourceToken, ...(manual ? { contract: "safe" } : {}) });
    expect(claim.environment.tools.map(tool => tool.name)).toEqual(["exec_command"]);
    if (claim.activityId) await callTurnBroker(f.provider.chatgptWeb!.brokerSocketPath!, {
      method: "activity_complete", token: f.controls.sourceToken, activityId: claim.activityId,
    });
    const result = f.request("", "turn-next", [...(next._rawBody as { input: unknown[] }).input,
      { type: "function_call_output", call_id: call.callId, output: "Later owner's result." }]);
    expect((await f.run(result)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } finally { update.mockRestore(); }
});

test("registry replay: a delayed old update cannot replace the new owner's discovery", async () => {
  const f = fixture(true, { mcpTransport: "in-process" });
  f.controls.deferCompletion = true;
  const tools = [{ type: "tool_search", parameters: { type: "object" } }];
  const first = parseRequest({ ...f.request()._rawBody as object, tools });
  first._conversationPolicy = "task";
  let release!: () => void;
  let entered!: () => void;
  const applied = new Promise<void>(resolve => { entered = resolve; });
  const originalUpdate = f.broker.updateEnvironment.bind(f.broker);
  let paused = false;
  // DEV owner IPC can apply the update before its response reaches the Adapter.
  const update = spyOn(f.broker, "updateEnvironment").mockImplementation(async (token, environment) => {
    originalUpdate(token, environment);
    if (!paused) {
      paused = true;
      entered();
      await new Promise<void>(resolve => { release = resolve; });
    }
  });
  let oldRun: Promise<AdapterEvent[]> | undefined;
  try {
    oldRun = f.run(first);
    await applied;
    while (!f.controls.started) await Bun.sleep(1);
    const oldSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
    f.broker.completeSafeTurn(f.controls.safeToken, "Old ordinary answer.");
    await oldSource.browserOutcome;
    await oldSource.physicalSettlement;
    const binding = oldSource.runtime.continuityBinding!;
    f.controls.deferCompletion = false;
    f.controls.invokeSourceTools = true;
    f.controls.singleSourceTool = true;
    f.controls.reviewWireName = "tool_search";
    const current = parseRequest({ ...f.next(first)._rawBody as object, tools });
    current._conversationPolicy = "task";
    expect((await f.run(current)).at(-1)).toMatchObject({ type: "done", endTurn: false });
    const currentSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(current)}`)!;
    const call = currentSource.outstanding()[0]!;
    const discovered = { type: "function", name: "new_owner_discovered", parameters: { type: "object", properties: {} } };
    const terminal = parseRequest({ ...current._rawBody as object, input: [...(current._rawBody as { input: unknown[] }).input,
      { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [discovered] }] });
    terminal._conversationPolicy = "task";
    expect((await f.run(terminal)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(binding.discoveredTools?.map(tool => tool.name)).toEqual(["new_owner_discovered"]);
    const newOwnerKey = binding.executionKey;
    const generation = currentSource.continuityGenerationValue();
    const lastUsedAt = binding.lastUsedAt;
    const lease = structuredClone(binding.lease);
    release();
    const oldEvents = await oldRun;
    expect(oldEvents).toContainEqual({ type: "text_delta", text: "Old ordinary answer.", phase: "final_answer" });
    expect(oldEvents.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(binding.executionKey).toBe(newOwnerKey);
    expect(binding.discoveredTools?.map(tool => tool.name)).toEqual(["new_owner_discovered"]);
    expect(currentSource.continuityGenerationValue()).toBe(generation);
    expect(binding.lastUsedAt).toBe(lastUsedAt);
    expect(binding.lease).toEqual(lease);
    expect(f.controls.toolResults).toHaveLength(1);
    expect(f.submissions).toHaveLength(2);
  } finally {
    release?.();
    await oldRun?.catch(() => {});
    update.mockRestore();
  }
});

for (const [kind, layout] of [
  ["plugins.instructions", "merged"], ["plugins.usage_instructions", "merged"], ["apps.instructions", "merged"],
  ["multi_agent.mode_instructions", "standalone"], ["multi_agent.role_instructions", "standalone"],
  ["multi_agent.usage_hint", "standalone"], ["token_budget.context_window", "standalone"],
  ["managed_config.developer_instructions", "standalone"],
  ["skills.catalog", "merged"], ["skills.instructions", "merged"], ["cloud_skills.instructions", "merged"],
  ["memories.instructions", "merged"], ["plugins.recommendations", "merged"], ["environments.instructions", "merged"],
  ["persistent_mode.instructions", "merged"], ["token_budget.context_window_guidance", "merged"],
  ["tools.deferred_namespaces", "merged"], ["git_attribution.instructions", "merged"], ["model_switch.instructions", "merged"],
] as const) test(`native prefix: ${kind} survives a new turn and rejects a conflicting retry`, async () => {
  const f = fixture();
  const generic = { type: "input_text", text: "Generic native developer instructions." };
  const target = { type: "input_text", text: `Current ${kind} instructions.` };
  const targetFirst = kind === "model_switch.instructions";
  const parts = targetFirst ? [target, generic] : [generic, target];
  const prefix = { type: "message", role: "developer", id: "native-prefix",
    content: layout === "merged" ? parts : [target],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: layout === "merged"
      ? (targetFirst ? [kind, "generic.developer_instructions"] : ["generic.developer_instructions", kind]) : [kind] } };
  // Source-backed synthetic variants of the rust-v0.159.2 initial developer layout.
  const prefixes = layout === "standalone" ? [{ ...prefix, id: "native-generic-prefix", content: [generic],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first", content_item_kinds: ["generic.developer_instructions"] } }, prefix] : [prefix];
  const first = f.request("", "turn-first", [...prefixes, ...(f.request()._rawBody as { input: unknown[] }).input]);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const next = f.next(first);
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const prompt = f.submissions.at(-1)!.prompt;
  for (const part of parts) expect(prompt).toContain(part.text);
  expect(prompt.indexOf(parts[0]!.text)).toBeLessThan(prompt.indexOf(parts[1]!.text));
  const raw = structuredClone(next._rawBody) as { input: Array<Record<string, unknown>> };
  const content = raw.input[layout === "standalone" ? 1 : 0]!.content as Array<{ type: string; text: string }>;
  content[layout === "merged" && !targetFirst ? 1 : 0]!.text = `Changed ${kind} instructions.`;
  const retry = parseRequest(raw);
  retry._conversationPolicy = "task";
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    await expect(f.run(retry)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
  } finally { update.mockRestore(); }
  expect(f.submissions).toHaveLength(2);
});

test("verified pure environment: a derived no-AGENTS checkpoint continuation stays on the same page", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "cgw-cont-pure-env-home-"));
  cleanups.push(async () => { rmSync(codexHome, { recursive: true, force: true }); });
  const f = fixture(false, { codexHome, threadId: "019cbcc7-31b2-7028-a632-7f8118410741" });
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  // Source-backed no-AGENTS variant of the API-key capture, with a synthetic canonical rollout.
  // The original verified resolver runs unchanged; the page is the existing controlled fixture.
  const capture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/session-continuity/current-work-protocol-api-key.json"), "utf8")) as {
    captured: Array<{ label: string; body: { input: Array<Record<string, any>>; client_metadata: Record<string, string>; [key: string]: unknown } }>;
  };
  const sourceTurn = "019cbcc7-31b2-7028-a632-7f8118410742";
  const compactTurn = "019cbcc7-31b2-7028-a632-7f8118410743";
  const continuedTurn = "019cbcc7-31b2-7028-a632-7f8118410744";
  const sourceBody = structuredClone(capture.captured.find(record => record.label === "new-turn")!.body);
  sourceBody.input = sourceBody.input.filter(item => item.role === "developer" || item.id === "item_4" || item.id === "item_12");
  const continuedBody = structuredClone(capture.captured.find(record => record.label === "continue")!.body);
  for (const body of [sourceBody, continuedBody]) for (const item of body.input) {
    if (Array.isArray(item.content)) {
      item.content = item.content.filter((part: { text?: string }) => !part.text?.startsWith("# AGENTS.md instructions"));
    }
  }
  expect(JSON.stringify([sourceBody.input, continuedBody.input])).not.toContain("AGENTS_MARKER");
  const sourceItem = sourceBody.input.find(item => item.id === "item_12")!;
  const sessionDirectory = join(codexHome, "sessions", "2026", "09", "30");
  mkdirSync(sessionDirectory, { recursive: true });
  const rolloutPath = join(sessionDirectory, `rollout-2026-09-30T09-00-00-${f.threadId}.jsonl`);
  const nativeEnvironment = (item: Record<string, any>, turnId: string) => ({ type: "response_item", payload: {
    ...item, internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["environments.environment_context"] },
  } });
  const nativeContext = (turnId: string) => ({ type: "turn_context", payload: { turn_id: turnId, cwd: "/tmp/cgw-protocol-fixture/workspace",
    workspace_roots: ["/tmp/cgw-protocol-fixture/workspace"], approval_policy: "never", sandbox_policy: { type: "read-only" },
    permission_profile: { type: "managed", network: "restricted", file_system: { type: "restricted",
      entries: [{ path: { type: "special", value: { kind: "root" } }, access: "read" }] } } } });
  const nativeRecords: unknown[] = [
    { type: "session_meta", payload: { id: f.threadId, source: "vscode" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: sourceTurn } },
    nativeEnvironment(sourceBody.input.find(item => item.id === "item_4")!, sourceTurn),
    nativeContext(sourceTurn),
    { type: "response_item", payload: { ...sourceItem, internal_chat_message_metadata_passthrough: {
      turn_id: sourceTurn, content_item_kinds: ["user.text"],
    } } },
  ];
  const writeNativeRecords = () => writeFileSync(rolloutPath, nativeRecords.map(item => JSON.stringify(item)).join("\n") + "\n");
  writeNativeRecords();
  const metadata = JSON.parse(sourceBody.client_metadata["x-codex-turn-metadata"]!);
  const options = { model: "gpt-5.6-sol", reasoning: { effort: "low" }, stream: false };
  const first = parseRequest({ ...sourceBody, ...options, client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    ...metadata, thread_id: f.threadId, turn_id: sourceTurn, request_kind: "turn",
  }) } });
  first._conversationPolicy = "task";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const binding = source.runtime.continuityBinding!;
  const physicalKey = f.submissions[0]!.key;
  const leaseId = binding.lease!.leaseId;
  const compact = parseRequest({ ...sourceBody, ...options, input: [...sourceBody.input,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Completed response 1." }] },
    { type: "message", role: "user", content: COMPACT_PROMPT }],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: f.threadId, turn_id: compactTurn,
      request_kind: "compaction", compaction: { implementation: "responses", strategy: "memento", phase: "standalone_turn" } }) },
  });
  compact._conversationPolicy = "task";
  compact._compactionRequest = true;
  compact._compactionOutput = "message";
  // The retained source environment predates the standalone compaction task. A turn_context
  // alone is not historical provenance; native Codex writes the task_started boundary too.
  nativeRecords.push({ type: "event_msg", payload: { type: "task_started", turn_id: compactTurn } });
  writeNativeRecords();
  await new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolveWithRolloutPublicationRetry(compact);
  const summary = (await f.run(compact)).find(event => event.type === "text_delta");
  if (summary?.type !== "text_delta") throw new Error("Missing verified compaction summary");
  expect(compact._chatGptCompactionSourceTurnId).toBe(sourceTurn);
  expect(binding.checkpoints.size).toBe(1);
  expect(binding.revision).toBe(1);
  expect(f.submissions).toHaveLength(2);
  continuedBody.input.find(item => item.id === "item_18")!.content = [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary.text}` }];
  const continued = parseRequest({ ...continuedBody, ...options, client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    ...JSON.parse(continuedBody.client_metadata["x-codex-turn-metadata"]!), thread_id: f.threadId, turn_id: continuedTurn, request_kind: "turn",
  }) } });
  continued._conversationPolicy = "task";
  nativeRecords.push(
    { type: "event_msg", payload: { type: "task_started", turn_id: continuedTurn } },
    nativeEnvironment(continuedBody.input.find(item => item.id === "item_20")!, continuedTurn),
    nativeContext(continuedTurn),
  );
  writeNativeRecords();
  const accepted = await f.run(continued);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]).toMatchObject({ key: physicalKey, reused: true });
  expect(binding.lease!.leaseId).toBe(leaseId);
  const prompt = f.submissions[2]!.prompt;
  for (const marker of ["SYSTEM_MARKER", "DEVELOPER_MARKER", "CONTINUE_MARKER"]) expect(prompt).toContain(marker);
  for (const marker of ["ORDINARY_MARKER", "NEW_TURN_MARKER", "AGENTS_MARKER"]) expect(prompt).not.toContain(marker);
  expect(await f.run(structuredClone(continued))).toEqual(accepted);
  expect(f.submissions).toHaveLength(3);
  const conflictingRaw = structuredClone(continued._rawBody) as { input: Array<Record<string, any>> };
  conflictingRaw.input.find(item => item.id === "item_21")!.content[0].text = "Changed current continuation payload.";
  const conflicting = parseRequest(conflictingRaw);
  conflicting._conversationPolicy = "task";
  const update = spyOn(f.broker, "updateEnvironment");
  try {
    await expect(f.run(conflicting)).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(update).not.toHaveBeenCalled();
  } finally { update.mockRestore(); }
  expect(f.submissions).toHaveLength(3);
  expect(f.pages.size).toBe(1);
  expect(binding.revision).toBe(1);
  expect(binding.checkpoints.size).toBe(1);
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

test("automatic continuity keeps the same page with Bigger Context enabled and sends each input without staging", async () => {
  const f = fixture();
  f.provider.chatgptWeb!.experimentalBiggerContext = true;
  const first = f.request();
  first.options.reasoning = "medium";
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const next = f.next(first);
  next.options.reasoning = "medium";
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(2);
  expect(f.pages.size).toBe(1);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.submissions[1]!.prompt).not.toContain("Completed response 1.");
});

for (const biggerContext of [false, true]) test(`first input preflight rejects over-limit prompts with Bigger Context ${biggerContext}`, async () => {
  const f = fixture();
  f.provider.chatgptWeb!.experimentalBiggerContext = biggerContext;
  await expect(f.run(f.request("oversized ".repeat(100_000)))).rejects.toMatchObject({
    code: biggerContext ? "context_length_exceeded" : "CONTEXT_BUDGET_EXCEEDED", retryable: false,
  });
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
  const store = new ContinuityRecoveryStore(f.statePath);
  const pending = store.get(continuityDigest(f.threadId))!;
  const attempt = pending.works[pending.currentWorkId!]!.attempts.at(-1)!;
  expect(attempt).toMatchObject({ stage: "prepared", writerRetired: false,
    acquisitionEvidence: { status: "not-acquired" } });
  expect(attempt.sendEvidence?.status).toBe(manual ? "not-sent" : undefined);
  expect(attempt.preparationTermination).toBeUndefined();
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} unknown pre-page capacity failure permits a new page generation`, async () => {
  const f = fixture(manual);
  const first = f.request();
  f.controls.unknownPreLeaseFailures = 1;
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const store = new ContinuityRecoveryStore(f.statePath);
  const before = store.get(continuityDigest(f.threadId))!;
  const attempt = before.works[before.currentWorkId!]!.attempts[0]!;
  expect(attempt.acquisitionEvidence?.status).toBe("possible");
  expect(attempt.sendEvidence?.status).toBe(manual ? "possible" : undefined);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  const after = store.get(before.thread)!;
  expect(after.works[before.currentWorkId!]).toBeUndefined();
  expect(after.transaction!.transactionId).not.toBe(before.transaction!.transactionId);
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ended initial creation uses the current payload and history`, async () => {
  const payload = fixture(manual);
  const first = payload.request();
  payload.controls.preLeaseFailures = 1;
  expect((await payload.run(first)).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  expect((await payload.run(payload.request("Changed current instruction.", "turn-first"))).at(-1))
    .toMatchObject({ type: "done", endTurn: true });
  expect(payload.submissions).toHaveLength(1);
  expect(payload.submissions[0]!.prompt).toContain("Changed current instruction.");
  await expect(payload.run(first)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(payload.submissions).toHaveLength(1);

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
  expect((await history.run(history.request("", "turn-first", changedInput))).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(history.submissions).toHaveLength(1);
  expect(history.submissions[0]!.prompt).toContain("Changed initial history.");
  expect(history.submissions[0]!.prompt).not.toContain("Original initial history.");
});

for (const manual of [false, true]) for (const retryable of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ${retryable ? "ended creation uses current" : "live completed replay preserves accepted"} ID-only history after removed turn metadata`, async () => {
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
  expect(f.submissions[0]!.prompt).toContain(retryable ? "Changed ID-only history." : "Original ID-only history.");
  expect(f.submissions[0]!.prompt).not.toContain(retryable ? "Original ID-only history." : "Changed ID-only history.");
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

for (const manual of [false, true]) for (const terminal of ["interrupt", "mode-exit", "lost"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${terminal} ${terminal === "lost" ? "preserves" : "releases"} the captured input of failed initial creation`, async () => {
  const f = fixture(manual);
  f.controls.preLeaseFailures = 1;
  expect((await f.run(f.request())).at(-1)).toMatchObject({ type: "error", code: "continuity_resource_capacity" });
  const bindings = continuityBindingsFor(f.statePath);
  const binding = bindings.observed(continuityDigest(f.threadId))!;
  expect(binding.state).toBe("creating");
  expect(binding.initialAcceptedInput).toBeDefined();
  expect(binding.initialInstructionPayloadDigest).toBeDefined();
  const acceptedInput = binding.initialAcceptedInput;
  const acceptedPayloadDigest = binding.initialInstructionPayloadDigest;
  const recoveryStore = new ContinuityRecoveryStore(f.statePath);
  const originalRecovery = recoveryStore.get(continuityDigest(f.threadId))!;
  if (terminal === "interrupt") expect(cancelAbandonedContinuityCreation(f.statePath, f.threadId, "turn-first")).toBe(true);
  else if (terminal === "mode-exit") await leaveContinuityMode(f.statePath, f.threadId);
  else bindings.lose(binding, binding.executionKey);
  expect(binding.state).toBe(terminal === "lost" ? "lost" : "ended");
  if (terminal === "lost") {
    expect(binding.initialAcceptedInput).toEqual(acceptedInput);
    expect(binding.initialInstructionPayloadDigest).toBe(acceptedPayloadDigest);
  } else {
    expect(binding.initialAcceptedInput).toBeUndefined();
    expect(binding.initialInstructionPayloadDigest).toBeUndefined();
  }
  const accepted = await f.run(f.request());
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(f.request())).toEqual(accepted);
  const recovered = recoveryStore.get(originalRecovery.thread)!;
  expect(recovered.works[originalRecovery.currentWorkId!]).toBeUndefined();
  expect(recovered.epoch).not.toBe(originalRecovery.epoch);
  expect(f.pages.size).toBe(1);
  expect(f.submissions).toHaveLength(1);
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
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Actual checkpoint source result." },
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

for (const manual of [false, true]) for (const role of ["system", "developer"] as const) for (const tagged of [false, true]) for (const trailing of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} ended first creation accepts current ${tagged ? "tagged" : "untagged"} ${trailing ? "trailing" : "leading"} ${role} constraint then enforces it on the live page`, async () => {
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
  const changedInput = structuredClone((first._rawBody as { input: Array<Record<string, unknown>> }).input);
  changedInput.find(item => item.id === "current-envelope")!.content = "Conflicting current constraint.";
  const changed = f.request("", "turn-first", changedInput);
  const accepted = await f.run(changed);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions[0]!.prompt).toContain("Conflicting current constraint.");
  expect(f.submissions[0]!.prompt).not.toContain("Accepted current constraint.");
  expect(await f.run(changed)).toEqual(accepted);
  await expect(f.run(first)).rejects.toMatchObject({ code: "continuity_source_unproven" });
  expect(f.submissions).toHaveLength(1);
});

for (const manual of [false, true]) for (const retainSource of [false, true]) for (const tagged of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint-only keeps ${tagged ? "tagged" : "untagged"} trailing constraints with source ${retainSource ? "retained" : "recovered"}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = manual;
  const first = f.request();
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const compact = f.request("", "turn-first", [
    ...(first._rawBody as { input: unknown[] }).input,
    recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint source result." },
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
        recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
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
    parsed._conversationPolicy = "task";
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
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." }] });
    compact._conversationPolicy = "task";
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

for (const manual of [false, true]) for (const entry of ["initial", "ordinary", "checkpoint"] as const) test(`${manual ? "Zero Risk" : "Automatic"} ${entry} rejects anonymous current instruction before submitting`, async () => {
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
        recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Real checkpoint result." },
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
  const submissions = f.submissions.length;
  // Keep real admission and no-Send checks for both layouts on each route. The
  // complete parameter matrix also calls the production selector without I/O.
  for (const trailing of [false, true]) {
    const input = [...base, ...(trailing ? [current, anonymous] : [anonymous, current])];
    await expect(f.run(f.request("", "turn-next", input))).rejects.toMatchObject({ code: "continuity_source_unproven" });
    const changed = input.map(item => item === anonymous ? { ...anonymous, content: "Conflicting anonymous constraint." } : item);
    await expect(f.run(f.request("", "turn-next", changed))).rejects.toMatchObject({ code: "continuity_source_unproven" });
    expect(f.submissions).toHaveLength(submissions);
  }
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
  expect(capacityQueries).toBe(1);
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
  await leaveContinuityMode(f.statePath, f.threadId);
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("ended");
  expect(f.pages.size).toBe(0);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
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
  await leaveContinuityMode(f.statePath, f.threadId);
  expect((await f.run(first)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
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

for (const manual of [false, true]) test(`limited takeover notice waits for a real submission and is consumed once manual=${manual}`, async () => {
  const f = fixture(manual);
  const first = f.request();
  await f.run(first);
  f.pages.clear();
  f.controls.retirementCleanup = "pending";
  const next = f.next(first);
  const adapter = f.adapter();
  await adapter.preflight!(next, { headers: new Headers() });
  const bindings = continuityBindingsFor(f.statePath);
  const thread = continuityDigest(f.threadId);
  expect(bindings.recoveryStore.get(thread)!.takeoverNoticePending).toBeUndefined();
  expect(f.submissions).toHaveLength(1);
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(next, { headers: new Headers() }, event => events.push(event));
  expect(events.filter(event => event.type === "text_delta" && event.text.includes("Previous external effects may remain"))).toHaveLength(1);
  expect(bindings.recoveryStore.get(thread)!.takeoverNoticePending).toBeUndefined();
  const consumed = bindings.recoveryStore.get(thread)!;
  const replay = await f.run(structuredClone(next));
  expect(replay).toEqual(events);
  expect(bindings.recoveryStore.get(thread)).toEqual(consumed);
  expect(f.submissions).toHaveLength(2);
});

test("a missing physical page starts one replacement epoch and exact retries replay its result", async () => {
  const f = fixture();
  const first = f.request();
  await f.run(first);
  const sourceEpoch = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(f.threadId))!.epoch;
  const sourceKey = f.submissions[0]!.key;
  f.pages.clear();
  const next = f.next(first);
  const recovered = await f.run(next);
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(next))).toEqual(recovered);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).not.toBe(sourceKey);
  expect(f.submissions[1]!.reused).toBe(false);
  expect(f.submissions[1]!.prompt).toContain("Next continuity instruction.");
  expect(f.pages.size).toBe(1);
  expect(f.registrations.get(continuityDigest(f.threadId))).toMatchObject({ state: "entered" });
  expect(continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(f.threadId))!.epoch).not.toBe(sourceEpoch);
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
  writeFileSync(f.descriptorPath, JSON.stringify({ ...f.descriptor, features: [] }));
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  writeFileSync(f.descriptorPath, JSON.stringify(f.descriptor));
  rmSync(f.statePath, { recursive: true, force: true });
  await expect(f.run(f.request())).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
  expect(f.submissions).toHaveLength(0);
});

for (const kind of ["summary", "compaction", "tool-context"] as const) test(`page lifetime: readable current ${kind} input can create a page`, async () => {
  const f = fixture();
  const summary = { type: "compaction", encrypted_content: encodeCompactionSummary("Current task: finish the inherited checkpoint task.") };
  const request = kind === "summary" ? f.request("", "turn-first", [summary]) : f.request("", "turn-first", [
    ...(f.request()._rawBody as { input: unknown[] }).input,
    ...(kind === "tool-context" ? [{ type: "function_call_output", call_id: "historical-call", output: "Actual previous result." }] : []),
  ]);
  request._compactionRequest = kind === "compaction";
  expect((await f.run(request)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(1);
  expect(f.controls.toolResults).toHaveLength(0);
  const record = new ContinuityRecoveryStore(f.statePath).get(continuityDigest(f.threadId))!;
  expect(Object.keys(record.calls)).toHaveLength(0);
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
  expect(JSON.stringify(taskEnvelope(f.submissions[1]!.prompt))).not.toContain("Foreign tool result.");
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
  const f = fixture(manual, { mcpTransport: "in-process" });
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
  const f = fixture(manual, { mcpTransport: "in-process" });
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
  first._conversationPolicy = "task";
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
  accepted._conversationPolicy = "task";
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
  changed._conversationPolicy = "task";
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

test("a lost manual end acknowledgement preserves its accepted answer and reuses the verified page for new work", async () => {
  const f = fixture(true);
  f.controls.endFailure = true;
  const first = f.request();
  const accepted = await f.run(first);
  expect(accepted.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.registrations.get(continuityDigest(f.threadId))?.state).toBe("entered");
  const source = continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!;
  const sourceEpoch = source.epoch;
  expect(source.state).toBe("ready");
  expect(await f.run(structuredClone(first))).toEqual(accepted);
  expect(f.submissions).toHaveLength(1);
  f.controls.endFailure = false;
  const next = f.next(first);
  const recovered = await f.run(next);
  expect(recovered.at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(await f.run(structuredClone(next))).toEqual(recovered);
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  expect(f.submissions[1]!.reused).toBe(true);
  expect(f.pages.size).toBe(1);
  expect(continuityBindingsFor(f.statePath).observed(continuityDigest(f.threadId))!.epoch).toBe(sourceEpoch);
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

async function completedInspectionFixture(manual: boolean) {
  const f = fixture(manual);
  let releaseInspection!: () => void, inspectionEntered!: () => void, executionStarted!: () => void;
  const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
  const started = new Promise<void>(resolve => { executionStarted = resolve; });
  f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
  f.controls.onStarted = executionStarted;
  f.controls.deferCompletion = true;
  cleanups.push(async () => { releaseInspection(); });
  const parsed = f.request(), adapter = f.adapter(), originalAbort = new AbortController();
  await adapter.preflight!(parsed, { headers: new Headers() });
  const detached = adapter.runTurn!(parsed, { headers: new Headers(), abortSignal: originalAbort.signal }, () => {}).catch(error => error);
  await started;
  originalAbort.abort();
  expect(await detached).toMatchObject({ name: "AbortError" });
  if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
  else f.controls.releaseDeferredCompletion!();
  await inspected;
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(parsed)}`)!;
  const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), before = store.get(thread)!;
  expect(source.isActive()).toBe(true);
  expect(source.settledOutcome()).toBeUndefined();
  expect(before.works[before.currentWorkId!]!).toMatchObject({ state: "completed", terminalDigest: recoveryDigest("Completed response 1.") });
  expect(before.works[before.currentWorkId!]!.attempts.at(-1)).toMatchObject({ stage: "completed", writerRetired: true });
  expect(source.runtime.recoveryOrigin).toMatchObject({ scope: before!.scope, logicalWorkId: before.currentWorkId,
    ownerId: before.owner.id, attempt: 0, epoch: before.epoch });
  return { ...f, parsed, source, store, thread, before, releaseInspection };
}

for (const manual of [false, true]) for (const boundary of ["settles", "observer-aborts", "business-deadline", "source-conflict", "stops", "successor", "successor-browser-error"] as const) {
  test(`review repair3: ${manual ? "Zero Risk" : "Automatic"} exact completed reconnect ${boundary}`, async () => {
    const f = await completedInspectionFixture(manual);
    const update = spyOn(f.broker, "updateEnvironment");
    cleanups.push(async () => { update.mockRestore(); });
    if (boundary === "source-conflict") {
      const raw = structuredClone(f.parsed._rawBody) as { input: Array<Record<string, unknown>> };
      raw.input[0]!.content = "A conflicting body for the already accepted instruction.";
      const changed = parseRequest(raw); changed._conversationPolicy = "task";
      await expect(f.run(changed)).rejects.toMatchObject({ code: "continuity_source_unproven" });
      f.releaseInspection();
      expect((await f.run(f.parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
    } else {
      let canonicalChecked!: () => void;
      const checked = new Promise<void>(resolve => { canonicalChecked = resolve; });
      const adapter = f.adapter(), abort = new AbortController(), events: AdapterEvent[] = [];
      await adapter.preflight!(f.parsed, { headers: new Headers() });
      const assertCanonical = f.source.assertCanonicalReplayInput.bind(f.source);
      const canonical = spyOn(f.source, "assertCanonicalReplayInput").mockImplementation(input => { assertCanonical(input); canonicalChecked(); });
      cleanups.push(async () => { canonical.mockRestore(); });
      let returned = false;
      const reconnect = adapter.runTurn!(f.parsed, { headers: new Headers(), abortSignal: abort.signal }, event => events.push(event))
        .then(() => { returned = true; }, error => { returned = true; return error; });
      await checked;
      expect(returned).toBe(false);
      expect(update).not.toHaveBeenCalled();
      if (boundary === "observer-aborts") {
        abort.abort();
        expect(await reconnect).toMatchObject({ name: "AbortError" });
        expect(f.source.isActive()).toBe(true);
        expect(f.store.get(f.thread)).toEqual(f.before);
        f.releaseInspection();
        expect((await f.run(f.parsed)).at(-1)).toMatchObject({ type: "done", endTurn: true });
      } else if (boundary === "business-deadline") {
        // Deliver the original runtime's deadline failure while its physical cleanup is held.
        // The reconnect must consume that failure before the cleanup gate opens.
        f.source.runtime.cancel(chatGptToolTimeoutError("fixture-command-not-executed-by-this-test", 1000));
        expect(await reconnect).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "error", code: "codex_tool_timeout", status: 504 });
        expect(f.source.isPhysicallySettled()).toBe(false);
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.attempts).toEqual(f.before.works[f.before.currentWorkId!]!.attempts);
        f.releaseInspection();
        await f.source.physicalSettlement;
      } else if (boundary === "stops" || boundary === "successor" || boundary === "successor-browser-error") {
        if (boundary === "stops") f.store.stopWork(f.thread, { scope: f.before.scope }, f.before.currentWorkId!, "user-stop");
        else {
          const next = f.next(f.parsed, "turn-after-durable-final");
          f.store.admitWork({ thread: f.thread, scope: f.before.scope, owner: continuityProcessInstance(),
            logicalWorkId: continuityDigest([f.thread, "turn-after-durable-final"]), instructionIdentity: "turn-after-durable-final",
            nativeTurnId: "turn-after-durable-final", workPayloadDigest: recoveryDigest(next._rawBody),
            snapshotDigest: recoveryDigest(next._rawBody), dispatchProtocolComplete: true, createPage: true });
          expect(f.store.get(f.thread)!.epoch).toBe(f.before.epoch + 1);
        }
        if (boundary === "successor-browser-error") {
          f.source.runtime.cancel(new Error("The original browser failed after its task was replaced."));
        }
        f.releaseInspection();
        expect(await reconnect).toMatchObject({ code: "continuity_source_unproven" });
        expect(events.some(event => event.type === "done")).toBe(false);
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.terminalDigest).toBe(f.before.works[f.before.currentWorkId!]!.terminalDigest);
      } else {
        f.releaseInspection();
        expect(await reconnect).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
        expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer").map(event => event.type === "text_delta" ? event.text : "").join("")).toBe("Completed response 1.");
        expect(f.store.get(f.thread)!.works[f.before.currentWorkId!]!.attempts).toEqual(f.before.works[f.before.currentWorkId!]!.attempts);
      }
    }
    expect(update).not.toHaveBeenCalled();
    expect(f.submissions).toHaveLength(1);
  });
}

for (const manual of [false, true]) for (const boundary of ["same-work", "successor", "renamed-error", "lookalike-error"] as const) {
  test(`review repair3: ${manual ? "Zero Risk" : "Automatic"} environment RPC crossing completion ${boundary}`, async () => {
    const successor = boundary === "successor";
    const rejects = successor || boundary === "lookalike-error";
    const f = fixture(manual);
    let started!: () => void, inspectionEntered!: () => void, releaseInspection!: () => void;
    const starting = new Promise<void>(resolve => { started = resolve; });
    const inspected = new Promise<void>(resolve => { inspectionEntered = resolve; });
    f.controls.onStarted = started; f.controls.deferCompletion = true;
    f.controls.completionInspection = { entered: inspectionEntered, release: new Promise<void>(resolve => { releaseInspection = resolve; }) };
    cleanups.push(async () => { releaseInspection(); });
    const parsed = f.request(), original = f.adapter(), originalAbort = new AbortController();
    await original.preflight!(parsed, { headers: new Headers() });
    const detached = original.runTurn!(parsed, { headers: new Headers(), abortSignal: originalAbort.signal }, () => {}).catch(error => error);
    await starting; originalAbort.abort();
    expect(await detached).toMatchObject({ name: "AbortError" });
    let rpcEntered!: () => void, releaseRpc!: () => void, rpcRejected!: (error: unknown) => void;
    const entered = new Promise<void>(resolve => { rpcEntered = resolve; });
    const reply = new Promise<void>(resolve => { releaseRpc = resolve; });
    const rejected = new Promise<unknown>(resolve => { rpcRejected = resolve; });
    const updateEnvironment = f.broker.updateEnvironment.bind(f.broker);
    const update = spyOn(f.broker, "updateEnvironment").mockImplementation(async (...args) => {
      rpcEntered(); await reply;
      try { return await updateEnvironment(...args); }
      catch (error) {
        if (boundary === "renamed-error" && error instanceof Error) error.message = "The writer ended; wording is not a protocol field.";
        const returned = boundary === "lookalike-error"
          ? continuityError("continuity_source_unproven", "An obsolete execution cannot write to the current recovery attempt.") : error;
        rpcRejected(returned); throw returned;
      }
    });
    cleanups.push(async () => { releaseRpc(); update.mockRestore(); });
    const adapter = f.adapter(), events: AdapterEvent[] = [];
    await adapter.preflight!(parsed, { headers: new Headers() });
    let returned = false;
    const reconnect = adapter.runTurn!(parsed, { headers: new Headers() }, event => events.push(event))
      .then(() => { returned = true; }, error => { returned = true; return error; });
    await entered;
    if (manual) f.broker.completeSafeTurn(f.controls.safeToken, "Completed response 1.");
    else f.controls.releaseDeferredCompletion!();
    await inspected;
    const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(parsed)}`)!;
    const store = new ContinuityRecoveryStore(f.statePath), thread = continuityDigest(f.threadId), completed = store.get(thread)!;
    expect(completed.works[completed.currentWorkId!]!.state).toBe("completed");
    if (successor) {
      const next = f.next(parsed, "turn-rpc-successor");
      store.admitWork({ thread, scope: completed.scope, owner: continuityProcessInstance(),
        logicalWorkId: continuityDigest([thread, "turn-rpc-successor"]), instructionIdentity: "turn-rpc-successor", nativeTurnId: "turn-rpc-successor",
        workPayloadDigest: recoveryDigest(next._rawBody), snapshotDigest: recoveryDigest(next._rawBody), dispatchProtocolComplete: true, createPage: true });
    }
    releaseRpc();
    expect(await rejected).toMatchObject({ code: "continuity_source_unproven" });
    if (rejects) {
      if (boundary === "lookalike-error") releaseInspection();
      expect(await reconnect).toMatchObject({ code: "continuity_source_unproven" });
      expect(events.some(event => event.type === "done")).toBe(false);
      releaseInspection();
      await source.physicalSettlement;
    } else {
      expect(returned).toBe(false);
      releaseInspection();
      expect(await reconnect).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(store.get(thread)!.works[completed.currentWorkId!]!.terminalDigest).toBe(recoveryDigest("Completed response 1."));
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(f.submissions).toHaveLength(1);
  });
}

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
  const f = fixture(manual, { mcpTransport: "in-process" });
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
    parsed._conversationPolicy = "task";
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} same native turn old instruction cannot revive after steering and checkpoint`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
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

for (const manual of [false, true]) test(`${manual ? "Zero Risk" : "Automatic"} checkpoint resume excludes old item-ID-only instructions and binds only new work`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
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
  replay._conversationPolicy = "task";
  const submissions = f.submissions.length;
  expect((await f.run(replay)).at(-1)).toMatchObject({ type: "done", endTurn: true });
  expect(f.submissions).toHaveLength(submissions);
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

for (const manual of [false, true]) test(`Round 7: approved tool discovery remains usable on ordinary work ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  f.controls.reviewWireName = "tool_search";
  const raw = structuredClone(f.request()._rawBody) as { input: unknown[]; tools: unknown[] };
  const discovered = { type: "function", name: "discovered_command", description: "Locally discovered fixture tool",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } };
  raw.tools = [{ type: "tool_search", description: "Current fixture discovery", parameters: { type: "object" } }];
  raw.input.push({ type: "additional_tools", tools: [{ ...discovered, name: "inline_command" }] });
  const first = parseRequest(raw);
  first._conversationPolicy = "task";
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const searchResult = { type: "tool_search_output", call_id: call.callId, status: "completed", tools: [discovered] };
  const resultRaw = { ...raw, input: [...raw.input, { type: "tool_search_call", call_id: call.callId, arguments: {} }, searchResult] };
  const result = parseRequest(resultRaw);
  result._conversationPolicy = "task";
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
  next._conversationPolicy = "task";
  f.controls.reviewWireName = "discovered_command";
  expect((await f.run(next)).at(-1)).toMatchObject({ type: "done", endTurn: false });
  const nextSource = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(next)}`)!;
  expect(nextSource.outstanding()[0]?.wireName).toBe("discovered_command");
  expect(next.context.tools?.find(tool => tool.name === "discovered_command")?.parameters).toEqual(discovered.parameters);
  const nextCall = nextSource.outstanding()[0]!;
  const terminal = parseRequest({ ...nextRaw, input: [...nextRaw.input,
    { type: "function_call_output", call_id: nextCall.callId, output: "Approved discovered result." }] });
  terminal._conversationPolicy = "task";
  await f.run(terminal);
  expect(f.controls.toolResults).toHaveLength(2);
});

for (const manual of [false, true]) test(`Round 8: historical result collision outside current native instruction ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
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
  const f = fixture(manual, { mcpTransport: "in-process" });
  f.controls.invokeSourceTools = true;
  f.controls.singleSourceTool = true;
  const first = f.request("Source A.", "turn-first");
  await f.run(first);
  const source = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(first)}`)!;
  const call = source.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...(first._rawBody as { input: unknown[] }).input,
    recordedCall(call),
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
      recordedCall(source.outstanding()[0]!), { type: "function_call_output", call_id: source.outstanding()[0]!.callId, output: "Accepted source result." }]);
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

for (const manual of [false, true]) test(`Round 9: foreign call echoes cannot hide malformed current results ${manual}`, async () => {
  const f = fixture(manual, { mcpTransport: "in-process" });
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
