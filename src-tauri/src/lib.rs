pub mod commands;
pub mod db;
pub mod fs_util;
pub mod indexer;
pub mod language;
pub mod models;
pub mod search;
pub mod state;
pub mod symbols;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::file_tree,
            commands::file_read,
            commands::file_write,
            commands::git_file_diff,
            commands::git_changed_files,
            commands::git_log,
            commands::git_branches,
            commands::git_commit_detail,
            commands::git_commit_file_diff,
            commands::git_working_changes,
            commands::git_working_diff,
            commands::git_blame,
            commands::call_hierarchy,
            commands::file_rename,
            commands::file_delete,
            commands::file_create,
            commands::highlight,
            commands::outline,
            commands::search,
            commands::resolve_definition,
            commands::find_references,
            commands::goto_definition,
            commands::fuzzy_files,
            commands::fuzzy_symbols
        ])
        .run(tauri::generate_context!())
        .expect("error while running Light Reader");
}




