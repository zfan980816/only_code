use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLanguage {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Java,
    Text,
}

impl SourceLanguage {
    pub fn from_path(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "js" | "mjs" | "cjs" => Self::JavaScript,
            "jsx" => Self::Tsx,
            "ts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "py" | "pyi" => Self::Python,
            "java" => Self::Java,
            _ => Self::Text,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::JavaScript => "javascript",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::Python => "python",
            Self::Java => "java",
            Self::Text => "text",
        }
    }

    pub fn tree_language(&self) -> Option<tree_sitter::Language> {
        let language = match self {
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
            Self::Text => return None,
        };
        Some(language)
    }

    pub fn highlight_configuration(
        &self,
    ) -> Option<tree_sitter_highlight::HighlightConfiguration> {
        let language = self.tree_language()?;
        let query = match self {
            Self::JavaScript => tree_sitter_javascript::HIGHLIGHT_QUERY.to_string(),
            Self::TypeScript | Self::Tsx => format!(
                "{}\n{}",
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY
            ),
            Self::Python => tree_sitter_python::HIGHLIGHTS_QUERY.to_string(),
            Self::Java => tree_sitter_java::HIGHLIGHTS_QUERY.to_string(),
            Self::Text => return None,
        };
        let mut config = tree_sitter_highlight::HighlightConfiguration::new(
            language,
            "light-reader",
            &query,
            "",
            "",
        )
        .ok()?;
        config.configure(&HIGHLIGHT_NAMES);
        Some(config)
    }
}

pub const HIGHLIGHT_NAMES: &[&str] = &[
    "attribute",
    "comment",
    "constant",
    "function",
    "keyword",
    "operator",
    "property",
    "punctuation",
    "string",
    "type",
    "variable",
];

