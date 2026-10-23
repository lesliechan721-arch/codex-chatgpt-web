import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { assertLauncherContextDeliveryFeature, CONTINUITY_EXECUTION_FENCING_FEATURE, CONTINUITY_PREPARATION_TERMINATION_FEATURE, isLauncherKnownUnsentReceipt,
  LauncherKnownUnsentReceiptError, type LauncherKnownUnsentReceipt,
  LAUNCHER_CONTEXT_DELIVERY_FEATURE, notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import { validateBrowserHelperContextPlan } from "./browser-helper-prompt-selection";
import { CONTEXT_PROTOCOL_VERSION } from "./context-runtime";
import { hasContextBootstrapCapabilities } from "./context-protocol";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, isContinuityLease, isContinuityRecoveryIdentity,
  sameContinuityRecoveryIdentity, type ContinuityLease, type ContinuityRecoveryIdentity } from "./continuity-contract";
import { continuityError } from "./continuity-errors";
import { ContinuityRecoveryStore } from "./continuity-recovery-store";
import { isTaskRevision, type TaskUpdateOwnerContext } from "./task-update-protocol";
import {
  parseChatGptLunaCheckpoint,
  type ChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
  prepared?: CompiledChatGptWebPrompt & { release: () => void };
  localFailure?: Error;
  progressForwarding?: AbortController;
  selectedContextPlanId?: string;
  preparing?: boolean;
  submissionReceipt?: Promise<void>;
  submissionReceiptAcknowledgement?: boolean;
  submissionReceiptAccepted?: boolean;
  sendActivationAcknowledged?: boolean;
  terminalReceived?: boolean;
  receiptTimer?: ReturnType<typeof setTimeout>;
  abortTimer?: ReturnType<typeof setTimeout>;
  retirement?: Promise<void>;
  exiting?: boolean;
  lease?: ContinuityLease;
}

const SUBMISSION_RECEIPT_ACK_FEATURE = "submission-receipt-ack-v1";
export const LAUNCHER_SUBMISSION_RECEIPT_TIMEOUT_MS = 15_000;
const ABORT_RETIREMENT_TIMEOUT_MS = 15_000;
const MAX_UNFINISHED_ABORTS = 5;

type HelperMessage = { recovery?: ContinuityRecoveryIdentity } & (
  | { type: "ready"; features?: string[]; contextCompatible: boolean }
  | { type: "event"; id: string; event: "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean; candidate?: TaskUpdateOwnerContext }
  | { type: "event"; id: string; event: "tool_batch_observed"; revision: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number; candidate?: TaskUpdateOwnerContext }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number; candidate?: TaskUpdateOwnerContext }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "context_plan_selected"; planId: string }
  | { type: "event"; id: string; event: "continuity_lease"; lease: ContinuityLease }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
      sendUnsentReceipt?: LauncherKnownUnsentReceipt;
    });

function parseHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.recovery !== undefined && !isContinuityRecoveryIdentity(message.recovery)) {
    throw new Error("Launcher browser helper returned an invalid recovery identity");
  }
  return { ...parseHelperPayload(message), ...(message.recovery ? { recovery: message.recovery as ContinuityRecoveryIdentity } : {}) };
}

function parseHelperPayload(message: Record<string, unknown>): HelperMessage {
  if (message.type === "ready") {
    const features = message.features;
    if (features !== undefined
      && (!Array.isArray(features) || features.some(feature => typeof feature !== "string"))) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    return { type: "ready", contextCompatible: hasContextBootstrapCapabilities(message, CONTEXT_PROTOCOL_VERSION), ...(features ? { features: features as string[] } : {}) };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    let candidate: TaskUpdateOwnerContext | undefined;
    if (message.candidate !== undefined) {
      const value = message.candidate as TaskUpdateOwnerContext;
      if (!value || !isTaskRevision(value.taskRevision) || !isTaskRevision(value.expectedDriverGeneration)
        || (value.acknowledgedRevision !== undefined && (!isTaskRevision(value.acknowledgedRevision)
          || value.acknowledgedRevision > value.taskRevision))) {
        throw new Error("Launcher browser helper task output candidate is invalid");
      }
      candidate = Object.freeze({ taskRevision: value.taskRevision, expectedDriverGeneration: value.expectedDriverGeneration,
        ...(value.acknowledgedRevision !== undefined ? { acknowledgedRevision: value.acknowledgedRevision } : {}) });
    }
    if (event === "continuity_lease") {
      if (!isContinuityLease(message.lease)) throw new Error("Launcher browser helper returned an invalid continuity lease");
      return { type: "event", id: message.id, event, lease: message.lease };
    }
    if (event === "tool_batch_observed") {
      if (!Number.isSafeInteger(message.revision) || (message.revision as number) <= 0) {
        throw new Error("Launcher browser helper tool-boundary revision is invalid");
      }
      return { type: "event", id: message.id, event, revision: message.revision as number };
    }
    if (event === "completion_fence_begin") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper completion fence request id is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number, ...(candidate ? { candidate } : {}) };
    }
    if (event === "completion_fence_commit") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0
        || !Number.isSafeInteger(message.revision) || (message.revision as number) < 0) {
        throw new Error("Launcher browser helper completion fence revision is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
        ...(candidate ? { candidate } : {}),
      };
    }
    if (event === "luna_checkpoint") {
      if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
        throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
        answerHash: message.answerHash,
      };
    }
    const text = message.text;
    const continuation = message.continuation;
    if (event === "prepared_selected") {
      if (typeof message.reused !== "boolean") {
        throw new Error("Launcher browser helper prompt selection is invalid");
      }
      return { type: "event", id: message.id, event, reused: message.reused };
    }
    if (event === "context_plan_selected") {
      if (typeof message.planId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.planId)) {
        throw new Error("Launcher browser helper context plan selection is invalid");
      }
      return { type: "event", id: message.id, event, planId: message.planId };
    }
    if (!["heartbeat", "generation_progress", "send_activated", "submitted", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "generation_progress" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
      ...(candidate ? { candidate } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const status = message.status;
    const errorType = message.errorType;
    const code = message.code;
    const retryable = message.retryable;
    const sendUnsentReceipt = message.sendUnsentReceipt;
    const structured = status !== undefined
      || errorType !== undefined
      || code !== undefined
      || retryable !== undefined;
    if (typeof errorMessage !== "string"
      || (errorName !== undefined && typeof errorName !== "string")
      || (structured && (
        !Number.isInteger(status)
        || (status as number) < 400
        || (status as number) > 599
        || typeof errorType !== "string"
        || !errorType
        || typeof code !== "string"
        || !code
        || typeof retryable !== "boolean"
      )) || (sendUnsentReceipt !== undefined && (code !== "continuity_resource_capacity" || !isLauncherKnownUnsentReceipt(sendUnsentReceipt)))) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(errorName !== undefined ? { name: errorName as string } : {}),
      ...(structured ? {
        status: status as number,
        errorType: errorType as string,
        code: code as string,
        retryable: retryable as boolean,
      } : {}),
      ...(sendUnsentReceipt ? { sendUnsentReceipt: sendUnsentReceipt as LauncherKnownUnsentReceipt } : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

export class LauncherBrowserHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();
  private helperFeatures = new Set<string>();
  private helperContextCompatible = false;
  // A timed-out legacy worker may still emit frames. Do not reuse its trace until its
  // terminal frame or process exit proves that the old producer has stopped.
  private readonly unfinishedAborts = new Map<string, { child: ChildProcessWithoutNullStreams; recovery?: ContinuityRecoveryIdentity }>();

  constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * The helper that shipped with this daemon, when one sits beside its own entrypoint.
   *
   * The launcher advertises the helper inside its application bundle while the daemon runs from a
   * versioned runtime directory, so the two sides update independently and can disagree about the
   * protocol. Preferring the sibling keeps daemon and helper on the same build by construction;
   * anything else — a source checkout, an unbundled entrypoint — falls back to the advertised path.
   */
  private bundledHelperScript(): string | undefined {
    const entrypoint = process.argv[1];
    // Only the packaged runtime layout is claimed: the bundle builder emits cli.js and
    // browser-helper.cjs into one directory. Matching on that entrypoint name keeps a source
    // checkout, or any other launch shape, on the launcher-advertised helper rather than adopting
    // an unrelated sibling that merely shares a filename.
    if (typeof entrypoint !== "string" || basename(entrypoint) !== "cli.js") return undefined;
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    return existsSync(sibling) ? sibling : undefined;
  }

  async run(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    await this.ensureChild();
    if (turn.continuity) await this.assertContinuityCompatible(Boolean(turn.continuity.recovery));
    if (turn.continuity?.recovery && !turn.onSendActivated) {
      throw continuityError("continuity_configuration_conflict", "Recovery requires an acknowledged durable Send boundary before browser submission.");
    }
    if (turn.continuity?.recovery && !turn.recoveryStoreDirectory?.trim()) {
      throw continuityError("continuity_configuration_conflict", "Recovery requires the authenticated durable state directory in the browser helper.");
    }
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (turn.externalProgress && !this.helperFeatures.has("tool-boundary-ack")) {
      throw new Error(
        "Launcher browser helper does not support causal Codex tool-boundary acknowledgement; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("completion-fence")) {
      throw new Error(
        "Launcher browser helper does not support the MCP completion fence; update or restart the launcher",
      );
    }
    if (turn.externalProgress && !this.helperFeatures.has("native-tool-wait-v1")) {
      throw new ChatGptWebAdapterError(
        "Launcher browser helper does not support Native operation waiting; update the runtime and helper before using the current connector",
        { status: 503, errorType: "server_error", code: "codex_tool_upgrade_required", retryable: false },
      );
    }
    if (turn.taskUpdateProtocol && !this.hasTaskUpdateFeatures()) {
      throw new ChatGptWebAdapterError("Launcher browser helper no longer supports the negotiated task update protocol", {
        status: 503, errorType: "server_error", code: "task_update_protocol_missing", retryable: false,
      });
    }
    return await new Promise<string>((resolveResult, rejectResult) => {
        if (this.unfinishedAborts.has(turn.traceId) || this.unfinishedAborts.size >= MAX_UNFINISHED_ABORTS) {
          rejectResult(new Error("Launcher browser helper still owns an unfinished aborted turn"));
          return;
        }
        if (this.pending.has(turn.traceId)) {
          rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
          return;
        }
        const pending: PendingTurn = { turn, resolve: resolveResult, reject: rejectResult,
          submissionReceiptAcknowledgement: Boolean(turn.onSubmitted && this.helperFeatures.has(SUBMISSION_RECEIPT_ACK_FEATURE)),
        };
        this.pending.set(turn.traceId, pending);
        if (turn.abortSignal) {
          const abortListener = () => {
            if (this.pending.get(turn.traceId) !== pending) return;
            if (pending.terminalReceived) {
              if (!pending.exiting && !pending.retirement) {
                this.finishWithError(turn.traceId, pending.localFailure ?? new DOMException("ChatGPT web turn aborted", "AbortError"));
              }
              return;
            }
            if (!pending.sent) {
              this.finishWithError(
                turn.traceId,
                new DOMException("ChatGPT web turn aborted", "AbortError"),
              );
              return;
            }
            this.scheduleAbortRetirement(turn.traceId, pending);
            void this.send({
              type: "abort",
              id: turn.traceId,
              ...(turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted
                ? { reason: "compaction_handoff_accepted" }
                : {}),
            }).catch(error => {
              if (this.pending.get(turn.traceId) !== pending) return;
              this.finishWithError(
                turn.traceId,
                error instanceof Error ? error : new Error(String(error)),
              );
            });
          };
          pending.abortListener = abortListener;
          turn.abortSignal.addEventListener("abort", abortListener, { once: true });
          if (turn.abortSignal.aborted) {
            abortListener();
            return;
          }
        }
        // Setting this before the synchronous write call makes an abort either prevent dispatch or
        // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
        pending.sent = true;
        const progressForwarding = new AbortController();
        pending.progressForwarding = progressForwarding;
        void this.send({
          type: "run",
          id: turn.traceId,
          config: {
            appName: this.config.appName,
            browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
            browserDiagnosticsPath: this.config.browserDiagnosticsPath,
            turnTimeoutMs: this.config.turnTimeoutMs,
            autoApproveToolCalls: this.config.autoApproveToolCalls,
            useSavedChats: this.config.useSavedChats,
          },
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            reasoning: turn.reasoning,
            ...(turn.modelFamily ? { modelFamily: turn.modelFamily } : {}),
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.continuity ? { continuity: turn.continuity } : {}),
            ...(turn.recoveryStoreDirectory ? { recoveryStoreDirectory: turn.recoveryStoreDirectory } : {}),
            ...(turn.recoveryRequestId ? { recoveryRequestId: turn.recoveryRequestId } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
            ...(turn.externalProgress ? { externalProgress: true } : {}),
            ...(turn.taskUpdateProtocol ? { taskUpdateProtocol: turn.taskUpdateProtocol } : {}),
            ...(pending.submissionReceiptAcknowledgement ? { submissionReceiptAcknowledgement: true } : {}),
          },
        })
          // Only mirror once the run frame is on the wire, so the helper never sees progress for a
          // turn it has not been told about and cannot accumulate state for unknown ids.
          .then(() => {
            if (!progressForwarding.signal.aborted) this.forwardProgress(turn, progressForwarding.signal);
          })
          .catch(error => {
            if (this.pending.get(turn.traceId) === pending) {
              this.finishWithError(turn.traceId, error instanceof Error ? error : new Error(String(error)));
            }
          });
      });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, new DOMException("Launcher browser helper is closing", "AbortError"));
    }
    this.unfinishedAborts.clear();
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  async assertContinuityCompatible(recovery = false): Promise<void> {
    await this.ensureChild();
    if (!this.helperFeatures.has(CONTINUITY_FEATURE) || !this.helperFeatures.has("native-tool-wait-v1")
      || (recovery && (!this.helperFeatures.has(CONTINUITY_RECOVERY_FEATURE)
        || !this.helperFeatures.has(CONTINUITY_EXECUTION_FENCING_FEATURE)))) {
      throw continuityError("continuity_configuration_conflict", "Update the runtime and browser helper before starting this mode.");
    }
  }

  async assertContextDeliveryCompatible(): Promise<void> {
    await this.ensureChild();
    assertLauncherContextDeliveryFeature(readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!));
    if (!this.helperFeatures.has(LAUNCHER_CONTEXT_DELIVERY_FEATURE) || !this.helperContextCompatible) {
      throw new ChatGptWebAdapterError(`Launcher browser helper does not support context protocol ${CONTEXT_PROTOCOL_VERSION}, context-bootstrap-payload-v3, context-text-batch-v1 and manifest 3; update the runtime and helper before using context navigation`, {
        status: 503, errorType: "server_error", code: "codex_context_upgrade_required", retryable: false,
      });
    }
  }

  async supportsTaskUpdates(): Promise<boolean> {
    await this.ensureChild();
    return this.hasTaskUpdateFeatures();
  }

  private hasTaskUpdateFeatures(): boolean {
    return ["task-updates-v1", "task-output-ack-v3", "progress", "tool-boundary-ack", "completion-fence", "native-tool-wait-v1"]
      .every(feature => this.helperFeatures.has(feature));
  }

  private async ensureChild(): Promise<void> {
    if (this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready) {
      return this.ready;
    }
    const descriptor = readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!);
    const child = spawn(
      descriptor.helper.executable,
      [this.config.browserHelperScriptPath ?? this.bundledHelperScript() ?? descriptor.helper.script],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child = child;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: HelperMessage;
    try { message = parseHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      // Optional frames are sent only when the helper advertises support for them.
      this.helperFeatures = new Set(message.features ?? []);
      this.helperContextCompatible = message.contextCompatible;
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      const unfinished = this.unfinishedAborts.get(message.id);
      if (unfinished?.child === child && (message.type === "result" || message.type === "error")
        && (!unfinished.recovery || (message.recovery && sameContinuityRecoveryIdentity(message.recovery, unfinished.recovery)))) {
        this.unfinishedAborts.delete(message.id);
      }
      return;
    }
    const recovery = pending.turn.continuity?.recovery;
    if (recovery) {
      if (!message.recovery) {
        this.abortWithLocalFailure(message.id, continuityError("continuity_configuration_conflict", "Browser helper omitted a recovery frame identity."), pending);
        return;
      }
      if (!sameContinuityRecoveryIdentity(message.recovery, recovery)) return;
    }
    if (message.type === "event") {
      if (pending.terminalReceived) return;
      if ((pending.localFailure || pending.turn.abortSignal?.aborted)
        && message.event !== "submitted") return;
      if (pending.turn.onSubmitted && !pending.submissionReceiptAccepted
        && ["text", "reasoning", "commentary", "luna_checkpoint", "completion_fence_begin", "completion_fence_commit"].includes(message.event)) {
        this.abortWithLocalFailure(message.id, new Error("Launcher browser helper published output before submission receipt persistence"), pending);
        return;
      }
      if (pending.turn.taskUpdateProtocol && (
        message.event === "text" || message.event === "completion_fence_begin" || message.event === "completion_fence_commit"
      ) && (!message.candidate || message.candidate.acknowledgedRevision === undefined)) {
        this.abortWithLocalFailure(message.id, new ChatGptWebAdapterError(
          "Launcher browser helper omitted the task output candidate or its observed acknowledgment head",
          { status: 503, errorType: "server_error", code: "task_update_protocol_missing", retryable: false },
        ), pending);
        return;
      }
      if (message.event === "heartbeat") pending.turn.onHeartbeat?.();
      else if (message.event === "generation_progress") pending.turn.onGenerationProgress?.();
      else if (message.event === "tool_batch_observed") {
        const progress = pending.turn.externalProgress;
        if (!progress) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper observed a tool boundary for a turn without progress transport"),
            pending,
          );
          return;
        }
        void progress.acknowledgeToolBatch(message.revision).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_begin") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.begin(message.candidate).then(revision => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_begin_ack",
            id: message.id,
            requestId: message.requestId,
            revision: revision ?? null,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "completion_fence_commit") {
        const fence = pending.turn.completionFence;
        if (!fence) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested a completion fence for an unfenced turn"),
            pending,
          );
          return;
        }
        void fence.commit(message.revision, message.candidate).then(committed => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "completion_fence_commit_ack",
            id: message.id,
            requestId: message.requestId,
            committed,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "send_activated") {
        if (pending.prepared?.contextPlan && pending.selectedContextPlanId !== pending.prepared.contextPlan.planId) {
          this.abortWithLocalFailure(message.id, new Error("Launcher browser helper has not acknowledged the selected context plan"), pending);
          return;
        }
        void Promise.resolve().then(() => pending.turn.onSendActivated?.()).then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          pending.sendActivationAcknowledged = true;
          return this.send({ type: "send_activation_ack", id: message.id });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "submitted") {
        if (recovery && !pending.sendActivationAcknowledged) {
          this.abortWithLocalFailure(message.id, continuityError("continuity_source_unproven", "The helper submission has no acknowledged Send boundary for this run."), pending);
          return;
        }
        if (pending.prepared?.contextPlan && pending.selectedContextPlanId !== pending.prepared.contextPlan.planId) {
          this.abortWithLocalFailure(message.id, new Error("Launcher browser helper submitted without its selected context plan"), pending);
          return;
        }
        // This exact helper channel may settle its original Send after cancellation or withdrawal.
        // It cannot grant rights or publish a final answer. Duplicate receipts share one write.
        if (pending.submissionReceipt) return;
        const receipt = pending.submissionReceipt = Promise.resolve()
          .then(() => {
            if (!recovery && (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted)) return;
            return pending.turn.onSubmitted?.();
          });
        // Keep rejection on the receipt itself: an old helper's result must not turn a
        // failed persistence callback into success. This separate observer owns the ACK.
        void receipt.then(() => {
            pending.submissionReceiptAccepted = true;
            if (!pending.submissionReceiptAcknowledgement || this.pending.get(message.id) !== pending
              || pending.terminalReceived || this.child !== child) return;
            if (!recovery && (pending.localFailure || pending.turn.abortSignal?.aborted)) return;
            return this.send({ type: "submitted_ack", id: message.id });
          }).catch(error => this.abortWithLocalFailure(
            message.id, error instanceof Error ? error : new Error(String(error)), pending,
          ));
      }
      else if (message.event === "continuity_lease") {
        try {
          const claim = pending.turn.continuity;
          if (!claim || message.lease.owner !== claim.owner || message.lease.traceId !== pending.turn.traceId
            || (claim.expected && message.lease.leaseId !== claim.expected.leaseId)
            || (claim.recovery && (!message.lease.recovery || !sameContinuityRecoveryIdentity(message.lease.recovery, claim.recovery)))) {
            throw continuityError("continuity_session_lost");
          }
          pending.turn.onContinuityLease?.(message.lease);
          pending.lease = message.lease;
        } catch (error) {
          this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending);
        }
      }
      else if (message.event === "prepared_selected") {
        if (pending.preparing || pending.prepared) {
          this.abortWithLocalFailure(message.id, new Error("Launcher browser helper selected the prompt more than once"), pending);
          return;
        }
        pending.preparing = true;
        const prepare = message.reused ? pending.turn.prepareResume : pending.turn.prepare;
        void Promise.resolve().then(() => prepare?.()).then(prepared => {
          if (!prepared) throw new Error("Launcher browser helper selected an unavailable continuation prompt");
          if (this.pending.get(message.id) !== pending) {
            prepared.release();
            return;
          }
          pending.prepared = prepared;
          if (Object.hasOwn(prepared, "multipart")) {
            throw new ChatGptWebAdapterError("Staged context transport is retired; update the runtime and browser helper before sending this prompt", {
              status: 503, errorType: "server_error", code: "codex_context_upgrade_required", retryable: false,
            });
          }
          validateBrowserHelperContextPlan(prepared.contextPlan);
          if (prepared.skillFiles?.length && !this.helperFeatures.has("skill-attachments")) {
            throw new Error("Launcher browser helper does not support skill attachments; update or restart the launcher");
          }
          return Promise.resolve(prepared.contextPlan ? this.assertContextDeliveryCompatible() : undefined)
            .then(() => pending.turn.onPreparedSelected?.(message.reused)).then(() => {
            if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
            return this.send({
              type: "prepared_selected_ack",
              id: message.id,
              prepared: {
                text: prepared.text,
                images: prepared.images,
                ...(prepared.contextPlan ? { contextPlan: prepared.contextPlan } : {}),
                ...(prepared.turnToken ? { turnToken: prepared.turnToken } : {}),
                ...(prepared.skillFiles ? { skillFiles: prepared.skillFiles } : {}),
                ...(prepared.trimmedCompactionMessages !== undefined
                  ? { trimmedCompactionMessages: prepared.trimmedCompactionMessages }
                  : {}),
              } satisfies CompiledChatGptWebPrompt,
            });
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
      else if (message.event === "context_plan_selected") {
        if (!this.helperFeatures.has(LAUNCHER_CONTEXT_DELIVERY_FEATURE) || !this.helperContextCompatible
          || !pending.prepared?.contextPlan || message.planId !== pending.prepared.contextPlan.planId
          || pending.selectedContextPlanId !== undefined) {
          this.abortWithLocalFailure(message.id, new Error("Launcher browser helper selected an unknown or mismatched context plan"), pending);
          return;
        }
        void Promise.resolve().then(() => pending.turn.onContextPlanSelected?.(message.planId)).then(() => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          pending.selectedContextPlanId = message.planId;
          return this.send({ type: "context_plan_selected_ack", id: message.id, planId: message.planId });
        }).catch(error => this.abortWithLocalFailure(message.id, error instanceof Error ? error : new Error(String(error)), pending));
      }
      else if (message.event === "luna_checkpoint") {
        if (!pending.turn.captureLunaCheckpoint || !pending.turn.onLunaCheckpoint) {
          this.finishWithError(message.id, new Error("Launcher browser helper emitted an unexpected Luna checkpoint"));
          return;
        }
        pending.turn.onLunaCheckpoint({ checkpoint: message.checkpoint, answerHash: message.answerHash });
      }
      else if (message.event === "reasoning" && message.text) {
        pending.turn.onReasoningSummary?.(message.text, message.continuation === true);
      }
      else if (message.event === "commentary" && message.text) pending.turn.onCommentary?.(message.text, message.continuation === true);
      else if (message.event === "text" && message.text) pending.turn.onTextDelta(message.text, message.candidate);
      return;
    }
    if (pending.terminalReceived) return;
    pending.terminalReceived = true;
    if (pending.abortTimer) clearTimeout(pending.abortTimer);
    pending.abortTimer = undefined;
    if (message.type === "result") {
      if (pending.localFailure || pending.turn.abortSignal?.aborted) {
        if (pending.retirement) return;
        this.finishWithError(message.id, pending.localFailure ?? new DOMException("ChatGPT web turn aborted", "AbortError"));
        return;
      }
      if (pending.turn.onSubmitted && !pending.submissionReceipt) {
        this.finishWithError(message.id, new Error("Launcher browser helper completed without a submission receipt"));
        return;
      }
      // An older helper can complete while the daemon is still persisting its receipt.
      // Keep ownership and prepared resources until that receipt has settled too.
      if (pending.submissionReceipt) {
        pending.receiptTimer = setTimeout(() => {
          if (this.pending.get(message.id) !== pending) return;
          this.finishWithError(message.id, pending.localFailure ?? new Error("Launcher browser helper submission receipt persistence timed out"));
        }, LAUNCHER_SUBMISSION_RECEIPT_TIMEOUT_MS);
        pending.receiptTimer.unref?.();
      }
      void (pending.submissionReceipt ?? Promise.resolve()).then(() => {
        if (this.pending.get(message.id) !== pending || pending.exiting) return;
        this.finish(message.id);
        if (pending.localFailure) pending.reject(pending.localFailure);
        else if (pending.turn.abortSignal?.aborted) pending.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
        else pending.resolve(message.text);
      }, error => {
        if (this.pending.get(message.id) !== pending || pending.exiting) return;
        this.finishWithError(message.id, pending.localFailure ?? (error instanceof Error ? error : new Error(String(error))));
      });
    } else if (message.type === "error") {
      const receipt = message.sendUnsentReceipt;
      const matchingUnsentReceipt = receipt && recovery && pending.turn.recoveryRequestId === receipt.requestId
        && pending.turn.traceId === receipt.traceId && child.pid === receipt.helperPid
        && sameContinuityRecoveryIdentity(receipt.recovery, recovery);
      const error = receipt
        ? matchingUnsentReceipt ? new LauncherKnownUnsentReceiptError(receipt)
          : continuityError("continuity_unverified", "The helper returned an unsent receipt for another acquisition.")
        : message.status !== undefined
        ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
        })
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
      // The producer sends a terminal error after Launcher retirement. An already
      // observed receipt continues independently with its captured original identity.
      if (pending.retirement) {
        pending.localFailure ??= error;
      } else {
        this.finish(message.id);
        pending.reject(pending.localFailure ?? error);
      }
    }
  }

  private abortWithLocalFailure(id: string, error: Error, pending: PendingTurn): void {
    if (this.pending.get(id) !== pending || pending.localFailure) return;
    pending.localFailure = error;
    const recovery = pending.turn.continuity?.recovery;
    if (pending.preparing && pending.lease && recovery && pending.turn.recoveryStoreDirectory && pending.turn.recoveryRequestId
      && this.child?.pid && this.helperFeatures.has(CONTINUITY_PREPARATION_TERMINATION_FEATURE)) {
      try {
        if (readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!).features?.includes(CONTINUITY_PREPARATION_TERMINATION_FEATURE)) {
          new ContinuityRecoveryStore(pending.turn.recoveryStoreDirectory).terminatePreparation(recovery, {
            requestId: pending.turn.recoveryRequestId, traceId: id, helperPid: this.child.pid, lease: pending.lease,
          });
        }
      } catch { /* A failed fence or changed owner is not evidence of an unsent turn. */ }
    }
    if (pending.exiting) return;
    if (pending.terminalReceived) {
      if (pending.retirement) return;
      this.finishWithError(id, error);
      return;
    }
    this.scheduleAbortRetirement(id, pending);
    void this.send({ type: "abort", id }).catch(sendError => {
      if (this.pending.get(id) !== pending) return;
      this.finishWithError(
        id,
        new AggregateError(
          [error, sendError instanceof Error ? sendError : new Error(String(sendError))],
          "Launcher browser helper could not abort after a local protocol failure",
        ),
      );
    });
  }

  private scheduleAbortRetirement(id: string, pending: PendingTurn): void {
    if (pending.abortTimer || pending.terminalReceived) return;
    const child = this.child;
    if (!child) return;
    pending.abortTimer = setTimeout(() => {
      pending.abortTimer = undefined;
      if (this.pending.get(id) !== pending || pending.terminalReceived) return;
      this.unfinishedAborts.set(id, { child, recovery: pending.turn.continuity?.recovery });
      pending.retirement = notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end", traceId: id, helperPid: child.pid!, status: "failed",
        message: "Launcher browser helper did not finish the aborted turn",
        ...(pending.turn.continuity?.recovery ? { recovery: pending.turn.continuity.recovery } : {}),
        ...(pending.turn.recoveryStoreDirectory ? { recoveryStoreDirectory: pending.turn.recoveryStoreDirectory } : {}),
      }, undefined, undefined, { compaction: pending.turn.compaction }).then(() => {});
      void pending.retirement.then(() => {
        if (this.pending.get(id) !== pending) return;
        if (pending.terminalReceived) this.unfinishedAborts.delete(id);
        this.finishWithError(id, pending.localFailure ?? new DOMException("ChatGPT web turn aborted", "AbortError"));
      }, error => {
        if (this.pending.get(id) !== pending) return;
        this.finishWithError(id, new AggregateError(
          [pending.localFailure ?? new DOMException("ChatGPT web turn aborted", "AbortError"), error],
          "Launcher browser helper could not release the aborted turn",
        ));
      });
    }, ABORT_RETIREMENT_TIMEOUT_MS);
    pending.abortTimer.unref?.();
  }

  /**
   * Mirrors daemon-recorded MCP progress into the helper process for the life of the turn.
   *
   * The browser worker runs out of process, so without this the worker sees no external progress
   * and cancels turns whose tool calls are still completing.
   */
  private forwardProgress(turn: BrowserTurn, stop: AbortSignal): void {
    const progress = turn.externalProgress;
    if (!progress) return;
    if (!this.helperFeatures.has("progress")) {
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} runs without an MCP progress mirror:`
        + " the launcher browser helper predates the progress frame",
      );
      return;
    }
    void (async () => {
      let revision = 0;
      while (!stop.aborted) {
        const snapshot = await progress.waitForChange(revision, stop);
        revision = snapshot.revision;
        if (stop.aborted) return;
        await this.send({ type: "progress", id: turn.traceId, snapshot });
      }
    })().catch(error => {
      // Ending, aborting, or losing the helper stops the mirror by design and is not a fault.
      // Anything else leaves the worker on DOM-only health without saying so, which is exactly the
      // silent degradation this transport exists to remove, so it is surfaced rather than dropped.
      if (stop.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      console.warn(
        `[chatgpt-web] browser turn ${turn.traceId} lost its MCP progress mirror:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.receiptTimer) clearTimeout(pending.receiptTimer);
    if (pending.abortTimer) clearTimeout(pending.abortTimer);
    pending.receiptTimer = undefined;
    pending.abortTimer = undefined;
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.progressForwarding?.abort();
    pending.progressForwarding = undefined;
    const prepared = pending.prepared;
    pending.prepared = undefined;
    this.pending.delete(id);
    prepared?.release();
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finish(id);
    pending.reject(error);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    for (const [id, unfinished] of this.unfinishedAborts) {
      if (unfinished.child === child) this.unfinishedAborts.delete(id);
    }
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      pending.terminalReceived = true;
      pending.exiting = true;
      if (pending.abortTimer) clearTimeout(pending.abortTimer);
      if (pending.receiptTimer) clearTimeout(pending.receiptTimer);
      pending.abortTimer = undefined;
      pending.receiptTimer = undefined;
      const retirement = pending.retirement ?? notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
        ...(pending.turn.continuity?.recovery ? { recovery: pending.turn.continuity.recovery } : {}),
        ...(pending.turn.recoveryStoreDirectory ? { recoveryStoreDirectory: pending.turn.recoveryStoreDirectory } : {}),
      }, undefined, undefined, { compaction: pending.turn.compaction });
      void retirement.then(
        () => { if (this.pending.get(id) === pending) this.finishWithError(id, pending.localFailure ?? error); },
        controlError => {
          if (this.pending.get(id) !== pending) return;
          this.finishWithError(id, new AggregateError(
            [pending.localFailure ?? error, controlError instanceof Error ? controlError : new Error(String(controlError))],
            `Launcher browser helper exited and failed to release turn ${id}`,
          ));
        },
      );
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    const frame = message as { id?: string; recovery?: ContinuityRecoveryIdentity };
    const recovery = frame?.id ? this.pending.get(frame.id)?.turn.continuity?.recovery : undefined;
    return this.sendTo(child, recovery && !frame.recovery ? { ...frame, recovery } : message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }
}
