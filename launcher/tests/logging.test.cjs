const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  redactText,
  registerSensitiveProxyUrl,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("raw launcher logs remove authenticated proxy URLs but preserve ordinary URLs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-proxy-log-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    const logger = createLogger({ filePath });
    logger.error("runtime.failure", {
      message: "failed via http://proxy-user:p%40ss@private.proxy.example:8123/path and http://public.example:8080/path",
    });
    const raw = fs.readFileSync(filePath, "utf8");
    assert.match(raw, /\[authenticated-proxy-url\]/);
    assert.match(raw, /http:\/\/public\.example:8080\/path/);
    assert.doesNotMatch(raw, /proxy-user|p%40ss|private\.proxy\.example|8123/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registered proxy endpoints remain redacted after environment changes", () => {
  registerSensitiveProxyUrl("HTTP://Old.Proxy.Example:8123/");
  registerSensitiveProxyUrl("https://[2001:db8::7]");
  const redacted = redactText([
    "HTTP://OLD.PROXY.EXAMPLE:8123/health",
    "old.proxy.example",
    "OLD.PROXY.EXAMPLE:8123",
    "port 8123",
    "https://[2001:DB8::7]:443/",
    "[2001:db8::7]:443",
    "2001:db8::7",
    "PORT 443",
    "http://public.example:9090/health",
  ].join(" | "));

  assert.doesNotMatch(redacted, /old\.proxy\.example|8123|2001:db8::7|\b443\b/i);
  assert.match(redacted, /http:\/\/public\.example:9090\/health/);
});

test("current proxy host, endpoint, IPv6, and port descriptions are redacted", () => {
  const previousHttpProxy = process.env.HTTP_PROXY;
  const previousHttpsProxy = process.env.HTTPS_PROXY;
  try {
    process.env.HTTP_PROXY = "http://current.proxy.example:8421";
    process.env.HTTPS_PROXY = "https://[2001:db8::42]";
    const redacted = redactText(
      "current.proxy.example current.proxy.example:8421 port 8421 "
        + "[2001:db8::42] [2001:db8::42]:443 2001:db8::42 port 443 "
        + "http://public.example:9090/health",
    );
    assert.doesNotMatch(redacted, /current\.proxy\.example|8421|2001:db8::42|\b443\b/i);
    assert.match(redacted, /http:\/\/public\.example:9090\/health/);
  } finally {
    if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previousHttpProxy;
    if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = previousHttpsProxy;
  }
});

test("sensitive proxy registry evicts its oldest entry after the fixed limit", () => {
  for (let index = 0; index < 33; index += 1) {
    registerSensitiveProxyUrl(`http://bounded-${String(index).padStart(2, "0")}.proxy.invalid:85${String(index).padStart(2, "0")}`);
  }
  const redacted = redactText(
    "http://bounded-00.proxy.invalid:8500/ "
      + "http://bounded-01.proxy.invalid:8501/ "
      + "http://bounded-32.proxy.invalid:8532/",
  );
  assert.match(redacted, /http:\/\/bounded-00\.proxy\.invalid:8500\//);
  assert.doesNotMatch(redacted, /bounded-01\.proxy\.invalid|8501|bounded-32\.proxy\.invalid|8532/);
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exported launcher logs remove local usernames, private ChatGPT titles, and URL paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-export-"));
  const filePath = path.join(root, "launcher.jsonl");
  const destinationPath = path.join(root, "shared", "diagnostics.jsonl");
  try {
    fs.writeFileSync(`${filePath}.1`, `${JSON.stringify({
      at: "2026-08-23T00:00:00.000Z",
      level: "error",
      event: "runtime.daemon_stdout",
      detail: {
        line: "prompt_attachment failed at C:\\Users\\private.user\\.codex and encoded C:\\\\Users\\\\private.user\\\\.codex; connector missing; visible rows: Private roadmap, Health notes",
      },
    })}\n`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      at: "2026-08-23T00:01:00.000Z",
      level: "info",
      event: "runtime.stdout",
      detail: {
        line: "config loaded from /Users/local-person/.codex/config.toml",
        prompt: "private prompt",
        connector: "Codex Native3",
        url: "https://chatgpt.com/c/private-conversation?state=oauth-secret&email=private@example.com",
        message: "failed while loading 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-secret&login_hint=private@example.com'",
      },
    })}\n`);

    assert.equal(exportSanitizedLogs({ filePath, destinationPath }), 2);
    const exported = fs.readFileSync(destinationPath, "utf8");
    assert.doesNotMatch(exported, /private\.user|local-person|Private roadmap|Health notes|private prompt|private-conversation|oauth-secret|private@example\.com/);
    assert.match(exported, /\[user-home\]/);
    assert.match(exported, /visible rows: \[redacted\]/);
    assert.match(exported, /Codex Native3/);
    assert.match(exported, /"prompt":"\[redacted\]"/);
    assert.match(exported, /https:\/\/chatgpt\.com/);
    assert.match(exported, /https:\/\/accounts\.google\.com/);
    assert.throws(
      () => exportSanitizedLogs({ filePath, destinationPath: filePath }),
      /Refusing to overwrite a launcher source log/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("process stream diagnostics redact registered proxy endpoints from error stacks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-proxy-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    registerSensitiveProxyUrl("http://diagnostic.proxy.example:8321");
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", new Error(
      "failed through http://diagnostic.proxy.example:8321 and diagnostic.proxy.example:8321; see http://public.example/help",
    ));
    const diagnostic = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(diagnostic, /http:\/\/diagnostic\.proxy\.example:8321|diagnostic\.proxy\.example|8321/);
    assert.match(diagnostic, /http:\/\/public\.example\/help/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
