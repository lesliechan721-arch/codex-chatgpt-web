# Security model

## Trust boundaries

The user trusts the Codex client, the daemon's configured listener boundary, the launcher's private
Electron browser profile, the selected ChatGPT workspace, OpenAI's tunnel service, and the exact MCP
connector they created. Normal local installs keep the daemon on loopback. The server remote-desktop
deployment may place an API-Key-protected Responses listener on the private container interface while
the host and HTTPS reverse proxy remain the external network boundary. Repository contents, tool
output, websites, and prompt text are untrusted data.

## Full-mode capability flow

1. The daemon accepts a Codex Responses turn on its configured Responses listener. Normal local
   installs use `127.0.0.1`. The server remote-desktop deployment can bind the private container
   listener to `0.0.0.0` only after API-Key access is enabled.
2. Tool authority has two explicit modes. `verified-environment` is the local default. It extracts
   `cwd`, workspace roots, and sandbox policy from the native Codex envelope. When a resumed root
   task or subagent omits that envelope, its canonical local rollout must prove the exact thread and
   current turn (or latest source turn for standalone compaction). A context-only continuation after
   completed compaction also binds the exact checkpoint and source instruction to its native thread,
   turn, model, and effort. A new environment claim without a new human message must match the
   canonical rollout in cwd, roots, and sandbox policy; the checkpoint alone grants no filesystem
   authority. `delegated` does not read filesystem authority, rollout files, or Codex SQLite
   state. It accepts only the current native `thread_id`, native `turn_id`, and the tool registry
   advertised by the current Responses request. The server remote-desktop deployment forces this
   mode. User-authored `<environment_context>` text is prompt context only and cannot add authority.
3. It creates a random, turn-scoped token and embeds it in that one ChatGPT browser prompt. Treat this
   short-lived bearer token as a capability secret. Until revocation or expiry, possession of the
   token grants the tools allowed by its originating turn's current registry. The token stays bound
   to its originating native thread and turn and cannot be rebound to another native turn. In
   delegated mode the current tool registry can be replaced between rounds; each replacement
   increments a monotonic generation.
4. Every Codex Native action presents that same turn token. The MCP handler idempotently claims an
   internal binding plus a request-scoped activity lease and immediately dispatches the requested
   action; neither internal handle is exposed to the model. The lease is settled only after the MCP
   handler finishes, including inventory calls that need no outer Codex tool.
5. MCP can request only a callable tool advertised by the active outer Codex turn. Before a new
   call ID exists, the broker checks the requested wire name against its latest registry, so a
   stale MCP claim cannot reopen a removed tool. An already-admitted call can still complete after
   a later registry replacement. The adapter also checks each delivered batch against the current
   Responses request. The raw orchestration `exec` gateway remains available in Full mode. Before caller-authored
   JavaScript runs, the bridge wraps its tool registry with a transparent proxy that enforces the
   exact 10-second `wait_agent` polling contract and prevents recursive raw `exec`. The generic
   inventory/call pair also provides a structured exact-name path. Codex remains responsible for
   its sandbox, approval, UI, command sessions, and tool result.
6. Before a Codex tool batch is dispatched, the browser records and acknowledges the current answer
   projection. Completion stays blocked while the tool is unresolved and then requires a new stable
   final-answer projection after that causal boundary. A two-phase broker fence then rereads the DOM
   and commits completion only if the activity revision stayed unchanged with no active invocation;
   a concurrent claim makes the candidate lose, while a claim after commit receives an explicit
   terminal rejection. Recent MCP activity may suppress a false DOM-health failure but never adds
   an idle delay to a successful completion.

The bridge transports decisions; it does not add a second planner, semantic router, or fallback
model. Every available effort uses the same MCP contract. An unavailable account route, missing
connector, or missing outer tool fails explicitly instead of becoming an effort-specific exception.

The direct turn-token MCP schema is attached only through the `Codex Native3` connector identity.
The older `Codex Native` and `Codex Native2` connectors are treated as legacy and are never selected as a fallback. This
prevents a cached legacy schema from being mistaken for the current capability contract.

## Principal risks

### Prompt injection and destructive tool use

ChatGPT sees repository content and tool results that may contain hostile instructions. Full mode
can invoke write and command tools. Use a trusted workspace, keep Codex sandbox/approval settings
appropriate, and grant only intended connector actions. Automatic per-call approval is off by
default.

### Browser session theft

The launcher's persistent Electron partition can authorize ChatGPT access. It remains in the
current OS user's private application-data directory and is never copied into a daemon prompt or
runtime descriptor. Never sync, upload, attach, or commit it. On suspected exposure, sign out or
revoke the ChatGPT session from the launcher.

### Tunnel credential theft

The runtime key needs only Tunnels Read + Use. It is accepted through a hidden prompt or copied
from a file, stored with user-only permissions, referenced by file, and never placed in a command
argument or generated profile. Rotate it after suspected exposure.

### Same-user local process

In the default OpenAI-forwarding path, the Responses endpoint remains loopback-only and has no
independent bearer secret because the built-in Codex OpenAI provider cannot be configured with a
bridge-specific credential while preserving the native provider/task identity. Another process under
the same OS user can reach that port. API-Key mode requires the client bearer before `/v1/*` is
served. The server remote-desktop deployment permits a non-loopback container listener only in this
API-Key mode; Compose publishes it on host loopback and the intended remote path is the existing
HTTPS reverse proxy.

The lifecycle endpoints are separate from the Responses surface. `/admin/drain`, `/admin/resume`,
`/admin/cancel-turn`, `/admin/cancel-turns`, and `/admin/shutdown` require a random bearer token stored in the
user-only application config. The launcher uses them to reject new work, prove that both the HTTP
request and long-lived browser/tool loop are idle, flush response state, and stop a process. The
token does not turn loopback into a hostile-local-process security boundary; it prevents accidental
or unauthenticated lifecycle control through ordinary requests.

### Browser/UI drift

ChatGPT DOM and labels are not a stable API. Selectors are narrow; Full-mode completion requires
stable completed-turn evidence and, after tools, a new final-answer projection. UI drift fails the
turn; it never chooses another model, starts another transport, or returns a fabricated success.

### Login-state isolation

The launcher keeps ChatGPT login, identity-provider navigation, and model turns in one private
Electron partition. Allowed login popups are adopted into an in-launcher `WebContentsView` that
shares that partition; unrelated external links remain outside it. A visible composer alone is not
authentication evidence: the launcher also requires a valid server session and an exact Temporary
Chat URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

Browser turns use at most five independent task-bound tabs in one private login partition. Every
outer Codex task owns an exact launcher surface lease and retains its Temporary Chat only across
sequential messages in the same model/effort/compaction epoch; chats are never reused across tasks.
Closing a running tab destroys its page and terminates that turn. The five-tab limit bounds parallel
account traffic. Tool calls remain in the same ChatGPT response. The
bounded local continuation cache is private, expires, and exists only to implement Codex
`previous_response_id` replay. Full-mode context compaction accepts a checkpoint only through its
one-shot MCP control capability in the exact retained source chat. If that chat no longer exists, a
fresh tool-free Temporary Chat receives the canonical Codex history; the bridge never parses ordinary
assistant prose as a structured handoff.
In delegated mode, retained compaction source proof comes only from the request-carried source turn ID,
source message ID, source content, current native thread, model, and reasoning identity. Rollout aliases
and rollout-derived source-turn fallbacks are not accepted. Missing or conflicting proof retires the
retained conversation before a fresh compaction starts from the full request history.

## Network exposure

- Normal local installs bind Responses and health to `127.0.0.1`.
- In the server remote-desktop deployment, Responses may bind to `0.0.0.0` inside the private
  container only in API-Key mode. The default Compose publication is host-loopback only, and the
  external HTTPS reverse proxy exposes only `/v1`. It must not expose `/healthz`, `/admin/*`,
  CDP, or raw VNC.
- Full mode uses OpenAI's outbound HTTPS Secure MCP Tunnel; it opens no public listener or inbound
  firewall rule.
- The embedded browser connects to ChatGPT, the selected identity provider during explicit sign-in,
  and user-authorized attachment URLs through normal browser networking.

## Non-goals

- Defending against a compromised local OS user or compromised Codex/Electron binary.
- Bypassing ChatGPT plan, workspace, usage, action-control, or model restrictions.
- Making consumer browser automation equivalent to a supported OpenAI API contract.
