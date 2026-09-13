---
name: computer-use
description: 操作本机电脑：窗口枚举、全屏/窗口截图、鼠标键盘控制、滚动，以及在授权后执行 PowerShell 命令
when_to_use: 用户要求操作电脑、截屏、看屏幕、控制鼠标键盘、启动程序或运行本地命令
version: 1.0
---

# Computer Use 技能

本技能用于把"用户想操作电脑"的自然语言翻译成 computer_* 工具的调用序列。

## 执行步骤

1. 先明确目标环境：是否需要指定窗口。需要操作某个应用时，先调用 `computer_list_windows` 找到窗口句柄和标题。
2. 截屏：全屏用 `computer_screenshot`；指定窗口时传 `windowId`。截图后用坐标定位交互点。
3. 鼠标：用 `computer_mouse`（action 支持 move/click/dblclick/rightclick）把动作落到截图上看到的坐标。
4. 键盘：用 `computer_type` 输入中文/文本（走剪贴板粘贴），用 `computer_key` 发送 Enter/Tab/Escape 等按键。
5. 验证：再次 `computer_screenshot` 对比执行结果，并把结果如实转述给用户。

## 安全规则

- 任何删除文件、改系统设置、退出程序等高风险操作，先调用 `ask_clarification` 向用户确认。
- `computer_run` 和 `computer_launch` 默认被开关禁用；未授权时不要让用户误以为已执行，直接说明需要开启开关。
- 不主动点击对话框里的"删除/格式化/卸载"等破坏性按钮，除非用户明确要求。
- 一次只做一步或一个明确的小目标，长任务边截图边推进。
