# Context navigation

Full/MCP tasks can provide a source directory instead of repeating large tool-history fields in
each browser input. Images use MCP first and use the existing attachment path only when necessary.
This applies to Automatic and Zero Risk. Browser-only and API Key routes keep their existing paths.
The feature's complete release validation is still pending; the
[validation record](release-validation.md#context-navigation-validation) defines the tested scope.

## Connector setup

The current public MCP identities are `Codex Native5` for Automatic, `Codex Native5 DEV` for the
isolated DEV profile, and `Codex Zero Risk4` for Zero Risk. The three context tools and their
compaction credential branches require this ABI.

Keep `Codex Native4`, `Codex Native4 DEV`, and `Codex Zero Risk3` unchanged. Create the corresponding
new plugin with the current name, the existing Tunnel URL, **Authentication: None**, and
**Allow all actions**. Never rename or refresh an old plugin to obtain the new schema. Earlier
retired defaults remain retired. Production and DEV plugins can remain installed together.

Setup preserves custom names that are not retired defaults. If a custom plugin caches the old
schema, choose a new name and create a new plugin. A local name change uses transactional setup and
clears verification after success. An old setup marker or a mismatched saved identity also clears
verification; it does not rename a remote plugin or change a custom name automatically.

Verify the selected identity before a new Full task. The installed MCP tool list must include
`codex_context_list`, `codex_context_read`, and `codex_context_search`, with exactly one ordinary
mode credential or `compaction_token` in each input schema. Existing `operation_id`, `task_revision`,
`codex_tool_wait`, and `codex_task_update_ack` contracts still apply. **Verify runtime** then uses a
fixed small text source to require list, search, and read with each credential, for six successful
supported-transport returns. A written model claim is not evidence. The private verification scope
cannot execute business tools, inventory, waits, completion, or compaction submission. Automatic
opens reads after real prompt submission. Zero Risk keeps the user's plugin choice, manual Send,
original start, and configured Sent policy. It never sends the manual prompt automatically.

The owner-only result is bound to the runtime profile and home, interaction mode, exact plugin name,
selected tunnel, runtime command, and installed schema digest. A binding change, missing result, or
failed six-call retry requires verification again. There is no time-based validity period. The setup
marker records UI flow only. Local health and `tools/list` alone cannot authorize navigation;
ordinary unmodified inline input needs no navigation result. The gate runs before publishing a
projected directory and before admitting compaction. These calls prove callability, not a raw copy
of the platform's cached schema, image interpretation, or model stability. Retired identities are
rejected without fallback. The CLI equivalent is `codex-chatgpt-web verify-context`; isolated DEV
uses `codex-chatgpt-web verify-context --dev-profile`.

## Sources and browser input

Each new physical send captures the actual legal sources in one fixed snapshot. The directory
contains message text, tool arguments, tool-result text, and individual images. It preserves source
roles, order, original representations, and known completeness. Tool calls and results are paired
only by a unique call ID. A recorded result is evidence that a result exists, not evidence of
business success. Labels, snippets, digests, and references are not complete sources.

The existing full, retained-suffix, or continuity input selection happens first. Within that
candidate, only eligible tool-history arguments and results can be replaced by references. A field
must offer at least 1 KiB of potential serialized-byte savings, and the complete projected prompt
must be smaller after protocol and reference overhead. System, developer, user, skill, delegation,
summary, and assistant prose retain their existing delivery contract. The canonical request and
the real tool results used for settlement remain intact. This feature generates no intermediate
summary and does not silently trim an oversized request.

A new navigation entry is also required when the legal snapshot contains readable tool history or
fixed images that the selected retained or continuity input omits. The current credential,
`context_id`, and first list call then appear in the actual input, even if that entry adds bytes.
The directory can expose those legal historical sources without sending the full history again.
It cannot recover sources that the current request and existing authorized restoration do not hold.
Small inputs with no navigation need keep the original path.

## Read-only tools

All three tools require `context_id` and exactly one credential: Automatic uses `turn_token`,
Zero Risk uses `request_id`, and compaction source reads use `compaction_token`. Credentials,
references, and cursors are bound to their active scope. A context ID is not a credential.
These tools allocate no `operation_id`, execute no historical action, and acknowledge no task update.

| Tool | Input and result |
| --- | --- |
| `codex_context_list` | `view: "overview"` returns bounded source counts and current readiness. `view: "entries"` returns a page of source targets; use its cursor for the next page. |
| `codex_context_read` | `read_ref` returns one exact text page or one complete image. Text pages can use a cursor. |
| `codex_context_search` | A nonempty `query` returns bounded literal matches and snippets. A match's `read_cursor` opens the corresponding text; the search pagination cursor cannot be used for read. |

List and search accept `kind`, exact base `tool_name`, `namespace`, `call_id`, and a one-based
`source_range: {start, end_exclusive}`. Combined filters intersect. An omitted namespace accepts
all namespaces; `null` accepts only sources without one. Search can also select a text `read_ref`.
It is case-sensitive literal search, with no regular expressions, OCR, or semantic search.

Text reads report UTF-8 byte ranges `[start, end_exclusive)`. Successive pages reconstruct the saved
representation exactly and never split a character. Object and array inputs use a declared
deterministic JSON representation; string and freeform inputs retain their characters. Source
completeness remains `complete`, `truncated`, or `unknown` according to the supplied source evidence.
A direct read does not require listing the full directory first. Ordinary text has no mandatory
reading count or coverage threshold. Read an earlier result before deciding to repeat its operation.

## Images and confirmation

Each image target uses fixed PNG, JPEG, GIF, or WebP bytes from the request or an existing authorized
source. The navigator does not fetch arbitrary URLs, open local paths, or turn a file ID into a
claimed image. It does not resize, crop, or perform OCR.

An image that fits the local MCP budgets uses one inline MCP image block and consumes no composer
attachment slot. Its structured metadata does not duplicate the base64 bytes. One read returns
one complete image; images are not byte-paginated, and a resource link is not counted as image
delivery. Repeated reads of the same reference return the same image and consume budget again.

If MCP delivery cannot be planned, the runtime checks the existing supported attachment path and
its independent limits. A required image that fits neither route fails before Send. An optional
historical image can be marked unavailable with a reason. Routes are fixed when published: a
failure after Send does not change that plan to attachments or send a supplemental browser message.

Images from requirement sources in the selected input are required for that send. Assistant and
tool-history images are normally on demand. Historical images excluded by a valid retained or
continuity boundary do not become required merely because the directory still exposes them.

`context_ready` requires delivery of every required image. MCP delivery uses the supported return
receipt; Automatic attachments use upload evidence. In Zero Risk, the Launcher lists only the
required fallback images. Attach all listed images to that ChatGPT turn and explicitly confirm the
list. That confirmation records your statement (`user_attested`); the Launcher does not inspect
the attachments. It is bound to the request, selected plan, and manifest version.

Sent, connector start, and image confirmation are separate facts. Disabling Sent confirmation
does not remove fallback-image confirmation. A plan containing only MCP images has no attachment
confirmation step. A mixed plan can start and read MCP images while attachment confirmation is
still pending.

Until ready, new bridge business tools, business inventory, and successful completion are blocked
with `CONTEXT_NOT_READY`. Existing operation waits, result replay and settlement, context reads,
and task-update ACKs retain their permissions. A deterministically rejected business start keeps
its rejection; use a new `operation_id` after correcting readiness. ChatGPT-owned web or research
tools have no equivalent server interception point. The prompt requires image delivery before
using them, but this is not a programmatic block or proof that the model understood an image.
With no required images, the plan is ready from the start and has no image-readiness timer.

## Compaction sources

Compaction keeps its summary task and existing checkpoint submission path. When navigation is
needed, a separate fixed snapshot provides the complete legal source range, including its current
checkpoint and later history. The initial control carries a bounded overview and read entry,
rather than all source bodies. The model chooses what to list, search, or read. It may submit
without reading every target, every image, or any source; there is no minimum coverage gate.

The independent `compaction_token` permits only the three context tools. It grants no business
tool, inventory, start, ACK, completion, or checkpoint-submission permission. The original handoff
or completion credential remains necessary to submit. Ordinary credentials cannot read the
compaction snapshot, and submission credentials cannot substitute for the read credential.
Historical instructions are summary evidence, not new work to execute.

The control entry must actually be delivered before reads open. Existing owner, generation,
revision, ACK, Send, real-result settlement, and checkpoint checks still apply. A healthy retained
source does not need to fit all source bytes into a new browser input or all reads into the cumulative
allowance. Existing fresh-page and recovery full-input admission checks remain in force. An ended
Zero Risk continuity response still requires manual handoff; navigation does not create a second
automatic prompt.

Sources must remain real and individually readable. Missing source bytes fail before control
delivery. A permanent read failure, cancellation, expiry, or revoked source prevents successful
checkpoint submission. Correctable argument, cursor, and remaining-budget errors allow the model
to stop reading and submit a supported summary. In-flight reads must settle before submission.
Neither source failure nor missing evidence permits rerunning business tools to reconstruct history.

## Effective local budgets

These are runtime ceilings, not measured ChatGPT limits or a promise of more image capacity.
The selected model's existing context and composer budgets can impose smaller effective allowances.

| Return | Maximum items | Complete response bytes | Estimated text tokens |
| --- | --- | --- | --- |
| List | 20 targets | 12 KiB | 1,500 |
| Search | 10 hits | 12 KiB | 1,500 |
| Text read | One target page | 24 KiB | 2,500 |
| Image read | One complete image | 4 MiB raw; 6 MiB wire | 1,500 metadata tokens, plus visual reserve |

| Shared limit | Effective value |
| --- | --- |
| Snapshot source storage | 32 MiB |
| Cumulative navigation wire / estimated tokens | 64 MiB / 96,000 tokens, including the corrective-reply reserve |
| Image returns / cumulative raw image bytes | 64 / 32 MiB |
| Query / context arguments after credential removal | 512 UTF-8 bytes / 8 KiB |
| Navigation entry JSON / label / search snippet | 8 KiB / 120 characters / 160 characters |
| Response framing / token reserve | 128 bytes / 32 tokens per return |
| Corrective replies | 3 at up to 512 wire bytes and 128 tokens each; protected reserve of 1,536 bytes / 384 tokens |
| Active navigation processing | 2 seconds per call; 20 seconds cumulative |

The fallback attachment planner retains limits of 10 attachment slots, 20,000,000 bytes per image,
and 50,000,000 bytes total, including reserved skill attachments. These are local checks, not a
measurement of the account's current composer allowance. Only actual attachments consume slots.

Ordinary planning includes the selected prompt, retained-page estimate, required images, return
wrappers, an 8,192-token platform reserve, a 4,096-token work reserve, and a 512-token discovery
reserve when navigation is used. Each image uses a conservative visual reserve of 4,096 tokens,
or 8,192 for original detail. These reserves are estimates, not observed vision usage or billing.
Compaction deducts its instruction and a 4,096-token entry reserve from available page capacity,
caps the shared allowance at 96,000 tokens, and reserves 8,192 of that allowance for summary and
submission. Unread sources need not all fit within the remaining reading allowance.

Wire measurement includes the complete result's content, structured content, JSON escaping,
cursors, base64, and framing reserve. Text-token estimation excludes image base64 and counts visual
reserves separately. Repeated reads and retries count again. A shorter prompt alone does not prove
lower total delivery cost; directory, search, read, retry, and image costs must also be measured.
Successful pages cannot consume the protected corrective-reply pool. Errors cannot borrow required
image or compaction summary reserves. After the third corrective reply, or when no budgeted reply
can be returned, the scope stops authorizing source queries. Further queries receive a JSON-RPC
rejection. This does not close
the shared MCP transport, ordinary business authority, or the original compaction submission path.
Existing readiness and permanent-failure checks still apply; losing read permission cannot waive
an undelivered required image or authorize a checkpoint after permanent source failure.

Required MCP images have a 120-second readiness deadline and a 45-second no-progress deadline,
starting when the selected entry is delivered and the original start/Sent conditions allow reading.
Only a newly delivered required image advances progress. Required fallback confirmation has its
own five-minute deadline from presentation of the selected list. An in-flight MCP return has a
90-second settlement deadline. Compaction retains its existing finite control deadline, at most
five minutes; reads do not restart it. Processing budgets exclude human waiting and idle time
between authorized calls. Once images are ready, navigation adds no overall business-task timeout.
Existing task deadlines, Native leases, cancellation, and owner-liveness rules still apply.

## Lifetime and validation limits

Snapshots are active-task data, not a permanent history store. New access stops on completion,
cancellation, retirement, or expiry, and in-flight returns recheck revocation. Restart invalidates
old context IDs, references, cursors, and read credentials. A legal recovery must obtain and verify
actual sources before creating new references; digests and old chat URLs cannot restore content.
Unknown Send state does not authorize resending. Recovery journals retain bounded identity,
coverage, digest, budget, and receipt metadata, not source text, images, or read credentials.

Local contract tests do not prove cloud schema adoption, model understanding, summary quality,
exact visual token use, or stable repeated image consumption across all models. See the
[release validation checks](release-validation.md#context-navigation-validation) for the limited
live image evidence and the remaining acceptance requirements.
