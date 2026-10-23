import { chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { parseDataUrl } from "../image";
import type { CodexImageContent } from "../../types";
import { contextLimits, measureContextResponse, type ContextLimitOverrides, type ContextResponseCost } from "./context-budget";
import { ContextNavigator } from "./context-navigator";
import { assertSupportedContextImage, type ContextSnapshot } from "./context-snapshot";
import type { ContextDelivery, ContextTarget } from "./context-types";
import { ChatGptWebAdapterError } from "./adapter-error";

/** These are the existing browser-worker file checks, in a module with no browser side effects. */
export const CONTEXT_ATTACHMENT_LIMITS = Object.freeze({ count: 10, imageBytes: 20_000_000, totalBytes: 50_000_000 });
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const REQUIRED_SOURCES = new Set(["system", "developer", "user", "skill", "delegation", "agent_message", "summary"]);

export class ContextDeliveryPlanningError extends ChatGptWebAdapterError {
  constructor(readonly code: "CONTEXT_MAPPING_UNPROVEN" | "CONTEXT_IMAGE_UNAVAILABLE" | "CONTEXT_BUDGET_EXCEEDED",
    message: string, readonly details: Record<string, unknown> = {}) {
    super(message, { status: 400, errorType: "invalid_request_error", code, retryable: false });
  }
}

export function contextAttachmentImage(imageUrl: string): { mimeType: string; bytes: number } | undefined {
  const parsed = parseDataUrl(imageUrl);
  if (!parsed || !IMAGE_MIMES.has(parsed.mediaType.toLowerCase())
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(parsed.base64, "base64"), mimeType = parsed.mediaType.toLowerCase();
  if (decoded.toString("base64") !== parsed.base64 || decoded.length === 0 || decoded.length > CONTEXT_ATTACHMENT_LIMITS.imageBytes) return undefined;
  try { assertSupportedContextImage(decoded, mimeType); } catch { return undefined; }
  return { mimeType, bytes: decoded.length };
}

export interface ContextMediaPlan {
  deliveryByTarget: Record<string, ContextDelivery>;
  /** Exact original bytes for a selected attachment route, including authorized fixed sources. */
  attachmentUrls: ReadonlyMap<string, string>;
  requiredAttachments: Array<{ id: string; label: string }>;
  requiredImageTokenReserves: Record<string, number>;
  requiredImageWireReserves: Record<string, number>;
  imageResponseCosts: Record<string, ContextResponseCost>;
  requiredImages: number;
  mcpImages: number;
  mcpImageBytes: number;
  mcpWireBytes: number;
  requiredMcpTokens: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentVisualTokens: number;
}

export interface ContextMediaPlanInput {
  snapshot: ContextSnapshot;
  /** Actual selected targets, proved by the caller's canonical field mapping. */
  selectedTargetIds: ReadonlySet<string>;
  selectedImageParts: ReadonlyMap<string, CodexImageContent>;
  limits?: ContextLimitOverrides;
  attachmentSlotsReserved?: number;
  attachmentBytesReserved?: number;
}

/** Routes are computed before publication. No image is fetched, changed, or sent here. */
export function planContextMedia(input: ContextMediaPlanInput): ContextMediaPlan {
  const limits = contextLimits(input.limits);
  const result: ContextMediaPlan = { deliveryByTarget: {}, attachmentUrls: new Map(), requiredAttachments: [],
    requiredImageTokenReserves: {}, requiredImageWireReserves: {}, imageResponseCosts: {}, requiredImages: 0, mcpImages: 0, mcpImageBytes: 0,
    mcpWireBytes: 0, requiredMcpTokens: 0, attachmentCount: 0, attachmentBytes: 0, attachmentVisualTokens: 0 };
  const attachmentUrls = result.attachmentUrls as Map<string, string>;
  const images = input.snapshot.targets.filter(t => t.kind === "image");
  const required = (target: ContextTarget) => input.selectedTargetIds.has(target.target_id) && REQUIRED_SOURCES.has(target.source_kind);
  const vision = (target: ContextTarget) => target.visual_token_reserve ?? chatGptWebImageTokenReserve(input.selectedImageParts.get(target.target_id)?.detail);
  const ordered = [...images.filter(required), ...images.filter(t => !required(t) && input.selectedTargetIds.has(t.target_id)),
    ...images.filter(t => !input.selectedTargetIds.has(t.target_id))];
  let attachmentSlots = input.attachmentSlotsReserved ?? 0;
  let attachmentBytes = input.attachmentBytesReserved ?? 0;
  for (const target of ordered) {
    const isRequired = required(target);
    if (isRequired) result.requiredImages++;
    const selected = input.selectedTargetIds.has(target.target_id);
    const fixed = target.read_ref ? input.snapshot.getImage(target.read_ref) : undefined;
    let mcpCost: ContextResponseCost | undefined;
    if (fixed && target.image_bytes !== null && target.image_bytes <= limits.maxImageBytes
      && result.mcpImages < limits.maxImageReads && result.mcpImageBytes + fixed.bytes.length <= limits.maxTotalImageBytes) {
      const navigator = new ContextNavigator({ scopeId: "context-media-preflight", snapshot: input.snapshot, purpose: "normal", limits,
        deliveryByTarget: { [target.target_id]: { delivery: "source_on_demand", media_route: "mcp", required: isRequired } } });
      const response = navigator.read({ context_id: input.snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
      if (!response.isError) mcpCost = measureContextResponse(response, { visualTokens: fixed.visual_token_reserve,
        wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve });
    }
    // Every image return must fit the fixed single-response limits.
    if (mcpCost && result.mcpImages < limits.maxImageReads
      && result.mcpImageBytes + fixed!.bytes.length <= limits.maxTotalImageBytes) {
      result.deliveryByTarget[target.target_id] = { delivery: "source_on_demand", media_route: "mcp", required: isRequired };
      result.imageResponseCosts[target.target_id] = mcpCost;
      result.mcpImages++; result.mcpImageBytes += fixed!.bytes.length; result.mcpWireBytes += mcpCost.wire_bytes;
      if (isRequired) { result.requiredMcpTokens += mcpCost.total_tokens;
        result.requiredImageTokenReserves[target.target_id] = mcpCost.total_tokens; result.requiredImageWireReserves[target.target_id] = mcpCost.wire_bytes; }
      continue;
    }
    const originalUrl = input.selectedImageParts.get(target.target_id)?.imageUrl;
    const attachmentUrl = fixed ? `data:${fixed.mime_type};base64,${Buffer.from(fixed.bytes).toString("base64")}` : originalUrl;
    const attachment = selected && attachmentUrl ? contextAttachmentImage(attachmentUrl) : undefined;
    if (attachment && attachmentSlots < CONTEXT_ATTACHMENT_LIMITS.count
      && attachmentBytes + attachment.bytes <= CONTEXT_ATTACHMENT_LIMITS.totalBytes) {
      result.deliveryByTarget[target.target_id] = { delivery: "attachment", media_route: "attachment", required: isRequired,
        reason: "The fixed MCP image does not fit the selected image budget; the supported attachment route is used" };
      attachmentUrls.set(target.target_id, attachmentUrl!);
      attachmentSlots++; attachmentBytes += attachment.bytes;
      result.attachmentCount++; result.attachmentBytes += attachment.bytes; result.attachmentVisualTokens += vision(target);
      if (isRequired) result.requiredAttachments.push({ id: target.target_id,
        label: `source ${target.source_index} / target ${target.target_index}: ${Array.from(target.label).slice(0, 80).join("")}` });
      continue;
    }
    const reason = !fixed && !attachment ? "The source has no supported fixed image or inline attachment representation"
      : "The image exceeds the selected MCP and attachment budgets";
    result.deliveryByTarget[target.target_id] = { delivery: "source_unavailable", media_route: "unavailable", required: isRequired, reason };
    if (isRequired) throw new ContextDeliveryPlanningError("CONTEXT_IMAGE_UNAVAILABLE", `Required image ${target.target_id} cannot be delivered`,
      { target_id: target.target_id, source_index: target.source_index, reason });
  }
  return result;
}
