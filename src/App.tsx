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
const LOCALE_KEY = "light-reader.locale";

type Locale = "zh" | "en";

const t = (locale: Locale, key: string): string => {
  const dict: Record<Locale, Record<string, string>> = {
    zh: {
      ready: "就绪",
      openFolder: "打开文件夹",
      noWorkspace: "未打开工作区",
      files: "文件",
      search: "搜索",
      recent: "最近",
      outline: "大纲",
      definitions: "定义",
      noFileSelected: "未选择文件",
      noSymbols: "此文件没有可识别的符号",
      ctrlClickHint: "Ctrl/⌘ + 点击符号跳转到定义",
      searchPlaceholder: "搜索代码…",
      noMatchesYet: "暂无匹配结果",
      searchAcrossWorkspace: "跨工作区搜索",
      resultLimitReached: "已达结果上限",
      fileSearched: "个文件 · 已搜索",
      browserPreviewNote:
        "浏览器预览仅显示 UI。运行 npm run tauri dev 以使用本地工作区后端。",
      nativeBackendRequired: "需要桌面后端才能打开工作区。",
      openingWorkspace: "正在打开工作区…",
      opening: "正在打开",
      indexComplete: "索引完成",
      indexing: "索引中",
      workspaceChanged: "工作区变更 — 正在刷新索引…",
      refreshingIndex: "正在刷新索引…",
      noDefinitionFound: "未找到该符号的定义",
      noSymbolUnderCursor: "光标下没有符号",
      indexed: "已索引",
      symbols: "符号",
      imports: "导入",
      readOnly: "只读 · 本地优先 · 无遥测",
      searching: "搜索中…",
      filesLabel: "个文件",
    },
    en: {
      ready: "Ready",
      openFolder: "Open Folder",
      noWorkspace: "No workspace",
      files: "Files",
      search: "Search",
      recent: "Recent",
      outline: "Outline",
      definitions: "Definitions",
      noFileSelected: "No file selected",
      noSymbols: "No supported symbols in this file",
      ctrlClickHint: "Ctrl/⌘ + click a symbol to jump",
      searchPlaceholder: "Search code…",
      noMatchesYet: "No matches yet.",
      searchAcrossWorkspace: "Search across the workspace.",
      resultLimitReached: "Result limit reached.",
      fileSearched: " files · ",
      browserPreviewNote:
        "Browser preview shows UI only. Run npm run tauri dev to use the local workspace backend.",
      nativeBackendRequired: "The native backend is required to open a workspace.",
      openingWorkspace: "Opening workspace…",
      opening: "Opening",
      indexComplete: "Index complete",
      indexing: "Indexing",
      workspaceChanged: "Workspace changed — refreshing index…",
      refreshingIndex: "Refreshing index…",
      noDefinitionFound: "No definition found for this symbol.",
      noSymbolUnderCursor: "No symbol under cursor",
      indexed: "Indexed",
      symbols: "Symbols",
      imports: "Imports",
      readOnly: "Read-only · local-first · no telemetry",
      searching: "Searching…",
      filesLabel: " files · ",
    },
  };
  return dict[locale][key] ?? key;
};

function mergeSearchResults(previous: SearchResult[], incoming: SearchResult[]): SearchResult[] {
  const map = new Map(previous.map((result) => [result.path, result]));
  for (const result of incoming) {
    const existing = map.get(result.path);
    map.set(
      result.path,
      existing
        ? {
            ...existing,
            matches: [...existing.matches, ...result.matches].slice(0, 80),
          }
        : result,
    );
  }
  return [...map.values()];
}

export default function App() {
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      return (localStorage.getItem(LOCALE_KEY) as Locale) || "zh";
    } catch {
      return "zh";
    }
  });
  const setLocale = useCallback((value: Locale) => {
    setLocaleState(value);
    localStorage.setItem(LOCALE_KEY, value);
  }, []);
  const tr = useCallback((key: string) => t(locale, key), [locale]);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileDocument, setFileDocument] = useState<FileDocument | null>(null);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [definitions, setDefinitions] = useState<NavigationTarget[]>([]);
  const [status, setStatus] = useState(() => t(locale === "zh" ? "zh" : "en", "ready"));
  const [sidebarTab, setSidebarTab] = useState<"files" | "search">("files");
  const [searchQuery, setSearchQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexMode, setRegexMode] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; start: number } | null>(null);
  const [recents, setRecents] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const searchRun = useRef(0);

  const loadTree = useCallback(async (workspaceId: string) => {
    setTreeNodes(await backend.fileTree(workspaceId));
  }, []);

  const selectFile = useCallback(
    async (path: string) => {
      if (!workspace) return;
      setActivePath(path);
      setStatus(`${tr("opening")} ${path}…`);
      setDefinitions([]);
      try {
        const [document, symbols] = await Promise.all([
          backend.readFile(workspace.id, path),
          backend.outline(workspace.id, path).catch(() => []),
        ]);
        setFileDocument(document);
        setOutline(symbols);
        setScrollTarget({ path, start: 0 });
        setStatus(`${path} · ${document.language}`);
        setRecents((current) => {
          const next = [path, ...current.filter((item) => item !== path)].slice(0, 20);
          localStorage.setItem(RECENT_KEY, JSON.stringify(next));
          return next;
        });
      } catch (cause) {
        setFileDocument(null);
        setOutline([]);
        setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [tr, workspace],
  );

  const openFolder = useCallback(async () => {
    if (!isTauri()) {
      setStatus(tr("nativeBackendRequired"));
      return;
    }
    try {
      setStatus(tr("openingWorkspace"));
      const selected = await open({ directory: true, multiple: false, title: tr("openFolder") });
      if (!selected) return;
      const opened = await backend.openWorkspace(selected);
      setWorkspace(opened);
      setActivePath(null);
      setFileDocument(null);
      setOutline([]);
      setSearchResults([]);
      setSearchQuery("");
      await loadTree(opened.id);
      setStatus(`${opened.name} · ${opened.indexedFiles} ${tr("indexed")}`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadTree, tr]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const promises = [
      listen<IndexProgress>("index_progress", (event) => {
        if (event.payload.workspaceId !== workspace.id || disposed) return;
        setStatus(
          event.payload.phase === "complete"
            ? `${tr("indexComplete")} · ${event.payload.indexedFiles} ${tr("indexed")}`
            : `${tr("indexing")} · ${event.payload.indexedFiles}`,
        );
        if (event.payload.phase === "complete") {
          void loadTree(workspace.id);
        }
      }),
      listen<string[]>("files_changed", (event) => {
        if (event.payload.includes(workspace.id)) {
          setStatus(tr("workspaceChanged"));
          void loadTree(workspace.id);
        }
      }),
    ];
    return () => {
      disposed = true;
      promises.forEach((promise) => promise.then((unlisten) => unlisten()));
    };
  }, [loadTree, tr, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchTruncated(false);
      return;
    }
    const runId = ++searchRun.current;
    setStatus(tr("searching"));
    setSearchResults([]);
    const timer = window.setTimeout(async () => {
      try {
        const unlisten = await listen<SearchResult[]>("search_batch", (event) => {
          if (searchRun.current === runId) {
            setSearchResults((previous) => mergeSearchResults(previous, event.payload));
          }
        });
        const response = await backend.search(workspace.id, query, {
          caseSensitive,
          regex: regexMode,
          wholeWord,
          maxResults: 1000,
        });
        unlisten();
        if (searchRun.current !== runId) return;
        setSearchResults(response.results);
        setSearchTruncated(response.truncated);
        setSidebarTab("search");
        setStatus(
          `${response.results.length} ${tr("filesLabel")}${tr("fileSearched")}${response.filesSearched}${response.truncated ? " · " + tr("resultLimitReached") : ""}`,
        );
      } catch (cause) {
        if (searchRun.current === runId) {
          setStatus(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [caseSensitive, regexMode, searchQuery, tr, wholeWord, workspace]);

  const handleDefinitionClick = useCallback(
    async (path: string, position: number) => {
      if (!workspace) return;
      try {
        const targets = await backend.resolveDefinition(workspace.id, path, position, position);
        setDefinitions(targets);
        if (targets.length > 0) {
          await selectFile(targets[0].path);
          setScrollTarget({ path: targets[0].path, start: targets[0].start });
        } else {
          setStatus(tr("noDefinitionFound"));
        }
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [selectFile, tr, workspace],
  );

  const importCount = useMemo(
    () => outline.filter((symbol) => symbol.kind === "import").length,
    [outline],
  );

  return (
    <div className={`app-shell ${locale === "en" ? "locale-en" : "locale-zh"}`}>
      <header className="app-header">
        <div className="brand">
          <span className="logo">LR</span>
          <div>
            <strong>Light Reader</strong>
            <small>{tr("readOnly")}</small>
          </div>
        </div>
        <div className="workspace-details">
          <span>{workspace ? workspace.name : tr("noWorkspace")}</span>
          {workspace ? <small title={workspace.root}>{workspace.root}</small> : null}
        </div>
        <div className="header-actions">
          <div className="locale-switch">
            <button
              className={locale === "zh" ? "active" : ""}
              onClick={() => setLocale("zh")}
              title="切换到中文"
            >
              中文
            </button>
            <button
              className={locale === "en" ? "active" : ""}
              onClick={() => setLocale("en")}
              title="Switch to English"
            >
              EN
            </button>
          </div>
          <button className="primary-button" onClick={openFolder}>
            {tr("openFolder")}
          </button>
        </div>
      </header>

      {!isTauri() ? <div className="browser-note">{tr("browserPreviewNote")}</div> : null}

      <main className="workspace-layout">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "files" ? "active" : ""}
              onClick={() => setSidebarTab("files")}
            >
              {tr("files")}
            </button>
            <button
              className={sidebarTab === "search" ? "active" : ""}
              onClick={() => setSidebarTab("search")}
            >
              {tr("search")}
            </button>
          </div>

          {sidebarTab === "files" ? (
            <>
              <FileTree
                workspaceId={workspace?.id ?? null}
                nodes={treeNodes}
                activePath={activePath}
                onSelect={(node) => void selectFile(node.path)}
              />
              {recents.length > 0 ? (
                <div className="recent-panel">
                  <h4>{tr("recent")}</h4>
                  {recents.slice(0, 8).map((path) => (
                    <button key={path} onClick={() => void selectFile(path)} title={path}>
                      {path}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="search-panel">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={tr("searchPlaceholder")}
                spellCheck={false}
              />
              <div className="search-options">
                <label>
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(event) => setCaseSensitive(event.target.checked)}
                  />
                  Aa
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={regexMode}
                    onChange={(event) => setRegexMode(event.target.checked)}
                  />
                  .*
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={wholeWord}
                    onChange={(event) => setWholeWord(event.target.checked)}
                  />
                  Word
                </label>
              </div>
              <div className="search-results">
                {searchResults.length === 0 ? (
                  <div className="empty-note">
                    {searchQuery.trim() ? tr("noMatchesYet") : tr("searchAcrossWorkspace")}
                  </div>
                ) : null}
                {searchTruncated ? (
                  <div className="tree-error">{tr("resultLimitReached")}</div>
                ) : null}
                {searchResults.map((result) => (
                  <div key={result.path} className="result-group">
                    <button className="result-file" onClick={() => void selectFile(result.path)}>
                      {result.name}
                      <small>{result.path}</small>
                    </button>
                    {result.matches.map((match, index) => (
                      <button
                        key={`${match.line}-${index}`}
                        className="result-line"
                        onClick={() => void selectFile(result.path)}
                      >
                        <span>{match.line}</span>
                        {match.text.trim()}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        <section className="main-pane">
          <CodeViewer
            file={fileDocument}
            activePath={activePath}
            onDefinitionClick={(path, position) => void handleDefinitionClick(path, position)}
            scrollTarget={scrollTarget}
            hint={tr("ctrlClickHint")}
            emptyLabel={tr("noFileSelected")}
          />
        </section>

        <aside className="context-pane">
          <div className="context-block">
            <h4>{tr("outline")}</h4>
            <div className="outline-list">
              {outline.length === 0 ? (
                <div className="empty-note">{tr("noSymbols")}</div>
              ) : null}
              {outline.map((symbol, index) => (
                <button
                  key={`${symbol.path}-${symbol.start}-${index}`}
                  className={`outline-item kind-${symbol.kind}`}
                  onClick={() => {
                    setScrollTarget({ path: symbol.path, start: symbol.start });
                    setStatus(`${symbol.kind}: ${symbol.name}`);
                  }}
                  title={`${symbol.path}:${symbol.startLine + 1}`}
                >
                  <span>{symbol.kind}</span>
                  {symbol.name}
                </button>
              ))}
            </div>
          </div>

          <div className="context-block">
            <h4>{tr("definitions")}</h4>
            {definitions.length === 0 ? (
              <div className="empty-note">{tr("ctrlClickHint")}</div>
            ) : null}
            {definitions.map((target, index) => (
              <button
                key={`${target.path}-${target.start}-${index}`}
                onClick={async () => {
                  await selectFile(target.path);
                  setScrollTarget({ path: target.path, start: target.start });
                }}
              >
                <strong>{target.name}</strong>
                <small>
                  {target.path}:{target.startLine}
                </small>
              </button>
            ))}
          </div>

          <div className="context-stats">
            <div>
              <strong>{outline.length}</strong>
              <span>{tr("symbols")}</span>
            </div>
            <div>
              <strong>{importCount}</strong>
              <span>{tr("imports")}</span>
            </div>
            <div>
              <strong>{workspace?.indexedFiles ?? 0}</strong>
              <span>{tr("indexed")}</span>
            </div>
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        <span>{tr("readOnly")}</span>
      </footer>
    </div>
  );
}
