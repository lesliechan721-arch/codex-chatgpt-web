# HTTP/HTTPS 认证全局代理 Spec

## 用户结果与范围

Launcher 的“全局网络代理”继续只接受 HTTP 和 HTTPS URL，并新增 URL 内用户名及密码认证：

- `http://host:port`
- `https://host:port`
- `http://user:password@host:port`
- `https://user:password@host:port`

用户名和密码是可选项，通过 URL userinfo 设置。保留现有单一代理 URL 输入框，不新增独立凭据表单。

明确放弃 SOCKS5 支持，不启动协议转换或本地转发代理，也不新增代理依赖。留空时保持现有行为：Electron 会话使用系统代理，子进程恢复 Launcher 启动时继承的代理环境。

## 行为与关键场景

1. 无认证 HTTP/HTTPS 代理保持现有行为。
2. 带认证的 HTTP/HTTPS URL 规范化后保存。环境变量获得包含凭据的完整 URL，使 Bun Responses 运行时使用代理认证。
3. Electron `session.setProxy` 只获得移除 userinfo 的代理 URL。Chromium 发出代理认证挑战时，Launcher 通过 Electron `app` 的 `login` 事件提交对应凭据。
4. 认证回调只处理来自目标 ChatGPT partition、`authInfo.isProxy === true`、`authInfo.scheme === "basic"`，且主机和端口与当前代理完全匹配的挑战。`webContents` 缺失、其它 session、普通网站认证、其它认证机制、不同代理和旧代理的挑战不得获得凭据。
5. 没有配置凭据或挑战不匹配时，Launcher 不调用 `preventDefault()` 或 callback。Electron 的默认行为会取消该认证请求；本任务不提供交互式凭据提示。
6. 应用新设置时保持现有事务顺序：更新进程环境、设置 Electron 代理、关闭现有连接、重启已配置运行时，然后持久化状态。认证状态按以下顺序切换：
   - 开始设置或清除时，先停用当前认证信息。
   - 停用认证后，先等待目标 session 的 `clearAuthCache()` 成功，再调用 `session.setProxy`。首次应用、切换、清除和回滚都执行该步骤。
   - `session.setProxy` 成功后、调用 `closeAllConnections` 前，启用新代理的认证信息；无认证代理或系统模式保持停用。
   - 后续步骤失败时，先停用新认证信息并再次清理认证缓存；旧 `session.setProxy` 恢复成功后、关闭旧连接前恢复旧认证信息。
   - 回滚也失败时保持认证停用，避免继续向不确定端点提交凭据。
   - 任一次认证缓存清理失败时进入 fail-closed：不启用或恢复任何凭据，不持久化新配置。代理控制器先把全部代理环境变量恢复为本次事务开始前的精确快照，再调用 fatal callback。主进程立即销毁已存在的内置浏览器及其 WebContents，并要求已存在的受管 Responses/MCP 运行时强制停止。只有 shutdown 返回 `stopped` 或 `forced`，或尚未创建 supervisor 时，才以非零状态退出 Launcher。状态文件保留旧配置，下次启动重新应用。
   - 如果 shutdown 返回 `forced-partial` 或抛出异常，主进程不得把退出当作成功，也不得放弃仍可能存活的子进程。Launcher 保持运行和监督所有未确认停止的子进程，向 Renderer 和日志发布固定 fatal 状态，但不再保留代理 partition 的浏览器消费者。
   - `forced-partial` 后若受管 Tunnel 仍可能存活，RuntimeSupervisor 必须使用当前有效的 Full/Tunnel 配置或进程内最近一次成功校验且包含可用 Tunnel 合同的配置恢复 Tunnel 监控。有效的 browser-only 配置不得替换该 Tunnel 配置缓存。若本进程从未取得有效 Tunnel 配置，必须保留失败状态和 Tunnel PID 等所有权证据，不得声称已恢复监控。用户随后执行普通退出时也必须再次检查 shutdown 结果；结果仍为 `forced-partial` 或抛出异常时不得设置 `exitCommitted` 或调用 `app.quit()`。
   - fail-closed 的 Renderer、日志和退出原因只使用固定安全消息，不包含底层错误或代理端点。若失败发生在启动期且 supervisor 尚未创建，直接执行清理和非零退出，不显示可继续使用 Launcher 的状态。
7. 应用或运行时重启失败时，恢复旧代理 URL、旧 Electron 代理和旧凭据匹配状态；回滚失败除外，其凭据按上一条保持停用。
8. 清除设置开始时即停止响应旧代理的认证挑战，随后恢复系统/继承配置。
9. URL 协议名大小写不敏感，但原始输入必须使用精确的 `http://` 或 `https://` authority 结构；拒绝单斜杠、多斜杠、反斜杠、路径、空或非空查询、空或非空片段、控制字符、空主机、非 HTTP/HTTPS 协议和超过 2048 字符的输入。
   - 路径校验必须发生在 WHATWG URL 规范化前。authority 后原始后缀只允许为空或精确 `/`；必须拒绝 `/.`、`/%2e`、`/a/..`、`/../` 和等价大小写编码形式。
10. 用户名或密码中的特殊字符必须使用 URL 百分号编码。userinfo 各字段只解码一次；无效百分号编码被拒绝。空用户名加非空密码被拒绝；非空用户名可配空密码。
11. 认证端点使用 URL 规范化后的主机，并移除 IPv6 方括号后按 ASCII 小写比较。端口为显式非默认端口，或 HTTP 的 80、HTTPS 的 443。显式默认端口和隐式默认端口必须匹配同一挑战。

## 重要实现决定

- `network-proxy-config.cjs` 继续负责规范化与协议校验，并增加：
  - 为 Electron 生成不含 userinfo 的代理 URL。
  - 从配置 URL 提取只解码一次的用户名、密码和规范化主机/端口，用于认证挑战匹配。
- `network-proxy.cjs` 继续负责代理切换事务，并维护当前已成功应用的认证信息。失败回滚必须同步恢复该信息。
- `network-proxy.cjs` 在每次 Electron 代理应用前调用目标 session 的 `clearAuthCache()`。该调用必须完成于 `setProxy`、启用凭据和 `closeAllConnections` 之前。
- `network-proxy.cjs` 在每次事务开始时捕获全部代理环境变量；认证缓存无法清理时，由控制器恢复该精确快照，再通过注入的 fatal callback 报告失败。`main.cjs` 的 callback 负责阻止后续启动、销毁已存在的浏览器资源并强制停止已存在的受管运行时。仅在 shutdown 明确返回 `stopped` 或 `forced`，或 supervisor 尚不存在时调用 `app.exit(1)`；`forced-partial` 或异常时保留 Launcher 对剩余子进程的监督并显示固定 fatal 状态。该路径不得进入普通可恢复错误流程。
- `main.cjs` 注册一个 `app.on("login", ...)` 处理器，并把代理认证挑战委托给代理控制器。控制器必须验证 `webContents.session` 等于 `session.fromPartition(browserPartition)`，再核对 Basic 代理挑战和端点；只有全部匹配时才调用 `event.preventDefault()` 和 `callback(username, password)`。
- 环境变量保留完整认证 URL。Electron 配置和日志不得包含凭据。
- 运行时诊断使用进程内有界注册表定向移除认证或无认证代理的完整 URL、去 userinfo 端点、主机、主机端口和常见端口表述。代理控制器在首次配置和每次事务前注册继承环境、事务前配置和候选配置；当前代理环境作为补充。环境切换或清空后，已注册的旧端点仍须脱敏；不匹配已注册或当前代理端点的普通 URL保持现有日志行为。
- 不增加 `proxy-chain` 或其它依赖，不实现 SOCKS5。

## 界面与凭据处理

- 所有现有语言的说明保持 HTTP/HTTPS 范围，并补充认证 URL 格式。文案明确认证能力覆盖内置浏览器和 Responses 运行时；MCP Tunnel 只接收相同代理环境变量，其认证支持取决于 Tunnel 实现。
- 输入框继续回显已保存的完整 URL，便于用户修改。浏览器自动完成保持关闭。
- 界面状态、日志、错误文本和诊断导出不得输出代理 URL、协议、主机、端口或凭据。输入框按用户要求回显配置值；除此以外，现有状态只显示是否启用了自定义代理。
- 原始 URL（包括凭据）按现有状态机制保存在 Launcher 状态文件中。该文件及目录继续使用现有私有权限：文件 `0600`、目录 `0700`（平台支持时）。
- 本任务不引入操作系统钥匙串或字段级加密。因此，具有当前操作系统用户文件读取权限或 Renderer 执行权限的代码仍可读取凭据。这是本次实现的明确安全限制。

## 验收与验证

自动测试至少覆盖：

- HTTP 和 HTTPS URL 的现有规范化行为不变。
- HTTP 和 HTTPS URL 内用户名、可为空的密码及百分号编码凭据被接受；密码存在但用户名为空、无效百分号编码被拒绝。
- 非支持协议及现有非法结构继续被拒绝，包括 SOCKS5。
- Electron `fixed_servers` 配置不含 userinfo；环境变量仍包含完整认证 URL。
- HTTP/HTTPS 的隐式与显式默认端口、非默认端口、大小写主机和 IPv6 端点按统一规则匹配；凭据只解码一次。
- 来自目标 partition 且完全匹配的 Basic 代理认证挑战收到已解码凭据。
- 其它 session、空 `webContents`、非 Basic、非代理、错误主机、错误端口、无凭据及已被替换的旧代理挑战不收到凭据，也不被 Launcher 拦截；测试确认其进入 Electron 默认取消路径。
- 用可延迟的 `setProxy` 和 `closeAllConnections` 测试各事务阶段：切换开始停用旧凭据，Electron 新配置生效后启用新凭据，运行时重启或状态写入失败且旧配置恢复后恢复旧凭据，回滚失败则保持停用。
- 验证首次应用、切换、清除和回滚都按 `停用凭据 → clearAuthCache → setProxy → 启用匹配的新凭据 → closeAllConnections` 排序。
- 分别在首次应用、从旧认证代理切换、清除和回滚注入 `clearAuthCache` 失败，断言：新配置不持久化；认证保持停用；全部代理环境变量精确恢复为事务前值；不再执行后续代理或连接操作；错误、日志和退出原因不泄露端点。运行期失败还断言浏览器 WebContents 销毁；shutdown 返回 `stopped` 或 `forced` 时调用 `app.exit(1)`，返回 `forced-partial` 或抛出异常时不退出、发布固定 fatal 状态并继续监督子进程。启动期失败断言不再创建 BrowserHost、RuntimeSupervisor 或其它后续资源并直接退出。
- 清除设置后不再响应认证挑战。
- 持久化认证 URL 可在重启后恢复；损坏值仍回退为 `null`。
- 注入包含完整认证 URL 的 Electron 和运行时异常，断言 Renderer 错误、原始 Launcher 日志和诊断导出均不含 URL、协议、主机、端口、用户名或密码。代理切换的底层错误必须转换为不含端点数据的阶段性安全消息。
- 认证和无认证代理切换后延迟输出旧 URL、裸主机、主机端口、IPv6 和 `port N` 表述，断言原始日志、状态、operation、诊断导出和进程诊断均不泄露端点；无关普通 URL保持可见。注册表必须有固定上限。
- `forced-partial` 时分别让当前配置读取抛错和返回空值，断言最近一次有效配置用于恢复 Tunnel 监控；从未成功校验配置时断言不声称监控已恢复，并保留所有权证据。
- 五种现有界面语言说明认证 URL 格式和 MCP 限制，但不声明 SOCKS5 或 Tunnel 认证保证。

执行 Launcher 代理相关测试、Launcher 全量测试、TypeScript 检查和 Renderer 构建。

## 风险与授权

- 凭据以明文 URL 形式存放在私有状态文件中，并会进入 Launcher 子进程环境。用户已选择继续此范围。
- 认证处理器必须严格限定代理挑战和当前代理的规范化主机、端口。错误匹配可能向非预期端点泄露凭据。
- `clearAuthCache` 失败会在确认运行时已停止后强制退出 Launcher，可能中断当前本地工作。若无法确认运行时停止，Launcher 会销毁代理浏览器消费者并保留进程以监督剩余子进程。这是用户确认的安全优先策略。
- 日志只记录自定义代理是否启用，不记录协议、主机、端口、用户名或密码。
- 代理控制器不得直接传播 Electron、运行时重启或状态写入产生的原始错误消息；对 Renderer 和 IPC 日志只提供固定的安全阶段信息。底层错误若需记录，必须先完整移除代理端点和凭据；本任务默认不记录底层文本。
- 代理切换保持现有限制：活动 ChatGPT turn 或 Launcher 生命周期操作期间不可修改。
- MCP Tunnel 是否支持认证代理取决于其对现有代理环境变量的处理，仓库内没有充分证据。界面不得新增“认证覆盖所有 Tunnel 实现”的保证。

## 实现自由

- 认证信息的内部对象形状和控制器方法名可由实现者选择。
- 可在配置模块或控制器内完成主机及默认端口规范化，但必须由单一可测试逻辑产生 Electron 配置和挑战匹配依据。
- 错误文案可按现有英文风格调整，但不得泄露代理 URL 或凭据。

## 来源与开放问题

- 原始需求后续确认：仅新增 HTTP/HTTPS 账号密码认证，放弃 SOCKS5。
- 当前实现入口：`launcher/electron/network-proxy-config.cjs`、`launcher/electron/network-proxy.cjs`、`launcher/electron/main.cjs`、`launcher/src/NetworkProxySettings.tsx`。
- Electron 41 文档：`app` 的 `login` 事件提供 `authInfo.isProxy`、主机、端口和凭据 callback，用于 HTTP 407 代理认证。
- Bun 1.4 文档：`HTTP_PROXY` 与 `HTTPS_PROXY` 支持包含用户名和密码的 HTTP/HTTPS URL。
- 开放问题：无。实施不承诺未在仓库内验证的第三方 Tunnel 认证能力。
