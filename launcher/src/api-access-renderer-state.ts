import type { ApiAccessStatus } from "./api-access-types";

export type ActionFailureRecovery = "refresh-status" | "preserve-draft";

export async function recoverApiAccessActionFailure(
  recovery: ActionFailureRecovery,
  refreshStatus: () => Promise<void>,
): Promise<void> {
  if (recovery === "preserve-draft") return;
  try { await refreshStatus(); } catch {}
}

export function shouldShowUpstreamMissingKey(status: ApiAccessStatus | null): boolean {
  return status?.upstream?.configured === true && status.upstream.keyAvailable === false;
}
