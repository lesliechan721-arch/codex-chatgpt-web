import { contextCandidateCanonicalSource, contextCandidateMessageIndices, contextCandidateRawInputIndices } from "./context-candidate-mapping";
import type { ContextReuseBaseline } from "./context-reuse-types";
import {
  isChatGptWebZeroRiskBackendModel,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  resolveChatGptWebMessageTokenBudget,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest } from "../../types";
import { assertChatGptWebInputWithinLimits, chatGptPromptFilePayloads } from "./browser-worker";
import { continuityError } from "./continuity-errors";
import { estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "./input-tokens";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { planContextDelivery } from "./context-planner";
import { createContextSnapshot } from "./context-snapshot";
import {
  CHATGPT_MAX_INPUT_IMAGES, CHATGPT_ZERO_RISK_CONTINUITY_INPUT_CHAR_LIMIT,
  countChatGptContextImages,
  type CompiledChatGptWebPrompt,
} from "./prompt";

/** Validate the selected message only. Canonical history remains intact for usage and replay. */
export function assertContinuityCompiledInput(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  capabilityReserveTokens = 0,
): void {
  try {
    if (countChatGptContextImages(parsed.context.messages) > CHATGPT_MAX_INPUT_IMAGES) {
      throw continuityError("continuity_input_limit");
    }
    const inputTokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId) + capabilityReserveTokens;
    if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
      const visibleBudget = resolveChatGptWebMessageTokenBudget(parsed.modelId, "low", capabilities);
      if (compiled.text.length > CHATGPT_ZERO_RISK_CONTINUITY_INPUT_CHAR_LIMIT
        || inputTokens - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS > visibleBudget) throw continuityError("continuity_input_limit");
      return;
    }
    // Use the existing byte/count checks as well as the original model/composer boundaries.
    // Nothing is uploaded here; the returned buffers are not retained by the preflight.
    chatGptPromptFilePayloads(compiled);
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
    assertChatGptWebInputWithinLimits(
      inputTokens, estimateCompiledChatGptWebMessageTokens(compiled, parsed.modelId) + capabilityReserveTokens,
      parsed.modelId, mode.effort, capabilities, compiled.text.length,
    );
  } catch {
    throw continuityError("continuity_input_limit");
  }
}

function assertPreflightCapabilityBudget(compiled: CompiledChatGptWebPrompt, parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities, placeholder: string): void {
  // Both Broker capabilities have 32 base64url characters. Charge each entire ASCII token
  // again, plus its short JSON/text boundary, rather than assuming zero runs tokenize like
  // random capability text. The real prompt is still checked before any browser submission.
  const occurrences = compiled.text.split(placeholder).length - 1;
  assertContinuityCompiledInput(compiled, parsed, capabilities, occurrences * (placeholder.length + 8));
}

/** Source admission must precede this check. Only the possible selected delivery
 * plan contributes page cost; unread canonical tool history is not browser input. */
export function preflightContinuityInput(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
  retainedContinuity = false,
  options: { canonical?: CodexParsedRequest; retainedTokens?: number; contextReuseAvailable?: boolean; taskUpdateProtocol?: 1; reuseBaseline?: ContextReuseBaseline } = {},
): void {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const placeholder = `${manual ? "request" : "turn"}_${"0".repeat(32)}`;
  // This dry run proves capacity only. The real send still verifies the connector ABI,
  // binds the real credential and publishes its independently selected plan in the Adapter.
  const canonical = contextCandidateCanonicalSource(options.canonical ?? parsed, parsed) ?? options.canonical ?? parsed;
  const planned = planContextDelivery({ canonical, snapshot: createContextSnapshot(canonical, { imageStoragePolicy: "bounded" }), candidate: parsed,
    messageIndices: contextCandidateMessageIndices(canonical, parsed), rawInputIndices: contextCandidateRawInputIndices(canonical, parsed),
    capabilities, turnToken: placeholder, contextToolsAvailable: true, contextReuseAvailable: options.contextReuseAvailable,
    ...(retainedContinuity && options.reuseBaseline ? { reuseBaseline: options.reuseBaseline } : {}), budget: { retainedTokens: options.retainedTokens ?? 0 }, compileOptions: {
      ...(manual ? { manualControl: true } : { experimentalSkillAttachments }),
      ...(retainedContinuity ? { retainedContinuity: true } : {}),
      ...(options.taskUpdateProtocol ? { taskUpdateProtocol: options.taskUpdateProtocol } : {}),
    } });
  if (options.contextReuseAvailable) console.info(`[chatgpt-web] context_preflight ${JSON.stringify({ retained: retainedContinuity,
    cumulative_delivery_estimate_tokens: planned.costs.retainedTokens, planned_delivery_estimate_tokens: planned.costs.requiredTotalTokens,
    reuse: planned.costs.reuse })}`);
  assertPreflightCapabilityBudget(planned.compiled, planned.projected, capabilities, placeholder);
}
