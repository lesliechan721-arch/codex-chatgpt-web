import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, getContextCapabilityEvidencePath, providerConfig, ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../src/config";
import { assertContextCapabilityVerified, contextCapabilitySchemaDigest, invalidateContextCapabilityEvidence,
  contextCapabilityReceiptsComplete,
  installedContextCapabilitySchemaDigest, readContextCapabilityEvidence, readProviderContextCapabilityEvidence, runContextCapabilityVerification, saveContextCapabilityEvidence,
  type ContextCapabilityReceipts } from "../src/adapters/chatgpt-web/context-capability-verification";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createChatGptWebAdapter, type ChatGptZeroRiskManualControl } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import { CHATGPT_WEB_BACKEND_MODEL, CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { ContextNavigator } from "../src/adapters/chatgpt-web/context-navigator";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { CONTEXT_TEXT_READ_FORMAT, contextTextReadReceipt, parseContextTextReadResult } from "../src/adapters/chatgpt-web/context-text-result";

import type { AdapterEvent } from "../src/types";

const roots: string[] = [];
afterEach(() => { chatGptTurnSessions.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "context-capability-")); roots.push(home);
  const config = defaultConfig("full");
  config.brokerSocketPath = defaultBrokerEndpoint(home);
  config.runtimeCommand = [process.execPath, resolve("src/cli.ts")];
  config.tunnel = config.automaticTunnel = { binaryPath: "/fixed/tunnel-client", tunnelId: `tunnel_${"a".repeat(32)}`, runtimeKeyFile: "/private/runtime-key",
    profileDir: join(home, "tunnel"), profileName: "automatic", alias: "automatic" };
  return { home, config };
}
const successMethods = { ordinary: { list: true, search: true, read: true }, compaction: { list: true, search: true, read: true } };
const receipts = (): ContextCapabilityReceipts => {
  const snapshot = createContextSnapshot(parseRequest({ model: "gpt-6", input: "test receipt source" }));
  const read = (purpose: "normal" | "compaction") => contextTextReadReceipt(new ContextNavigator({ scopeId: "receipt-fixture", snapshot, purpose })
    .read({ context_id: snapshot.context_id, read_ref: snapshot.targets[0]!.read_ref! }));
  return { ordinary: { ...successMethods.ordinary, text_read: read("normal") }, compaction: { ...successMethods.compaction, text_read: read("compaction") } };
};
function tools(mode: "automatic" | "manual" = "automatic") {
  const key = mode === "manual" ? "request_id" : "turn_token";
  return ["list", "search", "read"].map(method => ({ name: `codex_context_${method}`, description: `Read-only ${method} ${method === "read" ? CONTEXT_TEXT_READ_FORMAT : "directory"}`, annotations: { readOnlyHint: true }, inputSchema: {
    type: "object", additionalProperties: false, properties: { [key]: { type: "string" }, compaction_token: { type: "string" }, context_id: { type: "string" } },
    required: ["context_id"], oneOf: [{ required: [key], not: { required: ["compaction_token"] } }, { required: ["compaction_token"], not: { required: [key] } }],
  } }));
}
function verificationStopped(signal: AbortSignal): Promise<string> {
  return new Promise(resolveStopped => {
    if (signal.aborted) resolveStopped("Stopped");
    else signal.addEventListener("abort", () => resolveStopped("Stopped"), { once: true });
  });
}
describe("context capability evidence", () => {
  test("installed runtime has both current public read contracts, without proving remote callability", async () => {
    const f = fixture(); const automatic = await installedContextCapabilitySchemaDigest(f.config);
    expect(automatic).toMatch(/^[a-f0-9]{64}$/);
    f.config.browserInteractionMode = "manual";
    expect(await installedContextCapabilitySchemaDigest(f.config)).not.toBe(automatic);
    f.config.manualTunnel = { ...f.config.tunnel!, profileName: "manual", alias: "manual" };
    await expect(assertContextCapabilityVerified(f.config, { home: f.home, schemaDigest: automatic })).rejects.toThrow("six read-only MCP calls");
  });
  test("schema requires every tool and XOR credentials, rejects business operation fields", () => {
    expect(contextCapabilitySchemaDigest(tools(), "automatic")).toBe(contextCapabilitySchemaDigest(tools().reverse(), "automatic"));
    expect(() => contextCapabilitySchemaDigest(tools().slice(1), "automatic")).toThrow("lacks");
    const both = tools(); both[0]!.inputSchema.oneOf = [];
    expect(() => contextCapabilitySchemaDigest(both, "automatic")).toThrow("exclusive");
    const operation = tools(); (operation[0]!.inputSchema.properties as Record<string, unknown>).operation_id = { type: "integer" };
    expect(() => contextCapabilitySchemaDigest(operation, "automatic")).toThrow("incompatible");
    expect(() => contextCapabilitySchemaDigest(tools(), "manual")).toThrow("incompatible");
  });
  test("fingerprint binds descriptions, actual read format and optional output schema", () => {
    const current = contextCapabilitySchemaDigest(tools(), "automatic");
    const old = tools(); old[2]!.description = "Old read format, duplicated structured body";
    expect(() => contextCapabilitySchemaDigest(old, "automatic")).toThrow("output contract");
    const description = tools(); description[0]!.description += " Updated discovery instructions";
    expect(contextCapabilitySchemaDigest(description, "automatic")).not.toBe(current);
    const output = tools().map(tool => ({ ...tool, outputSchema: { type: "object", properties: { format: { const: CONTEXT_TEXT_READ_FORMAT } } } }));
    expect(contextCapabilitySchemaDigest(output, "automatic")).not.toBe(current);
  });
  test("v1 stores and Boolean-only read receipts cannot authorize the new contract", () => {
    const f = fixture(), schema = contextCapabilitySchemaDigest(tools(), "automatic");
    const saved = saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    expect(contextCapabilityReceiptsComplete(successMethods)).toBe(false);
    expect(() => saveContextCapabilityEvidence(f.config, schema, successMethods, f.home)).toThrow("six");
    const malformed = receipts(); malformed.compaction.text_read!.body_content_index = 0 as 1;
    expect(contextCapabilityReceiptsComplete(malformed)).toBe(false);
    for (const store of [
      { version: 1, modes: { automatic: { ...saved, version: 1, receipts: successMethods } } },
      { version: 2, modes: { automatic: { ...saved, receipts: successMethods } } },
      { version: 2, modes: { automatic: { ...saved, binding: { ...saved.binding, textReadFormat: "context-text-read-v1" } } } },
    ]) {
      writeFileSync(getContextCapabilityEvidencePath(f.home), JSON.stringify(store));
      expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
    }
  });
  test("all six receipts are required and persisted evidence contains no credentials or source", async () => {
    const f = fixture(); const schema = contextCapabilitySchemaDigest(tools(), "automatic");
    const incomplete = receipts(); incomplete.compaction.read = false;
    expect(() => saveContextCapabilityEvidence(f.config, schema, incomplete, f.home)).toThrow("six");
    const saved = saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    expect(await assertContextCapabilityVerified(f.config, { home: f.home, schemaDigest: schema })).toEqual(saved);
    const json = readFileSync(getContextCapabilityEvidencePath(f.home), "utf8");
    expect(json).not.toContain("turn_token"); expect(json).not.toContain("compaction_token"); expect(json).not.toContain("runtime-key");
    if (process.platform !== "win32") expect(statSync(getContextCapabilityEvidencePath(f.home)).mode & 0o777).toBe(0o600);
  });
  test("profile, interaction, plugin, tunnel, runtime and schema changes invalidate evidence", () => {
    const f = fixture(); const schema = contextCapabilitySchemaDigest(tools(), "automatic"); saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    for (const config of [
      { ...f.config, purpose: "dev-harness" as const }, { ...f.config, automaticAppName: "Codex Custom Unverified" },
      { ...f.config, automaticTunnel: { ...f.config.automaticTunnel!, tunnelId: "other-tunnel" } },
      { ...f.config, runtimeCommand: ["/other/runtime"] }, { ...f.config, brokerSocketPath: "/other/broker.sock" },
    ]) expect(readContextCapabilityEvidence(config, schema, f.home)).toBeUndefined();
    expect(readContextCapabilityEvidence(f.config, "f".repeat(64), f.home)).toBeUndefined();
    expect(readContextCapabilityEvidence(f.config, schema, `${f.home}-other`)).toBeUndefined();
    expect(() => readContextCapabilityEvidence({ ...f.config, automaticAppName: "Codex Native4" }, schema, f.home)).toThrow("newly created");
  });
  test("replacing a runtime file at the same command path invalidates former evidence", () => {
    const f = fixture(); const runtimeFile = join(f.home, "runtime-entry.js"); writeFileSync(runtimeFile, "runtime version one");
    f.config.runtimeCommand = [process.execPath, runtimeFile];
    const schema = contextCapabilitySchemaDigest(tools(), "automatic"); saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeDefined();
    writeFileSync(runtimeFile, "runtime version two with a changed artifact");
    expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
  });
  test("manual and automatic evidence coexist, and retry invalidation removes only the selected mode", () => {
    const f = fixture(); const schema = contextCapabilitySchemaDigest(tools(), "automatic"); saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    const manual = { ...f.config, browserInteractionMode: "manual" as const, appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
      manualTunnel: { ...f.config.tunnel!, profileName: "manual", alias: "manual" } };
    const manualSchema = contextCapabilitySchemaDigest(tools("manual"), "manual"); saveContextCapabilityEvidence(manual, manualSchema, receipts(), f.home);
    expect(readContextCapabilityEvidence(manual, manualSchema, f.home)).toBeDefined();
    expect(readContextCapabilityEvidence({ ...manual, zeroRiskRequireSentConfirmation: !manual.zeroRiskRequireSentConfirmation }, manualSchema, f.home)).toBeUndefined();
    invalidateContextCapabilityEvidence(manual, f.home);
    expect(readContextCapabilityEvidence(manual, manualSchema, f.home)).toBeUndefined();
    expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeDefined();
  });
  test("provider proof reads only the known production and DEV profile layouts", () => {
    for (const development of [false, true]) {
      const f = fixture(); if (development) f.config.purpose = "dev-harness";
      writeFileSync(join(f.home, "config.json"), JSON.stringify(f.config));
      const schema = contextCapabilitySchemaDigest(tools(), "automatic"); saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
      const provider = providerConfig(f.config);
      for (const statePath of [join(f.home, "runtime", "thread-environments.json"),
        ...(development ? [join(f.home, "runtime", "dev-chat", "thread-environments.json")] : [])]) {
        provider.chatgptWeb!.threadEnvironmentStatePath = statePath;
        expect(readProviderContextCapabilityEvidence(provider, schema)).toBeDefined();
      }
      provider.chatgptWeb!.threadEnvironmentStatePath = join(f.home, "other", "thread-environments.json");
      expect(() => readProviderContextCapabilityEvidence(provider, schema)).toThrow("supported runtime profile");
      provider.chatgptWeb!.threadEnvironmentStatePath = join(f.home, "runtime", "thread-environments.json");
      provider.chatgptWeb!.appName = "Codex Different";
      expect(() => readProviderContextCapabilityEvidence(provider, schema)).toThrow("does not match");
    }
  });
  test("real stdio six-call returns create evidence through an isolated external-owner broker", async () => {
    const f = fixture();
    const client = new Client({ name: "verification-callability-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("src/cli.ts"), "mcp", "--contract", "native", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
    try {
      const evidence = await runContextCapabilityVerification(f.config, { home: f.home, timeoutMs: 5_000, automaticRun: async turn => {
        const prompt = await turn.prepare();
        expect(prompt.text).not.toContain("pairToken"); expect(prompt.images).toEqual([]);
        await turn.onSubmitted?.();
        const calls = prompt.text.split("\n").filter(line => line.startsWith("Call "));
        expect(calls).toHaveLength(6);
        for (const line of calls) {
          const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(line)!;
          const result = await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) });
          expect(result.isError).not.toBe(true);
        }
        return "A model's final prose is not used as evidence";
      } });
      expect(evidence.receipts).toMatchObject(successMethods); expect(contextCapabilityReceiptsComplete(evidence.receipts)).toBe(true);
      expect(readContextCapabilityEvidence(f.config, evidence.binding.schemaDigest, f.home)).toEqual(evidence);
    } finally { await client.close(); }
  });
  test("Automatic verification crosses the real helper contract before its six successful MCP receipts", async () => {
    const f = fixture(); f.config.browserHost = "launcher";
    f.config.browserHostDescriptorPath = join(f.home, "launcher.json");
    const helperPath = join(f.home, "verification-helper.ts"); const observedPath = join(f.home, "helper-observed.json");
    writeFileSync(helperPath, `
      import { writeFileSync } from "node:fs";
      import { Client } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"))};
      import { StdioClientTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/client/stdio.js"))};
      import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
      // Substitute only the browser; the production helper validates the actual run message first.
      ChatGptBrowserWorker.prototype.run = async function(turn) {
        await turn.onPreparedSelected(false);
        const prepared = await turn.prepare();
        const calls = prepared.text.split("\\n").filter(line => line.startsWith("Call ")).map(line => {
          const match = /^Call (codex_context_\\w+) with (\\{.*\\})\\.$/.exec(line);
          if (!match) throw new Error("Invalid verification call fixture");
          return { name: match[1], arguments: JSON.parse(match[2]) };
        });
        const client = new Client({ name: "automatic-helper-verification-test", version: "1" });
        await client.connect(new StdioClientTransport({ command: ${JSON.stringify(process.execPath)},
          args: [${JSON.stringify(resolve("src/cli.ts"))}, "mcp", "--contract", "native", "--broker-socket", ${JSON.stringify(f.config.brokerSocketPath)}], stderr: "pipe" }));
        try {
          if ((await client.callTool(calls[0])).isError !== true) throw new Error("Source reads opened before onSubmitted");
          await turn.onSendActivated();
          await turn.onSubmitted();
          const successful = [];
          for (const call of calls) {
            if ((await client.callTool(call)).isError === true) throw new Error("A real context call failed");
            successful.push(call.name);
          }
          writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ traceId: turn.traceId, conversationKey: turn.conversationKey,
            nativeConnector: turn.nativeConnector, preSubmitReadRejected: true, successful }));
          return "Read-only verification completed";
        } finally { await client.close(); }
      };
      await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
    `, { mode: 0o700 });
    writeFileSync(f.config.browserHostDescriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
      profile: "production", pid: process.pid, endpoint: "http://127.0.0.1:39001",
      control: { endpoint: "http://127.0.0.1:39002", token: "local-helper-control-0123456789abcdefghijklmnop" },
      helper: { executable: process.execPath, script: helperPath }, partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const evidence = await runContextCapabilityVerification(f.config, { home: f.home, timeoutMs: 15_000 });
    const observed = JSON.parse(readFileSync(observedPath, "utf8"));
    expect(observed.traceId).toStartWith("context_verify_");
    expect(observed.nativeConnector).toBe(true); expect(observed.preSubmitReadRejected).toBe(true);
    expect(observed.successful).toEqual(["codex_context_list", "codex_context_search", "codex_context_read",
      "codex_context_list", "codex_context_search", "codex_context_read"]);
    expect(evidence.receipts).toMatchObject(successMethods); expect(contextCapabilityReceiptsComplete(evidence.receipts)).toBe(true);
    expect(readContextCapabilityEvidence(f.config, evidence.binding.schemaDigest, f.home)).toEqual(evidence);
  }, 30_000);
  test("a typed success reply does not verify and a failed retry clears the previous proof", async () => {
    const f = fixture(); const schema = await installedContextCapabilitySchemaDigest(f.config);
    saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    await expect(runContextCapabilityVerification(f.config, { home: f.home, timeoutMs: 15_000,
      automaticRun: async turn => { await turn.onSubmitted?.(); return "All six tools succeeded"; } })).rejects.toThrow("without all six");
    expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
  });
  test("cancelled verification clears old evidence and cannot save partial transport success", async () => {
    const f = fixture(), schema = await installedContextCapabilitySchemaDigest(f.config);
    saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    const broker = TurnBroker.forSocket(f.config.brokerSocketPath);
    const client = new Client({ name: "cancelled-verification-test", version: "1" });
    const controller = new AbortController();
    let partialSuccess!: () => void;
    const partialReady = new Promise<void>(resolveReady => { partialSuccess = resolveReady; });
    let outcome: Promise<unknown> | undefined;
    try {
      await broker.listen();
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [resolve("src/cli.ts"), "mcp", "--contract", "native", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
      outcome = runContextCapabilityVerification(f.config, { home: f.home, broker, timeoutMs: 15_000, abortSignal: controller.signal,
        automaticRun: async turn => {
          const prompt = await turn.prepare();
          await turn.onSubmitted?.();
          const firstCall = prompt.text.split("\n").find(line => line.startsWith("Call "))!;
          const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(firstCall)!;
          expect((await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) })).isError).not.toBe(true);
          partialSuccess();
          return verificationStopped(turn.abortSignal!);
        } }).then(() => undefined, error => error);
      await Promise.race([partialReady,
        outcome.then(error => { throw new Error("Verification ended before partial transport success", { cause: error }); })]);
      expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
      const cancellation = new Error("User cancelled verification");
      controller.abort(cancellation);
      expect(await outcome).toBe(cancellation);
      expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
    } finally {
      controller.abort(new Error("Cancellation test cleanup"));
      await outcome;
      await client.close();
      await broker.close();
    }
  });
  test("verification timeout clears old evidence without saving incomplete receipts", async () => {
    const f = fixture(), schema = await installedContextCapabilitySchemaDigest(f.config);
    saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
    const broker = TurnBroker.forSocket(f.config.brokerSocketPath);
    try {
      await broker.listen();
      await expect(runContextCapabilityVerification(f.config, { home: f.home, broker, timeoutMs: 100,
        automaticRun: turn => verificationStopped(turn.abortSignal!) })).rejects.toThrow("timed out");
      expect(readContextCapabilityEvidence(f.config, schema, f.home)).toBeUndefined();
    } finally { await broker.close(); }
  });
  test("verify-context --json keeps a self-owned Broker's diagnostics outside its single JSON stdout", async () => {
    const f = fixture();
    f.config.browserInteractionMode = "manual"; f.config.browserHost = "launcher";
    f.config.appName = f.config.manualAppName; f.config.zeroRiskRequireSentConfirmation = true;
    f.config.manualTunnel = { ...f.config.tunnel!, tunnelId: `tunnel_${"b".repeat(32)}`, profileName: "manual", alias: "manual" };
    f.config.tunnel = f.config.manualTunnel;
    f.config.browserHostDescriptorPath = join(f.home, "launcher.json");
    const client = new Client({ name: "cli-context-verification-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
    let allowReads!: () => void; const readyForReads = new Promise<void>(resolveReady => { allowReads = resolveReady; });
    let userCalls: Promise<void> | undefined; let modelFailure: unknown; const calls: string[] = [];
    const controlToken = "local-verification-control-0123456789abcdefghijklmnop";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${controlToken}`);
      const action = new URL(request.url).pathname;
      const activity = await request.json() as { prompt?: string; sentConfirmationRequired?: boolean };
      if (action === "/v1/manual/start") {
        expect(activity.sentConfirmationRequired).toBe(true);
        userCalls = (async () => {
          const start = /First call codex_turn_start with (\{.*?\})\./.exec(activity.prompt!)!;
          expect((await client.callTool({ name: "codex_turn_start", arguments: JSON.parse(start[1]!) })).isError).not.toBe(true);
          await readyForReads;
          for (const line of activity.prompt!.split("\n").filter(line => line.startsWith("Call "))) {
            const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(line)!;
            expect((await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) })).isError).not.toBe(true);
            calls.push(match[1]!);
          }
        })();
        void userCalls.catch(error => { modelFailure = error; });
        return Response.json({ ok: true, tabId: "local-verification", reused: false, deadlineAt: null,
          state: "awaiting-user", sentConfirmationRequired: true });
      }
      if (action === "/v1/manual/wait-sent") return Response.json({ status: "sent", sentAt: new Date().toISOString() });
      if (action === "/v1/manual/started") { allowReads(); return Response.json({ ok: true }); }
      if (action === "/v1/manual/wait-terminal") {
        await Bun.sleep(50);
        return modelFailure ? Response.json({ status: "failed" }) : Response.json({ status: "pending" }, { status: 202 });
      }
      if (action === "/v1/manual/end") return Response.json({ ok: true, cancelledByUser: false });
      return Response.json({ error: "Unexpected manual control action" }, { status: 404 });
    } });
    const endpoint = `http://127.0.0.1:${server.port}`;
    writeFileSync(f.config.browserHostDescriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND,
      profile: "production", pid: process.pid, endpoint, control: { endpoint, token: controlToken },
      helper: { executable: process.execPath, script: resolve("src/cli.ts") }, partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "a".repeat(32), surfaceTargets: {}, createdAt: new Date().toISOString() }), { mode: 0o600 });
    writeFileSync(join(f.home, "config.json"), JSON.stringify(f.config));
    expect(existsSync(f.config.brokerSocketPath)).toBe(false);
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", f.home, "verify-context", "--json"], {
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: f.home, CODEX_HOME: join(f.home, "codex") }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [exitCode, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      await userCalls;
      if (exitCode !== 0) throw new Error(`Local verification CLI failed: ${err}`);
      expect(modelFailure).toBeUndefined(); expect(exitCode).toBe(0);
      expect(calls).toEqual(["codex_context_list", "codex_context_search", "codex_context_read", "codex_context_list", "codex_context_search", "codex_context_read"]);
      const result = JSON.parse(out);
      expect(result.ok).toBe(true); expect(result.evidence.receipts).toMatchObject(successMethods);
      expect(contextCapabilityReceiptsComplete(result.evidence.receipts)).toBe(true);
      expect(out.trim().split("\n")).toHaveLength(1);
      expect(err).toContain("broker lifecycle"); expect(err).toContain('"event":"start_requested"');
      expect(err).toContain('"event":"close_complete"');
      expect(readContextCapabilityEvidence(f.config, result.evidence.binding.schemaDigest, f.home)).toEqual(result.evidence);
    } finally {
      clearTimeout(timeout); if (child.exitCode === null) child.kill("SIGKILL");
      allowReads(); await userCalls?.catch(() => {}); server.stop(true); await client.close();
    }
  }, 30_000);
  for (const requireSent of [true, false]) test(`manual six-call transaction preserves start and Sent=${requireSent}`, async () => {
    const f = fixture(); f.config.browserInteractionMode = "manual"; f.config.browserHost = "launcher";
    f.config.appName = f.config.manualAppName; f.config.browserHostDescriptorPath = join(f.home, "launcher.json");
    f.config.zeroRiskRequireSentConfirmation = requireSent;
    f.config.manualTunnel = { ...f.config.tunnel!, tunnelId: `tunnel_${"b".repeat(32)}`, profileName: "manual", alias: "manual" };
    const client = new Client({ name: "manual-verification-test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("src/cli.ts"), "mcp", "--contract", "safe", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
    let userCalls: Promise<void> | undefined; let allowReads!: () => void;
    const readsAllowed = new Promise<void>(resolveReady => { allowReads = resolveReady; });
    let sentChecks = 0; let endStatus = "";
    try {
      const evidence = await runContextCapabilityVerification(f.config, { home: f.home, timeoutMs: 5_000,
        automaticRun: async () => { throw new Error("manual verification must not automate Send"); },
        manualControl: {
          async start(_descriptor, activity) {
            expect(activity.sentConfirmationRequired).toBe(requireSent);
            userCalls = (async () => {
              await new Promise(resolveTick => setTimeout(resolveTick, 20));
              const start = /First call codex_turn_start with (\{.*?\})\./.exec(activity.prompt)!;
              const result = await client.callTool({ name: "codex_turn_start", arguments: JSON.parse(start[1]!) });
              expect(result.isError).not.toBe(true);
              await readsAllowed;
              for (const line of activity.prompt.split("\n").filter(line => line.startsWith("Call "))) {
                const match = /^Call (codex_context_\w+) with (\{.*\})\.$/.exec(line)!;
                expect((await client.callTool({ name: match[1]!, arguments: JSON.parse(match[2]!) })).isError).not.toBe(true);
              }
            })();
            return { tabId: "manual-verification", reused: false, deadlineAt: null, state: "awaiting-user", sentConfirmationRequired: requireSent };
          },
          async waitSent() { sentChecks++; return { sentAt: new Date().toISOString() }; },
          async started() { allowReads(); },
          waitTerminal(_descriptor, _owner, options) { return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener("abort", () => reject(new Error("manual scope closed")), { once: true });
          }); },
          async end(_descriptor, activity) { endStatus = activity.status; return { cancelledByUser: false }; },
        } });
      await userCalls;
      expect(evidence.receipts).toMatchObject(successMethods); expect(contextCapabilityReceiptsComplete(evidence.receipts)).toBe(true); expect(sentChecks).toBe(requireSent ? 1 : 0); expect(endStatus).toBe("completed");
    } finally { allowReads(); await userCalls?.catch(() => {}); await client.close(); }
  });
  for (const manual of [false, true]) for (const development of [false, true])
    test(`actual ${manual ? "Zero Risk" : "Automatic"} ${development ? "DEV" : "production"} sends ignore historical diagnostic records`, async () => {
      const f = fixture(); f.config.toolAuthorityMode = "delegated"; f.config.solAvailable = true;
      f.config.browserInteractionMode = manual ? "manual" : "automatic";
      f.config.browserHost = "launcher"; f.config.browserHostDescriptorPath = join(f.home, "launcher.json");
      if (development) f.config.purpose = "dev-harness";
      f.config.manualTunnel = { ...f.config.tunnel!, tunnelId: `tunnel_${"b".repeat(32)}`, profileName: "manual", alias: "manual" };
      f.config.appName = manual ? f.config.manualAppName : f.config.automaticAppName;
      // Keep mutable fixtures outside Git so parallel source fingerprints stay stable.
      const runtimeRoot = mkdtempSync(join(tmpdir(), "context-runtime-")); roots.push(runtimeRoot);
      const runtimeFile = join(runtimeRoot, "runtime-entry.ts");
      const runtimeSource = `await import(${JSON.stringify(resolve("src/cli.ts"))});\n`;
      writeFileSync(runtimeFile, runtimeSource); f.config.runtimeCommand = [process.execPath, runtimeFile];
      writeFileSync(join(f.home, "config.json"), JSON.stringify(f.config));
      const provider = providerConfig(f.config);
      provider.chatgptWeb!.threadEnvironmentStatePath = development
        ? join(f.home, "runtime", "dev-chat", "thread-environments.json") : join(f.home, "runtime", "thread-environments.json");
      const broker = TurnBroker.forSocket(f.config.brokerSocketPath); await broker.listen();
      const client = new Client({ name: "diagnostic-independent-factory-test", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [resolve("src/cli.ts"), "mcp", "--contract", manual ? "safe" : "native", "--broker-socket", f.config.brokerSocketPath], stderr: "pipe" }));
      const schema = await installedContextCapabilitySchemaDigest(f.config);
      const evidencePath = getContextCapabilityEvidencePath(f.home);
      const worker = ChatGptBrowserWorker.forProvider(provider);
      const taskUpdates = spyOn(worker, "supportsTaskUpdates").mockResolvedValue(false);
      const diagnostics = spyOn(broker, "armContextVerification");
      const answer = "Recorded evidence is available.";
      let sends = 0, expectedNavigation = false;
      const plans: unknown[] = [];
      const inspectPrompt = async (prompt: string) => {
        sends++;
        expect(prompt).not.toContain("Read-only capability verification");
        const match = /<codex_context_navigation_json>\n([^\n]+)\n<\/codex_context_navigation_json>/.exec(prompt);
        expect(Boolean(match)).toBe(expectedNavigation);
        if (!match) { plans.push({ navigation: false }); return undefined; }
        const entry = JSON.parse(match[1]!);
        const listing = await client.callTool({ name: entry.first_call.name,
          arguments: { ...entry.first_call.arguments, view: "entries", kind: "tool_result" } });
        expect(listing.isError).not.toBe(true);
        const target = (listing.structuredContent as any).entries.find((entry: any) => entry.call_id === "old-call");
        expect(target).toBeDefined();
        const { view, ...reference } = entry.first_call.arguments;
        const result = await client.callTool({ name: "codex_context_read", arguments: { ...reference, read_ref: target.read_ref } });
        expect(result.isError).not.toBe(true);
        const read = parseContextTextReadResult(result);
        expect(read.body).toContain("Recorded tool evidence.");
        plans.push({ navigation: true, requiredImages: entry.required_images,
          sourceBytes: read.metadata.utf8_bytes, delivery: target.delivery });
        return entry;
      };
      const run = spyOn(worker, "run").mockImplementation(async turn => {
        expect(manual).toBe(false);
        const compiled = await turn.prepare();
        try {
          if (compiled.contextPlan) await turn.onContextPlanSelected!(compiled.contextPlan.planId);
          await turn.onSubmitted?.(); await inspectPrompt(compiled.text);
          turn.onTextDelta(answer); return answer;
        } finally { await compiled.release(); }
      });
      let prompt = "", requestId: string | undefined;
      const control: ChatGptZeroRiskManualControl = {
        async start(_path, activity) { prompt = activity.prompt; return { selectedPlanId: activity.contextPlans?.full?.planId }; },
        async waitSent() {
          requestId = /request_id=([A-Za-z0-9_-]+)/.exec(prompt)?.[1]
            ?? /"request_id":"([A-Za-z0-9_-]+)"/.exec(prompt)?.[1];
          expect(requestId).toBeDefined();
          expect((await client.callTool({ name: "codex_turn_start", arguments: { request_id: requestId } })).isError).not.toBe(true);
        },
        waitTerminal: () => new Promise<never>(() => {}),
        async markStarted() {
          const entry = await inspectPrompt(prompt);
          if (entry) expect(entry.first_call.arguments.request_id).toBe(requestId);
          expect((await client.callTool({ name: "codex_turn_complete", arguments: { request_id: requestId, final_answer: answer } })).isError).not.toBe(true);
        },
        async end() {}, async cancel() {},
      };
      let turnNumber = 0;
      const request = (threadId: string, continuation: boolean) => {
        const turnId = `turn-${++turnNumber}`;
        return parseRequest({ model: manual ? CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL : CHATGPT_WEB_BACKEND_MODEL,
          reasoning: { effort: manual ? "low" : "high" },
          input: [...(expectedNavigation ? [
            { type: "function_call", call_id: "old-call", name: "exec_command", arguments: '{"cmd":"old evidence"}' },
            { type: "function_call_output", call_id: "old-call", output: "Recorded tool evidence.\n".repeat(4_000) },
          ] : []),
          ...(continuation ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }] : []),
          { type: "message", id: `user-message-${turnNumber}`, role: "user", content: [{ type: "input_text", text: "Read the recorded evidence." }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId } }],
          tools: [{ type: "function", name: "exec_command", description: "Execute", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }) } });
      };
      const adapter = createChatGptWebAdapter(provider, { broker, zeroRiskManualControl: control });
      try {
        const variants = ["missing", "corrupt", "old-version", "schema", "mode", "plugin", "tunnel", "runtime-command", "runtime-replaced", "success"];
        let baseline: unknown[] | undefined;
        for (const variant of variants) {
          writeFileSync(runtimeFile, runtimeSource);
          const evidence = saveContextCapabilityEvidence(f.config, schema, receipts(), f.home);
          if (variant === "schema") evidence.binding.schemaDigest = "f".repeat(64);
          if (variant === "mode") evidence.binding.mode = manual ? "automatic" : "manual";
          if (variant === "plugin") evidence.binding.appName = "Codex Previous Plugin";
          if (variant === "tunnel") evidence.binding.tunnelId = "previous-tunnel";
          if (variant === "runtime-command") evidence.binding.runtimeCommand = ["previous-runtime"];
          if (variant === "runtime-replaced") writeFileSync(runtimeFile, runtimeSource + "// compatible runtime upgrade\n");
          if (variant === "missing") rmSync(evidencePath, { force: true });
          else writeFileSync(evidencePath, variant === "corrupt" ? "{invalid" : JSON.stringify({
            version: variant === "old-version" ? 1 : 2, modes: { [f.config.browserInteractionMode]: evidence } }));
          expect(Boolean(readContextCapabilityEvidence(f.config, schema, f.home))).toBe(variant === "success");
          const before = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : undefined;
          const firstPlan = plans.length, firstSend = sends;
          for (const navigation of [false, true]) {
            expectedNavigation = navigation;
            const threadId = `${f.home}-${variant}-${navigation}`;
            for (const continuation of [false, true]) {
              const events: AdapterEvent[] = [];
              await adapter.runTurn!(request(threadId, continuation), { headers: new Headers() }, event => events.push(event));
              expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
              expect(events.filter(event => event.type === "error")).toEqual([]);
            }
          }
          expect(sends - firstSend).toBe(4);
          const actual = plans.slice(firstPlan);
          if (baseline) expect(actual).toEqual(baseline); else baseline = actual;
          expect(existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : undefined).toBe(before);
        }
        expect(diagnostics).not.toHaveBeenCalled();
        expectedNavigation = true;
        const beforeRejection = sends;
        const registration = spyOn(broker, "registerContextPlan").mockImplementation(() => {
          throw new Error("Current Broker context protocol is incompatible");
        });
        try {
          await expect(adapter.runTurn!(request(`${f.home}-incompatible`, false), { headers: new Headers() }, () => {}))
            .rejects.toThrow("Current Broker context protocol is incompatible");
          expect(sends).toBe(beforeRejection);
        } finally { registration.mockRestore(); }
      } finally { run.mockRestore(); diagnostics.mockRestore(); taskUpdates.mockRestore(); await client.close(); await broker.close(); }
    }, 30_000);
});
