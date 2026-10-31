//! MIND Wake desktop : icône de zone de notification avec voyant, sélecteur
//! On / Réveil / Force-off, panneau « Que fait mon agent ? » et fils privés (SPEC §21,
//! §23). Client local des CLI : fermer ou faire planter le panneau n'arrête ni ne relance
//! Wake ; chaque action est la commande CLI correspondante (ADR-007, agent-first).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod quick_input;
mod windows_startup;
mod updates;
mod startup_receipt;
mod documents;
mod conversation_images;
mod external_urls;
mod authorizations;

use cli::{CliRun, OwnerRequest, Verb};
use std::time::Duration;
use std::sync::atomic::Ordering;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry, WindowEvent};

/// Intervalle du voyant de l'icône, indépendant du panneau (qui relit toutes les 2 s).
const LIGHT_POLL: Duration = Duration::from_secs(3);

#[tauri::command]
fn app_restart(app: AppHandle) {
    if std::env::var("MIND_WAKE_DESKTOP_SUPERVISED").as_deref() == Ok("1") {
        // The supervisor reloads the installation manifest, including installed updates.
        app.exit(75);
    } else {
        app.restart();
    }
}

#[tauri::command]
fn app_fullscreen(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_fullscreen(enabled).map_err(|e| e.to_string())
}

async fn blocking<F>(f: F) -> Result<CliRun, String>
where
    F: FnOnce() -> Result<CliRun, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wake_status() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Status)).await
}

#[tauri::command]
async fn wake_restart() -> Result<CliRun, String> {
    blocking(cli::restart_daemon).await
}

#[tauri::command]
async fn wake_journal() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Journal)).await
}

#[tauri::command]
async fn wake_pause() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Pause)).await
}

#[tauri::command]
async fn wake_resume() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Resume)).await
}

#[tauri::command]
async fn wake_stop() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Stop)).await
}

#[tauri::command]
async fn wake_on() -> Result<CliRun, String> { blocking(|| cli::wake(Verb::On)).await }

#[tauri::command]
async fn wake_always_on() -> Result<CliRun, String> { blocking(cli::always_on).await }

#[tauri::command]
async fn wake_now() -> Result<CliRun, String> {
    blocking(cli::wake_now).await
}

#[tauri::command]
async fn wake_messages() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::Messages)).await
}

#[tauri::command]
async fn wake_history() -> Result<CliRun, String> {
    blocking(|| cli::wake(Verb::WakeHistory)).await
}

#[tauri::command]
async fn workspace_sync_status() -> Result<CliRun, String> {
    blocking(|| cli::workspace_sync("status", None)).await
}

#[tauri::command]
async fn workspace_sync_configure(workspace_dir: String, github_url: String, enabled: bool) -> Result<CliRun, String> {
    blocking(move || cli::workspace_sync("configure", Some((workspace_dir, github_url, enabled)))).await
}

#[tauri::command]
async fn workspace_sync_now() -> Result<CliRun, String> {
    blocking(|| cli::workspace_sync("now", None)).await
}

#[tauri::command]
async fn wake_open_location(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || cli::open_wake_location(&kind))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || external_urls::open(&url))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn wake_reply(idempotency_key: String, text: String) -> Result<CliRun, String> {
    blocking(move || cli::wake_reply(idempotency_key, text)).await
}

#[tauri::command]
async fn recipient_status() -> Result<CliRun, String> { blocking(|| cli::recipient("status",None,None)).await }
#[tauri::command]
async fn recipient_poll() -> Result<CliRun, String> { blocking(|| cli::recipient("poll",None,None)).await }
#[tauri::command]
async fn recipient_send(idempotency_key:String,text:String) -> Result<CliRun,String> { blocking(move || cli::recipient("send",Some(idempotency_key),Some(text))).await }

#[tauri::command]
fn quick_input_close(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "quick-input" { return Err("Fenêtre invalide".into()); }
    quick_input::dismiss(&window)
}

#[tauri::command]
async fn quick_input_send(window: tauri::WebviewWindow, idempotency_key: String, text: String, click_id: u64) -> Result<(), String> {
    if window.label() != "quick-input" { return Err("Fenêtre invalide".into()); }
    let point = quick_input::click_point(click_id)?;
    let targeted_bump = idempotency_key.starts_with("ui-bumpe-");
    if quick_input::SENDING.swap(true, Ordering::SeqCst) { return Err("Envoi déjà en cours".into()); }
    if targeted_bump { quick_input::mark_unconfirmed(point); }
    // Remove our menu from the image of the actual selected point.
    let result = match window.hide() {
        Ok(()) => blocking(move || cli::quick_reply(idempotency_key, text, Some(point))).await,
        Err(error) => Err(format!("Menu impossible à masquer ; aucun message envoyé : {error}")),
    };
    // Confirm persistence before success; errors restore the hidden menu and keep its draft.
    let result = result.and_then(|run| {
        if run.exit_code != 0 {
            let value = serde_json::from_str::<serde_json::Value>(&run.stdout).ok();
            let detail = value.as_ref().and_then(|v| v["data"]["detail"].as_str().map(str::to_owned));
            if targeted_bump && value.as_ref().is_some_and(|v| v["data"]["status"].as_str() == Some("refused")) {
                quick_input::finish_point(click_id,true);
                return Err(format!("POINT_REFRESH_REQUIRED: {} Refaire un clic droit pour choisir le contexte actuel.",detail.unwrap_or_else(|| "Aucun message envoyé.".into())));
            }
            return Err(detail.unwrap_or_else(|| "Envoi non confirmé ; réessayer pour vérifier le même envoi, sans nouvelle capture si déjà enregistré.".into()));
        }
        if targeted_bump { quick_input::finish_point(click_id,false); }
        let _ = window.hide();
        // Bumpe follows Bump's queue semantics. Preserve ordinary quick-message wake.
        if !targeted_bump { tauri::async_runtime::spawn_blocking(cli::wake_after_quick_reply); }
        Ok(())
    });
    if result.is_err() && !quick_input::DISMISSED.load(Ordering::SeqCst) { quick_input::show_without_focus(&window); }
    quick_input::SENDING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
async fn helpers_answers() -> Result<CliRun, String> {
    blocking(cli::helpers_answers).await
}

#[tauri::command]
async fn owner_threads() -> Result<CliRun, String> {
    blocking(|| cli::owner(OwnerRequest::Threads)).await
}

#[tauri::command]
async fn owner_thread(thread_id: String) -> Result<CliRun, String> {
    blocking(move || cli::owner(OwnerRequest::Thread { thread_id })).await
}

#[tauri::command]
async fn owner_reply(
    thread_id: String,
    in_reply_to: Option<String>,
    idempotency_key: String,
    text: String,
) -> Result<CliRun, String> {
    blocking(move || {
        cli::owner(OwnerRequest::Reply { thread_id, in_reply_to, idempotency_key, text })
    })
    .await
}

/// Voyant : dérivé de `profile.state` de `status --json`, comme `desktop/ui/view.ts`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Light {
    Awake,
    On,
    Off,
    ForcedOff,
    Unknown,
}

impl Light {
    fn of(run: &Result<CliRun, String>) -> Light {
        let Ok(run) = run else { return Light::Unknown };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&run.stdout) else {
            return Light::Unknown;
        };
        if json["schema"] != "mind-wake.cli" || json["schemaVersion"] != 1 {
            return Light::Unknown;
        }
        match json["data"]["profile"]["state"].as_str() {
            Some("running" | "checkpointing") => Light::Awake,
            Some("ready" | "hibernating") => Light::On,
            Some("paused" | "blocked" | "disabled") => Light::Off,
            Some("stopped") => Light::ForcedOff,
            _ => Light::Unknown,
        }
    }

    fn icon(self) -> &'static [u8] {
        match self {
            Light::Awake => include_bytes!("../icons/tray-awake.png"),
            Light::On => include_bytes!("../icons/tray-on.png"),
            Light::Off => include_bytes!("../icons/tray-off.png"),
            Light::ForcedOff => include_bytes!("../icons/tray-forced_off.png"),
            Light::Unknown => include_bytes!("../icons/tray-unknown.png"),
        }
    }

    fn tooltip(self) -> &'static str {
        match self {
            Light::Awake => "MIND Wake — éveillé : une session tourne",
            Light::On => "MIND Wake — allumé : réveils autorisés dans les fenêtres",
            Light::Off => "MIND Wake — éteint (pause, blocage ou désactivé)",
            Light::ForcedOff => "MIND Wake — arrêt forcé (arrêt d'urgence)",
            Light::Unknown => "MIND Wake — état indisponible",
        }
    }
}

/// Sélecteur On / Réveil / Force-off du menu : coché d'après l'état réel, jamais d'après
/// le dernier clic.
struct Switch {
    on: CheckMenuItem<Wry>,
    wake: CheckMenuItem<Wry>,
    always: CheckMenuItem<Wry>,
    off: CheckMenuItem<Wry>,
}

impl Switch {
    fn show(&self, light: Light, always_on: bool) {
        let _ = self.on.set_checked(light == Light::On && !always_on);
        let _ = self.wake.set_checked(light == Light::Awake && !always_on);
        let _ = self.off.set_checked(light == Light::ForcedOff);
        let _ = self.always.set_checked(always_on);
        // Selecting Always-on explicitly reactivates through the validated CLI path.
        let _ = self.always.set_enabled(true);
        // Après un arrêt d'urgence, seule une commande explicite hors menu peut relancer.
        let _ = self.on.set_enabled(light != Light::ForcedOff);
        let _ = self.wake.set_enabled(light != Light::ForcedOff);
    }
}

fn refresh_light(tray: &TrayIcon<Wry>, switch: &Switch) {
    let status = cli::wake(Verb::Status);
    let light = Light::of(&status);
    let always_on = status.as_ref().ok().and_then(|r| serde_json::from_str::<serde_json::Value>(&r.stdout).ok()).map(|j| j["data"]["executionMode"] == "always-on" && matches!(light, Light::On | Light::Awake)).unwrap_or(false);
    if let Ok(icon) = Image::from_bytes(light.icon()) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(light.tooltip()));
    switch.show(light, always_on);
}

fn show_panel(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Exécute une commande du menu puis relit l'état pour le voyant et le sélecteur.
fn menu_action(app: &AppHandle, verb: Verb) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = if matches!(verb, Verb::Wake) { cli::wake_now() } else if matches!(verb, Verb::AlwaysOn) { cli::always_on() } else { cli::wake(verb) };
        if let (Some(tray), Some(switch)) = (app.tray_by_id("wake"), app.try_state::<Switch>()) {
            refresh_light(&tray, &switch);
        }
    });
}

fn main() {
    tauri::Builder::default()
        // Un seul panneau : relancer l'application (menu Démarrer) rouvre le panneau existant.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel(app)))
        .invoke_handler(tauri::generate_handler![
            app_restart,
            wake_restart,
            app_fullscreen,
            documents::document_browse,
            documents::conversation_image,
            authorizations::authorizations_read,
            authorizations::authorizations_save,
            updates::app_update,
            updates::app_version,
            wake_status,
            wake_journal,
            wake_pause,
            wake_resume,
            wake_stop,
            wake_now,
            wake_on,
            wake_always_on,
            wake_messages,            wake_history,
            workspace_sync_status,
            workspace_sync_configure,
            workspace_sync_now,
            wake_open_location,
            open_external_url,
            wake_reply,
            quick_input_close,
            quick_input_send,
            helpers_answers,
            owner_threads,
            recipient_status,
            recipient_poll,
            recipient_send,
            owner_thread,
            owner_reply
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "quick-input", tauri::WebviewUrl::App("quick-input.html".into()))
                .title("Parler à Wake").inner_size(460.0, 240.0).resizable(false)
                .decorations(false).always_on_top(true).skip_taskbar(true).visible(false).build()?;
            let quick = CheckMenuItem::with_id(app, "quick_input", "Clic droit — saisie rapide", true, true, None::<&str>)?;
            if quick_input::start(app.handle().clone()).is_err() {
                quick.set_checked(false)?;
                quick.set_enabled(false)?;
                quick.set_text("Clic droit — indisponible")?;
            }
            let open = MenuItem::with_id(app, "open", "Ouvrir le panneau", true, None::<&str>)?;
            let startup = CheckMenuItem::with_id(app, "windows_startup", "Démarrer avec Windows", false, false, None::<&str>)?;
            let on = CheckMenuItem::with_id(app, "mode_on", "On — réveils autorisés", true, false, None::<&str>)?;
            let wake = CheckMenuItem::with_id(app, "mode_wake", "Réveil — maintenant", true, false, None::<&str>)?;
            let always = CheckMenuItem::with_id(app, "mode_always", "Always-on — enchaîner les réponses", true, false, None::<&str>)?;
            let off = CheckMenuItem::with_id(app, "mode_off", "Force-off — arrêt d'urgence", true, false, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quitter le panneau (Wake continue)", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &quick,
                    &startup,
                    &PredefinedMenuItem::separator(app)?,
                    &on,
                    &wake,
                    &always,
                    &off,
                    &pause,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let tray = TrayIconBuilder::with_id("wake")
                .icon(Image::from_bytes(Light::Unknown.icon())?)
                .tooltip(Light::Unknown.tooltip())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_panel(app),
                    "windows_startup" => windows_startup::refresh(app, true),
                    "quick_input" => {
                        let enabled = !quick_input::ENABLED.load(Ordering::Relaxed);
                        quick_input::ENABLED.store(enabled, Ordering::Relaxed);
                        if !enabled && !quick_input::SENDING.load(Ordering::Relaxed) {
                            if let Some(window) = app.get_webview_window("quick-input") { let _=window.hide(); }
                        }
                    }
                    // « On » lève une pause ; la CLI refuse après un arrêt d'urgence.
                    "mode_on" => menu_action(app, Verb::On),
                    "mode_always" => menu_action(app, Verb::AlwaysOn),
                    "mode_wake" => menu_action(app, Verb::Wake),
                    "mode_off" => {
                        menu_action(app, Verb::Stop);
                        show_panel(app);
                    }
                    "pause" => menu_action(app, Verb::Pause),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_panel(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(Switch { on, wake, always, off });
            app.manage(windows_startup::StartupMenu(startup));
            windows_startup::refresh(app.handle(), false);
            updates::start();
            startup_receipt::write()?;

            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if let Some(switch) = handle.try_state::<Switch>() {
                    refresh_light(&tray, &switch);
                }
                std::thread::sleep(LIGHT_POLL);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer la fenêtre masque le panneau ; l'icône reste et Wake n'est pas affecté.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "quick-input" {
                    if let Some(input) = window.get_webview_window("quick-input") { let _ = quick_input::dismiss(&input); }
                    return;
                }
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage du panneau MIND Wake");
}
