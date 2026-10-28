param([string]$PayloadPath)

# Right-corner DSH reply popup.
#
# This script is a one-shot helper: the Host half starts it with a JSON payload
# whenever a turn finishes, and it either exits immediately (the user is still
# in the DSH window) or shows a small always-on-top card for a few seconds.
#
# While the card is up, the Host may replace its copy (a newer reply replaces the
# visible one) or ask it to fold for a priority request; both arrive through a
# small JSON control file polled below.
#
# The file must stay pure ASCII: Windows PowerShell 5.1 reads scripts with the
# system ANSI code page, so non-ASCII literals here would be mangled. All copy
# arrives through the UTF-8 JSON payload instead.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshNotifyNative {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Pick($value, $fallback) {
  if ($null -ne $value -and "$value" -ne '') { return "$value" }
  return $fallback
}

$payload = $null
try {
  $payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  exit 1
}

$outPath = Pick $payload.resultPath ''
$tracePath = Pick $payload.tracePath ''
# The Host writes replacements and close requests here while the card is up.
$controlPath = Pick $payload.controlPath ''

# Optional breadcrumb file, used while diagnosing the helper on a live machine.
function Trace([string]$message) {
  if ($tracePath -eq '') { return }
  try {
    $line = (Get-Date).ToString('HH:mm:ss.fff') + ' ' + $message + [Environment]::NewLine
    [System.IO.File]::AppendAllText($tracePath, $line, [System.Text.Encoding]::UTF8)
  } catch { }
}

Trace 'start'

function Write-Result([string]$result, [bool]$focused) {
  if ($outPath -eq '') { return }
  try {
    $record = @{ result = $result; at = (Get-Date).ToString('o'); focused = $focused }
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $outPath -Encoding UTF8
  } catch { }
}

function Get-ForegroundProcessName {
  $handle = [DshNotifyNative]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { return '' }
  $procId = [uint32]0
  [void][DshNotifyNative]::GetWindowThreadProcessId($handle, [ref]$procId)
  if ($procId -eq 0) { return '' }
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

$focusProcess = Pick $payload.focusProcess 'DeepSeek Harness'
# The app binary, used only when no DSH process exists at all.
$focusExe = Pick $payload.focusExe ''

# The point of the whole bundle: notify only while the user is away from DSH.
# "Always notify" and the settings page's test card turn this check off.
$skipWhenFocused = $true
if ($null -ne $payload.skipWhenFocused) { $skipWhenFocused = [bool]$payload.skipWhenFocused }
$foreground = Get-ForegroundProcessName
Trace ('foreground=' + $foreground)
if ($skipWhenFocused -and $foreground -ne '' -and $foreground -eq $focusProcess) {
  Trace 'skip: dsh focused'
  Write-Result 'dsh-focused' $false
  exit 0
}

# A real card folds itself three seconds after DSH comes back to the foreground,
# in both reminder modes. "Returned" only means something when DSH was in the
# background when the card appeared: a card shown while DSH is already in front
# keeps its focused delay, or it would close almost immediately. The test card
# opts out entirely.
$watchReturn = $true
if ($null -ne $payload.watchReturn) { $watchReturn = [bool]$payload.watchReturn }
$dshWasFocused = $foreground -ne '' -and $foreground -eq $focusProcess

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

function Brush([string]$hex) {
  $color = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
  $brush = New-Object System.Windows.Media.SolidColorBrush($color)
  $brush.Freeze()
  return $brush
}

# Theme: payload carries both palettes, the mode picks one. "auto" asks Windows,
# which is also what DSH follows by default.
$mode = Pick $payload.themeMode 'auto'
$dark = $true
if ($mode -eq 'light') {
  $dark = $false
} elseif ($mode -eq 'dark') {
  $dark = $true
} else {
  try {
    $personalize = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction Stop
    if ($personalize.AppsUseLightTheme -eq 1) { $dark = $false }
  } catch {
    $dark = $true
  }
}

$themePalette = $payload.themes.dark
if (-not $dark) { $themePalette = $payload.themes.light }

$bg           = Pick $themePalette.bg           '#FF232324'
$fg           = Pick $themePalette.fg           '#FFF9FAFB'
$muted        = Pick $themePalette.muted        '#FFADB2B8'
$border       = Pick $themePalette.border       '#FF35363A'
$accent       = Pick $themePalette.accent       '#FF5686FE'
$primaryBg    = Pick $themePalette.primaryBg    '#FFF9FAFB'
$primaryFg    = Pick $themePalette.primaryFg    '#FF151517'
$primaryHover = Pick $themePalette.primaryHover '#FFE7E8EB'
$ghostHover   = Pick $themePalette.ghostHover   '#14FFFFFF'

# The settings page can pin the blinking dot to one color. It arrives as a plain
# #RRGGBB, so promote it to an opaque ARGB brush; anything else keeps the accent.
$dotColor = [string](Pick $payload.dotColor '')
if ($dotColor -match '^#[0-9a-fA-F]{6}$') {
  $dotAccent = '#FF' + $dotColor.Substring(1)
} else {
  $dotAccent = $accent
}

# The settings page picks the accent: a top bar (default) or a dot beside the
# kicker. Both breathe with the same colour.
$indicator = [string](Pick $payload.indicator 'bar')
if ($indicator -ne 'dot') { $indicator = 'bar' }

function New-FlatTemplate([string]$hoverColor) {
  $xaml = @"
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                 TargetType="{x:Type Button}">
  <Border x:Name="Chrome" Background="{TemplateBinding Background}" CornerRadius="9"
          Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True">
      <Setter TargetName="Chrome" Property="Background" Value="$hoverColor" />
    </Trigger>
    <Trigger Property="IsPressed" Value="True">
      <Setter TargetName="Chrome" Property="Opacity" Value="0.82" />
    </Trigger>
    <Trigger Property="IsEnabled" Value="False">
      <Setter TargetName="Chrome" Property="Opacity" Value="0.45" />
    </Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
"@
  $reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
  return [System.Windows.Markup.XamlReader]::Load($reader)
}

function New-FlatButton([string]$text, [string]$background, [string]$foreground, [string]$hoverColor) {
  $button = New-Object System.Windows.Controls.Button
  $button.Content = $text
  $button.FontSize = 12
  $button.Padding = New-Object System.Windows.Thickness(14, 6, 14, 6)
  $button.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.BorderThickness = New-Object System.Windows.Thickness(0)
  $button.Background = Brush $background
  $button.Foreground = Brush $foreground
  $button.Template = New-FlatTemplate $hoverColor
  return $button
}

$themeName = 'light'
if ($dark) { $themeName = 'dark' }
Trace ('theme=' + $themeName)
$window = New-Object System.Windows.Window
$window.Title = Pick $payload.windowTitle 'DSH notification'
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.ShowInTaskbar = $false
$window.Topmost = $true
# A notification must never pull keyboard focus away from whatever the person is
# typing in. Without this, WPF activates the card the moment it is shown.
$window.ShowActivated = $false
$window.ResizeMode = 'NoResize'
$window.SizeToContent = 'Height'
$window.Width = 384
$window.FontFamily = 'Segoe UI, Microsoft YaHei UI'

$card = New-Object System.Windows.Controls.Border
$card.CornerRadius = New-Object System.Windows.CornerRadius(14)
$card.Background = Brush $bg
$card.BorderBrush = Brush $border
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Object System.Windows.Thickness(0)
$window.Content = $card

# The accent indicator breathes: a long, centered bar on the top edge by
# default, or a dot beside the kicker. Only its opacity animates, never the
# text, so the copy stays legible.
$bar = $null
$accentElement = $null
if ($indicator -eq 'dot') {
  $dot = New-Object System.Windows.Controls.Border
  $dot.Width = 12
  $dot.Height = 12
  $dot.CornerRadius = New-Object System.Windows.CornerRadius(6)
  $dot.Background = Brush $dotAccent
  $dot.Margin = New-Object System.Windows.Thickness(0, 2, 9, 0)
  $dot.VerticalAlignment = 'Center'
  $accentElement = $dot
} else {
  $bar = New-Object System.Windows.Controls.Border
  $bar.Width = 220
  $bar.Height = 6
  $bar.CornerRadius = New-Object System.Windows.CornerRadius(3)
  $bar.Margin = New-Object System.Windows.Thickness(0, 3, 0, 0)
  $bar.Background = Brush $dotAccent
  $bar.HorizontalAlignment = 'Center'
  $bar.VerticalAlignment = 'Top'
  $accentElement = $bar
}

$pulse = New-Object System.Windows.Media.Animation.DoubleAnimation
$pulse.From = 0.35
$pulse.To = 1.0
$pulse.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds(0.9))
$pulse.AutoReverse = $true
$pulse.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
$pulseEase = New-Object System.Windows.Media.Animation.QuadraticEase
$pulseEase.EasingMode = 'EaseInOut'
$pulse.EasingFunction = $pulseEase
$pulseStory = New-Object System.Windows.Media.Animation.Storyboard
[void]$pulseStory.Children.Add($pulse)
[System.Windows.Media.Animation.Storyboard]::SetTarget($pulse, $accentElement)
[System.Windows.Media.Animation.Storyboard]::SetTargetProperty($pulse, [System.Windows.PropertyPath]::new('Opacity'))

# The summary body owns every pixel that the 30% taller card adds: the star
# row in this grid absorbs whatever the fixed-height card leaves over.
$content = New-Object System.Windows.Controls.Grid
$content.Margin = New-Object System.Windows.Thickness(18, 14, 18, 10)
for ($row = 0; $row -lt 6; $row++) {
  $definition = New-Object System.Windows.Controls.RowDefinition
  if ($row -eq 2) {
    $definition.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
  } else {
    $definition.Height = [System.Windows.GridLength]::Auto
  }
  [void]$content.RowDefinitions.Add($definition)
}

$head = New-Object System.Windows.Controls.StackPanel
$head.Orientation = 'Horizontal'
if ($indicator -eq 'dot') { [void]$head.Children.Add($dot) }

$kicker = New-Object System.Windows.Controls.TextBlock
$kicker.Text = Pick $payload.kicker 'DSH'
$kicker.FontSize = 12
$kicker.FontWeight = 'SemiBold'
$kicker.Foreground = Brush $muted
$kicker.VerticalAlignment = 'Center'
[void]$head.Children.Add($kicker)
[void]$content.Children.Add($head)
[System.Windows.Controls.Grid]::SetRow($head, 0)

$title = New-Object System.Windows.Controls.TextBlock
$title.Text = Pick $payload.title 'Session'
$title.FontSize = 15
$title.FontWeight = 'SemiBold'
$title.Foreground = Brush $fg
$title.TextWrapping = 'Wrap'
$title.Margin = New-Object System.Windows.Thickness(0, 8, 0, 0)
$title.MaxHeight = 44
[void]$content.Children.Add($title)
[System.Windows.Controls.Grid]::SetRow($title, 1)

$body = New-Object System.Windows.Controls.TextBlock
$body.Text = Pick $payload.summary ''
$body.FontSize = 12.5
$body.Foreground = Brush $muted
$body.TextWrapping = 'Wrap'
$body.TextTrimming = 'CharacterEllipsis'
$body.Margin = New-Object System.Windows.Thickness(0, 5, 0, 0)
$body.MaxHeight = 58
[void]$content.Children.Add($body)
[System.Windows.Controls.Grid]::SetRow($body, 2)

$meta = New-Object System.Windows.Controls.TextBlock
$meta.Text = Pick $payload.workspace ''
$meta.FontSize = 11
$meta.Foreground = Brush $muted
$meta.Opacity = 0.8
$meta.TextTrimming = 'CharacterEllipsis'
$meta.Margin = New-Object System.Windows.Thickness(0, 7, 0, 0)
[void]$content.Children.Add($meta)
[System.Windows.Controls.Grid]::SetRow($meta, 3)

# A hairline divider between the workspace path and the buttons. The buttons
# are centered between this divider and the card's bottom border (10 above,
# 10 below), while the divider-to-border distance and the card height stay put.
$divider = New-Object System.Windows.Controls.Border
$divider.Height = 1
$divider.Background = Brush $border
$divider.Opacity = 0.9
$divider.Margin = New-Object System.Windows.Thickness(0, 7, 0, 0)
[void]$content.Children.Add($divider)
[System.Windows.Controls.Grid]::SetRow($divider, 4)

$actions = New-Object System.Windows.Controls.StackPanel
$actions.Orientation = 'Horizontal'
$actions.HorizontalAlignment = 'Right'
$actions.Margin = New-Object System.Windows.Thickness(0, 10, 0, 0)

$viewLabel  = Pick $payload.viewLabel  'View'
$closeLabel = Pick $payload.closeLabel 'Close'
$closeButton = New-FlatButton $closeLabel $bg $muted $ghostHover
$viewButton  = New-FlatButton $viewLabel $primaryBg $primaryFg $primaryHover
$viewButton.FontWeight = 'SemiBold'
[void]$actions.Children.Add($closeButton)
[void]$actions.Children.Add($viewButton)
[void]$content.Children.Add($actions)
[System.Windows.Controls.Grid]::SetRow($actions, 5)

$grid = New-Object System.Windows.Controls.Grid
[void]$grid.Children.Add($content)
if ($null -ne $bar) { [void]$grid.Children.Add($bar) }
$card.Child = $grid

$script:result = 'timeout'
$script:closing = $false
$script:focusOk = $false

function Close-Popup([string]$reason) {
  Trace ('close-popup=' + $reason)
  if ($script:closing) { return }
  $script:closing = $true
  $script:result = $reason
  if ($null -ne $returnWatch) { $returnWatch.Stop() }
  if ($null -ne $script:returnTimer) { $script:returnTimer.Stop() }
  if ($null -ne $controlWatch) { $controlWatch.Stop() }
  $window.Close()
}

function Focus-MainWindow([string]$processName, [string]$execPath) {
  $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
  $target = $running | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

  if ($null -ne $target) {
    $hwnd = $target.MainWindowHandle
    # Touch the window only when it is actually hidden or minimized. Restoring
    # a normal or maximized window would resize it, and the user asked for the
    # window to stay exactly the size it was.
    if (-not [DshNotifyNative]::IsWindowVisible($hwnd)) {
      [void][DshNotifyNative]::ShowWindow($hwnd, 5)
    } elseif ([DshNotifyNative]::IsIconic($hwnd)) {
      [void][DshNotifyNative]::ShowWindow($hwnd, 9)
    }
    if (-not [DshNotifyNative]::SetForegroundWindow($hwnd)) {
      # A background process is not allowed to steal the foreground; when that
      # happens, fall back to the shell's own switch.
      [DshNotifyNative]::SwitchToThisWindow($hwnd, $true)
    }
    return $true
  }

  # No window to raise. Relaunch the app only when it is not running at all, so
  # a hidden-to-tray instance is never duplicated.
  if ($running.Count -gt 0) { return $false }
  if ($execPath -eq '' -or -not (Test-Path -LiteralPath $execPath)) { return $false }
  # Refuse to launch anything but the app the Host named: a misconfigured path
  # would otherwise start an unrelated executable.
  if ([System.IO.Path]::GetFileNameWithoutExtension($execPath) -ne $processName) { return $false }
  Start-Process -FilePath $execPath | Out-Null
  return $true
}

$timeoutSeconds = 15
if ($null -ne $payload.timeoutSeconds -and "$($payload.timeoutSeconds)" -match '^\d+$') {
  $timeoutSeconds = [int]$payload.timeoutSeconds
}

# "Always notify" also shows the card while DSH is in front. In that case the
# person is already looking at the window the card points at, so the shorter
# focused delay applies. Away cards keep the longer delay.
$focusedTimeoutSeconds = $timeoutSeconds
if ($null -ne $payload.focusedTimeoutSeconds -and "$($payload.focusedTimeoutSeconds)" -match '^\d+$') {
  $focusedTimeoutSeconds = [int]$payload.focusedTimeoutSeconds
}
if ($foreground -ne '' -and $foreground -eq $focusProcess -and $focusedTimeoutSeconds -gt 0) {
  $timeoutSeconds = $focusedTimeoutSeconds
}
Trace ('close-seconds=' + $timeoutSeconds)

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds($timeoutSeconds)
$timer.Add_Tick({
  Trace 'tick'
  $timer.Stop()
  Close-Popup 'timeout'
})

# Switching back to DSH by hand (Alt-Tab, taskbar, whatever) earns a three second
# grace period, then the card closes so it never sits on top of the window the
# user just picked.
$script:returnTimer = $null
$returnWatch = New-Object System.Windows.Threading.DispatcherTimer
$returnWatch.Interval = [TimeSpan]::FromMilliseconds(400)
$returnWatch.Add_Tick({
  if ($script:closing) { $returnWatch.Stop(); return }
  if ((Get-ForegroundProcessName) -ne $focusProcess) { return }
  $returnWatch.Stop()
  Trace 'dsh-returned'
  $script:returnTimer = New-Object System.Windows.Threading.DispatcherTimer
  $script:returnTimer.Interval = [TimeSpan]::FromSeconds(3)
  $script:returnTimer.Add_Tick({
    $script:returnTimer.Stop()
    Close-Popup 'returned'
  })
  $script:returnTimer.Start()
})

$viewButton.Add_Click({
  Trace 'view-click'
  $script:focusOk = Focus-MainWindow $focusProcess $focusExe
  Close-Popup 'view'
})
$closeButton.Add_Click({
  Trace 'close-click'
  Close-Popup 'close'
})

$window.Add_KeyDown({
  param($sender, $eventArgs)
  if ($eventArgs.Key -eq 'Escape') { Close-Popup 'close' }
})

# Hovering pauses the countdown, so reading never races the close.
$card.Add_MouseEnter({
  $script:hovered = $true
  $timer.Stop()
})
$card.Add_MouseLeave({
  $script:hovered = $false
  if (-not $script:closing) {
    $timer.Stop()
    $timer.Start()
  }
})

# The Host rewrites this small JSON file while the card is up. A newer reply
# replaces the copy in place; a priority request asks the card to fold.
$script:lastControl = ''
$script:hovered = $false
$controlWatch = New-Object System.Windows.Threading.DispatcherTimer
$controlWatch.Interval = [TimeSpan]::FromMilliseconds(250)
$controlWatch.Add_Tick({
  if ($script:closing) { $controlWatch.Stop(); return }
  if ($controlPath -eq '' -or -not (Test-Path -LiteralPath $controlPath)) { return }
  try { $raw = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8 } catch { return }
  if ($raw -eq $script:lastControl) { return }
  $script:lastControl = $raw
  try { $record = $raw | ConvertFrom-Json } catch { return }
  if ($null -eq $record) { return }
  if ($record.close -eq $true) {
    $controlWatch.Stop()
    Close-Popup 'replaced'
    return
  }
  $updated = $false
  if ($null -ne $record.kicker) { $kicker.Text = [string]$record.kicker; $updated = $true }
  if ($null -ne $record.title) { $title.Text = [string]$record.title; $updated = $true }
  if ($null -ne $record.summary) { $body.Text = [string]$record.summary; $updated = $true }
  if ($null -ne $record.workspace) { $meta.Text = [string]$record.workspace; $updated = $true }
  if (-not $updated) { return }
  Trace ('control-replace=' + $title.Text + ' | ' + $body.Text)
  # The copy may be taller or shorter now; keep the card on the corner.
  $window.UpdateLayout()
  $window.Left = $script:workArea.Right - $window.ActualWidth - 24
  $window.Top  = $script:workArea.Bottom - $window.ActualHeight - 7
  # A fresh card restarts its countdown unless the person is still reading it.
  if (-not $script:hovered) {
    $timer.Stop()
    $timer.Start()
  }
  try { $pulseStory.Stop($window); $pulseStory.Begin($window) } catch { Trace ('pulse-failed: ' + $_.Exception.Message) }
})

$window.Add_Loaded({
  Trace 'loaded'
  $script:workArea = [System.Windows.SystemParameters]::WorkArea
  # Grow the auto-sized card by 30%; the star row then hands every extra pixel
  # to the summary body instead of leaving a gap under the buttons.
  $baseHeight = [double]$window.ActualHeight
  Trace ('height-base=' + $baseHeight)
  # Give the card itself the new height; the window keeps SizeToContent=Height
  # so it follows the card, and the star row expands into the added space.
  $card.Height = [math]::Round($baseHeight * 1.3)
  $body.MaxHeight = 1000
  $window.UpdateLayout()
  Trace ('height-card=' + $window.ActualHeight)
  $window.Left = $script:workArea.Right - $window.ActualWidth - 24
  # Keep the old 24px gap to the screen edge, but only 7px above the taskbar
  # (30% of the previous 24px bottom gap).
  $window.Top  = $script:workArea.Bottom - $window.ActualHeight - 7
  Trace ('anchor=' + $window.Left + ',' + $window.Top)
  $timer.Start()
  if ($controlPath -ne '') { $controlWatch.Start() }
  if ($watchReturn -and -not $dshWasFocused) { $returnWatch.Start() }
  try { [void]$pulseStory.Begin($window) } catch { Trace ('pulse-failed: ' + $_.Exception.Message) }
})

$window.Add_Closed({
  Trace ('closed result=' + $script:result + ' focused=' + $script:focusOk)
  if ($null -ne $controlWatch) { $controlWatch.Stop() }
  Write-Result $script:result $script:focusOk
  try {
    [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
  } catch { }
})

Trace 'pre-show'
try { [void]$window.ShowDialog() } catch { Trace ('show-failed: ' + $_.Exception.Message) }
