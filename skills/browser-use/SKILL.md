---
name: browser-use
description: 受控浏览器自动化：打开网页、读取页面快照、按文本/坐标点击、输入表单、截图验证
when_to_use: 用户要求在浏览器中查找信息、操作网页、打开网址、填表或自动化浏览
version: 1.0
---

# Browser Use 技能

本技能通过 CDP 控制本机 Edge/Chrome/Chromium，让助手能"看见"网页并操作网页。

## 执行步骤

1. 启动：确认浏览器是否已运行（`browser_start`）；没有则启动，需要时带上初始 URL。
2. 打开：`browser_open` 打开目标地址；或 `browser_navigate` 切换当前标签。
3. 观察：`browser_snapshot` 读取页面可交互元素、链接和正文；必要时 `browser_screenshot` 截图。
4. 定位：优先用页面快照里的元素文本（text），其次用 CSS selector，最后用截图坐标。
5. 操作：`browser_click` 点击，`browser_type` 输入（支持中文），`browser_key` 发送快捷键。
6. 验证：截图/快照确认操作结果；页面加载慢时先等 `readyState=complete`。

## 提示

- 搜索场景：直接把搜索词拼成 `https://www.baidu.com/s?wd=${urlencoded}` 或 `https://www.google.com/search?q=${urlencoded}`。
- 遇到弹窗、Cookie 同意、登录墙时：先快照看按钮文本，再点击；不要盲点坐标。
- 登录页需要账号密码时，绝不主动填写密码；请用户手动输入或明确授权。
