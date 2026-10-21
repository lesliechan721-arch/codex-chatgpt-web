# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Dependency audits

The root and Launcher audits run without advisory exclusions. Both audits must pass
before release validation proceeds. The Launcher pins `http-cache-semantics` to 4.3.0;
the previous 4.2.0 advisory exclusion has been removed.

When changing build dependencies or download configuration, check the resolved lockfile
and run both audits. Do not force `@electron/get` 5.x over the builder's 3.x requirement:
its download options and proxy API differ, so that migration requires packaging validation
on all three platforms.

## Preview releases and updater visibility

Use GitHub's **Set as a pre-release** flag for public test builds. They remain downloadable from
Releases but are excluded from `/releases/latest`, the endpoint used by both existing launchers
and the installer. A draft is private; a pre-release is the public testing option. No separate
launcher update channel or custom release-body flag is required.

After validation, uncheck **Set as a pre-release** and select **Set as latest release**, or publish
a newer stable release. Launchers discover it on their next startup update check, provided its
version is newer and its platform asset and checksums are present. Already running launchers
do not poll for publication changes.

This fork's installers and launcher updater use releases from
`lesliechan721-arch/codex-chatgpt-web`. Numeric suffixes are stable fork revisions:
`6.1.7-1` follows `6.1.7`, `6.1.7-2` follows `6.1.7-1`, `6.1.7-3` follows `6.1.7-2`, `6.1.7-4` follows `6.1.7-3`, and `6.1.7-5` follows `6.1.7-4`.
Version `6.1.12-2` integrates upstream `6.1.12` with this fork's continuity, durable input queue,
short-start context, API access, provider, proxy, and remote-runtime contracts. New configurations
and configurations without `useSavedChats` save chats by default; explicit choices are preserved.
Connector verification uses the selected saved or temporary chat mode. The service, Launcher, installer, and download
metadata use the same version. Next-message suggestions are available as an explicit opt-in;
new installations and existing configurations without this setting leave them disabled.
The tag workflow marks tags containing `beta` as pre-releases automatically and preserves an
existing release's pre-release flag when rerun. Other preview builds must have that flag set
explicitly before publication. Named version suffixes retain preview ordering below the base release.
Use a new version for changed binaries; toggling publication flags promotes the existing build.
Do not publish a stable tag and only mark it as a pre-release afterwards: an older launcher could
offer it during that interval. To keep a final version out of the updater during testing,
prepare a draft release with **Set as a pre-release** checked before pushing its tag.
The workflow publishes it with that flag preserved.

GitHub documents this contract in [Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or private task prompt contents.
For controlled synthetic fixtures, retain only the fixture input and output needed to assess the
result, with credentials redacted.

For `6.1.10-3`, Native protocol compatibility targets
[Codex `0.163.0`](https://github.com/openai/codex/releases/tag/rust-v0.163.0).
Run `bun run smoke:compaction` with no flags, `--auto`, `--zero-risk`, and
`--auto --zero-risk`. The smoke uses the real installed Codex and a local deterministic model
with temporary homes. Check every actual compaction response, the canonical replacement history,
continued use of the checkpoint, current filesystem/network authority, and repeated manual compaction.
Automatic `responses/memento` and standalone local compaction return assistant messages; remote v2
retains its separate compaction-item contract. Internal parser field names alone are not wire evidence.
These checks do not validate an authenticated ChatGPT session or live model recall.

## Context navigation validation

The [context navigation contract](context-navigation.md) requires new plugins named `Codex Native5`,
`Codex Native5 DEV`, and `Codex Zero Risk4`, or current custom identities that are not retired defaults.
Keep old plugins unchanged; create new plugins rather than renaming or refreshing them. A local
health result, installed MCP `tools/list`, or completed setup marker is not cloud cached-schema
verification. **Verify runtime** requires six real successful read-only context transport returns
against fixed small text, using ordinary and independent compaction credentials. Retain redacted
evidence for each selected new plugin and both manual Sent policies. Missing calls, model-only
success claims, failed transport sends, and profile/mode/plugin/tunnel/runtime/schema mismatches
must fail the diagnosis rather than report success. Separately, prove that absent, damaged, old,
and mismatched records do not block normal tasks, navigation, compaction, or recovery, alter plans,
or trigger automatic diagnostic calls. Cover Automatic and Zero Risk, production and DEV, and
setup completion without diagnosis. Current protocol, source, credential, delivery, and commit
failures must still reject invalid execution even with successful historical evidence.
Evidence has no time-based expiry; binding changes affect diagnostic applicability only. A successful six-call check proves callability, not raw cloud schema,
image consumption, model understanding, or the remaining acceptance cases below.

Complete acceptance and release validation are still pending. The initial live image checks,
dated 2026-10-11, used the preceding `Codex Native4 DEV` Automatic and `Codex Zero Risk3` manual
identities. They exercised official Tunnel → stdio MCP image returns in one response, with image
IDs `1, 2, 3, 1` and no composer image uploads.

| Live fixture and mode | Observed result | Supported conclusion |
| --- | --- | --- |
| Geometry, Automatic GPT-6 Sol High | Correct red circle, two blue squares, three green triangles, then the original red circle | One successful four-return response with fixed 640 × 360 PNG images |
| Geometry, Zero Risk with user-selected High | All four colors, shapes, and counts correct | One successful manual response on the same MCP path |
| Instant, Automatic and Zero Risk | Calls settled, but outputs reported missing or unreliable visual information | This mode did not pass the image-consumption check |
| Medium comparisons | Number errors and geometry visibility failures remained | Repeated transport success did not establish reliable image use |
| Numbers, Automatic High | The second number was read as `915465` instead of `915406` | High geometry success does not establish reliable number recognition |

Those initial checks are limited feasibility evidence for the tested High geometry sequence. They do not establish
new-ABI cloud schema adoption, all-model stability, exact visual token cost, larger single-image
limits, or increased image capacity. The four-return sequence never measured the composer boundary.
Keep the failed outputs alongside successful evidence; do not replace them with local contract tests.

Subsequent isolated DEV checks on 2026-10-11 used newly created `Codex Native5 DEV` and
`Codex Zero Risk4` plugins. Both completed all six ordinary/compaction context calls with real
transport receipts. Automatic initially failed before sending because the verifier supplied an
invalid helper conversation key; the corrected key passed a real helper protocol regression and
the live six-call check. This proves callability, not a raw platform schema export.

| New-ABI live check | Observed result | Limit |
| --- | --- | --- |
| Zero Risk High geometry | All reported colors, shapes and counts correct; the user confirmed High, no uploads, and four reports in one ChatGPT reply | Actual image returns were `1, 1, 1, 1, 2, 3, 1`; the strict sequence test failed and remains recorded |
| Automatic High geometry | All reported colors, shapes and counts correct; one physical browser run, with user-confirmed zero uploads and four reports in one reply | Actual image returns were `1, 1, 2, 3, 1`; the strict sequence test failed and remains recorded |
| Zero Risk two-turn text | The first turn read only the first log fragment; a new second-turn context found and read the previously unread unique tail value | One representative retained conversation |
| Automatic two-turn text | A new second-turn context searched and read the previously unread unique tail value after the first turn read only the first fragment | One representative retained conversation |
| Zero Risk compaction after source completion | A bounded prompt exposed the independent read entry; 1,336 bytes of selected source reads supported an accepted summary of the 233,177-byte log | Explicit manual compaction; does not prove an active-turn handoff or capacity limits |
| Automatic retained compaction | The actual retained compaction entry supported search and a 427-byte tail read, followed by an accepted summary | One representative retained handoff; not a capacity-limit test |

The geometry checks support consumption of three distinct MCP images in one reply in the tested
High configurations. The additional exact-four-call assertion failed; neither the failure records
nor the models' inaccurate claims about exact call order are discarded. These observations do not
prove stable call counts, all-model reliability, or increased image capacity.

Both representative summaries preserved the unique tail value, decision, rollback threshold
of more than three mismatches, next action, historical source, and distinction between completed
observations and pending work. Read coverage alone was not used as a semantic-quality verdict.

Before treating the feature as release-ready, exercise both Automatic and Zero Risk:

1. Read the current navigation entry from actual inline, retained, and cold-start recovery inputs. Across
   two sends, discover and read an earlier unconsumed source using the new entry; old references
   must fail. Check exact reconstruction, source roles, ambiguous call IDs, filter boundaries, and
   UTF-8 pagination through the public tools, without injecting internal credentials into a test model.
2. Compare a short input, a large tool log read only in part, and that log read in full. Record original
   and projected prompt bytes, entry and directory overhead, complete MCP response bytes, unique and
   repeated reads, calls, image uploads, image bytes, estimated tokens, and total elapsed time.
   A shorter prompt alone is not a delivery-cost result.
3. Check current required images, optional history images, unavailable sources, and fixed routes.
   Confirm no upload for MCP images. Exercise mixed fallback images with Sent enabled and disabled;
   only the selected required fallback subset receives independent confirmation. Confirmation from
   an old request or manifest must fail. Record real model use, not only HTTP success.
4. Attempt business work and completion before image readiness. Check deterministic rejection and
   a new operation ID after correction, while existing waits, replay, results, and ACKs still work.
   Observe ChatGPT-owned tool ordering separately; it has no hard server interception point.
5. Exercise no-progress, total readiness, attachment-confirmation, return-settlement, resource,
   cancellation, and in-flight completion boundaries. A legitimate Native long wait after readiness
   must retain its snapshot without a new navigation task timeout. Check task-update and owner-transfer
   races without adding a composer message or implicit ACK.
6. End ordinary work with an unread externalized source, then compact through the actual retained
   control entry. Search or read its unique information and submit once. Also submit after reading
   only part or none. Check separate credentials, bounded summary reserve, correctable budget errors,
   permanent source failures, unavailable bytes, in-flight reads, expiry, and revoked access.
   Failed attempts must preserve accepted ordinary results and must not create a successful checkpoint.
7. Cover restart, lost-page recovery, unknown Send, stop, both active and ended manual compaction,
   and new/retired/custom identities. Rebuild only from real verified sources under existing recovery
   admission. Keep browser-only, API Key, production, and DEV regression coverage. Repeat the live
   image check through the final new-ABI path; measure actual attachment limits and a higher count
   before making any capacity claim.

## Short-start context validation

`context-bootstrap-v1` implementation and local tests are separate from release acceptance.
Real ChatGPT editor behavior, remote connector schema adoption and model use of required tail pages
have not been accepted for this change. A15 remains pending. Earlier v2 text/image, continuity or
Verify runtime evidence does not establish these passes. The default 8,000-code-point composer
limit and 3,000-code-point fixed-entry limit are engineering limits, not measured attachment
thresholds for every account or model.

Validate ordinary Automatic and Zero Risk Full/MCP against the
[short-start contract](context-navigation.md#short-startup-and-required-text). Keep Browser-only,
upstream API forwarding, legacy inline, compaction and existing multipart regressions separate.

| Gate | Required evidence |
| --- | --- |
| Exact planning | About 30,000 code points of injected rules, a short request, no history/images; both modes use a fixed entry at most 3,000 code points and final text within the effective limit. Test common and mode-specific configuration, invalid values, exact boundaries, emoji, escaping, whitespace and complete long ordered user requests. |
| Source fidelity | Reconstruct the selected value tree, including source roles/order, skill paths, unknown structures, null, false and empty values. Preserve applicable instructions, delegation, summaries and assistant history. Body role/control imitations cannot change authority. |
| Delivery | Missing/overlapping/repeated/out-of-order pages, empty sources, multibyte boundaries, malformed batch-v1 metadata, failed transport, wrong digest/index/range, cross-source/scope, revocation and late receipts. Only valid range unions reach ready. |
| Execution | Early business calls, inventory and no-tool direct success fail in both modes; existing wait/replay/ACK/control remains usable. Rejected IDs stay rejected; new decisions use new IDs. Verify atomic generation/revision checks and exact output-schema values. |
| Independent controls | MCP and fallback images, configured Sent on/off, duplicate start, pending Sent without read spending, and image-first guidance. Text does not advance image progress or extend deadlines. Updates and ACK remain independent of initial coverage. |
| Capacity | All fixed required batches, initial/final overview, image recovery controls, startup/result wrappers, cursors, required images, corrective replies, one maximum-return recovery allowance and working reserves count. No mandatory entries traversal is reserved. On-demand reads cannot exhaust protected required capacity. A shorter composer can cost more total tokens. Impossible complete plans fail before Send. |
| Lifecycle | Same-scope retry, retained suffix, new-page/cold recovery, restart, unknown Send, active updates before/during/after reading, final lock, cancellation and compaction. Fresh scopes start with zero coverage; compaction keeps optional reads. |
| Compatibility | Missing/old/failed diagnosis does not select a plan. Current missing capabilities and remote old schema fail explicitly; valid custom identities remain supported. Only a complete pre-send candidate independent of the incompatible context interface can fall back; old read parameters cannot. No post-send automatic reroute. |
| Protocol migration | Account for P01–P13: role/trust, execution, wait, updates, navigation, batch-v1 read, images, attachments/skills, real errors and safety recovery, retained/recovered context, output schema, final output and mode-specific completion. Verify all unique conditions and exceptions remain reachable. Server instructions/tool descriptions must not repeat full protocols. Current errors alone select recovery; the three-attempt rule applies only to unexplained platform safety-check rejection. |

For real-platform A15 acceptance, compare old/new inputs on the same model, interaction mode and
effort. Alternate order and run at least three pairs for each tested combination. Include harmless
rules and request details found only on the last required page. Do not reveal those details in
the entry, directory previews or expected answer. Record actual batch-v1 bodies, read order, first business
dispatch and final answer. Test the actual composer to confirm that text was not converted to an
attachment, and retain remote-connector evidence separately from local schema checks. Zero Risk
must retain manual connector choice, paste, Send, configured Sent and image confirmation.

Record fixed-entry and inline-request code points, old/new final code points, UTF-16 length,
UTF-8 and serialized bytes, required/on-demand source sizes, manifest and result-wrapper costs,
unique/repeated delivered bytes, call counts, conservative total tokens, errors and elapsed time.
Record old/new generated protocol characters separately for prompt, server instructions, tool
metadata, first required protocol and triggered recovery. The fixed ordinary sample's first-use
protocol total must decrease. Record which metadata actually reached the model; unknown model
input tokens remain unknown. Keep logs to metrics and bounded identities without source bodies
or credentials. A shorter pasted entry does not establish lower total cost.

Any successful work before required delivery, byte corruption, expanded authority, duplicate
business dispatch or cross-scope coverage blocks release. Until the real editor, connector and
model-use evidence exists, do not claim that attachment conversion or missed required text is fixed.
If 8,000 code points still converts to an attachment, reduce the configured limit and repeat the
paired acceptance. Missing third-party sample bytes cannot be reported as a tested fixture.

## Same-page reuse validation

`context-reuse-v1` requires independent program-level and real-platform evidence. Earlier
short-start, navigation and continuity results do not prove same-page reuse or model retention.
The contract is in [Same-page rule reuse](context-navigation.md#same-page-rule-reuse).

Program-level acceptance covers both modes for 20 healthy turns with at least 30,000 code points
of real classified rules and growing canonical history. After a unit's first complete delivery,
its mandatory repeated body must be zero bytes across prompt, protocol, payload, source map,
manifest and actual required returns. Newly applicable protocol branches may be delivered once.
Test exact reconstruction, independent identical user events, changed rules/roles/ordering,
dynamic environment/schema, long-request missing pages, empty/multibyte/forged receipts,
updates/ACK/output races, new page/restart/compaction, unknown Send, proved unsent preparation,
late final, capacity eviction, current-scope rereads and old/new capability combinations.

Real-platform acceptance is pending. For each of Automatic and Zero Risk, compare complete
short-start and reuse plans with the same model and effort, alternate order, and record at least
three paired sessions of at least ten turns each. Include stable rules, changed rules and a long
request. Harmless early rule checks belong only in source bodies, not entry hints or expected
answers. Record rule use before business work, tail-page use and any exact rereads. Zero Risk
retains its original manual Send/Sent and image steps.

Report selected full/resume candidates and bounded miss/fallback reasons; units hit/redelivered;
reused original bytes and current required bytes; composer code points, UTF-16, UTF-8 and
serialized bytes; mapping/reference/manifest/directory sizes; actual unique, duplicate and
reread bytes; calls and time before first business work or successful completion; preparation
time; retained, new and total token estimates. Model input tokens remain unknown when they
cannot be observed. Reduced mandatory bytes do not establish a fixed speed or token benefit.
Missing events, corrupt bytes, invalid-baseline admission, incomplete-context execution,
expanded permissions or duplicate business dispatch block acceptance.

## Context rendering validation

The browser renderer and MCP text-batch-v1 require separate evidence from the earlier context
navigation observations above. Local round-trip, pagination, protocol, receipt, and control tests
do not establish release readiness. Current connector names remain unchanged for this unreleased
update; reconnect/refresh the same connector if needed. When validating the optional diagnosis,
obtain current batch-v1 Verify runtime evidence from all six real calls, with at least two
independent text bodies in each ordinary/compaction read. Normal use does not require it.

For Automatic and Zero Risk, record the actual runtime, model, effort, client path, source fixture,
selected format, and observation limits:

1. Compare compiled input with the readable editor/submission representation and exact model
   extraction. Cover long code, links, nested/long fences, LF, tabs, and trailing whitespace. Zero
   Risk keeps manual paste/Send/Sent. Only actual evidence for a path can enable its whitespace
   allowances; default production policy retains these fields in JSON.
2. Confirm matching metadata in the first text block and structured content, and every independent
   body selected by `items[].body_content_index`. Request at least two fixed sources in each read;
   validate all blocks and the actual successful transport batch receipt. Cover empty and paginated sources.
   The new verifier's ordinary and compaction shape/transport receipts must pass; they do not prove
   the model used the body.
3. In separate real ordinary tasks and compaction transactions, extract a unique body-only fragment
   and its UTF-8 range through each mode's existing answer/checkpoint path. The entry, list labels,
   search snippets, and expected-answer hints must not reveal the fragment. Keep the verifier's
   private scope read-only and unable to complete tasks.
4. Before model runs, fix paired baseline/new fixtures, the same model/mode/effort, order, and
   judging rules. Interleave formats and repeat each task at least three pairs. Check exact
   extraction, source priority, call pairing, long-history constraints, paging, and forged
   boundaries. These are minimum smoke observations, not statistical significance. Permission
   leaks, duplicate actions, early execution, or body corruption block the stage separately.
5. Report full prompt token estimates, visible bytes, editor length, JSON-encoded bytes, attachment
   and image reserves, complete MCP bytes, conservative and diagnostic token estimates, calls,
   unique/repeated bytes, errors/retries, and elapsed time. Include long code, Markdown, JSON text,
   short results, partial reading, and complete reading. Preserve negative-savings cases. Mark
   actual model input counts unknown unless directly observed.

Missing editor evidence blocks that browser allowance. Missing any required real ordinary or
compaction body-use evidence blocks stage-two release. A client that cannot update under the
current identity stops batch-v1 use; it does not authorize a new connector name or weaker budget.

`bun run scripts/measure-context-rendering.ts` produces the offline cost replay with forced legacy,
forced new, and automatic candidates; all use MCP batch-v1. `bun run scripts/validate-context-rendering.ts
check` checks the default DEV setup, and `plan` prints the fixed live matrix without sending a task.
Its explicit `run` action creates a real model task and records observed evidence. Use the project
development Launcher so its supervised MCP process loads the checkout; a source path in a copied
configuration does not prove that an installed Launcher uses that runtime.

## Context batch and short-start validation

Protocol 4, manifest 3 and `context-text-batch-v1` require fresh acceptance. Historical single-read,
image and renderer results above do not prove this contract or its larger response limits.
Real Automatic, Zero Risk and applicable installed Codex validation is pending. Local parser,
DEV simulation and offline replay do not establish remote schema adoption or model body use.

Use saved fixed sources: one about 65 KiB; 24 short sources totaling about 9 KiB; dense multibyte
text; empty text; and necessary details only in the last page or last returned item. Compare the
historical baseline, conservative batch-v1 and expanded batch-v1 separately. Isolate larger-page
benefit from source grouping. Observe multiple actual bodies in a response and fewer read calls
than per-source reading where grouping fits; do not assume 24 sources always take three calls.
Check zero required `entries` calls in normal pure-text startup, the fixed successor chain and
final settled overview. Test single text, single image, mixed-image plans and failure recovery;
images retain their separate receipt/confirmation and Send/Sent/ACK remain independent.

Local acceptance must cover strict 0/1/8/9 arrays, duplicate targets, invalid suffixes, old schemas,
complete UTF-8 reconstruction, all-block validation, packaging/argument limits, deterministic
partial pages, whole-batch receipts, cancellation, late scope callbacks and canonical replay.
Prove that partial coverage does not release proportional reservation credit, generated response
costs remain charged after failed transport, one finite maximum-return allowance serves both retry and replay, and the
final overview retains it until first business/success admission. Impossible complete plans fail
before Send; running out of recovery cannot waive coverage or consume protected workspace funds.
Compaction may still read partially or not at all and waits for in-flight reads before submission.

Real validation must record remote acceptance of the array schema, intact maximum candidate
responses, use of last-page/item details, readiness before work and elapsed time. Record requested
and returned items per batch, body read calls, overview and entries calls separately, complete
response bytes, estimated tokens, unique/repeated body bytes and the actual limiting budget.
Separate generation costs from successful transport metrics. `before_first_work.elapsed_ms`
starts at scope diagnostics, not browser Send. Separately record actual Send or confirmed manual
Send to first business admission; identify waiting for Sent/image confirmation. Keep actual model
input tokens unknown unless observed. No fixed speedup or platform-capacity claim is accepted
before these measurements. If expanded fails, choose conservative only for a new plan; never
switch a sent plan to old arguments/format or automatically Send again.

## Session continuity validation

Supported ordinary `chatgpt-web/` Full Native + Launcher routes use page-lifecycle recovery.
The historical evidence below covers earlier contracts. It does not establish this change's
real Launcher acceptance. Keep Automatic and Zero Risk observations separate, and keep the
navigation platform matrix above outstanding until a new run covers it.

Record the following before claiming page-lifecycle recovery validated:

1. Interrupt a request, manually close its page, then continue the same request through the full
   HTTP endpoint and Adapter preflight to normal new-page preparation. Old stopped, revision, or
   source state must not return 409, and old cancellation cache must not return 400
   `client_cancelled`. Zero Risk must still wait for manual Send and confirmation.
2. With the old page closed, vary stopped, completed-without-body, consumed checkpoint, unknown
   Send/tool result, legacy metadata, missing/corrupt journals, and exhausted old budgets. All
   must permit current-request recovery. Do not automatically redispatch old tool calls. Include
   request-carried real results, process handles, summaries, and rolled-back history.
3. Disconnect, time out, or restart Launcher so old-page state is unknown, then restore the normal
   creation interface. Observe best-effort old-generation revocation and a new page without old
   Send, settlement, or destruction proof. An actually unavailable interface remains a service
   failure. Record that unreachable old commands may continue producing effects.
4. Keep a page confirmed alive and test rollback, same identity with changed payload, unknown or
   conflicting result groups, incorrect compaction source, and owner conflicts. Reject specific
   conflicts while preserving its valid writer. Matching retries must still attach or replay.
   HTTP disconnect or interrupt alone must not start background recovery.
5. Race matching recoveries, distinct requests, stop, task append, and checkpoint. Change page
   state after query: closed becomes recovery; an already-created new page becomes live-page
   validation. Observe one current execution, one corresponding Send, and no stale replacement.
6. After new-page activation, deliver old destroyed callbacks, stops, Send receipts, helper
   acquisition/dispatch, tool results, task updates/ACK, final answers, and checkpoint commits.
   Observe actual old-generation denial at cross-process entry points. No old callback may
   delete the new page, write its state, rebuild deleted records, or issue new tools. Test
   storage/lock failures and late completion of original in-flight transmissions separately.
7. Close a real page and restart backend. Confirm its registration, work/attempt/call,
   stop/completion, history/checkpoint/retry data, binding/index, and task snapshots are removed,
   without TTL or replacement tombstones. The independent one-hour input/output cache must
   remain compatible. Independently referenced in-flight bodies may remain only until completion.
8. Migrate current and old formats, missing/corrupt closed-page records, and interrupted migration.
   Preserve confirmed-live activity, installation/login state, and increment cache; revoke unknown
   generations and remove closed-page task records. No permanent deny list, long-term quarantine
   archive, or two current writers. Verify running backend, helper, Broker, and Launcher; new
   files on disk alone do not prove compatibility or old-process termination.
9. Cover ordinary unfinished work, checkpoint continuation, and uncommitted compaction, including
   local/v1/v2 wrappers and ordinary aliases. New-page recovery does not require old checkpoint
   proof. Regenerated compaction is a new transaction, not exact old replay; current-page
   compaction still commits once. Cover a legal tool log whose inline form exceeds the old
   window but whose real on-demand plan fits, and read a unique unread tail through actual
   delivery. Compare healthy-page incremental continuation without injecting test answers.
10. Test increment-cache hit and expiry, unreadable ciphertext, missing current source bytes,
    non-externalizable instructions, image/attachment, input/output, snapshot, and navigation
    limits. Report actual source/read/plan budgets and preserve required bodies. A missing
    `previous_response_id` cache keeps its API-context 409. Corrected requests retain recovery
    eligibility. Load the public 1,000,000 / 900,000 history settings with the target Codex binary
    and lower client limits; this is not proof of million-token browser capacity.
11. Exercise five physical pages, safe idle reclamation, and cleanup that never destroys a page.
    Closing/fault documents still occupy slots, with at most three automatic closes per fixed
    cleanup transaction. Logical revocation cannot permit a sixth page. Retain only minimum
    physical cleanup information after task revocation. Exercise the real 24-hour successful-work
    clock separately from controlled-clock tests. Current-page journal/cache bounds still apply.
12. Cover Automatic, Zero Risk, local Web API Key access, and excluded Browser-only, non-Launcher,
    Luna, Think, and upstream API paths. Fresh affects logical sends rather than tool round trips,
    retries, or updates, and cannot bypass live-page conflicts. Preserve Zero Risk Send, Sent,
    attachment and ended-response handoff boundaries and Bigger Context prohibition. Confirm one
    accurate recovery notice and bounded logs without prompt bodies, tool results, or credentials.

Real Launcher pages must cover items 1, 3, 5, and 6 in Automatic and Zero Risk, in addition to
local regression tests. Controlled fake pages and old live evidence are separate observations.
**Currently unverified for this change:** full HTTP manual-close recovery, unknown-page recovery,
concurrent real-page recovery and late-generation events in both sending modes; cross-process
running-component migration; physical-page pressure/cleanup; the new-page unique-tail acceptance
and remaining navigation/platform combinations. Update this list only when new evidence exists.

The maintained contract is [session continuity](session-continuity.md).
Keep raw controlled output and acceptance records in the local ignored task workspace.

### Current unified-budget evidence

The 2026-10-12 target-Codex loopback probe used synthetic usage without ChatGPT sending. Three
usage scopes passed with the public 1,000,000 / 900,000 resolver settings; six lower-window,
lower-limit and combined cases passed with lower client settings. This supports actual client
budget loading and trigger behavior only. It does not validate new-page source reads, real image
routing, live execution isolation, throughput, or browser capacity. The local records are
`.dev-workflows/unified-task-continuity/budget-target.json` and `budget-lower.json`.

### Recorded continuity evidence

These September/October records describe the historical independent-mode and recovery contracts.
They are retained as evidence, not certification of the unified mechanism or its removed full-source
window gate and protected-page rules. The September records established different kinds of evidence, not one interchangeable
end-to-end pass:

| Evidence | What it established | What it did not establish |
| --- | --- | --- |
| Budget probe, Codex 0.157.0, 17 controlled cases | Native app-server configuration, usage-triggered compaction, lower user limits, and a finite upper bound with the 1,000,000 / 900,000 catalog settings | Million-token browser input, throughput, or ChatGPT context capacity; requests were short with controlled usage |
| 2026-09-28 DEV page probes | Automatic active/completed source and Zero Risk active source each completed two same-page runs with new authority; completed/pre-control-ended Zero Risk stopped | Complete production outer-Codex integration; outer work-tool receipts were simulated |
| Synthetic component resource sample | About 4.85 MB of history, about 1.03 million estimated tokens, short-increment acceptance, oversized-first-input rejection, and bounded response-cache eviction | Five real pages, checkpoint load, sustained throughput, or a process-memory cap; maximum sampled RSS was about 0.8 GB, not a precise peak |
| 2026-09-30 current-work protocol capture | 34 real Codex POSTs, a harmless Native `printf`, retry, steering, local/v2 compact, and active/completed checkpoint-only shapes against a fake page | Authenticated ChatGPT DOM, Launcher surface/lease, remote deployment, or complete real Zero Risk interaction |

The [budget probe](../scripts/probe-session-continuity-budget.ts) records the chosen binary,
configuration, and controlled usage interval. The recorded 0.157.0 binary SHA-256 was
`ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`.
For the target catalog, its effective window was 900,000: controlled usage of 898,000 did not
compact and 901,000 did. Setting client window/compact values to 2,000,000 did not remove the
upper bound. Lower client settings still reduced the threshold. Recheck on the release's actual
Codex binary; these observations are not a floating-version guarantee.

The [current-work capture/replay script](../scripts/probe-codex-continuity-protocol.ts) used Codex
0.159.2, binary SHA-256
`16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704`, and Bun 1.4.0.
It used temporary configuration, loopback-only synthetic authentication, a deterministic page
substitute, and a harmless real Native command, not production credentials or browser state.

| Replayable sample | Captured POSTs and scope |
| --- | --- |
| [Ordinary and steering](../tests/fixtures/session-continuity/current-work-protocol.json) | 8; built-in OpenAI provider with synthetic ChatGPT authentication, manual v2 compaction, one lost-response retry |
| [API-key provider](../tests/fixtures/session-continuity/current-work-protocol-api-key.json) | 8; custom provider, local compaction, native client removal of item source metadata |
| [Active and checkpoint-only](../tests/fixtures/session-continuity/current-work-protocol-active.json) | 10; mid-turn automatic v2 compaction and completed-source empty-input continuation |
| [Zero Risk model protocol](../tests/fixtures/session-continuity/current-work-protocol-zero-risk.json) | 8; model request shape only, not proof that real Zero Risk can compact an already-completed response |

Native thread/turn metadata and item IDs distinguish retry, new turn, and same-turn steering.
Persistent base/developer and AGENTS/environment prefixes can keep their creation-turn metadata
while remaining applicable. Tools can arrive in `additional_tools`, not only top-level `tools`.
The custom-provider capture removes item source metadata; that does not relax delegated source
proof. Source instruction turn and compaction request turn must not be interchanged.

The captured normal requests retained predecessors. Deleting completed history, adding other
native developer kinds, removing an AGENTS part, and testing role/attachment conflicts are
explicit synthetic variants, not additional captured client behavior. The native-source layout
coverage is retained in the [input regression tests](../tests/session-continuity-input.test.ts).
These captures do not cover v1 compaction, JSON responses, `previous_response_id` expansion, or
real file/image/audio attachments. The current-work change still lacked authenticated-page,
real 24-hour, sustained real-page-memory, and remote-deployment acceptance in its recorded result.

Replay exercises only the parser/normalize boundary. It does not run Native tools or open a page:

```sh
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-api-key.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-active.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-zero-risk.json
```

## Native tool waiting validation

Use the [Native tool protocol](native-tool-protocol.md) as the public contract. Test both Automatic
Full and Zero Risk with the actual connector, Tunnel, helper, and outer Codex. Record one dispatch
and original call identity across pending, wait, identical retry, and result replay. Distinct new
operation IDs must remain distinct calls. Verify that the caller holds the ID before any side
effect and preserves its allocation counter through same-capability reconnects.

Keep a real `request_user_input` or approval operation open for at least 11 minutes with remote
deployment's default 600-second idle enabled. Verify 30-second pending responses, valid 120-second
consumer leases, unchanged idle last-progress time, and delivery of the real answer/rejection.
Also check a noninteractive long call, cancellation, first pending/result receipt loss, reconnect,
lease loss, and completion blocked on unread results. Retained compaction must distinguish queued
control terminals from delivered Native calls; fresh-owner retirement must not redispatch old work.
Reject an incompatible connector/helper before a Native side effect.

The recorded 2026-09-24 Automatic DEV probe crossed real ChatGPT → Connector → Tunnel, returned a
45-second **simulated** Native result through wait, reused the original call for same-ID retry,
and created one new call for a new ID. It established the normal transport topology, not real
11-minute human input/approval, remote idle, first-receipt loss, or reconnect behavior. Local
controlled-clock and MCP tests are additional component evidence, not substitutes for those gates.
The [DEV probe regression](../tests/native-tool-long-wait-probe.test.ts) and
[waiting regressions](../tests/native-tool-long-wait.test.ts) remain available without retaining
historical implementation/review rounds as public specifications.

## Continuity input queue validation

The input-queue contract applies to supported Full Native + Launcher Automatic and Zero Risk
routes. Implementation and local contract tests do not establish authenticated platform success.
Keep these evidence classes separate:

| Gate | Required evidence |
| --- | --- |
| Preparation P01–P04 | Actual local preparation/Send race, same-lock termination receipt, healthy-page retry, unknown Send fence, stop/successor races, unchanged history/checkpoint, exact Send count, original error fields |
| Queue Q01–Q17 | Thinking/no-tool receipt, ordered multi-message prefixes, ID/digest retry, real tool results exactly once, immutable ACK gap, final lock and compaction races, stop/discard intent fences, capacity and process-restart recovery |
| C02 | Installed Codex 0.163.0 with deterministic loopback provider: nonterminal waits, steering timing, current association and same physical completion, multiple assistant items and one true logical terminal |
| C01 | Real Codex input history plus product custody: refused/unknown receipt retains exact original and stable message ID; query/retry/repair recovers the same record; JSON/SSE ordered outputs agree |
| C03 | Real Launcher/ChatGPT Automatic and Zero Risk: same-page local failure/retry, no-tool continuation, final-lock queue, manual Send/Sent/attachment snapshots, disconnect, stop and real tool effects |

For every race, record trusted IDs, S/M/R/G/H, physical owner/capability, observer association,
Send count, tool dispatch count and exact coverage. Do not infer completion from an empty queue
or a successful Send. Missing originals must block delivery/copy and require an exact-body repair;
capacity failure must leave the sender's original available. Inspect Activity occupancy and explicit
cleanup after page loss and restart. Pending/stopped originals must not disappear on page cleanup.
After a later native turn completes and the historical replay window ends, verify that only fully
settled older inbox details are reclaimed. A prepared/failed successor must preserve the old head.
Crash between source-fence commit, payload removal and final metadata compaction, then restart.
The original source must remain unable to create new work, while pending/stopped originals remain
readable. Include the remaining compact fences in the unchanged global budget.

Local client checks can be reproduced with `bun run scripts/probe-continuity-input-queue.ts` and
`bun test scripts/probe-continuity-input-adapter.test.ts`. Both use the installed Codex client and
an isolated loopback upstream. The adapter probe additionally exercises real product request,
queue and observation code against a deterministic page worker. They do not establish a C03 pass.

Normal waiting must not emit `incomplete(task_update_handoff)`, a fake completion or an empty
final answer. Codex 0.163.0 treats that incomplete reason as a failed turn; it is not a pause API.
A pure observer handoff must keep G, the physical owner, final candidate, lock and completion CAS
valid while preventing the old association from claiming new tools. Keep failed client evidence
alongside successful cases. A deterministic page/helper fixture cannot substitute for C03.

## Inflight user update validation

The [task update contract](native-tool-protocol.md#user-updates-during-tool-work) requires both
Automatic Full (`Codex Native5`, or `Codex Native5 DEV`) and Zero Risk (`Codex Zero Risk4`).
Create the new connector identity and verify the ACK tool and `task_revision` start schema before
testing. Existing active tasks keep their original protocol; start a new compatible task.

1. Have real Codex execute a harmless tool with a visible delay. While it runs, append one plain
   user instruction in the same native turn. Record the source Responses batch and tool-use
   terminal before the request carrying its real result and the new user item.
2. Confirm that the result carries the ordered update and the model ACKs it before further Native
   work. The same ChatGPT response, turn token/request ID, operation ID, and tab must continue,
   with no new Send action. The Native side effect must occur exactly once.
3. Append twice during the unconfirmed chain. Confirm that the first delivery stays immutable,
   its ACK response can carry the next delivery, and both updates affect the complete final answer.
   Drop an ACK receipt and recover with the identical delivery and original operation ID.
4. Exercise result errors, images/resources, and inventory. Compare the entire original public
   result with the envelope's `native_result`; control must not alter it. Confirm old queued calls
   and new calls on an unacknowledged revision return an unexecuted terminal.
5. Check that commentary remains process output and the first final-answer text closes the update
   window. An input received after final output locks is durably queued for the next ordinary response;
   it is not covered by the locked answer. A late ACK cannot reopen it. Check
   strict structured output, stable Automatic completion without ACK, and refused Zero Risk
   completion followed by a valid ACK and revision-bound complete answer.
6. Check old-observer disconnect after a continuous append, explicit user stop, initial Zero Risk
   awaiting Sent, compaction with a pending update, and compaction from the latest acknowledged
   source. Old observer cleanup must not stop the new driver, while explicit stop still releases
   the physical task. Record each mode's tab/response identity and terminal result.

For supported ordinary Web routes, also verify that a tool boundary accepts a text-only append and a
partial result batch. Supply the missing results later without more user text. Trim completed
history, reorder results, and repeat known results with changed bodies: locally identified work
must continue, the first result must remain unchanged, and each call must complete once. A wrong
result type for a still-pending call must fail before accepting the append. After acknowledgement,
compact the latest logical source without resending already accepted result bodies. Verify that
only compaction advances history revision and that a stale preflight cannot retire a new driver.
Without a boundary or negotiated active-update protocol, verify durable receipt and ordinary
continuation after the original physical response settles. Do not silently upgrade the old
capability or require the user to re-enter an already accepted input. Keep real-client evidence separate from controlled fixtures.

The [continuity append probe](../scripts/probe-continuity-append-live.ts) runs a real local Codex
app-server, the working-tree Adapter and helper, the isolated DEV Launcher, and one harmless
Native `sleep`/`printf` command. It steers the same native turn while that command runs, then
checks delivery, ACK, the changed answer, and one physical response. Run `--check-only` first;
`--model=chatgpt-web/gpt-6-pro` selects that supported route when the DEV account has
Pro access. The probe uses the DEV profile's current interaction mode; Zero Risk still needs
the first manual send and Sent confirmation. It saves local evidence under `.dev-workflows/`.
Script availability and a successful preflight are not a real-platform pass.

Local Broker/Remote owner, MCP, Session, helper, and Adapter tests use controlled fixtures and
failure injection. They establish local contract behavior, not authenticated ChatGPT/connector
acceptance. This is historical evidence for the former independent-mode contract: on 2026-10-08,
the continuity append probe passed the result-plus-append scenario
with the real Codex app-server and DEV Automatic GPT-6 Pro. It recorded one Native command and
result, one page and physical response, two logical execution keys, delivery and ACK, and the
changed final answer, with no 409 response. Local evidence is retained at
`.dev-workflows/continuity-append-handoff/tmp/a1-live-automatic-8/evidence.json`.
This pass covers that scenario only. Zero Risk and the other real-platform scenarios above
remain unverified; retain separate redacted evidence before claiming those passes.

## API access, upstream, and proxy validation

Maintain the [API Key](api-key-mode.md), [upstream](upstream-provider.md), and
[proxy](network-proxy.md) contracts together. Local automated runs should use isolated `HOME`,
`CODEX_HOME`, and `CODEX_CHATGPT_WEB_HOME`, with inherited HTTP(S)/ALL proxy variables cleared in
the test subprocess only. Do not let test cleanup fall back to a user's active configuration.

Check local authentication before routing, private key-vault recovery and session-only fallback,
save-before-restart failures, API mode's no-automatic-Codex-write rule, and sensitive export
contents. With a dedicated test upstream, exercise all three proxy policies, selected versus
unselected models, missing/failed discovery, all metadata modes, protected Agent-control fields,
degraded custom round-trip, v1 marker/vault cleanup, and dynamic/static catalog consistency for the
exact response consumed by export. A configured revision does not freeze the remote catalog.

For metadata release verification, use one immutable source lock for generated bundled data,
schema, and the actual Codex parser. Check repeatable generation, field/type diffs, unique exact
slugs, final-row validity, and stale-artifact rejection. Run
[catalog smoke](../scripts/smoke-codex-catalog.ts) only after proving parser identity against that
lock; a matching display version or an arbitrary installed `codex` is not enough.

For packaged Electron proxy validation, verify exact partition/Basic/host/port challenge matching,
old-auth cache removal before switching, rollback, and the fixed fatal path if cache clearing
fails. Confirm that unconfirmed child shutdown keeps supervision rather than falsely reporting
exit, and that diagnostics redact old as well as current endpoints. Do not interpret mocked
safeStorage/network tests as real OS-vault, provider, proxy, or Tunnel authentication evidence.

Server release acceptance additionally requires the
[real two-host delegated harness and packaged secure-storage checks](../deploy/server/README.md#runtime-acceptance-on-the-target-server).
Same-workstation mocks do not prove child-origin execution, outer sandbox/approval enforcement,
manual Zero Risk handshakes, private public-facing listeners, or persistence across container
recreation. A Secret Service substrate probe does not by itself validate Electron safeStorage.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
4. Complete one Browser-only turn and verify streamed commentary plus the final answer.
5. Create the `Codex Native5` connector, run **Verify runtime**, and complete one Full-mode local
   tool turn. Repeat with Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without
   a duplicate or orphaned browser turn.
7. On a clean install, prove that setup offers both interaction modes and defaults to With
   Automation. Select Zero Risk and prove that Codex shows exactly one generic Web model after
   restart, a retained chat receives only the next prompt, and
   compaction completes through MCP before the compacted continuation opens a fresh manual chat.
   Inspect the copied prompt and prove that it contains only the current `request_id`, never a
   surface nonce, capability token, or prompt-level lifecycle commands.
   Switch back to Automatic and prove that the account-visible catalog is restored.
8. Cancel a running turn by closing its launcher tab, then cancel another with the launcher action;
   prove that neither turn recreates a tab or keeps the runtime busy.
9. Quit the launcher during an active turn, confirm the explicit cancellation path, reopen it, and
   prove that the saved ChatGPT session and Codex route are still valid.
10. Prove Codex Voice can create a WebRTC call while Responses use the local bridge. Disconnect the
   bridge and prove that both exact previous route assignments are restored; reconnect it and prove
   that the existing private MCP credentials are reused rather than replaced.
11. Upgrade from the previous public release and prove that launcher state, browser state, Codex
    settings, and MCP configuration survive the updater transaction.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

### v3.0.0 result

Maintainer validation passed on Windows 11 x64 on 2026-08-22 using the published v3.0.0-alpha
upgrade package and a real ChatGPT Pro account. The authenticated launcher, Codex model catalog,
Full-mode MCP tools, Pro turns, compaction, cancellation, session reuse, and preserved connector
configuration were exercised successfully. The direct installer completed successfully but gave no
clear completion action; v3.0.0 changes it to an assisted installer with a final launch option.

## macOS gate

Repeat items 2 through 10 on the oldest supported macOS version or the closest maintained machine.
Packaging smoke and code-signing verification remain separate gates; neither substitutes for the
interactive account flow.

## Linux gate

CI packaging smoke is required. Before claiming interactive Linux support for a release, repeat
items 2 through 7 under a supported desktop session and record the display server and packaging
format used.
