const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const vm = require("node:vm");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

test("the public launcher command uses the Electron bootstrap", () => {
  assert.equal(repositoryManifest.scripts.launcher, "bun run scripts/start-launcher.ts");
  assert.equal(repositoryManifest.scripts.launcher, repositoryManifest.scripts.app);
});

test("the full verification gate audits dependencies without advisory exclusions", () => {
  assert.equal(repositoryManifest.scripts.audit, "bun audit");
  assert.equal(manifest.scripts.audit, "bun audit");
  assert.equal(repositoryManifest.scripts["launcher:audit"], "bun run --cwd launcher audit");
  const verification = spawnSync("bun", ["-e", `
    import { verificationCommands } from "./scripts/verify.ts";
    console.log(JSON.stringify(["full", "timing"].map(mode => verificationCommands(mode, "scratch"))));
  `], { cwd: repositoryRoot, encoding: "utf8", timeout: 10_000 });
  assert.equal(verification.status, 0, verification.error?.message || verification.stderr);
  for (const commands of JSON.parse(verification.stdout)) {
    assert.deepEqual(commands.filter(command => command[1] === "audit" || command[1] === "launcher:audit"),
      [["run", "audit"], ["run", "launcher:audit"]]);
    assert.ok(commands.findIndex(command => command[1] === "launcher:audit")
      < commands.findIndex(command => command[1] === "test"));
  }
});

test("launcher publishes native packages for all supported desktop operating systems", () => {
  assert.equal(manifest.build.appId, "dev.codexwebgpt.launcher");
  assert.equal(manifest.build.artifactName, "codex-web-gpt-${version}-${os}-${arch}.${ext}");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(
    manifest.build.mac.signIgnore,
    ["[/\\\\]Contents[/\\\\]Resources[/\\\\]runtime[/\\\\]runtime[/\\\\]bun$"],
  );
  assert.deepEqual(manifest.build.win.target, ["nsis"]);
  assert.equal(manifest.build.win.icon, "assets/icon.ico");
  assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
  assert.ok(manifest.build.files.includes("assets/icon.png"));
  assert.ok(manifest.build.files.includes("assets/linux-appimage-runner.sh"));
  assert.ok(manifest.build.asarUnpack.includes("assets/linux-appimage-runner.sh"));
  assert.equal(manifest.build.afterPack, undefined);
  assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, false);
  assert.equal(manifest.build.nsis.runAfterFinish, true);
  assert.match(manifest.build.nsis.guid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
});

test("release installers resolve checksummed native launcher assets", () => {
  const shellInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.sh"), "utf8");
  const windowsInstaller = fs.readFileSync(path.join(repositoryRoot, "scripts", "install-launcher.ps1"), "utf8");
  const devProfile = fs.readFileSync(path.join(repositoryRoot, "src", "dev-chat", "profile.ts"), "utf8");
  const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
  for (const installer of [shellInstaller, windowsInstaller]) {
    assert.match(installer, /checksums\.txt/);
    assert.match(installer, /SHA-?256/i);
    assert.match(installer, /releases\/download/);
  }
  assert.match(shellInstaller, /PLATFORM="mac"/);
  assert.match(shellInstaller, /PLATFORM="linux"/);
  assert.match(shellInstaller, /codex-web-gpt\.desktop/);
  assert.match(shellInstaller, /--appimage-extract/);
  assert.match(packager, /-linux-x86_64\(\?=\\\.\).*?-linux-x64/);
  assert.match(packager, /const executable = "node"/);
  assert.doesNotMatch(packager, /process\.execPath/);
  assert.match(packager, /electron-builder\/out\/cli\/cli\.js/);
  assert.match(packager, /target === "--mac" && !env\.CSC_LINK && !env\.CSC_NAME/);
  assert.match(packager, /--config\.mac\.identity=-/);
  assert.match(packager, /verifySignedMacArchive\(\)/);
  assert.match(packager, /codesign[\s\S]*--verify[\s\S]*--deep[\s\S]*--strict/);
  assert.match(packager, /validateRuntimeBundle/);
  assert.doesNotMatch(packager, /electron-builder\.cmd/);
  assert.match(shellInstaller, /shell_quote\(\)/);
  assert.match(shellInstaller, /RUNNER_SOURCE/);
  assert.match(shellInstaller, /exec %s %s "\$@"/);
  assert.doesNotMatch(shellInstaller, /APPIMAGE_EXTRACT_AND_RUN=.*1/);
  assert.ok(
    shellInstaller.indexOf('chmod 0755 "$TEMP_DIR/$ASSET"')
      < shellInstaller.indexOf('"$TEMP_DIR/$ASSET" --appimage-extract'),
    "the downloaded AppImage must be executable before it is inspected",
  );
  assert.match(windowsInstaller, /codex-web-gpt-\$Version-win-\$Arch\.exe/);
  assert.match(windowsInstaller, /\[Environment\]::Is64BitOperatingSystem/);
  assert.doesNotMatch(windowsInstaller, /RuntimeInformation/);
  assert.match(windowsInstaller, /function Test-IsFullyQualifiedWindowsPath/);
  assert.match(windowsInstaller, /Test-IsFullyQualifiedWindowsPath \$InstallLocation/);
  assert.doesNotMatch(windowsInstaller, /IsPathFullyQualified/);
  const windowsPathPattern = windowsInstaller.match(/return \$Path -match '([^']+)'/)?.[1];
  assert.ok(windowsPathPattern, "the Windows installer must expose its absolute-path contract");
  const fullyQualifiedWindowsPath = new RegExp(windowsPathPattern);
  assert.equal(fullyQualifiedWindowsPath.test("C:\\Users\\tester\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("\\\\server\\share\\Codex Web GPT"), true);
  assert.equal(fullyQualifiedWindowsPath.test("C:Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("\\Codex Web GPT"), false);
  assert.equal(fullyQualifiedWindowsPath.test("Codex Web GPT"), false);
  assert.ok(windowsInstaller.includes(`HKCU:\\Software\\${manifest.build.nsis.guid}`));
  assert.ok(devProfile.includes(`WINDOWS_LAUNCHER_GUID = "${manifest.build.nsis.guid}"`));
  assert.match(windowsInstaller, /Get-ItemPropertyValue[\s\S]*InstallLocation/);
  assert.ok(windowsInstaller.includes(`Join-Path $InstallLocation "${manifest.build.productName}.exe"`));
  assert.match(windowsInstaller, /-ArgumentList "\/S", "\/currentuser"/);
  const packageSmoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(packageSmoke, /run\(installer, \["\/S", "\/currentuser"\]/);
  assert.match(packageSmoke, /reg\.exe[\s\S]*InstallLocation/);
});

test("macOS pull requests can sign ad hoc without enabling certificate signing", () => {
  const packageScript = path.join(launcherRoot, "scripts", "package.cjs");
  const source = fs.readFileSync(packageScript, "utf8");
  const scriptRequire = createRequire(packageScript);
  for (const credentials of [{}, { CSC_LINK: "test-certificate.p12" }, { CSC_NAME: "Test Developer ID" }]) {
    const env = { GITHUB_BASE_REF: "main", CSC_FOR_PULL_REQUEST: "false", ...credentials };
    const stopped = new Error("builder invocation captured");
    let invocation;
    const mockRequire = name => name === "node:child_process" ? {
      spawnSync: (command, args, options) => {
        invocation = { command, args, env: options.env };
        return { error: stopped };
      },
    } : scriptRequire(name);
    mockRequire.resolve = scriptRequire.resolve;
    assert.throws(() => vm.runInNewContext(source, {
      require: mockRequire,
      __dirname: path.dirname(packageScript),
      process: { argv: ["node", packageScript], platform: "darwin", arch: "arm64", env },
    }), error => error === stopped);
    assert.equal(invocation.command, "node");
    const adHoc = !credentials.CSC_LINK && !credentials.CSC_NAME;
    assert.equal(invocation.args.includes("--config.mac.identity=-"), adHoc);
    assert.equal(invocation.env.CSC_FOR_PULL_REQUEST, adHoc ? "true" : "false");
    if (adHoc) assert.equal(invocation.env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(env.CSC_FOR_PULL_REQUEST, "false", "the parent environment must remain unchanged");
  }
});

test("failed package smoke reports readiness and launcher logs before removing its scratch directory", () => {
  const smokeScript = path.join(launcherRoot, "scripts", "smoke-package.cjs");
  const scriptRequire = createRequire(smokeScript);
  const diagnostics = [];
  let scratch;
  const mockFs = {
    ...fs,
    readdirSync: directory => directory === path.join(launcherRoot, "artifacts")
      ? ["test-win-x64.exe"] : fs.readdirSync(directory),
    existsSync: file => file.endsWith("Codex Web GPT.exe") || fs.existsSync(file),
  };
  const mockRequire = name => name === "node:fs" ? mockFs : name === "node:child_process" ? {
    spawnSync: (command, args, options) => {
      if (command === "reg.exe") return { status: 0, stdout: "  InstallLocation  REG_SZ  C:\\Installed\n" };
      if (!args.includes("--launcher-smoke-test")) return { status: 0 };
      scratch = options.cwd;
      const logs = path.join(options.env.CODEX_WEB_GPT_LAUNCHER_DATA_DIR, "logs");
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(options.env.CODEX_WEB_GPT_SMOKE_FILE, '{"ok":true}\n');
      fs.writeFileSync(path.join(logs, "launcher-fatal.log"), "shutdown diagnostic\n");
      return { status: 3, stdout: "application stdout", stderr: "application stderr" };
    },
  } : scriptRequire(name);
  assert.throws(() => vm.runInNewContext(fs.readFileSync(smokeScript, "utf8"), {
    require: mockRequire,
    __dirname: path.dirname(smokeScript),
    process: { env: {}, platform: "win32", arch: "x64" },
    console: { error: message => diagnostics.push(message) },
  }), error => {
    assert.match(error.message, /status 3/);
    assert.match(error.message, /application stdout/);
    assert.match(error.message, /application stderr/);
    return true;
  });
  assert.match(diagnostics.join("\n"), /ready\.json[\s\S]*"ok":true/);
  assert.match(diagnostics.join("\n"), /launcher-fatal\.log[\s\S]*shutdown diagnostic/);
  assert.equal(fs.existsSync(scratch), false);
});

test("packaged launcher owns a detached checksummed updater for every release platform", () => {
  const updater = fs.readFileSync(path.join(launcherRoot, "electron", "update.cjs"), "utf8");
  const worker = fs.readFileSync(path.join(launcherRoot, "electron", "update-worker.cjs"), "utf8");
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.match(updater, new RegExp(`platform === "${platform}"`));
    assert.match(worker, new RegExp(`job\\.platform === "${platform}"`));
  }
  assert.match(updater, /expectedChecksum/);
  assert.match(updater, /SHA-256 verification failed/);
  assert.match(updater, /detached:\s*true/);
  assert.match(worker, /waitForParent/);
  assert.doesNotMatch(worker, /backup/i);
});

test("Linux installer selects native assets and rejects unsupported architectures or bad checksums", {
  skip: process.platform === "win32" ? "POSIX installer" : false,
}, () => {
  if (process.platform === "win32") return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-installer-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  script("uname", 'case "$1" in -s) echo Linux ;; -m) echo "$TEST_MACHINE" ;; esac');
  script("pgrep", "exit 1");
  script("nohup", 'printf started > "$TEST_ROOT/started"');
  script("update-desktop-database", "exit 0");
  script("curl", `
while [ "$#" -gt 0 ]; do
  case "$1" in https:*) url="$1" ;; -o) shift; output="$1" ;; esac
  shift
done
printf '%s\\n' "$url" >> "$TEST_ROOT/downloads"
case "$url" in
  */checksums.txt) cp "$TEST_ROOT/checksums.txt" "$output" ;;
  *) cp "$TEST_ROOT/fixture.AppImage" "$output" ;;
esac`);
  const appImage = Buffer.from(`#!/bin/sh
set -eu
test "$1" = --appimage-extract
printf extracted > "$TEST_ROOT/extracted"
mkdir -p squashfs-root/usr/share/icons/hicolor/512x512/apps squashfs-root/resources/app.asar.unpacked/assets
printf icon > squashfs-root/usr/share/icons/hicolor/512x512/apps/test.png
printf '#!/bin/sh\\nexit 0\\n' > squashfs-root/resources/app.asar.unpacked/assets/linux-appimage-runner.sh
`);
  // Use Node's real SHA-256 implementation on macOS as well as Linux.
  fs.writeFileSync(path.join(bin, "sha256sum"), `#!${process.execPath}\nconst fs = require('node:fs'); const c = require('node:crypto'); console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex') + '  ' + process.argv[2]);\n`, { mode: 0o755 });
  try {
    for (const [machine, arch, valid] of [
      ["x86_64", "x64", true], ["amd64", "x64", true],
      ["aarch64", "arm64", true], ["arm64", "arm64", true],
      ["aarch64", "arm64", false], ["armv7l", null, true],
    ]) {
      const root = path.join(scratch, `${machine}-${valid}`);
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "fixture.AppImage"), appImage);
      const asset = `codex-web-gpt-1.2.3-linux-${arch}.AppImage`;
      const checksum = valid ? createHash("sha256").update(appImage).digest("hex") : "0".repeat(64);
      fs.writeFileSync(path.join(root, "checksums.txt"), `${checksum}  ${asset}\n`);
      const result = spawnSync("/bin/sh", [path.join(repositoryRoot, "scripts", "install-launcher.sh")], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          TEST_MACHINE: machine, TEST_ROOT: root, CODEX_WEB_GPT_VERSION: "1.2.3",
          CODEX_WEB_GPT_LIB_DIR: path.join(root, "lib"), CODEX_WEB_GPT_BIN_DIR: path.join(root, "installed-bin"),
          CODEX_CHATGPT_WEB_HOME: path.join(root, "core"), XDG_DATA_HOME: path.join(root, "data"),
        },
      });
      if (!arch) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unsupported Linux architecture/);
        assert.equal(fs.existsSync(path.join(root, "downloads")), false);
      } else {
        assert.match(fs.readFileSync(path.join(root, "downloads"), "utf8"), new RegExp(`${asset.replaceAll(".", "\\.")}$`, "m"));
        if (valid) {
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(fs.readFileSync(path.join(root, "lib", "1.2.3", "Codex Web GPT.AppImage")), appImage);
          assert.ok(fs.existsSync(path.join(root, "data", "applications", "codex-web-gpt.desktop")));
        } else {
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /SHA-256 verification failed/);
          assert.equal(fs.existsSync(path.join(root, "lib")), false);
          assert.equal(fs.existsSync(path.join(root, "extracted")), false);
        }
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

function readWorkflow(name) {
  const source = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", `${name}.yml`), "utf8");
  const parsed = spawnSync("bun", ["-e", "console.log(JSON.stringify(Bun.YAML.parse(await Bun.stdin.text())))"], {
    input: source, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(parsed.status, 0, parsed.error?.message || parsed.stderr);
  return { source, ...JSON.parse(parsed.stdout) };
}

function workflowExpression(value, { inputs = {}, matrix = {}, runner = {}, env = {} } = {}) {
  if (typeof value !== "string") return value ?? true;
  const expression = value.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return Function("inputs", "matrix", "runner", "env", "always", `return (${expression});`)(
    inputs, matrix, runner, env, () => true,
  );
}

function workflowStep(job, predicate) {
  const steps = job.steps.filter(predicate);
  assert.equal(steps.length, 1, "the workflow must retain exactly one matching step");
  return steps[0];
}

const jobNeeds = job => [job.needs ?? []].flat();

test("CI defaults to two timing shards and keeps the single-job and worker fallbacks", () => {
  const ci = readWorkflow("ci");
  const inputs = ci.on.workflow_dispatch.inputs;
  assert.ok(Object.hasOwn(ci.on, "push") && Object.hasOwn(ci.on, "pull_request"));
  assert.equal(inputs.windows_test_topology.default, "sharded");
  assert.deepEqual(inputs.windows_test_topology.options, ["sharded", "single"]);
  assert.deepEqual(inputs.test_workers.options, ["auto", "1", "2"]);
  assert.equal(Object.hasOwn(inputs, "windows_skip_evidence"), false);
  for (const topology of [undefined, inputs.windows_test_topology.default, "single"]) {
    const context = { inputs: { windows_test_topology: topology } };
    assert.equal(workflowExpression(ci.jobs["windows-test-shard"].if, context), topology !== "single");
    assert.equal(workflowExpression(ci.jobs["windows-verify"].if, context), topology === "single");
    assert.equal(workflowExpression(ci.jobs["windows-gate"].env.WINDOWS_TOPOLOGY, context), topology || "sharded");
  }
  for (const name of ["verify", "windows-verify", "windows-test-shard", "windows-gate"]) {
    for (const workers of [undefined, "auto", "1", "2"]) {
      assert.equal(workflowExpression(ci.jobs[name].env.CGW_TEST_WORKERS, { inputs: { test_workers: workers } }),
        workers === "1" ? "1" : "2", `${name} must retain the selected worker count`);
    }
  }
  for (const name of ["verify", "windows-verify"]) {
    assert.match(workflowStep(ci.jobs[name], step => /^bun run verify\b/.test(step.run)).run, /--test-mode=timing(?:\s|$)/);
  }
  assert.equal(ci.jobs["windows-verify"]["runs-on"], "windows-latest");
});

test("CI and Release preserve complete Windows verification, cold shards, and attempt-bound aggregation", () => {
  for (const name of ["ci", "release"]) {
    const workflow = readWorkflow(name);
    const shards = workflow.jobs["windows-test-shard"];
    const gate = workflow.jobs["windows-gate"];
    assert.equal(shards["runs-on"], "windows-latest");
    assert.deepEqual(shards.strategy.matrix.shard, [1, 2]);
    assert.equal(shards.strategy["fail-fast"], false);
    assert.ok(jobNeeds(gate).includes("windows-test-shard"));
    assert.equal(gate.if, "always()");
    assert.equal(gate.env.WINDOWS_SHARDS_RESULT, "${{ needs.windows-test-shard.result }}");
    const verify = workflowStep(shards, step => /^bun run verify\b/.test(step.run));
    const server = workflowStep(shards, step => /^bun run test\b/.test(step.run));
    assert.match(verify.run, /--test-mode=timing(?:\s|$)/);
    assert.match(verify.run, /--test-shard=1\/2(?:\s|$)/);
    assert.match(server.run, /--mode=timing(?:\s|$)/);
    assert.match(server.run, /--shard=2\/2(?:\s|$)/);
    const installer = workflowStep(shards, step => step.shell === "powershell");
    assert.match(installer.run, /PSVersionTable\.PSVersion\.Major -ne 5/);
    assert.match(installer.run, /\[scriptblock\]::Create\(\$source\)/);
    assert.match(installer.run, /scripts\/install-launcher\.ps1/);
    for (const shard of [1, 2]) {
      const context = { matrix: { shard } };
      assert.equal(workflowExpression(verify.if, context), shard === 1);
      assert.equal(workflowExpression(server.if, context), shard === 2);
      assert.equal(workflowExpression(installer.if, context), shard === 1);
    }
    for (const scopedEnv of [workflow.env, shards.env, ...shards.steps.map(step => step.env)]) {
      assert.equal(Object.keys(scopedEnv ?? {}).some(key => key.startsWith("CGW_TEST_TIMING_")), false,
        `${name} shards must not inherit timing-history settings`);
    }
    for (const job of [shards, gate]) {
      const configure = job.steps.findIndex(step => /git config --global core\.autocrlf false/.test(step.run));
      const checkout = job.steps.findIndex(step => step.uses?.startsWith("actions/checkout@"));
      assert.ok(configure >= 0 && checkout > configure, "shard evidence must use the original repository bytes");
      assert.equal(job["continue-on-error"], undefined);
      assert.ok(job.steps.every(step => !step["continue-on-error"]));
    }
    const evidence = workflowStep(shards, step => step.uses?.startsWith("actions/upload-artifact@"));
    assert.equal(evidence.if, "always()");
    assert.equal(evidence.with["if-no-files-found"], "error");
    assert.ok(evidence.with.name.includes("${{ github.run_attempt }}"));
    assert.equal(shards.steps.some(step => step.uses?.startsWith("actions/download-artifact@")), false);
    const downloads = gate.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(downloads.length, 2);
    for (const shard of [1, 2]) {
      const download = downloads.find(step => step.with.name.includes(`-shard-${shard}-of-2-`));
      assert.ok(download, `the gate must download exact evidence for shard ${shard}`);
      assert.equal(download.with.name, evidence.with.name.replace("${{ matrix.shard }}", String(shard)));
      assert.ok(download.with.name.includes("${{ env.CGW_TEST_WORKERS }}"));
    }
    const aggregate = workflowStep(gate, step => /scripts\/aggregate-test-shards\.ts/.test(step.run));
    assert.match(aggregate.run, /--skip-policy=\.github\/windows-test-skips\.json(?:\s|$)/);
    assert.match(aggregate.run, /--mode=timing(?:\s|$)/);
    assert.match(aggregate.run, /--job-results=/);
    assert.doesNotMatch(aggregate.run, /--skip-evidence|WINDOWS_SKIP_EVIDENCE/);
    const expectedNeeds = name === "ci" ? ["windows-verify", "windows-test-shard", "windows-package"] : ["build", "windows-test-shard"];
    assert.deepEqual(jobNeeds(gate).sort(), expectedNeeds.sort());
    const packageJob = name === "ci" ? "windows-package" : "build";
    assert.equal(gate.env.WINDOWS_PACKAGE_RESULT, `\${{ needs.${packageJob}.result }}`);
    const states = workflowStep(gate, step => /WINDOWS_PACKAGE_RESULT/.test(step.run) && !/bun /.test(step.run));
    // These steps run under bash on Ubuntu. Execute them on POSIX hosts to check failure propagation.
    if (process.platform !== "win32") {
      const pass = { WINDOWS_TOPOLOGY: "sharded", WINDOWS_SHARDS_RESULT: "success", WINDOWS_FULL_RESULT: "skipped", WINDOWS_PACKAGE_RESULT: "success" };
      const succeeds = env => spawnSync("bash", ["-e", "-o", "pipefail", "-c", states.run], {
        env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
      }).status === 0;
      assert.equal(succeeds(pass), true);
      for (const result of ["failure", "cancelled", "skipped"]) {
        for (const key of ["WINDOWS_SHARDS_RESULT", "WINDOWS_PACKAGE_RESULT"]) {
          assert.equal(succeeds({ ...pass, [key]: result }), false, `${name} must reject ${key}=${result}`);
        }
      }
      if (name === "ci") {
        const single = { ...pass, WINDOWS_TOPOLOGY: "single", WINDOWS_FULL_RESULT: "success", WINDOWS_SHARDS_RESULT: "skipped" };
        assert.equal(succeeds(single), true);
        assert.equal(succeeds({ ...single, WINDOWS_FULL_RESULT: "failure" }), false);
        assert.equal(succeeds({ ...pass, WINDOWS_FULL_RESULT: "success" }), false);
      }
    }
  }
});

test("CI and Release retain platform packages, smoke tests, signatures, and publication dependencies", () => {
  const ci = readWorkflow("ci");
  const release = readWorkflow("release");
  assert.deepEqual(ci.jobs.verify.strategy.matrix.os, ["macos-15", "ubuntu-latest"]);
  for (const job of [ci.jobs.verify, ci.jobs["windows-package"], release.jobs.build]) {
    for (const command of ["bun run app:package", "bun run app:smoke"]) {
      const step = workflowStep(job, step => step.run === command);
      for (const os of job === ci.jobs.verify ? ["macOS", "Linux"] : job === ci.jobs["windows-package"] ? ["Windows"] : ["macOS", "Linux", "Windows"]) {
        assert.equal(workflowExpression(step.if, { runner: { os } }), true, `${command} must run on ${os}`);
      }
    }
  }
  assert.equal(ci.jobs["windows-package"]["runs-on"], "windows-latest");
  assert.deepEqual(release.jobs.build.strategy.matrix.include, [
    { runner: "macos-15", runtime_asset: "codex-chatgpt-web-darwin-arm64.tar.gz" },
    { runner: "ubuntu-latest", runtime_asset: "codex-chatgpt-web-linux-amd64.tar.gz" },
    { runner: "ubuntu-24.04-arm", runtime_asset: "codex-chatgpt-web-linux-arm64.tar.gz" },
    { runner: "windows-latest", runtime_asset: "codex-chatgpt-web-windows-amd64.zip" },
  ]);
  const verify = workflowStep(release.jobs.build, step => /^bun run verify\b/.test(step.run));
  assert.match(verify.run, /--test-mode=timing(?:\s|$)/);
  for (const os of ["macOS", "Linux", "Windows"]) {
    assert.equal(workflowExpression(verify.if, { runner: { os } }), os !== "Windows");
  }
  assert.equal(verify.env.CGW_TEST_TIMING_RESTORE, "1");
  assert.ok(verify.env.CGW_TEST_TIMING_TOKEN);
  assert.ok(verify.env.CGW_TEST_TIMING_ARTIFACT_DIR);
  const timings = workflowStep(release.jobs.build, step => step.with?.name === "test-timings-${{ matrix.runner }}");
  assert.equal(workflowExpression(timings.if, { runner: { os: "Windows" } }), false);
  assert.equal(workflowExpression(timings.if, { runner: { os: "Linux" } }), true);
  for (const name of ["build", "windows-test-shard", "intel"]) {
    assert.ok(jobNeeds(release.jobs[name]).includes("codex-model-gate"));
  }
  for (const name of ["build", "windows-test-shard", "windows-gate"]) {
    assert.equal(release.jobs[name].env.CGW_TEST_WORKERS, "2");
  }
  assert.deepEqual(jobNeeds(release.jobs.publish).sort(), ["build", "intel", "windows-gate"]);
  assert.deepEqual(jobNeeds(release.jobs["publish-image"]), ["publish"]);
  for (const name of ["publish", "publish-image"]) {
    assert.equal(release.jobs[name].if, undefined, `${name} must require all dependencies to succeed`);
    assert.equal(release.jobs[name]["continue-on-error"], undefined);
  }
  for (const source of [ci.source, release.source]) {
    assert.match(source, /prepare-linux-libnotify\.sh/);
    assert.match(source, /prepare-linux-appimage-tools\.cjs/);
    assert.match(source, /archlinux:base/);
    assert.match(source, /prepare-windows-baseline-bun\.ps1 -Version 1\.4\.3/);
  }
  assert.match(release.source, /launcher\/build\/runtime/);
  const abi = workflowStep(release.jobs.build, step => step.name === "Verify Linux AppImage ABI on current Arch");
  assert.equal(workflowExpression(abi.if, { runner: { os: "Linux", arch: "X64" } }), true);
  assert.equal(workflowExpression(abi.if, { runner: { os: "Linux", arch: "ARM64" } }), false);
  assert.match(release.source, /codesign --verify --deep --strict --verbose=2/);
  assert.match(release.source, /Codex Web GPT\.app/);
  assert.doesNotMatch(release.source, /gh release create[\s\S]*?--draft/);
});

test("Intel release shards retain package signatures, complete coverage, and the same diagnostic workflow", () => {
  const release = readWorkflow("release"), intel = readWorkflow("intel-release"), diagnostic = readWorkflow("windows-performance");
  const shards = intel.jobs["test-shard"], gate = intel.jobs.gate, packaged = intel.jobs.package;
  assert.equal(release.jobs.intel.uses, "./.github/workflows/intel-release.yml");
  assert.equal(diagnostic.jobs["intel-shards"].uses, release.jobs.intel.uses);
  assert.ok(Object.hasOwn(intel.on, "workflow_call"));
  assert.equal(shards["runs-on"], "macos-15-intel");
  assert.deepEqual(shards.strategy.matrix.shard, [1, 2]);
  assert.equal(shards.strategy["fail-fast"], false);
  assert.equal(shards.env.CGW_TEST_WORKERS, "2");
  const verify = workflowStep(shards, step => /^bun run verify\b/.test(step.run));
  const server = workflowStep(shards, step => /^bun run test\b/.test(step.run));
  assert.equal(verify.run, "bun run verify --test-mode=timing --test-shard=1/2");
  assert.equal(server.run, "bun run test --mode=timing --shard=2/2");
  for (const shard of [1, 2]) {
    assert.equal(workflowExpression(verify.if, { matrix: { shard } }), shard === 1);
    assert.equal(workflowExpression(server.if, { matrix: { shard } }), shard === 2);
  }
  for (const job of [shards, diagnostic.jobs["intel-baseline"]]) {
    for (const env of [intel.env, diagnostic.env, job.env, ...job.steps.map(step => step.env)]) {
      assert.equal(Object.keys(env ?? {}).some(key => key.startsWith("CGW_TEST_TIMING_")), false);
    }
  }
  assert.deepEqual(jobNeeds(packaged), []);
  assert.equal(packaged["runs-on"], "macos-15-intel");
  for (const command of ["bun run app:package", "bun run app:smoke",
    "codesign --verify --deep --strict launcher/build/runtime/runtime/bun"]) {
    assert.equal(workflowStep(packaged, step => step.run === command).if, undefined);
  }
  assert.match(workflowStep(packaged, step => step.name === "Verify packaged macOS application signature").run,
    /codesign --verify --deep --strict --verbose=2/);
  const archive = workflowStep(packaged, step => step.name === "Archive runtime");
  assert.match(archive.run, /codex-chatgpt-web-darwin-amd64\.tar\.gz/);
  const upload = workflowStep(packaged, step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.name, "release-macos-15-intel");
  for (const asset of ["codex-chatgpt-web-darwin-amd64.tar.gz", "launcher/artifacts/*.dmg", "launcher/artifacts/*.zip"]) {
    assert.ok(upload.with.path.includes(asset));
  }
  assert.equal(gate.if, "always()");
  assert.deepEqual(jobNeeds(gate).sort(), ["package", "test-shard"]);
  assert.equal(gate.env.INTEL_SHARDS_RESULT, "${{ needs.test-shard.result }}");
  assert.equal(gate.env.INTEL_PACKAGE_RESULT, "${{ needs.package.result }}");
  for (const job of [shards, gate, packaged]) {
    assert.equal(job["continue-on-error"], undefined);
    assert.ok(job.steps.every(step => !step["continue-on-error"]));
  }
  const evidence = workflowStep(shards, step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(evidence.if, "always()");
  assert.equal(evidence.with["if-no-files-found"], "error");
  const downloads = gate.steps.filter(step => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(downloads.length, 2);
  for (const shard of [1, 2]) {
    assert.ok(downloads.some(step => step.with.name === evidence.with.name.replace("${{ matrix.shard }}", String(shard))));
  }
  const aggregate = workflowStep(gate, step => /scripts\/aggregate-test-shards\.ts/.test(step.run));
  assert.match(aggregate.run, /--skip-policy=\.github\/macos-intel-test-skips\.json --platform=darwin --arch=x64 --mode=timing/);
  const states = workflowStep(gate, step => step.name === "Check complete Intel job states");
  if (process.platform !== "win32") {
    const pass = { INTEL_SHARDS_RESULT: "success", INTEL_PACKAGE_RESULT: "success" };
    const succeeds = env => spawnSync("bash", ["-e", "-o", "pipefail", "-c", states.run], {
      env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
    }).status === 0;
    assert.equal(succeeds(pass), true);
    for (const key of Object.keys(pass)) for (const result of ["failure", "cancelled", "skipped", ""]) {
      assert.equal(succeeds({ ...pass, [key]: result }), false);
    }
  }
  for (const condition of ["intel-shards", "mode-pair", "all"]) {
    const context = { inputs: { condition } };
    assert.equal(workflowExpression(diagnostic.jobs.diagnose.if, context), condition !== "intel-shards");
    for (const name of ["intel-shards", "intel-baseline"]) {
      assert.equal(workflowExpression(diagnostic.jobs[name].if, context), condition === "intel-shards");
    }
  }
});

test("Linux AppImage fallback uses one owned extraction and removes it on exit", {
  skip: process.platform !== "linux" ? "AppImage process identity is Linux-specific" : false,
}, () => {
  // node:test honours the `skip` option above and reports this as skipped. Bun's shim ignores that
  // option and runs the body anyway, and implements neither t.skip(), so the test read /proc on
  // macOS and failed for everyone running `bun test` locally. Returning early is the one form both
  // runners agree on.
  if (process.platform !== "linux") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-appimage-runner-"));
  const runtime = path.join(root, "runtime");
  const appImage = path.join(root, "Codex Web GPT.AppImage");
  const appRunSource = path.join(root, "AppRun");
  const marker = path.join(root, "launched");
  const runner = path.join(launcherRoot, "assets", "linux-appimage-runner.sh");
  fs.mkdirSync(runtime);
  fs.writeFileSync(appRunSource, [
    "#!/bin/sh",
    `printf '%s|%s' \"$APPIMAGE\" \"$1\" > ${JSON.stringify(marker)}`,
    "",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(appImage, [
    "#!/bin/sh",
    "if [ \"$1\" != \"--appimage-extract\" ]; then exit 99; fi",
    "mkdir -p squashfs-root",
    "cp \"$FAKE_APPRUN_SOURCE\" squashfs-root/AppRun",
    "chmod 0755 squashfs-root/AppRun",
    "",
  ].join("\n"), { mode: 0o755 });
  const fallbackRoot = path.join(runtime, `codex-web-gpt-appimage-${process.getuid?.() ?? 0}`);
  const stale = path.join(fallbackRoot, "run.stale");
  const active = path.join(fallbackRoot, "run.active");
  const ownerStart = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8")
    .replace(/^[^)]*\) /, "")
    .split(/\s+/)[19];
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, "owner.pid"), `${process.pid} ${Number(ownerStart) + 1}\n`);
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, "owner.pid"), `${process.pid} ${ownerStart}\n`);
  try {
    const result = spawnSync(runner, [appImage, "hello"], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: "1",
        FAKE_APPRUN_SOURCE: appRunSource,
        XDG_RUNTIME_DIR: runtime,
      },
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), `${appImage}|hello`);
    assert.deepEqual(fs.readdirSync(fallbackRoot), ["run.active"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux packaging stages native libnotify in an owned AppImage toolset before assembly", async () => {
  const source = fs.readFileSync(path.join(launcherRoot, "scripts", "prepare-linux-appimage-tools.cjs"), "utf8");
  const prepare = fs.readFileSync(path.join(repositoryRoot, "scripts", "prepare-linux-libnotify.sh"), "utf8");
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), "utf8");
  const license = fs.readFileSync(
    path.join(repositoryRoot, "LICENSES", "libnotify-0.8.7-LGPL-2.1.md"),
    "utf8",
  );
  for (const contract of [source, prepare, smoke]) {
    assert.match(contract, /notify_notification_get_activation_app_launch_context/);
  }
  assert.match(prepare, /4be15202ec4184fce1ac15997ece5530d2be32fe9573875aeb10e3b573858748/);
  assert.match(source, /getAppImageTools\("0\.0\.0", Arch\[process\.arch\]\)/);
  assert.match(source, /APPIMAGE_TOOLS_PATH/);
  assert.match(source, /must not replace the shared download cache/);
  assert.match(smoke, /cp "\$APPIMAGE_PATH" "\$SMOKE_APPIMAGE"/);
  assert.doesNotMatch(smoke, /chmod 0755 "\$APPIMAGE_PATH"/);
  assert.match(license, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(license, /libnotify-0\.8\.7\.tar\.xz/);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-toolset-"));
  const scriptRequire = createRequire(path.join(launcherRoot, "scripts", "prepare-linux-appimage-tools.cjs"));
  const module = { exports: {} };
  let symbols = "00000100 T notify_notification_get_activation_app_launch_context\n";
  vm.runInNewContext(source, {
    module, Buffer, process,
    require: (name) => name === "node:child_process"
      ? { spawnSync: () => ({ status: 0, stdout: symbols, stderr: "" }) } : scriptRequire(name),
  });
  const { replaceToolsetLibnotify, requireLibnotifySymbol } = module.exports;
  try {
    for (const [arch, machine] of [["x64", 62], ["arm64", 183]]) {
      const library = path.join(scratch, `${arch}.so`);
      const bytes = Buffer.alloc(64);
      Buffer.from("7f454c460201", "hex").copy(bytes);
      bytes.writeUInt16LE(3, 16);
      bytes.writeUInt16LE(machine, 18);
      fs.writeFileSync(library, bytes);
      const toolsRoot = path.join(scratch, arch);
      if (arch === "x64") {
        const libDir = path.join(toolsRoot, "lib", "x64");
        fs.mkdirSync(libDir, { recursive: true });
        fs.writeFileSync(path.join(libDir, "libnotify.so.4"), "old x64 library");
      }
      const staged = replaceToolsetLibnotify(toolsRoot, library, arch);
      assert.deepEqual(fs.readFileSync(staged), bytes);
      assert.throws(() => requireLibnotifySymbol(library, arch === "arm64" ? "x64" : "arm64"), /ELF shared library/);
      symbols = "00000100 T unrelated_symbol\n";
      assert.throws(() => requireLibnotifySymbol(library, arch), /does not export/);
      symbols = "00000100 T notify_notification_get_activation_app_launch_context\n";

      if (arch === "arm64") {
        // Exercise the pinned builder's actual CLI parser, schema and file copier.
        const packager = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
        assert.match(packager, /--config\.linux\.extraFiles\.from=\$\{library\}/);
        assert.match(packager, /--config\.linux\.extraFiles\.to=usr\/lib\/libnotify\.so\.4/);
        const parsed = scriptRequire("yargs/yargs")([
          `--config.linux.extraFiles.from=${staged}`,
          "--config.linux.extraFiles.to=usr/lib/libnotify.so.4",
        ]).parse();
        await scriptRequire("app-builder-lib/out/util/config/config.js").validateConfiguration(parsed.config, { isEnabled: false });
        const { getFileMatchers, copyFiles } = scriptRequire("app-builder-lib/out/fileMatcher.js");
        const appDir = path.join(scratch, "app");
        const matchers = getFileMatchers(parsed.config, "extraFiles", appDir, {
          macroExpander: value => value, customBuildOptions: parsed.config.linux,
          defaultSrc: scratch, globalOutDir: appDir,
        });
        await copyFiles(matchers);
        assert.deepEqual(fs.readFileSync(path.join(appDir, "usr", "lib", "libnotify.so.4")), bytes);
        assert.equal(fs.existsSync(path.join(toolsRoot, "lib", "x64")), false);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("macOS package smoke unregisters its staged app from LaunchServices", () => {
  const smoke = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
  assert.match(smoke, /Frameworks\/LaunchServices\.framework\/Support\/lsregister/);
  assert.match(smoke, /\["-u", macAppBundle\]/);
  assert.ok(
    smoke.indexOf('["-u", macAppBundle]') < smoke.indexOf("fs.rmSync(scratch"),
    "the staged app must be unregistered before its bundle is deleted",
  );
});

test("release does not publish demo or screenshot assets", () => {
  const release = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.doesNotMatch(release, /assets\/demo\.gif/);
  assert.doesNotMatch(release, /release-assets\/[^\n]*(?:demo|screenshot)/i);
});

test("Windows packages embed the checksummed Bun baseline runtime for CPUs without AVX2", () => {
  const builder = fs.readFileSync(path.join(repositoryRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
  const baseline = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "prepare-windows-baseline-bun.ps1"),
    "utf8",
  );
  assert.match(builder, /CODEX_CHATGPT_WEB_EMBEDDED_BUN/);
  assert.match(builder, /Embedded Bun must be/);
  assert.match(builder, /if not defined NODE_USE_SYSTEM_CA set "NODE_USE_SYSTEM_CA=1"/);
  assert.match(baseline, /bun-windows-x64-baseline\.zip/);
  assert.match(baseline, /SHASUMS256\.txt/);
  assert.match(baseline, /Get-FileHash[^\n]+SHA256/);
  assert.match(baseline, /CODEX_CHATGPT_WEB_EMBEDDED_BUN=/);
});
