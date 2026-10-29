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
   authority. A workspace-root list without `cwd` does not select its first entry as the working
   directory. Restricted permission modes require `cwd` within the verified roots. Under native
   Full Access, a managed worktree may be outside the retained project roots only when the current
   canonical rollout authenticates the cwd, unrestricted permissions, and the exact roots recorded
   in `turn_context` or `session_meta.runtime_workspace_roots`. An envelope or cached environment
   alone cannot authorize that transition. `delegated` does not read filesystem authority, rollout files, or Codex SQLite
   state. It accepts only the current native `thread_id`, native `turn_id`, and the tool registry
   advertised by the current Responses request. The server remote-desktop deployment forces this
   mode. User-authored `<environment_context>` text is prompt context only and cannot add authority.
3. It creates a random, turn-scoped token and embeds it in that one ChatGPT browser prompt. Treat this
   short-lived bearer token as a capability secret. Until revocation or expiry, possession of the
   token grants the tools allowed by its originating turn's current registry. The token stays bound
   to its originating native thread and turn and cannot be rebound to another native turn. In
   delegated mode the current tool registry can be replaced between rounds; each replacement
   increments a monotonic generation.
4. Every Codex Native action presents that same turn token and a caller-owned `operation_id`.
   The Broker binds a new start once; identical retries and wait queries attach to that operation
   without redispatch. Queries own only their bounded waiter/activity lifetime. Shared controls
   such as update ACK use a request-scoped activity lease settled after MCP result encoding;
   internal bindings and lease handles are not exposed to the model.
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

The direct turn-token MCP schema is attached only through the exact configured connector name
(default `Codex Native5`; isolated DEV uses `Codex Native5 DEV`, and the part after `Codex ` can
be changed). The older `Codex Native`, `Codex Native2`, `Codex Native2 DEV`, `Codex Native3`,
`Codex Native3 DEV`, `Codex Native4`, and `Codex Native4 DEV` connectors are treated as legacy
and are never selected as a fallback. Zero Risk uses `Codex Zero Risk4`, with `Codex Zero Risk`,
`Codex Zero Risk2`, and `Codex Zero Risk3` retired. This
prevents a cached legacy schema from being mistaken for the current capability contract.
Create a new plugin instead of renaming or refreshing an old one. Setup preserves custom names
that are not retired defaults, but a custom plugin's name alone cannot prove its schema is current.
Local health, installed tool schemas, and the setup-flow marker do not authenticate cloud cache
contents. Verify runtime requires six successful supported-transport context returns against a
fixed small text source, with ordinary and independent compaction credentials. It does not trust
model claims. Its private scope rejects business execution and compaction submission; manual
verification retains the original user choice, Send, start, and Sent policy. The stored owner-only
evidence contains no read credentials and is bound to profile/home, mode, exact plugin, tunnel,
runtime command, and installed schema digest. Binding changes invalidate it; it has no time-based
expiry. The record is for diagnostic comparison only. Normal tasks, navigation, compaction,
and recovery do not read it as permission or start diagnosis automatically. Current credentials,
protocols, sources, budgets, and delivery and commit checks still apply. Setup completion depends
on the required configuration steps, independent of diagnostic success or failure. A diagnosis
proves callability at that time, not raw cloud schema contents or continued model reliability.

### Context source capabilities

`codex_context_list`, `codex_context_read`, and `codex_context_search` read an immutable snapshot of
actual legal task sources. They do not execute Native tools, acknowledge task updates, or upgrade
tool content into instructions. `_rawBody` is used only for verified visible source fields; it is
not a navigable dump of authentication or hidden runtime state. Arbitrary file paths, URLs, digests,
and unavailable file IDs grant no read authority. Source roles and completeness stay explicit;
ambiguous tool-call relationships do not become evidence of success.

Reads use `reads: [{read_ref, cursor?}]`, including single text/image reads. A batch validates
all items before exposing a prefix; duplicate targets and mixed image/text batches are rejected.
A single image keeps its independent fixed-byte receipt and confirmation. Batch metadata grants
no authority beyond the fixed source.

Ordinary reads require the current mode credential, selected plan, context ID, delivered entry,
and original start/Sent conditions. Snapshot IDs, references, and cursors are not credentials and
cannot cross modes, unauthorized owners, physical executions, or retired scopes. Required-text
and required-image readiness are separate from ACK and completion fences. A successful MCP image return records delivery to the
supported transport, not model understanding. Zero Risk fallback confirmation is a scoped user
statement, not programmatic attachment inspection. ChatGPT-owned tools have no server-side context
readiness interception; their ordering remains a prompt requirement.

Ordinary `context-bootstrap-v1` binds required text to the selected immutable plan and scope.
Only matching pending batch-v1 successful transport receipts atomically add all returned UTF-8
ranges, including an actual empty-body receipt for an empty source. Missing or corrupt metadata,
body blocks or source ranges invalidate coverage for the entire batch. Generation costs remain
charged even when transport fails; partial coverage cannot proportionally release a canonical
batch reservation. Complete coverage is a delivery condition, not proof that the
model followed the rules. New business calls, inventory and successful completion enforce the
condition at the atomic execution boundary with the original authority and revision checks.
Wait/replay, ACK and existing controls retain their separate permissions. Text cannot extend image
deadlines, grant a capability, forge ACK, redefine the required set or enlarge a budget.
Source role metadata preserves the original Codex task; a tool response does not become a real
ChatGPT system/developer message. Host sandbox and approval decisions remain authoritative.

Current capability checks are required for short startup. Optional Verify runtime evidence cannot
grant admission or prove remote cached-schema adoption. A pre-send fallback must be an existing
complete candidate within every limit that does not
depend on the incompatible context interface. Old top-level read arguments and v2 text results
are rejected. Refresh or reconnect the current connector; do not change a sent plan or Send again.
An incompatible response after Send cannot authorize automatic
resend or a weaker gate. Logs retain bounded delivery metadata, not source text or credentials.

Compaction's `compaction_token` is an independent read-only capability for the same three tools.
It cannot start business work, list business tools, ACK, complete a turn, or submit a checkpoint.
The original submission capability cannot substitute for it, and ordinary credentials cannot read
its snapshot. Historical task instructions are summary evidence. The model chooses what to read;
submission checks actual control delivery, source availability, failures, in-flight reads, and the
original transaction protections rather than a claimed reading percentage.

Snapshots are bounded active-task data. Completion, cancellation, expiry, and retirement revoke
new access, and in-flight returns recheck revocation. Process restart invalidates old read
credentials and references. Recovery needs actual verified source bytes and existing writer/Send
admission; a digest or old page URL cannot restore content or authorize a second Send. Journals
store bounded source-coverage metadata, not raw text, images, or read credentials. If access evidence
is recorded, it contains references, ranges, sizes, routes, timing, and necessary identity summaries,
not source bodies. See [context navigation](context-navigation.md) for the effective resource limits.

`context-reuse-v1` authorizes reuse only through a committed same-page baseline and verified
current source units. Exact content, source identity, role, structure and applicability are part
of the unit fingerprint. Text that claims to be stable, read or privileged is not evidence.
References cannot inherit credentials, operation IDs, ACKs, permissions or text coverage.
The Broker checks the baseline separately from this scope's delivery at business and success
boundaries. A sent plan is immutable after baseline invalidation. Baseline commit requires
normal completion, physical termination and a fresh page/head check; delayed old execution
cannot write a successor's baseline. Baselines contain bounded metadata and are not restored
as reuse authority after restart.

### Durable input custody and preparation termination

Task inbox originals are sensitive local data. Owner-only payload files hold exact user text;
the metadata journal contains IDs, digests, sizes, ordering and delivery/coverage bindings rather
than text, URLs or credentials. Bodies, metadata and mutation reservations share the existing
24 MiB recovery budget. Each task is limited to 128 pending messages and 1 MiB. Capacity refusal
must not evict an accepted original. Missing or unsafe payloads block delivery and copying; repair
must supply the same ID and exact digest. Pending/stopped input has no silent expiry and survives
page cleanup, but grants no tool, browser, owner or recovery execution permission.

Launcher input controls require the trusted main renderer frame and live local Launcher token.
Text crosses a bounded stdin pipe and a dedicated IPC path, not command arguments or general
logs. Mutations recheck task version and intent under the durable lock. Stop/deletion fence older
intents before subsequent dispatch. A user-selected retry creates a new linked intent rather than
reviving an old automatic retry. An input with delivery permission cannot be withdrawn as unsent.
Terminal reclamation and task deletion persist a source fence before deleting bodies. Detailed
records can then be removed without allowing an old request to create new work after page cleanup.
The compact fence remains charged to the shared budget; it has no unverified expiry or eviction.

Preparation termination and actual Send permission use one durable lock and exact attempt/owner/
epoch/page/lease identity. Neither an abort nor absence of a successful receipt proves unsent.
A preparation termination receipt does not authorize a new Send or weaken page-loss recovery.
Only the current owner can preserve the last committed source on a verified healthy page; late
callbacks cannot restore a stopped attempt or overwrite a successor.

### Trusted user updates and owner writes

`task-updates-v1` accepts only a proven ordered suffix of native plain user messages in the same
thread and turn. It compares the complete accepted prefix, source IDs, payloads, higher-priority
instructions, execution options, and trusted capability identity, together with the complete raw
result batch. Repository text, tool output, environment context, skills, subagent material, and
browser content cannot create user updates. Updates remain below system/developer instructions
and do not change sandbox or approval authority.

Only authenticated Broker owner IPC can reserve and accept the update transfer. Native starts
declare their acknowledged task revision; generation-bound owner writes and waiter delivery
reject stale or missing ownership at the mutation point. An active update can replace the driver while retaining the same physical capability. Pure HTTP
observer replacement uses a separate association and does not advance that driver. Old observers
cannot claim new tools; already issued calls retain their original completion rights and final
output keeps its captured version. Trusted user stop
and launcher cancellation keep their physical revocation authority.

An ACK authenticates through the original turn capability. Its delivery ID prevents unknown or
out-of-range confirmation; it is not an additional credential or proof against prompt injection.
Broker-generated control is kept separate from lossless Native results. Immutable output receipts
prevent late ACKs or a later task head from changing a final-answer candidate. Bounds and failure
behavior are defined in the [Native tool protocol](native-tool-protocol.md#user-updates-during-tool-work).

### Credential domains and long-running operations

The local API access key, upstream provider key, daemon control token, Tunnel credentials, and
turn capability are separate authorities. Local client authentication is checked before upstream
routing; the upstream transport constructs its own Bearer header rather than forwarding client
credentials. Explicit Codex TOML exports contain the local access key, never the upstream key or
daemon control token. Treat these exports and authenticated proxy environment values as secrets.
See [API Key mode](api-key-mode.md) and the
[upstream credential boundary](upstream-provider.md#network-and-credential-boundaries).

Upstream runtime metadata is untrusted. It cannot replace project Agent-control fields, including
the entire `model_messages` object, or take over either local Web model namespace. Bundled
metadata and the field schema are fixed-revision build inputs, not runtime provider assertions.
Custom metadata also obeys these project boundaries.

The accepted private plaintext proxy-URL storage model is not an exception to the OS-encrypted or
session-only API key vault policy. Exact proxy challenge matching and fail-closed authentication
cache cleanup protect credentials across proxy changes; see [network proxy](network-proxy.md).

A Native `operation_id` only identifies work within an already-authorized capability. It is not a
credential and does not expand the advertised registry. Retry and wait attach to the same accepted
operation; deterministic admission rejection also occupies its ID. Pending is bridge control, not
execution evidence. Unread public results block final completion, and owner restart does not
authorize reexecution. The [Native tool protocol](native-tool-protocol.md) defines this lifecycle,
including the narrow consumer-lease exception to remote idle termination.

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

A web page is not a local process. Browsers can reach a loopback port with a cross-site request,
or with a same-origin one after DNS rebinding, and they attach `Origin` to every non-GET request.
The daemon rejects any non-GET request that carries `Origin` before it reaches a route; Codex and
the launcher never send that header. This closes the browser path only and is not authentication.

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
authentication evidence: the launcher also requires a valid server session and an ordinary new-chat
URL before setup can continue. No cookies, local storage, or browser profile are copied from an
external browser.

### Cross-turn data leakage

The following recovery behavior applies to supported Full Native + Launcher `chatgpt-web/`
routes and equivalent ordinary aliases. Browser-only, non-Launcher Managed Chrome, Luna, Think,
and upstream API forwarding retain their existing contracts.

Browser turns use at most five independent task-bound pages in one private login partition.
Every task has its own exact Launcher surface lease; chats are not shared across tasks. Closing
a page terminates that page's execution, but a later request may recover in a new page. Tool
round trips remain in the same response. The independent `previous_response_id` input/output
cache retains its one-hour memory and disk lifetime and capacity limits. It can outlive page task
cleanup; it grants no page ownership or tool authority. A missing or expired entry still produces
the existing 409 API-context error and requires full canonical input.

Choose the page branch before historical admission checks. A current authenticated Launcher must
confirm the actual page and its execution generation before the bridge treats it as alive. A disk
record, expired lease, or old receipt alone is insufficient. A confirmed live page retains current
instruction/payload, owner, history, real-result, task-update, and compaction conflict checks.
Matching retries can attach or replay. Delegated retained-source proof still uses request-carried
source thread/turn, item ID, content, model, and reasoning identity. A conflict does not authorize
adopting a guessed live source or replacing that page's valid writer.

Closed or unknown pages use current-request recovery. Revoke project-controlled old permissions,
make a best effort to cancel or close known helper, Broker, Launcher, and tool work, then create
one new generation. Do not require old Send proof, tool settlement, stopped/completed receipts,
checkpoint history, or a remaining old retry budget. A missing or corrupt old journal does not
make the new request ineligible. This applies to HTTP cancellation caches and Adapter preflight,
not only the internal recovery function. Current authentication, thread isolation, tool permission,
readable-source, real input/output, account, and actual physical-capacity limits still apply.

The current expanded request supplies effective instructions, summaries, history, attachments,
and real results. Historical calls are context only; they cannot authorize redispatch. A new
model call needs current authority. Cold compaction can regenerate a summary from these sources,
without claiming an exact replay of an old commit. Within a current page, one compaction
transaction still commits once. Full/MCP navigation retains its independent read-only credential,
actual source and delivery limits, and current protocol checks. Historical runtime diagnosis is
optional and does not grant execution authority. Ordinary assistant prose is not a
structured retained-path handoff. Zero Risk keeps manual Send, Sent, and attachment confirmation
and its ended-response manual checkpoint boundary.

Recovery can execute work that previously ran or was stopped. An unreachable old execution or
already-issued external command may continue producing effects. Permission revocation cannot
undo those effects, prove process termination, or promise exactly-once business behavior. A
running-process handle remains context about a possibly running process. Recovery notice and
bounded logs must state these limits without exposing prompt bodies, tool results, or credentials.
No additional confirmation dialog is required for recovery.

Generation revocation and activation share an atomic order at project-managed entry points.
Every dispatch, helper Send/acquisition, result, task update/ACK, final answer, and checkpoint
commit checks current authority. Serialize same-thread selection and mutation, then recheck the
generation after asynchronous inspection. Matching concurrent requests share one creation and
execution. Old results cannot join a new page; old callbacks cannot recreate cleaned records or
remove a newer owner. An already-admitted old completion channel can finish only its original
transmission and grants no new-generation writes.

Page destruction removes that generation's registration, work/call, stop/completion, checkpoint,
history/retry, binding, execution index, and task snapshots. Match the exact generation at cleanup,
including late destruction events; cleanup is idempotent. Independently owned pending/stopped
task inbox originals remain outside that page cleanup and grant no execution rights. Keep independently referenced in-flight
content only until its transmission ends. Do not retain replacement stop tombstones or history
archives. The independent API cache and login/installation state are explicit exceptions.

Current-page journals retain their existing bounds: 10,000 threads / 4 MiB registration data,
24 MiB shared recovery/checkpoint evidence, 2 MiB per item, 256 checkpoints/tombstones, and 512
execution rounds. Reserve needed current-page receipts before side effects. Metadata journals
store no prompts, result bodies, chat URLs, or capability tokens. Storage, permission, or lock
failures are explicit infrastructure errors, not permanent stopped work.

The 24-hour ready-page clock uses successful ordinary work or committed compaction; queries and
replay do not extend it. Active or uncertain pages are not idle eviction candidates. A closing
or failed-cleanup physical document still counts toward five slots until actual destruction.
Each fixed-target cleanup has at most three automatic attempts. Logical revocation does not
release capacity. Incomplete physical cleanup keeps only the minimum document identity and
close-retry information, without task bodies or work history.

Migration preserves installation/login state, the independent API cache, and necessary activity
state of confirmed live pages. Remove closed-page records; revoke unknown generations and use
current-request recovery. Legacy, missing, or corrupt records must not become a permanent deny
list or a long-term quarantine archive. Retry interrupted migration under mutual exclusion without
two current writers. Update running backend, helper, Broker, and Launcher together; files on disk
alone do not establish runtime compatibility. Make a best effort to retire unreachable old
components without requiring proof that all exited. An actually unavailable creation interface
remains a service error.

An HTTP observer disconnect or interrupt alone does not establish page closure and does not start
background recovery. New work still uses current permission and approval checks. The separate
[release validation matrix](release-validation.md#session-continuity-validation) distinguishes local
regressions from real Launcher, connector, and cross-process evidence; it is not proof those
checks have passed.

**Temporary Chat** is enabled by default and keeps new task conversations out of ChatGPT history; it does not prevent OpenAI from processing them
or change local Codex history and diagnostics. ChatGPT memory, plugins and custom instructions may
still apply. Existing ChatGPT conversations are not deleted. Connector verification follows the
selected mode; sign-in and account inspection use ordinary chats. The retired saved-chat preference
is discarded when loading older configuration; an explicit choice to disable Temporary Chat is preserved.

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
