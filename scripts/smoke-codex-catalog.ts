import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHATGPT_WEB_MODEL_ROUTES, availableChatGptWebModelRoutes, chatGptWebRouteEfforts } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { normalizeUpstreamModelCatalog } from "../src/upstream-model-catalog";
import { parseUpstreamProviderConfig } from "../src/upstream-provider";

const repositoryRoot = resolve(import.meta.dir, "..");
const generatedDir = join(repositoryRoot, "launcher", "electron", "generated");
const sourceLock = JSON.parse(readFileSync(join(generatedDir, "codex-source-lock.json"), "utf8")) as {
  revision: string;
};
const bundledArtifact = JSON.parse(readFileSync(join(generatedDir, "codex-bundled-models.json"), "utf8")) as {
  revision: string;
  models: unknown[];
};
const sourceArg = process.argv.find(argument => argument.startsWith("--source="))?.slice("--source=".length)
  ?? process.env.CODEX_SOURCE_DIR;
if (!sourceArg) throw new Error("smoke:codex requires --source=/path/to/openai-codex or CODEX_SOURCE_DIR");
const sourceRoot = resolve(sourceArg);
const codexRs = join(sourceRoot, "codex-rs");
const gitRevision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" });
if (gitRevision.status !== 0 || gitRevision.stdout.trim() !== sourceLock.revision
  || bundledArtifact.revision !== sourceLock.revision) {
  throw new Error("Codex parser smoke source does not match the generated artifact source lock");
}
const gitStatus = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: sourceRoot, encoding: "utf8" });
if (gitStatus.status !== 0 || gitStatus.stdout.trim()) {
  throw new Error("Codex parser smoke requires a clean tracked checkout at the generated artifact source lock");
}
function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync("cargo", ["run", "--quiet", "-p", "codex-cli", "--", ...args], {
    cwd: codexRs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    timeout: 20 * 60_000,
    // Hidden task identities also carry the native harness metadata in this JSON response.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const sourceCatalog = { models: bundledArtifact.models };
if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
  throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
const cargoLockPath = join(codexRs, "Cargo.lock");
const originalCargoLock = readFileSync(cargoLockPath);
process.env.CODEX_HOME = join(root, "codex");
process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
mkdirSync(process.env.CODEX_HOME, { recursive: true });
const config = defaultConfig("browser-only");
config.proAvailable = true;
config.extraHighAvailable = true;
config.subagentProtocol = "compatibility-v1";
const catalogPath = join(root, "augmented-models.json");
const augmented = augmentNativeModelCatalog(sourceCatalog, config);
if (!Array.isArray(augmented.models)) throw new Error("Augmented Codex catalog is missing a models array");
const smokeUpstream = parseUpstreamProviderConfig({
  version: 2,
  baseUrl: "https://smoke.invalid/v1/",
  apiKeySha256: "0".repeat(64),
  proxy: { mode: "direct" },
  models: [
    { id: "smoke/upstream", metadata: { mode: "upstream" } },
    {
      id: "smoke/custom",
      metadata: { mode: "custom", baseMode: "fallback", overrides: { display_name: "Smoke Custom" } },
    },
  ],
  supportsOpenAiServerCompaction: false,
});
const smokeModels = normalizeUpstreamModelCatalog({
  object: "list",
  data: [{ id: "smoke/upstream" }, { id: "smoke/custom" }],
  models: [{ slug: "smoke/upstream", description: "Upstream metadata mapping smoke" }],
}, smokeUpstream, "disabled");
writeFileSync(catalogPath, `${JSON.stringify({
  ...augmented,
  models: [...augmented.models, ...smokeModels.models],
})}\n`);
writeFileSync(join(process.env.CODEX_HOME, "config.toml"), [
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  "",
  "[features]",
  "multi_agent = true",
  "multi_agent_v2 = false",
  "",
].join("\n"));
try {
  const isolatedEnv = { ...process.env, CODEX_HOME: process.env.CODEX_HOME };
  const result = runCodex(["debug", "models"], isolatedEnv);
  const catalog = JSON.parse(result.stdout) as {
    models?: Array<{
      slug?: string;
      supported_reasoning_levels?: unknown[];
      multi_agent_version?: string;
      supported_in_api?: boolean;
      visibility?: string;
      priority?: number;
    }>;
  };
  const web = catalog.models?.filter(model => model.slug?.startsWith("chatgpt-web/")) ?? [];
  const expected = availableChatGptWebModelRoutes(config, true).map(route => ({
    slug: route.slug, visibility: route.legacy ? "hide" : "list", effort: chatGptWebRouteEfforts(route, config).join(","),
  }));
  const actual = web.map(model => ({
    slug: model.slug,
    visibility: model.visibility,
    effort: Array.isArray(model.supported_reasoning_levels)
      ? (model.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort).join(",")
      : "",
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Codex did not preserve the grouped and legacy ChatGPT Web model contract: ${JSON.stringify(actual)}`);
  }
  const nativeSol = catalog.models?.find(model => model.slug === "gpt-5.6-sol");
  const webPro = catalog.models?.find(model => model.slug === "chatgpt-web/pro");
  if (nativeSol?.multi_agent_version !== "v1" || webPro?.multi_agent_version !== "v1") {
    throw new Error(
      `Codex did not preserve Compatibility V1 catalog metadata: ${JSON.stringify({ nativeSol, webPro })}`,
    );
  }
  const features = runCodex(["features", "list"], isolatedEnv).stdout;
  if (!/^multi_agent\s+stable\s+true$/m.test(features)
    || !/^multi_agent_v2\s+stable\s+false$/m.test(features)) {
    throw new Error(`Codex did not load the Compatibility V1 feature override:\n${features}`);
  }
  const spawnOverrides = (catalog.models ?? [])
    .filter(model => model.supported_in_api === true && model.visibility === "list")
    .toSorted((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 5)
    .map(model => model.slug);
  const nativeSpawnLeader = (augmented.models as Array<Record<string, unknown>>)
    .filter(model => typeof model.slug === "string"
      && !model.slug.startsWith("chatgpt-web/")
      && model.supported_in_api === true
      && model.visibility === "list")
    .toSorted((left, right) => (typeof left.priority === "number" ? left.priority : Number.MAX_SAFE_INTEGER)
      - (typeof right.priority === "number" ? right.priority : Number.MAX_SAFE_INTEGER))[0]?.slug;
  if (typeof nativeSpawnLeader !== "string") throw new Error("Codex smoke catalog has no native API model for the V1 roster");
  const expectedSpawnOverrides = [
    nativeSpawnLeader,
    ...CHATGPT_WEB_MODEL_ROUTES.slice(1).map(route => route.slug),
    "chatgpt-web/gpt-5.6-sol-instant",
  ];
  if (JSON.stringify(spawnOverrides) !== JSON.stringify(expectedSpawnOverrides)) {
    throw new Error(`Codex did not preserve the bounded V1 subagent roster: ${JSON.stringify(spawnOverrides)}`);
  }
  const upstreamSmoke = catalog.models?.find(model => model.slug === "smoke/upstream") as
    | ({ description?: string; shell_type?: string } & Record<string, unknown>) | undefined;
  const customSmoke = catalog.models?.find(model => model.slug === "smoke/custom") as
    | ({ display_name?: string; shell_type?: string } & Record<string, unknown>) | undefined;
  if (upstreamSmoke?.description !== "Upstream metadata mapping smoke" || upstreamSmoke.shell_type !== "disabled") {
    throw new Error(`Codex did not accept normalized upstream metadata: ${JSON.stringify(upstreamSmoke)}`);
  }
  if (customSmoke?.display_name !== "Smoke Custom" || customSmoke.shell_type !== "disabled") {
    throw new Error(`Codex did not accept normalized custom metadata: ${JSON.stringify(customSmoke)}`);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  if (!readFileSync(cargoLockPath).equals(originalCargoLock)) writeFileSync(cargoLockPath, originalCargoLock);
  rmSync(root, { recursive: true, force: true });
}

const gitStatusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: sourceRoot,
  encoding: "utf8",
});
if (gitStatusAfter.status !== 0 || gitStatusAfter.stdout.trim()) {
  throw new Error("Codex parser smoke changed tracked files in the locked source checkout");
}
