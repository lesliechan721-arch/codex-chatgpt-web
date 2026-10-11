import type { CompiledChatGptWebPrompt } from "./prompt";

export function validateBrowserHelperContextPlan(plan: CompiledChatGptWebPrompt["contextPlan"]): void {
  if (plan === undefined) return;
  const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)
    || !validId(plan.planId) || !validId(plan.contextId)
    || typeof plan.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(plan.manifestDigest)
    || !Array.isArray(plan.requiredAttachments) || plan.requiredAttachments.length > 100
    || plan.requiredAttachments.some(item => !item || !validId(item.id)
      || typeof item.label !== "string" || !item.label.trim() || Array.from(item.label).length > 200
      || /[\u0000-\u001f\u007f]/.test(item.label))
    || new Set(plan.requiredAttachments.map(item => item.id)).size !== plan.requiredAttachments.length) {
    throw new Error("Browser helper selected context delivery plan is invalid");
  }
}

export interface BrowserHelperPromptSelection {
  select(prepared: CompiledChatGptWebPrompt): void;
  cancel(): void;
  wait(): Promise<CompiledChatGptWebPrompt>;
}

export function createBrowserHelperPromptSelection(): BrowserHelperPromptSelection {
  let settle!: (prepared: CompiledChatGptWebPrompt | undefined) => void;
  let settled = false;
  const selected = new Promise<CompiledChatGptWebPrompt | undefined>(resolve => { settle = resolve; });
  const finish = (prepared: CompiledChatGptWebPrompt | undefined): void => {
    if (settled) return;
    settled = true;
    settle(prepared);
  };
  return {
    select: prepared => {
      validateBrowserHelperContextPlan(prepared.contextPlan);
      finish(prepared);
    },
    cancel: () => finish(undefined),
    wait: async () => {
      const prepared = await selected;
      if (!prepared) throw new DOMException("Browser helper prompt selection aborted", "AbortError");
      return prepared;
    },
  };
}
