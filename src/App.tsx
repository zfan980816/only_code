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
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [fileDocument, setFileDocument] = useState<FileDocument | null>(null);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [definitions, setDefinitions] = useState<NavigationTarget[]>([]);
  const [status, setStatus] = useState("Ready");
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
      setStatus(`Opening ${path}…`);
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
    [workspace],
  );

  const openFolder = useCallback(async () => {
    if (!isTauri()) {
      setStatus("The native backend is required to open a workspace.");
      return;
    }
    try {
      const selected = await open({ directory: true, multiple: false, title: "Open code folder" });
      if (!selected) return;
      setStatus("Opening workspace…");
      const opened = await backend.openWorkspace(selected);
      setWorkspace(opened);
      setActivePath(null);
      setFileDocument(null);
      setOutline([]);
      setSearchResults([]);
      setSearchQuery("");
      await loadTree(opened.id);
      setStatus(`${opened.name} indexed ${opened.indexedFiles} files`);
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    }
  }, [loadTree]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    const promises = [
      listen<IndexProgress>("index_progress", (event) => {
        if (event.payload.workspaceId !== workspace.id || disposed) return;
        setStatus(
          `${event.payload.phase === "complete" ? "Index complete" : "Indexing"} · ${event.payload.indexedFiles} files`,
        );
        if (event.payload.phase === "complete") {
          void loadTree(workspace.id);
        }
      }),
      listen<string[]>("files_changed", (event) => {
        if (event.payload.includes(workspace.id)) {
          setStatus("Workspace changed — refreshing index…");
          void loadTree(workspace.id);
        }
      }),
    ];
    return () => {
      disposed = true;
      promises.forEach((promise) => promise.then((unlisten) => unlisten()));
    };
  }, [loadTree, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchTruncated(false);
      return;
    }
    const runId = ++searchRun.current;
    setStatus("Searching…");
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
          `${response.results.length} file${response.results.length === 1 ? "" : "s"} · ${response.filesSearched} searched${response.truncated ? " · limit reached" : ""}`,
        );
      } catch (cause) {
        if (searchRun.current === runId) {
          setStatus(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [caseSensitive, regexMode, searchQuery, wholeWord, workspace]);

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
          setStatus("No definition found for this symbol.");
        }
      } catch (cause) {
        setStatus(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [selectFile, workspace],
  );

  const importCount = useMemo(
    () => outline.filter((symbol) => symbol.kind === "import").length,
    [outline],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="logo">LR</span>
          <div>
            <strong>Light Reader</strong>
            <small>Read-first code explorer</small>
          </div>
        </div>
        <div className="workspace-details">
          <span>{workspace ? workspace.name : "No workspace"}</span>
          {workspace ? <small title={workspace.root}>{workspace.root}</small> : null}
        </div>
        <button className="primary-button" onClick={openFolder}>
          Open Folder
        </button>
      </header>

      {!isTauri() ? (
        <div className="browser-note">
          Browser preview shows UI only. Run <code>npm run tauri dev</code> to use the local
          workspace backend.
        </div>
      ) : null}

      <main className="workspace-layout">
        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "files" ? "active" : ""}
              onClick={() => setSidebarTab("files")}
            >
              Files
            </button>
            <button
              className={sidebarTab === "search" ? "active" : ""}
              onClick={() => setSidebarTab("search")}
            >
              Search
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
                  <h4>Recent</h4>
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
                placeholder="Search code…"
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
                    {searchQuery.trim() ? "No matches yet." : "Search across the workspace."}
                  </div>
                ) : null}
                {searchTruncated ? <div className="tree-error">Result limit reached.</div> : null}
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
          />
        </section>

        <aside className="context-pane">
          <div className="context-block">
            <h4>Outline</h4>
            <div className="outline-list">
              {outline.length === 0 ? (
                <div className="empty-note">No supported symbols in this file.</div>
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
            <h4>Definitions</h4>
            {definitions.length === 0 ? (
              <div className="empty-note">Ctrl / ⌘ + click a symbol.</div>
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
              <span>Symbols</span>
            </div>
            <div>
              <strong>{importCount}</strong>
              <span>Imports</span>
            </div>
            <div>
              <strong>{workspace?.indexedFiles ?? 0}</strong>
              <span>Indexed</span>
            </div>
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <span>{status}</span>
        <span>Read-only · local-first · no telemetry</span>
      </footer>
    </div>
  );
}
