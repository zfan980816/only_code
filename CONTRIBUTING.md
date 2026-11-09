# Contributing to Light Reader

Thanks for helping improve a read-first code explorer.

## Development

```bash
npm install
npm run tauri dev
```

Frontend-only checks:

```bash
npm run lint
npm run build
```

Backend checks:

```bash
cd src-tauri
cargo test
```

## Principles

- Keep the workspace read-only.
- Never execute code found in a user repository.
- Keep startup fast: scan lazily and index in the background.
- Respect `.gitignore` and never write index/cache data into the workspace.
- Prefer local-first behavior; network access is opt-in and not required for core features.

## Pull requests

1. Describe the user-facing problem.
2. Include tests for path safety, search, indexing, or UI behavior where practical.
3. Run `npm run build` and `cargo test` before requesting review.

By participating, you agree to uphold the Code of Conduct.
