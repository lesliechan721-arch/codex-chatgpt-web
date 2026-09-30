# 连续性最小校验：精确设计

2026-09-30 第三版更新：本附件第 3.1、4、5.2 节已由 [当前工作规格](current-work-validation.md) 按明确范围替代，第 7—8 节验收按该规格收缩。最新实施与验证见 [第三版记录](current-work-build.md)。以下累计第 10 轮和未修复问题属于本附件的历史基线，不是当前第三版结论。

版本：0.1。日期：2026-09-29。状态更新：2026-09-30。当前 workspace 已落地 S1-S3 实现，以及 S4 的本地自动化回归和文档同步。既有 9 轮授权额度已使用；用户再追加 1 轮，本轮已使用，当前累计第 10 轮。本轮处理 checkpoint 前旧 user 历史误阻断续接、缓存 compact 重放的 source 证据无界增长两项问题，并保留首次过渡及缓存重试的 source 负载检查。14 项新增回归通过；相关专项 71 pass，17 个文件集成验证合计 844 pass / 1 Windows-only skip / 0 fail，typecheck 和 diff 检查通过。新的两轴独立全面复审已完成，前轮两项均关闭；新增两项 P2 尚未修复，当前范围未通过。真实 Codex 客户端和 ChatGPT 页面链路验证仍未完成。未提交、未推送。

本轮独立复审新增的两项问题及关闭条件：

- **P2：同一 native turn 的不同 source 提交相同摘要后，第二个 source 的合法 checkpoint-only 续接被拒绝。** [恢复记录](../../../src/adapters/chatgpt-web/compaction-continuation.ts) 保留第一次 source，[指令定位](../../../src/adapters/chatgpt-web/environment.ts) 越过 checkpoint 前的第二 source 并返回第一次身份。隔离探针使用不同原生 ID、相同正文和摘要，两次活动压缩均提交至 revision 2；明确保留第二 source 的续接在两模式中均被拒绝，没有新增提交。只将第二摘要改为不同内容，两模式均合法同页续接。关闭条件：结合第二 source ID 与已有有界提交关系完成一次续接；旧请求仍受自身记录约束，真正没有区分信息的输入仍停止，缓存重放不得扩大证据集合。
- **P2：活动执行的缓存 ordinary round 重放跳过当前工具 registry 更新。** [Adapter](../../../src/adapters/chatgpt-web/index.ts) 在已完成 round 重放返回后才更新 registry。隔离探针覆盖两模式及旧历史不变/仅改旧 assistant 共 4 个组合：当前工具声明清空后仍成功重放，随后被删除的工具取得不同于原 outstanding 的新 call ID 并进入 Broker 队列；页面提交次数仍为 1，未执行 Native 命令。原样 input 的早退缺口已存在于基线；本范围新兼容的旧历史改写也稳定进入该路径。关闭条件：当前活动执行在合法重连重放前更新 registry，删除工具后的新调用拒绝，原已准入调用仍可完成一次；较早执行的只读重放不得修改后续 owner。

本轮修复依据：第 9 轮独立复审发现的以下两项问题。当前修改、本地回归及第 10 轮两轴独立全面复审均支持关闭这些原问题。

- **P2：checkpoint-only 续接把 checkpoint 前的已完成 user 历史误认为当前指令。** [指令选择](../../../src/adapters/chatgpt-web/environment.ts) 越过已提交 checkpoint 及 retained source，继续扫描旧 user；无 ID/turn 时报当前身份缺失，仅有展示 ID 时选错当前指令。Automatic/Zero Risk、source 保留/本地恢复、旧 user 无身份/仅展示 ID 共 8 个隔离案例均在提交前拒绝；只删除旧前缀，同一 source、摘要和 revision 立即合法续接。关闭条件：这 8 个组合通过，旧历史不参与当前身份选择；同时保留显式当前约束，真正无法定位的新指令及歧义过渡仍拒绝。
- **P2：缓存 compact 重放无界扩展 source 比较集合，绕过 checkpoint 证据预算。** [HTTP 成功回调](../../../src/server.ts) 每次重算 v1 source，[续接证据](../../../src/adapters/chatgpt-web/compaction-continuation.ts) 将其 hash 并入原集合，后续增长不经过容量或字节计量。隔离探针仅改写更早 user 历史，保持当前合法父代理指令不变；600 次缓存成功后，600 个 v1 source 表示均被认可，binding revision 和 checkpoint 条数仍各为 1，页面提交次数仍为 2。未观察到重复执行、OOM 或身份提权。关闭条件：已提交事务的 producer 表示集合保持有界，缓存重放不追加来自历史改写的比较证据；现有 codec 合法续接与容量合同保持有效。

本轮修复依据：第 8 轮复审发现的以下五项问题。当前修改、本地回归及第 9 轮两轴独立全面复审均支持关闭这些原问题。

- 位于前驱/checkpoint 之前、明确属于当前 turn 的 system/developer 被遗漏，修改后重放也不报冲突。需求轴评为 P1，工程轴评为 P2，实证一致。须完整保留当前指令层级并比较已接受负载；歧义时在提交前拒绝。
- 当前 Native 分组消息中的 AGENTS 等指令与 environment_context 同级时，只重建环境 XML，遗漏同组指令；改写后仍可重放。工程轴 P2。须保留当前分组的指令、附件、角色和顺序，并纳入负载比较，环境权限合同不变。
- verified 首次 checkpoint 续接中，结构化 source 仅重排对象键顺序也被拒绝。需求轴 P2。须采用一致的确定性结构比较，同时保留字符串、类型、数组顺序和 source 身份的冲突检查及 delegated 原合同。
- 首次 checkpoint 过渡中，同 source ID/turn/正文的 user 与合法父代理 agent_message 可互换并获准。需求轴 P2。须核对本地接受的原生角色及 author/recipient；封装冲突在新提交或 capability 建立前拒绝，合法新指令仍用新身份。
- 当前批次收齐后遇任意 tool-call 回显便停止，导致回显之前的同批重复结果被忽略。需求轴 P2；未观察到重复工具执行。无归属回显不能证明批次边界，当前组重复/未知/错误类型须在结果交付前统一拒绝。

本文是 [主规格](spec.md) v0.5 的规范性附件，完整定义本次校验收缩。主规格负责产品范围、生命周期、预算和压缩终态；本文负责当前工作识别、增量选择和幂等。正文与附件须一起审阅，不能只删除旧断言而不实现替代的请求识别。

## 1. 结果、范围和明确取舍

连续性模式信任通过既有监听与鉴权边界进入的 Codex 客户端所提供的原生任务和当前请求身份。桥接器以本地 thread 绑定、物理页面 lease、当前执行、工具批次和压缩事务维持连续性，不再证明客户端回传的整份历史逐项等于自身记录。

本次只修改 `chatgpt-web-continuity/` 的 Adapter 请求识别。Automatic 与 Zero Risk 使用相同的内容校验边界；`verified-environment` 和 `delegated` 保持各自现有权限合同。已有远程部署的认证、网络边界和 delegated 规则不变，不增加远程例外或第二套 strict/relaxed/off 配置。普通 `chatgpt-web/`、Native、API-Key 上游转发、Luna/Think、模型别名、账户与 effort 门槛不变。

**兼容性收益有边界。** 已完成历史的 JSON 对象键顺序、展示性 item ID、assistant 文本、输出回显及非执行元数据变化，不再单独阻断当前合法工作；但旧内容的修改不会同步修改已经存在的 ChatGPT 页面。桥接器不承诺发现未观察到的外部执行或重写过去。用户应通过新指令更正，或另开 thread 重写任务历史。不能把历史中的工具记录解释成新执行、当前权限或已交付结果。

**当前工作仍需可定位。** native thread/turn、正在使用的指令身份、当前结果的 `call_id`/类型、有效 capability、压缩 source 和必要 checkpoint 定位数据不属于可任意改写的历史装饰。它们缺失、冲突或无法唯一解释时明确失败，不猜测、不新建页面、不重做工具。重复摘要等确实不可区分的输入允许停止，不能以“放宽校验”宣称消除了信息缺失。

不新增公共 request ID、checkpoint token、摘要尾注、codec 版本或客户端配置。本稿保留局部摘要匹配用于定位已提交版本，不建立新的历史证明链。需要改变这些公共协议时须另行提出受影响设计，不能在实施中静默加入。

## 2. 保留和删除什么

| 对象 | 本次处理 | 判断依据与用途 |
| --- | --- | --- |
| scope / thread / owner / lease / head | 保留 | 可信路由与本地状态；保证同页、单写入者和任务隔离 |
| 首次进入的持久登记 | 保留 | 重启后阻止第二次创建；不是恢复凭据 |
| 当前 instruction identity | 保留小范围身份及负载检查 | 区分新指令、同轮 steering、当前请求重连和旧请求 |
| 完整 input 前缀逐项相等 | 从连续性准入条件移除 | 回传历史用于上下文、usage 和既有 Responses 展开，不再认证过去 |
| 客户端回显的 assistant / tool-call 输出 digest | 从连续性准入条件移除 | 输出内容与最终回答取桥接器已有结果；回显不授权工作 |
| HTTP round 的完整 input digest | 替换为第 3 节的局部工作键 | 历史元数据变化不创建新的执行或工具结果 round |
| checkpoint 前缀长度和完整位置 digest | 删除 | 不再要求摘要前的全部历史具有某个精确形状 |
| checkpoint 与已提交事务 / revision 的关系 | 保留 | 摘要仅帮助找版本；必须存在本地已提交关系及当前归属 |
| 当前工具结果关联和不可覆盖性 | 保留 | 只向本地已交付的调用交付一次真实结果 |
| Native operation 启动描述指纹 | 原样保留 | 同 capability / operation_id 不能换工具或参数；不以参数相同猜测新旧调用 |
| 页面 DOM 归属、完成屏障和控制 handoff | 原样保留 | 本次不改变浏览器观察或 Native 等待协议 |

哈希本身不是删除目标。不可逆 thread 索引、固定 scope、单条当前指令、当前结果负载和摘要定位可以使用哈希；也可直接比较规范化值。不得以更换哈希函数、增加忽略字段白名单或无条件吞掉异常替代上述语义变化。

## 3. 当前工作的最小身份

### 3.1 执行身份和负载

沿用现有 `environment.ts` 对原生指令、steering、环境和压缩恢复指令的分类，不将“最后一条 user 文本”直接当成新的人类指令。保留 thread、native turn、模型/provider scope、策略和经本地确认的 history revision。指令项使用现有合法 item-ID 映射；delegated source 的 item ID 不使用 rollout alias。

同一普通执行还必须绑定当前指令及其实际工作负载：当前指令内容、当前附件和会影响本次工作含义的请求选项。允许按现有输入 parser 对结构化对象做确定性规范化；字符串、附件内容/引用和数组顺序不得以“语义近似”折叠。路由后的模型、effort 等已由 scope 约束，不从任意 metadata 接受覆盖。

已接收身份的当前负载不可被重试替换。同一 native 指令 ID 携带不同的当前指令内容时拒绝，不能仅因内容哈希不同创建新执行。真正的新 steering 需要现有原生指令身份/谱系能够区分的新指令；没有足够 item identity 的路径只能接受可唯一定位的同 turn 工作，不能通过比较旧正文猜测新旧。首次接收前的输入预检失败不占用工作身份；首次准入之后的重试则复用已捕获的输入和创建事务。

既有权限校验独立运行。当前环境和工具 registry 仍按当前请求以及 verified/delegated 合同更新；尤其 delegated 的 registry generation 变化不等于新 execution 或新 capability。已准入 operation 不因 registry 随后变化被再次准入。本文不将完整 registry 序列化加入工作键。当前声明包括 request tools 和原生 additional_tools；discovery 只接受本地已准入完整结果批次中的工具定义。后续历史回显只能引用当前绑定已接受的 discovery 定义，不能增加或改写权限。实现只保留当前 discovery registry，随当前声明更新，并在绑定丢失或结束时释放；不新增逐批历史索引。

下列是语义组成，不要求新增同名公共字段或独立注册服务：

```text
execution = (trusted scope, native thread, native turn,
             accepted history revision, native instruction identity)
instruction payload = current instruction + current attachments + execution-relevant options

ordinary round = (execution, initial-or-checkpoint-continuation)
result round   = (execution, locally issued tool batch identity)
compact work   = (trusted scope, source execution, source history revision)
```

工作键与负载检查分开：键负责找到同一逻辑工作，负载检查防止该工作被换成另一件事。不能把新算出的负载 digest 直接当成一次新的副作用授权。键可继续用固定长度哈希编码，但不得包含完整 input、旧 assistant 内容、完整历史长度或 HTTP 的 stream/JSON 选择。

### 3.2 工具批次与 round 重放

工具批次身份来自桥接器已发出的批次，使用其 call-ID 集合或本地批次序号。后者必须与原 call-ID 集合一起保存在现有 execution journal 中，不增加客户端字段。一个批次内结果顺序可变化；按本地发出顺序归一化后处理。不同批次即使工具名和参数相同仍是不同工作。

结果入口先定位当前请求所携带的末端工具结果组，再用 call ID 找到本地批次。可跳过只作回显的 assistant/tool-call 项和已分类的环境项；不能让回显字段参与批次授权。末端结果所属批次确定后，只收集该批次成员，遇到更早批次、原生指令或 checkpoint 边界停止。该组不完整、重复、类型错误、混入未归属当前结果，或无法唯一确定末端批次时拒绝。不能把未知的末端结果误当成“没有结果的普通重连”。边界外的已完成历史不再逐项认证；跨越当前工作边界重排记录不在兼容保证内，不能唯一解释时停止。

先查该批次已有的 round journal，再交付结果。精确到局部身份及负载的重试复用正在运行的 round 或重放其已有输出，不再次调用 `completeTool`。较早批次的重试返回其较早 round，不能因为目前有更新的 outstanding 批次而改用新批次。无结果的原始 ordinary 请求重连仍重放该请求的 journal；若第一次交付尚未完整记入 journal，仍只能交付同一 outstanding call ID，不能分配新调用。

同一 execution 中的逻辑工作识别、批次全量验证、接受结果和 journal 更新必须由已有 `runExclusive` 串行化。不得让两个 HTTP 请求分别看见同一批次“尚未接受”并重复交付。浏览器/工具完成事件写 journal 后才向 HTTP observer 输出；JSON 和 SSE 共用相同逻辑结果，编码方式不构成第二份执行身份。

### 3.3 结果负载和历史内容的区别

当前结果必须属于原 capability 下已经通过 Broker queued/delivered 分界的调用，并具有相应 `function_call_output`、`custom_tool_call_output` 或 `tool_search_output` 类型。Native dispatch 的工具名、namespace、arguments/freeform input 以桥接器首次准入的调用为准；客户端回传的 tool-call 副本不再次驱动调用，也不作为其内容证明。

首次接受结果时保存其实际交付负载或有界的局部比较数据。相同批次重试若更改该结果，返回冲突且保留第一次已接受结果；不回滚外部副作用、不覆盖缓存、不分配第二个 call。这里只比较本次被重放的批次，不重新比较请求中所有历史结果。opaque 字符串不做 trim 或模糊归一化；结构化对象仅采用现有确定性规范化，协议类型和有意义内容必须保留。

先验证整个当前批次再开始交付。若部分 `completeTool` 已成功但后续基础设施失败，记录已经交付的成员，重连不能重复交付它们；不能确定交付状态时停止，不靠重新执行修复。此处理沿用现有 owner、Broker 和 journal，不另建跨进程事务服务。

### 3.4 历史与进展计数

可以保留最新已接收请求的规范历史快照，供完整 usage、`previous_response_id` 和诊断使用。快照不是网页内历史的认证副本，也不是本地执行结果的权威来源。已完成 round 的输出及 usage 保持其原 journal 结果；改变历史的重试不覆盖已完成响应，不产生新进展。

需要并发比较的 generation 只在实际准入新工作、接受新批次结果或提交 checkpoint 等本地因果变化时推进。HTTP 查询、重放、对象键重排、旧正文或来源元数据变化不能推进 generation、revision 或 24 小时成功工作时钟。当前 snapshot 的表达更新不得绕开压缩互斥，也不得把内容变化伪装成一次本地工具结果交付。

## 4. 普通续接和输入选择

首次选择的语义、完整初始输入预检、持久登记和创建前容量检查完全沿用主规格第 3 节。第一次准入捕获的初始 prompt 属于唯一创建事务；重试不因回传旧历史变化而重建或覆盖它。预检尚未成功的请求不消耗首次创建权。

已有绑定收到新的普通指令时，先确认同一健康 lease、当前 head 已物理收尾且无其它写入者，再根据原生当前指令位置选取本次明确的新输入、附件和当前合法执行环境。不使用旧 input 的长度、旧回答逐字相等或“最后一个 assistant”作为增量证明。现有 compiler 所需的当前 instructions、权限封装和工具说明仍按原方式提供，不能为减少校验而遗漏。

旧 user、assistant、agent_message、已完成 tool-call/result 和 checkpoint 均不作为新指令重发。真正属于当前轮的新原生父代理指令等仍按已有分类保留，不能简单丢弃所有 agent_message。无法区分新输入和历史时明确失败，不能退回全历史上传，也不能只发送最后一段文字冒充完整当前指令。

选定实际输入后再执行原 token、字符、附件和请求体边界；完整历史仍用于外层 usage。健康同页的小增量不能因旧历史超过网页窗口而被拒绝；过大的初始输入或当前增量仍拒绝，不启动 Bigger Context 或 fresh fallback。

客户端实质改写旧历史而当前身份仍完整时，新指令可以继续原页；桥接器不声称原页已吸收这些修改。已观察到的 mode exit 仍终止绑定，scope 改变仍拒绝。未观察到的外部执行不再由全文比对检测，但其历史记录绝不能向 Broker 增加 outstanding 调用或权限。

## 5. 压缩：保留提交关系，不证明历史位置

### 5.1 source 与唯一事务

只对当前绑定中的 source execution 压缩；source 的原生 thread/turn、指令身份、模型/effort、source revision 和活 owner/head 均须符合既有合同。`delegated` 保留 request-carried source turn、item ID、source content 的精确匹配，不允许 rollout alias、摘要正文或当前 compaction turn 冒充 source。`verified-environment` 保留已有合法恢复途径。source 指令本身是本次选择执行的必要数据，不属于本次取消检查的“任意旧历史”。

删除 `assertCompactionSourceHistory()` 的全历史内容相等要求，但保留本地 source generation 的前后比较。压缩请求带回原批次的真实结果时，先按第 3 节交回原调用并记录已经交付的成员，再捕获可用的 source generation。Broker 已交付但尚无结果的调用继续由原 capability 接收，不能等新 capability 接管，也不能把它们改成 queued 控制结果。

同一个 source execution / source revision 最多有一个已开始控制交付的压缩事务。local、v1、v2 的传输包装或旧历史元数据变化不创建第二次模型摘要；同 source 的冲突控制负载明确拒绝。可将同一已提交语义结果编码为各入口原有格式，格式编码不得再次运行摘要。原生请求身份与取消目标仍分别登记到该同一工作；HTTP observer 断开不是取消。

控制开始前，重新核对 source、generation、revision 和 lease，并原子取得原有压缩写入权。预检之后若本地接受了新结果或 head 变化，过期预检不得提交控制，也不得误退休较新的合法 owner。尚未交付任何控制且无副作用的预检失败可以在条件改变后重新预检；控制已交付或交付状态不明后，沿用主规格的唯一失败/提交结果，不能通过换请求键再发一次摘要。

成功顺序、accepted-but-uncommitted 证据、ready 确认、旧权限退休和普通 final 保留完全沿用主规格第 4 节。Zero Risk 的活动/已完成/控制送达前结束三个分支不变。

### 5.2 checkpoint 与 revision 选择

只保留“已提交事务 → source revision → 新 revision → 原页面 lease”的本地关系以及必要摘要定位数据。移除 `historyPositions`、前缀长度和前缀 digest。checkpoint 移到不同的合法历史位置或被相同内容重复回显，不再仅因前缀不同拒绝；但它也不能覆盖已有工作身份或授权摘要之前的历史重新执行。

接收续接时按以下顺序选择，不得无条件使用最新 `binding.revision`：

1. 确认现存绑定和物理归属；checkpoint 用既有 codec 解码，在该 scope/thread 内取得本地已提交版本候选。revision 0 只允许原首次登记的初始标记，不把初始历史中的摘要当成本模式提交。摘要匹配只是候选索引；多个候选尚不直接选最新版，也不直接认定失败。需要参与版本定位的摘要被改写或没有对应登记/提交时不推进版本。
2. 将版本候选、已登记的 source→continuation 关系，与 native 工作身份、已发批次和压缩事务共同用于查找已接受的逻辑 round。唯一命中旧工作只重放其原结果；回收记录命中则明确失败。不能仅凭 thread/turn 或源指令 ID 就认定是旧 ordinary 重试：同一 source 指令可能出现在合法的新 checkpoint 过渡中。既有 round 若属于新 revision，后续重连直接命中它。
3. 没有已接受续接 round、没有新指令而有明确的新 checkpoint 过渡时，必须由本地已提交 source→continuation 关系唯一定位。原 source 已完成 ordinary final 时重放该答案；活动压缩后的合法继续只消费该次过渡一次，开始当前 revision 的新 execution/capability，不重新提交旧工具或摘要。旧 source 的执行记录不能抢先覆盖这个经版本区分的新过渡。
4. 没有可重放的旧工作或已登记过渡时，当前版本的新指令必须有可区分的新原生指令身份；checkpoint 候选须包含当前已提交版本，且不得冒充已知旧工作或其回收记录。相同摘要可对应多个 revision：明确的新指令可在当前版本准入；已知旧指令仍受自身版本及第 2—3 步约束，不能借相同摘要复活。
5. 同一 native turn/指令在多个相同摘要版本间无法由已有事务/工作记录区分，或必要映射已过期时，返回确定性错误。不能用“最右摘要”“出现次数”或摘要前的全文哈希猜测意图；也不增加公共 token 作为本任务的隐式补救。

连续两次不同 source 的压缩即使产生相同摘要，也必须能分别提交和按各自 source 重放；不得把摘要作为唯一事务键。对于“相同 native 身份、相同摘要且无其它可区分信息”的输入，本稿保证不重复执行，不保证无条件继续。这项兼容边界必须随实现和用户说明一起保留。

## 6. 生命周期、容量与失败

继续使用既有 creating/running/ready/compacting/lost/ended 状态，不引入通用策略引擎或第二套会话存储。每个健康物理会话最多一个普通执行或压缩写入者；迟到清理按原 execution/lease 判断，不能关闭后续轮次的页面。

持久登记保留 10,000 条 / 4 MiB、不自动清理/修复、损坏和重启后不误建的合同。逻辑/物理 ready 保留 24 小时，五页上限、普通模式 30 分钟、HTTP 编解码 64/128 MiB、Responses 内存高水位 64 MiB、磁盘单条 2 MiB/总量 24 MiB 不变。checkpoint 证据保留现有 256 项、单项 2 MiB、总量 24 MiB 约束。

当前 head、必要 checkpoint 关系和未交付结果仍受保护。旧 ordinary execution 被回收时，继续使用现有每绑定 256 项 ordinary replay tombstone 记录阻止重新执行，不另外开无界 Map。

当前 `turn-execution.ts` 每 execution 的 round journal 上限为 512 项。新增批次索引和局部负载比较数据应随对应 journal 一起回收，不留下独立增长的历史索引；当前未交付批次继续受保护。旧结果 round 已回收后，末端 call 无可重放记录即明确失败，不能把未知末端结果降级为 ordinary 重连，也不能据它重新分配调用。这不要求另存无限的逐批 tombstone。source→continuation 关系计入既有 checkpoint 容量，局部比较数据计入其所属有界记录，不复制无限历史。

容量不够时沿用确定性拒绝，健康页不被淘汰；观察型查询不泄漏 admission 错误。不得悄悄提高容量，具体表示和保守字节计量由实施者按现有存储合同选择并测试；512 项是条数上限，不是已有独立字节上限的证据。

`previous_response_id` 缓存缺失仍返回 409。重发完整请求后，只有当前绑定和局部工作/revision 可确定才继续；不再要求历史正文与旧快照相等。普通旧结果可读取不等于允许新执行。压缩成功的重放仍须证明同运行 owner、同物理归属及提交关系；进程重启、丢页、模式退出后不把旧缓存当作新的成功或恢复许可。

沿用现有错误族与非自动重试规则：丢页/owner 丢失为 `continuity_session_lost`；身份、批次、当前负载或 revision 歧义可使用 `continuity_source_unproven` 并给出固定的具体原因；容量、输入、配置和 Zero Risk 交接仍用原类别。不得输出笼统“历史被篡改”，也不得记录 capability、完整历史、工具负载或为本次增加无关遥测。局部当前请求冲突通常只拒绝该请求，不取消仍合法的 owner；delegated source 不匹配和真实会话丢失的既有 retirement 例外保留。

升级不热迁移存活 execution/journal 到新身份算法。正常停止旧组件、保留持久首次登记；重启后的旧 thread 仍按原合同结束，由用户新建 thread。不得为“新工作键”重置登记或开放旧 thread 再创建。协议和 Launcher/helper 严格 lease 字段不变，不增加运行时发布门禁。

## 7. 修改落点和实施顺序

以下是本次实施落点和顺序。当前 workspace 中 S1-S3 已有实现；S4 的本地自动化回归和文档同步已完成。第 10 轮本地回归通过，两轴独立全面复审已完成，新增两项 P2 尚未修复，当前范围未通过。真实客户端兼容性验证未完成。共享文件较多，应按依赖顺序收敛，不按表格并行重写。

| 步骤 | 修改落点 | 可验证交付 |
| --- | --- | --- |
| S1：局部工作识别与重放 | `turn-execution.ts`、`continuity-request.ts`、必要的 `environment.ts` 原生指令定位，以及 `index.ts` 调用点 | ordinary/result/compact 键不依赖完整 input；相同负载只复用一次工作；当前冲突拒绝；旧批次 journal 可重放。先接入新识别，再移除旧准入判断 |
| S2：增量和结果准入 | `ordinaryResumeInput`、`checkpointResumeInput`、`currentToolResults`、结果交付/journal 边界 | 不依赖旧回答和前缀相等；实际新输入完整；已完成内容不重发；并行批次先全量检查、一次交付；旧模式不变 |
| S3：压缩和证据收缩 | `continuity-compaction.ts`、`continuity-binding.ts`、`compaction-continuation.ts`、必要的 Responses compaction 入口 | 删除完整位置证明；按本地 generation 处理竞态；三个入口复用同 source 事务；重复摘要及旧请求安全；不改变公开 codec |
| S4：回归和文档同步 | 现有 continuity/retained-compaction、HTTP/codec、Native wait 与 Launcher 测试；架构、安全、用户说明和发布验证 | 验收矩阵覆盖新旧边界；运行文档才描述实际行为；未运行的真实环境项继续明确记录 |

清理仅限本改动失去用途的内容：连续性 `canonicalInputDigests` / `canonicalInputGenerationByDigest`、完整输出比较及 `historyPositions` 等，不先假设共享 helper 没有旧模式调用者。Responses 历史展开、输出 journal、结构化响应验证、真实网页文本完整性检查和当前输入预检不属于要删除的历史认证。

优先复用当前类与互斥、Broker outstanding/delivered、checkpoint map 和 tombstone；内部函数名、局部类型及哈希编码可自主。不能省略工作身份、批次冲突处理、source CAS 或容量，不能增加新配置/服务/协议来回避本稿边界。

## 8. 验收矩阵

两种交互模式都覆盖适用场景；HTTP 的 JSON/SSE、Responses 全量与 previous-response 展开、local/v1/v2 压缩分别覆盖。测试必须同时统计网页新建/提交、原 call ID、实际 Native 执行和结果交付，不能只断言 HTTP 200。

| 场景 | 必须观察到的结果 |
| --- | --- |
| 已完成历史的对象键重排、展示 ID/status/annotations/来源元数据变化 | 当前工作仍正确定位；网页和 Native 执行不因重试增加；不需要新增字段白名单 |
| 已完成历史正文、旧工具回显变化，新指令完整 | 同页仅发送新指令/附件/当前环境；不把旧改写回灌，不凭旧记录交付结果 |
| 当前 thread/turn、scope、指令身份、当前负载缺失或冲突 | 在新提交/新结果交付前拒绝；不通过 changed digest 创建新执行；合法旧 owner 不被误伤 |
| 同 turn 两个真实 steering 指令；旧指令迟到 | 可区分的指令保持独立；活动写入者遵守原冲突规则；旧工作只重放/拒绝，不能再执行 |
| 普通重连改变历史元数据、JSON 与 SSE 交叉重试 | 同一 round journal；已有 commentary/final 不丢失、不重复网页提交 |
| 多轮工具，较早批次在后续批次开始后重试 | 返回原 round；不交付给后续批次，不重新调用 Native |
| round journal 跨越 512 项并回收旧结果 round | 批次索引和局部比较数据同步回收；旧末端结果明确失败，不被解释为 ordinary 请求或新调用；当前批次仍可完成 |
| 当前批次结果乱序、缺项、重复、未知末端 call、错误类型 | 乱序按本地集合正常处理；其余在批次交付前拒绝，不误作普通重连 |
| 同批次相同结果重试与不同结果重试 | 相同结果不再交付；不同结果冲突并保留第一次结果；部分基础设施失败不重复已交付成员 |
| 原工具 call 回显的 name/arguments/metadata 被改写 | 只以已准入调用和真实结果处理；不根据回显执行新命令；Native operation 同 ID 改参数仍冲突 |
| 首次大输入、首次并发、首次启动回执丢失 | 原预检和登记顺序有效；至多一个创建事务和页面；首次失败不被误判成可随意重建 |
| 历史很大而新输入很小；Responses cache 过期 | 单次预检只看真实输入；完整 usage 保留；cache 缺失 409，合法完整重发不依赖旧正文相等 |
| 三种压缩入口、旧历史表示变化、并发重试 | 同 source/revision 一个控制事务、一个摘要、一次提交；原返回格式保持 |
| 压缩请求带未交付的真实结果；preflight 后 source 进展 | 结果回原 call 且一次交付；过期 generation 不提交控制、不误取消新 owner；无循环等待 |
| checkpoint 前缀变化或重复回显，明确新指令在后 | 不靠前缀全文证明；同页只发送新工作，历史中的外部工具记录不能取得权限 |
| 连续两次不同 source 返回相同摘要 | 两个独立 revision 可提交；各自重试命中各自事务；新 native 指令可继续当前 revision |
| 相同摘要下旧 ordinary 重放已被 TTL/容量回收 | tombstone 保留旧身份；确定性拒绝，无第二次执行、页面不受损 |
| 同 native 身份的相同摘要缺少区分信息、摘要正文被改写 | 明确歧义/无法定位错误；不选最新版本猜测，不推进 revision |
| completed-source checkpoint-only 和 active-source checkpoint-only，保留相同 source 指令 ID | 先结合 checkpoint 版本区分原 source 与新过渡；前者重放普通 final，后者只消费已提交过渡一次并取新 capability；不被旧执行记录抢先截断，摘要不作为工作指令 |
| Zero Risk 完成、控制前结束、控制后失败 | 原三种终态保留；不新增消息/页面/剪贴板 prompt，不替换未提交历史 |
| 接受 handoff 后未物理收尾、提交后丢页/重启 | 不报告新的成功，不再生成摘要；保留证据但不恢复权限 |
| 并发、取消、失联、旧 token、mode exit、满额和 idle | 主规格及 Native wait/Launcher 原回归仍成立；查询和重放不续 24 小时 |
| 无关旧模式和动态 delegated registry | 旧恢复/fresh 行为不变；registry generation 不分裂既有 operation，当前工具仍按原权限准入 |

历史兼容性测试必须分别模拟含/不含来源元数据的请求，不把模拟字段称为真实 Codex 版本认证。实施时使用目标 Codex 的隔离 Responses 装置取得真实 round-trip 形态，至少验证 ordinary → tool result → compact → continue 和响应回执丢失重试；记录二进制、认证路径和三个 codec 的实际覆盖。先用假页面/无害工具验证，不使用生产任务重复测试副作用。

本次设计不要求重新制造百万历史或等待真实 24 小时才可修改代码，但也不把已有覆盖缺口标成通过。完整历史 parsing/usage 仍可能是线性成本；不承诺移除校验就消除所有长历史开销或给出未测量的加速数值。

## 9. 来源、现状和批准面

用户最初提出本地项目的历史指纹兼容性和复杂性问题，要求评估删除或最小化；上一轮建议保留本地绑定、当前身份和幂等，删除整份历史证明；随后用户明确要求按本方案实施，并指定 `dev-workflow:dev-build`。这构成当前 workspace 的实施授权，但不构成提交、推送、正式独立审查或真实客户端兼容性验证已经完成。长期取舍见 [D6](decisions.md#d6连续性校验收缩到当前工作与本地状态)。

设计核查基线为 Git `46fa491bbab92b27e5292d1670d661b94c16b416`。当前 workspace 已从连续性准入证明中移除完整 input 前缀相等、客户端回显 output digest 和 checkpoint `historyPositions`；同时保留当前 native instruction 身份/负载、本地工具批次与首次接受结果负载、source/revision/lease/generation 和已提交 checkpoint 关系等局部证明。主要事实入口为 [当前指令解析](../../../src/adapters/chatgpt-web/environment.ts)、[执行与 round](../../../src/adapters/chatgpt-web/turn-execution.ts)、[连续性请求](../../../src/adapters/chatgpt-web/continuity-request.ts)、[压缩驱动](../../../src/adapters/chatgpt-web/continuity-compaction.ts)、[绑定](../../../src/adapters/chatgpt-web/continuity-binding.ts) 和 [Adapter 结果交付](../../../src/adapters/chatgpt-web/index.ts)。

未改合同须共同读取：[安全模型](../../security-model.md) 的 Trust boundaries、Full-mode capability flow 与 Cross-turn data leakage；[delegated 规格](../delegated-tool-authority/spec.md) 的 Source turn；[Native 长等待规格](../native-tool-long-wait/spec.md) 的 operation identity、结果重放、queued/delivered 与取消。delegated 旧规格里的 fresh fallback 不覆盖连续性主规格已确定的禁止重建。

没有接受原型；已有本稿的 workspace 实现和本地自动化回归，但没有真实客户端兼容性验证。作者自查不能代替独立审查。完整确认面包括：不再认证旧历史的风险、当前身份和结果冲突仍拒绝、保留局部 checkpoint 匹配及其歧义停止边界、不新增公共协议/配置，以及所有未改产品合同。独立审查未通过或真实客户端验证未完成时，不将 v0.4 的旧审查结论沿用到本稿。
