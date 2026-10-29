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
  Latest must identify version 6 for a GPT-6 Pro response. No version fallback is allowed.
- Pre-6.0 slugs remain hidden catalog entries with their original fixed bindings, including the
  unpinned `chatgpt-web/pro`. They keep old tasks and cached selections working. The existing release
  upgrade reruns integration setup and invalidates the model cache; Codex must restart for the new
  picker. Native model budgets are preserved; Web routes use the account/model history table below.
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
changes require another explicit connector identity. The current context-rendering/text-batch-v1
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

ChatGPT DOM contracts live in [`src/chatgpt-ui`](../src/chatgpt-ui/README.md), grouped
by composer, model picker and turn renderer. Each component records its historical
evidence and regression coverage. Model policy and turn ownership remain outside
that layer. Diagnostic checkpoints identify observed structural variants without
copying message content; a variant's age never selects or retires it automatically.

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
server-authenticated session and a new ordinary chat composer in the primary owned view, then closes
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
and costs. It does not change source choice, permissions, or retry policy. MCP text reads accept a
`reads` array of 1–8 distinct targets and use a separate
`context-text-batch-v1` result with two metadata representations and one independent body block per
returned item. A whole batch has one transaction and one validated successful-transport receipt;
any invalid item prevents all new coverage. Single images retain their original result and
confirmation through one-item arrays. Protocol 6 and manifest 3 publish a fixed required batch
chain, so normal pure-text startup needs no required directory traversal. A final overview
establishes settled readiness. The expanded profile caps a complete text response at 64 KiB and
8,000 estimated tokens; it is a local budget, not proof of real platform acceptance.

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

Automatic and Zero Risk task turns use Temporary Chat by default. The `useTemporaryChats`
preference (`setup --temporary-chats`; `--ordinary-chats` to disable) selects the mode for task
turns, connector verification and smoke tests. Sign-in and account inspection still use ordinary
chats. The retired `useSavedChats` preference is discarded and cannot override the new setting.
An absent new setting defaults to true; an explicit false is preserved.
Changing modes retires idle retained task surfaces after setup succeeds; the launcher refuses
to change it during active browser work. This is independent of conversation reuse. Saved history
does not authorize reopening an arbitrary ChatGPT conversation. Applicable unified tasks retain
verified page reuse across compaction. Temporary Chat does not provide a saved-history fallback
when a retained page is lost; the existing recovery admission and source checks still apply.
ChatGPT memory and custom instructions may apply in either mode.

Automatic mode also offers an explicit **New browser chat for each turn** setting, disabled by
default (`setup --fresh-conversation`; `--retained-conversation` restores reuse). Each logical send
that needs actual new browser input selects a new page with a legal cold-start plan and current
connector attachment. Tool rounds, HTTP replays and task updates do not create pages solely for
this preference. It changes page choice, not work identity, stop, checkpoint or retry facts. The
existing Zero Risk send capability and manual boundaries still apply.

Default Full/MCP planning compares inline and selective delivery for Automatic and Zero Risk,
including GPT-6 Instant and Luna/Think. Payload v3 uses an external position table for optional
fields and an optional detailed source_map; manifest 3 and text-batch-v1 use protocol 6. Requests,
effective rules, current delegation and recovery checkpoints remain required. Only trusted ordinary
assistant history is optional by default; unknown mixed records and unproved skill/image scope
remain required. See [context navigation](context-navigation.md) for exact source and reuse rules.

Bigger Context, its configuration/capability/API/IPC surfaces and new two-/six-stage transactions
are removed. Saved old values normalize to default behavior. Legacy command switches have no
effect and report removal. Historical staged bodies remain readable data, not executable sends.
Browser-only has no new MCP capability and must use a complete legal single-message input or fail.

The account/model catalog selects H/C of 200k/180k, 300k/270k, 500k/450k or 600k/540k, with C = 90%
of H; Full + Launcher has no override. These are history policies. Single-message transport remains
independent, including Luna's ordinary 28,000-token input and existing Pro text limits. H/C cannot
raise read-response, composer, image, attachment, storage or time limits. Full/MCP Luna/Think
estimates canonical history and uses independent client compaction at 180k; Browser-only Luna
retains rolling checkpoints and projected usage.

Cumulative delivered tokens/wire bytes are diagnostics. They cannot reject Send, read, completion,
compaction registration/submission or page reuse. Missing cost records alone cannot force a page.
No ordinary or compaction total reading ceiling is derived from page history or summary reserves.
Required delivery, source identity, permissions, settlement, ACK and independent resource limits
remain gates.

In Full mode, routed compaction v1/v2 uses the exact retained source agent and a one-shot MCP control
capability that accepts only the bound checkpoint; it cannot claim or invoke the ordinary Codex tool
environment. When required, the same control message also supplies an independent
`compaction_token` and a bounded entry into complete legal sources. The model chooses its reads;
submission does not require full reading or image coverage. Reading grants no submission or business
authority. Source availability, in-flight reads, and original ownership
and settlement checks still gate acceptance. A permanent source failure prevents a checkpoint.
Zero Risk retains its manual-send boundary. Account/model history tiers remain separate from actual
delivery limits. Active compaction receives
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

The continuity runtime separates durable receipt, model delivery and HTTP observation. Its task
inbox binds a trusted native thread/turn and execution scope to stable native message IDs, exact
text digests and receive sequence S. Original text lives in owner-only payload files. Metadata and
body reservations use the recovery store's existing lock and 24 MiB global budget. Page deletion
does not delete pending or stopped task inputs, and a saved inbox never grants execution rights.
Detailed completed inbox records retire after a different native turn completes, the 30-minute
historical Session replay window ends, and the older work, writers and delivery coverage settle.
A failed successor preparation preserves the old head and does not start that window.
A durable source fence precedes body
deletion; maintenance finishes interrupted reclamation after restart. The small remaining fence
uses the same budget and blocks delayed old-source admission after page-journal deletion.

Receipt can occur during preparation, thinking, tools, final output, compaction or manual waiting.
It does not change M/R/G/H. A controlled Native/result/ACK entry can deliver an ordered finite
prefix to a compatible `task-updates-v1` capability. That delivery advances M for its messages and
G once, while recovery R advances per admitted work. Real tools retain their original completion
rights. One immutable delivery is outstanding until its exact ACK. Without a boundary, accepted
input waits for the next ordinary physical response, whose M/G start at zero. Final output and
compaction sources remain frozen; later input cannot relabel an earlier answer or summary.

Session keeps physical execution ownership separate from the current tool observer association.
Changing that association does not change G or invalidate a final candidate/lock/CAS. Old observers
cannot claim new calls or cancel successors. Normal waits emit nonterminal commentary/heartbeat;
`incomplete(task_update_handoff)` is not used as a normal transition. Distinct physical responses
produce distinct assistant items in JSON and SSE. No current observer means no automatic new Send
or Native business admission. Zero Risk keeps its manual confirmation gates for every new prompt.

The Launcher Activity panel reads saved originals through authenticated local control IPC. It
shows storage use and supports copy, exact-body repair, explicit retry after stop, pre-delivery
discard and original cleanup. See the [public protocol](native-tool-protocol.md#durable-task-input-queue)
and [acceptance gate](release-validation.md#continuity-input-queue-validation).

### Unified task continuity

Ordinary `chatgpt-web/` routes use one task mechanism for supported Full Native + Launcher
Automatic and Zero Risk paths. Task/work, execution attempt/generation, source/plan and physical
page are separate. Healthy compatible pages receive increments and remain usable across accepted
compaction. Fresh selects pages for actual new logical sends without changing task identity.
Zero Risk retains its manual-send boundary. Ordinary tool ACK, task-update ACK and compaction
submission retain their separate contracts.

The public history tiers and 90% compaction thresholds follow the
[account/model table](context-navigation.md#history-window-and-client-compaction), including aliases.
Lower client limits still apply. Canonical Full/MCP usage remains distinct from actual browser,
attachment, storage, per-response and result-cache limits. Cumulative page accounting is diagnostic.

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
Every physical Send is counted once after semantic acceptance, including historical staged sends;
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

Native task recovery normally uses the bridge's own `CODEX_HOME`. An operator can register up to
seven additional local homes through `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`, a JSON array of absolute
existing directories. Request data cannot register homes. Directory aliases are canonicalized;
the resolver establishes one owning home before reading the current turn's permissions and rejects
duplicate thread ownership. Each secondary home uses its own `sqlite_home` configuration, without
inheriting the primary process's SQLite override. With multiple homes, every turn needs current
native proof and the legacy single-home environment cache is neither read nor written. DEV profile
activation removes the production registration. See [setup details](../TROUBLESHOOTING.md#a-second-codex_home-fails-with-missing-network-access-in-trusted-codex-environment-context).

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
