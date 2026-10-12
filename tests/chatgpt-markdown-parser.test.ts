import { expect, test } from "bun:test";
import { _electron } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { decodeWebContextPayload, decodeWebContextTransaction } from "../src/adapters/chatgpt-web/context-renderer";

// #806 (@xianengqi): link parsing stalls on repeated code spans inside JSON arrays.
// Its code-span branch was verified in ChatGPT's public 257798.4db0db71a9.js asset.
// Run the actual expression in Chromium, inside a terminable worker: a timeout
// must not crash a renderer, create crash dumps, or affect a real account.
test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("encoded context avoids the Chromium Markdown parser stall", async () => {
  const userData = mkdtempSync(join(tmpdir(), "markdown-parser-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/composer-controls.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const page = await app.firstWindow();
    const code = "```a``` ".repeat(12);
    const parsed = {
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { systemPrompt: [], messages: [{ role: "user" as const, content: code, timestamp: 1 }] },
    };
    const encoded: string[] = [];
    for (const format of ["legacy-json", "codex-context-text-v1"] as const) {
      for (const parts of [undefined, 2, 6] as const) {
        const compiled = compileChatGptWebPrompt(parsed,
          { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
          "turn_12345678901234567890123456789012", { contextRendering: format, experimentalMultipartParts: parts });
        const payloads = compiled.multipart?.parts ?? [compiled.contextPayload!];
        const records = compiled.multipart ? decodeWebContextTransaction(payloads, format)
          : decodeWebContextPayload(payloads[0]!, format).records;
        expect(records.find(record => record.kind === "message")!.message.content).toBe(code);
        for (const payload of payloads) expect(payload).not.toContain("`");
        encoded.push(...payloads);
      }
    }
    const original = JSON.stringify([{ role: "user", content: code }]);
    const pattern = JSON.parse(readFileSync(new URL("./fixtures/chatgpt-markdown-link-regexp.json", import.meta.url), "utf8"));
    const result = await page.evaluate(async ({ pattern, original, encoded }) => {
      const run = (value: string): Promise<"done" | "timeout"> => new Promise((resolve, reject) => {
        const source = 'onmessage=({data})=>{new RegExp(data.pattern.source,data.pattern.flags).exec(data.value);postMessage("done")}';
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(url);
        const finish = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); };
        const timer = setTimeout(() => { finish(); resolve("timeout"); }, 1_000);
        worker.onmessage = () => { finish(); resolve("done"); };
        worker.onerror = event => { finish(); reject(new Error(event.message)); };
        worker.postMessage({ pattern, value });
      });
      const results = [];
      for (const payload of encoded) results.push(await run(payload));
      return { encoded: results, original: await run(original) };
    }, { pattern, original, encoded });
    expect(result).toEqual({ encoded: encoded.map(() => "done"), original: "timeout" });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 20_000);
