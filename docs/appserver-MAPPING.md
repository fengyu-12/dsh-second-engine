# app-server 事件 → 归一化字段映射

协议目标是 `codex app-server` v2 生成 schema。本文按 schema 原始 payload 设计；真实运行日志若显示更少字段，可能是探测器摘要，不代表 wire shape。成功事件样本共 **46 条**。

## 1. 归一化信封

每个事件生成一条 `Normalized`。核心字段保留 `{kind,text,tool,usage,done}`，另增 `meta` 用于状态组装与幂等合并。

```ts
type Normalized = {
  kind: "text" | "reasoning" | "tool" | "usage" | "done" | "status";
  text?: string;
  tool?: null | {
    type: "commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | string;
    name?: string;
    itemId: string;
    status?: string;
    command?: string;
    exitCode?: number | null;
    aggregatedOutput?: string | null;
    changes?: unknown[];
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
    progress?: string | null;
    diff?: string | null;
  };
  usage?: null | {
    tokens?: {
      total?: TokenUsageBreakdown;
      last?: TokenUsageBreakdown;
      modelContextWindow?: number | null;
    };
    rateLimits?: unknown;
  };
  done: boolean;
  meta: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    eventType: string;
    status?: string;
    contentIndex?: number;
    summaryIndex?: number;
    willRetry?: boolean;
    raw: unknown;
  };
};
```

规则：

- `kind:"status"` 用于生命周期/基础设施，`kind:"reasoning"` 与最终文本分离。
- `done:true` 只表示 turn 终态，不表示 item 终态；终态来源是 `turn/completed`，旧运行时若真的发出 `turn/failed` 也可作为兼容分支。
- 以 `meta.threadId`、`meta.turnId`、`meta.itemId` 关联状态；不要依赖事件顺序组装状态。
- 流式增量是 append-only 预览；匹配的 `item/completed` 用最终 item 整体替换预览。
- `tokenUsage.total` 是累计值，`tokenUsage.last` 是最近增量；二者不得相加。

## 2. 事件映射

“可缺省”指实现必须容忍该事件缺失；若 schema 必填字段在日志中缺失，应先怀疑探测器摘要。

| 事件 | 原始 schema 形态 | 探测摘要说明 | 归一化字段 | 可缺省? | 建议动作 |
|---|---|---|---|---|---|
| `thread/start` 响应 | `ThreadStartResponse` 需要 `thread` 及 policy/config 字段。 | 摘要为 `threadId`。 | `kind:"status"`, `meta.threadId`, `done:false`; raw 响应入 `meta.raw`。 | 必须有；这是新建 thread 身份的权威来源。 | 保存 thread 身份/配置；不产生 UI 文本。 |
| `thread/started` | 需要 `thread`。 | 摘要为 `threadId`。 | `kind:"status"`, `meta.threadId`, `done:false`。 | 可缺省或晚到。 | 初始化/调和 thread 状态；已初始化则忽略。 |
| `thread/status/changed` | 需要 `threadId`、`status`（`active`、`idle`、`notLoaded`、`systemError`）。 | 观察到 `active`、`idle`。 | `kind:"status"`, `text=status.type`, `done:false`, `meta.status=status.type`。 | 可缺省。 | 更新 spinner/只读状态；不能据此结束 turn。 |
| `turn/start` 响应 | 需要 `turn`；`turn.id`、`turn.status` 必填。 | 摘要为 `turnId/status`。 | `kind:"status"`, `done:false`, `meta.turnId`, `meta.status=turn.status`。 | 必须有；这是 turn 身份的权威来源。 | 登记活动 turn；不视为终态。 |
| `turn/started` | 需要 `threadId`、`turn`。 | 摘要为 `turnId/status`。 | `kind:"status"`, `done:false`, `meta.turnId`, `meta.status`。 | 可缺省；响应已足够。 | 启动/刷新 turn UI，并与响应调和。 |
| `item/started` | 需要 `threadId`、`turnId`、`item`、`startedAtMs`；类型在 `item.type`。 | 摘要为 `itemId/itemType` 及选定字段。 | 工具类型映射 `kind:"tool"`；reasoning 映射 `kind:"reasoning"`；其他按内容映射 `kind:"status"` 或 `kind:"text"`。字段可为空。 | item 可缺省；类型和字段数据相关。 | 按 `itemId` 建 placeholder；工具 item 更新工具卡。 |
| `item/completed` | 需要 `threadId`、`turnId`、`item`、`completedAtMs`；最终 item 权威。 | 嵌套 item 字段被摘要。 | `agentMessage` 映射 `kind:"text"`；`reasoning` 映射 `kind:"reasoning"`；工具类型映射 `kind:"tool"`；`done:false`。 | item 可缺省；部分类型文本可为空。 | 按 `itemId` 整体替换状态；有 `item.status`/exit/result 时完成工具卡。 |
| `item/agentMessage/delta` | 需要 `threadId`、`turnId`、`itemId`、`delta`。 | 已观察。 | `kind:"text"`, `text=delta`, `done:false`, `meta.itemId`。 | 可缺省。 | 向该 assistant message 追加预览文本。 |
| `item/reasoning/textDelta` | 需要 `threadId`、`turnId`、`itemId`、`delta`、`contentIndex`。 | 摘要可能省略 `contentIndex`。 | `kind:"reasoning"`, `text=delta`, `done:false`, `meta.itemId`, `meta.contentIndex`。 | 可缺省。 | 按 `(itemId,contentIndex)` 追加审计/调试流；与最终答案隔离。 |
| `item/reasoning/summaryTextDelta` | 需要 `threadId`、`turnId`、`itemId`、`delta`、`summaryIndex`。 | 未观察。 | `kind:"reasoning"`, `text=delta`, `done:false`, `meta.summaryIndex`。 | 可缺省。 | 若启用摘要，按 `(itemId,summaryIndex)` 追加。 |
| `item/reasoning/summaryPartAdded` | 需要 `threadId`、`turnId`、`itemId`、`summaryIndex`。 | 未观察。 | `kind:"reasoning"`, `done:false`, `meta.summaryIndex`。 | 可缺省。 | 打开新的摘要分段，等待后续 delta。 |
| `item/commandExecution/outputDelta` | 需要 `threadId`、`turnId`、`itemId`、`delta`。 | 短命令样本未产生。 | `kind:"tool"`, `tool={type:"commandExecution",itemId,aggregatedOutput:delta}`, `done:false`。 | 命令存在时仍可缺省。 | 向该命令卡追加预览输出。 |
| `item/commandExecution/terminalInteraction` | 需要 `threadId`、`turnId`、`itemId`、`processId`、`stdin`。 | 未观察。 | `kind:"tool"`, `tool={type:"commandExecution",itemId,progress:stdin}`, `done:false`。 | 可缺省。 | 显示终端交互输入；不当作命令输出。 |
| `item/fileChange/outputDelta` | 已废弃的旧通知，需要 `delta`；新服务器不再发出。 | 未观察。 | `kind:"tool"`, `tool={type:"fileChange",itemId,diff:delta}`, `done:false`。 | 可缺省；支持 `patchUpdated` 后可忽略。 | 优先 `item/fileChange/patchUpdated`；旧运行时保留兼容 append。 |
| `item/fileChange/patchUpdated` | 需要 `threadId`、`turnId`、`itemId`、`changes`。 | 未观察。 | `kind:"tool"`, `tool={type:"fileChange",itemId,changes}`, `done:false`。 | 可缺省。 | 按 `itemId` 整体替换 patch 预览。 |
| `item/mcpToolCall/progress` | 需要 `threadId`、`turnId`、`itemId`、`message`。 | 未观察。 | `kind:"tool"`, `tool={type:"mcpToolCall",itemId,progress:message}`, `done:false`。 | 可缺省。 | 向 MCP 工具卡追加进度行。 |
| `item/plan/delta` | 需要 `threadId`、`turnId`、`itemId`、`delta`；最终 plan item 可能不等于 delta 拼接。 | 未观察。 | `kind:"text"`, `text=delta`, `done:false`, `meta.itemId`; `meta.raw` 标记为 plan。 | 可缺省。 | 追加 plan 预览；完成时用权威 plan item 替换。 |
| `thread/tokenUsage/updated` | 需要 `threadId`、`turnId`、`tokenUsage`；`last`、`total` 必填。 | 已观察完整嵌套 usage。 | `kind:"usage"`, `usage={tokens:{total,last,modelContextWindow}}`, `done:false`。 | 可缺省。 | 用 `total` 更新累计用量；用 `last` 展示增量；不得相加。 |
| `account/rateLimits/updated` | 需要 `rateLimits`；稀疏更新需要合并。 | 摘要丢失 `rateLimits`。 | `kind:"usage"`, `usage={rateLimits}`, `done:false`。 | 可缺省。 | 合并稀疏限流快照；缺失可空字段不清空旧值。 |
| `mcpServer/startupStatus/updated` | 需要 `name`、`status`；`threadId`、`error`、`failureReason` 可选。 | 摘要省略 `name`。 | `kind:"status"`, `text=status`, `done:false`, `meta.raw`。 | 可缺省。 | 更新 MCP 启动状态；失败要暴露。 |
| `remoteControl/status/changed` | 需要 `installationId`、`serverName`、`status`。 | 摘要省略身份字段。 | `kind:"status"`, `text=status`, `done:false`。 | 可缺省。 | 更新远程控制状态；不参与 turn 内容。 |
| `warning` | 需要 `message`；`threadId` 可选。 | 摘要省略 `message`。 | `kind:"status"`, `text=message`, `done:false`。 | 可缺省。 | 显示警告；不终止 turn。 |
| `error` | 需要 `threadId`、`turnId`、`error`、`willRetry`。 | 未观察。 | 可重试时 `kind:"status"`, `text=error.message`, `done:false`, `meta.willRetry`。 | 未演练失败/重试路径；必须防御性处理。 | 可重试则保持 turn 活动并展示错误；不可重试则等待终态，不得伪造完成。 |
| `turn/completed` | 需要 `threadId`、`turn`；`turn.status` 必填，可为 `completed`、`interrupted`、`failed`、`inProgress`；失败时 `turn.error` 有值。 | 摘要为 `turnId/status`。 | `kind:"done"`, `done:true`, `meta.turnId`, `meta.status`; `turn.items` 映射最终内容/工具状态；失败时 `turn.error.message` 映射 `text`。 | 必须有，作为终态。 | 结束 turn，用 `turn.items` 替换流式预览，停掉活动计时器，必要时更新 usage。 |
| `turn/failed` | 生成 v2 `ServerNotification` 方法集未包含；schema 终态路径是 `turn/completed` 且状态为 `failed`。 | 探测器有分支但未触发。 | 若旧运行时真的发出，映射 `kind:"done"`, `done:true`, 从可用错误信息取 `text`, `meta.status="failed"`。 | 可选且未验证。 | 仅在实际收到时使用；否则以 `error` 和 failed `turn/completed` 处理。 |
| `turn/diff/updated` | 需要 `threadId`、`turnId`、`diff`。 | 未观察。 | `kind:"tool"`, `tool={type:"fileChange",diff}`, `done:false`。 | 可缺省。 | 整体替换 turn 级 diff 预览。 |
| `turn/plan/updated` | 需要 `threadId`、`turnId`、`plan`。 | 未观察。 | `kind:"text"`, `text=plan` 或结构化 plan 入 `meta.raw`, `done:false`。 | 可缺省。 | 整体替换 turn 级 plan 视图。 |
| `turn/moderationMetadata` | 需要 `threadId`、`turnId`、`metadata`。 | 未观察。 | `kind:"status"`, `done:false`; raw metadata 保留。 | 可缺省。 | 仅审计；不显示为 assistant 文本。 |

## 3. 生命周期最小集

### 必须等待

1. `initialize` 响应，随后发送 `initialized`。
2. `thread/start` 响应中的权威 `thread.id`。
3. `turn/start` 响应中的权威 `turn.id` 和初始状态。
4. `turn/completed` 通知；这是 schema 声明的唯一终态事件。`turn.status` 可为 `completed`、`interrupted`、`failed`；`inProgress` 只调和，不接受为完成。

### 可期望但无保证

- `thread/started` 与响应冗余。
- `thread/status/changed` 可用于 spinner，但不是终态权威。
- `turn/started` 与响应冗余。
- `item/started`、各类 delta、`item/completed` 可能按模型/运行时只出现任意子集；46 事件样本中的短命令没有 command output delta。
- usage、限流、warning、MCP startup、remote control、diff/plan/moderation 均为辅助事件。

包含回答的最小正确重建：

```text
thread/start response -> turn/start response
  -> 至少一个权威内容来源
     （agent item/completed，或 turn/completed.turn.items）
  -> turn/completed(status=completed)
```

实现可以在 delta 到达时流式渲染，但必须做到：即使所有内容事件都缺失、只收到终态 turn 对象，结果状态也正确。

## 4. Interrupt 映射

`turn/interrupt` 需要 `threadId` 与 `turnId`；响应属性可为空。泛化样本顺序：

```text
-> turn/interrupt params={"threadId":"<thread-id>","turnId":"<turn-id>"}
<- response result={}
EVENT thread/status/changed {"threadId":"<thread-id>","status":{"type":"idle"}}
EVENT turn/completed {"threadId":"<thread-id>","turnId":"<turn-id>","status":"interrupted"}
```

归一化结论：

- `turn/interrupt` 响应：保持 `done:false`，turn 尚未终止。
- `thread/status/changed` 到 `idle`：更新状态，但仍保持 `done:false`。
- `turn/completed`：映射 `kind:"done"`, `done:true`, `meta.status:"interrupted"`。
- 不要求 user message item 完成或任何 agent/tool 事件先到达。
- schema 原始终态字段是 `threadId` 与嵌套 `turn.id` / `turn.status`；日志扁平字段是摘要。

## 5. 异议与边界

- `turn/failed` 不在生成 v2 通知方法集内；schema 失败路径是 `turn/completed` 且 `turn.status:"failed"`。只有旧运行时真实发出时，才通过兼容适配器处理。
- 真实运行日志是摘要，不是原始帧；`warning.message`、`rateLimits`、MCP `name`、时间戳以及嵌套 thread/turn/item 对象可能缺失。
- 审批、服务器发起请求、steering、活动工具打断未演练；对应映射不得作为已验证行为实现。
