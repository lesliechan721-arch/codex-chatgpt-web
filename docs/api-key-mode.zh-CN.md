# 独立 API Key 模式：设计、使用与验收

## 1. 目的与实现基线

本功能基于 fork 的 `main` 提交 `d98ce92f6e0b46266ea460d3bccad8da14c09325`（包含全局代理及 Electron 代理规则修复）。目标是让 Codex 使用一个**本地服务密钥**连接 ChatGPT Web bridge，而不必以 OpenAI OAuth 身份登录 Codex，也不再依赖官方 Codex `/models` 返回的模型模板。

新增的是 HTTP **接入模式**，不替代原有执行模式：

| 维度 | 可选值 | 职责 |
| --- | --- | --- |
| HTTP 接入 | `openai` / `api-key` | 原生转发还是本地鉴权、Web-only 路由 |
| 执行能力 | `browser-only` / `full` | 是否桥接外层 Codex 工具 |
| 网页交互 | `automatic` / `manual` | 自动浏览器或 Zero Risk 人工发送 |

旧安装没有新增配置文件时仍使用 `openai`。本次实现不改动全局代理配置、Electron 代理控制器、浏览器交互、MCP broker、SSE 编码、上下文编译或压缩算法。

**边界：不再转发原生 OpenAI/Codex HTTP 接口，不等于不访问 OpenAI。** 推理仍通过已经登录的 ChatGPT 浏览器完成；Full / Zero Risk 仍使用已有 Connector 和 Tunnel。该密钥不是 OpenAI API key，不会购买额度、赋予 Pro 权限或绕过账号限制。

## 2. 请求架构

```text
Codex 自定义 provider
  env_key = CODEX_CHATGPT_WEB_API_KEY
  requires_openai_auth = false
          |
          | Authorization: Bearer <本地密钥>
          v
127.0.0.1:<port>/v1/*
          |
          +-- 统一鉴权失败 ----------------------> 401
          +-- 非允许端点 ------------------------> 404 / 405
          +-- GET /models -----------------------> 本地模型目录
          +-- POST /responses[/compact]
                       |
                       +-- 非 chatgpt-web/* ------> 400（禁止转发）
                       +-- 不可用/未知 Web model -> 400（禁止回退）
                       +-- 可用 Web model
                                  |
                        原有 parser / adapter / MCP / compaction
                                  |
                        清除客户端凭证后的浏览器侧调用
                                  |
                           原有 JSON / SSE 响应
```

`startServer()` 在打开监听器或 broker 前读取、校验并冻结接入策略。每个 `/v1` 请求先过鉴权和端点白名单；`modelsRequest`、`responseRequest`、`compactRequest` 也执行鉴权，避免直接调用这些处理器时误越过边界。

这些导出处理器保留默认 legacy 策略，供现有受信任的进程内 DEV 调用使用；公开 HTTP 分派器始终显式传入已加载的策略。它们不是新的未鉴权 HTTP 入口。

## 3. 配置及凭证分离

### 3.1 独立配置文件

位置：`<CODEX_CHATGPT_WEB_HOME>/api-access.json`，默认应用私有目录 `~/.codex-chatgpt-web/`。

```json
{
  "version": 1,
  "mode": "api-key",
  "keySha256": "<64 位小写十六进制 SHA-256 摘要>"
}
```

以上摘要仅为占位符，不能直接作为有效配置。建议始终通过 CLI 生成文件。

关闭时显式写入：

```json
{"version": 1, "mode": "openai"}
```

采用独立文件而不是扩展通用 `config.json`，是为了避免 Launcher、setup、升级及账号能力刷新重新写通用配置时丢失鉴权开关，也避免把凭证混入通用状态输出。CLI 与服务使用相同的 `--home` / `CODEX_CHATGPT_WEB_HOME` 解析规则。

没有文件是唯一隐式兼容旧模式的情况。格式错误、未知版本/字段、缺失摘要、超大文件、非普通文件（包括符号链接）及读取失败都拒绝启动，不能静默降级到原生转发。显式 `api-key disable` 可作为损坏配置的恢复操作。**删除文件会在下次启动恢复旧模式，不是撤销所有访问的手段。**

### 3.2 三种凭证互不替代

| 凭证 | 用途 | 保管方式 |
| --- | --- | --- |
| 本地客户端 API Key | `/v1/*` 客户端接入 | 服务只保存摘要；客户端从环境变量读取 |
| `controlToken` | 已有 `/admin/*` 管理接口 | 沿用原设计，客户端密钥不能使用它 |
| Tunnel runtime key / 浏览器 session | 原有工具连接与 ChatGPT 登录 | 原有机制，本次不修改 |

生成使用 `randomBytes(32)`，输出 `cgw_` 加 base64url，随机部分为 256 bit。导入值限制为 32–256 个 ASCII 字母、数字、下划线或连字符；长度合格不意味着人工选择的重复字符足够安全，推荐随机生成。

只存 SHA-256 是因为密钥应是高熵随机值，不是人类密码。比较使用等长摘要和 `timingSafeEqual`。保存复用现有 `atomicWriteFile`，文件权限 `0600`、私有目录 `0700`；Windows 沿用现有 ACL/文件权限处理，不能把 POSIX mode 当作完整的 Windows ACL 保证。

客户端密钥不得与 `controlToken` 相同，CLI 导入和服务启动均检查。客户端密钥没有 `/admin/*` 权限，管理令牌也不能用于 `/v1/*`。

### 3.3 生效与轮换

策略在进程启动时快照，**不是热更新**。启用、关闭、轮换后必须通过现有受控流程停止活动任务并重启服务或 Launcher。旧进程继续使用旧策略/旧密钥；不能把“配置已保存”误认为“旧密钥已立即撤销”。

`api-key status` 返回 `configured_mode`，表示磁盘配置；`/healthz` 的 `access_mode` 表示当前运行实例。两者不一致时需要重启或核对是否使用了相同 home/端口。

## 4. API 行为矩阵

以下均指 `api-key` 模式。除 `/healthz` 和已有 `/admin/*` 外，先鉴权再检查路由。

| 请求 | 行为 |
| --- | --- |
| 缺失/错误/格式错误的 Bearer key | 401 `invalid_api_key`；不读 JSON、不启动 adapter、不向上游发请求 |
| `GET /v1/models` | 200，本地可用 Web 模型，包含 Codex `models` 与兼容客户端的 `object/data` |
| `POST /v1/responses`，合法 Web model | 原有 JSON / SSE、工具调用及 continuation |
| `POST /v1/responses/compact`，合法 Web model | 原有 v1 压缩路径 |
| `/responses` 中 `compaction_trigger` | 原有 v2 压缩路径 |
| 缺失 model 或原生 model | 400 `model_not_supported`；绝不 fallback/passthrough |
| 不存在或当前账号/模式不支持的 Web model | 原有路由验证返回 400 |
| Luna 独立 compact | 沿用原有 409；Luna 保持 rolling checkpoint |
| `GET /v1/responses` | 鉴权后返回原有 426；本地仍只支持 HTTP/SSE，不新增 WebSocket |
| 已知端点的其他 method | 405，并带 `Allow` |
| `/v1/alpha/search`、`/v1/images/*`、`/v1/chat/completions` 及其他未知端点 | 404 `endpoint_not_supported` |
| `GET /healthz` | 继续允许本机探活；新增 `access_mode`，没有密钥或摘要 |
| `/admin/*` | 完全保留原有 `controlToken` 鉴权 |

不支持 URL query、JSON body、`x-api-key` 作为替代鉴权。不添加 CORS 或匿名 OPTIONS 放行。拒绝合并的重复 Authorization 和包含空白的 token。错误信息不反射凭证。

在调用 Web adapter 前，复制并移除 `authorization`、`proxy-authorization`、`x-api-key`、`cookie`、`chatgpt-account-id`、`openai-organization`、`openai-project`；保留 `x-codex-*` 等任务元数据。客户端凭证不应进入浏览器、Connector 或 adapter trace。客户端自己将密钥写入 prompt/body 的情况不属于 HTTP header 清理可以解决的范围。

## 5. 独立模型目录

原有 `augmentNativeModelCatalog` 需要官方模型模板。API 模式不能先调用官方 `/models` 再过滤，那仍然依赖 OAuth 并泄漏本地密钥。

新增 `buildStandaloneModelCatalog()` 使用**项目自有模板**，再复用：

- `availableChatGptWebModelRoutes(config)`：账号资格、Automatic/Zero Risk、Pro/Luna 等可见性；
- `buildChatGptWebModel(template, route, config)`：模型名称、固定 reasoning effort、modalities、上下文窗口与自动压缩阈值。

内部模板不会作为模型行返回。所有公开 ID 均是 `chatgpt-web/*`，不继承官方 Fast/service tier、不复制 `comp_hash`。保留 `supported_in_api: true`、工具能力字段和必要的 Codex `ModelInfo` 字段。

模板指令是项目内的简短 coding assistant 约束，不冒充完整的官方 Codex system prompt。原本由官方 catalog 注入的模型特定指令和未来新增字段不会自动同步；这是断开上游依赖的维护成本。对 Codex 新版本应重验 ModelInfo、工具模式及 subagent 协议兼容性。

提供 `api-key codex-config`，将 `{models:[...]}` 写入私有 `api-key-models.json`，并输出引用它的 TOML。这样不依赖客户端在 API-key/自定义 provider 下如何刷新远端 `/models`。远端接口依然可以给支持它的客户端使用。

**本地目录是快照。** 更改浏览器交互模式、账户模型资格、Zero Risk Pro、Bigger Context 或 subagent 配置后，重新导出目录并重启 Codex。服务端仍会检查真实当前配置，不能靠旧目录获得额外模型权限。

## 6. CLI 与接入步骤

### 6.1 前提

这是现有 bridge 的附加接入方式，不是独立的无浏览器推理服务。先按原项目流程配置/登录 ChatGPT；Full 仍完成 Tunnel/Connector 配置。已有 fork 安装可直接切换；从源码使用以下命令，打包后的命令名等价替换为 `codex-chatgpt-web`。

本次没有新增 Launcher 设置页，也没有重写其 onboarding、doctor 或旧的 `route connect` 安装器。它们仍可能以原生 OpenAI route 的视角显示状态。服务 API 模式与下述 Codex 自定义 provider 是验收入口；不要把旧 doctor 的原生 route 检查结果当作 API Key 鉴权结果。

### 6.2 随机生成并启用

在已安装依赖的仓库根目录（POSIX shell）：

```sh
# stdout 只有新密钥，stderr 为提示。失败时不要继续启动客户端。
CODEX_CHATGPT_WEB_API_KEY="$(bun run src/cli.ts api-key enable --generate)" || exit 1
export CODEX_CHATGPT_WEB_API_KEY

# 防止本机接入请求经过外部 HTTP 代理。
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

bun run src/cli.ts api-key status
```

关闭 shell 会丢失环境变量；将密钥保存到密码管理器，并在后续 Codex 启动环境中恢复。服务端仅有摘要，无法“查看原密钥”，遗失后使用 rotate。不要开启 shell `set -x`，不要把环境变量转储贴入日志/issue，也不要把密钥写入源码、命令参数、TOML 或 PR。

导入密码管理器/受保护文件提供的密钥：

```sh
# 输入允许末尾有一个 LF 或 CRLF；导入命令不回显密钥。
bun run src/cli.ts api-key enable --key-stdin < /path/to/private-key-file
```

路径是示意。不要用会将密钥字面量记入 history 的命令替代。导入后还需为 Codex 设置 `CODEX_CHATGPT_WEB_API_KEY`。

### 6.3 导出独立 Codex 配置（推荐先隔离验收）

```sh
# 不覆盖现有 ~/.codex/config.toml / auth.json。
# 选择一个新目录；文件已存在时先人工审查，避免覆盖自己的配置。
CLIENT_HOME="$HOME/.codex-chatgpt-web-client"
mkdir -p "$CLIENT_HOME"
chmod 700 "$CLIENT_HOME"
test ! -e "$CLIENT_HOME/config.toml" || exit 1
(umask 077; bun run src/cli.ts api-key codex-config > "$CLIENT_HOME/config.toml") || exit 1
```

输出形状如下（模型/effort 从当前第一个可用 route 获取，路径由程序生成）：

```toml
model_provider = "chatgpt_web"
model = "chatgpt-web/light"
model_reasoning_effort = "low"
model_catalog_json = "/absolute/private/path/api-key-models.json"
web_search = "disabled"

[model_providers.chatgpt_web]
name = "ChatGPT Web (local API key)"
base_url = "http://127.0.0.1:17841/v1"
wire_api = "responses"
env_key = "CODEX_CHATGPT_WEB_API_KEY"
requires_openai_auth = false
supports_websockets = false
```

停止活动任务后，使用现有机制重启服务；Launcher 管理的安装从 Launcher 退出/重启应用，终端受支持安装使用原有 `service restart`。不建议用强杀进程跨过活动工具/压缩流程。

```sh
# 先检查运行实例，确认 access_mode 为 api-key。
curl --noproxy 127.0.0.1 http://127.0.0.1:17841/healthz
curl --noproxy 127.0.0.1 \
  -H "Authorization: Bearer $CODEX_CHATGPT_WEB_API_KEY" \
  http://127.0.0.1:17841/v1/models

# 使用隔离配置，不执行 codex login，也不修改已有 OAuth 登录状态。
CODEX_HOME="$CLIENT_HOME" codex
```

shell 展开的 `curl -H` 可能在本机进程参数查看中短暂可见，仅用于可信单用户环境的诊断；不要在共享主机上运行或记录命令执行跟踪。

也可以把导出的配置按所用 Codex 版本的 profile 规则合并。新版本文档采用独立 `<name>.config.toml`；不要将整段 provider TOML 随意追加到一个仍处于其他表作用域的文件中。隔离 `CODEX_HOME` 避免继承旧 `forced_login_method`、model/provider 覆盖或官方目录缓存，但同时不自动继承旧 Codex MCP/skills/hooks 配置。需要这些能力时逐项迁移非凭证配置，或审查后合并到现有环境。企业管理员策略不能由本功能绕过。

API mode 不自动设置危险的 sandbox/approval 配置。通用 curl/SDK 虽可读取目录，真实 Web turn 仍受现有 Codex task metadata、工具注册和生命周期 contract 约束；本功能不承诺任意 OpenAI 客户端都能代替 Codex harness。

### 6.4 轮换与关闭

```sh
CODEX_CHATGPT_WEB_API_KEY="$(bun run src/cli.ts api-key rotate --generate)" || exit 1
export CODEX_CHATGPT_WEB_API_KEY
# 随后受控重启服务并重启/更新客户端环境；重启前旧 key 仍有效。

bun run src/cli.ts api-key disable
# 受控重启服务，再恢复原 Codex provider/config。
```

`enable` 在已启用时拒绝覆盖，必须显式 rotate。`rotate` 在未启用时拒绝。`disable` 不删除浏览器登录、Tunnel、原 Codex auth，也不自动重写 Codex TOML。关闭后不要继续把本地密钥发给 legacy passthrough；先恢复原客户端配置。

## 7. 与全局代理及上下文压缩的关系

全局代理决定**出站网络**怎么走，本地 API key 决定**入站客户端**能调用什么，二者不共享配置或凭证。本次不改动已有代理认证和 Electron proxyRules 修复。配置了出站代理后，ChatGPT 网页和 Tunnel 仍按原逻辑使用它；本机客户端应设置 NO_PROXY，避免本地 key 被外部代理看到。

鉴权通过且 model 合法后，Responses、previous_response_id 状态恢复、tool call/result、v1/v2 compact 均进入原路径。模式没有重新实现 prompt compiler 或扩大上下文窗口。上下文限制仍来自 route，Luna rolling checkpoint 和 Zero Risk structured handoff 也保持原策略。新增测试使用 fake adapter 验证压缩 API 分支，不等于已验证真实 ChatGPT 摘要质量或中途 MCP/compaction race。

## 8. 安全保证与非目标

保证范围：固定格式高熵生成；摘要存储；错误时拒绝运行；HTTP 白名单；先鉴权后解析；原生 model 禁止转发；客户端 header 凭证清理；admin key 分离；回环监听保持不变。

不保证：公网服务安全、多租户状态隔离、账户限流、配额计费、请求级审计、TTL/多 key 管理、TLS、Prompt injection 防护增强、外层 Codex 工具权限提升后的安全。持有本地 key 的客户端可使用服务端 ChatGPT 会话；该功能是**可信单用户本机服务**，不能直接把端口映射到公网或把同一个 key 分发给互不信任的用户。

若后续需要 LAN/公网或多人使用，必须先设计 TLS、账户/continuation/broker 隔离、速率限制、审计和独立 admin 网络边界，不能仅放宽 `host`。

## 9. 文件与维护点

| 文件 | 改动 |
| --- | --- |
| `src/api-access.ts` | 策略类型、生成/摘要/恒定时间比较、HTTP 白名单、header 清理 |
| `src/api-access-config.ts` | 私有策略文件解析/保存、拒绝非法配置 |
| `src/standalone-model-catalog.ts` | 项目自有模板、本地 Web-only 目录 |
| `src/api-key-codex-config.ts` | 无密钥的自定义 provider TOML 生成 |
| `src/api-key-cli.ts` | enable / rotate / disable / status / codex-config |
| `src/cli.ts` | 注册子命令和帮助；其余原逻辑保留 |
| `src/server.ts` | 启动快照、HTTP guard、local models、禁止原生路由、adapter header 隔离 |
| `tests/api-access.test.ts` | 密钥、鉴权、端点/方法、凭证清理、TOML 单测 |
| `tests/api-access-config.test.ts` | 文件权限、损坏/缺失/符号链接、rotation snapshot |
| `tests/api-key-server.test.ts` | 目录、实际 handler、SSE/JSON、压缩、HTTP/admin 隔离、legacy 回归 |
| `tests/api-key-cli.test.ts` | 子进程命令生成/导入/轮换/关闭和损坏恢复 |

未来新增原生 API 时，要保持 api-key 模式的 allowlist，不能只依赖模型前缀。未来新增 Web route，优先让目录沿用 `availableChatGptWebModelRoutes`，不要复制第二份可用性表。调整 Codex ModelInfo 时维护本地模板及真实客户端验证。

## 10. 测试与验收状态

本实现环境没有 Bun 和完整依赖，不能声称 `bun run verify` 或真实 Codex/ChatGPT/Tunnel E2E 已通过。已对实际纯逻辑 TS 源码转译，并用 Node 的测试运行器兼容层执行 `api-access.test.ts`：**16 项通过**。新增/修改的 11 个 TS 文件均通过转译语法检查；鉴权、TOML 生成及纯逻辑测试也通过了隔离的 strict / noUncheckedIndexedAccess 类型检查。这不等同于全项目 Bun 类型检查。

四个测试文件共提供 35 项测试；除上述 16 项外，其余测试尚未在本环境运行，需在完整仓库执行：

```sh
bun install --frozen-lockfile
bun test tests/api-access.test.ts tests/api-access-config.test.ts \
  tests/api-key-server.test.ts tests/api-key-cli.test.ts
bun run typecheck
bun run verify
```

`verify` 的其他步骤可能需要 Launcher 依赖、受支持 OS 及现有仓库的环境准备；以实际输出为准，不将新增测试的通过等同于全仓库通过。

合并前人工验收：

1. 保留旧配置运行 legacy，确认原生模型及 Web 模型仍可用；全局代理设置不变。
2. 启用 API 模式，重启，确认 `/healthz.access_mode`；无 key/错误 key 请求应 401。
3. 用不含 OAuth auth.json 的隔离 Codex home 接入，模型列表只包含可用 Web 模型，实际完成文本、图片（Automatic）、SSE 与取消测试。
4. Full 模式实际运行工具调用及 continuation；Zero Risk 人工发送、start/complete 握手；检查独立客户端需要的 MCP/中断 hooks 是否已迁移。
5. 测试 v1/v2 compaction 和 Luna 特殊路径；确认本地目录的窗口、effort 与当前 Web 账号能力一致。
6. 带合法 key 调原生模型、search、images、未知路径，确认直接返回 4xx；通过抓取仅包含目的地/计数的安全网络证据确认无原生 passthrough。
7. rotation 后重启，旧 key 401、新 key 成功；客户端 key 无 admin 权限。检查日志、status、health、TOML 无 key/摘要。
8. 显式 disable 后受控重启并恢复原 provider；确认 OAuth/原生路径可恢复，配置文件和代理设置未丢失。

## 11. 参考

- [Codex 配置文档](https://developers.openai.com/codex/config-advanced/)：自定义 provider、环境变量鉴权、profile、model_catalog_json。
- [Codex ModelInfo 源码基线](https://github.com/openai/codex/blob/da18000cae9884ab45f83b2d07fbd5a220a1de39/codex-rs/protocol/src/openai_models.rs)：本地模板所需的模型元数据字段。
- 项目既有 `src/model-catalog.ts`、`src/chatgpt-web-models.ts`、`src/server.ts`、`docs/security-model.md`、`CONTRIBUTING.md`。
