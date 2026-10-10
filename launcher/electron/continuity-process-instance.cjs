const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const { win32 } = require("node:path");

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (start && /^\d+$/.test(start) && /^[a-f0-9-]{36}$/.test(boot)) return `linux:${boot}:${start}`;
    } else if (process.platform === "darwin") {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      }).trim();
      if (start) return `darwin:${start}`;
    } else if (process.platform === "win32") {
      // Preserve the OS creation time as integer FILETIME ticks, independent of locale.
      const start = execFileSync(win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)`],
        { encoding: "utf8", timeout: 5000, maxBuffer: 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (/^[1-9]\d{0,18}$/.test(start)) return `win32:${start}`;
    }
  } catch { /* No readable start identity is not exit evidence. */ }
  return null;
}
function knownProcessStart(value) {
  return typeof value === "string" && (/^linux:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:\d+$/.test(value)
    || /^darwin:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(value)
    || /^win32:[1-9]\d{0,18}$/.test(value));
}
function validLauncherInstance(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "instanceId,pid,startIdentity"
    && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647
    && typeof value.instanceId === "string" && /^[a-f0-9]{64}$/.test(value.instanceId)
    && typeof value.startIdentity === "string" && value.startIdentity.length > 0 && value.startIdentity.length <= 256;
}
function sameLauncherInstance(a, b) {
  return validLauncherInstance(a) && validLauncherInstance(b)
    && a.pid === b.pid && a.startIdentity === b.startIdentity && a.instanceId === b.instanceId;
}
function launcherProcessInstanceStatus(instance) {
  if (!validLauncherInstance(instance) || !knownProcessStart(instance.startIdentity)) return "unverified";
  try { process.kill(instance.pid, 0); }
  catch (error) { return error?.code === "ESRCH" ? "exited" : "unverified"; }
  const current = processStartIdentity(instance.pid);
  return current === null ? "unverified" : current === instance.startIdentity ? "live" : "exited";
}
function launcherInstance(host) {
  host.continuityLauncherInstance ??= { pid: process.pid, startIdentity: processStartIdentity(process.pid) ?? "unverified",
    instanceId: randomBytes(32).toString("hex") };
  return structuredClone(host.continuityLauncherInstance);
}

module.exports = { processStartIdentity, knownProcessStart, validLauncherInstance, sameLauncherInstance,
  launcherProcessInstanceStatus, launcherInstance };
