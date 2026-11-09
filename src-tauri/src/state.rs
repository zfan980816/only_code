use crate::models::{IndexProgress, Symbol, Workspace};
use notify::RecommendedWatcher;
use once_cell::sync::Lazy;
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

#[derive(Default)]
pub struct WorkspaceEntry {
    pub root: PathBuf,
    pub symbols: Vec<Symbol>,
    #[allow(dead_code)]
    pub watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct AppState;

pub static WORKSPACES: Lazy<Mutex<HashMap<String, WorkspaceEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn workspace_root(id: &str) -> Result<PathBuf, String> {
    WORKSPACES
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .get(id)
        .map(|entry| entry.root.clone())
        .ok_or_else(|| format!("workspace {} is not open", id))
}

pub fn workspace_symbols(id: &str) -> Result<Vec<Symbol>, String> {
    WORKSPACES
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?
        .get(id)
        .map(|entry| entry.symbols.clone())
        .ok_or_else(|| format!("workspace {} is not open", id))
}

pub fn set_symbols(id: &str, symbols: Vec<Symbol>) -> Result<Workspace, String> {
    let mut workspaces = WORKSPACES
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    let entry = workspaces
        .get_mut(id)
        .ok_or_else(|| format!("workspace {} is not open", id))?;
    entry.symbols = symbols;
    let indexed_files = count_unique_files(&entry.symbols);
    let root = entry.root.to_string_lossy().to_string();
    let name = entry
        .root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());
    Ok(Workspace {
        id: id.to_string(),
        root,
        name,
        indexed_files,
    })
}

pub fn insert_workspace(id: String, root: PathBuf, watcher: RecommendedWatcher) -> Result<(), String> {
    let mut workspaces = WORKSPACES
        .lock()
        .map_err(|_| "workspace lock poisoned".to_string())?;
    workspaces.insert(
        id,
        WorkspaceEntry {
            root,
            symbols: Vec::new(),
            watcher: Some(watcher),
        },
    );
    Ok(())
}

fn count_unique_files(symbols: &[Symbol]) -> usize {
    let mut paths: Vec<_> = symbols.iter().map(|s| s.path.as_str()).collect();
    paths.sort_unstable();
    paths.dedup();
    paths.len()
}

pub fn emit_progress(app: &tauri::AppHandle, progress: IndexProgress) {
    use tauri::Emitter;
    let _ = app.emit("index_progress", progress);
}




