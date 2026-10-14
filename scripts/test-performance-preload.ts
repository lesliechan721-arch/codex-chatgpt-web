import { afterAll } from "bun:test";
import { flushRuntimePerformance } from "../src/runtime-performance";

// Parallel workers discard each file's global. Flush before that happens; exit
// also covers child processes that do not load the test runner or this preload.
afterAll(flushRuntimePerformance);
