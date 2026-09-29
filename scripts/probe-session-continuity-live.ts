import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, providerConfig } from "../src/config";
import { activateDevProfileEnvironment } from "../src/dev-chat/profile";
import { DEV_CHAT_SYSTEM_INSTRUCTIONS, prepareWorkingTreeBrowserHelper } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { ChatGptBrowserWorker, closeChatGptBrowserWorkers } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { activeCompactionToolResultInstruction, structuredCompactionHandoffInstruction } from "../src/adapters/chatgpt-web/native-compaction-control";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { readLauncherBrowserHostDescriptor, releaseLauncherRetainedConversation } from "../src/launcher-browser-host";
import type { CodexParsedRequest } from "../src/types";

// P0 platform experiment, not a continuity route. It owns only its newly created DEV pages.
// Browser, connector, broker and one-shot handoff are real. Outer command results are simulated.
const option = (name: string) => process.argv.slice(2).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
const path = option("--path") ?? "automatic-completed";
assert.ok(["automatic-completed", "automatic-active"].includes(path), "Choose --path=automatic-completed or automatic-active");
const repetitions = Number(option("--repetitions") ?? 2);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 2);
const runId = `${path}-${Date.now()}`;
const outputDir = resolve("output/session-continuity-p0", runId);
mkdirSync(outputDir, { recursive: true });
const paths = activateDevProfileEnvironment();
const config = loadConfig();
assert.equal(config.purpose, "dev-harness");
assert.equal(config.mode, "full");
assert.equal(config.browserInteractionMode, "automatic");
assert.equal(config.experimentalBiggerContext, false);
assert.notEqual(config.experimentalFreshConversationPerTurn, true);
const descriptorPath = config.browserHostDescriptorPath!;
assert.equal(readLauncherBrowserHostDescriptor(descriptorPath).profile, "development");
const provider = providerConfig(config);
provider.chatgptWeb = { ...provider.chatgptWeb, browserHelperScriptPath: prepareWorkingTreeBrowserHelper(),
  browserDiagnosticsPath: join(outputDir, "diagnostics"), turnTimeoutMs: 300_000 };
const worker = ChatGptBrowserWorker.forProvider(provider);
const transport = await startDevChatTransport(config, paths.home);
const broker = transport.broker;
const capabilities = { localToolsEnabled: true, solAvailable: config.solAvailable,
  extraHighAvailable: config.extraHighAvailable === true, proAvailable: config.proAvailable };
const environment: ChatGptTurnEnvironment = {
  cwd: process.cwd(), roots: [process.cwd()], writableRoots: [],
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  tools: [{ name: "exec_command", description: "DEV simulator. Returns a receipt; executes no command.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: true } }],
};
const report: any = { startedAt: new Date().toISOString(), runId, path, repetitions, simulatedOuterTools: true, runs: [] };
const save = () => writeFileSync(join(outputDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

async function probe(index: number): Promise<void> {
  const conversationKey = fingerprint(`p0-continuity-${randomUUID()}`);
  const baseline = readLauncherBrowserHostDescriptor(descriptorPath).surfaceTargets;
  const evidence: any = { index, conversationKey, status: "running", events: [], capabilities: [] };
  report.runs.push(evidence); save();
  let surface: [string, string] | undefined;
  const tokens: string[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("P0 live experiment exceeded ten minutes")), 600_000);
  function record(event: string, fields: Record<string, unknown> = {}): void {
    evidence.events.push({ at: new Date().toISOString(), event, ...fields }); save();
    console.log(`P0 ${index} ${event} ${JSON.stringify(fields)}`);
  }
  function verifySurface(phase: string): void {
    const targets = readLauncherBrowserHostDescriptor(descriptorPath).surfaceTargets;
    if (!surface) {
      const created = Object.entries(targets).filter(([id]) => !(id in baseline));
      assert.equal(created.length, 1, "Exactly one new DEV physical surface must identify the experiment");
      surface = created[0]!;
    }
    assert.equal(targets[surface[0]], surface[1], "The exact physical surface and browser target must remain alive");
    const unexpected = Object.keys(targets).filter(id => !(id in baseline) && id !== surface![0]);
    assert.equal(unexpected.length, 0, "No second physical surface may appear in this experiment");
    record("surface", { phase, surfaceId: surface[0], targetId: surface[1] });
  }
  async function rejectRetired(token: string): Promise<void> {
    await assert.rejects(callTurnBroker(broker.socketPath, { method: "claim", token }), { code: "codex_tool_operation_retired" });
    record("old-capability-rejected", { fingerprint: fingerprint(token) });
  }
  async function work(phase: "before" | "after"): Promise<void> {
    const traceId = `p0_${index}_${phase}_${randomUUID()}`;
    const token = await broker.register(environment, 600_000, traceId);
    tokens.push(token);
    evidence.capabilities.push({ phase, fingerprint: fingerprint(token) });
    assert.equal(new Set(tokens).size, tokens.length, "Each ordinary response must receive a new capability");
    const active = phase === "before" && path === "automatic-active";
    const marker = `P0_${phase.toUpperCase()}_${index}`;
    const parsed: CodexParsedRequest = { modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "low" },
      context: { systemPrompt: [DEV_CHAT_SYSTEM_INSTRUCTIONS], tools: environment.tools,
        messages: [{ role: "user", timestamp: Date.now(), content:
          `Call exec_command with cmd "printf ${marker}" exactly once. This is a simulated DEV receipt, not a real command. `
          + (active ? `After receiving that receipt, call exec_command once more with cmd "printf P0_SECOND". ` : "")
          + "Then give a short final answer describing the receipt. Do not use other tools." }] } };
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token);
    const prepare = async () => ({ ...compiled, release() {} });
    const progress = new ChatGptExternalTurnProgress();
    const observation = new AbortController();
    const observationSignal = AbortSignal.any([controller.signal, observation.signal]);
    const waiting = (async () => {
      let revision = 0;
      while (!observationSignal.aborted) {
        const snapshot = await broker.waitForNativeWaiting(token, revision, observationSignal);
        if (observationSignal.aborted) return;
        revision = snapshot.revision; progress.recordNativeWaiting(snapshot);
      }
    })().catch(error => { if (!observationSignal.aborted) controller.abort(error); });
    const browser = worker.run({ traceId, modelId: parsed.modelId, reasoning: "low", capabilities,
      prepare, prepareResume: prepare, conversationKey, retainConversation: true,
      requireRetainedConversation: phase === "after", abortSignal: controller.signal,
      externalProgress: progress,
      completionFence: { begin: async () => broker.beginCompletionFence(token),
        commit: async revision => broker.commitCompletionFence(token, revision) },
      onPreparedSelected: reused => {
        assert.equal(reused, phase === "after", "Only the first response may create a page");
        record("lease", { phase, reused });
      },
      onSubmitted: () => verifySurface(phase), onTextDelta() {},
    });
    void browser.then(() => observation.abort(), () => observation.abort());
    const calls = await Promise.race([broker.nextToolBatch(token, controller.signal),
      browser.then(() => { throw new Error("Browser ended before the expected real MCP tool call"); })]);
    assert.equal(calls.length, 1, "One simulated outer call is expected");
    assert.equal(calls[0]!.wireName, "exec_command");
    assert.ok(String(calls[0]!.arguments?.cmd).includes(marker), "The new capability must carry this response's task");
    const revision = progress.recordToolBatch(calls.length);
    // Keep the production causal barrier: the browser must observe this tool boundary before
    // the simulated outer executor can deliver a result and let ChatGPT change the DOM again.
    await Promise.race([progress.waitForToolBatchObservation(revision, controller.signal),
      browser.then(() => { throw new Error("Browser ended before observing the tool boundary"); })]);
    if (active) broker.requestCompaction(token, { content: [{ type: "text", text: activeCompactionToolResultInstruction() }], isError: true });
    const receipt = { simulated: true, side_effects_performed: false, marker, callId: calls[0]!.callId };
    broker.completeTool(token, calls[0]!.callId, { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt });
    progress.recordToolResult(); record("tool-receipt", { phase, ...receipt });
    const answer = await browser;
    await waiting;
    assert.ok(answer.trim(), "Ordinary response must finish");
    if (active) {
      const deliveries = broker.compactionDeliveryCount(token);
      assert.ok(deliveries >= 1, "Active path must deliver the control instruction to the later unexecuted tool call");
      record("active-control-delivered", { deliveries });
    }
    broker.revoke(token);
    await rejectRetired(token);
    verifySurface(`${phase}-settled`);
  }
  try {
    await work("before");
    const traceId = `p0_${index}_compact_${randomUUID()}`;
    const transaction = await broker.beginCompactionTransaction(traceId, 300_000);
    const browserAbort = new AbortController();
    const signal = AbortSignal.any([controller.signal, browserAbort.signal]);
    const instruction = structuredCompactionHandoffInstruction(transaction);
    const prepare = async () => ({ text: instruction, images: [], release() {} });
    const browser = worker.run({ traceId, modelId: "gpt-5.6-sol", reasoning: "low",
      capabilities: { ...capabilities, localToolsEnabled: false }, nativeConnector: true,
      prepare, prepareResume: prepare, conversationKey, requireRetainedConversation: true,
      retainConversation: true, abortSignal: signal, onTextDelta() {},
      onPreparedSelected: reused => { assert.equal(reused, true); record("lease", { phase: "summary", reused }); },
      onSubmitted: () => verifySurface("summary"),
    });
    void browser.catch(() => {});
    try {
      let handoffReceived = false;
      const handoff = broker.waitForCompactionHandoff(transaction.token, controller.signal).then(summary => {
        handoffReceived = true;
        return summary;
      });
      const summary = await Promise.race([handoff,
        browser.then(answer => {
          if (!handoffReceived) {
            let diagnostic = answer;
            for (const secret of [...tokens, transaction.token, transaction.handoffId]) {
              diagnostic = diagnostic.replaceAll(secret, "[redacted]");
              diagnostic = diagnostic.replaceAll(secret.replaceAll("_", "\\_"), "[redacted]");
            }
            record("summary-ended-without-handoff", { responseChars: answer.length,
              responseText: diagnostic.slice(0, 2_000) });
          }
          throw new Error("Summary response ended without a structured handoff");
        })]);
      assert.ok(summary.trim());
      record("structured-handoff", { summarySha256: fingerprint(summary), summaryChars: summary.length });
      browserAbort.abort(new ChatGptCompactionHandoffAccepted());
      await browser.catch(() => {});
      verifySurface("summary-settled");
      await assert.rejects(callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff",
        token: transaction.token, handoffId: transaction.handoffId, summary: "REPLAY MUST FAIL" }), /invalid|expired|consumed/i);
      record("consumed-control-rejected");
    } finally {
      browserAbort.abort(); broker.abortCompactionTransaction(transaction.token);
      await browser.catch(() => {});
    }
    await work("after");
    evidence.status = "passed"; record("passed");
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
    record("failed", { error: evidence.error });
    throw error;
  } finally {
    clearTimeout(timeout); controller.abort();
    for (const token of tokens) broker.revoke(token);
    await releaseLauncherRetainedConversation(descriptorPath, conversationKey).catch(error => {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
    });
    save();
  }
}

try {
  for (let index = 1; index <= repetitions; index++) await probe(index);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await closeChatGptBrowserWorkers(); await transport.close(); save();
  console.log(`Evidence: ${join(outputDir, "evidence.json")}`);
}
