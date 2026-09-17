export type ApiAccessMode = "openai" | "api-key";
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
  apiAccessExport(): Promise<ApiAccessResult<{ config: string; catalogPath: string }>>;
}
