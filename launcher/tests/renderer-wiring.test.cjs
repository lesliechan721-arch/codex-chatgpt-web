const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
const rendererEntrySource = fs.readFileSync(path.join(launcherRoot, "src", "main.tsx"), "utf8");
const stylesSource = fs.readFileSync(path.join(launcherRoot, "src", "styles.css"), "utf8");
const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");
const browserHostSource = fs.readFileSync(path.join(launcherRoot, "electron", "browser-host.cjs"), "utf8");
const preloadSource = fs.readFileSync(path.join(launcherRoot, "electron", "preload.cjs"), "utf8");
const networkProxySettingsSource = fs.readFileSync(path.join(launcherRoot, "src", "NetworkProxySettings.tsx"), "utf8");
const apiAccessSettingsSource = fs.readFileSync(path.join(launcherRoot, "src", "ApiAccessSettings.tsx"), "utf8");

test("embedded ChatGPT is measured only after its animated surface mounts", () => {
  assert.match(appSource, /const \[browserSlot, setBrowserSlot\] = useState<HTMLDivElement \| null>\(null\)/);
  assert.match(appSource, /setBrowserSurfaceActive\(browserSurfaceActive\)\.then\(\(\) => \{/);
  assert.match(appSource, /observer\.observe\(browserSlot\)/);
  assert.match(appSource, /ref=\{browserSlotRef\}/);
});

test("the proxy dialog coordinates with the native browser surface", () => {
  assert.match(appSource, /const \[networkProxyOpen, setNetworkProxyOpen\] = useState\(false\)/);
  assert.match(
    appSource,
    /const browserSurfaceActive = surface === "browser"[\s\S]*?&& !networkProxyOpen;/,
  );
  assert.match(
    appSource,
    /<NetworkProxySettings[\s\S]*?onOpenChange=\{setNetworkProxyOpen\}/,
  );
  assert.doesNotMatch(rendererEntrySource, /<NetworkProxySettings/);
});

test("proxy authentication is scoped to the embedded partition and unsafe cache state exits", () => {
  assert.match(electronMain, /app\.on\("login"[\s\S]*?handleNetworkProxyLogin\([\s\S]*?networkProxyController/);
  assert.match(electronMain, /fatal: exitForUnsafeProxyAuthenticationState/);
  assert.match(electronMain, /runtimeSupervisorInstance\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /browserHost\?\.destroy\(\)/);
  assert.match(electronMain, /app\.exit\(1\)/);
});

test("Electron's five-argument login event forwards authInfo and callback without shifting", () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function handleNetworkProxyLogin(");
  const end = electronMain.indexOf("function publishOperation", start);
  const sandbox = {};
  vm.runInNewContext(electronMain.slice(start, end), sandbox);
  const event = {};
  const webContents = {};
  const responseDetails = { url: "https://target.example" };
  const authInfo = { isProxy: true, scheme: "basic", host: "proxy.example", port: 8080 };
  const callback = () => {};
  let received;
  const result = sandbox.handleNetworkProxyLogin({
    handleLogin: (...args) => {
      received = args;
      return "handled";
    },
  }, event, webContents, responseDetails, authInfo, callback);
  assert.equal(result, "handled");
  assert.equal(received[0], event);
  assert.equal(received[1], webContents);
  assert.equal(received[2], authInfo);
  assert.equal(received[3], callback);
  assert.equal(received.includes(responseDetails), false);
});

test("unsafe proxy authentication exits only after runtime shutdown is confirmed", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("async function handleUnsafeProxyAuthenticationState(");
  const end = electronMain.indexOf("function publishOperation", start);
  const sandbox = { NETWORK_PROXY_FATAL_MESSAGE: "fixed proxy fatal" };
  vm.runInNewContext(electronMain.slice(start, end), sandbox);

  for (const scenario of [
    { name: "stopped", shutdown: async () => ({ status: "stopped" }), exits: true },
    { name: "forced", shutdown: async () => ({ status: "forced" }), exits: true },
    { name: "forced-partial", shutdown: async () => ({ status: "forced-partial", failures: ["private"] }), exits: false },
    { name: "throw", shutdown: async () => { throw new Error("http://user:pw@private.example:8123"); }, exits: false },
  ]) {
    const events = [];
    const logs = [];
    const operations = [];
    const result = await sandbox.handleUnsafeProxyAuthenticationState({
      appApi: { exit: code => events.push(["exit", code]) },
      browserControlInstance: { close: async () => events.push("control-closed") },
      browserHostInstance: { destroy: () => events.push("browser-destroyed") },
      logger: { error: (event, detail) => logs.push({ event, detail }) },
      onExitCommitted: () => events.push("exit-committed"),
      publishFatalOperation: operation => operations.push(operation),
      runtimeSupervisorInstance: { shutdown: scenario.shutdown },
      stopBackgroundWork: () => events.push("background-stopped"),
      showWindow: () => events.push("window-shown"),
    });
    assert.equal(result.status, scenario.exits ? "exit-requested" : "supervision-retained", scenario.name);
    assert.equal(events.some(event => Array.isArray(event) && event[0] === "exit"), scenario.exits, scenario.name);
    assert.equal(events.includes("browser-destroyed"), true, scenario.name);
    assert.equal(events.includes("control-closed"), true, scenario.name);
    assert.equal(events.includes("window-shown"), true, scenario.name);
    assert.equal(logs[0].detail.message, "fixed proxy fatal", scenario.name);
    assert.equal(operations[0].message, "fixed proxy fatal", scenario.name);
    assert.doesNotMatch(JSON.stringify({ logs, operations }), /private|user:pw|8123/, scenario.name);
  }
});

test("fatal partial shutdown stays supervised and a later partial quit does not exit", async () => {
  const vm = require("node:vm");
  const fatalStart = electronMain.indexOf("async function handleUnsafeProxyAuthenticationState(");
  const fatalEnd = electronMain.indexOf("function publishOperation", fatalStart);
  const quitStart = electronMain.indexOf("async function requestQuit()");
  const quitEnd = electronMain.indexOf("async function start()", quitStart);
  const events = [];
  const operations = [];
  let monitorActive = true;
  let shutdownCalls = 0;
  const runtimeSupervisor = {
    shutdown: async () => {
      shutdownCalls += 1;
      if (shutdownCalls === 3) throw new Error("private shutdown exception");
      return { status: "forced-partial", failures: ["private child detail"] };
    },
  };
  const browserHost = {
    currentOperation: () => null,
    destroy: () => events.push("browser-destroyed"),
    persistSession: async () => events.push("session-persisted"),
  };
  const sandbox = {
    LAUNCHER_SHUTDOWN_INCOMPLETE_MESSAGE: "fixed shutdown failure",
    NETWORK_PROXY_FATAL_MESSAGE: "fixed proxy fatal",
    app: { exit: code => events.push(["exit", code]), quit: () => events.push("quit") },
    browserControl: { close: async () => events.push("control-closed") },
    browserHost,
    exitCommitted: false,
    publishOperation: operation => operations.push(operation),
    quitting: false,
    runtimeHost: { currentOperation: () => null },
    runtimeSupervisor,
    showMainWindow: () => events.push("window-shown"),
    shutdownInProgress: false,
    stopCatalogVerificationMonitor: () => events.push("background-stopped"),
  };
  vm.runInNewContext(
    `${electronMain.slice(fatalStart, fatalEnd)}\n${electronMain.slice(quitStart, quitEnd)}`,
    sandbox,
  );

  const fatalResult = await sandbox.handleUnsafeProxyAuthenticationState({
    appApi: sandbox.app,
    browserControlInstance: sandbox.browserControl,
    browserHostInstance: browserHost,
    logger: { error: () => {} },
    onExitCommitted: () => { sandbox.exitCommitted = true; },
    publishFatalOperation: sandbox.publishOperation,
    runtimeSupervisorInstance: runtimeSupervisor,
    stopBackgroundWork: sandbox.stopCatalogVerificationMonitor,
    showWindow: sandbox.showMainWindow,
  });
  assert.equal(fatalResult.status, "supervision-retained");
  assert.equal(monitorActive, true);

  const quitResult = await sandbox.requestQuit();
  assert.equal(quitResult.ok, false);
  assert.equal(quitResult.message, "fixed shutdown failure");
  assert.equal(shutdownCalls, 2);
  assert.equal(monitorActive, true);
  assert.equal(sandbox.exitCommitted, false);
  assert.equal(events.includes("quit"), false);
  assert.equal(events.some(event => Array.isArray(event) && event[0] === "exit"), false);
  assert.equal(events.includes("session-persisted"), false);
  assert.equal(operations.at(-1).message, "fixed shutdown failure");
  assert.doesNotMatch(JSON.stringify(operations), /private child detail/);

  const thrownQuitResult = await sandbox.requestQuit();
  assert.equal(thrownQuitResult.ok, false);
  assert.equal(thrownQuitResult.message, "fixed shutdown failure");
  assert.equal(shutdownCalls, 3);
  assert.equal(events.includes("quit"), false);
  assert.doesNotMatch(JSON.stringify(operations), /private shutdown exception/);
});

test("all proxy translations describe authenticated URLs and the MCP Tunnel limitation", () => {
  assert.equal((networkProxySettingsSource.match(/http:\/\/user:password@host:port/g) || []).length, 5);
  assert.equal((networkProxySettingsSource.match(/MCP Tunnel/g) || []).length, 5);
  assert.equal((networkProxySettingsSource.match(/http:\/\/user:password@proxy\.example:8080/g) || []).length, 5);
  assert.doesNotMatch(networkProxySettingsSource, /SOCKS/i);
  assert.match(networkProxySettingsSource, /autoComplete="off"/);
});

test("native clicks reach browser tabs instead of the window drag region", () => {
  assert.match(appSource, /draggable=\{surface !== "browser"\}/);
  assert.match(appSource, /className=\{`app-titlebar\$\{draggable \? " draggable" : ""\}`\}/);
  assert.match(stylesSource, /\.browser-tab\s*\{[^}]*-webkit-app-region:\s*no-drag;/s);
  assert.match(appSource, /className="browser-tab-drag draggable"/);
});

test("renderer zoom scales the shell without moving or zooming the native ChatGPT surface", () => {
  assert.match(
    electronMain,
    /browserHost\?\.setBounds\(validateBounds\(bounds\), event\.sender\.getZoomFactor\(\)\)/,
  );
  assert.match(browserHostSource, /this\.bindShellZoomShortcuts\(this\.window\.webContents\)/);
  assert.match(browserHostSource, /contents\.setZoomLevel\(next\)/);
  assert.match(appSource, /api!\.zoomBrowser\(action\)/);
});

test("closing the launcher follows the persisted background-runtime preference", () => {
  assert.match(
    electronMain,
    /if \(stateStore\.read\(\)\.keepRunningOnClose && tray\) window\.hide\(\);\s*else void requestQuit\(\);/,
  );
  assert.match(appSource, /setPreference\("keepRunningOnClose", checked\)/);
});

test("a foreground launch request survives hidden startup until the launcher window is ready", () => {
  const showMainWindow = electronMain.slice(
    electronMain.indexOf("function showMainWindow()"),
    electronMain.indexOf("async function openWebUrl"),
  );
  assert.match(
    showMainWindow,
    /mainWindowShowRequested = true;[\s\S]*?!mainWindowReadyToShow[\s\S]*?mainWindowShowRequested = false;/,
  );

  const readyHandler = electronMain.slice(
    electronMain.indexOf('window.once("ready-to-show"'),
    electronMain.indexOf("trackWindowState(window", electronMain.indexOf('window.once("ready-to-show"')),
  );
  assert.match(
    readyHandler,
    /mainWindowReadyToShow = true;[\s\S]*?if \(mainWindowShowRequested\) showMainWindow\(\);/,
  );

  const secondInstance = electronMain.indexOf('app.on("second-instance", () => showMainWindow())');
  const runtimeMaterialization = electronMain.indexOf("await waitForPackagedRuntimeSource", secondInstance);
  assert.ok(secondInstance >= 0, "the second-instance foreground request must be registered");
  assert.ok(
    runtimeMaterialization > secondInstance,
    "the foreground request must be registered before packaged-runtime startup can block window creation",
  );
});

test("normal shutdown persists the ChatGPT session before closing browser views", () => {
  assert.match(
    electronMain,
    /runtimeSupervisor\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/,
  );
  const persist = electronMain.indexOf("await browserHost?.persistSession()");
  const destroy = electronMain.indexOf("browserHost?.destroy()", persist);
  assert.ok(persist >= 0, "shutdown must persist the ChatGPT session");
  assert.ok(destroy > persist, "browser views must close only after session persistence completes");
});

test("setup preserves session-check failures and never installs without verified authentication", async () => {
  const vm = require("node:vm");
  const source = electronMain.slice(
    electronMain.indexOf('handle("launcher:setup-core",'),
    electronMain.indexOf('handle("launcher:setup-mcp",'),
  );
  for (const dev of [false, true]) {
    let setup;
    let installs = 0;
    let browser = { authenticated: false, status: "error", message: "ChatGPT session verification failed (HTTP 503)." };
    const state = { browserInteractionMode: "automatic", coreSetupComplete: false };
    const run = async () => { installs++; return { mode: "browser-only", stdout: "" }; };
    vm.runInNewContext(source, {
      handle: (_name, handler) => { setup = handler; }, IS_DEV_PROFILE: dev,
      stateStore: { read: () => state, update() {} },
      browserHost: { probeAuthentication: async () => browser, returnToIdle: async () => {} },
      runtimeHost: {
        setupCore: run,
        setupDevCore: run,
        runtimeConfigSnapshot: () => ({ configured: false, config: {} }),
        toolAuthorityControl: () => ({ effectiveMode: "verified-environment", forced: false, source: null }),
      },
      smokePassedThisSession: true, send() {}, startCatalogVerificationMonitor() {}, logger: {},
    });
    await assert.rejects(setup, error => error.message === browser.message);
    assert.equal(installs, 0);
    browser = { authenticated: false, status: "signed-out", message: "Sign in to ChatGPT" };
    await assert.rejects(setup, /Sign in to/);
    assert.equal(installs, 0);
    browser = { authenticated: true, status: "ready", message: "ChatGPT is ready" };
    assert.equal((await setup()).ok, true);
    assert.equal(installs, 1);
  }
});

test("startup failure stays visible on another launch and Retry exits the failed instance", async () => {
  const vm = require("node:vm");
  const source = electronMain.slice(electronMain.indexOf("function showMainWindow()"), electronMain.indexOf("async function openWebUrl"))
    + electronMain.slice(electronMain.indexOf("void start().catch("));
  const events = [];
  let visible = false;
  let answer;
  const dialogOpened = new Promise(resolve => {
    answer = { opened: resolve };
  });
  const window = { isDestroyed: () => false, isMinimized: () => false,
    show: () => { visible = true; }, focus() {}, };
  const sandbox = {
    mainWindow: window, mainWindowReadyToShow: false, mainWindowShowRequested: false,
    startupFailed: false, quitting: false,
    browserHost: { destroy: () => events.push("destroy") },
    browserControl: { close: async () => events.push("control closed") },
    start: async () => { throw new Error("Browser idle document did not commit within 10000ms"); },
    app: { getPath: () => "/unused", whenReady: async () => {},
      relaunch: options => events.push(["relaunch", options.args]), exit: code => events.push(["exit", code]) },
    fs: { appendFileSync() {} }, path,
    createStateStore: () => ({ read: () => ({ language: "ko" }) }),
    nativeCopyFor: language => {
      assert.equal(language, "ko");
      return { startupTitle: "시작 오류", startupDetail: "다시 시작", startupCleanupFailed: "정리 실패", retry: "다시 시도", quit: "종료" };
    },
    launchEnvironment: { CODEX_CHATGPT_WEB_HOME: undefined, CODEX_HOME: "original-codex-home" },
    process: { argv: ["launcher", "--hidden"], env: { CODEX_CHATGPT_WEB_HOME: "dev-home", CODEX_HOME: "dev-codex-home" } },
    dialog: {
      showErrorBox: () => { answer.opened(); },
      showMessageBox: (owner, options) => {
        assert.equal(options.title, "시작 오류");
        assert.deepEqual(Array.from(options.buttons), ["다시 시도", "종료"]);
        events.push(["dialog", owner === window, options.message]);
        answer.opened();
        return new Promise(resolve => { answer.resolve = resolve; });
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await dialogOpened;
  assert.equal(visible, true, "the failed startup must expose its error owner without renderer readiness");
  assert.deepEqual(events.slice(0, 2), ["destroy", "control closed"]);
  visible = false;
  sandbox.showMainWindow();
  assert.equal(visible, true, "a second launch must restore the existing startup error window");
  assert.equal(events.some(event => Array.isArray(event) && event[0] === "exit"), false);
  answer.resolve({ response: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-2)[0], "relaunch");
  assert.deepEqual(Array.from(events.at(-2)[1]), []);
  assert.deepEqual(events.at(-1), ["exit", 1]);
  assert.deepEqual(sandbox.process.env, { CODEX_HOME: "original-codex-home" });
});

test("packaged runtime is verified before launcher browser surfaces can bind ports", () => {
  const start = electronMain.indexOf("async function start()");
  const runtimeValidation = electronMain.indexOf("installedRuntimeRoot = runtimeRootProvider();", start);
  const cdpPortAllocation = electronMain.indexOf("cdpPort = await findFreePort();", start);
  const windowCreation = electronMain.indexOf("mainWindow = createWindow({", start);
  const controlServerStart = electronMain.indexOf("browserControl = await new BrowserControlServer({", start);
  const browserReady = electronMain.indexOf("await browserHost.ready();", start);

  assert.ok(runtimeValidation > start, "startup must eagerly verify the packaged runtime");
  for (const [surface, position] of [
    ["CDP port allocation", cdpPortAllocation],
    ["launcher window", windowCreation],
    ["browser control server", controlServerStart],
    ["embedded browser", browserReady],
  ]) {
    assert.ok(position > runtimeValidation, `${surface} must start only after runtime verification`);
  }
});

test("DEV launcher exposes its profile and supervises only its Full-mode MCP runtime", () => {
  assert.match(electronMain, /profile:\s*LAUNCHER_PROFILE\.kind/);
  assert.match(electronMain, /if \(IS_DEV_PROFILE\) \{[\s\S]*?config\?\.mode === "full"[\s\S]*?runtimeSupervisor\.startIfConfigured\(\)[\s\S]*?\} else void \(async \(\) => \{/);
  assert.match(electronMain, /await runtimeSupervisor\.shutdown\(\{ cancelActiveTurns: true, force: true \}\)/);
  assert.match(electronMain, /packaged:\s*app\.isPackaged && !IS_DEV_PROFILE/);
  assert.match(electronMain, /IS_DEV_PROFILE && !stateStore\.read\(\)\.onboardingComplete/);
  assert.match(electronMain, /onboardingComplete:\s*true,[\s\S]*?autoStart:\s*false/);
  assert.match(appSource, /snapshot\.profile === "development"/);
  assert.match(appSource, /data-profile=\{snapshot\.profile\}/);
  assert.match(appSource, /manualBiggerContextUnavailable[\s\S]*?copy\.biggerContextBody/);
  assert.match(appSource, /api!\.setBiggerContext\(enabled\)/);
  assert.match(electronMain, /runtimeHost\.setBiggerContext\(enabled === true\)/);
  assert.match(appSource, /api!\.setToolAuthorityMode\(mode\)/);
  assert.match(preloadSource, /setToolAuthorityMode:[\s\S]*?launcher:tool-authority-mode/);
  assert.match(electronMain, /runtimeHost\.setToolAuthorityMode\(mode\)/);
  assert.doesNotMatch(electronMain, /IS_DEV_PROFILE && key === "experimentalBiggerContext"/);
});

test("tool authority UI shows effective forced state and permits pre-setup selection when unmanaged", async () => {
  assert.match(
    electronMain,
    /toolAuthority:\s*runtimeHost\.toolAuthorityControl\(state\.toolAuthorityMode\)/,
  );
  assert.match(
    appSource,
    /displayedToolAuthorityMode = snapshot\.toolAuthority\.forced[\s\S]*?snapshot\.toolAuthority\.effectiveMode[\s\S]*?snapshot\.state\.toolAuthorityMode/,
  );
  assert.match(appSource, /disabled=\{busy \|\| snapshot\.toolAuthority\.forced\}/);
  assert.match(appSource, /delegatedToolAuthorityForcedRemote[\s\S]*?delegatedToolAuthorityForcedEnvironment/);

  const vm = require("node:vm");
  const source = electronMain.slice(
    electronMain.indexOf('handle("launcher:tool-authority-mode"'),
    electronMain.indexOf('handle("launcher:skill-attachments"'),
  );
  const state = { toolAuthorityMode: "verified-environment", coreSetupComplete: false };
  const events = [];
  let runtimeWrites = 0;
  const runtimeHost = {
    toolAuthorityControl: () => ({ effectiveMode: state.toolAuthorityMode, forced: false, source: null }),
    runtimeConfigSnapshot: () => ({ configured: false }),
    setToolAuthorityMode: async () => {
      runtimeWrites += 1;
      return { authorityMode: "delegated" };
    },
  };
  let handler;
  vm.runInNewContext(source, {
    handle: (_name, next) => { handler = next; },
    validateToolAuthorityMode: value => value,
    stateStore: {
      read: () => ({ ...state }),
      update: patch => Object.assign(state, patch),
    },
    runtimeHost,
    browserHost: { activeTraceId: null, currentOperation: () => null },
    send: (...args) => events.push(args),
  });

  const selected = await handler(null, "delegated");
  assert.equal(selected.toolAuthorityMode, "delegated");
  assert.equal(state.toolAuthorityMode, "delegated");
  assert.equal(runtimeWrites, 0, "pre-setup selection must not start a setup transaction");
  assert.equal(events.at(-1)[0], "launcher:state-changed");

  runtimeHost.toolAuthorityControl = () => ({
    effectiveMode: "delegated",
    forced: true,
    source: "environment",
  });
  await assert.rejects(
    handler(null, "verified-environment"),
    /forced by CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE/,
  );
  assert.equal(state.toolAuthorityMode, "delegated");
  assert.equal(runtimeWrites, 0);
});

test("macOS passkey sign-in is additive to the unchanged embedded login action", () => {
  assert.match(appSource, /onAction=\{openLogin\}/);
  assert.match(appSource, /<BrowserSurface[\s\S]*?operation=\{operation\}[\s\S]*?platform=\{snapshot\.platform\}/);
  assert.match(appSource, /const passkeyAvailable = !manualInteraction[\s\S]*?platform === "darwin"[\s\S]*?browser\?\.authenticated !== true/);
  assert.match(appSource, /\{passkeyAvailable \? \([\s\S]*?className="toolbar-text-button"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /className="browser-empty-actions"[\s\S]*?copy\.passkeySignIn/);
  assert.match(appSource, /passkeyWaiting \? continuePasskeyLogin : openPasskeyLogin/);
  assert.match(preloadSource, /openPasskeyLogin:[\s\S]*?launcher:browser-passkey-login/);
  assert.match(preloadSource, /continuePasskeyLogin:[\s\S]*?launcher:browser-passkey-login-continue/);
  assert.match(electronMain, /launcher:browser-passkey-login[\s\S]*?browserHost\.openPasskeyLogin\(\)/);
  assert.match(electronMain, /loginWithPasskey: \(\) => runtimeHost\.capturePasskeyLogin\(\)/);
  assert.match(browserHostSource, /await this\.waitForAuthenticated\(60_000\)[\s\S]*?runSessionInspection\(false\)/);
});

test("Bigger Context startup recommendation reuses the persisted setting and setup transaction", () => {
  assert.match(
    appSource,
    /const \[biggerContextRecommendationOpen, setBiggerContextRecommendationOpen\] = useState\([\s\S]*?snapshot\.state\.browserInteractionMode === "automatic"[\s\S]*?snapshot\.state\.coreSetupComplete === true[\s\S]*?!snapshot\.state\.experimentalBiggerContext,/,
  );
  assert.match(appSource, /&& !biggerContextRecommendationOpen\s*&& !networkProxyOpen;/);
  assert.match(appSource, /updateState\(await api!\.setBiggerContext\(enabled\)\)/);
  assert.match(
    appSource,
    /<BiggerContextRecommendation[\s\S]*?checked=\{snapshot\.state\.experimentalBiggerContext\}[\s\S]*?onClose=\{\(\) => setBiggerContextRecommendationOpen\(false\)\}/,
  );
  assert.match(appSource, /<Switch checked=\{checked\} disabled=\{busy\} onChange=\{onChange\} \/>/);
  assert.match(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*position:\s*fixed;/s);
  assert.doesNotMatch(stylesSource, /\.bigger-context-recommendation-backdrop\s*\{[^}]*backdrop-filter:/s);
});

test("Zero Risk setup commits state after the runtime transaction and preserves manual inspection boundaries", () => {
  const modeSwitchHandler = electronMain.slice(
    electronMain.indexOf('handle("launcher:browser-interaction-mode"'),
    electronMain.indexOf('handle("launcher:set-preference"'),
  );
  const modeTransaction = modeSwitchHandler.indexOf("await browserHost.withInteractionModeChange(");
  const runtimeModeCommit = modeSwitchHandler.indexOf("runtimeHost.setBrowserInteractionMode(mode, afterRuntimeReady)");
  const stateModeCommit = modeSwitchHandler.indexOf("const state = stateStore.update({");
  assert.ok(modeTransaction >= 0 && modeTransaction < runtimeModeCommit);
  assert.ok(runtimeModeCommit < stateModeCommit);

  const mcpSetupHandler = electronMain.slice(
    electronMain.indexOf('handle("launcher:setup-mcp"'),
    electronMain.indexOf('handle("launcher:set-mcp-step"'),
  );
  const runtimeMcpCommit = mcpSetupHandler.indexOf("const runSetup = afterRuntimeReady => setup({");
  const mcpTransaction = mcpSetupHandler.indexOf("await browserHost.withInteractionModeChange(interactionMode, runSetup)");
  const stateMcpCommit = mcpSetupHandler.indexOf("const state = stateStore.update({");
  assert.ok(runtimeMcpCommit >= 0 && runtimeMcpCommit < mcpTransaction);
  assert.ok(mcpTransaction < stateMcpCommit);
  assert.match(browserHostSource, /bindManualTurnContents\(tab\)/);
  const manualBinding = browserHostSource.slice(
    browserHostSource.indexOf("bindManualTurnContents(tab)"),
    browserHostSource.indexOf("bindWebContents()"),
  );
  assert.doesNotMatch(manualBinding, /executeJavaScript|insertCSS|querySelector|runBrowserHelperOperation|enableDeviceEmulation/);
  assert.match(browserHostSource, /requireAutomaticBrowserInspection\(this, "ChatGPT authentication probe"\)/);
  assert.match(browserHostSource, /requireAutomaticBrowserInspection\(this, "ChatGPT session and capability inspection"\)/);
  assert.match(browserHostSource, /browserInteractionModeFor\(this\) === "manual"\) return;[\s\S]*?applyViewportCss\(\)/);
  assert.match(
    browserHostSource,
    /page-title-updated[\s\S]*?browserInteractionModeFor\(this\) === "manual"\) return;/,
  );
  assert.doesNotMatch(modeSwitchHandler, /const pending = stateStore\.update|catch \(error\)/);
  assert.match(electronMain, /browserInteractionMode === "manual"[\s\S]*?Local Zero Risk runtime is healthy/);

});

test("Zero Risk Pro commits Launcher state before a best-effort API-key model catalog refresh", () => {
  const handler = electronMain.slice(
    electronMain.indexOf('handle("launcher:zero-risk-pro"'),
    electronMain.indexOf('handle("launcher:browser-interaction-mode"'),
  );
  const runtimeCommit = handler.indexOf("await runtimeHost.setZeroRiskPro(enabled === true)");
  const stateCommit = handler.indexOf("const state = stateStore.update");
  const catalogRefresh = handler.indexOf("await apiAccessSettings.refreshModelCatalog()");
  assert.ok(runtimeCommit >= 0 && runtimeCommit < stateCommit && stateCommit < catalogRefresh);
  assert.match(handler, /try \{ await apiAccessSettings\.refreshModelCatalog\(\); \}[\s\S]*?catch \{ logger\.warn\("api_access\.model_catalog_refresh_deferred", \{\}\); \}/);
  assert.match(handler, /catch[\s\S]*?startCatalogVerificationMonitor\(\{ logger, stateStore \}\)/);
});

test("external model catalog export-required state directs the user to export instead of retrying refresh", () => {
  assert.match(apiAccessSettingsSource, /modelCatalogState === "export-required"[\s\S]*?copy\.catalogExportRequired/);
  assert.match(apiAccessSettingsSource, /modelCatalogState === "export-required"[\s\S]*?exportConfig\(true\)[\s\S]*?copy\.exportCatalog/);
  const retryCondition = apiAccessSettingsSource.slice(
    apiAccessSettingsSource.indexOf("{pending || status?.cleanupPending"),
    apiAccessSettingsSource.indexOf("{status?.modelCatalogState === \"export-required\" ? <button", apiAccessSettingsSource.indexOf("{pending || status?.cleanupPending")),
  );
  assert.doesNotMatch(retryCondition, /export-required/);
});

test("API-key and remote forwarding bypass catalog validation while invalid policy fails closed", () => {
  assert.match(
    appSource,
    /function requiresCodexCatalog[\s\S]*?snapshot\.apiAccessMode !== "api-key"[\s\S]*?snapshot\.toolAuthority\.source !== "remote-bind"/,
  );
  assert.match(
    appSource,
    /function codexCatalogReady[\s\S]*?snapshot\.apiAccessMode !== "invalid"[\s\S]*?!requiresCodexCatalog\(snapshot\)[\s\S]*?snapshot\.state\.codexCatalogVerified === true/,
  );
  assert.match(
    electronMain,
    /function codexCatalogRequiredForState[\s\S]*?apiAccessMode === "api-key"[\s\S]*?source !== "remote-bind"/,
  );
  assert.match(
    electronMain,
    /apiAccessMode === "invalid"[\s\S]*?invalidPolicyObserved = true;[\s\S]*?return;/,
  );
  assert.match(
    appSource,
    /manualInteraction[\s\S]*?\|\| configuringInactiveMode[\s\S]*?\|\| catalogReady[\s\S]*?copy\.mcpStepTwoHint/,
  );
  assert.match(appSource, /snapshot\.state\.coreSetupComplete !== true[\s\S]*?\|\| !catalogReady/);
});

test("API access mode changes refresh the catalog requirement", () => {
  assert.match(electronMain, /apiAccessMode:\s*currentApiAccessMode\(\)/);
  assert.match(appSource, /onModeChange=\{onApiAccessModeChange\}/);
  const adopt = apiAccessSettingsSource.slice(
    apiAccessSettingsSource.indexOf("function adopt("),
    apiAccessSettingsSource.indexOf("useEffect(() =>", apiAccessSettingsSource.indexOf("function adopt(")),
  );
  assert.ok(adopt.indexOf("onModeChange?.(next.configuredMode)") >= 0);
  assert.ok(
    adopt.indexOf("onModeChange?.(next.configuredMode)") < adopt.indexOf("if (!mounted.current) return"),
    "completed saves must notify the parent even if Settings unmounted while the apply was running",
  );
});

test("API access mode transitions reset and resume local OpenAI catalog verification", () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function resetCodexCatalogVerification(");
  const end = electronMain.indexOf("\nfunction startCatalogVerificationMonitor(", start);
  const state = { coreSetupComplete: true, codexCatalogVerified: true, codexRestartRequired: false };
  let required = true;
  let stopped = 0;
  let started = 0;
  const sandbox = {
    stopCatalogVerificationMonitor: () => { stopped++; },
    codexCatalogRequiredForState: () => required,
    startCatalogVerificationMonitor: () => { started++; },
    send() {},
  };
  vm.runInNewContext(electronMain.slice(start, end), sandbox);
  const stateStore = { read: () => state, update: patch => Object.assign(state, patch) };

  sandbox.handleApiAccessModeCommitted({ logger: {}, stateStore });
  assert.equal(stopped, 1);
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
  sandbox.handleApiAccessModeSettled({ logger: {}, stateStore });
  assert.equal(started, 1);

  required = false;
  state.codexCatalogVerified = true;
  state.codexRestartRequired = false;
  sandbox.handleApiAccessModeCommitted({ logger: {}, stateStore });
  sandbox.handleApiAccessModeSettled({ logger: {}, stateStore });
  assert.equal(stopped, 2);
  assert.equal(started, 1);
  assert.equal(state.codexCatalogVerified, true);
  assert.equal(state.codexRestartRequired, false);
});

test("API access settle retries catalog state reset after the committed notification cannot persist", () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function resetCodexCatalogVerification(");
  const end = electronMain.indexOf("\nfunction startCatalogVerificationMonitor(", start);
  const state = { coreSetupComplete: true, codexCatalogVerified: true, codexRestartRequired: false };
  const warnings = [];
  let failNextUpdate = true;
  let started = 0;
  const sandbox = {
    stopCatalogVerificationMonitor() {},
    codexCatalogRequiredForState: () => true,
    startCatalogVerificationMonitor: () => { started++; },
    send() {},
  };
  vm.runInNewContext(electronMain.slice(start, end), sandbox);
  const stateStore = {
    read: () => state,
    update: patch => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error("disk write failed");
      }
      return Object.assign(state, patch);
    },
  };
  const logger = { warn: (...args) => warnings.push(args) };

  sandbox.handleApiAccessModeCommitted({ logger, stateStore });
  assert.equal(state.codexCatalogVerified, true);
  sandbox.handleApiAccessModeSettled({ logger, stateStore });

  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
  assert.equal(started, 1);
  assert.equal(warnings.length, 1);
});

test("MCP navigation remains locked while an operation is active", () => {
  assert.match(appSource, /<McpSurface[\s\S]*?operation=\{operation\}/);
  assert.match(appSource, /const busy = localBusy \|\| operation\?\.status === "running"/);
  assert.match(appSource, /const safeMove = async \(next: number\) => \{\s*if \(busy\) return;/);
  assert.match(appSource, /disabled=\{busy \|\| index > step\}/);
});

test("failed doctor reports retain every failed check", () => {
  assert.match(
    appSource,
    /report\.ok\s*\?\s*report\.checks\.slice\(-6\)\s*:\s*report\.checks\.filter\(\(check\) => check\.status !== "ok"\)/,
  );
  assert.match(appSource, /visibleChecks\.map\(\(check\) =>/);
});

test("launcher shares only privacy-safe exported diagnostics", () => {
  assert.match(appSource, /api!\.exportLogs\(\)/);
  assert.match(preloadSource, /exportLogs:[\s\S]*?launcher:export-logs/);
  assert.match(electronMain, /launcher:export-logs[\s\S]*?showSaveDialog[\s\S]*?exportSanitizedLogs/);
  assert.doesNotMatch(preloadSource, /launcher:open-logs/);
  assert.doesNotMatch(electronMain, /launcher:open-logs/);
});

test("MCP verification failures stay inside the structured setup report", () => {
  assert.match(appSource, /next\.operation\.name !== "mcp-verification"/);
  assert.match(appSource, /next\.name !== "mcp-verification"/);
  assert.match(electronMain, /Finish the active Codex task before verifying the ChatGPT connector/);
  assert.match(electronMain, /report\.checks\.filter\(\(check\) => check\.id !== "connector"\)/);
  assert.match(electronMain, /mcp\.verification_requested/);
  assert.match(electronMain, /launcherFocused:\s*mainWindow\?\.isFocused\(\) === true/);
  assert.match(electronMain, /rendererFocused:\s*event\.sender\.isFocused\(\)/);
});

test("MCP verification proves runtime health before checking the connector", () => {
  const start = electronMain.indexOf('handle("launcher:mcp-verify"');
  const end = electronMain.indexOf('handle("launcher:doctor"', start);
  const handler = electronMain.slice(start, end);

  assert.ok(start >= 0 && end > start, "MCP verification handler must remain registered");
  assert.match(
    handler,
    /Checking local runtime[\s\S]*?await runtimeHost\.doctor\(\)[\s\S]*?if \(!report\.ok\)[\s\S]*?return report;[\s\S]*?Checking ChatGPT connector[\s\S]*?await browserHost\.verifyConnector/,
  );
  assert.match(handler, /publishOperation\(\{ name: operationName, status: "completed"/);
  assert.match(appSource, /operation\?\.name === "mcp-verification"/);
});

test("saved ChatGPT authentication is refreshed before setup is presented", () => {
  assert.match(electronMain, /browserHost\.refreshAuthentication\(\)/);
  const productionStartup = electronMain.indexOf("} else void (async () => {");
  const refreshBarrier = electronMain.indexOf("await startupAuthenticationRefresh", productionStartup);
  const upgrade = electronMain.indexOf("runtimeHost.upgradeManagedRuntime()", productionStartup);
  const runtimeStart = electronMain.indexOf("runtimeSupervisor.startIfConfigured()", upgrade);
  const routeConnect = electronMain.indexOf("runtimeHost.connectBridgeRoute()", runtimeStart);
  assert.ok(refreshBarrier > productionStartup, "production startup must wait for saved-session refresh");
  assert.ok(upgrade > refreshBarrier, "runtime upgrade must not inspect the browser before refresh settles");
  assert.ok(runtimeStart > upgrade, "configured runtime must start after any upgrade");
  assert.ok(routeConnect > runtimeStart, "Codex route must connect only after the runtime is healthy");
  assert.match(appSource, /browser\?\.status === "loading" \? copy\.checkingSignIn/);
});

test("completed model setup remains a repeatable capability probe", () => {
  assert.match(appSource, /<SetupRow[\s\S]*?onAction=\{install\}[\s\S]*?repeatable/);
  assert.match(appSource, /complete && !repeatable/);
  assert.match(
    electronMain,
    /!setupState\.coreSetupComplete[\s\S]*?smokePassedThisSession[\s\S]*?smokePassedForCurrentVersion\(setupState\)/,
  );
});

test("catalog verification reports a failed request instead of requesting another restart, then recovers", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function startCatalogVerificationMonitor(");
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const source = electronMain.slice(start, end);
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  const operations = [];
  const events = [];
  let tick;
  let payload = { pid: 10, successful_model_catalog_requests: 0, model_catalog_requests: 0, last_model_catalog_result: null };
  vm.runInNewContext(source + "\nstartCatalogVerificationMonitor({ logger, stateStore });", {
    catalogVerificationInFlight: false, catalogVerificationTimer: null, catalogVerificationGeneration: 0, lastOperation: null,
    codexCatalogRequiredForState: () => true,
    currentApiAccessMode: () => "openai",
    resetCodexCatalogVerification: () => state,
    stopCatalogVerificationMonitor() {},
    runtimeSupervisor: { readConfig: () => ({}), proxyHealthPayload: async () => payload },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: callback => { tick = callback; return { unref() {} }; },
    logger: { info: (...args) => events.push(args), warn: (...args) => events.push(args), debug() {} },
    send() {}, publishOperation: op => operations.push(op),
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 0);
  assert.equal(state.codexRestartRequired, true);
  payload = { ...payload, model_catalog_requests: 1, last_model_catalog_result: {
    request: 1, at: "2026-09-16T10:00:00Z", status: 502, failure: { stage: "transport", code: "UnsupportedProxyProtocol" },
  } };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, false);
  assert.equal(operations[0]?.status, "failed");
  assert.match(operations[0].message, /502.*UnsupportedProxyProtocol/);
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(operations.length, 1, "polling must not repeat the same failure");
  payload = { ...payload, successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: "2026-09-16T10:01:00Z" };
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.codexCatalogVerified, true);
  assert.equal(state.codexRestartRequired, false);
  assert.ok(events.some(([event]) => event === "codex.model_catalog_verified"));
});

test("catalog verification ignores an in-flight result after its generation is invalidated", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function startCatalogVerificationMonitor(");
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const source = electronMain.slice(start, end);
  const state = { coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true, language: "en" };
  let resolveHealth;
  const health = new Promise(resolve => { resolveHealth = resolve; });
  const sandbox = {
    catalogVerificationInFlight: false,
    catalogVerificationTimer: null,
    catalogVerificationGeneration: 0,
    lastOperation: null,
    codexCatalogRequiredForState: () => true,
    currentApiAccessMode: () => "openai",
    resetCodexCatalogVerification: () => state,
    stopCatalogVerificationMonitor() {},
    runtimeSupervisor: { readConfig: () => ({}), proxyHealthPayload: () => health },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: () => ({ unref() {} }),
    logger: { info() {}, warn() {}, debug() {} },
    send() {}, publishOperation() {},
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  };
  vm.runInNewContext(source + "\nstartCatalogVerificationMonitor({ logger, stateStore });", sandbox);
  sandbox.catalogVerificationGeneration++;
  resolveHealth({ pid: 10, successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: "2026-09-22T10:00:00Z" });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
});

test("catalog verification keeps polling through an invalid policy and revalidates after recovery", async () => {
  const vm = require("node:vm");
  const start = electronMain.indexOf("function startCatalogVerificationMonitor(");
  const end = electronMain.indexOf("\nfunction ", start + 1);
  const source = electronMain.slice(start, end);
  const state = { coreSetupComplete: true, codexCatalogVerified: true, codexRestartRequired: false, language: "en" };
  let mode = "invalid";
  let tick;
  let stopCalls = 0;
  let healthCalls = 0;
  let resets = 0;
  const sandbox = {
    catalogVerificationInFlight: false,
    catalogVerificationTimer: null,
    catalogVerificationGeneration: 0,
    lastOperation: null,
    currentApiAccessMode: () => mode,
    codexCatalogRequiredForState: () => true,
    resetCodexCatalogVerification: () => {
      resets++;
      Object.assign(state, { codexCatalogVerified: false, codexRestartRequired: true });
      return state;
    },
    stopCatalogVerificationMonitor: () => { stopCalls++; },
    runtimeSupervisor: {
      readConfig: () => ({}),
      proxyHealthPayload: async () => {
        healthCalls++;
        return { pid: 10, successful_model_catalog_requests: 0, last_model_catalog_result: null };
      },
    },
    stateStore: { read: () => state, update: patch => Object.assign(state, patch) },
    setInterval: callback => { tick = callback; return { unref() {} }; },
    logger: { info() {}, warn() {}, debug() {} },
    send() {}, publishOperation() {},
    nativeCopyFor: () => ({ catalogFailure: "Catalog failed (HTTP {status}; {reason})." }),
  };

  vm.runInNewContext(source + "\nstartCatalogVerificationMonitor({ logger, stateStore });", sandbox);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopCalls, 1, "starting a new monitor invalidates only the previous generation");
  assert.equal(healthCalls, 0);
  assert.equal(state.codexCatalogVerified, true);

  mode = "openai";
  await tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resets, 1);
  assert.equal(healthCalls, 1);
  assert.equal(state.codexCatalogVerified, false);
  assert.equal(state.codexRestartRequired, true);
  assert.equal(stopCalls, 1, "invalid policy must not permanently stop the monitor");
});

test("fresh-conversation IPC commits only after setup succeeds and refuses active browser work", async () => {
  const vm = require("node:vm");
  for (const savedChats of [false, true]) {
    const property = savedChats ? "useSavedChats" : "experimentalFreshConversationPerTurn";
    const method = savedChats ? "setUseSavedChats" : "setFreshConversationPerTurn";
    const channel = savedChats ? "launcher:use-saved-chats" : "launcher:fresh-conversation-per-turn";
    const nextChannel = savedChats ? "launcher:zero-risk-pro" : "launcher:use-saved-chats";
    const source = electronMain.slice(
      electronMain.indexOf(`handle("${channel}",`),
      electronMain.indexOf(`handle("${nextChannel}",`),
    );
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const config = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const events = [];
    let handler, finishSetup, setupFailure, calls = 0;
    const browserHost = { activeTraceId: "running-turn", currentOperation: () => null, turnTabs: new Map() };
    const syncSource = electronMain.slice(electronMain.indexOf("function syncFreshConversationPreference("), electronMain.indexOf("function registerIpc("));
    vm.runInNewContext(syncSource + source, {
      handle: (_channel, callback) => { handler = callback; }, browserHost,
      releaseRetainedConversation: require("../electron/retained-turn-release.cjs").releaseRetainedConversation,
      runtimeHost: { currentOperation: () => null, runtimeConfigSnapshot: () => ({ config }), [method]: async enabled => {
        calls++;
        if (setupFailure) throw setupFailure;
        await new Promise(resolve => { finishSetup = resolve; });
        config[property] = enabled;
        return { enabled };
      } },
      stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) },
      send: (channel, value) => events.push({ channel, value: { ...value } }),
    });
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    browserHost.activeTraceId = null;
    browserHost.currentOperation = () => "browser-smoke";
    await assert.rejects(() => handler(null, true), /Finish or cancel active ChatGPT turns/);
    assert.equal(calls, 0);
    browserHost.currentOperation = () => null;
    let api;
    vm.runInNewContext(preloadSource, { require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (actualChannel, enabled) => {
        assert.equal(actualChannel, channel);
        return handler(null, enabled);
      } },
    }) });
    const changing = api[method](true);
    assert.equal(state[property], false);
    assert.equal(events.length, 0);
    finishSetup();
    assert.equal((await changing)[property], true);
    assert.equal(events.length, 1);
    assert.equal(events[0].channel, "launcher:state-changed");
    setupFailure = new Error("synthetic setup rollback");
    await assert.rejects(() => api[method](false), /synthetic setup rollback/);
    assert.equal(state[property], true);
    assert.equal(events.length, 1);
  }
});

test("fresh-conversation snapshot uses runtime configuration and mode switching preserves the preference", async () => {
  const vm = require("node:vm");
  const handlers = new Map();
  const state = {
    browserInteractionMode: "automatic",
    experimentalFreshConversationPerTurn: false,
    toolAuthorityMode: "verified-environment",
  };
  let config = { browserInteractionMode: "automatic", experimentalFreshConversationPerTurn: true };
  const runtimeHost = {
    currentOperation: () => null,
    runtimeConfigSnapshot: () => ({ config }), browserConnectorName: () => "Codex Native2",
    setupConnectorName: () => "Codex Native2", mcpCredentialsConfigured: () => true,
    toolAuthorityControl: mode => ({ effectiveMode: mode ?? "verified-environment", forced: false, source: null }),
    setBrowserInteractionMode: async mode => { config.browserInteractionMode = mode; return { configured: true }; },
  };
  const sandbox = {
    handle: (name, handler) => handlers.set(name, handler), runtimeHost,
    releaseRetainedConversation: require("../electron/retained-turn-release.cjs").releaseRetainedConversation,
    stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) },
    browserHost: { activeTraceId: null, turnTabs: new Map(), currentOperation: () => null, snapshot: () => ({}),
      withInteractionModeChange: async (_mode, action) => action() },
    validateBrowserInteractionMode: mode => mode, currentApiAccessMode: () => "openai",
    IS_DEV_PROFILE: false, send() {}, startCatalogVerificationMonitor() {},
    LAUNCHER_PROFILE: { kind: "production", codexHome: "/fixture/codex" }, CORE_HOME: "/fixture/core",
    launcherUserData: "/fixture/launcher", logger: { recent: () => [] },
    GITHUB_URL: "", X_URL: "", CONNECTORS_URL: "", TUNNELS_URL: "", KEYS_URL: "",
    process: { platform: "darwin" }, app: { isPackaged: false, getVersion: () => "test" },
    smokePassedThisSession: false, smokePassedForCurrentVersion: () => false, lastOperation: null, updateController: null,
  };
  vm.runInNewContext(electronMain.slice(electronMain.indexOf("function syncFreshConversationPreference("), electronMain.indexOf("function registerIpc(")) +
    electronMain.slice(electronMain.indexOf('handle("launcher:snapshot",'),
    electronMain.indexOf('handle("launcher:set-language",')) +
    electronMain.slice(electronMain.indexOf('handle("launcher:browser-interaction-mode",'),
    electronMain.indexOf('handle("launcher:set-preference",')), sandbox);
  const snapshot = handlers.get("launcher:snapshot");
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, true);
  assert.equal(state.experimentalFreshConversationPerTurn, true, "snapshot synchronizes a CLI configuration change");
  const changeMode = handlers.get("launcher:browser-interaction-mode");
  for (const mode of ["manual", "automatic"]) {
    const changed = await changeMode(null, mode);
    assert.equal(changed.state.experimentalFreshConversationPerTurn, true);
    assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, true);
  }
  config = {};
  assert.equal((await snapshot()).state.experimentalFreshConversationPerTurn, false);
});

test("fresh-conversation control is translated, disabled in Zero Risk, and invokes the async setting", async () => {
  const ts = require("typescript");
  const vm = require("node:vm");
  const settings = appSource.slice(appSource.indexOf("function SettingsSurface("), appSource.indexOf("function ContentSurface("));
  const transpile = (source, fileName) => ts.transpileModule(source, {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, jsxFactory: "element" },
  }).outputText;
  const translated = { exports: {} };
  vm.runInNewContext(transpile(fs.readFileSync(path.join(launcherRoot, "src", "i18n.ts"), "utf8"), "i18n.ts"), translated);
  let render, invocation, saved;
  const sandbox = {
    element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => [value, () => {}],
    api: { setFreshConversationPerTurn: async enabled => { invocation = enabled; return { experimentalFreshConversationPerTurn: enabled }; } },
    messageOf: String, platformLabel: String, requiresCodexCatalog: () => false,
  };
  for (const name of ["ContentSurface", "SectionHeading", "SettingRow", "Switch", "InteractionModePicker", "LanguageMenu", "NoticeRow", "Icon", "DoctorSummary", "BrandMark", "ApiAccessSettings"]) sandbox[name] = name;
  vm.runInNewContext(transpile(settings, "settings.tsx") + "\nrender = SettingsSurface;", Object.assign(sandbox, { render }));
  render = sandbox.render;
  const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
    ? [tree, ...visit(tree.children ?? [])] : [];
  for (const language of Object.keys(require("../electron/languages.json"))) {
    const copy = translated.exports.copyFor(language);
    for (const key of ["freshConversation", "freshConversationBody", "manualFreshConversationUnavailable"]) {
      assert.equal(typeof copy[key], "string");
      assert.ok(copy[key].length > 10);
    }
    for (const [mode, configured, enabled] of [["automatic", true, false], ["manual", true, true], ["automatic", false, false]]) {
      const tree = render({ copy, devProfile: false, language, configureInteractionMode() {}, setError() {},
        snapshot: {
          state: {
            browserInteractionMode: mode,
            coreSetupComplete: configured,
            experimentalFreshConversationPerTurn: enabled,
            toolAuthorityMode: "verified-environment",
          },
          toolAuthority: { effectiveMode: "verified-environment", forced: false, source: null },
        },
        updateState: value => { saved = value; },
      });
      const row = visit(tree).find(node => node.type === "SettingRow" && node.props.label === copy.freshConversation);
      assert.ok(row);
      assert.equal(row.props.body, mode === "manual" ? copy.manualFreshConversationUnavailable : copy.freshConversationBody);
      const control = visit(row).find(node => node.type === "Switch");
      assert.equal(control.props.checked, enabled);
      assert.equal(control.props.disabled, mode === "manual" || !configured);
      if (!control.props.disabled) {
        control.props.onChange(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(invocation, true);
        assert.equal(saved.experimentalFreshConversationPerTurn, true);
      }
    }
  }
});
