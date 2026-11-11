// Minimal Language Server Protocol (LSP) client over stdio JSON-RPC.
// Keeps one server process per (workspace, language), spawned on demand.
// No external dependencies: hand-rolled framing and message parsing.
use crate::models::NavigationTarget;
use crate::state::workspace_root;
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
// Cold-starting a language server (process spawn, AV scans, project discovery)
// can take far longer than a normal request; allow up to a minute.
const INIT_TIMEOUT: Duration = Duration::from_secs(60);

pub struct LspClient {
    child: Mutex<Child>,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    next_id: Arc<Mutex<i64>>,
    #[allow(dead_code)]
    pending: Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    opened: Mutex<HashMap<String, i64>>,
    pub command: String,
}

impl LspClient {
    pub fn spawn(command: &str, root: &Path) -> Result<Self, String> {
        let mut parts = command.split_whitespace();
        let program = parts.next().ok_or("LSP 命令为空")?;
        let args: Vec<&str> = parts.collect();

        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new(program);
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(windows))]
        let mut cmd = Command::new(program);
        cmd.args(&args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 LSP 服务器 {program}: {e}"))?;
        let stdin = child.stdin.take().ok_or("LSP stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("LSP stdout unavailable")?;
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 { break; }
                }
            });
        }

        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let client = Self {
            child: Mutex::new(child),
            stdin: Arc::new(Mutex::new(Box::new(stdin))),
            next_id: Arc::new(Mutex::new(1)),
            pending: pending.clone(),
            opened: Mutex::new(HashMap::new()),
            command: command.to_string(),
        };

        // Reader thread: frame parsing, response dispatch, server-request replies.
        let stdin_for_reader = client.stdin.clone();
        let pending_for_fail = pending.clone();
        std::thread::spawn(move || {
            // When the server process dies, wake every pending request so the
            // UI falls back instantly instead of waiting for the full timeout.
            let fail_all = || {
                let waiters: Vec<Sender<Value>> = pending_for_fail
                    .lock()
                    .map(|mut p| {
                        let drained: Vec<_> = p.values().cloned().collect();
                        p.clear();
                        drained
                    })
                    .unwrap_or_default();
                for tx in waiters {
                    let _ = tx.send(Value::String("__LSP_ERR__LSP 服务器已退出".into()));
                }
            };
            let mut reader = BufReader::new(stdout);
            loop {
                // Read the full header block (Content-Length + optional
                // Content-Type) until the blank separator line.
                let mut len: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 { fail_all(); return; }
                    let trimmed = line.trim();
                    if trimmed.is_empty() { break; }
                    if let Some(value) = trimmed.split_once(':') {
                        if value.0.eq_ignore_ascii_case("content-length") {
                            len = value.1.trim().parse().ok();
                        }
                    }
                }
                let Some(len) = len else { fail_all(); return; };
                let mut body = vec![0u8; len];
                if reader.read_exact(&mut body).is_err() { fail_all(); break; }
                let msg: Value = match serde_json::from_slice(&body) { Ok(v) => v, Err(_) => continue };

                if let (Some(id), Some(method)) = (
                    msg.get("id").and_then(Value::as_i64),
                    msg.get("method").and_then(Value::as_str),
                ) {
                    // Server -> client request: answer politely so servers never stall.
                    let result = match method {
                        "workspace/configuration" => {
                            let items = msg
                                .pointer("/params/items")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            Value::Array(vec![Value::Object(serde_json::Map::new()); items.len()])
                        }
                        _ => Value::Null,
                    };
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
                    let _ = write_frame(&stdin_for_reader, &reply);
                } else if msg.get("id").is_some() && msg.get("method").is_none() {
                    let id = msg.get("id").and_then(Value::as_i64).unwrap_or(-1);
                    let sender = pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(sender) = sender {
                        if let Some(err) = msg.get("error") {
                            let text = err
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("LSP error")
                                .to_string();
                            let _ = sender.send(Value::String(format!("__LSP_ERR__{text}")));
                        } else {
                            let _ = sender.send(msg.get("result").cloned().unwrap_or(Value::Null));
                        }
                    }
                }
            }
        });

        client.initialize(root)?;
        Ok(client)
    }

    fn initialize(&self, root: &Path) -> Result<(), String> {
        let params = json!({
            "processId": std::process::id(),
            "rootUri": path_to_uri(root),
            "rootPath": root.to_string_lossy(),
            "workspaceFolders": [{ "uri": path_to_uri(root), "name": root.file_name().map(|n| n.to_string_lossy()).unwrap_or_default() }],
            "capabilities": {},
            "initializationOptions": {}
        });
        let result = self.send_request_with_timeout("initialize", params, INIT_TIMEOUT)?;
        let _ = result; // ignored; servers with mismatched capabilities still answer
        self.notify("initialized", json!({}))
    }

    fn write_msg(&self, msg: &Value) -> Result<(), String> {
        write_frame(&self.stdin, msg)
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_msg(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.send_request_with_timeout(method, params, REQUEST_TIMEOUT)
    }

    fn send_request_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = {
            let mut n = self.next_id.lock().map_err(|_| "id lock")?;
            let id = *n;
            *n += 1;
            id
        };
        let (tx, rx) = channel();
        self.pending
            .lock()
            .map_err(|_| "pending lock")?
            .insert(id, tx);
        self.write_msg(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        let value = rx
            .recv_timeout(timeout)
            .map_err(|_| format!("LSP 请求超时: {method}"))?;
        match value.as_str() {
            Some(text) if text.starts_with("__LSP_ERR__") => {
                Err(text.trim_start_matches("__LSP_ERR__").to_string())
            }
            _ => Ok(value),
        }
    }

    pub fn ensure_open(&self, path: &Path, content: &str, language_id: &str) -> Result<(), String> {
        let uri = path_to_uri(path);
        let mut opened = self.opened.lock().map_err(|_| "opened lock")?;
        match opened.get_mut(&uri) {
            Some(version) => {
                *version += 1;
                self.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": *version },
                        "contentChanges": [{ "text": content }]
                    }),
                )
            }
            None => {
                opened.insert(uri.clone(), 1);
                self.notify(
                    "textDocument/didOpen",
                    json!({
                        "textDocument": {
                            "uri": uri, "languageId": language_id,
                            "version": 1, "text": content
                        }
                    }),
                )
            }
        }
    }

    pub fn position_request(
        &self,
        method: &str,
        path: &Path,
        content: &str,
        language_id: &str,
        line: usize,
        column: usize,
        include_declaration: bool,
    ) -> Result<Value, String> {
        self.ensure_open(path, content, language_id)?;
        let params = if method == "textDocument/references" {
            json!({
                "textDocument": { "uri": path_to_uri(path) },
                "position": { "line": line, "character": column },
                "context": { "includeDeclaration": include_declaration }
            })
        } else {
            json!({
                "textDocument": { "uri": path_to_uri(path) },
                "position": { "line": line, "character": column }
            })
        };
        self.send_request(method, params)
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn write_frame(stdin: &Arc<Mutex<Box<dyn Write + Send>>>, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let mut pipe = stdin.lock().map_err(|_| "stdin lock")?;
    write!(pipe, "Content-Length: {}\r\n\r\n{}", body.len(), body)
        .map_err(|e| format!("LSP 写入失败: {e}"))
}

// ── URI / path helpers (percent-encoding safe for CJK paths) ──

fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut uri = String::from("file:///");
    for ch in text.trim_start_matches('/').chars() {
        match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '.' | '_' | '~' | '/' | ':' | '@' | '!' | '$' | '&' | '\'' | '(' | ')' | '*' | '+' | ',' | ';' | '=' => uri.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                for byte in ch.encode_utf8(&mut buf).as_bytes() {
                    uri.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    uri
}

fn uri_to_path(uri: &str) -> String {
    let rest = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))
        .unwrap_or(uri);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| (*b as char).to_digit(16)),
                bytes.get(i + 2).and_then(|b| (*b as char).to_digit(16)),
            ) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).replace('/', std::path::MAIN_SEPARATOR_STR)
}

fn utf16_col_to_byte_offset(line: &str, col16: usize) -> usize {
    let mut seen: usize = 0;
    for (byte_idx, ch) in line.char_indices() {
        if seen >= col16 {
            return byte_idx;
        }
        seen += ch.len_utf16();
    }
    line.len()
}

// ── Location parsing (Location | Location[] | LocationLink[] | null) ──

fn parse_locations(value: &Value) -> Vec<(String, u32, u32)> {
    let empty = Vec::new();
    let items: Vec<&Value> = match value {
        Value::Null => return empty,
        Value::Array(a) => a.iter().collect(),
        obj @ Value::Object(_) => vec![obj],
        _ => return empty,
    };
    let mut out = Vec::new();
    for item in items {
        let uri = item
            .get("uri")
            .or_else(|| item.get("targetUri"))
            .and_then(Value::as_str);
        let range = item
            .get("range")
            .or_else(|| item.get("targetSelectionRange"))
            .or_else(|| item.get("targetRange"));
        if let (Some(uri), Some(range)) = (uri, range) {
            let line = range.pointer("/start/line").and_then(Value::as_u64).unwrap_or(0);
            let col = range.pointer("/start/character").and_then(Value::as_u64).unwrap_or(0);
            out.push((uri_to_path(uri), line as u32, col as u32));
        }
    }
    out
}

// ── Server pool ──

static SERVERS: Lazy<Mutex<HashMap<(String, String), Arc<LspClient>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn default_command(lang: &str) -> Option<String> {
    match lang {
        "rust" => Some("rust-analyzer".into()),
        "python" => Some("pyright-langserver --stdio".into()),
        "go" => Some("gopls".into()),
        "c" | "cpp" => Some("clangd".into()),
        "typescript" | "javascript" | "tsx" => Some("typescript-language-server --stdio".into()),
        "java" => Some("jdtls".into()),
        _ => None,
    }
}

fn get_or_spawn(
    workspace_id: &str,
    lang: &str,
    command: Option<&str>,
    root: &Path,
) -> Result<Arc<LspClient>, String> {
    let cmd = command
        .map(str::to_string)
        .filter(|c| !c.trim().is_empty())
        .or_else(|| default_command(lang))
        .ok_or_else(|| format!("语言 {lang} 没有配置 LSP 服务器"))?;
    let key = (workspace_id.to_string(), lang.to_string());
    let mut pool = SERVERS.lock().map_err(|_| "LSP pool lock")?;
    if let Some(existing) = pool.get(&key) {
        if existing.command == cmd {
            return Ok(existing.clone());
        }
        pool.remove(&key); // drop -> kill old process
    }
    let client = Arc::new(LspClient::spawn(&cmd, root)?);
    pool.insert(key, client.clone());
    Ok(client)
}

pub fn stop_workspace(workspace_id: &str) {
    if let Ok(mut pool) = SERVERS.lock() {
        let keys: Vec<_> = pool.keys().filter(|(ws, _)| ws == workspace_id).cloned().collect();
        for key in keys { pool.remove(&key); }
    }
}

pub fn stop_all() {
    if let Ok(mut pool) = SERVERS.lock() {
        pool.clear();
    }
}

// ── Tauri commands ──

fn lsp_navigate(
    workspace_id: &str,
    path: &str,
    line: usize,
    column: usize,
    command: Option<String>,
    method: &str,
) -> Result<Vec<NavigationTarget>, String> {
    let root = workspace_root(workspace_id)?;
    let abs = crate::fs_util::safe_relative_path(&root, path)?;
    let bytes = std::fs::read(&abs).map_err(|e| format!("无法读取文件: {e}"))?;
    let content = crate::fs_util::decode_lossy(&bytes);
    let lang = crate::language::SourceLanguage::from_path(&abs).name().to_string();
    let client = get_or_spawn(workspace_id, &lang, command.as_deref(), &root)?;

    let line_text = content.lines().nth(line).unwrap_or("");
    let byte_col = utf16_col_to_byte_offset(line_text, column);
    let raw = client.position_request(
        method,
        &abs,
        &content,
        &lang,
        line,
        column,
        true,
    )?;
    let locations = parse_locations(&raw);
    if locations.is_empty() {
        return Err("LSP 未返回结果".to_string());
    }
    let mut targets = Vec::new();
    for (target_path, tline, tcol) in locations.into_iter().take(200) {
        let rel = std::path::Path::new(&target_path)
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or(target_path.clone());
        let display = std::path::Path::new(&target_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| rel.clone());
        // Best-effort symbol name at the target: first identifier on the line.
        let target_line = std::fs::read_to_string(&target_path)
            .ok()
            .and_then(|text| text.lines().nth(tline as usize).map(|s| s.trim().to_string()))
            .unwrap_or_else(|| display.clone());
        targets.push(NavigationTarget {
            path: rel,
            name: target_line,
            kind: if method == "textDocument/references" { "reference" } else { "definition" }.into(),
            start: byte_col,
            end: byte_col,
            start_line: tline as usize + 1,
            start_column: tcol as usize + 1,
        });
    }
    Ok(targets)
}

#[tauri::command]
pub fn lsp_definition(
    workspace_id: String,
    path: String,
    line: usize,
    column: usize,
    command: Option<String>,
    _name: String,
) -> Result<Vec<NavigationTarget>, String> {
    lsp_navigate(&workspace_id, &path, line, column, command, "textDocument/definition")
}

#[tauri::command]
pub fn lsp_references(
    workspace_id: String,
    path: String,
    line: usize,
    column: usize,
    command: Option<String>,
    _name: String,
) -> Result<Vec<NavigationTarget>, String> {
    lsp_navigate(&workspace_id, &path, line, column, command, "textDocument/references")
}

#[tauri::command]
pub fn lsp_stop(workspace_id: Option<String>) -> Result<(), String> {
    match workspace_id {
        Some(id) => stop_workspace(&id),
        None => stop_all(),
    }
    Ok(())
}
