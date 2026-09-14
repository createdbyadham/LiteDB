//! Reading and saving the SQLite file the editor holds in memory.
//!
//! sql.js edits a copy and saves by writing a whole file image, which SQLite
//! knows nothing about. Two things make that safe enough to do next to an
//! agent or another program using the same file:
//!
//! - Check and write in one call. Checking from the webview and writing on a
//!   later IPC round trip left a gap an agent's write could land in and be
//!   overwritten, or be mistaken for our own save.
//! - Take the lock SQLite itself takes to write (see `sqlite_lock`). It fails
//!   while any connection is mid-transaction, and — measured — while any WAL
//!   connection is merely open, which is the case where a whole-file
//!   overwrite leaves it serving stale pages and writing frames that corrupt
//!   the file. SQLite treats the lock as "busy" and waits, where cruder
//!   approaches broke it: an exclusive open of `-shm` failed SQLite's own opens
//!   with "unable to open database file", and denying write sharing on the
//!   main file made SQLite fall back to read-only.
//!
//! Nothing here opens or locks anything during the poll; `disk_state` only
//! stats. On non-Windows targets the lock is not implemented yet: the checks
//! and the write still happen in one call, which narrows the gap without
//! closing it.

use serde::Serialize;
use std::fs::{File, Metadata, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiskState {
    /// Microseconds since the epoch. `None` when the file cannot be stat'd.
    pub mtime: Option<u64>,
    pub wal_size: u64,
    /// Writes are sitting in the WAL that the main file does not have yet.
    /// A live connection that is not mid-write only shows up when a save
    /// tries to take the lock.
    pub in_use: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SaveOutcome {
    Saved { mtime: u64 },
    /// The file is not the one we last loaded or saved.
    Changed,
    InUse,
    Missing,
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn mtime_of(meta: &Metadata) -> Option<u64> {
    let modified = meta.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_micros()).ok()
}

fn wal_size(path: &Path) -> u64 {
    std::fs::metadata(sidecar(path, "-wal"))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// Stats only. Probing for open connections here — every second — is what
/// made SQLite's own opens fail; the save's lock attempt answers it instead.
pub fn disk_state(path: &Path) -> DiskState {
    let wal_size = wal_size(path);
    DiskState {
        mtime: std::fs::metadata(path).ok().and_then(|m| mtime_of(&m)),
        wal_size,
        in_use: wal_size > 0,
    }
}

#[cfg(windows)]
mod sqlite_lock {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;

    // The byte ranges SQLite locks (os_win.c). They sit at 1 GiB, past any
    // data a file under that size has, and SQLite never stores data in the
    // page that holds them.
    const PENDING_BYTE: u32 = 0x4000_0000;
    const RESERVED_BYTE: u32 = PENDING_BYTE + 1;
    const SHARED_FIRST: u32 = PENDING_BYTE + 2;
    const SHARED_SIZE: u32 = 510;

    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x1;
    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x2;

    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut c_void,
            flags: u32,
            reserved: u32,
            len_low: u32,
            len_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn UnlockFileEx(
            file: *mut c_void,
            reserved: u32,
            len_low: u32,
            len_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }

    fn at(offset: u32) -> Overlapped {
        Overlapped {
            internal: 0,
            internal_high: 0,
            offset,
            offset_high: 0,
            event: std::ptr::null_mut(),
        }
    }

    fn lock(handle: *mut c_void, offset: u32, len: u32, flags: u32) -> bool {
        let mut overlapped = at(offset);
        // SAFETY: a valid file handle and a live OVERLAPPED for the call.
        unsafe { LockFileEx(handle, flags, 0, len, 0, &mut overlapped) != 0 }
    }

    /// SQLite's EXCLUSIVE lock: pending, reserved, then the shared range.
    /// Released on drop. Must not outlive the `File` it was taken on.
    pub struct Exclusive {
        handle: *mut c_void,
        held: Vec<(u32, u32)>,
    }

    impl Exclusive {
        pub fn try_acquire(file: &File) -> Option<Self> {
            let mut guard = Exclusive {
                handle: file.as_raw_handle(),
                held: Vec::new(),
            };
            for (offset, len) in [(PENDING_BYTE, 1), (RESERVED_BYTE, 1), (SHARED_FIRST, SHARED_SIZE)] {
                if !lock(
                    guard.handle,
                    offset,
                    len,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                ) {
                    return None; // drop releases what was taken
                }
                guard.held.push((offset, len));
            }
            Some(guard)
        }
    }

    impl Drop for Exclusive {
        fn drop(&mut self) {
            for &(offset, len) in self.held.iter().rev() {
                let mut overlapped = at(offset);
                // SAFETY: unlocking a range this guard locked on this handle.
                unsafe { UnlockFileEx(self.handle, 0, len, 0, &mut overlapped) };
            }
        }
    }

    /// What an open WAL connection holds for its whole life.
    #[cfg(test)]
    pub fn hold_shared(file: &File) -> bool {
        lock(
            file.as_raw_handle(),
            SHARED_FIRST,
            SHARED_SIZE,
            LOCKFILE_FAIL_IMMEDIATELY,
        )
    }
}

#[cfg(not(windows))]
mod sqlite_lock {
    pub struct Exclusive;

    impl Exclusive {
        pub fn try_acquire(_file: &std::fs::File) -> Option<Self> {
            Some(Exclusive)
        }
    }
}

/// Write `data` over `path` only if nothing else is using it and it is still
/// the file whose modified time was `expected`.
pub fn guarded_save(path: &Path, data: &[u8], expected: Option<u64>) -> io::Result<SaveOutcome> {
    if wal_size(path) > 0 {
        return Ok(SaveOutcome::InUse);
    }
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(SaveOutcome::Missing),
        Err(error) => return Err(error),
    };
    // Declared after `file`, so it is dropped — unlocked — before the handle closes.
    let Some(_lock) = sqlite_lock::Exclusive::try_acquire(&file) else {
        return Ok(SaveOutcome::InUse);
    };
    // Under the lock nothing can commit to the WAL; it was only unlocked before.
    if wal_size(path) > 0 {
        return Ok(SaveOutcome::InUse);
    }
    let current = mtime_of(&file.metadata()?);
    if current.is_none() || current != expected {
        return Ok(SaveOutcome::Changed);
    }

    let mut writer = &file;
    writer.seek(SeekFrom::Start(0))?;
    writer.write_all(data)?;
    file.set_len(data.len() as u64)?;
    file.sync_all()?;
    // Set rather than read back: once a handle sets its write time, Windows
    // stops updating it for that handle, so closing cannot move it off the
    // value returned here.
    file.set_modified(SystemTime::now())?;
    let mtime = mtime_of(&file.metadata()?)
        .ok_or_else(|| io::Error::other("the saved file has no modified time"))?;
    Ok(SaveOutcome::Saved { mtime })
}

/// The bytes, with the modified time they correspond to. Retries if the file
/// changes mid-read so the pair is never a torn mix.
pub fn read_consistent(path: &Path) -> io::Result<(Vec<u8>, DiskState)> {
    for _ in 0..5 {
        let mut state = disk_state(path);
        let mut file = File::open(path)?;
        let before = mtime_of(&file.metadata()?);
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        let after = mtime_of(&file.metadata()?);
        if before.is_some() && before == after {
            state.mtime = before;
            return Ok((data, state));
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err(io::Error::other(
        "the database file kept changing while it was being read",
    ))
}

/// `[u32 LE length][JSON state][file bytes]` — one binary response instead of
/// the bytes as a JSON array of numbers.
pub fn encode_read(data: Vec<u8>, state: &DiskState) -> Result<Vec<u8>, String> {
    let meta = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    let len = u32::try_from(meta.len()).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + meta.len() + data.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(&data);
    Ok(out)
}

#[derive(serde::Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub path: String,
    pub expected_mtime: Option<u64>,
}

/// Inverse of the webview's `[u32 LE length][JSON request][file bytes]`.
pub fn decode_save(body: &[u8]) -> Result<(SaveRequest, &[u8]), String> {
    let head: [u8; 4] = body
        .get(..4)
        .and_then(|b| b.try_into().ok())
        .ok_or("save request is truncated")?;
    let len = u32::from_le_bytes(head) as usize;
    let meta = body.get(4..4 + len).ok_or("save request is truncated")?;
    let request: SaveRequest = serde_json::from_slice(meta).map_err(|e| e.to_string())?;
    Ok((request, &body[4 + len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "litedb-sqlite-file-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("db.sqlite");
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn saves_when_unchanged_and_the_returned_time_survives_close() {
        let path = temp_file("unchanged", b"old contents that are longer");
        let expected = disk_state(&path).mtime;
        let outcome = guarded_save(&path, b"new", expected).unwrap();
        let SaveOutcome::Saved { mtime } = outcome else {
            panic!("expected Saved, got {outcome:?}");
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        assert_eq!(disk_state(&path).mtime, Some(mtime));
    }

    #[test]
    fn refuses_when_the_file_moved_on() {
        let path = temp_file("changed", b"a");
        let expected = disk_state(&path).mtime.map(|m| m - 1);
        assert_eq!(guarded_save(&path, b"b", expected).unwrap(), SaveOutcome::Changed);
        assert_eq!(std::fs::read(&path).unwrap(), b"a");
    }

    #[test]
    fn unknown_last_time_is_treated_as_changed() {
        let path = temp_file("unknown", b"a");
        assert_eq!(guarded_save(&path, b"b", None).unwrap(), SaveOutcome::Changed);
    }

    #[test]
    fn missing_file() {
        let path = temp_file("missing", b"a");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(guarded_save(&path, b"b", Some(1)).unwrap(), SaveOutcome::Missing);
        assert!(!path.exists(), "a save must not recreate a deleted file");
    }

    #[test]
    fn non_empty_wal_is_in_use() {
        let path = temp_file("wal", b"a");
        std::fs::write(sidecar(&path, "-wal"), b"frames").unwrap();
        let expected = disk_state(&path).mtime;
        assert!(disk_state(&path).in_use);
        assert_eq!(guarded_save(&path, b"b", expected).unwrap(), SaveOutcome::InUse);
        assert_eq!(std::fs::read(&path).unwrap(), b"a");
    }

    #[test]
    fn empty_leftover_wal_and_shm_are_not_in_use() {
        // What a read-only SQLite connection leaves behind when it closes.
        let path = temp_file("leftovers", b"a");
        std::fs::write(sidecar(&path, "-wal"), b"").unwrap();
        std::fs::write(sidecar(&path, "-shm"), b"index").unwrap();
        assert!(!disk_state(&path).in_use);
        let expected = disk_state(&path).mtime;
        assert!(matches!(
            guarded_save(&path, b"b", expected).unwrap(),
            SaveOutcome::Saved { .. }
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_sqlite_lock_held_elsewhere_is_in_use() {
        let path = temp_file("locked", b"a");
        let expected = disk_state(&path).mtime;
        let other = File::open(&path).unwrap();
        assert!(sqlite_lock::hold_shared(&other));
        assert_eq!(guarded_save(&path, b"b", expected).unwrap(), SaveOutcome::InUse);
        assert_eq!(std::fs::read(&path).unwrap(), b"a");
        drop(other); // closing the handle releases its locks
        assert!(matches!(
            guarded_save(&path, b"b", expected).unwrap(),
            SaveOutcome::Saved { .. }
        ));
    }

    #[test]
    fn read_returns_bytes_with_their_time() {
        let path = temp_file("read", b"hello");
        let (data, state) = read_consistent(&path).unwrap();
        assert_eq!(data, b"hello");
        assert_eq!(state.mtime, disk_state(&path).mtime);
    }

    #[test]
    fn save_request_round_trips() {
        let meta = br#"{"path":"C:\\x\\y.db","expectedMtime":42}"#;
        let mut body = (meta.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(meta);
        body.extend_from_slice(b"DATA");
        let (request, data) = decode_save(&body).unwrap();
        assert_eq!(
            request,
            SaveRequest { path: r"C:\x\y.db".into(), expected_mtime: Some(42) }
        );
        assert_eq!(data, b"DATA");
        assert!(decode_save(&body[..3]).is_err());
    }

    // ---- Against real SQLite. Needs Node 22.16+ on PATH: `cargo test -- --ignored`.

    fn node(script: &str) -> std::process::Child {
        std::process::Command::new("node")
            .args(["-e", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("node on PATH")
    }

    fn read_line(child: &mut std::process::Child) -> String {
        use std::io::BufRead;
        let mut line = String::new();
        io::BufReader::new(child.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        line.trim().to_string()
    }

    fn sqlite_file(name: &str, journal: &str) -> PathBuf {
        let path = temp_file(name, b"");
        std::fs::remove_file(&path).unwrap();
        let mut child = node(&format!(
            "const {{DatabaseSync}}=require('node:sqlite');const d=new DatabaseSync({p:?});\
             d.exec(\"PRAGMA journal_mode={journal};CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER);\
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000) INSERT INTO t SELECT i, i FROM n\");\
             d.close();console.log('ready');",
            p = path.to_string_lossy()
        ));
        assert_eq!(read_line(&mut child), "ready");
        child.wait().unwrap();
        path
    }

    /// An idle WAL connection must block the save; an idle rollback-journal
    /// connection needs no block (it re-checks the file header itself).
    #[test]
    #[ignore]
    fn live_sqlite_open_connections() {
        for (journal, read_only, blocks) in [
            ("WAL", false, true),
            ("WAL", true, true),
            ("DELETE", false, false),
        ] {
            let label = format!("{journal} read_only={read_only}");
            let path = sqlite_file("live", journal);
            let mut child = node(&format!(
                "const {{DatabaseSync}}=require('node:sqlite');\
                 const d=new DatabaseSync({p:?},{{readOnly:{read_only}}});\
                 d.prepare('SELECT count(*) FROM t').get();console.log('open');\
                 process.stdin.on('data',()=>{{d.close();process.exit(0)}});",
                p = path.to_string_lossy()
            ));
            assert_eq!(read_line(&mut child), "open", "{label}");

            let (bytes, state) = read_consistent(&path).unwrap();
            let outcome = guarded_save(&path, &bytes, state.mtime).unwrap();
            if blocks {
                assert_eq!(outcome, SaveOutcome::InUse, "{label}");
            } else {
                assert!(matches!(outcome, SaveOutcome::Saved { .. }), "{label}: {outcome:?}");
            }

            child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
            child.wait().unwrap();
            let (bytes, state) = read_consistent(&path).unwrap();
            assert!(
                matches!(guarded_save(&path, &bytes, state.mtime).unwrap(), SaveOutcome::Saved { .. }),
                "{label}: saves once the connection closes"
            );
        }
    }

    /// The bug a user hit: the app's file handling must not make an agent's
    /// open or write fail. Saves hammer the file while an agent-style loop
    /// (busy timeout, as the MCP server sets) reads, writes and checkpoints.
    #[test]
    #[ignore]
    fn live_saves_do_not_break_agent_writes() {
        let path = sqlite_file("stress", "WAL");
        let mut agent = node(&format!(
            "const {{DatabaseSync}}=require('node:sqlite');const p={p:?};const fail={{}};let ok=0;\
             for(let i=0;i<300;i++){{try{{\
               const r=new DatabaseSync(p,{{readOnly:true,timeout:5000}});r.prepare('SELECT count(*) FROM t').get();r.close();\
               const w=new DatabaseSync(p,{{timeout:5000}});w.exec('UPDATE t SET v='+i+' WHERE id=1');\
               w.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();w.close();ok++;\
             }}catch(e){{fail[e.message]=(fail[e.message]||0)+1}}}}\
             console.log(JSON.stringify({{ok,fail}}));",
            p = path.to_string_lossy()
        ));

        let mut saves = 0;
        let mut refused = 0;
        while agent.try_wait().unwrap().is_none() {
            if let Ok((bytes, state)) = read_consistent(&path) {
                match guarded_save(&path, &bytes, state.mtime) {
                    Ok(SaveOutcome::Saved { .. }) => saves += 1,
                    _ => refused += 1,
                }
            }
        }
        let report = read_line(&mut agent);
        assert_eq!(report, r#"{"ok":300,"fail":{}}"#, "saves={saves} refused={refused}");
        assert!(saves > 0, "the test must actually save while the agent runs");

        let mut check = node(&format!(
            "const {{DatabaseSync}}=require('node:sqlite');const d=new DatabaseSync({p:?},{{readOnly:true}});\
             console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close();",
            p = path.to_string_lossy()
        ));
        assert_eq!(read_line(&mut check), "ok");
    }
}
