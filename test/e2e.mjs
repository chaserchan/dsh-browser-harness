/**
 * 真机 E2E：跳过 DSH，直接驱动插件注册出来的工具 execute()，
 * 走完整路径（二进制解析 → dedicated Chrome → spawn → ensure_daemon → 解析 stdout）。
 *
 * 用法: node test/e2e.mjs [url]
 * 前置: 本机已装 browser-use / browser-harness（uv tool），有 Chrome。
 */

const URL_UNDER_TEST = process.argv[2] ?? 'https://www.baidu.com'

const tools = []
const svc = {
  tools: { register: (d) => { tools.push(d); return () => {} } },
  systemPrompt: { section: () => () => {} },
}
const mockCtx = { inject: (_services, cb) => cb({ tools: svc.tools, systemPrompt: svc.systemPrompt }) }

const mod = await import('../lib/index.js')
mod.apply(mockCtx, {})

const run = tools.find((t) => t.name === 'browser_run')
const status = tools.find((t) => t.name === 'browser_status')

let failed = 0
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  [ok  ] ${label}`)
  else { failed += 1; console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`) }
}

// 1) browser_status
console.log('--- browser_status ---')
const st = await status.execute({})
console.log(JSON.stringify({ ok: st.ok, command: st.command, source: st.commandSource, version: st.version, mode: st.mode, cdpUrl: st.cdpUrl, failed: st.failedChecks }, null, 1))
check('browser_status.ok', st.ok === true, st.hint ?? '')
check('解析到的命令不是旧版 CLI（版本应为 0.1.x 的 harness）', /^0\.1\./.test(String(st.version).trim()), `version=${st.version}`)

// 2) browser_run：真实导航并取回页面信息
console.log('--- browser_run（真实导航）---')
const code = [
  'import json',
  `new_tab(${JSON.stringify(URL_UNDER_TEST)})`,
  'wait_for_load(timeout=25.0)',
  'info = page_info()',
  'print(json.dumps({"url": info.get("url"), "title": info.get("title")}, ensure_ascii=False))',
].join('\n')

const t0 = Date.now()
const res = await run.execute({ code, timeoutMs: 180000 })
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  exit=${res.exitCode} ok=${res.ok} 用时=${secs}s`)
console.log(`  stdout: ${res.stdout}`)
if (res.stderr) console.log(`  stderr: ${res.stderr.slice(0, 400)}`)
if (res.hint) console.log(`  hint: ${res.hint}`)

check('browser_run 退出码 0', res.exitCode === 0, res.hint ?? res.stderr.slice(0, 200))

let parsed
try { parsed = JSON.parse(res.stdout.split('\n').filter(Boolean).at(-1)) } catch { /* 见下面的断言 */ }
check('stdout 是可解析的 JSON', !!parsed, `raw=${res.stdout.slice(0, 200)}`)
check('返回了非空 title（真打开了页面）', !!(parsed?.title && parsed.title.length > 0), JSON.stringify(parsed))
check('url 不是错误页', !String(parsed?.url ?? '').startsWith('chrome-error'), String(parsed?.url))

console.log(failed === 0 ? '\nE2E_OK' : `\nE2E_FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
