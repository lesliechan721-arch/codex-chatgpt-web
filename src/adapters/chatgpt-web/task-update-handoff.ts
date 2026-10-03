import type { CodexParsedRequest, CodexToolResultMessage } from "../../types";
import type { ChatGptTurnCapability } from "./environment";
import { extractChatGptTurnIdentity } from "./environment";
import type { BrokerToolResult, TurnBrokerOwner } from "./turn-broker";
import { chatGptTurnSessions, type ChatGptTaskUpdateProof, type ChatGptTurnSession } from "./turn-execution";
import type { TaskUpdateState, TaskUpdateTransfer, TaskUpdateTransferOutcome } from "./task-update-protocol";
import { captureTaskUpdateSource, taskUpdateDigest, taskUpdateSourceError, type TaskUpdateExecutionIdentity } from "./task-update-source";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

type EligibleProof = Extract<ChatGptTaskUpdateProof, { status: "eligible" }>;
interface TransferAttempt {
  proof: EligibleProof; transfer: TaskUpdateTransfer; reserved: boolean; prepared: boolean;
  release: () => void; recordedResults?: boolean; preparationFailure?: { code: string };
}

// The transfer lock excludes other local transfers, never the model or an observer's long wait.
const transferTails = new WeakMap<ChatGptTurnSession, Promise<void>>();
const attempts = new WeakMap<ChatGptTurnSession, TransferAttempt>();

function exclusive<T>(session: ChatGptTurnSession, action: () => Promise<T>): Promise<T> {
  const previous = transferTails.get(session) ?? Promise.resolve();
  const result = previous.then(action);
  const tail = result.then(() => undefined, () => undefined);
  transferTails.set(session, tail);
  return result;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** An immutable commit receipt and an observer reply can arrive out of order over owner IPC. */
export function mirrorLatestTaskUpdateState(progress: ChatGptExternalTurnProgress, state: TaskUpdateState): void {
  const current = progress.snapshot().taskUpdates;
  if (current && (current.acceptedRevision > state.acceptedRevision
    || current.deliveredRevision > state.deliveredRevision || current.acknowledgedRevision > state.acknowledgedRevision
    || current.driverGeneration > state.driverGeneration
    || (current.finalOutputRevision !== null && state.finalOutputRevision === null))) return;
  progress.recordTaskUpdateState(state);
}

/** Return a proven logical route, or undefined only when the existing fallback is applicable. */
export async function tryTaskUpdateHandoff(options: {
  parsed: CodexParsedRequest;
  executionKey: string;
  ownerKey: string;
  namespace: string;
  environment: ChatGptTurnCapability;
  execution: TaskUpdateExecutionIdentity;
  broker: TurnBrokerOwner;
  result: (message: CodexToolResultMessage, raw?: Record<string, unknown>) => BrokerToolResult;
  onProgress?: () => void;
}): Promise<ChatGptTurnSession | undefined> {
  const { parsed, broker } = options;
  if (parsed._conversationPolicy === "continuity-first" || parsed._compactionRequest) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId || !identity.turnId) return undefined;
  const foundSession = chatGptTurnSessions.findTaskUpdateOwner(identity.threadId, identity.turnId, options.ownerKey);
  if (!foundSession || foundSession.runtime.mode !== "tools") return undefined;
  const session: ChatGptTurnSession = foundSession;
  if (!broker.taskUpdateState || !broker.reserveTaskUpdate || !broker.acceptTaskUpdate
    || !broker.taskUpdateTransferOutcome || !broker.rejectTaskUpdateReservation) {
    throw taskUpdateSourceError("task_update_upgrade_required", "The active task update owner protocol is unavailable.");
  }
  return exclusive(session, async () => {
    if (session.runtime.mode !== "tools") return undefined;
    const token = await session.runtime.token;
    let attempt = attempts.get(session);
    if (attempt) {
      // No second transfer ID, even if a previous accept timed out before its receipt arrived.
      const incoming = captureTaskUpdateSource(parsed, options.execution);
      if (incoming?.requestFingerprint !== attempt.proof.source.requestFingerprint
        || incoming?.immutableDigest !== attempt.proof.source.immutableDigest) {
        throw taskUpdateSourceError("task_update_transfer_pending", "The original task update transfer must be recovered before another request can take ownership.");
      }
    } else {
      const state = await broker.taskUpdateState!(token);
      if (!state || state.finalOutputRevision !== null) return undefined;
      const proof = session.proveTaskUpdate(parsed, options.execution);
      if (proof.status === "inapplicable") return undefined;
      if (proof.status === "conflict" || proof.status === "stale") throw proof.error;
      if (proof.status === "replay") return session;
      if (proof.mode === "replay" && state.acknowledgedRevision === state.acceptedRevision) return undefined;
      const transferId = `update_${taskUpdateDigest({ namespace: options.namespace,
        physical: session.traceId, request: proof.source.requestIdentity })}`;
      const payload = {
        transferId, expectedDriverGeneration: proof.expectedDriverGeneration,
        expectedRevision: proof.expectedRevision, environment: options.environment,
        updates: proof.updates,
        results: proof.batch.messages.map((message, index) => ({ callId: message.toolCallId,
          result: options.result(message, proof.batch.rawResults[index]) })),
        batchFingerprint: proof.batch.batchFingerprint, mode: proof.mode,
      };
      attempt = { proof, transfer: { ...payload, payloadDigest: taskUpdateDigest(payload) }, reserved: false, prepared: false,
        release: session.retainTaskUpdateTransaction() };
      attempts.set(session, attempt);
    }

    const context = { expectedDriverGeneration: attempt.proof.expectedDriverGeneration,
      taskRevision: attempt.proof.expectedRevision };
    let reserved: TaskUpdateTransferOutcome | undefined;
    if (!attempt.reserved) {
      const reserve = () => broker.reserveTaskUpdate!(token, attempt!.transfer.transferId, attempt!.transfer.payloadDigest, context);
      try { reserved = await reserve(); }
      catch (error) {
        if (errorCode(error)?.startsWith("task_update_") || errorCode(error)?.startsWith("codex_tool_")) {
          attempts.delete(session);
          attempt.release();
          if (errorCode(error) === "task_update_final_output_started") return undefined;
          throw error;
        }
        // Reservation receipt loss also recovers the identical outcome slot. A not-found
        // query alone cannot establish whether that first owner request is still in flight.
        try { reserved = await reserve(); }
        catch { throw taskUpdateSourceError("task_update_transfer_unknown", "The task update reservation is unknown; reconnect using the identical request."); }
      }
      attempt.reserved = true;
    }
    if (!attempt.prepared) {
      if (!attempt.preparationFailure) {
        try {
          session.prepareTaskUpdate(attempt.proof, attempt.transfer.transferId, attempt.transfer.payloadDigest);
          attempt.prepared = true;
        } catch (error) {
          attempt.preparationFailure = { code: errorCode(error) ?? "task_update_preparation_rejected" };
        }
      }
      if (attempt.preparationFailure) {
        // A failed preparation can only close its reserved slot. Reconnect must never
        // submit an unprepared transfer when the rejection receipt was lost.
        let rejected: TaskUpdateTransferOutcome;
        try { rejected = await broker.rejectTaskUpdateReservation!(token, attempt.transfer.transferId,
          attempt.transfer.payloadDigest, context, attempt.preparationFailure.code); }
        catch { throw taskUpdateSourceError("task_update_transfer_unknown", "The task update preparation rejection is unknown; reconnect using the identical request."); }
        return finish(rejected);
      }
    }
    if (reserved && reserved.status !== "unknown") return finish(reserved);

    let outcome: TaskUpdateTransferOutcome;
    try {
      outcome = await broker.acceptTaskUpdate!(token, attempt.transfer);
    } catch {
      // A failed receipt is not a failed commit. Query and retry the identical reserved transfer.
      try {
        outcome = await broker.taskUpdateTransferOutcome!(token, attempt.transfer.transferId);
        if (outcome.status === "unknown") outcome = await broker.acceptTaskUpdate!(token, attempt.transfer);
      } catch {
        throw taskUpdateSourceError("task_update_transfer_unknown", "The task update commit is unknown; reconnect using the identical request to recover its receipt.");
      }
    }
    return finish(outcome);

    async function finish(outcome: TaskUpdateTransferOutcome): Promise<ChatGptTurnSession | undefined> {
      if (outcome.status === "unknown") {
        throw taskUpdateSourceError("task_update_transfer_unknown", "The task update commit is unknown; the original transfer remains isolated.");
      }
      if (outcome.status === "committed") {
        session.finishTaskUpdateTransfer(outcome);
        chatGptTurnSessions.registerTaskUpdateRoute(options.executionKey, session);
        if (session.runtime.mode === "tools") {
          mirrorLatestTaskUpdateState(session.runtime.externalProgress, outcome.state);
          if (attempt!.proof.mode === "results" && !attempt!.recordedResults) {
            for (const _message of attempt!.proof.batch.messages) session.runtime.externalProgress.recordToolResult();
            attempt!.recordedResults = true;
            options.onProgress?.();
          }
          session.runtime.usageInput = parsed;
        }
        attempts.delete(session);
        attempt!.release();
        return session;
      }
      const state = await broker.taskUpdateState!(token);
      if (attempt!.prepared) session.finishTaskUpdateTransfer(outcome, { state, ownerValid: state !== undefined,
        completed: state?.finalOutputRevision !== null && state?.finalOutputRevision !== undefined });
      attempts.delete(session);
      attempt!.release();
      if (outcome.code === "task_update_final_output_started" || outcome.code === "task_update_no_boundary") return undefined;
      throw taskUpdateSourceError(outcome.code, outcome.message);
    }
  });
}
