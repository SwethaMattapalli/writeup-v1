use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::ShortcutState;

// ── Shared application state ────────────────────────────────────────────────

#[derive(Default)]
struct AppState {
    /// Text captured from the focused application.
    captured_text: Mutex<String>,
    /// Original clipboard content before we overwrote it.
    original_clipboard: Mutex<String>,
    /// Last tone chosen by the user.
    last_tone: Mutex<String>,
    /// Platform window handle of the source app (HWND as isize on Windows,
    /// X11 window id as decimal string on Linux).
    source_window: Mutex<Option<String>>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            captured_text: Mutex::new(String::new()),
            original_clipboard: Mutex::new(String::new()),
            last_tone: Mutex::new("Professional".to_string()),
            source_window: Mutex::new(None),
        }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_captured_text(state: tauri::State<AppState>) -> String {
    state.captured_text.lock().unwrap().clone()
}

#[tauri::command]
fn get_last_tone(state: tauri::State<AppState>) -> String {
    state.last_tone.lock().unwrap().clone()
}

#[tauri::command]
fn set_last_tone(state: tauri::State<AppState>, tone: String) {
    *state.last_tone.lock().unwrap() = tone;
}

/// Hide the widget and restore the original clipboard content.
#[tauri::command]
fn dismiss_widget(app: AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;

    let original = state.original_clipboard.lock().unwrap().clone();
    if !original.is_empty() {
        let _ = app.clipboard().write_text(original);
    }
    Ok(())
}

/// Hide widget, focus the source window, write `text` to clipboard, simulate
/// Ctrl+V, then restore the original clipboard.
///
/// If any step fails after hiding the widget the improved text remains on the
/// clipboard so the user can paste manually (FR-6).
#[tauri::command]
fn paste_back(
    app: AppHandle,
    state: tauri::State<AppState>,
    text: String,
) -> Result<(), String> {
    let original_clipboard = state.original_clipboard.lock().unwrap().clone();
    let source_window = state.source_window.lock().unwrap().clone();

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;

    // Return focus to the app the user was typing in.
    if !focus_window(source_window.as_deref()) {
        std::thread::sleep(Duration::from_millis(220));
    } else {
        std::thread::sleep(Duration::from_millis(120));
    }

    app.clipboard()
        .write_text(&text)
        .map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(60));

    simulate_paste().map_err(|e| e.to_string())?;

    std::thread::sleep(Duration::from_millis(250));
    if !original_clipboard.is_empty() {
        let _ = app.clipboard().write_text(original_clipboard);
    }

    Ok(())
}

// ── Platform helpers ─────────────────────────────────────────────────────────

/// Simulate Ctrl+C / Cmd+C in the currently focused window.
fn simulate_copy() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_send_ctrl_key('C')
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to keystroke \"c\" using {command down}",
            ])
            .output()
            .map(|_| ())
            .map_err(|e| format!("osascript failed: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdotool")
            .args(["key", "--clearmodifiers", "ctrl+c"])
            .output()
            .map(|_| ())
            .map_err(|e| format!("xdotool failed: {e}"))
    }
}

/// Simulate Ctrl+V / Cmd+V in the currently focused window.
fn simulate_paste() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_send_ctrl_key('V')
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"System Events\" to keystroke \"v\" using {command down}",
            ])
            .output()
            .map(|_| ())
            .map_err(|e| format!("osascript failed: {e}"))
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdotool")
            .args(["key", "--clearmodifiers", "ctrl+v"])
            .output()
            .map(|_| ())
            .map_err(|e| format!("xdotool failed: {e}"))
    }
}

#[cfg(target_os = "windows")]
fn windows_send_ctrl_key(vk_char: char) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_CONTROL,
    };

    let vk = VIRTUAL_KEY(vk_char.to_ascii_uppercase() as u16);

    // Ensure modifier keys the user may still be holding are released first
    // (Shift from Ctrl+Shift+G is the usual culprit).
    windows_release_modifiers();

    unsafe {
        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: Default::default(),
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VK_CONTROL,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];

        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent as usize != inputs.len() {
            return Err(format!(
                "SendInput sent {sent}/{} events (Win32 error)",
                inputs.len()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_release_modifiers() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
        VK_LWIN, VK_MENU, VK_SHIFT,
    };

    unsafe {
        let keys = [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN];
        let inputs: Vec<INPUT> = keys
            .iter()
            .map(|vk| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: *vk,
                        wScan: 0,
                        dwFlags: KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            })
            .collect();
        let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Cursor position in screen pixels.
fn cursor_position() -> (i32, i32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        unsafe {
            let mut pt = POINT { x: 100, y: 100 };
            if GetCursorPos(&mut pt).is_ok() {
                return (pt.x, pt.y);
            }
        }
        return (100, 100);
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = std::process::Command::new("xdotool")
            .args(["getmouselocation", "--shell"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            let x = text
                .lines()
                .find(|l| l.starts_with("X="))
                .and_then(|l| l[2..].parse::<i32>().ok())
                .unwrap_or(100);
            let y = text
                .lines()
                .find(|l| l.starts_with("Y="))
                .and_then(|l| l[2..].parse::<i32>().ok())
                .unwrap_or(100);
            return (x, y);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {}
    (100, 100)
}

/// Opaque id of the currently focused window (stringified HWND / X11 id).
fn active_window_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                None
            } else {
                Some((hwnd.0 as isize).to_string())
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let out = std::process::Command::new("xdotool")
            .arg("getactivewindow")
            .output()
            .ok()?;
        let id = String::from_utf8(out.stdout).ok()?.trim().to_string();
        if id.is_empty() {
            None
        } else {
            Some(id)
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

/// Focus a previously captured window. Returns true if focus was requested.
fn focus_window(id: Option<&str>) -> bool {
    let Some(id) = id else {
        return false;
    };

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow,
            SW_RESTORE,
        };

        let Ok(hwnd_val) = id.parse::<isize>() else {
            return false;
        };
        let target = HWND(hwnd_val as *mut _);

        unsafe {
            // Restore if minimized, then force-foreground via AttachThreadInput.
            let _ = ShowWindow(target, SW_RESTORE);

            let fg = GetForegroundWindow();
            let fg_tid = GetWindowThreadProcessId(fg, None);
            let cur_tid = GetCurrentThreadId();

            if fg_tid != 0 && fg_tid != cur_tid {
                let _ = AttachThreadInput(cur_tid, fg_tid, true);
            }
            let target_tid = GetWindowThreadProcessId(target, None);
            if target_tid != 0 && target_tid != cur_tid {
                let _ = AttachThreadInput(cur_tid, target_tid, true);
            }

            let ok = SetForegroundWindow(target).as_bool();

            if target_tid != 0 && target_tid != cur_tid {
                let _ = AttachThreadInput(cur_tid, target_tid, false);
            }
            if fg_tid != 0 && fg_tid != cur_tid {
                let _ = AttachThreadInput(cur_tid, fg_tid, false);
            }

            return ok;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("xdotool")
            .args(["windowfocus", "--sync", id])
            .status();
        return status.map(|s| s.success()).unwrap_or(false);
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = id;
        false
    }
}

/// Clamp the widget so it stays inside the monitor the cursor is on.
fn clamped_position(
    window: &tauri::WebviewWindow,
    cursor_x: i32,
    cursor_y: i32,
    win_w: i32,
    win_h: i32,
) -> (i32, i32) {
    let offset = 22i32;
    let mut x = cursor_x + offset;
    let mut y = cursor_y + offset;

    if let Ok(monitors) = window.available_monitors() {
        for m in &monitors {
            let pos = m.position();
            let size = m.size();
            let mx = pos.x;
            let my = pos.y;
            let mw = size.width as i32;
            let mh = size.height as i32;

            if cursor_x >= mx && cursor_x < mx + mw && cursor_y >= my && cursor_y < my + mh {
                if x + win_w > mx + mw {
                    x = cursor_x - win_w - offset;
                }
                if y + win_h > my + mh {
                    y = cursor_y - win_h - offset;
                }
                x = x.max(mx);
                y = y.max(my);
                break;
            }
        }
    }

    (x, y)
}

/// Poll clipboard until it differs from `sentinel`, or timeout.
fn poll_clipboard(app: &AppHandle, sentinel: &str) -> String {
    const ATTEMPTS: u32 = 12;
    const INTERVAL_MS: u64 = 25;

    for _ in 0..ATTEMPTS {
        std::thread::sleep(Duration::from_millis(INTERVAL_MS));
        let current = app.clipboard().read_text().unwrap_or_default();
        if !current.is_empty() && current != sentinel {
            return current;
        }
    }
    app.clipboard().read_text().unwrap_or_default()
}

// ── Hotkey handler ───────────────────────────────────────────────────────────

fn handle_hotkey(app: &AppHandle) {
    // Snapshot while the source app is still focused (widget is hidden).
    let (cursor_x, cursor_y) = cursor_position();
    let source_win = active_window_id();
    let app = app.clone();

    std::thread::spawn(move || {
        // Let physical modifier keys settle after hotkey release.
        std::thread::sleep(Duration::from_millis(80));

        if let Err(e) = capture_and_show(&app, cursor_x, cursor_y, source_win) {
            eprintln!("[WriteUp] capture error: {e}");
        }
    });
}

/// Core capture flow (FR-1 + FR-2 + FR-3 + FR-8).
fn capture_and_show(
    app: &AppHandle,
    cursor_x: i32,
    cursor_y: i32,
    source_win: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    const SENTINEL: &str = "__WA_SENTINEL_7F3A__";
    const MAX_LEN: usize = 3000;

    // Keep / restore focus on the source app before simulating Ctrl+C.
    if !focus_window(source_win.as_deref()) {
        eprintln!("[WriteUp] could not refocus source window; copying into current focus");
    } else {
        std::thread::sleep(Duration::from_millis(80));
    }

    // 1. Save original clipboard content.
    let original_clipboard = app.clipboard().read_text().unwrap_or_default();

    // 2. Write sentinel so we can detect empty / unchanged clipboard.
    app.clipboard().write_text(SENTINEL)?;

    // 3. Simulate Ctrl+C in the focused (source) window.
    simulate_copy()?;

    // 4. Poll until clipboard updates (or timeout ~300ms).
    let captured = poll_clipboard(app, SENTINEL);

    // 5. Restore original clipboard ≤ 300 ms after capture (FR-2).
    let _ = app.clipboard().write_text(&original_clipboard);

    {
        let state = app.state::<AppState>();
        *state.original_clipboard.lock().unwrap() = original_clipboard;
        *state.source_window.lock().unwrap() = source_win;
    }

    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;

    let (wx, wy) = clamped_position(&window, cursor_x, cursor_y, 440, 560);
    window.set_position(PhysicalPosition::new(wx, wy))?;

    // 6. No-selection case (FR-8 / flow 7.2).
    if captured.is_empty() || captured == SENTINEL {
        eprintln!("[WriteUp] no selection captured (clipboard unchanged)");
        window.emit("state-change", serde_json::json!({ "type": "no_selection" }))?;
        window.show()?;
        return Ok(());
    }

    eprintln!("[WriteUp] captured {} chars", captured.len());

    // 7. Over-length text (FR-8).
    let truncated = captured.len() > MAX_LEN;
    let text: String = if truncated {
        captured.chars().take(MAX_LEN).collect()
    } else {
        captured
    };

    {
        let state = app.state::<AppState>();
        *state.captured_text.lock().unwrap() = text.clone();
    }

    window.emit(
        "state-change",
        serde_json::json!({
            "type": "ready",
            "text": text,
            "truncated": truncated,
        }),
    )?;
    window.show()?;
    window.set_focus()?;

    Ok(())
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Fire on release so Ctrl/Shift are no longer held when we
                    // synthesize Ctrl+C (Pressed races with stuck modifiers).
                    if event.state() == ShortcutState::Released {
                        handle_hotkey(app);
                    }
                })
                .build(),
        )
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            get_captured_text,
            get_last_tone,
            set_last_tone,
            dismiss_widget,
            paste_back,
        ])
        .setup(|app| {
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            let _ = app.global_shortcut().unregister("CmdOrCtrl+Shift+G");
            app.global_shortcut()
                .register("CmdOrCtrl+Shift+G")?;
            eprintln!("[WriteUp] global hotkey registered: Ctrl+Shift+G");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
