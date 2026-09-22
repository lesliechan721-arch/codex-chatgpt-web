const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createApiKeyVault } = require("../electron/api-key-vault.cjs");
const KEY = "k".repeat(40);

test("Linux basic_text cannot create a falsely protected persistent key", t => {
  const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "key-vault-"));
  t.after(() => fs.rmSync(coreHome, { recursive: true, force: true }));
  const vault = createApiKeyVault({ coreHome, platform: "linux", safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text",
    encryptString: () => { throw new Error("must not use basic_text"); },
  } });
  assert.equal(vault.store(KEY), "session");
  assert.equal(vault.read(createHash("sha256").update(KEY).digest("hex")), KEY);
  assert.equal(fs.existsSync(path.join(coreHome, "secrets", "api-client-key.json")), false);
  vault.dispose(); assert.equal(vault.read(), null);
});
test("corrupt, oversized, or non-regular sealed copies are not trusted", t => {
  const coreHome = fs.mkdtempSync(path.join(os.tmpdir(), "key-vault-"));
  t.after(() => fs.rmSync(coreHome, { recursive: true, force: true }));
  const file = path.join(coreHome, "secrets", "api-client-key.json"); fs.mkdirSync(path.dirname(file));
  const vault = createApiKeyVault({ coreHome, safeStorage: { isEncryptionAvailable: () => true } });
  for (const content of ["not-json", " ".repeat(9000), '{"version":1,"digest":"x","ciphertext":"y"}']) {
    fs.writeFileSync(file, content); assert.equal(vault.read(), null); assert.equal(vault.info().available, false);
  }
  fs.rmSync(file); fs.mkdirSync(file); assert.equal(vault.read(), null);
});
