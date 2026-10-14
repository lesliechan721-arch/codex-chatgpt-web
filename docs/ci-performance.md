# CI test performance

Normal CI runs the server tests with two workers on Windows and one worker on Linux and
macOS. Manual CI runs use the same defaults when `test_workers` is `auto`; selecting `1`
or `2` overrides the worker count on every OS in that run. Launcher type checks and tests
run first, so a Launcher failure does not wait for the full server suite. Each verification
command prints its elapsed time and exit code.

CI profiles the server tests and uploads `test-performance-<OS>-workers-<N>` even when tests
fail. A run contains:

- `file-timings.json`: Bun's measured duration for each test file.
- `summary.json`: platform, Bun version, revision, worker count, test exit code, wall time,
  and aggregate operation counters.
- `processes/*.json`: snapshots from test globals and child processes. They contain counts
  and durations, without paths, process start identities, request content or credentials.

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

`totalBytes` records the encoded bytes supplied to recovery writes and confirmations,
including failed attempts. It is not the number of bytes proved durable. Old reports without
this field contribute zero bytes. Recovery operation timings include nested `fsync` timings;
do not add them together as independent costs.

Unchanged transactions keep their version after a fresh locked read, authority checks and
transition validation. A bounded process-local proof can avoid another flush only for the
same complete contents, file identity/change metadata and canonical parent directory identity.
It does not cache authority or process liveness. Replacement, an uncertain write or a process
restart requires confirmation again. Unsupported file identity falls back to flushing.
Version 2 format promotion still writes version 3. Real state changes still commit before
external effects. Optional tool-result body accounting is batched after the durable terminal
results; a rejected batch falls back to independent reservations without undoing those results.

Counters are disabled unless the profiler sets `CGW_RUNTIME_PERFORMANCE_DIR`. The profiler
flushes before a test file's isolated global is discarded and at normal process exit. A
process killed without cleanup can lose its last counters. Invalid reports are listed in
the summary. Report I/O failures print a warning and preserve the test exit code.
Aggregate operation time can overlap between processes; it is not wall time. Operation
totals cover the selected suite; run a single file to attribute those totals to that file.

## Compare serial and two-worker runs

```sh
bun run test:profile
bun run test:parallel
```

Reports go to separate run directories under ignored `output/test-performance/`. Set
`CGW_TEST_PROFILE_DIR` to choose another output directory. To profile the recovery tests:

```sh
bun run test:profile tests/session-continuity-adapter.test.ts tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
bun run test:parallel tests/session-continuity-adapter.test.ts tests/continuity-recovery-compaction.test.ts tests/continuity-task-update.test.ts tests/continuity-recovery-store.test.ts
```

For hosted measurements, manually run the CI workflow on the same revision with
`test_workers` set to `1`, then `2`. This selects Bun 1.4.2 file-level parallelism with fresh
globals; tests within a file stay serial. Repeat each setting and compare failures as well
as wall time. Keep failures in the comparison. A faster local macOS run does not establish
a Windows improvement.

Each run starts with an empty timing file, so earlier measurements do not change file
scheduling. Splitting a large test file is a separate experiment after the two-worker
measurements. Do not remove durability checks, cache PID liveness, or skip recovery tests
to improve a benchmark.

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
`.dev-workflows/windows-performance/evidence/`, outside permanent project documentation.
