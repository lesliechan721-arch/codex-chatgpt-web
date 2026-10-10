import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  LauncherManualTurnTimedOutError,
  LauncherRetainedConversationUnavailableError,
  LauncherBrowserTurnCancelledError,
  endLauncherManualTurn,
  inspectLauncherBrowserHost,
  inspectLauncherBrowserHostLiveness,
  inspectLauncherContinuityConversation,
  queryLauncherContinuityTransaction,
  updateLauncherContinuityPreparation,
  markLauncherContinuitySendPossible,
  retireLauncherContinuityWriter,
  notifyLauncherTurn,
  markLauncherManualTurnStarted,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
} from "../src/launcher-browser-host";
import { CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE, type ContinuityRecoveryIdentity } from "../src/adapters/chatgpt-web/continuity-contract";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const roots: string[] = [];
const launcherInstance = { pid: process.pid, startIdentity: "darwin:Sat Oct 10 00:00:00 2026", instanceId: "0".repeat(64) };

function recoveryIdentity(overrides: Partial<ContinuityRecoveryIdentity> = {}): ContinuityRecoveryIdentity {
  return { schemaVersion: 2, installationId: "a".repeat(64), threadKey: "b".repeat(64), epoch: 0,
    transactionId: "c".repeat(64), transactionVersion: 0, logicalWorkId: "d".repeat(64), attempt: 0,
    snapshotVersion: 0, snapshotDigest: "e".repeat(64), ownerProcess: { pid: process.pid, startIdentity: "verified-start" }, launcherInstance, ...overrides };
}

test("continuity inspect distinguishes transient control failures from a confirmed missing page", async () => {
  const lease = { owner: "a".repeat(64), leaseId: "b".repeat(32), traceId: "inspect-trace" };
  let state = "transient";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return state === "transient" ? Response.json({ error: "not ready" }, { status: 503 })
      : state === "lost" ? Response.json({ code: "continuity_session_lost" }, { status: 409 })
      : Response.json({ ok: true, continuity: lease, state: "ready" });
  } });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`, "production", undefined, [CONTINUITY_FEATURE]);
    await expect(inspectLauncherContinuityConversation(path, "c".repeat(64), lease)).rejects.toMatchObject({ code: "continuity_unverified", retryable: true });
    state = "ready";
    await expect(inspectLauncherContinuityConversation(path, "c".repeat(64), lease)).resolves.toEqual({ continuity: lease, state: "ready" });
    state = "lost";
    await expect(inspectLauncherContinuityConversation(path, "c".repeat(64), lease)).rejects.toMatchObject({ code: "continuity_session_lost" });
  } finally { server.stop(true); }
});

test("a v2 Launcher rejects instance recovery before a start request can create a page", async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json({}); } });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`, "production", undefined, [CONTINUITY_FEATURE, "session-continuity-recovery-v2"]);
    await expect(notifyLauncherTurn(path, { phase: "start", traceId: "old-launcher", helperPid: process.pid,
      conversationKey: "f".repeat(64), continuity: { owner: "f".repeat(64), recovery: recoveryIdentity() } })).rejects.toMatchObject({ code: "continuity_configuration_conflict" });
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});

test("recovery helpers authenticate and reject late snapshot and repeated Send authorization", async () => {
  let identity = recoveryIdentity();
  let preparationExpected: ContinuityRecoveryIdentity | undefined;
  let sent = false;
  const actions: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    const action = new URL(request.url).pathname.split("continuity-")[1]!;
    actions.push(action);
    const body = await request.json() as { recovery: ContinuityRecoveryIdentity; expected?: ContinuityRecoveryIdentity };
    if (action === "prepare") { expect(body.expected).toEqual(identity); preparationExpected = body.expected; identity = body.recovery; }
    if (action === "send-possible") {
      const sendAuthorized = !sent; sent = true;
      return Response.json({ ok: true, recovery: identity, state: "send-possible", writerRetired: false, toolsSettled: false, launcherInstance, hostNoWriter: false, sendAuthorized });
    }
    return Response.json({ ok: true, recovery: identity, state: action === "retire" ? "retired" : "prepared",
      writerRetired: action === "retire", toolsSettled: false, launcherInstance, hostNoWriter: action === "retire", preparationExpected });
  } });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`, "production", undefined, [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE]);
    await expect(queryLauncherContinuityTransaction(path, identity)).resolves.toMatchObject({ state: "prepared" });
    const before = identity;
    const after = recoveryIdentity({ transactionVersion: 1, snapshotVersion: 1, snapshotDigest: "1".repeat(64) });
    await expect(updateLauncherContinuityPreparation(path, { expected: before, recovery: after })).resolves.toMatchObject({ preparationExpected: before });
    await expect(queryLauncherContinuityTransaction(path, before)).rejects.toMatchObject({ code: "continuity_unverified" });
    await markLauncherContinuitySendPossible(path, after);
    await expect(markLauncherContinuitySendPossible(path, after)).rejects.toMatchObject({ code: "continuity_execution_unsettled" });
    await expect(retireLauncherContinuityWriter(path, after)).resolves.toMatchObject({ writerRetired: true, toolsSettled: false });
    expect(actions).toEqual(["query", "prepare", "query", "send-possible", "send-possible", "retire"]);
  } finally { server.stop(true); }
});

test("prepared CAS receipts must prove their complete predecessor before a migration can finish", async () => {
  const before = recoveryIdentity();
  const after = recoveryIdentity({ transactionVersion: 1, snapshotVersion: 1,
    ownerProcess: { pid: process.pid, startIdentity: "second-backend-instance" } });
  let preparationExpected: ContinuityRecoveryIdentity | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ ok: true, recovery: after, state: "prepared", writerRetired: false,
      toolsSettled: false, launcherInstance, hostNoWriter: false, preparationExpected });
  } });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`, "production", undefined, [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE]);
    await expect(updateLauncherContinuityPreparation(path, { expected: before, recovery: after })).rejects.toMatchObject({ code: "continuity_unverified" });
    preparationExpected = { ...before, ownerProcess: after.ownerProcess };
    await expect(updateLauncherContinuityPreparation(path, { expected: before, recovery: after })).rejects.toMatchObject({ code: "continuity_unverified" });
    preparationExpected = { ...before, snapshotVersion: 1 };
    await expect(queryLauncherContinuityTransaction(path, after)).rejects.toMatchObject({ code: "continuity_unverified" });
    preparationExpected = before;
    await expect(updateLauncherContinuityPreparation(path, { expected: before, recovery: after })).resolves.toMatchObject({ recovery: after, preparationExpected: before });
    await expect(queryLauncherContinuityTransaction(path, after)).resolves.toMatchObject({ preparationExpected: before });
  } finally { server.stop(true); }
});

test("a late lifecycle acknowledgement cannot be accepted for the next snapshot", async () => {
  const before = recoveryIdentity();
  const after = recoveryIdentity({ transactionVersion: 1, snapshotVersion: 1 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ ok: true, cancelledByUser: false, recovery: before });
  } });
  try {
    const path = descriptorFile(`http://127.0.0.1:${server.port}`, "production", undefined, [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE]);
    await expect(notifyLauncherTurn(path, { phase: "end", traceId: "late-end-trace", helperPid: process.pid,
      recovery: after, status: "failed" })).rejects.toMatchObject({ code: "continuity_unverified" });
  } finally { server.stop(true); }
});

test("a lost recovery start response queries the original transaction before retrying identical acquisition", async () => {
  const recovery = recoveryIdentity();
  const owner = "f".repeat(64);
  const traceId = "recovery-response-loss";
  const continuity = { owner, leaseId: "a".repeat(32), traceId, recovery };
  const routes: string[] = [];
  const starts: unknown[] = [];
  let allocated = false;
  let pages = 0;
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString());
    routes.push(request.url!);
    if (request.url === "/v1/turn/start") {
      starts.push(body);
      if (!allocated) { allocated = true; pages++; response.destroy(); return; }
    } else {
      expect(body.recovery).toEqual(recovery);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/v1/turn/continuity-query"
      ? { ok: true, recovery, state: "prepared", writerRetired: false, toolsSettled: false, launcherInstance, hostNoWriter: false, continuity,
        surfaceId: "s".repeat(32), tabId: "single-page" }
      : { ok: true, surfaceId: "s".repeat(32), reused: false, connectorBound: false, continuity }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test control port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`, "production", undefined, [CONTINUITY_FEATURE, CONTINUITY_RECOVERY_FEATURE]);
    await expect(notifyLauncherTurn(path, { phase: "start", traceId, helperPid: process.pid,
      conversationKey: "e".repeat(64), continuity: { owner, recovery } }, 500)).resolves.toMatchObject({ continuity });
    expect(routes).toEqual(["/v1/turn/start", "/v1/turn/continuity-query", "/v1/turn/start"]);
    expect(starts[0]).toEqual(starts[1]);
    expect(pages).toBe(1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("launcher activity follows actual send callbacks and current-turn tool counts", async () => {
  const messages: Array<{ phase: string; progress?: { stage: string; activeToolCalls: number } }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const message = await request.json() as typeof messages[number];
    messages.push(message);
    return Response.json(message.phase === "start"
      ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false });
  } });
  const waitForStage = async (stage: string) => {
    const deadline = Date.now() + 1_000;
    while (!messages.some(message => message.progress?.stage === stage) && Date.now() < deadline) await Bun.sleep(5);
    expect(messages.some(message => message.progress?.stage === stage)).toBeTrue();
  };
  let activeToolCalls = 0;
  let activated = 0;
  let submitted = 0;
  try {
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptorFile(`http://127.0.0.1:${server.port}`) },
      runBrowserTurn: async (turn: { onSendActivated(): Promise<void>; onSubmitted(): Promise<void> }) => {
        await waitForStage("preparing");
        await turn.onSendActivated();
        await waitForStage("sending");
        activeToolCalls = 2;
        await turn.onSubmitted();
        await waitForStage("chatgpt");
        return "done";
      },
    });
    await expect(worker.runExclusive({
      traceId: "activity-fixture", capabilities: { localToolsEnabled: true },
      externalProgress: { snapshot: () => ({ activeToolCalls }) },
      onSendActivated: () => { activated++; }, onSubmitted: () => { submitted++; },
    })).resolves.toBe("done");
    expect(messages.filter(message => message.progress).map(message => message.progress)).toEqual([
      { stage: "preparing", activeToolCalls: 0 }, { stage: "sending", activeToolCalls: 0 },
      { stage: "chatgpt", activeToolCalls: 2 },
    ]);
    expect(messages.at(-1)?.phase).toBe("end");
    expect([activated, submitted]).toEqual([1, 1]);
  } finally { server.stop(true); }
});

test("a blocked sign-in replaces an opaque navigation abort with a non-retryable session error", async () => {
  let needsSignIn: unknown = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const activity = await req.json() as { phase: string };
    return Response.json(activity.phase === "start"
      ? { surfaceId: "a".repeat(32), reused: false, connectorBound: false }
      : { cancelledByUser: false, authenticationRequired: needsSignIn });
  } });
  try {
    const descriptor = descriptorFile(`http://127.0.0.1:${server.port}`);
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { browserHost: "launcher", browserHostDescriptorPath: descriptor },
      runBrowserTurn: async () => { throw new Error("page.goto: net::ERR_ABORTED"); },
    });
    const turn = { traceId: "auth-redirect", capabilities: { localToolsEnabled: false } };
    await expect(worker.runExclusive(turn)).rejects.toMatchObject({
      status: 401, code: "chatgpt_sign_in_required", retryable: false,
    });
    needsSignIn = false;
    await expect(worker.runExclusive(turn)).rejects.toThrow("page.goto: net::ERR_ABORTED");
    needsSignIn = "true";
    await expect(notifyLauncherTurn(descriptor, { phase: "end", traceId: "auth-redirect", helperPid: process.pid, status: "failed" }))
      .rejects.toThrow("invalid authentication state");
  } finally { server.stop(true); }
});

test("startup waits beyond five seconds and distinguishes its deadline from caller cancellation", async () => {
  let calls = 0;
  let onRequest: (() => void) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    calls++;
    onRequest?.();
    await Bun.sleep(calls === 1 ? 5_100 : 80);
    return Response.json({ surfaceId: "a".repeat(32), reused: false, connectorBound: false });
  } });
  try {
    const descriptor = descriptorFile(`http://127.0.0.1:${server.port}`);
    const activity = { phase: "start" as const, traceId: "bounded-start", helperPid: process.pid };
    await expect(notifyLauncherTurn(descriptor, activity)).resolves.toMatchObject({ reused: false });
    await expect(notifyLauncherTurn(descriptor, activity, 10)).rejects.toThrow("start timed out after 10ms");
    const controller = new AbortController();
    let cancelledAfterArrival = false;
    // Cancel after the request arrives, independent of the runner's scheduling speed.
    onRequest = () => { cancelledAfterArrival = true; controller.abort(); };
    const pending = notifyLauncherTurn(descriptor, activity, undefined, controller.signal);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledAfterArrival).toBe(true);
  } finally { server.stop(true); }
}, 10_000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
  endpoint = "http://127.0.0.1:39110",
  features?: string[],
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    ...(features ? { features } : {}),
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    launcherInstance,
    endpoint,
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("automatic initial continuity start reconciles one lost acknowledgement with the exact claim", async () => {
  let attempts = 0;
  const owner = "a".repeat(64);
  const traceId = "automatic_reconcile";
  const lease = { owner, leaseId: "b".repeat(32), traceId };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    attempts += 1;
    if (attempts === 1) {
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      surfaceId: "s".repeat(32),
      reused: true,
      connectorBound: false,
      continuity: lease,
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(
      `http://127.0.0.1:${address.port}`,
      "production",
      "http://127.0.0.1:39110",
      [CONTINUITY_FEATURE],
    );
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId,
      helperPid: process.pid,
      conversationKey: "c".repeat(64),
      continuity: { owner },
    }, 500)).resolves.toMatchObject({
      surfaceId: "s".repeat(32),
      reused: true,
      continuity: lease,
    });
    expect(attempts).toBe(2);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":true,"connectorBound":true}\n'
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native4",
      requireRetainedConversation: true,
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      reused: true,
      connectorBound: true,
      trackUsage: false,
    });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native4",
      requireRetainedConversation: true,
    });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    expect(received.body).toEqual({
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    await expect(notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    })).resolves.toEqual({ cancelledByUser: false });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher retained-conversation release uses its authenticated exact-key endpoint", async () => {
  let received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"released":1}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(releaseLauncherRetainedConversation(path, "b".repeat(64))).resolves.toBe(1);
    expect(received).toEqual({
      url: "/v1/turn/release",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { conversationKey: "b".repeat(64) },
    });
    await expect(releaseLauncherRetainedConversation(path, "not-a-key"))
      .rejects.toThrow("retained conversation key is invalid");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves explicit user cancellation as a terminal signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"turn closed by user","code":"turn_cancelled"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "cancelled123",
      helperPid: process.pid,
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(LauncherBrowserTurnCancelledError);
    expect((error as Error).message).toBe("turn closed by user");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves a missing retained conversation as a typed signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"retained source missing","code":"retained_conversation_unavailable"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "missing123456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      requireRetainedConversation: true,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(LauncherRetainedConversationUnavailableError);
    expect(error.message).toContain("retained source missing");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectCapabilities: true })).toEqual({
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher liveness verification checks only owned process and loopback CDP metadata", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    expect(request.url).toBe("/json/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1:39120/devtools/browser/test",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(
      "http://127.0.0.1:39111",
      "development",
      `http://127.0.0.1:${address.port}`,
    );
    await expect(inspectLauncherBrowserHostLiveness(path, {
      expectedProfile: "development",
    })).resolves.toMatchObject({
      profile: "development",
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* consume request */ }
    } catch (error) {
      // The inspection deadline can abort the client before its request body is consumed.
      if (request.aborted) return;
      throw error;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectCapabilities: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher profile checks reject cross-profile browser ownership", async () => {
  const path = descriptorFile("http://127.0.0.1:39111", "development");
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt",
  });
  await expect(inspectLauncherBrowserHost(path, { expectedProfile: "production", timeoutMs: 5 }))
    .rejects.toThrow("belongs to development");
});

function nativeTargetContext(pages: Page[], targetId: (page: Page) => string): BrowserContext {
  return {
    pages: () => pages,
    newCDPSession: async (page: Page) => ({
      send: async (method: string) => {
        expect(method).toBe("Target.getTargetInfo");
        return { targetInfo: { targetId: targetId(page) } };
      },
      detach: async () => {},
    }),
  } as unknown as BrowserContext;
}

test("launcher page selection uses native ownership without evaluating unrelated renderers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: () => { throw new Error("Do not evaluate an unrelated renderer"); },
  } as unknown as Page;
  const ownedPage = {
    url: () => LAUNCHER_BROWSER_IDLE_URL,
    evaluate: () => { throw new Error("Ownership comes from the native target"); },
  } as unknown as Page;
  const context = nativeTargetContext([hiddenPage, ownedPage],
    page => page === ownedPage ? "native-owned-target" : "native-other-target");
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated native target ownership", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = nativeTargetContext([page(), page()], () => "native-owned-target");
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("launcher descriptor rejects ambiguous native targets and selection rejects retired surfaces", async () => {
  const path = descriptorFile();
  const descriptor = readLauncherBrowserHostDescriptor(path);
  const duplicate = { ...descriptor, surfaceTargets: {
    ...descriptor.surfaceTargets, ["x".repeat(32)]: "native-owned-target",
  } };
  writeFileSync(path, JSON.stringify(duplicate), { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("duplicated surface targets");
  const browser = { contexts: () => [] } as unknown as Browser;
  await expect(selectLauncherPage(browser, descriptor, 20, "retired".repeat(5))).rejects.toThrow("no longer registered");
  writeFileSync(path, JSON.stringify({ ...descriptor, version: 2 }), { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("restart the updated launcher");
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("manual launcher control separates idempotent start from reconnectable Sent observation", async () => {
  const requests: Array<{ url: string | undefined; body: unknown }> = [];
  let sentPolls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/manual/start") {
      response.end(JSON.stringify({
        ok: true,
        tabId: "manual-tab",
        reused: false,
        deadlineAt: "2026-08-30T00:01:00.000Z",
        state: "awaiting-user",
        sentConfirmationRequired: true,
      }));
      return;
    }
    if (request.url === "/v1/manual/wait-sent" && sentPolls++ === 0) {
      response.statusCode = 202;
      response.end('{"ok":true,"status":"pending"}');
      return;
    }
    if (request.url === "/v1/manual/wait-sent") {
      response.end('{"ok":true,"status":"sent","sentAt":"2026-08-30T00:00:30.000Z"}');
      return;
    }
    if (request.url === "/v1/manual/started") {
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/v1/manual/wait-terminal") {
      response.end('{"ok":true,"status":"cancelled"}');
      return;
    }
    response.end('{"ok":true,"cancelledByUser":false}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const owner = { traceId: "manual123456", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, {
      ...owner,
      prompt: "private prompt",
      compaction: true,
      sentConfirmationRequired: true,
    })).resolves.toMatchObject({
      tabId: "manual-tab",
      reused: false,
      state: "awaiting-user",
      sentConfirmationRequired: true,
    });
    await expect(waitForLauncherManualSent(path, owner)).resolves.toEqual({
      sentAt: "2026-08-30T00:00:30.000Z",
    });
    await expect(markLauncherManualTurnStarted(path, owner)).resolves.toBeUndefined();
    await expect(waitForLauncherManualTerminal(path, owner)).resolves.toEqual({ status: "cancelled" });
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed", retain: true }))
      .resolves.toEqual({ cancelledByUser: false });
    expect(requests.map(request => request.url)).toEqual([
      "/v1/manual/start",
      "/v1/manual/wait-sent",
      "/v1/manual/wait-sent",
      "/v1/manual/started",
      "/v1/manual/wait-terminal",
      "/v1/manual/end",
    ]);
    expect(requests[0]?.body).toEqual({
      ...owner,
      prompt: "private prompt",
      compaction: true,
      sentConfirmationRequired: true,
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual launcher start rejects a lease with a different captured Sent policy", async () => {
  const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/manual/end") {
      response.end('{"ok":true,"cancelledByUser":false}');
      return;
    }
    response.end(JSON.stringify({
      ok: true,
      tabId: "manual-tab",
      reused: false,
      deadlineAt: "2026-08-30T00:01:00.000Z",
      state: "awaiting-user",
      sentConfirmationRequired: false,
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(startLauncherManualTurn(path, {
      traceId: "manualPolicyMismatch",
      helperPid: process.pid,
      prompt: "private prompt",
      sentConfirmationRequired: true,
    })).rejects.toThrow("does not match the caller expectation");
    expect(requests.map(request => request.url)).toEqual([
      "/v1/manual/start",
      "/v1/manual/end",
    ]);
    expect(requests[1]?.body).toEqual({
      traceId: "manualPolicyMismatch",
      helperPid: process.pid,
      status: "failed",
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual launcher start cleans up an observed turn when its lease is invalid", async () => {
  const requests: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/manual/end") {
      response.end('{"ok":true,"cancelledByUser":false}');
      return;
    }
    response.end(JSON.stringify({
      ok: true,
      tabId: "manual-tab",
      reused: false,
      deadlineAt: "2026-08-30T00:01:00.000Z",
      state: "awaiting-user",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(startLauncherManualTurn(path, {
      traceId: "manualInvalidLease",
      helperPid: process.pid,
      prompt: "private prompt",
      sentConfirmationRequired: true,
    })).rejects.toThrow("invalid manual turn lease");
    expect(requests.map(request => request.url)).toEqual([
      "/v1/manual/start",
      "/v1/manual/start",
      "/v1/manual/end",
    ]);
    expect(requests[2]?.body).toEqual({
      traceId: "manualInvalidLease",
      helperPid: process.pid,
      status: "failed",
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual launcher mutations reconcile one lost local response with the same turn owner", async () => {
  const attempts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = request.url ?? "";
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (attempt === 1) {
      response.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url === "/v1/manual/start") {
      response.end(JSON.stringify({
        ok: true,
        tabId: "manual-tab",
        reused: true,
        deadlineAt: "2026-08-30T00:01:00.000Z",
        state: "awaiting-user",
        sentConfirmationRequired: true,
      }));
      return;
    }
    if (url === "/v1/manual/started") {
      response.end('{"ok":true}');
      return;
    }
    response.end('{"ok":true,"cancelledByUser":false}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const owner = { traceId: "manual_reconcile", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, {
      ...owner,
      prompt: "private prompt",
      sentConfirmationRequired: true,
    }, 500))
      .resolves.toMatchObject({ tabId: "manual-tab", reused: true });
    await expect(markLauncherManualTurnStarted(path, owner, 500)).resolves.toBeUndefined();
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed" }, 500))
      .resolves.toEqual({ cancelledByUser: false });
    expect(Object.fromEntries(attempts)).toEqual({
      "/v1/manual/start": 2,
      "/v1/manual/started": 2,
      "/v1/manual/end": 2,
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual Sent wait preserves typed timeout and cancellation signals", async () => {
  for (const reply of [
    { status: 408, body: { error: "too slow", code: "manual_turn_timed_out" } },
    { status: 409, body: { error: "closed", code: "turn_cancelled" } },
  ]) {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      const path = descriptorFile(`http://127.0.0.1:${address.port}`);
      const error = await waitForLauncherManualSent(path, {
        traceId: "manual123456",
        helperPid: process.pid,
      }).catch(caught => caught);
      expect(error).toBeInstanceOf(reply.status === 408
        ? LauncherManualTurnTimedOutError
        : LauncherBrowserTurnCancelledError);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }
});
