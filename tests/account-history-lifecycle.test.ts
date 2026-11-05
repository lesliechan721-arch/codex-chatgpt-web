import { expect, test } from "bun:test";
import { apiKeyPolicy } from "../src/api-access";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";

test("drain reports a retained remote turn and shutdown refuses it after HTTP transport is idle", async () => {
  const previousTimeout = process.env.CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC;
  process.env.CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC = "60";
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const clientKey = `cgw_${"h".repeat(43)}`;
  let finish = false;
  const server = startServer(config, { accessPolicy: apiKeyPolicy(clientKey),
    upstreamRuntime: { available: true, keyMatches: true, apiKey: "provider-test-key", config: {
      version: 2, baseUrl: "https://provider.example/v1/", apiKeySha256: "a".repeat(64), proxy: { mode: "direct" },
      models: [{ id: "gpt-5.6-sol" }], supportsOpenAiServerCompaction: false,
    } },
    fetchUpstreamProvider: async () => Response.json({ id: "native-retained-turn", status: "completed", output: finish ? []
      : [{ type: "function_call", call_id: "pending-native-tool", name: "exec_command", arguments: "{}" }] }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  const request = () => fetch(`${endpoint}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${clientKey}` },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: false, input: "Native turn input.",
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "retained-switch-thread", turn_id: "retained-switch-turn" }) } }),
  });
  try {
    await (await request()).text();
    const drain = await fetch(`${endpoint}/admin/drain`, { method: "POST", headers: authorization });
    expect(drain.status).toBe(200);
    expect(await drain.json()).toMatchObject({ accepting_turns: false, active_http_turns: 0, active_browser_turns: 0, active_remote_turn_idle_leases: 1 });
    const shutdown = await fetch(`${endpoint}/admin/shutdown`, { method: "POST", headers: authorization });
    expect(shutdown.status).toBe(409);
    expect(await shutdown.json()).toMatchObject({ status: "refused", active_remote_turn_idle_leases: 1 });
    await fetch(`${endpoint}/admin/resume`, { method: "POST", headers: authorization });
    finish = true;
    await (await request()).text();
    const idle = await fetch(`${endpoint}/admin/drain`, { method: "POST", headers: authorization });
    expect(await idle.json()).toMatchObject({ active_http_turns: 0, active_browser_turns: 0, active_remote_turn_idle_leases: 0 });
  } finally {
    await server.stop(true);
    if (previousTimeout === undefined) delete process.env.CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC;
    else process.env.CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC = previousTimeout;
  }
});
