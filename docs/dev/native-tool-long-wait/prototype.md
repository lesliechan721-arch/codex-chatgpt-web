# Native Tool Long Wait DEV 技术验证

**当前状态（2026-09-24）：本文件保留原型的操作和实测记录。用户随后确认前期技术验证完成并授权正式实施，当前结果见 [实施记录](work.md)。** 正式 Automatic DEV 也使用 `Codex Native3 DEV`，但只有显式启用 `--native-tool-long-wait-probe` 并保存对应配置时才运行本文件的双工具探针；不能再按连接器名称推断探针模式。正式开发应刷新为完整的新 MCP 合同，不使用下文的“只有两个工具”作为正式合同验收。

## 目的

本验证只检查 `spec.md` 的长等待传输假设。它不是正式实现。

验证使用独立连接器：

```text
Codex Native3 DEV
```

该名称不会修改 `Codex Native2` 或 `Codex Native2 DEV` 的 ChatGPT connector ABI 缓存。

## 验证形状

专用连接器只公开两个工具：

- `codex_exec(turn_token, operation_id, ...)`
- `codex_tool_wait(turn_token, operation_id)`

`codex_exec` 的 `cmd` 在此验证中只是 inert label。它不会执行 shell 命令。

第一次 `codex_exec` 会在 Broker 中建立 operation，并只派发一次 DEV 模拟 Native tool：

```text
dev_long_wait_probe
```

DEV driver 固定延迟 45 秒后返回该模拟结果。连接器每次最多等待 30 秒。因此真实 ChatGPT 应先看到：

```json
{
  "kind": "codex_native_pending",
  "operation_id": 1,
  "next_tool": "codex_tool_wait"
}
```

随后 ChatGPT 用同一个 `operation_id` 调用 `codex_tool_wait`。该调用只读取原 operation，不创建新的 Native dispatch。

相同 `operation_id` 配合不同原始参数会失败。新的逻辑调用必须分配新的正整数 `operation_id`。

## 启用

先启动隔离 DEV Launcher：

```bash
bun run launcher:dev
```

源码验证使用上面的 Launcher 开发命令，以加载工作区内的 MCP 实现。已有 Automatic DEV Tunnel ID 和 runtime key 时，可以省略下面命令末尾的两个凭据参数；不要填入 Zero Risk Tunnel ID。

然后配置 Automatic Full DEV profile，并启用此 probe：

```bash
bun run src/cli.ts dev setup --full \
  --automatic-browser-interaction \
  --native-tool-long-wait-probe \
  --tunnel-id <DEV_TUNNEL_ID> \
  --runtime-key-file <DEV_RUNTIME_KEY_FILE>
```

在 ChatGPT 中对同一个 DEV tunnel 新建 connector，名称必须完全是：

```text
Codex Native3 DEV
```

Authentication 使用 `None`。不要重命名或刷新已有的 `Codex Native2` 和 `Codex Native2 DEV` connector。

如果 `Codex Native3 DEV` 在 DEV runtime 启动前创建，或创建时仍显示旧工具，在 ChatGPT 设置的“插件”中打开这个连接器并点“刷新”。开始验证前，确认它只列出 `codex_exec` 和 `codex_tool_wait`，且两者的输入架构都含 `operation_id`。

## 真实链路验证

用一个新的 DEV chat 发起最小请求，例如：

```bash
bun run dev:chat native-long-wait-probe \
  "Use the attached DEV connector to run codex_exec once. Allocate operation_id 1 before the first call. If it returns pending, keep calling codex_tool_wait with operation_id 1 until the result arrives. Then report the tool sequence and result."
```

记录以下证据：

1. ChatGPT 首次调用 `codex_exec` 时已经带 `operation_id=1`。
2. 首次调用约 30 秒后得到 pending，而不是 MCP/Tunnel 超时或 connector 断开。
3. ChatGPT 随后调用 `codex_tool_wait(operation_id=1)`。
4. 约 45 秒后的模拟 Native 结果通过 wait 返回。
5. Broker 日志只出现一次 `dev_long_wait_probe` dispatch。
6. 同一 `operation_id` 的同参数重试不产生第二次 dispatch。
7. 新 `operation_id` 会产生新的 dispatch。

如果第 2、3 或 4 项失败，则 `spec.md` 的当前 topology 不能作为实现基线，应先修改方案。

## 2026-09-24 实测结果

环境为隔离 Automatic Full DEV profile、源码 DEV Launcher、`6.0.1-2` runtime 和独立的 `Codex Native3 DEV` 连接器。连接器创建时 DEV 已退出，因此它最初缓存了旧的六个 `codex_*` 工具。启动探针 runtime 后，在 ChatGPT 的连接器详情页刷新，工具列表变为 `codex_exec`、`codex_tool_wait`，两个 schema 均包含 `operation_id`。

- 首轮真实 ChatGPT → Connector → Tunnel 调用（trace `be8a55d820b6`）：首次 `codex_exec(operation_id=1)` 得到 pending；ChatGPT 随后调用 `codex_tool_wait(operation_id=1)`，收到 45 秒 DEV 模拟结果并完成回答。Broker 仅派发一次 `dev_long_wait_probe`。
- 同一轮内的身份验证（trace `8489672395a2`）：`operation_id=1` 的同参数 `codex_exec` 重试返回原 `call_id`；Broker 没有第二次派发。新的 `operation_id=2` 产生不同 `call_id` 和一次新派发；两个结果都经 wait 返回。模拟结果均标记 `side_effects_performed=false`。

上述证据覆盖本节第 1—7 项的正常传输路径。首次 pending 或结果回执丢失、MCP/Tunnel reconnect、11 分钟人工输入以及远程 600 秒 idle 仍未验证，不能据此把 `spec.md` 升级为实施基线。

## 当前边界

仓库自动测试只验证 connector ABI、Broker operation identity、去重和 wait 语义。它不能替代真实 ChatGPT/Tunnel 证据。

此 probe 没有验证 11 分钟 `request_user_input`、初次回执丢失重连和最终生产工具迁移。正式方案只在同一存活 Broker capability 内保留 operation；跨 Broker/所有者进程重启的 durable store 不在 `spec.md` 范围内。
