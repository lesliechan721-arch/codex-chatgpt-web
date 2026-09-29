import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { activateDevProfileEnvironment } from "../src/dev-chat/profile";
import { DEV_CHAT_SYSTEM_INSTRUCTIONS } from "../src/dev-chat/driver";
import { startDevChatTransport } from "../src/dev-chat/transport";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { settleActiveZeroRiskCompactionSource } from "../src/adapters/chatgpt-web/compaction-handoff";
import { callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSession } from "../src/adapters/chatgpt-web/turn-execution";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { COMPACT_PROMPT } from "../src/responses/compaction";
import { endLauncherManualTurn, markLauncherManualTurnStarted, readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation, startLauncherManualTurn, waitForLauncherManualSent,
  waitForLauncherManualTerminal } from "../src/launcher-browser-host";
import type { CodexParsedRequest } from "../src/types";

// Uses the real Zero Risk control path. The user submits every ordinary browser message.
// No browser DOM, CDP connection, automatic message, or fresh-summary fallback is used here.
const paths = activateDevProfileEnvironment();
const config = loadConfig();
assert.equal(config.purpose, "dev-harness");
assert.equal(config.mode, "full");
assert.equal(config.browserInteractionMode, "manual", "Configure Zero Risk in the isolated DEV launcher first");
const descriptorPath = config.browserHostDescriptorPath!;
assert.equal(readLauncherBrowserHostDescriptor(descriptorPath).profile, "development");
const runId = `zero-risk-active-${Date.now()}`;
const outputDir = resolve("output/session-continuity-p0", runId);
mkdirSync(outputDir, { recursive: true });
const transport = await startDevChatTransport(config, paths.home);
const broker = transport.broker;
const capabilities = { localToolsEnabled: true, solAvailable: false, extraHighAvailable: false, proAvailable: false };
const environment: ChatGptTurnEnvironment = { cwd: process.cwd(), roots: [process.cwd()], writableRoots: [],
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  tools: [{ name: "exec_command", description: "DEV simulated command receipt; no command is executed.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: true } }] };
const report: any = { startedAt: new Date().toISOString(), runId, repetitions: 2, simulatedOuterTools: true, runs: [] };
const save = () => writeFileSync(join(outputDir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

async function probe(index: number): Promise<void> {
  const conversationKey = fingerprint(`p0-zero-risk-${randomUUID()}`);
  const evidence: any = { index, conversationKey, status: "running", events: [], capabilities: [] };
  report.runs.push(evidence); save();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("P0 manual experiment exceeded twenty minutes")), 1_200_000);
  let tabId: string | undefined;
  let summarySha256: string | undefined;
  let launcherStarts = 0;
  const tokens: string[] = [];
  function record(event: string, fields: Record<string, unknown> = {}): void {
    evidence.events.push({ at: new Date().toISOString(), event, ...fields }); save();
    console.log(`P0 ${index} ${event} ${JSON.stringify(fields)}`);
  }
  async function work(phase: "before" | "after"): Promise<void> {
    const owner = { traceId: `p0_zero_${index}_${phase}_${randomUUID()}`, helperPid: process.pid };
    const nonce = randomBytes(32).toString("base64url");
    const token = await broker.registerSafe(environment, nonce, 900_000, owner.traceId,
      { requireSentConfirmation: config.zeroRiskRequireSentConfirmation });
    tokens.push(token);
    assert.equal(new Set(tokens).size, tokens.length);
    evidence.capabilities.push({ phase, fingerprint: fingerprint(token) });
    const marker = `P0_ZERO_${phase.toUpperCase()}_${index}`;
    const parsed: CodexParsedRequest = { modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, stream: true, options: { reasoning: "low" },
      context: { systemPrompt: [DEV_CHAT_SYSTEM_INSTRUCTIONS], tools: environment.tools,
        messages: [{ role: "user", timestamp: Date.now(), content:
          `Call exec_command exactly once with cmd "printf ${marker}". This returns a simulated receipt and executes no command. `
          + "Then give a short final answer through the normal Zero Risk completion tool. Do not call any other work tool." }] } };
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { manualControl: true });
    const progress = new ChatGptExternalTurnProgress();
    let started = false;
    const browser = (async () => {
      try {
        const lease = await startLauncherManualTurn(descriptorPath, { ...owner, prompt: compiled.text,
          resumePrompt: compiled.text, conversationKey, sentConfirmationRequired: config.zeroRiskRequireSentConfirmation });
        started = true; launcherStarts++;
        record("manual-lease", { phase, tabId: lease.tabId, reused: lease.reused, deadlineAt: lease.deadlineAt });
        if (phase === "before") { assert.equal(lease.reused, false); tabId = lease.tabId; }
        else { assert.equal(lease.reused, true, "The retained manual tab must be reused before user submission"); assert.equal(lease.tabId, tabId); }
        record("ACTION_REQUIRED", { phase, instruction: "Copy the DEV Launcher prompt, paste it into this ChatGPT tab, select Codex Zero Risk2, send, and confirm Sent if requested." });
        if (config.zeroRiskRequireSentConfirmation) {
          await waitForLauncherManualSent(descriptorPath, owner, { abortSignal: controller.signal });
          broker.confirmSafeTurnSent(token, nonce);
        }
        const terminalAbort = new AbortController();
        const terminalSignal = AbortSignal.any([controller.signal, terminalAbort.signal]);
        const terminal = waitForLauncherManualTerminal(descriptorPath, owner, { abortSignal: terminalSignal })
          .then(result => { throw new Error(`Manual tab ended: ${result.status}`); })
          .catch(error => terminalAbort.signal.aborted ? new Promise<never>(() => {}) : Promise.reject(error));
        try {
          await Promise.race([broker.waitForSafeStart(token, controller.signal), terminal]);
          await markLauncherManualTurnStarted(descriptorPath, owner);
          record("manual-started", { phase });
          const answer = await Promise.race([broker.waitForSafeCompletion(token, controller.signal), terminal]);
          await endLauncherManualTurn(descriptorPath, { ...owner, status: "completed", retain: true });
          record("manual-settled", { phase, tabId });
          return answer;
        } finally { terminalAbort.abort(); }
      } catch (error) {
        if (started) await endLauncherManualTurn(descriptorPath, { ...owner, status: "failed" }).catch(() => {});
        throw error;
      }
    })();
    void browser.catch(() => {});
    const source = new ChatGptTurnSession({ mode: "tools", token: Promise.resolve(token), browser,
      physicalSettlement: browser.then(() => undefined, () => undefined), externalProgress: progress,
      trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), conversationKey,
      manualControl: { surfaceNonce: nonce }, cancel: reason => controller.abort(reason) }, owner.traceId);
    const calls = await Promise.race([broker.nextToolBatch(token, controller.signal),
      browser.then(() => { throw new Error("Manual response ended before its expected MCP call"); })]);
    assert.equal(calls.length, 1); assert.equal(calls[0]!.wireName, "exec_command");
    assert.ok(String(calls[0]!.arguments?.cmd).includes(marker));
    source.setOutstanding(calls); progress.recordToolBatch(calls.length);
    const receipt = { simulated: true, side_effects_performed: false, marker, callId: calls[0]!.callId };
    record("tool-receipt", { phase, ...receipt });
    const compact: CodexParsedRequest = { ...parsed, _compactionRequest: true, _compactionOutput: "message",
      context: { messages: [
        { role: "toolResult", toolCallId: calls[0]!.callId, toolName: "exec_command", content: JSON.stringify(receipt), isError: false, timestamp: Date.now() },
        { role: "user", content: COMPACT_PROMPT, timestamp: Date.now() },
      ] } };
    if (phase === "before") {
      const summary = await settleActiveZeroRiskCompactionSource(compact, source, broker, controller.signal);
      assert.ok(typeof summary === "string" && summary.trim(), "The bound Zero Risk completion must carry the active checkpoint");
      summarySha256 = fingerprint(summary);
      record("active-checkpoint", { summarySha256, summaryChars: summary.length });
    } else {
      // Put the normal result on the wire first, then request compaction with no outstanding call.
      // If the response ends without another tool, existing code must return no checkpoint.
      broker.completeTool(token, calls[0]!.callId, { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt });
      source.markResultDelivered(calls[0]!.callId); progress.recordToolResult();
      compact.context.messages = compact.context.messages.filter(message => message.role !== "toolResult");
      const unchangedSummary = summarySha256;
      const summary = await settleActiveZeroRiskCompactionSource(compact, source, broker, controller.signal);
      assert.equal(summary, undefined, "No delivered control means no history replacement");
      assert.equal(summarySha256, unchangedSummary);
      record("ended-before-control", { result: "manual_handoff_required", historyReplaced: false, launcherStarts });
      await assert.rejects(settleActiveZeroRiskCompactionSource(compact, source, broker, controller.signal), /no manual MCP tool boundary/);
      assert.equal(launcherStarts, 2);
      record("completed-response-stop", { result: "manual_handoff_required", extraMessages: 0, extraPages: 0, extraPromptCopies: 0 });
    }
    await browser;
    broker.revoke(token);
    await assert.rejects(callTurnBroker(broker.socketPath, { method: "claim", token }), { code: "codex_tool_operation_retired" });
    record("old-capability-rejected", { phase, fingerprint: fingerprint(token) });
  }
  try {
    await work("before"); await work("after");
    evidence.status = "passed"; record("passed");
  } catch (error) {
    evidence.status = "failed"; evidence.error = error instanceof Error ? error.message : String(error);
    record("failed", { error: evidence.error }); throw error;
  } finally {
    clearTimeout(timer); controller.abort();
    for (const token of tokens) broker.revoke(token);
    await releaseLauncherRetainedConversation(descriptorPath, conversationKey).catch(error => {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
    });
    save();
  }
}

try { for (let index = 1; index <= 2; index++) await probe(index); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await transport.close(); save(); console.log(`Evidence: ${join(outputDir, "evidence.json")}`); }
