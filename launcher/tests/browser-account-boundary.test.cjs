const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createAccountStore } = require("../electron/accounts.cjs");
const { BrowserHost, IDLE_BROWSER_URL } = require("../electron/browser-host.cjs");
const { readChatGptAuthSession } = require("../electron/chatgpt-auth-session.cjs");

function hostFixture() {
  return Object.assign(Object.create(BrowserHost.prototype), {
    state: { authenticated: true }, turnTabs: new Map(), closingTurnTabs: new Map(),
    setState(patch) { Object.assign(this.state, patch); }, snapshot() { return { ...this.state }; },
    ready: async () => {}, activateHomeSurface() {}, logger: { info() {}, warn() {} },
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  });
}

function browserHostConstructor() {
  const filename = require.resolve("../electron/browser-host.cjs");
  const localRequire = createRequire(filename);
  const sandbox = { module: { exports: {} }, process, URL, AbortController, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    require: id => id === "electron" ? { WebContentsView: class {
      constructor() { this.webContents = { setZoomFactor() {} }; }
    } } : localRequire(id),
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), sandbox, { filename });
  const Host = sandbox.module.exports.BrowserHost;
  for (const method of ["bindShellZoomShortcuts", "bindChatGptBackendRecovery", "bindAuthenticationChanges", "bindWebContents"]) {
    Host.prototype[method] = () => {};
  }
  Host.prototype.initializePrimaryView = async () => {};
  return options => new Host({ window: { contentView: { addChildView() {} }, on() {} },
    getConnectorName: () => "Codex", loginWithPasskey: async () => {}, ...options });
}

test("closing account admission rejects active and retained execution without cancelling it", () => {
  const activities = [
    { status: "running", manualState: "awaiting-user" },
    { status: "ready", pendingBusinessDispatch: true },
    { status: "ready", unsettledOperations: 1 },
    { status: "ready", unknownSend: true },
    { status: "ready", approvalPending: true },
  ];
  for (const activity of activities) {
    const host = hostFixture();
    const tab = { ...activity, traceId: "active-trace", view: { webContents: { isDestroyed: () => false } } };
    host.turnTabs.set("tab", tab);
    assert.throws(() => host.closeAccountAdmission(), /busy|active|Finish/);
    assert.equal(host.accountAdmissionClosed, false);
    assert.equal(host.turnTabs.get("tab"), tab);
    assert.equal(tab.status, activity.status);
  }
  for (const field of ["manualOperation", "loginOperation", "sessionRefreshOperation", "authenticationProbe", "authenticationRefresh", "primaryRendererRecovery"]) {
    const host = hostFixture();
    host[field] = "pending";
    assert.throws(() => host.closeAccountAdmission(), /busy|active|Finish/, field);
    assert.equal(host.accountAdmissionClosed, false);
  }
  const retained = hostFixture();
  retained.continuityTransactions = new Map([["retained", { state: "send-possible", result: { tabId: "lost-page" } }]]);
  assert.throws(() => retained.closeAccountAdmission(), /retained ChatGPT execution/);
  assert.equal(retained.accountAdmissionClosed, false);
});

test("browser partitions bind exactly to the environment and immutable local account", () => {
  const create = browserHostConstructor();
  const id = "22222222-2222-4222-8222-222222222222";
  for (const profile of ["production", "development"]) {
    const legacyPartition = profile === "production" ? "persist:codex-web-gpt-chatgpt" : "persist:codex-web-gpt-dev-chatgpt";
    assert.equal(create({ profile, partition: legacyPartition }).partition, legacyPartition);
    for (const legacy of [true, false]) {
      const partition = legacy ? legacyPartition : `${legacyPartition}-account-${id}`;
      const context = { id: legacy ? "default" : id, profileKind: profile, legacy, browserPartition: partition };
      const host = create({ profile, partition, accountContext: context });
      assert.equal(Object.isFrozen(host.accountContext), true);
      context.browserPartition = "persist:tampered";
      assert.equal(host.accountContext.browserPartition, partition);
      for (const invalid of [
        { ...host.accountContext, profileKind: profile === "production" ? "development" : "production" },
        { ...host.accountContext, legacy: !legacy },
        { ...host.accountContext, browserPartition: `${partition}-extra` },
        { ...host.accountContext, id: "unsafe-name" },
      ]) assert.throws(() => create({ profile, partition, accountContext: invalid }), /profile|partition|account context/);
      assert.throws(() => create({ profile, partition: `${partition}-extra`, accountContext: host.accountContext }), /partition/);
    }
  }
});

test("a saved identity mismatch survives a manual-mode restart until the original identity is verified", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-identity-restart-"));
  try {
    const profile = { kind: "production", coreHome: path.join(root, "core"),
      userData: path.join(root, "launcher"), codexHome: path.join(root, "codex"),
      browserPartition: "persist:codex-web-gpt-chatgpt" };
    const original = { userId: "original-user", accountId: "original-account" };
    const store = createAccountStore({ profile });
    store.recordIdentity("default", original);
    store.recordIdentity("default", { userId: "other-user", accountId: original.accountId });
    const reopened = createAccountStore({ profile });
    const context = reopened.context("default");
    assert.equal(context.identityStatus, "mismatch");
    let mode = "manual";
    const host = browserHostConstructor()({ accountContext: context, partition: context.browserPartition,
      profile: context.profileKind, getBrowserInteractionMode: () => mode,
      logger: { info() {}, warn() {}, error() {} },
      verifyAccountIdentity: identity => reopened.recordIdentity(context.id, identity) });
    host.snapshot = () => ({ ...host.state });
    await host.ready();
    assert.equal(host.accountIdentityStatus, "mismatch");
    assert.equal(host.state.accountIdentityStatus, "mismatch");
    assert.equal(host.state.authenticated, false);
    assert.throws(() => host.assertAccountAdmission({ execution: true }), { code: "account_identity_mismatch" });
    assert.throws(() => host.beginManualTurn("manual-after-restart"), { code: "account_identity_mismatch" });
    await assert.rejects(host.beginTurn("automatic-after-restart"), { code: "account_identity_mismatch" });
    assert.throws(() => host.hasContinuityCapacity(), { code: "account_identity_mismatch" });

    mode = "automatic";
    let observed = original;
    host.view.webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isCrashed: () => false, getURL: () => "https://chatgpt.com/",
      executeJavaScript: async () => ({ sessionAuthenticated: true, sessionIdentity: observed,
        composer: true, newChat: true, url: "https://chatgpt.com/" }),
    });
    const verify = host.verifyAccountIdentity;
    host.verifyAccountIdentity = undefined;
    await host.probeAuthentication();
    assert.equal(host.state.authenticated, false, "authentication without an identity callback cannot clear a saved mismatch");
    host.verifyAccountIdentity = verify;
    for (const incomplete of [undefined, { userId: original.userId }]) {
      observed = incomplete;
      await host.probeAuthentication();
      assert.equal(host.accountIdentityStatus, "mismatch");
      assert.equal(host.state.authenticated, false);
      assert.equal(reopened.context().identityStatus, "mismatch");
    }
    observed = original;
    await host.probeAuthentication();
    assert.equal(host.accountIdentityStatus, "matching");
    assert.equal(host.state.authenticated, true);
    assert.equal(reopened.context().identityStatus, "matching");
    mode = "manual";
    assert.doesNotThrow(() => host.assertAccountAdmission({ execution: true }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed account admission permits completed history but blocks new turns, login and diagnostics", async () => {
  const host = hostFixture();
  host.turnTabs.set("history", { status: "ready", view: { webContents: { isDestroyed: () => false } } });
  host.closeAccountAdmission();
  assert.equal(host.accountAdmissionClosed, true);
  await assert.rejects(host.beginTurn("new-trace"), /account.*closed/i);
  assert.throws(() => host.beginManualTurn("new-trace"), /account.*closed/i);
  assert.throws(() => host.openLogin(), /account.*closed/i);
  assert.throws(() => host.openPasskeyLogin(), /account.*closed/i);
  await assert.rejects(host.inspectSession(true), /account.*closed/i);
  await assert.rejects(host.smokeTest(), /account.*closed/i);
  await assert.rejects(host.probeAuthentication(), /account.*closed/i);
  assert.equal(host.turnTabs.size, 1);
  host.resumeAccountAdmission();
  assert.equal(await host.withManualOperation("diagnostic", async () => "resumed"), "resumed");
});

test("a diagnostic waiting for browser readiness prevents the switch check from racing it", async () => {
  const host = hostFixture();
  let ready;
  host.ready = () => new Promise(resolve => { ready = resolve; });
  let calls = 0;
  const operation = host.withManualOperation("diagnostic", async () => { calls++; });
  assert.throws(() => host.closeAccountAdmission(), /busy|active|Finish/);
  assert.equal(host.accountAdmissionClosed, false);
  ready();
  await operation;
  assert.equal(calls, 1);
  host.closeAccountAdmission();
  assert.equal(host.accountAdmissionClosed, true);
});

test("a pending turn acquisition prevents switching before its browser tab exists", async () => {
  const host = hostFixture();
  let finish;
  host.beginTurnAcquisition = () => new Promise(resolve => { finish = resolve; });
  const turn = host.beginTurn("pending-trace");
  assert.throws(() => host.closeAccountAdmission(), /busy|active|Finish/);
  finish({ tabId: "completed" });
  await turn;
  host.closeAccountAdmission();
  await assert.rejects(host.beginTurn("next-trace"), /account.*closed/i);
});

test("a closed account rejects primary-page sign-in popups before creating another browser surface", () => {
  const host = hostFixture();
  let popup;
  host.view.webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: handler => { popup = handler; },
  });
  host.bindWebContents();
  host.closeAccountAdmission();
  assert.deepEqual(popup({ url: "https://auth.openai.com/authorize" }), { action: "deny" });
  assert.throws(() => host.createAuthView(), { code: "account_admission_closed" });
});

test("the authenticated endpoint yields only stable identity fields", async () => {
  const read = payload => readChatGptAuthSession(async () => ({
    ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => payload,
  }), "https://chatgpt.com", 1000);
  const result = await read({ user: { id: "user-123", email: "private@example.com", name: "Private" },
    account: { id: "account-456" }, workspace: { id: "workspace-789" }, accessToken: "private-token" });
  assert.deepEqual(result.sessionIdentity, { userId: "user-123", accountId: "account-456", workspaceId: "workspace-789" });
  assert.doesNotMatch(JSON.stringify(result), /private|Private/);
  assert.equal((await read({ user: { email: "private@example.com", name: "Private" } })).sessionIdentity, undefined);
  assert.equal((await read({ user: { id: "user-123" }, expires: "2000-01-01T00:00:00Z" })).sessionIdentity, undefined);
});

test("identity mismatch blocks old execution and capability inspection until a matching identity is checked", async () => {
  const host = hostFixture();
  const identities = [];
  let verdict = "mismatch";
  host.verifyAccountIdentity = identity => { identities.push(identity); return { status: verdict }; };
  host.view.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isCrashed: () => false, getURL: () => "https://chatgpt.com/",
    executeJavaScript: async () => ({ sessionAuthenticated: true, sessionIdentity: { userId: "wrong-user" },
      composer: true, newChat: true, url: "https://chatgpt.com/" }),
  });
  const tab = { status: "ready", view: { webContents: { isDestroyed: () => false } } };
  host.turnTabs.set("old", tab);
  const mismatched = await host.probeAuthentication();
  assert.equal(mismatched.authenticated, false);
  assert.equal(mismatched.accountIdentityStatus, "mismatch");
  await assert.rejects(host.beginTurn("next-trace"), /identity/i);
  assert.throws(() => host.beginManualTurn("next-trace"), /identity/i);
  await assert.rejects(host.runSessionInspection(true), /identity/i);
  assert.equal(tab.continuityInvalidated, true);
  verdict = "unverified";
  await host.probeAuthentication();
  assert.equal(host.state.authenticated, false, "missing identity cannot clear a mismatch");
  verdict = "matching";
  const matching = await host.probeAuthentication();
  assert.equal(matching.authenticated, true);
  assert.equal(matching.accountIdentityStatus, "matching");
  assert.deepEqual(identities[0], { userId: "wrong-user" });
  assert.equal(tab.continuityInvalidated, true, "pages invalidated during the mismatch stay unusable");
});

test("native idle-session changes apply the same account identity boundary", async () => {
  const host = hostFixture();
  host.view.webContents = { isDestroyed: () => false, getURL: () => IDLE_BROWSER_URL,
    session: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" },
      json: async () => ({ user: { id: "other-user" }, accessToken: "not-returned" }) }) } };
  host.verifyAccountIdentity = identity => {
    assert.deepEqual(identity, { userId: "other-user" });
    return { status: "mismatch" };
  };
  await host.refreshAuthenticationFromSession();
  assert.equal(host.state.authenticated, false);
  assert.equal(host.state.accountIdentityStatus, "mismatch");
});

test("an obsolete identity callback cannot publish authentication after the session changes", async () => {
  const host = hostFixture();
  host.state.authenticated = false;
  host.authenticationRevision = 0;
  let complete;
  host.verifyAccountIdentity = () => new Promise(resolve => { complete = resolve; });
  host.view.webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isCrashed: () => false, getURL: () => "https://chatgpt.com/",
    executeJavaScript: async () => ({ sessionAuthenticated: true, sessionIdentity: { userId: "old-user" } }),
  });
  const probe = host.probeAuthentication();
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => host.closeAccountAdmission(), /busy|active|Finish/);
  host.authenticationRevision++;
  complete({ status: "matching" });
  await probe;
  assert.equal(host.state.authenticated, false);
  assert.equal(host.accountIdentityStatus, undefined);
});
