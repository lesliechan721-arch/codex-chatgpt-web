import type {
  MetadataBaseMode,
  ModelMetadataConfig,
  UpstreamModelCandidate,
  UpstreamModelPreview,
} from "./api-access-types";

function metadataFacts(
  candidate: UpstreamModelCandidate | undefined,
  preview: UpstreamModelPreview | undefined,
): UpstreamModelCandidate | UpstreamModelPreview | undefined {
  return candidate ?? preview;
}

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

export function retainBundledMetadataFacts(
  facts: Readonly<Record<string, UpstreamModelCandidate>>,
): Record<string, UpstreamModelCandidate> {
  return Object.fromEntries(Object.entries(facts).flatMap(([key, fact]) => fact.hasBundledMetadata
    ? [[key, {
        id: fact.id,
        hasUpstreamMetadata: false,
        hasBundledMetadata: true,
        availableModes: ["default", "fallback", "custom"],
        automaticMode: "default",
      } satisfies UpstreamModelCandidate]]
    : []));
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

export function metadataModeChoices(
  candidate: UpstreamModelCandidate | undefined,
  preview: UpstreamModelPreview | undefined,
): {
  modes: Array<MetadataBaseMode | "custom">;
  baseModes: MetadataBaseMode[];
} {
  const facts = metadataFacts(candidate, preview);
  const modes = new Set<MetadataBaseMode | "custom">(["fallback", "custom"]);
  facts?.availableModes.forEach(mode => modes.add(mode));
  const orderedModes = (["upstream", "default", "fallback", "custom"] as const).filter(mode => modes.has(mode));
  return {
    modes: orderedModes,
    baseModes: orderedModes.filter((mode): mode is MetadataBaseMode => mode !== "custom"),
  };
}

export function automaticMetadataMode(
  candidate: UpstreamModelCandidate | undefined,
  preview: UpstreamModelPreview | undefined,
): MetadataBaseMode {
  return metadataFacts(candidate, preview)?.automaticMode ?? "fallback";
}

export function customMetadataBaseMode(
  configured: ModelMetadataConfig | undefined,
  candidate: UpstreamModelCandidate | undefined,
  preview: UpstreamModelPreview | undefined,
): MetadataBaseMode {
  if (configured?.mode === "custom") return configured.baseMode;
  return configured?.mode ?? automaticMetadataMode(candidate, preview);
}

export function modelDiscoveryState(
  candidate: UpstreamModelCandidate | undefined,
  preview: UpstreamModelPreview | undefined,
  discoveryComplete: boolean,
): "discovered" | "missing" | "unavailable" {
  const candidateDiscovered = candidate && "discovered" in candidate
    ? candidate.discovered === true
    : undefined;
  if (preview?.discovered === true || candidateDiscovered === true
    || (candidateDiscovered === undefined && discoveryComplete && candidate !== undefined)) return "discovered";
  return discoveryComplete ? "missing" : "unavailable";
}
