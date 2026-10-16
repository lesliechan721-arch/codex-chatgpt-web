# CI test performance

Local runs, CI and release verification use `bun run test` for the server tests, with two
workers by default on every OS. Set `CGW_TEST_WORKERS=1` or pass `--parallel=1` to run serially;
the command-line option takes precedence. Manual CI runs use two workers when `test_workers`
is `auto`; selecting `1` or `2` overrides the worker count on every OS in that run.
`test:profile` is an alias for `test`, and `test:parallel` explicitly selects two workers.
Launcher type checks and tests run first, so a Launcher failure does not wait for the full
server suite. Each verification command prints its elapsed time and exit code.

Continuity integration tests are split into adapter, HTTP, compaction, recovery and checkpoint
files. Each file owns its fixture cleanup. Bun can distribute these files across workers;
tests within each file remain serial, including the 600-request compaction stress cases.

CI uploads `test-performance-<OS>-workers-<N>`, and release builds upload
`test-performance-release-<runner>`, even when tests fail. `CGW_TEST_PROFILE_DIR` selects the
report output directory; it does not change the test entry point or worker count. A run contains:

- `file-timings.json`: Bun's measured duration for each test file.
- `summary.json`: platform, Bun version, revision, worker count, test exit code, wall time,
  and aggregate operation counters.
- `processes/*.json`: snapshots from test globals and child processes. They contain counts
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
version 2 snapshot is also written at startup. A killed process can leave an unfinished
snapshot. Bun child starts and exits, including Bun's `node:child_process` implementation,
are recorded separately; runtime children receive a runtime-only preload. Native programs
are tracked for exit status and do not produce backend counters. Tests that explicitly
use a separate diagnostic report directory keep that directory; the parent records this
exclusion. Unknown, abnormal or missing children, unfinished globals, corrupt reports and
unidentified source make metrics incomplete. Expected crash tests can therefore pass while
their performance report remains incomplete. A successful test exit does not prove complete
metrics. Report and log I/O failures preserve the test exit code and still wait for the test
process. Child-start counters must match the ledger for each parent process; a lost ledger
or failed ledger write makes the evidence incomplete. Comparison refuses incomplete
metrics and does not report a speedup for them.

Version 2 records the actual checkout SHA, dirty status and patch digest, measurement tool
digest, Bun and installed Node versions, OS/architecture, runner image, command, timestamps
and test counts. `workflowRevision` records `GITHUB_SHA` separately. The measurement patch
must be identical in both versions. `measurementFiles` lists content hashes for the collector,
drivers and every production/test probe file. `toolDigest` includes this full manifest.
The version driver requires whole-file equality for these files. This conservative check
also rejects a business change in a probe file; such a change needs a separately reviewed
measurement/coverage comparison before it can support a performance conclusion.
Version 1 snapshots retain their old counters; added
phase fields stay unknown (`null`). Their missing provenance/completeness cannot support a
new formal performance conclusion. Repeated flushes replace the same snapshot; duplicate
snapshot IDs are rejected.
Aggregate operation time can overlap between processes; it is not wall time. Operation
totals cover the selected suite; run a single file to attribute those totals to that file.

## Compare serial and two-worker runs

```sh
bun run test --parallel=1
bun run test --parallel=2
```

Reports go to separate run directories under ignored `output/test-performance/`. Set
`CGW_TEST_PROFILE_DIR` to choose another output directory. To profile the recovery tests:

```sh
bun run test --parallel=1 tests/session-continuity tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
bun run test --parallel=2 tests/session-continuity tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
```

For hosted measurements, manually run the CI workflow on the same revision with
`test_workers` set to `1`, then `2`. This selects Bun 1.4.2 file-level parallelism with fresh
globals; tests within a file stay serial. Repeat each setting and compare failures as well
as wall time. Keep failures in the comparison. A faster local macOS run does not establish
a Windows improvement.

Each run starts with an empty timing file, so earlier measurements do not change file
scheduling. The `tests/session-continuity` path filter selects all continuity test files,
including the split integration suite. Compare the complete selected set when evaluating
file distribution. Do not remove durability checks, cache PID liveness, or skip recovery
tests to improve a benchmark.

## Repeat a comparison on one runner

```sh
bun run test:compare
bun run test:compare --repetitions=1 tests/continuity-recovery-store.test.ts
```

The default runs workers in the order `1, 2, 2, 1`. `--repetitions=1|2|3` selects the number
of runs for each worker count. Every run starts with fresh timing data and a separate report
directory. Tests that fail do not stop the later measurements. `comparison.json` keeps every
exit code and summary path, and reports failure rates and wall times for both worker counts.
Missing or invalid reports, and any failed run, make `valid` false and leave `speedup` unset
(`null`). A shorter failed test run is not a performance improvement.

The manually dispatched **Windows test performance comparison** workflow runs this command
on one Windows runner and uploads the original reports even when tests fail. Select the same
revision when comparing changes. A local report's `revision` is its base HEAD;
`workingTreeDirty` identifies uncommitted changes, so that revision alone does not identify
the measured source. Keep individual investigation notes and measurement logs in
the current task's `.dev-workflows/<task>/evidence/`, outside permanent project documentation.

This worker-count comparison is not a version A/B comparison. For two prepared checkouts
with the accepted clock repair and identical profiling support, use:

```sh
bun run scripts/compare-test-versions.ts --baseline=/path/to/A --candidate=/path/to/B tests/session-continuity
```

The driver fixes two workers and runs `A, B, B, A`. Both checkouts need frozen root and
launcher dependencies, the same lockfiles, runtime and install/warmup/cache policy. It
does not create checkouts or reuse mutable fixtures or build products. It checks actual
source/tool digests and all reports, keeps failures, and requires equal test counts. When
test layers change, review their coverage mapping before using a different driver. Overlap
between sample ranges produces `insufficient-evidence`; nonoverlap is engineering evidence,
not a statistical significance claim. A local macOS result is not Windows acceptance.

## Windows package checks

`verify (windows-latest)` runs complete verify, including installer syntax validation.
`Windows package and smoke` independently installs both frozen lockfiles, prepares the
same Bun 1.4.2 baseline runtime, packages the installer and runs its existing artifact
smoke. Neither Windows chain waits for the other. Linux/macOS keep their packaging and
smoke coverage. Both Windows statuses must succeed before Windows acceptance; failure,
cancellation or a skipped chain does not satisfy it. Configure both names as required
checks in repository branch protection/rulesets. Workflow results alone do not configure
that merge rule.

For a successful run, report server test wall time, the span from the first Windows job
start to the last Windows job finish, workflow creation to Windows readiness, total Windows
runner time, and whole-CI readiness. Do not compare the new verify job alone with the old
combined Windows job. Job queue time and additional preparation can reduce the net benefit.
