# API Key 上游模型发现与 Codex 元数据归一化 Spec

## 本次交付与审阅导航

本规格定义 API Key 模式下新的上游模型发现、选择和 Codex `ModelInfo` 元数据生成规则。

本规格是一个新的开发规格。历史文档 `docs/dev/api-key-upstream-provider/spec.md` 保持原样，不在本任务中修改，也不把该历史文档改写成当前行为说明。该历史文档可以作为已有实现背景，但当它和本规格在“模型筛选、模型选择、模型目录、模型元数据”范围内冲突时，以本规格为本次实现目标。

本次变化集中在四个主题：

1. 删除新的上游配置中的正则模型筛选。获取上游模型时必须展示全部可识别模型，由用户逐项勾选需要启用的模型。
2. 只有已勾选模型可以获得上游路由授权；最终 Codex catalog 还要求该模型在本次成功发现结果中存在，不能为 stale selection 或失败的目录请求伪造 catalog 行。
3. 每个已勾选模型支持“上游返回 / 默认填充 / fallback 填充 / 用户自定义”元数据模式；可选项和默认项由当前模型 ID 与上游是否返回 `models[]` 元数据决定。
4. 项目负责把标准 `data[].id`、部分 `models[]` 或完整 `models[]` 归一化成 Codex 可以整体反序列化的完整 `ModelInfo`。动态 `/v1/models`、Launcher preview 和静态导出必须共用同一 normalizer；静态导出消费它实际获取的那次已验证动态结果，不建立“同 config revision 跨时间必须相等”的额外快照合同。

本规格不改变以下范围：

- `chatgpt-web/*` 本地模型的现有生成与路由；
- 上游 Base URL、API Key、代理策略；
- Responses、compaction、search、images 的既有上游端点语义，除“模型是否允许路由”改为显式模型选择外；
- `model_catalog_json` 的当前使用方式。本任务不删除它。

### 本轮确认状态

本文件从 SHA-256 `3349a79c92e0fd55b888604adc26b0d6798a8a2f52fd542a294187d2ba91c6ed` 的 review 版本修订。2026-09-20 的决策访谈已确认本轮 review 提出的材料问题，包括：

- Codex instructions 由项目信任边界拥有，上游和 custom 不得覆盖；
- custom 固定为 `baseMode + overrides`，并确认字段锁定、`null`、对象/数组覆盖和 `baseMode` 持久化语义；
- 新配置固定为 `version: 2`，所有 v1 `selected / all / regex` 配置升级后直接失效并自动删除，不做迁移或兼容执行；
- 动态和静态目录只要求同一生成规则以及“导出与其实际消费的动态响应一致”，不要求同 config revision 跨时间强等价；
- `ModelInfo` 字段/类型 schema 与 bundled metadata 必须绑定同一个固定 Codex revision，并由目标 Codex 真实 parser 做发布 smoke；
- stale selection 在成功目录中明确缺失，或整个目录请求失败时，都保持路由授权但不发布 catalog 行；
- configured metadata mode 与 effective mode 分离，来源失效不静默改写持久化选择；
- `data[]` 与 `models[]` 作为独立发现来源容错。

随后对 SHA-256 `0d0def12efe0ebc6ffd0ee973531137cf742396c9014c28cec4ad6d34c7b8993` 版本做的复核又发现 4 个实现闭合问题。
本版本已进一步明确：

- `model_messages` 整体以及三个 `include_*_usage_instructions` 开关属于项目拥有的 Agent-control metadata；
- persisted-invalid/degraded custom 可以在未被用户修改时原样 round-trip，但新建或修改 custom 仍必须通过当前 schema；
- bundled/schema generation 与 release parser smoke 必须共享唯一 Codex source lock，并验证 parser identity；
- v1 自动清理由 provider-config storage 的 reset marker、core fail-closed 和 Launcher vault cleanup 共同完成。

这些是对已确认方向的安全与可实现性闭合，不改变此前产品选择。除明确标为“建议”或“实施自由”的内容外，上述规则均作为实现合同。
当前没有遗留需要实施者自行决定的材料产品语义。

## 1. 用户结果与已确定选择

### 1.1 全量发现，显式启用

Launcher 获取上游模型后，必须显示所有有效的上游模型 ID，不再用正则表达式过滤候选列表。

“显示”和“启用”必须分离：

- 上游返回且模型 ID 合法的模型：作为候选项显示；
- 用户勾选的模型：进入已启用集合；
- 只有已启用模型：可以进入最终 Codex 模型目录，并允许 `/v1/responses` 与 `/v1/responses/compact` 使用该模型；
- 未勾选模型：即使上游真实支持，也不得通过直接填写模型 ID 绕过本地选择限制。

本地命名空间 `chatgpt-web/*` 始终由项目本地模型目录和本地路由拥有。上游返回同名 ID 时必须忽略，不能覆盖、替换或取得路由权。

### 1.2 元数据默认优先级

自动元数据选择采用以下方向：

```text
上游明确返回且字段合法的 metadata
    >
项目内建的 Codex bundled metadata（exact slug）
    >
项目 conservative generic fallback
```

这里的“上游优先”不是把半完整上游行直接交给 Codex。项目必须先选择 baseline，再逐字段吸收上游的合法字段，最后执行完整 `ModelInfo` 校验。

### 1.3 元数据模式矩阵

Launcher 对每个模型只显示当前有意义的模式。用户已确认以下矩阵：

| 当前模型事实 | 可选模式 | 自动默认 |
| --- | --- | --- |
| 上游有匹配 `models[]` 行，且 exact slug 命中 bundled metadata | 上游返回 / 默认填充 / fallback 填充 / 用户自定义 | 上游返回 |
| 上游有匹配 `models[]` 行，但没有 bundled metadata | 上游返回 / fallback 填充 / 用户自定义 | 上游返回 |
| 上游没有匹配 `models[]` 行，但 exact slug 命中 bundled metadata | 默认填充 / fallback 填充 / 用户自定义 | 默认填充 |
| 上游没有匹配 `models[]` 行，且没有 bundled metadata | fallback 填充 / 用户自定义 | fallback 填充 |

“上游有匹配 `models[]` 行”只要求存在一个 `slug` 合法并精确等于模型 ID 的对象行。该行的其它字段仍按字段级校验处理。某个非法字段不能使整个模型失去“上游返回”来源，也不能使整份目录解析失败。

“默认填充”专指项目随版本同步保存的 Codex bundled metadata，并且只允许 exact slug 匹配。不得使用前缀、模糊匹配、家族猜测或相似模型替代。

“fallback 填充”专指项目自己的 conservative generic `ModelInfo`。它不是 Codex 内部 `model_info_from_slug()` 的运行时调用，也不应完整复制该函数中的能力假设。

### 1.4 自动默认与显式选择

新勾选模型如果用户没有主动修改元数据模式，持久化层使用“无显式 override”表示自动模式，不增加第五个可见的“自动”模式。

运行时根据第 1.3 节矩阵重新计算当前自动默认。

用户主动选择某个模式后，持久化该显式选择。显式选择的语义如下：

- `upstream`：使用“上游合法且允许覆盖的字段 > exact bundled baseline > generic baseline”的合并策略；
- `default`：忽略上游元数据，只使用 exact bundled metadata；
- `fallback`：忽略上游和 bundled metadata，只使用 generic fallback；
- `custom`：在持久化的 `baseMode` 结果上应用用户 overrides，再执行项目不变量和完整校验。

configured mode 与 effective mode 是两个不同状态。显式来源后来不可用时：

- 不自动改写磁盘上的 configured mode；
- Launcher 必须显示 configured mode、来源不可用状态和本次 effective fallback；
- 普通可选项仍严格由第 1.3 节矩阵决定；不可用的旧 configured mode 作为当前状态显示，不伪装成仍可选择的新选项；
- 用户可以保存与 metadata 无关的其它设置而保留该旧值；
- 用户一旦主动修改该模型的 metadata mode，就必须选择当前可用模式或恢复自动。

`upstream` 来源不可用时，effective baseline 依次退化到 exact bundled、generic。`default` 来源不可用时，effective baseline 退化到 generic。`custom` 的详细退化语义见第 10.3 节。

## 2. 模型发现

### 2.1 支持的上游响应形状

上游 `GET /models` 可以提供以下一种或两种结构：

```json
{
  "object": "list",
  "data": [
    { "id": "model-a" }
  ],
  "models": [
    { "slug": "model-a", "display_name": "Model A" }
  ]
}
```

标准模型 ID 来源：

- `data[].id`

Codex 元数据来源：

- `models[].slug`
- 同一个 `models[]` 对象中的其它已识别 Codex metadata 字段

`data[]` 与 `models[]` 是两个独立发现来源。一个已声明来源结构错误时，只废弃该来源；另一边如果可读取，仍继续用于本次发现。只有两边都不可用时，本次模型发现才按目录 schema 失败处理。

这是一项已确认的容错合同，不表示项目接受任意第三方结构。每个来源内部仍必须执行第 2.2 节的行级和字段级校验。

### 2.2 行级容错

模型目录必须按行处理，不能继续使用“`models[]` 中每一行都必须先通过完整 rich row validator，否则整份响应失败”的策略。

规则：

1. `data[]` 中不是对象的行忽略；
2. `data[]` 中 `id` 非法的行忽略；
3. `models[]` 中不是对象的行忽略；
4. `models[]` 中 `slug` 非法的行忽略；
5. 合法 `slug` 行中的每个 metadata 字段单独做类型和结构校验；
6. 非法 metadata 字段忽略，不覆盖 baseline；
7. 合法字段保留，作为 `upstream` 模式的 override 来源；
8. 任何单行或单字段错误都不能让其它模型从候选列表消失。

### 2.3 去重和身份

模型 ID 必须继续使用现有 ID 约束：

- 非空字符串；
- 不包含控制字符；
- 不带首尾空白；
- 长度不超过项目限制；
- 不能使用 `chatgpt-web/*` 命名空间。

同一 ID 同时出现在 `data[]` 与 `models[]` 时，只产生一个候选模型。

同一来源重复返回同一 ID 时，候选列表只显示一次。规范不要求“第一条 `models[]` wins”这一具体策略。实现可以选择一个确定性的重复行解析方式，但必须满足：

- 相同输入得到相同结果；
- 重复行不能产生第二个候选模型；
- 每个实际采用的字段仍单独通过目标 schema 校验；
- 不允许通过重复行绕过项目不变量、受保护 Agent-control metadata 或最终 `ModelInfo` validator。

Launcher 默认按上游首次发现顺序显示候选模型。搜索只做本地 UI 过滤，不改变已选择集合，也不改变持久化顺序语义。

### 2.4 已选但本次未发现的模型

已保存的模型不能因为一次 `/models` 响应缺失或目录请求失败就从用户配置中自动删除。

Launcher 必须继续显示这些已选模型，并区分至少两种状态：

- **成功发现但明确缺失**：本次 `/models` 成功且至少一个发现来源可用，但该模型 ID 不在当前发现集合中；
- **目录请求失败**：transport、HTTP 或整体 schema 失败，没有本次可用的上游发现集合。

两种状态下都遵守同一已确认路由语义：

- 该模型仍属于本地允许路由的已选集合；
- 实际 `/v1/responses` 或 `/v1/responses/compact` 请求仍可转发给已配置上游，由上游决定该 ID 是否真实可用；
- 项目不自动删除用户的 v2 selection。

但 catalog 发布语义不同于路由授权：没有本次发现证据时，不得使用 bundled 或 generic metadata 伪造该上游模型仍存在。因此：

- 成功目录明确缺失的 stale selection 不进入本次 `/v1/models.data[]` 或 `/v1/models.models[]`；
- 整个上游目录请求失败时，本次动态 catalog 不发布任何上游模型，只保留本地 `chatgpt-web/*` catalog；
- 路由 allowlist 与 catalog 可见性必须分别判断，不能用 catalog 缺失反推取消路由授权。

## 3. 元数据来源与归一化

### 3.1 最终目标

每个进入最终 `models[]` 的上游模型，都必须先生成一个可以被当前目标 Codex `ModelsResponse { models: Vec<ModelInfo> }` 整体解析的完整行。

不能继续把“看起来像 rich metadata 的部分对象”当成完整 `ModelInfo` 直接写入 `api-key-models.json` 或 `/v1/models.models[]`。

### 3.2 当前必须保证的字段

归一化后的最终行至少必须保证以下字段存在并通过类型校验：

| 字段 | 约束 |
| --- | --- |
| `slug` | 精确等于上游模型 ID |
| `display_name` | 非空字符串 |
| `supported_reasoning_levels` | 合法数组，可以为空 |
| `shell_type` | 合法 Codex shell type |
| `visibility` | 最终已发布模型必须可列出 |
| `supported_in_api` | 最终已发布模型必须为 `true` |
| `priority` | 安全整数 |
| `support_verbosity` | boolean |
| `truncation_policy` | 包含合法 `mode` 与 `limit` |
| `experimental_supported_tools` | 合法数组，可以为空 |
| instructions | `base_instructions` 或 `model_messages.instructions_template` 至少一个存在，并来自受信任项目 baseline |

其它字段只有在第 4 节生成的目标 Codex schema 识别、类型合法，并且没有被第 3.3 节设为受保护路径时才可以进入最终行。真正由目标 Codex serde 提供默认值的字段可以省略。

最终 validator、上游字段识别和 custom 字段识别必须来自同一个目标 Codex revision 的版本化 schema，不能从 `models.json` 中“出现过哪些键”反推完整 schema。它是输出边界 validator，也是字段识别的规范来源。

### 3.3 项目拥有的目录与 instructions 不变量

无论 metadata 来源是什么，最终已发布上游模型必须满足以下项目目录不变量：

```text
slug == selected model id
visibility == "list"
supported_in_api == true
```

这些字段由本项目的“用户已选模型并允许发布”事实拥有。上游 metadata 和用户 custom 不能改写它们。

会影响 Codex Agent 指令、策略注入或项目指令装配的 metadata 也属于项目信任边界。以下顶层字段/对象受保护：

```text
base_instructions
model_messages
include_skills_usage_instructions
include_plugin_usage_instructions
include_apps_usage_instructions
```

其中 `model_messages` 必须作为整个对象受保护，而不是只保护 `model_messages.instructions_template`。固定目标 Codex revision
中如果新增 `persistent_instructions`、`approvals`、`collaboration_modes`、`auto_review`、`permissions`、
`multi_agent`、`token_budget`、`guardian_v2`、`confirmation_policies` 或其它新的 `model_messages.*` 字段，
它们自动继承同一保护边界，不需要项目逐个补黑名单。

受保护 Agent-control metadata 的可信来源只能是：

- 与固定目标 Codex revision 一起生成并由项目打包的 bundled baseline；或
- 项目自己的 generic baseline。

第三方上游不能覆盖这些字段/对象；解析上游 metadata 时必须忽略相应值。custom 也不能覆盖它们；用户新建或修改 custom
时，对这类 override 必须报校验错误。

“对象整体替换”只适用于允许用户编辑的对象。`model_messages` 不参与 custom 对象替换，也不参与 upstream 对象覆盖。
项目目录不变量和受保护 Agent-control metadata 必须在 upstream/custom 合并之后重新施加。这是安全不变量，不属于隐式 deep merge。

### 3.4 上游模式

`upstream` 模式的解析顺序：

```text
exact bundled baseline（存在时）
    else generic baseline
        ↓
覆盖当前上游 models[] 行中逐字段校验通过、且允许上游控制的字段
        ↓
重新应用项目目录不变量与受保护 Agent-control metadata
        ↓
最终完整 ModelInfo 校验
```

上游字段校验必须逐字段进行。一个字段失败时只丢弃该字段，不能丢弃整行，也不能回退掉同一行其它合法字段。

`slug` 只用于匹配模型身份，不参与普通覆盖。`visibility`、`supported_in_api` 以及第 3.3 节全部受保护 Agent-control
metadata 即使类型合法也不能由上游覆盖。

当本次没有匹配 `models[]` 行时，显式 `upstream` configured mode 仍保留，但 effective baseline 退化到 exact bundled；若 bundled 也不存在，则使用 generic。

### 3.5 默认填充模式

`default` 模式：

1. 按模型 ID exact slug 查找项目生成的 Codex bundled metadata；
2. 找不到时该模式不应出现在 Launcher 可选项中；
3. 读取完整 bundled row；
4. 应用项目目录不变量；
5. 执行最终完整校验。

该模式不读取当前上游 `models[]` 的 metadata 字段。

### 3.6 fallback 填充模式

generic fallback 必须保持保守。最小基线如下：

```json
{
  "slug": "<model-id>",
  "display_name": "<model-id>",
  "supported_reasoning_levels": [],
  "shell_type": "<full mode: unified_exec; otherwise: disabled>",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 99,
  "support_verbosity": false,
  "truncation_policy": {
    "mode": "bytes",
    "limit": 10000
  },
  "experimental_supported_tools": [],
  "model_messages": {
    "instructions_template": "<project generic Codex instructions>"
  }
}
```

generic fallback 的通用 instructions 必须由项目拥有，并与本项目代理安全边界一致。

未知时不要主动声明以下能力：

- `context_window` / `max_context_window`；
- reasoning 默认等级；
- 特定 tool mode；
- multi-agent 版本或推理强度；
- 搜索、图片细节、特殊工具能力；
- 任何仅从模型名称猜测出来的能力。

如果这些字段在目标 Codex 中有 serde default，则让 Codex 使用其真实 serde default。不要为了模拟 `model_info_from_slug()` 而无证据写入 `272000` 等应急值。

### 3.7 用户自定义模式

`custom` 的已确认数据模型是“持久化基础模式 + 用户字段 overrides”，不是一条完全脱离项目基线的原始 JSON 直通记录：

```ts
type MetadataBaseMode = "upstream" | "default" | "fallback";

type CustomMetadataConfig = {
  mode: "custom";
  baseMode: MetadataBaseMode;
  overrides: Record<string, unknown>;
};
```

`baseMode` 必须持久化。进入 custom 时，默认取用户当前正在查看的非 custom 模式；保存后不能在未来运行时改成“重新按自动默认推导 baseline”。

override 合同：

- 缺失字段表示继承本次解析后的 `baseMode` baseline；
- `null` 只有在固定目标 Codex schema 对该字段允许 null 时才有效；
- 数组和对象字段按该字段整体替换，不进行用户不可见的递归 deep merge；
- 第 4 节 schema 未识别的字段拒绝保存，不原样透传；
- 已识别但类型错误的字段拒绝保存；
- `slug`、`visibility`、`supported_in_api` 不允许用户 override；
- `base_instructions`、整个 `model_messages` 对象、`include_skills_usage_instructions`、
  `include_plugin_usage_instructions`、`include_apps_usage_instructions` 不允许用户 override；
- 其它目标 schema 已识别字段允许 override；
- 应用 overrides 后必须重新施加项目目录不变量与受保护 Agent-control metadata；
- 用户新建或修改该 custom 时，保存前必须按当前 schema 生成最终行并通过完整 validator；
- 自定义错误只阻止该次保存，不能破坏已保存的上一版配置。

UI 可以用结构化表单或 JSON 编辑器实现。具体控件形式属于实施自由，但必须展示最终生效预览或提供等价方式，让用户可以看见 baseline、overrides 和最终关键字段的关系。

`baseMode` 来源后来不可用时，不删除 custom，也不改写其 `baseMode`。已经持久化、但因为 Codex schema 升级而不再通过
当前语义校验的旧 custom 仍必须可以被结构化读取并原样保留；它不能因此使整个 v2 配置文件变成不可读取。运行时退化、
round-trip 和旧 custom 失效语义见第 5.2、7.4、10.3 节。

## 4. Codex bundled metadata 与 ModelInfo schema 同步

### 4.1 单一 Codex revision

项目必须有一个版本化的**唯一 Codex source lock**，固定一个精确、不可变的目标 Codex revision（例如 Git commit SHA）。
不能只记录“latest”、浮动分支、Codex CLI 的展示版本字符串或无法复现的本机 Codex 状态。

同一个 source lock/revision 同时拥有两类生成输入：

1. bundled metadata 数据源：该 revision 的 `codex-rs/models-manager/models.json`；
2. `ModelInfo` schema 来源：该 revision 中真实的 Rust `ModelInfo` 类型与 serde 定义。

`models.json` 只能作为 bundled **数据**来源，不能充当完整字段 schema。某个 optional 字段没有出现在当前 bundled 数据中，不代表目标 `ModelInfo` 不识别该字段。

### 4.2 生成产物

项目发布流程必须从同一目标 revision 生成或同步至少两类只读产物：

```text
bundled model metadata artifact
versioned ModelInfo field/type schema artifact
```

具体文件名属于实施自由，例如可以放在 `src/generated/`，但必须满足：

- 两个产物都记录同一个 source lock 中的精确 Codex revision；
- schema artifact 能确定项目当前识别的字段/路径、类型、nullability，以及 validator 所需的结构约束；
- final validator、upstream 字段级 parser 和 custom validator 都消费该 schema 或由它生成；
- bundled artifact 包含 exact slug 到完整 bundled `ModelInfo` 的映射；
- 运行时不依赖用户机器存在 Codex 源码；
- 运行时不联网获取 metadata 或 schema；
- 开发者不能通过手改单个模型行或手加 validator 分支代替 revision 同步流程。

生成工具如何从 Rust 类型定义得到项目使用的 schema 表示属于实施自由；结果必须版本化、可重复生成并可审阅。
source lock 是唯一版本身份入口，不能让 bundled generator、schema generator 和 parser smoke 各自接受互不校验的“某个 Codex 路径/版本”。

### 4.3 版本一致性与 release gate

CI 或 release verify 至少检查：

1. source lock 中的目标 Codex revision 是精确且可复现的；
2. bundled artifact 与 schema artifact 记录的 revision 完全一致；
3. bundled exact slug 唯一，所有 bundled 行通过当前生成 validator；
4. schema 同步后，合法字段集合和字段类型变化可以形成可审阅 diff；
5. 生成脚本重复运行不会产生无意义 diff；
6. 目标 Codex revision 更新后，未同步任一生成产物都会使验证失败；
7. 最终代表性 catalog 必须通过该目标 Codex revision 的真实 parser smoke；
8. smoke 使用的 parser 必须能证明来自同一个 source lock：优先由该 revision 的源码构建；也可以使用与该 revision
   建立了可验证映射且内容摘要固定的发布二进制。仅传入任意本机 `codex` 路径、仅比较 `codex --version`
   字符串，或仅因为 `debug models --bundled` 能运行，都不足以证明 parser identity；
9. parser identity 校验必须发生在 smoke 之前；identity 不匹配时 release verify 直接失败，不能把“在另一个 Codex
   版本上 parser smoke 通过”当成目标 revision 的兼容证据。

真实 parser smoke 是发布门禁，而不是替代本地 schema。两者必须同时存在：schema 负责可重复的字段级输入/输出验证，
目标 Codex parser 负责验证项目生成结果和真实消费者兼容。现有 `scripts/smoke-codex-catalog.ts` 可以继续作为 smoke
行为基础，但 release gate 必须补上上述 source-lock/parser-identity 约束；它当前默认读取本机 ChatGPT.app 内 Codex
的行为本身不能满足该身份合同。

## 5. 持久化配置

### 5.1 新配置结构

新的上游模型配置固定升级为 `version: 2`。v2 从“筛选器”改为“显式模型选择”：

```ts
type MetadataMode = "upstream" | "default" | "fallback";

type ModelMetadataConfig =
  | { mode: MetadataMode }
  | {
      mode: "custom";
      baseMode: MetadataMode;
      overrides: Record<string, unknown>;
    };

type UpstreamModelConfig = {
  id: string;
  // absent means use the automatic matrix; it is not a fifth visible UI mode.
  metadata?: ModelMetadataConfig;
};

type UpstreamProviderConfigV2 = {
  version: 2;
  baseUrl: string;
  apiKeySha256: string;
  proxy: UpstreamProxyConfig;
  models: UpstreamModelConfig[];
  supportsOpenAiServerCompaction: boolean;
};
```

v2 不包含：

```text
modelFilter.mode = all
modelFilter.mode = regex
modelFilter.mode = selected
modelFilter.pattern
```

`models[]` 本身就是唯一的上游路由 allowlist 和每模型 metadata 配置表。新 UI、新 IPC 保存合同和运行时 v2 provider parser 都必须使用该结构，不得继续把 v1 作为新配置的兼容输出格式。

### 5.2 规范化

保存时必须区分**配置结构校验**和**当前 metadata 语义校验**。

所有保存都必须：

- 校验模型 ID；
- 去重；
- 拒绝 `chatgpt-web/*`；
- 校验显式 metadata mode；
- 使用稳定的序列化顺序计算 revision；
- revision 必须覆盖模型集合、每个模型的 metadata 模式和 custom overrides。

对 custom：

- v2 reader 必须能结构化读取已保存的 `mode: "custom"`、`baseMode` 和 JSON `overrides`，即使 overrides 因目标
  Codex schema 升级而不再是当前合法字段；这种状态记为 persisted-invalid/degraded custom，而不是把整个 provider 配置判坏；
- 用户本次**新建或修改**某个 custom 时，必须按当前 schema 校验 baseMode 和 overrides，并生成最终 `ModelInfo`
  执行完整 validator；
- 用户只修改 Base URL、proxy、compaction、其它模型或其它无关设置时，当前 revision 中**未触碰**的
  persisted-invalid/degraded custom 必须可以原样 round-trip，不能因为它当前语义失效而阻止保存；
- “未触碰”必须相对 optimistic-concurrency 检查所绑定的 authoritative saved revision 判断。实现不能信任 Renderer
  把任意新 payload 声称为“旧值”；可以由 main process 对比原值，或采用只提交字段 patch 的等价协议；
- 一旦用户修改该 custom 的 `baseMode` 或 `overrides`，它就是新版本，必须通过当前 schema/final validator 才能保存；
- round-trip 不表示旧 custom 重新变得有效；运行时仍按第 10.3 节安全退化，并在 Launcher 中显示需要修复。

上游模型 ID 可以按规范化后的字典序持久化，以获得稳定 revision；Launcher 的发现展示顺序可以独立保留上游顺序。

## 6. 历史 v1 配置处理

### 6.1 已确认的破坏式升级策略

历史 `version: 1` 的 `selected / all / regex` 配置在新版本中**全部失效**。本任务不实现 v1 到 v2 的自动迁移，也不保留 v1 运行时兼容语义。

检测到持久化 v1 upstream provider 配置时，必须：

1. 不执行该 v1 配置，不运行其 `selected`、`all` 或 `regex` 授权语义；
2. legacy 检测必须发生在严格 v2 parser 之前：只对成功解析为 JSON object 且 `version === 1` 的文件执行本节
   destructive cleanup；JSON 损坏、未知 version 或其它无效配置只能 fail closed，不能按 v1 自动删除；
3. 由 provider-config 存储层执行一次 legacy cleanup：**先持久化 reset marker，再删除 v1 配置文件**。reset marker
   不得包含 Base URL、API Key digest、model IDs、regex 或其它用户数据，至少表达
   `reason = legacy-v1-removed`。不能先删文件再补 marker，因为进程在两步之间退出会失去清理 Launcher vault 的证据；
4. 删除后把 upstream provider 视为“未配置”；core/CLI/runtime 即使不能访问 Launcher secret vault，也必须立即
   fail closed，不能等待 Launcher 才停止执行 v1；
5. Launcher main process 读取到 reset marker 时，清除其 upstream API Key vault，并显示“旧 v1 配置已移除，
   需要重新配置”或等价状态；
6. reset marker 必须保留到 Launcher 已完成 vault 清理；vault 清理成功后 Launcher 可以删除 marker，并在当前 UI
   session 中保留 reset reason。Launcher 保存新 v2 前必须先完成该 marker/vault cleanup，避免随后把新 key 当旧 key 清掉；
7. 用户必须重新 Fetch Models、逐项选择并保存新的 v2；
8. 不把旧 v1 筛选结果、正则或 selected 列表自动带入新 v2。

legacy cleanup 只针对 v1 upstream provider 配置、与它配套的 Launcher upstream API Key vault，以及上述 reset marker。
不得删除无关 API access 配置、主 API key vault 或其它项目设置。

### 6.2 删除失败

如果存储层无法删除已识别的 v1 upstream provider 配置或无法可靠写入 cleanup/reset 状态：

- 仍然必须 fail closed：该 v1 provider 不得进入运行时；
- Launcher/diagnostics 必须报告可操作的配置清理错误；
- 不得为了维持可用性而回退执行旧 v1 过滤或授权语义；
- 后续成功保存合法 v2 配置后，以 v2 为唯一有效上游配置。

### 6.3 新代码禁止项

新代码不得：

- 创建新的 v1 配置；
- 暴露 `all` 或 `regex` 模式；
- 在后台把 v1 转成 v2；
- 读取 v1 `selected` 作为隐式 v2 allowlist；
- 为 v1 保留隐藏的长期兼容路由；
- 在 v1 reset marker 尚未驱动 Launcher 清除旧 upstream vault 时，把该 vault 中的旧 key 自动复用于新的 v2。

## 7. Launcher 行为

### 7.1 上游设置页面

删除以下 UI：

- “模型筛选”模式选择器；
- “全部模型”筛选模式；
- “正则筛选”模式；
- 正则输入框。

保留并提升“获取模型 + 搜索 + 多选”作为唯一模型选择方式。

建议页面顺序：

1. Base URL；
2. API Key；
3. 代理；
4. 获取模型；
5. 模型搜索；
6. 全部候选模型列表；
7. 每个已选模型的 metadata mode；
8. custom metadata 编辑入口；
9. server compaction 声明；
10. 保存。

### 7.2 候选模型状态

每个候选或已保存模型至少需要表达：

- 模型 ID；
- 是否已选择；
- 本次上游是否发现；
- 如果未发现，是“成功目录明确缺失”还是“目录请求失败/无当前发现结果”；
- 是否有匹配的上游 `models[]` 行；
- 是否有 bundled exact-slug metadata；
- 当前可选 metadata modes；
- configured metadata mode（自动时为空）；
- current effective mode/baseline；
- configured source 是否当前不可用；
- custom 是否存在未保存修改或运行时降级。

不要求把整份第三方原始 `/models` 响应持久化到 Renderer 状态或配置文件。

### 7.3 获取模型失败

获取失败时：

- 不清空已保存模型；
- 不清空当前页面已勾选模型；
- 不覆盖已保存 metadata 模式或 custom overrides；
- 显示获取失败；
- 用户仍可以取消已有选择，但新增模型需要新的成功发现证据。

### 7.4 元数据模式控件

模式下拉框的正常可选项严格使用第 1.3 节矩阵。

如果用户从自动默认切换到显式模式，保存显式 mode。

如果用户选择“恢复自动”，UI 可以提供“使用推荐值”或等价操作，内部删除该模型的 `metadata` override。该操作不是第五种 metadata mode。

当已持久化的显式 `upstream`、`default` 或 `custom.baseMode` 来源后来不可用时：

- configured value 继续显示，且明确标记“来源不可用”；
- UI 同时显示本次 effective fallback；
- 不把不可用 configured value 放回正常可选模式列表来伪装成可用；
- 用户可保存与 metadata 无关的其它设置，不强制改写该模型；persisted-invalid/degraded custom 按第 5.2 节原样 round-trip；
- 用户主动修改该模型 metadata 时，只能保存当前可用模式、合法 custom，或恢复自动。

进入 custom 时：

- 选择并持久化一个合法 `baseMode`；
- 显示 configured base、当前解析后的 effective baseline 和来源可用性；
- 编辑第 3.7 节允许 override 的字段；
- 保存前展示 schema、受保护路径和最终 validator 错误；
- 只有完整最终行通过 validator 才允许保存。

`custom.baseMode` 来源失效时的运行时行为由第 10.3 节统一定义，UI 必须显示该降级而不是静默修改配置。

## 8. 路由授权

### 8.1 唯一授权来源

对于非 `chatgpt-web/*` 模型，新的 v2 上游配置中：

```text
model id 是否存在于 config.models[]
```

是唯一的本地模型路由 allowlist 判断。

不再执行正则判断，也不存在“all 自动允许任意合法 ID”的新配置语义。

### 8.2 请求边界

对 `/v1/responses` 和 `/v1/responses/compact`：

- `chatgpt-web/*`：继续走本地 Web 路由；
- 非 Web 且在 `config.models[]`：允许转发给配置的上游；
- 非 Web 且不在 `config.models[]`：本地返回 `model_not_supported`，不得访问上游。

目录展示不能代替请求时授权。每一个带模型 ID 的请求都必须重新按当前已加载配置检查。

## 9. 最终模型目录

### 9.1 单一生成管线

必须建立一个项目内部统一的模型目录解析器。概念流程：

```text
本次可用的 upstream data[].id / partial models[]
    ↓
逐行解析、去重、保留合法发现 ID
    ↓
与 v2 selected models 计算 selected ∩ currently discovered
    ↓
每个可发布 selected id 计算 configured/effective metadata mode
    ↓
exact bundled baseline 或 generic baseline
    ↓
按模式吸收允许的 upstream metadata / custom overrides
    ↓
重新应用项目目录不变量与受保护 Agent-control metadata
    ↓
固定 revision 的最终 Codex ModelInfo 完整校验
    ↓
生成统一 data[] + models[]
```

服务器动态 `/v1/models`、Launcher metadata preview、API Key 静态导出都必须复用这个核心解析逻辑或消费它的最终结果。不能继续存在多个互相不同的 rich-row validator。

路由授权不使用上面的 `selected ∩ currently discovered` 交集；路由只按第 8 节 v2 allowlist 判断。catalog 发布和路由授权是两个独立结果。

### 9.2 `/v1/models`

API Key 模式的最终 `/v1/models`：

- 始终包含本地 `chatgpt-web/*` 模型；
- 上游目录本次成功时，只包含“已选择且本次发现”的上游模型；
- 每个被发布上游模型在 `data[]` 中有标准模型 ID 行；
- 每个被发布上游模型在 `models[]` 中有完整、已验证的 Codex `ModelInfo`；
- 未选择模型不发布；
- 已选择但本次成功目录明确缺失的模型不发布；
- 上游目录请求整体失败时，本次响应不发布任何上游模型，只返回本地 catalog。

一个上游 metadata 字段错误不能使其它合法发现模型或本地目录整体失败。只要某个已选模型本次 ID 被发现，就可以用 bundled 或 generic baseline 补全其 metadata；“补 metadata”不能用于伪造一个本次没有被发现的模型 ID。

### 9.3 `api-key-models.json`

`api-key-models.json` 必须直接写入导出流程**实际获取并验证的那次本地 `/v1/models` 响应**中的 normalized `models[]`，不能再把该结果当作未经处理的第三方目录进行第二套 merge。

如果导出流程继续通过 loopback 获取目录，它必须：

1. 验证 API access revision；
2. 验证 upstream provider config revision；
3. 获取已经完成归一化的本地 `/v1/models`；
4. 保存这一次响应的最终 `models[]`；
5. 不再次调用旧的 partial rich-row merge validator。

一致性合同是：

```text
export 实际消费的 GET /v1/models -> models[]
    ==
该次 export 写出的 api-key-models.json -> models[]
```

允许的差异只能是无语义的 JSON 格式化。

`upstreamProviderRevision()` 表示本地 provider 配置身份，不表示远端 `/models` 内容快照身份。本任务不引入 catalog generation/hash/snapshot identity。因此，上游可以在两个请求之间改变目录；后续另一次 `GET /v1/models` 即使 config revision 相同，也**不要求**与旧的 `api-key-models.json` 逐模型相等。

## 10. 失败与恢复语义

### 10.1 上游目录请求失败

上游目录请求超时、网络失败、非 2xx，或两个发现来源都不可用时：

- 本地 `chatgpt-web/*` 目录继续可用；
- 已选择上游模型不能因为一次失败从 v2 持久化配置消失；
- 本次 `/v1/models` 不发布任何上游模型，也不使用 bundled/generic metadata 伪造远端模型仍存在；
- 已选择上游模型仍保留路由 allowlist；实际模型请求仍可转发，由上游端点决定是否成功；
- Launcher 必须区分“目录请求失败”和“成功目录明确缺失某模型”；
- health/diagnostics 继续报告目录失败，但不能泄露 Base URL、API Key、代理凭据或完整第三方 metadata。

### 10.2 bundled metadata 缺失

自动模式或 configured `upstream` 模式遇到未命中 bundled 的模型时，使用 generic fallback 作为 metadata baseline，不报错。

用户显式选择 `default` 后，如果后续项目版本中的 bundled artifact 不再包含该 exact slug：

- configured mode 仍为 `default`；
- effective baseline 使用 generic fallback，使已发现模型仍能生成可解析 metadata；
- Launcher 标记 configured source 当前不可用并展示 effective fallback；
- 不静默把持久化选择改成 `fallback`；
- 用户主动修改该模型 metadata 时，必须改选当前可用模式或恢复自动。

### 10.3 custom base 来源失效或 custom 失效

正常保存路径不得产生当下无效 custom。

当 `custom.baseMode` 的来源后来不可用时：

1. 保留持久化的 `mode: "custom"`、`baseMode` 和 overrides；
2. 先按该 baseMode 的既定退化规则得到一个可用 effective baseline：
   - `upstream` 缺失 -> exact bundled，仍缺失 -> generic；
   - `default` 缺失 -> generic；
   - `fallback` -> generic；
3. 在该 effective baseline 上继续应用已保存 overrides；
4. 重新施加项目目录不变量和受保护 Agent-control metadata；
5. 执行当前固定 Codex revision 的最终 validator；
6. 如果结果合法，继续使用 custom effective result，同时在 Launcher 标记 base source 已降级；
7. 如果结果不合法，运行时使用未应用 custom overrides 的有效 baseline，并标记 custom 需要修复。

如果目标 Codex schema 升级使旧 custom override 不再合法，也执行第 7 条安全退化：

- 无效 custom 不得进入最终 `models[]`；
- 保留用户原始 custom 配置，不静默删除字段或重写意图；
- Launcher 和 diagnostics 标记需要修复；
- 用户修改其它无关设置时，该 custom 必须按第 5.2 节原样 round-trip；
- 用户重新编辑时必须按当前 schema 成功校验后才能保存新版本。

## 11. 安全与信任边界

上游 `/models` 是不可信输入。用户 custom 是显式本地配置，但也不能越过项目安全不变量。

必须满足：

- 第三方上游返回的 `base_instructions`、整个 `model_messages` 对象，以及
  `include_skills_usage_instructions` / `include_plugin_usage_instructions` / `include_apps_usage_instructions`
  不进入最终 effective metadata；这些字段会影响 Codex Agent 的指令、策略或项目指令装配；
- custom 也不能覆盖上述受保护 Agent-control metadata；
- 受保护 Agent-control metadata 只来自项目打包的 fixed-revision bundled baseline 或项目 generic baseline；
- 不接受上游 metadata 改写本地文件路径、网络地址、认证或路由所有权；
- 不允许上游 `slug` 进入 `chatgpt-web/*`；
- 不把固定 Codex schema 未识别的字段原样透传给最终 catalog；
- 不把非法字段因为“存在”就视为能力证据；
- 不在普通日志中记录完整上游原始响应；
- `slug`、`visibility`、`supported_in_api` 始终由项目目录不变量重写；
- custom metadata 仍经过同一 schema、受保护路径检查和最终 validator。

固定 Codex revision 的 bundled metadata/schema 属于项目构建时信任输入；第三方 provider 的运行时 `/models` 响应不属于该信任域。实现和文档必须保持这两个来源的边界可见。

## 12. 模块责任建议

具体文件拆分可以调整，但职责必须保持单一。

建议：

| 责任 | 目标 |
| --- | --- |
| upstream discovery parser | 从 `data[]` / `models[]` 提取 ID 与字段级合法 metadata |
| bundled metadata registry | exact slug 查询生成的 Codex bundled artifact |
| generic model baseline | 生成保守 fallback |
| metadata resolver | 实现 auto / upstream / default / fallback / custom 语义 |
| final ModelInfo validator | 校验最终可交给 Codex 的完整行 |
| catalog builder | 组合本地 Web 与已选上游 `data[]` / `models[]` |
| provider config/storage | 保存 v2 selected models 和 metadata 配置；识别并清理 v1，维护非敏感 reset marker |
| Launcher main process | 网络发现、配置校验、metadata preview，不让 Renderer直接信任原始上游响应 |
| Launcher Renderer | 全量候选展示、搜索、勾选、模式选择和 custom 编辑 |
| export | 消费最终 normalized catalog，不重新实现 metadata 合并 |

`src/upstream-model-catalog.ts` 当前的 `compatibleCodexRichModel()` 不能继续作为最终设计，因为它把部分 metadata 当完整 row，又没有覆盖 Codex 真正的完整必需字段。可以重写该模块或拆分职责，但不能保留同一错误语义。

## 13. 验收

### 13.1 发现、选择与 stale 状态

1. 上游只返回标准 `data[].id` 时，所有合法 ID 都出现在 Launcher 候选列表。
2. 上游同时返回 `data[]` 和 `models[]` 时，ID 去重且 metadata 与 matching slug 关联。
3. `data[]` 结构错误但 `models[]` 可读时继续使用 `models[]`；反向同理；两边都不可用才报告 schema 失败。
4. 上游包含 `chatgpt-web/*` 时，该 ID 不作为上游候选。
5. 不存在正则筛选 UI，新保存配置也不包含 regex。
6. 未勾选模型不能路由，即使它出现在上游 `/models`。
7. 已勾选模型允许路由。
8. 搜索只改变可见候选，不改变已勾选集合。
9. 成功目录明确缺失的已选模型仍显示为 stale selection，可路由，但不出现在该次 `/v1/models.data[]` 或 `models[]`。
10. 整个上游目录请求失败时，已选模型仍保留路由授权和配置，但该次 `/v1/models` 只发布本地 catalog。
11. 重复 ID 只产生一个候选；测试不得把“第一条 duplicate row wins”当成产品合同。

### 13.2 元数据模式矩阵

为以下四种组合分别测试可选模式与自动默认：

1. upstream metadata = yes，bundled = yes；
2. upstream metadata = yes，bundled = no；
3. upstream metadata = no，bundled = yes；
4. upstream metadata = no，bundled = no。

结果必须和第 1.3 节矩阵完全一致。

### 13.3 部分上游 metadata 与 instructions 边界

至少覆盖：

1. `{ "slug": "gpt-x" }` 仍能被发现；
2. 只有 `display_name` 合法，其它字段缺失时，最终行由 baseline 补齐；
3. 某一个字段类型错误时，只忽略该字段；
4. 一个坏模型行不影响其它好模型行；
5. 完整合法上游 `ModelInfo` 可以通过同一 normalize 路径得到等价的**允许覆盖字段**结果；
6. 上游提供合法 `base_instructions`、任意 `model_messages` 内容（包括 `persistent_instructions`、approval/collaboration/policy
   字段）或三个 `include_*_usage_instructions` 开关时，这些值不会覆盖最终行中的项目受保护 Agent-control metadata；
7. 最终结果可被固定目标 Codex 的真实 parser 接受。

### 13.4 baseline 与 schema 同步

1. exact bundled slug 使用同一固定 Codex revision 生成产物中的完整 metadata；
2. bundled metadata artifact 与 ModelInfo schema artifact 记录完全相同的精确 Codex revision；
3. validator、upstream 字段识别和 custom 字段识别使用该版本化 schema；
4. 未知 slug 的 generic fallback 不写入未经证实的 context window；
5. generic fallback 具备全部当前必填字段；
6. `shell_type` 按项目运行模式生成；
7. 所有最终已发布模型强制 `slug=id`、`visibility=list`、`supported_in_api=true`；
8. 修改目标 Codex revision 但不重新生成任一产物时，CI/release verify 失败；
9. 代表性最终 catalog 通过目标 Codex 真实 parser smoke；
10. release smoke 的 parser identity 与 source lock 的不可变 revision 匹配；任意本机 Codex 或只匹配展示版本字符串不能满足此项；
11. bundled/schema artifact、generator 输入和 parser smoke 都能追溯到同一个 source lock。

### 13.5 custom

1. custom 持久化 `baseMode + overrides`；
2. 未设置字段继承解析后的 baseMode；
3. `null` 只在 schema 允许时有效；
4. 数组和对象按字段整体替换，不做用户不可见 deep merge；
5. 非法字段类型不能保存；
6. schema 未识别字段不能保存；
7. 不允许 custom 改写 `slug`、`visibility`、`supported_in_api`；
8. 不允许 custom 改写 `base_instructions`、整个 `model_messages` 对象或三个 `include_*_usage_instructions` 开关；
9. 其它 schema 已识别字段允许 override；
10. 新建或修改 custom 时最终行必须通过完整 validator；
11. 已保存 custom 因 schema 升级而失效时仍能被结构化读取；用户只改无关设置可原样 round-trip；
12. 修改已失效 custom 本身时必须按当前 schema 重新校验，不能利用 round-trip 规则注入新的未知/非法字段；
13. `custom.baseMode` 来源消失时，先对 baseMode 安全降级，再继续应用 overrides；合法则使用并标记 degraded；
14. schema 升级或 degraded baseline 导致 custom 最终无效时，运行时退回有效 baseline，用户 custom 配置不被静默删除。

### 13.6 动态与静态目录一致性

1. 导出流程写出的 `api-key-models.json.models[]` 与**它实际消费的那次** `/v1/models.models[]` 等价；
2. 导出不再对该动态结果执行第二套 partial rich-row merge；
3. 标准 `data[].id` 发现且已选中的模型，在该次动态 catalog 中生成完整 `ModelInfo`，静态导出原样继承；
4. 不再发生“同一个动态结果里知道模型 ID，但导出分支丢失 metadata 行”的代码路径分叉；
5. 不再发生“项目 validator 通过，但目标 Codex 因必需字段/类型不兼容而整份 catalog 解析失败”的情况；
6. 测试不得要求后续另一次 GET 在 config revision 相同的情况下与历史导出相等；该能力需要另行引入 catalog snapshot identity，本任务明确不做。

### 13.7 v1 破坏式升级

分别准备 v1 `selected`、`all`、`regex` 配置并验证：

1. 新运行时不执行任何 v1 路由授权或筛选语义；
2. 检测后自动删除该 v1 upstream provider 配置并建立非敏感 reset marker；
3. core/CLI/runtime 在 Launcher 未启动时也立即 fail closed；
4. Launcher 读取 reset marker 后清除旧 upstream API Key vault，并显示需要重新配置；
5. 删除后 upstream 视为未配置，Launcher 要求重新 Fetch/选择；
6. 旧 selected 列表、all 结果、regex pattern 和旧 vault key 都不自动迁入/复用于 v2；
7. cleanup 不删除无关 API access、主 API key vault 或其它项目配置；
8. config 删除或 reset 状态写入失败时 provider 仍 fail closed，并出现可操作错误；
9. 新 UI 和 IPC 只能创建 `version: 2` 配置。

### 13.8 configured/effective UI 状态

至少覆盖：

1. configured `upstream` 后来没有匹配 `models[]` 行；
2. configured `default` 后来没有 exact bundled slug；
3. `custom.baseMode=upstream` 来源消失；
4. `custom.baseMode=default` 来源消失。

每种情况下，Launcher 都能同时表示 configured value、source unavailable/degraded 状态和 effective fallback；无关设置仍可保存且
不静默改写 configured metadata。若 custom 已因 schema 升级变成 persisted-invalid/degraded，保存无关设置时原 custom 必须
round-trip 不变；用户主动修改该 metadata 后，只能保存当前合法选择或恢复自动。

## 14. 实施自由与禁止项

以下可以由实现者决定：

- 内部模块和函数名称；
- generated bundled artifact 与 generated schema artifact 的具体文件名；
- 从固定 Codex revision 的 Rust `ModelInfo` 定义生成项目 schema 表示的具体工具实现；
- source lock 与已校验 parser artifact 的具体文件名和生成工具，只要版本身份不可变且 release gate 可验证；
- v1 reset marker 的具体文件名和删除时机，只要满足第 6 节的 fail-closed、vault 清理和不复用旧 key 合同；
- 重复 `models[]` 行的确定性消解策略，只要满足第 2.3 节边界；
- custom 编辑器使用结构化表单还是 JSON；
- metadata preview 的 IPC 是否单独拆接口；
- 发现列表的视觉布局、排序控件和搜索样式。

以下不是实施自由：

- 不能修改历史 `docs/dev/api-key-upstream-provider/spec.md` 来代替本规格；
- 不能保留新的 regex 筛选入口；
- 不能创建、迁移或运行兼容 v1 upstream provider 配置；
- 检测到 v1 后不能保留其 provider 配置；必须按第 6 节自动删除、记录 reset 状态并 fail closed；
- 不能把未选择模型路由到上游；
- 不能把 stale selection 或失败目录请求中的已选 ID 伪造成当前 catalog 行；
- 不能要求标准 OpenAI-compatible 上游自己提供完整 Codex `ModelInfo`；
- 不能把部分 `models[]` 行不经补全直接交给 Codex；
- 不能用一个坏 metadata 字段让另一独立发现来源或其它好模型失败；
- 不能允许上游或 custom 覆盖第 3.3 节受保护 Agent-control metadata，包括整个 `model_messages` 对象；
- 不能从 `models.json` 的当前键集合反推完整 `ModelInfo` schema；
- 不能手工维护每个 Codex bundled 模型 metadata 或另写一套脱离固定 revision schema 的 validator；
- 不能用未证明来自 source lock revision 的任意本机 Codex binary 作为 release parser smoke 证据；
- 不能因为 persisted custom 在新 schema 下语义失效，就让整个 v2 配置不可读取，或阻止用户保存与该 custom 无关的设置；
- 不能为未知模型猜测 context window、reasoning、tool 或 multi-agent 能力；
- 不能让动态 `/v1/models`、preview 和 `api-key-models.json` 使用不同的 metadata 生成规则；
- 不能把“相同 provider config revision”误当成“相同远端 catalog snapshot”。

本任务不要求实现 catalog snapshot generation/hash。如果未来需要跨时间强一致，必须另行设计其 identity、缓存生命周期和 revision 合同。

## 15. 当前规范资料与来源

### 15.1 用户确认与本次 review

本规格保留此前已确认的第 1.3 节四种 metadata 模式矩阵。本轮 2026-09-20 决策访谈进一步确认了“本次交付与审阅导航”中列出的 trust、custom、v2/v1、目录一致性、schema、stale selection、来源失效和发现容错决定。

第一轮修订直接针对 SHA-256 `3349a79c92e0fd55b888604adc26b0d6798a8a2f52fd542a294187d2ba91c6ed` 版本的 Spec Review；
该 review 中指出的 7 个实质问题均已转换为已确认合同或明确实施自由。

后续对 SHA-256 `0d0def12efe0ebc6ffd0ee973531137cf742396c9014c28cec4ad6d34c7b8993` 版本的复核又发现 4 个闭合缺口：
Agent-control metadata 范围、旧 custom round-trip、source-lock/parser identity，以及 v1 cleanup/vault 生命周期。本版本已在
§3.3/3.7、§4、§5.2、§6、§7.4、§10.3、§11 和 §13/14 中统一关闭这些问题。

### 15.2 项目事实核对范围

本规格的项目事实核对范围包括：

- `src/upstream-model-catalog.ts`：当前上游目录使用整行 rich metadata validator；
- `src/upstream-provider.ts`：当前实现仍是 v1 `all / regex / selected`，provider revision 只覆盖本地配置；
- `src/server.ts`：API Key `/v1/models` 当前每次请求都会重新请求上游目录，因此相同本地 revision 不代表相同远端 catalog；
- `src/api-key-cli.ts`：当前静态导出通过 loopback `/v1/models` 获取目录后仍执行独立 merge；
- `src/standalone-model-catalog.ts`：当前本地 baseline 使用项目拥有的 Codex agent instructions；
- `tests/api-key-server.test.ts`：当前已有“selected 模型本次目录缺失时不伪造 catalog 行，但仍可路由”的行为证据；
- `launcher/src/ApiAccessSettings.tsx`、`launcher/src/api-access-types.ts`：当前上游筛选和手动模型选择 UI/API；
- `launcher/electron/upstream-provider-config.cjs`、`launcher/electron/upstream-provider-network.cjs`：当前 Launcher 配置校验和上游模型发现；
- `launcher/electron/api-access-settings.cjs`、`launcher/electron/upstream-api-key-vault.cjs`：当前显式删除 upstream provider 时，
  Launcher 会同时清除独立的加密 upstream API Key vault；
- `scripts/smoke-codex-catalog.ts`：项目已有通过真实 Codex catalog 行为做 smoke 验证的能力，但当前默认可直接使用本机
  ChatGPT.app 内的 Codex，因此 release gate 仍需要本规格要求的 source-lock/parser-identity 绑定；
- 本轮只读核对的本机 `codex-cli 0.154.0-alpha.6.2` bundled catalog：`model_messages` 除
  `instructions_template` 外还包含 `persistent_instructions`、approval/collaboration/policy/multi-agent 等字段，
  证明不能只保护单个 instructions leaf。该观察用于确认信任边界风险；正式生成与发布仍只认第 4 节的 source lock。

历史文档 `docs/dev/api-key-upstream-provider/spec.md` 本轮仍不修改。后续实施、任务拆分和代码审查应直接以本文件作为本次模型发现与 metadata 改造的规范入口。
