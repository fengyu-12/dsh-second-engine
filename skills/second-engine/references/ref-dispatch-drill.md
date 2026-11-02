# ref-dispatch-drill：派单核对纪律 · 执行通道 · 降级 · 唤醒

> 2026-11-03 从 SKILL.md 外置。正文留判据指针，细节读本文件。

## 3.3 派单与核对纪律（从多次误判提炼，只记判据不记过程）

- **派单前逐条复核自己的缺陷描述**。任务单里每条缺陷 = **一条断言**（`文件:行号` + 当前行为），派单前用 `grep` / `sed -n` 实测一遍，与描述不符就**改描述**，不许凭印象写。2026-10-29 两连击实证：① 把活的 `createPiCards`/`PiCleanupCard` 写成死代码（只 `grep -c` 数出现次数、没查调用点），对方核实后才没把 Pi 面板搞崩；② 写「引擎未知时放行」，实际 `activeEngineId()` 读不到就 `return 'codex'`（`registry.js:82-88`）、**永不返回空串**——半句既错又是死代码。**同一类错误两天犯两次，说明缺的是检查点不是态度**。判据：单子里凡是能被一条命令验证的描述，落笔前必须已经跑过那条命令。
- **workdir 里不能放同名过期副本**。模型会诚实去读 workdir 里能找到的那份，给出「对那份完全正确、对真身全错」的答案。派单前 `find <workdir> -name index.js` 查一遍；发现副本就挪走或改名。
- **核对它给的行号，先确认为它读的是哪份文件**。拿 A 的行号去比 B，会得出「它在编」的错误结论——实际它读的是旧快照且 6/6 命中。**先问"你读的哪个路径"，再判对错。**
- **要它精确改代码，路径写到文件级**：`<插件目录>/src/index.js`，别只给 workdir。
- **采纳它提出的新名词前先 `grep -c`**。合同里塞进 `queued`/`finalizing` 两个状态，代码里 0 命中——凭空放大改造面。**新名词先验证存在性**。
- **改「取消 / 终局」这类语义，先把所有写点找齐**。exec 走 `child.on('exit')`、appserver 走 `handle.done` reject；只改一条路径等于没改，且要等真实取消才暴露。
- **删一个副作用前，查它还兼管什么**。`utimesSync(outPath)` 同时喂看门狗和污染 `cleanupLiveFiles` 的 mtime 判据——删掉解耦了两件事，也顺带改了清理行为（这是好事，但要知道）。
- **同一块 UI 可能有两套判据**。面板标题走 `taskStateText()`（认 `cancelled`），同卡片的 `status` 变量白名单只有 `done|error` → 出现「已取消 + 运行中」并存。改状态语义时扫全部判据，不只看一处。
- **可执行产物：验输出不验跑通，有偏差就修不补偿**。① 它交的脚本 `ok:true` + 自检通过 ≠ 可用 —— 先问「自检覆盖了我依赖的那个量吗」；② 判据三选一：给行号就 `grep -n` 核 3 个、给计数就 `grep -c`/`wc -l` 核总数、给边界就用极值用例戳；③ **出现任何「调用侧补偿」＝ 工具坏了**：修掉它或标「不可用于不可逆场景」，不许靠用法上的 `-1` 顶过去。
- **`grep task\.<字段>` 这类归零判据看不见对象字面量里的裸字段**（`const task = { ..., child, ... }`）。改字段归属时必须对着**每条创建路径**逐个确认（本项目三条：appserver / exec / review）；否则会出现「grep 已归零、运行时却拿不到值」——2026-10-28 就这么漏了 exec 的 child，导致取消杀不死进程、`endedAt` 永不落定，而冒烟 32 项全绿。


## 3.7 执行模式：exec / appserver（运行时切换、不需要重启）

- **exec**（默认）：`codex exec` 一次性子进程，行为与旧版一致。
- **appserver**：`codex app-server` JSON-RPC 长连接——`GET /api/task?id=` 多 `progress` 字段（最近 20 条归一化事件，可看流式进度）；`POST /api/task/cancel` 先发 `turn/interrupt`（65ms 级结束）。输出仍落 `-o` 文件，看门狗判据不变，任何事件都刷新输出 mtime。
- **复核恒走 exec，不支持 appserver**（2026-10-25 定）。

```sh
echo appserver > ~/.dsh/second-engine-mode.txt   # 切 app-server
echo exec      > ~/.dsh/second-engine-mode.txt   # 切回
```
优先级：env `SECOND_ENGINE_EXEC_MODE` > 模式文件 > 默认 `exec`。验收：`bash ~/.dsh/scripts/dsh/se-appserver-verify.sh`（流式进度 / 打断 / exec 回归三条判据）。appserver 协议映射见 `<DSH 技能目录>/skills/second-engine/references/ref-codex-facts.md`。


## 3.8 命令行降级（无插件环境 / 需要交互时）

```bash
codex-env          # 插件提供：自动注入激活提供方 key → 进 TUI（Ctrl+D 或 /quit 退出）
# 手动（⚠️ 别写成 VAR=key cmd，会进 argv 被 ps 看到）：
KEY=$(head -1 "<DSH 技能目录>/中转站/当前生效API.txt"); cd ~/proj && env PROVIDER_API_KEY="$KEY" codex exec --skip-git-repo-check -o /tmp/out.txt "工单"
```
- 长线程需 resume 时不加 `--ephemeral`（完整 36 位 UUID）；结构化收结果用 `-o <文件>` 或 `--json`。


## 3.9 唤醒层：把消息递进 DSH 会话（实验端点，2026-10-30 实测通过）

`POST /second-engine/api/_exp/wake` `{sessionId, text?, provider?, model?}` —— 拿 DSH 会话对象后 `session.append()` + `agents.resume()` 把消息递进去。**三条实测约束**：① `sessionId` 必须 `session-<uuid>` **带前缀**，裸 uuid 报 `session not found`；② `agentOptions` 只能用 **DSH 侧** provider（如 `deepseek-account`），Codex keyring 的 `ziluo` 会 `NO_ADAPTER`（跨引擎 provider id 不通用）；③ 对**正在跑的会话**发 followup 会**打断它当前回合**（我自己被测试打断过一次）。

### 怎么找到"另一个会话"并把消息投进去（2026-11-03 实测，补 3.9 缺的操作段）

```bash
# 1) 会话按 cwd 分区存放，目录名就是 sessionId（带 session- 前缀）
ls -lat ~/.dsh/sessions/--root-Documents-deepseek-harness-default-workspace--/ | head
# 2) 投一条消息（模拟真实用户发言；text 会被当成 user 消息追加）
curl -s -X POST "$DSH_WEB_URL/second-engine/api/_exp/wake" -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-<uuid>","text":"<要说的话>"}'
# 3) 读它怎么反应：会话文件是 zstd 压缩的 jsonl
zstd -dc ~/.dsh/sessions/<分区>/<sessionId>/session.v4.jsonl.zstd > /tmp/s.jsonl
```

- 返回 `{"ok":true,"live":true}` = 已投递；`live:false` 看 `resumed` 字段。
- **轨迹里 `assistant/message` 的 `content[].type=="reasoning"` 就是它的思维链原文** —— 判断"它有没有想到某件事"只能看这个，不能看正文措辞。
- 会话目录只有 `session.lock` + `session.v4.jsonl.zstd` 两个文件，按 cwd 转义分区。
- 验证注入类实验时：① 先确认开关 `~/.dsh/second-engine/hint-toggles.json`（`vocabulary`/`interruption`/`mechanical` 默认全 false）；② **投递后先数 `source.kind=='mood-watch'` 的事件有没有新增**，没有新增就是被冷却吞了（设置页「纠正检测」写明：同一轮最多一次、90 秒冷却），**此时读 reasoning 得出的任何结论都无效**——跳过这一步就会把「没注入」误判成「文案无效」（2026-11-03 踩过：两次投递间隔 41 秒，第二次没注入，却据此宣布文案对模糊场景失效）。

---

## 提醒通道（编排开始前问偏好 · 2026-11-02 实测矩阵）

**编排一旦开始，主 AI 会长时间在后台跑，用户不会一直盯着屏幕。开编排前先问一句、并按回答配好通道**，否则任务做完了人不知道。

### 问什么（一次问清，别每轮问）

> 「需要我在关键节点提醒你吗？你一般怎么挂着 App——全屏、画中画，还是小窗？」

按回答决定用哪条通道（**实测矩阵，2026-11-02 本机验证**）：

| 用户挂法 | 能收到文字 | 依赖 |
|---|---|---|
| 全屏 | ✅ App 内横幅 | 无 |
| **画中画** | ✅ 系统通知 | 无（通知权限关着也能收到） |
| 普通小窗 / 真后台 | ❌ 只有振动 | **需开系统通知权限** |

三条结论都来自实测：小窗时 `app_foreground=false`、`/app/notify` 返回 `ok`（走系统通知）；全屏时返回 `FOREGROUND_SKIP`，但 App 自己画应用内横幅。**不要只看返回值判断成败**。

### 怎么用

```bash
# 本机有脚本（三通道全发：Toast → 振动 → 通知）
bash ~/.dsh/scripts/notify-user.sh "标题" "正文"

# 没有脚本的环境直接打 App 桥（token 在 ~/.dsh/.bridge_token）
curl -H "X-Token: <token>" "http://127.0.0.1:3090/app/notify?title=...&text=..."
curl -H "X-Token: <token>" "http://127.0.0.1:3090/app/vibrate?ms=600"
```

### 什么时候用（**关键：只在需要用户介入时**）

✅ 该提醒：验收完需要他拍板 / 需要他重启或确认 / 要动发布·凭据·删数据前 / 卡住且两轮不通需要他定方向
❌ 不该提醒：**每个任务落定就提醒**——任务完成时用户通常就在等，提醒等于吵

### 怎么打开（用户环境的一次性设置）

- 通知权限：设置 → 应用管理 → DSH App → 通知 → 允许
- 悬浮窗（只有用 `/app/overlay` 顶部浮条才需要）：特殊权限 → 显示在其他应用上层
- 两者都可缺省：**画中画挂机最省事，不需要任何权限**

> 记录口令：用户若说「不必提醒」，就只在**必须他决策**时才叫；说「要提醒」就按上面的矩阵配通道，并在开工前确认一次。
