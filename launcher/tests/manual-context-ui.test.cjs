const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "../src/App.tsx"), "utf8");
const copy = {
  complete: "完成", failed: "失败", manualPromptCancel: "取消任务", manualPromptCancelConfirm: "再次点击取消",
  manualPromptCopied: "已复制", manualPromptCopy: "复制提示", manualPromptInstruction: "发送后确认",
  manualPromptInstructionAutomaticConfirmation: "发送后由连接器开始", manualPromptRunning: "正在运行",
  manualPromptSeconds: "秒剩余", manualPromptSent: "已发送", manualPromptTitle: "发送本轮", manualPromptWaiting: "等待连接器",
  manualAttachmentsTitle: "本轮必需图片：{count} 张", manualAttachmentsInstruction: "此确认记录你的声明。Launcher 不检查附件。",
  manualAttachmentsConfirm: "已附加本轮清单中的全部图片", manualAttachmentsAttested: "你已确认全部图片。",
};
const visit = tree => Array.isArray(tree) ? tree.flatMap(visit) : tree && typeof tree === "object"
  ? [tree, ...visit(tree.children ?? [])] : [];
const strings = tree => Array.isArray(tree) ? tree.flatMap(strings) : typeof tree === "string" ? [tree]
  : tree && typeof tree === "object" ? strings(tree.children ?? []) : [];

function component(start, end, additions = {}) {
  const compiled = ts.transpileModule(source.slice(source.indexOf(start), source.indexOf(end)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: "element" },
  }).outputText;
  const sandbox = { element: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    PrimaryButton: "PrimaryButton", SecondaryButton: "SecondaryButton", useEffect() {},
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], ...additions };
  vm.runInNewContext(`${compiled}\nrender = ${start.match(/function (\w+)/)[1]};`, sandbox);
  return sandbox.render;
}

test("required fallback images have an independent explicit confirmation in both Sent policies", () => {
  const render = component("function ManualTurnGuide(", "function SetupSurface(");
  for (const sent of [true, false]) {
    let attestations = 0;
    let sentConfirmations = 0;
    const tab = { id: "tab", manualState: "awaiting-user", manualSentConfirmationRequired: sent, canConfirmSent: true,
      manualAttachments: { required: [{ id: "image_1", label: "用户消息 3，图片 1" }, { id: "image_2", label: "技能截图，图片 2" }],
        requiredCount: 2, status: "pending", canConfirm: true, deadlineAt: new Date(Date.now() + 60_000).toISOString() } };
    const tree = render({ copy, tab, onCancel() {}, onCopy() {}, onSent() { sentConfirmations++; }, onAttachments() { attestations++; } });
    const text = strings(tree);
    assert.ok(text.includes("本轮必需图片：2 张"));
    assert.ok(text.includes("用户消息 3，图片 1"));
    assert.ok(text.includes(copy.manualAttachmentsInstruction));
    const buttons = visit(tree).filter(node => node.type === "PrimaryButton");
    const media = buttons.find(node => node.children[0] === copy.manualAttachmentsConfirm);
    assert.ok(media);
    assert.equal(media.props.disabled, false);
    media.props.onClick();
    assert.equal(attestations, 1);
    assert.equal(sentConfirmations, 0);
    assert.equal(buttons.some(node => node.children[0] === copy.manualPromptSent), sent);
  }
});

test("an all-MCP plan has no media step and a completed human statement is described as attestation", () => {
  const render = component("function ManualTurnGuide(", "function SetupSurface(");
  const base = { copy, onCancel() {}, onCopy() {}, onSent() {}, onAttachments() {} };
  const mcp = render({ ...base, tab: { manualState: "awaiting-user", manualSentConfirmationRequired: false,
    manualAttachments: { requiredCount: 0, required: [], status: "not-required" } } });
  assert.equal(strings(mcp).some(text => text.includes("本轮必需图片")), false);
  const attested = render({ ...base, tab: { manualState: "sent", manualSentConfirmationRequired: true,
    manualAttachments: { requiredCount: 1, required: [{ id: "image", label: "图片 1" }], status: "user_attested" } } });
  assert.ok(strings(attested).includes(copy.manualAttachmentsAttested));
  assert.equal(visit(attested).some(node => node.children[0] === copy.manualAttachmentsConfirm), false);
});

test("a running mixed turn keeps media confirmation visible and transmits the exact current surface binding", async () => {
  const calls = [];
  const render = component("function BrowserSurface(", "function ManualTurnGuide(", {
    api: { confirmManualAttachments: async (...args) => calls.push(args) },
    BrandMark: "BrandMark", Icon: "Icon", IconButton: "IconButton", ManualTurnGuide: "ManualTurnGuide", StateDot: "StateDot",
    browserTabTitleFromTitle: value => value, browserTabTone: () => "idle", formatBrowserAddress: value => value ?? "",
  });
  const tab = { id: "retained-tab", traceId: "request-surface", active: true, interactionMode: "manual", manualState: "running", status: "running",
    manualAttachments: { traceId: "request-surface", nonce: "surface-nonce", planId: "selected-plan", manifestDigest: "a".repeat(64),
      status: "pending", requiredCount: 1, required: [{ id: "image", label: "图片" }] } };
  const props = { browser: { tabs: [tab], zoomFactor: 1 }, browserSlotRef() {}, copy, interactionMode: "manual", platform: "darwin", setError() {} };
  const guide = visit(render(props)).find(node => node.type === "ManualTurnGuide");
  assert.ok(guide, "connector start must not hide pending media confirmation");
  guide.props.onAttachments();
  await Promise.resolve();
  assert.equal(calls[0][0], tab.id);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { traceId: tab.traceId, nonce: "surface-nonce", planId: "selected-plan", manifestDigest: "a".repeat(64) });
  const priorKey = guide.props.key;
  tab.manualAttachments.nonce = "new-surface-nonce";
  const refreshed = visit(render(props)).find(node => node.type === "ManualTurnGuide");
  assert.notEqual(refreshed.props.key, priorKey, "refresh remounts local confirmation state");
  guide.props.onAttachments();
  await Promise.resolve();
  assert.equal(calls.at(-1)[1].nonce, "surface-nonce", "a stale UI action cannot adopt the new surface nonce");
  refreshed.props.onAttachments();
  await Promise.resolve();
  assert.equal(calls.at(-1)[1].nonce, "new-surface-nonce");
});
