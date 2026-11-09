use crate::fs_util::{decode_lossy, is_probably_binary};
use crate::models::{SearchMatch, SearchOptions, SearchResponse, SearchResult};
use crate::state::workspace_root;
use regex::RegexBuilder;
use std::fs;

pub fn search_workspace(
    workspace_id: &str,
    query: &str,
    options: &SearchOptions,
    mut on_batch: impl FnMut(Vec<SearchResult>),
) -> Result<SearchResponse, String> {
    if query.trim().is_empty() {
        return Ok(SearchResponse {
            results: Vec::new(),
            truncated: false,
            files_searched: 0,
        });
    }
    let root = workspace_root(workspace_id)?;
    let max_results = options.max_results.unwrap_or(500).clamp(1, 5000);
    let mut pattern = query.to_string();
    if !options.regex {
        pattern = regex::escape(&pattern);
    }
    if options.whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    let regex = RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| format!("invalid search expression: {e}"))?;

    let path_filter = options
        .path_filter
        .as_ref()
        .map(|value| value.to_ascii_lowercase());

    let walker = ignore::WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build();

    let mut results = Vec::new();
        let mut total_matches = 0usize;
    let mut files_searched = 0usize;
    let mut truncated = false;
    let mut pending_batch = Vec::new();

    for entry in walker.flatten() {
        if total_matches >= max_results {
            truncated = true;
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));
        if let Some(filter) = &path_filter {
            if !relative.to_ascii_lowercase().contains(filter) {
                continue;
            }
        }
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        if metadata.len() > crate::fs_util::MAX_READ_SIZE {
            continue;
        }
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        if is_probably_binary(&bytes) {
            continue;
        }
        let content = decode_lossy(&bytes);
        files_searched += 1;

        let mut matches = Vec::new();
        for (line_index, line) in content.lines().enumerate() {
            if matches.len() >= 20 {
                break;
            }
            let line_byte_start = byte_offset_of_line(&content, line_index);
            let line_start_char = content[..line_byte_start].chars().count();
            let mut last_end_char = 0usize;
            for capture in regex.find_iter(line) {
                let start_char = line[..capture.start()].chars().count();
                let end_char = line[..capture.end()].chars().count();
                if end_char <= last_end_char {
                    continue;
                }
                last_end_char = end_char;
                matches.push(SearchMatch {
                    line: line_index + 1,
                    start: line_start_char + start_char,
                    end: line_start_char + end_char,
                    text: line.chars().take(500).collect(),
                });
                total_matches += 1;
                if total_matches >= max_results || matches.len() >= 20 {
                    truncated = total_matches >= max_results;
                    break;
                }
            }
            if total_matches >= max_results {
                break;
            }
        }

        if !matches.is_empty() {
            let result = SearchResult {
                path: relative.clone(),
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| relative.clone()),
                matches,
            };
            pending_batch.push(result.clone());
            results.push(result);
            if pending_batch.len() >= 20 {
                on_batch(std::mem::take(&mut pending_batch));
            }
        }
    }

    if !pending_batch.is_empty() {
        on_batch(std::mem::take(&mut pending_batch));
    }

    Ok(SearchResponse {
        results,
        truncated,
        files_searched,
    })
}

fn byte_offset_of_line(content: &str, line_index: usize) -> usize {
    if line_index == 0 {
        return 0;
    }
    let mut current_line = 0usize;
    for (byte_index, ch) in content.char_indices() {
        if ch == '\n' {
            current_line += 1;
            if current_line == line_index {
                return byte_index + 1;
            }
        }
    }
    content.len()
}



