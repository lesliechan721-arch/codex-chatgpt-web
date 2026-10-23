import { appendFileSync, writeFileSync } from "node:fs";

export type ShardSelection = {
  version: 1;
  repository: string;
  runId: string;
  revision: string;
  // REST metadata uses the PR head; revision remains the tested merge commit.
  runHeadRevision: string;
  gateAttempt: string;
  shards: { index: number; attempt: string; jobId: number; artifactId: number; artifactName: string }[];
};
type Identity = Pick<ShardSelection, "repository" | "runId" | "revision" | "gateAttempt">;
type Job = { id: number; name: string; run_attempt: number; head_sha: string; status: string;
  conclusion: string | null; started_at: string; completed_at: string | null };
type Artifact = { id: number; name: string; expired: boolean; workflow_run?: { id: number; head_sha: string } };
type ShardFetch = (url: string, init: RequestInit) => Promise<Response>;
const positive = (value: unknown) => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));

/** A platform gate must use its package job, rather than the whole build matrix. */
export function packageJobResult(jobs: Job[], expected: Pick<ShardSelection, "gateAttempt" | "runHeadRevision">, name: string): "success" | "failure" {
  const candidates = jobs.filter(job => job.name === name && job.run_attempt <= Number(expected.gateAttempt));
  const attempt = Math.max(...candidates.map(job => job.run_attempt));
  const latest = candidates.filter(job => job.run_attempt === attempt);
  if (latest.length !== 1 || latest[0]!.head_sha !== expected.runHeadRevision || latest[0]!.status !== "completed") return "failure";
  return latest[0]!.conclusion === "success" ? "success" : "failure";
}

export function validateShardSelection(selection: any, expected: Identity): asserts selection is ShardSelection {
  if (selection?.version !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository)
    || !/^[a-f0-9]{40}$/.test(expected.revision) || !/^[a-f0-9]{40}$/.test(selection.runHeadRevision)
    || !positive(expected.runId) || !positive(expected.gateAttempt)
    || !["repository", "runId", "revision", "gateAttempt"].every(key => selection[key] === expected[key as keyof Identity])
    || !Array.isArray(selection.shards) || selection.shards.length !== 2
    || ![1, 2].every(index => selection.shards.filter((shard: any) => shard?.index === index).length === 1)
    || !selection.shards.every((shard: any) => positive(shard.attempt) && Number(shard.attempt) <= Number(expected.gateAttempt)
      && Number.isSafeInteger(shard.jobId) && shard.jobId > 0 && Number.isSafeInteger(shard.artifactId) && shard.artifactId > 0
      && typeof shard.artifactName === "string" && shard.artifactName.endsWith(`-shard-${shard.index}-of-2-attempt-${shard.attempt}`))
    || new Set(selection.shards.map((shard: any) => shard.artifactId)).size !== 2
    || new Set(selection.shards.map((shard: any) => shard.jobId)).size !== 2) {
    throw new Error("Invalid shard artifact selection or workflow identity.");
  }
}

/** Bind each report to the latest effective job, including jobs retained by partial reruns. */
export function selectShardArtifacts(jobs: Job[], artifacts: Artifact[], expected: Identity & Pick<ShardSelection, "runHeadRevision">,
  jobName: string, artifactPrefix: string): ShardSelection {
  const selection: ShardSelection = { version: 1, ...expected, shards: [] };
  for (const index of [1, 2]) {
    const suffix = `${jobName} (${index}/2)`;
    const candidates = jobs.filter(job => (job.name === suffix || job.name.endsWith(` / ${suffix}`))
      && job.run_attempt <= Number(expected.gateAttempt));
    if (!candidates.length || new Set(candidates.map(job => job.name)).size !== 1) throw new Error(`Missing or ambiguous job: ${suffix}`);
    candidates.sort((a, b) => b.run_attempt - a.run_attempt);
    const latest = candidates[0]!;
    if (candidates.filter(job => job.run_attempt === latest.run_attempt).length !== 1
      || latest.status !== "completed" || latest.conclusion !== "success" || latest.head_sha !== expected.runHeadRevision
      || !latest.started_at || !latest.completed_at) throw new Error(`Latest shard job did not succeed: ${suffix}`);
    // GitHub lists retained jobs again under each attempt, with new job IDs and
    // run_attempt values. Their original start and completion times stay the same.
    const original = candidates.filter(job => job.started_at === latest.started_at && job.completed_at === latest.completed_at)
      .sort((a, b) => a.run_attempt - b.run_attempt)[0]!;
    if (original.status !== "completed" || original.conclusion !== "success" || original.head_sha !== expected.runHeadRevision) {
      throw new Error(`Inconsistent retained shard job: ${suffix}`);
    }
    const attempt = String(original.run_attempt);
    const name = `${artifactPrefix}-shard-${index}-of-2-attempt-${attempt}`;
    const matches = artifacts.filter(artifact => artifact.name === name);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous artifact: ${name}`);
    const artifact = matches[0]!;
    if (artifact.expired || String(artifact.workflow_run?.id) !== expected.runId
      || artifact.workflow_run?.head_sha !== expected.runHeadRevision) throw new Error(`Expired or different-source artifact: ${name}`);
    selection.shards.push({ index, attempt, jobId: original.id, artifactId: artifact.id, artifactName: name });
  }
  validateShardSelection(selection, expected);
  return selection;
}

export async function listRunItems(api: string, repository: string, runId: string, kind: "jobs" | "artifacts",
  token: string, request: ShardFetch = fetch): Promise<any[]> {
  const items: any[] = [];
  for (let page = 1; ; page++) {
    const response = await request(`${api}/repos/${repository}/actions/runs/${runId}/${kind}?per_page=100&page=${page}${kind === "jobs" ? "&filter=all" : ""}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot list workflow ${kind}: HTTP ${response.status}`);
    const data = await response.json() as Record<string, any>;
    if (!Array.isArray(data[kind])) throw new Error(`Invalid workflow ${kind} response.`);
    items.push(...data[kind]);
    if (data[kind].length < 100) return items;
  }
}

if (import.meta.main) {
  try {
    const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
    const expected = { repository: required("GITHUB_REPOSITORY"), runId: required("GITHUB_RUN_ID"),
      revision: required("GITHUB_SHA"), runHeadRevision: required("SHARD_RUN_HEAD_SHA"), gateAttempt: required("GITHUB_RUN_ATTEMPT") };
    const api = required("GITHUB_API_URL"), token = required("GH_TOKEN");
    const [jobs, artifacts] = await Promise.all([
      listRunItems(api, expected.repository, expected.runId, "jobs", token),
      listRunItems(api, expected.repository, expected.runId, "artifacts", token),
    ]);
    if (process.env.SHARD_PACKAGE_JOB_NAME) {
      const result = packageJobResult(jobs, expected, process.env.SHARD_PACKAGE_JOB_NAME);
      appendFileSync(required("GITHUB_OUTPUT"), `package-result=${result}\n`);
    }
    const selection = selectShardArtifacts(jobs, artifacts, expected, required("SHARD_JOB_NAME"), required("SHARD_ARTIFACT_PREFIX"));
    writeFileSync(required("SHARD_SELECTION_PATH"), JSON.stringify(selection, null, 2) + "\n");
    for (const shard of selection.shards) {
      appendFileSync(required("GITHUB_OUTPUT"), `shard-${shard.index}-id=${shard.artifactId}\n`);
      console.info(`[test-shards] shard ${shard.index}: attempt ${shard.attempt}, job ${shard.jobId}, artifact ${shard.artifactId}`);
    }
  } catch (error) {
    console.error(`[test-shards] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
