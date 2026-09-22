import metadata from "../launcher/electron/codex-model-metadata.cjs";
import type { UpstreamDiscovery } from "../launcher/electron/codex-model-metadata.cjs";
import { upstreamModelConfig, type UpstreamProviderConfig } from "./upstream-provider";

type JsonObject = Record<string, unknown>;
export type UpstreamShellType = "unified_exec" | "disabled";

export interface NormalizedUpstreamCatalog {
  object: "list";
  data: JsonObject[];
  models: JsonObject[];
  discovery: UpstreamDiscovery;
  metadataRepairCount: number;
}

export function parseUpstreamModelDiscovery(value: unknown): UpstreamDiscovery {
  return metadata.parseUpstreamDiscovery(value);
}

export function upstreamCatalogModelIds(value: unknown): string[] {
  return parseUpstreamModelDiscovery(value).ids;
}

export function normalizeUpstreamModelCatalog(
  upstream: unknown,
  config: UpstreamProviderConfig,
  shellType: UpstreamShellType,
): NormalizedUpstreamCatalog {
  const discovery = parseUpstreamModelDiscovery(upstream);
  const selected = new Set(config.models.map(model => model.id));
  const publishIds = discovery.ids.filter(id => selected.has(id));
  let metadataRepairCount = 0;
  const models = publishIds.map(id => {
    const configured = upstreamModelConfig(id, config);
    if (!configured) throw new Error("Selected upstream model configuration disappeared");
    const resolved = metadata.resolveModelMetadata(id, configured.metadata, discovery, shellType);
    if (resolved.customInvalid) metadataRepairCount += 1;
    return resolved.model;
  });
  return {
    object: "list",
    data: publishIds.map(id => ({ id, object: "model", created: 0, owned_by: "configured-upstream" })),
    models,
    discovery,
    metadataRepairCount,
  };
}

export function upstreamMetadataRepairCount(
  config: UpstreamProviderConfig,
  shellType: UpstreamShellType,
): number {
  const providerIndependentDiscovery = parseUpstreamModelDiscovery({ data: [] });
  return config.models.reduce((count, configured) => {
    if (configured.metadata?.mode !== "custom") return count;
    const resolved = metadata.resolveModelMetadata(
      configured.id,
      configured.metadata,
      providerIndependentDiscovery,
      shellType,
    );
    return count + (resolved.customInvalid ? 1 : 0);
  }, 0);
}

export function mergeUpstreamModelCatalog<T extends { data: JsonObject[]; models: JsonObject[] }>(
  local: T,
  upstream: unknown,
  config: UpstreamProviderConfig,
  shellType: UpstreamShellType,
): T {
  const normalized = normalizeUpstreamModelCatalog(upstream, config, shellType);
  return {
    ...local,
    data: [...local.data, ...normalized.data],
    models: [...local.models, ...normalized.models],
  };
}
