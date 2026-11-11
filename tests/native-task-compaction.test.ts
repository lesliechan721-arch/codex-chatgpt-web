import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionContinuityFixtures, recordedCall, deliveredStartupSources } from "./helpers/session-continuity-fixture";
import { continuityBindingsFor, continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { ContinuityRecoveryStore, continuityProcessInstance } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { bindContinuityRequestScope } from "../src/adapters/chatgpt-web/continuity-request";
import { chatGptWebExecutionNamespace } from "./helpers/chatgpt-web-adapter";
import { chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptCurrentInstructionRevision, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { recoverCompactionInstruction } from "../src/adapters/chatgpt-web/compaction-continuation";
import { buildCompactV1Output, encodeCompactionSummary, extractCompactUserMessages } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";

const { fixture, disposeTestFixtures } = createSessionContinuityFixtures(import.meta.path);
afterEach(disposeTestFixtures);
type Item = Record<string, any>;
const goal = (kind: string, text: string, id = "edited-goal"): Item => ({ type: "message", role: "user", id,
  content: [{ type: "input_text", text: `<codex_internal_context source="user_goal">${text}</codex_internal_context>` }],
  internal_chat_message_metadata_passthrough: { turn_id: "auto-compact-3", content_item_kinds: [kind] } });

test.skipIf(!process.env.NATIVE_TASK_RESTART_ROOT)("native task goal restart seed", async () => {
  const root = process.env.NATIVE_TASK_RESTART_ROOT!;
  const f = fixture(false, { root, threadId: "native-goal-restart", cleanupMode: "backend-exit",
    launcherInstance: JSON.parse(process.env.NATIVE_TASK_LAUNCHER!) });
  const human = (f.request()._rawBody as { input: Item[] }).input[0]!;
  human.content = [{ type: "input_text", text: "Continue the original goal." }];
  const edit = goal(process.env.NATIVE_TASK_GOAL_KIND!, process.env.NATIVE_TASK_GOAL_TEXT!);
  const pure = process.env.NATIVE_TASK_PURE_GOAL === "true";
  if (pure) edit.internal_chat_message_metadata_passthrough = { turn_id: "turn-first", content_item_kinds: ["goal.internal_context"] };
  const sourceItems = [...(pure ? [] : [human]), edit];
  const source = f.request("", "turn-first", sourceItems);
  f.controls.invokeSourceTools = true;
  await f.run(source);
  expect(chatGptCurrentInstructionRevision(source)).toMatchObject({ itemId: edit.id, turnId: "turn-first",
    ...(pure ? {} : { nativeTurnId: "auto-compact-3" }) });
  const active = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(f.provider)}:${chatGptTurnExecutionKey(source)}`)!;
  expect(active.continuitySourceInstructionReplayEvidence().instructionIdentity).toBe(edit.id);
  const call = active.outstanding()[0]!;
  const compact = f.request("", "turn-first", [...sourceItems, recordedCall(call),
    { type: "function_call_output", call_id: call.callId, output: "Goal command finished once." }]);
  compact._compactionRequest = true;
  const checkpoint = (await f.run(compact)).find(event => event.type === "text_delta");
  if (checkpoint?.type !== "text_delta") throw new Error("Missing native goal checkpoint");
  const installed = process.env.NATIVE_TASK_FORMAT === "v1"
    ? buildCompactV1Output(extractCompactUserMessages(sourceItems), checkpoint.text)
    : [...(pure ? [] : [human]), { type: "compaction", encrypted_content: encodeCompactionSummary(checkpoint.text) }];
  f.controls.invokeSourceTools = false;
  const beforeResume = f.request("", "turn-first", installed);
  bindContinuityRequestScope(beforeResume, chatGptWebExecutionNamespace(f.provider));
  expect(recoverCompactionInstruction(beforeResume, extractChatGptTurnIdentity(beforeResume))?.sourceWasGoal).toBe(true);
  expect(chatGptCurrentInstructionRevision(beforeResume)?.itemId).toBe(edit.id);
  await f.run(beforeResume);
  writeFileSync(join(root, "seed.json"), JSON.stringify({ installed, edit, summary: checkpoint.text, pages: [...f.pages] }));
}, 30_000);

for (const [kind, text] of [["user.goal", "User cleared the goal."], ["user.goal.omitted", "User set the goal: inspect only."]]) {
  for (const format of ["v1", "v2"]) test(`${format} task restores ${kind} after backend restart and keeps the next goal edit`, async () => {
    const root = mkdtempSync(join(tmpdir(), "native-goal-restart-"));
    const launcher = continuityProcessInstance();
    const launcherInstance = { pid: launcher.pid, startIdentity: launcher.startIdentity === "unverified"
      ? "darwin:Sat Oct 10 00:00:00 2026" : launcher.startIdentity, instanceId: "a".repeat(64) };
    try {
      const log = Bun.file(join(root, "seed.log"));
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^native task goal restart seed$"], {
        env: { ...process.env, NATIVE_TASK_RESTART_ROOT: root, NATIVE_TASK_LAUNCHER: JSON.stringify(launcherInstance),
          NATIVE_TASK_GOAL_KIND: kind, NATIVE_TASK_GOAL_TEXT: text, NATIVE_TASK_FORMAT: format }, stdout: log, stderr: log });
      expect(await child.exited, await log.text()).toBe(0);
      const seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
      const f = fixture(false, { root, threadId: "native-goal-restart", launcherInstance });
      for (const [key, page] of seed.pages) f.pages.set(key, page);
      f.controls.queryIncludesContinuity = true;
      continuityBindingsFor(f.statePath);
      const request = f.request("", "turn-first", seed.installed);
      bindContinuityRequestScope(request, chatGptWebExecutionNamespace(f.provider));
      request._continuityStateDirectory = f.statePath;
      const recovered = recoverCompactionInstruction(request, extractChatGptTurnIdentity(request))!;
      expect(recovered.sourceWasGoal).toBe(true);
      expect(recovered.source.itemId).toBe(seed.edit.id);
      request._compactionRequest = true;
      expect(canonicalizeCompactionHandoff(request, seed.summary)).toBe(seed.summary);
      const nextEdit = goal("user.goal", "User cleared the replacement goal.", "next-goal-edit");
      const steered = f.request("", "turn-first", [...seed.installed, nextEdit]);
      expect((await f.run(steered)).at(-1)).toMatchObject({ type: "done", endTurn: true });
      expect(extractChatGptTurnUserRevision(steered)).toEqual(nextEdit.content);
      expect(chatGptCurrentInstructionRevision(steered)).toMatchObject({ itemId: nextEdit.id, turnId: "turn-first" });
      expect(deliveredStartupSources(f.submissions.at(-1)!.prompt)).toContain("User cleared the replacement goal.");
      const record = continuityBindingsFor(f.statePath).recoveryStore.get(continuityDigest(f.threadId))!;
      expect(record.works[record.currentWorkId!]!.instructionIdentity).toBe(nextEdit.id);
    } finally {
      await disposeTestFixtures();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test("task automatic pre-turn compaction reads one exact durable source and cannot replace its own checkpoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-pre-turn-"));
  try {
    new ContinuityRegistrationStore(directory).initialize();
    continuityBindingsFor(directory);
    const store = new ContinuityRecoveryStore(directory);
    const threadId = "native-pre-turn-thread", thread = continuityDigest(threadId), scope = continuityDigest("native-pre-turn-scope");
    const owner = continuityProcessInstance();
    const commit = (turn: string, summary: string) => {
      store.admitWork({ thread, scope, owner, logicalWorkId: `source:${turn}`, instructionIdentity: `item:${turn}`,
        nativeTurnId: turn, workPayloadDigest: continuityDigest(`payload:${turn}`), snapshotDigest: continuityDigest(turn),
        createPage: true, dispatchProtocolComplete: true });
      store.retireAttempt(thread, { scope }, `source:${turn}`, 0);
      const record = store.registerCompactionTarget(thread, { scope }, { sourceLogicalWorkId: `source:${turn}`,
        sourceIdentity: `item:${turn}`, representationDigests: [continuityDigest([turn, `item:${turn}`, "Task instruction.", { role: "user" }])] });
      const target = Object.values(record.compactionTargets).find(value => value.sourceIdentity === `item:${turn}`)!;
      store.admitWork({ thread, scope, owner, logicalWorkId: `compact:${turn}`, instructionIdentity: `compact:${turn}`,
        nativeTurnId: turn, workPayloadDigest: continuityDigest(`compact:${turn}`), snapshotDigest: continuityDigest(summary),
        purpose: "compaction", compactionTargetId: target.compactionTargetId, dispatchProtocolComplete: true });
      store.retireAttempt(thread, { scope }, `compact:${turn}`, 0);
      store.commitCheckpoint(thread, { scope }, { logicalWorkId: `compact:${turn}`, commitId: `commit:${turn}`,
        compactionTargetId: target.compactionTargetId, summaryDigest: continuityDigest(summary), coveredCallIds: [], nativeTurnId: turn });
    };
    commit("previous-turn", "Exact previous checkpoint.");
    const request = (phase = "pre_turn", trigger = "auto", summary = "Exact previous checkpoint.") => {
      const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "next-turn", request_kind: "compaction",
          compaction: { implementation: "responses", strategy: "memento", phase, trigger } }) } });
      parsed._conversationPolicy = "task";
      parsed._continuityScope = scope;
      parsed._continuityStateDirectory = directory;
      return parsed;
    };
    const before = store.get(thread)!.version;
    expect(extractChatGptCompactionSourceRevision(request())).toMatchObject({ itemId: "item:previous-turn", turnId: "previous-turn", content: [] });
    for (const invalid of [request("mid_turn"), request("pre_turn", "manual"), request("pre_turn", "auto", "Unknown checkpoint.")]) {
      expect(() => extractChatGptCompactionSourceRevision(invalid)).toThrow("requires a source user message");
    }
    const ordinary = request();
    ordinary._compactionRequest = false;
    expect(() => extractChatGptTurnUserRevision(ordinary)).toThrow("current-turn user message");
    expect(store.get(thread)!.version).toBe(before);
    commit("next-turn", "Exact current checkpoint.");
    expect(() => extractChatGptCompactionSourceRevision(request())).toThrow("requires a source user message");
    expect(extractChatGptCompactionSourceRevision(request("pre_turn", "auto", "Exact current checkpoint."))).toMatchObject({ itemId: "item:next-turn" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const pure of [false, true]) test(`task automatic pre-turn compaction summarizes its committed goal after backend exit (no human=${pure})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "native-preturn-restart-"));
  const launcher = continuityProcessInstance();
  const launcherInstance = { pid: launcher.pid, startIdentity: launcher.startIdentity === "unverified"
    ? "darwin:Sat Oct 10 00:00:00 2026" : launcher.startIdentity, instanceId: "a".repeat(64) };
  try {
    const log = Bun.file(join(root, "seed.log"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "^native task goal restart seed$"], {
      env: { ...process.env, NATIVE_TASK_RESTART_ROOT: root, NATIVE_TASK_LAUNCHER: JSON.stringify(launcherInstance),
        NATIVE_TASK_GOAL_KIND: "user.goal", NATIVE_TASK_GOAL_TEXT: "User cleared the goal.", NATIVE_TASK_FORMAT: "v2",
        NATIVE_TASK_PURE_GOAL: String(pure) }, stdout: log, stderr: log });
    expect(await child.exited, await log.text()).toBe(0);
    const seed = JSON.parse(readFileSync(join(root, "seed.json"), "utf8"));
    const f = fixture(false, { root, threadId: "native-goal-restart", launcherInstance });
    for (const [key, page] of seed.pages) f.pages.set(key, page);
    f.controls.queryIncludesContinuity = true;
    f.controls.handoffSummary = "Summary for the next native step.";
    const parsed = f.request("", "turn-next", seed.installed);
    const body = parsed._rawBody as { client_metadata: Record<string, string> };
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ thread_id: f.threadId, turn_id: "turn-next", request_kind: "compaction",
      compaction: { trigger: "auto", phase: "pre_turn", implementation: "responses", strategy: "memento" } });
    parsed._compactionRequest = true;
    const rejected = ["unknown summary", "changed instructions", "new developer", "anonymous instruction", ...(pure ? ["wrong scope"] : ["removed human", "changed human"])];
    for (const fault of rejected) {
      const invalid = structuredClone(parsed);
      const raw = invalid._rawBody as { input: Item[]; instructions?: string };
      if (fault === "unknown summary") raw.input.at(-1)!.encrypted_content = encodeCompactionSummary("Unknown native checkpoint.");
      if (fault === "changed instructions") raw.instructions = "Changed constraints cannot borrow the old goal.";
      if (fault === "new developer") raw.input.push({ type: "message", role: "developer", id: "new-constraint", content: "Unproved new constraint.",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-next" } });
      if (fault === "anonymous instruction") raw.input.push({ type: "message", role: "user", content: "Unproved anonymous task." });
      if (fault === "wrong scope") invalid.options.reasoning = "high";
      if (fault === "removed human") raw.input.splice(0, 1);
      if (fault === "changed human") raw.input[0]!.content = [{ type: "input_text", text: "Changed retained instruction." }];
      await expect(f.run(invalid), fault).rejects.toThrow();
      expect(f.submissions, fault).toHaveLength(0);
    }
    const events = await f.run(parsed);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: expect.stringContaining("User cleared the goal.") }));
    expect(f.submissions).toHaveLength(1);
  } finally {
    await disposeTestFixtures();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
