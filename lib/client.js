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
//   websearch      POST 写 web_search { value: disabled|cached|indexed|live }
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
.dse-wrap{display:flex;flex-direction:column;gap:14px;min-height:320px;max-height:78vh;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.dse-intro{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
.dse-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;transition:border-color .16s,background .16s}
.dse-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dse-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dse-card-title{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dse-card-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:6px;width:100%;padding:0;margin:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dse-card-arrow{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}
.dse-card-arrow-open{transform:rotate(90deg)}
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
.dse-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
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
.dse-ball{position:fixed;right:-14px;top:60%;width:44px;height:44px;border-radius:999px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:18px;line-height:1;cursor:pointer;z-index:9999;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;box-shadow:0 4px 14px rgba(0,0,0,.28);opacity:.92;transition:top .18s ease,opacity .16s ease,border-color .16s ease}
.dse-ball:hover{opacity:1;border-color:var(--dsw-alias-label-dimmed)}
.dse-ball-drag{transition:opacity .16s ease;cursor:grabbing}
.dse-ball-open{background:var(--dsw-alias-interactive-bg-hover-solid);border-color:var(--dsw-alias-label-dimmed)}
.dse-ball-icon{display:block;transform:translateX(-6px)}
.dse-ball-panel{position:fixed;right:8px;top:50%;transform:translateY(-50%);width:min(300px,78vw);box-sizing:border-box;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:12px 14px;z-index:9999;pointer-events:auto;box-shadow:0 10px 30px rgba(0,0,0,.36);animation:dse-ball-in .18s ease-out}
@keyframes dse-ball-in{from{opacity:0;transform:translate(16px,-50%)}to{opacity:1;transform:translate(0,-50%)}}
.dse-ball-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dse-ball-title{flex:1;min-width:0;font-size:13px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dse-ball-close{flex:none;font:inherit;font-size:13px;line-height:1;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;width:22px;height:22px;padding:0;cursor:pointer}
.dse-ball-close:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.dse-ball-sec{font-size:11px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:10px 0 2px}
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
.dse-ball-dot-run{background:var(--dsw-alias-state-warning-primary,#f0b400)}
.dse-ball-select{font-family:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 6px;box-sizing:border-box}
.dse-ball-badge{flex:none;font-size:10px;font-weight:600;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:0 6px}
.dse-ball-sev{flex:none;width:7px;height:7px;border-radius:999px;background:var(--dsw-alias-label-dimmed);margin-top:5px}
.dse-ball-sev-high{background:var(--dsw-alias-state-error-primary)}
.dse-ball-sev-mid{background:var(--dsw-alias-state-warning-primary,#f0b400)}
.dse-ball-sev-low{background:var(--dsw-alias-state-success-primary)}
.dse-ball-round{font-size:11px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:6px 0 1px}
.dse-ball-issue{display:flex;gap:6px;font-size:11px;line-height:1.45;padding:2px 0;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dse-ball-issue-body{flex:1;min-width:0}
.dse-ball-issue-point{color:var(--dsw-alias-label-primary)}
.dse-ball-issue-sug{color:var(--dsw-alias-label-tertiary)}
.dse-ball-stuck{color:var(--dsw-alias-state-warning-primary,#f0b400)}
.dse-switch{flex:none;position:relative;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer;padding:0;transition:background .16s,border-color .16s}
.dse-switch:hover{border-color:var(--dsw-alias-label-dimmed)}
.dse-switch[disabled]{opacity:.5;cursor:not-allowed}
.dse-switch.dse-switch-on{background:var(--dsw-alias-state-business-primary);border-color:transparent}
.dse-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .16s}
.dse-switch.dse-switch-on .dse-switch-knob{transform:translateX(18px)}
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

      return h('div', { className: 'dse-card' },
        h('div', { className: 'dse-card-head' },
          h('h4', { className: 'dse-card-title' },
            collapsible
              ? h('button', {
                  type: 'button',
                  className: 'dse-card-toggle',
                  'aria-expanded': open,
                  onClick: () => setOpen((value) => !value),
                },
                  props.title,
                  h('span', { className: 'dse-card-arrow' + (open ? ' dse-card-arrow-open' : ''), 'aria-hidden': true }, '▸'),
                )
              : props.title,
          ),
          props.badge ? h('span', { className: 'dse-badge' }, props.badge) : null,
        ),
        props.desc ? h('p', { className: 'dse-card-desc' }, props.desc) : null,
        open ? h('div', { className: 'dse-card-body' }, props.children) : null,
      )
    }

    function StatusCard() {
      const [phase, setPhase] = React.useState('loading')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [bytes, setBytes] = React.useState(null)

      const refresh = async () => {
        setPhase('loading'); setError('')
        try {
          const r = await getJson('/second-engine/api/status')
          if (r && r.ok) {
            setData({
              codexBinary: !!r.codexBinary,
              configExists: !!r.configExists,
              keyConfigured: !!r.keyConfigured,
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
      const [ver, setVer] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        getJson('/second-engine/api/version').then((r) => {
          if (alive && r && r.ok) setVer({ local: r.current || null, latest: r.latest || null, updateAvailable: !!r.updateAvailable, htmlUrl: r.htmlUrl || 'https://github.com/openai/codex/releases/latest' })
        }).catch(() => { /* 静默：版本检查失败不干扰状态卡 */ })
        return () => { alive = false }
      }, [])

      const d = data
      return h(Card,
        {
          title: '引擎状态',
          desc: 'Codex 二元引擎的本地安装、配置与密钥可用性（只在本地探测，不上报）。',
          badge: phase === 'loading' ? '检测中' : '实时探测',
        },
        h(StatusItem, { label: 'Codex 可执行文件', ok: d ? d.codexBinary : null, badText: '未找到' }),
        h(StatusItem, { label: '配置文件 config.toml', ok: d ? d.configExists : null, badText: '缺失' }),
        h(StatusItem, { label: 'API Key', ok: d ? d.keyConfigured : null, badText: '未配置' }),
        h('div', { className: 'dse-kv' },
          h('span', { className: 'dse-kv-label' }, 'Codex 版本'),
          h('span', { className: 'dse-kv-value' },
            ver === null ? '检查中…' : [
              ver.local || '未知',
              ver.updateAvailable
                ? h('a', { key: 'up', href: ver.htmlUrl, target: '_blank', rel: 'noreferrer', style: { color: '#e6b800', marginLeft: '6px' } }, `有新版 ${ver.latest} →`)
                : (ver.latest === null ? h('span', { key: 'na', style: { color: '#888', marginLeft: '6px' } }, '检查失败') : h('span', { key: 'ok', style: { color: '#3fb96f', marginLeft: '6px' } }, '已是最新')),
            ]),
        ),
        h('div', { className: 'dse-kv' },
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
      const [draft, setDraft] = React.useState({ id: '', name: '', baseUrl: '', wireApi: 'responses', model: '' })
      const [models, setModels] = React.useState(null)
      const [modelMsg, setModelMsg] = React.useState({ text: '', kind: '' })

      const load = async () => {
        setPhase('loading'); setLoadError('')
        try {
          const r = await getJson('/second-engine/api/providers')
          if (r && r.ok) {
            setActive(typeof r.active === 'string' ? r.active : '')
            setProviders(Array.isArray(r.providers) ? r.providers : [])
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
        const r = await postJson('/second-engine/api/providers', { id, name, baseUrl, wireApi: draft.wireApi, model })
        if (r && r.ok) {
          setDraft({ id: '', name: '', baseUrl: '', wireApi: 'responses', model: '' })
          setShowAdd(false)
          setStatus({ text: `已添加「${name}」（${id}），可点「启用」切换过去。`, kind: 'ok' })
          await load()
        } else {
          setStatus({ text: (r && r.error) || '添加失败', kind: 'err' })
        }
      })

      const activeProvider = providers.find((p) => p && p.id === active) || null

      // 逐个提供方一行；单行结构异常只吞掉这次渲染，不影响整卡。
      let rows = null
      try {
        rows = providers.map((p) => {
          const configured = !!(p && p.apiKey && p.apiKey.configured)
          const isActive = p.id === active
          // 预设判定与服务层 PROTECTED_IDS 对齐：只有 deepseek/zhipu 不可删。
          const isPreset = p.id === 'deepseek' || p.id === 'zhipu'
          // 'completions' = 上游只说 chat，经本地翻译桥接入（Codex 侧仍是 responses）。
          const bridged = (p.wireApi || 'responses') === 'completions'
          return h('div', { className: 'dse-prov', key: p.id },
            h('div', { className: 'dse-prov-head' },
              h('span', { className: 'dse-dot' + (configured ? ' dse-dot-ok' : ' dse-dot-bad') }),
              h('span', { className: 'dse-prov-name' }, p.name || p.id),
              isActive ? h('span', { className: 'dse-badge' }, '当前启用') : null,
              bridged ? h('span', { className: 'dse-badge' }, '桥') : null,
              h('span', { className: 'dse-prov-id' }, p.id),
            ),
            h('p', { className: 'dse-prov-meta' },
              `${p.baseUrl || '未配置地址'} · 协议 ${bridged ? 'chat（经本地桥）' : 'responses（直连）'} · 模型 ${p.model || '未设置'} · `,
              configured ? `Key ${p.apiKey.preview}` : 'Key 未配置',
            ),
            h('div', { className: 'dse-prov-actions' },
              h('button', {
                type: 'button',
                className: 'dse-btn' + (isActive ? '' : ' dse-primary'),
                disabled: busy !== '' || isActive,
                onClick: () => enable(p.id),
              }, isActive ? '已启用' : (busy === 'active:' + p.id ? '启用中…' : '启用')),
              h('button', {
                type: 'button', className: 'dse-btn', disabled: busy !== '',
                onClick: () => {
                  setOpenKeyId(openKeyId === p.id ? '' : p.id)
                  setKeyDraft('')
                  setEditingId('')
                  setStatus({ text: '', kind: '' })
                },
              }, '填 Key'),
              h('button', {
                type: 'button', className: 'dse-btn', disabled: busy !== '',
                onClick: () => openEdit(p),
              }, editingId === p.id ? '收起' : '编辑'),
              isPreset ? null : h('button', {
                type: 'button', className: 'dse-btn dse-danger', disabled: busy !== '',
                onClick: () => removeProvider(p.id),
              }, busy === 'del:' + p.id ? '删除中…' : '删'),
            ),
            openKeyId === p.id && editingId !== p.id ? h('div', { className: 'dse-prov-actions' },
              h('input', {
                className: 'dse-input dse-grow', type: 'password', value: keyDraft, disabled: busy !== '',
                autoComplete: 'off', spellCheck: false, placeholder: '粘贴 key 后点保存（保存即清空）',
                onChange: (e) => { setKeyDraft(e.target.value); setStatus({ text: '', kind: '' }) },
              }),
              h('button', {
                type: 'button', className: 'dse-btn dse-primary', disabled: busy !== '',
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
                  type: 'button', className: 'dse-btn dse-primary', disabled: busy !== '',
                  onClick: () => saveEdit(p.id),
                }, busy === 'edit:' + p.id ? '保存中…' : '保存'),
                h('button', {
                  type: 'button', className: 'dse-btn', disabled: busy !== '',
                  onClick: () => { setEditingId(''); setEditDraft({ name: '', baseUrl: '', model: '', apiKey: '' }); setStatus({ text: '', kind: '' }) },
                }, '取消'),
              ),
            ) : null,
          )
        })
      } catch { rows = null }

      return h(Card,
        {
          title: '模型提供方',
          desc: '管理 Codex 的 provider 目录：启用、编辑、写入 Key（仅脱敏回显）、删除自定义项，并为当前启用项挑选模型。',
          badge: phase === 'loading' ? '读取中' : 'keyring',
        },
        providers.length === 0
          ? h('p', { className: 'dse-empty' }, phase === 'loading' ? '读取提供方…' : '暂无提供方')
          : h('div', { className: 'dse-prov-list' }, rows),
        loadError ? h('p', { className: 'dse-hint dse-err' }, `提供方列表读取失败：${loadError}`) : null,
        status.text ? h('p', { className: 'dse-hint ' + (status.kind === 'err' ? 'dse-err' : 'dse-ok') }, status.text) : null,

        // ── 模型选择：只对当前启用的提供方开放 ──
        activeProvider
          ? h('div', { className: 'dse-form' },
              h('div', { className: 'dse-field-head' },
                h('span', { className: 'dse-label' }, `模型选择 · ${activeProvider.name || activeProvider.id}`),
              ),
              h('div', { className: 'dse-row' },
                h('span', { className: 'dse-item-value' }, '当前模型：'),
                h('span', { className: 'dse-mono' }, activeProvider.model || '未设置'),
                h('button', {
                  type: 'button', className: 'dse-btn', disabled: busy !== '', onClick: fetchModels,
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
            )
          : null,

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
                    h('option', { value: 'responses' }, 'responses（直连）'),
                    h('option', { value: 'completions' }, 'chat（经本地桥）'),
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
          badge: '不可撤销',
        },
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
            return h('div', { className: 'dse-prov', key: sname || surl },
              h('div', { className: 'dse-prov-head' },
                h('span', { className: 'dse-prov-name' }, sname || '（未命名）'),
              ),
              h('p', { className: 'dse-prov-meta' }, surl || '（未配置 url）'),
              h('div', { className: 'dse-prov-actions' },
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

    function SecondEngineSection() {
      return h('div', { className: 'dse-wrap' },
        h('p', { className: 'dse-intro' }, '第二引擎（Codex）：状态探测、提供方与模型管理、联网搜索与 MCP、会话清理。全部请求都走本机宿主路由 /second-engine/api/*。'),
        h(StatusCard),
        h(ProviderCard),
        h(WebSearchMcpCard),
        h(CleanupCard),
      )
    }

    // ── 浮动小球（会话界面常驻入口，挂 shell.overlay）──
    // 贴右边缘的半露圆球：可上下拖动，松手带过渡吸回贴边；点击（位移 < 6px）
    // 展开第二引擎状态面板。整段渲染防御式，出错只是不显示，绝不影响宿主。
    const BALL_SIZE = 44
    const BALL_MARGIN = 8
    const BALL_TAP_SLOP = 6
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
            if (!Number.isFinite(n)) return
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
          const dot = status === 'done' ? ' dse-ball-dot-ok' : status === 'error' ? ' dse-ball-dot-bad' : status === 'cancelled' ? '' : ' dse-ball-dot-run'
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
          : h('p', { className: 'dse-ball-hint' }, '暂无复核'),
      )
    }

    function TaskSection(props) {
      const open = !props || props.open !== false
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
        rows = list.map((task, i) => {
          const t = task && typeof task === 'object' ? task : {}
          const id = typeof t.id === 'string' ? t.id : ''
          const status = t.status === 'done' || t.status === 'error' ? t.status : 'running'
          const isExpanded = expanded !== '' && expanded === id
          const output = id === '' ? undefined : outputs[id]
          const dot = status === 'done' ? ' dse-ball-dot-ok' : status === 'error' ? ' dse-ball-dot-bad' : ' dse-ball-dot-run'
          return h('div', { className: 'dse-ball-task', key: id || `task-${i}` },
            h('div', {
              className: 'dse-ball-task-head',
              role: 'button',
              tabIndex: 0,
              onClick: () => toggle(id),
              onKeyDown: (e) => { try { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(id) } } catch { /* best effort */ } },
            },
              h('span', { className: 'dse-ball-dot' + dot }),
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

      return h('div', { className: 'dse-ball-tasks' },
        h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', margin: '0 0 6px' } },
          h('input', { type: 'checkbox', checked: keepSession, onChange: (e) => { try { setKeepSession(e.target.checked) } catch { /* best effort */ } } }),
          '保留会话（落盘可 resume，默认不落盘）',
        ),
        h('textarea', {
          className: 'dse-ball-textarea',
          rows: 3,
          placeholder: '工单内容（本机 codex exec 后台执行）',
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
          : h('p', { className: 'dse-ball-hint' }, '暂无工单'),
      )
    }

    function FloatBall() {
      const [topPx, setTopPx] = React.useState(null) // null = 跟随 CSS 的 top:60%
      const [dragging, setDragging] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [phase, setPhase] = React.useState('idle')
      const [data, setData] = React.useState(null)
      const [bytes, setBytes] = React.useState(null)
      const [error, setError] = React.useState('')
      const ballRef = React.useRef(null)
      const gestureRef = React.useRef(null) // { startY, startTop, moved }
      const lastTouchRef = React.useRef(0)

      // 纵向夹在视口内，避免拖出屏幕后抓不回来。
      const clampTop = (value) => {
        try {
          const vh = (typeof window !== 'undefined' && Number(window.innerHeight)) || 0
          const min = BALL_MARGIN
          if (!vh) return Math.max(min, value)
          const max = Math.max(min, vh - BALL_SIZE - BALL_MARGIN)
          return Math.min(max, Math.max(min, value))
        } catch { return value }
      }

      const onTouchStart = (e) => {
        try {
          const t = e.touches && e.touches[0]
          const el = ballRef.current
          if (!t || !el) return
          const rect = el.getBoundingClientRect()
          gestureRef.current = { startY: t.clientY, startTop: rect.top, moved: 0 }
          setDragging(true)
          setTopPx(clampTop(rect.top))
        } catch { /* best effort */ }
      }

      const onTouchMove = (e) => {
        try {
          const g = gestureRef.current
          const t = e.touches && e.touches[0]
          if (!g || !t) return
          const dy = t.clientY - g.startY
          if (Math.abs(dy) > g.moved) g.moved = Math.abs(dy)
          setTopPx(clampTop(g.startTop + dy))
        } catch { /* best effort */ }
      }

      const onTouchEnd = () => {
        try {
          const g = gestureRef.current
          gestureRef.current = null
          setDragging(false) // 撤掉过渡禁用 → top 带过渡吸回贴边
          lastTouchRef.current = Date.now()
          if (!g) return
          if (g.moved < BALL_TAP_SLOP) setOpen((v) => !v) // 位移 < 6px 算点击
        } catch { /* best effort */ }
      }

      const onClick = () => {
        try {
          // 触屏点击已在 touchend 处理，跳过随之而来的合成 click。
          if (Date.now() - lastTouchRef.current < 600) return
          setOpen((v) => !v)
        } catch { /* best effort */ }
      }

      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        try {
          setPhase('loading'); setError('')
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

      const statusRow = (label, ok, badText) => h('div', { className: 'dse-ball-row' },
        h('span', { className: 'dse-ball-dot' + (ok === true ? ' dse-ball-dot-ok' : ok === false ? ' dse-ball-dot-bad' : ' dse-ball-dot-wait') }),
        h('span', { className: 'dse-ball-row-label' }, label),
        h('span', { className: 'dse-ball-row-value' + (ok === false ? ' dse-ball-bad' : '') },
          ok === true ? '已就绪' : ok === false ? badText : '检测中…'),
      )

      let view = null
      try {
        const d = data
        const keyOk = d ? d.keyConfigured : null
        view = h(React.Fragment, null,
          h('div', {
            ref: ballRef,
            className: 'dse-ball' + (dragging ? ' dse-ball-drag' : '') + (open ? ' dse-ball-open' : ''),
            style: topPx === null ? undefined : { top: topPx + 'px' },
            role: 'button',
            tabIndex: 0,
            title: '第二引擎',
            'aria-expanded': open,
            'aria-label': '第二引擎状态',
            onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd, onClick,
            onKeyDown: (e) => {
              try {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
              } catch { /* best effort */ }
            },
          },
            h('span', { className: 'dse-ball-icon' }, '二'),
          ),
          open
            ? h('div', { className: 'dse-ball-panel', role: 'dialog', 'aria-label': '第二引擎状态' },
                h('div', { className: 'dse-ball-head' },
                  h('span', { className: 'dse-ball-title' }, '第二引擎'),
                  h('button', {
                    type: 'button', className: 'dse-ball-close', 'aria-label': '关闭',
                    onClick: () => setOpen(false),
                  }, '×'),
                ),
                h('div', { className: 'dse-ball-sec' }, '引擎状态'),
                statusRow('Codex 可执行文件', d ? d.codexBinary : null, '未找到'),
                statusRow('配置 config.toml', d ? d.configExists : null, '缺失'),
                statusRow('API Key', keyOk, '未配置'),
                h('div', { className: 'dse-ball-kv' },
                  h('span', { className: 'dse-ball-row-label' }, '会话目录占用'),
                  h('span', { className: 'dse-ball-kv-value' }, bytes === null ? '—' : humanize(bytes)),
                ),
                error ? h('p', { className: 'dse-ball-hint dse-ball-err' }, `读取失败：${error}`) : null,
                h('div', { className: 'dse-ball-sec' }, 'Key'),
                statusRow('API Key', keyOk, '未配置'),
                h('p', { className: 'dse-ball-hint' + (keyOk === true ? ' dse-ball-ok' : '') },
                  keyOk === true
                    ? '已配置。需要更换请去 设置 → 第二引擎。'
                    : '未配置。去 设置 → 第二引擎 粘贴 API Key 后保存。'),
                h('div', { className: 'dse-ball-sec' }, '复核'),
                h(ReviewSection, { open }),
                h('div', { className: 'dse-ball-sec' }, '工单'),
                h(TaskSection, { open }),
                phase === 'loading' ? h('p', { className: 'dse-ball-hint' }, '状态读取中…') : null,
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
