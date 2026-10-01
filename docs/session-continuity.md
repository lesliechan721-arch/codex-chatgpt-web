# Session continuity first

Compatible Full Native tools + Launcher environments expose the opt-in
`chatgpt-web-continuity/` model aliases without
an additional internal verification flag. Existing `chatgpt-web/` models keep their current behavior
and remain the default. Implementation and test presence do not replace the real-platform evidence
required in [release validation](release-validation.md#session-continuity-validation).

## Intended behavior

This policy uses one new ChatGPT conversation for a native Codex thread, then keeps that exact
conversation for later ordinary instructions and accepted compaction checkpoints. It never
adopts an older chat. The first instruction may include existing history, but the complete first
prompt must fit the original model's single-input limits before a page is created.

The policy requires Full Native tools and Launcher. It preserves the account, model, effort,
connector, and Zero Risk manual-submission requirements. Luna and Think have no continuity alias.
Fresh Conversation Per Turn and Bigger Context are incompatible with this policy.

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
Changes to old text or display metadata do not update the retained ChatGPT page. Send a new
instruction to correct the task, or use a new thread to rewrite its history. Old tool records
cannot authorize a tool or supply a result for an outstanding call.

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
own accepted instructions, issued calls, first results, and replayable output. A checkpoint commit
owns its exact source execution/revision, target revision, original page lease, summary, and
one-time transition. An index or request-local cache can refer to these records; it cannot replace
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

Result rounds use locally issued batch/call IDs and their expected result types. Identify the
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

### Checkpoint selection and one-time continuation

The committed checkpoint is the source of recovery, not the ordinary-mode summary cache. Exact
delegated proof still includes request-carried source thread/turn, item ID, content, model, and
reasoning identity. Neither the current compaction turn nor a matching summary replaces the source.
Verified mode retains only its existing legitimate mappings. Continuity never uses the recoverable
policy's fresh-browser fallback when proof fails.

| Recognized work | Result |
| --- | --- |
| Known old ordinary, result, or compaction work | Replay its own record or fail if reclaimed; do not remap it to the current revision. |
| Explicit source and committed checkpoint | Select that exact commit. Equal summaries from other sources do not decide identity. |
| Interrupted active source with an unconsumed transition | After the old writer settles, consume the transition once on the original page with a new execution/capability. Retry reuses that continuation round. |
| Completed source with a checkpoint-only request | Replay the original ordinary final answer; do not substitute the summary or rerun the instruction. |
| Explicitly new instruction | Exclude old identities/tombstones, then admit against the healthy current binding. An explicitly conflicting or stale relationship still fails. |
| Summary only, or indistinguishable source relationships | Fail before a new side effect. Do not choose the first, latest, or rightmost matching summary. |

Two source instructions in one native turn can have equal text and summaries but different item
identities and commits. A request for B selects B; a replay of A cannot write to B's later page.
The transition and continuation journal are established atomically, so a lost receipt cannot
consume the transition twice. Reclaimed source evidence cannot be reconstructed from current head.

Compaction work is bound to source execution and revision. Different local/v1/v2 wrappers do not
create another summary transaction. Deliver any valid current results first, then recheck source
generation and acquire the single-writer transaction before control delivery. A preflight that
became stale must not retire a newer owner. Once control delivery starts or is uncertain, keep the
unique failure/commit outcome rather than changing the request key to generate another summary.
An accepted handoff with unconfirmed physical settlement is not a successful checkpoint.

## Retention is not recovery

A healthy ready page has a 24-hour idle limit measured from successful ordinary work or a
committed checkpoint. Queries, heartbeats, and final-answer replay do not extend this time.
Active-tool leases, cancellation, helper failure, remote idle, and explicit task deadlines keep
their existing rules. The five-page limit remains; a sixth task cannot evict a healthy continuity
page to make room.

Closing or reloading the page, losing the owner, restarting components, or leaving the policy
does not grant permission to create a replacement for the same thread. Changing to a different
model or provider scope also cannot take over that page. Finish or explicitly cancel active work
before changing routes. A separately created native thread has its own first-use check.

The durable first-use registry stores only irreversible thread/scope indexes, owner identifiers,
and minimal state. It contains no prompts, tool results, chat URLs, or capability tokens. Its
limit is 10,000 threads or 4 MiB. It has no TTL, LRU eviction, or automatic reset. Missing, corrupt,
or full storage fails closed; deleting the registry is not a supported recovery procedure.

Checkpoint evidence is separately bounded to 256 entries, 2 MiB per entry including its retained
source evidence, and 24 MiB total. The `previous_response_id` cache still has its independent
one-hour lifetime and capacity limits. A missing response cache returns 409 even while a page
remains alive. Resending full canonical history is useful only while the exact live binding and
current revision can still be proved; it is not a fresh-page fallback.

Each execution's round journal is bounded to 512 entries; its initial ordinary replay remains
protected. Ordinary execution tombstones are bounded to 256 per binding. Reclaiming old replay
records must not close the current page or make an old identity executable again. Capacity errors
do not silently increase HTTP, cache, or memory budgets.

First-use registration occurs after input/authority prechecks but before the first page creation.
Concurrent first requests share one creation right. Registration initialization is distinguished
from a missing file in an already-initialized installation. Registration does not expire with page
or response caches. Only an explicit reset of the whole bridge configuration removes it; that
ends its continuity tasks and requires new native threads, not recovery of old ones.

## Why these boundaries exist

The confirmed September 2026 choices separate when compaction happens, who writes the summary,
and whether the page changes. They also separate retained conversation identity from tool authority.

| Decision | Reason and consequence |
| --- | --- |
| Keep the original page through necessary compaction | Reduce interruptions without treating every summary as migration. A lost page requires user handoff, not automatic reconstruction. |
| Stop completed Zero Risk responses at manual handoff | Preserve the existing human-send boundary instead of adding an automatic second message or a new manual-compaction product flow. |
| Use finite 1,000,000 / 900,000 history budgets and 24-hour retention | Support longer work and a return within a day, while accepting increased local memory/page use. This is not a claim about ChatGPT memory or unlimited upstream context. Lower explicit client limits still apply. |
| Treat first explicit alias selection as the mode's start | A client history cannot prove that a thread never ran. One registered creation can accept existing history within input limits, but does not adopt an old page or permit a later rebuild. |
| Use a separate `chatgpt-web-continuity/` prefix | Preserve ordinary model names and make policy ownership explicit throughout routing, filtering, and export. |
| Validate current work, not all completed client history | The client is trusted; serialization changes should not invalidate legitimate new work. The cost is that edited old history is not backfilled into the page and unobserved external execution is not detected by full-history comparison. Local authority and idempotency remain required. |

Revisit the affected decision when adding cross-restart recovery, different resources, Luna, or a
new Zero Risk compaction flow. Do not implement those changes by silently extending old tokens,
replaying side effects, or weakening source proof.

## Stop reasons and manual handoff

| Error | Meaning and next action |
| --- | --- |
| `continuity_session_lost` | The exact conversation or owner is unavailable. No replacement was created. Preserve known work and prepare a separate task. |
| `continuity_source_unproven` | The source, revision, or current page writer cannot be proved. Do not fabricate a summary or replay tools to recover ownership. |
| `continuity_manual_handoff_required` | Zero Risk ended before checkpoint control was delivered. Keep the accepted answer and tool results; any next task is a user-controlled handoff. |
| `continuity_configuration_conflict` | Configuration, registration storage, or component versions are incompatible. Check the specific diagnostic; changing settings does not restore a lost owner. |
| `continuity_input_limit` | The actual next prompt is too large. Reduce the new input; this policy does not increase the single-input limit. |
| `continuity_resource_capacity` | Page or state capacity is full. Existing protected tasks were not evicted. Page capacity can be released by explicitly closing an unneeded task. |

These failures are non-retryable by the automatic retry loop. They do not undo file changes or
already executed Native operations. Keep a handoff with the task goal, completed changes, real
tool results, current files and Git state, unresolved questions, and next action. A healthy
conversation can write a handoff file when the user requests it; the bridge does not silently
write project files or reconstruct facts after the conversation is lost.

Implementation boundaries are in [continuity binding](../src/adapters/chatgpt-web/continuity-binding.ts),
[environment/input selection](../src/adapters/chatgpt-web/environment.ts),
[execution and journals](../src/adapters/chatgpt-web/turn-execution.ts), and
[Adapter integration](../src/adapters/chatgpt-web/index.ts). The
[input](../tests/session-continuity-input.test.ts),
[state](../tests/session-continuity-state.test.ts), and
[Adapter regressions](../tests/session-continuity-adapter.test.ts) preserve those contracts.
See also the [security model](security-model.md), [Native tool protocol](native-tool-protocol.md),
and [release evidence](release-validation.md#recorded-continuity-evidence).
