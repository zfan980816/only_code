use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;

use crate::db;
use crate::fs_util::{
    decode_lossy, is_probably_binary, language_for_path, safe_relative_path, MAX_READ_SIZE,
};
use crate::indexer::index_workspace;
use crate::models::{
    FileDocument, HighlightSpan, IndexProgress, NavigationTarget, SearchOptions, SearchResponse,
    SearchResult, Symbol, TreeNode, Workspace,
};
use crate::search::search_workspace;
use crate::state::{emit_progress, insert_workspace, set_symbols, workspace_root, workspace_symbols};
use crate::symbols::{extract_symbols, highlight_source, read_text_file, symbol_at};

#[tauri::command]
pub fn workspace_open(root: String, app: tauri::AppHandle) -> Result<Workspace, String> {
    let canonical = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("cannot open folder: {e}"))?;
    if !canonical.is_dir() {
        return Err("selected path is not a directory".to_string());
    }

    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    let id = format!("ws-{:016x}", hasher.finish());
    let root_text = canonical.to_string_lossy().to_string();
    let persisted = db::load_symbols(&root_text)?;

    let watcher = start_watcher(&canonical, &id, app.clone())?;
    insert_workspace(id.clone(), canonical.clone(), watcher)?;

    let workspace = set_symbols(&id, persisted)?;
    emit_progress(
        &app,
        IndexProgress {
            workspace_id: id.clone(),
            phase: "started".to_string(),
            indexed_files: workspace.indexed_files,
        },
    );

    let background_app = app.clone();
    let background_id = id.clone();
    let background_root = canonical.clone();
    std::thread::spawn(move || {
        let (symbols, _indexed_files) = index_workspace(&background_root);
        if let Ok(updated) = set_symbols(&background_id, symbols.clone()) {
            let _ = db::save_symbols(&background_root.to_string_lossy(), &symbols);
            emit_progress(
                &background_app,
                IndexProgress {
                    workspace_id: background_id,
                    phase: "complete".to_string(),
                    indexed_files: updated.indexed_files,
                },
            );
        }
    });

    Ok(workspace)
}

fn start_watcher(
    root: &std::path::Path,
    workspace_id: &str,
    app: tauri::AppHandle,
) -> Result<notify::RecommendedWatcher, String> {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|e| format!("cannot start file watcher: {e}"))?;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("cannot watch workspace: {e}"))?;

    let id = workspace_id.to_string();
    let root_path = root.to_path_buf();
    std::thread::spawn(move || {
        while let Ok(_event) = rx.recv() {
            while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
            let _ = app.emit("files_changed", id.clone());
            let (symbols, _indexed_files) = index_workspace(&root_path);
            let _ = db::save_symbols(&root_path.to_string_lossy(), &symbols);
            if let Ok(updated) = set_symbols(&id, symbols) {
                let _ = app.emit(
                    "index_progress",
                    IndexProgress {
                        workspace_id: id.clone(),
                        phase: "complete".to_string(),
                        indexed_files: updated.indexed_files,
                    },
                );
            }
        }
    });
    Ok(watcher)
}

#[tauri::command]
pub fn file_tree(workspace_id: String, path: Option<String>) -> Result<Vec<TreeNode>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, path.as_deref().unwrap_or(""))?;
    if !target.is_dir() {
        return Err("tree path is not a directory".to_string());
    }

    let walker = ignore::WalkBuilder::new(&target)
        .max_depth(Some(1))
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build();

    let mut nodes = Vec::new();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let entry_path = entry.path();
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        let relative = entry_path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry_path.to_string_lossy().replace('\\', "/"));
        nodes.push(TreeNode {
            name: entry_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: relative,
            is_dir: file_type.is_dir(),
        });
    }

    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

#[tauri::command]
pub fn file_read(workspace_id: String, path: String) -> Result<FileDocument, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let metadata = std::fs::metadata(&target)
        .map_err(|e| format!("cannot read file metadata: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".to_string());
    }
    if is_probably_binary(&std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))?) {
        return Err("binary files are not shown".to_string());
    }
    let truncated = metadata.len() > MAX_READ_SIZE;
    let bytes = std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))?;
    let take_len = if truncated {
        MAX_READ_SIZE.min(bytes.len() as u64) as usize
    } else {
        bytes.len()
    };
    let content = decode_lossy(&bytes[..take_len]);
    let language = language_for_path(&target).to_string();
    let highlights = highlight_source(&content, &language);

    Ok(FileDocument {
        path: path.clone(),
        name: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone()),
        language,
        content,
        highlights,
        size: metadata.len(),
        truncated,
    })
}

#[tauri::command]
pub fn highlight(workspace_id: String, path: String) -> Result<Vec<HighlightSpan>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _truncated) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    Ok(highlight_source(
        &content,
        language_for_path(&target),
    ))
}

#[tauri::command]
pub fn outline(workspace_id: String, path: String) -> Result<Vec<Symbol>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    let relative = target
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.clone());
    Ok(extract_symbols(&target, &relative, &content))
}

#[tauri::command]
pub fn search(
    workspace_id: String,
    query: String,
    options: Option<SearchOptions>,
    app: tauri::AppHandle,
) -> Result<SearchResponse, String> {
    let search_options = options.unwrap_or_default();
    search_workspace(&workspace_id, &query, &search_options, |batch: Vec<SearchResult>| {
        let _ = app.emit("search_batch", batch);
    })
}

#[tauri::command]
pub fn resolve_definition(
    workspace_id: String,
    path: String,
    start: usize,
    end: Option<usize>,
) -> Result<Vec<NavigationTarget>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    let offset = end.unwrap_or(start).min(content.len());
    let clicked_name = symbol_at(&content, offset)
        .ok_or_else(|| "no symbol under cursor".to_string())?;
    let symbols = workspace_symbols(&workspace_id)?;
    let mut targets: Vec<NavigationTarget> = symbols
        .iter()
        .filter(|symbol| {
            symbol.name == clicked_name
                && matches!(symbol.kind.as_str(), "function" | "method" | "class" | "interface" | "type" | "constant")
                && symbol.path != path
                || symbol.name == clicked_name
                    && symbol.path == path
                    && (symbol.start != start || symbol.end != offset)
        })
        .map(|symbol| NavigationTarget {
            path: symbol.path.clone(),
            name: symbol.name.clone(),
            kind: symbol.kind.clone(),
            start: symbol.start,
            end: symbol.end,
            start_line: symbol.start_line + 1,
            start_column: symbol.start_column + 1,
        })
        .take(100)
        .collect();

    if targets.is_empty() {
        if let Ok(Some(symbol)) = db::find_symbol(
            &root.to_string_lossy(),
            &clicked_name,
        ) {
            targets.push(NavigationTarget {
                path: symbol.path.clone(),
                name: symbol.name,
                kind: symbol.kind,
                start: symbol.start,
                end: symbol.end,
                start_line: symbol.start_line + 1,
                start_column: symbol.start_column + 1,
            });
        }
    }
    Ok(targets)
}


