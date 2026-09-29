export const CONTINUITY_IDLE_TTL_MS = 86_400_000;
export const CONTINUITY_FEATURE = "session-continuity-v1";

export interface ContinuityLease {
  owner: string;
  leaseId: string;
  traceId: string;
}

export interface ContinuityClaim {
  owner: string;
  expected?: ContinuityLease;
}

export function isContinuityLease(value: unknown): value is ContinuityLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const lease = value as Record<string, unknown>;
  return Object.keys(lease).sort().join(",") === "leaseId,owner,traceId"
    && typeof lease.owner === "string" && /^[a-f0-9]{64}$/.test(lease.owner)
    && typeof lease.leaseId === "string" && /^[a-f0-9]{32}$/.test(lease.leaseId)
    && typeof lease.traceId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(lease.traceId);
}

export function isContinuityClaim(value: unknown): value is ContinuityClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return typeof claim.owner === "string" && /^[a-f0-9]{64}$/.test(claim.owner)
    && (Object.keys(claim).sort().join(",") === "owner"
      || (Object.keys(claim).sort().join(",") === "expected,owner"
        && isContinuityLease(claim.expected) && claim.expected.owner === claim.owner));
}
