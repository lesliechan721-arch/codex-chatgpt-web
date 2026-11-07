import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRoundtrippedOutput, createSessionContinuityFixtures, deliveredStartupSources } from "./helpers/session-continuity-fixture";

const fixtures = createSessionContinuityFixtures(import.meta.path);
const accountB = "12345678-1234-4123-8123-123456789abc";
const keys = ["CODEX_CHATGPT_WEB_HOME", "CODEX_CHATGPT_WEB_APPLICATION_HOME", "CODEX_CHATGPT_WEB_ACCOUNT_ID", "CODEX_CHATGPT_WEB_ACCOUNTS_PATH"] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const roots: string[] = [];
afterEach(async () => {
  await fixtures.disposeTestFixtures();
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function accounts() {
  const app = mkdtempSync(join(tmpdir(), "account-page-history-"));
  roots.push(app);
  const registry = join(app, "accounts.json");
  writeFileSync(registry, JSON.stringify({ version: 1, accounts: [
    { id: "default", name: "A", legacy: true, status: "active" },
    { id: accountB, name: "B", legacy: false, status: "active" },
  ] }));
  return (id: "default" | typeof accountB) => {
    const home = id === "default" ? app : join(app, "accounts", id, "core");
    mkdirSync(home, { recursive: true });
    process.env.CODEX_CHATGPT_WEB_HOME = home;
    process.env.CODEX_CHATGPT_WEB_APPLICATION_HOME = app;
    process.env.CODEX_CHATGPT_WEB_ACCOUNT_ID = id;
    process.env.CODEX_CHATGPT_WEB_ACCOUNTS_PATH = registry;
    return home;
  };
}

for (const account of ["default", accountB] as const) {
  for (const cache of ["absent", "expired", "corrupt", "different"] as const) {
    test(`tool results with Codex metadata keep the live page (account=${account}, old cache=${cache})`, async () => {
      const home = accounts()(account);
      const path = join(home, "responses-state.json");
      const contents = cache === "absent" ? undefined : cache === "corrupt" ? "not JSON" : JSON.stringify({ version: 1, states: [["old-response", {
        createdAt: Date.now() - (cache === "expired" ? 61 * 60_000 : 0), completed: true, threadId: "metadata-task",
        items: [{ role: "user", content: "Different old task history." }],
      }]] });
      if (contents !== undefined) writeFileSync(path, contents);
      const f = fixtures.httpFixture(false, false, { root: home, threadId: "metadata-task" });
      f.controls.invokeSourceTools = true;
      f.controls.singleSourceTool = true;
      const first = await (await f.send(f.body)).json();
      expect(first.error).toBeUndefined();
      const output = codexRoundtrippedOutput(first.output).map<Record<string, unknown>>(item => ({ ...item,
        internal_chat_message_metadata_passthrough: { turn_id: "turn-first" },
      }));
      const call = output.find(item => item.type === "function_call")!;
      expect(call).toBeDefined();
      const page = [...f.pages.values()][0];
      const continuation = await f.send({ ...f.body, input: [...f.body.input, ...output,
        { type: "function_call_output", call_id: call.call_id, output: "Actual fixture tool result: 42." },
      ] });
      expect(continuation.status).toBe(200);
      expect((await continuation.json()).status).toBe("completed");
      expect(f.controls.toolResults).toHaveLength(1);
      expect(JSON.stringify(f.controls.toolResults)).toContain("Actual fixture tool result: 42.");
      expect(f.submissions).toHaveLength(1);
      expect(f.pages.size).toBe(1);
      expect([...f.pages.values()][0]).toBe(page);
      await fixtures.disposeTestFixtures();
      if (contents === undefined) expect(existsSync(path)).toBe(false);
      else expect(readFileSync(path, "utf8")).toBe(contents);
    });
  }
}

for (const sequence of [["default", "default"], ["default", accountB], ["default", accountB, "default"]] as const) {
  test(`restart lifecycle ${sequence.join(" -> ")} destroys old pages and delivers current context`, async () => {
    const select = accounts();
    let history: unknown[] = [];
    for (const [index, account] of sequence.entries()) {
      const home = select(account);
      const f = fixtures.httpFixture(false, false, { root: home, threadId: "restart-task" });
      const turnId = `turn-restart-${index}`;
      const instruction = `Current instruction from ${account}, step ${index}.`;
      const body = { ...f.body, input: [...history, { type: "message", role: "user", id: `msg-${turnId}`, content: instruction,
        internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
        client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: f.threadId, turn_id: turnId }) } };
      const response = await f.send(body);
      expect(await response.clone().json()).not.toHaveProperty("error");
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.status).toBe("completed");
      expect(f.submissions).toHaveLength(1);
      expect(f.submissions[0]!.reused).toBe(false);
      const delivered = deliveredStartupSources(f.submissions[0]!.prompt);
      expect(delivered).toContain(instruction);
      if (index > 0) expect(delivered).toContain("step 0");
      history = [...body.input, ...codexRoundtrippedOutput(result.output)];
      // Account switching stops the old runtime and destroys its browser documents.
      await fixtures.disposeTestFixtures();
      f.pages.clear();
      for (const tab of [...f.recoveryHost.turnTabs.values()]) f.recoveryHost.removeTurnTab(tab);
      expect(f.pages.size).toBe(0);
      expect(existsSync(join(home, "responses-state.json"))).toBe(false);
    }
  });
}
