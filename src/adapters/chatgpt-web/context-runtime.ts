import { ContextReuseDiagnostics } from "./context-reuse-diagnostics";
import { createHash, randomBytes } from "node:crypto";
import { ContextNavigator, ContextNavigationStoppedError, type ContextNavigationUsage } from "./context-navigator";
import type { ContextSnapshot } from "./context-snapshot";
import { assertContextNavigationBudget, contextLimits, measureContextResponse, type ContextLimitOverrides } from "./context-budget";
import type { ContextDelivery, ContextListArgs, ContextReadArgs, ContextSearchArgs, ContextRemainingBudget, ContextBootstrapControl, ContextRequiredRead, ContextTextPageCost, ContextTarget } from "./context-types";
import type { BrokerToolResult } from "./turn-broker";
import { NativeOperationError } from "./native-tool-operations";
import { contextTextReadReceipt, contextTextReadReceiptsEqual, parseContextTextReadResult, type ContextTextReadReceipt } from "./context-text-result";
import { ContextTextCoverage } from "./context-text-coverage";

import { CONTEXT_REUSE_PROTOCOL, type ContextReusePlan, type ContextReuseDeliveryEvidence } from "./context-reuse-types";
import { boundedContextReuse } from "./context-reuse-lifecycle";

export const CONTEXT_PROTOCOL_VERSION = 3;
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
  requiredImageTokenReserves?: Readonly<Record<string, number>>;
  requiredImageWireReserves?: Readonly<Record<string, number>>;
  requiredTextPageCosts?: Readonly<Record<string, readonly ContextTextPageCost[]>>;
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
  private readonly generatedRequiredTextPages = new Set<ContextTextPageCost>();
  private readonly coverage = new ContextTextCoverage();
  private readonly reuseDiagnostics = new ContextReuseDiagnostics();
  private manifestSequence = 0;
  private firstWorkReturns?: Set<string>;
  private readonly textPageCosts: Readonly<Record<string, readonly ContextTextPageCost[]>>;
  private readonly retryReserve: { tokens: number; wire_bytes: number };
  private readonly failedRequiredCost = { tokens: 0, wire_bytes: 0 };
  private reservedTokensUsed = 0;
  private readonly pending = new Map<string, { targetId?: string; manifestOrder?: number; method: ContextMethod; successful: boolean; observedCost: { wire_bytes: number; total_tokens: number }; textRead?: ContextTextReadReceipt; requiredCost?: { tokens: number; wire_bytes: number }; timer: ReturnType<typeof setTimeout> }>();
  private live = true;
  private deliveredEntry = false;
  private permanentFailure = false;
  private readonly effectiveBudget: ContextRemainingBudget;
  private readyStarted?: number;
  private lastProgress?: number;
  private attachmentStarted?: number;
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
    this.effectiveBudget = { tokens: supplied?.tokens ?? limits.maxTotalTokens,
      reserved_tokens: supplied?.reserved_tokens ?? 0,
      wire_bytes: supplied?.wire_bytes ?? limits.maxTotalWireBytes,
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
    const pageCosts: Record<string, readonly ContextTextPageCost[]> = {};
    const preflight = new ContextNavigator({ scopeId, snapshot: registration.snapshot, purpose, limits: registration.limits,
      ...(registration.startupProtocol ? { bootstrap: { planId: registration.planId, manifestDigest: registration.manifestDigest, ...(registration.reuse ? { reuse: registration.reuse } : {}) } } : {}) });
    for (const target of this.requiredTextTargets()) {
      let pages = registration.requiredTextPageCosts?.[target.target_id];
      if (!pages) {
        const measured: ContextTextPageCost[] = [];
        let cursor: string | undefined;
        do {
          const result = preflight.preflightRead({ context_id: registration.snapshot.context_id, read_ref: target.read_ref!, ...(cursor ? { cursor } : {}) });
          if (result.isError) throw contextError("BUDGET_EXCEEDED", "A required text page cannot fit the context return limits");
          const { metadata } = parseContextTextReadResult(result);
          const cost = measureContextResponse(result, { ...limits, boundCursorTokens: true });
          measured.push({ ...metadata.range, tokens: cost.total_tokens, wire_bytes: cost.wire_bytes });
          cursor = metadata.next_cursor ?? undefined;
        } while (cursor);
        pages = measured;
      }
      let end = 0;
      for (const page of pages) {
        if ([page.start, page.end_exclusive, page.tokens, page.wire_bytes].some(n => !Number.isSafeInteger(n) || n < 0)
          || page.start !== end || page.end_exclusive < page.start || page.end_exclusive === page.start && target.utf8_bytes !== 0
          || page.tokens < limits.tokenReserve || page.wire_bytes < limits.wireReserveBytes) throw contextError("CONTEXT_INVALID", "Invalid required text page budget");
        end = page.end_exclusive;
      }
      if (!pages.length || target.utf8_bytes === 0 && pages.length !== 1 || end !== target.utf8_bytes) throw contextError("CONTEXT_INVALID", "Required text page budgets do not cover the fixed source");
      pageCosts[target.target_id] = pages.map(page => ({ ...page }));
    }
    this.textPageCosts = pageCosts;
    const requiredMcpImages = this.requiredTargets().filter(t => registration.deliveryByTarget[t.target_id]?.media_route === "mcp");
    const minimumRetry = {
      tokens: Math.max(0, ...Object.values(pageCosts).flatMap(pages => pages.map(page => page.tokens)), ...requiredMcpImages.map(target =>
        registration.requiredImageTokenReserves?.[target.target_id] ?? (target.visual_token_reserve ?? 0) + limits.imageMetadataTokens)),
      wire_bytes: Math.max(0, ...Object.values(pageCosts).flatMap(pages => pages.map(page => page.wire_bytes)), ...requiredMcpImages.map(target =>
        registration.requiredImageWireReserves?.[target.target_id] ?? Math.ceil((target.image_bytes ?? 0) / 3) * 4 + 2 * Buffer.byteLength(JSON.stringify(target)) + 1024 + limits.wireReserveBytes)) };
    this.retryReserve = registration.startupProtocol ? registration.requiredReturnRetryReserve ?? minimumRetry : { tokens: 0, wire_bytes: 0 };
    if (Object.entries(this.retryReserve).some(([key, n]) => !Number.isSafeInteger(n) || n < 0
      || registration.startupProtocol && n < minimumRetry[key as keyof typeof minimumRetry])) throw contextError("CONTEXT_INVALID", "Invalid required return retry reserve");
    const remainingBudget = (readingTarget?: ContextTarget, result?: BrokerToolResult): ContextRemainingBudget => {
      const used = this.navigator?.usage();
      const budget = this.effectiveBudget;
      const pending = this.requiredTargets().filter(t => !this.delivered.has(t.target_id) && (registration.startupProtocol || !this.hasPendingImage(t.target_id)) && t.target_id !== readingTarget?.target_id
        && registration.deliveryByTarget[t.target_id]?.media_route === "mcp");
      const readingRange = readingTarget && result && !result.isError && readingTarget.kind !== "image" ? parseContextTextReadResult(result).metadata.range : undefined;
      let textTokens = 0, textWire = 0;
      for (const [targetId, pages] of Object.entries(this.textPageCosts)) for (const page of pages) {
        if (!this.coverage.contains(targetId, page.start, page.end_exclusive, targetId === readingTarget?.target_id ? readingRange : undefined)) {
          textTokens += page.tokens; textWire += page.wire_bytes;
        }
      }
      const inFlightCosts = [...this.pending.values()].reduce((sum, item) => ({ tokens: sum.tokens + (item.requiredCost?.tokens ?? 0),
        wire_bytes: sum.wire_bytes + (item.requiredCost?.wire_bytes ?? 0) }), { tokens: 0, wire_bytes: 0 });
      const unfinished = this.requiredTargets().some(target => !this.delivered.has(target.target_id))
        || this.requiredTextTargets().some(target => !this.coverage.contains(target.target_id, 0, target.utf8_bytes!));
      const retryTokens = unfinished ? Math.max(0, this.retryReserve.tokens - this.failedRequiredCost.tokens - inFlightCosts.tokens) : 0;
      const retryWire = unfinished ? Math.max(0, this.retryReserve.wire_bytes - this.failedRequiredCost.wire_bytes - inFlightCosts.wire_bytes) : 0;
      // Planner supplies exact complete-response costs. Trusted callers which omit the
      // maps get conservative metadata allowances, never a zero-byte media reserve.
      const imageWireReserve = (target: import("./context-types").ContextTarget) => registration.requiredImageWireReserves?.[target.target_id]
        ?? Math.ceil((target.image_bytes ?? 0) / 3) * 4 + 2 * Buffer.byteLength(JSON.stringify(target)) + 1024 + limits.wireReserveBytes;
      const spentTokens = (used?.text_tokens ?? 0) + (used?.visual_token_reserve ?? 0);
      const spentWire = used?.wire_bytes ?? 0;
      // Apply both remaining capacities to required media. Add the shared-only
      // work reserve back to the local ceiling before subtracting it below.
      return { tokens: Math.max(0, Math.min(budget.tokens - spentTokens,
          limits.maxTotalTokens - spentTokens + (budget.reserved_tokens ?? 0))),
        reserved_tokens: (budget.reserved_tokens ?? 0) + textTokens + retryTokens + pending.reduce((sum, target) => sum +
          (registration.requiredImageTokenReserves?.[target.target_id] ?? (target.visual_token_reserve ?? 0) + limits.imageMetadataTokens), 0),
        wire_bytes: Math.max(0, Math.min(budget.wire_bytes - spentWire,
          limits.maxTotalWireBytes - spentWire + (budget.reserved_wire_bytes ?? 0))),
        reserved_wire_bytes: (budget.reserved_wire_bytes ?? 0) + textWire + retryWire + pending.reduce((sum, target) => sum + imageWireReserve(target), 0),
        image_reads: Math.max(0, limits.maxImageReads - (used?.image_reads ?? 0)), reserved_image_reads: pending.length,
        image_bytes: Math.max(0, limits.maxTotalImageBytes - (used?.image_bytes ?? 0)),
        reserved_image_bytes: pending.reduce((sum, target) => sum + (target.image_bytes ?? 0), 0) };
    };
    try {
      const initial = remainingBudget();
      assertContextNavigationBudget(initial, limits);
      // The local navigation cap counts only navigation. Model work/summary reserves
      // belong to the shared capacity and must not be charged against this cap twice.
      assertContextNavigationBudget({ tokens: limits.maxTotalTokens, wire_bytes: limits.maxTotalWireBytes,
        reserved_tokens: initial.reserved_tokens! - (this.effectiveBudget.reserved_tokens ?? 0),
        reserved_wire_bytes: initial.reserved_wire_bytes! - (this.effectiveBudget.reserved_wire_bytes ?? 0) }, limits);
    }
    catch { throw contextError("BUDGET_EXCEEDED", "The context budget cannot protect required sources, completion and bounded corrective replies"); }
    this.navigator = new ContextNavigator({ scopeId, snapshot: registration.snapshot, purpose,
      deliveryByTarget: registration.deliveryByTarget, limits: registration.limits, remainingBudget,
      ...(registration.startupProtocol ? { bootstrap: { planId: registration.planId, manifestDigest: registration.manifestDigest, ...(registration.reuse ? { reuse: registration.reuse } : {}) } } : {}) });
  }

  assertPending(receiptId: string, textRead?: ContextTextReadReceipt): void {
    this.assertLive();
    const pending = this.pending.get(receiptId);
    if (!pending) throw contextError("CONTEXT_RETIRED", "The context return is no longer active");
    if (pending.textRead && !contextTextReadReceiptsEqual(pending.textRead, textRead)) throw contextError("CONTEXT_INVALID", "The transported text result does not match the fixed v2 page");
  }
  get inFlight(): number { return this.pending.size; }
  get isLive(): boolean { return this.live && (this.expiresAt === undefined || Date.now() < this.expiresAt); }
  usageEvidence(final = false): ContextUsageEvidence {
    const reuseDelivery = this.reuseDeliveryEvidence();
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      purpose: this.purpose, usage: this.navigator.usage(), reserved_tokens_used: this.reservedTokensUsed, final,
      ...(this.registration.reuse ? { reuse_diagnostics: this.reuseDiagnostics.snapshot() } : {}),
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
    const timer = setTimeout(() => this.finish(receiptId, false), CONTEXT_RETURN_TIMEOUT_MS); timer.unref?.();
    this.pending.set(receiptId, { manifestOrder: this.manifestSequence++, method: "list", successful: true,
      observedCost: measureContextResponse(result, { wireReserveBytes: 0, tokenReserve: 0 }), timer });
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
  private hasPendingImage(targetId: string): boolean { return [...this.pending.values()].some(pending => pending.targetId === targetId); }
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
    const text = missingTexts[0];
    const nextRequiredRead: ContextRequiredRead | null = image ? { tool: "codex_context_read", arguments: {
      context_id: this.registration.snapshot.context_id, read_ref: image.read_ref! } } : text ? {
      tool: "codex_context_read", arguments: this.navigator.readArgsAt(text.target_id, this.coverage.firstGap(text.target_id)) } : null;
    const reuseReady = this.reuseValid();
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      ...(this.registration.reuse ? { reuse_ready: reuseReady, ...(!reuseReady ? { reuse_failure: "baseline_invalid" } : {}) } : {}),
      context_ready: remaining.length === 0 && missingTexts.length === 0 && reuseReady && (!this.registration.reuse || this.deliveredEntry), images_ready: remaining.length === 0, text_ready: missingTexts.length === 0 && (!this.registration.reuse || this.deliveredEntry),
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
    return control.read_state && control.read_state !== "readable" ? this.navigator.preflightList(args, this.status(), control)
      : this.navigator.list(args, this.status(), control);
  }
  markEntryDelivered(): void { this.assertLive(); this.deliveredEntry = true; }
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
    this.openReads();
    if (this.navigator.usage().navigation_stopped) throw contextError("CONTEXT_NAVIGATION_STOPPED", "This scope's navigation capability is retired. Use its original completion path");
    if (this.pending.size >= 8) throw contextError("CONTEXT_BUSY", "Wait for the in-flight context returns");
    if (args.context_id !== this.registration.snapshot.context_id) throw contextError("CONTEXT_INVALID", "Context access is invalid or no longer active");
    const target = method === "read" ? this.registration.snapshot.targets.find(t => t.read_ref === (args as ContextReadArgs).read_ref) : undefined;
    // One return buffer protects an undelivered required page if its transport fails.
    // Parallel on-demand navigation still has to leave this buffer and all holes intact.
    if (this.registration.startupProtocol && target && this.registration.deliveryByTarget[target.target_id]?.required
      && [...this.pending.values()].some(pending => pending.requiredCost)) throw contextError("CONTEXT_BUSY", "Wait for the in-flight required context return");
    // The first return has already paid its budgets, but only its successful receipt
    // contributes coverage. A parallel duplicate must not spend its delivery reserve.
    if (target && (target.kind === "image" || this.registration.deliveryByTarget[target.target_id]?.required)
      && this.hasPendingImage(target.target_id)) throw contextError("CONTEXT_BUSY", "Wait for this source's in-flight return before reading it again");
    const status = this.status();
    let result: BrokerToolResult;
    try {
      result = method === "list" ? this.navigator.list(args as ContextListArgs, status, overviewControl)
        : method === "read" ? this.navigator.read(args as ContextReadArgs, status)
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
    if (method === "read" && target?.kind !== "image" && !result.isError) {
      try {
        const { metadata } = parseContextTextReadResult(result);
        if (!target || metadata.context_id !== this.registration.snapshot.context_id || metadata.purpose !== this.purpose
          || metadata.read_ref !== target.read_ref || metadata.utf8_bytes !== target.utf8_bytes
          || metadata.source.target_id !== target.target_id || metadata.source.source_id !== target.source_id) throw new Error("Mismatched fixed text page");
        textRead = contextTextReadReceipt(result);
      } catch {
        this.permanentFailure = true;
        throw contextError("CONTEXT_SOURCE_UNAVAILABLE", "The fixed text return has an invalid v2 shape");
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
    if (textRead && target) {
      const page = this.textPageCosts[target.target_id]?.find(page => page.start === textRead.range.start
        && page.end_exclusive === textRead.range.end_exclusive);
      if (page && !this.generatedRequiredTextPages.has(page)) {
        // Usage is charged when a return is generated, even if its transport fails.
        // Credit each planned page once; retries and other ranges cost extra. Only
        // the successful receipt below can advance delivery coverage.
        this.generatedRequiredTextPages.add(page);
        const cost = measureContextResponse(result, contextLimits(this.registration.limits));
        this.reservedTokensUsed += Math.min(page.tokens, cost.total_tokens);
      }
    }
    if (result.isError) {
      const body = result.structuredContent as { code?: unknown; error?: { code?: unknown } } | undefined;
      const code = body?.error?.code ?? body?.code ?? (result.content[0] as { text?: unknown } | undefined)?.text;
      // Parameter/cursor and remaining-budget errors remain correctable. Immutable source loss is permanent.
      if (this.purpose === "normal" && target && !this.delivered.has(target.target_id) && this.registration.deliveryByTarget[target.target_id]?.required && this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp" && ["IMAGE_UNAVAILABLE", "BUDGET_EXCEEDED", "PROCESSING_BUDGET_EXCEEDED"].includes(String(code))) this.fail(contextError("CONTEXT_IMAGE_UNAVAILABLE", "A required image cannot be delivered within the remaining budget"));
      if (target && code === "INVALID_REFERENCE" || code === "PROCESSING_BUDGET_EXCEEDED") this.permanentFailure = true;
      if (["IMAGE_UNAVAILABLE", "CONTEXT_IMAGE_UNAVAILABLE", "CONTEXT_SOURCE_UNAVAILABLE", "CONTEXT_RETIRED", "CONTEXT_EXPIRED"].includes(String(code))) this.permanentFailure = true;
    }
    const receiptId = `context_return_${randomBytes(24).toString("base64url")}`;
    const timer = setTimeout(() => this.finish(receiptId, false), CONTEXT_RETURN_TIMEOUT_MS); timer.unref?.();
    const required = target && this.purpose === "normal" && this.registration.deliveryByTarget[target.target_id]?.required
      && (target.kind === "image" ? !this.delivered.has(target.target_id) : !this.coverage.contains(target.target_id, 0, target.utf8_bytes!));
    const cost = required && !result.isError ? measureContextResponse(result, { ...contextLimits(this.registration.limits),
      visualTokens: target?.visual_token_reserve ?? 0 }) : undefined;
    this.pending.set(receiptId, { ...(validImage || textRead ? { targetId: target!.target_id } : {}), method,
      manifestOrder: !result.isError && method === "list" && (args as ContextListArgs).view === "overview" ? this.manifestSequence++ : undefined, successful: !result.isError,
      observedCost: measureContextResponse(result, { wireReserveBytes: 0, tokenReserve: 0 }), textRead,
      ...(cost ? { requiredCost: { tokens: cost.total_tokens, wire_bytes: cost.wire_bytes } } : {}), timer });
    this.changed();
    return { result, receiptId };
  }
  finish(receiptId: string, sent: boolean, textRead?: ContextTextReadReceipt): ContextSuccessfulReturn | undefined {
    const pending = this.pending.get(receiptId);
    if (!pending) return;
    const beforeFirstWork = this.firstWorkReturns?.delete(receiptId) ?? false;
    clearTimeout(pending.timer); this.pending.delete(receiptId);
    const successful = sent && this.isLive && pending.successful && (!pending.textRead || contextTextReadReceiptsEqual(pending.textRead, textRead));
    const beforeBytes = pending.targetId ? this.coverage.bytes(pending.targetId) : 0;
    if (successful && pending.targetId) {
      if (pending.textRead) this.coverage.add(pending.targetId, pending.textRead.range);
      else if (!this.delivered.has(pending.targetId)) { this.delivered.add(pending.targetId); this.lastProgress = Date.now(); }
    } else if (pending.requiredCost) {
      this.failedRequiredCost.tokens += pending.requiredCost.tokens;
      this.failedRequiredCost.wire_bytes += pending.requiredCost.wire_bytes;
    }
    if (sent && this.isLive) this.reuseDiagnostics.sent({ wireBytes: pending.observedCost.wire_bytes,
      tokens: pending.observedCost.total_tokens, successful: pending.successful, method: pending.method, manifestOrder: pending.manifestOrder,
      ...(successful && pending.textRead ? { textBytes: pending.textRead.range.end_exclusive - pending.textRead.range.start,
        uniqueBytes: this.coverage.bytes(pending.targetId!) - beforeBytes,
        reusedSource: this.registration.reuse?.units.some(unit => unit.delivery === "reuse" && unit.target_id === pending.targetId) } : {}) }, beforeFirstWork);
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
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear(); this.changed();
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
