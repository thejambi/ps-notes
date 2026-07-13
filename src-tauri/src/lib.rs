/// Move a file to the OS trash/recycle bin rather than deleting it outright.
#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FsEntry {
    name: String,
    is_dir: bool,
    mtime_ms: i64,
}

/// List a folder's entries with modified times in a single IPC round-trip.
/// (Per-file stat calls from the frontend are far too slow for large folders.)
#[tauri::command]
async fn list_notes(dir: String) -> Result<Vec<FsEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(FsEntry {
            name,
            is_dir: meta.is_dir(),
            mtime_ms,
        });
    }
    Ok(out)
}

/// Case-insensitive full-text search across a folder's note files.
/// Returns the paths of files whose content contains the query.
#[tauri::command]
async fn search_notes(dir: String, query: String, exts: Vec<String>) -> Result<Vec<String>, String> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let exts: Vec<String> = exts
        .iter()
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .collect();
    let mut matches = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let ext_ok = path
            .extension()
            .map(|e| exts.iter().any(|x| e.to_string_lossy().eq_ignore_ascii_case(x)))
            .unwrap_or(false);
        if !ext_ok || !path.is_file() {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if text.to_lowercase().contains(&q) {
                matches.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(matches)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![move_to_trash, list_notes, search_notes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
