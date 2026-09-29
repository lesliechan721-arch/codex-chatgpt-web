import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// P0 only: real Codex, a private catalog, and short requests to a loopback model stub.
// Reported usage is synthetic. This does not measure million-token memory or browser capacity.
const args = process.argv.slice(2);
const option = (name: string) => args.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const codex = realpathSync(resolve(option("--codex") ?? Bun.which("codex")!));
const output = resolve(option("--output") ?? "output/session-continuity-p0/budget.json");
const root = mkdtempSync("/tmp/continuity-budget-");
const bootstrapHome = join(root, "bootstrap");
mkdirSync(bootstrapHome);
const isolatedEnv = { ...process.env, CODEX_HOME: bootstrapHome, OPENAI_API_KEY: "p0-loopback-only" };
const version = spawnSync(codex, ["--version"], { env: isolatedEnv, encoding: "utf8" });
const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  cwd: root, env: isolatedEnv, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
});
assert.equal(bundled.status, 0, bundled.stderr);
const template = JSON.parse(bundled.stdout).models.find((model: any) => model.slug === "gpt-5.6-sol");
assert.ok(template, "The target binary must contain the Sol model template");
const model = "chatgpt-web-continuity/gpt-5.6-sol";
const checkpoint = "P0_CHECKPOINT: Prior synthetic work is complete. Continue the short validation task.";

interface Scenario {
  name: string;
  window: number;
  limit: number;
  windowOverride?: number;
  limitOverride?: number;
}
const scenarios: Scenario[] = [
  { name: "short", window: 20_000, limit: 12_000 },
  { name: "target-default", window: 1_000_000, limit: 900_000 },
  { name: "lower-window", window: 1_000_000, limit: 900_000, windowOverride: 100_000 },
  { name: "lower-limit", window: 1_000_000, limit: 900_000, limitOverride: 25_000 },
  { name: "lower-both", window: 1_000_000, limit: 900_000, windowOverride: 100_000, limitOverride: 25_000 },
  { name: "higher-window", window: 1_000_000, limit: 900_000, windowOverride: 2_000_000 },
  { name: "higher-limit", window: 1_000_000, limit: 900_000, limitOverride: 2_000_000 },
  { name: "higher-both", window: 1_000_000, limit: 900_000, windowOverride: 2_000_000, limitOverride: 2_000_000 },
];
const report = {
  startedAt: new Date().toISOString(), codex, version: version.stdout.trim(),
  sha256: createHash("sha256").update(readFileSync(codex)).digest("hex"),
  model, root, syntheticUsage: true, cases: [] as any[],
};
mkdirSync(join(output, ".."), { recursive: true });
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);

async function run(scenario: Scenario, scope: "default" | "total" | "body_after_prefix"): Promise<void> {
  const name = `${scenario.name}-${scope}`;
  const home = join(root, name);
  mkdirSync(home);
  const catalog = { models: [{ ...template, slug: model, display_name: "Continuity P0 fixture",
    context_window: scenario.window, max_context_window: scenario.window,
    auto_compact_token_limit: scenario.limit, effective_context_window_percent: 90,
    supported_in_api: true, visibility: "list",
  }] };
  writeFileSync(join(home, "models.json"), JSON.stringify(catalog));
  const resolvedWindow = Math.min(scenario.windowOverride ?? scenario.window, scenario.window);
  const fullWindow = Math.floor(resolvedWindow * 0.9);
  const baseUsage = 5_000;
  const scopeLimit = scope === "body_after_prefix" && scenario.limitOverride !== undefined
    ? scenario.limitOverride : Math.min(scenario.limitOverride ?? scenario.limit, fullWindow);
  const expectedTrigger = Math.min(fullWindow, scopeLimit + (scope === "body_after_prefix" ? baseUsage : 0));
  const evidence: any = { name, scope, catalog: { window: scenario.window, limit: scenario.limit },
    windowOverride: scenario.windowOverride, limitOverride: scenario.limitOverride,
    expectedFullWindow: fullWindow, expectedTrigger, requests: [], tokenEvents: [], status: "running" };
  report.cases.push(evidence);
  let nextUsage = baseUsage;
  let requestNumber = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
      const text = await request.text();
      const body = JSON.parse(text);
      const metadata = JSON.parse(body.client_metadata?.["x-codex-turn-metadata"] ?? "{}");
      const compact = metadata.request_kind === "compaction";
      const usage = compact ? 500 : nextUsage;
      evidence.requests.push({ compact, reportedTotalTokens: usage, inputBytes: Buffer.byteLength(text),
        hasCheckpoint: JSON.stringify(body.input).includes(checkpoint), requestKind: metadata.request_kind });
      if (++requestNumber > 15) return new Response("P0 request bound exceeded", { status: 400 });
      const responseId = `resp_p0_${requestNumber}`;
      const message = { id: `msg_p0_${requestNumber}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: compact ? checkpoint : "P0 work complete.", annotations: [] }] };
      const response = { id: responseId, object: "response", status: "completed", output: [message],
        usage: { input_tokens: usage - 5, output_tokens: 5, total_tokens: usage,
          input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response },
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    },
  });
  writeFileSync(join(home, "config.toml"), [
    `model = "${model}"`, 'model_provider = "p0_stub"',
    `model_catalog_json = ${JSON.stringify(join(home, "models.json"))}`,
    ...(scope === "default" ? [] : [`model_auto_compact_token_limit_scope = "${scope}"`]),
    ...(scenario.windowOverride ? [`model_context_window = ${scenario.windowOverride}`] : []),
    ...(scenario.limitOverride ? [`model_auto_compact_token_limit = ${scenario.limitOverride}`] : []),
    '[model_providers.p0_stub]', 'name = "P0 loopback stub"',
    `base_url = "http://127.0.0.1:${server.port}/v1"`, 'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"', 'supports_websockets = false',
    '[features]', 'multi_agent = false', '[analytics]', 'enabled = false',
  ].join("\n"));
  const child = Bun.spawn([codex, "app-server", "--strict-config"], {
    cwd: home, env: { ...isolatedEnv, CODEX_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  let nextId = 1;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const completions: any[] = [];
  const readLoop = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (typeof message.id === "number") {
          const waiter = pending.get(message.id); pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
          else waiter?.resolve(message.result);
        } else if (message.method === "turn/completed") completions.push(message.params.turn);
        else if (message.method === "thread/tokenUsage/updated") evidence.tokenEvents.push(message.params.tokenUsage);
      }
    }
    for (const waiter of pending.values()) waiter.reject(new Error("Codex exited before the RPC completed"));
  })();
  const send = (value: unknown) => { child.stdin.write(`${JSON.stringify(value)}\n`); child.stdin.flush(); };
  async function rpc(method: string, params: unknown): Promise<any> {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise((resolveRequest, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 20_000);
        pending.set(id, { resolve: resolveRequest, reject }); send({ id, method, params });
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  }
  try {
    await rpc("initialize", { clientInfo: { name: "continuity-p0", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized" });
    const started = await rpc("thread/start", { cwd: home, model, approvalPolicy: "never", sandbox: "read-only" });
    evidence.rollout = started.thread.path;
    async function turn(usage: number): Promise<void> {
      nextUsage = usage;
      const start = completions.length;
      await rpc("turn/start", { threadId: started.thread.id,
        input: [{ type: "text", text: "Complete this short P0 validation step. Do not use tools." }] });
      const deadline = Date.now() + 20_000;
      while (completions.length === start && Date.now() < deadline) await Bun.sleep(20);
      assert.ok(completions.length > start, "Turn must complete within 20 seconds");
      assert.equal(completions.at(-1).status, "completed", JSON.stringify(completions.at(-1).error));
    }
    await turn(baseUsage);
    await turn(expectedTrigger - 2_000);
    await turn(expectedTrigger + 1_000);
    assert.equal(evidence.requests.filter((entry: any) => entry.compact).length, 0, "No compaction below the measured threshold");
    await turn(baseUsage);
    assert.equal(evidence.requests.filter((entry: any) => entry.compact).length, 1, "One automatic compaction after high usage");
    await turn(baseUsage);
    assert.equal(evidence.requests.filter((entry: any) => entry.compact).length, 1, "Low post-compaction usage must not compact again");
    assert.ok(evidence.requests.at(-1).hasCheckpoint, "Replacement history must contain the accepted checkpoint");
    assert.ok(evidence.tokenEvents.some((event: any) => event.modelContextWindow === fullWindow), "Native effective window must match the bounded catalog window");
    const recount = evidence.tokenEvents.find((event: any, index: number, events: any[]) => index > 0
      && events[index - 1].last.totalTokens === 500
      && event.last.totalTokens !== 500 && event.last.totalTokens < expectedTrigger
      && event.total.totalTokens === events[index - 1].total.totalTokens);
    assert.ok(recount, "Codex must recount the replaced history independently of the next stub response");
    evidence.historyRecountTokens = recount.last.totalTokens;
    evidence.triggerBracket = { noCompactionAfterReportedUsage: expectedTrigger - 2_000,
      compactionAfterReportedUsage: expectedTrigger + 1_000 };
    evidence.lastNativeUsage = evidence.tokenEvents.at(-1);
    evidence.status = "passed";
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    child.kill(); await child.exited; await readLoop;
    const errors = await stderr;
    writeFileSync(join(home, "stderr.log"), errors);
    evidence.stderrPath = join(home, "stderr.log");
    if (evidence.requests.length === 0) evidence.startupError = errors.slice(-2_000);
    await server.stop(true); save();
  }
  console.log(`${evidence.status.toUpperCase()} ${name}${evidence.error ? `: ${evidence.error}` : ""}`);
}

for (const scenario of scenarios) {
  for (const scope of scenario.name === "target-default"
    ? ["default", "total", "body_after_prefix"] as const
    : ["total", "body_after_prefix"] as const) {
    if (option("--case") && !`${scenario.name}-${scope}`.includes(option("--case")!)) continue;
    await run(scenario, scope);
  }
}
save();
console.log(`Evidence: ${output}`);
if (report.cases.some(entry => entry.status !== "passed")) process.exitCode = 1;
