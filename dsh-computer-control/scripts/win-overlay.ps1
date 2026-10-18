# =============================================================================
#  win-overlay.ps1  --  DSH Computer Control native takeover overlay helper
# -----------------------------------------------------------------------------
#  Pure Windows PowerShell 5.1 + .NET (GDI+ / user32 / gdi32 / kernel32).
#  Long lived JSON-lines helper (stdin commands -> stdout protocol lines).
#
#  Spawn:
#    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#                   -File C:\...\overlay\win-overlay.ps1
#
#  Protocol (see CONTRACT.md):
#    stdout  first line: {"type":"ready","pid":N,"hwnd":N,"virtualScreen":{...}}
#            {"type":"resume"}                       when "点击继续" is clicked
#            {"type":"layout","resumeRect":{...}}    on entering paused state
#            {"type":"state","mode":"active|paused|idle"}
#    stdin   {"cmd":"show","mode":"active"} | {"cmd":"show","mode":"paused"}
#            {"cmd":"hide"} | {"cmd":"quit"}
#    stderr  diagnostics / errors only.
#
#  Visual design:
#    ACTIVE  - click-through per-pixel-alpha layered window over the whole
#              virtual screen. A THIN emerald border glow (≈2px core line plus
#              a small ≈20px soft halo) slowly breathes along the four screen
#              edges; the centre of the screen is left completely clear so the
#              content underneath is not tinted. Plus a top-centre pill banner
#              "Agent正在操控此电脑" with pulsing dot.
#    PAUSED  - border glow fades out; a small topmost no-activate pill banner
#              window "用户正在操控电脑- 点击继续" appears at top-centre of the
#              monitor under the mouse cursor. "点击继续" is a blue clickable
#              region (hover brightens + underlines).
#    IDLE    - both windows hidden, helper stays alive.
# =============================================================================

param(
    # 0 = follow the primary monitor refresh rate; >0 caps the overlay FPS.
    [int]$MaxFps = 60,
    # Optional/experimental DirectComposition presenter (requires dx-overlay.dll).
    [switch]$UseDx,
    # Optional multi-window presenter (requires multi-overlay.dll).
    [switch]$Multi
)

$ErrorActionPreference = 'Stop'
# Host writes UTF-8 JSON lines; Windows PowerShell defaults stdin to the OEM code page.
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ------------------------------------------------------------------ protocol --
$script:ProtoLock = New-Object object
function Write-Proto {
    param([hashtable]$Payload)
    try {
        $json = $Payload | ConvertTo-Json -Compress -Depth 6
        [System.Threading.Monitor]::Enter($script:ProtoLock)
        try {
            [Console]::Out.WriteLine($json)
            [Console]::Out.Flush()
        } finally {
            [System.Threading.Monitor]::Exit($script:ProtoLock)
        }
    } catch {
        Write-Diag ('proto write failed: ' + $_.Exception.Message)
    }
}

function Write-Diag {
    param([string]$Message)
    try {
        [Console]::Error.WriteLine(('[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss.fff'), $Message))
        [Console]::Error.Flush()
    } catch { }
}

# -------------------------------------------------------------------- native --
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WinOverlayNative
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst,
        IntPtr pptDst, IntPtr psize, IntPtr hdcSrc, IntPtr pptSrc,
        uint crKey, IntPtr pblend, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi,
        uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    public static extern int GetDeviceCaps(IntPtr hdc, int nIndex);

    [DllImport("winmm.dll")]
    public static extern uint timeBeginPeriod(uint uPeriod);

    [DllImport("winmm.dll")]
    public static extern uint timeEndPeriod(uint uPeriod);

    [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")]
    public static extern void CopyMemory(IntPtr dest, IntPtr src, IntPtr count);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int CX; public int CY; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public uint cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFO
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
        public uint bmiColors0;
    }

    // ---- convenience helpers (keep PS free of tricky struct marshalling) ----
    public static void GetCursorPoint(out int x, out int y)
    {
        POINT p;
        x = 0; y = 0;
        if (GetCursorPos(out p)) { x = p.X; y = p.Y; }
    }

    // Returns the rectangle of the monitor nearest to the cursor;
    // succeeds even when the monitor API fails (falls back to primary).
    public static bool GetMonitorRectAtCursor(out int x, out int y, out int w, out int h)
    {
        POINT p;
        x = 0; y = 0;
        w = GetSystemMetrics(0); h = GetSystemMetrics(1);
        if (!GetCursorPos(out p)) return false;
        IntPtr hmon = MonitorFromPoint(p, 2 /*MONITOR_DEFAULTTONEAREST*/);
        if (hmon == IntPtr.Zero) return false;
        MONITORINFO mi = new MONITORINFO();
        mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(hmon, ref mi)) return false;
        x = mi.rcMonitor.Left; y = mi.rcMonitor.Top;
        w = mi.rcMonitor.Right - mi.rcMonitor.Left;
        h = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
        return true;
    }

    // 主显示器刷新率（VREFRESH=116）；失败返回 0。
    public static int GetPrimaryRefreshHz()
    {
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return 0;
        try { return GetDeviceCaps(dc, 116); } finally { ReleaseDC(IntPtr.Zero, dc); }
    }

    public static uint BeginHighResolutionTimer() { return timeBeginPeriod(1); }
    public static uint EndHighResolutionTimer() { return timeEndPeriod(1); }
}
'@

$null = Add-Type -AssemblyName System.Drawing
$null = Add-Type -AssemblyName System.Windows.Forms

# Force a clean process exit when native multi-window worker threads are alive.
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ExitNative
{
    [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
}
'@ -ErrorAction SilentlyContinue

# --- optional DirectComposition presenter (native dx-overlay.dll) ------------
$script:DxOverlay = [IntPtr]::Zero
$script:DxDll = Join-Path $PSScriptRoot 'dx-overlay.dll'
$script:DxAvailable = $false
$script:UseDx = $UseDx.IsPresent
$script:UseMulti = $Multi.IsPresent
$script:MultiAvailable = $false
$script:MultiOverlay = [IntPtr]::Zero
if (Test-Path $script:DxDll) {
    try {
        $env:PATH = "$PSScriptRoot;$env:PATH"
        $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class DxOverlayNative
{
    [DllImport("dx-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern IntPtr DxOverlay_Create(IntPtr hwnd, int width, int height);

    [DllImport("dx-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int DxOverlay_Present(IntPtr handle, IntPtr bits, int stride);

    [DllImport("dx-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void DxOverlay_Destroy(IntPtr handle);

    [DllImport("dx-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int DxOverlay_GetLastError();

    [DllImport("dx-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern int DxOverlay_GetLastStage();
}

// DirectComposition 需要窗口从创建起就没有 redirection bitmap。
public class DxForm : Form
{
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle &= ~0x00080000; // WS_EX_LAYERED
            cp.ExStyle |= 0x00200000;  // WS_EX_NOREDIRECTIONBITMAP
            cp.ExStyle |= 0x00000020;  // WS_EX_TRANSPARENT
            cp.ExStyle |= 0x08000000;  // WS_EX_NOACTIVATE
            return cp;
        }
    }

    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnPaintBackground(PaintEventArgs e) { }
}
'@ -ReferencedAssemblies 'System.Windows.Forms.dll' -ErrorAction Stop
        $script:DxAvailable = $true
        Write-Diag ('DirectComposition DLL loaded: ' + $script:DxDll)
    } catch {
        Write-Diag ('DirectComposition DLL load failed: ' + $_.Exception.Message)
    }
} else {
    Write-Diag ('DirectComposition DLL not found: ' + $script:DxDll)
}

function Set-DxWindowStyle {
    param([IntPtr]$Hwnd, [bool]$Enable)
    $ex = [WinOverlayNative]::GetWindowLong($Hwnd, $script:GWL_EXSTYLE)
    if ($Enable) {
        $ex = ($ex -band (-bnot $script:WS_EX_LAYERED)) -bor $script:WS_EX_NOREDIRECTIONBITMAP
    } else {
        $ex = ($ex -band (-bnot $script:WS_EX_NOREDIRECTIONBITMAP)) -bor $script:WS_EX_LAYERED
    }
    [WinOverlayNative]::SetWindowLong($Hwnd, $script:GWL_EXSTYLE, $ex) | Out-Null
}

# --- optional multi-window presenter (native multi-overlay.dll) --------------
if ($script:UseMulti) {
    $multiDll = Join-Path $PSScriptRoot 'multi-overlay.dll'
    if (Test-Path $multiDll) {
        try {
            $env:PATH = "$PSScriptRoot;$env:PATH"
            $null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MultiOverlayNative
{
    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern IntPtr MultiOverlay_Create();

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void MultiOverlay_Show(IntPtr handle);

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void MultiOverlay_Hide(IntPtr handle);

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall, CharSet = CharSet.Unicode)]
    public static extern void MultiOverlay_Caption(IntPtr handle, [MarshalAs(UnmanagedType.LPWStr)] string text, int ttlMs);

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void MultiOverlay_CaptionUtf8(IntPtr handle, byte[] utf8, int ttlMs);

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void MultiOverlay_Ripple(IntPtr handle, int x, int y);

    [DllImport("multi-overlay.dll", CallingConvention = CallingConvention.StdCall)]
    public static extern void MultiOverlay_Destroy(IntPtr handle);
}
'@ -ErrorAction Stop
            $script:MultiAvailable = $true
            Write-Diag ('multi-window DLL loaded: ' + $multiDll)
        } catch {
            Write-Diag ('multi-window DLL load failed: ' + $_.Exception.Message)
        }
    } else {
        Write-Diag ('multi-window DLL not found: ' + $multiDll)
    }
}

# DPI: per-monitor v2 so every coordinate below is a physical pixel.
$script:DpiAware = $false
try { $script:DpiAware = [WinOverlayNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
if (-not $script:DpiAware) {
    try { $script:DpiAware = [WinOverlayNative]::SetProcessDPIAware() } catch { }
}

# 刷新率同步：默认跟随主显示器 Hz；-MaxFps N 可手动封顶。
$script:RefreshHz = 60
try {
    $detected = [WinOverlayNative]::GetPrimaryRefreshHz()
    if ($detected -ge 24 -and $detected -le 240) { $script:RefreshHz = [int]$detected }
} catch { }
# 注意：脚本作用域下 $script:MaxFps 与 param $MaxFps 是同一变量，不能先置 0。
$script:MaxFps = if ($MaxFps -ge 24) { [Math]::Min(240, [int]$MaxFps) } else { 0 }
$script:TargetFps = if ($script:MaxFps -gt 0) { [Math]::Min($script:RefreshHz, $script:MaxFps) } else { $script:RefreshHz }
$script:FrameIntervalMs = [Math]::Max(1, [int][Math]::Round(1000.0 / $script:TargetFps))
if (-not $script:DpiAware) { Write-Diag 'warning: could not enable DPI awareness (continuing)' }

# ---------------------------------------------------------------- constants --
$script:GWL_EXSTYLE        = -20
$script:WS_EX_TOPMOST      = 0x00000008
$script:WS_EX_TRANSPARENT  = 0x00000020
$script:WS_EX_TOOLWINDOW   = 0x00000080
$script:WS_EX_APPWINDOW    = 0x00040000
$script:WS_EX_LAYERED      = 0x00080000
$script:WS_EX_NOREDIRECTIONBITMAP = 0x00200000
$script:WS_EX_NOACTIVATE   = 0x08000000

$script:SWP_NOSIZE         = 0x0001
$script:SWP_NOMOVE         = 0x0002
$script:SWP_NOACTIVATE     = 0x0010
$script:SWP_FRAMECHANGED   = 0x0020
$script:SWP_SHOWWINDOW     = 0x0040
$script:SWP_NOOWNERZORDER  = 0x0200

$script:SW_HIDE            = 0
$script:SW_SHOWNOACTIVATE  = 4

$script:ULW_ALPHA          = 2

$script:SM_XVSCREEN = 76
$script:SM_YVSCREEN = 77
$script:SM_CXVSCREEN = 78
$script:SM_CYVSCREEN = 79
$script:SM_CXSCREEN = 0
$script:SM_CYSCREEN = 1

# color palette (spec: emerald/teal #22c55e #34d399 #4ade80 #16a34a)
$script:ColEmerald  = [System.Drawing.Color]::FromArgb(255, 34, 197, 94)
$script:ColMint     = [System.Drawing.Color]::FromArgb(255, 52, 211, 153)
$script:ColGreen400 = [System.Drawing.Color]::FromArgb(255, 74, 222, 128)
$script:ColGreen600 = [System.Drawing.Color]::FromArgb(255, 22, 163, 74)
$script:ColBlueLink = [System.Drawing.Color]::FromArgb(255, 77, 163, 255)
$script:ColBlueHover = [System.Drawing.Color]::FromArgb(255, 140, 197, 255)

function New-ColorA {
    param([int]$Alpha, [System.Drawing.Color]$Color)
    if ($Alpha -lt 0) { $Alpha = 0 }
    if ($Alpha -gt 255) { $Alpha = 255 }
    return [System.Drawing.Color]::FromArgb($Alpha, $Color.R, $Color.G, $Color.B)
}

# ------------------------------------------------------------- geometry -------
$script:VX = [WinOverlayNative]::GetSystemMetrics($script:SM_XVSCREEN)
$script:VY = [WinOverlayNative]::GetSystemMetrics($script:SM_YVSCREEN)
$script:VW = [WinOverlayNative]::GetSystemMetrics($script:SM_CXVSCREEN)
$script:VH = [WinOverlayNative]::GetSystemMetrics($script:SM_CYVSCREEN)
$script:PrimaryW = [WinOverlayNative]::GetSystemMetrics($script:SM_CXSCREEN)
$script:PrimaryH = [WinOverlayNative]::GetSystemMetrics($script:SM_CYSCREEN)
if ($script:VW -le 0) { $script:VW = $script:PrimaryW }
if ($script:VH -le 0) { $script:VH = $script:PrimaryH }
if ($script:VW -le 0) { $script:VW = 1920 }
if ($script:VH -le 0) { $script:VH = 1080 }
if ($script:PrimaryW -le 0) { $script:PrimaryW = $script:VW }
if ($script:PrimaryH -le 0) { $script:PrimaryH = $script:VH }

$script:LowDiv = 8
$script:LowW = [int][Math]::Ceiling($script:VW / [double]$script:LowDiv)
$script:LowH = [int][Math]::Ceiling($script:VH / [double]$script:LowDiv)
if ($script:LowW -lt 64) { $script:LowW = 64 }
if ($script:LowH -lt 36) { $script:LowH = 36 }
$script:FogMargin = 12          # low-res px of bleed so drifting never shows a seam
$script:FadeSeconds = 0.35      # fade-in / fade-out duration

# fonts -----------------------------------------------------------------------
$script:FontFamily = 'Microsoft YaHei UI'
try {
    $ifc = New-Object System.Drawing.Text.InstalledFontCollection
    $fontNames = @($ifc.Families | ForEach-Object { $_.Name })
    foreach ($cand in @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI')) {
        if ($fontNames -contains $cand) { $script:FontFamily = $cand; break }
    }
    $ifc.Dispose()
} catch { Write-Diag ('font enumeration failed: ' + $_.Exception.Message) }

# =============================================================================
#  GDI+ drawing helpers
# =============================================================================
function New-RoundRectPath {
    param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $maxR = [Math]::Min($W, $H) / 2.0
    if ($R -gt $maxR) { $R = [single]$maxR }
    if ($R -lt 0.5) {
        $p.AddRectangle((New-Object System.Drawing.RectangleF $X, $Y, $W, $H))
        return $p
    }
    $d = $R * 2.0
    $p.AddArc($X, $Y, $d, $d, 180, 90)
    $p.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $p.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $p.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function Set-SurroundColors {
    param($Brush, $Path, [System.Drawing.Color]$Color)
    $n = $Path.PointCount
    if ($n -le 0) { return }
    $arr = [System.Array]::CreateInstance([System.Drawing.Color], $n)
    for ($i = 0; $i -lt $n; $i++) { $arr[$i] = $Color }
    $Brush.SurroundColors = $arr
}

function Add-RadialBlob {
    param($Graphics, [single]$CX, [single]$CY, [single]$RX, [single]$RY,
          [System.Drawing.Color]$CenterColor, [System.Drawing.Color]$EdgeColor)
    if ($RX -lt 0.5 -or $RY -lt 0.5) { return }
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddEllipse($CX - $RX, $CY - $RY, $RX * 2.0, $RY * 2.0)
    $b = New-Object System.Drawing.Drawing2D.PathGradientBrush $p
    $b.CenterPoint = New-Object System.Drawing.PointF $CX, $CY
    $b.CenterColor = $CenterColor
    Set-SurroundColors -Brush $b -Path $p -Color $EdgeColor
    $Graphics.FillPath($b, $p)
    $b.Dispose()
    $p.Dispose()
}

function Add-EdgeBand {
    param($Graphics, [System.Drawing.RectangleF]$Rect,
          [System.Drawing.Color]$C0, [System.Drawing.Color]$C1,
          [System.Drawing.Color]$C2, [System.Drawing.Color]$C3,
          [single[]]$Positions, $Mode)
    if ($Rect.Width -le 0.5 -or $Rect.Height -le 0.5) { return }
    $b = New-Object System.Drawing.Drawing2D.LinearGradientBrush $Rect, $C0, $C3, $Mode
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
    $blend.Colors = [System.Drawing.Color[]]@($C0, $C1, $C2, $C3)
    $blend.Positions = $Positions
    $b.InterpolationColors = $blend
    $Graphics.FillRectangle($b, $Rect)
    $b.Dispose()
}

function New-QualityGraphics {
    param($Bitmap, [bool]$ForFog)
    $g = [System.Drawing.Graphics]::FromImage($Bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($ForFog) {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
    } else {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    }
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    return $g
}

# =============================================================================
#  Fog layers (pre-rendered low-res emerald mist masks, animated by alpha)
# =============================================================================
$script:FogDefs = @(
    @{ Color = $script:ColEmerald;  EdgeA = 64; VignA = 6; CornerA = 40; Period = 4.2; Phase = 0.00; DriftX = 3.2; DriftY = 2.0; DriftPX = 13.1; DriftPY = 9.7; Seed = 1103 },
    @{ Color = $script:ColMint;     EdgeA = 48; VignA = 5; CornerA = 33; Period = 5.6; Phase = 2.15; DriftX = 2.4; DriftY = 3.0; DriftPX = 15.7; DriftPY = 11.3; Seed = 2207 },
    @{ Color = $script:ColGreen400; EdgeA = 36; VignA = 4; CornerA = 26; Period = 6.8; Phase = 4.05; DriftX = 3.0; DriftY = 2.4; DriftPX = 9.1;  DriftPY = 16.9; Seed = 3301 }
)

function New-FogLayerBitmap {
    param([hashtable]$Def)
    $M = $script:FogMargin
    $lw = $script:LowW
    $lh = $script:LowH
    $bw = $lw + 2 * $M
    $bh = $lh + 2 * $M
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $bw, $bh, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = New-QualityGraphics -Bitmap $bmp -ForFog $true
    $g.Clear([System.Drawing.Color]::Transparent)

    $col = $Def.Color
    $fadeX = [int][Math]::Round($lw * 0.25)
    $fadeY = [int][Math]::Round($lh * 0.25)
    if ($fadeX -lt 8) { $fadeX = 8 }
    if ($fadeY -lt 8) { $fadeY = 8 }
    $platX = $M / [single]($M + $fadeX)
    $platY = $M / [single]($M + $fadeY)

    # --- soft green vignette: giant radial gradient, transparent centre -----
    Add-RadialBlob -Graphics $g -CX ([single]($M + $lw / 2.0)) -CY ([single]($M + $lh / 2.0)) `
        -RX ([single]($lw * 1.02)) -RY ([single]($lh * 1.02)) `
        -CenterColor ([System.Drawing.Color]::Transparent) `
        -EdgeColor (New-ColorA -Alpha $Def.VignA -Color $Def.Color)

    # --- four edge bands: peak alpha on the physical screen edge, fade to 0 --
    $peakTop = New-ColorA -Alpha $Def.EdgeA -Color $col
    $peakTopMid = New-ColorA -Alpha ([int]($Def.EdgeA * 0.28)) -Color $col
    $transparent = [System.Drawing.Color]::Transparent
    Add-EdgeBand -Graphics $g -Rect (New-Object System.Drawing.RectangleF 0, 0, $bw, ($M + $fadeY)) `
        -C0 $peakTop -C1 $peakTop -C2 $peakTopMid -C3 $transparent `
        -Positions ([single[]]@(0.0, $platY, 0.66, 1.0)) -Mode ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    Add-EdgeBand -Graphics $g -Rect (New-Object System.Drawing.RectangleF 0, ($bh - $M - $fadeY), $bw, ($M + $fadeY)) `
        -C0 $transparent -C1 $peakTopMid -C2 $peakTop -C3 $peakTop `
        -Positions ([single[]]@(0.0, 0.34, (1.0 - $platY), 1.0)) -Mode ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    Add-EdgeBand -Graphics $g -Rect (New-Object System.Drawing.RectangleF 0, 0, ($M + $fadeX), $bh) `
        -C0 $peakTop -C1 $peakTop -C2 $peakTopMid -C3 $transparent `
        -Positions ([single[]]@(0.0, $platX, 0.55, 1.0)) -Mode ([System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
    Add-EdgeBand -Graphics $g -Rect (New-Object System.Drawing.RectangleF ($bw - $M - $fadeX), 0, ($M + $fadeX), $bh) `
        -C0 $transparent -C1 $peakTopMid -C2 $peakTop -C3 $peakTop `
        -Positions ([single[]]@(0.0, 0.45, (1.0 - $platX), 1.0)) -Mode ([System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)

    # --- denser, rounder corner mist: a little stronger than mid-edges -------
    $cornerCol = New-ColorA -Alpha $Def.CornerA -Color $col
    $cornerEdge = [System.Drawing.Color]::Transparent
    $crx = [single]($lw * 0.52)
    $cry = [single]($lh * 0.62)
    $corners = @(
        @($M, $M), @(($M + $lw), $M), @($M, ($M + $lh)), @(($M + $lw), ($M + $lh))
    )
    foreach ($c in $corners) {
        Add-RadialBlob -Graphics $g -CX ([single]$c[0]) -CY ([single]$c[1]) -RX $crx -RY $cry `
            -CenterColor $cornerCol -EdgeColor $cornerEdge
    }

    # --- procedural mist blobs for texture (deterministic per layer) --------
    $rnd = New-Object System.Random ($Def.Seed)
    $edgeBandX = [Math]::Min($bw * 0.42, 110.0)
    $edgeBandY = [Math]::Min($bh * 0.45, 90.0)
    for ($i = 0; $i -lt 70; $i++) {
        $side = $rnd.Next(0, 4)
        $alpha = [int](10 + $rnd.NextDouble() * 22)
        $ci = New-ColorA -Alpha $alpha -Color $col
        $rx = [single](6.0 + $rnd.NextDouble() * 26.0)
        $ry = [single](5.0 + $rnd.NextDouble() * 22.0)
        switch ($side) {
            0 { $cx = [single]($M + $rnd.NextDouble() * $lw);                $cy = [single]($M + $rnd.NextDouble() * $edgeBandY) }
            1 { $cx = [single]($M + $rnd.NextDouble() * $lw);                $cy = [single]($M + $lh - $rnd.NextDouble() * $edgeBandY) }
            2 { $cx = [single]($M + $rnd.NextDouble() * $edgeBandX);         $cy = [single]($M + $rnd.NextDouble() * $lh) }
            3 { $cx = [single]($M + $lw - $rnd.NextDouble() * $edgeBandX);   $cy = [single]($M + $rnd.NextDouble() * $lh) }
        }
        Add-RadialBlob -Graphics $g -CX $cx -CY $cy -RX $rx -RY $ry -CenterColor $ci -EdgeColor ([System.Drawing.Color]::Transparent)
    }
    # a few very faint interior wisps so the fog reads as volumetric
    for ($i = 0; $i -lt 6; $i++) {
        $ci = New-ColorA -Alpha ([int](2 + $rnd.NextDouble() * 3)) -Color $col
        Add-RadialBlob -Graphics $g -CX ([single]($M + $rnd.NextDouble() * $lw)) -CY ([single]($M + $rnd.NextDouble() * $lh)) `
            -RX ([single](30 + $rnd.NextDouble() * 50)) -RY ([single](22 + $rnd.NextDouble() * 40)) `
            -CenterColor $ci -EdgeColor ([System.Drawing.Color]::Transparent)
    }

    $g.Dispose()
    return $bmp
}

# =============================================================================
#  Thin breathing border glow (replaces the old wide mist that tinted content)
# =============================================================================
$script:BorderPath = $null
$script:BorderStrips = $null
$script:BorderAttrs = $null
$script:BorderStripSize = 24

# 预渲染边框条：只在贴边 32px 内生成 4 条 ARGB 贴图，运行时每帧 4 次小 DrawImage。
function New-BorderStrip {
    param([ValidateSet('top', 'bottom', 'left', 'right')][string]$Edge)
    $B = $script:BorderStripSize
    $isHorizontal = ($Edge -eq 'top' -or $Edge -eq 'bottom')
    $w = if ($isHorizontal) { $script:VW } else { $B }
    $h = if ($isHorizontal) { $B } else { [Math]::Max(1, $script:VH - 2 * $B) }
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = New-QualityGraphics -Bitmap $bmp -ForFog $false
    $g.Clear([System.Drawing.Color]::Transparent)
    if ($Edge -eq 'bottom') {
        $g.TranslateTransform(0, -($script:VH - $B))
    } elseif ($Edge -eq 'left') {
        $g.TranslateTransform(0, -$B)
    } elseif ($Edge -eq 'right') {
        $g.TranslateTransform(-($script:VW - $B), -$B)
    }

    # 预渲染参考强度：core 约 0.68，glow 约 0.09；运行期再整体乘呼吸 alpha。
    $glowLayers = @(
        @{ Width = 24.0; Weight = 0.22 },
        @{ Width = 15.0; Weight = 0.34 },
        @{ Width = 8.0;  Weight = 0.52 },
        @{ Width = 4.0;  Weight = 0.75 }
    )
    foreach ($layer in $glowLayers) {
        $alpha = [int][Math]::Round(255.0 * 0.09 * $layer.Weight)
        if ($alpha -le 0) { continue }
        $pen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha $alpha -Color $script:ColEmerald), ([single]$layer.Width)
        try {
            $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
            $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $g.DrawPath($pen, $script:BorderPath)
        } finally { $pen.Dispose() }
    }
    $core = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha 173 -Color $script:ColMint), ([single]2.0)
    try {
        $core.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
        $core.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPath($core, $script:BorderPath)
    } finally { $core.Dispose() }
    $g.Dispose()
    return @{ Bmp = $bmp; W = $w; H = $h }
}

function Build-BorderSprites {
    if ($null -ne $script:BorderStrips) { return }
    $inset = 1.0
    $script:BorderPath = New-RoundRectPath -X $inset -Y $inset `
        -W ([single]($script:VW - 2.0 * $inset)) -H ([single]($script:VH - 2.0 * $inset)) -R 14.0
    $script:BorderStrips = @{
        top = New-BorderStrip -Edge 'top'
        bottom = New-BorderStrip -Edge 'bottom'
        left = New-BorderStrip -Edge 'left'
        right = New-BorderStrip -Edge 'right'
    }
    $script:BorderAttrs = New-AlphaAttributes
}

function Draw-BorderGlow {
    param($Graphics, [single]$Fade, [double]$T)
    if ($Fade -le 0.002) { return }
    if ($null -eq $script:BorderStrips) { Build-BorderSprites }

    # 缓慢呼吸：两条不同周期的正弦叠加，避免机械感（周期约 5.2s / 7.6s）。
    $breath1 = 0.5 + 0.5 * [Math]::Sin(2.0 * [Math]::PI * $T / 5.2)
    $breath2 = 0.5 + 0.5 * [Math]::Sin(2.0 * [Math]::PI * $T / 7.6 + 1.7)
    $breath = 0.5 * ($breath1 + $breath2)
    $alpha = [single]($Fade * (0.82 + 0.18 * $breath))
    Set-AlphaAttr -Attr $script:BorderAttrs -Alpha $alpha
    $ia = $script:BorderAttrs.IA
    $B = $script:BorderStripSize
    $top = $script:BorderStrips.top
    $bottom = $script:BorderStrips.bottom
    $left = $script:BorderStrips.left
    $right = $script:BorderStrips.right
    $Graphics.DrawImage($top.Bmp, (New-Object System.Drawing.Rectangle 0, 0, $top.W, $top.H), 0, 0, $top.W, $top.H, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $Graphics.DrawImage($bottom.Bmp, (New-Object System.Drawing.Rectangle 0, ($script:VH - $bottom.H), $bottom.W, $bottom.H), 0, 0, $bottom.W, $bottom.H, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $Graphics.DrawImage($left.Bmp, (New-Object System.Drawing.Rectangle 0, $B, $left.W, $left.H), 0, 0, $left.W, $left.H, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $Graphics.DrawImage($right.Bmp, (New-Object System.Drawing.Rectangle ($script:VW - $right.W), $B, $right.W, $right.H), 0, 0, $right.W, $right.H, [System.Drawing.GraphicsUnit]::Pixel, $ia)
}

function Build-FogLayers {
    $script:FogLayers = @()
    for ($i = 0; $i -lt $script:FogDefs.Count; $i++) {
        $def = $script:FogDefs[$i]
        $bmp = New-FogLayerBitmap -Def $def
        $ia = New-Object System.Drawing.Imaging.ImageAttributes
        $script:FogLayers += @{
            Bmp = $bmp; W = $bmp.Width; H = $bmp.Height; IA = $ia
            MinA = 0.45; MaxA = 0.95
            Period = [double]$def.Period; Phase = [double]$def.Phase
            DriftX = [double]$def.DriftX; DriftY = [double]$def.DriftY
            DriftPX = [double]$def.DriftPX; DriftPY = [double]$def.DriftPY
            Color = $def.Color
        }
    }
}

# =============================================================================
#  Banner artwork
# =============================================================================
function New-AlphaAttributes {
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = 1.0; $cm.Matrix11 = 1.0; $cm.Matrix22 = 1.0
    $cm.Matrix33 = 1.0; $cm.Matrix44 = 1.0
    $ia.SetColorMatrix($cm)
    return @{ IA = $ia }
}

# multiply the source-alpha of an ImageAttributes by $Alpha (0..1)
function Set-AlphaAttr {
    param($Attr, [single]$Alpha)
    if ($null -eq $Attr) { return }
    $ia = $Attr
    if ($Attr -is [hashtable]) { $ia = $Attr.IA }
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = 1.0; $cm.Matrix11 = 1.0; $cm.Matrix22 = 1.0
    $cm.Matrix33 = $Alpha; $cm.Matrix44 = 1.0
    $ia.SetColorMatrix($cm)
}

# --- ACTIVE banner: pill "Agent正在操控此电脑" ------------------------------
function Build-ActiveChrome {
    $mBmp = New-Object System.Drawing.Bitmap -ArgumentList 4, 4
    $mg = [System.Drawing.Graphics]::FromImage($mBmp)
    $mg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $font = New-Object System.Drawing.Font -ArgumentList $script:FontFamily, ([single]15.0), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $strFmt = [System.Drawing.StringFormat]::GenericTypographic
    $text = 'Agent正在操控此电脑'
    $textSize = $mg.MeasureString($text, $font, (New-Object System.Drawing.PointF 0, 0), $strFmt)
    $mg.Dispose()
    $mBmp.Dispose()

    $PadVar = 18
    $pillH = 40
    $dotCx = 22
    $textX = 40
    $rightPad = 20
    $textW = [int][Math]::Ceiling($textSize.Width)
    $pillW = $textX + $textW + $rightPad
    $cW = $pillW + 2 * $PadVar
    $cH = $pillH + 2 * $PadVar

    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $cW, $cH, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = New-QualityGraphics -Bitmap $bmp -ForFog $false
    $g.Clear([System.Drawing.Color]::Transparent)

    $pillRect = New-Object System.Drawing.RectangleF $PadVar, $PadVar, $pillW, $pillH
    $path = New-RoundRectPath -X $PadVar -Y $PadVar -W $pillW -H $pillH -R ($pillH / 2.0)

    # soft emerald halo behind the pill
    $glowDefs = @(
        @{ A = 10; W = 16.0 }, @{ A = 16; W = 11.0 }, @{ A = 24; W = 7.0 }, @{ A = 34; W = 3.5 }
    )
    foreach ($gd in $glowDefs) {
        $pen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha $gd.A -Color $script:ColEmerald), ([single]$gd.W)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }

    # translucent green-black body
    $bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList `
        (New-Object System.Drawing.RectangleF $PadVar, $PadVar, $pillW, $pillH), `
        (New-ColorA -Alpha 232 -Color ([System.Drawing.Color]::FromArgb(255, 8, 26, 16))), `
        (New-ColorA -Alpha 242 -Color ([System.Drawing.Color]::FromArgb(255, 3, 13, 8))), `
        ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillPath($bodyBrush, $path)
    $bodyBrush.Dispose()

    # glassy top sheen
    $g.SetClip($path)
    $sheenRect = New-Object System.Drawing.RectangleF $PadVar, $PadVar, $pillW, ($pillH * 0.58)
    $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList `
        $sheenRect, (New-ColorA -Alpha 34 -Color ([System.Drawing.Color]::FromArgb(255, 190, 255, 220))), `
        ([System.Drawing.Color]::Transparent), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillRectangle($sheen, $sheenRect)
    $sheen.Dispose()
    $g.ResetClip()

    # 1px emerald border
    $borderPen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha 205 -Color $script:ColMint), ([single]1.0)
    $g.DrawPath($borderPen, $path)
    $borderPen.Dispose()
    # faint inner white highlight on the upper edge
    $hlPen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha 28 -Color ([System.Drawing.Color]::White)), ([single]1.0)
    $g.DrawPath($hlPen, $path)
    $hlPen.Dispose()

    # text: soft dark shadow + light green-white glyphs
    $textRectY = $PadVar + ($pillH - $textSize.Height) / 2.0
    $shadowBrush = New-Object System.Drawing.SolidBrush -ArgumentList (New-ColorA -Alpha 130 -Color ([System.Drawing.Color]::Black))
    $textBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 232, 255, 241))
    $g.DrawString($text, $font, $shadowBrush, [single]($PadVar + $textX + 0.8), [single]($textRectY + 1.2), $strFmt)
    $g.DrawString($text, $font, $textBrush, [single]($PadVar + $textX), [single]$textRectY, $strFmt)
    $shadowBrush.Dispose()
    $textBrush.Dispose()
    $g.Dispose()

    $screenX = [int](($script:PrimaryW - $cW) / 2)
    $pillTop = 18
    $screenY = $pillTop - $PadVar

    return @{
        Bmp = $bmp; W = $cW; H = $cH
        X = $screenX; Y = $screenY
        PillW = $pillW; PillH = $pillH; G = $PadVar
        Font = $font; FontSize = 15.0; Text = $text; TextW = $textW
        DotCx = $dotCx
    }
}

# --- pulsing dot sprite ------------------------------------------------------
function Build-DotSprite {
    $sz = 44
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $sz, $sz, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = New-QualityGraphics -Bitmap $bmp -ForFog $false
    $g.Clear([System.Drawing.Color]::Transparent)
    $cx = $sz / 2.0
    $cy = $sz / 2.0
    $ringDefs = @(
        @{ R = 17.5; A = 10; C = $script:ColGreen400 },
        @{ R = 14.0; A = 16; C = $script:ColGreen400 },
        @{ R = 11.0; A = 26; C = $script:ColGreen400 },
        @{ R = 8.4; A = 42; C = $script:ColMint },
        @{ R = 6.2; A = 76; C = $script:ColMint },
        @{ R = 4.6; A = 150; C = $script:ColGreen400 },
        @{ R = 3.1; A = 238; C = [System.Drawing.Color]::FromArgb(255, 200, 255, 220) },
        @{ R = 2.0; A = 255; C = [System.Drawing.Color]::White }
    )
    foreach ($rd in $ringDefs) {
        $brush = New-Object System.Drawing.SolidBrush -ArgumentList (New-ColorA -Alpha $rd.A -Color $rd.C)
        $g.FillEllipse($brush, [single]($cx - $rd.R), [single]($cy - $rd.R), [single]($rd.R * 2), [single]($rd.R * 2))
        $brush.Dispose()
    }
    $g.Dispose()
    return @{ Bmp = $bmp; Size = $sz }
}

# --- PAUSED banner layout + artwork -----------------------------------------
function Build-PausedLayout {
    $mBmp = New-Object System.Drawing.Bitmap -ArgumentList 4, 4
    $mg = [System.Drawing.Graphics]::FromImage($mBmp)
    $mg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $prefixFont = New-Object System.Drawing.Font -ArgumentList $script:FontFamily, ([single]14.0), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $linkFont = New-Object System.Drawing.Font -ArgumentList $script:FontFamily, ([single]14.0), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $strFmt = [System.Drawing.StringFormat]::GenericTypographic
    $prefix = '用户正在操控电脑-'
    $link = '点击继续'
    $prefixSize = $mg.MeasureString($prefix, $prefixFont, (New-Object System.Drawing.PointF 0, 0), $strFmt)
    $linkSize = $mg.MeasureString($link, $linkFont, (New-Object System.Drawing.PointF 0, 0), $strFmt)
    $mg.Dispose()
    $mBmp.Dispose()

    $PadVar = 16
    $pillH = 36
    $leftPad = 15
    $gap = 3
    $rightPad = 15
    $prefixW = [int][Math]::Ceiling($prefixSize.Width)
    $linkW = [int][Math]::Ceiling($linkSize.Width)
    $linkH = [int][Math]::Ceiling($linkSize.Height)
    $prefixH = [int][Math]::Ceiling($prefixSize.Height)
    $pillW = $leftPad + $prefixW + $gap + $linkW + $rightPad
    $winW = $pillW + 2 * $PadVar
    $winH = $pillH + 2 * $PadVar

    $linkX = $PadVar + $leftPad + $prefixW + $gap
    $linkY = $PadVar + [int](($pillH - $linkSize.Height) / 2.0)
    $prefixX = $PadVar + $leftPad
    $prefixY = $PadVar + [int](($pillH - $prefixSize.Height) / 2.0)

    return @{
        G = $PadVar; PillW = $pillW; PillH = $pillH; WinW = $winW; WinH = $winH
        PrefixFont = $prefixFont; LinkFont = $linkFont; StrFmt = $strFmt
        Prefix = $prefix; Link = $link
        PrefixX = $prefixX; PrefixY = $prefixY
        LinkX = $linkX; LinkY = $linkY; LinkW = $linkW; LinkH = $linkH
        ResumeRectRel = New-Object System.Drawing.Rectangle $linkX, $linkY, $linkW, $linkH
    }
}

function Build-PausedBannerBitmap {
    param([bool]$Hover)
    $L = $script:PausedLayout
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $L.WinW, $L.WinH, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $g = New-QualityGraphics -Bitmap $bmp -ForFog $false
    $g.Clear([System.Drawing.Color]::Transparent)

    $PadVar = $L.G
    $path = New-RoundRectPath -X $PadVar -Y $PadVar -W $L.PillW -H $L.PillH -R ($L.PillH / 2.0)

    # soft blue halo
    $glowDefs = @(
        @{ A = 9; W = 14.0 }, @{ A = 14; W = 9.5 }, @{ A = 21; W = 6.0 }, @{ A = 30; W = 3.0 }
    )
    foreach ($gd in $glowDefs) {
        $pen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha $gd.A -Color $script:ColBlueLink), ([single]$gd.W)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPath($pen, $path)
        $pen.Dispose()
    }

    $bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList `
        (New-Object System.Drawing.RectangleF $PadVar, $PadVar, $L.PillW, $L.PillH), `
        (New-ColorA -Alpha 238 -Color ([System.Drawing.Color]::FromArgb(255, 6, 12, 26))), `
        (New-ColorA -Alpha 244 -Color ([System.Drawing.Color]::FromArgb(255, 8, 16, 32))), `
        ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillPath($bodyBrush, $path)
    $bodyBrush.Dispose()

    $g.SetClip($path)
    $sheenRect = New-Object System.Drawing.RectangleF $PadVar, $PadVar, $L.PillW, ($L.PillH * 0.55)
    $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList `
        $sheenRect, (New-ColorA -Alpha 26 -Color ([System.Drawing.Color]::FromArgb(255, 170, 210, 255))), `
        ([System.Drawing.Color]::Transparent), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillRectangle($sheen, $sheenRect)
    $sheen.Dispose()
    $g.ResetClip()

    $borderPen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha 200 -Color $script:ColBlueLink), ([single]1.0)
    $g.DrawPath($borderPen, $path)
    $borderPen.Dispose()
    $hlPen = New-Object System.Drawing.Pen -ArgumentList (New-ColorA -Alpha 22 -Color ([System.Drawing.Color]::White)), ([single]1.0)
    $g.DrawPath($hlPen, $path)
    $hlPen.Dispose()

    # prefix text (neutral light blue-white)
    $prefixBrush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(240, 208, 224, 246))
    $g.DrawString($L.Prefix, $L.PrefixFont, $prefixBrush, [single]$L.PrefixX, [single]$L.PrefixY, $L.StrFmt)
    $prefixBrush.Dispose()

    # clickable link text (blue, brighter + underlined on hover)
    $linkColor = if ($Hover) { $script:ColBlueHover } else { $script:ColBlueLink }
    $linkBrush = New-Object System.Drawing.SolidBrush -ArgumentList $linkColor
    $g.DrawString($L.Link, $L.LinkFont, $linkBrush, [single]$L.LinkX, [single]$L.LinkY, $L.StrFmt)
    $linkBrush.Dispose()
    if ($Hover) {
        $uPen = New-Object System.Drawing.Pen -ArgumentList $linkColor, ([single]1.4)
        $uy = [single]($L.LinkY + $L.LinkH - 1.0)
        $g.DrawLine($uPen, [single]$L.LinkX, $uy, [single]($L.LinkX + $L.LinkW - 1.0), $uy)
        $uPen.Dispose()
    }
    $g.Dispose()
    return $bmp
}

# =============================================================================
#  Layered window plumbing
# =============================================================================
function New-DibSurface {
    param([int]$W, [int]$H)
    $hdcScreen = [WinOverlayNative]::GetDC([IntPtr]::Zero)
    $memDC = [WinOverlayNative]::CreateCompatibleDC($hdcScreen)
    $bi = New-Object WinOverlayNative+BITMAPINFO
    $bi.biSize = 40
    $bi.biWidth = $W
    $bi.biHeight = -$H          # top-down
    $bi.biPlanes = 1
    $bi.biBitCount = 32
    $bi.biCompression = 0       # BI_RGB
    $bits = [IntPtr]::Zero
    $hbm = [WinOverlayNative]::CreateDIBSection($hdcScreen, [ref]$bi, 0, [ref]$bits, [IntPtr]::Zero, 0)
    if ($hbm -eq [IntPtr]::Zero -or $bits -eq [IntPtr]::Zero) {
        throw ('CreateDIBSection failed ({0}x{1}) err={2}' -f $W, $H, [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    $old = [WinOverlayNative]::SelectObject($memDC, $hbm)
    [WinOverlayNative]::ReleaseDC([IntPtr]::Zero, $hdcScreen) | Out-Null
    return @{ DC = $memDC; HBmp = $hbm; Old = $old; Bits = $bits; W = $W; H = $H }
}

function New-UlwSurface {
    param([string]$Name, $Bitmap, [int]$W, [int]$H)
    $dib = New-DibSurface -W $W -H $H
    # 28-byte param block: POINT pptDst (8) | SIZE psize (8) | POINT pptSrc (8) | BLENDFUNCTION (4)
    $block = [Runtime.InteropServices.Marshal]::AllocHGlobal(28)
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 0, 0)       # pptDst.x
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 4, 0)       # pptDst.y
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 8, $W)      # psize.cx
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 12, $H)     # psize.cy
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 16, 0)      # pptSrc.x
    [Runtime.InteropServices.Marshal]::WriteInt32($block, 20, 0)      # pptSrc.y
    [Runtime.InteropServices.Marshal]::WriteByte($block, 24, 0)       # BlendOp   = AC_SRC_OVER
    [Runtime.InteropServices.Marshal]::WriteByte($block, 25, 0)       # BlendFlags
    [Runtime.InteropServices.Marshal]::WriteByte($block, 26, 255)     # SourceConstantAlpha
    [Runtime.InteropServices.Marshal]::WriteByte($block, 27, 1)       # AlphaFormat = AC_SRC_ALPHA
    return @{
        Name = $Name; BitmapObj = $Bitmap; DC = $dib.DC; HBmp = $dib.HBmp; Old = $dib.Old; Bits = $dib.Bits
        W = $W; H = $H; Rect = (New-Object System.Drawing.Rectangle 0, 0, $W, $H)
        Params = $block
        PtDst = $block
        SizePtr = [IntPtr]::Add($block, 8)
        PtSrc = [IntPtr]::Add($block, 16)
        BlendPtr = [IntPtr]::Add($block, 24)
    }
}

function Copy-BitmapToSurface {
    param($Surface)
    $lk = $Surface.BitmapObj.LockBits($Surface.Rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    try {
        [WinOverlayNative]::CopyMemory($Surface.Bits, $lk.Scan0, [IntPtr]($Surface.W * $Surface.H * 4))
    } finally {
        $Surface.BitmapObj.UnlockBits($lk)
    }
}

function Present-Surface {
    param($Surface, [IntPtr]$Hwnd, [int]$X, [int]$Y)
    if ($Surface.Name -eq 'overlay' -and $script:DxOverlay -ne [IntPtr]::Zero) {
        $lk = $Surface.BitmapObj.LockBits($Surface.Rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
        try {
            $hr = [DxOverlayNative]::DxOverlay_Present($script:DxOverlay, $lk.Scan0, $lk.Stride)
            if ($hr -ne 0) { throw ('DxOverlay_Present failed hr=0x{0:X8}' -f $hr) }
        } finally {
            $Surface.BitmapObj.UnlockBits($lk)
        }
        return
    }
    Copy-BitmapToSurface -Surface $Surface
    [Runtime.InteropServices.Marshal]::WriteInt32($Surface.Params, 0, $X)
    [Runtime.InteropServices.Marshal]::WriteInt32($Surface.Params, 4, $Y)
    $ok = [WinOverlayNative]::UpdateLayeredWindow($Hwnd, [IntPtr]::Zero, $Surface.PtDst, $Surface.SizePtr,
        $Surface.DC, $Surface.PtSrc, 0, $Surface.BlendPtr, $script:ULW_ALPHA)
    if (-not $ok) {
        throw ('UpdateLayeredWindow failed err={0}' -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
}

function Dispose-UlwSurface {
    param($Surface)
    try { if ($Surface.BitmapObj) { $Surface.BitmapObj.Dispose() } } catch { }
    try { [WinOverlayNative]::SelectObject($Surface.DC, $Surface.Old) | Out-Null } catch { }
    try { [WinOverlayNative]::DeleteObject($Surface.HBmp) | Out-Null } catch { }
    try { [WinOverlayNative]::DeleteDC($Surface.DC) | Out-Null } catch { }
    try { [Runtime.InteropServices.Marshal]::FreeHGlobal($Surface.Params) } catch { }
}

# ------------------------------------------------------------------ windows --
function New-OverlayWindow {
    param([string]$Title, [int]$X, [int]$Y, [int]$W, [int]$H, [bool]$ClickThrough, [switch]$Dx)
    $f = if ($Dx) { New-Object DxForm } else { New-Object System.Windows.Forms.Form }
    $f.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
    $f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $f.ShowInTaskbar = $false
    $f.MinimizeBox = $false
    $f.MaximizeBox = $false
    $f.ControlBox = $false
    $f.Text = $Title
    $f.TopMost = $true
    $f.Location = New-Object System.Drawing.Point $X, $Y
    $f.Size = New-Object System.Drawing.Size $W, $H
    $f.BackColor = [System.Drawing.Color]::Black
    $null = $f.Handle
    $ex = [WinOverlayNative]::GetWindowLong($f.Handle, $script:GWL_EXSTYLE)
    if ($Dx) {
        $ex = ($ex -band (-bnot $script:WS_EX_LAYERED)) -bor $script:WS_EX_NOREDIRECTIONBITMAP -bor $script:WS_EX_TOOLWINDOW -bor $script:WS_EX_NOACTIVATE
        if ($ClickThrough) { $ex = $ex -bor $script:WS_EX_TRANSPARENT }
    } else {
        $ex = $ex -bor $script:WS_EX_LAYERED -bor $script:WS_EX_TOOLWINDOW -bor $script:WS_EX_NOACTIVATE
        if ($ClickThrough) { $ex = $ex -bor $script:WS_EX_TRANSPARENT }
    }
    $ex = $ex -band (-bnot $script:WS_EX_APPWINDOW)
    [WinOverlayNative]::SetWindowLong($f.Handle, $script:GWL_EXSTYLE, $ex) | Out-Null
    return $f
}

function Show-WindowTopmost {
    param([IntPtr]$Hwnd, [int]$X, [int]$Y, [int]$W, [int]$H)
    $flags = $script:SWP_NOACTIVATE -bor $script:SWP_SHOWWINDOW -bor $script:SWP_FRAMECHANGED
    [WinOverlayNative]::SetWindowPos($Hwnd, [IntPtr](-1), $X, $Y, $W, $H, $flags) | Out-Null
}

function Hide-Window {
    param([IntPtr]$Hwnd)
    [WinOverlayNative]::ShowWindow($Hwnd, $script:SW_HIDE) | Out-Null
}

function Assert-Topmost {
    param([IntPtr]$Hwnd)
    $flags = $script:SWP_NOMOVE -bor $script:SWP_NOSIZE -bor $script:SWP_NOACTIVATE -bor $script:SWP_NOOWNERZORDER
    [WinOverlayNative]::SetWindowPos($Hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags) | Out-Null
}

# =============================================================================
#  State
# =============================================================================
$script:Mode = 'idle'          # idle | active | paused
$script:Fade = 0.0
$script:LastRenderSeconds = 0.0
$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:FrameCount = 0
$script:LastTitleSeconds = 0.0
$script:LastFpsSeconds = 0.0
$script:LastFpsFrames = 0
$script:MeasuredFps = 0.0
$script:LastTopmostSeconds = 0.0
$script:NeedFadeOut = $false
$script:TickDiagnosticDone = $false
$script:PausedHover = $false
$script:PausedVisible = $false
$script:PausedX = 0
$script:PausedY = 0
$script:OverlayVisible = $false
$script:ExitRequested = $false
$script:ShutdownDone = $false
$script:CleanScreenInfo = $null
$script:CaptionText = ''
$script:CaptionUntil = 0.0
$script:Ripples = New-Object System.Collections.ArrayList

# =============================================================================
#  Captions / click ripple
# =============================================================================
function Set-Caption {
    param([string]$Text, [int]$TtlMs = 1800)
    if ([string]::IsNullOrWhiteSpace($Text)) { return }
    $clean = ($Text -replace '\s+', ' ').Trim()
    if ($clean.Length -gt 48) { $clean = $clean.Substring(0, 47) + '…' }
    $script:CaptionText = $clean
    $script:CaptionUntil = $script:Clock.Elapsed.TotalSeconds + ([Math]::Max(600, $TtlMs) / 1000.0)
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($clean)
            [MultiOverlayNative]::MultiOverlay_CaptionUtf8($script:MultiOverlay, $bytes, [Math]::Max(600, $TtlMs))
        } catch { }
        return
    }
    if ($script:Mode -eq 'active') { try { Show-OverlayWindowNow } catch { } }
}

function Add-Ripple {
    param([double]$X, [double]$Y)
    if ([double]::IsNaN($X) -or [double]::IsNaN($Y)) { return }
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        # Native ripple windows are topmost layered windows at the click point;
        # they can swallow the next click on canvas apps. Keep the click stream
        # clean until ripple is drawn inside a click-through surface.
        return
    }
    $null = $script:Ripples.Add([pscustomobject]@{
        X = $X
        Y = $Y
        Start = $script:Clock.Elapsed.TotalSeconds
    })
    while ($script:Ripples.Count -gt 8) { $script:Ripples.RemoveAt(0) }
    if ($script:Mode -eq 'active') { try { Show-OverlayWindowNow } catch { } }
}

function Draw-Ripples {
    param($Graphics, [single]$Fade)
    if ($script:Ripples.Count -eq 0) { return }
    $now = $script:Clock.Elapsed.TotalSeconds
    for ($i = $script:Ripples.Count - 1; $i -ge 0; $i--) {
        $ripple = $script:Ripples[$i]
        $age = $now - [double]$ripple.Start
        if ($age -gt 0.9) { $script:Ripples.RemoveAt($i); continue }
        $progress = [Math]::Min(1.0, [Math]::Max(0.0, $age / 0.7))
        $radius = [single](10.0 + 46.0 * $progress)
        $alpha = [int](255 * $Fade * (1.0 - $progress) * 0.78)
        if ($alpha -le 0) { continue }
        $lx = [single]([double]$ripple.X - $script:VX)
        $ly = [single]([double]$ripple.Y - $script:VY)
        $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb($alpha, 52, 211, 153)), ([single]2.4)
        try {
            $Graphics.DrawEllipse($pen, [single]($lx - $radius), [single]($ly - $radius), [single]($radius * 2), [single]($radius * 2))
        } finally { $pen.Dispose() }
        $dotAlpha = [int](220 * $Fade * (1.0 - $progress))
        $brush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb($dotAlpha, 167, 243, 208))
        try { $Graphics.FillEllipse($brush, [single]($lx - 3), [single]($ly - 3), [single]6, [single]6) } finally { $brush.Dispose() }
    }
}

function Draw-Caption {
    param($Graphics, [single]$Fade)
    if ([string]::IsNullOrEmpty($script:CaptionText)) { return }
    $remaining = $script:CaptionUntil - $script:Clock.Elapsed.TotalSeconds
    if ($remaining -le 0) { return }
    $alpha = [Math]::Min(1.0, $remaining / 0.35)
    if ($alpha -le 0) { return }
    $font = $script:CaptionFont
    if ($null -eq $font) { return }
    $size = $Graphics.MeasureString($script:CaptionText, $font)
    $padX = [single]14
    $height = [single]30
    $width = [single]($size.Width + 2 * $padX)
    $x = [single](($script:VW - $width) / 2)
    $y = [single]($script:ActiveChrome.Y + $script:ActiveChrome.H + 6 - $script:VY)
    $path = New-RoundRectPath -X $x -Y $y -W $width -H $height -R ($height / 2.0)
    try {
        $fill = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb([int](205 * $Fade * $alpha), 5, 22, 16))
        try { $Graphics.FillPath($fill, $path) } finally { $fill.Dispose() }
        $pen = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb([int](150 * $Fade * $alpha), 52, 211, 153)), ([single]1.2)
        try { $Graphics.DrawPath($pen, $path) } finally { $pen.Dispose() }
        $text = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb([int](245 * $Fade * $alpha), 236, 253, 245))
        try {
            $Graphics.DrawString($script:CaptionText, $font, $text, [single]($x + $padX), [single]($y + ($height - $size.Height) / 2.0))
        } finally { $text.Dispose() }
    } finally { $path.Dispose() }
}

# =============================================================================
#  Rendering
# =============================================================================
function Render-ActiveFrame {
    $now = $script:Clock.Elapsed.TotalSeconds
    $dt = [Math]::Min(0.25, [Math]::Max(0.0, $now - $script:LastRenderSeconds))
    $script:LastRenderSeconds = $now

    $target = 0.0
    if ($script:Mode -eq 'active') { $target = 1.0 }
    $step = $dt / [double]$script:FadeSeconds
    if ($script:Fade -lt $target) {
        $script:Fade = [Math]::Min($target, $script:Fade + $step)
    } elseif ($script:Fade -gt $target) {
        $script:Fade = [Math]::Max($target, $script:Fade - $step)
    }

    if ($script:Fade -le 0.002 -and $script:Mode -ne 'active') {
        if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
        return
    }

    $fade = [single]$script:Fade
    $t = $now

    # ---- 1. clear the frame (no wide mist; only a thin border glow) --------
    $full = $script:FullG
    $full.ResetTransform()
    $full.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $full.Clear([System.Drawing.Color]::Transparent)

    # ---- 2. thin breathing border glow (centre stays fully transparent) ----
    $full.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $full.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $full.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    Draw-BorderGlow -Graphics $full -Fade $fade -T $t

    # ---- 3. banner chrome --------------------------------------------------
    $chrome = $script:ActiveChrome
    $chromeX = $chrome.X - $script:VX
    $chromeY = $chrome.Y - $script:VY
    Set-AlphaAttr -Attr $script:ChromeAttrs.IA -Alpha $fade
    $full.DrawImage($chrome.Bmp, (New-Object System.Drawing.Rectangle $chromeX, $chromeY, $chrome.W, $chrome.H),
        0, 0, $chrome.W, $chrome.H, [System.Drawing.GraphicsUnit]::Pixel, $script:ChromeAttrs.IA)

    # ---- 4. pulsing dot ----------------------------------------------------
    $pulse = 0.72 + 0.28 * (0.5 + 0.5 * [Math]::Sin(2.0 * [Math]::PI * $t / 2.4))
    $scale = 0.94 + 0.10 * (0.5 + 0.5 * [Math]::Sin(2.0 * [Math]::PI * $t / 2.4 - 0.9))
    $dotCx = $chrome.X + $chrome.G + $chrome.DotCx - $script:VX
    $dotCy = $chrome.Y + $chrome.G + ($chrome.PillH / 2.0) - $script:VY
    $spr = $script:DotSprite
    $dw = [int][Math]::Round($spr.Size * $scale)
    $dh = $dw
    $dRect = New-Object System.Drawing.Rectangle ([int][Math]::Round($dotCx - $dw / 2.0)), ([int][Math]::Round($dotCy - $dh / 2.0)), $dw, $dh
    Set-AlphaAttr -Attr $script:DotAttrs.IA -Alpha ([single]($fade * $pulse))
    $full.DrawImage($spr.Bmp, $dRect, 0, 0, $spr.Size, $spr.Size, [System.Drawing.GraphicsUnit]::Pixel, $script:DotAttrs.IA)

    # ---- 5. captions / click ripple ----------------------------------------
    Draw-Ripples -Graphics $full -Fade $fade
    Draw-Caption -Graphics $full -Fade $fade

    # ---- 6. present --------------------------------------------------------
    Present-Surface -Surface $script:OverlaySurface -Hwnd $script:OverlayForm.Handle -X $script:VX -Y $script:VY
    $script:FrameCount++
}

# =============================================================================
#  Mode transitions
# =============================================================================
function Show-OverlayWindowNow {
    if (-not $script:OverlayVisible) {
        Show-WindowTopmost -Hwnd $script:OverlayForm.Handle -X $script:VX -Y $script:VY -W $script:VW -H $script:VH
        $script:OverlayVisible = $true
    } else {
        Assert-Topmost -Hwnd $script:OverlayForm.Handle
    }
}

function Enter-Active {
    if ($script:PausedVisible) { Hide-PausedBanner }
    $wasIdle = ($script:Mode -ne 'active')
    $script:Mode = 'active'
    $script:NeedFadeOut = $false
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        try { [MultiOverlayNative]::MultiOverlay_Show($script:MultiOverlay) } catch { }
        if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
        if ($wasIdle) { Write-Proto @{ type = 'state'; mode = 'active' } }
        return
    }
    # make sure the first painted frame exists before the window becomes visible
    if ($script:Fade -le 0.002) {
        try { Render-ActiveFrame } catch { Write-Diag ('initial frame render failed: ' + $_.Exception.Message) }
    }
    Show-OverlayWindowNow
    if ($wasIdle) { Write-Proto @{ type = 'state'; mode = 'active' } }
}

function Get-CursorMonitorRect {
    $mx = 0; $my = 0; $mw = $script:PrimaryW; $mh = $script:PrimaryH
    try {
        $ok = $false
        try {
            # three out params; PS 5.1 handles primitive out params through [ref]
            $ok = [WinOverlayNative]::GetMonitorRectAtCursor([ref]$mx, [ref]$my, [ref]$mw, [ref]$mh)
        } catch {
            $ok = $false
        }
        if (-not $ok) {
            $mx = 0; $my = 0; $mw = $script:PrimaryW; $mh = $script:PrimaryH
        }
    } catch { }
    if ($mw -le 0) { $mw = $script:PrimaryW }
    if ($mh -le 0) { $mh = $script:PrimaryH }
    return @{ X = [int]$mx; Y = [int]$my; W = [int]$mw; H = [int]$mh }
}

function Compute-PausedPlacement {
    $mon = Get-CursorMonitorRect
    $L = $script:PausedLayout
    $x = $mon.X + [int](($mon.W - $L.WinW) / 2)
    $y = $mon.Y + 10
    return @{ X = $x; Y = $y; Monitor = $mon }
}

function Set-PausedBannerBitmap {
    param([bool]$Hover)
    $bmp = Build-PausedBannerBitmap -Hover $Hover
    $old = $script:PausedSurface.BitmapObj
    $script:PausedSurface.BitmapObj = $bmp
    try { $old.Dispose() } catch { }
}

function Show-PausedBanner {
    $place = Compute-PausedPlacement
    $script:PausedX = $place.X
    $script:PausedY = $place.Y
    $script:PausedHover = $false
    Set-PausedBannerBitmap -Hover $false
    $L = $script:PausedLayout
    Show-WindowTopmost -Hwnd $script:BannerForm.Handle -X $script:PausedX -Y $script:PausedY -W $L.WinW -H $L.WinH
    Present-Surface -Surface $script:PausedSurface -Hwnd $script:BannerForm.Handle -X $script:PausedX -Y $script:PausedY
    $script:PausedVisible = $true
    $rr = $L.ResumeRectRel
    $mon = $place.Monitor
    Write-Proto @{
        type = 'layout'
        mode = 'paused'
        resumeRect = @{ x = ($script:PausedX + $rr.X); y = ($script:PausedY + $rr.Y); w = $rr.Width; h = $rr.Height }
        hitRect = @{ x = ($script:PausedX + $rr.X - 14); y = ($script:PausedY + $rr.Y - 9); w = ($rr.Width + 28); h = ($rr.Height + 20) }
        bannerRect = @{ x = $script:PausedX; y = $script:PausedY; w = $L.WinW; h = $L.WinH }
        bannerHwnd = [long]$script:BannerForm.Handle
        monitor = @{ x = $mon.X; y = $mon.Y; w = $mon.W; h = $mon.H }
    }
}

function Hide-PausedBanner {
    if ($script:PausedVisible) {
        Hide-Window -Hwnd $script:BannerForm.Handle
        $script:PausedVisible = $false
        $script:PausedHover = $false
        try { $script:BannerForm.Cursor = [System.Windows.Forms.Cursors]::Default } catch { }
    }
}

function Enter-Paused {
    Hide-PausedBanner
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        try { [MultiOverlayNative]::MultiOverlay_Hide($script:MultiOverlay) } catch { }
        if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
    }
    $wasPaused = ($script:Mode -eq 'paused')
    $script:Mode = 'paused'
    $script:CaptionText = ''
    $script:Ripples.Clear()
    $script:NeedFadeOut = $true
    try {
        Show-PausedBanner
        Assert-Topmost -Hwnd $script:BannerForm.Handle
    } catch { Write-Diag ('show paused banner failed: ' + $_.Exception.Message) }
    if (-not $wasPaused) { Write-Proto @{ type = 'state'; mode = 'paused' } }
}

function Enter-Idle {
    $script:Mode = 'idle'
    $script:CaptionText = ''
    $script:Ripples.Clear()
    $script:NeedFadeOut = $false
    $script:Fade = 0.0
    Hide-PausedBanner
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        try { [MultiOverlayNative]::MultiOverlay_Hide($script:MultiOverlay) } catch { }
    }
    if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
    Write-Proto @{ type = 'state'; mode = 'idle' }
}

function Invoke-ResumeClick {
    if ($script:Mode -ne 'paused') { return }
    Write-Diag 'resume link clicked'
    Write-Proto @{ type = 'resume' }
    # hand control straight back: hide the banner and wait for the host to
    # re-enter active mode on its own (it normally sends show/active next).
    Hide-PausedBanner
    if ($script:MultiOverlay -ne [IntPtr]::Zero) {
        try { [MultiOverlayNative]::MultiOverlay_Hide($script:MultiOverlay) } catch { }
    }
    $script:Mode = 'idle'
    $script:NeedFadeOut = $false
    $script:Fade = 0.0
    if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
    Write-Proto @{ type = 'state'; mode = 'idle' }
}

function Test-PointInResumeLink {
    param([int]$X, [int]$Y)
    $L = $script:PausedLayout
    $r = $L.ResumeRectRel
    return ($X -ge ($r.X - 14) -and $X -lt ($r.X + $r.Width + 14) -and
            $Y -ge ($r.Y - 9) -and $Y -lt ($r.Y + $r.Height + 9))
}

function Test-PointInBannerPill {
    param([int]$X, [int]$Y)
    $L = $script:PausedLayout
    return ($X -ge $L.G -and $X -lt ($L.G + $L.PillW) -and $Y -ge $L.G -and $Y -lt ($L.G + $L.PillH))
}

# =============================================================================
#  Command handling
# =============================================================================
function Handle-CommandLine {
    param([string]$Line)
    if ([string]::IsNullOrWhiteSpace($Line)) { return }
    $cmd = $null
    try { $cmd = $Line | ConvertFrom-Json } catch {
        Write-Diag ('bad json command: ' + $Line)
        return
    }
    if ($null -eq $cmd -or $null -eq $cmd.cmd) { Write-Diag ('command without cmd: ' + $Line); return }
    switch ([string]$cmd.cmd) {
        'show' {
            $mode = 'active'
            if ($null -ne $cmd.mode) { $mode = [string]$cmd.mode }
            switch ($mode) {
                'active' { Enter-Active }
                'paused' { Enter-Paused }
                'idle'   { Enter-Idle }
                default  { Write-Diag ('unknown show mode: ' + $mode) }
            }
        }
        'hide'  { Enter-Idle }
        'caption' {
            Set-Caption -Text ([string]$cmd.text) -TtlMs ([int]($(if ($null -ne $cmd.ttlMs) { $cmd.ttlMs } else { 1800 })))
        }
        'ripple' {
            Add-Ripple -X ([double]$cmd.x) -Y ([double]$cmd.y)
        }
        'quit'  { Write-Diag 'quit command received'; Request-Shutdown 0 }
        default { Write-Diag ('unknown command: ' + [string]$cmd.cmd) }
    }
}

function Request-Shutdown {
    param([int]$Code)
    if ($script:ShutdownDone) { return }
    $script:ShutdownDone = $true
    $script:ExitRequested = $true
    $forceExit = ($script:MultiOverlay -ne [IntPtr]::Zero)
    Write-Diag 'shutdown begin'
    try { Hide-PausedBanner } catch { }
    try { if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false } } catch { }
    try { Cleanup-Overlay } catch { Write-Diag ('cleanup failed: ' + $_.Exception.Message) }
    Write-Diag 'shutdown cleanup done'
    try { [Console]::Out.Flush() } catch { }
    if ($forceExit) {
        Write-Diag 'shutdown terminate native threads'
        [ExitNative]::TerminateProcess([ExitNative]::GetCurrentProcess(), 0)
        return
    }
    Write-Diag 'shutdown env exit'
    [Environment]::Exit($Code)
}

# =============================================================================
#  Timer tick
# =============================================================================
function Update-PerfTitle {

    $now = $script:Clock.Elapsed.TotalSeconds
    if (($now - $script:LastFpsSeconds) -ge 1.0) {
        $dFrames = $script:FrameCount - $script:LastFpsFrames
        $dTime = $now - $script:LastFpsSeconds
        if ($dTime -gt 0.1) { $script:MeasuredFps = $dFrames / $dTime }
        $script:LastFpsFrames = $script:FrameCount
        $script:LastFpsSeconds = $now
    }
    if (($now - $script:LastTitleSeconds) -ge 1.0) {
        $script:LastTitleSeconds = $now
        try {
            $script:OverlayForm.Text = ('win-overlay fps={0:0.0} frames={1} mode={2}' -f $script:MeasuredFps, $script:FrameCount, $script:Mode)
        } catch { Write-Diag ('title update failed: ' + $_.Exception.Message) }
    }
}

function Invoke-Tick {
    # drain stdin (up to 8 lines per tick for responsiveness)
    $eof = $false
    for ($k = 0; $k -lt 8; $k++) {
        $poll = Poll-Stdin
        if ($poll -eq 'eof') { $eof = $true; break }
        if ($poll -ne 'line') { break }
    }
    if ($eof) { Write-Diag 'stdin closed, exiting'; Request-Shutdown 0; return }

    $needRender = ($script:Mode -eq 'active') -or ($script:Fade -gt 0.002)
    if ($script:MultiOverlay -ne [IntPtr]::Zero) { $needRender = $false }
    if ($needRender) {
        Render-ActiveFrame
    }

    $now = $script:Clock.Elapsed.TotalSeconds
    if ($script:PausedVisible) { Assert-Topmost -Hwnd $script:BannerForm.Handle }
    if (($now - $script:LastTopmostSeconds) -ge 1.0) {
        $script:LastTopmostSeconds = $now
        if ($script:OverlayVisible -and $script:Mode -eq 'active' -and $script:MultiOverlay -eq [IntPtr]::Zero) { Assert-Topmost -Hwnd $script:OverlayForm.Handle }
    }
    Update-PerfTitle
}

# =============================================================================
#  Startup
# =============================================================================
$script:ResourcesReady = $false
function Initialize-Overlay {
    Build-FogLayers
    $script:FogComposite = New-Object System.Drawing.Bitmap -ArgumentList $script:LowW, $script:LowH, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $script:FogG = New-QualityGraphics -Bitmap $script:FogComposite -ForFog $true
    $script:FullBmp = New-Object System.Drawing.Bitmap -ArgumentList $script:VW, $script:VH, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $script:FullG = New-QualityGraphics -Bitmap $script:FullBmp -ForFog $false
    $script:FullRect = New-Object System.Drawing.Rectangle 0, 0, $script:VW, $script:VH
    $script:OverlaySurface = New-UlwSurface -Name 'overlay' -Bitmap $script:FullBmp -W $script:VW -H $script:VH
    $script:ActiveChrome = Build-ActiveChrome
    Build-BorderSprites
    $script:CaptionFont = New-Object System.Drawing.Font -ArgumentList 'Microsoft YaHei UI', ([single]10.5), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Point)
    $script:DotSprite = Build-DotSprite
    $script:ChromeAttrs = New-AlphaAttributes
    $script:DotAttrs = New-AlphaAttributes
    $script:PausedLayout = Build-PausedLayout

    # overlay window (click-through, full virtual screen)
    $script:OverlayForm = New-OverlayWindow -Title 'win-overlay' -X $script:VX -Y $script:VY -W $script:VW -H $script:VH -ClickThrough $true -Dx:($script:DxAvailable -and $script:UseDx)

    # 尝试 DirectComposition：移除 layered，改用 NOREDIRECTIONBITMAP + DComp swapchain。
    if ($script:DxAvailable -and $script:UseDx) {
        try {
            Set-DxWindowStyle -Hwnd $script:OverlayForm.Handle -Enable $true
            $dx = [DxOverlayNative]::DxOverlay_Create($script:OverlayForm.Handle, $script:VW, $script:VH)
            if ($dx -ne [IntPtr]::Zero) {
                $script:DxOverlay = $dx
                Write-Diag ('DirectComposition overlay active {0}x{1}' -f $script:VW, $script:VH)
            } else {
                Set-DxWindowStyle -Hwnd $script:OverlayForm.Handle -Enable $false
                $dxHr = [DxOverlayNative]::DxOverlay_GetLastError()
                $dxStage = [DxOverlayNative]::DxOverlay_GetLastStage()
                Write-Diag ('DirectComposition create returned null hr=0x{0:X8} stage={1}; using GDI fallback' -f $dxHr, $dxStage)
            }
        } catch {
            $script:DxOverlay = [IntPtr]::Zero
            Set-DxWindowStyle -Hwnd $script:OverlayForm.Handle -Enable $false
            Write-Diag ('DirectComposition init failed: ' + $_.Exception.Message)
        }
    }
    # optional multi-window overlay (4 border strips + banner + caption + ripple)
    if ($script:UseMulti -and $script:MultiAvailable) {
        try {
            $multiHandle = [MultiOverlayNative]::MultiOverlay_Create()
            if ($multiHandle -ne [IntPtr]::Zero) {
                $script:MultiOverlay = $multiHandle
                if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false }
                Write-Diag 'multi-window overlay active (4 strips + banner)'
            } else {
                Write-Diag 'multi-window overlay create returned null; using GDI fallback'
            }
        } catch {
            Write-Diag ('multi-window overlay init failed: ' + $_.Exception.Message)
        }
    }
    # paused banner window (small, layered, no activate, NOT click-through)
    $script:BannerForm = New-OverlayWindow -Title 'win-overlay-banner' -X 0 -Y 0 -W $script:PausedLayout.WinW -H $script:PausedLayout.WinH -ClickThrough $false
    $script:PausedSurface = New-UlwSurface -Name 'banner' -Bitmap (Build-PausedBannerBitmap -Hover $false) -W $script:PausedLayout.WinW -H $script:PausedLayout.WinH

    # banner mouse interaction (hover + click on "点击继续")
    $script:BannerForm.Add_MouseMove({
        param($sender, $e)
        try {
            $hover = (Test-PointInResumeLink -X $e.X -Y $e.Y) -or (Test-PointInBannerPill -X $e.X -Y $e.Y)
            if ($hover -ne $script:PausedHover) {
                $script:PausedHover = $hover
                Set-PausedBannerBitmap -Hover $hover
                if ($script:PausedVisible) {
                    Present-Surface -Surface $script:PausedSurface -Hwnd $script:BannerForm.Handle -X $script:PausedX -Y $script:PausedY
                }
                if ($hover) {
                    $script:BannerForm.Cursor = [System.Windows.Forms.Cursors]::Hand
                } else {
                    $script:BannerForm.Cursor = [System.Windows.Forms.Cursors]::Default
                }
            }
        } catch { Write-Diag ('banner mousemove failed: ' + $_.Exception.Message) }
    })
    $script:BannerForm.Add_MouseLeave({
        try {
            if ($script:PausedHover) {
                $script:PausedHover = $false
                Set-PausedBannerBitmap -Hover $false
                if ($script:PausedVisible) {
                    Present-Surface -Surface $script:PausedSurface -Hwnd $script:BannerForm.Handle -X $script:PausedX -Y $script:PausedY
                }
                $script:BannerForm.Cursor = [System.Windows.Forms.Cursors]::Default
            }
        } catch { Write-Diag ('banner mouseleave failed: ' + $_.Exception.Message) }
    })
    $script:BannerForm.Add_MouseUp({
        param($sender, $e)
        try {
            if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            if ((Test-PointInResumeLink -X $e.X -Y $e.Y) -or (Test-PointInBannerPill -X $e.X -Y $e.Y)) { Invoke-ResumeClick }
        } catch { Write-Diag ('banner mouseup failed: ' + $_.Exception.Message) }
    })

    $script:ResourcesReady = $true
}

function Cleanup-Overlay {
    try { if ($script:Timer) { $script:Timer.Stop(); $script:Timer.Dispose() } } catch { }
    try {
        if ($script:MultiOverlay -ne [IntPtr]::Zero) {
            # Detached native worker threads are reclaimed by process exit;
            # joining/destroying here can stall on a layered-window present.
            [MultiOverlayNative]::MultiOverlay_Hide($script:MultiOverlay)
            $script:MultiOverlay = [IntPtr]::Zero
        }
    } catch { }
    try {
        if ($script:DxOverlay -ne [IntPtr]::Zero) {
            [DxOverlayNative]::DxOverlay_Destroy($script:DxOverlay)
            $script:DxOverlay = [IntPtr]::Zero
        }
    } catch { }
    try { if ($script:OverlayForm) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayForm.Dispose() } } catch { }
    try { if ($script:BannerForm) { Hide-Window -Hwnd $script:BannerForm.Handle; $script:BannerForm.Dispose() } } catch { }
    try { if ($script:OverlaySurface) { Dispose-UlwSurface -Surface $script:OverlaySurface } } catch { }
    try { if ($script:PausedSurface) { Dispose-UlwSurface -Surface $script:PausedSurface } } catch { }
    try { if ($script:FullG) { $script:FullG.Dispose() } } catch { }
    try { if ($script:FogG) { $script:FogG.Dispose() } } catch { }
    try { if ($script:ActiveChrome) { $script:ActiveChrome.Bmp.Dispose(); $script:ActiveChrome.Font.Dispose() } } catch { }
    try { if ($script:DotSprite) { $script:DotSprite.Bmp.Dispose() } } catch { }
    try { if ($script:PausedLayout) { $script:PausedLayout.PrefixFont.Dispose(); $script:PausedLayout.LinkFont.Dispose() } } catch { }
    try { if ($script:FogLayers) { foreach ($L in $script:FogLayers) { $L.Bmp.Dispose(); $L.IA.Dispose() } } } catch { }
    try { if ($script:DotAttrs) { $script:DotAttrs.IA.Dispose() } } catch { }
    try { if ($script:ChromeAttrs) { $script:ChromeAttrs.IA.Dispose() } } catch { }
}

# ---- unhandled exception safety nets ---------------------------------------
try {
    [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
    [System.Windows.Forms.Application]::add_ThreadException({
        param($sender, $e)
        Write-Diag ('UI thread exception: ' + $e.Exception.Message)
    })
} catch { }

# ---- stdin reader (async ReadLineAsync, polled from the UI timer) ----------
$script:StdinTask = $null
$script:StdinEof = $false
try {
    $script:StdinReader = New-Object System.IO.StreamReader -ArgumentList `
        ([Console]::OpenStandardInput()), ([System.Text.Encoding]::UTF8), $false, 4096, $false
} catch {
    $script:StdinReader = [Console]::In
}
function Poll-Stdin {
    # returns 'line' (one command handled), 'none' (nothing ready), 'eof'
    if ($script:StdinEof) { return 'eof' }
    try {
        if ($null -eq $script:StdinTask) {
            $script:StdinTask = $script:StdinReader.ReadLineAsync()
            if ($null -eq $script:StdinTask) { $script:StdinEof = $true; return 'eof' }
        }
        if (-not $script:StdinTask.IsCompleted) { return 'none' }
        $line = $null
        try { $line = $script:StdinTask.Result } catch { $script:StdinEof = $true; return 'eof' }
        $script:StdinTask = $null
        if ($null -eq $line) { $script:StdinEof = $true; return 'eof' }
        Handle-CommandLine -Line $line
        return 'line'
    } catch {
        Write-Diag ('stdin read failed: ' + $_.Exception.Message)
        $script:StdinEof = $true
        return 'eof'
    }
}
# ---- main -------------------------------------------------------------------
$exitCode = 0
try {
    Initialize-Overlay

    $script:Timer = New-Object System.Windows.Forms.Timer
    $script:Timer.Interval = $script:FrameIntervalMs
    $null = [WinOverlayNative]::BeginHighResolutionTimer()
    $script:Timer.Add_Tick({
        try { Invoke-Tick } catch {
            Write-Diag ('tick error: ' + $_.Exception.Message + ' @line ' + $_.InvocationInfo.ScriptLineNumber)
            try { if ($script:OverlayVisible) { Hide-Window -Hwnd $script:OverlayForm.Handle; $script:OverlayVisible = $false } } catch { }
        }
    })
    $script:Timer.Start()

    Write-Proto @{
        type = 'ready'
        pid = $PID
        hwnd = [long]$script:OverlayForm.Handle
        virtualScreen = @{ x = $script:VX; y = $script:VY; width = $script:VW; height = $script:VH }
        bannerHwnd = [long]$script:BannerForm.Handle
        fps = $script:TargetFps
        refreshHz = $script:RefreshHz
        maxFps = $script:MaxFps
    }
    Write-Diag ('ready: screen {0}x{1}@{2},{3} lowres {4}x{5} font={6} dpi={7} refreshHz={8} targetFps={9}' -f $script:VW, $script:VH, $script:VX, $script:VY, $script:LowW, $script:LowH, $script:FontFamily, $script:DpiAware, $script:RefreshHz, $script:TargetFps)

    [System.Windows.Forms.Application]::Run()
} catch {
    Write-Diag ('fatal: ' + $_.Exception.Message)
    Write-Diag ($_.ScriptStackTrace)
    try { Cleanup-Overlay } catch { }
    $exitCode = 1
}
try { $null = [WinOverlayNative]::EndHighResolutionTimer() } catch { }
try { Cleanup-Overlay } catch { }
[Environment]::Exit($exitCode)