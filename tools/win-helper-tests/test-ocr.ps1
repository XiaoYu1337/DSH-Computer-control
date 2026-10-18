#requires -Version 5.1
# test-ocr.ps1 - End-to-end test for dsh-computer-control/scripts/ocr-text.ps1.
#
# Flow:
#   1. Launch Windows 11 Notepad with a fresh empty file (its own window).
#   2. Focus/maximize that window with window-tools.ps1, paste known text
#      ("DSH OCR 测试 4399 Agent") and zoom in.
#   3. Capture the physical desktop with tools/desktop.ps1.
#   4. OCR the screenshot with and without -Language; assert 4399 and 测试 are found.
#   5. Assert error envelopes (missing file, missing args) and clean up Notepad.
#
# Prints PASS/FAIL lines; exit code 0 only when every assertion passed.

$ErrorActionPreference = 'Stop'
$script:TestRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot '_common.ps1')
Ensure-OutputDir

$ocrHelper = Join-Path $script:HelperDir 'ocr-text.ps1'
$windowTools = Join-Path $script:HelperDir 'window-tools.ps1'
$desktopHelper = Join-Path $script:RepoRoot 'tools\desktop.ps1'

$screenshotPath = Join-Path $script:OutputDir 'ocr-screenshot.png'
$notepadFile = Join-Path $env:TEMP 'dsh-ocr-input.txt'
$testText = 'DSH OCR 测试 4399 Agent'

$baselineNotepad = @(Get-ProcessIdsByName 'notepad')
$savedClipboard = $null
try { $savedClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $savedClipboard = $null }
$targetWindow = $null
$shotWidth = 0
$shotHeight = 0

Write-Output ('INFO ocr helper: ' + $ocrHelper)
Write-Output ('INFO screenshot: ' + $screenshotPath)

try {
    # ------------------------------------------------------------------
    # 1. Notepad with its own empty document (avoids touching restored tabs)
    # ------------------------------------------------------------------
    if (Test-Path -LiteralPath $notepadFile) {
        Remove-Item -LiteralPath $notepadFile -Force
    }
    [System.IO.File]::WriteAllText($notepadFile, '', (New-Object System.Text.UTF8Encoding($false)))
    Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $notepadFile + '"') -PassThru | Out-Null
    Write-Output ('INFO notepad file: ' + $notepadFile)

    $deadline = (Get-Date).AddSeconds(15)
    while ($null -eq $targetWindow -and (Get-Date) -lt $deadline) {
        $listResult = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{ Action = 'list' } -Tag 'list'
        if ($listResult.ExitCode -eq 0 -and $null -ne $listResult.Json -and $listResult.Json.ok -eq $true) {
            $targetWindow = @($listResult.Json.windows) | Where-Object {
                ([string]$_.process) -ieq 'Notepad' -and
                ([string]$_.title).IndexOf('dsh-ocr-input', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            } | Select-Object -First 1
        }
        if ($null -eq $targetWindow) {
            Start-Sleep -Milliseconds 400
        }
    }
    Assert-That ($null -ne $targetWindow) 'ocr:notepad-window-found' 'Notepad window with dsh-ocr-input did not appear within 15s.'
    if ($null -eq $targetWindow) {
        throw 'Notepad test window was not found.'
    }

    $focusResult = Invoke-HelperJson -ScriptPath $windowTools -Parameters @{
        Action   = 'focus'
        WindowId = [string]$targetWindow.hwnd
    } -Tag 'focus'
    Assert-That ($focusResult.ExitCode -eq 0 -and $null -ne $focusResult.Json -and $focusResult.Json.focused -eq $true) `
        'ocr:notepad-focused' ('focus result: ' + $focusResult.JsonText)

    # Maximize so the screenshot is dominated by the known text.
    [void][DshWinHelperTestNative]::ShowWindow([IntPtr][long]$targetWindow.hwnd, [DshWinHelperTestNative]::SW_MAXIMIZE)
    Start-Sleep -Milliseconds 600

    # ------------------------------------------------------------------
    # 2. Paste known text and enlarge it (Ctrl + numpad-plus zoom)
    # ------------------------------------------------------------------
    Add-Type -AssemblyName System.Windows.Forms
    Set-Clipboard -Value $testText
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 500
    for ($zoomStep = 0; $zoomStep -lt 3; $zoomStep++) {
        [System.Windows.Forms.SendKeys]::SendWait('^{ADD}')
        Start-Sleep -Milliseconds 150
    }
    Start-Sleep -Milliseconds 700

    $enteredValue = ''
    try {
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$targetWindow.hwnd)
        $documentCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Document
        )
        $document = $windowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $documentCondition)
        if ($document) {
            $valuePattern = $document.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $enteredValue = [string]$valuePattern.Current.Value
        }
    } catch {
        Write-Output ('INFO UIA document value unavailable: ' + $_.Exception.Message)
    }
    Assert-That ($enteredValue.Contains('4399')) 'ocr:notepad-text-entered' ('document value: ' + $enteredValue)

    # ------------------------------------------------------------------
    # 3. Screenshot the desktop
    # ------------------------------------------------------------------
    if (Test-Path -LiteralPath $screenshotPath) {
        Remove-Item -LiteralPath $screenshotPath -Force
    }
    $screenshotResult = Invoke-HelperJson -ScriptPath $desktopHelper -Parameters @{
        Action  = 'screenshot'
        OutPath = $screenshotPath
    } -Tag 'screenshot'
    if ($null -ne $screenshotResult.Json) {
        $shotWidth = [int]$screenshotResult.Json.width
        $shotHeight = [int]$screenshotResult.Json.height
    }
    Assert-That ($screenshotResult.ExitCode -eq 0 -and (Test-Path -LiteralPath $screenshotPath) -and $shotWidth -gt 0 -and $shotHeight -gt 0) `
        'ocr:screenshot-created' ($shotWidth.ToString() + 'x' + $shotHeight.ToString() + ' ' + $screenshotResult.JsonText)
    Write-Output ('INFO screen size: ' + $shotWidth + 'x' + $shotHeight)

    # ------------------------------------------------------------------
    # 4. OCR with explicit language and with automatic language selection
    # ------------------------------------------------------------------
    $ocrZh = Invoke-HelperJson -ScriptPath $ocrHelper -Parameters @{
        Path     = $screenshotPath
        Language = 'zh-Hans'
    } -Tag 'ocr-zh-hans'
    Assert-That ($ocrZh.ExitCode -eq 0 -and $null -ne $ocrZh.Json -and $ocrZh.Json.ok -eq $true -and [string]::IsNullOrEmpty($ocrZh.JsonError)) `
        'ocr:json-valid' ('exit=' + $ocrZh.ExitCode + ' json=' + $ocrZh.JsonText)

    $json = $ocrZh.Json
    if ($null -eq $json) {
        throw 'OCR did not return parseable JSON.'
    }

    Assert-That ($json.engine -eq 'Windows.Media.Ocr') 'ocr:engine-name' ([string]$json.engine)
    Assert-That (([string]$json.language) -match '^zh-Hans') 'ocr:language-zh-hans' ([string]$json.language)
    Assert-That ([int]$json.width -eq $shotWidth -and [int]$json.height -eq $shotHeight) `
        'ocr:size-matches-screenshot' ([string]$json.width + 'x' + [string]$json.height)

    $words = @($json.words)
    $lines = @($json.lines)
    Assert-That ($words.Count -gt 0) 'ocr:words-present' ('words=' + $words.Count)
    Assert-That ($lines.Count -gt 0) 'ocr:lines-present' ('lines=' + $lines.Count)

    $joinedText = ($words | ForEach-Object { [string]$_.text }) -join ''
    Assert-That ($joinedText.Contains('4399')) 'ocr:found-4399' ('joined text: ' + $joinedText)
    Assert-That ($joinedText.Contains('测试')) 'ocr:found-chinese' ('joined text: ' + $joinedText)

    $wordSchemaOk = $true
    $bboxOk = $true
    $confidenceOk = $true
    $lineSchemaOk = $true
    foreach ($word in $words) {
        $names = Get-JsonPropertyNames $word
        foreach ($requiredName in @('text', 'x', 'y', 'w', 'h', 'confidence')) {
            if ($names -notcontains $requiredName) { $wordSchemaOk = $false }
        }
        if (-not (Test-Number $word.x) -or -not (Test-Number $word.y) -or -not (Test-Number $word.w) -or -not (Test-Number $word.h)) {
            $wordSchemaOk = $false
        } else {
            $boxX = [int]$word.x
            $boxY = [int]$word.y
            $boxW = [int]$word.w
            $boxH = [int]$word.h
            if ($boxX -lt 0 -or $boxY -lt 0 -or $boxW -lt 0 -or $boxH -lt 0) { $bboxOk = $false }
            if (($boxX + $boxW) -gt ($shotWidth + 2) -or ($boxY + $boxH) -gt ($shotHeight + 2)) { $bboxOk = $false }
        }
        if ($null -ne $word.confidence) { $confidenceOk = $false }
    }
    foreach ($line in $lines) {
        $names = Get-JsonPropertyNames $line
        foreach ($requiredName in @('text', 'x', 'y', 'w', 'h')) {
            if ($names -notcontains $requiredName) { $lineSchemaOk = $false }
        }
        if (-not (Test-Number $line.x) -or -not (Test-Number $line.y) -or -not (Test-Number $line.w) -or -not (Test-Number $line.h)) {
            $lineSchemaOk = $false
        }
    }
    Assert-That $wordSchemaOk 'ocr:word-schema' 'word objects need text/x/y/w/h/confidence'
    Assert-That $bboxOk 'ocr:word-bbox-in-image' 'word boxes must be inside the screenshot'
    Assert-That $confidenceOk 'ocr:confidence-null' 'Windows.Media.Ocr exposes no per-word confidence on this build'
    Assert-That $lineSchemaOk 'ocr:line-schema' 'line objects need text/x/y/w/h'
    Assert-That ((Test-Number $json.elapsedMs) -and ([int]$json.elapsedMs -ge 0)) 'ocr:elapsed-ms' ([string]$json.elapsedMs)

    $ocrAuto = Invoke-HelperJson -ScriptPath $ocrHelper -Parameters @{
        Path = $screenshotPath
    } -Tag 'ocr-auto'
    $autoOk = ($ocrAuto.ExitCode -eq 0 -and $null -ne $ocrAuto.Json -and $ocrAuto.Json.ok -eq $true)
    $autoJoined = ''
    if ($autoOk) {
        $autoJoined = (@($ocrAuto.Json.words) | ForEach-Object { [string]$_.text }) -join ''
    }
    Assert-That ($autoOk -and ([string]$ocrAuto.Json.language).Length -gt 0) 'ocr:auto-language' ([string]$ocrAuto.Json.language)
    Assert-That ($autoJoined.Contains('4399')) 'ocr:auto-found-4399' ('joined text: ' + $autoJoined)

    Save-JsonSample $json 'ocr-result-zh-hans.json' | Out-Null
    Save-JsonSample $ocrAuto.Json 'ocr-result-auto.json' | Out-Null
    Save-TextSample $ocrZh.JsonText 'ocr-result-zh-hans.raw.json' | Out-Null

    # ------------------------------------------------------------------
    # 5. Error envelopes
    # ------------------------------------------------------------------
    $missing = Invoke-HelperJson -ScriptPath $ocrHelper -Parameters @{
        Path = 'C:\no-such-folder\dsh-ocr-missing.png'
    } -Tag 'ocr-missing'
    Assert-That ($missing.ExitCode -eq 1 -and $null -ne $missing.Json -and $missing.Json.ok -eq $false -and $missing.Json.code -eq 'file_not_found') `
        'ocr:missing-file-json' ('exit=' + $missing.ExitCode + ' json=' + $missing.JsonText)

    $noArgs = Invoke-HelperJson -ScriptPath $ocrHelper -Parameters @{} -Tag 'ocr-noargs'
    Assert-That ($noArgs.ExitCode -eq 1 -and $null -ne $noArgs.Json -and $noArgs.Json.ok -eq $false -and $noArgs.Json.code -eq 'invalid_args') `
        'ocr:invalid-args-json' ('exit=' + $noArgs.ExitCode + ' json=' + $noArgs.JsonText)
} catch {
    Write-Fail 'ocr:unexpected-exception' $_.Exception.Message
} finally {
    Stop-ProcessesNotIn -Name 'notepad' -Baseline $baselineNotepad | Out-Null
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $notepadFile) {
        Remove-Item -LiteralPath $notepadFile -Force -ErrorAction SilentlyContinue
    }
    if (-not [string]::IsNullOrEmpty($savedClipboard)) {
        try { Set-Clipboard -Value $savedClipboard } catch { }
    }
    $remaining = @(Get-NewProcessIds -Name 'notepad' -Baseline $baselineNotepad)
    Assert-That ($remaining.Count -eq 0) 'ocr:notepad-cleanup' ('remaining pids=' + ($remaining -join ','))
}

Write-TestSummary 'ocr'
if ((Get-TestFailCount) -gt 0) { exit 1 } else { exit 0 }
