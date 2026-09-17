import { API_KEY_ENV } from "./api-access";
import type { AppConfig } from "./config";
import { installCompatibilityV1Features } from "./codex-integration-document";
import { codexInterruptHookCommand } from "./codex-interrupt-hook";

/** Render only. Neither the caller's config.toml nor auth.json is ever written here. */
export function renderApiKeyCodexConfig(options: {
  port: number;
  catalogPath: string;
  model: string;
  reasoningEffort: string;
  subagentProtocol?: AppConfig["subagentProtocol"];
  runtimeCommand?: string[];
}): string {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Invalid local API port");
  }
  if (!options.model.startsWith("chatgpt-web/")) throw new Error("A ChatGPT Web model is required");
  const quote = (value: string) => JSON.stringify(value);
  let text = [
    '# Manual client configuration; set the local service key in the client environment.',
    '# Merge tables with existing settings instead of duplicating TOML table headers.',
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
  // Reuse the same V1 defaults as OpenAI forwarding; native mode must not be pinned to V1.
  if ((options.subagentProtocol ?? "compatibility-v1") === "compatibility-v1") {
    const defaults = installCompatibilityV1Features("").text
      .split(/\r\n|\n|\r/)
      .filter(line => !line.trimStart().startsWith("#"))
      .map(line => line.replace(/[ \t]+#.*$/, ""))
      .join("\n").trim();
    // Exported settings belong to the user, not to the automatic injection journal.
    text = text.trimEnd() + "\n\n" + defaults + "\n";
  }
  if (options.runtimeCommand?.length) {
    const command = codexInterruptHookCommand({ runtimeCommand: options.runtimeCommand });
    text = text.trimEnd() + "\n\n" + [
      '# Interrupt lifecycle hook, shared with the forwarding integration.',
      '# No automatic trust hash: the destination file and hook index are chosen by you.',
      '# Approve this hook in Codex after merging it into your configuration.',
      '[[hooks.Interrupt]]',
      '',
      '[[hooks.Interrupt.hooks]]',
      'type = "command"',
      `command = ${quote(command)}`,
      'timeout = 3',
      '',
    ].join("\n");
  }
  // Deliberately omit openai_base_url, the authenticated OpenAI realtime route, and path-bound
  // hook trust state. They conflict with this custom provider or with manual destination choice.
  return text;
}
