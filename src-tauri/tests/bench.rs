// Reproducible performance benchmarks on a synthetic 10,000-file repository.
// Ignored by default: run with `cargo test --release --test bench -- --ignored --nocapture`
use light_reader_lib::indexer::index_workspace;
use light_reader_lib::models::SearchOptions;
use light_reader_lib::search::search_workspace;
use light_reader_lib::state;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const TOP_DIRS: usize = 10;
const SUB_DIRS: usize = 10;
const FILES_PER_SUB: usize = 100; // 10 * 10 * 100 = 10,000 files

fn ext_for(i: usize) -> &'static str {
    [".ts", ".tsx", ".py", ".js", ".java", ".rs", ".go", ".json", ".md", ".css"][i % 10]
}

fn gen_content(i: usize, dir: usize) -> String {
    let ext = ext_for(i);
    if ext == ".json" {
        return format!("{{\n  \"name\": \"module-{dir}-{i}\",\n  \"version\": \"1.0.{i}\",\n  \"items\": [1, 2, 3],\n  \"enabled\": true\n}}\n");
    }
    if ext == ".md" {
        return format!("# Module {dir}-{i}\n\ngetUserData and handleRequest live here.\n\n## Notes\n\n- item {i}\n- item {}\n", i + 1);
    }
    let mut out = String::new();
    out.push_str(&format!("// file {dir}-{i}: generated benchmark module\n"));
    out.push_str("// \u{4e2d}\u{6587}\u{6ce8}\u{91ca}\u{ff1a}\u{6d4b}\u{8bd5}\u{7f16}\u{7801}\u{517c}\u{5bb9}\u{6027}\n");
    for k in 0..12 {
        out.push_str(&format!(
            "export function getUserData_{i}_{k}(id: number): string {{\n  const cache = loadCache(id);\n  return `user-${{cache}}-{{id}}`;\n}}\n\n"
        ));
    }
    out.push_str(&format!("export const CONFIG_{i} = {{ retries: {i}, timeout: 3000 }};\n"));
    out
}

fn make_corpus(root: &Path) {
    for d in 0..TOP_DIRS {
        for s in 0..SUB_DIRS {
            let dir = root.join(format!("pkg{d}/src/sub{s}"));
            fs::create_dir_all(&dir).unwrap();
            for i in 0..FILES_PER_SUB {
                let n = d * 1000 + s * 100 + i;
                let path = dir.join(format!("file{n}{}", ext_for(i)));
                fs::write(path, gen_content(n, d)).unwrap();
            }
        }
    }
    // .gitignore so tree walks behave like a real repo
    fs::write(root.join(".gitignore"), "target/\nnode_modules/\n*.log\n").unwrap();
}

fn cleanup(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore = "10k-file benchmark; run explicitly"]
fn bench_10k_files() {
    let root: PathBuf = std::env::temp_dir().join(format!("lr-bench-10k-{}", std::process::id()));
    cleanup(&root);

    let t = Instant::now();
    make_corpus(&root);
    println!("corpus 10k files generated in {:?}", t.elapsed());

    // ?? workspace_open core: watcher + state (indexing runs async in the app) ??
    let id = "bench-ws".to_string();
    let (tx, _rx) = std::sync::mpsc::channel();
    let watcher = notify::recommended_watcher(tx).unwrap();
    state::insert_workspace(id.clone(), root.clone(), watcher).unwrap();

    // ?? background indexing (what happens after the UI is already usable) ??
    let t = Instant::now();
    let (symbols, indexed) = index_workspace(&root);
    println!("index_workspace: {:?} -> {} symbols, {} files", t.elapsed(), symbols.len(), indexed);
    assert!(indexed >= 9900, "expected ~10k files indexed, got {indexed}");

    // ?? file tree (root, depth 1) ??
    let t = Instant::now();
    let nodes = light_reader_lib::commands::file_tree(id.clone(), None).unwrap();
    println!("file_tree(root): {:?} -> {} nodes", t.elapsed(), nodes.len());

    // ?? search for a term present in most files ??
    let opts = SearchOptions::default();
    let t = Instant::now();
    let resp = search_workspace(&id, "getUserData", &opts, |_| {}).unwrap();
    println!("search 'getUserData': {:?} -> {} files matched", t.elapsed(), resp.results.len());

    // ?? search with no matches (worst case: scans everything) ??
    let t = Instant::now();
    let resp = search_workspace(&id, "zzz_no_such_term_zzz", &opts, |_| {}).unwrap();
    println!("search no-match (full scan): {:?} -> {} files", t.elapsed(), resp.results.len());

    // ?? fuzzy file open ??
    let t = Instant::now();
    let hits = light_reader_lib::commands::fuzzy_files(id.clone(), "file5000".into(), None).unwrap();
    println!("fuzzy_files: {:?} -> {} hits", t.elapsed(), hits.len());
    assert!(!hits.is_empty());

    // ?? single file read (a mid-size generated file) ??
    let t = Instant::now();
    let doc = light_reader_lib::commands::file_read(id.clone(), "pkg5/src/sub0/file5000.ts".into()).unwrap();
    println!("file_read: {:?} -> {} bytes, lang {}", t.elapsed(), doc.size, doc.language);

    cleanup(&root);
    println!("BENCH OK");
}
