# dsh-browser-harness

DSH（DeepSeek Harness）插件：把 [browser-use](https://github.com/browser-use/browser-use) 的 **Browser Harness** 注册为会话工具，让 DSH 的 agent 直接写 Python 驱动一个真实 Chrome —— 导航、点击、填表、取无障碍树、执行 JS/CDP、截图。

**不套娃**：Browser Harness 不是「另一个 LLM agent」，而是一个给 coding agent 用的浏览器控制面。DSH 自己的 agent 就是大脑，写的每一行 Python 都留在会话历史里，可读、可审计、可复现。**不需要额外的 LLM，也不需要 API key。**

## 人机协同（0.2.0 新增）

典型场景：申请开发者账号、注册平台、填复杂表单 —— **agent 逐步陪跑，能填的它填，需要本人的交还给你**。

```
agent：打开页面 → show_tab() 让你看到 → form_fields() 摸清表单
      → 姓名/邮箱/项目名等普通字段自动填
agent：遇到登录/验证码/扫码/支付 → show_tab() + 明确告诉你「这步你来」
你：  在浏览器里完成登录/验证
agent：wait_url_change() 检测到跳转 → 继续推进 → page_brief() 汇报结果
```

0.2.0 起内置 helper（每个 `browser_run` 自动注入，零 import 直调）：

```python
ax_list()            # 可交互元素清单 [{role,name,cx,cy}] —— 找元素不再手搓 CDP
ax_click(role=None, text=None)   # 按角色/文本定位并点击
form_fields()        # 表单字段清单
fill_field(字段名, 值)            # 自动填单个控件（兼容 React/Vue）
show_tab()           # 页面切到前台，交还用户
wait_url_change(旧url)           # 等用户操作完成后的跳转
page_brief()         # 一屏页面概况 {url,title,elements,text}
```

**要求**：人机协同需要你**看得到**那个 Chrome —— 用默认的 `dedicated` 模式（有头专用浏览器）即可；agent 与你在同一标签页上交替操作。

## 安装

### 1. 装 Harness CLI（前置）

```bash
uv tool install browser-use      # 完整版（含 agent 库，依赖较多）
# 或更轻的等价物（推荐）：
uv tool install browser-harness  # 同一份 harness，依赖只有 4~5 个纯 Python 包
```

装完**立刻关掉遥测**（Harness 默认会把 stdout 尾部最多 20KB 上报）：

```bash
browser-use telemetry disable
```

### 2. 装插件

```bash
dsh plugin --profile web add dsh-browser-harness
```

或从本地路径：

```bash
dsh plugin --profile web add file:/path/to/dsh-browser-harness
```

装完 `dsh --profile web --dump-config` 里应出现：

```yaml
- id: browser-harness
  name: dsh-browser-harness
```

## 工具

| 工具 | 作用 |
|---|---|
| `browser_run({ code, timeoutMs? })` | 把一段 **Python** 交给 Harness 执行。`print()` 的输出就是返回值；返回 `{ok, exitCode, stdout, stderr, hint}`。`ok=false` 时先读 `hint` —— 它已经把错误码翻译成下一步动作。 |
| `browser_status({})` | 体检：回显解析到的命令与其来源、模式、`BU_NAME`/CDP 地址、doctor 诊断。`browser_run` 报错时先调它。 |

插件还会把完整的**函数速查表 + 操作纪律**注入系统提示词，所以 agent 知道有哪些函数可用、哪些不存在。

## 配置

在 profile 的 `cordis.patch.yml` 里用 **id 定向覆盖**（不要 `- insert:`，本 bundle 已自动 insert 自身 id）：

```yaml
- id: browser-harness
  config:
    mode: dedicated            # dedicated（默认）| system
    command: browser-use       # 或 browser-harness，或绝对路径
    timeoutMs: 120000
    cdpPort: 9334
    chromeArgs: ['--proxy-server=http://127.0.0.1:7890']   # 需要代理时
```

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `dedicated` | `dedicated` 自起专用 Chrome（与日常浏览器完全隔离，不弹授权框）；`system` 附着你正在用的 Chrome |
| `command` | 自动解析 | Harness 可执行文件。**建议显式配置**，见下方「已知陷阱」 |
| `buName` | `dsh-browser` | 具名 daemon，会开自己的后台 tab，不抢你当前看的 tab |
| `cdpUrl` | 空 | 自带 CDP 地址时填，填了就不再自起 Chrome |
| `cdpPort` | `9334` | dedicated 模式的调试端口 |
| `chromePath` | 自动探测 | Chrome 可执行文件 |
| `userDataDir` | `~/.dsh-browser-profile` | dedicated 模式的独立配置目录 |
| `chromeArgs` | `[]` | 追加给 Chrome 的参数（代理、窗口大小等） |
| `timeoutMs` | `120000` | 单次执行预算，上限 600000 |
| `restoreTab` | `true` | 是否设置 `BU_NAME` 让 daemon 用独立后台 tab |

同一份配置也可用环境变量给：`DSH_BROWSER_USE_MODE` / `DSH_BROWSER_USE_BIN` / `DSH_BROWSER_USE_PORT` / `DSH_BROWSER_USE_PROFILE`。

## 已知陷阱

**裸 `browser-use` 不一定是 Harness。** 本机实测：PATH 上先命中了一个更早安装的旧版 CLI（原子式 `open/click/type` 接口，v0.12.3），它不认 stdin 的 Python 协议。本插件按「`config.command` → 环境变量 → `~/.local/bin/browser-use(.exe)`（uv tool 安装位）→ PATH 兜底」的顺序解析，并在 `browser_status` 里回显命令与来源。**如果报错指向命令解析，先看 `browser_status.command` 和 `commandSource`。**

**冷启动第一次调用会超时。** daemon 首启 + 附着 Chrome 会超过 Harness 内部的 IPC 响应上限（5s）。本插件在每段用户代码前自动前置 `ensure_daemon()` 来消除这个问题（已实测：加前置后退出码 0）。

**一次调用一个进程，但状态在 tab 里。** 每次 `browser_run` 都是全新 Python 进程，变量不跨调用保留；真正持久的是 daemon 附着的那**一个**标签页。所以要么复用当前 tab，要么显式 `new_tab`。

**串行执行。** 同一个 daemon 只有一个「当前 tab」，并发调用会互相踩。插件内部用队列串行化，所以并发调用会排队而不是并行。

**外网要代理。** dedicated 模式起的 Chrome 不继承系统代理设置。需要代理时用 `chromeArgs: ['--proxy-server=...']`。

## 安全

> ⚠️ `browser_run` 允许 agent 执行**任意 Python**。这是「代码执行式」架构的固有属性，不是漏洞 —— 换来的是「DSH 自己是大脑、步骤全可见」。插件不额外提权，也不提供沙箱。**只在你信任的环境里使用。**

Harness 默认启用遥测（上报 stdout 尾部最多 20KB）。安装后请执行 `browser-use telemetry disable`。

## 开发

```bash
node test/smoke.mjs    # 离线冒烟：import / schema / apply / 速查表，秒级
node test/e2e.mjs      # 真机：真的打开一个网页并把 title 打回来
```

冒烟测试需要插件目录自带与宿主同版的依赖闭包（`node_modules/@deepseek-ai/`）—— 这是 DSH `link:` 插件的固有要求。

沙盒验证（不污染正式 profile）：

```bash
bash ~/.claude/skills/dsh-plugin-sandbox/scripts/sandbox-test.sh <插件绝对路径> dev
```

## 许可

MIT
