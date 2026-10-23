import { CONTEXT_TEXT_READ_FORMAT } from "./context-text-result";

/** Version 6 supports selective v3 payloads and has no cumulative page/read admission ceiling. */
export const CONTEXT_PROTOCOL_VERSION = 6;

/** Current source-navigation ABI, shared by Broker status and the browser helper. */
export function contextProtocolCapabilities(version: number) {
  return { contextProtocol: version, contextReadArguments: "reads-array" as const,
    contextTextReadFormat: CONTEXT_TEXT_READ_FORMAT, contextManifestVersion: 3 as const,
    contextRequiredDiscovery: "batch-metadata" as const };
}

export function hasContextToolCapabilities(value: unknown, version: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as Record<string, unknown>;
  return status.contextProtocol === version && status.contextReadArguments === "reads-array"
    && status.contextTextReadFormat === CONTEXT_TEXT_READ_FORMAT;
}

export function hasContextBootstrapCapabilities(value: unknown, version: number): boolean {
  if (!hasContextToolCapabilities(value, version)) return false;
  const status = value as Record<string, unknown>;
  return status.contextManifestVersion === 3 && status.contextRequiredDiscovery === "batch-metadata";
}
