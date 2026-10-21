import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expandUserPath } from "../../config";
import { findTopLevelAssignment } from "../../codex-integration-document";
import type { CodexTool } from "../../types";
import { TrustedCodexEnvironmentValidationError } from "./environment";
import type {
  ChatGptRootThreadMetadata,
  ChatGptThreadSpawnLineage,
  ChatGptTurnEnvironment,
  ChatGptTurnUserRevision,
  ChatGptUnattributedEnvironmentMessage,
  ChatGptNativeCompactionPhase,
  ChatGptNativeInstructionOwnership,
} from "./environment";

type RolloutIdentity = ChatGptRootThreadMetadata | ChatGptThreadSpawnLineage;

export interface CodexRolloutEnvironment {
  environment: ChatGptTurnEnvironment;
  workspaceRootsDeclared: boolean;
  currentInstructionOwnership?: ChatGptNativeInstructionOwnership;
}

const CODEX_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CODEX_ID = new RegExp(`^${CODEX_ID_SOURCE}$`, "i");
const ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_ROLLOUT_JSON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ROLLOUT_DIRECTORY_ENTRIES = 100_000;

type IndexedRollout =
  | { kind: "unavailable" }
  | { kind: "absent" }
  | { kind: "found"; path: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? toNamespacedPath(normalized).toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "ENOENT";
}

function matchesAgentPath(value: unknown, expected: string): boolean {
  // V1 reports /root without an assigned path; rollout metadata can omit the field.
  return expected === "/root" ? value == null : value === expected;
}

function canonicalRolloutName(name: string, threadId: string): boolean {
  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${escapedThreadId}(?:_${CODEX_ID_SOURCE})?\\.jsonl$`,
    "i",
  ).test(name);
}

function configuredSqliteHome(codexHome: string, explicit?: string, inheritEnvironment = true): string {
  if (explicit) return resolve(explicit);

  const configPath = join(codexHome, "config.toml");
  if (existsSync(configPath)) {
    const configured = findTopLevelAssignment(
      readFileSync(configPath, "utf8").split(/\r\n|\n|\r/),
      "sqlite_home",
    );
    if (configured.present) {
      const value = configured.value?.trim();
      if (!value) throw new Error("sqlite_home in Codex config must not be empty");
      return resolve(codexHome, expandUserPath(value));
    }
  }

  const environmentValue = inheritEnvironment ? process.env.CODEX_SQLITE_HOME?.trim() : undefined;
  return resolve(environmentValue ? expandUserPath(environmentValue) : codexHome);
}

function indexedRollout(
  sqliteHome: string,
  identity: RolloutIdentity,
): IndexedRollout {
  const databasePath = join(sqliteHome, "state_5.sqlite");
  if (!existsSync(databasePath)) return { kind: "unavailable" };
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const row = database.query(`
      SELECT t.rollout_path, t.agent_path, e.parent_thread_id, e.status
      FROM threads AS t
      LEFT JOIN thread_spawn_edges AS e ON e.child_thread_id = t.id
      WHERE t.id = ?
      LIMIT 1
    `).get(identity.threadId) as {
      rollout_path?: unknown;
      agent_path?: unknown;
      parent_thread_id?: unknown;
      status?: unknown;
    } | null;
    if (!row) return { kind: "absent" };
    const child = "parentThreadId" in identity;
    const matchesOwner = child
      ? matchesAgentPath(row.agent_path, identity.agentName)
        && row.parent_thread_id === identity.parentThreadId && row.status === "open"
      : row.parent_thread_id == null && (row.agent_path == null || row.agent_path === "/root");
    if (typeof row.rollout_path !== "string" || !matchesOwner) {
      throw new Error(`Codex state does not authenticate the requested ${child ? "subagent" : "root thread"} rollout`);
    }
    return { kind: "found", path: row.rollout_path };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Codex state does not authenticate the requested ")) {
      throw error;
    }
    // State storage is optional in Codex. A missing/older schema does not create authority; the
    // canonical rollout itself can still prove the exact thread, its lineage, and current turn.
    return { kind: "unavailable" };
  } finally {
    database?.close();
  }
}

function validateRolloutPath(codexHome: string, candidate: string, threadId: string): string {
  if (!isAbsolute(candidate)) throw new Error("Codex state returned a non-absolute rollout path");
  const sessionsRoot = realpathSync(join(codexHome, "sessions"));
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Codex rollout path is a symbolic link");
  const rolloutPath = realpathSync(candidate);
  if (!lstatSync(rolloutPath).isFile()) throw new Error("Codex rollout path is not a regular file");
  if (!contains(sessionsRoot, rolloutPath)) throw new Error("Codex rollout path escapes the sessions directory");
  if (!canonicalRolloutName(basename(rolloutPath), threadId)) {
    throw new Error("Codex rollout filename does not belong to the requested thread");
  }
  return rolloutPath;
}

function scanCanonicalRollouts(codexHome: string, threadId: string): string[] {
  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const matches: string[] = [];
  let visited = 0;
  const visitLevel = (path: string, depth: number): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_ROLLOUT_DIRECTORY_ENTRIES) {
        throw new Error("Codex sessions directory is too large for an unindexed rollout lookup");
      }
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (depth < 3) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) visitLevel(child, depth + 1);
        continue;
      }
      if (entry.isFile() && canonicalRolloutName(entry.name, threadId)) matches.push(child);
    }
  };
  visitLevel(sessionsRoot, 0);
  return matches;
}

function currentRolloutOwner(options: {
  codexHome: string;
  additionalCodexHomes?: readonly string[];
  sqliteHome?: string;
  lineage: RolloutIdentity;
}): { home: string; indexed: IndexedRollout; candidates: string[] } | undefined {
  // Select the owner before reading permissions, source proofs, or aliases. A stale
  // copy in another registered home is still ambiguous ownership.
  const owners = [options.codexHome, ...(options.additionalCodexHomes ?? [])].map((home, index) => {
    const indexed = indexedRollout(configuredSqliteHome(
      home, index === 0 ? options.sqliteHome : undefined, index === 0,
    ), options.lineage);
    const candidates = indexed.kind === "found"
      ? [indexed.path] : scanCanonicalRollouts(home, options.lineage.threadId);
    return { home, indexed, candidates };
  }).filter(owner => owner.candidates.length > 0);
  if (owners.length > 1) throw new Error("Codex thread exists in multiple trusted homes");
  return owners[0];
}

function parseJsonLine(line: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line.toString("utf8").replace(/^\uFEFF/, ""));
    const item = record(parsed);
    if (!item) throw new Error("not an object");
    return item;
  } catch (error) {
    throw new Error("Codex rollout contains an invalid complete JSONL record", { cause: error });
  }
}

function firstRolloutRecord(fd: number, size: number): Record<string, unknown> {
  let position = 0;
  let buffered = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count <= 0) break;
    position += count;
    buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
    const newline = buffered.indexOf(0x0a);
    if (newline >= 0) return parseJsonLine(buffered.subarray(0, newline));
    if (buffered.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout session metadata exceeds the bounded JSONL record size");
    }
  }
  throw new Error("Codex rollout has no complete session metadata record");
}

function latestRolloutRecord(
  fd: number, size: number, matches: (item: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let position = size;
  let carry = Buffer.alloc(0);
  let firstSegmentAtEof = true;
  const fileEndsWithNewline = (() => {
    if (size === 0) return false;
    const byte = Buffer.alloc(1);
    return readSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 0x0a;
  })();

  while (position > 0) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count !== length) throw new Error("Codex rollout changed during authority lookup");
    const data = Buffer.concat([chunk, carry]);
    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(index + 1, lineEnd);
      const trailingPartial = firstSegmentAtEof && !fileEndsWithNewline;
      firstSegmentAtEof = false;
      lineEnd = index;
      if (trailingPartial || line.length === 0) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
        throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      }
      const item = parseJsonLine(line);
      if (matches(item)) return item;
    }
    carry = Buffer.from(data.subarray(0, lineEnd));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout JSONL record exceeds the bounded record size");
    }
  }
  if (carry.length === 0) return undefined;
  const item = parseJsonLine(carry);
  return matches(item) ? item : undefined;
}

interface LocatedRolloutRecord {
  item: Record<string, unknown>;
  order: number;
  activeTurn: unknown;
}

function visitRolloutRecords(fd: number, size: number, visit: (entry: LocatedRolloutRecord) => void): void {
  let activeTurn: unknown;
  let position = 0;
  let order = 0;
  let carry = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    if (readSync(fd, chunk, 0, length, position) !== length) throw new Error("Codex rollout changed during provenance lookup");
    position += length;
    const data = Buffer.concat([carry, chunk]);
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, end);
      start = end + 1;
      if (!line.length) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      const item = parseJsonLine(line);
      const payload = record(item.payload);
      if (item.type === "event_msg" && payload?.type === "task_started") activeTurn = payload.turn_id;
      visit({ item, order: order++, activeTurn });
    }
    carry = Buffer.from(data.subarray(start));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) throw new Error("Codex rollout JSONL record exceeds the bounded record size");
  }
  // Partial records are never provenance evidence.
}

/** A current human after the latest checkpoint must have its own exact native record. */
function currentInstructionOwnership(fd: number, size: number, turnId: string,
  instruction: ChatGptTurnUserRevision): ChatGptNativeInstructionOwnership | undefined {
  if (!instruction.itemId || (instruction.turnId !== undefined && instruction.turnId !== turnId)) return undefined;
  let checkpoint: LocatedRolloutRecord | undefined, context: LocatedRolloutRecord | undefined;
  const boundaries: LocatedRolloutRecord[] = [], matches: LocatedRolloutRecord[] = [];
  visitRolloutRecords(fd, size, entry => {
    const payload = record(entry.item.payload);
    if (entry.item.type === "compacted") checkpoint = entry;
    if (entry.item.type === "turn_context") context = entry;
    if (entry.item.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === turnId) boundaries.push(entry);
    if (entry.item.type === "response_item" && payload?.id === instruction.itemId) matches.push(entry);
  });
  if (!checkpoint || !context || boundaries.length !== 1 || matches.length !== 1) return undefined;
  const boundary = boundaries[0]!, original = matches[0]!, payload = record(original.item.payload)!;
  const provenance = record(payload.internal_chat_message_metadata_passthrough);
  const kinds = provenance?.content_item_kinds;
  if (!(checkpoint.order < boundary.order && boundary.order < context.order && context.order < original.order)
    || record(context.item.payload)?.turn_id !== turnId || context.activeTurn !== turnId
    || original.activeTurn !== turnId || payload.type !== "message" || payload.role !== "user"
    || provenance?.turn_id !== turnId || !Array.isArray(payload.content) || !Array.isArray(kinds)
    || kinds.length === 0 || kinds.length !== payload.content.length || !kinds.every(kind => kind === "user.text")
    || !isDeepStrictEqual(payload.content, instruction.content)) return undefined;
  return { itemId: instruction.itemId, turnId,
    contentDigest: createHash("sha256").update(canonicalJson(payload.content)).digest("hex") };
}

interface NativeCompactionSourceProof {
  sourceTurnId: string;
  environmentTurnId: string;
}

/** Retained human ownership and the latest permission turn can differ only in a proved checkpoint. */
function authenticateCompactionSource(
  fd: number, size: number, source: ChatGptTurnUserRevision | undefined, latestTurnId: unknown,
  currentTurnId?: string, phase?: ChatGptNativeCompactionPhase,
): NativeCompactionSourceProof | undefined {
  if (!source?.itemId || typeof latestTurnId !== "string") return undefined;
  // Local compaction re-ids retained human messages. Only the latest replacement history is
  // current; neither guardian_history nor a message removed by a later compact is proof.
  const item = latestRolloutRecord(fd, size, item => item.type === "compacted"
    || (item.type === "response_item" && record(item.payload)?.id === source.itemId));
  const replacement = record(item?.payload)?.replacement_history;
  const matches = Array.isArray(replacement)
    ? replacement.map(record).filter(message => message?.id === source.itemId) : [];
  const payload = item?.type === "compacted"
    ? matches.length === 1 ? matches[0] : undefined : record(item?.payload);
  if (payload?.type === "message" && payload.role === "user"
    && record(payload.internal_chat_message_metadata_passthrough)?.turn_id === latestTurnId
    && (source.turnId === undefined || source.turnId === latestTurnId)
    && isDeepStrictEqual(payload.content, source.content)
    && (item?.type !== "compacted" || record(record(item.payload)?.resume_metadata)?.last_started_turn_id === undefined)) {
    if (phase && currentTurnId) {
      const originals: LocatedRolloutRecord[] = [];
      let boundary: LocatedRolloutRecord | undefined;
      visitRolloutRecords(fd, size, entry => {
        const value = record(entry.item.payload);
        if (entry.item.type === "response_item" && value?.id === source.itemId) originals.push(entry);
        if (entry.item.type === "event_msg" && value?.type === "task_started" && value.turn_id === currentTurnId) boundary = entry;
      });
      const original = originals[0];
      const kinds = record(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
      if (originals.length !== 1 || !original || original.activeTurn !== latestTurnId || !boundary
        || (currentTurnId !== latestTurnId && original.order >= boundary.order)
        || !Array.isArray(kinds) || !kinds.includes("user.text")
        || kinds.some(kind => typeof kind !== "string" || !kind.startsWith("user."))) return undefined;
    }
    return { sourceTurnId: latestTurnId, environmentTurnId: latestTurnId };
  }
  if (!phase || !currentTurnId || item?.type !== "compacted" || matches.length !== 1 || !payload) return undefined;
  const checkpoint = record(item.payload);
  const provenance = record(payload.internal_chat_message_metadata_passthrough);
  const sourceTurnId = provenance?.turn_id;
  const kinds = provenance?.content_item_kinds;
  if (payload.type !== "message" || payload.role !== "user" || typeof sourceTurnId !== "string"
    || (source.turnId !== undefined && source.turnId !== sourceTurnId)
    || !isDeepStrictEqual(payload.content, source.content) || !Array.isArray(kinds)
    || !kinds.includes("user.text") || kinds.some(kind => typeof kind !== "string" || !kind.startsWith("user."))
    || !Array.isArray(payload.content) || kinds.length !== payload.content.length
    || record(checkpoint?.resume_metadata)?.last_started_turn_id !== latestTurnId) return undefined;
  const metadata = checkpoint?.replacement_history_metadata;
  const sourceIndex = Array.isArray(replacement) ? replacement.findIndex(message => record(message)?.id === source.itemId) : -1;
  const retained = Array.isArray(metadata) && Array.isArray(replacement) && metadata.length === replacement.length
    ? record(record(metadata[sourceIndex])?.retained_source) : undefined;
  const retainedId = record(retained?.id);
  if (retained?.complete !== true || retainedId?.message_id !== source.itemId
    || retainedId.turn_id !== sourceTurnId || retainedId.role !== "user") return undefined;

  let checkpointLocation: LocatedRolloutRecord | undefined;
  let contextLocation: LocatedRolloutRecord | undefined;
  let boundary: LocatedRolloutRecord | undefined;
  const originals: LocatedRolloutRecord[] = [];
  visitRolloutRecords(fd, size, entry => {
    const value = record(entry.item.payload);
    if (entry.item.type === "compacted") checkpointLocation = entry;
    if (entry.item.type === "turn_context") contextLocation = entry;
    if (entry.item.type === "event_msg" && value?.type === "task_started" && value.turn_id === currentTurnId) boundary = entry;
    if (entry.item.type === "response_item" && value?.id === source.itemId) originals.push(entry);
  });
  if (!checkpointLocation || !contextLocation || !boundary
    || checkpointLocation.activeTurn !== latestTurnId || boundary.activeTurn !== currentTurnId
    || !(checkpointLocation.order < contextLocation.order && contextLocation.order < boundary.order)
    || record(contextLocation.item.payload)?.turn_id !== latestTurnId || originals.length !== 1) return undefined;
  const originalLocation = originals[0]!;
  const original = record(originalLocation.item.payload)!;
  const originalProvenance = record(original.internal_chat_message_metadata_passthrough);
  if (originalLocation.order >= checkpointLocation.order || originalLocation.activeTurn !== sourceTurnId
    || original.type !== "message" || original.role !== "user" || originalProvenance?.turn_id !== sourceTurnId
    || !isDeepStrictEqual(originalProvenance.content_item_kinds, kinds)
    || !isDeepStrictEqual(original.content, source.content)) return undefined;
  return { sourceTurnId, environmentTurnId: latestTurnId };
}

interface NativeUserMessageIdentity {
  id: string;
  turnId: string;
  content: unknown;
}

function nativeUserMessageIdentity(value: unknown): NativeUserMessageIdentity | undefined {
  const payload = record(value);
  const turnId = record(payload?.internal_chat_message_metadata_passthrough)?.turn_id;
  return payload?.type === "message" && payload.role === "user"
    && typeof payload.id === "string" && payload.id.length > 0
    && typeof turnId === "string" && turnId.length > 0
    ? { id: payload.id, turnId, content: payload.content }
    : undefined;
}

function originalResponseItemIds(
  fd: number,
  size: number,
  replacements: NativeUserMessageIdentity[],
): Map<string, Set<string>> {
  const matches = new Map(replacements.map(message => [message.id, new Set<string>()]));
  let position = 0;
  let carry = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count !== length) throw new Error("Codex rollout changed during message identity lookup");
    position += length;
    const data = Buffer.concat([carry, chunk]);
    let start = 0;
    for (let end = data.indexOf(0x0a); end >= 0; end = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, end);
      start = end + 1;
      if (!line.length) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
        throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      }
      const item = parseJsonLine(line);
      if (item.type !== "response_item") continue;
      const candidate = nativeUserMessageIdentity(item.payload);
      if (!candidate) continue;
      for (const replacement of replacements) {
        if (candidate.id === replacement.id || candidate.turnId !== replacement.turnId
          || !isDeepStrictEqual(candidate.content, replacement.content)) continue;
        matches.get(replacement.id)!.add(candidate.id);
      }
    }
    carry = Buffer.from(data.subarray(start));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout JSONL record exceeds the bounded record size");
    }
  }
  // A trailing partial record can be concurrently written. It is not identity evidence until
  // Codex terminates the JSONL record with a newline.
  return matches;
}

/**
 * Recover stable instruction ids after native local compaction re-ids retained user messages.
 * Every alias requires one exact current replacement item and one unique earlier response_item
 * with the same native turn and content. Ambiguous or incomplete evidence produces no alias.
 */
export interface ResolvedCodexRolloutMessageIdentity {
  aliases?: Record<string, string>;
  turnId: string;
  environmentTurnId?: string;
}

export function resolveCurrentCodexRolloutMessageIdAliases(options: {
  codexHome: string;
  additionalCodexHomes?: readonly string[];
  sqliteHome?: string;
  lineage: RolloutIdentity;
  turnId: string;
  revisions: readonly ChatGptTurnUserRevision[];
  compactionSource?: ChatGptTurnUserRevision;
  compactionTurnId?: string;
  compactionPhase?: ChatGptNativeCompactionPhase;
}): ResolvedCodexRolloutMessageIdentity | undefined {
  const requested = options.revisions.filter((revision): revision is ChatGptTurnUserRevision & { itemId: string } => (
    typeof revision.itemId === "string" && revision.itemId.length > 0
  ));
  if (requested.length === 0) return undefined;
  const nativeThreadId = CODEX_ID.test(options.lineage.threadId);
  const nativeTurnId = CODEX_ID.test(options.turnId);
  if (!nativeThreadId && !nativeTurnId) return undefined;
  if (!nativeThreadId || !nativeTurnId
    || ("parentThreadId" in options.lineage && !CODEX_ID.test(options.lineage.parentThreadId))) return undefined;

  try {
    const owner = currentRolloutOwner(options);
    if (!owner) return undefined;
    const recovered: ResolvedCodexRolloutMessageIdentity[] = [];
    for (const candidate of owner.candidates) {
      const rolloutPath = validateRolloutPath(owner.home, candidate, options.lineage.threadId);
      const fd = openSync(rolloutPath, "r");
      try {
        const size = fstatSync(fd).size;
        if (!Number.isSafeInteger(size) || size <= 0) continue;
        validateSessionMeta(firstRolloutRecord(fd, size), options.lineage);
        const latest = record(latestRolloutRecord(fd, size, item => item.type === "turn_context")?.payload);
        const sourceProof = authenticateCompactionSource(fd, size, options.compactionSource, latest?.turn_id,
          options.compactionTurnId, options.compactionPhase);
        // A wire source owner is a constraint on native proof. Even when it names the latest
        // permission turn, it cannot establish the retained human's execution identity.
        const aliasTurnId = options.compactionSource
          ? sourceProof?.sourceTurnId
          : latest?.turn_id === options.turnId ? options.turnId : undefined;
        if (typeof aliasTurnId !== "string") continue;
        const compacted = latestRolloutRecord(fd, size, item => item.type === "compacted");
        const replacementHistory = record(compacted?.payload)?.replacement_history;
        const aliases: Record<string, string> = {};
        if (Array.isArray(replacementHistory)) {
          const replacements: NativeUserMessageIdentity[] = [];
          for (const revision of requested) {
            const exact = replacementHistory.map(nativeUserMessageIdentity).filter((message): message is NativeUserMessageIdentity => (
              message !== undefined
              && message.id === revision.itemId
              && message.turnId === aliasTurnId
              && isDeepStrictEqual(message.content, revision.content)
            ));
            if (exact.length === 1) replacements.push(exact[0]!);
          }
          if (replacements.length > 0) {
            const originals = originalResponseItemIds(fd, size, replacements);
            for (const replacement of replacements) {
              const ids = [...(originals.get(replacement.id) ?? [])];
              if (ids.length === 1) aliases[replacement.id] = ids[0]!;
            }
          }
        }
        if (options.compactionSource || Object.keys(aliases).length > 0) {
          recovered.push({
            turnId: aliasTurnId,
            ...(sourceProof ? { environmentTurnId: sourceProof.environmentTurnId } : {}),
            ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
          });
        }
      } finally {
        closeSync(fd);
      }
    }
    if (recovered.length !== 1) return undefined;
    return recovered[0];
  } catch {
    // This mapping is only a replay optimization. Missing, changing, or malformed rollout state
    // must fail closed to the new id instead of weakening ordinary environment validation.
    return undefined;
  }
}

interface NativeEnvironmentEvidence {
  payload: Record<string, unknown>;
  location: LocatedRolloutRecord;
  boundary: LocatedRolloutRecord;
  checkpoint: boolean;
}

function isNativeEnvironmentMessage(payload: Record<string, unknown>): boolean {
  const kinds = record(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  const content = payload.content;
  if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(kinds) || !Array.isArray(content)
    || kinds.length !== content.length || kinds.filter(kind => kind === "environments.environment_context").length !== 1) return false;
  const index = kinds.indexOf("environments.environment_context");
  return /^<environment_context>[\s\S]*<\/environment_context>$/.test(String(record(content[index])?.text ?? "").trim());
}

/** A latest replacement overrides earlier records, including records with the same message id. */
function nativeEnvironmentEvidence(
  fd: number, size: number, turnId: string, message: ChatGptUnattributedEnvironmentMessage,
  publicationPendingIsTransient = false,
): NativeEnvironmentEvidence | undefined {
  let boundary: LocatedRolloutRecord | undefined;
  let checkpoint: LocatedRolloutRecord | undefined;
  const responses: LocatedRolloutRecord[] = [];
  let checkpointContext: LocatedRolloutRecord | undefined;
  visitRolloutRecords(fd, size, entry => {
    const payload = record(entry.item.payload);
    if (!boundary && entry.item.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === turnId) boundary = entry;
    if (entry.item.type === "compacted") {
      checkpoint = entry;
      checkpointContext = undefined;
    }
    if (entry.item.type === "turn_context" && checkpoint
      && payload?.turn_id === record(record(checkpoint.item.payload)?.resume_metadata)?.last_started_turn_id) checkpointContext = entry;
    if (entry.item.type === "response_item" && payload?.id === message.id) responses.push(entry);
  });
  if (!boundary) return undefined;
  if (checkpoint) {
    const payload = record(checkpoint.item.payload);
    const replacement = payload?.replacement_history;
    const candidates = Array.isArray(replacement) ? replacement.map(record).filter(item => item?.id === message.id) : [];
    if (candidates.length > 1) return undefined;
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      const owner = record(candidate.internal_chat_message_metadata_passthrough)?.turn_id;
      const checkpointTurn = record(payload?.resume_metadata)?.last_started_turn_id;
      if (!isNativeEnvironmentMessage(candidate) || typeof owner !== "string" || owner !== checkpointTurn
        || checkpoint.activeTurn !== owner || !checkpointContext) return undefined;
      return { payload: candidate, location: checkpoint, boundary, checkpoint: true };
    }
  }
  // A removed checkpoint item cannot be revived by an earlier independent message. A newer
  // native message remains part of the active suffix, subject to the usual task boundary.
  const candidates = checkpoint ? responses.filter(entry => entry.order > checkpoint!.order) : responses;
  // The current turn context can be flushed before its environment message. Only absence
  // is transient; existing ambiguous or conflicting records must still fail validation.
  if (candidates.length === 0 && publicationPendingIsTransient) {
    throw new CodexRolloutPublicationPendingError("Codex rollout has not published the current environment message yet");
  }
  if (candidates.length !== 1) return undefined;
  const location = candidates[0]!;
  const payload = record(location.item.payload);
  return payload ? { payload, location, boundary, checkpoint: false } : undefined;
}

/** The wire omits ownership; only the exact native current message can supply that proof. */
function verifyCurrentEnvironmentMessage(
  fd: number, size: number, turnId: string, message: ChatGptUnattributedEnvironmentMessage,
  publicationPendingIsTransient: boolean,
): void {
  const proof = nativeEnvironmentEvidence(fd, size, turnId, message, publicationPendingIsTransient);
  const owner = record(proof?.payload.internal_chat_message_metadata_passthrough)?.turn_id;
  if (!proof || proof.location.order <= proof.boundary.order || proof.location.activeTurn !== turnId
    || owner !== turnId || !isNativeEnvironmentMessage(proof.payload)) {
    throw new TrustedCodexEnvironmentValidationError("Codex rollout does not authenticate the current environment message");
  }
  if (!isDeepStrictEqual(proof.payload.content, message.content)) {
    throw new TrustedCodexEnvironmentValidationError("Current environment message differs from its native Codex record");
  }
  const provenance = record(proof.payload.internal_chat_message_metadata_passthrough);
  if ((message.turnId !== undefined && provenance?.turn_id !== message.turnId)
    || (message.contentItemKinds !== undefined && !isDeepStrictEqual(provenance?.content_item_kinds, message.contentItemKinds))) {
    throw new TrustedCodexEnvironmentValidationError("Current environment provenance differs from its native Codex record");
  }
}

function verifyHistoricalEnvironmentMessages(
  fd: number, size: number, turnId: string, messages: ChatGptUnattributedEnvironmentMessage[], nativeCompaction = false,
): ChatGptUnattributedEnvironmentMessage[] {
  if (new Set(messages.map(message => message.id)).size !== messages.length) {
    throw new TrustedCodexEnvironmentValidationError("Codex environment history repeats a message id");
  }
  const current: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const message of messages) {
    const proof = nativeEnvironmentEvidence(fd, size, turnId, message);
    if (!proof) {
      let hasBoundary = false;
      visitRolloutRecords(fd, size, ({ item }) => {
        const payload = record(item.payload);
        if (item.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === turnId) hasBoundary = true;
      });
      if (!hasBoundary) throw new Error("Codex rollout has no current task boundary for environment history");
      throw new TrustedCodexEnvironmentValidationError("Codex rollout does not authenticate the historical environment messages");
    }
    if (!isDeepStrictEqual(proof.payload.content, message.content)) {
      throw new TrustedCodexEnvironmentValidationError("Historical environment message differs from its native Codex record");
    }
    const provenance = record(proof.payload.internal_chat_message_metadata_passthrough);
    if ((nativeCompaction && !isNativeEnvironmentMessage(proof.payload))
      || (message.turnId !== undefined && provenance?.turn_id !== message.turnId)
      || (message.contentItemKinds !== undefined && !isDeepStrictEqual(provenance?.content_item_kinds, message.contentItemKinds))) {
      throw new TrustedCodexEnvironmentValidationError("Historical environment provenance differs from its native Codex record");
    }
    if (proof.location.order > proof.boundary.order) {
      // Only a native compaction installs a new current environment away from the instruction.
      // An ordinary current update must still pass the explicit current-message proof above.
      if ((!proof.checkpoint && !nativeCompaction) || proof.location.activeTurn !== turnId
        || record(proof.payload.internal_chat_message_metadata_passthrough)?.turn_id !== turnId) {
        throw new TrustedCodexEnvironmentValidationError("Codex rollout does not authenticate the historical environment messages");
      }
      current.push(message);
    }
  }
  return current;
}

function validateSessionMeta(
  item: Record<string, unknown>,
  identity: RolloutIdentity,
): void {
  const payload = record(item.payload);
  if (!("parentThreadId" in identity)) {
    if (item.type !== "session_meta" || payload?.id !== identity.threadId
      || typeof payload.source !== "string" || payload.source === "subagent"
      || payload.parent_thread_id != null || payload.thread_source === "subagent"
      || (payload.agent_path != null && payload.agent_path !== "/root")) {
      throw new Error("Codex rollout session metadata does not authenticate the requested root thread");
    }
    return;
  }
  const lineage = identity;
  const source = record(payload?.source);
  const subagent = record(source?.subagent);
  const spawn = record(subagent?.thread_spawn);
  if (item.type !== "session_meta"
    || payload?.id !== lineage.threadId
    || payload.parent_thread_id !== lineage.parentThreadId
    || !matchesAgentPath(payload.agent_path, lineage.agentName)
    || payload.thread_source !== "subagent"
    || spawn?.parent_thread_id !== lineage.parentThreadId
    || !matchesAgentPath(spawn.agent_path, lineage.agentName)) {
    throw new Error("Codex rollout session metadata does not authenticate the requested subagent");
  }
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Codex rollout ${field} is invalid`);
  }
  const unique = new Map<string, string>();
  for (const path of value as string[]) {
    const normalized = resolve(path);
    if (!unique.has(pathIdentity(normalized))) unique.set(pathIdentity(normalized), normalized);
  }
  return [...unique.values()];
}

function validGlobScanMaxDepth(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function validRestrictiveEntry(entryValue: unknown): { rootRead: boolean } | undefined {
  const entry = record(entryValue);
  const path = record(entry?.path);
  if (!entry || !path
    || (entry.access !== "read" && entry.access !== "deny")
    || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;
  if (path.type === "special") {
    const special = record(path.value)?.kind;
    if (typeof special !== "string" || !special) return undefined;
    return {
      rootRead: special === "root"
        && entry.access === "read"
        && entry.missing_path_behavior === undefined,
    };
  }
  if (path.type === "path") {
    return typeof path.path === "string" && isAbsolute(path.path) ? { rootRead: false } : undefined;
  }
  if (path.type === "glob_pattern") {
    return typeof path.pattern === "string" && path.pattern.length > 0 ? { rootRead: false } : undefined;
  }
  return undefined;
}

function exactManagedReadOnlyProfile(
  value: Record<string, unknown>,
  expectedNetwork: "enabled" | "restricted",
): boolean {
  const fileSystem = record(value.file_system);
  const entries = fileSystem?.entries;
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(entries)
    || value.network !== expectedNetwork) return false;
  let rootReads = 0;
  for (const entry of entries) {
    const restrictive = validRestrictiveEntry(entry);
    if (!restrictive) return false;
    if (restrictive.rootRead) rootReads += 1;
  }
  return rootReads === 1;
}

function networkAccess(value: Record<string, unknown>, field: string): boolean {
  if (value.network_access !== undefined && typeof value.network_access !== "boolean") {
    throw new Error(`Codex rollout ${field} network_access is invalid`);
  }
  return value.network_access === true;
}

function splitPolicyMatchesProfile(
  splitValue: unknown,
  profileFileSystem: Record<string, unknown>,
): boolean {
  if (splitValue === undefined || splitValue === null) return true;
  const split = record(splitValue);
  if (!split) return false;
  const profileType = profileFileSystem.type;
  if (profileType !== "restricted" && profileType !== "unrestricted") return false;
  if (split.kind !== profileType) return false;
  if (profileType === "unrestricted") {
    return split.entries === undefined && split.glob_scan_max_depth === undefined;
  }
  return isDeepStrictEqual(split.entries, profileFileSystem.entries)
    && split.glob_scan_max_depth === profileFileSystem.glob_scan_max_depth;
}

function exactManagedWorkspaceWriteProfile(
  profile: Record<string, unknown>,
  roots: string[],
  cwd: string,
  sandbox: Record<string, unknown>,
): { networkAccess: boolean; writableRoots: string[] } | undefined {
  const fileSystem = record(profile.file_system);
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(fileSystem.entries)
    || (profile.network !== "restricted" && profile.network !== "enabled")) return undefined;

  const rawWritableRoots = sandbox.writable_roots ?? [];
  if (!Array.isArray(rawWritableRoots)
    || rawWritableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || (sandbox.exclude_tmpdir_env_var !== undefined && typeof sandbox.exclude_tmpdir_env_var !== "boolean")
    || (sandbox.exclude_slash_tmp !== undefined && typeof sandbox.exclude_slash_tmp !== "boolean")) return undefined;
  const expectedWritableRoots = [cwd, ...rawWritableRoots.map(path => resolve(path as string))];
  const uniqueExpectedWritableRoots = [...new Map(expectedWritableRoots.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  // Native Codex can grant an output directory outside its project roots and can
  // repeat a grant while composing policies. Compare the exact sets below instead.

  let rootRead = 0;
  let projectRootsWrite = 0;
  const directWrites: string[] = [];
  const specialWrites = new Set<string>();
  for (const value of fileSystem.entries) {
    const entry = record(value);
    const path = record(entry?.path);
    if (!entry || !path
      || (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny")
      || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;

    if (path.type === "special") {
      const special = record(path.value)?.kind;
      if (special === "root" && entry.access === "read" && entry.missing_path_behavior === undefined) {
        rootRead += 1;
        continue;
      }
      if (entry.access !== "write") {
        if (typeof special !== "string" || !special) return undefined;
        continue;
      }
      if (special === "project_roots" && entry.access === "write" && entry.missing_path_behavior === undefined) {
        projectRootsWrite += 1;
        continue;
      }
      if ((special === "slash_tmp" || special === "tmpdir")
        && entry.access === "write"
        && entry.missing_path_behavior === undefined
        && !specialWrites.has(special)) {
        specialWrites.add(special);
        continue;
      }
      return undefined;
    }

    // Read/deny entries only narrow the profile. Codex legitimately adds external worktree gitdirs
    // and protected metadata paths here, so they do not affect the writable authority recovered
    // by this bridge. Every write entry, in contrast, must be one of the exact legacy roots below.
    if (entry.access !== "write") {
      if (path.type === "path") {
        if (typeof path.path !== "string" || !isAbsolute(path.path)) return undefined;
      } else if (path.type === "glob_pattern") {
        if (typeof path.pattern !== "string" || !path.pattern) return undefined;
      } else {
        return undefined;
      }
      continue;
    }
    if (path.type !== "path"
      || typeof path.path !== "string"
      || !isAbsolute(path.path)
      || entry.missing_path_behavior !== undefined) return undefined;
    directWrites.push(resolve(path.path));
  }

  if (rootRead !== 1 || projectRootsWrite > 1) return undefined;
  const uniqueDirectWrites = [...new Map(directWrites.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  const expectedIdentities = new Set(uniqueExpectedWritableRoots.map(pathIdentity));
  if (uniqueDirectWrites.some(path => !expectedIdentities.has(pathIdentity(path)))) return undefined;
  if (projectRootsWrite === 0 && uniqueDirectWrites.length !== uniqueExpectedWritableRoots.length) return undefined;
  if (projectRootsWrite === 1) {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (rootIdentities.size !== expectedIdentities.size
      || [...rootIdentities].some(path => !expectedIdentities.has(path))) return undefined;
  }

  const expectsSlashTmp = sandbox.exclude_slash_tmp !== true;
  const expectsTmpdir = sandbox.exclude_tmpdir_env_var !== true;
  if (specialWrites.has("slash_tmp") !== expectsSlashTmp
    || specialWrites.has("tmpdir") !== expectsTmpdir) return undefined;

  return {
    networkAccess: profile.network === "enabled",
    writableRoots: uniqueExpectedWritableRoots,
  };
}

function environmentFromTurnContext(
  payload: Record<string, unknown>,
  expectedTurnId: string,
  tools: readonly CodexTool[] | undefined,
): ChatGptTurnEnvironment {
  if (payload.turn_id !== expectedTurnId) {
    throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
  }
  if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) {
    throw new Error("Codex rollout cwd is invalid");
  }
  const cwd = resolve(payload.cwd);
  const declaredRoots = payload.workspace_roots === undefined
    ? []
    : absolutePaths(payload.workspace_roots, "workspace_roots");
  const roots = declaredRoots.length > 0 ? declaredRoots : [cwd];
  if (!roots.some(root => contains(root, cwd))) {
    throw new Error("Codex rollout cwd is outside its workspace roots");
  }

  const permissionProfile = record(payload.permission_profile);
  const sandbox = record(payload.sandbox_policy);
  if (!permissionProfile || !sandbox) {
    throw new Error("Codex rollout is missing its authoritative permission profile");
  }
  if (permissionProfile.type === "disabled" && sandbox.type === "danger-full-access") {
    const split = payload.file_system_sandbox_policy;
    if (split !== undefined && split !== null) {
      const unrestricted = record(split);
      if (unrestricted?.kind !== "unrestricted"
        || unrestricted.entries !== undefined
        || unrestricted.glob_scan_max_depth !== undefined) {
        throw new Error("Codex rollout split filesystem policy conflicts with full access");
      }
    }
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "read-only") {
    const enabled = networkAccess(sandbox, "read-only");
    const expectedNetwork = enabled ? "enabled" : "restricted";
    const fileSystem = record(permissionProfile.file_system);
    if (!fileSystem
      || !exactManagedReadOnlyProfile(permissionProfile, expectedNetwork)
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout read-only permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: enabled },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "workspace-write") {
    const fileSystem = record(permissionProfile.file_system);
    const workspace = exactManagedWorkspaceWriteProfile(permissionProfile, roots, cwd, sandbox);
    if (!fileSystem
      || !workspace
      || networkAccess(sandbox, "workspace-write") !== workspace.networkAccess
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout workspace-write permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: workspace.writableRoots,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: workspace.writableRoots,
        networkAccess: workspace.networkAccess,
      },
      tools: [...(tools ?? [])],
    };
  }
  throw new Error("Codex rollout permission profile cannot be represented safely by the Web bridge");
}

function validateMetadataConsistency(
  lineage: RolloutIdentity,
  environment: ChatGptTurnEnvironment,
  workspaceRootsDeclared: boolean,
): void {
  // Request sandbox/workspace fields are diagnostic only. They narrow a rollout-derived authority
  // here and never create or expand it.
  const owner = "parentThreadId" in lineage ? "subagent" : "thread";
  if (lineage.sandboxType === "platform"
    ? environment.sandboxPolicy.type === "dangerFullAccess"
    : environment.sandboxPolicy.type !== lineage.sandboxType) {
    throw new TrustedCodexEnvironmentValidationError(
      `ChatGPT Web ${owner} sandbox metadata conflicts with its Codex rollout`,
    );
  }
  if (lineage.workspaceRoots.length > 0
    && !lineage.workspaceRoots.some(root => contains(root, environment.cwd))) {
    throw new TrustedCodexEnvironmentValidationError(
      `ChatGPT Web ${owner} workspace metadata does not contain its Codex rollout cwd`,
    );
  }
  if ((workspaceRootsDeclared || environment.sandboxPolicy.type !== "dangerFullAccess")
    && lineage.workspaceRoots.some(root => !environment.roots.some(rolloutRoot => (
    contains(rolloutRoot, root) || contains(root, rolloutRoot)
  )))) {
    throw new TrustedCodexEnvironmentValidationError(
      `ChatGPT Web ${owner} workspace metadata conflicts with its Codex rollout roots`,
    );
  }
}

export function resolveCurrentCodexRolloutEnvironment(options: {
  codexHome: string;
  additionalCodexHomes?: readonly string[];
  sqliteHome?: string;
  lineage: RolloutIdentity;
  turnId: string;
  compactionSourceTurnId?: string;
  compactionSource?: ChatGptTurnUserRevision;
  tools?: readonly CodexTool[];
  historicalEnvironmentMessages?: ChatGptUnattributedEnvironmentMessage[];
  currentEnvironmentMessage?: ChatGptUnattributedEnvironmentMessage;
  currentInstruction?: ChatGptTurnUserRevision;
  compactionPhase?: ChatGptNativeCompactionPhase;
  validateCurrentEnvironmentMessage?: (
    message: ChatGptUnattributedEnvironmentMessage,
    environment: ChatGptTurnEnvironment,
    workspaceRootsDeclared: boolean,
  ) => void;
  publicationPendingIsTransient?: boolean;
}): CodexRolloutEnvironment | undefined {
  const { lineage, turnId, tools, compactionSourceTurnId } = options;
  const nativeThreadId = CODEX_ID.test(lineage.threadId);
  const nativeTurnId = CODEX_ID.test(turnId);
  if (!nativeThreadId && !nativeTurnId) return undefined;
  if (!nativeThreadId || !nativeTurnId || (compactionSourceTurnId !== undefined && !CODEX_ID.test(compactionSourceTurnId))
    || ("parentThreadId" in lineage && !CODEX_ID.test(lineage.parentThreadId))) {
    throw new TrustedCodexEnvironmentValidationError(
      "Codex thread metadata contains an invalid native identifier",
    );
  }

  const owner = currentRolloutOwner(options);
  if (!owner) {
    if (!("parentThreadId" in lineage)) return undefined;
    if (options.publicationPendingIsTransient) {
      throw new CodexRolloutPublicationPendingError(
        "Codex has no canonical rollout for the requested subagent thread",
      );
    }
    throw new Error("Codex has no canonical rollout for the requested subagent thread");
  }

  const matching: CodexRolloutEnvironment[] = [];
  let sawAuthenticatedStaleTurn = false;
  for (const candidate of owner.candidates) {
    let rolloutPath: string;
    let fd: number;
    try {
      rolloutPath = validateRolloutPath(owner.home, candidate, lineage.threadId);
      fd = openSync(rolloutPath, "r");
    } catch (error) {
      if (options.publicationPendingIsTransient && owner.indexed.kind === "found" && isEnoent(error)) {
        throw new CodexRolloutPublicationPendingError("Codex indexed rollout is not published yet");
      }
      throw error;
    }
    try {
      const size = fstatSync(fd).size;
      if (!Number.isSafeInteger(size) || size <= 0) {
        if (options.publicationPendingIsTransient) {
          throw new CodexRolloutPublicationPendingError("Codex rollout is empty");
        }
        throw new Error("Codex rollout is empty");
      }
      let sessionMeta: Record<string, unknown>;
      try {
        sessionMeta = firstRolloutRecord(fd, size);
      } catch (error) {
        if (options.publicationPendingIsTransient
          && error instanceof Error
          && error.message === "Codex rollout has no complete session metadata record") {
          throw new CodexRolloutPublicationPendingError(error.message);
        }
        throw error;
      }
      validateSessionMeta(sessionMeta, lineage);
      const latest = record(latestRolloutRecord(fd, size, item => item.type === "turn_context")?.payload);
      if (!latest) {
        if (options.publicationPendingIsTransient) {
          throw new CodexRolloutPublicationPendingError("Codex rollout has no complete turn context");
        }
        throw new Error("Codex rollout has no complete turn context");
      }
      const sourceProof = options.compactionSource
        ? authenticateCompactionSource(fd, size, options.compactionSource, latest.turn_id, turnId, options.compactionPhase)
        : undefined;
      if (options.compactionSource && (!sourceProof
        || (compactionSourceTurnId !== undefined && sourceProof.sourceTurnId !== compactionSourceTurnId))) {
        if (options.publicationPendingIsTransient) {
          throw new CodexRolloutPublicationPendingError("Codex rollout has not authenticated the compaction source yet");
        }
        throw new TrustedCodexEnvironmentValidationError("The trusted Codex environment rollout does not authenticate the compaction source");
      }
      // Borrowing another turn's permissions requires the exact native human source. A supplied
      // owner may constrain that proof, but matching the permission owner is never authority.
      if (latest.turn_id !== turnId && !sourceProof) {
        if (owner.indexed.kind === "found") {
          if (options.publicationPendingIsTransient) {
            throw new CodexRolloutPublicationPendingError(
              "Codex indexed rollout has not published the requested turn context yet",
            );
          }
          throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
        }
        if (options.publicationPendingIsTransient) sawAuthenticatedStaleTurn = true;
        continue;
      }
      const environment = environmentFromTurnContext(latest, latest.turn_id as string, tools);
      const workspaceRootsDeclared = latest.workspace_roots !== undefined;
      validateMetadataConsistency(lineage, environment, workspaceRootsDeclared);
      if (options.currentEnvironmentMessage) {
        verifyCurrentEnvironmentMessage(fd, size, turnId, options.currentEnvironmentMessage,
          options.publicationPendingIsTransient === true);
      }
      if (options.historicalEnvironmentMessages) {
        if (new Set(options.historicalEnvironmentMessages.map(message => message.id)).size
          !== options.historicalEnvironmentMessages.length) {
          throw new TrustedCodexEnvironmentValidationError("Codex environment history repeats a message id");
        }
        // Exclude only the message whose exact current provenance was proved above. All other
        // fragments still require native history before this turn's task_started boundary.
        const current = options.currentEnvironmentMessage;
        const historical = options.historicalEnvironmentMessages.filter(message => !current
          || message.id !== current.id || !isDeepStrictEqual(message.content, current.content));
        if (historical.length > 0) {
          const currentMessages = verifyHistoricalEnvironmentMessages(fd, size, turnId, historical,
            Boolean(options.compactionSource && options.compactionPhase));
          for (const message of currentMessages) {
            options.validateCurrentEnvironmentMessage?.(message, environment, workspaceRootsDeclared);
          }
        }
      }
      const ownership = options.currentInstruction && latest.turn_id === turnId
        ? currentInstructionOwnership(fd, size, turnId, options.currentInstruction) : undefined;
      matching.push({ environment, workspaceRootsDeclared, ...(ownership ? { currentInstructionOwnership: ownership } : {}) });
    } finally {
      closeSync(fd);
    }
  }
  if (matching.length === 0) {
    if (options.publicationPendingIsTransient && sawAuthenticatedStaleTurn) {
      throw new CodexRolloutPublicationPendingError(
        "Codex canonical rollout has not published the requested turn context yet",
      );
    }
    throw new Error("Codex has no canonical rollout for the requested current turn");
  }
  if (matching.length > 1) {
    throw new Error("Codex has multiple canonical rollouts for the requested current turn");
  }
  return matching[0]!;
}

export class CodexRolloutPublicationPendingError extends Error {}
