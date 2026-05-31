//! Application menu bar module.
//!
//! Creates a native menu bar for macOS and Windows using Tauri's menu API.
//! Supports internationalization by rebuilding the menu when the locale changes.

use crate::window_manager::create_window;
use std::sync::Mutex;
use tauri::{
    menu::{AboutMetadata, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

/// Current locale stored in the backend, defaults to "en".
static CURRENT_LOCALE: Mutex<String> = Mutex::new(String::new());

/// Menu item IDs — used to identify custom menu items in event handlers.
const MENU_ID_NEW_WINDOW: &str = "new_window";
const MENU_ID_SETTINGS: &str = "settings";

// ---------------------------------------------------------------------------
// Locale strings
// ---------------------------------------------------------------------------

/// Struct holding all translatable menu strings for a given locale.
///
/// Note: Some fields (e.g. undo, redo, cut, copy, paste, select_all, minimize,
/// maximize, bring_all_to_front, hide, hide_others, show_all, quit, about,
/// services, fullscreen) correspond to Tauri's predefined menu items whose
/// text is set via builder methods. These strings are kept for documentation
/// completeness and future use (e.g. manual menu reconstruction), but are
/// not directly referenced in the current builder flow.
#[allow(dead_code)]
struct MenuStrings {
    app_name: String,
    about: String,
    services: String,
    hide: String,
    hide_others: String,
    show_all: String,
    quit: String,
    file: String,
    new_window: String,
    close_window: String,
    edit: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    view: String,
    fullscreen: String,
    minimize: String,
    maximize: String,
    window: String,
    bring_all_to_front: String,
    help: String,
}

impl MenuStrings {
    fn for_locale(locale: &str) -> Self {
        match locale {
            "zh" => Self {
                app_name: "TalkCody".to_string(),
                about: "关于 TalkCody".to_string(),
                services: "服务".to_string(),
                hide: "隐藏 TalkCody".to_string(),
                hide_others: "隐藏其他".to_string(),
                show_all: "显示全部".to_string(),
                quit: "退出 TalkCody".to_string(),
                file: "文件".to_string(),
                new_window: "新建窗口".to_string(),
                close_window: "关闭窗口".to_string(),
                edit: "编辑".to_string(),
                undo: "撤销".to_string(),
                redo: "重做".to_string(),
                cut: "剪切".to_string(),
                copy: "复制".to_string(),
                paste: "粘贴".to_string(),
                select_all: "全选".to_string(),
                view: "视图".to_string(),
                fullscreen: "切换全屏".to_string(),
                minimize: "最小化".to_string(),
                maximize: "最大化".to_string(),
                window: "窗口".to_string(),
                bring_all_to_front: "全部置于顶层".to_string(),
                help: "帮助".to_string(),
            },
            // Default: English
            _ => Self {
                app_name: "TalkCody".to_string(),
                about: "About TalkCody".to_string(),
                services: "Services".to_string(),
                hide: "Hide TalkCody".to_string(),
                hide_others: "Hide Others".to_string(),
                show_all: "Show All".to_string(),
                quit: "Quit TalkCody".to_string(),
                file: "File".to_string(),
                new_window: "New Window".to_string(),
                close_window: "Close Window".to_string(),
                edit: "Edit".to_string(),
                undo: "Undo".to_string(),
                redo: "Redo".to_string(),
                cut: "Cut".to_string(),
                copy: "Copy".to_string(),
                paste: "Paste".to_string(),
                select_all: "Select All".to_string(),
                view: "View".to_string(),
                fullscreen: "Toggle Full Screen".to_string(),
                minimize: "Minimize".to_string(),
                maximize: "Maximize".to_string(),
                window: "Window".to_string(),
                bring_all_to_front: "Bring All to Front".to_string(),
                help: "Help".to_string(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Menu construction
// ---------------------------------------------------------------------------

/// Build the application menu bar for the given locale.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>, locale: &str) -> Result<(), String> {
    let s = MenuStrings::for_locale(locale);

    // ---- App / TalkCody submenu (macOS only, but we build it everywhere for consistency) ----
    let app_submenu = SubmenuBuilder::new(app, &s.app_name)
        .about(Some(AboutMetadata {
            ..Default::default()
        }))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .quit()
        .build()
        .map_err(|e| format!("Failed to build app submenu: {e}"))?;

    // ---- File submenu ----
    let new_window_item =
        MenuItem::with_id(app, MENU_ID_NEW_WINDOW, &s.new_window, true, None::<&str>)
            .map_err(|e| format!("Failed to create new window menu item: {e}"))?;

    let close_window_item = PredefinedMenuItem::close_window(app, Some(&s.close_window))
        .map_err(|e| format!("Failed to create close window menu item: {e}"))?;

    let file_submenu = SubmenuBuilder::new(app, &s.file)
        .item(&new_window_item)
        .separator()
        .item(&close_window_item)
        .build()
        .map_err(|e| format!("Failed to build file submenu: {e}"))?;

    // ---- Edit submenu ----
    let edit_submenu = SubmenuBuilder::new(app, &s.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()
        .map_err(|e| format!("Failed to build edit submenu: {e}"))?;

    // ---- View submenu ----
    let view_submenu = SubmenuBuilder::new(app, &s.view)
        .fullscreen()
        .build()
        .map_err(|e| format!("Failed to build view submenu: {e}"))?;

    // ---- Window submenu ----
    let window_submenu = SubmenuBuilder::new(app, &s.window)
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()
        .map_err(|e| format!("Failed to build window submenu: {e}"))?;

    // ---- Assemble the menu bar ----
    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()
        .map_err(|e| format!("Failed to build menu: {e}"))?;

    app.set_menu(menu)
        .map_err(|e| format!("Failed to set menu: {e}"))?;

    // Store the current locale
    if let Ok(mut current) = CURRENT_LOCALE.lock() {
        *current = locale.to_string();
    }

    log::info!("Application menu built for locale: {}", locale);
    Ok(())
}

// ---------------------------------------------------------------------------
// Menu event handler
// ---------------------------------------------------------------------------

/// Handle menu events from the native menu bar.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: &tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_ID_NEW_WINDOW => {
            log::info!("Menu: New Window triggered");
            let app_handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let window_registry = app_handle
                    .state::<crate::AppState>()
                    .window_registry
                    .clone();
                if let Err(e) = create_window(&app_handle, &window_registry, None, None, true) {
                    log::error!("Failed to create new window from menu: {}", e);
                }
            });
        }
        MENU_ID_SETTINGS => {
            // Emit event to frontend to navigate to settings
            let _ = app.emit("menu-event", "settings");
        }
        _ => {
            // Other menu items are handled by Tauri's predefined handlers
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri command: update locale from frontend
// ---------------------------------------------------------------------------

/// Tauri command called from the frontend when the locale changes.
/// Rebuilds the menu bar with the new locale strings.
#[tauri::command]
pub fn update_menu_locale<R: Runtime>(app: AppHandle<R>, locale: String) -> Result<(), String> {
    // Skip rebuild if locale hasn't changed
    {
        if let Ok(current) = CURRENT_LOCALE.lock() {
            if *current == locale {
                return Ok(());
            }
        }
    }

    log::info!("Updating menu locale to: {}", locale);
    build_app_menu(&app, &locale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_menu_strings_english() {
        let s = MenuStrings::for_locale("en");
        assert_eq!(s.file, "File");
        assert_eq!(s.edit, "Edit");
        assert_eq!(s.view, "View");
        assert_eq!(s.window, "Window");
        assert_eq!(s.new_window, "New Window");
        assert_eq!(s.close_window, "Close Window");
    }

    #[test]
    fn test_menu_strings_chinese() {
        let s = MenuStrings::for_locale("zh");
        assert_eq!(s.file, "文件");
        assert_eq!(s.edit, "编辑");
        assert_eq!(s.view, "视图");
        assert_eq!(s.window, "窗口");
        assert_eq!(s.new_window, "新建窗口");
        assert_eq!(s.close_window, "关闭窗口");
    }

    #[test]
    fn test_menu_strings_unknown_defaults_to_english() {
        let s = MenuStrings::for_locale("fr");
        assert_eq!(s.file, "File");
        assert_eq!(s.new_window, "New Window");
    }
}
