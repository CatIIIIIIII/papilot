param([long]$Window, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'

# WM_NCHITTEST exercises the OS drag regions that Playwright clicks bypass.
# Coordinates are physical pixels relative to the Electron client area.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowHitTest {
    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X, Y; }
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
}
'@

# Avoid DPI virtualization, including on monitors with different scale factors.
[void][WindowHitTest]::SetThreadDpiAwarenessContext([IntPtr](-4))
$point = New-Object WindowHitTest+Point
$point.X = $X; $point.Y = $Y
if (-not [WindowHitTest]::ClientToScreen([IntPtr]$Window, [ref]$point)) {
    throw 'Could not convert the window coordinates to screen coordinates'
}
$packed = (($point.Y -band 65535) -shl 16) -bor ($point.X -band 65535)
$result = [IntPtr]::Zero
if ([WindowHitTest]::SendMessageTimeout([IntPtr]$Window, 0x84, [IntPtr]::Zero,
        [IntPtr]$packed, 2, 5000, [ref]$result) -eq [IntPtr]::Zero) {
    throw 'WM_NCHITTEST failed or timed out'
}
$result.ToInt64()
