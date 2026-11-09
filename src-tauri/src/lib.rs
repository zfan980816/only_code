mod commands;
mod db;
mod fs_util;
mod indexer;
mod language;
mod models;
mod search;
mod state;
mod symbols;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::file_tree,
            commands::file_read,
            commands::highlight,
            commands::outline,
            commands::search,
            commands::resolve_definition,
            commands::find_references,
            commands::fuzzy_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Light Reader");
}


