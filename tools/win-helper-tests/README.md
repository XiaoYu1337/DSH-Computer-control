# win-helper tests

End-to-end tests for the three standalone PowerShell helpers in
`dsh-computer-control/scripts/`:

| helper | test |
| --- | --- |
| `ocr-text.ps1` | `test-ocr.ps1` |
| `uia-find-text.ps1` | `test-uia.ps1` |
| `window-tools.ps1` | `test-window-tools.ps1` |

All files are Windows PowerShell 5.1 (`powershell.exe`), UTF-8 with BOM.

## Run

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\win-helper-tests\run-all.ps1
```

`run-all.ps1` executes the three test scripts, streams every PASS/FAIL line, verifies that
each sample JSON file parses with `ConvertFrom-Json`, and writes the combined output to
`output/test-log.txt`.

Run one suite directly when iterating:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\win-helper-tests\test-ocr.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\win-helper-tests\test-uia.ps1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\win-helper-tests\test-window-tools.ps1
```

Each suite exits `0` only when all of its assertions pass. Notepad processes launched by
a suite are force-closed at the end (only PIDs created after the suite's baseline is
recorded; pre-existing Notepad instances are left alone).

## What is tested

### OCR (`test-ocr.ps1`)

- Launches Notepad with a fresh empty file, maximizes it, pastes
  `DSH OCR 测试 4399 Agent` via the clipboard, and zooms in.
- Captures the physical desktop with `tools/desktop.ps1 -Action screenshot`.
- Runs `ocr-text.ps1 -Path <png> -Language zh-Hans` and asserts:
  `ok:true`, `engine:Windows.Media.Ocr`, `zh-Hans*` recognizer, image-sized
  output, `words`/`lines` arrays with numeric pixel boxes, `4399` and `测试`
  found in words, `confidence:null` (Windows.Media.Ocr exposes no per-word
  confidence on this build).
- Repeats without `-Language` (user-profile language path) and checks `4399`.
- Checks error envelopes for a missing file (`file_not_found`, exit 1) and for
  missing `-Path` (`invalid_args`, exit 1).

Sample outputs: `output/ocr-screenshot.png`, `output/ocr-result-zh-hans.json`,
`output/ocr-result-auto.json`, `output/ocr-result-zh-hans.raw.json`.

### UIA (`test-uia.ps1`)

- Searches the live DeepSeek Harness Electron window for `插件` (contains and
  exact), `新建会话`, an absent string, and a non-matching `-WindowTitle`.
- Asserts `source:"uia"`, the schema of every match (name/controlType/
  className/automationId/x/y/w/h/enabled), and physical-screen bounds.
- Exercises the global (no `-WindowTitle`) path.
- Checks `invalid_regex` and `invalid_args` error envelopes.

Sample outputs: `output/uia-dsh-plugins.json`,
`output/uia-dsh-plugin-exact.json`, `output/uia-empty.json`,
`output/uia-global-plugins.json`.

Note: `新建会话` is the real DSH label; the brief's `新会话` does not exist in
the current UI. Edge/Chromium expose their DOM through UIA only when
accessibility is enabled; the Electron shell used here exposes it.

### window-tools (`test-window-tools.ps1`)

- Launches Notepad, then `wait -Process notepad`.
- `list`: schema, non-empty titles, visible/positive-size windows,
  foreground-first ordering, and physical-pixel rects (`notepad 1440x740` at
  125% scaling, not the ~1152 DIP value).
- `focus` by `-Process`, `-WindowId` and `-Title`, each verified against
  `GetForegroundWindow`.
- Minimizes Notepad with Win32, confirms `minimized:true` in `list`, then
  `focus -WindowId` restores it (`minimized:false`, foreground).
- `wait` by `-WindowId` and `-Title`.
- Error envelopes: `window_not_found` (missing title and bogus hwnd),
  `timeout` (800 ms), `invalid_args` (no selector / bad action),
  `invalid_regex`.

Sample outputs: `output/window-list.json`,
`output/window-list-minimized.json`, `output/window-wait-process.json`,
`output/window-wait-title.json`, `output/window-focus-process.json`,
`output/window-focus-title.json`.

## Limitations

- OCR quality and language coverage depend on installed Windows OCR language
  packs. This machine exposes `en-US` and `zh-Hans-CN`.
- UIA trees differ per app. Web content (Edge/Chromium, and Electron without
  accessibility) may expose nothing or only a document node.
- `window-tools list` excludes empty titles, tool windows, cloaked windows and
  zero-area windows, so some helper/UWP windows are intentionally invisible.
- Foreground activation uses `SetForegroundWindow`; when the OS foreground lock
  refuses it, the helper falls back to `AttachThreadInput` and an Alt tap. A
  `focus_failed` error is returned if the window still is not foreground.
- Tests drive the live desktop: a foreground user or a modal dialog can affect
  timing-sensitive assertions.
