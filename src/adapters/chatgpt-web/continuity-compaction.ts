import { createHash } from "node:crypto";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { inspectLauncherContinuityConversation, releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import { rememberCompactionContinuation, reserveCompactionContinuation } from "./compaction-continuation";
import {
  canonicalizeCompactionHandoff, existingStructuredCompactionRun, MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff, runStructuredCompactionOnce,
  settleActiveCompactionSource, settleActiveZeroRiskCompactionSource, withCompactionAbort,
} from "./compaction-handoff";
import { continuityError } from "./continuity-errors";
import { continuityCheckpointHistoryPositions } from "./continuity-binding";
import type { PreparedContinuityRequest } from "./continuity-request";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import { chatGptThreadOwnershipKey, chatGptTurnSessions } from "./turn-execution";

async function readyPage(prepared: PreparedContinuityRequest, allowRunning = false): Promise<void> {
  const { binding } = prepared;
  if (!binding.lease) throw continuityError("continuity_session_lost");
  const physical = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, binding.lease);
  if (physical.state !== "ready" && !(allowRunning && physical.state === "running")) {
    throw continuityError("continuity_session_lost");
  }
}

export async function assertContinuityCompactionResult(prepared: PreparedContinuityRequest): Promise<void> {
  const { binding, bindings, executionKey, revision } = prepared;
  bindings.assertCompactionReplay(binding, executionKey, revision);
  const lease = binding.lease!;
  // A committed compaction replay is read-only. Later work may currently own the same
  // retained lease, so physical proof may be ready or running without changing that owner.
  try { await readyPage(prepared, true); }
  catch {
    if (binding.lease?.traceId !== lease.traceId || binding.executionKey !== undefined) throw continuityError("continuity_source_unproven");
    bindings.lose(binding);
    throw continuityError("continuity_session_lost");
  }
  bindings.assertCompactionReplay(binding, executionKey, revision);
}

/** One strict transaction. HTTP observers may detach without cancelling its physical owner. */
export function runContinuityCompaction(
  parsed: CodexParsedRequest,
  prepared: PreparedContinuityRequest,
  worker: ChatGptBrowserWorker,
  broker: TurnBrokerOwner,
  capabilities: ChatGptWebCapabilities,
  namespace: string,
  configuredTimeout?: number,
  onProgress?: () => void,
): Promise<string> {
  const { binding, bindings, executionKey } = prepared;
  const cached = existingStructuredCompactionRun<string>(executionKey);
  if (binding.checkpoints.has(executionKey)) {
    bindings.assertCompactionReplay(binding, executionKey, prepared.revision);
    if (!cached) throw continuityError("continuity_source_unproven", "The committed result is no longer in the bounded replay cache.");
    return cached;
  }
  if (cached) return cached;
  const identity = extractChatGptTurnIdentity(parsed);
  const handoffTraceId = createHash("sha256").update(`${executionKey}:continuity-handoff`).digest("hex").slice(0, 12);
  return runStructuredCompactionOnce(executionKey, {
    ownerKey: `${namespace}:${chatGptThreadOwnershipKey(parsed)}`,
    traceIds: [createHash("sha256").update(executionKey).digest("hex").slice(0, 12), handoffTraceId],
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
    retainFailedResult: true,
  }, async (operatorSignal, retainOwnershipUntil) => {
    const sourceExecutionKey = prepared.sourceExecutionKey;
    const source = sourceExecutionKey ? chatGptTurnSessions.find(sourceExecutionKey) : undefined;
    if (!source || !sourceExecutionKey || binding.executionKey !== sourceExecutionKey
      || binding.revision !== prepared.revision || source.supersededError
      || chatGptTurnSessions.findConversationHead(prepared.conversationKey) !== source) {
      throw continuityError("continuity_source_unproven");
    }
    const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
    if (!manual && !(broker instanceof TurnBroker)) throw continuityError("continuity_configuration_conflict");
    const sourceRevision = extractChatGptCompactionSourceRevision(parsed);
    // The recovery table retains one exact source plus bounded hashes and owner metadata.
    const sourceEvidenceBytes = Buffer.byteLength(JSON.stringify(sourceRevision)) + 512;
    const releaseReservation = reserveCompactionContinuation(parsed, identity);
    let begun = false;
    let noControlDelivered = false;
    const timeoutMs = Math.min(configuredTimeout ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
    const deadline = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const reportProgress = (): void => {
      if (deadline.signal.aborted) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => deadline.abort(continuityError("continuity_session_lost", "The handoff stopped making progress within its bounded deadline.")), timeoutMs);
      timeout.unref?.();
      onProgress?.();
    };
    reportProgress();
    const signal = AbortSignal.any([operatorSignal, deadline.signal]);
    const acceptHandoff = (raw: string): void => {
      bindings.acceptCompactionHandoff(binding, executionKey, sourceExecutionKey, canonicalizeCompactionHandoff(parsed, raw));
      reportProgress();
    };
    retainOwnershipUntil(source.physicalSettlement);
    try {
      if (signal.aborted) throw signal.reason;
      const claim = bindings.beginCompaction(binding, executionKey, sourceExecutionKey, sourceEvidenceBytes);
      begun = true;
      try {
        if (!prepared.verifiedSourceHistory || prepared.verifiedSourceGeneration === undefined) {
          throw continuityError("continuity_source_unproven");
        }
        source.assertCompactionSourceHistory(prepared.verifiedSourceHistory, prepared.verifiedSourceGeneration);
      } catch (error) {
        bindings.abandonUndeliveredCompaction(binding, executionKey, sourceExecutionKey);
        begun = false;
        throw error;
      }
      let preserveFinalResponse = !source.isActive();
      let rawSummary: string | undefined;
      if (manual) {
        if (source.isActive()) {
          rawSummary = await withCompactionAbort(settleActiveZeroRiskCompactionSource(parsed, source, broker, signal, reportProgress, acceptHandoff), signal);
        } else {
          const outcome = await source.browserOutcome;
          if (outcome.type === "error") throw outcome.error;
          await withCompactionAbort(source.physicalSettlement, signal);
        }
        if (rawSummary === undefined) {
          await readyPage(prepared);
          bindings.abandonUndeliveredCompaction(binding, executionKey, sourceExecutionKey);
          noControlDelivered = true;
          throw continuityError("continuity_manual_handoff_required");
        }
      } else {
        if (source.isActive() && source.runtime.mode === "tools") {
          const settled = await withCompactionAbort(settleActiveCompactionSource(parsed, source, broker as TurnBroker, signal, reportProgress), signal);
          preserveFinalResponse = !settled.compactionInstructionDelivered;
        } else {
          const outcome = await source.browserOutcome;
          if (outcome.type === "error") throw outcome.error;
          await withCompactionAbort(source.physicalSettlement, signal);
          preserveFinalResponse = true;
        }
        rawSummary = await requestRetainedCompactionHandoff(worker, parsed, source, broker as TurnBroker,
          capabilities, handoffTraceId, signal, timeoutMs, reportProgress, {
            claim,
            onLease: lease => {
              if (binding.state !== "compacting" || binding.compactionKey !== executionKey
                || binding.executionKey !== sourceExecutionKey || lease.traceId !== handoffTraceId) {
                throw continuityError("continuity_source_unproven");
              }
              bindings.acceptLease(binding, lease);
            },
            onPhysicalSettlement: retainOwnershipUntil,
            onAcceptedHandoff: acceptHandoff,
          });
      }
      const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
      if (signal.aborted) throw signal.reason;
      await readyPage(prepared);
      await chatGptTurnSessions.retireContinuityExecution(sourceExecutionKey, source, prepared.conversationKey, preserveFinalResponse);
      if (signal.aborted) throw signal.reason;
      bindings.commitCompaction(
        binding,
        executionKey,
        sourceExecutionKey,
        summary,
        preserveFinalResponse,
        continuityCheckpointHistoryPositions(prepared.verifiedSourceHistory, summary),
      );
      // Capacity was reserved before the first control instruction. Only a real committed
      // handoff enters the instruction-recovery table; summary text alone is never authority.
      rememberCompactionContinuation(parsed, identity, [sourceRevision], summary);
      return summary;
    } catch (error) {
      if (!begun || noControlDelivered) throw error;
      const lease = binding.lease ? { ...binding.lease } : undefined;
      try { bindings.lose(binding); }
      catch { /* The in-memory lost state is already terminal even if the durable store failed. */ }
      source.cancel(continuityError("continuity_session_lost"));
      await source.runtime.retireCapability?.();
      if (lease) {
        const release = source.physicalSettlement.then(() => releaseLauncherRetainedConversation(
          prepared.descriptor, prepared.conversationKey, undefined, lease,
        )).then(() => undefined);
        retainOwnershipUntil(release);
        void release.catch(() => {});
      }
      if (error instanceof ChatGptWebAdapterError) throw error;
      throw continuityError("continuity_source_unproven", "The handoff did not commit; already accepted results were not re-executed.");
    } finally {
      clearTimeout(timeout);
      releaseReservation();
    }
  });
}
