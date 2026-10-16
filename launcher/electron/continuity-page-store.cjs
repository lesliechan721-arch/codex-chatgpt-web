const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { processStartIdentity, knownProcessStart, launcherProcessInstanceStatus } = require("./continuity-process-instance.cjs");

// The backend and Launcher share the existing registration -> journal lock order.
function withLock(directory, name, operation) {
  const lock = path.join(directory, name);
  const owner = `${process.pid}-${randomBytes(16).toString("hex")}`;
  const staging = `${lock}.${owner}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  let acquired = false;
  try {
    // The backend recognizes this same owner schema during crash recovery.
    const startIdentity = processStartIdentity(process.pid) ?? "unverified";
    fs.writeFileSync(path.join(staging, owner), JSON.stringify({ id: randomBytes(32).toString("hex"), pid: process.pid, startIdentity }), { mode: 0o600 });
    for (let attempt = 0; attempt < 4; attempt++) {
      let stat;
      try { stat = fs.lstatSync(lock); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!stat) {
        try {
          if (process.platform === "win32") {
            // Directory.Move refuses replacement, including a legacy file lock.
            const from = Buffer.from(staging, "utf16le").toString("base64"), to = Buffer.from(lock, "utf16le").toString("base64");
            require("node:child_process").execFileSync(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
              ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; [System.IO.Directory]::Move([System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${from}')),[System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${to}')))`],
              { timeout: 5000, windowsHide: true, stdio: "ignore" });
          } else fs.renameSync(staging, lock);
          acquired = true; break;
        } catch (error) {
          try { stat = fs.lstatSync(lock); } catch { throw error; }
        }
      }
      if (!stat.isDirectory() || process.platform !== "win32" && (stat.mode & 0o077) !== 0
        || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe continuity storage lock.");
      const entries = fs.readdirSync(lock);
      if (entries.length !== 1 || !/^[1-9]\d*-[a-f0-9]{32}$/.test(entries[0])) throw new Error("Unverified continuity storage lock.");
      const file = path.join(lock, entries[0]), ownerStat = fs.lstatSync(file);
      if (!ownerStat.isFile() || ownerStat.size > 1024 || process.platform !== "win32" && (ownerStat.mode & 0o077) !== 0
        || typeof process.getuid === "function" && ownerStat.uid !== process.getuid()) throw new Error("Unsafe continuity lock owner.");
      const previous = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!/^[a-f0-9]{64}$/.test(previous.id) || previous.pid !== Number(entries[0].split("-")[0])
        || !knownProcessStart(previous.startIdentity)
        || launcherProcessInstanceStatus({ ...previous, instanceId: previous.id }) !== "exited") throw new Error("Continuity page cleanup storage is busy.");
      fs.unlinkSync(file); fs.rmdirSync(lock);
    }
    if (!acquired) throw new Error("Continuity page cleanup ownership changed.");
    return operation();
  } finally {
    const target = acquired ? lock : staging;
    try { fs.unlinkSync(path.join(target, owner)); fs.rmdirSync(target); } catch {}
  }
}
function replace(file, value) {
  const temporary = `${file}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    const fd = fs.openSync(temporary, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") {
      const parent = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function privateObject(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 24 * 1024 * 1024 || process.platform !== "win32" && (stat.mode & 0o077) !== 0
    || typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Unsafe continuity page state file.");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 24 * 1024 * 1024) throw new Error("Oversized continuity page state file.");
  return JSON.parse(bytes.toString("utf8"));
}
function destroyedPage(tab, recovery, contents) {
  const { validRecovery, sameRecovery } = require("./continuity-recovery.cjs");
  const creation = tab?.continuityCreationRecovery;
  return contents?.isDestroyed() === true && validRecovery(creation)
    && sameRecovery(tab.continuityRecovery, recovery) && /^[a-f0-9]{32}$/.test(tab.continuityLeaseId)
    && ["installationId", "threadKey", "epoch"].every(key => creation[key] === recovery[key])
    ? { creation, leaseId: tab.continuityLeaseId } : undefined;
}
/** A physical epoch and creation nonce survive writer changes on the same document. */
function ownsDestroyedPage(record, page) {
  if (!page || record.epoch !== page.creation.epoch) return false;
  const creation = page.creation;
  const attempt = record.works?.[creation.logicalWorkId]?.attempts?.[creation.attempt];
  return attempt?.epoch === creation.epoch && attempt.transactionId === creation.transactionId
    && attempt.transactionVersion >= creation.transactionVersion && attempt.snapshotVersion >= creation.snapshotVersion
    // Preparation can temporarily clear the receipt while retaining the same creation
    // nonce. A contradictory receipt always denotes another physical document.
    && (attempt.pageReceiptId === undefined || attempt.pageReceiptId === page.leaseId);
}
/** Physical observation cannot grant execution rights to the document's old writer. */
function removeDestroyedPage(host, recovery, tab, contents = tab?.view?.webContents) {
  if (!recovery) return false;
  const directory = host.continuityAuthorityDirectories?.get(recovery.installationId);
  if (!directory) return false;
  return withLock(directory, "write.lock", () => withLock(directory, "recovery.write.lock", () => {
    const file = path.join(directory, "recovery.json");
    const document = privateObject(file);
    if (![3, 4].includes(document.version) || document.installation !== recovery.installationId) return false;
    const page = destroyedPage(tab, recovery, contents);
    if (tab?.continuityCreationRecovery !== undefined && !page) return false;
    const record = document.threads?.[recovery.threadKey];
    const attempt = record?.works?.[recovery.logicalWorkId]?.attempts?.[recovery.attempt];
    if (!record) {
      const registryFile = path.join(directory, "threads.json"), registry = privateObject(registryFile);
      const entry = registry.entries?.[recovery.threadKey];
      if (entry?.epoch === recovery.epoch && (entry.transactionId === recovery.transactionId || page)) {
        delete registry.entries[recovery.threadKey]; replace(registryFile, registry);
        return true;
      }
      return false;
    }
    const exactWriter = attempt && record.epoch === recovery.epoch
      && record.owner?.pid === recovery.ownerProcess.pid && record.owner?.startIdentity === recovery.ownerProcess.startIdentity
      && ["epoch", "snapshotVersion", "snapshotDigest", "transactionId", "transactionVersion"].every(key => attempt[key] === recovery[key])
      && record.transaction?.transactionId === recovery.transactionId && record.transaction?.version === recovery.transactionVersion;
    if (!exactWriter && !ownsDestroyedPage(record, page)) return false;
    delete document.threads[recovery.threadKey]; document.version = 4;
    replace(file, document);
    const registryFile = path.join(directory, "threads.json");
    const registry = privateObject(registryFile);
    delete registry.entries[recovery.threadKey]; replace(registryFile, registry);
    return true;
  }));
}
module.exports = { removeDestroyedPage };
