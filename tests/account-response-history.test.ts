import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { responseRequest, startServer } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

const keys = ["CODEX_CHATGPT_WEB_HOME", "CODEX_CHATGPT_WEB_APPLICATION_HOME", "CODEX_CHATGPT_WEB_ACCOUNT_ID", "CODEX_CHATGPT_WEB_ACCOUNTS_PATH"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const roots: string[] = [];
afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "response-history-boundary-"));
  roots.push(root);
  const home = join(root, "accounts", "12345678-1234-4123-8123-123456789abc", "core");
  mkdirSync(home, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = root;
  process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID = "12345678-1234-4123-8123-123456789abc";
  process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH = join(root, "accounts.json");
  // Neither this corrupt registry nor the old account's cache is a request input.
  writeFileSync(process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH, "not JSON");
  const snapshot = JSON.stringify({ version: 1, states: [["resp-old", { createdAt: Date.now(), completed: true,
    threadId: "task-one", items: [{ role: "user", content: "Source account secret history." }] }]] });
  writeFileSync(join(root, "responses-state.json"), snapshot);
  const observed: CodexParsedRequest[] = [];
  const adapter = () => ({ name: "current-request",
    async runTurn(parsed: CodexParsedRequest, _incoming: unknown, emit: (event: import("../src/types").AdapterEvent) => void) {
      observed.push(parsed);
      emit({ type: "text_delta", text: "New answer.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const config = defaultConfig("browser-only");
  const send = (body: unknown) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), config, adapter);
  return { root, home, snapshot, observed, adapter, config, send };
}

for (const stream of [false, true]) test(`local Web ignores extra previous_response_id and uses only current input (stream=${stream})`, async () => {
  const f = fixture();
  const input = [
    { role: "user", content: "Current task history." },
    { role: "assistant", content: "Earlier answer in the current request." },
    { role: "user", content: "Continue this task." },
  ];
  for (const extra of [{}, { previous_response_id: "resp-old" }, { previous_response_id: { unsupported: true } }]) {
    const response = await f.send({ model: "chatgpt-web/high", stream, input, ...extra });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("New answer.");
  }
  expect(f.observed).toHaveLength(3);
  const contexts = f.observed.map(parsed => ({ ...parsed.context,
    messages: parsed.context.messages.map(({ timestamp: _timestamp, ...message }) => message) }));
  expect(contexts).toEqual(Array(3).fill(contexts[0]));
  for (const parsed of f.observed) expect((parsed._rawBody as { input: unknown }).input).toEqual(input);
  expect(existsSync(join(f.home, "responses-state.json"))).toBe(false);
  expect(readFileSync(join(f.root, "responses-state.json"), "utf8")).toBe(f.snapshot);
});

test("a short input is processed as supplied; missing and invalid input use general validation", async () => {
  const f = fixture();
  const response = await f.send({ model: "chatgpt-web/high", input: "Continue.", previous_response_id: "resp-old" });
  expect(response.status).toBe(200);
  await response.text();
  expect(f.observed[0]!.context.messages.map(message => message.content)).toEqual(["Continue."]);
  for (const body of [{ model: "chatgpt-web/high", input: 42 }, { input: "Missing model." }]) {
    const invalid = await f.send({ ...body, previous_response_id: "resp-old" });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("responses parse error");
  }
  expect(f.observed).toHaveLength(1);
});

test("server shutdown does not create or refresh response history snapshots", async () => {
  const f = fixture();
  for (const contents of [undefined, "obsolete corrupt snapshot"]) {
    const path = join(f.home, "responses-state.json");
    if (contents !== undefined) writeFileSync(path, contents);
    const server = startServer({ ...f.config, port: 0 }, { adapterFactory: f.adapter });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/high", input: "Current input.", stream: false }) });
      expect(response.status).toBe(200);
      await response.text();
    } finally { await server.stop(true); }
    if (contents === undefined) expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toBe(contents);
  }
});
