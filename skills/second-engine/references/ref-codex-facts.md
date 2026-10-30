# ref · Codex 事实档案（二进制 / keyring / 预设 / wireApi / CODEX_HOME / CLI 面 / 凭证）

> 入口：`SKILL.md`「要 Codex 的路径、keyring、wireApi 选法、`~/.codex` 现场查、CLI 探针、中转站参数时」。
> 版本号、feature 开关、逐版实测一律查 `<本机功能核对表>`，本文件不记现状。

## 1. 二进制与沙箱

- 二进制 `/usr/local/bin/codex`（musl 静态）。
- 沙箱 `danger-full-access`（proot 无 Landlock/bwrap）→ **防线靠流程：工作副本隔离 + diff 审查 + git 仲裁**。
- 体积：Codex 是 223 MB CLI + 70 MB sidecar（对比 Pi 约 22 MB）。
- 换模型：改 `config.toml` 的 `model_provider` + `model`，本机现为 zhipu/glm-5.3-flash。Codex 一次一个 active provider（Pi 可并存多个）。

## 2. 提供方与 key（由插件统一管理）

- `~/.codex/keyring.json`（0600，**不手改**）。
- 激活切换时自动重写 `~/.codex/config.toml`（**不手改**，sandbox_mode 自动保留）。
- 预设两家均实测直连：DeepSeek（responses）/ 智谱（responses，Coding 端点）；chat 协议上游（中转 / 自建）经本地翻译桥自动挂接。
- `subagent_codex`（DSH 原生工具）的凭据由 provider 的 `env` 显式喂（**形似凭据的环境变量会被先剥离**，放 `~/.dsh/.env` 也没用）；本机做法是 `!!js` 现场从 `~/.codex/keyring.json` 读 active provider 的 key，凭据不落明文。装法/坑见 skill `dsh-plugin-discipline` 第五节。

## 3. 🔴 wireApi 怎么选（2026-10-03 实证，接任何第三方端点前必做）

判据只有一条 —— 直接 `POST {base}/responses` 发最小请求，**200 = 原生支持 Responses 标 `responses` 直连；404/400 才标 `completions` 走桥**。

**别默认套 `completions`**：桥只保证**文本**往返，**工具调用循环会断**（同模型同工单经桥 exit 0 + 零产物；改直连后同一工单立刻成功）。

**判据："工单 exit 0 但工作目录没有新文件" = 假完成**，第一件事查它是不是走了桥。

✅ `/providers/update` 已支持原地改 `wireApi`（2026-10-03），不必"新增一个提供方再切 active"绕行。两条前提：① 改完**重启 Web** 新代码才生效（`updated:[]` + `configRegenerated:false` 就是未生效信号）；② 换 `responses` 前先按上条验过端点原生支持。

## 4. `~/.codex/`（CODEX_HOME）现场查（完整目录地图已外移 `<本机功能核对表>` 附A）

- 大小分布：`du -sh ~/.codex/* ~/.codex/.tmp 2>/dev/null | sort -rh | head -15`
- 工单原始输出：`ls -la ~/.codex/task-*.out.live`（**工单 ID 只在文件名里、不在内容里**，查单用文件名或 mtime；清理走 `POST /second-engine/api/cleanup`，**别手删 sqlite 状态库**）
- 会话 rollout：`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`，**仅工单 `ephemeral:false` 才落盘**（缺省 true 不写）⇒ **磁盘查不到 ≠ 没跑**。最近一份的一行读法：

```bash
f=$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)
python3 -c "import json,sys
for i,l in enumerate(open(sys.argv[1],encoding='utf-8')):
    d=json.loads(l); print(i,d.get('type'),str(d.get('payload'))[:120])" "$f"
```

## 5. 能力边界：别直接引旧结论

> 结论随 codex 版本变动，日志旧结论会腐化——本环境已发生过一次（早期记录"exec 单发无协作层"，09-24 实测发现是**整个协作层被上游移除**）。**别直接引旧结论**；版本号、feature 开关、CLI 面、逐版实测一律查 `<本机功能核对表>`。

- **用前重测两条**：`node ~/.dsh/scripts/dsh/se-tool-probe.mjs`（工具面：工具**名字集合**与上版基线比对，只看名字不看字节数）+ `bash ~/.dsh/scripts/dsh/se-appserver-verify.sh`（执行链 5/5）。开关现值一条命令：`codex features list`。
- 换 provider / 换模型后必做「真干活」验证：发小工单让它用 shell 建文件并 cat 确认，看到 `exec /bin/bash -lc "..." succeeded` 且文件真存在，才算工具调用可用（当日实测 token 仅 ~14k）。
- **模型清单**：`POST /api/models {id}` 对智谱**并集**两个端点（`/api/v1` 只 3 个 + `/api/coding/paas/v4` 全量），响应 `sources` 回显实际来源，两端点共用同一 key（2026-09-28 实测）。

## 6. 凭证安全（2026-09-24 实测）

DSHA App 启动 proot 容器时把 `DEEPSEEK_API_KEY` 明文放进**命令行参数**（`/proc/<pid>/cmdline` 可见；来源是 App 层非 AI 引入，暴露面与 keyring.json 同级，不必紧急轮换，应并入上游反馈）。自己的命令**不要写 `VAR=key cmd`**（同样进 argv），要从文件读再 `env` 注入；任何 key **不得**写进产物/文档/日志。

## 7. 中转站速查（选型判据不在本文件）

Base `https://laneai.dev/v1`；key 在 `~/.dsh/中转站/keys/*.txt`（只读取、不写产物）；模型名以 `GET /v1/models` 实拉为准；一账号 5 并发；**敏感数据不过中转**。详见 `~/.dsh/中转站/接入档案.md`；选型判据归 skill `relay-forensics`（`~/.dsh/skills/relay-forensics`）。

relay 侧现场查：`ls ~/.codex/skills/relay-probe/ && ls ~/.dsh/refs/retired-proj-20261015/relay-forge/`；桥 UI 改动记录：`head -60 <插件目录>/bridge/CHANGELOG.md`。

## 8. CLI 现场速查（完整速查已外移 `<本机功能核对表>` 附B）

`codex --help` / `codex features list` / `codex doctor`（一站式环境诊断）；官方文档镜像索引 `curl -sSL https://mintlify.com/openai/codex/llms.txt`，任意页加 `.md` 后缀取纯文本 markdown（openai 官方域本环境全线不可达，一律走镜像）。

## 9. 智谱端点事实

`/api/v1` 是智谱给 **Codex 的专用适配端点**（只 3 个模型：glm-5.3 / glm-5.3-flash / glm-5-turbo）；标准列表在 `/api/paas/v4/models`；`/api/coding/paas/v4/responses` = 404（编程端点只支持 chat/completions）；**不需要额外「编程密钥」**，现有 key 三端点通用（2026-09-27 实测）。

## 10. appserver 协议映射

协议映射 `~/.dsh/refs/codex-appserver-spike-20260928/MAPPING.md`（原 `~/proj/appserver-spike` 已迁 refs）。

## 11. `~/.codex` 目录维护（插件不管这目录的体积，偶尔手动跑一次）

先跑这条看现状：

```bash
du -sm ~/.codex ~/.codex/.tmp /tmp/codex-upgrade 2>/dev/null; ls ~/.codex/*.bak-* | wc -l
python3 -c "import sqlite3;c=sqlite3.connect('file:~/.codex/logs_2.sqlite?mode=ro',uri=True);print('碎片 %d/%d 页'%(c.execute('PRAGMA freelist_count').fetchone()[0],c.execute('PRAGMA page_count').fetchone()[0]))"
```

- **能删**：`/tmp/codex-upgrade`（升级残留）· `.tmp/git-*`（Codex **每次运行建一个、从不自清**）· `.live`/`task-*.out`（`POST /api/cleanup {"keepDays":7}`，自动清理卡在 200 MB 阈值上所以永远跑不到）· bak 每类各留最新一份
- **别动**：`tmp/arg0` 与 `tmp/arg0-linux` —— 是**符号链接**（`apply_patch`/`codex-linux-sandbox`/`codex-execve-wrapper` 全指同一二进制，靠 `argv[0]` 分派），删了 sandbox 与打补丁坏
- **`logs_2.sqlite`**：删行不缩文件，只有 `VACUUM` 能收；`VACUUM` 要独占锁、Codex 在跑时**禁止**。低优先，别为它引入新机制
