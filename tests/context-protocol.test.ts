import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONTEXT_PROTOCOL_VERSION } from "../src/adapters/chatgpt-web/context-runtime";
import { contextProtocolCapabilities } from "../src/adapters/chatgpt-web/context-protocol";
import { RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("remote capabilities require the current read ABI and manifest rather than tool presence or bootstrap alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-protocol-"));
  const endpoint = join(directory, "broker.sock");
  let status: Record<string, unknown> = {};
  const methods: string[] = [];
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", fragment => {
      input += fragment;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.trim()); methods.push(request.method);
      socket.end(`${JSON.stringify({ id: request.id, result: status })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const owner = new RemoteTurnBroker(endpoint);
  const current = { ...contextProtocolCapabilities(CONTEXT_PROTOCOL_VERSION),
    contextBootstrapProtocol: "context-bootstrap-v1", contextReuseProtocol: "context-reuse-v1" };
  try {
    for (const changed of [
      { contextProtocol: 3, contextBootstrapProtocol: "context-bootstrap-v1" },
      { ...current, contextProtocol: 4 },
      { ...current, contextReadArguments: "single-read-ref" },
      { ...current, contextTextReadFormat: "context-text-read-v2" },
    ]) {
      status = changed;
      expect(await owner.contextToolsAvailable()).toBe(false);
      expect(await owner.contextBootstrapAvailable()).toBe(false);
      expect(await owner.contextReuseAvailable()).toBe(false);
    }
    for (const changed of [{ ...current, contextManifestVersion: 2 }, { ...current, contextRequiredDiscovery: "entries" }]) {
      status = changed;
      expect(await owner.contextToolsAvailable()).toBe(true);
      expect(await owner.contextBootstrapAvailable()).toBe(false);
      expect(await owner.contextReuseAvailable()).toBe(false);
    }
    status = current;
    expect(await owner.contextToolsAvailable()).toBe(true);
    expect(await owner.contextBootstrapAvailable()).toBe(true);
    expect(await owner.contextReuseAvailable()).toBe(true);
    expect(new Set(methods)).toEqual(new Set(["owner_status"]));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
