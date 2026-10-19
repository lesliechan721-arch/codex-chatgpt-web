const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { RuntimeHost } = require("../electron/runtime.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const { createStateStore } = require("../electron/state.cjs");
const identity = require("../electron/connector-identity.cjs");
const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");

function fixture(context, profile = "production", mode = "automatic") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-mcp-setup-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const browserDescriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const logger = { info() {}, warn() {}, error() {} };
  const app = { getVersion: () => "current", getPath: () => root, isPackaged: false };
  const supervisor = new RuntimeSupervisor({ app, logger, sourceRoot: root, coreHome: root,
    browserDescriptorPath, launcherProfile: profile });
  const tunnel = { binaryPath: process.execPath, tunnelId: `tunnel_${"a".repeat(32)}`,
    runtimeKeyFile: path.join(root, "runtime.key"), profileDir: path.join(root, "profiles"),
    profileName: "mcp-setup", alias: "mcp-setup" };
  const config = { version: 3, releaseVersion: "current", mode: "full", browserHost: "launcher",
    browserInteractionMode: mode, browserHostDescriptorPath: browserDescriptorPath,
    ...(profile === "development" ? { purpose: "dev-harness" } : {}),
    host: "127.0.0.1", port: 17841, contextWindow: 256000,
    appName: mode === "manual" ? identity.CURRENT_MANUAL_CONNECTOR_NAME
      : profile === "development" ? identity.DEV_CONNECTOR_NAME : identity.CURRENT_CONNECTOR_NAME,
    chromeExecutablePath: process.execPath, storageStatePath: path.join(root, "storage.json"),
    brokerSocketPath: process.platform === "win32" ? "\\\\.\\pipe\\cgw-mcp-setup" : path.join(root, "broker.sock"),
    headed: true, solAvailable: true, proAvailable: true, autoApproveToolCalls: false,
    controlToken: "mcp-setup-current-control-token-0123456789abcdef", runtimeCommand: [process.execPath],
    tunnel, [mode === "manual" ? "manualTunnel" : "automaticTunnel"]: tunnel };
  fs.mkdirSync(tunnel.profileDir, { recursive: true });
  fs.writeFileSync(tunnel.runtimeKeyFile, "fixture runtime credential", { mode: 0o600 });
  const saveConfig = () => fs.writeFileSync(supervisor.configPath, JSON.stringify(config));
  saveConfig();
  supervisor.tunnel = { pid: process.pid, exitCode: null, signalCode: null };
  if (profile === "production") supervisor.daemon = { pid: process.pid, exitCode: null, signalCode: null };
  supervisor.writeState("ready");
  const stateStore = createStateStore(path.join(root, "launcher-state.json"));
  stateStore.update({ browserInteractionMode: mode, coreSetupComplete: true,
    mcpRuntimeInstalled: true, mcpSetupComplete: false, mcpSetupContract: "old-diagnostic-contract", mcpGuideStep: 2 });
  const host = new RuntimeHost({ app, logger, sourceRoot: root, coreHome: root,
    browserDescriptorPath, supervisor, launcherProfile: profile,
    getBrowserInteractionMode: () => mode });
  host.run = async () => assert.fail("Completing setup must not start a diagnostic CLI transaction");
  const handlers = new Map();
  const operations = [];
  const browser = { activeTraceId: null, verifyConnector: async () => {} };
  const sandbox = vm.createContext({
    handle: (channel, handler) => handlers.set(channel, handler),
    IS_DEV_PROFILE: profile === "development", MCP_SETUP_CONTRACT: identity.MCP_SETUP_CONTRACT,
    runtimeHost: host, browserHost: browser, stateStore, logger, Error,
    mainWindow: null, send() {}, publishOperation: value => operations.push(value),
  });
  const start = mainSource.indexOf('  handle("launcher:mcp-verify"');
  const end = mainSource.indexOf('  handle("launcher:doctor"', start);
  vm.runInContext(mainSource.slice(start, end), sandbox);
  return { root, config, saveConfig, host, supervisor, stateStore, browser, operations,
    complete: () => handlers.get("launcher:complete-mcp-setup")(),
    verify: () => handlers.get("launcher:mcp-verify")({ sender: { isFocused: () => false } }) };
}

for (const profile of ["production", "development"]) for (const mode of ["automatic", "manual"]) {
  test(`${profile}/${mode} completes valid saved setup without reading diagnostic evidence`, context => {
    const f = fixture(context, profile, mode);
    const record = path.join(f.root, "context-capability-verification.json");
    for (const content of [null, "invalid json", JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 2, binding: { appName: "old connector" } }),
      JSON.stringify({ version: 2, ok: true })]) {
      if (content === null) fs.rmSync(record, { force: true });
      else fs.writeFileSync(record, content);
      f.stateStore.update({ mcpSetupComplete: false });
      const completed = f.complete();
      assert.equal(completed.mcpSetupComplete, true);
      assert.equal(completed.mcpSetupConnectorName, f.config.appName);
      assert.equal(f.stateStore.read().mcpSetupComplete, true);
      assert.deepEqual(f.operations, []);
    }
    // A changed runtime file or old setup contract is not a request to repeat diagnostics.
    const entry = path.join(f.root, "runtime-entry.cjs");
    fs.writeFileSync(entry, "old runtime");
    f.config.runtimeCommand.push(entry);
    f.saveConfig();
    fs.writeFileSync(entry, "upgraded runtime at the same path");
    assert.equal(f.complete().mcpSetupComplete, true);
  });
}

test("completion rejects missing configuration steps, credentials, files, mode and runtime ownership", context => {
  const mutations = [
    f => f.stateStore.update({ coreSetupComplete: false }),
    f => f.stateStore.update({ mcpRuntimeInstalled: false }),
    f => { f.config.mode = "browser-only"; f.saveConfig(); },
    f => f.stateStore.update({ browserInteractionMode: "manual" }),
    f => fs.rmSync(f.config.tunnel.runtimeKeyFile),
    f => { f.config.tunnel.binaryPath = path.join(f.root, "missing-binary"); f.saveConfig(); },
    f => fs.rmSync(f.config.tunnel.profileDir, { recursive: true }),
    f => { f.config.appName = "Codex Native4"; f.saveConfig(); },
    f => f.supervisor.writeState("starting"),
    f => { f.supervisor.daemon = null; },
    f => { f.supervisor.tunnel = null; },
    f => { f.host.lifecycleOperation = "mcp-setup"; },
  ];
  if (process.platform !== "win32") mutations.push(f => fs.chmodSync(f.config.tunnel.runtimeKeyFile, 0o644));
  for (const mutate of mutations) {
    const f = fixture(context);
    mutate(f);
    assert.throws(f.complete);
    assert.equal(f.stateStore.read().mcpSetupComplete, false);
    assert.deepEqual(f.operations, []);
  }
});

for (const profile of ["production", "development"]) for (const mode of ["automatic", "manual"]) {
  test(`${profile}/${mode} diagnostic outcomes leave completed and incomplete setup unchanged`, async context => {
    const f = fixture(context, profile, mode);
    const healthy = { ok: true, checks: [{ id: "connector", status: "warning", message: "local check" }] };
    f.host.launcherControlEnvironment = () => ({});
    for (const completed of [false, true]) for (const outcome of ["active", "local-error", "failed", "cancelled", "timeout", "success"]) {
      f.stateStore.update({ mcpSetupComplete: completed });
      const before = f.stateStore.read();
      f.browser.activeTraceId = outcome === "active" ? "business-task" : null;
      f.host.doctor = f.host.devDoctor = async () => outcome === "local-error"
        ? { ok: false, checks: [{ id: "runtime", status: "error", message: "local runtime failure" }] } : healthy;
      f.host.run = async () => {
        if (outcome !== "success") throw new Error(`diagnostic ${outcome}`);
        return { stdout: JSON.stringify({ ok: true, evidence: { version: 2,
          binding: { profile, mode, appName: f.config.appName },
          receipts: { ordinary: { list: true, search: true, read: true },
            compaction: { list: true, search: true, read: true } } } }) };
      };
      const report = await f.verify();
      assert.equal(report.ok, outcome === "success");
      assert.deepEqual(f.stateStore.read(), before);
      assert.equal(f.operations.at(-1).status, outcome === "success" ? "completed" : "failed");
      if (outcome === "active") assert.equal(f.browser.activeTraceId, "business-task");
      assert.equal(f.complete().mcpSetupComplete, true);
    }
  });
}

for (const migrated of [false, true]) test(`runtime upgrade ${migrated ? "with connection migration resets" : "preserves"} setup completion`, async context => {
  const f = fixture(context);
  f.stateStore.update({ mcpSetupComplete: true, mcpSetupConnectorName: f.config.appName });
  let finished;
  const finishedStartup = new Promise(resolve => { finished = resolve; });
  const sandbox = vm.createContext({
    runtimeHost: { upgradeManagedRuntime: async () => ({ updated: true, mode: "full", connectorMigrated: migrated }),
      runtimeConfigSnapshot: () => ({ configured: true, config: f.config }), connectBridgeRoute: async () => ({}) },
    runtimeSupervisor: { startIfConfigured: async () => ({ status: "ready" }), readConfig: () => f.config },
    stateStore: f.stateStore, send() {}, logger: { info() {}, warn() {}, error() {} },
    connectorSetupStatePatch: identity.connectorSetupStatePatch, startCatalogVerificationMonitor() {},
    finishRuntimeStartup: finished, readPolicyFile: () => ({ policy: { mode: "openai" } }), path, CORE_HOME: f.root,
  });
  const start = mainSource.indexOf('} else void (async () => {');
  vm.runInContext(mainSource.slice(start + '} else '.length, mainSource.indexOf('  app.on("before-quit"', start)), sandbox);
  await finishedStartup;
  assert.equal(f.stateStore.read().mcpSetupComplete, !migrated);
});

function mcpViewHarness(f) {
  const ts = require("typescript");
  const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
  const component = source.slice(source.indexOf("function McpSurface("), source.indexOf("function ActivitySurface("));
  const transpiled = ts.transpileModule(component, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "element",
  } }).outputText;
  const translations = { exports: {} };
  const i18nSource = fs.readFileSync(path.join(__dirname, "../src/i18n.ts"), "utf8");
  const i18n = ts.transpileModule(i18nSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  Function("module", "exports", "require", i18n)(translations, translations.exports, require);
  const copy = translations.exports.copyFor("zh-CN");
  const values = [];
  let cursor = 0;
  let done = 0;
  let diagnostics = 0;
  let error = null;
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useMemo: fn => fn(), codexCatalogReady: () => true, MCP_GUIDE_MEDIA: [],
    motion: { section: "section" }, React: { Fragment: "Fragment" },
    messageOf: cause => cause.message, localizeRuntimeMessage: translations.exports.localizeRuntimeMessage,
    api: { completeMcpSetup: f.complete, verifyMcp: async () => { diagnostics++; return f.verify(); },
      snapshot: async () => ({ state: f.stateStore.read() }) },
  };
  for (const name of ["ContentSurface", "SecondaryButton", "PrimaryButton", "NoticeRow", "DoctorSummary", "Icon", "AnimatePresence", "FieldRow", "TutorialVideo"]) sandbox[name] = name;
  vm.runInNewContext(`${transpiled}\nrender = McpSurface;`, sandbox);
  const props = {
    copy, language: "zh-CN", interactionMode: f.config.browserInteractionMode,
    devProfile: f.host.launcherProfile === "development", operation: null,
    snapshot: { state: f.stateStore.read(), mcpCredentialsConfigured: true,
      connectorNames: { automatic: f.config.appName, manual: f.config.appName } },
    updateState: state => { props.snapshot.state = state; }, onDone: () => { done++; }, setError: value => { error = value; },
  };
  const render = () => { cursor = 0; return sandbox.render(props); };
  const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object"
    ? [tree, ...nodes(tree.children ?? [])] : [];
  const findButton = (tree, type, label) => nodes(tree).find(node => node.type === type && node.children.includes(label));
  const text = tree => Array.isArray(tree) ? tree.map(text).join(" ") : tree && typeof tree === "object"
    ? text(tree.children ?? []) : typeof tree === "string" ? tree : "";
  return { copy, render, nodes, text, props,
    completeButton: tree => nodes(tree).find(node => node.type === "PrimaryButton"),
    verifyButton: tree => findButton(tree, "SecondaryButton", copy.verifyRuntime),
    result: () => ({ done, diagnostics, error }) };
}

for (const profile of ["production", "development"]) for (const mode of ["automatic", "manual"]) {
  test(`${profile}/${mode} wizard completes without verification and after a failed diagnostic`, async context => {
    for (const diagnose of [false, true]) {
      const f = fixture(context, profile, mode);
      f.host.doctor = f.host.devDoctor = async () => ({ ok: true, checks: [] });
      f.host.run = async () => { throw new Error("diagnostic cancelled or timed out"); };
      const view = mcpViewHarness(f);
      let tree = view.render();
      assert.match(view.text(tree), new RegExp(view.copy.mcpDiagnosticNotRun));
      assert.equal(view.completeButton(tree).props.disabled, false);
      assert.equal(view.verifyButton(tree).props.disabled, false);
      if (diagnose) {
        view.verifyButton(tree).props.onClick();
        await new Promise(resolve => setImmediate(resolve));
        tree = view.render();
        const report = view.nodes(tree).find(node => node.type === "DoctorSummary").props.report;
        assert.equal(report.ok, false);
        assert.equal(view.completeButton(tree).props.disabled, false);
      }
      view.completeButton(tree).props.onClick();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.stateStore.read().mcpSetupComplete, true);
      assert.deepEqual(view.result(), { done: 1, diagnostics: diagnose ? 1 : 0, error: null });
      tree = view.render();
      assert.ok(view.text(tree).includes(view.copy.mcpReady));
      if (diagnose) assert.equal(view.nodes(tree).find(node => node.type === "DoctorSummary").props.report.ok, false);
    }
  });
}

test("the wizard cannot complete skipped configuration steps after a successful diagnostic", async context => {
  const f = fixture(context);
  f.stateStore.update({ mcpRuntimeInstalled: false });
  f.host.doctor = async () => ({ ok: true, checks: [] });
  f.host.launcherControlEnvironment = () => ({});
  f.host.run = async () => ({ stdout: JSON.stringify({ ok: true, evidence: { version: 2,
    binding: { profile: "production", mode: "automatic", appName: f.config.appName },
    receipts: { ordinary: { list: true, search: true, read: true },
      compaction: { list: true, search: true, read: true } } } }) });
  const view = mcpViewHarness(f);
  let tree = view.render();
  view.verifyButton(tree).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = view.render();
  assert.equal(view.nodes(tree).find(node => node.type === "DoctorSummary").props.report.ok, true);
  assert.equal(view.completeButton(tree).props.disabled, true);
  assert.ok(view.text(tree).includes(view.copy.mcpSetupRequired));
  view.completeButton(tree).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stateStore.read().mcpSetupComplete, false);
  assert.equal(view.result().done, 0);
});
