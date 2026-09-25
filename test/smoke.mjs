/**
 * 插件级冒烟测试：抓 import / schema / apply 三类错误，秒级反馈，不需要 DSH 也不需要浏览器。
 *
 * 用法: node test/smoke.mjs
 *
 * 注意 mock ctx 必须提供 inject（pitfall #18：mock 缺 inject 会直接挂），
 * 并且 inject 要按 cordis 语义「立即调用回调并传入服务对象」。
 */

const tools = []
const sections = []
const settingsNamespaces = []

/** settings mock：可切换返回值，用来测「有 key / 没 key」两条路径。 */
let settingsValue = {}
const settingsScope = { get: () => settingsValue }

const svc = {
  tools: {
    register(def) {
      tools.push(def)
      return () => {}
    },
  },
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  settings: {
    register(namespace, schema) {
      settingsNamespaces.push({ namespace, schema })
      return settingsScope
    },
  },
}

const mockCtx = {
  inject(services, cb) {
    // 只把请求到的服务交出去，缺服务就抛 —— 与 cordis 的等待语义不同，
    // 但足以在冒烟阶段暴露服务名写错
    const picked = {}
    for (const name of services) {
      if (!svc[name]) throw new Error(`smoke: 未知服务名 "${name}"`)
      picked[name] = svc[name]
    }
    cb(picked)
  },
}

let failed = 0
const check = (label, cond, extra = '') => {
  if (cond) {
    console.log(`  [ok  ] ${label}`)
  } else {
    failed += 1
    console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`)
  }
}

// 1) import
const mod = await import('../lib/index.js')
check('lib/index.js 可 import', typeof mod.apply === 'function', 'apply 不是函数')
check('导出 apply（不需要 name/inject 这类额外字段）', Object.keys(mod).length === 1, `多余导出: ${Object.keys(mod).join(',')}`)

// 2) harness-api 内容体检
const { HARNESS_API } = await import('../lib/harness-api.js')
check('HARNESS_API 非空且是字符串', typeof HARNESS_API === 'string' && HARNESS_API.length > 500)
for (const fn of ['new_tab', 'page_info', 'click_at_xy', 'fill_input', 'press_key', 'js', 'cdp', 'capture_screenshot', 'drain_events']) {
  check(`速查表包含 ${fn}()`, HARNESS_API.includes(fn + '('))
}
check('速查表明确标注 evaluate 不存在', /evaluate/.test(HARNESS_API) && /js\(/.test(HARNESS_API))

// 3) apply（system 模式：离线冒烟绝不拉起专用 Chrome）
mod.apply(mockCtx, { mode: 'system' })

check('注册了 3 个工具', tools.length === 3, `实际 ${tools.length}`)
const names = tools.map((t) => t.name).sort()
check('工具名符合预期', names.join(',') === 'browser_autopilot,browser_run,browser_status', names.join(','))

for (const t of tools) {
  check(`${t.name} 有 description`, typeof t.description === 'string' && t.description.length > 20)
  check(`${t.name} 有 output.schema + render`, !!t.output?.schema && typeof t.output.render === 'function')
  check(`${t.name} 有 execute`, typeof t.execute === 'function')
}

// defineTool 会把 parameters 编译成 object 根的 JSON Schema，断言要看编译后的形态
const run = tools.find((t) => t.name === 'browser_run')
check('browser_run.parameters 编译成 object 根 schema', run.parameters?.type === 'object' && !!run.parameters.properties)
check('browser_run.code 是必填 string', run.parameters?.properties?.code?.type === 'string' && (run.parameters.required ?? []).includes('code'))
check('browser_run.timeoutMs 是可选 integer', run.parameters?.properties?.timeoutMs?.type === 'integer' && !(run.parameters.required ?? []).includes('timeoutMs'))
check('browser_status 无必填参数', (tools.find((t) => t.name === 'browser_status').parameters?.required ?? []).length === 0)

// 3.5) settings 注册与条件启用
check('注册了 settings namespace browser-harness', settingsNamespaces.map((n) => n.namespace).join(',') === 'browser-harness')
const autopilot = tools.find((t) => t.name === 'browser_autopilot')
check('autopilot.url/goal 必填', (autopilot.parameters?.required ?? []).join(',') === 'url,goal' || (autopilot.parameters?.required ?? []).join(',') === 'goal,url', (autopilot.parameters?.required ?? []).join(','))

// 没 key：执行被拒绝并引导到设置页
const noKeyRes = await autopilot.execute({ url: 'https://example.com', goal: 'test' }, {})
check('无 key 时 autopilot 拒绝执行', noKeyRes.ok === false && typeof noKeyRes.hint === 'string')
check('无 key 时的提示指向设置页', /设置/.test(noKeyRes.hint ?? ''))

// 4) systemPrompt 注入（text 是函数、按 key 动态求值）
check('注册了 1 个 prompt section', sections.length === 1, `实际 ${sections.length}`)
const sec = sections[0] ?? {}
check('section 名带命名空间前缀', typeof sec.name === 'string' && sec.name.includes(':'))
check('section.order 是有限数', Number.isFinite(sec.order))
check('section.text 是函数（每步重估，支持热生效）', typeof sec.text === 'function')
// 此刻仍是无 key 状态，先求值再切 key
const textNoKey = sec.text()
check('无 key 时提示词不含 autopilot 段', !textNoKey.includes('browser_autopilot'))

// 有 key（settings mock 返回）：不再走「未配置」拒绝路径
settingsValue = { typesafeKey: 'ts_test_123' }
const hasKeyRes = await autopilot.execute({ url: 'https://example.com', goal: 'test' }, {})
check('有 key 时不再报「未配置 key」', !(hasKeyRes.hint ?? '').includes('未配置 TypeSafe key'), hasKeyRes.hint)
check('有 key 时 autopilot 命令未配置有明确指引', typeof hasKeyRes.hint === 'string' || hasKeyRes.ok === false, JSON.stringify(hasKeyRes).slice(0, 120))

const textWithKey = sec.text()
check('有 key 时提示词含 autopilot 段', textWithKey.includes('browser_autopilot') && textWithKey.includes('new_tab('))

// 5) client 半边（window.__ModuleLoader__ 模式：mock 浏览器环境后动态 import）
{
  let clientDef = null
  const localeDictionaries = []
  const slotInjections = []
  const slotRegistrations = []
  let scopeBound = null
  let scopeSnapshot = { status: 'ready', value: { typesafeKey: '', textModelKey: '' } }

  globalThis.window = {
    __ModuleLoader__: {
      load(def) { clientDef = def },
    },
  }
  // window 必须先于 import 就位（client.js 顶层就调 __ModuleLoader__.load）
  await import('../lib/client.js')
  const fakeRequire = (name) => {
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (name === 'react') return { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) }
    if (name === '@deepseek-ai/dsh-client-store') {
      return { defineStore: (spec) => spec }
    }
    throw new Error(`smoke: client require 白名单外的包 "${name}"`)
  }
  // factory 的返回值就是模块（module.exports），与 global-prompt 同构
  const clientModule = clientDef.factory(fakeRequire)

  // 宿主 client bundle 的校验契约：load 的 id 必须等于插件包名，
  // 否则报 "loaded without registering <name> via __ModuleLoader__.load"
  const pkgName = (await import('../package.json', { with: { type: 'json' } })).default.name
  check('client: __ModuleLoader__.load 注册了 id', typeof clientDef.id === 'string' && clientDef.id.length > 0, String(clientDef.id))
  check('client: id 必须等于包名（宿主校验契约）', clientDef.id === pkgName, `${clientDef.id} !== ${pkgName}`)
  check('client: exports.inject 不含 settingsScope（0.1.7 已移除该服务）', clientModule.inject.join(',') === 'slots,locale', clientModule.inject.join(','))

  const clientCtx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dict) => localeDictionaries.push({ ns, dict }),
      bind: () => (key) => key,
    },
    settingsScope: {
      bind: (opts) => {
        scopeBound = opts
        return {
          subscribe: () => () => {},
          getSnapshot: () => scopeSnapshot,
          set: () => Promise.resolve(),
        }
      },
    },
    slots: {
      inject: (name, fn) => { slotInjections.push(name); fn() },
      register: (spec, comp) => slotRegistrations.push({ spec, comp }),
    },
  }
  clientModule.apply(clientCtx)

  check('client: 绑定 settings namespace browser-harness', scopeBound?.namespace === 'browser-harness', JSON.stringify(scopeBound))
  check('client: 注入 settings.general.item 槽位', slotInjections.join(',') === 'settings.general.item', slotInjections.join(','))
  const reg = slotRegistrations[0]?.spec ?? {}
  check('client: 槽位 id 为 browser-harness', reg.id === 'browser-harness', String(reg.id))
  check('client: 中英词典 key 集一致', (() => {
    const d = localeDictionaries[0]?.dict
    if (!d) return false
    const zh = Object.keys(d.zh).sort().join(',')
    const en = Object.keys(d.en).sort().join(',')
    return zh === en && zh.length > 0
  })())
  check('client: 词典含 TypeSafe 字段文案', Object.values(localeDictionaries[0]?.dict?.zh ?? {}).some((v) => String(v).includes('TypeSafe')))

  // 0.1.7 降级路径：settingsScope 服务不存在 → 不抛、不注册槽位（避免 pending）
  {
    const degradedInjections = []
    let warned = false
    const origWarn = console.warn
    console.warn = () => { warned = true }
    try {
      clientModule.apply({
        effect: (fn) => fn(),
        locale: { register: () => {}, bind: () => () => {} },
        // 无 settingsScope —— 模拟 0.1.7
        slots: { inject: (n, fn) => { degradedInjections.push(n); fn() }, register: () => {} },
      })
    } finally {
      console.warn = origWarn
    }
    check('client: 0.1.7 无 settingsScope → apply 不抛', true)
    check('client: 0.1.7 降级时不注册槽位', degradedInjections.length === 0, `注册了 ${degradedInjections.length} 个`)
    check('client: 0.1.7 降级时打了 warn 提示 env 兜底', warned)
  }
}

console.log(failed === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
