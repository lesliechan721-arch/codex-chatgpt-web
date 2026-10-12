import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import type { WebContextFormat } from "./context-renderer";

/** Persisted identities and digests only. This is never a source restoration format. */
export interface ContextCoverageMetadata {
  historyRevision: number; pageGeneration: string; planId: string;
  bodyDigest: string; manifestDigest: string; pageTokens: number;
  /** Missing only in historical journals, whose inputs used legacy-json. */
  contextFormat?: WebContextFormat;
  navigationReservedTokens?: number;
  navigationUsage?: { tokens: number; wireBytes: number; reservedTokensUsed: number; chargedTokens: number };
  versions: string[]; externalizedVersions: string[];
  routes: Array<{ version: string; delivery: string; mediaRoute?: "mcp" | "attachment" | "unavailable"; required: boolean }>;
  delivered: boolean;
  toolResults?: Array<{ callId: string; versions: string[]; delivered: boolean; tokens: number }>;
  acceptedUpdates?: string[][];
  issuedCalls?: Array<{ callId: string; freeform: boolean; argumentDigest: string }>;
}
export interface ContextCoverageJournalEntry {
  ownerId: string; logicalWorkId: string; workLineageId: string;
  attempt: number; epoch: number; acceptedTaskRevision: number; sourceTaskRevision: number;
  metadata: ContextCoverageMetadata;
}
/** Candidate capacity only; it supplies no delivery or source coverage evidence. */
export interface ContextCoverageReservation {
  ownerId: string; logicalWorkId: string; attempt: number; epoch: number; historyRevision: number;
  candidateDigests: string[]; bytes: number;
}
function invalid(): never { throw continuityError("continuity_configuration_conflict", "Context coverage journal has an invalid digest-only schema."); }
function object(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function hash(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
function identity(value: unknown): void { if (typeof value !== "string" || !/^[A-Za-z0-9_.:@+-]{1,256}$/.test(value)) invalid(); }
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(); }
function boolean(value: unknown): void { if (typeof value !== "boolean") invalid(); }
function array(value: unknown): asserts value is unknown[] { if (!Array.isArray(value)) invalid(); }
function hashes(value: unknown): void { array(value); value.forEach(hash); }
export function validateContextCoverageMetadata(value: unknown): asserts value is ContextCoverageMetadata {
  object(value, ["historyRevision", "pageGeneration", "planId", "bodyDigest", "manifestDigest", "pageTokens", "versions", "externalizedVersions", "routes", "delivered"], ["toolResults", "acceptedUpdates", "issuedCalls", "navigationReservedTokens", "navigationUsage", "contextFormat"]);
  integer(value.historyRevision); integer(value.pageTokens); identity(value.pageGeneration); identity(value.planId);
  hash(value.bodyDigest); hash(value.manifestDigest); hashes(value.versions); hashes(value.externalizedVersions); boolean(value.delivered);
  if (value.contextFormat !== undefined && value.contextFormat !== "legacy-json" && value.contextFormat !== "codex-context-text-v1") invalid();
  const navigationReserved = value.navigationReservedTokens ?? 0;
  integer(navigationReserved);
  if (Number(navigationReserved) > Number(value.pageTokens)) invalid();
  if (value.navigationUsage !== undefined) {
    object(value.navigationUsage, ["tokens", "wireBytes", "reservedTokensUsed", "chargedTokens"]);
    const usage = value.navigationUsage;
    for (const field of ["tokens", "wireBytes", "reservedTokensUsed", "chargedTokens"]) integer(usage[field]);
    if (!value.delivered || Number(usage.reservedTokensUsed) > Math.min(Number(usage.tokens), Number(navigationReserved))
      || Number(usage.chargedTokens) < Number(usage.tokens) - Number(usage.reservedTokensUsed)
      || Number(usage.chargedTokens) > Number(usage.tokens)
      || Number(value.pageTokens) < Number(navigationReserved) + Number(usage.chargedTokens)) invalid();
  }
  array(value.routes);
  for (const route of value.routes) {
    object(route, ["version", "delivery", "required"], ["mediaRoute"]); hash(route.version); boolean(route.required);
    if (typeof route.delivery !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(route.delivery)
      || route.mediaRoute !== undefined && !["mcp", "attachment", "unavailable"].includes(String(route.mediaRoute))) invalid();
    if (!(value.versions as string[]).includes(String(route.version))) invalid();
  }
  if ((value.externalizedVersions as string[]).some(version => !(value.versions as string[]).includes(version))) invalid();
  if (value.toolResults !== undefined) {
    array(value.toolResults); const calls = new Set();
    for (const result of value.toolResults) {
      object(result, ["callId", "versions", "delivered", "tokens"]); identity(result.callId); hashes(result.versions); boolean(result.delivered); integer(result.tokens);
      if (calls.has(result.callId)) invalid(); calls.add(result.callId);
    }
  }
  if (value.acceptedUpdates !== undefined) { array(value.acceptedUpdates); value.acceptedUpdates.forEach(hashes); }
  if (value.issuedCalls !== undefined) {
    array(value.issuedCalls); const calls = new Set();
    for (const call of value.issuedCalls) {
      object(call, ["callId", "freeform", "argumentDigest"]); identity(call.callId); boolean(call.freeform); hash(call.argumentDigest);
      if (calls.has(call.callId)) invalid(); calls.add(call.callId);
    }
  }
}
export function validateContextCoverageJournal(value: unknown): asserts value is ContextCoverageJournalEntry[] {
  array(value); const plans = new Set();
  for (const entry of value) {
    object(entry, ["ownerId", "logicalWorkId", "workLineageId", "attempt", "epoch", "acceptedTaskRevision", "sourceTaskRevision", "metadata"]);
    hash(entry.ownerId); identity(entry.logicalWorkId); identity(entry.workLineageId);
    integer(entry.attempt); integer(entry.epoch); integer(entry.acceptedTaskRevision); integer(entry.sourceTaskRevision); validateContextCoverageMetadata(entry.metadata);
    if (plans.has(entry.metadata.planId)) invalid(); plans.add(entry.metadata.planId);
  }
}
export function validateContextCoverageReservations(value: unknown): asserts value is ContextCoverageReservation[] {
  array(value); const owners = new Set();
  for (const reservation of value) {
    object(reservation, ["ownerId", "logicalWorkId", "attempt", "epoch", "historyRevision", "candidateDigests", "bytes"]);
    hash(reservation.ownerId); identity(reservation.logicalWorkId); integer(reservation.attempt); integer(reservation.epoch);
    integer(reservation.historyRevision); integer(reservation.bytes); hashes(reservation.candidateDigests);
    if ((reservation.candidateDigests as string[]).length < 1 || (reservation.candidateDigests as string[]).length > 2) invalid();
    const key = `${reservation.logicalWorkId}:${reservation.attempt}`;
    if (owners.has(key)) invalid(); owners.add(key);
  }
}
/** Only monotone evidence changes are permitted before a successful checkpoint. */
export function assertContextCoverageAdvance(before: ContextCoverageMetadata, after: ContextCoverageMetadata): void {
  const reject = (): never => { throw continuityError("continuity_source_unproven", "Uncheckpointed context source evidence cannot be removed or replaced."); };
  const fixed = (value: ContextCoverageMetadata) => ({ ...value, delivered: undefined, pageTokens: undefined,
    toolResults: undefined, acceptedUpdates: undefined, issuedCalls: undefined, navigationUsage: undefined });
  if (canonicalJson(fixed(before)) !== canonicalJson(fixed(after)) || before.delivered && !after.delivered || after.pageTokens < before.pageTokens) reject();
  if (before.navigationUsage && !after.navigationUsage) reject();
  for (const field of ["tokens", "wireBytes", "reservedTokensUsed", "chargedTokens"] as const) {
    if ((after.navigationUsage?.[field] ?? 0) < (before.navigationUsage?.[field] ?? 0)) reject();
  }
  if (after.pageTokens - before.pageTokens < (after.navigationUsage?.chargedTokens ?? 0) - (before.navigationUsage?.chargedTokens ?? 0)) reject();
  for (const [index, update] of (before.acceptedUpdates ?? []).entries()) {
    if (canonicalJson(update) !== canonicalJson(after.acceptedUpdates?.[index] ?? null)) reject();
  }
  for (const call of before.issuedCalls ?? []) {
    if (canonicalJson(call) !== canonicalJson(after.issuedCalls?.find(value => value.callId === call.callId) ?? null)) reject();
  }
  for (const result of before.toolResults ?? []) {
    const current = after.toolResults?.find(value => value.callId === result.callId);
    if (!current || result.delivered && !current.delivered
      || canonicalJson({ ...result, delivered: false }) !== canonicalJson({ ...current, delivered: false })) reject();
  }
}
