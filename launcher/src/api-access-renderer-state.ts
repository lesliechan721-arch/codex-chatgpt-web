import type { ApiAccessStatus } from "./api-access-types";

export type ActionFailureRecovery = "refresh-status" | "preserve-draft";

export async function recoverApiAccessActionFailure(
  recovery: ActionFailureRecovery,
  refreshStatus: () => Promise<void>,
): Promise<void> {
  if (recovery === "preserve-draft") return;
  try { await refreshStatus(); } catch {}
}

export function upstreamDraftRevisionConflict(
  dirty: boolean,
  baselineRevision: string | null,
  currentRevision: string | null,
): boolean {
  return dirty && baselineRevision !== null && currentRevision !== baselineRevision;
}

export function upstreamDraftMutationRevision(
  baselineRevision: string | null,
  currentRevision: string | null,
): string | null {
  return baselineRevision !== null && baselineRevision === currentRevision ? baselineRevision : null;
}

export function upstreamDraftDiscoveryRevision(
  baselineRevision: string | null,
  currentRevision: string | null,
  hasDraftKey: boolean,
): string | null {
  if (baselineRevision === null) return null;
  return hasDraftKey ? baselineRevision : upstreamDraftMutationRevision(baselineRevision, currentRevision);
}

export function shouldShowUpstreamMissingKey(status: ApiAccessStatus | null): boolean {
  return status?.upstream?.configured === true && status.upstream.keyAvailable === false;
}
