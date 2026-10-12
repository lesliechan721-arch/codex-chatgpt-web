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
const root = mkdtempSync(join(tmpdir(), "codex-local-compaction-"));
const home = join(root, "codex");
const previousEnvironment = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME,
};
let server: ReturnType<typeof Bun.serve> | undefined;
let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
let readLoop: Promise<void> | undefined;
let errors: Promise<string> | undefined;
const failures: string[] = [];
try {
  mkdirSync(home);
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME);
  process.env.CODEX_HOME = home;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "bridge");
  const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 15_000,
  });
  if (bundled.status !== 0) throw new Error(`Cannot read native model catalog: ${bundled.stderr}`);
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
  const observed: Array<{ compact: boolean; completed: any[]; status: number }> = [];
  server = Bun.serve({
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
            assert.equal(trusted.sandboxPolicy.networkAccess, false, "native read-only network authority");
            if (compact) {
              // compact.rs consumes assistant text for standalone and inline responses/memento.
              assert.equal(parsed._compactionOutput ?? parsed._compactionResponseFormat, "message");
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
      const completedResponses = [...wire.matchAll(/data: (.+)/g)].flatMap(match => {
        if (match[1] === "[DONE]") return [];
        const event = JSON.parse(match[1]!);
        return event.type === "response.completed" ? [event.response] : [];
      });
      observed.push({ compact, completed: completedResponses, status: response.status });
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

  const native = Bun.spawn([codex, "app-server"], {
    cwd: root, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "local-smoke-only" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child = native;
  errors = new Response(native.stderr).text();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const notifications: any[] = [];
  let nextId = 1;
  readLoop = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of native.stdout) {
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
    native.stdin.write(JSON.stringify(value) + "\n");
    native.stdin.flush();
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
  const compactRequests = observed.filter(item => item.compact);
  for (const compact of compactRequests) {
    assert.equal(compact.status, 200, "compaction HTTP status");
    assert.equal(compact.completed.length, 1, "one response.completed per compaction");
    const response = compact.completed[0];
    assert.equal(response.status, "completed", "compaction response status");
    assert.deepEqual(response.output.map((item: any) => item.type), ["message"]);
    const message = response.output[0];
    assert.equal(message.role, "assistant");
    assert.equal(message.content.filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text).join(""), summary, "wire compaction summary");
  }
  const checkpoints = readFileSync(started.thread.path, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(item => item.type === "compacted");
  assert.equal(checkpoints.length, compactRequests.length, "every compaction installs a native checkpoint");
  for (const checkpoint of checkpoints) {
    assert.ok(checkpoint.payload.message.includes(summary), "native checkpoint summary");
    const replacement = checkpoint.payload.replacement_history;
    assert.ok(Array.isArray(replacement), "native replacement history");
    const userTexts = replacement.filter((item: any) => item.type === "message" && item.role === "user")
      .flatMap((item: any) => item.content.filter((part: any) => part.type === "input_text").map((part: any) => part.text));
    assert.ok(userTexts.some((text: string) => text.includes(summary)), "replacement history retains the summary");
    assert.ok(userTexts.includes("FIRST_REQUEST: Inspect the task."), "replacement history retains the human instruction");
  }
  console.log("NATIVE_CODEX_LOCAL_COMPACTION_SMOKE_OK", {
    model, automatic, requests: observed.length, checkpoints: checkpoints.length,
  });
} finally {
  try {
    if (child) {
      child.kill();
      await child.exited;
    }
    await readLoop;
    const stderr = await errors;
    if (failures.length && stderr) console.error(stderr.slice(-2000));
  } finally {
    try {
      await server?.stop(true);
    } finally {
      try {
        rmSync(root, { recursive: true, force: true });
      } finally {
        for (const [key, value] of Object.entries(previousEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }
}
