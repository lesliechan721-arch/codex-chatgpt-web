import { API_KEY_ENV } from "./api-access";

/** Produce a standalone Codex config/profile; never change auth.json or the user's existing TOML. */
export function renderApiKeyCodexConfig(options: {
  port: number;
  catalogPath: string;
  model: string;
  reasoningEffort: string;
}): string {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Invalid local API port");
  }
  if (!options.model.startsWith("chatgpt-web/")) throw new Error("A ChatGPT Web model is required");
  // JSON double-quoted strings are TOML-compatible for these validated values and absolute paths.
  const quote = (value: string) => JSON.stringify(value);
  return [
    '# Local service key only; do not use an OpenAI API key here.',
    'model_provider = "chatgpt_web"',
    `model = ${quote(options.model)}`,
    `model_reasoning_effort = ${quote(options.reasoningEffort)}`,
    `model_catalog_json = ${quote(options.catalogPath)}`,
    'web_search = "disabled"',
    '',
    '[model_providers.chatgpt_web]',
    'name = "ChatGPT Web (local API key)"',
    `base_url = "http://127.0.0.1:${options.port}/v1"`,
    'wire_api = "responses"',
    `env_key = "${API_KEY_ENV}"`,
    'requires_openai_auth = false',
    'supports_websockets = false',
    '',
  ].join("\n");
}
