/** Immutable source data. Broker authenticates scopeId before invoking the navigator. */
export type ContextTargetKind = "message_text" | "tool_arguments" | "tool_result" | "image";
export type ContextPurpose = "normal" | "compaction";
export type ContextCompleteness = "complete" | "truncated" | "unknown";
export type ContextSourceKind = "system" | "user" | "developer" | "skill" | "summary" | "assistant" | "tool" | "agent_message" | "delegation";

/** Zero-based canonical locations; raw locations exist only after source verification. */
export interface ContextLocator {
  system_index?: number;
  message_index?: number;
  content_index?: number;
  raw_input_index?: number;
  raw_content_index?: number;
  /** UTF-16 offsets in a canonical string collapsed by parser; not read byte offsets. */
  text_start?: number;
  text_end_exclusive?: number;
  field: "systemPrompt" | "content" | "arguments" | "input" | "output" | "thinking";
}

export interface ContextSource {
  source_id: string;
  source_index: number;
  source_kind: ContextSourceKind;
  original_role: string;
  origin: string | null;
  author?: string | null;
  recipient?: string | null;
  provenance: "parsed" | "verified_raw" | "verified_restoration";
  source_completeness: ContextCompleteness;
  locator: Readonly<ContextLocator>;
}

export interface ContextRelation {
  state: "paired" | "missing" | "ambiguous" | "not_applicable";
  call_count: number;
  result_count: number;
  /** Internal target IDs. The navigator never emits out-of-range targets or references. */
  related_target_ids: readonly string[];
}

export interface ContextTarget {
  target_id: string;
  source_id: string;
  source_index: number;
  target_index: number;
  kind: ContextTargetKind;
  source_kind: ContextSourceKind;
  original_role: string;
  origin: string | null;
  author?: string | null;
  recipient?: string | null;
  provenance: ContextSource["provenance"];
  source_completeness: ContextCompleteness;
  tool_name: string | null;
  namespace: string | null;
  call_id: string | null;
  read_ref: string | null;
  encoding: "utf-8" | "deterministic-json" | null;
  utf8_bytes: number | null;
  mime_type: string | null;
  image_bytes: number | null;
  content_digest: string | null;
  /** Conservative estimate reserved for model vision; not measured tokens or billing. */
  visual_token_reserve: number | null;
  label: string;
  label_source: "excerpt" | "image_metadata" | "unavailable";
  unavailable_reason: string | null;
  error_status: "error" | "not_error" | "unknown";
  relation: Readonly<ContextRelation>;
  locator: Readonly<ContextLocator>;
}

/** Provided by an already authorized loader; no paths or fetch callbacks are accepted. */
export interface FixedContextImage {
  locator: Pick<ContextLocator, "message_index" | "content_index" | "system_index" | "raw_input_index" | "raw_content_index">;
  mime_type: string;
  bytes: Uint8Array;
  visual_token_reserve?: number;
}

/** Evidence is supplied only by the trusted restoration/provenance layer. */
export interface ContextSourceEvidence {
  source_kind?: "summary" | "delegation";
  source_completeness?: ContextCompleteness;
  restored?: boolean;
  /** Trusted restoration supplied an argument object, not its original string. */
  tool_arguments_encoding?: "deterministic-json";
}

export interface ContextDelivery {
  delivery: string;
  media_route?: "mcp" | "attachment" | "unavailable";
  required?: boolean;
  reason?: string;
}

export interface ContextFilter {
  kind?: ContextTargetKind;
  tool_name?: string;
  namespace?: string | null;
  call_id?: string;
  source_range?: { start: number; end_exclusive: number };
}

export interface ContextListArgs extends ContextFilter {
  context_id: string;
  view: "overview" | "entries";
  cursor?: string;
  required_only?: boolean;
}
export interface ContextReadArgs { context_id: string; read_ref: string; cursor?: string }
export interface ContextSearchArgs extends ContextFilter {
  context_id: string;
  query: string;
  read_ref?: string;
  cursor?: string;
}

/** Dynamic state is never mixed into stable entries/search pages. */
export interface ContextLiveOverview {
  context_ready?: boolean;
  text_ready?: boolean;
  images_ready?: boolean;
  required_texts?: number;
  delivered_texts?: number;
  required_text_bytes?: number;
  delivered_text_bytes?: number;
  next_required_read?: ContextRequiredRead | null;
  required_images?: number;
  delivered_images?: number;
  remaining_tokens?: number;
  remaining_wire_bytes?: number;
  stop_hint?: string;
}

export interface ContextRequiredRead {
  tool: "codex_context_read";
  arguments: ContextReadArgs;
}
export interface ContextBootstrapControl {
  read_state?: "readable" | "waiting" | "retired" | "failed";
  revision?: number;
  acknowledged_revision?: number;
  next_action?: string;
}
export interface ContextTextPageCost {
  start: number;
  end_exclusive: number;
  tokens: number;
  wire_bytes: number;
}

export interface ContextRemainingBudget {
  tokens: number;
  wire_bytes: number;
  /** Reserved for still-undelivered required media or compaction summary/submission. */
  reserved_tokens?: number;
  reserved_wire_bytes?: number;
  image_reads?: number;
  reserved_image_reads?: number;
  image_bytes?: number;
  reserved_image_bytes?: number;
}
