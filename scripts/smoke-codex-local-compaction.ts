import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { responseRequest } from "../src/server";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

// Real native requests and rollout files; only the model is replaced by a local deterministic stub.
const args = process.argv.slice(2);
const automatic = args.includes("--auto");
const zeroRisk = args.includes("--zero-risk");
const codex = resolve(args.find(arg => !arg.startsWith("--")) ?? Bun.which("codex") ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
if (bundled.status !== 0) throw new Error(`Cannot read native model catalog: ${bundled.stderr}`);
const root = mkdtempSync(join(tmpdir(), "codex-local-compaction-"));
const home = join(root, "codex");
mkdirSync(home);
process.env.CODEX_HOME = home;
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "bridge");
const config = defaultConfig("full");
if (zeroRisk) {
  config.browserInteractionMode = "manual";
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(root, "mock-launcher.json");
  config.zeroRiskProEnabled = true;
}
const model = zeroRisk ? "chatgpt-web/zero-risk-pro" : "chatgpt-web/high";
const summary = "LOCAL_COMPACTION_CHECKPOINT: The first request was completed. Continue the requested task.";
writeFileSync(join(root, "models.json"), JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)));
const observed: Array<{ compact: boolean; outputTypes: string[] }> = [];
const failures: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    const body = await request.clone().json() as any;
    const metadata = JSON.parse(body.client_metadata?.["x-codex-turn-metadata"] ?? "{}");
    const compact = metadata.request_kind === "compaction";
    const response = await responseRequest(request, config, () => ({
      name: "native-local-compaction-smoke",
      async runTurn(parsed, _incoming, emit) {
        try {
          assert.equal(parsed._compactionRequest === true, compact, "native compaction classification");
          // A new store per request also tests recovery after a daemon restart.
          const trusted = new ChatGptThreadEnvironmentStore(undefined, Date.now, home).resolve(parsed);
          assert.equal(trusted.cwd, root);
          assert.equal(trusted.sandboxPolicy.type, "readOnly");
          if (compact) {
            assert.equal(parsed._compactionOutput, "message");
            const source = extractChatGptCompactionSourceRevision(parsed);
            assert.ok(/FIRST_REQUEST|Continue after/.test(JSON.stringify(source.content)), "source is the human request");
            assert.equal(parsed.context.tools, undefined);
          } else {
            extractChatGptTurnUserRevision(parsed);
            if (observed.length > 1) assert.ok(JSON.stringify(parsed.context).includes(summary), "checkpoint is retained");
          }
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        emit({ type: "text_delta", text: compact ? summary : "Task completed.", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true,
          usage: { inputTokens: automatic && observed.length === 0 ? 200 : 10, outputTokens: 5, totalTokens: automatic && observed.length === 0 ? 205 : 15 },
        });
      },
    }), { rememberState: false });
    const wire = await response.text();
    const outputTypes = [...wire.matchAll(/data: (.+)/g)].flatMap(match => {
      if (match[1] === "[DONE]") return [];
      const event = JSON.parse(match[1]!);
      return event.type === "response.completed" ? event.response.output.map((item: any) => item.type) : [];
    });
    observed.push({ compact, outputTypes });
    return new Response(wire, { status: response.status, headers: response.headers });
  },
});
writeFileSync(join(home, "config.toml"), [
  `model = "${model}"`,
  'model_provider = "local_compaction_smoke"',
  `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
  ...(automatic ? ['model_auto_compact_token_limit = 100'] : []),
  '[model_providers.local_compaction_smoke]',
  'name = "Local compaction smoke"',
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  'env_key = "OPENAI_API_KEY"',
  'wire_api = "responses"',
  'supports_websockets = false',
  '[features]',
  'multi_agent = false',
].join("\n"));

const child = Bun.spawn([codex, "app-server"], {
  cwd: root, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "local-smoke-only" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const errors = new Response(child.stderr).text();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const notifications: any[] = [];
let nextId = 1;
const readLoop = (async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
        else waiter?.resolve(message.result);
      } else notifications.push(message);
    }
  }
  for (const waiter of pending.values()) waiter.reject(new Error("Native app-server exited"));
})();
function send(value: unknown): void {
  child.stdin.write(JSON.stringify(value) + "\n");
  child.stdin.flush();
}
async function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise((resolveRequest, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15_000);
      pending.set(id, { resolve: resolveRequest, reject });
      send({ id, method, params });
    });
  } finally { clearTimeout(timer!); pending.delete(id); }
}
async function completed(threadId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const index = notifications.findIndex(message => message.method === "turn/completed" && message.params.threadId === threadId);
    if (index >= 0) {
      const turn = notifications.splice(index, 1)[0].params.turn;
      assert.equal(turn.status, "completed", JSON.stringify(turn.error));
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for native turn completion");
}

try {
  await rpc("initialize", { clientInfo: { name: "local-compaction-smoke", version: "1" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  const started = await rpc("thread/start", { cwd: root, model, approvalPolicy: "never", sandbox: "read-only" });
  const threadId = started.thread.id;
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "FIRST_REQUEST: Inspect the task." }] });
  await completed(threadId);
  if (!automatic) {
    await rpc("thread/compact/start", { threadId });
    await completed(threadId);
    await rpc("thread/compact/start", { threadId });
    await completed(threadId);
  }
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "Continue after the checkpoint." }] });
  await completed(threadId);
  assert.deepEqual(failures, []);
  assert.deepEqual(observed.map(item => item.compact), automatic ? [false, true, false] : [false, true, true, false]);
  assert.deepEqual(observed[1]!.outputTypes, ["message"]);
  assert.ok(readFileSync(started.thread.path, "utf8").includes(summary));
  console.log("NATIVE_CODEX_LOCAL_COMPACTION_SMOKE_OK", { model, automatic, requests: observed.length });
} finally {
  child.kill();
  await child.exited;
  await readLoop;
  const stderr = await errors;
  if (failures.length) console.error(stderr.slice(-2000));
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
