import { upstreamModelAllowed, type UpstreamProviderConfig } from "./upstream-provider";

type JsonObject = Record<string, unknown>;

function objectRows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter((row): row is JsonObject => Boolean(row && typeof row === "object" && !Array.isArray(row))) : [];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compatibleReasoningLevels(value: unknown): boolean {
  return Array.isArray(value) && value.every(level => {
    if (!level || typeof level !== "object" || Array.isArray(level)) return false;
    const row = level as JsonObject;
    return nonEmptyString(row.effort) && typeof row.description === "string";
  });
}

function compatibleCodexRichModel(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as JsonObject;
  return nonEmptyString(row.slug)
    && nonEmptyString(row.display_name)
    && nonEmptyString(row.visibility)
    && typeof row.supported_in_api === "boolean"
    && compatibleReasoningLevels(row.supported_reasoning_levels)
    && (row.tool_mode === null || nonEmptyString(row.tool_mode))
    && typeof row.context_window === "number"
    && Number.isSafeInteger(row.context_window)
    && row.context_window > 0;
}

function catalogRows(value: unknown): { data: JsonObject[]; models: JsonObject[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upstream model catalog must be a JSON object");
  }
  const raw = value as JsonObject;
  const standard = raw.object === "list" && Array.isArray(raw.data);
  const richDeclared = Object.hasOwn(raw, "models");
  let models: JsonObject[] = [];
  if (richDeclared) {
    if (!Array.isArray(raw.models) || !raw.models.every(compatibleCodexRichModel)) {
      throw new Error("Upstream Codex model catalog is incompatible");
    }
    models = raw.models;
  }
  if (!standard && !richDeclared) throw new Error("Upstream model catalog is incompatible");
  return { data: standard ? objectRows(raw.data) : [], models };
}

function uniqueRows(rows: JsonObject[], field: "id" | "slug", config: UpstreamProviderConfig): JsonObject[] {
  const seen = new Set<string>();
  const result: JsonObject[] = [];
  for (const row of rows) {
    const model = row[field];
    if (typeof model !== "string" || !upstreamModelAllowed(model, config) || seen.has(model)) continue;
    seen.add(model);
    result.push(row);
  }
  return result;
}

export function upstreamCatalogModelIds(value: unknown, config: UpstreamProviderConfig): string[] {
  const rows = catalogRows(value);
  const ids = [
    ...uniqueRows(rows.data, "id", config).map(row => row.id as string),
    ...uniqueRows(rows.models, "slug", config).map(row => row.slug as string),
  ];
  return [...new Set(ids)];
}

export function mergeUpstreamModelCatalog<T extends { data: JsonObject[]; models: JsonObject[] }>(
  local: T,
  upstream: unknown,
  config: UpstreamProviderConfig,
): T {
  const rows = catalogRows(upstream);
  const upstreamData = uniqueRows(rows.data, "id", config);
  const upstreamModels = uniqueRows(rows.models, "slug", config);
  const localData = new Set(local.data.map(row => row.id).filter((id): id is string => typeof id === "string"));
  const localModels = new Set(local.models.map(row => row.slug).filter((id): id is string => typeof id === "string"));
  return {
    ...local,
    data: [...local.data, ...upstreamData.filter(row => !localData.has(row.id as string))],
    models: [...local.models, ...upstreamModels.filter(row => !localModels.has(row.slug as string))],
  };
}
