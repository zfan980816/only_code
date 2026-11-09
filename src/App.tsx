import { useState, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

async function tauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

interface Ws { id: string; root: string; name: string; indexedFiles: number; }
interface Node { name: string; path: string; isDir: boolean; }
interface Doc { path: string; name: string; language: string; content: string; size: number; truncated: boolean; }
interface Sym { name: string; kind: string; start: number; startLine: number; }

type Lang = "zh" | "en";
const L = {
  zh: { open: "打开文件夹", files: "文件", search: "搜索", noWs: "未打开工作区", status: "就绪", outline: "大纲", noFile: "未选择文件", noSyms: "无符号", focus: "专注", err: "错误" },
  en: { open: "Open Folder", files: "Files", search: "Search", noWs: "No workspace", status: "Ready", outline: "Outline", noFile: "No file", noSyms: "No symbols", focus: "Focus", err: "Error" }
};

export default function App() {
  const [lang, setLang] = useState<Lang>("zh");
  const t = L[lang];
  const [ws, setWs] = useState<Ws | null>(null);
  const [tree, setTree] = useState<Node[]>([]);
  const [expanded, setExpanded] = useState<Record<string, Node[]>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [syms, setSyms] = useState<Sym[]>([]);
  const [status, setStatus] = useState("就绪");
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<{path:string;name:string;matches:{line:number;text:string}[]}[]>([]);
  const [focus, setFocus] = useState(false);
  const [tab, setTab] = useState<"files"|"search">("files");
  const [err, setErr] = useState<string | null>(null);

  const openFolder = useCallback(async () => {
    setErr(null);
    try {
      setStatus("Opening...");
      const sel = await open({ directory: true, multiple: false });
      if (!sel) { setStatus("Cancelled"); return; }
      const ws = await tauri<Ws>("workspace_open", { root: sel });
      setWs(ws); setActivePath(null); setDoc(null); setSyms([]); setResults([]); setSearchQ("");
      const nodes = await tauri<Node[]>("file_tree", { workspaceId: ws.id });
      setTree(nodes); setExpanded({});
      setStatus(`${ws.name} · ${ws.indexedFiles} indexed`);
    } catch (e) { const m = String(e); setErr(m); setStatus(`ERR: ${m}`); }
  }, []);

  const loadDir = useCallback(async (path: string) => {
    if (!ws) return;
    try {
      if (expanded[path]) { const c = {...expanded}; delete c[path]; setExpanded(c); return; }
      const children = await tauri<Node[]>("file_tree", { workspaceId: ws.id, path });
      setExpanded(prev => ({ ...prev, [path]: children }));
    } catch (e) { setStatus(`ERR: ${e}`); }
  }, [ws, expanded]);

  const openFile = useCallback(async (path: string) => {
    if (!ws) return;
    try {
      setErr(null); setActivePath(path); setStatus(`Loading ${path}...`);
      const d = await tauri<Doc>("file_read", { workspaceId: ws.id, path });
      setDoc(d);
      try { const s = await tauri<Sym[]>("outline", { workspaceId: ws.id, path }); setSyms(s); } catch { setSyms([]); }
      setStatus(`${path} · ${d.language}`);
    } catch (e) { const m = String(e); setErr(m); setStatus(`ERR: ${m}`); }
  }, [ws]);

  const doSearch = useCallback(async (q: string) => {
    if (!ws || !q.trim()) { setResults([]); return; }
    try {
      const r = await tauri<{results:{path:string;name:string;matches:{line:number;text:string}[]}[]}>("search", {
        workspaceId: ws.id, query: q.trim(), options: { caseSensitive: false, regex: false, wholeWord: false, maxResults: 200 }
      });
      setResults(r.results);
    } catch (e) { setStatus(`ERR: ${e}`); }
  }, [ws]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.shiftKey && e.ctrlKey && e.key === "F") { e.preventDefault(); setFocus(v => !v); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const renderTree = (nodes: Node[], depth: number) => nodes.map(n => (
    <div key={n.path}>
      <button className="tree-row" style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => n.isDir ? loadDir(n.path) : openFile(n.path)}>
        <span className="tree-icon">{n.isDir ? (expanded[n.path] ? "▾" : "▸") : "•"}</span>
        {n.name}
      </button>
      {expanded[n.path]?.map(child => renderTree([child], depth + 1))}
    </div>
  ));

  return (
    <div className={`app ${focus ? "focus" : ""}`}>
      <header className="hdr">
        <span className="logo">LR</span>
        <span className="ws-name">{ws ? ws.name : t.noWs}</span>
        <button className="btn-focus" onClick={() => setFocus(!focus)}>{t.focus}</button>
        <button className="btn-lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "EN" : "中文"}</button>
        <button className="btn-open" onClick={openFolder}>{t.open}</button>
      </header>

      {err && <div className="err-bar">⚠ {err}</div>}

      <main className="layout">
        {!focus && (
          <aside className="left">
            <div className="tabs">
              <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>{t.files}</button>
              <button className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>{t.search}</button>
            </div>
            {tab === "files" && <div className="tree">{renderTree(tree, 0)}</div>}
            {tab === "search" && (
              <div className="search-wrap">
                <input className="search-input" value={searchQ} placeholder="Search..."
                  onChange={e => { setSearchQ(e.target.value); doSearch(e.target.value); }} />
                <div className="results">
                  {results.map(r => (
                    <div key={r.path} className="result-file">
                      <button className="result-name" onClick={() => openFile(r.path)}>{r.name}</button>
                      {r.matches.map((m, i) => (
                        <button key={i} className="result-line" onClick={() => openFile(r.path)}>
                          <span className="line-num">{m.line}</span> {m.text.trim()}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        <section className="center">
          {doc ? (
            <>
              <div className="doc-hdr"><span>{activePath}</span><span className="lang-tag">{doc.language}</span></div>
              <pre className="code">
                {doc.content.split("\n").map((line, i) => (
                  <div key={i} className="code-line">
                    <span className="line-num">{i + 1}</span>
                    <span>{line || " "}</span>
                  </div>
                ))}
              </pre>
            </>
          ) : <div className="no-file">{t.noFile}</div>}
        </section>

        {!focus && (
          <aside className="right">
            <div className="panel"><h4>{t.outline}</h4>
              {syms.length === 0 ? <span className="muted">{t.noSyms}</span> :
                syms.map((s, i) => <div key={i} className="sym"><span className="kind">{s.kind}</span> {s.name}</div>)}
            </div>
          </aside>
        )}
      </main>

      <footer className="stbar"><span>{status}</span><span className="muted">Ctrl+Shift+F Focus</span></footer>
    </div>
  );
}
