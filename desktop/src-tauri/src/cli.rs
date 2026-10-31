//! Appel des CLI locales : seul chemin du panneau vers Wake (`mind-wake`) et vers les fils
//! privés de l'humain (`services/mcp/owner-main.ts`). Le panneau n'ouvre ni SQLite, ni
//! port, ni pipe ; il exécute une sous-commande d'une liste fermée avec `--json` et rend
//! la sortie telle quelle. Les permissions restent imposées par la CLI, le hub et le
//! policy engine, pas par cette interface (SPEC §21.4, ADR-007).

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Au-delà, la commande est terminée et le panneau affiche « état indisponible ».
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRun {
    pub exit_code: i32,
    pub stdout: String,
}

/// Sous-commandes `mind-wake` autorisées.
#[derive(Clone, Copy)]
pub enum Verb {
    Status,
    Journal,
    Pause,
    Resume,
    On,
    AlwaysOn,
    Stop,
    Wake,
    Messages,
    WakeHistory,
}

impl Verb {
    fn args(self) -> &'static [&'static str] {
        match self {
            Verb::Status => &["status"],
            Verb::Journal => &["journal", "--limit", "1000"],
            Verb::Pause => &["pause"],
            Verb::Resume => &["resume"],
            Verb::On => &["on"],
            Verb::AlwaysOn => &["always-on"],
            Verb::Stop => &["stop"],
            Verb::Wake => &["wake"],
            Verb::Messages => &["messages"],
            Verb::WakeHistory => &["wake-history"],
        }
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn repo() -> PathBuf {
    env_path("MIND_WAKE_REPO_DIR")
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

/// `MIND_WAKE_NODE` (chemin absolu de node.exe) sinon `node` du PATH.
fn node() -> PathBuf {
    env_path("MIND_WAKE_NODE").unwrap_or_else(|| PathBuf::from("node"))
}

/// `MIND_WAKE_CLI` sinon `dist/cli/main.js` du dépôt. Défaut de développement seulement :
/// le paquet distribué fixera ses chemins (F5).
fn wake_script() -> PathBuf {
    env_path("MIND_WAKE_CLI").unwrap_or_else(|| repo().join("dist/cli/main.js"))
}

/// `MIND_OWNER_CLI` sinon `services/mcp/owner-main.ts`, exécuté depuis les sources comme
/// le hub (type stripping et hooks de résolution du dépôt).
fn owner_command() -> Vec<OsString> {
    let script = env_path("MIND_OWNER_CLI").unwrap_or_else(|| repo().join("services/mcp/owner-main.ts"));
    let hooks = repo().join("test/fixtures/store-ledger/ts-hooks.ts");
    let hooks_url = format!("file:///{}", hooks.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    vec![
        "--disable-warning=ExperimentalWarning".into(),
        "--experimental-transform-types".into(),
        "--import".into(),
        hooks_url.into(),
        script.into(),
    ]
}

/// Réponses des sessions Claude Code / Codex réveillées pour aider l'agent
/// (`services/helpers/helpers-main.ts answers --json`, état dans MIND_WAKE_HELPERS_DIR).
pub fn helpers_answers() -> Result<CliRun, String> {
    let mut args = owner_command();
    args.pop();
    args.push(repo().join("services/helpers/helpers-main.ts").into());
    args.push("answers".into());
    run(args, None)
}

fn wake_args(verb_args: &[&str]) -> Result<Vec<OsString>, String> {
    let script = wake_script();
    if !script.is_file() {
        return Err(format!(
            "CLI introuvable ({}) : lancer `npm run build` ou définir MIND_WAKE_CLI",
            script.display()
        ));
    }
    let mut args: Vec<OsString> = vec![script.into()];
    args.extend(verb_args.iter().map(OsString::from));
    Ok(args)
}

pub fn wake(verb: Verb) -> Result<CliRun, String> {
    run(wake_args(verb.args())?, None)
}

/// Read-only local Git binding; no endpoint or path is accepted from the webview.
pub fn aurore_document(relative: String, read: bool, image: bool, version: Option<String>) -> Result<CliRun, String> {
    let input = serde_json::json!({"relative": relative, "read": read, "image": image, "version": version}).to_string();
    run(vec![repo().join("services/shared-workspace/git-document-reader-main.mjs").into()], Some(input))
}

/// Fixed profile-local operations. Values are separate argv entries, never shell text.
pub fn workspace_sync(action: &str, configuration: Option<(String, String, bool)>) -> Result<CliRun, String> {
    if !matches!(action, "status" | "configure" | "now") {
        return Err("Action de synchronisation inconnue".into());
    }
    let mut args = wake_args(&["workspace-sync", action])?;
    if action == "configure" {
        let (workspace, github, enabled) = configuration.ok_or("Réglages manquants")?;
        if !std::path::Path::new(&workspace).is_absolute() || workspace.contains('\0') || github.contains('\0') {
            return Err("Dossier absolu et URL valides requis".into());
        }
        args.extend(["--workspace".into(), workspace.into(), "--github-url".into(), github.into(),
            "--enabled".into(), if enabled { "true" } else { "false" }.into()]);
    }
    run(args, None)
}

/// Opens only fixed locations resolved by the local Wake CLI, never a webview-supplied path.
pub fn open_wake_location(kind: &str) -> Result<(), String> {
    if kind != "workspace" && kind != "systemPrompt" { return Err("Emplacement inconnu".into()); }
    let history = wake(Verb::WakeHistory)?;
    let envelope: serde_json::Value = serde_json::from_str(&history.stdout).map_err(|e| e.to_string())?;
    if history.exit_code != 0 { return Err("Emplacements de l’agent indisponibles".into()); }
    let file = envelope["data"]["locations"][kind].as_str().ok_or("Prompt système pas encore disponible")?;
    let target = PathBuf::from(file).canonicalize().map_err(|e| e.to_string())?;
    if kind == "workspace" {
        if !target.is_dir() { return Err("Dossier de l’agent introuvable".into()); }
        Command::new("explorer.exe").arg(target).spawn().map_err(|e| e.to_string())?;
    } else {
        if !target.is_file() || target.extension().and_then(|s| s.to_str()) != Some("md") {
            return Err("Fichier du prompt invalide".into());
        }
        Command::new("notepad.exe").arg(target).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bouton « Réveil » : démarre le daemon s'il ne tourne pas, puis demande la session.
/// Le daemon est détaché du panneau (le fermer ne l'arrête pas) ; sa sortie va dans
/// `daemon.log` du dossier de données.
pub fn wake_now() -> Result<CliRun, String> {
    let status = wake(Verb::Status)?;
    let running = serde_json::from_str::<serde_json::Value>(&status.stdout)
        .map(|j| j["data"]["daemon"]["state"] == "running")
        .unwrap_or(false);
    let requested = wake(Verb::Wake)?;
    if !running {
        start_daemon(&status.stdout)?;
    }
    Ok(requested)
}

pub fn always_on() -> Result<CliRun, String> {
    let status = wake(Verb::Status)?;
    let running = serde_json::from_str::<serde_json::Value>(&status.stdout).map(|j| j["data"]["daemon"]["state"] == "running").unwrap_or(false);
    // This command is an explicit user selection in the panel/tray. Revalidate the
    // consented policy through reactivate before clearing an emergency stop.
    if requires_reactivation(&status.stdout) {
        let reactivated = run(wake_args(&["reactivate"])?, None)?;
        if reactivated.exit_code != 0 { return Ok(reactivated); }
    }
    let result = wake(Verb::AlwaysOn)?;
    if result.exit_code == 0 && !running { start_daemon(&status.stdout)?; }
    Ok(result)
}

fn requires_reactivation(status: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(status)
        .map(|j| j["data"]["profile"]["state"] == "stopped" || j["data"]["profile"]["emergencyStopLocked"] == true)
        .unwrap_or(false)
}

fn start_daemon(status_json: &str) -> Result<(), String> {
    let data_dir = serde_json::from_str::<serde_json::Value>(status_json)
        .ok()
        .and_then(|j| j["data"]["dataDir"].as_str().map(PathBuf::from))
        .ok_or("dossier de données inconnu")?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("daemon.log"))
        .map_err(|e| format!("journal du daemon : {e}"))?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(node());
    let manifest = data_dir.join("installation/manifest.json");
    if manifest.is_file() {
        let installation: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let repo = installation["repoDir"].as_str().ok_or("Source installée inconnue")?;
        command.args(["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import"])
            .arg(PathBuf::from(repo).join("test/fixtures/store-ledger/ts-hooks.ts"))
            .arg(PathBuf::from(repo).join("scripts/engine-supervisor.mjs"))
            .arg("--manifest").arg(manifest);
    } else { command.args(wake_args(&["daemon", "run"]) ?); }
    command
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("démarrage du daemon : {e}"))
}

/// Explicit desktop action: replace the engine, preserving all profile controls.
/// Dropping the old engine closes its Job Objects and stops its runtime children.
pub fn restart_daemon() -> Result<CliRun, String> {
    static RESTART: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = RESTART.try_lock().map_err(|_| "Redémarrage déjà en cours")?;
    let before = wake(Verb::Status)?;
    let status: serde_json::Value = serde_json::from_str(&before.stdout).map_err(|e| e.to_string())?;
    if before.exit_code != 0 || status["ok"] != true {
        return Err("État du moteur indisponible ; aucun processus arrêté".into());
    }
    if let Some(dir) = status["data"]["dataDir"].as_str() {
        let manifest = PathBuf::from(dir).join("installation/manifest.json");
        if manifest.is_file() {
            let installation: serde_json::Value = serde_json::from_slice(&std::fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if let Some(repo) = installation["repoDir"].as_str() {
                let mut owner = Command::new(node());
                owner.args(["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import"])
                    .arg(PathBuf::from(repo).join("test/fixtures/store-ledger/ts-hooks.ts"))
                    .arg(PathBuf::from(repo).join("scripts/owned-runtime-control.mjs"))
                    .arg("--manifest").arg(&manifest).args(["--role","daemon","--action","restart"]);
                #[cfg(windows)] { use std::os::windows::process::CommandExt; owner.creation_flags(0x0800_0000); }
                if let Ok(output) = owner.output() {
                    if let Ok(result) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                        if result["owned"] == true {
                            if result["ok"] != true { return Err("Relance refusée par le propriétaire du moteur ; vérifier Pause et Force-off".into()); }
                            return wake(Verb::Status);
                        }
                    }
                }
            }
        }
    }
    let old_pid = status["data"]["daemon"]["pid"].as_u64();
    if status["data"]["daemon"]["state"] == "running" {
        let pid = old_pid.filter(|p| *p > 0 && *p <= u32::MAX as u64).ok_or("PID du moteur invalide")?;
        let started = status["data"]["daemon"]["startedAt"].as_str().ok_or("Date du moteur inconnue")?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let output = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", include_str!("restart-engine.ps1")])
                .env("WAKE_RESTART_PID", pid.to_string())
                .env("WAKE_RESTART_STARTED", started)
                .creation_flags(0x0800_0000)
                .output().map_err(|e| format!("Arrêt du moteur : {e}"))?;
            if !output.status.success() {
                return Err(format!("Moteur non redémarré : {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
        }
        #[cfg(not(windows))]
        { let _ = (pid, started); return Err("Redémarrage du moteur disponible sous Windows uniquement".into()); }
    }
    start_daemon(&before.stdout)?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(300));
        let current = wake(Verb::Status)?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&current.stdout) {
            if current.exit_code == 0 && value["data"]["daemon"]["state"] == "running"
                && (value["data"]["daemon"]["pid"].as_u64() != old_pid
                    || value["data"]["daemon"]["startedAt"] != status["data"]["daemon"]["startedAt"]) {
                return Ok(current);
            }
        }
    }
    Err("Le nouveau moteur n’a pas confirmé son démarrage. Consulter daemon.log avant de réessayer.".into())
}

/// Réponse de l'humain à son agent (`mind-wake reply`) : clé vérifiée ici puis par la CLI,
/// texte par l'entrée standard, jamais en argument.
pub fn wake_reply(key: String, text: String) -> Result<CliRun, String> {
    if !idempotency_key(&key) {
        return Err("clé d'idempotence invalide".into());
    }
    let mut args = wake_args(&["reply", "--idempotency-key"])?;
    args.push(key.into());
    run(args, Some(text))
}

/// Fixed recipient alias only. No endpoint or credential is accepted from the webview.
pub fn recipient(action: &str, key: Option<String>, text: Option<String>) -> Result<CliRun, String> {
    let verb = match action { "status" => "recipient-status", "poll" => "recipient-poll", "send" => "recipient-send", _ => return Err("Action inconnue".into()) };
    let mut args=owner_command();
    args.extend([verb.into(),"--json".into()]);
    if action=="send" {
        let key=key.ok_or("Clé manquante")?;
        if !idempotency_key(&key) { return Err("Clé invalide".into()); }
        let body=text.as_ref().ok_or("Message manquant")?;
        if body.trim().is_empty() || body.chars().count()>4000 { return Err("Message invalide".into()); }
        args.extend(["--idempotency-key".into(),key.into()]);
    }
    run(args,text)
}

pub fn quick_reply(key: String, text: String, point: Option<crate::quick_input::ClickTarget>) -> Result<CliRun, String> {
    if !idempotency_key(&key) || text.trim().is_empty() || text.chars().count() > 4000 {
        return Err("Message ou identifiant invalide".into());
    }
    let mut args = wake_args(&["reply", "--capture-screen", "--idempotency-key"])?;
    args.push(key.into());
    run_with_click(args, Some(text), point)
}

/// A quick message never lifts Pause/Force-off. The queue survives until resume.
pub fn wake_after_quick_reply() {
    if let Ok(status) = wake(Verb::Status) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&status.stdout) {
            if matches!(value["data"]["profile"]["state"].as_str(), Some("ready" | "hibernating")) {
                let _ = wake_now();
            }
        }
    }
}

/// Requête vers les fils de l'humain. Les identifiants viennent du webview : formats
/// vérifiés ici, puis de nouveau par la CLI et le hub.
pub enum OwnerRequest {
    Threads,
    Thread { thread_id: String },
    Reply { thread_id: String, in_reply_to: Option<String>, idempotency_key: String, text: String },
}

fn opaque(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else { return false };
    (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

pub fn owner(request: OwnerRequest) -> Result<CliRun, String> {
    let mut args = owner_command();
    let mut stdin = None;
    match request {
        OwnerRequest::Threads => args.push("threads".into()),
        OwnerRequest::Thread { thread_id } => {
            if !opaque(&thread_id, "thr_") {
                return Err("identifiant de fil invalide".into());
            }
            args.extend(["thread".into(), "--thread".into(), thread_id.into()]);
        }
        OwnerRequest::Reply { thread_id, in_reply_to, idempotency_key: key, text } => {
            if !opaque(&thread_id, "thr_") || !idempotency_key(&key) {
                return Err("identifiant de fil ou clé d'idempotence invalide".into());
            }
            if in_reply_to.as_deref().is_some_and(|m| !opaque(m, "msg_")) {
                return Err("message cité invalide".into());
            }
            args.extend([
                "reply".into(),
                "--thread".into(),
                thread_id.into(),
                "--idempotency-key".into(),
                key.into(),
            ]);
            if let Some(cited) = in_reply_to {
                args.extend(["--in-reply-to".into(), cited.into()]);
            }
            // Le texte passe par l'entrée standard, jamais en argument.
            stdin = Some(text);
        }
    }
    run(args, stdin)
}

fn run(args: Vec<OsString>, stdin: Option<String>) -> Result<CliRun, String> {
    run_with_click(args, stdin, None)
}


fn run_with_click(mut args: Vec<OsString>, stdin: Option<String>, point: Option<crate::quick_input::ClickTarget>) -> Result<CliRun, String> {
    args.push("--json".into());
    let mut command = Command::new(node());
    command.env_remove("MIND_WAKE_CAPTURE_CLICK_X").env_remove("MIND_WAKE_CAPTURE_CLICK_Y");
    command.env_remove("MIND_WAKE_CAPTURE_CLICK_AT_MS").env_remove("MIND_WAKE_CAPTURE_CLICK_ROOT");
    if let Some(point) = point {
        command.env("MIND_WAKE_CAPTURE_CLICK_X", point.x.to_string()).env("MIND_WAKE_CAPTURE_CLICK_Y", point.y.to_string());
        if args.iter().any(|arg| arg.to_string_lossy().starts_with("ui-bumpe-")) {
            command.env("MIND_WAKE_CAPTURE_CLICK_AT_MS",point.at_ms.to_string()).env("MIND_WAKE_CAPTURE_CLICK_ROOT",point.root_window.to_string());
        }
    }
    command
        .args(&args)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // MIND_WAKE_DATA_DIR, MIND_MCP_HUB_PIPE et MIND_MCP_LINK_KEY sont hérités tels quels.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("impossible de lancer node : {e}"))?;
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().ok_or("entrée de la CLI indisponible")?;
        pipe.write_all(text.as_bytes()).map_err(|e| format!("écriture impossible : {e}"))?;
    }
    let mut stdout = child.stdout.take().ok_or("sortie de la CLI indisponible")?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).map(|_| out)
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("la CLI n'a pas répondu en {} s", TIMEOUT.as_secs()));
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let stdout = reader
        .join()
        .map_err(|_| "lecture de la sortie interrompue".to_string())?
        .map_err(|e| format!("sortie illisible : {e}"))?;
    if stdout.trim().is_empty() {
        return Err(format!("la CLI n'a rien renvoyé (code {:?})", status.code()));
    }
    Ok(CliRun { exit_code: status.code().unwrap_or(-1), stdout })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_always_on_reactivates_only_a_stopped_or_locked_profile() {
        assert!(requires_reactivation(r#"{"data":{"profile":{"state":"stopped","emergencyStopLocked":true}}}"#));
        assert!(requires_reactivation(r#"{"data":{"profile":{"state":"ready","emergencyStopLocked":true}}}"#));
        assert!(!requires_reactivation(r#"{"data":{"profile":{"state":"paused","emergencyStopLocked":false}}}"#));
        assert!(!requires_reactivation("invalid"));
    }

    #[test]
    fn formats_d_identifiants() {
        assert!(opaque("thr_abcdEFGH12", "thr_"));
        assert!(!opaque("thr_abc", "thr_"));
        assert!(!opaque("msg_abcdefgh12", "thr_"));
        assert!(!opaque("thr_abcdefgh;rm", "thr_"));
        assert!(idempotency_key("ui-1234-abcd"));
        assert!(!idempotency_key("court"));
        assert!(!idempotency_key("ui 1234 abcd"));
    }

    #[test]
    fn reponse_refusee_avant_tout_lancement() {
        let refused = owner(OwnerRequest::Reply {
            thread_id: "thr_bad id!!".into(),
            in_reply_to: None,
            idempotency_key: "ui-12345678".into(),
            text: "x".into(),
        });
        assert!(refused.is_err());
    }
}
