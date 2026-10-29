import { test, type TestOptions } from "bun:test";
import type { OptionalBrowserEnvironment } from "../../scripts/optional-browser-tests";

/** A configured but broken executable must fail the test instead of becoming a skip. */
export function optionalBrowserTest(environment: OptionalBrowserEnvironment) {
  return (name: string, run: () => void | Promise<unknown>, options?: number | TestOptions) => {
    const missing = !process.env[environment];
    test.skipIf(missing)(missing ? `[requires:${environment}] ${name}` : name, run, options);
  };
}
