# Native tool operation protocol

This contract covers Native-capable Automatic Full and Zero Risk calls. Codex remains the executor
and enforces its sandbox, approvals, command sessions, and actual tool results. Browser-only mode
and ChatGPT-owned tools are outside this protocol. The authority modes are described in the
[security model](security-model.md#full-mode-capability-flow).

## Identity before execution

The caller allocates a positive JSON safe integer `operation_id` before sending each new logical
Native call. The identity is `(Broker capability epoch, operation_id)`, not the tool arguments.
Automatic uses the capability identified by its `turn_token`; Zero Risk uses its `request_id`.
The integer is not a credential.

Start the counter at 1 for a new capability. Keep it across MCP, Tunnel, and Responses reconnects
within that capability. Concurrent calls need distinct IDs. Gaps and out-of-order network arrival
are allowed. A new call needs a new ID even when its arguments equal an earlier call's arguments.
There is no extra `codex_tool_begin` request.

The Native-capable entries are `codex_exec`, `codex_write_stdin`, `codex_apply_patch`,
`codex_view_image`, ordinary `codex_tool_call`, and `codex_tool_inventory` when it can use a Native
gateway. `operation_id` is bridge control and is removed before constructing Native arguments.
The control-only `codex.control.compaction_handoff` branch does not create a Native operation and
does not require this ID; its isolated control capability does not grant ordinary tool authority.
The read-only `codex_context_list`, `codex_context_read`, and `codex_context_search` entries also
require no operation ID. They read fixed sources without business dispatch or task-update ACK.

On first arrival, the Broker atomically binds the ID to a normalized start description: bridge
entry, requested logical target, freeform intent, and execution parameters. Authentication and
bridge control fields are not execution parameters. Admission then uses the latest advertised
tool registry. A successful admission fixes the Native target, one call ID, and the public-result
finalizer. The description is bound even when admission is deterministically rejected.

| Request | Result |
| --- | --- |
| Same capability, ID, and start description | Attach to the existing operation or replay its cached public result or rejection. Do not dispatch again. |
| Same capability and ID, different description | Return `codex_tool_operation_conflict`; preserve the original operation. |
| Corrected request after a deterministic rejection | Use a new ID. The old ID continues to replay its rejection even if the registry later changes. |
| Same parameters, different ID | Treat as a separate requested operation, subject to current admission and capacity. |
| Missing, expired, revoked, or wrong capability | Reject; knowing the numeric ID does not authorize access. |

A registry generation is a tool-directory version, not a new capability epoch. A claim does not
freeze admission: a new invoke checks the current registry before creating its call ID. Once
admitted, removal of that tool from a later registry does not by itself prevent the original result
from completing. A same-ID retry is not a second admission. The Adapter's independent batch check
against the current outer request remains in place.

## Context sources and readiness

The three context tools use the current `context_id` and exactly one credential: `turn_token` in
Automatic, `request_id` in Zero Risk, or the independent `compaction_token` for compaction reads.
The public schema exposes mutually exclusive ordinary and compaction branches. Credentials and
references cannot cross these scopes. List discovers bounded entries, search returns literal text
matches, and read accepts `reads: [{read_ref, cursor?}]` for 1–8 distinct text targets under one shared
response budget, or a single image without a cursor. Directory labels and snippets
are not the full result. Reading an old result never repeats its action.

Ordinary `context_ready` records delivery of required images through MCP return receipts, verified
Automatic uploads, or Zero Risk's separate confirmation of its selected fallback-image manifest.
Sent, start, and task-update ACK do not supply image-delivery evidence. Legacy and on-demand text
have no mandatory coverage. In ordinary `context-bootstrap-v1` plans, required text also needs
complete UTF-8 range coverage from matching pending batch-v1 successful transport receipts. Empty sources
need an actual empty-body receipt. Text and image readiness are independent, and text reads do not
extend image deadlines. Until ready, new business execution and successful completion are blocked with
`CONTEXT_NOT_READY`; existing operations can still wait, replay, and settle. Business inventory
and direct successful completion use the same atomic gate. Original ACK and control permissions
remain independent. A rejected new start
keeps its deterministic terminal, so corrected new work uses a new `operation_id`.

Compaction uses a separate legal-source snapshot. Its read credential grants only the three context
tools, while the original handoff or completion credential submits the checkpoint. The model can
choose a subset of sources or submit without reading. There is no all-source or image-coverage gate.
Actual control delivery, available sources, no permanent read failure, settled in-flight reads, and
the original owner, revision, ACK, Send, and real-result checks still gate submission. Business tools
remain disabled. The [context navigation contract](context-navigation.md) defines input filters,
pagination, image fallback, effective budgets, and lifecycle limits.
The finite corrective-reply reserve is three replies at 128 tokens and 512 wire bytes each.
After the third corrective reply, or when no budgeted reply can be returned, source-query
permission stops and further queries receive JSON-RPC rejection;
it does not close the shared MCP transport or revoke ordinary business or checkpoint-submission
authority. Those operations retain their original readiness and transaction checks.

Ordinary short-start Automatic tasks first call `codex_context_list(view: "overview")` with the
current `turn_token` and `context_id`. Zero Risk first calls `codex_turn_start(request_id)`;
`started`/`duplicate` also returns `context_bootstrap`. Repeated start preserves manifest identity
and coverage. A configured Sent wait returns `read_state: "waiting"` without consuming reads.
The user still chooses the connector and manually sends. Manifest 3 declares
`text_read_format: "context-text-batch-v1"` and `required_discovery: "batch-metadata"`. Follow
`next_required_read` then `required_step.next_required_read` unchanged; normal pure-text startup
needs no required `entries` traversal. Read a final overview for settled readiness. Images use
single-item arrays, their original result and confirmation, then overview recovery. Optional lists
use 50 targets / 48 KiB / 6,000 estimated tokens under the expanded profile.
The startup entry carries minimum batch read rules and the required execution protocol supplies the
complete applicable wait, update, error and completion rules. Neither metadata roles nor source
body text can change permissions or control state. See
[short startup](context-navigation.md#short-startup-and-required-text) for the complete contract.

Ordinary `context-reuse-v1` plans add `reuse_ready` to the context gate. A v2 full plan has no
reuse dependency; an incremental plan must retain its server-validated page baseline. Required
text coverage is still local to this scope. Inline data needs real prompt submission, and external
text still needs complete v2 receipts. Reused units are optional exact rereads with current
references; reading them again consumes budget. Startup remains overview in Automatic and
`codex_turn_start` in Zero Risk. An invalid baseline blocks new business calls, inventory and
successful completion with bounded recovery information. Existing operation settlement,
wait/replay, ACK, cancellation and error termination retain their own rules.

## Command polling limits

A Native command poll through `codex_write_stdin`, generic tool dispatch, or a nested `exec`
gateway accepts `yield_time_ms` up to 60,000 ms. A larger value is rejected before dispatch;
the bridge does not silently shorten it. Each MCP invocation has its own 90-second deadline.
Commands can keep running between polls: use the same Native `session_id` in a later operation
with a new `operation_id` to collect more output. Repeating a pending bridge query uses the
original operation ID and does not start another command poll.

This command-argument limit is separate from the 30-second bridge result-query window below.
A pending result, its renewable lease, or an accepted old schema does not extend the command
poll limit. Old connectors that still advertise five-minute polls need their tool schema refreshed.

## Waiting and public results

The first call and each `codex_tool_wait` have a 30,000 ms semantic waiting window. A still-running
operation returns bridge control, not a Native result:

```json
{"kind":"codex_native_pending","operation_id":1,"next_tool":"codex_tool_wait"}
```

Keep querying the same capability and ID until the public result arrives. After a lost start or
result receipt, retry the identical original call with the original ID, or wait on that ID. Do not
reissue the work under a new ID to recover a result. Pending is not an answer, approval, success,
failure, or permission to finish the turn. A Native result that happens to contain similarly named
fields is still a Native result, not bridge control.

The wait path reads the Broker directly. It does not schedule another Native tool, query a gateway,
or depend on the outer Codex producing another model request while the original tool is blocked.
The Broker holds the operation, result slot, and bounded finalizer context independently of the
original MCP handler or socket.

The cached result is the public result the original entry would have returned, including content,
structured content, metadata, and error semantics. Inventory results still undergo parsing,
validation, direct/nested merging, and pagination. A nonempty filtered query with no matches may
return separate `discovery_tools`; those entries do not affect `total` or pagination, and their
schemas follow `include_schema`. A wait result must not expose an unfinished raw gateway result.

Cancelling or disconnecting one wait query only removes that waiter. Explicit task cancellation,
Native deadlines, owner loss, and lease expiry retain their separate termination semantics.
An empty user answer or a real Native rejection is returned unchanged, not replaced by a guessed
answer or an automatic approval.

## Consumer lease and timeout boundaries

Each unfinished operation has a 120,000 ms consumer lease. Valid start retries or wait queries renew
it; observation, browser/helper heartbeats, and TCP activity do not. While the real task, owner,
operation, and consumer lease remain valid, the bridge imposes no total human-input or Native
execution deadline. The 90,000 ms MCP-to-Broker transport failure budget is a separate boundary,
not a Native execution timeout.

Verified waiting evidence can suppress a false browser DOM-silence failure. It cannot preserve a
closed page, replace a lost owner, disable helper liveness checks, or extend an explicit task
deadline. Resume from suspension gives a bounded 5-second opportunity to obtain fresh proof; it
does not renew authority without that proof.

Remote deployment has an independent default 600-second no-progress timer. A valid unfinished
Native operation lease pauses that timer's **termination action**, not its accumulated idle time.
Wait and retry never update `lastProgressAt`. When no eligible waiting operation remains, the
timer immediately compares the original progress time and can terminate an already-expired turn.
See [server deployment](../deploy/server/README.md#external-codex-client).

This separation preserves long human waits with a live consumer while still reclaiming orphaned
turns. Polling has tool-call, context, and response-latency costs; increasing a transport timeout or
renaming polling as business progress would not preserve the same failure boundaries.

## User updates during tool work

New compatible Full Native Automatic and started Zero Risk runtimes negotiate `task-updates-v1`.
A new ordinary turn on a retained page negotiates the protocol with fresh tool authority and
revision 0. Compaction does not negotiate it. All eligible routes use the same local work/source
records for active text-only appends. The same trusted thread, turn, scope, owner and page lease,
must be identifiable. A live tool boundary is required for active model delivery, not for durable
receipt. Initial Zero Risk inputs awaiting Sent can be saved; they do not modify a confirmed prompt
snapshot or authorize automatic Send.

Completed history may be trimmed or reserialized; edited old text is not sent back to a healthy
page. Stable new user item IDs preserve order and prevent duplicate acceptance. Equal text under
different IDs remains distinct input; changing an already accepted item's text is a conflict.
An append can contain zero or some pending results. Pending call IDs retain their expected type
and first-real-result checks. Later result-only requests fill remaining calls without another
update. Historical echoes, unknown IDs and repeated results cannot complete a new call or grant
execution authority. HTTP retry recovers the same accepted update outcome.

The Broker tracks accepted, delivered, and acknowledged revisions independently, beginning at 0.
Each appended user item has a stable source ID; equal text in different items remains distinct.
An owner-only transfer binds its ID to immutable local commit data. It includes immutable accepted updates and the registry/source relationship. Retries recover
that local data without requiring the client to repeat completed history or the original batch.
Reservation precedes the short Session preparation barrier; atomic acceptance installs the new
revision and driver generation before waking real result promises.
Append reservation checks the live tool or confirmation boundary before binding its ID. The
reservation retains that admission for the same immutable transfer if an ACK closes the window
before commit; driver, revision, final output, compaction and result-batch checks still apply.
Remote append reservation checks Broker compatibility before sending the reservation request.
Draining rejects new external owners; existing tokens can still update and recover transfer receipts.
Outcomes are immutable: `committed`, `not_committed`, or `unknown`. Recover an unknown outcome by querying or retrying the
same transfer. A timeout or absent lookup is not evidence that it failed to commit.

Native query replies retain their original `pending` or `result` plus a separate `taskUpdate`
delivery. With a delivery, MCP presents a visible fixed control block and a structured envelope:
`native_result` preserves the complete original public result; `task_update` comes only from the
Broker. Text, images, resources, `structuredContent`, `_meta`, and error semantics are preserved.
No update is stored in the Native result cache or sent through the browser composer.

Apply delivered updates in order, then call `codex_task_update_ack` with the same capability,
`delivery_id`, and `through_revision`. One immutable delivery is outstanding at a time; retries
return it unchanged. A further append during the ACK gap stays queued and can be delivered in
that ACK response. Without a boundary, accepted input stays in the durable queue until a controlled
entry or the next ordinary browser response. ACK is confirmation, not Native execution or extra
business progress.

Every Native start on a negotiated capability declares a nonnegative safe integer `task_revision`,
initially 0. That revision joins the bound start fingerprint and is removed from Native arguments.
An identical ID retry replays its original outcome before current-version admission. A new ID
requires `task_revision === acceptedRevision === acknowledgedRevision` and no final output lock;
otherwise it caches `task_update_not_executed` with zero Native dispatches. Previously handed-off
calls keep their real results. Old queued calls are intercepted rather than executed after ACK.
`codex_tool_wait` uses the original ID and does not declare a new task revision.

All owner writes and waiter delivery capture `expectedDriverGeneration` and check it at the actual
Broker mutation, including Remote IPC. Session generation checks also run after asynchronous
owner calls. Observer attachment has a separate protected association: changing the HTTP/tool
delivery connection does not advance the driver generation or invalidate physical completion.
Only the current association can claim new calls; an already dispatched call keeps its completion
right. Normal waiting uses commentary/heartbeat, with no `incomplete(task_update_handoff)` terminal.
An already completed source round keeps its terminal journal. Late observer cancellation cannot
revoke the current physical owner. Trusted user stop remains a separate physical cancellation operation.

The first nonempty final-answer delta locks its captured acknowledged version. Commentary and
reasoning do not lock it. A strict buffered answer or worker-first completion may lock inside
the completion CAS before text is sent; sending then reuses that immutable receipt. Candidates
are never upgraded to a later head. Automatic unacknowledged final output fails explicitly;
Zero Risk completion requires the acknowledged revision after an update and can return the
pending delivery on refusal. Its initial revision 0 remains the compatible default. After the
lock, late ACKs cannot change the answer. New input is still saved, but belongs to a later ordinary
response; it cannot change the locked output or be marked as covered by it. A response that did not negotiate the update
protocol cannot be upgraded by an append. Compaction refuses unresolved updates or prepared
transfers and requires the latest exact source. Compaction reuses locally accepted
results, without requiring their old bodies again. Appends advance task revision and driver
generation, while only committed compaction advances history revision.

An exact Automatic reconnect can finish its own incomplete round after the browser has completed
and the capability has retired. This is a read-only recovery: the accepted request, current task
revision, driver generation, output-owning round, and completed receipt must agree, with no cancellation,
supersession, prepared transfer, or outstanding tools. Strict buffered candidates retain their original admission
evidence on the round and remain subject to JSON/schema validation. Recovery journals the answer
and terminal events before sending them; subsequent retries replay that journal. It does not renew
tool authority, update the registry, or create another browser submission.
Another accepted round with the same task version cannot inherit these events. A delayed output-start
reply cannot replace a completed receipt that was committed while that reply was in flight.
Once final text is consumed or an output receipt exists, another round cannot rebind that answer,
including before the browser outcome settles. While strict text is only buffered and no output
receipt exists, the owning round can still finish a real Native tool batch. Its ordinary result
round may continue the same execution only with the complete raw results and the owning source
round's recorded tool boundary; it inherits the buffered candidates' original admission evidence.
An old result boundary cannot transfer ownership again. Rejecting a non-owning round can journal its own
error, but cannot cancel or retire the owning execution. A newly committed task update may still
bind its new revision/generation while strict text is buffered and no final-output lock exists.

## Durable task input queue

Supported continuity routes retain plain user messages under trusted task/thread/scope identities.
Stable native message IDs and content digests provide idempotent receipt. A different ID with the
same text is a second message; reusing an ID with changed text is a conflict. Complete text is stored
in owner-only payload files, outside the recovery metadata journal. A receipt is successful only
when that text and its identity are durable. Unknown commit outcomes require the same ID to be
queried or retried; missing text blocks delivery and must be restored from the identical original.

Receive sequence S is task-wide. Receipt alone changes neither model revision M, recovery work
revision R, driver generation G, nor history revision H. An active finite prefix maps its exact S
set to M+1 through M+k, advances G once, and admits one new recovery work revision. An ordinary
next physical response starts M/G at zero and records its prefix as initial prompt input. Exact
journal recovery keeps the journal's versions. ACK and completion cover exact message sets and
physical/work bindings, including holes left by discarded messages.

The queue checks existing Native admission, real-result return and ACK entries. One immutable
unacknowledged delivery is allowed per capability. Already started tools retain their original
IDs/results and are not redispatched. Unsent old decisions require a new model decision after the
update. If no active entry is available, the current physical response settles and an authorized
current observer can start the next ordinary response. Each physical assistant output remains a
separate Responses item; JSON and SSE expose the same ordered content. Disconnect alone does
not start new browser sends or business work. Zero Risk retains manual Send/Sent/attachment gates.

Pending inputs are bounded by 128 messages and 1 MiB per task. Capability cumulative update limits
still apply separately. Payload bytes, metadata and safe mutation reserves share the existing
24 MiB recovery budget. Pending/stopped originals survive page cleanup and restart without a silent
TTL. Activity provides view/copy, original-body repair, explicit stopped-input retry, discard before
delivery permission, and cleanup. Input custody never grants tool or page ownership.
Once a later native turn completes, a 30-minute historical Session replay window starts. After
that window ends and all earlier work and exact input coverage have settled, maintenance releases the earlier inbox's
bodies and detailed message/delivery references. A prepared or failed successor cannot start
this retirement window.
Explicit task deletion also commits a source fence before removing bodies. The compact fence
continues to count toward the shared budget and prevents delayed old-source work from restarting;
physical completion within the same native turn does not retire its inbox.

## Compaction, retirement, and completion

The retained-compaction boundary is the Broker handoff, not the later emission of the Native batch.

| Operation state at handoff | Required outcome |
| --- | --- |
| Still queued in the Broker | Compaction may take it over. Cache the existing compaction-control terminal result, do not execute Native, and bypass the ordinary Native/inventory finalizer. Retry and wait replay that control result. |
| Moved to the delivered batch | Keep waiting for the actual Native result, even if the Adapter has not yet emitted the batch. Do not reinterpret it as an unexecuted queued call. |
| Public result ready but not delivered | Keep it attached to the original operation and block final completion until delivery or explicit retirement. |

Queued, waiting, and unread result-ready operations block both Automatic completion fences and
Zero Risk completion. Delivered cached results may still replay without blocking completion
forever. A queued compaction-control terminal stops blocking after its public delivery.

Non-applicable recoverable paths retain their configured fresh-compaction and delegated-source
fallback retirement rules. Applicable Full Native + Launcher routes first determine the page
lifecycle. A confirmed live page keeps its current operation, result, owner, and compaction checks.
A closed or unknown page uses the current authenticated request after revoking old project
permissions and making a best effort to cancel old work. Old Send, settlement, stop/completion,
checkpoint, and retry facts do not gate that new execution. Physical cleanup and actual page
capacity remain separate. See [session continuity](session-continuity.md).

There is no operation-object or capability recovery across Broker or owner-process restart.
The current-page journal records issued calls and possible delivery before external dispatch,
and accepts real results before exposing receipts. Revocation alone does not stop a delivered
outer command. An already-admitted result channel can finish its original transmission, but
cannot write a newer execution, ACK its updates, or submit its answers.

The current request may carry historical real results and running-process handles as context.
It does not need an old durable source chain, and old call text grants no redispatch authority.
Do not rerun a historical call to resolve an unknown result. Valid new model suggestions are new
operations under current permissions. They can repeat prior business effects: the bridge does
not promise exactly-once execution across page loss. On a confirmed live page, existing call-ID,
expected-type, first-result, and current-writer conflict checks still apply.

## Capacity and compatibility

The implementation bounds resources per capability:

| Resource | Limit |
| --- | --- |
| Operation identities | 1,024 |
| Active queries / waiters | 64 |
| Start description and finalizer context | 8 MiB per operation; 64 MiB total |
| Public results | 16 MiB each; 64 MiB total, including a 1 MiB reserve for fixed unavailable terminals |
| Accepted user updates / total text | 128 / 1 MiB per capability |
| Transfer outcomes / immutable deliveries | 128 / 128 per capability |
| One task-update result batch | 32 MiB |
| Session logical routes / retained transfer conclusions | 128 / 128 |
| Session source proof plus round event journal | 32 MiB, including bounded error and transfer-terminal reserves |

Capacity failures do not evict accepted operations or rerun Native work. Distinct errors identify
unknown/conflicting IDs, rejected admission, unavailable results, resource limits, lease expiry,
Native deadlines, cancellation, retirement, infrastructure failure, and required upgrades.
Session event admission preserves a bounded error terminal for each admitted round; journal
exhaustion closes current physical authority and leaves the capacity error available for exact replay.
An ordinary result round proved against the current owning tool boundary takes responsibility
for cleanup before saving inherited candidates. If that storage exhausts the journal, cancellation
and capability revocation still occur; a rejected non-owning or older-generation round cannot
gain cleanup authority from a capacity error.

The implemented Broker protocol is 14. Native waiting and task update protocols are 1; the context
protocol is 4 and requires `context-text-batch-v1` for all successful text reads.
Each text response has one metadata block and one independent body per `items` entry;
`structuredContent` repeats metadata only. Every item/block is validated before one atomic
transport receipt can cover the batch. Old top-level read parameters and v2 text results are rejected.
The helper advertises `native-tool-wait-v1`, `task-updates-v1`, and `task-output-ack-v3`.
For each negotiated turn the Broker publishes empty, immutable ACK files in a private temporary
directory before returning an ACK. The same directory carries an atomically published revision /
driver-generation pair; transfers publish that pair before any irreversible commit effects or
result replies. Owner and helper workers synchronously bind each DOM read to this same-host
version before awaiting it, then sample ACK at the first returned final-text projection. A delayed
whole progress frame cannot bind a new answer to an old owner; a head change during the read cannot
upgrade that read. The asynchronous progress mirror remains responsible for tool activity and
liveness, rather than negative ACK or version evidence. Candidates retain that result; late ACKs cannot upgrade it during helper
transport or a delayed Broker check. Publications contain only version counters, never user text, do not lock output, and
are released when a page-bound capability retires, after its admitted owner/helper work settles.
Already admitted transports retain their own immutable replies, without retaining the page's
transfer journal or ACK directory. Routes without page recovery retain the existing bounded
retired-turn cache until eviction or Broker shutdown.
Directory cleanup errors are reported without retaining execution rights; only failed cleanup
paths survive for a shutdown retry. Shutdown reports any directories it still cannot remove.
Missing or invalid sources fail the turn. Helpers
without `task-output-ack-v3` do not negotiate hot updates for a new execution.
Check for `codex_tool_wait`, `operation_id`, `task_revision`, `codex_task_update_ack`, and all three
context tools with their mutually exclusive credential schemas on the selected connector before
using navigation or dispatching work. The private owner must advertise `contextProtocol: 5`
and `context-bootstrap-v1` for short-start plans.
An installed local `tools/list` proves local runtime support, not ChatGPT's cached remote schema.
Optional Verify runtime requires six successful context transport returns over fixed small text,
one list/search/read sequence per ordinary and independent compaction credential. Each read
requests at least two distinct text targets and validates every batch-v1 item/body, matching
metadata, exact UTF-8 range and actual successful transport batch receipt. Body blocks are
selected only through `items[].body_content_index`; metadata does not repeat their text. Empty
sources still have actual empty blocks. Historical single-read evidence is inapplicable. The verification
pair has no business or compaction-submission authority. A model's final reply cannot substitute
for receipts. This optional diagnosis saves bound owner-only evidence for comparison; it does not
gate normal tasks, navigation publication, compaction admission, or recovery. Missing, failed,
unreadable, old, or mismatched records do not change execution plans or trigger test calls.
Binding changes affect diagnostic applicability only, with no time-based expiry. Setup completion
uses the required configuration steps rather than this result. Manual diagnosis keeps the original
start and Sent rules and never automates Send. Current protocol, credential, source, delivery,
and commit checks remain necessary even after a successful diagnosis.
An incompatible connector or helper fails before execution; it must
not silently fall back to the former timeout behavior. Production connector defaults are
`Codex Native5` and `Codex Zero Risk4`; Automatic DEV uses `Codex Native5 DEV`. Old active runtimes
are not upgraded in place; a negotiated runtime fails explicitly on a later protocol downgrade.
Connector identity
and cached-schema migration follow the [architecture](architecture.md), not an in-place rename of
an old production connector. Keep `Codex Native4`, `Codex Native4 DEV`, and `Codex Zero Risk3`
unchanged and create the corresponding new plugin. Earlier retired defaults also remain unusable.
For the still-unreleased context text v2 update, keep the current Native5 / Native5 DEV / Zero Risk4
and non-retired custom names. Update or reconnect the same connector if its current contract is
incompatible. A past diagnostic result cannot replace current v2 checks. If the client cannot
update or use the new shape,
stop v2 enablement. This exception does not restore any retired connector identity. The verification
scope still forbids completion; body-use evidence comes from separate real tasks and compaction.

## Decision basis and implementation

The confirmed September 2026 long-wait decisions separate one logical execution from repeated
transport waits. Caller-owned identity was chosen instead of parameter-based deduplication or a
separate begin step. Binding rejected IDs preserves deterministic recovery after a lost admission
receipt; keeping public finalizers in the operation preserves results after an MCP handler returns.

The maintained implementation is in [operations](../src/adapters/chatgpt-web/native-tool-operations.ts),
[result contracts](../src/adapters/chatgpt-web/native-tool-contract.ts),
[waiting constants](../src/adapters/chatgpt-web/native-tool-wait-protocol.ts),
[Broker](../src/adapters/chatgpt-web/turn-broker.ts),
[MCP server](../src/adapters/chatgpt-web/mcp-server.ts), and
[remote idle registry](../src/native-turn-idle.ts). Relevant regressions are
[operation tests](../tests/native-tool-operations.test.ts),
[MCP waiting tests](../tests/native-tool-long-wait.test.ts), and
[waiting progress tests](../tests/native-tool-long-wait-progress.test.ts).
Task-update behavior is covered by the [Local/Remote Broker tests](../tests/task-update-broker.test.ts),
[MCP encoding tests](../tests/task-update-mcp.test.ts), [source/session tests](../tests/task-update-session.test.ts),
[Automatic Adapter tests](../tests/task-update-adapter.test.ts), and
[Zero Risk Adapter tests](../tests/task-update-zero-risk-adapter.test.ts).
Real-platform coverage is separate from those tests; see
[release validation](release-validation.md#native-tool-waiting-validation).

## Execution transfer and trusted settlement

Task identity, attempt, execution generation, page generation, task revision, and history revision
have distinct roles. Revocation precedes successor activation and is checked at the actual
dispatch/commit boundary, including queued Native calls, helper Send/acquisition, inventory,
context reads, task transfer/ACK, final answers, and checkpoint commits. Static configuration and
navigation verification do not prove running components share these rules. Keep backend, Broker,
helper, and Launcher compatible and verify their running capabilities.

The recovery journal uses document version 4 for page-lifecycle authority. Existing version 2/3
documents are promoted under the storage lock; readers that do not support version 4 reject its
execution permissions. Running components advertise `session-continuity-recovery-v4`; the
recovery identity schema remains 2. Document-format compatibility does not prove that an old
external command stopped or that physical page capacity was released.

Dispatch registration and generation changes have one atomic order. The current-page journal
retains its work, attempt, snapshot, call type/ID, first digest, and Send relationships. Once a
generation is revoked or removed, old messages cannot recreate its records or affect the new
page. Original in-flight completion channels can finish only the old transmission; a missing
old record denies old-message writes, while a new request can start a new generation.
A running-process handle does not prove process termination. Neither cancellation nor cleanup
can undo an already-issued external command.

Serialize same-thread recovery and recheck the generation after asynchronous queries. Concurrent
matching requests share one creation and execution. Different requests keep one current writer;
once a new page exists, subsequent requests use its live-page checks. Delayed old helper Sends,
acquisitions, results, stops, task updates/ACK, final answers, and checkpoint commits cannot
modify the successor. Stop targets its own generation, and a closed page's old stop cannot block
a later request.

Within a confirmed live page, accepted updates retain their revision, acknowledgement, and
one-time transfer rules, and a compaction transaction commits once. Closed or unknown-page
continuation instead uses the current request's readable summary/history without an old
checkpoint ledger. Lost compaction may regenerate from current sources as a new transaction,
not an exact replay. Old cumulative retries and missing old Send/results cannot deny that new
request. Finite per-request attempts and actual service, input, and physical-capacity limits
remain in effect.

These rules isolate project-controlled operations and state commits. They do not prove that
ChatGPT-owned platform activity has stopped or globally deduplicate semantically equal operations
with different IDs. See [session continuity](session-continuity.md).
