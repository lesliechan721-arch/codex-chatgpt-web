# 当前工作协议取证

2026-09-30。对应 [当前工作规格第 6 节](current-work-validation.md#6-先取得正常请求再确定选择规则)。Git HEAD：`9906a7e37af59f1e2d8362bbad3e383177182e31`。这是本轮取得的真实 Codex 请求证据，不沿用旧 P0 结果。

## 装置与可重放样例

[取证脚本](../../../scripts/probe-codex-continuity-protocol.ts) 复用现有 local-compaction smoke 的 app-server、bundled catalog、临时配置和 Responses adapter 装置，以及 delegated acceptance 的请求捕获方法。它使用一个确定性的页面替身；此替身在 Responses adapter 中运行，不包含 DOM、Launcher surface 或物理 lease。Codex、HTTP 请求、native rollout 和 `exec_command` 结果是真实的。工具只执行固定 `printf`，不写文件、不访问网络。

目标二进制为 PATH 中的 `codex-cli 0.159.2`，实际文件为 `~/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex`，SHA-256：`16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704`。Bun 为 1.4.0。每次运行使用独立临时 `CODEX_HOME`、`CODEX_SQLITE_HOME`、workspace、AGENTS 文件和模型目录；结束时删除临时目录。不安装程序、不改用户配置、不读取真实认证文件。

内置 OpenAI provider 使用仅供 loopback 服务接受的合成 ChatGPT 认证。另一条路径使用 custom provider 和固定测试 API key。这些值只存在于临时配置或进程环境中，未保存到样例。authority 实际覆盖的是 `extractChatGptDelegatedTurnCapability()` 对本次 request-carried thread/turn 和 registry 的解析；没有验证真实 Broker capability、verified-environment、远程 Server 或账户认证。

| 样例 | 真实请求与形态 |
| --- | --- |
| [主样例](../../../tests/fixtures/session-continuity/current-work-protocol.json) | Automatic 模型；built-in OpenAI + 合成 ChatGPT 认证；8 个 POST；ordinary → 工具调用 → Codex 真实结果 → 新 turn → 手动 v2 compact → 新指令续接 → 同 turn steering；含一次丢回执重试 |
| [API-key 样例](../../../tests/fixtures/session-continuity/current-work-protocol-api-key.json) | custom provider；8 个 POST；相同链路，压缩为 local message；输入项来源元数据被 native client 删除 |
| [活动 source 与 checkpoint-only](../../../tests/fixtures/session-continuity/current-work-protocol-active.json) | built-in OpenAI；10 个 POST；中途自动 v2 compact 后在原 turn 续接；另有手动压缩完成后通过真实 `turn/start input:[]` 发出的 checkpoint-only |
| [Zero Risk 模型协议](../../../tests/fixtures/session-continuity/current-work-protocol-zero-risk.json) | `chatgpt-web-continuity/zero-risk-pro`；built-in OpenAI；8 个 POST；只证明该模型的 native 请求形态。页面替身允许 completed-source compact，不能据此声称真实 Zero Risk 支持此路径 |

所有文件使用 `codex-chatgpt-web/continuity-protocol-evidence/v1`。`captured[]` 保存 `label`、脱敏后的完整 decoded `body`、HTTP `status`、`replay`、桥接响应及 `parsed.input`。较新的样例还保存无敏感值的 content-encoding 和解析标志。回执重放直接返回装置缓存，未调用 adapter，因此该项没有 `parsed`。`nativeItems` 只保存这次工具调用及真实结果。ID 替换在 body、元数据 JSON、响应和 rollout 中保持相等/不等关系；数组顺序、角色、来源字段和 content parts 保留。临时路径和用户 home 路径统一替换；没有 capability、认证 header、凭据或生产任务正文。

重放只走 Responses parser/normalize 边界，使用固定替身回答，不执行 Native 工具，也不操作网页：

```sh
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-api-key.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-active.json
bun run scripts/probe-codex-continuity-protocol.ts --replay=tests/fixtures/session-continuity/current-work-protocol-zero-risk.json
```

重新取证时可指定 `--output=<临时文件>`；其余选项为 `--auth=api-key`、`--zero-risk`、`--active-compact`、`--checkpoint-only` 和 `--codex=<路径>`。macOS 当前外层沙箱禁止子进程再次调用 `sandbox_apply`，最初只读运行取得真实 Native 错误、exit 71。成功取证在外层执行脚本，子 Codex 仍使用 read-only sandbox 和 never approval，没有改为 danger-full-access。

## 身份与指令分组的直接观察

下表的 ID 指向主样例内的脱敏 ID，不是新增协议字段。raw body 在进入 `responseRequest` 前捕获；`parsed.input` 中对应 ID 保持相同，没有桥接器生成的指令 ID 或 rollout alias 混入这份证据。

| 字段或对象 | 观察及消费边界 |
| --- | --- |
| `client_metadata["x-codex-turn-metadata"]` | native JSON 包含 `thread_id`、`turn_id`、`request_kind`；ordinary 重试的完整 body 相同；新 turn 改变 turn；两次 steering 的 turn 相同。`window_id`、`context_window_id` 会在压缩后变化，不能据它们新建工作身份 |
| `input[].id` | native 直接发送；ordinary/result round 回显的指令 ID 不变。steering 两条 user 指令分别为 `item_22`、`item_25`，同属 `turn_5`；不能只用 turn 合并它们 |
| base instructions | `thread/start.baseInstructions` 在 wire 上是 developer message `item_2`，不是 system role。来源 kind 为 `model.base_instructions`，没有 item turn；它持续位于 leading prefix，压缩后仍在 checkpoint 前 |
| developer 指令组 | `item_3` 有四个 content parts：显式 developer 指令、skills、permissions、collaboration mode。kinds 分别为 `generic.developer_instructions`、`host_skills.instructions`、`permissions.instructions`、`collaboration_mode.instructions`。它带创建时的 `turn_1`；新 `turn_2` 仍以同 ID、原 turn 和 leading 顺序发送。不能仅因它的 turn 不是当前 turn 而丢弃持续 prefix |
| AGENTS 与环境 | `item_4` 是一个 user message，有两个 content parts，kinds 为 `agents_md.instructions`、`environments.environment_context`，归属 `turn_1`。真实任务 user 指令另为 `item_5`，kind 为 `user.text`。AGENTS 不能被“仅取最后一个 user”规则遗漏 |
| 新 turn | 首轮 prefix、AGENTS/environment、指令、工具和 answer 回显保留；只追加当前 `item_12`，其 item turn 为 `turn_2`。本次没有新增 AGENTS/environment 组，其 ID 和创建 turn 保持不变。原生窗口前缀与已完成任务 user/工具历史需分别识别 |
| standalone compact 后 | 保留 source user `item_5`/`item_12` 及原 turn，随后是 checkpoint `item_16`；重新建立 developer 组 `item_17` 和 AGENTS/environment 组 `item_18`，均归属当前 `turn_4`；最后才是新指令 `item_19`。base `item_2` 仍在 checkpoint 前 |
| 同 turn steering | 两条真实 steering user 均有 `user.text` kind、不同 item ID 和相同 `turn_5`。第二条位于第一条 assistant answer 后；没有新增 AGENTS/environment，原 context 组 ID 不变 |
| registry | 本版本由 `additional_tools` 输入项发送工具声明，不能假设必有顶层 `tools`。压缩解析后不向替身开放 ordinary tools。prompt 中的环境文字没有赋予额外 authority |
| 附件 | 这些样例没有 image/file/audio 附件；只覆盖结构化 text content parts，不能声称附件上传或保留已通过 |

API-key 路径保持相同角色和分组顺序，但删除全部 `internal_chat_message_metadata_passthrough`。其 leading base/developer 组 ID 在普通新 turn 和 steering 中稳定。local compact 后则重新建立无 turn 的 developer 组和 AGENTS/environment 组，位置在 retained users/summary 后、新 ordinary user 前。对这条路径，可以使用已证实的 leading prefix 和明确的环境同组结构；不能把一个新展示 ID 自动当作整组归属或 delegated source turn 证明。

独立工程审查补充了目标 `rust-v0.159.2` 的源码证据：[插件指令](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/plugin_instructions.rs)、[插件使用说明](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/available_plugins_instructions.rs) 和 [Apps 指令](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/apps_instructions.rs) 均生成 developer 指令，kinds 分别为 `plugins.instructions`、`plugins.usage_instructions`、`apps.instructions`。基于真实新 turn 样例的派生测试向持续 developer 组添加这些原生种类，验证完整分组保留和正文变化进入 payload 比较；这三项是源码支持的合成变体，没有增加真实捕获数。

修后完整工程复审继续核对了该版本的 context 生产器及 [initial builder](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/session/mod.rs#L4296)。以下 16 种常规或条件初始 developer 内容也可能持续回显，创建 turn 不代表失效。布局以 initial builder 为准：`multi_agent.mode_instructions` 的 trait 可合并，但初始 builder 将它独立发送；`model_switch.instructions` 位于合并组首。

| kind | 初始布局 | 固定版本生产器 |
| --- | --- | --- |
| `multi_agent.mode_instructions` | 独立项 | [mode](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/multi_agent_mode_instructions.rs) |
| `multi_agent.role_instructions` | 独立项 | [role](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/prompts/src/multi_agent_instructions.rs) |
| `multi_agent.usage_hint` | 独立项 | [usage](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/multi_agent_usage_hint.rs) |
| `skills.catalog` | 合并项 | [catalog](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/ext/skills/src/fragments.rs) |
| `skills.instructions`、`cloud_skills.instructions` | 合并项 | [skills](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/ext/skills/src/world_state.rs) |
| `memories.instructions` | 合并项 | [memories](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/ext/memories/src/extension.rs) |
| `plugins.recommendations` | 合并项 | [recommendations](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/recommended_plugins_instructions.rs) |
| `environments.instructions` | 合并项 | [environment](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/environments_instructions.rs) |
| `persistent_mode.instructions` | 合并项 | [persistent mode](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/world_state/persistent_mode.rs) |
| `token_budget.context_window` | 独立项 | [budget](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/token_budget_context.rs) |
| `token_budget.context_window_guidance` | 合并项 | 同上 |
| `tools.deferred_namespaces` | 合并项 | [deferred tools](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/world_state/tools.rs) |
| `git_attribution.instructions` | 合并项 | [attribution](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/ext/git-attribution/src/world_state.rs) |
| `managed_config.developer_instructions` | 独立项 | [managed config](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/world_state/managed_developer_instructions.rs) |
| `model_switch.instructions` | 合并组首 | [model switch](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/model_switch_instructions.rs) |

对应派生测试保留原 fixture 的身份和角色顺序，按表添加完整独立项或合并 part，并验证内容保留、正文冲突拒绝及拒绝时不更新 registry。修前 16 种均遗漏且正文变化不进入 payload 比较。这些仍是源码支持的合成变体。realtime 条件生产器、Guardian 专用及动态中途通知没有相同产品可达证据，本次不据此扩大实现或声称覆盖。

完整复审还核对了 [无 AGENTS 的生产条件](https://github.com/openai/codex/blob/rust-v0.159.2/codex-rs/core/src/context/world_state/agents_md.rs)：没有 AGENTS 时不生成其 fragment，initial builder 仍发送纯 `environment_context` user 项。API-key continue 样例删除 AGENTS part 的派生变体用于验证这种分组。Adapter 回归使用临时合成 canonical rollout 和实际 `verified-environment` resolver，先证明 source 并完成 local compact，再验证无 AGENTS 的完整当前窗口；这些证据不放宽 delegated source 证明，也不计入真实捕获或页面验收。

## source、checkpoint 与重试

built-in OpenAI 的真实压缩请求末端为 `compaction_trigger`，metadata 的 implementation 为 `responses_compaction_v2`、strategy 为 `memento`。桥接响应只有一个 compaction item，summary 使用现有 `ocx1:` 编码；后续真实请求原样回显该 item。手动 compact request 自身的 turn 为 `turn_3`，实际 source `item_12` 为 `turn_2`，两者不能互换。custom provider 则发 local compaction prompt，取得 assistant message，并在后续 input 回显 retained users 和 `SUMMARY_PREFIX` user message。

活动样例用临时 100-token 自动阈值和受控 usage 触发自动压缩。这只验证协议，不测真实预算。其 `active-compact` 请求的 phase 为 `mid_turn`；input 已带真实 `function_call_output`，尚未取得 ordinary final。之后 Codex 在相同 `turn_1` 发送：

```text
additional_tools → base developer → 重建 developer(当前 turn)
→ AGENTS/environment(当前 turn) → retained source user(原 ID/turn) → checkpoint
```

没有新的 `user.text`；当前 context 组确实可能位于 source/checkpoint 前。另一次手动压缩后，本装置调用公开 app-server 的空 input `turn/start`；客户端接受并发出新 request turn，含 retained source、checkpoint 及当前 developer/AGENTS/environment，没有新普通指令。这是实际产生的 completed-source checkpoint-only 形态，不代表 TUI 默认操作会主动发送空 input。

所有链路都在第一次页面替身提交工具调用后返回受控 HTTP 503。真实 Codex 用相同 body、thread/turn 和 item ID 重试，替身返回原缓存响应。每个样例的 native rollout 都只有一个 `function_call` 和一个 `function_call_output`，输出包含 `CGW_TOOL_RESULT`。基线样例的替身创建数为 1、工具调用数为 1、摘要数为 1；active 样例按其两个 source 摘要两次。计数证明本装置没有因该回执故障再次执行 Native 命令；不代替产品的 registry、journal、checkpoint CAS、结果交付或物理 lease 验证。

## 可用规则与未覆盖项

正常实测的 ordinary 新 turn、steering 和压缩后新指令都保留可定位的 predecessor/source。没有取得“native 正常请求删除旧 predecessor、但当前输入完整”的实测案例。删除旧 user/assistant/tool 历史的定向变体只能标为合成测试；必须保留真实 prefix、当前 context/AGENTS、当前指令及其元数据。不能把这种变体称为客户端复现。

已证实可使用的输入归属信息是 request thread/turn、native item ID、item turn、content-item kinds、稳定 leading 指令 prefix，以及明确的 AGENTS/environment 同组和 checkpoint 关系。当前 user 的 native 身份与当前 payload 分开比较；持续 prefix 和全部当前组参与 payload。没有 per-item turn 的 custom 路径不能据 source ID 或 summary 补造 delegated source turn。摘要编码只提供内容，source 身份仍取请求中的 source 与本地已提交关系。

实际覆盖为：Automatic/Zero Risk **模型协议**、delegated request-carried 解析、v2 和 local codec、SSE 响应、完整 decoded input。built-in 请求使用 zstd，custom 使用 identity 编码。全部 native 请求 `stream:true`，没有 `previous_response_id`；JSON 响应、previous-response 展开和 v1 codec 没有真实客户端覆盖。目标二进制的 `remote_compaction_v2` feature 标记为 removed；本次未制造旧客户端或人工 v1 请求来冒充覆盖。

四份 fixture 的 parser/normalize 重放均通过，脚本类型检查通过。真实 ChatGPT 同页、Launcher lease、MCP control handoff、Automatic 活动/完成 source 的产品闭环及 Zero Risk 合法活动 source/明确交接仍未验证。当前隔离 DEV Launcher descriptor 指向的进程未运行；本记录不将旧页面探针或这些 stub 数字写成真实页面验收。
