import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

async function waitForLoginPhase(path: string, outcome: Promise<unknown>, phase: string, browserReady = Promise.resolve()): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const fileReady = (async () => {
    while (!existsSync(path) && !stopped) await Bun.sleep(10);
  })();
  try {
    await Promise.race([
      Promise.all([browserReady, fileReady]),
      outcome.then(error => { throw new Error(`${phase}: login ended before readiness`, { cause: error }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out during ${phase}`)), 10_000); }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    await fileReady;
  }
}

test("login waits for normal Chrome to exit before headed Keychain-aware capture", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  const exitRequest = join(root, "exit-request");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "while [ ! -f \"$CODEX_LOGIN_EXIT_REQUEST\" ]; do sleep 0.01; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  const previousExit = process.env.CODEX_LOGIN_EXIT_REQUEST;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  process.env.CODEX_LOGIN_EXIT_REQUEST = exitRequest;
  const captureFailure = new Error("Controlled browser capture failure");
  const capture = spyOn(chromium, "launchPersistentContext").mockRejectedValue(captureFailure);
  let outcome: Promise<unknown> | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    outcome = loginToChatGpt(config).then(() => undefined, error => error);
    await waitForLoginPhase(pidLog, outcome, "normal Chrome startup");
    expect(capture).not.toHaveBeenCalled();
    writeFileSync(exitRequest, "");
    expect(await outcome).toBe(captureFailure);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toBe(join(root, "browser", "login-profile"));
    expect(capture.mock.calls[0]?.[1]).toMatchObject({
      executablePath: executable,
      headless: false,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    });
  } finally {
    writeFileSync(exitRequest, "");
    await outcome;
    capture.mockRestore();
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    if (previousExit === undefined) delete process.env.CODEX_LOGIN_EXIT_REQUEST;
    else process.env.CODEX_LOGIN_EXIT_REQUEST = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login authenticates in normal Chrome before isolated offline pipe capture", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 0.05; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  let cancelLogin: ((error: Error) => void) | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>((resolve, reject) => { continueLogin = resolve; cancelLogin = reject; });
    let ready!: () => void;
    const browserReady = new Promise<void>(resolve => { ready = resolve; });
    outcome = captureSystemBrowserLogin(config, { continuation, timeoutMs: 15_000,
      onBrowserReady: ready }).then(() => undefined, error => error);
    await waitForLoginPhase(pidLog, outcome, "passkey Chrome startup", browserReady);
    continueLogin();
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("launchPersistentContext");

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--enable-automation");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--headless");
    expect(launches[1]).toContain("--restore-last-session");
    expect(launches[1]).toContain("--disable-background-networking");
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    cancelLogin?.(new Error("Passkey test cleanup"));
    await outcome;
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
