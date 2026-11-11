import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createSessionContinuityFixtures, recordedCall } from "./helpers/session-continuity-fixture";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { LATEST_USER_PROMPT_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { encodeCompactionSummary } from "../src/responses/compaction";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);
const thread = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const turns = ["01a06c66-4380-75c6-a0df-318f890ef6de", "01a06c66-4381-75c6-a0df-318f890ef6de", "01a06c66-4382-75c6-a0df-318f890ef6de"];
type Item = Record<string, any>;
type Fixture = ReturnType<typeof fixture>;
const home = (root: string) => join(root, "codex");
const rolloutPath = (root: string) => join(home(root), "sessions", "2026", "11", "11", `rollout-2026-11-11T10-00-00-${thread}.jsonl`);
const boundary = (turn: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const context = (root: string, turn: string) => ({ type: "turn_context", payload: { turn_id: turn, cwd: home(root), workspace_roots: [home(root)],
  sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } });
const writeRollout = (root: string, records: Item[]) => {
  const path = rolloutPath(root); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map(item => JSON.stringify(item)).join("\n") + "\n");
};
const installed = (human: Item | undefined, summary: string): Item[] => [
  ...(human ? [human] : []), { type: "compaction", encrypted_content: encodeCompactionSummary(summary) },
];
const compacted = (turn: string, history: Item[]) => ({ type: "compacted", payload: {
  replacement_history: structuredClone(history), resume_metadata: { last_started_turn_id: turn },
} });

function createFixture(root: string, launcherInstance: any, cleanupMode: "backend-exit" | "release-page" = "release-page") {
  const f = fixture(false, { root, threadId: thread, launcherInstance, cleanupMode, codexHome: home(root) });
  f.provider.chatgptWeb!.toolAuthorityMode = "verified-environment";
  return f;
}
function request(f: Fixture, turn: string, input: Item[], phase?: "mid_turn" | "pre_turn") {
  const parsed = f.request("", turn, input);
  const raw = parsed._rawBody as { client_metadata: Record<string, string> };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: thread, turn_id: turn,
    request_kind: phase ? "compaction" : "turn", sandbox_mode: "danger-full-access", workspaces: { [home(f.root)]: {} },
    ...(phase ? { compaction: { trigger: "auto", phase, implementation: "responses", strategy: "memento" } } : {}) });
  if (phase) parsed._compactionRequest = true;
  bindContinuityRequestScope(parsed, chatGptWebExecutionNamespace(f.provider));
  parsed._continuityStateDirectory = f.statePath;
  return parsed;
}
function summary(events: Awaited<ReturnType<Fixture["run"]>>) {
  const delta = events.findLast(event => event.type === "text_delta" && event.text.includes(`\n${LATEST_USER_PROMPT_MARKER}\n`));
  if (delta?.type !== "text_delta") throw new Error("The native goal checkpoint has no summary");
  expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  return delta.text;
}

function laterInstruction(kind: string, turn: string): Item {
  if (kind === "delegation") return { type: "function_call_output", id: "new-delegation", name: "send_message_to_thread", namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>parent-thread</source_thread_id><input>Replace the previous task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: turn } };
  if (kind === "mixed human" || kind === "mixed image") return { type: "message", role: "user", id: `new-${kind}`, content: [
    { type: "input_text", text: "<environment_context><current_date>2026-11-11</current_date></environment_context>" },
    kind === "mixed human" ? { type: "input_text", text: "Replace the previous task beside the environment fragment." }
      : { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxWQAAAAASUVORK5CYII=" },
  ], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["environments.environment_context", kind === "mixed human" ? "user.text" : "user.image"] } };
  return { type: "message", role: "user", id: `new-${kind}`, content: [{ type: "input_text", text: {
    human: "Replace the previous task.",
    "goal context": '<codex_internal_context source="goal">Continue the new native task.</codex_internal_context>',
    edit: '<codex_internal_context source="user_goal">User set the goal: inspect only.</codex_internal_context>',
    clear: '<codex_internal_context source="user_goal">User cleared the goal.</codex_internal_context>',
  }[kind] }], internal_chat_message_metadata_passthrough: {
    turn_id: kind === "edit" || kind === "clear" ? "auto-compact-4" : turn,
    content_item_kinds: [{ human: "user.text", "goal context": "goal.internal_context", edit: "user.goal.omitted", clear: "user.goal" }[kind]],
  } };
}

function contextAndOutputs(turn: string): Item[] {
  const user = (id: string, kind: string, text: string) => ({ type: "message", role: "user", id,
    content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] } });
  const contexts = [user("native-agents", "agents_md.instructions", "# AGENTS.md instructions\nUse the repository rules."),
    user("native-skill", "skills.selected_skill_instructions", "Use the selected skill as task context."),
    user("native-environment", "environments.environment_context", "<environment_context><current_date>2026-11-11</current_date></environment_context>")];
  return [...contexts, { type: "message", role: "user", id: "native-context-group", content: contexts.flatMap(item => item.content),
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: contexts.flatMap(item => item.internal_chat_message_metadata_passthrough.content_item_kinds) } },
    { type: "agent_message", id: "native-child-report", author: "/root/child", recipient: "/root", content: "The child reported its result.",
      internal_chat_message_metadata_passthrough: { turn_id: turn } },
    { type: "message", role: "assistant", id: "native-answer", content: [{ type: "output_text", text: "Earlier command completed." }] },
    { type: "function_call_output", call_id: "ordinary-call", output: "Ordinary command output." }];
}

test.skipIf(!process.env.NATIVE_UUID_GOAL_ROOT)("UUID goal recovery child seed", async () => {
  const root = process.env.NATIVE_UUID_GOAL_ROOT!, kind = process.env.NATIVE_UUID_GOAL_KIND!;
  const f = createFixture(root, JSON.parse(process.env.NATIVE_UUID_GOAL_LAUNCHER!), "backend-exit");
  const human: Item | undefined = kind === "pure" ? undefined : { type: "message", role: "user", id: "native-human",
    content: [{ type: "input_text", text: "Continue the accepted task." }],
    internal_chat_message_metadata_passthrough: { turn_id: turns[0], content_item_kinds: ["user.text"] } };
  const goal: Item = { type: "message", role: "user", id: "native-goal",
    content: [{ type: "input_text", text: kind === "edit"
      ? '<codex_internal_context source="user_goal">User set the goal: inspect only.</codex_internal_context>'
      : '<codex_internal_context source="goal">Continue the current goal.</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: kind === "pure" ? turns[0] : "auto-compact-3",
      content_item_kinds: [kind === "pure" ? "goal.internal_context" : kind === "edit" ? "user.goal.omitted" : "user.goal"] } };
  if (kind === "clear") goal.content[0].text = '<codex_internal_context source="user_goal">User cleared the goal.</codex_internal_context>';
  const input = [...(human ? [human] : []), goal];
  const records = [{ type: "session_meta", payload: { id: thread, source: "vscode" } }, boundary(turns[0]), context(root, turns[0]),
    ...input.map(payload => ({ type: "response_item", payload: structuredClone(payload) }))];
  writeRollout(root, records);
  const source = request(f, turns[0], input);
  f.controls.invokeSourceTools = true;
  await f.run(source);
  const session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(source)}`)!;
  const call = session.outstanding()[0]!;
  const text = summary(await f.run(request(f, turns[0], [...input, recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Accepted native goal result." }], "mid_turn")));
  const history = installed(human, text);
  records.push(compacted(turns[0], history), context(root, turns[0]));
  writeRollout(root, records);
  f.controls.invokeSourceTools = false;
  await f.run(request(f, turns[0], history));
  writeFileSync(join(root, "seed.json"), JSON.stringify({ human, goal, records, history, pages: [...f.pages] }));
}, 30_000);

test.skipIf(!process.env.NATIVE_UUID_GOAL_ROOT)("UUID goal recovery child repeat", async () => {
  const root = process.env.NATIVE_UUID_GOAL_ROOT!, seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
  const f = createFixture(root, JSON.parse(process.env.NATIVE_UUID_GOAL_LAUNCHER!), "backend-exit");
  for (const [key, page] of seed.pages) f.pages.set(key, page);
  f.controls.queryIncludesContinuity = true;
  seed.records.push(boundary(turns[1]), context(root, turns[1])); writeRollout(root, seed.records);
  f.controls.handoffSummary = "Second exact native goal checkpoint.";
  const text = summary(await f.run(request(f, turns[1], seed.history, "pre_turn")));
  seed.history = installed(seed.human, text);
  seed.records.push(compacted(turns[1], seed.history), context(root, turns[1])); writeRollout(root, seed.records);
  seed.pages = [...f.pages];
  writeFileSync(join(root, "seed.json"), JSON.stringify(seed));
}, 30_000);

for (const kind of ["pure", "edit", "clear"]) test(`UUID ${kind} goal keeps exact canonical proof across two backend exits`, async () => {
  const root = mkdtempSync(join(tmpdir(), "native-uuid-goal-"));
  const owner = continuityProcessInstance();
  const launcher = { pid: owner.pid, startIdentity: owner.startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : owner.startIdentity, instanceId: "a".repeat(64) };
  try {
    for (const stage of ["seed", "repeat"]) {
      const log = Bun.file(join(root, `${stage}.log`));
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", `^UUID goal recovery child ${stage}$`], {
        env: { ...process.env, NATIVE_UUID_GOAL_ROOT: root, NATIVE_UUID_GOAL_KIND: kind, NATIVE_UUID_GOAL_LAUNCHER: JSON.stringify(launcher) }, stdout: log, stderr: log });
      expect(await child.exited, await log.text()).toBe(0);
    }
    const seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
    const f = createFixture(root, launcher);
    for (const [key, page] of seed.pages) f.pages.set(key, page);
    f.controls.queryIncludesContinuity = true;
    continuityBindingsFor(f.statePath);
    seed.records.push(boundary(turns[2]), context(root, turns[2]));
    const latest = seed.records.findLastIndex((item: Item) => item.type === "compacted");
    if (kind === "pure") {
      const before = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!;
      for (const newer of ["human", "goal context", "edit", "clear", "delegation", "mixed human"]) {
        const records = structuredClone(seed.records);
        records.splice(latest, 0, { type: "response_item", payload: laterInstruction(newer, turns[1]) });
        writeRollout(root, records);
        await expect(f.run(request(f, turns[2], seed.history, "pre_turn")), newer)
          .rejects.toMatchObject({ code: "invalid_trusted_codex_environment" });
        expect(f.submissions, newer).toHaveLength(0);
        expect(continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!.historyRevision, newer).toBe(before.historyRevision);
      }
    }
    const faults = ["missing checkpoint", "changed checkpoint", "foreign checkpoint owner", "empty", "guardian only", "older matching", "original body", "later instruction",
      ...(seed.human ? ["removed human", "changed human"] : [])];
    for (const fault of faults) {
      const records = structuredClone(seed.records), cp = records[latest].payload;
      if (fault === "missing checkpoint") cp.replacement_history = seed.human ? [seed.human] : [];
      if (fault === "changed checkpoint" || fault === "older matching") {
        if (fault === "older matching") records.splice(latest, 0, structuredClone(records[latest]));
        cp.replacement_history = installed(seed.human, "A different canonical checkpoint.");
      }
      if (fault === "empty") cp.replacement_history = [];
      if (fault === "foreign checkpoint owner") cp.replacement_history.at(-1).internal_chat_message_metadata_passthrough = { turn_id: turns[2] };
      if (fault === "guardian only") { cp.guardian_history = cp.replacement_history; cp.replacement_history = []; }
      if (fault === "original body") records.find((item: Item) => item.type === "response_item" && item.payload.id === seed.goal.id).payload.content[0].text = "Changed canonical goal.";
      if (fault === "later instruction") records.push({ type: "response_item", payload: { type: "message", role: "user", id: "newer-task",
        content: [{ type: "input_text", text: "Another native instruction." }], internal_chat_message_metadata_passthrough: { turn_id: turns[2], content_item_kinds: ["user.text"] } } });
      if (fault === "removed human") cp.replacement_history.splice(0, 1);
      if (fault === "changed human") cp.replacement_history[0].content[0].text = "Changed retained human.";
      writeRollout(root, records);
      const parsed = request(f, turns[2], seed.history, "pre_turn");
      expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, home(root)).resolve(parsed), fault).toThrow();
      expect(f.submissions, fault).toHaveLength(0);
    }
    // These native records add context and observations, not replacement tasks.
    seed.records.splice(latest, 0, ...contextAndOutputs(turns[1]).map(payload => ({ type: "response_item", payload })));
    writeRollout(root, seed.records);
    const parsed = request(f, turns[2], seed.history, "pre_turn");
    const before = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!;
    expect(before.historyRevision).toBe(2);
    expect(parsed._continuityScope).toBe(before.scope);
    const source = extractChatGptCompactionSourceRevision(parsed);
    expect(source).toMatchObject({ itemId: seed.goal.id, turnId: turns[0], content: [] });
    f.controls.handoffSummary = "Third exact native goal checkpoint.";
    const text = summary(await f.run(parsed));
    expect(text).toContain(JSON.stringify(seed.goal.content[0].text));
    expect(source.content).toEqual([]);
    const record = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!;
    expect(record.historyRevision).toBe(3);
    expect(f.submissions).toHaveLength(1);
  } finally {
    await disposeTestFixtures(); rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

for (const kind of ["human", "goal context", "edit", "clear", "delegation", "mixed human", "mixed image", "context and output"]) {
  test(`UUID raw goal pre-turn ${kind === "context and output" ? "accepts" : "rejects newer"} ${kind} before Send`, async () => {
    const root = mkdtempSync(join(tmpdir(), "native-raw-supersession-"));
    const owner = continuityProcessInstance();
    const launcher = { pid: owner.pid, startIdentity: owner.startIdentity === "unverified"
      ? "darwin:Sat Oct 10 00:00:00 2026" : owner.startIdentity, instanceId: "a".repeat(64) };
    try {
      const f = createFixture(root, launcher);
      const human = laterInstruction("human", turns[0]); human.id = "original-human";
      const goal = laterInstruction("clear", turns[0]); goal.id = "original-goal";
      goal.internal_chat_message_metadata_passthrough.turn_id = "auto-compact-3";
      const input = [human, goal];
      const records: Item[] = [{ type: "session_meta", payload: { id: thread, source: "vscode" } }, boundary(turns[0]), context(root, turns[0]),
        ...input.map(payload => ({ type: "response_item", payload: structuredClone(payload) }))];
      writeRollout(root, records);
      f.controls.invokeSourceTools = true;
      const original = request(f, turns[0], input);
      await f.run(original);
      const active = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(original)}`)!;
      const call = active.outstanding()[0]!;
      records.push(boundary(turns[1]), context(root, turns[1]),
        ...(kind === "context and output" ? contextAndOutputs(turns[1]) : [laterInstruction(kind, turns[1])])
          .map(payload => ({ type: "response_item", payload })));
      writeRollout(root, records);
      const before = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!;
      const submissions = f.submissions.length;
      const compact = request(f, turns[1], [...input, recordedCall(call),
        { type: "function_call_output", call_id: call.callId, output: "The already issued command finished." }], "pre_turn");
      f.controls.invokeSourceTools = false;
      if (kind === "context and output") {
        summary(await f.run(compact));
        expect(f.submissions).toHaveLength(submissions + 1);
      } else {
        await expect(f.run(compact)).rejects.toMatchObject({ code: "invalid_trusted_codex_environment" });
        expect(f.submissions).toHaveLength(submissions);
        expect(continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(thread))!.historyRevision).toBe(before.historyRevision);
      }
    } finally { await disposeTestFixtures(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
}
