import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunItems, packageJobResult, selectShardArtifacts } from "../scripts/select-test-shard-artifacts";

const revision = "a".repeat(40);
const identity = { repository: "owner/repo", runId: "42", revision, runHeadRevision: revision, gateAttempt: "4" };
test("package result selects the Windows job across partial reruns and ignores other platforms", () => {
  const name = "build (windows-latest, codex-chatgpt-web-windows-amd64.zip)";
  const job = { id: 1, name, run_attempt: 1, head_sha: revision, status: "completed", conclusion: "success",
    started_at: "2026-10-23T01:00:00Z", completed_at: "2026-10-23T01:10:00Z" };
  const jobs = [job, { ...job, id: 2, name: "build (ubuntu-latest, linux.tar.gz)", conclusion: "failure" }];
  expect(packageJobResult(jobs, identity, name)).toBe("success");
  jobs.push({ ...job, id: 3, run_attempt: 4, conclusion: "failure" });
  expect(packageJobResult(jobs, identity, name)).toBe("failure");
  expect(packageJobResult(jobs, { ...identity, gateAttempt: "3" }, name)).toBe("success");
  for (const defect of [
    { status: "in_progress" }, { head_sha: "b".repeat(40) }, { conclusion: "cancelled" },
  ]) expect(packageJobResult([{ ...job, ...defect }], identity, name)).not.toBe("success");
  expect(packageJobResult([], identity, name)).toBe("failure");
  expect(packageJobResult([job, { ...job, id: 4 }], identity, name)).toBe("failure");
});
function fixture(intel = false) {
  const jobName = intel ? "Intel server tests" : "Windows server tests";
  const prefix = intel ? "test-performance-macos-15-intel-workers-2" : "test-performance-windows-latest-workers-2";
  const jobs = [1, 2, 3, 4].flatMap(attempt => [1, 2].map(index => ({
    id: attempt * 10 + index, name: `${intel ? "intel / " : ""}${jobName} (${index}/2)`, run_attempt: attempt, head_sha: revision,
    status: "completed", conclusion: index === 1 && attempt < 4 ? "failure" : "success",
    // Shard 2 was retained from attempt 1. Its IDs and run_attempt values change.
    started_at: `2026-10-22T0${index === 2 ? 1 : attempt}:00:00Z`,
    completed_at: `2026-10-22T0${index === 2 ? 1 : attempt}:10:00Z`,
  })));
  const artifacts = [1, 2, 3, 4].flatMap(attempt => [1, 2].filter(index => index === 1 || attempt === 1).map(index => ({
    id: attempt * 100 + index, name: `${prefix}-shard-${index}-of-2-attempt-${attempt}`, expired: false,
    workflow_run: { id: 42, head_sha: revision },
  })));
  return { jobs, artifacts, select: () => selectShardArtifacts(jobs, artifacts, identity, jobName, prefix) };
}

for (const intel of [false, true]) test(`${intel ? "Intel reusable" : "Windows"} selection resolves retained jobs to their original reports`, () => {
  const input = fixture(intel);
  // Future reruns must not affect an older gate, and API ordering is not significant.
  input.jobs.push({ ...input.jobs[0]!, id: 51, run_attempt: 5, conclusion: "failure" });
  input.jobs.reverse(); input.artifacts.reverse();
  expect(input.select()).toMatchObject({ ...identity, shards: [
    { index: 1, attempt: "4", jobId: 41, artifactId: 401 },
    { index: 2, attempt: "1", jobId: 12, artifactId: 102 },
  ] });
});

test("selection supports rerunning only the gate or all jobs", () => {
  const input = fixture();
  expect(selectShardArtifacts(input.jobs, input.artifacts, { ...identity, gateAttempt: "5" }, "Windows server tests",
    "test-performance-windows-latest-workers-2").shards.map(shard => shard.attempt)).toEqual(["4", "1"]);
  const shard2 = input.jobs.find(job => job.id === 42)!;
  shard2.started_at = "2026-10-22T04:01:00Z"; shard2.completed_at = "2026-10-22T04:11:00Z";
  input.artifacts.push({ ...input.artifacts[1]!, id: 402,
    name: "test-performance-windows-latest-workers-2-shard-2-of-2-attempt-4" });
  expect(input.select().shards.map(shard => shard.attempt)).toEqual(["4", "4"]);
});

test("PR report selection uses the API head SHA while preserving the tested merge revision", () => {
  const input = fixture(), runHeadRevision = "b".repeat(40);
  for (const job of input.jobs) job.head_sha = runHeadRevision;
  for (const artifact of input.artifacts) artifact.workflow_run.head_sha = runHeadRevision;
  expect(selectShardArtifacts(input.jobs, input.artifacts, { ...identity, runHeadRevision }, "Windows server tests",
    "test-performance-windows-latest-workers-2")).toMatchObject({ revision, runHeadRevision,
      shards: [{ index: 1, attempt: "4" }, { index: 2, attempt: "1" }] });
  input.artifacts.at(-1)!.workflow_run.head_sha = revision;
  expect(() => selectShardArtifacts(input.jobs, input.artifacts, { ...identity, runHeadRevision }, "Windows server tests",
    "test-performance-windows-latest-workers-2")).toThrow("different-source artifact");
});

const defects: [string, (input: ReturnType<typeof fixture>) => void][] = [
  ["failed latest job", input => { input.jobs.find(job => job.id === 41)!.conclusion = "failure"; }],
  ["cancelled latest job", input => { input.jobs.find(job => job.id === 41)!.conclusion = "cancelled"; }],
  ["unfinished latest job", input => { input.jobs.find(job => job.id === 41)!.status = "in_progress"; }],
  ["different job revision", input => { input.jobs.find(job => job.id === 41)!.head_sha = "b".repeat(40); }],
  ["missing latest report", input => { input.artifacts.pop(); }],
  ["expired latest report", input => { input.artifacts.at(-1)!.expired = true; }],
  ["different artifact run", input => { input.artifacts.at(-1)!.workflow_run.id = 41; }],
  ["different artifact revision", input => { input.artifacts.at(-1)!.workflow_run.head_sha = "b".repeat(40); }],
  ["duplicate artifact", input => { input.artifacts.push({ ...input.artifacts.at(-1)!, id: 999 }); }],
  ["duplicate job attempt", input => { input.jobs.push({ ...input.jobs.find(job => job.id === 41)!, id: 999 }); }],
  ["ambiguous reusable callers", input => { input.jobs.push({ ...input.jobs.find(job => job.id === 41)!, id: 999,
    name: "another / Windows server tests (1/2)" }); }],
  ["missing shard job", input => { input.jobs.splice(0, input.jobs.length, ...input.jobs.filter(job => !job.name.endsWith("(2/2)"))); }],
];
for (const [name, change] of defects) test(`selection rejects ${name} without falling back to older success`, () => {
  const input = fixture(); change(input);
  expect(input.select).toThrow();
});

test("the API reader paginates jobs with filter=all and artifacts before selection", async () => {
  for (const kind of ["jobs", "artifacts"] as const) {
    const requests: string[] = [];
    const result = await listRunItems("https://api.github.com", "owner/repo", "42", kind, "test-token", (async (url: string, init: RequestInit) => {
      requests.push(url);
      expect(init.headers).toMatchObject({ Authorization: "Bearer test-token" });
      return Response.json({ [kind]: requests.length === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [{ id: 100 }] });
    }));
    expect(result).toHaveLength(101);
    expect(requests).toEqual([1, 2].map(page => `https://api.github.com/repos/owner/repo/actions/runs/42/${kind}?per_page=100&page=${page}${kind === "jobs" ? "&filter=all" : ""}`));
  }
  await expect(listRunItems("https://api.github.com", "owner/repo", "42", "jobs", "test-token",
    async () => new Response(null, { status: 403 }))).rejects.toThrow("HTTP 403");
});

for (const pullRequest of [false, true]) test(`the selector CLI writes selected IDs for ${pullRequest ? "PR merge" : "push"} reports`, async () => {
  const input = fixture(true), directory = mkdtempSync(join(tmpdir(), "shard-selection-"));
  const runHeadRevision = pullRequest ? "b".repeat(40) : revision;
  const packageName = "build (windows-latest, codex-chatgpt-web-windows-amd64.zip)";
  input.jobs.push({ ...input.jobs[0]!, id: 99, name: packageName, conclusion: "success" },
    { ...input.jobs[0]!, id: 100, name: "build (ubuntu-latest, linux.tar.gz)", conclusion: "failure" });
  for (const job of input.jobs) job.head_sha = runHeadRevision;
  for (const artifact of input.artifacts) artifact.workflow_run.head_sha = runHeadRevision;
  const server = Bun.serve({ port: 0, fetch(request) {
    if (request.headers.get("authorization") !== "Bearer test-token") return new Response(null, { status: 403 });
    const url = new URL(request.url);
    if (url.pathname.endsWith("/jobs") && url.searchParams.get("filter") === "all") return Response.json({ jobs: input.jobs });
    if (url.pathname.endsWith("/artifacts")) return Response.json({ artifacts: input.artifacts });
    return new Response(null, { status: 404 });
  } });
  try {
    const output = join(directory, "outputs"), manifest = join(directory, "selection.json");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/select-test-shard-artifacts.ts")], {
      env: { ...process.env, GITHUB_API_URL: server.url.origin, GH_TOKEN: "test-token", GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "42", GITHUB_SHA: revision, SHARD_RUN_HEAD_SHA: runHeadRevision, GITHUB_RUN_ATTEMPT: "4", GITHUB_OUTPUT: output,
        SHARD_JOB_NAME: "Intel server tests", SHARD_ARTIFACT_PREFIX: "test-performance-macos-15-intel-workers-2",
        SHARD_PACKAGE_JOB_NAME: packageName,
        SHARD_SELECTION_PATH: manifest }, stdout: "pipe", stderr: "pipe",
    });
    const [, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual(selectShardArtifacts(input.jobs, input.artifacts,
      { ...identity, runHeadRevision }, "Intel server tests", "test-performance-macos-15-intel-workers-2"));
    expect(readFileSync(output, "utf8")).toBe("package-result=success\nshard-1-id=401\nshard-2-id=102\n");
  } finally { server.stop(true); rmSync(directory, { recursive: true, force: true }); }
});
