import { createHash } from "node:crypto";
import { CONTEXT_REUSE_MAX_BYTES, CONTEXT_REUSE_MAX_UNITS, type ContextReuseBaseline, type ContextReuseDependency, type ContextReuseDeliveryEvidence } from "./context-reuse-types";
import type { RecoveryThreadRecord } from "./continuity-recovery-store";
import type { RuntimeRecoveryReference } from "./continuity-recovery-runtime";

/** Stable physical lineage. Execution traces and per-turn transaction IDs are excluded. */
export function contextReusePageIdentity(ref: RuntimeRecoveryReference, record: RecoveryThreadRecord): string {
  return createHash("sha256").update(JSON.stringify([ref.directory, record.thread, record.scope, record.owner.id, record.epoch])).digest("hex");
}
export function boundedContextReuse(value: { units: readonly unknown[] }): boolean {
  return value.units.length <= CONTEXT_REUSE_MAX_UNITS && Buffer.byteLength(JSON.stringify(value)) <= CONTEXT_REUSE_MAX_BYTES;
}
export function contextReuseMatches(baseline: ContextReuseBaseline | undefined, dependency: ContextReuseDependency): boolean {
  return !!baseline && baseline.baseline_id === dependency.baseline_id && baseline.page_identity === dependency.page_identity
    && baseline.predecessor === dependency.predecessor && dependency.units.every(unit => baseline.units.some(saved =>
      saved.unit_id === unit.unit_id && saved.fingerprint === unit.fingerprint));
}
export function contextReuseBaseline(evidence: ContextReuseDeliveryEvidence, pageIdentity: string, predecessor: string): ContextReuseBaseline | undefined {
  const value: ContextReuseBaseline = { baseline_id: createHash("sha256").update(JSON.stringify([pageIdentity, predecessor, evidence])).digest("hex"),
    page_identity: pageIdentity, predecessor, units: evidence.units, snapshots: evidence.snapshots };
  return boundedContextReuse(value) ? value : undefined;
}

/** Appended work preserves the original completed predecessor through its durable lineage. */
export function contextReusePredecessor(record: RecoveryThreadRecord, workId: string, predecessor: string): boolean {
  let work = record.works[workId];
  const previous = record.works[predecessor];
  if (!work || !previous || previous.state !== "completed" || previous.purpose !== "ordinary"
    || previous.attempts.at(-1)?.epoch !== record.epoch) return false;
  const visited = new Set<string>();
  while (work && !visited.has(work.logicalWorkId)) {
    visited.add(work.logicalWorkId);
    const attempt = work.attempts.at(-1);
    if (work.purpose !== "ordinary" || work.state === "stopped" || attempt?.epoch !== record.epoch) return false;
    if (work.predecessorLogicalWorkId === predecessor || !!work.instructionPrevious
      && work.instructionPrevious.instructionIdentity === previous.instructionIdentity
      && (work.instructionPrevious.nativeTurnId === undefined || work.instructionPrevious.nativeTurnId === previous.nativeTurnId)) return true;
    const parent = work.predecessorLogicalWorkId ? record.works[work.predecessorLogicalWorkId] : undefined;
    if (!parent || parent.workLineageId !== work.workLineageId || !parent.attempts.at(-1)?.writerRetired
      || parent.acceptedTaskRevision + 1 !== work.acceptedTaskRevision
      || parent.attempts.at(-1)?.historyRevision !== attempt.historyRevision) return false;
    work = parent;
  }
  return false;
}
