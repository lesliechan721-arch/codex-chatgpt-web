import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";

const tooLong = "The message you submitted was too long, please edit it and resubmit.";

for (const freshAlert of [false, true]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`physical Send keeps the alert baseline and its native identity (fresh alert=${freshAlert})`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    const observer = new ChatGptSubmissionRejectionObserver();
    try {
      const page = await browser.newPage();
      await page.route("**/*", route => route.fulfill(route.request().method() === "POST"
        ? { contentType: "application/json", body: "{}" }
        : { contentType: "text/html", body: `<main></main>
        <aside role="alert">${tooLong}</aside>
        <form data-chatgpt-composer><div contenteditable="true" data-composer-markdown role="textbox">Prompt</div>
          <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button></form>` }));
      await page.goto("https://chatgpt.com/c/fixture");
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
      const messageId = "11111111-1111-4111-8111-111111111111";
      await page.locator("button").evaluate((button, { id, fresh, text }) => {
        button.addEventListener("keydown", async event => {
          if ((event as KeyboardEvent).key !== "Enter") return;
          event.preventDefault();
          await fetch("/backend-api/f/conversation", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [{ id, author: { role: "user" } }] }) });
          document.querySelector("main")!.innerHTML = fresh
            ? `<aside role="alert">${text}</aside>`
            : '<button data-testid="stop-button" aria-label="Stop streaming">Stop</button>';
        });
      }, { id: messageId, fresh: freshAlert, text: tooLong });
      let receipts = 0;
      let dispatches = 0;
      let dispatchedAt = 0;
      const result = worker.sendAttachedPrompt(page, baseline, undefined, AbortSignal.timeout(25_000), undefined, {
        async onSendActivated() {
          // Preparation may issue a request. It must not make the actual Send ambiguous.
          await page.evaluate(async () => { await fetch("/backend-api/f/conversation", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: [{ id: "22222222-2222-4222-8222-222222222222", author: { role: "user" } }] }),
          }); });
        },
        dispatchWithExecutionAuthority<T>(dispatch: () => T): T { dispatchedAt = performance.now(); dispatches += 1; return dispatch(); },
        onSubmitted() { receipts += 1; },
      }, undefined, undefined, undefined, observer);
      if (freshAlert) {
        // The rejection can remove every turn before any acceptance evidence appears.
        await expect(result).rejects.toMatchObject({ code: "context_length_exceeded", retryable: false });
        expect(performance.now() - dispatchedAt).toBeLessThan(10_000);
        expect(receipts).toBe(0);
      } else {
        expect(await result).toBe("generation_running");
        expect(await observer.failure()).toBeUndefined();
        expect(receipts).toBe(1);
      }
      expect(dispatches).toBe(1);
      expect(baseline.submittedUserMessage).toEqual({ messageId });
    } finally { observer.dispose(); await browser.close(); }
  }, 30_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a new service size alert survives removal of the current conversation DOM (#874)", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const observer = new ChatGptSubmissionRejectionObserver();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main><div data-turn-key='current'>Response</div></main>" }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page, undefined, [], await observer.captureAlertBaseline(page));
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    await page.evaluate(text => {
      document.querySelector("main")!.innerHTML = `<aside role="alert">${text}</aside>`;
    }, tooLong);
    expect(await observer.failure()).toMatchObject({ code: "context_length_exceeded", retryable: false });
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("size alerts require a current owned Send and exclude history, quoted text and hidden UI", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const failures: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => failures.push(error));
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<main><aside id="old" role="alert">${tooLong}</aside></main>` }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page, undefined, [], await observer.captureAlertBaseline(page));
    await page.evaluate(text => document.querySelector("main")!.insertAdjacentHTML("beforeend", `<aside id="new" role="alert">${text}</aside>`), tooLong);
    // Background requests and requests from another page do not authorize this alert.
    await page.evaluate(async () => { await fetch("/backend-api/other", { method: "POST" }); });
    const other = await browser.newPage();
    await other.route("**/*", route => route.fulfill({ body: "fixture" }));
    await other.goto("https://chatgpt.com/");
    await other.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
    await page.locator("#new").evaluate(element => element.remove());
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    for (const markup of [
      `<div class="markdown"><aside role="alert">${tooLong}</aside></div>`,
      `<div data-turn-key="old-turn"><aside role="alert">${tooLong}</aside></div>`,
      `<div data-user-message-bubble><aside role="alert">${tooLong}</aside></div>`,
      `<div contenteditable="true"><aside role="alert">${tooLong}</aside></div>`,
      `<aside role="alert" hidden>${tooLong}</aside>`,
      `<aside role="alert" style="visibility:hidden">${tooLong}</aside>`,
      `<aside role="alert">The model said: ${tooLong}</aside>`,
      `<div>${tooLong}</div>`,
    ]) {
      await page.evaluate(html => {
        document.querySelector("#variant")?.remove();
        document.querySelector("main")!.insertAdjacentHTML("beforeend", `<section id="variant">${html}</section>`);
      }, markup);
      expect(await observer.failure()).toBeUndefined();
    }
    expect(failures).toHaveLength(0);
    await page.evaluate(text => { document.querySelector("#variant")!.innerHTML = `<aside role="alert">${text}</aside>`; }, tooLong);
    expect(await observer.failure()).toMatchObject({ status: 400, code: "context_length_exceeded", retryable: false });
    await observer.failure();
    expect(failures).toHaveLength(1);
    // The next multipart Send records the existing alert as stale and resets the failure.
    observer.begin(page, undefined, [], await observer.captureAlertBaseline(page));
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);
