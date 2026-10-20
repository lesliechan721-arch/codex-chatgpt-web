import { existsSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome, getTrustedCodexHomes } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  chatGptTurnUserRevisionHistory,
  extractChatGptTurnEnvironmentClaim,
  extractChatGptEnvironmentMessageClaim,
  extractChatGptNativeCompactionPhase,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptRolloutEnvironmentMarker,
  hasCurrentChatGptEnvironmentContext,
  extractChatGptCalendarEnvironmentDelta,
  hasRawChatGptEnvironmentContext,
  unattributedChatGptEnvironmentMessages,
  nativeChatGptCompactionEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  TrustedCodexEnvironmentValidationError,
  type ChatGptEnvironmentClaim,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
  type ChatGptTurnUserRevision,
} from "./environment";
import {
  CodexRolloutPublicationPendingError,
  resolveCurrentCodexRolloutEnvironment,
  resolveCurrentCodexRolloutMessageIdAliases,
} from "./codex-rollout-environment";

/** Only fixed reason labels enter diagnostics; filesystem errors can contain private paths. */
export function trustedEnvironmentFailureDetails(error: unknown): {
  errorType: string; reason: string; errorCode?: string;
} {
  const errorType = error instanceof Error
    && [
      "Error", "TypeError", "SyntaxError", "RangeError",
      "MissingTrustedCodexEnvironmentError", "TrustedCodexEnvironmentValidationError",
    ].includes(error.name)
    ? error.name : "UnknownError";
  const reasons: Record<string, string> = {
    "ChatGPT web turn is missing cwd in trusted Codex environment context": "missing_cwd",
    "ChatGPT web turn is missing workspace_roots in trusted Codex environment context": "missing_workspace_roots",
    "ChatGPT web turn is missing network access in trusted Codex environment context": "missing_network_access",
    "ChatGPT web cwd must contain absolute paths": "relative_cwd",
    "ChatGPT web workspace_roots must contain absolute paths": "relative_workspace_roots",
    "ChatGPT web turn has conflicting trusted Codex cwd values": "conflicting_cwd",
    "ChatGPT web cwd is outside the trusted Codex workspace roots": "cwd_outside_roots",
    "ChatGPT web turn requires one explicit trusted Codex sandbox mode": "missing_sandbox_mode",
    "Compaction continuation requires one current native environment claim": "invalid_compaction_claim",
    "Compaction continuation environment conflicts with its current Codex rollout": "compaction_authority_conflict",
    "Current environment conflicts with its current Codex rollout": "current_authority_conflict",
    "Steering environment conflicts with its current Codex rollout": "steering_authority_conflict",
    "Calendar environment delta conflicts with its current Codex rollout": "calendar_authority_conflict",
    "Current Codex environment claim has no unique source message": "current_environment_source_unproven",
    "Codex rollout does not authenticate the current environment message": "current_environment_unrecorded",
    "Current environment message differs from its native Codex record": "current_environment_content_mismatch",
    "Codex thread metadata contains an invalid native identifier": "invalid_native_identifier",
    "Codex environment history repeats a message id": "duplicate_historical_message_id",
    "Codex rollout does not authenticate the historical environment messages": "historical_environment_unrecorded",
    "Historical environment message differs from its native Codex record": "historical_environment_content_mismatch",
    "ChatGPT Web thread sandbox metadata conflicts with its Codex rollout": "rollout_thread_sandbox_conflict",
    "ChatGPT Web thread workspace metadata does not contain its Codex rollout cwd": "rollout_thread_cwd_conflict",
    "ChatGPT Web thread workspace metadata conflicts with its Codex rollout roots": "rollout_thread_roots_conflict",
    "ChatGPT Web subagent sandbox metadata conflicts with its Codex rollout": "rollout_subagent_sandbox_conflict",
    "ChatGPT Web subagent workspace metadata does not contain its Codex rollout cwd": "rollout_subagent_cwd_conflict",
    "ChatGPT Web subagent workspace metadata conflicts with its Codex rollout roots": "rollout_subagent_roots_conflict",
    "ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread": "parent_sandbox_conflict",
    "ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd": "parent_cwd_conflict",
    "ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots": "parent_roots_conflict",
  };
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const errorCode = code && ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "EISDIR"].includes(code) ? code : undefined;
  const message = error instanceof Error ? error.message : "";
  const reason = Object.hasOwn(reasons, message) ? reasons[message]! : "unclassified_environment_error";
  return { errorType, reason, ...(errorCode ? { errorCode } : {}) };
}
import { ChatGptWebAdapterError } from "./adapter-error";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
  compactionSource?: TrustedCompactionSource;
}

interface TrustedCompactionSource {
  turnId: string;
  prefixLength: number;
  prefixHash: string;
  scopeHash: string;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;
const ROLLOUT_PUBLICATION_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

function rolloutPublicationAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Codex rollout publication retry aborted", "AbortError");
}

function throwIfRolloutPublicationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw rolloutPublicationAbortError(signal);
}

function waitForRolloutPublicationRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise<void>(resolveDelay => {
      setTimeout(resolveDelay, delayMs);
    });
  }
  if (signal.aborted) return Promise.reject(rolloutPublicationAbortError(signal));
  return new Promise<void>((resolveDelay, rejectDelay) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) rejectDelay(error);
      else resolveDelay();
    };
    const onAbort = () => finish(rolloutPublicationAbortError(signal));
    const timer = setTimeout(() => finish(), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

type EnvironmentLookupOutcome = "not_attempted" | "identity_unavailable" | "error" | "miss" | "hit";

export interface ChatGptEnvironmentResolutionDiagnostics {
  recovery_stage?: "request" | "current_update_rejected" | "compaction_claim" | "rollout"
    | "compaction_replay" | "raw_context_rejected" | "thread_cache" | "parent_cache";
  rollout_lookup?: EnvironmentLookupOutcome;
  thread_cache_lookup?: EnvironmentLookupOutcome;
  parent_cache_lookup?: EnvironmentLookupOutcome;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const unique = new Map<string, string>();
  for (const path of value.map(path => resolve(path as string))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    const policyRoots = absolutePaths(parsed.writableRoots, "workspace-write policy writable roots");
    const declared = new Set(policyRoots.map(pathIdentity));
    // Project membership is not the grant boundary: native Codex also authorizes
    // external output directories. Both persisted grant sets must agree exactly.
    if (typeof parsed.networkAccess !== "boolean" || policyRoots.length !== writableRoots.length
      || writableRoots.some(path => !declared.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
    ...(parsed.compactionSource === undefined ? {} : {
      compactionSource: validateCompactionSource(parsed.compactionSource),
    }),
  };
}

function validateCompactionSource(value: unknown): TrustedCompactionSource {
  const source = record(value);
  if (!source || typeof source.turnId !== "string" || !source.turnId.trim()
    || typeof source.prefixLength !== "number" || !Number.isSafeInteger(source.prefixLength) || source.prefixLength <= 0
    || typeof source.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(source.prefixHash)
    || typeof source.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(source.scopeHash)) {
    throw new Error("Invalid persisted ChatGPT compaction source");
  }
  return { turnId: source.turnId, prefixLength: source.prefixLength, prefixHash: source.prefixHash, scopeHash: source.scopeHash };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalJson(child)]),
  );
}

function canonicalCompactionPrefixItem(value: unknown): unknown {
  const item = record(value);
  if (!item || typeof item.role !== "string") return canonicalJson(value);
  if (item.type === "message") {
    const { type: _type, ...implicit } = item;
    return canonicalJson(implicit);
  }
  return canonicalJson(item);
}

function canonicalCompactionPrefixHash(input: unknown[]): string {
  return digest(input.map(canonicalCompactionPrefixItem));
}

function legacyMessageTypeVariant(value: unknown, explicit: boolean): unknown {
  const item = record(value);
  if (!item || typeof item.role !== "string") return value;
  if (explicit && item.type === undefined) return { type: "message", ...item };
  if (!explicit && item.type === "message") {
    const { type: _type, ...implicit } = item;
    return implicit;
  }
  return value;
}

function matchesCompactionPrefixHash(input: unknown[], prefixLength: number, expectedHash: string): boolean {
  const prefix = input.slice(0, prefixLength);
  return canonicalCompactionPrefixHash(prefix) === expectedHash
    // Compatibility with persisted proofs written before semantic prefix hashing. These cannot
    // represent every mixed legacy encoding, but exact/all-explicit/all-implicit proofs remain
    // valid until the next accepted ordinary turn refreshes the stored source proof.
    || digest(prefix) === expectedHash
    || digest(prefix.map(value => legacyMessageTypeVariant(value, true))) === expectedHash
    || digest(prefix.map(value => legacyMessageTypeVariant(value, false))) === expectedHash;
}

function compactionScopeValue(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): unknown[] {
  const identity = extractChatGptTurnIdentity(parsed);
  // Callers already required canonical thread/turn identity, so this metadata is valid JSON.
  const wire = record(record(parsed._rawBody)?.client_metadata)?.["x-codex-turn-metadata"];
  const metadata = record(typeof wire === "string" ? JSON.parse(wire) : wire);
  return [
    parsed.modelId, parsed.options.reasoning, source,
    identity.parentThreadId, identity.agentName, identity.subagentKind,
    metadata?.sandbox_mode ?? metadata?.sandbox,
    Object.keys(record(metadata?.workspaces) ?? {}).sort(),
  ];
}

function compactionScope(parsed: CodexParsedRequest, source: ChatGptTurnUserRevision): string {
  return digest(canonicalJson(compactionScopeValue(parsed, source)));
}

function matchesCompactionScopeHash(
  parsed: CodexParsedRequest,
  source: ChatGptTurnUserRevision,
  expectedHash: string,
): boolean {
  const value = compactionScopeValue(parsed, source);
  return digest(canonicalJson(value)) === expectedHash
    || digest(value) === expectedHash;
}

function trustedCompactionSource(parsed: CodexParsedRequest): TrustedCompactionSource | undefined {
  if (parsed._compactionRequest) return undefined;
  const identity = extractChatGptTurnIdentity(parsed);
  const input = record(parsed._rawBody)?.input;
  const source = chatGptTurnUserRevisionHistory(parsed).at(-1);
  if (!identity.threadId || !identity.turnId || !Array.isArray(input) || input.length === 0 || !source) return undefined;
  return {
    turnId: identity.turnId,
    prefixLength: input.length,
    prefixHash: canonicalCompactionPrefixHash(input),
    scopeHash: compactionScope(parsed, source),
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number, parsed: CodexParsedRequest): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
    compactionSource: trustedCompactionSource(parsed),
  };
}

function conflictingAuthorityFields(claim: ChatGptEnvironmentClaim, right: ChatGptTurnEnvironment): string[] {
  const left = claim.environment;
  const claimedRoots = new Set(left.roots.map(pathIdentity));
  const nativeRoots = new Set(right.roots.map(pathIdentity));
  const nativeGrants = new Set([...right.roots, ...right.writableRoots].map(pathIdentity));
  const fields: string[] = [];
  if (pathIdentity(left.cwd) !== pathIdentity(right.cwd)) fields.push("cwd");
  // Codex 0.163 omits workspace_roots in some rollouts while its envelope still
  // lists output directories. Every extra claimed root must be an exact native
  // grant, and no native workspace may disappear. Return only native authority.
  if ([...nativeRoots].some(root => !claimedRoots.has(root))
    || [...claimedRoots].some(root => !nativeGrants.has(root))) fields.push("workspace_roots");
  // Filesystem envelopes omit Codex's extra output directories, including after
  // compaction. Only the current native rollout supplies the returned grants.
  if (!left.writableRoots.every(path => right.writableRoots.some(root => pathIdentity(root) === pathIdentity(path)))) {
    fields.push("writable_roots");
  }
  if (left.sandboxPolicy.type !== right.sandboxPolicy.type) fields.push("sandbox_policy");
  // An envelope that does not state its network policy cannot contradict the rollout on it.
  if (left.sandboxPolicy.type !== "dangerFullAccess" && right.sandboxPolicy.type !== "dangerFullAccess"
    && claim.statesNetworkAccess && left.sandboxPolicy.networkAccess !== right.sandboxPolicy.networkAccess) {
    fields.push("network_access");
  }
  return fields;
}

function currentWorkspaceContext(
  environment: ChatGptTurnEnvironment,
  workspaceRootsDeclared: boolean,
  claim: ChatGptEnvironmentClaim | undefined,
): ChatGptTurnEnvironment {
  // Full access grants no native workspace restriction. A restart can omit its
  // roots, so retain only a matching current envelope's workspace context.
  if (!workspaceRootsDeclared
    && environment.sandboxPolicy.type === "dangerFullAccess"
    && claim?.environment.sandboxPolicy.type === "dangerFullAccess"
    && pathIdentity(claim.environment.cwd) === pathIdentity(environment.cwd)) {
    return {
      ...environment,
      roots: [...claim.environment.roots],
      writableRoots: [...claim.environment.roots],
    };
  }
  return environment;
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();
  private readonly codexHomes: readonly string[];

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
    additionalCodexHomes?: readonly string[],
  ) {
    this.codexHomes = getTrustedCodexHomes(codexHome, additionalCodexHomes);
  }

  resolve(
    parsed: CodexParsedRequest,
    diagnostics: ChatGptEnvironmentResolutionDiagnostics = {},
  ): ChatGptTurnEnvironment {
    return this.resolveOnce(parsed, diagnostics, false);
  }

  async resolveWithRolloutPublicationRetry(
    parsed: CodexParsedRequest,
    diagnostics: ChatGptEnvironmentResolutionDiagnostics = {},
    signal?: AbortSignal,
  ): Promise<ChatGptTurnEnvironment> {
    throwIfRolloutPublicationAborted(signal);
    for (let attempt = 0; attempt <= ROLLOUT_PUBLICATION_RETRY_DELAYS_MS.length; attempt += 1) {
      if (attempt > 0) {
        await waitForRolloutPublicationRetry(ROLLOUT_PUBLICATION_RETRY_DELAYS_MS[attempt - 1]!, signal);
      }
      throwIfRolloutPublicationAborted(signal);
      const finalAttempt = attempt === ROLLOUT_PUBLICATION_RETRY_DELAYS_MS.length;
      try {
        const environment = this.resolveOnce(parsed, diagnostics, !finalAttempt, false);
        throwIfRolloutPublicationAborted(signal);
        const identity = extractChatGptTurnIdentity(parsed);
        this.attachNativeMessageIdAliases(parsed, identity.turnId);
        return environment;
      } catch (error) {
        if (!(error instanceof CodexRolloutPublicationPendingError) || finalAttempt) throw error;
      }
    }
    throw new Error("Unreachable rollout publication retry state");
  }

  private resolveOnce(
    parsed: CodexParsedRequest,
    diagnostics: ChatGptEnvironmentResolutionDiagnostics,
    publicationPendingIsTransient: boolean,
    recoverNativeMessageIdAliases = true,
  ): ChatGptTurnEnvironment {
    diagnostics.recovery_stage = "request";
    diagnostics.rollout_lookup = "not_attempted";
    diagnostics.thread_cache_lookup = "not_attempted";
    diagnostics.parent_cache_lookup = "not_attempted";
    delete parsed._chatGptMessageIdAliases;
    delete parsed._chatGptCompactionSourceTurnId;
    const identity = extractChatGptTurnIdentity(parsed);
    const compactionPhase = extractChatGptNativeCompactionPhase(parsed);
    const nativeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (compactionPhase && (nativeId.test(identity.threadId ?? "") || nativeId.test(identity.turnId ?? ""))) {
      const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
      if (!lineage || !identity.turnId) {
        throw new TrustedCodexEnvironmentValidationError("Native Codex compaction has no complete source identity");
      }
      // The current permission turn does not prove the human source. Authenticate before any
      // XML/cache return, including the retry path that defers optional alias attachment.
      const source = extractChatGptCompactionSourceRevision(parsed);
      const messages = nativeChatGptCompactionEnvironmentMessages(parsed);
      const native = resolveCurrentCodexRolloutEnvironment({
        codexHome: this.codexHomes[0]!, additionalCodexHomes: this.codexHomes.slice(1),
        ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
        lineage, turnId: identity.turnId, compactionSource: source, compactionPhase,
        ...(source.turnId ? { compactionSourceTurnId: source.turnId } : {}),
        ...(messages.current ? { currentEnvironmentMessage: messages.current } : {}),
        historicalEnvironmentMessages: messages.historical,
        validateCurrentEnvironmentMessage(message, environment, workspaceRootsDeclared) {
          const claim = extractChatGptEnvironmentMessageClaim(parsed, message);
          if (conflictingAuthorityFields(claim, currentWorkspaceContext(environment, workspaceRootsDeclared, claim)).length > 0) {
            throw new TrustedCodexEnvironmentValidationError("Current environment conflicts with its current Codex rollout");
          }
        },
        tools: parsed.context.tools, publicationPendingIsTransient,
      });
      if (!native) {
        if (publicationPendingIsTransient) throw new CodexRolloutPublicationPendingError("Codex compaction rollout is not published yet");
        throw new TrustedCodexEnvironmentValidationError("The trusted Codex environment has no authenticated native compaction source rollout");
      }
      if (messages.current) {
        const claim = extractChatGptEnvironmentMessageClaim(parsed, messages.current);
        if (conflictingAuthorityFields(claim, currentWorkspaceContext(native.environment, native.workspaceRootsDeclared, claim)).length > 0) {
          throw new TrustedCodexEnvironmentValidationError("Current environment conflicts with its current Codex rollout");
        }
      }
    }
    if (recoverNativeMessageIdAliases) this.attachNativeMessageIdAliases(parsed, identity.turnId);
    let initialClaim: ChatGptEnvironmentClaim | undefined;
    try {
      const claim = extractChatGptTurnEnvironmentClaim(parsed);
      const environment = claim.environment;
      if (this.codexHomes.length > 1
        || (environment.sandboxPolicy.type !== "dangerFullAccess" && !claim.statesNetworkAccess)) {
        // A shared bridge must prove the current native owner even for complete envelopes.
        // Modern envelopes state filesystem access only. Resolve the current native policy on
        // the first round too: absence of a network statement is not a disabled-network grant.
        initialClaim = claim;
        throw new MissingTrustedCodexEnvironmentError(
          this.codexHomes.length > 1 ? "current native task ownership" : "network access",
        );
      }
      if (identity.threadId) this.set(identity.threadId, environment, parsed);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      // Root tasks also retain unattributed environment fragments after compaction.
      // They are historical only when the exact native record predates this task;
      // neither the fragment nor the cache supplies the current authority.
      const historicalMessages = hasCurrentContext && !currentCompaction
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      const rolloutMarker = hasCurrentContext && !currentCompaction
        && hasCurrentChatGptRolloutEnvironmentMarker(parsed);
      const steeringClaim = hasCurrentContext && !currentCompaction
        ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
      const calendarDelta = hasCurrentContext && !currentCompaction
        ? extractChatGptCalendarEnvironmentDelta(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction
        && !initialClaim && !historicalMessages && !rolloutMarker && !steeringClaim && !calendarDelta) {
        diagnostics.recovery_stage = "current_update_rejected";
        throw error;
      }
      if (currentCompaction) diagnostics.recovery_stage = "compaction_claim";
      const currentClaim = initialClaim ?? (currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim);
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      diagnostics.rollout_lookup = "identity_unavailable";
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSource = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed) : undefined;
      if (initialClaim && !initialClaim.sourceMessage) {
        throw new TrustedCodexEnvironmentValidationError("Current Codex environment claim has no unique source message");
      }
      if (rolloutIdentity && identity.turnId) {
        // Shared homes require current native proof for complete envelopes and follow-ups too.
        const waitForPublication = publicationPendingIsTransient && (rolloutMarker || this.codexHomes.length > 1);
        diagnostics.recovery_stage = "rollout";
        diagnostics.rollout_lookup = "error";
        const rollout = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHomes[0]!,
          additionalCodexHomes: this.codexHomes.slice(1),
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSource?.turnId ? { compactionSourceTurnId: compactionSource.turnId } : {}),
          ...(compactionSource ? { compactionSource } : {}),
          ...(extractChatGptNativeCompactionPhase(parsed) ? { compactionPhase: extractChatGptNativeCompactionPhase(parsed) } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          ...(initialClaim?.sourceMessage ? { currentEnvironmentMessage: initialClaim.sourceMessage } : {}),
          validateCurrentEnvironmentMessage(message, nativeEnvironment, workspaceRootsDeclared) {
            const claim = extractChatGptEnvironmentMessageClaim(parsed, message);
            if (conflictingAuthorityFields(claim, currentWorkspaceContext(nativeEnvironment, workspaceRootsDeclared, claim)).length > 0) {
              throw new TrustedCodexEnvironmentValidationError("Current environment conflicts with its current Codex rollout");
            }
          },
          tools: parsed.context.tools,
          publicationPendingIsTransient: waitForPublication,
        });
        if (!rollout && waitForPublication) {
          throw new CodexRolloutPublicationPendingError(
            "Codex canonical rollout is not published yet",
          );
        }
        diagnostics.rollout_lookup = rollout ? "hit" : "miss";
        if (rollout) {
          const rolloutEnvironment = currentWorkspaceContext(rollout.environment, rollout.workspaceRootsDeclared, currentClaim);
          if (calendarDelta) {
            const nativeRoots = new Set(rolloutEnvironment.roots.map(pathIdentity));
            if (rolloutEnvironment.sandboxPolicy.type !== "dangerFullAccess"
              || calendarDelta.workspaceRoots.some(roots => roots.length !== nativeRoots.size
                || roots.some(root => !nativeRoots.has(root)))) {
              throw new TrustedCodexEnvironmentValidationError("Calendar environment delta conflicts with its current Codex rollout");
            }
          }
          const conflicts = currentClaim ? conflictingAuthorityFields(currentClaim, rolloutEnvironment) : [];
          if (conflicts.length > 0) {
            const source = currentCompaction ? "Compaction continuation" : initialClaim ? "Current" : "Steering";
            // Export fixed field names only; keep paths and permission contents private.
            console.warn(`[chatgpt-web] trusted environment conflict (source=${source}, fields=${conflicts.join(",")})`);
            throw new TrustedCodexEnvironmentValidationError(
              `${source} environment conflicts with its current Codex rollout`,
            );
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment, parsed);
          return rolloutEnvironment;
        }
      }
      console.warn(`[chatgpt-web] trusted_environment_recovery ${JSON.stringify({
        currentContext: hasCurrentContext,
        compactionContinuation: currentCompaction,
        nativeMetadata: rolloutIdentity !== undefined,
        nativeTurnId: identity.turnId !== undefined,
        registeredHomes: this.codexHomes.length,
        nativeRolloutFound: false,
      })}`);
      if (this.codexHomes.length > 1) {
        throw new Error("No current native Codex task proof in the trusted homes", { cause: error });
      }
      // Custom-provider compaction can replay full history without previous_response_id. Bind
      // that history to an input previously accepted with this exact trusted authority, not to
      // XML supplied by this request. Current updates and unproven suffixes remain fail-closed.
      if (!hasCurrentContext && parsed._compactionRequest) diagnostics.recovery_stage = "compaction_replay";
      const replay = !hasCurrentContext && parsed._compactionRequest
        ? this.compactionReplay(parsed, identity.threadId) : undefined;
      if (replay) return replay;
      // Without native rollout or authenticated replay proof, do not turn arbitrary history or
      // an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed)) {
        diagnostics.recovery_stage = "raw_context_rejected";
        throw error;
      }
      diagnostics.recovery_stage = "thread_cache";
      diagnostics.thread_cache_lookup = "error";
      const sameThread = this.get(identity.threadId);
      diagnostics.thread_cache_lookup = sameThread ? "hit" : "miss";
      if (sameThread) {
        if (!parsed._compactionRequest) {
          // Do not let an older source proof survive a later environment-less native turn.
          // Updating provenance must not extend the lifetime of the cached authority itself.
          sameThread.compactionSource = trustedCompactionSource(parsed);
          this.persist();
        }
        return {
          cwd: sameThread.cwd,
          roots: sameThread.roots,
          writableRoots: sameThread.writableRoots,
          sandboxPolicy: sameThread.sandboxPolicy,
          tools: parsed.context.tools ?? [],
        };
      }

      if (!lineage) throw error;
      diagnostics.recovery_stage = "parent_cache";
      diagnostics.parent_cache_lookup = "error";
      const parent = this.get(lineage.parentThreadId);
      diagnostics.parent_cache_lookup = parent ? "hit" : "miss";
      if (!parent) throw error;
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new TrustedCodexEnvironmentValidationError(
          "ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread",
        );
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new TrustedCodexEnvironmentValidationError(
          "ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd",
        );
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new TrustedCodexEnvironmentValidationError(
          "ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots",
        );
      }
      const inherited: ChatGptTurnEnvironment = {
        cwd: parent.cwd,
        roots: parent.roots,
        writableRoots: parent.writableRoots,
        sandboxPolicy: parent.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      this.set(lineage.threadId, inherited, parsed);
      return inherited;
    }
  }

  private attachNativeMessageIdAliases(parsed: CodexParsedRequest, turnId?: string): void {
    delete parsed._chatGptMessageIdAliases;
    delete parsed._chatGptCompactionSourceTurnId;
    if (!turnId) return;
    try {
      const compactionSource = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed)
        : undefined;
      const revisions = compactionSource ? [compactionSource] : chatGptTurnUserRevisionHistory(parsed);
      const aliasTurnId = compactionSource?.turnId ?? turnId;
      // A standalone compaction envelope owns a new turn id. Its source execution key must use
      // the retained instruction's native turn. Real local-compaction wire history can omit that
      // turn id, so rollout evidence must be allowed to authenticate the exact retained source.
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      if (!rolloutIdentity) return;
      const resolved = resolveCurrentCodexRolloutMessageIdAliases({
        codexHome: this.codexHomes[0]!,
        additionalCodexHomes: this.codexHomes.slice(1),
        ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
        lineage: rolloutIdentity,
        turnId: aliasTurnId,
        revisions,
        ...(compactionSource ? {
          compactionSource, compactionTurnId: turnId,
          ...(extractChatGptNativeCompactionPhase(parsed) ? { compactionPhase: extractChatGptNativeCompactionPhase(parsed) } : {}),
        } : {}),
      });
      if (resolved?.aliases) parsed._chatGptMessageIdAliases = resolved.aliases;
      if (compactionSource && resolved?.turnId) parsed._chatGptCompactionSourceTurnId = resolved.turnId;
    } catch {
      // Alias recovery changes replay identity only. Normal environment validation below remains
      // authoritative, so missing or malformed optional identity evidence must not change it.
    }
  }

  private compactionReplay(parsed: CodexParsedRequest, threadId: string): ChatGptTurnEnvironment | undefined {
    const stored = this.get(threadId);
    const proof = stored?.compactionSource;
    const input = record(parsed._rawBody)?.input;
    const identity = extractChatGptTurnIdentity(parsed);
    if (!stored || !proof || !identity.turnId || !Array.isArray(input) || input.length < proof.prefixLength) return undefined;
    const source = extractChatGptCompactionSourceRevision(parsed);
    // Standalone compaction has a new turn id; its source must still be the recorded native turn.
    if (identity.turnId !== proof.turnId && source.turnId !== proof.turnId) return undefined;
    if (!matchesCompactionScopeHash(parsed, source, proof.scopeHash)
      || !matchesCompactionPrefixHash(input, proof.prefixLength, proof.prefixHash)) return undefined;
    const suffix = input.slice(proof.prefixLength).map(value => {
      const item = record(value);
      return item && item.type === undefined && item.role ? { ...item, type: "message" } : value;
    });
    if (hasRawChatGptEnvironmentContext({ ...parsed, _rawBody: { input: suffix } })) return undefined;
    return {
      cwd: stored.cwd, roots: stored.roots, writableRoots: stored.writableRoots,
      sandboxPolicy: stored.sandboxPolicy, tools: parsed.context.tools ?? [],
    };
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    if (this.codexHomes.length > 1) return undefined;
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment, parsed: CodexParsedRequest): void {
    // Shared-home recovery requires current native proof and does not use this cache.
    if (this.codexHomes.length > 1) return;
    // Only this path has already verified authority from the current request, native
    // rollout, or a successfully loaded parent. A cache read alone may never recover it.
    this.load(true);
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now(), parsed));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(verifiedEnvironment = false): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    const invalidState = (reason: string) => new ChatGptWebAdapterError(
      `The saved Codex task environment file (thread-environments.json) ${reason}. `
      + "Its contents have not been overwritten. Start a fresh Codex task to supply its current workspace and permissions. "
      + "If that also fails, export Activity > Export safe log; do not delete your launcher settings.",
      { status: 409, errorType: "invalid_request_error", code: "thread_environment_state_invalid", retryable: false },
    );
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedEnvironment) throw invalidState("contains invalid JSON");
      // Preserve the original for diagnosis. Never infer permissions from a damaged cache,
      // discard an unfamiliar schema, or turn a read/rename permission error into recovery.
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery");
      const backup = `${this.path}.corrupt-${crypto.randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt thread-environments.json beside the original; rebuilding from a verified current Codex environment");
      this.loaded = true;
      return;
    }
    const parsed = record(decoded);
    const rawThreads = record(parsed?.threads);
    if (parsed?.version !== 1 || !rawThreads) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredThreadEnvironment]>;
    try {
      const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
      entries = Object.entries(rawThreads)
        .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
        .filter(([, environment]) => environment.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_THREAD_ENVIRONMENTS);
    } catch {
      throw invalidState("contains invalid workspace or permission records");
    }
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
    this.loaded = true;
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
  }
}
