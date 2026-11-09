use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;

use crate::models::Symbol;

fn database_path() -> Result<PathBuf, String> {
    let dir = dirs::data_dir()
        .ok_or_else(|| "cannot determine application data directory".to_string())?
        .join("light-reader");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create cache directory: {e}"))?;
    Ok(dir.join("symbols.db"))
}

fn open() -> Result<Connection, String> {
    let conn = Connection::open(database_path()?)
        .map_err(|e| format!("cannot open index database: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS symbols (
           root TEXT NOT NULL,
           path TEXT NOT NULL,
           name TEXT NOT NULL,
           kind TEXT NOT NULL,
           start INTEGER NOT NULL,
           end INTEGER NOT NULL,
           start_line INTEGER NOT NULL,
           start_column INTEGER NOT NULL,
           end_line INTEGER NOT NULL,
           end_column INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS symbols_root_name ON symbols(root, name);
         CREATE INDEX IF NOT EXISTS symbols_root_path ON symbols(root, path);",
    )
    .map_err(|e| format!("cannot initialize index database: {e}"))?;
    Ok(conn)
}

pub fn save_symbols(root: &str, symbols: &[Symbol]) -> Result<(), String> {
    let mut conn = open()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("database transaction failed: {e}"))?;
    tx.execute("DELETE FROM symbols WHERE root = ?1", params![root])
        .map_err(|e| format!("cannot clear old symbols: {e}"))?;
    {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO symbols (
                   root,path,name,kind,start,end,start_line,start_column,end_line,end_column
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            )
            .map_err(|e| format!("cannot prepare symbol insert: {e}"))?;
        for symbol in symbols {
            stmt.execute(params![
                root,
                symbol.path,
                symbol.name,
                symbol.kind,
                symbol.start as i64,
                symbol.end as i64,
                symbol.start_line as i64,
                symbol.start_column as i64,
                symbol.end_line as i64,
                symbol.end_column as i64
            ])
            .map_err(|e| format!("cannot save symbol: {e}"))?;
        }
    }
    tx.commit()
        .map_err(|e| format!("cannot commit symbol index: {e}"))
}

pub fn load_symbols(root: &str) -> Result<Vec<Symbol>, String> {
    if !database_path()?.exists() {
        return Ok(Vec::new());
    }
    let conn = open()?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT path,name,kind,start,end,start_line,start_column,end_line,end_column
             FROM symbols WHERE root = ?1 ORDER BY path, start",
        )
        .map_err(|e| format!("cannot prepare symbol query: {e}"))?;
    let rows = stmt
        .query_map(params![root], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| format!("cannot load symbols: {e}"))?;
    let mut symbols = Vec::new();
    for row in rows {
        let (path, name, kind, start, end, start_line, start_column, end_line, end_column) =
            row.map_err(|e| format!("cannot read symbol row: {e}"))?;
        symbols.push(Symbol {
            path,
            name,
            kind,
            start: start.max(0) as usize,
            end: end.max(0) as usize,
            start_line: start_line.max(0) as usize,
            start_column: start_column.max(0) as usize,
            end_line: end_line.max(0) as usize,
            end_column: end_column.max(0) as usize,
        });
    }
    Ok(symbols)
}

pub fn find_symbol(root: &str, name: &str) -> Result<Option<Symbol>, String> {
    let conn = open()?;
    conn.query_row(
        "SELECT path,name,kind,start,end,start_line,start_column,end_line,end_column
         FROM symbols WHERE root = ?1 AND name = ?2 ORDER BY path,start LIMIT 1",
        params![root, name],
        |row| {
            Ok(Symbol {
                path: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                start: row.get::<_, i64>(3)?.max(0) as usize,
                end: row.get::<_, i64>(4)?.max(0) as usize,
                start_line: row.get::<_, i64>(5)?.max(0) as usize,
                start_column: row.get::<_, i64>(6)?.max(0) as usize,
                end_line: row.get::<_, i64>(7)?.max(0) as usize,
                end_column: row.get::<_, i64>(8)?.max(0) as usize,
            })
        },
    )
    .optional()
    .map_err(|e| format!("cannot query definition: {e}"))
}
