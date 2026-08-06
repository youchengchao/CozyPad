param([int]$X, [int]$Y)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = $null
foreach ($p in (Get-Process electron -ErrorAction SilentlyContinue)) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $exe = ''
  try { $exe = $p.Path } catch { $exe = '' }
  if ($exe -like 'D:\CozyPad\node_modules\*') { $proc = $p; break }
}
if ($null -eq $proc) { Write-Output "NO_WINDOW"; exit 1 }

$h = $proc.MainWindowHandle
[void][C]::ShowWindow($h, 9)
# Background processes cannot steal focus via SetForegroundWindow alone.
# TOPMOST raises the window regardless, which is what synthetic clicks need.
[void][C]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)  # HWND_TOPMOST | NOSIZE|NOMOVE
[void][C]::BringWindowToTop($h)
[void][C]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500

$r = New-Object C+RECT
[void][C]::GetWindowRect($h, [ref]$r)
$sx = $r.L + $X
$sy = $r.T + $Y
[void][C]::SetCursorPos($sx, $sy)
Start-Sleep -Milliseconds 120
[C]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 60
[C]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
Start-Sleep -Milliseconds 500
Write-Output "clicked window($X,$Y) -> screen($sx,$sy)"
