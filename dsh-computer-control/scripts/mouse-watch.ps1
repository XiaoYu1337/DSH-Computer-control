#requires -Version 5.1
# mouse-watch.ps1 - global mouse-button watcher for the DSH Computer Control plugin.
#
# Spawn (production):
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <abs> -FilterInjected
#
# Protocol:
#   * stdout: one JSON object per line:
#       {"type":"ready","pid":<int>}
#       {"type":"click","button":"left|right|middle|x1|x2","x":<int>,"y":<int>,"at":<epoch-ms>}
#   * -FilterInjected ignores low-level injected input (LLMHF_INJECTED /
#     LLMHF_LOWER_IL_INJECTED), so Agent/E2E synthetic clicks do not pause takeover.
#     Without the switch injected clicks are reported (test harness compatibility).
#   * stdin EOF -> watcher exits cleanly (exit code 0).
#
# Implementation: WH_MOUSE_LL hook on a dedicated message-loop thread; the hook
# callback only enqueues events, the PowerShell loop drains every ~20 ms.

param(
    [switch]$FilterInjected
)

$ErrorActionPreference = 'Stop'

$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Stdout = New-Object System.IO.StreamWriter([System.Console]::OpenStandardOutput(), $script:Utf8)
$script:Stdout.AutoFlush = $false
$script:Stderr = New-Object System.IO.StreamWriter([System.Console]::OpenStandardError(), $script:Utf8)
$script:Stderr.AutoFlush = $true

function Write-Diag([string]$Message) {
    try {
        $script:Stderr.WriteLine(("{0:HH:mm:ss.fff} {1}" -f (Get-Date), $Message))
    } catch {
        # Diagnostics must never crash the watcher.
    }
}

function Send-Line([string]$Line) {
    $script:Stdout.Write($Line)
    $script:Stdout.Write("`n")
    $script:Stdout.Flush()
}

function Send-Json($Object) {
    $json = ConvertTo-Json -InputObject $Object -Depth 8 -Compress
    Send-Line $json
}

$hookSource = @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;

public static class MouseHookNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    private const int WH_MOUSE_LL = 14;
    private const uint LLMHF_INJECTED = 0x00000001;
    private const uint LLMHF_LOWER_IL_INJECTED = 0x00000002;
    private const uint WM_QUIT = 0x0012;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    private static LowLevelMouseProc proc = HookCallback;
    private static IntPtr hook = IntPtr.Zero;
    private static Thread thread;
    private static uint threadId;
    private static bool filterInjected;
    private static readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);
    private static readonly ConcurrentQueue<string> queue = new ConcurrentQueue<string>();

    public static string SetDpiAwareness()
    {
        bool perMonitor = false;
        try { perMonitor = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
        if (perMonitor) return "per-monitor-v2";
        bool system = false;
        try { system = SetProcessDPIAware(); } catch (Exception) { }
        if (system) return "system";
        return "unaware";
    }

    public static bool Start(bool filter)
    {
        filterInjected = filter;
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Name = "dsh-mouse-hook";
        thread.Start();
        return ready.Wait(4000) && hook != IntPtr.Zero;
    }

    private static void Run()
    {
        threadId = GetCurrentThreadId();
        hook = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
        ready.Set();
        if (hook == IntPtr.Zero) return;
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        if (hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int message = wParam.ToInt32();
            string button = null;
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            if (message == 0x0201) button = "left";
            else if (message == 0x0204) button = "right";
            else if (message == 0x0207) button = "middle";
            else if (message == 0x020B) button = ((data.mouseData >> 16) & 0xFFFF) == 2 ? "x2" : "x1";
            if (button != null)
            {
                bool injected = (data.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0;
                if (!filterInjected || !injected)
                {
                    long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    queue.Enqueue(button + "|" + data.pt.X + "|" + data.pt.Y + "|" + at);
                }
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    public static string[] Drain()
    {
        var list = new System.Collections.Generic.List<string>();
        string item;
        while (queue.TryDequeue(out item)) list.Add(item);
        return list.ToArray();
    }

    public static void Stop()
    {
        try { if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero); } catch (Exception) { }
    }
}
'@

$script:HookReady = $false
$script:DpiAware = 'unknown'
try {
    Add-Type -TypeDefinition $hookSource -ErrorAction Stop | Out-Null
    $script:DpiAware = [MouseHookNative]::SetDpiAwareness()
    $script:HookReady = [MouseHookNative]::Start($FilterInjected.IsPresent)
} catch {
    Write-Diag ("Add-Type / hook start failed: " + $_.Exception.Message)
}

if ($script:HookReady -ne $true) {
    Write-Diag 'mouse hook could not be installed'
    exit 1
}

# Detect stdin EOF without blocking the drain loop.
$script:StdinStream = [System.Console]::OpenStandardInput()
$script:StdinBuffer = New-Object byte[] 64
$script:StdinAsync = $null
try {
    $script:StdinAsync = $script:StdinStream.BeginRead($script:StdinBuffer, 0, 1, $null, $null)
} catch {
    Write-Diag ("stdin async read setup failed: " + $_.Exception.Message)
}

Write-Diag ("watcher starting, pid=" + $PID + " dpiAware=" + $script:DpiAware + " filterInjected=" + $FilterInjected.IsPresent)
Send-Json ([ordered]@{ type = 'ready'; pid = $PID })

while ($true) {
    if ($null -ne $script:StdinAsync -and $script:StdinAsync.IsCompleted) {
        Write-Diag 'stdin closed, watcher exiting'
        break
    }
    try {
        $events = [MouseHookNative]::Drain()
    } catch {
        $events = @()
    }
    foreach ($event in $events) {
        $parts = [string]$event -split '\|'
        if ($parts.Count -lt 4) { continue }
        Send-Json ([ordered]@{
            type = 'click'
            button = [string]$parts[0]
            x = [int]$parts[1]
            y = [int]$parts[2]
            at = [long]$parts[3]
        })
    }
    Start-Sleep -Milliseconds 20
}

try { [MouseHookNative]::Stop() } catch { }
try { $script:Stdout.Flush() } catch { }
exit 0
