import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { flushResponseState } from "../src/responses/state";
import { responseRequest } from "../src/server";
import { codexRoundtrippedOutput, createSessionContinuityFixtures } from "./helpers/session-continuity-fixture";

const fixtures = createSessionContinuityFixtures(import.meta.path);
const accountB = "12345678-1234-4123-8123-123456789abc";
const keys = ["CODEX_CHATGPT_WEB_HOME", "CODEX_CHATGPT_WEB_APPLICATION_HOME", "CODEX_CHATGPT_WEB_ACCOUNT_ID", "CODEX_CHATGPT_WEB_ACCOUNTS_PATH"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const roots: string[] = [];
afterEach(async () => {
  flushResponseState();
  await fixtures.disposeTestFixtures();
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("A -> B -> A rebuilds the retained page when B added task history; an unchanged A head still reuses its page", async () => {
  const app = mkdtempSync(join(tmpdir(), "account-page-history-"));
  roots.push(app);
  const registry = join(app, "accounts.json");
  writeFileSync(registry, JSON.stringify({ version: 1, accounts: [
    { id: "default", name: "A", legacy: true, status: "active" },
    { id: accountB, name: "B", legacy: false, status: "active" },
  ] }));
  function select(id: "default" | typeof accountB) {
    const home = id === "default" ? app : join(app, "accounts", id, "core");
    mkdirSync(home, { recursive: true });
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = app;
    process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID = id;
    process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH = registry;
  }
  select("default");
  const f = fixtures.httpFixture(false, false, { root: app, threadId: "account-switch-task" });
  const first = await (await f.send(f.body, false, true)).json();
  expect(first.status).toBe("completed");
  const normalRaw = f.next(parseRequest(f.body))._rawBody as { input: unknown[] };
  const normal = { ...normalRaw, model: f.body.model, reasoning: f.body.reasoning,
    input: [...f.body.input, ...codexRoundtrippedOutput(first.output), normalRaw.input.at(-1)] };
  const second = await (await f.send(normal, false, true)).json();
  expect(second.status).toBe("completed");
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]!.key).toBe(f.submissions[0]!.key);
  flushResponseState();

  function delta(turnId: string, previousId: string) {
    return { ...f.body, previous_response_id: previousId,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: turnId }) },
      input: [{ type: "message", id: `msg-${turnId}`, role: "user", content: `Instruction for ${turnId}.`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId } }] };
  }
  select(accountB);
  const responseB = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(delta("turn-b", second.id)),
  }), defaultConfig("browser-only"), () => ({ name: "B",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "New history committed by B.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));
  expect(responseB.status).toBe(200);
  const committedB = await responseB.json();
  expect(committedB.status).toBe("completed");
  flushResponseState();

  select("default");
  const returned = await f.send(delta("turn-returned-a", committedB.id), false, true);
  expect(returned.status).toBe(200);
  expect((await returned.json()).status).toBe("completed");
  expect(f.submissions).toHaveLength(3);
  expect(f.submissions[2]!.key).not.toBe(f.submissions[0]!.key);
  expect(f.submissions[2]!.reused).toBe(false);
  expect(f.pages.size).toBe(1);
});
