export type MetadataBaseMode = "upstream" | "default" | "fallback";
export type ModelMetadataConfig =
  | { mode: MetadataBaseMode }
  | { mode: "custom"; baseMode: MetadataBaseMode; overrides: Record<string, unknown> };

export interface UpstreamDiscovery {
  ids: string[];
  upstreamMetadata: Map<string, Record<string, unknown>>;
  richIds: Set<string>;
  sources: { data: boolean; models: boolean };
}

export interface ResolvedModelMetadata {
  model: Record<string, unknown>;
  availableModes: Array<MetadataBaseMode | "custom">;
  automaticMode: MetadataBaseMode;
  configuredMode: MetadataBaseMode | "custom" | null;
  configuredSourceAvailable: boolean;
  effectiveMode: MetadataBaseMode | "custom";
  effectiveBaseMode: MetadataBaseMode;
  degraded: boolean;
  customInvalid: boolean;
}

export const PROJECT_GENERIC_INSTRUCTIONS: string;
export const sourceLock: { version: number; repository: string; tag: string; revision: string };
export function normalizeModelId(value: unknown): string;
export function normalizeMetadataConfig(value: unknown): ModelMetadataConfig | undefined;
export function parseUpstreamDiscovery(value: unknown): UpstreamDiscovery;
export function resolveModelMetadata(
  modelId: string,
  configuredMetadata: ModelMetadataConfig | undefined,
  discovery: UpstreamDiscovery,
  shellType: "unified_exec" | "disabled",
  options?: { strictCustom?: boolean },
): ResolvedModelMetadata;
export function metadataPreview(
  models: Array<{ id: string; metadata?: ModelMetadataConfig }>,
  discovery: UpstreamDiscovery,
  shellType: "unified_exec" | "disabled",
): Array<Record<string, unknown>>;
export function finalModelError(model: unknown): string | null;
export function bundledModelIds(): string[];
export function customMetadataSchema(): Record<string, unknown>;
export function protectedMetadataFields(): string[];
