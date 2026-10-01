# Project documentation

These pages describe maintained behavior, operating procedures, and decisions that need a lasting
explanation. Start with the topic that owns the contract rather than a completed development plan.

| Topic | Maintained location |
| --- | --- |
| Components, routing, browser ownership, and service lifecycle | [Architecture](architecture.md) |
| Trust, tool authority, credentials, and isolation | [Security model](security-model.md) |
| Native operation identity, waiting, results, and compaction | [Native tool protocol](native-tool-protocol.md) |
| API access, local keys, manual Codex configuration, and restart behavior | [API Key mode](api-key-mode.md) |
| Upstream routing, explicit model selection, and Codex metadata | [Upstream provider](upstream-provider.md) |
| Global HTTP/HTTPS proxy authentication and failure handling | [Network proxy](network-proxy.md) |
| Same-conversation work, checkpoints, retention, and handoff | [Session continuity](session-continuity.md) |
| Docker desktop, external Codex, private networking, and persistence | [Server deployment](../deploy/server/README.md) |
| Isolated browser and MCP development | [DEV chat mode](dev-chat.md) |
| Release gates and the limits of recorded evidence | [Release validation](release-validation.md) |

## Document lifetime

Keep public contracts and necessary decision reasons with their owning topic. Keep local task
specifications, implementation plans, review rounds, prototypes, and raw validation output under
the ignored `.dev-workflows/<task>/` workspace. A task report is not a second source of current
product behavior. See [Contributing](../CONTRIBUTING.md#documentation-lifetime).

`docs/dev/request-context-navigation/` is the existing, unimplemented design exception. Its files
remain unchanged; they are not a claim that the proposed navigation behavior is implemented.
