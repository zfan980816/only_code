use crate::fs_util::{decode_lossy, is_probably_binary, language_for_path, MAX_INDEX_FILES, MAX_INDEX_SIZE};
use crate::models::Symbol;
use crate::symbols::extract_symbols;
use ignore::WalkBuilder;
use std::path::Path;

pub fn index_workspace(root: &Path) -> (Vec<Symbol>, usize) {
    let walker = WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build();

    let mut symbols = Vec::new();
    let mut indexed_files = 0usize;

    for entry in walker.flatten() {
        if indexed_files >= MAX_INDEX_FILES {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let display_language = language_for_path(path);
        if display_language == "text" {
            continue;
        }
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if metadata.len() > MAX_INDEX_SIZE {
            continue;
        }
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        if is_probably_binary(&bytes) {
            continue;
        }
        let source = decode_lossy(&bytes);
        let relative = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
        symbols.extend(extract_symbols(path, &relative, &source));
        indexed_files += 1;
    }

    symbols.sort_by(|a, b| a.path.cmp(&b.path).then(a.start.cmp(&b.start)));
    (symbols, indexed_files)
}
