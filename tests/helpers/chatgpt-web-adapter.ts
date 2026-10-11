import { createChatGptWebAdapter as createAdapter } from "../../src/adapters/chatgpt-web";

export * from "../../src/adapters/chatgpt-web";

/** Local adapter tests simulate the cloud client. Cloud capability verification has
 * separate six-receipt tests; production callers never use this dependency. */
export const verifiedTestContextCapability = async (): Promise<void> => {};

export function createChatGptWebAdapter(
  provider: Parameters<typeof createAdapter>[0],
  dependencies: NonNullable<Parameters<typeof createAdapter>[1]> = {},
): ReturnType<typeof createAdapter> {
  return createAdapter(provider, { verifyContextCapability: verifiedTestContextCapability, ...dependencies });
}
