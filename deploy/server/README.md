# Server remote desktop deployment (Phase 1)

This deployment runs the packaged Linux x64 Launcher in one long-running Docker container. It keeps the existing Launcher ownership model: the container supervisor owns the desktop processes and the Launcher process only. The Launcher continues to own the Responses daemon, Tunnel, MCP runtime, browser helper, and task browser views.

## Requirements

- Linux x86_64 server with Docker Engine and Docker Compose.
- Network access to pull `lesliechan721/codex-chatgpt-web` from Docker Hub.
- A persistent Docker volume for `/home/codex`.
- A private `VNC_PASSWORD` environment variable for remote desktop authentication.
- A separate private `KEYRING_PASSWORD` environment variable. Keep this keyring secret stable when reusing the HOME volume. It is intentionally independent from the VNC password, so the VNC password can be rotated without changing the safeStorage keyring credential.
- An existing HTTPS reverse proxy. This deployment does not install or manage TLS termination.
- A Codex client outside the container. It can run on the same Linux host or on another trusted machine that can reach the HTTPS reverse proxy.

The container user is named `codex` and uses uid/gid `10001:10001`; this avoids the `1000:1000` `node` user already present in the base image. Docker Compose reads the two password values from the invoking process environment and mounts them into the container as separate Compose secrets; the values are not part of `deploy/server/.env`.

VNC authentication uses the legacy VNC password mechanism. Use at least 8 random characters; only the first 8 characters are significant to this protocol. HTTPS at the existing reverse proxy is required for public access.

## Pull and start

Copy the environment template and set real values:

```sh
cp deploy/server/.env.example deploy/server/.env
```

Export the two secrets in the same shell before running Docker Compose:

```sh
export VNC_PASSWORD='replace-with-a-random-password'
export KEYRING_PASSWORD='replace-with-an-independent-stable-password'
```

The image does not install Codex CLI. The Launcher and its packaged runtime are the server-side product; Codex runs outside the container. The published image contains the production Linux x64 AppImage and records its SHA-256 digest in `/opt/codex-server/build/appimage.sha256`.

Pull the published image and start:

```sh
docker compose --env-file deploy/server/.env -f deploy/server/compose.yaml pull
docker compose --env-file deploy/server/.env -f deploy/server/compose.yaml up -d
```

The published image is built for `linux/amd64`. The Compose file fixes that platform and the Dockerfile rejects a non-amd64 userspace.

Inspect the packaged Launcher digest:

```sh
docker compose --env-file deploy/server/.env -f deploy/server/compose.yaml exec desktop cat /opt/codex-server/build/appimage.sha256
```

## Publish the server image

Log in to Docker Hub, then run:

```sh
docker login
bun run publish:server:image
```

The publish script builds `deploy/server/Dockerfile` with Docker Buildx for `linux/amd64` and pushes both `lesliechan721/codex-chatgpt-web:<package-version>` and `lesliechan721/codex-chatgpt-web:latest`. The Docker build packages the production Linux x64 AppImage from this source tree; no prebuilt `launcher/artifacts/*.AppImage` is required.

## Network contract

The default Compose file publishes noVNC and Responses only on host loopback:

```text
127.0.0.1:${NOVNC_HOST_PORT:-6080} -> container 6080 (noVNC/websockify)
127.0.0.1:${RESPONSES_HOST_PORT:-17841} -> container 17841 (Responses)
container 127.0.0.1:5900                -> x11vnc only
container loopback CDP                  -> Launcher browser diagnostics only
```

The deployment requests `CODEX_CHATGPT_WEB_BIND_HOST=0.0.0.0` inside the container so Docker can reach the Responses listener. The runtime honors that request only when the saved API access policy is `api-key`; OpenAI forwarding remains loopback-only. Do not change the host publication to `0.0.0.0`, and do not use host networking.

For external URLs such as `https://server.example.com/desktop/` and `https://server.example.com/v1`, the existing reverse proxy must:

1. terminate HTTPS;
2. proxy `/desktop/` to `http://127.0.0.1:${NOVNC_HOST_PORT}/` and strip the `/desktop/` prefix; the image landing page opens `vnc.html` with noVNC's WebSocket path set to `desktop/websockify`;
3. pass the WebSocket upgrade for `/desktop/websockify`; after the same `/desktop/` prefix strip, this reaches `http://127.0.0.1:${NOVNC_HOST_PORT}/websockify`;
4. proxy `/v1/` to `http://127.0.0.1:${RESPONSES_HOST_PORT}/v1/` with streaming/SSE buffering disabled;
5. do not proxy `/healthz`, `/admin/*`, VNC, CDP, or any other control endpoint.

If the reverse proxy itself runs in Docker, use an explicit private shared Docker network and remove the host-loopback port publication in a local Compose override. Do not replace it with a `0.0.0.0` publication.

Set `CODEX_PUBLIC_BASE_URL=https://server.example.com/v1` when Codex runs on another machine. Leave it empty when Codex runs on the same server host; exported client configuration then uses `http://127.0.0.1:${RESPONSES_HOST_PORT}/v1`.

## External Codex client

Server deployment sets `CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG=1`. Setup and runtime operations therefore do not create or modify any Codex `config.toml`, `auth.json`, or hook. Configure the client explicitly:

The Compose deployment also fixes `CODEX_CHATGPT_WEB_TOOL_AUTHORITY_MODE=delegated`. The server
does not mount or inspect the external client `CODEX_HOME`, rollout files, `sessions/`, or
`state_5.sqlite`, and it does not need the client workspace path or sandbox policy. Each tool-capable
turn is authorized only by its native `thread_id`, native `turn_id`, and the tool registry on that
current Responses request. Tool execution and local-state inspection still happen through the
external Codex client tools. A browser-only turn without those native tools cannot discover live
client filesystem or process state.

1. In Launcher Settings, switch API access to **API Key** and save a client key.
2. Use **Copy Codex config** or **Export TOML**. The provider `base_url` uses `CODEX_PUBLIC_BASE_URL`, or the host-loopback fallback when that value is empty.
3. Copy the exported TOML into the external Codex configuration and copy the exported model catalog to `CODEX_CLIENT_CATALOG_PATH` on that client. The default destination is `~/.codex/api-key-models.json`.
4. Restart the external Codex client.

The server export deliberately contains no container-local Interrupt command and no daemon control token. Normal HTTP disconnect cancellation is still used, and the server deployment adds `REMOTE_TURN_IDLE_TIMEOUT_SEC` as a no-progress fallback. Its default is 600 seconds. It is not a total turn duration limit. Real text/reasoning progress, tool-call creation, tool results, and compaction progress refresh the native `thread_id + turn_id` idle lease; transport/helper heartbeats and retries do not. A tool call that never returns therefore still times out and releases its ownership.

## Desktop and persistence

The supervisor starts these top-level processes:

```text
Xvfb
GNOME Keyring Secret Service
Openbox
xterm (maintenance shell under the container HOME)
x11vnc (loopback only, password required)
noVNC/websockify
production Codex Web GPT AppImage
```

The AppImage receives `APPIMAGE_EXTRACT_AND_RUN=1`, so FUSE is not required. It runs as the non-root `codex` user and is not started with `--no-sandbox`.

By default, the named `codex_home` volume persists all application-user state under `/home/codex`, including:

- `~/.codex-chatgpt-web`;
- Electron `userData` at `~/.config/Codex Web GPT`;
- the persistent ChatGPT browser partition and cookies;
- Launcher state and logs;
- GNOME Keyring data used by Electron safeStorage.

To keep this state in a directly managed host directory instead, set `CODEX_HOME_MOUNT` in `deploy/server/.env` to an absolute host path. The directory must be writable by the container user `10001:10001`. For example:

```sh
sudo install -d -o 10001 -g 10001 -m 0700 /srv/codex-chatgpt-web/home
```

Then set:

```dotenv
CODEX_HOME_MOUNT=/srv/codex-chatgpt-web/home
```

Leave `CODEX_HOME_MOUNT` empty to keep using the Docker-managed `codex_home` volume. Do not switch an existing deployment from the named volume to a host directory without first copying the existing `/home/codex` data; otherwise the new mount starts with a separate empty state.

The external Codex client owns its own `CODEX_HOME`, project files, sandbox, and command side effects. They are not mounted into this container.

To upgrade, pull the new published image, then recreate the container with the same HOME volume. To roll back, use a previously published version tag with the same persistent data. The AppImage self-updater is not the authoritative server update path.

## Health behavior

The container health check verifies that Xvfb, keyring, Openbox, xterm, VNC, noVNC, and the Launcher are all under supervisor control and running. It also fetches the noVNC page.

Before Launcher setup is complete, the desktop can be healthy without a Responses runtime. Once `coreSetupComplete` has been observed, the health check writes a marker in the persistent application home, reads the persisted Responses port from `~/.codex-chatgpt-web/config.json`, and requires the container-local `/healthz` endpoint to report the existing `codex-chatgpt-web` healthy contract. The public reverse proxy must not expose that endpoint.

## Secure storage validation

The image installs D-Bus, GNOME Keyring, and libsecret. Launcher startup waits for `org.freedesktop.secrets` and explicitly selects Electron's `gnome-libsecret` password store. A dedicated keyring secret is supplied to `gnome-keyring-daemon --unlock` over standard input, never in a process argument. The keyring secret is not derived from the VNC password. The entry point records only the non-secret D-Bus session address in the private runtime directory so `docker compose exec` validation commands can reach the same Secret Service.

After the container is running, verify that the Secret Service can write and read a value:

```sh
docker compose --env-file deploy/server/.env -f deploy/server/compose.yaml exec desktop \
  /opt/codex-server/bin/check-secret-service.sh
```

This probe validates the Secret Service substrate, but it does not replace the Spec's final Electron acceptance. On the target Linux x86_64 host, record `safeStorage.isEncryptionAvailable()` and `safeStorage.getSelectedStorageBackend()` from the final packaged Launcher. The backend must be `gnome_libsecret` (not `basic_text` or `unknown`). Then store a key through the existing safeStorage-backed product path, recreate the container while keeping the HOME volume and the same keyring secret, and confirm that the key remains readable. Rotate only the VNC password, recreate the container again, and confirm that the same safeStorage-backed key is still readable. Do not relax the existing vault check if this validation fails.

Changing the VNC password does not change the keyring unlock credential. Changing the keyring password is a keyring migration event; do not rotate it independently while expecting existing safeStorage entries to remain readable unless the keyring password is migrated first.

## Runtime acceptance on the target server

The final Linux x86_64 acceptance still needs real server evidence. At minimum, verify the production Launcher window without `--no-sandbox`, wrong/correct VNC password behavior, HTTPS `/desktop/` HTTP and WebSocket routing, API-key rejection/acceptance on HTTPS `/v1`, ChatGPT login/MFA, one real external-Codex turn, Automatic/Zero Risk, an MCP round trip, compaction, prompt client-disconnect cleanup, a short configured no-progress idle-timeout test, container recreation with persistent HOME, restart recovery, and absence of public raw listeners for Responses, health/admin, VNC, and CDP.

For delegated tool authority, use the two-host acceptance harness. It is intentionally not a same-workstation mock. First choose one fresh challenge and run the server attestation on the Linux server host:

```sh
export CODEX_WEB_REMOTE_ACCEPTANCE_CHALLENGE="$(openssl rand -hex 16)"
bun run accept:delegated:server > /tmp/delegated-server-attestation.json
```

Copy that JSON file to the separate machine that runs the real Codex client. On that client, use the same challenge and the exported remote API configuration:

```sh
export CODEX_WEB_REMOTE_ACCEPTANCE_CHALLENGE="<same challenge>"
export CODEX_WEB_REMOTE_BASE_URL="https://server.example.com/v1"
export CODEX_WEB_REMOTE_API_KEY="<dedicated acceptance API key>"
export CODEX_WEB_REMOTE_SERVER_ATTESTATION="/path/to/delegated-server-attestation.json"
export CODEX_WEB_REMOTE_MODEL_CATALOG="${HOME}/.codex/api-key-models.json"
bun run accept:delegated:remote
```

The server phase fails unless the production container uses `delegated`, has no Codex CLI or client `sessions`/`state_5.sqlite`, and has only the expected HOME and secret mounts. The Automatic client phase fails on loopback or when the server and Codex host identities are the same. It runs real Codex against the HTTPS Responses endpoint through a local capture proxy, then verifies a depth-1 child whose first Responses request has no `<environment_context>`, whose native `pwd` and file read resolve in the client workspace, and whose native thread is distinct from the parent. The capture also proves that the parent and child native tool `call_id` values return only on their own native thread, so a child continuation is not rebound to the parent or vice versa.

The Automatic phase also runs real `read-only` and `workspace-write` sandboxes. Its workspace-write escape target is under the client home, not under the system temporary directory. Before the escape is attempted, the harness reads the real native rollout permission profile and fails unless that target is outside every explicit writable root, `project_roots`, `tmpdir`, and `slash_tmp` permission. A separate `approval_policy = "on-request"` run requests `require_escalated` for another out-of-scope write and requires the non-interactive native client to reject it without creating the target file. These checks verify outer Codex sandbox and approval results instead of Server-side fields.

Zero Risk is a separate manual acceptance phase because the Server must be in Zero Risk browser-interaction mode and a human must perform its normal Launcher handshake. Switch the production Launcher to Zero Risk, export a fresh Zero Risk client model catalog, rerun the server attestation, and copy the new attestation to the Codex client. Then use the same remote settings and run:

```sh
export CODEX_WEB_REMOTE_ZERO_RISK_MODEL="chatgpt-web/zero-risk"
# Optional: increase this when manual ChatGPT interaction needs more than 15 minutes.
export CODEX_WEB_REMOTE_ZERO_RISK_TIMEOUT_MS="900000"
bun run accept:delegated:zero-risk
```

During this command, complete each visible Zero Risk prompt through the normal Launcher flow: paste/send, confirm **Sent**, use the `Codex Zero Risk` connector for `codex_turn_start`, the requested Native tool, and `codex_turn_complete`. The Server still has no client rollout/Codex filesystem state, so the delegated Zero Risk round has no trusted filesystem environment even if raw environment text is present in the native request. The harness first requires a native `pwd`/read round and final completion. It then asks the real Codex `app-server` for `thread/compact/start`. Because the source Zero Risk turn has already completed, delegated compaction must retire that retained source and use the fresh compaction fallback; complete that second manual Zero Risk prompt too. A final native turn must recover a challenge marker from the compacted context and complete normally. The harness never uses `--dangerously-bypass-approvals-and-sandbox`.
