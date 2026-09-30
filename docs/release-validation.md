# Release validation

CI proves that the runtime builds, the launcher starts, and native packages pass their smoke
contract on macOS, Windows, and Linux. It does not prove an authenticated ChatGPT session, a live
MCP connector, or a complete Codex turn. A release candidate is not ready until those account-bound
flows are exercised manually on the platforms below.

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

Minimal-validation coverage on 2026-09-30: the tenth repair round has 14 passing new
regressions. Checkpoint-only continuation ignores completed user history before the checkpoint;
the retained source itself remains protected on first transition and cached retries. Original and
v1 producer source representations are captured at commit, so cached HTTP compaction replay
adds no source evidence. Both modes cover 600 cached reads across local/v1/v2 codecs, current
source payload conflicts, current constraints, anonymous new instructions, and preserved ordinary
final output. Related targeted validation has 71 passes. Integration validation across 17 files
totals 844 passes, one Windows-only skip, and no failures; typecheck and diff checks pass.
Both new independent full reviews are complete, and the two prior findings are closed. Two new
P2 findings remain: same-turn sources with identical summaries select the first source and reject
the second continuation, and an active execution replays a cached ordinary round before updating
its current tool registry. The current scope has not passed review. The
[design attachment](dev/session-continuity/minimal-validation.md) records the current status. The real Codex/ChatGPT path in item 9, real 24-hour retention,
sustained page-memory load, and remote deployment validation remain unexecuted for this change.

Keep the component and synthetic evidence with the implementation record, but distinguish it from
real authenticated ChatGPT results. Any unexecuted platform, 24-hour, resource-load, or remote-idle
combination must remain visible in the release record instead of being described as validated.

## Windows 11 gate

Run this list on a maintained Windows 11 x64 machine with a real ChatGPT account:

1. Install the packaged launcher on a clean profile and prove that the embedded Bun runtime starts.
2. Sign in inside the embedded browser and prove that Temporary Chat reaches a usable composer.
3. Install the Codex model route, restart Codex, and prove that every account-available ChatGPT Web
   effort appears exactly once without removing native models.
4. Complete one Browser-only turn and verify streamed commentary plus the final answer.
5. Configure the `Codex Native3` connector, run **Verify runtime**, and complete one Full-mode local
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
