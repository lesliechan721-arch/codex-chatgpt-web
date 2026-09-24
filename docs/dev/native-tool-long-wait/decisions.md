# Codex Native 长等待：需求对齐记录

记录日期：2026-09-23。以下决定和证据按其原始时间保留。

**当前状态（2026-09-24）：用户已确认前期技术验证完成，并授权实施及连接器名称迁移。当前结果见 [实施记录](work.md)。** 下文“只更新文档”“不授权实现”和开放技术证据关口描述的是此前各轮范围；新的实施授权取代这些历史范围限制，但不等于本轮重新取得了真实长等待证据或独立审查结论。

当前规格入口：[Spec v0.7](spec.md)。本目录只包含本问题的需求与设计资料；本轮只更新文档，不授权产品实现、发布或 Git 提交。

## 目标、边界与共享方向

用户报告：调用 Codex 工具迟迟没有回复时，例如 `request_user_input` 等待用户输入，gpt-web 会话关闭，并出现 `stream disconnected before completion: ChatGPT stopped responding after the task started. Check the ChatGPT tab before continuing.`。

本轮用户请求：`$dev-workflow:dev-workflow 对齐需求制定一个修复上面问题的spec`。

后续用户请求：`$dev-workflow:dev-workflow 修复上面发现的spec问题`。该请求授权在现有目标、项目事实和独立审查关闭条件内修订规格；不等于批准候选产品设计、开始产品实现或创建 Git commit。

本轮用户请求：`$dev-workflow:dev-spec 修复上面发现的问题`。该轮按 v0.2 独立审查指出的两个 blocker 和一个 Major 形成 v0.3，不授权产品实现。

随后用户明确要求从“当前没有确定内容”开始使用逐轮决策访谈，并在访谈结束时确认最终决定记录准确。下列“已确认决定”以该确认结果为当前决策来源；v0.3 中与这些决定一致的内容由候选升级为规范约束。

2026-09-23，用户提供了对 v0.4 的独立复审结果：1 项跨规格 blocker（远程 600 秒 idle 与 11 分钟 Native 等待冲突）和 4 项重要协议缺口（`discovery_tools`、动态 registry 准入、compaction control 例外、fresh/fallback compaction retirement）。随后用户要求先决策再修复，并通过 `decision-grill` 明确确认两项材料取舍：

1. 远程部署中，已启动且持续持有 `120_000 ms` 合法等待租约的 Native operation 暂停 600 秒 idle 的**终止动作**；wait/retry 不算真实业务进展，也不刷新 remote idle 的 last-progress 时间。租约失效后按原 last-progress 时间恢复，若已越阈值则立即清理。
2. configured fresh compaction 或 delegated source identity mismatch 的 fresh fallback 既然按现有合同退役旧 browser/tool owner，就同步退役属于该旧 owner 的 operation；fresh owner 不接管，也不自动重执行。

v0.5 当时的同一确认还授权按当前基线合同补齐 R2—R4，而不重新发明行为：inventory 保留 `discovery_tools`；当时的 prepared ticket 不冻结动态 registry 权限、已准入 operation 不重复准入；`codex.control.compaction_handoff` 保持控制专用隔离，不要求普通 operation identity。随后 v0.6 删除 prepared 阶段，但保留“首次真正到达 Broker 时按当前 registry 准入、已准入 operation 不重复准入”的合同。本轮授权范围是修订 `spec.md`、本决定记录及必要的交叉规格文字，不授权产品代码实现。

随后用户进一步简化稳定 identity 方案并明确确认：不再增加 `codex_tool_begin`。每个新的 Native-capable 逻辑调用在第一次原工具调用发出前，直接在当前 Broker capability 内分配一个递增的数字 `operation_id`；ID 只用于同一 capability 内的去重和结果续接，不要求跨 capability 全局唯一。新的 capability 可以重新从 `1` 开始；同一 capability 内 reconnect 不得重置分配状态。同一逻辑调用的 retry / wait 必须复用原 ID，新的逻辑调用必须使用新 ID。该决定取代此前“每次 Native 逻辑调用先 begin 再启动”的已确认方案，并形成 Spec v0.6。

2026-09-23 的 v0.6 独立复审随后发现两项协议缺口。用户要求先通过 `decision-grill` 决定修复方法，再执行文档修复，并最终确认以下记录：

1. retained compaction 在 Broker handoff 前接管 queued operation 时，把现有压缩控制结果缓存为该 operation 的桥接控制终态；后续 wait / 同描述 retry 重放该结果，不再执行 Native，也不把该控制结果送入原入口的 Native finalizer。控制结果交付后，该 operation 不再阻止完成。
2. 确定性准入拒绝也占用第一次到达 Broker 的 `operation_id` 并绑定首次规范化启动请求描述；同描述 retry 稳定重放原拒绝，不同描述必须 conflict。修正后的新逻辑尝试使用新 ID，不能复用已被拒绝占用的 ID。

这两项决定不恢复 `codex_tool_begin` / prepared 阶段，也不增加短调用的额外 MCP 启动次数；形成当前 Spec v0.7。

共享方向是：修复正常 Native 长等待被桥接层误终止，同时保持原生请求、用户输入、审批和副作用语义。桥接层一次等待结束不代表 Native 已失败或完成；不能通过重复执行、自动回答、自动批准或取消全部保护来维持表面的成功。

## 已确认决定

### P1：核心目标与修复范围

核心目标是修复正常 Codex Native 长等待被桥接层误判为失败或结束的问题。统一覆盖工具能力开启时的 Automatic 和 Zero Risk，处理所有经该桥接层调用的 Native 长等待，而不只对 `request_user_input` 加白名单。包括人工输入、原生审批、长执行、`write_stdin` 等待及 gateway 调用。Browser-only 和 ChatGPT 自有工具不在范围内。

该统一范围已经确认；原始报告中的 `request_user_input` 是代表场景，不是唯一修复对象。

### P2：等待与结束策略

在原生工具仍未结束、任务绑定有效且等待通道持续有可验证活动时，桥接层不设置人工等待或原生执行的总时长上限。单次等待到期返回 pending；真实工具结果、原生期限、用户取消、页面/任务真实终止和所有者失效分别处理。

首次原工具调用和每次结果查询的语义等待预算固定为 `30_000 ms`。等待 operation 的失联租约固定为 `120_000 ms`，有效启动重试或查询续租。30 秒影响查询频率、工具调用量、上下文消耗和结果反馈延迟；120 秒决定“多久没有有效查询后可以把等待通道视为失联并清理任务”。

不承诺在 ChatGPT 服务终止、用户关闭页面、进程退出或既有明确任务期限到达后仍继续原任务。

轮询会增加工具调用、上下文消耗和结果反馈延迟；用户接受这一取舍。租约失联检测是清理失去消费者的请求，不是重新给用户回答设一个总倒计时。

服务端远程部署的 600 秒 native turn idle 继续只由真实业务进展刷新。Native wait/retry 不是业务进展，不能把 last-progress 时间归零；但只要 turn 中有已启动、未结束且 120 秒等待租约有效的 operation，idle 到期动作暂停。租约失效或 operation 结束且没有其他符合条件的等待 operation 后，idle 立刻按未修改的 last-progress 时间恢复判断。这个窄例外用于同时满足“活跃消费者不被桥接超时误杀”和“孤儿 turn 最终可回收”，不是关闭远程 idle，也不是把轮询改名为业务进展。

### P3：稳定 operation identity 与查询协议

每个可能执行 Native 的逻辑操作在第一次原工具调用发出前，由调用方/connector 在当前 Broker capability 内分配一个递增的正整数 `operation_id`。原专用入口、普通 `codex_tool_call` 和可能使用 Native gateway 的 `codex_tool_inventory` 直接携带该 `operation_id` 启动；长请求返回 pending 后用固定 `codex_tool_wait` 查询同一 operation。短请求只需要一次原工具调用，公共结果格式保持不变，但请求 schema 增加 `operation_id`。

operation identity 必须在任何 Native 副作用发生前由调用方持有。真正的唯一键是 `(Broker capability epoch, operation_id)`：Automatic 绑定当前 `turn_token` capability，Zero Risk 绑定当前 `request_id` capability。数值 ID 不需要跨 capability 全局唯一，也不是授权凭据；新的 capability 可以重新从 `1` 开始。同一 capability 中新的逻辑调用递增分配 ID，并发分配必须唯一；允许跳号，网络到达顺序也不要求与数字顺序一致。

一个 `(capability, operation_id)` 最多启动一次 Native call。第一次请求真正到达 Broker 后，无论最终准入成功还是得到确定性准入拒绝，该 ID 都绑定首次规范化启动请求描述：同 ID + 同描述的重试只重新附着或重放既有拒绝，同 ID + 不同描述必须 conflict；修正请求和其它新的逻辑调用必须使用新的 operation_id。MCP/Tunnel/Responses reconnect 不得使同一个存活 capability 的 ID 分配状态重置。

首次 pending 或真实结果回执丢失后，调用方继续使用原 `operation_id` 重试或查询，不得按参数猜测重试身份，也不得重新执行 Native。结果形成后必须缓存并允许同一 operation 重放；结果回执丢失不能导致再次执行。

本地分配一个 operation_id 不冻结工具权限、schema、direct/gateway 路由或 `registryGeneration`。第一次请求真正到达 Broker 时先原子绑定一个不依赖准入成功即可构造的规范化启动请求描述，再按当前 registry 完成一次准入；成功后固定最终 Native wire / gateway 目标并创建唯一 call ID。确定性准入拒绝不得创建 Native call，也不得仅因此退休整个任务，但它仍占用该 ID 并缓存安全的公共终态拒绝。为了保持首次准入错误回执丢失后的确定性，同描述 retry 稳定重放原拒绝；不同描述返回 operation conflict；修正后的新尝试使用新的 ID。`registryGeneration` 是工具目录版本，不是 capability epoch。

operation 一旦完成首次准入并取得唯一 call ID，后续同 ID 的合法启动重试、wait 和结果重放不再作为新的工具准入。确定性准入拒绝也不因后续 registry 变化重新准入同一 ID。准入后工具被删除或 registry/schema/路由变化，不影响该已接受 operation；如果重试请求与第一次绑定的启动请求描述不同，则按 operation conflict 拒绝，不生成第二个 call。

`codex_tool_call` 的 `codex.control.compaction_handoff` 是控制专用路径，不创建 Native operation，因此明确不要求 `operation_id`。它继续使用隔离的 `control_*` token；不能为了统一 schema 而给控制 token 普通 turn capability。普通 Native `codex_tool_call` 仍必须在首次调用前使用合法 operation identity。

### P4：operation 生命周期、取消与 retained compaction

operation 绑定的生命周期定义为 Broker capability epoch，而不是浏览器/Responses/compaction epoch。retained compaction 的权威边界是 Broker handoff：仍在 `queuedCallIds` 的 call 可由压缩控制接管；接管后不执行该 Native call，而是把现有压缩控制结果缓存为该 operation 的桥接控制终态，供原 handler、wait 或同描述 retry 交付/重放。`nextToolBatch()` / `takeQueued()` 已把 call 移入 `deliveredCallIds` 后，即使 Adapter 还没有执行 `emitToolBatch()`，也按 waiting 处理并继续接收真实结果。新 capability 不得接管旧 operation。

单次 `codex_tool_wait` 查询中止或断开只取消该查询等待者，不自动取消底层 operation；operation 在 120 秒租约、任务所有权和其他真实终止条件仍有效时继续。显式任务取消仍撤销对应 operation。

不支持跨 Broker/所有者进程重启恢复 operation。重启后旧 operation 失效，不持久化恢复，也不自动重放有副作用的 Native 调用。

retained handoff 与 fresh/fallback retirement 必须分开。保留同一 owner 的 retained compaction 继续按 Broker handoff 分界处理；`experimentalFreshConversationPerTurn` 的 configured fresh compaction，或 delegated source identity 无法精确证明而进入 fresh fallback 时，现有合同先退役旧 browser/tool owner。用户确认这些路径同步退役旧 owner 的 queued/waiting/result-ready operation；fresh owner 不接管，不自动重执行旧 Native 调用，并需要可识别的终止原因。

### P5：公共结果与完成屏障

`codex_tool_wait` 返回原桥接入口本应返回给 ChatGPT 的公共结果，不直接暴露 raw Native/gateway result。普通 Native 调用保持现有结果字段；需要桥接层后处理的 `codex_tool_inventory` 必须继续完成现有解析、校验、分页和 direct/nested 合并，再缓存公共结果。唯一的控制分流是 queued operation 被 retained compaction 接管：压缩控制结果直接作为该 operation 的桥接控制终态缓存并重放，绕过普通 Native / inventory finalizer，不能被误解析成 Native 结果。原 MCP handler 返回 pending 后不能成为后处理继续存在的必要条件。

当前 inventory 公共结果还有可选 `discovery_tools`：只有非空过滤查询最终零命中时，才把当前 `toolSearch` 发现入口作为独立字段返回；它不计入 `total`，不参与分页，且 `include_schema` 决定是否带 `parameters`。异步 finalizer 的有界快照和结果重放必须保留这些语义，不能把“查询零命中”退化成“没有可用发现工具”。

queued、waiting 和 result-ready operation 都阻止 Automatic 完成屏障和 Zero Risk 最终完成，直到公共结果已经交付或 operation 明确退休。result-delivered 的缓存结果可以继续重放，但不应永久阻止完成。

### P6：旧组件兼容

如果 connector/helper 不支持 per-capability `operation_id` + wait 新合同，必须在任何有副作用的 Native 调度前明确拒绝并提示升级或刷新。不得静默退回旧的 90 秒失败路径；无副作用的能力检查可以发生在拒绝之前。

### P7：实施前证据关口

正式实现前必须先用真实 ChatGPT + Tunnel 验证“首次原工具调用携带 operation_id → wait/重试”拓扑。Automatic 和 Zero Risk 都要证明：operation_id 在任何 Native 副作用前已经由调用方持有；短调用不增加额外 begin 步骤；启动只执行一次 Native；Native 阻塞期间查询可直接访问同一 Broker operation；首次 pending/结果回执丢失后仍能使用原 operation identity 恢复；同 capability reconnect 后不会重置 ID 分配；用户最终输入或审批结果回到同一 operation。

纯 Broker 单测、DEV 模拟输入或缩短超时测试不能替代这项平台能力证据。如果真实链路不支持上述拓扑，应停止当前方案并重新打开等待机制分支，不能退回参数猜测去重或接受重复执行。

### P8：保留的实施自由

资源上限的具体常量、内部状态类型/字段名、错误码最终名称、finalizer 放置位置和协议版本号没有固定。实现可以在不改变 P1—P7 行为、风险和验收边界的前提下选择这些细节。

## 项目事实与已取得证据

当前核对基线：Git `d25998dec7868ced34be3ffccd52c0b50b0ed44c`，包版本 `6.0.1-1`。v0.4 之前的决定来源最初建立在 `b9098e5832f99b948cf9f3678f438a522e84294b` / `5.0.9-10`；本轮已针对当前基线重新核对会影响 R1—R5 的实现合同。下列结论不替代故障现场日志。

| 编号 | 事实 | 可恢复来源 |
| --- | --- | --- |
| E1 | 通用 MCP invoke 最长等待 90,000 ms；失败分支 release 整个 binding | [mcp-server.ts](../../../src/adapters/chatgpt-web/mcp-server.ts)，`CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS`、`chatGptMcpInvocationTimeout()`、`invoke()` |
| E2 | release 撤销 token；Adapter 观察 retirement 后中止浏览器；已发送任务的普通错误可能被统一包装 | [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts)，`release`、`revoke()`；[index.ts](../../../src/adapters/chatgpt-web/index.ts)，`observeCapabilityRetirement()`、`submittedTurnFailure()` |
| E3 | `wait_agent` 有 30,000 ms 轮询约束；`request_user_input` 没有对应专门处理 | [mcp-server.ts](../../../src/adapters/chatgpt-web/mcp-server.ts)，`GATEWAY_AGENT_WAIT_TOOL_NAMES`、`browserToolParameters()`、`assertBrowserToolArguments()` |
| E4 | Native 结果由后续 Responses 请求交给 Adapter，再调用 `broker.completeTool()`；查询若再次依赖该 Native 调度，会受尚未完成的原调用阻塞 | [index.ts](../../../src/adapters/chatgpt-web/index.ts)，`currentToolResults()` 及 outstanding 结果交付分支 |
| E5 | 浏览器对工具进展还有 10 分钟的新鲜度上限；只有一次工具开始记录不能永久抑制 DOM 停滞判断 | [browser-worker.ts](../../../src/adapters/chatgpt-web/browser-worker.ts)，`CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS`、`chatGptExternalProgressSuppressesDomHealth()` |
| E6 | 当前实际工具目录中的 `request_user_input` 只接收 questions；描述为等待响应；没有 timeout、operation_id 或查询接口 | 本轮实际读取工具目录的结果。仅查询描述与 schema，没有调用用户输入工具 |
| E7 | Broker 的完成屏障检查 invocations 和 activities；Zero Risk 完成同样拒绝未完成工具 | [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts)，`beginCompletionFence()`、`commitCompletionFence()`、`completeSafeTurn()` |
| E8 | DEV 的用户输入工具是模拟工具，不能证明真实人工等待行为 | [driver.ts](../../../src/dev-chat/driver.ts)，`DEV_CHAT_TOOLS`、`simulatedFunction()` |
| E9 | 当前 retained compaction 只把尚在 `queuedCallIds` 的调用转换为 compaction 控制结果；已经由 Broker handoff 给 Adapter、进入 `deliveredCallIds` 的调用仍可通过 `completeTool()` 返回真实结果。现有测试覆盖 Broker handoff 边界，不证明 `emitToolBatch()` 已发生 | [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts)，`requestCompaction()` / `takeQueued()`；[retained-compaction.test.ts](../../../tests/retained-compaction.test.ts)，`active compaction delivers the current result and converts every later MCP call into the checkpoint request` |
| E10 | 当前 MCP stdio server 的 `send()` 只等待 stdout `write()` 成功或 `drain`，没有 ChatGPT/connector 远端消费确认；不能用它证明首次结果已被调用方取得 | 当前安装的 `@modelcontextprotocol/sdk`，`node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js` 的 `StdioServerTransport.send()` |
| E11 | Broker 的实际 compaction 分界早于 Native emit：`takeQueued()` 把 call 从 `queuedCallIds` 移入 `deliveredCallIds` 后，Adapter 还会等待工具边界，随后才在 `emitToolBatch()` 处向外层返回工具调用 | [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts)，`nextToolBatch()` / `takeQueued()`；[index.ts](../../../src/adapters/chatgpt-web/index.ts)，工具边界等待和 `emitToolBatch()` 分支 |
| E12 | 当前 `codex_tool_inventory` 的 gateway Native result 不是最终公共结果；handler 还会执行 `gatewayToolCatalogPage()`，再与 direct page 合并为 `tools/total/next_offset`；过滤查询最终零命中时还可返回独立 `discovery_tools`，来源是 `visibleTools` 中的 `toolSearch` 工具，且受 `include_schema` 控制 | [mcp-server.ts](../../../src/adapters/chatgpt-web/mcp-server.ts)，`codex_tool_inventory` handler、`gatewayToolCatalogPage()`、`discoveryTools` 分支 |
| E13 | 服务端远程部署有独立 `NativeTurnIdleRegistry`；默认合同是 600 秒无真实业务进展触发 `client_turn_idle_timeout`，Server 随后取消 HTTP、browser、broker/compaction ownership | [native-turn-idle.ts](../../../src/native-turn-idle.ts)，`arm()`；[server.ts](../../../src/server.ts)，remote idle `onExpire` / native turn cancellation |
| E14 | Broker `updateEnvironment()` 推进 `registryGeneration`；普通 invoke 在创建 call ID 前按当前 registry 找工具并校验。这个 generation 表示工具目录变化，不是 capability 身份 | [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts)，`updateEnvironment()`、普通 invoke 准入分支 |
| E15 | `codex_tool_call` 当前包含 `codex.control.compaction_handoff` 控制专用分支；它直接提交 handoff，不进入普通 `withClaimedTurn()` / Native invoke | [mcp-server.ts](../../../src/adapters/chatgpt-web/mcp-server.ts)，`CODEX_COMPACTION_CONTROL_WIRE_NAME` 分支 |
| E16 | configured fresh compaction 会退役未结束旧 execution；delegated 模式无法证明 exact source identity 时会先退役旧 retained conversation，再执行 fresh compaction | [index.ts](../../../src/adapters/chatgpt-web/index.ts)，`freshConversationPerTurn` 与 delegated `exactSource` fallback 分支；[delegated 规格](../delegated-tool-authority/spec.md) 的 source turn fallback 合同 |
| E17 | 当前 delegated authority 合同明确区分动态 registry 的新调用准入与已接受调用的结果交付：工具后续从 registry 移除不能单独否定已经接受的调用结果 | [delegated 规格](../delegated-tool-authority/spec.md) 的工具 registry 生命周期要求；[turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts) 当前准入与结果路径 |

已复核以下现有测试，第一组结果为 **2 pass，0 fail，18 次断言**：

```sh
bun test tests/chatgpt-web-harness.test.ts tests/browser-worker-contract.test.ts -t 'a native tool deadline returns an explicit MCP timeout instead of a transport failure|stale MCP progress stops suppressing DOM health without penalising long active turns'
```

这验证的是当前超时退休机制和进展过期判断，不是新方案通过验收。前一个测试用缩短的能力期限触发超时，没有进行 90 秒真实人工等待。

v0.2 修订时另外复跑 retained compaction 的当前合同测试，结果为 **1 pass，0 fail，2 次断言**：

```sh
bun test tests/retained-compaction.test.ts -t 'active compaction delivers the current result and converts every later MCP call into the checkpoint request'
```

该测试只证明 E9 描述的现有行为仍成立，不证明新的 operation_id/wait、固定 finalizer 或等待租约已经实现。

v0.3 修订后再次复跑上述两组当前行为测试，结果仍分别为 **2 pass，0 fail，18 次断言** 和 **1 pass，0 fail，2 次断言**；同时对两份未跟踪文档执行尾随空白扫描，未发现问题。它们仍只验证未实现新协议前的基线行为。

2026-09-23 的 v0.4 独立复审在 `d25998d` / `6.0.1-1` 基线上报告：从 6 个相关测试文件选取的 10 项定向回归为 **9 pass，1 fail**；`bun test tests/native-turn-idle.test.ts` 为 **4 pass，0 fail，30 次断言**。失败的远程 replay 用例在沙箱外进入实际工具等待后观察到 `client_turn_idle_timeout` 撤销 Broker/browser ownership，但中间重试断言仍是预期 200、实际 504；该失败根因没有在复审中关闭。这些结果是复审提供的基线证据，本轮文档修订没有把它们重新描述成新协议验收通过。

## 开放证据与复审缺口

1. P1—P8、remote idle / fresh retirement 取舍、v0.6 的 per-capability 递增 operation_id 简化方案，以及 v0.7 的 queued compaction 控制终态和拒绝 ID 占用规则均已确认，不再作为开放产品决定。真实 ChatGPT + Tunnel + Native 输入阻塞期间的 operation_id→wait/retry、同 capability reconnect 后 ID 稳定性和首次回执丢失恢复尚未验证；这是正式实现前的硬证据关口。远程部署默认 600 秒 idle 开启时的 11 分钟等待也必须纳入该真实链路证据。
2. “Tunnel 约两分钟截止时间”来自源码注释，未独立验证当前上游的精确时限；不能作为服务承诺，也不能据此承诺调大本地超时有效。
3. 尚未取得与原始故障对应的现场日志。可确认代码存在该失效路径，不能确认每次同文案错误都由这一路径造成。
4. v0.4 已完成独立复审并产生 R1—R5；v0.5 修订这些问题。v0.6 简化启动 identity 合同后的独立复审又发现 queued compaction 终态续接和拒绝 ID 冲突语义两项缺口，当前 v0.7 已按用户确认的决定修订。**v0.7 尚未独立复审**，因此当前状态仍不是实施基线。
5. v0.4 复审中的远程 replay 定向用例仍有一个 504 失败；它验证的是当前基线远程 idle/重试组合，不是 operation_id/wait 新协议。后续实现前需要保留该失败作为集成风险，不能把文档修订当作根因关闭。

## 委托与延后

本轮只把已确认决定同步回当前规范与决定记录。没有产品实现、真实输入弹窗试验、发布、Git commit 或服务重启。

当前确认接受 30 秒查询窗口、120 秒租约、Broker handoff 压缩边界、公共结果重放、调度前兼容拒绝、不跨重启恢复、remote idle 的“等待租约暂停终止但不刷新业务进展”规则、fresh/fallback owner retirement 同步退役旧 operation、queued compaction 的可重放桥接控制终态，以及确定性准入拒绝占用并绑定首次 ID 的规则。此前接受的额外 `codex_tool_begin` 成本已被 v0.6 起的一次原工具调用方案明确取代。协议版本号、错误码名、内部状态类型、资源常量和 finalizer 放置仍由后续实现/规格细化决定。

后续若真实链路不能在首次原工具调用前稳定携带 per-capability operation_id、不能在同 capability reconnect/首次回执丢失后保留原 operation identity，需要重新对齐受影响设计；不得静默退回超时终止、参数猜测去重、重复执行或改变 retained compaction 的既有 Broker handoff 语义。其余有效来源继续保留。
