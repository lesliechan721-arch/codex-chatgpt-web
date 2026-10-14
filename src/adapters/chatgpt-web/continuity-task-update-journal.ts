import { assertRecoveryWriter, recoveryDigest, recoveryStore, type RuntimeRecoveryReference } from "./continuity-recovery-runtime";
import type { RecoveryTaskUpdateJournal, RecoveryThreadRecord, RecoveryWorkRecord } from "./continuity-recovery-store";
import type { UserUpdate, UpdateDelivery } from "./task-update-protocol";
import { continuityError } from "./continuity-errors";

function current(record: RecoveryThreadRecord, ref: RuntimeRecoveryReference) {
  const work = record.works[ref.logicalWorkId]; const attempt = work?.attempts[ref.attempt];
  if (!work || !attempt || record.currentWorkId !== work.logicalWorkId || attempt !== work.attempts.at(-1)
    || attempt.writerRetired || attempt.epoch !== record.epoch || ["stopped", "completed"].includes(work.state)
    || ref.ownerId !== undefined && record.owner.id !== ref.ownerId || record.pendingPreparation) throw continuityError("continuity_source_unproven");
  return work;
}

export function recoveryTaskUpdateSeed(record: RecoveryThreadRecord, work: RecoveryWorkRecord): RecoveryTaskUpdateJournal | undefined {
  if (!work.predecessorLogicalWorkId || ["completed", "stopped"].includes(record.works[work.predecessorLogicalWorkId]?.state ?? "")
    || !Object.keys(record.lineages[work.workLineageId]!.taskMappings).length) return;
  const source = record.works[work.predecessorLogicalWorkId]!;
  const checkpoint = Object.values(record.checkpoints).find(value => value.sourceLogicalWorkId === source.logicalWorkId
    && value.workLineageId === work.workLineageId && value.continuation.state === "consumed" && value.continuation.consumerLogicalWorkId === work.logicalWorkId);
  if (checkpoint && source.taskUpdateJournal && source.taskUpdateJournal.acceptedRevision === source.taskUpdateJournal.acknowledgedRevision) {
    return structuredClone(source.taskUpdateJournal);
  }
  throw continuityError("continuity_context_missing", "The retained task updates have no durable acknowledgement evidence.");
}

/** Bodies are authenticated against digest-only acceptance facts, never persisted. */
export function restoreRecoveryTaskUpdates(ref: RuntimeRecoveryReference, sources: readonly Omit<UserUpdate, "revision">[] = []): { journal: RecoveryTaskUpdateJournal; updates: UserUpdate[] } {
  const store = recoveryStore(ref); let record = assertRecoveryWriter(ref); let work = current(record, ref);
  if (!work.taskUpdateJournal) {
    // An old append has no durable ACK evidence. History alone cannot make it acknowledged.
    const inherited = recoveryTaskUpdateSeed(record, work);
    record = store.transact(ref.thread, { scope: record.scope, expectedVersion: record.version }, draft => {
      current(draft, ref).taskUpdateJournal = inherited ?? { streamId: work.logicalWorkId, acceptedRevision: 0, acknowledgedRevision: 0,
        driverGeneration: 0, updates: [], deliveries: [] };
    });
    work = record.works[ref.logicalWorkId]!;
  }
  const journal = structuredClone(work.taskUpdateJournal!);
  const updates = journal.updates.filter(update => update.revision > journal.acknowledgedRevision).map(update => {
    const candidates = sources.filter(source => source.sourceMessageId === update.sourceMessageId);
    if (!candidates.length || candidates.some(source => source.payloadDigest !== update.payloadDigest || recoveryDigest(source.content) !== update.payloadDigest)) {
      throw continuityError("continuity_context_missing", "An accepted unacknowledged task update has missing or conflicting source text.");
    }
    return { ...update, content: candidates[0]!.content };
  });
  return { journal, updates };
}

export function recordRecoveryTaskDelivery(ref: RuntimeRecoveryReference, delivery: UpdateDelivery): void {
  const store = recoveryStore(ref), observed = assertRecoveryWriter(ref);
  store.transact(ref.thread, { scope: observed.scope, expectedVersion: observed.version }, record => {
    const work = current(record, ref), journal = work.taskUpdateJournal;
    if (!journal || delivery.fromRevision !== journal.acknowledgedRevision + 1 || delivery.throughRevision !== journal.acceptedRevision
      || recoveryDigest(delivery.updates.map(({ content, ...update }) => update)) !== recoveryDigest(journal.updates.filter(update => update.revision >= delivery.fromRevision))) {
      throw continuityError("continuity_source_unproven", "The delivered task update range does not match its durable acceptance.");
    }
    const prior = journal.deliveries.find(value => value.deliveryId === delivery.deliveryId);
    if (prior) throw continuityError("continuity_source_unproven", "A task delivery identity cannot be reused.");
    if (journal.deliveries.length >= 512) throw continuityError("continuity_resource_capacity");
    journal.deliveries.push({ deliveryId: delivery.deliveryId, fromRevision: delivery.fromRevision, throughRevision: delivery.throughRevision,
      attempt: ref.attempt, epoch: record.epoch, ownerId: record.owner.id, acknowledged: false });
  });
}

export function recordRecoveryTaskAck(ref: RuntimeRecoveryReference, deliveryId: string, throughRevision: number): void {
  const store = recoveryStore(ref), observed = assertRecoveryWriter(ref);
  store.transact(ref.thread, { scope: observed.scope, expectedVersion: observed.version }, record => {
    const work = current(record, ref), journal = work.taskUpdateJournal;
    const delivery = journal?.deliveries.find(value => value.deliveryId === deliveryId);
    if (!journal || !delivery || delivery.attempt !== ref.attempt || delivery.epoch !== record.epoch || delivery.ownerId !== record.owner.id
      || delivery.throughRevision !== throughRevision || !delivery.acknowledged && delivery.fromRevision !== journal.acknowledgedRevision + 1) {
      throw continuityError("continuity_source_unproven", "The task acknowledgement does not belong to the current execution delivery.");
    }
    delivery.acknowledged = true; journal.acknowledgedRevision = Math.max(journal.acknowledgedRevision, throughRevision);
  });
}
