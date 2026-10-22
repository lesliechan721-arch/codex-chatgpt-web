import { createHash, randomBytes } from "node:crypto";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, resolveChatGptWebContextLimits, resolveChatGptWebMessageTokenBudget, resolveChatGptWebTransportLimits } from "../../chatgpt-web-models";
import { estimateTokens, withTokenEstimateCache } from "../../lib/token-estimate";
import type { CodexImageContent, CodexMessage, CodexParsedRequest } from "../../types";
import { contextErrorReserve, contextLimits, contextBudgetProfileLimits, measureContextResponse, type ContextBudgetProfile, type ContextLimitOverrides, type ContextLimits, type ContextResponseCost } from "./context-budget";
import { ContextDeliveryPlanningError, planContextMedia, type ContextMediaPlan } from "./context-media-plan";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt, type CompileChatGptWebPromptOptions } from "./prompt";
import type { ContextPlanRegistration } from "./context-runtime";
import { appendFixedContextRecords, deterministicContextJson, type ContextSnapshot } from "./context-snapshot";
import type { ContextDelivery, ContextTarget } from "./context-types";
import { skillFileTokens } from "./skill-attachments";
import { ContextNavigator } from "./context-navigator";
import { estimateWebContextFieldCost, type WebContextFormat } from "./context-renderer";
import { shortContextBootstrapPrompt, shortContextReuseBootstrapPrompt } from "./context-prompt";
import { prepareContextReuse } from "./context-reuse-plan";
import type { ContextReuseBaseline, ContextReusePlan } from "./context-reuse-types";
import { measureBootstrapRequiredCosts } from "./context-bootstrap-plan";
import { contextBootstrapRequestMessageIndices } from "./context-bootstrap-request";
import type { ContextBootstrapInlineRequest } from "./context-prompt";
import { resolveLocalCodexAppName } from "./execution-protocol";

/** A field must save this many estimated encoded bytes in its current presentation before full compilation. */
export const CONTEXT_MIN_EXTERNALIZE_BYTES = 1_024;
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
  /** Trusted provider setting for the page budget, independent of message splitting. */
  experimentalBiggerContext?: boolean;
  turnToken?: string;
  compileOptions?: CompileChatGptWebPromptOptions;
  /** True only after the new context-tool ABI is verified. */
  contextToolsAvailable: boolean;
  /** Current owner and connector support, independent of historical diagnostics. */
  contextBootstrapAvailable?: boolean;
  /** Current end-to-end reuse capability, independent of bootstrap availability. */
  contextReuseAvailable?: boolean;
  /** Supplied only by the healthy retained-page lifecycle gate. */
  reuseBaseline?: ContextReuseBaseline;
  limits?: ContextLimitOverrides;
  budgetProfile?: ContextBudgetProfile;
  budget?: { contextWindowTokens?: number; retainedTokens?: number; workReserveTokens?: number };
}

export interface ContextDeliveryCosts {
  /** Ordinary serialization is a conservative byte baseline when the original multipart cannot compile. */
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
  /** Fixed replies retained before the final multipart commit; already included in promptTokens. */
  acknowledgementTokens: number;
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

function transportTexts(compiled: CompiledChatGptWebPrompt): string[] {
  if (!compiled.multipart) return [compiled.text];
  const transactionId = `ctx_${"0".repeat(32)}`;
  return [...compiled.multipart.parts.slice(0, -1).map((payload, index) =>
    formatChatGptWebMultipartStage(payload, transactionId, index + 1, compiled.multipart!.parts.length).text),
  formatChatGptWebMultipartCommit(compiled.multipart, transactionId)];
}
function promptBytes(compiled: CompiledChatGptWebPrompt): number {
  return transportTexts(compiled).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0)
    + (compiled.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text, "utf8"), 0);
}
function promptTokens(compiled: CompiledChatGptWebPrompt): number {
  return transportTexts(compiled).reduce((sum, text) => sum + estimateTokens(text), 0)
    + skillFileTokens(compiled.skillFiles) + acknowledgementTokens(compiled);
}
function acknowledgementTokens(compiled: CompiledChatGptWebPrompt): number {
  if (!compiled.multipart) return 0;
  const transactionId = `ctx_${"0".repeat(32)}`;
  return compiled.multipart.parts.slice(0, -1).reduce((sum, payload, index) => sum + estimateTokens(
    formatChatGptWebMultipartStage(payload, transactionId, index + 1, compiled.multipart!.parts.length).acknowledgement), 0);
}
function promptJsonBytes(compiled: CompiledChatGptWebPrompt): number {
  return transportTexts(compiled).reduce((sum, text) => sum + Buffer.byteLength(JSON.stringify(text), "utf8"), 0);
}
function discoveryResponseCost(snapshot: ContextSnapshot, limits: ContextLimits, requiredImages: number,
  deliveryByTarget?: Readonly<Record<string, ContextDelivery>>, started = performance.now()): ContextResponseCost {
  const checkDeadline = (): void => {
    if (performance.now() - started > limits.totalProcessingMs) {
      throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "Context directory admission exceeded its bounded processing deadline");
    }
  };
  // These instances measure complete discovery returns. Actual admission below uses
  // the selected local caps; measurement must not turn a too-small total into an
  // error reply whose smaller cost could be mistaken for the directory's cost.
  const measurementLimits = { ...limits, maxTotalTokens: Number.MAX_SAFE_INTEGER, maxTotalWireBytes: Number.MAX_SAFE_INTEGER };
  const costs = [0, requiredImages].map(deliveredImages => {
    const nav = new ContextNavigator({ scopeId: "context-discovery-preflight", snapshot, purpose: "normal", limits: measurementLimits, deliveryByTarget });
    const response = nav.list({ context_id: snapshot.context_id, view: "overview" }, {
      context_ready: deliveredImages === requiredImages, required_images: requiredImages, delivered_images: deliveredImages,
      text_ready: true, images_ready: deliveredImages === requiredImages,
      required_texts: 0, delivered_texts: 0, required_text_bytes: 0, delivered_text_bytes: 0,
    });
    checkDeadline();
    if (response.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The context budget cannot carry its directory overview and bounded error reserve");
    return measureContextResponse(response, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve });
  });
  const result = { wire_bytes: Math.max(...costs.map(cost => cost.wire_bytes)), text_tokens: Math.max(...costs.map(cost => cost.text_tokens)),
    visual_tokens: 0, total_tokens: Math.max(...costs.map(cost => cost.total_tokens)) };
  if (!deliveryByTarget) return result;
  const overviewCost = { ...result };
  const required = new Set(snapshot.targets.filter(target => target.kind === "image"
    && deliveryByTarget[target.target_id]?.required && deliveryByTarget[target.target_id]?.media_route === "mcp").map(target => target.target_id));
  const nav = new ContextNavigator({ scopeId: "context-directory-preflight", snapshot, purpose: "normal", limits: measurementLimits, deliveryByTarget });
  let cursor: string | undefined;
  do {
    checkDeadline();
    const response = nav.preflightList({ context_id: snapshot.context_id, view: "entries", ...(required.size ? { kind: "image" } : {}), ...(cursor ? { cursor } : {}) });
    checkDeadline();
    if (response.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The context budget cannot carry a useful directory entries page");
    const page = response.structuredContent as { entries: Array<{ target_id: string; read_ref: string | null }>; next_cursor: string | null };
    const cost = measureContextResponse(response, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve, boundCursorTokens: true });
    result.wire_bytes += cost.wire_bytes; result.text_tokens += cost.text_tokens; result.total_tokens += cost.total_tokens;
    for (const entry of page.entries) if (entry.read_ref) required.delete(entry.target_id);
    cursor = page.next_cursor ?? undefined;
    if (required.size && !cursor) throw new ContextDeliveryPlanningError("CONTEXT_IMAGE_UNAVAILABLE", "The directory cannot discover every required image reference");
  } while (required.size);
  // Test every minimal unfiltered page, including its continuation cursor. Reserve
  // only the largest useful page with the overview, not an all-source traversal.
  for (const index of snapshot.targets.keys()) {
    checkDeadline();
    const response = nav.preflightListEntry(index);
    checkDeadline();
    if (response.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A context source cannot be discovered within a bounded directory page");
    const cost = measureContextResponse(response, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve, boundCursorTokens: true });
    result.wire_bytes = Math.max(result.wire_bytes, overviewCost.wire_bytes + cost.wire_bytes);
    result.text_tokens = Math.max(result.text_tokens, overviewCost.text_tokens + cost.text_tokens);
    result.total_tokens = Math.max(result.total_tokens, overviewCost.total_tokens + cost.total_tokens);
  }
  checkDeadline();
  return result;
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
function replacement(snapshot: ContextSnapshot, target: ContextTarget): string | Record<string, unknown> {
  return target.kind === "tool_arguments" ? { codex_context_ref: { context_id: snapshot.context_id, read_ref: target.read_ref } } : contextRef(snapshot, target);
}
function projection(input: ContextDeliveryPlanInput, messages: ReadonlyMap<number, number>, media: ContextMediaPlan,
  externalized: ReadonlySet<string>): CodexParsedRequest {
  const projected = { ...input.candidate, context: { ...input.candidate.context,
    ...(input.candidate.context.systemPrompt ? { systemPrompt: [...input.candidate.context.systemPrompt] } : {}), messages: structuredClone(input.candidate.context.messages) } };
  const stringEdits = new Map<number, Array<{ start: number; end: number; text: string }>>();
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
    if (externalized.has(target.target_id)) {
      const value = replacement(input.snapshot, target);
      if (typeof message.content === "string") {
        const edits = stringEdits.get(candidateIndex) ?? [];
        edits.push({ start: target.locator.text_start ?? 0, end: target.locator.text_end_exclusive ?? message.content.length, text: String(value) });
        stringEdits.set(candidateIndex, edits);
      } else {
        const part = message.content[target.locator.content_index!];
        if (part?.type === "toolCall" && typeof value !== "string") part.arguments = value;
        else if (part?.type === "text" && typeof value === "string") part.text = value;
        else throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "An externalized target does not match its canonical field", { target_id: target.target_id });
      }
    }
    if (target.kind === "image" && Array.isArray(message.content)) {
      const part = message.content[target.locator.content_index!];
      if (part?.type !== "image") continue;
      const delivery = media.deliveryByTarget[target.target_id]!;
      if (delivery.media_route === "attachment") part.imageUrl = media.attachmentUrls.get(target.target_id)!;
      else message.content[target.locator.content_index!] = { type: "text", text: delivery.media_route === "mcp"
        ? contextRef(input.snapshot, target) : `[context image ${target.target_id} unavailable: ${delivery.reason}]` };
    }
  }
  for (const [index, edits] of stringEdits) {
    const message = projected.context.messages[index]!;
    let content = message.content as string;
    let upper = content.length;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      if (edit.end > upper || edit.start > edit.end) throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN", "Canonical tool text ranges overlap", { candidate_index: index });
      content = content.slice(0, edit.start) + edit.text + content.slice(edit.end); upper = edit.start;
    }
    message.content = content;
  }
  return projected;
}

/** Optimizes only the already selected send candidate. It never changes source or send policy. */
export function planContextDelivery(input: ContextDeliveryPlanInput): ContextDeliveryPlan {
  return withTokenEstimateCache(() => planDelivery(input));
}

function planDelivery(input: ContextDeliveryPlanInput): ContextDeliveryPlan {
  const started = performance.now();
  const budgetProfile = input.budgetProfile ?? "expanded";
  const limits = contextLimits({ ...contextBudgetProfileLimits(budgetProfile), ...input.limits });
  // Multipart keeps its existing staged value-tree and acknowledgement contract.
  const reuseAvailable = input.contextReuseAvailable === true && !input.compileOptions?.experimentalMultipartParts;
  const compile = (parsed: CodexParsedRequest, options = input.compileOptions) => compileChatGptWebPrompt(parsed, input.capabilities, input.turnToken, options);
  if (input.compileOptions?.contextNavigation) throw new Error("The context planner owns its navigation entry");
  let original: CompiledChatGptWebPrompt;
  let originalCompileFailure: unknown;
  try { original = compile(input.candidate); }
  catch (error) {
    if (!input.compileOptions?.experimentalMultipartParts || (error as { code?: string }).code !== "context_length_exceeded"
      || !input.contextToolsAvailable || !input.capabilities.localToolsEnabled || input.candidate._compactionRequest) throw error;
    // This complete ordinary compilation is a byte-comparison baseline only. It is never sent.
    // The final candidate must still compile and fit using the originally selected multipart mode.
    const { experimentalMultipartParts: _parts, ...ordinary } = input.compileOptions;
    original = compile(input.candidate, ordinary); originalCompileFailure = error;
  }
  const originalBytes = promptBytes(original);
  const mode = input.compileOptions?.manualControl
    ? { localTools: true, effort: "low" as const }
    : resolveChatGptWebModelMode(input.candidate.modelId, input.candidate.options.reasoning, input.capabilities);
  const composerLimited = input.capabilities.localToolsEnabled && mode.localTools && !input.candidate._compactionRequest;
  const maxComposer = input.capabilities.maxComposerCodePoints ?? CONTEXT_MAX_COMPOSER_CODE_POINTS;
  if (!Number.isSafeInteger(maxComposer) || maxComposer < 1) throw new Error("Invalid maximum composer code point configuration");
  const fitsComposer = (compiled: CompiledChatGptWebPrompt): boolean => !composerLimited
    || transportTexts(compiled).every(text => Array.from(text).length <= maxComposer);
  const contextWindow = input.budget?.contextWindowTokens ?? resolveChatGptWebContextLimits(input.candidate.modelId as Parameters<typeof resolveChatGptWebContextLimits>[0],
    input.compileOptions?.manualControl ? "low" : mode.effort, { ...input.capabilities,
      experimentalBiggerContext: input.experimentalBiggerContext ?? input.compileOptions?.experimentalMultipartParts !== undefined,
    }, input.candidate._chatgptModelFamily).contextWindow;
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
    const attachmentVision = media?.attachmentVisualTokens ?? 0;
    return { originalPromptTransport: originalCompileFailure ? "ordinary_capacity_baseline" : "candidate", originalPromptBytes: originalBytes,
      promptBytes: promptBytes(compiled), netSavedPromptBytes: originalBytes - promptBytes(compiled), promptTokens: tokens,
      acknowledgementTokens: acknowledgementTokens(compiled),
      originalContextFormat: original.contextFormat ?? "legacy-json", contextFormat: compiled.contextFormat ?? "legacy-json",
      originalPromptJsonBytes: promptJsonBytes(original), promptJsonBytes: promptJsonBytes(compiled),
      promptCharacters: transportTexts(compiled).reduce((sum, text) => sum + text.length, 0),
      originalPromptCodePoints: transportTexts(original).reduce((sum, text) => sum + Array.from(text).length, 0),
      promptCodePoints: transportTexts(compiled).reduce((sum, text) => sum + Array.from(text).length, 0),
      maxComposerMessageCodePoints: Math.max(...transportTexts(compiled).map(text => Array.from(text).length)),
      navigationPromptBytes, requiredMcpWireBytes: Object.entries(media?.imageResponseCosts ?? {}).filter(([id]) => media?.deliveryByTarget[id]?.required).reduce((sum, [, cost]) => sum + cost.wire_bytes, 0),
      requiredMcpTokens: requiredMcp, attachmentBytes: media?.attachmentBytes ?? 0, attachmentVisualTokens: attachmentVision,
      retainedTokens: retained, workReserveTokens: work, platformReserveTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
      discoveryReserveTokens: discoveryTokens, discoveryReserveWireBytes: discoveryWire, errorReserveTokens: errorTokens, errorReserveWireBytes: errorWire,
      requiredNavigationWireBytes: Object.values(media?.requiredImageWireReserves ?? {}).reduce((sum, value) => sum + value, 0) + discoveryWire + errorWire,
      requiredTotalTokens: tokens + retained + work + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + requiredMcp + attachmentVision + discoveryTokens + errorTokens,
      contextWindowTokens: contextWindow, remainingNavigationTokens: Math.max(0, contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - retained - tokens - attachmentVision) };
  };
  const assertCandidateCapacity = (compiled: CompiledChatGptWebPrompt, costs: ContextDeliveryCosts): void => {
    if (!fitsComposer(compiled)) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED",
      input.contextBootstrapAvailable === false
        ? "The complete prompt exceeds the composer code point budget and the current connector does not support context-bootstrap-v1"
        : "A complete composer message exceeds the configured Unicode code point budget", { max_composer_code_points: maxComposer, costs });
    if (costs.requiredTotalTokens > contextWindow) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The selected prompt, required media, retained context and work reserve exceed the context budget", { costs });
  const transportLimits = resolveChatGptWebTransportLimits(input.candidate.modelId as Parameters<typeof resolveChatGptWebTransportLimits>[0],
    input.compileOptions?.manualControl ? "low" : mode.effort, input.capabilities);
  if (!compiled.multipart && (compiled.text.length > (transportLimits.browserComposerCharLimit ?? Infinity)
    || promptTokens(compiled) > (transportLimits.browserMessageTokenLimit ?? Infinity))) {
    throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The selected prompt and navigation entry exceed the browser message budget", { costs });
  }
  if (compiled.multipart) {
    const texts = transportTexts(compiled);
    for (const [index, text] of texts.entries()) {
      const final = index === texts.length - 1;
      const effort = final ? mode.effort : input.capabilities.proAvailable ? "max" : "medium";
      const stageLimits = resolveChatGptWebTransportLimits(CHATGPT_WEB_MODEL_ID, effort, input.capabilities);
      const tokenBudget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, effort, input.capabilities,
        final ? costs.attachmentVisualTokens + skillFileTokens(compiled.skillFiles) : 0);
      if (text.length > (stageLimits.browserComposerCharLimit ?? Infinity) || estimateTokens(text) > tokenBudget) {
        throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A complete Bigger Context message exceeds its stage budget", { part_index: index + 1, costs });
      }
    }
  }
  };
  const fast = (): ContextDeliveryPlan => {
    if (originalCompileFailure) throw originalCompileFailure;
    const costs = baseCosts(original);
    if (composerLimited) assertCandidateCapacity(original, costs);
    return { snapshot: input.snapshot, compiled: original, projected: input.candidate, navigationEnabled: false, externalizedTargetIds: [],
      bodyDigest: hash(transportTexts(original).join("\n")), costs, limits };
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
  const omittedHistory = input.snapshot.targets.some(t => !selected.has(t.target_id) && t.read_ref
    && (t.kind === "tool_arguments" || t.kind === "tool_result" || t.kind === "image"));
  if (!input.contextToolsAvailable) {
    if (omittedHistory) throw new ContextDeliveryPlanningError("CONTEXT_MAPPING_UNPROVEN",
      "The candidate requires omitted history that the current connector cannot expose. Refresh its context tool schema or prepare a complete candidate before Send");
    return fast();
  }
  if (!input.turnToken) throw new Error("Context navigation requires the current credential");
  const bootstrapCandidate = (): ContextDeliveryPlan => {
    // Each trial gets its own source identity before any reference is rendered.
    let source: ContextSnapshot;
    try { source = appendFixedContextRecords(input.snapshot, [], { maxStorageBytes: limits.maxStorageBytes }); }
    catch (error) {
      throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The selected sources exceed the fixed-source storage budget",
        { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
    }
    const sourceInput = { ...input, snapshot: source };
    const planId = `plan_${randomBytes(16).toString("hex")}`;
    const externalized = new Set(source.targets.filter(t => selected.has(t.target_id) && t.read_ref
      && (t.kind === "tool_arguments" || t.kind === "tool_result")).map(t => t.target_id));
    const { experimentalMultipartParts: _parts, ...ordinaryOptions } = input.compileOptions ?? {};
    let media = planContextMedia({ snapshot: source, selectedTargetIds: selected, selectedImageParts: imageParts, limits,
      availableTokens: Math.max(0, contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - retained - work),
      attachmentSlotsReserved: original.skillFiles?.length ?? 0,
      attachmentBytesReserved: (original.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) });
    const attempts = source.targets.filter(t => t.kind === "image").length + 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const projected = projection(sourceInput, messages, media, externalized);
      const contextSystemImages = source.targets.filter(t => t.kind === "image" && t.source_kind === "system"
        && selected.has(t.target_id) && media.deliveryByTarget[t.target_id]?.media_route === "attachment")
        .map(t => ({ ...imageParts.get(t.target_id)!, imageUrl: media.attachmentUrls.get(t.target_id)! }));
      const prepared = compile(projected, { ...ordinaryOptions, bootstrapPreparation: true,
        ...(contextSystemImages.length ? { contextSystemImages } : {}), contextNavigation: {
          plan: { planId, contextId: source.context_id, manifestDigest: "0".repeat(64), requiredAttachments: media.requiredAttachments },
          overview: { sources: source.sources.length, targets: source.targets.length, source_cutoff: source.sources.length,
            externalized_targets: externalized.size, images: source.targets.filter(t => t.kind === "image").length, recent_tools: [] },
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
      const inlineCanonicalMessages = new Set(inlineRequest ? canonicalRequest : []);
      const textDelivery = (target: ContextTarget): ContextDelivery => ({ required: false,
        delivery: inlineCanonicalMessages.has(target.locator.message_index!) ? "inline"
          : selected.has(target.target_id) && !externalized.has(target.target_id) ? "source_required_record" : "source_on_demand" });
      const selectedSources = new Set(source.targets.filter(target => selected.has(target.target_id)).map(target => target.source_id));
      const candidateSources = new Map([...messages].map(([canonicalIndex, candidateIndex]) => [candidateIndex, canonicalIndex]));
      const sourceMap = {
        candidate_message_sources: input.candidate.context.messages.map((_, index) => candidateSources.get(index) ?? null),
        prepared_message_sources: prepared.bootstrapContent.messageSourceIndices,
        sources: source.sources.filter(item => selectedSources.has(item.source_id)),
        targets: source.targets.filter(target => selected.has(target.target_id)).map(target => {
          const { label: _label, label_source: _labelSource, ...metadata } = target;
          return { ...metadata, ...(target.kind !== "image" ? textDelivery(target) : media.deliveryByTarget[target.target_id]) };
        }),
      };
      let payload: unknown;
      let reuse: ContextReusePlan | undefined;
      let reusePrepared: ReturnType<typeof prepareContextReuse> | undefined;
      let inlineReusePayload: unknown;
      if (reuseAvailable) {
        try {
          reusePrepared = prepareContextReuse({ canonical: input.canonical, candidate: input.candidate,
            prepared: prepared.bootstrapContent, snapshot: source, planId, baseline: input.reuseBaseline, maxStorageBytes: limits.maxStorageBytes });
        } catch (error) {
          throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The exact context units exceed the fixed-source storage budget",
            { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
        }
        if (reusePrepared) {
          const inlinePayload = reusePrepared.makePayload(true, sourceMap);
          const trialEntry = shortContextReuseBootstrapPrompt({ ...entryInput, plan: provisionalDescriptor,
            reuse: reusePrepared.makePlan(true), inlinePayload });
          const useInline = Array.from(trialEntry.text).length <= maxComposer;
          reuse = reusePrepared.makePlan(useInline);
          payload = useInline ? inlinePayload : reusePrepared.makePayload(false, sourceMap);
          if (useInline) inlineReusePayload = payload;
        }
      }
      if (!reuse) {
        // The inline group is a positional part of this same value tree. A typed
        // reference avoids charging or delivering the original request twice.
        payload = { format: "context-bootstrap-payload-v1",
          inline_request_message_indices: inlineRequest?.message_indices ?? [],
          payload: { ...prepared.bootstrapContent.payload, messages: prepared.bootstrapContent.payload.messages.map((message, index) =>
            inlineRequest?.message_indices.includes(index) ? { codex_inline_request_message: { message_index: index } } : message) },
          source_map: sourceMap };
      }
      let snapshot: ContextSnapshot;
      try {
        snapshot = appendFixedContextRecords(reusePrepared?.snapshot ?? source, [
          ...(!reuse ? [{ text: prepared.bootstrapContent.protocol, encoding: "utf-8" as const, origin: "context_bootstrap_protocol" as const }] : []),
          { text: deterministicContextJson(payload), encoding: "deterministic-json", origin: "context_bootstrap_payload" },
        ], { contextId: source.context_id, maxStorageBytes: limits.maxStorageBytes });
      } catch (error) {
        throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The exact required sources exceed the fixed-source storage budget",
          { limit: "source_storage", reason: error instanceof Error ? error.message : String(error) });
      }
      const added = new Set(snapshot.targets.slice(source.targets.length).map(t => t.target_id));
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
      const manifestBasis = { context_id: snapshot.context_id, plan_id: planId, budget_profile: budgetProfile, limits,
        context_protocol: 4, manifest_version: 3, read_arguments: "reads-array", text_read_format: "context-text-batch-v1",
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
      const compiled: CompiledChatGptWebPrompt = { ...prepared, text: entry.text, contextPlan: descriptor };
      for (const [id, cost] of Object.entries(media.imageResponseCosts)) if (deliveryByTarget[id]?.required) {
        required.retry.tokens = Math.max(required.retry.tokens, cost.total_tokens);
        required.retry.wire_bytes = Math.max(required.retry.wire_bytes, cost.wire_bytes);
      }
      const costs = baseCosts(compiled, media, promptBytes(compiled), required.discovery);
      costs.fixedBootstrapCodePoints = entry.fixedCodePoints;
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
      // Account for text before publishing image routes. An image can narrow to an
      // attachment, but an admitted route can never consume required text capacity.
      const routed = planContextMedia({ snapshot: source, selectedTargetIds: selected, selectedImageParts: imageParts, limits,
        availableTokens: Math.max(0, contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - retained - work - costs.promptTokens
          - required.text.total_tokens - required.discovery.total_tokens - errorReserve.tokens - required.retry.tokens),
        reservedNavigationTokens: required.text.total_tokens + required.discovery.total_tokens + errorReserve.tokens + required.retry.tokens,
        reservedNavigationWireBytes: required.text.wire_bytes + required.discovery.wire_bytes + errorReserve.wire_bytes + required.retry.wire_bytes,
        attachmentSlotsReserved: prepared.skillFiles?.length ?? 0,
        attachmentBytesReserved: (prepared.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) });
      if (deterministicContextJson(routed.deliveryByTarget) !== deterministicContextJson(media.deliveryByTarget)) {
        media = routed; continue;
      }
      assertCandidateCapacity(compiled, costs);
      if (costs.requiredNavigationWireBytes > limits.maxTotalWireBytes
        || costs.requiredMcpTokens + costs.discoveryReserveTokens + costs.errorReserveTokens + required.retry.tokens > limits.maxTotalTokens) {
        throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The complete required batches, controls, recovery and corrective replies exceed the navigation budget", { limit: "required_reads", costs });
      }
      if (compiled.images.length !== media.attachmentCount || compiled.images.length + (compiled.skillFiles?.length ?? 0) > 10) {
        throw new ContextDeliveryPlanningError("CONTEXT_IMAGE_UNAVAILABLE", "The short bootstrap does not preserve its selected image attachment routes");
      }
      const registration: ContextPlanRegistration = { snapshot, planId, manifestDigest, startupProtocol: "context-bootstrap-v1", deliveryByTarget, limits, budgetProfile,
        ...(reuse ? { reuse } : {}),
        remainingBudget: { tokens: costs.remainingNavigationTokens, reserved_tokens: work, wire_bytes: limits.maxTotalWireBytes, reserved_wire_bytes: 0 },
        requiredImageTokenReserves: media.requiredImageTokenReserves, requiredImageWireReserves: media.requiredImageWireReserves,
        requiredTextBatches: required.batches, requiredControlReserve: required.control, requiredReturnRetryReserve: required.retry };
      return { snapshot, compiled, projected, navigationEnabled: true, externalizedTargetIds: [...externalized, ...added],
        registration, planId, manifestDigest, bodyDigest: hash(compiled.text), costs, limits };
    }
    throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "Required text and image delivery routes did not converge");
  };
  if (reuseAvailable && input.contextBootstrapAvailable !== false && !input.compileOptions?.captureLunaCheckpoint) return bootstrapCandidate();
  if (!fitsComposer(original) && input.contextBootstrapAvailable !== false && !input.compileOptions?.captureLunaCheckpoint) return bootstrapCandidate();
  const currentImages = imageParts.size > 0;
  const eligible = input.snapshot.targets.filter(t => selected.has(t.target_id) && t.read_ref
    && (t.kind === "tool_arguments" && t.source_kind === "assistant" || t.kind === "tool_result" && t.source_kind === "tool"))
    .map(target => {
      // Mirror the renderer's scalar eligibility and wrapper cost without recompiling
      // the entire history per field. Object arguments keep their structured form.
      const path = target.kind === "tool_arguments"
        ? ["message", "content", target.locator.content_index ?? 0, "arguments"]
        : target.locator.content_index === undefined ? ["message", "content"]
          : ["message", "content", target.locator.content_index, "text"];
      const options = { contextFormat: original.contextFormat ?? "legacy-json", path,
        rawTextPolicy: input.compileOptions?.contextRawTextPolicy };
      return { target, saving: estimateWebContextFieldCost(selectedField(input, target, messages), options).jsonBytes
        - estimateWebContextFieldCost(replacement(input.snapshot, target), options).jsonBytes };
    })
    .filter(({ saving }) => saving >= CONTEXT_MIN_EXTERNALIZE_BYTES)
    .sort((a, b) => b.saving - a.saving || a.target.source_index - b.target.source_index || a.target.target_index - b.target.target_index);
  if (!omittedHistory && !currentImages && eligible.length === 0) return fast();
  const mandatoryNavigation = omittedHistory || currentImages;
  const requiredImages = input.snapshot.targets.filter(t => t.kind === "image" && selected.has(t.target_id)
    && ["system", "developer", "user", "skill", "delegation", "agent_message"].includes(t.source_kind)).length;
  let initialDiscovery: ContextResponseCost;
  try { initialDiscovery = discoveryResponseCost(input.snapshot, limits, requiredImages, undefined, started); }
  catch (error) {
    if (mandatoryNavigation) throw error;
    const inline = fast();
    assertCandidateCapacity(inline.compiled, inline.costs);
    return inline;
  }
  const planId = `plan_${randomBytes(16).toString("hex")}`;
  const navigationCandidate = (externalized: ReadonlySet<string>): ContextDeliveryPlan => {
    // Each candidate owns its route and discovery reserves. A trial must not make
    // the inline candidate pay for routes or metadata that it does not publish.
    let discovery = initialDiscovery;
    const available = contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - retained - work - discovery.total_tokens - errorReserve.tokens;
    const mediaInput = () => ({ snapshot: input.snapshot, selectedTargetIds: selected, selectedImageParts: imageParts, limits,
      reservedNavigationTokens: discovery.total_tokens + errorReserve.tokens, reservedNavigationWireBytes: discovery.wire_bytes + errorReserve.wire_bytes,
      attachmentSlotsReserved: original.skillFiles?.length ?? 0, attachmentBytesReserved: (original.skillFiles ?? []).reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) });
    let media = planContextMedia({ ...mediaInput(), availableTokens: Math.max(0, available) });
    let manifestDigest = "";
    const compileProjected = (ids: ReadonlySet<string>, navigation: boolean): { projected: CodexParsedRequest; compiled: CompiledChatGptWebPrompt } => {
      const projected = projection(input, messages, media, ids);
      const contextSystemImages = input.snapshot.targets.filter(t => t.kind === "image" && t.source_kind === "system"
        && selected.has(t.target_id) && media.deliveryByTarget[t.target_id]?.media_route === "attachment")
        .map(t => ({ ...imageParts.get(t.target_id)!, imageUrl: media.attachmentUrls.get(t.target_id)! }));
      const options = { ...input.compileOptions, ...(contextSystemImages.length ? { contextSystemImages } : {}) };
      if (!navigation) return { projected, compiled: compile(projected, options) };
      manifestDigest = hash(deterministicContextJson(input.snapshot.targets.filter(t => t.kind === "image").map(target => ({
        target_id: target.target_id, content_digest: target.content_digest, ...media.deliveryByTarget[target.target_id] }))));
      const recent = input.snapshot.targets.filter(t => t.kind === "tool_arguments" || t.kind === "tool_result").slice(-3).map(t => ({
        target_id: t.target_id, kind: t.kind, tool_name: t.tool_name, call_id: t.call_id, label: Array.from(t.label).slice(0, 60).join("") }));
      return { projected, compiled: compile(projected, { ...options, contextNavigation: {
        plan: { planId, contextId: input.snapshot.context_id, manifestDigest, requiredAttachments: media.requiredAttachments },
        overview: { sources: input.snapshot.sources.length, targets: input.snapshot.targets.length, source_cutoff: input.snapshot.sources.length,
          externalized_targets: ids.size, images: input.snapshot.targets.filter(t => t.kind === "image").length, recent_tools: recent }, requiredImages: media.requiredImages,
      } }) };
    };
    let chosen = compileProjected(externalized, true);
    const deliveryMap = (): Record<string, ContextDelivery> => {
      const result: Record<string, ContextDelivery> = { ...media.deliveryByTarget };
      for (const target of input.snapshot.targets) if (target.kind !== "image") result[target.target_id] = {
        delivery: externalized.has(target.target_id) ? "source_on_demand" : selected.has(target.target_id) ? "inline" : "source_on_demand", required: false };
      return result;
    };
    // Route changes alter directory metadata. Reserve complete discovery pages and
    // narrow routes until the final body, discovery and required media all fit.
    // Reserves never decrease, so at most one narrowing per image can occur.
    const routeAttempts = input.snapshot.targets.filter(target => target.kind === "image").length + 2;
    for (let attempt = 0; attempt < routeAttempts; attempt++) {
      const measured = discoveryResponseCost(input.snapshot, limits, requiredImages, deliveryMap(), started);
      discovery = { wire_bytes: Math.max(discovery.wire_bytes, measured.wire_bytes),
        text_tokens: Math.max(discovery.text_tokens, measured.text_tokens), visual_tokens: 0,
        total_tokens: Math.max(discovery.total_tokens, measured.total_tokens) };
      if (discovery.wire_bytes + errorReserve.wire_bytes > limits.maxTotalWireBytes
        || discovery.total_tokens + errorReserve.tokens > limits.maxTotalTokens) {
        throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The context budget cannot carry its directory overview, useful entries and bounded error reserve");
      }
      const routed = planContextMedia({ ...mediaInput(), availableTokens: Math.max(0, contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS
        - retained - work - discovery.total_tokens - errorReserve.tokens - promptTokens(chosen.compiled)) });
      if (deterministicContextJson(routed.deliveryByTarget) === deterministicContextJson(media.deliveryByTarget)) break;
      media = routed; chosen = compileProjected(externalized, true);
      if (attempt === routeAttempts - 1) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The context media and discovery budgets did not converge");
    }
    const withoutEntry = compileProjected(externalized, false).compiled;
    const costs = baseCosts(chosen.compiled, media, promptBytes(chosen.compiled) - promptBytes(withoutEntry), discovery);
    assertCandidateCapacity(chosen.compiled, costs);
    if (costs.requiredNavigationWireBytes > limits.maxTotalWireBytes || media.requiredMcpTokens + discovery.total_tokens + errorReserve.tokens > limits.maxTotalTokens) {
      throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "The required context responses and bounded error reserve exceed the navigation budget", { costs });
    }
    if (chosen.compiled.images.length !== media.attachmentCount || chosen.compiled.images.length + (chosen.compiled.skillFiles?.length ?? 0) > 10) {
      throw new ContextDeliveryPlanningError("CONTEXT_IMAGE_UNAVAILABLE", "The compiled attachment list does not preserve the selected image routes");
    }
    const deliveryByTarget = deliveryMap();
    const registration: ContextPlanRegistration = { snapshot: input.snapshot, planId, manifestDigest,
      deliveryByTarget, limits, remainingBudget: { tokens: costs.remainingNavigationTokens, reserved_tokens: work, wire_bytes: limits.maxTotalWireBytes, reserved_wire_bytes: 0 },
      requiredImageTokenReserves: media.requiredImageTokenReserves, requiredImageWireReserves: media.requiredImageWireReserves };
    return { snapshot: input.snapshot, ...chosen, navigationEnabled: true, externalizedTargetIds: [...externalized], registration, planId, manifestDigest,
      bodyDigest: hash(transportTexts(chosen.compiled).join("\n")), costs, limits };
  };
  let inline: ContextDeliveryPlan | undefined;
  let inlineFailure: unknown;
  try {
    inline = mandatoryNavigation ? navigationCandidate(new Set()) : fast();
    assertCandidateCapacity(inline.compiled, inline.costs);
  } catch (error) {
    if (!(error instanceof ContextDeliveryPlanningError) && (error as { code?: string }).code !== "context_length_exceeded") throw error;
    inline = undefined; inlineFailure = error;
  }
  // Apply eligible fields together so preparation does not recompile every prefix.
  // Compare complete admitted candidates, including fixed protocol, directory,
  // required media and error reserves, rather than visible prompt bytes alone.
  if (eligible.length) {
    try {
      const trial = navigationCandidate(new Set(eligible.map(({ target }) => target.target_id)));
      if (!inline || trial.costs.requiredTotalTokens < inline.costs.requiredTotalTokens) return trial;
    } catch (error) {
      if (!(error instanceof ContextDeliveryPlanningError) && (error as { code?: string }).code !== "context_length_exceeded") throw error;
      if (!inline) throw error;
    }
  }
  if (inline) return inline;
  if (inlineFailure instanceof ContextDeliveryPlanningError && inlineFailure.details.max_composer_code_points !== undefined
    && input.contextBootstrapAvailable !== false && !input.compileOptions?.captureLunaCheckpoint) return bootstrapCandidate();
  throw inlineFailure;
}
