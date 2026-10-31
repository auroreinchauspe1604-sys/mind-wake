use std::path::{Component, Path, PathBuf};

fn root(scope: &str) -> Result<PathBuf, String> {
    let path = match scope {
        "project" => std::env::var_os("MIND_WAKE_REPO_DIR").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")),
        "agent" => {
            let run = crate::cli::wake(crate::cli::Verb::WakeHistory)?;
            let value: serde_json::Value = serde_json::from_str(&run.stdout).map_err(|e| e.to_string())?;
            if run.exit_code != 0 { return Err("Espace agent indisponible".into()); }
            PathBuf::from(value["data"]["locations"]["workspace"].as_str().ok_or("Espace agent indisponible")?)
        }
        _ => return Err("Espace inconnu".into()),
    };
    path.canonicalize().map_err(|e| e.to_string())
}

fn supported(path: &Path) -> bool {
    document_format(path).is_some()
}

fn document_format(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("md" | "markdown") => Some("markdown"),
        Some("html" | "htm") => Some("html"),
        Some("txt") => Some("text"),
        _ => None,
    }
}

// Installation-local opt-in, supplied by its authorized launcher. Never inferred
// from file content, a peer message, a URL, or the personal grants in this repo.
fn local_app(scope: &str, relative: &str, enabled: Option<&str>) -> Option<serde_json::Value> {
    if enabled == Some("1") && scope == "agent" && relative == "artifacts/creations/atelier-dj/index.html" {
        Some(serde_json::json!({"id":"atelier-dj","url":"http://127.0.0.1:8941/"}))
    } else { None }
}

#[tauri::command]
pub async fn conversation_image(reference: String, scope: Option<String>, version: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if scope.as_deref() == Some("aurore") {
            let value = aurore_read(reference.clone(), true, true, version)?;
            if value["state"] != "available" { return Err("Image du clone indisponible".into()); }
            let bytes: Vec<u8> = serde_json::from_value(value["bytes"].clone()).map_err(|_| "Image invalide")?;
            let extension = Path::new(&reference).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let data_url = crate::conversation_images::raster_data_url(&bytes, &extension)?;
            return Ok(serde_json::json!({"dataUrl": data_url}));
        }
        let roots: Vec<PathBuf> = match scope {
            Some(scope) => vec![root(&scope)?],
            None => ["agent", "project"].iter().filter_map(|scope| root(scope).ok()).collect(),
        };
        let data_url = crate::conversation_images::read_confined(&reference, &roots)?;
        Ok(serde_json::json!({"dataUrl": data_url}))
    }).await.map_err(|e| e.to_string())?
}

fn resolve(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if Path::new(relative).components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("Chemin hors de l’espace".into());
    }
    let target = base.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(base) { return Err("Chemin hors de l’espace".into()); }
    Ok(target)
}

#[tauri::command]
pub async fn document_browse(scope: String, relative: String, read: bool, recursive: Option<bool>, version: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if scope == "aurore" {
            return aurore_read(relative, read, false, version);
        }
        let base = root(&scope)?;
        let target = resolve(&base, &relative)?;
        if read {
            if !supported(&target) || !target.is_file() { return Err("Choisir un fichier HTML, Markdown ou texte brut (.txt)".into()); }
            if target.metadata().map_err(|e| e.to_string())?.len() > 2_000_000 { return Err("Document trop volumineux (maximum 2 Mo)".into()); }
            let text = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
            let app = local_app(&scope, &relative, std::env::var("MIND_WAKE_ATELIER_DJ").ok().as_deref());
            return Ok(serde_json::json!({"text": text, "format": document_format(&target).ok_or("Format de document inconnu")?, "localApp":app}));
        }
        if recursive.unwrap_or(false) {
            return catalog(&base, &target);
        }
        let mut entries = Vec::new();
        for item in std::fs::read_dir(target).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build") { continue; }
            let Ok(real) = item.path().canonicalize() else { continue; };
            if !real.starts_with(&base) { continue; }
            let directory = real.is_dir();
            if directory || supported(&real) {
                entries.push(serde_json::json!({"name": name, "directory": directory, "relative": Path::new(&relative).join(item.file_name()).to_string_lossy().replace('\\', "/")}));
            }
        }
        entries.sort_by_key(|e| (e["directory"] != true, e["name"].as_str().unwrap_or_default().to_lowercase()));
        Ok(serde_json::json!({"entries": entries}))
    }).await.map_err(|e| e.to_string())?
}

// One confined read of the library, rather than a CLI round trip per folder.
fn catalog(base: &Path, start: &Path) -> Result<serde_json::Value, String> {
    let mut pending = vec![start.to_path_buf()];
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    let mut truncated = false;
    while let Some(folder) = pending.pop() {
        if !seen.insert(folder.clone()) { continue; }
        if seen.len() > 10_000 { truncated = true; break; }
        let Ok(items) = std::fs::read_dir(&folder) else { continue; };
        for item in items.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build" | "jobs") { continue; }
            // Do not follow aliases into private/ignored trees or create loops.
            if item.file_type().map(|kind| kind.is_symlink()).unwrap_or(true) { continue; }
            let Ok(real) = item.path().canonicalize() else { continue; };
            if !real.starts_with(base) { continue; }
            if real.is_dir() { pending.push(real); continue; }
            if !real.is_file() || !supported(&real) { continue; }
            let Ok(relative) = real.strip_prefix(base) else { continue; };
            let modified = real.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_millis() as u64).unwrap_or(0);
            entries.push(serde_json::json!({"name":name,"relative":relative.to_string_lossy().replace('\\', "/"),"modifiedAt":modified,"directory":false}));
            if entries.len() >= 10_000 { truncated = true; break; }
        }
        if truncated { break; }
    }
    entries.sort_by(|a,b| b["modifiedAt"].as_u64().cmp(&a["modifiedAt"].as_u64()).then(a["relative"].as_str().cmp(&b["relative"].as_str())));
    Ok(serde_json::json!({"entries":entries,"truncated":truncated}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interactive_atelier_requires_local_opt_in_exact_scope_and_path() {
        let page = "artifacts/creations/atelier-dj/index.html";
        assert!(local_app("agent", page, Some("1")).is_some());
        for flag in [None, Some("0"), Some("true")] { assert!(local_app("agent", page, flag).is_none()); }
        for scope in ["project", "aurore", ""] { assert!(local_app(scope, page, Some("1")).is_none()); }
        for path in ["index.html", "artifacts/creations/other/index.html", "artifacts/creations/atelier-dj/../atelier-dj/index.html", "http://127.0.0.1:8941/"] {
            assert!(local_app("agent", path, Some("1")).is_none());
        }
    }
    #[test]
    fn rejects_escape_and_non_document_extensions() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).canonicalize().unwrap();
        assert!(resolve(&base, "../Cargo.toml").is_err());
        assert!(resolve(&base, "C:\\Windows\\win.ini").is_err());
        assert!(supported(Path::new("notes.MD")));
        assert_eq!(document_format(Path::new("draft.TXT")), Some("text"));
        assert_eq!(document_format(Path::new("notes.markdown")), Some("markdown"));
        assert_eq!(document_format(Path::new("index.htm")), Some("html"));
        assert!(!supported(Path::new("draft.txt.exe")));
        assert!(!supported(Path::new("keys.json")));
    }
    #[test]
    fn catalog_lists_nested_documents_and_omits_hidden_and_build_trees() {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("wake-document-catalog-{unique}"));
        for name in ["creations/blog", ".private", "node_modules"] { std::fs::create_dir_all(dir.join(name)).unwrap(); }
        for name in ["creations/blog/index.html", "notes.md", "creations/blog/draft.TXT", ".private/secret.md", ".private/secret.txt", "node_modules/readme.md", "node_modules/readme.txt", "credentials.json", "draft.txt.exe"] { std::fs::write(dir.join(name), "sample").unwrap(); }
        let base = dir.canonicalize().unwrap();
        let result = catalog(&base, &base).unwrap();
        let files: Vec<_> = result["entries"].as_array().unwrap().iter().map(|e| e["relative"].as_str().unwrap()).collect();
        assert_eq!(files.len(), 3);
        assert!(files.contains(&"notes.md"));
        assert!(files.contains(&"creations/blog/index.html"));
        assert!(files.contains(&"creations/blog/draft.TXT"));
        assert_eq!(result["truncated"], false);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

fn aurore_read(relative: String, read: bool, image: bool, version: Option<String>) -> Result<serde_json::Value, String> {
    let run = crate::cli::aurore_document(relative, read, image, version).map_err(|_| "Lecture du clone indisponible")?;
    if run.exit_code != 0 { return Err("Lecture du clone indisponible".into()); }
    serde_json::from_str(&run.stdout).map_err(|_| "Lecture du clone indisponible".into())
}
