export function retainSelectedModelCandidates(fetched: readonly string[], selected: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of [...fetched, ...selected]) {
    if (seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

export function resetDiscoveredModelCandidates(selected: readonly string[]): string[] {
  return retainSelectedModelCandidates([], selected);
}

export function filterModelCandidates(candidates: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter(model => model.toLowerCase().includes(needle));
}

export function modelCandidateEmptyState(
  candidates: readonly string[],
  filteredCandidates: readonly string[],
  discoveryComplete: boolean,
): "not-fetched" | "empty" | "no-match" | null {
  if (filteredCandidates.length > 0) return null;
  if (candidates.length > 0) return "no-match";
  return discoveryComplete ? "empty" : "not-fetched";
}
