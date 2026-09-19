"""
Browser Harness 人机协同 helper 集 —— 由 dsh-browser-use 插件注入到每次
browser_run 执行的 globals 前部，用户代码可直接调用，无需 import。

依赖 harness 预导入的 globals：cdp / click_at_xy / fill_input / page_info /
current_tab / activate_tab / js。
（这些函数名以 harness helpers.py 为准；新增前先核对源码。）
"""

import json as _json
import time as _time

_INTERACTIVE_ROLES = {
    "button", "link", "textbox", "combobox", "checkbox", "radio",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option",
    "searchbox", "slider", "switch",
}


def _ax_nodes():
    """取整棵无障碍树的节点列表。"""
    return cdp("Accessibility.getFullAXTree").get("nodes", [])


def ax_list(limit=100):
    """当前页面可交互元素清单。

    返回 [{role, name, cx, cy, backendNodeId}]，cx/cy 为视口中心坐标
    （可直接喂给 click_at_xy）；无几何信息的元素坐标为 None。
    """
    out = []
    for n in _ax_nodes():
        role = (n.get("role") or {}).get("value") or ""
        if role not in _INTERACTIVE_ROLES:
            continue
        if (n.get("ignored") or {}).get("value"):
            continue
        name = ((n.get("name") or {}).get("value") or "")[:60]
        bid = n.get("backendDOMNodeId")
        cx = cy = None
        if bid:
            try:
                q = cdp("DOM.getBoxModel", backendNodeId=bid)["model"]["content"]
                cx = int(round((q[0] + q[2]) / 2))
                cy = int(round((q[1] + q[5]) / 2))
            except Exception:
                pass
        out.append({"role": role, "name": name, "cx": cx, "cy": cy, "backendNodeId": bid})
        if len(out) >= limit:
            break
    return out


def ax_click(role=None, text=None, index=0):
    """按角色/文本匹配可交互元素并点击。

    ax_click(text="登录") / ax_click(role="link", text="注册") / ax_click(text="提交", index=1)
    返回命中的元素描述；找不到或无坐标时抛 RuntimeError。
    """
    items = ax_list(limit=400)
    if role:
        items = [x for x in items if x["role"].lower() == str(role).lower()]
    if text:
        items = [x for x in items if str(text).lower() in (x["name"] or "").lower()]
    if index is not None:
        items = items[int(index):int(index) + 1]
    if not items:
        raise RuntimeError("ax_click: no matching interactive element")
    hit = items[0]
    if hit["cx"] is None:
        raise RuntimeError("ax_click: matched element has no geometry: %r" % hit)
    click_at_xy(hit["cx"], hit["cy"])
    return hit


def form_fields():
    """当前页面表单可填字段清单（隐藏/密码值不回显）。

    返回 [{tag, type, name, id, label, value, required}]。
    """
    code = (
        "(() => { const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);"
        "return Array.from(document.querySelectorAll('input,select,textarea'))"
        ".filter(e => e.type !== 'hidden')"
        ".map(e => ({ tag: e.tagName.toLowerCase(), type: e.type || '', name: e.name || '',"
        "id: e.id || '',"
        "label: ((e.labels && e.labels[0] && e.labels[0].innerText) || e.placeholder ||"
        "e.getAttribute('aria-label') || '').slice(0, 60),"
        "value: e.type === 'password' ? '' : String(e.value || '').slice(0, 80),"
        "required: !!e.required })) })()"
    )
    return js(code)


def _field_selector(name_or_label):
    """按 name/id/label/placeholder 匹配表单控件，返回 CSS selector。"""
    code = (
        "(() => { const key = %s.toLowerCase();"
        "const els = Array.from(document.querySelectorAll('input,select,textarea'))"
        ".filter(e => e.type !== 'hidden');"
        "const hit = els.find(e => (e.name || '').toLowerCase() === key)"
        "|| els.find(e => (e.id || '').toLowerCase() === key)"
        "|| els.find(e => Array.from(e.labels || []).some(l => l.innerText.toLowerCase().includes(key)))"
        "|| els.find(e => (e.placeholder || '').toLowerCase().includes(key))"
        "|| els.find(e => (e.getAttribute('aria-label') || '').toLowerCase().includes(key));"
        "if (!hit) return null;"
        "if (hit.id) return '#' + CSS.escape(hit.id);"
        "return (hit.tagName.toLowerCase() + '[name=' + JSON.stringify(hit.name || hit.id) + ']');"
        "})()" % _json.dumps(str(name_or_label))
    )
    return js(code)


def fill_field(name_or_label, value):
    """按字段名/标签填写单个表单控件（真实按键序列，兼容 React/Vue）。"""
    sel = _field_selector(name_or_label)
    if not sel:
        raise RuntimeError("fill_field: field %r not found" % name_or_label)
    fill_input(sel, str(value), clear_first=True, timeout=5.0)
    return {"field": name_or_label, "selector": sel, "value": str(value)[:40]}


def show_tab():
    """人机协同「轮到你」信号：把当前标签页切到 Chrome 前台，交还用户操作。"""
    t = current_tab()
    activate_tab(t)
    return t


def wait_url_change(old_url=None, timeout=120.0, poll=1.5):
    """人机交接检测：轮询当前 tab 的 URL 直到变化（如登录完成后跳转）。

    old_url 缺省取调用时的当前 URL。超时抛 TimeoutError。
    """
    old = old_url or (page_info().get("url") or "")
    deadline = _time.time() + float(timeout)
    last = old
    while _time.time() < deadline:
        _time.sleep(float(poll))
        try:
            last = page_info().get("url") or last
        except Exception:
            pass
        if last and last != old:
            return last
    raise TimeoutError("wait_url_change: URL unchanged within %.0fs (last=%s)" % (timeout, last))


def page_brief(max_text=600):
    """一屏页面概况：url / title / 可交互元素 / 可见文本摘要。"""
    info = page_info()
    elements = ax_list(limit=40)
    text = js("document.body ? document.body.innerText.slice(0, %d) : ''" % int(max_text))
    return {
        "url": info.get("url"),
        "title": info.get("title"),
        "elements": [e for e in elements if e["cx"] is not None],
        "text": text,
    }
