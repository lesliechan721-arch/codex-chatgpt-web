import { createHash } from "node:crypto";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../../chatgpt-web-models";
import { estimateTokens, withTokenEstimateCache } from "../../lib/token-estimate";
import type { CodexImageContent, CodexMessage, CodexParsedRequest } from "../../types";
import { parseRequest } from "../../responses/parser";
import { contextErrorReserve, contextLimits, contextBudgetProfileLimits, measureContextResponse, UNLIMITED_CONTEXT_ALLOWANCE, type ContextBudgetProfile, type ContextLimitOverrides, type ContextLimits, type ContextResponseCost } from "./context-budget";
import { ContextDeliveryPlanningError, planContextMedia, type ContextMediaPlan } from "./context-media-plan";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { restoreCompactionTaskMessages } from "./compaction-continuation";
import { chatGptTurnUserRevisionHistory, extractChatGptTurnIdentity } from "./environment";
import { compileChatGptWebPrompt, contextTokenBreakdown,
  type CompiledChatGptWebPrompt, type CompileChatGptWebPromptOptions } from "./prompt";
import type { ContextPlanRegistration } from "./context-runtime";
import { appendFixedContextRecords, deterministicContextJson, type ContextSnapshot } from "./context-snapshot";
import type { ContextDelivery, ContextTarget } from "./context-types";
import { skillFileTokens } from "./skill-attachments";
import { ContextNavigator } from "./context-navigator";
import { type WebContextFormat } from "./context-renderer";
import { shortContextBootstrapPrompt, shortContextReuseBootstrapPrompt } from "./context-prompt";
import { prepareContextReuse } from "./context-reuse-plan";
import type { ContextReuseBaseline, ContextReusePlan } from "./context-reuse-types";
import { measureBootstrapRequiredCosts } from "./context-bootstrap-plan";
import { contextBootstrapRequestMessageIndices } from "./context-bootstrap-request";
import type { ContextBootstrapInlineRequest } from "./context-prompt";
import { resolveLocalCodexAppName } from "./execution-protocol";
import { CONTEXT_PROTOCOL_VERSION } from "./context-protocol";

export const CONTEXT_WORK_RESERVE_TOKENS = 4_096;
export const CONTEXT_MAX_COMPOSER_CODE_POINTS = 8_000;
export const CONTEXT_MAX_FIXED_BOOTSTRAP_CODE_POINTS = 3_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ContextDeliveryPlanInput {
  canonical: CodexParsedRequest;
  snapshot: ContextSnapshot;
  candidate: CodexParsedRequest;
  /** Explicit canonical indices for re-parsed candidates. null denotes trusted synthetic text. */
  messageIndices?: readonly (number | null)[];
  /** Selected canonical raw items, including system images absent from parser messages. */
  rawInputIndices?: readonly number[];
  capabilities: ChatGptWebCapabilities;
  turnToken?: string;
  compileOptions?: CompileChatGptWebPromptOptions;
  /** True only after the new context-tool ABI is verified. */
  contextToolsAvailable: boolean;
  /** Current owner and connector support, independent of historical diagnostics. */
  contextBootstrapAvailable?: boolean;
  /** Current end-to-end reuse capability, independent of bootstrap availability. */
  contextReuseAvailable?: boolean;
  /** Trusted offline A/B control. New plans use profitable tool-field inlining by default. */
  inlineToolFields?: boolean;
  /** Supplied only by the healthy retained-page lifecycle gate. */
  reuseBaseline?: ContextReuseBaseline;
  limits?: ContextLimitOverrides;
  budgetProfile?: ContextBudgetProfile;
  budget?: { contextWindowTokens?: number; retainedTokens?: number; workReserveTokens?: number };
}

export interface ContextDeliveryCosts {
  /** Complete ordinary preparation remains a baseline when the original input cannot be sent. */
  originalPromptTransport: "candidate" | "ordinary_capacity_baseline";
  originalPromptBytes: number;
  promptBytes: number;
  originalContextFormat: WebContextFormat;
  contextFormat: WebContextFormat;
  /** JSON-encoded transport text, distinct from the visible UTF-8 byte count above. */
  originalPromptJsonBytes: number;
  promptJsonBytes: number;
  /** Sum of the actual editor input lengths, before JSON transport encoding. */
  promptCharacters: number;
  originalPromptCodePoints: number;
  promptCodePoints: number;
  maxComposerMessageCodePoints: number;
  fixedBootstrapCodePoints?: number;
  requiredTextTokens?: number;
  requiredTextWireBytes?: number;
  requiredRetryTokens?: number;
  requiredRetryWireBytes?: number;
  netSavedPromptBytes: number;
  promptTokens: number;
  navigationPromptBytes: number;
  requiredMcpWireBytes: number;
  requiredMcpTokens: number;
  attachmentBytes: number;
  attachmentVisualTokens: number;
  retainedTokens: number;
  workReserveTokens: number;
  platformReserveTokens: number;
  discoveryReserveTokens: number;
  discoveryReserveWireBytes: number;
  errorReserveTokens: number;
  errorReserveWireBytes: number;
  requiredNavigationWireBytes: number;
  requiredTotalTokens: number;
  contextWindowTokens: number;
  remainingNavigationTokens: number;
  selection?: { byCategory: Record<string, number>; reasons: Record<string, number>; requiredBodyBytes: number; sourceMapBytes: number; requiredBatches: number;
    toolFields: number; inlinedToolFields: number; externalPositions: number; externalPositionBytes: number; messageSkeletonBytes: number };
  reuse?: NonNullable<ReturnType<typeof prepareContextReuse>>["diagnostics"] & {
    mode: "full" | "incremental"; requiredBodyBytes: number; sourceMapBytes: number;
    inlineUtf16: number; inlineUtf8Bytes: number;
    /** UTF-8 bytes of JSON.stringify(final compiled.text), including quotes and escapes. */
    inlineSerializedBytes: number;
    directoryBytes: number;
  };
}

export interface ContextDeliveryPlan {
  /** Every candidate binds its actual immutable source collection. */
  snapshot: ContextSnapshot;
  compiled: CompiledChatGptWebPrompt;
  /** Projection is private send data; canonical and snapshot are never changed. */
  projected: CodexParsedRequest;
  navigationEnabled: boolean;
  externalizedTargetIds: readonly string[];
  registration?: ContextPlanRegistration;
  planId?: string;
  manifestDigest?: string;
  bodyDigest: string;
  costs: ContextDeliveryCosts;
  limits: ContextLimits;
}

function promptBytes(compiled: CompiledChatGptWebPrompt): number {
  return Buffer.byteLength(compiled.text, "utf8")
    + (compiled.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text, "utf8"), 0);
}
function promptTokens(compiled: CompiledChatGptWebPrompt): number {
  return estimateTokens(compiled.text)
    + skillFileTokens(compiled.skillFiles);
}
function promptJsonBytes(compiled: CompiledChatGptWebPrompt): number {
  return Buffer.byteLength(JSON.stringify(compiled.text), "utf8");
}
function visible(message: CodexMessage): string {
  return deterministicContextJson(Object.fromEntries(Object.entries(message).filter(([key]) => key !== "timestamp")));
}
function mapping(input: ContextDeliveryPlanInput): Map<number, number> {
  const result = new Map<number, number>();
  const references = new Map<CodexMessage, number[]>();
  for (const [index, message] of input.canonical.context.messages.entries()) {
    const indices = references.get(message) ?? []; indices.push(index); references.set(message, indices);
  }
  if (input.messageIndices && input.messageIndices.length !== input.candidate.context.messages.length) {
    throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "The candidate index map has the wrong number of messages");
  }
  for (const [candidateIndex, message] of input.candidate.context.messages.entries()) {
    const explicit = input.messageIndices?.[candidateIndex];
    if (explicit === null) {
      if (Array.isArray(message.content) && message.content.some(part => part.type === "image" || part.type === "toolCall")) {
        throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "Synthetic candidate images or tool calls need a canonical source mapping", { candidate_index: candidateIndex });
      }
      continue;
    }
    const matches = references.get(message) ?? [];
    const canonicalIndex = explicit ?? (matches.length === 1 ? matches[0] : undefined);
    if (canonicalIndex === undefined || !Number.isSafeInteger(canonicalIndex) || canonicalIndex < 0
      || !input.canonical.context.messages[canonicalIndex] || result.has(canonicalIndex)
      || visible(message) !== visible(input.canonical.context.messages[canonicalIndex]!)) {
      throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "The selected candidate message has no exact canonical mapping",
        { candidate_index: candidateIndex, ...(explicit !== undefined ? { canonical_index: explicit } : {}) });
    }
    result.set(canonicalIndex, candidateIndex);
  }
  return result;
}
function selectedRawSystem(input: ContextDeliveryPlanInput, target: ContextTarget): boolean {
  if (input.rawInputIndices) return input.rawInputIndices.includes(target.locator.raw_input_index!);
  if (input.candidate === input.canonical || input.candidate._rawBody === input.canonical._rawBody
    && input.candidate.context.systemPrompt === input.canonical.context.systemPrompt) return true;
  throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "Raw system sources require the selected canonical raw indices", { target_id: target.target_id });
}
function rawImagePart(input: ContextDeliveryPlanInput, target: ContextTarget): CodexImageContent | undefined {
  const raw = input.canonical._rawBody as { input?: Array<{ content?: unknown; output?: unknown }> } | undefined;
  const item = raw?.input?.[target.locator.raw_input_index!];
  const blocks = item?.[target.original_role === "toolResult" ? "output" : "content"];
  const block = Array.isArray(blocks) ? blocks[target.locator.raw_content_index!] : undefined;
  if (!block || typeof block !== "object" || block.type !== "input_image") return undefined;
  return { type: "image", imageUrl: typeof block.image_url === "string" ? block.image_url : `file_id:${String(block.file_id ?? "unavailable")}`,
    ...(typeof block.detail === "string" ? { detail: block.detail } : {}) };
}
function selectedField(input: ContextDeliveryPlanInput, target: ContextTarget, messages: ReadonlyMap<number, number>): unknown {
  const candidate = input.candidate;
  if (target.source_kind === "system" && target.locator.raw_input_index !== undefined) {
    if (!selectedRawSystem(input, target)) return undefined;
    if (target.kind === "image") return rawImagePart(input, target);
    const text = input.canonical.context.systemPrompt?.[target.locator.system_index!];
    return target.locator.text_start !== undefined ? text?.slice(target.locator.text_start, target.locator.text_end_exclusive) : text;
  }
  if (target.locator.system_index !== undefined) {
    const text = candidate.context.systemPrompt?.[target.locator.system_index];
    return target.locator.text_start !== undefined ? text?.slice(target.locator.text_start, target.locator.text_end_exclusive) : text;
  }
  const candidateIndex = messages.get(target.locator.message_index!);
  if (candidateIndex === undefined) return undefined;
  const message = candidate.context.messages[candidateIndex]!;
  if (typeof message.content === "string") {
    if (target.locator.text_start !== undefined) return message.content.slice(target.locator.text_start, target.locator.text_end_exclusive);
    return target.kind === "image" ? rawImagePart(input, target) : target.locator.content_index === undefined ? message.content : undefined;
  }
  const part = message.content[target.locator.content_index!];
  if (!part) return undefined;
  if (target.kind === "image") return part.type === "image" ? part : rawImagePart(input, target);
  if (target.kind === "tool_arguments") return part.type === "toolCall" ? part.arguments : undefined;
  if (target.locator.field === "thinking") return part.type === "thinking" ? part.thinking : undefined;
  return part.type === "text" ? part.text : undefined;
}
function contextRef(snapshot: ContextSnapshot, target: ContextTarget): string {
  return `<codex_context_ref>${JSON.stringify({ context_id: snapshot.context_id, read_ref: target.read_ref, kind: target.kind })}</codex_context_ref>`;
}
function projection(input: ContextDeliveryPlanInput, messages: ReadonlyMap<number, number>, media: ContextMediaPlan): CodexParsedRequest {
  const projected = { ...input.candidate, context: { ...input.candidate.context,
    ...(input.candidate.context.systemPrompt ? { systemPrompt: [...input.candidate.context.systemPrompt] } : {}), messages: structuredClone(input.candidate.context.messages) } };
  for (const target of input.snapshot.targets) {
    if (target.kind === "image" && target.source_kind === "system" && media.deliveryByTarget[target.target_id]?.required) {
      const delivery = media.deliveryByTarget[target.target_id]!;
      (projected.context.systemPrompt ??= []).push(delivery.media_route === "mcp" ? contextRef(input.snapshot, target)
        : `System source image ${target.source_index} / target ${target.target_index} is supplied by the selected image attachment.`);
      continue;
    }
    const candidateIndex = messages.get(target.locator.message_index!);
    if (candidateIndex === undefined) continue;
    const message = projected.context.messages[candidateIndex]!;
    if (target.kind === "image" && Array.isArray(message.content)) {
      const part = message.content[target.locator.content_index!];
      if (part?.type !== "image") continue;
      const delivery = media.deliveryByTarget[target.target_id]!;
      if (delivery.media_route === "attachment") part.imageUrl = media.attachmentUrls.get(target.target_id)!;
      else message.content[target.locator.content_index!] = { type: "text", text: delivery.media_route === "mcp"
        ? contextRef(input.snapshot, target) : `[context image ${target.target_id} unavailable: ${delivery.reason}]` };
    }
  }
  return projected;
}

type ExternalPosition = {
  path: (string | number)[]; source_id: string; source_index: number; original_role: string;
  target_id: string; read_ref: string; encoding: ContextTarget["encoding"]; content_digest: string;
  value_encoding: "text" | "json"; utf8_bytes: number;
};

/** Native turn identity does not add control content to an ordinary assistant record. */
function ordinaryNativeTurnMetadata(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, "internal_chat_message_metadata_passthrough")) return true;
  const metadata = record.internal_chat_message_metadata_passthrough;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const fields = metadata as Record<string, unknown>;
  return Object.keys(fields).every(key => key === "turn_id")
    && typeof fields.turn_id === "string" && fields.turn_id.length > 0;
}

/** Classification uses typed parser/source evidence, never declarations inside source text. */
function ordinaryAssistant(input: ContextDeliveryPlanInput, target: ContextTarget,
  rawMessageMatches: (messageIndex: number) => boolean): boolean {
  if (target.source_kind !== "assistant" || target.kind !== "message_text") return false;
  const message = input.canonical.context.messages[target.locator.message_index!];
  if (message?.role !== "assistant" || !Array.isArray(message.content)
    || Object.keys(message).some(key => !["role", "content", "timestamp", "phase", "model"].includes(key))
    || message.content.some(part => !["text", "thinking", "toolCall"].includes(part.type)
      || part.type === "text" && Object.keys(part).some(key => !["type", "text"].includes(key))
      || part.type === "thinking" && Object.keys(part).some(key => !["type", "thinking", "signature", "itemId", "redacted"].includes(key)))) return false;
  const raw = (input.canonical._rawBody as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(raw)) return !input.canonical._rawBody;
  const records = target.locator.raw_input_index === undefined ? raw : [raw[target.locator.raw_input_index]];
  const ordinaryRecords = records.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    if (value.type === "reasoning") {
      // Reasoning has no role. Its parser projection can omit unknown fields or merge
      // siblings, so the complete source shape must be ordinary before any text is optional.
      if (Object.keys(value).some(key => !["type", "id", "summary", "content", "encrypted_content", "status",
        "internal_chat_message_metadata_passthrough"].includes(key))
        || !ordinaryNativeTurnMetadata(value)
        || value.id !== undefined && typeof value.id !== "string"
        || value.encrypted_content !== undefined && typeof value.encrypted_content !== "string"
        || value.status !== undefined && (typeof value.status !== "string" || !["in_progress", "completed", "incomplete"].includes(value.status))) return false;
      return ([["summary", "summary_text"], ["content", "reasoning_text"]] as const).every(([field, type]) =>
        value[field] === undefined || Array.isArray(value[field]) && value[field].every(part =>
          !!part && typeof part === "object" && !Array.isArray(part) && part.type === type && typeof part.text === "string"
          && Object.keys(part).every(key => ["type", "text"].includes(key))));
    }
    if (value.type !== undefined && value.type !== "message") {
      // These records contribute tool fields, not assistant text. Their fields keep
      // the separate exact tool-source mapping below; an arbitrary role is not evidence.
      return value.role === undefined && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
        "local_shell_call", "tool_search_call", "tool_search_output"].includes(String(value.type));
    }
    if (value.role !== "assistant") return ["system", "developer", "user"].includes(String(value.role));
    // Unknown mixed blocks and unknown message control fields remain required.
    if (Object.keys(value).some(key => !["id", "type", "role", "content", "status", "phase", "end_turn",
      "internal_chat_message_metadata_passthrough"].includes(key)) || !ordinaryNativeTurnMetadata(value)) return false;
    return typeof value.content === "string" || Array.isArray(value.content) && value.content.every(part =>
      !!part && typeof part === "object" && !Array.isArray(part)
      && ["text", "output_text"].includes(String(part.type))
      && Object.keys(part).every(key => ["type", "text", "annotations", "logprobs"].includes(key)));
  });
  // A merged thinking part keeps only its last sibling's signature/itemId. Without
  // a unique raw locator, check every possible contributor and the full parser
  // projection. A matching last sibling alone cannot prove the merged source.
  return ordinaryRecords && (target.locator.raw_input_index !== undefined || rawMessageMatches(target.locator.message_index!));
}

function selectPayloadFields(input: ContextDeliveryPlanInput, source: ContextSnapshot,
  prepared: NonNullable<CompiledChatGptWebPrompt["bootstrapContent"]>, messages: ReadonlyMap<number, number>,
  selected: ReadonlySet<string>): { prepared: typeof prepared; positions: ExternalPosition[]; reasons: Record<string, number> } {
  const payload = structuredClone(prepared.payload);
  const preparedIndices = new Map(prepared.messageSourceIndices.map((sourceIndex, index) => [sourceIndex, index]));
  const positions: ExternalPosition[] = [];
  const reasons: Record<string, number> = {};
  let rawMessages: readonly CodexMessage[] | null | undefined;
  const rawMessageMatches = (index: number): boolean => {
    if (rawMessages === undefined) {
      try { rawMessages = parseRequest(input.canonical._rawBody).context.messages; }
      catch { rawMessages = null; }
    }
    return !!rawMessages && rawMessages.length === input.canonical.context.messages.length
      && !!rawMessages[index] && visible(rawMessages[index]!) === visible(input.canonical.context.messages[index]!);
  };
  const count = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const target of source.targets) {
    if (!selected.has(target.target_id) || target.kind === "image") continue;
    const optional = ordinaryAssistant(input, target, rawMessageMatches)
      || target.kind === "tool_arguments" && target.source_kind === "assistant"
      || target.kind === "tool_result" && target.source_kind === "tool";
    if (!optional) { count(`${target.source_kind}:required_or_unproven`); continue; }
    const index = preparedIndices.get(messages.get(target.locator.message_index!) ?? -1) ?? -1;
    const message = payload.messages[index];
    if (!message || !target.read_ref || !target.content_digest) {
      count(`${target.source_kind}:mapping_unproven`); continue;
    }
    let owner = message, key = "content";
    const path: (string | number)[] = ["messages", index, "content"];
    if (Array.isArray(message.content)) {
      const partIndex = target.locator.content_index;
      const part = partIndex === undefined ? undefined : message.content[partIndex];
      if (!part || typeof part !== "object" || Array.isArray(part)) { count(`${target.source_kind}:mapping_unproven`); continue; }
      owner = part; key = target.kind === "tool_arguments" ? "arguments" : "text";
      path.push(partIndex!, key);
    }
    const text = source.getText(target.read_ref);
    let valueEncoding: "text" | "json" = "text";
    let matches = typeof owner[key] === "string" && owner[key] === text;
    if (!matches && target.kind === "tool_arguments" && typeof text === "string") {
      try { matches = deterministicContextJson(JSON.parse(text)) === deterministicContextJson(owner[key]); valueEncoding = "json"; } catch { /* Retain unmatched parser projections. */ }
    }
    if (!matches) { count(`${target.source_kind}:mapping_unproven`); continue; }
    owner[key] = null;
    positions.push({ path, source_id: target.source_id, source_index: target.source_index, original_role: target.original_role,
      target_id: target.target_id, read_ref: target.read_ref, encoding: target.encoding, content_digest: target.content_digest,
      value_encoding: valueEncoding, utf8_bytes: target.utf8_bytes! });
    count(`${target.source_kind}:optional_exact_field`);
  }
  return { prepared: { ...prepared, payload }, positions, reasons };
}

/** Only already-proven external tool positions can become inline. Compare serialized
 * values, then the aggregate representation; the caller also measures the full chain. */
function inlineToolFields(selection: ReturnType<typeof selectPayloadFields>, source: ContextSnapshot,
  original: NonNullable<CompiledChatGptWebPrompt["bootstrapContent"]>): typeof selection {
  const prepared = { ...selection.prepared, payload: structuredClone(selection.prepared.payload) };
  const positions: ExternalPosition[] = [], reasons = { ...selection.reasons };
  for (const position of selection.positions) {
    const target = source.getTarget(position.target_id)!;
    if (target.kind !== "tool_arguments" && target.kind !== "tool_result") { positions.push(position); continue; }
    let owner: any = prepared.payload, originalOwner: any = original.payload;
    for (const key of position.path.slice(0, -1)) { owner = owner[key]; originalOwner = originalOwner[key]; }
    const key = position.path.at(-1)!;
    const value = originalOwner[key];
    if (!cheaperRepresentation({ value, positions: [] }, { value: null, positions: [position] })) {
      positions.push(position); continue;
    }
    owner[key] = structuredClone(value);
    reasons[`${target.source_kind}:optional_exact_field`]!--;
    const reason = `${target.source_kind}:inline_tool_field`;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  if (positions.length === selection.positions.length || !cheaperRepresentation(
    { payload: prepared.payload, external_positions: positions },
    { payload: selection.prepared.payload, external_positions: selection.positions })) return selection;
  return { prepared, positions, reasons };
}

function cheaperRepresentation(candidate: unknown, baseline: unknown): boolean {
  const next = deterministicContextJson(candidate), previous = deterministicContextJson(baseline);
  const bytes = Buffer.byteLength(next), oldBytes = Buffer.byteLength(previous);
  const tokens = estimateTokens(next), oldTokens = estimateTokens(previous);
  return bytes <= oldBytes && tokens <= oldTokens && (bytes < oldBytes || tokens < oldTokens);
}

/** Optimizes only the already selected send candidate. It never changes source or send policy. */
export function planContextDelivery(input: ContextDeliveryPlanInput): ContextDeliveryPlan {
  return withTokenEstimateCache(() => planDelivery(input));
}

function planDelivery(input: ContextDeliveryPlanInput): ContextDeliveryPlan {
  if (input.messageIndices && input.messageIndices.length !== input.candidate.context.messages.length) {
    throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "The candidate index map has the wrong number of messages");
  }
  const candidate = input.candidate;
  const restored = restoreCompactionTaskMessages(candidate, extractChatGptTurnIdentity(candidate), chatGptTurnUserRevisionHistory(candidate));
  if (restored !== candidate.context.messages) {
    input = { ...input, candidate: { ...candidate, context: { ...candidate.context, messages: restored } },
      messageIndices: restored.map(message => {
        const index = candidate.context.messages.indexOf(message);
        return index < 0 ? null : input.messageIndices?.[index] ?? (input.messageIndices ? null : input.canonical.context.messages.indexOf(message));
      }) };
  }
  const started = performance.now();
  const budgetProfile = input.budgetProfile ?? "expanded";
  const limits = contextLimits({ ...contextBudgetProfileLimits(budgetProfile), ...input.limits });
  const reuseAvailable = input.contextReuseAvailable === true;
  // The candidate above already contains its authenticated task restoration. A media
  // projection clones these messages; compile that view without inserting the task again.
  const compile = (parsed: CodexParsedRequest, options = input.compileOptions) => compileChatGptWebPrompt(parsed, input.capabilities,
    input.turnToken, { ...options, contextTaskRestoration: false });
  if (input.compileOptions?.contextNavigation) throw new Error("The context planner owns its navigation entry");
  let original: CompiledChatGptWebPrompt;
  let originalCompileFailure: unknown;
  try { original = compile(input.candidate); }
  catch (error) {
    if ((error as { code?: string }).code !== "context_length_exceeded"
      || !input.contextToolsAvailable || !input.capabilities.localToolsEnabled || input.candidate._compactionRequest) throw error;
    // The complete preparation is a comparison baseline, never an admitted Send.
    original = compile(input.candidate, { ...input.compileOptions, bootstrapPreparation: true });
    originalCompileFailure = error;
  }
  const originalBytes = promptBytes(original);
  const mode = input.compileOptions?.manualControl
    ? { localTools: true, effort: "low" as const }
    : resolveChatGptWebModelMode(input.candidate.modelId, input.candidate.options.reasoning, input.capabilities);
  const composerLimited = input.capabilities.localToolsEnabled && mode.localTools && !input.candidate._compactionRequest;
  const maxComposer = input.capabilities.maxComposerCodePoints ?? CONTEXT_MAX_COMPOSER_CODE_POINTS;
  if (!Number.isSafeInteger(maxComposer) || maxComposer < 1) throw new Error("Invalid maximum composer code point configuration");
  const fitsComposer = (compiled: CompiledChatGptWebPrompt): boolean => !composerLimited
    || Array.from(compiled.text).length <= maxComposer;
  const contextWindow = input.budget?.contextWindowTokens ?? resolveChatGptWebContextLimits(input.candidate.modelId as Parameters<typeof resolveChatGptWebContextLimits>[0],
    input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities, input.candidate._chatgptModelFamily).contextWindow;
  const retained = input.budget?.retainedTokens ?? 0;
  const work = input.budget?.workReserveTokens ?? CONTEXT_WORK_RESERVE_TOKENS;
  for (const [key, value] of Object.entries({ contextWindow, retained, work })) {
    if (!Number.isSafeInteger(value) || value < 0 || key === "contextWindow" && value === 0) throw new Error(`Invalid context planning budget: ${key}`);
  }
  const errorReserve = contextErrorReserve(limits);
  const baseCosts = (compiled: CompiledChatGptWebPrompt, media?: ContextMediaPlan, navigationPromptBytes = 0,
    discovery?: ContextResponseCost): ContextDeliveryCosts => {
    const tokens = promptTokens(compiled);
    const discoveryTokens = media ? discovery!.total_tokens : 0;
    const discoveryWire = media ? discovery!.wire_bytes : 0;
    const errorTokens = media ? errorReserve.tokens : 0;
    const errorWire = media ? errorReserve.wire_bytes : 0;
    const requiredMcp = media?.requiredMcpTokens ?? 0;
    const attachmentVision = media?.attachmentVisualTokens ?? compiled.images.reduce((sum, image) => sum + chatGptWebImageTokenReserve(image.detail), 0);
    return { originalPromptTransport: originalCompileFailure ? "ordinary_capacity_baseline" : "candidate", originalPromptBytes: originalBytes,
      promptBytes: promptBytes(compiled), netSavedPromptBytes: originalBytes - promptBytes(compiled), promptTokens: tokens,
      originalContextFormat: original.contextFormat ?? "legacy-json", contextFormat: compiled.contextFormat ?? "legacy-json",
      originalPromptJsonBytes: promptJsonBytes(original), promptJsonBytes: promptJsonBytes(compiled),
      promptCharacters: compiled.text.length,
      originalPromptCodePoints: Array.from(original.text).length,
      promptCodePoints: Array.from(compiled.text).length,
      maxComposerMessageCodePoints: Array.from(compiled.text).length,
      navigationPromptBytes, requiredMcpWireBytes: Object.entries(media?.imageResponseCosts ?? {}).filter(([id]) => media?.deliveryByTarget[id]?.required).reduce((sum, [, cost]) => sum + cost.wire_bytes, 0),
      requiredMcpTokens: requiredMcp, attachmentBytes: media?.attachmentBytes ?? 0, attachmentVisualTokens: attachmentVision,
      retainedTokens: retained, workReserveTokens: work, platformReserveTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
      discoveryReserveTokens: discoveryTokens, discoveryReserveWireBytes: discoveryWire, errorReserveTokens: errorTokens, errorReserveWireBytes: errorWire,
      requiredNavigationWireBytes: Object.values(media?.requiredImageWireReserves ?? {}).reduce((sum, value) => sum + value, 0) + discoveryWire + errorWire,
      requiredTotalTokens: tokens + retained + work + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + requiredMcp + attachmentVision + discoveryTokens + errorTokens,
      contextWindowTokens: contextWindow, remainingNavigationTokens: UNLIMITED_CONTEXT_ALLOWANCE };
  };
  const assertCandidateCapacity = (compiled: CompiledChatGptWebPrompt, costs: ContextDeliveryCosts): void => {
    if (!fitsComposer(compiled)) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED",
      input.contextBootstrapAvailable === false
        ? "The complete prompt exceeds the composer code point budget and the current connector does not support context-bootstrap-v1"
        : "A complete composer message exceeds the configured Unicode code point budget", { max_composer_code_points: maxComposer, costs });
    const transportLimits = resolveChatGptWebTransportLimits(input.candidate.modelId as Parameters<typeof resolveChatGptWebTransportLimits>[0],
      input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities);
    const tokenBudget = resolveChatGptWebMessageTokenBudget(input.candidate.modelId as Parameters<typeof resolveChatGptWebMessageTokenBudget>[0],
      input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities,
      costs.attachmentVisualTokens + skillFileTokens(compiled.skillFiles));
    if (compiled.text.length > (transportLimits.browserComposerCharLimit ?? Infinity)
      || estimateTokens(compiled.text) > tokenBudget) throw new ContextDeliveryPlanningError(
      "CONTEXT_BUDGET_EXCEEDED", "The selected prompt exceeds its single browser message budget", { costs });
  };
  const fast = (): ContextDeliveryPlan => {
    if (originalCompileFailure) throw originalCompileFailure;
    const costs = baseCosts(original);
    assertCandidateCapacity(original, costs);
    return { snapshot: input.snapshot, compiled: original, projected: input.candidate, navigationEnabled: false, externalizedTargetIds: [],
      bodyDigest: hash(original.text), costs, limits };
  };
  if (!input.capabilities.localToolsEnabled || !mode.localTools || input.candidate._compactionRequest) return fast();
  const messages = mapping(input);
  if (input.rawInputIndices && (new Set(input.rawInputIndices).size !== input.rawInputIndices.length
    || input.rawInputIndices.some(index => !Number.isSafeInteger(index) || index < 0
      || !Array.isArray((input.canonical._rawBody as { input?: unknown } | undefined)?.input)
      || index >= ((input.canonical._rawBody as { input: unknown[] }).input.length)))) {
    throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "The selected canonical raw index map is invalid");
  }
  const selected = new Set<string>();
  const imageParts = new Map<string, CodexImageContent>();
  for (const target of input.snapshot.targets) {
    const field = selectedField(input, target, messages);
    if (field === undefined) continue;
    if (target.locator.system_index !== undefined && target.locator.raw_input_index === undefined && field !== input.canonical.context.systemPrompt?.[target.locator.system_index]) {
      throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "System prompt source mapping changed", { target_id: target.target_id });
    }
    selected.add(target.target_id);
    if (target.kind === "image") imageParts.set(target.target_id, field as CodexImageContent);
    if ((target.kind === "tool_result" || target.kind === "message_text") && target.read_ref && typeof field === "string"
      && input.snapshot.getText(target.read_ref) !== field) {
      throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "Snapshot text does not match the selected canonical field", { target_id: target.target_id });
    }
  }
  for (const [index, message] of input.candidate.context.messages.entries()) {
    if (!Array.isArray(message.content)) continue;
    for (const [partIndex, part] of message.content.entries()) if (part.type === "image"
      && !Array.from(imageParts.values()).includes(part)) {
      throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "Candidate image is absent from the canonical snapshot", { candidate_index: index, content_index: partIndex });
    }
  }
  const omittedHistory = input.snapshot.targets.some(target => !selected.has(target.target_id) && target.read_ref);
  if (!input.contextToolsAvailable) {
    if (omittedHistory) throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN",
      "The candidate requires omitted history that the current connector cannot expose. Refresh its context tool schema or prepare a complete candidate before Send");
    return fast();
  }
  if (!input.turnToken) throw new Error("Context navigation requires the current credential");
  const bootstrapCandidate = (): ContextDeliveryPlan => {
    // A fixed input snapshot and preparation produce fixed planning identities.
    // Physical-send owners fork the input snapshot for each new preparation.
    const identity = hash(deterministicContextJson({ context_id: input.snapshot.context_id, candidate: input.candidate,
      messageIndices: input.messageIndices, rawInputIndices: input.rawInputIndices,
      compileOptions: input.compileOptions, capabilities: input.capabilities, limits, budgetProfile,
      reuseAvailable, reuseBaseline: input.reuseBaseline, budget: input.budget }));
    let source: ContextSnapshot;
    try { source = appendFixedContextRecords(input.snapshot, [], { contextId: `context_${identity.slice(0, 32)}`,
      maxStorageBytes: limits.maxStorageBytes }); }
    catch (error) {
      throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The selected sources exceed the fixed-source storage budget",
        { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
    }
    // Optional sources must remain discoverable in one bounded entry page. This
    // validates access; it does not require traversal or prepay optional reads.
    const directory = new ContextNavigator({ scopeId: "context-directory-preflight", snapshot: source, purpose: "normal", limits });
    for (const index of source.targets.keys()) {
      if (performance.now() - started > limits.totalProcessingMs) throw new ContextDeliveryPlanningError(
        "CONTEXT_BUDGET_EXCEEDED", "Context directory admission exceeded its bounded processing deadline");
      const reply = directory.preflightListEntry(index);
      const cost = measureContextResponse(reply, { wireReserveBytes: limits.wireReserveBytes,
        tokenReserve: limits.tokenReserve, boundCursorTokens: true });
      if (reply.isError || cost.text_tokens > limits.listTokens || cost.wire_bytes > limits.listBytes) throw new ContextDeliveryPlanningError(
        "CONTEXT_BUDGET_EXCEEDED", "A context source cannot be discovered within a bounded directory page");
    }
    const sourceInput = { ...input, snapshot: source };
    const planId = `plan_${identity.slice(32)}`;
    const ordinaryOptions = input.compileOptions ?? {};
    const media = planContextMedia({ snapshot: source, selectedTargetIds: selected, selectedImageParts: imageParts, limits,
      attachmentSlotsReserved: original.skillFiles?.length ?? 0,
      attachmentBytesReserved: (original.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) });
    {
      const projected = projection(sourceInput, messages, media);
      const contextSystemImages = source.targets.filter(t => t.kind === "image" && t.source_kind === "system"
        && selected.has(t.target_id) && media.deliveryByTarget[t.target_id]?.media_route === "attachment")
        .map(t => ({ ...imageParts.get(t.target_id)!, imageUrl: media.attachmentUrls.get(t.target_id)! }));
      const prepared = compile(projected, { ...ordinaryOptions, bootstrapPreparation: true,
        ...(contextSystemImages.length ? { contextSystemImages } : {}), contextNavigation: {
          plan: { planId, contextId: source.context_id, manifestDigest: "0".repeat(64), requiredAttachments: media.requiredAttachments },
          overview: { sources: source.sources.length, targets: source.targets.length, source_cutoff: source.sources.length,
            externalized_targets: 0, images: source.targets.filter(t => t.kind === "image").length, recent_tools: [] },
          requiredImages: media.requiredImages,
          requiredMcpImages: Object.values(media.deliveryByTarget).filter(route => route.required && route.media_route === "mcp").length,
        } });
      if (!prepared.bootstrapContent) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "This ordinary task cannot prepare an exact short bootstrap source");
      const provisionalDescriptor = { planId, contextId: source.context_id, manifestDigest: "0".repeat(64), requiredAttachments: media.requiredAttachments };
      const credential = input.compileOptions?.manualControl ? { request_id: input.turnToken! } : { turn_token: input.turnToken! };
      const entryInput = { appName: resolveLocalCodexAppName(ordinaryOptions.appName, ordinaryOptions.manualControl === true),
        credential, taskUpdateInitialState: input.compileOptions?.taskUpdateProtocol === 1
        ? input.compileOptions.taskUpdateInitialState ?? { acceptedRevision: 0, acknowledgedRevision: 0 } : undefined,
        requiredMcpImages: Object.values(media.deliveryByTarget).filter(route => route.required && route.media_route === "mcp").length };
      let inlineRequest: ContextBootstrapInlineRequest | undefined;
      const canonicalRequest = contextBootstrapRequestMessageIndices(input.canonical);
      if (!reuseAvailable && canonicalRequest?.length) {
        const candidateIndices = canonicalRequest.map(index => messages.get(index));
        const preparedIndices = candidateIndices.map(index => index === undefined ? -1 : prepared.bootstrapContent!.messageSourceIndices.indexOf(index));
        if (preparedIndices.every(index => index >= 0)) {
          const request = { message_indices: preparedIndices,
            messages: preparedIndices.map(index => prepared.bootstrapContent!.payload.messages[index]!) };
          const withRequest = shortContextBootstrapPrompt({ ...entryInput, plan: provisionalDescriptor, inlineRequest: request });
          if (Array.from(withRequest.text).length <= maxComposer) inlineRequest = request;
        }
      }
      const selection = selectPayloadFields(input, source, prepared.bootstrapContent, messages, selected);
      const fixedRecordOptions = { contextId: source.context_id, maxStorageBytes: limits.maxStorageBytes,
        referenceNamespace: source.context_id };
      const materialize = (selection: ReturnType<typeof selectPayloadFields>): ContextDeliveryPlan => {
        const externalized = new Set(selection.positions.map(position => position.target_id));
        const inlineCanonicalMessages = new Set(inlineRequest ? canonicalRequest : []);
        const textDelivery = (target: ContextTarget): ContextDelivery => ({ required: false,
          delivery: inlineCanonicalMessages.has(target.locator.message_index!) ? "inline"
            : selected.has(target.target_id) && !externalized.has(target.target_id) ? "source_required_record" : "source_on_demand" });
        const selectedSources = new Set(source.targets.filter(target => selected.has(target.target_id)).map(target => target.source_id));
        const candidateSources = new Map([...messages].map(([canonicalIndex, candidateIndex]) => [candidateIndex, canonicalIndex]));
        const sourceMap = {
          candidate_message_sources: input.candidate.context.messages.map((_, index) => candidateSources.get(index) ?? null),
          prepared_message_sources: selection.prepared.messageSourceIndices,
          sources: source.sources.filter(item => selectedSources.has(item.source_id)),
          targets: source.targets.filter(target => selected.has(target.target_id)).map(target => {
            const { label: _label, label_source: _labelSource, ...metadata } = target;
            return { ...metadata, ...(target.kind !== "image" ? textDelivery(target) : media.deliveryByTarget[target.target_id]) };
          }),
        };
        let mappedSource: ContextSnapshot;
        try {
          mappedSource = appendFixedContextRecords(source, [{ text: deterministicContextJson(sourceMap),
            encoding: "deterministic-json", origin: "context_source_map" }],
            fixedRecordOptions);
        } catch (error) {
          throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The source map exceeds the fixed-source storage budget",
            { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
        }
        const mapTarget = mappedSource.targets.at(-1)!;
        const sourceMapRef = { context_id: source.context_id, target_id: mapTarget.target_id, read_ref: mapTarget.read_ref,
          encoding: mapTarget.encoding, content_digest: mapTarget.content_digest, utf8_bytes: mapTarget.utf8_bytes };
        const decorate = (value: Record<string, unknown>) => ({ ...value,
          external_positions: selection.positions, source_map: sourceMapRef });
        let payload: unknown;
        let reuse: ContextReusePlan | undefined;
        let reusePrepared: ReturnType<typeof prepareContextReuse> | undefined;
        let inlineReusePayload: unknown;
        if (reuseAvailable) {
          try {
            reusePrepared = prepareContextReuse({ canonical: input.canonical, candidate: input.candidate,
              prepared: selection.prepared, snapshot: mappedSource, planId, baseline: input.reuseBaseline,
              maxStorageBytes: limits.maxStorageBytes, referenceNamespace: fixedRecordOptions.referenceNamespace });
          } catch (error) {
            throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The exact context units exceed the fixed-source storage budget",
              { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
          }
          if (reusePrepared) {
            const inlinePayload = decorate(reusePrepared.makePayload(true, sourceMapRef));
            const trialEntry = shortContextReuseBootstrapPrompt({ ...entryInput, plan: provisionalDescriptor,
              reuse: reusePrepared.makePlan(true), inlinePayload });
            const singleLimits = resolveChatGptWebTransportLimits(input.candidate.modelId as Parameters<typeof resolveChatGptWebTransportLimits>[0],
              input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities);
            const singleTokens = resolveChatGptWebMessageTokenBudget(input.candidate.modelId as Parameters<typeof resolveChatGptWebMessageTokenBudget>[0],
              input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities,
              media.attachmentVisualTokens + skillFileTokens(prepared.skillFiles));
            const useInline = Array.from(trialEntry.text).length <= maxComposer
              && trialEntry.text.length <= (singleLimits.browserComposerCharLimit ?? Infinity)
              && estimateTokens(trialEntry.text) <= singleTokens;
            reuse = reusePrepared.makePlan(useInline);
            payload = useInline ? inlinePayload : decorate(reusePrepared.makePayload(false, sourceMapRef));
            if (useInline) inlineReusePayload = payload;
          }
        }
        if (!reuse) {
          // All control positions are external. A user value with the same keys is inert.
          payload = decorate({ format: "context-bootstrap-payload-v3",
            inline_request_positions: (inlineRequest?.message_indices ?? []).map((index, inline_index) => ({
              path: ["messages", index], inline_index })),
            payload: { ...selection.prepared.payload, messages: selection.prepared.payload.messages.map((message, index) =>
              inlineRequest?.message_indices.includes(index) ? null : message) } });
        }
        let snapshot: ContextSnapshot;
        try {
          snapshot = appendFixedContextRecords(reusePrepared?.snapshot ?? mappedSource, [
            ...(!reuse ? [{ text: selection.prepared.protocol, encoding: "utf-8" as const, origin: "context_bootstrap_protocol" as const }] : []),
            { text: deterministicContextJson(payload), encoding: "deterministic-json", origin: "context_bootstrap_payload" },
          ], fixedRecordOptions);
        } catch (error) {
          throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The exact required sources exceed the fixed-source storage budget",
            { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
        }
        const added = new Set(snapshot.targets.slice(mappedSource.targets.length).map(t => t.target_id));
        const deliveryByTarget: Record<string, ContextDelivery> = { ...media.deliveryByTarget };
        for (const target of snapshot.targets) if (target.kind !== "image") deliveryByTarget[target.target_id] = added.has(target.target_id)
          ? { delivery: "source_required", required: true }
          : textDelivery(target);
        if (reuse) {
          for (const target of snapshot.targets) if (target.kind !== "image" && selected.has(target.target_id)) {
            deliveryByTarget[target.target_id] = { delivery: "source_on_demand", required: false };
          }
          for (const unit of reuse.units) deliveryByTarget[unit.target_id] = {
            delivery: unit.delivery === "required" ? "source_required" : unit.delivery === "reuse" ? "source_reused" : "inline",
            required: unit.delivery === "required",
          };
          const aggregate = snapshot.targets.at(-1)!;
          deliveryByTarget[aggregate.target_id] = { delivery: inlineReusePayload ? "inline" : "source_required", required: !inlineReusePayload };
        }
        deliveryByTarget[mapTarget.target_id] = { delivery: "source_on_demand", required: false, reason: "Detailed source mapping is optional" };
        const manifestBasis = { context_id: snapshot.context_id, plan_id: planId, budget_profile: budgetProfile, limits,
          context_protocol: CONTEXT_PROTOCOL_VERSION, manifest_version: 3, read_arguments: "reads-array", text_read_format: "context-text-batch-v1",
          targets: snapshot.targets.map(target => ({ ...target, ...deliveryByTarget[target.target_id] })) };
        let manifestDigest = hash(deterministicContextJson(manifestBasis));
        let required = measureBootstrapRequiredCosts({ snapshot, planId, manifestDigest, limits, deliveryByTarget,
          started, ...(reuse ? { reuse } : {}) });
        manifestDigest = hash(deterministicContextJson({ ...manifestBasis,
          batches: required.batches.map(({ reads, ranges }) => ({ reads, ranges })) }));
        // Final control wrappers include the manifest digest. Measure that exact
        // version before the candidate can be selected or sent.
        required = measureBootstrapRequiredCosts({ snapshot, planId, manifestDigest, limits, deliveryByTarget,
          started, ...(reuse ? { reuse } : {}) });
        const descriptor = { planId, contextId: snapshot.context_id, manifestDigest, requiredAttachments: media.requiredAttachments };
        const entry = reuse ? shortContextReuseBootstrapPrompt({ ...entryInput, plan: descriptor, reuse,
          ...(inlineReusePayload ? { inlinePayload: inlineReusePayload } : {}) })
          : shortContextBootstrapPrompt({ ...entryInput, plan: descriptor, ...(inlineRequest ? { inlineRequest } : {}) });
        if (entry.fixedCodePoints > CONTEXT_MAX_FIXED_BOOTSTRAP_CODE_POINTS) throw new ContextDeliveryPlanningError(
          "CONTEXT_BUDGET_EXCEEDED", "The fixed bootstrap exceeds its 3000 Unicode code point engineering limit",
          { limit: "fixed_bootstrap", fixed_code_points: entry.fixedCodePoints });
        let diagnostics: CompiledChatGptWebPrompt["contextTokenBreakdown"];
        if (ordinaryOptions.includeContextTokenBreakdown) {
          let delivered = selection.prepared.payload;
          if (reuse && reusePrepared) {
            // Reused rule bodies remain on the page. Count only current records delivered again.
            const current = reusePrepared.makePayload(false, sourceMapRef);
            delivered = structuredClone(current.payload);
            for (const position of current.positions) {
              const reference = current.references.find(reference => reference.unit_id === position.unit_id)!;
              if (reference.delivery === "current") {
                delivered[position.path[0]][position.path[1]] = JSON.parse(snapshot.getText(reference.read_ref!)!) as never;
              }
            }
          }
          diagnostics = contextTokenBreakdown(delivered.system.filter(content => content !== null),
            delivered.messages.filter(message => message !== null));
        }
        const compiled: CompiledChatGptWebPrompt = { ...prepared, text: entry.text, contextPlan: descriptor,
          ...(diagnostics ? { contextTokenBreakdown: diagnostics } : {}) };
        for (const [id, cost] of Object.entries(media.imageResponseCosts)) if (deliveryByTarget[id]?.required) {
          required.retry.tokens = Math.max(required.retry.tokens, cost.total_tokens);
          required.retry.wire_bytes = Math.max(required.retry.wire_bytes, cost.wire_bytes);
        }
        const costs = baseCosts(compiled, media, promptBytes(compiled), required.discovery);
        costs.fixedBootstrapCodePoints = entry.fixedCodePoints;
        costs.selection = { byCategory: Object.fromEntries([...new Set(source.targets.map(target => target.source_kind))].map(kind =>
            [kind, source.targets.filter(target => target.source_kind === kind).length])), reasons: selection.reasons,
          requiredBodyBytes: snapshot.targets.filter(target => target.kind !== "image" && deliveryByTarget[target.target_id]?.required)
            .reduce((sum, target) => sum + (target.utf8_bytes ?? 0), 0),
          sourceMapBytes: mapTarget.utf8_bytes!, requiredBatches: required.batches.length,
          toolFields: source.targets.filter(target => target.kind === "tool_arguments" || target.kind === "tool_result").length,
          inlinedToolFields: (selection.reasons["assistant:inline_tool_field"] ?? 0) + (selection.reasons["tool:inline_tool_field"] ?? 0),
          externalPositions: selection.positions.length, externalPositionBytes: Buffer.byteLength(deterministicContextJson(selection.positions)),
          messageSkeletonBytes: Buffer.byteLength(deterministicContextJson(selection.prepared.payload.messages)) };
        costs.requiredTextTokens = required.text.total_tokens; costs.requiredTextWireBytes = required.text.wire_bytes;
        costs.requiredRetryTokens = required.retry.tokens; costs.requiredRetryWireBytes = required.retry.wire_bytes;
        costs.requiredMcpTokens += required.text.total_tokens;
        costs.requiredMcpWireBytes += required.text.wire_bytes;
        costs.requiredTotalTokens += required.text.total_tokens + required.retry.tokens;
        costs.requiredNavigationWireBytes += required.text.wire_bytes + required.retry.wire_bytes;
        if (reusePrepared && reuse) costs.reuse = { ...reusePrepared.diagnostics, mode: reuse.mode,
          requiredBodyBytes: snapshot.targets.filter(target => target.kind !== "image" && deliveryByTarget[target.target_id]?.required)
            .reduce((sum, target) => sum + (target.utf8_bytes ?? 0), 0),
          sourceMapBytes: Buffer.byteLength(deterministicContextJson(sourceMap)), inlineUtf16: compiled.text.length,
          inlineUtf8Bytes: Buffer.byteLength(compiled.text), inlineSerializedBytes: Buffer.byteLength(JSON.stringify(compiled.text)),
          directoryBytes: Buffer.byteLength(deterministicContextJson(snapshot.targets)) };
        assertCandidateCapacity(compiled, costs);
        if (compiled.images.length !== media.attachmentCount || compiled.images.length + (compiled.skillFiles?.length ?? 0) > 10) {
          throw new ContextDeliveryPlanningError("CONTEXT_IMAGE_UNAVAILABLE", "The short bootstrap does not preserve its selected image attachment routes");
        }
        const registration: ContextPlanRegistration = { snapshot, planId, manifestDigest, startupProtocol: "context-bootstrap-v1", deliveryByTarget, limits, budgetProfile,
          ...(reuse ? { reuse } : {}),
          remainingBudget: { tokens: costs.remainingNavigationTokens, reserved_tokens: work, wire_bytes: UNLIMITED_CONTEXT_ALLOWANCE, reserved_wire_bytes: 0 },
          requiredImageTokenReserves: media.requiredImageTokenReserves, requiredImageWireReserves: media.requiredImageWireReserves,
          requiredTextBatches: required.batches, requiredControlReserve: required.control, requiredReturnRetryReserve: required.retry };
        return { snapshot, compiled, projected, navigationEnabled: true, externalizedTargetIds: [...externalized, ...added],
          registration, planId, manifestDigest, bodyDigest: hash(compiled.text), costs, limits };
      };
      const baseline = materialize(selection);
      if (input.inlineToolFields === false) return baseline;
      const inlined = inlineToolFields(selection, source, prepared.bootstrapContent);
      if (performance.now() - started > limits.totalProcessingMs) throw new ContextDeliveryPlanningError(
        "CONTEXT_BUDGET_EXCEEDED", "Tool-field selection exceeded its bounded processing deadline");
      if (inlined === selection) return baseline;
      try {
        const trial = materialize(inlined);
        const payloadOf = (plan: ContextDeliveryPlan): unknown => JSON.parse(plan.snapshot.getText(
          plan.snapshot.targets.find(target => target.origin === "context_bootstrap_payload")!.read_ref!)!);
        if (cheaperRepresentation(payloadOf(trial), payloadOf(baseline))
          && trial.costs.selection!.requiredBatches <= baseline.costs.selection!.requiredBatches
          && trial.costs.requiredTextWireBytes! <= baseline.costs.requiredTextWireBytes!
          && trial.costs.requiredTextTokens! <= baseline.costs.requiredTextTokens!) return trial;
      } catch (error) {
        // An optional representation must not invalidate an already verified plan.
        // Exhausting the shared deadline is a task failure, not a representation choice.
        if (!(error instanceof ContextDeliveryPlanningError) || performance.now() - started > limits.totalProcessingMs) throw error;
      }
      return baseline;
    }
  };
  let inline: ContextDeliveryPlan | undefined;
  let inlineFailure: unknown;
  try {
    // A selected image or omitted source needs a current directory and delivery evidence.
    if (!omittedHistory && imageParts.size === 0) inline = fast();
  } catch (error) {
    if (!(error instanceof ContextDeliveryPlanningError) && (error as { code?: string }).code !== "context_length_exceeded") throw error;
    inlineFailure = error;
  }
  if (input.contextBootstrapAvailable !== false && !input.compileOptions?.captureLunaCheckpoint) {
    try {
      const trial = bootstrapCandidate();
      if (!inline || trial.costs.requiredTotalTokens < inline.costs.requiredTotalTokens) return trial;
    } catch (error) {
      if (!(error instanceof ContextDeliveryPlanningError) && (error as { code?: string }).code !== "context_length_exceeded") throw error;
      if (!inline || performance.now() - started > limits.totalProcessingMs) throw error;
    }
  }
  if (inline) return inline;
  if (inlineFailure) throw inlineFailure;
  throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "The current connector cannot deliver the selected context sources");
}
