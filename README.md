# Light Reader

A lightweight, read-first local code reader built for the AI-assisted development workflow: browse and understand code without opening a full IDE.

## Current capabilities

- Open a local folder as a read-only workspace
- Lazy file tree with `.gitignore` support
- Syntax highlighting for JavaScript/TypeScript/TSX, Python, and Java via Tree-sitter
- Streaming full-text/regex search
- File outline and go-to-definition MVP
- Workspace symbol persistence in SQLite and incremental refresh on file changes

## Development

```bash
npm install
npm run tauri dev
```

### Production build

```bash
npm run tauri build
```

Windows builds require the Rust MSVC toolchain and Visual Studio Build Tools. macOS and Linux use their usual Tauri prerequisites.

## Security model

- The workspace is opened read-only.
- All IPC paths are validated to remain inside the workspace.
- The app does not execute repository code, access the network by default, or collect telemetry.
- Index data is stored under the user data directory, not in the workspace.

## License

MIT OR Apache-2.0
