# CI test performance

Normal CI runs the server tests serially. Launcher type checks and tests run first, so a
Launcher failure does not wait for the full server suite. Each verification command prints
its elapsed time and exit code.

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
