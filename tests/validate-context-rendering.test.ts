import { expect, test } from "bun:test";
import { createLiveFixture, createLiveFixtureInput, createLiveRequestBody, extractLiveCompletion, inspectLiveResult, inspectLiveWebPayload, LIVE_CASES, livePairSchedule,
  createLiveDomObservation, inspectLiveDomObservations, installLiveDomObserver, prepareObservedBrowserHelper, readLiveEditorDom, readLiveSubmittedDom, type LiveDomObservation } from "../scripts/validate-context-rendering";
import { executeLiveRequestPipeline, extractLiveCompactionSummary } from "../scripts/validate-context-rendering";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { createContextSnapshot } from "../src/adapters/chatgpt-web/context-snapshot";
import { planContextDelivery } from "../src/adapters/chatgpt-web/context-planner";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { decodeWebContextPayload } from "../src/adapters/chatgpt-web/context-renderer";
import { ChatGptThreadEnvironmentStore, type ChatGptEnvironmentResolutionDiagnostics } from "../src/adapters/chatgpt-web/thread-environment";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity, extractChatGptTurnUserRevision, hasCurrentChatGptEnvironmentContext } from "../src/adapters/chatgpt-web/environment";
import { chromium, type Page } from "playwright-core";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import type { ContinuityLease } from "../src/adapters/chatgpt-web/continuity-contract";
import { continuityDigest } from "../src/adapters/chatgpt-web/continuity-binding";
import { createChatGptWebAdapter, chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { chatGptTurnSessions, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { captureCompactionSource, prepareFreshCompactionSource, type CompactionSourceCoverage } from "../src/adapters/chatgpt-web/compaction-context";
import { canonicalizeCompactionHandoff, LATEST_USER_PROMPT_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { defaultConfig } from "../src/config";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { compactRequest } from "../src/server";
import { retainedTaskFixture } from "./helpers/retained-compaction-fixture";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function sourceWiringHarness(run: (fixture: {
  config: ReturnType<typeof defaultConfig>; broker: TurnBroker;
  factory: NonNullable<Parameters<typeof compactRequest>[2]>;
  configureProvider: (provider: CodexProviderConfig) => CodexProviderConfig;
  store: ReturnType<typeof retainedTaskFixture>["store"];
  source: () => { parsed: CodexParsedRequest; provider: CodexProviderConfig };
  setBrowser: (implementation: (turn: BrowserTurn) => Promise<string>) => void;
}) => Promise<void>) {
  const f = retainedTaskFixture();
  const config = { ...f.config, browserHostDescriptorPath: f.provider.chatgptWeb!.browserHostDescriptorPath,
    brokerSocketPath: f.provider.chatgptWeb!.brokerSocketPath!, extraHighAvailable: true, proAvailable: true };
  const broker = TurnBroker.forSocket(config.brokerSocketPath); await broker.listen();
  const worker = ChatGptBrowserWorker.forProvider(f.provider);
  const originalRun = worker.run;
  const configureProvider = (provider: CodexProviderConfig): CodexProviderConfig => ({ ...provider, baseUrl: f.provider.baseUrl,
    chatgptWeb: { ...f.provider.chatgptWeb, toolAuthorityMode: provider.chatgptWeb?.toolAuthorityMode,
      extraHighAvailable: true, proAvailable: true, threadEnvironmentStatePath: join(f.root, "environments.json") } });
  let accepted: { parsed: CodexParsedRequest; provider: CodexProviderConfig } | undefined;
  const factory: NonNullable<Parameters<typeof compactRequest>[2]> = provider => {
    const adapter = createChatGptWebAdapter(provider, { broker });
    const original = adapter.runTurn!;
    return { ...adapter, runTurn: (...parameters) => { accepted = { parsed: parameters[0], provider }; return original.apply(adapter, parameters); } };
  };
  try { await run({ config, broker, factory, configureProvider, store: f.store, source: () => accepted!,
    setBrowser: implementation => { worker.run = async turn => {
      const claim = turn.continuity!, old = f.pages.get(turn.conversationKey!);
      if (claim.expected) expect(old).toEqual({ continuity: claim.expected, state: "ready" });
      const lease: ContinuityLease = { owner: claim.owner, traceId: turn.traceId,
        leaseId: old?.continuity.leaseId ?? "1".repeat(32), ...(claim.recovery ? { recovery: claim.recovery } : {}) };
      f.pages.set(turn.conversationKey!, { continuity: lease, state: "running" });
      turn.onContinuityLease!(lease);
      try {
        const answer = await implementation(turn);
        if (!turn.compaction) turn.onTextDelta(answer);
        return answer;
      } finally { f.pages.set(turn.conversationKey!, { continuity: lease, state: "ready" }); }
    }; } }); }
  finally { worker.run = originalRun; await f.dispose(); }
}

test("compaction pipeline refuses a primer without original submission evidence", async () => {
  await sourceWiringHarness(async ({ config, factory, configureProvider, source, setBrowser }) => {
    let starts = 0, preparations = 0; const stages: string[] = [];
    let coverage: CompactionSourceCoverage | undefined;
    setBrowser(async turn => { starts++; const prepared = await turn.prepare();
      if (prepared.contextPlan) await turn.onContextPlanSelected?.(prepared.contextPlan.planId);
      preparations++;
      const accepted = source(), key = `${chatGptWebExecutionNamespace(accepted.provider)}:${chatGptTurnExecutionKey(accepted.parsed)}`;
      coverage = chatGptTurnSessions.find(key)!.runtime.compactionSourceCoverage!;
      prepared.release(); return "Source was not sent."; });
    const body = createLiveRequestBody(createLiveFixture("mcp-partial"), { purpose: "compaction", model: "chatgpt-web/gpt-6-sol-instant",
      cwd: process.cwd(), threadId: "missing_send_thread", turnId: "missing_send_turn" });
    await expect(executeLiveRequestPipeline(body, "compaction", config, factory, { signal: new AbortController().signal, configureProvider,
      onStage: stage => stages.push(stage) })).rejects.toThrow();
    expect(preparations).toBe(1);
    expect(coverage!.latest()?.delivered).toBeFalse();
    expect(starts).toBe(1); expect(stages).toEqual(["primer"]);
  });
});

test("compaction pipeline reuses real accepted source and settlement for every fixed fixture", async () => {
  for (const name of LIVE_CASES) await sourceWiringHarness(async ({ config, broker, factory, configureProvider, store, source, setBrowser }) => {
    const fixture = createLiveFixture(name), body = createLiveRequestBody(fixture, { purpose: "compaction", model: "chatgpt-web/gpt-6-sol-instant",
      cwd: process.cwd(), threadId: `source_thread_${name}`, turnId: `source_turn_${name}` });
    const stages: string[] = [], reports: Record<string, any>[] = [];
    const summary = `~~~\n<live_validation_result>${JSON.stringify(fixture.expected)}</live_validation_result>\n~~~`;
    let starts = 0;
    setBrowser(async turn => {
      starts++; const prepared = await turn.prepare();
      if (!turn.compaction) {
        if (prepared.contextPlan) await turn.onContextPlanSelected?.(prepared.contextPlan.planId);
        const accepted = source(), key = `${chatGptWebExecutionNamespace(accepted.provider)}:${chatGptTurnExecutionKey(accepted.parsed)}`;
        const coverage = chatGptTurnSessions.find(key)!.runtime.compactionSourceCoverage!;
        expect(coverage.latest()?.delivered).toBe(false);
        expect(() => captureCompactionSource(accepted.parsed, coverage)).toThrow("pending");
        await turn.onSendActivated?.();
        await turn.onSubmitted?.();
        expect(coverage.latest()?.delivered).toBe(true);
        expect(captureCompactionSource(accepted.parsed, coverage).targets.length).toBeGreaterThan(0);
        prepared.release(); return "Source accepted and settled.";
      }
      expect(reports.at(-1)?.source).toMatchObject({ delivered: true, physicallySettled: true });
      expect(turn.requireRetainedConversation).toBe(true);
      await turn.onSendActivated?.();
      await turn.onSubmitted?.();
      const token = prepared.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
      const handoffId = prepared.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
      prepared.release();
      await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary });
      return "Checkpoint handed off.";
    });
    const response = await executeLiveRequestPipeline(body, "compaction", config, factory, { signal: new AbortController().signal,
      configureProvider,
      onStage: stage => stages.push(stage), onPrimer: report => {
        reports.push(report);
        if (!report.source) return;
        const accepted = source(), record = store.get(continuityDigest(extractChatGptTurnIdentity(accepted.parsed).threadId!))!;
        const sourceWork = record.works[record.currentWorkId!]!;
        expect(record.legacyUnproven).toBeFalse();
        expect(sourceWork.state).toBe("completed");
        expect(sourceWork.attempts.at(-1)!.stage).toBe("completed");
        expect(record.contextCoverage!.some(entry => entry.metadata.delivered)).toBeTrue();
      } });
    const envelope = await response.json();
    expect(envelope.error).toBeUndefined();
    expect(response.status).toBe(200);
    const checkpoint = extractLiveCompletion(envelope, "compaction");
    expect(checkpoint).toBe(canonicalizeCompactionHandoff(source().parsed, summary));
    expect(inspectLiveResult(fixture, checkpoint).passed).toBe(false); // The bound task itself contains literal result tags.
    expect(extractLiveCompactionSummary(checkpoint, fixture.task)).toBe(`${summary}\n`);
    expect(inspectLiveResult(fixture, extractLiveCompactionSummary(checkpoint, fixture.task))).toMatchObject({ passed: true });
    expect(starts).toBe(2); expect(stages).toEqual(["primer", "compaction"]);
    expect(reports.at(-1)?.source?.coverageRecords).toBe(1);
    const committed = store.get(continuityDigest(extractChatGptTurnIdentity(source().parsed).threadId!))!;
    expect(committed.historyRevision).toBe(1);
    expect(Object.keys(committed.checkpoints)).toHaveLength(1);
  });
});

test("compaction model summary extraction requires the exact production appendix and keeps the strict oracle", () => {
  const fixture = createLiveFixture("mcp-partial"), body = createLiveRequestBody(fixture, { purpose: "compaction",
    model: "chatgpt-web/gpt-6-sol-instant", cwd: process.cwd(), threadId: "appendix_thread", turnId: "appendix_turn" });
  const parsed = parseRequest({ ...body, input: [...body.input, { type: "compaction_trigger" }] });
  const summary = `~~~\n<live_validation_result>${JSON.stringify(fixture.expected)}</live_validation_result>\n~~~`;
  const checkpoint = canonicalizeCompactionHandoff(parsed, summary);
  expect(inspectLiveResult(fixture, extractLiveCompactionSummary(checkpoint, fixture.task)).passed).toBe(true);
  const boundary = `\n${LATEST_USER_PROMPT_MARKER}\n`;
  for (const invalid of [summary, `${checkpoint}\n`, `${summary}${boundary}{`,
    `${summary}${boundary}${JSON.stringify("another task")}`, `${checkpoint}${boundary}${JSON.stringify(fixture.task)}`]) {
    expect(() => extractLiveCompactionSummary(invalid, fixture.task)).toThrow();
  }
  const duplicate = canonicalizeCompactionHandoff(parsed, `${summary}\n${summary}`);
  expect(inspectLiveResult(fixture, extractLiveCompactionSummary(duplicate, fixture.task)).passed).toBe(false);
  const forged = canonicalizeCompactionHandoff(parsed, summary.replace(fixture.expected.fragments[0]!.text, "forged source"));
  expect(inspectLiveResult(fixture, extractLiveCompactionSummary(forged, fixture.task)).passed).toBe(false);
});

test("live compaction rejects changed source while an unknown thread uses its current readable input", async () => {
  await sourceWiringHarness(async ({ config, broker, factory, configureProvider, source, setBrowser }) => {
    const body = createLiveRequestBody(createLiveFixture("mcp-partial"), { purpose: "compaction", model: "chatgpt-web/gpt-6-sol-instant",
      cwd: process.cwd(), threadId: "negative_source_thread", turnId: "negative_source_turn" });
    let starts = 0, sends = 0;
    setBrowser(async turn => { starts++; const prepared = await turn.prepare();
      if (prepared.contextPlan) await turn.onContextPlanSelected?.(prepared.contextPlan.planId);
      await turn.onSendActivated?.();
      await turn.onSubmitted?.(); sends++;
      if (turn.compaction) {
        const token = prepared.text.match(/turn_token (control_[a-f0-9]{32})/)![1]!;
        const handoffId = prepared.text.match(/handoff_id (handoff_[a-f0-9]{32})/)![1]!;
        prepared.release();
        await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId,
          summary: "The current request contains the source and the original tool result." });
        return "Checkpoint handed off.";
      }
      prepared.release(); return "Source accepted."; });
    const response = await executeLiveRequestPipeline(body, "ordinary", config, factory, { signal: new AbortController().signal, configureProvider });
    const envelope = await response.json();
    expect(envelope).toMatchObject({ status: "completed" });
    const accepted = source(), session = chatGptTurnSessions.find(`${chatGptWebExecutionNamespace(accepted.provider)}:${chatGptTurnExecutionKey(accepted.parsed)}`)!;
    await session.physicalSettlement;
    const coverage = session.runtime.compactionSourceCoverage!;
    const changed = structuredClone(accepted.parsed);
    const textSource = changed.context.messages.find(message => message.role === "toolResult")!;
    textSource.content = `${String(textSource.content)} changed source`;
    await expect(prepareFreshCompactionSource(changed, broker, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      { historyRevision: 0, ownerGeneration: "negative-source", traceId: "negative-source", sourceCoverage: coverage })).rejects.toMatchObject({ code: "continuity_source_unproven" });
    const wrongThread = structuredClone(body), metadata = JSON.parse(wrongThread.client_metadata["x-codex-turn-metadata"]);
    metadata.thread_id = "other_source_thread"; wrongThread.prompt_cache_key = metadata.thread_id;
    wrongThread.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    expect(starts).toBe(1); expect(sends).toBe(1);
    const recovered = await compactRequest(new Request("http://local/v1/responses/compact", { method: "POST", headers: {
      "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify(metadata) }, body: JSON.stringify(wrongThread) }), config, provider => factory(configureProvider(provider)));
    const recoveredEnvelope = await recovered.json();
    expect(recovered.status).toBe(200); expect(recoveredEnvelope.error).toBeUndefined();
    expect(extractLiveCompletion(recoveredEnvelope, "compaction")).toContain("The current request contains the source");
    expect(starts).toBe(2); expect(sends).toBe(2);
  });
});

test("DOM observations retain only hashes and reject foreign run, trace, prompt and duplicate evidence", () => {
  const secret = "private test text \n\t中文  ";
  const row = createLiveDomObservation("run_a", "trace_a", "editor", secret, { text: secret, reason: "readable" });
  const prompt = { traceId: "trace_a", sha256: createHash("sha256").update(secret).digest("hex"), chars: secret.length, utf8Bytes: Buffer.byteLength(secret) };
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(row.expected?.utf8Bytes).toBe(Buffer.byteLength(secret));
  expect(inspectLiveDomObservations([row], "run_a", [prompt]).editorExact).toBe(true);
  expect(inspectLiveDomObservations([row], "run_b", [prompt]).editorExact).toBeNull();
  expect(inspectLiveDomObservations([row], "run_a", [{ ...prompt, traceId: "trace_b" }]).editorExact).toBeNull();
  expect(inspectLiveDomObservations([row], "run_a", [{ ...prompt, sha256: "different" }]).editorExact).toBeNull();
  expect(inspectLiveDomObservations([row, row], "run_a", [prompt]).editorExact).toBeNull();
  expect(inspectLiveDomObservations([row], "run_a", [prompt, prompt]).editorExact).toBeNull();
  expect(inspectLiveDomObservations([{ ...row, exact: false }], "run_a", [prompt]).editorExact).toBeNull();
  const changed = createLiveDomObservation("run_a", "trace_a", "editor", secret, { text: secret.trim(), reason: "readable" });
  expect(inspectLiveDomObservations([changed], "run_a", [prompt]).editorExact).toBe(false);
  expect(inspectLiveDomObservations([createLiveDomObservation("run_a", "trace_a", "submitted", secret,
    { text: null, reason: "missing_user_identity" })], "run_a", [prompt]).submittedExact).toBeNull();
});

test("private observer helper builds and loads the original helper entry without browser operations", async () => {
  const output = mkdtempSync(join(tmpdir(), "dom-observer-build-test-"));
  try {
    // The generated helper needs project dependencies when it runs outside the repository.
    symlinkSync(resolve(import.meta.dir, "../node_modules"), join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const helper = await prepareObservedBrowserHelper(output, "fixture_run");
    expect(existsSync(helper.helper)).toBe(true);
    expect(readFileSync(join(output, "dom-observer-entry.ts"), "utf8")).toContain("browser-helper-main.ts");
    const child = Bun.spawn([process.execPath, "run", helper.helper], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.end();
    const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(errors).toBe("");
    expect(existsSync(helper.observations)).toBe(false);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 15_000);

test("original send return and submission notification do not wait for an unfinished DOM observation", async () => {
  let completeReading!: (value: { text: null; reason: string }) => void;
  const reading = new Promise(resolve => { completeReading = resolve; });
  let returnedFromSend!: () => void;
  const returned = new Promise<void>(resolve => { returnedFromSend = resolve; });
  let notified = false;
  class TimingWorker {
    async assertPromptAttached() {}
    async sendAttachedPrompt(_page: unknown, baseline: { onSubmitted: () => void }) { baseline.onSubmitted(); return "original_send_return"; }
    async run(turn: { traceId: string }) {
      const result = await this.sendAttachedPrompt({ evaluate: () => reading }, { onSubmitted: () => { notified = true; } });
      returnedFromSend(); return result;
    }
  }
  const rows: LiveDomObservation[] = [];
  const restore = installLiveDomObserver(TimingWorker.prototype, "timing_run", row => rows.push(row));
  try {
    const result = new TimingWorker().run({ traceId: "timing_trace" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([returned, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("original send waited for observation")), 100);
    })]); } finally { clearTimeout(timer); }
    expect(notified).toBe(true);
    expect(rows).toHaveLength(0);
    completeReading({ text: null, reason: "fixture_unreadable" });
    expect(await result).toBe("original_send_return");
    expect(rows[0]!.exact).toBeNull();
  } finally { completeReading({ text: null, reason: "fixture_unreadable" }); restore(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("original assert plus observer reads real DOM strictly and preserves product returns", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const rows: LiveDomObservation[] = [];
  class FixtureWorker {
    activeComposer(page: Page) { return page.locator("#editor"); }
    attachedPromptText = (ChatGptBrowserWorker.prototype as any).attachedPromptText;
    promptTextEquivalent = (ChatGptBrowserWorker.prototype as any).promptTextEquivalent;
    promptCodeUnitEquivalent = (ChatGptBrowserWorker.prototype as any).promptCodeUnitEquivalent;
    async assertPromptAttached(page: Page, prompt: string) { await (ChatGptBrowserWorker.prototype as any).assertPromptAttached.call(this, page, prompt); }
    async sendAttachedPrompt(_page: Page, _baseline: unknown) { return "original_product_return"; }
    async run(turn: { traceId: string; page: Page; prompt: string; identity?: string }) {
      await this.assertPromptAttached(turn.page, turn.prompt);
      // This fixture keeps a stable editor before its simulated send; production has its own stages.
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.sendAttachedPrompt(turn.page, { acceptedUserIdentity: turn.identity, submittedText: turn.prompt });
    }
  }
  const restore = installLiveDomObserver(FixtureWorker.prototype, "fixture_run", row => rows.push(row));
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="editor" contenteditable="true" style="white-space:pre"></div><section data-turn-key="accepted"><div data-user-message-bubble><div id="content" data-search-result-target style="white-space:pre"></div></div></section>');
    const prompt = "alpha  beta\n\t中文🙂 é  \n\n";
    const setText = async (editor: string, submitted: string) => {
      await page.locator("#editor").evaluate((element, text) => { element.textContent = text; }, editor);
      await page.locator("#content").evaluate((element, text) => { element.textContent = text; }, submitted);
    };
    await setText(prompt, prompt);
    const worker = new FixtureWorker();
    expect(await worker.run({ traceId: "fixture_trace", page, prompt, identity: "group:user:accepted" })).toBe("original_product_return");
    expect(rows.map(row => row.exact)).toEqual([true, true]);
    expect(JSON.stringify(rows)).not.toContain(prompt);
    const expected = { traceId: "fixture_trace", sha256: createHash("sha256").update(prompt).digest("hex"), chars: prompt.length, utf8Bytes: Buffer.byteLength(prompt) };
    expect(inspectLiveDomObservations(rows, "fixture_run", [expected])).toMatchObject({ editorExact: true, submittedExact: true });
    rows.length = 0;
    // The production predicate permits this NBSP representation; strict observation must fail.
    await setText(prompt.replace("  ", "\u00a0\u00a0"), prompt.trimEnd());
    expect(await worker.run({ traceId: "fixture_trace", page, prompt, identity: "group:user:accepted" })).toBe("original_product_return");
    expect(rows.map(row => row.exact)).toEqual([false, false]);
    rows.length = 0;
    await setText(prompt, prompt);
    expect(await worker.run({ traceId: "fixture_trace", page, prompt })).toBe("original_product_return");
    expect(rows[1]!.exact).toBeNull();
    expect(rows[1]!.reason).toBe("missing_user_identity");
    expect((await page.evaluate(readLiveSubmittedDom, "unsupported")).text).toBeNull();
    await page.locator("#content").evaluate(element => { element.parentElement!.appendChild(element.cloneNode(true)); });
    expect((await page.evaluate(readLiveSubmittedDom, "group:user:accepted")).text).toBeNull();
    await page.locator("#editor").evaluate(element => { element.innerHTML = "<span>a</span><span>b</span>"; });
    const inline = await page.locator("#editor").evaluate(readLiveEditorDom);
    expect(inline.text).toBe("ab");
    expect(createLiveDomObservation("fixture_run", "fixture_trace", "editor", "a\nb", inline).exact).toBe(false);
    for (const html of ['<span> a<br>b  </span>', '<p> leading </p><p><br></p><p> trailing  </p>']) {
      await page.locator("#editor").evaluate((element, value) => { element.innerHTML = value; }, html);
      expect((await page.locator("#editor").evaluate(readLiveEditorDom)).text).toBe(await page.locator("#editor").innerText());
    }
    await page.locator("#editor").evaluate(element => {
      element.innerHTML = '<span data-id="plugin:fixture" data-keyword="Fixture Connector" contenteditable="false">Fixture Connector</span><span> source  </span>';
    });
    expect((await page.locator("#editor").evaluate(readLiveEditorDom)).text).toBe(" source  ");
    await page.locator("#editor").evaluate(element => {
      element.innerHTML = '<span>source</span><span data-id="plugin:fixture" data-keyword="Fixture Connector" contenteditable="false">Fixture Connector</span>';
    });
    expect((await page.locator("#editor").evaluate(readLiveEditorDom)).text).toBeNull();
    // A failed observer still leaves the original product result untouched.
    restore();
    await page.locator("#content").nth(1).evaluate(element => element.remove());
    await setText(prompt, prompt);
    const restoreThrowing = installLiveDomObserver(FixtureWorker.prototype, "fixture_run", () => { throw new Error("fixture observer failed"); });
    try { expect(await worker.run({ traceId: "fixture_trace", page, prompt })).toBe("original_product_return"); }
    finally { restoreThrowing(); }
  } finally { restore(); await browser.close(); }
}, 20_000);

test("actual live request helper resolves native DEV environment and instruction for ordinary and explicit compaction", () => {
  const cwd = resolve(tmpdir(), "context-rendering-fixture", "a&b<c>");
  for (const name of LIVE_CASES) for (const purpose of ["ordinary", "compaction"] as const) {
    const fixture = createLiveFixture(name), threadId = `dev_thread_${name}_${purpose}`, turnId = `dev_turn_${name}_${purpose}`;
    const body = createLiveRequestBody(fixture, { purpose, model: "chatgpt-web/gpt-6-sol-instant", cwd, threadId, turnId });
    const messages = body.input.filter(item => item.type === "message");
    expect(messages.every(item => typeof item.id === "string" && item.id.length > 0)).toBe(true);
    expect(new Set(messages.map(item => item.id)).size).toBe(messages.length);
    expect(messages.every(item => (item.internal_chat_message_metadata_passthrough as { turn_id: string }).turn_id === turnId)).toBe(true);
    expect(JSON.parse(body.client_metadata["x-codex-turn-metadata"])).toEqual({ thread_id: threadId, turn_id: turnId,
      request_kind: "turn", sandbox: "none", workspaces: { [cwd]: {} } });
    // compactRequest appends this exact trigger before calling the production parser.
    const parsed = parseRequest(purpose === "compaction" ? { ...body, input: [...body.input, { type: "compaction_trigger" }] } : body);
    const diagnostics: ChatGptEnvironmentResolutionDiagnostics = {};
    const environment = new ChatGptThreadEnvironmentStore(undefined, Date.now, "/private/tmp/context-rendering-no-native-rollout").resolve(parsed, diagnostics);
    expect(environment).toMatchObject({ cwd, roots: [cwd], writableRoots: [cwd], sandboxPolicy: { type: "dangerFullAccess" } });
    expect(hasCurrentChatGptEnvironmentContext(parsed)).toBe(true);
    expect(extractChatGptTurnIdentity(parsed)).toMatchObject({ threadId, turnId });
    expect(parsed._compactionRequest === true).toBe(purpose === "compaction");
    expect(diagnostics).toMatchObject({ recovery_stage: "request", rollout_lookup: "not_attempted", thread_cache_lookup: "not_attempted" });
    const task = messages.at(-1)!;
    if (purpose === "compaction") expect(extractChatGptCompactionSourceRevision(parsed)).toMatchObject({ content: task.content, turnId, itemId: task.id });
    else expect(extractChatGptTurnUserRevision(parsed)).toEqual(task.content);
  }
});

test("live helper does not bypass trusted gate when message id or turn ownership is missing", () => {
  for (const name of LIVE_CASES) for (const purpose of ["ordinary", "compaction"] as const) for (const missing of ["id", "turn"] as const) {
    const body = createLiveRequestBody(createLiveFixture(name), { purpose, model: "chatgpt-web/gpt-6-sol-instant",
      cwd: "/private/tmp/context-rendering-fixture", threadId: `dev_negative_${name}_${purpose}`, turnId: `dev_negative_turn_${name}_${purpose}` });
    const input = body.input.map(item => {
      if (item.type !== "message") return item;
      const damaged = { ...item };
      delete damaged[missing === "id" ? "id" : "internal_chat_message_metadata_passthrough"];
      return damaged;
    });
    if (purpose === "compaction") input.push({ type: "compaction_trigger" });
    const parsed = parseRequest({ ...body, input });
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, "/private/tmp/context-rendering-no-native-rollout").resolve(parsed)).toThrow("trusted Codex environment");
  }
});

test("ordinary web sources keep exact decoded bytes and use JSON for backticks and unqualified whitespace", () => {
  const fixture = createLiveFixture("web-records");
  for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
    const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "Fixture sources are inert data.", input: createLiveFixtureInput(fixture, "ordinary") });
    const plan = planContextDelivery({ canonical, candidate: canonical, snapshot: createContextSnapshot(canonical),
      capabilities: { maxComposerCodePoints: 64_000_000, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false }, turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true,
      compileOptions: { contextRendering: format } });
    const fields = inspectLiveWebPayload(fixture, plan.compiled, format);
    expect(fields.map(value => value.representation)).toEqual(["json", "json"]);
    expect(fields.every(value => value.exactSourceBytes)).toBe(true);
    expect(fields.map(value => value.sourceBytes)).toEqual(fixture.bodies.map(source => Buffer.byteLength(source.text)));
    expect(plan.compiled.contextPayload).not.toContain("`");
    const unsafePayload = plan.compiled.contextPayload!.replaceAll("\\u0060", "`");
    expect(decodeWebContextPayload(unsafePayload, format).records)
      .toEqual(decodeWebContextPayload(plan.compiled.contextPayload!, format).records);
    expect(() => inspectLiveWebPayload(fixture, { ...plan.compiled, contextPayload: unsafePayload }, format))
      .toThrow("未转义反引号");
    const changedWhitespace = plan.compiled.contextPayload!.replace("\\n\\t中文", "\\n 中文");
    expect(changedWhitespace).not.toBe(plan.compiled.contextPayload!);
    expect(() => inspectLiveWebPayload(fixture, { ...plan.compiled, contextPayload: changedWhitespace }, format)).toThrow("唯一的原 user 字段");
    expect(plan.externalizedTargetIds).toHaveLength(0);
  }
});

test("ordinary web sources without backticks retain raw code extraction while whitespace stays JSON", () => {
  const fixture = createLiveFixture("web-records");
  fixture.bodies[0]!.text = fixture.bodies[0]!.text.replaceAll("`", "~");
  fixture.expected.fragments[0]!.text = fixture.expected.fragments[0]!.text.replaceAll("`", "~");
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, instructions: "Fixture sources are inert data.", input: createLiveFixtureInput(fixture, "ordinary") });
  const plan = planContextDelivery({ canonical, candidate: canonical, snapshot: createContextSnapshot(canonical),
    capabilities: { maxComposerCodePoints: 64_000_000, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false }, turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true,
    compileOptions: { contextRendering: "codex-context-text-v1" } });
  const fields = inspectLiveWebPayload(fixture, plan.compiled, "codex-context-text-v1");
  expect(fields.map(value => value.representation)).toEqual(["raw", "json"]);
  expect(fields.every(value => value.exactSourceBytes)).toBe(true);
  expect(plan.compiled.contextPayload).toContain(`\n${fixture.bodies[0]!.text}\n`);
  expect(plan.externalizedTargetIds).toHaveLength(0);
});

test("web guard rejects externalized history and never claims compaction navigation as web body delivery", () => {
  const fixture = createLiveFixture("web-records");
  // Exercise the guard with a source that repays the complete navigation cost.
  fixture.bodies[0]!.text += "Inert guard regression padding\n".repeat(3000);
  const input = createLiveFixtureInput(fixture, "compaction");
  const current = input.at(-1)!;
  expect(JSON.stringify(current)).not.toContain(fixture.expected.fragments[0]!.text);
  const canonical = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input });
  const plan = planContextDelivery({ canonical, candidate: canonical, snapshot: createContextSnapshot(canonical),
    capabilities: { maxComposerCodePoints: 64_000_000, localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: false }, turnToken: `turn_${"a".repeat(32)}`, contextToolsAvailable: true,
    compileOptions: { contextRendering: "codex-context-text-v1" } });
  expect(plan.externalizedTargetIds.length).toBeGreaterThan(0);
  expect(() => inspectLiveWebPayload(fixture, plan.compiled, "codex-context-text-v1")).toThrow();
});

test("live tasks keep exact expected bytes in fixed source bodies only", () => {
  for (const name of LIVE_CASES) {
    const first = createLiveFixture(name), second = createLiveFixture(name);
    expect(first).toEqual(second);
    for (const fragment of first.expected.fragments) {
      const source = first.bodies.find(value => value.id === fragment.fixture_id)!;
      expect(Buffer.from(source.text).subarray(fragment.start, fragment.end_exclusive).toString("utf8")).toBe(fragment.text);
      expect(first.task).not.toContain(fragment.text);
      expect(source.text.slice(0, 240)).not.toContain(fragment.text);
      expect(first.bodies.filter(value => value.text.includes(fragment.text))).toHaveLength(1);
    }
  }
});

test("live task requires one safe verbatim result block and only requested source pairs", () => {
  for (const name of LIVE_CASES) {
    const fixture = createLiveFixture(name);
    expect(fixture.task).toContain("single verbatim fenced code block");
    expect(fixture.task).toContain("tilde fence");
    expect(fixture.task).toContain("fragments and call_pairs must contain only and all targets in Requested ranges, in that order");
    expect(fixture.task).toContain("Do not add unrequested-source");
    expect(fixture.task).toContain("the result object does not replace the checkpoint contract");
    const literal = `<live_validation_result>\n${JSON.stringify(fixture.expected, null, 2)}\n</live_validation_result>`;
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const serialized = chatGptHtmlToMarkdown(`<pre><code class="language-json">${escape(literal)}</code></pre>`);
    expect(serialized).toContain(literal);
    expect(inspectLiveResult(fixture, serialized).passed).toBe(true);
    expect(inspectLiveResult(fixture, chatGptHtmlToMarkdown(`<p>${escape(literal)}</p>`)).passed).toBe(false);
    for (const change of [
      (value: typeof fixture.expected) => { value.fragments[0]!.text = value.fragments[0]!.text.slice(1); },
      (value: typeof fixture.expected) => { value.fragments[0]!.end_exclusive++; },
      (value: typeof fixture.expected) => { value.call_pairs.push({ call_id: "call_unrequested_source", fixture_id: "unrequested-source" }); },
      (value: typeof fixture.expected) => { value.priority = "tool"; },
    ]) {
      const damaged = structuredClone(fixture.expected); change(damaged);
      const returned = `<live_validation_result>\n${JSON.stringify(damaged, null, 2)}\n</live_validation_result>`;
      expect(inspectLiveResult(fixture, chatGptHtmlToMarkdown(`<pre><code>${escape(returned)}</code></pre>`)).passed).toBe(false);
    }
  }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("production response DOM and Markdown preserve a complete fenced result in both code layouts", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as { responseDomSnapshot(locator: unknown): Promise<{ markdownSegments: Parameters<ChatGptMarkdownBuffer["observe"]>[0] }> };
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    for (const name of LIVE_CASES) for (const layout of ["pre", "code-card"] as const) {
      const fixture = createLiveFixture(name);
      const literal = `<live_validation_result>\n${JSON.stringify(fixture.expected, null, 2)}\n</live_validation_result>`;
      const code = layout === "pre" ? `<pre><code class="language-json">${escape(literal)}</code></pre>`
        : `<div data-markdown-copy="code-block"><button>Copy</button><div><code class="language-json">${escape(literal)}</code></div></div>`;
      await page.setContent(`<section id="turn" data-turn="assistant"><div data-message-author-role="assistant"><div class="markdown">${code}</div><button data-testid="copy-turn-action-button">Copy</button></div></section>`);
      const snapshot = await worker.responseDomSnapshot(page.locator("#turn"));
      const buffer = new ChatGptMarkdownBuffer(); buffer.observe(snapshot.markdownSegments, 0);
      const returned = buffer.finish().markdown;
      expect(returned).toContain(literal);
      expect(inspectLiveResult(fixture, returned).passed).toBe(true);
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("submitted observer treats target and outer user collapse states as unknown", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage(), expected = "Full source\n\t中文  ";
    const content = '<div id="content" data-search-result-target style="white-space:pre"></div>';
    const set = async (insideBubble = "", outsideBubble = "") => {
      await page.setContent(`<section data-turn-key="accepted"><div data-user-message-bubble>${content}${insideBubble}</div>${outsideBubble}</section>`);
      await page.locator("#content").evaluate((element, text) => { element.textContent = text; }, expected);
    };
    const read = () => page.evaluate(readLiveSubmittedDom, "group:user:accepted");
    await set();
    expect((await read()).text).toBe(expected);
    for (const placement of ["bubble", "group"] as const) for (const control of [
      '<button aria-expanded="false">Show more</button>',
      '<button>显示更多</button>',
      '<div role="button" tabindex="0">Show more</div>',
    ]) {
      await set(placement === "bubble" ? control : "", placement === "group" ? control : "");
      const reading = await read();
      expect(reading.text).toBeNull();
      expect(createLiveDomObservation("fixture_run", "fixture_trace", "submitted", expected, reading).exact).toBeNull();
    }
    for (const attribute of ["aria-expanded", "data-truncated"] as const) {
      await set();
      await page.locator("#content").evaluate((element, name) => { element.setAttribute(name, name === "aria-expanded" ? "false" : "true"); }, attribute);
      expect((await read()).text).toBeNull();
    }
    await set('<button hidden aria-expanded="false">Show more</button><span>显示更多</span>');
    expect((await read()).text).toBe(expected);
    await page.locator("#content").evaluate(element => { element.textContent += "changed"; });
    expect(createLiveDomObservation("fixture_run", "fixture_trace", "submitted", expected, await read()).exact).toBe(false);
    await set('<button aria-expanded="true">Show less</button>');
    expect((await read()).text).toBe(expected);
    await page.locator("#content").evaluate(element => { element.style.display = "none"; });
    expect((await read()).text).toBeNull();
    await set();
    await page.locator("#content").evaluate(element => { element.parentElement!.appendChild(element.cloneNode(true)); });
    expect((await read()).text).toBeNull();
  } finally { await browser.close(); }
}, 20_000);

test("live oracle rejects damaged whitespace, source pairing, range and source priority", () => {
  const fixture = createLiveFixture("web-records");
  const wrap = (value: unknown) => `<live_validation_result>${JSON.stringify(value)}</live_validation_result>`;
  expect(inspectLiveResult(fixture, wrap(fixture.expected)).passed).toBe(true);
  for (const change of [
    (value: typeof fixture.expected) => { value.fragments[1]!.text = value.fragments[1]!.text.trim(); },
    (value: typeof fixture.expected) => { value.fragments[0]!.start++; },
    (value: typeof fixture.expected) => { value.call_pairs.reverse(); },
    (value: typeof fixture.expected) => { value.priority = "tool"; },
  ]) {
    const damaged = structuredClone(fixture.expected); change(damaged);
    expect(inspectLiveResult(fixture, wrap(damaged)).passed).toBe(false);
  }
  expect(inspectLiveResult(fixture, wrap(fixture.expected) + wrap(fixture.expected)).passed).toBe(false);
});

test("live evidence does not confuse retained source text with a newly returned checkpoint", () => {
  const source = "<live_validation_result>source answer must not count</live_validation_result>";
  const output = [
    { type: "message", role: "user", content: [{ type: "input_text", text: source }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nactual checkpoint` }] },
  ];
  expect(extractLiveCompletion({ output }, "compaction")).toBe("actual checkpoint");
  expect(() => extractLiveCompletion({ output: output.slice(0, 1) }, "compaction")).toThrow("唯一");
  expect(() => extractLiveCompletion({ output }, "ordinary")).toThrow("真实最终完成");
  expect(extractLiveCompletion({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "actual answer" }] }], status: "completed", end_turn: true }, "ordinary")).toBe("actual answer");
});

test("every live item has three adjacent format pairs with reversed second-pair order", () => {
  const schedule = livePairSchedule();
  for (const name of LIVE_CASES) for (const mode of ["automatic", "zero-risk"] as const) for (const purpose of ["ordinary", "compaction"] as const) {
    const group = schedule.filter(run => run.case === name && run.mode === mode && run.purpose === purpose);
    expect(group.map(run => run.repeat)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(group.map(run => run.format)).toEqual(["legacy-json", "codex-context-text-v1", "codex-context-text-v1", "legacy-json", "legacy-json", "codex-context-text-v1"]);
  }
});
