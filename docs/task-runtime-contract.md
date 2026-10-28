# TaskRuntime 合同（P3.1 · 2026-10-28）

> 目的：把「公共代码直读引擎字段」收编成方法调用，使第二个引擎接入时**不需要任何 `if (engine === 'codex')`**。
> 依据：现行 `src/index.js`（4,059 行）实况；行号均指该版本，改动后须重核。
> 不在本文件实现，只定形状；实现从 P3.2 开始按节收编。

---

## 一、状态机（先定这个，合同才有意义）

现有代码的 `task.status` 实际取值只有四个：`running | done | error | cancelled`（`finalizeJob:1932` 是唯一写点）。
合同把它拆成「运行态」+「终局」两轴，**不引入现有代码里没有的状态**（`queued` / `finalizing` 无对应物，见 §六）：

```ts
type TaskStatus = 'running' | 'cancelling' | 'finished';

type TaskOutcome =
  | { kind: 'succeeded' }      // 原 done（exit 0）
  | { kind: 'failed'; error?: string }   // 原 error
  | { kind: 'cancelled' }      // 原 cancelled
  | { kind: 'lost'; why: string };       // 原 reconcile 判失联
```

对应关系：

| 现状 | 合同表达 |
|---|---|
| `status='running'` | `status='running'`, `outcome=null` |
| `cancelled=true` 但 `endedAt` 未写 | `status='cancelling'`, `outcome=null`（= 现在的 `viewStatus()` 映射） |
| `status='done'` + `endedAt` | `status='finished'`, `outcome={kind:'succeeded'}` |
| `status='error'` | `status='finished'`, `outcome={kind:'failed'}` |
| `status='cancelled'` | `status='finished'`, `outcome={kind:'cancelled'}` |
| reconcile 判失联 | `status='finished'`, `outcome={kind:'lost'}` |

**铁律**：`finished` 一旦成立不再变（等价于现有 `endedAt` 幂等哨兵 `:1930`）。

---

## 二、合同

```ts
interface EngineDescriptor {
  readonly id: string;                                  // 'codex'
  readonly transport: 'process' | 'http' | 'in-process'; // 实现方式，不是能力
}

interface EngineCapabilities {
  readonly eventStream: 'fine' | 'coarse' | 'none';   // progress 的粒度
  readonly approvals: boolean;                        // 能否反向请求批准
  readonly resume: boolean;                           // 能否续会话
  readonly checkpoint: boolean;
  readonly usage: boolean;                            // 是否报 token 用量
  // ── P4.24（2026-10-29）面板能力适配：语义已定死，不得互推 ──
  readonly chatBridge: boolean;                       // 用户**是否可用** Web 聊天桥（不是「怎么实现」）
  readonly chatBridgeMode: 'app-server' | 'pi-rpc' | 'none'; // 实现模式；与 chatBridge 两个维度
  readonly modelSwitch: 'config-file' | 'runtime-command';   // 模型切换方式（仅描述切换）
  readonly versionCheck: 'github' | 'npm';                   // 版本检查源；非 github 不得请 /api/version
  readonly mcp: 'config-toml' | 'pi-config' | 'none';        // MCP 配置真源；**不得**由 modelSwitch 推导
  readonly webSearch: boolean;                        // 原生联网搜索开关可用性；与 mcp 独立
}

/**
 * 清理目标（P4.24）。**不**塞进 capabilities：`resume` 与「删哪个目录」无因果关系。
 * 实现在 src/engine/registry.js 的 CLEANUP_TARGETS，唯一出口是 engineView() 的 `engine.cleanup`。
 */
interface CleanupTarget {
  readonly dir: string;              // 绝对路径（直接给 UI 显示，不让用户猜）
  readonly filePattern: string;      // 如 '*.jsonl'
  readonly appliesToEngine: string;  // 该目标属于哪个引擎
  readonly confirmRequired: boolean; // 破坏性确认（Pi 走 POST /api/pi-cleanup 的 confirm:true）
}

/**
 * 当前引擎模型视图（P4.25，2026-10-29 契约 4.2）。Pi 的优先序：
 *   ① runtime 当前值（Pi 桥 /api/runtime-settings → get_state 回读）
 *   ② Pi settings 的默认（settings.defaultProvider → keyring.active）
 *   ③ 空值 + fallback:true，不猜
 * keyring 只在第 ② 级作为「配置默认」参与，不单独决定 provider。
 * fallback=true 的语义：**没有可验证的 runtime 值，显示的是配置默认值**（UI 据此标注「（默认值）」），
 * 不要泛化成任意回退。
 */
interface EngineModel {
  readonly providerId: string;
  readonly model: string;
  readonly fallback: boolean;
  readonly source: 'runtime' | 'config' | 'keyring' | 'none';
}

interface ViewEvent { kind: 'status' | 'text' | 'reasoning' | 'tool' | 'usage' | 'done'; text: string; at: number }
interface ArtifactRef { path: string; bytes?: number; kind?: 'output' | 'live' | 'review-round' }

interface TaskSnapshot {
  status: TaskStatus;
  outcome: TaskOutcome | null;
  activityAt: number;            // 与看门狗同一来源（现行 task.activityAt）
  stuckSuspect: boolean;
  progress: ViewEvent[];         // 只含封闭投影（现行 view.progress）
  liveBytes?: number;
  error?: string;
  details?: unknown;             // 复核域：rounds / issues / verdict
}

interface TaskRuntime {
  readonly descriptor: EngineDescriptor;
  readonly capabilities: EngineCapabilities;

  /** 起一个 run。返回后公共代码只通过下面四个方法观察它。 */
  start(spec: { prompt: string; workdir: string; outPath: string; ephemeral: boolean }): Promise<void>;

  /**
   * 取消：runtime **拥有子进程**，负责 interrupt → SIGTERM → 3s SIGKILL 整条终止链。
   * 对外语义只是「请求」（可能失败/延迟），终局仍由 finalize 落定。
   * 公共代码**不得持有 `task.child`**，也不得自己 kill —— 这是 Codex 复核指出的合同缺口：
   * 原稿只写"只写意图"，那样 `FixedRuntime` 这种无子进程的实现接不进来。
   */
  cancel(): Promise<void>;

  /** 活性心跳；返回当前 activityAt。看门狗只调它，不再摸文件。 */
  heartbeat(at?: number): number;

  /** 一次取全量视图。公共代码（taskView/taskSummary/看板）只调它。 */
  snapshot(): TaskSnapshot;

  /** 增量事件（可选能力；eventStream='none' 时应为空流，不伪造）。 */
  events(afterSeq?: number): AsyncIterable<ViewEvent>;

  /** 产物引用（路径语义由 runtime 负责，公共代码不得从文件名反解 id）。 */
  artifacts(): ArtifactRef[];

  /** 唯一收尾入口：把 evidence 变成终局。重复调用是 no-op。 */
  finalize(evidence: {
    exitCode?: number; signal?: string; cancelled?: boolean;
    error?: string;
    lost?: string;        // 对账判失联的原因；与普通 failed 区分（原 reconcileLost）
  }): Promise<boolean>;
}
```

---

## 三、映射表（合同项 → 现行代码落点）

| 合同项 | 收编点（现行行号） | 收编判据 |
|---|---|---|
| `descriptor.transport` | `task.mode` 判断 `:1749`、赋值 `:2281`；`task.child:2328`、`task.app:2329` | 由「有没有 child / app」推导，替代字符串枚举 |
| `capabilities` | 目前**无承载点** → 新增字段，落 `taskView:1735` 与 `/status` 响应 | 纯增量，UI 按能力降级 |
| `capabilities.chatBridge` / `chatBridgeMode` / `mcp` / `webSearch`（P4.24） | 定义 `registry.js:ENGINES[*].capabilities` → 出口 `index.js:1202 engineView()` → 消费 `client.js:418` 兜底 | 同一提交内同步四处（任务书 v2 §4.5）；新字段对旧前端是惰性增量 |
| `CleanupTarget`（P4.24） | `registry.js:CLEANUP_TARGETS` → `engineView().cleanup`；实际删除仍是 `handleCleanup:2492` / `handlePiCleanup:1495` | UI 必须显示 `dir`；`resume` 与清理不得互推 |
| `start()` | `startAppServerTask:2267`、`spawnReviewRound:3089`、exec 的 `child.on('exit'):2456`、复核的 `:3116` | 三入口收敛成一个；child 归 runtime 持有 |
| `cancel()` | `handleTaskCancel:2504`（写意图 `:2517`）、`handleReviewCancel:3518`（`:3530`） | 两处只写意图，不预置终态（已经是现状） |
| `heartbeat()` | `onEvent` 写 `activityAt` `:2325`、`startWatchdog:1838` 判据 `:1851-1853`、`outFileMtimeMs:1826` | 看门狗不再直接读 mtime，改调 heartbeat |
| `snapshot()` | `taskView:1735`、`taskSummary:1800`、`viewStatus:1730`、`finalizeJob:1927`（唯一写 `:1932`）、`probeTaskLost:1013`、`reconcileOnce:1030`→`:1056` | 公共代码只调它，不读 `task.status/exitCode/endedAt` |
| `events()` | `projectProgress:2260`、`view.progress:1756`、`task.engineEvents:2316` | 封闭投影（已做）；原文留 engineEvents |
| `artifacts()` | `task.outPath`（读 `:1941`、删 `:1945-1946`）、`task.live:1748`、`task.output:1941` | 路径规则与清理归 runtime，公共代码只拿引用 |
| `finalize()` | `finalizeJob:1927` / `finalizeTask:1955` / `finalizeReview:1992` | 三个包装收敛成一个，extra 白名单保留 |

### 17 个字段的归属（逐个，无遗漏 —— 按 Codex 复核补齐）

| 字段 | 归属 | 现行行号 |
|---|---|---|
| `app` / `child` | **runtime 私有**（cancel/finalize 用），公共代码不读 | `:2328-2329` |
| `live` | `artifacts()` + `snapshot().liveBytes` | `:1748` |
| `progress` | `snapshot().progress`（封闭投影）；`events()` 可选 | `:1756` |
| `mode` | `descriptor.transport` | `:1749` / `:2281` |
| `watchdog` | 公共看门狗只调 `heartbeat()` | `:1846` |
| `activityAt` | `heartbeat()` / `snapshot().activityAt` | `:1845` / `:2325` |
| `stuckSuspect` | `snapshot().stuckSuspect` | `:1858` |
| `exitCode` | `finalize()` 入参；投影 `snapshot().outcome` | `:1933` |
| `cancelled` | `cancel()` 意图；投影 `snapshot().status='cancelling'` | `:2517` / `:3530` |
| `appError` | `finalize()` 入参 `error`；投影 `snapshot().error` | `:2331` |
| `outPath` | `start(spec.outPath)` / `artifacts()` | `:1941-1946` |
| `forcedKill` | **runtime 私有**，不对外；诊断进 `details` | `:2530` |
| `childPid` / `childStart` | **runtime 私有**，仅 `transport==='process'` 时存在 | `:1841-1843` |
| `lastSignal` | `finalize()` 入参 `signal`；投影 `snapshot().details.lastSignal` | `:1790` / `:2464` |
| `reconcileLost` | `finalize()` 入参 `lost`；投影 `outcome.kind==='lost'` | `:1056` / `:1792` |

**归零判据**（P3.8）：
```bash
grep -cE "task\.(app|live|progress|mode|child|watchdog|forcedKill|childPid|childStart|activityAt|stuckSuspect|lastSignal|exitCode|cancelled|reconcileLost|appError|outPath)\b" src/index.js
# 期望 0
```

---

## 四、假引擎（先验合同，不接真 CLI）

用它证明「实现合同就能被公共代码驱动」，全程不看引擎品牌：

```js
class FixedRuntime {
  constructor() {
    this.descriptor = { id: 'fixed', transport: 'in-process' };
    this.capabilities = { eventStream: 'none', approvals: false, resume: false, checkpoint: false, usage: false };
    this._status = 'running'; this._outcome = null;
    this._activityAt = Date.now(); this._progress = []; this._artifacts = []; this._ended = false;
  }
  async start(spec) {
    this._artifacts.push({ path: spec.outPath, kind: 'output' });
    setTimeout(() => { this._status = 'finished'; this._outcome = { kind: 'succeeded' }; }, 2000);
  }
  async cancel() { this._status = 'cancelling'; }   // 只写意图
  heartbeat(at) { return (this._activityAt = at ?? Date.now()); }
  snapshot() {
    return { status: this._status, outcome: this._outcome, activityAt: this._activityAt,
             stuckSuspect: false, progress: this._progress, liveBytes: 0 };
  }
  async *events() { /* eventStream:'none' → 空流，不伪造 */ }
  artifacts() { return [...this._artifacts]; }
  async finalize(ev) {
    if (this._ended) return false;                  // 幂等
    this._ended = true;
    this._status = 'finished';
    this._outcome = ev.cancelled ? { kind: 'cancelled' }
                 : (ev.error ? { kind: 'failed', error: ev.error }
                 : { kind: 'succeeded' });
    return true;
  }
}
```

**验收**：把 `FixedRuntime` 塞给 `taskView` / 看板 / 取消接口，`grep -c "=== 'codex'"` 结果必须为 0。

---

## 五、未定项（实施时再决，不阻塞合同）

1. `events()` 的序号语义：用递增 seq 还是时间戳游标（Codex 建议 cursor，可重放）。
2. ~~`capabilities` 放哪：`taskView` 顶层还是嵌在 `engine` 字段下（影响前端改动面）。~~
   **已定（P4.24，2026-10-29）**：面板侧嵌在 `/status` 与 `/config` 的 `engine.caps` 下（出口 `engineView():1202`）；
   `taskView` 侧仍待收编。清理范围**不入** `capabilities`，走 `engine.cleanup: CleanupTarget`。
3. review 域的 `details` 类型：目前 `rounds/issues/verdict` 形状未定，先用 `unknown`。

---

## 六、为什么砍掉 `queued` / `finalizing`

上一版（外部模型产出）的合同里列了五态。实测 `grep -c "queued\|finalizing" src/index.js` = **0**：

- 没有队列（`POST /task` 立刻起子进程，无排队阶段）
- 没有异步 finalize（`finalizeJob` 同步写完即返回）

引入两个不存在的状态，会让 P3.2–P3.7 每一处状态判断都要多考虑两种情况，却不带来任何能力。`cancelling` 保留，因为它对应真实的中间窗口（`task.cancelled=true` 且 `endedAt` 未写）。
