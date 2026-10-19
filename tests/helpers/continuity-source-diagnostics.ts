import { spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as bindingModule from "../../src/adapters/chatgpt-web/continuity-binding";
import * as continuationModule from "../../src/adapters/chatgpt-web/continuity-recovery-continuation";
import * as compactionModule from "../../src/adapters/chatgpt-web/continuity-recovery-compaction";
import * as environmentModule from "../../src/adapters/chatgpt-web/environment-instruction";
import type { RecoveryThreadRecord } from "../../src/adapters/chatgpt-web/continuity-recovery-store";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../../src/responses/compaction";
import type { CodexParsedRequest } from "../../src/types";

interface SourceDiagnosticContext {
  scenario: string;
  format: "v1" | "v2";
  round: number;
  change: string;
  statePath: string;
  threadId: string;
  submissions(): number;
}

const digest = bindingModule.continuityDigest;
const id = (value: unknown) => value === undefined ? null : digest(value);
const errorCode = (error: unknown) => {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^continuity_[a-z_]+$/.test(code) ? code : "other-error";
  } catch { return "other-error"; }
};
function unavailable(stage: string): void {
  try { process.stderr.write(`[continuity-source-diagnostic-unavailable] ${stage}\n`); }
  catch { /* Diagnostic output cannot replace a request result or exception. */ }
}

function summaryDigests(parsed: CodexParsedRequest): Set<string> {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  const summaries = new Set<string>();
  for (const item of input ?? []) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(value.type))) {
      const summary = typeof value.encrypted_content === "string" ? decodeCompactionSummary(value.encrypted_content) : null;
      if (summary !== null) summaries.add(digest(summary));
    } else if (value.role === "user") {
      const text = typeof value.content === "string" ? value.content : Array.isArray(value.content)
        ? value.content.map(part => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("\n") : "";
      if (text.startsWith(`${SUMMARY_PREFIX}\n`)) summaries.add(digest(text.slice(SUMMARY_PREFIX.length + 1)));
    }
  }
  return summaries;
}

function durableState(record: RecoveryThreadRecord | continuationModule.RecoveryContinuationRecord | undefined) {
  if (record && !("owner" in record)) return null;
  return record ? {
    thread: id(record.thread), scope: id(record.scope), version: record.version, epoch: record.epoch, historyRevision: record.historyRevision,
    owner: id(record.owner.id), ownerPid: record.owner.pid, ownerStart: id(record.owner.startIdentity),
    currentWork: id(record.currentWorkId), state: record.state,
    transaction: record.transaction ? { id: id(record.transaction.transactionId), version: record.transaction.version,
      work: id(record.transaction.logicalWorkId), stage: record.transaction.stage, writerRetired: record.transaction.writerRetired } : null,
  } : null;
}

// Read fixture bytes directly. Do not call lookup(), instruction extraction, or any
// selector for observation: those calls can refresh registration or cache evidence.
function snapshot(context: SourceDiagnosticContext) {
  let record: RecoveryThreadRecord | undefined;
  let durableRead: { status: string } = { status: "present" };
  let bytes: string | undefined;
  try {
    bytes = readFileSync(join(context.statePath, "recovery.json"), "utf8");
  } catch (error) {
    durableRead = { status: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "file-missing" : "read-error" };
  }
  if (bytes !== undefined) {
    let document: unknown;
    try { document = JSON.parse(bytes); }
    catch { durableRead = { status: "parse-error" }; }
    if (durableRead.status === "present") {
      const threads = document && typeof document === "object" && "threads" in document ? document.threads : undefined;
      if (!threads || typeof threads !== "object" || Array.isArray(threads)) durableRead = { status: "invalid-document" };
      else {
        record = (threads as Record<string, RecoveryThreadRecord>)[digest(context.threadId)];
        if (!record) durableRead = { status: "thread-missing" };
      }
    }
  }
  const live = bindingModule.existingContinuityBindings(context.statePath)?.observed(digest(context.threadId));
  return { durableRead, durable: durableState(record), live: live ? { owner: id(live.owner), epoch: live.epoch,
    revision: live.revision, state: live.state, checkpointCount: live.checkpoints.size } : null, submissions: context.submissions() };
}

/** Opt in with CGW_CONTINUITY_SOURCE_DIAGNOSTICS=1. Only real selector calls are
 * observed; the original functions receive the same objects exactly once. Output
 * contains fixed scenario labels, scalar state, and hashes, never request bodies. */
export async function withContinuitySourceDiagnostics<T>(
  parsed: CodexParsedRequest,
  context: SourceDiagnosticContext,
  run: () => Promise<T>,
): Promise<T> {
  if (process.env.CGW_CONTINUITY_SOURCE_DIAGNOSTICS !== "1") return run();
  const events: Array<Record<string, unknown>> = [];
  const diagnosticFailures: string[] = [];
  const observe = <V>(stage: string, action: () => V): V | undefined => {
    try { return action(); }
    catch { diagnosticFailures.push(stage); return undefined; }
  };
  const frames: Array<{ parsed: CodexParsedRequest; carried: Array<Record<string, unknown>>; representations: readonly (readonly string[])[] }> = [];
  let sequence = 0;
  const originalLive = bindingModule.selectContinuityCheckpoint;
  const originalDurable = continuationModule.selectRecoveryContinuation;
  const originalCarried = environmentModule.requestCarriedChatGptInstructionRevision;
  const originalTarget = compactionModule.selectRecoveryCompactionTarget;
  const originalPrepare = compactionModule.prepareRecoveryCompaction;
  const originalFresh = compactionModule.prepareFreshRecoveryCompaction;
  const requestDigest = observe("request-digest", () => digest(parsed._rawBody));
  const before = observe("before-snapshot", () => snapshot(context));
  const restorers: Array<() => void> = [];
  const restore = () => { for (const undo of restorers.reverse()) observe("restore", undo); };
  try {
    const targetSpy = spyOn(compactionModule, "selectRecoveryCompactionTarget");
    restorers.push(() => targetSpy.mockRestore());
    targetSpy.mockImplementation((request, record) => {
      const event = observe("compaction-target-candidates", () => {
        const summaries = summaryDigests(request);
        const event: Record<string, unknown> = { sequence: ++sequence, path: "compaction-target", state: durableState(record),
          targets: Object.values(record.compactionTargets).map(target => ({ target: id(target.compactionTargetId),
            sourceWork: id(target.sourceLogicalWorkId), sourceIdentity: id(target.sourceIdentity),
            sourceHistoryRevision: target.sourceHistoryRevision, representations: target.representationDigests })),
          summaryCandidateCount: Object.values(record.checkpoints).filter(checkpoint => summaries.has(checkpoint.summaryDigest)).length };
        events.push(event);
        return event;
      });
      try {
        const result = originalTarget(request, record);
        observe("compaction-target-result", () => {
          if (event) event.result = result ? { target: id(result.target.compactionTargetId), sourceWork: id(result.source.logicalWorkId),
            commit: id(result.checkpoint?.commitId), sourceRepresentation: bindingModule.continuitySourceRepresentationDigest(request, result.sourceRevision) } : null;
        });
        return result;
      } catch (error) { if (event) event.error = errorCode(error); throw error; }
    });
    const prepareSpy = spyOn(compactionModule, "prepareRecoveryCompaction");
    restorers.push(() => prepareSpy.mockRestore());
    prepareSpy.mockImplementation(async (...args) => {
      const event = observe("compaction-prepare", () => {
        const event: Record<string, unknown> = { sequence: ++sequence, path: "compaction-prepare", entry: "durable",
          state: durableState(args[6]), existingTarget: id(args[11]) };
        events.push(event);
        return event;
      });
      try {
        const result = await originalPrepare(...args);
        observe("compaction-prepare-result", () => { if (event) event.result = result ? "prepared" : "retained-routing"; });
        return result;
      } catch (error) { if (event) event.error = errorCode(error); throw error; }
    });
    const freshSpy = spyOn(compactionModule, "prepareFreshRecoveryCompaction");
    restorers.push(() => freshSpy.mockRestore());
    freshSpy.mockImplementation(async (...args) => {
      const event = observe("fresh-compaction-prepare", () => {
        const event: Record<string, unknown> = { sequence: ++sequence, path: "compaction-prepare", entry: "fresh" };
        events.push(event);
        return event;
      });
      try {
        const result = await originalFresh(...args);
        observe("fresh-compaction-prepare-result", () => { if (event) event.result = "prepared"; });
        return result;
      } catch (error) { if (event) event.error = errorCode(error); throw error; }
    });
    const carriedSpy = spyOn(environmentModule, "requestCarriedChatGptInstructionRevision");
    restorers.push(() => carriedSpy.mockRestore());
    carriedSpy.mockImplementation((request, turnId) => {
      const source = originalCarried(request, turnId);
      observe("carried-source", () => {
        const frame = frames.at(-1);
        if (frame?.parsed === request) {
          const representation = source ? bindingModule.continuitySourceRepresentationDigest(request, source) : undefined;
          frame.carried.push({ expectedTurn: id(turnId), source: source ? {
            item: id(source.itemId), turn: id(source.turnId), contentDigest: digest(source.content), representationDigest: representation,
            matchesInCandidateOrder: frame.representations.map(values => values.includes(representation!)),
          } : null });
        }
      });
      return source;
    });
    const liveSpy = spyOn(bindingModule, "selectContinuityCheckpoint");
    restorers.push(() => liveSpy.mockRestore());
    liveSpy.mockImplementation((request, identity) => {
      const observation = observe("live-candidates", () => {
        const live = bindingModule.existingContinuityBindings(context.statePath)?.observed(digest(context.threadId));
        const summaries = summaryDigests(request);
        const candidates = [...live?.checkpoints ?? []];
        const frame = { parsed: request, carried: [] as Array<Record<string, unknown>>,
          representations: candidates.map(([, checkpoint]) => checkpoint.sourceRepresentationDigests ?? []) };
        const event: Record<string, unknown> = { sequence: ++sequence, path: "live", turn: id(identity.turnId), candidateStage: "retained-before-selector",
          retainedCount: candidates.length, summaryCandidateCount: candidates.filter(([, checkpoint]) => checkpoint.sourceInstruction
            && summaries.has(digest(checkpoint.summary))).length,
          candidates: candidates.map(([key, checkpoint]) => ({ key: id(key), revision: checkpoint.revision,
            summaryDigest: digest(checkpoint.summary), summaryMatches: summaries.has(digest(checkpoint.summary)),
            source: checkpoint.sourceInstruction ? { item: id(checkpoint.sourceInstruction.itemId), turn: id(checkpoint.sourceInstruction.turnId),
              contentDigest: digest(checkpoint.sourceInstruction.content) } : null,
            representations: checkpoint.sourceRepresentationDigests ?? [], consumerTurn: id(checkpoint.continuationNativeTurnId) })),
          carried: frame.carried };
        events.push(event);
        return { event, frame };
      });
      if (observation) frames.push(observation.frame);
      try {
        const result = originalLive(request, identity);
        observe("live-result", () => {
          if (observation) observation.event.result = result ? { selectedKey: id(result.key), revision: result.checkpoint.revision, summaryIndex: result.summaryIndex } : null;
        });
        return result;
      } catch (error) { if (observation) observation.event.error = errorCode(error); throw error; }
      finally { if (observation) frames.pop(); }
    });
    const durableSpy = spyOn(continuationModule, "selectRecoveryContinuation");
    restorers.push(() => durableSpy.mockRestore());
    durableSpy.mockImplementation((request, record, identity) => {
      const observation = observe("durable-candidates", () => {
        const summaries = summaryDigests(request);
        const candidates = Object.values(record.checkpoints);
        const frame = { parsed: request, carried: [] as Array<Record<string, unknown>>,
          representations: candidates.map(checkpoint => checkpoint.representationDigests) };
        const event: Record<string, unknown> = { sequence: ++sequence, path: "durable", turn: id(identity.turnId),
          state: durableState(record), retainedCount: candidates.length,
          workRelations: Object.values(record.works).map(work => ({ work: id(work.logicalWorkId), instruction: id(work.instructionIdentity),
            turn: id(work.nativeTurnId), purpose: work.purpose, state: work.state, lineage: id(work.workLineageId),
            payloadDigest: work.workPayloadDigest, acceptedTaskRevision: work.acceptedTaskRevision,
            predecessor: id(work.predecessorLogicalWorkId), allowRetainedSourceFallback: work.allowRetainedSourceFallback ?? false })),
          summaryCandidateCount: candidates.filter(checkpoint => summaries.has(checkpoint.summaryDigest)).length,
          candidates: candidates.map(checkpoint => ({ commit: id(checkpoint.commitId), summaryDigest: checkpoint.summaryDigest,
            summaryMatches: summaries.has(checkpoint.summaryDigest), sourceWork: id(checkpoint.sourceLogicalWorkId),
            sourceIdentity: id(checkpoint.sourceIdentity), sourceTurn: id(record.works[checkpoint.sourceLogicalWorkId]?.nativeTurnId),
            sourceHistoryRevision: checkpoint.sourceHistoryRevision, targetHistoryRevision: checkpoint.targetHistoryRevision,
            representations: checkpoint.representationDigests, continuation: checkpoint.continuation.state,
            consumerWork: id(checkpoint.continuation.consumerLogicalWorkId), consumerTurn: id(checkpoint.continuation.nativeTurnId) })),
          carried: frame.carried };
        events.push(event);
        return { event, frame };
      });
      if (observation) frames.push(observation.frame);
      try {
        const result = originalDurable(request, record, identity);
        observe("durable-result", () => {
          if (observation) observation.event.result = result ? { commit: id(result.checkpoint.commitId), sourceWork: id(result.checkpoint.sourceLogicalWorkId),
            work: id(result.work.logicalWorkId), consumerWork: id(result.consumerLogicalWorkId), action: result.action, summaryIndex: result.summaryIndex } : null;
        });
        return result;
      } catch (error) { if (observation) observation.event.error = errorCode(error); throw error; }
      finally { if (observation) frames.pop(); }
    });
  } catch {
    restore(); unavailable("observer-setup");
    return run();
  }
  let outcome: Record<string, unknown> = { status: "accepted" };
  try { return await run(); }
  catch (error) { outcome = { status: "rejected", code: errorCode(error) }; throw error; }
  finally {
    restore();
    try {
      // Repeated cached lookups retain their event order without repeating the same
      // candidate metadata in the log. Each event indexes this request's observations.
      const observations: Array<Record<string, unknown>> = [];
      const observationIds = new Map<string, number>();
      const orderedEvents = events.map(({ sequence, ...observation }) => {
        const key = JSON.stringify(observation);
        let index = observationIds.get(key);
        if (index === undefined) { index = observations.length; observationIds.set(key, index); observations.push(observation); }
        return { sequence, observation: index };
      });
      console.error(`[continuity-source-diagnostic] ${JSON.stringify({ schemaVersion: 2, scenario: context.scenario,
        format: context.format, round: context.round, change: context.change, pid: process.pid, platform: process.platform, arch: process.arch,
        bunVersion: Bun.version, stateDirectoryDigest: digest(context.statePath), thread: id(digest(context.threadId)),
        requestDigest, before, events: orderedEvents, observations, outcome,
        after: observe("after-snapshot", () => snapshot(context)), diagnosticFailures,
        unobserved: ["selector cache hit or miss", "candidate counts after internal relation filters", "page reconciliation decisions"] })}`);
    } catch { unavailable("report-output"); }
  }
}
