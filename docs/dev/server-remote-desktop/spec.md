# 服务端远程桌面部署 Phase 1 Spec

> Delegated authority 后续调整：server remote deployment 必须使用 delegated tool authority，不依赖 Server 本机 Codex rollout / SQLite 恢复客户端 filesystem authority。tool authority、tool registry lifecycle、rollout replay、compaction source recovery、retained browser fallback，以及这些要求所需的最小 adapter/broker 调整，都以 [`../delegated-tool-authority/spec.md`](../delegated-tool-authority/spec.md) 为当前规范。若这些主题与本文旧表述冲突，以 delegated Spec 为准；本文其余网络、远程桌面、API Key、Launcher ownership、持久化、idle lifecycle 和单用户合同继续有效。

> Native 长等待后续调整：[`../native-tool-long-wait/spec.md`](../native-tool-long-wait/spec.md) v0.7 通过其真实链路证据关口并进入实施基线后，当 Broker 已接受的 Native operation 持有该规格定义的有效 120 秒等待租约时，远程 native turn idle 的**终止动作暂停**。该等待活动不是“真实业务进展”，不得刷新本文定义的 idle last-progress 时间；等待租约失效或 operation 结束后，立即按原 last-progress 时间恢复 idle 判定。除此窄例外外，本文的 600 秒默认值、真实业务进展定义、断连清理、tombstone 和 ownership 回收合同继续有效。当前 6.0.1-1 实现尚未具备该例外。

## 用户结果与范围

Phase 1 将现有桌面 Launcher 作为长期运行的服务端应用使用。它不是 Launcher 的 Web 化重构。

用户最终得到以下拓扑：

```text
外部 Codex                         本地浏览器
    │                                  │
    │ HTTPS + API Key                  │ HTTPS
    └──────────────┬───────────────────┘
                   ▼
              现有反向代理
             ┌─────┴─────┐
             │           │
        /v1 Responses   /desktop/
             │           │ noVNC HTTP/WebSocket
             ▼           ▼
Linux x86_64 Server / Docker
┌────────────────────────────────────┐
│ 单一桌面容器                       │
│                                    │
│ Xvfb                               │
│  ├─ 轻量窗口管理器                 │
│  ├─ 维护终端                       │
│  └─ Codex Web GPT Linux AppImage   │
│       ├─ Electron Launcher          │
│       ├─ ChatGPT WebContentsView    │
│       ├─ persistent partition       │
│       ├─ Responses daemon           │
│       ├─ MCP / Tunnel（按现有模式）│
│       └─ browser helper             │
│                                    │
│ VNC server → noVNC/websockify       │
└────────────────────────────────────┘
```

本阶段保留核心功能可用性和 Launcher ownership。现有 `WebContentsView`、persistent browser partition、Responses bridge、Automatic/Zero Risk、MCP 能力，以及 Launcher 对 daemon/tunnel 的生命周期所有权继续保留；Codex 客户端从容器内移动到容器外，通过受认证的 HTTPS Responses 接口访问服务。server remote deployment 的 authority、rollout replay 和 compaction source recovery 是明确例外：它们按 delegated Spec 调整，并允许为此修改最小范围的 adapter/broker 行为；source proof 不足时，旧 retained browser epoch 可以被有意退役并建立 fresh epoch。

### 支持范围

- 仅支持 Linux x86_64 服务器。
- 仅支持单用户、单实例、专用可信 OS 用户的部署。
- 使用 Docker 运行服务端桌面环境。
- 本地人工入口只有浏览器中的 noVNC 桌面。不新增 SSH 作为产品入口。
- Codex CLI 运行在容器外。它可以位于同一服务器宿主机，也可以位于能够访问既有 HTTPS 反向代理的其它受信任客户端主机。
- 服务端容器不以运行 Codex CLI 为产品职责，也不要求挂载 Codex 工作项目目录。外部 Codex 使用其自身工作目录和文件系统。
- HTTPS 由用户现有的反向代理提供。本项目不在 Phase 1 内部署 Caddy、Nginx 或 Traefik。
- 远程桌面不增加独立网关登录。VNC/noVNC 密码是本阶段唯一的远程桌面应用级认证；这是已接受限制。
- 对外 Responses 接口必须使用现有 API Key 接入模式。公开 HTTPS 路径不得依赖 OpenAI passthrough 模式承担客户端认证。
- 容器运行生产 Linux x64 AppImage。不得用 `dev:launcher`、DEV profile 或 Vite 开发服务器替代生产 Launcher。

### 明确不做

- 不把 Launcher 重写为浏览器原生 Web 应用。
- 不把 Responses daemon 的裸 HTTP 监听、health、admin/control、CDP、VNC 或其它内部控制端口直接暴露到公网。公网只允许既有 HTTPS 反向代理转发受 API Key 保护的 `/v1` API 和 noVNC 所需路径。
- 不支持多人共享一个实例、同机多用户隔离或多租户。
- 不支持 Linux ARM64。
- 不同时维护裸机和 Docker 两套 Phase 1 部署合同。
- 不要求远程 Responses WebSocket、sidecar 或独立 TLS bridge。Phase 1 继续使用现有 Responses HTTP/SSE 合同，由既有 HTTPS 反向代理提供外部 TLS。
- 不允许用 `--no-sandbox`、特权容器、host network 或公开内部端口作为默认“跑通”手段。

## 行为与关键场景

### 首次部署

1. 服务器准备 Docker/Compose、一个持久 HOME volume、现有 HTTPS 反向代理、一个远程桌面密码和一个 Responses 客户端 API Key。
2. 桌面容器以非 root 用户启动。该用户的 `HOME` 使用持久 volume。
3. 容器级 supervisor 先建立虚拟桌面和远程桌面链路，再启动生产 Linux AppImage：
   - Xvfb；
   - 轻量窗口管理器；
   - 一个可用于服务器维护和诊断的终端；
   - VNC server；
   - noVNC/websockify；
   - Codex Web GPT AppImage。
4. AppImage 使用生产 profile。允许设置 `APPIMAGE_EXTRACT_AND_RUN=1`，以便在没有 FUSE 的容器内运行现有 AppImage。
5. Launcher 继续按现有代码启动和监督 Responses daemon、Tunnel、MCP 及浏览器 helper。容器 supervisor 不得重复启动这些 Launcher-owned 子进程。
6. 用户通过 `https://server.example.com/desktop/` 一类地址访问现有反向代理。反向代理转发 noVNC 的 HTTP 和 WebSocket 流量。
7. VNC 认证成功后，用户看到服务器上的桌面。用户可操作 Launcher、完成 ChatGPT 登录、MFA、Cloudflare/身份提供方验证。
8. 部署配置提供一个可选的“公开 Codex Base URL”。设置时，它必须是反向代理提供的 HTTPS `/v1` Base URL；未设置时，导出配置回退到宿主机 loopback 上的 Responses URL，供同一服务器宿主机上的 Codex 使用。
9. Launcher/CLI 只导出 Codex 客户端所需配置。用户在容器外的 Codex 主机上手工复制或合并这些配置，然后启动或重启 Codex。

### 正常使用

- ChatGPT 登录和任务 tab 继续使用同一个生产 Electron `userData` 和 `persist:codex-web-gpt-chatgpt` partition。
- 外部 Codex 使用导出的 custom provider/API Key 配置访问 Responses API。它不与服务端容器共享 `HOME`、`CODEX_HOME` 或工作目录。
- 公网客户端只访问反向代理暴露的 HTTPS `/v1`。Responses daemon 的容器监听可以为反向代理或 Docker 端口映射提供容器网络可达性，但不得直接成为公网监听。
- 当公开 Codex Base URL 为空时，客户端配置使用宿主机 `127.0.0.1` 的映射端口；这是“Codex 与 Docker 在同一服务器”场景，不是容器内 loopback。
- Electron CDP 继续只监听 loopback。
- VNC server 只服务同一容器内的 noVNC/websockify，不直接映射到服务器公网地址。
- 现有反向代理只允许两类产品入口：noVNC 路径，以及受 API Key 保护的 `/v1` Responses 路径。`/healthz`、`/admin/*`、CDP 和 VNC 不得由公网代理规则暴露。

### 外部 Codex 配置导出

- 服务端部署不得自动创建、修改或删除容器外 Codex 的 `config.toml`、`auth.json`、hooks 或其它客户端文件。
- API Key、provider、模型、reasoning effort、subagent 兼容设置和其它必要 Codex 项只通过显式导出/复制交付给用户。
- 导出的 provider `base_url` 使用部署配置中的公开 Codex Base URL；该值为空时使用宿主机 loopback Responses URL。
- 导出的客户端配置不得包含容器内绝对路径。需要模型目录文件时，必须同时导出可复制的 catalog 内容，并让最终 `model_catalog_json` 指向客户端主机上的路径，而不是服务端应用目录。
- 远程部署导出不得生成指向容器内 runtime 的 Interrupt command。远程使用的正确性不能依赖 command hook。未来若提供可移植的远程 interrupt hook，它只能是可选加速路径，不能替代断连和超时清理。
- 导出包含本地服务 API Key，属于敏感配置。不得写入普通日志、Git 或非敏感状态快照。

### 客户端断开与孤儿 turn 清理

- 已有 HTTP 请求断开语义保留：当 Responses 客户端连接被运行时/反向代理判定关闭时，必须立即向对应请求传播 abort，并释放该请求持有的 browser/compaction/HTTP ownership。
- 远程部署额外启用 native Codex turn 的“无真实进展” idle timeout。默认值为 **600 秒**，并允许部署配置调整；它不是整个 turn 的最大执行时长。
- idle lease 按 native `thread_id + turn_id` 计算。首次进入建立 lease；文本/推理增量、产生工具调用、收到工具结果、compaction 实际推进/产出等真实业务进展可以续租。单纯 retry/continuation 请求、Responses/adapter heartbeat、browser helper heartbeat 或 TCP 仍连接都不得续租。
- 工具调用已经发出但没有工具结果或其它真实进展时，idle 时间继续累计。普通工具等待、heartbeat、TCP 或 continuation 都不能刷新 last-progress 时间。唯一额外例外是 Native 长等待协议中由 Broker 验证的有效 operation 等待租约：它可以暂停 idle 到期后的终止动作，但不改变累计的无进展时间。没有这类有效等待租约时，连续达到 idle timeout 后，即使 heartbeat 和 TCP 仍正常，服务端也必须取消该 turn 的 HTTP、browser、broker/compaction 等仍存活 ownership，并使额度可以回收。
- Native 等待租约失效、operation 结束或旧 owner 因 fresh/fallback compaction 明确退役后，如果该 turn 没有其他符合条件的 Native 等待 operation，idle 判定必须立即恢复到原 last-progress 时间；若累计无进展已超过阈值，应立即进入同一 terminal timeout/ownership 清理路径，不能从恢复时刻重新给 600 秒。
- idle timeout 后，同一 `thread_id + turn_id` 视为已终止；后续 retry/continuation 不得重新建立新的 lease 来复活该逻辑 turn。
- 该 idle timeout 只属于服务端远程部署合同。现有桌面/本地安装不因此获得新的全局 turn 上限。
- 现有 adapter stall timeout 与 browser helper heartbeat lease 继续保留，但它们解决不同问题：前者处理 adapter 事件流静默，后者处理服务端 helper 消失；二者都不能替代 native turn 的“无真实进展”回收机制。

### 持久化与容器重建

- 整个应用用户 HOME 必须持久化。这样可同时覆盖：
  - `~/.codex-chatgpt-web`；
  - Electron app-data / `userData`；
  - persistent browser partition、cookies、登录状态、Launcher 状态、日志和现有用户级凭据文件。
- 外部 Codex 的 `CODEX_HOME`、项目文件和用户维护的客户端配置不属于服务器 HOME volume。
- 删除并重建容器时，只要复用相同 HOME volume，Launcher 配置、API access 配置和 ChatGPT 登录状态应继续存在。
- 删除 HOME volume 视为显式清除应用身份和登录状态，不提供自动恢复。

### 重启与 24x7 运行

- Docker/Compose 负责容器级自动启动和重启。
- 容器直接启动 Launcher，不依赖 Linux 桌面登录时的 XDG autostart。
- Launcher 仍是 daemon/tunnel 的唯一 supervisor。Docker 或容器级 supervisor 只判断 Launcher 进程和桌面基础进程是否存活，不接管 Launcher 的内部 runtime ownership。
- Launcher 的 daemon/tunnel 崩溃恢复继续使用现有 `RuntimeSupervisor` 合同。
- Xvfb、窗口管理器、VNC/noVNC 或 Launcher 本身退出时，容器 supervisor 可以重启对应顶层进程或让容器失败并由 Docker 重启；不得留下一个对外可连但没有有效 Launcher 所有权的“假健康”桌面。

### 登录失效和人工恢复

- ChatGPT 会话过期、MFA、身份提供方登录和 Cloudflare 等交互继续通过服务器上的 Electron UI 完成。
- 不复制本地浏览器 cookie，不导入外部 profile，也不增加 CDP 登录端口。
- 登录失效不是容器重建理由。用户连接 noVNC 后在现有 Launcher 内重新登录。

### 更新和回退

- Phase 1 的部署版本由容器镜像中的生产 Linux AppImage 决定。
- 服务端升级采用“构建/获取新镜像 → 使用同一 HOME volume 重建容器”的方式。
- 回退采用旧镜像加同一持久化数据重新启动。
- Phase 1 不要求现有 Linux AppImage 自更新器理解只读容器镜像层。部署文档必须明确：服务器部署以容器镜像替换为权威升级路径，不依赖 Launcher 内的 AppImage 自更新完成服务端升级。

## 重要实现决定

### 生产 Launcher 路径

容器必须运行打包后的 Linux x64 AppImage，而不是源码开发入口。当前仓库已经提供：

- `launcher/package.json` 的 Linux AppImage target；
- Linux x64 release artifact 命名；
- `launcher/scripts/smoke-package.cjs` 中通过 `xvfb-run` 启动打包 Launcher 的 smoke 路径；
- `APPIMAGE_EXTRACT_AND_RUN=1` 的 Linux smoke 使用方式。

因此 Phase 1 的部署层应消费真实生产 artifact。实现可从本地构建产物复制 AppImage，也可从受控 release artifact 构建镜像，但运行时不得切换到 DEV profile。

### 容器用户和目录

- 运行用户必须是固定的非 root 用户，例如 `codex`。
- `HOME` 必须位于持久 volume 内，例如 `/home/codex`。
- 服务端部署不要求 `/workspace` 或其它项目代码挂载。若运维者额外挂载目录用于诊断，它不属于 Codex 客户端运行合同。
- 可显式设置下列路径，使服务端生产状态位于持久 HOME：

```text
CODEX_CHATGPT_WEB_HOME=/home/codex/.codex-chatgpt-web
CODEX_WEB_GPT_LAUNCHER_DATA_DIR=/home/codex/.config/Codex Web GPT
```

- 当前服务端运行路径没有 Codex CLI 运行时依赖，因此 Phase 1 镜像**不安装 Codex CLI**。不得仅为了导出客户端配置、运行 Responses daemon 或 Launcher setup 而引入 Codex 包。
- 若未来实现引入不可替代的 Codex CLI 运行时依赖，才允许在镜像中安装一个与该服务版本兼容的固定版本；该依赖必须有明确调用点、版本约束和测试证据，不能恢复“在容器里给用户运行 Codex”的旧部署模型。

### 桌面组件

Phase 1 使用最小 X11 桌面，不引入完整 GNOME/KDE 桌面，也不引入 Guacamole。推荐组件关系为：

```text
Xvfb
 ├─ Openbox 或等价轻量 WM
 ├─ xterm 或等价轻量终端
 └─ Electron Launcher
       ↓ rendered X11 desktop
VNC server
       ↓ loopback
noVNC/websockify
       ↓ internal HTTP/WebSocket
existing reverse proxy
       ↓ HTTPS
browser
```

具体轻量 WM、终端和 VNC server 包可以替换，但替换后仍须满足本 Spec 的窗口交互、剪贴板、认证、网络隔离和持久化验收。

### 网络合同

- 当前核心配置将 Responses host 硬限制为 `127.0.0.1`；本需求实现必须把“进程监听地址”和“外部公开范围”拆开。容器中的 Responses listener 可以绑定容器网络接口，以便 Docker 端口映射或私有 Docker network 到达它。
- 默认宿主机发布仍必须是 loopback，例如 `127.0.0.1:<responses-host-port>:17841`。如果反向代理本身运行在 Docker 中，可改用显式共享的私有 Docker network，并不发布该端口到宿主机公网接口。
- 反向代理对公网只转发 Responses 的 `/v1` API。`/healthz`、`/admin/*` 和任何 control endpoint 不得进入公网 location/rule。
- 公网 `/v1` 必须在 API Key 模式运行。缺失或错误 Bearer key 必须在请求进入 browser/adapter 前拒绝。
- 部署配置中的公开 Codex Base URL 可以为空。非空时必须是 HTTPS URL，并指向反向代理后的 `/v1` Base URL；为空时，客户端导出回退到 `http://127.0.0.1:<responses-host-port>/v1`。
- Electron remote debugging 保持 loopback 绑定。
- VNC server 只允许同一容器中的 noVNC/websockify 连接；不得发布 `5900` 一类 VNC 端口。
- noVNC/websockify 可以监听容器内服务端口，例如 `6080`。
- 若现有反向代理运行在宿主机，Compose 默认应把 noVNC 端口只发布到宿主机 loopback，例如 `127.0.0.1:<host-port>:6080`。
- 若现有反向代理本身运行在 Docker 中，可以通过显式共享的私有 Docker network 访问 noVNC，而不是把端口发布到 `0.0.0.0`。
- 不使用 `network_mode: host`。
- 反向代理必须同时支持 noVNC 静态 HTTP/WebSocket 和 Responses HTTP/SSE，并把外部 `/desktop/` 与 `/v1` 分别稳定映射到对应上游。具体代理产品配置不属于本仓库 Phase 1 交付，但部署文档必须给出路径、SSE buffering/streaming 和 WebSocket 合同。

### Codex 客户端配置所有权

- 服务端部署只生成/导出客户端配置，不自动调用现有 `installCodexIntegration()` 去改写外部 Codex。
- 现有 API Key 导出能力是本需求的基线，但必须移除“客户端一定与服务同机”的假设：
  - `base_url` 不能固定为服务进程自己的 `127.0.0.1`；
  - `model_catalog_json` 不能指向服务端应用目录中的绝对路径；
  - Interrupt hook 不能指向服务端容器里的 runtime command。
- 导出结果必须足够让用户在另一台主机完成手工配置。允许输出多个明确产物，例如 TOML 片段、模型 catalog 内容和必要的客户端环境项；它们都不得自动写入远端文件系统。
- 服务端不得导出 daemon `controlToken`。外部 Codex 只获得客户端 API Key；admin/control 认证继续与客户端认证分离。

### 远程 turn 生命周期

- `Request.signal`/客户端流取消仍是首选的即时清理信号。真实 TCP peer disconnect 必须继续释放 tracked HTTP turn，并将 abort 传播到 ChatGPT Web adapter。
- 远程部署必须额外提供可配置的 native turn idle timeout，默认 `600s`。该值表示“连续没有真实业务进展”的最长时间，不是 adapter silence timeout、HTTP idle timeout，也不是 wall-clock 总时长。
- idle lease 的 authority 是 native Codex `thread_id + turn_id`。同 identity 的多个 HTTP 请求加入同一 lease；只有已证明的业务进展可以把 idle 计时重新归零。请求重试、continuation 本身和任何 heartbeat 都不能刷新 lease。
- 工具等待期间如果没有工具结果或其它真实进展，idle 计时继续运行。Broker 已验证的 Native operation 等待租约可以暂停**到期终止动作**，但不能把 wait/retry 记录成业务进展，也不能修改 last-progress 时间。等待租约结束且没有其他符合条件的 Native operation 后，按原 last-progress 时间继续判定；若已经超过阈值，必须立即走与现有精确 interrupt/cancel 路径等价的 ownership 清理：至少覆盖 active HTTP Responses/compact、ChatGPT browser session、structured compaction，以及与该 turn 绑定且仍存活的 broker ownership。
- 如果客户端连接仍存在，服务端应返回可识别的 terminal timeout/incomplete 结果；如果客户端已经不可达，清理仍必须完成，不能等待响应成功写回。
- timeout 后必须保留有界的 terminal/tombstone 状态，在同一 authority epoch 内拒绝同 identity 复活；该终止记录必须有容量上限或等价回收策略，不能形成新的长期无界内存 ownership。容量轮换只能在 active lease 为 `0` 的明确 epoch 边界发生，并且当前 epoch 必须可诊断；仍有 active lease 时应返回可识别、可重试的容量错误，不能让所有未知 identity 永久共用一个 aborted signal。正常完成则释放活动 lease。

### 远程桌面认证

- Phase 1 不增加独立网关认证。这是用户已确认的范围。
- 远程桌面密码必须由 VNC server 强制验证。noVNC 不能以无认证模式连接一个无密码 VNC server。
- 密码不得写入镜像、Git、日志或命令行参数。
- 部署层应通过只读 secret 文件或等价的运行时文件注入密码，并在启动时生成 VNC server 所需的私有密码文件。
- 外部反向代理必须提供 HTTPS。纯 HTTP 公网访问不符合本 Spec。

### 进程所有权

容器级 supervisor 与 Launcher 的职责必须分离：

```text
container supervisor owns:
  Xvfb
  window manager
  terminal bootstrap
  VNC server
  noVNC/websockify
  Launcher top-level process

Launcher owns:
  Responses daemon
  Tunnel
  MCP/runtime helpers
  Electron browser host and task views
```

不得再使用独立 systemd、supervisor、Compose service 或 shell loop 启动第二个 Responses daemon/tunnel。这样可以保留现有 drain、health、PID ownership、restart budget 和 shutdown 合同。

### Electron/Chromium sandbox

- Electron 必须以非 root 用户运行。
- 不得添加 `--no-sandbox`。
- 不得把 `privileged: true`、host PID、host network、Docker socket 或宽泛 Linux capabilities 作为默认配置。
- 如果标准 Docker 安全配置阻止 Chromium sandbox 启动，必须先用运行证据定位具体内核/namespace/seccomp 原因，再选择最小修复。任何新增 capability 或 seccomp 例外必须单独记录依据并进入安全审查，不能作为无条件默认值。

### Linux secure storage

当前 `api-key-vault.cjs` 明确拒绝 Linux `safeStorage` 的 `basic_text` 和 `unknown` 后端。容器化环境不能通过放宽该检查来取得“可用”。

Phase 1 必须实测 Electron `safeStorage` 在最终容器中的后端：

- 若已使用安全后端，继续使用现有逻辑。
- 若只有 `basic_text`/`unknown`，实现需要给容器提供可用的 D-Bus + Secret Service/keyring 或等价安全后端，再重新验证。
- 不允许修改核心代码，使明文或 `basic_text` 被当作安全持久存储。
- Secret Service/keyring 的解锁凭据必须与 VNC 密码独立，不得从 VNC 密码派生。仅轮换 VNC 密码不得使已有 safeStorage 数据失效。

该项是证据驱动的部署要求，不预先固定具体 keyring 实现。

### 健康状态

容器健康检查至少要区分：

- noVNC/websockify 已监听；
- Launcher 顶层进程仍存活；
- Launcher-owned Responses runtime 在完成初始 setup 后可以按现有 health 合同达到可用状态。

首次尚未完成 ChatGPT/Launcher setup 时，容器可以处于“桌面可连接但应用未完成配置”的初始化状态。健康检查不得因为用户尚未登录 ChatGPT 而无限重启容器。

Responses 健康检查通过容器内部或宿主机私有路径完成。公开 HTTPS 反向代理不得为了健康检查而暴露 `/healthz`。活动 turn 计数可以继续用于诊断，但 health 本身不能因为存在一个正常运行的长 turn 而失败；600 秒 idle timeout 以真实业务进展时间为基准，且可在有效 Native operation 等待租约存在时按上述窄例外暂停终止动作。

## 已接受设计依据

- 被接受产物与版本、可访问入口：无视觉原型。当前决定来源为本任务确认的 Phase 1 决定记录。
- 适用环境：单用户 Linux x86_64 Docker server；浏览器通过现有 HTTPS 反向代理访问 `/desktop/`；容器外 Codex 通过同一反向代理的受 API Key 保护 HTTPS `/v1` 访问 Responses。
- 须保持的结构和行为：生产 Electron Launcher、persistent partition、`WebContentsView`、Launcher runtime ownership、现有登录、MCP/compaction 的功能可用性、task/session 隔离和正确 ownership；客户端断开继续传播 abort。tool authority、rollout replay、compaction source recovery 和 retained browser fallback 的具体行为由 delegated Spec 覆盖，不要求错误或缺少 source proof 时继续保留原 retained epoch。
- 允许调整：基础镜像、容器 supervisor、轻量 WM、终端、VNC server/noVNC 的具体包和版本，只要通过本 Spec 的运行、安全和持久化验收。
- 演示排除项：多人、多租户、ARM64、Guacamole、内置 HTTPS reverse proxy、远程 Responses WebSocket、多客户端密钥管理。
- 核对方式：仓库静态合同、容器运行 smoke、真实 ChatGPT 登录、容器外真实 Codex turn、API Key/反向代理验证、断连和 idle-timeout 清理、重建/重启验证。

## 验收与验证

### 仓库和构建验收

实现至少提供可版本控制的服务器部署资产，能从一个生产 Linux x64 AppImage 得到可运行镜像，并提供 Compose 或等价启动定义。具体文件名可以由实现者选择。

静态检查至少确认：

1. 部署配置没有 `--no-sandbox`。
2. 部署配置没有 `privileged: true`、host network、Docker socket 挂载或公开的 raw Responses/health/admin/CDP/VNC 端口。
3. 现有 reverse proxy 只对公网提供 `/desktop/` 和受 API Key 保护的 Responses `/v1`；`/healthz`、`/admin/*`、CDP 和 VNC 不在公网规则中。
4. HOME 使用持久 volume；服务端部署不要求 `/workspace` 项目挂载。
5. 运行用户不是 root。
6. VNC 密码来自 secret 文件或等价私有文件，不在镜像、Git、日志、Compose 明文 command 中。
7. Launcher 由容器启动一次；部署层没有第二个 daemon/tunnel 启动路径。
8. 运行入口使用生产 AppImage，没有 `--dev-profile`、Vite 或 `dev:launcher`。
9. 镜像不安装 `@openai/codex`、不要求 `CODEX_VERSION`，也没有 `codex --version` 运行验收；除非未来新增并证明真实服务端运行时依赖。
10. 服务端 setup/启动不会修改 `CODEX_HOME/config.toml` 或 `auth.json` 作为部署步骤；客户端 Codex 配置只通过显式导出交付。
11. 导出配置的公开 Base URL 非空时使用部署提供的 HTTPS 值；为空时回退宿主机 `127.0.0.1` Responses 地址。
12. 导出产物不包含容器内 `model_catalog_json` 路径、容器 runtime Interrupt command 或 daemon `controlToken`。
13. 远程部署显式启用默认 600 秒 native turn 无进展 idle timeout；普通桌面/本地安装默认行为不因此改变。

若实现修改任何现有 TypeScript/JavaScript/Launcher 核心代码，必须执行现有相关单元测试和 `bun run verify`。纯部署资产也应增加能覆盖关键启动参数和网络边界的轻量自动检查，避免后续提交意外公开端口或关闭 sandbox。

### Linux x86_64 运行验收

在真实 Linux x86_64 Docker host 上执行：

1. 构建或获取生产 Linux x64 AppImage，并用它构建服务器镜像。
2. 启动容器，证明生产 AppImage 在 Xvfb 中成功创建 Launcher 窗口。不得使用 `--no-sandbox`。
3. 从现有 HTTPS reverse proxy 访问 `/desktop/`，证明静态资源和 WebSocket 都正常。
4. 输入错误 VNC 密码时拒绝桌面访问；正确密码可以进入桌面。
5. 在 noVNC 桌面中操作 Launcher，完成真实 ChatGPT 登录。需要 MFA/身份提供方/Cloudflare 时在同一 Electron UI 中完成。
6. 关闭并重新打开本地浏览器，重新连接 noVNC 后服务器桌面和 Launcher 仍在运行。
7. 在反向代理公开 Responses `/v1` 后，缺少或使用错误 API Key 的 `/v1/models`、`/v1/responses` 请求被拒绝；正确 API Key 可以访问。公网访问 `/healthz` 和 `/admin/*` 必须失败或根本没有路由。
8. 在容器外的真实 Codex 客户端上应用导出配置，完成至少一个真实 ChatGPT Web turn，并覆盖当前项目需要的 Automatic/Zero Risk 路径。客户端工作目录和 `CODEX_HOME` 位于容器外。
9. Full/Automation 模式下由该外部 Codex 完成至少一个 MCP 工具回合，证明 Tunnel/MCP 与 outer Codex 工具调用仍保持现有合同。
10. 触发 delegated compaction 路径，证明 task/session 隔离和 browser/session ownership 仍然正确：exact source execution 可按 delegated Spec 复用；proof 不足或 identity 不精确匹配时，旧 retained conversation 会先退役，再使用 fresh compaction / fresh browser epoch。验收不得要求 retained epoch 在所有情况下保持不变。
11. 让外部 Codex 在活动流中正常断开 TCP/HTTP 连接，确认对应 HTTP/browser/compaction ownership 被及时取消，活动 turn 计数回到零。
12. 将远程 native turn idle timeout 临时配置为一个短测试值并覆盖三种情况：仅持续发送 adapter/browser helper heartbeat、TCP 或 continuation 而没有真实业务进展时，同一 `thread_id + turn_id` 仍会超时并被强制清理；文本/推理增量、工具调用产生、工具结果返回或 compaction 实际进展可以刷新 last-progress；已启动 Native operation 在没有工具结果时，只有 Broker 验证的 120 秒等待租约可以跨过 idle 阈值暂停终止动作，且观测到的 last-progress 不应被 wait/retry 改写。停止合法查询并让等待租约失效后，如果原 idle 时间已经越过阈值，应立即触发同一 timeout/ownership 清理，而不是重新得到一个完整 idle 周期。测试后恢复部署默认 600 秒。
13. 在宿主机确认 Responses raw port、health、admin、CDP 和 VNC 没有公网监听。Responses/noVNC 端口只允许 reverse proxy 所需的宿主机 loopback 或 private-network 可达范围。
14. 验证公开 Codex Base URL 为空时，导出配置指向宿主机 `127.0.0.1`；设置 HTTPS Base URL 后，重新导出只改变客户端目标，不自动写外部 Codex 文件。

### 持久化验收

1. 完成 ChatGPT 登录和 Launcher setup。
2. 停止并删除容器，但保留 HOME volume。
3. 用同一镜像重建容器，确认：
   - ChatGPT 登录状态仍有效，或在服务端会话本身已失效时只要求正常重新认证；
   - Launcher setup/state 仍存在；
   - API Key 接入策略和公开 Base URL 部署配置仍按预期生效；
   - 容器外 Codex 文件未被服务器重建流程修改。
4. 用另一个镜像版本重复重建，确认相同持久化合同成立。
5. 回退到上一镜像，确认容器可以用同一数据重新启动。若应用数据本身发生未来版本不可逆迁移，该迁移不由本 Phase 1 自动解决，但必须失败明确，不能静默重置 HOME。

### 重启验收

1. 在没有活动 turn 时重启容器，确认桌面、Launcher 和 Launcher-owned runtime 自动恢复。
2. 模拟 Launcher 顶层异常退出，确认不会留下一个“noVNC 正常但 Launcher 永久死亡”的健康容器。
3. 模拟 Responses daemon 异常退出，确认恢复仍由现有 Launcher `RuntimeSupervisor` 完成，而不是由容器启动第二个 daemon。
4. 服务器重启后，Compose/restart policy 能恢复桌面容器；连接 noVNC 后不需要重新创建应用配置，外部 Codex 继续使用原已复制的客户端配置即可重新连接。

### secure storage 验收

在最终镜像中记录 Electron `safeStorage` 的实际可用性和 backend：

- `safeStorage.isEncryptionAvailable()` 必须为可接受状态；
- Linux backend 不得为 `basic_text` 或 `unknown`；
- 写入依赖 safeStorage 的现有密钥后，重启/重建容器并复用 HOME volume，密钥应仍可按现有产品合同读取；
- 在保持 HOME volume 和 keyring 解锁凭据不变的前提下，仅轮换 VNC 密码并重建容器，已有 safeStorage 密钥仍应可读取；
- 如果初始镜像不满足以上条件，先补足安全 keyring/Secret Service，再重复验收。不得通过修改核心检查来放宽标准。

## 风险与授权

- 用户已选择不增加反向代理层的独立认证。远程桌面只依赖 HTTPS 加 VNC/noVNC 密码。该入口如果对公网开放，风险高于 VPN 或额外网关认证方案；这是本阶段已接受的取舍。
- Responses API 是新的外部入口。它必须使用 HTTPS + 独立客户端 API Key；API Key 泄漏等价于获得该单用户实例的 `/v1` 调用权限。密钥应作为登录凭据处理并支持轮换。
- Responses 进程为了被 Docker/私有网络转发，容器内可能不再只监听 loopback。这扩大了容器网络内的可达范围，因此安全边界必须由 Docker publication/private network、反向代理 path allowlist 和 API Key 三层共同约束；不能把“进程不再是 loopback”误解为允许公网直连。
- daemon `controlToken` 的权限高于客户端 API Key，且 `/admin/*` 不使用客户端 API Key 作为授权边界。`controlToken` 不得出现在远程 Codex 导出、反向代理 header 注入或公网响应中。
- 600 秒 idle timeout 会终止连续 600 秒没有真实业务进展、且没有有效 Native operation 等待租约保护终止动作的远程 turn，包括工具回调永久丢失或等待消费者已经失联的情况。合法 Native 长等待可凭 Broker 验证的 120 秒等待租约跨过 600 秒，但 wait/retry 不算真实业务进展，租约一旦失效就按原 last-progress 时间立即恢复清理判断；部署可调整 idle 阈值，但不得通过 heartbeat 冒充业务进展来续租。
- 持久 HOME volume 包含 ChatGPT 浏览器会话和其它敏感应用状态。它必须被视为登录凭据，不得同步到不可信存储、提交到 Git 或作为普通诊断附件上传。
- 外部 Codex 的文件和命令副作用发生在客户端主机的工作目录，不由服务器容器文件系统隔离。现有 Codex sandbox/approval 仍是该客户端主机上的权限控制边界。
- 同一容器用户下的其它进程仍属于现有 same-user trust boundary。Phase 1 不尝试防御已取得该用户代码执行能力的恶意进程。
- Docker 本身不是新的租户隔离合同。单用户/单实例前提不能因为“运行在容器里”而放宽。
- 外部 reverse proxy 的证书续期、公网防火墙、DDoS/速率限制和域名运维不由本项目管理。部署文档定义 noVNC 与 Responses `/v1` upstream 合同，但不接管这些基础设施。
- Linux secure storage 是当前最大的容器环境证据风险。如果安全 backend 无法成立，Phase 1 不能通过完整验收，也不能用明文降级绕过。
- AppImage 内置更新器不是服务端容器的权威升级路径。用户应通过镜像升级和回退管理版本。

## 实现自由

- 可选择 Ubuntu、Debian 或其它满足 Electron 41 和项目运行依赖的 glibc Linux x86_64 基础镜像；本 Spec 不固定发行版。
- 可选择 supervisord、s6、tini 加自定义 supervisor 或其它最小进程管理方式。必须保持“容器 supervisor 不接管 Launcher-owned daemon/tunnel”的边界。
- 可替换 Openbox、xterm、x11vnc 等具体包，但不得引入完整桌面或 Guacamole 作为 Phase 1 必需依赖。
- noVNC/Responses 的容器内部监听端口、Xvfb display 编号和默认桌面分辨率可由实现者选择，只要不会改变公网 path、认证和端口安全边界。
- “公开 Codex Base URL”的部署变量名、Responses host-port 变量名和 600 秒 idle timeout 的内部配置字段名由实现者选择；其空值语义、默认值和验收行为必须符合本 Spec。
- 客户端导出可以通过 Launcher UI、CLI 或两者提供；只要产物可复制到另一台主机、不自动写外部 Codex、且不包含服务端本地路径或 control token。
- 远程 idle lease 可以实现为独立 turn registry，或复用现有 HTTP/session ownership 数据结构；实现必须按 native turn identity 保持单一 last-progress authority，并只在真实业务进展时刷新它，不能简单给每个 HTTP 请求重新计时。Native 长等待的 120 秒 operation lease 是独立的终止暂停条件；实现可以订阅或查询其状态，但不得把它写回成 remote idle 的业务进展。
- 部署资产可以放在 `deploy/server/` 或等价清晰目录；确切文件组织不属于公共运行合同。
- 当前 `src/config.ts` 明确拒绝非 loopback Responses host，现有 API Key export 又固定本机 URL，因此本次需求预计需要最小核心改动。除网络绑定、客户端导出、远程 idle lifecycle，以及 delegated Spec 为 authority、tool registry、rollout replay 和 compaction source recovery 明确要求的最小 adapter/broker 修改外，不应顺带重构 Launcher 或其它无关行为。

## 来源与开放问题

当前仓库事实来源：

- `docs/architecture.md`：Launcher-owned daemon、persistent Electron partition、`WebContentsView` 生命周期、Linux AppImage、Linux launcher supervisor 和 loopback 安全约束。
- `docs/security-model.md`：same-user trust boundary、browser session 风险、普通本地 loopback 与服务端 API-Key 私有容器监听/HTTPS 反代边界。
- `src/config.ts`：Responses 默认 `127.0.0.1:17841`，并拒绝非 loopback host。
- `src/api-access.ts`：API Key 模式对 `/v1/*` 执行 Bearer 认证，并将客户端 API Key 与 daemon control token 分离。
- `src/api-key-codex-config.ts`、`src/api-key-cli.ts`：已有“只渲染/导出、不自动写 Codex”的 API Key 配置路径，但当前仍固定 `127.0.0.1`、服务端 catalog 路径和本机 runtime Interrupt hook，需要为远程客户端消除这些本机假设。
- `src/server.ts`、`tests/server-lifecycle.test.ts`：HTTP turn 已绑定 request abort；真实 TCP peer disconnect 有测试证明会释放 tracked stream；精确 Interrupt endpoint 可取消同一 native thread/turn 的 HTTP/browser/compaction ownership。
- `src/stall-timeout.ts`、`tests/bridge-stall-timeout.test.ts`：现有默认 300 秒 stall timeout 只针对 adapter 静默，不等价于 Codex 客户端存活租约。
- `launcher/electron/profile.cjs`：生产 `~/.codex-chatgpt-web`、`~/.codex`、Electron `userData` 和 `persist:codex-web-gpt-chatgpt` partition。
- `launcher/electron/browser-host.cjs`：生产 `WebContentsView`、persistent partition、helper heartbeat/browser lease 使用；健康 helper 会持续续租，因此该 lease 不能证明外部 Codex 仍在线。
- `launcher/electron/runtime-supervisor.cjs`：Launcher-owned daemon/tunnel 生命周期。
- `launcher/package.json`：Linux x64 AppImage 打包入口。
- `launcher/scripts/smoke-package.cjs`：Linux 打包 smoke 已使用 `xvfb-run` 和 `APPIMAGE_EXTRACT_AND_RUN=1`。
- `launcher/electron/api-key-vault.cjs`：Linux secure storage 拒绝 `basic_text`/`unknown` backend。

已确认的用户决定：

- 单用户、单实例、可信 Linux 主机/OS 用户；
- Docker 部署；
- Linux x86_64 only；
- Codex 在容器外运行，通过服务接口访问服务器；
- 复用现有 HTTPS reverse proxy 暴露受 API Key 保护的 Responses `/v1`；raw Responses 端口不直接公开；
- 当前服务没有 Codex CLI 运行时依赖，因此服务器镜像不安装 Codex；未来只有出现真实依赖时才安装兼容固定版本；
- 服务端不再自动配置 Codex，改为导出并由用户复制/合并客户端配置；
- 公开 Codex Base URL 由部署配置提供，可以为空；为空时导出宿主机 `127.0.0.1` 地址；
- 正常 HTTP 断开立即取消；远程部署另设可配置 native turn 无进展 idle timeout，默认 600 秒；
- idle timeout 只属于服务端远程部署，不改变普通桌面/本地安装默认行为，也不限制有持续真实进展的 turn 总时长；有效 Native operation 等待租约可暂停其终止动作，但不刷新真实业务进展时间，租约失效后按原时间恢复；
- 远程正确性不依赖 Interrupt command hook；
- 持久 HOME volume 只保存服务器应用身份和运行状态，不承担外部 Codex 项目/配置持久化；
- 远程桌面不增加额外网关认证，继续使用 HTTPS + VNC/noVNC 密码；Responses API 则单独要求客户端 API Key；
- 以最小部署改造保留现有核心运行模型。

仍需实现阶段用运行证据确定的问题只有一项：最终容器中 Electron `safeStorage` 应使用哪一种安全 Secret Service/keyring 实现。选择本身交给实现者，但验收标准已经固定：不能是 `basic_text` 或 `unknown`，也不能通过放宽核心安全检查来规避。
