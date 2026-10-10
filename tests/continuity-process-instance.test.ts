import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import * as windowsLock from "../src/adapters/chatgpt-web/continuity-lock-windows";
import { ContinuityRecoveryStore, withContinuityStorageLock, continuityProcessStartIdentity, continuityProcessInstanceStatus,
  continuityLauncherInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { isVerifiableContinuityLauncherInstance } from "../src/adapters/chatgpt-web/continuity-contract";

const require = createRequire(import.meta.url);

test("Windows process creation identity agrees across backend, Launcher and protocol, including PID reuse", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-instance-"));
  const move = platform.value === "win32" ? undefined
    : spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation((source, destination) => {
      fs.renameSync(source, destination);
    });
  let start = "134045280001234567\r\n";
  let unreadable = false;
  let exited = false;
  const execute = (file: string, args: readonly string[], options: childProcess.ExecFileSyncOptions) => {
    expect(file).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(args[4]).toContain(`GetProcessById(${process.pid})`);
    expect(args[4]).toContain("ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)");
    expect(options.timeout).toBe(5000);
    expect(options.windowsHide).toBe(true);
    if (unreadable) throw new Error("Access denied or probe timeout");
    return start;
  };
  const exec = spyOn(childProcess, "execFileSync").mockImplementation(execute as typeof childProcess.execFileSync);
  const kill = spyOn(process, "kill").mockImplementation(() => {
    if (exited) throw Object.assign(new Error("No process"), { code: "ESRCH" });
    return true;
  });
  // Windows stat permissions are synthesized by libuv and do not represent ACLs.
  const originalStat = fs.lstatSync;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: string) => {
    const value = originalStat(path);
    value.mode = (value.mode & ~0o777) | (value.isDirectory() ? 0o777 : 0o666);
    return value;
  }) as typeof fs.lstatSync);
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const module = { exports: {} as Record<string, any> };
    runInNewContext(readFileSync(require.resolve("../launcher/electron/continuity-process-instance.cjs"), "utf8"), {
      module, process,
      require: (name: string) => name === "node:child_process" ? { execFileSync: execute } : require(name),
      structuredClone,
    });
    const launcher = module.exports;
    const instance = launcher.launcherInstance({});
    expect(instance.startIdentity).toBe("win32:134045280001234567");
    expect(continuityProcessStartIdentity(process.pid)).toBe(instance.startIdentity);
    expect(isVerifiableContinuityLauncherInstance(instance)).toBe(true);
    const owner = { id: "a".repeat(64), pid: process.pid, startIdentity: instance.startIdentity };
    const registration = new ContinuityRegistrationStore(directory); registration.initialize();
    const store = new ContinuityRecoveryStore(directory);
    const input = { thread: "b".repeat(64), scope: "c".repeat(64), owner,
      logicalWorkId: "work", instructionIdentity: "instruction", workPayloadDigest: "d".repeat(64),
      snapshotDigest: "e".repeat(64), dispatchProtocolComplete: true, createPage: true };
    store.admitWork(input);
    store.markAttempt(input.thread, { scope: input.scope }, { logicalWorkId: "work", attempt: 0, stage: "page-possible", launcherInstance: instance });
    expect(new ContinuityRecoveryStore(directory).get(input.thread)!.owner).toEqual(owner);
    const lock = join(directory, "stale.write.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(join(lock, `${owner.pid}-${"f".repeat(32)}`), JSON.stringify(owner));
    expect(() => withContinuityStorageLock(lock, () => "must not run")).toThrow("busy");
    unreadable = true;
    expect(() => withContinuityStorageLock(lock, () => "must not run")).toThrow("not verifiably exited");
    unreadable = false; exited = true;
    expect(withContinuityStorageLock(lock, () => "reclaimed")).toBe("reclaimed");
    exited = false;
    for (const status of [launcher.launcherProcessInstanceStatus(instance), continuityProcessInstanceStatus(owner), continuityLauncherInstanceStatus(instance)]) expect(status).toBe("live");
    // Restart and PID reuse produce a different creation time even if the PID is unchanged.
    start = "134045280001234568\r\n";
    expect(launcher.launcherInstance({}).startIdentity).not.toBe(instance.startIdentity);
    expect(launcher.launcherProcessInstanceStatus(instance)).toBe("exited");
    expect(continuityProcessInstanceStatus(owner)).toBe("exited");
    unreadable = true;
    expect(launcher.launcherProcessInstanceStatus(instance)).toBe("unverified");
    expect(continuityProcessInstanceStatus(owner)).toBe("unverified");
    exited = true;
    expect(launcher.launcherProcessInstanceStatus(instance)).toBe("exited");
    expect(continuityProcessInstanceStatus(owner)).toBe("exited");
    exited = false; unreadable = false;
    for (const invalid of ["", "0", "-1", "2026-10-10", "134045280001234567\n134045280001234568", "unverified"]) {
      start = invalid;
      expect(launcher.processStartIdentity(process.pid)).toBeNull();
      expect(continuityProcessStartIdentity(process.pid)).toBeNull();
      expect(isVerifiableContinuityLauncherInstance({ ...instance, startIdentity: `win32:${invalid}` })).toBe(false);
    }
    expect(launcher.launcherInstance({}).startIdentity).toBe("unverified");
    expect(launcher.processStartIdentity("1; exit" as any)).toBeNull();
    expect(continuityProcessStartIdentity("1; exit" as any)).toBeNull();
  } finally {
    Object.defineProperty(process, "platform", platform);
    exec.mockRestore(); kill.mockRestore(); stat.mockRestore(); move?.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("POSIX recovery files and existing lock directories reject public permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "cgw-posix-permissions-"));
  try {
    new ContinuityRegistrationStore(directory).initialize();
    expect(new ContinuityRecoveryStore(directory).get("a".repeat(64))).toBeUndefined();
    fs.chmodSync(join(directory, "recovery.json"), 0o644);
    expect(() => new ContinuityRecoveryStore(directory).get("a".repeat(64))).toThrow("not reset");
    const lock = join(directory, "unsafe.write.lock");
    fs.mkdirSync(lock); fs.chmodSync(lock, 0o755);
    fs.writeFileSync(join(lock, "owner"), "existing lock");
    expect(() => withContinuityStorageLock(lock, () => "must not run")).toThrow("unsafe");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Windows lock acquisition preserves an existing file without attempting replacement", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-file-lock-"));
  const lock = join(directory, "write.lock");
  fs.writeFileSync(lock, "other-owner");
  const rename = spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation(() => {
    throw new Error("An existing file must not be replaced");
  });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() => withContinuityStorageLock(lock, () => "must not run")).toThrow("busy");
    expect(readFileSync(lock, "utf8")).toBe("other-owner");
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual(["write.lock"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    rename.mockRestore(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows lock publication preserves a file created after the missing-lock inspection", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-file-lock-race-"));
  const lock = join(directory, "write.lock");
  const originalStat = fs.lstatSync, originalRename = fs.renameSync;
  let inserted = false, operationRan = false;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
    if (path === lock && !inserted) {
      inserted = true;
      fs.writeFileSync(lock, "other-owner", { flag: "wx" });
      throw Object.assign(new Error("Lock was absent at inspection"), { code: "ENOENT" });
    }
    return originalStat(path);
  }) as typeof fs.lstatSync);
  // Model the original Windows rename, including its successful replacement.
  const rename = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (fs.existsSync(destination) && originalStat(destination).isFile()) fs.unlinkSync(destination);
    return originalRename(source, destination);
  });
  // Real Windows runs use the native no-replace operation; other hosts model
  // that boundary here and exercise the native API in the Windows-only suite.
  const move = platform.value === "win32" ? undefined
    : spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation((source, destination) => {
      if (fs.existsSync(destination)) throw Object.assign(new Error("Destination exists"), { code: "EEXIST" });
      originalRename(source, destination);
    });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() => withContinuityStorageLock(lock, () => { operationRan = true; })).toThrow("busy");
    expect(operationRan).toBe(false);
    expect(readFileSync(lock, "utf8")).toBe("other-owner");
    expect(fs.readdirSync(directory)).toEqual(["write.lock"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    stat.mockRestore(); rename.mockRestore(); move?.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const code of ["EPERM", "EACCES"]) test(`Windows ${code} during a lock publication race preserves the unverified owner`, () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-lock-race-"));
  const lock = join(directory, "write.lock");
  const ownerFile = `${process.pid}-${"f".repeat(32)}`;
  fs.mkdirSync(lock);
  fs.writeFileSync(join(lock, ownerFile), JSON.stringify({ id: "a".repeat(64), pid: process.pid, startIdentity: "unverified" }));
  const originalStat = fs.lstatSync;
  let firstObservation = true;
  const stat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
    if (path === lock && firstObservation) {
      firstObservation = false;
      throw Object.assign(new Error("The competing lock is not visible yet"), { code: "ENOENT" });
    }
    return originalStat(path);
  }) as typeof fs.lstatSync);
  const rename = spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation(() => {
    throw Object.assign(new Error("The competing lock is now present"), { code });
  });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() => withContinuityStorageLock(lock, () => "must not run")).toThrow("not verifiably exited");
    expect(fs.readdirSync(lock)).toEqual([ownerFile]);
    expect(readFileSync(join(lock, ownerFile), "utf8")).toContain("unverified");
    expect(fs.readdirSync(directory)).toEqual(["write.lock"]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    stat.mockRestore(); rename.mockRestore(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows lock publication permission failure without a competing lock retains the original error", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-lock-denied-"));
  const denied = Object.assign(new Error("Lock directory access denied"), { code: "EPERM" });
  const rename = spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation(() => { throw denied; });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() => withContinuityStorageLock(join(directory, "write.lock"), () => "must not run")).toThrow(denied);
    expect(fs.readdirSync(directory)).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", platform);
    rename.mockRestore(); rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows durability confirmation uses a writable handle and preserves the accepted journal", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-sync-"));
  try {
    new ContinuityRegistrationStore(directory).initialize();
    const store = new ContinuityRecoveryStore(directory);
    const input = { thread: "b".repeat(64), scope: "c".repeat(64),
      owner: { id: "a".repeat(64), pid: process.pid, startIdentity: "unverified" },
      logicalWorkId: "work", instructionIdentity: "instruction", workPayloadDigest: "d".repeat(64),
      snapshotDigest: "e".repeat(64), dispatchProtocolComplete: true, createPage: true };
    const accepted = store.admitWork(input);
    const file = join(directory, "recovery.json");
    const before = readFileSync(file, "utf8");
    const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
    const readOnly = new Set<number>();
    const open = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      const fd = originalOpen(path, flags, mode);
      if (path === file && flags === "r") readOnly.add(fd);
      return fd;
    });
    const sync = spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (readOnly.has(fd)) throw Object.assign(new Error("FlushFileBuffers requires write access"), { code: "EACCES" });
      return originalSync(fd);
    });
    const move = platform.value === "win32" ? undefined
      : spyOn(windowsLock, "moveContinuityLockWithoutReplacement").mockImplementation((source, destination) => {
        fs.renameSync(source, destination);
      });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      expect(store.confirmDurable(input.thread, { scope: input.scope, expectedVersion: accepted.version })).toEqual(accepted);
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(sync).toHaveBeenCalled();
    } finally { open.mockRestore(); sync.mockRestore(); move?.mockRestore(); }
  } finally {
    Object.defineProperty(process, "platform", platform);
    rmSync(directory, { recursive: true, force: true });
  }
});
