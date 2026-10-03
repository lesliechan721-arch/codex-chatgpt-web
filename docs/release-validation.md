# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

## Launcher dependency audit exception

`bun run launcher:audit` temporarily excludes only
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
As of 2026-10-03, `http-cache-semantics` has no published fixed version. The locked
dependency comes from `app-builder-lib` 26.15.3 → `@electron/get` 3.1.0 → `got` 11.8.6
→ `cacheable-request` 7.0.4 → `http-cache-semantics` 4.2.0. Electron itself uses
`@electron/get` 5.1.0, which uses Fetch instead of Got.

The advisory requires a shared HTTP response cache. Got disables that cache by default,
and the current launcher build configuration does not enable `downloadOptions.cache`.
Electron's file cache stores downloaded artifacts; it is separate from Got's HTTP response
cache. These packages are build tools, not launcher runtime dependencies. This exception
does not fix the dependency's vulnerability. The root audit and all other launcher advisories
still block verification.

Reassess this exception when changing the build dependencies or download configuration.
Do not enable Got's HTTP response cache while the exception is active. Remove the exclusion
when a fixed version is available or the build dependency no longer includes the affected
package. Do not force `@electron/get` 5.x over the builder's 3.x requirement: its download
options and proxy API changed, so that migration requires packaging validation on all three
platforms.

## Preview releases and updater visibility

Use GitHub's **Set as a pre-release** flag for public test builds. They remain downloadable from
Releases but are excluded from `/releases/latest`, the endpoint used by both existing launchers
and the installer. A draft is private; a pre-release is the public testing option. No separate
launcher update channel or custom release-body flag is required.

After validation, uncheck **Set as a pre-release** and select **Set as latest release**, or publish
a newer stable release. Launchers discover it on their next startup update check, provided its
version is newer and its platform asset and checksums are present. Already running launchers
do not poll for publication changes.

The tag workflow marks new suffixed versions such as `v6.0.0-rc.1` as pre-releases automatically
and preserves an existing release's pre-release flag when rerun.
Use a new version for changed binaries; toggling publication flags promotes the existing build.
Do not publish a stable tag and only mark it as a pre-release afterwards: an older launcher could
offer it during that interval. To keep a final version out of the updater during testing,
prepare a draft release with **Set as a pre-release** checked before pushing its tag.
The workflow publishes it with that flag preserved.

GitHub documents this contract in [Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Required evidence

Record the release version, operating-system version, install path (`clean` or `upgrade`), ChatGPT
plan, Codex version, result of each check, and a redacted Activity log for every failure. Never
capture cookies, tunnel IDs, API keys, bearer tokens, or prompt contents.

## Session continuity validation

`chatgpt-web-continuity/` has additional validation because it deliberately keeps one exact
ChatGPT conversation across ordinary turns and compaction. These checks record release coverage;
they are not an additional runtime feature flag or alias gate.

For both Automatic and Zero Risk on a compatible Full Native + Launcher setup, record:

1. First-use creation, a normal continuation, and a compaction continuation all keep the exact
   expected native thread, history revision, Launcher surface, and continuity lease. A lost page,
   changed scope, restart, or explicit mode exit must stop instead of creating a replacement page.
2. Automatic completed-response and active-response compaction each commit one structured
   checkpoint and continue on the same page with new tool authority. Zero Risk active compaction
   uses the delivered control path; a response that ended before control delivery preserves its
   ordinary result and requires manual handoff without a second automatic prompt.
3. The published 1,000,000-token history window and 900,000-token automatic-compaction target do
   not increase the existing single-browser-input limits. Test a large canonical history with a
   short valid increment and a first input that exceeds the original browser boundary.
4. Five healthy continuity pages remain protected from capacity eviction. Measure representative
   real-page memory plus checkpoint/replay storage under sustained use, and verify that additional
   work fails before creating a page when no safe capacity remains.
5. A ready page expires only after 24 hours without successful continuity work. Health checks,
   replay, inspection, and heartbeats must not renew that clock. Exercise the real 24-hour boundary
   rather than replacing it only with a mocked clock.
6. Remote/delegated operation keeps the existing native operation identity, queued/delivered tool
   boundaries, cancellation, helper liveness, and remote-idle behavior. A retained page never
   extends a tool capability or authorizes a replay after its exact owner is lost.
7. Completed-history text, display IDs, and source metadata changes do not change accepted current
   work or cause extra browser/Native execution. New increments send all current instruction items
   and attachments, with the required current environment; they never resend completed work.
   Ambiguous unowned instructions fail before submission. Current payload and result conflicts
   remain rejected, and changing tool-call echoes never grants authority.
8. Old result batches replay their own journal after later batches begin. Cross the 512-round
   bound and verify that reclaimed results fail while ordinary reconnects retain their original
   events and usage. Concurrent initial requests preserve the first captured prompt. Shared
   compaction retries register each accepted cancellation identity without generating another
   summary. Different sources with identical summaries remain distinct; unresolved revision
   ambiguity stops instead of selecting the latest revision.
9. Use the target Codex binary with an isolated Responses fixture first, then a harmless tool and
   authenticated ChatGPT page. Record the binary, authentication path, JSON/SSE and full/previous-
   response history forms, local/v1/v2 codec coverage, ordinary → tool result → compact → continue,
   and lost-response retries. Synthetic metadata variants are not real-client certification.

The maintained contract is [current work and committed relationships](session-continuity.md#current-work-and-committed-relationships).
Keep raw task output in the local ignored workspace, not as a second public implementation spec.
Record each release's actual results separately from the historical evidence below. Any unexecuted
platform, 24-hour, resource-load, or remote-idle combination must remain visible in that release's
record instead of being described as validated.

### Recorded continuity evidence

The September 2026 records established different kinds of evidence, not one interchangeable
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

## Inflight user update validation

The [task update contract](native-tool-protocol.md#user-updates-during-tool-work) requires both
Automatic Full (`Codex Native4`, or `Codex Native4 DEV`) and Zero Risk (`Codex Zero Risk3`).
Refresh the new connector identity and verify the ACK tool and `task_revision` start schema before
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
   window. A later append uses the ordinary replacement path; a late ACK cannot reopen it. Check
   strict structured output, stable Automatic completion without ACK, and refused Zero Risk
   completion followed by a valid ACK and revision-bound complete answer.
6. Check old-observer disconnect after a continuous append, explicit user stop, initial Zero Risk
   awaiting Sent, compaction with a pending update, and compaction from the latest acknowledged
   source. Old observer cleanup must not stop the new driver, while explicit stop still releases
   the physical task. Record each mode's tab/response identity and terminal result.

Local Broker/Remote owner, MCP, Session, helper, and Adapter tests use controlled fixtures and
failure injection. They establish local contract behavior, not authenticated ChatGPT/connector
acceptance. Real-platform validation of this feature remains pending and is reserved for the
maintainer's subsequent manual run; retain redacted evidence for each mode before claiming it.

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
5. Configure the `Codex Native4` connector, run **Verify runtime**, and complete one Full-mode local
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
