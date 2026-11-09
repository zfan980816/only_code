use std::path::{Component, Path, PathBuf};

pub const MAX_READ_SIZE: u64 = 2 * 1024 * 1024;
pub const MAX_INDEX_SIZE: u64 = 1024 * 1024;
pub const MAX_INDEX_FILES: usize = 20_000;

pub fn workspace_path(id: &str) -> Result<PathBuf, String> {
    crate::state::workspace_root(id).map_err(|_| format!("workspace {} is not open", id))
}

pub fn safe_relative_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty() {
        return Ok(root.to_path_buf());
    }
    if rel.is_absolute() || rel.has_root() {
        return Err("absolute paths are not allowed".to_string());
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("path traversal is not allowed".to_string()),
        }
    }
    let joined = root.join(rel);
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("workspace root disappeared: {e}"))?;
    let candidate = if joined.exists() {
        joined
            .canonicalize()
            .map_err(|e| format!("cannot resolve path: {e}"))?
    } else {
        joined
    };
    if !candidate.starts_with(&canonical_root) {
        return Err("path escapes the workspace".to_string());
    }
    Ok(candidate)
}

pub fn language_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" => "typescript",
        "tsx" => "tsx",
        "py" | "pyi" => "python",
        "java" => "java",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "rs" => "rust",
        "go" => "go",
        "css" | "scss" | "less" => "css",
        "html" | "htm" => "html",
        "yml" | "yaml" => "yaml",
        "toml" => "toml",
        _ => "text",
    }
}

pub fn is_probably_binary(bytes: &[u8]) -> bool {
    let sample_len = bytes.len().min(8192);
    bytes[..sample_len].contains(&0)
}

pub fn decode_lossy(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).into_owned()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub fn line_col_at(source: &str, byte_offset: usize) -> (usize, usize) {
    let clamped = byte_offset.min(source.len());
    let safe_stop = source
        .char_indices()
        .take_while(|(idx, _)| *idx < clamped)
        .count();
    let prefix = source.get(..safe_stop).unwrap_or("");
    let line = prefix.matches('\n').count();
    let column = prefix
        .rsplit('\n')
        .next()
        .unwrap_or("")
        .chars()
        .count();
    (line, column)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn rejects_parent_traversal() {
        let root = std::env::temp_dir();
        assert!(safe_relative_path(&root, "../outside").is_err());
        assert!(safe_relative_path(&root, "a/../../outside").is_err());
    }

    #[test]
    fn detects_binary_content() {
        assert!(is_probably_binary(&[104, 105, 0, 123]));
        assert!(!is_probably_binary(b"plain text"));
    }

    #[test]
    fn strips_utf8_bom() {
        let text = decode_lossy(&[0xEF, 0xBB, 0xBF, b'a', b'b']);
        assert_eq!(text, "ab");
    }

    #[test]
    fn maps_byte_offsets_to_line_columns() {
        let (line, column) = line_col_at("alpha\nbeta", 7);
        assert_eq!((line, column), (1, 1));
        assert_eq!(language_for_path(Path::new("src/App.tsx")), "tsx");
    }
}




