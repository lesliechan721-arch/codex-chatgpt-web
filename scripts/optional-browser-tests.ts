export const OPTIONAL_BROWSER_ENVIRONMENTS = ["CHATGPT_DOM_TEST_BROWSER", "LAUNCHER_TEST_ELECTRON"] as const;
export type OptionalBrowserEnvironment = typeof OPTIONAL_BROWSER_ENVIRONMENTS[number];
export type OptionalBrowserRule = { environment: OptionalBrowserEnvironment; files: string[]; reason: string };

export function optionalBrowserRuntimes(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(OPTIONAL_BROWSER_ENVIRONMENTS.map(key => [key, Boolean(env[key])]));
}

export function validOptionalBrowserRules(rules: unknown, files: string[]): rules is OptionalBrowserRule[] {
  return Array.isArray(rules) && new Set(rules.map(rule => rule?.environment)).size === rules.length
    && rules.every(rule => OPTIONAL_BROWSER_ENVIRONMENTS.includes(rule?.environment)
      && typeof rule.reason === "string" && rule.reason.trim().length > 0
      && Array.isArray(rule.files) && rule.files.length > 0 && new Set(rule.files).size === rule.files.length
      && rule.files.every((file: unknown) => typeof file === "string" && files.includes(file)));
}

/** Only the conditional test helper emits this prefix; ordinary skips stay explicit. */
export function optionalBrowserSkip(identity: string) {
  const match = /^(.*?)::\[requires:(CHATGPT_DOM_TEST_BROWSER|LAUNCHER_TEST_ELECTRON)\] (.+)$/.exec(identity);
  return match ? { file: match[1]!, environment: match[2]! as OptionalBrowserEnvironment } : null;
}
