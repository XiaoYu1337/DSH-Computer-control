#requires -Version 5.1
# uia-find-text.ps1 - Find UI Automation elements by visible Name text.
#
# Usage:
#   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File uia-find-text.ps1
#       -Query <text> [-Match contains|exact] [-WindowTitle <regex>] [-MaxResults 20]
#
# stdout: exactly one JSON object (UTF-8, no BOM), then exit 0 (ok:true) or 1 (ok:false).
# stderr: diagnostics only.
#
# Success:
#   {"ok":true,"source":"uia","matches":[
#     {"name":"插件","controlType":"Button","className":"...","automationId":"...",
#      "x":1,"y":2,"w":3,"h":4,"enabled":true}]}
#   No matches is still success: {"ok":true,"source":"uia","matches":[]}
#
# Failure:
#   {"ok":false,"code":"invalid_args|invalid_regex|uia_unavailable|uia_error","message":"..."}
#
# Notes:
#   * Searches descendants of the top-level window(s) whose title matches -WindowTitle.
#     Without -WindowTitle it searches descendants of every top-level UIA window.
#   * Name matching is case-insensitive (OrdinalIgnoreCase).
#   * Bounds are physical screen pixels (per-monitor-v2 DPI awareness is requested before
#     any UIA call). UIA may report an empty rect (0,0,0,0) for offscreen/virtual nodes.
#   * Browsers (Edge/Chromium) only expose their DOM through UIA when accessibility is
#     enabled; Win32/WinForms/WPF/XAML/Electron apps expose their control tree normally.

param(
    [string]$Query = '',
    [ValidateSet('contains', 'exact')][string]$Match = 'contains',
    [string]$WindowTitle = '',
    [ValidateRange(1, 500)][int]$MaxResults = 20
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
        $script:Stderr.WriteLine(('uia-find-text: ' + $Message))
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
        $script:Stdout.WriteLine('{"ok":false,"code":"uia_error","message":"JSON serialization failed"}')
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

if ([string]::IsNullOrWhiteSpace($Query)) {
    Fail 'invalid_args' '-Query <text> is required.'
}

$titleRegex = $null
if (-not [string]::IsNullOrWhiteSpace($WindowTitle)) {
    try {
        $titleRegex = New-Object System.Text.RegularExpressions.Regex(
            $WindowTitle,
            [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
        )
    } catch {
        Fail 'invalid_regex' ('-WindowTitle is not a valid .NET regex: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# DPI awareness (physical pixels) + UIAutomation assemblies
# ---------------------------------------------------------------------------
$nativeSource = @"
using System;
using System.Runtime.InteropServices;

public static class DshUiaFindTextNative
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDPIAware();
}
"@

try {
    Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null
    $dpiMode = 'unknown'
    try {
        if ([DshUiaFindTextNative]::SetProcessDpiAwarenessContext([IntPtr]-4)) {
            $dpiMode = 'per-monitor-v2'
        }
    } catch {
        $dpiMode = 'unknown'
    }
    if ($dpiMode -eq 'unknown') {
        try {
            if ([DshUiaFindTextNative]::SetProcessDPIAware()) {
                $dpiMode = 'system'
            }
        } catch {
            $dpiMode = 'unavailable'
        }
    }
    Write-Diag ('dpiAware=' + $dpiMode)
} catch {
    Write-Diag ('DPI helper unavailable, continuing: ' + $_.Exception.Message)
}

try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
} catch {
    Fail 'uia_unavailable' ('UI Automation client assemblies are not available: ' + $_.Exception.Message)
}

try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
} catch {
    Fail 'uia_unavailable' ('Could not access the UI Automation root element: ' + $_.Exception.Message)
}

$trueCondition = [System.Windows.Automation.Condition]::TrueCondition
$treeScopeChildren = [System.Windows.Automation.TreeScope]::Children
$treeScopeDescendants = [System.Windows.Automation.TreeScope]::Descendants

# ---------------------------------------------------------------------------
# Enumerate candidate top-level windows
# ---------------------------------------------------------------------------
$candidateWindows = New-Object System.Collections.ArrayList
$allTopLevelCount = 0

try {
    $topLevelWindows = $root.FindAll($treeScopeChildren, $trueCondition)
    $allTopLevelCount = $topLevelWindows.Count
    foreach ($window in $topLevelWindows) {
        try {
            $windowName = [string]$window.Current.Name
        } catch {
            continue
        }
        if ($titleRegex -and -not $titleRegex.IsMatch($windowName)) {
            continue
        }
        [void]$candidateWindows.Add($window)
    }
} catch {
    Fail 'uia_error' ('Failed to enumerate top-level windows: ' + $_.Exception.Message)
}

Write-Diag ('topLevelWindows=' + $allTopLevelCount + ' candidateWindows=' + $candidateWindows.Count + ' query=' + $Query)

if ($candidateWindows.Count -eq 0) {
    Write-JsonResult ([ordered]@{
        ok      = $true
        source  = 'uia'
        matches = @()
    }) 0
}

# ---------------------------------------------------------------------------
# Search descendants
# ---------------------------------------------------------------------------
$matches = New-Object System.Collections.ArrayList
$scannedElements = 0
$scannedWindows = 0
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($window in $candidateWindows) {
    if ($matches.Count -ge $MaxResults) { break }
    $scannedWindows++
    try {
        $elements = $window.FindAll($treeScopeDescendants, $trueCondition)
    } catch {
        Write-Diag ('FindAll failed for a top-level window: ' + $_.Exception.Message)
        continue
    }

    foreach ($element in $elements) {
        if ($matches.Count -ge $MaxResults) { break }
        $scannedElements++
        try {
            $name = [string]$element.Current.Name
        } catch {
            # Element went away while enumerating (common with dynamic UIs).
            continue
        }
        if ([string]::IsNullOrEmpty($name)) { continue }

        if ($Match -eq 'exact') {
            $hit = [string]::Equals($name, $Query, [System.StringComparison]::OrdinalIgnoreCase)
        } else {
            $hit = $name.IndexOf($Query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        }
        if (-not $hit) { continue }

        $controlType = ''
        try {
            $controlType = ([string]$element.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        } catch { }

        $className = ''
        try { $className = [string]$element.Current.ClassName } catch { }

        $automationId = ''
        try { $automationId = [string]$element.Current.AutomationId } catch { }

        $enabled = $true
        try { $enabled = [bool]$element.Current.IsEnabled } catch { }

        $x = 0
        $y = 0
        $w = 0
        $h = 0
        try {
            $rect = $element.Current.BoundingRectangle
            if (-not $rect.IsEmpty) {
                $x = [int][Math]::Round($rect.X)
                $y = [int][Math]::Round($rect.Y)
                $w = [int][Math]::Round($rect.Width)
                $h = [int][Math]::Round($rect.Height)
                if ($w -lt 0) { $w = 0 }
                if ($h -lt 0) { $h = 0 }
            }
        } catch { }

        [void]$matches.Add([ordered]@{
            name         = $name
            controlType  = $controlType
            className    = $className
            automationId = $automationId
            x            = $x
            y            = $y
            w            = $w
            h            = $h
            enabled      = $enabled
        })
    }
}

$stopwatch.Stop()
Write-Diag ('scannedWindows=' + $scannedWindows + ' scannedElements=' + $scannedElements + ' matches=' + $matches.Count + ' elapsedMs=' + $stopwatch.ElapsedMilliseconds)

Write-JsonResult ([ordered]@{
    ok      = $true
    source  = 'uia'
    matches = @($matches)
}) 0
