// dsh-second-engine —— 设置 > 第二引擎（Codex）client 半。
// 数据通过 fetch 调 host 的 /second-engine/api/* HTTP 路由：
//   status         GET  引擎/密钥/会话占用概览（codexBinary / configExists / keyConfigured / sessionsBytes）
//   providers      GET  提供方列表（apiKey 脱敏）+ active
//   providers      POST 新增自定义提供方
//   providers/key  POST 写入指定提供方 apiKey（返回脱敏 preview，前端不回显明文）
//   providers/active POST 切换启用的提供方
//   providers/delete POST 删除自定义提供方（预设不可删）
//   providers/update POST 编辑提供方（name/baseUrl/model，apiKey 留空=不改）
//   models         POST 拉取该提供方 /models 清单（缺省 active）
//   model          POST 保存该提供方 model（active 时宿主重写 config.toml）
//   cleanup        POST 按保留天数清理旧会话 *.jsonl（返回 removed / freedBytes）
//   task           POST 下发异步工单（后台 codex exec，返回 id；完成由宿主弹 App 通知）
//   tasks          GET  最近 10 条工单摘要（不含 output）
//   task?id=       GET  单条工单全量（含 output）
//   task/cancel    POST 取消运行中的工单（SIGTERM）
//   review         POST 双向互审：对产出做多轮批判性复核（服务层自动循环，返回 id）
//   review/cancel  POST 熔断取消复核任务（SIGTERM）
//   config         GET  读插件配置（复核轮数 reviewRounds）
//   config         POST 写插件配置 { reviewRounds: 1|3|5 }
//   consult        POST Codex 卡点求助入队（{ from, task, stuckContext }）
//   consults       GET  求助列表（给主 AI 收卷）
//   websearch      GET  读 config.toml 顶层 web_search（无则 disabled）
//   websearch      POST 写 config.toml 顶层 web_search { value: disabled|cached|indexed|live }
//   mcp            GET  config.toml 全部 [mcp_servers.*] 段
//   mcp            POST 新增 [mcp_servers.<name>] { name, url }
//   mcp/<name>     DELETE 删除该段
// 渲染模式与 dsh-plugin-guard 一致：__ModuleLoader__ + React.createElement（无 JSX）。

window.__ModuleLoader__.load({
  id: 'dsh-second-engine',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const h = React.createElement

    const CSS = `
.dse-wrap{display:flex;flex-direction:column;gap:14px;min-height:320px;max-height:78vh;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:none}.dse-wrap::-webkit-scrollbar{width:0;height:0}
.dse-intro{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
.dse-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;transition:border-color .16s,background .16s}
.dse-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dse-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dse-card-title{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dse-card-head-click{cursor:pointer}
.dse-card-pill{flex:none;padding:3px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;cursor:pointer;user-select:none;-webkit-user-select:none}
.dse-card-desc{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dse-item{display:flex;align-items:center;gap:8px;padding:5px 0}
.dse-item-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-item-value{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dse-item-value.dse-bad{color:var(--dsw-alias-state-error-primary)}
.dse-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-dimmed)}
.dse-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dse-dot-bad{background:var(--dsw-alias-state-error-primary)}
.dse-dot-wait{background:var(--dsw-alias-label-dimmed)}
.dse-kv{display:flex;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:10px}
.dse-kv-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-kv-value{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:12px;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dse-field-head{align-items:center;gap:8px;display:flex}
.dse-label{min-width:0;flex:1;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-badge{flex:none;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dse-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.dse-input{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box;width:96px}
.dse-input.dse-grow{flex:1;min-width:160px;width:auto}
.dse-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dse-select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box}
.dse-btn{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.dse-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dse-btn[disabled]{opacity:.5;cursor:not-allowed}
.dse-btn.dse-primary{background:var(--dsw-alias-state-business-primary);color:#fff;border:none}
.dse-hint{font-size:11px;line-height:1.5;margin:8px 0 0;color:var(--dsw-alias-label-tertiary)}
.dse-hint.dse-err{color:var(--dsw-alias-state-error-primary)}
.dse-hint.dse-ok{color:var(--dsw-alias-state-success-primary)}
.dse-mono{font-family:ui-monospace,Consolas,'Courier New',monospace;color:var(--dsw-alias-label-primary)}
.dse-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px 0}
.dse-prov-list{display:flex;flex-direction:column;gap:8px}
.dse-prov{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px}
.dse-prov-head{display:flex;align-items:center;gap:8px}
.dse-prov-name{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-prov-id{white-space:nowrap;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dse-prov-meta{font-size:11px;line-height:1.5;margin:4px 0 0;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dse-prov-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.dse-btn.dse-danger{color:var(--dsw-alias-state-error-primary)}
.dse-form{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:12px;padding-top:10px}
.dse-form-row{display:flex;align-items:center;gap:8px}
.dse-form-label{flex:0 0 92px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dse-select.dse-grow{flex:1;min-width:160px;width:auto}
/* ── 浮动小球（shell.overlay 常驻入口）── */
.dse-ball{position:fixed;right:-14px;top:60%;width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:18px;line-height:1;cursor:pointer;z-index:9999;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;box-shadow:0 4px 14px rgba(0,0,0,.28);opacity:.92;transition:top .18s ease,left .22s ease,right .22s ease,opacity .16s ease,border-color .16s ease}
.dse-ball:hover{opacity:1;border-color:var(--dsw-alias-label-dimmed)}
.dse-ball-drag{transition:opacity .16s ease;cursor:grabbing}
.dse-ball-open{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-label-dimmed)}
.dse-ball-ver-new{color:var(--dsw-alias-state-warn-primary)}
.dse-ball-link{color:inherit;text-decoration:underline;cursor:pointer}
.dse-ball-icon{display:block;transform:translateX(-6px)}
.dse-ball-panel{position:fixed;right:8px;top:50%;transform:translateY(-50%);height:auto;max-height:calc(100vh - 160px);max-height:calc(100dvh - 160px);width:min(300px,78vw);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:12px 14px;z-index:9999;pointer-events:auto;box-shadow:0 10px 30px rgba(0,0,0,.36);animation:dse-ball-in .18s ease-out}
@keyframes dse-ball-in{from{opacity:0;transform:translate(16px,-50%)}to{opacity:1;transform:translate(0,-50%)}}
.dse-ball-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dse-ball-panel > .dse-ball-head{flex:none;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-3)}
.dse-ball-body{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-width:none}.dse-ball-body::-webkit-scrollbar{width:0;height:0}
.dse-ball-panel .dse-ball-close{min-width:30px;min-height:30px}
@media (max-height:420px){.dse-ball-panel{padding:8px 10px}.dse-ball-panel .dse-ball-textarea{min-height:36px}.dse-ball-panel .dse-ball-sec{margin:6px 0 2px}}
.dse-ball-title{flex:0 0 auto;white-space:nowrap;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dse-ball-close{flex:none;font:inherit;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;width:22px;height:22px;padding:0;cursor:pointer}
.dse-ball-close:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dse-ball-sec{font-size:11px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:10px 0 2px}
/* 首组不带上边距，否则面板顶部会多出一段空白（纯布局，不动配色） */
.dse-ball-body > .dse-ball-sec:first-child{margin-top:0}
.dse-ball-row{display:flex;align-items:center;gap:6px;padding:3px 0}
.dse-ball-row-label{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-ball-row-value{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dse-ball-row-value.dse-ball-bad{color:var(--dsw-alias-state-error-primary)}
.dse-ball-dot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed)}
.dse-ball-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dse-ball-dot-bad{background:var(--dsw-alias-state-error-primary)}
.dse-ball-dot-wait{background:var(--dsw-alias-label-dimmed)}
.dse-ball-kv{display:flex;align-items:center;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);margin-top:6px;padding-top:8px}
.dse-ball-kv-value{font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dse-ball-hint{font-size:11px;line-height:1.5;margin:4px 0 0;color:var(--dsw-alias-label-tertiary)}
.dse-ball-hint.dse-ball-ok{color:var(--dsw-alias-state-success-primary)}
.dse-ball-hint.dse-ball-err{color:var(--dsw-alias-state-error-primary)}
.dse-ball-tasks{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.dse-ball-textarea{font-family:inherit;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;box-sizing:border-box;width:100%;min-height:54px;resize:vertical}
.dse-ball-btn{font-family:inherit;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 12px;cursor:pointer;white-space:nowrap}
.dse-ball-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.dse-ball-btn[disabled]{opacity:.5;cursor:not-allowed}
.dse-ball-tasklist{display:flex;flex-direction:column;gap:4px;margin-top:2px}
.dse-ball-task{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 7px;background:var(--dsw-alias-bg-base)}
.dse-ball-task-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;-webkit-user-select:none}
.dse-ball-task-id{flex:1;min-width:0;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dse-ball-task-state{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dse-ball-task-cancel{flex:none;font:inherit;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;cursor:pointer}
.dse-ball-task-cancel:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dse-ball-task-out{margin:6px 0 0;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}
.dse-ball-dot-run{background:var(--dsw-alias-state-warn-primary)}
.dse-ball-select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;box-sizing:border-box}
.dse-ball-badge{flex:none;font-size:10px;font-weight:600;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:0 6px}
.dse-ball-sev{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed);margin-top:5px}
.dse-ball-sev-high{background:var(--dsw-alias-state-error-primary)}
.dse-ball-sev-mid{background:var(--dsw-alias-state-warn-primary)}
.dse-ball-sev-low{background:var(--dsw-alias-state-success-primary)}
.dse-ball-round{font-size:11px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:6px 0 1px}
.dse-ball-issue{display:flex;gap:6px;font-size:11px;line-height:1.45;padding:2px 0;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dse-ball-issue-body{flex:1;min-width:0}
.dse-ball-issue-point{color:var(--dsw-alias-label-primary)}
.dse-ball-issue-sug{color:var(--dsw-alias-label-tertiary)}
.dse-ball-stuck{color:var(--dsw-alias-state-warn-primary)}
.dse-switch{flex:none;position:relative;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer;padding:0;transition:background .16s,border-color .16s}
.dse-switch:hover{border-color:var(--dsw-alias-label-dimmed)}
.dse-switch[disabled]{opacity:.5;cursor:not-allowed}
.dse-switch.dse-switch-on{background:var(--dsw-alias-state-business-primary);border-color:transparent}
.dse-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s}
.dse-switch.dse-switch-on .dse-switch-knob{transform:translateX(18px)}
/* ═══ 2026-10-24 面板视觉重设计：只调整结构与层次（分组、间距、字重、数值对齐、
   空态容器），配色一律沿用上面的 --dsw-alias-* 主题变量，不新增任何色值。 ═══ */
.dse-ball-panel{border-radius:16px;padding:14px 15px}
.dse-ball-head{padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:2px}
.dse-ball-title{font-size:14.5px;font-weight:650;letter-spacing:.01em}
.dse-ball-close{width:28px;height:28px;border-radius:8px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);font-size:17px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.dse-ball-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dse-ball-sec{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin:14px 0 4px}
.dse-ball-body > .dse-ball-sec:first-child{margin-top:0}
.dse-ball-row{padding:4.5px 0}
.dse-item-label{font-weight:500;color:var(--dsw-alias-label-secondary)}
.dse-item-value,.dse-ball-kv-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dse-ball-kv{margin-top:10px;padding-top:9px}
.dse-ball-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;margin-top:4px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);text-align:center}
/* ═══ 2026-10-24 设置页视觉重构：废「卡片套卡片」改分区制 —— 各区之间只有一条 1px 分隔线，
   层次靠字重/字号/颜色分层，不靠边框盒。说明文字收进标题旁「?」。配色仍只用 --dsw-alias-*。 ═══ */
.dse-wrap{gap:0;padding:1px 0}
.dse-card{border:0;border-radius:0;background:transparent;padding:0 0 10px;transition:none}
.dse-card:hover{border-color:transparent}
.dse-card + .dse-card{border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px;padding-top:13px}
.dse-card-head{margin-bottom:9px;gap:7px}
.dse-card-title{font-size:12.5px;font-weight:650;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}
.dse-card-pill{padding:2px 10px;font-size:11px;line-height:1.5;background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.dse-card-pill:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
/* 说明：默认不占版面，点「?」展开成浅底一句 */
.dse-help{flex:none;width:18px;height:18px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:11px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.dse-help:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dse-card-desc{font-size:11.5px;line-height:1.55;margin:0 0 10px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
/* 徽标只换字色，底色沿用通用 badge 的 bg-module-platform */
.dse-badge-warn{color:var(--dsw-alias-state-success-primary)}  /* 3.1.2：状态卡与工具区的「有新版」由橙改绿，与悬浮球口径统一 */
.dse-badge-ok{color:var(--dsw-alias-state-success-primary)}
.dse-badge-on{color:var(--dsw-alias-state-success-primary)}
.dse-kv-value,.dse-item-value{font-variant-numeric:tabular-nums}
.dse-card-body a.dse-badge{text-decoration:none}
/* provider / MCP 密集列表：无框行 + 行间分隔线 */
.dse-prov-list{gap:0}
.dse-prov{border:0;border-radius:0;padding:0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dse-prov:last-child{border-bottom:0}
.dse-prov-head{display:flex;align-items:center;gap:7px;padding:8px 0;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.dse-prov-head-click{cursor:pointer}
.dse-prov-head::before{content:'';flex:none;width:3px;height:15px;border-radius:2px;background:transparent}
.dse-prov.dse-prov-on .dse-prov-head::before{background:var(--dsw-alias-state-business-primary)}
.dse-prov-model{flex:none;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dse-prov.dse-prov-on .dse-prov-model{color:var(--dsw-alias-label-secondary)}
.dse-prov-caret{flex:none;font-size:9px;line-height:1;color:var(--dsw-alias-label-dimmed);transition:transform .15s}
.dse-prov.dse-prov-expanded .dse-prov-caret{transform:rotate(90deg)}
.dse-prov-body{padding:0 0 10px}
.dse-prov .dse-prov-meta{margin:0 0 8px;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.dse-prov .dse-prov-actions{margin-top:7px;gap:6px}
.dse-btn.dse-ghost{background:transparent;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dse-btn.dse-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dse-btn.dse-sm{padding:4px 10px;font-size:11.5px}
.dse-prov-actions .dse-spacer{flex:1 1 auto}
/* ═══ 2026-10-24 v2 信息结构重排（只追加覆盖，不动上面任何原始定义）：
   面板加宽一屏放下、字号微调、分组标题延伸线、标题行状态点与模型名、
   版本+占用并一行、空态去虚线框。配色仍只用 --dsw-alias-*（warn 是
   state-warn-primary，没有 warning 这个变量）。 ═══ */
.dse-ball-panel{width:min(340px,88vw)}
.dse-ball-row-label{font-size:12.5px}
.dse-ball-row-value{font-size:11.5px}
/* 分组标题右侧一条很淡的延伸短横线 */
.dse-ball-sec{display:flex;align-items:center;gap:8px}
.dse-ball-sec::after{content:'';flex:1;border-top:1px solid var(--dsw-alias-border-l1)}
/* 标题行：汇总状态点（三项全 true=success / 任一 false=error / 未知=dimmed） */
.dse-ball-head-dot{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed)}
.dse-ball-head-dot-ok{background:var(--dsw-alias-state-success-primary)}
.dse-ball-head-dot-bad{background:var(--dsw-alias-state-error-primary)}
/* 标题行右侧模型名：等宽小字，拿不到就不渲染 */
.dse-ball-head-model{flex:1 1 auto;min-width:0;max-width:42%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,'Courier New',monospace;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* 2026-10-25：版本/占用改成与设置页同款的两行 kv（左标签右值），每行各带一条上分割线。 */
.dse-ball-kv-label{flex:1;min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}
/* 空态去虚线框：单行左对齐小字（文案在 ReviewSection/TaskSection 内，不碰组件） */
.dse-ball-empty{border:0;border-radius:0;background:transparent;padding:0;margin-top:2px;text-align:left}
/* 状态卡徽标作为链接时（插件有新版）：只去下划线，配色沿用 dse-badge-warn 的主题变量 */
.dse-card-head a.dse-badge{text-decoration:none;cursor:pointer}
/* 球体右上角「插件有新版」红点：仅 updateAvailable 时由 JS 渲染；pointer-events:none 保证不扩大命中区 */
/* 球半露在屏幕边缘 ⇒ 红点必须落在「朝屏幕中心」那一侧，否则被裁掉得先划出来才看得见 */
.dse-ball-update-dot{position:absolute;top:1px;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-state-error-primary);pointer-events:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-3)}
.dse-ball-update-dot-l{left:1px}
.dse-ball-update-dot-r{right:1px}
/* 标题行右侧位置：插件有新版时改显示版本号链接，配色压过 .dse-ball-head-model 的 tertiary */
.dse-ball-head-model.dse-ball-ver-new{color:var(--dsw-alias-state-success-primary);text-decoration:underline;text-underline-offset:2px}
/* 协作模式 UI（2026-10-25）：三预设分段行 + 只读 chip（球头部与卡片自定义态共用） */
.dse-seg{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.dse-chip{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;background:rgba(127,127,127,.25)}
/* chip 可点形态（悬浮球协作模式下拉用）与当前项高亮 */
.dse-chip-btn{cursor:pointer;border:0;font:inherit;color:inherit;background:rgba(127,127,127,.22);padding:0 7px;white-space:nowrap}.dse-chip-mode{font-size:12.5px;font-weight:600}.dse-chip-btn:disabled{opacity:.55;cursor:default}
.dse-chip-btn:disabled{opacity:.5;cursor:default}
.dse-chip-on{border-color:currentColor;font-weight:600}
.dse-collab-list{display:flex;flex-direction:column;gap:2px;margin-top:6px}
.dse-collab-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;font-size:12.5px;color:inherit;text-align:left;cursor:pointer}
.dse-collab-item:disabled{opacity:.55;cursor:default}
.dse-collab-item-on{background:rgba(127,127,127,.18);font-weight:600}
.dse-collab-now{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dse-collab-row{display:flex;align-items:center;gap:8px;width:100%;padding:4px 2px;border:0;background:transparent;font-size:12.5px;color:inherit;text-align:left;cursor:pointer}
.dse-collab-row:disabled{opacity:.55;cursor:default}
.dse-collab-label{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dse-collab-value{font-size:12.5px;font-weight:600}
.dse-collab-caret{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dse-item-row{display:flex;align-items:center;gap:8px;padding:3px 0;min-width:0}
.dse-item-desc{margin:2px 0 0 14px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dse-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);word-break:break-all}
.dse-btn-primary{background:var(--dsw-alias-state-info-primary,#2563eb);color:#fff;border-color:transparent}
.dse-btn-primary:hover{filter:brightness(1.08)}
.dse-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
`

    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-second-engine'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // JSON 取回：HTTP 错误或非 JSON 响应都转成可展示的错误文案。
    async function getJson(path) {
      const r = await fetch(path)
      const data = await r.json().catch(() => null)
      if (!data) throw new Error(`宿主返回了非 JSON 响应（HTTP ${r.status}）`)
      if (!r.ok && !data.error) throw new Error(`请求失败（HTTP ${r.status}）`)
      return data
    }

    async function postJson(path, body) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await r.json().catch(() => null)
      if (!data) throw new Error(`宿主返回了非 JSON 响应（HTTP ${r.status}）`)
      if (!r.ok && !data.error) throw new Error(`请求失败（HTTP ${r.status}）`)
      return data
    }

    // DELETE 同样做「HTTP 错误或非 JSON 响应都转成可展示错误文案」的处理。
    async function delJson(path) {
      const r = await fetch(path, { method: 'DELETE' })
      const data = await r.json().catch(() => null)
      if (!data) throw new Error(`宿主返回了非 JSON 响应（HTTP ${r.status}）`)
      if (!r.ok && !data.error) throw new Error(`请求失败（HTTP ${r.status}）`)
      return data
    }

    const errText = (e) => String((e && e.message) || e)

    // 字节 → 人类可读（0 → 0 B，进位到 KB/MB/GB）
    function humanize(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let value = n
      let i = 0
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1 }
      return `${i === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`
    }

    // 状态点：phase 为 'loading' 时显示灰色待定态。
    function StatusItem(props) {
      const { label, ok } = props
      const known = ok === true || ok === false
      const cls = !known ? ' dse-dot-wait' : (ok ? ' dse-dot-ok' : ' dse-dot-bad')
      const text = !known ? '检测中…' : (ok ? '已就绪' : props.badText)
      const valueCls = 'dse-item-value' + (ok === false ? ' dse-bad' : '')
      return h('div', { className: 'dse-item' },
        h('span', { className: 'dse-dot' + cls }),
        h('span', { className: 'dse-item-label' }, label),
        h('span', { className: valueCls }, text),
      )
    }

    function Card(props) {
      const collapsible = props.collapsible === true
      const [open, setOpen] = React.useState(props.defaultOpen !== false)
      // 说明改成「?」按需展开：常驻段落是写给第一次看的，之后全是噪音。
      // title 保桌面 hover，点击切换保手机可达（Android 长按不会显示原生 title）。
      const [showDesc, setShowDesc] = React.useState(false)
      const toggle = () => setOpen((value) => !value)

      return h('div', { className: 'dse-card' },
        h('div', {
          className: 'dse-card-head' + (collapsible ? ' dse-card-head-click' : ''),
          onClick: collapsible ? toggle : undefined,
        },
          h('h4', { className: 'dse-card-title' }, props.title),
          // badge 传字符串包通用徽标；传元素（如可点的更新链接）原样透传
          props.badge ? (React.isValidElement(props.badge) ? props.badge : h('span', { className: 'dse-badge' }, props.badge)) : null,
          props.desc ? h('button', {
            type: 'button',
            className: 'dse-help',
            'aria-label': '说明',
            'aria-expanded': showDesc,
            title: props.desc,
            onClick: (e) => { e.stopPropagation(); setShowDesc((value) => !value) },
          }, '?') : null,
          collapsible ? h('button', {
            type: 'button',
            className: 'dse-card-pill',
            'aria-expanded': open,
            onClick: (e) => { e.stopPropagation(); toggle() },
          }, open ? '收回' : '展开') : null,
        ),
        props.desc && showDesc ? h('p', { className: 'dse-card-desc' }, props.desc) : null,
        open ? h('div', { className: 'dse-card-body' }, props.children) : null,
      )
    }

    function StatusCard() {
      const [phase, setPhase] = React.useState('loading')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [bytes, setBytes] = React.useState(null)
      // 插件自身（dsh-second-engine）的新版本提示：只有 updateAvailable 才有值，
      // 加载中/失败/无更新一律 null → badge 维持「实时探测」，不渲染任何额外元素。
      const [pluginNew, setPluginNew] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        getJson('/second-engine/api/plugin-version')
          .then((r) => { if (alive && r && r.ok && r.updateAvailable === true) setPluginNew({ latest: r.latest || '', htmlUrl: r.htmlUrl || '' }) })
          .catch(() => { /* 静默：查不到就当没有更新 */ })
        return () => { alive = false }
      }, [])

      const refresh = async () => {
        setPhase('loading'); setError('')
        try {
          const r = await getJson('/second-engine/api/status')
          if (r && r.ok) {
            setData({
              codexBinary: !!r.codexBinary,
              configExists: !!r.configExists,
              keyConfigured: !!r.keyConfigured,
              // P4.3 修（2026-10-28 实测）：少了这一行，面板 d.engine 恒为 undefined，
              // 引擎下拉永远只显示 fallback 的 Codex 一项 —— 看起来"下拉存在但只有自己"。
              engine: r.engine || null,
            })
            setBytes(Number.isFinite(Number(r.sessionsBytes)) ? Number(r.sessionsBytes) : 0)
          } else {
            setData(null); setBytes(null)
            setError((r && r.error) || '引擎状态读取失败')
          }
        } catch (e) {
          setData(null); setBytes(null)
          setError(errText(e))
        }
        setPhase('ready')
      }
      React.useEffect(() => { refresh() }, [])
      // 版本检查（8.3-9① 只提示不自动装）：面板打开时拉一次。
      // F4（P4.24，2026-10-29）：/second-engine/api/version 是**Codex 专属**口径——
      //   src/index.js:4828 handleVersion → localCodexVersion() + latestCodexVersion()（GitHub release）。
      // Pi 引擎下它查的不是当前引擎，所以**不发**这个请求（不只是隐藏行）：省一次 GitHub 访问，
      // 也不会把 Codex 版本号当成 Pi 的版本。判据用 versionCheck，不用 onPi（语义在能力表里）。
      // 门禁放在 effect 里、读 ref：caps 来自本组件的 status 回包，不能进依赖数组重跑（会循环拉）。
      // 写法：单链 setTimeout，每轮读**当时最新**的 capsRef —— 既能等 status 落地，
      // 又保证切引擎后下一轮就停发（不是 setInterval(…,0) 那种空转）。
      const capsRef = React.useRef(null)
      const [ver, setVer] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          if (!alive) return
          const c = capsRef.current
          if (c === null) { timer = setTimeout(tick, 150); return }   // status 未回：先不发，不把 Codex 默认当现状
          if (c.versionCheck !== 'github' && c.versionCheck !== 'npm') {   // P4.28：两个版本源都发；未知才不发
            setVer(null)
            timer = setTimeout(tick, 30000)
            return
          }
          getJson('/second-engine/api/version').then((r) => {
            if (alive && r && r.ok) setVer({ local: r.current || null, latest: r.latest || null, updateAvailable: !!r.updateAvailable, htmlUrl: r.htmlUrl || 'https://github.com/openai/codex/releases/latest' })
          }).catch(() => { /* 静默：版本检查失败不干扰状态卡 */ }).then(() => {
            if (alive) timer = setTimeout(tick, 30000)
          })
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      const d = data
      // P4.5（2026-10-28）：条件渲染的唯一依据。老后端不返回 caps 时按 codex 兜底，
      // 保证「面板不崩、只是显示旧内容」，而不是白屏。
      // P4.24（2026-10-29 契约 4.5）：新增字段必须在这里同步 Codex 默认值，否则老后端
      // （caps 缺字段）下 `caps.xxx === '某值'` 全落空 → 把能用的卡误隐藏。
      const caps = (d && d.engine && d.engine.caps) || {
        eventStream: 'fine', approvals: false, resume: true, review: true,
        chatBridge: true, chatBridgeMode: 'app-server', modelSwitch: 'config-file', versionCheck: 'github',
        mcp: 'config-toml', webSearch: true,
      }
      capsRef.current = caps   // 给上面那个版本轮询 effect 读最新能力（不进依赖数组，避免循环）
      const onPi = d && d.engine && d.engine.active === 'pi'
      return h(Card,
        {
          title: '引擎状态',
          desc: `${onPi ? 'Pi' : 'Codex'} 引擎的本地安装与可用性（只在本地探测，不上报）。`,
          badge: pluginNew
            ? h('a', {
                className: 'dse-badge dse-badge-warn', href: pluginNew.htmlUrl,
                target: '_blank', rel: 'noreferrer', title: '查看插件新版本发布页',
              }, `有新版 ${pluginNew.latest} →`)
            : (phase === 'loading' ? '检测中' : '实时探测'),
        },
        // P4.3（2026-10-28）：引擎切换。原来只加在浮球面板，设置页没有 —— 这里补上。
        // 切换只写 ~/.dsh/second-engine-engine.txt，影响「之后新下发的工单」。
        h('div', { className: 'dse-kv' },
          h('span', { className: 'dse-kv-label' }, '引擎'),
          h('select', {
            className: 'dse-select',
            value: d !== null && d !== undefined && d.engine ? d.engine.active : 'codex',
            // 注意：设置页作用域**没有 busy**（那是浮球面板的变量）。这里引用它会 ReferenceError，
            // 让整个「引擎状态」卡不渲染 —— 2026-10-28 实测就是这个把设置页整块搞白的。
            onChange: (e) => {
              const want = e.target.value
              void (async () => {
                try {
                  setError('')
                  const r = await postJson('/second-engine/api/config', { engine: want })
                  if (!r || !r.ok) { setError((r && r.error) || '切换失败'); return }
                  refresh()
                } catch (err) { setError(errText(err)) }
              })()
            },
          }, (d !== null && d !== undefined && d.engine && Array.isArray(d.engine.list) && d.engine.list.length > 0
              ? d.engine.list
              : [{ id: 'codex', label: 'Codex' }]).map((x) => h('option', { key: x.id, value: x.id }, x.label))),
        ),
        // F3：Pi 下换成本引擎的探测（原来三行永远是 Codex 的，切到 Pi 后全是误导）
        onPi
          ? h('div', null,
              h(StatusItem, { label: 'Pi 可执行文件', ok: d && d.engine && d.engine.probe && d.engine.probe.pi ? d.engine.probe.pi.inPath : null, badText: '不在 PATH' }),
              h(StatusItem, { label: '模型清单 models.json', ok: d && d.engine && d.engine.probe && d.engine.probe.pi ? d.engine.probe.pi.modelsJsonExists : null, badText: '缺失（可选）' }),
              h('div', { className: 'dse-kv' },
                h('span', { className: 'dse-kv-label' }, '当前模型'),
                h('span', { className: 'dse-kv-value' }, (d && d.engine && d.engine.model ? d.engine.model.model : '') || '未知'),
                d && d.engine && d.engine.model && d.engine.model.fallback
                  ? h('span', { className: 'dse-badge' }, '回落值')
                  : null),
            )
          : h('div', null,
              h(StatusItem, { label: 'Codex 可执行文件', ok: d ? d.codexBinary : null, badText: '未找到' }),
              h(StatusItem, { label: '配置文件 config.toml', ok: d ? d.configExists : null, badText: '缺失' }),
              h(StatusItem, { label: 'API Key', ok: d ? d.keyConfigured : null, badText: '未配置' })),
        caps.versionCheck === 'npm'
          ? h('div', { className: 'dse-kv' },
              h('span', { className: 'dse-kv-label' }, 'Pi 版本'),
              h('span', { className: 'dse-kv-value' }, ver === null ? '检查中…' : (ver.local || '未知')),
              ver === null
                ? null
                : (ver.updateAvailable
                    ? h('a', { key: 'up', className: 'dse-badge dse-badge-warn', href: ver.htmlUrl, target: '_blank', rel: 'noreferrer' }, `有新版 ${ver.latest} →`)
                    : (ver.latest === null
                        ? h('span', { key: 'na', className: 'dse-badge' }, '检查失败')
                        : h('span', { key: 'ok', className: 'dse-badge dse-badge-ok' }, '已是最新'))),
            )
          : null,
        caps.versionCheck === 'npm' ? null : h('div', { className: 'dse-kv' },
          h('span', { className: 'dse-kv-label' }, 'Codex 版本'),
          h('span', { className: 'dse-kv-value' }, ver === null ? '检查中…' : (ver.local || '未知')),
          ver === null
            ? null
            : (ver.updateAvailable
                ? h('a', {
                    key: 'up', className: 'dse-badge dse-badge-warn', href: ver.htmlUrl,
                    target: '_blank', rel: 'noreferrer',
                  }, `有新版 ${ver.latest} →`)
                : (ver.latest === null
                    ? h('span', { key: 'na', className: 'dse-badge' }, '检查失败')
                    : h('span', { key: 'ok', className: 'dse-badge dse-badge-ok' }, '已是最新'))),
        ),
        // Pi 引擎下来自 ~/.codex/sessions 的数字与用户无关：整行不渲染。
        // 只改文案（旧版写成「Codex 会话占用（当前引擎不使用）」）等于把无关数字留在面板上，
        // 用户第一眼就看出「还是有 codex 相关的」—— 文案不是豁免。
        onPi ? null : h('div', { className: 'dse-kv' },
          h('span', { className: 'dse-kv-label' }, '会话目录占用'),
          h('span', { className: 'dse-kv-value' }, bytes === null ? '—' : humanize(bytes)),
        ),
        error ? h('p', { className: 'dse-hint dse-err' }, `状态读取失败：${error}`) : null,
        h('div', { className: 'dse-row' },
          h('button', {
            type: 'button', className: 'dse-btn', disabled: phase === 'loading', onClick: refresh,
          }, phase === 'loading' ? '刷新中…' : '刷新状态'),
        ),
      )
    }

    // 表单一行：定宽标签 + 控件（窄屏下随 dse-form-row 换行）。
    function FormRow(props) {
      return h('div', { className: 'dse-form-row' },
        h('span', { className: 'dse-form-label' }, props.label),
        props.children,
      )
    }

    // 模型提供方卡：列表（启用 / 填 Key / 删）+ 自定义提供方表单 + 模型获取与选择。
    // 每次 fetch 失败都只落到文案上；组件结构与渲染全程 try/catch，绝不因数据异常白屏。
    // Pi 引擎与 Codex 共用这一张卡：数据源由后端 /api/providers 按引擎分流，
    // 前端不传任何 source、不做任何分支 —— 这也是「不造第二套 UI」的唯一正确做法。
    function ProviderCard() {
      const [phase, setPhase] = React.useState('loading')
      const [loadError, setLoadError] = React.useState('')
      const [active, setActive] = React.useState('')
      const [providers, setProviders] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState({ text: '', kind: '' })
      const [openKeyId, setOpenKeyId] = React.useState('')
      const [keyDraft, setKeyDraft] = React.useState('')
      const [editingId, setEditingId] = React.useState('')
      const [editDraft, setEditDraft] = React.useState({ name: '', baseUrl: '', model: '', apiKey: '' })
      const [showAdd, setShowAdd] = React.useState(false)
      const [draft, setDraft] = React.useState({ id: '', name: '', baseUrl: '', wireApi: '', model: '' })
      const [models, setModels] = React.useState(null)
      // 协议选项由后端下发：Codex 是 responses/completions 两种（后者经本地桥），
      // Pi 是 6 种原生 api（直连，没有桥）。前端不再写死两选项 —— 那会让 Pi 缺 anthropic 等。
      const [wireOpts, setWireOpts] = React.useState(null)
      const fallbackWireOpts = [{ value: 'responses', label: 'responses（直连）', bridged: false }]
      const wireOptions = Array.isArray(wireOpts) && wireOpts.length > 0 ? wireOpts : fallbackWireOpts
      const defaultWire = String(wireOptions[0].value)
      const [modelMsg, setModelMsg] = React.useState({ text: '', kind: '' })
      const [openRow, setOpenRow] = React.useState('')

      // 拿到 active 后自动展开那一行（模型选择就地可用）；用户手动收起后不再强开。
      React.useEffect(() => {
        setOpenRow((cur) => (cur === '' && active ? active : cur))
      }, [active])

      const load = async () => {
        setPhase('loading'); setLoadError('')
        try {
          const r = await getJson('/second-engine/api/providers')
          if (r && r.ok) {
            setActive(typeof r.active === 'string' ? r.active : '')
            setProviders(Array.isArray(r.providers) ? r.providers : [])
            setWireOpts(Array.isArray(r.wireApiOptions) ? r.wireApiOptions : null)
          } else {
            setProviders([]); setActive('')
            setLoadError((r && r.error) || '提供方列表读取失败')
          }
        } catch (e) {
          setProviders([]); setActive('')
          setLoadError(errText(e))
        }
        setPhase('ready')
      }
      React.useEffect(() => { load() }, [])

      const labelOf = (id) => {
        try {
          const p = providers.find((x) => x && x.id === id)
          return (p && p.name) ? p.name : id
        } catch { return id }
      }

      // 统一的忙碌/错误封装：tag 标记哪一行在忙，异常一律转成状态文案。
      const run = async (tag, fn) => {
        setBusy(tag); setStatus({ text: '', kind: '' })
        try {
          await fn()
        } catch (e) {
          setStatus({ text: errText(e), kind: 'err' })
        }
        setBusy('')
      }

      const enable = (id) => run('active:' + id, async () => {
        const r = await postJson('/second-engine/api/providers/active', { id })
        if (r && r.ok) {
          setModels(null); setModelMsg({ text: '', kind: '' })
          setStatus({ text: `已启用「${labelOf(id)}」，config.toml 已按该提供方重写。`, kind: 'ok' })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '启用失败', kind: 'err' })
        }
      })

      const saveKey = (id) => run('key:' + id, async () => {
        const trimmed = keyDraft.trim()
        if (trimmed === '') { setStatus({ text: '请先粘贴 API Key（不能为空）', kind: 'err' }); return }
        const r = await postJson('/second-engine/api/providers/key', { id, apiKey: trimmed })
        if (r && r.ok) {
          setKeyDraft(''); setOpenKeyId('') // 保存后立即清空输入框，界面不回显明文
          setStatus({ text: `已保存「${labelOf(id)}」的 Key（keyring.json 权限 0600），当前：${r.preview || ''}`, kind: 'ok' })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '保存失败', kind: 'err' })
        }
      })

      // 展开/收起行内编辑表单：每次展开都用该行当前值预填，Key 框永远空着（绝不回显）。
      const openEdit = (p) => {
        try {
          const opening = editingId !== p.id
          setEditingId(opening ? p.id : '')
          setEditDraft({
            name: typeof p.name === 'string' ? p.name : '',
            baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
            model: typeof p.model === 'string' ? p.model : '',
            apiKey: '',
          })
          setOpenKeyId(''); setKeyDraft('')
          setStatus({ text: '', kind: '' })
        } catch (e) { setStatus({ text: errText(e), kind: 'err' }) }
      }

      const saveEdit = (id) => run('edit:' + id, async () => {
        const name = editDraft.name.trim()
        const baseUrl = editDraft.baseUrl.trim()
        const model = editDraft.model.trim()
        const apiKey = editDraft.apiKey.trim()
        // 与服务端同一套校验，先在本地拦一道，避免无谓往返。
        if (name === '') { setStatus({ text: '显示名称不能为空', kind: 'err' }); return }
        if (!/^https?:\/\//i.test(baseUrl)) { setStatus({ text: 'API 地址必须以 http:// 或 https:// 开头', kind: 'err' }); return }
        if (model === '') { setStatus({ text: '模型名不能为空', kind: 'err' }); return }
        const payload = { id, name, baseUrl, model }
        // Key 留空 = 不修改：只有用户真填了新 Key 才把该字段带上。
        if (apiKey !== '') payload.apiKey = apiKey
        const r = await postJson('/second-engine/api/providers/update', payload)
        if (r && r.ok) {
          const changed = Array.isArray(r.updated) && r.updated.length > 0 ? r.updated.join('、') : '无字段变化'
          setEditingId('')
          setEditDraft({ name: '', baseUrl: '', model: '', apiKey: '' })
          setStatus({
            text: `已更新「${name}」：${changed}${r.configRegenerated ? '，config.toml 已同步。' : '。'}`,
            kind: 'ok',
          })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '保存失败', kind: 'err' })
        }
      })

      const removeProvider = (id) => run('del:' + id, async () => {
        const r = await postJson('/second-engine/api/providers/delete', { id })
        if (r && r.ok) {
          if (openKeyId === id) { setOpenKeyId(''); setKeyDraft('') }
          if (editingId === id) { setEditingId(''); setEditDraft({ name: '', baseUrl: '', model: '', apiKey: '' }) }
          setStatus({ text: `已删除「${labelOf(id)}」。`, kind: 'ok' })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '删除失败', kind: 'err' })
        }
      })

      const fetchModels = () => run('models', async () => {
        setModels(null); setModelMsg({ text: '', kind: '' })
        const r = await postJson('/second-engine/api/models', { id: active })
        if (r && r.ok && Array.isArray(r.models)) {
          setModels(r.models)
          setModelMsg({
            text: r.models.length > 0 ? `已获取 ${r.models.length} 个模型，选择后立即保存。` : '接口返回成功，但没有模型。',
            kind: r.models.length > 0 ? 'ok' : 'err',
          })
        } else {
          setModelMsg({ text: (r && r.error) || '获取模型列表失败', kind: 'err' })
        }
      })

      const chooseModel = (model) => run('model', async () => {
        if (!model) return
        const r = await postJson('/second-engine/api/model', { id: active, model })
        if (r && r.ok) {
          setModelMsg({ text: `已保存模型「${model}」${r.configRegenerated ? '，config.toml 已同步。' : '。'}`, kind: 'ok' })
          await load()
        } else {
          setModelMsg({ text: (r && r.error) || '保存模型失败', kind: 'err' })
        }
      })

      const addProvider = () => run('add', async () => {
        const id = draft.id.trim()
        const name = draft.name.trim()
        const baseUrl = draft.baseUrl.trim()
        const model = draft.model.trim()
        if (id === '' || name === '' || baseUrl === '') {
          setStatus({ text: 'Provider ID、显示名称、API 地址都不能为空', kind: 'err' }); return
        }
        const r = await postJson('/second-engine/api/providers', { id, name, baseUrl, wireApi: draft.wireApi || defaultWire, model })
        if (r && r.ok) {
          setDraft({ id: '', name: '', baseUrl: '', wireApi: '', model: '' })
          setShowAdd(false)
          setStatus({ text: `已添加「${name}」（${id}），可点「启用」切换过去。`, kind: 'ok' })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '添加失败', kind: 'err' })
        }
      })

      const activeProvider = providers.find((p) => p && p.id === active) || null

      // 模型选择只对当前启用项开放，就地放进该行展开体（原来独立在卡尾，最常换的反倒要走到底）。
      const modelPicker = activeProvider ? h('div', { className: 'dse-form' },
        h('div', { className: 'dse-row' },
          h('span', { className: 'dse-item-label' }, '换模型'),
          h('button', {
            type: 'button', className: 'dse-btn dse-ghost dse-sm', disabled: busy !== '', onClick: fetchModels,
          }, busy === 'models' ? '获取中…' : '获取模型列表'),
        ),
        models !== null
          ? h('div', { className: 'dse-row' },
              h('select', {
                className: 'dse-select dse-grow', value: '', disabled: busy !== '',
                onChange: (e) => chooseModel(e.target.value),
              },
                h('option', { value: '' }, models.length > 0 ? `选择模型（共 ${models.length} 个）` : '接口未返回任何模型'),
                models.map((m) => h('option', { key: m, value: m }, m)),
              ),
            )
          : null,
        modelMsg.text ? h('p', { className: 'dse-hint ' + (modelMsg.kind === 'err' ? 'dse-err' : 'dse-ok') }, modelMsg.text) : null,
      ) : null

      // 逐个提供方一行；单行结构异常只吞掉这次渲染，不影响整卡。
      // 主行只留「名称 + 状态徽标 + 模型名」，地址/协议/Key 降级到展开后的 meta，
      // 日常要看的就是"谁在跑、跑哪个模型"。
      let rows = null
      try {
        rows = providers.map((p) => {
          const configured = !!(p && p.apiKey && p.apiKey.configured)
          const isActive = p.id === active
          // 预设判定与服务层 PROTECTED_IDS 对齐：只有 deepseek/zhipu 不可删。
          const isPreset = p.id === 'deepseek' || p.id === 'zhipu'
          // 桥只存在于 Codex 侧（completions 经本地翻译桥）；Pi 的 6 种 api 全是直连。
          // 所以「是不是桥」由后端下发的 option.bridged 决定，不在前端按名字猜。
          const wireHit = wireOptions.find((o) => String(o.value) === String(p.wireApi || defaultWire))
          const bridged = Boolean(wireHit && wireHit.bridged)
          const wireLabel = String((wireHit && wireHit.label) || p.wireApi || defaultWire)
          // 展开态受控（不用 <details open>：受控 open 会让当前项永远收不起来）。
          const expanded = openRow === p.id
          return h('div', {
            className: 'dse-prov' + (isActive ? ' dse-prov-on' : '') + (expanded ? ' dse-prov-expanded' : ''),
            key: p.id,
          },
            h('div', {
              className: 'dse-prov-head dse-prov-head-click',
              onClick: () => setOpenRow(expanded ? '' : p.id),
            },
              h('span', { className: 'dse-dot' + (configured ? ' dse-dot-ok' : ' dse-dot-bad') }),
              h('span', { className: 'dse-prov-name' }, p.name || p.id),
              isActive ? h('span', { className: 'dse-badge dse-badge-on' }, '当前') : null,
              bridged ? h('span', { className: 'dse-badge' }, '桥') : null,
              h('span', { className: 'dse-prov-model' }, p.model || '未设模型'),
              h('span', { className: 'dse-prov-caret' }, '▶'),
            ),
            expanded ? h('div', { className: 'dse-prov-body' },
              h('p', { className: 'dse-prov-meta' },
                `${p.baseUrl || '未配置地址'} · ${wireLabel} · ${configured ? 'Key ' + p.apiKey.preview : 'Key 未配置'} · id ${p.id}`,
              ),
              h('div', { className: 'dse-prov-actions' },
                isActive ? null : h('button', {
                  type: 'button', className: 'dse-btn dse-primary dse-sm',
                  disabled: busy !== '', onClick: () => enable(p.id),
                }, busy === 'active:' + p.id ? '启用中…' : '启用'),
                h('button', {
                  type: 'button', className: 'dse-btn dse-ghost dse-sm', disabled: busy !== '',
                  onClick: () => {
                    setOpenKeyId(openKeyId === p.id ? '' : p.id)
                    setKeyDraft('')
                    setEditingId('')
                    setStatus({ text: '', kind: '' })
                  },
                }, '填 Key'),
                h('button', {
                  type: 'button', className: 'dse-btn dse-ghost dse-sm', disabled: busy !== '',
                  onClick: () => openEdit(p),
                }, editingId === p.id ? '收起编辑' : '编辑'),
                h('span', { className: 'dse-spacer' }),
                isPreset ? null : h('button', {
                  type: 'button', className: 'dse-btn dse-danger dse-sm', disabled: busy !== '',
                  onClick: () => removeProvider(p.id),
                }, busy === 'del:' + p.id ? '删除中…' : '删除'),
              ),
              openKeyId === p.id && editingId !== p.id ? h('div', { className: 'dse-prov-actions' },
                h('input', {
                  className: 'dse-input dse-grow', type: 'password', value: keyDraft, disabled: busy !== '',
                  autoComplete: 'off', spellCheck: false, placeholder: '粘贴 key 后点保存（保存即清空）',
                  onChange: (e) => { setKeyDraft(e.target.value); setStatus({ text: '', kind: '' }) },
                }),
                h('button', {
                  type: 'button', className: 'dse-btn dse-primary dse-sm', disabled: busy !== '',
                  onClick: () => saveKey(p.id),
                }, busy === 'key:' + p.id ? '保存中…' : '保存'),
              ) : null,
              editingId === p.id ? h('div', { className: 'dse-form' },
                h(FormRow, { label: '显示名称' },
                  h('input', {
                    className: 'dse-input dse-grow', value: editDraft.name, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '如 我的中转站',
                    onChange: (e) => { setEditDraft((d) => ({ ...d, name: e.target.value })); setStatus({ text: '', kind: '' }) },
                  }),
                ),
                h(FormRow, { label: 'API 地址' },
                  h('input', {
                    className: 'dse-input dse-grow', value: editDraft.baseUrl, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '如 https://api.example.com/v1',
                    onChange: (e) => { setEditDraft((d) => ({ ...d, baseUrl: e.target.value })); setStatus({ text: '', kind: '' }) },
                  }),
                ),
                h(FormRow, { label: '模型名' },
                  h('input', {
                    className: 'dse-input dse-grow', value: editDraft.model, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '如 deepseek-flash',
                    onChange: (e) => { setEditDraft((d) => ({ ...d, model: e.target.value })); setStatus({ text: '', kind: '' }) },
                  }),
                ),
                h(FormRow, { label: 'API Key' },
                  h('input', {
                    className: 'dse-input dse-grow', type: 'password', value: editDraft.apiKey, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '留空则不修改',
                    onChange: (e) => { setEditDraft((d) => ({ ...d, apiKey: e.target.value })); setStatus({ text: '', kind: '' }) },
                  }),
                ),
                h('div', { className: 'dse-row' },
                  h('button', {
                    type: 'button', className: 'dse-btn dse-primary dse-sm', disabled: busy !== '',
                    onClick: () => saveEdit(p.id),
                  }, busy === 'edit:' + p.id ? '保存中…' : '保存'),
                  h('button', {
                    type: 'button', className: 'dse-btn dse-ghost dse-sm', disabled: busy !== '',
                    onClick: () => { setEditingId(''); setEditDraft({ name: '', baseUrl: '', model: '', apiKey: '' }); setStatus({ text: '', kind: '' }) },
                  }, '取消'),
                ),
              ) : null,
              isActive ? modelPicker : null,
            ) : null,
          )
        })
      } catch { rows = null }

      return h(Card,
        {
          title: '模型提供方',
          desc: '管理 Codex 的 provider 目录：启用、编辑、写入 Key（仅脱敏回显）、删除自定义项，并为当前启用项挑选模型。',
          badge: phase === 'loading' ? '读取中' : (activeProvider ? (activeProvider.model || '未设模型') : '未启用'),
        },
        providers.length === 0
          ? h('p', { className: 'dse-empty' }, phase === 'loading' ? '读取提供方…' : '暂无提供方')
          : h('div', { className: 'dse-prov-list' }, rows),
        loadError ? h('p', { className: 'dse-hint dse-err' }, `提供方列表读取失败：${loadError}`) : null,
        status.text ? h('p', { className: 'dse-hint ' + (status.kind === 'err' ? 'dse-err' : 'dse-ok') }, status.text) : null,

        // ── 添加自定义提供方（折叠）──
        h('div', { className: 'dse-form' },
          h('div', { className: 'dse-row' },
            h('button', {
              type: 'button', className: 'dse-btn', disabled: busy !== '',
              onClick: () => { setShowAdd(!showAdd); setStatus({ text: '', kind: '' }) },
            }, showAdd ? '取消添加' : '+ 添加自定义提供方'),
          ),
          showAdd
            ? h(React.Fragment, null,
                h(FormRow, { label: 'Provider ID' },
                  h('input', {
                    className: 'dse-input dse-grow', value: draft.id, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '小写字母开头，如 my-provider',
                    onChange: (e) => setDraft((d) => ({ ...d, id: e.target.value })),
                  }),
                ),
                h(FormRow, { label: '显示名称' },
                  h('input', {
                    className: 'dse-input dse-grow', value: draft.name, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '如 我的中转站',
                    onChange: (e) => setDraft((d) => ({ ...d, name: e.target.value })),
                  }),
                ),
                h(FormRow, { label: 'API 地址' },
                  h('input', {
                    className: 'dse-input dse-grow', value: draft.baseUrl, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '如 https://api.example.com/v1',
                    onChange: (e) => setDraft((d) => ({ ...d, baseUrl: e.target.value })),
                  }),
                ),
                h(FormRow, { label: '协议' },
                  h('select', {
                    className: 'dse-select dse-grow', value: draft.wireApi, disabled: busy !== '',
                    onChange: (e) => setDraft((d) => ({ ...d, wireApi: e.target.value })),
                  },
                    wireOptions.map((o) => h('option', { key: String(o.value), value: String(o.value) }, String(o.label || o.value))),
                  ),
                ),
                h(FormRow, { label: '模型名' },
                  h('input', {
                    className: 'dse-input dse-grow', value: draft.model, disabled: busy !== '',
                    autoComplete: 'off', spellCheck: false, placeholder: '可留空，之后用「获取模型列表」选择',
                    onChange: (e) => setDraft((d) => ({ ...d, model: e.target.value })),
                  }),
                ),
                h('div', { className: 'dse-row' },
                  h('button', { type: 'button', className: 'dse-btn dse-primary', disabled: busy !== '', onClick: addProvider },
                    busy === 'add' ? '提交中…' : '添加'),
                ),
              )
            : null,
        ),
      )
    }

    function CleanupCard(props) {
      // 初始值来自宿主 settings 文档的 keepDays（命名空间不可用时回落 7）；
      // 之后的 fetch 逻辑与校验完全不变。
      const [keepDays, setKeepDays] = React.useState(String(props && props.initialKeepDays ? props.initialKeepDays : 7))
      const [busy, setBusy] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [status, setStatus] = React.useState({ text: '', kind: '' })

      const days = Number(keepDays)
      const invalid = keepDays.trim() === '' || !Number.isFinite(days) || days < 0

      // P4.25（2026-10-29 契约 4.3）：清理卡必须显示**实际清理目标**。
      // 旧版只有「保留天数 + 不可撤销」，用户无从核对删的是哪个目录；而 resume 与清理无因果关系，
      // 不能拿 resume 推范围。数据来自 /status 的 engine.cleanup（registry.CLEANUP_TARGETS 唯一来源）。
      // 展示性数据：拿不到就不显示，绝不影响清理操作本身。
      const [cleanupTarget, setCleanupTarget] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        getJson('/second-engine/api/status')
          .then((r) => { if (alive && r && r.engine && r.engine.cleanup) setCleanupTarget(r.engine.cleanup) })
          .catch(() => { /* 展示失败静默 */ })
        return () => { alive = false }
      }, [])

      const run = async () => {
        const n = Number(keepDays)
        if (keepDays.trim() === '' || !Number.isFinite(n) || n < 0) {
          setStatus({ text: '保留天数必须是非负数字', kind: 'err' }); setResult(null); return
        }
        setBusy(true); setStatus({ text: '', kind: '' }); setResult(null)
        try {
          const r = await postJson('/second-engine/api/cleanup', { keepDays: n })
          if (r && r.ok) {
            const removed = Number(r.removed) || 0
            const freed = Number(r.freedBytes) || 0
            setResult({ removed, freedBytes: freed })
            setStatus({
              text: removed > 0 ? `已删除 ${removed} 个会话文件。` : `没有早于 ${n} 天的会话文件，未删除任何内容。`,
              kind: 'ok',
            })
          } else {
            setStatus({ text: (r && r.error) || '清理失败', kind: 'err' })
          }
        } catch (e) {
          setStatus({ text: errText(e), kind: 'err' })
        }
        setBusy(false)
      }

      return h(Card,
        {
          title: '会话清理',
          desc: '删除会话目录下 mtime 早于保留天数的 *.jsonl，释放磁盘占用。',
          collapsible: true,
          defaultOpen: false,
          badge: '不可撤销',
        },
        cleanupTarget !== null
          ? h('div', { className: 'dse-kv' },
              h('span', { className: 'dse-kv-label' }, '清理目标'),
              h('span', { className: 'dse-kv-value' }, String(cleanupTarget.dir) + ' / ' + String(cleanupTarget.filePattern || '')),
            )
          : null,
        cleanupTarget !== null && cleanupTarget.appliesToEngine !== 'codex'
          ? h('p', { className: 'dse-hint' }, '注意：当前激活引擎不是 Codex，这张卡清理的是 Codex 的会话记录。')
          : null,
        h('div', { className: 'dse-field-head' },
          h('span', { className: 'dse-label' }, '保留天数'),
        ),
        h('div', { className: 'dse-row' },
          h('input', {
            className: 'dse-input' + (invalid ? ' dse-input-invalid' : ''),
            type: 'number', min: 0, step: 1, value: keepDays, disabled: busy,
            onChange: (e) => { setKeepDays(e.target.value); setStatus({ text: '', kind: '' }); setResult(null) },
          }),
          h('button', { type: 'button', className: 'dse-btn dse-primary', disabled: busy || invalid, onClick: run },
            busy ? '清理中…' : '清理旧会话'),
        ),
        invalid ? h('p', { className: 'dse-hint dse-err' }, '保留天数必须是非负数字') : null,
        result
          ? h('div', { className: 'dse-kv' },
              h('span', { className: 'dse-kv-label' }, `已删除 ${result.removed} 个文件 · 释放`),
              h('span', { className: 'dse-kv-value' }, humanize(result.freedBytes)),
            )
          : null,
        status.text ? h('p', { className: 'dse-hint ' + (status.kind === 'err' ? 'dse-err' : 'dse-ok') }, status.text) : null,
      )
    }

    // 联网搜索与 MCP 卡：web_search 开关（disabled↔live）+ MCP 服务器列表与增删。
    // 每次 fetch 失败都只落到文案上；组件渲染全程防御式，绝不因数据异常白屏。
    // 档位文案：面板只暴露 disabled/live 两档，config.toml 里可能是 cached/indexed。
    const WEB_SEARCH_TEXT = { disabled: 'disabled（关闭）', cached: 'cached（缓存档）', indexed: 'indexed（索引档）', live: 'live（开启）' }

    function WebSearchMcpCard() {
      const [phase, setPhase] = React.useState('loading')
      const [webSearch, setWebSearch] = React.useState('disabled')
      const [servers, setServers] = React.useState([])
      const [busy, setBusy] = React.useState('')
      const [status, setStatus] = React.useState({ text: '', kind: '' })
      const [draft, setDraft] = React.useState({ name: '', url: '' })

      // 开关与列表各拉各的：一条请求挂了（网络错 / 非 JSON / 后端报错）不影响另一条的数据，
      // 两个失败文案依次拼起来显示。读成功时清掉上一次的失败文案。
      const load = async () => {
        setPhase('loading')
        const errs = []
        const [ws, mcp] = await Promise.all([
          getJson('/second-engine/api/websearch').catch((e) => { errs.push(`联网搜索开关读取失败：${errText(e)}`); return null }),
          getJson('/second-engine/api/mcp').catch((e) => { errs.push(`MCP 列表读取失败：${errText(e)}`); return null }),
        ])
        if (ws && ws.ok) setWebSearch(String(ws.value || 'disabled'))
        else if (ws) errs.push(`联网搜索开关读取失败：${errText(ws.error || '未知错误')}`)
        if (mcp && mcp.ok && Array.isArray(mcp.servers)) setServers(mcp.servers)
        else if (mcp) errs.push(`MCP 列表读取失败：${errText(mcp.error || '未知错误')}`)
        setStatus(errs.length === 0 ? { text: '', kind: '' } : { text: errs.join('；'), kind: 'err' })
        setPhase('ready')
      }

      React.useEffect(() => { load() }, [])

      // 重新拉 MCP 列表：增删响应没带 servers 时的兜底；失败只落文案，不清空已有列表。
      const reloadServers = async () => {
        try {
          const mcp = await getJson('/second-engine/api/mcp')
          if (mcp && mcp.ok && Array.isArray(mcp.servers)) setServers(mcp.servers)
        } catch (e) { setStatus({ text: `列表刷新失败：${errText(e)}`, kind: 'err' }) }
      }

      // 增删成功后就地更新：优先后端回传的 servers，缺了就重新拉一次（契约只保证 GET 带 servers）。
      const applyServers = async (r) => {
        if (r && Array.isArray(r.servers)) setServers(r.servers)
        else await reloadServers()
      }

      // 开关：两档互切（disabled ↔ live）。
      const toggleSearch = async () => {
        const next = webSearch === 'live' ? 'disabled' : 'live'
        setBusy('search'); setStatus({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/websearch', { value: next })
          if (r && r.ok) {
            const saved = String(r.value || next)
            setWebSearch(saved)
            setStatus({ text: saved === 'live' ? '已开启原生联网搜索' : '已关闭原生联网搜索', kind: 'ok' })
          } else {
            setStatus({ text: (r && r.error) || '开关写入失败', kind: 'err' })
          }
        } catch (e) { setStatus({ text: `开关写入失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      const addServer = async () => {
        const name = draft.name.trim()
        const url = draft.url.trim()
        setBusy('add'); setStatus({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/mcp', { name, url })
          if (r && r.ok) {
            await applyServers(r)
            setDraft({ name: '', url: '' })
            setStatus({ text: `已添加 MCP 服务器 ${name}`, kind: 'ok' })
          } else {
            setStatus({ text: (r && r.error) || '添加失败', kind: 'err' })
          }
        } catch (e) { setStatus({ text: `添加失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      const removeServer = async (name) => {
        setBusy('del:' + name); setStatus({ text: '', kind: '' })
        try {
          const r = await delJson('/second-engine/api/mcp/' + encodeURIComponent(name))
          if (r && r.ok) {
            await applyServers(r)
            setStatus({ text: `已删除 MCP 服务器 ${name}`, kind: 'ok' })
          } else {
            setStatus({ text: (r && r.error) || '删除失败', kind: 'err' })
          }
        } catch (e) { setStatus({ text: `删除失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      // 启用/禁用：只改 config.toml 的 enabled 字段（Codex 官方字段），保留配置段不删除。
      // 此前面板只能删，禁用后想再开就得重新填 URL —— 这个开关补上那个缺口。
      const toggleServer = async (name, enabled) => {
        setBusy('toggle:' + name); setStatus({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/mcp/' + encodeURIComponent(name), { enabled })
          if (r && r.ok) {
            await applyServers(r)
            setStatus({
              text: enabled
                ? `已启用 MCP 服务器 ${name}`
                : `已禁用 MCP 服务器 ${name}（配置保留，新会话不再连接）`,
              kind: 'ok',
            })
          } else {
            setStatus({ text: (r && r.error) || '切换失败', kind: 'err' })
          }
        } catch (e) { setStatus({ text: `切换失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      const on = webSearch === 'live'
      const name = draft.name.trim()
      const url = draft.url.trim()
      const nameInvalid = name !== '' && !/^[A-Za-z0-9_-]+$/.test(name)
      const urlInvalid = url !== '' && !/^https?:\/\//.test(url)
      const canAdd = name !== '' && url !== '' && !nameInvalid && !urlInvalid
      // 档位说明按「实际值」写：cached/indexed 是用户在 config.toml 里手改的档，面板不冒充 disabled。
      const searchHint = on
        ? '已开启：Codex 可自行联网检索（config.toml 顶层 web_search = "live"）。'
        : (webSearch === 'disabled'
          ? '已关闭：Codex 只用本地工具，不联网（config.toml 顶层 web_search = "disabled"）。'
          : `当前档位 ${webSearch}（config.toml 里手改的，不属面板两档）；点开关即写成 live。`)

      const searchRow = h('div', { className: 'dse-item' },
        h('span', { className: 'dse-item-label' }, '原生联网搜索'),
        h('span', { className: 'dse-item-value' }, WEB_SEARCH_TEXT[webSearch] || webSearch),
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
          'aria-label': '原生联网搜索', title: '开启后 Codex 可自行联网检索',
          className: 'dse-switch' + (on ? ' dse-switch-on' : ''),
          disabled: busy !== '' || phase === 'loading',
          onClick: toggleSearch,
        }, h('span', { className: 'dse-switch-knob' })),
      )

      const rows = servers.length === 0
        ? h('div', { className: 'dse-empty' }, phase === 'loading' ? '读取中…' : '暂无 MCP 服务器')
        : servers.map((s) => {
            const sname = String((s && s.name) || '')
            const surl = String((s && s.url) || '')
            const senabled = !(s && s.enabled === false)
            return h('div', { className: 'dse-prov', key: sname || surl },
              h('div', { className: 'dse-prov-head' },
                h('span', { className: 'dse-prov-name' }, sname || '（未命名）'),
                h('span', { className: 'dse-badge' }, senabled ? '已启用' : '已禁用'),
              ),
              h('p', { className: 'dse-prov-meta' }, surl || '（未配置 url）'),
              h('div', { className: 'dse-prov-actions' },
                h('button', {
                  type: 'button', className: 'dse-btn' + (senabled ? '' : ' dse-primary'),
                  disabled: busy !== '',
                  onClick: () => toggleServer(sname, !senabled),
                }, busy === 'toggle:' + sname ? '切换中…' : (senabled ? '禁用' : '启用')),
                h('button', {
                  type: 'button', className: 'dse-btn dse-danger', disabled: busy !== '',
                  onClick: () => removeServer(sname),
                }, busy === 'del:' + sname ? '删除中…' : '删除'),
              ),
            )
          })

      return h(Card,
        {
          title: '联网搜索与 MCP',
          desc: 'web_search 控制 Codex 原生联网搜索；MCP 服务器写入 config.toml 的 [mcp_servers.*] 段，切换提供方时自动保留。',
          collapsible: true,
          defaultOpen: false,
          badge: `${servers.length} 个 MCP`,
        },
        searchRow,
        h('p', { className: 'dse-hint' }, searchHint),
        h('div', { className: 'dse-field-head', style: { marginTop: '12px' } },
          h('span', { className: 'dse-label' }, 'MCP 服务器'),
          h('span', { className: 'dse-badge' }, `${servers.length} 个`),
        ),
        h('div', { className: 'dse-prov-list' }, rows),
        // 读取失败时的退路：不起眼的一次重试，不必刷新整个设置页（照 StatusCard 的刷新状态写法）。
        h('div', { className: 'dse-row' },
          h('button', {
            type: 'button', className: 'dse-btn',
            disabled: busy !== '' || phase === 'loading',
            onClick: () => { setStatus({ text: '', kind: '' }); load() },
          }, phase === 'loading' ? '读取中…' : '刷新列表'),
        ),
        h('div', { className: 'dse-form' },
          h(FormRow, { label: '名称' },
            h('input', {
              className: 'dse-input dse-grow' + (nameInvalid ? ' dse-input-invalid' : ''),
              value: draft.name, disabled: busy !== '',
              autoComplete: 'off', spellCheck: false, placeholder: '字母、数字、下划线或连字符',
              onChange: (e) => { setDraft((d) => ({ ...d, name: e.target.value })); setStatus({ text: '', kind: '' }) },
            }),
          ),
          h(FormRow, { label: 'URL' },
            h('input', {
              className: 'dse-input dse-grow' + (urlInvalid ? ' dse-input-invalid' : ''),
              value: draft.url, disabled: busy !== '',
              autoComplete: 'off', spellCheck: false, placeholder: 'https://example.com/mcp',
              onChange: (e) => { setDraft((d) => ({ ...d, url: e.target.value })); setStatus({ text: '', kind: '' }) },
            }),
          ),
          h('div', { className: 'dse-row' },
            h('button', {
              type: 'button', className: 'dse-btn dse-primary',
              disabled: busy !== '' || !canAdd, onClick: addServer,
            }, busy === 'add' ? '添加中…' : '添加 MCP'),
          ),
          nameInvalid ? h('p', { className: 'dse-hint dse-err' }, '名称只允许字母、数字、下划线和连字符') : null,
          urlInvalid ? h('p', { className: 'dse-hint dse-err' }, 'URL 必须以 http:// 或 https:// 开头') : null,
        ),
        status.text ? h('p', { className: 'dse-hint ' + (status.kind === 'err' ? 'dse-err' : 'dse-ok') }, status.text) : null,
      )
    }

    // 浏览器聊天桥卡：查状态 / 启停 / 取网址（透传桥的 ctl.sh，只有 4 个固定子命令）。
    // status 走桥的 status-json；url 只在点「打开网页」时现取——token 不进常驻内存、不留日志。
    function BridgeCard() {
      const [st, setSt] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState({ text: '', kind: '' })

      const load = async () => {
        try {
          const r = await getJson('/second-engine/api/bridge/status')
          setSt(r)
        } catch (e) { setMsg({ text: `聊天桥状态读取失败：${errText(e)}`, kind: 'err' }) }
      }
      React.useEffect(() => { load() }, [])

      const doStart = async () => {
        setBusy('start'); setMsg({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/bridge/start', {})
          if (r && r.ok) { setMsg({ text: '聊天桥已启动', kind: 'ok' }); await load() }
          else setMsg({ text: (r && r.error) || '启动失败', kind: 'err' })
        } catch (e) { setMsg({ text: `启动失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      const doStop = async () => {
        setBusy('stop'); setMsg({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/bridge/stop', {})
          if (r && r.ok) { setMsg({ text: '聊天桥已停止（挂在它上面的终端 TUI 会一起断开）', kind: 'ok' }); await load() }
          else setMsg({ text: (r && r.error) || '停止失败', kind: 'err' })
        } catch (e) { setMsg({ text: `停止失败：${errText(e)}`, kind: 'err' }) }
        setBusy('')
      }

      const openPage = async () => {
        setMsg({ text: '', kind: '' })
        try {
          const r = await getJson('/second-engine/api/bridge/url')
          if (r && r.ok && r.url) window.open(r.url, '_blank', 'noopener')
          else setMsg({ text: (r && r.error) || '取网址失败（桥可能没在跑）', kind: 'err' })
        } catch (e) { setMsg({ text: `取网址失败：${errText(e)}`, kind: 'err' }) }
      }

      const web = (st && st.web) || {}
      const running = !!(web.running || (st && st.as && st.as.running))
      const stateText = st === null
        ? '读取中…'
        : (running ? `运行中（网页端口 ${web.port || '?'}${web.pid ? ' · pid ' + web.pid : ''}）` : '未运行')

      return h(Card,
        {
          title: '浏览器聊天桥',
          desc: '网页聊天界面，与终端共享同一批 Codex 会话。启动/停止都幂等；停止会断开挂在它上面的终端 TUI。',
          collapsible: true,
          defaultOpen: false,
          badge: st === null ? '读取中' : (running ? '运行中' : '未运行'),
        },
        h('div', { className: 'dse-item' },
          h('span', { className: 'dse-item-label' }, '状态'),
          h('span', { className: 'dse-item-value' }, stateText),
        ),
        h('div', { className: 'dse-row', style: { marginTop: '8px' } },
          h('button', {
            type: 'button', className: 'dse-btn dse-primary',
            disabled: busy !== '' || running, onClick: doStart,
          }, busy === 'start' ? '启动中…' : '启动'),
          h('button', {
            type: 'button', className: 'dse-btn',
            disabled: busy !== '' || !running, onClick: openPage,
          }, '打开网页'),
          h('button', {
            type: 'button', className: 'dse-btn dse-danger',
            disabled: busy !== '' || !running, onClick: doStop,
          }, busy === 'stop' ? '停止中…' : '停止'),
          h('button', {
            type: 'button', className: 'dse-btn',
            disabled: busy !== '' || st === null,
            onClick: () => { setMsg({ text: '', kind: '' }); load() },
          }, '刷新状态'),
        ),
        running && st && st.healthy === false
          ? h('p', { className: 'dse-hint dse-err' }, '进程在，但健康检查没过（app-server 可能还没就绪）')
          : null,
        msg.text ? h('p', { className: 'dse-hint ' + (msg.kind === 'err' ? 'dse-err' : 'dse-ok') }, msg.text) : null,
      )
    }

    // ── 协作模式卡（两位 + 三预设，2026-10-25）──
    // 真值 = /api/config 回包的 collab；preset 由服务端派生，客户端只渲染、绝不自算
    //（env 覆盖 / 自定义态 / 失败不回滚的正确性全押在这条上）。写路径唯一：save()。
    const COLLAB_PRESET_NAMES = { review: '普通复核', propose: '协作提议', longtask: '长任务配合', custom: '自定义' }
    // 当前模式说明（desc 跟随服务端派生的 preset 变化；加载中回落基础句）。
    const COLLAB_MODE_DESC = {
      review: '只答问、不主动推荐；任务形态由任务本身决定。',
      propose: '允许它主动说「这块我能接管 / 建议拉长会话」，开不开长会话由你裁决。',
      longtask: '允许提议，且分阶段任务直接走长会话 + 看板。',
      custom: '两位单独组合：当前「关提议 · 自动长会话」（由下方开关决定）。',
    }
    function CollabCard() {
      const [collab, setCollab] = React.useState(null)   // null = 加载中
      const [busy, setBusy] = React.useState(false)      // 请求锁：期间全控件禁用（防连点）
      const [msg, setMsg] = React.useState({ text: '', kind: '' })

      const load = async () => {
        try {
          const r = await getJson('/second-engine/api/config')
          if (r && r.collab) setCollab(r.collab)
          else if (r && r.ok) setMsg({ text: '后端未返回协作配置（插件需更新）', kind: 'err' })
        } catch (e) { setMsg({ text: `协作配置读取失败：${errText(e)}`, kind: 'err' }) }
      }
      React.useEffect(() => { load() }, [])

      // 唯一写路径：成功后 setCollab(回包) 是唯一的本地状态更新来源；失败只报错、state 不动（无乐观更新）。
      const save = async (body) => {
        setBusy(true); setMsg({ text: '', kind: '' })
        try {
          const r = await postJson('/second-engine/api/config', body)
          if (r && r.ok && r.collab) {
            setCollab(r.collab)
            // voice=on 却没写进 AGENTS.md = 真失败；voice=off 时无段是预期态，静默。
            if (r.collab.voice === 'on' && r.agentsWritten === false) {
              setMsg({ text: '已保存，AGENTS 未写入', kind: 'err' })
            }
          } else {
            setMsg({ text: (r && r.error) || '保存失败', kind: 'err' })
          }
        } catch (e) {
          setMsg({ text: `保存失败：${errText(e)}`, kind: 'err' })
        }
        setBusy(false)
      }

      const envLockVoice = collab !== null && collab.voiceSource === 'env'
      const envLockLong = collab !== null && collab.longtaskSource === 'env'
      const envAny = envLockVoice || envLockLong
      const badge = collab === null ? '读取中' : (COLLAB_PRESET_NAMES[collab.preset] || collab.preset || '未知')

      return h(Card,
        {
          title: '协作模式',
          // desc 动态：切档成功即随回包变化（collab 是唯一状态源），用户不用再猜「这个模式是什么意思」。
          desc: collab === null
            ? '第二引擎怎么参与协作：预设一次切换两位（允许提议 / 长会话自动），也可单独拨位组合。'
            : (COLLAB_MODE_DESC[collab.preset] || '第二引擎怎么参与协作：预设切换或单独拨位组合。'),
          badge,
        },
        // 任一位被 env 覆盖：点预设会写盘但生效档仍被 env 压住（回包高亮不会跳），这行解释「点了没反应」。
        envAny ? h('p', { className: 'dse-hint dse-err' }, 'env 覆盖中，预设不全生效') : null,
        // 三预设分段行：高亮只吃服务端 preset 字段；「自定义」chip 仅在 preset==='custom' 时出现，
        // 是状态显示不是按钮——第四组合（关提议+自动长会话）只能靠拨位开关进入。
        h('div', { className: 'dse-seg' },
          ['review', 'propose', 'longtask'].map((p) =>
            h('button', {
              type: 'button',
              className: 'dse-btn' + (collab !== null && collab.preset === p ? ' dse-primary' : ''),
              disabled: busy || collab === null,
              onClick: () => { void save({ preset: p }) },
            }, COLLAB_PRESET_NAMES[p])),
          collab !== null && collab.preset === 'custom'
            ? h('span', { className: 'dse-chip', title: '自定义：关提议·自动长会话' }, '自定义')
            : null,
        ),
        // 高级两位开关：env 覆盖的位灰置（title 给全文），另一位照常可拨；每次只发改动的位。
        h('div', { className: 'dse-item', style: { marginTop: '10px' } },
          h('span', { className: 'dse-item-label', title: '写入 Codex 协作协议（AGENTS.md 主动开口段）' }, '允许提议'),
          h('button', {
            type: 'button', className: 'dse-btn',
            disabled: busy || collab === null || envLockVoice,
            title: envLockVoice ? '被 SECOND_ENGINE_VOICE 覆盖，改 env 后需重启' : '写入 Codex 协作协议',
            onClick: () => { void save({ voice: collab.voice === 'on' ? 'off' : 'on' }) },
          }, collab === null ? '…' : (collab.voice === 'on' ? '开' : '关')),
        ),
        envLockVoice ? h('p', { className: 'dse-hint' }, 'env 覆盖中，需改环境变量') : null,
        h('div', { className: 'dse-item', style: { marginTop: '10px' } },
          h('span', { className: 'dse-item-label', title: '主 AI 派单倾向长会话（自动=优先长会话+看板，等裁决=升级走判据）' }, '长会话自动'),
          h('button', {
            type: 'button', className: 'dse-btn',
            disabled: busy || collab === null || envLockLong,
            title: envLockLong ? '被 SECOND_ENGINE_LONGTASK 覆盖，改 env 后需重启' : '主 AI 派单倾向长会话',
            onClick: () => { void save({ longtask: collab.longtask === 'auto' ? 'manual' : 'auto' }) },
          }, collab === null ? '…' : (collab.longtask === 'auto' ? '自动' : '等裁决')),
        ),
        envLockLong ? h('p', { className: 'dse-hint' }, 'env 覆盖中，需改环境变量') : null,
        msg.text ? h('p', { className: 'dse-hint ' + (msg.kind === 'err' ? 'dse-err' : 'dse-ok') }, msg.text) : null,
      )
    }

    // ── 死代码清理（2026-10-29 任务 2）─────────────────────────────────
    // 这里原有 Pi 卡片工厂（lib/pi-cards.js 内联进本文件的那一份）与它造的三张卡。现状：
    //   · 两张无人渲染的 Pi 卡（原 :1544-1592 与 :1595-1674）—— 全库引用为 0（grep 实测，
    //     除工厂自身 return 外无人使用），**已删**。
    //   · 第四个被点名的组件 —— 本文件里本来就没有（只在 lib/pi-cards.js 里），无需删。
    //   · PiCleanupCard —— ⚠️ 与任务书「四个名字引用全为 0」不符：PiSection 仍在渲染它
    //     （本文件 h(PiCleanupCard, { data, onRefresh })）。它依赖工厂闭包里的 useLocal/useLock/
    //     normalize/isObj/str/num/fmtBytes —— 那些若随工厂一起删，这张活卡会在渲染时
    //     ReferenceError，整个 Pi 设置面板崩（属真回归）。所以本轮只删两张死卡，
    //     工厂骨架与它的小工具**原样保留**给活卡用；Pi 侧清理卡与 Codex 的 CleanupCard
    //     并存这件事记在缺陷表 D5。
    // lib/pi-cards.js（:1 自述「不参与运行」的原始留档）本轮未动，见缺陷表 D6。

    // 下面这个工厂是 lib/pi-cards.js 内联进本文件的那一份，**已被裁到只剩一张卡**
    // （裁剪原因与去向见上方「死代码清理」注释）。宿主注入原语（h / React / Card / post）不变；
    // 本工厂不重新定义原语、不 fetch、不用 JSX；数据只从 props.data 来，唯一的网络调用是一个 POST。
    // 工厂闭包不能拆：PiCleanupCard 依赖闭包里的 localBox/useLocal/useLock/normalize 与四个小工具。
    function createPiCards(deps) {
      const { h, React, Card, StatusItem, post } = deps
      const useState = React.useState
      const useEffect = React.useEffect

      // ---- 小工具（全部局部定义，不依赖工单之外的标识符）----

      function isObj(v) {
        return v !== null && typeof v === 'object'
      }

      // 只有真正的布尔值才算「已知状态」，其余（null/undefined/缺失）交给 StatusItem 显示「检测中…」
      // ⚠️ 两张死卡删掉后本函数暂无调用方（缺陷表 D7）；纯函数、零副作用，本轮不删，等后续统一清。
      function toBool(v) {
        return v === true ? true : v === false ? false : undefined
      }

      function str(v) {
        return typeof v === 'string' ? v : ''
      }

      function num(v) {
        return typeof v === 'number' && isFinite(v) ? v : null
      }

      // 4096 -> 4.00 KB；1536*1024 -> 1.50 MB
      function fmtBytes(bytes) {
        if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '--'
        const kb = bytes / 1024
        if (kb < 1024) return kb.toFixed(2) + ' KB'
        return (kb / 1024).toFixed(2) + ' MB'
      }

      // 组件的本地状态盒放在工厂闭包里，而不是组件的 hook slot 里：宿主切换引擎、或 Card 收起
      // body 都会让组件 unmount + 重新 mount，hook slot 被清空会让在途请求的「启动中…」文案和
      // 互斥锁一起丢失，用户就能连点两次发出两个 POST。本文件同一套卡在同一时刻只会挂载一份，
      // 所以按组件名缓存是安全的（每次 createPiCards 得到独立的一套缓存）。
      // 状态盒身份跨渲染稳定，因此可以直接改字段再 bump() 触发重渲染；bump() 只在事件回调和
      // promise 回调里调用，不在渲染期调用。
      const localBox = {}

      function useLocal(key, initial) {
        // 渲染期只读这个盒子，写入全部发生在事件/promise 回调里，因此多实例并发也不会互相覆盖。
        let state = localBox[key]
        if (!state) {
          state = initial()
          state.n = 0
          state.lock = { busy: false }
          state.rerender = null
          state.bump = function () {
            state.n += 1
            if (state.rerender) state.rerender(state.n)
          }
          localBox[key] = state
        }
        useState(state.n) // 订阅点：bump() 改 n 后由这里驱动重渲染
        const setter = useState(state.n)[1]
        if (state.rerender !== setter) state.rerender = setter // 重新 mount 时把渲染出口指向新的 fiber
        return state
      }

      // 请求互斥锁：同一张卡同一时刻只允许一个在途请求，重复点击直接忽略（返回 null，调用方
      // 用 `if (!r) return` 短路）。post 的返回值/异常在这里统一归一化成 {ok, data?, error?}，
      // 组件层永远拿到合法对象，不会因为宿主返回 undefined 而炸。
      function useLock(state) {
        function run(job) {
          if (state.lock.busy) return Promise.resolve(null)
          state.lock.busy = true
          return Promise.resolve()
            .then(job)
            .then(
              (res) => normalize(res),
              (err) => ({ ok: false, error: (err && err.message) || '请求异常' }),
            )
            .then((res) => {
              state.lock.busy = false
              return res
            })
        }
        return { run }
      }

      // 宿主 post 的返回值归一化：非法返回一律按失败处理，绝不让组件抛异常
      function normalize(res) {
        if (!isObj(res)) return { ok: false, error: '没有收到后端响应' }
        if (res.ok === true) return { ok: true, data: isObj(res.data) ? res.data : null }
        return { ok: false, error: str(res.error) || '请求失败' }
      }

      // ---- 会话清理卡（原工厂里的第 4 张，也是唯一还有引用的一张）----

      function PiCleanupCard(props) {
        const state = useLocal('cleanup', function () {
          return { confirming: false, busy: false, result: '', error: '' }
        })
        const lock = useLock(state)

        // 两段式确认的第二段带 30 秒超时：避免按钮长期停在「确认清理？」被人顺手点掉。
        // prev 只在「未确认 -> 待确认」这条边上挂定时器，其余渲染不重挂，倒计时不会被无关渲染重置。
        const prev = useLocal('cleanup-prev', function () {
          return { confirming: false }
        })
        useEffect(
          function () {
            const wasPending = prev.confirming
            prev.confirming = state.confirming
            if (!state.confirming) {
              if (wasPending && prev.timer) {
                clearTimeout(prev.timer)
                prev.timer = null
              }
              return
            }
            if (wasPending) return
            prev.timer = setTimeout(function () {
              prev.timer = null
              state.confirming = false
              state.bump()
            }, 30000)
          },
          [state.confirming, prev, state],
        )
        useEffect(
          function () {
            return function () {
              if (prev.timer) {
                clearTimeout(prev.timer)
                prev.timer = null
              }
            }
          },
          [prev],
        )

        const sessions = isObj(props.data) && isObj(props.data.sessions) ? props.data.sessions : null
        const dir = sessions ? str(sessions.dir) : ''
        const count = sessions ? num(sessions.count) : null
        const size = sessions ? num(sessions.sizeBytes) : null

        function cleanup() {
          if (state.busy) return
          if (!state.confirming) {
            state.confirming = true
            state.result = ''
            state.error = ''
            state.bump()
            return
          }
          state.busy = true
          state.result = ''
          state.error = ''
          state.bump()
          lock.run(function () {
            return post('/second-engine/api/pi-cleanup', { confirm: true })
          }).then(function (r) {
            if (!r) return
            state.busy = false
            state.confirming = false
            if (r.ok) {
              const removed = isObj(r.data) ? num(r.data.removed) : null
              state.result = '已清理 ' + (removed === null ? '若干' : removed) + ' 个会话'
            } else {
              state.error = r.error
            }
            state.bump()
          })
        }

        const body = []
        if (!sessions) {
          body.push(h('p', { className: 'dse-item-desc', key: 'na' }, '未取到会话统计，请重新进入设置页加载。'))
        }
        body.push(
          h('div', { className: 'dse-item-row', key: 'dir' },
            h('span', { className: 'dse-item-label' }, '会话目录'),
            h('code', { className: 'dse-code' }, dir || '--'),
          ),
        )
        body.push(
          h('div', { className: 'dse-item-row', key: 'count' },
            h('span', { className: 'dse-form-label' /* = dse-item-label */ }, '会话数量'),
            h('span', { className: 'dse-item-value' }, count === null ? '--' : String(count)),
          ),
        )
        body.push(
          h('div', { className: 'dse-item-row', key: 'size' },
            h('span', { className: 'dse-item-label' }, '占用空间'),
            h('span', { className: 'dse-item-value' }, fmtBytes(size)),
          ),
        )
        if (state.result) body.push(h('p', { className: 'dse-item-desc', key: 'ok' }, state.result))
        if (state.error) body.push(h('p', { className: 'dse-err', key: 'err' }, state.error))
        body.push(
          h('div', { className: 'dse-item-row', key: 'ctl' },
            h('span', { className: 'dse-item-label' }, '清理'),
            h('button', {
              type: 'button',
              className: 'dse-btn dse-btn-danger',
              disabled: state.busy === true,
              onClick: cleanup,
            }, state.busy ? '清理中…' : state.confirming ? '确认清理？' : '清理'),
          ),
        )
        body.push(h('p', { className: 'dse-item-desc', key: 'warn' }, '清理会删除磁盘上的 Pi 会话记录，无法撤销。'))

        return h(Card, { title: '会话清理', badge: '不可撤销', desc: '只清理会话记录文件，不动模型配置、MCP 配置和 API Key。' }, body)
      }
      return { cleanupCard: PiCleanupCard }
    }

    // 一次性构造，不放进组件体内 —— 否则每次 render 都生成新的组件类型，React 会卸载重挂。
    const piCards = createPiCards({ h, React, Card, StatusItem, post: postJson })
    const PiCleanupCard = piCards.cleanupCard

    function PiSection() {
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        getJson('/second-engine/api/pi-panel')
          .then((r) => {
            if (!alive) return
            if (r && r.ok) { setData(r); setErr('') } else { setErr((r && r.error) || 'Pi 面板读取失败') }
          })
          .catch((e) => { if (alive) setErr(String((e && e.message) || e)) })
        return () => { alive = false }
      }, [tick])
      const refresh = () => setTick((v) => v + 1)
      return h(React.Fragment, null,
        data === null && err === '' ? h('p', { className: 'dse-intro' }, 'Pi 面板读取中…') : null,
        err !== '' ? h('p', { className: 'dse-err' }, err) : null,
        // 直接复用原版 ProviderCard：数据源由后端按引擎分流（index.js 的 7 个
        // activeEngineId()==='pi' 分支），前端零改动 —— 不维护第二套 UI。
        h(ProviderCard),
        // 复用 Codex 的 WebSearchMcpCard：后端 /api/mcp 已按引擎分流（Pi 读写 mcp.json），
        // /api/websearch 在 Pi 下如实回 disabled（Pi 无此开关，联网走 MCP）。
        h(WebSearchMcpCard),
        // 复用 Codex 的 BridgeCard：后端 /api/bridge/* 已按引擎分流，
        // 按钮（启动/打开网页/停止/刷新状态）自动与 Codex 一致，不再维护第二套。
        h(BridgeCard),
        h(PiCleanupCard, { data, onRefresh: refresh }),
      )
    }

    // 按引擎整套换面板，不在每张卡内部做行级 if。
    // 上行级 if 的真实代价：漏一处就把 Codex 的 keyring/config.toml/~/.codex/sessions
    // 显示在 Pi 面板上（E4 截图里「Pi 引擎下还写着 Codex 会话占用 1.15 MB」就是这个）。
    // 新增引擎只需加一个分支，不必回头审六张卡。
    function SecondEngineSection() {
      const [engineId, setEngineId] = React.useState('')
      React.useEffect(() => {
        let alive = true
        getJson('/second-engine/api/config')
          .then((r) => {
            if (!alive) return
            const id = r && r.engine && r.engine.active
            setEngineId(id === 'pi' ? 'pi' : 'codex')
          })
          .catch(() => { if (alive) setEngineId('codex') })
        return () => { alive = false }
      }, [])
      // 引擎未知时先只渲染与引擎无关的卡，避免先闪一屏 Codex 卡片再换掉。
      if (engineId === '') {
        return h('div', { className: 'dse-wrap' },
          h(StatusCard),
          h(CollabCard),
        )
      }
      // Pi 不渲染协作模式卡：三个预设（普通复核/协作提议/长任务配合）
      // 全部依赖 Codex 的多轮复核链路，而 Pi 的 capabilities.review === false。
      // 留一张点不动的卡比不留更糟 —— 用户会以为是自己点错了。
      if (engineId === 'pi') {
        return h('div', { className: 'dse-wrap' },
          h(StatusCard),
          h(PiSection),
        )
      }
      return h('div', { className: 'dse-wrap' },
        h(StatusCard),
        h(CollabCard),
        h(ProviderCard),
        h(WebSearchMcpCard),
        h(BridgeCard),
        h(CleanupCard),
      )
    }

    // ── 浮动小球（会话界面常驻入口，挂 shell.overlay）──
    // 贴右边缘的半露圆球：可上下拖动，松手带过渡吸回贴边；点击（位移 < 6px）
    // 展开第二引擎状态面板。整段渲染防御式，出错只是不显示，绝不影响宿主。
    const BALL_SIZE = 44
    const BALL_MARGIN = 8
    const BALL_TAP_SLOP = 6
    const BALL_POS_KEY = 'dse-ball.pos'
    const TASK_POLL_MS = 4000

    // ── 工单区（浮动球面板底部）──
    // 下发 → POST /task；列表 → GET /tasks（有 running 时每 4 秒轮询）；
    // 点行展开 output 全文（GET /task?id=，点开才取）；running 行带 [取消]。
    function taskStateText(task) {
      if (!task) return ''
      if (task.status === 'done') return `完成 · exit ${task.exitCode}`
      if (task.status === 'error') return `失败 · exit ${task.exitCode}`
      if (task.status === 'cancelled') return '已取消'
      return '运行中'
    }

    // ── 复核区（工单区上方）──
    // 提交 → POST /review（服务层自动跑多轮）；列表 → GET /tasks 里 kind==='review' 的那些；
    // 行内显示 徽标 + 第N/上限轮 + 最新 verdict，展开逐轮 issues（severity 色点）。
    function verdictText(verdict) {
      if (verdict === 'converged') return '已收敛'
      if (verdict === 'max-rounds') return '达上限 · 待裁决'
      // 阻断硬档（2026-10-26）：醒目于其他档——这是「必须停手、禁止上线」。
      if (verdict === 'blocked') return '⛔ 阻断 · 禁止上线'
      if (verdict === 'unparsed') return '解析失败'
      if (verdict === 'cancelled') return '已取消'
      if (verdict === 'error') return '出错'
      return typeof verdict === 'string' && verdict !== '' ? verdict : ''
    }

    // severity → 色点（high/critical/严重→红，low/info/轻微→绿，其余→黄）。
    function severityClass(severity) {
      const sev = String(severity === undefined || severity === null ? '' : severity).toLowerCase()
      if (sev === 'high' || sev === 'critical' || sev === '严重' || sev === '高' || sev === 'blocker') {
        return 'dse-ball-sev dse-ball-sev-high'
      }
      if (sev === 'low' || sev === 'info' || sev === '轻微' || sev === '低' || sev === 'nit') {
        return 'dse-ball-sev dse-ball-sev-low'
      }
      return 'dse-ball-sev dse-ball-sev-mid'
    }

    function reviewStateText(task) {
      const t = task && typeof task === 'object' ? task : {}
      const round = Number.isFinite(Number(t.round)) ? Number(t.round) : 0
      const maxRounds = Number.isFinite(Number(t.maxRounds)) ? Number(t.maxRounds) : 0
      const shown = round > 0 ? round : (maxRounds > 0 ? 1 : 0)
      const progress = `第${shown}/${maxRounds > 0 ? maxRounds : '?'}轮`
      let tail = '复核中'
      if (t.status === 'done') tail = verdictText(t.verdict) || '完成'
      else if (t.status === 'cancelled') tail = '已取消'
      else if (t.status === 'error') tail = verdictText(t.verdict) || '失败'
      return `${progress} · ${tail}`
    }

    function ReviewSection(props) {
      const open = !props || props.open !== false
      // P4.27（2026-10-29）：复核是 Codex 专属链路（caps.review=false 的引擎跑不了它）。
      // 之前的浮球不论引擎都渲染轮数/保存，Pi 下看着能点、点了必失败 —— 按引擎直接说明。
      const onPi = !!(props && props.onPi)
      const [rounds, setRounds] = React.useState(3) // 服务端已保存的轮数
      const [roundsDraft, setRoundsDraft] = React.useState(3) // 下拉里尚未保存的选择
      const [notice, setNotice] = React.useState(null) // { kind:'ok'|'err', text }
      const [list, setList] = React.useState([])
      const [listError, setListError] = React.useState('')
      const [expanded, setExpanded] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [version, setVersion] = React.useState(0)

      // 面板打开时：回显配置里的轮数 + 拉列表（只看复核）；有 running 时每 4 秒续拉。
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        let timer = null
        const loadConfig = async () => {
          try {
            const r = await getJson('/second-engine/api/config')
            if (!alive || !r || !r.ok) return
            const n = Number(r.reviewRounds)
            // 服务端没给轮数时别静默保留默认 3：用户会以为屏幕上看到的就是已保存配置（审阅 #14）。
            if (!Number.isFinite(n)) {
              if (alive) setNotice({ kind: 'err', text: '服务端未返回复核轮数，下拉显示的是默认值 3（未同步）' })
              return
            }
            setRounds(n)
            setRoundsDraft(n)
          } catch (e) {
            if (alive) setNotice({ kind: 'err', text: `轮数读取失败：${errText(e)}` })
          }
        }
        const load = async () => {
          try {
            const r = await getJson('/second-engine/api/tasks')
            if (!alive) return
            const all = r && r.ok && Array.isArray(r.tasks) ? r.tasks : []
            setList(all.filter((t) => t && t.kind === 'review'))
            setListError(r && r.ok ? '' : ((r && r.error) || '复核列表读取失败'))
            if (all.some((t) => t && t.status === 'running')) timer = setTimeout(load, TASK_POLL_MS)
          } catch (e) {
            if (alive) setListError(errText(e))
            // 2026-10-31 修：同工单列表 —— 一次失败不能让轮询永久停摆。
            if (alive) timer = setTimeout(load, TASK_POLL_MS)
          }
        }
        void loadConfig()
        load()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [open, version])

      // 保存复核轮数：POST /api/config { reviewRounds }，成功后以服务端返回值回显。
      const saveRounds = async () => {
        setBusy(true); setNotice(null)
        try {
          const r = await postJson('/second-engine/api/config', { reviewRounds: Number(roundsDraft) })
          if (r && r.ok) {
            const n = Number(r.reviewRounds)
            const saved = Number.isFinite(n) ? n : roundsDraft
            setRounds(saved)
            setRoundsDraft(saved)
            setNotice({ kind: 'ok', text: `已保存：复核 ${saved} 轮` })
          } else {
            setNotice({ kind: 'err', text: (r && r.error) || '轮数保存失败' })
          }
        } catch (e) { setNotice({ kind: 'err', text: `轮数保存失败：${errText(e)}` }) }
        setBusy(false)
      }

      const toggle = (id) => {
        try { setExpanded((prev) => (prev === id ? '' : id)) } catch { /* best effort */ }
      }

      const cancel = async (id) => {
        try {
          setNotice(null)
          const r = await postJson('/second-engine/api/review/cancel', { id })
          if (!r || !r.ok) setNotice({ kind: 'err', text: (r && r.error) || '取消失败' })
          setVersion((v) => v + 1)
        } catch (e) { setNotice({ kind: 'err', text: `取消失败：${errText(e)}` }) }
      }

      // 展开内容：逐轮 issues（severity 色点）+ 解析失败时的原始输出。
      const renderRounds = (taskWithRounds) => {
        const all = Array.isArray(taskWithRounds.rounds) ? taskWithRounds.rounds : []
        if (all.length === 0) {
          return [h('div', { className: 'dse-ball-round', key: 'r-empty' }, '尚无轮次结果')]
        }
        return all.map((rd, ri) => {
          const r = rd && typeof rd === 'object' ? rd : {}
          const issues = Array.isArray(r.issues) ? r.issues : []
          const title = `第${Number.isFinite(Number(r.round)) ? Number(r.round) : ri + 1}轮 · ${verdictText(r.verdict) || '—'}${issues.length > 0 ? ` · ${issues.length} 项` : ''}`
          const body = issues.length > 0
            ? issues.map((it, ii) => {
                const issue = it && typeof it === 'object' ? it : {}
                const severity = String(issue.severity || '').trim()
                const point = String(issue.point || '').trim()
                const suggestion = String(issue.suggestion || '').trim()
                return h('div', { className: 'dse-ball-issue', key: `r${ri}-i${ii}` },
                  h('span', { className: severityClass(severity) }),
                  h('span', { className: 'dse-ball-issue-body' },
                    h('span', { className: 'dse-ball-issue-point' },
                      `${severity !== '' ? `[${severity}] ` : ''}${point !== '' ? point : '（未给出问题点）'}`),
                    suggestion !== '' ? h('span', { className: 'dse-ball-issue-sug' }, ` → ${suggestion}`) : null,
                  ),
                )
              })
            : [h('div', { className: 'dse-ball-issue', key: `r${ri}-clean` },
                h('span', { className: 'dse-ball-issue-body dse-ball-issue-sug' },
                  r.raw ? `解析失败：${String(r.raw)}` : '（本轮无问题）'),
              )]
          return h('div', { key: `r-${ri}` },
            h('div', { className: 'dse-ball-round' }, title),
            body,
          )
        })
      }

      let rows = null
      try {
        rows = list.map((task, i) => {
          const t = task && typeof task === 'object' ? task : {}
          const id = typeof t.id === 'string' ? t.id : ''
          const status = t.status === 'done' || t.status === 'error' || t.status === 'cancelled' ? t.status : 'running'
          const isExpanded = expanded !== '' && expanded === id
          // 2026-10-31：取消改用中性灰（-wait）。原先是空串落基础灰、另一处落到 -run 橙色，两处不一致；
          // 也不用红 —— -bad 是 error 专用，取消是用户自己按的，标红会误导成"出错了"。
          const dot = status === 'done' ? ' dse-ball-dot-ok' : status === 'error' ? ' dse-ball-dot-bad' : status === 'cancelled' ? ' dse-ball-dot-wait' : ' dse-ball-dot-run'
          return h('div', { className: 'dse-ball-task', key: id || `review-${i}` },
            h('div', {
              className: 'dse-ball-task-head',
              role: 'button',
              tabIndex: 0,
              onClick: () => toggle(id),
              onKeyDown: (e) => { try { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id) } } catch { /* best effort */ } },
            },
              h('span', { className: 'dse-ball-dot' + dot }),
              h('span', { className: 'dse-ball-badge' }, '复核'),
              h('span', { className: 'dse-ball-task-id' }, id === '' ? '—' : id.slice(-6)),
              h('span', { className: 'dse-ball-task-state' + (t.stuckSuspect ? ' dse-ball-stuck' : '') },
                reviewStateText(t) + (t.stuckSuspect ? ' · 疑似停滞' : '')),
              status === 'running' && id !== ''
                ? h('button', {
                    type: 'button',
                    className: 'dse-ball-task-cancel',
                    onClick: (e) => { try { e.stopPropagation() } catch { /* best effort */ } void cancel(id) },
                  }, '取消')
                : null,
            ),
            isExpanded
              ? h('div', { className: 'dse-ball-task-out' },
                  t.error ? h('div', { className: 'dse-ball-issue' }, h('span', { className: 'dse-ball-issue-body dse-ball-issue-point' }, `错误：${t.error}`)) : null,
                  renderRounds(t),
                )
              : null,
          )
        })
      } catch { rows = null }

      if (onPi) {
        return h('div', { className: 'dse-ball-tasks' },
          h('p', { className: 'dse-ball-empty' }, '当前引擎（Pi）不支持互审 · 复核链路绑 Codex'),
        )
      }
      return h('div', { className: 'dse-ball-tasks' },
        // 复核由两引擎之间自动进行，不劳用户提交产出：这里只放一行轮数设置。
        h('div', { className: 'dse-ball-row' },
          h('span', { className: 'dse-ball-row-label' }, '复核轮数'),
          h('select', {
            className: 'dse-ball-select',
            value: String(roundsDraft),
            'aria-label': '复核轮数',
            disabled: busy,
            onChange: (e) => {
              try { setRoundsDraft(Number(e.target.value)); setNotice(null) } catch { /* best effort */ }
            },
          },
            h('option', { value: '1' }, '1 轮'),
            h('option', { value: '3' }, '3 轮'),
            h('option', { value: '5' }, '5 轮'),
          ),
          h('button', {
            type: 'button',
            className: 'dse-ball-btn',
            disabled: busy || roundsDraft === rounds,
            onClick: () => { void saveRounds() },
          }, busy ? '保存中…' : '保存'),
        ),
        notice && notice.text
          ? h('p', { className: 'dse-ball-hint' + (notice.kind === 'err' ? ' dse-ball-err' : ' dse-ball-ok') }, notice.text)
          : null,
        listError ? h('p', { className: 'dse-ball-hint dse-ball-err' }, `复核列表读取失败：${listError}`) : null,
        rows !== null && rows.length > 0
          ? h('div', { className: 'dse-ball-tasklist' }, rows)
          : h('p', { className: 'dse-ball-empty' }, '暂无复核 · 下发任务后这里显示进度'),
      )
    }

    function TaskSection(props) {
      const open = !props || props.open !== false
      // P4.27：工单是 codex exec 后台执行（/api/task 硬绑 Codex）。Pi 下输入框与「下发」看着可用，
      // 实际必失败；按引擎直接说明，不给假入口。
      const onPi = !!(props && props.onPi)
      const [prompt, setPrompt] = React.useState('')
      const [keepSession, setKeepSession] = React.useState(false) // 勾选=落盘会话（可 resume）；默认 ephemeral 不落盘
      const [notice, setNotice] = React.useState(null) // { kind:'ok'|'err', text }
      const [list, setList] = React.useState([])
      const [listError, setListError] = React.useState('')
      const [expanded, setExpanded] = React.useState('')
      const [outputs, setOutputs] = React.useState({}) // id → output 全文
      const [detailError, setDetailError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [version, setVersion] = React.useState(0)

      // 面板打开时拉列表；只要还有 running，就等 4 秒再拉一次（全完成后自动停）。
      // 复核任务（kind:'review'）归复核区显示，这里只保留工单。
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        let timer = null
        const load = async () => {
          try {
            const r = await getJson('/second-engine/api/tasks')
            if (!alive) return
            const all = r && r.ok && Array.isArray(r.tasks) ? r.tasks : []
            setList(all.filter((t) => !t || t.kind !== 'review'))
            setListError(r && r.ok ? '' : ((r && r.error) || '任务列表读取失败'))
            if (all.some((t) => t && t.status === 'running')) timer = setTimeout(load, TASK_POLL_MS)
          } catch (e) {
            if (alive) setListError(errText(e))
            // 2026-10-31 修：原先 catch 里不排下一次 timer ⇒ 只要有一次请求失败（**重启 Web 必现**）
            // 轮询就永久停摆，面板冻结在最后一次成功快照上（实机见过：任务已 finished 仍显示「运行中」）。
            if (alive) timer = setTimeout(load, TASK_POLL_MS)
          }
        }
        load()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [open, version])

      // 展开的行一旦不再是 running 且还没取过 output，补取一次（能看着它跑完直接读结果）。
      const expandedTask = list.find((t) => t && t.id === expanded)
      const expandedStatus = expandedTask ? expandedTask.status : ''
      const expandedOutput = expanded === '' ? undefined : outputs[expanded]
      React.useEffect(() => {
        if (!open || expanded === '' || expandedStatus === 'running') return undefined
        if (expandedOutput !== undefined) return undefined
        let alive = true
        const load = async () => {
          try {
            const r = await getJson(`/second-engine/api/task?id=${encodeURIComponent(expanded)}`)
            if (!alive) return
            if (r && r.ok && r.task) {
              const text = typeof r.task.output === 'string' ? r.task.output : ''
              setOutputs((prev) => (prev[expanded] === undefined ? { ...prev, [expanded]: text } : prev))
            } else {
              setDetailError((r && r.error) || 'output 读取失败')
            }
          } catch (e) {
            if (alive) setDetailError(errText(e))
          }
        }
        load()
        return () => { alive = false }
      }, [open, expanded, expandedStatus, expandedOutput, version])

      const submit = async () => {
        const text = prompt.trim()
        if (text === '') { setNotice({ kind: 'err', text: '工单内容不能为空' }); return }
        setBusy(true); setNotice(null)
        try {
          const r = await postJson('/second-engine/api/task', { prompt: text, ephemeral: !keepSession })
          if (r && r.ok) {
            setPrompt('')
            setNotice({ kind: 'ok', text: `已下发 ${r.id} · 完成后 App 通知` })
            setVersion((v) => v + 1)
          } else {
            setNotice({ kind: 'err', text: (r && r.error) || '下发失败' })
          }
        } catch (e) { setNotice({ kind: 'err', text: `下发失败：${errText(e)}` }) }
        setBusy(false)
      }

      const toggle = (id) => {
        try {
          setDetailError('')
          setExpanded((prev) => (prev === id ? '' : id))
        } catch { /* best effort */ }
      }

      const cancel = async (id) => {
        try {
          setNotice(null)
          const r = await postJson('/second-engine/api/task/cancel', { id })
          if (!r || !r.ok) setNotice({ kind: 'err', text: (r && r.error) || '取消失败' })
          setVersion((v) => v + 1)
        } catch (e) { setNotice({ kind: 'err', text: `取消失败：${errText(e)}` }) }
      }


      let rows = null
      try {
        // 固定只展示最近 5 条（面板高度恒定，头部×永不被挤）——更早的详情走 /api/task?id= 查询
        const visible = list.slice(0, 5)
        if (expanded !== '') {
          const et = list.find((t) => t && t.id === expanded)
          if (et && !visible.some((t) => t && t.id === expanded)) visible.push(et)
        }
        rows = visible.map((task, i) => {
          const t = task && typeof task === 'object' ? task : {}
          const id = typeof t.id === 'string' ? t.id : ''
          // 2026-10-28：白名单必须含 'cancelled' —— 否则取消态会被当成 running，
          // 于是同一张卡片出现「已取消」标题 + 「运行中，暂无输出」+ 取消按钮三件并存。
          const status = t.status === 'done' || t.status === 'error' || t.status === 'cancelled' ? t.status : 'running'
          const isExpanded = expanded !== '' && expanded === id
          const output = id === '' ? undefined : outputs[id]
          // 2026-10-31：补 cancelled 分支（原先漏了，取消态掉进 -run 橙色，与上一处不一致）。
          const dot = status === 'done' ? ' dse-ball-dot-ok' : status === 'error' ? ' dse-ball-dot-bad' : status === 'cancelled' ? ' dse-ball-dot-wait' : ' dse-ball-dot-run'
          return h('div', { className: 'dse-ball-task', key: id || `task-${i}` },
            h('div', {
              className: 'dse-ball-task-head',
              role: 'button',
              tabIndex: 0,
              onClick: () => toggle(id),
              onKeyDown: (e) => { try { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id) } } catch { /* best effort */ } },
            },
              h('span', { className: 'dse-ball-dot' + dot }),
              // 2026-10-31：标出引擎归属 —— 原先 Pi 的单混进 Codex 侧视图，根本看不出是谁跑的。
              h('span', {
                className: 'dse-ball-task-id',
                style: { opacity: 0.6, marginRight: '4px' },
                title: t.engine === 'pi' ? 'Pi 引擎' : 'Codex 引擎',
              // 2026-10-31：标出引擎归属 —— 原先 Pi 的单混进 Codex 侧视图，根本看不出是谁跑的。
              // ⚠️ 缺字段（旧后端还没加载 engine）时**不标**，绝不能默认成 Cx：
              // 那会把"不知道"说成"是 Codex"，实机已经踩过一次（Pi 的单显示成 Cx）。
              }, t.engine === 'pi' ? 'Pi' : t.engine === 'codex' ? 'Cx' : ''),
              h('span', { className: 'dse-ball-task-id' }, id === '' ? '—' : id.slice(-6)),
              h('span', { className: 'dse-ball-task-state' }, taskStateText(t)),
              status === 'running' && id !== ''
                ? h('button', {
                    type: 'button',
                    className: 'dse-ball-task-cancel',
                    onClick: (e) => { try { e.stopPropagation() } catch { /* best effort */ } void cancel(id) },
                  }, '取消')
                : null,
            ),
            isExpanded
              ? h('pre', { className: 'dse-ball-task-out' },
                  detailError !== ''
                    ? detailError
                    : status === 'running'
                      ? '运行中，暂无输出…'
                      : (output === undefined || output === '' ? '（无输出）' : output))
              : null,
          )
        })
      } catch { rows = null }

      // 2026-10-31：原先这里整块拦掉（"当前引擎（Pi）不支持工单"）。但后端 Pi 分支**确实支持**
      // API 派单（startPiTask）—— 拦掉只会造成"派了单却看不见、完成也没提示"。改为正常渲染，
      // 只把 Pi 不适用的两处（保留会话勾选 / placeholder 文案）按引擎区分。
      return h('div', { className: 'dse-ball-tasks' },
        onPi ? null : h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: '0 0 6px' } },
          h('input', { type: 'checkbox', checked: keepSession, onChange: (e) => { try { setKeepSession(e.target.checked) } catch { /* best effort */ } } }),
          '保留会话（落盘可 resume，默认不落盘）',
        ),
        h('textarea', {
          className: 'dse-ball-textarea',
          rows: 3,
          placeholder: onPi ? '工单内容（本机 pi --mode rpc 后台执行）' : '工单内容（本机 codex exec 后台执行）',
          value: prompt,
          onChange: (e) => { try { setPrompt(e.target.value) } catch { /* best effort */ } },
        }),
        h('div', { className: 'dse-ball-row' },
          h('button', {
            type: 'button',
            className: 'dse-ball-btn',
            disabled: busy || prompt.trim() === '',
            onClick: () => { void submit() },
          }, busy ? '下发中…' : '下发'),
        ),
        notice && notice.text
          ? h('p', { className: 'dse-ball-hint' + (notice.kind === 'err' ? ' dse-ball-err' : ' dse-ball-ok') }, notice.text)
          : null,
        listError ? h('p', { className: 'dse-ball-hint dse-ball-err' }, `列表读取失败：${listError}`) : null,
        rows !== null && rows.length > 0
          ? h('div', { className: 'dse-ball-tasklist' }, rows)
          : h('p', { className: 'dse-ball-empty' }, '暂无工单 · 下发后这里可查看进度'),
      )
    }

    function FloatBall() {
      const BALL_EDGE_HIDE = 14 // 贴边时藏进边缘的像素数（维持半露圆球形态）

      function edgeX(side) {
        try {
          const w = (typeof window !== 'undefined' && Number(window.innerWidth)) || 0
          return side === 'left' ? -BALL_EDGE_HIDE : Math.max(0, w - BALL_SIZE + BALL_EDGE_HIDE)
        } catch { return 0 }
      }

      function sideOf(x) {
        try {
          const w = (typeof window !== 'undefined' && Number(window.innerWidth)) || 0
          return (x + BALL_SIZE / 2) < w / 2 ? 'left' : 'right'
        } catch { return 'right' }
      }

      const [pos, setPos] = React.useState(() => {
        // 停靠位置（只记纵向 + 左右侧）；null = 沿用 CSS 默认（right:-14px; top:60%）
        try {
          const raw = localStorage.getItem(BALL_POS_KEY)
          if (!raw) return null
          const p = JSON.parse(raw)
          if (!p || !Number.isFinite(p.y)) return null
          const side = (p.side === 'left' || p.side === 'right')
            ? p.side
            : (Number.isFinite(p.x) ? sideOf(p.x) : 'right') // 兼容旧的 {x,y} 存档
          return { x: edgeX(side), y: p.y }
        } catch { /* best effort */ }
        return null
      })
      const [dragging, setDragging] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle')
      const [data, setData] = React.useState(null)
      const [bytes, setBytes] = React.useState(null)
      const [error, setError] = React.useState('')
      const ballRef = React.useRef(null)
      // 插件有新版 → 球右上角一枚红点。挂载时查一次（host 端有 1h/10min 缓存，代价可忽略）；
      // 加载中/失败/无更新都不设值 → 不渲染任何节点（连隐藏占位都不出）。
      const capsRef = React.useRef(null)      // 当前引擎能力（status 回包写入；红点轮询读它）
      const ballCapsRef = React.useRef(null)  // 同上，供「打开面板」时的版本/模型 effect 读最新能力
      const [pluginUpdate, setPluginUpdate] = React.useState(null)
      // Codex CLI 本身有新版时红点也要亮（面板底部 verline 已显示版本，这里只借它点亮红点）。
      // 与 ver 分开存：ver 的 effect 挂在 open 上（打开面板才查），红点在球上需要挂载即查。
      const [codexUpdate, setCodexUpdate] = React.useState(false)
      // 协作模式下拉（2026-10-25 改进 2，推翻此前「球只读」）：与设置页 CollabCard **各持一份
      // collab 状态、互不共享**——球这边切了档，设置页要等它重挂（重开设置页）才准，反之亦然；
      // 两边都以服务端回包为唯一真值，不存在自动同步。后人别在这里找同步逻辑。
      const [collabMenuOpen, setCollabMenuOpen] = React.useState(false)
      const [collabBusy, setCollabBusy] = React.useState(false)
      const [collabErr, setCollabErr] = React.useState('')
      // 键盘自适应：Android Chrome 里 100dvh 在 IME 动画期间不更新，面板会慢半拍才收缩。
      // visualViewport.height 先变 ⇒ 用它算可用高度，以内联 maxHeight 覆盖 CSS（仅面板打开时挂）。
      const [panelMax, setPanelMax] = React.useState(null)
      React.useEffect(() => {
        if (!open) return undefined
        const vv = typeof window !== 'undefined' ? window.visualViewport : null
        if (!vv) return undefined
        const apply = () => {
          try {
            const next = Math.max(240, Math.round(vv.height - 160))
            // 键盘动画期间会高频触发；变化小于 2px 不重渲染，避免抖动
            setPanelMax((prev) => (prev !== null && Math.abs(prev - next) < 2 ? prev : next))
          } catch { /* best effort */ }
        }
        apply()
        try {
          vv.addEventListener('resize', apply)
          vv.addEventListener('scroll', apply)
        } catch { /* best effort */ }
        return () => {
          try {
            vv.removeEventListener('resize', apply)
            vv.removeEventListener('scroll', apply)
          } catch { /* best effort */ }
        }
      }, [open])
      React.useEffect(() => {
        let alive = true
        let timer = null
        // 周期重查（2026-10-25 改）。旧版是「挂载查一次 + 只有 set(true) 没有清除分支」：
        // 升级完 codex 红点仍常亮，必须整页 reload 才熄 —— 用户实测撞到。
        // 现在两个方向都写：有新版点亮、无新版熄掉；30s 一次。
        // 代价可控：打的是本地 /second-engine/api/*，GitHub 那边另由 host 端 1h 缓存挡住，不会撞限速。
        // 查询失败时什么都不改（不是「没新版」），避免网络抖动把红点误熄。
        const POLL_MS = 30 * 1000
        const checkBoth = () => {
          getJson('/second-engine/api/plugin-version')
            .then((r) => {
              if (!alive || !r || !r.ok) return
              if (r.updateAvailable === true) setPluginUpdate({ latest: r.latest || '', htmlUrl: r.htmlUrl || '' })
              else setPluginUpdate(null)
            })
            .catch(() => { /* 保持现状 */ })
          // F4（P4.24）：/api/version 是 Codex CLI 的 GitHub release 口径（src/index.js:4828）。
          // 非 github 引擎（Pi = npm）下不发这个请求，并且要**主动熄掉红点**：
          // 不写清除分支的话，在 Codex 下亮的红点切到 Pi 后会一直亮到整页 reload（旧版同类事故）。
          const c = capsRef.current
          if (c === null) return   // status 未回（球从未打开过）：不发 Codex 版本请求；30s 后自然再试
          if (c.versionCheck !== 'github' && c.versionCheck !== 'npm') { setCodexUpdate(false); return }
          getJson('/second-engine/api/version')
            .then((r) => {
              if (!alive || !r || !r.ok) return
              setCodexUpdate(r.updateAvailable === true)
            })
            .catch(() => { /* 保持现状 */ })
        }
        checkBoth()
        timer = setInterval(checkBoth, POLL_MS)
        return () => { alive = false; if (timer) clearInterval(timer) }
      }, [])
      const gestureRef = React.useRef(null) // { startX, startY, baseX, baseY, moved }
      const lastPointerRef = React.useRef(0)

      // 拖动中把球夹在视口内（保持完全可见，方便再抓回来）
      const clampDrag = (x, y) => {
        try {
          const w = (typeof window !== 'undefined' && Number(window.innerWidth)) || 0
          const h = (typeof window !== 'undefined' && Number(window.innerHeight)) || 0
          if (!w || !h) return { x: x, y: y }
          return {
            x: Math.min(Math.max(BALL_MARGIN, x), Math.max(BALL_MARGIN, w - BALL_SIZE - BALL_MARGIN)),
            y: Math.min(Math.max(BALL_MARGIN, y), Math.max(BALL_MARGIN, h - BALL_SIZE - BALL_MARGIN)),
          }
        } catch { return { x: x, y: y } }
      }

      // 松手 / 视口变化：吸回最近的左右边缘（恢复半圆），纵向位置保留
      const docked = (p) => {
        if (!p) return p
        try {
          const h = (typeof window !== 'undefined' && Number(window.innerHeight)) || 0
          const maxY = h ? Math.max(BALL_MARGIN, h - BALL_SIZE - BALL_MARGIN) : p.y
          return { x: edgeX(sideOf(p.x)), y: Math.min(Math.max(BALL_MARGIN, p.y), maxY) }
        } catch { return p }
      }

      // 指针事件统一覆盖鼠标 / 触屏 / 触控笔（原来只有 onTouch*，鼠标拖不动），
      // setPointerCapture 保证拖出元素边界也不丢事件。
      const onPointerDown = (e) => {
        try {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          const el = ballRef.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          gestureRef.current = {
            startX: e.clientX, startY: e.clientY,
            baseX: rect.left, baseY: rect.top,
            moved: 0,
          }
          setDragging(true)
          // 按下不改位置：等真拖动（超过点击阈值）才把球拉出边缘。
          // 否则「轻点」也会先把球 clamp 成完全可见，而点击分支不吸回 →
          // 展开任务单后再点关闭，球就停在完全露出状态，必须再拖一次才回半圆。
          if (el.setPointerCapture && e.pointerId !== undefined) {
            try { el.setPointerCapture(e.pointerId) } catch { /* best effort */ }
          }
          e.preventDefault()
        } catch { /* best effort */ }
      }

      const onPointerMove = (e) => {
        try {
          const g = gestureRef.current
          if (!g) return
          const dx = e.clientX - g.startX
          const dy = e.clientY - g.startY
          const dist = Math.max(Math.abs(dx), Math.abs(dy))
          if (dist > g.moved) g.moved = dist
          if (g.moved >= BALL_TAP_SLOP) setPos(clampDrag(g.baseX + dx, g.baseY + dy))
        } catch { /* best effort */ }
      }

      const onPointerUp = (e) => {
        try {
          const g = gestureRef.current
          gestureRef.current = null
          setDragging(false)
          lastPointerRef.current = Date.now()
          if (e && e.pointerId !== undefined && ballRef.current && ballRef.current.releasePointerCapture) {
            try { ballRef.current.releasePointerCapture(e.pointerId) } catch { /* best effort */ }
          }
          if (g && g.moved < BALL_TAP_SLOP) {
            setOpen((v) => !v) // 位移 < 6px 算点击
          }
          setPos(docked) // 点击与拖动松手都吸回最近的左右边缘（对未拖动的球幂等）
        } catch { /* best effort */ }
      }

      const onClick = () => {
        try {
          // 指针点击已在 pointerup 处理，跳过随之而来的合成 click。
          if (Date.now() - lastPointerRef.current < 600) return
          setOpen((v) => !v)
        } catch { /* best effort */ }
      }

      // 位置持久化（只存纵向与左右侧，横向由视口宽度实时算）
      React.useEffect(() => {
        try {
          if (pos) localStorage.setItem(BALL_POS_KEY, JSON.stringify({ side: sideOf(pos.x), y: pos.y }))
        } catch { /* best effort */ }
      }, [pos])

      // 视口变化（横竖屏 / 窗口缩放）后重新贴边并夹回可见范围
      React.useEffect(() => {
        const onResize = () => { setPos((p) => (p ? docked(p) : p)) }
        try {
          window.addEventListener('resize', onResize)
          return () => { try { window.removeEventListener('resize', onResize) } catch { /* best effort */ } }
        } catch { return undefined }
      }, [])

      // 浮球跟随当前引擎（P4.24 阶段 C）。旧版球里**一次都没读 engine**：
      // 三行探测/版本/占用/模型名永远是 Codex 的（v2 任务书 §3.f）。
      // 这里只加一层数据分流，**不把六张卡改成逐行 caps if**（红线 5）：
      // 球本来就是单一组件，按 engineActive 整块切文案，与设置页 PiSection 的整套切换同构。
      // （当前引擎的四个派生量在下面 `const d = data` 之后算，那里才有 data）
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        try {
          setPhase('loading'); setError(''); setCollabMenuOpen(false); setCollabErr('')
        } catch { /* best effort */ }
        const load = async () => {
          try {
            const r = await getJson('/second-engine/api/status')
            if (!alive) return
            if (r && r.ok) {
              setData({
                codexBinary: !!r.codexBinary,
                configExists: !!r.configExists,
                keyConfigured: !!r.keyConfigured,
                // 协作模式预设（服务端派生）：球头部只读 chip 用；旧后端无 collab 字段 → 空串不渲染。
                collabPreset: r.collab && typeof r.collab.preset === 'string' ? r.collab.preset : '',
                // P4.24：引擎视图透传给上面四个派生量（旧后端无 engine 字段 → 全部落回 Codex 分支）。
                engine: r.engine || null,
              })
              setBytes(Number.isFinite(Number(r.sessionsBytes)) ? Number(r.sessionsBytes) : 0)
            } else {
              setData(null); setBytes(null); setError((r && r.error) || '状态读取失败')
            }
          } catch (e) {
            if (alive) { setData(null); setBytes(null); setError(errText(e)) }
          }
          if (alive) setPhase('ready')
        }
        load()
        return () => { alive = false }
      }, [open])

      // #2 版本检查：小球面板也显示 Codex 版本与新版本提示（原先只有设置页有）。
      // 打开面板时拉一次，失败静默——版本查不到不该干扰状态卡。
      // F4（P4.24）：按 versionCheck 门禁。status 与本请求同在 open 打开时起跑、顺序不保证，
      // 所以轮询到 caps 落地为止（最多 20 次 × 150ms = 3s），**宁可不发也不按 Codex 默认发**；
      // 3s 内没等到（老后端 / status 失败）就按 Codex 口径发一次，与改造前行为一致。
      const [ver, setVer] = React.useState(null)
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        let tries = 0
        let timer = null
        const fetchVer = () => getJson('/second-engine/api/version').then((r) => {
          if (alive && r && r.ok) {
            setVer({
              local: r.current || null,
              latest: r.latest || null,
              updateAvailable: !!r.updateAvailable,
              htmlUrl: r.htmlUrl || 'https://github.com/openai/codex/releases/latest',
            })
          }
        }).catch(() => { /* 静默：版本检查失败不干扰状态卡 */ })
        const tick = () => {
          if (!alive) return
          const c = ballCapsRef.current
          if (c === null) {
            if (++tries > 20) { void fetchVer(); return }   // 等不到 caps：维持改造前行为
            timer = setTimeout(tick, 150)
            return
          }
          if (c.versionCheck !== 'github' && c.versionCheck !== 'npm') { setVer(null); return }   // 两个版本源都发
          void fetchVer()
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [open])

      // v2 标题行模型名：面板打开时拉一次当前启用提供方的 model，失败静默留空
      //（面板随手开随手关，报错只会碍眼）。取 providers 里 id === active 那项的 model。
      // P4.24：这条读的是 Codex keyring（/api/providers），Pi 下不再发 —— Pi 的模型名走
      // engine.model（见 ballModel），否则 Pi 面板顶部显示的是 Codex 的模型。
      const [model, setModel] = React.useState('')
      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        const pull = () => {
          if (ballCapsRef.current !== null && ballCapsRef.current.modelSwitch !== 'config-file') return
          getJson('/second-engine/api/providers').then((r) => {
            if (!alive || !r || !r.ok) return
            const list = Array.isArray(r.providers) ? r.providers : []
            const hit = list.find((p) => p && p.id === r.active)
            setModel(hit && typeof hit.model === 'string' && hit.model !== '' ? hit.model : '')
          }).catch(() => { /* 静默：拿不到就不显示 */ })
        }
        pull()
        // 面板开着时轮询：设置页刚切了模型，球上的名字要跟着变。
        // 原先依赖只有 [open] —— 面板不关就永远不再拉，用户实测「切完还是旧的」。
        const timer = setInterval(pull, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [open])

      // 球侧切换预设（改进 2）：与设置页**同一个** POST /api/config；chip 高亮/文案只吃服务端
      // 回包的 preset 字段，绝不从两位自算。失败只报短错、不动 data（无乐观更新）；选中后菜单收起。
      const saveCollabPreset = async (preset) => {
        setCollabBusy(true); setCollabErr('')
        try {
          const r = await postJson('/second-engine/api/config', { preset })
          if (r && r.ok && r.collab && typeof r.collab.preset === 'string') {
            setData((d) => ({ ...(d || {}), collabPreset: r.collab.preset }))
          } else {
            setCollabErr((r && r.error) || '切换失败')
          }
        } catch (e) {
          setCollabErr(errText(e))
        }
        setCollabBusy(false)
        setCollabMenuOpen(false)
      }

      const statusRow = (label, ok, badText) => h('div', { className: 'dse-ball-row' },
        h('span', { className: 'dse-ball-dot' + (ok === true ? ' dse-ball-dot-ok' : ok === false ? ' dse-ball-dot-bad' : ' dse-ball-dot-wait') }),
        h('span', { className: 'dse-ball-row-label' }, label),
        h('span', { className: 'dse-ball-row-value' + (ok === false ? ' dse-ball-bad' : '') },
          ok === true ? '已就绪' : ok === false ? badText : '检测中…'),
      )

      // 拖动过就用绝对坐标（覆盖 CSS 的 right / top 默认值）；没拖动过保持原来的贴边样式。
      const ballStyle = pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto' } : undefined

      let view = null
      try {
        const d = data
        const keyOk = d ? d.keyConfigured : null
        // 浮球跟随当前引擎（P4.24 阶段 C）。旧版球里**一次都没读 engine**：三行探测 / 版本 /
        // 占用 / 模型名永远是 Codex 的（v2 任务书 §3.f）。这里只在**数据层**分流，
        // 不把六张卡改成逐行 caps if（红线 5）：球本来就是单一组件，按当前引擎整块切文案，
        // 与设置页 PiSection（:1816）的整套切换同构。旧后端无 engine 字段 → 全部落回 Codex 分支。
        const engineActive = d && d.engine && d.engine.active === 'pi' ? 'pi' : 'codex'
        const onPiBall = engineActive === 'pi'
        const ballCaps = (d && d.engine && d.engine.caps) || null
        const ballModel = d && d.engine && d.engine.model ? (d.engine.model.model || '') : ''
        const ballProbe = d && d.engine && d.engine.probe && d.engine.probe.pi ? d.engine.probe.pi : null
        const ballCleanup = d && d.engine && d.engine.cleanup ? d.engine.cleanup : null
        capsRef.current = ballCaps   // 给挂载期红点轮询读最新能力（不进依赖数组，避免循环拉）
        ballCapsRef.current = ballCaps
        // v2 标题行状态点：三项全 true = success；任一 false = error；未知（未加载/部分未知）= dimmed。
        // P4.24：Pi 引擎下这三项（codexBinary/config.toml/keyring）与当前引擎无关，
        // 拿它们点亮/点熄会让用户以为 Pi 没装好 —— 改看 Pi 自己的探测（PATH + models.json）。
        const headDotOk = onPiBall
          ? !!(ballProbe && ballProbe.inPath === true)
          : !!(d && d.codexBinary && d.configExists && d.keyConfigured)
        const headDotBad = onPiBall
          ? !!(ballProbe && ballProbe.inPath === false)
          : !!(d && (d.codexBinary === false || d.configExists === false || d.keyConfigured === false))
        const headDotCls = 'dse-ball-head-dot' + (headDotOk ? ' dse-ball-head-dot-ok' : headDotBad ? ' dse-ball-head-dot-bad' : '')
        // 版本与占用已拆成两行 kv，不再拼一行文本。
        view = h(React.Fragment, null,
          h('div', {
            ref: ballRef,
            className: 'dse-ball' + (dragging ? ' dse-ball-drag' : '') + (open ? ' dse-ball-open' : ''),
            style: ballStyle,
            role: 'button',
            tabIndex: 0,
            title: '第二引擎（可拖动）',
            'aria-expanded': open,
            'aria-label': '第二引擎状态',
            onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClick,
            onKeyDown: (e) => {
              try {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
              } catch { /* best effort */ }
            },
          },
            h('span', { className: 'dse-ball-icon' }, '二'),
            (pluginUpdate || codexUpdate) ? h('span', { className: 'dse-ball-update-dot ' + ((pos === null || sideOf(pos.x) === 'right') ? 'dse-ball-update-dot-l' : 'dse-ball-update-dot-r'), 'aria-hidden': 'true' }) : null,
          ),
          open
            ? h('div', {
                className: 'dse-ball-panel',
                role: 'dialog',
                'aria-label': '第二引擎状态',
                style: panelMax !== null ? { maxHeight: panelMax + 'px' } : undefined,
              },
                // v2 标题行承载最关键两个量：汇总状态点 + 当前模型名（等宽小字，拿不到就不渲染）。
                h('div', { className: 'dse-ball-head' },
                  h('span', { className: headDotCls }),
                  h('span', { className: 'dse-ball-title' }, '第二引擎'),
                  // 协作模式 chip（2026-10-25 收回头部：字号压到 12.5px + nowrap 后不再撑换行；
                  // 点开在面板体顶部展开竖排列表，当前项只吃服务端 preset。）
                  d && d.collabPreset
                    ? h('button', {
                        type: 'button',
                        className: 'dse-chip dse-chip-btn dse-chip-mode',
                        disabled: collabBusy,
                        title: '点开切换协作模式',
                        onClick: () => setCollabMenuOpen((v) => !v),
                      }, COLLAB_PRESET_NAMES[d.collabPreset] || d.collabPreset)
                    : null,
                  pluginUpdate
                    ? h('a', {
                        className: 'dse-ball-head-model dse-ball-ver-new',
                        href: pluginUpdate.htmlUrl || 'https://github.com/fengyu-12/dsh-second-engine/releases/latest',
                        target: '_blank', rel: 'noreferrer',
                        title: '插件有新版，点开发布页',
                      }, `版本可更新 v${pluginUpdate.latest} →`)
                    : (onPiBall
                        // Pi：模型名来自 engine.model（后端 engineView），fallback 时明说是配置默认值，
                        // 不冒充 runtime 当前值（契约 4.2）。
                        ? (ballModel !== ''
                            ? h('span', { className: 'dse-ball-head-model' }, ballModel + (d.engine.model && d.engine.model.fallback ? '（默认值）' : ''))
                            : null)
                        : (model !== '' ? h('span', { className: 'dse-ball-head-model' }, model) : null)),
                  h('button', {
                    type: 'button', className: 'dse-ball-close', 'aria-label': '关闭',
                    onClick: () => setOpen(false),
                  }, '×'),
                ),
                h('div', { className: 'dse-ball-body' },
                // 协作模式小下拉（点折叠行展开）：当前项高亮只吃 d.collabPreset（服务端派生，
                // 来源＝status 回包或 saveCollabPreset 的 POST 回包）；custom 时多一枚不可点的
                // 「自定义」说明项。尺寸与 chip 同级，不做大面板。
                collabMenuOpen && d
                  ? h('div', { className: 'dse-collab-list' },
                      ['review', 'propose', 'longtask'].map((p) =>
                        h('button', {
                          type: 'button',
                          className: 'dse-collab-item' + (d.collabPreset === p ? ' dse-collab-item-on' : ''),
                          disabled: collabBusy,
                          onClick: () => { void saveCollabPreset(p) },
                        },
                          h('span', null, COLLAB_PRESET_NAMES[p]),
                          d.collabPreset === p ? h('span', { className: 'dse-collab-now' }, '当前') : null,
                        )),
                      d.collabPreset === 'custom'
                        ? h('div', { className: 'dse-collab-item dse-collab-item-on', style: { cursor: 'default' } },
                            h('span', null, '自定义'),
                            h('span', { className: 'dse-collab-now' }, '当前'),
                          )
                        : null,
                    )
                  : null,
                collabErr !== '' ? h('p', { className: 'dse-ball-hint dse-ball-err' }, `切换失败：${collabErr}`) : null,
                h('div', { className: 'dse-ball-sec' }, '运行状态'),
                // P4.24：三行探测按当前引擎整套切换（不是逐行 if）：Pi 下 config.toml / keyring
                // 与 Pi 无关，显示出来就是误导（同 client.js:1789-1792 记的 E4 事故口径）。
                onPiBall
                  ? h('div', null,
                      statusRow('Pi 可执行文件', ballProbe ? ballProbe.inPath : null, '不在 PATH'),
                      statusRow('models.json', ballProbe ? ballProbe.modelsJsonExists : null, '缺失（可选）'),
                    )
                  : h('div', null,
                      statusRow('Codex', d ? d.codexBinary : null, '未找到'),
                      statusRow('config', d ? d.configExists : null, '缺失'),
                      statusRow('Key', keyOk, '未配置'),
                      // v2：Key 常驻提示砍掉——只有明确未配置才提示一句短的；已配置/未知都不说话。
                      keyOk === false
                        ? h('p', { className: 'dse-ball-hint dse-ball-err' }, 'Key 未配置 · 去 设置 → 第二引擎')
                        : null,
                    ),
                error ? h('p', { className: 'dse-ball-hint dse-ball-err' }, `读取失败：${error}`) : null,
                // 2026-10-25 改：照设置页「Codex 版本 / 会话目录占用」两行 kv 的形态——
                // 左侧标签、右侧等宽版本号 + 同一枚徽标。原来是一行 `v{版本} · {占用}` 灰字。
                // 徽标三档与设置页 client.js:427-434 一字不差（已是最新 / 有新版 x.y.z → / 检查失败）。
                // 版本行按 versionCheck 分流（F4）：Pi 下不查 GitHub release，显示 Pi 自己的探测版本；
                // 探测不到就写「未知」，不拿 Codex 的 ver 顶（ver 在 Pi 下已被门禁置 null）。
                (ballCaps && ballCaps.versionCheck === 'npm')
                  // P4.28：Pi 也显示版本与更新徽标（npm 源），与 Codex 行同款三档。
                  ? h('div', { className: 'dse-ball-kv' },
                      h('span', { className: 'dse-ball-kv-label' }, 'Pi 版本'),
                      h('span', { className: 'dse-ball-kv-value' }, ver === null ? '检查中…' : (ver.local || '未知')),
                      ver === null
                        ? null
                        : (ver.updateAvailable
                            ? h('a', { className: 'dse-badge dse-badge-warn', href: ver.htmlUrl, target: '_blank', rel: 'noreferrer' }, `有新版 ${ver.latest} →`)
                            : (ver.latest === null
                                ? h('span', { className: 'dse-badge' }, '检查失败')
                                : h('span', { className: 'dse-badge dse-badge-ok' }, '已是最新'))),
                    )
                  : h('div', { className: 'dse-ball-kv' },
                      h('span', { className: 'dse-ball-kv-label' }, 'Codex 版本'),
                      h('span', { className: 'dse-ball-kv-value' }, ver === null ? '检查中…' : (ver.local || '未知')),
                      ver === null
                        ? null
                        : (ver.updateAvailable
                            ? h('a', { className: 'dse-badge dse-badge-warn', href: ver.htmlUrl, target: '_blank', rel: 'noreferrer' }, `有新版 ${ver.latest} →`)
                            : (ver.latest === null
                                ? h('span', { className: 'dse-badge' }, '检查失败')
                                : h('span', { className: 'dse-badge dse-badge-ok' }, '已是最新'))),
                    ),
                // 占用数字来自顶层 codex* 兼容字段（sessionsBytes = ~/.codex/sessions，src/index.js:103/1224）。
                // Pi 引擎下这个数字与当前引擎无关 ⇒ 整行不渲染（改文案不算豁免，见 :494-496 同一条教训）；
                // 有 cleanup.dir 时至少告诉用户「这个数是谁家的」。
                onPiBall
                  ? null
                  : h('div', { className: 'dse-ball-kv' },
                      h('span', { className: 'dse-ball-kv-label' },
                        (ballCleanup && ballCleanup.appliesToEngine && ballCleanup.appliesToEngine !== 'codex')
                          ? 'Codex 会话占用' : '会话目录占用'),
                      h('span', { className: 'dse-ball-kv-value' }, bytes === null ? '—' : humanize(bytes)),
                    ),
                h('div', { className: 'dse-ball-sec' }, '复核'),
                h(ReviewSection, { open, onPi: onPiBall }),
                h('div', { className: 'dse-ball-sec' }, '工单'),
                h(TaskSection, { open, onPi: onPiBall }),
                phase === 'loading' ? h('p', { className: 'dse-ball-hint' }, '状态读取中…') : null,
                ),
              )
            : null,
        )
      } catch { view = null }
      return view
    }

    function apply(ctx) {
      // 注册保持防御式：DSH 版本差异时降级，而不是在 client 启动期抛错导致黑屏。
      try { ctx.effect(installStyles) } catch { /* best effort */ }

      // 浮动小球：会话界面常驻入口（照 dsh-plugin-guard 的 BootHeartbeat 写法挂 shell.overlay）。
      try {
        const slots = ctx.slots
        slots.inject('shell.overlay', () => slots.register(
          { name: 'shell.overlay', id: 'second-engine-float' },
          FloatBall,
        ))
      } catch { /* best effort */ }

      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'second-engine', order: 55, label: '第二引擎' },
          SecondEngineSection,
        ))
      } catch { /* best effort */ }
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
