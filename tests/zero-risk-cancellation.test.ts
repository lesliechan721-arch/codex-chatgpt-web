import { afterEach, expect, spyOn, test } from "bun:test";
import { chatGptWebExecutionNamespace } from "../src/adapters/chatgpt-web";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { responseRequest, routeChatGptWebRequest } from "../src/server";

afterEach(() => chatGptTurnSessions.clear());
const config = defaultConfig("full");
config.browserInteractionMode = "manual";
const namespace = chatGptWebExecutionNamespace(providerConfig(config));
function body(turn = "cancelled-turn", event: string | undefined = "original-event", text = "Original instruction.") {
  return {
    model: "chatgpt-web/zero-risk", stream: false, prompt_cache_key: "cancellation-thread",
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "cancellation-thread", turn_id: turn }) },
    input: [{ type: "message", id: event, role: "user", content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turn } }],
  };
}
function parsed(value = body()) {
  const request = parseRequest(value);
  routeChatGptWebRequest(request, config);
  return request;
}
function cancelledControl() {
  return { surfaceNonce: "cancelled-page" };
}
function cancellation(code = "manual_turn_cancelled") {
  return new ChatGptWebAdapterError("The user cancelled this turn.", {
    status: 409, errorType: "invalid_request_error", code, retryable: false,
  });
}
async function send(value = body()) {
  let starts = 0;
  const response = await responseRequest(new Request("http://fixture.invalid/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  }), config, () => {
    starts++;
    return { name: "cancellation-admission", async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "Accepted new work.", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } };
  }, {});
  const result = await response.json();
  return { response, result, starts };
}

for (const code of ["manual_turn_cancelled", "client_cancelled"]) test(`Zero Risk ${code} retry is HTTP 400 before adapter creation`, async () => {
  chatGptTurnSessions.rememberCancelledRequest(namespace, parsed(), cancelledControl(), cancellation(code));
  const retry = await send();
  expect(retry.response.status).toBe(400);
  expect(retry.result).toMatchObject({ error: { code } });
  expect(retry.starts).toBe(0);
  const recovery = parsed();
  recovery._continuityHistoryRevision = 99;
  recovery._continuityAttempt = 1;
  expect(chatGptTurnSessions.cancelledRequestError(namespace, recovery)?.code).toBe(code);
});

test("new turns, new input events, edited input and unidentified input are admitted", async () => {
  chatGptTurnSessions.rememberCancelledRequest(namespace, parsed(), cancelledControl(), cancellation());
  for (const next of [body("new-turn"), body("cancelled-turn", "new-event"),
    body("cancelled-turn", "new-event", "Additional instruction."), body("cancelled-turn", "original-event", "Edited instruction.")]) {
    const admitted = await send(next);
    expect(admitted.response.status).toBe(200);
    expect(admitted.starts).toBe(1);
  }
  const unidentified = body(); delete (unidentified.input[0] as { id?: string }).id;
  expect((await send(unidentified)).response.status).toBe(200);
  expect(chatGptTurnSessions.cancelledRequestError("another-provider", parsed())).toBeUndefined();
});

test("the cancellation expires after 30 seconds without renewal by retries or replay", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(100_000);
  const control = cancelledControl(), request = parsed(), error = cancellation();
  try {
    chatGptTurnSessions.rememberCancelledRequest(namespace, request, control, error);
    clock.mockReturnValue(129_999);
    expect((await send()).response.status).toBe(400);
    chatGptTurnSessions.rememberCancelledRequest(namespace, request, control, error);
    clock.mockReturnValue(130_000);
    chatGptTurnSessions.rememberCancelledRequest(namespace, request, control, error);
    expect((await send()).response.status).toBe(200);
    // A restarted registry has no cancellation memory.
    chatGptTurnSessions.rememberCancelledRequest(namespace, request, cancelledControl(), error);
    chatGptTurnSessions.clear();
    expect((await send()).response.status).toBe(200);
  } finally { clock.mockRestore(); }
});

test("a request checkpoint's synthesized summary ID cannot identify a cancelled native event", () => {
  const value = body(); delete (value.input[0] as { id?: string }).id;
  const request = parsed(value);
  request._continuityRequestInstruction = {
    turnId: "cancelled-turn", itemId: "request-summary:content-hash", content: "Readable request checkpoint.",
    instructionEnvelope: { role: "user" },
  };
  chatGptTurnSessions.rememberCancelledRequest(namespace, request, cancelledControl(), cancellation());
  expect(chatGptTurnSessions.cancelledRequestError(namespace, request)).toBeUndefined();
});
