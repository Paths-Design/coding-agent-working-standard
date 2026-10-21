//! Observed linked SQLite identity for the private build coordinator.
//! Neither this output nor the compiled prefix pin grants runtime admission.
use std::io::Write;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let connection = rusqlite::Connection::open_in_memory()?;
    let source_id: String =
        connection.query_row("SELECT sqlite_source_id()", [], |row| row.get(0))?;
    let mut options = connection.prepare("PRAGMA compile_options")?;
    let mut compile_options = options
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    compile_options.sort();
    // No arguments, pointers or callback lifetimes cross this direct FFI call.
    let thread_safe = unsafe { libsqlite3_sys::sqlite3_threadsafe() };
    let identity = serde_json::json!({
        "schema": "caws.sqlite_build_identity.v1",
        "version": rusqlite::version(),
        "sourceId": source_id,
        "threadSafe": thread_safe,
        "compileOptions": compile_options,
        "compiledPrefixSha256": env!("CAWS_SQLITE_PREFIX_SHA256"),
    });
    let mut bytes = serde_json::to_vec(&identity)?;
    bytes.push(b'\n');
    std::io::stdout().lock().write_all(&bytes)?;
    Ok(())
}
