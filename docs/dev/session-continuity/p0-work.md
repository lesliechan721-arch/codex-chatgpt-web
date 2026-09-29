# P0 验证记录

初始验证日期：2026-09-26。最新修复及重验：2026-09-28。状态：P0 最小 DEV 实验通过。预算 17 项通过；Automatic 已完成响应、活动响应和 Zero Risk 活动响应三条路径均连续两次通过。运行修复、证据及验证边界见本文末尾“运行行为修复与重验”；此前失败记录保留，历史段落中的未通过状态不代表最新结果。

## 已确认的验证方案

用户通过 decision-grill 逐项选择并确认以下安排，随后明确要求“开始实施”：

- 采用最小 DEV 实验，复用真实 Launcher、Broker 和摘要控制；外层工具使用 DEV 模拟回执。完整产品集成留给 P1—P5。
- 用短窗口验证阈值前不压缩、阈值后压缩、历史替换、计数回落及后续执行。用真实 Codex 和本地受控 usage 单独检查 100 万 / 90 万配置，不生成百万 token 历史。
- 配置检查覆盖默认值、较高和较低的 window / compact 值，以及 `total` / `body_after_prefix`。记录实测行为，不改用户全局配置。
- Automatic 活动响应、Automatic 已完成响应、Zero Risk 活动响应三条路径，各在独立短会话中连续成功两次。Zero Risk 普通轮次由用户按现有流程人工提交；另测已结束或控制送达前结束的停止边界。
- 同页闭环必须取得物理页面标识、结构化摘要回执、旧权限撤销及新权限工具回执。换页、旧权限仍有效或违规自动提交均不能通过。
- 区分实验代码问题、环境故障和平台 / 版本限制。缺少必要证据时保持未完成；平台 / 版本限制需要重开对应决定。
- 百万历史的性能、内存、上游承载能力、24 小时保留和完整产品集成不在本次 P0 结论内。

## 本地预算实验

入口：`bun run scripts/probe-session-continuity-budget.ts`。

脚本使用本机目标 Codex，创建独立临时配置和测试模型目录，在随机 loopback 端口运行可控 Responses 服务。每个配置组合启动独立 app-server，启用严格配置解析。请求保持短文本，仅响应 usage 为受控数值。原始证据默认写入忽略提交的 `output/session-continuity-p0/budget.json`；临时配置、rollout 和 stderr 保存在报告记录的 `/tmp/continuity-budget-*` 下。

可使用 `--codex=/absolute/path` 选择目标二进制，`--case=substring` 定向复跑，`--output=/absolute/path` 保留另一份报告。报告包含二进制路径、版本、SHA-256、配置、实际请求顺序、输入字节数和原生 token 事件。触发点报告为受控 usage 区间，不把范围检查写成逐 token 精确测量。

结果：本机 `codex-cli 0.157.0` 的 17 个组合全部通过，严格配置解析接受两种计数范围。二进制 SHA-256：`ad0be20d04e2ba6146ecdb51d7f8b7b0fe15420a15dc9b0057518d858f1f3714`。最大请求体 47,107 字节。

| 配置 | 已确认行为 |
| --- | --- |
| 短窗口 20,000 / 阈值 12,000 | 两种 scope 均自动压缩，摘要进入后续历史，重新计数后正常继续 |
| 目标 1,000,000 / 900,000；scope 省略、total、body_after_prefix | 原生有效窗口均为 900,000；受控 usage 898,000 后未压缩，901,000 后压缩 |
| window 降到 100,000 | 有效窗口 90,000；88,000 后未压缩，91,000 后压缩 |
| compact 降到 25,000；单独设置及与低 window 组合 | total 为 23,000 未压缩 / 26,000 后压缩；body_after_prefix 为 28,000 未压缩 / 31,000 后压缩，体现首轮约 5,000 的 prefix 基线 |
| window 或 compact 提高到 2,000,000，以及两者同时提高 | 两种 scope 均仍受有效窗口 900,000 限制，未扩大为无界历史 |

这里的 100 万是目录原始窗口。`effective_context_window_percent = 90` 使原生 `modelContextWindow` 为 90 万。目标 total 用例在压缩响应后、下一次模拟工作响应前，将当前历史重新估算为 4,608 tokens；后续工作 usage 为 5,000，没有再次压缩。原生累计 `total` 继续增加，不能把累计用量误当成当前执行历史占用。

现有本地压缩 smoke 提供真实 app-server 和 rollout 的调用范例；计数范围与配置覆盖语义也通过 [官方 context window 实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/context_window.rs) 和 [官方 model info 实现](https://github.com/openai/codex/blob/main/codex-rs/models-manager/src/model_info.rs) 核对。上表结论来自实际目标二进制，不能用当前主线源码代替版本证据。

## 真实平台实验

隔离 DEV Launcher 的只读状态报告为 `development`、`dev-harness`、Full/MCP ready。Automatic 实验时 Bigger Context 和每轮新会话均关闭；随后用户配置独立 Zero Risk 连接并切换为 manual，保留 Sent 确认。

实验入口：

- `bun run scripts/probe-session-continuity-live.ts --path=automatic-completed`
- `bun run scripts/probe-session-continuity-live.ts --path=automatic-active`
- `bun run scripts/probe-session-continuity-zero-risk.ts`

Automatic 脚本使用原 BrowserWorker、prompt compiler、Broker 和结构化摘要控制，给摘要轮显式设置 `retainConversation`。工具结果保留原有的浏览器观察屏障、Native 等待状态和完成屏障。后续两次提交均要求 retained lease；逐次核对同一 surface ID 和 CDP target ID。只输出 capability 指纹，不在证据中保存 token。每次运行默认为两次独立实验，第一次失败立即停止；报告和诊断写入 `output/session-continuity-p0/<运行标识>/`。

Zero Risk 脚本要求 DEV 已配置 manual 模式和独立连接器；每次实验需要人工提交两轮，共四次。使用原 `settleActiveZeroRiskCompactionSource`，按 manual lease 的 tab ID 检查复用，不读取 DOM 或连接 CDP。第二轮在工具结果交付后请求压缩，验证无后续控制交付时不产生新摘要；随后验证已完成响应的停止分支。这是 P0 的有界编排，不表示现有产品 Adapter 已停止 fresh fallback，也不提供 P2 才实施的 manual 原子严格续接保证。

### Automatic：普通响应归属阻塞

Automatic 已完成响应路径在第一个普通工具轮次失败，尚未进入摘要阶段。错误：`ChatGPT opened another user turn while the bound assistant response was detached`。真实 MCP 工具调用和 DEV 模拟回执已经发生；页面观察器随后拒绝继续。

实验脚本最初漏掉工具边界观察屏障，补齐后仍复现。使用未改动的正式 DEV driver 做对照：

```bash
bun run dev:chat p0-observer-baseline-20260926 --model gpt-5.6-sol-instant \
  'Call exec_command exactly once with cmd "printf P0_BASELINE". Describe the simulated receipt in one short sentence, then finish.'
```

该普通轮次也在相同位置失败，返回 `chatgpt_submitted_turn_failed`。因此已确认这是 P0 之前的普通 Automatic 观察路径阻塞，尚不能据此判定平台不支持同页摘要。失败发生在 `browser-worker.ts` 的 `reconcileAssistantTurnBinding`：原绑定节点消失后，当前 user identity 不在接受时的 identity 集合中。诊断显示接受时与失败时的挂载状态不同；现有证据不足以判定是身份变化、旧节点残留或真正的新轮次。

原始证据：`output/session-continuity-p0/automatic-completed-1790392376867/`、`automatic-completed-barrier.log`、`observer-baseline.log`；对照诊断在 DEV home 的 `runtime/dev-chat/diagnostics/browser-turns/38144bef0e4b-efd914ff/`。第一次脚本的非法 conversation key 已在网页创建前拒绝并修正，不计为平台失败。

Automatic 活动响应路径未继续运行：它依赖的首个普通工具轮次已在对照中失败。两条 Automatic 路径均没有连续两次通过的证据。

### Zero Risk：最新重试连续两次通过，保留此前导航失败记录

用户完成独立连接配置后，实际运行报告位于 `output/session-continuity-p0/zero-risk-active-1790393367422/evidence.json`；同目录 `launcher-events.json` 保存相关 Launcher 事件，完整实验日志为 `zero-risk-retry.log`。

第一次独立实验通过：

- 原页经绑定的 Zero Risk completion 返回 691 字符 checkpoint，记录摘要指纹；普通工具仅返回模拟回执。
- 前后两轮均为 tab `ClaL7Myuvfjp2lVN`，下一轮 lease 明确 `reused: true`，新 capability 完成工具调用，两轮旧 capability 均以 `codex_tool_operation_retired` 拒绝。
- 第二轮工具回执已交付、压缩控制尚未送达时，响应正常结束，原 handoff helper 返回 `undefined`；对已结束 source 再调用则拒绝。本实验编排据此停止，无第三次 Launcher start。这验证 helper 的停止条件，不表示产品 Adapter 已实现 `continuity_manual_handoff_required` 或取消 fresh fallback。

第二次独立实验失败，时间均为 UTC：

| 时间 | 实际事件 |
| --- | --- |
| 03:30:28.218 | 用户确认 Sent |
| 03:30:28.358 | 原 tab `sXBWM4kB4ZZ2I01B` 记录 `browser.manual_conversation_invalidated` |
| 03:30:47.431 | 摘要轮结束，Launcher 报告 `retained: false`；绑定 completion 已返回 604 字符 checkpoint |
| 03:30:47.457 | 下一轮 lease 为新 tab `AgENZxf7jh3NznxW`，`reused: false`；脚本断言失败，在下一轮人工提交前停止 |

用户明确确认当时没有刷新或切换对话，仅发送并点击 Sent。源码 `launcher/electron/browser-host.cjs` 的 `bindManualTurnContents` 在 Sent 之后遇到不被豁免的导航时清除 `conversationKey`，随后 `endManualTurn` 无法保留页面。这与事件顺序一致。日志未保存导航目标及同文档标志，因此不能确认具体 URL 变化，也不能据此放宽归属检查。

当前 manual start 缺少原子严格续接条件；失去保留资格后，实际已创建新页并写入剪贴板，脚本只能在收到 lease 后拒绝。该失败也说明 P2 的 manual 严格续接检查必须发生在这些副作用之前。此新页未用于发送下一轮工作。

更早的 `zero-risk-active-1790393189775/` 在取得 checkpoint 后，因脚本按英文错误文本断言而停止。实际旧凭证已被拒绝；断言现已改为核对稳定错误代码。该次不计为平台失败，也不计入成功次数。最新脚本将 lease 记录移到断言之前，以便后续失败直接保留新旧页面证据；此次缺失的失败 lease 由 Launcher 原始事件补足。

随后用户明确要求“重试一下 ZERO 模式”。保持产品代码及验证条件不变，完整重跑两次独立实验，均通过。证据位于 `output/session-continuity-p0/zero-risk-active-1790393638702/evidence.json` 和同目录 `launcher-events.json`，日志为 `zero-risk-retry2.log`：

| 独立实验 | 摘要前后 tab | checkpoint 长度 | 结果 |
| --- | --- | --- | --- |
| 1 | `BsJYgZyPoR2oO7Tf` | 1,231 字符 | 同页新 capability 工具调用、旧权限拒绝、两项停止边界均通过 |
| 2 | `inSAP93OSNxiCKO1` | 785 字符 | 同页新 capability 工具调用、旧权限拒绝、两项停止边界均通过 |

四轮 Launcher completion 均为 `retained: true`，本次没有会话归属失效事件。两次实验结束后均释放自身页面并关闭实验 Broker。成功重试提供了连续两次闭环证据，但不解释或修复此前正常发送流程中的导航失效。

### 结论与重新验证条件

| 验证项 | 结论 |
| --- | --- |
| 目标 Codex 预算 / 覆盖配置 / 压缩后计数 | 17 / 17 通过 |
| Automatic 已完成、活动响应同页闭环 | 普通响应观察路径阻塞，未取得通过证据 |
| Zero Risk 活动响应同页闭环 | 最新重试连续 2 次通过；此前 1 次成功、1 次导航失败仍保留 |
| Zero Risk 控制送达前结束、已结束响应 | 最新重试两次均验证 helper 停止分支；完整产品行为仍留给后续实施 |

P0 未通过，不能开放连续性别名。下一步应查明 Automatic 绑定节点变化并取得两条 Automatic 路径各连续两次成功的证据。Zero Risk 已取得所需成功次数，但此前正常发送时的导航归属失效仍须查明；成功重试不能替代该问题关闭。任何相关修复均须保持归属检查，并重跑受影响路径。当前结果不证明上游不支持同页摘要，也不授权自动接管导航后的页面。

## 本地检查

- `bun run typecheck`：通过。
- `bun test tests/retained-compaction.test.ts tests/zero-risk-adapter.test.ts`：60 pass，0 fail，404 次断言。这是既有接口合同检查，不是 P0 平台通过证据。
- Launcher 的 3 项 manual 导航合同定向测试：3 pass，0 fail，确认现有实现会撤销发送后导航页面的保留资格；日志为 `output/session-continuity-p0/manual-navigation-contracts.log`。
- 本轮仅增加 P0 实验脚本和文档；未开放连续性别名，未改产品运行逻辑。

## 2026-09-28：失败原因排查补充

本次核对既有原始证据、运行代码和本地测试，没有重新发起真实平台轮次。P0 仍未通过。已确认两条失败的代码触发条件；Automatic 的具体身份变化和 Zero Risk 的历史导航目标仍缺少证据，不能标记为根因已关闭。

### Automatic：绑定期间出现未接受的 user identity

补齐工具观察屏障后的 `automatic-completed-1790392523935` 提供以下结构快照；时间均为 2026-09-26 UTC：

| 采集点 | user 节点数 | assistant 节点数 | assistant 文本长度 | 完成控件数 |
| --- | --- | --- | --- | --- |
| `19-send-accepted`，03:15:42.055 | 0 | 1 | 55 | 0 |
| `20-response-visible`，03:15:42.091 | 0 | 1 | 55 | 0 |
| `21-turn-failed`，03:15:47.494 | 1 | 1 | 5,960 | 5 |

普通 DEV baseline 也出现相同的节点计数变化及错误。失败位于普通 Automatic 观察路径，尚未进入摘要流程。

[`waitForNewAssistantTurn`](../../../src/adapters/chatgpt-web/browser-worker.ts) 取得新增 assistant identity 时，将当次 `state.turnIdentities` 保存为 `acceptedTurnIdentities`。`reconcileAssistantTurnBinding` 只有在原 locator 已找不到节点时才检查当前 user identities；只要其中一个不在接受集合中，就在尝试 assistant 重绑之前抛出该错误。

因此，直接失败条件是“原 assistant 定位失效，同时出现未接受的 user identity”。但不能仅凭 user 节点从 0 变为 1，就断定晚挂载导致误报：`submissionDomState` 会为每个已有 `data-turn-key` 同时保存 `group:user:<key>` 和 `group:assistant:<key>`。同一个 group 内晚挂载 user 内容，本身不会触发该检查。新 group key、legacy identity 变化或实际新轮次仍需区分。

现有诊断只保存节点数、文本长度和控件数，没有保存绑定 identity、接受集合或身份变化顺序。因此，当前不能证明具体是哪一种 DOM 身份变化，也不能把错误文案当作用户确实发送了第二轮的证据。

### Zero Risk：Sent 改变首次导航的豁免条件

[`bindManualTurnContents`](../../../launcher/electron/browser-host.cjs) 对首次页面在 `awaiting-user` 状态下的导航放行。`confirmManualSent` 将状态改为 `sent`，该豁免立即结束。此后，同文档导航也只有在去掉 `#` 后 URL 不变时才放行；路径或查询参数变化会清除 `conversationKey`。

本次使用原 `BrowserHost` 方法和本地事件重放，对同一个受控的页内地址转换进行对照：从 `https://chatgpt.com/?temporary-chat=true` 到 `https://chatgpt.com/c/fixture`，均发送 `did-start-navigation(inPlace=true)` 和 `did-navigate-in-page`，不启动浏览器：

| 事件顺序 | 会话标识是否保留 |
| --- | --- |
| 地址转换 → Sent | 保留 |
| Sent → 相同地址转换 | 清除，并记录 `manual_conversation_invalidated` |
| Sent → 仅改变 URL fragment | 保留 |

这证明现有实现受 Sent 与导航事件的先后顺序影响。Electron 的同文档导航包括 `pushState` / `replaceState`，无需刷新页面，见 [官方事件定义](https://github.com/electron/electron/blob/main/docs/api/web-contents.md#event-did-start-navigation)。上述 URL 是受控复现输入，不是历史实验中已查实的 URL。

失败实验在 Sent 后 140 毫秒记录失效，随后才在 03:30:37.757 记录 `manual-started`，与该时序风险相符。首次页面失去 key 后不会立即终止当前轮，所以仍能返回 checkpoint；`endManualTurn` 随后因 key 缺失而不能保留页面。下一轮 manual start 创建新页，最终由 P0 的同页断言拦下。

旧日志只记录失效时的 tab ID 和 trace ID，没有导航事件名、目标 URL 或同文档标志。因此，“首次发送后的正常地址更新晚于 Sent 到达”是已可本地复现的候选原因，尚不能认定为那次历史失败的确定根因。成功重试也不能关闭该缺口。

### 本次验证与后续定位要求

- 复跑 `tests/retained-compaction.test.ts` 和 `tests/zero-risk-adapter.test.ts`：60 pass，0 fail，404 次断言。
- 复跑 `tests/browser-worker-contract.test.ts` 和 `tests/browser-response-dom.test.ts`：139 pass，0 fail，831 次断言。
- Launcher 三项 manual 导航合同测试通过；上述本地事件重放确认 Sent 前后的行为差异。这些检查不能替代真实平台验收。
- Automatic 下次复现需要记录绑定 identity、接受集合及当前身份的脱敏指纹，区分 legacy / group，并记录重绑前后的变化。
- Zero Risk 下次复现需要记录导航事件名、同文档与主框架标志、导航前后的脱敏地址类别及 manual 状态。取得归属证据后再修正具体状态转换，不能直接跳过归属检查或允许任意导航后续接。

预算原始报告的 17 个组合均含一次压缩、后续 checkpoint 和独立历史重计数证据；本次没有发现预算实验导致上述两类失败的证据。未修改产品代码，也未开放连续性别名。

## 2026-09-28：定向诊断与真实重跑

用户要求按上述建议继续，并确认可配合 Zero Risk 人工发送。本次增加诊断并重跑真实 DEV 路径，保留原有归属检查、停止条件和 P0 同页断言。未实施连续性产品功能，也未修复本节列出的失败。

### 诊断修改

- Automatic 在现有诊断文件中保存初次绑定、节点脱离、重绑及找不到新响应时的身份集合。只保存 SHA-256 指纹及 legacy / group 角色；group 另存共享 key 指纹，以核对两个角色是否属于同组。每个集合最多保留最近 64 项及总数，每条 trace 保留初次观察和最近 15 次观察。
- Zero Risk 在 Launcher 日志中记录导航事件名、同文档和主框架标志、前后地址类别及指纹、manual 状态、是否复用、保留资格及距 Sent 的毫秒数。保留及失效分支都有记录；不保存完整 URL，不读取 Zero Risk DOM，也不连接其 CDP。
- Automatic 实验脚本补记“普通回答结束但无结构化交接”时的有界回答，替换本实验的普通 token、控制 token 和 handoff ID。该项仅用于受控 P0 回答；产品诊断不新增对话正文。

### Zero Risk：真实复现正常发送时的地址切换

本次运行：`output/session-continuity-p0/zero-risk-active-1790561288012/`。同目录保存 `evidence.json` 和 `launcher-events.json`；完整实验日志为 `zero-risk-diagnostic-20260928.log`。以下时间均为 2026-09-28 UTC：

| 时间 | 事件 |
| --- | --- |
| 02:08:19.341 | 首次页面从临时聊天入口页变为会话 A；同文档导航，状态仍是 `awaiting-user`，按初始导航豁免放行 |
| 02:08:19.927 | 用户点击 Sent，状态改为 `sent` |
| 02:08:20.433 | 主框架再次发生 `did-start-navigation`，`sameDocument: true`；从会话 A 变为会话 B，两个 conversation 指纹不同；距 Sent 506 毫秒，触发 `invalidate` |
| 02:08:24.579 | connector 已开始工作，脚本记录 `manual-started` |
| 02:08:37.200 | 摘要轮结束，Launcher 记录 `retained: false` |
| 02:08:37.218 | 脚本取得 1,207 字符 checkpoint；旧 capability 已被拒绝 |
| 02:08:37.243 | 下一轮取得不同 tab，`reused: false`；同页断言失败，在人工发送下一轮前停止 |

用户随后明确确认：“没有，只按测试流程操作”，没有刷新或切换对话。

本次已确认：正常首次发送期间，页面可以先进入一个会话地址，再以同文档导航变为另一个会话地址。现有代码把 Sent 作为首次导航豁免的结束点，因此地址转换晚于 Sent 时，会撤销本轮保留资格。这是实际复现的时序缺陷，不再只是本地事件重放的候选原因。当前证据不能解释平台为何两次分配会话地址，也不能恢复 9 月 26 日那次未记录的 URL。

后续修复应区分首次会话建立与已保留会话续接，并取得首次地址稳定及当前 capability 的归属证据。不能仅因 `sameDocument: true` 就允许所有地址变化，也不能放宽已复用页面的导航检查。

### Automatic：普通轮次通过，摘要交接仍阻塞

| 本次运行目录 | 实际结果 |
| --- | --- |
| `automatic-completed-1790561381632` | 普通工具轮次通过；摘要轮复用同一 surface / target，但返回 129 字符普通回答，没有结构化 handoff |
| `automatic-active-1790561524127` | 普通工具结果交付、后续调用接收压缩控制、旧 capability 拒绝均通过；摘要轮复用原页，但 60 秒内未找到新的 assistant identity |
| `automatic-completed-1790561728451` | 一次有界定向复现；普通轮次通过；摘要轮再次因找不到新的 assistant identity 失败 |

目录均位于 `output/session-continuity-p0/`，各自保存 `evidence.json`、诊断目录和对应 `launcher-events.json`。日志分别为 `automatic-diagnostic-20260928.log`、`automatic-active-diagnostic-20260928.log`、`automatic-retry-diagnostic-20260928.log`。

最后一次失败的 `bindingObservations` 明确记录：提交前有一个 group；失败时有两个 group，其中新的 group 已有 user 角色，但唯一可见 assistant 仍属于提交前的 group。因此观察器没有取得可归属到本次摘要请求的新 assistant。该证据说明失败条件，尚不能区分网页未产生新响应与当前选择器未识别实际新响应。第一次无 handoff 的 129 字符回答没有保存正文，不能据其长度推定模型拒绝或工具不可用。

三次普通轮次均未重现 9 月 26 日的 `bound assistant response was detached` 错误。新增诊断已生效，但本轮没有取得该错误发生时的身份变化，不能将其标记为已修复。两条 Automatic 路径都没有完成“摘要后原页新 capability 调用工具”，仍不满足连续两次成功的条件。

曾尝试用 `agent-browser 0.38.1` 只读连接本实验的 Automatic target。工具返回 `Target.createTarget: Not supported`，没有取得页面观察结果，随后关闭该检查会话；不把此工具连接失败计为 P0 平台失败。本节结论来自实际实验脚本和诊断文件。

### 本轮验证与剩余工作

- `bun run typecheck` 通过。
- 浏览器合同及响应 DOM 测试：141 pass，0 fail。
- Launcher `browser-host` 全文件测试：112 pass，0 fail；包括 Sent 前后相同导航事件的保留差异和日志脱敏检查。
- 所有实验脚本均已结束并清理自身页面、权限与 Broker。DEV Launcher 保留运行，用户已将其切换为 Automatic。
- Zero Risk 下一步是基于本次事件序列修正首次会话建立的归属边界，再重跑同页闭环。
- Automatic 仍需定位摘要阶段的新响应归属及结构化回执问题，同时保留旧绑定错误的定向诊断。新失败不能替代旧问题关闭，也不能据此判定平台不支持同页摘要。

本次最终诊断源码指纹和检查工具限制记录在 `output/session-continuity-p0/diagnostic-20260928.json`。本轮只完成诊断和复现；P0 继续保持未通过。

## 2026-09-28：运行行为修复与重验

用户明确要求“修复运行行为”后，本轮修改了产品代码，保留前述归属、同页和结构化回执要求。

### 修复内容及依据

1. **Zero Risk 首次会话建立**：首次完整上下文提交后，`sent` 到 MCP `running` 之间，允许同文档的 ChatGPT 首页 / 会话路径转入会话路径，包括已实测的临时会话 ID 替换。Sent 只表示用户确认发送，不作为页面身份已稳定的证据。跨文档刷新、外部地址、返回首页、MCP 开始后的会话变化，以及所有复用轮次的会话变化仍撤销保留资格。没有增加 Zero Risk DOM 读取或自动提交。
2. **Automatic 响应重绑**：实时页面使用 `fallback-turn-0` 等临时 group key，并在 assistant 内容单元上提供 `data-chatgpt-search-message-ids`。现在只在新旧 group 具有相同 assistant message ID 时，允许对应的 user group key 随之变化；无消息 ID、消息不匹配或存在额外 user identity 时仍拒绝。受控回归覆盖这些分支。9 月 26 日的原始失败未保存 message ID，无法事后证明其具体替换关系；本轮普通实测未再出现原错误。
3. **Automatic 每条消息的连接器选择**：retained lease 证明的是物理页面和连接器绑定，不能证明下一条消息的 composer 仍选中了该 app。现在检查 composer；缺失时在原页重新选择当前 app，然后插入请求。选择失败时不发送。既有选择保持复用。
4. **结构化摘要发送契约**：明确摘要请求必须执行 checkpoint 存储，普通任务的最终回答格式不适用于此次控制提交；使用当前配置的 app，禁止换到其它 Codex 连接器，且不在摘要正文中复制控制凭证。仍要求 Broker 接收一次性 handoff，普通文字回答不能通过。

### Automatic 平台目录问题

只读检查实验页面后，确认此前“missing assistant”失败页只有新 user 和已结束的思考状态，没有可提取的 assistant 答案。补选连接器后曾得到普通 checkpoint 文本，或收到控制 token 无效的工具错误。同期 DEV MCP 日志只有普通 `codex_exec`，没有收到摘要 `codex_tool_call`。这些失败不能判为 DEV Broker 消费了正确 token，也不能判为选择器漏读了已存在的答案。

显式指定 `Codex Native3 DEV` 的对照返回“该连接器没有所需 control action”。用户随后刷新连接器；本轮进入正确 DEV app 设置，再次点击“刷新工具”，`/backend-api/aip/connectors/mcp/refresh_actions` 返回 200，7 项 action 包括启用的 `codex_tool_call`，其 schema 保留无 `operation_id` 的 compaction 分支。设置页面没有直接显示工具列表。

刷新后 `automatic-completed-1790564171473` 首次完整通过，DEV MCP 日志首次记录对应 `codex_tool_call` 成功，Broker 接收结构化 checkpoint。该结果支持工具目录 / 路由问题参与了此前阻塞；没有保留刷新前完整 action 列表，因此不将具体缓存层或缺失原因写成已证实事实。

诊断期间本地独立 MCP 客户端也成功完成一次控制调用，并拒绝重放，见 `output/session-continuity-p0/local-handoff-check.log`。平台调用成功与此本地检查分别记录，不能互相替代。

### 修复后验证

- `bun run typecheck` 通过。
- BrowserWorker、响应 DOM、retained compaction、Zero Risk adapter：203 pass，0 fail，1,256 次断言。
- Launcher `browser-host`：113 pass，0 fail。新增首次会话创建、Sent 后临时 ID 替换及 MCP 开始后的拒绝回归，并覆盖复用轮次的页内换会话和刷新。
- Native MCP 公开合同定向检查：2 pass，0 fail，39 次断言。
- Automatic 已完成响应：`automatic-completed-1790564271799` 连续两次通过，checkpoint 分别为 1,116 / 1,264 字符。
- Automatic 活动响应：`automatic-active-1790564418056` 连续两次通过。每次均确认后续未执行工具收到压缩控制，随后提交结构化摘要、撤销旧权限，并在同一 surface / target 用新权限调用工具。
- 上述 Automatic 每次都验证一次性摘要重放被拒绝；原始证据、诊断与 `launcher-events.json` 位于各运行目录，最终源码指纹记录在 `output/session-continuity-p0/runtime-fix-20260928.json`。两条路径的日志分别为 `runtime-automatic-completed-final.log` 和 `runtime-automatic-active-final.log`。
- DEV Launcher 重启加载修复后，Zero Risk 在 `zero-risk-active-1790564689800` 连续两次通过，checkpoint 分别为 707 / 744 字符。两次实验各自在同一 tab 完成前后两轮，后续 lease 均为 `reused: true`；新权限完成工具调用，旧权限被拒绝，控制送达前结束及已结束响应两项停止边界均通过。四次人工提交均由用户完成。
- Zero Risk 四轮 Launcher completion 均为 `retained: true`，没有会话归属失效事件。证据和 `launcher-events.json` 位于上述运行目录，完整日志为 `runtime-zero-risk-final.log`。本次两次首次地址替换都发生在 Sent 之前，未再次触发此前的 Sent 后竞态；该事件顺序由前述回归测试覆盖，不能将此次实测写成对该竞态的再次复现。

### 当前结论与范围

P0 约定的最小 DEV 实验已取得全部通过证据：预算 17 / 17，三条真实平台路径各连续 2 次成功。真实 Launcher、Broker 和摘要控制完成了同页闭环；外层工作工具仍使用约定的模拟回执。

Zero Risk 的首次导航时序缺陷已有实际失败证据和对应回归修复。Automatic 补齐了有消息身份依据的重绑、每条消息的连接器选择及摘要提交指令，并在刷新 DEV 工具目录后通过真实闭环；9 月 26 日旧绑定失败的具体 DOM 替换关系仍无法从历史日志恢复，不能声称已追溯其唯一根因。

完整连续性产品集成、manual 原子严格续接、百万历史性能和 24 小时保留仍属于后续工作。本次未开放连续性别名。实验已清理自身页面、权限和 Broker；DEV Launcher 保留运行，当前为 Zero Risk 模式。
