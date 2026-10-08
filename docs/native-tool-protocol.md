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
A new ordinary turn on a retained continuity page also negotiates this protocol with a new
tool capability and task revision 0. It keeps the page owner and lease; it does not reuse the
previous turn's tool authority or task revision. Compaction requests do not negotiate this protocol.
The Adapter may retain one physical ChatGPT response when the same native thread and turn append
trusted plain user text. In the ordinary policy, prior instructions, environment, model, options,
and permissions must remain unchanged. The prior Responses round must have journaled its complete real tool batch,
`done(tool_use, endTurn:false)`, and source observation proof before sending the batch to the
HTTP observer. An exact reconnect replays that same source round. A known outstanding or
handed-off batch lacking its source proof fails with `task_update_source_unproven`.
With no current batch, raw results must exactly match accepted historical results before
fallback is allowed; unknown or changed results fail before retiring the existing owner.
Pure text work, changed instructions, unsupported source shapes, and initial Zero Risk requests
awaiting Sent use their existing behavior.

Continuity-first work uses local source records instead of the ordinary policy's full-prefix and
complete-result-batch proof. The same active thread, turn, scope, owner, and page lease must be
identifiable. A current tool boundary or open update-confirmation window is required. Completed
history may be trimmed or reserialized; changed old text is not sent back to the page. Stable
new user item IDs preserve order and prevent duplicate acceptance. Equal text with different IDs
remains separate input; changing the text of an already accepted new item is a conflict.

A continuity append may contain zero or some pending results. Known pending call IDs retain their
expected result-type check. The first accepted result completes each call once; duplicates,
completed historical results, and unknown IDs do not complete current calls or authorize tools.
Later result-only requests can fill the remaining calls without another update or generation.
Result bodies and full history are not source proofs. A replay with a new HTTP request ID recovers
the original update outcome, and any new pending results can still be accepted independently.

The Broker tracks accepted, delivered, and acknowledged revisions independently, beginning at 0.
Each appended user item has a stable source ID; equal text in different items remains distinct.
An owner-only transfer binds its ID to immutable local commit data. For the ordinary policy this
includes the exact updates, registry, and original result batch. Continuity retries recover that
local data without requiring the client to repeat the original batch or history.
Reservation precedes the short Session preparation barrier; atomic acceptance installs the new
revision and driver generation before waking real result promises. Outcomes are immutable:
`committed`, `not_committed`, or `unknown`. Recover an unknown outcome by querying or retrying the
same transfer. A timeout or absent lookup is not evidence that it failed to commit.

Native query replies retain their original `pending` or `result` plus a separate `taskUpdate`
delivery. With a delivery, MCP presents a visible fixed control block and a structured envelope:
`native_result` preserves the complete original public result; `task_update` comes only from the
Broker. Text, images, resources, `structuredContent`, `_meta`, and error semantics are preserved.
No update is stored in the Native result cache or sent through the browser composer.

Apply delivered updates in order, then call `codex_task_update_ack` with the same capability,
`delivery_id`, and `through_revision`. One immutable delivery is outstanding at a time; retries
return it unchanged. A further append during the ACK gap stays queued and can be delivered in
that ACK response. In the ordinary policy, without a new real batch an append after the gap closes
uses the existing replacement path. An active continuity response without an available boundary
rejects the append as not accepted and preserves the running work. ACK is confirmation, not Native
execution or extra business progress.

Every Native start on a negotiated capability declares a nonnegative safe integer `task_revision`,
initially 0. That revision joins the bound start fingerprint and is removed from Native arguments.
An identical ID retry replays its original outcome before current-version admission. A new ID
requires `task_revision === acceptedRevision === acknowledgedRevision` and no final output lock;
otherwise it caches `task_update_not_executed` with zero Native dispatches. Previously handed-off
calls keep their real results. Old queued calls are intercepted rather than executed after ACK.
`codex_tool_wait` uses the original ID and does not declare a new task revision.

All owner writes and waiter delivery capture `expectedDriverGeneration` and check it at the actual
Broker mutation, including Remote IPC. Session generation checks also run after asynchronous
owner calls. A superseded active observer ends with `incomplete(task_update_handoff)`; an already
completed source round keeps its terminal journal. Late observer cancellation cannot revoke the
new driver. Trusted user stop remains a separate physical cancellation operation.

The first nonempty final-answer delta locks its captured acknowledged version. Commentary and
reasoning do not lock it. A strict buffered answer or worker-first completion may lock inside
the completion CAS before text is sent; sending then reuses that immutable receipt. Candidates
are never upgraded to a later head. Automatic unacknowledged final output fails explicitly;
Zero Risk completion requires the acknowledged revision after an update and can return the
pending delivery on refusal. Its initial revision 0 remains the compatible default. After the
lock, ordinary-policy appends use the existing replacement path and late ACKs cannot change the
answer. Continuity appends are not accepted while that locked response is still running; wait for
it to finish before sending a normal continuation. A response that did not negotiate the update
protocol cannot be upgraded by an append. Compaction refuses unresolved updates or prepared
transfers and requires the latest exact source. Continuity compaction reuses locally accepted
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

Configured fresh compaction and recoverable-mode delegated source fallback retire the old browser
and tool owner, including that owner's queued, waiting, and result-ready operations. The fresh
owner cannot adopt or reexecute them. Continuity-first policy forbids this fresh fallback; see
[session continuity](session-continuity.md).

There is no operation recovery across Broker or owner-process restart. Retained pages, HTTP rounds,
and reconnects are not new operation stores. Missing results or expired evidence must fail
explicitly rather than trigger a second side effect.

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

The implemented Broker protocol is 10, Native waiting protocol is 1, and task update protocol is 1.
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
are released with the bounded retired-turn cache or Broker shutdown. Missing or invalid sources
fail the turn. Helpers
without `task-output-ack-v3` do not negotiate hot updates for a new execution.
Check for `codex_tool_wait`,
`operation_id`, `task_revision`, and `codex_task_update_ack` on the selected connector before
any side-effecting dispatch. An incompatible connector or helper fails before execution; it must
not silently fall back to the former timeout behavior. Production connector defaults are
`Codex Native4` and `Codex Zero Risk3`; Automatic DEV uses `Codex Native4 DEV`. Old active runtimes
are not upgraded in place; a negotiated runtime fails explicitly on a later protocol downgrade.
Connector identity
and cached-schema migration follow the [architecture](architecture.md), not an in-place rename of
an old production connector.

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
