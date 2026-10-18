# 灵动岛顶部栏

## 当前效果

- 深色圆角胶囊，渐变 + 绿色描边
- 外侧柔光、内侧玻璃高光、顶部亮线
- 左侧绿色呼吸灯：约 3 秒周期，光晕/亮度/外圈扩散同步变化
- 主文案 `Agent正在操控此电脑`
- 事件副文案展示当前动作
- 有事件时胶囊弹性展开，主文案和事件日志从左侧平滑滑到水平居中
- 事件结束后阻尼回弹，文字滑回左侧
- 独立线程约 60fps 渲染，不阻塞四边边框条

## 尺寸

- 紧凑态：`286 × 52`
- 展开态：`500 × 70`

## 实现

- `tools/multi-overlay/multi-overlay.cpp` 的 `BannerLoop`
- 阻尼弹簧：刚度 210 / 阻尼 23，带轻微 overshoot
- 文字位置通过 `MeasureString` 测量实际宽度，再按 `eased` 插值
- native 独立 ripple 已禁用，避免 topmost 小窗拦截点击

## 构建

```powershell
cl /nologo /utf-8 /LD /MT /EHsc /O2 multi-overlay.cpp ^
  /link user32.lib gdi32.lib gdiplus.lib ^
  /OUT:..\dsh-computer-control\scripts\multi-overlay.dll
```

## 已知限制

- 首次显示 topmost 浮动窗时，Windows 可能短暂把它记为前台窗口；点回目标窗口后恢复正常
- 灵动岛只负责状态显示，不接收鼠标事件
