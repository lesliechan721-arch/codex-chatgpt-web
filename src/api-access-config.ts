import { readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "./config";
import { OPENAI_ACCESS, parseApiAccessPolicy, type ApiAccessPolicy } from "./api-access";

export function apiAccessConfigPath(home = getConfigDir()): string {
  return join(home, "api-access.json");
}

export function apiKeyReuseMarkerPath(home = getConfigDir()): string {
  return join(home, "secrets", "api-client-key-reuse.json");
}

export function openAiRoutingPendingPath(home = getConfigDir()): string {
  return join(home, "api-access-routing-pending.json");
}

export function clearOpenAiRoutingPending(home = getConfigDir()): void {
  rmSync(openAiRoutingPendingPath(home), { force: true });
}

/** A missing file is the only implicit legacy-mode fallback. Invalid/unreadable files fail closed. */
export function loadApiAccessPolicy(home = getConfigDir()): ApiAccessPolicy {
  const path = apiAccessConfigPath(home);
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return OPENAI_ACCESS;
    throw new Error("Cannot inspect API access configuration; refusing to start the service");
  }
  let text: string;
  try {
    // Only an actually absent path enables legacy mode. A dangling link or a file disappearing
    // between inspection and read must not silently re-enable native passthrough.
    if (!stat.isFile() || stat.size > 4_096) throw new Error("Invalid policy file");
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error("Cannot read API access configuration; refusing to start the service");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid API access JSON; refusing to start the service"); }
  return parseApiAccessPolicy(value);
}

export function saveApiAccessPolicy(policy: ApiAccessPolicy, home = getConfigDir()): void {
  const validated = parseApiAccessPolicy(policy);
  // CLI/core policy changes cannot prove that a GUI-sealed key still belongs to the current
  // policy history. Remove the GUI-only reuse grant before committing the external change.
  rmSync(apiKeyReuseMarkerPath(home), { force: true });
  atomicWriteFile(apiAccessConfigPath(home), `${JSON.stringify(validated, null, 2)}\n`);
}
