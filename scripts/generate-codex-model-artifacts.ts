import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkoutSource, downloadCli, fetchRelease, run, verifySchemaSources, verifySource, type SourceLock } from "./codex-release";

const root = resolve(import.meta.dir, "..");
const generatedDir = join(root, "launcher", "electron", "generated");
const lockPath = join(generatedDir, "codex-source-lock.json");
const sourceLock = JSON.parse(readFileSync(lockPath, "utf8")) as SourceLock;
const sourceArg = process.argv.find(argument => argument.startsWith("--source="))?.slice("--source=".length)
  ?? process.env.CODEX_SOURCE_DIR;
const checkOnly = process.argv.includes("--check");
const schemaPath = join(generatedDir, "codex-model-info.schema.json");
const schemaArtifact = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  schema: Record<string, unknown>;
  sourceFiles: Record<string, string>;
};

// Only synchronization follows latest. Verification uses the recorded stable release.
if (checkOnly && !sourceLock.tag) throw new Error("Codex source lock must identify a stable release tag");
const release = await fetchRelease(checkOnly ? sourceLock.tag : undefined, checkOnly ? sourceLock.revision : undefined);
const temporaryRoot = process.env.CODEX_RELEASE_DIR ? undefined : mkdtempSync(join(tmpdir(), "codex-model-metadata-"));
const directory = process.env.CODEX_RELEASE_DIR ?? temporaryRoot!;
let binary: string | undefined;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")).map(([key, item]) => [key, canonical(item)]));
}

try {
  const sourceRoot = sourceArg ? resolve(sourceArg) : checkoutSource(directory, release);
  const revision = verifySource(sourceRoot, release.tag_name, release.revision);
  verifySchemaSources(sourceRoot, schemaArtifact.sourceFiles);
  binary = await downloadCli(directory, release);
  const home = mkdtempSync(join(tmpdir(), "codex-model-export-"));
  let models: unknown[];
  try {
    const env = { ...process.env, CODEX_HOME: home };
    const catalogPath = join(sourceRoot, "codex-rs", "models-manager", "models.json");
    const sourceCatalog = JSON.parse(run(binary, ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`, "debug", "models"], home, env));
    const bundledCatalog = JSON.parse(run(binary, ["debug", "models", "--bundled"], home, env));
    if (!Array.isArray(sourceCatalog.models) || !sourceCatalog.models.length
      || JSON.stringify(canonical(sourceCatalog.models)) !== JSON.stringify(canonical(bundledCatalog.models))) {
      throw new Error("Codex release source catalog does not match the official CLI bundled catalog");
    }
    // ModelsResponse adds this legacy alias on output; ModelInfo uses model_messages.
    models = sourceCatalog.models.map((model: { base_instructions?: unknown; model_messages?: { instructions_template?: unknown } }) => {
      const { base_instructions, ...info } = model;
      if (base_instructions !== undefined && base_instructions !== model.model_messages?.instructions_template) {
        throw new Error("Codex legacy instructions do not match model_messages.instructions_template");
      }
      return info;
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const bundledPath = join(generatedDir, "codex-bundled-models.json");
  const bundledJson = `${JSON.stringify({ version: 1, revision, models: canonical(models) }, null, 2)}\n`;
  const schemaJson = `${JSON.stringify({ version: 2, revision, sourceFiles: schemaArtifact.sourceFiles, schema: schemaArtifact.schema }, null, 2)}\n`;
  const lockJson = `${JSON.stringify({ version: 3, repository: "https://github.com/openai/codex.git", tag: release.tag_name, revision }, null, 2)}\n`;
  if (checkOnly) {
    if (readFileSync(bundledPath, "utf8") !== bundledJson || readFileSync(schemaPath, "utf8") !== schemaJson
      || readFileSync(lockPath, "utf8") !== lockJson) {
      throw new Error("Generated Codex ModelInfo artifacts are stale for the locked release");
    }
  } else {
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(bundledPath, bundledJson);
    writeFileSync(schemaPath, schemaJson);
    writeFileSync(lockPath, lockJson);
  }
  verifySource(sourceRoot, release.tag_name, revision);
  process.stdout.write(`${checkOnly ? "Verified" : "Generated"} Codex ModelInfo artifacts from ${release.tag_name}@${revision}\n`);
} finally {
  if (binary) rmSync(dirname(binary), { recursive: true, force: true });
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
}
