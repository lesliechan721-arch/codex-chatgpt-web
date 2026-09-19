import { expect, test } from "bun:test";
import { MissingTrustedCodexEnvironmentError } from "../src/adapters/chatgpt-web/environment";
import { trustedEnvironmentFailureDetails } from "../src/adapters/chatgpt-web/thread-environment";

test("trusted environment diagnostics distinguish missing authority and conflicting authority", () => {
  expect(trustedEnvironmentFailureDetails(new MissingTrustedCodexEnvironmentError("cwd")))
    .toEqual({ errorType: "MissingTrustedCodexEnvironmentError", reason: "missing_cwd" });
  expect(trustedEnvironmentFailureDetails(new Error("Compaction continuation environment conflicts with its current Codex rollout")))
    .toEqual({ errorType: "Error", reason: "compaction_authority_conflict" });
});

test("trusted environment diagnostics preserve safe IO codes but never private exception content", () => {
  const error = Object.assign(new Error("private path /users/secret and api-key-private-value"), { code: "EACCES" });
  expect(trustedEnvironmentFailureDetails(error)).toEqual({
    errorType: "Error", reason: "unclassified_environment_error", errorCode: "EACCES",
  });
  error.name = "private-error-name";
  error.code = "private-error-code";
  expect(trustedEnvironmentFailureDetails(error)).toEqual({ errorType: "UnknownError", reason: "unclassified_environment_error" });
  expect(trustedEnvironmentFailureDetails(new Error("constructor")))
    .toEqual({ errorType: "Error", reason: "unclassified_environment_error" });
});
