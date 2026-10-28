# 按引擎能力渲染设置面板 · 改造清单（外部模型产出，2026-10-28）

> 供应用参考。行号以当时上传的片段为准（client-settings-snippet.js / status-config-snippet.js）。

核对完毕：三个片段都读了；`rtOf` 与 Pi 回落名单**不在任何上传文件里**（`grep rtOf|anthropic|models.json` 在 `uploads/index.js` 与 zip 版 `src/index.js` 均 0 命中），所以按你给的规则实现、不声称行号。片段里也**没有**「协作模式 / 浏览器聊天桥 / 复核轮数」三张卡（grep 0 命中），那三处按你点名的条件给改法。

## 后端 `status-config-snippet.js`

**B1 · `handleStatus`（片段 :1-20）新增 engine 探测**
```js
async function handleStatus(_req, res) {
  try {
    const active = activeEngineId()
    const caps = ENGINES[active].capabilities
    send(res, {
      ok: true,
      ...
-     engine: { active: activeEngineId(), list: engineList() },
+     engine: {
+       active, list: engineList(), caps,
+       model: activeEngineModel(active),   // B3
+       probe: await engineProbe(active),   // B2
+     },
+     // 保留顶层 codex* 字段（浮球面板还在读），只是不再作为面板真相来源
    })
```

**B2 · 新增 Pi 探测（spawn 一次 + 缓存；`execFile` 已在 :39 导入）**
```js
const PI_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json')
const PI_PROBE_TTL_MS = 60_000
let piProbeCache = { at: 0, value: null }
function piProbe() {
  if (Date.now() - piProbeCache.at < PI_PROBE_TTL_MS) return piProbeCache.value
  // which 用 spawnSync（同 :1617 的 df 写法）；version 同理，超时就当未安装
  let path = ''
  try {
    const w = spawnSync('sh', ['-lc', 'command -v pi'], { timeout: 3000 })
    path = w.status === 0 ? String(w.stdout || '').trim() : ''
  } catch { path = '' }
  let version = ''
  if (path !== '') {
    try {
      const v = spawnSync(path, ['--version'], { timeout: 8000 })
      const m = /(\d+\.\d+\.\d+)/.exec(String(v.stdout || '') + String(v.stderr || ''))
      if (m !== null) version = m[1]
    } catch { version = '' }
  }
  let modelsJsonExists = false
  try { modelsJsonExists = existsSync(PI_MODELS_PATH) } catch { /* 视为 false */ }
  piProbeCache = { at: Date.now(), value: { inPath: path !== '', path, version, modelsJsonPath: PI_MODELS_PATH, modelsJsonExists } }
  return piProbeCache.value
}
async function engineProbe(id) {
  return id === 'pi' ? { pi: piProbe() } : { pi: null }   // codex 沿用现有 codexBinary/configExists
}
```

**B3 · `engine.model`（codex→keyring active；pi→registry 回落）**
```js
// Pi 只认这 7 家（规则来自 index.js 的 rtOf；该函数不在本次片段内，名单按需求写死）
const PI_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'gemini', 'openrouter', 'kimi', 'moonshot']
function activeEngineModel(id) {
  try {
    const doc = loadKeyring()
    if (id !== 'pi') {
      const p = doc.providers.find((x) => x.id === doc.active)
      return { providerId: doc.active, model: p?.model || '', fallback: false, switchHint: 'config-file' }
    }
    const hit = doc.providers.find((x) => PI_PROVIDERS.includes(x.id) && (x.model || '') !== '')
    if (hit !== undefined) return { providerId: hit.id, model: hit.model, fallback: false, switchHint: 'runtime-command' }
    // 回落链：keyring 没有可用 provider → 读 pi models.json 的默认模型（读不到留空，不猜）
    let piDefault = ''
    try {
      const j = JSON.parse(readFileSync(PI_MODELS_PATH, 'utf8'))
      piDefault = typeof j?.defaultModel === 'string' ? j.defaultModel : ''
    } catch { /* 文件不存在/非 JSON：如实留空 */ }
    return { providerId: '', model: piDefault, fallback: true, switchHint: 'runtime-command' }
  } catch { return { providerId: '', model: '', fallback: true, switchHint: '' } }
}
```
**B4 · `handleConfigGet`（片段 :23）**：`engine: {...}` 同样换成 `{active, list, caps}`（复用 `activeEngineId()`/`engineList()`，别复制第二份能力表）。

## 前端 `client-settings-snippet.js`

**F1 · `refresh()` 解析块（:2-9）带上 caps/probe/model**
```js
  setData({ codexBinary: !!r.codexBinary, configExists: !!r.configExists,
-           keyConfigured: !!r.keyConfigured, engine: r.engine || null })
+           keyConfigured: !!r.keyConfigured, engine: r.engine || null })
+   // engine.caps 是本次条件渲染的唯一依据；缺失时按 codex 兜底（老后端不返回 caps）
```
紧接 :29 之后加一行统一取 caps（后续各处都用 `caps`）：
```js
const caps = (d?.engine?.caps) || { eventStream:'fine', approvals:false, resume:true, review:true, chatBridge:true, modelSwitch:'config-file', versionCheck:'github' }
```

**F2 · 卡头 desc（:35-36）**
```js
- desc: 'Codex 二元引擎的本地安装、配置与密钥可用性（只在本地探测，不上报）。',
+ desc: `${d?.engine?.active === 'pi' ? 'Pi' : 'Codex'} 引擎的本地安装与可用性（只在本地探测，不上报）。`,
```

**F3 · 三行 Codex 探测（:68-70）→ 按引擎换内容**
```js
- h(StatusItem, { label: 'Codex 可执行文件', ok: d ? d.codexBinary : null, badText: '未找到' }),
- h(StatusItem, { label: '配置文件 config.toml', ok: d ? d.configExists : null, badText: '缺失' }),
- h(StatusItem, { label: 'API Key', ok: d ? d.keyConfigured : null, badText: '未配置' }),
+ d?.engine?.active === 'pi'
+   ? h(Fragment, null,
+       h(StatusItem, { label: 'Pi 可执行文件', ok: d.engine.probe?.pi ? d.engine.probe.pi.inPath : null, badText: '不在 PATH' }),
+       h(StatusItem, { label: '模型清单 models.json', ok: d.engine.probe?.pi ? d.engine.probe.pi.modelsJsonExists : null, badText: '缺失' }),
+       h('div', { className: 'dse-kv' }, h('span', { className: 'dse-kv-label' }, '当前模型'),
+         h('span', { className: 'dse-kv-value' }, d.engine.model?.model || '未知'),
+         d.engine.model?.fallback ? h('span', { className: 'dse-badge' }, '回落值') : null))
+   : h(Fragment, null, /* 原三行 StatusItem 原样保留 */),
```

**F4 · 版本行（:71-85）按 `versionCheck` 分流**
```js
- h('div', { className: 'dse-kv' }, h('span', ...,'Codex 版本'), ...)
+ caps.versionCheck === 'npm'
+   ? h('div', { className: 'dse-kv' }, h('span', { className: 'dse-kv-label' }, 'Pi 版本'),
+       h('span', { className: 'dse-kv-value' }, d?.engine?.probe?.pi?.version || '未知'))
+   : (/* 原 Codex 版本块，含 ver.updateAvailable 徽标，不动 */),
```
并把 :25-31 的 `/api/version` 请求包一层：`if (caps.versionCheck === 'github') { …原 getJson('/second-engine/api/version')… }`（Pi 下不发这个请求，省一次 GitHub 访问）。

**F5 · 会话目录占用（:86-89）+ `CleanupCard`（:498-561）改文案**
```js
- h('span', { className: 'dse-kv-label' }, '会话目录占用'),
+ h('span', { className: 'dse-kv-label' }, d?.engine?.active === 'pi' ? 'Codex 会话占用（当前引擎不使用）' : '会话目录占用'),
```
`CleanupCard` 加 `props.caps`，在 :534 的 `return h(Card, {` 前：
```js
+ if (props?.caps?.resume === false) { /* Pi：路径不是 ~/.codex/sessions */ }
  title: '会话清理',
- desc: '删除会话目录下 mtime 早于保留天数的 *.jsonl，释放磁盘占用。',
+ desc: (props?.caps?.resume === false ? '【仅清 Codex】删除 ~/.codex/sessions 下 mtime 早于保留天数的 *.jsonl；当前引擎（Pi）的会话不在此目录，不受影响。'
+       : '删除会话目录下 mtime 早于保留天数的 *.jsonl，释放磁盘占用。'),
```
（保留按钮可用：残留的 Codex 会话仍需可清；只把「清的是谁」写进 desc，比整卡隐藏更不容易误导。）

**F6 · `ProviderCard`（:109，卡头 :429-433）按 `modelSwitch` 分流**
```js
  function ProviderCard(props) {                       // ← 原 :109 无参
+   const ms = props?.caps?.modelSwitch || 'config-file'
    ...
    return h(Card, { title: '模型提供方',
-     desc: '管理 Codex 的 provider 目录：启用、编辑、写入 Key（仅脱敏回显）、删除自定义项，并为当前启用项挑选模型。',
+     desc: ms === 'runtime-command'
+       ? 'Pi 的模型在 [platform configuration redacted] 里配置；这里的改动只影响 Codex，切换引擎不会带走它。'
+       : '管理 Codex 的 provider 目录：启用、编辑、写入 Key（仅脱敏回显）、删除自定义项，并为当前启用项挑选模型。',
      ... },
+     ms === 'runtime-command'
+       ? h(Fragment, null,
+           h('div', { className: 'dse-kv' }, h('span', { className: 'dse-kv-label' }, '当前模型（只读）'),
+             h('span', { className: 'dse-kv-value' }, props.engineModel || '未知')),
+           h('p', { className: 'dse-hint' }, '改这里不影响 Pi；运行期换模型走 RPC set_model。'),
+           h('div', { className: 'dse-prov-list' }, rows))   // 列表降级为只读展示
+       : /* 原 providers 分支不变 */,
```
调用点：`h(ProviderCard, { caps, engineModel: d?.engine?.model?.model || '' })`。`ms==='runtime-command'` 时把 :446 的「添加」按钮与 :429 之后的表单块整体 `ms === 'config-file' ? … : null`。

**F7 · `WebSearchMcpCard`（:570）Pi 下隐藏并注明**
```js
+ if (props?.caps?.modelSwitch === 'runtime-command') {   // Pi 的判据；更直白可给 caps 加 mcp:'config-toml'|'mcp-json'
+   return h(Card, { title: '联网搜索与 MCP', collapsible: true, defaultOpen: false },
+     h('p', { className: 'dse-hint' }, '当前引擎（Pi）不读 config.toml：这里的开关与列表对 Pi 无效。Pi 的 MCP 配在 [platform configuration redacted]'))
+ }
```
（隐藏开关与增删，但留一张说明卡 —— 整卡消失会让人以为功能被删了。）

**F8 · 复核轮数（片段内无此卡，按条件给）**
```js
+ const reviewOn = caps.review !== false
  h('select', { className: 'dse-select', value: rounds,
+               disabled: !reviewOn || busy !== '',
    onChange: (e) => setRounds(e.target.value) },
    choices.map((n) => h('option', { key: n, value: n }, n))),
+ reviewOn ? null : h('p', { className: 'dse-hint' }, '当前引擎不支持互审，轮数设置暂不生效。'),
```

**F9 · 浏览器聊天桥卡：`caps.chatBridge === false` 时整个 `return null`（放在该卡 `return h(Card,` 之前）**；协作模式卡不动（写在插件自己的文件里，与引擎无关）。

## 两点提醒
- **`caps` 只反映「当前激活引擎」**：切引擎后必须 `refresh()`（F1 的 `refresh()` 已被 :57 的切换逻辑调用，够用），但 `ProviderCard`/`CleanupCard` 的 caps 是 props，父组件重渲染才会更新 —— 别在子组件里 `useState(caps)` 缓存。
- 片段里没 `Fragment` 的使用先例；若宿主未注入，改用 `h('div', { className: 'dse-kv-group' }, …)` 包一层即可，视觉差一档但不会白屏。
