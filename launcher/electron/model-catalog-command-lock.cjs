const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const DEFAULT_RETRY_MS = 25;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROCESS_IDENTITY_RECHECK_MS = 1_000;

function processStartIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (start && /^\d+$/.test(start) && boot) return `linux:${boot}:${start}`;
    } else if (process.platform === "darwin") {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      if (start) return `darwin:${start}`;
    } else if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot) return null;
      const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const start = execFileSync(powershell, [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], {
        encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (/^\d+$/.test(start)) return `win32:${start}`;
    }
  } catch {
    // Missing process identity is not evidence of death. Keep the lock unless ESRCH proves exit.
  }
  return null;
}

function knownProcessStartIdentity(value) {
  if (typeof value !== "string") return false;
  if (process.platform === "linux") {
    return /^linux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d+$/.test(value);
  }
  if (process.platform === "darwin") {
    return /^darwin:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value);
  }
  return process.platform === "win32" && /^win32:\d+$/.test(value);
}

function privateEntry(stat) {
  return (process.platform === "win32" || (stat.mode & 0o077) === 0)
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function removeOwner(directory, owner) {
  try { fs.unlinkSync(path.join(directory, owner)); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try { fs.rmdirSync(directory); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code ?? "")) throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireModelCatalogCommandLock(markerPath, options = {}) {
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockPath = `${markerPath}.lock`;
  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const staging = `${lockPath}.${owner}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  let observedOwner = null;
  let observedStartCheckedAt = 0;
  let observedCurrentStart = null;
  try {
    fs.writeFileSync(path.join(staging, owner), JSON.stringify({
      processStart: processStartIdentity(process.pid),
    }), { flag: "wx", mode: 0o600 });
    for (;;) {
      try {
        // Publish a non-empty owner directory atomically. A competing rename cannot replace it.
        fs.renameSync(staging, lockPath);
        return () => removeOwner(lockPath, owner);
      } catch (error) {
        const code = error?.code ?? "";
        const collision = code === "ENOTEMPTY" || code === "EEXIST"
          || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));
        if (!collision) throw error;
      }

      const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (!stat) {
        if (Date.now() >= deadline) throw new Error("Could not acquire the API-key model catalog command lock");
        await sleep(retryMs);
        continue;
      }
      if (!stat.isDirectory() || !privateEntry(stat)) {
        throw new Error(`API-key model catalog command lock is unsafe: ${lockPath}`);
      }
      let entries;
      try { entries = fs.readdirSync(lockPath); }
      catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (entries.length === 0) {
        if (Date.now() >= deadline) throw new Error("Another API-key model catalog command is still finishing");
        await sleep(retryMs);
        continue;
      }
      const previousOwner = entries[0];
      if (entries.length !== 1 || !/^[1-9]\d*-[a-f0-9]{32}$/.test(previousOwner)) {
        throw new Error(`API-key model catalog command lock is invalid: ${lockPath}`);
      }
      const pid = Number(previousOwner.split("-", 1)[0]);
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) {
        throw new Error(`API-key model catalog command lock has an invalid PID: ${lockPath}`);
      }
      let exited = false;
      try { process.kill(pid, 0); }
      catch (error) { exited = error?.code === "ESRCH"; }
      if (!exited) {
        const marker = path.join(lockPath, previousOwner);
        try {
          const markerStat = fs.lstatSync(marker);
          if (!markerStat.isFile() || markerStat.size > 512 || !privateEntry(markerStat)) {
            throw new Error(`API-key model catalog command owner marker is unsafe: ${lockPath}`);
          }
          const text = fs.readFileSync(marker, "utf8");
          const previousStart = text ? JSON.parse(text).processStart : null;
          const now = Date.now();
          if (previousOwner !== observedOwner || now - observedStartCheckedAt >= PROCESS_IDENTITY_RECHECK_MS) {
            observedOwner = previousOwner;
            observedStartCheckedAt = now;
            observedCurrentStart = processStartIdentity(pid);
          }
          exited = knownProcessStartIdentity(previousStart)
            && observedCurrentStart !== null && previousStart !== observedCurrentStart;
        } catch (error) {
          if (error?.code === "ENOENT") continue;
          throw error;
        }
      }
      if (exited) {
        // Remove only the observed owner's unique marker. A delayed reaper cannot delete a successor.
        removeOwner(lockPath, previousOwner);
        observedOwner = null;
        observedCurrentStart = null;
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Another API-key model catalog command is still running");
      await sleep(retryMs);
    }
  } finally {
    removeOwner(staging, owner);
  }
}

module.exports = {
  acquireModelCatalogCommandLock,
  processStartIdentity,
};
