param(
  [int]$TimeoutSeconds = 30,
  [int]$ReturnGraceMs = 2000,
  [string]$OutDir = ''
)

if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $PSScriptRoot 'ui-check' }

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UiProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

function Get-ForegroundName {
  $handle = [UiProbe]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return '' }
  $owner = [uint32]0
  [void][UiProbe]::GetWindowThreadProcessId($handle, [ref]$owner)
  try { return (Get-Process -Id $owner -ErrorAction Stop).ProcessName } catch { return '' }
}

function Find-PopupElement([int]$processId) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $processId)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
}

function Save-Screen([string]$path) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
  $graphics.Dispose()
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  return $bitmap
}

function Measure-Region($bitmap, [int]$x, [int]$y, [int]$size) {
  $sumR = 0.0; $sumG = 0.0; $sumB = 0.0; $count = 0
  for ($dx = 0; $dx -lt $size; $dx++) {
    for ($dy = 0; $dy -lt $size; $dy++) {
      $px = $bitmap.GetPixel($x + $dx, $y + $dy)
      $sumR += $px.R; $sumG += $px.G; $sumB += $px.B; $count++
    }
  }
  return @{
    r = [math]::Round($sumR / $count, 1)
    g = [math]::Round($sumG / $count, 1)
    b = [math]::Round($sumB / $count, 1)
  }
}

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$tracePath = Join-Path $OutDir 'trace.log'
$payloadPath = Join-Path $OutDir 'payload.json'
$resultPath = Join-Path $OutDir 'result.json'
foreach ($stale in @($tracePath, $payloadPath, $resultPath)) {
  if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force }
}

$payload = @{
  windowTitle    = 'DSH notification'
  kicker         = 'DSH new reply'
  title          = 'Breathing dot probe'
  summary        = 'Checks the pulsing dot and the two second close after returning.'
  workspace      = 'dsh-plugins . <workspace>'
  viewLabel      = 'View'
  closeLabel     = 'Close'
  timeoutSeconds = $TimeoutSeconds
  focusProcess   = 'notepad'
  themeMode      = 'light'
  tracePath      = $tracePath
  resultPath     = $resultPath
  themes         = @{
    dark  = @{ bg = '#FF232324'; fg = '#FFF9FAFB'; muted = '#FFADB2B8'; border = '#FF35363A'; accent = '#FF5686FE' }
    light = @{ bg = '#FFFFFFFF'; fg = '#FF0F1115'; muted = '#FF61666B'; border = '#FFE4E7EC'; accent = '#FF4176E6' }
  }
}
$payload | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $payloadPath -Encoding UTF8

$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'popup.ps1'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$started = Get-Date
$popup = Start-Process -FilePath $shell -PassThru -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
  '-File', $scriptPath, '-PayloadPath', $payloadPath
)

$element = $null
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 120
  $element = Find-PopupElement $popup.Id
  if ($null -ne $element) { break }
}
if ($null -eq $element) {
  throw 'popup window was never found by UI Automation'
}

$rect = $element.Current.BoundingRectangle
$dotX = [int]($rect.X + 19 + 1)
$dotY = [int]($rect.Y + 16 + 1)

$samples = @()
$shots = @()
for ($i = 0; $i -lt 12; $i++) {
  $shotPath = Join-Path $OutDir ("frame{0:d2}.png" -f $i)
  $bitmap = Save-Screen $shotPath
  $samples += (Measure-Region $bitmap $dotX $dotY 6)
  $shotPath | Out-Null
  $bitmap.Dispose()
  Start-Sleep -Milliseconds 150
}

$mins = ($samples | ForEach-Object { $_.r + $_.g + $_.b })
$luma = $samples | ForEach-Object { [math]::Round(0.299 * $_.r + 0.587 * $_.g + 0.114 * $_.b, 1) }

# Bring notepad to the foreground the way a user would, then measure the close.
if (-not (Get-Process notepad -ErrorAction SilentlyContinue)) { Start-Process notepad | Out-Null }
$notepad = $null
$waitApp = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $waitApp) {
  $notepad = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -ne $notepad) { break }
  Start-Sleep -Milliseconds 150
}
if ($null -eq $notepad) { throw 'notepad window was never found' }

$wsh = New-Object -ComObject WScript.Shell
[void]$wsh.AppActivate($notepad.Id)
Start-Sleep -Milliseconds 250
if ((Get-ForegroundName) -ne 'notepad') {
  [void][UiProbe]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][UiProbe]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][UiProbe]::SetForegroundWindow($notepad.MainWindowHandle)
  Start-Sleep -Milliseconds 200
}
if ((Get-ForegroundName) -ne 'notepad') {
  [UiProbe]::SwitchToThisWindow($notepad.MainWindowHandle, $true)
  Start-Sleep -Milliseconds 300
}
$foregroundBefore = Get-ForegroundName
$switchedAt = Get-Date

$exited = $false
$closedAt = $null
$exitDeadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $exitDeadline) {
  if ($popup.HasExited) { $closedAt = Get-Date; $exited = $true; break }
  Start-Sleep -Milliseconds 100
}
if ($popup.HasExited -eq $false) { Stop-Process -Id $popup.Id -Force -ErrorAction SilentlyContinue }

$trace = @()
if (Test-Path -LiteralPath $tracePath) { $trace = Get-Content -LiteralPath $tracePath }
$result = ''
if (Test-Path -LiteralPath $resultPath) { $result = Get-Content -LiteralPath $resultPath -Raw }

$summary = [ordered]@{
  popupProcessId     = $popup.Id
  windowRect         = "$($rect.X),$($rect.Y) $($rect.Width)x$($rect.Height)"
  dotSamplePoint     = "$dotX,$dotY"
  dotLumaSeries      = ($luma -join ',')
  dotLumaMin         = ($luma | Measure-Object -Minimum).Minimum
  dotLumaMax         = ($luma | Measure-Object -Maximum).Maximum
  dotSamples         = ($samples | ForEach-Object { "$($_.r)/$($_.g)/$($_.b)" }) -join ' '
  foregroundBefore   = $foregroundBefore
  switchedAt         = $switchedAt.ToString('HH:mm:ss.fff')
  exited             = $exited
  closeAfterMs       = if ($null -ne $closedAt) { [int]($closedAt - $switchedAt).TotalMilliseconds } else { -1 }
  trace              = $trace
  resultJson         = $result.Trim()
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir 'report.json') -Encoding UTF8
$summary | ConvertTo-Json -Depth 4
