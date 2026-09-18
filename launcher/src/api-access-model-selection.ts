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

export function filterModelCandidates(candidates: readonly string[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter(model => model.toLowerCase().includes(needle));
}
