import { expect, test } from "bun:test";
import { isCodexRecapRequestFromBody, isCodexThreadTitleRequestFromBody } from "../src/adapters/chatgpt-web/environment";
import { apiKeyPolicy, OPENAI_ACCESS } from "../src/api-access";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

const localKey = `cgw_${"a".repeat(43)}`;

// Shape emitted by Codex TUI's temporary recap thread, including its output schema.
function recapBody(model = "chatgpt-web-continuity/zero-risk-pro", stream = true) {
  return {
    model, stream,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn", thread_source: "system", thread_id: "recap-thread", turn_id: "recap-turn",
      }),
    },
    input: [{ role: "user", content: [{ type: "input_text", text: "Write a brief catch-up for a user returning to this task." }] }],
    text: { format: {
      type: "json_schema", name: "codex_output_schema", strict: true,
      schema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 700 },
          next_action: { type: ["string", "null"], maxLength: 200 },
        },
        required: ["summary", "next_action"], additionalProperties: false,
      },
    } },
  };
}

function request(body: unknown, authorization = "Bearer codex-oauth-token") {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("Codex system recap requires the complete output contract and accepts unordered schema arrays", () => {
  const body = recapBody();
  expect(isCodexRecapRequestFromBody(body)).toBe(true);
  expect(isCodexThreadTitleRequestFromBody(body)).toBe(false);
  body.text.format.schema.required.reverse();
  body.text.format.schema.properties.next_action.type.reverse();
  expect(isCodexRecapRequestFromBody(body)).toBe(true);
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
  expect(isCodexRecapRequestFromBody({ ...body, client_metadata: { "x-codex-turn-metadata": metadata } })).toBe(true);
});

test("ordinary summaries, title requests and other system schemas are not Codex recaps", () => {
  const changes: Array<(body: any) => void> = [
    body => { delete body.client_metadata; },
    body => { body.client_metadata["x-codex-turn-metadata"] = "invalid-json"; },
    body => { body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ request_kind: "turn", thread_source: "user" }); },
    body => { body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ request_kind: "compact", thread_source: "system" }); },
    body => { delete body.text; },
    body => { body.text.format.strict = false; },
    body => { body.text.format.schema.properties.summary.maxLength = 701; },
    body => { body.text.format.schema.properties.next_action.maxLength = 201; },
    body => { body.text.format.schema.properties.next_action.type = "string"; },
    body => { body.text.format.schema.properties.title = { type: "string" }; },
    body => { body.text.format.schema.required = ["summary"]; },
    body => { body.text.format.schema.additionalProperties = true; },
    body => { body.text.format.schema = {
      type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
      required: ["title"], additionalProperties: false,
    }; },
  ];
  for (const change of changes) {
    const body = recapBody();
    change(body);
    expect(isCodexRecapRequestFromBody(body)).toBe(false);
  }
  for (const body of [null, [], {}, { client_metadata: null }, { client_metadata: { "x-codex-turn-metadata": [] } }]) {
    expect(isCodexRecapRequestFromBody(body)).toBe(false);
  }
});

test("recap is rejected before browser creation, upstream forwarding or turn lifecycle binding", async () => {
  for (const accessPolicy of [OPENAI_ACCESS, apiKeyPolicy(localKey)]) {
    for (const model of ["chatgpt-web-continuity/zero-risk-pro", "chatgpt-web/zero-risk", "chatgpt-web/high", "gpt-6-sol"]) {
      for (const stream of [true, false]) {
        let effects = 0;
        const unexpected = () => { effects += 1; throw new Error("Recap must have no routing side effects"); };
        const response = await responseRequest(
          request(recapBody(model, stream), accessPolicy.mode === "api-key" ? `Bearer ${localKey}` : undefined),
          defaultConfig(), unexpected,
          { accessPolicy, fetchNative: unexpected, fetchUpstreamProvider: unexpected,
            onTurnAdmission: unexpected, brokerAvailable: unexpected,
            onTurnIdentity: unexpected, onTurnInputProgress: unexpected, onTurnComplete: unexpected },
        );
        expect(response.status).toBe(400);
        expect(response.headers.get("content-type")).toContain("application/json");
        expect(await response.json()).toMatchObject({ error: {
          type: "invalid_request_error", code: "codex_recap_not_supported",
        } });
        expect(effects).toBe(0);
      }
    }
  }
});

test("API-key authentication takes precedence over recap rejection", async () => {
  const response = await responseRequest(request(recapBody()), defaultConfig(), undefined, { accessPolicy: apiKeyPolicy(localKey) });
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } });
});

test("a normal request mentioning recap still reaches its selected native model", async () => {
  const body = recapBody("gpt-6-sol");
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ request_kind: "turn", thread_source: "user" });
  let forwarded = 0;
  const response = await responseRequest(request(body), defaultConfig(), undefined, {
    fetchNative: async req => {
      forwarded += 1;
      expect((await req.json() as any).model).toBe("gpt-6-sol");
      return Response.json({ status: "completed", output: [] });
    },
  });
  expect(response.status).toBe(200);
  await response.json();
  expect(forwarded).toBe(1);
});

test("an ordinary Web summary request keeps its browser route", async () => {
  const body = recapBody("chatgpt-web/zero-risk", false);
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({ request_kind: "turn", thread_source: "user" });
  let turns = 0;
  const response = await responseRequest(request(body), {
    ...defaultConfig(), browserInteractionMode: "manual",
  }, () => ({
    name: "summary-test-no-browser",
    async runTurn(_parsed, _incoming, emit) {
      turns += 1;
      emit({ type: "text_delta", text: '{"summary":"Done","next_action":null}' });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), { rememberState: false });
  expect(response.status).toBe(200);
  await response.json();
  expect(turns).toBe(1);
});
