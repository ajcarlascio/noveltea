use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::Manager;

pub mod licence;

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

/// What every SQLite file begins with, including the trailing NUL.
///
/// Checked before the manuscript is overwritten. An empty buffer is not the only way
/// for this to go wrong — a truncated or garbled export is just as destructive and far
/// likelier — and the client deliberately does not surface save failures to an author
/// mid-sentence, so nothing downstream would report it. Refusing anything that is not
/// a database is the cheapest guard against the one failure this design cannot undo.
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;
    fs::create_dir_all(&dir).map_err(|error| format!("cannot create {dir:?}: {error}"))?;
    Ok(dir.join(DATABASE_FILE))
}

/// The stored database, or `None` when there is no file yet.
///
/// Split from the command so it can be tested: a `tauri::AppHandle` cannot be built in
/// a unit test, and the part worth testing is what happens to the bytes rather than how
/// the directory was located.
fn read_database(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("cannot read {path:?}: {error}")),
    }
}

/// The stored database, or `None` the first time this machine runs the app.
#[tauri::command]
fn db_load(app: tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
    read_database(&database_path(&app)?)
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
    write_database(&database_path(&app)?, &bytes)
}

/// See [`db_save`]. Split from the command for the same reason as [`read_database`].
fn write_database(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < SQLITE_MAGIC.len() || !bytes.starts_with(SQLITE_MAGIC) {
        // Something went wrong upstream. Writing it would replace a working database
        // with rubble, which is the one outcome worth refusing.
        return Err("refusing to write something that is not a SQLite database".into());
    }

    let temp = path.with_extension("sqlite3.tmp");

    let mut file = fs::File::create(&temp).map_err(|e| format!("cannot create {temp:?}: {e}"))?;
    file.write_all(bytes).map_err(|e| format!("cannot write {temp:?}: {e}"))?;
    file.sync_all().map_err(|e| format!("cannot flush {temp:?}: {e}"))?;
    drop(file);

    fs::rename(&temp, path).map_err(|e| format!("cannot replace {path:?}: {e}"))?;

    // The rename is a directory operation, so syncing the file above does not make the
    // swap itself durable: a power cut can leave the directory entry pointing at the
    // old inode. Unix only — Windows has no equivalent and needs none.
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}

/// The licence file, beside the database in the app data directory.
const LICENCE_FILE: &str = "licence.key";

/// What the interface needs to know about the licence, as plain data.
///
/// Deliberately not the `Status` enum: this crosses to JavaScript, and a shape with a
/// `state` string is easier to render and to widen later than a tagged union.
#[derive(serde::Serialize)]
pub struct LicenceView {
    /// `none`, `covers`, `too_old` or `invalid`.
    state: &'static str,
    /// Who it is licensed to, when there is a valid key.
    name: Option<String>,
    /// The licence id, for support.
    id: Option<String>,
    /// The highest major version the key covers.
    max_major: Option<u32>,
    /// Why it was refused, in words an author can act on.
    message: Option<String>,
}

impl LicenceView {
    fn none() -> Self {
        Self { state: "none", name: None, id: None, max_major: None, message: None }
    }

    fn of(status: licence::Status) -> Self {
        let (state, held) = match status {
            licence::Status::Covers(held) => ("covers", held),
            licence::Status::TooOld { licence: held, .. } => ("too_old", held),
        };
        Self {
            state,
            name: Some(held.name),
            id: Some(held.id),
            max_major: Some(held.max_major),
            message: None,
        }
    }

    fn invalid(reason: licence::Invalid) -> Self {
        Self {
            state: "invalid",
            name: None,
            id: None,
            max_major: None,
            message: Some(reason.message().to_owned()),
        }
    }
}

fn licence_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(database_path(app)?.with_file_name(LICENCE_FILE))
}

/// The licence this device holds, checked against the running version.
///
/// Re-verified on every call rather than cached at startup. Verification is a signature
/// check over a hundred bytes, and caching it would mean a key entered during a session
/// did not take effect until the app was restarted.
#[tauri::command]
fn licence_status(app: tauri::AppHandle) -> Result<LicenceView, String> {
    let path = licence_path(&app)?;
    let Some(stored) = read_database(&path)? else {
        return Ok(LicenceView::none());
    };
    let key = String::from_utf8_lossy(&stored);

    Ok(
        match licence::status(&key, licence::PUBLIC_KEY, env!("CARGO_PKG_VERSION")) {
            Ok(status) => LicenceView::of(status),
            Err(reason) => LicenceView::invalid(reason),
        },
    )
}

/// Stores a key, if it verifies.
///
/// A key that does not verify is never written. Storing it would mean the app came back
/// tomorrow still holding something it had already rejected, and an author retyping a
/// key they had already been told was wrong.
///
/// A key for an older major version *is* stored: it is a real purchase, and the app says
/// what it covers rather than throwing it away.
#[tauri::command]
fn licence_activate(app: tauri::AppHandle, key: String) -> Result<LicenceView, String> {
    match licence::status(&key, licence::PUBLIC_KEY, env!("CARGO_PKG_VERSION")) {
        Ok(status) => {
            let path = licence_path(&app)?;
            fs::write(&path, key.trim())
                .map_err(|error| format!("cannot write {path:?}: {error}"))?;
            Ok(LicenceView::of(status))
        }
        Err(reason) => Ok(LicenceView::invalid(reason)),
    }
}

/// Forgets the licence on this device. The file is the only copy the app keeps.
#[tauri::command]
fn licence_remove(app: tauri::AppHandle) -> Result<LicenceView, String> {
    let path = licence_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(LicenceView::none()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LicenceView::none()),
        Err(error) => Err(format!("cannot remove {path:?}: {error}")),
    }
}

/// Where the database is, for the author.
///
/// A local-first app should be able to answer "where are my words" without anyone
/// having to guess at platform conventions. Returned as a string rather than opened in
/// a file manager, so the interface decides whether to show it, copy it or reveal it.
#[tauri::command]
fn db_location(app: tauri::AppHandle) -> Result<String, String> {
    Ok(database_path(&app)?.to_string_lossy().into_owned())
}

pub fn run() {
    tauri::Builder::default()
        // Registered first, as the plugin requires. A second launch focuses the window
        // already open rather than starting a second webview with its own copy of the
        // database — see the note on the dependency in Cargo.toml.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            db_load,
            db_save,
            db_location,
            licence_status,
            licence_activate,
            licence_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running NovelTea");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real, minimal SQLite file header. Enough to pass the guard; the point of these
    /// tests is what happens to bytes, not what SQLite makes of them.
    fn database(tail: &[u8]) -> Vec<u8> {
        let mut bytes = SQLITE_MAGIC.to_vec();
        bytes.extend_from_slice(tail);
        bytes
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("noveltea-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir.join("noveltea.sqlite3")
    }

    #[test]
    fn a_missing_file_is_a_first_run_not_a_failure() {
        // Reported as None so the app opens empty and syncs its way back, rather than
        // refusing to start and leaving an author with nothing at all.
        let path = scratch("missing");
        assert_eq!(read_database(&path), Ok(None));
    }

    #[test]
    fn what_was_written_is_what_comes_back() {
        let path = scratch("roundtrip");
        let bytes = database(b"chapter one");
        write_database(&path, &bytes).expect("write");
        assert_eq!(read_database(&path), Ok(Some(bytes)));
    }

    #[test]
    fn refuses_anything_that_is_not_a_database() {
        // The manuscript is the file being overwritten. An empty or garbled export
        // would replace it with rubble, and nothing downstream would report that: the
        // client deliberately does not interrupt an author to announce a failed save.
        let path = scratch("garbage");
        write_database(&path, &database(b"real")).expect("write");

        for bad in [b"".as_slice(), b"nonsense".as_slice(), b"SQLite format 2\0".as_slice()] {
            assert!(write_database(&path, bad).is_err(), "accepted {bad:?}");
        }
        // And the real one is still there, untouched.
        assert_eq!(read_database(&path), Ok(Some(database(b"real"))));
    }

    #[test]
    fn a_finished_write_leaves_no_temporary_file_behind() {
        // The temporary file must be *renamed* onto the target, not copied: a stray
        // .tmp beside the database is a second copy of the manuscript, and a copy is
        // not atomic — a crash partway through it leaves a truncated database, which
        // is the whole thing the temp file exists to prevent.
        //
        // (This deliberately checks a *successful* write. A refused one never creates
        // the temporary file at all, so asserting on it there passes whether or not
        // the guard exists, and proves nothing.)
        let path = scratch("no-litter");
        write_database(&path, &database(b"chapter one")).expect("write");
        assert!(!path.with_extension("sqlite3.tmp").exists());
    }

    #[test]
    fn replacing_a_larger_database_leaves_none_of_the_old_one() {
        // Rename replaces rather than overwriting in place, so a shorter database
        // cannot leave a tail of the longer one behind it — which would still open,
        // and would be a different book.
        let path = scratch("shrink");
        write_database(&path, &database(&vec![b'x'; 4096])).expect("write long");
        let short = database(b"short");
        write_database(&path, &short).expect("write short");
        assert_eq!(read_database(&path), Ok(Some(short)));
    }
}
