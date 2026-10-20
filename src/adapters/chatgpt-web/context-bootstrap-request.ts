import type { CodexMessage, CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { canonicalJson } from "./canonical-json";
import { contextSourceParserModel } from "./context-source-parser";
import type { TaskUpdateSourceProof } from "./task-update-source";

// Only the adapter's accepted native-message proof can select an inline request.
// Unclassified records still travel in the complete required task payload.
const accepted = new WeakMap<CodexParsedRequest, TaskUpdateSourceProof>();

export function bindContextBootstrapRequestSource(parsed: CodexParsedRequest, proof: TaskUpdateSourceProof): void {
  accepted.set(parsed, structuredClone(proof));
}

export function inheritContextBootstrapRequestSource(from: CodexParsedRequest, to: CodexParsedRequest): void {
  const proof = accepted.get(from);
  if (proof) accepted.set(to, proof);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function visible(message: CodexMessage): string {
  const { timestamp: _timestamp, ...value } = message;
  return canonicalJson(value);
}

/** Canonical message indices of the complete accepted user-message group.
 * No role or text heuristic can establish membership in this group. */
export function contextBootstrapRequestMessageIndices(parsed: CodexParsedRequest): readonly number[] | undefined {
  const proof = accepted.get(parsed);
  const raw = record(parsed._rawBody);
  if (!proof || proof.conflictingMessageIds?.length || !Array.isArray(raw?.input)) return undefined;
  const input = raw.input;
  const identity = (value: unknown): string | undefined => {
    const id = record(value)?.id;
    return typeof id === "string" ? parsed._chatGptMessageIdAliases?.[id] ?? id : undefined;
  };
  const indices: number[] = [];
  for (const source of proof.messages) {
    const original = proof.input.filter(item => identity(item) === source.sourceMessageId);
    const matches = input.flatMap((item, index) => identity(item) === source.sourceMessageId ? [index] : []);
    if (original.length !== 1 || matches.length !== 1
      || canonicalJson(original[0]) !== canonicalJson(input[matches[0]!])) return undefined;
    const rawIndex = matches[0]!;
    const model = contextSourceParserModel(parsed);
    const single = parseRequest({ model, input: [input[rawIndex]] }).context.messages;
    const prefix = parseRequest({ model, instructions: raw.instructions, input: input.slice(0, rawIndex + 1) }).context.messages;
    const index = prefix.length - 1;
    if (single.length !== 1 || !parsed.context.messages[index] || !prefix[index]
      || visible(single[0]!) !== visible(prefix[index]!)
      || visible(single[0]!) !== visible(parsed.context.messages[index]!)
      || index <= (indices.at(-1) ?? -1)) return undefined;
    indices.push(index);
  }
  return Object.freeze(indices);
}
