# dsh-computer-control · Agent 电脑操控

![author](https://img.shields.io/badge/author-XiaoYu1337-6d28d9)
![version](https://img.shields.io/badge/version-1.0.0-22c55e)
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0ea5e9)
![license](https://img.shields.io/badge/license-Source--Available-red)
![mark](https://img.shields.io/badge/mark-XY1337--DSH--CC--2026-f59e0b)

> **作者 / Author**：XiaoYu1337 · **版权**：© 2026 XiaoYu1337 · **专属标记**：`XY1337-DSH-CC-2026`

给 DeepSeek Harness 的「Agent 接管电脑」插件：Agent 可以**看屏幕**（截屏识别）、**移动鼠标 / 点击 / 拖拽 / 滚动**、**打字 / 组合键**；接管期间用户始终知道现在是 Agent 在控制：

- **屏幕四个边缘亮起细边框式、缓慢呼吸的淡绿光**（约 2px 细线 + 约 24px 内柔光；屏幕中央完全透明、不染色），顶部出现胶囊提示 **「Agent正在操控此电脑」**；
- 用户**主动点击鼠标** → Agent 立即退出控制，绿光消失，顶部提示变为 **「用户正在操控电脑-点击继续」**，其中 **「点击继续」是蓝色可点击文字**；
- 用户点击「点击继续」→ 控制权交还 Agent，绿光与顶部提示恢复；
- Agent 本轮结束 / 调用 `computer_control_state` 的 `release` → 自动退出接管。

在 Windows 上，浮层是**屏幕级原生窗口**（覆盖整个虚拟桌面、始终置顶、鼠标穿透），即使 Agent 在别的应用里操作也能看到；如果原生浮层不可用（非 Windows / helper 启动失败），自动回退到 DSH Web UI 内部的 `shell.overlay` 浮层。

---

## 效果

| 状态 | 画面 | 顶部提示 |
|---|---|---|
| `active`（Agent 控制中） | **原生浮层**：虚拟屏幕四边一圈细边框呼吸绿光（2px 主线 + 约 24px 内柔光，周期 5.2s / 7.6s 缓慢呼吸）；屏幕中央完全透明、不染色 | 绿色脉冲圆点 + **Agent正在操控此电脑** |
| `paused`（用户接管） | 边框绿光淡出（外圈绿色染色像素 1343 → 0） | 灰色圆点 + **用户正在操控电脑-** + 蓝色 **点击继续**（可点击、悬停变亮/下划线，命中区 84×38） |
| `idle` | 无浮层 | 无 |

在 Windows 上默认使用**屏幕级原生浮层**（独立分层窗口，鼠标穿透、不抢焦点、不进任务栏）；原生浮层不可用（非 Windows / helper 启动失败 / 超过重试次数）时自动回退到 DSH Web UI 的 `shell.overlay` 浮层。

实机验证截图见 `../shots/`：`native-plugin-active.png`、`native-plugin-paused.png`、`native-plugin-resumed.png`、`final-idle.png`、`turn-end-auto-release.png`；Web 回退见 `active-web-fallback.png`、`paused-web-fallback.png`。

边框效果（1920×1080 实测）：屏幕中央取样 36,864 像素中，被浮层改变的像素为 **0**（不染色）；外圈取样 17,676 像素中有 1,343 个出现绿色边框染色。原生浮层 `active` 时约 8.3 fps、单逻辑核 **17%–25%**（`paused` / `idle` 时窗口隐藏、几乎无开销）。

---

## 安装（当前 profile）

插件包：`<项目目录>\dsh-computer-control`（本地 `link:` 安装）。

用宿主的 Plugin Manager 安装（已执行过；重装/升级时再执行）：

```text
plugin_manager action=install_bundle target=<项目目录>\dsh-computer-control
```

- 首次安装即可通过 HMR 在当前打开的页面生效；**宿主半代码（index.js）修改后需要让 bundle 重新挂载**（`plugin_manager set_bundle` 关→开，或重启桌面应用）。
- 安装后会在 profile 的 `dsh.profile.bundles` 中追加 `dsh-computer-control`。

**环境要求**：Windows 10/11、Windows PowerShell 5.1（系统自带）、交互式桌面会话；不需要管理员权限。无需安装任何 npm 依赖或编译原生模块。

---

## Agent 工具

| 工具 | 作用 |
|---|---|
| `computer_screen_info` | 返回显示器布局（虚拟桌面 + 每台显示器矩形）、当前光标位置、前台窗口标题/进程；用于把截屏里的目标换算成物理像素坐标。 |
| `computer_screenshot` | 截取整屏 / 指定显示器 / 指定区域到 PNG（可缩放）。返回绝对路径、像素尺寸、`scale/sourceWidth/sourceHeight` 与 sidecar；模型用 `read_image` 读取路径即可“看到”屏幕。 |
| `computer_mouse` | `move` / `click` / `double_click` / `right_click` / `middle_click` / `scroll` / `drag` / `position`。坐标是虚拟桌面的绝对物理像素（多显示器可为负）；也支持 `from_screenshot {path,x,y}` 自动换算。 |
| `computer_keyboard` | `type` 输入任意 Unicode 文本（含中文，走剪贴板粘贴）；`press` 发送组合键，如 `ctrl+shift+s`、`enter`、`win+r`、`alt+tab`、`ctrl+a,delete`、`f5`。 |
| `computer_control_state` | `status` 查看接管状态；`release` 主动把控制权交还用户（Agent 完成操作后应调用）。 |
| `computer_browser` | Edge CDP：`launch/attach/status/navigate/read/find/fields/frames/click/fill/press/wait/close`。专用临时 profile，自动跟随弹窗；`click/find` 支持 `prefer=button/link/input` 排序；`fields` + `fill fieldIndex` 可填写主 frame 与跨域 iframe 表单；`read/click` 支持 `frameIndex/frameId`。 |
| `computer_wait` | 等 text（page→UIA→OCR）/ url / window / 画面稳定；支持 `windowTitle` 限定 OCR 窗口。 |
| `computer_find_text` / `computer_click_text` | page DOM → UIA → Windows OCR 三级定位；`click_text` 返回 changed/前后状态，支持 `prefer` 与 `windowTitle`。 |
| `computer_open` / `computer_window` | 打开 URL/应用/文件；窗口 list/focus/wait。 |
| `computer_self_test` | 不接管屏幕的自检：浮层/worker/截图元数据/窗口/UIA/OCR/CDP。 |
| `computer_trace` | 读取/清空/导出最近操作 trace（含耗时、结果、失败截图；不存输入值/页面全文）。 |

任何**操控类**工具（截图/鼠标/键盘）被调用都会进入 `active` 接管态；`computer_control_state status` 只读，不会触发接管。

### 用户接管时 Agent 会怎样

用户点鼠标 → 状态变 `paused`。此时新的操控工具调用会**阻塞等待**用户点「点击继续」（默认最多 120 秒）：

- 用户点了 → 工具继续执行，Agent 的工作不中断；
- 超时 → 工具返回 `user takeover wait timed out`，Agent 应停下并请用户点「点击继续」；
- Agent 也可以调用 `computer_control_state release` 主动退出。

浮层「点击继续」是**用户专属操作**：没有对应的 Agent 工具，Agent 不能自己恢复被用户收回的控制权。

---

## 架构

```
宿主半 index.js（Loader 行 dsh-computer-control，随 DSH Host 进程运行）
  ├─ 13 个工具（ctx.tools.register）+ 1 段系统提示（ctx.systemPrompt.section）
  ├─ 接管状态机 idle ⇄ active ⇄ paused
  │    ├─ begin()：首个操控工具生效；显示浮层、启动鼠标 watcher
  │    ├─ 用户点击（watcher 上报，合成的 Agent 点击按时间窗抑制）→ paused
  │    ├─ resume()（用户点「点击继续」）→ active，唤醒被阻塞的工具
  │    └─ release() / durable `turn/end` / agent 销毁 → idle
  ├─ lib/browser/                 Edge CDP 内核（launch/profile/ws/page/popup follow）
  ├─ lib/locator/                 page DOM → UIA → OCR 三级定位
  ├─ lib/tools-extra.js           wait/find_text/click_text/open/window
  ├─ lib/observe-tools.js         self_test/trace
  ├─ scripts/win-automation.ps1  常驻 PowerShell worker（JSON-lines）：截屏、鼠标、键盘、屏幕信息
  ├─ scripts/mouse-watch.ps1     常驻全局鼠标按下 watcher：识别「用户主动点击」
  ├─ scripts/win-overlay.ps1     常驻屏幕级浮层：分层透明窗口画细边框呼吸绿光/顶部胶囊，paused 时显示可点击「点击继续」
  ├─ scripts/ocr-text.ps1        Windows.Media.Ocr 文本识别
  ├─ scripts/uia-find-text.ps1   UIA 控件文本定位
  ├─ scripts/window-tools.ps1    窗口 list/focus/wait
  └─ Web RPC `/dsh-computer-control/state`、`/resume`（与 /api 同一道 Host/Origin+cookie 闸门）
        ↑ 客户端只读轮询 / 点击继续；原生浮层可用时客户端不渲染任何东西

客户端半 client.js（Web UI）
  └─ 回退浮层：注册到 shell.overlay，细边框呼吸绿光 + 顶部胶囊 + 蓝色「点击继续」
```

关键设计：

- **用户点击识别**：`mouse-watch.ps1` 用 `GetAsyncKeyState` 20ms 轮询全局鼠标按键（不注入、不挂钩子、不影响系统输入），按键 0→1 时上报。Agent 自己合成的点击在时间窗内被宿主忽略，因此不会误判。
- **原生浮层**：PowerShell 分层窗口（`WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`）铺满虚拟桌面，鼠标穿透、不抢焦点、不进任务栏；**细边框呼吸绿光**由一条 2px 圆角主线 + 4 层贴边柔光描边组成（最多约 24px 向内），屏幕其余区域保持完全透明，因此不会给内容染色。`paused` 时另起一个小的可点击横幅窗口（在鼠标所在显示器的顶部），点中蓝字后向宿主回传 `{"type":"resume"}`。
- **主题/样式**：回退浮层只引用 `--dsw-alias-*` 主题令牌 + 自绘绿光（artwork 颜色），深/浅色主题都不突兀；原生浮层独立绘制，不依赖 Web UI。

---

## 截图与数据

- 截屏保存在系统图片目录的 `DSH-Computer-Control` 子目录（默认 `%USERPROFILE%\Pictures\DSH-Computer-Control`；可用 `DSH_CC_SCREENSHOT_DIR` 覆盖），自动保留最近 120 张 / 72 小时。
- 原生浮层 helper、worker、watcher 都是插件启动后按需 spawn 的子进程，Unload 插件时统一回收；不写注册表、不开服务、不改系统设置。

## 已知限制

- 仅 Windows；需要交互式桌面（锁屏 / UAC 安全桌面 / 服务会话下不可用）。
- 无管理员权限时无法向提权（UIPI）窗口注入输入；部分 DRM/受保护窗口截屏为黑。
- `computer_keyboard type` 依赖目标接受 Ctrl+V，并会短暂占用/恢复文本剪贴板；不要输入超过 ~100KB 的文本。
- `computer_keyboard press` 只覆盖文档列出的按键；`win+r`、`alt+tab` 等系统组合键已实现但受系统策略影响。
- 鼠标 watcher 是轮询式的：短于 ~20ms 的极快点按可能漏检（真人点击通常 80ms+）。
- 多显示器 / 负坐标已实现，但本机只有单屏 1920×1080@125%，未实测多屏；坐标一律按物理像素处理。
- Web 回退浮层的「点击继续」位于页面顶部下移 64px 处（避开桌面窗口自带的拖动条区域）；原生浮层不受此限制。

## 自检

- 宿主半契约自检（假 ctx）：`node ../tools/verify-host.mjs`（**20/20 PASS**）
- Windows 自动化后端 28 项集成测试：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ../automation/test-automation.ps1`（**28/28 PASS**）
- 原生浮层 29 项测试（含真实 synthetic click → resume、中央不染色断言）：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ../overlay/test-overlay.ps1`（**29/29 PASS**）
- 原生浮层冒烟（spawn → active → paused → 点击继续 → hide → quit）：`node ../tools/smoke-overlay.mjs`

## 端到端验证记录（本机实测）

- 宿主动态注册：13 个工具在安装后立即出现在当前 Agent 工具表中；客户端 `shell.overlay` 占用者出现 `dsh-computer-control`（order 950），无需刷新页面。
- 原生浮层链路：`computer_screen_info` → 全屏绿光 + 顶部「Agent正在操控此电脑」；模拟真实用户点击 → `paused`（绿光消失、顶部「用户正在操控电脑-点击继续」）；点击蓝字 → `resume` → 绿光恢复（`active`，overlay: native）；`release`/`turn/end` → `idle`。
- 输入链路：通过 `computer_screenshot` 截屏定位 → `computer_mouse click` 聚焦窗口 → `computer_keyboard type` 输入 `Hello 世界 你好，这是 DSH 电脑操控插件的输入测试 123。` → 再截屏确认（Notepad 状态栏 36 字符）。
- durable `turn/end` 自动收尾：子 Agent 调用一次 `computer_screen_info` 后本轮结束，约 1.8s 后浮层自动消失。

---

## 声明与专属标记

- 本项目（代码 / 脚本 / 文档 / 浮层与界面设计 / 图标）由 **XiaoYu1337** 独立创作，著作权归作者所有。
- 复制、修改、再分发时，必须完整保留作者署名、版权声明与专属标记 `XY1337-DSH-CC-2026`，并显著注明原仓库地址。
- **禁止商用、禁止倒卖**；不得移除、篡改或隐藏署名与标记，不得冒充原创或官方版本发布。
- 完整条款见仓库根目录 [LICENSE](../LICENSE) 与 [NOTICE.md](../NOTICE.md)；商业授权请联系作者。

> © 2026 XiaoYu1337 · 专属标记 `XY1337-DSH-CC-2026`
