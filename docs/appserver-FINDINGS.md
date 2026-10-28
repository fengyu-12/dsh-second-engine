# Codex app-server 协议探测事实

本文是协议事实的泛化记录，来源是一次真实运行的事件流探测。协议目标为 `codex app-server`（stdio JSON-RPC）。成功样本共收到 **46 条服务器事件**；另有一个 interrupt 专用样本验证取消路径。

## 1. 握手

客户端通过换行分隔的 JSON-RPC 请求建立会话：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"<客户端名>","title":"<客户端标题>","version":"<客户端版本>"},"capabilities":{"experimentalApi":true}}}
```

事实：

- `clientInfo.name` 和 `clientInfo.version` 必填；`title` 可选。
- `capabilities.experimentalApi: true` 开启实验方法与字段。
- 生成 schema 中还存在 `capabilities.extensions`、`mcpServerOpenaiFormElicitation`、`optOutNotificationMethods`、`requestAttestation`。
- 初始化响应后发送 `{"jsonrpc":"2.0","method":"initialized"}`。
- 初始化响应可包含 `userAgent`、`codexHome`、`platformFamily`、`platformOs`。其中 `codexHome` 是服务器侧绝对路径，泛化写作 `<工作目录>`。

## 2. 方法

真实运行中验证过：

| 方法 | 语义 |
|---|---|
| `initialize` | 协商协议能力。 |
| `initialized` | 初始化完成后的单向通知。 |
| `thread/start` | 创建 thread；空对象参数有效。 |
| `turn/start` | 以 `threadId` 与 `input` 启动 turn。 |
| `turn/interrupt` | 以 `threadId` 与 `turnId` 打断活动 turn。 |

生成 schema 中还有相关方法：`thread/resume`、`turn/steer`、`thread/archive`、`thread/delete`、`thread/read`、`thread/items/list`；其中 `turn/steer` 需要 `expectedTurnId`。schema 还声明了环境、文件系统、进程、命令执行、审批、账号、配置、模型、MCP、插件、技能、项目、realtime 等方法。schema 生成命令为 `codex app-server generate-json-schema --experimental --out schema`。

## 3. Turn 基本形态

文本输入最小形态：

```json
{"threadId":"<thread-id>","input":[{"type":"text","text":"<用户输入>"}]}
```

响应事实：

- `thread/start` 返回 `threadId`。
- `turn/start` 返回 `turnId` 和初始 `status`；泛化示例为 `{"turnId":"<turn-id>","status":"inProgress"}`。
- `turn/start` 可覆盖 `approvalPolicy`、`cwd`、`model`、`sandboxPolicy` 等参数；未覆盖时继承上层配置。

## 4. 已观察到的事件语义

| 事件 | 语义 |
|---|---|
| `remoteControl/status/changed` | 远程控制状态变化。 |
| `thread/started` | 新 thread 已发布/可用。 |
| `thread/status/changed` | thread 在 `active`、`idle` 等状态间变化。 |
| `mcpServer/startupStatus/updated` | MCP 服务器从 `starting` 到 `ready`；payload 含 `error`。 |
| `warning` | 服务器警告通知。 |
| `turn/started` | turn 激活，含 `threadId`、`turnId`、状态。 |
| `item/started` / `item/completed` | thread item 生命周期，如 `userMessage`、`reasoning`、`commandExecution`、`agentMessage`。 |
| `item/reasoning/textDelta` | 原始推理文本增量。 |
| `item/reasoning/summaryTextDelta` | 推理摘要文本增量，schema 中存在。 |
| `item/reasoning/summaryPartAdded` | 推理摘要分段开始，schema 中存在。 |
| `item/agentMessage/delta` | 最终 assistant 文本增量。 |
| `item/commandExecution/outputDelta` | 命令输出增量；schema 中存在，短命令样本未产生。 |
| `thread/tokenUsage/updated` | token 统计，含 `last`、`total`、`modelContextWindow`。 |
| `account/rateLimits/updated` | 账号/限流元数据。 |
| `turn/completed` | 终态事件；观察到的状态是 `completed` 或 `interrupted`。 |
| `turn/failed` / `error` | schema/探测分支中声明的失败路径；成功样本未触发。 |

审批请求和服务器发起请求未被测试。探测实现遇到此类请求返回 JSON-RPC `-32601`，避免无人值守场景静默审批。

## 5. Turn 生命周期

1. 以 stdio 子进程启动 `codex app-server`。
2. 发送 `initialize` 并等待响应。
3. 发送 `initialized` 通知。
4. 调用 `thread/start`，保留 `threadId`。
5. 调用 `turn/start`，保留 `turnId`。
6. 按到达顺序消费 thread 状态、turn 开始、item 生命周期、推理/回答/命令增量、usage 和 rate-limit 事件。
7. 等待终态 `turn/completed`；如收到旧运行时的 `turn/failed`，也应按终态分支处理。
8. 取消时调用 `turn/interrupt`，继续等待 `turn/completed` 且状态为 `interrupted`。
9. turn 结束后停止子进程。

## 6. 46 事件样本

一次成功 turn 的外部事件流包含 **46 条服务器事件**，类型计数如下：

| 事件 | 条数 |
|---|---:|
| `remoteControl/status/changed` | 1 |
| `thread/started` | 1 |
| `mcpServer/startupStatus/updated` | 2 |
| `warning` | 1 |
| `thread/status/changed` | 2 |
| `turn/started` | 1 |
| `item/started` | 3 |
| `item/completed` | 3 |
| `item/reasoning/textDelta` | 27 |
| `item/agentMessage/delta` | 2 |
| `thread/tokenUsage/updated` | 1 |
| `account/rateLimits/updated` | 1 |
| `turn/completed` | 1 |

该顺序说明：基础设施状态事件可能先于 turn 事件；`userMessage` 可能在模型/工具 item 前完成；原始推理增量可连续多次到达；usage 与限流事件可在回答 item 之后、thread idle 和 turn 终态前出现。事件顺序依赖模型与运行时，集成层不得假设同一 prompt 的子事件集合固定。

## 7. Interrupt 结论

取消请求形态：

```json
{"jsonrpc":"2.0","id":"<request-id>","method":"turn/interrupt","params":{"threadId":"<thread-id>","turnId":"<turn-id>"}}
```

interrupt 样本观察到的事件顺序：

1. `thread/status/changed` 到 `active`。
2. `turn/started`。
3. 发送 `turn/interrupt` 并收到空结果响应。
4. `thread/status/changed` 到 `idle`。
5. `turn/completed`，状态为 `interrupted`。

关键结论：

- `turn/interrupt` 响应不是 turn 终态，归一化时必须保持 `done:false`。
- thread 进入 `idle` 也不是 turn 终态，不能因此设置 `done:true`。
- 只有 `turn/completed.status:"interrupted"` 才能映射为取消完成。
- 不需要等待 user message item 完成，也不需要任何 agent/tool 事件先到达。
- schema 原始终态字段是 `threadId` 和嵌套 `turn.id`、`turn.status`；日志中的扁平 `turnId`、`status` 是探测器摘要结果。
- 本次验证的是非工具 turn 的打断路径；活动工具打断未验证。

## 8. 风险与待验证

- `turn/start` 原始 payload 在部分日志中被摘要，集成前需按生成 schema 验证原始帧。
- 审批、服务器请求、steering 未测试；不得按已验证行为实现。
- 事件顺序和事件子集依赖模型/运行时；必须按 `itemType` 归一化，并把流式增量视为可缺省预览。
- `turn/completed.status:"interrupted"` 已验证，但活动工具调用后的打断路径未验证。
- 生成 schema 显示响应包含更丰富的 `thread`、`turn` 对象；实现前必须验证原始帧，不能依赖摘要日志推断嵌套字段。
- app-server 被标记为实验特性，方法与字段可能随 CLI 版本变化。
- 原始推理流默认可见；需要明确用户可见流与审计流。
- token usage 增量到达；累计值必须取 `tokenUsage.total`，不能从 `last` 推导。
