import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { CodeViewer } from "./components/CodeViewer";
import { FileTree } from "./components/FileTree";
import { backend, isTauri } from "./lib/bridge";
import type {
  FileDocument,
  IndexProgress,
  NavigationTarget,
  SearchResult,
  Symbol,
  TreeNode,
  Workspace,
} from "./types";

const RECENT_KEY = "light-reader.recents";
const BOOKMARK_KEY = "light-reader.bookmarks";
const LOCALE_KEY = "light-reader.locale";

type Locale = "zh" | "en";

const dict: Record<Locale, Record<string, string>> = {
  zh: {
    ready: "就绪", openFolder: "打开文件夹", noWorkspace: "未打开工作区",
    files: "文件", search: "搜索", bookmarks: "书签", recent: "最近",
    outline: "大纲", definitions: "定义", references: "引用",
    noFileSelected: "未选择文件", noSymbols: "此文件没有可识别的符号",
    ctrlClickHint: "Ctrl/⌘ + 点击符号跳转到定义",
    searchPlaceholder: "搜索代码…", noMatchesYet: "暂无匹配结果",
    searchAcrossWorkspace: "跨工作区搜索", resultLimitReached: "已达结果上限",
    browserPreviewNote: "浏览器预览仅显示 UI。运行 npm run tauri dev 以使用本地后端。",
    nativeBackendRequired: "需要桌面后端才能打开工作区。",
    openingWorkspace: "正在打开工作区…", opening: "正在打开",
    indexComplete: "索引完成", indexing: "索引中",
    workspaceChanged: "工作区变更 — 正在刷新索引…",
    noDefinitionFound: "未找到该符号的定义",
    indexed: "已索引", symbols: "符号", imports: "导入",
    readOnly: "只读 · 本地优先 · 无遥测",
    searching: "搜索中…", filesLabel: "个文件 · 已搜索",
    findRefs: "查找引用", noRefs: "无引用结果",
    quickOpen: "快速打开…", noBookmark: "还没有书签",
    addBookmark: "加入书签", removeBookmark: "移除书签",
    refsFor: "引用结果", quickOpenHint: "输入文件名模糊搜索，Enter 打开",
    focusMode: "专注模式",
  },
  en: {
    ready: "Ready", openFolder: "Open Folder", noWorkspace: "No workspace",
    files: "Files", search: "Search", bookmarks: "Bookmarks", recent: "Recent",
    outline: "Outline", definitions: "Definitions", references: "References",
    noFileSelected: "No file selected", noSymbols: "No supported symbols in this file",
    ctrlClickHint: "Ctrl/⌘ + click a symbol to jump",
    searchPlaceholder: "Search code…", noMatchesYet: "No matches yet.",
    searchAcrossWorkspace: "Search across the workspace.", resultLimitReached: "Result limit reached.",
    browserPreviewNote: "Browser preview shows UI only. Run npm run tauri dev for full experience.",
    nativeBackendRequired: "The native backend is required.",
    openingWorkspace: "Opening workspace…", opening: "Opening",
    indexComplete: "Index complete", indexing: "Indexing",
    workspaceChanged: "Workspace changed — refreshing…",
    noDefinitionFound: "No definition found.",
    indexed: "Indexed", symbols: "Symbols", imports: "Imports",
    readOnly: "Read-only · local-first · no telemetry",
    searching: "Searching…", filesLabel: " files · ",
    findRefs: "Find References", noRefs: "No references found",
    quickOpen: "Quick Open…", noBookmark: "No bookmarks yet",
    addBookmark: "Add Bookmark", removeBookmark: "Remove Bookmark",
    refsFor: "References for", quickOpenHint: "Type to fuzzy-search files, Enter to open",
    focusMode: "Focus Mode",
  },
};

function mergeSearchResults(prev: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const map = new Map(prev.map((r) => [r.path, r]));
  for (const r of incoming) {
    const e = map.get(r.path);
    map.set(r.path, e ? { ...e, matches: [...e.matches, ...r.matches].slice(0, 80) } : r);
  }
  return [...map.values()];
}



export default function App() {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try { return (localStorage.getItem(LOCALE_KEY) as Locale) || "zh"; } catch { return "zh"; }
  });
  const setLocale = useCallback((v: Locale) => { setLocaleState(v); localStorage.setItem(LOCALE_KEY, v); }, []);
  const tr = useCallback((key: string) => dict[locale][key] ?? key, [locale]);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileDocument, setFileDocument] = useState<FileDocument | null>(null);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [definitions, setDefinitions] = useState<NavigationTarget[]>([]);
  const [references, setReferences] = useState<NavigationTarget[]>([]);
  const [refTarget, setRefTarget] = useState<string>("");
  const [status, setStatus] = useState(() => dict["zh"].ready);
  const [sidebarTab, setSidebarTab] = useState<"files" | "search" | "bookmarks">("files");
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexMode, setRegexMode] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; start: number } | null>(null);
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
  });
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY) ?? "[]"); } catch { return []; }
  });
  const [focusMode, setFocusMode] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickResults, setQuickResults] = useState<string[]>([]);
  const [quickSelected, setQuickSelected] = useState(0);
  const searchRun = useRef(0);
  const quickInputRef = useRef<HTMLInputElement>(null);

  // --- bookmarks ---
  const toggleBookmark = useCallback((path: string) => {
    setBookmarks((prev) => {
      const next = prev.includes(path) ? prev.filter(p => p !== path) : [path, ...prev];
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // --- quick open ---
  useEffect(() => {
    if (!quickOpenOpen) return;
    const timer = setTimeout(async () => {
      if (!workspace) return;
      try {
        const results = await backend.fuzzyFiles(workspace.id, quickQuery.trim(), 30);
        setQuickResults(results);
        setQuickSelected(0);
      } catch { setQuickResults([]); }
    }, 120);
    return () => clearTimeout(timer);
  }, [quickQuery, quickOpenOpen, workspace]);

  useEffect(() => {
    if (quickOpenOpen && quickInputRef.current) quickInputRef.current.focus();
  }, [quickOpenOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        setQuickOpenOpen(true);
        setQuickQuery("");
        setQuickResults([]);
        setQuickSelected(0);
      }
      if (e.key === "Escape" && quickOpenOpen) setQuickOpenOpen(false);
      if (e.key === "F" && e.shiftKey && (e.ctrlKey || e.metaKey)) { setFocusMode(v => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [quickOpenOpen]);

  const loadTree = useCallback(async (id: string) => {
    setTreeNodes(await backend.fileTree(id));
  }, []);

  const selectFile = useCallback(async (path: string) => {
    if (!workspace) return;
    setActivePath(path);
    setStatus(`${tr("opening")} ${path}…`);
    setDefinitions([]); setReferences([]); setRefTarget("");
    try {
      const [doc, symbols] = await Promise.all([
        backend.readFile(workspace.id, path),
        backend.outline(workspace.id, path).catch(() => []),
      ]);
      setFileDocument(doc); setOutline(symbols);
      setScrollTarget({ path, start: 0 });
      setStatus(`${path} · ${doc.language}`);
      setRecents((c) => {
        const n = [path, ...c.filter(i => i !== path)].slice(0, 20);
        localStorage.setItem(RECENT_KEY, JSON.stringify(n));
        return n;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[LightReader] selectFile error:", msg);
      setFileDocument(null); setOutline([]); setStatus(`Error: ${msg}`);
    }
  }, [tr, workspace]);

  const openFolder = useCallback(async () => {
    console.log("[LightReader] openFolder clicked, isTauri:", isTauri());
    if (!isTauri()) { setStatus(tr("nativeBackendRequired")); return; }
    try {
      setStatus(tr("openingWorkspace"));
      console.log("[LightReader] calling dialog.open...");
      const sel = await open({ directory: true, multiple: false, title: tr("openFolder") });
      console.log("[LightReader] dialog.open result:", sel);
      if (!sel) return;
      const ws = await backend.openWorkspace(sel);
      console.log("[LightReader] workspace opened:", ws);
      setWorkspace(ws); setActivePath(null); setFileDocument(null); setOutline([]);
      setSearchResults([]); setSearchQuery(""); setBookmarks([]);
      await loadTree(ws.id);
      setStatus(`${ws.name} · ${ws.indexedFiles} ${tr("indexed")}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[LightReader] openFolder error:", msg);
      setStatus(`Error: ${msg}`);
    }
  }, [loadTree, tr]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const ps = [
      listen<IndexProgress>("index_progress", (e) => {
        if (e.payload.workspaceId !== workspace.id || disposed) return;
        setStatus(e.payload.phase === "complete" ? `${tr("indexComplete")} · ${e.payload.indexedFiles}` : `${tr("indexing")} · ${e.payload.indexedFiles}`);
        if (e.payload.phase === "complete") void loadTree(workspace.id);
      }),
      listen<string[]>("files_changed", (e) => {
        if (e.payload.includes(workspace.id)) { setStatus(tr("workspaceChanged")); void loadTree(workspace.id); }
      }),
    ];
    return () => { disposed = true; ps.forEach(p => p.then(u => u())); };
  }, [loadTree, tr, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const q = searchQuery.trim();
    if (!q) { setSearchResults([]); setSearchTruncated(false); return; }
    const runId = ++searchRun.current;
    setStatus(tr("searching")); setSearchResults([]);
    const timer = window.setTimeout(async () => {
      try {
        const un = await listen<SearchResult[]>("search_batch", (e) => {
          if (searchRun.current === runId) setSearchResults((prev) => mergeSearchResults(prev, e.payload));
        });
        const res = await backend.search(workspace.id, q, { caseSensitive, regex: regexMode, wholeWord, maxResults: 1000 });
        un(); if (searchRun.current !== runId) return;
        setSearchResults(res.results); setSearchTruncated(res.truncated); setSidebarTab("search");
        setStatus(`${res.results.length} ${tr("filesLabel")}${res.filesSearched}${res.truncated ? " · " + tr("resultLimitReached") : ""}`);
      } catch (e) { if (searchRun.current === runId) setStatus(e instanceof Error ? e.message : String(e)); }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [caseSensitive, regexMode, searchQuery, tr, wholeWord, workspace]);

  const handleDefinitionClick = useCallback(async (path: string, pos: number) => {
    if (!workspace) return;
    try {
      const targets = await backend.resolveDefinition(workspace.id, path, pos, pos);
      setDefinitions(targets);
      if (targets.length > 0) { await selectFile(targets[0].path); setScrollTarget({ path: targets[0].path, start: targets[0].start }); }
      else setStatus(tr("noDefinitionFound"));
    } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  }, [selectFile, tr, workspace]);

  const handleFindReferences = useCallback(async (name: string) => {
    if (!workspace || !name.trim()) return;
    setRefTarget(name); setStatus(`${tr("findRefs")}: ${name}…`);
    try {
      const targets = await backend.findReferences(workspace.id, name.trim());
      setReferences(targets); setSidebarTab("files");
      setStatus(`${tr("refsFor")} ${name}: ${targets.length} results`);
    } catch (e) { setStatus(e instanceof Error ? e.message : String(e)); }
  }, [tr, workspace]);

  const isBookmarked = activePath ? bookmarks.includes(activePath) : false;
  const importCount = useMemo(() => outline.filter(s => s.kind === "import").length, [outline]);

  return (
    <div className={`app-shell ${locale} ${focusMode ? "focus-mode" : ""}`}>
      <header className="app-header">
        <div className="brand"><span className="logo">LR</span><div><strong>Light Reader</strong><small>{tr("readOnly")}</small></div></div>
        <div className="workspace-details"><span>{workspace ? workspace.name : tr("noWorkspace")}</span>{workspace ? <small title={workspace.root}>{workspace.root}</small> : null}</div>
        <div className="header-actions">
          <div className="locale-switch">
            <button className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>中文</button>
            <button className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>EN</button>
          </div>
          <button className={`focus-toggle ${focusMode ? "active" : ""}`} onClick={() => setFocusMode(v => !v)} title="Ctrl+Shift+F">{tr("focusMode")}</button>
          <button className="primary-button" onClick={openFolder}>{tr("openFolder")}</button>
        </div>
      </header>

      {!isTauri() ? <div className="browser-note">{tr("browserPreviewNote")}</div> : null}

      {quickOpenOpen && (
        <div className="quick-open-overlay" onClick={() => setQuickOpenOpen(false)}>
          <div className="quick-open-modal" onClick={(e) => e.stopPropagation()}>
            <input ref={quickInputRef} className="quick-open-input" value={quickQuery}
              onChange={(e) => setQuickQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setQuickSelected(i => Math.min(i + 1, quickResults.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setQuickSelected(i => Math.max(i - 1, 0)); }
                if (e.key === "Enter" && quickResults[quickSelected]) { setQuickOpenOpen(false); void selectFile(quickResults[quickSelected]); }
              }}
              placeholder={tr("quickOpen")} spellCheck={false} />
            <div className="quick-open-hint">{tr("quickOpenHint")}</div>
            <div className="quick-open-list">
              {quickResults.map((path, i) => (
                <button key={path} className={`quick-open-item ${i === quickSelected ? "active" : ""}`}
                  onClick={() => { setQuickOpenOpen(false); void selectFile(path); }}
                  onMouseEnter={() => setQuickSelected(i)}>
                  {path}
                </button>
              ))}
              {quickQuery.trim() && quickResults.length === 0 ? <div className="empty-note">…</div> : null}
            </div>
          </div>
        </div>
      )}

      <main className="workspace-layout">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button className={sidebarTab === "files" ? "active" : ""} onClick={() => setSidebarTab("files")}>{tr("files")}</button>
            <button className={sidebarTab === "search" ? "active" : ""} onClick={() => setSidebarTab("search")}>{tr("search")}</button>
            <button className={sidebarTab === "bookmarks" ? "active" : ""} onClick={() => setSidebarTab("bookmarks")}>{tr("bookmarks")}</button>
          </div>
          {sidebarTab === "files" && (<>
            <div className="tree-toolbar">
              <button className="toolbar-btn" onClick={() => setQuickOpenOpen(true)}>⌘P {tr("quickOpen")}</button>
            </div>
            <FileTree workspaceId={workspace?.id ?? null} nodes={treeNodes} activePath={activePath} onSelect={(n) => void selectFile(n.path)} />
            {recents.length > 0 ? (
              <div className="recent-panel"><h4>{tr("recent")}</h4>
                {recents.slice(0, 8).map((p) => <button key={p} onClick={() => void selectFile(p)} title={p}>{p}</button>)}
              </div>
            ) : null}
          </>)}
          {sidebarTab === "search" && (
            <div className="search-panel">
              <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder={tr("searchPlaceholder")} spellCheck={false} />
              <div className="search-options">
                <label><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />Aa</label>
                <label><input type="checkbox" checked={regexMode} onChange={(e) => setRegexMode(e.target.checked)} />.*</label>
                <label><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />Word</label>
              </div>
              <div className="search-results">
                {searchResults.length === 0 ? <div className="empty-note">{searchQuery.trim() ? tr("noMatchesYet") : tr("searchAcrossWorkspace")}</div> : null}
                {searchTruncated ? <div className="tree-error">{tr("resultLimitReached")}</div> : null}
                {searchResults.map((r) => (
                  <div key={r.path} className="result-group">
                    <button className="result-file" onClick={() => void selectFile(r.path)}>{r.name}<small>{r.path}</small></button>
                    {r.matches.map((m, i) => (
                      <button key={`${m.line}-${i}`} className="result-line" onClick={() => void selectFile(r.path)}><span>{m.line}</span>{m.text.trim()}</button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {sidebarTab === "bookmarks" && (
            <div className="bookmark-panel">
              {bookmarks.length === 0 ? <div className="empty-note">{tr("noBookmark")}</div> : null}
              {bookmarks.map((p) => (
                <div key={p} className="bookmark-item">
                  <button className="bookmark-open" onClick={() => void selectFile(p)} title={p}>{p}</button>
                  <button className="bookmark-remove" onClick={() => toggleBookmark(p)} title={tr("removeBookmark")}>✕</button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <section className="main-pane">
          <CodeViewer file={fileDocument} activePath={activePath}
            onDefinitionClick={(p, pos) => void handleDefinitionClick(p, pos)}
            scrollTarget={scrollTarget} hint={tr("ctrlClickHint")} emptyLabel={tr("noFileSelected")}
                        isBookmarked={isBookmarked} onToggleBookmark={() => { if (activePath) toggleBookmark(activePath); }} />
        </section>

        <aside className="context-pane">
          <div className="context-block">
            <h4>{tr("outline")}</h4>
            <div className="outline-list">
              {outline.length === 0 ? <div className="empty-note">{tr("noSymbols")}</div> : null}
              {outline.map((s, i) => (
                <button key={`${s.path}-${s.start}-${i}`} className={`outline-item kind-${s.kind}`}
                  onClick={() => { setScrollTarget({ path: s.path, start: s.start }); setStatus(`${s.kind}: ${s.name}`); }}
                  onContextMenu={(e) => { e.preventDefault(); void handleFindReferences(s.name); }}
                  title={`${s.path}:${s.startLine + 1} — ${tr("findRefs")}: right-click`}
                >
                  <span>{s.kind}</span>{s.name}
                </button>
              ))}
            </div>
            {outline.length > 0 ? (
              <button className="find-refs-btn" onClick={() => { const s = outline[0]; if (s) void handleFindReferences(s.name); }}>
                {tr("findRefs")} →
              </button>
            ) : null}
          </div>

          {references.length > 0 ? (
            <div className="context-block">
              <h4>{tr("references")} · {refTarget}</h4>
              <div className="refs-list">
                {references.length === 0 ? <div className="empty-note">{tr("noRefs")}</div> : null}
                {references.map((r, i) => (
                  <button key={`${r.path}-${r.start}-${i}`} onClick={async () => { await selectFile(r.path); setScrollTarget({ path: r.path, start: r.start }); }}>
                    <span className="ref-kind">{r.kind}</span>
                    <span className="ref-name">{r.name}</span>
                    <small>{r.path}:{r.startLine}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="context-block">
            <h4>{tr("definitions")}</h4>
            {definitions.length === 0 ? <div className="empty-note">{tr("ctrlClickHint")}</div> : null}
            {definitions.map((t, i) => (
              <button key={`${t.path}-${t.start}-${i}`} onClick={async () => { await selectFile(t.path); setScrollTarget({ path: t.path, start: t.start }); }}>
                <strong>{t.name}</strong><small>{t.path}:{t.startLine}</small>
              </button>
            ))}
          </div>

          <div className="context-stats">
            <div><strong>{outline.length}</strong><span>{tr("symbols")}</span></div>
            <div><strong>{importCount}</strong><span>{tr("imports")}</span></div>
            <div><strong>{workspace?.indexedFiles ?? 0}</strong><span>{tr("indexed")}</span></div>
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        <span>Ctrl+P {tr("quickOpen")} · {tr("readOnly")}</span>
      </footer>
    </div>
  );
}





