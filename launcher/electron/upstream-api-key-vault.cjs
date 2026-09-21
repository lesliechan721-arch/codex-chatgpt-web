const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const validKey = key => typeof key === "string" && key.length > 0 && key.length <= 4096 && !/[\r\n\0]/.test(key);
const digest = key => createHash("sha256").update(key).digest("hex");

function createUpstreamApiKeyVault({ coreHome, safeStorage, platform = process.platform }) {
  const filePath = path.join(coreHome, "secrets", "upstream-api-key.json");
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
      if (!stat.isFile() || stat.size > 16_384) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed.version !== 1 || !/^[a-f0-9]{64}$/.test(parsed.digest)
        || typeof parsed.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.ciphertext)) return null;
      return parsed;
    } catch { return null; }
  }
  function readSaved(expectedDigest) {
    const saved = record();
    if (!saved || saved.digest !== expectedDigest || !encryptionAvailable()) return null;
    try {
      const key = safeStorage.decryptString(Buffer.from(saved.ciphertext, "base64"));
      if (!validKey(key) || digest(key) !== expectedDigest) return null;
      return key;
    } catch { return null; }
  }
  function info(expectedDigest) {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest || "")) return { available: false, storage: "unavailable" };
    if (memory && digest(memory) === expectedDigest) {
      return { available: true, storage: readSaved(expectedDigest) ? "os" : "session" };
    }
    return readSaved(expectedDigest)
      ? { available: true, storage: "os" }
      : { available: false, storage: "unavailable" };
  }
  function read(expectedDigest) {
    if (!/^[a-f0-9]{64}$/.test(expectedDigest || "")) return null;
    if (memory && digest(memory) === expectedDigest) return memory;
    return readSaved(expectedDigest);
  }
  function store(key) {
    if (!validKey(key)) throw new Error("invalid-upstream-key");
    memory = key;
    ignoreDisk = true;
    try { fs.rmSync(filePath, { force: true }); } catch {}
    if (encryptionAvailable()) {
      try {
        const ciphertext = safeStorage.encryptString(key).toString("base64");
        writePrivateFileAtomic(filePath, `${JSON.stringify({ version: 1, digest: digest(key), ciphertext })}\n`);
        ignoreDisk = false;
        return "os";
      } catch {}
    }
    return "session";
  }
  function clearStrict() {
    memory = null;
    ignoreDisk = true;
    fs.rmSync(filePath, { force: true });
  }
  return { info, read, store, clearStrict, dispose: () => { memory = null; } };
}

module.exports = { createUpstreamApiKeyVault, validUpstreamApiKey: validKey };
