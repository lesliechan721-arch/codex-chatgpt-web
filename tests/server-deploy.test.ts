import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const deploy = resolve(root, "deploy/server");
const dockerPath = Bun.which("docker");
const dockerAvailable = dockerPath !== null && Bun.spawnSync(
  [dockerPath, "version", "--format", "{{.Server.Version}}"],
  { stdout: "ignore", stderr: "ignore" },
).exitCode === 0;

function read(relativePath: string): string {
  return readFileSync(resolve(deploy, relativePath), "utf8");
}

function filesUnder(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return filesUnder(resolve(directory, entry.name), relative);
    }
    return entry.isFile() ? [relative] : [];
  });
}

function writeFixtureFile(directory: string, relativePath: string): void {
  const path = resolve(directory, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${relativePath}\n`);
}

function buildDockerContextProbe(dockerignore: string, fixturePaths: string[]): string[] {
  if (dockerPath === null) throw new Error("Docker is not available");

  const probeRoot = mkdtempSync(join(tmpdir(), "codex-web-gpt-dockerignore-"));
  const contextRoot = resolve(probeRoot, "context");
  const outputRoot = resolve(probeRoot, "output");
  const buildxConfig = resolve(probeRoot, "buildx");
  mkdirSync(contextRoot, { recursive: true });
  mkdirSync(buildxConfig, { recursive: true });

  try {
    writeFileSync(resolve(contextRoot, ".dockerignore"), dockerignore);
    writeFileSync(resolve(contextRoot, "Dockerfile"), "FROM scratch\nCOPY . /context\n");
    for (const path of fixturePaths) writeFixtureFile(contextRoot, path);

    const result = Bun.spawnSync(
      [
        dockerPath,
        "build",
        "--progress=plain",
        "--output",
        `type=local,dest=${outputRoot}`,
        contextRoot,
      ],
      {
        env: { ...process.env, BUILDX_CONFIG: buildxConfig },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Docker context probe failed (exit ${result.exitCode})\n${result.stdout.toString()}\n${result.stderr.toString()}`,
      );
    }
    return filesUnder(resolve(outputRoot, "context")).sort();
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

describe("server remote desktop deployment", () => {
  test("builds the production AppImage inside the Docker image build", () => {
    const dockerfile = read("Dockerfile");
    const dockerignore = read("Dockerfile.dockerignore");
    const compose = read("compose.yaml");
    const envExample = read(".env.example");

    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS launcher-builder");
    expect(dockerfile).toContain("./scripts/prepare-linux-libnotify.sh");
    expect(dockerfile).toContain("launcher/scripts/prepare-linux-appimage-tools.cjs");
    expect(dockerfile).toContain("CODEX_WEB_GPT_APPIMAGE_TOOLS_OUTPUT=/build/launcher/build/appimage-tools");
    expect(dockerfile).toContain('APPIMAGE_TOOLS_PATH="$CODEX_WEB_GPT_APPIMAGE_TOOLS_OUTPUT"');
    expect(dockerfile).not.toContain('APPIMAGE_TOOLS_PATH="$(bun run launcher/scripts/prepare-linux-appimage-tools.cjs)"');
    expect(dockerfile).toContain("bun run --cwd launcher package:linux");
    expect(dockerfile).toContain(
      "COPY --from=launcher-builder /tmp/Codex-Web-GPT.AppImage /opt/codex/Codex-Web-GPT.AppImage",
    );
    expect(dockerfile).not.toContain("ARG APPIMAGE_FILE");
    expect(compose).not.toContain("APPIMAGE_FILE");
    expect(envExample).not.toContain("APPIMAGE_FILE");
    expect(dockerignore.split(/\r?\n/)[0]).toBe("**");
  });

  test.skipIf(!dockerAvailable)("keeps generated launcher directories out of the Docker build context", () => {
    const allowedPaths = [
      "package.json",
      "bun.lock",
      "LICENSE",
      "LICENSES/dependency.md",
      "src/cli.ts",
      "src/nested/helper.js",
      "scripts/build-runtime-bundle.ts",
      "scripts/generate-third-party-notices.ts",
      "scripts/prepare-linux-libnotify.sh",
      "launcher/package.json",
      "launcher/bun.lock",
      "launcher/tsconfig.json",
      "launcher/vite.config.ts",
      "launcher/index.html",
      "launcher/assets/icon.png",
      "launcher/assets/linux-appimage-runner.sh",
      "launcher/assets/mcp-mark.svg",
      "launcher/electron/main.cjs",
      "launcher/electron/nested/helper.txt",
      "launcher/scripts/package.cjs",
      "launcher/scripts/prepare-runtime.cjs",
      "launcher/scripts/prepare-linux-appimage-tools.cjs",
      "launcher/src/App.tsx",
      "launcher/src/nested/helper.js",
      "deploy/server/bin/start-vnc.sh",
      "deploy/server/novnc-index.html",
      "deploy/server/supervisord.conf",
    ];
    const blockedPaths = [
      "README.md",
      ".npmrc",
      "scripts/private.ts",
      "launcher/.npmrc",
      "launcher/node_modules/example/index.js",
      "launcher/artifacts/Codex-Web-GPT.AppImage",
      "launcher/build/generated.txt",
      "launcher/dist/generated.js",
      "launcher/release/generated.txt",
      "deploy/server/.env.production",
    ];

    const actualPaths = buildDockerContextProbe(
      read("Dockerfile.dockerignore"),
      [...allowedPaths, ...blockedPaths],
    );
    expect(actualPaths).toEqual([...allowedPaths].sort());
  });

  test("runs the production AppImage as a non-root user without sandbox bypasses", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");
    const launcher = read("bin/start-launcher.sh");
    const all = `${dockerfile}\n${launcher}\n${read("supervisord.conf")}`;

    expect(dockerfile).toContain("USER codex");
    expect(dockerfile).toContain("ARG CODEX_UID=10001");
    expect(dockerfile).toContain("ARG CODEX_GID=10001");
    expect(compose).toContain("CODEX_UID: ${CODEX_UID:-10001}");
    expect(compose).toContain("CODEX_GID: ${CODEX_GID:-10001}");
    expect(dockerfile).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
    expect(launcher).toContain('exec "$APPIMAGE_PATH" --password-store=gnome-libsecret');
    expect(all).not.toContain("--no-sandbox");
    expect(all).not.toContain("--dev-profile");
    expect(all).not.toContain("dev:launcher");
  });

  test("installs CJK fonts for localized launcher text", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("fonts-noto-cjk");
  });

  test("publishes noVNC and Responses only on host loopback and keeps control surfaces internal", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");
    const readme = read("README.md");
    const novncIndex = read("novnc-index.html");
    const supervisor = read("supervisord.conf");
    const vnc = read("bin/start-vnc.sh");

    expect(dockerfile).toContain("COPY deploy/server/novnc-index.html /usr/share/novnc/index.html");
    expect(novncIndex).toContain("vnc.html?path=desktop%2Fwebsockify");
    expect(compose).toContain('"127.0.0.1:${NOVNC_HOST_PORT:-6080}:6080"');
    expect(compose).toContain('"127.0.0.1:${RESPONSES_HOST_PORT:-17841}:17841"');
    expect(compose).not.toContain('"0.0.0.0:');
    expect(compose).not.toMatch(/:\s*5900\b/);
    expect(compose).not.toContain("network_mode: host");
    expect(compose).not.toContain("privileged: true");
    expect(compose).not.toContain("/var/run/docker.sock");
    expect(vnc).toContain("-localhost");
    expect(supervisor).toContain("0.0.0.0:6080 127.0.0.1:5900");
    expect(compose).toContain("CODEX_CHATGPT_WEB_BIND_HOST: 0.0.0.0");
    expect(compose).toContain('CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG: "1"');
    expect(compose).toContain("CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE: delegated");
    expect(compose).toContain("CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: ${CODEX_PUBLIC_BASE_URL:-}");
    expect(compose).toContain("CODEX_CHATGPT_WEB_CLIENT_PORT: ${RESPONSES_HOST_PORT:-17841}");
    expect(compose).toContain("CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC: ${REMOTE_TURN_IDLE_TIMEOUT_SEC:-600}");
    expect(readme).toContain("`/desktop/websockify`");
    expect(readme).not.toContain("proxy `/websockify`");
    expect(readme).toContain("do not proxy `/healthz`, `/admin/*`");
  });

  test("persists HOME without a Codex workspace and sources VNC and keyring secrets from environment variables", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");
    const envExample = read(".env.example");
    const entrypoint = read("bin/entrypoint.sh");
    const terminal = read("bin/start-terminal.sh");
    const supervisor = read("supervisord.conf");
    const vnc = read("bin/start-vnc.sh");
    const keyring = read("bin/start-keyring.sh");

    expect(compose).toContain('"${CODEX_HOME_MOUNT:-codex_home}:/home/codex"');
    expect(envExample).toContain("CODEX_HOME_MOUNT=");
    expect(read("README.md")).toContain("CODEX_HOME_MOUNT=/srv/codex-chatgpt-web/home");
    expect(compose).not.toContain(":/workspace");
    expect(envExample).not.toContain("WORKSPACE_PATH=");
    expect(entrypoint).not.toContain("/workspace");
    expect(terminal).not.toContain("/workspace");
    expect(supervisor).not.toContain("/workspace");
    expect(supervisor).toContain("directory=/home/codex");
    expect(dockerfile).not.toContain("WORKDIR /workspace");
    expect(compose).toContain("VNC_PASSWORD_FILE: /run/secrets/vnc_password");
    expect(compose).toContain("KEYRING_PASSWORD_FILE: /run/secrets/keyring_password");
    expect(compose).toContain("- vnc_password");
    expect(compose).toContain("- keyring_password");
    expect(compose).toContain("environment: VNC_PASSWORD");
    expect(compose).toContain("environment: KEYRING_PASSWORD");
    expect(compose).not.toContain("file: ${VNC_PASSWORD_FILE");
    expect(compose).not.toContain("file: ${KEYRING_PASSWORD_FILE");
    expect(envExample).not.toContain("VNC_PASSWORD_FILE=");
    expect(envExample).not.toContain("KEYRING_PASSWORD_FILE=");
    expect(envExample).not.toMatch(/^VNC_PASSWORD=/m);
    expect(envExample).not.toMatch(/^KEYRING_PASSWORD=/m);
    expect(vnc).toContain('head -n 1 "$VNC_PASSWORD_FILE"');
    expect(vnc).toContain("tigervncpasswd -f");
    expect(vnc).not.toMatch(/-passwd\s+\$?vnc_password/);
    expect(keyring).toContain('head -n 1 "$KEYRING_PASSWORD_FILE"');
    expect(keyring).not.toContain("VNC_PASSWORD_FILE");
  });

  test("does not install Codex CLI in the server image", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");
    const envExample = read(".env.example");
    const readme = read("README.md");

    expect(dockerfile).not.toContain("@openai/codex");
    expect(dockerfile).not.toContain("codex --version");
    expect(dockerfile).not.toContain("ARG CODEX_VERSION");
    expect(compose).not.toContain("CODEX_VERSION");
    expect(envExample).not.toContain("CODEX_VERSION");
    expect(readme).toContain("image does not install Codex CLI");
  });

  test("ships a two-host delegated Codex acceptance harness without sandbox bypass", () => {
    const acceptance = readFileSync(resolve(root, "scripts/accept-codex-remote-delegated.ts"), "utf8");
    const packageJson = readFileSync(resolve(root, "package.json"), "utf8");
    const readme = read("README.md");

    expect(packageJson).toContain('"accept:delegated:server"');
    expect(packageJson).toContain('"accept:delegated:remote"');
    expect(packageJson).toContain('"accept:delegated:zero-risk"');
    expect(acceptance).toContain("serverHostId");
    expect(acceptance).toContain("clientCodexStatePresent");
    expect(acceptance).toContain("<environment_context>");
    expect(acceptance).toContain("pwd && cat child-proof.txt");
    expect(acceptance).toContain('"read-only"');
    expect(acceptance).toContain('"workspace-write"');
    expect(acceptance).toContain("assertNotWritableByProfile");
    expect(acceptance).toContain("execEvidence(workspaceRoot, outsideTarget)");
    expect(acceptance).not.toContain('execEvidence(workspaceRoot, "workspace-write-denied.txt")');
    expect(acceptance).toContain("require_escalated");
    expect(acceptance).toContain("client-zero-risk");
    expect(acceptance).toContain("thread/compact/start");
    expect(acceptance).toContain("ZERO_RISK_FINAL_OK");
    expect(acceptance).toContain("codex_chatgpt_web_compaction_path");
    expect(acceptance).toContain("zero_risk_source_already_completed");
    expect(acceptance).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(readme).toContain("two-host acceptance harness");
    expect(readme).toContain("bun run accept:delegated:remote");
    expect(readme).toContain("bun run accept:delegated:zero-risk");
  });

  test("container supervisor owns only desktop processes and the top-level Launcher", () => {
    const supervisor = read("supervisord.conf");
    const fatalExit = read("bin/exit-on-fatal.sh");

    const programs = [...supervisor.matchAll(/^\[program:([^\]]+)\]$/gm)].map((match) => match[1]);
    expect(programs).toEqual(["xvfb", "keyring", "openbox", "terminal", "vnc", "novnc", "launcher"]);
    expect(supervisor).not.toMatch(/\bserve\b/);
    expect(supervisor).not.toMatch(/\btunnel\b/);
    expect(supervisor).not.toMatch(/\bmcp\b/i);
    expect(supervisor).not.toContain("17841");
    expect(supervisor).toContain("[eventlistener:fatal-exit]");
    expect(supervisor).toContain("events=PROCESS_STATE_FATAL");
    expect(fatalExit).toContain('supervisorctl -c "$supervisor_config" shutdown');
    expect(fatalExit).toContain("processname:launcher");
  });

  test("health allows first-time setup but requires Responses health after setup", () => {
    const health = read("bin/healthcheck.sh");

    expect(health).toContain("coreSetupComplete");
    expect(health).toContain("runtime-required");
    expect(health).toContain('config_file="$CODEX_CHATGPT_WEB_HOME/config.json"');
    expect(health).toContain("runtime_port=");
    expect(health).toContain('"http://127.0.0.1:${runtime_port}/healthz"');
    expect(health).not.toContain("127.0.0.1:17841");
    expect(health).toContain('"service":"codex-chatgpt-web"');
    expect(health).toContain('"status":"ok"');
  });

  test("provides a Secret Service instead of accepting basic_text storage", () => {
    const dockerfile = read("Dockerfile");
    const entrypoint = read("bin/entrypoint.sh");
    const runSupervisor = read("bin/run-supervisor.sh");
    const keyring = read("bin/start-keyring.sh");
    const launcher = read("bin/start-launcher.sh");
    const probe = read("bin/check-secret-service.sh");

    expect(dockerfile).toContain("gnome-keyring");
    expect(dockerfile).toContain("libsecret-1-0");
    expect(entrypoint).toContain("dbus-run-session -- /opt/codex-server/bin/run-supervisor.sh");
    expect(runSupervisor).toContain("dbus-session-address");
    expect(keyring).toContain("gnome-keyring-daemon --foreground --components=secrets --unlock");
    expect(keyring).toContain("KEYRING_PASSWORD_FILE");
    expect(keyring).not.toContain("codex-web-gpt-keyring:");
    expect(launcher).toContain("org.freedesktop.secrets");
    expect(launcher).toContain("--password-store=gnome-libsecret");
    expect(probe).toContain("dbus-session-address");
    expect(`${dockerfile}\n${keyring}\n${launcher}`).not.toContain("password-store=basic");
  });
});
