# 窗口捕获与窗口内点击

## 工具

- `computer_capture_window { title, area?, scale? }`
  - 按标题正则查找窗口；普通枚举找不到时会再查托盘隐藏窗口
  - 捕获前自动聚焦目标窗口并验证可见/前台，避免截到遮挡它的窗口
  - 最小化或托盘隐藏窗口会先 `SW_RESTORE`，聚焦后重新读取真实矩形
  - 最大化窗口超出屏幕的 DWM 边框会自动裁剪到虚拟屏幕，并记录裁剪后的 `captureRect`
  - `area=client`（默认）只截取客户区；`area=window` 截取完整窗口矩形
  - 返回 PNG、窗口矩形、客户区矩形、实际捕获原点、图像尺寸、缩放
  - 写 `<png>.window.json` sidecar（v2）
- `computer_window_click { capture, x, y, button?, double? }`
  - 先聚焦 sidecar 里的目标窗口，把正在操作的界面抬到最前给用户看
  - 读取 sidecar 的 `captureRect`，而不是无条件使用窗口矩形
  - `screen = captureRect.origin + image × scale`
  - 调用鼠标 worker 精准点击；worker 会回读实际光标坐标并校验

## 自动置前

- `computer_capture_window`：捕获前聚焦并验证目标窗口；最小化窗口会先恢复，聚焦后重新读取真实矩形
- `computer_window_click`：点击前再次聚焦目标窗口
- `computer_window action=restore`：显式恢复/弹出最小化或托盘隐藏窗口（`focus` 也会先恢复）
- `computer_window action=list includeHidden=true`：列出托盘隐藏窗口，并标记 `hidden`
- `computer_window action=list`：列出最小化窗口，并标记 `minimized`
- `computer_find_text` / `computer_click_text` 带 `windowTitle`：识别/点击前聚焦目标窗口
- 只做前台激活，不永久设置 `HWND_TOPMOST`，避免覆盖用户其他窗口

## 验证

- 酷狗客户区：原点 `298,45`，图像 `1325×900`
- 图像内 `(10,10)` → 屏幕 `(308,55)`，`GetCursorPos` 回读一致
- `verify-host.mjs`：20/20 PASS

## 限制

窗口级映射适合普通窗口；浏览器内嵌 canvas 若仍不接收系统鼠标，应改用浏览器 CDP 坐标点击。
