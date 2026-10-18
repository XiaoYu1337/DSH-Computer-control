#requires -Version 5.1
# _common.ps1 - Shared helpers for the win-helper PowerShell tests.
# Dot-source from each test script after setting $script:TestRoot = $PSScriptRoot.

$ErrorActionPreference = 'Stop'

if (-not $script:TestRoot) {
    $script:TestRoot = $PSScriptRoot
}
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $script:TestRoot)
$script:OutputDir = Join-Path $script:TestRoot 'output'
$script:HelperDir = Join-Path $script:RepoRoot 'dsh-computer-control\scripts'
$script:PassCount = 0
$script:FailCount = 0

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DshWinHelperTestNative
{
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();

    public const int SW_MAXIMIZE = 3;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;
}
"@ -ErrorAction Stop | Out-Null

function Ensure-OutputDir {
    if (-not (Test-Path -LiteralPath $script:OutputDir)) {
        New-Item -ItemType Directory -Force -Path $script:OutputDir | Out-Null
    }
}

function Write-Pass([string]$Name) {
    $script:PassCount++
    Write-Output ('PASS ' + $Name)
}

function Write-Fail([string]$Name, [string]$Detail = '') {
    $script:FailCount++
    if ([string]::IsNullOrEmpty($Detail)) {
        Write-Output ('FAIL ' + $Name)
    } else {
        Write-Output ('FAIL ' + $Name + ' :: ' + $Detail)
    }
}

function Assert-That {
    param(
        [bool]$Condition,
        [string]$Name,
        [string]$Detail = ''
    )
    if ($Condition) {
        Write-Pass $Name
    } else {
        Write-Fail $Name $Detail
    }
}

function Get-TestPassCount { return $script:PassCount }
function Get-TestFailCount { return $script:FailCount }

function Write-TestSummary([string]$Label) {
    Write-Output ('SUMMARY ' + $Label + ' pass=' + $script:PassCount + ' fail=' + $script:FailCount)
}

# Invoke one of the helper scripts with windows powershell.exe and return its single JSON
# object (parsed plus raw text), stderr text and exit code.
function Invoke-HelperJson {
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [hashtable]$Parameters = @{},
        [string]$Tag = 'helper'
    )

    $outFile = Join-Path $env:TEMP ('dsh-helper-' + [guid]::NewGuid().ToString('N') + '.out')
    $errFile = Join-Path $env:TEMP ('dsh-helper-' + [guid]::NewGuid().ToString('N') + '.err')
    $jsonText = ''
    $stdErr = ''
    $exitCode = -1
    $argBuilder = New-Object System.Text.StringBuilder

    foreach ($fixedArg in @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File')) {
        [void]$argBuilder.Append($fixedArg + ' ')
    }
    [void]$argBuilder.Append('"' + $ScriptPath + '" ')
    foreach ($key in $Parameters.Keys) {
        $value = [string]$Parameters[$key]
        $value = $value.Replace('"', '\"')
        [void]$argBuilder.Append('-' + $key + ' "' + $value + '" ')
    }
    $arguments = $argBuilder.ToString().Trim()

    try {
        $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments `
            -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -PassThru -Wait -WindowStyle Hidden
        $exitCode = $process.ExitCode
        if (Test-Path -LiteralPath $outFile) {
            $jsonText = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8).Trim()
        }
        if (Test-Path -LiteralPath $errFile) {
            $stdErr = [System.IO.File]::ReadAllText($errFile, [System.Text.Encoding]::UTF8).Trim()
        }
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }

    $json = $null
    $jsonError = ''
    if (-not [string]::IsNullOrEmpty($jsonText)) {
        try {
            $json = $jsonText | ConvertFrom-Json
        } catch {
            $jsonError = $_.Exception.Message
        }
    }

    return [pscustomobject]@{
        Tag      = $Tag
        ExitCode = $exitCode
        JsonText = $jsonText
        Json     = $json
        JsonError = $jsonError
        StdErr   = $stdErr
        Args     = $arguments
    }
}

function Save-JsonSample {
    param(
        $Object,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    Ensure-OutputDir
    $path = Join-Path $script:OutputDir $FileName
    $text = ConvertTo-Json -InputObject $Object -Depth 12
    [System.IO.File]::WriteAllText($path, $text + "`n", (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

function Save-TextSample {
    param(
        [AllowEmptyString()][string]$Text,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    Ensure-OutputDir
    $path = Join-Path $script:OutputDir $FileName
    [System.IO.File]::WriteAllText($path, $Text + "`n", (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

function Get-ProcessIdsByName {
    param([Parameter(Mandatory = $true)][string]$Name)
    return @(Get-Process -Name $Name -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id })
}

function Get-NewProcessIds {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [int[]]$Baseline = @()
    )
    $baselineSet = @{}
    foreach ($baselineId in $Baseline) {
        $baselineSet[[int]$baselineId] = $true
    }
    return @(Get-Process -Name $Name -ErrorAction SilentlyContinue |
        Where-Object { -not $baselineSet.ContainsKey([int]$_.Id) } |
        ForEach-Object { [int]$_.Id })
}

function Stop-ProcessesNotIn {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [int[]]$Baseline = @()
    )
    $killed = New-Object System.Collections.ArrayList
    foreach ($processId in @(Get-NewProcessIds -Name $Name -Baseline $Baseline)) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            [void]$killed.Add($processId)
        } catch {
            Write-Output ('WARN cleanup: could not stop ' + $Name + ' pid=' + $processId + ' (' + $_.Exception.Message + ')')
        }
    }
    if ($killed.Count -gt 0) {
        Write-Output ('INFO cleanup: stopped ' + $Name + ' pids=' + ($killed -join ','))
    }
    return @($killed)
}

function Get-ScreenBounds {
    # The helper scripts are per-monitor-v2 DPI aware, so their bounds are physical pixels.
    # Make this test process DPI aware too, otherwise System.Windows.Forms reports DIPs
    # (e.g. 1536x864 instead of 1920x1080 at 125% scaling).
    try {
        if (-not [DshWinHelperTestNative]::SetProcessDpiAwarenessContext([IntPtr]-4)) {
            [void][DshWinHelperTestNative]::SetProcessDPIAware()
        }
    } catch {
        try { [void][DshWinHelperTestNative]::SetProcessDPIAware() } catch { }
    }
    Add-Type -AssemblyName System.Windows.Forms
    return [System.Windows.Forms.SystemInformation]::VirtualScreen
}

function Test-Number {
    param($Value)
    return (($Value -is [int]) -or ($Value -is [long]) -or ($Value -is [double]) -or ($Value -is [decimal]))
}

function Get-JsonPropertyNames {
    param($Object)
    if ($null -eq $Object) { return @() }
    return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}
