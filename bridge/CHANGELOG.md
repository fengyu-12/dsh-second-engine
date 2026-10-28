# 变更与回滚史 · 第二引擎 浏览器聊天桥

本文件是**改动记录 + 回滚手册**（时间倒序）。使用/安装/接入请看同目录 `README.md`。

> 路径约定：文中 `/root/proj/web-bridge/` 指**本机运行实例**；可搬运副本里对应的就是本目录的
> `bridge/`（`bridge/server.mjs`、`bridge/ctl.sh`、`bridge/public/index.html` …）。
> 备份文件名（`*.bak-*`）只在本机运行目录里存在。

---

# 2026-09-29（续）— 浏览器聊天桥并入插件：4 透传路由 + 面板桥卡 + MCP 启用/禁用

## 1. 做了什么

插件成为聊天桥的**唯一入口**（此前桥由独立脚本 `codex-env` 硬编码路径驱动，插件完全不知道它存在）。

| 改动 | 文件 | 说明 |
|---|---|---|
| MCP 启用/禁用 | `src/index.js` | `listMcpServers()` 增读 `enabled`；新增 `setMcpServerEnabled()`；`POST /api/mcp/<name> {enabled}`；路由注释同步 |
| MCP 启用/禁用 | `lib/client.js` | MCP 项加「已启用/已禁用」徽标 + 启用/禁用按钮 |
| 桥 4 路由 | `src/bridge-routes.js`（**新增**） | `status/start/stop/url` 透传 `ctl.sh`；`execFile` + 固定子命令白名单；错误码 `bridge-timeout/bridge-failed/bridge-missing/bridge-bad-json`；`?t=` 打码 |
| 桥 4 路由接入 | `src/index.js` | `import { registerBridgeRoutes }`；`ctx.inject(['webServer'])` 注册循环后调 `registerBridgeRoutes(wctx)` |
| 面板桥卡 | `lib/client.js` | 新增 `BridgeCard`：状态 + 启动/打开网页/停止/刷新；接入 `SecondEngineSection` |

**依据**：Codex 官方文档支持 `[mcp_servers.*] enabled = true|false`；面板此前只映射 CLI 的 `add/remove`，缺 `disable`。

## 2. 桥侧改造（同批：Codex 施工 + 主 AI 补修）

- `second-engine-bridge/bridge/ctl.sh`、`server.mjs`：状态目录分离（`BRIDGE_STATE_DIR`，默认 `~/.dsh/second-engine-bridge/`）、`BRIDGE_WORKDIR` 参数化、端口探测 + `ports.json` 持久化、`start.lock` 启动锁、新增 `status-json`、`NODE_BIN`/`CODEX_BIN` 参数化。
- ⚠️ **主 AI 补修的一处（不可省）**：Codex 把 `load_key()` 当「密钥红线」删了 → app-server 拿不到 provider key，桥**能启动但跑不了回合**。已恢复，并在 `start_as` 起 app-server **之前**调用；实测 app-server 进程环境出现 `ZHIPU_API_KEY`。**红线管的是 key 不进日志/产物/命令行，不是不许从 keyring 读。**
- ⚠️ **路由模块的一处 bug（主 AI 修）**：原稿用 `res.end(json, undefined, 502)` 设状态码——Node 的 `res.end(data, encoding, callback)` **没有 statusCode 参数**，502/405 不会生效。已改为先 `res.statusCode = code` 再 `end`（与插件 `send()` 同口径）。

## 3. 自验

```
node --check src/bridge-routes.js / src/index.js / lib/client.js  → 全部 OK
runBridgeCommand('status-json')  → ok，{"web":{"running":true,"pid":...},"healthy":true}
runBridgeCommand('url')          → ok，http://127.0.0.1:3095/?t=<打码>
runBridgeCommand('rm-rf')        → 白名单拒绝
面板禁用 exa 后：config.toml 出现 enabled = false；新工单过程流 exa 错误 0 行
```

**待生效**：插件改动需**重启 DSH Web** 才加载（重启后面板出现「浏览器聊天桥」卡与 MCP 启停按钮）。

## 4. 回滚

```sh
cd /root/dsha-second-engine
cp -p src/index.js.bak-20260929-mcptoggle  src/index.js
cp -p lib/client.js.bak-20260929-mcptoggle lib/client.js
rm -f src/bridge-routes.js
# 桥侧回滚见上一节（*.bak-20260929-statedir.base）
```

## 5. 遗留

- 桥代码**尚未搬进插件包**（`bridge-routes.js` 用 `BRIDGE_DIR` 默认指向 `~/proj/second-engine-bridge/bridge`）；分发包 `files` 未含桥。
- `codex-env` 仍是独立脚本，未收编（「唯一入口」还差这一步）。

---

# 2026-09-29 — 修结构隐患：分发包默认目录与本机运行实例不一致

## 1. 问题（用户报「`codex-env -u` 的网址和终端对接不上」）

`codex-env`（已装 `/usr/local/bin/codex-env`）默认桥目录 09-28 已改为
`$HOME/proj/second-engine-bridge/bridge`，但**那次改动没有回灌分发包**：包内安装器与启动器
仍以 `$HOME/proj/web-bridge` 为默认。后果＝本机跑一次 `./install.sh --with-codex-env` 会把桥
拷回旧目录、并用旧版启动器覆盖已装版 → 配置指向与实例落点错位 → 3095 上的进程与 `-u` 给出的
token 不匹配 → **401**（现象酷似「网址过期/对接不上」）。

判据（决定性）：用两组 token 打鉴权接口 `/api/threads` —— 认的那份 200、另一份 401；再看
`readlink /proc/<pid>/cwd` 确认谁在监听 3095。**不要只看配置文件**（配置文件可能本来就是对的）。

## 2. 改法（4 个文件，均带备份）

1. `install.sh`：默认 `$TARGET` → `$HOME/proj/second-engine-bridge/bridge`；新增**源=目标保护**
   （`readlink -f` 比对，相同则跳过拷贝，避免 `cp: are the same file`）。
2. `bin/codex-env`：默认 `$BRIDGE_DIR` → 同上。
3. `web-bridge/ctl.sh`：新增**旧实例守卫** —— `start`/`restart` 在未设
   `ALLOW_DEPRECATED_BRIDGE=1` 时直接拒绝（exit 1），防止再次占住 3095。
4. `README.md`：安装示例路径同步。

## 3. 自验

```
bash -n install.sh / bin/codex-env / web-bridge/ctl.sh      → 三个 OK
./install.sh --dry-run                                      → 目标=…/second-engine-bridge/bridge
                                                              + 「跳过拷贝（原地安装）」
./install.sh --dry-run /tmp/se-test-target                  → 走正常拷贝分支
cd web-bridge && ./ctl.sh start                             → 被拒，退出码 1
bridge/ctl.sh status                                        → 活着（网页 12105 / 所有者 12035）
                                                              3095 监听者 cwd 仍指 bridge
grep -n web-bridge install.sh bin/codex-env                 → 零命中
```

## 4. 回滚

```sh
cd /root/proj/second-engine-bridge
cp -p install.sh.bak-20260929-defaultpath    install.sh
cp -p bin/codex-env.bak-20260929-defaultpath bin/codex-env
cp -p README.md.bak-20260929-defaultpath     README.md
cp -p /root/proj/web-bridge/ctl.sh.bak-20260929-depguard /root/proj/web-bridge/ctl.sh
```

## 5. 遗留（本次未做）

- ~~包内 `bin/codex-env`（09-23）功能落后于已装版~~ → **同日已回灌**：补 `-u`/`--url` 分支、
  `-r` 的 flock 锁探测、help 同步。**故意不回灌** `BOOT_LOG`（`$HOME/proj/se-verify/boot-log.sh`
  是本机运维耦合，分发包不该带），也不改硬编码→变量的设计（包内 `BRIDGE_DIR` 可覆盖更好）。
  实测：`BRIDGE_DIR=… bash bin/codex-env -u` 正常打印网址、`bash -n` 通过。
- `/root/proj/README.md` 工具表仍把 `web-bridge/ctl.sh` 当运行实例（历史文档，未改）。

---

# 2026-09-25（再三补）— 界面换浅色：配色抽成变量 + 深浅切换

## 1. 需求

用户：「UI 界面可以换成白色吗」→ 浅色**设为默认**，同时留一个切换按钮（不砍掉深色）。

## 2. 改法（只动 `public/index.html`，服务端没碰）

原来配色写死在 `:root` 里，另外有 8 处规则内联了硬编码颜色（`#22304a`、`#0f1115`、`#0b0d10`、
`rgba(0,0,0,.55)` …）。做法：

- 配色**全部**收进变量：`--bg / --panel / --line / --fg / --dim / --muted / --accent / --err / --warn`
  之外新增 `--bubble-me / --bubble-ai / --input-bg / --btn-fg / --sel / --mask / --hover-warn`；
- `:root` = **浅色**（默认，`color-scheme: light`），`html[data-theme="dark"]` = 原来的深色值；
- 规则里的硬编码颜色全部换成 `var(...)`（`grep '#[0-9a-f]\{6\}'` 现在只剩两个变量块命中）；
- 头部加 `#theme` 按钮（浅色显示 🌙 / 深色显示 ☀），选择存 `localStorage.bridge_theme`；
- `<head>` 里加一行内联脚本，在样式表之前就把 `data-theme` 挂上 —— **深色用户不会看到一瞬白屏**。

## 3. 自验

```sh
sed -n '/^<script>$/,/^<\/script>$/p' public/index.html | sed '1d;$d' > /tmp/x.mjs && node --check /tmp/x.mjs
./ctl.sh reload-web        # 不踢 TUI
```

无头浏览器（1440×900）实测取值：

| 状态 | data-theme | body 背景 | body 前景 | 按钮 |
|---|---|---|---|---|
| 默认 | `light` | `rgb(244,245,247)` | `rgb(23,26,31)` | 🌙 |
| 点击后 | `dark` | `rgb(20,22,26)` | `rgb(230,232,236)` | ☀ |
| 刷新后 | `dark`（记住了） | — | — | ☀ |
| 再点一次 | `light` | — | — | 🌙 |

截图已归档：`evidence/2026-09-25/ui/ui-light.png`、`ui-light-drawer.png`、`ui-dark.png`
（原 `/root/proj/.scratch/`，2026-09-25 收进 `evidence/`）。

## 4. 回滚

```sh
cd /root/proj/web-bridge
cp -p public/index.html.bak-20260925-light-theme public/index.html
./ctl.sh reload-web
```

---

# 2026-09-25（再补）— 409「被另一个终端占用」：把真正的锁持有者查出来

## 1. 问题：这句话经常是错的

旧提示（两处：`server.mjs` 归档/删除的 409、`public/index.html` 发消息前的本地拦截）：

> 这条会话正被另一个终端占用，先退出那个终端再来。

**实测下来的真相**：会话写锁的持有者**就是我们自己的 app-server**，压根没有「另一个终端」。

```
$ 扫 /proc/*/fd 找指向 thread-writer-locks/*.lock 的进程
/proc/23532 -> /root/.codex/thread-writer-locks/01a0d8ad-….lock
$ tr '\0' ' ' < /proc/23532/cmdline
codex app-server --listen ws://127.0.0.1:3096      ← 就是桥自己的上游（.as.pid = 23532）
```

所以用户拿到的是一句**没法执行**的指令：去找一个不存在的终端关掉。

## 2. 改法

`server.mjs` 新增锁持有者探测（禁止 `pgrep -f`，扫 `/proc/<pid>/fd` + `readlink` 比对
`path.basename(target) === '<id>.lock'` 且路径含 `thread-writer-locks`，见铁律 12）：

- `scanLockHolders(threadId)` → 候选进程；`appServerPid()` → 读 `.as.pid`，失效则按
  `cmdline` 含 `app-server` + `AS_URL` 兜底；`lockHolder(threadId)` → 汇总
  `{held, holders:[{pid,comm,cmdline,isUpstream,lockPath}], selfOnly, hint}`
- **如实区分两种情形**，不再一口咬定「另一个终端」：
  - `selfOnly`（锁在自家 app-server 手里）→「app-server 里这条会话还是 active，不是别的终端占着；
    要么终端那边 `codex --remote` 正跑着这一轮，要么是上游没释放的残留」
  - 别的进程拿着 → 直接报 `pid` + 完整命令行，用户能对上号
- 归档/删除的 409 body 带上 `holder`；新增 `GET /api/lock-info?id=` 供前端按需查询
  （扫 `/proc` 有成本，**不进**每 5 秒轮询的 `/api/threads`）

前端（`public/index.html`）：

- 新增 `checkLockOwner(id)`：查完把 `hint` 写进对话流；`noteFresh()` 绕开 `seenNotes` 去重，
  保证**每次点都会看到**（顺带治了「同页第二次点提示不出现」的老毛病）
- 会话列表的「占用中」标签**可点**（`.tag.busy.clickable`），点一下就去查是谁占着
- 发消息被占用的分支、归档/删除失败分支，都改成显示真持有者

## 3. 顺带：会话列表搜索框（PC 桌面）

抽屉顶部加搜索栏，纯前端过滤标题 / 完整会话 ID，顶部显示 `N / M 条匹配`，
`Ctrl+K`（或 `Cmd+K`）唤起并聚焦，`Enter` 打开第一条匹配，`Esc` / `✕` 清空。

## 4. 自验（全部实测）

```sh
cd /root/proj/web-bridge
node --check server.mjs                                    # 语法 OK
sed -n '/^<script>/,/^<\/script>/p' public/index.html | sed '1d;$d' > /tmp/x.mjs && node --check /tmp/x.mjs
./ctl.sh reload-web                                        # 不踢 TUI
T=$(cat .token)
curl -s -H "x-bridge-token: $T" "…/api/lock-info?id=01a0d8ad-…"   # → held:true, pid 23532, isUpstream:true
curl -s -H "x-bridge-token: $T" "…/api/lock-info?id=00000…"       # → {"held":false}
curl -s -o /dev/null -w '%{http_code}' "…/api/lock-info?id=x"     # → 401（无 token）
curl -s -X POST "…/api/thread/archive" -d '{"id":"01a0d8ad-…"}'   # → 409 + holder（未产生归档副作用）
```

无头浏览器实地跑（1440×900，PC 视口）：

```
列表 7 条 → 搜索「确认终端」→ 1 条命中，计数行「1 / 7 条匹配」
点「占用中」标签 → 日志出现 hint、状态栏「锁在上游 app-server」
截图已归档：`evidence/2026-09-25/ui/` 下的 `ui-drawer.png`、`ui-search.png`、`ui-lock.png`
```

## 5. 回滚

```sh
cd /root/proj/web-bridge
cp -p server.mjs.bak-20260925-lockholder server.mjs
cp -p public/index.html.bak-20260925-lockholder-search public/index.html
./ctl.sh reload-web
```

## 6. 未做（明确留白）

来自中转站 `relay-forge/out/20260925-144743/`（三模型各一版补丁）的另外两项：
`replay()` 增量渲染、NDJSON 断线状态灯 + 退避重连 —— **都没落地**。理由：这两项要动
流式核心与历史回放，回归风险高，而本次只做「有实测证据 + 只加不改」的部分。
三模型那版 `409` 方案已被本条目取代（它们看不到 `.as.pid` 与真实拓扑，沿用了「另一个终端」的错误前提）。

---

# 2026-09-25（补）— 网页「中断」按钮点了没反应：竞态根因修复

## 1. 问题与根因

**现象**：网页点「中断」，回合照跑，界面无任何反馈。

**根因（代码定位 + 实测）**：**竞态**。`entry.turnId` 是**异步**就绪的：

```js
const entry = { ..., turnId: null, ... };              // 362 行：先建，turnId 为 null
active.set(threadId, entry);
const started = await as.call('turn/start', {...}, 120000);   // 366：这里可能等一会儿
entry.turnId = started.turn?.id || entry.turnId;              // 367：这才有值
```
另有通知路径：`case 'turn/started': if (a && !a.turnId) a.turnId = p.turn?.id || null;`

而：
```js
async function interrupt(threadId, turnId) {
  if (!turnId) return false;     // ★ 就绪前点中断 → 直接返回，一个 RPC 都没发出
```

**用户在 `turn/start` 返回前点中断 → 那次点击被静默丢弃。** 前端又雪上加霜：
```js
try { await fetch('/api/stop', ...) } catch {}   // ★ 结果与错误全吞掉，连失败都看不见
```

**次因**：`/api/stop` 用 `active.entries().next().value` 取**第一个**活跃回合 —— 多会话时会停错那个。

## 2. 代码改动（按文件）

改动 2 个文件、共 7 处；**均只在前端/桥层，未动 app-server 与 codex 本体**。

| 文件 | 改动 |
|---|---|
| `server.mjs`（运行实例 + 可搬运副本，两份同改） | 见下 6 处 |
| `public/index.html`（两份同改） | 见下 1 处 |

**server.mjs**
1. `active` 注释：entry 增加 `pendingCancel` 字段
2. 新增 `tryPendingCancel(entry)`：`turnId` 就绪时补发中断，消费后清标记防重复
3. `case 'turn/started'`：就绪时调用 `tryPendingCancel`
4. `entry` 字面量：`pendingCancel: false`
5. `entry.turnId = started.turn?.id || ...` 之后：调用 `tryPendingCancel`
6. **`/api/stop` 重写**：支持请求体 `{threadId}` 精确定位；不带时仅在**唯一**活跃回合下回退，
   多回合返回 **409 `state:'ambiguous'`**（而不是猜）；返回四态
   `stopped` / `pending` / `none` / `failed`（+ `ambiguous`）

**public/index.html**
7. `stop()` 重写：保留 `abort()` 在前（见下方"假阳性"），改为**带 `{threadId}` 的 POST** 并解析四态，
   经 `addNote` 明确反馈（已中断 / 已登记取消 / 没有正在跑的回合 / 上游未确认 / 冲突 / HTTP 错误）

**备份**：`server.mjs.bak-20260925-interrupt-race`、`index.html.bak-20260925-interrupt-race`（两处目录各一份）

## 3. 验证结论

```sh
# 语法
node --check web-bridge/server.mjs                                  # 通过
python3 抽 index.html 内联 script → node --check                    # 通过

# 重载（README 明确：reload-web 不踢终端 TUI）
bash ctl.sh reload-web        # → 网页桥已重载 (pid 18084；所有者没动)

# 新接口实测
POST /api/stop {}                                  → {"ok":true,"state":"none","stopped":false}  HTTP 200
POST /api/stop {"threadId":"<不存在>"}              → {"ok":true,"state":"none","stopped":false}  HTTP 200
POST /api/stop 无 token                             → HTTP 401（鉴权未被破坏）
GET  /          含 "已登记取消"                      → 命中 1 次（新前端已上线）
bash ctl.sh status                                  → appServer connected:true / readyz ok
```

**未验证**：真实的 `pending`（启动期点中断）路径需人工在页面上复现一次才能确认闭环 ——
本环境无法在不真跑一轮的前提下构造 `turnId` 为空且用户在窗口期点击的时序。
**建议人工复现**：发一条需要长时间思考的提问，**立刻**点「中断」，应看到「回合还在启动，已登记取消：它一起来就会被停」，随后回合被停。

## 4. 回滚

```sh
cd /root/proj
cp web-bridge/server.mjs.bak-20260925-interrupt-race              web-bridge/server.mjs
cp web-bridge/public/index.html.bak-20260925-interrupt-race       web-bridge/public/index.html
cp second-engine-bridge/bridge/server.mjs.bak-20260925-interrupt-race        second-engine-bridge/bridge/server.mjs
cp second-engine-bridge/bridge/public/index.html.bak-20260925-interrupt-race second-engine-bridge/bridge/public/index.html
cd web-bridge && bash ctl.sh reload-web
```

## 5. 已知问题 / 待办

- [ ] `addNote` 有 `seenNotes` 去重（同一条文案只显示一次）→ 同一页会话内第二次点「中断」
      可能看不到同样的提示文案。若被用户抱怨，可给提示文案带上 `threadId` 前后缀或清 `seenNotes`。
- [ ] `/api/stop` 未做 threadId 格式校验（非 UUID 会走 `active.get()` 返回 undefined → `state:'none'`，行为无害）。
- [ ] 早前记录的「409 报错不说是哪个终端占用」**仍未修** —— 本单未覆盖。

## 附：用中转站做多模型第二意见的过程（可复用）

排查此 bug 时，用 `/root/proj/relay-forge/forge.py` 把任务书并发投给 4 个模型（qwen3.8-max /
qwen3.7-plus / qwen3.7-max / qwen3-coder-plus），产出 4.7K~5.4K 字符/份，**四份独立收敛到同一套方案**
（`pendingCancel` + 两条就绪路径 + 三态返回 + 精确 threadId）——**共识度可作可信度信号**。

**但共识里有一条假阳性**：3/4 模型断言「`controller.abort()` 可能把停止请求本身一起取消」。
实测证伪 —— 全文件**唯一**一处 `signal: controller.signal` 绑定在 `send()` 的 `/api/send` 流式请求（473 行）；
`/api/stop` 的 fetch **没有** signal，`abort()` 不可能影响它。故实际实现**保留 `abort()` 在前**
（UI 立即反馈，不必干等最长 15s 的 `turn/interrupt` RPC），与模型建议相反。

> **教训：共识 ≠ 正确。** 第二意见是线索，必须逐条对着代码验证后再采信 —— 与铁律「AI 输出一律当线索不当结论」同源。

候选原文留存：`/root/proj/relay-forge/out/20260925-150048/`

---

# 2026-09-25 — 网页会话列表显示会话 ID（附：终端/网页抢锁死锁定位）

## 1. 问题与根因

**现象 A（本次要修的）**：网页端会话列表**只显示标题、不显示会话 ID**。想在终端用
`codex-env -a <会话id>` 挂到同一批会话上时，用户拿不到 id，只能靠标题猜。

**现象 B（顺手定位的，比 A 严重）**：网页断线后，用户在终端用 `codex resume --last`
续上了最近一条会话；此后**网页输入框锁死**，提示「这条会话正被另一个终端占用」，
且重启桥无用。

**根因 B（实测确认）**：codex 的会话写权是 `~/.codex/thread-writer-locks/<id>.lock` 上的
flock，**一个进程 = 一个会话写者**。`codex resume --last` 起的是**独立写者**，与
`codex app-server` 所有者（本例 3096）**不是同一个** → 两者对同一把锁互斥，桥侧返回 409。

**定位方法（可复现）**：

| 步骤 | 命令 | 判读 |
|---|---|---|
| 找锁 | `ls ~/.codex/thread-writer-locks/` | 有 `<id>.lock` |
| 判活锁/残骸 | `flock -n <lock> -c true` | 退出码 0=空闲(残骸)；非 0=被活进程持有 |
| 找持有者 | 扫 `/proc/[0-9]*/fd` 里指向该 lock 的 fd | 拿到 PID + cmdline |

> ⚠️ 找持有者**不要用 `pgrep -f` / `pkill -f`** —— 匹配串会命中自身命令行（DSH 铁律 12）。
> 本次实测：`pgrep -af 'python3 xxx.py'` 的输出里出现了整段自身脚本即是此坑。
> 扫 `/proc/*/fd` 是安全的等价做法。

**关键事实**：两个桥（运行实例与可搬运副本）**都没有实现"强制释放/接管"接口**
（`rg 'release|force|takeover'` 零命中）→ 属**设计缺口**：那个终端不退出，网页就永久发不出。
桥自身 `status` 报的是 `busy:false, active:[]`，说明**不是桥认为忙，是 codex 的会话写锁真被外人持有**。

**终端侧正确姿势**（已写在 `bin/codex-env -h`，此处强调）：

| 命令 | 写者 | 与网页共享？ |
|---|---|---|
| `codex-env` / `codex-env -a [id]` | 挂 app-server 所有者 | ✓ 两边同时在线、同时发 |
| `codex-env -r` / `codex resume --last` | **独立写者** | ✗ **必与网页互斥** |

## 2. 代码改动（按文件）

改动**只在前端**，后端 `server.mjs` / `as-client.mjs` 一行未动。

改前两处 `index.html` **完全一致**（`diff -q` 验证），故两处同改：

| 文件 | 说明 |
|---|---|
| `/root/proj/web-bridge/public/index.html` | 本机**运行实例** |
| `/root/proj/second-engine-bridge/bridge/public/index.html` | **可搬运副本** |

三处改动：

1. **会话列表项 meta 行新增 ID 芯片**：显示 `id.slice(0,8)`，点击复制**完整** id，
   悬停 `title` 显示全量；同时 `item.title = t.id`（整项悬停可见）。
   CSS 新增 `.tag.idchip`（等宽字体）。
2. **新增 `copyText(text, done)` 助手**：优先 `navigator.clipboard.writeText`，
   **降级 `document.execCommand('copy')`**——手机经 **局域网 IP** 访问时不是安全上下文，
   clipboard API 会不可用，必须留兜底。
3. 备份：两处均留 `index.html.bak-20260925-show-id`。

## 3. 验证结论

```sh
# ① 内联 script 语法（单块 15473 字符）
python3 抽取 <script> → node --check           # 通过

# ② 补丁落地
grep -n 'idchip|copyText|item.title = t.id'    # CSS:77 / 渲染:243-254 / 助手:377

# ③ 服务端是否已吐新版（关键：决定要不要重启）
curl -sS -H "x-bridge-token: $TK" http://127.0.0.1:3095/ | grep -c idchip   # → 2
sed -n '412,415p' /root/proj/web-bridge/server.mjs                          # await readFile(PAGE) + no-store
```

**③ 的结论很重要**：`server.mjs` 是**每请求读盘**且带 `cache-control: no-store`，
所以**只需刷新页面**即生效 —— **不要**为了这个去 `ctl.sh restart`（那会踢掉挂着的终端 TUI）。

## 4. 回滚

```sh
cd /root/proj
cp web-bridge/public/index.html.bak-20260925-show-id                    web-bridge/public/index.html
cp second-engine-bridge/bridge/public/index.html.bak-20260925-show-id   second-engine-bridge/bridge/public/index.html
# 刷新网页即可（服务端每请求读盘，无需重启）
```

## 5. 已知问题 / 待办

- [ ] **409 提示不说是哪个终端**：现在只说「先退出那个终端」，用户无从下手。
      建议在报错里带上持有者的 **PID + cmdline**（扫 `/proc/*/fd` 或 `lsof`，**避开 `pgrep -f`**）。
      这是本次死锁里用户真正卡住的地方。
- [ ] **桥侧无"强制释放/接管"路径**。若要加，必须先 `flock -n` 探测确认无活进程持有，
      再动/删锁文件；否则会把正在写的会话写坏。
- [ ] `busy` 状态与真实锁状态可能不一致（桥报 `busy:false` 但锁被外人持有），
      前端提示文案可据此区分「桥忙」与「被外部写者占用」。

---

# 2026-09-23 — 终端新会话自动同步到网页

> 目标：在终端用 `codex-env` 开的新会话，能**立刻**出现在浏览器网页（3095）的会话列表里并可直接接管。
> 以前必须先在终端"说第一句"，网页才看得见它。

## 1. 问题与根因

**现象**：终端 `codex-env` 新开的会话，网页列表里没有；要先在终端发一条消息，之后才挂得上。

**根因（实测确认）**：codex **只在跑完第一条消息时才写 `~/.codex/sessions/…/rollout-*.jsonl`**。在那之前：

| 调用 | 未落盘会话时的结果 |
|---|---|
| `thread/list` | 看不见它 |
| `thread/resume` | `no rollout found for thread id …` |
| `codex resume <id>` | `No saved session found` |
| `codex --remote <url> <id>` | **能挂上**（走的是另一条路） |

所以网页桥（靠 `thread/list`）和 `thread/resume` 都摸不到它 → 只能等它落盘。

## 2. 关键协议发现（都实测验证过）

- `thread/loaded/list` → 返回**纯 id 数组**（`{"data":[id,...]}`），**包含 owner 内存里还没落盘的会话**。这是本功能的基石。
- `thread/start` → 返回完整对象，含官方 `path`（rollout 路径）、`cwd`、`createdAt`（UUIDv7 内嵌时间）。
- `thread/read` → 对**未落盘**会话可用（metadata 级）；`includeTurns` 可能失败 → 已做容错回退。
- `thread/items/list` → 对未落盘会话报 `not supported yet` → 已容错成"空转录"。
- `thread/resume` **同时是订阅动作**：跳过它直接 `turn/start` 虽能跑，但**收不到任何通知**（无 `item/agentMessage/delta`、无 `turn/completed`）→ 网页永久挂"运行中"。**已回滚该"优化"。**
- 空 input 的 `turn/start` 会**真的调用模型**（花钱、留垃圾回合）→ **不能**用它逼落盘。
- 自己给官方 `path` 补最小 `session_meta` → `thread/read` 能用但 `thread/list` 不可见，owner 之后还会追加自己的 meta（2 条 meta）→ 放弃此路。
- owner 对建在它上面的会话**一律报 `originator="web-bridge"`** → 分不出是谁开的 → 桥自己加一份归属账本。
- `thread/start` 的 `cwd` 协议层有效，但 **TUI 走 `--remote` 建会话时不传 cwd** → owner 用自己的 cwd（`/root/proj`）。
- 未落盘会话**无法删除**（`thread/delete` 报 `no rollout found`）→ 会残留在列表，已知小瑕疵。

## 3. 代码改动（按文件）

### 3.1 `web-bridge/server.mjs`
备份：`web-bridge/server.mjs.bak-20260923-web-sync`

- 新增 `loadedThreadIds()`：调 `thread/loaded/list` 取 id 集合（失败返回空集）。
- 新增 `threadRow(t, { pending })`：统一 thread → 列表项；`source` 改由账本决定。
- 新增**归属账本**：`OWN_FILE=.bridge-owns.json` + 内存 `owned` Map + `ownThread(id)`
  （只保留 7 天，500ms 防抖写盘）；桥自己 `thread/start` 时调 `ownThread`。
- `/api/threads`：合并 `thread/list` + `thread/loaded/list`（未落盘的补进列表，
  标题「（新会话 · 还没开始）」，`pending:true`），按 `updatedAt` 倒序。
- `/api/transcript`、`/api/stamp`：未落盘会话容错（空转录 / metadata 级读）。
- `handleSend`：**保留** `thread/resume`（订阅不可省，见 §2）；错误文案区分
  `no rollout found` → "还没有落盘…去终端里说一句"。
- 删除死代码 `isReallyBusy`（定义存在但无调用者）。

### 3.2 `web-bridge/public/index.html`
备份：`web-bridge/public/index.html.bak-20260923-web-sync`

- CSS 加 `.tag.new`。
- 列表项渲染 `t.pending` → 显示「未开始」标签。
- `openThread`：pending 会话给提示
  "它还没落盘，网页暂时接管不了。去终端里说一句…"。
- 轮询：`if (document.visibilityState !== 'visible' || controller) return;`
  之后 `if (threadId) syncNow(true); loadThreads();`（页面可见时才轮）。

### 3.3 `web-bridge/selftest.mjs`
- 体检新增 `thread/loaded/list` 项 + 对应 `hints` 文案（已同步到包内）。

### 3.4 `/usr/local/bin/codex-env`
备份：`/usr/local/bin/codex-env.bak-20260923-web-sync`

- 新增 `-s|--solo`：开**独立**新会话（老行为）。
- **默认路径改为** `exec codex --remote "$AS_URL"`：在 owner 上开共享会话（终端 + 网页共享）。
- **cwd 守卫**：读 `/api/health` 的 `workdir`，与 `$PWD` 不一致时自动退回独立会话并提示
  （已实测生效）。
- help 文本全面更新；提示语改为
  "默认就在它上面开新会话（终端 + 网页共享）；只想自己用加 `-s`"。

### 3.5 `README.md`
- 「聊天桥 v2」节下新增子节 **「终端新会话自动同步到网页（2026-09-23 加）」**
  （含根因、边界 6 条、"为什么不做跳过 resume"）。
- 工具表：`codex-env` 拆成三行（默认 / `-a` / `-s`）。

### 3.6 `second-engine-bridge/`（可搬运包，已同步）
- `bridge/server.mjs`：同样的补丁（包内 `WORKDIR` 用 `os.homedir()`，无硬编码）。
- `bridge/public/index.html`：直接从 web-bridge 拷贝。
- `bridge/selftest.mjs`：已同步。
- `bin/codex-env`：可搬运版（用 `BRIDGE_DIR` / `CODEX_KEYRING` / `SECOND_ENGINE_WORKDIR`
  环境变量），已移植同样逻辑。
- `install.sh`：末尾提示行改为
  `codex-env # 终端开新会话（默认就挂到同一批会话上，网页里立刻可见）`。

## 4. 涉及的命令

### 4.1 操作/验证桥
```bash
cd /root/proj/web-bridge
./ctl.sh check                      # 全绿（含新增 thread/loaded/list 项）
./ctl.sh reload-web                 # 只重载网页进程，不踢终端 TUI
./ctl.sh threads 10                 # 列会话（终端侧）

TOKEN=$(cat .token)
curl -s http://127.0.0.1:3095/api/health            -H "x-bridge-token: $TOKEN"
curl -s "http://127.0.0.1:3095/api/threads?limit=6" -H "x-bridge-token: $TOKEN"

# 网页发消息看流（已落盘会话 → 应有 {"kind":"text"...} + {"kind":"done"}）：
curl -sN -X POST http://127.0.0.1:3095/api/send \
  -H "x-bridge-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"threadId":"<id>","text":"只回复两个字母：ok"}'
```

### 4.2 直接问 owner：内存里的会话（含未落盘）
```bash
node -e 'const ws=new WebSocket("ws://127.0.0.1:3096");let i=0;const p=new Map();
const c=(m,q={})=>new Promise((r,j)=>{const d=++i;p.set(d,{r,j});
ws.send(JSON.stringify({id:d,method:m,params:q})+"\n")});
ws.onmessage=e=>{for(const l of String(e.data).split("\n")){if(!l.trim())continue;
const o=JSON.parse(l);const h=p.get(o.id);if(h){p.delete(o.id);
o.error?h.j(new Error(o.error.message)):h.r(o.result)}}};
ws.onopen=async()=>{await c("initialize",{clientInfo:{name:"probe",version:"1"}});
const r=await c("thread/loaded/list",{});console.log(JSON.stringify(r));process.exit(0)}'
```

### 4.3 终端行为验证
```bash
codex-env                      # 默认：owner 上开新会话，网页 5 秒内出现「未开始」
codex-env -s                   # 独立会话（网页看不见）
codex-env -a                   # 挂 owner，弹选择器
codex-env -a <id>              # 挂 owner 并直接打开
codex-env /root/proj/se-verify # 目录与 owner 不一致 → 自动退回独立会话并提示
```

### 4.4 打包副本安装（幂等）
```bash
cd /root/proj/second-engine-bridge && ./install.sh --dry-run --with-codex-env
```

### 4.5 浏览器真机验证（用完**必须** stop）
```bash
cd /root/proj
./dsh-browser.sh start
./dsh-browser.sh nav "http://127.0.0.1:3095/?t=$(cat web-bridge/.token)"
./dsh-browser.sh eval 'document.getElementById("menu").click(); document.getElementById("tlist").innerText.includes("未开始") ? "有 ✅" : "没有 ❌"'
./dsh-browser.sh stop
```

## 5. 验证结论

- `ctl.sh check` 全绿（含 `thread/loaded/list`）。
- 修回 `thread/resume` 后，网页发消息能收到**流式 + done**，`busy:false`。
- 浏览器页面确认列表出现**「未开始」**标签。
- cwd 守卫实测生效。

## 6. 回滚

```bash
cd /root/proj/web-bridge
cp server.mjs.bak-20260923-web-sync            server.mjs
cp public/index.html.bak-20260923-web-sync     public/index.html
cp /usr/local/bin/codex-env.bak-20260923-web-sync /usr/local/bin/codex-env
./ctl.sh reload-web
```
（更早的 exec 版备份：`server.exec.mjs.bak-*`、`ctl.exec.sh.bak-*`，见下一节。）

## 7. 已知问题 / 待办

- **残留会话**：测试残留 `01a0cc7c-0d9e-7100-b4d2-87156d198cb3`（未落盘，删不掉），
  会一直以「未开始」留在列表里。
- **终端跑着时网页被 409 挡**：可接
  `codex queue --thread <id> --message <text>`（写 `~/.codex/queue_1.sqlite`）让网页也能发。
  **桥尚未接**，是明确的下一步。
- **token 建议轮换**：本次对话中曾把 `web-bridge/.token` 打成明文。
  轮换方式：停桥 → 删 `.token` → 重启。
- 测试脚本散落在 `/tmp`：`rd.mjs`、`mk.mjs`、`loaded.mjs`、`probe*.mjs`、`patch*.py`、
  `fe.js`、`stream2.txt` 等，可清理。

---

# 2026-09-22 — exec 版 → app-server 版（v2）

## 一句话总结

把浏览器聊天桥从「每回合 spawn 一个 `codex exec resume`」改成
「一个常驻 `codex app-server` 当唯一会话所有者 + 多个客户端」。
锁只在所有者手里，网页和终端不再互抢；终端用 `codex-env -a` 挂上去就能两边同时发。

顺带升级：真流式（`item/agentMessage/delta`）、token 用量、`turn/interrupt` 中断、
归档/删除走协议（不再 spawn 命令）、新增 `./ctl.sh check` 自检。

## 用户要的是什么

「像 DSH 的 app UI 和 web UI 那样：**不论哪边打字，另一边的界面上也能看到**；两边同时发不互斥。」

## 为什么 codex 原来做不到

codex CLI 的模型是「一个进程 = 一个会话写者」，靠 `~/.codex/thread-writer-locks/<id>.lock` 的文件锁独占。
旧桥每回合 spawn 一个 `codex exec resume`，等于每回合抢一次锁 →
网页在跑时终端续不上、终端开着时网页发不出（报 `thread … already has an active writer`）。

## 关键结论：不用改 codex，官方自带同等架构

`codex app-server`（0.155.1 内置，标着 `[experimental]`）可以当**唯一所有者**：

| 官方能力 | 用途 |
|---|---|
| `codex app-server --listen ws://127.0.0.1:3096` | 所有者；同一端口还提供 `/readyz` `/healthz` |
| `codex resume --remote ws://…` / `codex --remote ws://…` | 让终端 TUI 作为**客户端**挂上去 |
| `codex agents` | 浏览共享所有者上的全部会话（TUI） |
| `codex queue --thread <id> --message <text>` | 给进行中的会话排队投递（`~/.codex/queue_1.sqlite`） |

**多客户端 + 推送已实测**：A（网页桥）在跑一轮时，B 客户端 `thread/resume` 同一会话成功
（`status={"type":"active"}`），并收到 159 个 `item/agentMessage/delta`，拼出完整回答。

## 改了哪些文件（都带备份）

| 文件 | 改了什么 | 备份 |
|---|---|---|
| `/root/proj/web-bridge/server.mjs` | 重写：改走 app-server 协议 | 同目录 `server.exec.mjs.bak-20260922-1433` |
| `/root/proj/web-bridge/ctl.sh` | 重写：管两个进程 + `check`/`as-url`/`restart` | 同目录 `ctl.exec.sh.bak-20260922-1433` |
| `/root/proj/web-bridge/as-client.mjs` | 新增：app-server 的 WebSocket/JSONL 客户端 | — |
| `/root/proj/web-bridge/selftest.mjs` | 新增：体检 | — |
| `/usr/local/bin/codex-env` | 加 `-a [会话id]` + 所有者在线提示 | `/usr/local/bin/codex-env.bak-v2-20260922` |
| `/root/proj/web-bridge/history.mjs` | 未改，已不再被引用（留作降级路径） | — |
| `/root/proj/README.md` | 工具表 + 「聊天桥 v2」章节 | — |
| `/root/proj/共同工作区/会话同步与终端切换-分析.md` | 新增第六节：改造结果与实测证据 | — |
| `/root/proj/second-engine-bridge/` | 本目录：可搬运副本（给 DSH 插件用） | — |

完全没动：codex 二进制、`~/.codex/config.toml`、`~/.codex/keyring.json`、
任何 DSH 包（`/usr/local/lib/node_modules/@deepseek-ai/*`）。

## 实测证据

| 项 | 结果 |
|---|---|
| 真流式 | `POST /api/send` → `meta` + 5 段 `text` + `end{output_tokens:6}` + `done{ok:true,ms:2697}` |
| 两边同时在线 | 见上（159 增量）；旧架构此处必然报 active writer |
| 转录 | 长会话读到 386 条（me/ai/act/note），比按 rollout 解析的 72 条更全 |
| stamp | 连读两次恒定，可安全 5 秒轮询 |
| 中断/归档/删除 | `stop` → `{ok,stopped:true}`；归档删除 → `{ok:true}` |
| 自检 | `./ctl.sh check` 四项全绿 |

## 怎么恢复（回到 exec 版）

```bash
cd /root/proj/web-bridge
./ctl.sh stop
cp server.exec.mjs.bak-20260922-1433 server.mjs
cp ctl.exec.sh.bak-20260922-1433 ctl.sh && chmod +x ctl.sh
cp /usr/local/bin/codex-env.bak-v2-20260922 /usr/local/bin/codex-env
chmod +x /usr/local/bin/codex-env
./ctl.sh start
./ctl.sh status
```

恢复后的注意点：

- exec 版 `ctl.sh` 不认 `as-url` / `check`，所以 `codex-env -a` 会失效（提示没有所有者），这是预期的。
- `as-client.mjs` / `selftest.mjs` 变成无用文件，留着不碍事。

## 验证恢复成功

```bash
cd /root/proj/web-bridge && ./ctl.sh start
curl -s 127.0.0.1:3095/api/health     # exec 版：JSON 里没有 appServer 字段
cd /root/proj && codex-env            # TUI 正常起来
```

## 运行时状态（不用恢复，删了会自己重建）

| 文件 | 说明 |
|---|---|
| `.token` | 鉴权 token；删掉 → 下次启动随机重建 → 网址会变 |
| `.pid` / `.as.pid` | 两个进程的 pid |
| `as-server.log` / `bridge.log` | 日志（含带 token 的网址，权限 0600） |
| `~/.codex/thread-writer-locks/*.lock` | 写锁文件，持有者退出后自动释放 |

## 想彻底不要它了

```bash
/root/proj/web-bridge/ctl.sh stop
# 再把 /root/proj/web-bridge 整个目录移走即可
# 没有在别处注册任何东西：不写 config.toml、不加开机自启、不进 DSH 包树
```

## 当时列的下一步（做完的打勾，其余见 2026-09-23 节）

1. 网页 `/api/stamp` 轮询 → **SSE 实时推送**（桥已在收通知，加一条 `/api/events` 即可），做到 DSH 那种即时。
2. 去掉前端 localStorage 的本地历史，改成"以会话为唯一真源"。
3. 协议自动适配：方法不存在时降级读 rollout 文件（`history.mjs` 就是这个备份）。
4. 打包成 Codex 插件（`skills` + `scripts`）：注意本机校验器**拒绝 `hooks` 字段**，插件无法自动拉后台进程。

> 依赖的官方接口清单（`[experimental]`，升级 codex 时对照的那张表）已移到 `README.md` 的「升级 codex 之后」。
