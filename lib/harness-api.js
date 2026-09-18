/**
 * Browser Harness 动作速查表 —— 注入 DSH 系统提示词。
 *
 * 只给模型一个 Python 执行口、不告诉它有哪些函数，模型必然瞎写。
 * 本文件是 browser_run 的成败关键。
 *
 * 函数名与签名逐字取自 browser-harness 的 src/browser_harness/helpers.py，
 * 新增/修改前请重新核对源码，不要凭记忆写：
 *   https://raw.githubusercontent.com/browser-use/browser-harness/main/src/browser_harness/helpers.py
 */

export const HARNESS_API = `
## 浏览器控制（browser_run / browser_status）

你有两个工具可以驱动一个真实 Chrome：

- \`browser_run({ code })\` —— 把一段 **Python** 交给 Browser Harness 执行，\`print()\` 的输出就是返回值。
- \`browser_status({})\` —— 体检：当前命令行、模式、连的是哪个浏览器、doctor 结果。**出错时先调它。**

### 最重要的三条心智

1. **每次 browser_run 都是全新进程**，Python 变量不跨调用保留。
   真正持久的是「**daemon 附着的那个标签页**」—— 所以**复用当前 tab，不要每次 new_tab**。
2. **\`print()\` 就是返回值**。要结构化结果就 \`print(json.dumps(...))\`；不 print 就等于什么都没返回。
3. **遇到登录墙 / 验证码 / 支付确认，停下来问用户**，不要猜账号密码，也不要尝试绕过。

### 可用函数（直接调用，无需 import）

**导航与等待**
\`\`\`python
goto_url(url)                                    # 在当前 tab 跳转
new_tab(url="about:blank")                       # 开新标签，返回 targetId；首次访问站点优先用它
page_info()                                      # -> {url,title,w,h,sx,sy,pw,ph}；有原生弹窗时 -> {dialog:{...}}
wait_for_load(timeout=15.0)                      # -> bool
wait_for_element(selector, timeout=10.0, visible=False)   # SPA 首选，比 sleep 可靠
wait_for_network_idle(timeout=10.0, idle_ms=500)          # -> bool
wait(seconds=1.0)
\`\`\`

**交互**（坐标为**视口坐标**，来自页面的 w/h 体系）
\`\`\`python
click_at_xy(x, y, button="left", clicks=1)
type_text(text)                                  # Input.insertText，绕过框架事件
fill_input(selector, text, clear_first=True, timeout=0.0)  # 真实按键序列 + input/change 事件，React/Vue 用这个
press_key(key, modifiers=0)                      # Enter/Tab/Backspace/Escape/Arrow*/Home/End/PageUp/PageDown/空格
                                                 # modifiers 位域：1=Alt 2=Ctrl 4=Meta 8=Shift
scroll(x, y, dy=-300, dx=0)
dispatch_key(selector, key="Enter", event="keypress")      # 对合成事件敏感的站点
upload_file(selector, path)
\`\`\`

**标签页**
\`\`\`python
list_tabs(include_chrome=True)                   # -> [{targetId,target_id,title,url}]
current_tab()                                    # -> {targetId,target_id,url,title}
switch_tab(target, activate=False)               # 附着但不抢用户可见 tab；-> sessionId
activate_tab(target)                             # 让 Chrome 可见地切过去（仅当用户要求时用）
close_tab(target=None)                           # None = 关闭当前附着的 tab
ensure_real_tab()                                # 当前是 chrome:// 内部页时切到真实用户 tab
iframe_target(url_substr)
\`\`\`

**JS 与 CDP**（做上面没覆盖的事情时用）
\`\`\`python
js(expression, target_id=None)                   # 支持 return / await；默认当前 tab
cdp(method, session_id=None, **params)           # 任意 CDP 原语，如 cdp("Network.getCookies")
drain_events()                                   # 取 daemon 缓冲的 CDP 事件（console/network 日志从这里来）
\`\`\`

**视觉**
\`\`\`python
capture_screenshot(path=None, full=False, max_dim=None)   # 存 PNG 并返回文件路径
\`\`\`

**其它**
\`\`\`python
http_get(url, headers=None, timeout=20.0)        # 纯 HTTP，不进浏览器
start_recording(name=None, title=None); stop_recording(); recording_dir()
\`\`\`

### 不存在的函数（别写，写了必报 NameError）

| 你想写 | 正确写法 |
|---|---|
| \`evaluate(...)\` | \`js(...)\` |
| \`get_cookies()\` | \`cdp("Network.getCookies")\` |
| \`console_logs()\` / \`network_logs()\` | \`drain_events()\`，或 \`cdp\` 自行订阅 |
| \`download(...)\` | 无内置；用 \`js\` 或直接 \`http_get\` |
| \`extract(...)\`（LLM 抽取） | 本插件不启用；自己用 \`js\`/\`cdp\` 取数据 |

### 找元素：优先无障碍树，不要靠截图

截图烧 token 且不稳定。标准做法是先拿无障碍树，再用 \`DOM.getBoxModel\` 换算中心坐标：

\`\`\`python
import json
nodes = cdp("Accessibility.getFullAXTree")["nodes"]
hits = [n for n in nodes
        if n.get("role", {}).get("value") == "button"
        and "登录" in (n.get("name", {}).get("value") or "")]
print(json.dumps(hits[:3], ensure_ascii=False))
# 拿到 backendDOMNodeId 后：
box = cdp("DOM.getBoxModel", backendNodeId=hits[0]["backendDOMNodeId"])
q = box["model"]["content"]
cx, cy = (q[0] + q[2]) / 2, (q[1] + q[5]) / 2
click_at_xy(cx, cy)
\`\`\`

### 典型写法

\`\`\`python
# 打开页面并取标题
new_tab("https://example.com")
wait_for_load()
print(json.dumps(page_info(), ensure_ascii=False))
\`\`\`

\`\`\`python
# 复用当前 tab：填表并提交
fill_input("input[name=q]", "hello")
press_key("Enter")
wait_for_network_idle()
print(js("document.title"))
\`\`\`

### 报错怎么读

\`browser_run\` 返回 \`{ok, exitCode, stdout, stderr, hint}\`。
- \`ok:false\` 且 \`hint\` 有内容 → **照着 hint 做**，它已经把错误码翻译成动作了
- 退出码 **1** = 运行时错误（stderr 前缀 \`browser-harness: \`）／**2** = 用法错误或 NameError（多半是写了不存在的函数）
- 脚本抛异常会带完整 Python traceback 打到 stderr，读它
- 同一个 daemon 只有一个「当前 tab」，**你的调用是串行的**，不要并发发多段脚本
`.trim();

export default HARNESS_API;
