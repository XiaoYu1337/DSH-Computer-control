# 坐标约定

1. 点击坐标必须是**实际 PNG 像素**，不能使用聊天界面里缩放后的预览坐标。
2. 使用 `computer_mouse from_screenshot {path,x,y}` 时，x/y 按该 PNG 的 `width × height` 取。
3. canvas / 游戏文本优先使用 `computer_click_text`：OCR 直接在原图位图上定位。
4. 窗口内点击用 `computer_capture_window` + `computer_window_click`；sidecar 记录窗口原点和图像缩放，工具自动换算到屏幕物理坐标。
5. 浏览器 canvas 可用 CDP 页面截图 + CSS 坐标点击，不依赖系统鼠标。

## 实测教训

4399 游戏窗口原图 1920×1080，聊天预览 1708×961；按预览目测的坐标会偏约 1.123 倍。改用 OCR 原图坐标后，领取按钮命中。
