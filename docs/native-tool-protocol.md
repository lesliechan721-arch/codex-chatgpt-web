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

Capacity failures do not evict accepted operations or rerun Native work. Distinct errors identify
unknown/conflicting IDs, rejected admission, unavailable results, resource limits, lease expiry,
Native deadlines, cancellation, retirement, infrastructure failure, and required upgrades.

The implemented Broker protocol is 7 and Native waiting protocol is 1. The helper advertises
`native-tool-wait-v1`. Check for `codex_tool_wait` and `operation_id` on Native entry schemas before
any side-effecting dispatch. An incompatible connector or helper fails before execution; it must
not silently fall back to the former timeout behavior. Production connector defaults are
`Codex Native3` and `Codex Zero Risk2`; Automatic DEV uses `Codex Native3 DEV`. Connector identity
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
Real-platform coverage is separate from those tests; see
[release validation](release-validation.md#native-tool-waiting-validation).
