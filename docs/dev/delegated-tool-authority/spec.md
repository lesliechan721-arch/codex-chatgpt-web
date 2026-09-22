# Delegated Tool Authority 调整 Spec

本规范是 [`server-remote-desktop/spec.md`](../server-remote-desktop/spec.md) 的后续调整。它定义 tool-capable ChatGPT Web 的可选 delegated authority 模式：server remote deployment 强制使用该模式，普通本地安装可以显式 opt in；其余 Phase 1 的网络、API Key、Launcher ownership、远程桌面、持久化、idle timeout 和单用户边界继续有效。

## 本次交付与审阅导航

目标是让 Codex 可以运行在另一台受信任机器上，而 Server 不需要访问该客户端的 `CODEX_HOME`、rollout、`state_5.sqlite` 或项目文件，同时继续支持 Automatic Full、Codex Native tools、Zero Risk、subagent 和正常 compaction。

本次确定两个 authority 模式：

- `verified-environment`：保持现有本地安装行为。Server 继续验证 Codex filesystem environment，并可使用本机 rollout 做当前已有的恢复和 replay 优化。
- `delegated`：Server 只验证当前 native turn 的 tool capability。filesystem、cwd、workspace、network、sandbox 和 approval 的最终 authority 全部属于 outer Codex。

普通本地安装默认继续使用 `verified-environment`。server remote deployment 必须强制使用 `delegated`。本地安装允许显式选择 `delegated`。

本规范的主要风险变化是：`delegated` 不再让 Server 对客户端 filesystem authority 做二次证明。对应的安全约束是，Server 在 capability 注册时把随机 bearer token 固定绑定到 native `thread_id + turn_id`，并为该 token 维护当前 request advertised tools 的 generation；token 后续不能被重绑定到其它 native turn。实际工具执行仍必须回到该 token 的 origin outer Codex channel，由 outer Codex 的 sandbox 和 approval 决定。

产品方向已经确认。本次修订进一步固定 tool registry generation、旧 invocation 存活边界和 exact retained-source execution identity。字段落盘位置、部署环境变量名称和内部类型拆分方式可以由实现者选择，但必须满足下文的模式、优先级和失败语义。

## Authority 模式与配置合同

### 结果与已确定选择

adapter/runtime 必须有一个显式的 authority 模式字段。规范语义如下：

```ts
type ToolAuthorityMode = "verified-environment" | "delegated";
```

`CodexProviderConfig.chatgptWeb` 应能表达这个模式。字段缺失时必须按 `verified-environment` 处理，以保持已有本地安装兼容性。

server remote deployment 是强制策略，不是普通默认值。部署级强制值优先于普通本地配置：

1. 普通本地安装未配置时，effective mode 为 `verified-environment`。
2. 普通本地安装可以显式设置 `delegated`。
3. server remote deployment 必须把 required mode 固定为 `delegated`。
4. server remote deployment 如果发现持久配置或其它显式配置要求 `verified-environment`，必须在启动或 provider 初始化时明确失败；不得静默回退，也不得继续提供一个依赖容器本机 rollout 的远程 `/v1`。
5. authority mode 在一个活动 native turn 中不得变化。实现可以要求重启 runtime 后才应用模式修改。

具体持久配置字段名和部署环境变量名可以由实现者选择。若增加环境变量，server Compose 中的值必须是固定的 `delegated`，不得作为可选的 `${...}` 用户覆盖项来削弱远程部署合同。

### 完整行为与边界

authority mode 只改变 tool-capable ChatGPT Web 路径的 authority 来源。browser-only / 没有 Native tools 的请求不因为选择 `delegated` 获得新的本地能力。

`verified-environment` 模式继续保留当前严格行为，包括：

- 当前 environment envelope 的解析和校验；
- 需要时从本机 Codex rollout 恢复 filesystem authority；
- 对 cwd、workspace roots、writable roots 和 sandbox policy 的一致性检查；
- 当前已有的 rollout message-id alias 和 source-turn replay 优化。

`delegated` 模式不得调用这些机制来授权工具，也不得因为这些本机证据缺失而阻塞一个合法的 tool-capable turn。

### 验收与实施自由

- 单元测试必须证明字段缺失时本地 effective mode 仍为 `verified-environment`。
- server deployment 测试必须证明 effective mode 始终为 `delegated`。
- server deployment 出现显式 `verified-environment` 冲突时必须失败，并给出可诊断错误。
- 本地显式 `delegated` 必须可以运行，不要求使用 server deployment。
- exact 配置字段名、配置文件层级和环境变量名属于实现自由；runtime 的两种模式语义不属于实现自由。

## Delegated turn capability

### 结果与已确定选择

`delegated` 不把 `ChatGptTurnEnvironment` 作为 broker capability。broker 需要的是当前 native turn 的 tool capability。

规范性数据模型可以等价表达为：

```ts
interface DelegatedTurnCapability {
  threadId: string;
  turnId: string;
  registryGeneration: number;
  tools: CodexTool[];
}
```

`parentThreadId`、`agentName`、`subagentKind` 等已有 lifecycle metadata 可以继续用于 session ownership、诊断、取消和 child 关联，但它们不是 filesystem authorization，也不能替代 `threadId + turnId`。

`registryGeneration` 是同一个 turn token 内 tool registry 的单调版本。首次注册建立初始 generation；每次原子替换当前 advertised tools 都必须前进到一个新的 generation。具体整数起点和字段名属于实现自由，但 generation 不得回退或被复用来表示不同 registry。

### 完整行为与边界

对于 Full、Automatic local tools 或 Zero Risk 的 `delegated` 请求：

1. 当前请求必须同时提供非空 `thread_id` 和 `turn_id`。
2. 任一字段缺失时，tool-capable turn 必须明确拒绝。不得静默降级到 browser-only，也不得使用 `prompt_cache_key`、turn-only、历史 environment 或 rollout 推断代替。
3. Server 为该 native turn 生成随机、不可预测的 opaque capability token。
4. token 是 bearer capability。token 一旦签发，就固定指向注册时的 `thread_id + turn_id`；同一个 token 不得被更新或重绑定成另一个 thread 或 turn。
5. 同一个 native turn 的 continuation/round 可以继续使用同一个 token，但每一轮必须原子替换 capability 中的当前 advertised tool registry，并推进该 token 的 `registryGeneration`。
6. MCP discovery / claim 只能得到某一 generation 的 registry snapshot。claim 本身不是 tool invocation 的正式准入，也不能冻结该 snapshot 的权限。
7. broker 在创建新的 `callId` 前，必须按**最新** generation 再校验请求的 `wireName`。如果 handler 使用旧 generation 的 claim，broker 必须重新按当前 registry 解析；工具已经删除时拒绝，仍存在时只能按当前 registry 的定义进入新的 invocation。旧 snapshot 不得重新开放已经删除或替换的 tool。
8. 成功通过该校验并由 broker 创建 `callId` 后，该 invocation 已正式准入。后续 registry generation 更新不得仅因为 tool 被删除或改变而取消这个既有 invocation。
9. `validateBatchTools()` 必须继续保留，并在将 batch 交给 outer Codex 前再次按当前 Responses request 的 `parsed.context.tools` 校验。broker 校验不能替代该检查。
10. tool registry 只能来自当前 request。历史请求、ChatGPT 文本、`environment_context`、rollout 和 Server admin/control capability 都不能增加可调用工具。

当某一后续 round 缩小工具集合时，“立即失效”只适用于 registry 更新之后的**新 discovery 和新 invoke**。已经正式准入并拥有 `callId` 的 invocation 必须继续允许 outer Codex 返回 result；`completeTool(callId)` 不得因为当前 generation 已删除该 tool 而再次按 registry 拒绝。turn token 被撤销/过期、turn 被取消、Zero Risk 进入独立终态等既有 lifecycle 规则仍可终止 pending invocation；tool registry 更新本身不能这样做。

Server 不从 MCP presenter 额外获得一个可独立认证的 caller `thread_id/turn_id`。因此 bearer token 本身就是调用授权：任何持有有效 token 的调用都只能进入该 token 已固定的 origin channel。token 泄漏在撤销或到期前等价于获得该 origin turn 的 capability；本规范不声称 broker 可以识别“当前 presenter 实际属于另一个 parent/child turn”。

### 精确规范与设计依据

当前 `TurnBroker` 把 `ChatGptTurnEnvironment` 同时当作 filesystem environment 和 tools 容器，并用 cwd/roots/sandbox identity 防止活动 loop 中 environment 变化。新实现应把这两个责任拆开：

- `verified-environment` 可以继续使用 filesystem environment identity；
- `delegated` 只检查 native turn identity，并更新当前 tools；
- 两种模式都使用随机 turn token 和现有 broker 生命周期；
- Zero Risk 的 surface nonce、request id、manual start/completion handshake 不变。

内部实现可以使用 tagged union、独立 `TurnCapability` 类型或两个 register/update 路径。不得为了复用旧类型而在 `delegated` 中伪造 cwd、roots 或 sandbox policy。

### 验收与实施自由

- 对已有 token 尝试更新或重绑定不同 `thread_id` / `turn_id` 必须失败；使用该 token 的调用必须始终路由到其注册时的 origin identity。
- round N 的 tool A 已经由 broker 产生 `callId` 后，round N+1 删除 A：A 的旧 result 仍必须能通过 `completeTool(callId)` 完成；更新后任何新的 A invoke 必须在 broker 层失败，且 `validateBatchTools()` 仍存在并有测试覆盖。
- MCP handler 在旧 generation 下 claim 后，如果 registry 在其 broker invoke 前更新，invoke 必须按最新 generation 再校验；已删除的 tool 不得因旧 claim 而重新获得准入。
- 同 turn 下一轮新增一个合法 advertised tool 后，该 tool 可以通过同一 token 的更新 registry 使用。
- Server admin/control 操作不得出现在 client tool registry 中。
- token 具体编码、broker 内部字段名、generation 的具体数值起点和 registry hash 方式属于实现自由；claim / invoke / complete 三个边界的 generation 语义不属于实现自由。

## Filesystem authority 与 environment_context

### 结果与已确定选择

在 `delegated` 中，filesystem authority 完全委托给 outer Codex。Server 不复制，也不二次认证以下状态：

- cwd；
- workspace roots；
- writable roots；
- network policy；
- sandbox policy；
- approval policy。

这些状态只由远端 Codex 当前 native execution context 决定。

### 完整行为与边界

`environment_context` 在 `delegated` 中只是一段给模型使用的运行上下文，不是 Server 权限来源：

- 有当前 `environment_context` 时，可以按现有 prompt/context 路径让模型看到它。
- 缺失时不得阻塞 turn。
- Server 不为了工具授权解析 cwd/roots/sandbox，也不要求这些字段格式完整。
- Server 不把历史 `environment_context` 当成当前状态。
- Server 不用当前或历史 `environment_context` 扩大 tool registry。
- 即使文本声称 `danger-full-access`、额外 writable root 或其它高权限，也不会改变 outer Codex 的真实 sandbox/approval。

当模型确实需要当前本地状态时，应通过当前 Codex Native tools 查询，例如 `pwd`、`git rev-parse --show-toplevel` 或其它当前 request 已 advertised 的只读工具。Server 不预先为模型补齐一个从历史 rollout 推断的 cwd。

没有 Native tools 的 browser-only 请求如果又没有 current environment，则不能可靠回答实时本机 cwd、可写范围或 sandbox 状态。这是已接受限制，不增加特殊远程 fallback。

### 验收与实施自由

- environment-less resumed root Full turn 必须能够注册 delegated capability 并执行 Native tool。
- 伪造或陈旧的 `environment_context` 不得改变工具集合，也不得改变 outer Codex 最终执行权限。
- delegated 路径不得因为 cwd、workspace roots 或 sandbox 字段缺失而抛出 `missing_trusted_codex_environment` 一类错误。
- prompt compiler 是否继续原样传递该文本属于现有模型输入合同；不得新建一个 Server-side filesystem authority parser 来替代 rollout。

## 禁止依赖本机 Codex rollout

### 结果与已确定选择

`delegated` 必须是“完全不读取”，不是“有就优化”。Server 在该模式下不得读取本机 Codex rollout 或 SQLite 来帮助当前远端 turn。

明确禁止：

- 扫描 Server 本机 `CODEX_HOME/sessions`；
- 读取本机 `state_5.sqlite` 或 `CODEX_SQLITE_HOME` 来定位远端 thread；
- 调用 rollout resolver 来恢复 cwd、roots、sandbox 或 child environment；
- 用 rollout 恢复 local-compaction message re-id alias；
- 用 rollout 恢复 standalone compaction source turn。

`threadEnvironmentStatePath` 一类 Server 自有缓存可以继续服务 `verified-environment`。`delegated` 不得把其中的历史 filesystem environment 当作 authority。

### 完整行为与边界

server remote deployment 的容器不需要挂载外部 Codex 的 `CODEX_HOME`，也不需要知道远端项目路径。将 `CODEX_HOME` 指向不存在、空或与客户端无关的目录，不得影响合法 delegated Full / Zero Risk turn。

该规则同时适用于 root、resumed root、subagent first turn 和 compaction/replay 路径。任何一条 fallback 如果重新打开 Server 本机 rollout，都违反本规范。

### 验收与实施自由

- 测试应让 rollout resolver 在 delegated 路径被调用时立即失败，证明正常 delegated turn 不会触发它。
- server deployment 运行验收必须在容器没有客户端 `CODEX_HOME`、项目目录和 `state_5.sqlite` 的情况下完成真实 Full / Zero Risk / child tool round。
- rollout 相关实现可以保留给 `verified-environment`；本需求不要求删除现有本地功能。

## Outer Codex 是唯一执行 authority

### 结果与已确定选择

`delegated` 的安全链路是：

```text
ChatGPT
  -> Server turn broker
  -> thread_id + turn_id + current advertised tools
  -> outer Codex
  -> cwd / filesystem / network / sandbox / approval / actual execution
```

Server 只运输和约束“这个 native turn 当前允许请求哪些 outer Codex tools”。Server 不决定一个 shell 命令最终是否允许，也不决定一个路径是否可写。

### 完整行为与边界

- API Key 继续验证远程 Responses 客户端。
- turn token 的 target native thread/turn 在签发后不可改变；持有 token 的调用只能进入该固定 origin channel。
- MCP/Native action 只能调用当前 outer Codex request advertised 的工具。
- outer Codex 的 sandbox 和 approval 是最终执行边界。
- 工具未指定 workdir 时，使用 outer Codex 自己的当前执行上下文；Server 不注入一个推断 cwd。
- ChatGPT 请求危险命令、危险路径或额外网络访问时，outer Codex 仍可以按自身 policy 拒绝或要求 approval。
- daemon `controlToken`、`/admin/*` 和 Launcher 私有 control capability 不能混入 client tool registry。

本规范不把远端 Codex 当作不可信的 filesystem executor。server remote deployment 仍是单用户、单实例、受信任客户端模型。API Key 泄漏或客户端被攻陷仍属于现有高风险事件。

### 验收与实施自由

- read-only outer Codex 必须继续拒绝写操作；Server 不得因为 delegated 而让写操作成功。
- workspace-write outer Codex 必须继续按其真实 writable scope 拒绝越界写入。
- approval-required 操作必须继续由 outer Codex 的现有 approval 流程决定。
- 这些测试要验证“实际远端执行结果”，不能只断言 Server 内部字段。

## Zero Risk 合同

### 结果与已确定选择

Zero Risk 在 `delegated` 中继续可用。不得用 `localToolsEnabled=false` 作为 server remote deployment 的替代方案。

现有以下合同保持不变：

- 用户手工 Send；
- surface nonce；
- request id；
- turn token；
- Launcher manual start/completion handshake；
- exact current tool registry；
- terminal/revocation semantics；
- outer Codex sandbox/approval。

变化只有 authority payload：Zero Risk 注册的是 delegated turn capability，而不是 trusted filesystem environment。

### 完整行为与边界

`startRuntime()` 一类当前硬编码的“Zero Risk requires a trusted Codex environment”条件必须按 authority mode 拆分：

- `verified-environment`：继续要求 trusted environment；
- `delegated`：要求有效的 `thread_id + turn_id + current tools` capability，不要求 filesystem environment。

Zero Risk 不因为缺少 rollout、cwd 或 sandbox envelope 失败。若缺少 native thread/turn identity，则按 delegated identity 合同明确失败。

### 验收与实施自由

- environment-less Zero Risk 必须能完成一次真实 Native tool round 和最终 completion handshake。
- 旧 request id、旧 surface nonce 或已 terminal token 的拒绝行为不得放宽。
- 手工发送和 Launcher UI 行为不是本次重设计范围。

## Subagent 首 turn

### 结果与已确定选择

child first turn 不再需要 Server 通过 rollout 恢复 child 的真实 cwd。

child 的 Native tool 必须由产生该 Responses 请求的同一个 native child harness 执行。Server 用 child 自己的 `thread_id + turn_id` 建立 delegated capability，不把 parent 的 filesystem environment 继承给 child。

### 完整行为与边界

- `parent_thread_id`、`agent_name`、`subagent_kind` 可以继续帮助证明 lifecycle 关系和 session ownership，但不授予 filesystem 权限。
- child tool call 未指定 workdir 时，由 child outer Codex 的当前 execution context 决定。
- child sandbox 由 child outer Codex 自己执行。
- Server 不从 parent environment、历史 XML 或 rollout 猜 child cwd。

### 验收与实施自由

必须增加真实 Codex integration test：

```text
remote Codex
  -> root thread
  -> spawn child
  -> child environment-less first Responses request
  -> ChatGPT 请求 pwd / read 类 Native tool
  -> 实际执行必须落在 child 自己的 native workspace/context
```

该测试还应证明 parent 与 child token 是两个独立 bearer capability：任何 token 都不能被更新或重绑定到另一方；使用 child token 的调用始终进入 child origin channel，使用 parent token 的调用始终进入 parent origin channel。测试不得假设 broker 能从 presenter 身份识别“拿错了另一个 turn 的 token”。

## Compaction、replay 与 retained browser fallback

### 结果与已确定选择

`delegated` 关闭所有 rollout-dependent replay 优化。效率可以下降，正确性不能依赖本机 rollout。

### 完整行为与边界

#### Message re-id

local compaction 如果重新分配 retained human message id：

- 不从 rollout 恢复 alias；
- 新 id 按新 id 处理；
- exact replay cache 可以 miss；
- 允许重新提交已展开的完整上下文或建立新 browser epoch；
- message re-id alias miss 本身不得触发一次新的 compaction summarization turn。

message-id alias 仍可在 `verified-environment` 中保留。

#### Source turn

delegated 模式下，唯一允许直接用于 retained-source recovery 的 request-carried source proof 是 `extractChatGptCompactionSourceRevision(parsed).turnId`，也就是 source user/parent instruction 自身携带的 native `turn_id`。它只有在以下条件全部成立时才可以复用 retained source：

1. 当前 compaction request 有非空 native `thread_id`；
2. source revision 有非空 native `turn_id`；
3. source revision 有非空的当前 request-carried item id；缺少 item id 时不能证明同一 native turn 内的具体 instruction revision；
4. retained session 的 `nativeThreadId` 与当前 request `thread_id` 精确相同；
5. retained session 的 `nativeTurnId` 与 source revision `turn_id` 精确相同；
6. 当前 retained registry 能按下述 **exact source execution identity** 精确找到该 source execution，且没有 identity 冲突。

这里的“精确”不能只等于 `nativeThreadId + nativeTurnId`。delegated source execution identity 必须覆盖与 `chatGptCompactionSourceExecutionKey(parsed)` 相同的 execution 维度：

- 当前 request 的 native thread id；
- source revision 自身的 native turn id；
- source revision content；
- source revision 当前 request-carried item id；
- 当前 `modelId`；
- 当前 reasoning identity（现有实现中的 `parsed.options.reasoning` 语义）。

delegated 模式的 source item id 必须直接使用当前 request 携带的 source revision item id，不得通过 rollout message-id alias、SQLite 或其它本机 canonicalization 改写。实现可以新增 delegated 专用 execution-key helper，或让现有 helper 接受禁止 alias 的模式；无论内部形式如何，以上 identity 维度必须全部参与匹配。

当前 compaction turn 自己的 `turn_id`、prompt/cache identity、历史 environment、Server 本机 rollout 或其它猜测值都不能替代 source revision 的 native `turn_id`。`parsed._chatGptCompactionSourceTurnId` 在 delegated 模式下不得通过 rollout 或 SQLite recovery 填充；若该内部字段保留给 verified 模式，delegated source recovery 不得依赖它。

如果 source revision 缺少 native `turn_id` 或当前 request-carried item id、source item id/revision/model/reasoning 任一 identity 维度不匹配、identity 冲突，或 retained registry 不能满足以上精确匹配：

1. 不猜测 source execution；
2. 用当前 `thread_id` / conversation key 找到该 task 的 retained conversation，仅用于 retirement；
3. 退役并等待当前 retained browser epoch 完整释放；
4. 使用 Responses 请求中已经展开的完整历史执行 fresh compaction；
5. 建立新的 browser epoch；
6. 不复用无法证明属于正确 source 的旧 session。

该 fallback 必须是 deterministic。不能因为 Server 本机恰好存在同名 rollout 而改变结果。

如果 local compaction re-id 使 source item id 与 retained execution 不再一致，它就是正常的 exact replay miss。实现必须走上述 retirement / fresh fallback，不能把匹配规则降级成 thread+turn，也不能忽略 revision content、item id、model 或 reasoning identity。

当前已有 `runFreshCompactionFallback()` 和 retained-conversation retirement 能力可以复用，但实现者可调整内部函数边界。

### previous_response_id 前置条件

fresh compaction 只解决 retained browser/source proof 缺失，不解决模型历史缺失。

如果请求依赖一个 Server 已无法展开的 `previous_response_id`，现有 409 行为必须保留：Server 拒绝用 partial Codex context 运行 ChatGPT Web。客户端需要重新发送完整历史、先完成可用 compaction，或开始新 task。

不得使用 rollout 来猜测丢失的 continuation history。

### 验收与实施自由

- 无 rollout 的 local-compaction re-id 必须允许 exact replay miss，并通过 full-context resubmission / fresh browser epoch 继续；不得仅因为 alias miss 再执行一次 fresh compaction。
- 无 source-turn proof 时必须退役对应 retained conversation，再 fresh compaction；测试必须证明不会复用另一个 turn 的旧 session。
- 同一个 native thread/turn 先运行 instruction A，再 steering 为 instruction B 时，A 与 B 必须是不同 source execution identity；compaction 指向 B 时不得复用 A 的 retained browser execution。即使 A/B 的 thread/turn 相同，也不能把匹配降级为 thread+turn。
- rollout 路径若被 mock 为“存在一个错误但看似匹配的 source”，delegated 结果仍不得使用它。
- missing `previous_response_id` continuation state 必须继续返回明确 409。
- fresh browser epoch 的内部 key 结构属于实现自由，但不能跨 task 复用。

## 模式切换、兼容与回退

### 结果与已确定选择

本需求是新增一个可选 trust model，不删除现有严格本地 trust model。

- 已有本地用户升级后没有显式设置时，行为不变。
- server remote deployment 升级后必须自动进入 `delegated`，不要求用户提供客户端 rollout mount。
- 本地用户可以显式切换到 `delegated`，用于与远程相同的 authority 模型。
- active turn 中不得从一种 authority mode 切到另一种。

### 完整行为与边界

如果部署需要回到 `verified-environment`，它必须重新满足该模式的本机 rollout/environment 前提。server remote deployment 本身不提供这种回退，因为它的产品合同是 Codex 可以在另一台机器运行。

删除 rollout mount、删除 Server 本机 Codex CLI、把客户端项目移动到另一台主机，都不应影响 `delegated` 正确性。

本需求不要求删除已有 rollout parser、SQLite lookup、thread environment cache 或 verified-mode tests。

## 安全文档与运维合同

实现必须同步更新 `docs/security-model.md` 和 server deployment 文档，使它们不再声称远程 Full/Zero Risk 需要 Server 本机 canonical rollout。

更新后的安全文档必须清楚区分：

```text
verified-environment:
Server verifies Codex filesystem authority
-> Server issues turn capability
-> Codex still enforces execution policy

delegated:
Server verifies native turn tool capability
-> Server issues turn capability
-> outer Codex is the sole filesystem/sandbox/approval authority
```

安全文档还必须把 bearer turn token 明确写成短生命周期 capability secret：在 token 被撤销或过期前，泄漏它等价于获得该 token 固定 origin turn 当前 registry 所允许的工具能力。token 不能被重绑定到其它 native turn。

server deployment 文档必须明确：

- 不挂载客户端 `CODEX_HOME`；
- 不扫描客户端 sessions；
- 不访问客户端 `state_5.sqlite`；
- 不要求服务端知道客户端 cwd；
- 当前本机状态需要时由模型通过 Native tools 查询；
- browser-only 且没有 current environment 时，实时本机状态不可可靠回答。

## 综合验收

实现完成后，至少覆盖以下验收：

1. **Environment-less resumed root**：远端 resumed root 没有 current environment，Full 模式仍可调用 Native tool。
2. **Child first turn**：remote root spawn child 后，child environment-less first turn 的 `pwd`/read tool 实际运行在 child native context。
3. **Sandbox authority**：read-only 和 workspace-write 的越权操作仍由 outer Codex 拒绝；Server 不提供 filesystem override。
4. **Unadvertised tool**：ChatGPT 请求当前 round 未 advertised 的 tool，broker 拒绝；`validateBatchTools()` 的独立校验也保留。
5. **Token isolation**：token target identity 在签发后不可更新或重绑定；parent/child token 保持独立，任何调用都只能进入所持 token 的 origin channel。测试明确把 token 当 bearer capability，不要求 broker 识别 presenter 属于哪个 native turn。
6. **Tool registry generation**：round N 的 tool A 已产生 `callId`；round N+1 删除 A 后，该旧 result 仍可完成，但任何新的 A invoke 都失败。旧 generation 下已 claim、更新后才 invoke 的 handler 也必须按最新 registry 失败；新增 advertised tool 可以在同 token 的新 generation 下生效。
7. **No rollout reads**：delegated root、child、Zero Risk、compaction 运行期间没有 `CODEX_HOME`/SQLite rollout lookup。
8. **Compaction re-id**：无 rollout alias 时允许 replay miss，并能通过 full-context resubmission / fresh browser epoch 继续；不得仅因 re-id miss 运行新的 compaction summarization。
9. **Exact retained source**：无法证明 exact source execution 时先 retire retained conversation，再 fresh compaction，不复用错误 session；同 thread/turn 的 instruction A/B steering 场景必须证明 compaction 指向 B 时不会复用 A。
10. **Zero Risk**：environment-less Zero Risk 完成真实 Native tool round、manual handshake 和 final completion。
11. **previous_response_id**：Server continuation state 不存在时仍返回明确 409，不用 rollout 补历史。
12. **Local compatibility**：未配置新模式的普通本地安装仍走 `verified-environment`，现有 rollout/environment strict tests 继续通过。
13. **Remote force**：server deployment 无法以 `verified-environment` 启动；显式冲突配置必须失败。
14. **Forged environment text**：请求中伪造 cwd/sandbox/environment 文本不能增加 tools，也不能改变 outer Codex 的实际 sandbox 结果。

真实远程验收应使用“Server 容器无客户端 Codex 数据 + Codex 在另一台机器”的拓扑。只在同一工作站上 mock 一个缺失 environment 不足以证明跨机器合同成立。

仓库中的真实远程验收按以下阶段执行，两个 client 阶段都必须使用前述双机拓扑：

- `bun run accept:delegated:server`：在 Server 主机生成带 challenge 的容器 attestation，证明 delegated 被强制启用、容器中没有 Codex CLI、没有客户端 `sessions` / `state_5.sqlite`，且没有客户端 workspace / Codex state mount。
- `bun run accept:delegated:remote`：在独立 Codex 主机执行 Automatic / Full 实机阶段。它覆盖 root -> child Native tool round、child 首个 Responses request 无 `<environment_context>`、parent/child native thread 分离和 origin-channel continuation 隔离、read-only、workspace-write，以及 `approval_policy = "on-request"` 的未批准 escalation。bearer token 本身不得暴露给 client harness，因此实机阶段用 parent/child native `call_id` 只回到各自 origin thread 证明真实 wire 隔离；`tests/turn-broker-lifecycle.test.ts` 同时直接验证已签发 token 的 thread/turn identity 不能更新或重绑定。workspace-write 的越界目标必须在系统临时目录之外；harness 在尝试写入前和实际运行后都从 native rollout 的 `permission_profile` 证明目标不属于任何 explicit writable root、`project_roots`、`tmpdir` 或 `slash_tmp` 权限。
- `bun run accept:delegated:zero-risk`：Server 切换到 Zero Risk 并重新导出 model catalog、重新生成 server attestation 后执行。该阶段使用真实 `codex app-server`，要求操作员完成 Launcher 的 manual send / Sent 和 Zero Risk `codex_turn_start` / Native tool / `codex_turn_complete` 链路。首个 turn 必须得到真实 native `pwd` / read 结果并完成 final completion；随后 harness 显式调用 native `thread/compact/start`。因为 source Zero Risk turn 已完成，此路径要求 delegated structured compaction 走 fresh browser fallback；compaction 完成后再执行一个 native turn，并从 compacted context 恢复 challenge marker 后完成。

远程 harness 不使用 `--dangerously-bypass-approvals-and-sandbox`。真实远程凭据、第二台 Codex 主机或需要人工 Launcher 操作的阶段不可由普通单机单元测试替代；缺少这些条件时只能报告未执行，不能把本地 mock 视为该验收通过。

## 跨主题不变量

以下规则对 `delegated` 的所有 Full / Zero Risk / subagent 场景成立：

- 推理历史由当前 Responses 请求和 Server continuation state 提供，不由 rollout 恢复。
- filesystem authority 不来自 prompt text。
- tools 只来自当前 request advertised registry。
- registry generation 只影响更新后的新 discovery / invoke；已产生 `callId` 的 invocation 不因后续 registry 缩小而失去 completion 权利。
- Server bearer capability 必须在注册时固定绑定 native thread/turn，之后不得重绑定。
- actual tool execution 只在 outer Codex 发生。
- sandbox/approval 只由 outer Codex 最终裁决。
- rollout 缺失只能降低 replay/retained-session 效率，不能导致 Server 猜测 authority。
- missing Server continuation state 是真实上下文缺失，继续 fail closed。

## 当前规范资料与来源

本规范基于以下已核对项目事实：

- `src/adapters/chatgpt-web/turn-broker.ts`：当前 broker 把 cwd/roots/writableRoots/sandboxPolicy/tools 放在同一个 `ChatGptTurnEnvironment`，并在活动 loop 中比较 filesystem environment identity。
- `src/adapters/chatgpt-web/environment.ts`：native `thread_id`、`turn_id`、parent/agent metadata 与 filesystem environment 已有独立解析结构。
- `src/adapters/chatgpt-web/index.ts`：当前 tool-capable 路径调用 trusted environment resolver；Zero Risk 当前要求 trusted environment；`validateBatchTools()` 已按 active request advertised tools 做最终校验；structured compaction 已有 fresh fallback 路径。
- `src/adapters/chatgpt-web/codex-rollout-environment.ts`：rollout 负责 canonical environment recovery、message identity alias 和 source-turn 相关恢复；message re-id mapping 已被标注为 replay optimization。
- `src/adapters/chatgpt-web/turn-execution.ts`：retained conversation 有按 conversation key retirement/wait 的现有能力；browser session 已保存 native thread/turn identity；当前 execution key 还包含 instruction revision、item id、model 和 reasoning identity，同一 native turn 的 steering revision 可以产生不同 execution key。
- `src/server.ts`：`previous_response_id` 会先通过 Server continuation state 展开；无法展开时当前已返回 409，而不是从 rollout 猜历史。
- `docs/security-model.md`：当前文档仍把远程 Full authority 写成 Server 从 native envelope/rollout 验证 filesystem environment，需要按本规范调整。
- `deploy/server/compose.yaml`、`deploy/server/README.md`：server remote deployment 已明确 Codex 在容器外，容器不共享客户端 `HOME`、`CODEX_HOME` 或工作目录；部署已经通过独立环境设置表达 server-only 行为。

已确认的本次决定：

- 使用显式 `verified-environment` / `delegated` 模式；
- 本地默认 verified，server remote deployment 强制 delegated，并拒绝冲突；
- delegated 中 `environment_context` 只作模型上下文；
- delegated 完全禁止本机 rollout/SQLite 读取，不保留 opportunistic rollout 优化；
- tool-capable delegated turn 缺少 `thread_id` 或 `turn_id` 时直接拒绝；
- turn token 是 bearer capability；其 target native thread/turn 在签发后不可改变，token 泄漏等价于获得原 origin turn capability；
- 同 turn token 每轮原子更新当前 tool registry 并推进单调 generation；claim 不是正式准入，broker invoke 必须按最新 generation 校验；已产生 `callId` 的旧 invocation 可以完成，`completeTool` 不重新按新 registry 拒绝；
- delegated retained-source proof 只接受 source user/parent instruction 自身携带的身份，并要求 exact source execution identity 同时匹配 native thread/turn、source revision content、request-carried source item id、model 和 reasoning；否则退役 retained conversation 后 fresh compaction；
- message re-id alias miss 只允许 replay/full-context/new-browser fallback，不单独触发 fresh compaction；
- filesystem/sandbox/approval 的唯一 authority 是 outer Codex；
- Full、Zero Risk、subagent 和 normal compaction 保留；
- missing `previous_response_id` continuation state 继续 409。

## 本次修订与待确认内容

本规范是新增调整文档，不重写原 Phase 1 的网络和桌面部署合同。它替换原 Spec 和当前 security model 中“远程 Full/Zero Risk 需要 Server 本机 rollout 证明 filesystem authority”的部分。

本轮复核指出的协议边界已经固定：tool registry generation 的 claim/invoke/complete 语义，以及 exact retained-source execution identity 都属于规范要求，不再留给实现者自行解释。实现阶段仍需要用真实远程 Codex integration 证据确认 child first turn、outer sandbox enforcement、Zero Risk 和 fresh compaction fallback。若真实运行结果表明 native child tool 并未回到产生该 Responses 请求的 child harness，则该事实会重新打开 delegated subagent 设计，而不是通过 Server 猜 cwd 来绕过。
