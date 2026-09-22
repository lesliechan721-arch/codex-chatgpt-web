# 独立 API Key 模式：设计、使用与验收

## 1. 范围与基线

本次调整基于 fork 最新 `main` 的 `da4c09b6f0eac4cd0a7f316e22cbd28ce0814630`，包含已经合并的 API 模式、Launcher GUI、全局代理和上游更新。

目标是简化接入设置，同时将「服务端接入策略」与「用户手动维护的 Codex 配置」分开。HTTP 接入仍有 `openai` / `api-key` 两种模式，与 `browser-only` / `full`、`automatic` / `manual` 是独立维度。

未配置自定义上游时，API 模式保持 Web-only：`chatgpt-web/*` 继续使用 ChatGPT 浏览器适配器，非 Web 模型以及原生搜索/图片端点不会转发。配置可用的 OpenAI 兼容上游后，非 Web Responses、search 和 images 请求按保存的上游、模型筛选和代理策略转发；`chatgpt-web/*` 始终保留给本地 Web 路由。OpenAI 转发模式不读取该上游配置。Full / Zero Risk 仍使用原有 Tunnel 与 Connector。

## 2. Launcher 使用流程

入口：**Settings → 接入模式**。

- 点击 **OpenAI 转发** 或 **API Key** 选择服务端接入模式，不再有一个独立的「应用配置」步骤或二次确认框。
- 第一次启用 API 模式、又没有可复用的密钥时，先显示密钥输入框。可以输入或随机生成；通过校验后点击「保存并切换」。没有有效密钥不会启用 API 模式。
- 已有可复用的密钥时，点击 API 模式直接保存并尝试重启后台。
- API 模式下显示掩码密钥；「查看 / 隐藏」「复制密钥」「重置密钥」分别负责显隐、复制和更新。重置使用同一个紧凑输入框，保存新密钥后尝试重启后台。
- Base URL、上游设置、「复制 Codex 配置」「导出 TOML」及导出预览仅在 API 模式下显示。Codex TOML 是显式敏感导出，包含当前本地服务 API Key，但不包含自定义上游 API Key；代理环境与 TOML 分开显示。

界面主要显示「已保存并生效」或「已保存，后台尚未加载」，而不是要求用户理解多个配置阶段。暂未生效时显示当前运行模式，并提供「重试重启」。未初始化后台也允许保存模式与密钥，初始化后生效。

API Key 允许 32–256 个 ASCII 字母、数字、`-`、`_`；随机生成使用 `randomBytes(32)`，不是可预测的时间戳或 `Math.random()`。

## 3. 保存成功与后台生效是两件事

```text
校验输入、旧配置 revision、管理令牌不可复用
    ↓
原子保存 api-access.json                 ← 设置在这里提交
    ↓
按模式清理旧注入 / 尝试恢复 OpenAI 路由
    ↓
尝试在当前 Launcher 内重启受监督后台
    ↓
读取 health 的策略 revision 确认生效
```

**不能停止或启动后台，不会回滚已保存的模式或密钥。** 但也不会谎报新密钥已经生效。

具体行为：

| 情况 | 配置保存 | 运行时处理 |
| --- | --- | --- |
| 后台空闲、由 Launcher 管理 | 保存 | 使用现有 `stopForSetup()` 排空/停止，再 `startIfConfigured()` |
| 有 HTTP、浏览器或 MCP 活动任务 | 保存 | 不强制取消，标记待重启 |
| 另一个 Launcher 配置操作正在运行 | 保存 | 延后配置清理与重启 |
| 受控停止失败 | 保存 | 旧实例继续使用旧策略，界面显示待生效 |
| 新实例启动失败 | 保存 | 不恢复旧密钥，显示停止或待生效 |
| 外部管理的后台 | 保存 | 不擅自终止外部进程，由其管理器重启 |
| 尚未初始化运行时 | 保存 | 等待初始化，不创建伪运行状态 |
| 输入无效、磁盘写入失败、过期 revision | 不保存 | 返回明确错误，不开始重启 |

这里的「热重启」是**不退出 Launcher 的后台子进程重启**，复用现有 supervisor 生命周期。不是在线替换 daemon 内存中的鉴权策略，也没有新增可由客户端密钥调用的热更新管理接口。Full 模式按现有监督流程处理 Tunnel。

运行时策略仍在服务启动时加载。在成功重启之前，旧密钥可能仍然有效，新密钥可能尚不可用。仅当 health 的 `api_access_revision` 与磁盘策略、管理令牌计算出的 HMAC 一致，且后台接受任务时，GUI 才显示生效。轮换后应更新客户端的环境变量并启动新的 Codex 进程。

本次没有增加后台定时重启队列。任务完成后可点击「重试重启」或正常重启 Launcher；不会在任务中途强行兑现排队的重启操作。

## 4. 密钥存储、查看与迁移

### 4.1 服务端鉴权文件不变

应用私有目录中的 `api-access.json` 保持 version 1：

```json
{"version":1,"mode":"api-key","keySha256":"<64 位小写十六进制 SHA-256 摘要>"}
```

OpenAI 模式为 `{"version":1,"mode":"openai"}`。文件不存在时保留旧版 OpenAI 转发行为；文件损坏不静默降级。

服务端继续使用摘要校验密钥。客户端 key、daemon `controlToken`、Tunnel runtime key 互不替代。模式/密钥变更不扩展管理接口权限。

### 4.2 新增仅供 GUI 的可恢复副本

为了实现「查看已保存密钥」，主进程增加 `secrets/api-client-key.json`：

```json
{"version":1,"digest":"<对应密钥摘要>","ciphertext":"<OS 加密密文的 Base64>"}
```

GUI 正常切回 OpenAI 模式时，还会用 `secrets/api-client-key-reuse.json` 记录允许复用的密钥摘要。

使用 Electron `safeStorage.encryptString/decryptString`；密文原子写入 owner-only 文件。主进程仅在用户明确点击查看、复制或需要复用时解密，状态刷新不会解密。

Linux 的 `basic_text` 和 `unknown` 后端不当作安全存储。OS 加密、密钥库或密文写入不可用时，不把明文降级写入磁盘；本次会话可在主进程内存里查看/复制密钥，GUI 提示用户自行备份。鉴权摘要已正常保存，所以这种情况不阻止模式切换。

密钥不进入 `launcher-state.json`、普通 snapshot、广播事件或操作日志。只有用户明确执行「复制 Codex 配置」或「导出 TOML」时，当前本地服务 API Key 才作为 `experimental_bearer_token` 进入该次敏感导出。自定义上游 API Key 不进入 Codex TOML。查看通过独立 IPC 返回给可信主窗口，切换状态、隐藏、失去窗口焦点或卸载组件会清除已显示的字符串。剪贴板 60 秒后只在内容仍为该密钥时清除，不清除后来复制的内容；系统剪贴板历史不在保证范围内。

### 4.3 旧密钥与 CLI 密钥

旧安装、CLI 生成/导入的密钥可能只有摘要，**无法从 SHA-256 还原明文**。这种密钥仍可认证，但不能凭空显示。用户可以继续使用原来备份的值，或从 GUI 重置以建立新的加密副本。

外部 CLI 写入接入策略时会删除 GUI 复用标记。CLI 轮换后，旧的 GUI 加密副本必须与当前摘要匹配才允许查看；CLI 随后关闭 API 模式也不能重新启用旧密钥。GUI 从 API 模式退出时也会丢弃不匹配的副本，避免后续复用它。

本机操作系统账户、进程内存和密钥库权限仍是安全边界；这不是多租户凭证保险库。

## 5. API 模式下 Codex 配置只由用户导入

### 5.1 不再自动注入

API 模式下，以下路径均不安装新的 Codex 路由、provider 或 hooks：

- Launcher 初始化、MCP/浏览器交互设置、能力刷新、运行时升级最终进入的 `setup()`；
- `route connect/disconnect`；
- 子代理协议切换；
- daemon `serve` 启动。

它们只允许清理先前有 ownership journal 记录的注入。`auth.json`、用户手动维护的 provider/table 不会被自动生成或覆盖。普通本地安装的 GUI 导出会生成应用目录内的 `api-key-models.json` 并返回 TOML；用户自行选择粘贴/合并位置，或通过下载保存 TOML。

服务端远程桌面部署使用 `CODEX_CHATGPT_WEB_MANUAL_CODEX_CONFIG=1`。该模式下，setup、route、subagents 和 reconnect 都不会修改容器内或外部客户端的 Codex 配置。导出结果同时返回 TOML、模型目录内容和客户端目标路径；服务端不会为了外部 Codex 把模型目录写到自己的 HOME。外部客户端必须自行复制这两个文件。

### 5.2 旧注入清理

新增 `cleanupApiKeyCodexIntegration()` 和 `api-key cleanup`。GUI 启用 API 模式、CLI enable/rotate、setup 以及 daemon 启动会尝试清理。

清理以现有 integration journal 为权威，使用原项目的 `replacementBaseline()` 恢复逻辑：只移除/恢复仍由本安装持有的 route、feature、agent depth 与 Interrupt hook。用户后来修改的 `model_provider`、`model_catalog_json`、其他 provider、MCP、skills 等保留。

- 没有 journal：不根据相似字段或 URL 猜测所有权，手动复制的配置原样保留。
- 有 journal 但 config 已被用户删除：不为了清理而重建空配置。
- 所有权路径不匹配或 hook 被修改：报清理冲突，不强删、不覆盖。
- 正常清理后删除旧 journal/recovery 与旧模型缓存，使下一次 API setup 不再重新注入。
- 有多个文件更新时保留快照并补偿失败；写入前检查目标是否被并发修改。

清理冲突不会撤销已经保存的接入模式；GUI 显示待清理。可以解决冲突后点击重试或运行 `api-key cleanup`。无 journal 的疑似残留需要人工核对，不能安全推断安装前的值。

切回 OpenAI 模式时，GUI 尝试 `api-key reconnect` 恢复原生转发集成，但不强制覆盖冲突的路由。失败仍保存选择，并通过 `api-access-routing-pending.json` 在 Launcher 重启后继续提示恢复未完成；成功重连、setup 或 route connect 会清除该标记。此前手动选择的 `model_provider` 不会擅自删除，用户需要核对客户端实际选择。

## 6. 导出配置补齐哪些内容

原转发集成的可兼容配置复用现有代码生成，不复制另一套默认值：

| 配置 | API 导出策略 |
| --- | --- |
| 自定义 `model_provider` / 模型 / effort / `model_catalog_json` | 保留 API 模式已有导出 |
| `experimental_bearer_token` / `requires_openai_auth = false` / Responses wire API | 保留；`experimental_bearer_token` 写入当前本地服务 API Key，不再输出 `env_key` |
| `supports_websockets = false` | 保留，仅使用已有 HTTP/SSE transport |
| `web_search = "disabled"` | 保留，不调用被禁止的原生搜索端点 |
| `[features] multi_agent = true` | Compatibility V1 模式导出，与自动集成一致 |
| `[features] multi_agent_v2 = false` | Compatibility V1 模式导出；native 模式不强制降级 |
| `[agents] max_depth` | 复用 V1 默认值，当前为 2；用户已有更高值可自行保留 |
| `[[hooks.Interrupt]]` | 普通本地 API 模式导出相同 runtime command、应用 home 与 timeout=3；服务端远程桌面部署不导出容器内命令 hook |
| `openai_base_url` | 排除；API 模式使用自定义 provider 的 `base_url` |
| `experimental_realtime_webrtc_call_base_url` | 排除；它依赖原生 OpenAI 身份，与独立 API 接入目标冲突 |
| `[hooks.state] trusted_hash` | 排除；用户选择的目标文件与 hook index 未知，不伪造预批准状态 |
| 自定义上游 API Key、OAuth、Tunnel 凭证 | 永不导出；本地服务 API Key 只在用户显式执行 Codex 敏感导出时写入 TOML |

从共享 feature builder 生成值之后，移除自动管理注释：手动导出的设置归用户，不冒充新的一次受 journal 管理的安装。

普通本地安装的 Interrupt hook 导出的是声明，不是自动授权。用户合并后按 Codex 的提示批准该命令。服务端远程桌面部署不依赖客户端命令 hook 来保证正确性；它继续使用 HTTP 断开取消，并额外启用 native turn 的无进展 idle timeout。已有 `[features]`、`[agents]` 或 hooks 时按字段合并，不要直接追加重复 TOML table，也不要重复导入同一个 hook。

## 7. 使用示例

### Launcher

1. 完成原有 ChatGPT/运行时初始化；也可以先保存接入模式，之后初始化。
2. Settings 中选择 API Key，必要时输入/生成密钥并保存。
3. 确认状态已生效；若提示待重启，结束任务后重试。
4. 查看或复制密钥，复制/导出含本地 API Key 的敏感 Codex 配置，并手动合并到目标 `CODEX_HOME/config.toml`；同时按导出结果设置独立的 Codex 进程代理环境。
5. 重新启动 Codex。导出的 provider 已通过 `experimental_bearer_token` 携带本地服务 API Key，不再要求 Codex 通过 `env_key` 读取它。浏览器登录仍独立存在。

### CLI

```bash
# 新启用；生成值只出现在 stdout，不放到命令参数里。
CODEX_CHATGPT_WEB_API_KEY="$(bun run src/cli.ts api-key enable --generate)" || exit 1
export CODEX_CHATGPT_WEB_API_KEY

# 显式重试有 journal 记录的旧注入清理。
bun run src/cli.ts api-key cleanup

# CODEX_CHATGPT_WEB_API_KEY 必须仍是当前 policy 对应的本地密钥。
# 输出的 TOML 含该本地密钥，并另外输出 Codex 进程代理环境；不会写入 ~/.codex/config.toml。
bun run src/cli.ts api-key codex-config
```

CLI 修改仍需通过已有服务管理方式重启。GUI 的「查看」仅能读取 GUI 创建的可恢复副本；CLI 输出值请自行保存。模型权限、交互模式、上下文或子代理设置更新后应重新导出模型目录/配置。

## 8. HTTP、代理与执行边界

所有 `/v1/*` 请求仍先检查本地 Bearer。未配置可用上游时，API Key 模式保持 Web-only：`/models`、`/responses`、`/responses/compact` 使用本地 ChatGPT Web 路由，非 Web 模型和 search/images 端点继续拒绝。配置可用上游后，`/models` 合并经过筛选的上游目录，允许的非 Web `/responses` 与 `/responses/compact` 转发到上游，并开放 `/v1/alpha/search`、`/v1/images/generations`、`/v1/images/edits`。`chatgpt-web/*` 始终走本地 Web 路由，不能被上游覆盖。

普通本地安装继续仅监听 `127.0.0.1`。服务端远程桌面部署是受约束的例外：只有已保存的接入策略为 API Key 时，部署环境才允许 Responses 在容器内监听 `0.0.0.0`；Compose 仍只把该端口发布到宿主机 loopback，外部 Codex 通过现有 HTTPS 反向代理访问 `/v1`。反向代理不能公开 `/healthz`、`/admin/*`、CDP 或原始 VNC 端口。配置远程公开 Base URL 时必须使用以 `/v1` 结尾的 HTTPS URL；留空表示同宿主机客户端使用 `http://127.0.0.1:<port>/v1`。

服务端远程桌面部署还可以设置 native turn 无进展 idle timeout，当前部署变量为 `REMOTE_TURN_IDLE_TIMEOUT_SEC`，默认值为 600 秒。它不限制整个 turn 的总执行时间。同一个 `thread_id + turn_id` 共用一份 idle lease；文本/推理增量、工具调用产生、工具结果返回和 compaction 实际进展可以续租，retry/continuation 请求本身、adapter/browser heartbeat 和 TCP 存活不能续租。工具调用发出后若一直没有结果，idle 时间继续累计。超时后会终止对应 HTTP/browser/compaction ownership，并拒绝同 identity 重新建立 lease。普通本地安装不默认启用这项部署超时。

自定义上游网络使用三态策略：`global` 复用当前全局代理，`direct` 强制直连且不修改进程代理环境，`custom` 只使用指定 HTTP/HTTPS 代理。普通本地 Codex 客户端连接 loopback；服务端部署的外部 Codex 使用导出的公开 Base URL 或宿主机 loopback fallback。导出的启动环境把 loopback 合并到 `NO_PROXY`，并仅在 Launcher 有全局代理时导出对应代理变量。应用自己的 control token、本地客户端 API Key 与上游 API Key 仍严格分离。

JSON/SSE、MCP tool loop、continuation、v1/v2 compaction、Luna checkpoint 使用原实现。本次仅在配置导出中把相应客户端能力声明补齐。

## 9. 主要文件

| 文件 | 职责 |
| --- | --- |
| `launcher/src/ApiAccessSettings.tsx`、`api-access.css` | 简化模式切换、密钥和复制/导出界面 |
| `launcher/electron/api-access-settings.cjs` | 保存优先、受控重启、清理与生效状态 |
| `launcher/electron/api-key-vault.cjs` | OS 加密副本、显式解密、会话内退化 |
| `launcher/electron/upstream-api-key-vault.cjs` | 上游 API Key 的独立 OS 加密副本与会话内退化 |
| `launcher/electron/upstream-provider-config.cjs`、`upstream-provider-network.cjs` | 上游配置校验/原子保存与 Launcher 手动模型获取网络 |
| `launcher/electron/api-access-ipc.cjs`、`preload.cjs` | 可信 renderer 的最小 IPC 表面 |
| `src/api-key-integration.ts` | 基于 journal 的旧配置清理 |
| `src/setup.ts`、`src/cli.ts`、`src/api-key-cli.ts` | 防止 API 模式自动注入的入口守卫 |
| `src/api-key-codex-config.ts` | 渲染包含本地 bearer 的敏感 Codex 配置，并生成分离的进程代理环境 |
| `src/upstream-provider.ts`、`upstream-provider-config.ts` | daemon 上游配置、运行时快照、筛选与 revision |
| `src/upstream-network.ts`、`upstream-passthrough.ts` | 三态 transport 与 OpenAI 兼容上游转发 |
| `src/upstream-model-catalog.ts` | 合并并筛选本地与上游模型目录 |

## 10. 验证与验收

实现已在 Bun 1.4.0 环境完成仓库验证。为避免本机已启用的 API Key policy 和进程启动时继承的代理变量污染测试，完整 Core/`verify` 使用临时 `CODEX_CHATGPT_WEB_HOME`，并在启动测试进程前清除继承的 HTTP(S)/ALL proxy 变量。该隔离只影响测试进程，不修改真实 Launcher 或用户配置。

- `bun test ./tests`：通过。
- `bun run --cwd launcher test`：通过。
- `bun run typecheck`、`bun run --cwd launcher typecheck`：通过。
- `bun run --cwd launcher build`、`bun run build`：通过。
- `bun run verify`：通过；包括版本检查、根/Launcher 依赖审计、上述全量测试与类型检查、Launcher 构建、runtime bundle、第三方 notices 和 release smoke。

自动化测试使用真实文件系统与注入的 supervisor/safeStorage 模拟。它不等同于真实 Electron OS 密钥库、真实第三方上游或 ChatGPT 账户端到端测试；这些场景仍应在发布验收时按需复核。

建议复核：

1. 首次选择 API 时必须先有合法密钥；已有 GUI 密钥可复用。密钥重置、切换不再需要额外 Apply/备份确认。
2. 注入 stop/start 失败，确认配置仍保存，旧后台继续服务时不显示新密钥已生效。运行中任务不被取消。
3. 关闭/重开 Launcher 后，通过系统加密副本查看新密钥；Linux 无密钥库时只有会话内可查看且不落明文。
4. 从 OpenAI 注入迁移，确认 route/features/hook 被清理，而手动 provider、MCP、skills 保留；修改 hook 的冲突不能误删。
5. API 模式反复 setup、升级、切换浏览器模式/子代理协议、重启，不重新生成 Codex 注入。无 journal 的手动配置逐字节不变。
6. 手动导出的 TOML 可解析；包含当前本地服务 API Key 的 `experimental_bearer_token`、对应 V1 子代理配置和 Interrupt 声明，不包含上游 API Key、原生路由或路径相关 trust state；代理环境保持独立输出。
7. 配置一个测试上游，分别验证 `global`、`direct`、`custom` 网络模式、模型筛选、手动获取模型、Responses/compact、search/images，以及 `/models` 上游失败时回退到本地新鲜目录。
8. 用无 OAuth 的客户端连接，验证本地 Web models、流式回答、MCP 工具循环、取消及压缩；未授权请求仍被拒绝，`chatgpt-web/*` 不被自定义上游覆盖。
9. 检查本 fork 全局代理以及最新上游 Skills as files 设置不受此次改动影响。
