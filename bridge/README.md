# 第二引擎 · 浏览器聊天桥（app-server 版）

**一句话**：在手机浏览器里用输入法跟 Codex 说话。终端和网页连的是**同一个会话所有者**，
所以两边可以同时在线、同时发，不会再出现「一边占用、另一边发不出」。

这个目录是**可搬运副本**（不是运行实例）。装到哪、用什么端口、工作目录在哪，全走环境变量。

> **插件内路径映射（2026-09-30 收编）**：本文件描述的是「可搬运副本」布局；在 second-engine 插件里，`ctl.sh` / `server.mjs` / `as-client.mjs` / `selftest.mjs` / `public/` 位于 `bridge/web/`，`bin/codex-env` 对应 `bridge/web/codex-env`；`install.sh` / `env.example` / `CHANGELOG.md` 与本文件同在 `bridge/`。

> 改动史、逐文件清单、备份文件名、回滚与验证步骤 → 同目录 `CHANGELOG.md`。
> 本文件只讲**怎么装、怎么用、怎么接**。

## 为什么是这个架构

codex CLI 的模型是「一个进程 = 一个会话写者」，靠 `~/.codex/thread-writer-locks/<id>.lock` 文件锁独占。
旧桥每回合 spawn 一个 `codex exec resume`，等于每回合抢一次锁 → 网页在跑时终端续不上、
终端开着时网页发不出（`thread … already has an active writer`）。

官方自带同等架构，**不用改 codex**：`codex app-server`（0.155.1 内置，`[experimental]`）当唯一所有者，
网页和终端都只是它的客户端。（推导过程与实测证据见 `CHANGELOG.md` §2026-09-22。）

## 组成

```
codex app-server --listen ws://127.0.0.1:$BRIDGE_AS_PORT   ← 唯一所有者（会话写锁只在它手里）
        ├── node server.mjs  :$BRIDGE_PORT                 ← 网页（HTTP + token + NDJSON 流）
        └── codex resume --remote ws://…                   ← 终端 TUI（bin/codex-env -a）
```

| 文件 | 作用 |
|---|---|
| `bridge/ctl.sh` | 管两个进程：`start` / `stop` / `restart` / `status` / `url` / `as-url` / `check` / `logs` |
| `bridge/server.mjs` | 网页侧：HTTP 路由、token 鉴权、把 app-server 的推送转成前端要的 NDJSON |
| `bridge/as-client.mjs` | app-server 客户端：WebSocket + JSONL 的 JSON-RPC，自动重连 |
| `bridge/selftest.mjs` | 体检：codex / 所有者 / 协议方法 / 网页 |
| `bridge/public/index.html` | 前端单页（自包含）：会话列表抽屉 + **搜索（Ctrl+K）**、**会话 ID 芯片（点击复制完整 ID）**、归档/删除、**深浅主题切换**（浅色默认）、被占用时显示写锁持有者 |
| `bin/codex-env` | 启动器：注入 key 进 TUI；默认挂到所有者上共享会话 |
| `install.sh` | 幂等安装器（`--dry-run`、`--with-codex-env`） |
| `env.example` | 全部环境变量 |
| `CHANGELOG.md` | 改动记录 + 回滚手册（时间倒序） |

## 依赖

- `codex` 在 PATH（可用 `CODEX_BIN` 指定绝对路径）
- `node` ≥ 22（用了全局 `WebSocket`）
- `python3`（只用来从 keyring 读 key）
- key 来源：`$CODEX_KEYRING`（默认 `~/.codex/keyring.json`，DSH 托管）

## 安装与使用

```bash
./install.sh --dry-run                     # 先看要做什么
./install.sh --with-codex-env              # 装到 $HOME/.local/share/second-engine-bridge + 启动器
cd $HOME/.local/share/second-engine-bridge
./ctl.sh start        # 起所有者 + 网页
./ctl.sh url          # 打印手机浏览器可直接打开的网址（含 token）
./ctl.sh check        # 体检
codex-env             # 终端也挂到同一批会话上（默认行为）
```

## 启动姿势速查

### 一、网页侧（服务）

| 命令 | 作用 |
|---|---|
| `./ctl.sh start` | 拉起所有者 + 网页（幂等，已在跑就跳过） |
| `./ctl.sh url` | 打印**手机浏览器要打开的网址**（含 token，token 首启随机生成） |
| `./ctl.sh status` | 看两个进程 + 健康 |
| `./ctl.sh check` | 体检：codex / 所有者 / 协议 / 网页 |
| `./ctl.sh threads [N]` | 列出最近 N 条会话（拿 id 用） |
| `./ctl.sh reload-web` | 只重载网页进程，**不踢**挂着的终端 TUI |
| `./ctl.sh logs` | 两个日志的尾巴 |
| `./ctl.sh restart` | 重启（⚠ 会踢掉挂着的终端 TUI） |
| `./ctl.sh stop` | 两个都停 |

### 二、终端侧（推荐用启动器 `bin/codex-env`）

| 命令 | 效果 | 和网页共享会话？ |
|---|---|---|
| `codex-env` | **默认**：在所有者上开新会话 | ✓ 网页列表 5 秒内出现它，标「未开始」 |
| `codex-env -a` | 挂到所有者，弹会话选择器 | ✓ 两边同时在线、同时发 |
| `codex-env -a <会话id>` | 挂上去并**直接打开指定会话**（如 `-a 01a0c942-…`） | ✓ |
| `codex-env -s` | 开一个**独立**新会话（老行为） | ✗（自成一套，网页看不到） |
| `codex-env -r` | 续**独立**的最近一条（`codex resume --last`） | ✗ |
| `codex-env /别的/目录` | 在指定目录开新会话；目录与所有者不一致时**自动退回独立会话**并提示 | ✗ |
| `codex-env -h` | 在终端里直接打印这份用法（不用翻 README） | — |

> 想让网页和终端**看到同一段话**，两边都得挂在所有者上：终端用默认或 `-a`，网页就是 `./ctl.sh url` 打开的页面。
> 共享会话的工作目录由**所有者**决定（TUI 走 `--remote` 建会话时不带 cwd），所以目录不一致会退回独立会话。

### 三、终端侧（不用启动器，原生 codex 命令）

```bash
# 所有者地址：./ctl.sh as-url   →  ws://127.0.0.1:3096
codex --remote ws://127.0.0.1:3096                      # 挂上去开新会话
codex resume --remote ws://127.0.0.1:3096               # 挂上去 + 会话选择器
codex resume --remote ws://127.0.0.1:3096 <会话id>      # 挂上去 + 直接打开
codex agents                                            # 浏览所有者上的全部会话（需真终端）
codex queue --thread <会话id> --message "一句话"        # 往进行中的会话排队投一句
```

### 四、怎么拿会话 id

```bash
./ctl.sh threads        # 默认 12 条：id / 时间 / 来源 / 是否运行中 / 标题
./ctl.sh threads 30     # 多看几条
```

（或打开网页，点左上 `☰` 看列表。）

## 常见问题

| 现象 | 原因 / 怎么办 |
|---|---|
| 网页打不开，或网址里的 token 失效 | `.token` 被删/换了机器 → `./ctl.sh url` 取新网址 |
| 终端报 `app-server session could not be restored` | 所有者重启过，挂着的 TUI 无法自动恢复 → 重新 `codex-env -a` |
| 网页切后台/锁屏后消息像"断"了 | 老版本会在网页断开时**中断**这一轮；现在改成**继续跑**，重开页面 5 秒内看到结果 |
| 消息发到了新会话 | 网页当时没选中会话（刚刷新过）→ 先在 `☰` 里点目标会话再发 |
| 列表里有一条会话标着「未开始」 | 终端刚开的会话还没落盘（codex 只在跑完第一条消息时才写 rollout）→ 在终端说一句它就落盘 |
| 网页打开「未开始」的会话发不出第一句 | 未落盘的会话没法 `thread/resume`（订阅动作）→ 去终端说一句，之后两边随便发 |
| 终端正在跑一轮时，网页发被 409 挡 | 一条会话同一时刻只能跑一轮。`codex queue --thread <id> --message …` 可排队投递（**桥还没接**） |
| 升级 codex 后不好使 | 先 `./ctl.sh check`，按本文「升级 codex 之后」那张接口表对一遍 |

## 已知限制

- **未落盘的会话，网页接管不了第一句**：`thread/resume` 是订阅动作，未落盘必然失败（跳过它又收不到任何通知）。
- **所有者一重启**：挂在它上面的终端 TUI 会掉线（`app-server session could not be restored`），需重新 `codex-env -a`；
  同时"还没说过话"的会话会丢（反正也没内容），内存里放久了所有者也会卸载它。
- **一条会话同一时刻只能跑一轮**：终端在跑时网页发会被 409 挡，桥还没接 `codex queue`。
  桥里残留的"已断开但没结束"条目会在下次发时自愈，实在不行 `./ctl.sh reload-web`。
- **未落盘会话无法删除**（`thread/delete` 报 `no rollout found`）→ 会以「未开始」一直留在列表里。
- **网页是 5 秒轮询**（用户接受）；桥其实已经在收推送，只是没往浏览器推。
- **区分「网页开的」/「终端开的」靠桥自己的账本** `web-bridge/.bridge-owns.json`（只留一周）——
  所有者对建在它上面的会话一律报 `originator=web-bridge`，分不出来。
- **依赖的官方接口都标 `[experimental]`**（见下）。

## 环境变量

见 `env.example`。要点：端口（`BRIDGE_PORT` / `BRIDGE_AS_PORT`）、工作目录（`BRIDGE_WORKDIR`）、
keyring 路径（`BRIDGE_KEYRING`）、codex 路径（`CODEX_BIN`）——**没有一个是写死的**。

## 安全

- 只绑 `127.0.0.1`（所有者与网页都是），外部访问不了。
- Host 头白名单（防 DNS rebinding）+ token 鉴权。
- **token 不是硬编码**：首次启动 `randomBytes(24)` 随机生成，存 `.token`（0600）；
  源码里没有任何写死的 token。`bridge.log` 里会带上含 token 的网址（该日志同样 0600）。
- 桥只通过协议读写会话，不直接改 codex 的会话文件。

## 给「第二引擎」DSH 插件的接入清单

**要打包进插件的**：`bridge/{server.mjs,as-client.mjs,selftest.mjs,ctl.sh,public/index.html}` + `bin/codex-env`

**不要打包**：`.token`、`.pid`、`.as.pid`、`*.log`、`.bridge-owns.json`、任何 `secrets/`

**插件只需要四个入口**（其它什么都别硬编码，四个都幂等）：

| 需求 | 命令 |
|---|---|
| 拉起 | `ctl.sh start`（幂等，已在跑就跳过） |
| 停止 | `ctl.sh stop` |
| 取网址给用户 | `ctl.sh url` |
| 取 ws 地址（给终端挂载用） | `ctl.sh as-url` |

其它约定：

- **环境变量注入，别硬编码**：`BRIDGE_WORKDIR`、`BRIDGE_PORT`、`BRIDGE_AS_PORT`、`BRIDGE_KEYRING`、`CODEX_BIN`。
- **不要缓存 token**：要网址就每次 `ctl.sh url` 取（token 首启随机生成，存 `.token` 0600）。
- **生命周期**：DSH 客户端退到后台约 30 秒会被系统回收，proot 里所有进程一起没 → 下次 `ctl.sh start`
  会重建；`.token` 会复用，所以网址不变。
- **别碰**：`~/.codex/config.toml`、`~/.codex/keyring.json`、DSH 包树（`/usr/local/lib/node_modules/@deepseek-ai/*`）。

**状态文件**：`.token`（鉴权，重建会变网址）、`.pid` / `.as.pid`（进程）、
`.bridge-owns.json`（会话归属账本，7 天）、`as-server.log` / `bridge.log`（日志）

## 升级 codex 之后

依赖的官方能力全标着 `[experimental]`，升级后先跑 `./ctl.sh check`（分别报 codex / 所有者 / 协议方法 / 网页四项，
能直接分清是"没起服务"还是"协议变了"），再照下面这张表对方法名/参数：

```bash
codex app-server --listen ws://127.0.0.1:PORT     # 所有者；同端口还有 /readyz /healthz
codex resume --remote ws://…  /  codex --remote ws://…
codex agents                                        # TUI 浏览全部会话
codex queue --thread <id> --message <text>          # 排队投递（~/.codex/queue_1.sqlite）
```

- 方法：`initialize`、`thread/list`、`thread/loaded/list`、`thread/items/list`、`thread/read`、
  `thread/start`、`thread/resume`、`thread/archive`、`thread/delete`、`turn/start`、`turn/interrupt`
- 通知：`item/agentMessage/delta`、`item/started`、`turn/started`、`turn/completed`、
  `thread/tokenUsage/updated`、`error`
- 已知边界：`thread/items/list` 对**未落盘**会话报 `not supported yet`（桥已容错成空转录）；
  `thread/loaded/list` 返回纯 id 数组（含未落盘）。

哪项红就改 `bridge/server.mjs` 里对应的方法名或参数。

（更老的实现——直接读 `~/.codex/sessions/*.jsonl` 的 `history.mjs`——留在运行目录里，
真遇到协议大改时可当降级路径；它对应 exec 版，见 `CHANGELOG.md`。）
