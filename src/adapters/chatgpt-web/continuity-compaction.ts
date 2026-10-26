import { CompactionDeadline } from "./compaction-deadline";
import { createHash } from "node:crypto";
import { estimateTokens } from "../../lib/token-estimate";
import { isChatGptWebZeroRiskBackendModel } from "../../chatgpt-web-models";
import { inspectLauncherContinuityConversation, releaseLauncherRetainedConversation } from "../../launcher-browser-host";
import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptBrowserWorker } from "./browser-worker";
import {
  canonicalizeCompactionHandoff, existingStructuredCompactionRun, MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff, runStructuredCompactionOnce,
  retainStructuredCompactionFailure,
  settleActiveCompactionSource, settleActiveZeroRiskCompactionSource, withCompactionAbort,
} from "./compaction-handoff";
import { continuitySourceRepresentationDigest, type ContinuityClaim, type ContinuityToolResultReplayEvidence } from "./continuity-binding";
import { continuityError } from "./continuity-errors";
import { compactionSourceWasDelegation, compactionSourceWasGoal, CONTINUITY_GOAL_SOURCE, CONTINUITY_DELEGATION_SOURCE, CONTINUITY_IDENTITY_ONLY_SOURCE, isDurableCompactionSourceIdentity } from "./compaction-continuation";
import { taskUpdateSourceError } from "./task-update-source";
import { assertCompactionReadable, captureRetainedCompactionSource, compactionSourcePageCost } from "./compaction-context";
import {
  acceptHealthyRecoveryCompactionLease, admitHealthyRecoveryCompaction, assertHealthyRecoveryCompactionAuthority, assertRecoveryCompactionResult,
  beginHealthyRecoveryCompaction, commitRecoveryCompaction, failHealthyRecoveryCompaction,
  assertRecoveryCompactionNotStopped, isRecoveryCompaction, markHealthyRecoveryCompactionAccepted, markHealthyRecoveryCompactionSend,
  prepareHealthyRecoveryCompactionControl, recoveryCompactionTarget, runRecoveryCompaction,
  type StartManualRecoveryCompaction,
} from "./continuity-recovery-compaction";
import { continuityToolRegistry } from "./continuity-tools";
import type { ContextSnapshot } from "./context-snapshot";
import type { PreparedContinuityRequest } from "./continuity-request";
import { extractChatGptCompactionSourceRevision, extractChatGptCompactV1SourceRevision, extractChatGptTurnIdentity } from "./environment";
import type { ChatGptWebCapabilities } from "./model";
import { TurnBroker, type TurnBrokerOwner } from "./turn-broker";
import {
  assertContinuitySourceInstructionReplay, assertContinuityToolResultReplayEvidence, chatGptContinuityCompactionRequestDigest,
  chatGptThreadOwnershipKey, chatGptTurnSessions,
} from "./turn-execution";

async function readyPage(prepared: PreparedContinuityRequest): Promise<void> {
  const { binding } = prepared;
  if (!binding.lease) throw continuityError("continuity_session_lost");
  const physical = await inspectLauncherContinuityConversation(prepared.descriptor, prepared.conversationKey, binding.lease, { compaction: true });
  if (physical.state !== "ready") {
    throw continuityError("continuity_session_lost");
  }
}

export async function assertContinuityCompactionResult(prepared: PreparedContinuityRequest): Promise<void> {
  if (isRecoveryCompaction(prepared)) return assertRecoveryCompactionResult(prepared);
  const { binding, bindings, executionKey, revision } = prepared;
  bindings.assertCompactionReplay(binding, executionKey, revision);
}

/** Share the exact retained-source replay checks with preview observers. */
function retainedCompactionAdmission(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest, namespace: string) {
  const { binding, bindings, executionKey } = prepared;
  const checkpoint = binding.checkpoints.get(executionKey);
  const replaySourceKey = checkpoint?.sourceExecutionKey ?? prepared.sourceExecutionKey;
  const replaySource = replaySourceKey ? chatGptTurnSessions.find(replaySourceKey) : undefined;
  if (checkpoint?.sourceResultReplay) assertContinuityToolResultReplayEvidence(parsed, checkpoint.sourceResultReplay);
  const resultEvidence = checkpoint?.sourceResultReplay ?? replaySource?.continuityToolResultReplayEvidence(parsed);
  if (!resultEvidence) throw continuityError("continuity_source_unproven");
  const requestDigest = chatGptContinuityCompactionRequestDigest(parsed, resultEvidence);
  const identity = extractChatGptTurnIdentity(parsed);
  const handoffTraceId = createHash("sha256").update(`${executionKey}:continuity-handoff`).digest("hex").slice(0, 12);
  const owner = {
    ownerKey: `${namespace}:${chatGptThreadOwnershipKey(parsed)}:${binding.pageGeneration ?? parsed._continuityPageGeneration}`,
    page: { directory: bindings.registrations.directory, thread: binding.thread,
      epoch: binding.pageGeneration ?? parsed._continuityPageGeneration! },
    traceIds: [createHash("sha256").update(executionKey).digest("hex").slice(0, 12), handoffTraceId],
    nativeThreadId: identity.threadId, nativeTurnId: identity.turnId,
    requestDigest,
  };
  const cached = existingStructuredCompactionRun<string>(executionKey, requestDigest);
  if (cached) {
    const assertCommittedPayload = (): void => {
      const committed = binding.checkpoints.get(executionKey);
      if (!committed?.sourceResultReplay || !committed.sourceInstructionReplay) {
        throw continuityError("continuity_source_unproven", "The retained compaction replay has no local payload comparison evidence.");
      }
      assertContinuitySourceInstructionReplay(parsed, committed.sourceInstructionReplay);
      assertContinuityToolResultReplayEvidence(parsed, committed.sourceResultReplay);
    };
    if (checkpoint) {
      bindings.assertCompactionReplay(binding, executionKey, prepared.revision);
      assertCommittedPayload();
    } else {
      replaySource?.assertContinuitySourceInstruction(parsed);
      replaySource?.assertContinuityToolResultReplay(parsed);
    }
    existingStructuredCompactionRun<string>(executionKey, requestDigest, owner);
    // A concurrent retry can arrive before the first result batch is accepted under the
    // source lock. Recheck against its committed evidence before returning the shared summary.
    return { owner, cached: cached.then(summary => { assertCommittedPayload(); return summary; }) };
  }
  if (checkpoint) {
    bindings.assertCompactionReplay(binding, executionKey, prepared.revision);
    throw continuityError("continuity_source_unproven", "The committed result is no longer in the bounded replay cache.");
  }
  return { owner, cached: undefined };
}

/** Capture an existing healthy run without permission to start another run. */
export function observeRetainedCompaction(parsed: CodexParsedRequest, prepared: PreparedContinuityRequest,
  namespace: string): Promise<string> | undefined {
  return retainedCompactionAdmission(parsed, prepared, namespace).cached;
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
  onRecovered?: () => void,
  startManual?: StartManualRecoveryCompaction,
): Promise<string> {
  if (isRecoveryCompaction(prepared)) {
    return runRecoveryCompaction(parsed, prepared, worker, broker, capabilities, namespace, configuredTimeout, onProgress, onRecovered, startManual);
  }
  const { binding, bindings, executionKey } = prepared;
  const { owner, cached } = retainedCompactionAdmission(parsed, prepared, namespace);
  if (cached) return cached;
  const identity = extractChatGptTurnIdentity(parsed);
  const handoffTraceId = createHash("sha256").update(`${executionKey}:continuity-handoff`).digest("hex").slice(0, 12);
  return runStructuredCompactionOnce(executionKey, owner, async (operatorSignal, retainOwnershipUntil) => {
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
    if (sourceRevision.itemId) sourceRevision.itemId = parsed._chatGptMessageIdAliases?.[sourceRevision.itemId] ?? sourceRevision.itemId;
    const sourceWasDelegation = compactionSourceWasDelegation(parsed, sourceRevision);
    const sourceIdentityOnly = isDurableCompactionSourceIdentity(parsed, sourceRevision);
    const sourceInstructionReplay = source.continuitySourceInstructionReplayEvidence();
    let sourceResultReplay: ContinuityToolResultReplayEvidence | undefined;
    let sourceSnapshot: ContextSnapshot | undefined;
    let begun = false;
    let durableCompactionWorkId: string | undefined;
    let noControlDelivered = false;
    const timeoutMs = Math.min(configuredTimeout ?? MAX_COMPACTION_HANDOFF_TIMEOUT_MS, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
    let budget = new CompactionDeadline(Date.now() + timeoutMs);
    const deadline = new AbortController();
    let stopDeadline = budget.watch(() => deadline.abort(continuityError("continuity_session_lost", "The handoff exceeded its original deadline.")));
    const reportProgress = (): void => {
      if (deadline.signal.aborted) return;
      if (budget.remainingMs() <= 0) deadline.abort(continuityError("continuity_session_lost", "The handoff exceeded its original deadline."));
      onProgress?.();
    };
    reportProgress();
    const signal = AbortSignal.any([operatorSignal, deadline.signal]);
    const acceptHandoff = (raw: string): void => {
      if (durableCompactionWorkId) assertHealthyRecoveryCompactionAuthority(prepared);
      bindings.acceptCompactionHandoff(binding, executionKey, sourceExecutionKey, canonicalizeCompactionHandoff(parsed, raw));
      reportProgress();
    };
    try {
      if (signal.aborted) throw signal.reason;
      let claim: ContinuityClaim | undefined;
      const begin = async (): Promise<ContinuityClaim> => {
        signal.throwIfAborted();
        if (prepared.verifiedSourceGeneration === undefined) {
          throw continuityError("continuity_source_unproven");
        }
        if (source.taskUpdatesEnabled() && source.runtime.mode === "tools") {
          const liveState = await broker.taskUpdateState?.(await source.runtime.token, { compaction: true });
          // A completed source retains its admitted completion receipt in the page
          // Session; its retired Broker no longer owns an update journal or ACK files.
          const receipt = !source.isActive() ? source.runtime.taskUpdates?.outputReceipt : undefined;
          const state = liveState ?? (receipt?.kind === "completed" ? {
            acceptedRevision: receipt.taskRevision, acknowledgedRevision: receipt.taskRevision,
            driverGeneration: receipt.driverGeneration,
          } : undefined);
          if (source.hasPendingTaskUpdate() || !state || state.acknowledgedRevision !== state.acceptedRevision) {
            throw taskUpdateSourceError("task_update_pending", "Confirm the accepted task updates before starting compaction. Current work continues.");
          }
          if (source.isActive()) source.assertDriverGeneration(state.driverGeneration);
          if (source.driverGeneration() !== state.driverGeneration || source.taskRevision() !== state.acceptedRevision
            || source.isTaskUpdateCancelled()) throw taskUpdateSourceError("task_update_source_stale", "The task update source advanced before compaction.");
        }
        source.assertContinuityCompactionResultBatch(parsed);
        const resultReplay = source.continuityToolResultReplayEvidence(parsed);
        source.assertContinuityGeneration(prepared.verifiedSourceGeneration);
        signal.throwIfAborted();
        await source.runtime.syncContextUsage?.({ compaction: true });
        signal.throwIfAborted();
        if (!manual || source.isActive()) {
          const coverage = source.runtime.compactionSourceCoverage;
          if (!coverage) throw continuityError("continuity_source_unproven", "Compaction has no accepted source coverage evidence.");
          source.prepareCompactionToolResults(parsed, source.outstanding().map(request => request.callId));
          sourceSnapshot = captureRetainedCompactionSource(parsed, source);
          await assertCompactionReadable(sourceSnapshot);
          signal.throwIfAborted();
        }
        // The checkpoint budget retains one exact source plus bounded local result comparison data.
        const sourceEvidenceBytes = Buffer.byteLength(JSON.stringify(sourceRevision))
          + Buffer.byteLength(JSON.stringify(resultReplay))
          + Buffer.byteLength(JSON.stringify(sourceInstructionReplay))
          + Buffer.byteLength(JSON.stringify(identity.turnId)) + 128 + 512;
        const accepted = bindings.beginCompaction(binding, executionKey, sourceExecutionKey, sourceEvidenceBytes);
        try {
          if (!manual || source.isActive()) {
            durableCompactionWorkId = beginHealthyRecoveryCompaction(parsed, prepared, budget.remainingMs());
            if (durableCompactionWorkId) {
              stopDeadline();
              budget = bindings.recoveryStore.compactionDeadline(binding.thread, durableCompactionWorkId);
              stopDeadline = budget.watch(() => deadline.abort(continuityError("continuity_session_lost", "The handoff exceeded its original deadline.")));
              reportProgress();
            }
          }
        } catch (error) {
          bindings.abandonUndeliveredCompaction(binding, executionKey, sourceExecutionKey);
          throw error;
        }
        if (source.continuityToolSearchResults(parsed).length > 0) {
          binding.discoveredTools = continuityToolRegistry(parsed, binding, source).discoveredTools;
        }
        sourceResultReplay = resultReplay;
        begun = true;
        claim = accepted;
        retainStructuredCompactionFailure(executionKey);
        retainOwnershipUntil(source.physicalSettlement);
        return accepted;
      };
      let preserveFinalResponse = !source.isActive();
      let rawSummary: string | undefined;
      if (manual) {
        if (source.isActive()) {
          rawSummary = await source.runExclusive(async () => {
            await begin();
            return withCompactionAbort(
              settleActiveZeroRiskCompactionSource(parsed, source, broker, signal, reportProgress, acceptHandoff, true, capabilities, sourceSnapshot),
              signal,
            );
          });
        } else {
          await source.runExclusive(async () => { await begin(); });
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
          const settled = await source.runExclusive(async () => {
            await begin();
            return withCompactionAbort(
              settleActiveCompactionSource(parsed, source, broker as TurnBroker, signal, reportProgress, true),
              signal,
            );
          });
          preserveFinalResponse = !settled.compactionInstructionDelivered;
        } else {
          await source.runExclusive(async () => { await begin(); });
          const outcome = await source.browserOutcome;
          if (outcome.type === "error") throw outcome.error;
          await withCompactionAbort(source.physicalSettlement, signal);
          preserveFinalResponse = true;
        }
        if (!claim) throw continuityError("continuity_source_unproven");
        await source.runtime.retireCapability?.({ compaction: true });
        const ordinaryFinal = preserveFinalResponse ? source.settledOutcome() : undefined;
        durableCompactionWorkId = admitHealthyRecoveryCompaction(parsed, prepared,
          ordinaryFinal?.type === "final" ? ordinaryFinal.answer : undefined);
        reportProgress();
        rawSummary = await requestRetainedCompactionHandoff(worker, parsed, source, broker as TurnBroker,
          capabilities, handoffTraceId, signal, budget.remainingMs(), reportProgress, {
            claim, sourceSnapshot,
            ...(durableCompactionWorkId ? {
              recoveryStoreDirectory: bindings.registrations.directory,
              onPrepared: (instruction: string) => prepareHealthyRecoveryCompactionControl(prepared, instruction),
              onSendActivated: () => markHealthyRecoveryCompactionSend(prepared),
              onSubmitted: () => markHealthyRecoveryCompactionAccepted(prepared),
            } : {}),
            onLease: lease => {
              if (binding.state !== "compacting" || binding.compactionKey !== executionKey
                || binding.executionKey !== sourceExecutionKey || lease.traceId !== handoffTraceId) {
                throw continuityError("continuity_source_unproven");
              }
              if (durableCompactionWorkId) acceptHealthyRecoveryCompactionLease(prepared, lease);
              bindings.acceptLease(binding, lease);
            },
            onPhysicalSettlement: retainOwnershipUntil,
            onAcceptedHandoff: acceptHandoff,
          });
      }
      const summary = canonicalizeCompactionHandoff(parsed, rawSummary);
      const sourcePageTokens = Math.max(binding.retainedPageTokens ?? 0,
        source.runtime.compactionSourceCoverage?.pageTokenReserve() ?? 0);
      const compactionPageTokens = sourceSnapshot ? await compactionSourcePageCost(broker, sourceSnapshot) : undefined;
      if (signal.aborted) throw signal.reason;
      await readyPage(prepared);
      await chatGptTurnSessions.retireContinuityExecution(sourceExecutionKey, source, prepared.conversationKey, preserveFinalResponse);
      if (signal.aborted) throw signal.reason;
      if (!sourceResultReplay) throw continuityError("continuity_source_unproven");
      const ordinaryFinal = preserveFinalResponse ? source.settledOutcome() : undefined;
      durableCompactionWorkId = admitHealthyRecoveryCompaction(parsed, prepared,
        ordinaryFinal?.type === "final" ? ordinaryFinal.answer : undefined);
      const durableTarget = recoveryCompactionTarget(parsed);
      if (durableCompactionWorkId && durableTarget) {
        commitRecoveryCompaction(parsed, prepared, durableTarget, durableCompactionWorkId, summary, preserveFinalResponse);
      }
      bindings.commitCompaction(
        binding,
        executionKey,
        sourceExecutionKey,
        summary,
        preserveFinalResponse,
        sourceResultReplay,
        sourceInstructionReplay,
        sourceRevision,
        [...new Set([
          ...[sourceRevision, extractChatGptCompactV1SourceRevision(parsed, summary)]
            .map(revision => continuitySourceRepresentationDigest(parsed, revision)),
          ...(sourceWasDelegation ? [CONTINUITY_DELEGATION_SOURCE] : []),
          ...(compactionSourceWasGoal(parsed, sourceRevision) ? [CONTINUITY_GOAL_SOURCE] : []),
          ...(sourceIdentityOnly ? [CONTINUITY_IDENTITY_ONLY_SOURCE] : []),
        ])],
        identity.turnId,
      );
      binding.retainedPageTokens = compactionPageTokens === undefined ? undefined
        : sourcePageTokens + compactionPageTokens + estimateTokens(summary);
      source.runtime.compactionSourceCoverage?.checkpointCommitted(prepared.revision);
      return summary;
    } catch (error) {
      try { assertRecoveryCompactionNotStopped(parsed, prepared); }
      catch (stopped) {
        source.cancel(stopped instanceof Error ? stopped : continuityError("continuity_stopped"));
        await source.runtime.retireCapability?.({ compaction: true });
        const lease = binding.lease ? { ...binding.lease } : undefined;
        if (lease) {
          const release = source.physicalSettlement.then(() => releaseLauncherRetainedConversation(
            prepared.descriptor, prepared.conversationKey, undefined, lease, { compaction: true },
          )).then(() => undefined);
          retainOwnershipUntil(release);
          void release.catch(() => {});
        }
        throw stopped;
      }
      if (!begun || noControlDelivered) throw error;
      if (durableCompactionWorkId) {
        try { assertHealthyRecoveryCompactionAuthority(prepared); }
        catch {
          if (error instanceof ChatGptWebAdapterError) throw error;
          throw continuityError("continuity_source_unproven", "The late handoff cannot retire a newer compaction attempt.");
        }
      }
      const lease = binding.lease ? { ...binding.lease } : undefined;
      try { bindings.lose(binding); }
      catch { /* The in-memory lost state is already terminal even if the durable store failed. */ }
      source.cancel(continuityError("continuity_session_lost"));
      await source.runtime.retireCapability?.({ compaction: true });
      await failHealthyRecoveryCompaction(parsed, prepared);
      if (lease) {
        const release = source.physicalSettlement.then(() => releaseLauncherRetainedConversation(
          prepared.descriptor, prepared.conversationKey, undefined, lease, { compaction: true },
        )).then(() => undefined);
        retainOwnershipUntil(release);
        void release.catch(() => {});
      }
      if (error instanceof ChatGptWebAdapterError) throw error;
      throw continuityError("continuity_source_unproven", "The handoff did not commit; already accepted results were not re-executed.");
    } finally {
      stopDeadline();
    }
  });
}
