#requires -Version 5.1
# test-window-tools.ps1 - End-to-end test for dsh-computer-control/scripts/window-tools.ps1.
#
# Flow:
#   1. Record baseline Notepad processes, launch Notepad.
#   2. wait -Process notepad; list windows (foreground first, schema, physical pixels).
#   3. focus -Process notepad / focus -WindowId / focus -Title and verify GetForegroundWindow.
#   4. Minimize with Win32, verify list reports minimized, then focus -WindowId restores it.
#   5. Error envelopes: window_not_found, timeout, invalid_args, invalid_regex.
#   6. Kill only the Notepad processes started by this test.
#
# Prints PASS/FAIL lines; exit code 0 only when every assertion passed.

$ErrorActionPreference = 'Stop'
$script:TestRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot '_common.ps1')
Ensure-OutputDir

$windowTools = Join-Path $script:HelperDir 'window-tools.ps1'
$screen = Get-ScreenBounds
$baselineNotepad = @(Get-ProcessIdsByName 'notepad')

Write-Output ('INFO window-tools helper: ' + $windowTools)
Write-Output ('INFO screen: ' + $screen.Width + 'x' + $screen.Height + ' at ' + $screen.X + ',' + $screen.Y)
if ($baselineNotepad.Count -gt 0) {
    Write-Output ('INFO pre-existing notepad pids (will not be killed): ' + ($baselineNotepad -join ','))
}

function Find-WindowByHwnd {
    param($Windows, [long]$Hwnd)
    return @($Windows) | Where-Object { [long]$_.hwnd -eq $Hwnd } | Select-Object -First 1
}

function Test-WindowSchema {
    param($Windows)
    $schemaOk = $true
    foreach ($window in $Windows) {
        $names = Get-JsonPropertyNames $window
        foreach ($requiredName in @('hwnd', 'title', 'process', 'pid', 'x', 'y', 'w', 'h', 'visible', 'minimized', 'foreground')) {
            if ($names -notcontains $requiredName) { $schemaOk = $false }
        }
        if (-not (Test-Number $window.hwnd) -or -not (Test-Number $window.pid)) { $schemaOk = $false }
        if (-not (Test-Number $window.x) -or -not (Test-Number $window.y) -or -not (Test-Number $window.w) -or -not (Test-Number $window.h)) { $schemaOk = $false }
        if ($window.visible -isnot [bool] -or $window.minimized -isnot [bool] -or $window.foreground -isnot [bool]) { $schemaOk = $false }
        if ([string]::IsNullOrEmpty([string]$window.title)) { $schemaOk = $false }
    }
    return $schemaOk
}

try {
    # ------------------------------------------------------------------
    # 1. Launch Notepad and wait for its window
    # ------------------------------------------------------------------
    Start-Process -FilePath 'notepad.exe' -PassThru | Out-Null
    $waitResult = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action    = 'wait'
        Process   = 'notepad'
        TimeoutMs = '15000'
    } -Tag 'wait-process'
    Assert-That ($waitResult.ExitCode -eq 0 -and $null -ne $waitResult.Json -and [string]::IsNullOrEmpty($waitResult.JsonError) -and $waitResult.Json.ok -eq $true) `
        'window:wait-process-json' ('exit=' + $waitResult.ExitCode + ' json=' + $waitResult.JsonText)

    if ($null -eq $waitResult.Json) {
        throw 'wait did not return parseable JSON.'
    }
    $notepadWindow = $waitResult.Json.window
    Assert-That (([string]$notepadWindow.process) -ieq 'notepad') 'window:wait-process-match' ([string]$notepadWindow.process)
    Assert-That ($notepadWindow.visible -eq $true -and $notepadWindow.minimized -eq $false) 'window:wait-visible' `
        ('visible=' + $notepadWindow.visible + ' minimized=' + $notepadWindow.minimized)
    Assert-That ((Test-Number $waitResult.Json.elapsedMs) -and ([int]$waitResult.Json.elapsedMs -ge 0)) 'window:wait-elapsed-ms' ([string]$waitResult.Json.elapsedMs)
    $notepadHwnd = [long]$notepadWindow.hwnd
    Save-JsonSample $waitResult.Json 'window-wait-process.json' | Out-Null

    # ------------------------------------------------------------------
    # 2. list
    # ------------------------------------------------------------------
    $listResult = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'list' } -Tag 'list'
    Assert-That ($listResult.ExitCode -eq 0 -and $null -ne $listResult.Json -and [string]::IsNullOrEmpty($listResult.JsonError) -and $listResult.Json.ok -eq $true) `
        'window:list-json' ('exit=' + $listResult.ExitCode + ' json=' + $listResult.JsonText)
    $windows = @($listResult.Json.windows)
    Assert-That ($windows.Count -gt 0) 'window:list-non-empty' ('windows=' + $windows.Count)
    Assert-That (Test-WindowSchema $windows) 'window:list-schema' 'each window needs hwnd/title/process/pid/x/y/w/h/visible/minimized/foreground'

    $listedNotepad = Find-WindowByHwnd $windows $notepadHwnd
    Assert-That ($null -ne $listedNotepad) 'window:list-notepad' ('hwnd=' + $notepadHwnd)
    $dshWindow = $windows | Where-Object { ([string]$_.title).IndexOf('DeepSeek Harness', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    Assert-That ($null -ne $dshWindow) 'window:list-dsh' 'DeepSeek Harness window should be listed'

    $allVisible = $true
    $allPositive = $true
    foreach ($window in $windows) {
        if ($window.visible -ne $true) { $allVisible = $false }
        if ([int]$window.w -le 0 -or [int]$window.h -le 0) { $allPositive = $false }
    }
    Assert-That $allVisible 'window:list-all-visible'
    Assert-That $allPositive 'window:list-positive-size'

    $anyForeground = $null -ne ($windows | Where-Object { $_.foreground -eq $true } | Select-Object -First 1)
    if ($anyForeground) {
        Assert-That ($windows[0].foreground -eq $true) 'window:list-foreground-first' ('first title: ' + $windows[0].title)
    } else {
        Write-Output 'INFO window:list-foreground-first skipped (no foreground window in list)'
    }

    # 125% scaling on this machine: physical Notepad width ~1440, DIP width would be ~1152.
    Assert-That (([int]$listedNotepad.w -ge 1200) -and ([int]$listedNotepad.h -ge 600)) 'window:list-physical-pixels' `
        ('notepad rect=' + $listedNotepad.w + 'x' + $listedNotepad.h)
    Write-Output ('INFO notepad rect: ' + $listedNotepad.x + ',' + $listedNotepad.y + ' ' + $listedNotepad.w + 'x' + $listedNotepad.h)
    Save-JsonSample $listResult.Json 'window-list.json' | Out-Null

    # ------------------------------------------------------------------
    # 3. focus by process / by window id / by title
    # ------------------------------------------------------------------
    $focusProcess = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action  = 'focus'
        Process = 'notepad'
    } -Tag 'focus-process'
    Assert-That ($focusProcess.ExitCode -eq 0 -and $focusProcess.Json.ok -eq $true -and $focusProcess.Json.focused -eq $true) `
        'window:focus-process' ('exit=' + $focusProcess.ExitCode + ' json=' + $focusProcess.JsonText)
    $focusedHwnd = [long]$focusProcess.Json.window.hwnd
    Assert-That ($focusedHwnd -eq $notepadHwnd) 'window:focus-process-hwnd' ([string]$focusedHwnd)
    Assert-That ($focusProcess.Json.window.foreground -eq $true) 'window:focus-process-foreground-flag'
    Assert-That ([long][DshWinHelperTestNative]::GetForegroundWindow() -eq $focusedHwnd) 'window:focus-process-verified-foreground'
    Save-JsonSample $focusProcess.Json 'window-focus-process.json' | Out-Null

    $focusById = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action   = 'focus'
        WindowId = [string]$notepadHwnd
    } -Tag 'focus-id'
    Assert-That ($focusById.ExitCode -eq 0 -and [long]$focusById.Json.window.hwnd -eq $notepadHwnd -and [long][DshWinHelperTestNative]::GetForegroundWindow() -eq $notepadHwnd) `
        'window:focus-window-id' ('exit=' + $focusById.ExitCode + ' json=' + $focusById.JsonText)

    $focusByTitle = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action = 'focus'
        Title  = 'Notepad|记事本'
    } -Tag 'focus-title'
    Assert-That ($focusByTitle.ExitCode -eq 0 -and $focusByTitle.Json.focused -eq $true -and ([string]$focusByTitle.Json.window.title) -match 'Notepad|记事本') `
        'window:focus-title-regex' ('json=' + $focusByTitle.JsonText)
    Save-JsonSample $focusByTitle.Json 'window-focus-title.json' | Out-Null

    # ------------------------------------------------------------------
    # 4. minimize -> list(minimized) -> focus(-WindowId) restores
    # ------------------------------------------------------------------
    [void][DshWinHelperTestNative]::ShowWindow([IntPtr]$notepadHwnd, [DshWinHelperTestNative]::SW_MINIMIZE)
    Start-Sleep -Milliseconds 600
    $minimizedList = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'list' } -Tag 'list-minimized'
    $minimizedWindow = Find-WindowByHwnd @($minimizedList.Json.windows) $notepadHwnd
    Assert-That ($null -ne $minimizedWindow -and $minimizedWindow.minimized -eq $true) 'window:list-minimized' `
        ('json=' + $minimizedList.JsonText)
    Save-JsonSample $minimizedList.Json 'window-list-minimized.json' | Out-Null

    $restoreFocus = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action   = 'focus'
        WindowId = [string]$notepadHwnd
    } -Tag 'restore-focus'
    $restoredHwnd = [long][DshWinHelperTestNative]::GetForegroundWindow()
    Assert-That ($restoreFocus.ExitCode -eq 0 -and $restoreFocus.Json.window.minimized -eq $false -and $restoredHwnd -eq $notepadHwnd) `
        'window:focus-restores-minimized' ('json=' + $restoreFocus.JsonText + ' foreground=' + $restoredHwnd)
    Assert-That ([DshWinHelperTestNative]::IsIconic([IntPtr]$notepadHwnd) -eq $false) 'window:isiconic-false-after-restore'

    # ------------------------------------------------------------------
    # 5. wait by window id / title
    # ------------------------------------------------------------------
    $waitById = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action    = 'wait'
        WindowId  = [string]$notepadHwnd
        TimeoutMs = '5000'
    } -Tag 'wait-id'
    Assert-That ($waitById.ExitCode -eq 0 -and [long]$waitById.Json.window.hwnd -eq $notepadHwnd) `
        'window:wait-window-id' ('json=' + $waitById.JsonText)

    $waitByTitle = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action    = 'wait'
        Title     = 'Notepad|记事本'
        TimeoutMs = '5000'
    } -Tag 'wait-title'
    Assert-That ($waitByTitle.ExitCode -eq 0 -and ([string]$waitByTitle.Json.window.title) -match 'Notepad|记事本') `
        'window:wait-title-regex' ('json=' + $waitByTitle.JsonText)
    Save-JsonSample $waitByTitle.Json 'window-wait-title.json' | Out-Null

    # ------------------------------------------------------------------
    # 6. Error envelopes
    # ------------------------------------------------------------------
    $notFound = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action = 'focus'
        Title  = 'dsh_no_such_window_4399'
    } -Tag 'not-found'
    Assert-That ($notFound.ExitCode -eq 1 -and $null -ne $notFound.Json -and $notFound.Json.code -eq 'window_not_found') `
        'window:window-not-found' ('exit=' + $notFound.ExitCode + ' json=' + $notFound.JsonText)

    $badId = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action   = 'focus'
        WindowId = '99999999'
    } -Tag 'bad-id'
    Assert-That ($badId.ExitCode -eq 1 -and $null -ne $badId.Json -and $badId.Json.code -eq 'window_not_found') `
        'window:invalid-window-id' ('exit=' + $badId.ExitCode + ' json=' + $badId.JsonText)

    $timeoutWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutResult = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action    = 'wait'
        Process   = 'dsh_no_such_process_4399'
        TimeoutMs = '800'
    } -Tag 'timeout'
    $timeoutWatch.Stop()
    Assert-That ($timeoutResult.ExitCode -eq 1 -and $null -ne $timeoutResult.Json -and $timeoutResult.Json.code -eq 'timeout') `
        'window:wait-timeout' ('exit=' + $timeoutResult.ExitCode + ' json=' + $timeoutResult.JsonText)
    Assert-That ($timeoutWatch.ElapsedMilliseconds -ge 700) 'window:wait-timeout-elapsed' ([string]$timeoutWatch.ElapsedMilliseconds + 'ms')

    $missingSelector = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'focus' } -Tag 'missing-selector'
    Assert-That ($missingSelector.ExitCode -eq 1 -and $null -ne $missingSelector.Json -and $missingSelector.Json.code -eq 'invalid_args') `
        'window:invalid-args-no-selector' ('exit=' + $missingSelector.ExitCode + ' json=' + $missingSelector.JsonText)

    $badAction = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'bogus' } -Tag 'bad-action'
    Assert-That ($badAction.ExitCode -eq 1 -and $null -ne $badAction.Json -and $badAction.Json.code -eq 'invalid_args') `
        'window:invalid-args-action' ('exit=' + $badAction.ExitCode + ' json=' + $badAction.JsonText)

    $badRegex = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'list'; Title = '[' } -Tag 'bad-regex'
    Assert-That ($badRegex.ExitCode -eq 1 -and $null -ne $badRegex.Json -and $badRegex.Json.code -eq 'invalid_regex') `
        'window:invalid-regex' ('exit=' + $badRegex.ExitCode + ' json=' + $badRegex.JsonText)
} catch {
    Write-Fail 'window:unexpected-exception' $_.Exception.Message
} finally {
    Stop-ProcessesNotIn -Name 'notepad' -Baseline $baselineNotepad | Out-Null
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-NewProcessIds -Name 'notepad' -Baseline $baselineNotepad)
    Assert-That ($remaining.Count -eq 0) 'window:notepad-cleanup' ('remaining pids=' + ($remaining -join ','))
}

Write-TestSummary 'window-tools'
if ((Get-TestFailCount) -gt 0) { exit 1 } else { exit 0 }
