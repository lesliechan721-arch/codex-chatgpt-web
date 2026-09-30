import { createHash, randomBytes } from "node:crypto";
import { COMPACT_PROMPT, decodeCompactionSummary, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest, CodexTool } from "../../types";
import { canonicalJson } from "./canonical-json";
import { continuityError } from "./continuity-errors";
import { ContinuityRegistrationStore } from "./continuity-registration";
import { CONTINUITY_IDLE_TTL_MS, type ContinuityClaim, type ContinuityLease } from "./continuity-contract";
import { releaseContinuityContinuationEvidence } from "./compaction-continuation";
import type { ContinuitySourceInstructionReplayEvidence } from "./turn-execution";
export { CONTINUITY_IDLE_TTL_MS, CONTINUITY_FEATURE } from "./continuity-contract";
export type { ContinuityClaim, ContinuityLease } from "./continuity-contract";

const MAX_CHECKPOINTS = 256;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_CHECKPOINT_BYTES = 24 * 1024 * 1024;
const MAX_ORDINARY_REPLAY_TOMBSTONES = 256;
const TERMINAL_EVIDENCE_TTL_MS = 30 * 60_000;
const runtimeOwner = randomBytes(32).toString("hex");

export interface ContinuityHandoffEvidence {
  key: string;
  sourceRevision: number;
  sourceExecutionKey: string;
  bytes: number;
  lease: ContinuityLease;
  summary: string;
}

export interface ContinuityToolResultReplayEvidence {
  earlierCallIds?: string[];
  results: Array<{
    callId: string;
    type: string;
    digest: string;
  }>;
}

export interface ContinuityCheckpointCommit extends Omit<ContinuityHandoffEvidence, "key"> {
  revision: number;
  preserveFinalResponse: boolean;
  sourceResultReplay?: ContinuityToolResultReplayEvidence;
  sourceInstructionReplay?: ContinuitySourceInstructionReplayEvidence;
}

export interface ContinuityBinding {
  readonly thread: string;
  readonly scope: string;
  readonly owner: string;
  readonly initialExecutionKey: string;
  readonly initialNativeTurnId?: string;
  /** First request accepted after initial preflight. Retained only while creation is retryable. */
  initialAcceptedInput?: CodexParsedRequest;
  initialInstructionPayloadDigest?: string;
  /** Current locally approved discovery only; released with this live binding. */
  discoveredTools?: CodexTool[];
  state: "creating" | "running" | "ready" | "compacting" | "lost" | "ended";
  revision: number;
  lastUsedAt: number;
  lease?: ContinuityLease;
  /** Trusted local ownership metadata only; never persisted or supplied by request JSON. */
  conversation?: { key: string; descriptor: string };
  executionKey?: string;
  compactionKey?: string;
  compactionSourceState?: "ready" | "running";
  compactionEvidenceBytes?: number;
  acceptedHandoff?: ContinuityHandoffEvidence;
  evidenceExpiresAt?: number;
  /** Every committed revision keeps its checkpoint digest; duplicate summary text is valid. */
  readonly revisionDigests: Map<number, string>;
  readonly revisions: Map<string, number>;
  readonly checkpoints: Map<string, ContinuityCheckpointCommit>;
  /** Capacity-reclaimed ordinary executions keep bounded replay and consumed-instruction identity. */
  readonly ordinaryReplayTombstones: Map<string, {
    revision: number;
    instructionIdentity?: string;
    nativeTurnId?: string;
  }>;
}

export function retainContinuityOrdinaryReplayTombstone(
  binding: ContinuityBinding,
  executionKey: string,
  revision: number,
  instructionIdentity?: string,
  nativeTurnId?: string,
): void {
  if (binding.state === "lost" || binding.state === "ended") return;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > binding.revision) {
    throw continuityError("continuity_source_unproven", "The reclaimed execution has no accepted history revision.");
  }
  const existing = binding.ordinaryReplayTombstones.get(executionKey);
  if (existing !== undefined) {
    if (existing.revision !== revision
      || (existing.instructionIdentity !== undefined && instructionIdentity !== undefined
        && existing.instructionIdentity !== instructionIdentity)
      || (existing.nativeTurnId !== undefined && nativeTurnId !== undefined
        && existing.nativeTurnId !== nativeTurnId)) throw continuityError("continuity_source_unproven");
    if ((instructionIdentity !== undefined && existing.instructionIdentity === undefined)
      || (nativeTurnId !== undefined && existing.nativeTurnId === undefined)) {
      binding.ordinaryReplayTombstones.set(executionKey, {
        revision,
        ...(instructionIdentity ?? existing.instructionIdentity
          ? { instructionIdentity: instructionIdentity ?? existing.instructionIdentity }
          : {}),
        ...(nativeTurnId ?? existing.nativeTurnId ? { nativeTurnId: nativeTurnId ?? existing.nativeTurnId } : {}),
      });
    }
    return;
  }
  if (binding.ordinaryReplayTombstones.size >= MAX_ORDINARY_REPLAY_TOMBSTONES) {
    throw continuityError(
      "continuity_resource_capacity",
      "The bounded ordinary replay tombstone registry is full; refusing to forget stale revision identity.",
    );
  }
  binding.ordinaryReplayTombstones.set(executionKey, {
    revision,
    ...(instructionIdentity ? { instructionIdentity } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
  });
}

export function continuityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function inputMessageText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
  }).join("\n");
}

function checkpointSummary(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
    return typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
  }
  if (item.role !== "user" || (item.type !== undefined && item.type !== "message")) return undefined;
  const text = inputMessageText(item);
  return text.startsWith(`${SUMMARY_PREFIX}\n`) ? text.slice(SUMMARY_PREFIX.length + 1) : undefined;
}

/** A digest is comparison data only. It cannot establish an owner or authorize a transition. */
export function continuityCheckpoint(parsed: CodexParsedRequest): { digest: string; index: number } {
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  let latest: { digest: string; index: number } | undefined;
  for (let index = Array.isArray(input) ? input.length - 1 : -1; index >= 0; index -= 1) {
    const summary = checkpointSummary(input![index]);
    if (summary === null) throw continuityError("continuity_source_unproven");
    if (summary === undefined) continue;
    latest ??= { digest: continuityDigest(summary), index };
  }
  return latest ?? { digest: continuityDigest(null), index: -1 };
}

export function continuityCheckpointDigest(parsed: CodexParsedRequest): string {
  return continuityCheckpoint(parsed).digest;
}

export function continuityCompactionSourceHistory(parsed: CodexParsedRequest): unknown[] {
  const raw = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(raw)) throw continuityError("continuity_source_unproven");
  const source = structuredClone(raw);
  for (;;) {
    const last = source.at(-1);
    if (!last || typeof last !== "object" || Array.isArray(last)) break;
    const item = last as Record<string, unknown>;
    if (item.type === "compaction_trigger") {
      source.pop();
      continue;
    }
    if (item.role === "user" && (item.type === undefined || item.type === "message")
      && inputMessageText(item) === COMPACT_PROMPT) {
      source.pop();
      continue;
    }
    break;
  }
  return source;
}

/** Live ownership is deliberately separate from durable, content-free registration. */
export class ContinuityBindings {
  private readonly bindings = new Map<string, ContinuityBinding>();
  private checkpointBytes = 0;
  private checkpointCount = 0;

  constructor(
    readonly registrations: ContinuityRegistrationStore,
    readonly owner = runtimeOwner,
    private readonly now = Date.now,
  ) {}

  lookup(thread: string, scope: string): ContinuityBinding | undefined {
    const registration = this.registrations.get(thread);
    if (!registration) return undefined;
    if (registration.owner !== this.owner || registration.state !== "entered") {
      throw continuityError("continuity_session_lost");
    }
    if (registration.scope !== scope) throw continuityError("continuity_configuration_conflict", "This native thread is already bound to a different model or provider scope.");
    const binding = this.bindings.get(thread);
    if (!binding || binding.state === "lost" || binding.state === "ended") throw continuityError("continuity_session_lost");
    if (binding.state === "ready" && this.now() - binding.lastUsedAt >= CONTINUITY_IDLE_TTL_MS) {
      this.lose(binding);
      throw continuityError("continuity_session_lost", "The conversation exceeded the 24-hour idle limit.");
    }
    return binding;
  }

  observed(thread: string): ContinuityBinding | undefined {
    return this.bindings.get(thread);
  }

  create(
    thread: string,
    scope: string,
    executionKey: string,
    checkpoint: string,
    nativeTurnId?: string,
  ): ContinuityBinding {
    const existing = this.lookup(thread, scope);
    if (existing) {
      if (existing.initialExecutionKey !== executionKey || existing.state !== "creating") {
        throw continuityError("continuity_source_unproven", "This thread has already consumed its initial creation transaction.");
      }
      return existing;
    }
    const registration = this.registrations.claim(thread, scope, this.owner);
    if (registration.owner !== this.owner || registration.scope !== scope || registration.state !== "entered") {
      throw continuityError("continuity_session_lost");
    }
    const binding: ContinuityBinding = {
      thread, scope, owner: this.owner, initialExecutionKey: executionKey,
      ...(nativeTurnId ? { initialNativeTurnId: nativeTurnId } : {}),
      state: "creating", revision: 0, lastUsedAt: this.now(), executionKey,
      revisionDigests: new Map([[0, checkpoint]]), revisions: new Map([[checkpoint, 0]]), checkpoints: new Map(),
      ordinaryReplayTombstones: new Map(),
    };
    this.bindings.set(thread, binding);
    return binding;
  }

  revisionFor(binding: ContinuityBinding, checkpoint: string): number {
    return this.revisionsFor(binding, checkpoint).at(-1)!;
  }

  revisionsFor(binding: ContinuityBinding, checkpoint: string): number[] {
    this.assertCurrent(binding);
    const revisions = [...binding.revisionDigests.entries()]
      .filter(([, digest]) => digest === checkpoint)
      .map(([revision]) => revision);
    if (revisions.length === 0) throw continuityError("continuity_source_unproven", "No accepted handoff produced this checkpoint.");
    return revisions;
  }

  beginResponse(binding: ContinuityBinding, executionKey: string): ContinuityClaim {
    this.assertCurrent(binding);
    if (binding.state === "creating" && binding.initialExecutionKey === executionKey && !binding.lease) {
      return { owner: this.owner };
    }
    if (binding.state !== "ready" || !binding.lease) {
      throw continuityError("continuity_source_unproven", "Another response or compaction owns the page; finish or explicitly cancel that work first.");
    }
    binding.state = "running";
    binding.executionKey = executionKey;
    return { owner: this.owner, expected: { ...binding.lease } };
  }

  acceptLease(binding: ContinuityBinding, lease: ContinuityLease): void {
    this.assertCurrent(binding);
    if (lease.owner !== this.owner || (binding.lease && binding.lease.leaseId !== lease.leaseId)) {
      this.lose(binding);
      throw continuityError("continuity_session_lost");
    }
    binding.lease = { ...lease };
    if (binding.state === "creating") {
      binding.state = "running";
      delete binding.initialAcceptedInput;
      delete binding.initialInstructionPayloadDigest;
    }
  }

  responseReady(binding: ContinuityBinding, executionKey: string, successfulWork = true): void {
    this.assertCurrent(binding);
    if (binding.executionKey !== executionKey || !binding.lease) throw continuityError("continuity_source_unproven");
    if (binding.state === "compacting") binding.compactionSourceState = "ready";
    else binding.state = "ready";
    if (successfulWork) binding.lastUsedAt = this.now();
  }

  beginCompaction(binding: ContinuityBinding, key: string, sourceExecutionKey: string, sourceEvidenceBytes = 0): ContinuityClaim {
    this.assertCurrent(binding);
    if (binding.state === "compacting" || binding.checkpoints.has(key)
      || !binding.lease || binding.executionKey !== sourceExecutionKey
      || !["ready", "running"].includes(binding.state)) {
      throw continuityError("continuity_source_unproven");
    }
    this.pruneTerminalEvidence();
    if (!Number.isSafeInteger(sourceEvidenceBytes) || sourceEvidenceBytes < 0 || sourceEvidenceBytes >= MAX_CHECKPOINT_BYTES
      || this.checkpointCount >= MAX_CHECKPOINTS || this.checkpointBytes + MAX_CHECKPOINT_BYTES > MAX_TOTAL_CHECKPOINT_BYTES) {
      throw continuityError("continuity_resource_capacity", "The retained checkpoint registry has no capacity for another bounded handoff.");
    }
    // Reserve before any summary request. Concurrent transactions cannot overbook the byte cap.
    this.checkpointBytes += MAX_CHECKPOINT_BYTES;
    this.checkpointCount += 1;
    binding.compactionSourceState = binding.state === "running" ? "running" : "ready";
    binding.state = "compacting";
    binding.compactionKey = key;
    binding.compactionEvidenceBytes = sourceEvidenceBytes;
    return { owner: this.owner, expected: { ...binding.lease } };
  }

  /** Capture the accepted result before physical settlement. It is not continuation authority. */
  acceptCompactionHandoff(binding: ContinuityBinding, key: string, sourceExecutionKey: string, summary: string): void {
    this.assertCurrent(binding);
    if (binding.state !== "compacting" || binding.compactionKey !== key
      || binding.executionKey !== sourceExecutionKey || !binding.lease) throw continuityError("continuity_source_unproven");
    if (binding.acceptedHandoff) {
      if (binding.acceptedHandoff.key !== key || binding.acceptedHandoff.sourceExecutionKey !== sourceExecutionKey
        || binding.acceptedHandoff.summary !== summary || binding.acceptedHandoff.lease.traceId !== binding.lease.traceId
        || binding.acceptedHandoff.lease.leaseId !== binding.lease.leaseId) throw continuityError("continuity_source_unproven");
      return;
    }
    const bytes = Buffer.byteLength(summary) + (binding.compactionEvidenceBytes ?? 0);
    if (bytes > MAX_CHECKPOINT_BYTES) {
      throw continuityError("continuity_resource_capacity", "The checkpoint exceeds the existing 2 MiB per-item or 24 MiB aggregate budget.");
    }
    if (!summary.trim()) throw continuityError("continuity_source_unproven", "The handoff summary is empty.");
    binding.acceptedHandoff = {
      key, sourceExecutionKey, sourceRevision: binding.revision, bytes, summary, lease: { ...binding.lease },
    };
  }

  commitCompaction(
    binding: ContinuityBinding,
    key: string,
    sourceExecutionKey: string,
    summary: string,
    preserveFinalResponse = false,
    sourceResultReplay?: ContinuityToolResultReplayEvidence,
    sourceInstructionReplay?: ContinuitySourceInstructionReplayEvidence,
  ): void {
    this.acceptCompactionHandoff(binding, key, sourceExecutionKey, summary);
    const checkpoint = continuityDigest(summary);
    const accepted = binding.acceptedHandoff!;
    const sourceRevision = binding.revision;
    binding.revision += 1;
    binding.revisionDigests.set(binding.revision, checkpoint);
    binding.revisions.set(checkpoint, binding.revision);
    binding.checkpoints.set(key, {
      sourceRevision, revision: binding.revision, sourceExecutionKey, bytes: accepted.bytes, summary: accepted.summary,
      lease: { ...accepted.lease }, preserveFinalResponse,
      ...(sourceResultReplay ? { sourceResultReplay: structuredClone(sourceResultReplay) } : {}),
      ...(sourceInstructionReplay ? { sourceInstructionReplay: structuredClone(sourceInstructionReplay) } : {}),
    });
    this.checkpointBytes += accepted.bytes - MAX_CHECKPOINT_BYTES;
    binding.compactionKey = undefined;
    binding.compactionSourceState = undefined;
    binding.compactionEvidenceBytes = undefined;
    binding.acceptedHandoff = undefined;
    binding.executionKey = undefined;
    binding.state = "ready";
    binding.lastUsedAt = this.now();
  }

  assertCompactionReplay(binding: ContinuityBinding, key: string, sourceRevision: number): void {
    this.assertCurrent(binding);
    const checkpoint = binding.checkpoints.get(key);
    if (!checkpoint || checkpoint.sourceRevision !== sourceRevision || checkpoint.revision > binding.revision
      || !binding.lease || checkpoint.lease.owner !== binding.lease.owner
      || checkpoint.lease.leaseId !== binding.lease.leaseId) {
      throw continuityError("continuity_source_unproven");
    }
  }

  /** No instruction crossed the Zero Risk control boundary; preserve the completed source. */
  abandonUndeliveredCompaction(binding: ContinuityBinding, key: string, sourceExecutionKey: string): void {
    this.assertCurrent(binding);
    if (binding.state !== "compacting" || binding.compactionKey !== key
      || binding.executionKey !== sourceExecutionKey || !binding.lease || binding.acceptedHandoff
      || !binding.compactionSourceState) throw continuityError("continuity_source_unproven");
    const sourceState = binding.compactionSourceState;
    this.checkpointCount -= 1;
    this.checkpointBytes -= MAX_CHECKPOINT_BYTES;
    binding.compactionKey = undefined;
    binding.compactionSourceState = undefined;
    binding.compactionEvidenceBytes = undefined;
    binding.state = sourceState;
  }

  /** Old cleanup can only retire the execution that still owns this binding. */
  lose(binding: ContinuityBinding, executionKey?: string): void {
    if (executionKey !== undefined && binding.executionKey !== executionKey) return;
    if (binding.state === "lost" || binding.state === "ended") return;
    binding.state = "lost";
    this.retireCheckpointAuthority(binding);
    this.registrations.finish(binding.thread, this.owner, "lost");
  }

  end(binding: ContinuityBinding): void {
    if (binding.state === "lost" || binding.state === "ended") return;
    binding.state = "ended";
    this.retireCheckpointAuthority(binding);
    this.registrations.finish(binding.thread, this.owner, "ended");
  }

  private assertCurrent(binding: ContinuityBinding): void {
    if (this.lookup(binding.thread, binding.scope) !== binding) throw continuityError("continuity_session_lost");
  }

  private retireCheckpointAuthority(binding: ContinuityBinding): void {
    delete binding.initialAcceptedInput;
    delete binding.initialInstructionPayloadDigest;
    delete binding.discoveredTools;
    releaseContinuityContinuationEvidence(binding.scope, binding.thread);
    binding.evidenceExpiresAt = this.now() + TERMINAL_EVIDENCE_TTL_MS;
    if (binding.compactionKey) {
      if (binding.acceptedHandoff) this.checkpointBytes += binding.acceptedHandoff.bytes - MAX_CHECKPOINT_BYTES;
      else {
        this.checkpointCount -= 1;
        this.checkpointBytes -= MAX_CHECKPOINT_BYTES;
      }
      binding.compactionKey = undefined;
      binding.compactionSourceState = undefined;
      binding.compactionEvidenceBytes = undefined;
    }
  }

  private pruneTerminalEvidence(): void {
    for (const binding of this.bindings.values()) {
      if ((binding.state !== "lost" && binding.state !== "ended") || binding.evidenceExpiresAt === undefined
        || binding.evidenceExpiresAt >= this.now()) continue;
      if (binding.acceptedHandoff) {
        this.checkpointCount -= 1;
        this.checkpointBytes -= binding.acceptedHandoff.bytes;
        binding.acceptedHandoff = undefined;
      }
      for (const checkpoint of binding.checkpoints.values()) {
        this.checkpointCount -= 1;
        this.checkpointBytes -= checkpoint.bytes;
      }
      binding.checkpoints.clear();
      binding.revisionDigests.clear();
      binding.revisions.clear();
      binding.ordinaryReplayTombstones.clear();
      binding.evidenceExpiresAt = undefined;
    }
  }
}

const registries = new Map<string, ContinuityBindings>();
/** An ordinary route must not initialize continuity state merely to observe a mode exit. */
export function existingContinuityBindings(directory: string): ContinuityBindings | undefined {
  return registries.get(directory);
}

export function continuityBindingsFor(directory: string): ContinuityBindings {
  let registry = registries.get(directory);
  if (!registry) {
    registry = new ContinuityBindings(new ContinuityRegistrationStore(directory));
    registries.set(directory, registry);
  }
  return registry;
}
