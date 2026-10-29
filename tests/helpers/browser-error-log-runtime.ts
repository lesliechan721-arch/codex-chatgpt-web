import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../../src/adapters/chatgpt-web";
import { chatGptTurnSessions } from "../../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../../src/config";
import { responseRequest } from "../../src/server";
import type { CodexProviderConfig } from "../../src/types";

export const sensitiveErrorSamples = [
  "private-prompt-sample-781", "private-tool-arguments-325", "private-result-body-629",
  "e7Q4v9Az2L6m8Y1w5N3c0B9d", "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==",
];
const sensitiveBody = sensitiveErrorSamples.join(" ");

export interface BrowserErrorLogResult {
  name: string;
  reason?: string;
  code?: string;
  traceId?: string;
  submission: "prepared" | "accepted";
  httpStatus: number;
  response: { status: string; error?: { type: string; code: string } };
  body: string;
}

const cases = [
  { name: "ordinary-source", failure: () => new Error(`The selected context navigation cost evidence is unavailable. ${sensitiveBody}`), reason: "source_unavailable" },
  { name: "ordinary-protocol", failure: () => new Error(`Launcher browser helper does not support the MCP completion fence; update or restart the launcher. ${sensitiveBody}`), reason: "protocol_incompatible" },
  { name: "adapter-protocol", failure: () => new ChatGptWebAdapterError(`Context delivery unavailable. ${sensitiveBody}`, {
    status: 503, errorType: "server_error", code: "codex_context_upgrade_required", retryable: false,
    cause: new Error(sensitiveBody),
  }), reason: "protocol_incompatible", code: "codex_context_upgrade_required" },
  { name: "adapter-source", failure: () => new ChatGptWebAdapterError(`Source unavailable. ${sensitiveBody}`, {
    status: 409, errorType: "invalid_request_error", code: "compaction_source_unavailable", retryable: false,
  }), reason: "source_unavailable", code: "compaction_source_unavailable" },
  { name: "ordinary-overload", failure: () => new Error(`Selected model is at capacity. ${sensitiveBody}`),
    reason: "upstream_overloaded", code: "server_is_overloaded" },
  { name: "upstream-overload", failure: () => new ChatGptWebAdapterError(`ChatGPT is overloaded. ${sensitiveBody}`, {
    status: 503, errorType: "server_error", code: "server_is_overloaded", retryable: false,
  }), reason: "upstream_overloaded", code: "server_is_overloaded" },
  { name: "cancelled", failure: () => new ChatGptWebAdapterError(`Client cancelled request. ${sensitiveBody}`, {
    status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false,
  }), reason: "task_cancelled", code: "client_cancelled" },
  { name: "delivery-timeout", failure: () => new ChatGptWebAdapterError(`Delivery timed out. ${sensitiveBody}`, {
    status: 503, errorType: "server_error", code: "chatgpt_delivery_timeout", retryable: true,
  }), reason: "execution_timeout", code: "chatgpt_delivery_timeout" },
  { name: "stale-capabilities", failure: () => new ChatGptWebAdapterError(`Refresh installed models. ${sensitiveBody}`, {
    status: 409, errorType: "invalid_request_error", code: "chatgpt_capabilities_stale", retryable: false,
  }), reason: "browser_execution_failed", code: "chatgpt_capabilities_stale" },
  { name: "unknown-model-controls", failure: () => new ChatGptWebAdapterError(`Model controls unavailable. ${sensitiveBody}`, {
    status: 409, errorType: "invalid_request_error", code: "chatgpt_model_controls_unavailable", retryable: false,
  }), reason: "browser_execution_failed", code: "chatgpt_model_controls_unavailable" },
  { name: "unknown-adapter", failure: () => new ChatGptWebAdapterError(sensitiveBody, {
    status: 502, errorType: sensitiveErrorSamples[0]!, code: sensitiveErrorSamples[3]!, retryable: false,
    cause: new Error(sensitiveBody),
  }), reason: "browser_execution_failed" },
  { name: "success", reason: undefined, failure: undefined },
] as const;

export async function runBrowserErrorLogCases(root: string) {
  const results: BrowserErrorLogResult[] = [];
  for (const scenario of cases) {
    const turnId = `turn-${scenario.name}`;
    const threadId = `thread-${scenario.name}`;
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web", baseUrl: `browser://error-log-${scenario.name}-${process.pid}`,
      chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
        threadEnvironmentStatePath: join(root, `${scenario.name}-environment.json`) },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run;
    let traceId: string | undefined;
    worker.run = async turn => {
      traceId = turn.traceId;
      if (scenario.name === "upstream-overload" || scenario.name === "success") {
        await turn.onSendActivated?.();
        await turn.onSubmitted?.();
      }
      const failure = scenario.failure?.();
      if (failure) throw failure;
      const answer = "Completed successfully.";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      const environment = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/high", stream: true,
          client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) },
          input: [environment, "Inspect the workspace."].map((text, index) => ({
            type: "message", role: "user", id: `message-${index}`, content: [{ type: "input_text", text }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          })),
        }),
      }), defaultConfig("browser-only"), () => createChatGptWebAdapter(provider));
      const body = await response.text();
      const terminal = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(event => event.type === "response.failed" || event.type === "response.completed");
      results.push({ name: scenario.name, reason: scenario.reason, code: "code" in scenario ? scenario.code : undefined,
        traceId, submission: scenario.name === "upstream-overload" || scenario.name === "success" ? "accepted" : "prepared",
        httpStatus: response.status, response: terminal?.response, body });
    } finally {
      worker.run = originalRun;
      chatGptTurnSessions.clear();
    }
  }
  return results;
}

if (import.meta.main) {
  const root = process.argv[2]!;
  writeFileSync(join(root, "responses.json"), JSON.stringify(await runBrowserErrorLogCases(root)));
}
