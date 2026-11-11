// Real-process smoke test against rust-analyzer. Ignored by default so
// regular `cargo test` stays green on machines without language servers.
// Run locally with: cargo test --release --test lsp_smoke -- --ignored
use light_reader_lib::lsp::LspClient;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

#[test]
#[ignore = "requires rust-analyzer on PATH"]
fn lsp_definition_smoke_with_rust_analyzer() {
    let dir: PathBuf = std::env::temp_dir().join(format!("lr-lsp-smoke-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).expect("create project");
    fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"smoke\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    let lib = "pub fn target_fn() -> i32 { 42 }\n\npub fn caller() -> i32 { target_fn() }\n";
    fs::write(dir.join("src/lib.rs"), lib).unwrap();

    let client = LspClient::spawn("rust-analyzer", &dir).expect("spawn rust-analyzer");
    let lib_path = dir.join("src/lib.rs");
    client.ensure_open(&lib_path, lib, "rust").expect("didOpen");

    let caller_line = lib.lines().nth(2).expect("caller line");
    let col = caller_line.find("target_fn").expect("symbol in line");

    // rust-analyzer may not have analyzed the tiny workspace yet; retry until
    // it returns a concrete location (or give up after ~30s).
    let mut last = String::new();
    for _ in 0..15 {
        let result = client
            .position_request(
                "textDocument/definition",
                &lib_path,
                lib,
                "rust",
                2,
                col,
                true,
            )
            .expect("definition request");
        last = serde_json::to_string(&result).unwrap();
        if last.contains("lib.rs") {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    assert!(last.contains("lib.rs"), "expected a definition location, got: {last}");

    let _ = fs::remove_dir_all(&dir);
}
