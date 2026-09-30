'use strict'

const {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  shell,
  Notification,
  protocol,
  systemPreferences,
} = require('electron')
const fs = require('fs')
const path = require('path')
const { exec, execFile } = require('child_process')
const { BackendManager } = require('./backend-manager.cjs')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'writeup',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

let mainWindow = null
let setupWindow = null
let hotkeyAnchor = null
let tray = null
let sourceHwnd = null
let sourceMacApp = ''
let originalClipboard = ''
let lastTone = 'Professional'
let backend = null
let widgetReady = false
let widgetUiReady = false
let pendingWidgetPayload = null
let registeredHotkey = 'Ctrl+Shift+G'
let macPermissionMissing = false

const SENTINEL = '__WA_SENTINEL_7F3A__'
const MAX_LEN = 3000
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  console.log(...args)
  try {
    if (app.isReady()) {
      fs.appendFileSync(path.join(app.getPath('userData'), 'writeup.log'), line)
    }
  } catch {
    // ignore log IO errors
  }
}

function iconPath() {
  return path.join(__dirname, 'icon.png')
}

function runPs(script, captureOutput = false) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    exec(
      `powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`,
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err) log('[WriteUp] PowerShell error:', err.message)
        resolve(captureOutput ? (stdout || '').trim() : undefined)
      },
    )
  })
}

function runCmd(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve((stdout || '').trim())
    })
  })
}

function runOsascript(args) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message} ${stderr || ''}`.trim()
        reject(err)
      } else {
        resolve((stdout || '').trim())
      }
    })
  })
}

// "not allowed to send keystrokes (1002)" = Accessibility missing,
// "Not authorized to send Apple events (-1743)" = Automation missing.
function isMacPermissionError(message) {
  return /1002|-1743|not allowed|not authorized|not permitted/i.test(String(message || ''))
}

// The hotkey's Cmd/Shift are usually still physically held when we fire the
// synthetic Cmd+C, which turns it into Cmd+Shift+C (not Copy) in most apps.
async function waitForMacModifierRelease() {
  const script =
    'ObjC.import("AppKit");' +
    'var i = 0;' +
    'while (($.NSEvent.modifierFlags & 0x1E0000) && i < 60) { delay(0.025); i++ }' +
    'i'
  try {
    await runOsascript(['-l', 'JavaScript', '-e', script])
  } catch (e) {
    log('[WriteUp] modifier wait failed:', e.message)
    await delay(250)
  }
}

function escapeAppleScriptString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function frontmostMacApp() {
  try {
    const name = await runCmd(
      `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
    )
    return name || ''
  } catch (e) {
    log('[WriteUp] could not read frontmost app:', e.message)
    if (isMacPermissionError(e.message)) macPermissionMissing = true
    return ''
  }
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  }[ext] || 'application/octet-stream'
}

function frontendDir() {
  const candidates = []
  // Custom signed-electron pack (Setup.exe / WriteUp-win): resources/app/build
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app', 'build'))
    // electron-builder layouts (older / alternate packs)
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'build'))
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'build'))
  }
  // Dev / unpackaged: app/electron -> app/build
  candidates.push(path.join(__dirname, '..', 'build'))

  for (const dir of candidates) {
    try {
      const index = path.join(dir, 'index.html')
      if (fs.existsSync(index) && fs.statSync(index).isFile()) {
        return path.normalize(dir)
      }
    } catch {
      // try next candidate
    }
  }

  const fallback = path.normalize(candidates[0] || path.join(__dirname, '..', 'build'))
  log('[WriteUp] frontend index.html not found; tried:', candidates.join(' | '))
  return fallback
}

function registerAppProtocol() {
  const distDir = frontendDir()
  const root = distDir.endsWith(path.sep) ? distDir : distDir + path.sep
  const indexFile = path.join(distDir, 'index.html')
  log('[WriteUp] frontend dir', distDir)

  protocol.handle('writeup', (request) => {
    try {
      if (!fs.existsSync(indexFile)) {
        const msg =
          `WriteUp UI missing.\nExpected: ${indexFile}\n` +
          `Reinstall WriteUp-Setup, or check resources\\app\\build\\index.html`
        log('[WriteUp] missing index', indexFile)
        return new Response(msg, {
          status: 404,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      const u = new URL(request.url)
      let rel = decodeURIComponent(u.pathname || '/')
      if (rel === '/' || rel === '' || rel === '/index.html') rel = '/index.html'
      let filePath = path.normalize(path.join(distDir, rel))
      if (!filePath.startsWith(root) && filePath !== distDir) {
        return new Response('Forbidden', { status: 403 })
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (!path.extname(rel) || rel === '/index.html') {
          filePath = indexFile
        } else {
          log('[WriteUp] missing frontend file', request.url, '->', filePath)
          return new Response('Not found', { status: 404 })
        }
      }
      const body = fs.readFileSync(filePath)
      return new Response(body, {
        headers: {
          'Content-Type': mimeFor(filePath),
          'Cache-Control': 'no-cache',
        },
      })
    } catch (err) {
      log('[WriteUp] protocol error', err.message, request.url)
      return new Response(String(err.message), { status: 500 })
    }
  })
}

function runningFromInstall() {
  try {
    if (fs.existsSync(path.join(process.resourcesPath, 'backend'))) return true
  } catch {
    // ignore
  }
  return /[\\/]Programs[\\/]WriteUp[\\/]electron\.exe$/i.test(process.execPath)
}

function loadWidgetPage() {
  const distDir = frontendDir()
  const indexFile = path.join(distDir, 'index.html')
  const built = fs.existsSync(indexFile)
  log('[WriteUp] loadWidgetPage', { built, indexFile, packaged: app.isPackaged })

  if (built && (app.isPackaged || runningFromInstall())) {
    // Pathname must be "/" so SvelteKit does not show its 404 page.
    mainWindow.loadURL('writeup://app/')
    return
  }
  if (built) {
    // Prefer custom protocol in packaged-like installs; file:// for local vite-less runs.
    mainWindow.loadURL('writeup://app/')
    return
  }
  mainWindow.loadURL('http://localhost:1420')
}

function showComposeWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  sendWidgetState({ type: 'compose' })
  bringToFront(mainWindow)
}

function sendWidgetState(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingWidgetPayload = payload
    return
  }
  pendingWidgetPayload = payload
  if (widgetUiReady) {
    mainWindow.webContents.send('state-change', payload)
  }
}

function createHotkeyAnchor() {
  if (hotkeyAnchor && !hotkeyAnchor.isDestroyed()) return
  hotkeyAnchor = new BrowserWindow({
    width: 1,
    height: 1,
    x: -32000,
    y: -32000,
    show: true,
    frame: false,
    skipTaskbar: true,
    transparent: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
  })
  hotkeyAnchor.setIgnoreMouseEvents(true)
  hotkeyAnchor.setAlwaysOnTop(true, 'screen-saver')
}

function createWidgetWindow() {
  const winOpts = {
    width: 440,
    height: 420,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    minimizable: true,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  }

  // Transparent windows are often invisible on Windows, so the hotkey
  // looks like it "does nothing".
  if (process.platform === 'win32') {
    winOpts.transparent = false
    winOpts.backgroundColor = '#1c1c2e'
  } else {
    winOpts.transparent = true
    winOpts.backgroundColor = '#00000000'
  }

  mainWindow = new BrowserWindow(winOpts)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.webContents.on('did-finish-load', () => {
    widgetReady = true
    // Page must still call widget-ui-ready after onStateChange is registered.
    log('[WriteUp] widget UI loaded')
  })
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log('[WriteUp] widget failed to load', code, desc)
  })
  mainWindow.on('closed', () => {
    widgetReady = false
    widgetUiReady = false
    mainWindow = null
  })

  loadWidgetPage()
}

function createSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    bringToFront(setupWindow)
    return
  }
  setupWindow = new BrowserWindow({
    width: 520,
    height: 500,
    resizable: false,
    minimizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'WriteUp Setup',
    icon: iconPath(),
    backgroundColor: '#13132b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  setupWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  setupWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== setupWindow.webContents.getURL()) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  setupWindow.loadFile(path.join(__dirname, 'setup.html'))
  setupWindow.on('closed', () => {
    setupWindow = null
  })
}

function bringToFront(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  win.focus()
}

function createTray() {
  try {
    const image = nativeImage.createFromPath(iconPath())
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }))
  } catch (err) {
    log('[WriteUp] system tray unavailable:', err.message)
    return
  }
  tray.setToolTip(`WriteUp — ${registeredHotkey}`)
  rebuildTrayMenu()
  tray.on('click', () => createSetupWindow())
}

function rebuildTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `WriteUp (${registeredHotkey})`, enabled: false },
    { type: 'separator' },
    {
      label: 'Open rewrite window',
      click: () => showComposeWindow(),
    },
    {
      label: 'Open setup window',
      click: () => createSetupWindow(),
    },
    {
      label: `Test ${registeredHotkey} now`,
      click: () => handleHotkey(),
    },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: isStartAtLoginEnabled(),
      click: (item) => setStartAtLogin(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Quit WriteUp',
      click: () => {
        backend?.stop()
        app.quit()
      },
    },
  ]))
}

function loginFlagFile() {
  return path.join(app.getPath('userData'), 'login-item.json')
}

function isStartAtLoginEnabled() {
  try {
    if (fs.existsSync(loginFlagFile())) {
      return JSON.parse(fs.readFileSync(loginFlagFile(), 'utf8')).openAtLogin !== false
    }
  } catch {
    // ignore
  }
  return app.getLoginItemSettings().openAtLogin
}

function loginLaunchPath() {
  const dir = path.dirname(process.execPath)
  const cmdPath = path.join(dir, 'WriteUp.cmd')
  return fs.existsSync(cmdPath) ? cmdPath : process.execPath
}

function setStartAtLogin(enabled) {
  const settings = {
    openAtLogin: Boolean(enabled),
    path: loginLaunchPath(),
    args: [],
    openAsHidden: true,
  }
  try {
    app.setLoginItemSettings(settings)
  } catch (err) {
    log('[WriteUp] setLoginItemSettings failed', err.message)
  }
  try {
    fs.writeFileSync(loginFlagFile(), JSON.stringify({ openAtLogin: Boolean(enabled) }))
  } catch (err) {
    log('[WriteUp] could not save login preference', err.message)
  }
  if (process.platform === 'win32') syncStartupShortcut(Boolean(enabled))
}

function syncStartupShortcut(enabled) {
  const appData = process.env.APPDATA
  if (!appData) return
  const lnk = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WriteUp.lnk')
  const dir = path.dirname(process.execPath)
  const cmdPath = path.join(dir, 'WriteUp.cmd')
  const target = fs.existsSync(cmdPath) ? cmdPath : process.execPath
  if (!enabled) {
    try { fs.unlinkSync(lnk) } catch { /* already gone */ }
    return
  }
  const ps = [
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}')`,
    `$s.TargetPath='${target.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory='${dir.replace(/'/g, "''")}'`,
    `$s.Arguments='${path.basename(target).toLowerCase() === 'writeup.cmd' ? '--startup' : ''}'`,
    `$s.WindowStyle=7`,
    `$s.Description='WriteUp'`,
    `$s.Save()`,
  ].join('; ')
  exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, (err) => {
    if (err) log('[WriteUp] startup shortcut failed', err.message)
  })
}

function ensureStartAtLogin() {
  if (!app.isPackaged && !runningFromInstall()) return
  const first = !fs.existsSync(loginFlagFile())
  if (first) setStartAtLogin(true)
  else if (isStartAtLoginEnabled()) setStartAtLogin(true)
}

function formatAccel(accel) {
  return accel
    .replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
    .replace('Control', 'Ctrl')
    .replace(/\+/g, '+')
}

function registerHotkeys() {
  const candidates = process.platform === 'win32'
    ? ['Control+Shift+G', 'CommandOrControl+Shift+G', 'Control+Shift+U']
    : ['CommandOrControl+Shift+G', 'CommandOrControl+Shift+U']

  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, () => {
        log('[WriteUp] hotkey pressed', accel)
        handleHotkey()
      })) {
        registeredHotkey = formatAccel(accel)
        log('[WriteUp] global hotkey registered:', registeredHotkey)
        rebuildTrayMenu()
        if (tray) tray.setToolTip(`WriteUp — ${registeredHotkey}`)
        return true
      }
    } catch (err) {
      log('[WriteUp] hotkey register threw', accel, err.message)
    }
  }
  log('[WriteUp] could not register any global hotkey')
  return false
}

function notifyReady() {
  try {
    if (!Notification.isSupported()) return
    new Notification({
      title: 'WriteUp is running',
      body: `Select text in any app, then press ${registeredHotkey}`,
    }).show()
  } catch (err) {
    log('[WriteUp] notification failed', err.message)
  }
}

function clampedPosition(cursorX, cursorY, winW, winH) {
  const offset = 22
  let x = cursorX + offset
  let y = cursorY + offset
  for (const d of screen.getAllDisplays()) {
    const { x: mx, y: my, width: mw, height: mh } = d.bounds
    if (cursorX >= mx && cursorX < mx + mw && cursorY >= my && cursorY < my + mh) {
      if (x + winW > mx + mw) x = cursorX - winW - offset
      if (y + winH > my + mh) y = cursorY - winH - offset
      x = Math.max(x, mx)
      y = Math.max(y, my)
      break
    }
  }
  return [x, y]
}

async function pollClipboard(sentinel, attempts = 12, intervalMs = 25) {
  for (let i = 0; i < attempts; i++) {
    await delay(intervalMs)
    const text = clipboard.readText()
    if (text && text !== sentinel) return text
  }
  return ''
}

async function synthesizeCopy() {
  if (process.platform === 'win32') {
    const hwndStr = await runPs(`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class WU {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, SI[] i, int s);
    [StructLayout(LayoutKind.Sequential)] public struct SI { public uint type; public KI ki; public long pad; }
    [StructLayout(LayoutKind.Sequential)] public struct KI  { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    static SI Key(ushort v,bool up=false){var x=new SI();x.type=1;x.ki.wVk=v;if(up)x.ki.dwFlags=2;return x;}
    public static void CtrlC(){SendInput(4,new SI[]{Key(0x11),Key(0x43),Key(0x43,true),Key(0x11,true)},System.Runtime.InteropServices.Marshal.SizeOf(typeof(SI)));}
}
"@ -ErrorAction SilentlyContinue
Write-Output ([WU]::GetForegroundWindow().ToInt64())
[WU]::CtrlC()
`, true)
    const hwnd = parseInt(hwndStr, 10)
    return Number.isNaN(hwnd) ? null : hwnd
  }

  if (process.platform === 'darwin') {
    await waitForMacModifierRelease()
    await runOsascript(['-e', 'tell application "System Events" to keystroke "c" using command down']).catch((e) => {
      log('[WriteUp] macOS copy failed:', e.message)
      if (isMacPermissionError(e.message)) macPermissionMissing = true
    })
    return null
  }

  await runCmd('xdotool key --clearmodifiers ctrl+c').catch((e) => {
    log('[WriteUp] Linux copy failed (install xdotool):', e.message)
  })
  return null
}

async function synthesizePaste(hwnd) {
  if (process.platform === 'win32') {
    await runPs(hwnd != null ? `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class WU {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, SI[] i, int s);
    [StructLayout(LayoutKind.Sequential)] public struct SI { public uint type; public KI ki; public long pad; }
    [StructLayout(LayoutKind.Sequential)] public struct KI  { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    static SI Key(ushort v,bool up=false){var x=new SI();x.type=1;x.ki.wVk=v;if(up)x.ki.dwFlags=2;return x;}
    public static void CtrlV(){SendInput(4,new SI[]{Key(0x11),Key(0x56),Key(0x56,true),Key(0x11,true)},System.Runtime.InteropServices.Marshal.SizeOf(typeof(SI)));}
}
"@ -ErrorAction SilentlyContinue
$h=[IntPtr]::new(${hwnd})
[WU]::ShowWindow($h,9)|Out-Null
[WU]::SetForegroundWindow($h)|Out-Null
Start-Sleep -Milliseconds 150
[WU]::CtrlV()
` : `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class WU {
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, SI[] i, int s);
    [StructLayout(LayoutKind.Sequential)] public struct SI { public uint type; public KI ki; public long pad; }
    [StructLayout(LayoutKind.Sequential)] public struct KI  { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    static SI Key(ushort v,bool up=false){var x=new SI();x.type=1;x.ki.wVk=v;if(up)x.ki.dwFlags=2;return x;}
    public static void CtrlV(){SendInput(4,new SI[]{Key(0x11),Key(0x56),Key(0x56,true),Key(0x11,true)},System.Runtime.InteropServices.Marshal.SizeOf(typeof(SI)));}
}
"@ -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 250
[WU]::CtrlV()
`)
    return
  }

  if (process.platform === 'darwin') {
    if (sourceMacApp) {
      const escaped = escapeAppleScriptString(sourceMacApp)
      await runCmd(
        `osascript -e 'tell application "System Events" to set frontmost of first process whose name is "${escaped}" to true'`,
      ).catch((e) => {
        log('[WriteUp] could not refocus source app:', e.message)
      })
    }
    // Give the WindowServer time to actually hand key focus back to the
    // source app before sending the keystroke — without this, the paste
    // can race the focus change and land nowhere (or on our own window).
    await delay(200)
    await runCmd(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`).catch((e) => {
      log('[WriteUp] macOS paste failed:', e.message)
    })
    return
  }

  await runCmd('xdotool key --clearmodifiers ctrl+v').catch((e) => {
    log('[WriteUp] Linux paste failed (install xdotool):', e.message)
  })
}

async function handleHotkey() {
  if (!backend || backend.state.stage !== 'ready') {
    log('[WriteUp] hotkey ignored — backend not ready', backend?.state?.stage)
    createSetupWindow()
    return
  }
  const { x: cx, y: cy } = screen.getCursorScreenPoint()
  await delay(80)
  try {
    await captureAndShow(cx, cy)
  } catch (e) {
    log('[WriteUp] capture error:', e.message)
  }
}

async function captureAndShow(cx, cy) {
  macPermissionMissing = false
  if (process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      log('[WriteUp] Accessibility permission not granted')
      macPermissionMissing = true
      systemPreferences.isTrustedAccessibilityClient(true)
    }
    sourceMacApp = await frontmostMacApp()
    log('[WriteUp] capturing from', sourceMacApp || '(unknown app)')
  }

  originalClipboard = clipboard.readText()
  clipboard.writeText(SENTINEL)

  sourceHwnd = await synthesizeCopy()
  await delay(120)

  const captured = await pollClipboard(SENTINEL, 25, 50)
  clipboard.writeText(originalClipboard)

  if (!mainWindow || mainWindow.isDestroyed()) createWidgetWindow()
  const [wx, wy] = clampedPosition(cx, cy, 440, 420)
  mainWindow.setPosition(wx, wy)
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  const payload = (!captured || captured === SENTINEL)
    ? { type: 'no_selection', reason: macPermissionMissing ? 'permission' : 'empty', hotkey: registeredHotkey }
    : {
        type: 'ready',
        text: captured.length > MAX_LEN ? captured.slice(0, MAX_LEN) : captured,
        truncated: captured.length > MAX_LEN,
      }

  sendWidgetState(payload)
  bringToFront(mainWindow)
}

function registerIpc() {
  ipcMain.handle('get-last-tone', () => lastTone)
  ipcMain.handle('set-last-tone', (_, tone) => {
    lastTone = tone
  })

  ipcMain.handle('widget-ui-ready', () => {
    widgetUiReady = true
    if (pendingWidgetPayload && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state-change', pendingWidgetPayload)
    }
    return true
  })

  ipcMain.handle('minimize-widget', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  })

  ipcMain.handle('resize-widget', (_, size) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const w = Math.max(360, Math.min(Number(size?.width) || 440, 520))
    const h = Math.max(260, Math.min(Number(size?.height) || 420, 680))
    try {
      mainWindow.setContentSize(Math.round(w), Math.round(h))
    } catch (err) {
      log('[WriteUp] resize-widget failed', err.message)
    }
  })

  ipcMain.handle('dismiss-widget', () => {
    mainWindow.hide()
    if (originalClipboard) clipboard.writeText(originalClipboard)
  })

  ipcMain.handle('paste-back', async (_, text) => {
    const hwnd = sourceHwnd
    mainWindow.hide()
    clipboard.writeText(text)
    await synthesizePaste(hwnd)
    await delay(300)
    if (originalClipboard) clipboard.writeText(originalClipboard)
  })

  ipcMain.handle('get-setup-state', () => ({
    ...(backend?.state || { stage: 'idle', message: 'Starting…' }),
    hotkey: registeredHotkey,
    remote: Boolean(backend?.isRemote()),
  }))
  ipcMain.handle('get-backend-config', () => backend?.clientConfig() || { url: 'http://127.0.0.1:8090', accessKey: '' })
  ipcMain.handle('save-access-key', (_, key) => backend.saveAccessKey(key))
  ipcMain.handle('save-api-key', (_, key) => backend.saveApiKey(key))
  ipcMain.handle('save-llm-settings', (_, cfg) => backend.saveLlmSettings(cfg))
  ipcMain.handle('retry-setup', () => {
    backend.stop()
    return backend.setupAndStart()
  })
  ipcMain.handle('finish-setup', () => {
    setupWindow?.hide()
  })
}

async function boot() {
  if (process.platform === 'darwin') {
    // Copy/paste is simulated via synthetic keystrokes (System Events), which
    // silently no-ops without Accessibility permission — surface the macOS
    // prompt now instead of letting every hotkey press fail invisibly later.
    try {
      systemPreferences.isTrustedAccessibilityClient(true)
    } catch (e) {
      log('[WriteUp] accessibility check failed:', e.message)
    }
  }

  backend = new BackendManager()
  backend.on('progress', (payload) => {
    const next = { ...payload, hotkey: registeredHotkey, remote: backend.isRemote() }
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.webContents.send('setup-progress', next)
    }
    if (tray && payload.stage === 'ready') {
      tray.setToolTip(`WriteUp — ready (${registeredHotkey})`)
      notifyReady()
      // Do not auto-open the compose widget after restart — avoids a blank second popup.
    }
    if (tray && payload.stage === 'error') tray.setToolTip('WriteUp — setup needs attention')
  })

  registerAppProtocol()
  ensureStartAtLogin()
  createHotkeyAnchor()
  createTray()
  createWidgetWindow()
  createSetupWindow()
  registerIpc()
  registerHotkeys()

  await backend.setupAndStart()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    createSetupWindow()
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.writeup.assistant')
    return boot()
  })

  app.on('activate', () => {
    createSetupWindow()
  })
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  backend?.stop()
})

app.on('window-all-closed', () => {
  // Stay resident in the tray even if the setup window is closed.
})
