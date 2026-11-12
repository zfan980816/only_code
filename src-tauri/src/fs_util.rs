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
    // BOM-first: explicit marks always win.
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE.decode(&bytes[2..]).0.into_owned();
    }
    // Strict UTF-8: the overwhelmingly common case, keep byte-exact fidelity.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    // Not UTF-8: legacy Chinese projects are usually GBK/GB2312, both subsets
    // of GB18030. Decode with it before giving up to replacement chars.
    let (text, _enc, had_errors) = encoding_rs::GB18030.decode(bytes);
    if !had_errors {
        return text.into_owned();
    }
    // Unknown encoding: last resort, lossy UTF-8.
    String::from_utf8_lossy(bytes).into_owned()
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
    fn decodes_gbk_chinese_comments() {
        let utf8 = "// 这是一个中文注释";
        let (gbk, _, had_errors) = encoding_rs::GBK.encode(utf8);
        assert!(!had_errors);
        assert_eq!(decode_lossy(&gbk), utf8);
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let (bytes, _, had_errors) = encoding_rs::UTF_16LE.encode("\u{feff}// hi");
        assert!(!had_errors);
        assert_eq!(decode_lossy(&bytes), "// hi");
    }

    #[test]
    fn keeps_utf8_byte_exact() {
        let text = "const x = 1; // café ünïcode";
        assert_eq!(decode_lossy(text.as_bytes()), text);
    }

    #[test]
    fn maps_byte_offsets_to_line_columns() {
        let (line, column) = line_col_at("alpha\nbeta", 7);
        assert_eq!((line, column), (1, 1));
        assert_eq!(language_for_path(Path::new("src/App.tsx")), "tsx");
    }
}




