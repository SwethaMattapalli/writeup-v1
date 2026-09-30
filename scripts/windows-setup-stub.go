package main

// Windows-only installer stub. Cross-compiled from Linux, then the zip
// payload is appended:
//   [stub.exe][zip bytes][uint64 zip length LE][16-byte tail tag]

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	fmt.Println("WriteUp Setup")
	fmt.Println("-------------")

	self, err := os.Executable()
	if err != nil {
		fail("Could not locate this installer", err)
	}
	raw, err := os.ReadFile(self)
	if err != nil {
		fail("Could not read installer", err)
	}

	payload, err := extractPayload(raw)
	if err != nil {
		fail("Installer payload is missing or corrupt", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		fail("Installer archive is corrupt", err)
	}

	dest := installDir()
	fmt.Println("Installing to:", dest)
	if err := os.MkdirAll(dest, 0755); err != nil {
		fail("Could not create install folder", err)
	}
	if err := extractZip(zr, dest); err != nil {
		fail("Could not extract files", err)
	}

	target := launchTarget(dest)
	writeUninstallScript(dest)
	registerUninstall(dest)
	createShortcut(dest, target)
	createStartupShortcut(dest, target)
	fmt.Println("Clearing Windows download-block flags…")
	unblockInstallDir(dest)

	fmt.Println("Launching WriteUp (signed electron.exe)…")
	fmt.Println("Leave WriteUp running in the tray, then select text and press Ctrl+Shift+G.")
	if err := startWriteUp(dest, target); err != nil {
		fail("Installed, but could not start WriteUp.", err)
	}
	time.Sleep(2 * time.Second)
}

func extractPayload(raw []byte) ([]byte, error) {
	if len(raw) < 24 {
		return nil, fmt.Errorf("file too small")
	}
	n := len(raw)
	tag := raw[n-16:]
	want := []byte("WRITEUP_INSTALL1")
	if !bytes.Equal(tag, want) {
		return nil, fmt.Errorf("bad trailer")
	}
	zipLen := binary.LittleEndian.Uint64(raw[n-24 : n-16])
	start := n - 24 - int(zipLen)
	if start < 0 || start > n {
		return nil, fmt.Errorf("bad zip length")
	}
	return raw[start : n-24], nil
}

func installDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.Getenv("USERPROFILE")
	}
	if base == "" {
		wd, _ := os.Getwd()
		base = wd
	}
	return filepath.Join(base, "Programs", "WriteUp")
}

func extractZip(zr *zip.Reader, dest string) error {
	total := len(zr.File)
	for i, f := range zr.File {
		name := filepath.Clean(f.Name)
		if strings.HasPrefix(name, "..") {
			continue
		}
		outPath := filepath.Join(dest, name)
		if !strings.HasPrefix(outPath, dest) {
			continue
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(outPath, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
			return err
		}
		if err := writeFile(f, outPath); err != nil {
			return err
		}
		if i%40 == 0 || i+1 == total {
			fmt.Printf("  copied %d/%d files\r", i+1, total)
		}
	}
	fmt.Println()
	return nil
}

func writeFile(f *zip.File, outPath string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

func writeUninstallScript(installDir string) {
	script := filepath.Join(installDir, "UninstallWriteUp.cmd")
	body := "@echo off\r\n" +
		"echo Uninstalling WriteUp...\r\n" +
		"taskkill /IM electron.exe /F >nul 2>&1\r\n" +
		"set \"AP=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\"\r\n" +
		"del /f /q \"%AP%\\WriteUp.lnk\" >nul 2>&1\r\n" +
		"del /f /q \"%AP%\\Startup\\WriteUp.lnk\" >nul 2>&1\r\n" +
		"reg delete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WriteUp\" /f >nul 2>&1\r\n" +
		"cd /d \"%USERPROFILE%\"\r\n" +
		"rmdir /s /q \"" + installDir + "\"\r\n" +
		"echo WriteUp was removed.\r\n" +
		"pause\r\n"
	_ = os.WriteFile(script, []byte(body), 0755)
}

func registerUninstall(installDir string) {
	fmt.Println("Registering in Apps & Features…")
	uninstall := filepath.Join(installDir, "UninstallWriteUp.cmd")
	key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\WriteUp`
	ps := fmt.Sprintf(
		"$k='%s'; New-Item -Path ('Registry::'+$k) -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name DisplayName -Value 'WriteUp' -PropertyType String -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name Publisher -Value 'WriteUp' -PropertyType String -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name DisplayVersion -Value '0.1.0' -PropertyType String -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name InstallLocation -Value '%s' -PropertyType String -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name UninstallString -Value 'cmd.exe /C \"\"%s\"\"' -PropertyType String -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null; "+
			"New-ItemProperty -Path ('Registry::'+$k) -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null",
		escapePS(key), escapePS(installDir), escapePS(uninstall),
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	if err := cmd.Run(); err != nil {
		fmt.Println("Warning: could not register uninstall entry:", err)
	}
}

func createShortcut(installDir, exe string) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return
	}
	lnk := filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "WriteUp.lnk")
	writeLnk(lnk, exe, installDir, 1, "")
}

func createStartupShortcut(installDir, exe string) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return
	}
	lnk := filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "WriteUp.lnk")
	fmt.Println("Enabling start at login…")
	args := ""
	if strings.EqualFold(filepath.Base(exe), "WriteUp.cmd") {
		args = "--startup"
	}
	writeLnk(lnk, exe, installDir, 7, args)
}

func writeLnk(lnk, target, workdir string, windowStyle int, args string) {
	ps := fmt.Sprintf(
		"$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s'); $s.TargetPath='%s'; $s.WorkingDirectory='%s'; $s.Arguments='%s'; $s.WindowStyle=%d; $s.Description='WriteUp'; $s.Save()",
		escapePS(lnk), escapePS(target), escapePS(workdir), escapePS(args), windowStyle,
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	_ = cmd.Run()
}

func unblockInstallDir(dir string) {
	ps := fmt.Sprintf(
		"Get-ChildItem -LiteralPath '%s' -Recurse -Force -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue",
		escapePS(dir),
	)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", ps)
	_ = cmd.Run()
}

func launchTarget(dir string) string {
	for _, name := range []string{"WriteUp.cmd", "electron.exe", "WriteUp.exe"} {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return filepath.Join(dir, "electron.exe")
}

func startWriteUp(dir, target string) error {
	base := filepath.Base(target)
	fmt.Println("Starting", base)
	// cmd.exe is Microsoft-signed; electron.exe from this pack is GitHub/Electron-signed.
	cmd := exec.Command("cmd.exe", "/C", "start", "WriteUp", "/D", dir, base)
	cmd.Dir = dir
	if err := cmd.Start(); err == nil {
		_ = cmd.Process.Release()
		return nil
	}

	direct := exec.Command(target)
	direct.Dir = dir
	direct.Stdin = nil
	direct.Stdout = nil
	direct.Stderr = nil
	direct.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200 | 0x01000000,
	}
	if err := direct.Start(); err != nil {
		return err
	}
	_ = direct.Process.Release()
	return nil
}

func escapePS(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func fail(msg string, err error) {
	fmt.Fprintf(os.Stderr, "\nERROR: %s\n%v\n", msg, err)
	fmt.Println()
	fmt.Println("The files are installed. Windows Application Control / Smart App Control")
	fmt.Println("is blocking this unsigned .exe. Try these in order:")
	fmt.Println()
	fmt.Println("1. Right-click WriteUp.exe → Properties → tick Unblock → Apply")
	fmt.Println("   Folder: %LOCALAPPDATA%\\Programs\\WriteUp")
	fmt.Println("2. Windows Security → App & browser control → Smart App Control → Off")
	fmt.Println("3. Then double-click WriteUp.exe in that folder.")
	fmt.Println()
	fmt.Println("If this is a work PC, ask IT to allow WriteUp.exe (WDAC / AppLocker).")
	fmt.Println()
	fmt.Println("Press Enter to close…")
	_, _ = fmt.Scanln()
	os.Exit(1)
}
