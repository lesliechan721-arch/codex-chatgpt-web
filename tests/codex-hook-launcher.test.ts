import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { codexInterruptHookCommand, codexInterruptHookHash, installCodexInterruptHookLauncher } from "../src/codex-interrupt-hook";

async function invoke(command: string, payload: string, environment: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command], {
    env: environment,
    stdin: Buffer.from(payload), stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("a copied hook command survives removing the old release and preserves stdin, home and exit status", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-upgrade-"));
  const home = join(root, "application home ' & !");
  const command = codexInterruptHookCommand(home);
  const hash = codexInterruptHookHash(command);
  const payload = '{"hook_event_name":"Interrupt","session_id":"thread_123","turn_id":"turn_123"}\n';
  try {
    for (const version of ["old", "new"]) {
      const entry = join(root, `${version} release.cjs`);
      writeFileSync(entry, `const fs = require("node:fs");
process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, args: process.argv.slice(2), input: fs.readFileSync(0, "utf8") }));
process.exitCode = 7;
`);
      installCodexInterruptHookLauncher({ runtimeCommand: [process.execPath, entry] }, home);
      if (version === "new") rmSync(join(root, "old release.cjs"));
      const result = await invoke(command, payload);
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        version, args: ["--home", home, "hook", "interrupt"], input: payload,
      });
      expect(codexInterruptHookCommand(home)).toBe(command);
      expect(codexInterruptHookHash(command)).toBe(hash);
    }
    if (process.platform !== "win32") {
      expect(statSync(join(home, "hooks", "interrupt.sh")).mode & 0o777).toBe(0o700);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the fixed hook reads current control credentials from its bound home and rejects invalid input", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-control-"));
  const home = join(root, "application home");
  mkdirSync(home);
  const requests: { path: string; authorization: string | null; body: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push({ path: new URL(request.url).pathname,
      authorization: request.headers.get("authorization"), body: await request.json() });
    return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 0 });
  } });
  const config = { ...defaultConfig(), port: server.port! };
  const command = codexInterruptHookCommand(home);
  const payload = JSON.stringify({ hook_event_name: "Interrupt", session_id: "thread_123", turn_id: "turn_123" });
  try {
    installCodexInterruptHookLauncher({ runtimeCommand: [process.execPath, resolve(import.meta.dir, "../src/cli.ts")] }, home);
    // The caller's environment must not redirect the hook to a different profile.
    const environment = { ...process.env, CODEX_CHATGPT_WEB_HOME: join(root, "wrong-home") };
    for (const token of ["a".repeat(43), "b".repeat(43)]) {
      config.controlToken = token;
      writeFileSync(join(home, "config.json"), JSON.stringify(config));
      const result = await invoke(command, payload, environment);
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(requests.at(-1)).toEqual({ path: "/admin/interrupt-turn", authorization: `Bearer ${token}`,
        body: { threadId: "thread_123", turnId: "turn_123" } });
    }
    for (const input of ["null", "{", payload.replace("Interrupt", "Stop"), "x".repeat(32 * 1024 + 1)]) {
      expect((await invoke(command, input, environment)).exitCode).toBe(1);
    }
    expect(requests).toHaveLength(2);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("starting the current service refreshes an old hook without editing the manual Codex config", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-hook-serve-"));
  const home = join(root, "app");
  const codexHome = join(root, "codex");
  mkdirSync(home); mkdirSync(codexHome);
  const reservation = createServer();
  await new Promise<void>(done => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No reserved service port");
  const port = address.port;
  await new Promise<void>(done => reservation.close(() => done()));
  const config = defaultConfig();
  config.port = port;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const manualConfig = 'model_provider = "chatgpt_web"\n# User-maintained configuration.\n';
  writeFileSync(join(codexHome, "config.toml"), manualConfig);
  const command = codexInterruptHookCommand(home);
  installCodexInterruptHookLauncher({ runtimeCommand: [process.execPath, "retired-release-entry.js"] }, home);
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), "--home", home, "serve"], {
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_CHATGPT_WEB_HOME: home,
      CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "0" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    const deadline = performance.now() + 10_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${(await output).join("\n")}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* Wait for the service listener. */ }
      if (performance.now() >= deadline) throw new Error("Service did not become ready");
      await Bun.sleep(50);
    }
    const result = await invoke(command, JSON.stringify({
      hook_event_name: "Interrupt", session_id: "thread_123", turn_id: "turn_123",
    }));
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(manualConfig);
  } finally {
    child.kill();
    const forceStop = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try { await child.exited; await output; }
    finally { clearTimeout(forceStop); rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);
