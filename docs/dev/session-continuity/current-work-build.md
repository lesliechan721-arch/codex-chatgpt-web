# 当前工作校验第三版：实施与验证

日期：2026-09-30。原始基线：`9906a7e37af59f1e2d8362bbad3e383177182e31`。
范围：[当前工作规格](current-work-validation.md) v0.1 及其明确继承的合同。
用户本轮提供该文档并调用 `dev-workflow:dev-build`，授权本地实施。未提交、未推送。

## 当前状态：审查后的定向修复

2026-09-30，用户提供新的审查报告并调用 `dev-workflow`，授权修复普通模式取消回归和请求级重复识别两项 P2。本次沿用当前规格，不扩大身份、历史证明或权限合同。修复前保存当前工作区快照，保留此前未提交改动。本次新增修复预算最多 3 轮，当前第 1 轮；此前实施的 3/3 轮属于下文历史范围。

- 普通模式恢复内联环境更新顺序，减少新增异步返回间隙。更新后若浏览器已失败，交付其真实错误；已结束的执行不再启动工具等待。continuity 仍在活动缓存重放前更新 registry，保留 owner 复核和旧 execution 只读行为。
- checkpoint 选择在请求内复用成功引用及“无需恢复”的结论。当前指令位置和不同既有边界下的输入选择也在请求内复用；选中结果只保存位置，负载比较仍读取本次正文、角色和附件。首次接受使用同一份选中内容计算 payload/content digest。
- checkpoint 来源仍是已提交记录；弱引用失效或记录被删除后拒绝恢复。既有开始响应、压缩提交和环境更新边界继续复核 owner、revision、lease、head 和记录，不把请求识别当作写入权限。

定向 red-green：原取消测试修复前失败，修复后通过；增加环境更新延迟期间取消的测试，两种时序均检查不可重试 `client_cancelled` 及重放不重启浏览器。三类扫描回归（无 checkpoint、无匹配、当前指令身份明确）修复前均失败，修复后均通过。

以下是同一临时计数探针在本轮修复前快照和修复后源码上的结果。探针基于保存的真实普通请求添加已完成 user/assistant 对，执行输入选择、首次接受、重放负载复核和身份/digest 消费；它不是 HTTP 延迟或百万 token 验收，也不能与用户报告中不同消费者序列的绝对读数直接比较。

| 无 checkpoint 的输入项数 | 修复前数组读取 | 修复后数组读取 | 修复前登记查询 | 修复后登记查询 |
| ---: | ---: | ---: | ---: | ---: |
| 205 | 115,059 | 1,674 | 545 | 1 |
| 405 | 429,759 | 3,274 | 1,045 | 1 |
| 805 | 1,659,159 | 6,474 | 2,045 | 1 |

另外两类修复后读取为 1,682/3,282/6,482 与 1,683/3,283/6,483，登记查询均为 1。固定回归断言输入翻倍时读数增长低于 2.3 倍、读取量有线性上限、登记查询有固定上限，并检查持续 developer 与当前指令完整。

本轮实际组合验证：8 个文件 **664 pass / 0 fail**，8,938 次断言，67.88 秒；文件为 session-continuity-adapter、session-continuity-state、session-continuity-protocol、session-continuity-input、session-continuity-lifecycle、retained-compaction、chatgpt-web-harness 和 server-lifecycle。四份协议 parser/normalize 重放共 **34 个请求通过**。`bun run typecheck` 与 `git diff --check` 通过。相关角色、附件、source 冲突、回收、registry 重放及取消测试包含在本轮组合中。

本轮两份独立审查均未发现确定缺陷，两项 P2 的关闭条件已满足。需求与设计轴独立运行三个相关文件：507 pass / 0 fail，7,404 次断言，42.74 秒；工程质量轴核对实际代码、差异、调用链及本轮 664 项组合日志，未另行运行测试。两轴结束时均核对六个源码及测试文件保持冻结。本轮修复使用 1/3 轮预算。

真实 ChatGPT 页面验收仍未完成：本轮只读检查确认隔离 DEV Launcher 的进程未运行。该限制不构成新增准入要求。没有提交或推送。

## 实现

- continuity 的完整 source、两个 producer codec 比较摘要和一次消费关系保存在原有 checkpoint 记录中，计入既有容量；共享 continuation cache 只服务普通模式。本请求持有已选提交记录的指针，记录回收后不能恢复其权威。
- source 选择使用请求携带的原生 source 身份和已有本地调用记录。相同 turn、正文和摘要的 A/B 保持不同提交；明确 B 选择 B，旧 A 不写后续页面，无法区分的请求停止。新 execution 建立时同步标记过渡消费，重试复用已建立的 round。
- 活动 execution 在现有互斥下复核 owner、revision、head、负载和 capability，再更新工具 registry 并返回缓存。旧 execution 的重放保持只读，已准入 operation 沿原描述完成。
- 远程 Broker 更新返回后再次复核 binding、owner、revision 和 head，防止旧请求覆盖新 owner 的发现工具；旧请求仍可返回原结果。
- 真实 Codex 请求证明基础指令和当前历史窗口的原生 developer/AGENTS 前缀持续适用；其 item turn 可表示创建时的 turn。选择保留这些前缀及当前指令的角色、内容和顺序，负载比较覆盖它们。
- 目标版本源码支持的插件、Apps、多代理、skills、memories、环境说明、托管配置、预算等持续 developer 内容均按本次证实的原生布局保留；派生测试验证完整分组、顺序及冲突重试拒绝，未将这些变体计入真实捕获。
- 明确属于不同新 turn 的完整输入不再强制回显已完成 predecessor。正常捕获请求仍保留 predecessor，删除旧历史的验证是合成变体。同 turn 无法区分 steering 或没有输入归属的请求仍拒绝。
- 无 AGENTS 工作区的纯环境项参与原生窗口的结构识别；输入正文与环境权限继续按原有规则处理。

## 证据边界

[协议取证](current-work-protocol-evidence.md) 使用 Codex 0.159.2、临时配置、假页面及真实无害 `printf`。保存了普通请求、实际工具结果、503 后原样重试、新 turn、同 turn steering、压缩及 checkpoint-only 形态。真实客户端发送的数据与合成删除历史测试分开。

API-key/custom provider 删除逐项来源元数据；built-in OpenAI provider 的临时 ChatGPT 认证样例保留这些字段。取证不读取生产凭据，不据缺少 source turn 放宽 delegated 的精确证明。

真实 ChatGPT 页面验收未运行：隔离 DEV Launcher 的描述文件存在，但其进程不在运行。Zero Risk 的人工页面提交、local/v1/v2 各 codec 的真实页面消费、JSON、previous-response 展开、远程部署及资源寿命未由这些样例证明。既有假页面回归也不能替代这些证据。

## 前次实施验证与审查（历史记录）

实施前相关基线：437 pass，0 fail。registry 定向 red-green：修复前 4 fail / 6 pass，修复后 10 pass / 0 fail。真实请求选择定向 red-green：首批 3 fail，修复后通过；补充历史窗口 steering 和 API-key 原生分组后，5 pass / 0 fail。

初次 17 个文件的组合验证：677 pass / 1 Windows-only skip / 0 fail；新增真实形态 Adapter 回放与 source 最后组合验证：10 个文件 581 pass / 1 Windows-only skip / 0 fail。类型和空白检查通过。

初次两轴独立审查：需求轴无确定缺陷；工程轴确认两个 P2：持续 developer 组包含 plugins/apps 原生种类时被遗漏；旧 owner 的异步 registry 更新返回后覆盖新 owner 的 discovery。各轴独立运行 4 个核心文件 449 pass / 0 fail，并重放四份协议样例。第 1 轮已完成这两项修复：前缀选择 8 pass；Adapter registry、竞态和冲突回归 14 pass；既有 discovery 另 4 pass。

第 1 轮修后 17 个文件的组合验证：684 pass / 1 Windows-only skip / 0 fail，8575 次断言，59.41 秒；类型及空白检查通过。新独立需求轴完整复审无确定缺陷；工程轴确认同版本另 16 种持续 developer 内容仍遗漏，其余完整范围无新的确定问题。

第 2 轮按固定版本生产器及 initial builder 补齐这 16 种内容，详见协议记录中的源码与布局表。协议选择回归修前 8 pass / 16 fail，修后 24 pass / 0 fail；Adapter 原生布局回归修前 3 pass / 16 fail，修后 19 pass / 0 fail。

第 2 轮 17 个文件组合验证：716 pass / 1 Windows-only skip / 0 fail，8859 次断言，59.00 秒；类型及空白检查通过。新独立需求轴无确定缺陷（137 pass / 0 fail，四份协议重放通过）；工程轴独立核心 488 pass / 0 fail、四份协议重放通过，但确认无 AGENTS 的纯环境窗口误拒绝，其他完整范围无新的确定问题。

第 3 轮仅修正纯环境分组的窗口识别。选择回归修前 24 pass / 1 fail，修后 25 pass / 0 fail；Adapter 使用实际 verified resolver 和临时合成 canonical rollout 取得 source 证明、完成 local compact，再测试无 AGENTS 续接，正向预期修前 0 pass / 1 fail，修后 1 pass / 0 fail、34 次断言。该测试先显式调用原 resolver 取得 compact 精确 source 证明，不证明完整 HTTP/native 客户端的 verified producer 链路。

最终 17 个文件组合验证：718 pass / 1 Windows-only skip / 0 fail，8899 次断言，59.10 秒；类型及空白检查通过。

第 3 轮修后完整两轴独立复审均未发现确定缺陷，前述问题的关闭条件已满足。需求轴独立定向验证 130 pass / 0 fail、1576 次断言；工程轴 137 pass / 0 fail、1712 次断言；各轴均重放四份协议样例共 34 个请求并通过空白检查。审查结束至交付仅更新文档状态，源码和测试保持冻结。真实页面及上文未覆盖项仍未验收。

初次实施不占修复轮次；本版独立审查后的修复预算为最多 3 轮，当前 3/3。前两版累计 10 轮及其数字属于历史范围。
