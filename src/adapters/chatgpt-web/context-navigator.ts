import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BrokerToolResult } from "./turn-broker";
import { assertContextNavigationBudget, contextLimits, measureContextResponse, type ContextLimitOverrides, type ContextLimits } from "./context-budget";
import { ContextSnapshot, deterministicContextJson } from "./context-snapshot";
import { createContextTextReadResult } from "./context-text-result";
import type { ContextDelivery, ContextFilter, ContextListArgs, ContextLiveOverview, ContextPurpose, ContextReadArgs,
  ContextRemainingBudget, ContextSearchArgs, ContextTarget, ContextBootstrapControl } from "./context-types";

export type ContextErrorCode = "CONTEXT_EXPIRED" | "INVALID_ARGUMENT" | "INVALID_REFERENCE" | "INVALID_CURSOR"
  | "IMAGE_UNAVAILABLE" | "UNSUPPORTED_TYPE" | "BUDGET_EXCEEDED" | "PROCESSING_BUDGET_EXCEEDED";
class NavigationError extends Error { constructor(readonly code: ContextErrorCode) { super(code); } }
/** No ordinary tool content follows exhaustion. The Broker retires only navigation
 * authority and keeps the original source and summary-submission authority intact. */
export class ContextNavigationStoppedError extends Error {
  readonly code = "CONTEXT_NAVIGATION_STOPPED";
  constructor() { super("Context navigation has stopped"); this.name = "ContextNavigationStoppedError"; }
}
interface Cursor { v: 1; b: string; k: "entries" | "search" | "read"; q: string; t: string | null; n: number }
export interface ContextNavigationUsage {
  wire_bytes: number; text_tokens: number; visual_token_reserve: number; image_reads: number; image_bytes: number; processing_ms: number;
  error_responses: number; navigation_stopped: boolean;
}
export interface ContextNavigatorOptions {
  scopeId: string;
  snapshot: ContextSnapshot;
  purpose: ContextPurpose;
  deliveryByTarget?: Readonly<Record<string, ContextDelivery>>;
  limits?: ContextLimitOverrides;
  bootstrap?: { planId: string; manifestDigest: string };
  /** The runtime may credit only this target's still-undelivered reserve when reading it. */
  remainingBudget?: (target?: ContextTarget, result?: BrokerToolResult) => ContextRemainingBudget;
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const kinds = ["message_text", "tool_arguments", "tool_result", "image"];
const filterKeys = ["kind", "tool_name", "namespace", "call_id", "source_range"];
const boundary = (bytes: Uint8Array, position: number): boolean => position === bytes.length || (bytes[position]! & 0xc0) !== 0x80;
const floorBoundary = (bytes: Uint8Array, position: number): number => { while (position > 0 && !boundary(bytes, position)) position--; return position; };
function response(body: Record<string, unknown>, image?: { type: "image"; mimeType: string; data: string }): BrokerToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }, ...(image ? [image] : [])], structuredContent: body };
}

/** No authorization by context_id. A trusted Broker binds/authenticates scopeId and owns
 * lifecycle and image receipt commits. This class performs synchronous read-only navigation. */
export class ContextNavigator {
  readonly #snapshot: ContextSnapshot;
  readonly #purpose: ContextPurpose;
  readonly #delivery: Readonly<Record<string, ContextDelivery>>;
  readonly #limits: ContextLimits;
  readonly #remaining?: ContextNavigatorOptions["remainingBudget"];
  readonly #bootstrap?: ContextNavigatorOptions["bootstrap"];
  readonly #secret = randomBytes(32);
  readonly #binding: string;
  readonly #usage: ContextNavigationUsage = { wire_bytes: 0, text_tokens: 0, visual_token_reserve: 0, image_reads: 0, image_bytes: 0, processing_ms: 0, error_responses: 0, navigation_stopped: false };
  #admissionChecked = false;
  #retired = false;

  constructor(options: ContextNavigatorOptions) {
    if (typeof options.scopeId !== "string" || !options.scopeId || options.scopeId.length > 4096
      || !["normal", "compaction"].includes(options.purpose) || !(options.snapshot instanceof ContextSnapshot)) throw new Error("Invalid context navigator binding");
    this.#snapshot = options.snapshot; this.#purpose = options.purpose;
    this.#limits = contextLimits(options.limits);
    this.#delivery = Object.freeze(structuredClone(options.deliveryByTarget ?? {}));
    for (const [targetId, delivery] of Object.entries(this.#delivery)) {
      if (!this.#snapshot.getTarget(targetId) || !obj(delivery) || typeof delivery.delivery !== "string" || delivery.delivery.length > 80
        || delivery.media_route !== undefined && !["mcp", "attachment", "unavailable"].includes(delivery.media_route)
        || delivery.required !== undefined && typeof delivery.required !== "boolean" || delivery.reason !== undefined && (typeof delivery.reason !== "string" || delivery.reason.length > 240)) throw new Error("Invalid context delivery metadata");
    }
    if (options.purpose === "compaction" && this.#snapshot.targets.some(t => !t.read_ref)) throw new Error("Compaction source is not fully readable");
    this.#remaining = options.remainingBudget;
    this.#bootstrap = options.purpose === "normal" ? options.bootstrap : undefined;
    // Never put the authorization scope itself inside a cursor.
    this.#binding = hash(deterministicContextJson([options.scopeId, this.#snapshot.context_id, options.purpose]));
  }

  retire(): void { this.#retired = true; }
  usage(): Readonly<ContextNavigationUsage> { return Object.freeze({ ...this.#usage }); }

  list(args: ContextListArgs | unknown, liveOverview?: ContextLiveOverview, control?: ContextBootstrapControl): BrokerToolResult {
    return this.#list(args, liveOverview, false, control);
  }
  /** Trusted directory measurement: pack pages using future cursor token bounds. */
  preflightList(args: ContextListArgs, liveOverview?: ContextLiveOverview, control?: ContextBootstrapControl): BrokerToolResult { return this.#list(args, liveOverview, true, control); }

  #list(args: ContextListArgs | unknown, liveOverview?: ContextLiveOverview, preflight = false, control: ContextBootstrapControl = {}): BrokerToolResult {
    return this.#run("list", () => {
      const input = this.#validate(args, ["context_id", "view", "cursor", "required_only", ...filterKeys]);
      if (input.view !== "overview" && input.view !== "entries") throw new NavigationError("INVALID_ARGUMENT");
      if (input.required_only !== undefined && typeof input.required_only !== "boolean") throw new NavigationError("INVALID_ARGUMENT");
      const filter = this.#filter(input);
      const requiredOnly = input.required_only === true;
      const matches = this.#snapshot.targets.filter(t => this.#matches(t, filter) && (!requiredOnly || this.#required(t)));
      if (input.view === "overview") {
        if (input.cursor !== undefined) throw new NavigationError("INVALID_ARGUMENT");
        const unfiltered = !requiredOnly && filterKeys.every(k => input[k] === undefined);
        const body: Record<string, unknown> = { context_id: this.#snapshot.context_id, purpose: this.#purpose,
          counts: { sources: unfiltered ? this.#snapshot.sources.length : new Set(matches.map(t => t.source_id)).size,
            targets: matches.length, calls: matches.filter(t => t.kind === "tool_arguments").length,
            results: new Set(matches.filter(t => t.original_role === "toolResult").map(t => t.source_id)).size,
            images: matches.filter(t => t.kind === "image").length },
          source_cutoff: this.#snapshot.sources.length };
        if (liveOverview) body.live = this.#live(liveOverview);
        if (this.#bootstrap) {
          delete body.counts; delete body.source_cutoff;
          if (body.live) {
            delete (body.live as ContextLiveOverview).remaining_tokens;
            delete (body.live as ContextLiveOverview).remaining_wire_bytes;
            delete (body.live as ContextLiveOverview).required_text_bytes;
            delete (body.live as ContextLiveOverview).delivered_text_bytes;
          }
          const readState = control.read_state ?? "readable";
          if (!["readable", "waiting", "retired", "failed"].includes(readState)) throw new NavigationError("INVALID_ARGUMENT");
          Object.assign(body, { startup_protocol: "context-bootstrap-v1", manifest_version: 1,
            plan_id: this.#bootstrap.planId, manifest_digest: this.#bootstrap.manifestDigest, read_state: readState });
          for (const key of ["revision", "acknowledged_revision"] as const) if (control[key] !== undefined) {
            if (!Number.isSafeInteger(control[key]) || control[key]! < 0) throw new NavigationError("INVALID_ARGUMENT");
            body[key] = control[key];
          }
          if (control.next_action !== undefined) body.next_action = Array.from(control.next_action).slice(0, 160).join("");
          body.next_required_read = readState === "readable" ? liveOverview?.next_required_read ?? null : null;
          const required = this.#snapshot.targets.filter(t => this.#required(t));
          if (preflight && readState === "readable") {
            const texts = required.filter(target => target.kind !== "image");
            const images = required.length - texts.length;
            body.live = { context_ready: false, text_ready: false, images_ready: false,
              required_texts: texts.length, delivered_texts: texts.length, required_images: images, delivered_images: images };
            const reads = required.filter(target => target.read_ref && target.kind !== "image").map(target => ({
              tool: "codex_context_read", arguments: this.readArgsAt(target.target_id, target.utf8_bytes!) }));
            reads.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
            if (reads.length) body.next_required_read = reads[0];
          }
          const query = hash(deterministicContextJson({ required_only: true }));
          const selected: Record<string, unknown>[] = [];
          const make = (end: number) => {
            const cursor = end < required.length ? this.#encode("entries", query, null, end) : null;
            // A header plus two signed cursors can exceed the list ceiling. When
            // no entry fits, start the regular required-only directory directly.
            // Its first page needs no cursor and always makes ordinary progress.
            return end === 0 && cursor ? response({ ...body, required_targets: { entries: [], has_more: true },
              next_required_list: { tool: "codex_context_list", arguments: { context_id: this.#snapshot.context_id,
                view: "entries", required_only: true } } })
              : response({ ...body, required_targets: { entries: [...selected], has_more: cursor !== null, next_cursor: cursor } });
          };
          let result = make(0);
          for (let index = 0; index < required.length && selected.length < this.#limits.listEntries; index++) {
            const entry = this.#bootstrapEntry(required[index]!);
            selected.push(entry);
            const candidate = make(index + 1);
            if (!this.#fits(this.#bootstrapEnvelope(candidate), "list", false, preflight)) { selected.pop(); result = make(index); break; }
            result = candidate;
          }
          return { result, meteredResult: this.#bootstrapEnvelope(result) };
        }
        if (this.#purpose === "compaction") body.remaining_budget = this.#budgetHint();
        return { result: response(body) };
      }
      const q = hash(deterministicContextJson({ ...filter, ...(requiredOnly ? { required_only: true } : {}) }));
      const start = input.cursor === undefined ? 0 : this.#decode(input.cursor, "entries", q, null).n;
      if (start > matches.length) throw new NavigationError("INVALID_CURSOR");
      const selected: Record<string, unknown>[] = [];
      let result = response(this.#listBody(selected, start, matches.length, q));
      for (let i = start; i < matches.length && selected.length < this.#limits.listEntries; i++) {
        const entry = this.#entry(matches[i]!);
        let candidate = response(this.#listBody([...selected, entry], i + 1, matches.length, q));
        // A preview is optional evidence, so shrink it before declaring the first complete
        // metadata entry impossible. Never truncate serialized JSON or a content reference.
        if (selected.length === 0) while (!this.#fits(candidate, "list", false, preflight) && String(entry.label).length > 0) {
          entry.label = Array.from(String(entry.label)).slice(0, Math.floor(Array.from(String(entry.label)).length / 2)).join("");
          candidate = response(this.#listBody([entry], i + 1, matches.length, q));
        }
        if (!this.#fits(candidate, "list", false, preflight)) break;
        selected.push(entry); result = candidate;
      }
      if (start < matches.length && selected.length === 0) throw new NavigationError("BUDGET_EXCEEDED");
      return { result };
    }, preflight);
  }

  read(args: ContextReadArgs | unknown, liveOverview?: ContextLiveOverview): BrokerToolResult {
    return this.#read(args, liveOverview);
  }
  /** Trusted preparation only: validates one real page using the same rendering and
   * per-response limits, without charging the cumulative cost of reading every source.
   * The caller owns the bounded total preparation deadline and event-loop yielding. */
  preflightRead(args: ContextReadArgs): BrokerToolResult { return this.#read(args, undefined, true); }

  /** Trusted coverage navigation. This does not read or mark a byte delivered. */
  readArgsAt(targetId: string, start: number): ContextReadArgs {
    const target = this.#snapshot.getTarget(targetId);
    const text = target?.read_ref ? this.#snapshot.getText(target.read_ref) : undefined;
    if (!target?.read_ref || target.kind === "image" || text === undefined || !Number.isSafeInteger(start)
      || start < 0 || start > Buffer.byteLength(text) || !boundary(Buffer.from(text), start)) throw new Error("Invalid fixed text offset");
    return { context_id: this.#snapshot.context_id, read_ref: target.read_ref,
      ...(start ? { cursor: this.#encode("read", this.#readQuery(target.read_ref), target.target_id, start) } : {}) };
  }

  /** Trusted preparation only: test the smallest unfiltered directory page for one
   * target, including its real continuation cursor, without charging traversal costs. */
  preflightListEntry(index: number): BrokerToolResult {
    return this.#run("list", () => {
      const target = this.#snapshot.targets[index];
      if (!Number.isSafeInteger(index) || index < 0 || !target) throw new NavigationError("INVALID_ARGUMENT");
      const entry = { ...this.#entry(target), label: "" };
      return { result: response(this.#listBody([entry], index + 1, this.#snapshot.targets.length, hash(deterministicContextJson({})))) };
    }, true);
  }

  #read(args: ContextReadArgs | unknown, liveOverview?: ContextLiveOverview, preflight = false): BrokerToolResult {
    return this.#run("read", () => {
      const input = this.#validate(args, ["context_id", "read_ref", "cursor"]);
      if (typeof input.read_ref !== "string" || !input.read_ref) throw new NavigationError("INVALID_ARGUMENT");
      const target = this.#snapshot.getTargetByReadRef(input.read_ref);
      if (!target) throw new NavigationError("INVALID_REFERENCE");
      if (target.kind === "image") {
        if (input.cursor !== undefined) throw new NavigationError("INVALID_CURSOR");
        const route = this.#route(target);
        if (route !== "mcp") throw new NavigationError("IMAGE_UNAVAILABLE");
        const image = this.#snapshot.getImage(target.read_ref!);
        if (!image) throw new NavigationError("IMAGE_UNAVAILABLE");
        if (image.bytes.length > this.#limits.maxImageBytes) throw new NavigationError("BUDGET_EXCEEDED");
        const body = { context_id: this.#snapshot.context_id, purpose: this.#purpose, read_ref: target.read_ref,
          source: this.#source(target), mime_type: image.mime_type, image_bytes: image.bytes.length, content_digest: target.content_digest,
          visual_token_reserve: image.visual_token_reserve,
          ...(this.#purpose === "compaction" ? { remaining_budget: this.#budgetHint(target) } : {}) };
        return { result: response(body, { type: "image", mimeType: image.mime_type, data: Buffer.from(image.bytes).toString("base64") }),
          target, visual: image.visual_token_reserve, imageBytes: image.bytes.length };
      }
      const text = this.#snapshot.getText(target.read_ref!);
      if (text === undefined) throw new NavigationError("INVALID_REFERENCE");
      const bytes = Buffer.from(text, "utf8");
      const q = this.#readQuery(target.read_ref!);
      const start = input.cursor === undefined ? 0 : this.#decode(input.cursor, "read", q, target.target_id).n;
      if (start > bytes.length || !boundary(bytes, start)) throw new NavigationError("INVALID_CURSOR");
      // Keep the core page fixed when remaining budgets change. This allowance is measured
      // with maximal safe integers, covering the optional bounded compaction hint as well.
      const hint = this.#purpose === "compaction" ? this.#budgetHint() : undefined;
      const make = (end: number, conservative = false): BrokerToolResult => createContextTextReadResult({
        context_id: this.#snapshot.context_id, purpose: this.#purpose, read_ref: target.read_ref!, source: this.#source(target),
        encoding: target.encoding!, source_completeness: target.source_completeness, utf8_bytes: bytes.length,
        range: { start, end_exclusive: end },
        has_more: end < bytes.length, next_cursor: end < bytes.length ? this.#encode("read", q, target.target_id, end) : null,
        ...(hint ? { remaining_budget: conservative ? { tokens: Number.MAX_SAFE_INTEGER, wire_bytes: Number.MAX_SAFE_INTEGER, reserved_tokens: Number.MAX_SAFE_INTEGER, reserved_wire_bytes: Number.MAX_SAFE_INTEGER, stop_hint: "Stop reading before consuming the summary and submission reserve" } : hint } : {}),
      }, bytes.subarray(start, end).toString("utf8"));
      void liveOverview; // Live image readiness belongs only to overview/runtime gate errors.
      if (start === bytes.length) {
        // EOF still returns a metadata block and an empty body block. Check that
        // complete v2 result against the same page limits as non-empty pages.
        if (!this.#fits(make(start, true), "read", false, !!this.#bootstrap)) throw new NavigationError("BUDGET_EXCEEDED");
        return { result: make(start), target };
      }
      // A terminal page has no cursor and can fit even when every nonterminal page
      // exceeds the metadata ceiling. Test it before the monotone partial-page search.
      if (bytes.length - start <= this.#limits.readBytes && this.#fits(make(bytes.length, true), "read", false, !!this.#bootstrap)) return { result: make(bytes.length), target };
      let low = start, high = Math.min(bytes.length, start + this.#limits.readBytes);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const end = floorBoundary(bytes, middle);
        if (end <= low) { high = middle - 1; continue; }
        if (this.#fits(make(end, true), "read", false, !!this.#bootstrap)) low = end;
        else high = middle - 1;
      }
      let end = floorBoundary(bytes, low);
      // Binary search can land in a continuation byte. Probe the next whole scalar, so a
      // four-byte character can always advance when the smallest valid page fits.
      let next = end + 1; while (next < bytes.length && !boundary(bytes, next)) next++;
      if (next <= bytes.length && this.#fits(make(next, true), "read", false, !!this.#bootstrap)) end = next;
      if (end <= start) throw new NavigationError("BUDGET_EXCEEDED");
      return { result: make(end), target };
    }, preflight);
  }

  search(args: ContextSearchArgs | unknown): BrokerToolResult {
    return this.#run("search", () => {
      const input = this.#validate(args, ["context_id", "query", "read_ref", "cursor", ...filterKeys]);
      if (typeof input.query !== "string" || !input.query || /[\uD800-\uDFFF]/u.test(input.query) || Buffer.byteLength(input.query) > this.#limits.maxQueryBytes) throw new NavigationError("INVALID_ARGUMENT");
      const filter = this.#filter(input);
      if (input.read_ref !== undefined && (typeof input.read_ref !== "string" || !input.read_ref)) throw new NavigationError("INVALID_ARGUMENT");
      if (typeof input.read_ref === "string") {
        const refTarget = this.#snapshot.targets.find(t => t.read_ref === input.read_ref);
        if (!refTarget) throw new NavigationError("INVALID_REFERENCE");
        if (refTarget.kind === "image") throw new NavigationError("UNSUPPORTED_TYPE");
      }
      const matches = this.#snapshot.targets.filter(t => t.kind !== "image" && t.read_ref && this.#matches(t, filter)
        && (input.read_ref === undefined || t.read_ref === input.read_ref));
      const q = hash(deterministicContextJson({ filter, query: input.query, read_ref: input.read_ref ?? null }));
      const position = input.cursor === undefined ? { t: matches[0]?.target_id ?? null, n: 0 } : this.#decode(input.cursor, "search", q);
      let targetIndex = position.t === null ? matches.length : matches.findIndex(t => t.target_id === position.t);
      if (targetIndex < 0 || position.t === null && position.n !== 0) throw new NavigationError("INVALID_CURSOR");
      let offset = position.n;
      const hits: Record<string, unknown>[] = [];
      const searchStart = performance.now();
      let finalCursor: string | null = null;
      const make = (cursor: string | null) => response({ context_id: this.#snapshot.context_id, purpose: this.#purpose, query: input.query,
        hits, has_more: cursor !== null, next_cursor: cursor });
      outer: for (; targetIndex < matches.length; targetIndex++, offset = 0) {
        const target = matches[targetIndex]!;
        const bytes = Buffer.from(this.#snapshot.getText(target.read_ref!)!, "utf8");
        if (offset > bytes.length || !boundary(bytes, offset)) throw new NavigationError("INVALID_CURSOR");
        let utf16Offset = bytes.subarray(0, offset).toString("utf8").length;
        const text = bytes.toString("utf8");
        for (;;) {
          if (performance.now() - searchStart > this.#limits.callProcessingMs) throw new NavigationError("PROCESSING_BUDGET_EXCEEDED");
          const index = text.indexOf(input.query, utf16Offset);
          if (index < 0) break;
          const matchStart = Buffer.byteLength(text.slice(0, index));
          const matchEnd = matchStart + Buffer.byteLength(input.query);
          const snippetStart = floorBoundary(bytes, Math.max(0, matchStart - Math.floor(this.#limits.snippetChars / 2)));
          const snippetEnd = floorBoundary(bytes, Math.min(bytes.length, snippetStart + this.#limits.snippetChars * 4));
          const snippet = Array.from(bytes.subarray(snippetStart, snippetEnd).toString("utf8")).slice(0, this.#limits.snippetChars).join("");
          const hit = { target_id: target.target_id, source_id: target.source_id, source_index: target.source_index, target_index: target.target_index,
            read_ref: target.read_ref, range: { start: matchStart, end_exclusive: matchEnd }, snippet: { content: snippet,
              start: snippetStart, end_exclusive: snippetStart + Buffer.byteLength(snippet) },
            read_cursor: this.#encode("read", this.#readQuery(target.read_ref!), target.target_id, snippetStart) };
          const resume = this.#encode("search", q, target.target_id, matchStart);
          if (hits.length >= this.#limits.searchHits) { finalCursor = resume; break outer; }
          hits.push(hit);
          if (hits.length === 1) {
            let previewLimit = Array.from(snippet).length;
            const minimumPreview = Math.min(this.#limits.snippetChars, Array.from(input.query).length);
            while (!this.#fits(make(this.#encode("search", q, target.target_id, matchEnd)), "search") && previewLimit > minimumPreview) {
              previewLimit = Math.max(minimumPreview, Math.floor(previewLimit / 2));
              const previewEnd = floorBoundary(bytes, Math.min(bytes.length, matchStart + previewLimit * 4));
              const preview = Array.from(bytes.subarray(matchStart, previewEnd).toString("utf8")).slice(0, previewLimit).join("");
              hit.snippet = { content: preview, start: matchStart, end_exclusive: matchStart + Buffer.byteLength(preview) };
              hit.read_cursor = this.#encode("read", this.#readQuery(target.read_ref!), target.target_id, matchStart);
            }
          }
          if (!this.#fits(make(this.#encode("search", q, target.target_id, matchEnd)), "search")) {
            hits.pop(); finalCursor = resume;
            if (hits.length === 0) throw new NavigationError("BUDGET_EXCEEDED");
            break outer;
          }
          utf16Offset = index + (text.codePointAt(index)! > 0xffff ? 2 : 1);
        }
      }
      return { result: make(finalCursor) };
    });
  }

  #run(tool: "list" | "read" | "search", action: () => { result: BrokerToolResult; meteredResult?: BrokerToolResult; target?: ContextTarget; visual?: number; imageBytes?: number }, preflight = false): BrokerToolResult {
    const started = performance.now();
    if (this.#usage.navigation_stopped) throw new ContextNavigationStoppedError();
    // A standalone caller receives the same fail-closed admission as the Broker.
    // Construction itself never invokes a callback which may refer to this instance.
    if (!preflight && !this.#admissionChecked) {
      this.#admissionChecked = true;
      try { assertContextNavigationBudget(this.#remaining?.() ?? this.#localRemaining(), this.#limits); }
      catch { this.#usage.navigation_stopped = true; throw new ContextNavigationStoppedError(); }
    }
    let result: BrokerToolResult;
    let meteredResult: BrokerToolResult | undefined;
    let visual = 0, imageBytes = 0;
    try {
      if (this.#retired) throw new NavigationError("CONTEXT_EXPIRED");
      if (this.#usage.processing_ms >= this.#limits.totalProcessingMs) throw new NavigationError("PROCESSING_BUDGET_EXCEEDED");
      const value = action(); result = value.result; meteredResult = value.meteredResult; visual = value.visual ?? 0; imageBytes = value.imageBytes ?? 0;
      const image = imageBytes > 0;
      if (!this.#fits(meteredResult ?? result, tool, image, preflight && tool === "list")) throw new NavigationError("BUDGET_EXCEEDED");
      if (preflight) {
        if (performance.now() - started > this.#limits.callProcessingMs) throw new NavigationError("PROCESSING_BUDGET_EXCEEDED");
        return result;
      }
      const cost = this.#cost(meteredResult ?? result, visual);
      const remaining = this.#remaining?.(value.target, result);
      if (remaining) this.#validateRemaining(remaining);
      const errors = this.#errorReserve();
      if (this.#usage.wire_bytes + cost.wire_bytes + errors.wire_bytes > this.#limits.maxTotalWireBytes
        || this.#usage.text_tokens + this.#usage.visual_token_reserve + cost.total_tokens + errors.tokens > this.#limits.maxTotalTokens
        || image && (this.#usage.image_reads >= this.#limits.maxImageReads || this.#usage.image_bytes + imageBytes > this.#limits.maxTotalImageBytes)
        || image && remaining && (remaining.image_reads !== undefined && remaining.image_reads - (remaining.reserved_image_reads ?? 0) < 1
          || remaining.image_bytes !== undefined && imageBytes > remaining.image_bytes - (remaining.reserved_image_bytes ?? 0))
        || remaining && (cost.total_tokens + errors.tokens > remaining.tokens - (remaining.reserved_tokens ?? 0)
          || cost.wire_bytes + errors.wire_bytes > remaining.wire_bytes - (remaining.reserved_wire_bytes ?? 0))) throw new NavigationError("BUDGET_EXCEEDED");
      if (this.#retired) throw new NavigationError("CONTEXT_EXPIRED");
      if (performance.now() - started > this.#limits.callProcessingMs || this.#usage.processing_ms + performance.now() - started > this.#limits.totalProcessingMs) throw new NavigationError("PROCESSING_BUDGET_EXCEEDED");
    } catch (error) {
      if (error instanceof ContextNavigationStoppedError) throw error;
      const code = error instanceof NavigationError ? error.code : "INVALID_ARGUMENT";
      const last = !preflight && this.#usage.error_responses + 1 >= this.#limits.maxErrorResponses;
      result = response({ error: { code, ...(last ? { navigation_stopped: true, stop_hint: "Stop context navigation" } : {}) } }); result.isError = true; visual = 0; imageBytes = 0;
      meteredResult = undefined;
      const cost = this.#cost(result);
      if (preflight) return result;
      const remaining = this.#remaining?.() ?? this.#localRemaining();
      try { this.#validateRemaining(remaining); } catch { this.#usage.navigation_stopped = true; throw new ContextNavigationStoppedError(); }
      if (cost.text_tokens > this.#limits.errorResponseTokens || cost.wire_bytes > this.#limits.errorResponseBytes
        || cost.total_tokens > remaining.tokens - (remaining.reserved_tokens ?? 0)
        || cost.wire_bytes > remaining.wire_bytes - (remaining.reserved_wire_bytes ?? 0)
        || this.#usage.wire_bytes + cost.wire_bytes > this.#limits.maxTotalWireBytes
        || this.#usage.text_tokens + this.#usage.visual_token_reserve + cost.total_tokens > this.#limits.maxTotalTokens) {
        this.#usage.navigation_stopped = true; throw new ContextNavigationStoppedError();
      }
      this.#usage.error_responses++;
      this.#usage.navigation_stopped = last;
    }
    const cost = this.#cost(meteredResult ?? result, visual);
    this.#usage.wire_bytes += cost.wire_bytes; this.#usage.text_tokens += cost.text_tokens;
    this.#usage.visual_token_reserve += visual; this.#usage.image_bytes += imageBytes;
    if (imageBytes > 0) this.#usage.image_reads++;
    this.#usage.processing_ms += performance.now() - started;
    return result;
  }
  #cost(result: BrokerToolResult, visualTokens = 0) { return measureContextResponse(result, {
    wireReserveBytes: this.#limits.wireReserveBytes, tokenReserve: this.#limits.tokenReserve, visualTokens }); }
  #fits(result: BrokerToolResult, tool: "list" | "read" | "search", image = false, boundCursorTokens = false): boolean {
    const cost = measureContextResponse(result, { wireReserveBytes: this.#limits.wireReserveBytes,
      tokenReserve: this.#limits.tokenReserve, boundCursorTokens });
    const bytes = image ? this.#limits.imageWireBytes : tool === "list" ? this.#limits.listBytes : tool === "search" ? this.#limits.searchBytes : this.#limits.readBytes;
    const tokens = image ? this.#limits.imageMetadataTokens : tool === "list" ? this.#limits.listTokens : tool === "search" ? this.#limits.searchTokens : this.#limits.readTokens;
    return cost.wire_bytes <= bytes && cost.text_tokens <= tokens;
  }
  #validate(value: unknown, allowed: string[]): Record<string, unknown> {
    if (!obj(value) || Object.keys(value).some(k => !allowed.includes(k)) || Buffer.byteLength(JSON.stringify(value)) > this.#limits.maxArgumentBytes) throw new NavigationError("INVALID_ARGUMENT");
    if (typeof value.context_id !== "string" || !value.context_id || value.context_id.length > 1024) throw new NavigationError("INVALID_ARGUMENT");
    if (value.context_id !== this.#snapshot.context_id) throw new NavigationError("CONTEXT_EXPIRED");
    if (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor || value.cursor.length > 2048)) throw new NavigationError("INVALID_CURSOR");
    return value;
  }
  #filter(input: Record<string, unknown>): ContextFilter {
    const filter: ContextFilter = {};
    if (input.kind !== undefined) {
      if (typeof input.kind !== "string" || !kinds.includes(input.kind)) throw new NavigationError("INVALID_ARGUMENT");
      filter.kind = input.kind as ContextFilter["kind"];
    }
    for (const key of ["tool_name", "call_id"] as const) if (input[key] !== undefined) {
      if (typeof input[key] !== "string" || !input[key] || Buffer.byteLength(input[key]) > 1024) throw new NavigationError("INVALID_ARGUMENT");
      filter[key] = input[key];
    }
    if (input.namespace !== undefined) {
      if (input.namespace !== null && (typeof input.namespace !== "string" || !input.namespace || Buffer.byteLength(input.namespace) > 1024)) throw new NavigationError("INVALID_ARGUMENT");
      filter.namespace = input.namespace as string | null;
    }
    if (input.source_range !== undefined) {
      const range = input.source_range;
      if (!obj(range) || Object.keys(range).length !== 2 || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end_exclusive)
        || (range.start as number) < 1 || (range.end_exclusive as number) < (range.start as number)
        || (range.end_exclusive as number) > this.#snapshot.sources.length + 1) throw new NavigationError("INVALID_ARGUMENT");
      filter.source_range = { start: range.start as number, end_exclusive: range.end_exclusive as number };
    }
    return filter;
  }
  #matches(target: ContextTarget, filter: ContextFilter): boolean {
    return (filter.kind === undefined || filter.kind === target.kind) && (filter.tool_name === undefined || filter.tool_name === target.tool_name)
      && (filter.namespace === undefined || filter.namespace === target.namespace) && (filter.call_id === undefined || filter.call_id === target.call_id)
      && (filter.source_range === undefined || target.source_index >= filter.source_range.start && target.source_index < filter.source_range.end_exclusive);
  }
  #source(target: ContextTarget) { return { source_id: target.source_id, source_index: target.source_index, target_id: target.target_id,
    target_index: target.target_index, source_kind: target.source_kind, original_role: target.original_role, origin: target.origin, provenance: target.provenance,
    ...(target.author !== undefined ? { author: target.author } : {}), ...(target.recipient !== undefined ? { recipient: target.recipient } : {}) }; }
  #route(target: ContextTarget): "mcp" | "attachment" | "unavailable" {
    if (this.#purpose === "normal" && this.#delivery[target.target_id]?.media_route === "attachment") return "attachment";
    if (!target.read_ref) return "unavailable";
    return this.#purpose === "compaction" ? "mcp" : this.#delivery[target.target_id]?.media_route ?? "mcp";
  }
  #required(target: ContextTarget): boolean { return this.#purpose === "normal" && this.#delivery[target.target_id]?.required === true; }
  #bootstrapEnvelope(result: BrokerToolResult): BrokerToolResult {
    return response({ started: true, duplicate: false, context_bootstrap: result.structuredContent });
  }
  #bootstrapEntry(target: ContextTarget): Record<string, unknown> {
    const delivery = this.#delivery[target.target_id]!;
    return { ...this.#source(target), kind: target.kind, source_completeness: target.source_completeness,
      read_ref: target.kind === "image" && this.#route(target) !== "mcp" ? null : target.read_ref,
      utf8_bytes: target.utf8_bytes, content_digest: target.content_digest, delivery: delivery.delivery,
      ...(target.kind === "image" ? { media_route: this.#route(target), mime_type: target.mime_type, image_bytes: target.image_bytes }
        : { encoding: target.encoding }) };
  }
  #entry(target: ContextTarget): Record<string, unknown> {
    const delivery = this.#delivery[target.target_id];
    const route = target.kind === "image" ? this.#route(target) : null;
    return { ...this.#source(target), kind: target.kind, tool_name: target.tool_name, namespace: target.namespace, call_id: target.call_id,
      read_ref: target.kind !== "image" || route === "mcp" ? target.read_ref : null, encoding: target.encoding, utf8_bytes: target.utf8_bytes,
      mime_type: target.mime_type, image_bytes: target.image_bytes, content_digest: target.content_digest,
      source_completeness: target.source_completeness, label: target.label, label_source: target.label_source,
      delivery: this.#purpose === "compaction" ? "source_on_demand" : delivery?.delivery ?? "source_on_demand", media_route: route,
      required: this.#required(target),
      ...(route === "attachment" || route === "unavailable" || target.unavailable_reason ? { reason: delivery?.reason ?? target.unavailable_reason ?? "Image uses the selected attachment route" } : {}),
      error_status: target.error_status, relation: { state: target.relation.state, call_count: target.relation.call_count, result_count: target.relation.result_count } };
  }
  #listBody(entries: Record<string, unknown>[], end: number, total: number, q: string) {
    return { context_id: this.#snapshot.context_id, purpose: this.#purpose, entries, has_more: end < total,
      next_cursor: end < total ? this.#encode("entries", q, null, end) : null };
  }
  #readQuery(readRef: string): string { return hash(deterministicContextJson({ read_ref: readRef })); }
  #encode(k: Cursor["k"], q: string, t: string | null, n: number): string {
    const json = Buffer.from(JSON.stringify({ v: 1, b: this.#binding, k, q, t, n } satisfies Cursor)).toString("base64url");
    return `${json}.${createHmac("sha256", this.#secret).update(json).digest("base64url")}`;
  }
  #decode(value: unknown, k: Cursor["k"], q: string, t?: string | null): Cursor {
    if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw new NavigationError("INVALID_CURSOR");
    const [json, signature] = value.split(".");
    const expected = createHmac("sha256", this.#secret).update(json!).digest();
    const supplied = Buffer.from(signature!, "base64url");
    if (supplied.toString("base64url") !== signature || Buffer.from(json!, "base64url").toString("base64url") !== json
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new NavigationError("INVALID_CURSOR");
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(json!, "base64url").toString("utf8")); } catch { throw new NavigationError("INVALID_CURSOR"); }
    if (!obj(cursor) || Object.keys(cursor).sort().join(",") !== "b,k,n,q,t,v" || cursor.v !== 1 || cursor.b !== this.#binding || cursor.k !== k || cursor.q !== q
      || cursor.t !== null && typeof cursor.t !== "string" || t !== undefined && cursor.t !== t || !Number.isSafeInteger(cursor.n) || (cursor.n as number) < 0) throw new NavigationError("INVALID_CURSOR");
    return cursor as unknown as Cursor;
  }
  #validateRemaining(budget: ContextRemainingBudget): void {
    if ([budget.tokens, budget.wire_bytes, budget.reserved_tokens ?? 0, budget.reserved_wire_bytes ?? 0, budget.image_reads ?? 0, budget.reserved_image_reads ?? 0, budget.image_bytes ?? 0, budget.reserved_image_bytes ?? 0].some(n => !Number.isSafeInteger(n) || n < 0)
      || budget.reserved_image_reads !== undefined && budget.image_reads === undefined || budget.reserved_image_bytes !== undefined && budget.image_bytes === undefined) throw new NavigationError("BUDGET_EXCEEDED");
  }
  #errorReserve() { const count = this.#limits.maxErrorResponses - this.#usage.error_responses;
    return { tokens: count * this.#limits.errorResponseTokens, wire_bytes: count * this.#limits.errorResponseBytes }; }
  #localRemaining(): ContextRemainingBudget { return { tokens: Math.max(0, this.#limits.maxTotalTokens - this.#usage.text_tokens - this.#usage.visual_token_reserve), wire_bytes: Math.max(0, this.#limits.maxTotalWireBytes - this.#usage.wire_bytes) }; }
  #budgetHint(target?: ContextTarget) {
    const budget = this.#remaining?.(target) ?? this.#localRemaining();
    this.#validateRemaining(budget);
    return { tokens: budget.tokens, wire_bytes: budget.wire_bytes, reserved_tokens: budget.reserved_tokens ?? 0, reserved_wire_bytes: budget.reserved_wire_bytes ?? 0, stop_hint: "Stop reading before consuming the summary and submission reserve" };
  }
  #live(value: ContextLiveOverview): ContextLiveOverview {
    const result: ContextLiveOverview = {};
    for (const key of ["context_ready", "text_ready", "images_ready"] as const) if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") throw new NavigationError("INVALID_ARGUMENT"); result[key] = value[key];
    }
    for (const key of ["required_images", "delivered_images", "required_texts", "delivered_texts", "required_text_bytes", "delivered_text_bytes", "remaining_tokens", "remaining_wire_bytes"] as const) if (value[key] !== undefined) {
      if (!Number.isSafeInteger(value[key]) || value[key]! < 0) throw new NavigationError("INVALID_ARGUMENT"); result[key] = value[key];
    }
    if (value.stop_hint !== undefined) { if (typeof value.stop_hint !== "string") throw new NavigationError("INVALID_ARGUMENT"); result.stop_hint = Array.from(value.stop_hint).slice(0, 160).join(""); }
    return result;
  }
}
