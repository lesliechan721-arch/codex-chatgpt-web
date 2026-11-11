import { afterEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const thread = "01a06c66-4232-7ae1-9108-69b5f70e0671";
const previous = "01a06c66-4380-75c6-a0df-318f890ef6de";
const next = "01a06c66-4381-75c6-a0df-318f890ef6de";
type Item = Record<string, any>;

function fixture(phase: "mid_turn" | "pre_turn", kind: string, previousPermissions = false, anchorKind = "user.text", child = false) {
  const home = mkdtempSync(join(tmpdir(), "native-goal-proof-")); homes.push(home);
  const current = phase === "pre_turn" ? next : previous;
  const human: Item = { type: "message", role: "user", id: "native-human",
    content: [{ type: "input_text", text: "Inspect the project." }],
    internal_chat_message_metadata_passthrough: { turn_id: previous, content_item_kinds: [anchorKind] } };
  if (anchorKind === "goal.internal_context") human.content[0].text = '<codex_internal_context source="goal">Continue the current native goal.</codex_internal_context>';
  const goal: Item = { type: "message", role: "user", id: "native-goal",
    content: [{ type: "input_text", text: '<codex_internal_context source="user_goal">User cleared the goal.</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: "auto-compact-3", content_item_kinds: [kind] } };
  const boundary = (turn: string): Item => ({ type: "event_msg", payload: { type: "task_started", turn_id: turn } });
  const context = (turn: string): Item => ({ type: "turn_context", payload: { turn_id: turn, cwd: home, workspace_roots: [home],
    approval_policy: "never", sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" }, model: "chatgpt-web/pro" } });
  const nativeHuman: Item = { type: "response_item", payload: structuredClone(human) };
  const nativeGoal: Item = { type: "response_item", payload: structuredClone(goal) };
  const parent = "01a06c66-18ad-73e1-a641-9b114f2ed10c";
  const lineage = child ? { parent_thread_id: parent, agent_name: "/root/child", subagent_kind: "thread_spawn" } : {};
  const session = child ? { id: thread, parent_thread_id: parent, agent_path: "/root/child", thread_source: "subagent",
    source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: "/root/child" } } } } : { id: thread, source: "vscode" };
  const records: Item[] = [{ type: "session_meta", payload: session },
    boundary(previous), context(previous), nativeHuman, nativeGoal,
    ...(phase === "pre_turn" ? [boundary(current), ...(previousPermissions ? [] : [context(current)])] : [])];
  const path = join(home, "sessions", "2026", "11", "11", `rollout-2026-11-11T10-00-00-${thread}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const write = () => writeFileSync(path, records.map(value => JSON.stringify(value)).join("\n") + "\n");
  const parsed = parseRequest({ model: "chatgpt-web/pro", input: [human, goal], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: current, request_kind: "compaction", ...lineage,
      sandbox_mode: "danger-full-access", workspaces: { [home]: {} },
      compaction: { trigger: "auto", phase, implementation: "responses", strategy: "memento" } }) } });
  parsed._conversationPolicy = "task";
  const resolve = () => { write(); return new ChatGptThreadEnvironmentStore(undefined, Date.now, home).resolve(parsed); };
  return { parsed, resolve, home, human, goal, records, nativeHuman, nativeGoal, boundary, context };
}

for (const kind of ["user.goal", "user.goal.omitted"]) for (const phase of ["mid_turn", "pre_turn"] as const) for (const anchor of ["user.text", "goal.internal_context"]) {
  test(`UUID ${phase} verifies the canonical ${anchor} task owner of ${kind}`, () => {
    const f = fixture(phase, kind, false, anchor);
    expect(f.resolve()).toMatchObject({ cwd: f.home, sandboxPolicy: { type: "dangerFullAccess" } });
    expect(extractChatGptCompactionSourceRevision(f.parsed)).toMatchObject({
      itemId: f.goal.id, turnId: previous, nativeTurnId: "auto-compact-3", content: f.goal.content });
  });
}

test("UUID pre-turn goal compaction can use the previous permission context before its new turn context is published", () => {
  const f = fixture("pre_turn", "user.goal", true);
  expect(f.resolve().cwd).toBe(f.home);
});

for (const [author, recipient, supersedes] of [["/root", "/root/child", true], ["/root/child/grandchild", "/root/child", false],
  ["/root", "/root/other", false]] as const) test(`UUID child accepts agent message as task only from its direct parent to itself (${author} -> ${recipient})`, () => {
  const f = fixture("pre_turn", "user.goal", false, "user.text", true);
  f.records.push({ type: "response_item", payload: { type: "agent_message", id: "native-agent-message", author, recipient,
    content: "A native agent message.", internal_chat_message_metadata_passthrough: { turn_id: next } } });
  if (supersedes) expect(f.resolve).toThrow();
  else expect(f.resolve().cwd).toBe(f.home);
});

for (const phase of ["mid_turn", "pre_turn"] as const) for (const fault of ["historical goal", "compacted source", "wrong task", "native kind", "wire kind", "id", "content", "duplicate id"] as const) {
  test(`UUID ${phase} rejects unproved goal source: ${fault}`, () => {
    const f = fixture(phase, "user.goal");
    if (fault === "historical goal") f.records.splice(5, 0, { type: "response_item", payload: {
      ...structuredClone(f.goal), id: "newer-goal", internal_chat_message_metadata_passthrough: {
        turn_id: "auto-compact-4", content_item_kinds: ["user.goal"] } } });
    if (fault === "wrong task") f.records.splice(4, 0, f.boundary(next), f.context(next));
    if (fault === "compacted source") f.records.splice(5, 0, { type: "compacted", payload: { replacement_history: [] } });
    if (fault === "native kind") f.nativeGoal.payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["user.text"];
    if (fault === "wire kind") f.goal.internal_chat_message_metadata_passthrough.content_item_kinds = ["user.text"];
    if (fault === "id") f.goal.id = "unrecorded-goal";
    if (fault === "content") f.nativeGoal.payload.content[0].text = "Different native goal.";
    if (fault === "duplicate id") f.records.splice(5, 0, structuredClone(f.nativeGoal));
    expect(f.resolve).toThrow();
  });
}
