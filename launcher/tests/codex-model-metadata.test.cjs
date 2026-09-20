const test = require("node:test");
const assert = require("node:assert/strict");
const metadata = require("../electron/codex-model-metadata.cjs");
const bundledArtifact = require("../electron/generated/codex-bundled-models.json");
const schemaArtifact = require("../electron/generated/codex-model-info.schema.json");
const sourceLock = require("../electron/generated/codex-source-lock.json");

const BUNDLED_ID = "gpt-5.6-sol";
const UNKNOWN_ID = "provider/model-x";
const emptyDiscovery = () => metadata.parseUpstreamDiscovery({ data: [] });

test("generated bundled metadata and ModelInfo schema share the immutable Codex source lock", () => {
  assert.match(sourceLock.revision, /^[a-f0-9]{40}$/);
  assert.equal(bundledArtifact.revision, sourceLock.revision);
  assert.equal(schemaArtifact.revision, sourceLock.revision);
  assert.ok(bundledArtifact.models.some(model => model.slug === BUNDLED_ID));
  assert.equal(schemaArtifact.schema.type, "object");
});

test("metadata source availability and automatic mode follow all four source combinations", () => {
  const cases = [
    {
      id: BUNDLED_ID,
      discovery: metadata.parseUpstreamDiscovery({ models: [{ slug: BUNDLED_ID }] }),
      modes: ["upstream", "default", "fallback", "custom"],
      automatic: "upstream",
    },
    {
      id: UNKNOWN_ID,
      discovery: metadata.parseUpstreamDiscovery({ models: [{ slug: UNKNOWN_ID }] }),
      modes: ["upstream", "fallback", "custom"],
      automatic: "upstream",
    },
    {
      id: BUNDLED_ID,
      discovery: emptyDiscovery(),
      modes: ["default", "fallback", "custom"],
      automatic: "default",
    },
    {
      id: UNKNOWN_ID,
      discovery: emptyDiscovery(),
      modes: ["fallback", "custom"],
      automatic: "fallback",
    },
  ];
  for (const item of cases) {
    const resolved = metadata.resolveModelMetadata(item.id, undefined, item.discovery, "disabled");
    assert.deepEqual(resolved.availableModes, item.modes);
    assert.equal(resolved.automaticMode, item.automatic);
    assert.equal(resolved.effectiveMode, item.automatic);
  }
});

test("partial upstream metadata is row tolerant, field tolerant, and cannot replace project-owned agent control metadata", () => {
  const discovery = metadata.parseUpstreamDiscovery({
    object: "list",
    data: [{ id: UNKNOWN_ID }, null, { id: "chatgpt-web/high" }, { bad: true }],
    models: [
      null,
      { slug: UNKNOWN_ID, display_name: "Provider Model X", context_window: "invalid",
        base_instructions: "untrusted base", model_messages: { instructions_template: "untrusted messages" },
        include_skills_usage_instructions: true, include_plugin_usage_instructions: true,
        include_apps_usage_instructions: true },
      { slug: "other-good", display_name: "Other good row" },
    ],
  });
  assert.deepEqual(discovery.ids, [UNKNOWN_ID, "other-good"]);
  const resolved = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "upstream" }, discovery, "disabled");
  assert.equal(resolved.model.slug, UNKNOWN_ID);
  assert.equal(resolved.model.display_name, "Provider Model X");
  assert.equal(Object.hasOwn(resolved.model, "context_window"), false);
  assert.equal(resolved.model.visibility, "list");
  assert.equal(resolved.model.supported_in_api, true);
  assert.notEqual(resolved.model.model_messages?.instructions_template, "untrusted messages");
  assert.equal(Object.hasOwn(resolved.model, "base_instructions"), false);
  assert.equal(Object.hasOwn(resolved.model, "include_skills_usage_instructions"), false);
  assert.equal(Object.hasOwn(resolved.model, "include_plugin_usage_instructions"), false);
  assert.equal(Object.hasOwn(resolved.model, "include_apps_usage_instructions"), false);
  assert.equal(metadata.finalModelError(resolved.model), null);
});

test("nested unknown metadata keys are rejected by the shared schema boundary", () => {
  const discovery = metadata.parseUpstreamDiscovery({
    models: [{
      slug: UNKNOWN_ID,
      truncation_policy: { mode: "bytes", limit: 1234, unexpected: "must-not-pass" },
    }],
  });
  const upstream = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "upstream" }, discovery, "disabled");
  assert.deepEqual(upstream.model.truncation_policy, { mode: "bytes", limit: 10_000 });
  assert.throws(() => metadata.resolveModelMetadata(UNKNOWN_ID, {
    mode: "custom",
    baseMode: "fallback",
    overrides: { truncation_policy: { mode: "bytes", limit: 1234, unexpected: "must-not-pass" } },
  }, discovery, "disabled", { strictCustom: true }), /Invalid ModelInfo field: truncation_policy/);
  assert.match(metadata.finalModelError({
    ...upstream.model,
    truncation_policy: { mode: "bytes", limit: 1234, unexpected: "must-not-pass" },
  }), /additional properties/);
});

test("display_name must be non-empty for upstream, custom, and final ModelInfo validation", () => {
  const discovery = metadata.parseUpstreamDiscovery({ models: [{ slug: UNKNOWN_ID, display_name: "" }] });
  const upstream = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "upstream" }, discovery, "disabled");
  assert.equal(upstream.model.display_name, UNKNOWN_ID);
  assert.throws(() => metadata.resolveModelMetadata(UNKNOWN_ID, {
    mode: "custom", baseMode: "fallback", overrides: { display_name: "" },
  }, discovery, "disabled", { strictCustom: true }), /Invalid ModelInfo field: display_name/);
  assert.match(metadata.finalModelError({ ...upstream.model, display_name: "" }), /fewer than 1 characters/);
  assert.equal(metadata.customMetadataSchema().properties.display_name.minLength, 1);
});

test("a complete bundled ModelInfo sent by upstream normalizes to the same trusted exact-slug result", () => {
  const bundled = bundledArtifact.models.find(model => model.slug === BUNDLED_ID);
  assert.ok(bundled);
  const discovery = metadata.parseUpstreamDiscovery({ models: [bundled] });
  const upstream = metadata.resolveModelMetadata(BUNDLED_ID, { mode: "upstream" }, discovery, "unified_exec");
  const defaults = metadata.resolveModelMetadata(BUNDLED_ID, { mode: "default" }, discovery, "unified_exec");
  assert.deepEqual(upstream.model, defaults.model);
});

test("generic fallback is conservative and changes shell_type only from the project runtime mode", () => {
  const disabled = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "fallback" }, emptyDiscovery(), "disabled").model;
  const full = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "fallback" }, emptyDiscovery(), "unified_exec").model;
  assert.equal(disabled.shell_type, "disabled");
  assert.equal(full.shell_type, "unified_exec");
  for (const model of [disabled, full]) {
    assert.equal(Object.hasOwn(model, "context_window"), false);
    assert.deepEqual(model.supported_reasoning_levels, []);
    assert.deepEqual(model.experimental_supported_tools, []);
    assert.equal(model.priority, 99);
    assert.equal(model.support_verbosity, false);
    assert.deepEqual(model.truncation_policy, { mode: "bytes", limit: 10_000 });
    assert.equal(metadata.finalModelError(model), null);
  }
});

test("custom metadata uses a shallow field overlay, permits schema nulls, and rejects unknown, invalid, protected, or invariant fields", () => {
  const discovery = emptyDiscovery();
  const configured = {
    mode: "custom",
    baseMode: "fallback",
    overrides: {
      display_name: "Custom name",
      context_window: null,
      experimental_supported_tools: ["custom_tool"],
      truncation_policy: { mode: "bytes", limit: 12345 },
    },
  };
  const resolved = metadata.resolveModelMetadata(UNKNOWN_ID, configured, discovery, "disabled", { strictCustom: true });
  assert.equal(resolved.model.display_name, "Custom name");
  assert.equal(resolved.model.context_window, null);
  assert.deepEqual(resolved.model.experimental_supported_tools, ["custom_tool"]);
  assert.deepEqual(resolved.model.truncation_policy, { mode: "bytes", limit: 12345 });
  assert.equal(resolved.effectiveMode, "custom");

  for (const overrides of [
    { unknown_field: true },
    { priority: "high" },
    { slug: "other" },
    { visibility: "hidden" },
    { supported_in_api: false },
    { model_messages: { instructions_template: "untrusted" } },
    { include_skills_usage_instructions: true },
    { include_plugin_usage_instructions: true },
    { include_apps_usage_instructions: true },
  ]) {
    assert.throws(() => metadata.resolveModelMetadata(UNKNOWN_ID, {
      mode: "custom", baseMode: "fallback", overrides,
    }, discovery, "disabled", { strictCustom: true }));
  }
});

test("configured metadata remains visible while unavailable sources degrade to a safe effective baseline", () => {
  const discovery = emptyDiscovery();
  const upstream = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "upstream" }, discovery, "disabled");
  assert.equal(upstream.configuredMode, "upstream");
  assert.equal(upstream.configuredSourceAvailable, false);
  assert.equal(upstream.effectiveMode, "fallback");
  assert.equal(upstream.degraded, true);

  const defaults = metadata.resolveModelMetadata(UNKNOWN_ID, { mode: "default" }, discovery, "disabled");
  assert.equal(defaults.configuredMode, "default");
  assert.equal(defaults.configuredSourceAvailable, false);
  assert.equal(defaults.effectiveMode, "fallback");
  assert.equal(defaults.degraded, true);

  for (const baseMode of ["upstream", "default"]) {
    const custom = metadata.resolveModelMetadata(UNKNOWN_ID, {
      mode: "custom", baseMode, overrides: { display_name: `Custom after ${baseMode}` },
    }, discovery, "disabled");
    assert.equal(custom.configuredMode, "custom");
    assert.equal(custom.configuredSourceAvailable, false);
    assert.equal(custom.effectiveMode, "custom");
    assert.equal(custom.effectiveBaseMode, "fallback");
    assert.equal(custom.degraded, true);
    assert.equal(custom.model.display_name, `Custom after ${baseMode}`);
  }
});

test("persisted-invalid custom metadata falls back at runtime without losing the structural configuration", () => {
  const configured = metadata.normalizeMetadataConfig({
    mode: "custom", baseMode: "fallback", overrides: { unknown_field: "persisted" },
  });
  assert.deepEqual(configured, {
    mode: "custom", baseMode: "fallback", overrides: { unknown_field: "persisted" },
  });
  const resolved = metadata.resolveModelMetadata(UNKNOWN_ID, configured, emptyDiscovery(), "disabled");
  assert.equal(resolved.customInvalid, true);
  assert.match(resolved.customError, /Unknown ModelInfo field/);
  assert.equal(resolved.degraded, true);
  assert.equal(resolved.effectiveMode, "fallback");
  assert.equal(resolved.model.display_name, UNKNOWN_ID);
});
