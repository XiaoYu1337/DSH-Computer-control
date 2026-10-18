# win-overlay.ps1 — DSH Computer-Control native takeover overlay (Windows)

Status: **working v1.1 (thin breathing border)**, verified on this machine (Windows 11 build 26200,
1920x1080 @125% scaling, single monitor, Windows PowerShell 5.1). All 29 automated checks in
`test-overlay.ps1` PASS.

Files (all under `overlay/`):

| file | purpose |
|---|---|
| `win-overlay.ps1` | long-lived JSON-lines helper: layered click-through takeover overlay + paused banner |
| `test-overlay.ps1` | automated visual + behavioural test (29 checks, real synthetic mouse click) |
| `shots/baseline.png` | desktop before any overlay (idle baseline) |
| `shots/active.png` | ACTIVE: thin emerald border glow + "Agent正在操控此电脑" pill |
| `shots/paused.png` | PAUSED: border glow gone + blue "用户正在操控电脑- 点击继续" banner |
| `shots/idle.png` | after `hide`: overlay fully gone |

## Spawn / cleanup

```
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File C:\...\overlay\win-overlay.ps1
```

* Runs in a single STA process; builds its own 10 fps WinForms message loop (timer 125 ms).
* stdout: protocol lines only (one JSON object per line, flushed immediately).
* stderr: diagnostics / errors only (timestamped; safe to ignore).
* On `quit`, stdin EOF, or a fatal startup error the helper hides its windows, disposes GDI
  objects and calls `Environment.Exit(0)` (quit/EOF) / `1` (startup failure). Measured exit code
  on `quit`: **0**; no child process remains.
* The script needs **UTF-8 BOM** encoding (Chinese string literals). It is saved that way.

## Protocol

First stdout line within ~2 s (startup: GDI+ font enumeration + Add-Type compile):

```json
{"type":"ready","pid":1234,"hwnd":4197148,"bannerHwnd":589830,"fps":10,
 "virtualScreen":{"x":0,"y":0,"width":1920,"height":1080}}
```

* `hwnd` — full-virtual-screen overlay window (for ex-style assertions / debugging).
* `bannerHwnd` — paused banner window handle (extra field; hosts may ignore it).
* `fps` — nominal render rate (extra field).

### stdin commands (one JSON object per line)

| command | effect |
|---|---|
| `{"cmd":"show","mode":"active"}` | show click-through overlay, thin emerald border glow fades in 350 ms, banner "Agent正在操控此电脑" |
| `{"cmd":"show","mode":"paused"}` | border glow fades out 350 ms then overlay hides; small topmost banner "用户正在操控电脑- 点击继续" appears at top-centre of the monitor under the mouse cursor |
| `{"cmd":"hide"}` | hide both windows immediately (idle), helper stays alive |
| `{"cmd":"quit"}` | clean shutdown, exit code 0 |

Unknown commands / malformed JSON are logged to stderr and ignored; helper keeps running.
Stdin EOF is treated as `quit`.

### other stdout lines

```json
{"type":"state","mode":"active"}          // after every applied mode switch (may be ignored)
{"type":"state","mode":"paused"}
{"type":"state","mode":"idle"}
{"type":"resume"}                          // user clicked the blue 点击继续 text
{"type":"layout","mode":"paused",
 "resumeRect":{"x":993,"y":35,"w":56,"h":18},
 "hitRect":{"x":979,"y":26,"w":84,"h":38},
 "bannerRect":{"x":840,"y":10,"w":240,"h":68},
 "bannerHwnd":589830,
 "monitor":{"x":0,"y":0,"w":1920,"h":1080}}
```

* `resumeRect` — text bounds of "点击继续" in virtual-screen physical pixels.
* `hitRect` — enlarged (84 x 38) clickable hit target around it (extra field, host may ignore).
* `bannerRect` / `bannerHwnd` — the small banner window.
* On **resume click** the helper emits `{"type":"resume"}`, hides banner/overlay and goes `idle`
  immediately; the host is expected to re-enter control and send `show active`.
  (Any left click inside the small banner pill also resumes — deliberate robustness fallback.)

## Visual design (ACTIVE)

* Per-pixel-alpha layered window rendered via `UpdateLayeredWindow` over the **entire virtual
  screen** (all monitors; here 1920x1080 at 0,0).
* **Thin breathing border** (v1.1; replaced the earlier wide mist because it tinted content):
  a rounded 2 px mint-emerald core line inset ~1 px from the physical screen edges, plus a small
  ≈24 px soft emerald halo drawn with 4 inset strokes (24/15/8/4 px, decreasing alpha). The rest
  of the surface is cleared to fully transparent — the centre is **not** tinted.
* Colors: emerald/mint family `#22c55e`, `#34d399`; core line uses `#34d399`, halo `#22c55e`.
* Breathing: core-line alpha ≈ **0.58…0.78**, halo alpha ≈ 0.055…0.12 (of full opacity), driven by
  two out-of-phase sines with periods **5.2 s / 7.6 s**; always slow and subtle, never a strobe.
* Impact bound: the glow reaches at most ~24 px inward from each edge; screen-centre pixels are
  unchanged by the overlay (measured differential test: **centre tint 0 / 36,864** sampled pixels;
  outer-ring border tint 1,343 / 17,676 pixels).
* ACTIVE banner: top-centre pill, 40 px high, rounded, dark green-black translucent
  (`RGBA 8,26,16,~232`), 1 px emerald border, soft halo, glassy sheen, pulsing green dot
  (period 2.4 s) and text **"Agent正在操控此电脑"** in Microsoft YaHei UI Bold 15 px,
  color `RGB(232,255,241)` with dark shadow.
* Global fade-in/out 350 ms.
* Font fallback order: `Microsoft YaHei UI` → `Microsoft YaHei` → `Segoe UI` (this machine
  resolves to Microsoft YaHei UI).

## Visual design (PAUSED)

* Border glow fades out and the fullscreen click-through overlay is hidden.
* Small always-on-top **layered, no-activate, borderless** banner window (240x68 px incl. glow
  margin; pill 208x36) at top-centre of the monitor under the cursor.
* Dark blue-black translucent pill (`RGBA ~6,12,26,238`), 1 px `#4da3ff` border, soft blue halo,
  glassy sheen.
* Text: **"用户正在操控电脑-"** in light blue-white 14 px, then clickable **"点击继续"** in
  bold blue `#4da3ff` (`#8ec5ff` + underline on hover, hand cursor over the pill).
* Clicking the blue text (or anywhere on the small pill as a fallback) emits `{"type":"resume"}`.
* Banner is re-asserted topmost every timer tick while paused so other topmost windows cannot
  steal the synthetic pause click.

## DPI / coordinate system

`SetProcessDpiAwarenessContext(-4)` (per-monitor-v2) early, fallback `SetProcessDPIAware()`.
All coordinates/sizes are physical pixels. On this machine the process reports
**1920x1080** (Windows display scaling is 125%; a non-DPI-aware helper would report 1536x864).

## Verified (test-overlay.ps1, 29/29 PASS)

* ready line + pid + virtualScreen within 10 s (observed ~1–2 s).
* exact ex-style `0x080900A8` contains `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW |
  WS_EX_NOACTIVATE`, no `WS_EX_APPWINDOW` (so no taskbar/alt-tab entry).
* ACTIVE differential vs baseline: thin border tint present in the outer ring
  (**1,343 / 17,676** sampled ring pixels), while the centre stays untouched
  (**0 / 36,864** sampled pixels changed) — no content tinting.
* PAUSED: outer-ring border tint drops to **0**; blue "点击继续" pixels detected in banner;
  layout line contains resumeRect/bannerRect/bannerHwnd.
* Real synthetic left-click (`mouse_event` at the centre of resumeRect while TopMost re-asserted)
  produced `{"type":"resume"}` within the timeout.
* `hide`: overlay window not visible, outer-ring tint back to **0**, paused banner window hidden.
* `quit`: process exits with code **0**, no helper process remains.
* Measured ACTIVE performance on this machine (10 s window, helper process only):
  **≈ 17–25 % of one logical core** (two runs: 16.8 % during plugin verification, 25.0 % in the
  test suite), ≈ 8.3 fps (timer 125 ms; per-frame cost dominated by the 1920x1080 DIB copy +
  `UpdateLayeredWindow` upload). This is lower than the old fog pipeline (≈26.6 %).
* Repeat runs on the shared desktop: 16.8 % / 8.3 fps and 25.0 % / 8.3 fps (border rendering; variance comes from desktop load / DIB upload).

## Exact ex-styles

```
WS_EX_LAYERED      0x00080000
WS_EX_TRANSPARENT  0x00000020   (overlay only — click-through)
WS_EX_TOOLWINDOW   0x00000080
WS_EX_NOACTIVATE   0x08000000
=> overlay   0x080900A8
=> banner    0x08090088 (same without TRANSPARENT; measured on the banner window)
```

Both windows are created with `TopMost`/`HWND_TOPMOST` + `SWP_NOACTIVATE|SWP_SHOWWINDOW`.
`UpdateLayeredWindow` uses `ULW_ALPHA` with a 32bpp premultiplied DIB
(`BLENDFUNCTION {BlendOp=0, BlendFlags=0, SourceConstantAlpha=255, AlphaFormat=1}`).
The paused banner is also a layered window (per-pixel alpha); fully transparent pixels pass
clicks through, the pill area receives them.

## Limitations

* **Exclusive fullscreen** apps (games / fullscreen video) are not covered — a normal topmost
  layered window cannot render above exclusive-fullscreen D3D surfaces.
* **UAC secure desktop / lock screen / Ctrl+Alt+Del**: the helper runs on the user desktop and is
  not visible or interactive there.
* **Multi-monitor**: virtual-screen geometry and per-monitor DPI awareness are implemented, but
  only a single 1920x1080 / 125 % monitor was tested here; the active pill is centred on the
  primary monitor, the paused banner on the monitor under the cursor.
* **Click-through**: overlay has `WS_EX_TRANSPARENT`; clicks/keys always reach the desktop.
  The paused banner intentionally captures clicks on its pill (needed for 点击继续).
* The shared desktop in this session also hosts another teammate's plugin overlay during tests;
  screenshots are kept for visual inspection and the test tolerates transient foreground windows.
* `UpdateLayeredWindow` uploads the full 1920x1080 surface each frame (~30 ms/frame); CPU is
  ≈ 27 % of one core at 7.7 fps. Rendering could be lowered further (e.g. 250 ms timer) if a
  quieter overlay is preferred at the cost of animation smoothness.
* No system settings are modified; nothing is installed; quitting leaves the desktop untouched.
