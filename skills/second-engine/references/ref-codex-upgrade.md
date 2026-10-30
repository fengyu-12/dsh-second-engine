# ref · Codex 升级姿势 + 升级后破坏性检验

> 入口：`SKILL.md`「要升级 Codex 二进制，或升级后判断插件要不要改时」。逐版实测记录查 `<本机功能核对表>`。

## 1. 升级姿势（2026-10-31 实测修订 —— 正选已换，别再按 release 直连试）

**npm 平台包** `@openai/codex@<版本>-linux-arm64`，一个 cURL 整包落地（0.166.0 实测 164,402,913 B、单路约 3 分钟、字节数相符）：

```sh
curl -fL -o pkg.tgz https://registry.npmmirror.com/@openai/codex/-/codex-0.166.0-linux-arm64.tgz
tar -xzf pkg.tgz -C pkg
pkg/package/vendor/aarch64-unknown-linux-musl/bin/codex --version   # 先验活，必须回 codex-cli <版本>
```

vendor 里有 `bin/codex` + `bin/codex-code-mode-host`（**须与主二进制同目录、无后缀命名**）+ `codex-resources/`（voice host / bwrap / gstreamer 库，本机当前**不装**，exec 与 app-server 用不到）+ `codex-path/rg`（PATH 已有 `/usr/bin/rg`，免装）。

**只取两个二进制**：`cp -a` 备份旧版到 `~/codex/*.bak-<旧版>` → `cp` 到临时名再 `mv -f` 原子替换 → `codex --version` 复核；回滚＝把 `.bak-<旧版>` 换回。

⚠️ **GitHub release 资产不要当正选**：2026-10-31 实测主二进制与 sidecar **直连 75 秒零字节**、`ghproxy.net` 同样卡（`ghfast.top` 更早已挂）。release 不通时**不要在它上面反复换镜像耗着**，直接走 npm 平台包。⚠️ 也别用"多文件并行各走一个镜像"解——包只有一个文件，两路并行是浪费带宽，取先完成的那路即可。

## 2. 每次升级后跑三条检验 —— 判据与处置固定

| # | 检验什么 | 命令 | 通过判据 | 不过怎么办 |
|---|---|---|---|---|
| 1 | 工具面 | `node ~/.dsh/scripts/dsh/se-tool-probe.mjs` | 工具**名字集合**与上一版基线一致（只看名字，不看字节数） | 工具名增删 ⇒ 上游改了工具面，复核插件对工具名的假设 |
| 2 | 执行链 | `bash ~/.dsh/scripts/dsh/se-appserver-verify.sh` | 5/5（appserver 派单+流式进度 / cancel 打断无残留 / exec 回归） | **插件必须动**：先切 `exec` 模式兜底，再修 |
| 3 | DSH 依赖点 | `python3 ~/.dsh/scripts/dsh/dsh-dep-check.py` | 全 OK | 与 codex 版本无关，属 DSH 侧问题 |

**只有第 2 条判不过，才需要动插件代码**；另两条是自查。

**人工判断（不可省）**：读 release notes 里**插件调用面**——`codex exec`（参数 `--skip-git-repo-check --ephemeral -o`）与 `codex app-server` 协议；这两条未动 ⇒ 插件无需维护；有变动或被默认收紧 ⇒ 记一条并评估。

⚠️ 探针数量会变（曾 3 条增至 6 条），按脚本当次输出比对，别照旧数字核。

## 3. 🔴 升级后第一件事：维护旧结论（本机私有判据 · 勿同步发布树）

真正的腐化源是"旧结论还挂在新版本号旁边"。每次升级后回扫 `SKILL.md` 与 `<本机功能核对表>` 的**状态性结论**（开关态、能力对照、扩展表、CLI 面），逐条二选一：

- **① 已复验 → 改成新版本 + 新日期**
- **② 没验 → 明确标「<旧版本> 观察，未复验」**

历史事实永不改（事故档案、版本日志、"某版实测"的记录）；现状标注必须跟上。
