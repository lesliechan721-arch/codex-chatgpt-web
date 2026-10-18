import { unzipSync } from "fflate";
import { HISTORY_MAX_BYTES, HISTORY_WORKFLOWS, parseTimingHistory, timingHistoryFilename,
  type TimingCompatibility, type TimingHistory, type TimingScheduling } from "./test-timing-history";

export type HistoryFetch = (input: string, init?: RequestInit) => Promise<Response>;
const ARCHIVE_MAX_BYTES = 2 * HISTORY_MAX_BYTES;
function fail(reason: string): never { throw new Error(reason); }
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

async function boundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail("response-too-large");
  if (!response.body) fail("empty-response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail("response-too-large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function artifactTimingHistory(archive: Uint8Array, compatibility: TimingCompatibility): TimingHistory {
  if (archive.byteLength > ARCHIVE_MAX_BYTES) fail("archive-too-large");
  const name = timingHistoryFilename(compatibility);
  let selected = 0, entries = 0;
  const files = unzipSync(archive, { filter(entry) {
    if (++entries > 100) fail("too-many-archive-entries");
    if (entry.name !== name) return false;
    if (++selected !== 1 || entry.size > ARCHIVE_MAX_BYTES || entry.originalSize > HISTORY_MAX_BYTES) fail("invalid-archive-entry");
    return true;
  } });
  if (selected !== 1 || !files[name]) fail("no-compatible-artifact-entry");
  return parseTimingHistory(files[name]!, compatibility);
}

/** This client only reads the current repository. It never uses archive-supplied URLs. */
export async function restoreArtifactHistory(options: {
  compatibility: TimingCompatibility; env: NodeJS.ProcessEnv; fetch?: HistoryFetch; budgetMs?: number;
}): Promise<{ history: TimingHistory; from: NonNullable<TimingScheduling["from"]> }> {
  const repository = options.env.GITHUB_REPOSITORY, token = options.env.CGW_TEST_TIMING_TOKEN;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("missing-repository");
  if (!token) fail("missing-actions-read-token");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetMs = options.budgetMs ?? 20_000;
  const fetcher = options.fetch ?? fetch;
  const api = `https://api.github.com/repos/${repository}`;
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
  const request = async (path: string, archive = false): Promise<Response> => {
    const response = await fetcher(`${api}${path}`, { headers, signal: controller.signal, redirect: "manual" });
    if (archive && response.status === 302) {
      const location = response.headers.get("location");
      if (!location) fail("missing-artifact-redirect");
      const url = new URL(location);
      if (url.protocol !== "https:" || url.username || url.password) fail("invalid-artifact-redirect");
      // Signed blob URLs get no repository token, including when another redirect follows.
      const download = await fetcher(url.href, { signal: controller.signal, redirect: "follow" });
      if (!download.ok) fail(`http-${download.status}`);
      return download;
    }
    if (!response.ok) fail(`http-${response.status}`);
    return response;
  };
  const json = async (path: string) => {
    const bytes = await boundedBody(await request(path), HISTORY_MAX_BYTES);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("invalid-api-json"); }
  };
  const validRun = (run: unknown, workflow?: string): run is Record<string, any> => record(run) && id(run.id) && id(run.workflow_id)
    && revision(run.head_sha) && run.status === "completed"
    && typeof run.created_at === "string" && Number.isFinite(Date.parse(run.created_at))
    && HISTORY_WORKFLOWS.some(path => run.path === path) && (workflow === undefined || run.path === workflow)
    && run.event === (run.path === HISTORY_WORKFLOWS[0] ? "push" : "workflow_dispatch")
    && record(run.repository) && id(run.repository.id) && String(run.repository.full_name).toLowerCase() === repository.toLowerCase()
    && record(run.head_repository) && run.head_repository.id === run.repository.id
    && String(run.head_repository.full_name).toLowerCase() === repository.toLowerCase();
  const lookup = async () => {
    const runs: Record<string, any>[] = [];
    let reason = "no-compatible-history";
    for (const workflow of HISTORY_WORKFLOWS) {
      try {
        const listed = await json(`/actions/workflows/${workflow.split("/").at(-1)}/runs?status=completed&per_page=10`);
        if (!record(listed) || !Array.isArray(listed.workflow_runs) || listed.workflow_runs.length > 10) fail("invalid-run-list");
        runs.push(...listed.workflow_runs.filter((run: unknown) => validRun(run, workflow)));
      } catch (error) {
        if (controller.signal.aborted) fail("history-lookup-timeout");
        reason = error instanceof Error && /^[a-z0-9:-]+$/.test(error.message) ? error.message : "workflow-list-unavailable";
        if (reason === "http-401" || reason === "http-403") fail(reason);
      }
    }
    const candidates = runs.filter(run => String(run.id) !== options.env.GITHUB_RUN_ID)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 10);
    for (const candidate of candidates) {
      try {
        // Fetch by the selected run ID and verify it again before reading its artifacts.
        const run = await json(`/actions/runs/${candidate.id}`);
        if (!validRun(run, candidate.path) || run.id !== candidate.id || run.workflow_id !== candidate.workflow_id || run.head_sha !== candidate.head_sha) fail("run-identity-mismatch");
        const listed = await json(`/actions/runs/${run.id}/artifacts?per_page=100`);
        if (!record(listed) || !Array.isArray(listed.artifacts) || listed.artifacts.length > 100) fail("invalid-artifact-list");
        for (const artifact of listed.artifacts) {
          if (!record(artifact) || artifact.name !== `test-timings-${options.compatibility.runnerClass}`) continue;
          if (!id(artifact.id) || artifact.expired !== false || typeof artifact.expires_at !== "string"
            || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now()) { reason = "expired-artifact"; continue; }
          if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > ARCHIVE_MAX_BYTES) { reason = "archive-too-large"; continue; }
          const source = artifact.workflow_run;
          if (!record(source) || source.id !== run.id || source.head_sha !== run.head_sha
            || source.repository_id !== run.repository.id || source.head_repository_id !== run.repository.id) { reason = "artifact-identity-mismatch"; continue; }
          const archive = await boundedBody(await request(`/actions/artifacts/${artifact.id}/zip`, true), ARCHIVE_MAX_BYTES);
          const history = artifactTimingHistory(archive, options.compatibility);
          if (history.source.repository?.toLowerCase() !== repository.toLowerCase() || history.source.runId !== String(run.id)
            || history.source.revision !== run.head_sha || history.source.workflow !== run.path) fail("history-identity-mismatch");
          return { history, from: { kind: "artifact" as const, runId: String(run.id), artifactId: artifact.id, revision: run.head_sha, workflow: run.path } };
        }
      } catch (error) {
        if (controller.signal.aborted) fail("history-lookup-timeout");
        reason = error instanceof Error && /^[a-z0-9:-]+$/.test(error.message) ? error.message : "invalid-artifact";
        if (reason === "http-401" || reason === "http-403") fail(reason);
      }
    }
    fail(reason);
  };
  try {
    return await Promise.race([
      lookup(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("history-lookup-timeout")); }, budgetMs); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
