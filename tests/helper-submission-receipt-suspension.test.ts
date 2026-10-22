import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Keep the production helper, client, clock, receipt timer and IPC. Only the
// external browser is replaced; no compaction handoff has been accepted here.
function helperFixture(body: string, compaction = true) {
  const root = mkdtempSync(join(tmpdir(), "cgw-helper-receipt-")); roots.push(root);
  const script = join(root, "helper.ts"), descriptor = join(root, "launcher.json");
  writeFileSync(script, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    import { chatGptSuspensionClock } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/suspension-clock.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async function(turn) {
      if (Boolean(turn.compaction) !== ${compaction}) throw new Error("Compaction purpose lost in IPC");
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      ${body}
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  writeFileSync(descriptor, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production",
    pid: process.pid, endpoint: "http://127.0.0.1:39001",
    control: { endpoint: "http://127.0.0.1:39002", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script }, partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "owned-helper-target" }, createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native5", browserHost: "launcher",
    browserHostDescriptorPath: descriptor, browserHelperScriptPath: script,
    storageStatePath: join(root, "unused-state.json"), chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000, headed: true, autoApproveToolCalls: false, useSavedChats: false });
  const sent: string[] = [];
  const internal = client as unknown as { send(frame: { type: string; id?: string }): Promise<void> };
  const send = internal.send.bind(client);
  internal.send = async frame => { sent.push(frame.type); await send(frame); };
  let releases = 0;
  const deltas: string[] = [];
  const turn: BrowserTurn = { traceId: "helper-receipt-trace", modelId: "gpt-5.6-sol",
    ...(compaction ? { compaction: true, nativeConnector: true } : {}),
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => ({ text: "bounded fixture", images: [], release() { releases++; } }),
    onSendActivated() {}, onSubmitted() {}, onTextDelta: text => deltas.push(text),
  };
  return { client, internal, turn, sent, deltas, releases: () => releases };
}

test("real helper receipt pauses only the compaction deadline across a detected event-loop pause longer than 15 seconds", async () => {
  type Report = { pausedMs: number; suspendedMs: number };
  const reports = new Map(["compaction", "ordinary"].map(mode => [mode, deferred<Report>()]));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    reports.get(new URL(request.url).pathname.slice(1))!.resolve(await request.json() as Report);
    return Response.json({ ok: true });
  } });
  try {
    await Promise.all([true, false].map(async compaction => {
      const mode = compaction ? "compaction" : "ordinary";
      const f = helperFixture(`
        const before = chatGptSuspensionClock.suspendedMs();
        const receipt = turn.onSubmitted();
        void receipt.catch(() => {});
        const startedAt = performance.now();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_250);
        const pausedMs = performance.now() - startedAt;
        // Yield to overdue timers before allowing the daemon to return the ACK.
        await Bun.sleep(25);
        await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/${mode}`)}, {
          method: "POST", body: JSON.stringify({ pausedMs, suspendedMs: chatGptSuspensionClock.suspendedMs() - before }),
        });
        await receipt;
        turn.onTextDelta("receipt accepted");
        return "receipt accepted";
      `, compaction);
      let callbacks = 0;
      f.turn.onSubmitted = async () => { callbacks++; await reports.get(mode)!.promise; await Bun.sleep(25); };
      try {
        const outcome = f.client.run(f.turn).catch(error => error);
        const report = await reports.get(mode)!.promise;
        expect(report.pausedMs).toBeGreaterThanOrEqual(15_000);
        expect(report.suspendedMs).toBeGreaterThan(14_000);
        const result = await outcome;
        if (compaction) {
          expect(result).toBe("receipt accepted");
          expect(f.deltas).toEqual(["receipt accepted"]);
          expect(f.sent.filter(type => type === "submitted_ack")).toHaveLength(1);
        } else {
          expect(result).toBeInstanceOf(Error);
          expect(result.message).toContain("submission receipt acknowledgement timed out");
          expect(f.deltas).toEqual([]);
          expect(f.sent).not.toContain("submitted_ack");
        }
        expect(callbacks).toBe(1);
        expect(f.releases()).toBe(1);
      } finally { await f.client.close(); }
    }));
  } finally { server.stop(true); }
}, 30_000);

test("a compaction receipt with no awake ACK expires and duplicate or late receipt settlement cannot publish output", async () => {
  const f = helperFixture(`
    const receipt = turn.onSubmitted();
    process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "submitted" }) + "\\n");
    await receipt;
    turn.onTextDelta("unacknowledged output");
    return "unacknowledged output";
  `);
  const entered = deferred(), receipt = deferred(), callbackEnded = deferred();
  let callbacks = 0;
  f.turn.onSubmitted = async () => {
    callbacks++; entered.resolve();
    try { await receipt.promise; } finally { callbackEnded.resolve(); }
  };
  try {
    const outcome = f.client.run(f.turn).catch(error => error);
    await entered.promise;
    const startedAt = performance.now();
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("submission receipt acknowledgement timed out");
    expect(performance.now() - startedAt).toBeGreaterThan(14_000);
    expect(performance.now() - startedAt).toBeLessThan(25_000);
    receipt.resolve();
    await callbackEnded.promise;
    await Bun.sleep(25);
    await f.internal.send({ type: "submitted_ack", id: f.turn.traceId });
    expect(callbacks).toBe(1);
    expect(f.sent.filter(type => type === "submitted_ack")).toHaveLength(1); // Only the explicit late probe.
    expect(f.deltas).toEqual([]);
    expect(f.releases()).toBe(1);
    await expect(f.client.assertContinuityCompatible()).resolves.toBeUndefined();
  } finally { receipt.resolve(); await f.client.close(); }
}, 30_000);

test("a compaction helper that returns early still waits for its one persisted receipt before its terminal", async () => {
  const f = helperFixture(`
    turn.onSubmitted();
    process.stdout.write(JSON.stringify({ type: "event", id: turn.traceId, event: "submitted" }) + "\\n");
    return "receipt-gated final";
  `);
  const entered = deferred(), receipt = deferred();
  let callbacks = 0, settled = false;
  f.turn.onSubmitted = async () => { callbacks++; entered.resolve(); await receipt.promise; };
  try {
    const outcome = f.client.run(f.turn).finally(() => { settled = true; });
    await entered.promise;
    await Bun.sleep(25);
    expect(settled).toBe(false);
    expect(f.releases()).toBe(0);
    expect(f.deltas).toEqual([]);
    receipt.resolve();
    expect(await outcome).toBe("receipt-gated final");
    expect(callbacks).toBe(1);
    expect(f.sent.filter(type => type === "submitted_ack")).toHaveLength(1);
    expect(f.releases()).toBe(1);
  } finally { receipt.resolve(); await f.client.close(); }
});

for (const stop of ["abort", "close", "error"] as const) test(`compaction receipt ${stop} settles once and cannot be revived by a late ACK`, async () => {
  const f = helperFixture(`
    await turn.onSubmitted();
    turn.onTextDelta("cancelled output");
    return "cancelled output";
  `);
  const entered = deferred(), receipt = deferred(), callbackEnded = deferred();
  const controller = new AbortController(), originalError = new Error("Receipt persistence failed");
  let callbacks = 0;
  f.turn.abortSignal = controller.signal;
  f.turn.onSubmitted = async () => {
    callbacks++; entered.resolve();
    try { await receipt.promise; } finally { callbackEnded.resolve(); }
  };
  try {
    const outcome = f.client.run(f.turn).catch(error => error);
    await entered.promise;
    if (stop === "abort") controller.abort();
    else if (stop === "close") await f.client.close();
    else receipt.reject(originalError);
    const result = await outcome;
    if (stop === "error") expect(result).toBe(originalError);
    else expect(result).toMatchObject({ name: "AbortError" });
    receipt.resolve();
    await callbackEnded.promise;
    await Bun.sleep(25);
    expect(f.sent).not.toContain("submitted_ack");
    if (stop !== "close") {
      await f.internal.send({ type: "submitted_ack", id: f.turn.traceId });
      await expect(f.client.assertContinuityCompatible()).resolves.toBeUndefined();
    }
    expect(callbacks).toBe(1);
    expect(f.deltas).toEqual([]);
    expect(f.releases()).toBe(1);
  } finally { receipt.resolve(); await f.client.close(); }
});
