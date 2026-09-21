import type { ApiAccessStatus } from "./api-access-types";

export type ActionFailureRecovery = "refresh-status" | "preserve-draft";

export function recordValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function customOverrideTextFor(record: Record<string, string>, modelId: string): string {
  return recordValue(record, modelId) ?? "{}";
}

export function parseCustomOverrideText(
  record: Record<string, string>,
  modelId: string,
): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(customOverrideTextFor(record, modelId)); }
  catch { throw new Error("invalid-upstream-metadata"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid-upstream-metadata");
  }
  return parsed as Record<string, unknown>;
}

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
