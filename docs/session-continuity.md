# Session continuity

Supported Full Native + Launcher routes use one task mechanism with the ordinary `chatgpt-web/`
model names. It covers the six Automatic routes, two Zero Risk routes, and supported ordinary
aliases that resolve to the same capability. Account, model, reasoning, tool, and source checks
still apply. Browser-only, non-Launcher Managed Chrome, Luna, Think, and API upstream forwarding
keep their existing contracts. API Key authentication to a local Web route does not exclude it;
actual runtime capability and trusted task identity determine eligibility.

Implementation presence does not establish a real-platform pass. See the explicit outstanding
checks in [release validation](release-validation.md#session-continuity-validation).

## Preparation failure and saved inputs

A healthy existing page can survive a failed local preparation attempt. The attempt must be
proved unsent and terminated at the same durable authority boundary that grants Send. The
`preparation-termination-v1` receipt binds the actual request, attempt, owner/epoch, page and lease.
A phase flag, missing response or HTTP abort is insufficient; acquisition-only known-unsent proof
cannot be reused as a generic preparation receipt. A late preparation ACK cannot authorize Send
after termination. Backend and Launcher must both confirm the same termination before releasing
the attempt and preserving the last committed source/history/checkpoint and healthy lease.

The original public error code, message, retryability and cause remain available. A healthy page
with uncertain termination or a possible Send stays fenced for status recovery; it is never
silently resent. A closed/unknown page takes current-request recovery without waiting for old
settlement. Explicit stop and successor ownership still prevent an old attempt from restoring
itself. The Launcher does not put a confirmed unsent local-preparation failure into generic failed
page cleanup.

Plain user appends are durably saved during any supported task phase. Receive order is separate
from model acceptance and ACK. Tool/result/ACK entries deliver finite ordered prefixes; a response
with no such entry can finish before ordinary continuation processes the queue. Input received
after final output locks waits for the next physical response and cannot alter earlier text.
Zero Risk retains manual Send, Sent and required-attachment confirmation for that continuation.
A confirmed prompt snapshot is immutable when later input arrives.

Activity lists task inputs independently of open tabs. It shows state and local storage use, reads
and copies actual saved originals, restores a missing body only under its original ID and digest,
and allows explicit stopped-input retry or cleanup. Unknown receipt means retain the sender's
original and query/retry the same ID. Queue originals share the existing 24 MiB recovery budget;
each task can have 128 pending messages totaling 1 MiB. They survive page loss/restart and are not
silently evicted by a TTL. Completed/discarded originals can be cleared; task deletion stops new
input delivery before deleting originals. Already started external operations can still complete.
After a different native turn completes and the historical Session replay window of 30 minutes
ends, a fully settled older inbox can release its originals and detailed delivery records. A failed
successor preparation does not start that window. The same turn's physical completion alone does
not close receipt.
A compact source fence remains inside the shared budget so a delayed old request cannot create
new work after cleanup. Cleanup commits that fence before removing any original and can resume
after a crash. These fences have no silent expiry; a full budget produces an explicit refusal.

Disconnect only detaches an observer. It does not stop an already started physical response or
authorize a new browser send. Pure observer replacement does not advance driver generation,
change the physical owner or invalidate its captured final output. The current observer alone can
claim new tools; already issued calls keep their original completion rights.

## Intended behavior

A page is a replaceable execution surface. Select its lifecycle branch before checking old work,
stop, completion, revision, checkpoint, source, or retry records. When the authenticated Launcher
can confirm the actual page and bind it to the current execution generation, retain the current
page's payload, owner, history, tool-result, and compaction conflict checks. Matching retries can
still attach or replay. An HTTP disconnect or user interrupt alone does not establish page loss
and does not start a task in the background.

When the page is closed or its state is unknown, revoke the old project-controlled execution
generation and use the current authenticated request to create a new generation. Make a best effort
to cancel old helper, Broker, Launcher, and tool work. Do not wait for an unavailable old Send,
tool settlement, or physical-destruction receipt before admitting the request. Old stopped or
completed work, missing replay bodies, consumed checkpoints, unknown results, legacy records,
and exhausted recovery budgets cannot block this branch. HTTP cancellation caches and Adapter
preflight must obey the same rule, including old 400 `client_cancelled` responses.

Recovery can execute work that ran or was stopped on the old page. An unreachable old execution
may still produce external effects. Revocation cannot undo an issued command, and a returned
running-process handle does not prove process termination. Historical calls and request-carried
results or handles are context; they do not authorize redispatch of old tools. Valid new model
calls use current permissions. One recovery notice and bounded logs describe this limitation;
the bridge does not promise exactly-once business effects across page loss.

Cold start includes all current effective system, developer, AGENTS, skill, delegation and user
instructions, request-carried summaries, history, real results, and required images. It is not an
old resume suffix or just the last user message and a directory. The request need not become a new
turn or prove equality with the closed page's history; it may contain rolled-back history.
Eligible tool history remains on demand. Ordinary Full/MCP short-start plans can deliver other
required text through `context-bootstrap-v1`; it must be fully delivered before business work or
successful completion. Required text cannot be silently summarized, trimmed, or made optional.

Complete sources need not fit as one browser prompt. The actual plan must fit its model and account
window, composer/attachment limits, existing page cost, directory discovery, complete read replies,
required images, error allowance, and work/summary reserve. HTTP, parsing, source readability,
32 MiB snapshot storage, and durable-evidence limits remain separate. Navigation retains its
96,000 estimated-token and 64 MiB wire cumulative limits. A small legal inline request remains valid.
Navigation requires the configured Native5 / Native5 DEV / Zero Risk4 or supported custom connector
and its current protocol, credentials, readable sources, and delivery checks. Historical
**Verify runtime** results do not control admission or recovery. Full + Launcher and a past
successful diagnosis do not establish that the current operation can succeed.

All three recovery entrances use this branch: unfinished ordinary work, checkpoint continuation,
and uncommitted compaction after page loss. A new page can use the request's readable summary
without finding an old local checkpoint commit. Lost compaction can produce a new summary from
the current request; it is not an exact replay of the old commit. Within a confirmed live page,
checkpoint selection and one-time commit rules still apply. Concurrent matching recovery requests
share one creation and execution with fresh generation-bound credentials. Recheck the current
generation after asynchronous inspection and before creation or mutation. A late old receipt
cannot replace a newer page.

The catalog publishes a finite 1,000,000-token Codex history window and 900,000-token automatic
compaction threshold for applicable routes and equivalent ordinary aliases. Lower client limits
still apply. Usage estimates the canonical history, not just a small retained-page increment.
These values do not enlarge the actual ChatGPT window, per-message transport, source storage,
read budget, or result cache, and do not claim platform billing or complete visual-token counts.

Fresh Conversation Per Turn selects a new page for each logical send that needs new browser input.
It does not create a page for tool round trips, HTTP replay, or task updates, and cannot bypass
conflict checks on a confirmed live page. Bigger Context keeps existing model/account/send capabilities
and single-message limits; supported fixed-part, final-commit, ACK and Send-retry contracts still
apply. Zero Risk's existing Bigger Context prohibition remains. Mode unification adds no new manual
multipart permission.

Zero Risk still requires user sending, Sent confirmation, and required-attachment confirmation.
An already-ended response uses the existing explicit manual checkpoint handoff; recovery never
sends an automatic second prompt or treats navigation reads as Sent confirmation.

## Short-start scope and updates

A new physical ordinary send creates its own fixed source snapshot, plan and required-text coverage.
A same-scope start/read retry retains those identities and its coverage. A new page, restart or
cold recovery cannot reuse old receipts or a journal's read marker to satisfy new required text.
It rebuilds current effective instructions and the complete request from authorized real sources.
Late old-generation returns cannot change the new scope. Healthy retained pages keep their legal
retained suffix; omitted history does not become required merely because it appears in a directory.
Unknown Send retains the existing no-resend fence and lifecycle recovery branches.

Active user updates retain exact ordered delivery and explicit ACK. They bypass the composer and
keep their own capacity limits. An update revision does not mutate the initial snapshot or invalidate
its still-authorized references. Reading initial sources does not ACK an update; ACK does not add
initial coverage. New work and final output must satisfy both current revision checks and initial
required-text readiness. Inputs during Zero Risk Send/Sent waiting do not rewrite the copied prompt
or trigger automatic Send.

Compaction sources remain optional summary evidence under their independent credential and
submission protections. Compaction does not acquire an all-history coverage gate. A subsequent
ordinary task delivers its current required instructions under its own new plan. Browser-only,
upstream API forwarding, legacy inline delivery and existing multipart semantics retain their
contracts; each actual composer message still obeys the effective code-point limit. See
[short-start delivery and budgets](context-navigation.md#short-startup-and-required-text).

## Current work and committed relationships

The following relationship checks apply to a confirmed live page. Closed or unknown pages use
the current-request recovery branch above, before any historical relationship check.

The binding owns the page, head, revision, and single-writer lease. The execution and round journal
own accepted instructions, issued calls, first results, and replayable output. A durable admission
journal preserves the work, attempt, source lineage, and send/delivery stages across restart.
A checkpoint commit owns its stable source work/task/batch/history target, target history revision,
summary digest, result coverage, and one-time transition. These records serve the current page;
they do not create permanent execution eligibility after it closes. An index or request-local
cache can refer to these records; it cannot replace missing or reclaimed live-page authority
with a guess.

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

Supported Full Native + Launcher tasks can save new plain user text at any phase. The bridge
proves the same thread, native turn and scope independently of a tool batch. A compatible active
Automatic or started Zero Risk capability can receive a finite prefix at a controlled tool or ACK
entry. That delivery retains the physical response, maps the exact inputs to it, and transfers
driver authority before delivering results. It adds no browser message and repeats no Native call.
Other saved input waits for an ordinary continuation with the normal page and manual Send policy.

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

Receipt advances only S. Active delivery advances task revision and driver generation, not history revision. Only committed
compaction advances history revision. Compaction uses the latest logical source and locally
accepted results; it does not request their old bodies again. Unacknowledged updates, prepared
transfers, and pending calls are not completed work. A stale compaction preflight cannot stop a
newer driver.

| Active source state | Append outcome |
| --- | --- |
| Tool boundary or open confirmation window | Save input, then deliver an ordered finite prefix; acknowledgement follows separately. |
| Running without an available boundary | Save input and preserve the current physical response. Use a later controlled entry or ordinary continuation. |
| Final answer locked but response still running | Save input for the next ordinary response. Do not change the locked answer's version or coverage. |
| Compaction owns the source | Save input independently. Preserve the frozen compaction source and wait for a legal continuation. |
| Earlier transfer outcome unknown | Recover the same transfer identity; do not assume rejection or start another transfer. |
| Old response without negotiated update support | Save input through the supported queue and wait for ordinary continuation. Preserve the old capability without upgrading it. |
| Response normally completed on a healthy page | Use ordinary continuation with only the new increment. Zero Risk still requires manual sending. |

These checks prevent misrouting, duplicate execution, and competing writers. They do not verify
complete history or tool-result content integrity. See the [Native update protocol](native-tool-protocol.md#user-updates-during-tool-work)
for delivery, acknowledgement, and final-answer admission.

### Checkpoint selection and one-time continuation

The specifically committed checkpoint relation selects continuation on a confirmed live page;
a summary cache alone grants no authority over that page. Exact
delegated proof still includes request-carried source thread/turn, item ID, content, model, and
reasoning identity. Neither the current compaction turn nor a matching summary replaces the source.
Native v1 compaction can retain an older human message while dropping a synthetic delegated
instruction. Recover that delegated source only through its exact committed checkpoint and
accepted producer representation. Repeated compaction preserves this provenance; a new steering
instruction keeps its own identity. Native AGENTS refreshes remain context and do not become a new
task. Durable source-type evidence does not reconstruct missing instruction text after restart.
Verified mode retains only its existing legitimate mappings. Retained-page continuation selects
a unique source; a matching summary or the latest head cannot replace missing source proof.

| Recognized work | Result |
| --- | --- |
| Known old ordinary, result, or compaction work | Replay its own record or fail if reclaimed; do not remap it to the current revision. |
| Explicit source and committed checkpoint | Select that exact commit. Equal summaries from other sources do not decide identity. |
| Interrupted active source with an unconsumed transition | Consume the transition once with current execution authority; retries reuse the same consumer, including after consumption and before Send. Page loss instead uses current-request recovery. |
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
became stale must not retire a newer owner. While the page remains live, uncertain control delivery
stays with its original attempt. An accepted handoff does not itself prove successful checkpoint
commit; bound execution, result, source, and one-time commit checks remain required.
Automatic can generate a read-only summary on a new page for lost compaction from the current
request's actual sources. Old work, handoff, commit, and retry records do not gate this new page.
It is a new summary transaction, not proof of exact old output. Each current-page transaction
still commits once. Zero Risk retains its manual handoff boundary after an ended response.

Full/MCP compaction can supply a bounded navigation entry into a separate snapshot of complete
legal sources. An independent `compaction_token` permits only `codex_context_list`,
`codex_context_read`, and `codex_context_search`; the original handoff or completion credential
still submits the checkpoint. Historical instructions are summary evidence, not new business work.
The model chooses which sources to inspect, with no minimum read count or full-coverage requirement.
New compaction admission does not read or require historical six-call diagnostic evidence.
Replay keeps its original receipts and authorization. Optional diagnosis does not change source
reading requirements or the original writer and Send rules.
Control delivery, actual source availability, summary reserve, settled in-flight reads, and the
existing writer, revision, ACK, Send, and real-result checks still gate acceptance.

Healthy retained compaction need not resend all source bodies or read every source within the
cumulative allowance. A fresh recovery page checks complete legal sources and the actual on-demand plan before
navigation can be published; unsent full-source compilation is not a browser-window gate. Missing source bytes,
permanent read failure, cancellation, or expiry prevent a successful checkpoint and preserve
accepted ordinary results for their original replay path. Correctable budget errors can let the
model stop reading and submit; exhausting the source-query reply allowance stops reads with a
JSON-RPC rejection without closing the shared MCP transport or original submission path. On a live
page, unknown Send is not resent to rebuild a directory. After page loss, a new request may start
a new execution without resolving that old Send; old calls are not automatically redispatched.
Restart invalidates old read credentials and references; new sources require actual verified
content. See [context navigation](context-navigation.md).

## Retention and recovery evidence

A healthy ready page has a 24-hour idle limit measured from successful ordinary work or a
committed checkpoint. Queries, heartbeats, and final-answer replay do not extend it. Active-tool
leases, helper liveness, remote idle, and task deadlines keep their current rules. The five
physical-page limit remains. Safe idle pages can be reclaimed under pressure; active dispatches,
unknown Send, unsettled calls, checkpoint commits, and active transfers exclude a page from idle
reclamation. Expiry does not permanently deny a later request's recovery.

A closing or failed-cleanup page still occupies its physical slot until destruction is confirmed.
Logical revocation does not release that slot. A successor can use another free slot, but cannot
create a sixth page. Each fixed-target cleanup transaction has at most three automatic close
attempts with finite timeouts. Exhaustion reports a cleanup fault and waits for explicit further
cleanup or destruction. Retain only the physical identity and minimum close-retry information;
do not retain page work history just because physical cleanup remains incomplete. Independently
owned pending/stopped task inbox originals remain until explicit handling; page cleanup must not
delete those inputs or grant execution authority.

Page destruction revokes that execution generation and removes its registration, work, attempts,
calls, stop/completion, revision/checkpoint/retry data, bindings, execution indexes, and associated
snapshots. A destruction callback must match its own generation; a late old callback cannot delete
a newer page. Cleanup is idempotent. Do not substitute permanent stop/completed tombstones or a
summary-history archive for the deleted task journal. Independently referenced in-flight data can
remain only until that transmission ends; it cannot grant new-generation writes or block recovery.

The registry and recovery journal retain bounded current-page ownership and protocol state,
including issued calls, first-result digests, Send stages, and checkpoint relationships. Existing
bounds remain: 10,000 threads / 4 MiB registration data, 24 MiB shared recovery/checkpoint evidence,
2 MiB per item, 256 checkpoints/tombstones, and 512 execution rounds. Reserve required current-page
receipts before side effects. The metadata journal stores no prompts, tool-result bodies, chat
URLs, or capability tokens. Snapshot and replay bodies have their own current-page references;
they are not an archive for possible future recovery.

While a page is live, record send-possible before Send and delivery-possible before Native dispatch.
Persist accepted results and stop/final/compaction receipts before exposing them. Recheck current
owner, generation, transaction, attempt, snapshot, and cancellation at mutation. A message with no
matching active record has no write authority. A new authenticated request with no old record can
start a page. These are different admission decisions.

An explicit stop targets its own current generation. A stop or HTTP observer disconnect alone
does not prove destruction and does not automatically restart work. When a later request finds
that page closed or unknown, the old stop cannot block recovery. Late stops, tool results, task
updates/ACK, Send receipts, and checkpoint commits cannot restore cleaned records or affect a
new generation. Already-issued external commands may still run.

The independent `previous_response_id` cache retains its one-hour memory and disk behavior,
capacity limits, and expiry collection. It can contain input and output bodies after page task
cleanup. It only expands API input; it does not prove a live page or old ownership. Missing or
expired cache data returns the existing 409 context error: resend full canonical history through
normal client handling. A chat URL, hash, or old task record cannot supply missing bytes.

A fresh page must satisfy actual HTTP, parsing, readable-source, input/output, attachment,
navigation, snapshot, account, and physical-capacity limits. Do not silently trim required text,
images, or real results. Creation has finite per-request retries and timeouts; the old cumulative
three-attempt / 30-minute budget cannot permanently deny later corrected requests.

Setup and migration preserve installation identity, login state, and the independent increment
cache. Keep necessary activity state only for pages that the current Launcher can confirm alive.
Remove closed-page records; revoke unknown generations and admit current-request recovery.
Legacy, stopped, completed, missing, or corrupt old task records are not a permanent deny list.
Temporary corrupt-file isolation must not become a long-term task archive. Interrupted migration
can retry under the existing mutual exclusion without activating two current writers.

Update backend, Launcher, helper, and Broker together. New files on disk do not prove running
components enforce the new rules. Revoke old project permissions before new activation, and make
a best effort to retire old processes and pages. Do not require proof that all unreachable old
processes exited. An unavailable creation interface is a real service error; temporary storage,
permission, or lock failures are infrastructure errors, not permanent stopped work.

## Configuration and existing tasks

The independent continuity mode and its model names are removed. An old
`chatgpt-web-continuity/gpt-6-pro` configuration must use `chatgpt-web/gpt-6-pro` instead; the same
prefix replacement applies to the corresponding supported model. Old names are rejected before
Send or new-work admission with the replacement name. They are not hidden callable aliases.
Model catalogs, exports and project-managed configuration use ordinary names. User-maintained
TOML is not silently rewritten. Responses retain the legal ordinary slug requested by the client.

Switching equivalent supported ordinary aliases or compatible Fresh preferences does not itself
record mode-exit. Account, actual model, and authorization-scope compatibility still apply to a
live page. Migration preserves that page's required active relationships; closed or unknown pages
use the lifecycle cleanup and recovery rules above. Current request history supplies a new page's
context without pretending to prove the old execution. Interrupted migration must not produce
two current owners.

## Stop reasons and manual handoff

| Error | Meaning and next action |
| --- | --- |
| `continuity_session_lost` / `continuity_unverified` | Re-evaluate the page branch. A closed or unknown old page permits current-request recovery; an actual new-page service failure remains an error. |
| `continuity_execution_unsettled` | A live-page operation remains unresolved. This old-generation state cannot block closed/unknown-page recovery or authorize automatic tool redispatch. |
| `continuity_context_missing` / `continuity_result_conflict` | Correct unreadable or insufficient current input, or a real current-page result conflict. Missing old ledger proof is not an input failure. |
| `continuity_replay_unavailable` | A confirmed live page lacks its replay body. After page loss, old completion cannot prevent a new current-request execution. |
| `continuity_legacy_unproven` | Old task metadata cannot prove a live page. Apply lifecycle recovery rather than requiring old settlement proof. |
| `continuity_stopped` | The confirmed live execution was stopped. If the page is later closed or unknown, that old stop cannot reject the new request. |
| `continuity_retry_exhausted` | The current request exhausted its bounded attempts. Old cumulative task budgets do not deny later recovery requests. |
| `continuity_source_unproven` | A confirmed live page has a specific source, revision, or owner conflict. Old-page source proof does not gate a new page. |
| `continuity_manual_handoff_required` | Zero Risk ended before checkpoint control was delivered. Keep the accepted answer and tool results; any next task is a user-controlled handoff. |
| `continuity_configuration_conflict` | Configuration, registration storage, or component versions are incompatible. Check the specific diagnostic; changing settings does not restore a lost owner. |
| `continuity_input_limit` | The actual next prompt is too large. Reduce the new input; this policy does not increase the single-input limit. |
| `continuity_resource_capacity` | Page or state capacity is full. Active or uncertain work cannot be evicted for capacity. Wait for safe idle reclamation or exact physical destruction; failed cleanup still consumes its slot. |

Temporary coordination failures use finite per-request attempts and timeouts. Concurrent matching
retries share one creation and do not cause a second Send. Old cumulative attempt or time windows
do not follow a closed page into later requests. Input and capacity errors preserve eligibility
for a corrected request. Recovery reports once when a new conversation loads current context;
Zero Risk still requires manual sending. No failure undoes already executed Native operations.

Implementation boundaries are in [continuity binding](../src/adapters/chatgpt-web/continuity-binding.ts),
[environment/input selection](../src/adapters/chatgpt-web/environment.ts),
[execution and journals](../src/adapters/chatgpt-web/turn-execution.ts), and
[Adapter integration](../src/adapters/chatgpt-web/index.ts). The
[input](../tests/session-continuity-input.test.ts),
[state](../tests/session-continuity-state.test.ts), and
[Adapter](../tests/session-continuity-adapter.test.ts),
[HTTP](../tests/session-continuity-http.test.ts),
[compaction](../tests/session-continuity-compaction.test.ts),
[recovery](../tests/session-continuity-recovery.test.ts), and
[checkpoint regressions](../tests/session-continuity-checkpoint.test.ts) preserve those contracts.
See also the [security model](security-model.md), [Native tool protocol](native-tool-protocol.md),
and [release evidence](release-validation.md#recorded-continuity-evidence).
