import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkoutSource, downloadCli, fetchRelease, type SourceLock } from "./codex-release";

const root = resolve(import.meta.dir, "..");
const lock = JSON.parse(readFileSync(join(root, "launcher/electron/generated/codex-source-lock.json"), "utf8")) as SourceLock;
const release = await fetchRelease(lock.tag, lock.revision);
const directory = join(process.env.RUNNER_TEMP ?? tmpdir(), `codex-release-${release.tag_name}`);
const sourceRoot = checkoutSource(directory, release);
const binary = await downloadCli(directory, release);
rmSync(dirname(binary), { recursive: true, force: true });
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `CODEX_SOURCE_DIR=${sourceRoot}\nCODEX_RELEASE_DIR=${directory}\n`);
}
process.stdout.write(`Prepared official Codex ${release.tag_name} at ${directory}\n`);
