import { measureContextResponse, type ContextLimits, type ContextResponseCost } from "./context-budget";
import { ContextDeliveryPlanningError } from "./context-media-plan";
import { ContextNavigator } from "./context-navigator";
import type { ContextSnapshot } from "./context-snapshot";
import type { ContextDelivery, ContextRequiredTextBatch } from "./context-types";
import type { ContextReusePlan } from "./context-reuse-types";

const empty = (): ContextResponseCost => ({ wire_bytes: 0, text_tokens: 0, visual_tokens: 0, total_tokens: 0 });
function add(total: ContextResponseCost, cost: ContextResponseCost): void {
  total.wire_bytes += cost.wire_bytes; total.text_tokens += cost.text_tokens;
  total.visual_tokens += cost.visual_tokens; total.total_tokens += cost.total_tokens;
}
export interface ContextBootstrapControlCosts {
  overview: { tokens: number; wire_bytes: number };
  start: { tokens: number; wire_bytes: number };
  /** Initial control, each MCP image recovery, and final readiness. */
  count: number;
}
/** Plan one finite chain with the runtime packer, then validate every materialized
 * step. Future scope bindings/signatures use bounded cursor token accounting. */
export function measureBootstrapRequiredCosts(input: {
  snapshot: ContextSnapshot; planId: string; manifestDigest: string; limits: ContextLimits;
  deliveryByTarget: Readonly<Record<string, ContextDelivery>>; started: number;
  reuse?: ContextReusePlan;
}): { text: ContextResponseCost; discovery: ContextResponseCost; batches: ContextRequiredTextBatch[];
  retry: { tokens: number; wire_bytes: number }; control: ContextBootstrapControlCosts } {
  const { snapshot, limits, deliveryByTarget } = input;
  const check = (): void => {
    if (performance.now() - input.started > limits.totalProcessingMs) throw new ContextDeliveryPlanningError(
      "CONTEXT_BUDGET_EXCEEDED", "Required context preflight exceeded its bounded processing deadline");
  };
  for (const target of snapshot.targets) if (target.kind !== "image" && deliveryByTarget[target.target_id]?.required
    && (!target.read_ref || target.source_completeness !== "complete")) throw new ContextDeliveryPlanningError(
    "CONTEXT_MAPPING_UNPROVEN", "A required text source is not complete and readable", { target_id: target.target_id });
  const options = { scopeId: "context-bootstrap-preflight", snapshot, purpose: "normal" as const, deliveryByTarget,
    limits };
  const bootstrap = { planId: input.planId, manifestDigest: input.manifestDigest, ...(input.reuse ? { reuse: input.reuse } : {}) };
  let batches: ContextRequiredTextBatch[];
  try { batches = new ContextNavigator({ ...options, bootstrap }).preflightRequiredTextBatches(); }
  catch { throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A required context batch cannot fit its complete response budget"); }
  const nav = new ContextNavigator({ ...options, bootstrap: { ...bootstrap, requiredTextBatches: batches } });
  const measure = (response: Parameters<typeof measureContextResponse>[0]): ContextResponseCost => {
    check();
    if (response.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A required context page cannot fit its complete response budget");
    return measureContextResponse(response, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve, boundCursorTokens: true });
  };
  const text = empty(), discovery = empty(), retry = { tokens: 0, wire_bytes: 0 };
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index]!, cost = measure(nav.preflightRead(nav.requiredReadArgs(index)));
    if (cost.total_tokens > batch.tokens || cost.wire_bytes > batch.wire_bytes
      || cost.total_tokens > limits.readTokens || cost.wire_bytes > limits.readBytes) throw new ContextDeliveryPlanningError(
      "CONTEXT_BUDGET_EXCEEDED", "A materialized required batch exceeded its fixed upper bound");
    batch.tokens = cost.total_tokens; batch.wire_bytes = cost.wire_bytes;
    add(text, cost);
    retry.tokens = Math.max(retry.tokens, cost.total_tokens); retry.wire_bytes = Math.max(retry.wire_bytes, cost.wire_bytes);
  }
  const images = snapshot.targets.filter(target => target.kind === "image" && deliveryByTarget[target.target_id]?.required
    && deliveryByTarget[target.target_id]?.media_route === "mcp");
  const requiredTexts = snapshot.targets.filter(target => target.kind !== "image" && deliveryByTarget[target.target_id]?.required).length;
  const controlReads = [null, ...batches.map((_, index) => ({ tool: "codex_context_read" as const, arguments: nav.requiredReadArgs(index) })),
    ...images.map(target => ({ tool: "codex_context_read" as const, arguments: { context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref! }] } }))];
  let overviewTokens = 0, overviewBytes = 0;
  for (const next of controlReads) {
    const overview = nav.preflightList({ context_id: snapshot.context_id, view: "overview" }, {
      context_ready: false, reuse_ready: false, text_ready: false, images_ready: false,
      required_images: images.length, delivered_images: images.length, required_texts: requiredTexts, delivered_texts: requiredTexts,
    }, { read_state: "readable", revision: Number.MAX_SAFE_INTEGER, acknowledged_revision: Number.MAX_SAFE_INTEGER,
      next_action: "Complete the original Launcher Sent confirmation. Then continue by repeating codex_turn_start with this request_id. Do not poll context reads while waiting." }, next);
    measure(overview);
    // Navigator meters this complete envelope for both list and start returns.
    for (const duplicate of [false, true]) {
      const body = { started: true, duplicate, context_bootstrap: overview.structuredContent };
      const cost = measure({ content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body });
      overviewTokens = Math.max(overviewTokens, cost.total_tokens); overviewBytes = Math.max(overviewBytes, cost.wire_bytes);
    }
  }
  const control: ContextBootstrapControlCosts = { overview: { tokens: overviewTokens, wire_bytes: overviewBytes },
    start: { tokens: overviewTokens, wire_bytes: overviewBytes }, count: images.length + 2 };
  for (let index = 0; index < control.count; index++) add(discovery, { wire_bytes: overviewBytes, text_tokens: overviewTokens,
    total_tokens: overviewTokens, visual_tokens: 0 });
  for (const target of images) {
    const result = nav.preflightRead({ context_id: snapshot.context_id, reads: [{ read_ref: target.read_ref! }] });
    const cost = measureContextResponse(result, { wireReserveBytes: limits.wireReserveBytes, tokenReserve: limits.tokenReserve,
      visualTokens: target.visual_token_reserve ?? 0, boundCursorTokens: true });
    if (result.isError) throw new ContextDeliveryPlanningError("CONTEXT_BUDGET_EXCEEDED", "A required image cannot fit its response budget");
    retry.tokens = Math.max(retry.tokens, cost.total_tokens); retry.wire_bytes = Math.max(retry.wire_bytes, cost.wire_bytes);
  }
  check();
  return { text, discovery, batches, retry, control };
}
