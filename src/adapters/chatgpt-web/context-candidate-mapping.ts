import { createHash } from "node:crypto";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import type { ContextSourceEvidence } from "./context-types";

type CandidateMessageIndices = readonly (number | null)[];
type InputSource = {
  canonical: CodexParsedRequest;
  digest: string;
} & ({ kind: "instruction"; rawInput: unknown[]; rawIndex: number; rawItem: unknown; delegatedToolResult: boolean }
  | { kind: "environment" });

const inputSources = new WeakMap<object, InputSource>();
const acceptedSources = new WeakMap<CodexParsedRequest, { request: CodexParsedRequest; source: CodexParsedRequest }>();
const restoredMessageSources = new WeakMap<CodexParsedRequest, readonly number[]>();
const restoredMessageEvidence = new WeakMap<CodexParsedRequest, ReadonlyMap<number, ContextSourceEvidence>>();
const candidateSources = new WeakMap<CodexParsedRequest, {
  canonical: CodexParsedRequest;
  canonicalMessages: CodexMessage[];
  candidateMessages: CodexMessage[];
  canonicalReferences: CodexMessage[];
  candidateReferences: CodexMessage[];
  canonicalDigests: string[];
  candidateDigests: string[];
  indices: CandidateMessageIndices;
  rawInputIndices: readonly number[];
  rawInput: unknown[];
  candidateRawInput: unknown[];
  rawInputLength: number;
  candidateRawInputLength: number;
  candidateRawInputIndices: readonly number[];
  rawReferences: unknown[];
  rawDigests: string[];
  canonicalSystemDigest: string;
  candidateSystemDigest: string;
}>();

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value) ?? "undefined").digest("hex");
}

function visibleDigest(message: CodexMessage): string {
  const { timestamp: _timestamp, ...visible } = message;
  return digest(visible);
}

function unproven(): never {
  throw continuityError("continuity_source_unproven", "The current candidate has no exact canonical message source.");
}

/** Internal provenance for a clone made by the native instruction selector. */
export function bindContextInstructionInputSource(canonical: CodexParsedRequest, item: unknown, rawIndex: number,
  delegatedToolResult = false): void {
  const rawInput = (canonical._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!item || typeof item !== "object" || !Array.isArray(rawInput)
    || !Number.isSafeInteger(rawIndex) || rawIndex < 0 || rawIndex >= rawInput.length
    || digest(item) !== digest(rawInput[rawIndex])) unproven();
  inputSources.set(item, { canonical, digest: digest(item), kind: "instruction",
    rawInput, rawIndex, rawItem: rawInput[rawIndex], delegatedToolResult });
}

/** Only the trusted environment rebuilder may register synthetic, text-only input. */
export function bindContextEnvironmentInputSource(canonical: CodexParsedRequest, item: object): void {
  inputSources.set(item, { canonical, digest: digest(item), kind: "environment" });
}

function rememberCandidate(canonical: CodexParsedRequest, candidate: CodexParsedRequest,
  indices: (number | null)[], rawInputIndices: number[],
  candidateRawInputIndices: number[] = rawInputIndices): CodexParsedRequest {
  const canonicalMessages = canonical.context.messages;
  const candidateMessages = candidate.context.messages;
  const rawInput = (canonical._rawBody as { input?: unknown[] } | undefined)?.input;
  const candidateRawInput = (candidate._rawBody as { input?: unknown[] } | undefined)?.input;
  if (indices.length !== candidateMessages.length || !Array.isArray(rawInput) || !Array.isArray(candidateRawInput)
    || rawInputIndices.length !== candidateRawInputIndices.length) unproven();
  candidateSources.set(candidate, { canonical, canonicalMessages, candidateMessages,
    canonicalReferences: canonicalMessages.slice(), candidateReferences: candidateMessages.slice(),
    canonicalDigests: canonicalMessages.map(visibleDigest), candidateDigests: candidateMessages.map(visibleDigest),
    indices: Object.freeze(indices), rawInputIndices: Object.freeze(rawInputIndices), rawInput, candidateRawInput,
    rawInputLength: rawInput.length, candidateRawInputLength: candidateRawInput.length,
    candidateRawInputIndices: Object.freeze(candidateRawInputIndices), rawReferences: rawInput.slice(),
    rawDigests: rawInput.map(digest),
    canonicalSystemDigest: digest(canonical.context.systemPrompt ?? null),
    candidateSystemDigest: digest(candidate.context.systemPrompt ?? null) });
  return candidate;
}

/** Initial full control retries preserve the accepted full input in a detached clone. */
export function bindContextFullCandidate(canonical: CodexParsedRequest, candidate: CodexParsedRequest): CodexParsedRequest {
  const rawInput = (canonical._rawBody as { input?: unknown[] } | undefined)?.input;
  const candidateRawInput = (candidate._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(rawInput) || !Array.isArray(candidateRawInput)
    || digest(rawInput) !== digest(candidateRawInput)
    || digest(canonical.context.systemPrompt ?? null) !== digest(candidate.context.systemPrompt ?? null)
    || canonical.context.messages.length !== candidate.context.messages.length
    || candidate.context.messages.some((message, index) => visibleDigest(message) !== visibleDigest(canonical.context.messages[index]!))) unproven();
  return rememberCandidate(canonical, candidate, candidate.context.messages.map((_, index) => index), rawInput.map((_, index) => index));
}

/** A creation retry sends the first accepted full input, even if new HTTP history differs. */
export function continuityAcceptedContextCandidate(request: CodexParsedRequest,
  accepted: CodexParsedRequest): CodexParsedRequest {
  const previous = acceptedSources.get(accepted);
  const binding = previous ? candidateSource(previous.source, accepted) : undefined;
  if (previous && !binding) unproven();
  const source = previous?.source ?? accepted;
  const candidate = binding
    ? rememberCandidate(source, structuredClone(accepted), [...binding.indices], [...binding.rawInputIndices], [...binding.candidateRawInputIndices])
    : bindContextFullCandidate(source, structuredClone(accepted));
  acceptedSources.set(candidate, { request, source });
  return candidate;
}

const callTypes = new Set(["function_call", "custom_tool_call", "tool_search_call"]);
const resultTypes = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);
function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function retainedKey(value: unknown): string | undefined {
  const item = rawRecord(value);
  if (!item) return undefined;
  if (typeof item.call_id === "string" && (callTypes.has(String(item.type)) || resultTypes.has(String(item.type)))) {
    return `call:${String(item.type)}:${item.call_id}`;
  }
  if (typeof item.id === "string") return `id:${item.id}`;
  if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) return `checkpoint:${digest(item)}`;
  return undefined;
}

function sameRetainedItem(left: unknown, right: unknown): boolean {
  const a = rawRecord(left), b = rawRecord(right);
  if (!a || !b || !callTypes.has(String(a.type))) return digest(left) === digest(right);
  // The issuing session holds object parameters. A native HTTP echo may include
  // its transport item ID or use different JSON spacing, never different values.
  const argumentsOf = (item: Record<string, unknown>): unknown => {
    if (item.type === "custom_tool_call") return item.input;
    if (typeof item.arguments !== "string") return item.arguments;
    try { const value = JSON.parse(item.arguments); return rawRecord(value) ? value : undefined; } catch { return undefined; }
  };
  const aa = argumentsOf(a), ba = argumentsOf(b);
  return aa !== undefined && ba !== undefined && a.type === b.type && a.call_id === b.call_id
    && a.name === b.name && a.namespace === b.namespace && digest(aa) === digest(ba);
}

/** Merge one exact retained stream at unique identity anchors. Instructions which
 * remained active on the lost page must also return to the full recovery body. */
function restoreRetainedInput(source: CodexParsedRequest, candidate: CodexParsedRequest,
  indices: number[], rawMessageIndex: (index: number) => number | undefined, evidence: Map<number, ContextSourceEvidence>,
  retained: readonly unknown[], objectCallIds: ReadonlySet<string>): { indices: number[]; evidence: Map<number, ContextSourceEvidence> } {
  const raw = (source._rawBody as { input: unknown[] }).input;
  const keyed = new Map<string, number[]>();
  raw.forEach((item, index) => { const key = retainedKey(item); if (key) keyed.set(key, [...keyed.get(key) ?? [], index]); });
  const retainedKeys = new Set<string>();
  const added = new Map<number, unknown[]>();
  let next = raw.length;
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const item = retained[index], key = retainedKey(item);
    if (key) {
      if (retainedKeys.has(key)) unproven();
      retainedKeys.add(key);
      const matches = keyed.get(key);
      if (matches) {
        if (matches.length !== 1 || matches[0]! >= next || !sameRetainedItem(raw[matches[0]!], item)) unproven();
        next = matches[0]!;
        continue;
      }
    } else {
      const record = rawRecord(item);
      if (raw.some(value => !retainedKey(value) && rawRecord(value)?.type === record?.type
        && rawRecord(value)?.role === record?.role)) unproven();
    }
    const bucket = added.get(next) ?? [];
    bucket.unshift(item); added.set(next, bucket);
  }
  if (!added.size) return { indices, evidence };
  const sourceBefore = new Map<number, Array<{ message: CodexMessage; include: boolean; evidence: ContextSourceEvidence }>>();
  const restoredSystem: string[] = [];
  const mergedRaw: unknown[] = [];
  for (let rawIndex = 0; rawIndex <= raw.length; rawIndex += 1) {
    let before = source.context.messages.length;
    if (added.has(rawIndex)) for (let index = rawIndex; index < raw.length; index += 1) {
      const mapped = rawMessageIndex(index);
      if (mapped !== undefined) { before = mapped; break; }
    }
    for (const item of added.get(rawIndex) ?? []) {
      mergedRaw.push(structuredClone(item));
      const parsed = parseRequest({ model: source.modelId, input: [item] }).context;
      restoredSystem.push(...parsed.systemPrompt ?? []);
      if (parsed.messages.length && rawIndex > 0) {
        for (let index = rawIndex - 1; index >= 0; index -= 1) {
          const previous = rawMessageIndex(index);
          if (previous === undefined) continue;
          // Never put retained text before an entire merged call message when
          // its real position falls between that message's original raw calls.
          if (previous === before) unproven();
          break;
        }
      }
      const bucket = sourceBefore.get(before) ?? [];
      const record = rawRecord(item);
      for (const message of parsed.messages) {
        const task = ["user", "developer", "agentMessage"].includes(message.role)
          || (message.role === "assistant" && (typeof message.content === "string" || message.content.some(part => part.type !== "toolCall")));
        bucket.push({ message, include: task, evidence: { restored: true,
          ...(record && typeof record.call_id === "string" && objectCallIds.has(record.call_id)
            && record.type !== "custom_tool_call" ? { tool_arguments_encoding: "deterministic-json" as const } : {}) } });
      }
      sourceBefore.set(before, bucket);
    }
    if (rawIndex < raw.length) mergedRaw.push(raw[rawIndex]);
  }
  const candidateAtSource = new Map(indices.map((sourceIndex, candidateIndex) => [sourceIndex, candidate.context.messages[candidateIndex]!]));
  const messages: CodexMessage[] = [], candidateMessages: CodexMessage[] = [], mapped: number[] = [];
  const restoredEvidence = new Map<number, ContextSourceEvidence>();
  for (let index = 0; index <= source.context.messages.length; index += 1) {
    for (const item of sourceBefore.get(index) ?? []) {
      restoredEvidence.set(messages.length, item.evidence);
      if (item.include) { mapped.push(messages.length); candidateMessages.push(structuredClone(item.message)); }
      messages.push(item.message);
    }
    if (index === source.context.messages.length) break;
    const previous = evidence.get(index); if (previous) restoredEvidence.set(messages.length, previous);
    const selected = candidateAtSource.get(index);
    if (selected) { mapped.push(messages.length); candidateMessages.push(selected); }
    messages.push(source.context.messages[index]!);
  }
  source.context.messages = messages;
  source.context.systemPrompt = [...source.context.systemPrompt ?? [], ...restoredSystem];
  (source._rawBody as { input: unknown[] }).input = mergedRaw;
  candidate.context.messages = candidateMessages;
  if (restoredSystem.length) candidate.context.systemPrompt = [...candidate.context.systemPrompt!.slice(0, -1), ...restoredSystem, candidate.context.systemPrompt!.at(-1)!];
  // This detached candidate retains actual restored raw fields. The HTTP request
  // and its accepted current instruction identity remain unchanged.
  candidate._rawBody = { ...rawRecord(candidate._rawBody), input: structuredClone(mergedRaw) };
  return { indices: mapped, evidence: restoredEvidence };
}

/** Register only after recoveryContext's original result and lineage checks pass.
 * actualInput may add parameters retained by that exact issuing session. It never
 * changes the candidate or promotes its appended recovery status to source text. */
export function continuityRecoveredContextCandidate(request: CodexParsedRequest,
  recovered: CodexParsedRequest, actualInput?: readonly unknown[], retainedInput?: readonly unknown[],
  objectCallIds: ReadonlySet<string> = new Set()): CodexParsedRequest {
  const requestRaw = rawRecord(request._rawBody);
  const recoveredRaw = rawRecord(recovered._rawBody);
  const original = requestRaw?.input;
  const raw = recoveredRaw?.input;
  if (!Array.isArray(original) || !Array.isArray(raw) || raw.length < original.length
    || original.some((item, index) => digest(item) !== digest(raw[index]))) unproven();
  const { input: _originalInput, ...originalEnvelope } = requestRaw!;
  const { input: _recoveredInput, ...recoveredEnvelope } = recoveredRaw!;
  if (digest(originalEnvelope) !== digest(recoveredEnvelope)) unproven();
  const extra = raw.slice(original.length);
  if (extra.some(item => !resultTypes.has(String(rawRecord(item)?.type)))) unproven();
  const parsedOriginal = parseRequest({ model: request.modelId, instructions: requestRaw!.instructions, input: original }).context;
  const parsedExtra = parseRequest({ model: request.modelId, input: extra }).context;
  const expectedMessages = [...request.context.messages, ...parsedExtra.messages];
  const system = request.context.systemPrompt ?? [];
  const recoveredSystem = recovered.context.systemPrompt ?? [];
  if (parsedOriginal.messages.length !== request.context.messages.length
    || parsedOriginal.messages.some((message, index) => visibleDigest(message) !== visibleDigest(request.context.messages[index]!))
    || expectedMessages.length !== recovered.context.messages.length
    || expectedMessages.some((message, index) => visibleDigest(message) !== visibleDigest(recovered.context.messages[index]!))
    || recoveredSystem.length !== system.length + 1
    || typeof recoveredSystem.at(-1) !== "string"
    || system.some((text, index) => text !== recoveredSystem[index])) unproven();

  const restoredRaw = structuredClone(actualInput ? [...actualInput] : raw);
  const originalCallIds = new Set(raw.flatMap(item => {
    const record = rawRecord(item);
    return record && callTypes.has(String(record.type)) && typeof record.call_id === "string" ? [record.call_id] : [];
  }));
  const addedIds = new Set<string>();
  const rawIndices: number[] = [];
  const insertions = new Map<number, Array<{ message: CodexMessage; evidence: ContextSourceEvidence; rawIndex: number }>>();
  let rawIndex = 0;
  for (const [sourceIndex, item] of restoredRaw.entries()) {
    const record = rawRecord(item);
    const added = record && callTypes.has(String(record.type)) && typeof record.call_id === "string"
      && !originalCallIds.has(record.call_id);
    if (!added) {
      if (rawIndex >= raw.length || digest(item) !== digest(raw[rawIndex])) unproven();
      rawIndices.push(sourceIndex);
      rawIndex += 1;
      continue;
    }
    const id = record.call_id as string;
    const result = rawRecord(raw[rawIndex]);
    // The retained call is inserted at its one real return, never located by a
    // repeated call ID or similar message content.
    if (addedIds.has(id) || !result || !resultTypes.has(String(result.type)) || result.call_id !== id
      || raw.filter(value => rawRecord(value)?.call_id === id && resultTypes.has(String(rawRecord(value)?.type))).length !== 1) unproven();
    const prefix = rawIndex < original.length
      ? parseRequest({ model: request.modelId, instructions: requestRaw!.instructions, input: original.slice(0, rawIndex + 1) }).context.messages
      : parseRequest({ model: request.modelId, input: extra.slice(0, rawIndex - original.length + 1) }).context.messages;
    const candidateIndex = prefix.length - 1 + (rawIndex < original.length ? 0 : request.context.messages.length);
    const target = recovered.context.messages[candidateIndex];
    const addedMessages = parseRequest({ model: request.modelId, input: [item] }).context.messages;
    if (!target || target.role !== "toolResult" || target.toolCallId !== id
      || visibleDigest(target) !== visibleDigest(prefix.at(-1)!)
      || addedMessages.length !== 1 || addedMessages[0]!.role !== "assistant") unproven();
    addedIds.add(id);
    const before = insertions.get(candidateIndex) ?? [];
    before.push({ message: addedMessages[0]!, rawIndex: sourceIndex, evidence: { restored: true,
      ...(record.type !== "custom_tool_call" ? { tool_arguments_encoding: "deterministic-json" as const } : {}) } });
    insertions.set(candidateIndex, before);
  }
  if (rawIndex !== raw.length) unproven();
  const source = structuredClone(recovered);
  (source._rawBody as { input: unknown[] }).input = restoredRaw;
  source.context.systemPrompt = request.context.systemPrompt ? [...request.context.systemPrompt] : undefined;
  source.context.messages = [];
  let indices: number[] = [];
  let restoredEvidence = new Map<number, ContextSourceEvidence>();
  const rawMessageIndices = new Map<number, number>();
  recovered.context.messages.forEach((message, index) => {
    for (const inserted of insertions.get(index) ?? []) {
      rawMessageIndices.set(inserted.rawIndex, source.context.messages.length);
      restoredEvidence.set(source.context.messages.length, inserted.evidence);
      source.context.messages.push(inserted.message);
    }
    indices.push(source.context.messages.length);
    if (index >= request.context.messages.length) {
      restoredEvidence.set(source.context.messages.length, { restored: true });
    }
    source.context.messages.push(structuredClone(message));
  });
  if (retainedInput?.length) {
    const candidateRawBySourceIndex = new Map(rawIndices.map((sourceIndex, candidateIndex) => [sourceIndex, candidateIndex]));
    const rawMessageIndex = (sourceIndex: number): number | undefined => {
      const mapped = rawMessageIndices.get(sourceIndex);
      if (mapped !== undefined) return mapped;
      const index = candidateRawBySourceIndex.get(sourceIndex);
      if (index === undefined || !parseRequest({ model: request.modelId, input: [raw[index]] }).context.messages.length) return undefined;
      const prefix = index < original.length
        ? parseRequest({ model: request.modelId, input: original.slice(0, index + 1) }).context.messages
        : parseRequest({ model: request.modelId, input: extra.slice(0, index - original.length + 1) }).context.messages;
      const candidateIndex = prefix.length - 1 + (index < original.length ? 0 : request.context.messages.length);
      rawMessageIndices.set(sourceIndex, indices[candidateIndex]!);
      return indices[candidateIndex];
    };
    ({ indices, evidence: restoredEvidence } = restoreRetainedInput(source, recovered, indices, rawMessageIndex,
      restoredEvidence, retainedInput, objectCallIds));
  }
  restoredMessageSources.set(source, Object.freeze([...restoredEvidence.keys()]));
  restoredMessageEvidence.set(source, restoredEvidence);
  const currentRaw = (recovered._rawBody as { input: unknown[] }).input;
  rememberCandidate(source, recovered, indices,
    currentRaw === raw ? rawIndices : (source._rawBody as { input: unknown[] }).input.map((_, index) => index),
    currentRaw.map((_, index) => index));
  acceptedSources.set(recovered, { request, source });
  return recovered;
}

/** Parse the existing continuity selection and retain its exact source positions. */
export function continuityContextCandidate(canonical: CodexParsedRequest, input: unknown[]): CodexParsedRequest {
  const instructions = (canonical._rawBody as { instructions?: unknown } | undefined)?.instructions;
  const selectedContext = parseRequest({ model: canonical.modelId, instructions, input }).context;
  const indices: (number | null)[] = [];
  const rawInputIndices: number[] = [];
  const used = new Set<number>();
  for (const item of input) {
    const source = item && typeof item === "object" ? inputSources.get(item) : undefined;
    if (!source || source.canonical !== canonical || source.digest !== digest(item)) unproven();
    const single = parseRequest({ model: canonical.modelId, input: [item] }).context;
    const record = item as { type?: unknown; role?: unknown; content?: unknown };
    if (source.kind === "environment") {
      if ((record.type !== undefined && record.type !== "message")
        || !["user", "developer", "system"].includes(String(record.role))
        || !Array.isArray(record.content)
        || !record.content.every(part => part && typeof part === "object"
          && (part.type === "input_text" || part.type === "text") && typeof part.text === "string")) unproven();
      indices.push(...single.messages.map(() => null));
      continue;
    }
    const rawInput = (canonical._rawBody as { input?: unknown[] } | undefined)?.input;
    if (source.rawInput !== rawInput || rawInput[source.rawIndex] !== source.rawItem
      || digest(source.rawItem) !== source.digest) unproven();
    rawInputIndices.push(source.rawIndex);
    // System items are selected by the existing contract but do not produce messages.
    if ((record.type === undefined || record.type === "message") && record.role === "system") {
      if (single.messages.length !== 0) unproven();
      continue;
    }
    if (single.messages.length !== 1 || (!["user", "developer", "agentMessage"].includes(single.messages[0]!.role)
      && !(source.delegatedToolResult && single.messages[0]!.role === "toolResult"))) unproven();
    // Adjacent calls can merge and non-message items can disappear. Count the original
    // parsed prefix through this instruction instead of equating raw and message indices.
    const prefix = parseRequest({ model: canonical.modelId, instructions,
      input: rawInput.slice(0, source.rawIndex + 1) }).context.messages;
    const index = prefix.length - 1;
    const message = canonical.context.messages[index];
    if (!message || used.has(index) || visibleDigest(single.messages[0]!) !== visibleDigest(prefix[index]!)
      || visibleDigest(message) !== visibleDigest(prefix[index]!)) unproven();
    used.add(index);
    indices.push(index);
  }
  return rememberCandidate(canonical, { ...canonical, context: { ...canonical.context,
    systemPrompt: selectedContext.systemPrompt, messages: selectedContext.messages } }, indices, rawInputIndices);
}

/** A binding cannot be copied to another request or reused after its message lists change. */
function candidateSource(canonical: CodexParsedRequest, candidate: CodexParsedRequest) {
  const source = candidateSources.get(candidate);
  if (!source || source.canonical !== canonical || source.canonicalMessages !== canonical.context.messages
    || source.candidateMessages !== candidate.context.messages
    || source.rawInput !== (canonical._rawBody as { input?: unknown[] } | undefined)?.input
    || source.candidateRawInput !== (candidate._rawBody as { input?: unknown[] } | undefined)?.input
    || source.rawInputLength !== source.rawInput.length || source.candidateRawInputLength !== source.candidateRawInput.length
    || source.rawReferences.some((item, index) => item !== source.rawInput[index] || source.rawDigests[index] !== digest(item))
    || source.rawInputIndices.some((rawIndex, index) => source.rawDigests[rawIndex]
      !== digest(source.candidateRawInput[source.candidateRawInputIndices[index]!]))
    || source.canonicalSystemDigest !== digest(canonical.context.systemPrompt ?? null)
    || source.candidateSystemDigest !== digest(candidate.context.systemPrompt ?? null)
    || source.canonicalReferences.length !== canonical.context.messages.length
    || source.candidateReferences.length !== candidate.context.messages.length
    || source.canonicalReferences.some((message, index) => message !== canonical.context.messages[index]
      || source.canonicalDigests[index] !== visibleDigest(message))
    || source.candidateReferences.some((message, index) => message !== candidate.context.messages[index]
      || source.candidateDigests[index] !== visibleDigest(message))) return undefined;
  return source;
}

export function contextCandidateMessageIndices(canonical: CodexParsedRequest,
  candidate: CodexParsedRequest): CandidateMessageIndices | undefined {
  return candidateSource(canonical, candidate)?.indices;
}

/** Includes selected raw system items; synthetic environment text has no raw source. */
export function contextCandidateRawInputIndices(canonical: CodexParsedRequest,
  candidate: CodexParsedRequest): readonly number[] | undefined {
  return candidateSource(canonical, candidate)?.rawInputIndices;
}

/** Only actual missing returns and retained issuing parameters are restoration.
 * HTTP-supplied history and the appended status never receive this evidence. */
export function contextCandidateRestoredMessageIndices(canonical: CodexParsedRequest,
  candidate: CodexParsedRequest): readonly number[] | undefined {
  return candidateSource(canonical, candidate) ? restoredMessageSources.get(canonical) : undefined;
}

/** Object parameters recovered from the issuing session use declared deterministic
 * JSON. Freeform input and all HTTP-supplied argument strings keep their original encoding. */
export function contextCandidateSourceProvenance(canonical: CodexParsedRequest,
  candidate: CodexParsedRequest): ReadonlyMap<number, ContextSourceEvidence> | undefined {
  const evidence = candidateSource(canonical, candidate) ? restoredMessageEvidence.get(canonical) : undefined;
  return evidence ? new Map([...evidence].map(([index, value]) => [index, { ...value }])) : undefined;
}

/** Only a trusted accepted input or verified recovery can override this send's source. */
export function contextCandidateCanonicalSource(request: CodexParsedRequest,
  candidate: CodexParsedRequest): CodexParsedRequest | undefined {
  const accepted = acceptedSources.get(candidate);
  return accepted?.request === request && candidateSource(accepted.source, candidate) ? accepted.source : undefined;
}
