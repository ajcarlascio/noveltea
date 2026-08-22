use std::fs;
use std::io::Write;
use std::path::PathBuf;

use tauri::Manager;

/// The local replica, as a file on the host.
///
/// The webview cannot keep it. WebKitGTK — the engine Tauri uses on Linux — exposes no
/// `navigator.storage` at all, so there is no OPFS and no durable browser storage worth
/// the name; the measurement is in `tooling/webview-probe`. So the webview holds the
/// database in memory and hands the bytes here, and here they become a file.
///
/// Deliberately dumb: no SQL, no schema knowledge, no locking beyond the filesystem's.
/// Everything that understands the database stays in one place, on the other side of
/// this boundary, where it is already tested against real SQLite.
const DATABASE_FILE: &str = "noveltea.sqlite3";

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("cannot create {dir:?}: {error}"))?;
    Ok(dir.join(DATABASE_FILE))
}

/// The stored database, or `None` the first time this machine runs the app.
#[tauri::command]
fn db_load(app: tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
    eprintln!("[noveltea] db_load called");
    let path = database_path(&app)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {path:?}: {error}")),
    }
}

/// Writes the database, atomically.
///
/// Temp file, flush, sync, rename. A rename within one directory is atomic on every
/// platform this ships to, so a crash mid-write leaves the previous database intact
/// rather than a half-written one — and a half-written SQLite file is not a database
/// that lost recent edits, it is a database that will not open.
///
/// `sync_all` before the rename is the part that is easy to leave out and useless to
/// leave out: without it the rename can reach the disk before the bytes do.
#[tauri::command]
fn db_save(app: tauri::AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    eprintln!("[noveltea] db_save called with {} bytes", bytes.len());
    if bytes.is_empty() {
        // An empty export means something went wrong upstream. Writing it would replace
        // a working database with nothing, which is the one outcome worth refusing.
        return Err("refusing to write an empty database".into());
    }

    let path = database_path(&app)?;
    let temp = path.with_extension("sqlite3.tmp");

    let mut file = fs::File::create(&temp).map_err(|e| format!("cannot create {temp:?}: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("cannot write {temp:?}: {e}"))?;
    file.sync_all().map_err(|e| format!("cannot flush {temp:?}: {e}"))?;
    drop(file);

    fs::rename(&temp, &path).map_err(|e| format!("cannot replace {path:?}: {e}"))?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![db_load, db_save])
        .run(tauri::generate_context!())
        .expect("error while running NovelTea");
}
