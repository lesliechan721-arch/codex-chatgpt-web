import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { responseRequest } from "../src/server";
import { readJsonRequestBody } from "../src/http-body";
import { extractChatGptDelegatedTurnCapability } from "../src/adapters/chatgpt-web/environment";

// Real app-server requests and native command execution; the page/model is deterministic.
// Capture raw request bodies before responseRequest can generate or canonicalize item IDs.
const args = process.argv.slice(2);
const option = (name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const replayPath = option("--replay");
if (replayPath) {
  const fixture = JSON.parse(readFileSync(resolve(replayPath), "utf8")) as Body;
  assert.equal(fixture.schema, "codex-chatgpt-web/continuity-protocol-evidence/v1");
  const replayConfig = defaultConfig("full");
  replayConfig.toolAuthorityMode = "delegated";
  replayConfig.browserHost = "launcher";
  replayConfig.browserHostDescriptorPath = "/tmp/cgw-protocol-fixture/fake-launcher.json";
  if (fixture.provenance.interactionMode.startsWith("zero-risk")) {
    replayConfig.browserInteractionMode = "manual";
    replayConfig.zeroRiskProEnabled = true;
  }
  for (const entry of fixture.captured) {
    let normalizedInput: unknown;
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(entry.body),
    }), replayConfig, () => ({
      name: "protocol-fixture-parser-replay",
      async runTurn(parsed, _request, emit) {
        extractChatGptDelegatedTurnCapability(parsed);
        normalizedInput = (parsed._rawBody as Body).input;
        emit({ type: "text_delta", text: "REPLAY_MARKER", phase: "final_answer" });
        emit({ type: "done", endTurn: true, stopReason: "stop" });
      },
    }), { rememberState: false });
    const wire = await response.text();
    assert.equal(response.status, 200, wire.slice(-1_000));
    if (entry.parsed?.input) assert.deepEqual(normalizedInput, entry.parsed.input, `${entry.label} normalized input`);
    else assert.deepEqual(normalizedInput, entry.body.input, `${entry.label} replayed input`);
  }
  console.log("CODEX_CONTINUITY_PROTOCOL_REPLAY_OK", fixture.captured.length);
  process.exit(0);
}
const zeroRisk = args.includes("--zero-risk");
const chatgptAuth = option("--auth") !== "api-key";
const activeCompact = args.includes("--active-compact");
const checkpointOnly = args.includes("--checkpoint-only");
const codex = realpathSync(resolve(option("--codex") ?? Bun.which("codex")!));
const output = resolve(option("--output") ?? "tests/fixtures/session-continuity/current-work-protocol.json");
const root = realpathSync(mkdtempSync(join(tmpdir(), "cgw-continuity-protocol-")));
const home = join(root, "codex-home");
const workspace = join(root, "workspace");
mkdirSync(home);
mkdirSync(workspace);
writeFileSync(join(workspace, "AGENTS.md"), "# Protocol fixture\n\nAGENTS_MARKER: Keep the command output exact.\n");
const config = defaultConfig("full");
config.toolAuthorityMode = "delegated";
config.browserHost = "launcher";
config.browserHostDescriptorPath = join(root, "fake-launcher.json");
if (zeroRisk) {
  config.browserInteractionMode = "manual";
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(root, "fake-launcher.json");
  config.zeroRiskProEnabled = true;
}
const model = zeroRisk ? "chatgpt-web-continuity/zero-risk-pro" : "chatgpt-web-continuity/gpt-5.6-sol";
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000 });
assert.equal(bundled.status, 0, "bundled native model catalog");
writeFileSync(join(root, "models.json"), JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)));
const version = spawnSync(codex, ["--version"], { encoding: "utf8", timeout: 15_000 }).stdout.trim();
const baselineHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Body = Record<string, any>;
type Capture = { label: string; body: Body; headers: Record<string, string>; status: number; replay: boolean; response?: Body; parsed?: Body };
const captured: Capture[] = [];
const limitations: string[] = [];
const cache = new Map<string, { wire: string; status: number; headers: Headers }>();
const page = { id: "fake-page-1", creates: 1, submissions: 0, toolCalls: 0, summaries: 0 };
let label = "ordinary";
let dropped = false;
let releaseSteer: (() => void) | undefined;
let steerSeen: (() => void) | undefined;
const steerArrival = new Promise<void>(done => { steerSeen = done; });
let holdSteer = false;
const summary = "CHECKPOINT_MARKER: The harmless command completed. Keep the current task.";
function completedResponse(wire: string): Body | undefined {
  for (const line of wire.split("\n")) {
    if (!line.startsWith("data: ") || line.slice(6).trim() === "[DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  try { return JSON.parse(wire); } catch { return undefined; }
}
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response("HTTP fixture only", { status: 426 });
    if (new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    const body = await readJsonRequestBody(request.clone()) as Body;
    const key = sha256(JSON.stringify(body));
    const hit = cache.get(key);
    const entry: Capture = { label, body, headers: { "content-encoding": request.headers.get("content-encoding") ?? "identity" }, status: 200, replay: Boolean(hit) };
    captured.push(entry);
    if (hit) {
      entry.response = completedResponse(hit.wire);
      return new Response(hit.wire, { status: hit.status, headers: hit.headers });
    }
    const metadata = JSON.parse(body.client_metadata?.["x-codex-turn-metadata"] ?? request.headers.get("x-codex-turn-metadata") ?? "{}");
    const compact = metadata.request_kind === "compaction";
    if (compact && label === "ordinary") entry.label = "active-compact";
    const input = Array.isArray(body.input) ? body.input : [];
    const hasResult = input.some((item: Body) => item.type === "function_call_output" && item.call_id === "call_protocol_1");
    const callRequested = !compact && label === "ordinary" && !hasResult && page.toolCalls === 0;
    const response = await responseRequest(request, config, () => ({
      name: "continuity-protocol-fake-page",
      async runTurn(parsed, _incoming, emit) {
        // This explicitly exercises request-carried delegated identity/registry, not rollout authority.
        extractChatGptDelegatedTurnCapability(parsed);
        entry.parsed = { input: (parsed._rawBody as Body).input, modelId: parsed.modelId,
          conversationPolicy: parsed._conversationPolicy, compactionRequest: parsed._compactionRequest === true,
          compactionOutput: parsed._compactionOutput };
        page.submissions += 1;
        if (holdSteer) {
          holdSteer = false;
          steerSeen?.();
          await new Promise<void>(done => { releaseSteer = done; });
        }
        if (compact) {
          page.summaries += 1;
          emit({ type: "text_delta", text: summary, phase: "final_answer" });
        } else if (callRequested) {
          page.toolCalls += 1;
          emit({ type: "tool_call_start", id: "call_protocol_1", name: "exec_command" });
          emit({ type: "tool_call_delta", arguments: JSON.stringify({ cmd: "printf 'CGW_TOOL_RESULT\\n'", login: false, max_output_tokens: 128 }) });
          emit({ type: "tool_call_end" });
        } else emit({ type: "text_delta", text: `FINAL_MARKER ${label}`, phase: "final_answer" });
        emit({ type: "done", endTurn: !callRequested, stopReason: "stop",
          usage: { inputTokens: activeCompact && callRequested ? 200 : 10, outputTokens: 5, totalTokens: activeCompact && callRequested ? 205 : 15 } });
      },
    }), { rememberState: false });
    const wire = await response.text();
    entry.status = response.status;
    entry.response = completedResponse(wire);
    if (response.status !== 200) return new Response(wire, { status: response.status, headers: response.headers });
    cache.set(key, { wire, status: response.status, headers: response.headers });
    if (label === "ordinary" && !hasResult && !dropped) {
      // The fake page already committed a tool call; the client loses that receipt and retries.
      dropped = true;
      entry.status = 503;
      return new Response("Isolated receipt loss", { status: 503 });
    }
    return new Response(wire, { status: response.status, headers: response.headers });
  },
});
if (chatgptAuth) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // These local fixture tokens are accepted only by this loopback stub, never sent to OpenAI.
  const accountId = "00000000-0000-4000-8000-000000000001";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "continuity-probe@example.invalid",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: "local-fixture", chatgpt_account_id: accountId } })}.c2ln`,
      access_token: "local-fixture-not-a-credential", refresh_token: "local-fixture-no-refresh", account_id: accountId },
    last_refresh: new Date().toISOString() }), { mode: 0o600 });
}
writeFileSync(join(home, "config.toml"), [
  `model = ${JSON.stringify(model)}`,
  `model_provider = "${chatgptAuth ? "openai" : "continuity_protocol_probe"}"`,
  `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
  'approval_policy = "never"',
  ...(activeCompact ? ['model_auto_compact_token_limit = 100'] : []),
  ...(chatgptAuth ? [`openai_base_url = "http://127.0.0.1:${server.port}/v1"`] : ['[model_providers.continuity_protocol_probe]',
  'name = "Isolated continuity protocol probe"',
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  'env_key = "CGW_PROTOCOL_PROBE_KEY"',
  'wire_api = "responses"',
  'supports_websockets = false']),
  '[features]',
  'multi_agent = false',
].join("\n"));
const environment: Record<string, string | undefined> = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, CGW_PROTOCOL_PROBE_KEY: "isolated-probe-only" };
delete environment.OPENAI_API_KEY;
const child = Bun.spawn([codex, "app-server"], {
  cwd: workspace, env: environment,
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const errors = new Response(child.stderr).text();
const pending = new Map<number, (message: Body) => void>();
const notifications: Body[] = [];
let nextId = 1;
const readLoop = (async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
      else notifications.push(message);
    }
  }
})();
function send(value: unknown): void { child.stdin.write(JSON.stringify(value) + "\n"); child.stdin.flush(); }
async function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((done, fail) => {
      timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 20_000);
      pending.set(id, message => message.error ? fail(new Error(JSON.stringify(message.error))) : done(message.result));
      send({ id, method, params });
    });
  } finally { clearTimeout(timer); pending.delete(id); }
}
async function completed(threadId: string): Promise<Body> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const index = notifications.findIndex(message => message.method === "turn/completed" && message.params.threadId === threadId);
    if (index >= 0) {
      const turn = notifications.splice(index, 1)[0]!.params.turn;
      assert.equal(turn.status, "completed", JSON.stringify(turn.error));
      return turn;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Turn timeout: ${label}`);
}

// Substitute identifiers consistently across bodies, metadata JSON and generated response items.
const identities = new Map<string, string>();
const counts = new Map<string, number>();
function identity(value: string, category: string): string {
  if (!identities.has(value)) {
    const count = (counts.get(category) ?? 0) + 1; counts.set(category, count);
    identities.set(value, `${category}_${count}`);
  }
  return identities.get(value)!;
}
function collect(value: unknown, key = ""): void {
  if (typeof value === "string") {
    if (key === "x-codex-turn-metadata") collect(JSON.parse(value));
    else if (["thread_id", "session_id", "threadId"].includes(key)) identity(value, "thread");
    else if (["turn_id", "turnId", "root_turn_id"].includes(key)) identity(value, "turn");
    else if (["installation_id", "context_window_id", "window_id"].includes(key)) identity(value, key);
    else if (["id", "call_id", "previous_response_id", "prompt_cache_key"].includes(key)) identity(value, key === "call_id" ? "call" : "item");
  } else if (Array.isArray(value)) value.forEach(item => collect(item));
  else if (value && typeof value === "object") Object.entries(value).forEach(([name, item]) => collect(item, name));
}
function sanitize(value: unknown): any {
  if (typeof value === "string") {
    let result = value.replaceAll(root, "/tmp/cgw-protocol-fixture").replaceAll(homedir(), "/tmp/cgw-protocol-fixture/user-home");
    for (const [original, alias] of identities) result = result.replaceAll(original, alias);
    return result;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitize(key), sanitize(item)]));
  return value;
}
try {
  await rpc("initialize", { clientInfo: { name: "continuity-protocol-probe", version: "1" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized" });
  const started = await rpc("thread/start", {
    cwd: workspace, model, approvalPolicy: "never", sandbox: "read-only",
    baseInstructions: "SYSTEM_MARKER: You are an isolated protocol test assistant.",
    developerInstructions: "DEVELOPER_MARKER: Preserve task instructions and tool results.",
  });
  const threadId = started.thread.id;
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "ORDINARY_MARKER: Run the harmless printf command once." }] });
  await completed(threadId);
  const nativeResult = captured.flatMap(entry => entry.body.input ?? []).find((item: Body) => item.type === "function_call_output");
  assert.ok(nativeResult?.output.includes("CGW_TOOL_RESULT"), "the real Codex native command returns its result");
  assert.equal(page.toolCalls, 1, "receipt retry cannot produce a second fake-page call");
  assert.ok(captured.some(entry => entry.replay), "Codex actually retried the lost receipt");
  label = "new-turn";
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "NEW_TURN_MARKER: Keep the next task separate." }] });
  await completed(threadId);
  label = "compact";
  await rpc("thread/compact/start", { threadId });
  await completed(threadId);
  if (checkpointOnly) {
    label = "checkpoint-only";
    try {
      await rpc("turn/start", { threadId, input: [] });
      await completed(threadId);
    } catch (error) {
      limitations.push(`Empty turn/start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  label = "continue";
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "CONTINUE_MARKER: Continue after the checkpoint." }] });
  await completed(threadId);
  label = "steering"; holdSteer = true;
  const active = await rpc("turn/start", { threadId, input: [{ type: "text", text: "STEER_FIRST_MARKER: Wait for a further instruction." }] });
  let steerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([steerArrival, new Promise((_, fail) => {
      steerTimer = setTimeout(() => fail(new Error("No steering request arrived")), 20_000);
    })]);
  } finally { clearTimeout(steerTimer); }
  const steering = await rpc("turn/steer", { threadId, expectedTurnId: active.turn.id,
    input: [{ type: "text", text: "STEER_SECOND_MARKER: Add this instruction in the same turn." }] });
  releaseSteer?.();
  await completed(threadId);
  const rollout = readFileSync(started.thread.path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const nativeItems = rollout.filter(entry => entry.type === "response_item"
    && ["function_call", "function_call_output"].includes(entry.payload?.type)).map(entry => entry.payload);
  assert.equal(nativeItems.filter(item => item.type === "function_call").length, 1, "one native tool invocation");
  assert.equal(nativeItems.filter(item => item.type === "function_call_output").length, 1, "one native tool result");
  const payload = { captured, nativeItems, steering };
  collect(payload);
  const fixture = sanitize({
    schema: "codex-chatgpt-web/continuity-protocol-evidence/v1",
    provenance: { client: "real-codex-app-server", page: "deterministic-fake-page", nativeTool: "real-exec-command-printf",
      baselineHead, codexPath: codex.replace(homedir(), "~"), capturedAt: new Date().toISOString(),
      codexVersion: version, codexSha256: sha256(readFileSync(codex)), authPath: chatgptAuth ? "built-in-openai-synthetic-chatgpt-auth" : "custom-provider-synthetic-api-key", authority: "delegated-request-carried",
      interactionMode: zeroRisk ? "zero-risk-model-protocol-only" : "automatic-model-protocol-only", codec: chatgptAuth ? "v2-compaction-item-ocx1" : "local-message",
      transport: "SSE", previousResponse: "not-observed", checkpointOnly: captured.some(entry => entry.label === "checkpoint-only") ? "real-empty-turn-start-request" : "not-observed",
      receiptLoss: "503-after-fake-page-commit", sanitized: "stable ID aliases and temporary path substitution" },
    page, limitations, ...payload,
  });
  mkdirSync(join(output, ".."), { recursive: true });
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log("CODEX_CONTINUITY_PROTOCOL_OK", JSON.stringify({ model, requests: captured.length, page, output }));
  for (const entry of fixture.captured) {
    console.log(JSON.stringify({ label: entry.label, status: entry.status, replay: entry.replay,
      metadata: JSON.parse(entry.body.client_metadata?.["x-codex-turn-metadata"] ?? "{}"),
      input: (entry.body.input ?? []).map((item: Body) => ({ type: item.type, role: item.role, id: item.id,
        metadata: item.internal_chat_message_metadata_passthrough, parts: item.content?.map((part: Body) => ({ type: part.type, marker: part.text?.slice(0,100) })), call_id: item.call_id })) }));
  }
} finally {
  releaseSteer?.(); child.kill(); await child.exited; await readLoop;
  const stderr = await errors;
  if (child.exitCode !== 0 && stderr.trim()) console.error(stderr.slice(-1_000));
  await server.stop(true); rmSync(root, { recursive: true, force: true });
}
