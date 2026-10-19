import { ContinuityTaskInputStore, validateTaskInputIdentity, type TaskInputGuard, type TaskInputIdentity } from "./adapters/chatgpt-web/continuity-task-input-store";
import { MAX_CONTINUITY_RECOVERY_BYTES } from "./adapters/chatgpt-web/continuity-recovery-store";

export const MAX_TASK_INPUT_CONTROL_BYTES = 6 * 1024 * 1024 + 16 * 1024;
const allowedCodes = new Set([
  "task_update_invalid", "task_update_stale", "task_update_message_conflict", "task_update_not_executed",
  "continuity_context_missing", "continuity_resource_capacity", "continuity_configuration_conflict", "continuity_unverified",
]);
function invalid(): never { throw Object.assign(new Error("Invalid task input action."), { code: "task_update_invalid" }); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function ids(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 128
    || value.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:@+-]{1,256}$/.test(id))
    || new Set(value).size !== value.length) invalid();
}
function identity(value: unknown): TaskInputIdentity {
  object(value); exact(value, ["thread", "scope", "taskId"]); validateTaskInputIdentity(value); return value;
}
function guard(value: Record<string, unknown>): TaskInputGuard {
  if (!Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 0
    || !Number.isSafeInteger(value.expectedIntentGeneration) || Number(value.expectedIntentGeneration) < 0) invalid();
  return { expectedVersion: Number(value.expectedVersion), expectedIntentGeneration: Number(value.expectedIntentGeneration) };
}

/** Owner-authorized Launcher control only. This API does not grant an execution capability. */
export function taskInputControl(directory: string, request: unknown): Record<string, unknown> {
  try {
    object(request);
    const store = new ContinuityTaskInputStore(directory);
    if (request.action === "snapshot") {
      exact(request, ["action"]);
      // Verify actual files before offering View or Copy. Missing content is never synthesized.
      for (const task of store.listTasks()) for (const message of task.messages) {
        if (message.payload === "released") continue;
        try { store.readBody(task, message.messageId); }
        catch (error) { if ((error as { code?: string }).code !== "continuity_context_missing") throw error; }
      }
      return { ok: true, value: { tasks: store.listTasks().filter(task => !task.retired?.compacted), usage: store.usage(), recoveryLimitBytes: MAX_CONTINUITY_RECOVERY_BYTES } };
    }
    const task = identity(request.identity);
    if (request.action === "read") {
      exact(request, ["action", "identity", "messageId"]); ids([request.messageId]);
      return { ok: true, value: { text: store.readBody(task, String(request.messageId)) } };
    }
    const expected = guard(request);
    const keys = ["action", "identity", "expectedVersion", "expectedIntentGeneration"];
    if (request.action === "retry") {
      exact(request, [...keys, "messageIds"]); ids(request.messageIds);
      store.retry(task, request.messageIds, expected);
    } else if (request.action === "discard") {
      exact(request, [...keys, "messageId"]); ids([request.messageId]);
      store.discard(task, String(request.messageId), expected);
    } else if (request.action === "repair") {
      exact(request, [...keys, "messageId", "text"]); ids([request.messageId]);
      if (typeof request.text !== "string") invalid();
      // This action can only restore an existing identity, never create a new user message.
      const current = store.get(task);
      if (!current?.messages.some(message => message.messageId === request.messageId && ["missing", "reserved"].includes(message.payload))) invalid();
      store.receive(task, [{ messageId: String(request.messageId), text: request.text }], expected);
    } else if (request.action === "cleanup") {
      exact(request, keys); store.cleanup(task, undefined, expected);
    } else if (request.action === "delete-task") {
      exact(request, keys); store.deleteTask(task, expected);
    } else invalid();
    return { ok: true, value: null };
  } catch (error) {
    const failure = error as { code?: string; receiveStatus?: string };
    return { ok: false, code: allowedCodes.has(failure.code ?? "") ? failure.code : "unavailable",
      ...(failure.receiveStatus === "unknown" ? { receiveStatus: "unknown" } : {}) };
  }
}

export async function readTaskInputControl(stream: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk); bytes += buffer.length;
    if (bytes > MAX_TASK_INPUT_CONTROL_BYTES) invalid();
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { invalid(); }
}
