use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLanguage {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Java,
    Rust,
    Go,
    C,
    Cpp,
    CSharp,
    Json,
    Css,
    Html,
    Xml,
    Vue,
    Svelte,
    Sql,
    Ruby,
    Php,
    Kotlin,
    Swift,
    Yaml,
    Toml,
    Shell,
    Lua,
    Markdown,
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
            "rs" => Self::Rust,
            "go" => Self::Go,
            "c" | "h" => Self::C,
            "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => Self::Cpp,
            "cs" => Self::CSharp,
            "json" | "jsonc" | "json5" => Self::Json,
            "css" | "scss" | "less" => Self::Css,
            "html" | "htm" => Self::Html,
            "xml" | "svg" => Self::Xml,
            "vue" => Self::Vue,
            "svelte" => Self::Svelte,
            "sql" => Self::Sql,
            "rb" => Self::Ruby,
            "php" => Self::Php,
            "kt" | "kts" => Self::Kotlin,
            "swift" => Self::Swift,
            "yml" | "yaml" => Self::Yaml,
            "toml" => Self::Toml,
            "sh" | "bash" | "zsh" => Self::Shell,
            "lua" => Self::Lua,
            "md" | "markdown" => Self::Markdown,
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
            Self::Rust => "rust",
            Self::Go => "go",
            Self::C => "c",
            Self::Cpp => "cpp",
            Self::CSharp => "csharp",
            Self::Json => "json",
            Self::Css => "css",
            Self::Html => "html",
            Self::Xml => "xml",
            Self::Vue => "vue",
            Self::Svelte => "svelte",
            Self::Sql => "sql",
            Self::Ruby => "ruby",
            Self::Php => "php",
            Self::Kotlin => "kotlin",
            Self::Swift => "swift",
            Self::Yaml => "yaml",
            Self::Toml => "toml",
            Self::Shell => "shell",
            Self::Lua => "lua",
            Self::Markdown => "markdown",
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
            _ => return None,
        };
        Some(language)
    }

}


