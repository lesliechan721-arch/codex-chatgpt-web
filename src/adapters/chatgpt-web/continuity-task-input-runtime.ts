import type { CodexParsedRequest } from "../../types";
import { ContinuityTaskInputStore, type TaskInputDelivery, type TaskInputIdentity, type TaskInputTaskRecord } from "./continuity-task-input-store";
import { recoveryRecord } from "./continuity-recovery-runtime";
import { chatGptTurnSessions, type ChatGptTurnSession } from "./turn-execution";
import { taskUpdateDigest, taskUpdateSourceError, type TaskUpdateExecutionIdentity } from "./task-update-source";

export interface RuntimeTaskInputQueue {
  store: ContinuityTaskInputStore;
  identity: TaskInputIdentity;
  authorize: () => void;
}

/** Inbox identity survives HTTP, physical response and page generation changes. */
export function taskInputQueue(session: ChatGptTurnSession): RuntimeTaskInputQueue | undefined {
  const binding = session.runtime.continuityBinding;
  const recovery = binding?.recovery;
  if (!binding || !recovery || !session.nativeThreadId || !session.nativeTurnId) return undefined;
  const identity = { thread: binding.thread, scope: binding.scope,
    taskId: `task_${taskUpdateDigest([binding.thread, session.nativeTurnId])}` };
  return { identity, store: new ContinuityTaskInputStore(recovery.directory), authorize: () => {
    const current = recoveryRecord(recovery);
    if (session.supersededError || session.isTaskUpdateCancelled() || binding.state === "lost" || binding.state === "ended"
      || current.thread !== identity.thread || current.scope !== identity.scope || current.epoch !== binding.epoch
      || current.owner.id !== binding.owner || current.state === "stopped"
      || binding.executionKey && chatGptTurnSessions.find(binding.executionKey) !== session) {
      throw taskUpdateSourceError("task_update_source_unproven", "The task input no longer belongs to this current local execution.");
    }
  } };
}

/** Receipt does not accept an active update, change the source snapshot, or send a prompt. */
export function receiveTaskInputs(session: ChatGptTurnSession, parsed: CodexParsedRequest,
  execution: TaskUpdateExecutionIdentity): TaskInputTaskRecord | undefined {
  const queue = taskInputQueue(session);
  if (!queue) return undefined;
  const source = session.proveTaskInputReceipt(parsed, execution);
  if (!source.messages.length) return queue.store.get(queue.identity);
  const received = queue.store.receive(queue.identity,
    source.messages.map(message => ({ messageId: message.sourceMessageId, text: message.content })),
    { authorize: queue.authorize });
  const reason = session.runtime.continuityBinding?.state === "compacting" ? "compaction"
    : session.runtime.manualControl && session.runtime.submission?.phase !== "accepted" ? "manual-send" : "boundary";
  return queue.store.setWaitReason(queue.identity, reason, { expectedIntentGeneration: received.intentGeneration, authorize: queue.authorize }) ?? received;
}

export function pendingTaskInputs(session: ChatGptTurnSession): Array<{ messageId: string; text: string; receivedSequence: number }> {
  const queue = taskInputQueue(session);
  if (!queue) return [];
  const task = queue.store.get(queue.identity);
  if (!task || task.state !== "active") return [];
  return task.messages.filter(message => message.status === "accepted" && !message.deliveryIds.some(id => {
    const delivery = task.deliveries.find(delivery => delivery.deliveryId === id)!;
    return !delivery.cancelled && delivery.intentGeneration === task.intentGeneration;
  })).map(message => ({ messageId: message.messageId, receivedSequence: message.receivedSequence,
    text: queue.store.readBody(queue.identity, message.messageId) }));
}

/** Mirror only exact delivered/ACKed subsets. Later inbox receipts do not change coverage. */
export function synchronizeTaskInputDelivery(session: ChatGptTurnSession, delivery: TaskInputDelivery): void {
  const queue = taskInputQueue(session);
  const state = session.runtime.mode === "tools" ? session.runtime.externalProgress.snapshot().taskUpdates : undefined;
  if (!queue || !state || delivery.physicalResponseId !== session.traceId) return;
  const guard = { expectedIntentGeneration: delivery.intentGeneration, authorize: queue.authorize };
  const through = (revision: number) => delivery.messageIds.filter((_, index) => delivery.modelRevisions[index]! <= revision);
  const delivered = through(state.deliveredRevision);
  if (delivered.length) queue.store.markDelivered(queue.identity, delivery.deliveryId, { ...delivery, messageIds: delivered }, guard);
  const acknowledged = through(state.acknowledgedRevision);
  if (acknowledged.length) queue.store.acknowledge(queue.identity, delivery.deliveryId, { ...delivery, messageIds: acknowledged }, guard);
}

export function completeTaskInputPhysicalResponse(session: ChatGptTurnSession): void {
  const queue = taskInputQueue(session);
  const receipt = session.runtime.taskUpdates?.outputReceipt;
  if (!queue || session.settledOutcome()?.type !== "final") return;
  const task = queue.store.get(queue.identity);
  if (!task || task.state === "stopped") return;
  for (const delivery of task.deliveries) {
    if (delivery.cancelled || delivery.physicalResponseId !== session.traceId
      || delivery.completedMessageIds.length === delivery.messageIds.length) continue;
    if (delivery.mode === "active") {
      synchronizeTaskInputDelivery(session, delivery);
      if (!receipt || receipt.kind !== "completed" || receipt.taskRevision < delivery.acceptedRevision
        || receipt.driverGeneration < delivery.driverGeneration) continue;
    } else queue.store.markDelivered(queue.identity, delivery.deliveryId, delivery,
      { expectedIntentGeneration: delivery.intentGeneration, authorize: queue.authorize });
    queue.store.complete(queue.identity, delivery.deliveryId, delivery,
      { expectedIntentGeneration: delivery.intentGeneration, authorize: queue.authorize });
  }
}
