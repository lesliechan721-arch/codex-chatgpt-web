import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { ContinuityRecoveryStore, withContinuityStorageLock, continuityProcessStartIdentity, continuityProcessInstanceStatus,
  continuityLauncherInstanceStatus } from "../src/adapters/chatgpt-web/continuity-recovery-store";
import { ContinuityRegistrationStore } from "../src/adapters/chatgpt-web/continuity-registration";
import { isVerifiableContinuityLauncherInstance } from "../src/adapters/chatgpt-web/continuity-contract";

const require = createRequire(import.meta.url);

test("Windows process creation identity agrees across backend, Launcher and protocol, including PID reuse", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const directory = mkdtempSync(join(tmpdir(), "cgw-win-instance-"));
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
    exec.mockRestore(); kill.mockRestore(); stat.mockRestore();
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
