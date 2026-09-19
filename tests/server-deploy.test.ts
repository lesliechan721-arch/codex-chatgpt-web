import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const deploy = resolve(root, "deploy/server");

function read(relativePath: string): string {
  return readFileSync(resolve(deploy, relativePath), "utf8");
}

describe("server remote desktop deployment", () => {
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
    expect(dockerfile).toContain("launcher/artifacts/${APPIMAGE_FILE}");
    expect(dockerfile).toContain("APPIMAGE_EXTRACT_AND_RUN=1");
    expect(launcher).toContain('exec "$APPIMAGE_PATH" --password-store=gnome-libsecret');
    expect(all).not.toContain("--no-sandbox");
    expect(all).not.toContain("--dev-profile");
    expect(all).not.toContain("dev:launcher");
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
    expect(compose).toContain("CODEX_CHATGPT_WEB_PUBLIC_BASE_URL: ${CODEX_PUBLIC_BASE_URL:-}");
    expect(compose).toContain("CODEX_CHATGPT_WEB_CLIENT_PORT: ${RESPONSES_HOST_PORT:-17841}");
    expect(compose).toContain("CODEX_CHATGPT_WEB_REMOTE_TURN_IDLE_TIMEOUT_SEC: ${REMOTE_TURN_IDLE_TIMEOUT_SEC:-600}");
    expect(readme).toContain("`/desktop/websockify`");
    expect(readme).not.toContain("proxy `/websockify`");
    expect(readme).toContain("do not proxy `/healthz`, `/admin/*`");
  });

  test("persists HOME without a Codex workspace and keeps VNC and keyring credentials in separate secret files", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("compose.yaml");
    const envExample = read(".env.example");
    const entrypoint = read("bin/entrypoint.sh");
    const terminal = read("bin/start-terminal.sh");
    const supervisor = read("supervisord.conf");
    const vnc = read("bin/start-vnc.sh");
    const keyring = read("bin/start-keyring.sh");

    expect(compose).toContain("codex_home:/home/codex");
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
    expect(envExample).toContain("VNC_PASSWORD_FILE=/etc/codex-web-gpt/vnc-password");
    expect(envExample).toContain("KEYRING_PASSWORD_FILE=/etc/codex-web-gpt/keyring-password");
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
