/** Reuse metadata never contains source bodies or credentials. */
export const CONTEXT_REUSE_PROTOCOL = "context-reuse-v1" as const;
export const CONTEXT_REUSE_MAX_UNITS = 128;
export const CONTEXT_REUSE_MAX_BYTES = 64 * 1024;

export interface ContextReuseUnit {
  unit_id: string;
  fingerprint: string;
  kind: string;
  role: string;
  scope: string;
  utf8_bytes: number;
}

export interface ContextReuseBaseline {
  baseline_id: string;
  page_identity: string;
  predecessor: string;
  units: readonly ContextReuseUnit[];
  /** Only domains with an explicit producer replacement contract. */
  snapshots: readonly { domain: string; state: string; unit_ids: readonly string[] }[];
}

export interface ContextReuseDependency {
  baseline_id: string;
  page_identity: string;
  predecessor: string;
  units: readonly { unit_id: string; fingerprint: string }[];
}

export interface ContextReusePlan {
  protocol: typeof CONTEXT_REUSE_PROTOCOL;
  payload_format: "context-bootstrap-payload-v2";
  mode: "full" | "incremental";
  dependency?: ContextReuseDependency;
  units: readonly (ContextReuseUnit & {
    delivery: "inline" | "required" | "reuse";
    /** Current scope source for precise rereading. */
    target_id: string;
  })[];
  snapshots: ContextReuseBaseline["snapshots"];
}

export interface ContextReuseDeliveryEvidence {
  plan_id: string;
  context_id: string;
  units: readonly ContextReuseUnit[];
  snapshots: ContextReuseBaseline["snapshots"];
}
