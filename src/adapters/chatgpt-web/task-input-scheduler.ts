import { encodeCompactionSummary } from "../../responses/compaction";
import { parseRequest } from "../../responses/parser";
import type { CodexParsedRequest, CodexToolResultMessage } from "../../types";
import type { ChatGptTurnCapability } from "./environment";
import { continuityDigest } from "./continuity-binding";
import { taskUpdateDigest, taskUpdateSourceError } from "./task-update-source";
import { pendingTaskInputs, synchronizeTaskInputDelivery, taskInputQueue } from "./continuity-task-input-runtime";
import { pendingTaskInputTransfer, tryTaskUpdateHandoff } from "./task-update-handoff";
import type { TaskUpdateExecutionIdentity } from "./task-update-source";
import { chatGptTurnExecutionKey, type ChatGptTurnSession } from "./turn-execution";
import type { BrokerToolResult, TurnBrokerOwner } from "./turn-broker";

/** Rebuild only from retained accepted source and durable user bodies, preserving their IDs. */
export function queuedTaskInputRequest(session: ChatGptTurnSession, base: CodexParsedRequest, checkpointSummary?: string): CodexParsedRequest | undefined {
  const pending = pendingTaskInputs(session).slice(0, 16);
  if (!pending.length) return undefined;
  const raw = structuredClone(base._rawBody) as Record<string, unknown>;
  const existing = checkpointSummary === undefined ? session.canonicalInput() ?? []
    : [{ type: "compaction", encrypted_content: encodeCompactionSummary(checkpointSummary) }];
  const outcome = session.settledOutcome();
  // Compaction owns this final until its committed checkpoint replaces the source.
  if (checkpointSummary === undefined && outcome?.type === "final"
    && session.runtime.continuityBinding?.state !== "compacting") {
    const receipt = session.recoveryFinalReceipt();
    const output = session.runtime.taskUpdates?.outputReceipt;
    if (!receipt || receipt.terminalDigest !== continuityDigest(outcome.answer)
      || session.runtime.taskUpdates && output?.kind !== "completed") {
      throw taskUpdateSourceError("task_update_output_unproven", "The queued continuation lacks a confirmed preceding answer.");
    }
    const id = `msg_${taskUpdateDigest([session.traceId, receipt.terminalReceiptId, "final"])}`;
    if (!existing.some(value => value && typeof value === "object" && "id" in value && value.id === id)) {
      existing.push({ type: "message", role: "assistant", id, content: [{ type: "output_text", text: outcome.answer }] });
    }
  }
  const ids = new Set(existing.flatMap(value => value && typeof value === "object" && "id" in value ? [String(value.id)] : []));
  raw.input = [...existing, ...pending.filter(message => !ids.has(message.messageId)).map(message => session.queuedTaskInputRepresentation(message.messageId) ?? ({
    type: "message", role: "user", id: message.messageId, content: message.text,
    internal_chat_message_metadata_passthrough: { turn_id: session.nativeTurnId, content_item_kinds: ["user.text"] },
  }))];
  delete raw.id; delete raw.request_id;
  const parsed = parseRequest(raw);
  return { ...base, _rawBody: raw, context: parsed.context, _continuityRequestInstruction: undefined };
}

export function startTaskInputScheduler(options: {
  session: ChatGptTurnSession; parsed: CodexParsedRequest; generation: number;
  ownerKey: string; namespace: string; environment: ChatGptTurnCapability; execution: TaskUpdateExecutionIdentity;
  broker: TurnBrokerOwner; result: (message: CodexToolResultMessage, raw?: Record<string, unknown>) => BrokerToolResult;
  signal?: AbortSignal;
}): { stop: () => void; settled: Promise<void> } {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const { session, broker } = options;
  const settled = (async () => {
    if (session.runtime.mode !== "tools" || !session.taskUpdatesEnabled() || !broker.waitForTaskInputBoundary || !taskInputQueue(session)) return;
    const token = await session.runtime.token;
    while (!signal.aborted && session.isCurrentToolObserver(options.generation)) {
      const queue = taskInputQueue(session)!;
      const task = queue.store.get(queue.identity);
      if (task?.state === "stopped") return;
      for (const delivery of task?.deliveries ?? []) if (!delivery.cancelled) synchronizeTaskInputDelivery(session, delivery);
      const pendingTransfer = pendingTaskInputTransfer(session);
      const request = pendingTransfer ?? queuedTaskInputRequest(session, options.parsed);
      const wait = pendingTransfer ? Promise.resolve(true) : request ? broker.waitForTaskInputBoundary(token, signal)
        : session.waitForTaskInputReceipt(session.taskInputReceiptRevision(), signal).then(() => true);
      const boundary = await Promise.race([wait, session.browserOutcome.then(() => false)]);
      if (!boundary || signal.aborted || !session.isCurrentToolObserver(options.generation)) return;
      if (!request) continue;
      try {
        await tryTaskUpdateHandoff({ ...options, parsed: request,
          executionKey: `${options.namespace}:${chatGptTurnExecutionKey(request)}`, controlledBoundary: true });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (["task_update_no_boundary", "task_update_final_output_started", "task_update_resource_limit", "task_update_capacity", "task_update_compacting"].includes(String(code))) {
          queue.store.setWaitReason(queue.identity, "next-response");
          return;
        }
        throw error;
      }
    }
  })().catch(error => {
    const binding = session.runtime.continuityBinding;
    if (session.settledOutcome()?.type === "error" || session.isTaskUpdateCancelled()
      || binding?.state === "lost" || binding?.state === "ended") return;
    throw error;
  }).finally(() => controller.abort());
  // Detaching never cancels the physical response; callers can inspect a real scheduler failure.
  return { stop: () => controller.abort(), settled };
}
