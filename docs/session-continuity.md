# Session continuity

Supported Full Native + Launcher routes use one task mechanism with the ordinary `chatgpt-web/`
model names. It covers the six Automatic routes, two Zero Risk routes, and supported ordinary
aliases that resolve to the same capability. Account, model, reasoning, tool, and source checks
still apply. Browser-only, non-Launcher Managed Chrome, Luna, Think, and API upstream forwarding
keep their existing contracts. API Key authentication to a local Web route does not exclude it;
actual runtime capability and trusted task identity determine eligibility.

Implementation presence does not establish a real-platform pass. See the explicit outstanding
checks in [release validation](release-validation.md#session-continuity-validation).

## Intended behavior

A page is a replaceable execution surface. A healthy compatible page is preferred for incremental
work and across compaction. If current instructions cannot be synchronized, the page is unavailable,
or its remaining budget is insufficient, recovery selects a new page after three separate checks:
execution admission, complete legal sources, and the actual selected delivery plan.

Execution admission preserves accepted instructions, issued calls, first real results, stop,
completion, checkpoint, and retry facts. A completed request only replays its available answer;
a missing answer body is an explicit failure, not permission to rerun. A stopped work item remains
stopped. Unknown Send or delivered-operation results block successor execution. Neither a timeout,
a missing page, nor permission revocation proves that a command did not run or has finished.
A running-process handle remains a running-process handle and must be handed over with its legal
wait path, without repeating the original start.

When old-page inspection is unavailable, takeover is allowed only after durable isolation of all
project-controlled entry points, real settlement of registered dispatches, confirmed original Send
state, and final source/plan checks. The old page can remain present. This guarantee covers project
tools and state commits; ChatGPT-owned search or research can still run. The user receives one
notice of this limited guarantee. It is not global semantic deduplication: a new operation identity
with the same arguments can represent a new business request.

Cold start includes all current effective system, developer, AGENTS, skill, delegation and user
instructions, the specifically bound checkpoint, uncovered text, work/result relationships, and
required images. It is not an old resume suffix or just the last user message and a directory.
Only tool history and images eligible under the existing contract use the on-demand route.
Other required text cannot be silently summarized, trimmed, or made optional reading.

Complete sources need not fit as one browser prompt. The actual plan must fit its model and account
window, composer/attachment limits, existing page cost, directory discovery, complete read replies,
required images, error allowance, and work/summary reserve. HTTP, parsing, source readability,
32 MiB snapshot storage, and durable-evidence limits remain separate. Navigation retains its
96,000 estimated-token and 64 MiB wire cumulative limits. A small legal inline request remains valid.
Navigation requires the configured Native5 / Native5 DEV / Zero Risk4 or supported custom connector
and its real Verify runtime result; Full + Launcher alone does not establish navigation readiness.

All three recovery entrances use these checks: unfinished ordinary work, continuation after a
committed checkpoint, and uncommitted compaction after page loss. A checkpoint transition is
consumed once; an accepted summary is replayed, never regenerated. Uncommitted compaction keeps
its logical target, deadline and cumulative retry budget. A new execution uses one successor
attempt with fresh bound credentials; the old Send, snapshot, credentials and late handoff stay
with the old attempt. Concurrent retries attach to the same transfer. A valid already-accepted
handoff is settled once before starting another summarization attempt.

The catalog publishes a finite 1,000,000-token Codex history window and 900,000-token automatic
compaction threshold for applicable routes and equivalent ordinary aliases. Lower client limits
still apply. Usage estimates the canonical history, not just a small retained-page increment.
These values do not enlarge the actual ChatGPT window, per-message transport, source storage,
read budget, or result cache, and do not claim platform billing or complete visual-token counts.

Fresh Conversation Per Turn selects a new page for each logical send that needs new browser input.
It does not create a page for tool round trips, HTTP replay, or task updates, nor change task identity
or reset stop/checkpoint/retry facts. Bigger Context keeps existing model/account/send capabilities
and single-message limits; supported fixed-part, final-commit, ACK and Send-retry contracts still
apply. Zero Risk's existing Bigger Context prohibition remains. Mode unification adds no new manual
multipart permission.

Zero Risk still requires user sending, Sent confirmation, and required-attachment confirmation.
An already-ended response uses the existing explicit manual checkpoint handoff; recovery never
sends an automatic second prompt or treats navigation reads as Sent confirmation.

## Current work and committed relationships

The binding owns the page, head, revision, and single-writer lease. The execution and round journal
own accepted instructions, issued calls, first results, and replayable output. A durable admission
journal preserves the work, attempt, source lineage, and send/delivery stages across restart.
A checkpoint commit owns its stable source work/task/batch/history target, target history revision,
summary digest, result coverage, and one-time transition. A page generation changes on recovery;
thread history revision advances only on successful compaction and does not reset with a new page. An index or request-local cache can refer to these records; it cannot replace
missing or reclaimed authority with a guess.

### Ordinary input and result batches

An ordinary work identity combines trusted scope, native thread/turn, accepted local revision, and
native instruction identity. Compare the actual current payload separately: instructions, roles,
attachments, parent-agent wrapping, order, and execution-relevant options. Changing a payload
digest cannot authorize a second execution under the same identity. Completed-history text,
HTTP JSON/SSE encoding, and summary content are not new-work identities.

Recognize the request once after normal parsing, continuation expansion, and authority resolution.
Prompt compilation, payload checking, replay, and compaction selection reuse that recognition.
Recheck owner, lease, head, and version under the existing lock before a state-changing commit.
The selected input includes applicable system/developer material and the current native context
group, not just the last user message. A persistent prefix can retain its creation turn across
later turns; that alone does not make it obsolete. An ambiguous unowned group still fails before
submission. The recorded real-client layouts and synthetic variants have distinct evidence limits
in [release validation](release-validation.md#recorded-continuity-evidence).

Ordinary result rounds without an active append use locally issued batch/call IDs and their expected result types. Identify the
terminal result group and validate its entire batch before delivery; reject unknown, duplicate,
partial, mixed, or conflicting results. Normalize permitted result ordering to the locally issued
batch order. Old tool-call echoes cannot authorize calls or substitute for current results.
Serialize acceptance and journal updates so concurrent retries cannot both deliver a result.

An old batch replays its own output and usage, not a newer outstanding batch. A same-batch payload
conflict preserves the first accepted result. If delivery partially succeeds before an
infrastructure failure, keep the delivered members and do not deliver them twice. Uncertain
delivery fails instead of rerunning tools. Opaque result strings are not trimmed or approximately
matched. JSON and SSE expose the same logical outcome without creating separate executions.

An active ordinary reconnect validates its current payload and owner, updates the current registry,
then returns its cached response. Recheck ownership after asynchronous updates. An older
execution's replay is read-only and cannot replace the new owner's registry. Removed tools cannot
start new operations; already admitted operations retain their original completion rights.
Replay alone does not advance generation, revision, or the successful-work retention clock.

### User updates during an active response

Compatible Full Native Automatic and already-started Zero Risk responses can accept new plain
user text at a local tool boundary or while a previous update awaits confirmation. The bridge
locates the same active thread, native turn, scope, owner, and lease before applying the normal
thread-occupancy rejection. It retains the original page and physical response, maps the new
logical instruction to that response, and transfers driver authority before delivering results.
It does not send a second browser message or repeat Native calls.

Local instruction identities, retained source relationships, or issued call IDs must uniquely
identify the source. Completed history, old user text, and old result bodies need not match an
earlier copy. The bridge uses stable IDs for new user items: different IDs with equal text remain
distinct, and a retry cannot silently change text already accepted under the same new item ID.
An ambiguous source or a conflicting thread, turn, scope, or expired owner still fails.

At an available boundary, an append can arrive without results or with only part of a batch.
Known pending calls retain their expected result-type check before acceptance. Each call keeps
its first accepted result; duplicates are skipped even when their bodies differ. Unknown and
completed historical call IDs cannot complete a pending call or add tool authority. Missing calls
keep waiting. Later requests can supply only the missing results without accepting the same user
update twice, advancing driver generation, or reproducing the full batch. These rules apply to
the active append and its later result rounds; ordinary work retains its existing batch rules.

Acceptance, delivery, and model acknowledgement are separate states. Pending updates travel
through the existing MCP control path and remain separate from cached Native results. New Native
work requires the accepted revision to be acknowledged. Another append during confirmation is
queued in order. An HTTP disconnect does not cancel the transferred work, and a late old observer
cannot overwrite or cancel the current driver. Explicit user stop still ends the physical task.

An append advances task revision and driver generation, not history revision. Only committed
compaction advances history revision. Compaction uses the latest logical source and locally
accepted results; it does not request their old bodies again. Unacknowledged updates, prepared
transfers, and pending calls are not completed work. A stale compaction preflight cannot stop a
newer driver.

| Active source state | Append outcome |
| --- | --- |
| Tool boundary or open confirmation window | Accept and queue the update; delivery and acknowledgement follow separately. |
| Running without an available boundary | The append is not accepted. Keep the current task and send again when a boundary is available or the response has ended. |
| Final answer locked but response still running | The append is not accepted. Wait for completion, then send a normal continuation. |
| Compaction owns the source | The append is not accepted. Report the busy state and preserve the compaction. |
| Earlier transfer outcome unknown | Recover the same transfer identity; do not assume rejection or start another transfer. |
| Old response without negotiated update support | The append is not accepted. Preserve that response; do not restart or upgrade it. |
| Response normally completed on a healthy page | Use ordinary continuation with only the new increment. Zero Risk still requires manual sending. |

These checks prevent misrouting, duplicate execution, and competing writers. They do not verify
complete history or tool-result content integrity. See the [Native update protocol](native-tool-protocol.md#user-updates-during-tool-work)
for delivery, acknowledgement, and final-answer admission.

### Checkpoint selection and one-time continuation

The specifically committed checkpoint relation is the source of checkpoint recovery; a summary
cache alone grants no authority. Exact
delegated proof still includes request-carried source thread/turn, item ID, content, model, and
reasoning identity. Neither the current compaction turn nor a matching summary replaces the source.
Verified mode retains only its existing legitimate mappings. Recovery must select a unique durable
source; a matching summary or the latest head cannot replace missing source proof.

| Recognized work | Result |
| --- | --- |
| Known old ordinary, result, or compaction work | Replay its own record or fail if reclaimed; do not remap it to the current revision. |
| Explicit source and committed checkpoint | Select that exact commit. Equal summaries from other sources do not decide identity. |
| Interrupted active source with an unconsumed transition | After the old writer and tools settle, consume the transition once with new execution authority. A lost page can initialize from the accepted context; retries reuse the same consumer, including after consumption and before Send. |
| Completed source with a checkpoint-only request | Replay the original ordinary final answer; do not substitute the summary or rerun the instruction. |
| Explicitly new instruction | Exclude old identities/tombstones, then admit against the healthy current binding. An explicitly conflicting or stale relationship still fails. |
| Summary only, or indistinguishable source relationships | Fail before a new side effect. Do not choose the first, latest, or rightmost matching summary. |

Two source instructions in one native turn can have equal text and summaries but different item
identities and commits. A request for B selects B; a replay of A cannot write to B's later page.
The transition and continuation journal are established atomically, so a lost receipt cannot
consume the transition twice. Reclaimed source evidence cannot be reconstructed from current head.

Compaction work is bound to a stable source work, accepted task revision, history revision, and durable tool-batch sequence. Different local/v1/v2 wrappers do not
create another summary transaction. Deliver any valid current results first, then recheck source
generation and acquire the single-writer transaction before control delivery. A preflight that
became stale must not retire a newer owner. Once control delivery starts or is uncertain, coordinate its original attempt before admitting
recovery. An accepted handoff does not itself prove successful checkpoint commit; bound execution,
result, source and one-time commit checks remain required.
Automatic can generate a read-only summary on a new page for an uncommitted lost compaction after
the old writer and delivered tools settle. If a complete valid handoff body is already available,
commit it once instead of generating another summary. A successful commit only replays its own
result; a missing replay body does not authorize regeneration. A logical checkpoint committed
without a live page is initialized by its subsequent ordinary continuation. Zero Risk retains its
manual handoff boundary after an ended response.

Full/MCP compaction can supply a bounded navigation entry into a separate snapshot of complete
legal sources. An independent `compaction_token` permits only `codex_context_list`,
`codex_context_read`, and `codex_context_search`; the original handoff or completion credential
still submits the checkpoint. Historical instructions are summary evidence, not new business work.
The model chooses which sources to inspect, with no minimum read count or full-coverage requirement.
New compaction admission first requires the selected profile's six-call read-only capability
verification; replay keeps its original receipts and authorization. This setup check does not
require production compaction to read every source or alter its original writer and Send rules.
Control delivery, actual source availability, summary reserve, settled in-flight reads, and the
existing writer, revision, ACK, Send, and real-result checks still gate acceptance.

Healthy retained compaction need not resend all source bodies or read every source within the
cumulative allowance. A fresh recovery page checks complete legal sources and the actual on-demand plan before
navigation can be published; unsent full-source compilation is not a browser-window gate. Missing source bytes,
permanent read failure, cancellation, or expiry prevent a successful checkpoint and preserve
accepted ordinary results for their original replay path. Correctable budget errors can let the
model stop reading and submit; exhausting the source-query reply allowance stops reads with a
JSON-RPC rejection without closing the shared MCP transport or original submission path. Unknown
Send is never resent to rebuild a directory. Restart invalidates old read credentials and references;
new sources require actual verified content. See [context navigation](context-navigation.md).

## Retention and recovery evidence

A healthy ready page has a 24-hour idle limit measured from successful ordinary work or a
committed checkpoint. Queries, heartbeats, and final-answer replay do not extend this time.
Active-tool leases, cancellation, helper failure, remote idle, and explicit task deadlines keep
their existing rules. The five physical-page limit remains. Under pressure, safe idle pages can be reclaimed early,
with terminal failed pages preferred and then least recent successful work in stable order. Active
dispatches, unknown Send, unsettled calls, checkpoint commits, and active transfers exclude a page
from idle reclamation. Reclamation preserves task evidence and does not create a user stop. Expiry ends the old page lease, but does not permanently deny the thread's recovery eligibility.

A closing or failed-cleanup page still occupies its physical slot until exact destruction is
confirmed. Durable execution isolation is independent of that physical cleanup. A successor can
use another free slot, but cannot create a sixth page. Each fixed-target cleanup transaction has
at most three automatic close attempts with finite control timeouts. Exhaustion reports a cleanup
fault and waits for explicit further cleanup or a real destruction event; it does not start an
unbounded background loop. Late acquisition/destruction receipts must match the original physical
page and creation transaction, not a reused UI tab number. Cleanup failure preserves isolation.

Page retention, source availability, answer-body replay, and durable execution evidence have
separate lifetimes. Active snapshots do not promise 24-hour original-text availability. Bounded
answer caches can expire independently of page retention. Durable stop and anti-replay facts
cannot expire into new execution rights.

An explicit stop or user closing a running page records stopped work. Fault page loss, idle
reclamation, and recovery cleanup do not automatically record user stop or remove an existing stop. Its retries
remain stopped. A distinct new user instruction can start a new page generation without clear,
after the previous writer and delivered tools settle. A plain HTTP disconnect only detaches an
observer. Changing the model or provider scope cannot take over an old page.

The durable registry keeps irreversible thread/scope indexes and minimal ownership state, with
10,000-thread and 4 MiB limits. Recovery metadata has a versioned, atomic, bounded journal. It
records work and source-lineage identities, page generations, attempts and snapshot versions,
issued call IDs/types, first result digests, stop/completion receipts, checkpoint relationships,
and retry counts. It saves no prompts, tool-result bodies, chat URLs, or capability tokens.
Empty memory after a restart is not proof that nothing was sent or executed.

Record send-possible before browser submission and delivery-possible before any Native dispatch.
The first compaction control on a healthy page also records its work identity, request payload,
attempt, and failure budget before delivery. Recovery reuses that work instead of starting a new
budget after the first failed handoff.
Persist results, stops, and successful commits before exposing their receipts. Creation and
preparation use a unique authenticated Launcher transaction; concurrent retries share it and late
receipts cannot overwrite a later generation, attempt, or snapshot version. Proven-unsent input
can be rebound after restart when its old body is gone; possibly sent input must first reconnect
or settle. No unknown Send is repeated to resolve a lost acknowledgement.
Preparation retains the preceding and target identities until Launcher confirms the update.
A creating transaction must finish or retire before input rebinding. Interrupted preparation
continues the same recorded transition; it cannot authorize a second Send.
A page acquisition records the Launcher process and host instance before it starts. After a
restart, a missing transaction requires authenticated proof of the old execution state. A compatible
running instance can be durably isolated for that thread; an incompatible instance needs verified
actual retirement. Registered dispatches and original Send must still be resolved before activating
a successor. Missing memory alone does not authorize another Send.

Recovery requires the results of delivered calls from the unfinished work's durable source chain,
including append predecessors and prior attempts. A reliable accepted checkpoint can cover older
settled results; unknown delivered calls cannot be hidden by a summary. The current authenticated
request can supply missing real results matching their issued IDs and first accepted digests.
An available completed result only replays. If its body was reclaimed, fail explicitly rather than
run the work again. Stopped and unknown-work evidence cannot expire into new execution rights.

Recovery and checkpoint evidence share the 24 MiB budget, with 2 MiB per item and at most 256
checkpoints. Execution rounds remain bounded to 512, with 256 ordinary tombstones per binding.
Admission reserves space for result, stop, and commit records before new side effects. Capacity
errors reject new work while preserving already admitted results and healthy tasks.

The independent previous_response_id cache still has its one-hour lifetime and capacity limits.
A missing cache returns 409: provide full canonical history through normal client handling.
The bridge does not reconstruct missing history from a chat URL or a digest. The selected actual recovery plan must fit its browser and attachment limits. Complete sources
remain subject to HTTP, parsing and storage limits. There is no silent trimming or implied new
multipart capability.

Setup/upgrade preserves the installation and existing registrations. Old v1 entries lack send,
call, and stop evidence and are legacy-unproven; they cannot be treated as never executed.
Missing or corrupt initialized storage fails closed and is not automatically reset. Recovery requires compatible running Broker, trusted result receiver, helper and Launcher
execution-isolation capabilities. Navigation verification or newer files on disk do not prove
that an old running instance enforces revocation. Unsupported old components need verified actual
retirement and dispatch settlement, or the transfer is rejected with an upgrade diagnostic. Deleting the registry is not supported.

## Configuration and existing tasks

The independent continuity mode and its model names are removed. An old
`chatgpt-web-continuity/gpt-6-pro` configuration must use `chatgpt-web/gpt-6-pro` instead; the same
prefix replacement applies to the corresponding supported model. Old names are rejected before
Send or new-work admission with the replacement name. They are not hidden callable aliases.
Model catalogs, exports and project-managed configuration use ordinary names. User-maintained
TOML is not silently rewritten. Responses retain the legal ordinary slug requested by the client.

Versioned atomic migration preserves existing work, calls, attempts, Send, stop, checkpoint,
revision and retry relationships. Switching equivalent supported ordinary aliases or compatible
Fresh preferences neither records mode-exit nor creates another task identity. Account, actual
model and authorization-scope compatibility still apply. An old task with only client history
cannot be adopted as proven unfinished execution. Legacy-unproven records and missing/corrupt
initialized journals stay unknown; do not delete the registry or write an empty journal to reset
execution rights. Interrupted migration resumes the same mapping without two active owners.

## Stop reasons and manual handoff

| Error | Meaning and next action |
| --- | --- |
| `continuity_session_lost` | The original page cannot continue. Recovery requires settled execution and valid current context; clear is not a general remedy. |
| `continuity_unverified` | The original page could not be inspected. Coordinate durable project isolation, real settlement and Send proof; lack of inspection alone does not authorize another Send. |
| `continuity_execution_unsettled` | Old project authority or dispatched operations are unresolved. Supply isolation and real settlement evidence; do not rerun the tools. |
| `continuity_context_missing` / `continuity_result_conflict` | Required current context or real results are missing or conflict with their first accepted digest. Correct the evidence before retrying. |
| `continuity_replay_unavailable` | Work completed, but its body is unavailable. It cannot run again. |
| `continuity_legacy_unproven` | The older registration lacks complete recovery evidence. Its previous execution must be proved settled. |
| `continuity_stopped` | This instruction was stopped. Only a distinct new user instruction may start new work. |
| `continuity_retry_exhausted` | This logical work reached its bounded recovery-attempt budget. Changing page generation does not reset it. |
| `continuity_source_unproven` | The source, revision, or current page writer cannot be proved. Do not fabricate a summary or replay tools to recover ownership. |
| `continuity_manual_handoff_required` | Zero Risk ended before checkpoint control was delivered. Keep the accepted answer and tool results; any next task is a user-controlled handoff. |
| `continuity_configuration_conflict` | Configuration, registration storage, or component versions are incompatible. Check the specific diagnostic; changing settings does not restore a lost owner. |
| `continuity_input_limit` | The actual next prompt is too large. Reduce the new input; this policy does not increase the single-input limit. |
| `continuity_resource_capacity` | Page or state capacity is full. Active or uncertain work cannot be evicted for capacity. Wait for safe idle reclamation or exact physical destruction; failed cleanup still consumes its slot. |

Temporary coordination failures can retry within the same logical work's durable budget: at most
three retries after its initial attempt within a 30-minute window. The window starts at the first
failure or recovery reservation, so a long healthy execution does not use up its recovery time.
Attaching an admitted transaction does not reset the window or create a second page.
Unknown tool results, missing context, conflicts, and explicit stops
do not trigger a blind automatic loop. Input and capacity errors preserve eligibility for a later
corrected request. Recovery reports once when a new conversation loads current context; Zero Risk
also requires the user to send the new prompt. No failure undoes already executed Native operations.

Implementation boundaries are in [continuity binding](../src/adapters/chatgpt-web/continuity-binding.ts),
[environment/input selection](../src/adapters/chatgpt-web/environment.ts),
[execution and journals](../src/adapters/chatgpt-web/turn-execution.ts), and
[Adapter integration](../src/adapters/chatgpt-web/index.ts). The
[input](../tests/session-continuity-input.test.ts),
[state](../tests/session-continuity-state.test.ts), and
[Adapter regressions](../tests/session-continuity-adapter.test.ts) preserve those contracts.
See also the [security model](security-model.md), [Native tool protocol](native-tool-protocol.md),
and [release evidence](release-validation.md#recorded-continuity-evidence).
