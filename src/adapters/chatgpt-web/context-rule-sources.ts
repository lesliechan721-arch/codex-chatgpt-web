import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { parsedRequestRuleSourceEvidence, type ParsedRuleSourcePosition } from "../../responses/parser";
import { isNativeAgentsMdContext } from "../../responses/native-context";
import { canonicalJson } from "./canonical-json";
import { contextCandidateIndices } from "./context-candidate-mapping";

export type ContextRuleSourcePosition = ParsedRuleSourcePosition;
export interface ContextRuleSourceUnit {
  identity: string;
  kind: "instructions" | "system" | "developer" | "native_agents_md";
  role: "system" | "developer" | "user";
  scope: string;
  sourceDigest: string;
  position: ContextRuleSourcePosition;
}
export interface ContextRuleSourceSnapshot {
  scope: string;
  identities: string[];
  state: "absent" | "null" | "empty" | "value" | "undefined";
}
export interface ContextRuleSourceMiss {
  reason: string;
  position?: ContextRuleSourcePosition;
  count?: number;
}
export interface ContextRuleSources {
  units: ContextRuleSourceUnit[];
  snapshots: ContextRuleSourceSnapshot[];
  misses: ContextRuleSourceMiss[];
}

const INSTRUCTIONS_SCOPE = "responses.instructions/current/v1";
const INSTRUCTIONS_IDENTITY = "responses.instructions/v1";
const MAX_MISSES = 32;
// environments.instructions is generic usage guidance. Current window state,
// window guidance and deferred tool availability must remain current data.
const stableKinds = new Set([
  "model.base_instructions", "generic.developer_instructions", "host_skills.instructions", "permissions.instructions",
  "collaboration_mode.instructions", "plugins.instructions", "plugins.usage_instructions", "apps.instructions",
  "multi_agent.mode_instructions", "multi_agent.role_instructions", "multi_agent.usage_hint", "skills.catalog",
  "skills.instructions", "cloud_skills.instructions", "memories.instructions", "plugins.recommendations",
  "environments.instructions", "persistent_mode.instructions", "git_attribution.instructions",
  "managed_config.developer_instructions", "model_switch.instructions", "agents_md.instructions",
]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Tag values so even an explicitly present undefined field has a distinct fingerprint. */
function sourceValue(value: unknown): unknown {
  if (Array.isArray(value)) return ["array", value.map(sourceValue)];
  const item = record(value);
  if (item) return ["object", Object.keys(item).sort().map(key => [key, sourceValue(item[key])])];
  return [typeof value, value === undefined ? null : value];
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(sourceValue(value))).digest("hex");
}
function sourceIdentity(item: Record<string, unknown>): string | undefined {
  return typeof item.id === "string" && item.id.trim().length > 0
    ? `responses.input.id/v1/${digest(item.id)}` : undefined;
}
function instructionState(present: boolean, value: unknown): ContextRuleSourceSnapshot["state"] {
  return !present ? "absent" : value === null ? "null" : value === "" ? "empty" : value === undefined ? "undefined" : "value";
}
function sourceOrderUnchanged(indices: readonly (number | null)[] | undefined): boolean {
  let previous = -1;
  return !indices || indices.every(index => {
    if (index === null) return true;
    if (index <= previous) return false;
    previous = index;
    return true;
  });
}
function textOnly(item: Record<string, unknown>): boolean {
  return typeof item.content === "string" || Array.isArray(item.content) && item.content.every(value => {
    const part = record(value);
    return part && ["input_text", "text"].includes(String(part.type)) && typeof part.text === "string";
  });
}
function kindOf(item: Record<string, unknown>): { kind?: ContextRuleSourceUnit["kind"]; reason?: string } {
  const metadata = record(item.internal_chat_message_metadata_passthrough);
  const kinds = metadata?.content_item_kinds;
  if (item.role === "user") {
    return isNativeAgentsMdContext(item) && textOnly(item)
      ? { kind: "native_agents_md" }
      : { reason: kinds === undefined ? "user_event" : "unverified_native_rule" };
  }
  if (!textOnly(item)) return { reason: "mixed_rule_content" };
  if (kinds !== undefined && (!Array.isArray(kinds) || kinds.length === 0
    || kinds.some(kind => typeof kind !== "string" || !stableKinds.has(kind))
    || new Set(kinds).size !== 1)) return { reason: "unsupported_rule_kind" };
  return { kind: item.role as "system" | "developer" };
}

/** Classify exact candidate fields, without changing the legal candidate or treating text as provenance. */
export function contextRuleSources(canonical: CodexParsedRequest, candidate: CodexParsedRequest): ContextRuleSources {
  const result: ContextRuleSources = { units: [], snapshots: [], misses: [] };
  let overflow = 0;
  const miss = (reason: string, position?: ContextRuleSourcePosition): void => {
    if (result.misses.length < MAX_MISSES - 1) result.misses.push({ reason, ...(position ? { position } : {}) });
    else overflow += 1;
  };
  const evidence = parsedRequestRuleSourceEvidence(canonical);
  const indices = canonical === candidate ? undefined : contextCandidateIndices(canonical, candidate);
  const { messageIndices, rawInputIndices: selectedRaw, systemIndices } = indices ?? {};
  if (!evidence || canonical !== candidate && !indices) {
    miss(evidence ? "candidate_source_unproven" : "parser_source_unproven");
    return result;
  }
  const systemOrderUnchanged = sourceOrderUnchanged(systemIndices);
  const messageOrderUnchanged = sourceOrderUnchanged(messageIndices);
  const candidateSystemPositions = new Map(systemIndices?.flatMap((sourceIndex, candidateIndex) =>
    sourceIndex === null ? [] : [[sourceIndex, candidateIndex] as const]) ?? []);
  const candidateMessagePositions = new Map(messageIndices?.flatMap((sourceIndex, candidateIndex) =>
    sourceIndex === null ? [] : [[sourceIndex, candidateIndex] as const]) ?? []);
  const raw = record(canonical._rawBody)?.input;
  const input: unknown[] = Array.isArray(raw) ? raw : [];
  const counts = new Map<string, number>();
  for (const value of input) {
    const id = record(value)?.id;
    if (typeof id === "string") counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const instructions = evidence.instructions;
  const state = instructionState(instructions.present, instructions.value);
  const hasInstructions = state === "value" && typeof instructions.value === "string";
  if (hasInstructions && candidate.context.systemPrompt?.[0] !== instructions.value) {
    miss("instructions_mapping_unproven");
    return result;
  }
  result.snapshots.push({ scope: INSTRUCTIONS_SCOPE, identities: hasInstructions ? [INSTRUCTIONS_IDENTITY] : [], state });
  if (hasInstructions) result.units.push({ identity: INSTRUCTIONS_IDENTITY, kind: "instructions", role: "system",
    scope: INSTRUCTIONS_SCOPE, sourceDigest: digest({ source: "responses.instructions", ...instructions, role: "system", scope: INSTRUCTIONS_SCOPE }),
    position: { system_index: 0 } });

  const entries = new Map(evidence.input.map(item => [item.rawIndex, item]));
  const systemPositions = new Map<number, number>();
  for (const rawIndex of selectedRaw ?? input.map((_, index) => index)) {
    const entry = entries.get(rawIndex);
    if (entry?.position && "system_index" in entry.position) {
      const index = canonical === candidate ? entry.position.system_index : candidateSystemPositions.get(entry.position.system_index);
      if (index !== undefined) systemPositions.set(rawIndex, index);
    }
  }
  // Priority is a chain of source anchors, not transport indices. Appended task history
  // leaves prefix rules stable; moving a rule across another rule changes its scope.
  let systemPriority = "root", contextPriority = "root";
  const systemPriorities = new Map<number, string>();
  for (const entry of evidence.input.filter(item => item.position && "system_index" in item.position)
    .sort((a, b) => (a.position as { system_index: number }).system_index - (b.position as { system_index: number }).system_index)) {
    const item = record(input[entry.rawIndex])!;
    systemPriorities.set(entry.rawIndex, systemPriority);
    systemPriority = digest({ previous: systemPriority, anchor: sourceIdentity(item) ?? digest(item) });
  }
  let precedingEvent = "request-start";
  for (const [rawIndex, value] of input.entries()) {
    const item = record(value);
    const entry = entries.get(rawIndex);
    if (!item || !entry) {
      precedingEvent = digest({ id: item?.id, call_id: item?.call_id, type: item?.type, value: item?.id || item?.call_id ? undefined : value });
      continue;
    }
    const role = entry.role;
    const identity = sourceIdentity(item);
    const classification = kindOf(item);
    const scope = `responses.input.rules/v1/${digest({ role, priority: role === "system" ? systemPriorities.get(rawIndex) : contextPriority,
      ...(role !== "system" ? { after: precedingEvent } : {}) })}`;
    const anchor = identity ?? digest(item);
    if (role !== "system" && (role !== "user" || classification.kind)) contextPriority = digest({ previous: contextPriority, role, anchor });
    if (role === "user" && !classification.kind) precedingEvent = digest({ role, anchor });
    let position: ContextRuleSourcePosition | undefined;
    if (entry.position && "system_index" in entry.position) {
      const index = systemPositions.get(rawIndex);
      if (index !== undefined && candidate.context.systemPrompt?.[index] === canonical.context.systemPrompt?.[entry.position.system_index]) position = { system_index: index };
    } else if (entry.position && "message_index" in entry.position) {
      const index = canonical === candidate ? entry.position.message_index : candidateMessagePositions.get(entry.position.message_index);
      if (index !== undefined) position = { message_index: index };
    }
    if (!position) continue;
    if (!classification.kind) { miss(classification.reason!, position); continue; }
    if (!(role === "system" ? systemOrderUnchanged : messageOrderUnchanged)) { miss("rule_priority_unproven", position); continue; }
    if (!identity) { miss("missing_source_id", position); continue; }
    if (counts.get(item.id as string) !== 1) { miss("duplicate_source_id", position); continue; }
    result.units.push({ identity, kind: classification.kind, role, scope,
      sourceDigest: digest({ source: "responses.input", item, identity, role, scope }), position });
  }
  result.units.sort((a, b) => "system_index" in a.position
    ? "system_index" in b.position ? a.position.system_index - b.position.system_index : -1
    : "system_index" in b.position ? 1 : a.position.message_index - b.position.message_index);
  if (overflow) result.misses.push({ reason: "additional_misses", count: overflow });
  return result;
}
