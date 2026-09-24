# Native 长等待实施记录

## 当前依据与范围

2026-09-24，用户确认前期技术验证已完成，并要求开始实现 [Spec v0.7](spec.md)。本次以该最新确认作为实施授权；规格、决定记录和原型记录中此前的“待技术验证”状态是历史状态，不作为本轮阻塞。用户确认不等于本轮重新执行了真实链路验收，也不等于已完成独立代码审查。

连接器名称同时更新：`Codex Native2` → `Codex Native3`，`Codex Zero Risk` → `Codex Zero Risk2`；Automatic DEV 使用 `Codex Native3 DEV`。只修改仓库代码、测试及本任务资料，不更新运行中的用户环境，不部署。

原始代码基线：`ee1ae190556f1ceca848151400a7f7b48c8cc0b5`，另有实施前已存在的未提交改动。本次选择无提交路径，不创建 Git checkpoint。实施前已有改动的逐文件副本、SHA-256 清单和 diff 保存在本机 `/tmp/codex-native-long-wait-request_5fsAEvZG/`。保留已有原型和远程部署改动，不修改 `docs/dev/request-context-navigation/`。

当前环境不支持子代理。本轮由同一实施者顺序实现和自查；不能将自查描述为双轴独立审查。

## 工作项与验收

| 工作项 | 依赖 | 结果与验收 | 当前状态 |
| --- | --- | --- | --- |
| W1：Broker operation 与公共结果 | 无 | 稳定 ID、首次当前 registry 准入、拒绝重放、冲突、30 秒 pending、查询隔离、有界缓存、固定 inventory finalizer、完成屏障、compaction 控制终态；覆盖 A0—A2、A5—A10、A13—A16、A18—A21 | 已实现；自动化覆盖见下表，调用方实测限制单列 |
| W2：MCP 合同和连接器迁移 | W1 | 两种模式原入口接收 ID，固定 wait、控制分支例外、调度前兼容拒绝、名称和提示一致；覆盖 A1、A6、A15、A17、A20 | 已实现；合同和迁移回归通过，未修改实际连接器 |
| W3：等待租约与存活集成 | W1 | 120 秒授权查询租约、独立于 Responses round 的浏览器/helper 同步、取消与退役、远程 idle 暂停终止但不刷新真实进展；覆盖 A3、A4、A11、A12、A21、A22 | 已实现；可控时钟和 helper IPC 验证通过，真实 11 分钟验收未重跑 |
| W4：组合验证与审查 | W1—W3 | 运行相关测试、类型检查及 Launcher 测试；核对完整范围，明确未执行的真实链路验收和独立审查限制 | 本地自动化验证与两轴自查已完成；全量仍有一项已证实的基线部署失败，独立审查和真实链路验收未完成 |

## 实现入口与内部合同

`src/adapters/chatgpt-web/native-tool-operations.ts` 保存每个 capability 的身份、状态、等待者和公共结果。`native-tool-contract.ts` 保存同步准入和固定结果 finalizer；`mcp-server.ts` 只处理公共协议。`turn-broker.ts` 在首次准入时固定唯一 Native call，查询不再依赖下一轮 Responses，也不产生新的 Native 调度。

等待窗口为 30,000 ms，租约为**每个 operation** 120,000 ms。只有合法启动重试或结果查询续租；观察、浏览器心跳和 TCP 活动不续租。90,000 ms 仅是 MCP→Broker 控制传输故障预算，不是底层 Native 总期限。查询中止仅释放查询等待者；取消任务、原生期限、owner 退役和失联租约分别处理。

queued retained compaction 缓存独立桥接控制终态，不调用 inventory finalizer；Broker handoff 后的 waiting 继续接受真实结果。fresh/fallback owner 退役不迁移或重执行旧 operation。Automatic 完成屏障和 Zero Risk complete 都检查活动查询、未结束 operation 和未领取结果。

`turn-progress.ts`、`index.ts` 和 helper IPC 同步 Broker 等待证据，不增加业务进展时间、工具批次或活动 Native 调用数。`browser-worker.ts` 用有效租约暂停 DOM 静默误判；挂起恢复只给 5 秒重新取得证明的宽限。`native-turn-idle.ts` 与 `server.ts` 暂停远程 idle 的终止动作，但保留真实 last-progress 时间，等待条件失效后立即重新判断。

Broker 协议版本为 **7**，Native 等待协议为 **1**，helper 必须宣告 `native-tool-wait-v1`。六个原 Native 入口携带 `operation_id`，另提供固定 `codex_tool_wait`。`codex.control.compaction_handoff` 保留控制专用例外；旧合同在 Native 调度前拒绝，不退回旧超时路径。

### 有界资源与错误分类

| 资源 | 每个 capability 的上限 |
| --- | --- |
| operation 身份 | 1,024 |
| 活动查询 / 等待者 | 64 |
| 单份 / 累计启动与 finalizer 上下文 | 8 MiB / 64 MiB |
| 单份 / 累计公共结果 | 16 MiB / 64 MiB；累计预算中预留 1 MiB 给固定 unavailable 终态 |

超过预算不驱逐已接受操作，不通过重执行恢复结果。主要错误类别为 `codex_tool_operation_id_required`、`codex_tool_operation_unknown`、`codex_tool_operation_conflict`、`codex_tool_admission_rejected`、`codex_tool_resource_limit`、`codex_tool_result_unavailable`、`codex_tool_upgrade_required`、`codex_tool_wait_lease_expired`、`codex_tool_native_deadline`、`codex_tool_cancelled`、`codex_tool_operation_retired` 和 `codex_tool_infrastructure_failure`。Native 结果中的同名字段不作为桥接 pending 判断依据。

### 连接器迁移

当前生产名称为 `Codex Native3` 和 `Codex Zero Risk2`，Automatic DEV 为 `Codex Native3 DEV`。源代码、Launcher 文案、当前用户/运维文档和合同测试已同步；历史记录中的旧名称保留。旧生产连接器不原地改名或刷新，需按新名称创建；运行时和 helper 需要一起更新。

已有 DEV 探针与正式 DEV 名称相同。探针现在由已有 setup 选项显式保存的 `devNativeToolLongWaitProbe` 开启，不再仅看名称。普通 `Codex Native3 DEV` 不会注入模拟 Native 工具或误用探针的双工具合同。本轮没有修改实际用户配置。

### Review 修复

后续代码 Review 发现并已修复三项问题：普通 `codex_tool_call` 的公开 schema 现在要求 `operation_id`，仅 Automatic 的 `codex.control.compaction_handoff` 控制分支保留无 ID 例外；超过 identity 规范化嵌套上限的确定性资源拒绝现在也先绑定稳定 fingerprint 和 operation ID，可同描述重放并对异描述返回 conflict；当前用户/运维文档已统一到 `Codex Native3`、`Codex Zero Risk2` 和 `Codex Native3 DEV`，旧名称只在明确的迁移或历史说明中保留。

修复后实际运行 `bun run typecheck` 通过；`native-tool-operations`、`native-tool-long-wait`、`native-tool-long-wait-progress` 和 `launcher-helper-client` 四个相关测试文件合计 **47 pass、0 fail、306 次断言**。本次没有重跑完整核心全量或真实 11 分钟/Tunnel 验收。

## 实际验证

日志与产物均位于本机 `/tmp/codex-native-long-wait-request_5fsAEvZG/`。这个临时目录是当前本地证据，不是已发布的构建。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 核心类型检查 | 通过 | `typecheck-final.log` |
| Launcher 类型检查 | 通过 | `launcher-typecheck-final.log` |
| 三个新增 Native 测试文件 | 39 pass，0 fail，240 次断言；包含两种 MCP 模式真实 30 秒 pending | `native-final.log` |
| helper IPC 与旧 helper 拒绝 | 7 pass，0 fail，49 次断言；等待专用 frame 不伪造业务进展，旧 helper 在准备/发送前拒绝 | `helper-final.log` |
| Launcher 全量测试 | 484 pass，0 fail，1 skip | `launcher-tests-final.log` |
| 第一轮最终核心全量 | 1165 pass，3 fail，1 skip；后补旧 helper 测试不在该次计数中 | `full-tests-final.log` |
| HOME 隔离定向验证 | runtime-layout、tunnel-service、setup-lifecycle：30 pass，0 fail，138 次断言 | `home-isolation-check.log` |
| 最终 HOME 隔离全量 | 1167 pass，1 fail，2 skip；80 文件、1170 测试、7514 次断言；退出码 1 | `full-tests-isolated-home.log`、`full-tests-isolated-home.exit` |
| 生产 runtime 构建 | 通过；全新临时目录构建，没有覆盖现有 dist | `runtime-build-final/`，Native 命令实际退出码 0 |
| 构建产物验证 | 6,035 个文件通过 manifest 校验；编译 CLI 报告 6.0.1-2；Node helper 宣告等待协议并正常退出 | `artifact-verification.json` |

构建平台为 darwin/arm64，Bun 1.4.0，bundle ID 为 `a870a9bcf91e7ec91d435dfb27efb75af8c16ad2424dbbf03542465d9ad8ecf1`。没有运行安装器、部署、浏览器登录或完整真实浏览器 release smoke。

### 回归失败的归因

`tests/server-deploy.test.ts:157` 要求 `deploy/server/compose.yaml` 包含 `CODEX_UID` build 参数，但现有 compose 改为引用发布镜像。两份文件均未被本轮修改。用原始 HEAD 的这份测试和 `deploy/server/` 建立独立快照后，同一断言仍失败：0 pass、1 fail、10 filtered。证据为 `deploy-baseline-final.log` 和 `deploy-baseline-final/`。未修复无关部署文件，不能宣称全量全绿。

第一轮最终全量的另两项失败来自 production setup 的 `integrate` 回调断言。现有 `runtime-layout` 和 `tunnel-service` 测试清理时直接删除 `CODEX_CHATGPT_WEB_HOME`，原始 HEAD 也有同样代码；后续测试会回退到本机配置，仅在命令开头设置该变量不足以隔离。额外设置测试子进程 `HOME` 和 `CODEX_HOME` 后，这三份文件组合全部通过。没有为此修改 setup/API policy 产品逻辑或用户配置。

最终全量也验证了这个环境归因：两项 production setup 测试通过，仅保留上述部署断言失败。两项跳过分别为当前平台不适用的 Windows 恢复测试，以及隔离 HOME 下 Docker daemon 不可用时自动跳过的构建上下文探针；没有人为过滤测试。

最终全量使用以下子进程环境，不修改全局环境或用户文件：

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  -u CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG \
  HOME=/tmp/codex-native-long-wait-request_5fsAEvZG/test-os-home \
  CODEX_HOME=/tmp/codex-native-long-wait-request_5fsAEvZG/test-codex-home \
  CODEX_CHATGPT_WEB_HOME=/tmp/codex-native-long-wait-request_5fsAEvZG/test-home \
  bun test ./tests
```

## 验收覆盖与两轴自查

| 规格项 | 本轮证据与限制 |
| --- | --- |
| A0 | ID 校验、乱序到达、capability 隔离、相同 ID 复用和重连指令已测试；真实 ChatGPT 调用方的并发分配与 reconnect 计数器未重验 |
| A1、A2、A5 | 两模式 Broker/MCP 测试证明短结果直返、真实 30 秒 pending 和独立查询；11 分钟及租约边界使用可控时钟 |
| A6、A6a—A6c | 同 ID 重试、结果缓存、进程丢失和替换、参数冲突、拒绝后 registry 变化已测试；真实 Tunnel 首次回执丢失未重验 |
| A3、A4 | 可控时钟验证超过 10 分钟的等待证据与真实结果/拒绝续接；未打开真实输入或审批 UI 保留 11 分钟 |
| A7、A8 | 多模态、空内容、structuredContent、isError=false、_meta 和 pending 同名字段已测试；批次/gateway 复用既有 harness 回归 |
| A9、A10 | 两种完成屏障拒绝未领取结果；查询取消、MCP 退出后原操作保留，后续查询取回原结果 |
| A11—A13 | 显式取消、原生期限、退役、失联、挂起与 capability 隔离测试；页面关闭和中断复用既有生命周期回归，不代表真实平台实测 |
| A14、A14a、A21 | queued inventory 压缩控制终态、Broker handoff 后真实结果、fresh owner 不接管及迟到结果拒绝已测试；外层 fresh/fallback 复用现有 compaction 回归 |
| A15、A20 | 旧 MCP claim、缺少 ID、旧 helper 都在 Native 调度前拒绝；控制 handoff 无 ID 的隔离例外保留 |
| A16、A17 | 身份、查询、单份和累计上下文/结果上限，稳定拒绝、固定安全错误和资源保留已测试并自查 |
| A18、A19 | 异步 inventory 固定快照、分页、discovery_tools、默认值与 null 区分、动态 registry 首次准入和重放已测试 |
| A22 | 可控时钟跨过 600 秒，证明等待只暂停终止、不刷新真实 last-progress；真实结果仍续租，等待结束按原时间终止。真实远程部署链路未重跑 |

需求/设计轴自查对照用户授权、Spec v0.7 和原决定，核对 identity、准入、compaction 分界、完成屏障、等待证据和名称迁移。工程轴自查核对真实 diff、查询 try/finally 清理、owner observer 生命周期、资源上限、协议失败封闭及测试结果。本轮没有剩余已定位的范围内代码缺陷；现有部署断言失败与验证缺口如上保留。两轴均由实施者执行，**不是两份独立审查**。

## 仍需满足的交付条件

当前完成的是仓库实现和本地验证。独立代码审查尚未完成。正式更新运行时和连接器后，还需按 Spec §8.3 对 Automatic 与 Zero Risk 各执行真实 11 分钟输入场景，开启远程默认 600 秒 idle，并补测真实首次回执丢失、同 capability MCP/Tunnel reconnect、取消及非交互长调用。用户此前确认用于本次实施授权，不伪写为本轮重新取得的验收结果。

没有 Git commit，没有更新 ChatGPT 连接器/Tunnel，没有部署或重启用户环境。`scope-verification.json` 记录实施前文件的比对；`docs/dev/request-context-navigation/`、原探针文件和其他未涉及的已有改动保持原样。
