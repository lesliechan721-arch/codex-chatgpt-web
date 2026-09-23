import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface SourceLock {
  version: 2;
  repository: string;
  branch: string;
  revision: string;
}

const root = resolve(import.meta.dir, "..");
const generatedDir = join(root, "launcher", "electron", "generated");
const lockPath = join(generatedDir, "codex-source-lock.json");
const sourceLock = JSON.parse(readFileSync(lockPath, "utf8")) as SourceLock;
const sourceArg = process.argv.find(argument => argument.startsWith("--source="))?.slice("--source=".length)
  ?? process.env.CODEX_SOURCE_DIR;
const checkOnly = process.argv.includes("--check");

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function generateArtifacts(sourceRoot: string, refreshRevision: boolean): void {
  const codexRs = join(sourceRoot, "codex-rs");
  if (!existsSync(join(codexRs, "protocol", "src", "openai_models.rs"))
    || !existsSync(join(codexRs, "models-manager", "models.json"))) {
    throw new Error("The Codex source checkout does not contain the required Rust sources");
  }

  const revision = run("git", ["rev-parse", "HEAD"], sourceRoot).trim();
  if (!refreshRevision && revision !== sourceLock.revision) {
    if (checkOnly && !sourceArg) {
      throw new Error(`Latest Codex ${sourceLock.branch} revision is ${revision}, but generated artifacts are locked to ${sourceLock.revision}; run bun run generate:codex-model-metadata to update them`);
    }
    throw new Error(`Codex source revision mismatch: expected ${sourceLock.revision}, received ${revision}`);
  }
  const dirtyTracked = run("git", ["status", "--porcelain", "--untracked-files=no"], sourceRoot).trim();
  if (dirtyTracked) throw new Error("Codex source checkout has tracked changes; generation requires the exact locked revision");

  const exampleName = `codex_chatgpt_web_model_export_${process.pid}`;
  const exampleDir = join(codexRs, "protocol", "examples");
  const examplePath = join(exampleDir, `${exampleName}.rs`);
  const cargoLockPath = join(codexRs, "Cargo.lock");
  const originalCargoLock = readFileSync(cargoLockPath);
  mkdirSync(exampleDir, { recursive: true });
  if (existsSync(examplePath)) throw new Error(`Temporary Codex exporter already exists: ${examplePath}`);

  const exporter = `use codex_protocol::openai_models::{ModelInfo, ModelsResponse};
use schemars::schema_for;

fn main() {
    let bundled: ModelsResponse = serde_json::from_str(include_str!("../../models-manager/models.json")).unwrap();
    let payload = serde_json::json!({
        "models": bundled.models,
        "schema": schema_for!(ModelInfo),
    });
    println!("{}", serde_json::to_string_pretty(&payload).unwrap());
}
`;

  let output = "";
  try {
    writeFileSync(examplePath, exporter);
    output = run("cargo", ["run", "--quiet", "-p", "codex-protocol", "--example", exampleName], codexRs);
  } finally {
    rmSync(examplePath, { force: true });
    if (!readFileSync(cargoLockPath).equals(originalCargoLock)) writeFileSync(cargoLockPath, originalCargoLock);
  }

  const dirtyAfter = run("git", ["status", "--porcelain", "--untracked-files=no"], sourceRoot).trim();
  if (dirtyAfter) throw new Error("Codex artifact generation changed tracked files in the source checkout");

  const payload = JSON.parse(output) as { models?: unknown[]; schema?: Record<string, unknown> };
  if (!Array.isArray(payload.models) || !payload.models.length || !payload.schema
    || typeof payload.schema !== "object" || Array.isArray(payload.schema)) {
    throw new Error("Codex exporter returned an invalid ModelInfo artifact payload");
  }

  mkdirSync(generatedDir, { recursive: true });
  const bundledJson = `${JSON.stringify({
    version: 1,
    revision,
    models: payload.models,
  }, null, 2)}\n`;
  const schemaJson = `${JSON.stringify({
    version: 1,
    revision,
    schema: payload.schema,
  }, null, 2)}\n`;
  const bundledPath = join(generatedDir, "codex-bundled-models.json");
  const schemaPath = join(generatedDir, "codex-model-info.schema.json");
  if (checkOnly) {
    if (readFileSync(bundledPath, "utf8") !== bundledJson || readFileSync(schemaPath, "utf8") !== schemaJson) {
      throw new Error("Generated Codex ModelInfo artifacts are stale for the locked source revision");
    }
  } else {
    writeFileSync(bundledPath, bundledJson);
    writeFileSync(schemaPath, schemaJson);
    if (refreshRevision) {
      writeFileSync(lockPath, `${JSON.stringify({ ...sourceLock, revision }, null, 2)}\n`);
    }
  }

  process.stdout.write(`${checkOnly ? "Verified" : "Generated"} Codex ModelInfo artifacts from ${basename(sourceRoot)}@${revision}\n`);
}

const temporaryRoot = sourceArg ? undefined : mkdtempSync(join(tmpdir(), "codex-model-metadata-"));
const sourceRoot = sourceArg ? resolve(sourceArg) : join(temporaryRoot!, "openai-codex");
try {
  if (!sourceArg) {
    run("git", ["clone", "--depth", "1", "--branch", sourceLock.branch, sourceLock.repository, sourceRoot], temporaryRoot!);
  }
  generateArtifacts(sourceRoot, !sourceArg && !checkOnly);
} finally {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}
