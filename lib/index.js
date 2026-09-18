/**
 * dsh-browser-use —— 浏览器控制插件（host-only）
 *
 * 把 browser-use / browser-harness 的 Browser Harness 注册为 DSH 会话工具：
 *   browser_run    把一段 Python 交给 Harness 执行（agent 自己写代码驱动浏览器）
 *   browser_status 体检：解析后的命令/模式/连的哪个浏览器/doctor 结果
 *
 * 契约来源（2026-09-18 本机实测，勿凭记忆改）：
 *   - stdin 是「整段读一次 → exec 一次 → 进程退出」，不是 REPL；
 *     跨调用持久的是 daemon + 它附着的那个 tab。
 *   - stdout 是 print 直通、无 banner；更新提示走 stderr（BH_UPDATE_CHECK=0 可禁）。
 *   - 退出码 0 成功 / 1 运行时错误（stderr 前缀 "browser-harness: "）/ 2 用法错误或 NameError。
 *   - **冷启动必挂**：daemon 首启 + 附着 Chrome 会超过 IPC 的 5s 响应上限，
 *     所以 user code 前必须前置 ensure_daemon()（已实测：加前置 EXIT=0）。
 *   - **裸 `browser-use` 不可信**：PATH 上可能先命中旧版原子式 CLI（本机 0.12.3），
 *     必须显式解析到 Harness 版（uv tool 装的那份）。
 *   - 本地模式不需要 API key，也不需要 LLM；cloud auth 是 optional。
 *   - doctor --json 被 browser-use 包装层拦掉，只能用可读版 --doctor。
 *
 * 已知安全属性：browser_run 允许 agent 执行任意 Python —— 这是「代码执行式」架构的
 * 固有属性（用户选定）。本插件不额外提权，也不做沙箱；请只在可信环境使用。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { HARNESS_API } from './harness-api.js'

// ---- 常量 ----
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MIN_TIMEOUT_MS = 5_000
const MAX_OUTPUT_BYTES = 400_000
const DEFAULT_CDP_PORT = 9334
const DEFAULT_BU_NAME = 'dsh-browser'
const STATUS_TIMEOUT_MS = 90_000

/** 渲染工具结果为 JSON 文本。 */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * 解析插件配置。优先级：cordis config → 环境变量 → 默认值。
 * @param config - cordis.patch.yml 里 `- id: browser-use` 的 config 块。
 * @returns 归一化后的配置。
 */
function resolveConfig(config = {}) {
  const mode = config.mode ?? process.env.DSH_BROWSER_USE_MODE ?? 'dedicated'
  return {
    mode: mode === 'system' ? 'system' : 'dedicated',
    command: config.command ?? process.env.DSH_BROWSER_USE_BIN ?? '',
    buName: config.buName ?? process.env.BU_NAME ?? DEFAULT_BU_NAME,
    cdpUrl: config.cdpUrl ?? process.env.BU_CDP_URL ?? '',
    cdpPort: Number(config.cdpPort ?? process.env.DSH_BROWSER_USE_PORT ?? DEFAULT_CDP_PORT),
    chromePath: config.chromePath ?? process.env.BH_CHROME_PATH ?? process.env.CHROME_PATH ?? '',
    userDataDir: config.userDataDir ?? process.env.DSH_BROWSER_USE_PROFILE ?? join(homedir(), '.dsh-browser-profile'),
    chromeArgs: Array.isArray(config.chromeArgs) ? config.chromeArgs : [],
    timeoutMs: clampTimeout(config.timeoutMs),
    restoreTab: config.restoreTab !== false,
  }
}

/** 把超时钳制在合理区间。 */
function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(n)))
}

/**
 * 定位 Harness CLI。
 *
 * 关键：不能直接信任 PATH 上的 `browser-use` —— 本机实测 PATH 里先命中一个
 * 预装的旧版（原子式 CLI，v0.12.3），它不认 stdin 的 Python 协议。所以按
 * 「显式配置 → 环境变量 → uv tool 安装位 → PATH 兜底」的顺序解析，
 * 并把结果原样回显给 browser_status，让这类混淆可见。
 *
 * @param configured - config.command / 环境变量给出的显式路径。
 * @returns { cmd, source } —— cmd 为可执行文件绝对路径或裸命令名。
 */
function resolveCommand(configured) {
  if (configured) return { cmd: configured, source: 'config' }

  const uvShim = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'browser-use.exe' : 'browser-use')
  if (existsSync(uvShim)) return { cmd: uvShim, source: 'uv-tool' }

  // uv 在 Windows 上也可能装到 %APPDATA%\uv\tools 的 Scripts 下
  const uvAlt = join(process.env.APPDATA ?? '', 'uv', 'tools', 'browser-use', 'Scripts', 'browser-use.exe')
  if (process.env.APPDATA && existsSync(uvAlt)) return { cmd: uvAlt, source: 'uv-tool-alt' }

  return { cmd: 'browser-use', source: 'path (可能命中旧版 CLI，建议显式配置 command)' }
}

/** 组装调用 Harness 用的环境变量。 */
function harnessEnv(cfg, resolvedCdpUrl) {
  const env = { ...process.env, BH_UPDATE_CHECK: '0', BH_TAB_MARKER: '0' }
  if (cfg.restoreTab) {
    // 让具名 daemon 拥有自己的后台 tab，不去抢用户当前可见的 tab
    env.BU_NAME = cfg.buName
  }
  if (resolvedCdpUrl) env.BU_CDP_URL = resolvedCdpUrl
  return env
}

/**
 * dedicated 模式下确保专用 Chrome 在跑（带 CDP 端口与独立 user-data-dir）。
 * 与用户日常浏览器完全隔离：不共享 profile，因此也不会触发 Chrome 136+/144+ 的
 * 「允许远程调试」授权弹窗。
 *
 * @returns { ok, cdpUrl, error? }
 */
function ensureDedicatedChrome(cfg) {
  if (cfg.cdpUrl) return { ok: true, cdpUrl: cfg.cdpUrl } // 用户自带 CDP 地址，不再插手

  const probe = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  const listening = (probe.stdout ?? '').includes(`:${cfg.cdpPort} `) && (probe.stdout ?? '').includes('LISTENING')
  if (listening) return { ok: true, cdpUrl: `http://127.0.0.1:${cfg.cdpPort}` }

  const chrome = cfg.chromePath || detectChrome()
  if (!chrome) {
    return { ok: false, error: 'CHROME_NOT_FOUND', hint: '未找到 Chrome，请在配置里设 chromePath，或改用 mode: system' }
  }
  try {
    mkdirSync(cfg.userDataDir, { recursive: true })
  } catch {
    /* 目录已存在或不可建，交给 Chrome 自己报错 */
  }
  const args = [
    `--remote-debugging-port=${cfg.cdpPort}`,
    `--user-data-dir=${cfg.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...cfg.chromeArgs,
    'about:blank',
  ]
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return { ok: true, cdpUrl: `http://127.0.0.1:${cfg.cdpPort}`, launched: true }
}

/** 逐个候选路径找 Chrome。 */
function detectChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  return candidates.find((p) => p && existsSync(p)) ?? ''
}

/**
 * 把 user code 交给 Harness 执行。
 *
 * @param cfg - 归一化配置。
 * @param code - 用户 Python 代码。
 * @param cdpUrl - 解析后的 CDP 地址（可能在 ensureDedicatedChrome 里刚定下来）。
 * @param timeoutMs - 本次调用预算。
 * @returns { ok, exitCode, stdout, stderr, hint? }
 */
function runHarness(cfg, code, cdpUrl, timeoutMs) {
  const { cmd } = resolveCommand(cfg.command)
  const env = harnessEnv(cfg, cdpUrl)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, exitCode: null, stdout: '', stderr: String(e?.message ?? e), hint: '无法启动 Harness 命令，请检查 command 配置' })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = (s, chunk) => (s.length >= MAX_OUTPUT_BYTES ? s : s + chunk.toString('utf8'))

    child.stdout.on('data', (d) => { stdout = cap(stdout, d) })
    child.stderr.on('data', (d) => { stderr = cap(stderr, d) })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
      resolve({
        ok: false, exitCode: null, stdout, stderr,
        hint: `执行超时（${timeoutMs}ms）。若页面很慢或首次要等授权，可用 timeoutMs 参数提高上限（最大 ${MAX_TIMEOUT_MS}ms）。`,
      })
    }, timeoutMs)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, stdout, stderr: String(err?.message ?? err), hint: '命令执行失败，先在浏览器里跑 browser_status 看解析到哪个 binary。' })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const res = { ok: code === 0, exitCode: code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
      if (code !== 0) res.hint = hintFor(code, stderr)
      resolve(res)
    })

    // 前置 ensure_daemon()：冷启动时 daemon 首启+附着 Chrome 会超过 IPC 的 5s 响应
    // 上限，导致 new_tab 之类的首条指令直接 TimeoutError。实测加这一行即可消除。
    child.stdin.write(`ensure_daemon()\n${code}\n`)
    child.stdin.end()
  })
}

/**
 * 把退出码 + stderr 翻译成可执行的中文提示。
 * Harness 的错误是设计好的机器可读契约（stderr 前缀 "browser-harness: "）。
 */
function hintFor(exitCode, stderr) {
  const s = stderr || ''
  const table = [
    [/chrome-not-running/i, '没有可用的浏览器。mode=dedicated 时插件会自动拉起专用 Chrome；mode=system 需要你先打开 Chrome。'],
    [/permission-blocked/i, 'Chrome 的远程调试授权被拦。到 chrome://inspect/#remote-debugging 勾选 "Allow remote debugging for this browser instance" 并点 Allow。'],
    [/remote-debugging-setup/i, '需要先开启远程调试授权：Chrome 已打开 chrome://inspect/#remote-debugging，请勾选允许后重试。'],
    [/DevToolsActivePort not found/i, '找不到可附着的浏览器。建议改用 mode=dedicated（插件自起专用 Chrome，不需要授权）。'],
    [/BU_CDP_URL=.*unreachable/i, 'CDP 地址连不上。专用 Chrome 可能没起来，或端口被占；先在浏览器里跑 browser_status。'],
    [/daemon-starting/i, 'daemon 正在启动，稍等几秒重试即可。'],
    [/didn't come up|is unhealthy/i, 'daemon 起不来，看日志 ~/.config/browser-harness/tmp/bu.log。'],
    [/cloud-auth-required/i, '走到了云浏览器路径。本地用法不需要账号；检查是否设了 BU_AUTOSPAWN 或 BU_NAME 指向了云端 daemon。'],
    [/NameError/i, '代码里用了不存在的函数。看系统提示词的函数表（例如用 js() 而不是 evaluate()）。'],
  ]
  for (const [re, msg] of table) if (re.test(s)) return msg
  if (exitCode === 2) return '用法错误或 NameError（退出码 2）。多半是调用了 Harness 不存在的函数，对照系统提示词的函数表。'
  if (exitCode === 1) return 'Harness 运行时错误（退出码 1）。看 stderr 里的 traceback。'
  return undefined
}

/** 串行化：同一 daemon 只有一个「当前 tab」，并发调用会互相踩。 */
let chain = Promise.resolve()
function serialize(fn) {
  const next = chain.then(fn, fn)
  chain = next.then(() => undefined, () => undefined)
  return next
}

/** 解析 dedicated 模式下要用的 CDP 地址（不启动浏览器，只判断）。 */
function dedicatedCdpUrl(cfg) {
  if (cfg.cdpUrl) return cfg.cdpUrl
  return `http://127.0.0.1:${cfg.cdpPort}`
}

/**
 * cordis 插件入口。
 * @param ctx - cordis 根上下文。
 * @param config - profile patch 里的 config 块。
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const { cmd: resolvedCmd, source } = resolveCommand(cfg.command)
  const cdpUrl = cfg.mode === 'dedicated' ? dedicatedCdpUrl(cfg) : ''

  const runBody = async (code, timeoutMs) => {
    if (cfg.mode === 'dedicated') {
      const ready = ensureDedicatedChrome(cfg)
      if (!ready.ok) {
        return { ok: false, exitCode: null, stdout: '', stderr: ready.error, hint: ready.hint }
      }
    }
    return runHarness(cfg, code, cdpUrl, timeoutMs)
  }

  ctx.inject(['tools'], (sctx) => {
    sctx.tools.register(defineTool({
      name: 'browser_run',
      description:
        '用 Python 驱动一个真实 Chrome（导航、点击、输入、取无障碍树、截图、执行 JS/CDP）。'
        + '把要执行的 Python 直接写在 code 里；跨调用持久的是「当前标签页」，所以复用当前 tab 而不是每次 new_tab。'
        + '返回 {ok, exitCode, stdout, stderr, hint}；ok=false 时先读 hint，它已经把错误码翻译成下一步动作。'
        + '遇到登录墙/验证码要停下来问用户，不要猜密码。',
      parameters: {
        code: { type: 'string', required: true, description: '要执行的 Python 代码。可用函数见系统提示词的浏览器速查表；print() 的输出就是返回值。' },
        timeoutMs: { type: 'integer', description: `本次执行预算（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，范围 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}。页面很慢或首次等待授权时提高。` },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: (args) => serialize(() => runBody(args.code, clampTimeout(args.timeoutMs ?? cfg.timeoutMs))),
    }))

    sctx.tools.register(defineTool({
      name: 'browser_status',
      description:
        '浏览器插件体检：回显解析到的 Harness 命令、浏览器模式、BU_NAME/CDP 地址、doctor 诊断结果。'
        + 'browser_run 报错时先调它，能区分「命令解析错了」「浏览器没起」「daemon 没起来」这三类问题。',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      execute: () => serialize(async () => {
        if (cfg.mode === 'dedicated') ensureDedicatedChrome(cfg)

        // 先预热：daemon 是按需自启的，不预热就 doctor，会得到「daemon alive = FAIL」的
        // 假阴性（实测：browser_run 明明能跑通）。预热后 doctor 才反映真实可用性。
        await runHarness(cfg, 'pass', cdpUrl, STATUS_TIMEOUT_MS)

        const version = runCommand(resolvedCmd, ['--version'], cdpUrl, cfg)
        const doc = runCommand(resolvedCmd, ['--doctor'], cdpUrl, cfg)

        const doctorText = doc.stdout || doc.stderr || ''
        // cloud auth 是官方标注 optional 的，不该算失败项
        const failed = doctorText
          .split('\n')
          .filter((l) => l.includes('[FAIL]') && !/optional/i.test(l))
          .map((l) => l.trim())
        const ok = /\[ok\s*\]\s*chrome running/.test(doctorText) && /\[ok\s*\]\s*daemon alive/.test(doctorText)

        return {
          ok,
          command: resolvedCmd,
          commandSource: source,
          version: (version.stdout || version.stderr || '').trim(),
          mode: cfg.mode,
          buName: cfg.restoreTab ? cfg.buName : '(未设置)',
          cdpUrl: cdpUrl || '(附着系统浏览器，由 Harness 自行发现)',
          userDataDir: cfg.mode === 'dedicated' ? cfg.userDataDir : '(不适用)',
          doctor: doctorText.trim(),
          failedChecks: failed,
          hint: ok
            ? undefined
            : 'doctor 未全绿。chrome/daemon 任一项失败都会让 browser_run 不可用 —— 按 failedChecks 里的条目逐条处理。',
        }
      }),
    }))

    console.log(`[dsh-browser-use] 已注册 2 个浏览器工具（mode=${cfg.mode}, command=${resolvedCmd}）`)
  })

  // 把 Harness 的可用函数表与操作纪律注入系统提示词。
  // 只给模型一个 Python 执行口、不告诉它有什么函数，模型必然瞎写 —— 这段是成败关键。
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'user:browser-use',
      order: 60,
      text: () => HARNESS_API,
    })
  })
}

/** 同步跑一条只读子命令（--version / --doctor）。 */
function runCommand(cmd, argv, cdpUrl, cfg) {
  try {
    const r = spawnSync(cmd, argv, {
      encoding: 'utf8',
      timeout: STATUS_TIMEOUT_MS,
      windowsHide: true,
      env: harnessEnv(cfg, cdpUrl),
    })
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' }
  } catch (e) {
    return { stdout: '', stderr: String(e?.message ?? e) }
  }
}
