# WriteUp Windows capture smoke test
#
# Run in Windows PowerShell 5.1 (NOT WSL, NOT pwsh Core unless WinForms is available):
#   cd \\wsl$\Ubuntu-22.04\home\swetha\WriteUp
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-capture-test.ps1
#
# Select text in Notepad -> Ctrl+Shift+G -> release keys.
# Captured text prints here. Close the small window to quit.

$ErrorActionPreference = "Stop"

# Prefer Windows PowerShell 5.1 — WinForms is built-in there.
if ($PSVersionTable.PSEdition -eq "Core") {
    Write-Host "[WriteUp] This script needs Windows PowerShell 5.1 (WinForms)." -ForegroundColor Yellow
    Write-Host "Re-run with:" -ForegroundColor Yellow
    Write-Host '  powershell.exe -ExecutionPolicy Bypass -File .\scripts\windows-capture-test.ps1'
    exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$formsAsm = [System.Windows.Forms.Form].Assembly.Location
$drawingAsm = [System.Drawing.Point].Assembly.Location

$csharp = @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class WriteUpHotkey {
    public const int WM_HOTKEY = 0x0312;
    public const int MOD_CONTROL = 0x0002;
    public const int MOD_SHIFT  = 0x0004;
    public const int HOTKEY_ID  = 0x5741;

    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    public const byte VK_CONTROL = 0x11;
    public const byte VK_SHIFT   = 0x10;
    public const byte VK_C       = 0x43;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static void ReleaseModifiers() {
        keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void SendCtrlC() {
        ReleaseModifiers();
        System.Threading.Thread.Sleep(40);
        keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
        keybd_event(VK_C, 0, 0, UIntPtr.Zero);
        keybd_event(VK_C, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static bool FocusWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        uint fgPid, targetPid;
        uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
        uint curTid = GetCurrentThreadId();
        uint targetTid = GetWindowThreadProcessId(hwnd, out targetPid);
        if (fgTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, true);
        if (targetTid != 0 && targetTid != curTid) AttachThreadInput(curTid, targetTid, true);
        bool ok = SetForegroundWindow(hwnd);
        if (targetTid != 0 && targetTid != curTid) AttachThreadInput(curTid, targetTid, false);
        if (fgTid != 0 && fgTid != curTid) AttachThreadInput(curTid, fgTid, false);
        return ok;
    }
}

public class WriteUpForm : Form {
    public Action OnHotkey;
    protected override void WndProc(ref Message m) {
        if (m.Msg == WriteUpHotkey.WM_HOTKEY && m.WParam.ToInt32() == WriteUpHotkey.HOTKEY_ID) {
            if (OnHotkey != null) OnHotkey();
        }
        base.WndProc(ref m);
    }
}
"@

# Must pass WinForms assembly refs — Add-Type does not pull them in automatically.
Add-Type -TypeDefinition $csharp -ReferencedAssemblies @($formsAsm, $drawingAsm)

$sentinel = "__WA_SENTINEL_7F3A__"

$form = New-Object WriteUpForm
$form.Text = "WriteUp Capture Test"
$form.Width = 480
$form.Height = 180
$form.TopMost = $true
$form.StartPosition = "CenterScreen"

$label = New-Object System.Windows.Forms.Label
$label.Dock = "Fill"
$label.TextAlign = "MiddleCenter"
$label.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$label.Text = "Select text in Notepad, then press Ctrl+Shift+G.`nWatch the PowerShell console for [WriteUp] logs."
$form.Controls.Add($label)

$form.OnHotkey = {
    Write-Host "[WriteUp] hotkey fired" -ForegroundColor Yellow
    $hwnd = [WriteUpHotkey]::GetForegroundWindow()
    Write-Host "[WriteUp] source HWND = $hwnd"

    Start-Sleep -Milliseconds 80
    [void][WriteUpHotkey]::FocusWindow($hwnd)
    Start-Sleep -Milliseconds 80

    $original = ""
    try { $original = [System.Windows.Forms.Clipboard]::GetText() } catch {}

    [System.Windows.Forms.Clipboard]::SetText($sentinel)
    [WriteUpHotkey]::SendCtrlC()

    $captured = $sentinel
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 25
        try {
            $cur = [System.Windows.Forms.Clipboard]::GetText()
            if ($cur -and $cur -ne $sentinel) {
                $captured = $cur
                break
            }
        } catch {}
    }

    if ($original) {
        try { [System.Windows.Forms.Clipboard]::SetText($original) } catch {}
    } else {
        try { [System.Windows.Forms.Clipboard]::Clear() } catch {}
    }

    if (-not $captured -or $captured -eq $sentinel) {
        Write-Host "[WriteUp] no selection captured (clipboard unchanged)" -ForegroundColor Red
        $label.Text = "No text selected. Select text in Notepad, then Ctrl+Shift+G."
    } else {
        Write-Host "[WriteUp] captured $($captured.Length) chars:" -ForegroundColor Green
        Write-Host "----------"
        Write-Host $captured
        Write-Host "----------"
        $preview = if ($captured.Length -gt 100) { $captured.Substring(0, 100) + "..." } else { $captured }
        $label.Text = "Captured $($captured.Length) chars:`n$preview"
    }
}

$null = $form.Add_Load({
    $ok = [WriteUpHotkey]::RegisterHotKey(
        $form.Handle,
        [WriteUpHotkey]::HOTKEY_ID,
        [WriteUpHotkey]::MOD_CONTROL -bor [WriteUpHotkey]::MOD_SHIFT,
        [int][char]"G"
    )
    if (-not $ok) {
        Write-Host "[WriteUp] FAILED to register Ctrl+Shift+G (conflict?)" -ForegroundColor Red
        $label.Text = "Hotkey registration failed (maybe already in use).`nStop the WSL Tauri app first, then retry."
    } else {
        Write-Host "[WriteUp] Hotkey registered: Ctrl+Shift+G" -ForegroundColor Green
        Write-Host "[WriteUp] Select text in Notepad, press Ctrl+Shift+G, release keys." -ForegroundColor Cyan
    }
})

$null = $form.Add_FormClosed({
    [void][WriteUpHotkey]::UnregisterHotKey($form.Handle, [WriteUpHotkey]::HOTKEY_ID)
})

Write-Host "[WriteUp] Starting Windows capture test..."
Write-Host "[WriteUp] Tip: stop 'npm run tauri dev' in WSL first so it does not fight for the hotkey."
[System.Windows.Forms.Application]::Run($form)
