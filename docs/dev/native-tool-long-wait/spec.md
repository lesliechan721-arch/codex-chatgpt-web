# Codex Native 长等待修复 Spec

版本：v0.7。规格日期：2026-09-23。

**当前状态（2026-09-24）：用户已确认前期技术验证完成，并授权按本规格实施。实现、验证结果和剩余交付条件见 [实施记录](work.md)。** 下文关于“待技术验证”“尚未实现”“不是实施基线”的表述保留为本次授权前的历史记录，不再阻止已授权的实施。本轮没有重新执行真实 ChatGPT 的 11 分钟验收，也没有完成独立代码审查。

## 1. 本次交付与审阅导航

本规格处理正常 Native 工具等待被桥接层误判为失败、撤销任务绑定并关闭 gpt-web 会话的问题。用户输入是必须覆盖的代表场景。目标是区分“单次传输等待结束”和“原生工具已经结束”。

2026-09-21 的决策访谈已从“没有任何已确定内容”开始逐项确认本规格的产品与协议方向。文中的“必须”和“不得”现在表示已确认的行为约束；它们不表示代码已经实现，也不表示真实链路技术验证已经通过。

建议按此顺序审阅：第 2 节范围和等待策略，第 3—5 节调用与存活合同，第 6—7 节取消和兼容影响，第 8—9 节验证及实施边界。来源、实际证据与确认状态见 [需求对齐记录](decisions.md)。本稿没有其他规范性附件。

v0.3 依据 v0.2 独立 Spec Review 补全了稳定启动身份、Broker handoff 边界和长等待 `codex_tool_inventory` 的结果后处理续接。v0.4 把随后已确认的决策正式写入规范：统一覆盖全部桥接 Native 长等待、不设桥接层总等待上限、30 秒语义等待窗口、120 秒失联租约、Broker 预分配 operation identity、句柄查询、Broker handoff 压缩边界、公共结果重放、查询取消隔离、完成屏障、调度前兼容拒绝和不跨重启恢复。

2026-09-23 的 v0.4 独立复审在当前 `d25998d` / `6.0.1-1` 基线上发现 1 项跨规格 blocker 和 4 项重要协议缺口。v0.5 保留原方案并吸收这些新基线合同：合法 Native 等待租约暂停远程 600 秒 idle 的**终止动作**但不伪装成真实业务进展；inventory 保留可选 `discovery_tools`；动态 registry 的首次准入与已接受 operation 重试分离；`codex.control.compaction_handoff` 保持控制专用例外；configured fresh compaction 和 delegated source fallback 退役旧 owner 时同步退役其旧 operation。

v0.6 进一步简化启动协议：删除额外的 `codex_tool_begin` 和 prepared ticket。每个新的 Native-capable 逻辑调用在第一次进入 Broker **之前**，由调用方/connector 在当前 Broker capability 内分配一个递增的正整数 `operation_id`，并直接把它放进原 `codex_*` 调用。短调用只需要一次原工具调用；长调用超过 30 秒后返回同一个 `operation_id` 的 pending，再由 `codex_tool_wait` 查询。该简化不改变首次回执丢失的去重要求：同一逻辑调用的 retry 必须复用原 ID，新的逻辑调用必须取得新的 ID。

2026-09-23 的 v0.6 独立复审随后指出两项协议缺口：queued operation 被 retained compaction 接管后缺少可重放的终态结果合同；确定性准入拒绝虽然要求按同一 ID 重放，但没有明确同 ID + 不同启动描述仍必须 conflict。v0.7 按后续 `decision-grill` 的确认修复这两点：压缩接管缓存桥接控制终态并绕过 Native finalizer；任何已经到达 Broker 的确定性准入拒绝也占用该 `operation_id` 并绑定首次启动请求描述。对应决定来源和当前证据见 [需求对齐记录](decisions.md)。

上述方向均已确认。尚未固定的是不会改变这些行为约束的实现细节，例如资源上限常量、内部状态类型/字段名、错误码最终名称、finalizer 放置位置和协议版本号。真实 ChatGPT + Tunnel 能否让调用方在 Native 副作用发生前稳定携带同一个 per-capability `operation_id`，并在首次 pending/正常结果回执丢失后用该 ID 重试或 wait，仍是进入正式实现前必须通过的证据关口。

## 2. 用户结果、范围与不变量

### 2.1 用户结果

用户看到 Native 的输入框或审批界面后，可以继续思考和操作。30 秒、90 秒或 10 分钟经过本身，都不能被转换为工具失败或正常等待的结束。用户提交答案后，原调用的真实结果交回 ChatGPT，原任务继续。

这项保证以任务所有者、原生调用和等待通道仍有效为条件。工具自己返回的超时、拒绝、空回答或错误保持原语义；用户明确取消、页面真实关闭、所有者退出或明确的任务总期限仍可结束任务。

服务端远程部署的 600 秒 native turn idle 继续记录“距最后一次真实业务进展”的时间；合法 `codex_tool_wait` / 启动重试不把这个时间归零。只要当前 turn 仍有已启动、未结束且 `120_000 ms` 等待租约持续有效的 Native operation，远程 idle 到期动作必须暂停。该等待租约失效或 operation 结束后，如果没有其他符合条件的 Native operation，远程 idle 立即按原来的真实业务进展时间恢复判定；此时已经超过阈值就可以立即清理。这样既不把轮询冒充业务进展，也不把一个仍有可验证消费者的人工等待强制截断在 600 秒。

### 2.2 覆盖范围

确认范围为 Automatic Full 与 Zero Risk 共用的 Native 调用链，覆盖专用调用入口、通用 `codex_tool_call` 和其 Native gateway 分支。人工输入、原生审批、长工具调用以及 `codex_write_stdin` 都不能仅因一次 MCP 等待期满而撤销整个任务。

`codex_tool_inventory` 若实际通过 Native gateway 执行，也采用同一长等待合同。完全在本地完成的目录读取不需要制造 pending。新的 `codex_tool_wait` 控制工具通过 MCP 固定工具列表可发现，不依赖先调用可能阻塞的 Native inventory。

不覆盖 Browser-only、ChatGPT 自有工具、外部服务恢复、跨进程重启恢复、新的输入/审批界面或子代理能力。保留已有 `wait_agent` 参数规则；不以本次修复放宽其调用语义。

### 2.3 全局不变量

- 同一 `operation_id` 在存活的 Broker capability 中最多启动一次逻辑操作并最多生成一次 Native call；查询、同一启动请求重试、Responses 重连和结果重放都不能再次执行该操作。两个不同的 `operation_id` 即使工具名和参数相同，也表示两个不同的新调用，不能因参数相同被合并。
- pending 不是 Native tool result、不是用户回答、不是审批、不是成功、不是错误，也不是允许 ChatGPT 提交最终答案的信号。
- 真实工具执行仍由 Codex Native 负责。不能把执行搬到 MCP 服务进程，以绕过审批、沙箱或调用生命周期。
- 任务绑定、原生调用、MCP 请求和浏览器完成是不同生命周期。一次查询结束只能释放该查询的等待资源。
- 本修复不通过加大 90 秒常量、持续 SSE 心跳或删除全部失联检查来实现。

## 3. 一次执行与独立查询合同

### 3.1 必须成立的数据流

```text
调用方/connector 在当前 Broker capability 内为新的逻辑调用分配 operation_id
  → operation_id 是递增的正整数；分配发生在任何 Native 副作用之前
ChatGPT 直接用该 operation_id 调用原有 codex_* 入口
  → Broker 以 (capability, operation_id) 查找逻辑操作
  → 首次出现时按当前 registry 准入并原子绑定启动描述，最多创建一次 BrokerToolRequest / Native call ID
  → 同 ID + 同启动描述的 retry 只附着到已有 operation；同 ID + 不同描述拒绝
  → Adapter 取得该 call；Codex 执行并可能等待人工输入
  → MCP 的本次等待期满，向 ChatGPT 返回 pending；operation_id 已在启动前由 ChatGPT 持有
  → ChatGPT 用固定查询入口直接读取 Broker 中的同一操作
  → 用户回答，Codex 在后续 Responses 请求中提交真实 tool result
  → Adapter 将该结果交给原操作
  → Broker 按该操作固定的结果合同完成桥接后处理并缓存公共结果
  → 查询返回与原入口一致的公共结果，ChatGPT 继续原任务
```

查询路径必须是 `ChatGPT → MCP → Broker`，不得生成新的 `BrokerToolRequest`、不得要求外层 Codex 发起下一次模型请求，也不得调用 Native `request_user_input`、`exec`、`wait` 或 inventory 作为查询实现。否则外层仍在等待原生结果时会再次阻塞。

Broker 必须独立持有 operation identity、启动描述、原操作、结果接收槽位、固定结果合同及其有界后处理上下文。原始 MCP handler 返回 pending、对应 socket 正常关闭或查询 handler 结束，都不得销毁已启动操作的槽位。

### 3.2 公共接口

新等待协议下，所有可能创建 Native operation 的桥接入口都必须接收 `operation_id`：专用 `codex_exec`、`codex_write_stdin`、`codex_apply_patch`、`codex_view_image`、通用 `codex_tool_call`，以及可能通过 Native gateway 补全目录的 `codex_tool_inventory`。原有执行参数和短调用的**结果格式**保持不变，但请求 schema 增加这个桥接控制字段。`operation_id` 只属于桥接控制层，必须在构造 Native 参数或 gateway program 前剥离，不能改变外层 Codex 工具实际收到的参数。

`operation_id` 是当前 Broker capability 内的正整数逻辑调用序号，必须在第一次发送该逻辑调用前分配，并满足：

- Automatic 的唯一键是 `(turn_token 所属 capability epoch, operation_id)`；Zero Risk 的唯一键是 `(request_id 所属 capability epoch, operation_id)`。
- 新逻辑调用按 capability 内的计数器递增分配；并发分配必须保证唯一。允许因为请求在到达 Broker 前取消等原因出现跳号。网络到达顺序可以与数值顺序不同，Broker 不得依赖“更大的 ID 一定先/后到达”，也不得要求 ID 连续到达。
- 数值只需在当前 capability epoch 内唯一，不要求跨任务、跨 capability 或跨进程全局唯一；新的 capability 可以重新从 `1` 开始。
- ID 必须是 JSON safe integer 范围内的正整数。它不是授权凭据，也不要求不可猜；读取、重试和查询仍必须同时验证当前授权及 capability ownership。
- MCP/Tunnel/Responses reconnect 不得重置同一个存活 capability 的分配状态。同一逻辑调用的 retry 必须复用原 ID；新的逻辑调用即使参数完全相同，也必须分配新 ID。

`codex_tool_call` 的 `codex.control.compaction_handoff` 是明确的控制专用例外：它提交 checkpoint，不创建 Native operation，不要求 `operation_id`，也不得为了满足新协议而让 `control_*` token 获得普通 turn capability。该分支继续只接受其现有控制参数和专用 token；普通 Native `codex_tool_call` 仍必须在第一次调用前带有合法的 per-capability `operation_id`。

启动入口第一次看到当前 capability 中尚不存在的 `operation_id` 时，Broker 必须先原子占用该 ID，并记录一个**不依赖准入成功即可构造**的不可变启动请求描述。该描述至少覆盖桥接入口、调用方请求的逻辑目标、freeform 模式意图和剥离桥接控制字段后的规范化请求参数；授权字段和 `operation_id` 本身不属于执行参数指纹。专用入口的逻辑目标来自该入口本身；普通 `codex_tool_call` 使用调用方提交的 `wire_name`；inventory 使用其固定目录操作类型和规范化查询参数。这个准入前描述不要求当前 registry 已经能解析出合法的最终 Native wire name 或 gateway 目标。

记录启动请求描述后，Broker 才按**当前** registry 和当前桥接准入规则作第一次准入。若准入成功，再把当次解析出的最终 Native wire name / gateway 目标、实际 freeform 模式和固定结果合同绑定到该 operation，并最多创建一个唯一 call ID；若是确定性准入拒绝，则不创建 Native call，但该 ID 已被占用，并把安全的拒绝结果缓存为该逻辑调用的公共终态。对同一 ID 的占用、描述记录和首次准入结果必须线性化，不能让并发请求分别把同一 ID 绑定到两个不同描述。对外只允许看到“尚无该 ID”或“该 ID 已绑定且已有准入成功/确定性拒绝结果”；准入结论形成前的基础设施失败不得留下可查询的半完成 identity，实现内部不得因此重新暴露 prepared 一类公共状态。

重复使用同一 `operation_id` 时，必须先比较准入前启动请求描述：

- 若描述不同，则以 `codex_tool_operation_conflict` 类错误拒绝，且不得创建 Native call、覆盖旧拒绝或改变既有 operation；
- 若描述相同且第一次准入已确定性拒绝，则稳定重放原拒绝，不按后来变化的 registry 重新准入；
- 若描述相同且 operation 已准入，则视为同一启动请求的重试，只复用已有 operation / call ID，并按当前状态返回结果、控制终态或 pending；
- 新的逻辑调用或修正后的新尝试即使参数完全相同，也必须分配新的 `operation_id`。

ID 的本地分配不冻结工具权限、schema、direct/gateway 路由或 `registryGeneration`。第一次请求真正到达 Broker 并占用该 ID 时，必须按当时的当前 registry 完成一次准入。确定性的准入拒绝不得创建 Native call，也不得仅因此退休整个任务 capability。为了让首次准入错误的回执丢失也保持确定性，Broker 必须按上述启动请求描述规则稳定重放拒绝；只有新的 `operation_id` 才表示修正后的新逻辑尝试。`registryGeneration` 是动态工具目录版本，不是 capability epoch。

一旦某个 operation 已通过准入、记录不可变启动描述并创建唯一 call ID，后续同 ID 的合法启动重试、`codex_tool_wait` 和结果重放只附着到该已接受 operation，不再把当前 registry 当作一次新的工具准入。工具随后从 registry 删除、schema 变化或 direct/gateway 路由变化，都不能仅因此否定已经接受的 operation；但调用方若用同一个 `operation_id` 提交一个按照新 schema/新路由重写后与原启动描述不同的请求，仍按 operation conflict 拒绝，不能生成第二个 call。

长请求在本次等待预算结束后返回控制回执，例如：

```json
{
  "kind": "codex_native_pending",
  "operation_id": 1,
  "next_tool": "codex_tool_wait"
}
```

这段 JSON 表示控制合同，不是实际工具结果。它应同时具有可读文本和结构化表示，不设置 `isError: true`。它必须明确说明：继续查询这个 ID；如果启动调用本身需要重试，也只能携带同一个 `operation_id` 重试；新的逻辑调用必须使用下一个新 ID。是否增加独立协议版本字段以及其具体数值由实现阶段冻结，不属于已确认产品决定。

新增固定 MCP 工具 `codex_tool_wait`：Automatic 接收当前 `turn_token` 与 `operation_id`；Zero Risk 接收当前 `request_id` 与 `operation_id`。分别沿用各自合同，不在一个模式中接受另一个模式的授权字段。不公开内部 `bindingId`，不接收执行参数，不增加用户可调的等待配置。普通结果就绪后，`codex_tool_wait` 必须返回“原桥接入口本应返回给 ChatGPT 的公共结果”，不能把 Broker 内部 raw Native result 或后处理元数据暴露为新的公共格式；若 queued operation 已被 retained compaction 接管，则返回第 4.2 节定义的同一份缓存桥接控制终态，而不是继续等待一个不会发生的 Native 结果。

`operation_id` 由调用方/connector 分配，但只有与当前任务、模式和 **Broker capability epoch** 绑定后才表示一个 Broker operation；一个 `(capability epoch, operation_id)` 最多对应一个 Native call。这里的 capability epoch 指一次 Broker turn capability 的生命周期：Automatic 由一个已注册的 `turn_token` 所属 capability 实例标识，Zero Risk 由一个已注册的 `request_id` 所属 capability 实例标识，并允许实现增加不可伪造的内部 generation。它从 capability 注册开始，在该 capability 被 revoke、过期、所有者丢失、Automatic 完成屏障提交或 Zero Risk 进入终态时结束。Responses round、浏览器 retained conversation epoch、MCP/Tunnel 连接和一次 compaction round 都不是新的 capability epoch。

启动重试和查询都必须验证当前授权、capability epoch 和 operation 归属。仅知道数值 `operation_id` 不能启动、附着或读取别的任务结果。跨任务、跨 capability epoch、过期或已撤销的 operation 必须明确拒绝，且不能泄漏其他任务的内容或创建新操作。浏览器或 Responses 的重建不得自行把旧 operation 重新绑定到新的 capability。一个新的、尚未使用的数值 ID 只有在当前 capability 的合法原工具调用第一次到达 Broker 时才可以创建新 operation；`codex_tool_wait` 不能凭未知 ID 创建 operation。

控制回执只能由桥接控制路径产生。禁止通过扫描 Native 工具输出中的 `pending` 字样来改变状态；原生结果恰好包含相同字段时仍是普通结果。实现需为桥接回执保留可识别来源标记，并为这种字段碰撞编写测试。

### 3.3 单次等待与失败边界

首次原工具调用和每次结果查询的语义等待预算均为 `30_000 ms`。30 秒只是本次 MCP 交互等待结果的窗口，不是 Native 操作期限。工具较早完成时立即返回，不额外等满窗口。查询从 Broker 持有的内存 operation 槽位读取，不通过故意触发 `TurnBrokerTimeoutError` 来制造 pending。

保留独立的传输失败预算和连接清理。在正常事件循环与连接条件下，30 秒窗口结束即形成回执；90 秒不能继续充当未结束 Native 操作的终止计时器。控制路径本身失联、数据损坏或无法完成收尾，才进入明确的基础设施错误路径。

当真实结果与等待计时器同时就绪时，状态转换必须线性化。本次可以返回 pending 或真实结果中的一个，但真实结果必须保留供后续读取，不能丢失、重复执行或触发撤销。

### 3.4 重试与回执丢失

调用方在第一次原工具调用前已经分配并持有的 `operation_id` 是本稿解决首次回执丢失的权威启动身份。不得把 MCP stdio `send()` 已完成、stdout 已接受写入或本地 socket 已正常关闭当成“ChatGPT 已收到结果”的端到端确认；当前 stdio transport 只保证本地 write / drain 结算，没有远端消费确认。协议正确性因此不能依赖这种不可观测的确认。

一个已经用于启动的 `operation_id` 必须贯穿启动重试、pending 查询和结果重放：

- 若首次启动请求在 Broker 记录该 ID 的启动请求描述之前中断，Broker 中尚无该 operation；携带同一个 `operation_id` 重试可以按当时的当前 registry 准入并最多启动一次。
- 若 Broker 已记录该 ID 并得到确定性准入拒绝，但拒绝回执丢失，同描述重试只重放原拒绝；不同描述必须 conflict，修正后的新尝试使用新的 `operation_id`。
- 若 Broker 已接受并已创建 queued / waiting operation，但首次 pending 或真实结果回执在调用方收到前丢失，携带同一个 `operation_id` 重试原入口只能重新附着到该 operation；不得创建第二个 call。调用方也可以直接查询同一 operation。
- 若结果回执丢失，结果缓存至少一次交付；同一 operation 读取只重放公共结果，不重新执行 Native。
- 新逻辑调用必须分配新的递增 `operation_id`；不能通过复用已经占用的 ID 来表示另一次调用。

保留当前 Responses 重连协议：尚未收到对应真实结果时，Broker 可以重发同一个 call ID 的批次。这是原有交付重放，不是分配新的 Native 调用。新查询不得触发这种批次重放；不得为避免重发而提前删除原生 outstanding 记录。重连测试需分别核对操作数量、call ID 和 Native 实际执行次数，不能仅统计回执数量。

如果真实 ChatGPT/Tunnel/connector 不能在第一次 Native-capable 原工具调用发出前稳定附带 per-capability `operation_id`，或者在首次结果丢失后的恢复路径中不能保留并复用原调用的 ID，第 8.1 节技术关口失败，本设计不能进入实现。不得退回按工具名、参数或命令文本猜测重试，也不得用 stdio write 成功替代端到端身份。跨进程重启仍不重建操作、不自动重新弹窗、不自动重放有副作用的命令。

## 4. 状态、真实结果与完成屏障

### 4.1 逻辑状态

下表名称是规范中的语义标签，用于定义行为边界；实现内部的类型名、字段名和状态表示可以不同，只要转换语义等价。

| 状态 | 意义 | 允许的动作 |
| --- | --- | --- |
| queued | 已接受启动描述并生成固定 call ID，call 仍在 Broker 的 `queuedCallIds` 中 | 查询返回 pending；retained compaction 可以按现有规则拦截；不得生成第二个 call |
| waiting | Broker 已通过 `nextToolBatch()` / `takeQueued()` 把 call 从 `queuedCallIds` 移入 `deliveredCallIds` 并交给 Adapter；此时 Adapter **可能尚未**执行 `emitToolBatch()` | 查询返回 pending；查询不触发再次下发；retained compaction 不再接管该 call |
| result-ready | 公共结果已形成但尚未提供给消费者；Native 调用先收到 raw result 并完成固定后处理，本地完成的 inventory、确定性准入拒绝或 retained compaction 接管形成的桥接控制终态可以不经过 raw Native result | 查询提供缓存的公共结果；阻止任务最终完成 |
| result-delivered | 已为消费者形成公共结果回执 | 同一 operation 查询可重放缓存；不得重新执行 |
| retired | 任务取消、失联清理或 capability epoch 结束 | 拒绝查询和迟到写入，不能恢复原操作 |

Native 成功、Native 返回的 `isError` 和原生审批拒绝都属于真实结果，不必把每个工具错误升级为整个任务退休。真实结果已形成回执不证明网络一定送达，所以同一存活任务内保留其可重放结果。

capability epoch 与压缩/替换的转换必须遵循下表；这是本稿对“epoch”的权威定义：

| 事件 | queued | waiting / result-ready | operation 与新任务关系 |
| --- | --- | --- | --- |
| retained compaction 开始 | queued 调用沿用当前 `requestCompaction()` 语义，由压缩控制接管，不得随后执行对应 Native call；接管结果缓存为该 operation 的桥接控制终态并进入 result-ready / result-delivered，不得永久停留在 pending | 保留当前行为：waiting 调用继续接收真实结果，result-ready 保留已形成的公共结果；compaction 本身不退休该 operation | 仍属于原 capability epoch；不得因为 browser epoch 变化而换绑 |
| configured fresh compaction，或 delegated source identity 无法精确证明而进入 fresh fallback | 旧 browser/tool owner 进入显式 retirement；属于该旧 owner 的 queued operation 一并进入 retired，不得在 fresh owner 中重新消费 | 属于该旧 owner 的 waiting / result-ready operation 一并进入 retired；拒绝迟到写入或查询，不能把旧结果槽位迁移到 fresh owner | 旧 operation 失效；fresh owner 若后续需要 Native 调用必须在其当前有效 capability 下分配新的 operation_id，禁止接管或自动重执行旧 operation |
| Responses 重连，同一 capability | queued 保持同一 call ID / operation | 保持同一 operation 和缓存结果 | 允许在同一授权下查询，不创建新调用；per-capability operation_id 分配状态不得因 reconnect 重置 |
| steering / 新指令导致新的 Broker capability | 原 capability 按现有取消/退休规则结束 | 原 capability 按现有取消/退休规则处理迟到结果；新 capability 不接管 | 旧 operation 在新 capability 中必须拒绝 |
| 显式取消、owner/helper 丢失、TTL/任务期限、终态提交 | 进入 retired | 进入 retired；迟到写入拒绝 | 不可恢复，不可转移 |

retained compaction 的权威分界是 **Broker handoff**，不是“Native 已经执行”。当前源码中该分界发生在 `takeQueued()` / `nextToolBatch()` 将 call 从 `queuedCallIds` 移出并加入 `deliveredCallIds` 时；之后 Adapter 仍可能等待浏览器工具边界，尚未执行 `emitToolBatch()`。本稿选择这个较早边界是为了保持现有 Broker 回归合同，而不是声称外层 Codex 已经收到 tool_use。若实现要把分界移动到实际 `emitToolBatch()` 或更后的 Native 接收时刻，应先修订本 Spec，并把这项行为变化作为兼容风险重新审阅。

### 4.2 结果保真

`currentToolResults()`、`brokerResult()` 和 `broker.completeTool()` 继续处理真实 Native raw result。pending 和查询记录不写入 Native 的 tool result，不伪造 `toolCallId`，不污染原始输入历史。

每个 operation 在启动时必须绑定一个由桥接代码选择的固定结果合同和有界、不可变的后处理上下文；内部字段名和类型由实现决定。结果合同只能来自代码内固定集合，不能由模型提供任意回调、脚本或可执行表达式。Native raw result 到达后，Broker 或共享的确定性 finalizer 先按该合同生成“原桥接入口本应返回的公共结果”，再进入 `result-ready`；同一 operation 后续读取只重放这个公共结果。

retained compaction 在 Broker handoff 前接管 queued operation 时，`requestCompaction()` 当前提供给该调用的压缩控制结果属于**桥接控制终态**，不是 Native raw result。Broker 必须把这个控制结果缓存为该 operation 的公共结果；原启动 handler 如果仍在等待，可以直接形成这份回执，否则后续 `codex_tool_wait` 或同描述的启动重试读取同一缓存。该控制终态必须绕过原入口的 Native 结果 finalizer，尤其不能把 compaction 控制结果送进 `codex_tool_inventory` 的 gateway catalog parser；重放也不得再次触发 `requestCompaction()`、再次执行 Native 或增加第二次压缩接管结算。它仍使用桥接控制来源标记，不能与 Native 内容字段碰撞。

- 普通专用调用和通用 `codex_tool_call` 使用 pass-through 合同。最终结果须保持原有 `content` 的顺序及多模态表示、`structuredContent`、`isError` 和 `_meta`。桥接自己的标记采用单独命名空间，不覆盖原始字段。无答案、拒绝、工具自身超时和执行会话句柄均保持 Native 返回值，不补成默认成功。
- `codex_tool_inventory` 必须使用专门的固定目录结果合同。operation 必须在启动时保存足以确定重建当前公共目录结果的有界快照：规范化的 `query` / `offset` / `limit` / `include_schema`、本地 direct page 与 direct total、排除名称、nested 窗口，以及按当次 `visibleTools` 投影出的可选 discovery 候选。Native gateway raw result 到达后，finalizer 按当前 `gatewayToolCatalogPage()` 等价规则解析、校验和合并，再缓存现有公共 `{ tools, total, next_offset, discovery_tools? }` 结果或对应安全错误。`discovery_tools` 只在非空过滤查询最终 `total === 0` 时出现，保持当前 `toolSearch` 来源和 `include_schema` 对 `parameters` 的控制；它不属于查询命中，不计入 `total`，也不参与 `next_offset` 分页。raw gateway 内容不能因异步查询而直接暴露给 ChatGPT。该内部结果合同的枚举名由实现决定。
- inventory 若不需要 Native gateway，则可以在首次原工具调用中立即形成同样的公共结果，不制造伪 pending 或 Native call。

finalizer 必须确定性、幂等；第一次 handler 和后续 `codex_tool_wait` 不能各自形成不同的目录分页、错误语义或结果字段。实现可以把 fixed finalizer 放在 Broker 或共享私有模块，但不能依赖已经返回 pending 的原始 MCP handler 继续存活。

并行批次仍使用真实 Native call ID 交付结果。当前 Adapter 要求同一 outstanding 批次完整返回；本稿不改变这一规则。查询在该批次的真实结果尚不可交付时可以继续 pending，不能为加快查询制造部分结果。

### 4.3 完成屏障与资源

已启动 operation 未结束、公共结果尚未提供给消费者，或 MCP 控制活动尚未结算时，Automatic 完成屏障和 Zero Risk 的 `codex_turn_complete` 都不得提交最终完成。缓存中已经交付的结果不再永久阻止完成。

`activities` 表示当前 MCP 请求；已启动逻辑操作和未领取结果另行计数。首次原工具调用和查询都只拥有各自 activity，并在 handler 结束后结算。一旦 operation 进入 queued / waiting / result-ready，就必须阻止最终完成，直到公共结果已经交付或 operation 明确退休。查询只增加和结算自身 activity，不重复修改原生工具批次数或完成次数。

结果只在当前存活任务的 Broker 内保留，不新增结果落盘。必须为 operation 记录、查询等待者、finalizer 上下文和累计缓存配置内部有界资源策略，拒绝新增工作时不得驱逐或重执行仍被持有的已启动操作。实现者可以选择内部上限，但必须给出常量、超限语义和测试；不能采用无界增长或静默丢弃结果。结果过大或确已不可用时明确报告，不重新执行以“恢复结果”。per-capability 递增计数器本身只需一个有界整数状态，不需要维护未使用 ID 的对象。

## 5. 浏览器存活与失联清理

### 5.1 不能只改 MCP 超时

当前浏览器代码会在距最后工具进展超过 `10 * 60_000 ms` 后停止抑制 DOM 停滞检查。原生输入等待可能没有新 tool batch 或 tool result，因此一次开始记录不足以支持长等待。

新设计需要单独的“已验证等待活动”。它由 Broker 根据当前任务的已接受操作和经过授权的查询产生，不能来自模型填写的时间戳、页面文字、普通 SSE 心跳或一个永不失效的布尔值。

### 5.2 等待租约

只有首次原工具请求被 Broker 接受并进入 queued 后，才建立 `120_000 ms` 的等待租约。后续对该 operation 的有效启动重试或查询续租。查询每次最多等 30 秒，租约因此可跨多个查询持续存在。120 秒决定“多久没有有效查询后可以清理仍未完成的等待”，是本地失联预算，与源码注释中的上游时限不是同一概念。

有效租约和未完成操作可以抑制“没有文本变化”“缺少完成按钮”“暂时缺少 response DOM”等基于静默的结论。经过 10 分钟或更久且仍正常续租时，不得因为最初 tool batch 的时间戳过旧而结束任务。

等待活动的更新必须通过独立于当前 Responses round 的路径到达 Adapter 和浏览器 helper。实现可采用订阅或等价的有界观察，但不能依赖 Native 工具返回后才刷新。更新可以推进状态版本，不得增加 `lastToolBatchRevision`、伪造新工具边界或把 `activeToolCalls` 加一。

等待租约不能覆盖明确的用户取消、页面关闭、ChatGPT 明确终止、helper/owner 丢失或已配置的任务期限。普通心跳不能给已经失去消费者的请求无限续命。租约过期后进入明确的等待通道失联状态并清理当前任务；仍被接受的原生调用不能在另一个任务中重放。

在服务端远程部署中，等待租约还承担一个窄的跨规格作用：有效租约可以暂停该 native turn 的 600 秒 idle **终止动作**，但不能更新 remote idle 的“最后真实业务进展”时间，也不能改变什么算文本/推理、工具产生、工具结果或 compaction 真实推进。等待租约结束后，remote idle 按未被修改的业务进展时间恢复；若阈值已经越过，清理可以立即发生。只有 Broker 已接受 operation 后产生的合法启动重试或查询可以维持此暂停；adapter/browser/helper heartbeat、TCP 存活和普通 Responses continuation 都不能替代 operation 等待租约。

人工输入没有桥接层总倒计时，但查询消费者必须继续续租。该设计依赖 ChatGPT 能持续调用查询工具，不能承诺服务已停止时仍能无限等待。模型长时间不查询、账户限制和上下文消耗是需要在真实链路评估的风险。

### 5.3 恢复普通检查

原 operation 的公共结果已领取且没有其他等待操作时，结束等待租约。DOM 普通宽限期从恢复观察时重新计算，不能把合法等待期间累计为停滞时间。

保留既有 Launcher 所有者心跳、真实页面终止和任务取消机制。时钟和系统挂起应沿用已有挂起处理原则，不能因进程被系统暂停而立即将健康等待误判为失联。无有效等待证据的旧 snapshot 仍受现有新鲜度检查约束。

## 6. 取消、上下文压缩与错误语义

单次查询超时正常返回 pending，不执行 `release` / `revoke`。单次查询消费者中止时清理该查询等待者；它不自动等同于 Native 用户取消，逻辑操作在有效租约和所有权下继续存在。

用户通过现有 Codex Interrupt 或 Launcher 关闭当前任务时，仍精确撤销对应任务的权限和操作。清理 pending、等待者、活动及缓存，并拒绝迟到结果。关闭一个任务不得取消并行的其他任务。对已发生的外部副作用不承诺撤销；没有原生停止确认时不得声称进程已经被杀死。

Broker / 所有者进程丢失后，内存状态不可恢复；新任务不得接管旧 operation。合法等待不阻止真实退出处理，也不允许孤立操作永久存活。

上下文压缩不得把 pending 当成工具结果或最终答案。若压缩时存在待完成 operation，必须按第 4.1 节的 capability epoch 转换表处理：仍在 `queuedCallIds` 的 queued 调用继续允许现有压缩控制接管；已经完成 Broker→Adapter handoff 的 waiting / result-ready 调用继续由原 capability 接收真实结果。这里不得把“waiting”表述成已经实际 emit 给 Native。operation 可以在同一 capability epoch 的 compaction 前后继续有效，但不得静默转移到新 capability。真实集成测试必须证明不会出现“等待压缩结束才能取结果、压缩又等待该结果”的循环依赖。若需要改变当前压缩协议，暂停这一分支并修订 Spec，而不是隐含扩大本任务。

上一段只适用于保留同一 owner 的 retained handoff。`experimentalFreshConversationPerTurn` 的 configured fresh compaction，以及 delegated source identity 无法精确证明时的 fresh fallback，当前合同都会先显式退役旧 browser/tool owner；这些路径必须同步把属于旧 owner 的未结束 operation 转为 retired，并给调用方保留可识别的终止类别。fresh owner 不得接管旧 operation，也不得为了“继续等待”自动重放原来可能有副作用的 Native 调用。这个 retirement 是真实 owner 终止条件，不得描述成普通 browser epoch 变化。

错误至少区分：原生工具真实错误、原生期限到达、显式取消、等待租约失联、基础设施失败、未知/过期 operation、operation 启动描述冲突和结果不可用。最终错误码名称尚未固定；实现阶段必须冻结命名并覆盖两种模式。v0.2 的 `codex_tool_start_ambiguous` 不再属于当前合同，因为调用方在 Native 副作用发生前已经为原工具调用分配并持有稳定的 `operation_id`。

正常 pending 不再报 `codex_tool_timeout`。有明确原因的错误不能只被 `submittedTurnFailure()` 改写为通用的“ChatGPT stopped responding”。保留安全的原因类别与工具名，不把底层可能含用户内容的异常文本直接透传。

日志只保留关联 ID 的安全表示、工具名、状态、经过时间及原因类别；不记录输入答案、审批内容、完整工具参数、结果正文、授权 token 或 binding 凭据。

## 7. MCP 合同、旧组件与使用说明

短调用保留现有**结果格式**，但可能创建 Native operation 的桥接入口请求 schema 增加必填 `operation_id`；同时新增 pending 回执及固定 `codex_tool_wait`。不新增 `codex_tool_begin`。`codex_tool_call` 中现有 `codex.control.compaction_handoff` 控制分支不创建 Native operation，因此保持无 `operation_id` 的显式例外。Automatic 和 Zero Risk 均须更新固定工具列表、桥接保留名称、过滤规则、结果观察以及给 ChatGPT 的使用说明。`codex_tool_wait` 是桥接控制工具，不能被当成外部 Native 工具再经过 gateway 递归调用；compaction control 也不能借此获得普通 Native 能力。

工具说明必须让 ChatGPT/connector 知道：在当前 capability 内，每个新的 Native-capable 逻辑操作先分配下一个递增的正整数 `operation_id`，然后直接调用原入口；pending 不是最终结果；查询和启动重试继续使用同一个 ID；新的逻辑调用必须使用新的 ID。不要重复发问，也不要因若干次 pending 自动结束任务。不能每次查询都向用户输出一段相同的进度文字。

旧 connector 工具列表可能被缓存。启用新等待协议前，必须确认 `codex_tool_wait`、原入口的 `operation_id` schema、per-capability ID 分配能力以及相应 helper 协议同时可用；缺失或版本不匹配时，必须在 Native 调度前提供明确的升级或刷新提示。可以先执行无副作用的 capability 检查，但不能先执行具有副作用的 Native 操作再发现无法续接。不能假定只更新工具列表哈希就完成用户端迁移。

能力协商可以复用仓库的版本/feature 机制，具体命名由实现者给出；旧新组件不匹配时不得静默退回“人工等待 90 秒就撤销任务”。本轮不升级正在运行的用户环境，也不修改已存在任务的合同。

## 8. 验收与证据关口

### 8.1 进入产品实现前的技术验证

先用受控原型验证真实调用拓扑：调用方/connector 必须能在第一次 Native-capable 原工具调用发出前分配 `operation_id`，并完成 `带 operation_id 的原入口 → codex_tool_wait`。Native 原调用不返回时，查询必须能经 MCP 直接访问同一 Broker。测试中短调用只发生一次原工具调用；第一次启动只分配一次 Native call；查询和同 operation_id 的启动重试都不触发新的外层 Native 调度；用户最终回答必须回到同一 operation。

必须验证真实 ChatGPT/Tunnel 的回执与后续工具调用行为，尤其验证“服务端 stdio 已写出响应、但调用方没有取得首次 pending/真实结果”的恢复路径：调用方仍能从原启动调用保留的 `operation_id` 重试或查询，同一 Native call 实际执行一次。还要验证 MCP/Tunnel reconnect 不会让同一存活 capability 的 operation_id 分配状态重置；不同 capability 可以安全复用相同的数值 ID。纯 Broker 单测、DEV 的模拟 `request_user_input`、看到心跳或把期限缩短后的 timeout 测试，都不能替代这一证据。原型应使用隔离的无害测试任务，不能为演示而重复运行用户的有副作用操作。

2026-09-24 已通过独立 DEV 装置执行真实 ChatGPT + Tunnel 的 45 秒模拟 Native 等待：首次调用携带 `operation_id`、30 秒窗口返回 pending、后续 wait 取得结果；同 ID 同参数重试复用原 call，新 ID 创建新 call。证据见 [prototype.md](prototype.md)。首次回执丢失、MCP/Tunnel reconnect、11 分钟人工输入和远程 idle 暂停尚未验证，因此本设计仍不能进入实施基线。

### 8.2 自动化验收矩阵

| 编号 | 场景 | 必须验证的结果 |
| --- | --- | --- |
| A0 | per-capability operation_id 分配、并发分配、reconnect、新 capability | 新逻辑调用得到唯一递增正整数；并发分配不重复；同一 capability reconnect 后不重置；新的 capability 可以重新从 1 开始；数值 ID 本身不是授权凭据 |
| A1 | 带 operation_id 的短调用在 30 秒内完成 | 只发生一次原工具调用和一次 Native 执行；保持原公共结果及字段，不产生多余 pending；不需要额外 begin 控制调用 |
| A2 | 调用等待越过 30 秒、90 秒和 120 秒，查询持续续租 | 返回 pending；同一 Native call 与 binding 保留；不触发正常等待的撤销 |
| A3 | 人工输入/审批保持 pending 超过 10 分钟 | 健康等待证据持续同步；没有静默 DOM 误判；界面只创建一次；远程部署开启 600 秒 idle 时，有效 120 秒 Native 等待租约暂停 idle 终止但不更新真实业务进展时间 |
| A4 | 多次 pending 后收到答案或审批拒绝 | 原结果完整返回；同一任务按真实结果继续；不代填或代批 |
| A5 | Native 阻塞且没有新的 Responses 请求 | 固定查询入口仍能响应；Native 调度次数保持为一 |
| A6 | 结果与等待期满同时发生、查询回执丢失后重读、Responses 重连 | 状态可确定；结果可取；保持同一操作与 call ID；无重复执行、丢失或双重结算 |
| A6a | 调用方已在启动前持有 operation_id；Broker 接受启动后，首次 pending/真实结果回执在调用方收到前丢失 | 重试原入口时复用同一 operation_id 并附着到同一 operation；也可查询同一 operation；Native 实际执行次数为一，不依赖 stdio send 成功判断 |
| A6b | 同一 operation_id 重复启动：一次参数相同、一次参数不同；另用新 operation_id 启动相同参数 | 相同描述重试复用同一 call；不同描述以 operation conflict 拒绝且不执行；新 operation_id 的相同参数作为独立新调用执行 |
| A6c | 首次请求到达 Broker 后被确定性准入拒绝，拒绝回执丢失；随后分别以同描述和不同描述复用同一 operation_id | 同描述稳定重放原拒绝且不重新按新 registry 准入；不同描述返回 operation conflict 且不覆盖原拒绝；修正后的新逻辑尝试只能使用新 ID；Native 执行次数保持为零 |
| A7 | 多模态、structuredContent、isError、_meta、空回答 | 最终结果不变；Native 内容中的 pending 字段不成为桥接控制 |
| A8 | 并行批次及 gateway 中多个子调用 | 原批次交付约束不变；每个 operation 归属正确；查询不生成新批次 |
| A9 | 操作未完成或 result-ready 时提交最终完成 | Automatic fence 和 Zero Risk complete 都拒绝；公共结果领取后可正常完成 |
| A10 | 一次查询中止，后续查询在有效租约内恢复 | 等待者无泄漏；原操作没有被该次中止误杀或重执行 |
| A11 | 原生工具自身超时、用户取消、停止思考、页面关闭 | 保留真实终止语义；只清理目标任务；迟到结果被拒绝 |
| A12 | 查询长期消失、Broker/helper 退出、时钟跳变和系统挂起 | 失联清理有明确依据；普通心跳不无限续租；挂起不被误作直接取消 |
| A13 | 跨任务或旧 capability epoch 查询、重启后使用旧 operation_id | 拒绝并且无信息泄漏，无自动重放；browser/Responses/MCP epoch 变化本身不得被误判为 capability epoch 变化；新 capability 复用相同数值 ID 不发生串线 |
| A14 | retained compaction 分别发生在 queued、`nextToolBatch()` 已 handoff 但 `emitToolBatch()` 尚未发生、以及实际 Native 等待期间 | queued 保持现有压缩接管；从 `queuedCallIds` 移入 `deliveredCallIds` 后即按 waiting 处理并继续收真实结果，即使尚未 emit；新 capability 不接管旧 operation；无循环等待、无重复执行 |
| A14a | 需要 Native gateway 的 `codex_tool_inventory` 已返回 pending，但其 operation 仍 queued 时 retained compaction 接管；随后用同 ID wait / retry | 缓存并重放同一桥接压缩控制终态；inventory Native finalizer 不解析该控制结果；Native/gateway 不执行，压缩接管不重复结算，operation 不永久 pending；控制结果交付后不再阻止完成 |
| A15 | 旧 connector / helper 缺少新合同 | 在有副作用的 Native 调度前明确拒绝，并给出兼容处理路径 |
| A16 | operation 记录、并行查询数、finalizer context 和缓存达到上限 | 内存和等待者有界；拒绝新增工作时已启动操作不被静默丢弃或重执行；递增计数器不要求为未使用 ID 建立对象 |
| A17 | 错误与日志 | 显示真正类别；无用户内容或凭据泄漏；pending 不产生通用失败 |
| A18 | `codex_tool_inventory` 需要 Native gateway 且超过 30 秒才完成 | 首次返回 pending；wait 最终返回与当前 inventory 一致的 `tools/total/next_offset/discovery_tools?`、分页、schema 与安全错误；过滤查询最终零命中时保留 `tool_search` discovery 信息且不计入 total/分页；结果重放不再次调用 gateway，raw gateway 结果不泄漏 |
| A19 | operation_id 已分配但首次请求尚未到达 Broker 时 registry 删除工具；确定性拒绝后 registry 再变化；准入后删除工具；同 ID 重试时 schema 或 direct/gateway 路由变化 | 本地 ID 分配不冻结旧权限；首次到达按当前 registry 拒绝且不创建 Native call/不退休任务；确定性准入拒绝只对同一启动请求描述稳定重放，不因后续 registry 变化重新准入；不同描述仍 conflict，修正请求使用新 ID；已准入 operation 的合法 retry/wait/result replay 不重新准入；`registryGeneration` 不被当成 capability epoch |
| A20 | `codex.control.compaction_handoff` 与普通 `codex_tool_call` 并行覆盖 | checkpoint 控制调用无需 operation_id 且仍可提交；普通 Native 调用缺少合法 operation identity 时拒绝；`control_*` token 不能 claim 普通 turn capability |
| A21 | configured fresh compaction 和 delegated source identity mismatch fresh fallback 发生在旧 owner 有 queued/waiting/result-ready operation 时 | 旧 owner 先按现有合同退役；其未结束 operation 进入 retired 并拒绝迟到写入；fresh owner 不接管、不自动重执行；retained handoff 的既有 Broker 分界不受影响 |
| A22 | 远程 idle 使用缩短的可控阈值并跨越该阈值等待 Native | 普通 heartbeat/TCP/continuation 不能续租 remote idle；有效 Native 等待租约可以暂停终止动作但不改变 last real progress；停止合法查询使 120 秒租约失效后，若原 idle 已越阈值则立即按 `client_turn_idle_timeout` 等价路径清理；真实工具结果仍按远程规格作为业务进展续租 |

测试使用可控时钟和延迟结果覆盖边界，不让所有自动测试真实睡眠十分钟。需要另外做真实链路验证以覆盖客户端、MCP 及浏览器行为。

### 8.3 真实链路验收

Automatic 和 Zero Risk 各执行一次隔离的用户输入场景：在第一次原工具调用发出前分配 operation_id，再保留同一输入框至少 11 分钟，期间确认查询持续、Native 调用只发生一次；提交答案后确认 ChatGPT 收到真实答案并继续。至少这两次场景都必须在服务端远程部署默认 600 秒 native turn idle 已启用的条件下完成，并记录 remote idle 没有被 wait 伪续租、而是因有效 Native 等待租约暂停终止。另测显式取消、一个非交互长调用、一次受控的首次结果回执丢失恢复，以及一次同 capability 的 MCP/Tunnel reconnect 后继续使用后续递增 ID。

11 分钟只是超过已有 10 分钟保护的验收样本，不是新的等待上限，也不证明上游永不终止。记录真实模式、组件版本、匿名关联信息及状态顺序；不保存输入正文或凭据。

涉及的现有测试入口为 [harness](../../../tests/chatgpt-web-harness.test.ts)、[browser contract](../../../tests/browser-worker-contract.test.ts)、[broker lifecycle](../../../tests/turn-broker-lifecycle.test.ts)、[broker regression](../../../tests/turn-broker-regression.test.ts)、[Zero Risk](../../../tests/zero-risk-adapter.test.ts)、[helper](../../../tests/launcher-helper-client.test.ts) 和 [retained compaction](../../../tests/retained-compaction.test.ts)。实现后还须运行相关类型检查及受影响的 Launcher 测试。

## 9. 修改边界与实施自由

| 模块 | 需要承担的责任 |
| --- | --- |
| [mcp-server.ts](../../../src/adapters/chatgpt-web/mcp-server.ts) | 新等待协议的 operation_id / wait 公共合同、有界执行回执、控制回执、真实错误分类、模式校验及固定结果合同选择；不新增 begin 工具 |
| [turn-broker.ts](../../../src/adapters/chatgpt-web/turn-broker.ts) | `(capability, operation_id)` operation 表、不可变启动描述、一次 handoff / call ID、查询与公共结果缓存、固定 finalizer 上下文、授权、租约、完成屏障与清理 |
| [index.ts](../../../src/adapters/chatgpt-web/index.ts)、[turn-execution.ts](../../../src/adapters/chatgpt-web/turn-execution.ts) | 保持真实结果与 Native round；明确 Broker→Adapter handoff 与实际 emit 的差异；在 round 之外观察等待状态；保留错误原因与精确取消 |
| [turn-progress.ts](../../../src/adapters/chatgpt-web/turn-progress.ts)、[browser-worker.ts](../../../src/adapters/chatgpt-web/browser-worker.ts) | 区分真实工具进展和等待存活；正确暂停并恢复 DOM 停滞判断 |
| [launcher-helper-client.ts](../../../src/adapters/chatgpt-web/launcher-helper-client.ts)、[browser-helper-main.ts](../../../src/adapters/chatgpt-web/browser-helper-main.ts) | 传输等待证据并验证协议兼容，不靠旧快照永远保持活跃 |
| [prompt.ts](../../../src/adapters/chatgpt-web/prompt.ts)、[mcp-observation.ts](../../../src/adapters/chatgpt-web/mcp-observation.ts) 及合同测试 | 暴露 per-capability operation_id 分配与 start→wait 规则、保留名称与控制结果识别；更新工具列表和新等待协议兼容证据 |
| [native-turn-idle.ts](../../../src/native-turn-idle.ts)、[server.ts](../../../src/server.ts) | 远程 idle 继续只由真实业务进展刷新；新增对 Broker 已验证 Native 等待租约的终止暂停/恢复联动，租约失效后按原 last-progress 时间精确清理 |

这是责任边界，不是要求对每个文件都做修改。可以选择内部类型、计时器注入、状态容器和推送机制；不新增通用任务队列、跨重启持久化、输入 UI、自动审批或等待时间设置面板。不能减少上述用户行为、安全和验收要求来换取实现方便。

不修改或吸收工作区已有的 `docs/dev/request-context-navigation/`。若后续两项任务同时改动真实结果通道，需按各自当前规格做集成核对，不能以本稿默默覆盖另一项需求。

## 10. 来源、核对状态与剩余证据

来源基线、用户原话和已执行命令见 [需求对齐记录的 E1—E17](decisions.md#项目事实与已取得证据)。源码中“Tunnel 约两分钟截止”的注释仅是历史设计依据，当前精确上游限制尚未独立验证。

v0.1 首次引入 pending 查询合同、等待租约与结果保留方向，同时补入 10 分钟 DOM 保护和外层 Native 阻塞两项设计约束。v0.2 增加启动歧义 fail-closed、capability epoch / retained compaction 说明，并把 `30_000 ms` / `120_000 ms` 纳入用户确认面。v0.3 用“先 begin、再启动”的稳定 operation identity 替代不可端到端证明的 `start-ambiguous` 判断；把 compaction 权威边界明确为当前 Broker handoff；并为 inventory 增加可跨 handler 生命周期重放的固定结果 finalizer 合同。v0.4 将随后逐项确认的决策写成当前规范，并明确保留协议版本号、错误码命名、内部状态类型、资源上限和 finalizer 放置位置等实现自由。v0.5 吸收当前 6.0.1-1 基线的独立复审：补齐 remote idle 暂停规则、`discovery_tools`、动态 registry 准入边界、compaction control 例外，以及 fresh/fallback owner retirement。v0.6 删除额外 begin/prepared 阶段，改为调用方/connector 在每个 capability 内递增分配 operation_id，并由原工具第一次调用直接建立 Broker operation。v0.7 根据 v0.6 独立复审和后续确认，补齐 queued compaction 接管后的可重放桥接控制终态，以及确定性准入拒绝占用 ID、同描述重放与不同描述 conflict 的统一 identity 规则。

v0.2 已完成独立 Spec Review：阈值人审缺口已关闭，同时发现“首次回执缺少稳定启动身份”和“Broker handoff / Native emit 边界混淆”两个实施 blocker，并新增 inventory 后处理续接一个 Major。v0.3 针对这些问题完成第二轮有界修订。随后决策访谈已确认 v0.4 所列的产品与协议行为。2026-09-23 的 v0.4 独立复审进一步发现 R1—R5；这些问题在 v0.5 中修订。随后用户进一步确认用 per-capability 递增数字 ID 直接随原工具调用，形成 v0.6。2026-09-23 的 v0.6 独立复审又指出 queued compaction 终态续接和拒绝 ID 冲突语义两个缺口；v0.7 按用户确认的修复方向关闭文档缺口。当前没有实现正式新合同或产品构建；45 秒 DEV 真实链路原型已执行，剩余技术验证和 v0.7 独立规格复审仍未完成。

进入正式实施基线前，必须通过第 8.1 节的真实 ChatGPT + Tunnel 调用拓扑、per-capability ID 在 reconnect/首次回执丢失时的稳定性验证和默认 600 秒远程 idle 开启条件下的 11 分钟等待验收，并完成 v0.7 独立规格复审。若真实链路不能在首次原工具调用前稳定附带 operation_id、不能在首次回执丢失后继续保留原 operation identity，或无法在不伪造业务进展的前提下让有效 Native 等待租约暂停远程 idle 终止，应停止对应方案并重新打开等待机制分支；不得静默退回超时终止、参数猜测去重或重复执行。只有在这些证据关口通过后，才将本稿升级为实施基线。
