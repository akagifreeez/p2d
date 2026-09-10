param(
    [Parameter(Mandatory=$true)][string]$cmd,
    [int]$x = 0,
    [int]$y = 0,
    [string]$text = "",
    [string]$out = "$env:TEMP\p2d-shot.png"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lp);
    public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[Native]::SetProcessDPIAware() | Out-Null
[Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null  # PER_MONITOR_AWARE_V2

function Get-P2DWindow {
    $p = Get-Process -Name p2d -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { throw "p2d window not found" }
    return $p.MainWindowHandle
}

switch ($cmd) {
    "shot" {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Output "saved $out ($($b.Width)x$($b.Height))"
    }
    "click" {
        [Native]::SetCursorPos($x, $y) | Out-Null
        Start-Sleep -Milliseconds 100
        [Native]::mouse_event(2,0,0,0,0)
        Start-Sleep -Milliseconds 50
        [Native]::mouse_event(4,0,0,0,0)
        Write-Output "clicked $x,$y"
    }
    "focus" {
        $h = Get-P2DWindow
        [Native]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 200
        $r = New-Object Native+RECT
        [Native]::GetWindowRect($h, [ref]$r) | Out-Null
        Write-Output "focused rect L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom) size=$($r.Right-$r.Left)x$($r.Bottom-$r.Top)"
    }
    "top" {
        # P2Dを最前面化+指定位置へ移動(物理px)
        $h = Get-P2DWindow
        $HWND_TOPMOST = [IntPtr](-1)
        [Native]::SetWindowPos($h, $HWND_TOPMOST, $x, $y, 0, 0, 0x1) | Out-Null
        Start-Sleep -Milliseconds 300
        $r = New-Object Native+RECT
        [Native]::GetWindowRect($h, [ref]$r) | Out-Null
        Write-Output "topmost+moved rect L=$($r.Left) T=$($r.Top) R=$($r.Right) B=$($r.Bottom) size=$($r.Right-$r.Left)x$($r.Bottom-$r.Top)"
    }
    "enum" {
        $found = @()
        $cb = [Native+EnumProc]{ param($h, $lp)
            if ([Native]::IsWindowVisible($h)) {
                $sb = New-Object System.Text.StringBuilder 256
                [Native]::GetWindowText($h, $sb, 256) | Out-Null
                $t = $sb.ToString()
                if ($t -like '*P2D*') {
                    $r = New-Object Native+RECT
                    [Native]::GetWindowRect($h, [ref]$r) | Out-Null
                    Write-Output ("hwnd={0} title='{1}' rect L={2} T={3} R={4} B={5}" -f $h, $t, $r.Left, $r.Top, $r.Right, $r.Bottom)
                }
            }
            return $true
        }
        [Native]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
        Write-Output "enum done"
    }
    "type" {
        [System.Windows.Forms.SendKeys]::SendWait($text)
        Write-Output "typed: $text"
    }
    "press" {
        [System.Windows.Forms.SendKeys]::SendWait($text)
        Write-Output "pressed: $text"
    }
}
