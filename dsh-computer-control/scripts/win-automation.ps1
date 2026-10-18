#requires -Version 5.1
# win-automation.ps1 - JSON-lines automation worker for the DSH Computer Control plugin.
#
# Spawn:
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs path>
#
# Protocol (details in CONTRACT.md):
#   * stdout carries ONLY one JSON object per line (UTF-8, LF terminated, flushed).
#   * first line: {"type":"ready","pid":<int>,"dpiAware":"<mode>"}
#   * stdin: one request per line: {"id":<number|string>,"action":"<name>","params":{...}}
#   * response: {"id":<same>,"ok":true,"result":{...}}
#           or {"id":<same>,"ok":false,"error":{"code":"<code>","message":"<msg>"}}
#   * stdin EOF -> worker exits cleanly (exit code 0).
#   * stderr is diagnostics only.
#
# DPI: per-monitor-v2 awareness is requested with SetProcessDpiAwarenessContext(-4) before
# any GDI/System.Drawing use, with SetProcessDPIAware() as fallback. All coordinates are
# therefore physical pixels, consistent with SetCursorPos / CopyFromScreen.

$ErrorActionPreference = 'Stop'

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Stdout = New-Object System.IO.StreamWriter([System.Console]::OpenStandardOutput(), $script:Utf8)
$script:Stdout.AutoFlush = $false
$script:Stderr = New-Object System.IO.StreamWriter([System.Console]::OpenStandardError(), $script:Utf8)
$script:Stderr.AutoFlush = $true
$script:Stdin = New-Object System.IO.StreamReader([System.Console]::OpenStandardInput(), $script:Utf8)

function Write-Diag([string]$Message) {
    try {
        $script:Stderr.WriteLine(("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $Message))
    } catch {
        # Diagnostics must never crash the worker.
    }
}

function Send-Line([string]$Line) {
    $script:Stdout.Write($Line)
    $script:Stdout.Write("`n")
    $script:Stdout.Flush()
}

function Send-Json($Object) {
    $json = ConvertTo-Json -InputObject $Object -Depth 12 -Compress
    Send-Line $json
}

# Throws an exception carrying a protocol error code.
function Fail([string]$Code, [string]$Message) {
    $exception = New-Object System.Exception($Message)
    $exception.Data['automationCode'] = $Code
    throw $exception
}

# ---------------------------------------------------------------------------
# Native interop (compiled once)
# ---------------------------------------------------------------------------
$script:NativeReady = $false
$script:DrawingReady = $false
$script:DpiAware = 'unknown'

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class WinAutoNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll", SetLastError = true)] private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int virtualKey);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalUnlock(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalFree(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);

    public const uint CF_UNICODETEXT = 13;
    public const uint GMEM_MOVEABLE = 0x0002;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    private static List<string> monitorDescriptions;

    private static bool MonitorCallback(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
    {
        MONITORINFOEX info = new MONITORINFOEX();
        info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        if (GetMonitorInfo(hMonitor, ref info))
        {
            bool primary = (info.dwFlags & 1) != 0;
            int width = info.rcMonitor.Right - info.rcMonitor.Left;
            int height = info.rcMonitor.Bottom - info.rcMonitor.Top;
            monitorDescriptions.Add(
                info.rcMonitor.Left + "," + info.rcMonitor.Top + "," + width + "," + height + "," +
                (primary ? "1" : "0") + "," + info.szDevice);
        }
        return true;
    }

    public static string[] EnumerateMonitors()
    {
        monitorDescriptions = new List<string>();
        MonitorEnumProc callback = new MonitorEnumProc(MonitorCallback);
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
        GC.KeepAlive(callback);
        return monitorDescriptions.ToArray();
    }

    public static int[] GetVirtualScreenMetrics()
    {
        return new int[] {
            GetSystemMetrics(76), GetSystemMetrics(77),
            GetSystemMetrics(78), GetSystemMetrics(79)
        };
    }

    public static string SetDpiAwareness()
    {
        bool perMonitor = false;
        try { perMonitor = SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch (Exception) { }
        if (perMonitor) { return "per-monitor-v2"; }
        bool system = false;
        try { system = SetProcessDPIAware(); }
        catch (Exception) { }
        if (system) { return "system"; }
        return "unaware";
    }

    public static string GetAwarenessName()
    {
        try
        {
            IntPtr context = GetThreadDpiAwarenessContext();
            int awareness = GetAwarenessFromDpiAwarenessContext(context);
            if (awareness == 2) { return "per-monitor"; }
            if (awareness == 1) { return "system"; }
            if (awareness == 0) { return "unaware"; }
        }
        catch (Exception) { }
        return "unknown";
    }

    public static int[] ReadCursor()
    {
        POINT point;
        if (!GetCursorPos(out point)) { return null; }
        return new int[] { point.X, point.Y };
    }

    public static int[] MoveCursor(int x, int y)
    {
        bool ok = SetCursorPos(x, y);
        return new int[] { ok ? 1 : 0, Marshal.GetLastWin32Error() };
    }

    public static void MouseButton(uint flags)
    {
        mouse_event(flags, 0, 0, 0, UIntPtr.Zero);
    }

    public static void MouseWheel(int delta)
    {
        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
    }

    public static void KeyboardEvent(byte virtualKey, bool keyUp, bool extended)
    {
        uint flags = 0;
        if (keyUp) { flags |= 0x0002; }
        if (extended) { flags |= 0x0001; }
        keybd_event(virtualKey, 0, flags, UIntPtr.Zero);
    }

    public static string[] GetForegroundWindowInfo()
    {
        IntPtr handle = GetForegroundWindow();
        if (handle == IntPtr.Zero) { return null; }
        int length = GetWindowTextLengthW(handle);
        if (length < 0) { length = 0; }
        StringBuilder builder = new StringBuilder(length + 2);
        GetWindowTextW(handle, builder, builder.Capacity);
        uint processId = 0;
        GetWindowThreadProcessId(handle, out processId);
        return new string[] { processId.ToString(), builder.ToString() };
    }

    public static bool SetClipboardText(string text)
    {
        if (text == null) { text = String.Empty; }
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (!OpenClipboard(IntPtr.Zero))
            {
                Thread.Sleep(50);
                continue;
            }
            bool success = false;
            try
            {
                if (EmptyClipboard())
                {
                    int byteCount = (text.Length + 1) * 2;
                    IntPtr handle = GlobalAlloc(GMEM_MOVEABLE, new UIntPtr(unchecked((uint)byteCount)));
                    if (handle != IntPtr.Zero)
                    {
                        IntPtr pointer = GlobalLock(handle);
                        if (pointer != IntPtr.Zero)
                        {
                            byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
                            Marshal.Copy(bytes, 0, pointer, bytes.Length);
                            GlobalUnlock(handle);
                            if (SetClipboardData(CF_UNICODETEXT, handle) != IntPtr.Zero)
                            {
                                success = true;
                            }
                            else
                            {
                                GlobalFree(handle);
                            }
                        }
                        else
                        {
                            GlobalFree(handle);
                        }
                    }
                }
            }
            finally
            {
                CloseClipboard();
            }
            if (success) { return true; }
            Thread.Sleep(50);
        }
        return false;
    }

    public static string GetClipboardText()
    {
        for (int attempt = 0; attempt < 10; attempt++)
        {
            if (!OpenClipboard(IntPtr.Zero))
            {
                Thread.Sleep(50);
                continue;
            }
            try
            {
                IntPtr handle = GetClipboardData(CF_UNICODETEXT);
                if (handle == IntPtr.Zero) { return null; }
                IntPtr pointer = GlobalLock(handle);
                if (pointer == IntPtr.Zero) { return null; }
                try
                {
                    return Marshal.PtrToStringUni(pointer);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
            }
            finally
            {
                CloseClipboard();
            }
        }
        return null;
    }

    public static short AsyncKeyState(int virtualKey)
    {
        return GetAsyncKeyState(virtualKey);
    }
}
'@

try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
    $script:NativeReady = $true
} catch {
    Write-Diag ("Add-Type (native interop) failed: " + $_.Exception.Message)
}

# DPI must be configured before any GUI/GDI usage (System.Drawing included).
if ($script:NativeReady) {
    try {
        $script:DpiAware = [WinAutoNative]::SetDpiAwareness()
        $actualAwareness = [WinAutoNative]::GetAwarenessName()
        if ($script:DpiAware -eq 'unaware' -and $actualAwareness -ne 'unaware' -and $actualAwareness -ne 'unknown') {
            $script:DpiAware = $actualAwareness
        }
        Write-Diag ("dpiAware=" + $script:DpiAware + " actual=" + $actualAwareness)
    } catch {
        Write-Diag ("DPI configuration failed: " + $_.Exception.Message)
    }
}

try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop | Out-Null
    $script:DrawingReady = $true
} catch {
    Write-Diag ("Add-Type (System.Drawing) failed: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# Parameter helpers
# ---------------------------------------------------------------------------
function Get-Property($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    foreach ($candidate in $Object.PSObject.Properties) {
        if ($candidate.Name -eq $Name) { return $candidate.Value }
    }
    return $null
}

function Assert-ParamsObject($Params) {
    if ($null -eq $Params) { return }
    if ($Params -is [System.Management.Automation.PSCustomObject]) { return }
    if ($Params -is [System.Collections.IDictionary]) { return }
    Fail 'invalid-params' 'params must be a JSON object'
}

function ConvertTo-IntValue($Value, [string]$Name, [int]$Minimum, [int]$Maximum) {
    if ($null -eq $Value) { Fail 'invalid-params' ("missing required parameter '" + $Name + "'") }
    if ($Value -is [bool]) { Fail 'invalid-params' ("parameter '" + $Name + "' must be an integer") }
    $text = [string]$Value
    $number = 0.0
    $ok = [double]::TryParse($text, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)
    if (-not $ok) { Fail 'invalid-params' ("parameter '" + $Name + "' must be a number") }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { Fail 'invalid-params' ("parameter '" + $Name + "' must be a finite number") }
    if ([Math]::Round($number) -ne $number) { Fail 'invalid-params' ("parameter '" + $Name + "' must be an integer") }
    if ($number -lt -2147483648.0 -or $number -gt 2147483647.0) { Fail 'invalid-params' ("parameter '" + $Name + "' is out of range") }
    $integer = [int]$number
    if ($integer -lt $Minimum -or $integer -gt $Maximum) {
        Fail 'invalid-params' ("parameter '" + $Name + "' must be between " + $Minimum + " and " + $Maximum)
    }
    return $integer
}

function ConvertTo-OptionalInt($Value, [string]$Name, [int]$Default, [int]$Minimum, [int]$Maximum) {
    if ($null -eq $Value) { return $Default }
    return ConvertTo-IntValue $Value $Name $Minimum $Maximum
}

function ConvertTo-OptionalNumber($Value, [string]$Name, [double]$Default, [double]$Minimum, [double]$Maximum) {
    if ($null -eq $Value) { return $Default }
    if ($Value -is [bool]) { Fail 'invalid-params' ("parameter '" + $Name + "' must be a number") }
    $number = 0.0
    $ok = [double]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$number)
    if (-not $ok) { Fail 'invalid-params' ("parameter '" + $Name + "' must be a number") }
    if ([double]::IsNaN($number) -or [double]::IsInfinity($number)) { Fail 'invalid-params' ("parameter '" + $Name + "' must be a finite number") }
    if ($number -lt $Minimum -or $number -gt $Maximum) {
        Fail 'invalid-params' ("parameter '" + $Name + "' must be between " + $Minimum + " and " + $Maximum)
    }
    return $number
}

# ---------------------------------------------------------------------------
# Basic cursor / screen helpers
# ---------------------------------------------------------------------------
function Get-CursorResult {
    $cursor = [WinAutoNative]::ReadCursor()
    if ($null -eq $cursor) { Fail 'win32-error' 'GetCursorPos failed' }
    return [ordered]@{ x = [int]$cursor[0]; y = [int]$cursor[1] }
}

function Set-CursorPosition([int]$X, [int]$Y) {
    $result = [WinAutoNative]::MoveCursor($X, $Y)
    if ($result[0] -ne 1) {
        Fail 'win32-error' ("SetCursorPos(" + $X + "," + $Y + ") failed, Win32 error " + $result[1])
    }
    $actual = [WinAutoNative]::ReadCursor()
    if ($null -eq $actual) { Fail 'win32-error' 'GetCursorPos failed after move' }
    $actualX = [int]$actual[0]
    $actualY = [int]$actual[1]
    if ([Math]::Abs($actualX - $X) -gt 2 -or [Math]::Abs($actualY - $Y) -gt 2) {
        Fail 'cursor-mismatch' ("requested (" + $X + "," + $Y + ") but cursor is (" + $actualX + "," + $actualY + ")")
    }
    return [ordered]@{ x = $actualX; y = $actualY }
}

function Get-MonitorList {
    $entries = [WinAutoNative]::EnumerateMonitors()
    $list = New-Object System.Collections.ArrayList
    $index = 0
    foreach ($entry in $entries) {
        $parts = ([string]$entry).Split(',')
        $item = [ordered]@{
            index = $index
            x = [int]$parts[0]
            y = [int]$parts[1]
            width = [int]$parts[2]
            height = [int]$parts[3]
            primary = ([string]$parts[4] -eq '1')
        }
        [void]$list.Add($item)
        $index++
    }
    return $list
}

function Get-VirtualScreenRect {
    $monitors = @(Get-MonitorList)
    if ($monitors.Count -lt 1) { Fail 'internal-error' 'no monitors detected' }
    $minX = [int]::MaxValue
    $minY = [int]::MaxValue
    $maxRight = [int]::MinValue
    $maxBottom = [int]::MinValue
    foreach ($monitor in $monitors) {
        if ($monitor.x -lt $minX) { $minX = $monitor.x }
        if ($monitor.y -lt $minY) { $minY = $monitor.y }
        $right = $monitor.x + $monitor.width
        $bottom = $monitor.y + $monitor.height
        if ($right -gt $maxRight) { $maxRight = $right }
        if ($bottom -gt $maxBottom) { $maxBottom = $bottom }
    }
    $rect = [ordered]@{ x = $minX; y = $minY; width = ($maxRight - $minX); height = ($maxBottom - $minY) }
    if ($script:NativeReady) {
        $metrics = [WinAutoNative]::GetVirtualScreenMetrics()
        if ($metrics[0] -ne $rect.x -or $metrics[1] -ne $rect.y -or $metrics[2] -ne $rect.width -or $metrics[3] -ne $rect.height) {
            Write-Diag ("virtual screen metrics mismatch (monitors=" + $rect.x + "," + $rect.y + "," + $rect.width + "," + $rect.height + " metrics=" + ($metrics -join ',') + ")")
        }
    }
    return $rect
}

function Get-ActiveWindowInfo {
    $info = [WinAutoNative]::GetForegroundWindowInfo()
    if ($null -eq $info) { return $null }
    $processId = 0
    [void][int]::TryParse([string]$info[0], [ref]$processId)
    $processName = 'unknown'
    if ($processId -gt 0) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -ne $process) { $processName = [string]$process.ProcessName }
    }
    return [ordered]@{ title = [string]$info[1]; process = $processName; pid = $processId }
}

function Move-Smooth([int]$TargetX, [int]$TargetY, [int]$DurationMs) {
    $start = [WinAutoNative]::ReadCursor()
    if ($null -eq $start) { Fail 'win32-error' 'GetCursorPos failed' }
    $startX = [int]$start[0]
    $startY = [int]$start[1]
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $progress = $stopwatch.Elapsed.TotalMilliseconds / [double]$DurationMs
        if ($progress -ge 1.0) { break }
        $currentX = [int][Math]::Round($startX + ($TargetX - $startX) * $progress)
        $currentY = [int][Math]::Round($startY + ($TargetY - $startY) * $progress)
        Set-CursorPosition $currentX $currentY
        Start-Sleep -Milliseconds 15
    }
    Set-CursorPosition $TargetX $TargetY
}

function Resolve-Point($PointObject, [string]$Prefix) {
    if ($null -eq $PointObject -or $PointObject -isnot [System.Management.Automation.PSCustomObject]) {
        Fail 'invalid-params' ("'" + $Prefix + "' must be an object with x and y")
    }
    $x = ConvertTo-IntValue (Get-Property $PointObject 'x') ($Prefix + '.x') (-100000) 100000
    $y = ConvertTo-IntValue (Get-Property $PointObject 'y') ($Prefix + '.y') (-100000) 100000
    return [ordered]@{ x = $x; y = $y }
}

function Get-MouseFlags([string]$Button) {
    switch ($Button) {
        'left' { return @([WinAutoNative]::MOUSEEVENTF_LEFTDOWN, [WinAutoNative]::MOUSEEVENTF_LEFTUP) }
        'right' { return @([WinAutoNative]::MOUSEEVENTF_RIGHTDOWN, [WinAutoNative]::MOUSEEVENTF_RIGHTUP) }
        'middle' { return @([WinAutoNative]::MOUSEEVENTF_MIDDLEDOWN, [WinAutoNative]::MOUSEEVENTF_MIDDLEUP) }
        default { Fail 'invalid-params' ("unsupported mouse button '" + $Button + "'") }
    }
}

function Get-ButtonParam($Params) {
    $value = Get-Property $Params 'button'
    if ($null -eq $value) { return 'left' }
    if ($value -isnot [string]) { Fail 'invalid-params' 'button must be a string' }
    $button = ([string]$value).ToLowerInvariant()
    if ($button -ne 'left' -and $button -ne 'right' -and $button -ne 'middle') {
        Fail 'invalid-params' ("button must be 'left', 'right' or 'middle', got '" + $button + "'")
    }
    return $button
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------
function Invoke-ScreenInfo($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $monitors = @(Get-MonitorList)
    if ($monitors.Count -lt 1) { Fail 'internal-error' 'no monitors detected' }
    $virtual = Get-VirtualScreenRect
    $activeWindow = Get-ActiveWindowInfo
    return [ordered]@{
        virtualScreen = $virtual
        monitors = @($monitors)
        cursor = (Get-CursorResult)
        activeWindow = $activeWindow
        dpiAware = $script:DpiAware
    }
}

function Invoke-Screenshot($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    if ($script:DrawingReady -ne $true) { Fail 'internal-error' 'System.Drawing is unavailable' }

    $pathValue = Get-Property $Params 'path'
    if ($null -eq $pathValue -or $pathValue -isnot [string] -or ([string]$pathValue).Length -eq 0) {
        Fail 'invalid-params' "missing required parameter 'path'"
    }
    $path = [string]$pathValue
    if (-not [System.IO.Path]::IsPathRooted($path)) { Fail 'invalid-params' 'path must be an absolute path' }
    try { $path = [System.IO.Path]::GetFullPath($path) } catch { Fail 'invalid-params' 'path is not a valid filesystem path' }

    $region = Get-Property $Params 'region'
    $monitorValue = Get-Property $Params 'monitor'
    $scale = ConvertTo-OptionalNumber (Get-Property $Params 'scale') 'scale' 1.0 0.1 1.0
    $hideHwndValue = Get-Property $Params 'hideHwnd'
    $hideHwnd = [IntPtr]::Zero
    if ($null -ne $hideHwndValue) {
        $hideHwnd = [IntPtr]([long](ConvertTo-IntValue $hideHwndValue 'hideHwnd' 1 2147483647))
    }

    if ($null -ne $region -and $region -isnot [System.Management.Automation.PSCustomObject]) {
        Fail 'invalid-params' 'region must be an object with x, y, width and height'
    }

    if ($null -ne $region) {
        $sourceX = ConvertTo-IntValue (Get-Property $region 'x') 'region.x' (-100000) 100000
        $sourceY = ConvertTo-IntValue (Get-Property $region 'y') 'region.y' (-100000) 100000
        $sourceWidth = ConvertTo-IntValue (Get-Property $region 'width') 'region.width' 1 100000
        $sourceHeight = ConvertTo-IntValue (Get-Property $region 'height') 'region.height' 1 100000
    } elseif ($null -ne $monitorValue) {
        $monitorIndex = ConvertTo-IntValue $monitorValue 'monitor' 0 63
        $monitors = @(Get-MonitorList)
        if ($monitorIndex -ge $monitors.Count) {
            Fail 'invalid-params' ("monitor index " + $monitorIndex + " does not exist (count=" + $monitors.Count + ")")
        }
        $monitor = $monitors[$monitorIndex]
        $sourceX = [int]$monitor.x
        $sourceY = [int]$monitor.y
        $sourceWidth = [int]$monitor.width
        $sourceHeight = [int]$monitor.height
    } else {
        $virtual = Get-VirtualScreenRect
        $sourceX = [int]$virtual.x
        $sourceY = [int]$virtual.y
        $sourceWidth = [int]$virtual.width
        $sourceHeight = [int]$virtual.height
    }

    $virtualRect = Get-VirtualScreenRect
    if ($sourceWidth -lt 1 -or $sourceHeight -lt 1) { Fail 'invalid-params' 'capture width and height must be positive' }
    if ($sourceX -lt $virtualRect.x -or $sourceY -lt $virtualRect.y -or
        ($sourceX + $sourceWidth) -gt ($virtualRect.x + $virtualRect.width) -or
        ($sourceY + $sourceHeight) -gt ($virtualRect.y + $virtualRect.height)) {
        Fail 'invalid-params' ("capture region (" + $sourceX + "," + $sourceY + "," + $sourceWidth + "x" + $sourceHeight + ") is outside the virtual screen (" + $virtualRect.x + "," + $virtualRect.y + "," + $virtualRect.width + "x" + $virtualRect.height + ")")
    }

    $outputWidth = $sourceWidth
    $outputHeight = $sourceHeight
    if ($scale -lt 1.0) {
        $outputWidth = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
        $outputHeight = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))
    }

    try {
        $directory = [System.IO.Path]::GetDirectoryName($path)
        if ($null -ne $directory -and $directory.Length -gt 0) {
            [void][System.IO.Directory]::CreateDirectory($directory)
        }
    } catch {
        Fail 'io-error' ("cannot create screenshot directory: " + $_.Exception.Message)
    }

    $bitmap = $null
    $scaledBitmap = $null
    $graphics = $null
    $scaledGraphics = $null
    $hidden = $false
    if ($hideHwnd -ne [IntPtr]::Zero -and [WinAutoNative]::IsWindow($hideHwnd)) {
        $hidden = [WinAutoNative]::ShowWindow($hideHwnd, 0)
        if ($hidden) { Start-Sleep -Milliseconds 140 }
    }
    try {
        $bitmap = New-Object System.Drawing.Bitmap($sourceWidth, $sourceHeight)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($sourceX, $sourceY, 0, 0, (New-Object System.Drawing.Size($sourceWidth, $sourceHeight)), [System.Drawing.CopyPixelOperation]::SourceCopy)
        } catch {
            Fail 'win32-error' ("screen capture failed: " + $_.Exception.Message)
        }
        if ($scale -lt 1.0) {
            $scaledBitmap = New-Object System.Drawing.Bitmap($outputWidth, $outputHeight)
            $scaledGraphics = [System.Drawing.Graphics]::FromImage($scaledBitmap)
            $scaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scaledGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $scaledGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $scaledGraphics.DrawImage($bitmap, 0, 0, $outputWidth, $outputHeight)
            $scaledBitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        } else {
            $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
        }
    } catch {
        if ($_.Exception.Data.Contains('automationCode')) { throw }
        Fail 'io-error' ("screenshot failed: " + $_.Exception.Message)
    } finally {
        if ($null -ne $scaledGraphics) { $scaledGraphics.Dispose() }
        if ($null -ne $scaledBitmap) { $scaledBitmap.Dispose() }
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        if ($hidden -and [WinAutoNative]::IsWindow($hideHwnd)) {
            [void][WinAutoNative]::ShowWindow($hideHwnd, 5)
        }
    }

    $fileInfo = Get-Item -LiteralPath $path -ErrorAction Stop
    return [ordered]@{
        path = $path
        x = $sourceX
        y = $sourceY
        width = $outputWidth
        height = $outputHeight
        sourceWidth = $sourceWidth
        sourceHeight = $sourceHeight
        scale = [double]$scale
        fileBytes = [long]$fileInfo.Length
    }
}

function Invoke-Move($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $x = ConvertTo-IntValue (Get-Property $Params 'x') 'x' (-100000) 100000
    $y = ConvertTo-IntValue (Get-Property $Params 'y') 'y' (-100000) 100000
    $durationMs = ConvertTo-OptionalInt (Get-Property $Params 'durationMs') 'durationMs' 0 0 5000
    if ($durationMs -le 0) {
        Set-CursorPosition $x $y
    } else {
        Move-Smooth $x $y $durationMs
    }
    return [ordered]@{ cursor = (Get-CursorResult) }
}

function Invoke-Click($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $button = Get-ButtonParam $Params
    $count = ConvertTo-OptionalInt (Get-Property $Params 'count') 'count' 1 1 3
    $intervalMs = ConvertTo-OptionalInt (Get-Property $Params 'intervalMs') 'intervalMs' 120 50 500
    $xValue = Get-Property $Params 'x'
    $yValue = Get-Property $Params 'y'
    if ($null -ne $xValue -or $null -ne $yValue) {
        if ($null -eq $xValue -or $null -eq $yValue) { Fail 'invalid-params' 'x and y must be provided together' }
        Set-CursorPosition (ConvertTo-IntValue $xValue 'x' (-100000) 100000) (ConvertTo-IntValue $yValue 'y' (-100000) 100000)
        Start-Sleep -Milliseconds 30
    }
    $flags = Get-MouseFlags $button
    $downFlag = [uint32]$flags[0]
    $upFlag = [uint32]$flags[1]
    $holdMs = 45
    for ($clickIndex = 0; $clickIndex -lt $count; $clickIndex++) {
        [WinAutoNative]::MouseButton($downFlag)
        try {
            Start-Sleep -Milliseconds $holdMs
        } finally {
            [WinAutoNative]::MouseButton($upFlag)
        }
        if ($clickIndex -lt ($count - 1)) {
            $delay = $intervalMs - $holdMs
            if ($delay -lt 5) { $delay = 5 }
            Start-Sleep -Milliseconds $delay
        }
    }
    return [ordered]@{ cursor = (Get-CursorResult); button = $button; count = $count }
}

function Invoke-Scroll($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $delta = ConvertTo-IntValue (Get-Property $Params 'delta') 'delta' (-120000) 120000
    if (($delta % 120) -ne 0) { Fail 'invalid-params' 'delta must be a multiple of 120' }
    $xValue = Get-Property $Params 'x'
    $yValue = Get-Property $Params 'y'
    if ($null -ne $xValue -or $null -ne $yValue) {
        if ($null -eq $xValue -or $null -eq $yValue) { Fail 'invalid-params' 'x and y must be provided together' }
        Set-CursorPosition (ConvertTo-IntValue $xValue 'x' (-100000) 100000) (ConvertTo-IntValue $yValue 'y' (-100000) 100000)
        Start-Sleep -Milliseconds 30
    }
    [WinAutoNative]::MouseWheel($delta)
    Start-Sleep -Milliseconds 40
    return [ordered]@{ cursor = (Get-CursorResult) }
}

function Invoke-Drag($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $from = Resolve-Point (Get-Property $Params 'from') 'from'
    $to = Resolve-Point (Get-Property $Params 'to') 'to'
    $button = Get-ButtonParam $Params
    $durationMs = ConvertTo-OptionalInt (Get-Property $Params 'durationMs') 'durationMs' 300 0 5000
    $flags = Get-MouseFlags $button
    $downFlag = [uint32]$flags[0]
    $upFlag = [uint32]$flags[1]
    Set-CursorPosition ([int]$from.x) ([int]$from.y)
    Start-Sleep -Milliseconds 60
    [WinAutoNative]::MouseButton($downFlag)
    try {
        if ($durationMs -le 0) {
            Set-CursorPosition ([int]$to.x) ([int]$to.y)
        } else {
            Move-Smooth ([int]$to.x) ([int]$to.y) $durationMs
        }
        Start-Sleep -Milliseconds 50
    } finally {
        [WinAutoNative]::MouseButton($upFlag)
    }
    return [ordered]@{ cursor = (Get-CursorResult) }
}

function Invoke-Type($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $textValue = Get-Property $Params 'text'
    if ($null -eq $textValue -or $textValue -isnot [string]) { Fail 'invalid-params' "missing required parameter 'text'" }
    $text = [string]$textValue
    if ($text.Length -eq 0) { return [ordered]@{ length = 0 } }

    $previousText = $null
    $hadPreviousText = $false
    try {
        $previousText = [WinAutoNative]::GetClipboardText()
        if ($null -ne $previousText) { $hadPreviousText = $true }
    } catch {
        Write-Diag ("clipboard read failed: " + $_.Exception.Message)
    }

    $clipboardOk = $false
    try { $clipboardOk = [WinAutoNative]::SetClipboardText($text) } catch { Write-Diag ("clipboard write failed: " + $_.Exception.Message) }
    if ($clipboardOk -ne $true) { Fail 'win32-error' 'could not place the text on the clipboard' }

    try {
        try {
            [WinAutoNative]::KeyboardEvent(0x11, $false, $false)   # Ctrl down
            Start-Sleep -Milliseconds 20
            [WinAutoNative]::KeyboardEvent(0x56, $false, $false)   # V down
            Start-Sleep -Milliseconds 25
            [WinAutoNative]::KeyboardEvent(0x56, $true, $false)    # V up
            Start-Sleep -Milliseconds 20
        } finally {
            [WinAutoNative]::KeyboardEvent(0x11, $true, $false)    # Ctrl up (always released)
        }
    } catch {
        Fail 'win32-error' ("failed to send Ctrl+V: " + $_.Exception.Message)
    }

    # Give the focused target time to consume the paste before restoring the clipboard.
    Start-Sleep -Milliseconds 250
    if ($hadPreviousText) {
        try { [void][WinAutoNative]::SetClipboardText($previousText) } catch { Write-Diag ("clipboard restore failed: " + $_.Exception.Message) }
    }
    return [ordered]@{ length = $text.Length }
}

$script:ModifierVirtualKeys = @{
    'ctrl' = 0x11
    'control' = 0x11
    'shift' = 0x10
    'alt' = 0x12
    'win' = 0x5B
    'lwin' = 0x5B
}

$script:NamedVirtualKeys = @{
    'enter' = @(0x0D, $false)
    'return' = @(0x0D, $false)
    'esc' = @(0x1B, $false)
    'escape' = @(0x1B, $false)
    'tab' = @(0x09, $false)
    'space' = @(0x20, $false)
    'backspace' = @(0x08, $false)
    'back' = @(0x08, $false)
    'delete' = @(0x2E, $true)
    'del' = @(0x2E, $true)
    'insert' = @(0x2D, $true)
    'ins' = @(0x2D, $true)
    'up' = @(0x26, $true)
    'down' = @(0x28, $true)
    'left' = @(0x25, $true)
    'right' = @(0x27, $true)
    'home' = @(0x24, $true)
    'end' = @(0x23, $true)
    'pageup' = @(0x21, $true)
    'pgup' = @(0x21, $true)
    'pagedown' = @(0x22, $true)
    'pgdn' = @(0x22, $true)
}
for ($functionIndex = 1; $functionIndex -le 24; $functionIndex++) {
    $script:NamedVirtualKeys['f' + $functionIndex] = @((0x70 + $functionIndex - 1), $false)
}

function Parse-KeyChord([string]$Chord) {
    $trimmed = $Chord.Trim()
    if ($trimmed.Length -eq 0) { Fail 'invalid-params' 'empty key chord' }
    $tokens = $trimmed.Split('+')
    $modifiers = New-Object System.Collections.ArrayList
    $virtualKey = $null
    $extended = $false
    foreach ($rawToken in $tokens) {
        $token = $rawToken.Trim().ToLowerInvariant()
        if ($token.Length -eq 0) { Fail 'invalid-params' ("invalid key chord '" + $Chord + "'") }
        if ($script:ModifierVirtualKeys.ContainsKey($token)) {
            if ($modifiers.Count -ge 4) { Fail 'invalid-params' 'too many modifiers in key chord' }
            [void]$modifiers.Add([int]$script:ModifierVirtualKeys[$token])
            continue
        }
        if ($null -ne $virtualKey) { Fail 'invalid-params' ("key chord '" + $Chord + "' contains more than one non-modifier key") }
        if ($script:NamedVirtualKeys.ContainsKey($token)) {
            $entry = $script:NamedVirtualKeys[$token]
            $virtualKey = [int]$entry[0]
            $extended = [bool]$entry[1]
        } elseif ($token -match '^[a-z]$') {
            $virtualKey = [int][char]::ToUpperInvariant($token[0])
        } elseif ($token -match '^[0-9]$') {
            $virtualKey = 0x30 + [int][char]::GetNumericValue($token[0])
        } else {
            Fail 'invalid-params' ("unsupported key '" + $token + "' in chord '" + $Chord + "'")
        }
    }
    if ($null -eq $virtualKey) { Fail 'invalid-params' ("key chord '" + $Chord + "' has no non-modifier key") }
    return @{ modifiers = @($modifiers); virtualKey = [int]$virtualKey; extended = $extended }
}

function Send-KeyChord($Chord) {
    $modifierKeys = $Chord.modifiers
    $extended = [bool]$Chord.extended
    $virtualKey = [int]$Chord.virtualKey
    foreach ($modifierKey in $modifierKeys) {
        [WinAutoNative]::KeyboardEvent([byte]$modifierKey, $false, $false)
        Start-Sleep -Milliseconds 15
    }
    try {
        [WinAutoNative]::KeyboardEvent([byte]$virtualKey, $false, $extended)
        Start-Sleep -Milliseconds 15
        [WinAutoNative]::KeyboardEvent([byte]$virtualKey, $true, $extended)
        Start-Sleep -Milliseconds 15
    } finally {
        for ($modifierIndex = $modifierKeys.Count - 1; $modifierIndex -ge 0; $modifierIndex--) {
            [WinAutoNative]::KeyboardEvent([byte]$modifierKeys[$modifierIndex], $true, $false)
            Start-Sleep -Milliseconds 10
        }
    }
}

function Invoke-Key($Params) {
    if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }
    $keysValue = Get-Property $Params 'keys'
    if ($null -eq $keysValue -or $keysValue -isnot [string]) { Fail 'invalid-params' "missing required parameter 'keys'" }
    $keys = [string]$keysValue
    if ($keys.Trim().Length -eq 0) { Fail 'invalid-params' 'keys must not be empty' }
    $repeat = ConvertTo-OptionalInt (Get-Property $Params 'repeat') 'repeat' 1 1 20
    $segments = $keys.Split(',')
    $chords = New-Object System.Collections.ArrayList
    foreach ($segment in $segments) {
        [void]$chords.Add((Parse-KeyChord $segment))
    }
    for ($repeatIndex = 0; $repeatIndex -lt $repeat; $repeatIndex++) {
        foreach ($chord in $chords) {
            Send-KeyChord $chord
            if ($chords.Count -gt 1) { Start-Sleep -Milliseconds 40 }
        }
    }
    return [ordered]@{ keys = $keys; repeat = $repeat }
}

function Invoke-Action([string]$Action, $Params) {
    Assert-ParamsObject $Params
    switch ($Action) {
        'screenInfo' { return Invoke-ScreenInfo $Params }
        'screenshot' { return Invoke-Screenshot $Params }
        'move' { return Invoke-Move $Params }
        'click' { return Invoke-Click $Params }
        'scroll' { return Invoke-Scroll $Params }
        'drag' { return Invoke-Drag $Params }
        'type' { return Invoke-Type $Params }
        'key' { return Invoke-Key $Params }
        'cursor' { if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }; return [ordered]@{ cursor = (Get-CursorResult) } }
        'activeWindow' { if ($script:NativeReady -ne $true) { Fail 'internal-error' 'native interop is unavailable' }; return Get-ActiveWindowInfo }
        default { Fail 'unknown-action' ("unknown action '" + $Action + "'") }
    }
}

# ---------------------------------------------------------------------------
# Ready + request loop
# ---------------------------------------------------------------------------
Write-Diag ("worker starting, ps=" + $PSVersionTable.PSVersion.ToString() + " pid=" + $PID + " native=" + $script:NativeReady + " drawing=" + $script:DrawingReady)
Send-Json ([ordered]@{ type = 'ready'; pid = $PID; dpiAware = $script:DpiAware })

while ($true) {
    $line = $null
    try {
        $line = $script:Stdin.ReadLine()
    } catch {
        Write-Diag ("stdin read failed: " + $_.Exception.Message)
        break
    }
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $response = $null
    $request = $null
    $parseFailed = $false
    try {
        $request = ConvertFrom-Json -InputObject $line -ErrorAction Stop
    } catch {
        $parseFailed = $true
    }
    if ($parseFailed -or $null -eq $request -or $request -isnot [System.Management.Automation.PSCustomObject]) {
        $snippet = $line
        if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) + '...' }
        Write-Diag ("invalid JSON request: " + $snippet)
        $response = [ordered]@{
            id = $null
            ok = $false
            error = [ordered]@{ code = 'invalid-json'; message = ('request must be a single JSON object: ' + $snippet) }
        }
    } else {
        $requestId = Get-Property $request 'id'
        $action = $null
        try {
            $actionValue = Get-Property $request 'action'
            if ($null -eq $actionValue -or $actionValue -isnot [string] -or ([string]$actionValue).Length -eq 0) {
                Fail 'invalid-params' "request is missing a valid 'action' string"
            }
            $action = [string]$actionValue
            $paramsValue = Get-Property $request 'params'
            $result = Invoke-Action $action $paramsValue
            $response = [ordered]@{ id = $requestId; ok = $true; result = $result }
        } catch {
            $exception = $_.Exception
            $errorCode = 'internal-error'
            $errorMessage = [string]$exception.Message
            if ($exception.Data.Contains('automationCode')) {
                $errorCode = [string]$exception.Data['automationCode']
            } elseif ($exception -is [System.IO.IOException] -or $exception -is [System.UnauthorizedAccessException]) {
                $errorCode = 'io-error'
            } elseif ($exception -is [System.ComponentModel.Win32Exception]) {
                $errorCode = 'win32-error'
            } elseif ($exception -is [System.ArgumentException]) {
                $errorCode = 'invalid-params'
            }
            Write-Diag ("action '" + $action + "' failed (" + $errorCode + "): " + $errorMessage)
            $response = [ordered]@{
                id = $requestId
                ok = $false
                error = [ordered]@{ code = $errorCode; message = $errorMessage }
            }
        }
    }

    try {
        Send-Json $response
    } catch {
        Write-Diag ("response write failed: " + $_.Exception.Message)
        break
    }
}

try { $script:Stdout.Flush() } catch { }
Write-Diag 'stdin closed, worker exiting'
exit 0
