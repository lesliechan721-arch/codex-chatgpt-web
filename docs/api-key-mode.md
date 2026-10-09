# Standalone API Key mode: usage and runtime contract

## 1. Scope

This document maintains the long-term contract for access keys, configuration ownership, save-and-restart behavior, and manual client export. For upstream v2 model selection and metadata, see [Upstream provider](upstream-provider.md). For the global authenticated proxy, see [Network proxy](network-proxy.md).

The goal is to simplify access setup while keeping the server access policy separate from Codex configuration that the user maintains manually. HTTP access still has two independent modes, `openai` and `api-key`. These are separate from `browser-only` / `full` and `automatic` / `manual`.

Without a custom upstream provider, API mode remains Web-only: `chatgpt-web/*` and `chatgpt-web-continuity/*` use the ChatGPT browser adapter, and non-Web models plus native search/image endpoints are not forwarded. After a usable OpenAI-compatible upstream provider is configured, non-Web Responses requests are forwarded according to the saved v2 explicit model selection and proxy policy, and the corresponding search/image endpoints are enabled. Both Web prefixes always remain owned by the local route. OpenAI forwarding mode does not read the upstream configuration. Full / Zero Risk continue to use the existing Tunnel and Connector.

## 2. Launcher workflow

Entry point: **Settings → Access mode**.

- Select **OpenAI forwarding** or **API Key** to choose the server access mode. There is no separate "apply configuration" step or second confirmation dialog.
- When API mode is enabled for the first time and no reusable key exists, the Launcher first shows the key field. Enter a key or generate one, then select **Save and switch** after validation. API mode is not enabled without a valid key.
- When a reusable key already exists, selecting API mode saves the setting and attempts to restart the backend directly.
- In API mode, the Launcher shows a masked key. **Show / hide**, **Copy key**, and **Reset key** control visibility, copying, and replacement. Reset uses the same compact input field and attempts a backend restart after the new key is saved.
- Base URL, upstream settings, **Copy Codex config**, **Export TOML**, and the export preview appear only in API mode. The Codex TOML is an explicitly sensitive export: it contains the current local service API Key, but not the custom upstream API Key. Proxy environment values are shown separately from the TOML.

The UI primarily reports **Saved and active** or **Saved, backend not yet loaded** instead of exposing multiple configuration stages. When a saved change is not active yet, it shows the current runtime mode and offers **Retry restart**. The mode and key can also be saved before runtime initialization; they take effect after initialization.

An API Key can contain 32–256 ASCII letters, digits, `-`, and `_`. Random generation uses `randomBytes(32)`, not a predictable timestamp or `Math.random()`.

## 3. Saving and runtime activation are separate

```text
validate input, old config revision, and non-reuse of the management token
    ↓
atomically save api-access.json             ← the setting is committed here
    ↓
clean old injection by mode / try to restore the OpenAI route
    ↓
try to restart the supervised backend inside the current Launcher
    ↓
read the policy revision from health to confirm activation
```

**If the backend cannot stop or start, the saved mode or key is not rolled back.** The UI also does not claim that the new key is active.

Behavior by case:

| Case | Configuration save | Runtime handling |
| --- | --- | --- |
| Backend idle and Launcher-managed | Save | Use the existing `stopForSetup()` to drain/stop, then `startIfConfigured()` |
| Active HTTP, browser, or MCP work | Save | Do not force cancellation; mark restart pending |
| Another Launcher configuration operation is running | Save | Defer configuration cleanup and restart |
| Controlled stop fails | Save | Old process keeps the old policy; UI reports pending activation |
| New process fails to start | Save | Do not restore the old key; report stopped or pending activation |
| Externally managed backend | Save | Do not terminate the external process; its manager must restart it |
| Runtime not initialized yet | Save | Wait for initialization; do not create fake runtime state |
| Invalid input, disk write failure, or stale revision | Do not save | Return an explicit error and do not start restart work |

The "hot restart" here is a **backend child-process restart without quitting the Launcher**. It reuses the existing supervisor lifecycle. It is not an in-memory replacement of daemon authentication policy, and it does not add a hot-update management endpoint that a client key can call. Full mode handles the Tunnel through the existing supervision flow.

Runtime policy is still loaded when the service starts. Before a successful restart, the old key can remain valid and the new key can remain unavailable. The GUI reports the setting as active only when the health `api_access_revision` matches the HMAC calculated from the on-disk policy and management token, and the backend accepts work. After key rotation, update the client environment and start a new Codex process.

There is no timed backend restart queue. After active work finishes, use **Retry restart** or restart the Launcher normally. The Launcher does not force a queued restart in the middle of a task.

## 4. Key storage, viewing, and migration

### 4.1 Server authentication file is unchanged

`api-access.json` in the private application directory remains version 1:

```json
{"version":1,"mode":"api-key","keySha256":"<64-character lowercase hexadecimal SHA-256 digest>"}
```

OpenAI mode is `{"version":1,"mode":"openai"}`. If the file does not exist, the previous OpenAI-forwarding behavior remains. A damaged file does not silently downgrade.

The server still validates the key by digest. The client key, daemon `controlToken`, and Tunnel runtime key do not substitute for one another. Changing the access mode or key does not extend management-endpoint permissions.

### 4.2 Recoverable copy for the GUI

To support **Show saved key**, the main process maintains `secrets/api-client-key.json`:

```json
{"version":1,"digest":"<matching key digest>","ciphertext":"<Base64 OS-encrypted ciphertext>"}
```

When the GUI normally switches back to OpenAI mode, it also records the digest of a key that may be reused in `secrets/api-client-key-reuse.json`.

The Launcher uses Electron `safeStorage.encryptString/decryptString`. Ciphertext is written atomically to an owner-only file. The main process decrypts only after an explicit show/copy action or when reuse is required. A normal state refresh does not decrypt the key.

Linux `basic_text` and `unknown` backends are not treated as secure storage. If OS encryption, a keyring, or the ciphertext write is unavailable, the Launcher does not fall back to writing plaintext to disk. The key can still be shown or copied from main-process memory during the current session, and the GUI tells the user to keep their own backup. The authentication digest is still saved, so this condition does not block the mode switch.

The key does not enter `launcher-state.json`, normal snapshots, broadcast events, or operation logs. Only an explicit **Copy Codex config** or **Export TOML** action puts the current local service API Key into that sensitive export as `experimental_bearer_token`. The custom upstream API Key never enters Codex TOML. A separate IPC path returns the key only to the trusted main window. Changing state, hiding the value, losing window focus, or uninstalling the component clears the displayed string. After 60 seconds, clipboard cleanup occurs only if the clipboard still contains that same key; it does not erase content copied later. System clipboard history is outside this guarantee.

### 4.3 Legacy and CLI keys

Older installations and keys generated/imported through the CLI may contain only the digest. **Plaintext cannot be recovered from SHA-256.** Such a key can still authenticate, but the Launcher cannot display a value that it does not have. The user can continue using a separately saved value or reset the key in the GUI to create a new encrypted copy.

When an external CLI writes the access policy, it removes the GUI reuse marker. After a CLI rotation, an older GUI encrypted copy can be viewed only if its digest matches the current policy. If the CLI later disables API mode, it still cannot make the old key reusable again. The GUI also discards a mismatched copy when leaving API mode so that it cannot be reused later.

The local operating-system account, process memory, and keyring permissions remain the security boundary. This is not a multi-tenant credential vault.

## 5. In API mode, Codex configuration is exported only by the user

### 5.1 No new automatic injection

In API mode, none of these paths installs a new Codex route, provider, or hook:

- Launcher initialization, MCP/browser interaction settings, capability refresh, and runtime upgrade paths that eventually call `setup()`;
- `route connect/disconnect`;
- subagent protocol switching;
- daemon `serve` startup.

These paths may only clean injections that have an ownership journal from an earlier installation. `auth.json` and provider/table configuration that the user maintains manually are not generated or overwritten automatically. On a normal local installation, the GUI export writes `api-key-models.json` in the application directory and returns TOML. The user chooses where to paste/merge the TOML or downloads it explicitly.

Server remote-desktop deployment uses `CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG=1`. In this mode, setup, route, subagents, and reconnect do not modify Codex configuration inside the container or on an external client. The export returns TOML, model-catalog content, and the target client path. The server does not write a catalog into its own HOME for an external Codex client. The external client must copy both files itself.

### 5.2 Cleanup of earlier injected configuration

`cleanupApiKeyCodexIntegration()` and `api-key cleanup` handle old managed injection. Enabling API mode in the GUI, CLI enable/rotate, setup, and daemon startup attempt this cleanup.

The existing integration journal is authoritative. Cleanup uses the original `replacementBaseline()` restoration logic and only removes/restores route, feature, agent-depth, and Interrupt-hook entries still owned by this installation. Later user changes to `model_provider`, `model_catalog_json`, other providers, MCP, skills, and similar configuration remain.

- No journal: do not infer ownership from similar fields or URLs. Manually copied configuration remains unchanged.
- Journal exists but the config file was deleted: do not recreate an empty config only for cleanup.
- Ownership path mismatch or modified hook: report a cleanup conflict; do not force-delete or overwrite.
- After successful cleanup, remove the old journal/recovery state and old model cache so that a later API setup does not inject them again.
- When multiple files must be updated, keep snapshots, compensate on failure, and check for concurrent changes before writing.

A cleanup conflict does not undo the saved access mode. The GUI reports cleanup as pending. Resolve the conflict and retry, or run `api-key cleanup`. Suspected leftovers without a journal require manual review because the installation's previous values cannot be inferred safely.

When switching back to OpenAI mode, the GUI tries `api-key reconnect` to restore the native forwarding integration, but it does not forcibly overwrite a conflicting route. Failure still saves the selected mode and records `api-access-routing-pending.json` so that the Launcher continues to report the incomplete restoration after restart. Successful reconnect, setup, or route connect clears the marker. A manually selected `model_provider` is not deleted automatically; the user must check the client's actual selection.

## 6. What the exported configuration includes

Compatible settings from the original forwarding integration are generated through the existing code instead of duplicating another set of defaults:

| Setting | API export policy |
| --- | --- |
| Custom `model_provider` / model / effort / `model_catalog_json` | Keep the existing API-mode export |
| `experimental_bearer_token` / `requires_openai_auth = false` / Responses wire API | Keep; `experimental_bearer_token` contains the current local service API Key and `env_key` is no longer emitted |
| `supports_websockets = false` | Keep; use the existing HTTP/SSE transport only |
| `web_search = "disabled"` | Keep; do not call blocked native search endpoints |
| `[tui] auto_recap = false` | Disable background recap requests in all exported profiles, matching automatic integration |
| `[features] instant_interrupt = false` | Disable instant model-stream interruption in all exported profiles; this steering path does not invoke the Interrupt hook |
| `[features] multi_agent = true` | Export in Compatibility V1 mode, matching automatic integration |
| `[features] multi_agent_v2 = false` | Export in Compatibility V1 mode; native mode does not force a downgrade |
| `[agents] max_depth` | Reuse the V1 default, currently 2; the user can retain a larger existing value |
| `[[hooks.Interrupt]]` | Normal local API mode exports the same runtime command, application home, and `timeout=3`; server remote-desktop deployment does not export a container-local command hook |
| `openai_base_url` | Exclude; API mode uses the custom provider's `base_url` |
| `experimental_realtime_webrtc_call_base_url` | Exclude; it depends on native OpenAI identity and conflicts with standalone API access |
| `[hooks.state] trusted_hash` | Exclude; the target file and hook index are user-selected, so export does not fabricate pre-approval state |
| Custom upstream API Key, OAuth, Tunnel credentials | Never export; the local service API Key enters TOML only during an explicit sensitive Codex export |

After values are generated from the shared feature builder, automatic-management comments are removed. Manually exported settings are owned by the user and must not look like a new journal-managed installation.

The Responses endpoint rejects identified Codex recap requests with HTTP 400 and
`codex_recap_not_supported` before browser creation, continuation changes, or upstream forwarding.
Detection requires Codex turn metadata with `thread_source=system` and the bounded recap JSON schema
(`summary` and nullable `next_action`). Ordinary summary prompts and other system schemas keep their
normal route. Automatic and manual `/recap` calls use the same contract and are both rejected.
Restart Codex after merging `tui.auto_recap = false`; existing clients retain their loaded setting.

Codex enables `instant_interrupt` by default. Exported configurations disable it because the
bridge does not support instant interruption of an active model response. Merge
`features.instant_interrupt = false` into existing client settings and restart Codex.

On a normal local installation, the exported Interrupt hook is a declaration, not automatic authorization. After merging it, the user approves the command through Codex as required. Server remote-desktop deployment does not depend on a client command hook for correctness. It continues to use HTTP disconnect cancellation and additionally enables a no-progress timeout for native turns. When `[features]`, `[agents]`, or hooks already exist, merge by field instead of appending duplicate TOML tables or importing the same hook twice.

## 7. Usage examples

### Launcher

1. Complete the existing ChatGPT/runtime initialization, or save the access mode first and initialize later.
2. In Settings, select API Key. Enter or generate a key if required, then save it.
3. Confirm that the state is active. If restart is pending, finish active work and retry.
4. Show or copy the key, then copy/export the sensitive Codex configuration that contains the local API Key and merge it manually into the target `CODEX_HOME/config.toml`. Apply the separate Codex process proxy environment from the same export.
5. Restart Codex. The exported provider carries the local service API Key through `experimental_bearer_token`; Codex no longer needs to read it through `env_key`. Browser login remains separate.

### CLI

```bash
# Enable API mode. The generated value is written only to stdout, never to a command argument.
CODEX_CHATGPT_WEB_API_KEY="$(bun run src/cli.ts api-key enable --generate)" || exit 1
export CODEX_CHATGPT_WEB_API_KEY

# Explicitly retry cleanup of earlier injection recorded in the journal.
bun run src/cli.ts api-key cleanup

# CODEX_CHATGPT_WEB_API_KEY must still match the current policy's local key.
# The TOML output contains the local key and separately reports the Codex process proxy
# environment. It does not write ~/.codex/config.toml.
bun run src/cli.ts api-key codex-config
```

CLI changes still require a restart through the existing service-management path. The GUI **Show** action can recover only copies created by the GUI. Save CLI output separately. Re-export the model catalog/configuration after model permissions, interaction mode, context, or subagent settings change.

## 8. HTTP, proxy, and execution boundaries

Every `/v1/*` request still validates the local Bearer first. Without a usable upstream provider, API Key mode remains Web-only: `/models`, `/responses`, and `/responses/compact` use local ChatGPT Web routing, while non-Web models and search/image endpoints remain rejected. With a usable upstream provider, `/models` merges only upstream models that are both selected and discovered in the current request; allowed non-Web `/responses` and `/responses/compact` requests are forwarded upstream, and `/v1/alpha/search`, `/v1/images/generations`, and `/v1/images/edits` are enabled. `chatgpt-web/*` and `chatgpt-web-continuity/*` always use local Web routing and cannot be overridden by the upstream provider. A catalog failure or missing model does not delete the saved allowlist; see [Discovery, selection, and catalog publication](upstream-provider.md#discovery-selection-and-catalog-publication).

Normal local installations continue to listen only on `127.0.0.1`. Server remote-desktop deployment is a constrained exception: only when the saved access policy is API Key may the deployment listen on `0.0.0.0` inside the container. Compose still publishes the port only on the host loopback, and external Codex uses the existing HTTPS reverse proxy for `/v1`. The reverse proxy must not publish `/healthz`, `/admin/*`, CDP, or the raw VNC port. A configured public remote Base URL must be an HTTPS URL ending in `/v1`. If it is empty, a client on the same host uses `http://127.0.0.1:<port>/v1`.

Server remote-desktop deployment can also set a no-progress timeout for native turns. The current deployment variable is `REMOTE_TURN_IDLE_TIMEOUT_SEC`, with a default of 600 seconds. This is not a total turn-duration limit. The same `thread_id + turn_id` shares one idle lease. Text/reasoning deltas, tool-call creation, tool results, and real compaction progress can renew it. Retry/continuation requests, adapter/browser heartbeats, and TCP liveness cannot. If a tool call is issued but no result or other real progress occurs, idle time continues to accumulate. On timeout, the server terminates the related HTTP/browser/compaction ownership and rejects recreation of a lease for the same identity. Normal local installations do not enable this deployment timeout by default.

The only wait exception is a Broker-accepted, unfinished Native operation with a valid 120-second consumer lease. It pauses termination after idle expiry, but it does not refresh the real last-progress timestamp. When the operation finishes, or its lease expires and no other qualifying operation exists, idle evaluation resumes immediately from the original timestamp; the turn does not receive a new 600 seconds. See [Native long-wait contract](native-tool-protocol.md#consumer-lease-and-timeout-boundaries) and [Remote deployment](../deploy/server/README.md#external-codex-client).

Custom upstream networking uses a strict three-state policy: `global` reuses the current global proxy, `direct` forces direct connection without changing the process proxy environment, and `custom` uses only the specified HTTP/HTTPS proxy. A normal local Codex client connects to loopback. An external client in server deployment uses the exported public Base URL or the host-loopback fallback. Exported startup environment merges loopback into `NO_PROXY` and includes proxy variables only when the Launcher has a global proxy. The application's control token, local client API Key, and upstream API Key remain strictly separate.

JSON/SSE, the MCP tool loop, continuation, v1/v2 compaction, and the Luna checkpoint keep their own runtime contracts. Capability declarations in exported configuration do not change routing ownership between local Web models and the third-party upstream provider.

## 9. Main implementation files

| File | Responsibility |
| --- | --- |
| `launcher/src/ApiAccessSettings.tsx`, `api-access.css` | Simplified mode switching, key controls, and copy/export UI |
| `launcher/electron/api-access-settings.cjs` | Save-first behavior, controlled restart, cleanup, and activation state |
| `launcher/electron/api-key-vault.cjs` | OS-encrypted copy, explicit decryption, and session-memory fallback |
| `launcher/electron/upstream-api-key-vault.cjs` | Independent OS-encrypted copy for the upstream API Key and session-memory fallback |
| `launcher/electron/upstream-provider-config.cjs`, `upstream-provider-network.cjs` | Upstream configuration validation/atomic save and Launcher-side manual model discovery network |
| `launcher/electron/api-access-ipc.cjs`, `preload.cjs` | Minimal IPC surface for the trusted renderer |
| `src/api-key-integration.ts` | Cleanup of earlier configuration from the ownership journal |
| `src/setup.ts`, `src/cli.ts`, `src/api-key-cli.ts` | Entry-point guards that prevent automatic Codex injection in API mode |
| `src/api-key-codex-config.ts` | Render sensitive Codex configuration containing the local bearer and generate the separate process proxy environment |
| `src/upstream-provider.ts`, `upstream-provider-config.ts` | Daemon v2 upstream configuration, runtime snapshot, explicit model selection, and revision |
| `src/upstream-network.ts`, `upstream-passthrough.ts` | Three-state transport and OpenAI-compatible upstream forwarding |
| `src/upstream-model-catalog.ts`, `launcher/electron/codex-model-metadata.cjs` | Local/upstream catalog, shared metadata completion, and full validation |

## 10. Validation and acceptance

To prevent the current API Key policy and inherited proxy variables from contaminating tests, Core/`verify` should use temporary `HOME`, `CODEX_HOME`, and `CODEX_CHATGPT_WEB_HOME`, and clear inherited HTTP(S)/ALL proxy variables in the test subprocess. Isolating only the application HOME is not sufficient because test cleanup can fall back to the real user directory. This isolation does not modify the real Launcher or user configuration.

Repeatable repository entry points are `bun test ./tests`, `bun run --cwd launcher test`, typecheck/build on both sides, and the full `bun run verify`. Record the version, scope, and actual result that were run. A historical successful run does not prove that the current release passes.

Automated tests use the real filesystem plus injected supervisor/safeStorage simulations. They are not equivalent to an actual Electron OS keyring, a real third-party upstream provider, or an end-to-end ChatGPT account test. Release checks are listed in [API access, upstream, and proxy validation](release-validation.md#api-access-upstream-and-proxy-validation).

Recommended checks:

1. First-time API selection requires a valid key; an existing GUI key can be reused. Key reset and mode switching do not require an extra Apply/backup confirmation.
2. Inject stop/start failures and confirm that configuration remains saved, the old backend can keep serving, and the UI does not report the new key as active. Active work is not cancelled.
3. Close and reopen the Launcher and recover a new key through the OS-encrypted copy. On Linux without a keyring, the key remains viewable only for the current session and is not stored as plaintext.
4. Migrate from OpenAI injection and confirm that route/features/hook entries are cleaned while manually maintained providers, MCP, and skills remain. A modified-hook conflict must not delete the hook incorrectly.
5. Repeat setup, upgrade, browser-mode/subagent-protocol changes, and restart in API mode. They must not recreate Codex injection. Manual configuration without a journal must remain byte-for-byte unchanged.
6. Confirm that manually exported TOML parses; it contains the current local service API Key as `experimental_bearer_token`, the matching V1 subagent configuration, and the Interrupt declaration. It does not contain the upstream API Key, native route, or path-specific trust state. Proxy environment remains a separate export.
7. Configure a test upstream provider and verify `global`, `direct`, and `custom` networking, v2 explicit model selection, all four metadata modes, manual model discovery, Responses/compact, search/images, and fallback to a fresh local catalog when upstream `/models` fails.
8. Connect a client without OAuth and verify local Web models, streaming answers, the MCP tool loop, cancellation, and compaction. Unauthorized requests remain rejected, and neither local Web prefix can be overridden by the upstream provider.
