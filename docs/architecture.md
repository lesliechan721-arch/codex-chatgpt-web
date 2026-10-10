# Architecture

```text
Codex app / CLI
      │ Responses API on loopback by default
      ▼
launcher-owned codex-chatgpt-web daemon
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ authenticated native Search and Image Gen request forwarding
  ├─ ChatGPT browser worker (up to five task-bound Electron tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel
            ▼
      ChatGPT custom connector
```

For maintained topic contracts, see the [documentation index](README.md). Native operation identity
and waiting are defined in the [Native tool protocol](native-tool-protocol.md); API Key upstream
routing and metadata are defined in the [upstream provider guide](upstream-provider.md).

## Modes

### `browser-only`

- Exposes `GPT-5.6 Luna (Web)` with ordinary/Think effort on Luna-only accounts. Sol-capable accounts
  get `GPT-5.6 Sol Instant (Web)` and `GPT-5.6 Sol (Web)` with Medium/High and available Extra High.
  Pro-capable accounts also get separate `GPT-5.6 Pro (Web)` and `GPT-6 Pro (Web)` rows.
- Instant retains its own context budget. Grouped efforts must have identical context and compaction
  limits; catalog generation rejects a mismatch rather than reducing a budget. Pro rows use the
  native `max` effort; `ultra` is not used for new rows because Codex transforms it before transport.
- Named Sol/Pro routes select the exact browser family and verify it again before every Send.
  Latest must identify version 6 for a GPT-6 Pro response. Its existing lower-effort multipart
  acknowledgements identify 5.6, then the final part returns to verified 6 Pro. No version fallback.
- Pre-6.0 slugs remain hidden catalog entries with their original fixed bindings, including the
  unpinned `chatgpt-web/pro`. They keep old tasks and cached selections working. The existing release
  upgrade reruns integration setup and invalidates the model cache; Codex must restart for the new
  picker. Native models and existing context/compaction budgets are preserved.
- Sends the complete Codex context and image attachments to a fresh ChatGPT conversation (Temporary Chat by default).
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same models and attaches the turn-bound connector capability to every available
  effort, from Luna through Pro. There are no effort-specific MCP exclusions.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- When Codex exposes tools behind its code-mode `exec` gateway, the connector discovers their
  runtime registry and can invoke an exact listed name through bridge-owned code. Full mode also
  preserves Codex's native freeform `exec`; its tool registry enforces the same bounded
  `wait_agent` contract as direct and structured calls.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

### Repository DEV driver

The DEV chat is not another provider or browser implementation. It is a synthetic outer-Codex
driver around the same in-process Responses handlers. `dev launcher` starts the packaged launcher
with an explicit `development` profile. That profile has a different core home, sandboxed
`CODEX_HOME`, Electron `userData`, persistent browser partition, descriptor, cookie jar, login,
configuration, chat store, diagnostic store, broker path, tunnel profile, and alias. The normal and
DEV launchers can therefore run at the same time with different ChatGPT accounts.

The working-tree adapter attaches to a tab leased only from that DEV launcher. In Full mode the DEV
launcher owns one persistent, isolated tunnel runtime; a named CLI chat owns only the private turn
broker attached to that tunnel for the command's lifetime. The distinct `Codex Native4 DEV`
connector reaches the same MCP server and turn-token contract without requiring any Responses
daemon or colliding with the production `Codex Native4` connector.

Only the responsibilities normally owned by native Codex are synthetic: named history storage,
turn metadata, tool-result execution, context-threshold scheduling, and installation of compacted
replacement history. Every tool result is an explicit `simulated: true` receipt with
`side_effects_performed: false`; no semantic router guesses a command result.

The driver calls `responseRequest` and `compactRequest` directly. It starts no HTTP server, does not
read or write Codex's route journal or `config.toml`, and does not stop or replace the normal
launcher-owned daemon. A `dev-harness` discriminator prevents the Responses server and production
launcher from starting a Responses daemon for its config. DEV setup stores browser capabilities
and tunnel credentials but performs no Codex integration, system service installation, or port
probe. The DEV launcher supervisor owns only the isolated MCP tunnel. Browser diagnostics, broker
state, thread authority, checkpoints, and named chat state live
under `~/.codex-chatgpt-web-dev` by default.

The ChatGPT connector name is also the public MCP ABI identity. The `task_updates-v1` start
revision and ACK tool require new identities: `Codex Native4` in Automatic and `Codex Zero Risk3`
in Zero Risk; Settings can change the part after `Codex ` for the selected mode. The retired
`Codex Native`, `Codex Native2`, `Codex Native2 DEV`, `Codex Native3`, `Codex Native3 DEV`,
`Codex Zero Risk`, and `Codex Zero Risk2` identities are never selected or refreshed in
place. Setup migrates known legacy local configuration to the current identity, clears prior verification state, and
requires the user to create the new connector. Browser verification accepts the exact new identity,
reports a specific migration error when only the legacy identity is visible, and never falls back to
the legacy connector. Future public schema changes require another explicit connector identity.
Repository DEV mode uses `Codex Native4 DEV` so the same ChatGPT account can keep both production
and development connectors installed without renaming, refreshing, or deleting either one.

Settings fixes only the `Codex ` prefix and edits the rest of the selected mode's name: `Native4`
by default in Automatic, `Zero Risk3` in manual mode, and `Native4 DEV` in Automatic DEV. Mode names
are stored independently and must differ. Setup preserves custom nonlegacy names across upgrades
and mode changes. When upgrading from
`Codex Native3`, `Codex Native3 DEV`, or `Codex Zero Risk2`, preserve the old remote connector and
create the corresponding new connector; never rename or refresh an old identity.
A name change uses the existing setup transaction, rejects active work, and clears MCP verification
only after success. The user must create a new plugin with that exact name. Renaming a display
label does not itself replace a remote connector's cached schema; retired connector identities cannot
be selected as new names and legacy connectors are still never reused. If a preserved custom name
still caches an older public contract, choose a new name and create a new plugin.

## Browser lifecycle

The following describes the recoverable `chatgpt-web/` policy. The continuity policy is described
separately below.

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each task/model/effort/compaction epoch owns one exact `WebContentsView` lease; sequential
native messages reuse that surface, while each message receives a fresh turn-bound MCP token and
keeps all of its MCP tool rounds inside one ChatGPT response. Compaction asks the same retained Web
agent for a one-shot structured checkpoint, waits for the response and physical helper cleanup,
then closes the old surface. The next epoch gets a new browser chat. Model messages never copy
state between tabs. Tabs share only the local login
partition and keep independent documents and lifecycles. Closing a running tab destroys its page
and terminates that browser turn. A sixth concurrent turn fails explicitly; the cap avoids excessive
parallel traffic that could trigger account abuse controls.

Browser submission and response binding use ChatGPT's logical `data-turn-id`, not the
`conversation-turn-N` display index, which can change during rendering. The submission baseline
includes the persistent `data-turn-id-container` wrappers of virtualized history. Remounting old
messages therefore cannot count as a new submission or another user's turn. Missing or duplicate
logical identities fail explicitly; accepted messages are never resent to repair their DOM.

Sign-in uses that same persistent Electron partition. ChatGPT login pages and allowed identity-
provider popups are adopted into a temporary `WebContentsView` inside the launcher instead of being
redirected to another browser. After the provider returns to ChatGPT, the launcher requires both a
server-authenticated session and the Temporary Chat composer in the primary owned view, then closes
the temporary auth view. There is no browser-profile handoff, cookie import, CDP login port, or
temporary session-transfer directory.

The current compiled Codex task context is inserted as one inline JSON envelope. Image bytes stay
out of the JSON and are attached natively with stable references. The runtime does not create a
context JSONL file, upload a synthetic context document, include prompt hashes, or silently truncate
the envelope. Attachment acceptance and send readiness are verified before the turn begins.

Initial Launcher setup asks which interaction mode to install and defaults to With Automation. The
same choice remains available in Settings; changing it uses the transactional setup path, replaces
the installed catalog, and requires a Codex restart. Zero Risk never reads or mutates the ChatGPT DOM.
For a new ChatGPT chat the adapter provides the complete compiled prompt; for an exactly retained
chat it also provides an incremental prompt containing only the Codex suffix after the last assistant
reply. The Launcher chooses between those two prompts from its own retained-tab ownership and writes
the selected text to the system clipboard. The Launcher captures the Sent-confirmation policy for
each manual turn. The adapter sends its expected policy with `/v1/manual/start`; if that expectation
does not match the Launcher's captured policy, the start fails before the prompt is exposed. The
captured policy does not change if the global setting changes while the turn is active.

With Sent confirmation enabled, an ordinary manual handoff allows one minute to paste, select the
visible ChatGPT model, effort, and Zero Risk connector, send, and confirm Sent; a manual compaction
handoff allows two minutes. Copying the prompt again restarts this confirmation timer, and the prompt
remains available to copy until the plugin starts. Sent ends that confirmation deadline. With Sent confirmation disabled,
the Launcher does not show the Sent button and instead allows up to five minutes for the first MCP
connector bind, which confirms the turn automatically. After either confirmation path succeeds, the
live turn remains subject to explicit cancellation and runtime-owner cleanup.
The pasted task carries one opaque `request_id` for routing concurrent requests. Start/completion
sequencing lives in the Zero Risk MCP server metadata, not in user-authored imperative text; the
per-tab nonce used to validate the Launcher confirmation never leaves the local runtime.

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.
Top-level `model_context_window` raises only the proxied native rows' advertised maximum, allowing
Codex to apply its own configured context override without clamping. Routed ChatGPT Web models
retain their measured adapter-owned limits.

**Save chats in ChatGPT** (`setup --saved-chats`; `--temporary-chats` restores the default)
uses ordinary saved conversations for task turns in Automatic and Zero Risk modes. This is
independent of conversation reuse. Changing it releases idle retained tabs, and its provider
configuration participates in conversation identity. Saved history does not authorize reopening
an arbitrary ChatGPT conversation. Compaction still starts the next context epoch in a new chat;
account inspection continues to use an empty Temporary Chat. ChatGPT memory and custom instructions
may apply to saved conversations.

Automatic mode also offers an explicit **New browser chat for each turn** setting, disabled by
default (`setup --fresh-conversation`; `--retained-conversation` restores reuse). Each native turn
gets a new browser chat, the complete canonical Codex context and a fresh connector attachment.
Tool rounds and reconnects within that turn keep their existing owner. Compaction deliberately
uses a fresh read-only summarization chat with the same bounded lifecycle. This can isolate lost
connector access on retained follow-ups, at the cost of resending more context. The preference is
preserved but inactive in Zero Risk mode.

Bigger Context partitions complete ordered records against each message's available token and
composer budgets. Inert stages carry text; the final message also carries all retained attachments,
the execution contract and any output schema. Their reserves are deducted before partitioning,
then preflight checks the actual compiled messages and total transaction. The selected execution
effort and attachment references remain unchanged. Large transactions use up to six messages;
the advertised context and compaction thresholds depend on the model and account. GPT-5.6 and
GPT-6 Pro retain three-times budgets. GPT-6 Sol on Pro accounts at Medium, High, or Extra High
uses a 240,000-token context window and a 220,000-token compaction threshold. GPT-6 Instant and
GPT-6 Sol on other plans use standard budgets. More parts reduce message size without increasing
these total limits. Bigger Context applies only to non-continuity models. Session continuity
ignores this preference and does not use multipart staging; its separate
1,000,000 / 900,000-token history budget does not increase browser input capacity.

In Full mode, routed compaction v1/v2 uses the exact retained source agent and a one-shot MCP control
capability that accepts only the bound checkpoint; it cannot claim or invoke the ordinary Codex tool
environment. Zero Risk always advertises a fixed three-times compaction interval without enabling
Bigger Context multipart transport. At that boundary its active ChatGPT response receives the
checkpoint instruction as an MCP result, returns the compacted context through its bound completion
control, and ends. The old manual chat is retired; the next compacted Codex request owns a fresh
browser chat and its locally compiled prompt is copied to the clipboard. A missing Automatic
retained source falls back to a dedicated read-only browser chat built from canonical Codex
history; a missing Zero Risk source uses the same explicit manual checkpoint contract. An invalid or
ambiguous handoff still fails explicitly. Browser-only mode
uses the same read-only summarization path, then returns the native replacement-history shape expected
by Codex. A prompt-level checkpoint marker is translated into a visible Codex trace item;
every later tool action in the same turn continues to present the current turn capability. Visible
ChatGPT status rows become reasoning summaries, while stable prose between rows becomes native
Codex commentary.

### User updates during Native tool work

A new compatible Full Native runtime negotiates `task-updates-v1`. A proven plain user suffix in
the same native thread and turn can keep the existing physical ChatGPT response after the old
Responses round has registered its tools and tool-use terminal and Codex returns the complete
real results. Broker state separates accepted, delivered, and acknowledged revisions from driver
generation and registry generation. A short owner transfer commits the registry, updates, new
driver, and real result batch together; an unknown receipt recovers the same transfer.

The Session registry stores one physical execution with bounded logical request routes. Exact
reconnects replay only their own immutable journals. During the ACK gap, a further append can
replace the active Responses observer; that observer ends with `task_update_handoff` while the
physical response continues. Control arrives only in existing MCP replies or ACK replies.
It adds no composer message, Native tool, or extra browser observation barrier. Versioned browser
and helper candidates preserve their captured task head through completion and final text.

Once final output starts, the ordinary replacement path applies. Continuity-first work, initial
manual requests awaiting Sent, and unproven or unsupported inputs retain their existing mode
boundaries. Unresolved updates block compaction; accepted updates make the latest logical route
the exact compaction source. See the [public protocol](native-tool-protocol.md#user-updates-during-tool-work)
and [acceptance gate](release-validation.md#inflight-user-update-validation).

### Continuity policy

`chatgpt-web-continuity/` is a separate, opt-in namespace. Only trusted routing selects the policy.
Full Native tools, Launcher, supported
account/model/effort controls, and compatible helper features are required. Fresh Conversation
Per Turn is rejected. Bigger Context applies only to non-continuity models. No additional internal release-verification flag is
required to expose these models.

The physical conversation key does not change at compaction. Execution keys and response rounds
include a trusted scope and a separate history revision. Before first-page creation, the actual
ordinary input passes environment, identity, version, input, and capacity checks, then a durable
content-free registry records the thread and current ownership. Logical work identity is independent
of page generation; completed or stopped receipts are checked before loss handling. A missing live
owner is coordinated through durable admission records. A changed scope or damaged registration
still fails before new work.

The compaction driver accepts the exact source's handoff, waits for physical settlement, retires
old execution authority, and commits one checkpoint/revision while retaining the page. Accepted
but uncommitted evidence remains bounded evidence, not continuation authority. Completed ordinary
answers remain separate from control summaries. Zero Risk uses only an active response's real
MCP control delivery; a response that already ended requires manual handoff without a new prompt.

The 1,000,000/900,000-token catalog values govern canonical Codex history. Actual browser prompts
still use the original transport checks. Healthy ready pages and their current logical heads
use a 24-hour successful-work clock; queries and replay do not renew it. Five protected pages
block a sixth allocation. Durable registration, checkpoint evidence, response caches, tool
capabilities, and physical pages have separate limits and lifetimes; retained pages do not extend
tool authority. Restart recovery uses separate durable evidence. See [the policy guide](session-continuity.md)
for limits, failure handling, and release status.

Continuity work identity uses native instruction identity, locally issued tool batches, and the
accepted source/revision transaction. Completed history, client output echoes, and checkpoint
prefix positions are not content proofs. Current payload conflicts still fail. An ordinary
reconnect replays its original journal; a result retry selects its original local batch. Journal
and batch comparison records share the 512-round bound, with the initial ordinary journal
protected while its execution is retained. Reclaimed results cannot start new work.

Continuation input uses current native instruction ownership and the committed checkpoint relation.
An explicitly owned new turn can omit its completed predecessor. The native instruction prefix of
the current execution-history window remains part of the current payload, including developer and
grouped AGENTS instructions whose turn metadata records their earlier creation. Unowned instructions
mixed with completed output remain ambiguous and are rejected before submission. Source relationships and codec comparison data live in the bounded checkpoint commit; continuity
does not recover source authority from the ordinary mode's continuation cache. Each request reuses its selected commit, and the start
boundary checks ownership again before consuming its transition once. Historical edits are not sent
back to the retained page. Active ordinary reconnects publish the current tool registry under the
execution lock before replaying their journal; historical execution replay cannot update a later owner.


Recovery introduces sequential page generations while preserving the thread's monotonic history
revision. A versioned, content-minimal journal records source lineages, work/attempt/snapshot
identities, send/delivery-possible stages, first-result digests, stop/completion receipts, stable
compaction targets, and continuation consumers. New side effects require durable admission first.
No operation object or capability is restored from disk. A missing result must be supplied through
the authenticated request or remain a specific recovery gap.

A lost page can initialize from the current canonical request after old thread write authority and
delivered calls settle. Authenticated Launcher creation/query/preparation transactions are unique
across retries and versions; late receipts cannot take over a later generation. Healthy pages are
preferred, and a transient inspect failure pauses submission rather than declaring permanent loss.
A new explicit instruction can restart after stop or mode exit; stopped retries cannot revive.

Automatic can finish an uncommitted lost compaction in a new tool-free page, or commit an existing
valid handoff once. Committed results only replay. Checkpoints keep durable call coverage and one
consumer relationship; that consumer's later attempts reuse the relationship without consuming it
again. Completed-source checkpoint-only requests replay the original answer. Zero Risk ended
compaction still needs manual handoff, and all new ordinary Zero Risk prompts need actual sending.

## Local ChatGPT Limits

The launcher Limits page is an opt-in estimate of its own accepted browser submissions. Setup
reads the current personal ChatGPT account and the Billing panel's Pro tier; a model-picker Pro
badge alone cannot distinguish Pro $100 from Pro $200. The private store keeps account hashes,
submission receipt IDs, timestamps, and model families, never prompts or authentication tokens.
Every physical Send is counted once after semantic acceptance, including Bigger Context stages;
native tool rounds and stream reconnects do not create receipts. The selected slider's accessibility
announcement identifies GPT-6 Pro versus GPT-5.6 Pro. Unidentified Pro sends are visibly uncertain.

The page compares rolling 24-hour and seven-day local counts with the published Chat allowances.
It does not claim OpenAI's reset time, include messages sent elsewhere, or enforce a model limit.
Writes are drained before the browser lease is released; accounting failure cannot replay an
accepted Send. Account changes require another plan check, and Zero Risk performs no inspection
or tracking. Production and DEV keep separate stores in their own launcher profiles.

## Installation and service lifecycle

Each native desktop package contains Electron, a platform-matched pinned Bun executable, the
Responses bridge, Playwright client code, MCP server, setup, doctor, and the browser helper.
Browser-only mode downloads no browser and requires no installed Chrome/Chromium or system Node/Bun;
sign-in and model turns both remain in Electron. Full mode separately downloads the official pinned
`openai/tunnel-client` build for the current OS/architecture and verifies it against the release
SHA-256 manifest.

On first launch, the embedded runtime is checked against a deterministic manifest covering every
file path, size, and SHA-256 before any launcher port or window opens. The source, transactional
temporary copy, and final destination are all validated before the private versioned directory is
accepted under the application home. Daemon and MCP commands use that durable copy, which is
required because Linux AppImage mount paths are temporary and must never be persisted in Codex or
tunnel configuration.

The launcher is the sole process supervisor on macOS, Windows, and Linux. It starts the optional
tunnel first, waits for healthy/ready evidence, starts the Responses daemon, and then waits for its
versioned health payload. Native login items or an owner-local XDG autostart file launch the app
hidden after sign-in. A marker containing only launcher-owned PIDs lets doctor distinguish the
launcher runtime from a stale or external process. Legacy macOS launchd services are drained and
removed during an explicit launcher migration; launchd remains only for the advanced terminal-only
mode.

Setup keeps Codex's built-in `openai` provider. It routes Responses through the local daemon with
`openai_base_url`, while pinning `experimental_realtime_webrtc_call_base_url` to Codex's official
ChatGPT endpoint so Voice session creation never falls through to the Responses-only bridge. Both
assignments are journaled and restored exactly on disconnect or uninstall; a conflicting existing
Voice route requires explicit `--replace-codex-route` ownership. The daemon forwards the
authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed. Subagent protocol selection is explicit,
and new installations default to Compatibility V1 because it is the only surface portable across
native and routed Web backends:

- **Compatibility V1** pins every delegation-capable native and routed row to V1 and atomically
  manages `multi_agent = true`, `multi_agent_v2 = false`, and `[agents].max_depth` of at least 2 so
  a routed child can spawn a routed grandchild. The integration journal preserves the user's prior
  scalar, structured-feature, and agent-depth lines and restores them byte-for-byte on disconnect,
  native-mode selection, or uninstall. The ChatGPT connector projects `wait_agent` as an explicit
  10-second polling contract: terminal semantics stay native, while every non-terminal poll releases
  the serialized MCP channel so Web children can run their own harness tools.
- **Native** preserves every official native row and gives routed rows the selected template's
  protocol surface. Under MultiAgent V2, Web-origin `spawn_agent`, `send_message`, and
  `followup_task` calls include Codex's explicit `encrypted_function_args: []` plaintext marker.
  A genuinely encrypted native-to-Web payload is rejected with one HTTP 400 before a browser is
  opened; it is never turned into an SSE disconnect/retry loop.

Catalog metadata alone never claims to change an existing task's protocol. Codex pins the protocol
when a task starts, and its global `multi_agent_v2` override wins over per-model metadata. Switching
protocol therefore requires restarting Codex and starting a new task. Model choice, effort,
context, and service tiers are otherwise unchanged.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active HTTP requests, including native compaction, Search, and Image Gen forwarding;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. The launcher then stops the
tunnel through its runtime command and asks the daemon to flush state and exit through an
authenticated shutdown endpoint. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible. An
unexpected child exit is recovered with a bounded restart budget; a crash loop becomes an explicit
launcher error.

## Security invariants

- Normal local installs bind the Responses proxy and health endpoint to loopback. The server
  remote-desktop deployment may bind Responses to the private container interface only in API-Key
  mode; host publication stays private/loopback and the external reverse proxy exposes only `/v1`.
  Health and lifecycle control endpoints remain non-public.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
