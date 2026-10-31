import { existsSync } from "node:fs";

export async function waitForChildReady(
  child: Bun.Subprocess<"pipe", "pipe", "pipe">,
  readyPath: string,
  timeoutMs = 30_000,
): Promise<void> {
  // Drain diagnostics during startup, but never wait for EOF from a live child.
  const stderr = new Response(child.stderr).text().catch(error => String(error));
  const deadline = performance.now() + timeoutMs;
  const running = () => child.exitCode === null && child.signalCode === null;
  while (!existsSync(readyPath) && running() && performance.now() < deadline) {
    await Bun.sleep(10);
  }
  if (existsSync(readyPath)) return;

  const reason = running() ? "readiness deadline exceeded" : "exited before readiness";
  if (running()) child.kill("SIGKILL");
  await child.exited;
  throw new Error(`Child ${reason}: ${readyPath}; exit=${child.exitCode}; signal=${child.signalCode}`
    + `\nstderr: ${(await stderr).slice(-8_192)}`);
}
