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



