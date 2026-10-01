import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface SourceLock {
  version: 3;
  repository: string;
  tag: string;
  revision: string;
}

export interface CodexRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  revision: string;
  assets: Array<{ name: string; browser_download_url: string; digest: string }>;
}

export function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, {
    cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return result.stdout;
}

export function releaseVersion(release: Pick<CodexRelease, "tag_name" | "draft" | "prerelease">): string {
  if (release.draft || release.prerelease || !/^rust-v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error(`Expected a stable Codex Rust release, received ${release.tag_name}`);
  }
  return release.tag_name.slice("rust-v".length);
}

async function githubJson<T>(path: string): Promise<T> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/openai/codex/${path}`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Cannot fetch Codex ${path}: HTTP ${response.status}`);
  return await response.json() as T;
}

export async function fetchRelease(tag?: string, lockedRevision?: string): Promise<CodexRelease> {
  const release = await githubJson<Omit<CodexRelease, "revision">>(`releases/${tag ? `tags/${encodeURIComponent(tag)}` : "latest"}`);
  releaseVersion(release);
  if (tag && release.tag_name !== tag) throw new Error(`Codex release tag mismatch: expected ${tag}`);
  type GitObject = { type: string; sha: string };
  let object = (await githubJson<{ object: GitObject }>(`git/ref/tags/${encodeURIComponent(release.tag_name)}`)).object;
  while (object.type === "tag") {
    object = (await githubJson<{ object: GitObject }>(`git/tags/${object.sha}`)).object;
  }
  const revision = object.sha;
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Cannot resolve official Codex release tag ${release.tag_name}`);
  if (lockedRevision && revision !== lockedRevision) throw new Error(`Locked Codex revision does not match official release ${release.tag_name}`);
  return { ...release, revision };
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyDigest(value: Uint8Array, digest: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || `sha256:${sha256(value)}` !== digest) {
    throw new Error("Codex release archive SHA-256 mismatch");
  }
}

export const SCHEMA_SOURCE_FILES = [
  "protocol/src/openai_models.rs",
  "protocol/src/openai_models/access_programs.rs",
  "protocol/src/openai_models/guardian.rs",
  "protocol/src/openai_models/guardian_v2.rs",
  "protocol/src/openai_models/reasoning_effort.rs",
  "protocol/src/config_types.rs",
  "protocol/src/protocol.rs",
  "protocol/src/turn_input.rs",
] as const;

export function verifySchemaSources(sourceRoot: string, sourceFiles: Record<string, string>): void {
  for (const file of SCHEMA_SOURCE_FILES) {
    if (sha256(readFileSync(join(sourceRoot, "codex-rs", file))) !== sourceFiles?.[file]) {
      throw new Error(`Codex ModelInfo schema source changed: ${file}; review and update the checked-in schema and its source fingerprints before syncing`);
    }
  }
}

export function verifySource(sourceRoot: string, tag: string, revision: string): string {
  const actual = run("git", ["rev-parse", "HEAD"], sourceRoot).trim();
  const tagged = run("git", ["rev-parse", `refs/tags/${tag}^{commit}`], sourceRoot).trim();
  if (actual !== tagged || actual !== revision) {
    throw new Error(`Codex source revision does not match release ${tag}`);
  }
  if (run("git", ["status", "--porcelain", "--untracked-files=no"], sourceRoot).trim()) {
    throw new Error("Codex release source has tracked changes");
  }
  return actual;
}

export function checkoutSource(directory: string, release: CodexRelease): string {
  const sourceRoot = join(directory, "source");
  if (!existsSync(sourceRoot)) {
    mkdirSync(directory, { recursive: true });
    process.stdout.write(`Downloading Codex ${release.tag_name} source\n`);
    const staging = mkdtempSync(join(directory, "source-"));
    try {
      const checkout = join(staging, "source");
      run("git", ["clone", "--config", "core.autocrlf=false", "--depth", "1", "--branch", release.tag_name, "https://github.com/openai/codex.git", checkout], directory);
      verifySource(checkout, release.tag_name, release.revision);
      try {
        renameSync(checkout, sourceRoot);
      } catch (error) {
        // Another preparation can publish the same complete checkout first.
        if (!existsSync(sourceRoot)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  verifySource(sourceRoot, release.tag_name, release.revision);
  return sourceRoot;
}

export async function downloadCli(directory: string, release: CodexRelease): Promise<string> {
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc.exe", "win32-x64": "x86_64-pc-windows-msvc.exe",
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Unsupported Codex release platform: ${process.platform}-${process.arch}`);
  const name = `codex-${target}`;
  const asset = release.assets.find(item => item.name === `${name}.tar.gz`);
  if (!asset) throw new Error(`Codex ${release.tag_name} has no ${name}.tar.gz asset`);
  const expectedUrl = `https://github.com/openai/codex/releases/download/${release.tag_name}/${asset.name}`;
  if (asset.browser_download_url !== expectedUrl) throw new Error("Unexpected Codex release asset URL");
  mkdirSync(directory, { recursive: true });
  const archive = join(directory, asset.name);
  const cliDirectory = mkdtempSync(join(directory, "cli-"));
  try {
    if (!existsSync(archive)) {
      process.stdout.write(`Downloading official Codex ${release.tag_name} CLI\n`);
      const response = await fetch(expectedUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Cannot download Codex CLI: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      verifyDigest(bytes, asset.digest);
      const staging = join(cliDirectory, asset.name);
      writeFileSync(staging, bytes);
      try {
        // Publish complete bytes without replacing an archive another caller uses.
        linkSync(staging, archive);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      rmSync(staging);
    }
    verifyDigest(readFileSync(archive), asset.digest);
    // The caller owns this directory and removes it after CLI execution.
    run("tar", ["-xzf", archive, "-C", cliDirectory, name], directory);
    const binary = join(cliDirectory, name);
    const home = join(cliDirectory, "version-home");
    mkdirSync(home, { recursive: true });
    if (run(binary, ["--version"], cliDirectory, { ...process.env, CODEX_HOME: home }).trim() !== `codex-cli ${releaseVersion(release)}`) {
      throw new Error(`Codex CLI version does not match release ${release.tag_name}`);
    }
    return binary;
  } catch (error) {
    rmSync(cliDirectory, { recursive: true, force: true });
    throw error;
  }
}
