use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Emitter;

use crate::db;
use crate::fs_util::{
    decode_lossy, is_probably_binary, language_for_path, safe_relative_path, MAX_READ_SIZE,
};
use crate::indexer::index_workspace;
use crate::models::{
    FileDocument, GitBranch, GitCommit, GitCommitDetail, GitFileChange, GitLogOptions,
    HighlightSpan, IndexProgress, NavigationTarget, SearchOptions, SearchResponse, SearchResult,
    Symbol, TreeNode, Workspace,
};
use crate::search::search_workspace;
use crate::state::{emit_progress, insert_workspace, set_symbols, workspace_root, workspace_symbols};
use crate::symbols::{extract_symbols, highlight_source, read_text_file, symbol_at};

#[tauri::command]
pub fn workspace_open(root: String, app: tauri::AppHandle) -> Result<Workspace, String> {
    let canonical = PathBuf::from(&root)
        .canonicalize()
        .map_err(|e| format!("cannot open folder: {e}"))?;
    if !canonical.is_dir() {
        return Err("selected path is not a directory".to_string());
    }

    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    let id = format!("ws-{:016x}", hasher.finish());
    let root_text = canonical.to_string_lossy().to_string();
    let persisted = db::load_symbols(&root_text)?;

    let watcher = start_watcher(&canonical, &id, app.clone())?;
    insert_workspace(id.clone(), canonical.clone(), watcher)?;

    let workspace = set_symbols(&id, persisted)?;
    emit_progress(
        &app,
        IndexProgress {
            workspace_id: id.clone(),
            phase: "started".to_string(),
            indexed_files: workspace.indexed_files,
        },
    );

    let background_app = app.clone();
    let background_id = id.clone();
    let background_root = canonical.clone();
    std::thread::spawn(move || {
        let (symbols, _indexed_files) = index_workspace(&background_root);
        if let Ok(updated) = set_symbols(&background_id, symbols.clone()) {
            let _ = db::save_symbols(&background_root.to_string_lossy(), &symbols);
            emit_progress(
                &background_app,
                IndexProgress {
                    workspace_id: background_id,
                    phase: "complete".to_string(),
                    indexed_files: updated.indexed_files,
                },
            );
        }
    });

    Ok(workspace)
}

fn start_watcher(
    root: &std::path::Path,
    workspace_id: &str,
    app: tauri::AppHandle,
) -> Result<notify::RecommendedWatcher, String> {
    use notify::Watcher;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|e| format!("cannot start file watcher: {e}"))?;
    watcher
        .watch(root, notify::RecursiveMode::Recursive)
        .map_err(|e| format!("cannot watch workspace: {e}"))?;

    let id = workspace_id.to_string();
    let root_path = root.to_path_buf();
    std::thread::spawn(move || {
        while let Ok(_event) = rx.recv() {
            while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
            let _ = app.emit("files_changed", id.clone());
            let (symbols, _indexed_files) = index_workspace(&root_path);
            let _ = db::save_symbols(&root_path.to_string_lossy(), &symbols);
            if let Ok(updated) = set_symbols(&id, symbols) {
                let _ = app.emit(
                    "index_progress",
                    IndexProgress {
                        workspace_id: id.clone(),
                        phase: "complete".to_string(),
                        indexed_files: updated.indexed_files,
                    },
                );
            }
        }
    });
    Ok(watcher)
}

#[tauri::command]
pub fn file_tree(workspace_id: String, path: Option<String>) -> Result<Vec<TreeNode>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, path.as_deref().unwrap_or(""))?;
    if !target.is_dir() {
        return Err("tree path is not a directory".to_string());
    }

    let walker = ignore::WalkBuilder::new(&target)
        .max_depth(Some(1))
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build();

    let mut nodes = Vec::new();
    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let entry_path = entry.path();
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        let relative = entry_path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| entry_path.to_string_lossy().replace('\\', "/"));
        nodes.push(TreeNode {
            name: entry_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: relative,
            is_dir: file_type.is_dir(),
        });
    }

    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(nodes)
}

#[tauri::command]
pub fn file_read(workspace_id: String, path: String) -> Result<FileDocument, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let metadata = std::fs::metadata(&target)
        .map_err(|e| format!("cannot read file metadata: {e}"))?;
    if !metadata.is_file() {
        return Err("path is not a file".to_string());
    }
    if is_probably_binary(&std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))?) {
        return Err("binary files are not shown".to_string());
    }
    let truncated = metadata.len() > MAX_READ_SIZE;
    let bytes = std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))?;
    let take_len = if truncated {
        MAX_READ_SIZE.min(bytes.len() as u64) as usize
    } else {
        bytes.len()
    };
    let content = decode_lossy(&bytes[..take_len]);
    let language = language_for_path(&target).to_string();
    let highlights = highlight_source(&content, &language);

    Ok(FileDocument {
        path: path.clone(),
        name: target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone()),
        language,
        content,
        highlights,
        size: metadata.len(),
        truncated,
    })
}


#[tauri::command]
pub fn file_create(workspace_id: String, path: String, content: Option<String>) -> Result<(), String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    if target.exists() {
        return Err("file already exists".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create parent dirs: {e}"))?;
    }
    std::fs::write(&target, content.unwrap_or_default().as_bytes())
        .map_err(|e| format!("cannot create file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn file_delete(workspace_id: String, path: String) -> Result<(), String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    if !target.is_file() {
        return Err("target is not a file".to_string());
    }
    std::fs::remove_file(target).map_err(|e| format!("cannot delete: {e}"))
}

#[tauri::command]
pub fn file_rename(workspace_id: String, old_path: String, new_path: String) -> Result<(), String> {
    let root = workspace_root(&workspace_id)?;
    let from = safe_relative_path(&root, &old_path)?;
    let to = safe_relative_path(&root, &new_path)?;
    if !from.is_file() {
        return Err("source file not found".to_string());
    }
    if to.exists() {
        return Err("target already exists".to_string());
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create parent dirs: {e}"))?;
    }
    std::fs::rename(from, to).map_err(|e| format!("cannot rename: {e}"))
}

fn git_command(root: &std::path::Path) -> Command {
    let mut command = Command::new("git");
    command.current_dir(root);
    // Git.exe is a console program on Windows. Without CREATE_NO_WINDOW every
    // Git action flashes a console window and makes history clicks feel slow.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn git_stderr(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).trim().to_string()
}

fn changed_path(status: &str, paths: &[&str]) -> Option<String> {
    // Rename/copy records contain both old and new paths. The outline and file
    // APIs work with the path that exists after HEAD, so expose the new one.
    let path = if (status.starts_with('R') || status.starts_with('C')) && paths.len() > 1 {
        paths[paths.len() - 1]
    } else {
        paths.first()?
    };
    if path.is_empty() { None } else { Some(path.to_string()) }
}

fn ensure_git_commit(root: &std::path::Path, rev: &str) -> Result<(), String> {
    if rev.is_empty()
        || rev.len() > 120
        || !rev.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~/^".contains(c))
    {
        return Err("无效的 Git 提交".to_string());
    }
    let out = git_command(root)
        .args(["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{}^{{commit}}", rev)])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if out.status.success() { Ok(()) } else { Err("Git 提交不存在".to_string()) }
}

fn parse_changed_files(text: &str) -> Vec<GitFileChange> {
    let mut files = Vec::new();
    for line in text.lines() {
        let mut fields = line.split('\t');
        let Some(status) = fields.next() else { continue };
        // Deleted files no longer exist after the commit, so they cannot be
        // resolved as current paths by the outline/file APIs; exclude them.
        if status.starts_with('D') { continue; }
        let paths: Vec<&str> = fields.collect();
        if let Some(path) = changed_path(status, &paths) {
            files.push(GitFileChange { path, status: status.to_string() });
        }
    }
    files
}

fn parse_commit_record(record: &str) -> Option<GitCommit> {
    let fields: Vec<&str> = record.split('\u{1f}').collect();
    if fields.len() < 8 { return None; }
    Some(GitCommit {
        hash: fields[0].trim().to_string(),
        short_hash: fields[1].trim().to_string(),
        subject: fields[2].trim().to_string(),
        body: fields[3].to_string(),
        author_name: fields[4].trim().to_string(),
        author_email: fields[5].trim().to_string(),
        timestamp: fields[6].trim().parse().unwrap_or(0),
        refs: fields[7].trim().to_string(),
        parents: fields[8]
            .split_whitespace()
            .map(|p| p.to_string())
            .collect(),
    })
}

fn changed_files_for_revision(root: &std::path::Path, rev: &str, include_root: bool) -> Result<Vec<GitFileChange>, String> {
    // Locale-independent repo check: LC_ALL=C forces English git messages so
    // "not a git repository" can be matched reliably on any system language.
    let head = git_command(root)
        .env("LC_ALL", "C")
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !head.status.success() {
        let message = git_stderr(&head);
        return Err(if message.contains("not a git repository") {
            "此文件夹不是 Git 仓库".to_string()
        } else {
            "当前仓库还没有提交".to_string()
        });
    }
    ensure_git_commit(root, rev)?;
    let mut args = vec![
        "-c".to_string(), "core.quotepath=false".to_string(), "diff-tree".to_string(),
        "--no-commit-id".to_string(), "--name-status".to_string(), "-r".to_string(),
        "--first-parent".to_string(), "--relative".to_string(),
    ];
    if include_root { args.push("--root".to_string()); }
    args.push(rev.to_string());
    let out = git_command(root).args(&args).output().map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() { return Err(git_stderr(&out)); }
    Ok(parse_changed_files(&String::from_utf8_lossy(&out.stdout)))
}

fn git_commit_from_rev(root: &std::path::Path, rev: &str) -> Result<GitCommit, String> {
    ensure_git_commit(root, rev)?;
    let format = "%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1e";
    let out = git_command(root)
        .args(["-c", "core.quotepath=false", "show", "-s", "--date=unix", &format!("--pretty=format:{}", format), rev])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() { return Err(git_stderr(&out)); }
    String::from_utf8_lossy(&out.stdout)
        .split('\u{1e}')
        .find_map(parse_commit_record)
        .ok_or_else(|| "无法解析 Git 提交".to_string())
}

pub fn git_changed_files_in(root: &std::path::Path) -> Result<Vec<GitFileChange>, String> {
    changed_files_for_revision(root, "HEAD", true)
}

pub fn git_file_diff_in(root: &std::path::Path, path: &str) -> Result<String, String> {
    let out = git_command(root)
        .args([
            "-c", "core.quotepath=false", "diff", "--no-color",
            "HEAD~1", "HEAD", "--",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }

    // For the repository's root commit there is no HEAD~1. diff-tree --root
    // produces the same patch format without the commit message.
    let root_out = git_command(root)
        .args([
            "-c", "core.quotepath=false", "diff-tree", "--patch", "--root",
            "--no-color", "HEAD", "--",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !root_out.status.success() {
        let message = git_stderr(&root_out);
        if message.contains("bad revision") || message.contains("ambiguous argument") {
            return Err("当前仓库还没有提交".to_string());
        }
        return Err(message);
    }
    Ok(String::from_utf8_lossy(&root_out.stdout).to_string())
}

#[tauri::command]
pub fn git_changed_files(workspace_id: String) -> Result<Vec<GitFileChange>, String> {
    let root = workspace_root(&workspace_id)?;
    git_changed_files_in(&root)
}

#[tauri::command]
pub fn git_file_diff(workspace_id: String, path: String) -> Result<String, String> {
    let root = workspace_root(&workspace_id)?;
    safe_relative_path(&root, &path)?;
    git_file_diff_in(&root, &path)
}

pub fn git_log_in(root: &std::path::Path, options: &GitLogOptions) -> Result<Vec<GitCommit>, String> {
    let head = git_command(root).args(["rev-parse", "--verify", "--quiet", "HEAD"]).output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !head.status.success() {
        let message = git_stderr(&head);
        return Err(if message.contains("bad revision") || message.contains("ambiguous argument") {
            "当前仓库还没有提交".to_string()
        } else { "此文件夹不是 Git 仓库".to_string() });
    }

    let format = "%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1e";
    let mut args = vec![
        "-c".to_string(), "core.quotepath=false".to_string(), "log".to_string(),
        "--no-color".to_string(), "--date=unix".to_string(),
        format!("--pretty=format:{}", format),
        format!("--max-count={}", options.limit.clamp(1, 1000)),
    ];
    if options.all_branches { args.push("--all".to_string()); }
    else if let Some(branch) = options.branch.as_deref().filter(|v| !v.trim().is_empty()) {
        args.push(branch.trim().to_string());
    }
    if let Some(author) = options.author.as_deref().filter(|v| !v.trim().is_empty()) { args.push(format!("--author={}", author.trim())); }
    if let Some(since) = options.since.as_deref().filter(|v| !v.trim().is_empty()) { args.push(format!("--since={}", since.trim())); }
    if let Some(until) = options.until.as_deref().filter(|v| !v.trim().is_empty()) { args.push(format!("--until={}", until.trim())); }
    args.push("--".to_string());
    if let Some(path) = options.path.as_deref().filter(|v| !v.trim().is_empty()) { args.push(path.trim().to_string()); }

    let out = git_command(root).args(&args).output().map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() { return Err(git_stderr(&out)); }
    let query = options.query.as_deref().unwrap_or("").trim().to_lowercase();
    let commits = String::from_utf8_lossy(&out.stdout)
        .split('\u{1e}')
        .filter_map(parse_commit_record)
        .filter(|commit| {
            query.is_empty()
                || commit.hash.to_lowercase().contains(&query)
                || commit.short_hash.to_lowercase().contains(&query)
                || commit.subject.to_lowercase().contains(&query)
                || commit.body.to_lowercase().contains(&query)
                || commit.author_name.to_lowercase().contains(&query)
                || commit.author_email.to_lowercase().contains(&query)
        })
        .collect();
    Ok(commits)
}

pub fn git_branches_in(root: &std::path::Path) -> Result<Vec<GitBranch>, String> {
    let head = git_command(root).args(["rev-parse", "--verify", "--quiet", "HEAD"]).output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !head.status.success() { return Err("此文件夹不是 Git 仓库".to_string()); }
    let current_out = git_command(root).args(["rev-parse", "--abbrev-ref", "HEAD"]).output().map_err(|e| format!("git 不可用: {e}"))?;
    let current = String::from_utf8_lossy(&current_out.stdout).trim().to_string();
    let out = git_command(root)
        .args(["-c", "core.quotepath=false", "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() { return Err(git_stderr(&out)); }
    let mut branches = Vec::new();
    for full in String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|v| !v.is_empty()) {
        let (kind, name) = if let Some(name) = full.strip_prefix("refs/heads/") {
            ("local", name)
        } else if let Some(name) = full.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") { continue; }
            ("remote", name)
        } else { continue };
        branches.push(GitBranch {
            name: name.to_string(), full_name: full.to_string(), kind: kind.to_string(),
            is_current: kind == "local" && name == current,
        });
    }
    branches.sort_by(|a, b| b.is_current.cmp(&a.is_current).then(a.kind.cmp(&b.kind)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(branches)
}

pub fn git_commit_detail_in(root: &std::path::Path, hash: &str) -> Result<GitCommitDetail, String> {
    let commit = git_commit_from_rev(root, hash)?;
    let files = changed_files_for_revision(root, &commit.hash, true)?;
    Ok(GitCommitDetail { commit, files })
}

pub fn git_commit_file_diff_in(root: &std::path::Path, hash: &str, path: &str) -> Result<String, String> {
    ensure_git_commit(root, hash)?;
    let parent = git_command(root)
        .args(["rev-parse", "--verify", "--quiet", "--end-of-options", &format!("{}^1", hash)])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    let out = if parent.status.success() {
        git_command(root)
            .args(["-c", "core.quotepath=false", "diff", "--no-color", &format!("{}^1", hash), hash, "--"])
            .arg(path)
            .output()
            .map_err(|e| format!("git 不可用: {e}"))?
    } else {
        git_command(root)
            .args(["-c", "core.quotepath=false", "diff-tree", "--patch", "--root", "--no-color", hash, "--"])
            .arg(path)
            .output()
            .map_err(|e| format!("git 不可用: {e}"))?
    };
    if !out.status.success() { return Err(git_stderr(&out)); }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
pub fn git_log(workspace_id: String, options: Option<GitLogOptions>) -> Result<Vec<GitCommit>, String> {
    let root = workspace_root(&workspace_id)?;
    let options = options.unwrap_or(GitLogOptions { query: None, branch: None, author: None, since: None, until: None, path: None, all_branches: false, limit: 200 });
    git_log_in(&root, &options)
}

#[tauri::command]
pub fn git_branches(workspace_id: String) -> Result<Vec<GitBranch>, String> {
    let root = workspace_root(&workspace_id)?;
    git_branches_in(&root)
}

#[tauri::command]
pub fn git_commit_detail(workspace_id: String, hash: String) -> Result<GitCommitDetail, String> {
    let root = workspace_root(&workspace_id)?;
    git_commit_detail_in(&root, &hash)
}

#[tauri::command]
pub fn git_commit_file_diff(workspace_id: String, hash: String, path: String) -> Result<String, String> {
    let root = workspace_root(&workspace_id)?;
    safe_relative_path(&root, &path)?;
    git_commit_file_diff_in(&root, &hash, &path)
}

fn parse_working_status_line(line: &str) -> Option<GitFileChange> {
    if line.len() < 3 { return None; }
    let status = line[..2].trim().to_string();
    let raw_path = &line[3..];
    let path = raw_path.rsplit(" -> ").next()?.trim().to_string();
    if path.is_empty() { return None; }
    let code = if status.is_empty() { "M".to_string() } else { status.split("").last().unwrap_or("M").to_string() };
    Some(GitFileChange { path, status: code })
}

pub fn git_working_changes_in(root: &std::path::Path) -> Result<Vec<GitFileChange>, String> {
    let head = git_command(root).args(["rev-parse", "--verify", "--quiet", "HEAD"]).output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !head.status.success() { return Err("此文件夹不是 Git 仓库".to_string()); }
    let out = git_command(root)
        .args(["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() { return Err(git_stderr(&out)); }
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some(file) = parse_working_status_line(line) {
            if !files.iter().any(|f: &GitFileChange| f.path == file.path) { files.push(file); }
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(files)
}

pub fn git_working_diff_in(root: &std::path::Path, path: &str) -> Result<String, String> {
    let target = safe_relative_path(root, path)?;
    let files = git_working_changes_in(root)?;
    let entry = files.iter().find(|f| f.path == path);
    let untracked = entry.map(|f| f.status == "?").unwrap_or(false);
    let out = if untracked {
        git_command(root)
            .args(["-c", "core.quotepath=false", "diff", "--no-index", "--no-color", "--", "/dev/null"])
            .arg(&target)
            .output()
            .map_err(|e| format!("git 不可用: {e}"))?
    } else {
        git_command(root)
            .args(["-c", "core.quotepath=false", "diff", "HEAD", "--no-color", "--"])
            .arg(path)
            .output()
            .map_err(|e| format!("git 不可用: {e}"))?
    };
    // git diff --no-index returns 1 for differences; that is expected.
    if out.status.code() == Some(1) || out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    Err(git_stderr(&out))
}

#[tauri::command]
pub fn git_working_changes(workspace_id: String) -> Result<Vec<GitFileChange>, String> {
    let root = workspace_root(&workspace_id)?;
    git_working_changes_in(&root)
}

#[tauri::command]
pub fn git_working_diff(workspace_id: String, path: String) -> Result<String, String> {
    let root = workspace_root(&workspace_id)?;
    safe_relative_path(&root, &path)?;
    git_working_diff_in(&root, &path)
}

#[tauri::command]
pub fn file_write(workspace_id: String, path: String, content: String) -> Result<(), String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    if !target.is_file() {
        return Err("target is not an existing file".to_string());
    }
    std::fs::write(&target, content.as_bytes()).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn highlight(workspace_id: String, path: String) -> Result<Vec<HighlightSpan>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _truncated) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    Ok(highlight_source(
        &content,
        language_for_path(&target),
    ))
}

#[tauri::command]
pub fn outline(workspace_id: String, path: String) -> Result<Vec<Symbol>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    let relative = target
        .strip_prefix(&root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.clone());
    Ok(extract_symbols(&target, &relative, &content))
}

#[tauri::command]
pub fn search(
    workspace_id: String,
    query: String,
    options: Option<SearchOptions>,
    app: tauri::AppHandle,
) -> Result<SearchResponse, String> {
    let search_options = options.unwrap_or_default();
    search_workspace(&workspace_id, &query, &search_options, |batch: Vec<SearchResult>| {
        let _ = app.emit("search_batch", batch);
    })
}

#[tauri::command]
pub fn resolve_definition(
    workspace_id: String,
    path: String,
    start: usize,
    end: Option<usize>,
) -> Result<Vec<NavigationTarget>, String> {
    let root = workspace_root(&workspace_id)?;
    let target = safe_relative_path(&root, &path)?;
    let (content, _) =
        read_text_file(&target).ok_or_else(|| "file is missing, binary, or too large".to_string())?;
    let offset = end.unwrap_or(start).min(content.len());
    let clicked_name = symbol_at(&content, offset)
        .ok_or_else(|| "no symbol under cursor".to_string())?;
    let symbols = workspace_symbols(&workspace_id)?;
    let mut targets: Vec<NavigationTarget> = symbols
        .iter()
        .filter(|symbol| {
            symbol.name == clicked_name
                && matches!(symbol.kind.as_str(), "function" | "method" | "class" | "interface" | "type" | "constant")
                && symbol.path != path
                || symbol.name == clicked_name
                    && symbol.path == path
                    && (symbol.start != start || symbol.end != offset)
        })
        .map(|symbol| NavigationTarget {
            path: symbol.path.clone(),
            name: symbol.name.clone(),
            kind: symbol.kind.clone(),
            start: symbol.start,
            end: symbol.end,
            start_line: symbol.start_line + 1,
            start_column: symbol.start_column + 1,
        })
        .take(100)
        .collect();

    if targets.is_empty() {
        if let Ok(Some(symbol)) = db::find_symbol(
            &root.to_string_lossy(),
            &clicked_name,
        ) {
            targets.push(NavigationTarget {
                path: symbol.path.clone(),
                name: symbol.name,
                kind: symbol.kind,
                start: symbol.start,
                end: symbol.end,
                start_line: symbol.start_line + 1,
                start_column: symbol.start_column + 1,
            });
        }
    }
    Ok(targets)
}



#[tauri::command]
pub fn goto_definition(
    workspace_id: String,
    name: String,
    _current_path: String,
) -> Result<Vec<NavigationTarget>, String> {
    let root = workspace_root(&workspace_id)?;
    let symbols = workspace_symbols(&workspace_id)?;
    let mut targets: Vec<NavigationTarget> = symbols
        .iter()
        .filter(|symbol| {
            symbol.name == name
                && matches!(symbol.kind.as_str(), "function" | "method" | "class" | "interface" | "type" | "constant")
        })
        .map(|symbol| NavigationTarget {
            path: symbol.path.clone(),
            name: symbol.name.clone(),
            kind: symbol.kind.clone(),
            start: symbol.start,
            end: symbol.end,
            start_line: symbol.start_line + 1,
            start_column: symbol.start_column + 1,
        })
        .take(100)
        .collect();

    if targets.is_empty() {
        if let Ok(Some(symbol)) = db::find_symbol(&root.to_string_lossy(), &name) {
            targets.push(NavigationTarget {
                path: symbol.path,
                name: symbol.name,
                kind: symbol.kind,
                start: symbol.start,
                end: symbol.end,
                start_line: symbol.start_line + 1,
                start_column: symbol.start_column + 1,
            });
        }
    }
    Ok(targets)
}

#[tauri::command]
pub fn find_references(
    workspace_id: String,
    name: String,
) -> Result<Vec<NavigationTarget>, String> {
    let _root = workspace_root(&workspace_id)?;
    let symbols = workspace_symbols(&workspace_id)?;
    let targets: Vec<NavigationTarget> = symbols
        .iter()
        .filter(|symbol| {
            symbol.name.contains(&name)
                && matches!(
                    symbol.kind.as_str(),
                    "function" | "method" | "class" | "interface" | "type" | "constant"
                )
        })
        .map(|symbol| NavigationTarget {
            path: symbol.path.clone(),
            name: symbol.name.clone(),
            kind: symbol.kind.clone(),
            start: symbol.start,
            end: symbol.end,
            start_line: symbol.start_line + 1,
            start_column: symbol.start_column + 1,
        })
        .take(200)
        .collect();
    Ok(targets)
}

#[tauri::command]
pub fn fuzzy_files(
    workspace_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let root = workspace_root(&workspace_id)?;
    let max = limit.unwrap_or(50).min(200);
    let walker = ignore::WalkBuilder::new(&root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .require_git(false)
        .build();

    let query_lower = query.to_lowercase();
    let mut results: Vec<(usize, String)> = Vec::new();

    for entry in walker.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));

        if query_lower.is_empty() {
            results.push((relative.len(), relative));
        } else {
            let path_lower = relative.to_lowercase();
            let mut score = 0usize;
            let mut query_idx = 0usize;
            for (path_idx, ch) in path_lower.char_indices() {
                if query_idx < query_lower.len() && ch == query_lower.chars().nth(query_idx).unwrap_or('\0') {
                    score += 100 - path_idx.min(99);
                    query_idx += query_lower.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
                }
            }
            if query_idx >= query_lower.len() {
                results.push((score, relative));
            }
        }
        if results.len() > max * 4 {
            results.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())));
            results.truncate(max);
        }
    }

    results.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.len().cmp(&b.1.len())));
    results.truncate(max);
    Ok(results.into_iter().map(|(_, path)| path).collect())
}

#[tauri::command]
pub fn fuzzy_symbols(
    workspace_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<NavigationTarget>, String> {
    let max = limit.unwrap_or(50).min(200);
    let symbols = workspace_symbols(&workspace_id)?;
    let query_lower = query.to_lowercase();

    let mut scored: Vec<(usize, usize, NavigationTarget)> = Vec::new();
    for (idx, symbol) in symbols.iter().enumerate() {
        if !matches!(
            symbol.kind.as_str(),
            "function" | "method" | "class" | "interface" | "type" | "constant"
        ) {
            continue;
        }
        let name_lower = symbol.name.to_lowercase();
        let score = if query_lower.is_empty() {
            1
        } else if name_lower == query_lower {
            300
        } else if name_lower.starts_with(&query_lower) {
            200
        } else if name_lower.contains(&query_lower) {
            100
        } else {
            // Subsequence fuzzy match
            let mut qi = 0usize;
            for ch in name_lower.chars() {
                if qi < query_lower.len()
                    && ch == query_lower.chars().nth(qi).unwrap_or('\0')
                {
                    qi += query_lower.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
                }
            }
            if qi >= query_lower.len() { 50 } else { continue }
        };
        scored.push((
            score,
            idx,
            NavigationTarget {
                path: symbol.path.clone(),
                name: symbol.name.clone(),
                kind: symbol.kind.clone(),
                start: symbol.start,
                end: symbol.end,
                start_line: symbol.start_line + 1,
                start_column: symbol.start_column + 1,
            },
        ));
        if scored.len() > max * 4 {
            scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            scored.truncate(max);
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.truncate(max);
    Ok(scored.into_iter().map(|(_, _, t)| t).collect())
}

#[cfg(test)]
mod git_tests {
    use super::{changed_path, git_changed_files_in, git_file_diff_in};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRepo(PathBuf);

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().expect("git available");
        assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    fn make_repo() -> TempRepo {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("light-reader-git-{}-{}", std::process::id(), unique));
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/a.txt"), "one\n").unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "test@example.com"]);
        git(&root, &["config", "user.name", "Light Reader Test"]);
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "base"]);
        fs::remove_file(root.join("src/a.txt")).unwrap();
        fs::write(root.join("src/中文.txt"), "unicode\n").unwrap();
        fs::write(root.join("src/nested/b.txt"), "nested\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-m", "last commit"]);
        TempRepo(root)
    }

    #[test]
    fn last_commit_paths_use_workspace_relative_unicode_names() {
        let repo = make_repo();
        let paths: Vec<_> = git_changed_files_in(&repo.0).unwrap().into_iter().map(|f| f.path).collect();
        assert!(paths.iter().any(|p| p == "src/中文.txt"), "unicode path missing: {:?}", paths);
        assert!(paths.iter().any(|p| p == "src/nested/b.txt"), "nested path missing: {:?}", paths);
        assert!(!paths.iter().any(|p| p == "src/a.txt"), "deleted path exposed as current: {:?}", paths);
    }

    #[test]
    fn diff_uses_workspace_relative_path_from_subfolder() {
        let repo = make_repo();
        let sub = repo.0.join("src");
        let paths: Vec<_> = git_changed_files_in(&sub).unwrap().into_iter().map(|f| f.path).collect();
        assert!(paths.iter().any(|p| p == "nested/b.txt"), "subfolder path missing: {:?}", paths);
        let diff = git_file_diff_in(&sub, "nested/b.txt").unwrap();
        assert!(diff.contains("+nested"), "content missing: {}", diff);
        assert!(!diff.contains("last commit"), "commit message leaked: {}", diff);
    }

    #[test]
    fn rename_record_uses_new_path() {
        assert_eq!(changed_path("R100", &["old.txt", "new.txt"]).as_deref(), Some("new.txt"));
        assert_eq!(changed_path("A", &["new.txt"]).as_deref(), Some("new.txt"));
        assert_eq!(changed_path("D", &["old.txt"]).as_deref(), Some("old.txt"));
    }

    #[test]
    fn non_git_workspace_is_rejected() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("light-reader-no-git-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        let err = git_changed_files_in(&dir).unwrap_err();
        assert!(err.contains("不是 Git 仓库"), "unexpected: {}", err);
        let _ = fs::remove_dir_all(dir);
    }
}
