import { configuredContextBudgetProfile } from "./context-budget";
import type { ContextReuseBaseline } from "./context-reuse-types";
import { randomBytes } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { CompactionSourceCoverage, type CompactionSourcePlan } from "./compaction-context";
import { contextCandidateMessageIndices, contextCandidateRawInputIndices } from "./context-candidate-mapping";
import { planContextDelivery, type ContextDeliveryPlan } from "./context-planner";
import { createContextSnapshot, type ContextSnapshot } from "./context-snapshot";
import type { ChatGptWebCapabilities } from "./model";
import type { CompileChatGptWebPromptOptions } from "./prompt";
import type { BrokerWaitOptions, TurnBrokerOwner } from "./turn-broker";
import type { TaskUpdateOwnerContext } from "./task-update-protocol";
import type { ContextPlanDescriptor } from "./context-prompt";

/** Owns only a new physical send. Replayed HTTP rounds never create this object. */
export class ContextSend {
  private source?: ContextSnapshot;
  private initialSource?: ContextSnapshot;
  private retired = false;
  get snapshot(): ContextSnapshot {
    if (this.retired || !this.source) throw new Error("The physical context send is retired");
    return this.source;
  }
  readonly coverage: CompactionSourceCoverage;
  private readonly plans = new Map<string, ContextDeliveryPlan>();
  private readonly manualPlans = new WeakSet<ContextDeliveryPlan>();
  private selected?: { id: string; token: string; plan: ContextDeliveryPlan };
  private reuseToken?: string;
  private usageBinding?: { id: string; token: string; contextId: string; finalAccounted?: true };
  private usageQueue: Promise<void> = Promise.resolve();
  constructor(private readonly canonical: CodexParsedRequest, private readonly broker: TurnBrokerOwner,
    private readonly capabilities: ChatGptWebCapabilities, private readonly pageGeneration: string,
    coverage?: CompactionSourceCoverage, private readonly ownerContext?: TaskUpdateOwnerContext,
    sourceSnapshot?: ContextSnapshot, private readonly reuseBaseline?: ContextReuseBaseline) {
    this.source = sourceSnapshot ?? createContextSnapshot(canonical, { imageStoragePolicy: "bounded" });
    this.initialSource = this.source;
    this.coverage = coverage?.fork() ?? new CompactionSourceCoverage();
  }
  async prepare(candidate: CodexParsedRequest, token: string, options: CompileChatGptWebPromptOptions,
    retainedTokens = 0): Promise<ContextDeliveryPlan> {
    if (this.retired || !this.initialSource) throw new Error("The physical context send is retired");
    const startedAt = performance.now();
    const contextToolsAvailable = await this.broker.contextToolsAvailable?.() ?? false;
    const bootstrapAvailable = contextToolsAvailable && (await this.broker.contextBootstrapAvailable?.() ?? false);
    const budgetProfile = configuredContextBudgetProfile();
    const reuseAvailable = bootstrapAvailable && (await this.broker.contextReuseAvailable?.() ?? false);
    const baseline = options.retainedContinuity ? this.reuseBaseline : undefined;
    const planInput = { canonical: this.canonical, snapshot: this.initialSource, candidate,
      messageIndices: contextCandidateMessageIndices(this.canonical, candidate), capabilities: this.capabilities,
      rawInputIndices: contextCandidateRawInputIndices(this.canonical, candidate),
      turnToken: token, compileOptions: options, contextToolsAvailable, budgetProfile,
      contextBootstrapAvailable: bootstrapAvailable, contextReuseAvailable: reuseAvailable,
      ...(baseline ? { reuseBaseline: baseline } : {}), budget: { retainedTokens } };
    let plan = planContextDelivery(planInput);
    console.info(`[chatgpt-web] context_reuse_plan ${JSON.stringify({ candidate: options.retainedContinuity ? "resume" : "full", mode: plan.registration?.reuse?.mode ?? "legacy", reason: !reuseAvailable ? "capability_missing" : !baseline ? "baseline_not_supplied" : plan.registration?.reuse?.mode === "incremental" ? "matched" : "content_or_scope_changed" })}`);
    if (plan.registration) {
      if (!this.broker.registerContextPlan || !this.broker.selectContextPlan || !this.broker.markContextPlanSent
        || !this.broker.confirmContextAttachments || !this.broker.contextUsage) throw new Error("Update the Launcher and connector to use context navigation");
      // Remote owners validate the versioned contract before the prompt can leave this process.
      try { await this.broker.registerContextPlan(token, plan.registration, this.ownerContext); }
      catch (error) {
        if (!plan.registration.reuse?.dependency || (error as { code?: string }).code !== "CONTEXT_NOT_READY") throw error;
        // This preparation has not been selected or sent. An evicted or replaced
        // baseline can safely fall back to a new, independently complete candidate.
        plan = planContextDelivery({ ...planInput, reuseBaseline: undefined });
        if (plan.registration) await this.broker.registerContextPlan(token, plan.registration, this.ownerContext);
        console.info('[chatgpt-web] context_reuse_miss {"reason":"baseline_changed_or_evicted","action":"prepare_full"}');
      }
    }
    if (this.retired) throw new Error("The physical context send was cancelled during preparation");
    const costs = plan.costs;
    console.info(`[chatgpt-web] context_prepared ${JSON.stringify({ prepare_ms: performance.now() - startedAt,
      prompt_code_points: costs.promptCodePoints, retained_tokens: costs.retainedTokens, total_tokens: costs.requiredTotalTokens,
      prompt_serialized_bytes: costs.promptJsonBytes, reuse: costs.reuse, selection: costs.selection,
      page_accounting: "cumulative_delivery_estimate",
      context_budget_profile: budgetProfile, context_limits: plan.limits,
      budget: { context_window_tokens: costs.contextWindowTokens, retained_tokens: costs.retainedTokens,
        current_plan_tokens: costs.requiredTotalTokens - costs.retainedTokens - costs.platformReserveTokens,
        prompt_tokens: costs.promptTokens, required_mcp_tokens: costs.requiredMcpTokens,
        attachment_visual_tokens: costs.attachmentVisualTokens, work_reserve_tokens: costs.workReserveTokens,
        platform_reserve_tokens: costs.platformReserveTokens, discovery_reserve_tokens: costs.discoveryReserveTokens,
        error_reserve_tokens: costs.errorReserveTokens, total_tokens: costs.requiredTotalTokens,
        required_navigation_wire_bytes: costs.requiredNavigationWireBytes }, actual_model_input_tokens: null })}`);
    const id = plan.planId ?? `body_${randomBytes(24).toString("base64url")}`;
    this.plans.set(id, plan);
    if (options.manualControl) this.manualPlans.add(plan);
    return plan;
  }
  async select(token: string, planOrId: ContextDeliveryPlan | string): Promise<void> {
    const entry = typeof planOrId === "string" ? [planOrId, this.plans.get(planOrId)] as const
      : [...this.plans].find(([, plan]) => plan === planOrId);
    if (!entry?.[1]) throw new Error("The selected context plan was not prepared for this send");
    const [id, plan] = entry;
    if (this.selected) {
      if (this.selected.id !== id || this.selected.token !== token) throw new Error("The selected context plan cannot change");
      return;
    }
    if (plan.registration) await this.broker.selectContextPlan!(token, id, this.ownerContext);
    else if ([...this.plans.values()].some(candidate => candidate.registration)) {
      if (!this.broker.discardUnselectedContextPlans) throw new Error("Update the Launcher to select this delivery plan");
      await this.broker.discardUnselectedContextPlans(token, this.ownerContext);
    }
    this.coverage.prepare(plan.snapshot, this.sourcePlan(id, plan));
    this.source = plan.snapshot;
    this.selected = { id, token, plan };
    if (plan.registration?.reuse) this.reuseToken = token;
    console.info(`[chatgpt-web] context_plan_selected ${JSON.stringify({ mode: plan.registration?.reuse?.mode ?? "legacy", retained: plan.costs.retainedTokens > 0 })}`);
    if (plan.registration) this.usageBinding = { id, token, contextId: plan.snapshot.context_id };
  }
  private sourcePlan(id: string, plan: ContextDeliveryPlan): CompactionSourcePlan {
    const routes = plan.registration?.deliveryByTarget ?? {};
    // Prepay required source returns, which runtime usage credits once each.
    // Discovery, errors and retries enter this retained-page ledger through actual
    // usage. Their full admission reserves remain in the planner and active scope.
    const navigationReserve = plan.costs.requiredMcpTokens;
    return { historyRevision: this.canonical._continuityHistoryRevision ?? 0,
      pageGeneration: this.pageGeneration, planId: id, bodyDigest: plan.bodyDigest,
      contextFormat: plan.compiled.contextFormat ?? "legacy-json",
      manifestDigest: plan.manifestDigest ?? plan.bodyDigest,
      // Work capacity is protected in the active scope, not retained as used input.
      // The completed answer is accounted separately by the owning session.
      pageTokens: plan.costs.retainedTokens + plan.costs.promptTokens + navigationReserve
        + plan.costs.attachmentVisualTokens,
      navigationReservedTokens: navigationReserve,
      externalizedTargetIds: [...new Set([...plan.externalizedTargetIds,
        ...Object.entries(routes).filter(([, route]) => route.media_route === "mcp").map(([target]) => target)])],
      deliveryByTarget: routes };
  }
  /** All submitted candidates have identities, including an unmodified body. */
  descriptor(plan: ContextDeliveryPlan): ContextPlanDescriptor {
    const entry = [...this.plans].find(([, candidate]) => candidate === plan);
    if (!entry) throw new Error("Unknown candidate delivery plan");
    return plan.compiled.contextPlan ?? {
      planId: entry[0], contextId: plan.snapshot.context_id,
      manifestDigest: plan.manifestDigest ?? plan.bodyDigest, requiredAttachments: [],
    };
  }
  /** Pre-publication space checks do not make an unselected candidate source evidence. */
  candidateCoverage(plan: ContextDeliveryPlan): ReturnType<CompactionSourceCoverage["metadata"]> {
    const entry = [...this.plans].find(([, candidate]) => candidate === plan);
    if (!entry) throw new Error("Unknown candidate source plan");
    const preview = this.coverage.fork();
    preview.prepare(plan.snapshot, this.sourcePlan(entry[0], plan));
    return preview.metadata();
  }
  async sent(): Promise<void> {
    if (!this.selected) throw new Error("Send has no selected context source plan");
    const { id, token, plan } = this.selected;
    if (plan.registration) {
      // Safe reads use the Broker's original start/Sent evidence. They may finish before
      // the observing owner resumes, so do not mutate an already completed safe channel.
      if (!this.manualPlans.has(plan)) await this.broker.markContextPlanSent!(token, id, this.ownerContext);
      // Automatic onSubmitted follows completed attachment upload and Send.
      if (!this.manualPlans.has(plan) && plan.compiled.contextPlan?.requiredAttachments.length) {
        await this.broker.confirmContextAttachments!(token, { planId: id, manifestDigest: plan.manifestDigest! }, this.ownerContext);
      }
    }
    this.coverage.markDelivered(id);
  }
  /** Cost evidence outlives the readable snapshot and is serialized before page reuse. */
  syncUsage(options?: BrokerWaitOptions): Promise<void> {
    // Each queued invocation owns its clock. A later compaction must not change
    // an ordinary synchronization that is already queued or in flight.
    const wait = options?.compaction ? { compaction: true as const } : undefined;
    const update = async () => {
      const binding = this.usageBinding;
      if (!binding) return;
      if (!binding.finalAccounted) {
        const evidence = await this.broker.contextUsage!(binding.token, wait);
        if (!evidence || evidence.plan_id !== binding.id || evidence.context_id !== binding.contextId
          || evidence.purpose !== "normal") throw new Error("The selected context navigation cost evidence is unavailable");
        // An unsubmitted candidate cannot have successful model reads. It contributes no page cost.
        const record = this.coverage.metadata().find(value => value.planId === binding.id);
        if (record?.delivered) this.coverage.recordNavigationUsage(binding.id, {
          tokens: evidence.usage.text_tokens + evidence.usage.visual_token_reserve,
          wireBytes: evidence.usage.wire_bytes, reservedTokensUsed: evidence.reserved_tokens_used,
        });
        if (!evidence.final) return;
        if (evidence.reuse_diagnostics) console.info(`[chatgpt-web] context_delivery_observed ${JSON.stringify(evidence.reuse_diagnostics)}`);
        // Release can succeed at the owner before its reply is lost. The next
        // synchronization retries only that idempotent release, never a deleted
        // evidence read or a second ledger update. This invocation still fails.
        binding.finalAccounted = true;
      }
      await this.broker.releaseContextUsage?.(binding.token, wait);
      this.usageBinding = undefined;
    };
    const result = this.usageQueue.then(update, update);
    this.usageQueue = result.catch(() => {});
    return result;
  }
  /** Called only after normal final and physical page settlement by the owning Session. */
  async commitReuse(): Promise<ContextReuseBaseline | undefined> {
    const token = this.reuseToken;
    this.reuseToken = undefined;
    return token ? this.broker.commitContextReuse?.(token) : undefined;
  }
  retire(): void {
    this.retired = true;
    this.plans.clear();
    this.selected = undefined;
    this.source = undefined;
    this.initialSource = undefined;
  }
}
