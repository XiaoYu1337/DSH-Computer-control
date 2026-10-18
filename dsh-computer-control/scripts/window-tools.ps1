#requires -Version 5.1
# window-tools.ps1 - List / focus / wait for Windows top-level windows.
#
# Usage:
#   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File window-tools.ps1
#       -Action list|focus|wait [-Title <regex>] [-Process <name>] [-WindowId <hwnd>] [-TimeoutMs 15000]
#
# stdout: exactly one JSON object (UTF-8, no BOM), then exit 0 (ok:true) or 1 (ok:false).
# stderr: diagnostics only.
#
# list:
#   {"ok":true,"windows":[{"hwnd":123,"title":"...","process":"notepad","pid":1234,
#     "x":0,"y":0,"w":800,"h":600,"visible":true,"minimized":false,"foreground":false}, ...]}
#   Visible top-level windows with non-empty titles; tool windows are skipped.
#   The foreground window (if present) is first, remaining windows keep z-order.
#
# focus:
#   {"ok":true,"focused":true,"window":{...}}
#   {"ok":false,"code":"window_not_found","message":"..."}
#   Selects by -WindowId, else first visible window matching -Title regex / -Process name.
#   Restores minimized windows (SW_RESTORE) and verifies GetForegroundWindow()==hwnd.
#
# wait:
#   {"ok":true,"window":{...},"elapsedMs":123}
#   {"ok":false,"code":"timeout","message":"..."}
#   Polls every 200ms until a window matches or -TimeoutMs expires.
#
# Notes:
#   * -Title is a case-insensitive .NET regex; -Process accepts a process name with or
#     without ".exe" (case-insensitive). Both filters are ANDed when specified.
#   * Coordinates are physical pixels from GetWindowRect (DPI awareness requested before
#     any user32 call: SetProcessDpiAwarenessContext(-4), fallback SetProcessDPIAware).
#   * Exit code mirrors "ok": success 0, failure 1.

param(
    [string]$Action = '',
    [string]$Title = '',
    [string]$Process = '',
    [long]$WindowId = 0,
    [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Stdout = New-Object System.IO.StreamWriter([System.Console]::OpenStandardOutput(), $script:Utf8NoBom)
$script:Stdout.AutoFlush = $true
$script:Stderr = New-Object System.IO.StreamWriter([System.Console]::OpenStandardError(), $script:Utf8NoBom)
$script:Stderr.AutoFlush = $true

function Write-Diag([string]$Message) {
    try {
        $script:Stderr.WriteLine(('window-tools: ' + $Message))
    } catch {
        # Diagnostics must never prevent the JSON response.
    }
}

function Write-JsonResult($Object, [int]$ExitCode) {
    try {
        $json = ConvertTo-Json -InputObject $Object -Depth 10 -Compress
        $script:Stdout.WriteLine($json)
        $script:Stdout.Flush()
    } catch {
        $script:Stdout.WriteLine('{"ok":false,"code":"internal_error","message":"JSON serialization failed"}')
        $script:Stdout.Flush()
        exit 1
    }
    exit $ExitCode
}

function Fail([string]$Code, [string]$Message) {
    Write-Diag ('FAIL ' + $Code + ': ' + $Message)
    Write-JsonResult ([ordered]@{
        ok      = $false
        code    = $Code
        message = $Message
    }) 1
}

# ---------------------------------------------------------------------------
# Native interop
# ---------------------------------------------------------------------------
$nativeSource = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWindowToolsNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowLongW(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll")]
    public static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr hWnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int SW_RESTORE = 9;
    public const int SW_SHOW = 5;
    public const int DWMWA_CLOAKED = 14;

    public static bool IsCloaked(IntPtr hWnd)
    {
        try
        {
            int cloaked;
            int result = DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int));
            return result == 0 && cloaked != 0;
        }
        catch
        {
            return false;
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
} catch {
    Fail 'internal_error' ('Could not compile native window helpers: ' + $_.Exception.Message)
}

$dpiMode = 'unknown'
try {
    if ([DshWindowToolsNative]::SetProcessDpiAwarenessContext([IntPtr]-4)) {
        $dpiMode = 'per-monitor-v2'
    }
} catch {
    $dpiMode = 'unknown'
}
if ($dpiMode -eq 'unknown') {
    try {
        if ([DshWindowToolsNative]::SetProcessDPIAware()) {
            $dpiMode = 'system'
        }
    } catch {
        $dpiMode = 'unavailable'
    }
}
Write-Diag ('dpiAware=' + $dpiMode)

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
$actionName = ''
if (-not [string]::IsNullOrWhiteSpace($Action)) {
    $actionName = $Action.Trim().ToLowerInvariant()
}
if (@('list', 'focus', 'wait') -notcontains $actionName) {
    Fail 'invalid_args' ('-Action must be list, focus or wait (got: ' + $Action + ').')
}

$script:TitleRegex = $null
if (-not [string]::IsNullOrWhiteSpace($Title)) {
    try {
        $script:TitleRegex = New-Object System.Text.RegularExpressions.Regex(
            $Title,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    } catch {
        Fail 'invalid_regex' ('-Title is not a valid .NET regex: ' + $_.Exception.Message)
    }
}

$processFilter = ''
if (-not [string]::IsNullOrWhiteSpace($Process)) {
    $processFilter = $Process.Trim()
    if ($processFilter.ToLowerInvariant().EndsWith('.exe')) {
        $processFilter = $processFilter.Substring(0, $processFilter.Length - 4)
    }
}

$hasSelector = ($WindowId -gt 0) -or (-not [string]::IsNullOrWhiteSpace($Title)) -or (-not [string]::IsNullOrWhiteSpace($processFilter))
if ($actionName -ne 'list' -and -not $hasSelector) {
    Fail 'invalid_args' ('-Action ' + $actionName + ' requires -WindowId, -Title or -Process.')
}
if ($TimeoutMs -lt 0) {
    Fail 'invalid_args' '-TimeoutMs must be >= 0.'
}

function Get-SelectorDescription {
    $parts = New-Object System.Collections.ArrayList
    if ($WindowId -gt 0) { [void]$parts.Add('WindowId=' + $WindowId) }
    if (-not [string]::IsNullOrWhiteSpace($Title)) { [void]$parts.Add('Title=/' + $Title + '/') }
    if (-not [string]::IsNullOrWhiteSpace($processFilter)) { [void]$parts.Add('Process=' + $processFilter) }
    return ($parts -join ' ')
}

# ---------------------------------------------------------------------------
# Window helpers
# ---------------------------------------------------------------------------
function Get-WindowInfo {
    param(
        [IntPtr]$hWnd,
        [IntPtr]$ForegroundWindow
    )

    $titleText = ''
    $textLength = [DshWindowToolsNative]::GetWindowTextLengthW($hWnd)
    if ($textLength -gt 0) {
        $builder = New-Object System.Text.StringBuilder ($textLength + 2)
        [void][DshWindowToolsNative]::GetWindowTextW($hWnd, $builder, $builder.Capacity)
        $titleText = $builder.ToString()
    }

    $processId = [uint32]0
    [void][DshWindowToolsNative]::GetWindowThreadProcessId($hWnd, [ref]$processId)
    $processName = ''
    if ($processId -ne 0) {
        try {
            $processName = [System.Diagnostics.Process]::GetProcessById([int]$processId).ProcessName
        } catch {
            $processName = ''
        }
    }

    $rect = New-Object 'DshWindowToolsNative+RECT'
    $hasRect = [DshWindowToolsNative]::GetWindowRect($hWnd, [ref]$rect)
    $x = 0
    $y = 0
    $w = 0
    $h = 0
    if ($hasRect) {
        $x = [int]$rect.Left
        $y = [int]$rect.Top
        $w = [int]($rect.Right - $rect.Left)
        $h = [int]($rect.Bottom - $rect.Top)
    }

    $clientRect = New-Object 'DshWindowToolsNative+RECT'
    $hasClient = [DshWindowToolsNative]::GetClientRect($hWnd, [ref]$clientRect)
    $clientX = $x
    $clientY = $y
    $clientW = 0
    $clientH = 0
    if ($hasClient) {
        $origin = New-Object 'DshWindowToolsNative+POINT'
        $origin.X = 0
        $origin.Y = 0
        [void][DshWindowToolsNative]::ClientToScreen($hWnd, [ref]$origin)
        $clientX = [int]$origin.X
        $clientY = [int]$origin.Y
        $clientW = [int]($clientRect.Right - $clientRect.Left)
        $clientH = [int]($clientRect.Bottom - $clientRect.Top)
    }

    return [ordered]@{
        hwnd       = $hWnd.ToInt64()
        title      = $titleText
        process    = $processName
        pid        = [int]$processId
        x          = $x
        y          = $y
        w          = $w
        h          = $h
        clientX    = $clientX
        clientY    = $clientY
        clientW    = $clientW
        clientH    = $clientH
        visible    = [bool][DshWindowToolsNative]::IsWindowVisible($hWnd)
        minimized  = [bool][DshWindowToolsNative]::IsIconic($hWnd)
        foreground = ($hWnd -eq $ForegroundWindow)
    }
}

$script:EnumAccumulator = $null
$script:EnumForeground = [IntPtr]::Zero
$script:EnumCallback = $null

function Get-TopLevelWindows {
    $script:EnumAccumulator = New-Object System.Collections.ArrayList
    $script:EnumForeground = [DshWindowToolsNative]::GetForegroundWindow()

    if (-not $script:EnumCallback) {
        $script:EnumCallback = [DshWindowToolsNative+EnumWindowsProc]{
            param([IntPtr]$hWnd, [IntPtr]$lParam)

            try {
                if (-not [DshWindowToolsNative]::IsWindowVisible($hWnd)) { return $true }

                $textLength = [DshWindowToolsNative]::GetWindowTextLengthW($hWnd)
                if ($textLength -le 0) { return $true }

                $exStyle = [DshWindowToolsNative]::GetWindowLongW($hWnd, [DshWindowToolsNative]::GWL_EXSTYLE)
                if (($exStyle -band [DshWindowToolsNative]::WS_EX_TOOLWINDOW) -ne 0) { return $true }

                if ([DshWindowToolsNative]::IsCloaked($hWnd)) { return $true }

                $info = Get-WindowInfo -hWnd $hWnd -ForegroundWindow $script:EnumForeground
                if ($info.w -le 0 -or $info.h -le 0) { return $true }
                [void]$script:EnumAccumulator.Add($info)
            } catch {
                # A single inaccessible window must not break enumeration.
            }

            return $true
        }
    }

    [void][DshWindowToolsNative]::EnumWindows($script:EnumCallback, [IntPtr]::Zero)
    return @($script:EnumAccumulator)
}

function Sort-ForegroundFirst {
    param($Windows)

    $result = New-Object System.Collections.ArrayList
    foreach ($window in $Windows) {
        if ($window.foreground) { [void]$result.Add($window) }
    }
    foreach ($window in $Windows) {
        if (-not $window.foreground) { [void]$result.Add($window) }
    }
    return @($result)
}

function Find-WindowTarget {
    param(
        [long]$TargetWindowId,
        [string]$TargetTitle,
        [string]$TargetProcess
    )

    if ($TargetWindowId -gt 0) {
        $hWnd = [IntPtr]$TargetWindowId
        if (-not [DshWindowToolsNative]::IsWindow($hWnd)) {
            return $null
        }
        return Get-WindowInfo -hWnd $hWnd -ForegroundWindow ([DshWindowToolsNative]::GetForegroundWindow())
    }

    $windows = @(Get-TopLevelWindows)
    foreach ($window in $windows) {
        if ($script:TitleRegex -and -not $script:TitleRegex.IsMatch([string]$window.title)) { continue }
        if (-not [string]::IsNullOrWhiteSpace($TargetProcess)) {
            if ([string]::Compare([string]$window.process, $TargetProcess, $true) -ne 0) { continue }
        }
        return $window
    }
    return $null
}

function Test-ForegroundWindow {
    param([IntPtr]$hWnd)
    return ([DshWindowToolsNative]::GetForegroundWindow() -eq $hWnd)
}

function Activate-Window {
    param([IntPtr]$hWnd)

    if (Test-ForegroundWindow $hWnd) { return $true }

    try {
        [void][DshWindowToolsNative]::SetForegroundWindow($hWnd)
    } catch { }
    for ($i = 0; $i -lt 5; $i++) {
        if (Test-ForegroundWindow $hWnd) { return $true }
        Start-Sleep -Milliseconds 40
    }

    # Foreground-lock workaround 1: attach to the current foreground thread and bring the
    # target to the top. Released immediately afterwards.
    $foreground = [DshWindowToolsNative]::GetForegroundWindow()
    if ($foreground -ne [IntPtr]::Zero) {
        $tempProcessId = [uint32]0
        $foregroundThread = [DshWindowToolsNative]::GetWindowThreadProcessId($foreground, [ref]$tempProcessId)
        $currentThread = [DshWindowToolsNative]::GetCurrentThreadId()
        $attached = $false
        try {
            $attached = [DshWindowToolsNative]::AttachThreadInput($currentThread, $foregroundThread, $true)
            [void][DshWindowToolsNative]::BringWindowToTop($hWnd)
            [void][DshWindowToolsNative]::SetForegroundWindow($hWnd)
            [void][DshWindowToolsNative]::SetFocus($hWnd)
        } catch {
            # Fall through to the Alt-key nudge.
        } finally {
            if ($attached) {
                try { [void][DshWindowToolsNative]::AttachThreadInput($currentThread, $foregroundThread, $false) } catch { }
            }
        }
        for ($i = 0; $i -lt 5; $i++) {
            if (Test-ForegroundWindow $hWnd) { return $true }
            Start-Sleep -Milliseconds 40
        }
    }

    # Foreground-lock workaround 2: harmless Alt tap, then retry SetForegroundWindow.
    try {
        [DshWindowToolsNative]::keybd_event([byte]0x12, [byte]0, [uint32]0, [UIntPtr]::Zero)
        [DshWindowToolsNative]::keybd_event([byte]0x12, [byte]0, [uint32]2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [void][DshWindowToolsNative]::SetForegroundWindow($hWnd)
    } catch { }

    for ($i = 0; $i -lt 10; $i++) {
        if (Test-ForegroundWindow $hWnd) { return $true }
        Start-Sleep -Milliseconds 60
    }
    return $false
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
try {
    switch ($actionName) {
        'list' {
            $windows = @(Get-TopLevelWindows)
            $sorted = @(Sort-ForegroundFirst $windows)
            Write-Diag ('list windows=' + $sorted.Count + ' dpiAware=' + $dpiMode)
            Write-JsonResult ([ordered]@{
                ok      = $true
                windows = $sorted
            }) 0
        }

        'focus' {
            $target = Find-WindowTarget -TargetWindowId $WindowId -TargetTitle $Title -TargetProcess $processFilter
            if (-not $target) {
                Fail 'window_not_found' ('No window matched: ' + (Get-SelectorDescription))
            }

            $targetHandle = [IntPtr]$target.hwnd
            if ([DshWindowToolsNative]::IsIconic($targetHandle)) {
                [void][DshWindowToolsNative]::ShowWindow($targetHandle, [DshWindowToolsNative]::SW_RESTORE)
                Start-Sleep -Milliseconds 150
            } elseif (-not [DshWindowToolsNative]::IsWindowVisible($targetHandle)) {
                [void][DshWindowToolsNative]::ShowWindow($targetHandle, [DshWindowToolsNative]::SW_SHOW)
                Start-Sleep -Milliseconds 100
            }

            $activated = Activate-Window $targetHandle
            if (-not $activated) {
                $foregroundHandle = [DshWindowToolsNative]::GetForegroundWindow()
                $foregroundInfo = Get-WindowInfo -hWnd $foregroundHandle -ForegroundWindow $foregroundHandle
                Fail 'focus_failed' ('Window ' + $target.hwnd + ' was found but could not be activated; foreground is "' + $foregroundInfo.title + '".')
            }

            $window = Get-WindowInfo -hWnd $targetHandle -ForegroundWindow ([DshWindowToolsNative]::GetForegroundWindow())
            Write-Diag ('focused hwnd=' + $window.hwnd + ' title=' + $window.title)
            Write-JsonResult ([ordered]@{
                ok      = $true
                focused = $true
                window  = $window
            }) 0
        }

        'wait' {
            $timeout = [int][Math]::Max(0, $TimeoutMs)
            $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
            while ($true) {
                $target = Find-WindowTarget -TargetWindowId $WindowId -TargetTitle $Title -TargetProcess $processFilter
                if ($target) {
                    $stopwatch.Stop()
                    $elapsed = [int]$stopwatch.ElapsedMilliseconds
                    Write-Diag ('wait matched hwnd=' + $target.hwnd + ' elapsedMs=' + $elapsed)
                    Write-JsonResult ([ordered]@{
                        ok        = $true
                        window    = $target
                        elapsedMs = $elapsed
                    }) 0
                }
                if ($stopwatch.ElapsedMilliseconds -ge $timeout) { break }
                Start-Sleep -Milliseconds 200
            }
            Fail 'timeout' ('No window matched within ' + $timeout + 'ms (' + (Get-SelectorDescription) + ').')
        }
    }
} catch {
    Fail 'internal_error' ('Unexpected window-tools failure: ' + $_.Exception.Message)
}
