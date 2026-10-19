import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ChatGptMcpContract, createChatGptMcpServer } from "../../src/adapters/chatgpt-web/mcp-server";

export type ContinuityMcpTransport = "stdio" | "in-process";

/** Each call owns its Client and both transport ends; fixtures must retain and call close. */
export async function createContinuityMcpClient(options: {
  brokerSocketPath: string;
  contract: ChatGptMcpContract;
  transport?: ContinuityMcpTransport;
  name?: string;
}): Promise<{ client: Client; close(): Promise<void> }> {
  const client = new Client({ name: options.name ?? "continuity-model-fixture", version: "1" });
  let server: ReturnType<typeof createChatGptMcpServer> | undefined;
  let cleanup: Promise<void> | undefined;
  const close = () => cleanup ??= (async () => {
    const errors: unknown[] = [];
    try { await client.close(); } catch (error) { errors.push(error); }
    try { await server?.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Continuity MCP cleanup failed");
  })();

  try {
    if (options.transport === "in-process") {
      const { createChatGptMcpServer } = await import("../../src/adapters/chatgpt-web/mcp-server");
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      server = createChatGptMcpServer(options);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    } else {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["src/cli.ts", "mcp", "--contract", options.contract, "--broker-socket", options.brokerSocketPath],
        cwd: process.cwd(), stderr: "pipe",
      });
      // Fixtures do not consume child diagnostics. Drain the pipe so logging cannot block tools.
      transport.stderr?.on("data", () => {});
      await client.connect(transport);
    }
    return { client, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Continuity MCP connection and cleanup failed");
    }
    throw error;
  }
}
