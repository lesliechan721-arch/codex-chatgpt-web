const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const validKey = key => typeof key === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(key);
const digest = key => createHash("sha256").update(key).digest("hex");

/** Optional recoverable copy for the GUI. The daemon continues to use only its SHA-256 policy. */
function createApiKeyVault({ coreHome, safeStorage, platform = process.platform }) {
  const filePath = path.join(coreHome, "secrets", "api-client-key.json");
  let memory = null;
  let ignoreDisk = false;
  function encryptionAvailable() {
    try {
      return safeStorage?.isEncryptionAvailable() === true
        && (platform !== "linux" || (typeof safeStorage.getSelectedStorageBackend?.() === "string"
          && !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())));
    } catch { return false; }
  }
  function record() {
    if (ignoreDisk) return null;
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size > 8192) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.digest)
        || typeof parsed.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.ciphertext)) return null;
      return parsed;
    } catch { return null; }
  }
  function info(expectedDigest) {
    if (memory && (!expectedDigest || digest(memory) === expectedDigest)) {
      const saved = record();
      return { available: true, storage: saved?.digest === digest(memory) ? "os" : "session" };
    }
    const saved = record();
    return saved && (!expectedDigest || saved.digest === expectedDigest) && encryptionAvailable()
      ? { available: true, storage: "os" } : { available: false, storage: "unavailable" };
  }
  function read(expectedDigest) {
    if (memory && (!expectedDigest || digest(memory) === expectedDigest)) return memory;
    const saved = record();
    if (!saved || (expectedDigest && saved.digest !== expectedDigest) || !encryptionAvailable()) return null;
    try {
      const key = safeStorage.decryptString(Buffer.from(saved.ciphertext, "base64"));
      if (!validKey(key) || digest(key) !== saved.digest) return null;
      return key;
    } catch { return null; }
  }
  function store(key) {
    if (!validKey(key)) throw new Error("invalid-key");
    memory = key;
    // A failed replacement must not expose the stale sealed copy in this session.
    ignoreDisk = true;
    try { fs.rmSync(filePath, { force: true }); } catch {}
    if (encryptionAvailable()) {
      try {
        const ciphertext = safeStorage.encryptString(key).toString("base64");
        writePrivateFileAtomic(filePath, JSON.stringify({ version: 1, digest: digest(key), ciphertext }) + "\n");
        ignoreDisk = false;
        return "os";
      } catch { /* Keychain/IO failures must not undo a saved access-mode change. */ }
    }
    return "session";
  }
  function retainOnly(expectedDigest) {
    if (memory && digest(memory) !== expectedDigest) memory = null;
    const saved = record();
    if (saved && saved.digest !== expectedDigest) {
      ignoreDisk = true;
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }
  return { info, read, store, retainOnly, dispose: () => { memory = null; } };
}

module.exports = { createApiKeyVault };
