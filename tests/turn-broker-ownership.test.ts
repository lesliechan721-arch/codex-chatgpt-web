import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { acquireBrokerSocketLock } from "../src/adapters/chatgpt-web/turn-broker-lock";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const brokerModule = JSON.stringify(new URL("../src/adapters/chatgpt-web/turn-broker.ts", import.meta.url).href);

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}

test("a delayed lock release cannot remove the successor's owner marker", () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync("/tmp/cgw-lock-");
  const path = join(root, "broker.sock");
  const firstOwner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const secondOwner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  let releaseSecond = () => {};
  const releaseFirst = acquireBrokerSocketLock(path, firstOwner);
  try {
    expect(() => acquireBrokerSocketLock(path, secondOwner)).toThrow("already owned");
    releaseFirst();
    releaseSecond = acquireBrokerSocketLock(path, secondOwner);
    releaseFirst();
    expect(readdirSync(`${path}.lock`)).toEqual([secondOwner]);
  } finally {
    releaseFirst();
    releaseSecond();
    rmSync(root, { recursive: true, force: true });
  }
});

test("competing processes recover a crashed owner without unlinking the winning broker", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync("/tmp/cgw-crash-");
  const path = join(root, "broker.sock");
  const ready = join(root, "ready");
  const crashed = Bun.spawn([process.execPath, "-e", `
    import { writeFileSync } from "node:fs";
    import { TurnBroker } from ${brokerModule};
    console.info = () => {};
    await TurnBroker.forSocket(${JSON.stringify(path)}).listen();
    writeFileSync(${JSON.stringify(ready)}, "ready");
  `], { stdout: "pipe", stderr: "pipe" });
  const contenders: ReturnType<typeof Bun.spawn>[] = [];
  try {
    await waitForFile(ready);
    crashed.kill("SIGKILL");
    await crashed.exited;
    expect(existsSync(path)).toBe(true);
    const results = Array.from({ length: 4 }, (_, index) => join(root, `result-${index}`));
    for (const result of results) {
      contenders.push(Bun.spawn([process.execPath, "-e", `
        import { writeFileSync } from "node:fs";
        import { TurnBroker } from ${brokerModule};
        console.info = () => {};
        const broker = TurnBroker.forSocket(${JSON.stringify(path)});
        try {
          await broker.listen();
          writeFileSync(${JSON.stringify(result)}, "owner");
          await new Promise(resolve => process.stdin.once("data", resolve));
        } catch (error) {
          writeFileSync(${JSON.stringify(result)}, error.message);
        } finally {
          await broker.close();
        }
        process.exit(0);
      `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    }
    await Promise.all(results.map(waitForFile));
    const outcomes = results.map(result => readFileSync(result, "utf8"));
    expect(outcomes.filter(outcome => outcome === "owner")).toHaveLength(1);
    for (let index = 0; index < outcomes.length; index += 1) {
      if (outcomes[index] === "owner") continue;
      expect(outcomes[index]).toMatch(/already owned|ownership changed/);
      expect(await contenders[index]!.exited).toBe(0);
    }
    await expect(callTurnBroker(path, { method: "owner_status" }))
      .resolves.toMatchObject({ acceptingExternalOwners: true });
    const winner = contenders[outcomes.indexOf("owner")]!;
    const stdin = winner.stdin as import("bun").FileSink;
    stdin.write("close\n");
    stdin.end();
    expect(await winner.exited).toBe(0);
    await expect(callTurnBroker(path, { method: "owner_status" })).rejects.toThrow("ECONNREFUSED");
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    crashed.kill();
    for (const child of contenders) child.kill();
    await Promise.all([crashed.exited, ...contenders.map(child => child.exited)]);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("stale-socket probing does not delete a regular file that replaced the socket", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync("/tmp/cgw-probe-");
  const path = join(root, "broker.sock");
  const ready = join(root, "ready");
  // A legacy process does not participate in the new ownership lock.
  const crashed = Bun.spawn([process.execPath, "-e", `
    import { chmodSync, writeFileSync } from "node:fs";
    import { createServer } from "node:net";
    createServer().listen(${JSON.stringify(path)}, () => {
      chmodSync(${JSON.stringify(path)}, 0o600);
      writeFileSync(${JSON.stringify(ready)}, "ready");
    });
  `], { stdout: "pipe", stderr: "pipe" });
  const broker = TurnBroker.forSocket(path);
  try {
    await waitForFile(ready);
    crashed.kill("SIGKILL");
    await crashed.exited;
    const starting = broker.listen();
    queueMicrotask(() => {
      unlinkSync(path);
      writeFileSync(path, "preserve this replacement");
    });
    await expect(starting).rejects.toThrow("changed during stale-socket probe");
    await broker.close();
    expect(readFileSync(path, "utf8")).toBe("preserve this replacement");
  } finally {
    crashed.kill();
    await crashed.exited;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reused PID with a different process start identity does not retain a stale lock", () => {
  if (!["darwin", "linux"].includes(process.platform)) return;
  const root = mkdtempSync("/tmp/cgw-lock-pid-");
  const path = join(root, "broker.sock");
  const oldOwner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const previousStart = process.platform === "darwin"
    ? "darwin:Mon Jan  1 00:00:00 1990"
    : "linux:00000000-0000-0000-0000-000000000000:1";
  mkdirSync(`${path}.lock`, { mode: 0o700 });
  writeFileSync(join(`${path}.lock`, oldOwner), JSON.stringify({ processStart: previousStart }), { mode: 0o600 });
  let release = () => {};
  try {
    release = acquireBrokerSocketLock(path, owner);
    expect(readdirSync(`${path}.lock`)).toEqual([owner]);
    const metadata = JSON.parse(readFileSync(join(`${path}.lock`, owner), "utf8"));
    expect(typeof metadata.processStart).toBe("string");
    expect(metadata.processStart).not.toBe(previousStart);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const contents of ["", JSON.stringify({ processStart: null }), JSON.stringify({ processStart: "invalid-start" })]) {
  test(`a live PID with unknown process identity keeps its lock (${contents || "legacy"})`, () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync("/tmp/cgw-lock-unknown-");
    const path = join(root, "broker.sock");
    const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    writeFileSync(join(`${path}.lock`, owner), contents, { mode: 0o600 });
    try {
      expect(() => acquireBrokerSocketLock(path, `${process.pid}-${randomBytes(16).toString("hex")}`))
        .toThrow("already owned");
      expect(readdirSync(`${path}.lock`)).toEqual([owner]);
      expect(readFileSync(join(`${path}.lock`, owner), "utf8")).toBe(contents);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const endpoint of ["public", "listener"] as const) {
test(`an old process preserves a replaced ${endpoint} socket through refused close and runtime exit`, async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync("/tmp/cgw-replaced-");
  const path = join(root, "broker.sock");
  const ready = join(root, "ready");
  const outcome = join(root, "outcome");
  const old = Bun.spawn([process.execPath, "-e", `
    import { writeFileSync } from "node:fs";
    import { TurnBroker } from ${brokerModule};
    const broker = TurnBroker.forSocket(${JSON.stringify(path)});
    await broker.listen();
    writeFileSync(${JSON.stringify(ready)}, "ready");
    await new Promise(resolve => process.stdin.once("data", resolve));
    try {
      await broker.close();
      writeFileSync(${JSON.stringify(outcome)}, "unexpected close");
    } catch (error) {
      writeFileSync(${JSON.stringify(outcome)}, error.message);
    }
    // No forced exit: the retired listener must not keep this process alive.
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const replacement = createServer(socket => socket.end("replacement alive"));
  try {
    await waitForFile(ready);
    const replacementPath = endpoint === "public" ? path : readlinkSync(path);
    unlinkSync(replacementPath); // Emulate an uncooperative peer only in this private fixture.
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(replacementPath, resolve);
    });
    const stdin = old.stdin as import("bun").FileSink;
    stdin.write("close\n");
    stdin.end();
    await waitForFile(outcome);
    expect(await old.exited).toBe(0);
    expect(readFileSync(outcome, "utf8")).toContain("replaced");
    expect(existsSync(path)).toBe(true);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", data => { socket.destroy(); resolve(String(data)); });
    });
    expect(reply).toBe("replacement alive");
  } finally {
    old.kill();
    await old.exited;
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test(`a failed close rejects a delayed connection and preserves the ${endpoint} replacement at exit`, async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync("/tmp/cgw-replaced-queued-");
  const path = join(root, "broker.sock");
  const ready = join(root, "ready");
  const queued = join(root, "queued");
  const outcome = join(root, "outcome");
  const old = Bun.spawn([process.execPath, "-e", `
    import { writeFileSync } from "node:fs";
    import { TurnBroker } from ${brokerModule};
    const broker = TurnBroker.forSocket(${JSON.stringify(path)});
    await broker.listen();
    const originalHandleSocket = broker.handleSocket.bind(broker);
    let delayedSocket;
    broker.handleSocket = socket => {
      delayedSocket = socket;
      writeFileSync(${JSON.stringify(queued)}, "queued");
    };
    writeFileSync(${JSON.stringify(ready)}, "ready");
    await new Promise(resolve => process.stdin.once("data", resolve));
    let closeMessage = "unexpected close";
    try {
      await broker.close();
    } catch (error) {
      closeMessage = error.message;
    }
    broker.handleSocket = originalHandleSocket;
    originalHandleSocket(delayedSocket);
    writeFileSync(${JSON.stringify(outcome)}, closeMessage);
    // No forced exit and no client-side disconnect: the delayed socket must be rejected here.
  `], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const replacement = createServer(socket => socket.end("replacement alive"));
  let queuedClient: ReturnType<typeof createConnection> | undefined;
  try {
    await waitForFile(ready);
    queuedClient = createConnection(path);
    await waitForFile(queued);
    const replacementPath = endpoint === "public" ? path : readlinkSync(path);
    unlinkSync(replacementPath); // Emulate an uncooperative peer only in this private fixture.
    await new Promise<void>((resolve, reject) => {
      replacement.once("error", reject);
      replacement.listen(replacementPath, resolve);
    });
    const stdin = old.stdin as import("bun").FileSink;
    stdin.write("close\n");
    stdin.end();
    await waitForFile(outcome);
    expect(await Promise.race([old.exited, Bun.sleep(750).then(() => "still running")])).toBe(0);
    expect(readFileSync(outcome, "utf8")).toContain("replaced");
    expect(existsSync(path)).toBe(true);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", data => { socket.destroy(); resolve(String(data)); });
    });
    expect(reply).toBe("replacement alive");
  } finally {
    queuedClient?.destroy();
    old.kill();
    await old.exited;
    if (replacement.listening) await new Promise<void>(resolve => replacement.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
}
