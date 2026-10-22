import { CompactionDeadline } from "./compaction-deadline";
import { ContextReuseDiagnostics } from "./context-reuse-diagnostics";
import { createHash, randomBytes } from "node:crypto";
import { withTokenEstimateCache } from "../../lib/token-estimate";
import { ContextNavigator, ContextNavigationStoppedError, type ContextNavigationUsage } from "./context-navigator";
import { deterministicContextJson, type ContextSnapshot } from "./context-snapshot";
import { assertContextNavigationBudget, contextLimits, measureContextResponse, UNLIMITED_CONTEXT_ALLOWANCE, type ContextLimitOverrides, type ContextBudgetProfile } from "./context-budget";
import type { ContextDelivery, ContextListArgs, ContextReadArgs, ContextSearchArgs, ContextRemainingBudget, ContextBootstrapControl, ContextRequiredRead, ContextRequiredTextBatch, ContextTarget } from "./context-types";
import { measureBootstrapRequiredCosts } from "./context-bootstrap-plan";
import type { BrokerToolResult } from "./turn-broker";
import { NativeOperationError } from "./native-tool-operations";
import { contextTextReadReceipt, contextTextReadReceiptsEqual, parseContextTextReadResult, type ContextTextReadReceipt } from "./context-text-result";
import { ContextTextCoverage } from "./context-text-coverage";
export { CONTEXT_PROTOCOL_VERSION } from "./context-protocol";

import { CONTEXT_REUSE_PROTOCOL, type ContextReusePlan, type ContextReuseDeliveryEvidence } from "./context-reuse-types";
import { boundedContextReuse } from "./context-reuse-lifecycle";

export const CONTEXT_READY_TIMEOUT_MS = 120_000;
export const CONTEXT_PROGRESS_TIMEOUT_MS = 45_000;
export const CONTEXT_ATTACHMENT_TIMEOUT_MS = 300_000;
export const CONTEXT_RETURN_TIMEOUT_MS = 90_000;
export type ContextMethod = "list" | "read" | "search";
export type ContextArgs = ContextListArgs | ContextReadArgs | ContextSearchArgs;
export interface ContextPlanRegistration {
  snapshot: ContextSnapshot;
  planId: string;
  manifestDigest: string;
  deliveryByTarget: Readonly<Record<string, ContextDelivery>>;
  startupProtocol?: "context-bootstrap-v1";
  reuse?: ContextReusePlan;
  limits?: ContextLimitOverrides;
  budgetProfile?: ContextBudgetProfile;
  requiredImageTokenReserves?: Readonly<Record<string, number>>;
  requiredImageWireReserves?: Readonly<Record<string, number>>;
  requiredTextBatches?: readonly ContextRequiredTextBatch[];
  requiredControlReserve?: { overview: ContextReservedCost; start: ContextReservedCost; count: number };
  requiredReturnRetryReserve?: { tokens: number; wire_bytes: number };
  remainingBudget?: ContextRemainingBudget;
}
export interface ContextAttachmentConfirmation { planId: string; manifestDigest: string }
export interface ContextStatus {
  context_id: string;
  plan_id: string;
  context_ready: boolean;
  text_ready: boolean;
  reuse_ready?: boolean;
  reuse_failure?: string;
  images_ready: boolean;
  required_texts: number;
  delivered_texts: number;
  remaining_texts: number;
  required_text_bytes: number;
  delivered_text_bytes: number;
  next_required_read: ContextRequiredRead | null;
  required_images: number;
  delivered_images: number;
  remaining_images: number;
  next_actions: Array<{ read_ref: string } | { action: "confirm_attachments"; manifest_digest: string }>;
}
export interface CompactionContextRegistration {
  snapshot: ContextSnapshot;
  recovery?: import("./continuity-recovery-runtime").RuntimeRecoveryReference;
  contract: "native" | "safe";
  /** Existing explicit manual compaction input, prepared before its original start/Sent. */
  explicitManual?: true;
  transactionToken?: string;
  turnToken?: string;
  handoffId: string;
  historyRevision: number;
  ownerGeneration: string;
  expiresAt: number;
  limits?: ContextLimitOverrides;
  remainingBudget?: ContextRemainingBudget;
}
export interface CompactionContextHandle { compactionToken: string; contextId: string }
export interface ContextPreparedReply { result: BrokerToolResult; receiptId: string }
export interface ContextUsageEvidence {
  context_id: string;
  plan_id: string;
  purpose: "normal" | "compaction";
  usage: ContextNavigationUsage;
  reserved_tokens_used: number;
  final: boolean;
  reuse_delivery?: ContextReuseDeliveryEvidence;
  reuse_diagnostics?: ReturnType<ContextReuseDiagnostics["snapshot"]>;
}
export interface ContextVerificationRegistration {
  normal: ContextPlanRegistration;
  compactionSnapshot: ContextSnapshot;
  expiresAt: number;
}
export interface ContextVerificationHandle {
  pairToken: string;
  compactionToken: string;
  normalContextId: string;
  compactionContextId: string;
}
export interface ContextVerificationStatus extends ContextVerificationHandle {
  planId: string;
  completed: boolean;
  ordinary: ContextVerificationReceipts;
  compaction: ContextVerificationReceipts;
  expiresAt: number;
}
export type ContextVerificationReceipts = Record<ContextMethod, boolean> & { text_read?: ContextTextReadReceipt };
export interface ContextSuccessfulReturn { method: ContextMethod; textRead?: ContextTextReadReceipt }
interface ContextReservedCost { tokens: number; wire_bytes: number }
interface ContextPendingReturn {
  targetIds: readonly string[];
  manifestOrder?: number;
  method: ContextMethod;
  successful: boolean;
  observedCost: { wire_bytes: number; total_tokens: number };
  textRead?: ContextTextReadReceipt;
  requiredCost?: ContextReservedCost;
  recoveryClaim?: ContextReservedCost;
  replayCharged?: boolean;
  requestedItems?: number;
  stopTimer: () => void;
}

export function contextFailure(code: string, message: string, detail: Record<string, unknown> = {}): BrokerToolResult {
  const value = { code, message, ...detail };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}
export function contextError(code: string, message: string): NativeOperationError {
  return new NativeOperationError(code, message);
}
function identifier(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw contextError("CONTEXT_INVALID", "Invalid bounded context identity");
}

/** A return remains in flight until the supported MCP transport confirms its send.
 * Coverage and completion therefore share the Broker's synchronous mutation boundary. */
export class ContextScope {
  readonly navigator: ContextNavigator;
  private readonly delivered = new Set<string>();
  private readonly generatedRequiredImages = new Set<string>();
  private readonly generatedRequiredBatches = new Set<number>();
  private readonly coverage = new ContextTextCoverage();
  private readonly reuseDiagnostics = new ContextReuseDiagnostics();
  private manifestSequence = 0;
  private firstWorkReturns?: Set<string>;
  private readonly textBatches: readonly ContextRequiredTextBatch[];
  private readonly controlReserve?: ContextPlanRegistration["requiredControlReserve"];
  private readonly generatedControls = new Set<string>();
  private readonly retryReserve: ContextReservedCost;
  private readonly recoverySpent = { tokens: 0, wire_bytes: 0 };
  private reservedTokensUsed = 0;
  private readonly pending = new Map<string, ContextPendingReturn>();
  private live = true;
  private deliveredEntry = false;
  private permanentFailure = false;
  private budgetStopped = false;
  private readonly effectiveBudget: ContextRemainingBudget;
  private readyStarted?: number;
  private lastProgress?: number;
  private attachmentStarted?: number;
  private compactionDeadline?: CompactionDeadline;
  private readinessTimer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly scopeId: string,
    readonly registration: ContextPlanRegistration,
    readonly purpose: "normal" | "compaction",
    private readonly changed: () => void,
    private readonly fail: (error: Error) => void,
    readonly expiresAt?: number,
    private readonly reuseValid: () => boolean = () => !registration.reuse?.dependency,
  ) {
    if (purpose === "compaction" && expiresAt !== undefined) this.compactionDeadline = new CompactionDeadline(expiresAt);
    // A plan and its effective limits do not change after this scope is published.
    registration = this.registration = { ...registration, limits: contextLimits(registration.limits),
      deliveryByTarget: structuredClone(registration.deliveryByTarget),
      requiredTextBatches: registration.requiredTextBatches && structuredClone(registration.requiredTextBatches),
      requiredControlReserve: registration.requiredControlReserve && structuredClone(registration.requiredControlReserve),
      requiredReturnRetryReserve: registration.requiredReturnRetryReserve && { ...registration.requiredReturnRetryReserve },
      requiredImageTokenReserves: { ...registration.requiredImageTokenReserves },
      requiredImageWireReserves: { ...registration.requiredImageWireReserves },
      remainingBudget: registration.remainingBudget && { ...registration.remainingBudget } };
    identifier(registration.planId); identifier(registration.manifestDigest);
    if (registration.reuse) {
      const reuse = registration.reuse;
      if (reuse.protocol !== CONTEXT_REUSE_PROTOCOL || reuse.payload_format !== "context-bootstrap-payload-v2"
        || !boundedContextReuse(reuse) || new Set(reuse.units.map(unit => unit.unit_id)).size !== reuse.units.length
        || reuse.units.some(unit => !registration.snapshot.getTarget(unit.target_id)
          || !["inline", "required", "reuse"].includes(unit.delivery)
          || unit.delivery === "required" && !registration.deliveryByTarget[unit.target_id]?.required
          || unit.delivery === "reuse" && !reuse.dependency?.units.some(dependency => dependency.unit_id === unit.unit_id && dependency.fingerprint === unit.fingerprint))) {
        throw contextError("CONTEXT_INVALID", "Invalid bounded reuse unit delivery plan");
      }
    }
    const limits = contextLimits(registration.limits);
    const supplied = registration.remainingBudget;
    this.effectiveBudget = { tokens: supplied?.tokens ?? UNLIMITED_CONTEXT_ALLOWANCE,
      reserved_tokens: supplied?.reserved_tokens ?? 0,
      wire_bytes: supplied?.wire_bytes ?? UNLIMITED_CONTEXT_ALLOWANCE,
      reserved_wire_bytes: supplied?.reserved_wire_bytes ?? 0 };
    for (const reserves of [registration.requiredImageTokenReserves, registration.requiredImageWireReserves]) {
      for (const [id, reserve] of Object.entries(reserves ?? {})) {
        const target = registration.snapshot.getTarget(id);
        const minimum = reserves === registration.requiredImageTokenReserves ? target?.visual_token_reserve ?? 0
          : Math.ceil((target?.image_bytes ?? 0) / 3) * 4 + limits.wireReserveBytes;
        if (target?.kind !== "image" || !Number.isSafeInteger(reserve) || reserve < minimum) throw contextError("CONTEXT_INVALID", "Invalid required-image budget reserve");
      }
    }
    for (const [id, delivery] of Object.entries(registration.deliveryByTarget)) {
      const target = registration.snapshot.getTarget(id);
      if (!target || target.kind !== "image" && delivery.required && (registration.startupProtocol !== "context-bootstrap-v1"
        || delivery.delivery !== "source_required" || !target.read_ref || target.source_completeness !== "complete")) throw contextError("CONTEXT_INVALID", "Invalid required context source");
      if (target.kind === "image" && delivery.required && (!(["mcp", "attachment"].includes(delivery.media_route ?? "")) || (delivery.media_route === "mcp" && !target.read_ref))) {
        throw contextError("CONTEXT_IMAGE_UNAVAILABLE", "A required source image cannot be delivered");
      }
    }
    const planned = registration.startupProtocol && purpose === "normal"
      && (!registration.requiredTextBatches || !registration.requiredControlReserve)
      ? measureBootstrapRequiredCosts({ snapshot: registration.snapshot, planId: registration.planId,
        manifestDigest: registration.manifestDigest, limits, deliveryByTarget: registration.deliveryByTarget,
        started: performance.now(), ...(registration.reuse ? { reuse: registration.reuse } : {}) }) : undefined;
    this.textBatches = purpose === "normal" && registration.startupProtocol
      ? registration.requiredTextBatches ?? planned!.batches : [];
    this.controlReserve = purpose === "normal" && registration.startupProtocol
      ? registration.requiredControlReserve ?? planned!.control : undefined;
    const ends = new Map<string, number>();
    for (const batch of this.textBatches) {
      if (!Array.isArray(batch.reads) || !Array.isArray(batch.ranges) || !batch.reads.length || batch.reads.length > 8
        || !batch.ranges.length || batch.ranges.length > batch.reads.length
        || new Set(batch.reads.map(read => read.target_id)).size !== batch.reads.length
        || !Number.isSafeInteger(batch.tokens) || batch.tokens < limits.tokenReserve
        || !Number.isSafeInteger(batch.wire_bytes) || batch.wire_bytes < limits.wireReserveBytes) {
        throw contextError("CONTEXT_INVALID", "Invalid required text batch budget");
      }
      for (const [index, range] of batch.ranges.entries()) {
        const target = registration.snapshot.getTarget(range.target_id), read = batch.reads[index];
        if (!target || target.kind === "image" || !registration.deliveryByTarget[target.target_id]?.required
          || !read || read.target_id !== range.target_id || read.start !== range.start
          || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end_exclusive)
          || range.start !== (ends.get(range.target_id) ?? 0) || range.end_exclusive < range.start
          || range.end_exclusive > target.utf8_bytes! || range.end_exclusive === range.start && target.utf8_bytes !== 0
          || target.utf8_bytes === 0 && ends.has(range.target_id)) {
          throw contextError("CONTEXT_INVALID", "Invalid fixed required text batch range");
        }
        ends.set(range.target_id, range.end_exclusive);
      }
    }
    if (this.requiredTextTargets().some(target => ends.get(target.target_id) !== target.utf8_bytes)) {
      throw contextError("CONTEXT_INVALID", "Required text batches do not cover the fixed sources");
    }
    const requiredMcpImages = this.requiredTargets().filter(t => registration.deliveryByTarget[t.target_id]?.media_route === "mcp");
    const minimumRetry = {
      tokens: Math.max(0, ...this.textBatches.map(batch => batch.tokens), ...requiredMcpImages.map(target =>
        registration.requiredImageTokenReserves?.[target.target_id] ?? (target.visual_token_reserve ?? 0) + limits.imageMetadataTokens)),
      wire_bytes: Math.max(0, ...this.textBatches.map(batch => batch.wire_bytes), ...requiredMcpImages.map(target => this.imageWireReserve(target))) };
    this.retryReserve = registration.startupProtocol && purpose === "normal"
      ? registration.requiredReturnRetryReserve ?? minimumRetry : { tokens: 0, wire_bytes: 0 };
    if (Object.entries(this.retryReserve).some(([key, n]) => !Number.isSafeInteger(n) || n < 0 || registration.startupProtocol && purpose === "normal" && n < minimumRetry[key as keyof typeof minimumRetry])) {
      throw contextError("CONTEXT_INVALID", "Invalid required return recovery reserve");
    }
    if (this.controlReserve && (this.controlReserve.count !== requiredMcpImages.length + 2
      || [this.controlReserve.overview, this.controlReserve.start].some(cost =>
        !Number.isSafeInteger(cost.tokens) || cost.tokens < 0 || !Number.isSafeInteger(cost.wire_bytes) || cost.wire_bytes < 0))) {
      throw contextError("CONTEXT_INVALID", "Invalid required control reserve");
    }
    const remainingBudget = (targets?: readonly ContextTarget[], result?: BrokerToolResult): ContextRemainingBudget =>
      this.remainingBudget(targets, result);
    try {
      const initial = remainingBudget();
      assertContextNavigationBudget(initial, limits);
    }
    catch { throw contextError("BUDGET_EXCEEDED", "The context budget cannot protect required sources, completion and bounded corrective replies"); }
    this.navigator = new ContextNavigator({ scopeId, snapshot: registration.snapshot, purpose,
      deliveryByTarget: registration.deliveryByTarget, limits: registration.limits, remainingBudget,
      ...(registration.startupProtocol ? { bootstrap: { planId: registration.planId, manifestDigest: registration.manifestDigest, requiredTextBatches: this.textBatches, ...(registration.reuse ? { reuse: registration.reuse } : {}) } } : {}) });
  }

  private imageWireReserve(target: ContextTarget): number {
    return this.registration.requiredImageWireReserves?.[target.target_id]
      ?? Math.ceil((target.image_bytes ?? 0) / 3) * 4 + 2 * Buffer.byteLength(JSON.stringify(target)) + 1024
        + contextLimits(this.registration.limits).wireReserveBytes;
  }
  private batchCovered(batch: ContextRequiredTextBatch, additions: readonly { target_id: string; start: number; end_exclusive: number }[] = []): boolean {
    return batch.ranges.every(range => this.coverage.contains(range.target_id, range.start, range.end_exclusive,
      additions.find(addition => addition.target_id === range.target_id)));
  }
  private recoveryAvailable(): ContextReservedCost {
    if (this.firstWorkReturns) return { tokens: 0, wire_bytes: 0 };
    const claims = [...this.pending.values()].reduce((sum, entry) => ({
      tokens: sum.tokens + (entry.recoveryClaim?.tokens ?? 0),
      wire_bytes: sum.wire_bytes + (entry.recoveryClaim?.wire_bytes ?? 0),
    }), { tokens: 0, wire_bytes: 0 });
    return { tokens: Math.max(0, this.retryReserve.tokens - this.recoverySpent.tokens - claims.tokens),
      wire_bytes: Math.max(0, this.retryReserve.wire_bytes - this.recoverySpent.wire_bytes - claims.wire_bytes) };
  }
  private controlCredits(result?: BrokerToolResult): string[] {
    const body = result?.structuredContent as { startup_protocol?: string; read_state?: string } | undefined;
    if (!this.controlReserve || !result || result.isError || body?.startup_protocol !== "context-bootstrap-v1"
      || body.read_state !== "readable" || this.firstWorkReturns) return [];
    if (!this.generatedControls.has("initial")) return ["initial"];
    const keys = this.requiredTargets().filter(target => this.delivered.has(target.target_id)
      && this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp")
      .map(target => `image:${target.target_id}`).filter(key => !this.generatedControls.has(key));
    if (this.status().context_ready && !this.generatedControls.has("final")) keys.push("final");
    return keys;
  }
  private remainingControlCost(credits: readonly string[] = []): ContextReservedCost {
    if (!this.controlReserve || this.firstWorkReturns) return { tokens: 0, wire_bytes: 0 };
    const { start, overview } = this.controlReserve;
    const units = [{ key: "initial", tokens: Math.max(start.tokens, overview.tokens), wire_bytes: Math.max(start.wire_bytes, overview.wire_bytes) },
      { key: "final", ...overview }, ...this.requiredTargets().filter(target => this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp")
        .map(target => ({ key: `image:${target.target_id}`, ...overview }))];
    return units.filter(unit => !this.generatedControls.has(unit.key) && !credits.includes(unit.key))
      .reduce((sum, unit) => ({ tokens: sum.tokens + unit.tokens, wire_bytes: sum.wire_bytes + unit.wire_bytes }), { tokens: 0, wire_bytes: 0 });
  }
  private remainingBudget(targets: readonly ContextTarget[] = [], result?: BrokerToolResult): ContextRemainingBudget {
    const limits = contextLimits(this.registration.limits), used = this.navigator?.usage(), budget = this.effectiveBudget;
    const metadata = result && !result.isError && (result.structuredContent as { format?: string } | undefined)?.format === "context-text-batch-v1"
      ? parseContextTextReadResult(result).metadata : undefined;
    const step = metadata?.required_step;
    const canonical = step && step.plan_id === this.registration.planId ? this.textBatches[step.index] : undefined;
    const additions = canonical ? metadata!.items.map(item => ({ target_id: String(item.source.target_id), ...item.range })) : [];
    const text = this.textBatches.filter(batch => !this.batchCovered(batch, additions))
      .reduce((sum, batch) => ({ tokens: sum.tokens + batch.tokens, wire_bytes: sum.wire_bytes + batch.wire_bytes }), { tokens: 0, wire_bytes: 0 });
    const readingImage = result && !result.isError && targets.length === 1 && targets[0]!.kind === "image" ? targets[0] : undefined;
    const images = this.requiredTargets().filter(target => !this.delivered.has(target.target_id)
      && target.target_id !== readingImage?.target_id && this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp"
      && (this.registration.startupProtocol || !this.hasPendingTarget(target.target_id)));
    const retry = this.recoveryAvailable();
    // A canonical replay can use only the remaining shared recovery allowance.
    // New canonical delivery credits its whole unit temporarily; its pending entry
    // then protects every undelivered range until the atomic transport settlement.
    if (canonical && this.batchCovered(canonical) && result) {
      const cost = measureContextResponse(result, limits);
      retry.tokens = Math.max(0, retry.tokens - cost.total_tokens);
      retry.wire_bytes = Math.max(0, retry.wire_bytes - cost.wire_bytes);
    }
    const controls = this.remainingControlCost(this.controlCredits(result));
    const spentTokens = (used?.text_tokens ?? 0) + (used?.visual_token_reserve ?? 0), spentWire = used?.wire_bytes ?? 0;
    return { tokens: Math.max(0, budget.tokens - spentTokens),
      reserved_tokens: (budget.reserved_tokens ?? 0) + text.tokens + retry.tokens + controls.tokens + images.reduce((sum, target) =>
        sum + (this.registration.requiredImageTokenReserves?.[target.target_id] ?? (target.visual_token_reserve ?? 0) + limits.imageMetadataTokens), 0),
      wire_bytes: Math.max(0, budget.wire_bytes - spentWire),
      reserved_wire_bytes: (budget.reserved_wire_bytes ?? 0) + text.wire_bytes + retry.wire_bytes + controls.wire_bytes
        + images.reduce((sum, target) => sum + this.imageWireReserve(target), 0),
      image_reads: Math.max(0, limits.maxImageReads - (used?.image_reads ?? 0)), reserved_image_reads: images.length,
      image_bytes: Math.max(0, limits.maxTotalImageBytes - (used?.image_bytes ?? 0)),
      reserved_image_bytes: images.reduce((sum, target) => sum + (target.image_bytes ?? 0), 0) };
  }
  private consumeControl(result: BrokerToolResult): void {
    for (const key of this.controlCredits(result)) this.generatedControls.add(key);
  }

  assertPending(receiptId: string, textRead?: ContextTextReadReceipt): void {
    this.assertLive();
    const pending = this.pending.get(receiptId);
    if (!pending) throw contextError("CONTEXT_RETIRED", "The context return is no longer active");
    if (pending.textRead && !contextTextReadReceiptsEqual(pending.textRead, textRead)) throw contextError("CONTEXT_INVALID", "The transported text result does not match the complete fixed batch");
  }
  get inFlight(): number { return this.pending.size; }
  get isLive(): boolean { return this.live && (this.compactionDeadline ? this.compactionDeadline.remainingMs() > 0 : this.expiresAt === undefined || Date.now() < this.expiresAt); }
  usageEvidence(final = false): ContextUsageEvidence {
    const reuseDelivery = this.reuseDeliveryEvidence();
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      purpose: this.purpose, usage: this.navigator.usage(), reserved_tokens_used: this.reservedTokensUsed, final,
      reuse_diagnostics: this.reuseDiagnostics.snapshot(),
      ...(reuseDelivery ? { reuse_delivery: reuseDelivery } : {}) };
  }
  recordFirstWork(): void {
    if (this.firstWorkReturns) return;
    this.firstWorkReturns = new Set(this.pending.keys());
    this.reuseDiagnostics.freeze();
  }
  /** Observe the actual start envelope without charging its already-generated manifest twice. */
  prepareBootstrapReturn(response: Record<string, unknown>): string {
    this.assertLive();
    if (this.pending.size >= 8) throw contextError("CONTEXT_BUSY", "Wait for in-flight context returns");
    const result = { content: [{ type: "text", text: JSON.stringify(response) }], structuredContent: response };
    const receiptId = `context_return_${randomBytes(24).toString("base64url")}`;
    const stopTimer = this.returnTimer(() => this.finish(receiptId, false));
    this.pending.set(receiptId, { targetIds: [], manifestOrder: this.manifestSequence++, method: "list", successful: true,
      observedCost: measureContextResponse(result, { wireReserveBytes: 0, tokenReserve: 0 }), stopTimer });
    this.changed();
    return receiptId;
  }
  private reuseDeliveryEvidence(): ContextReuseDeliveryEvidence | undefined {
    const reuse = this.registration.reuse;
    if (!reuse || !this.deliveredEntry || !this.live || this.permanentFailure || this.pending.size || !this.status().context_ready) return undefined;
    if (reuse.units.some(unit => unit.delivery === "required" && !this.coverage.contains(unit.target_id, 0,
      this.registration.snapshot.getTarget(unit.target_id)!.utf8_bytes!))) return undefined;
    const evidence = { plan_id: this.registration.planId, context_id: this.registration.snapshot.context_id,
      units: reuse.units.map(({ delivery, target_id, ...unit }) => unit), snapshots: reuse.snapshots };
    return boundedContextReuse(evidence) ? evidence : undefined;
  }
  private hasPendingTarget(targetId: string): boolean { return [...this.pending.values()].some(pending => pending.targetIds.includes(targetId)); }
  private requiredTargets() {
    return this.purpose === "compaction" ? [] : this.registration.snapshot.targets.filter(t => t.kind === "image" && this.registration.deliveryByTarget[t.target_id]?.required === true);
  }
  private requiredTextTargets() {
    return this.purpose !== "normal" || !this.registration.startupProtocol ? [] : this.registration.snapshot.targets.filter(t => t.kind !== "image"
      && this.registration.deliveryByTarget[t.target_id]?.required === true);
  }
  status(): ContextStatus {
    const required = this.requiredTargets();
    const remaining = required.filter(t => !this.delivered.has(t.target_id));
    const next: ContextStatus["next_actions"] = [];
    for (const target of remaining) {
      if (this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp" && target.read_ref && next.length < 4) next.push({ read_ref: target.read_ref });
    }
    if (remaining.some(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "attachment")) next.push({ action: "confirm_attachments", manifest_digest: this.registration.manifestDigest });
    const texts = this.requiredTextTargets();
    const missingTexts = texts.filter(t => !this.coverage.contains(t.target_id, 0, t.utf8_bytes!));
    const image = remaining.find(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "mcp" && t.read_ref);
    const batchIndex = this.textBatches.findIndex(batch => !this.batchCovered(batch));
    const nextRequiredRead: ContextRequiredRead | null = image ? { tool: "codex_context_read", arguments: {
      context_id: this.registration.snapshot.context_id, reads: [{ read_ref: image.read_ref! }] } } : batchIndex >= 0 ? {
      tool: "codex_context_read", arguments: this.navigator.requiredReadArgs(batchIndex) } : null;
    const reuseReady = this.reuseValid();
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      ...(this.registration.reuse ? { reuse_ready: reuseReady, ...(!reuseReady ? { reuse_failure: "baseline_invalid" } : {}) } : {}),
      context_ready: !this.permanentFailure && !this.budgetStopped && remaining.length === 0 && missingTexts.length === 0 && reuseReady && (!this.registration.reuse || this.deliveredEntry), images_ready: remaining.length === 0, text_ready: missingTexts.length === 0 && (!this.registration.reuse || this.deliveredEntry),
      required_texts: texts.length, delivered_texts: texts.length - missingTexts.length, remaining_texts: missingTexts.length,
      required_text_bytes: texts.reduce((sum, target) => sum + target.utf8_bytes!, 0),
      delivered_text_bytes: texts.reduce((sum, target) => sum + this.coverage.bytes(target.target_id), 0), next_required_read: nextRequiredRead,
      required_images: required.length, delivered_images: required.length - remaining.length,
      remaining_images: remaining.length, next_actions: next };
  }
  bootstrapManifest(control: ContextBootstrapControl = {}): BrokerToolResult {
    this.assertLive();
    if (!this.registration.startupProtocol) throw contextError("CONTEXT_INVALID", "This plan has no bootstrap manifest");
    const args = { context_id: this.registration.snapshot.context_id, view: "overview" as const };
    if (control.read_state && control.read_state !== "readable") return this.navigator.preflightList(args, this.status(), control);
    const result = this.navigator.list(args, this.status(), control);
    this.consumeControl(result);
    return result;
  }
  markEntryDelivered(): void { this.assertLive(); this.deliveredEntry = true; this.reuseDiagnostics.markEntryDelivered(); }
  openReads(): void {
    this.assertLive();
    if (!this.deliveredEntry) throw contextError("CONTEXT_NOT_READY", "The selected context entry has not been delivered");
    if (this.purpose === "normal" && this.readyStarted === undefined && this.requiredTargets().some(t => !this.delivered.has(t.target_id) && this.registration.deliveryByTarget[t.target_id]?.media_route === "mcp")) {
      this.readyStarted = this.lastProgress = Date.now(); this.scheduleReadiness();
    }
  }
  presentAttachments(): void {
    if (this.requiredTargets().some(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "attachment") && this.attachmentStarted === undefined) {
      this.attachmentStarted = Date.now(); this.scheduleReadiness();
    }
  }
  confirmAttachments(confirmation: ContextAttachmentConfirmation): void {
    this.assertLive();
    if (confirmation.planId !== this.registration.planId || confirmation.manifestDigest !== this.registration.manifestDigest) throw contextError("CONTEXT_INVALID", "Attachment confirmation does not match the selected plan and manifest");
    for (const target of this.requiredTargets()) if (this.registration.deliveryByTarget[target.target_id]?.media_route === "attachment") this.delivered.add(target.target_id);
    this.changed(); this.scheduleReadiness();
  }
  notReady(): BrokerToolResult | undefined {
    this.assertLive();
    const status = this.status();
    return status.context_ready ? undefined : status.reuse_ready === false
      ? contextFailure("CONTEXT_NOT_READY", "The fixed reuse baseline is no longer valid. Stop new work and recover a new complete plan through the original lifecycle; do not resend this plan.", { ...status, recovery_action: "recover_full_plan" })
      : contextFailure("CONTEXT_NOT_READY", "Deliver the required context and confirm required attachments. Use a new operation_id for new work after readiness.", { ...status });
  }
  assertReady(): void {
    const failure = this.notReady();
    if (failure) throw contextError("CONTEXT_NOT_READY", (failure.content[0] as { text: string }).text);
  }
  prepare(method: ContextMethod, args: ContextArgs, overviewControl?: ContextBootstrapControl): ContextPreparedReply {
    return withTokenEstimateCache(() => this.prepareReply(method, args, overviewControl));
  }
  private prepareReply(method: ContextMethod, args: ContextArgs, overviewControl?: ContextBootstrapControl): ContextPreparedReply {
    this.openReads();
    if (this.budgetStopped || this.navigator.usage().navigation_stopped) throw contextError("CONTEXT_NAVIGATION_STOPPED", "This scope's navigation capability is retired. Use its original completion path");
    if (this.pending.size >= 8) throw contextError("CONTEXT_BUSY", "Wait for the in-flight context returns");
    if (args.context_id !== this.registration.snapshot.context_id) throw contextError("CONTEXT_INVALID", "Context access is invalid or no longer active");
    const inputReads = method === "read" && Array.isArray((args as ContextReadArgs).reads) ? (args as ContextReadArgs).reads : [];
    const targets = inputReads.flatMap(read => {
      const target = read && this.registration.snapshot.getTargetByReadRef(read.read_ref);
      return target ? [target] : [];
    });
    const target = targets.length === 1 ? targets[0] : undefined;
    // One return buffer protects an undelivered required page if its transport fails.
    // Parallel on-demand navigation still has to leave this buffer and all holes intact.
    const requiredPending = this.registration.startupProtocol
      && [...this.pending.values()].some(pending => pending.targetIds.some(id => this.registration.deliveryByTarget[id]?.required));
    if (requiredPending) {
      const remaining = this.remainingBudget(), limits = contextLimits(this.registration.limits);
      // Generation has paid for this return, but its full unit stays protected until
      // settlement. If recovery is exhausted, even an error may temporarily not fit.
      // Use the existing transient gate; successful settlement can restore capacity.
      if (targets.some(target => this.registration.deliveryByTarget[target.target_id]?.required)
        || remaining.tokens - (remaining.reserved_tokens ?? 0) < limits.errorResponseTokens
        || remaining.wire_bytes - (remaining.reserved_wire_bytes ?? 0) < limits.errorResponseBytes) {
        throw contextError("CONTEXT_BUSY", "Wait for the in-flight required context return");
      }
    }
    // The first return has already paid its budgets, but only its successful receipt
    // contributes coverage. A parallel duplicate must not spend its delivery reserve.
    if (targets.some(target => (target.kind === "image" || this.registration.deliveryByTarget[target.target_id]?.required)
      && this.hasPendingTarget(target.target_id))) throw contextError("CONTEXT_BUSY", "Wait for this source's in-flight return before reading it again");
    const status = method === "list" ? this.status() : undefined;
    let result: BrokerToolResult;
    try {
      result = method === "list" ? this.navigator.list(args as ContextListArgs, status, overviewControl)
        : method === "read" ? this.navigator.read(args as ContextReadArgs)
        : this.navigator.search(args as ContextSearchArgs);
    } catch (error) {
      if (error instanceof ContextNavigationStoppedError) throw contextError(error.code, "This scope's navigation capability is retired. Stop reading and use its original completion path");
      throw error;
    }
    const image = result.content.find(block => !!block && typeof block === "object" && (block as { type?: unknown }).type === "image") as { data?: unknown; mimeType?: unknown } | undefined;
    const validImage = !result.isError && target?.kind === "image" && typeof image?.data === "string" && image.mimeType === target.mime_type
      && Buffer.from(image.data, "base64").byteLength === target.image_bytes
      && createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") === target.content_digest;
    if (target?.kind === "image" && !result.isError && !validImage) {
      this.permanentFailure = true; throw contextError("CONTEXT_IMAGE_UNAVAILABLE", "The fixed image return is invalid");
    }
    let textRead: ContextTextReadReceipt | undefined;
    let batchIndex: number | undefined;
    if (method === "read" && !image && !result.isError) {
      try {
        const { metadata, bodies } = parseContextTextReadResult(result);
        if (metadata.context_id !== this.registration.snapshot.context_id || metadata.purpose !== this.purpose
          || metadata.items.length > inputReads.length) throw new Error("Mismatched fixed text batch");
        for (const [index, item] of metadata.items.entries()) {
          const fixed = this.registration.snapshot.getTargetByReadRef(item.read_ref);
          if (!fixed || fixed.kind === "image" || item.read_ref !== inputReads[index]?.read_ref
            || item.utf8_bytes !== fixed.utf8_bytes || item.kind !== fixed.kind
            || item.encoding !== fixed.encoding || item.content_digest !== fixed.content_digest
            || item.source_completeness !== fixed.source_completeness
            || item.required !== (this.purpose === "normal" && this.registration.deliveryByTarget[fixed.target_id]?.required === true)
            || deterministicContextJson(item.locator) !== deterministicContextJson(fixed.locator)
            || deterministicContextJson(item.source) !== deterministicContextJson({
              source_id: fixed.source_id, source_index: fixed.source_index, target_id: fixed.target_id, target_index: fixed.target_index,
              source_kind: fixed.source_kind, original_role: fixed.original_role, origin: fixed.origin, provenance: fixed.provenance,
              ...(fixed.author !== undefined ? { author: fixed.author } : {}), ...(fixed.recipient !== undefined ? { recipient: fixed.recipient } : {}),
            })
            || bodies[index] !== Buffer.from(this.registration.snapshot.getText(item.read_ref)!, "utf8")
              .subarray(item.range.start, item.range.end_exclusive).toString("utf8")) throw new Error("Mismatched fixed batch item");
        }
        if (metadata.required_step) {
          batchIndex = metadata.required_step.index;
          if (metadata.required_step.plan_id !== this.registration.planId || !this.textBatches[batchIndex]
            || deterministicContextJson(args) !== deterministicContextJson(this.navigator.requiredReadArgs(batchIndex))) {
            throw new Error("Mismatched fixed required step");
          }
        }
        textRead = contextTextReadReceipt(result);
      } catch {
        this.permanentFailure = true;
        throw contextError("CONTEXT_SOURCE_UNAVAILABLE", "The fixed text return has an invalid batch shape");
      }
    }
    if (validImage && this.purpose === "normal" && this.registration.deliveryByTarget[target!.target_id]?.required
      && !this.generatedRequiredImages.has(target!.target_id)) {
      this.generatedRequiredImages.add(target!.target_id);
      const reserved = this.registration.requiredImageTokenReserves?.[target!.target_id] ?? 0;
      const limits = contextLimits(this.registration.limits);
      const cost = measureContextResponse(result, { visualTokens: target!.visual_token_reserve ?? 0,
        tokenReserve: limits.tokenReserve, wireReserveBytes: limits.wireReserveBytes });
      this.reservedTokensUsed += Math.min(reserved, cost.total_tokens);
    }
    if (batchIndex !== undefined && !this.generatedRequiredBatches.has(batchIndex)) {
      this.generatedRequiredBatches.add(batchIndex);
      const cost = measureContextResponse(result, contextLimits(this.registration.limits));
      this.reservedTokensUsed += Math.min(this.textBatches[batchIndex]!.tokens, cost.total_tokens);
    }
    this.consumeControl(result);
    if (result.isError) {
      const body = result.structuredContent as { code?: unknown; error?: { code?: unknown } } | undefined;
      const code = body?.error?.code ?? body?.code ?? (result.content[0] as { text?: unknown } | undefined)?.text;
      // Parameter/cursor and remaining-budget errors remain correctable. Immutable source loss is permanent.
      if (this.purpose === "normal" && target && !this.delivered.has(target.target_id) && this.registration.deliveryByTarget[target.target_id]?.required && this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp" && ["IMAGE_UNAVAILABLE", "BUDGET_EXCEEDED", "PROCESSING_BUDGET_EXCEEDED"].includes(String(code))) this.fail(contextError("CONTEXT_IMAGE_UNAVAILABLE", "A required image cannot be delivered within the remaining budget"));
      if (code === "PROCESSING_BUDGET_EXCEEDED") this.permanentFailure = true;
      if (["IMAGE_UNAVAILABLE", "CONTEXT_IMAGE_UNAVAILABLE", "CONTEXT_SOURCE_UNAVAILABLE", "CONTEXT_RETIRED", "CONTEXT_EXPIRED"].includes(String(code))) this.permanentFailure = true;
    }
    const receiptId = `context_return_${randomBytes(24).toString("base64url")}`;
    const stopTimer = this.returnTimer(() => this.finish(receiptId, false));
    const canonicalBatch = batchIndex === undefined ? undefined : this.textBatches[batchIndex];
    const replay = canonicalBatch !== undefined && this.batchCovered(canonicalBatch);
    const requiredImage = validImage && this.purpose === "normal" && this.registration.deliveryByTarget[target!.target_id]?.required
      && !this.delivered.has(target!.target_id);
    const cost = !result.isError && (canonicalBatch || requiredImage) ? measureContextResponse(result, {
      ...contextLimits(this.registration.limits), visualTokens: target?.visual_token_reserve ?? 0 }) : undefined;
    const recovery = this.recoveryAvailable();
    const claim = cost ? { tokens: Math.min(cost.total_tokens, recovery.tokens), wire_bytes: Math.min(cost.wire_bytes, recovery.wire_bytes) } : undefined;
    if (replay && claim) {
      // Generation spends the replay allowance once, even if this return later fails.
      this.recoverySpent.tokens += claim.tokens;
      this.recoverySpent.wire_bytes += claim.wire_bytes;
    }
    this.pending.set(receiptId, { targetIds: textRead ? textRead.items.map(item => item.target_id) : validImage ? [target!.target_id] : [], method,
      manifestOrder: !result.isError && method === "list" && (args as ContextListArgs).view === "overview" ? this.manifestSequence++ : undefined,
      successful: !result.isError, observedCost: measureContextResponse(result, { wireReserveBytes: 0, tokenReserve: 0 }), textRead,
      requestedItems: method === "read" ? inputReads.length : undefined,
      ...(cost ? { requiredCost: { tokens: cost.total_tokens, wire_bytes: cost.wire_bytes },
        ...(replay ? { replayCharged: true } : { recoveryClaim: claim }) } : {}), stopTimer });
    this.changed();
    return { result, receiptId };
  }
  finish(receiptId: string, sent: boolean, textRead?: ContextTextReadReceipt): ContextSuccessfulReturn | undefined {
    const pending = this.pending.get(receiptId);
    if (!pending) return;
    const beforeFirstWork = this.firstWorkReturns?.delete(receiptId) ?? false;
    pending.stopTimer(); this.pending.delete(receiptId);
    const successful = sent && this.isLive && pending.successful && (!pending.textRead || contextTextReadReceiptsEqual(pending.textRead, textRead));
    let textBytes = 0, uniqueBytes = 0, reusedBytes = 0;
    if (successful) {
      if (pending.textRead) {
        // All item identities, byte ranges and the entire result digest have passed
        // before any coverage is committed. This synchronous loop is one transaction.
        for (const item of pending.textRead.items) {
          const before = this.coverage.bytes(item.target_id);
          this.coverage.add(item.target_id, item.range);
          const bytes = item.range.end_exclusive - item.range.start;
          textBytes += bytes; uniqueBytes += this.coverage.bytes(item.target_id) - before;
          if (this.registration.reuse?.units.some(unit => unit.delivery === "reuse" && unit.target_id === item.target_id)) reusedBytes += bytes;
        }
      } else for (const targetId of pending.targetIds) if (!this.delivered.has(targetId)) {
        this.delivered.add(targetId); this.lastProgress = Date.now();
      }
    } else if (pending.requiredCost && !pending.replayCharged) {
      this.recoverySpent.tokens += pending.requiredCost.tokens;
      this.recoverySpent.wire_bytes += pending.requiredCost.wire_bytes;
    }
    if (!successful && pending.requiredCost && this.isLive) {
      const remaining = this.remainingBudget();
      if (remaining.tokens < (remaining.reserved_tokens ?? 0) || remaining.wire_bytes < (remaining.reserved_wire_bytes ?? 0)) {
        this.budgetStopped = true;
      }
    }
    if (sent && this.isLive) this.reuseDiagnostics.sent({ wireBytes: pending.observedCost.wire_bytes,
      tokens: pending.observedCost.total_tokens, successful: successful, method: pending.method, manifestOrder: pending.manifestOrder,
      requestedItems: pending.requestedItems, returnedItems: successful ? pending.textRead?.items.length : undefined,
      ...(successful && pending.textRead ? { textBytes, uniqueBytes, reusedBytes, reusedSource: reusedBytes > 0 } : {}) }, beforeFirstWork);
    this.changed(); this.scheduleReadiness();
    return successful
      ? { method: pending.method, ...(pending.textRead ? { textRead: pending.textRead } : {}) } : undefined;
  }
  guardCommit(): void {
    this.assertLive();
    if (!this.deliveredEntry) throw contextError("CONTEXT_NOT_READY", "The compaction source entry has not been delivered");
    if (this.permanentFailure) throw contextError("CONTEXT_SOURCE_UNAVAILABLE", "The compaction source has a permanent read failure");
    if (this.pending.size) throw contextError("CONTEXT_BUSY", "Wait for in-flight context reads before submitting");
    const budget = this.effectiveBudget;
    const used = this.navigator.usage();
    if (budget.tokens - used.text_tokens - used.visual_token_reserve < (budget.reserved_tokens ?? 0)
      || budget.wire_bytes! - used.wire_bytes < (budget.reserved_wire_bytes ?? 0)) throw contextError("BUDGET_EXCEEDED", "The summary and submission reserve is exhausted");
  }
  retire(): void {
    this.live = false; this.navigator.retire();
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    for (const pending of this.pending.values()) pending.stopTimer();
    this.pending.clear(); this.changed();
  }
  private returnTimer(finish: () => void): () => void {
    if (this.purpose === "compaction") return new CompactionDeadline(Date.now() + CONTEXT_RETURN_TIMEOUT_MS).watch(finish);
    const timer = setTimeout(finish, CONTEXT_RETURN_TIMEOUT_MS); timer.unref?.();
    return () => clearTimeout(timer);
  }
  private assertLive(): void {
    if (!this.isLive) throw contextError("CONTEXT_RETIRED", "Context access is invalid or no longer active");
  }
  private scheduleReadiness(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    if (!this.live || this.purpose !== "normal") return;
    const missing = this.requiredTargets().filter(t => !this.delivered.has(t.target_id));
    const deadlines: number[] = [];
    if (this.readyStarted !== undefined && missing.some(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "mcp")) deadlines.push(this.readyStarted + CONTEXT_READY_TIMEOUT_MS, this.lastProgress! + CONTEXT_PROGRESS_TIMEOUT_MS);
    if (this.attachmentStarted !== undefined && missing.some(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "attachment")) deadlines.push(this.attachmentStarted + CONTEXT_ATTACHMENT_TIMEOUT_MS);
    if (!deadlines.length) return;
    this.readinessTimer = setTimeout(() => this.fail(contextError("CONTEXT_NOT_READY", "Required image delivery exceeded its bounded readiness deadline")), Math.max(1, Math.min(...deadlines) - Date.now()));
    this.readinessTimer.unref?.();
  }
}
