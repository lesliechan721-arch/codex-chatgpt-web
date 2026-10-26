import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { rememberCompactionContinuation, restoreCompactionTaskMessages } from "../src/adapters/chatgpt-web/compaction-continuation";
import { chatGptTurnUserRevisionHistory, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { planContextDelivery } from "../src/adapters/chatgpt-web/context-planner";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";

const model = "chatgpt-web/high";
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };

for (const format of ["v1", "v2"] as const) {
  for (const kind of ["goal", "delegation"] as const) {
    for (const steering of [false, true]) {
      test(`${format} restores dropped ${kind} to model context, preserving later steering=${steering}`, async () => {
        const turn = `turn_${format}_${kind}_${steering}`;
        const metadata = { thread_id: `thread_${turn}`, turn_id: turn };
        const human = { type: "message", role: "user", id: "msg_human", content: [{ type: "input_text", text: "Report the goal status only." }],
          internal_chat_message_metadata_passthrough: { turn_id: "earlier", content_item_kinds: ["user.text"] } };
        const taskText = kind === "goal"
          ? '<codex_internal_context source="goal">Implement the next checked milestone.</codex_internal_context>'
          : '<codex_delegation><source_thread_id>coordinator</source_thread_id><input>Implement the next checked milestone.</input></codex_delegation>';
        const task = kind === "goal"
          ? { type: "message", role: "user", id: "msg_task", content: taskText,
            internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["goal.internal_context"] } }
          : { type: "function_call_output", id: "fco_task", name: "send_message_to_thread", namespace: "codex_app",
            output: taskText, internal_chat_message_metadata_passthrough: { turn_id: turn } };
        const body = { model, stream: false, input: [human, task],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
        const config = defaultConfig("full");
        const compactFactory = () => ({ name: "task-context-compactor", async runTurn(_p: any, _i: any, emit: any) {
          emit({ type: "text_delta", text: "The earlier status check is complete. Continue implementation.", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        } });
        const compact = format === "v1"
          ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", body: JSON.stringify(body) }), config, compactFactory)
          : await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
            body: JSON.stringify({ ...body, input: [...body.input, { type: "compaction_trigger" }] }) }), config, compactFactory);
        expect(compact.status).toBe(200);
        const result = await compact.json() as { output: Array<Record<string, unknown>> };
        // Native process_annotated_compacted_history drops goal/model context and synthetic inputs.
        const retained = result.output.filter(item => item.id !== task.id);
        const input: unknown[] = format === "v1" ? retained : [human, ...retained];
        if (steering) input.push({ type: "message", role: "user", id: "msg_new_steering", content: "Stop and report the new steering request.",
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
        input.push({ type: "function_call", call_id: "call_after_compact", name: "exec_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_after_compact", output: "LATEST_TOOL_RESULT" });
        const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
          body: JSON.stringify({ ...body, input }) }), config, () => ({ name: "model-context-observer", async runTurn(parsed: any, _i: any, emit: any) {
            const before = JSON.stringify(parsed.context.messages);
            {
              const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012");
              const match = prompt.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
              const messages = JSON.parse(match![1]!).messages;
              const tasks = messages.filter((m: any) => m.content === taskText);
              if (steering) {
                expect(tasks).toHaveLength(0);
                expect(messages.some((m: any) => m.content === "Stop and report the new steering request.")).toBe(true);
              } else {
                expect(tasks).toHaveLength(1);
                expect(tasks[0].role).toBe(kind === "goal" ? "user" : "agent_message");
                expect(messages.indexOf(tasks[0])).toBeLessThan(messages.findIndex((m: any) => m.content === "LATEST_TOOL_RESULT"));
              }
            }
            expect(JSON.stringify(parsed.context.messages)).toBe(before);
            emit({ type: "text_delta", text: "Observed model-facing context", phase: "final_answer" });
            emit({ type: "done", stopReason: "stop", endTurn: true });
          } }), { rememberState: false });
        const observed = await response.json();
        expect(response.status).toBe(200);
        expect(observed.status).toBe("completed");
      });
    }
  }
}

test("task restoration preserves repeated authenticated checkpoints and rejects changed scope/history", () => {
  const identity = { threadId: "task_restore_guards", turnId: "goal_turn" };
  const human = { type: "message", role: "user", id: "human", content: "Earlier task",
    internal_chat_message_metadata_passthrough: { turn_id: "old_turn" } };
  const task = { type: "message", role: "user", id: "goal", content: "Current native goal",
    internal_chat_message_metadata_passthrough: { turn_id: "goal_turn", content_item_kinds: ["goal.internal_context"] } };
  const source = { itemId: task.id, turnId: "goal_turn", content: task.content };
  const retained = { itemId: human.id, turnId: "old_turn", content: human.content };
  const body = { model, input: [human, task], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId }),
  } };
  const first = parseRequest(body);
  first._compactionRequest = true;
  rememberCompactionContinuation(first, identity, [source, retained], "First exact summary");
  const compacted = { type: "compaction", encrypted_content: encodeCompactionSummary("First exact summary") };
  const replay = parseRequest({ ...body, input: [human, compacted] });
  const restore = (parsed: ReturnType<typeof parseRequest>, scope = extractChatGptTurnIdentity(parsed)) =>
    restoreCompactionTaskMessages(parsed, scope, chatGptTurnUserRevisionHistory(parsed));
  expect(restore(replay).filter(m => m.content === task.content)).toHaveLength(1);
  replay._compactionRequest = true;
  // Recompaction keeps the authenticated goal as the source despite its missing raw item.
  const recoveredSource = extractChatGptCompactionSourceRevision(replay);
  expect(recoveredSource).toEqual(source);
  rememberCompactionContinuation(replay, identity, [recoveredSource, retained], "Second exact summary");
  const second = { type: "compaction", encrypted_content: encodeCompactionSummary("Second exact summary") };
  const continuation = parseRequest({ ...body, input: [human, second] });
  expect(restore(continuation).filter(m => m.content === task.content)).toHaveLength(1);
  expect(restore(continuation, { ...identity, threadId: "another_thread" })).toBe(continuation.context.messages);
  expect(restore(continuation, { ...identity, turnId: "another_turn" })).toBe(continuation.context.messages);
  const changedModel = { ...continuation, modelId: "other-model" };
  expect(restore(changedModel)).toBe(changedModel.context.messages);
  const changedEffort = { ...continuation, options: { ...continuation.options, reasoning: "low" as const } };
  expect(restore(changedEffort)).toBe(changedEffort.context.messages);
  const changedSummary = parseRequest({ ...body, input: [human, { ...second,
    encrypted_content: encodeCompactionSummary("Rewritten summary") }] });
  expect(restore(changedSummary)).toBe(changedSummary.context.messages);
  const stillPresent = parseRequest({ ...body, input: [human, second, task] });
  expect(restore(stillPresent)).toBe(stillPresent.context.messages);
  const noIdSteering = parseRequest({ ...body, input: [human, second, { type: "message", role: "user",
    content: "New instruction without item id", internal_chat_message_metadata_passthrough: { turn_id: "goal_turn" } }] });
  expect(restore(noIdSteering)).toBe(noIdSteering.context.messages);
});

test("ordinary user text that resembles a native goal is not promoted to restored task context", () => {
  const identity = { threadId: "quoted_goal_guard", turnId: "quoted_turn" };
  const item = { type: "message", role: "user", id: "quoted_goal",
    content: '<codex_internal_context source="goal">Quoted data</codex_internal_context>',
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId, content_item_kinds: ["user.text"] } };
  const body = { model, input: [item], client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    thread_id: identity.threadId, turn_id: identity.turnId,
  }) } };
  const original = parseRequest(body);
  original._compactionRequest = true;
  rememberCompactionContinuation(original, identity, [{ itemId: item.id, turnId: identity.turnId, content: item.content }], "Quoted summary");
  const replay = parseRequest({ ...body, input: [{ type: "compaction", encrypted_content: encodeCompactionSummary("Quoted summary") }] });
  expect(restoreCompactionTaskMessages(replay, identity, chatGptTurnUserRevisionHistory(replay))).toBe(replay.context.messages);
});

for (const format of ["v1", "v2"] as const) {
  test(`${format} equal historical user text cannot replace the current restored goal`, () => {
    const identity = { thread_id: `equal_goal_${format}`, turn_id: "current_goal_turn" };
    const text = "Continue the current regression repair.";
    const human = { type: "message", role: "user", id: "earlier_human", content: text,
      internal_chat_message_metadata_passthrough: { turn_id: "earlier_turn" } };
    const goal = { ...human, id: "current_goal", internal_chat_message_metadata_passthrough: {
      turn_id: identity.turn_id, content_item_kinds: ["goal.internal_context"],
    } };
    const parse = (input: unknown[]) => parseRequest({ model: "gpt-5.6-sol", input,
      instructions: "Preserve the current task rule.\n".repeat(500),
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) } });
    const original = parse([human, goal]);
    original._compactionRequest = true;
    const summary = `Exact equal-text ${format} goal checkpoint`;
    rememberCompactionContinuation(original, extractChatGptTurnIdentity(original), [
      extractChatGptCompactionSourceRevision(original), { itemId: human.id, turnId: "earlier_turn", content: text },
    ], summary);
    const checkpoint = format === "v1" ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }
      : { type: "compaction", encrypted_content: encodeCompactionSummary(summary) };
    const toolText = "EQUAL_GOAL_RESULT ".repeat(1200);
    for (const steering of [false, true]) {
      const resumed = parse([human, checkpoint, ...(steering ? [{ ...human, id: "new_steering",
        internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } }] : []),
      { type: "function_call", call_id: "equal_goal_call", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "equal_goal_call", output: toolText }]);
      const before = structuredClone(resumed);
      const restore = (parsed: ReturnType<typeof parse>) => restoreCompactionTaskMessages(parsed,
        extractChatGptTurnIdentity(parsed), chatGptTurnUserRevisionHistory(parsed));
      const restored = restore(resumed);
      expect(restored).toHaveLength(resumed.context.messages.length + (steering ? 0 : 1));
      expect(restored[2]!.content).toBe(text);
      const materialized = { ...resumed, context: { ...resumed.context, messages: restored } };
      expect(restore(materialized)).toBe(restored);
      for (let attempt = 0; attempt < 2; attempt++) {
        const candidate = attempt === 0 ? resumed : materialized;
        const messageIndices = steering ? [0, 1, 2, 3, 4] : [0, 1, null, 2, 3];
        const compiled = compileChatGptWebPrompt(candidate, capabilities, "turn_12345678901234567890123456789012");
        const payload = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!);
        expect(payload.messages.filter((message: any) => message.content === text)).toHaveLength(2);
        expect(payload.messages[2]!.content).toBe(text);
        const plan = planContextDelivery({ canonical: resumed, candidate, ...(attempt ? { messageIndices } : {}),
          snapshot: createContextSnapshot(resumed), capabilities,
          contextToolsAvailable: true, turnToken: "turn_12345678901234567890123456789012" });
        expect(plan.navigationEnabled).toBe(true);
        const bootstrap = plan.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!;
        const delivered = JSON.parse(plan.snapshot.getText(bootstrap.read_ref!)!);
        expect(delivered.payload.messages.filter((message: any) => message.content === text)).toHaveLength(2);
        expect(delivered.payload.messages[2]!.content).toBe(text);
        const mapping = plan.snapshot.targets.find(target => target.origin === "context_source_map")!;
        const sourceMap = JSON.parse(plan.snapshot.getText(mapping.read_ref!)!);
        expect(sourceMap.candidate_message_sources).toEqual(messageIndices);
        const result = delivered.external_positions.find((position: any) => position.original_role === "toolResult");
        expect(result.path).toEqual(["messages", 4, "content"]);
        expect(plan.snapshot.getText(result.read_ref)).toBe(toolText);
      }
      expect(resumed).toEqual(before);
    }
  });
}

for (const format of ["v1", "v2"] as const) for (const kind of ["goal", "delegation"] as const) {
  test(`${format} ${kind} restoration keeps short-start source positions and optional results exact`, () => {
    const identity = { thread_id: `mapped_${format}_${kind}`, turn_id: "mapped_current" };
    const human = { type: "message", role: "user", id: "mapped_human", content: "Check prior task status.",
      internal_chat_message_metadata_passthrough: { turn_id: "mapped_old" } };
    const text = kind === "goal" ? '<codex_internal_context source="goal">Continue the measured repair.</codex_internal_context>'
      : '<codex_delegation><source_thread_id>mapped_parent</source_thread_id><input>Continue the measured repair.</input></codex_delegation>';
    const task = kind === "goal" ? { type: "message", role: "user", id: "mapped_goal", content: text,
      internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id, content_item_kinds: ["goal.internal_context"] } }
      : { type: "function_call_output", id: "mapped_delegation", name: "send_message_to_thread", namespace: "codex_app", output: text,
        internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } };
    const parse = (input: unknown[]) => parseRequest({ model: "gpt-5.6-sol", instructions: "Preserve the current task rule.\n".repeat(500), input,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(identity) } });
    const original = parse([human, task]);
    original._compactionRequest = true;
    const summary = `Mapped ${format} ${kind} checkpoint`;
    rememberCompactionContinuation(original, extractChatGptTurnIdentity(original), [
      extractChatGptCompactionSourceRevision(original), { itemId: human.id, turnId: "mapped_old", content: human.content },
    ], summary);
    const checkpoint = format === "v1" ? { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summary}` }
      : { type: "compaction", encrypted_content: encodeCompactionSummary(summary) };
    const toolText = "OPTIONAL_MAPPED_RESULT ".repeat(1200);
    for (const steering of [false, true]) {
      const resumed = parse([human, checkpoint, ...(steering ? [{ ...human, id: "mapped_steering",
        internal_chat_message_metadata_passthrough: { turn_id: identity.turn_id } }] : []),
      { type: "function_call", call_id: "mapped_call", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "mapped_call", output: toolText }]);
      const before = structuredClone(resumed);
      const plan = planContextDelivery({ canonical: resumed, candidate: resumed, snapshot: createContextSnapshot(resumed), capabilities,
        contextToolsAvailable: true, turnToken: "turn_12345678901234567890123456789012",
        compileOptions: { includeContextTokenBreakdown: true } });
      expect(plan.navigationEnabled).toBe(true);
      const target = plan.snapshot.targets.find(item => item.origin === "context_bootstrap_payload")!;
      const delivered = JSON.parse(plan.snapshot.getText(target.read_ref!)!);
      const mapping = plan.snapshot.targets.find(item => item.origin === "context_source_map")!;
      const sourceMap = JSON.parse(plan.snapshot.getText(mapping.read_ref!)!);
      const expectedSources: Array<number | null> = resumed.context.messages.map((_, index) => index);
      if (!steering) expectedSources.splice(2, 0, null);
      expect(sourceMap.candidate_message_sources).toEqual(expectedSources);
      const tasks = delivered.payload.messages.filter((item: any) => item?.content === text);
      expect(tasks).toHaveLength(steering ? 0 : 1);
      const resultPosition = delivered.external_positions.find((position: any) => position.original_role === "toolResult");
      expect(resultPosition).toBeDefined();
      const resultIndex = resumed.context.messages.findIndex(item => item.role === "toolResult");
      expect(resultPosition.path).toEqual(["messages", resultIndex + (steering ? 0 : 1), "content"]);
      expect(plan.snapshot.getText(resultPosition.read_ref)).toBe(toolText);
      expect(delivered.payload.messages[resultPosition.path[1]].content).toBeNull();
      expect(plan.compiled.contextTokenBreakdown!.tool_result!.tokens).toBeLessThan(100);
      expect(resumed).toEqual(before);
    }
  });
}
