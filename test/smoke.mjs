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

// 3) apply
mod.apply(mockCtx, {})

check('注册了 2 个工具', tools.length === 2, `实际 ${tools.length}`)
const names = tools.map((t) => t.name).sort()
check('工具名符合预期', names.join(',') === 'browser_run,browser_status', names.join(','))

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

// 4) systemPrompt 注入
check('注册了 1 个 prompt section', sections.length === 1, `实际 ${sections.length}`)
const sec = sections[0] ?? {}
check('section 名带命名空间前缀', typeof sec.name === 'string' && sec.name.includes(':'))
check('section.order 是有限数', Number.isFinite(sec.order))
const text = typeof sec.text === 'function' ? sec.text() : sec.text
check('section.text 能求值出速查表', typeof text === 'string' && text.includes('new_tab('))

console.log(failed === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
