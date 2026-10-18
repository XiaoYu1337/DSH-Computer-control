#requires -Version 5.1
# test-uia.ps1 - End-to-end test for dsh-computer-control/scripts/uia-find-text.ps1.
#
# Searches the live DeepSeek Harness (Electron/Chromium) window through UI Automation:
#   * "插件" (Button) in contains and exact modes
#   * "新建会话" (Button)
#   * empty results and non-matching -WindowTitle (still ok:true)
#   * invalid regex / missing Query error envelopes
#
# Prints PASS/FAIL lines; exit code 0 only when every assertion passed.

$ErrorActionPreference = 'Stop'
$script:TestRoot = $PSScriptRoot
. (Join-Path $PSScriptRoot '_common.ps1')
Ensure-OutputDir

$uiaHelper = Join-Path $script:HelperDir 'uia-find-text.ps1'
$dshWindowPattern = 'DeepSeek Harness'
$screen = Get-ScreenBounds

Write-Output ('INFO uia helper: ' + $uiaHelper)
Write-Output ('INFO screen: ' + $screen.Width + 'x' + $screen.Height + ' at ' + $screen.X + ',' + $screen.Y)

function Test-UiaMatchSchema {
    param($Matches)
    $schemaOk = $true
    foreach ($match in $Matches) {
        $names = Get-JsonPropertyNames $match
        foreach ($requiredName in @('name', 'controlType', 'className', 'automationId', 'x', 'y', 'w', 'h', 'enabled')) {
            if ($names -notcontains $requiredName) { $schemaOk = $false }
        }
        if (-not (Test-Number $match.x) -or -not (Test-Number $match.y) -or -not (Test-Number $match.w) -or -not (Test-Number $match.h)) {
            $schemaOk = $false
        }
        if ($match.enabled -isnot [bool]) {
            $schemaOk = $false
        }
    }
    return $schemaOk
}

try {
    # ------------------------------------------------------------------
    # 1. DSH UI: find "插件" (contains, default 20 results)
    # ------------------------------------------------------------------
    $contains = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = '插件'
        Match       = 'contains'
        WindowTitle = $dshWindowPattern
        MaxResults  = '20'
    } -Tag 'dsh-plugins'
    Assert-That ($contains.ExitCode -eq 0 -and $null -ne $contains.Json -and [string]::IsNullOrEmpty($contains.JsonError) -and $contains.Json.ok -eq $true) `
        'uia:contains-json-valid' ('exit=' + $contains.ExitCode + ' json=' + $contains.JsonText)

    $matches = @()
    if ($null -ne $contains.Json) {
        $matches = @($contains.Json.matches)
    }
    Assert-That ($contains.Json.source -eq 'uia') 'uia:source-uia' ([string]$contains.Json.source)
    Assert-That ($matches.Count -gt 0) 'uia:contains-has-matches' ('matches=' + $matches.Count)

    $pluginButton = $matches | Where-Object {
        ([string]$_.name) -eq '插件' -and ([string]$_.controlType) -eq 'Button'
    } | Select-Object -First 1
    Assert-That ($null -ne $pluginButton) 'uia:plugin-button-found' ('names: ' + (($matches | ForEach-Object { $_.name }) -join ' | '))
    Assert-That (Test-UiaMatchSchema $matches) 'uia:match-schema' 'each match needs name/controlType/className/automationId/x/y/w/h/enabled'

    # UIA also reports virtualized descendants of scrolled-away conversation history
    # (large negative Y). Only the visible hit has to fit the physical desktop; every
    # rect must still be numeric (checked by Test-UiaMatchSchema).
    $pluginBoundsText = 'plugin button missing'
    $boundsOk = $false
    if ($null -ne $pluginButton) {
        $boxX = [int]$pluginButton.x
        $boxY = [int]$pluginButton.y
        $boxW = [int]$pluginButton.w
        $boxH = [int]$pluginButton.h
        $pluginBoundsText = ($boxX.ToString() + ',' + $boxY.ToString() + ' ' + $boxW.ToString() + 'x' + $boxH.ToString())
        $boundsOk = ($boxW -gt 0) -and ($boxH -gt 0) -and
            ($boxX -ge $screen.X) -and ($boxY -ge $screen.Y) -and
            (($boxX + $boxW) -le ($screen.X + $screen.Width)) -and
            (($boxY + $boxH) -le ($screen.Y + $screen.Height))
    }
    $offscreenCount = @($matches | Where-Object {
        ([int]$_.x -lt $screen.X) -or ([int]$_.y -lt $screen.Y) -or
        (([int]$_.x + [int]$_.w) -gt ($screen.X + $screen.Width)) -or
        (([int]$_.y + [int]$_.h) -gt ($screen.Y + $screen.Height))
    }).Count
    Assert-That $boundsOk 'uia:bounds-physical-pixels' ('plugin button rect: ' + $pluginBoundsText + '; screen: ' + $screen.Width + 'x' + $screen.Height)
    Write-Output ('INFO uia on-screen matches: ' + ($matches.Count - $offscreenCount) + '/' + $matches.Count +
        ' (offscreen/virtualized descendants are expected for scrolled-away content)')
    Save-JsonSample $contains.Json 'uia-dsh-plugins.json' | Out-Null

    # ------------------------------------------------------------------
    # 2. Exact match mode
    # ------------------------------------------------------------------
    $exact = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = '插件'
        Match       = 'exact'
        WindowTitle = $dshWindowPattern
        MaxResults  = '20'
    } -Tag 'dsh-plugin-exact'
    $exactMatches = @()
    if ($null -ne $exact.Json) { $exactMatches = @($exact.Json.matches) }
    Assert-That ($exact.ExitCode -eq 0 -and $exact.Json.ok -eq $true -and $exactMatches.Count -gt 0) `
        'uia:exact-has-matches' ('matches=' + $exactMatches.Count)
    $exactNamesOk = $true
    foreach ($match in $exactMatches) {
        if (([string]$match.name) -ne '插件') { $exactNamesOk = $false }
    }
    Assert-That $exactNamesOk 'uia:exact-names' 'exact mode must only return elements named 插件'
    Save-JsonSample $exact.Json 'uia-dsh-plugin-exact.json' | Out-Null

    # ------------------------------------------------------------------
    # 3. "新建会话" (actual DSH label; the brief's "新会话" is not a real label)
    # ------------------------------------------------------------------
    $newSession = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = '新建会话'
        WindowTitle = $dshWindowPattern
        MaxResults  = '10'
    } -Tag 'dsh-new-session'
    $newSessionMatches = @()
    if ($null -ne $newSession.Json) { $newSessionMatches = @($newSession.Json.matches) }
    $newSessionHit = $newSessionMatches | Where-Object {
        ([string]$_.name).IndexOf('新建会话', [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } | Select-Object -First 1
    Assert-That ($newSession.ExitCode -eq 0 -and $null -ne $newSessionHit) 'uia:new-session-found' `
        ('names: ' + (($newSessionMatches | ForEach-Object { $_.name }) -join ' | '))

    # ------------------------------------------------------------------
    # 4. Empty results are success (no matching text / no matching window)
    # ------------------------------------------------------------------
    $empty = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = 'dsh_no_such_text_4399'
        WindowTitle = $dshWindowPattern
    } -Tag 'dsh-empty'
    $emptyMatches = @()
    if ($null -ne $empty.Json) { $emptyMatches = @($empty.Json.matches) }
    Assert-That ($empty.ExitCode -eq 0 -and $empty.Json.ok -eq $true -and $emptyMatches.Count -eq 0) `
        'uia:empty-is-ok' ('exit=' + $empty.ExitCode + ' json=' + $empty.JsonText)
    Save-JsonSample $empty.Json 'uia-empty.json' | Out-Null

    $noWindow = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = '插件'
        WindowTitle = 'dsh_no_such_window_4399'
    } -Tag 'no-window'
    $noWindowMatches = @()
    if ($null -ne $noWindow.Json) { $noWindowMatches = @($noWindow.Json.matches) }
    Assert-That ($noWindow.ExitCode -eq 0 -and $noWindow.Json.ok -eq $true -and $noWindowMatches.Count -eq 0) `
        'uia:no-window-is-ok' ('exit=' + $noWindow.ExitCode + ' json=' + $noWindow.JsonText)

    # ------------------------------------------------------------------
    # 5. Global search across all top-level windows (no -WindowTitle)
    # ------------------------------------------------------------------
    $global = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query      = '插件'
        MaxResults = '3'
    } -Tag 'global'
    $globalMatches = @()
    if ($null -ne $global.Json) { $globalMatches = @($global.Json.matches) }
    Assert-That ($global.ExitCode -eq 0 -and $global.Json.ok -eq $true -and $globalMatches.Count -gt 0) `
        'uia:global-search' ('matches=' + $globalMatches.Count)
    Save-JsonSample $global.Json 'uia-global-plugins.json' | Out-Null

    # ------------------------------------------------------------------
    # 6. Error envelopes
    # ------------------------------------------------------------------
    $badRegex = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = '插件'
        WindowTitle = '['
    } -Tag 'bad-regex'
    Assert-That ($badRegex.ExitCode -eq 1 -and $null -ne $badRegex.Json -and $badRegex.Json.code -eq 'invalid_regex') `
        'uia:invalid-regex' ('exit=' + $badRegex.ExitCode + ' json=' + $badRegex.JsonText)

    $noArgs = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{} -Tag 'noargs'
    Assert-That ($noArgs.ExitCode -eq 1 -and $null -ne $noArgs.Json -and $noArgs.Json.code -eq 'invalid_args') `
        'uia:invalid-args' ('exit=' + $noArgs.ExitCode + ' json=' + $noArgs.JsonText)

    $exactEmpty = Invoke-HelperJson -ScriptPath $uiaHelper -Parameters @{
        Query       = 'dsh_no_such_text_4399'
        Match       = 'exact'
        WindowTitle = $dshWindowPattern
    } -Tag 'exact-empty'
    Assert-That ($exactEmpty.ExitCode -eq 0 -and $exactEmpty.Json.ok -eq $true -and @($exactEmpty.Json.matches).Count -eq 0) `
        'uia:exact-empty-is-ok'
} catch {
    Write-Fail 'uia:unexpected-exception' $_.Exception.Message
}

Write-TestSummary 'uia'
if ((Get-TestFailCount) -gt 0) { exit 1 } else { exit 0 }
