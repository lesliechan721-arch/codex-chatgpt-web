import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { decodeCompactionSummary, encodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "./compaction";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false continuation chains
 * store the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  /** Only new, completed records with exact native task identity can leave this account. */
  threadId?: string;
  completed?: boolean;
  conversationEpoch?: string;
  /** Approximate in-memory size, computed locally at insert time (never trusted from disk). */
  sizeBytes?: number;
}

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;

/** The ONLY size computation: approximate entry weight from its items payload. */
function measuredEntry(entry: Omit<StoredResponseState, "sizeBytes">): StoredResponseState {
  let sizeBytes = 0;
  try {
    sizeBytes = JSON.stringify(entry.items).length;
  } catch {
    /* unserializable items: weightless rather than fatal */
  }
  return { ...entry, sizeBytes };
}

/** The ONLY insertion point: keeps the byte counter consistent on replacement. */
function setEntry(id: string, entry: Omit<StoredResponseState, "sizeBytes">): void {
  deleteEntry(id);
  const measured = measuredEntry(entry);
  storedResponseBytes += measured.sizeBytes ?? 0;
  states.set(id, measured);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes ?? 0;
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  states.delete(id);
}
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. Consumers use the prefix length to bind trusted history and rolling checkpoints to the
// exact replayed portion of this request.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const freshConversationRequests = new WeakSet<object>();
const conversationEpochs = new WeakMap<object, string>();
let loadedPath: string | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  const path = snapshotPath();
  if (loadedPath === path) return;
  // A daemon normally has one immutable home. This also makes embedded users and tests
  // changing homes obey the same account boundary instead of retaining another home's cache.
  flushResponseState();
  states.clear();
  storedResponseBytes = 0;
  loadedPath = path;
  try {
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if (raw.version !== 1 || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      // Recompute sizes locally while loading; persisted sizeBytes is never trusted.
      setEntry(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        ...(typeof rec.threadId === "string" ? { threadId: rec.threadId } : {}),
        ...(rec.completed === true ? { completed: true } : {}),
        ...(typeof rec.conversationEpoch === "string" ? { conversationEpoch: rec.conversationEpoch } : {}),
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      // sizeBytes is in-memory accounting only; keep it out of the disk snapshot.
      const [id, state] = entry;
      const { sizeBytes: _sizeBytes, ...persistable } = state;
      const persistEntry: [string, StoredResponseState] = [id, persistable];
      const size = JSON.stringify(persistEntry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(persistEntry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 1, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path now: tests may swap CODEX_CHATGPT_WEB_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled; CODEX_CHATGPT_WEB_HOME may have moved.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) deleteEntry(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
  // Byte high-water eviction, oldest-first (Map preserves insertion order).
  while (storedResponseBytes > MAX_STORED_RESPONSE_BYTES && states.size > 1) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    deleteEntry(oldest);
  }
}

export class ResponseContinuationError extends Error {
  constructor(detail: string) {
    super(`Cannot recover task history: ${detail}. Compact the Codex task or start a new task with the necessary context.`);
    this.name = "ResponseContinuationError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function taskThreadId(request: Record<string, unknown>): string | undefined {
  let metadata: unknown = record(request.client_metadata)?.["x-codex-turn-metadata"];
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { return; }
  }
  const thread = record(metadata)?.thread_id;
  return typeof thread === "string" && thread.trim() ? thread : undefined;
}

/** Compare logical bytes, including text, across the output -> Codex input round trip. */
function logicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(logicalValue);
  const object = record(value);
  if (!object) return value;
  if (object.role && (object.type === undefined || object.type === "message")) {
    const content = typeof object.content === "string" ? [{ type: "text", text: object.content }] : object.content;
    return { role: object.role, content: logicalValue(content) };
  }
  return Object.fromEntries(Object.keys(object).sort()
    .filter(key => !["id", "status", "annotations", "logprobs"].includes(key))
    .map(key => [key, key === "type" && ["input_text", "output_text"].includes(String(object[key])) ? "text" : logicalValue(object[key])]));
}

function historyDigest(items: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(logicalValue(items))).digest("hex");
}

function textOf(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  return Array.isArray(item.content) ? item.content.map(part => record(part)?.text ?? "").join("\n") : "";
}

function hasReadableCheckpoint(items: unknown[]): boolean {
  return items.some(value => {
    const item = record(value);
    if (!item) return false;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))
      && typeof item.encrypted_content === "string") {
      const summary = decodeCompactionSummary(item.encrypted_content);
      return Boolean(summary?.trim() && encodeCompactionSummary(summary) === item.encrypted_content);
    }
    const text = textOf(item);
    return item.role === "user" && isReadableCompactionSummaryText(text) && Boolean(text.slice(SUMMARY_PREFIX.length).trim());
  });
}

/** Message roles cannot prove completeness: an incremental suffix can include whole exchanges.
 * The exact previous response supplies the complete committed prefix we must preserve. */
function coversCommittedHistory(items: unknown[], previous: StoredResponseState): boolean {
  return previous.items.length > 0 && items.length >= previous.items.length
    && historyDigest(items.slice(0, previous.items.length)) === historyDigest(previous.items);
}

/** Source bytes are context, never issued calls or permission to resume an operation. */
function assertRecoverableItems(items: unknown[]): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const item = record(value);
    if (!item) return;
    if (item.type === "encrypted_content") throw new ResponseContinuationError("a required historical payload is not readable");
    if (item.type === "input_file" || (item.type === "input_image"
      && (typeof item.image_url !== "string" || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(item.image_url)))) {
      throw new ResponseContinuationError("a required attachment is unavailable through a supported input channel");
    }
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))
      && (typeof item.encrypted_content !== "string" || !decodeCompactionSummary(item.encrypted_content))) {
      throw new ResponseContinuationError("the required compaction summary is not readable");
    }
    if (["function_call", "custom_tool_call", "tool_search_call"].includes(String(item.type))) {
      if (typeof item.call_id !== "string") throw new ResponseContinuationError("a historical tool call has no verifiable result association");
      calls.add(item.call_id);
    }
    if (["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type))) {
      if (typeof item.call_id !== "string") throw new ResponseContinuationError("a historical tool result has no verifiable call association");
      results.add(item.call_id);
    }
    Object.values(item).forEach(inspect);
  };
  items.forEach(inspect);
  if ([...calls].some(id => !results.has(id)) || [...results].some(id => !calls.has(id))) {
    throw new ResponseContinuationError("historical tool calls need their actual results; old operations cannot be replayed");
  }
}

const HANDOFF_ITEM_FIELDS: Record<string, readonly string[]> = {
  message: ["type", "id", "role", "content", "phase"],
  agent_message: ["type", "author", "recipient", "content"],
  reasoning: ["type", "id", "summary", "content"],
  compaction: ["type", "encrypted_content"],
  compaction_summary: ["type", "encrypted_content"],
  context_compaction: ["type", "encrypted_content"],
  function_call: ["type", "id", "call_id", "name", "namespace", "arguments"],
  function_call_output: ["type", "call_id", "output"],
  custom_tool_call: ["type", "id", "call_id", "name", "input"],
  custom_tool_call_output: ["type", "call_id", "output"],
  tool_search_call: ["type", "id", "call_id", "arguments"],
};

/** Copy task payload fields only. Browser state, old capability/config fields and opaque
 * reasoning envelopes are not part of a logical handoff, even if present in a cache. */
function logicalHandoffItems(items: unknown[]): unknown[] {
  const content = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    return value.map(block => {
      const part = record(block);
      if (!part) throw new ResponseContinuationError("a saved content block is not readable");
      return Object.fromEntries(["type", "text", "refusal", "image_url", "detail", "file_id", "filename", "file_data"]
        .filter(key => part[key] !== undefined).map(key => [key, structuredClone(part[key])]));
    });
  };
  const toolDescription = (value: unknown): unknown => {
    const tool = record(value);
    if (!tool) return {};
    return Object.fromEntries(["type", "name", "description", "parameters", "input_format", "tools"]
      .filter(key => tool[key] !== undefined)
      .map(key => [key, key === "tools" && Array.isArray(tool[key]) ? tool[key].map(toolDescription) : structuredClone(tool[key])]));
  };
  return items.flatMap(value => {
    const item = record(value);
    if (!item) throw new ResponseContinuationError("a saved history item is not readable");
    const type = typeof item.type === "string" ? item.type : item.role ? "message" : "";
    if (type === "additional_tools") return []; // The target request owns its available tools.
    if (type === "tool_search_output") {
      // Replaying old tool descriptors through the parser would install A's tool catalog in B.
      // Preserve the result as task text; the target may discover its own tools if needed.
      return [{ type: "function_call_output", call_id: item.call_id,
        output: JSON.stringify({ status: item.status, historical_tools: Array.isArray(item.tools) ? item.tools.map(toolDescription) : [] }) }];
    }
    const selected = HANDOFF_ITEM_FIELDS[type];
    if (!selected) throw new ResponseContinuationError("a saved history item has no supported logical representation");
    const copy = Object.fromEntries(selected.filter(key => item[key] !== undefined)
      .map(key => [key, ["content", "output", "summary"].includes(key) ? content(item[key]) : structuredClone(item[key])]));
    if (type === "message") {
      const metadata = record(item.internal_chat_message_metadata_passthrough);
      if (metadata) copy.internal_chat_message_metadata_passthrough = Object.fromEntries(["turn_id", "content_item_kinds"]
        .filter(key => metadata[key] !== undefined).map(key => [key, structuredClone(metadata[key])]));
    }
    return [copy];
  });
}

const ACCOUNT_ID = /^(?:default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Registry paths are not data paths. Derive every source from the controlled account id. */
function sourceResponse(previousId: string, threadId: string | undefined): StoredResponseState | undefined {
  const appHome = process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME?.trim();
  const accountId = process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID?.trim();
  const registryPath = process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH?.trim();
  if (!appHome || !accountId || !registryPath) return;
  if (!threadId || !ACCOUNT_ID.test(accountId)) throw new ResponseContinuationError("the native task association is missing");
  const matches: StoredResponseState[] = [];
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    if (registry.version !== 1 || !Array.isArray(registry.accounts)) throw new Error("invalid registry");
    const accounts = registry.accounts as Array<Record<string, unknown>>;
    if (accounts.filter(account => account.id === accountId && account.status === "active").length !== 1) throw new Error("inactive target");
    const ids = new Set<string>();
    const applicationRoot = realpathSync(resolve(appHome));
    for (const account of accounts) {
      if (typeof account.id !== "string" || !ACCOUNT_ID.test(account.id) || account.status !== "active") continue;
      if (ids.has(account.id)) throw new Error("duplicate account");
      ids.add(account.id);
      if (account.id === accountId) continue;
      const home = account.id === "default" ? applicationRoot : join(applicationRoot, "accounts", account.id, "core");
      const path = join(home, "responses-state.json");
      if (!existsSync(path)) continue;
      // Neither a linked cache nor a linked account directory may widen this read exception.
      if (lstatSync(path).isSymbolicLink() || realpathSync(home) !== home || realpathSync(path) !== path) continue;
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      if (snapshot.version !== 1 || !Array.isArray(snapshot.states)) continue;
      for (const value of snapshot.states) {
        if (!Array.isArray(value) || value.length !== 2 || value[0] !== previousId) continue;
        const state = record(value[1]);
        if (state?.threadId !== threadId || state.completed !== true || !Array.isArray(state.items)
          || typeof state.createdAt !== "number" || !Number.isFinite(state.createdAt)
          || state.createdAt > now() || now() - state.createdAt > RESPONSE_TTL_MS) continue;
        matches.push({ createdAt: state.createdAt, items: state.items, threadId, completed: true });
      }
    }
  } catch { throw new ResponseContinuationError("the source account registry or committed history cannot be verified"); }
  if (matches.length !== 1) throw new ResponseContinuationError("no unique active account has this committed response and native task association");
  return matches[0];
}

function bindHistoryHead(body: Record<string, unknown>, items: unknown[], threadId: string | undefined): void {
  if (!process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID || !threadId) return;
  const head = [...states.values()].findLast(state => state.threadId === threadId && state.completed);
  const matches = head && items.length >= head.items.length
    && historyDigest(items.slice(0, head.items.length)) === historyDigest(head.items)
    // A matching prefix alone is insufficient after A -> B -> A: the intervening B
    // answer is history that A's page has never received. Only a new input suffix,
    // or results for calls already on this page, can use the retained document.
    && items.slice(head.items.length).every(value => {
      const item = record(value);
      if (!item) return false;
      if (["user", "developer", "system"].includes(String(item.role)) || item.type === "additional_tools") return true;
      return ["function_call_output", "custom_tool_call_output", "tool_search_output"].includes(String(item.type))
        && head.items.some(old => {
          const call = record(old);
          return ["function_call", "custom_tool_call", "tool_search_call"].includes(String(call?.type)) && call?.call_id === item.call_id;
        });
    });
  if (matches) {
    if (head.conversationEpoch) conversationEpochs.set(body, head.conversationEpoch);
  } else {
    freshConversationRequests.add(body);
    conversationEpochs.set(body, historyDigest(items));
  }
}

export function responseHistoryNeedsFreshConversation(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && freshConversationRequests.has(body));
}

export function responseHistoryConversationEpoch(body: unknown): string | undefined {
  return body && typeof body === "object" ? conversationEpochs.get(body) : undefined;
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  ensureLoaded();
  pruneResponses();
  const threadId = taskThreadId(request);
  const current = inputItems(request.input);
  if (!previousId) {
    bindHistoryHead(request, current, threadId);
    if (responseHistoryNeedsFreshConversation(request)) assertRecoverableItems(current);
    return body;
  }
  if (hasReadableCheckpoint(current)) {
    assertRecoverableItems(current);
    const complete = { ...request, previous_response_id: undefined };
    bindHistoryHead(complete, current, threadId);
    return complete;
  }
  const local = states.get(previousId);
  if (local?.threadId && local.threadId !== threadId) throw new ResponseContinuationError("the response belongs to another native task");
  const previous = local ?? sourceResponse(previousId, threadId);
  if (!previous) return body;
  if (coversCommittedHistory(current, previous)) {
    assertRecoverableItems(current);
    const complete = { ...request, previous_response_id: undefined };
    bindHistoryHead(complete, current, threadId);
    return complete;
  }
  const restored = local ? previous.items : logicalHandoffItems(previous.items);
  const items = [...restored, ...current];
  if (!local) assertRecoverableItems(items);
  const expanded = {
    ...request,
    input: items,
  };
  replayedInputPrefixLengths.set(expanded, restored.length);
  bindHistoryHead(expanded, items, threadId);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  setEntry(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    ...(taskThreadId(request) ? { threadId: taskThreadId(request) } : {}),
    ...(response.status === "completed" ? { completed: true } : {}),
    ...(conversationEpochs.has(request) ? { conversationEpoch: conversationEpochs.get(request) } : {}),
  });
  pruneResponses();
  schedulePersist();
}
