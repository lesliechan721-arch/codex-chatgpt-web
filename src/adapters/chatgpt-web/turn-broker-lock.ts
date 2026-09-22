import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function processStartIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm can contain spaces and parentheses. Field 22 follows the final closing parenthesis.
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (start && /^\d+$/.test(start) && boot) return `linux:${boot}:${start}`;
    } else if (process.platform === "darwin") {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      if (start) return `darwin:${start}`;
    }
  } catch {
    // Missing process identity is not evidence of death. Keep the lock unless ESRCH proves exit.
  }
  return null;
}

function removeOwner(directory: string, owner: string): void {
  try {
    unlinkSync(join(directory, owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    // Never recursively remove the shared directory: a new owner may already have replaced it.
    rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Serialize Unix endpoint lifetimes across processes, including stale-socket probing. */
export function acquireBrokerSocketLock(socketPath: string, owner: string): () => void {
  const lockPath = `${socketPath}.lock`;
  const staging = `${lockPath}.${owner}`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    writeFileSync(join(staging, owner), JSON.stringify({ processStart: processStartIdentity(process.pid) }), {
      mode: 0o600, flag: "wx",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Publish a NONEMPTY directory atomically. rename cannot replace another nonempty lock.
        // This also avoids the mkdir-then-write gap during recovery by competing processes.
        renameSync(staging, lockPath);
        return () => removeOwner(lockPath, owner);
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      const stat = lstatSync(lockPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
        throw new Error(`ChatGPT web broker ownership lock is unsafe: ${lockPath}`);
      }
      let entries: string[];
      try {
        entries = readdirSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (entries.length === 0) continue;
      const previousOwner = entries[0]!;
      if (entries.length !== 1 || !/^[1-9]\d*-[a-f0-9]{32}$/.test(previousOwner)) {
        throw new Error(`ChatGPT web broker ownership lock is invalid: ${lockPath}`);
      }
      const pid = Number(previousOwner.split("-", 1)[0]);
      if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) {
        throw new Error(`ChatGPT web broker ownership lock has an invalid PID: ${lockPath}`);
      }
      let exited = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        exited = (error as NodeJS.ErrnoException).code === "ESRCH";
      }
      if (!exited) {
        const marker = join(lockPath, previousOwner);
        try {
          const markerStat = lstatSync(marker);
          if (!markerStat.isFile() || markerStat.size > 512 || (markerStat.mode & 0o077) !== 0
            || (typeof process.getuid === "function" && markerStat.uid !== process.getuid())) {
            throw new Error(`ChatGPT web broker owner marker is unsafe: ${lockPath}`);
          }
          const text = readFileSync(marker, "utf8");
          // Empty markers came from the earlier lock format. Do not steal them from a live PID.
          const previousStart: unknown = text ? JSON.parse(text).processStart : null;
          const currentStart = processStartIdentity(pid);
          // Corrupt or foreign-format metadata is not proof that the observed process exited.
          const knownStart = typeof previousStart === "string" && (
            process.platform === "linux" && /^linux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d+$/.test(previousStart)
            || process.platform === "darwin" && /^darwin:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(previousStart)
          );
          exited = knownStart
            && currentStart !== null && previousStart !== currentStart;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
      }
      if (!exited) {
        throw new Error(`ChatGPT web broker socket is already owned by another process: ${socketPath}`);
      }
      // Remove only the observed dead owner's unique marker. A delayed reaper cannot delete
      // a successor's marker, even if the filesystem has reused the directory's inode.
      console.info(`[chatgpt-web] broker lifecycle ${JSON.stringify({
        event: "stale_lock_cleanup_requested", pid: process.pid, socketPath, owner, previousOwner,
        reason: "owner_exited_or_process_instance_changed",
      })}`);
      removeOwner(lockPath, previousOwner);
    }
    throw new Error(`ChatGPT web broker ownership changed during startup: ${socketPath}`);
  } finally {
    removeOwner(staging, owner);
  }
}

/** Confirm that the published lock still names this exact broker owner. */
export function brokerSocketLockOwnedBy(socketPath: string, owner: string): boolean {
  const lockPath = `${socketPath}.lock`;
  try {
    const lockStat = lstatSync(lockPath);
    if (!lockStat.isDirectory() || (lockStat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && lockStat.uid !== process.getuid())) return false;
    const entries = readdirSync(lockPath);
    if (entries.length !== 1 || entries[0] !== owner) return false;
    const markerStat = lstatSync(join(lockPath, owner));
    return markerStat.isFile() && markerStat.size <= 512 && (markerStat.mode & 0o077) === 0
      && (typeof process.getuid !== "function" || markerStat.uid === process.getuid());
  } catch {
    return false;
  }
}
