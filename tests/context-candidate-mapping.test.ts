import { describe, expect, test } from "bun:test";
import type { CodexParsedRequest } from "../src/types";
import { parseRequest } from "../src/responses/parser";
import { bindContextFullCandidate, bindContextInstructionInputSource, contextCandidateMessageIndices,
  contextCandidateCanonicalSource, contextCandidateRawInputIndices, contextCandidateRestoredMessageIndices, contextCandidateSourceProvenance,
  continuityAcceptedContextCandidate,
  continuityContextCandidate, continuityRecoveredContextCandidate } from "../src/adapters/chatgpt-web/context-candidate-mapping";
import { continuityCurrentEnvironmentInput, continuityCurrentInstructionInput } from "../src/adapters/chatgpt-web/environment";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { preflightFullRecoveryContinuityInput } from "../src/adapters/chatgpt-web/continuity-input";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

const previous = { instructionIdentity: "previous", nativeTurnId: "prior" };
const instruction = (id: string, turnId: string, content: unknown) => ({
  type: "message", role: "user", id, content,
  internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.input"] },
});
function request(input: unknown[], metadata: Record<string, unknown> = {}): CodexParsedRequest {
  const parsed = parseRequest({ model: "gpt-6", instructions: "Base instructions.", input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread", turn_id: "current", request_kind: "turn", ...metadata,
    }) } });
  parsed._conversationPolicy = "continuity-first";
  return parsed;
}
function candidate(parsed: CodexParsedRequest, prior: typeof previous | undefined = previous): CodexParsedRequest {
  const suffix = continuityCurrentInstructionInput(parsed, prior);
  return continuityContextCandidate(parsed, [...continuityCurrentEnvironmentInput(parsed, suffix), ...suffix]);
}
function recovered(parsed: CodexParsedRequest, results: unknown[] = []): CodexParsedRequest {
  const result = structuredClone(parsed);
  (result._rawBody as { input: unknown[] }).input.push(...structuredClone(results));
  result.context.messages.push(...parseRequest({ model: parsed.modelId, input: results }).context.messages);
  result.context.systemPrompt = [...result.context.systemPrompt ?? [], "Trusted recovery status."];
  return result;
}

describe("continuity candidate source mapping", () => {
  test("identical instruction text selects the actual newer native input, including cached selection", () => {
    const parsed = request([
      instruction("previous", "prior", "Repeated instruction."),
      instruction("current", "current", "Repeated instruction."),
    ]);
    const original = structuredClone(parsed.context);
    const first = candidate(parsed);
    const cached = candidate(parsed);
    expect(first.context.messages).toHaveLength(1);
    expect(contextCandidateMessageIndices(parsed, first)).toEqual([1]);
    expect(contextCandidateMessageIndices(parsed, cached)).toEqual([1]);
    expect(first.context.messages[0]).not.toBe(parsed.context.messages[1]);
    expect(parsed.context).toEqual(original);
  });

  test("original prefix parsing accounts for merged adjacent calls and omitted raw items", () => {
    const parsed = request([
      { role: "system", content: "Persistent system." },
      { type: "additional_tools", tools: [] },
      { role: "developer", content: "Persistent developer.",
        internal_chat_message_metadata_passthrough: { turn_id: "prior", content_item_kinds: ["generic.developer_instructions"] } },
      instruction("previous", "prior", "Repeated instruction."),
      { type: "function_call", call_id: "duplicate", name: "exec", arguments: "{}" },
      { type: "function_call", call_id: "duplicate", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "duplicate", output: "Repeated result." },
      { type: "function_call_output", call_id: "duplicate", output: "Repeated result." },
      instruction("current", "current", "Repeated instruction."),
    ]);
    const selected = candidate(parsed);
    expect(parsed.context.messages).toHaveLength(6);
    expect(contextCandidateMessageIndices(parsed, selected)).toEqual([0, 5]);
    expect(contextCandidateRawInputIndices(parsed, selected)).toEqual([0, 2, 8]);
    expect(selected.context.systemPrompt).toEqual(["Base instructions.", "Persistent system."]);
    expect(selected.context.messages.map(message => message.role)).toEqual(["developer", "user"]);
  });

  test("the current image retains a canonical source and reconstructed environment text is synthetic", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=", detail: "high" };
    const environment = { type: "message", role: "user", id: "environment", content: [
      { type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" },
    ], internal_chat_message_metadata_passthrough: { turn_id: "current", content_item_kinds: ["environments.environment_context"] } };
    const parsed = request([
      instruction("previous", "prior", "Old task."), environment,
      instruction("current", "current", [{ type: "input_text", text: "Use this image." }, image]),
    ]);
    const selected = candidate(parsed);
    expect(contextCandidateMessageIndices(parsed, selected)).toEqual([null, 2]);
    expect(contextCandidateRawInputIndices(parsed, selected)).toEqual([2]);
    expect(selected.context.messages[0]!.content).toContain("<environment_context>");
    expect(selected.context.messages[1]!.content).toEqual([
      { type: "text", text: "Use this image." }, { type: "image", imageUrl: image.image_url, detail: "high" },
    ]);
  });

  test("a delegated current instruction maps to its exact agent message source", () => {
    const parsed = request([
      { type: "agent_message", id: "delegated", author: "/root", recipient: "/root/child", content: "Current delegated task.",
        internal_chat_message_metadata_passthrough: { turn_id: "current" } },
    ], { parent_thread_id: "parent", agent_name: "/root/child", subagent_kind: "thread_spawn" });
    const selected = candidate(parsed, undefined);
    expect(contextCandidateMessageIndices(parsed, selected)).toEqual([0]);
    expect(selected.context.messages[0]!.role).toBe("agentMessage");
  });

  test("the existing strict desktop delegation maps exactly without admitting general tool results", () => {
    const delegated = { type: "function_call_output", id: "delegated", name: "send_message_to_thread", namespace: "codex_app",
      output: "<codex_delegation><source_thread_id>parent</source_thread_id><input>Current delegated task.</input></codex_delegation>",
      internal_chat_message_metadata_passthrough: { turn_id: "current" } };
    const parsed = request([delegated]);
    const selected = candidate(parsed, undefined);
    expect(contextCandidateMessageIndices(parsed, selected)).toEqual([0]);
    expect(contextCandidateRawInputIndices(parsed, selected)).toEqual([0]);
    expect(selected.context.messages[0]!.role).toBe("toolResult");
    const ordinary = request([{ type: "function_call_output", call_id: "call", output: "Ordinary tool result." }]);
    const item = structuredClone((ordinary._rawBody as { input: unknown[] }).input[0]);
    bindContextInstructionInputSource(ordinary, item, 0);
    expect(() => continuityContextCandidate(ordinary, [item])).toThrow("exact canonical message source");
  });

  test("an initial full control retry binds a complete clone by exact original positions", () => {
    const parsed = request([
      { role: "system", content: [{ type: "input_text", text: "System instruction." },
        { type: "input_image", image_url: "data:image/png;base64,c3lzdGVt" }] },
      instruction("previous", "prior", "Same instruction."), instruction("current", "current", "Same instruction."),
    ]);
    const clone = bindContextFullCandidate(parsed, structuredClone(parsed));
    expect(contextCandidateMessageIndices(parsed, clone)).toEqual([0, 1]);
    expect(contextCandidateRawInputIndices(parsed, clone)).toEqual([0, 1, 2]);
    (clone._rawBody as any).input[0].content[1].image_url = "data:image/png;base64,ZGlmZmVyZW50";
    expect(contextCandidateRawInputIndices(parsed, clone)).toBeUndefined();
    const reordered = structuredClone(parsed);
    (reordered._rawBody as { input: unknown[] }).input.reverse();
    expect(() => bindContextFullCandidate(parsed, reordered)).toThrow("exact canonical message source");
    const changedImage = structuredClone(parsed);
    (changedImage._rawBody as any).input[0].content[1].image_url = "data:image/png;base64,ZGlmZmVyZW50";
    expect(() => bindContextFullCandidate(parsed, changedImage)).toThrow("exact canonical message source");
  });

  test("an initial retry binds the trusted accepted source and preserves the new HTTP request", () => {
    const accepted = request([instruction("previous", "prior", "Original history."), instruction("current", "current", "Current task.")]);
    const retry = request([instruction("current", "current", "Current task.")]);
    const originalRetry = structuredClone(retry);
    const selected = continuityAcceptedContextCandidate(retry, accepted);
    const canonical = contextCandidateCanonicalSource(retry, selected);
    expect(canonical).toBe(accepted);
    expect(contextCandidateMessageIndices(canonical!, selected)).toEqual([0, 1]);
    expect(contextCandidateRawInputIndices(canonical!, selected)).toEqual([0, 1]);
    expect(contextCandidateMessageIndices(retry, selected)).toBeUndefined();
    expect(contextCandidateCanonicalSource(structuredClone(retry), selected)).toBeUndefined();
    expect(contextCandidateCanonicalSource(retry, structuredClone(selected))).toBeUndefined();
    expect(contextCandidateCanonicalSource(retry, candidate(retry, undefined))).toBeUndefined();
    expect(selected.context.messages[0]!.content).toBe("Original history.");
    expect(retry).toEqual(originalRetry);
  });

  test("a verified recovered return enters the source while its appended status remains candidate text", () => {
    const parsed = request([instruction("current", "current", [{ type: "input_text", text: "Current image task." },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }])]);
    const original = structuredClone(parsed);
    const selected = continuityRecoveredContextCandidate(parsed, recovered(parsed, [
      { type: "function_call_output", call_id: "actual", output: "Real completed return." },
    ]));
    const canonical = contextCandidateCanonicalSource(parsed, selected)!;
    expect(canonical).not.toBe(parsed);
    expect(canonical.context.systemPrompt).toEqual(parsed.context.systemPrompt);
    expect(selected.context.systemPrompt!.at(-1)).toBe("Trusted recovery status.");
    expect(canonical.context.messages[1]!.content).toBe("Real completed return.");
    expect(contextCandidateMessageIndices(canonical, selected)).toEqual([0, 1]);
    expect(contextCandidateRawInputIndices(canonical, selected)).toEqual([0, 1]);
    expect(contextCandidateRestoredMessageIndices(canonical, selected)).toEqual([1]);
    expect(contextCandidateRestoredMessageIndices(parsed, selected)).toBeUndefined();
    expect(contextCandidateMessageIndices(parsed, selected)).toBeUndefined();
    expect(contextCandidateCanonicalSource(structuredClone(parsed), selected)).toBeUndefined();
    expect(parsed).toEqual(original);
  });

  test("actual retained parameters enter their source positions without changing the replay candidate", () => {
    const result = { type: "function_call_output", call_id: "actual", output: "Real return." };
    const customResult = { type: "custom_tool_call_output", call_id: "custom", output: "Real custom return." };
    const parsed = request([instruction("current", "current", "Current task."), result, customResult]);
    const selected = recovered(parsed);
    const originalCandidate = structuredClone(selected);
    continuityRecoveredContextCandidate(parsed, selected, [
      (parsed._rawBody as { input: unknown[] }).input[0],
      { type: "function_call", call_id: "actual", name: "exec", arguments: '{"command":"echo real"}' }, result,
      { type: "custom_tool_call", call_id: "custom", name: "patch", input: "Actual patch input." }, customResult,
    ]);
    const canonical = contextCandidateCanonicalSource(parsed, selected)!;
    expect(contextCandidateMessageIndices(canonical, selected)).toEqual([0, 2, 4]);
    expect(contextCandidateRawInputIndices(canonical, selected)).toEqual([0, 2, 4]);
    expect(contextCandidateRestoredMessageIndices(canonical, selected)).toEqual([1, 3]);
    expect(canonical.context.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult"]);
    expect(canonical.context.messages[1]!.content).toEqual([
      { type: "toolCall", id: "actual", name: "exec", arguments: { command: "echo real" } },
    ]);
    expect(canonical.context.messages[3]!.content).toEqual([
      { type: "toolCall", id: "custom", name: "patch", arguments: { input: "Actual patch input." } },
    ]);
    expect(selected).toEqual(originalCandidate);
    const provenanceByMessage = contextCandidateSourceProvenance(canonical, selected)!;
    expect(provenanceByMessage.get(1)).toEqual({ restored: true, tool_arguments_encoding: "deterministic-json" });
    expect(provenanceByMessage.get(3)).toEqual({ restored: true });
    const snapshot = createContextSnapshot(canonical, { provenanceByMessage });
    expect(snapshot.targets.filter(target => target.kind === "tool_arguments").map(target => target.provenance)).toEqual([
      "verified_restoration", "verified_restoration",
    ]);
    expect(snapshot.targets.filter(target => target.kind === "tool_result").map(target => target.provenance)).toEqual([
      "verified_raw", "verified_raw",
    ]);
    expect(snapshot.targets.filter(target => target.kind === "tool_arguments").every(target => target.read_ref !== null)).toBe(true);
    expect(snapshot.targets.filter(target => target.kind === "tool_arguments").map(target => target.encoding)).toEqual([
      "deterministic-json", "utf-8",
    ]);
    (canonical._rawBody as any).input[1].arguments = '{"command":"changed"}';
    expect(contextCandidateCanonicalSource(parsed, selected)).toBeUndefined();
    expect(contextCandidateRestoredMessageIndices(canonical, selected)).toBeUndefined();
  });

  test("a saved accepted recovery retry preserves the original source and does not promote status", () => {
    const parsed = request([instruction("current", "current", "Current task.")]);
    const selected = continuityRecoveredContextCandidate(parsed, recovered(parsed));
    const canonical = contextCandidateCanonicalSource(parsed, selected)!;
    const saved = continuityAcceptedContextCandidate(parsed, selected);
    const retry = request([instruction("current", "current", "Current task.")]);
    const retried = continuityAcceptedContextCandidate(retry, saved);
    expect(contextCandidateCanonicalSource(retry, retried)).toBe(canonical);
    expect(contextCandidateMessageIndices(canonical, retried)).toEqual([0]);
    expect(contextCandidateRestoredMessageIndices(canonical, retried)).toEqual([]);
    expect(canonical.context.systemPrompt).toEqual(["Base instructions."]);
    expect(retried.context.systemPrompt).toEqual(["Base instructions.", "Trusted recovery status."]);
    expect(contextCandidateCanonicalSource(parsed, retried)).toBeUndefined();
  });

  test("restored object parameters do not change the encoding of HTTP-supplied calls", () => {
    const supplied = { type: "function_call", call_id: "supplied", name: "exec", arguments: ' { "z": 1, "a": 2 } ' };
    const result = { type: "function_call_output", call_id: "restored", output: "Actual return." };
    const parsed = request([instruction("current", "current", "Current task."), supplied, result]);
    const selected = continuityRecoveredContextCandidate(parsed, recovered(parsed), [
      (parsed._rawBody as { input: unknown[] }).input[0], supplied,
      { type: "function_call", call_id: "restored", name: "exec", arguments: '{"z":1,"a":2}' }, result,
    ]);
    const canonical = contextCandidateCanonicalSource(parsed, selected)!;
    const snapshot = createContextSnapshot(canonical, { provenanceByMessage: contextCandidateSourceProvenance(canonical, selected) });
    const calls = snapshot.targets.filter(target => target.kind === "tool_arguments");
    expect(calls.map(target => target.encoding)).toEqual(["utf-8", "deterministic-json"]);
    expect(calls.map(target => target.provenance)).toEqual(["verified_raw", "verified_restoration"]);
    expect(calls.map(target => snapshot.getText(target.read_ref!))).toEqual([supplied.arguments, '{"a":2,"z":1}']);
    expect(contextCandidateRestoredMessageIndices(canonical, selected)).toEqual([2]);
  });

  test("retained active task text returns to the full candidate at its exact identity anchor", () => {
    const old = instruction("previous", "prior", "Repeated task text.");
    const current = instruction("current", "current", "Repeated task text.");
    const parsed = request([current]);
    const original = structuredClone(parsed);
    const selected = continuityRecoveredContextCandidate(parsed, recovered(parsed), undefined, [old, current]);
    const canonical = contextCandidateCanonicalSource(parsed, selected)!;
    expect(selected.context.messages.map(message => message.content)).toEqual(["Repeated task text.", "Repeated task text."]);
    expect(contextCandidateMessageIndices(canonical, selected)).toEqual([0, 1]);
    expect(contextCandidateRawInputIndices(canonical, selected)).toEqual([0, 1]);
    expect(contextCandidateRestoredMessageIndices(canonical, selected)).toEqual([0]);
    expect((selected._rawBody as { input: unknown[] }).input).toEqual([old, current]);
    expect(selected.context.systemPrompt!.at(-1)).toBe("Trusted recovery status.");
    expect(canonical.context.systemPrompt).toEqual(["Base instructions."]);
    expect(parsed).toEqual(original);
    const retried = continuityAcceptedContextCandidate(parsed, selected);
    expect(contextCandidateMessageIndices(canonical, retried)).toEqual([0, 1]);
    expect(contextCandidateSourceProvenance(canonical, retried)?.get(0)).toEqual({ restored: true });
  });

  test("retained identity conflicts, duplicates and reordered anchors cannot supply source text", () => {
    const current = instruction("current", "current", "Current task.");
    const later = instruction("later", "current", "Later constraint.");
    const parsed = request([current, later]);
    expect(() => continuityRecoveredContextCandidate(parsed, recovered(parsed), undefined,
      [{ ...current, content: "Changed source task." }, later])).toThrow("exact canonical message source");
    expect(() => continuityRecoveredContextCandidate(parsed, recovered(parsed), undefined,
      [current, current, later])).toThrow("exact canonical message source");
    expect(() => continuityRecoveredContextCandidate(parsed, recovered(parsed), undefined,
      [later, current])).toThrow("exact canonical message source");
  });

  test("retained task text cannot be moved across calls merged into one canonical message", () => {
    const first = { type: "function_call", call_id: "first", name: "exec", arguments: "{}" };
    const second = { type: "function_call", call_id: "second", name: "exec", arguments: "{}" };
    const current = instruction("current", "current", "Current task.");
    const parsed = request([first, second, current]);
    const selected = recovered(parsed);
    const original = structuredClone(selected);
    expect(parsed.context.messages).toHaveLength(2);
    expect(() => continuityRecoveredContextCandidate(parsed, selected, undefined,
      [first, instruction("previous", "prior", "Task between the actual calls."), second, current]))
      .toThrow("exact canonical message source");
    expect(selected).toEqual(original);
  });

  test("full recovery capacity includes task text restored from the retained page", () => {
    const current = instruction("current", "current", "Current task.");
    const parsed = request([current]);
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const selected = continuityRecoveredContextCandidate(parsed, recovered(parsed), undefined,
      [instruction("previous", "prior", "Original active task. ".repeat(60_000)), current]);
    expect(selected.context.messages).toHaveLength(2);
    expect(() => preflightFullRecoveryContinuityInput(selected, {
      localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false,
    })).toThrow("original single-input boundary");
    expect((parsed._rawBody as { input: unknown[] }).input).toHaveLength(1);
  });

  test("recovery binding rejects changed original source, fabricated instructions and ambiguous call returns", () => {
    const result = { type: "function_call_output", call_id: "actual", output: "Real return." };
    const parsed = request([instruction("current", "current", "Current task."), result]);
    const changed = recovered(parsed);
    changed.context.messages[0]!.content = "Changed original task.";
    expect(() => continuityRecoveredContextCandidate(parsed, changed)).toThrow("exact canonical message source");
    expect(() => continuityRecoveredContextCandidate(parsed, recovered(parsed, [
      { role: "user", content: "Fabricated recovery task." },
    ]))).toThrow("exact canonical message source");
    const sourceRaw = (parsed._rawBody as { input: unknown[] }).input;
    expect(() => continuityRecoveredContextCandidate(parsed, recovered(parsed), [sourceRaw[0],
      { type: "function_call", call_id: "wrong", name: "exec", arguments: "{}" }, result,
    ])).toThrow("exact canonical message source");
    const ambiguous = request([...sourceRaw, result]);
    expect(() => continuityRecoveredContextCandidate(ambiguous, recovered(ambiguous), [sourceRaw[0],
      { type: "function_call", call_id: "actual", name: "exec", arguments: "{}" }, result, result,
    ])).toThrow("exact canonical message source");
  });

  test("selected system image provenance is invalid after raw input or system prompt changes", () => {
    const parsed = request([
      { role: "system", content: [{ type: "input_text", text: "System instruction." },
        { type: "input_image", image_url: "data:image/png;base64,c3lzdGVt" }] },
      instruction("previous", "prior", "Old task."), instruction("current", "current", "Current task."),
    ]);
    const selected = candidate(parsed);
    expect(contextCandidateRawInputIndices(parsed, selected)).toEqual([0, 2]);
    selected.context.systemPrompt!.push("Changed system instruction.");
    expect(contextCandidateRawInputIndices(parsed, selected)).toBeUndefined();
    const fresh = candidate(parsed);
    (parsed._rawBody as any).input[0].content[1].image_url = "data:image/png;base64,ZGlmZmVyZW50";
    expect(contextCandidateRawInputIndices(parsed, fresh)).toBeUndefined();
  });

  test("bindings reject another canonical request, copied candidates and unregistered equal input", () => {
    const parsed = request([instruction("previous", "prior", "Old task."), instruction("current", "current", "Current task.")]);
    const selected = candidate(parsed);
    const other = parseRequest(parsed._rawBody);
    other._conversationPolicy = "continuity-first";
    expect(contextCandidateMessageIndices(other, selected)).toBeUndefined();
    expect(contextCandidateRawInputIndices(other, selected)).toBeUndefined();
    expect(contextCandidateMessageIndices(parsed, structuredClone(selected))).toBeUndefined();
    expect(contextCandidateRawInputIndices(parsed, structuredClone(selected))).toBeUndefined();
    const suffix = continuityCurrentInstructionInput(parsed, previous);
    expect(() => continuityContextCandidate(other, suffix)).toThrow("exact canonical message source");
    expect(() => continuityContextCandidate(parsed, structuredClone(suffix))).toThrow("exact canonical message source");
  });

  test("a selected input must match the canonical message at the proved position", () => {
    const parsed = request([instruction("previous", "prior", "Old task."), instruction("current", "current", "Current task.")]);
    const suffix = continuityCurrentInstructionInput(parsed, previous);
    const modified = suffix[0] as { content: string };
    modified.content = "Changed after selection.";
    expect(() => continuityContextCandidate(parsed, suffix)).toThrow("exact canonical message source");
    const fresh = continuityCurrentInstructionInput(parsed, previous);
    parsed.context.messages[1]!.content = "A different parsed message.";
    expect(() => continuityContextCandidate(parsed, fresh)).toThrow("exact canonical message source");
  });

  test("canonical positions and candidate contents cannot change after binding", () => {
    const parsed = request([instruction("previous", "prior", "Same task."), instruction("current", "current", "Same task.")]);
    const selected = candidate(parsed);
    expect(contextCandidateMessageIndices(parsed, selected)).toEqual([1]);
    parsed.context.messages.reverse();
    expect(contextCandidateMessageIndices(parsed, selected)).toBeUndefined();
    expect(contextCandidateRawInputIndices(parsed, selected)).toBeUndefined();
    parsed.context.messages.reverse();
    selected.context.messages[0]!.content = "Changed task.";
    expect(contextCandidateMessageIndices(parsed, selected)).toBeUndefined();
  });

  test("removing selected raw source items invalidates getters without throwing", () => {
    const parsed = request([instruction("previous", "prior", "Old task."), instruction("current", "current", "Current task.")]);
    const selected = candidate(parsed);
    (parsed._rawBody as { input: unknown[] }).input.pop();
    expect(contextCandidateMessageIndices(parsed, selected)).toBeUndefined();
    expect(contextCandidateRawInputIndices(parsed, selected)).toBeUndefined();
  });
});
