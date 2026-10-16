import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("CodeMirror language invalidates the response cache and incomplete code is not delivered", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```python\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => editor.setAttribute("data-language", "text"));
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```text\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => {
      const gap = document.createElement("div");
      gap.style.height = "200px";
      editor.appendChild(gap);
    });
    await expect(observe()).rejects.toThrow("one complete set of code lines");
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("paragraph identity survives file preview movement in both response layouts", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
      const page = await browser.newPage();
      await page.setContent(`<section id="turn"><div data-content-search-unit-key="answer">
        <h4 data-conversation-role="assistant"></h4><div id="answer" ${root}>
        <p>Report saved:</p><p id="file">report.md</p><p id="tail">Done.</p>
      </div></div><button aria-label="Copy"></button></section>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const cache = {};
      const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
      const before = await observe();
      const buffer = new ChatGptMarkdownBuffer(undefined, 0);
      expect(buffer.observe(before.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
      await page.locator("#file").evaluate(file => { file.parentElement!.parentElement!.appendChild(file); });
      const moved = await observe();
      expect(moved.markdownSegments.at(-1).key).toBe(before.markdownSegments.at(-1).key);
      expect(buffer.observe(moved.markdownSegments, 1)).toBe("");
      await page.locator("#answer").evaluate(answer => { answer.innerHTML = answer.innerHTML; });
      buffer.observe((await observe()).markdownSegments, 2);
      expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nDone.");
      await page.locator("#tail").evaluate(tail => { tail.textContent = "A changed answer."; });
      buffer.observe((await observe()).markdownSegments, 3);
      expect(() => buffer.finish()).toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn, cache);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished", "streaming"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      const response = scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>'
        : scenario === "streaming" ? answer.replace('<div class="turn-action-controls"><button>Copy</button></div>', "") : answer;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${response}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (["same-user", "unfinished", "streaming"].includes(scenario)) {
        expect((await result).identity).toBe("group:assistant:submitted");
      } else {
        await expect(result).rejects.toThrow("another user turn");
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a Send acknowledged under a fallback key rebinds only to its exact submitted prompt", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read the current source.\nReturn its exact value.";
    const group = (key: string, text: string) => `<div data-turn-key="${key}">
      <div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div></div>
      <span hidden data-chatgpt-agent-turn-start></span></div>`;
    for (const scenario of ["same-prompt", "changed-prompt", "competing-turn", "old-group-remains"] as const) {
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, group("fallback-turn-0", prompt));
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      let replacement = group("persisted", scenario === "changed-prompt" ? "Another instruction." : prompt);
      if (scenario === "competing-turn") replacement += group("foreign", prompt);
      if (scenario === "old-group-remains") replacement += group("fallback-turn-0", prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "same-prompt") expect((await result).identity).toBe("group:assistant:persisted");
      else if (scenario === "old-group-remains") expect((await result).identity).toBe(binding.identity);
      else await expect(result).rejects.toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

for (const scenario of ["same-assistant", "foreign-assistant", "temporary-same-assistant", "temporary-foreign-assistant", "second-foreign-user", "same-formal-user"] as const) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`fallback recovery preserves message identities: ${scenario}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const prompt = "Read the current source.\nReturn its exact value.";
      const group = (key: string, messageId?: string) => `<div data-turn-key="${key}">
        <div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>
        ${messageId ? `<div data-chatgpt-search-message-ids="${messageId}"><div data-conversation-role="assistant"></div></div>`
          : '<span hidden data-chatgpt-agent-turn-start></span>'}</div>`;
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      const knownAssistant = scenario.includes("assistant");
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, group("fallback-turn-0", knownAssistant ? "accepted-answer" : undefined));
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      let binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      if (scenario.startsWith("temporary-")) {
        await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-1"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
        binding = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
        expect(binding.identity).toBe("group:assistant:fallback-turn-1");
      }
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, group("formal-user", knownAssistant
        ? scenario.endsWith("same-assistant") ? "accepted-answer" : "foreign-answer" : undefined));
      const first = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario.endsWith("foreign-assistant")) {
        await expect(first).rejects.toThrow("another user turn");
      } else {
        const formal = await first;
        expect(formal.identity).toBe("group:assistant:formal-user");
        if (!knownAssistant) {
          // Force a fresh DOM observation for the remounted group. The submitted
          // text is identical even when the replacement belongs to another user.
          await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, group(scenario === "same-formal-user" ? "formal-user" : "foreign-user"));
          const second = worker.reconcileAssistantTurnBinding(page, baseline, formal);
          if (scenario === "same-formal-user") expect((await second).identity).toBe(formal.identity);
          else await expect(second).rejects.toThrow("another user turn");
        }
      }
      await page.close();
    } finally { await browser.close(); }
  }, 15_000);
}

for (const stage of ["acceptance", "initial binding"] as const) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`the submitted native user also constrains ${stage}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const page = await browser.newPage();
      await page.setContent("<main></main>");
      const baseline = await worker.captureSubmissionBaseline(page, "Same prompt");
      baseline.submittedUserMessage = { messageId: "11111111-1111-4111-8111-111111111111" };
      await page.locator("main").evaluate(main => { main.innerHTML = '<div data-turn-key="22222222-2222-4222-8222-222222222222"><div data-user-message-bubble>Same prompt</div><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const result = stage === "acceptance" ? worker.currentSubmissionEvidence(page, baseline)
        : worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      await expect(result).rejects.toThrow("user turn");
    } finally { await browser.close(); }
  }, 15_000);
}

for (const matchingUser of [true, false]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`the physical Send identifies its formal user despite display escaping: match=${matchingUser}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    const observer = new ChatGptSubmissionRejectionObserver();
    try {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const page = await browser.newPage();
      await page.route("https://chatgpt.com/backend-api/f/conversation", route => route.fulfill({
        status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }, body: "{}",
      }));
      await page.setContent('<main></main><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">Prompt</div><button type="button" data-testid="send-button" aria-label="Send prompt">Send</button></form>');
      const messageId = "11111111-1111-4111-8111-111111111111";
      const prompt = 'Read the current source.\\"Keep literal escaping.\\"';
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("button").evaluate((button, id) => button.addEventListener("keydown", async event => {
        if ((event as KeyboardEvent).key !== "Enter") return;
        event.preventDefault();
        await fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ id, author: { role: "user" }, content: { parts: ["Browser serialized text"] } }] }) });
        document.querySelector("main")!.innerHTML = '<button data-testid="stop-button" aria-label="Stop streaming">Stop</button>';
      }), messageId);
      expect(await worker.sendAttachedPrompt(page, baseline, undefined, AbortSignal.timeout(5000),
        undefined, undefined, undefined, undefined, undefined, observer)).toBe("generation_running");
      await page.locator("main").evaluate(main => { main.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      let binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      const key = matchingUser ? messageId : "22222222-2222-4222-8222-222222222222";
      await page.locator("main").evaluate((main, { key, text }) => {
        const group = document.createElement("div"); group.setAttribute("data-turn-key", key);
        group.innerHTML = '<div data-user-message-bubble><div data-search-result-target></div></div><span hidden data-chatgpt-agent-turn-start></span>';
        group.querySelector("[data-search-result-target]")!.textContent = text;
        main.replaceChildren(group);
      }, { key, text: matchingUser ? "The browser renders escaped text differently." : prompt });
      // Same-page observation recovery copies the baseline and must retain the Send association.
      const result = worker.reconcileAssistantTurnBinding(page, { ...baseline, domCache: {} }, binding);
      if (matchingUser) expect((await result).identity).toBe(`group:assistant:${messageId}`);
      else await expect(result).rejects.toThrow("another user turn");
    } finally { observer.dispose(); await browser.close(); }
  }, 15_000);
}

for (const hasUser of [true, false]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`a known assistant cannot be replaced after a formal user was proved: user bubble=${hasUser}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const page = await browser.newPage();
      const prompt = "Read the current source.";
      const group = (key: string, user: boolean, id?: string) => `<div data-turn-key="${key}">
        ${user ? `<div data-user-message-bubble><div data-search-result-target>${prompt}</div></div>` : ""}
        ${id ? `<div data-chatgpt-search-message-ids="${id}"><div data-conversation-role="assistant"></div></div>`
          : '<span hidden data-chatgpt-agent-turn-start></span>'}</div>`;
      await page.setContent("<main></main>");
      const render = (html: string) => page.locator("main").evaluate((node, value) => { node.innerHTML = value; }, html);
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await render(group("fallback-turn-0", true, "accepted-answer"));
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      let binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      await render(group("formal-user", true, "accepted-answer"));
      binding = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
      expect(baseline.acceptedUserIdentity).toBe("group:user:formal-user");
      await render(group("fallback-turn-1", false));
      binding = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
      await render(group(hasUser ? "formal-user" : "foreign", hasUser, "foreign-answer"));
      await expect(worker.reconcileAssistantTurnBinding(page, baseline, binding)).rejects.toThrow("another user turn");
    } finally { await browser.close(); }
  }, 15_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await browser.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key" || scenario === "unfinished") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/backend-api/files/process_upload_stream"
    ? new Response(JSON.stringify({ event: "file.processing.completed", file_id: "fixture-file" }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
    : new Response("<main></main>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await page.locator('input[type="file"]').evaluate(input => {
        input.addEventListener("change", () => void fetch("/backend-api/files/process_upload_stream", {
          method: "POST", body: JSON.stringify({ file_name: "codex-input-image-1.png", file_id: "fixture-file" }),
        }));
      });
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await browser.close(); server.stop(true); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("native identity capture ends before asynchronous submission acknowledgement", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const laterId = "22222222-2222-4222-8222-222222222222";
  try {
    for (const late of [false, true]) {
      const page = await browser.newPage();
      const observer = new ChatGptSubmissionRejectionObserver();
      try {
        await page.route("https://chatgpt.com/backend-api/f/conversation", route => route.fulfill({ status: 200,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }, body: "{}" }));
        await page.setContent('<main></main><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">Prompt</div><button type="button" data-testid="send-button" aria-label="Send prompt">Send</button></form>');
        const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
        const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
        await page.locator("button").evaluate((button, id) => button.addEventListener("keydown", async event => {
          if ((event as KeyboardEvent).key !== "Enter") return;
          event.preventDefault();
          await fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [{ id, author: { role: "user" }, content: { parts: ["Prompt"] } }] }) });
          document.querySelector("main")!.innerHTML = '<button data-testid="stop-button" aria-label="Stop streaming">Stop</button>';
        }), firstId);
        let acknowledged = false;
        expect(await worker.sendAttachedPrompt(page, baseline, undefined, AbortSignal.timeout(5000), undefined, {
          async onSubmitted() {
            acknowledged = true;
            expect(baseline.submittedUserMessage).toEqual({ messageId: firstId });
            if (late) await page.evaluate(async id => {
              await fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ messages: [{ id, author: { role: "user" }, content: { parts: ["Later request"] } }] }) });
            }, laterId);
          },
        }, undefined, undefined, undefined, observer)).toBe("generation_running");
        expect(acknowledged).toBeTrue();
        expect(baseline.submittedUserMessage).toEqual({ messageId: firstId });
      } finally { observer.dispose(); await page.close(); }
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("initial assistant binding preserves the formal user accepted by physical Send", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const acceptedId = "11111111-1111-4111-8111-111111111111";
  const foreignId = "22222222-2222-4222-8222-222222222222";
  try {
    for (const native of ["known", "absent", "unknown"] as const) for (const foreign of [false, true]) {
      const page = await browser.newPage();
      const observer = new ChatGptSubmissionRejectionObserver();
      try {
        await page.route("https://chatgpt.com/backend-api/f/conversation", route => route.fulfill({ status: 200,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }, body: "{}" }));
        await page.setContent('<main></main><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox">Prompt</div><button type="button" data-testid="send-button" aria-label="Send prompt">Send</button></form>');
        const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
        const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
        await page.locator("button").evaluate((button, { id, native }) => button.addEventListener("keydown", async event => {
          if ((event as KeyboardEvent).key !== "Enter") return;
          event.preventDefault();
          if (native !== "absent") await fetch("https://chatgpt.com/backend-api/f/conversation", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(native === "known" ? { messages: [{ id, author: { role: "user" } }] } : { unknownSchema: true }) });
          document.querySelector("main")!.innerHTML = `<div data-turn-key="${id}"><div data-user-message-bubble>Prompt</div></div>`;
        }), { id: acceptedId, native });
        expect(await worker.sendAttachedPrompt(page, baseline, undefined, AbortSignal.timeout(5000), undefined,
          undefined, undefined, undefined, undefined, observer)).toBe("user_turn");
        expect(baseline.acceptedUserIdentity).toBe(`group:user:${acceptedId}`);
        const id = foreign ? foreignId : acceptedId;
        await page.locator("main").evaluate((main, id) => {
          main.innerHTML = `<div data-turn-key="${id}"><div data-user-message-bubble>Prompt</div><span hidden data-chatgpt-agent-turn-start></span></div>`;
        }, id);
        const binding = worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
        if (foreign) await expect(binding).rejects.toThrow("user turn");
        else expect((await binding).identity).toBe(`group:assistant:${acceptedId}`);
        expect(baseline.acceptedUserIdentity).toBe(`group:user:${acceptedId}`);
      } finally { observer.dispose(); await page.close(); }
    }
  } finally { await browser.close(); }
}, 30_000);
