import type { AppConfig } from "./config";
import { availableChatGptWebModelRoutes } from "./chatgpt-web-models";
import { buildChatGptWebModel } from "./model-catalog";
import metadata from "../launcher/electron/codex-model-metadata.cjs";

/**
 * Project-owned metadata, not a cached/authenticated OpenAI model. Keep required fields compatible
 * with Codex ModelInfo. Per-route identity, effort and compaction limits remain owned by the
 * existing buildChatGptWebModel/resolveChatGptWebContextLimits implementation.
 */
export function buildStandaloneModelCatalog(config: AppConfig): {
  models: Record<string, unknown>[];
  object: "list";
  data: { id: string; object: "model"; created: number; owned_by: string }[];
} {
  const instructions = metadata.PROJECT_GENERIC_INSTRUCTIONS;
  const template = {
    slug: "local-codex-template",
    display_name: "Local Codex metadata template",
    description: "Project-owned Responses contract; never exposed as a selectable model",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [],
    shell_type: config.mode === "full" ? "unified_exec" : "disabled",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: instructions },
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: true,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: config.mode === "full" ? "freeform" : null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_image_detail_original: false,
    experimental_supported_tools: [],
    supports_search_tool: false,
    tool_mode: null,
    multi_agent_version: config.subagentProtocol === "native" ? "v2" : "v1",
  };
  const routes = availableChatGptWebModelRoutes(config);
  const models = routes.map(route => buildChatGptWebModel(template, route, config));
  return {
    // Codex consumes `models`; OpenAI-compatible clients consume `object`/`data`.
    models,
    object: "list",
    data: routes.map(route => ({
      id: route.slug,
      object: "model",
      created: 0,
      owned_by: "codex-chatgpt-web",
    })),
  };
}
