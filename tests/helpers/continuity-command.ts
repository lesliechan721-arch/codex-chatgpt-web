/** A real command for the outer executor, with the same effects on all platforms. */
export function harmlessContinuityCommand(counter: string, output: string): string {
  const script = `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.stdout.write(${JSON.stringify(output)});`;
  // Bun Shell uses shell quoting on Windows too. Preserve backslashes and quotes
  // in both the executable path and the script instead of relying on cmd.exe.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} --eval ${quote(script)}`;
}
