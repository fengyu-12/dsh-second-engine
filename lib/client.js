// dsh-second-engine —— 设置 > 第二引擎（Codex）client 半。
// 数据通过 fetch 调 host 的 /second-engine/api/* HTTP 路由：
//   status  GET  引擎/密钥/会话占用概览（codexBinary / configExists / keyConfigured / sessionsBytes）
//   key     POST 写入 provider + key（返回脱敏 preview，前端不回显明文）
//   cleanup POST 按保留天数清理旧会话 *.jsonl（返回 removed / freedBytes）
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
.dse-wrap{display:flex;flex-direction:column;gap:14px;min-height:320px}
.dse-intro{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0}
.dse-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;transition:border-color .16s,background .16s}
.dse-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dse-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dse-card-title{flex:1;min-width:0;margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
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

    const PROVIDER_LABEL = { deepseek: 'DeepSeek', zhipu: '智谱 AI' }

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
      return h('div', { className: 'dse-card' },
        h('div', { className: 'dse-card-head' },
          h('h4', { className: 'dse-card-title' }, props.title),
          props.badge ? h('span', { className: 'dse-badge' }, props.badge) : null,
        ),
        props.desc ? h('p', { className: 'dse-card-desc' }, props.desc) : null,
        h('div', { className: 'dse-card-body' }, props.children),
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

    function KeyCard() {
      const [provider, setProvider] = React.useState('deepseek')
      const [key, setKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [preview, setPreview] = React.useState('')
      const [status, setStatus] = React.useState({ text: '', kind: '' })

      const save = async () => {
        const trimmed = key.trim()
        if (trimmed === '') { setStatus({ text: '请先粘贴 API Key（不能为空）', kind: 'err' }); return }
        setBusy(true); setStatus({ text: '', kind: '' }); setPreview('')
        try {
          const r = await postJson('/second-engine/api/key', { provider, key: trimmed })
          if (r && r.ok) {
            setKey('') // 保存后立即清空输入框，不回显明文
            setPreview(typeof r.preview === 'string' ? r.preview : '')
            setStatus({ text: `已保存到 ${PROVIDER_LABEL[provider] || provider} 的 keyring（文件权限 0600）。`, kind: 'ok' })
          } else {
            setStatus({ text: (r && r.error) || '保存失败', kind: 'err' })
          }
        } catch (e) {
          setStatus({ text: errText(e), kind: 'err' })
        }
        setBusy(false)
      }

      return h(Card,
        {
          title: 'API Key',
          desc: '写入 Codex 的 keyring.json；明文只在提交时传输，界面不回显。',
          badge: '密码框',
        },
        h('div', { className: 'dse-field-head' },
          h('span', { className: 'dse-label' }, '服务提供方'),
        ),
        h('div', { className: 'dse-row' },
          h('select', {
            className: 'dse-select', value: provider, disabled: busy,
            onChange: (e) => { setProvider(e.target.value); setStatus({ text: '', kind: '' }) },
          },
            h('option', { value: 'deepseek' }, 'DeepSeek'),
            h('option', { value: 'zhipu' }, '智谱 AI'),
          ),
        ),
        h('div', { className: 'dse-field-head', style: { marginTop: '10px' } },
          h('span', { className: 'dse-label' }, 'API Key'),
        ),
        h('div', { className: 'dse-row' },
          h('input', {
            className: 'dse-input dse-grow', type: 'password', value: key, disabled: busy,
            autoComplete: 'off', spellCheck: false, placeholder: '粘贴 key 后点保存',
            onChange: (e) => { setKey(e.target.value); setStatus({ text: '', kind: '' }) },
          }),
          h('button', { type: 'button', className: 'dse-btn dse-primary', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存'),
        ),
        preview
          ? h('p', { className: 'dse-hint dse-ok' },
              '当前已保存：',
              h('span', { className: 'dse-mono' }, preview),
            )
          : null,
        status.text ? h('p', { className: 'dse-hint ' + (status.kind === 'err' ? 'dse-err' : 'dse-ok') }, status.text) : null,
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

    function SecondEngineSection() {
      return h('div', { className: 'dse-wrap' },
        h('p', { className: 'dse-intro' }, '第二引擎（Codex）：状态探测、密钥写入与会话清理。全部请求都走本机宿主路由 /second-engine/api/*。'),
        h(StatusCard),
        h(KeyCard),
        h(CleanupCard),
      )
    }

    function apply(ctx) {
      // 注册保持防御式：DSH 版本差异时降级，而不是在 client 启动期抛错导致黑屏。
      try { ctx.effect(installStyles) } catch { /* best effort */ }

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
