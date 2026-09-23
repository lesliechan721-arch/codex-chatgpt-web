import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";

function fixture() {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "cgw-race-"));
  const path = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(path);
  const environment = {
    cwd: root, roots: [root], writableRoots: [root],
    sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [],
  };
  return { root, path, broker, environment };
}

test("close settles an in-flight listen and cannot resurrect the retired broker", async () => {
  const { root, path, broker } = fixture();
  try {
    const listening = broker.listen().catch(() => {});
    await Promise.resolve(); // Let listen begin, but do not wait for its completion callback.
    await broker.close();
    await listening;
    await expect(callTurnBroker(path, { method: "owner_status" })).rejects.toThrow("unavailable");
    await expect(broker.listen()).rejects.toThrow("closed");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement startup and repeated close wait for physical close completion", async () => {
  const { root, path, broker } = fixture();
  let releaseClose = () => {};
  let replacement: TurnBroker | undefined;
  let closing: Promise<void> | undefined;
  try {
    await broker.listen();
    const server = (broker as unknown as { server: Server }).server;
    const originalClose = server.close.bind(server);
    let closeReached!: () => void;
    const reached = new Promise<void>(resolve => { closeReached = resolve; });
    spyOn(server, "close").mockImplementation(callback => originalClose(error => {
      releaseClose = () => callback?.(error);
      closeReached();
    }));
    closing = broker.close();
    await reached;
    let secondClosed = false;
    const secondClose = broker.close().then(() => { secondClosed = true; });
    replacement = TurnBroker.forSocket(path);
    let replacementStarted = false;
    const starting = replacement.listen().then(() => { replacementStarted = true; });
    // The callback is held explicitly; elapsed time cannot release the old owner.
    await Bun.sleep(20);
    expect(secondClosed).toBe(false);
    expect(replacementStarted).toBe(false);
    if (process.platform !== "win32") {
      const child = Bun.spawn([process.execPath, "-e", `
        import assert from "node:assert/strict";
        import { TurnBroker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href)};
        console.info = () => {};
        const broker = TurnBroker.forSocket(${JSON.stringify(path)});
        try { await assert.rejects(broker.listen(), /already owned by another process/); }
        finally { await broker.close(); }
      `], { stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    }
    releaseClose();
    await Promise.all([closing, secondClose, starting]);
    await broker.close();
    expect(TurnBroker.forSocket(path)).toBe(replacement);
    await expect(callTurnBroker(path, { method: "owner_status" }))
      .resolves.toMatchObject({ acceptingExternalOwners: true });
  } finally {
    releaseClose();
    await closing;
    await broker.close();
    await replacement?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const endpoint of ["public", "listener"] as const) {
test(`native close cannot unlink a ${endpoint} replacement bound after the final ownership check`, async () => {
  if (process.platform === "win32") return;
  const { root, path, broker } = fixture();
  const replacement = createServer(socket => socket.end("replacement alive"));
  let replacementListening: Promise<void> | undefined;
  try {
    await broker.listen();
    const replacementPath = endpoint === "public" ? path : readlinkSync(path);
    const server = (broker as unknown as { server: Server }).server;
    const originalClose = server.close.bind(server);
    spyOn(server, "close").mockImplementation(callback => {
      unlinkSync(replacementPath);
      replacementListening = new Promise<void>((resolve, reject) => {
        replacement.once("error", reject);
        replacement.listen(replacementPath, resolve);
      });
      expect(existsSync(path)).toBe(true);
      return originalClose(callback);
    });

    await broker.close();
    await replacementListening;
    expect(existsSync(path)).toBe(true);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", chunk => { socket.destroy(); resolve(String(chunk)); });
    });
    expect(reply).toBe("replacement alive");
  } finally {
    await broker.close().catch(() => {});
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("a reused dev/ino identity cannot cause a delayed close to unlink a replacement", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker } = fixture();
  const replacement = createServer(socket => socket.end("replacement alive"));
  let releaseClose = () => {};
  let closing: Promise<void> | undefined;
  try {
    await broker.listen();
    const internals = broker as unknown as { server: Server; ownedSocket: { dev: number; ino: number } };
    const oldIdentity = internals.ownedSocket;
    const originalClose = internals.server.close.bind(internals.server);
    let reached!: () => void;
    const closeReached = new Promise<void>(resolve => { reached = resolve; });
    spyOn(internals.server, "close").mockImplementation(callback => originalClose(error => {
      releaseClose = () => callback?.(error);
      reached();
    }));
    closing = broker.close();
    await closeReached;
    // Model a legacy peer that does not honor the new lock and a filesystem that reuses inode
    // numbers. Change the captured old identity instead of relying on probabilistic kernel reuse.
    unlinkSync(path);
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(path, resolve);
    });
    const current = statSync(path);
    Object.assign(oldIdentity, { dev: current.dev, ino: current.ino });
    releaseClose();
    await closing;
    expect(existsSync(path)).toBe(true);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", chunk => { socket.destroy(); resolve(String(chunk)); });
    });
    expect(reply).toBe("replacement alive");
  } finally {
    releaseClose();
    await closing;
    await broker.close();
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing endpoint cannot reuse a resolved start promise to register a turn", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  try {
    await broker.listen();
    unlinkSync(path); // Simulate an external deletion only inside this test's private directory.
    await expect(broker.register(environment)).rejects.toThrow("endpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("valid claims use info while invalid claims retain warning evidence", async () => {
  const { root, path, broker, environment } = fixture();
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const token = await broker.register(environment);
    await callTurnBroker(path, { method: "claim", token });
    expect(info.mock.calls.some(args => String(args[0]).includes("valid=true"))).toBe(true);
    expect(error.mock.calls.some(args => String(args[0]).includes("claim received"))).toBe(false);
    await expect(callTurnBroker(path, { method: "claim", token: "invalid" })).rejects.toThrow("invalid");
    expect(warn.mock.calls.some(args => String(args[0]).includes("valid=false"))).toBe(true);
    expect(JSON.stringify([...info.mock.calls, ...warn.mock.calls])).not.toContain(token);
  } finally {
    await broker.close();
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing a broker retires idle and partial-frame peers without waiting forever", async () => {
  const { root, path, broker } = fixture();
  const peers: ReturnType<typeof createConnection>[] = [];
  try {
    await broker.listen();
    for (const data of ["", '{"id":"unfinished"']) {
      const peer = createConnection(path);
      peers.push(peer);
      peer.on("error", () => {});
      await new Promise<void>(resolve => peer.once("connect", resolve));
      if (data) peer.write(data);
    }
    await callTurnBroker(path, { method: "owner_status" });
    const closed = await Promise.race([
      broker.close().then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    expect(closed).toBe(true);
    const replacement = TurnBroker.forSocket(path);
    try {
      await replacement.listen();
      expect(await replacement.checkHealth()).toBe(true);
    } finally {
      await replacement.close();
    }
  } finally {
    for (const peer of peers) peer.destroy();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("closing a broker rejects a connection dispatched after forced cleanup", async () => {
  const { root, path, broker } = fixture();
  const internals = broker as unknown as { handleSocket(socket: Socket): void };
  const originalHandleSocket = internals.handleSocket.bind(broker);
  let delayedSocket: Socket | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  let closing: Promise<void> | undefined;
  let queued!: () => void;
  let forced!: () => void;
  const socketQueued = new Promise<void>(resolve => { queued = resolve; });
  const forcedCleanup = new Promise<void>(resolve => { forced = resolve; });
  const info = spyOn(console, "info").mockImplementation(message => {
    if (String(message).includes('"event":"connections_forced_closed"')) forced();
  });
  try {
    await broker.listen();
    internals.handleSocket = socket => {
      delayedSocket = socket;
      queued();
    };
    client = createConnection(path);
    client.on("error", () => {});
    await socketQueued;

    closing = broker.close();
    expect(await Promise.race([
      forcedCleanup.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ])).toBe(true);

    internals.handleSocket = originalHandleSocket;
    originalHandleSocket(delayedSocket!);
    expect(await Promise.race([
      closing.then(() => true),
      Bun.sleep(500).then(() => false),
    ])).toBe(true);
  } finally {
    internals.handleSocket = originalHandleSocket;
    client?.destroy();
    await closing?.catch(() => {});
    await broker.close().catch(() => {});
    info.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed startup releases its lock without requiring a separate close call", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker } = fixture();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "keep this file");
  try {
    await expect(broker.listen()).rejects.toThrow("not a socket");
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed lost endpoint fails waiting turns instead of leaving them unresponsive", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  try {
    const token = await broker.registerSafe(environment, "surface_nonce_lost_endpoint_0123456789");
    const waiting = broker.waitForSafeStart(token).then(() => "unexpected success", error => error.message);
    unlinkSync(path);
    expect(await broker.checkHealth()).toBe(false);
    const outcome = await Promise.race([waiting, Bun.sleep(500).then(() => "still waiting")]);
    expect(outcome).toContain("endpoint");
    expect(existsSync(path)).toBe(false); // Detection must not recreate or replay the endpoint.
    await expect(broker.register(environment)).rejects.toThrow("endpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reapplying safe socket permissions keeps the same broker owner and waiting turn alive", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  let waitingState = "pending";
  try {
    const token = await broker.registerSafe(environment, "surface_nonce_permission_refresh_0123456789");
    const waiting = broker.waitForSafeStart(token).then(
      () => { waitingState = "resolved"; },
      error => { waitingState = error.message; },
    );
    const before = statSync(path);
    await Bun.sleep(20);
    chmodSync(path, 0o600);
    const after = statSync(path);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await broker.checkHealth()).toBe(true);
    await Bun.sleep(20);
    expect(waitingState).toBe("pending");
    chmodSync(path, 0o600);
    await broker.close();
    await waiting;
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated protocol transport failures retire existing waits and release active owners", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  let peer: ReturnType<typeof createConnection> | undefined;
  try {
    const token = await broker.registerSafe(
      environment,
      "surface_nonce_transport_failure_0123456789",
      undefined,
      "transport_failure_trace",
      true,
    );
    const waiting = broker.waitForSafeStart(token).then(() => "unexpected success", error => error.message);
    const server = (broker as unknown as { server: Server }).server;
    server.maxConnections = 1;
    peer = createConnection(path);
    peer.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      peer!.once("error", reject);
      peer!.once("connect", resolve);
    });
    const health = [await broker.checkHealth()];
    expect(health).toEqual([false]);
    expect(broker.externalOwnerActiveCount()).toBe(1);
    for (let index = 1; index < 3; index += 1) health.push(await broker.checkHealth());
    expect(health).toEqual([false, false, false]);
    const outcome = await Promise.race([waiting, Bun.sleep(500).then(() => "still waiting")]);
    expect(outcome).toContain("protocol remained unreachable");
    expect(broker.externalOwnerActiveCount()).toBe(0);
  } finally {
    peer?.destroy();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the endpoint monitor retires waits after sustained protocol transport failure", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  let peer: ReturnType<typeof createConnection> | undefined;
  try {
    const token = await broker.registerSafe(
      environment,
      "surface_nonce_monitor_transport_failure_0123456789",
      undefined,
      "monitor_transport_failure_trace",
      true,
    );
    const waiting = broker.waitForSafeStart(token).then(() => "unexpected success", error => error.message);
    const server = (broker as unknown as { server: Server }).server;
    server.maxConnections = 1;
    peer = createConnection(path);
    peer.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      peer!.once("error", reject);
      peer!.once("connect", resolve);
    });
    const outcome = await Promise.race([waiting, Bun.sleep(4_500).then(() => "still waiting")]);
    expect(outcome).toContain("protocol remained unreachable");
    expect(broker.externalOwnerActiveCount()).toBe(0);
  } finally {
    peer?.destroy();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 6_000);

test("health rejects a protocol response from a different broker owner", async () => {
  const { root, broker } = fixture();
  try {
    await broker.listen();
    const dispatch = spyOn(broker as any, "dispatch").mockResolvedValue({
      protocolVersion: 6, acceptingExternalOwners: true, owner: "another-process-instance",
    });
    try {
      expect(await broker.checkHealth()).toBe(false);
    } finally {
      dispatch.mockRestore();
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("endpoint loss fails an existing wait even without a new request or health poll", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker, environment } = fixture();
  try {
    const token = await broker.registerSafe(environment, "surface_nonce_monitor_loss_0123456789");
    const waiting = broker.waitForSafeStart(token).then(() => "unexpected success", error => error.message);
    unlinkSync(path);
    const outcome = await Promise.race([waiting, Bun.sleep(2_500).then(() => "still waiting")]);
    expect(outcome).toContain("endpoint");
    expect(existsSync(path)).toBe(false);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("connection failures retain the original filesystem code and cause", async () => {
  if (process.platform === "win32") return;
  const { root, path, broker } = fixture();
  try {
    const error = await callTurnBroker(path, { method: "owner_status" }).then(() => null, error => error);
    expect(error?.code).toBe("ENOENT");
    expect(error?.cause?.code).toBe("ENOENT");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
