# CI test performance

Local runs, CI and release verification use `bun run test` for the server tests, with two
workers by default on every OS. Set `CGW_TEST_WORKERS=1` or pass `--parallel=1` to run serially;
the command-line option takes precedence. Manual CI runs use two workers when `test_workers`
is `auto`; selecting `1` or `2` overrides the worker count on every OS in that run.
`test:profile` is an alias for `test`, and `test:parallel` explicitly selects two workers.
Launcher type checks and tests run first, so a Launcher failure does not wait for the full
server suite. Each verification command prints its elapsed time and exit code.
`verify-summary.json` preserves stage results, failures and test-report locations. Actions
also shows a verification summary. Missing artifacts from an ordinary unsharded run produce
a warning. A sharded Windows gate fails when required evidence is missing.
`bun run verify --test-mode=timing` selects timing collection for the server tests only.
Local commands default to `full`. CI and Release explicitly select `timing` for server
tests on every platform. Invalid mode values fail before verification starts.

Continuity integration tests are split into adapter, HTTP, compaction, recovery and checkpoint
files. Each file owns its fixture cleanup. Bun can distribute these files across workers;
tests within each file remain serial, including the 600-request compaction stress cases.
Selected manual protocol scenarios explicitly use an in-process MCP transport. Each
fixture owns its client and server. Both transports use the same production tool registration,
SDK validation and error mapping. These scenarios still use the real broker socket,
registration/recovery files and helper HTTP. The default fixture uses CLI stdio.
Process exit, cancellation, restart, ownership and persistence checks keep their real
system boundaries. The paired MCP contracts also run through CLI stdio.

CI uploads `test-performance-<OS>-workers-<N>-attempt-<attempt>` for Linux/macOS and
`test-performance-windows-latest-workers-<N>-full-attempt-<attempt>` for an unsharded
Windows run. Release uploads `test-performance-release-<runner>` for unsharded platform
verification. Windows shard artifacts include the shard number and run attempt. Reports
are uploaded even when tests fail. `CGW_TEST_PROFILE_DIR` selects the
report output directory; it does not change the test entry point or worker count. A run contains:

- `file-timings.json`: Bun's measured duration for each test file.
- `summary.json`: platform, Bun version, revision, worker count, test exit code, wall time,
  and aggregate operation counters.
- `processes/*.json` in full mode: snapshots from test globals and child processes. They contain counts
  and durations, without paths, process start identities, request content or credentials.
- `stdout.log` and `stderr.log`: original test output, including failed and filtered tests.

The counters measure backend process identity probes, file and directory `fsync`, and
Windows file replacement retry waits. `rename.retryWait.count` is the retry count; its
`totalMs` is the measured wait time. `errors` counts operations that throw. Identity probes
return `null` when the OS cannot verify identity, so this is not an identity-failure count.
Launcher Electron operations are not included in these backend counters.

Recovery persistence adds these counters:

- `recovery.write`: recovery journal and migration marker write attempts, including file
  flush, replacement and the required directory flush.
- `recovery.noop`: transactions whose validated business state did not change.
- `recovery.confirm`: explicit file/directory flushes when the current process has no valid
  proof that the exact current file was durably committed.
- `recovery.reuse`: count of successful proof reuse, without another flush. Its duration is
  only counter bookkeeping; it does not measure the proof's file reads.
- `recovery.proofReuse`: the actual proof lookup, file reads, identity checks and hash.
- `recovery.proofRemember`: proof creation after a successful write or explicit flush.
- `recovery.lockWait`: lock publication and owner checks before the transaction starts.
- `recovery.transaction`: the locked operation; it includes reads, validation, writes and proofs.
- `recovery.read`, `recovery.parse`, `recovery.validate`: fresh reads and document checks.

`processIdentity.local` measures eager module initialization. `processIdentity.localUse`
counts consumption of that identity. `processIdentity.fresh` measures live-owner checks.
These contain the existing `processIdentity` probe counter; their times must not be added.
No liveness or identity cache policy changes as part of this instrumentation.

The adapter and recovery-compaction tests use static test labels and table row indices to
create stable scenario and parameter hashes. Parameter objects are not serialized or read
to make IDs. Unmatched rows have a null parameter ID; `unassignedParameterTests` gives their
test count. Equal duplicate rows can share the first matching row ID.
An unknown callback completion boundary makes the evidence incomplete; its original
arguments still reach the test unchanged.
Reports include the relative test file, fixture mode, PID and worker
ID. Controlled Bun children inherit this context. Other tests and module initialization
remain in an explicit unassigned bucket. The profiler does not distribute their costs
across named cases. `fixture.prepare`, `fixture.firstRequest`, `request.total` and cleanup
phases measure the work needed to reach assertions. The adapter fixture also records
store, HTTP, broker and MCP preparation. A cleanup count can contain more than one resource
per fixture; it is not a fixture count. `fixture.prepare.count` is the fixture count.

All phase times use `process.hrtime.bigint()`. Async phases finish after their Promise
settles. `test.total`, `fixture.prepare`, `fixture.firstRequest`, `request.total`,
`recovery.transaction`, `recovery.noop` and `fixture.cleanup` include child operations.
For example, `recovery.noop` can include `recovery.proofReuse`; that proof cost is not an
additional independent saving. `recovery.reuse` keeps its original bookkeeping meaning.

`totalBytes` records the encoded bytes supplied to recovery writes and confirmations,
including failed attempts. It is not the number of bytes proved durable. Old reports without
this field contribute zero bytes. Recovery operation timings include nested `fsync` timings;
do not add them together as independent costs.

Unchanged transactions keep their version after a fresh locked read, authority checks and
transition validation. A bounded process-local proof can avoid another flush only for the
same complete contents, file identity/change metadata and canonical parent directory identity.
It does not cache authority or process liveness. Replacement, an uncertain write or a process
restart requires confirmation again. Unsupported file identity falls back to flushing.
Version 2/3 format promotion still writes version 4. Real state changes still commit before
external effects. Optional tool-result body accounting is batched after the durable terminal
results; a rejected batch falls back to independent reservations without undoing those results.

Page-lifetime maintenance reads and validates the current journal and registrations on every
call. Healthy version 4 state needs no maintenance locks or writes when no writer is observed
before or after the reads. This is not an execution permit or an atomic snapshot. Migration,
damage, legacy entries, orphan registrations and observed writers use the original locked
path and read the evidence again. Admission, execution and state-changing transactions keep
their locks and authority checks.

Counters are disabled unless the profiler sets `CGW_RUNTIME_PERFORMANCE_DIR`. The profiler
flushes before a test file's isolated global is discarded and at normal process exit. A
version 3 snapshot is also written at startup. Each isolated test global has its own
ledger and completion evidence; a later worker completion cannot finish an earlier global. A killed process can leave an unfinished
snapshot. Bun child starts and exits, including Bun's `node:child_process` implementation,
are recorded separately; runtime children receive a runtime-only preload. Native programs
are tracked for exit status and do not produce backend counters. Tests that explicitly
use a separate diagnostic report directory keep that directory; the parent records this
exclusion. Missing children, signals, unfinished operations/globals, corrupt reports and
unidentified source make metrics incomplete. The narrow `expectTestChildExit([1], action)`
helper can declare a specific negative-case exit when starting a child. The test must still
assert that status and its rejection semantics. A declaration does not exempt missing reports,
signals or unfinished operations. Undeclared nonzero exits appear in `childResultIssues`
and are rejected by successful-path comparisons, even if collection is complete. Expected crash tests can therefore pass while
their performance report remains incomplete. A successful test exit does not prove complete
metrics. Report and log I/O failures preserve the test exit code and still wait for the test
process. Child-start counters must match the ledger for each parent process; a lost ledger
or failed ledger write makes the evidence incomplete. Comparison refuses incomplete
metrics and does not report a speedup for them.

Version 3 separates `testResult`, `collection` and `wallValid`. Assertion failure does not
by itself make collection incomplete, and complete collection does not make a failed run
valid performance evidence. `wallMs` remains root-process execution time. `segments` adds
preparation, post-exit log draining and report aggregation. `completion.json` records
the later point after summary serialization, persistence and status output. It identifies
the same run and explicitly excludes its own small write and process shutdown. Parent
comparison/verification processes separately record `wrapperExitMs` through actual child
exit. Strict v3 comparison rejects a missing or invalid completion record. Log draining has a five-second limit after root exit; this is not worker
crash detection. The actual executable path/digest and whether it is the prepared embedded
Bun are recorded. Preparing a Windows packaging runtime does not select it for tests.

Version 4 also separates file measurement from history publication. `fileTiming.version=2`
checks the target, executed and measured file sets. `complete` applies to the selected
target; `fullSuite` separately identifies a complete, unfiltered suite. Test success,
source stability and operation completeness remain separate fields. A history write failure
does not erase valid file measurements. `historyPublication.status` is `not-requested`,
`ineligible`, `succeeded` or `failed`; `stage` identifies the failed action. Success covers
local history output and artifact staging. `remoteUpload=not-observed` never claims that
Actions uploaded an artifact. Version 2/3 summaries keep their original file-timing meaning;
a historical publication failure alone does not establish measurement completeness.

Version 3 records the actual checkout SHA, dirty status and patch digest, measurement tool
digest, Bun and installed Node versions, OS/architecture, runner image, command, timestamps
and test counts. `workflowRevision` records `GITHUB_SHA` separately. The measurement patch
must be identical in both versions. `measurementFiles` lists content hashes for the collector,
drivers and every production/test probe file. `toolDigest` includes this full manifest.
The version driver requires whole-file equality for these files. This conservative check
also rejects a business change in a probe file; such a change needs a separately reviewed
measurement/coverage comparison before it can support a performance conclusion.
Old version 2 summaries retain their original completeness gate; they do not gain v3
evidence from a successful exit. Version 1 snapshots retain their old counters; added
phase fields stay unknown (`null`). Their missing provenance/completeness cannot support a
new formal performance conclusion. Repeated flushes replace the same snapshot; duplicate
snapshot IDs are rejected.
Aggregate operation time can overlap between processes; it is not wall time. Operation
totals cover the selected suite; run a single file to attribute those totals to that file.

## Compare serial and two-worker runs

```sh
bun run test --parallel=1 --isolation=isolate
bun run test --parallel=2 --isolation=isolate
```

Reports go to separate run directories under ignored `output/test-performance/`. Set
`CGW_TEST_PROFILE_DIR` to choose another output directory. To profile the recovery tests:

```sh
bun run test --parallel=1 tests/session-continuity tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
bun run test --parallel=2 tests/session-continuity tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
```

For controlled worker measurements, use the manual diagnostic workflow or explicitly
select `--isolation=isolate` for both worker counts. The ordinary wrapper keeps its prior
default: one worker omits `--parallel`, while two workers use Bun's default file isolation.
Those ordinary calls differ in both worker count and isolation; tests within a file stay serial. Repeat each setting and compare failures as well
as wall time. Keep failures in the comparison. A faster local macOS run does not establish
a Windows improvement.

Each run starts with a new timing output. With no explicit history source, scheduling
is cold. When history is enabled, a separate fixed input snapshot supplies prior durations;
only files observed in the current run remain in its output. The `tests/session-continuity` path filter selects all continuity test files,
including the split integration suite. Compare the complete selected set when evaluating
file distribution. Do not remove durability checks, cache PID liveness, or skip recovery
tests to improve a benchmark.

## Repeat a comparison on one runner

```sh
bun run test:compare
bun run test:compare --repetitions=1 tests/continuity-recovery-store.test.ts
```

Worker comparisons use explicit file isolation by default. `--isolation=default` selects
the original wrapper behavior and permits old v2 reports without inventing isolation
evidence. Use `--mode=timing` for a wall-clock-only comparison; default `full` still requires
complete operation reports.

The default runs workers in the order `1, 2, 2, 1`. `--repetitions=1|2|3` selects the number
of runs for each worker count. Every run starts with fresh timing data and a separate report
directory. Tests that fail do not stop the later measurements. `comparison.json` keeps every
exit code and summary path, and reports failure rates and wall times for both worker counts.
Missing or invalid reports, and any failed run, make `valid` false and leave `speedup` unset
(`null`). A shorter failed test run is not a performance improvement.

The manually dispatched **Release test diagnostics** workflow selects Windows or Intel
macOS, a continuity pair, the CLI file, or the full server suite. It runs original calls,
controlled isolated 1/2-worker calls and full/timing collection calls, retaining every
repetition. Windows can explicitly select the installed or prepared baseline executable.
The continuity pair is diagnostic input; its order is not claimed to match the historical
crash. A single CLI file does not prove two workers ran. Full-mode process ledgers show
observed workers; timing mode does not collect worker identities. The workflow uploads
original reports even when tests fail. Select the same
revision when comparing changes. A local report's `revision` is its base HEAD;
`workingTreeDirty` identifies uncommitted changes, so that revision alone does not identify
the measured source. Keep individual investigation notes and measurement logs in
the current task's `.dev-workflows/<task>/evidence/`, outside permanent project documentation.

This worker-count comparison is not a version A/B comparison. For two prepared checkouts
with the accepted clock repair and identical profiling support, use:

```sh
bun run scripts/compare-test-versions.ts --baseline=/path/to/A --candidate=/path/to/B tests/session-continuity
```

The driver fixes two workers. The strict operation path requires equal measurement tools. Both checkouts need frozen root and
launcher dependencies, the same lockfiles, runtime and install/warmup/cache policy. It
does not create checkouts or reuse mutable fixtures or build products. It checks actual
source/tool digests and all reports, keeps failures, and requires equal test counts. For changed fixture or test layers, use the explicit `--wall-clock --coverage-map=/path/map.json`
path. Its version 1 map binds `sources.A` and `sources.B` (revision, patchDigest, toolDigest),
`files.A` and `files.B`, nonempty `scenarios` with `id`, `A` and `B` labels, and
`expectedCounts.A` / `expectedCounts.B` with explicit `pass` and `skip` counts. Each
side must run at least one passing test and match its reviewed counts on every repetition;
failures and undeclared skip changes are rejected. Review this
semantic mapping before use. That path runs the same external timer against both checkouts,
uses three alternating pairs (AB, BA, AB), records tool-file differences, and permits changed
pass counts only through the supplied mapping. It does not compare operation counts. Each
valid pair must have a shorter candidate time to report a repeatable benefit. Mixed directions
produce `insufficient-evidence`. This is not a statistical significance claim. A local macOS
result is not Windows acceptance.

To compare the wrapper under a fixed collection and isolation condition, specify both:

```sh
bun run scripts/compare-test-versions.ts --baseline=/path/to/A --candidate=/path/to/B --wall-clock --mode=full --isolation=default --coverage-map=/path/map.json
```

The driver saves `measurement-tools.json`. Freeze these tools before fixture migration;
reuse the manifest with `--measurement-manifest=/path/measurement-tools.json`. Both checkouts
must contain the same collector, wrapper, driver and timer bytes. Changed fixture and
business probe files need explicit `measurementChanges` entries with `file`, `reason` and
mapped `scenarioIds`. Read the old and new assertions to check the mapping. JSON validation
alone does not prove equivalent behavior. The external clock stops when the wrapper exits;
parent log draining and report reads are separate. Omitting mode and isolation keeps the
older direct Bun/isolate path and its own execution conditions.
The wrapper map also declares `preparation` with `installation`, `warmup`, `cache` and
`cleanup` policies. If tests skip, `expectedSkips.A` and `expectedSkips.B` must list each
`test` (file and name) and reviewed `reason`. All attempts remain in the report.

## Collection and failure diagnosis

```sh
bun run test --mode=timing --isolation=isolate tests/api-key-cli.test.ts
bun run scripts/diagnose-test-performance.ts --suite=continuity --repetitions=3
```

Timing mode records execution, exit, command, file durations and logs. It removes inherited
profiler variables and does not inject operation preloads into children. Its collection
status is `not-requested`; absence of operation reports is expected. CI and Release use
this mode. Local commands retain full mode and cold scheduling unless
`CGW_TEST_TIMING_HISTORY` names a validated history envelope. Release restores history
only for unsharded Linux/macOS verification. Windows shards and manual diagnosis stay cold.

For a full/timing comparison under the daily CI isolation condition, use:

```sh
bun run scripts/diagnose-test-performance.ts --condition=mode-pair --suite=all --history=cold --repetitions=3
```

The diagnostic workflow exposes the same `mode-pair` condition. It runs only full/default/2
and timing/default/2, in AB, BA, AB order. Each attempt gets a clean temporary directory.
CLI/source diagnostics and history publication are disabled for this comparison. The
report keeps every attempt, source/tool/runtime identities, commands, results, file scope,
skip evidence and external wrapper times. Requested workers are separate from observed
workers; timing does not add operation profiling to obtain worker evidence.

At least three valid pairs and a shorter timing wrapper in every valid pair are required
for a switch candidate. Failures, changed inputs, unknown skips or opposite results leave
the conclusion as insufficient evidence. Bun logs name skipped tests but do not provide
structured reasons; missing reason evidence remains unverified. A full operation report
can be incomplete while its wall-clock sample is valid. Timing intentionally has no
operation report. A diagnostic result does not change workflow configuration automatically.
Use full mode when operation counters or process ledgers are needed; daily CI and Release
use timing mode.
Use `--skip-evidence=/path/reviewed-skips.json` to supply reviewed reasons. Its version 1
document binds `source.revision`, `source.patchDigest` and `source.toolDigest`, and lists
`entries` with `file`, `name` and `reason`. Store it outside tracked source or in an ignored
directory. The driver records its SHA-256 and rejects changed, extra, duplicate or missing
entries for candidate qualification. It still runs and retains all attempts when evidence
is invalid. The workflow's optional `skip_evidence` JSON input supplies the same evidence.

`--bail=N` accepts a positive integer and passes Bun's native option unchanged. It can
stop dispatch after ordinary assertion failures; it is not a crash-only policy. Release
does not enable it. Neither exit code 3 nor matching stderr text proves a native Windows
crash. Crash-only detection, bounded tree cleanup and cross-platform acceptance remain
separate experiments.

`CGW_API_KEY_CLI_DIAGNOSTICS=1` enables named CLI startup/exit and cleanup records without
stdin, output or secret arguments. `CGW_CONTINUITY_SOURCE_DIAGNOSTICS=1` enables test-only
selector observations for repeat-checkpoint scenarios. These contain hashed identifiers,
source representations and existing state; they do not create recovery records or alter
source acceptance rules. Do not enable these diagnostic modes in timing comparisons.

## Timing history

Unsharded Linux/macOS Release verification can restore the most recent compatible
`test-timings-<runner>` artifact from this repository's Release or diagnostic workflow. `actions: read` is sufficient. The lookup and
download have a combined 20-second limit. No permission, expiry, corruption, incompatible
metadata and a first run all select cold scheduling and record the reason. Downloads contain
bounded numeric JSON; artifact content is not executed. OS, architecture, exact Bun version,
runner class, worker count, isolation, collection mode and timing format must match.

`CGW_TEST_TIMING_RESTORE=1` enables remote lookup. CI supplies a dedicated
`CGW_TEST_TIMING_TOKEN`, which is removed before tests start. `CGW_TEST_RUNNER_CLASS`
identifies the runner class. `CGW_TEST_TIMING_ARTIFACT_DIR` selects the publication directory.
Ordinary local tests do not make history requests.

A full successful platform run can create `history.json` when publication is requested and
the source is eligible. Its file gate checks actual file headers, Bun's final file count and fresh measured
values against the repository's test set. Filtered, bailed, failed, interrupted or incomplete
runs do not publish full-suite history. Old entries merged by Bun are removed from the current
output. This gate does not depend on operation-report completeness or other matrix jobs.
A diagnostic `all` run may publish complete results for its conditions; a CLI or continuity
subset cannot become full-suite history. New tests still run without history and deleted
files are ignored.
Ordinary CI is not a trusted history publisher. Its complete file measurements remain
usable, and its publication status is explicitly ineligible when an artifact output is requested.

For a repeatable local input, point `CGW_TEST_TIMING_HISTORY` at a prior compatible
`history.json`. The wrapper copies and validates it before the run. Reports record the input
digest and source SHA/run/artifact. Compare `wrapperExitMs`, including preparation and lookup,
when assessing net scheduling benefit. A restored history is not proof of a performance gain.

## Windows verification and release gates

CI and Release run the Windows server suite in two jobs, with two workers in each job
and timing collection. Shard 1 also runs all other verify stages and the Windows
PowerShell 5.1 installer syntax check. Shard 2 runs only its server-test subset.
Packaging and smoke checks run in parallel with these jobs.

The CI check `verify (windows-latest)` requires both shards, complete aggregate evidence
and `Windows package and smoke` to succeed. Release publication also requires all five
platform builds and the Windows aggregate to succeed. Failure, cancellation, a missing
artifact or a skipped required job cannot satisfy these gates. Linux/macOS retain full
verification, packaging, smoke and platform-specific signature or ABI checks.

Manual CI accepts `windows_test_topology=single` to run the complete Windows suite in one
job. The default is `sharded`. `test_workers=auto|2` uses two workers per test job; `1`
selects serial execution. Local `bun run test` and `bun run verify` still run the complete
suite without a shard argument.

```sh
bun run test --mode=timing --shard=1/2 --parallel=2
bun run test --mode=timing --shard=2/2 --parallel=2
bun run verify --test-mode=timing --test-shard=1/2
```

Shards use Bun 1.4.3 cold file allocation. They reject path/name filters, bail, invalid or
duplicate shard numbers, and explicit `CGW_TEST_TIMING_*` variables. They do not restore
or publish history. Each shard has an independent output directory and artifact; artifacts
from different workflow runs or attempts cannot be combined.

Shard summaries use schema v5 and file-timing schema v3. `fullSuite=false` means that each
report covers only its assigned subset. Unsharded reports retain schema v4. The independent
aggregate checks the exact repository file union, each expected/executed/measured subset,
source and tool identities, both lockfiles, runtime, workers, mode, isolation, exit state,
logs, completion records and shard 1's non-server stages. Only a successful aggregate
claims complete multi-job coverage. Windows checkouts preserve repository bytes before
source hashes are computed.

## Reviewed Windows skips

`.github/windows-test-skips.json` stores each permitted Windows skip by test file, test
name and reason, with a content hash for every source file. The gate checks those hashes
against its checkout, binds the policy to the current source, and requires the observed
skip identities to match exactly. It never generates an allowlist from the current run.

When a listed test file changes, review its skip conditions and update the affected hash
and entries in the same change. New skips require a reason; removing a test or enabling it
also requires updating the policy. Do not refresh hashes without checking the conditions.
Missing entries, duplicate identities, changed source bytes or unknown skips fail the gate.

```sh
bun run scripts/aggregate-test-shards.ts --artifacts=/path/to/separate-artifacts --job-results=/path/to/jobs.json --output=/path/to/aggregate.json --skip-policy=.github/windows-test-skips.json --mode=timing
```

`jobs.json` contains the actual final states of `shard1`, `shard2` and `package`.
The CLI binds evidence to `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
`GITHUB_REPOSITORY` and `CGW_TEST_WORKERS=1|2` (default 2). `--mode` defaults to `full`
for standalone use. An explicitly supplied `--skip-evidence` retains the source-bound
version 1 evidence format; it cannot be combined with `--skip-policy`.

Required-check settings are managed separately from workflow files. The CI retains
`verify (windows-latest)` and `Windows package and smoke` check names.
