[English](README.md) | [简体中文](README.zh-CN.md)

# Light Reader

A lightweight local code reader built for the AI-assisted development era - fast to open, searchable, navigable; and when a small change is needed you can edit and save right away, without launching a full IDE.

## Features

- Local workspace management: open folders, drag-and-drop import, recent workspaces, session restore
- Lazy-loading file tree with `.gitignore` support; hidden / oversized / binary files are safely skipped
- Automatic encoding detection: UTF-8 / UTF-16 BOM / GBK - GB2312 - GB18030 (no more garbled comments in legacy Chinese projects)
- Syntax highlighting: full parsing for JavaScript / TypeScript / TSX / Python / Java; keyword highlighting for Rust / Go / C / C++ / C# / PHP / Ruby / Kotlin / Swift / Lua / SQL / Shell / JSON / YAML / TOML / CSS / HTML / XML / Vue / Svelte / Markdown
- Full-text and regex search with streaming results
- IDE-style grouped outline (Imports / Classes / Functions / Constants / Types), symbol search, go-to-definition, find references
- **Optional LSP precise navigation**: auto-detects rust-analyzer / pyright / gopls / clangd and more; IDE-grade jump accuracy with automatic fallback to the built-in parser when no server is installed
- Read-first, with editing when needed: edit, Ctrl+S to save, find & replace
- Create, rename and delete files with live tree sync
- File tabs, in-file search, code zoom, fixed line numbers and current-line highlight
- Click any identifier to highlight all references in the current file; status bar shows the match count; `F3` / `Shift+F3` to jump between matches
- Block comments (`/* */`, JSDoc) and line comments are colored consistently
- Back / Forward navigation history
- Git History: commit graph, search by text/hash, branch / author / date / path filters, commit details, grouped changed files and per-file diff
- **Review mode**: GitHub-style diff view - inline red/green highlights, word-level change marks, syntax coloring, hunk navigation (Alt+Up/Down), one-click open file; a sidebar badge shows the number of uncommitted files for one-click review
- Git working tree changes: file list and diff of Working Tree vs HEAD, with change badges directly in the file tree
- Light / dark themes (including follow-system), IDE-style three-pane layout, resizable panels
- Local settings: UI language, theme, code font size / family / line spacing, line numbers, current-line highlight, session restore, delete confirmation
- Per-file reading positions are remembered; project images (png/jpg/gif/webp/svg) preview inline

## Getting Started

### Option 1: Run from source (developers)

#### Prerequisites

| Dependency | Minimum | Notes |
|------|----------|------|
| Node.js | v18+ | Frontend build |
| Rust | stable | Backend build |
| Visual Studio Build Tools | 2022 | Windows C++ build (select "Desktop development with C++") |
| WebView2 | latest | Preinstalled on Windows 11; Windows 10 needs installation |

#### Steps

```bash
# 1. Clone
git clone https://github.com/zfan980816/only_code.git
cd only_code

# 2. Install frontend dependencies
npm install

# 3. Start the desktop app (dev mode)
npm run tauri dev
```

The first launch compiles the Rust backend and takes a few minutes. The window opens when ready.

### Option 2: Frontend only (browser preview)

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Browser mode cannot open local folders (the Tauri backend is required).

### Option 3: Build installers

```bash
npm run tauri build
```

Installers land in `src-tauri/target/release/bundle/`. A release workflow also builds Windows / macOS / Linux bundles automatically when a `v*` tag is pushed.

## Usage Guide

### 1. Open a code folder

Click **Open Folder** on the left, or drag a folder into the window.

Supported: Git repositories (`.gitignore` respected automatically) and plain folders (`node_modules`, `.git` and other hidden directories are skipped).

### 2. Browse files

- Click folders to expand, click files to open the code view
- Syntax highlighting is automatic per file type
- Hover a file in the tree for its Git status badge and colored name
- Click **Edit** (top right) to modify code, `Ctrl+S` to save
- In edit mode `Ctrl+H` opens find & replace

### 3. Global search

Switch to **Search** in the left rail:

| Option | Notes |
|------|--------|
| Text search | Type a keyword |
| Regex | Toggle `.*` |
| Case sensitive | Toggle `Aa` |
| Whole word | Toggle Word |

Results are grouped by file; click one to jump to the exact line.

### 4. Go to definition

**Ctrl + Click** any identifier (or **Cmd + Click** on macOS):

- Uses the LSP server when available for IDE-grade accuracy
- Falls back to the built-in Tree-sitter index
- **Ctrl + Alt + Click** finds references (same priority order)

### 5. Outline

The right panel lists symbols of the current file grouped by Imports / Classes / Functions / Constants / Types. Click an item to jump.

### 6. Recent files

**Recent** at the bottom of the left panel keeps the last 20 files for one-click switching.

### 7. Keyboard shortcuts

| Shortcut | Action |
|--------|------|
| `Ctrl + O` | Open folder |
| `Ctrl + P` | Quick open file |
| `Ctrl + Shift + N` | Search symbols |
| `Ctrl + Shift + F` | Global search panel |
| `Ctrl + F` | Search in file |
| `Ctrl + G` | Go to line |
| `Ctrl + H` | Find & replace (edit mode) |
| `Ctrl + S` | Save file |
| `Ctrl + Tab` / `Ctrl + Shift + Tab` | Next / previous tab |
| `Ctrl + W` | Close tab |
| `Ctrl + Mouse wheel` | Zoom code |
| `Ctrl + Click` | Go to definition |
| `Ctrl + Alt + Click` | Find references |
| `Ctrl + Shift + C` | Copy file path |
| `F3` / `Shift + F3` | Next / previous occurrence |
| `Alt + Left` / `Alt + Right` | Navigate back / forward |
| `Alt + Up` / `Alt + Down` | Previous / next diff hunk (review mode) |
| Middle click | Close tab |

## Git History

### Commit history

- Commit graph with subject, author, time and branch labels
- Filter by text/hash, branch, author, date range and paths
- Commit details with per-file diff on the right
- Handles unicode paths, sub-repositories, root and merge commits

### Uncommitted changes (review AI edits)

Switch to **Uncommitted** (or click the Review button with the count badge):

- Lists modified / added / deleted files from the working tree
- GitHub-style diff: line-level red/green backgrounds, word-level marks, syntax coloring
- `Alt+Up` / `Alt+Down` or the arrows jump between hunks
- **Open file** jumps to the change location for further reading

## LSP Language Servers (optional)

Enable in **Settings - Precise navigation (LSP)**; go-to-definition and find references then prefer the language server.

| Language | Server | Auto-detected |
|------|--------|----------|
| Rust | rust-analyzer | Yes |
| Python | pyright-langserver | Yes |
| Go | gopls | Yes |
| C / C++ | clangd | Yes |
| TypeScript / JavaScript | typescript-language-server | Yes |
| Java | jdtls | Yes |

- Falls back to the built-in parser automatically when no server is installed
- Custom commands (e.g. pylsp) can be configured in Settings
- Server processes start lazily per workspace and exit when the window closes

## Performance

Measured on a synthetic 10,000-file repository using the exact same code paths as the app:

| Operation | Time |
|------|------|
| Open file tree (root) | 2.5ms |
| Global search (46 files matched) | 12.9ms |
| Open a single file | 27ms |
| Background full indexing (non-blocking) | 7.4s |

See [docs/benchmarks.md](docs/benchmarks.md) for methodology and how to reproduce.

## Supported Languages

| Language | Highlighting | Symbols | Jump |
|------|----------|----------|------|
| JavaScript / JSX | Tree-sitter | functions/classes/methods/constants/imports | Yes |
| TypeScript / TSX | Tree-sitter | functions/classes/methods/interfaces/types/constants/imports | Yes |
| Python | Tree-sitter | functions/classes/assignments/imports | Yes |
| Java | Tree-sitter | classes/methods/interfaces/enums/fields/imports | Yes |
| Rust / Go / C / C++ / C# / PHP / Ruby / Kotlin / Swift / Lua / SQL / Shell | Keywords | - | - |
| JSON / YAML / TOML / CSS / Markdown | Keywords | - | - |
| HTML / XML / Vue / Svelte | Tags | - | - |
| Everything else | Plain text | - | - |

## Tech Stack

| Layer | Technology |
|------|------|
| Desktop framework | Tauri 2 |
| Backend | Rust |
| Frontend | React 19 + TypeScript + Vite |
| Code view | Custom virtualized reader/editor view |
| Syntax parsing | Tree-sitter |
| Persistence | SQLite (rusqlite) |
| File watching | notify |
| Precise navigation | LSP client (stdio JSON-RPC, optional) |

## Architecture

```
+-----------------------------------------------------+
|                  Tauri desktop app                  |
+-------------+---------------------+-----------------+
|  React UI   |   Tauri IPC layer   |  Rust backend   |
|  Code view  |  workspace_open     |  file scanning  |
|  File tree  |  file_tree          |  Tree-sitter    |
|  Search     |  search             |  symbol index   |
|  Outline    |  resolve_def        |  SQLite store   |
|  Git review |  lsp_definition     |  notify watcher |
+-------------+---------------------+-----------------+
```

## Security Model

- The reader is read-only by default; files are written only when you explicitly edit and save
- All IPC paths are validated against workspace escape
- No code from the workspace is ever executed
- No network access, no telemetry
- Index data lives in the user data directory, never inside your project

## FAQ

### Q: "error: linker not found" on startup

Install [VS Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) on Windows and select "Desktop development with C++".

### Q: Search returns nothing

Check the toggles (case sensitivity, regex syntax). Search is case-insensitive by default.

### Q: Go-to-definition does nothing

Built-in navigation relies on symbol extraction and covers JS/TS/Python/Java only. Install a language server (see LSP section) for other languages and IDE-grade accuracy.

### Q: Large files show "truncated"

Files over 2MB are truncated to protect performance.

### Q: Chinese comments look garbled in old projects

Encoding is auto-detected (UTF-8 / UTF-16 / GBK family by BOM and content sniffing). Unrecognized encodings fall back to lossy UTF-8. Saving always writes UTF-8.

## Roadmap

- [x] File tree + syntax highlighting
- [x] Global search
- [x] Go to definition
- [x] Find references
- [x] In-file occurrence highlighting with F3 navigation
- [x] Git commit history and GitHub-style review diff
- [x] Back / forward navigation
- [x] More languages (Rust / Go / C/C++ / JSON / CSS / HTML and more)
- [x] Optional LSP precise navigation
- [x] Git status badges in the file tree
- [ ] Plugin system
- [ ] Signed macOS builds

## Contributing

PRs are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE)
