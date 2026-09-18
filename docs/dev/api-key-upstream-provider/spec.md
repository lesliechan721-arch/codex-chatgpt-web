# API Key 模式上游模型服务商 Spec

## 用户结果与范围

在 `API Key` 接入模式中增加一个可选的 OpenAI 兼容上游模型服务商。用户可以配置：

- 请求 `baseUrl`；
- 上游 `apiKey`；
- 上游网络代理策略：使用全局代理、强制直连、使用单独代理。
- 上游模型筛选策略：不过滤、按模型名称正则筛选、手动获取并选择模型。
- 上游是否支持 Codex 所使用的 OpenAI 服务端压缩协议（Responses `compaction_trigger` / remote compaction v2）。

上游只影响 `API Key` 模式。`OpenAI 转发`模式继续使用现有原生 OpenAI/Codex 转发逻辑，不读取此上游配置。

未配置上游时，`API Key` 模式保持当前 Web-only 行为：

- `chatgpt-web/*` 继续通过现有 ChatGPT 浏览器适配器处理；
- `/v1/models` 只返回本地 ChatGPT Web 模型目录；
- 非 `chatgpt-web/*` 模型继续被拒绝；
- `/v1/alpha/search`、`/v1/images/generations`、`/v1/images/edits` 继续不对 API Key 客户端开放。

配置上游且上游密钥在当前运行时可用时，采用混合路由：

- `chatgpt-web/*` 始终保留给本地 ChatGPT Web 路由；
- 其它模型的 `/v1/responses` 与 `/v1/responses/compact` 转发到上游；
- `/v1/alpha/search`、`/v1/images/generations`、`/v1/images/edits` 转发到上游；
- `/v1/models` 合并本地模型目录与经过筛选的上游模型目录；
- 非 Web 模型请求必须同时满足当前上游模型筛选规则，不能通过直接填写被过滤的模型名绕过筛选。

本任务只支持一个上游服务商。不增加多服务商、按模型映射、负载均衡、故障切换、权重或租户隔离。

## 行为与关键场景

### 1. 上游启用条件

上游配置即启用，不增加独立开关。

有效上游需要同时具备：

1. 有效 `baseUrl`；
2. 与配置摘要匹配且当前运行时可以读取的上游 `apiKey`；
3. 有效代理配置。

删除上游配置即停用上游，并恢复当前 API Key 模式的 Web-only 行为。

配置元数据存在但密钥在当前会话不可用时，不得回退到原生 OpenAI 转发，也不得使用本地客户端 API Key 代替上游密钥。该运行时将上游视为不可用：本地 `chatgpt-web/*` 仍可工作，上游模型请求按“未启用上游”的接口边界拒绝，Launcher 明确显示上游密钥需要重新输入或重新应用。

### 2. Base URL 语义

`baseUrl` 是上游 API 根地址。例如：

```text
https://provider.example/v1
http://127.0.0.1:11434/v1
```

运行时在根地址后追加现有端点路径：

```text
models
responses
responses/compact
alpha/search
images/generations
images/edits
```

`baseUrl`：

- 必须是绝对 HTTP 或 HTTPS URL；
- HTTP 和 HTTPS 都允许；
- 必须包含主机；
- 可以包含固定路径前缀，例如 `/v1`；
- 不允许用户名、密码、查询参数或 fragment；
- 规范化尾部 `/` 后再追加端点，不能使用 URL 解析规则意外丢弃已有路径前缀；
- 不把原始 URL、主机、端口或路径写入普通日志、健康状态或诊断摘要。

### 3. 上游 API Key

上游 `apiKey` 与以下凭据严格分离：

- 客户端访问本地服务的 `CODEX_CHATGPT_WEB_API_KEY`；
- daemon `controlToken`；
- OpenAI/Codex 原生登录凭据；
- Tunnel/MCP 凭据。

上游密钥不复用本地 API Key 的格式限制。为了兼容不同 OpenAI 兼容服务商，只要求它：

- 是非空字符串；
- 不包含 CR、LF 或 NUL；
- 长度不得超过 4096 个字符。

发送上游请求时，运行时固定使用：

```http
Authorization: Bearer <upstream-api-key>
```

客户端传入的 `Authorization`、`Proxy-Authorization`、`x-api-key`、Cookie、ChatGPT 账号头以及 OpenAI 组织/项目认证头不得直接传到自定义上游。上游认证由本地配置单独建立。

### 4. 请求路由

#### `/v1/responses`

- `model` 是 `chatgpt-web/*`：继续执行现有 Web adapter、MCP、continuation、SSE 和取消逻辑。
- `model` 不是 `chatgpt-web/*`，且上游可用：按 OpenAI 兼容请求转发到 `<baseUrl>/responses`。
- `model` 不是 `chatgpt-web/*`，且上游不可用：保持现有 API Key Web-only 拒绝行为。

本地生成的 ChatGPT Web reasoning/compaction 包装在跨到上游时，继续执行现有 `scrubBridgeArtifactsForNative()` 同类清理规则，不能把只属于本地 Web provider 的 response item id 或本地 compaction envelope 当作上游可识别对象。

#### `/v1/responses/compact`

- `chatgpt-web/*` 保持现有本地 compaction 行为；
- 其它模型且上游可用时转发到 `<baseUrl>/responses/compact`；
- 上游不可用时保持当前拒绝行为。

#### `/v1/alpha/search` 与 `/v1/images/*`

只有“API Key 模式 + 上游可用”时允许这些端点。请求先通过本地 API Key 鉴权，再转发到对应上游路径。

没有上游时继续返回当前 API Key 模式的 `endpoint_not_supported`，不能转发到官方 OpenAI/Codex 后端。

#### 上游失败

除模型目录外，不做 provider 故障回退：

- 上游 4xx/5xx 按兼容转发语义返回客户端；
- 网络失败转换为现有安全的 `upstream_error` 形式；
- 不能在失败后自动改走 ChatGPT Web 或官方 OpenAI；
- 不能自动重放具有副作用的图片或其它 POST 请求。

### 5. 模型目录合并

配置上游后，`GET /v1/models` 同时提供本地 ChatGPT Web 模型和**经过当前上游模型筛选规则处理后的**上游模型。

合并规则：

1. 先构建现有本地 `buildStandaloneModelCatalog(config)`。
2. 请求上游 `<baseUrl>/models`。
3. 上游返回标准 OpenAI `object: "list"` / `data` 数组时，先按当前筛选规则过滤，再合并有效 `data` 项。
4. 本地 `chatgpt-web/*` 命名空间永久保留给本地路由。上游 `data[].id` 与本地模型同名时丢弃上游项。
5. 如果上游明确返回兼容的 Codex 富 `models` 数组，可以合并其有效行；同样先应用当前筛选规则，并丢弃 `chatgpt-web/*` 冲突项。
6. 如果上游只有标准 `data`，不得根据本地模板猜测或合成上游模型的 context window、reasoning level、tool capability、compaction limit、multi-agent capability 或其它 Codex 富元数据。此时上游模型仍可按模型名直接请求，但不会因为猜测数据而出现在 Codex 富 `models` 列表中。
7. 合并不能修改上游非冲突模型的身份，也不能把本地 ChatGPT Web 能力声明复制给上游模型。

上游模型目录获取、解析或校验失败时：

- `/v1/models` 仍返回 HTTP 200 和完整本地 ChatGPT Web 模型目录；
- 记录一次不包含端点或凭据的上游目录失败诊断；
- 不使用陈旧缓存；
- 不把目录失败解释为整个本地服务失败。

### 6. 上游模型筛选与手动选择

模型筛选只作用于自定义上游模型，不作用于本地 `chatgpt-web/*`。未配置筛选时保持原 Spec 行为，即允许并展示所有非冲突上游模型。

筛选配置为三态：

```ts
type UpstreamModelFilter =
  | { mode: "all" }
  | { mode: "regex"; pattern: string }
  | { mode: "selected"; models: string[] };
```

#### `all`

- 不过滤上游模型。
- `/v1/models` 合并所有有效、非冲突的上游模型。
- 任意非 `chatgpt-web/*` 模型名都可以进入上游路由；实际是否存在由上游决定。

#### `regex`

- `pattern` 是正则表达式源字符串，匹配上游的**可请求模型标识**，即标准目录的 `data[].id` 或 Codex 富目录行的 `slug`。
- 不使用展示名称 `display_name` 做路由判定，避免“看到的名称”和实际请求的 `model` 不一致。
- 正则固定区分大小写，本范围不增加独立 flags 配置。
- 保存前必须验证正则可编译；非法正则不保存、不重启运行时。
- pattern 长度必须有固定上限，建议最多 512 个 UTF-16 code units。
- `/v1/models` 只合并匹配的上游模型。
- `/v1/responses` 和 `/v1/responses/compact` 的非 Web `model` 只有匹配该正则时才允许转发。未匹配模型返回本地 `model_not_supported`，不得请求上游。
- 正则筛选不依赖一次成功的 `/models` 拉取。只要请求中的模型名匹配正则，即可按规则路由；上游是否真实支持该模型由上游响应决定。

#### `selected`

- `models` 是用户手动选择后持久化的上游模型标识 allowlist。
- 数组保存前去重并使用稳定顺序；每个模型名必须是非空、无控制字符且长度受限的字符串。
- `chatgpt-web/*` 不允许进入该列表；该命名空间始终由本地保留。
- `/v1/models` 只合并 allowlist 中且本次上游目录实际返回的模型，不为已选择但本次目录缺失的模型伪造目录条目。
- `/v1/responses` 和 `/v1/responses/compact` 只允许 `model` 精确命中 allowlist。未命中返回本地 `model_not_supported`，不得请求上游。
- 已保存的 allowlist 不会因为后续 `/models` 返回变化而自动删除项目。用户重新获取模型并保存新选择时才更新；如果上游已经移除某个仍在 allowlist 中的模型，直接请求时由上游返回对应错误。

#### 手动获取并选择模型

Launcher 在上游编辑区提供显式的“获取模型”动作。它只由用户操作触发，不在打开设置、状态刷新或后台轮询时自动请求第三方上游。

获取流程：

1. 使用编辑器当前的 `baseUrl`、代理模式和代理 URL。
2. 若用户当前填写了新的上游 API Key，使用该 draft key；否则使用与当前已保存上游配置匹配且可读取的安全存储密钥。
3. 调用当前 draft 配置对应的 `<baseUrl>/models`。
4. 从标准 `data[].id` 和兼容 Codex `models[].slug` 中提取可请求模型标识，去重，并排除所有 `chatgpt-web/*`。
5. 把结果返回给可信 Renderer，供用户搜索、勾选或取消选择；获取结果本身不写配置、不改变运行时、不触发重启。
6. 用户选择“手动选择”模式并保存后，才把所选模型 ID 写入上游配置并走正常的保存/受控重启流程。

获取模型失败时：

- 不清空当前已保存的 allowlist，也不修改其它上游配置；
- Renderer 显示安全错误，不包含 API Key、baseUrl、proxy URL 或代理凭据；
- 不回退到官方 OpenAI `/models`，也不自动使用上一次临时获取结果；
- 用户可以修改 draft 配置后再次手动获取。

筛选只约束带 `model` 的上游模型请求和模型目录。`/v1/alpha/search` 与 `/v1/images/*` 是否开放仍只由“API Key 模式 + 上游可用”决定，不受模型筛选影响。

### 7. OpenAI 服务端压缩能力

上游配置必须显式记录它是否支持 Codex 当前使用的 OpenAI 服务端压缩协议：

```ts
supportsOpenAiServerCompaction: boolean;
```

该字段描述的是 **Responses remote compaction v2**：Codex 在普通 `/responses` 请求的 `input` 尾部发送 `type: "compaction_trigger"`，并要求服务端返回 compaction item。它不等同于“上游存在 `/responses/compact` 端点”。只有真实兼容 `compaction_trigger` 协议的上游才能设置为 `true`。

行为要求：

- `false`：API Key 模式导出的 Codex provider 不得冒充 OpenAI，Codex 使用其非 OpenAI provider 的压缩能力判定。
- `true`：API Key 模式导出的 Codex provider 的 `name` 必须是精确字符串 `OpenAI`。provider id 仍可保持 `chatgpt_web`；不能因为名称变化修改本地路由命名空间或模型 ID。
- 该名称要求来自 Codex 当前实现：`ModelProviderInfo::is_openai()` 只在 `name == "OpenAI"` 时为真，而配置型 provider 只有被识别为 OpenAI（或 Azure Responses 特例）时才把 `remote_compaction` 标记为 `V2`。
- 名称切换只用于向 Codex 声明 provider capability。它不能切换到官方 OpenAI base URL、官方认证或 `CODEX_BACKEND`。
- 对非 `chatgpt-web/*` 模型，remote compaction v2 请求继续经过现有 `/responses` 自定义上游路由、模型筛选、独立 Bearer 和代理规则；不能因为它是压缩请求绕过 allowlist/regex。
- 对 `chatgpt-web/*`，即使导出的 provider 名称为 `OpenAI`，仍由本地 ChatGPT Web 路由处理。现有本地 remote compaction v2 bridge 行为必须保持可用，不能把 Web 模型的 `compaction_trigger` 转发到第三方上游。
- `supportsOpenAiServerCompaction` 的变更属于运行时配置变更，必须进入 revision，并按现有保存后受控重启流程生效。

Launcher 在上游设置中提供明确的布尔选项，并说明它只应在上游真实支持 OpenAI Responses 服务端压缩时启用。默认值为 `false`，不能通过探测 `/responses/compact`、provider 名称或模型名称自动推断。

### 8. 三态代理

上游代理配置为严格三态：

```ts
type UpstreamProxy =
  | { mode: "global" }
  | { mode: "direct" }
  | { mode: "custom"; url: string };
```

语义如下：

- `global`：复用 Launcher 当前全局网络代理策略。若 Launcher 没有自定义全局代理，则继续使用现有系统/进程默认代理解析行为。
- `direct`：该上游请求强制直连。必须忽略 Launcher 全局代理、系统代理和代理环境变量。实现不得通过临时修改全局 `process.env` 来实现，因为并发中的其它请求不能被影响。
- `custom`：该上游请求只使用此配置中的代理 URL，不使用全局或系统代理回退。

单独代理复用现有全局代理 URL 规则：

- 只支持 HTTP/HTTPS；
- 支持 `http://user:password@host:port` 与 HTTPS 等价形式；
- 支持现有 percent-encoding 规则；
- 不支持 SOCKS；
- 不允许 path、query 或 fragment。

`custom` 代理完整 URL 按用户确认的现有全局代理安全模型持久化：允许包含 userinfo，并保存在应用私有配置文件中，不增加字段级系统加密。日志、错误、健康状态和诊断不得输出代理 URL、协议、主机、端口、用户名或密码。

精确实现“强制直连”的 Bun/Node transport 方法由实现者选择，但验收必须证明它不会使用进程代理环境或 Launcher 全局代理，也不会改变其它并发请求的代理行为。

### 9. 配置保存与运行时生效

沿用现有 API Key 设置的“先保存，再尝试受控重启”语义：

```text
校验输入与 revision
    ↓
原子保存上游非敏感配置
    ↓
安全保存/更新上游 API Key
    ↓
当前后台空闲时受控 stop/start
    ↓
读取 health revision 确认新配置已加载
```

- 配置写入成功后即视为用户意图已保存。
- 有活动 HTTP、浏览器或 MCP 任务时不强制取消，显示待重启。
- Launcher 管理的空闲运行时复用现有 `stopForSetup()` / `startIfConfigured()`。
- 外部管理的运行时不由 Launcher 强杀。配置保持已保存状态，并等待外部管理器重启。
- 后台停止或启动失败不回滚用户已经保存的上游配置，但 UI 不能显示“已生效”。
- 不增加 daemon 内存热更新接口。

## 重要实现决定

### 1. 配置文件与版本边界

现有 `api-access.json` version 1 继续只描述本地 HTTP 接入策略，不把上游服务商字段塞入该文件。这样可以保留当前本地鉴权解析、CLI 和迁移合同。

新增独立私有配置文件，例如：

```json
{
  "version": 1,
  "baseUrl": "https://provider.example/v1",
  "apiKeySha256": "<64-char-lowercase-hex>",
  "proxy": { "mode": "global" },
  "modelFilter": { "mode": "all" },
  "supportsOpenAiServerCompaction": false
}
```

单独代理示例：

```json
{
  "version": 1,
  "baseUrl": "https://provider.example/v1",
  "apiKeySha256": "<64-char-lowercase-hex>",
  "proxy": {
    "mode": "custom",
    "url": "http://user:password@proxy.example:8080/"
  },
  "modelFilter": {
    "mode": "regex",
    "pattern": "^gpt-5\\."
  },
  "supportsOpenAiServerCompaction": true
}
```

手动模型选择示例：

```json
{
  "version": 1,
  "baseUrl": "https://provider.example/v1",
  "apiKeySha256": "<64-char-lowercase-hex>",
  "proxy": { "mode": "direct" },
  "modelFilter": {
    "mode": "selected",
    "models": ["gpt-5.6-sol", "gpt-5.6-pro"]
  },
  "supportsOpenAiServerCompaction": false
}
```

文件名可由实现者按项目命名习惯选择，但必须：

- 位于应用私有目录；
- 原子写入；
- 有固定大小上限；
- 严格拒绝未知字段或损坏结构；
- 不包含上游 API Key 明文；
- `modelFilter` 必须符合 `all` / `regex` / `selected` 的互斥 schema；
- `supportsOpenAiServerCompaction` 必须是布尔值；新配置必须显式写入，缺失值按 `false` 处理，不能自动推断；
- 文件缺失表示未配置上游。

`apiKeySha256` 只用于把配置与安全存储中的密钥绑定、检测陈旧副本和计算配置 revision。它不是上游认证值。

### 2. 上游 API Key 安全存储

Launcher 复用现有 `api-key-vault.cjs` 的安全模型，可抽取通用 vault 或新增专用 vault：

- 使用 Electron `safeStorage.encryptString/decryptString`；
- Linux `basic_text` / `unknown` 后端仍视为不可安全持久化；
- 系统加密不可用时，密钥只保存在 Launcher 当前进程内存；
- 不把明文密钥降级写入磁盘；
- 状态刷新不主动解密；
- 替换配置时，只有 digest 与当前配置匹配的密钥可以复用；
- 删除上游配置时清除对应上游密钥副本，避免孤立凭据继续被自动复用。

上游密钥需要进入独立 Responses daemon。Launcher 只能在启动 daemon 时解密并注入。建议使用专用环境变量：

```text
CODEX_CHATGPT_WEB_UPSTREAM_API_KEY
```

该环境变量只能注入 daemon 子进程。不得因为修改 `process.env` 而让 Tunnel、浏览器 helper、MCP helper 或其它 Launcher 子进程继承上游密钥。

外部管理的 daemon 可以自行设置同名环境变量。Launcher 的系统加密副本不能假定外部进程可以读取。

### 3. Runtime 配置快照

daemon 启动时一次性加载：

- `api-access.json`；
- 上游非敏感配置；
- daemon 专用上游密钥环境变量。

运行期间不重新读取或热替换。

health 增加非敏感证据，用于 Launcher 判断上游是否已经应用，例如：

- 是否存在已加载上游；
- 上游配置 revision；
- 上游密钥是否与配置 digest 匹配。

revision 必须使用 daemon 管理令牌参与 HMAC，覆盖 `baseUrl`、代理模式、单独代理配置的稳定摘要以及上游 key digest。health 不能返回上游 URL、proxy URL 或任何明文凭据。

revision 还必须覆盖完整 `modelFilter` 配置和 `supportsOpenAiServerCompaction`。修改正则、手动模型 allowlist 或服务端压缩能力声明，与修改 baseUrl/代理一样，需要新的 daemon revision；旧 daemon 不得被 UI 误判为已加载新配置。

### 4. 上游转发模块

不要把自定义上游硬编码为 `CODEX_BACKEND` 的另一种值。将“构造 OpenAI 兼容上游请求”与“选择官方 Codex backend”分开，使以下两条路径明确：

- OpenAI 转发模式：继续使用现有官方 `CODEX_BACKEND` 与原生认证语义；
- API Key + 自定义上游：使用配置 `baseUrl`、独立上游 Bearer 和三态代理。

现有可复用逻辑应继续复用：

- hop-by-hop header 过滤；
- request body 保真转发；
- ChatGPT Web bridge artifact 清理；
- SSE `[DONE]` 后非正常关闭容忍；
- 图片请求不自动重放；
- 上游响应头清理。

自定义上游路径不得要求入站 `Authorization` 作为上游凭据。入站 Bearer 只用于本地 API Key 鉴权。

### 5. API Key Codex 配置导出

API Key 模式的手动 Codex 导出合同改为直接在 provider 配置中写入本地服务访问密钥，不再要求用户通过 `env_key = "CODEX_CHATGPT_WEB_API_KEY"` 给 Codex 提供认证。

导出的 provider 结构至少满足：

```toml
model_provider = "chatgpt_web"
model = "chatgpt-web/<route>"
model_catalog_json = "<local-catalog-path>"

[model_providers.chatgpt_web]
name = "ChatGPT Web (local API key)"
base_url = "http://127.0.0.1:<port>/v1"
wire_api = "responses"
experimental_bearer_token = "<local CODEX_CHATGPT_WEB_API_KEY value>"
requires_openai_auth = false
supports_websockets = false
```

当且仅当当前已保存的上游配置满足 `supportsOpenAiServerCompaction = true` 时，上述 `name` 必须改为：

```toml
name = "OpenAI"
```

其它 provider 字段、`model_provider = "chatgpt_web"`、本地 loopback `base_url` 和模型命名空间保持不变。不能把 `name = "OpenAI"` 解释为改用官方 OpenAI endpoint 或官方 OpenAI 登录。

导出使用已保存的配置作为用户当前意图，不使用旧 daemon health 中的 capability 值覆盖它。若该配置尚待运行时重启，Launcher 仍要保留现有“待重启”状态提示；导出本身不能把旧 daemon 误写成当前配置。

密钥导出规则：

- 不再输出 `env_key = "CODEX_CHATGPT_WEB_API_KEY"`；同一 provider 不能同时输出 `env_key` 与 `experimental_bearer_token`。
- `experimental_bearer_token` 写入的是**客户端访问本地 codex-chatgpt-web 服务的 API Key**，不是自定义上游 `apiKey`。上游密钥永远不能进入 Codex 导出。
- Launcher 导出前必须从现有安全存储/当前会话安全副本取得与当前 API Key policy digest 匹配的明文密钥。密钥不可恢复时导出失败并提示重新解锁或重置；不能输出空 token、旧 token 或仅有 digest 的占位配置。
- CLI `api-key codex-config` 因磁盘 policy 只保存 digest，必须从当前进程环境的 `CODEX_CHATGPT_WEB_API_KEY` 取得待导出的明文值，并先验证它与当前 policy digest 匹配。缺失或不匹配时失败；不能从命令行参数接收密钥，也不能回显失败值。
- 导出的 TOML 从此是**含敏感信息的配置**。Launcher/CLI 文案不得再声明“配置不含密钥”。导出内容不得进入普通日志、operation 记录、health、诊断、崩溃上下文或测试快照。
- “复制 Codex 配置”和“导出 TOML”属于用户显式的密钥导出动作。下载文件不会由应用自动写入 `~/.codex/config.toml`，也不会写入 `auth.json`。

#### Codex 进程代理环境

Codex 当前 `ModelProviderInfo` 没有 per-provider HTTP proxy 字段；模型 HTTP transport 使用进程/系统代理解析。因此 API Key 导出必须同时给出 Codex **启动进程环境**所需的代理变量，而不能把代理伪装成 `[model_providers.chatgpt_web]` 的未知 TOML 字段。

代理环境导出规则：

- Launcher 当前配置了全局 HTTP/HTTPS 代理时，给出 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`；值使用与 Launcher 当前全局代理相同的规范化 URL。
- 同时给出 `NO_PROXY`，至少包含 `localhost,127.0.0.1,::1`，并与用户/Launcher 已有 bypass 值合并去重，保证 Codex 到本地 `base_url` 的请求不经过外部代理。
- 为兼容只读取小写变量的其它启动环境，可以同时给出 `http_proxy`、`https_proxy`、`all_proxy`、`no_proxy`；大小写同名变量必须表达相同策略。
- Launcher 未配置自定义全局代理时，不伪造 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 值；仍要明确本地 loopback 应处于 NO_PROXY/bypass 范围。
- 自定义上游的 `proxy.mode = "custom"` 或 `direct` 是 daemon 到第三方上游的服务器侧策略，不能导出给 Codex 客户端进程。Codex 客户端始终连接本地 loopback 服务。
- 代理环境配置必须作为与 TOML 分离的启动环境说明/结构化导出数据提供；不能把 `export HTTP_PROXY=...` 等 shell 语句直接追加到 `.toml` 正文。
- 代理 URL 可能包含 userinfo，因此代理环境导出与包含 `experimental_bearer_token` 的 TOML 同属敏感导出。不得记录其 URL、主机、端口、用户名或密码。

Codex 当前源码依据：`codex-rs/model-provider-info/src/lib.rs` 定义 `experimental_bearer_token`；`codex-rs/model-provider/src/auth.rs` 将其直接构造成 Bearer auth；`codex-rs/http-client/src/outbound_proxy.rs` 从 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（并回退对应小写名）解析环境代理。

### 6. API Key 路由守卫

当前 `guardApiRequest()` 和 `requireWebModelInApiKeyMode()` 的 Web-only 条件改为读取“当前运行时是否有可用上游”。

守卫规则：

- API Key 鉴权始终先执行；
- 无上游时保持当前允许端点集合；
- 有上游时增加 `POST /v1/alpha/search`、`POST /v1/images/generations`、`POST /v1/images/edits`；
- `responses` / `compact` 对非 Web 模型只在上游可用时放行；
- `responses` / `compact` 的非 Web 模型还必须通过当前 `modelFilter`；
- `chatgpt-web/*` 不能被自定义上游覆盖。

### 7. Launcher UI 与 IPC

上游服务商设置放在现有 **Settings → 接入模式 → API Key** 区域中，只在 API Key 模式下显示。

最小界面需要：

- `Base URL` 输入；
- 上游 `API Key` 密码输入；
- 代理模式选择：`使用全局代理` / `不使用代理` / `单独代理`；
- `单独代理` 被选中时显示代理 URL 输入；
- 模型筛选方式：`全部模型` / `正则筛选` / `手动选择`；
- OpenAI 服务端压缩能力：显式布尔选项，默认关闭，并提示只有真实支持 Responses `compaction_trigger` 的上游才能启用；
- `正则筛选` 显示正则输入框，并在保存前反馈语法错误；
- `手动选择` 提供“获取模型”按钮和可勾选模型列表；
- 手动获取使用当前 draft 上游配置，允许用户在正式保存前验证 baseUrl、API Key 和代理是否可以访问 `/models`；
- 保存/更新和删除上游配置；
- 上游密钥不可恢复时显示需要重新输入；
- 已保存但 daemon 尚未加载时沿用现有“待重启”状态。

API Key Codex 导出 UI 同步调整：

- 导出操作需要当前本地 API Key 明文可用，因为 TOML 会包含 `experimental_bearer_token`；
- 预览和导出提示必须明确“包含本地 API Key”；
- 同一导出结果还要展示/返回 Codex 进程代理环境配置，供用户启动外部 Codex 时应用；
- Renderer 可以接收本次用户显式导出的 TOML 和代理环境文本，但不得把内容持久化到普通 Launcher state，也不得在错误上报中附带导出正文。

不要求新增多 provider 列表、provider 名称、模型映射器或独立设置页面。

IPC 继续使用 optimistic revision，避免两个窗口/外部修改发生 lost update。Renderer 不接收已保存的上游明文密钥，除非实现者明确增加与现有“查看本地 API Key”等价的独立用户动作；本任务不要求该查看/复制功能。

手动“获取模型”需要独立 IPC 操作，并且：

- 只接受可信主窗口调用；
- 输入可以包含用户当前正在编辑的 draft API Key，但主进程不得把该值记录到日志、状态、operation 或普通错误；
- 没有 draft key 时，只能由主进程内部读取当前匹配的安全存储密钥，不能把密钥先返回 Renderer 再发回；
- 返回值只包含规范化后的模型 ID 列表和必要的非敏感展示状态；
- 获取动作不持久化配置，也不使用配置 revision 做写入提交；真正保存时仍必须检查 optimistic revision。

## 与现有设计的兼容关系

- `docs/api-key-mode.zh-CN.md` 中“API Key 模式不转发原生模型/search/images”的描述在**未配置上游**时继续成立；配置上游后由本 Spec 的混合路由规则覆盖。
- 现有本地 API Key 鉴权、旧 integration journal 清理和 OpenAI route reconnect 行为不改变；Codex TOML 手动导出按本 Spec 改为 `experimental_bearer_token`，并增加独立的 Codex 进程代理环境导出。
- API Key 模式仍不自动改写用户的 `config.toml` 或 `auth.json`。
- ChatGPT Web 浏览器登录、MCP、Zero Risk、Compatibility V1 / native subagent protocol、Luna checkpoint 和本地 context 逻辑不因为上游配置而改变。
- 全局网络代理实现保持独立。选择 `global` 时只消费其当前策略；选择 `custom` 或 `direct` 时不能修改全局代理状态。

## 验收与验证

自动测试至少覆盖以下内容。

### 配置与凭据

1. 无上游配置时，现有 API Key 路由、鉴权和 Web-only 运行时行为保持通过；Codex 导出测试按本 Spec 的 `experimental_bearer_token` 与代理环境新合同更新。
2. `baseUrl` 接受 HTTP、HTTPS 和路径前缀，拒绝相对 URL、无主机、userinfo、query、fragment 和控制字符。
3. 上游 API Key 可使用不符合本地 `cgw_*`/`[A-Za-z0-9_-]` 规则的合法 provider token；CR/LF/NUL 和超长值被拒绝。
4. 上游明文 API Key 不进入上游配置、launcher state、snapshot、health、日志、Codex TOML 或诊断导出。
5. safeStorage 可用时重启 Launcher 可以恢复上游密钥；不可用时只在当前会话可用，重启后状态明确为密钥不可用。
6. 删除上游配置后不再自动复用旧上游密钥。
7. daemon 收到上游密钥，但 Tunnel 和其它子进程环境不包含该密钥。

### 路由与鉴权

8. 所有新开放的 `/v1/*` 上游端点仍先验证本地 API Key。
9. 入站本地 Bearer 不到达上游；上游收到配置的 Bearer。
10. `chatgpt-web/*` 在上游启用后仍走现有 browser adapter，并且不会产生任何自定义上游请求。
11. 非 Web `/responses` 和 `/responses/compact` 在上游可用时使用配置 `baseUrl`；上游不可用时继续被 API Key Web-only 规则拒绝。
12. search/images 只有上游可用时开放；无上游时保持当前 404/`endpoint_not_supported`。
13. 上游 4xx/5xx 和网络失败不改走官方 OpenAI 或 ChatGPT Web。
14. Web 产生的 bridge reasoning/compaction artifact 跨到上游前按现有 provider 边界规则清理。

### 模型目录

15. 标准上游 `data` 与本地 `data` 合并，`chatgpt-web/*` 同名冲突由本地项胜出。
16. 上游存在兼容 `models` 时合并非冲突行；上游没有 `models` 时不合成富元数据。
17. 上游 `/models` 失败、超时、非法 JSON 或 schema 不兼容时，仍返回本地模型目录，不返回陈旧缓存。
18. 目录失败诊断不包含 baseUrl、proxy URL、apiKey 或代理凭据。

### 模型筛选与手动选择

19. `all` 模式保持原有“所有上游模型”行为，且不影响 `chatgpt-web/*`。
20. `regex` 对标准 `data[].id` 和 Codex `models[].slug` 使用同一模型标识语义；匹配项进入目录且可路由，未匹配项既不进入目录也不能通过直接填写模型名绕过筛选。
21. 非法正则、超长正则不保存、不修改旧配置、不触发运行时重启。
22. `selected` 只允许精确命中持久化 allowlist 的非 Web 模型；重复 ID 被去重，`chatgpt-web/*` 选择被拒绝。
23. 已选择模型本次未出现在上游目录时不合成目录行，但 allowlist 不被自动修改；直接请求仍转发并由上游决定是否支持。
24. “获取模型”只在用户显式操作时调用上游 `/models`，使用当前 draft baseUrl/proxy/draft key；draft key 为空时由主进程内部复用当前安全存储密钥。
25. 手动获取成功只更新 Renderer 临时候选列表，不写配置、不改 revision、不重启 daemon；保存手动选择后才持久化并进入受控重启。
26. 手动获取失败不清空既有 allowlist，不回退官方 OpenAI，不暴露 baseUrl、apiKey、proxy URL 或代理凭据。
27. 运行时 revision 覆盖完整筛选配置和 `supportsOpenAiServerCompaction`；旧 daemon 不能把新 regex/allowlist/压缩能力声明报告为已生效。

### 服务端压缩与 Codex 导出

28. `supportsOpenAiServerCompaction = false` 时，导出的 provider `name` 不是 `OpenAI`；不能仅因为存在 `/responses/compact` 就自动改为 `true`。
29. `supportsOpenAiServerCompaction = true` 时，导出的 `[model_providers.chatgpt_web].name` 精确为 `OpenAI`，而 `model_provider = "chatgpt_web"`、loopback `base_url` 和本地路由保持不变；即使 daemon 仍处于旧 revision，导出也使用已保存配置，并继续显示“待重启”。
30. 开启服务端压缩后，非 Web 模型的 `compaction_trigger` 请求仍执行当前模型筛选、上游 Bearer 和三态代理；Web 模型的 `compaction_trigger` 仍由本地 bridge 处理，不请求第三方上游。
31. API Key Codex TOML 包含当前本地服务 API Key 的 `experimental_bearer_token`，且不包含 `env_key = "CODEX_CHATGPT_WEB_API_KEY"`；上游 API Key 永远不进入该 TOML。
32. Launcher 在本地 API Key 明文不可恢复时拒绝导出；CLI 只接受当前进程环境中与 policy digest 匹配的 `CODEX_CHATGPT_WEB_API_KEY` 作为导出输入，缺失或不匹配时失败且不回显密钥。
33. 导出预览、下载和剪贴板内容明确标记为含敏感信息；普通日志、operation、health、诊断和错误不包含 TOML 正文、本地 API Key 或上游 API Key。
34. 配置全局代理时，Codex 进程环境导出包含一致的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 和含 loopback 的 `NO_PROXY`；没有全局代理时不伪造代理 URL。
35. 代理环境配置与 TOML 分离，不写入未知 provider 字段；上游 `custom`/`direct` 代理不泄漏到 Codex 客户端环境。

### 代理

36. `global` 与现有 Launcher 全局代理行为一致。
37. `custom` 使用配置的 HTTP/HTTPS 代理，支持与全局代理相同的 URL userinfo 认证格式，并且不使用全局代理回退。
38. `direct` 在设置了 `HTTP_PROXY`、`HTTPS_PROXY`、Launcher 自定义全局代理或系统代理时仍直连。
39. 并发测试确认 `direct` 和 `custom` 不修改进程级代理环境，不影响同时运行的 Web、OpenAI 原生转发或其它上游请求。
40. 单独代理 URL 和凭据只在用户编辑输入中可见；日志、health、operation、错误和诊断均脱敏。

### 生命周期

41. 修改 baseUrl、上游 API Key、代理、正则筛选、手动 allowlist 或 `supportsOpenAiServerCompaction` 后，配置先保存，再尝试受控重启。
42. 有活动任务时不取消任务，状态为待重启。
43. 新 daemon 加载的上游 revision 与磁盘配置一致后才显示已生效。
44. 受控 stop/start 失败时保留新配置，但不谎报已生效。
45. 外部 runtime 不被 Launcher 强制停止，并且只有外部进程真实加载配置与密钥后 health 才能显示生效。

实现完成后运行：

- API access / API key 相关 Bun 测试；
- native passthrough / server routing 测试；
- Launcher API access controller、vault、IPC 测试；
- network proxy 相关测试；
- Launcher 全量测试；
- TypeScript 检查和 Renderer 构建；
- 项目现有完整 `verify` 流程。

## 风险与授权

- 用户已明确允许远端 `baseUrl` 使用明文 HTTP。此时上游 API Key 和请求内容可能以明文经过网络。本实现不自动升级为 HTTPS，也不阻止远端 HTTP。
- 用户已明确选择让“单独代理”的完整认证 URL 沿用全局代理的持久化模型。代理 userinfo 可能以可读形式存在应用私有文件中，不做字段级 safeStorage 加密。
- 上游 API Key 必须保持系统加密或当前会话内存存储，不能因为代理凭据允许明文保存而一起降级。
- API Key Codex 导出现在会把**本地服务 API Key**以 `experimental_bearer_token` 明文写入用户显式导出的 TOML。该文件、预览和剪贴板必须按凭据处理；此风险不允许扩展为把自定义上游 API Key 一并导出。
- Codex 进程代理环境导出可能包含带 userinfo 的全局代理 URL，因此它与导出的 TOML 一样属于敏感数据。不得写入普通日志、诊断或持久化 Renderer state。
- 错误地转发本地客户端认证头会造成凭据泄露，因此自定义上游必须使用显式 header allow/deny 逻辑建立独立认证边界。
- `chatgpt-web/*` 命名空间由本地保留。第三方上游即使声明同名模型也不能覆盖。
- 上游只声明 OpenAI 兼容，不保证每个第三方服务都实现 `responses/compact`、search 或 images。若服务商返回不支持错误，按上游响应返回，不做能力模拟。
- `name = "OpenAI"` 会让当前 Codex 把配置型 provider 的 remote compaction capability 设为 V2。因此只能由用户显式的 `supportsOpenAiServerCompaction` 声明触发，不能根据品牌名、模型名或 `/responses/compact` 是否存在进行猜测。
- 正则和 allowlist 是本地路由限制，不是上游授权机制。上游目录可能变化，运行时仍必须在每个带模型的请求上执行当前筛选规则，不能只依赖目录 UI。
- `direct` 必须是真正的请求级直连。若当前 Bun API 不能可靠关闭环境代理，实施者必须使用不会共享或改写全局代理状态的其它 transport；不得降低本 Spec 的三态语义。

## 实现自由

- 上游配置文件的准确文件名、TypeScript 类型名和模块拆分可调整。
- 可把现有 API key vault 抽取成通用 secret vault，也可创建上游专用 vault；安全行为必须一致。
- 可新增独立 `upstream-provider.ts` / `upstream-network.ts`，也可在现有 native passthrough 中提取公共转发核心；不能把官方 Codex 与自定义上游认证规则混为一个隐式分支。
- health 字段名和 IPC 方法名可调整，但必须提供不泄密的 revision 与“密钥是否已加载”证据。
- Codex 进程代理环境在 IPC 中可以使用结构化 map 或独立文本表示；必须与 TOML 语义分离，并满足相同的敏感数据边界。
- Renderer 的排版、字段顺序和短文案可以按现有 `ApiAccessSettings` 样式调整，但不能增加本 Spec 未要求的 provider 管理功能。
- 模型目录可以保留上游非冲突的额外顶层字段；本地 `models` / `data` 合并结果和冲突规则必须稳定。
- 手动模型列表的 UI 组件形式、排序方式和本地搜索交互可以调整；持久化值只能是规范化模型 ID allowlist，不能持久化整份第三方 `/models` 响应。

## 来源与开放问题

来源：

- 用户确认：上游启用后采用完整 OpenAI 同等转发范围，即非 Web `models / responses / responses/compact / search / images` 走自定义上游，`chatgpt-web/*` 保持本地。
- 用户确认：模型目录合并本地与上游；目录失败时返回本地目录；本地 `chatgpt-web/*` 名称优先。
- 用户确认：`baseUrl` 是 API 根地址；HTTP 和 HTTPS 都允许。
- 用户确认：上游 API Key 使用系统加密存储；系统加密不可用时只保留当前 Launcher 会话。
- 用户确认：上游设置位于 API Key 区域，配置即启用。
- 用户确认：代理采用严格三态；单独代理支持与全局代理一致的 HTTP/HTTPS 认证 URL，并沿用全局代理的明文私有状态持久化模型。
- 用户确认：配置变更先保存，再按现有生命周期受控重启。
- 用户确认：标准 OpenAI `data` 可以合并；缺失 Codex 富 `models` 时不猜测或合成富元数据。
- 用户新增要求：支持配置上游模型筛选；筛选支持按模型名称正则匹配，以及由用户手动调用上游模型接口获取候选并选择模型。
- 用户新增要求：上游必须标明是否支持 OpenAI 服务端压缩；支持时，API Key 模式导出的 Codex provider 名称必须为 `OpenAI`。
- 用户新增要求：API Key Codex 导出改为通过 `experimental_bearer_token` 直接配置本地服务密钥，并提供 Codex 启动所需的代理环境变量配置。
- 当前实现依据：`src/api-access.ts`、`src/api-access-config.ts`、`src/server.ts`、`src/native-passthrough.ts`、`src/native-network.ts`、`src/standalone-model-catalog.ts`、`src/model-catalog.ts`。
- Launcher 依据：`launcher/electron/api-access-settings.cjs`、`api-key-vault.cjs`、`runtime-supervisor.cjs`、`network-proxy-config.cjs`、`network-proxy.cjs`、`launcher/src/ApiAccessSettings.tsx`。
- 现有 API Key 设计依据：`docs/api-key-mode.zh-CN.md`。
- 现有代理安全模型依据：`docs/dev/socks5-auth-proxy/spec.md`。
- Codex provider capability 依据：`codex-rs/model-provider-info/src/lib.rs` 的 `ModelProviderInfo::is_openai()` 与 `codex-rs/model-provider/src/provider.rs` 的 `ConfiguredModelProvider::capabilities()`。
- Codex bearer 认证依据：`codex-rs/model-provider/src/auth.rs` 的 `experimental_bearer_token` Bearer 构造逻辑。
- Codex 代理环境依据：`codex-rs/http-client/src/outbound_proxy.rs` 对 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 及对应小写变量的解析。

开放问题：无材料级开放问题。具体直连 transport、内部文件名和模块拆分留给实现阶段，但不得改变本 Spec 已确认的行为边界。
