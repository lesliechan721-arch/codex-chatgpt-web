export type ApiAccessMode = "openai" | "api-key";
export type UpstreamProxy = { mode: "global" } | { mode: "direct" } | { mode: "custom"; url: string };
export type UpstreamModelFilter = { mode: "all" } | { mode: "regex"; pattern: string } | { mode: "selected"; models: string[] };
export interface UpstreamStatus {
  configured: boolean;
  baseUrl?: string;
  proxy?: UpstreamProxy;
  modelFilter?: UpstreamModelFilter;
  supportsOpenAiServerCompaction?: boolean;
  keyAvailable: boolean;
  keyStorage: "os" | "session" | "unavailable";
  runtimeAvailable: boolean;
}
export interface ApiAccessStatus {
  configuredMode: ApiAccessMode | "invalid";
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
    modelFilter: UpstreamModelFilter;
    supportsOpenAiServerCompaction: boolean;
  }): Promise<ApiAccessResult<{ status: ApiAccessStatus }>>;
  apiAccessUpstreamDelete(input: { expectedRevision: string }): Promise<ApiAccessResult<{ status: ApiAccessStatus }>>;
  apiAccessUpstreamModels(input: { baseUrl: string; apiKey?: string; proxy: UpstreamProxy }): Promise<ApiAccessResult<{ models: string[] }>>;
}
