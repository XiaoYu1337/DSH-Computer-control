#requires -Version 5.1
# run-all.ps1 - Run every win-helper test, capture PASS/FAIL output to output/test-log.txt,
# verify that all sample JSON files are parseable, and clean up test-launched Notepad processes.
#
# Usage:
#   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\win-helper-tests\run-all.ps1
#
# Exit code 0 only when OCR, UIA and window-tools tests all pass.

$ErrorActionPreference = 'Stop'
$script:TestRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot '_common.ps1')
Ensure-OutputDir

$logPath = Join-Path $script:OutputDir 'test-log.txt'
$baselineNotepad = @(Get-ProcessIdsByName 'notepad')
$logLines = New-Object System.Collections.ArrayList

function Add-LogLine([string]$Text = '') {
    [void]$logLines.Add($Text)
    Write-Output $Text
}

function Read-Utf8File([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Split-TextLines([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return @() }
    return @($Text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
}

Add-LogLine '=== DSH win-helper tests ==='
Add-LogLine ('Time: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'))
Add-LogLine ('Host: ' + $env:COMPUTERNAME + ' | OS: ' + [System.Environment]::OSVersion.VersionString)
Add-LogLine ('PowerShell: ' + $PSVersionTable.PSVersion.ToString() + ' (' + $PSVersionTable.PSEdition + ')')
Add-LogLine ('Helpers: ' + $script:HelperDir)
Add-LogLine ('Output: ' + $script:OutputDir)
if ($baselineNotepad.Count -gt 0) {
    Add-LogLine ('INFO pre-existing notepad pids (will not be killed by cleanup): ' + ($baselineNotepad -join ','))
}

# Screen/DPI environment snapshot (also validates tools/desktop.ps1 in this shell).
$desktopHelper = Join-Path $script:RepoRoot 'tools\desktop.ps1'
if (Test-Path -LiteralPath $desktopHelper) {
    $screenResult = Invoke-HelperJson -ScriptPath $desktopHelper -Parameters @{ Action = 'screeninfo' } -Tag 'screeninfo'
    if ($null -ne $screenResult.Json) {
        Save-JsonSample $screenResult.Json 'environment-screen.json' | Out-Null
        Add-LogLine ('Screen: ' + $screenResult.JsonText)
    } else {
        Add-LogLine ('Screen: unavailable (' + $screenResult.StdErr + ')')
    }
}

$tests = @(
    @{ Name = 'ocr'; ScriptName = 'test-ocr.ps1' },
    @{ Name = 'uia'; ScriptName = 'test-uia.ps1' },
    @{ Name = 'window-tools'; ScriptName = 'test-window-tools.ps1' }
)

$testFailures = 0
$totalPass = 0
$totalFail = 0

foreach ($test in $tests) {
    $scriptPath = Join-Path $script:TestRoot $test.ScriptName
    $outFile = Join-Path $env:TEMP ('dsh-test-' + $test.Name + '-' + [guid]::NewGuid().ToString('N') + '.out')
    $errFile = Join-Path $env:TEMP ('dsh-test-' + $test.Name + '-' + [guid]::NewGuid().ToString('N') + '.err')

    Add-LogLine ''
    Add-LogLine ('--- RUN ' + $test.Name + ' ---')
    Add-LogLine ('Command: powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $scriptPath + '"')

    try {
        $process = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $scriptPath + '"')) `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -PassThru -Wait -WindowStyle Hidden

        $stdout = Read-Utf8File $outFile
        $stderr = Read-Utf8File $errFile
        foreach ($line in (Split-TextLines $stdout)) {
            Add-LogLine ('[' + $test.Name + '] ' + $line)
            if ($line -like 'PASS *') { $totalPass++ }
            if ($line -like 'FAIL *') { $totalFail++ }
        }
        foreach ($line in (Split-TextLines $stderr)) {
            Add-LogLine ('[' + $test.Name + '-stderr] ' + $line)
        }
        Add-LogLine ('[' + $test.Name + '] EXIT ' + $process.ExitCode)
        if ($process.ExitCode -ne 0) { $testFailures++ }
    } catch {
        Add-LogLine ('[' + $test.Name + '] ERROR ' + $_.Exception.Message)
        $testFailures++
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

# Safety net: remove Notepad processes launched by this test run.
Add-LogLine ''
$leftover = @(Get-NewProcessIds -Name 'notepad' -Baseline $baselineNotepad)
if ($leftover.Count -gt 0) {
    Add-LogLine ('Cleanup: stopping leftover notepad pids=' + ($leftover -join ','))
    Stop-ProcessesNotIn -Name 'notepad' -Baseline $baselineNotepad | Out-Null
} else {
    Add-LogLine 'Cleanup: no leftover notepad processes'
}

# Verify every JSON sample written by the tests parses with ConvertFrom-Json.
Add-LogLine ''
Add-LogLine '--- SAMPLE JSON VALIDATION ---'
$sampleFiles = @(Get-ChildItem -LiteralPath $script:OutputDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
$invalidSamples = 0
foreach ($sampleFile in $sampleFiles) {
    try {
        $sampleText = Read-Utf8File $sampleFile.FullName
        $null = $sampleText | ConvertFrom-Json
        Add-LogLine ('JSON OK   ' + $sampleFile.Name)
    } catch {
        $invalidSamples++
        Add-LogLine ('JSON FAIL ' + $sampleFile.Name + ' :: ' + $_.Exception.Message)
    }
}
Add-LogLine ('JSON samples: ' + $sampleFiles.Count + ' checked, ' + $invalidSamples + ' invalid')

Add-LogLine ''
Add-LogLine ('Result: ' + $(if ($testFailures -eq 0 -and $invalidSamples -eq 0) { 'PASS' } else { 'FAIL' }) +
    ' | testSuites=' + $tests.Count + ' suiteFailures=' + $testFailures +
    ' | PASS lines=' + $totalPass + ' FAIL lines=' + $totalFail +
    ' | jsonSamples=' + $sampleFiles.Count + ' invalidJson=' + $invalidSamples)
Add-LogLine ('Log: ' + $logPath)

$logText = ($logLines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($logPath, $logText, (New-Object System.Text.UTF8Encoding($true)))
Write-Output ''
Write-Output ('Test log written to: ' + $logPath)

if ($testFailures -gt 0 -or $invalidSamples -gt 0) { exit 1 } else { exit 0 }
