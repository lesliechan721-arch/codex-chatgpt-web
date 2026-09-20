export type ApiAccessMode = "openai" | "api-key";
export type UpstreamProxy = { mode: "global" } | { mode: "direct" } | { mode: "custom"; url: string };
export type MetadataBaseMode = "upstream" | "default" | "fallback";
export type ModelMetadataConfig =
  | { mode: MetadataBaseMode }
  | { mode: "custom"; baseMode: MetadataBaseMode; overrides: Record<string, unknown> };
export interface UpstreamModelConfig {
  id: string;
  metadata?: ModelMetadataConfig;
}
export interface UpstreamStatus {
  configured: boolean;
  baseUrl?: string;
  proxy?: UpstreamProxy;
  models?: UpstreamModelConfig[];
  supportsOpenAiServerCompaction?: boolean;
  keyAvailable: boolean;
  keyStorage: "os" | "session" | "unavailable";
  runtimeAvailable: boolean;
  resetReason?: "legacy-v1-removed";
  metadata?: UpstreamModelPreview[];
  metadataSchema?: Record<string, unknown>;
  protectedMetadataFields?: string[];
}
export interface ApiAccessStatus {
  configuredMode: ApiAccessMode | "invalid";
  errorCode?: string;
  effectiveMode: ApiAccessMode | null;
  revision: string | null;
  keyConfigured: boolean;
  keyAvailable: boolean;
  keyStorage: "os" | "session" | "unavailable";
  runtimeState: "invalid" | "unconfigured" | "stopped" | "in-sync" | "restart-required";
  baseUrl: string | null;
  canApply: boolean;
  cleanupPending: boolean;
  routingPending?: boolean;
  upstream?: UpstreamStatus;
}
export type ApiAccessResult<T> = { ok: true; value: T } | { ok: false; code: string };
export interface ApiAccessChange {
  mode: ApiAccessMode;
  key?: string;
  expectedRevision: string;
}
export interface UpstreamModelCandidate {
  id: string;
  hasUpstreamMetadata: boolean;
  hasBundledMetadata: boolean;
  availableModes: Array<MetadataBaseMode | "custom">;
  automaticMode: MetadataBaseMode;
}
export interface UpstreamModelPreview extends UpstreamModelCandidate {
  discovered: boolean;
  configuredMode: MetadataBaseMode | "custom" | null;
  configuredSourceAvailable: boolean;
  effectiveMode: MetadataBaseMode | "custom";
  effectiveBaseMode: MetadataBaseMode;
  degraded: boolean;
  customInvalid: boolean;
  customError?: string | null;
  model: Record<string, unknown>;
}
export interface ApiAccessApi {
  apiAccessStatus(): Promise<ApiAccessResult<ApiAccessStatus>>;
  apiAccessGenerate(): Promise<ApiAccessResult<string>>;
  apiAccessReveal(): Promise<ApiAccessResult<string>>;
  apiAccessApply(input: ApiAccessChange): Promise<ApiAccessResult<{ cancelled: boolean; status: ApiAccessStatus }>>;
  apiAccessCopyKey(key: string): Promise<ApiAccessResult<boolean>>;
  apiAccessCopyUrl(): Promise<ApiAccessResult<boolean>>;
  apiAccessExport(): Promise<ApiAccessResult<{ config: string; environment: Record<string, string>; catalogPath: string }>>;
  apiAccessUpstreamSave(input: {
    expectedRevision: string;
    baseUrl: string;
    apiKey?: string;
    proxy: UpstreamProxy;
    models: UpstreamModelConfig[];
    supportsOpenAiServerCompaction: boolean;
  }): Promise<ApiAccessResult<{ status: ApiAccessStatus }>>;
  apiAccessUpstreamDelete(input: { expectedRevision: string }): Promise<ApiAccessResult<{ status: ApiAccessStatus }>>;
  apiAccessUpstreamModels(input: {
    expectedRevision: string;
    baseUrl: string;
    apiKey?: string;
    proxy: UpstreamProxy;
    models: UpstreamModelConfig[];
  }): Promise<ApiAccessResult<{
    models: string[];
    candidates: UpstreamModelCandidate[];
    preview: UpstreamModelPreview[];
    sources: { data: boolean; models: boolean };
  }>>;
}
