import { measureContextResponse, type ContextLimits, type ContextResponseCost } from "./context-budget";
import { ContextDeliveryPlanningError } from "./context-media-plan";
import { ContextNavigator } from "./context-navigator";
import type { ContextSnapshot } from "./context-snapshot";
import { parseContextTextReadResult } from "./context-text-result";
import type { ContextDelivery } from "./context-types";

export interface RequiredTextPageCost { start: number; end_exclusive: number; tokens: number; wire_bytes: number }
const empty = (): ContextResponseCost => ({ wire_bytes: 0, text_tokens: 0, visual_tokens: 0, total_tokens: 0 });
function add(total: ContextResponseCost, cost: ContextResponseCost): void {
  total.wire_bytes += cost.wire_bytes; total.text_tokens += cost.text_tokens;
  total.visual_tokens += cost.visual_tokens; total.total_tokens += cost.total_tokens;
}

/** Measure complete v2 pages and every required directory page. The same navigator
 * packs both preflight and runtime pages, including signed-cursor token bounds. */
export function measureBootstrapRequiredCosts(input: {
  snapshot: ContextSnapshot; planId: string; manifestDigest: string; limits: ContextLimits;
  deliveryByTarget: Readonly<Record<string, ContextDelivery>>; manual: boolean; started: number;
}): { text: ContextResponseCost; discovery: ContextResponseCost;
  pageCosts: Record<string, RequiredTextPageCost[]>; retry: { tokens: number; wire_bytes: number } } {
  const { snapshot, limits, deliveryByTarget } = input;
  const check = (): void => {
    if (performance.now() - input.started > limits.totalProcessingMs) throw new ContextDeliveryPlanningError(
      "CONTEXT_BUDGET_EXCEEDED", "Required context preflight exceeded its bounded processing deadline");
  };
  const nav = new ContextNavigator({ scopeId: "context-bootstrap-preflight", snapshot, purpose: "normal", deliveryByTarget,
    bootstrap: { planId: input.planId, manifestDigest: input.manifestDigest },
    limits: { ...limits, maxTotalTokens: Number.MAX_SAFE_INTEGER, maxTotalWireBytes: Number.MAX_SAFE_INTEGER } });
  const measure = (response: Parameters<typeof measureContextResponse>[0]): ContextResponseCost => {
    check();
    if (response.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A required context page cannot fit its complete response budget");
    return measureContextResponse(response, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve, boundCursorTokens: true });
  };
  const text = empty(), discovery = empty(), pageCosts: Record<string, RequiredTextPageCost[]> = {};
  const retry = { tokens: 0, wire_bytes: 0 };
  for (const target of snapshot.targets) {
    if (target.kind === "image" || !deliveryByTarget[target.target_id]?.required) continue;
    if (!target.read_ref || target.source_completeness !== "complete") throw new ContextDeliveryPlanningError(
      "CONTEXT_MAPPING_UNPROVEN", "A required text source is not complete and readable", { target_id: target.target_id });
    const pages: RequiredTextPageCost[] = [];
    let cursor: string | undefined;
    do {
      check();
      const result = nav.preflightRead({ context_id: snapshot.context_id, read_ref: target.read_ref, ...(cursor ? { cursor } : {}) });
      const cost = measure(result), { metadata } = parseContextTextReadResult(result);
      add(text, cost);
      pages.push({ ...metadata.range, tokens: cost.total_tokens, wire_bytes: cost.wire_bytes });
      retry.tokens = Math.max(retry.tokens, cost.total_tokens); retry.wire_bytes = Math.max(retry.wire_bytes, cost.wire_bytes);
      if (metadata.next_cursor === cursor) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "Required context pagination did not advance");
      cursor = metadata.next_cursor ?? undefined;
    } while (cursor);
    pageCosts[target.target_id] = pages;
  }
  // The start return and the overview return have different outer envelopes.
  // Reserve the larger complete result, including initial revision/control data.
  const overview = nav.preflightList({ context_id: snapshot.context_id, view: "overview" }, {
    context_ready: false, required_images: snapshot.targets.filter(t => t.kind === "image" && deliveryByTarget[t.target_id]?.required).length,
    delivered_images: 0, remaining_tokens: Number.MAX_SAFE_INTEGER, remaining_wire_bytes: Number.MAX_SAFE_INTEGER,
    text_ready: false, images_ready: false, required_texts: Object.keys(pageCosts).length, delivered_texts: Object.keys(pageCosts).length,
    required_text_bytes: snapshot.targets.filter(t => pageCosts[t.target_id]).reduce((sum, target) => sum + target.utf8_bytes!, 0),
    delivered_text_bytes: snapshot.targets.filter(t => pageCosts[t.target_id]).reduce((sum, target) => sum + target.utf8_bytes!, 0),
  }, { read_state: "readable", revision: Number.MAX_SAFE_INTEGER, acknowledged_revision: Number.MAX_SAFE_INTEGER });
  let overviewCost = measure(overview);
  // Runtime meters the complete start envelope as an upper bound in both modes.
  for (const duplicate of [false, true]) {
    const body = { started: true, duplicate, context_bootstrap: overview.structuredContent };
    const cost = measure({ content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body });
    overviewCost = { wire_bytes: Math.max(overviewCost.wire_bytes, cost.wire_bytes), text_tokens: Math.max(overviewCost.text_tokens, cost.text_tokens),
      visual_tokens: 0, total_tokens: Math.max(overviewCost.total_tokens, cost.total_tokens) };
  }
  overviewCost.wire_bytes = Math.max(overviewCost.wire_bytes, limits.listBytes);
  overviewCost.text_tokens = Math.max(overviewCost.text_tokens, limits.listTokens);
  overviewCost.total_tokens = Math.max(overviewCost.total_tokens, limits.listTokens);
  add(discovery, overviewCost);
  const manifest = overview.structuredContent as { required_targets: { has_more: boolean; next_cursor?: string | null } };
  let cursor = manifest.required_targets.next_cursor ?? undefined;
  let more = manifest.required_targets.has_more;
  while (more) {
    const result = nav.preflightList({ context_id: snapshot.context_id, view: "entries", required_only: true, ...(cursor ? { cursor } : {}) });
    add(discovery, measure(result));
    const page = result.structuredContent as { next_cursor: string | null };
    if (page.next_cursor === cursor) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "Required directory pagination did not advance");
    cursor = page.next_cursor ?? undefined;
    more = cursor !== undefined;
  }
  check();
  return { text, discovery, pageCosts, retry };
}
