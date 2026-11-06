const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountStore } = require("../electron/accounts.cjs");
const { createStateStore, createAccountStateStore } = require("../electron/state.cjs");

function fixture(t, kind = "production") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = {
    kind, coreHome: path.join(root, "core"), userData: path.join(root, "launcher"),
    codexHome: path.join(root, "codex"),
    browserPartition: kind === "development" ? "persist:codex-web-gpt-dev-chatgpt" : "persist:codex-web-gpt-chatgpt",
  };
  return { root, profile };
}

test("legacy registration preserves physical identities and retries incomplete migration once", t => {
  const { profile } = fixture(t);
  createStateStore(path.join(profile.userData, "launcher-state.json")).update({
    language: "zh-CN", coreSetupComplete: true, mcpSetupComplete: true,
    networkProxyUrl: "https://user:secret@proxy.example:8443/",
  });
  fs.mkdirSync(profile.coreHome, { recursive: true });
  const original = "legacy runtime configuration";
  fs.writeFileSync(path.join(profile.coreHome, "config.json"), original);
  let store = createAccountStore({ profile });
  const context = store.context();
  assert.equal(context.id, "default");
  assert.equal(context.legacy, true);
  assert.equal(context.coreHome, profile.coreHome);
  assert.equal(context.browserPartition, profile.browserPartition);
  assert.equal(context.limitsPath, path.join(profile.userData, "limits.json"));
  assert.equal(Object.isFrozen(context), true);
  assert.equal(fs.readFileSync(path.join(profile.coreHome, "config.json"), "utf8"), original);
  const state = createAccountStateStore({ sharedPath: path.join(profile.userData, "launcher-state.json"), accountPath: context.statePath });
  assert.equal(state.read().mcpSetupComplete, true);
  state.update({ networkProxyUrl: null });
  const registryPath = path.join(profile.userData, "accounts.json");
  const interrupted = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  interrupted.migration.complete = false;
  fs.writeFileSync(registryPath, JSON.stringify(interrupted));
  store = createAccountStore({ profile });
  assert.equal(store.snapshot().accounts.length, 1);
  assert.deepEqual(store.context(), context);
  assert.equal(createAccountStateStore({ sharedPath: path.join(profile.userData, "launcher-state.json"), accountPath: context.statePath }).read().networkProxyUrl, null);
  assert.equal(store.snapshot().migration.complete, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(registryPath).mode & 0o077, 0);
});

test("new account uses empty defaults and stable paths while the registry hides proxy credentials", t => {
  const { profile } = fixture(t);
  const store = createAccountStore({ profile });
  const sharedPath = path.join(profile.userData, "launcher-state.json");
  createAccountStateStore({ sharedPath, accountPath: store.context().statePath }).update({
    language: "ja", coreSetupComplete: true, mcpSetupComplete: true, autoApproveToolCalls: true,
    networkProxyUrl: "http://legacy:secret@proxy.example/",
  });
  const added = store.add({ name: "第二个账号" });
  const before = store.context(added.id);
  assert.equal(before.coreHome, path.join(profile.coreHome, "accounts", added.id, "core"));
  assert.equal(before.browserPartition, `${profile.browserPartition}-account-${added.id}`);
  const state = createAccountStateStore({ sharedPath, accountPath: before.statePath }).read();
  assert.equal(state.language, "ja");
  assert.equal(state.networkProxyUrl, null);
  assert.equal(state.autoApproveToolCalls, false);
  assert.equal(state.mcpSetupComplete, undefined);
  assert.equal(state.coreSetupComplete, undefined);
  assert.equal(fs.existsSync(before.coreHome), false);
  store.rename(added.id, "改名 / ../账号");
  assert.deepEqual(store.context(added.id), before);
  const custom = store.add({ name: "代理账号", networkProxyUrl: "https://user:private@proxy.example:8443/" });
  assert.equal(custom.proxyMode, "custom");
  assert.equal(JSON.stringify(store.snapshot()).includes("private"), false);
  assert.equal(fs.readFileSync(path.join(profile.userData, "accounts.json"), "utf8").includes("private"), false);
  assert.throws(() => store.context("../../outside"), /account/i);
});

test("failed target recovers the last loaded account once and then stops automatic recovery", t => {
  const { profile } = fixture(t);
  let store = createAccountStore({ profile });
  store.commitLoaded("default");
  const added = store.add({ name: "目标" });
  store.setPending(added.id);
  store.cancelPending();
  assert.equal(store.context().id, "default");
  assert.equal(store.snapshot().lastLoadedId, "default");
  assert.equal(store.snapshot().pendingId, null);
  assert.equal(store.snapshot().recoveryAttempted, false);
  store.setPending(added.id);
  store = createAccountStore({ profile });
  assert.equal(store.context().id, added.id);
  const recovered = store.failPending("Target local files could not load");
  assert.equal(recovered.pendingId, null);
  assert.equal(recovered.currentId, "default");
  assert.equal(recovered.recoveryAttempted, true);
  assert.equal(store.context().id, "default");
  store = createAccountStore({ profile });
  store.failPending("Recovery local files could not load");
  assert.equal(store.context(), null);
  assert.equal(createAccountStore({ profile }).context(), null);
  store.setPending(added.id);
  store.commitLoaded(added.id);
  assert.equal(store.snapshot().currentId, added.id);
  assert.equal(store.snapshot().lastLoadedId, added.id);
  assert.equal(store.snapshot().pendingId, null);
  assert.equal(store.snapshot().recoveryError, null);
});

test("identity summaries pin verified IDs and cannot be replaced by another login", t => {
  const { profile } = fixture(t);
  const store = createAccountStore({ profile });
  assert.equal(store.recordIdentity("default", { accessToken: "do not retain" }).status, "unverified");
  assert.equal(store.recordIdentity("default", { userId: "user-a", accountId: "workspace-a", accessToken: "secret" }).status, "matching");
  assert.equal(store.recordIdentity("default", { userId: "user-b", accountId: "workspace-a" }).status, "mismatch");
  assert.equal(store.snapshot().accounts[0].identity.userId, "user-a");
  assert.equal(createAccountStore({ profile }).snapshot().accounts[0].identityStatus, "mismatch");
  assert.equal(store.recordIdentity("default", null).status, "mismatch");
  assert.equal(store.recordIdentity("default", { userId: "user-a", accountId: "workspace-a" }).status, "matching");
  store.recordLogin("default", { authenticated: true, accessToken: "secret" });
  assert.equal(store.snapshot().accounts[0].lastLogin.status, "signed-in");
  assert.equal(fs.readFileSync(path.join(profile.userData, "accounts.json"), "utf8").includes("secret"), false);
});

test("removal is staged, disables an account on failure, and retries without touching another account", async t => {
  const { profile } = fixture(t);
  let store = createAccountStore({ profile });
  const other = store.add({ name: "保留" });
  assert.throws(() => store.beginRemoval("default"), /switch/i);
  store.commitLoaded(other.id);
  const context = store.context("default");
  fs.mkdirSync(context.coreHome, { recursive: true });
  fs.writeFileSync(path.join(context.coreHome, "config.json"), "account config");
  store.beginRemoval("default");
  assert.throws(() => store.setPending("default"), /remov/i);
  await assert.rejects(store.remove("default", { clearBrowserStorage: async () => { throw new Error("storage busy"); } }), /storage busy/);
  store = createAccountStore({ profile });
  assert.equal(store.snapshot().accounts.find(item => item.id === "default").status, "removal-failed");
  let cleared;
  await store.remove("default", { clearBrowserStorage: async partition => { cleared = partition; } });
  assert.equal(cleared, profile.browserPartition);
  assert.equal(store.snapshot().accounts.length, 1);
  assert.equal(store.context().id, other.id);
  store.beginRemoval(other.id);
  assert.equal(store.context(), null);
  await store.remove(other.id, { clearBrowserStorage: async () => {} });
  assert.equal(createAccountStore({ profile }).snapshot().accounts.length, 0);
  assert.equal(createAccountStore({ profile }).context(), null);
});

test("default cleanup preserves shared policies, keys, integration, resources and external configuration paths", async t => {
  const { root, profile } = fixture(t);
  const store = createAccountStore({ profile });
  const other = store.add({ name: "保留账号" });
  const shared = [
    "api-access.json", "api-access-routing-pending.json", "api-key-models.json", "service-endpoint.json",
    "secrets/api-client-key.json", "secrets/api-client-key-reuse.json", "codex/integration-journal.json",
    "codex/integration-journal.recovery.json", "versions/current/runtime/bun", "bin/tunnel-client",
    "runtime/program-resource", "hooks/interrupt.sh",
  ];
  const owned = [
    "browser/storage-state.json", "upstream-provider.json", "secrets/upstream-api-key.json",
    "secrets/tunnel-runtime-automatic.key", "tunnel/profiles/default.yaml", "responses-state.json",
    "runtime/session-continuity/task/context.json", "runtime/thread-environments.json",
    "chats/task.json",
  ];
  const otherData = path.join(store.context(other.id).coreHome, "responses-state.json");
  const external = path.join(root, "project", "config.json");
  const codexHistory = path.join(profile.codexHome, "sessions", "task.jsonl");
  const legacyLauncherLog = path.join(profile.userData, "logs", "launcher.jsonl");
  for (const relative of [...shared, ...owned]) {
    const file = path.join(profile.coreHome, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  for (const file of [otherData, external, codexHistory, legacyLauncherLog]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "preserve");
  }
  fs.writeFileSync(path.join(profile.coreHome, "config.json"), JSON.stringify({
    storageStatePath: external, tunnel: { runtimeKeyFile: external, profileDir: path.dirname(external) },
  }));
  store.commitLoaded(other.id);
  store.beginRemoval("default");
  await store.remove("default", { clearBrowserStorage: async () => {} });
  for (const relative of shared) assert.equal(fs.existsSync(path.join(profile.coreHome, ...relative.split("/"))), true, relative);
  for (const relative of owned) assert.equal(fs.existsSync(path.join(profile.coreHome, ...relative.split("/"))), false, relative);
  for (const file of [otherData, external, codexHistory]) assert.equal(fs.readFileSync(file, "utf8"), "preserve");
  assert.equal(fs.existsSync(legacyLauncherLog), false);
  assert.equal(fs.existsSync(path.join(profile.coreHome, "config.json")), false);
});

test("symlink escape blocks migration and account selection, and failed cleanup remains retryable", async t => {
  const { root, profile } = fixture(t);
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "preserve");
  fs.mkdirSync(profile.userData, { recursive: true });
  const accountsPath = path.join(profile.userData, "accounts");
  fs.symlinkSync(outside, accountsPath, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => createAccountStore({ profile }), /symbolic/i);
  const incomplete = JSON.parse(fs.readFileSync(path.join(profile.userData, "accounts.json"), "utf8"));
  assert.equal(incomplete.migration.complete, false);
  assert.equal(incomplete.accounts[0].id, "default");
  fs.unlinkSync(accountsPath);
  const store = createAccountStore({ profile });
  assert.equal(store.snapshot().accounts.length, 1);
  const other = store.add({ name: "删除测试" });
  const context = store.context(other.id);
  fs.mkdirSync(path.dirname(context.coreHome), { recursive: true });
  fs.symlinkSync(outside, context.coreHome, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => store.context(other.id), /symbolic/i);
  store.beginRemoval(other.id);
  let browserCleared = false;
  await assert.rejects(store.remove(other.id, { clearBrowserStorage: async () => { browserCleared = true; } }), /symbolic/i);
  assert.equal(browserCleared, false);
  assert.equal(store.snapshot().accounts.find(item => item.id === other.id).status, "removal-failed");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "preserve");
  fs.unlinkSync(context.coreHome);
  await store.remove(other.id, { clearBrowserStorage: async () => {} });
  assert.equal(store.snapshot().accounts.length, 1);
});

test("environment profiles keep separate registries and partitions, and invalid registries are not replaced", t => {
  const production = fixture(t);
  const development = fixture(t, "development");
  const productionStore = createAccountStore({ profile: production.profile });
  const developmentStore = createAccountStore({ profile: development.profile });
  productionStore.add({ name: "生产" });
  assert.equal(developmentStore.snapshot().accounts.length, 1);
  assert.notEqual(productionStore.context().browserPartition, developmentStore.context().browserPartition);
  const registryPath = path.join(production.profile.userData, "accounts.json");
  const broken = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  broken.accounts[0].id = "../../outside";
  fs.writeFileSync(registryPath, JSON.stringify(broken));
  assert.throws(() => createAccountStore({ profile: production.profile }), /registry is invalid/);
  assert.equal(JSON.parse(fs.readFileSync(registryPath, "utf8")).accounts[0].id, "../../outside");
});
