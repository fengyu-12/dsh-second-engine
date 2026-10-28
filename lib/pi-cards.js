// ⚠️ 已内联进 lib/client.js（createPiCards，约 :1385），本文件仅作原始交付留档，不参与运行。
// lib/pi-cards.js
// Pi（~/.pi/agent/mcp.json）引擎设置页卡片组。
// 宿主注入原语（h / React / Card / StatusItem / post）。
// 本文件不重新定义原语、不 fetch、不用 JSX；数据只从 props.data 来，唯一的网络调用是三个 POST。

function createPiCards(deps) {
  const { h, React, Card, StatusItem, post } = deps
  const useState = React.useState
  const useEffect = React.useEffect

  // ---- 小工具（全部局部定义，不依赖工单之外的标识符）----

  function isObj(v) {
    return v !== null && typeof v === 'object'
  }

  // 只有真正的布尔值才算「已知状态」，其余（null/undefined/缺失）交给 StatusItem 显示「检测中…」
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

  // ---- 1. 模型提供方 ----

  function PiProviderCard(props) {
    // 只读展示：数据只来自父组件 GET /api/pi-panel 的 props.data，本卡不发任何请求。
    const d = isObj(props.data) ? props.data : null
    const providers = d && Array.isArray(d.providers) ? d.providers : null

    const body = []
    if (!providers || providers.length === 0) {
      body.push(
        h('p', { className: 'dse-item-desc', key: 'empty' }, '未取到模型提供方列表，请重新进入设置页加载。'),
      )
    }
    for (let i = 0; providers && i < providers.length; i++) {
      const p = isObj(providers[i]) ? providers[i] : {}
      const count = num(p.modelCount)
      const env = str(p.keyEnv)
      const key = str(p.id) || str(p.label) || 'provider-' + i
      body.push(
        h('div', { className: 'dse-item-row', key: key },
          h(StatusItem, { label: str(p.label) || '未命名提供方', ok: toBool(p.hasKey), badText: '未配 Key' }),
          h('span', { className: 'dse-item-value' }, count === null ? '--' : count + ' 个模型'),
        ),
      )
      // 底部小字：Key 环境变量提示
      body.push(
        h('p', { className: 'dse-item-desc', key: key + '-env' }, env ? '需要 ' + env : '未声明 Key 环境变量名'),
      )
    }

    return h(
      Card,
      {
        title: '模型提供方',
        desc: 'Pi 自己管理模型清单，本面板只读展示 providers 与 Key 是否已配置；不提供添加、删除或填写 API Key 的入口。',
      },
      body,
    )
  }

  // ---- 2. 联网搜索与 MCP ----

  function PiMcpCard(props) {
    // 只读展示：数据只来自父组件 GET /api/pi-panel 的 props.data，本卡不发任何请求。
    const d = isObj(props.data) ? props.data : null
    const mcp = d && isObj(d.mcp) ? d.mcp : null
    const body = []

    if (!mcp) {
      body.push(h('p', { className: 'dse-item-desc', key: 'na' }, '未取到 MCP 配置信息，请重新进入设置页加载。'))
      return h(Card, { title: '联网搜索与 MCP' }, body)
    }

    body.push(
      h('div', { className: 'dse-item-row', key: 'path' },
        h('span', { className: 'dse-item-label' }, '配置文件'),
        h('code', { className: 'dse-code' }, str(mcp.path) || '--'),
      ),
    )
    if (mcp.exists === true) {
      const servers = Array.isArray(mcp.servers) ? mcp.servers : []
      if (servers.length === 0) {
        body.push(h('p', { className: 'dse-item-desc', key: 'none' }, '该文件里暂未声明 MCP server。'))
      }
      for (let i = 0; i < servers.length; i++) {
        const s = isObj(servers[i]) ? servers[i] : {}
        body.push(
          h('div', { className: 'dse-item-row', key: 's-' + i },
            h('span', { className: 'dse-item-label' }, str(s.name) || '未命名'),
            h('span', { className: 'dse-item-value' }, str(s.type) || '未知类型'),
          ),
        )
      }
    } else {
      body.push(
        h('p', { className: 'dse-item-desc', key: 'guide' },
          'Pi 从 ~/.pi/agent/mcp.json 读取 MCP，与 Codex 的 config.toml 无关。该文件当前不存在。',
        ),
      )
    }

    return h(
      Card,
      {
        title: '联网搜索与 MCP',
        desc: '本卡只读展示 Pi 的 MCP 配置文件与已声明的 server；增删 MCP 请在 Pi 侧完成。',
      },
      body,
    )
  }

  // ---- 3. 浏览器聊天桥 ----

  function PiBridgeCard(props) {
    const state = useLocal('bridge', function () {
      return { pending: '', error: '', override: null }
    })
    const lock = useLock(state)

    const bridge = isObj(props.data) && isObj(props.data.bridge) ? props.data.bridge : null
    const port = bridge ? num(bridge.port) : null
    // 运行状态优先级：props.data.bridge.running（权威）> 本卡上一次 POST 的本地结果（兜底）
    // > 「检测中…」。父组件重新 GET 到 bridge 字段后，props.data 会重新成为权威源。
    const known = bridge ? toBool(bridge.running) : undefined
    const running = state.override === null ? known : state.override
    const url = bridge ? str(bridge.url) : ''

    function toggle() {
      if (state.pending) return
      const action = running === true ? 'stop' : 'start'
      state.pending = action
      state.error = ''
      state.bump()
      lock.run(function () {
        return post('/api/pi-bridge', { action: action })
      }).then(function (r) {
        if (!r) return
        state.pending = ''
        if (r.ok) {
          // 后端若回传了权威状态（{ bridge: { running } }）就用它，否则按本次动作兜底
          const posted = isObj(r.data) && isObj(r.data.bridge) ? toBool(r.data.bridge.running) : undefined
          state.override = posted === undefined ? action === 'start' : posted
          state.error = ''
        } else {
          state.error = r.error
        }
        state.bump()
      })
    }

    const body = []
    if (!bridge) {
      body.push(h('p', { className: 'dse-item-desc', key: 'na' }, '未取到聊天桥状态，请重新进入设置页加载。'))
    }
    body.push(
      h('div', { className: 'dse-item-row', key: 'port' },
        h('span', { className: 'dse-item-label' }, '本地端口'),
        h('span', { className: 'dse-item-value' }, port === null ? '--' : String(port)),
      ),
    )
    body.push(h(StatusItem, { key: 'st', label: 'Pi 聊天桥', ok: running, badText: '未运行' }))
    if (running === true && url) {
      body.push(
        h('p', { className: 'dse-item-desc', key: 'link' },
          '浏览器打开：',
          h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url),
        ),
      )
    }
    if (state.error) {
      body.push(h('p', { className: 'dse-err', key: 'err' }, state.error))
    }
    body.push(
      h('div', { className: 'dse-item-row', key: 'ctl' },
        h('span', { className: 'dse-item-label' }, '控制'),
        h('button', {
          type: 'button',
          className: 'dse-btn' + (running === true ? ' dse-btn-danger' : ' dse-btn-primary'),
          disabled: state.pending !== '',
          onClick: toggle,
        }, state.pending === 'start' ? '启动中…' : state.pending === 'stop' ? '停止中…' : running === true ? '停止' : '启动'),
      ),
    )

    return h(
      Card,
      {
        title: '浏览器聊天桥',
        desc: '启动后可在浏览器里直接和 Pi 会话对话；停止只结束这个本地服务，不影响磁盘上的会话记录。',
      },
      body,
    )
  }

  // ---- 4. 会话清理 ----

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
        return post('/api/pi-cleanup', { confirm: true })
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

  return {
    PiProviderCard: PiProviderCard,
    PiMcpCard: PiMcpCard,
    PiBridgeCard: PiBridgeCard,
    PiCleanupCard: PiCleanupCard,
  }
}

module.exports = { createPiCards }
