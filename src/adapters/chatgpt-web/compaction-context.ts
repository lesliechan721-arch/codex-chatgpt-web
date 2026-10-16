import { createHash } from "node:crypto";
import { estimateTokens, withTokenEstimateCache } from "../../lib/token-estimate";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, resolveChatGptWebContextLimits, type ChatGptWebBackendModel, type ChatGptWebAdapterEffort } from "../../chatgpt-web-models";
import type { CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import type { ChatGptTurnSession } from "./turn-execution";
import { contextLimits, assertContextNavigationBudget, contextErrorReserve, measureContextResponse, type ContextLimitOverrides } from "./context-budget";
import { ContextNavigator } from "./context-navigator";
import { compactionContextPrompt } from "./context-prompt";
import { createContextSnapshot, deterministicContextJson, type ContextSnapshot } from "./context-snapshot";
import { continuityError } from "./continuity-errors";
import type { CompactionContextRegistration } from "./context-runtime";
import type { TurnBrokerOwner, BrokerToolRequest } from "./turn-broker";
import type { ChatGptWebCapabilities } from "./model";
import type { ContextDelivery, ContextSourceEvidence } from "./context-types";
import { COMPACT_PROMPT } from "../../responses/compaction";
import { compileChatGptWebPrompt, type CompiledChatGptWebPrompt, type CompileChatGptWebPromptOptions } from "./prompt";
import { assertContinuityCompiledInput } from "./continuity-input";
import { validateContextCoverageMetadata, type ContextCoverageMetadata } from "./context-coverage-journal";

const MAX_COVERAGE_BYTES = 512 * 1024;
export const COMPACTION_SUMMARY_RESERVE = 8_192;
const compactionPageEntries = new WeakMap<ContextSnapshot, { token: string; instructionTokens: number }>();
export interface CompactionSourcePlan {
  historyRevision: number;
  pageGeneration: string;
  planId: string;
  bodyDigest: string;
  manifestDigest: string;
  /** Fixed with the selected input; absent only for legacy coverage. */
  contextFormat?: ContextCoverageMetadata["contextFormat"];
  /** Actual retained page estimate, including selected input and reserved output,
   * excluding the platform reserve shared by the whole context window. */
  pageTokens: number;
  navigationReservedTokens?: number;
  externalizedTargetIds: readonly string[];
  deliveryByTarget?: Readonly<Record<string, ContextDelivery>>;
}
interface CoverageRecord extends Omit<CompactionSourcePlan, "externalizedTargetIds" | "deliveryByTarget"> {
  versions: string[];
  externalizedVersions: string[];
  routes: Array<{ version: string; delivery: string; mediaRoute?: "mcp" | "attachment" | "unavailable"; required: boolean }>;
  delivered: boolean;
  navigationUsage?: { tokens: number; wireBytes: number; reservedTokensUsed: number; chargedTokens: number };
  toolResults?: Array<{ callId: string; versions: string[]; delivered: boolean; tokens: number }>;
  acceptedUpdates?: string[][];
  issuedCalls?: Array<{ callId: string; freeform: boolean; argumentDigest: string }>;
}
function versions(snapshot: ContextSnapshot): string[] {
  return snapshot.targets.map(target => createHash("sha256").update(deterministicContextJson({
    kind: target.kind, role: target.original_role, call: target.call_id,
    // Result names are derived only from uniquely paired calls and can be absent in a
    // legitimate result-only return. The call target separately proves its own name.
    tool: target.kind === "tool_arguments" ? target.tool_name : null,
    namespace: target.kind === "tool_arguments" ? target.namespace : null,
    value: target.kind === "image" ? target.content_digest : snapshot.getText(target.read_ref ?? ""),
  })).digest("hex"));
}
function unavailable(message: string): never { throw continuityError("continuity_source_unproven", message); }

/** Digest-only source ledger. It outlives ordinary capabilities, never their readable bytes.
 * Call prepare only for the selected branch, then markDelivered on actual delivery evidence.
 * A journal may persist metadata(), but must independently restore and verify original sources.
 */
export class CompactionSourceCoverage {
  private records: CoverageRecord[] = [];
  private persistence?: (metadata: readonly Readonly<CoverageRecord>[]) => void;
  private admission?: (metadata: readonly Readonly<CoverageRecord>[]) => void;
  /** Read-only journal verification; this does not restore source data or capabilities. */
  static assertRecordedSource(snapshot: ContextSnapshot, metadata: readonly ContextCoverageMetadata[], historyRevision: number): void {
    if (!metadata.length) unavailable("The recovered compaction source has no complete source coverage journal.");
    metadata.forEach(validateContextCoverageMetadata);
    const ledger = new CompactionSourceCoverage();
    ledger.records = structuredClone([...metadata]);
    const latest = ledger.records.at(-1)!;
    ledger.prove(snapshot, { historyRevision, pageGeneration: latest.pageGeneration });
  }
  /** Rebuild evidence only after independently verifying fixed recovered bytes. */
  static restoreVerifiedSource(snapshot: ContextSnapshot, metadata: readonly ContextCoverageMetadata[],
    historyRevision: number): CompactionSourceCoverage {
    CompactionSourceCoverage.assertRecordedSource(snapshot, metadata, historyRevision);
    if (snapshot.targets.some(target => !target.read_ref)) unavailable("A recovered source image has no fixed readable bytes.");
    const ledger = new CompactionSourceCoverage();
    ledger.records = structuredClone([...metadata]);
    if (Buffer.byteLength(JSON.stringify(ledger.records)) > MAX_COVERAGE_BYTES) throw continuityError("continuity_resource_capacity");
    return ledger;
  }
  bindPersistence(persist: (metadata: readonly Readonly<CoverageRecord>[]) => void,
    initialMetadata: readonly Readonly<CoverageRecord>[] = this.metadata()): void {
    persist(initialMetadata); this.persistence = persist;
  }
  /** The session's existing evidence limit applies before journal or live publication. */
  bindAdmission(admit: (metadata: readonly Readonly<CoverageRecord>[]) => void): void {
    admit(this.metadata()); this.admission = admit;
  }
  private publish(records: CoverageRecord[]): void {
    this.admission?.(structuredClone(records)); this.persistence?.(structuredClone(records)); this.records = records;
  }
  fork(): CompactionSourceCoverage {
    const next = new CompactionSourceCoverage(); next.records = structuredClone(this.records); return next;
  }
  /** Transfer publication uses a clone that passed capacity admission before commit. */
  acceptPreparedCoverage(prepared: CompactionSourceCoverage): void { this.publish(structuredClone(prepared.records)); }
  prepare(snapshot: ContextSnapshot, plan: CompactionSourcePlan): void {
    if (!Number.isSafeInteger(plan.historyRevision) || plan.historyRevision < 0
      || !Number.isSafeInteger(plan.pageTokens) || plan.pageTokens < 0
      || plan.contextFormat !== undefined && plan.contextFormat !== "legacy-json" && plan.contextFormat !== "codex-context-text-v1"
      || plan.navigationReservedTokens !== undefined && (!Number.isSafeInteger(plan.navigationReservedTokens) || plan.navigationReservedTokens < 0 || plan.navigationReservedTokens > plan.pageTokens)
      || [plan.pageGeneration, plan.planId, plan.bodyDigest, plan.manifestDigest].some(v => !v || v.length > 256)) {
      unavailable("The selected source plan has invalid coverage metadata.");
    }
    const all = versions(snapshot);
    const externalizedVersions = plan.externalizedTargetIds.map(id => {
      const index = snapshot.targets.findIndex(target => target.target_id === id);
      if (index < 0) unavailable("The source plan references an unknown source target.");
      return all[index]!;
    });
    const routes = Object.entries(plan.deliveryByTarget ?? {}).map(([id, route]) => {
      const index = snapshot.targets.findIndex(target => target.target_id === id);
      if (index < 0 || typeof route.delivery !== "string" || route.delivery.length > 80) unavailable("The selected source route is invalid.");
      return { version: all[index]!, delivery: route.delivery,
        ...(route.media_route ? { mediaRoute: route.media_route } : {}), required: route.required === true };
    });
    const { externalizedTargetIds: _, deliveryByTarget: _routes, ...metadata } = plan;
    const record = { ...metadata, versions: all, externalizedVersions, routes, delivered: false };
    const existing = this.records.find(r => r.planId === plan.planId);
    if (existing) {
      if (deterministicContextJson({ ...existing, delivered: false }) !== deterministicContextJson(record)) {
        unavailable("The selected source plan changed after preparation.");
      }
      return;
    }
    const next = [...this.records, record];
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_COVERAGE_BYTES) {
      throw continuityError("continuity_resource_capacity", "The bounded source coverage journal is full.");
    }
    this.publish(next);
  }
  markDelivered(planId: string): void {
    const next = structuredClone(this.records);
    const record = next.find(r => r.planId === planId);
    if (!record) unavailable("Delivery has no selected source plan.");
    record.delivered = true;
    this.publish(next);
  }
  metadata(): readonly Readonly<CoverageRecord>[] { return structuredClone(this.records); }
  latest(): Readonly<CoverageRecord> | undefined { return this.metadata().at(-1); }
  pageTokenReserve(): number {
    const latest = this.records.at(-1);
    return (latest?.pageTokens ?? 0) + (latest?.toolResults ?? []).filter(result => !result.delivered).reduce((sum, result) => sum + result.tokens, 0);
  }
  recordNavigationUsage(planId: string, usage: { tokens: number; wireBytes: number; reservedTokensUsed: number }): void {
    const next = structuredClone(this.records); const record = next.find(record => record.planId === planId);
    if (!record || !record.delivered || Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)
      || usage.reservedTokensUsed > Math.min(usage.tokens, record.navigationReservedTokens ?? 0)) unavailable("Navigation usage has no valid selected source plan.");
    const old = record.navigationUsage;
    if (old && (usage.tokens < old.tokens || usage.wireBytes < old.wireBytes || usage.reservedTokensUsed < old.reservedTokensUsed)) {
      unavailable("Navigation usage cannot move backwards.");
    }
    const chargedTokens = Math.max(old?.chargedTokens ?? 0, usage.tokens - usage.reservedTokensUsed);
    record.pageTokens += chargedTokens - (old?.chargedTokens ?? 0);
    record.navigationUsage = { ...usage, chargedTokens };
    if (!Number.isSafeInteger(record.pageTokens) || Buffer.byteLength(JSON.stringify(next)) > MAX_COVERAGE_BYTES) {
      throw continuityError("continuity_resource_capacity");
    }
    this.publish(next);
  }
  private update(mutator: (record: CoverageRecord) => void): void {
    const next = structuredClone(this.records);
    const record = next.at(-1);
    if (!record || !record.delivered) unavailable("New source evidence has no delivered physical source plan.");
    mutator(record);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_COVERAGE_BYTES) throw continuityError("continuity_resource_capacity");
    this.publish(next);
  }
  recordIssuedCalls(requests: readonly BrokerToolRequest[]): void {
    this.update(record => {
      record.issuedCalls ??= [];
      for (const request of requests) {
        const argumentDigest = createHash("sha256").update(request.freeform ? request.input ?? ""
          : deterministicContextJson(request.arguments ?? {})).digest("hex");
        const existing = record.issuedCalls.find(call => call.callId === request.callId);
        if (existing) {
          if (existing.argumentDigest !== argumentDigest || existing.freeform !== request.freeform) unavailable("An issued call changed its accepted arguments.");
        } else record.issuedCalls.push({ callId: request.callId, freeform: request.freeform, argumentDigest });
      }
    });
  }
  prepareToolResults(parsed: CodexParsedRequest, callIds: readonly string[]): void {
    if (!callIds.length) return;
    const snapshot = createContextSnapshot(parsed); const all = versions(snapshot);
    this.update(record => {
      record.toolResults ??= [];
      for (const callId of callIds) {
        const indices = snapshot.targets.flatMap((target, index) => target.original_role === "toolResult" && target.call_id === callId ? [index] : []);
        if (!indices.length) unavailable("An accepted tool result has no readable source representation.");
        const resultVersions = indices.map(index => all[index]!);
        const existing = record.toolResults.find(result => result.callId === callId);
        if (existing) {
          if (deterministicContextJson(existing.versions) !== deterministicContextJson(resultVersions)) unavailable("An accepted tool result changed its source version.");
          continue;
        }
        const tokens = indices.reduce((sum, index) => {
          const target = snapshot.targets[index]!;
          return sum + (target.kind === "image" ? target.visual_token_reserve ?? 0 : estimateTokens(snapshot.getText(target.read_ref ?? "") ?? ""));
        }, 0);
        record.toolResults.push({ callId, versions: resultVersions, delivered: false, tokens });
      }
    });
  }
  markToolResultDelivered(callId: string): void {
    this.update(record => {
      const result = record.toolResults?.find(result => result.callId === callId);
      if (!result) unavailable("A delivered tool result has no prepared source version.");
      if (!result.delivered) { result.delivered = true; record.pageTokens += result.tokens; }
    });
  }
  /** The existing task-update commit receipt proves this source was accepted/delivered. */
  recordTaskUpdate(snapshot: ContextSnapshot): void {
    const all = versions(snapshot);
    const known = new Map<string, number>();
    for (const record of this.records) for (const list of [record.versions, ...record.acceptedUpdates ?? []]) {
      const counts = new Map<string, number>();
      for (const version of list) counts.set(version, (counts.get(version) ?? 0) + 1);
      for (const [version, count] of counts) known.set(version, Math.max(known.get(version) ?? 0, count));
    }
    const seen = new Map<string, number>();
    let newTokens = 0;
    const userVersions = snapshot.targets.flatMap((target, index) => {
      if (target.original_role !== "user" || target.kind !== "message_text") return [];
      const version = all[index]!;
      const count = (seen.get(version) ?? 0) + 1; seen.set(version, count);
      if (count > (known.get(version) ?? 0)) newTokens += estimateTokens(snapshot.getText(target.read_ref ?? "") ?? "");
      return [version];
    });
    this.update(record => { (record.acceptedUpdates ??= []).push(userVersions); record.pageTokens += newTokens; });
  }
  prove(snapshot: ContextSnapshot, binding: { historyRevision: number; pageGeneration: string }): void {
    const current = this.records.at(-1);
    if (!current || !current.delivered || current.historyRevision !== binding.historyRevision
      || current.pageGeneration !== binding.pageGeneration) unavailable("The page source coverage is absent, pending, or stale.");
    const actual = versions(snapshot);
    for (const record of this.records.filter(r => r.historyRevision === binding.historyRevision)) {
      if (!record.delivered) unavailable("The source chain contains an unresolved Send.");
      let position = 0;
      for (const version of record.versions) {
        const found = actual.indexOf(version, position);
        if (found < 0) unavailable("The compaction request is missing or changed an uncovered source version.");
        position = found + 1;
      }
      for (const expected of [...record.toolResults?.map(result => result.versions) ?? [], ...record.acceptedUpdates ?? []]) {
        let next = 0;
        for (const version of expected) {
          const found = actual.indexOf(version, next);
          if (found < 0) unavailable("The compaction source omits a real tool result or accepted task update.");
          next = found + 1;
        }
      }
      for (const call of record.issuedCalls ?? []) {
        const targets = snapshot.targets.filter(target => target.kind === "tool_arguments" && target.call_id === call.callId);
        if (targets.length !== 1) unavailable("The compaction source omits an issued call or contains ambiguous call arguments.");
        const text = snapshot.getText(targets[0]!.read_ref ?? "");
        let value: string;
        try { value = call.freeform ? text! : deterministicContextJson(JSON.parse(text!)); }
        catch { unavailable("The compaction call arguments have no accepted representation."); }
        if (createHash("sha256").update(value).digest("hex") !== call.argumentDigest) unavailable("The compaction source changed an issued call's arguments.");
      }
    }
  }
  /** Invoke only after the original checkpoint commit succeeded. */
  checkpointCommitted(historyRevision: number): void {
    this.publish(this.records.filter(record => record.historyRevision > historyRevision));
  }
}

export function captureCompactionSource(parsed: CodexParsedRequest, coverage: CompactionSourceCoverage,
  provenanceByMessage?: ReadonlyMap<number, ContextSourceEvidence>): ContextSnapshot {
  const snapshot = createContextSnapshot(parsed, { provenanceByMessage });
  const latest = coverage.latest();
  if (!latest) unavailable("Compaction has no accepted source coverage evidence.");
  coverage.prove(snapshot, { historyRevision: parsed._continuityHistoryRevision ?? latest.historyRevision,
    pageGeneration: latest.pageGeneration });
  if (snapshot.targets.some(target => !target.read_ref)) unavailable("A compaction source image has no fixed readable bytes.");
  return snapshot;
}

/** Call only after the original source/revision/ACK/result checks. Retained actual
 * sources can complete a trimmed HTTP view; digest coverage still proves every item. */
export function captureRetainedCompactionSource(parsed: CodexParsedRequest, source: ChatGptTurnSession): ContextSnapshot {
  const coverage = source.runtime.compactionSourceCoverage;
  if (!coverage) unavailable("Compaction has no accepted source coverage evidence.");
  const { accepted, provenance } = retainedCompactionInput(parsed, source);
  return captureCompactionSource(accepted, coverage, provenance);
}

/** Capacity preview does not accept results or publish source coverage. The actual
 * source transaction must still validate and admit the first real result. */
export function previewRetainedCompactionSource(parsed: CodexParsedRequest, source: ChatGptTurnSession): {
  snapshot: ContextSnapshot; coverage: CompactionSourceCoverage;
} {
  const coverage = source.runtime.compactionSourceCoverage?.fork();
  if (!coverage) unavailable("Compaction has no accepted source coverage evidence.");
  const { accepted, provenance } = retainedCompactionInput(parsed, source);
  coverage.prepareToolResults(accepted, source.outstanding().map(call => call.callId));
  return { snapshot: captureCompactionSource(accepted, coverage, provenance), coverage };
}

function retainedCompactionInput(parsed: CodexParsedRequest, source: ChatGptTurnSession): {
  accepted: CodexParsedRequest; provenance: ReadonlyMap<number, ContextSourceEvidence>;
} {
  const original = source.runtime.continuityBinding?.initialAcceptedInput ?? source.runtime.usageInput ?? parsed;
  const raw = (value: CodexParsedRequest): unknown[] => {
    const body = value._rawBody as { input?: unknown[] } | undefined;
    return Array.isArray(body?.input) ? body.input : [];
  };
  const input: unknown[] = []; const known = new Map<string, number>();
  for (const list of [source.canonicalInput() ?? [], raw(original), raw(parsed)]) {
    const seen = new Map<string, number>();
    for (const value of list) {
      const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const isResult = item && ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type));
      const accepted = isResult && typeof item.call_id === "string" ? source.continuityReceivedToolResult(item.call_id) ?? value : value;
      const key = item && typeof item.call_id === "string" ? `call:${String(item.type)}:${item.call_id}`
        : item && typeof item.id === "string" ? `id:${item.id}` : `value:${deterministicContextJson(accepted)}`;
      const count = (seen.get(key) ?? 0) + 1; seen.set(key, count);
      if (count > (known.get(key) ?? 0)) input.push(structuredClone(accepted));
    }
    for (const [key, count] of seen) known.set(key, Math.max(known.get(key) ?? 0, count));
  }
  const accepted = parseRequest({ ...(original._rawBody as Record<string, unknown>), model: parsed.modelId,
    input: source.restoreCompactionIssuedCalls(input) });
  accepted._continuityHistoryRevision = parsed._continuityHistoryRevision;
  const objectCalls = source.compactionObjectArgumentCallIds();
  const provenance = new Map<number, ContextSourceEvidence>();
  // Keep each restored object call separate from original raw-string arguments.
  // Splitting assistant parts preserves source order and the actual part objects.
  const messages: typeof accepted.context.messages = [];
  for (const message of accepted.context.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") { messages.push(message); continue; }
    for (const part of message.content) {
      if (part.type === "toolCall" && objectCalls.has(part.id)) {
        provenance.set(messages.length, { restored: true, tool_arguments_encoding: "deterministic-json" });
      }
      messages.push({ ...message, content: [part] });
    }
  }
  accepted.context = { ...accepted.context, messages };
  return { accepted, provenance };
}

export function compactionAvailableTokens(parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities & { experimentalBiggerContext?: boolean },
  pageTokens: number): number {
  const window = resolveChatGptWebContextLimits(parsed.modelId as ChatGptWebBackendModel,
    (parsed.options.reasoning ?? "high") as ChatGptWebAdapterEffort, capabilities, parsed._chatgptModelFamily).contextWindow;
  // Page estimates accumulate across sends. Keep the platform reserve outside the
  // source ledger so it is deducted once, including fresh pages and restored ledgers.
  return Math.max(0, window - pageTokens - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS);
}

/** Validate individual readability without requiring the whole source to fit the page. */
export async function assertCompactionReadable(snapshot: ContextSnapshot, availableTokens: number,
  overrides: ContextLimitOverrides = {}): Promise<void> {
  const limits = contextLimits(overrides); const errors = contextErrorReserve(overrides);
  const budget = { tokens: Math.min(availableTokens, limits.maxTotalTokens), wire_bytes: limits.maxTotalWireBytes,
    reserved_tokens: COMPACTION_SUMMARY_RESERVE, reserved_wire_bytes: 0 };
  try { assertContextNavigationBudget(budget, overrides); }
  catch { throw continuityError("continuity_input_limit", "There is no bounded source reading allowance after the summary reserve."); }
  const started = performance.now(); let yieldedAt = started;
  const navigator: ContextNavigator = new ContextNavigator({ scopeId: "compaction-preflight", snapshot,
    purpose: "compaction", limits: overrides, remainingBudget: () => {
      const usage = navigator.usage();
      return { ...budget, tokens: Math.max(0, budget.tokens - usage.text_tokens - usage.visual_token_reserve),
        wire_bytes: Math.max(0, budget.wire_bytes - usage.wire_bytes) };
    } });
  // Shared discovery overhead is paid once. Every target still passes the same
  // real single-page serializer and per-response limits without accumulating all-source reads.
  const overview = navigator.list({ context_id: snapshot.context_id, view: "overview" });
  const entries = navigator.list({ context_id: snapshot.context_id, view: "entries" });
  if (performance.now() - started > limits.totalProcessingMs) {
    throw continuityError("continuity_resource_capacity", "Compaction source admission exceeded its bounded processing deadline.");
  }
  if (overview.isError || entries.isError) {
    throw continuityError("continuity_input_limit", "The source overview and discovery page exceed the reading allowance.");
  }
  const directory = navigator.usage();
  for (const [index, target] of snapshot.targets.entries()) {
    if (performance.now() - started > limits.totalProcessingMs) {
      throw continuityError("continuity_resource_capacity", "Compaction source admission exceeded its bounded processing deadline.");
    }
    // Page sizing and admission measure the same response. Share exact token
    // counts only during this synchronous check; release them before yielding.
    withTokenEstimateCache(() => {
      const entry = navigator.preflightListEntry(index);
      const entryCost = measureContextResponse(entry, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve, boundCursorTokens: true });
      if (entry.isError || entryCost.total_tokens + directory.text_tokens + errors.tokens > budget.tokens - COMPACTION_SUMMARY_RESERVE
        || entryCost.wire_bytes + directory.wire_bytes + errors.wire_bytes > budget.wire_bytes) {
        unavailable("A compaction source cannot be discovered within a bounded directory page.");
      }
      const result = navigator.preflightRead({ context_id: snapshot.context_id, read_ref: target.read_ref ?? "" });
      const cost = measureContextResponse(result, { wireReserveBytes: limits.wireReserveBytes,
        tokenReserve: limits.tokenReserve, visualTokens: target.kind === "image" ? target.visual_token_reserve ?? 0 : 0 });
      if (result.isError || cost.total_tokens + directory.text_tokens + directory.visual_token_reserve + errors.tokens
        > budget.tokens - COMPACTION_SUMMARY_RESERVE || cost.wire_bytes + directory.wire_bytes + errors.wire_bytes > budget.wire_bytes) {
        unavailable("A compaction source cannot be returned within a bounded read.");
      }
    });
    if (performance.now() - yieldedAt >= 8) {
      await new Promise<void>(resolve => setImmediate(resolve)); yieldedAt = performance.now();
    }
  }
}

export async function registerCompactionSource(broker: TurnBrokerOwner, input: Omit<CompactionContextRegistration, "remainingBudget"> & {
  availableTokens: number;
}, instruction: string, ownerContext?: Parameters<NonNullable<TurnBrokerOwner["registerCompactionContext"]>>[1]): Promise<{
  instruction: string; token: string;
}> {
  if (!broker.registerCompactionContext || !broker.revokeCompactionContext || !broker.markCompactionContextDelivered
    || !broker.guardCompactionContextCommit) unavailable("The connector has no compaction source capability.");
  // Charge a fixed entry reserve before creating credentials; charge the exact control below.
  const { availableTokens, ...registration } = input;
  const remaining = Math.min(contextLimits(input.limits).maxTotalTokens, availableTokens - estimateTokens(instruction) - 4_096);
  await assertCompactionReadable(input.snapshot, remaining, input.limits);
  const handle = await broker.registerCompactionContext({ ...registration,
    remainingBudget: { tokens: remaining, wire_bytes: contextLimits(input.limits).maxTotalWireBytes,
      reserved_tokens: COMPACTION_SUMMARY_RESERVE, reserved_wire_bytes: 0 } }, ownerContext);
  try {
    if (handle.contextId !== input.snapshot.context_id) unavailable("The compaction source registration changed its fixed context identity.");
    const selectedInstruction = compactionSourceInstruction(input.snapshot, instruction, availableTokens,
      handle.compactionToken, input.limits);
    compactionPageEntries.set(input.snapshot, { token: handle.compactionToken, instructionTokens: estimateTokens(selectedInstruction) });
    return { instruction: selectedInstruction, token: handle.compactionToken };
  } catch (error) { await broker.revokeCompactionContext(handle.compactionToken); throw error; }
}

/** A checkpoint changes the logical source revision, not the physical page.
 * Preserve the exact entry and confirmed navigation cost before clearing its ledger. */
export async function compactionSourcePageCost(broker: TurnBrokerOwner, snapshot: ContextSnapshot): Promise<number | undefined> {
  const entry = compactionPageEntries.get(snapshot);
  if (!entry) return undefined;
  const evidence = await broker.contextUsage?.(entry.token);
  if (!evidence || !evidence.final || evidence.purpose !== "compaction" || evidence.context_id !== snapshot.context_id) return undefined;
  const cost = entry.instructionTokens + evidence.usage.text_tokens + evidence.usage.visual_token_reserve;
  return Number.isSafeInteger(cost) && cost >= 0 ? cost : undefined;
}

/** The exact read-only entry used for cold compaction admission. It contains no
 * historical task text; the independently verified snapshot remains readable. */
export function compactionSourceInstruction(snapshot: ContextSnapshot, instruction: string, availableTokens: number,
  compactionToken = `compaction_${"0".repeat(32)}`, overrides: ContextLimitOverrides = {}): string {
  const remaining = Math.min(contextLimits(overrides).maxTotalTokens, availableTokens - estimateTokens(instruction) - 4_096);
  const navigation = compactionContextPrompt({ contextId: snapshot.context_id, compactionToken,
    overview: { sources: snapshot.sources.length, targets: snapshot.targets.length,
      images: snapshot.targets.filter(target => target.kind === "image").length,
      remaining_tokens: remaining, summary_reserved_tokens: COMPACTION_SUMMARY_RESERVE } }).join("\n");
  if (estimateTokens(navigation) > 4_096) throw continuityError("continuity_input_limit");
  return `${instruction}\n\n${navigation}`;
}

/** Existing fresh-page/manual compaction only. The caller owns the original writer/Send
 * admission and must supply an actual source-chain proof when no live ledger survives. */
export async function prepareFreshCompactionSource(parsed: CodexParsedRequest, broker: TurnBrokerOwner,
  capabilities: ChatGptWebCapabilities, options: {
    historyRevision: number; ownerGeneration: string; traceId: string; timeoutMs?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
    recovery?: import("./continuity-recovery-runtime").RuntimeRecoveryReference;
    sourceCoverage?: CompactionSourceCoverage;
    /** Independent fixed source captured after the original live source proof. */
    sourceSnapshot?: ContextSnapshot;
    verifyCompleteSource?: (snapshot: ContextSnapshot) => void | Promise<void>;
    /** Additional selected-input check for an existing send contract. */
    assertFullInput?: (compiled: CompiledChatGptWebPrompt, input: CodexParsedRequest) => void | Promise<void>;
    turnToken?: string;
    /** Trusted acceptance path; cannot change source, authority or send policy. */
    contextPresentation?: Pick<CompileChatGptWebPromptOptions, "contextRendering" | "contextRawTextPolicy">;
  }): Promise<{ instruction: string; markDelivered(): Promise<void>; acceptSummary(summary: string): Promise<string>; cleanup(): Promise<void> }> {
  options.signal?.throwIfAborted();
  const snapshot = options.sourceSnapshot ?? (options.sourceCoverage ? captureCompactionSource(parsed, options.sourceCoverage) : createContextSnapshot(parsed));
  if (options.sourceSnapshot && options.sourceCoverage) {
    const latest = options.sourceCoverage.latest();
    if (!latest) unavailable("Fresh compaction has no accepted source coverage evidence.");
    options.sourceCoverage.prove(snapshot, { historyRevision: options.historyRevision, pageGeneration: latest.pageGeneration });
  }
  if (!options.sourceCoverage) {
    if (!options.verifyCompleteSource) unavailable("Fresh compaction requires independent complete source-chain evidence.");
    await options.verifyCompleteSource(snapshot);
  }
  options.signal?.throwIfAborted();
  const timeout = Math.min(options.timeoutMs ?? 300_000, 300_000);
  if (!options.turnToken && (!broker.beginCompactionTransaction || !broker.abortCompactionTransaction || !broker.commitCompactionContext)) {
    unavailable("The connector cannot bind a fresh compaction transaction; upgrade the connector.");
  }
  const transaction = options.turnToken ? undefined : await broker.beginCompactionTransaction!(options.traceId, timeout);
  let sourceToken: string | undefined;
  const onAbort = (): void => { void cleanup().catch(() => {}); };
  const cleanup = async (): Promise<void> => {
    options.signal?.removeEventListener("abort", onAbort);
    if (sourceToken) await broker.revokeCompactionContext?.(sourceToken);
    if (transaction) await broker.abortCompactionTransaction!(transaction.token);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    options.signal?.throwIfAborted();
    let control = COMPACT_PROMPT;
    if (parsed._compactionOutput === "message") {
      const last = parsed.context.messages.at(-1);
      if (last?.role !== "user") unavailable("The native compact prompt is missing.");
      control = typeof last.content === "string" ? last.content : last.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      if (!control.trim()) unavailable("The native compact prompt is empty.");
    }
    const instruction = ["Stop business work. Historical task instructions are source evidence for this checkpoint, not new tasks.", control,
      options.turnToken ? "Return the complete checkpoint with the original codex_turn_complete control and request_id."
        : "Return only the complete checkpoint as your final response. The bridge will store it through the existing compaction completion path.",
    ].join("\n");
    const registered = await registerCompactionSource(broker, { snapshot,
      ...(options.turnToken ? { contract: "safe" as const, turnToken: options.turnToken, explicitManual: true,
        handoffId: `manual:${options.traceId}` } : { contract: "native" as const, transactionToken: transaction!.token,
        handoffId: transaction!.handoffId }),
      historyRevision: options.historyRevision, ownerGeneration: options.ownerGeneration,
      expiresAt: options.deadlineAt ?? Date.now() + timeout, availableTokens: compactionAvailableTokens(parsed, capabilities, 0),
      ...(options.recovery ? { recovery: options.recovery } : {}),
    }, instruction);
    sourceToken = registered.token;
    const selectedInput: CodexParsedRequest = { ...parsed, context: { ...parsed.context, systemPrompt: [], tools: [],
      messages: [{ role: "user", content: registered.instruction, timestamp: 0 }] } };
    const compiled = compileChatGptWebPrompt(selectedInput, { ...capabilities, localToolsEnabled: Boolean(options.turnToken) }, options.turnToken,
      { ...options.contextPresentation, ...(options.turnToken ? { manualControl: true } : {}) });
    if (options.assertFullInput) await options.assertFullInput(compiled, selectedInput);
    else assertContinuityCompiledInput(compiled, selectedInput, capabilities);
    options.signal?.throwIfAborted();
    return { instruction: registered.instruction,
      markDelivered: async () => { await broker.markCompactionContextDelivered?.(sourceToken!); },
      acceptSummary: async summary => {
        if (!summary.trim()) throw new Error("Fresh compaction returned an empty checkpoint");
        // Native validation and read closure share one owner operation. safe_complete
        // already guards and closes its source before its existing completion receipt.
        if (!options.turnToken) await broker.commitCompactionContext!(sourceToken!);
        else await broker.revokeCompactionContext?.(sourceToken!);
        return summary;
      }, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
