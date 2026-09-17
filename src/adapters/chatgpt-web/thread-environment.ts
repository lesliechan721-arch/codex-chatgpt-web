import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import { getCodexHome } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  chatGptTurnUserRevisionHistory,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
  hasRawChatGptEnvironmentContext,
  unattributedChatGptEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
  type ChatGptTurnUserRevision,
} from "./environment";
import {
  resolveCurrentCodexRolloutEnvironment,
  resolveCurrentCodexRolloutMessageIdAliases,
} from "./codex-rollout-environment";

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
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.some(path => !roots.some(root => contains(root, path)))) {
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

function sameAuthority(left: ChatGptTurnEnvironment, right: ChatGptTurnEnvironment): boolean {
  const samePaths = (a: string[], b: string[]): boolean => {
    const expected = new Set(b.map(pathIdentity));
    return a.length === expected.size && a.every(path => expected.has(pathIdentity(path)));
  };
  return pathIdentity(left.cwd) === pathIdentity(right.cwd)
    && samePaths(left.roots, right.roots)
    && samePaths(left.writableRoots, right.writableRoots)
    && left.sandboxPolicy.type === right.sandboxPolicy.type
    && (left.sandboxPolicy.type === "dangerFullAccess" || (right.sandboxPolicy.type !== "dangerFullAccess"
      && left.sandboxPolicy.networkAccess === right.sandboxPolicy.networkAccess));
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    private readonly codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    this.attachNativeMessageIdAliases(parsed, identity.turnId);
    try {
      const environment = extractChatGptTurnEnvironment(parsed);
      if (identity.threadId) this.set(identity.threadId, environment, parsed);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      const historicalMessages = hasCurrentContext && !currentCompaction && lineage
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction && !historicalMessages) throw error;
      const currentClaim = currentCompaction ? extractChatGptContinuationEnvironmentClaim(parsed) : undefined;
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSource = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed) : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rolloutEnvironment = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHome,
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSource?.turnId ? { compactionSourceTurnId: compactionSource.turnId } : {}),
          ...(compactionSource && !compactionSource.turnId ? { compactionSource } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          tools: parsed.context.tools,
        });
        if (rolloutEnvironment) {
          if (currentClaim && !sameAuthority(currentClaim, rolloutEnvironment)) {
            throw new Error("Compaction continuation environment conflicts with its current Codex rollout");
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment, parsed);
          return rolloutEnvironment;
        }
      }
      // Custom-provider compaction can replay full history without previous_response_id. Bind
      // that history to an input previously accepted with this exact trusted authority, not to
      // XML supplied by this request. Current updates and unproven suffixes remain fail-closed.
      const replay = !hasCurrentContext && parsed._compactionRequest
        ? this.compactionReplay(parsed, identity.threadId) : undefined;
      if (replay) return replay;
      // Without native rollout or authenticated replay proof, do not turn arbitrary history or
      // an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed)) throw error;
      const sameThread = this.get(identity.threadId);
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
      const parent = this.get(lineage.parentThreadId);
      if (!parent) throw error;
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
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
        codexHome: this.codexHome,
        ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
        lineage: rolloutIdentity,
        turnId: aliasTurnId,
        revisions,
        ...(compactionSource && !compactionSource.turnId ? { compactionSource } : {}),
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
    this.load();
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now(), parsed));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredThreadEnvironmentFile>;
    const rawThreads = record(parsed.threads);
    if (parsed.version !== 1 || !rawThreads) {
      throw new Error(`Invalid ChatGPT thread environment store: ${this.path}`);
    }
    const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
    const entries = Object.entries(rawThreads)
      .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
      .filter(([, environment]) => environment.updatedAt >= cutoff)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_THREAD_ENVIRONMENTS);
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
