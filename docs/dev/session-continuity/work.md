# 会话连续性优先：实施与验收记录

## 范围与状态

2026-09-28，按用户的 `dev-build docs/dev/session-continuity/spec.md` 请求继续实际实施。
P0 已完成验证，以 [p0-work.md](p0-work.md) 的最后结果为准。代码基线为
`e7f0f603e7715bfebf561c21f3b41c0525c28014`，工作区版本 `6.1.1-1`。

P1—P4 的代码路径已接入；P5 已完成下列本地回归和合成资源测量，但尚有真实环境验证未覆盖。
用户已确认需求实现完成并移除额外发布门禁；兼容环境按现有配置条件提供六个连续性别名。
实施阶段没有推送、部署、安装或重启用户服务，没有切换用户 Launcher 模式，也没有操作真实 P0 页面。
当前环境不支持子代理；下述核查是实施者自查，不是两份独立代码审查。

## 已接入的工作项

| 工作项 | 实现与边界 |
| --- | --- |
| P1：路由和预算 | 双 Web 前缀统一分类；可信路由选择内部策略；目录历史预算与原单次输入限制分离；保持账户、effort、manual、Native/API-Key 及旧默认。连续性别名不再要求额外内部验证位。 |
| P2：登记和严格续接 | 显式 setup 初始化内容无关的持久登记；普通请求不初始化或修复。物理 key 稳定，执行按 scope/revision 隔离。首次完整输入先预检，后登记；后续增量必须证明当前来源和精确 owner/lease/head。Launcher/helper 与 manual start 都验证严格 claim。 |
| P3：同页压缩 | Automatic 活动/已完成路径和 Zero Risk 活动控制路径已接入同一事务。接受 handoff、物理收尾、权限退休后只提交一个 checkpoint/revision。同页继续，禁止 fresh fallback。已接受但未提交的摘要保留为有界证据，不授予续接权；普通 final 不被控制摘要替换。 |
| P4：生命周期和错误 | 逻辑/物理 ready 均按成功工作计 24 小时；查询、心跳和纯 final 重放不续期。保护健康页面和必要 source，安全回收旧 replay。五页容量在创建/剪贴板前拒绝。reload、丢页、重启、模式退出及配置冲突不能重建同一 thread。六类确定性非重试错误及人工交接说明已补齐。 |
| P5：组合验证 | Adapter/Broker/HTTP、核心全量、Launcher 全量及类型检查已运行；当前唯一全量失败已在未修改的 HEAD 部署快照复现。合成百万历史资源数据单列；真实平台和独立审查关口仍保留。 |

核心入口为 `continuity-request.ts`、`continuity-compaction.ts`、`continuity-binding.ts`、
`continuity-registration.ts`、`continuity-lifecycle.ts`，以及现有 Adapter、Launcher lease、
helper、compaction continuation 和 Responses 入口。Native operation identity、queued/delivered、
真实工具结果、完成屏障、权限期限、HTTP/cache 原边界没有为本模式放宽。

## 本次续行修正

恢复时 Adapter 测试为 34 项，其中 2 项失败。两项均是测试夹具问题：

1. HTTP v1 compact 测试误按 v2 的 `compaction` envelope 读取输出。现按原 v1 合同读取最后一条
   user summary message，并检查 `SUMMARY_PREFIX`；没有改变 v1 产品格式。local 和 v2 各保留原解析。
2. 普通 Native 路由的 mode-exit 测试没有携带必需的 Bearer 头。现仅增加明确的测试凭证，并同时
   断言 HTTP 状态及响应 JSON 状态；没有放宽上游鉴权。

README 中英文、架构、安全和发布验证说明已区分旧恢复模式与连续性模式。新增
[用户说明](../../session-continuity.md)，包含首次选择语义、预算拆分、停止原因和人工交接清单。

## 实际测试结果

日志在本机 `.dev-workflows/session-continuity/evidence/`。该目录是本地过程证据，不是发布产物。
测试使用独立临时 `HOME`、`CODEX_HOME`、`CODEX_CHATGPT_WEB_HOME`，清除代理变量；最终全量还清除
`CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG`。获准的沙箱外重跑只处理系统读取限制，不修改用户服务。

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| Adapter / HTTP 全量 | 34 pass，0 fail，467 次断言 | `p5-http-recheck.log` |
| 核心类型检查 | 通过 | `p5-typecheck-recheck.log` |
| 核心全量，沙箱内 | 1,243 pass，4 skip，2 fail；85 文件、1,249 项、8,480 次断言 | `p5-bun-full.log` |
| 核心全量，获准重跑 | 1,244 pass，4 skip，1 fail；85 文件、1,249 项、8,483 次断言 | `p5-bun-full-authorized.log` |
| Launcher 全量，沙箱内 | 445 pass，2 skip，1 fail；runtime-supervisor 文件在加载时被系统限制拒绝 | `p5-launcher-full.log` |
| Launcher 全量，获准重跑 | 515 pass，2 skip，0 fail；517 项 | `p5-launcher-full-authorized.log` |
| Launcher 类型检查 | 通过 | `p5-launcher-typecheck.log` |
| 部署 HEAD 快照对照 | 同一部署断言失败；0 pass，1 fail，10 filtered，4 次断言 | `p5-deploy-baseline.log` |
| 隔离运行时构建 | 通过；只输出到新的临时目录 | `p5-runtime-build.log` |
| 运行时产物校验 | 6,050 个文件及校验和通过；CLI 版本正确，helper 宣告两项必要协议并正常退出 | `p5-runtime-verification.json` |
| 最终连续性专项回归 | 54 pass，0 fail，4 文件，699 次断言 | `p5-final-focused.log` |
| 最终核心 / Launcher 类型检查及差异检查 | 均通过 | `p5-final-typecheck.log`、`p5-final-launcher-typecheck.log`、`p5-final-diff-check.log` |

核心全量的唯一剩余失败是 `tests/server-deploy.test.ts:157`：测试要求 Compose 包含 `CODEX_UID`
build 参数，而现有 Compose 使用发布镜像。测试和部署文件均未被本任务修改。在上述 HEAD 的独立
`/tmp/cgw-continuity-deploy-baseline.PEyOON/snapshot` 快照中已复现相同失败；未修改无关部署合同，
因此不能声称全量全绿。

沙箱内另一项核心失败来自 macOS 进程启动身份读取；获准重跑后通过。Launcher 的沙箱失败为
`uv_uptime EPERM`，导致 runtime-supervisor 测试文件无法加载，故两次测试总数不同；重跑后全部
适用用例通过，没有为消除失败而跳过该文件。核心四项 skip 为两种 Billing 检查布局、不可用 Docker
构建探针和 Windows 专用历史路径测试；Launcher 两项为 Linux AppImage 进程身份和 Windows 安装器
专用测试，详见对应日志。

构建位于 `/tmp/cgw-continuity-p5-build.vPQg7m/runtime-bundle`，不覆盖仓库产物或用户安装。
使用 Launcher 自身的 `validateRuntimeBundle` 校验完整清单，运行产物 CLI 的 `--version` 得到
`6.1.1-1`。打包 helper 在只收到 shutdown 帧的进程中报告 `native-tool-wait-v1` 和
`session-continuity-v1`，随后以 0 退出；未发 run 帧、未打开浏览器。这不等于账户绑定的集成验收。

## 合成资源测量

本地脚本 `.dev-workflows/session-continuity/measure-resources.ts` 使用固定合成记录，不读取用户内容，
不启动监听端口、浏览器或 Native 操作。环境为 macOS arm64、Bun 1.4.0；两个模式分别在独立进程和
临时 HOME 下运行。数据由实际 HTTP decoder、parser、usage、输入预检和 Responses cache 处理。
这是组件测量，不是可信 source/lease 归属证明，也不等于模型支持此历史规模。

| 指标 | Automatic | Zero Risk |
| --- | ---: | ---: |
| 规范输入消息数 | 353 | 353 |
| 编码/解码字节数（identity 编码） | 4,854,513 | 4,854,520 |
| 规范输入估算 tokens，含执行封装余量 | 1,028,947 | 1,029,098 |
| 短增量估算 tokens，含执行封装余量 | 9,258 | 9,268 |
| HTTP decode | 13.50 ms | 12.03 ms |
| parse | 6.92 ms | 6.67 ms |
| 完整历史 usage | 563.71 ms | 552.37 ms |
| 增量预检和 usage 合计 | 2.38 ms | 1.70 ms |
| 缓存压力及快照排除后最大采样 RSS | 798,982,144 bytes | 788,103,168 bytes |

两次均证明短增量通过原输入预检，而整个合成历史作为首次输入返回 `continuity_input_limit`。
向原 Responses cache 连续写入 25 份独立解析的历史后，最旧记录被容量回收、最新记录仍可展开；
超过单条磁盘上限的记录全部被排除在快照之外。没有提高 HTTP 或缓存限制。

结果文件为 `p5-resources-automatic.json` 和 `p5-resources-manual.json`，对应错误日志为空。
最大采样 RSS 不是精确进程峰值；约 0.8 GB 包括压力场景、序列化临时分配和运行时内存，不可将
64 MiB 缓存权重上限误写为进程内存上限。这里尚未测量五个真实网页的内存、checkpoint 运行时
占用或持续负载性能，不能据此宣布资源验收通过。

## 自查覆盖和剩余关口

需求/设计轴自查核对了版本/账户/模型门槛、首次激活、输入预算、精确 scope/revision、普通答案与
摘要分离、Zero Risk 停止、24 小时和五页保护。工程轴自查核对了真实 diff、claim/lease 验证、
accepted-but-uncommitted 证据、source 字节预算、预留 token 余量、模式退出、旧 cleanup 和缓存回收。
HTTP 回归还覆盖页面仍在但 `previous_response_id` 超过一小时失效后返回 409，以及完整规范历史
重发后继续原页。页面与人工动作均由夹具模拟，未冒充真实 ChatGPT 验收。

剩余验证覆盖：隔离环境的真实 Automatic/Zero Risk 产品同页闭环；五页真实内存、checkpoint/replay
占用和持续负载；真实 24 小时保留；目标组件/平台及远程 idle 组合；两份独立代码审查。
详见 [发布验证](../../release-validation.md#session-continuity-validation)。这些未覆盖项必须明确记录，
但不再通过额外运行时验证位阻止别名可用。

## 2026-09-29 提交前复核

提交前重新按规格检查了路由/预算、持久登记、严格 owner/lease/head、同页压缩、生命周期、Launcher
容量与健康管理接口。复核补了两个同一资源边界问题：观察型 TTL prune 在 ordinary replay tombstone
满额时保留该历史 execution 并继续扫描，不再让 `/healthz`、drain 或 resume 泄漏任务级容量错误；
admission 在最老历史项因 tombstone 满额不可回收时会继续寻找其它安全候选，只有所有候选都无法
回收时才返回 `continuity_resource_capacity`。对应 lifecycle 和 server 回归已加入。

本轮专项回归在修改后通过：连续性 lifecycle 8 / 8；连续性 input/state/adapter、retained compaction、
BrowserWorker 合并检查此前为 288 / 288；核心 TypeScript 和 `git diff --check` 通过。setup lifecycle
在隔离 `HOME` / `CODEX_HOME` / `CODEX_CHATGPT_WEB_HOME` 并清除本机手工 Codex 配置变量后 7 / 7
通过；非隔离运行会按本机现有客户端策略跳过生产 Codex integration，因此不能作为仓库回归结果。
发布验证文档现包含本文引用的连续性验证章节。提交仍不等于剩余真实平台、24 小时、资源负载、
远程 idle 或独立双轴审查已经完成。

最终提交前复跑 `bun test ./tests` 得到 1298 pass、4 skip、2 fail。`tests/server-deploy.test.ts:157`
仍是上文已在未修改 HEAD 快照复现的基线失败；另一个 PID 启动身份用例在受限沙箱中因 `/bin/ps`
返回 EPERM 失败，允许真实进程身份读取后单独复跑 1 / 1 通过。Launcher 全量在同样允许系统能力
的环境中复跑为 516 pass、2 skip、0 fail。没有为这些环境差异修改连续性实现或跳过适用测试。
