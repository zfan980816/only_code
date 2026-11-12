use crate::fs_util::{decode_lossy, is_probably_binary, line_col_at};
use crate::language::SourceLanguage;
use crate::models::Symbol;
use std::{fs, path::Path};
pub fn extract_symbols(path: &Path, relative_path: &str, source: &str) -> Vec<Symbol> {
    let language = SourceLanguage::from_path(path);
    let Some(tree_language) = language.tree_language() else {
        return Vec::new();
    };
    let mut parser = tree_sitter::Parser::new();
    if parser.set_language(&tree_language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let mut symbols = Vec::new();
    walk_symbol_node(
        tree.root_node(),
        source.as_bytes(),
        relative_path,
        &language,
        &mut symbols,
        0,
    );
    symbols
}

fn node_text(node: tree_sitter::Node, source: &[u8]) -> String {
    String::from_utf8_lossy(&source[node.byte_range()]).into_owned()
}

fn child_name(node: tree_sitter::Node, source: &[u8]) -> Option<String> {
    let name_node = node.child_by_field_name("name")?;
    let text = node_text(name_node, source).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn walk_symbol_node(
    node: tree_sitter::Node,
    source: &[u8],
    relative_path: &str,
    language: &SourceLanguage,
    symbols: &mut Vec<Symbol>,
    depth: usize,
) {
    if depth > 80 {
        return;
    }

    let kind = node.kind();
    let symbol_kind = match (language, kind) {
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "function_declaration" | "function_signature" | "generator_function_declaration",
        ) => Some("function"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "method_definition" | "method_signature" | "abstract_method_signature",
        ) => Some("method"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "class_declaration" | "class",
        ) => Some("class"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "interface_declaration",
        ) => Some("interface"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "type_alias_declaration" | "enum_declaration",
        ) => Some("type"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "variable_declarator",
        ) => Some("constant"),
        (
            SourceLanguage::JavaScript | SourceLanguage::TypeScript | SourceLanguage::Tsx,
            "import_statement",
        ) => Some("import"),
        (SourceLanguage::Python, "function_definition") => Some("function"),
        (SourceLanguage::Python, "class_definition") => Some("class"),
        (SourceLanguage::Python, "assignment") => Some("constant"),
        (SourceLanguage::Python, "import_statement" | "import_from_statement") => {
            Some("import")
        }
        (SourceLanguage::Java, "method_declaration") => Some("method"),
        (SourceLanguage::Java, "class_declaration") => Some("class"),
        (SourceLanguage::Java, "interface_declaration") => Some("interface"),
        (SourceLanguage::Java, "enum_declaration" | "record_declaration") => Some("type"),
        (SourceLanguage::Java, "field_declaration") => Some("constant"),
        (SourceLanguage::Java, "import_declaration") => Some("import"),
        _ => None,
    };

    if let Some(symbol_kind) = symbol_kind {
        let name = if matches!(symbol_kind, "import") {
            Some(node_text(node, source).replace('\n', " ").trim().to_string())
        } else if language == &SourceLanguage::Python
            && symbol_kind == "constant"
        {
            node.child_by_field_name("left")
                .map(|left| node_text(left, source))
        } else if language == &SourceLanguage::Java && symbol_kind == "constant" {
            let mut found = None;
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "variable_declarator" {
                    found = child_name(child, source);
                    if found.is_some() {
                        break;
                    }
                }
            }
            found
        } else {
            child_name(node, source)
        };

        if let Some(name) = name.filter(|name| !name.is_empty() && name.len() <= 240) {
            let start = node.start_position();
            let end = node.end_position();
            symbols.push(Symbol {
                path: relative_path.to_string(),
                name,
                kind: symbol_kind.to_string(),
                start: node.start_byte(),
                end: node.end_byte(),
                start_line: start.row,
                start_column: start.column,
                end_line: end.row,
                end_column: end.column,
            });
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_symbol_node(child, source, relative_path, language, symbols, depth + 1);
    }
}

pub fn read_text_file(path: &Path) -> Option<(String, bool)> {
    let bytes = fs::read(path).ok()?;
    let binary = is_probably_binary(&bytes);
    if binary {
        return None;
    }
    Some((decode_lossy(&bytes), false))
}

pub fn symbol_at(source: &str, byte_offset: usize) -> Option<String> {
    let chars: Vec<(usize, char)> = source.char_indices().collect();
    let mut index = chars
        .iter()
        .position(|(idx, _)| *idx >= byte_offset)
        .unwrap_or(chars.len());
    let is_word = |ch: char| ch.is_alphanumeric() || ch == '_' || ch == '$';
    if index >= chars.len() {
        return None;
    }
    while index > 0 && !is_word(chars[index].1) {
        index -= 1;
    }
    while index > 0 && is_word(chars[index - 1].1) {
        index -= 1;
    }
    let mut end = index;
    while end < chars.len() && is_word(chars[end].1) {
        end += 1;
    }
    let start_byte = chars.get(index)?.0;
    let end_byte = chars
        .get(end)
        .map(|(idx, _)| *idx)
        .unwrap_or(source.len());
    let word = source.get(start_byte..end_byte)?;
    if word.is_empty() {
        None
    } else {
        Some(word.to_string())
    }
}

pub fn line_column(source: &str, byte_offset: usize) -> (usize, usize) {
    line_col_at(source, byte_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_identifier_at_offset() {
        let source = "fn calculate_total(value: u32) -> u32 { value }";
        let offset = source.find("total").unwrap();
        assert_eq!(symbol_at(source, offset).as_deref(), Some("calculate_total"));
    }

    #[test]
    fn accepts_middle_of_identifier() {
        let source = "let refresh_state = true;";
        let offset = source.find("state").unwrap();
        assert_eq!(symbol_at(source, offset).as_deref(), Some("refresh_state"));
    }

    #[test]
    fn line_column_is_zero_based() {
        let (line, column) = line_column("alpha\nbeta", 7);
        assert_eq!((line, column), (1, 1));
    }
}


