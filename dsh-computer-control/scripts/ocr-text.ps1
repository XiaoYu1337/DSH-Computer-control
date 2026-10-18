#requires -Version 5.1
# ocr-text.ps1 - OCR a PNG with Windows.Media.Ocr (WinRT) from Windows PowerShell 5.1.
#
# Usage:
#   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File ocr-text.ps1 -Path <png> [-Language <bcp47>]
#
# stdout: exactly one JSON object (UTF-8, no BOM), then exit 0 (ok:true) or 1 (ok:false).
# stderr: diagnostics and error detail only.
#
# Success:
#   {"ok":true,"engine":"Windows.Media.Ocr","language":"zh-Hans-CN","width":1920,"height":1080,
#    "words":[{"text":"...","x":1,"y":2,"w":3,"h":4,"confidence":null}],
#    "lines":[{"text":"...","x":1,"y":2,"w":3,"h":4}],
#    "elapsedMs":123}
#
# Failure:
#   {"ok":false,"code":"ocr_unavailable|file_not_found|invalid_args|image_too_large|ocr_error","message":"..."}
#
# Notes:
#   * Bounding boxes are image pixels (physical pixels of the decoded PNG).
#   * Windows.Media.Ocr.OcrWord on current Windows builds only exposes Text + BoundingRect;
#     there is no per-word confidence, so "confidence" is emitted as null (schema-stable).
#   * Engine selection: requested -Language -> user profile languages -> en-US -> zh-Hans ->
#     any installed recognizer language. "language" reports the language actually used.

param(
    [string]$Path = '',
    [string]$Language = ''
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
        $script:Stderr.WriteLine(('ocr-text: ' + $Message))
    } catch {
        # Diagnostics must never prevent the JSON response.
    }
}

function Write-JsonResult($Object, [int]$ExitCode) {
    try {
        $json = ConvertTo-Json -InputObject $Object -Depth 12 -Compress
        $script:Stdout.WriteLine($json)
        $script:Stdout.Flush()
    } catch {
        # Last-resort literal JSON (should not happen).
        $script:Stdout.WriteLine('{"ok":false,"code":"ocr_error","message":"JSON serialization failed"}')
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

# ---------------------------------------------------------------------------
# Argument / path validation
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Path)) {
    Fail 'invalid_args' '-Path <png> is required.'
}

try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
} catch {
    Fail 'file_not_found' ('Invalid path: ' + $Path)
}

if (-not [System.IO.File]::Exists($fullPath)) {
    Fail 'file_not_found' ('Image file not found: ' + $fullPath)
}

# ---------------------------------------------------------------------------
# WinRT projection setup (Windows.Media.Ocr)
# ---------------------------------------------------------------------------
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
} catch {
    Fail 'ocr_unavailable' ('Windows.Media.Ocr WinRT projection is not available: ' + $_.Exception.Message)
}

$script:AsTaskMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1)

if (-not $script:AsTaskMethod) {
    Fail 'ocr_unavailable' 'System.Runtime.WindowsRuntime AsTask(IAsyncOperation<T>) helper was not found.'
}

function Await-WinRtOperation($Operation, [Type]$ResultType) {
    $generic = $script:AsTaskMethod.MakeGenericMethod($ResultType)
    $task = $generic.Invoke($null, @($Operation))
    [void]$task.Wait(-1)
    return $task.Result
}

function New-OcrEngine([string]$RequestedLanguage) {
    $engine = $null

    if (-not [string]::IsNullOrWhiteSpace($RequestedLanguage)) {
        try {
            $lang = New-Object Windows.Globalization.Language($RequestedLanguage.Trim())
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
        } catch {
            Write-Diag ('Requested language could not be constructed: ' + $RequestedLanguage + ' (' + $_.Exception.Message + ')')
        }
        if (-not $engine) {
            Write-Diag ('Requested language is not installed: ' + $RequestedLanguage + '; falling back.')
        }
    }

    if (-not $engine) {
        try {
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        } catch {
            Write-Diag ('TryCreateFromUserProfileLanguages failed: ' + $_.Exception.Message)
        }
    }

    if (-not $engine) {
        foreach ($tag in @('en-US', 'zh-Hans')) {
            try {
                $lang = New-Object Windows.Globalization.Language($tag)
                $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
            } catch {
                $engine = $null
            }
            if ($engine) { break }
        }
    }

    if (-not $engine) {
        try {
            $languages = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
            foreach ($language in $languages) {
                try {
                    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
                } catch {
                    $engine = $null
                }
                if ($engine) { break }
            }
        } catch {
            Write-Diag ('AvailableRecognizerLanguages failed: ' + $_.Exception.Message)
        }
    }

    return $engine
}

$engine = New-OcrEngine $Language
if (-not $engine) {
    Fail 'ocr_unavailable' 'No Windows.Media.Ocr recognizer is available (no OCR language pack installed or OCR disabled by policy).'
}

$engineLanguage = ''
try {
    $engineLanguage = [string]$engine.RecognizerLanguage.LanguageTag
} catch {
    Write-Diag ('Could not read recognizer language: ' + $_.Exception.Message)
}
Write-Diag ('engine=' + $engineLanguage + ' requested=' + $Language)

# ---------------------------------------------------------------------------
# Decode + recognize
# ---------------------------------------------------------------------------
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$stream = $null
$softwareBitmap = $null
$ocrResult = $null
$imageWidth = 0
$imageHeight = 0

try {
    $storageFile = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRtOperation ($storageFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $imageWidth = [int]$decoder.PixelWidth
    $imageHeight = [int]$decoder.PixelHeight

    $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($imageWidth -gt $maxDimension -or $imageHeight -gt $maxDimension) {
        Fail 'image_too_large' ("Image is {0}x{1}; Windows.Media.Ocr supports up to {2}x{2} pixels." -f $imageWidth, $imageHeight, $maxDimension)
    }

    $softwareBitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocrResult = Await-WinRtOperation ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
    Fail 'ocr_error' ('OCR failed: ' + $_.Exception.Message)
} finally {
    if ($softwareBitmap) {
        try { $softwareBitmap.Dispose() } catch { }
    }
    if ($stream) {
        try { $stream.Dispose() } catch { }
    }
}

# ---------------------------------------------------------------------------
# Shape the result
# ---------------------------------------------------------------------------
$words = New-Object System.Collections.ArrayList
$lines = New-Object System.Collections.ArrayList

try {
    foreach ($line in $ocrResult.Lines) {
        $minX = [double]::MaxValue
        $minY = [double]::MaxValue
        $maxX = [double]::MinValue
        $maxY = [double]::MinValue
        $lineWordCount = 0

        foreach ($word in $line.Words) {
            $rect = $word.BoundingRect
            $wordX = [int][Math]::Round($rect.X)
            $wordY = [int][Math]::Round($rect.Y)
            $wordW = [int][Math]::Round($rect.Width)
            $wordH = [int][Math]::Round($rect.Height)
            if ($wordW -lt 0) { $wordW = 0 }
            if ($wordH -lt 0) { $wordH = 0 }

            $confidence = $null
            try {
                $property = $word.PSObject.Properties['Confidence']
                if ($property) {
                    $confidence = [double]$property.Value
                } else {
                    $reflected = $word.GetType().GetProperty('Confidence')
                    if ($reflected) {
                        $confidence = [double]$reflected.GetValue($word, $null)
                    }
                }
            } catch {
                $confidence = $null
            }

            [void]$words.Add([ordered]@{
                text       = [string]$word.Text
                x          = $wordX
                y          = $wordY
                w          = $wordW
                h          = $wordH
                confidence = $confidence
            })

            if ($rect.X -lt $minX) { $minX = $rect.X }
            if ($rect.Y -lt $minY) { $minY = $rect.Y }
            if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
            if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
            $lineWordCount++
        }

        if ($lineWordCount -gt 0) {
            $lineX = [int][Math]::Round($minX)
            $lineY = [int][Math]::Round($minY)
            $lineW = [int][Math]::Round($maxX - $minX)
            $lineH = [int][Math]::Round($maxY - $minY)
            if ($lineW -lt 0) { $lineW = 0 }
            if ($lineH -lt 0) { $lineH = 0 }
            [void]$lines.Add([ordered]@{
                text = [string]$line.Text
                x    = $lineX
                y    = $lineY
                w    = $lineW
                h    = $lineH
            })
        }
    }
} catch {
    Fail 'ocr_error' ('Failed to shape OCR result: ' + $_.Exception.Message)
}

$stopwatch.Stop()
Write-Diag ('words=' + $words.Count + ' lines=' + $lines.Count + ' elapsedMs=' + $stopwatch.ElapsedMilliseconds)

Write-JsonResult ([ordered]@{
    ok        = $true
    engine    = 'Windows.Media.Ocr'
    language  = $engineLanguage
    width     = $imageWidth
    height    = $imageHeight
    words     = @($words)
    lines     = @($lines)
    elapsedMs = [int]$stopwatch.ElapsedMilliseconds
}) 0
