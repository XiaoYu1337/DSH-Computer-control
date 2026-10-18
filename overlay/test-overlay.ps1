# =============================================================================
#  test-overlay.ps1 -- automated visual + behavioural test for win-overlay.ps1
#  Run with Windows PowerShell 5.1:
#    powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#      -File C:\...\overlay\test-overlay.ps1
#  Produces overlay/shots/{baseline,active,paused,idle}.png and PASS/FAIL lines.
# =============================================================================
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$shots = Join-Path $here 'shots'
if (-not (Test-Path $shots)) { New-Item -ItemType Directory -Force -Path $shots | Out-Null }
$overlayScript = Join-Path $here 'win-overlay.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $psExe)) { $psExe = 'powershell.exe' }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class T {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
$dpi = $false
try { $dpi = [T]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }
if (-not $dpi) { try { [void][T]::SetProcessDPIAware() } catch { } }
$VW = [T]::GetSystemMetrics(78); $VH = [T]::GetSystemMetrics(79)
if ($VW -le 0) { $VW = 1920 }; if ($VH -le 0) { $VH = 1080 }

# ------------------------------------------------------------------ helpers --
$script:Failures = 0
$script:Checks = 0
$script:Results = New-Object System.Collections.ArrayList
function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $script:Checks++
    if (-not $Ok) { $script:Failures++ }
    $tag = if ($Ok) { 'PASS' } else { 'FAIL' }
    $msg = ('[{0}] {1}{2}' -f $tag, $Name, $(if ($Detail) { ' -- ' + $Detail } else { '' }))
    [void]$script:Results.Add($msg)
    Write-Host $msg
}

# --- async line reader -------------------------------------------------------
function New-LineReader {
    param($Reader)
    return @{ Reader = $Reader; Task = $null }
}
function Read-Line {
    param($LR, [int]$TimeoutMs)
    if ($null -eq $LR.Task) { $LR.Task = $LR.Reader.ReadLineAsync() }
    if ($LR.Task.Wait($TimeoutMs)) {
        $line = $LR.Task.Result
        $LR.Task = $null
        if ($null -eq $line) { return @{ status = 'eof'; line = $null } }
        return @{ status = 'line'; line = $line }
    }
    return @{ status = 'timeout'; line = $null }
}
function Wait-ForLine {
    param($LR, [int]$TimeoutMs, [scriptblock]$Predicate, [string[]]$Ignored)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $collected = New-Object System.Collections.ArrayList
    while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
        $r = Read-Line -LR $LR -TimeoutMs ([int][Math]::Max(1, $TimeoutMs - $sw.ElapsedMilliseconds))
        if ($r.status -eq 'eof') { return @{ status = 'eof'; line = $null; collected = $collected } }
        if ($r.status -eq 'timeout') { break }
        [void]$collected.Add($r.line)
        if ($null -eq $Predicate) { return @{ status = 'line'; line = $r.line; collected = $collected } }
        try { $obj = $r.line | ConvertFrom-Json } catch { $obj = $null }
        if ($obj -ne $null -and (& $Predicate $obj)) {
            return @{ status = 'line'; line = $r.line; collected = $collected; obj = $obj }
        }
    }
    return @{ status = 'timeout'; line = $null; collected = $collected }
}

# --- screenshots + colour analysis ------------------------------------------
function Save-Screenshot {
    param([string]$Path)
    $bmp = New-Object System.Drawing.Bitmap $VW, $VH
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size $VW, $VH))
    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return (Get-Item $Path).Length
}

# returns hashtable of colour statistics sampled from the PNG
function Get-ShotStats {
    param([string]$Path)
    $bmp = [System.Drawing.Bitmap]::FromFile($Path)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $bmp.Width, $bmp.Height
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $bmp.Height)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    $bmp.UnlockBits($data)
    $W = $bmp.Width; $H = $bmp.Height
    $bmp.Dispose()

    $step = 6
    $edgeX = [int]($W * 0.10); $edgeY = [int]($H * 0.10)
    $cx0 = [int]($W * 0.35); $cx1 = [int]($W * 0.65); $cy0 = [int]($H * 0.35); $cy1 = [int]($H * 0.65)
    $edgeN = 0; $edgeGreen = 0; $edgeGsum = 0
    $cN = 0; $cGreen = 0; $cGsum = 0
    $bannerLight = 0; $bannerBlue = 0; $bannerDark = 0
    $bannerX0 = [int]($W / 2 - 260); $bannerX1 = [int]($W / 2 + 260)
    for ($y = 0; $y -lt $H; $y += $step) {
        $inEdgeY = ($y -lt $edgeY) -or ($y -ge ($H - $edgeY))
        $inCenterY = ($y -ge $cy0) -and ($y -lt $cy1)
        $row = $y * $stride
        for ($x = 0; $x -lt $W; $x += $step) {
            $i = $row + $x * 4
            $B = [int]$bytes[$i]; $G = [int]$bytes[$i + 1]; $R = [int]$bytes[$i + 2]
            $inEdge = $inEdgeY -or ($x -lt $edgeX) -or ($x -ge ($W - $edgeX))
            if ($inEdge) {
                $edgeN++
                if (($G -gt ($R + 18)) -and ($G -gt ($B + 8)) -and ($G -gt 40)) { $edgeGreen++ }
                $edgeGsum += ($G - $R)
            } elseif ($inCenterY -and ($x -ge $cx0) -and ($x -lt $cx1)) {
                $cN++
                if (($G -gt ($R + 18)) -and ($G -gt ($B + 8)) -and ($G -gt 40)) { $cGreen++ }
                $cGsum += ($G - $R)
            }
            if ($y -lt 96 -and $x -ge $bannerX0 -and $x -lt $bannerX1) {
                if (($R -gt 190) -and ($G -gt 210) -and ($B -gt 180)) { $bannerLight++ }
                if (($B -gt 160) -and (($B - $R) -gt 55) -and (($B - $G) -gt 18)) { $bannerBlue++ }
                if (($R -lt 60) -and ($G -lt 85) -and ($B -lt 75)) { $bannerDark++ }
            }
        }
    }
    return @{
        W = $W; H = $H
        EdgeN = $edgeN; EdgeGreenFrac = $(if ($edgeN -gt 0) { $edgeGreen / [double]$edgeN } else { 0 })
        EdgeGExcess = $(if ($edgeN -gt 0) { $edgeGsum / [double]$edgeN } else { 0 })
        CenterN = $cN; CenterGreenFrac = $(if ($cN -gt 0) { $cGreen / [double]$cN } else { 0 })
        CenterGExcess = $(if ($cN -gt 0) { $cGsum / [double]$cN } else { 0 })
        BannerLight = $bannerLight; BannerBlue = $bannerBlue; BannerDark = $bannerDark
    }
}

function Get-RingDelta {
    param([string]$PathA, [string]$PathB)
    # 对比两张截图：外圈（约 27px）应出现绿色边框染色，中央区域应几乎无变化。
    if (-not (Test-Path -LiteralPath $PathA)) { throw ("ring-delta: PathA not found: " + $PathA) }
    if (-not (Test-Path -LiteralPath $PathB)) { throw ("ring-delta: PathB not found: " + $PathB) }
    $a = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $PathA).Path)
    $b = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $PathB).Path)
    $W = $a.Width; $H = $a.Height
    $rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
    $fmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    $mode = [System.Drawing.Imaging.ImageLockMode]::ReadOnly
    $da = $a.LockBits($rect, $mode, $fmt); $db = $b.LockBits($rect, $mode, $fmt)
    $stride = $da.Stride
    $bytesA = New-Object byte[] ($stride * $H); $bytesB = New-Object byte[] ($stride * $H)
    [System.Runtime.InteropServices.Marshal]::Copy($da.Scan0, $bytesA, 0, $bytesA.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($db.Scan0, $bytesB, 0, $bytesB.Length)
    $a.UnlockBits($da); $b.UnlockBits($db); $a.Dispose(); $b.Dispose()
    $ring = [Math]::Max(10, [int]($W * 0.014))
    $cx0 = [int]($W * 0.30); $cx1 = [int]($W * 0.70)
    $cy0 = [int]($H * 0.30); $cy1 = [int]($H * 0.70)
    $ringTint = 0; $ringN = 0; $centerTint = 0; $centerN = 0
    for ($y = 0; $y -lt $H; $y += 3) {
        $inRingY = ($y -lt $ring) -or ($y -ge ($H - $ring))
        $inCenterY = ($y -ge $cy0) -and ($y -lt $cy1)
        $row = $y * $stride
        for ($x = 0; $x -lt $W; $x += 3) {
            $i = $row + $x * 4
            $dG = [int]$bytesA[$i + 1] - [int]$bytesB[$i + 1]
            $dR = [int]$bytesA[$i + 2] - [int]$bytesB[$i + 2]
            $tint = $dG - $dR
            $inRing = $inRingY -or ($x -lt $ring) -or ($x -ge ($W - $ring))
            if ($inRing) {
                $ringN++
                if ($tint -ge 8) { $ringTint++ }
            } elseif ($inCenterY -and ($x -ge $cx0) -and ($x -lt $cx1)) {
                $centerN++
                if (($tint -ge 8) -and ($dG -ge 5)) { $centerTint++ }
            }
        }
    }
    return @{ RingTint = $ringTint; RingN = $ringN; CenterTint = $centerTint; CenterN = $centerN; Ring = $ring }
}

function Send-Cmd {
    param($Proc, [string]$Json)
    $Proc.StandardInput.WriteLine($Json)
    $Proc.StandardInput.Flush()
}
function Get-WindowTitle {
    param([IntPtr]$Hwnd)
    $sb = New-Object System.Text.StringBuilder 256
    [void][T]::GetWindowText($Hwnd, $sb, 256)
    return $sb.ToString()
}
function Test-ResumeLinkHit {
    param([int]$X, [int]$Y, [IntPtr]$Expect)
    $pt = New-Object T+POINT
    $pt.X = $X; $pt.Y = $Y
    $hit = [T]::WindowFromPoint($pt)
    return ($hit -eq $Expect)
}

function Show-Stderr {
    param($LR, [int]$MaxLines)
    if ($null -eq $LR) { return }
    $n = 0
    while ($n -lt $MaxLines) {
        $r = Read-Line -LR $LR -TimeoutMs 30
        if ($r.status -ne 'line') { break }
        Write-Host ('  helper-stderr: ' + $r.line)
        $n++
    }
}

# =============================================================================
#  Test body
# =============================================================================
$proc = $null
$outLR = $null
$errLR = $null
$oldCursor = New-Object T+POINT
[void][T]::GetCursorPos([ref]$oldCursor)
$startAll = [System.Diagnostics.Stopwatch]::StartNew()

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $psExe
    $psi.Arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $overlayScript)
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.WorkingDirectory = $here
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $outLR = New-LineReader $proc.StandardOutput
    $errLR = New-LineReader $proc.StandardError

    # ---- 1. ready ----------------------------------------------------------
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ready = $null
    while ($sw.ElapsedMilliseconds -lt 10000) {
        $r = Read-Line -LR $outLR -TimeoutMs 500
        if ($r.status -eq 'eof') { break }
        if ($r.status -eq 'line') {
            try { $obj = $r.line | ConvertFrom-Json } catch { $obj = $null }
            if ($obj -and $obj.type -eq 'ready') { $ready = $obj; break }
        }
    }
    Check 'ready line within 10s' ($ready -ne $null) $(if ($ready) { 'pid=' + $ready.pid + ' hwnd=' + $ready.hwnd } else { 'no ready line' })
    if ($null -eq $ready) { throw 'helper did not become ready' }
    $hwnd = [IntPtr][long]$ready.hwnd
    Check 'ready pid matches spawned process' ($ready.pid -eq $proc.Id) ('ready pid=' + $ready.pid + ' spawned=' + $proc.Id)
    $vs = $ready.virtualScreen
    Check 'virtualScreen reported' (($vs.width -ge $VW) -and ($vs.height -ge $VH)) ('reported ' + $vs.width + 'x' + $vs.height)

    # ---- 2. ex styles ------------------------------------------------------
    $ex = [T]::GetWindowLong($hwnd, -20)
    Check 'layered or NOREDIRECTIONBITMAP style' ((($ex -band 0x00080000) -ne 0) -or (($ex -band 0x00200000) -ne 0)) ('ex=0x{0:X8}' -f $ex)
    Check 'WS_EX_TRANSPARENT click-through (0x20)' (($ex -band 0x00000020) -ne 0) ('ex=0x{0:X8}' -f $ex)
    Check 'WS_EX_TOOLWINDOW no taskbar/alt-tab (0x80)' (($ex -band 0x00000080) -ne 0) ('ex=0x{0:X8}' -f $ex)
    Check 'WS_EX_NOACTIVATE (0x08000000)' (($ex -band 0x08000000) -ne 0) ('ex=0x{0:X8}' -f $ex)
    Check 'WS_EX_APPWINDOW not set' (($ex -band 0x00040000) -eq 0) ('ex=0x{0:X8}' -f $ex)

    # ---- 3. baseline (idle) -------------------------------------------------
    Start-Sleep -Milliseconds 250
    $basePath = Join-Path $shots 'baseline.png'
    $baseSize = Save-Screenshot $basePath
    $baseStats = Get-ShotStats $basePath
    Check 'baseline.png saved (>20KB)' ($baseSize -gt 20480) ('bytes=' + $baseSize)

    # ---- 4. active state ---------------------------------------------------
    Send-Cmd $proc '{"cmd":"show","mode":"active"}'
    Start-Sleep -Milliseconds 1300
    $activePath = Join-Path $shots 'active.png'
    $activeSize = Save-Screenshot $activePath
    $activeStats = Get-ShotStats $activePath
    Check 'active.png saved (>20KB)' ($activeSize -gt 20480) ('bytes=' + $activeSize)
    $activeDelta = Get-RingDelta $activePath $basePath
    Check 'active: thin green border tint in outer ring' ($activeDelta.RingTint -ge 300) ('ringTint=' + $activeDelta.RingTint + '/' + $activeDelta.RingN + ' ring=' + $activeDelta.Ring + 'px')
    Check 'active: centre remains untouched by overlay' ($activeDelta.CenterTint -le 120) ('centerTint=' + $activeDelta.CenterTint + '/' + $activeDelta.CenterN)
    Check 'active: banner present (light green/white text + dark pill)' (($activeStats.BannerLight -ge 100) -and ($activeStats.BannerDark -ge 30)) ('light=' + $activeStats.BannerLight + ' dark=' + $activeStats.BannerDark)
    $title1 = Get-WindowTitle $hwnd
    Check 'overlay window title reports render fps' ($title1 -match 'fps=') ('title="' + $title1 + '"')

    # ---- 5. paused state ---------------------------------------------------
    $pt = New-Object T+POINT
    $pt.X = [int]($VW / 2); $pt.Y = [int]($VH / 2)
    [void][T]::SetCursorPos($pt.X, $pt.Y)     # paused banner follows the cursor monitor
    Start-Sleep -Milliseconds 150
    Send-Cmd $proc '{"cmd":"show","mode":"paused"}'
    $layout = $null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 2500 -and $null -eq $layout) {
        $r = Wait-ForLine -LR $outLR -TimeoutMs 400 -Predicate { param($o) $o.type -eq 'layout' }
        foreach ($c in $r.collected) { try { $o = $c | ConvertFrom-Json; if ($o.type -eq 'layout') { $layout = $o } } catch { } }
    }
    Check 'paused: layout line with resumeRect' ($layout -ne $null) $(if ($layout) { 'resumeRect=' + $layout.resumeRect.x + ',' + $layout.resumeRect.y + ' ' + $layout.resumeRect.w + 'x' + $layout.resumeRect.h } else { 'missing' })
    Start-Sleep -Milliseconds 900
    $pausedPath = Join-Path $shots 'paused.png'
    $pausedSize = Save-Screenshot $pausedPath
    $pausedStats = Get-ShotStats $pausedPath
    Check 'paused.png saved (>20KB)' ($pausedSize -gt 20480) ('bytes=' + $pausedSize)
    $pausedDelta = Get-RingDelta $pausedPath $basePath
    Check 'paused: border glow faded out' ($pausedDelta.RingTint -le ([Math]::Max(80, [int]($activeDelta.RingTint * 0.25)))) ('activeRingTint=' + $activeDelta.RingTint + ' pausedRingTint=' + $pausedDelta.RingTint)
    Check 'paused: blue "点击继续" link visible in banner area' ($pausedStats.BannerBlue -ge 15) ('bluePixels=' + $pausedStats.BannerBlue)
    Check 'paused: banner backdrop present' ($pausedStats.BannerDark -ge 30) ('darkPixels=' + $pausedStats.BannerDark)

    # ---- 6. click "点击继续" ------------------------------------------------
if ($layout) {
        $script:TestBannerHwnd = [IntPtr][long]$layout.bannerHwnd
        $rr = $layout.resumeRect
        $bx = [int]$layout.bannerHwnd
        $bannerHwnd = [IntPtr][long]$layout.bannerHwnd
        $clickX = [int]($rr.x + $rr.w / 2)
        $clickY = [int]($rr.y + $rr.h / 2)
        # make sure our banner is the topmost window at the click point
        $hitOk = $false
        for ($a = 0; $a -lt 8; $a++) {
            [void][T]::SetWindowPos($bannerHwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0002 -bor 0x0001 -bor 0x0010)
            Start-Sleep -Milliseconds 60
            if (Test-ResumeLinkHit -X $clickX -Y $clickY -Expect $bannerHwnd) { $hitOk = $true; break }
        }
        Check 'paused banner is hit-test visible at resumeRect' $hitOk ('click=' + $clickX + ',' + $clickY)
        [void][T]::SetCursorPos($clickX, $clickY)
        Start-Sleep -Milliseconds 120
        [T]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
        [T]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
        $resumeSeen = $false
        $r = Wait-ForLine -LR $outLR -TimeoutMs 1500 -Predicate { param($o) $o.type -eq 'resume' }
        foreach ($c in $r.collected) { try { $o = $c | ConvertFrom-Json; if ($o.type -eq 'resume') { $resumeSeen = $true } } catch { } }
        if ($r.status -eq 'line' -and $r.obj -and $r.obj.type -eq 'resume') { $resumeSeen = $true }
        Check 'clicking 点击继续 emits {"type":"resume"}' $resumeSeen
        [void][T]::SetCursorPos($oldCursor.X, $oldCursor.Y)
    }

    # ---- 7. hide returns to baseline --------------------------------------
    Send-Cmd $proc '{"cmd":"show","mode":"active"}'
    Start-Sleep -Milliseconds 600
    Send-Cmd $proc '{"cmd":"hide"}'
    Start-Sleep -Milliseconds 700
    $idlePath = Join-Path $shots 'idle.png'
    $idleSize = Save-Screenshot $idlePath
    $idleStats = Get-ShotStats $idlePath
    Check 'idle.png saved (>20KB)' ($idleSize -gt 20480) ('bytes=' + $idleSize)
    $idleDelta = Get-RingDelta $idlePath $basePath
    Check 'idle: border glow gone (ring back to background)' ($idleDelta.RingTint -le ([Math]::Max(80, [int]($activeDelta.RingTint * 0.2)))) ('idleRingTint=' + $idleDelta.RingTint + ' activeRingTint=' + $activeDelta.RingTint)
    Check 'idle: paused banner window hidden' (-not [T]::IsWindowVisible($script:TestBannerHwnd)) ('bannerHwndVisible=' + [T]::IsWindowVisible($script:TestBannerHwnd))
    Check 'overlay window hidden after hide' (-not [T]::IsWindowVisible($hwnd))

    # ---- 8. performance: 10 s active -------------------------------------
    Send-Cmd $proc '{"cmd":"show","mode":"active"}'
    Start-Sleep -Milliseconds 500
    $t0 = $proc.TotalProcessorTime
    $frames0 = 0
    $titleA = Get-WindowTitle $hwnd
    if ($titleA -match 'frames=(\d+)') { $frames0 = [int]$Matches[1] }
    $cpuCores = [Environment]::ProcessorCount
    $perfSw = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Seconds 10
    $perfSw.Stop()
    $t1 = $proc.TotalProcessorTime
    $titleB = Get-WindowTitle $hwnd
    $frames1 = $frames0
    if ($titleB -match 'frames=(\d+)') { $frames1 = [int]$Matches[1] }
    $cpuMs = ($t1 - $t0).TotalMilliseconds
    $oneCorePct = 100.0 * $cpuMs / $perfSw.Elapsed.TotalMilliseconds
    $sysPct = $oneCorePct / $cpuCores
    $fps = 0.0
    if ($perfSw.Elapsed.TotalSeconds -gt 0) { $fps = ($frames1 - $frames0) / $perfSw.Elapsed.TotalSeconds }
    Write-Host ('PERF active: cpu={0:0.0}% of one core / {1:0.1}% of {2} logical CPUs, fps={3:0.0}, frames={4}' -f $oneCorePct, $sysPct, $cpuCores, $fps, ($frames1 - $frames0))
    Check 'active render fps >= 5' ($fps -ge 5.0) ('fps=' + [math]::Round($fps, 1))
    Check 'active CPU below 60% of one core' ($oneCorePct -lt 60.0) ('cpu=' + [math]::Round($oneCorePct, 1) + '%')
    $script:MeasuredCpuOneCore = $oneCorePct
    $script:MeasuredCpuSystem = $sysPct
    $script:MeasuredFps = $fps

    # ---- 9. quit -----------------------------------------------------------
    Send-Cmd $proc '{"cmd":"quit"}'
    try { $proc.StandardInput.Close() } catch { }
    $exited = $proc.WaitForExit(4000)
    Check 'helper exits cleanly on quit' $exited $(if ($exited) { 'exitCode=' + $proc.ExitCode } else { 'still running' })
    $still = $false
    try { $still = -not $proc.HasExited } catch { }
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    Check 'no helper process remains' ($exited -and (-not $still))
} catch {
    Write-Host ('[FAIL] test harness exception: ' + $_.Exception.Message)
    $script:Failures++
    $script:Checks++
} finally {
    try { if ($proc -and -not $proc.HasExited) { $proc.Kill(); [void]$proc.WaitForExit(2000) } } catch { }
    try { [void][T]::SetCursorPos($oldCursor.X, $oldCursor.Y) } catch { }
    try {
        Show-Stderr -LR $errLR -MaxLines 12
    } catch { }
    $startAll.Stop()
    Write-Host ('TOTAL: {0} checks, {1} failed, elapsed={2:0.0}s' -f $script:Checks, $script:Failures, $startAll.Elapsed.TotalSeconds)
    if ($script:Failures -eq 0) { Write-Host 'RESULT: PASS' } else { Write-Host 'RESULT: FAIL' }
    exit $(if ($script:Failures -eq 0) { 0 } else { 1 })
}