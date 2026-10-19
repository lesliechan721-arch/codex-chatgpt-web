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
- Ordinary connector calls present the current outer Codex turn capability. The Broker keeps its
  derived binding private and admits business dispatch under operation, revision, and image-readiness
  checks. Context calls read fixed sources instead; compaction reads use a separate read-only capability.
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
broker attached to that tunnel for the command's lifetime. The distinct `Codex Native5 DEV`
connector reaches the same MCP server and turn-token contract without requiring any Responses
daemon or colliding with the production `Codex Native5` connector.

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

The ChatGPT connector name is also the public MCP ABI identity. Context navigation uses
`Codex Native5` in Automatic, `Codex Zero Risk4` in Zero Risk, and `Codex Native5 DEV` in isolated
DEV. Its three public tools include mutually exclusive ordinary and compaction-read credentials.
Existing Native operations, waiting, task revisions, and ACKs retain their contracts. Settings can
change the part after `Codex ` for the selected mode. The retired `Codex Native`, `Codex Native2`,
`Codex Native2 DEV`, `Codex Native3`, `Codex Native3 DEV`, `Codex Native4`, `Codex Native4 DEV`,
`Codex Zero Risk`, `Codex Zero Risk2`, and `Codex Zero Risk3` are never selected or refreshed in
place. Setup migrates known legacy local configuration transactionally and requires the necessary
configuration steps for the selected identity.
The user creates a new remote plugin. Exact browser selection never falls back to a retired
identity. Production and DEV plugins can remain installed together. Future released public schema
changes require another explicit connector identity. The current context-rendering/text-read-v2
work is an update to an unreleased feature and retains Native5 / Native5 DEV / Zero Risk4 and
non-retired custom names. It upgrades the internal context protocol and capability evidence instead.

Settings fixes only the `Codex ` prefix and edits the rest of the selected mode's name: `Native5`
by default in Automatic, `Zero Risk4` in manual mode, and `Native5 DEV` in Automatic DEV. Mode names
are stored independently and must differ. Setup preserves custom nonlegacy names across upgrades
and mode changes. When upgrading from
`Codex Native4`, `Codex Native4 DEV`, or `Codex Zero Risk3`, preserve the old remote connector and
create the corresponding new connector; never rename or refresh an old identity.
A name change uses the existing setup transaction, rejects active work, and requires completion of
the changed configuration after success. The user must create a new plugin with that exact name.
Renaming a display label does not itself replace a remote connector's cached schema; retired connector identities cannot
be selected as new names and legacy connectors are still never reused. If a preserved custom name
still caches a pre-navigation public contract, use the original new-name migration. For the
unreleased text-v2 update, refresh/reconnect the same current connector when needed. If that
cannot establish v2 support, stop its use without selecting another or retired identity.
A saved-name mismatch can require completion of the changed configuration without changing the
configured custom name. A compatible setup-marker upgrade alone does not reset valid configuration.
The marker records configuration completion, independent of diagnosis. Local health, installed
`tools/list`, and browser connector selection cannot prove the remote cached schema. Optional
Verify runtime registers a bounded private read-only pair over fixed small text, then requires six
successful transport returns: list/search/read with ordinary and independent compaction credentials. Capability
evidence 2 additionally binds each read to the actual v2 result shape and supported-transport digest.
The contract fingerprint includes tool descriptions, the text-read version, and any output schema.
Old evidence is invalid. The pair
has no business or compaction-submission authority. Automatic uses real submission evidence;
manual uses the original user selection, Send, start, and Sent policy. The owner-only sidecar binds
the result to profile/home, mode, exact plugin, tunnel, runtime command, and installed schema digest,
with no time-based expiry. A retry clears that mode's old result; a binding change invalidates it.
Normal tasks, context projection, compaction, and recovery do not consume this record as permission.
Missing, unreadable, failed, old, or mismatched records do not change plans or trigger automatic
checks. Diagnosis does not clear configuration completion, and success does not bypass required
configuration steps. Current protocol, credential, source, budget, delivery, and commit checks
remain in place. The result proves shape and callability at that time, not model body use or the
platform's raw cached schema. Separate real ordinary tasks and compaction transactions check body
use through their existing answer/checkpoint
exits; the private verifier still cannot complete a task. Image and model acceptance remain part
of [release validation](release-validation.md#context-navigation-validation).

## Browser lifecycle

The following describes the browser lifecycle. Unified task recovery is described
separately below.

The desktop launcher owns one persistent Electron partition and up to five task-bound browser
tabs. Each task owns an exact `WebContentsView` lease. Compatible native messages reuse that
surface, while each message receives a fresh turn-bound MCP token and keeps all of its MCP rounds
inside one ChatGPT response. For eligible unified routes, accepted compaction advances history
revision while retaining a healthy compatible page; page replacement is a separate action. Other
paths keep their existing lifecycle. Model messages never copy state between unrelated task tabs. Tabs share only the local login
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

The selected Codex input retains its task-text contract. In Full/MCP mode, eligible tool-history
fields can become references into an immutable legal-source snapshot, with a bounded entry in the
actual browser input. Retained inputs also receive a fresh entry when they omit
readable history. The canonical request and real tool results used for settlement stay intact.
Images prefer fixed inline MCP image blocks; required fallback images use the existing attachment
path. Image bytes stay out of the prompt JSON. No context JSONL file, synthetic context document,
or intermediate summary is created. The [context navigation contract](context-navigation.md)
defines source provenance, net-savings selection, effective budgets, and failure boundaries.

After the existing selected-input mapping and cleanup, a deterministic presentation layer compares
legacy JSON with `codex-context-text-v1`. The new representation keeps structural JSON and places
eligible long strings in length-bound raw blocks. It preserves the delivered value tree and uses
dynamic outer fences. Short/no-benefit fields stay JSON; unverified editor whitespace stays JSON.
The [byte contract](context-rendering.md) defines decoding and collision checks. Selection measures
complete inputs, fixes the actual format and bytes before Send, and records the format with coverage
and costs. It does not change source choice, permissions, or retry policy. MCP text pages use a
separate `context-text-read-v2` result with two metadata representations and one body block.

Initial Launcher setup asks which interaction mode to install and defaults to With Automation. The
same choice remains available in Settings; changing it uses the transactional setup path, replaces
the installed catalog, and requires a Codex restart. Zero Risk never reads or mutates the ChatGPT DOM.
For a new ChatGPT chat the adapter provides the selected cold-start plan, including effective
instructions and any required on-demand entries; unsent full-source compilation is not its browser
gate. For an exactly retained chat it also provides a legal incremental prompt with current entry
and coverage checks. The Launcher chooses between those two prompts from its own retained-tab ownership and writes
the selected text to the system clipboard. The Launcher captures the Sent-confirmation policy for
each manual turn. The adapter sends its expected policy with `/v1/manual/start`; if that expectation
does not match the Launcher's captured policy, the start fails before the prompt is exposed. The
captured policy does not change if the global setting changes while the turn is active.
When navigation is active, the Launcher selects and validates the exact full/resume plan before
display or copy and returns its plan receipt. Required fallback images have a separate bounded
manifest and explicit user confirmation. That confirmation is independent of Sent and connector
start, remains necessary with Sent disabled, and records a user statement rather than inspected
attachments. All-MCP plans need no attachment confirmation. Readiness gates new bridge business
work and successful completion; it does not replace task-update ACK or real-result settlement.

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
an arbitrary ChatGPT conversation. Applicable unified tasks prefer page reuse across compaction;
account inspection continues to use an empty Temporary Chat. ChatGPT memory and custom instructions
may apply to saved conversations.

Automatic mode also offers an explicit **New browser chat for each turn** setting, disabled by
default (`setup --fresh-conversation`; `--retained-conversation` restores reuse). Each logical send
that needs actual new browser input selects a new page with a legal cold-start plan and current
connector attachment. Tool rounds, HTTP replays and task updates do not create pages solely for
this preference. It changes page choice, not work identity, stop, checkpoint or retry facts. The
existing Zero Risk send capability and manual boundaries still apply.

Bigger Context partitions complete ordered records against each message's available token and
composer budgets. Inert stages carry text; the final message also carries actual fallback attachments,
the execution contract and any output schema. Their reserves are deducted before partitioning,
then preflight checks the actual compiled messages and total transaction. The selected execution
effort and attachment references remain unchanged. Large transactions use up to six messages;
the actual delivery window and multipart thresholds depend on the model and account. These are
separate from the public unified-task history window and automatic-compaction threshold. GPT-5.6 and
GPT-6 Pro retain three-times budgets. GPT-6 Sol on Pro accounts at Medium, High, or Extra High
uses a 240,000-token context window and a 220,000-token compaction threshold. Plus supports
Medium, High, and available Extra High with a 120,000-token window and a 110,000-token compaction
threshold. GPT-6 Instant uses standard budgets. Luna/Think can opt into experimental multipart
transport with an 84,000-token ceiling derived from its 28,000-token per-message transport budget;
this is not a verified Free recall window. Multipart Luna sends complete canonical history without
the rolling checkpoint; disabling Bigger Context restores ordinary checkpoint transport.
More parts reduce message size without increasing these delivery limits. Bigger Context uses
existing supported model/account and transport capabilities. Applicable unified routes use the
separate 1,000,000 / 900,000-token history budget; it does not increase browser input capacity.

In Full mode, routed compaction v1/v2 uses the exact retained source agent and a one-shot MCP control
capability that accepts only the bound checkpoint; it cannot claim or invoke the ordinary Codex tool
environment. When required, the same control message also supplies an independent
`compaction_token` and a bounded entry into complete legal sources. The model chooses its reads;
submission does not require full reading or image coverage. Reading grants no submission or business
authority. Source availability, remaining summary allowance, in-flight reads, and original ownership
and settlement checks still gate acceptance. A permanent source failure prevents a checkpoint.
Zero Risk retains its Bigger Context multipart prohibition. Applicable unified routes advertise
1,000,000 / 900,000 history values separately from actual delivery limits. Active compaction receives
the checkpoint instruction as an MCP result and submits through its bound completion control.
A healthy compatible page can remain after the checkpoint; replacing it is a separate decision.
Every actual new manual input still requires its selected plan, Sent and attachment confirmation.
An ended Zero Risk response retains the explicit manual checkpoint handoff.

Applicable Automatic lost-page compaction rebuilds complete legal sources and admits the actual
read-only on-demand plan, without requiring their full inline browser compilation. Closed or
unknown pages use the current request after best-effort old-execution revocation; old Send,
settlement, checkpoint, and retry records do not gate new-page admission. Current-page commits
remain single-writer transactions, and physical cleanup is independent. Non-applicable routes retain their original compaction interval,
page retirement and fresh summarizer/source admission behavior. An invalid or
ambiguous handoff still fails explicitly. Browser-only mode
uses the same read-only summarization path, then returns the native replacement-history shape expected
by Codex. A prompt-level checkpoint marker is translated into a visible Codex trace item;
every later tool action in the same turn continues to present the current turn capability. Visible
ChatGPT status rows become reasoning summaries, while stable prose between rows becomes native
Codex commentary.

### User updates during Native tool work

A new compatible Full Native runtime negotiates `task-updates-v1`. A proven plain user suffix in
the same native thread and turn can keep the existing physical ChatGPT response after the old
local execution records identify its source and pending tools. Result batches may arrive partly;
first-result and expected-type checks remain mandatory. Broker state separates accepted, delivered, and acknowledged revisions from driver
generation and registry generation. A short owner transfer commits the registry, updates, new
driver, and real result batch together; an unknown receipt recovers the same transfer.

The Session registry stores one physical execution with bounded logical request routes. Exact
reconnects replay only their own immutable journals. During the ACK gap, a further append can
replace the active Responses observer; that observer ends with `task_update_handoff` while the
physical response continues. Control arrives only in existing MCP replies or ACK replies.
It adds no composer message, Native tool, or extra browser observation barrier. Versioned browser
and helper candidates preserve their captured task head through completion and final text.

Once final output locks, appends wait for normal continuation. Initial manual requests awaiting
Sent and unproven or unsupported inputs retain their existing boundaries. Unresolved updates block compaction; accepted updates make the latest logical route
the exact compaction source. See the [public protocol](native-tool-protocol.md#user-updates-during-tool-work)
and [acceptance gate](release-validation.md#inflight-user-update-validation).

### Unified task continuity

Ordinary `chatgpt-web/` routes use one task mechanism for supported Full Native + Launcher
Automatic and Zero Risk paths. Task/work, execution attempt/generation, source/plan and physical
page are separate. Healthy compatible pages receive increments and remain usable across accepted
compaction. Fresh selects pages for actual new logical sends without changing task identity.
Bigger Context retains existing model/account, staged ACK/final-commit and Send-retry limits;
Zero Risk retains its existing prohibition and manual-send boundary.

The public history window is 1,000,000 estimated tokens with a 900,000 automatic-compaction
threshold, including equivalent ordinary aliases. Lower client limits still apply. Canonical
history usage remains distinct from actual browser/attachment, source storage, navigation and
answer-cache budgets. No million-token browser input is implied.

Ordinary unfinished recovery, checkpoint continuation, and uncommitted compaction select the
page-lifecycle branch before historical admission. A current authenticated Launcher must confirm
both the actual document and its generation for live-page reuse. That branch retains current
payload, owner, revision, result, and compaction conflict checks. Matching retries can attach or
replay. A disk receipt alone does not establish a live page.

Closed or unknown pages use the current expanded request's instructions, summaries, history,
real results, and required images. They need no old work/checkpoint ledger or equality with old
history. Complete eligible sources may exceed an inline prompt, but actual readable content and
the selected plan must fit HTTP, snapshot, navigation, account, and delivery limits. Old tool text
is context, not dispatch authority. Lost compaction can generate a new summary; it is not an
exact old-commit replay. Current-page compaction still commits once.

Project revocation precedes successor activation. Backend, Broker, helper, and Launcher check the
current generation at dispatch and commit boundaries. Make a best effort to cancel or close old
work, without waiting for unavailable Send, tool-settlement, or destruction proof. Serialize
same-thread selection and recheck after asynchronous queries; matching recoveries share one
creation and execution. Old results, stops, helper receipts, final output, checkpoints, and ACK
cannot write the successor or rebuild deleted records. Original in-flight completion channels
can finish only their old transmission.

Closing a page removes its registration, work/call, stop/completion, history/checkpoint/retry,
binding/index, and task snapshots by exact generation. A late destroyed event cannot remove a
new page. Do not retain replacement task tombstones or history archives. The independent
one-hour memory/disk API increment cache remains, including its existing missing-context 409.
Installation identity and login state also retain their existing lifetimes.

Physical cleanup is a fixed-target transaction with at most three automatic attempts. Closing
or failed-cleanup documents count toward five real pages until actual destruction. A revoked
page can remain while a successor uses a free slot; logical revocation does not release capacity.
Incomplete cleanup retains minimum physical identity and close-retry data. Pressure can reclaim
safe idle pages; active or uncertain work is not idle. HTTP disconnect or interrupt alone does
not establish closure and does not start background recovery.

Old independent names are rejected with an ordinary replacement name. Managed exports use
ordinary names; user TOML needs explicit replacement. Migration preserves required confirmed-live
activity, installation/login state, and the increment cache, removes closed-page records, and
revokes unknown generations. Legacy, missing, or corrupt old journals cannot become a permanent
deny list. Run compatible backend, Broker, helper, and Launcher versions; files on disk do not
prove runtime compatibility. Actually unavailable creation interfaces remain service errors.
Excluded Non-Launcher, Browser-only, Luna, Think, and upstream API paths retain existing behavior;
local Web API Key authentication alone is not excluded.

Recovery may execute previously stopped or completed work, and an unreachable old execution can
still produce external effects. Revocation does not undo issued commands or guarantee exactly-once
business execution. See [session continuity](session-continuity.md) for current-page relationships,
limits, cleanup, and manual handoff, and [release validation](release-validation.md) for actual
coverage and outstanding real-platform checks.

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
