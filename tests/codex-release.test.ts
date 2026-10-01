import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { releaseVersion, run, SCHEMA_SOURCE_FILES, sha256, verifyDigest, verifySchemaSources, verifySource } from "../scripts/codex-release";

test("Codex synchronization accepts only stable Rust releases", () => {
  const release = { tag_name: "rust-v0.159.3", draft: false, prerelease: false, assets: [] };
  expect(releaseVersion(release)).toBe("0.159.3");
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: "rust-v0.160.0-alpha.1" }, { tag_name: "main" }]) {
    expect(() => releaseVersion({ ...release, ...change })).toThrow("Expected a stable Codex Rust release");
  }
});

test("official CLI archive verification rejects modified bytes and missing digests", () => {
  const archive = Buffer.from("official archive");
  const digest = `sha256:${sha256(archive)}`;
  expect(() => verifyDigest(archive, digest)).not.toThrow();
  expect(() => verifyDigest(Buffer.from("modified archive"), digest)).toThrow("SHA-256 mismatch");
  expect(() => verifyDigest(archive, "")).toThrow("SHA-256 mismatch");
});

test("release source requires the tag's commit, the locked revision, and clean tracked files", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-release-source-test-"));
  const tag = "rust-v0.159.3";
  try {
    run("git", ["init"], root);
    writeFileSync(join(root, "models.json"), "{}");
    run("git", ["add", "models.json"], root);
    run("git", ["-c", "user.name=Codex Test", "-c", "user.email=codex-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], root);
    run("git", ["tag", tag], root);
    const revision = run("git", ["rev-parse", "HEAD"], root).trim();
    expect(verifySource(root, tag, revision)).toBe(revision);
    expect(() => verifySource(root, tag, "0".repeat(40))).toThrow("source revision does not match release");
    writeFileSync(join(root, "models.json"), '{"changed": true}');
    expect(() => verifySource(root, tag, revision)).toThrow("tracked changes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema synchronization stops for changed sources or missing fingerprints", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-schema-source-test-"));
  const sourceFiles: Record<string, string> = {};
  try {
    for (const file of SCHEMA_SOURCE_FILES) {
      const path = join(root, "codex-rs", file);
      mkdirSync(dirname(path), { recursive: true });
      const bytes = Buffer.from(`source for ${file}`);
      writeFileSync(path, bytes);
      sourceFiles[file] = sha256(bytes);
    }
    expect(() => verifySchemaSources(root, sourceFiles)).not.toThrow();
    expect(() => verifySchemaSources(root, {})).toThrow("schema source changed");
    writeFileSync(join(root, "codex-rs", SCHEMA_SOURCE_FILES[0]), "changed ModelInfo");
    expect(() => verifySchemaSources(root, sourceFiles)).toThrow("schema source changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synchronization rejects a local release tag moved away from the official commit", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-release-identity-test-"));
  const tag = "rust-v0.159.3";
  try {
    run("git", ["init"], root);
    writeFileSync(join(root, "README.md"), "official source");
    run("git", ["add", "README.md"], root);
    const commit = ["-c", "user.name=Codex Test", "-c", "user.email=codex-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-am"];
    run("git", [...commit, "official fixture"], root);
    const official = run("git", ["rev-parse", "HEAD"], root).trim();
    writeFileSync(join(root, "README.md"), "local source");
    run("git", [...commit, "local fixture"], root);
    run("git", ["tag", tag], root);
    const preload = join(root, "preload.cjs");
    writeFileSync(preload, `
global.fetch = async url => Response.json(String(url).includes("/git/")
  ? { object: { type: "commit", sha: ${JSON.stringify(official)} } }
  : { tag_name: ${JSON.stringify(tag)}, draft: false, prerelease: false, assets: [] });
`);
    const result = spawnSync(process.execPath, ["--preload", preload, join(import.meta.dir, "../scripts/generate-codex-model-artifacts.ts"), `--source=${root}`], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, CODEX_SOURCE_DIR: undefined, CODEX_RELEASE_DIR: undefined },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Codex source revision does not match release");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second CLI extraction cannot overwrite the first caller's executable", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-cli-isolation-test-"));
  const targets: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc.exe", "win32-x64": "x86_64-pc-windows-msvc.exe",
  };
  const name = `codex-${targets[`${process.platform}-${process.arch}`]}`;
  try {
    const cache = join(root, "cache");
    mkdirSync(cache);
    writeFileSync(join(root, name), "fixture-cli");
    const archive = join(cache, `${name}.tar.gz`);
    run("tar", ["-czf", archive, "-C", root, name], root);
    const release = {
      tag_name: "rust-v0.159.3", draft: false, prerelease: false, revision: "0".repeat(40),
      assets: [{ name: `${name}.tar.gz`, digest: `sha256:${sha256(readFileSync(archive))}`,
        browser_download_url: `https://github.com/openai/codex/releases/download/rust-v0.159.3/${name}.tar.gz` }],
    };
    const preload = join(root, "preload.cjs");
    writeFileSync(preload, `
const childProcess = require("node:child_process");
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => require("node:path").basename(command) === ${JSON.stringify(name)} && args[0] === "--version"
  ? { status: require("node:fs").readFileSync(command, "utf8") === "fixture-cli" ? 0 : 1, stdout: "codex-cli 0.159.3\\n", stderr: "" }
  : originalSpawn(command, args, options);
require("node:module").syncBuiltinESMExports();
`);
    const helper = pathToFileURL(join(import.meta.dir, "../scripts/codex-release.ts")).href;
    const script = `
const { downloadCli } = await import(${JSON.stringify(helper)});
const fs = await import("node:fs");
const path = await import("node:path");
const first = await downloadCli(${JSON.stringify(cache)}, ${JSON.stringify(release)});
try {
  fs.writeFileSync(first, "first caller still owns this file");
  const second = await downloadCli(${JSON.stringify(cache)}, ${JSON.stringify(release)});
  try { process.stdout.write(fs.readFileSync(first, "utf8")); }
  finally { fs.rmSync(path.dirname(second), { recursive: true, force: true }); }
} finally { fs.rmSync(path.dirname(first), { recursive: true, force: true }); }
`;
    const result = spawnSync(process.execPath, ["--preload", preload, "--eval", script], { cwd: root, encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("first caller still owns this file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
