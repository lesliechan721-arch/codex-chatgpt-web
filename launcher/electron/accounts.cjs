const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { createAccountStateStore } = require("./state.cjs");
const { normalizeNetworkProxyUrl } = require("./network-proxy-config.cjs");

const ACCOUNT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACCOUNT_STATUSES = new Set(["active", "removing", "removal-failed"]);
const IDENTITY_STATUSES = new Set(["unverified", "matching", "mismatch"]);
const LOGIN_STATUSES = new Set(["signed-in", "signed-out", "error", "unknown"]);

// The legacy home is also the application root. Keep resources and shared records there.
const LEGACY_ACCOUNT_PATHS = [
  "config.json", "upstream-provider.json", "upstream-provider-reset.json", "responses-state.json", "api-key-models-refresh-pending.json",
  "browser", "chats", "diagnostics", "logs", "tunnel",
  "secrets/tunnel-runtime.key", "secrets/tunnel-runtime-automatic.key", "secrets/tunnel-runtime-zero-risk.key",
  "secrets/upstream-api-key.json",
  "runtime/launcher-supervisor.json", "runtime/launcher-browser.json", "runtime/turn-broker.sock",
  "runtime/thread-environments.json", "runtime/luna-checkpoints.json",
  "runtime/context-capability-verification.json", "runtime/session-continuity", "runtime/dev-chat",
];

function validId(id) {
  return typeof id === "string" && (id === "default" || ACCOUNT_ID.test(id));
}

function accountName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Account name must contain 1–80 characters without control characters");
  }
  return value.trim();
}

function identitySummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = {};
  for (const key of ["userId", "accountId", "workspaceId"]) {
    if (value[key] === undefined || value[key] === null) continue;
    if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > 256
      || /[\u0000-\u001f\u007f]/.test(value[key])) return null;
    summary[key] = value[key].trim();
  }
  return summary.userId ? summary : null;
}

function errorSummary(value) {
  const message = value instanceof Error ? value.message : String(value || "Account operation failed");
  // Errors can include a rejected proxy URL. Never retain its credentials in the registry.
  return message.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1000);
}

function assertControlledPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Account path is outside its storage root");
  }
  let current = root;
  for (const component of ["", ...(relative ? relative.split(path.sep) : [])]) {
    if (component) current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Account storage path must not use symbolic links");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function assertRemovalTree(root, candidate) {
  assertControlledPath(root, candidate);
  let stat;
  try { stat = fs.lstatSync(candidate); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(candidate)) assertRemovalTree(root, path.join(candidate, name));
  }
}

function validateRegistry(value) {
  const invalid = () => { throw new Error("Account registry is invalid; existing accounts were not replaced"); };
  if (!value || value.version !== 1 || !Array.isArray(value.accounts)
    || value.migration?.version !== 1 || typeof value.migration.complete !== "boolean"
    || typeof value.recoveryAttempted !== "boolean"
    || (value.recoveryError !== null && typeof value.recoveryError !== "string")) invalid();
  const ids = new Set();
  for (const record of value.accounts) {
    if (!record || !validId(record.id) || ids.has(record.id)
      || record.legacy !== (record.id === "default") || !ACCOUNT_STATUSES.has(record.status)
      || !IDENTITY_STATUSES.has(record.identityStatus) || accountName(record.name) !== record.name
      || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || (record.removalError !== null && typeof record.removalError !== "string")
      || (record.identity !== null && !identitySummary(record.identity))) invalid();
    if (record.lastLogin !== null && (!record.lastLogin || !LOGIN_STATUSES.has(record.lastLogin.status)
      || typeof record.lastLogin.checkedAt !== "string" || !Number.isFinite(Date.parse(record.lastLogin.checkedAt)))) invalid();
    ids.add(record.id);
  }
  for (const key of ["currentId", "lastLoadedId", "pendingId"]) {
    if (value[key] !== null && (!validId(value[key])
      || !value.accounts.some(record => record.id === value[key] && record.status === "active"))) invalid();
  }
  return {
    version: 1, currentId: value.currentId, lastLoadedId: value.lastLoadedId, pendingId: value.pendingId,
    recoveryError: value.recoveryError, recoveryAttempted: value.recoveryAttempted,
    migration: { version: 1, complete: value.migration.complete },
    accounts: value.accounts.map(record => ({
      id: record.id, name: record.name, legacy: record.legacy, status: record.status,
      createdAt: record.createdAt, identity: identitySummary(record.identity), identityStatus: record.identityStatus,
      lastLogin: record.lastLogin === null ? null : { status: record.lastLogin.status, checkedAt: record.lastLogin.checkedAt },
      removalError: record.removalError,
    })),
  };
}

function newRecord(id, name, legacy) {
  return {
    id, name, legacy, status: "active", createdAt: new Date().toISOString(),
    identity: null, identityStatus: "unverified", lastLogin: null, removalError: null,
  };
}

function createAccountStore({ profile }) {
  if (!profile || !["production", "development"].includes(profile.kind)
    || ["coreHome", "userData", "codexHome"].some(key => typeof profile[key] !== "string" || !path.isAbsolute(profile[key]))
    || typeof profile.browserPartition !== "string" || !profile.browserPartition.startsWith("persist:")) {
    throw new Error("Account storage requires a resolved launcher profile");
  }
  // The environment profile is fixed for this store's lifetime.
  profile = Object.freeze({ ...profile });
  const registryPath = path.join(profile.userData, "accounts.json");
  const sharedPath = path.join(profile.userData, "launcher-state.json");
  const accountDataPath = id => path.join(profile.userData, "accounts", id);
  const makeContext = record => Object.freeze({
    id: record.id,
    identityStatus: record.identityStatus,
    coreHome: record.legacy ? profile.coreHome : path.join(profile.coreHome, "accounts", record.id, "core"),
    statePath: path.join(accountDataPath(record.id), "launcher-state.json"),
    limitsPath: record.legacy ? path.join(profile.userData, "limits.json") : path.join(accountDataPath(record.id), "limits.json"),
    browserPartition: record.legacy ? profile.browserPartition : `${profile.browserPartition}-account-${record.id}`,
    applicationHome: profile.coreHome,
    userData: profile.userData,
    codexHome: profile.codexHome,
    profileKind: profile.kind,
    legacy: record.legacy,
  });
  const validateContextPaths = context => {
    assertControlledPath(profile.coreHome, context.coreHome);
    assertControlledPath(profile.userData, context.statePath);
    assertControlledPath(profile.userData, context.limitsPath);
  };
  const write = value => {
    assertControlledPath(profile.userData, registryPath);
    writePrivateFileAtomic(registryPath, `${JSON.stringify(validateRegistry(value), null, 2)}\n`);
  };
  assertControlledPath(profile.userData, registryPath);
  let registry;
  try {
    registry = validateRegistry(JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, "")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    registry = {
      version: 1, currentId: "default", lastLoadedId: "default", pendingId: null,
      recoveryError: null, recoveryAttempted: false, migration: { version: 1, complete: false },
      accounts: [newRecord("default", "Default", true)],
    };
    write(registry);
  }
  if (!registry.migration.complete) {
    const legacy = registry.accounts.find(record => record.id === "default");
    if (!legacy || legacy.status !== "active") throw new Error("Default account migration cannot be completed");
    const context = makeContext(legacy);
    validateContextPaths(context);
    createAccountStateStore({ sharedPath, accountPath: context.statePath, migrateLegacy: true });
    registry = { ...registry, migration: { version: 1, complete: true } };
    write(registry);
  }
  const save = next => {
    write(next);
    registry = next;
  };
  const getRecord = (id, { allowRemoving = false } = {}) => {
    if (!validId(id)) throw new Error("Account ID is invalid");
    const record = registry.accounts.find(item => item.id === id);
    if (!record) throw new Error("Account does not exist");
    if (!allowRemoving && record.status !== "active") throw new Error("Account removal is incomplete; this account cannot be selected");
    return record;
  };
  const replaceRecord = record => save({
    ...registry, accounts: registry.accounts.map(item => item.id === record.id ? record : item),
  });
  const summary = record => {
    let proxyMode = "system";
    const context = makeContext(record);
    try {
      assertControlledPath(profile.userData, context.statePath);
      const state = JSON.parse(fs.readFileSync(context.statePath, "utf8").replace(/^\uFEFF/, ""));
      proxyMode = normalizeNetworkProxyUrl(state.networkProxyUrl) ? "custom" : "system";
    } catch (error) {
      if (error.code !== "ENOENT") proxyMode = "unknown";
    }
    return { ...structuredClone(record), proxyMode };
  };
  const snapshot = () => ({
    version: 1, currentId: registry.currentId, lastLoadedId: registry.lastLoadedId, pendingId: registry.pendingId,
    recoveryError: registry.recoveryError, recoveryAttempted: registry.recoveryAttempted,
    migration: { ...registry.migration }, accounts: registry.accounts.map(summary),
  });
  return {
    snapshot,
    context(id = registry.pendingId ?? registry.currentId) {
      if (id === null) return null;
      const context = makeContext(getRecord(id));
      validateContextPaths(context);
      return context;
    },
    add({ name, networkProxyUrl = null }) {
      name = accountName(name);
      networkProxyUrl = normalizeNetworkProxyUrl(networkProxyUrl);
      const record = newRecord(randomUUID(), name, false);
      const context = makeContext(record);
      validateContextPaths(context);
      createAccountStateStore({ sharedPath, accountPath: context.statePath }).update({ networkProxyUrl });
      save({ ...registry, accounts: [...registry.accounts, record] });
      return summary(record);
    },
    rename(id, name) {
      const record = getRecord(id);
      replaceRecord({ ...record, name: accountName(name) });
      return snapshot();
    },
    setPending(id) {
      getRecord(id);
      save({ ...registry, pendingId: id, recoveryError: null, recoveryAttempted: false });
      return snapshot();
    },
    cancelPending() {
      save({ ...registry, pendingId: null });
      return snapshot();
    },
    commitLoaded(id) {
      getRecord(id);
      if (registry.pendingId !== null && registry.pendingId !== id) throw new Error("Loaded account does not match the pending account");
      save({ ...registry, currentId: id, lastLoadedId: id, pendingId: null });
      return snapshot();
    },
    failPending(message) {
      const fallback = !registry.recoveryAttempted && registry.accounts.some(record => record.id === registry.lastLoadedId && record.status === "active")
        ? registry.lastLoadedId : null;
      save({
        ...registry, currentId: fallback, pendingId: null, recoveryError: errorSummary(message), recoveryAttempted: true,
      });
      return snapshot();
    },
    beginRemoval(id) {
      const record = getRecord(id, { allowRemoving: true });
      if (registry.currentId === id && registry.accounts.some(item => item.id !== id && item.status === "active")) {
        throw new Error("Switch to another account before removing the current account");
      }
      save({
        ...registry,
        currentId: registry.currentId === id ? null : registry.currentId,
        lastLoadedId: registry.lastLoadedId === id ? null : registry.lastLoadedId,
        pendingId: registry.pendingId === id ? null : registry.pendingId,
        accounts: registry.accounts.map(item => item.id === id ? { ...record, status: "removing", removalError: null } : item),
      });
      return snapshot();
    },
    async remove(id, { clearBrowserStorage } = {}) {
      const record = getRecord(id, { allowRemoving: true });
      if (record.status === "active") throw new Error("Begin account removal before clearing its data");
      try {
        if (typeof clearBrowserStorage !== "function") throw new Error("Account removal requires browser storage cleanup");
        const context = makeContext(record);
        const paths = record.legacy
          ? [
            ...LEGACY_ACCOUNT_PATHS.map(relative => [profile.coreHome, path.join(profile.coreHome, ...relative.split("/"))]),
            [profile.userData, accountDataPath(id)], [profile.userData, context.limitsPath],
            [profile.userData, path.join(profile.userData, "passkey-login")],
            [profile.userData, path.join(profile.userData, "logs")],
          ]
          : [
            [profile.coreHome, path.join(profile.coreHome, "accounts", id)],
            [profile.userData, accountDataPath(id)],
          ];
        for (const [root, candidate] of paths) assertRemovalTree(root, candidate);
        await clearBrowserStorage(context.browserPartition, context);
        for (const [root, candidate] of paths) {
          assertRemovalTree(root, candidate);
          fs.rmSync(candidate, { recursive: true, force: true });
        }
        save({ ...registry, accounts: registry.accounts.filter(item => item.id !== id) });
      } catch (error) {
        replaceRecord({ ...record, status: "removal-failed", removalError: errorSummary(error) });
        throw error;
      }
      return snapshot();
    },
    recordIdentity(id, identity) {
      const record = getRecord(id);
      const observedIdentity = identitySummary(identity);
      let status = record.identityStatus === "mismatch" ? "mismatch" : "unverified";
      let pinnedIdentity = record.identity;
      if (observedIdentity) {
        if (!pinnedIdentity) {
          pinnedIdentity = observedIdentity;
          status = "matching";
        } else if (Object.entries(pinnedIdentity).some(([key, value]) => observedIdentity[key] !== undefined && observedIdentity[key] !== value)) {
          status = "mismatch";
        } else if (Object.keys(pinnedIdentity).every(key => observedIdentity[key] !== undefined)) {
          status = "matching";
          pinnedIdentity = { ...pinnedIdentity, ...observedIdentity };
        }
      }
      replaceRecord({ ...record, identity: pinnedIdentity, identityStatus: status });
      return { status, identity: structuredClone(pinnedIdentity), observedIdentity };
    },
    recordLogin(id, result) {
      const record = getRecord(id);
      const status = result?.authenticated === true ? "signed-in"
        : result?.status === "error" || result?.error ? "error"
        : result?.authenticated === false || result?.status === "signed-out" ? "signed-out" : "unknown";
      replaceRecord({ ...record, lastLogin: { status, checkedAt: new Date().toISOString() } });
      return snapshot();
    },
  };
}

module.exports = { createAccountStore };
