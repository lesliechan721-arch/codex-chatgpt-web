# Session continuity first

Compatible Full Native tools + Launcher environments expose the opt-in
`chatgpt-web-continuity/` model aliases without
an additional internal verification flag. Existing `chatgpt-web/` models keep their current behavior
and remain the default. Implementation and test presence do not replace the real-platform evidence
required in [release validation](release-validation.md#session-continuity-validation).

## Intended behavior

This policy starts a new ChatGPT conversation for a native Codex thread and prefers that page
for later ordinary instructions and accepted compaction checkpoints. If the page can no longer
continue, the bridge can create a new page generation for the same thread after it proves that
the old writer cannot dispatch and that delivered tools have real results. It then continues the
unfinished instruction from the current request, without requiring clear or another user message.
It never adopts an arbitrary older chat. Every initial or recovery prompt must fit the original
model's single-input limits before page creation.

Recovery can cover backend, helper, and Launcher restarts. A timeout while inspecting a page is
an unverified state: coordinate with the original execution before deciding whether a new page
is safe. Process exit or capability revocation does not prove that an external tool stopped.
The new page receives only the context actually available in the current canonical request.
Browser-only history and the previous model's internal state cannot be restored.

The policy requires Full Native tools and Launcher. It preserves the account, model, effort,
connector, and Zero Risk manual-submission requirements. Luna and Think have no continuity alias.
Fresh Conversation Per Turn is incompatible with this policy. Bigger Context can remain enabled;
it applies only to non-continuity models. Continuity keeps its fixed history budget and original
single-input limits without multipart staging.

The catalog advertises a 1,000,000-token execution history window and a 900,000-token
auto-compaction limit. These are Codex history budgets, not a larger ChatGPT context window or
permission to send a million-token prompt. Each actual initial prompt or continuation increment
still has its original token, character, attachment, and HTTP limits. Usage counts the complete
canonical history, not only the small increment sent to the retained page.

Compaction verifies the source, accepts a bound handoff, waits for physical completion, retires
the old execution's authority, and commits one new history revision. The page remains. An exact
retry can replay an available committed result; it cannot generate a second summary. A summary
alone never authorizes work, and a control summary does not replace an accepted ordinary answer.

The bridge checks current work against local thread, owner, lease, instruction, tool-batch, and
revision records. It does not require completed history to match an earlier copy item by item.
Changes to old text or display metadata do not update a healthy retained ChatGPT page. A recovery
page uses the current valid request history, so those edits can become part of its initial context.
Current instruction conflicts and changes to the first accepted required tool result remain errors.
Historical tool records cannot authorize tools or cause their calls to be dispatched again.

Current instruction identity and payload, result call IDs and types, and compaction source proof
still have to match. Identical summaries can belong to different revisions. If local records
cannot distinguish the requested work or a new increment from completed history, the bridge
returns `continuity_source_unproven` before submitting it. It does not select the latest revision
or repeat work to resolve that ambiguity.

An explicitly owned new turn can continue without replaying its completed predecessor. The
current native instruction prefix, including applicable developer and grouped AGENTS instructions,
remains part of the current payload. An active ordinary retry updates the current advertised tools
before replaying its response; a removed tool cannot start a new operation.

Zero Risk remains manual. An active response can return a checkpoint only through its existing
MCP control path. When that response finishes before the control instruction is delivered, the
bridge returns `continuity_manual_handoff_required`. It preserves the accepted answer and real
tool results, and does not copy or send a second prompt. The user must control any handoff.

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
| Final answer locked but response still running | The append is not accepted. Wait for completion, then send a normal continuity instruction. |
| Compaction owns the source | The append is not accepted. Report the busy state and preserve the compaction. |
| Earlier transfer outcome unknown | Recover the same transfer identity; do not assume rejection or start another transfer. |
| Old response without negotiated update support | The append is not accepted. Preserve that response; do not restart or upgrade it. |
| Response normally completed on a healthy page | Use ordinary continuity continuation with only the new increment. Zero Risk still requires manual sending. |

These checks prevent misrouting, duplicate execution, and competing writers. They do not verify
complete history or tool-result content integrity. See the [Native update protocol](native-tool-protocol.md#user-updates-during-tool-work)
for delivery, acknowledgement, and final-answer admission.

### Checkpoint selection and one-time continuation

The committed checkpoint is the source of recovery, not the ordinary-mode summary cache. Exact
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
recovery. An accepted handoff with unconfirmed physical settlement is not a successful checkpoint.
Automatic can generate a tool-free summary on a new page for an uncommitted lost compaction after
the old writer and delivered tools settle. If a complete valid handoff body is already available,
commit it once instead of generating another summary. A successful commit only replays its own
result; a missing replay body does not authorize regeneration. A logical checkpoint committed
without a live page is initialized by its subsequent ordinary continuation. Zero Risk retains its
manual handoff boundary after an ended response.

## Retention and recovery evidence

A healthy ready page has a 24-hour idle limit measured from successful ordinary work or a
committed checkpoint. Queries, heartbeats, and final-answer replay do not extend this time.
Active-tool leases, cancellation, helper failure, remote idle, and explicit task deadlines keep
their existing rules. The five-page limit remains; a sixth task cannot evict a healthy continuity
page. Expiry ends the old page lease, but does not permanently deny the thread's recovery eligibility.

A page being closed still occupies a page slot until its physical document is confirmed destroyed.
Removing a tab or acknowledging a close request does not prove writer retirement. Queries and
concurrent retirement retries must retain the same closing-page evidence; a successor page waits
for verified destruction. A late destruction event can settle only that page's original identity.

An explicit stop, closing a running page, or leaving the policy records stopped work. Its retries
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
restart, a missing transaction requires proof that the old instance retired and the current host
has no surviving writer for that thread. Missing memory alone does not authorize another Send.

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
The bridge does not reconstruct missing history from a chat URL or a digest. The complete compiled
recovery input, including its controls and current tool authority, must fit every original model,
attachment, and HTTP limit. There is no multipart recovery upload or silent trimming.

Setup/upgrade preserves the installation and existing registrations. Old v1 entries lack send,
call, and stop evidence and are legacy-unproven; they cannot be treated as never executed.
Missing or corrupt initialized storage fails closed and is not automatically reset. Recovery
requires compatible runtime/helper/Launcher features, including `session-continuity-recovery-v3`.
An older component is rejected before taking the recovery start path. Deleting the registry is not supported.

## Why these boundaries exist

The September 2026 choices established retained-page behavior. The October 2026 recovery design
permits a new page when the original cannot continue and admission evidence is sufficient.
Conversation identity and tool authority remain separate.

| Decision | Reason and consequence |
| --- | --- |
| Keep the original page through necessary compaction | Reduce interruptions without treating every summary as migration. A lost page can continue from current context after writer retirement and tool settlement. |
| Stop completed Zero Risk responses at manual handoff | Preserve the existing human-send boundary instead of adding an automatic second message or a new manual-compaction product flow. |
| Use finite 1,000,000 / 900,000 history budgets and 24-hour retention | Support longer work and a return within a day, while accepting increased local memory/page use. This is not a claim about ChatGPT memory or unlimited upstream context. Lower explicit client limits still apply. |
| Treat first explicit alias selection as the mode's start | A client history cannot prove that a thread never ran. First creation and later recovery accept only actual request context within input limits; existing registration is not proof of an empty thread. |
| Use a separate `chatgpt-web-continuity/` prefix | Preserve ordinary model names and make policy ownership explicit throughout routing, filtering, and export. |
| Validate current work, not all completed client history | The client is trusted; serialization changes should not invalidate legitimate new work. Edited old history is not backfilled into a healthy page, but can enter a new recovery page; required accepted results remain protected and unobserved external execution is not detected by full-history comparison. Local authority and idempotency remain required. |

Revisit the affected decision when adding different resources, Luna, or a new Zero Risk compaction flow. Do not implement those changes by silently extending old tokens,
replaying side effects, or weakening source proof.

## Stop reasons and manual handoff

| Error | Meaning and next action |
| --- | --- |
| `continuity_session_lost` | The original page cannot continue. Recovery requires settled execution and valid current context; clear is not a general remedy. |
| `continuity_unverified` | The original page could not be inspected. Retry the bounded coordination after restoring the connection; do not send in a second page yet. |
| `continuity_execution_unsettled` | Old writer or delivered tools are unresolved. Supply real settlement evidence; do not rerun the tools. |
| `continuity_context_missing` / `continuity_result_conflict` | Required current context or real results are missing or conflict with their first accepted digest. Correct the evidence before retrying. |
| `continuity_replay_unavailable` | Work completed, but its body is unavailable. It cannot run again. |
| `continuity_legacy_unproven` | The older registration lacks complete recovery evidence. Its previous execution must be proved settled. |
| `continuity_stopped` | This instruction was stopped. Only a distinct new user instruction may start new work. |
| `continuity_retry_exhausted` | This logical work reached its bounded recovery-attempt budget. Changing page generation does not reset it. |
| `continuity_source_unproven` | The source, revision, or current page writer cannot be proved. Do not fabricate a summary or replay tools to recover ownership. |
| `continuity_manual_handoff_required` | Zero Risk ended before checkpoint control was delivered. Keep the accepted answer and tool results; any next task is a user-controlled handoff. |
| `continuity_configuration_conflict` | Configuration, registration storage, or component versions are incompatible. Check the specific diagnostic; changing settings does not restore a lost owner. |
| `continuity_input_limit` | The actual next prompt is too large. Reduce the new input; this policy does not increase the single-input limit. |
| `continuity_resource_capacity` | Page or state capacity is full. Existing protected tasks were not evicted. Page capacity can be released by explicitly closing an unneeded task. |

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
