import { createHash, randomBytes } from "node:crypto";
import { ContextNavigator, ContextNavigationStoppedError, type ContextNavigationUsage } from "./context-navigator";
import type { ContextSnapshot } from "./context-snapshot";
import { assertContextNavigationBudget, contextLimits, measureContextResponse, type ContextLimitOverrides } from "./context-budget";
import type { ContextDelivery, ContextListArgs, ContextReadArgs, ContextSearchArgs, ContextRemainingBudget } from "./context-types";
import type { BrokerToolResult } from "./turn-broker";
import { NativeOperationError } from "./native-tool-operations";
import { contextTextReadReceipt, contextTextReadReceiptsEqual, parseContextTextReadResult, type ContextTextReadReceipt } from "./context-text-result";

export const CONTEXT_PROTOCOL_VERSION = 2;
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
  limits?: ContextLimitOverrides;
  requiredImageTokenReserves?: Readonly<Record<string, number>>;
  requiredImageWireReserves?: Readonly<Record<string, number>>;
  remainingBudget?: ContextRemainingBudget;
}
export interface ContextAttachmentConfirmation { planId: string; manifestDigest: string }
export interface ContextStatus {
  context_id: string;
  plan_id: string;
  context_ready: boolean;
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
  private reservedTokensUsed = 0;
  private readonly pending = new Map<string, { targetId?: string; method: ContextMethod; successful: boolean; textRead?: ContextTextReadReceipt; timer: ReturnType<typeof setTimeout> }>();
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
  ) {
    identifier(registration.planId); identifier(registration.manifestDigest);
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
      if (!target || (target.kind !== "image" && delivery.required)) throw contextError("CONTEXT_INVALID", "Only source images can be required");
      if (delivery.required && (!(["mcp", "attachment"].includes(delivery.media_route ?? "")) || (delivery.media_route === "mcp" && !target.read_ref))) {
        throw contextError("CONTEXT_IMAGE_UNAVAILABLE", "A required source image cannot be delivered");
      }
    }
    const remainingBudget = (readingTarget?: import("./context-types").ContextTarget): ContextRemainingBudget => {
      const used = this.navigator?.usage();
      const budget = this.effectiveBudget;
      const pending = this.requiredTargets().filter(t => !this.delivered.has(t.target_id) && !this.hasPendingImage(t.target_id) && t.target_id !== readingTarget?.target_id
        && registration.deliveryByTarget[t.target_id]?.media_route === "mcp");
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
        reserved_tokens: (budget.reserved_tokens ?? 0) + pending.reduce((sum, target) => sum +
          (registration.requiredImageTokenReserves?.[target.target_id] ?? (target.visual_token_reserve ?? 0) + limits.imageMetadataTokens), 0),
        wire_bytes: Math.max(0, Math.min(budget.wire_bytes - spentWire,
          limits.maxTotalWireBytes - spentWire + (budget.reserved_wire_bytes ?? 0))),
        reserved_wire_bytes: (budget.reserved_wire_bytes ?? 0) + pending.reduce((sum, target) => sum + imageWireReserve(target), 0),
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
      deliveryByTarget: registration.deliveryByTarget, limits: registration.limits, remainingBudget });
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
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      purpose: this.purpose, usage: this.navigator.usage(), reserved_tokens_used: this.reservedTokensUsed, final };
  }
  private hasPendingImage(targetId: string): boolean { return [...this.pending.values()].some(pending => pending.targetId === targetId); }
  private requiredTargets() {
    return this.purpose === "compaction" ? [] : this.registration.snapshot.targets.filter(t => t.kind === "image" && this.registration.deliveryByTarget[t.target_id]?.required === true);
  }
  status(): ContextStatus {
    const required = this.requiredTargets();
    const remaining = required.filter(t => !this.delivered.has(t.target_id));
    const next: ContextStatus["next_actions"] = [];
    for (const target of remaining) {
      if (this.registration.deliveryByTarget[target.target_id]?.media_route === "mcp" && target.read_ref && next.length < 4) next.push({ read_ref: target.read_ref });
    }
    if (remaining.some(t => this.registration.deliveryByTarget[t.target_id]?.media_route === "attachment")) next.push({ action: "confirm_attachments", manifest_digest: this.registration.manifestDigest });
    return { context_id: this.registration.snapshot.context_id, plan_id: this.registration.planId,
      context_ready: remaining.length === 0, required_images: required.length, delivered_images: required.length - remaining.length,
      remaining_images: remaining.length, next_actions: next };
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
    return status.context_ready ? undefined : contextFailure("CONTEXT_NOT_READY", "Read the remaining images or confirm the selected attachment manifest. Use a new operation_id for new work after readiness.", { ...status });
  }
  assertReady(): void {
    const failure = this.notReady();
    if (failure) throw contextError("CONTEXT_NOT_READY", (failure.content[0] as { text: string }).text);
  }
  prepare(method: ContextMethod, args: ContextArgs): ContextPreparedReply {
    this.openReads();
    if (this.navigator.usage().navigation_stopped) throw contextError("CONTEXT_NAVIGATION_STOPPED", "This scope's navigation capability is retired. Use its original completion path");
    if (this.pending.size >= 8) throw contextError("CONTEXT_BUSY", "Wait for the in-flight context returns");
    if (args.context_id !== this.registration.snapshot.context_id) throw contextError("CONTEXT_INVALID", "Context access is invalid or no longer active");
    const target = method === "read" ? this.registration.snapshot.targets.find(t => t.read_ref === (args as ContextReadArgs).read_ref) : undefined;
    // The first return has already paid its budgets, but only its successful receipt
    // contributes coverage. A parallel duplicate must not spend its delivery reserve.
    if (target?.kind === "image" && this.hasPendingImage(target.target_id)) throw contextError("CONTEXT_BUSY", "Wait for this image's in-flight return before reading it again");
    const status = this.status();
    let result: BrokerToolResult;
    try {
      result = method === "list" ? this.navigator.list(args as ContextListArgs, status)
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
    this.pending.set(receiptId, { ...(validImage ? { targetId: target!.target_id } : {}), method, successful: !result.isError, textRead, timer });
    this.changed();
    return { result, receiptId };
  }
  finish(receiptId: string, sent: boolean, textRead?: ContextTextReadReceipt): ContextSuccessfulReturn | undefined {
    const pending = this.pending.get(receiptId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(receiptId);
    if (sent && this.isLive && pending.targetId && !this.delivered.has(pending.targetId)) {
      this.delivered.add(pending.targetId); this.lastProgress = Date.now();
    }
    this.changed(); this.scheduleReadiness();
    return sent && this.isLive && pending.successful && (!pending.textRead || contextTextReadReceiptsEqual(pending.textRead, textRead))
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
