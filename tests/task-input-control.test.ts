import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { ContinuityTaskInputStore } from "../src/adapters/chatgpt-web/continuity-task-input-store";
import { taskInputControl } from "../src/task-input-control";
const roots: string[] = [];
const identity = { thread: "1".repeat(64), scope: "2".repeat(64), taskId: "control-task" };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cgw-input-control-")); roots.push(directory);
  new ContinuityRegistrationStore(directory).initialize();
  const store = new ContinuityTaskInputStore(directory);
  const task = store.receive(identity, [{ messageId: "message-A", text: "exact original text" }]);
  return { directory, store, task, binding: { identity, expectedVersion: task.version, expectedIntentGeneration: task.intentGeneration } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("control requires an exact action and a current durable version for mutation", () => {
  const { directory, store, binding } = fixture();
  expect(taskInputControl(directory, { action: "snapshot", path: "/private" })).toEqual({ ok: false, code: "task_update_invalid" });
  store.stop(identity);
  expect(taskInputControl(directory, { action: "discard", ...binding, messageId: "message-A" })).toEqual({ ok: false, code: "task_update_stale" });
  expect(store.readBody(identity, "message-A")).toBe("exact original text");
});
test("missing bodies cannot be copied and repair must match the saved ID and digest", () => {
  const { directory, store } = fixture();
  const payloads = join(directory, "task-input-payloads");
  for (const name of readdirSync(payloads)) unlinkSync(join(payloads, name));
  expect(taskInputControl(directory, { action: "read", identity, messageId: "message-A" })).toEqual({ ok: false, code: "continuity_context_missing" });
  const task = store.get(identity)!;
  const binding = { identity, expectedVersion: task.version, expectedIntentGeneration: task.intentGeneration };
  expect(taskInputControl(directory, { action: "repair", ...binding, messageId: "message-A", text: "wrong text" })).toEqual({ ok: false, code: "task_update_message_conflict" });
  expect(taskInputControl(directory, { action: "repair", ...binding, messageId: "new-ID", text: "exact original text" })).toEqual({ ok: false, code: "task_update_invalid" });
  expect(taskInputControl(directory, { action: "repair", ...binding, messageId: "message-A", text: "exact original text" })).toEqual({ ok: true, value: null });
  expect(taskInputControl(directory, { action: "read", identity, messageId: "message-A" })).toEqual({ ok: true, value: { text: "exact original text" } });
});
