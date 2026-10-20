# Context navigation

Full/MCP tasks can provide a source directory instead of repeating large source text in
each browser input. Ordinary Automatic and Zero Risk tasks can use `context-bootstrap-v1`
when the complete input exceeds the composer text budget. Images use MCP first and use the existing
attachment path only when necessary.
This applies to Automatic and Zero Risk. Browser-only and upstream API forwarding keep their
existing paths. Local API Key authentication does not exclude a request that uses Web Full/MCP.
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
pre-navigation schema, follow the original migration above. The still-unreleased context-rendering,
text-read-v2, and short-start update keeps `Codex Native5`, `Codex Native5 DEV`, `Codex Zero Risk4`, and current
non-retired custom names. Refresh or reconnect that same connector if its current contract is
incompatible. If the client cannot update or consume v2, stop v2 use and report the missing
capability. This update does not introduce another connector name. A local name change uses
transactional setup and requires the necessary configuration steps for that identity. It does not
rename a remote plugin or change a custom name automatically.

The selected connector must support `codex_context_list`, `codex_context_read`, and
`codex_context_search`, with exactly one ordinary mode credential or `compaction_token` in each
input schema. Existing `operation_id`, `task_revision`, `codex_tool_wait`, and
`codex_task_update_ack` contracts still apply. Current Broker and Helper protocol, credential,
source, budget, delivery, and commit checks remain at the execution boundary. An installed local
schema does not prove the platform's remote cached schema or guarantee a later call.

Complete setup after saving the required credentials and completing the connection and mode-specific
runtime and directory steps. **Verify runtime** is optional and is also available for troubleshooting.
A missing, failed, unreadable, old, or mismatched diagnostic record does not block normal tasks,
navigation, compaction, or recovery, change their input plans, or start automatic test calls.
A compatible upgrade or runtime-file change alone does not require setup or diagnosis again.
Diagnostic failure, cancellation, timeout, or refusal during active work does not clear completed
setup. A successful diagnosis does not replace the required configuration steps or current checks.

When requested, **Verify runtime** checks the installed schema and uses a fixed small text source
for list, search, and read with each credential: six successful supported-transport returns.
Evidence version 2 requires both text reads' actual v2 shape, matching metadata, body index,
UTF-8 range, and result digest. Preparing a result, a stale Boolean receipt, or a written model
claim is not evidence. The private diagnostic scope cannot execute business tools, inventory,
waits, completion, or compaction submission. Automatic opens reads after real prompt submission.
Zero Risk keeps the user's plugin choice, manual Send, original start, and configured Sent policy.
It never sends the manual prompt automatically. Failure and cancellation release only the
resources owned by that diagnosis.

The owner-only result is bound to runtime profile and home, interaction mode, exact plugin name,
selected tunnel, runtime command, text-read format, and installed contract digest, including tool
descriptions and any output schema. A binding mismatch makes a result inapplicable for diagnostic
comparison only. There is no time-based expiry. A diagnostic retry can clear that mode's old result;
it does not clear another mode's result or affect business admission. These calls prove shape and
callability at the time of the check, not model body use, raw cached schema, image interpretation,
or continued model reliability. Retired identities remain rejected without fallback.
The CLI equivalent is `codex-chatgpt-web verify-context`; isolated DEV uses
`codex-chatgpt-web verify-context --dev-profile`.

## Sources and browser input

Each new physical send captures the actual legal sources in one fixed snapshot. The directory
contains message text, tool arguments, tool-result text, and individual images. It preserves source
roles, order, original representations, and known completeness. Tool calls and results are paired
only by a unique call ID. A recorded result is evidence that a result exists, not evidence of
business success. Labels, snippets, digests, and references are not complete sources.

The unified task mechanism selects a legal full or retained-suffix input first. Within that
candidate, the legacy navigation path replaces only eligible tool-history arguments and results
with references. A field
must offer at least 1 KiB of potential encoded-byte savings in its selected presentation. The planner
then compares complete inline and externalized candidates in their best available presentation.
Each candidate must fit the context window, browser message limits, and required navigation limits.
For legacy candidates within the composer text budget, when a valid inline candidate is available, externalization must reduce the total required token estimate, including protocol instructions,
references, directory discovery, required media, and error reserves. If it has no benefit or cannot
fit, the planner keeps that inline candidate. If inline cannot fit, a valid externalized candidate
can be used. Required history navigation remains present in
both candidates. System, developer, user, skill, delegation,
summary, and assistant prose retain their existing delivery contract. The canonical request and
the real tool results used for settlement remain intact. This feature generates no intermediate
summary and does not silently trim an oversized request.

A new navigation entry is also required when the legal snapshot contains readable tool history or
fixed images that the selected retained input omits. The current credential,
`context_id`, and first list call then appear in the actual input, even if that entry adds bytes.
The directory can expose those legal historical sources without sending the full history again.
It cannot recover sources that the current request and existing authorized restoration do not hold.
Small inputs with no navigation need keep the original path.

### Browser context presentation

The compiler compares `legacy-json` with `codex-context-text-v1` after the existing message mapping,
attachment projection, and retired-handle cleanup. Both represent the same delivered JSON value
tree, including field presence, null, false, empty strings, roles, block order, and call metadata.
It does not restore information lost by an earlier mapping. API Key messages and live business-tool
results keep their existing formats.

The text format has a versioned JSON header and ordered system/message records. Each record retains
compact JSON for its structure. A `raw_fields` descriptor binds a null placeholder at an existing
own-property path to a following text block, using an exact UTF-8 byte length. Only system/content
strings, text/thinking-summary strings, and existing freeform argument strings can be extracted.
Argument objects, image/skill descriptors, and unknown fields stay structured. Original null values
without descriptors remain null. The persistent byte contract is in [Context rendering](context-rendering.md).

The default raw-string policy is conservative: CR, NUL, other control characters, isolated surrogates,
LF, tabs, and trailing whitespace remain JSON. LF, tabs, or trailing whitespace can be admitted only
by a trusted internal policy with actual evidence for the Automatic or Zero Risk input path. A
local encoder/decoder test alone does not enable them. MCP strings do not have this editor restriction.

When both complete candidates fit, auto selection uses the mixed format only with strictly fewer
estimated input tokens and no increase in JSON-encoded transport bytes. Protocol instructions,
dynamic fences, navigation, attachments, multipart stages, the final commit, and ACKs count in the
comparison. No-benefit inputs keep JSON. Preparation verifies exact decoding; retries keep the
selected format, boundaries, bytes, hash, and plan. Unknown Send or post-send corruption never
triggers an automatic format switch or resend.

Two- and six-part inputs partition complete records in one format. A raw field never spans parts.
Manifests and ACKs refer to the actual fixed payload bytes. The coverage journal records the selected
`contextFormat` with the body digest and costs; older records without it mean `legacy-json`.

## Short startup and required text

The short-start plan captures the complete selected task and generated execution protocol as required
sources. It preserves the selected value tree, source identity, roles, order, empty values, unknown
structure, and known completeness. It does not infer authority from body markers such as
`role:developer` or `AGENTS.md`. The guarantee starts after existing normalization, attachment
projection, and retired-handle cleanup. It does not restore data that those steps already removed.

Automatic starts with `codex_context_list` using `turn_token`, `context_id`, and `view: "overview"`
after actual prompt submission. It does not call `codex_turn_start`. Zero Risk starts with
`codex_turn_start` using `request_id`; the existing `started` and `duplicate` reply also contains
`context_bootstrap`. A duplicate start keeps the same immutable manifest and current coverage.
When configured Sent confirmation is pending, `read_state: "waiting"` identifies the original
manual step. Waiting does not consume the read allowance and is not an instruction to poll reads.
Manual Send, Sent policy, and image confirmation remain separate.

The overview identifies `startup_protocol: "context-bootstrap-v1"`, `manifest_version: 1`,
`context_id`, `plan_id`, `manifest_digest`, current revision and acknowledged revision, readiness
and the next required read. `required_targets` contains a bounded first page and its continuation.
Each target retains source location, role/origin/scope, UTF-8 size, digest, completeness, delivery
route and read reference.
`codex_context_list(view: "entries", required_only: true)` pages through required entries with the
returned cursor. The default filter remains false. Each response, including its wrapper, fits the
list limits of 20 targets, 12 KiB and 1,500 estimated tokens. Labels and previews are not body text.
`next_required_read` first selects undelivered required MCP images, then the first missing text
range in source order. Read arguments still need the current mode credential.

A current user request that fits is retained exactly inline with its original identity. Otherwise,
the whole accepted request or ordered message group becomes required text. It is never replaced
by a summary, keyword-selected fragment, or truncated tail. Required rules and skill catalogs must
be delivered before task work. Existing skill paths and relative-reference bases remain valid.

`text_ready` requires successful supported-transport receipts matching pending v2 pages. Only their
UTF-8 range union counts; every required source must cover `[0, utf8_bytes)`. Empty sources require
an actual empty-body receipt. Duplicate or overlapping pages add only new coverage, but each return
consumes budget. Failed, malformed, cross-source, expired, revoked or cross-scope receipts add no
coverage. Preparing a reply, a search hit, a digest or a claim of reading does not count.
`images_ready` stays independent; `context_ready` requires both. Text returns do not extend image
deadlines. Readiness proves delivery to the supported transport, not model understanding.

New business calls, business inventory and successful completion are checked atomically against
readiness and existing authority, generation, revision, ACK, result and output fences. This includes
Automatic direct answers and Zero Risk `codex_turn_complete`. Missing context returns
`CONTEXT_NOT_READY` with bounded recovery details. A rejected operation ID retains its rejection;
new work after recovery needs a new ID. Existing wait, replay, settlement, ACK, cancellation and
other control paths retain their original permissions. They do not grant new business authority.
ChatGPT-owned tools must also wait under the prompt rules; the connector cannot intercept them.

The fixed short entry, including credentials and wrappers but excluding the inline request, is at
most 3,000 Unicode code points. AppConfig accepts optional `maxComposerCodePoints`,
`automaticMaxComposerCodePoints` and `zeroRiskMaxComposerCodePoints`. Values must be positive safe
integers. The mode override takes priority over the common value, then the default of 8,000.
The provider's `chatgptWeb` options receive only the effective valid `maxComposerCodePoints`.
The complete final text is measured after rendering and escaping; UTF-16 length is recorded
separately. The default is an engineering limit, not a measured platform attachment threshold.

Plans reserve all required text pages, manifest discovery, startup and result wrappers, cursors,
required images, corrective replies, retained context and working capacity. On-demand reads cannot
spend the protected remaining required-source allowance. Repeats count again. A plan that exceeds
the composer limit cannot win because it uses fewer tokens; a valid short plan can cost more total
tokens. If no complete plan fits, preparation fails before Send with the limiting budget or missing
capability. It does not summarize, truncate, switch model, attach text or automatically resend.
Each actual composer message in existing multipart delivery also has this text limit.

The short entry gives the first call, v2 body selection, trust boundary and pre-work gate. Detailed
role, execution, wait, error, output and applicable update/image/attachment/continuity rules are in
the required execution protocol. Server instructions and tool descriptions retain their own short
parameter and recovery rules. Conditional rules use trusted plan state. Current errors select error
recovery; historical error strings do not. Pending and lost receipts keep the original ID. Only an
unexplained platform safety-check rejection permits at most three recovery attempts per affected
step; uncertain writes must first be checked. Permission denials retain the original approval rules.
Strict output values and the result/ACK/final-output order remain unchanged. Rich cards also need
ordinary Markdown results that Codex can receive; their DOM markup is not final-answer content
unless requested. Ordinary tasks recognize trusted compaction handoff, whose full control rules
are supplied only on that path. Multipart stage/commit/ACK rules remain inline while stage sources
are unavailable; they bind fixed bytes and do not execute task work before final commit. A resume
entry states the remaining startup and ACK conditions rather than claiming the context is complete.

Local checks require the current bootstrap and v2 contracts, not historical diagnostic success.
They cannot prove adoption of the new schema in ChatGPT's remote cache. Refresh or reconnect the
current compatible connector when needed. A known pre-send incompatibility allows only a complete
legacy plan that fits every budget; post-send incompatibility stops the request without a new Send.
The real editor, remote schema and model tail-page acceptance remain pending; see
[short-start validation](release-validation.md#short-start-context-validation).

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
A direct read does not require listing the full directory first. Legacy and on-demand text have
no mandatory reading count or coverage threshold. Short-start required text uses the gate above. Read an earlier result before deciding to repeat its operation.

Successful text pages use `format: "context-text-read-v2"`. `structuredContent` contains metadata
only; `content[0].text` is JSON for the same metadata; `content[1].text` is the one exact body.
Metadata includes `body_content_index: 1`. Consumers select that block using the version and index,
not by concatenating text blocks. The body is never moved to `_meta` or copied into metadata.
An empty source still returns the second text block with an empty string. The body byte length is
`range.end_exclusive - range.start`; `utf8_bytes` remains the complete source length. Unknown
versions, missing blocks, wrong indices, inconsistent metadata, and wrong lengths are errors.

Page sizing accounts for the complete v2 response. The core body, range, and next cursor remain
stable for the same source/scope retry; compaction's remaining-budget hints can change. Strings
are not trimmed, reparsed, normalized, or unescaped. Images, list, search, and errors retain their
existing result forms. New scopes require v2 and do not silently accept an older text result.

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

`images_ready` requires delivery of every required image. Short startup also requires all required
text before `context_ready` becomes true. MCP delivery uses the supported return
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

The control entry must actually be delivered before reads open. Current-page owner, generation,
revision, ACK, Send, real-result settlement, and checkpoint checks still apply. A healthy retained
source does not need to fit all source bytes into a new browser input or all reads into the cumulative
allowance. Fresh-page recovery checks complete legal sources independently from the actual selected plan;
unsent full-source compilation is not a browser-window admission gate. Ordinary recovery, committed
checkpoint continuation, and uncommitted compaction all use this separation. The new plan includes
current effective instructions and rechecks required images from zero page coverage. An ended
Zero Risk response still requires manual handoff; navigation does not create a second
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
wrappers, an 8,192-token platform reserve, and a 4,096-token work reserve. Navigation also reserves
the measured directory overview and useful entries pages, plus the protected error reserve.
Discovery includes all pages needed to find required image references and the largest useful
single-target page, with bounded cursor costs. Each image uses a conservative visual reserve of 4,096 tokens,
or 8,192 for original detail. These reserves are estimates, not observed vision usage or billing.
Compaction deducts its instruction and a 4,096-token entry reserve from available page capacity,
caps the shared allowance at 96,000 tokens, and reserves 8,192 of that allowance for summary and
submission. Unread sources need not all fit within the remaining reading allowance.

Wire measurement includes the complete result's content, structured content, JSON escaping,
cursors, base64, and framing reserve. Text-token estimation excludes image base64 and counts visual
reserves separately. Repeated reads and retries count again. A shorter prompt alone does not prove
lower total delivery cost; directory, search, read, retry, and image costs must also be measured.
The hard text budget still serializes the complete result without image base64 and adds the existing
reserve, including the directory-preflight cursor bound. A diagnostic estimate of model-visible
text and structured metadata is separate and cannot reduce this hard allowance. Reports distinguish
visible prompt bytes, editor length, JSON-encoded bytes, conservative tokens, and actual model input
counts; actual model counts remain unknown unless observed.
Successful pages cannot consume the protected corrective-reply pool. Errors cannot borrow required
image or compaction summary reserves. After the third corrective reply, or when no budgeted reply
can be returned, the scope stops authorizing source queries. Further queries receive a JSON-RPC
rejection. This does not close
the shared MCP transport, ordinary business authority, or the original compaction submission path.
Existing readiness and permanent-failure checks still apply; losing read permission cannot waive
undelivered required text or images, or authorize a checkpoint after permanent source failure.

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
Unknown Send state on a confirmed live page does not authorize resending. Closed or unknown-page
recovery can start a new current-request execution without resolving that old Send, but does not
automatically redispatch historical tools. Current-page journals retain bounded identity,
coverage, digest, budget, and receipt metadata, not source text, images, or read credentials.

Local contract tests do not prove cloud schema adoption, model understanding, summary quality,
exact visual token use, or stable repeated image consumption across all models. See the
[release validation checks](release-validation.md#context-navigation-validation) for the limited
live image evidence and the remaining acceptance requirements.

## Page replacement and source reconstruction

Retired or restarted snapshots do not provide a permanent original-text store. Rebuild from the
current authenticated request, legal previous-response expansion, or still-held verifiable content.
A specifically bound checkpoint may cover its earlier history, but cannot recover discarded bytes.
A digest, URL, expired reference, or result-exists record does not replace source content. For
supported closed or unknown-page recovery, revoke old project permissions and make a best effort
to cancel old work before using the current request and actual source/plan limits. Old Send,
settlement, checkpoint, or retry records do not gate the new page. Old in-flight reads cannot
contribute delivery or read proof to the successor. Physical page cleanup and its real capacity
remain independent of this permission boundary. See
[session continuity](session-continuity.md) for scope, budgets and cleanup limits.
