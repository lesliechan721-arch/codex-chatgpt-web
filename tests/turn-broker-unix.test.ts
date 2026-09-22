import { expect, spyOn, test } from "bun:test";
import { fstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type ListenOptions } from "node:net";
import { join } from "node:path";
import { listenOnUnixBrokerSocket } from "../src/adapters/chatgpt-web/turn-broker-unix";

const unixTest = process.platform === "win32" ? test.skip : test;

unixTest("fd-only listener is private, close-on-exec, and closes its descriptor without unlink", async () => {
  const root = mkdtempSync("/tmp/cgw-unix-");
  const path = join(root, "broker.sock");
  const server = createServer();
  const originalListen = server.listen.bind(server);
  let fd = -1;
  const { dlopen } = await import("bun:ffi");
  const flags = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    fcntl: { args: ["i32", "i32"], returns: "i32" },
  });
  const listen = spyOn(server, "listen").mockImplementation((options, callback) => {
    fd = (options as { fd: number }).fd;
    expect(flags.symbols.fcntl(fd, 1) & 1).toBe(1); // F_GETFD, FD_CLOEXEC before adoption
    expect(statSync(path).mode & 0o777).toBe(0o600);
    return originalListen(options as ListenOptions, callback as () => void);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      listenOnUnixBrokerSocket(server, path, resolve);
    });
    expect(fstatSync(fd).isSocket()).toBe(true);
    const before = statSync(path);
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(() => fstatSync(fd)).toThrow("EBADF");
    expect(statSync(path).ino).toBe(before.ino);
  } finally {
    listen.mockRestore();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    flags.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const asynchronous of [false, true]) {
unixTest(`failed fd adoption releases the descriptor without a pathname fallback (async: ${asynchronous})`, async () => {
  const root = mkdtempSync("/tmp/cgw-unix-failed-");
  const path = join(root, "broker.sock");
  const server = createServer();
  const failure = new Error("injected fd adoption failure");
  let fd = -1;
  const listen = spyOn(server, "listen").mockImplementation(options => {
    fd = (options as { fd: number }).fd;
    if (!asynchronous) throw failure;
    queueMicrotask(() => server.emit("error", failure));
    return server;
  });
  try {
    await expect(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      listenOnUnixBrokerSocket(server, path, resolve);
    })).rejects.toBe(failure);
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(() => fstatSync(fd)).toThrow("EBADF");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
  } finally {
    listen.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
}

unixTest("binding a used Unix path preserves its listener and reports the native errno", async () => {
  const root = mkdtempSync("/tmp/cgw-unix-used-");
  const path = join(root, "broker.sock");
  const owner = createServer(socket => socket.end("owner alive"));
  const contender = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.listen(path, resolve);
    });
    const before = statSync(path);
    expect(() => listenOnUnixBrokerSocket(contender, path, () => {})).toThrow("EADDRINUSE");
    expect(contender.listening).toBe(false);
    expect(statSync(path).ino).toBe(before.ino);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("error", reject);
      socket.once("data", data => { socket.destroy(); resolve(String(data)); });
    });
    expect(reply).toBe("owner alive");
  } finally {
    if (owner.listening) await new Promise<void>(resolve => owner.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
