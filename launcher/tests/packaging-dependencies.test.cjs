const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const builderRequire = createRequire(require.resolve("app-builder-lib"));
const universalRequire = createRequire(builderRequire.resolve("@electron/universal"));

test("legacy glob sync handles recursive patterns, braces, dotfiles and exclusions", t => {
  const asarRequire = createRequire(builderRequire.resolve("@electron/asar"));
  const glob = asarRequire("glob");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-glob-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.mkdirSync(path.join(scratch, "nested"));
  for (const file of ["main.js", "main.txt", ".hidden.js", "nested/keep.js", "nested/skip.js"]) {
    fs.writeFileSync(path.join(scratch, file), "fixture");
  }

  const options = { cwd: scratch, ignore: "**/skip.*" };
  assert.deepEqual(glob.sync("**/*.{js,txt}", options).sort(), ["main.js", "main.txt", "nested/keep.js"]);
  assert.deepEqual(glob.sync("**/.*.js", options), [".hidden.js"]);
  assert.deepEqual(glob.sync("**/*.js", { ...options, dot: true }).sort(),
    [".hidden.js", "main.js", "nested/keep.js"]);
});

test("ASAR packs files and keeps matching files and directories unpacked", async t => {
  const asar = builderRequire("@electron/asar");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-asar-"));
  t.after(() => {
    asar.uncacheAll();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const source = path.join(scratch, "source");
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.mkdirSync(path.join(source, "native-addon"));
  fs.writeFileSync(path.join(source, "main.cjs"), "module.exports = 42;\n");
  fs.writeFileSync(path.join(source, "assets", "runner.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(source, "native-addon", "addon.node"), "native fixture\n");
  const archive = path.join(scratch, "app.asar");

  await asar.createPackageWithOptions(source, archive, { unpack: "*.sh", unpackDir: "native-*" });

  assert.equal(asar.extractFile(archive, "main.cjs").toString(), "module.exports = 42;\n");
  for (const file of ["assets/runner.sh", "native-addon/addon.node"]) {
    assert.equal(asar.statFile(archive, file).unpacked, true);
    assert.equal(fs.readFileSync(path.join(`${archive}.unpacked`, file), "utf8"),
      fs.readFileSync(path.join(source, file), "utf8"));
  }
});

test("universal bundle comparison applies include and exclude glob filters", async t => {
  const { compare } = universalRequire("dir-compare");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-dir-compare-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const left = path.join(scratch, "left");
  const right = path.join(scratch, "right");
  for (const [directory, content] of [[left, "left"], [right, "right"]]) {
    fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(directory, "nested", "keep.txt"), "same");
    fs.writeFileSync(path.join(directory, "nested", "ignored.txt"), content);
    fs.writeFileSync(path.join(directory, "nested", "other.js"), content);
  }
  const options = { compareContent: true, includeFilter: "*.txt", excludeFilter: "ignored.*" };

  assert.equal((await compare(left, right, options)).same, true);
  fs.writeFileSync(path.join(right, "nested", "keep.txt"), "changed");
  assert.equal((await compare(left, right, options)).same, false);
});
