import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { CodexParsedRequest } from "../src/types";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "../src/responses/state";

const accountB = "12345678-1234-4123-8123-123456789abc";
const environmentKeys = ["CODEX_CHATGPT_WEB_HOME", "CODEX_CHATGPT_WEB_APPLICATION_HOME", "CODEX_CHATGPT_WEB_ACCOUNT_ID", "CODEX_CHATGPT_WEB_ACCOUNTS_PATH"] as const;
const previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const roots: string[] = [];
afterEach(() => {
  flushResponseState();
  for (const key of environmentKeys) {
    const value = previousEnvironment[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const app = mkdtempSync(join(tmpdir(), "account-response-history-"));
  roots.push(app);
  const registry = join(app, "accounts.json");
  const homes = { default: app, [accountB]: join(app, "accounts", accountB, "core") };
  const records = [{ id: "default", name: "A", legacy: true, status: "active" }, { id: accountB, name: "B", legacy: false, status: "active" }];
  const saveRegistry = () => writeFileSync(registry, JSON.stringify({ version: 1, accounts: records }));
  saveRegistry();
  function select(id: "default" | typeof accountB) {
    mkdirSync(homes[id], { recursive: true });
    process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = app;
    process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH = registry;
    process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID = id;
    process.env.CODEX_CHATGPT_WEB_HOME = homes[id];
  }
  const body = (input: unknown, previous_response_id?: string, thread = "task-one") => ({
    model: "chatgpt-web/high", stream: false, input,
    ...(previous_response_id ? { previous_response_id } : {}),
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "turn-current" }) },
  });
  const output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "A completed answer." }] }];
  select("default");
  const first = body([{ role: "user", content: "Original task." }]);
  rememberResponseState(first, { id: "resp-a", status: "completed", output }, { force: true });
  flushResponseState();
  return { app, homes, records, saveRegistry, select, body, first, output };
}

test("an exact previous response and thread prepare only the needed logical history in memory", () => {
  const f = fixture();
  f.select(accountB);
  const next = f.body("Continue in B.", "resp-a");
  const expanded = expandPreviousResponseInput(next) as { input: unknown[] };
  expect(expanded.input).toEqual([...(f.first.input as unknown[]), ...f.output, { role: "user", content: "Continue in B." }]);
  flushResponseState();
  expect(existsSync(join(f.homes[accountB], "responses-state.json"))).toBe(false);
});

for (const removed of [false, true]) test(`an incremental user/assistant exchange cannot replace the source constraints (source removed=${removed})`, async () => {
  const f = fixture();
  f.select(accountB);
  if (removed) {
    f.records[0]!.status = "removing";
    f.saveRegistry();
    rmSync(join(f.app, "responses-state.json"));
  }
  const delta = [{ role: "user", content: "A later incremental question." },
    { role: "assistant", content: "An answer from that incremental exchange." },
    { role: "user", content: "Continue the original task." }];
  let observed: CodexParsedRequest | undefined;
  const result = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body(delta, "resp-a")),
  }), defaultConfig("browser-only"), () => ({ name: "incremental-target",
    async runTurn(parsed, _incoming, emit) {
      observed = parsed;
      emit({ type: "text_delta", text: "New target answer.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  if (removed) {
    expect(result.status).toBe(409);
    expect(observed).toBeUndefined();
    flushResponseState();
    expect(existsSync(join(f.homes[accountB], "responses-state.json"))).toBe(false);
  } else {
    expect(result.status).toBe(200);
    await result.text();
    expect(observed!.previousResponseId).toBe("resp-a");
    expect((observed!._rawBody as { input: unknown[] }).input).toEqual([...(f.first.input as unknown[]), ...f.output, ...delta]);
  }
});

test("ordinary CLI continuation preserves its cached constraints when a delta has user and assistant messages", () => {
  const f = fixture();
  delete process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME;
  delete process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID;
  delete process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH;
  const delta = [{ role: "user", content: "A later incremental question." },
    { role: "assistant", content: "Its answer." }, { role: "user", content: "Continue." }];
  const expanded = expandPreviousResponseInput(f.body(delta, "resp-a")) as { input: unknown[]; previous_response_id?: string };
  expect(expanded.input).toEqual([...(f.first.input as unknown[]), ...f.output, ...delta]);
  expect(expanded.previous_response_id).toBe("resp-a");
});

test("source lookup rejects another thread, a removed account and expired or legacy entries", () => {
  const f = fixture();
  f.select(accountB);
  expect(() => expandPreviousResponseInput(f.body("Continue.", "resp-a", "another-task"))).toThrow();
  expect(() => expandPreviousResponseInput(f.body("Continue.", "unknown-response"))).toThrow();
  expect(() => expandPreviousResponseInput({ input: "Continue.", previous_response_id: "resp-a" })).toThrow();
  f.records[0]!.status = "removing";
  f.saveRegistry();
  expect(() => expandPreviousResponseInput(f.body("Continue.", "resp-a"))).toThrow();
  f.records[0]!.status = "active";
  f.saveRegistry();
  const path = join(f.app, "responses-state.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  snapshot.states[0][1].createdAt = Date.now() - 61 * 60_000;
  writeFileSync(path, JSON.stringify(snapshot));
  expect(() => expandPreviousResponseInput(f.body("Continue.", "resp-a"))).toThrow();
  snapshot.states[0][1].createdAt = Date.now();
  delete snapshot.states[0][1].threadId;
  writeFileSync(path, JSON.stringify(snapshot));
  expect(() => expandPreviousResponseInput(f.body("Continue.", "resp-a"))).toThrow();
});

test("current complete history matching the exact committed source is used without duplicate expansion", () => {
  const f = fixture();
  f.select(accountB);
  const input = [...(f.first.input as unknown[]), ...f.output, { role: "user", content: "Continue from this complete history." }];
  const expanded = expandPreviousResponseInput(f.body(input, "resp-a")) as { input: unknown[]; previous_response_id?: string };
  expect(expanded.input).toEqual(input);
  expect(expanded.previous_response_id).toBeUndefined();
});

test("a complete request without an old response dependency still works after its source account was removed", () => {
  const f = fixture();
  f.select(accountB);
  f.records[0]!.status = "removing";
  f.saveRegistry();
  rmSync(join(f.app, "responses-state.json"));
  const input = [...(f.first.input as unknown[]), ...f.output, { role: "user", content: "Continue from this complete history." }];
  expect((expandPreviousResponseInput(f.body(input)) as { input: unknown[] }).input).toEqual(input);
});

test("a readable current checkpoint recovers without the deleted source and an opaque checkpoint fails", () => {
  const f = fixture();
  f.select(accountB);
  f.records[0]!.status = "removing";
  f.saveRegistry();
  const input = [{ type: "compaction", encrypted_content: encodeCompactionSummary("Completed work and the next required step.") },
    { role: "user", content: "Continue using this checkpoint." }];
  expect((expandPreviousResponseInput(f.body(input, "resp-a")) as { input: unknown[] }).input).toEqual(input);
  const nativeSummary = [{ role: "user", content: `${SUMMARY_PREFIX}\nCompleted work and the next required step.` },
    { role: "user", content: "Continue using this checkpoint." }];
  expect((expandPreviousResponseInput(f.body(nativeSummary, "resp-a")) as { input: unknown[] }).input).toEqual(nativeSummary);
  for (const checkpoint of [
    { type: "compaction", encrypted_content: "unreadable-native-checkpoint" },
    { type: "compaction", encrypted_content: encodeCompactionSummary("   ") },
    { type: "compaction", encrypted_content: `${encodeCompactionSummary("A readable summary.")}!` },
    { role: "user", content: `${SUMMARY_PREFIX}\n` },
  ]) {
    expect(() => expandPreviousResponseInput(f.body([checkpoint, ...f.output,
      { role: "user", content: "Continue without readable prior work." }], "resp-a"))).toThrow();
  }
});

test("a committed target continuation survives source removal without importing the source response id", () => {
  const f = fixture();
  f.select(accountB);
  const expanded = expandPreviousResponseInput(f.body("Continue in B.", "resp-a"));
  rememberResponseState(expanded, { id: "resp-b", status: "completed", output: f.output }, { force: true });
  flushResponseState();
  f.records[0]!.status = "removing";
  f.saveRegistry();
  rmSync(join(f.app, "responses-state.json"));
  expect((expandPreviousResponseInput(f.body("Continue again.", "resp-b")) as { input: unknown[] }).input).toHaveLength(5);
  const saved = JSON.parse(readFileSync(join(f.homes[accountB], "responses-state.json"), "utf8"));
  expect(saved.states.map(([id]: [string]) => id)).toEqual(["resp-b"]);
});

test("missing historical attachments fail before constructing the adapter and leave no target cache", async () => {
  const f = fixture();
  rememberResponseState(f.body([{ role: "user", content: [{ type: "input_file", file_id: "account-a-only-file" }] }]),
    { id: "resp-attachment", status: "completed", output: f.output }, { force: true });
  flushResponseState();
  f.select(accountB);
  let constructions = 0;
  const result = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body("Continue.", "resp-attachment")),
  }), defaultConfig("browser-only"), () => { constructions++; throw new Error("must not reach adapter"); });
  expect(result.status).toBe(409);
  expect(await result.text()).toContain("attachment");
  expect(constructions).toBe(0);
  flushResponseState();
  expect(existsSync(join(f.homes[accountB], "responses-state.json"))).toBe(false);
});

test("HTTP commits the target's new response and never serves the old final answer as its result", async () => {
  const f = fixture();
  f.select(accountB);
  let runs = 0;
  const result = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body("Continue.", "resp-a")),
  }), defaultConfig("browser-only"), () => ({
    name: "target-account",
    async runTurn(parsed, _incoming, emit) {
      runs++;
      expect(parsed.context.messages.some(message => JSON.stringify(message.content).includes("A completed answer."))).toBe(true);
      emit({ type: "text_delta", text: "B newly generated answer.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(result.status).toBe(200);
  const response = await result.json();
  expect(JSON.stringify(response.output)).toContain("B newly generated answer.");
  expect(JSON.stringify(response.output)).not.toContain("A completed answer.");
  expect(runs).toBe(1);
  flushResponseState();
  f.records[0]!.status = "removing";
  f.saveRegistry();
  rmSync(join(f.app, "responses-state.json"));
  expect((expandPreviousResponseInput(f.body("Continue again.", response.id)) as { input: unknown[] }).input).toHaveLength(5);
});

test("failed target preflight leaves neither a continuation copy nor the source response id in the target cache", async () => {
  const f = fixture();
  f.select(accountB);
  const result = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body("Continue.", "resp-a")),
  }), defaultConfig("browser-only"), () => ({
    name: "failed-target-account",
    preflight() { throw new ChatGptWebAdapterError("Target model is unavailable", { status: 409, errorType: "invalid_request_error", code: "model_unavailable", retryable: false }); },
    async runTurn() { throw new Error("preflight must reject"); },
  }));
  expect(result.status).toBe(409);
  flushResponseState();
  expect(existsSync(join(f.homes[accountB], "responses-state.json"))).toBe(false);
});

test("handoff keeps historical tool results as context and does not install source tool configuration", async () => {
  const f = fixture();
  rememberResponseState(f.body([
    ...(f.first.input as unknown[]),
    { type: "additional_tools", tools: [{ type: "function", name: "source_only_tool", headers: { authorization: "source-credential" } }] },
    { type: "tool_search_call", call_id: "search-a", arguments: {} },
    { type: "tool_search_output", call_id: "search-a", status: "completed", tools: [{ type: "function", name: "source_only_tool" }] },
    { type: "function_call", call_id: "cmd-a", name: "exec_command", arguments: '{"cmd":"already ran"}', page: "source-page", authorization: "old-token" },
    { type: "function_call_output", call_id: "cmd-a", output: "Actual source result." },
  ]), { id: "resp-tools", status: "completed", output: f.output }, { force: true });
  flushResponseState();
  f.select(accountB);
  let observed: CodexParsedRequest | undefined;
  const result = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.body("Continue.", "resp-tools")),
  }), defaultConfig("browser-only"), () => ({
    name: "target-tools",
    async runTurn(parsed, _incoming, emit) {
      observed = parsed;
      emit({ type: "text_delta", text: "New answer.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(result.status).toBe(200);
  await result.text();
  expect(observed!.context.tools?.some(tool => tool.name === "source_only_tool") ?? false).toBe(false);
  expect(JSON.stringify(observed!._rawBody)).toContain("Actual source result.");
  expect(JSON.stringify(observed!._rawBody)).not.toContain("source-credential");
  expect(JSON.stringify(observed!._rawBody)).not.toContain("source-page");
  expect(JSON.stringify(observed!._rawBody)).not.toContain("old-token");
});
