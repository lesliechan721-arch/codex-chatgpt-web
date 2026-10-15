import { createHash } from "node:crypto";
import type { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { recoveryRecord } from "../src/adapters/chatgpt-web/continuity-recovery-runtime";
import { TASK_UPDATE_INSTRUCTIONS } from "../src/adapters/chatgpt-web/prompt";
type Row = Record<string, any>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const number = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const fingerprint = (value: unknown) => digest(JSON.stringify(value) ?? "undefined");
const code = (value: unknown) => typeof value === "string" && /^(?:continuity_|task_update_|codex_tool_|CONTEXT_)[A-Za-z0-9_]{1,100}$/.test(value) ? value : null;

export const RESOURCE_SYNTHETIC_INSTRUCTIONS = [
  "Follow the isolated synthetic task. The only permitted business operation is unified_resource_receipt exactly once. Never repeat it or access user files, URLs or shell commands.",
  "This business restriction permits required Native protocol controls: read-only codex_tool_inventory, codex_tool_wait for the original operation, and codex_task_update_ack.",
  "When the current task contract has accepted_revision above its acknowledged task_revision, obtain and explicitly ACK its pending Broker delivery before the final answer.",
  "If there is no current control envelope, use the public codex_tool_inventory schema with a new operation_id and the exact acknowledged task_revision explicitly given by the current task contract or the Broker ACK reply. Do not use accepted_revision as an ACK.",
  "ACK only an actual returned delivery, using its exact delivery_id and through_revision with the current capability. Read the ACK reply and process any next delivery in order. Preserve original operation identities when waiting.",
  "Never guess a delivery, revision or capability; never reuse a historical delivery on a successor; never repeat business work to obtain a control envelope. Do not call controls after starting the final answer.",
].join(" ");

/** Actual prepared text only: no prompt body, capability, internal delivery or inferred revision. */
export function summarizeResourcePreparedProtocol(text: string) {
  const blocks = [...text.matchAll(/<codex_task_update_protocol_json>\s*([\s\S]*?)\s*<\/codex_task_update_protocol_json>/g)];
  const openings = text.split("<codex_task_update_protocol_json>").length - 1;
  const closings = text.split("</codex_task_update_protocol_json>").length - 1;
  let parsed: Row | undefined;
  if (blocks.length === 1 && openings === 1 && closings === 1) {
    try { const value = JSON.parse(blocks[0]![1]!); if (value && typeof value === "object" && !Array.isArray(value)) parsed = value; } catch {}
  }
  return { completeBlocks: blocks.length, openings, closings, unique: Boolean(parsed),
    protocol: parsed?.protocol === "task-updates-v1" ? "task-updates-v1" : null,
    initialAcknowledgedRevision: number(parsed?.task_revision), acceptedRevisionPresent: Boolean(parsed && Object.hasOwn(parsed, "accepted_revision")),
    initialAcceptedRevision: number(parsed?.accepted_revision), blockDigest: blocks.length === 1 ? digest(blocks[0]![1]!) : null,
    instructionsPresent: text.includes(TASK_UPDATE_INSTRUCTIONS), instructionsDigest: digest(TASK_UPDATE_INSTRUCTIONS),
    observationBoundary: "prepared-text", modelReadConfirmed: false };
}

/** Preserve field absence, false and non-boolean values without copying arbitrary server content. */
export function resourceResponseObservation(encoded: string, response: Pick<Response, "status">, envelope: Row) {
  const present = Object.hasOwn(envelope, "retryable"), value = envelope.retryable;
  return { httpStatus: response.status, status: ["failed", "completed", "in_progress", "incomplete"].includes(envelope.status) ? envelope.status : null,
    endTurn: typeof envelope.end_turn === "boolean" ? envelope.end_turn : null, requestBytes: Buffer.byteLength(encoded), bodyDigest: digest(encoded),
    code: code(envelope.error?.code), retryablePresent: present,
    retryable: typeof value === "boolean" || value === null ? value : null,
    retryableType: !present ? "absent" : value === null ? "null" : typeof value,
    ...(present && value !== null && typeof value !== "boolean" ? { invalidRetryableDigest: fingerprint(value) } : {}) };
}

export function summarizeResourceTaskUpdateJournal(journal: Row | undefined) {
  if (!journal) return null;
  return { acceptedRevision: number(journal.acceptedRevision), acknowledgedRevision: number(journal.acknowledgedRevision), driverGeneration: number(journal.driverGeneration),
    pendingSources: journal.updates.filter((row: Row) => row.revision > journal.acknowledgedRevision).map((row: Row) => ({ revision: number(row.revision),
      sourceDigest: digest(row.sourceMessageId), payloadDigest: row.payloadDigest })),
    deliveries: journal.deliveries.map((row: Row) => ({ deliveryDigest: digest(row.deliveryId), fromRevision: number(row.fromRevision), throughRevision: number(row.throughRevision),
      attempt: number(row.attempt), epoch: number(row.epoch), acknowledged: row.acknowledged === true })),
    observationBoundary: "durable-journal", mcpTransportObserved: false, modelReadConfirmed: false };
}

/** Logical acceptance and task-update protocol revisions are separate counters. */
export function resourceSuccessorRevisionEvidence(logicalWorkAcceptedTaskRevision: unknown, retiredLogicalWorkAcceptedTaskRevision: unknown,
  journal: { acceptedRevision?: unknown; acknowledgedRevision?: unknown } | null | undefined,
  connectorAck: { acceptedRevision?: unknown; acknowledgedRevision?: unknown } | undefined) {
  return { logicalWorkAcceptedTaskRevision: number(logicalWorkAcceptedTaskRevision),
    retiredLogicalWorkAcceptedTaskRevision: number(retiredLogicalWorkAcceptedTaskRevision),
    connectorAcceptedRevision: number(connectorAck?.acceptedRevision), connectorAcknowledgedRevision: number(connectorAck?.acknowledgedRevision),
    protocolAcceptedRevision: number(journal?.acceptedRevision), protocolAcknowledgedRevision: number(journal?.acknowledgedRevision) };
}

/** Broker observations are not MCP transmission receipts and never claim model receipt. */
export function observeResourceBrokerControl(broker: TurnBroker, write: (event: Row) => void, remember: (value: string) => void = () => {}, metadata: () => Row = () => ({}), nextObservation?: () => number) {
  const target = broker as unknown as Row;
  const originals = new Map<string, { value: Function; own: PropertyDescriptor | undefined; wrapper: Function }>();
  let sequence = 0;
  let observationSequence = 0;
  const emit = (event: Row) => { try { write({ ...event, observationSequence: nextObservation ? nextObservation() : ++observationSequence,
    observationBoundary: "broker", mcpTransportObserved: false, modelReadConfirmed: false }); } catch {} };
  const secret = (value: unknown) => { if (typeof value === "string" && value) { try { remember(value); } catch {} } };
  const context = (token: string) => {
    secret(token);
    const channel = target.channels.get(token), ref = channel?.recovery;
    let identity: Row = {};
    try {
      if (ref) {
        const record = recoveryRecord(ref), work = record.works[ref.logicalWorkId], attempt = work?.attempts.find((item: Row) => item.attempt === ref.attempt);
        identity = { workDigest: digest(ref.logicalWorkId), threadDigest: digest(ref.thread), attempt: number(ref.attempt), epoch: number(attempt?.epoch) };
      }
    } catch { identity = { bindingUnavailable: true }; }
    return { tokenDigest: digest(token), ...identity, traceDigest: typeof channel?.traceId === "string" ? digest(channel.traceId) : null,
      acceptedRevisionBefore: number(channel?.taskUpdates?.state.acceptedRevision), acknowledgedRevisionBefore: number(channel?.taskUpdates?.state.acknowledgedRevision),
      driverGeneration: number(channel?.taskUpdates?.state.driverGeneration) };
  };
  const delivery = (value: any) => {
    if (!value || typeof value !== "object") return undefined;
    secret(value.deliveryId);
    return { protocolVersion: number(value.protocolVersion), deliveryDigest: typeof value.deliveryId === "string" ? digest(value.deliveryId) : null,
      fromRevision: number(value.fromRevision), throughRevision: number(value.throughRevision), updateCount: Array.isArray(value.updates) ? value.updates.length : null,
      updates: Array.isArray(value.updates) ? value.updates.map((update: Row) => ({ revision: number(update.revision),
        sourceDigest: typeof update.sourceMessageId === "string" ? digest(update.sourceMessageId) : null,
        payloadDigest: typeof update.payloadDigest === "string" && /^[a-f0-9]{64}$/.test(update.payloadDigest) ? update.payloadDigest : null,
        bodyDigest: typeof update.content === "string" ? digest(update.content) : null })) : [],
    };
  };
  const result = (value: any) => ({ resultDigest: fingerprint(value), kind: ["pending", "result"].includes(value?.kind) ? value.kind : null,
    acknowledgedRevision: number(value?.acknowledgedRevision), acceptedRevision: number(value?.acceptedRevision),
    ignored: value?.ignored === "final_output_started" ? "final_output_started" : null,
    ...(value?.taskUpdate ? { delivery: delivery(value.taskUpdate) } : {}) });
  const rejected = (error: any) => ({ code: code(error?.code), errorDigest: fingerprint({ code: error?.code, message: error?.message }),
    ...(error?.taskUpdate ? { delivery: delivery(error.taskUpdate) } : {}) });
  const watch = (name: string, make: (args: any[]) => Row | undefined) => {
    const original = target[name]; if (typeof original !== "function") throw new Error("Resource observer requires the original Broker method");
    const own = Object.getOwnPropertyDescriptor(target, name);
    const wrapper = function(this: unknown, ...args: any[]) {
      let request: Row | undefined;
      try { request = make(args); if (request) request = { ...metadata(), ...request, call: ++sequence }; } catch {}
      if (request) emit({ ...request, stage: "broker-request" });
      try {
        const returned = original.apply(this, args);
        const accepted = (value: any) => { if (request) { try { emit({ ...request, stage: "broker-returned", ...result(value) }); } catch {} } };
        const failure = (error: any) => { if (request) { try { emit({ ...request, stage: "broker-rejected", ...rejected(error) }); } catch {} } };
        // Observe the original promise; never replace it or turn a synchronous ACK into a promise.
        if (returned instanceof Promise) void returned.then(accepted, failure); else accepted(returned);
        return returned;
      } catch (error) { if (request) { try { emit({ ...request, stage: "broker-rejected", ...rejected(error) }); } catch {} } throw error; }
    };
    originals.set(name, { value: original, own, wrapper }); target[name] = wrapper;
  };
  try {
    watch("dispatch", args => {
      const request = args[0];
      if (!["native_operation_start", "native_operation_wait", "task_update_ack"].includes(request?.method)) return undefined;
      secret(request.deliveryId);
      return { ...context(request.token), method: request.method, methodBoundary: "broker-wire-dispatch", requestDigest: fingerprint(request),
        requestIdDigest: fingerprint(request.id), operationDigest: request.operationId === undefined ? null : fingerprint([request.token, request.operationId]),
        entry: request.method === "native_operation_wait" ? "codex_tool_wait"
          : ["codex_tool_inventory", "codex_tool_call", "codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image"].includes(request.entry) ? request.entry : null,
        taskRevision: number(request.taskRevision), taskUpdateProtocol: number(request.taskUpdateProtocol),
        deliveryDigest: typeof request.deliveryId === "string" ? digest(request.deliveryId) : null, throughRevision: number(request.throughRevision) };
    });
    watch("acknowledgeTaskUpdate", args => {
      secret(args[1]);
      return { ...context(args[0]), method: "task_update_ack", methodBoundary: "broker-ack-method", deliveryDigest: digest(args[1]), throughRevision: number(args[2]),
        contract: ["native", "safe"].includes(args[3]) ? args[3] : null };
    });
  } catch (error) {
    for (const [name, entry] of originals) { if (entry.own) Object.defineProperty(target, name, entry.own); else delete target[name]; }
    throw error;
  }
  return () => {
    for (const [name, entry] of originals) if (target[name] === entry.wrapper) {
      if (entry.own) Object.defineProperty(target, name, entry.own); else delete target[name];
    }
  };
}

export interface ResourceSuccessorIdentity { workDigest: string; traceDigest: string; tokenDigest: string; attempt: number; epoch: number }

/** Match the actual final session, then the monotonic prepared/Send/delivery/ACK timeline. */
export function resourceSuccessorControlEvidence(events: Row[], originalTokenDigest: string, throughRevision: number,
  successor: ResourceSuccessorIdentity, prepared: Row | undefined, acceptedSend: Row | undefined) {
  const sameExecution = (row: Row | undefined) => Boolean(row && successor && row.workDigest === successor.workDigest
    && row.traceDigest === successor.traceDigest && row.attempt === successor.attempt && row.epoch === successor.epoch);
  const observed = (row: Row | undefined) => number(row?.observationSequence) !== null && row!.observationSequence > 0;
  const preparedSendBound = Boolean(sameExecution(prepared) && sameExecution(acceptedSend) && prepared?.selected === true
    && acceptedSend?.kind === "accepted-receipt" && observed(prepared) && observed(acceptedSend)
    && prepared!.observationSequence < acceptedSend!.observationSequence);
  const ack = preparedSendBound ? events.findLast(row => row.stage === "broker-returned" && row.methodBoundary === "broker-wire-dispatch"
    && row.method === "task_update_ack" && row.origin === "connector" && sameExecution(row)
    && row.tokenDigest === successor.tokenDigest && row.tokenDigest !== originalTokenDigest && observed(row)
    && row.observationSequence > acceptedSend!.observationSequence
    && row.acknowledgedRevision === throughRevision && row.acceptedRevision === throughRevision) : undefined;
  const returned = ack && events.find((row, index) => row.stage === "broker-returned" && row.methodBoundary === "broker-wire-dispatch"
    && ["native_operation_start", "native_operation_wait"].includes(row.method) && row.origin === "connector" && sameExecution(row)
    && row.tokenDigest === successor.tokenDigest && observed(row) && index < events.indexOf(ack)
    && acceptedSend!.observationSequence < row.observationSequence && row.observationSequence < ack.observationSequence
    && row.delivery?.protocolVersion === 1 && row.delivery.deliveryDigest === ack.deliveryDigest && row.delivery.throughRevision === throughRevision);
  return { brokerReturnedCurrentDelivery: Boolean(returned), actualCurrentAckReturned: Boolean(ack), passed: Boolean(returned && ack),
    preparedSendBound, ordered: Boolean(returned && ack), traceDigest: ack?.traceDigest ?? null, workDigest: ack?.workDigest ?? null,
    observationSequences: { prepared: prepared?.observationSequence ?? null, acceptedSend: acceptedSend?.observationSequence ?? null,
      deliveryReturned: returned?.observationSequence ?? null, ackReturned: ack?.observationSequence ?? null },
    deliveryDigest: returned?.delivery.deliveryDigest ?? null, epoch: ack?.epoch ?? null, attempt: ack?.attempt ?? null,
    mcpTransportObserved: false, modelReadConfirmed: false, observationBoundary: "broker-return-and-ACK" };
}
