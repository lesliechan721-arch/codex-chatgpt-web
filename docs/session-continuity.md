# Session continuity first

Status on 2026-09-28: the implementation and automated tests are present. Compatible Full Native
tools + Launcher environments expose the six opt-in `chatgpt-web-continuity/` model aliases without
an additional internal verification flag. Existing `chatgpt-web/` models keep their current behavior
and remain the default.

## Intended behavior

This policy uses one new ChatGPT conversation for a native Codex thread, then keeps that exact
conversation for later ordinary instructions and accepted compaction checkpoints. It never
adopts an older chat. The first instruction may include existing history, but the complete first
prompt must fit the original model's single-input limits before a page is created.

The policy requires Full Native tools and Launcher. It preserves the account, model, effort,
connector, and Zero Risk manual-submission requirements. Luna and Think have no continuity alias.
Fresh Conversation Per Turn and Bigger Context are incompatible with this policy.

The candidate catalog advertises a 1,000,000-token execution history window and a 900,000-token
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

The minimal-validation implementation has local automated coverage. Its current independent
review status is recorded in the [design attachment](dev/session-continuity/minimal-validation.md).
The real Codex → ChatGPT ordinary/tool-result/compact/continue path and lost-response retries
remain unverified for this change; local fixtures do not certify that path.

Zero Risk remains manual. An active response can return a checkpoint only through its existing
MCP control path. When that response finishes before the control instruction is delivered, the
bridge returns `continuity_manual_handoff_required`. It preserves the accepted answer and real
tool results, and does not copy or send a second prompt. The user must control any handoff.

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

See the [implementation spec](dev/session-continuity/spec.md), the
[P0 evidence](dev/session-continuity/p0-work.md), and the
