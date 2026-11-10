import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

interface Ws { id: string; root: string; name: string; indexedFiles: number; }
interface N { name: string; path: string; isDir: boolean; }
interface Doc { path: string; name: string; language: string; content: string; size: number; truncated: boolean; }
interface Sym { name: string; kind: string; path: string; start: number; end: number; startLine: number; startColumn: number; endLine: number; endColumn: number; }
interface NavTarget { path: string; name: string; kind: string; start: number; startLine: number; }
interface SRes { results: { path: string; name: string; matches: { line: number; text: string }[] }[]; truncated: boolean; filesSearched: number; }
interface Tab { path: string; name: string; lang: string; }

type Lang = "zh" | "en";
const L: Record<Lang, Record<string,string>> = {
  zh: { workspaces:"工作区",open:"打开文件夹",files:"文件",search:"搜索",bookmarks:"书签",noWs:"未打开",outline:"大纲",refs:"引用",defs:"定义",noFile:"未选择文件",noSyms:"无符号",focus:"专注",findRefs:"查找引用",quick:"快速打开文件…",noBm:"无书签",refsFor:"引用",status:"就绪",fileSearch:"文件内搜索…",close:"关闭",goDef:"跳转",popupRefs:"引用处",popupDefs:"定义",noRefsFound:"无引用" },
  en: { workspaces:"Workspaces",open:"Open Folder",files:"Files",search:"Search",bookmarks:"Bookmarks",noWs:"No workspace",outline:"Outline",refs:"Refs",defs:"Defs",noFile:"No file",noSyms:"No symbols",focus:"Focus",findRefs:"Find Refs",quick:"Quick open file…",noBm:"No bookmarks",refsFor:"Refs",status:"Ready",fileSearch:"Search in file…",close:"Close",goDef:"Go",popupRefs:"Usages",popupDefs:"Definitions",noRefsFound:"No usages" }
};

const KW: Record<string, string[]> = {
  typescript: ["const","let","var","function","return","if","else","for","while","class","interface","type","enum","import","export","from","extends","implements","public","private","protected","static","async","await","new","this","super","try","catch","finally","throw","typeof","instanceof","in","of","default","switch","case","break","continue","do","yield","readonly","abstract","declare","namespace","as","is","keyof"],
  javascript: ["const","let","var","function","return","if","else","for","while","class","import","export","from","extends","async","await","new","this","super","try","catch","finally","throw","typeof","instanceof","in","of","default","switch","case","break","continue","do","yield"],
  python: ["def","class","return","if","elif","else","for","while","import","from","as","with","try","except","finally","raise","lambda","yield","pass","break","continue","global","in","is","not","and","or","async","await","self","None","True","False"],
  java: ["public","private","protected","static","final","abstract","class","interface","enum","extends","implements","import","package","return","if","else","for","while","do","switch","case","break","continue","try","catch","finally","throw","throws","new","this","super","void","int","long","double","float","boolean","null","true","false","synchronized","instanceof"],
};

let _inMultiLine = false;
const OVERSCAN = 20; // extra lines rendered above/below viewport

function hl(line: string, lang: string): { text: string; cls: string }[] {
  const r: { text: string; cls: string }[] = [];
  const kws = KW[lang] || [];
  const trimmed = line.trimStart();
  
  // Multi-line string tracking (docstrings)
  const tripleCount = (line.match(/\"\"\"/g) || []).length;
  if (_inMultiLine) {
    if (tripleCount > 0) { _inMultiLine = false; }
    r.push({ text: line, cls: "hl-str" });
    return r;
  }
  if (tripleCount % 2 === 1) {
    _inMultiLine = true;
    r.push({ text: line, cls: "hl-str" });
    return r;
  }
  
  // Whole-line comment (starts with # or //)
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
    r.push({ text: line, cls: "hl-cmt" });
    return r;
  }
  
  // For lines with inline comments, split at first # that's outside strings
  let commentStart = -1;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) { if (ch === inStr && line[i-1] !== "\\") inStr = null; }
    else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === "#") { commentStart = i; break; }
    else if (ch === "/" && line[i+1] === "/") { commentStart = i; break; }
  }
  
  const codePart = commentStart >= 0 ? line.substring(0, commentStart) : line;
  const commentPart = commentStart >= 0 ? line.substring(commentStart) : null;
  
  // Highlight code part
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(codePart)) !== null) {
    const c = m;
    if (c[1]) r.push({ text: c[1], cls: "hl-str" });
    else if (c[2]) r.push({ text: c[2], cls: "hl-num" });
    else if (c[3]) {
      if (kws.includes(c[3])) r.push({ text: c[3], cls: "hl-kw" });
      else if (/^[A-Z]/.test(c[3])) r.push({ text: c[3], cls: "hl-type" });
      else r.push({ text: c[3], cls: "" });
    } else r.push({ text: c[0], cls: "" });
  }
  
  // Append comment part
  if (commentPart) r.push({ text: commentPart, cls: "hl-cmt" });
  
  return r;
}

function getWordIndex(text: string, clicked: number): { start: number; end: number } {
  const isWordChar = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
  const clamped = Math.max(0, Math.min(clicked, text.length));
  let start = clamped;
  let end = clamped;

  // If the caret is on whitespace/punctuation, first try the character immediately after it.
  if (!isWordChar(text[start] ?? "")) {
    const next = start + 1;
    if (next < text.length && isWordChar(text[next])) {
      start = next;
      end = next;
    }
  }

  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  return { start, end };
}



interface SymNode { sym: Sym; children: SymNode[]; }

function normPath(p?: string): string {
  return (p ?? "").replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "").toLowerCase();
}

function buildSymTree(flat: Sym[]): SymNode[] {
  const sorted = [...flat].sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  const roots: SymNode[] = [];
  const stack: SymNode[] = [];
  for (const s of sorted) {
    const node: SymNode = { sym: s, children: [] };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (s.startLine > top.sym.endLine || (s.startLine === top.sym.endLine && s.startColumn >= top.sym.endColumn)) {
        stack.pop();
      } else break;
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
export default function App() {
  const [lang, setLang] = useState<Lang>("zh");
  const t = (k: string) => (L[lang] as Record<string,string>)[k] ?? k;
  const [ws, setWs] = useState<Ws | null>(null);
  const [, setTree] = useState<N[]>([]);
  const [expanded, setExpanded] = useState<Record<string, N[]>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [syms, setSyms] = useState<Sym[]>([]);
  const [status, setStatus] = useState("就绪");
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [fileSearch, setFileSearch] = useState("");
  const [fileSearchVisible, setFileSearchVisible] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const [matchLines, setMatchLines] = useState<number[]>([]);
  const codeRef = useRef<HTMLPreElement>(null);
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<SRes["results"]>([]);
  const [focus, setFocus] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("lr-bm") ?? "[]"); } catch { return []; } });
  const [wsList, setWsList] = useState<Array<{root:string;name:string}>>(() => { try { return JSON.parse(localStorage.getItem("lr-ws-list") ?? "[]"); } catch { return []; } });
  const [refs, setRefs] = useState<NavTarget[]>([]);
  const [defs, setDefs] = useState<NavTarget[]>([]);
  const [refTarget, setRefTarget] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQ, setQuickQ] = useState("");
  const [quickResults, setQuickResults] = useState<string[]>([]);
  const [quickIdx, setQuickIdx] = useState(0);
  const [symOpen, setSymOpen] = useState(false);
  const [symQ, setSymQ] = useState("");
  const [symResults, setSymResults] = useState<NavTarget[]>([]);
  const [symIdx, setSymIdx] = useState(0);
  const [currentLine, setCurrentLine] = useState(0);
  const [highlightWord, setHighlightWord] = useState("");
  const [foldedLines, setFoldedLines] = useState<Set<number>>(new Set());
  const [outlineOpen, setOutlineOpen] = useState<Set<string>>(new Set());
  const [outlineFilter, setOutlineFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [codeFontSize, setCodeFontSize] = useState<number>(() => { const v = parseInt(localStorage.getItem("lr-font-size") ?? "13"); return v >= 9 && v <= 32 ? v : 13; });
  const codeLineH = Math.round(codeFontSize * 1.7);
  const [viewportH, setViewportH] = useState(600);
  const [jumpTarget, setJumpTarget] = useState<{path:string; line:number} | null>(null);
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(230);
  const [isResizing, setIsResizing] = useState<"left" | "right" | null>(null);
  const [refPopup, setRefPopup] = useState<{x:number;y:number;name:string;targets:NavTarget[]} | null>(null);
  const quickRef = useRef<HTMLInputElement>(null);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const symRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef<string | undefined>(undefined);

  const toggleBm = useCallback((p: string) => {
    setBookmarks(prev => { const n = prev.includes(p) ? prev.filter(x=>x!==p) : [p,...prev]; localStorage.setItem("lr-bm", JSON.stringify(n)); return n; });
  }, []);

  // Keyboard shortcuts
  // Resizable panels
  useEffect(() => {
    if (!isResizing) return;
    const onMouseMove = (e: MouseEvent) => {
      if (isResizing === "left") {
        const w = Math.max(160, Math.min(500, e.clientX));
        setLeftWidth(w);
      } else if (isResizing === "right") {
        const w = Math.max(160, Math.min(500, window.innerWidth - e.clientX));
        setRightWidth(w);
      }
    };
    const onMouseUp = () => setIsResizing(null);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); setCodeFontSize(v => Math.min(32, v + 1)); }
      if (e.ctrlKey && e.key === "-") { e.preventDefault(); setCodeFontSize(v => Math.max(9, v - 1)); }
      if (e.ctrlKey && e.key === "0") { e.preventDefault(); setCodeFontSize(13); }
            if (e.ctrlKey && e.key === "p") { e.preventDefault(); setQuickOpen(true); setQuickQ(""); setQuickResults([]); setQuickIdx(0); }
      if (e.ctrlKey && e.key === "f" && !e.shiftKey) { e.preventDefault(); setFileSearchVisible(true); setTimeout(() => fileSearchRef.current?.focus(), 50); }
      if (e.ctrlKey && e.shiftKey && e.key === "N") { e.preventDefault(); setSymOpen(true); setSymQ(""); setSymResults([]); setSymIdx(0); }
      if (e.ctrlKey && e.shiftKey && e.key === "F") { e.preventDefault(); setFocus(v=>!v); }
      if (e.key === "Escape") { setQuickOpen(false); setFileSearchVisible(false); setFileSearch(""); setMatchIdx(0); setRefPopup(null); setSymOpen(false); setSearchModalOpen(false); setWsMenuOpen(false); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Quick open debounce
  useEffect(() => {
    if (!quickOpen || !ws) return;
    const timer = setTimeout(async () => {
      try { setQuickResults(await call<string[]>("fuzzy_files", { workspaceId: ws.id, query: quickQ.trim(), limit: 20 })); setQuickIdx(0); } catch {}
    }, 100);
    return () => clearTimeout(timer);
  }, [quickQ, quickOpen, ws]);

  // Ctrl+wheel zoom on code area
  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setCodeFontSize(v => Math.max(9, Math.min(32, v + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [doc]);
  
  useEffect(() => { if (quickOpen && quickRef.current) quickRef.current.focus(); }, [quickOpen]);
  useEffect(() => { if (symOpen && symRef.current) symRef.current.focus(); }, [symOpen]);

  // Symbol lookup debounce
  useEffect(() => {
    if (!symOpen || !ws) return;
    const timer = setTimeout(async () => {
      try { setSymResults(await call<NavTarget[]>("fuzzy_symbols", { workspaceId: ws.id, query: symQ.trim(), limit: 30 })); setSymIdx(0); } catch {}
    }, 100);
    return () => clearTimeout(timer);
  }, [symQ, symOpen, ws]);
  

  // Tauri events: streaming search results + file change refresh + index progress
  useEffect(() => {
    if (!ws) return;
    const unsubs: Array<() => void> = [];
    const setup = async () => {
      unsubs.push(await listen<SRes["results"]>("search_batch", (ev) => {
        if (!Array.isArray(ev.payload)) return;
        setResults(prev => {
          const map = new Map(prev.map(r => [r.path, r]));
          for (const batch of ev.payload) {
            const existing = map.get(batch.path);
            if (existing) existing.matches.push(...batch.matches);
            else map.set(batch.path, { ...batch, matches: [...batch.matches] });
          }
          return [...map.values()];
        });
      }));
      unsubs.push(await listen<string>("files_changed", () => {
        // Reload tree root + active file
        call<N[]>("file_tree", { workspaceId: ws.id }).then(ch => {
          setTree([{ name: ws.name, path: "", isDir: true }]);
          setExpanded(p => { const c = { ...p, "": ch }; return c; });
        }).catch(() => {});
        if (activeTabRef.current) {
          call<Doc>("file_read", { workspaceId: ws.id, path: activeTabRef.current })
            .then(d => setDoc(d)).catch(() => {});
        }
      }));
      unsubs.push(await listen<{ indexedFiles: number }>("index_progress", (ev) => {
        if (ev.payload?.indexedFiles !== undefined) {
          setStatus(`${ws.name} · ${ev.payload.indexedFiles} indexed`);
        }
      }));
    };
    setup();
    return () => unsubs.forEach(fn => { try { fn(); } catch {} });
  }, [ws]);


  const openWorkspace = useCallback(async (root: string) => {
    setErr(null);
    try {
      const w = await call<Ws>("workspace_open", { root });
      setWs(w); setTabs([]); setActiveTab(0); setDoc(null); setSyms([]); setResults([]); setSearchQ(""); setRefs([]); setDefs([]);
      setTree([{ name: w.name, path: "", isDir: true }]); setExpanded({});
      try { const ch = await call<N[]>("file_tree", { workspaceId: w.id }); setExpanded({ "": ch }); } catch {}
      setFoldedLines(new Set()); setHighlightWord(""); setCurrentLine(0); setJumpTarget(null);
      setStatus(`${w.name} · ${w.indexedFiles} indexed`);
      setWsList(prev => {
        const next = [{ root, name: w.name }, ...prev.filter(x => normPath(x.root) !== normPath(root))];
        localStorage.setItem("lr-ws-list", JSON.stringify(next));
        return next;
      });
      return w;
    } catch (e) { const m = String(e); setErr(m); setStatus(`ERR: ${m}`); return null; }
  }, []);

  const removeWorkspace = useCallback((root: string) => {
    setWsList(prev => {
      const next = prev.filter(x => x.root !== root);
      localStorage.setItem("lr-ws-list", JSON.stringify(next));
      return next;
    });
    if (ws?.root === root) {
      setWs(null); setTabs([]); setActiveTab(0); setDoc(null); setSyms([]); setTree([]);
      localStorage.removeItem("lr-last-ws"); localStorage.removeItem("lr-last-tabs"); localStorage.removeItem("lr-last-active");
      setStatus(lang === "zh" ? "工作区已移除" : "Workspace removed");
    }
  }, [ws, lang]);

  const openFolder = useCallback(async () => {
    const sel = await open({ directory: true, multiple: false });
    if (!sel) return;
    await openWorkspace(sel);
  }, [openWorkspace]);

  // Session persistence: save workspace + tabs + active tab
  useEffect(() => {
    if (!ws) return;
    localStorage.setItem("lr-last-ws", ws.root);
    localStorage.setItem("lr-last-tabs", JSON.stringify(tabs.map(t => t.path)));
    localStorage.setItem("lr-last-active", String(activeTab));
  }, [ws, tabs, activeTab]);

  useEffect(() => { localStorage.setItem("lr-font-size", String(codeFontSize)); }, [codeFontSize]);
  
  // Session restore: on startup, reopen last workspace + tabs
  useEffect(() => {
    const savedWs = localStorage.getItem("lr-last-ws");
    if (!savedWs) return;
    (async () => {
      const w = await openWorkspace(savedWs);
      if (!w) return;
      let savedTabs: string[] = [];
      let savedActive = 0;
      try {
        savedTabs = JSON.parse(localStorage.getItem("lr-last-tabs") ?? "[]");
        savedActive = parseInt(localStorage.getItem("lr-last-active") ?? "0") || 0;
      } catch {}
      for (const path of savedTabs) {
        try {
          const d = await call<Doc>("file_read", { workspaceId: w.id, path });
          const name = path.split("/").pop() || path;
          setTabs(prev => prev.some(tb => tb.path === path) ? prev : [...prev, { path, name, lang: d.language }]);
        } catch {}
      }
      if (savedTabs.length > 0) {
        const idx = Math.min(savedActive, savedTabs.length - 1);
        const path = savedTabs[idx];
        try {
          const d = await call<Doc>("file_read", { workspaceId: w.id, path });
          setDoc(d); _inMultiLine = false;
          try { setSyms(await call<Sym[]>("outline", { workspaceId: w.id, path })); } catch { setSyms([]); }
          const tabIdx = savedTabs.indexOf(path);
          setActiveTab(tabIdx >= 0 ? tabIdx : 0);
          setStatus(`${path} · ${d.language}`);
        } catch {}
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDir = useCallback(async (path: string) => {
    if (!ws) return;
    try {
      if (expanded[path]) { const c = {...expanded}; delete c[path]; setExpanded(c); return; }
      const ch = path === "" ? await call<N[]>("file_tree", { workspaceId: ws.id }) : await call<N[]>("file_tree", { workspaceId: ws.id, path });
      setExpanded(p => ({ ...p, [path]: ch }));
    } catch (e) { setStatus(`ERR: ${e}`); }
  }, [ws, expanded]);


  const activeTabData = tabs[activeTab];
  activeTabRef.current = activeTabData?.path;
  const openFile = useCallback(async (path: string, targetLine?: number) => {
    if (!ws) return;
    try {
      setErr(null); setStatus(`Loading...`);
      const d = await call<Doc>("file_read", { workspaceId: ws.id, path });
      setDoc(d); setRefs([]); setDefs([]); setFileSearch(""); setFileSearchVisible(false); setCursor({line:1,col:1}); _inMultiLine = false;
      const name = path.split("/").pop() || path;
      setTabs(prev => {
        if (prev.some(tb => tb.path === path)) return prev;
        return [...prev, { path, name, lang: d.language }];
      });
      const existingIdx = tabs.findIndex(tb => tb.path === path);
      setActiveTab(existingIdx >= 0 ? existingIdx : tabs.length);
      try { setSyms(await call<Sym[]>("outline", { workspaceId: ws.id, path })); } catch { setSyms([]); }
      setStatus(`${path} · ${d.language}`);
      if (targetLine !== undefined) {
        setJumpTarget({ path, line: targetLine });
      } else {
        setJumpTarget(null);
      }
    } catch (e) { const m = String(e); setErr(m); setStatus(`ERR: ${m}`); }
  }, [ws, tabs]);

  const switchTab = useCallback(async (idx: number) => {
    if (!ws || !tabs[idx]) return;
    setActiveTab(idx);
    try {
      const d = await call<Doc>("file_read", { workspaceId: ws.id, path: tabs[idx].path });
      setDoc(d);
      try { setSyms(await call<Sym[]>("outline", { workspaceId: ws.id, path: tabs[idx].path })); } catch { setSyms([]); }
      setStatus(`${tabs[idx].path} · ${d.language}`);
    } catch (e) { setStatus(`ERR: ${e}`); }
  }, [ws, tabs]);

  const closeTab = useCallback((idx: number) => {
    setTabs(prev => {
      const n = prev.filter((_, i) => i !== idx);
      if (n.length === 0) { setDoc(null); setSyms([]); }
      else if (idx === activeTab) { const ni = Math.min(idx, n.length - 1); setActiveTab(ni); switchTab(ni); }
      return n;
    });
  }, [activeTab, switchTab]);


  const doSearch = useCallback(async (q: string) => {
    if (!ws || !q.trim()) { setResults([]); return; }
    try {
      const r = await call<SRes>("search", { workspaceId: ws.id, query: q.trim(), options: { caseSensitive: false, regex: false, wholeWord: false, maxResults: 300 } });
      setResults(r.results);
    } catch (e) { setStatus(`ERR: ${e}`); }
  }, [ws]);

  // Global search (modal) debounce
  useEffect(() => {
    if (!searchModalOpen || !ws || !searchQ.trim()) return;
    const timer = setTimeout(() => doSearch(searchQ), 250);
    return () => clearTimeout(timer);
  }, [searchQ, searchModalOpen, ws, doSearch]);
  
  const findRefs = useCallback(async (name: string) => {
    if (!ws || !name.trim()) return;
    setRefTarget(name);
    try { setRefs(await invoke<NavTarget[]>("find_references", { workspaceId: ws.id, name: name.trim() })); } catch {}
  }, [ws]);


  const getWordAtClick = useCallback((e: React.MouseEvent, lineText: string): { word: string; charIdx: number } => {
    const lineEl = e.currentTarget as HTMLElement;
    const codeTextEl = lineEl.querySelector<HTMLElement>(".code-text");
    if (!codeTextEl) return { word: "", charIdx: 0 };

    // WebView2 exposes caretRangeFromPoint. This is more accurate than estimating columns
    // from pixels, especially around multi-byte text and syntax-highlight spans.
    const caret =
      typeof document.caretRangeFromPoint === "function"
        ? document.caretRangeFromPoint(e.clientX, e.clientY)
        : null;
    if (caret && codeTextEl.contains(caret.startContainer)) {
      const prefix = document.createRange();
      prefix.selectNodeContents(codeTextEl);
      try {
        prefix.setEnd(caret.startContainer, caret.startOffset);
        const charIdx = Math.max(0, Math.min(prefix.toString().length, lineText.length));
        const at = getWordIndex(lineText, charIdx);
        return { word: lineText.slice(at.start, at.end), charIdx: at.start };
      } catch {
        // Fall through to the geometry-based detector below.
      }
    }

    // Fallback for platforms without caret APIs. Measure the real glyph width instead of
    // hard-coding one; this stays correct if the reader font size changes later.
    const measuredRange = document.createRange();
    measuredRange.selectNodeContents(codeTextEl);
    const measuredRect = measuredRange.getBoundingClientRect();
    const textLength = Math.max(1, codeTextEl.textContent?.length || lineText.length);
    const glyphWidth = Math.max(1, measuredRect.width / textLength);
    const rawIndex = Math.floor((e.clientX - codeTextEl.getBoundingClientRect().left) / glyphWidth);
    const charIdx = Math.max(0, Math.min(rawIndex, lineText.length));
    const at = getWordIndex(lineText, charIdx);
    return { word: lineText.slice(at.start, at.end), charIdx: at.start };
  }, []);

  const handleCodeClick = useCallback(async (e: React.MouseEvent, lineIdx: number) => {
    if (!ws || !activeTabData?.path || !doc) return;

    const lines = doc.content.split("\n");
    const lineText = lines[lineIdx] || "";
    const { word, charIdx } = getWordAtClick(e, lineText);
    if (!word || word.length < 2) {
      setCursor({ line: lineIdx + 1, col: charIdx + 1 });
      return;
    }

    setCursor({ line: lineIdx + 1, col: charIdx + 1 });
    setCurrentLine(lineIdx + 1);
    setHighlightWord(word);

    // Ctrl+Alt+Click: Find Usages (IDEA style)
    if (e.ctrlKey && e.altKey) {
      e.preventDefault();
      try {
        const targets = await call<NavTarget[]>("find_references", { workspaceId: ws.id, name: word });
        setRefPopup({ x: e.clientX, y: e.clientY, name: word, targets });
      } catch (err) {
        setStatus(lang === "zh" ? `引用查找失败：${err}` : `Find references failed: ${err}`);
      }
      return;
    }

    // Ctrl+Click / Cmd+Click: Go to Definition (IDEA style)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      try {
        const targets = await call<NavTarget[]>("goto_definition", { workspaceId: ws.id, name: word, currentPath: activeTabData.path });
        if (targets.length === 1) {
          openFile(targets[0].path, targets[0].startLine);
        } else if (targets.length > 1) {
          setRefPopup({ x: e.clientX, y: e.clientY, name: word, targets });
        } else {
          const refs = await call<NavTarget[]>("find_references", { workspaceId: ws.id, name: word });
          if (refs.length > 0) {
            setRefPopup({ x: e.clientX, y: e.clientY, name: word, targets: refs });
          } else {
            setStatus(lang === "zh" ? `未找到定义：${word}` : `No definition found for "${word}"`);
          }
        }
      } catch (err) {
        console.error("[goDef]", err);
        setStatus(lang === "zh" ? `跳转失败：${err}` : `Go-to-definition failed: ${err}`);
      }
      return;
    }

    // Ordinary clicks only move the logical cursor, exactly like IDEA.
  }, [ws, activeTabData, doc, openFile, getWordAtClick, lang]);

  // File search matches
  const searchMatches = useMemo(() => {
    if (!doc || !fileSearch.trim()) { setMatchLines([]); return new Set<number>(); }
    const q = fileSearch.toLowerCase();
    const lines = doc.content.split("\n");
    const matches = new Set<number>();
    const arr: number[] = [];
    lines.forEach((line, i) => { if (line.toLowerCase().includes(q)) { matches.add(i); arr.push(i); } });
    setMatchLines(arr);
    if (arr.length > 0 && matchIdx >= arr.length) setMatchIdx(0);
    return matches;
  }, [doc, fileSearch]);




  // Code folding: combines bracket-balanced folding (for multi-line calls/blocks) with
  // indentation-based folding (for def/class/if/for etc). A foldable line gets a gutter
  // arrow; folding it hides all lines until the matching close bracket or dedent.
  const foldInfo = useMemo(() => {
    const empty = { foldable: new Set<number>(), ranges: new Map<number, number>() };
    if (!doc) return empty;
    const lines = doc.content.split("\n");
    const foldable = new Set<number>();
    const ranges = new Map<number, number>(); // start line -> end line (inclusive)

    // Pass 1: bracket-based folding. Track each opening bracket individually on a stack
    // so patterns like "} catch (Exception e) {" correctly close try AND open catch as
    // two independent foldable regions (IDEA behavior).
    const bracketStack: Array<{ line: number; char: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let inStr: string | null = null;
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (inStr) {
          if (ch === inStr && line[j - 1] !== "\\") inStr = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
        } else if (ch === "#") {
          break; // Python-style comment
        } else if (ch === "(" || ch === "[" || ch === "{") {
          bracketStack.push({ line: i, char: ch });
        } else if (ch === ")" || ch === "]" || ch === "}") {
          const open = bracketStack.pop();
          if (open) {
            foldable.add(open.line);
            const existing = ranges.get(open.line);
            if (existing === undefined || i > existing) ranges.set(open.line, i);
          }
        }
      }
    }

    // Pass 2: indentation-based folding for blocks like def/if/for/class.
    // Skip lines already covered by bracket folds to avoid double-marking.
    for (let i = 0; i < lines.length - 1; i++) {
      const cur = lines[i];
      if (!cur.trim()) continue;
      const curIndent = cur.length - cur.trimStart().length;
      const trimmed = cur.trim();
      const isDefOrClass = trimmed.startsWith("def ") || trimmed.startsWith("class ") || trimmed.startsWith("async def ");

      if (isDefOrClass) {
        // Whole-method fold: cover from def line all the way to end of body (indentation).
        // Start scanning after any bracket-fold range (multi-line params) so the body
        // after the closing paren is included in the same fold region.
        let bodyStart = i + 1;
        if (ranges.has(i)) bodyStart = Math.max(bodyStart, ranges.get(i)! + 1);
        let end = i;
        for (let j = bodyStart; j < lines.length; j++) {
          const line = lines[j];
          if (!line.trim()) { end = j; continue; }
          const indent = line.length - line.trimStart().length;
          if (indent <= curIndent) break;
          end = j;
        }
        if (end > i) {
          foldable.add(i);
          ranges.set(i, end); // override bracket fold with whole-method fold
        }
        continue;
      }

      if (foldable.has(i)) continue;
      const next = lines[i + 1] ?? "";
      const nextIndent = next.length - next.trimStart().length;
      if (next.trim() && nextIndent > curIndent) {
        // Extend to the last consecutive line with deeper indentation
        let end = i;
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          if (!line.trim()) { end = j; continue; }
          const indent = line.length - line.trimStart().length;
          if (indent <= curIndent) break;
          end = j;
        }
        if (end > i) {
          foldable.add(i);
          ranges.set(i, end);
        }
      }
    }

    return { foldable, ranges };
  }, [doc]);

  // Which lines are hidden because their fold-parent is collapsed
  const hiddenLines = useMemo(() => {
    if (!doc || foldedLines.size === 0) return new Set<number>();
    const hidden = new Set<number>();
    for (const start of foldedLines) {
      const end = foldInfo.ranges.get(start);
      if (end === undefined) continue;
      for (let j = start + 1; j <= end; j++) hidden.add(j);
    }
    return hidden;
  }, [doc, foldedLines, foldInfo]);

  const toggleFold = useCallback((lineIdx: number) => {
    setFoldedLines(prev => {
      const next = new Set(prev);
      if (next.has(lineIdx)) next.delete(lineIdx);
      else next.add(lineIdx);
      return next;
    });
  }, []);
  const isBm = activeTabData?.path ? bookmarks.includes(activeTabData.path) : false;

  const toggleOutline = useCallback((key: string) => {
    setOutlineOpen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  
  const renderOutlineSym = (node: SymNode, depth: number): React.ReactNode => {
    const s = node.sym;
    const key = `${s.path}:${s.startLine}:${s.name}`;
    const hasChildren = node.children.length > 0;
    const isOpen = outlineOpen.has(key);
    return (
      <div key={key}>
        <div className="sym-row" style={{ paddingLeft: 8 + depth * 14 }}
          onClick={(e) => { if (hasChildren && (e.target as HTMLElement).classList.contains("outline-arrow")) { e.stopPropagation(); toggleOutline(key); } else { openFile(activeTabData?.path || "", s.startLine + 1); setHighlightWord(s.name); setCurrentLine(s.startLine + 1); } }}
          onContextMenu={(e) => { e.preventDefault(); findRefs(s.name); }}
          title="Click name: jump · Click arrow: expand/collapse · Right-click: find refs">
          {hasChildren && <span className={`outline-arrow ${isOpen ? "open" : ""}`}>{isOpen ? "▾" : "▸"}</span>}
          {!hasChildren && <span className="outline-arrow"> </span>}
          <span className="kind">{s.kind}</span>{s.name}
        </div>
        {hasChildren && isOpen && node.children.map(c => renderOutlineSym(c, depth + 1))}
      </div>
    );
  };
  
  const renderTree = (nodes: N[], depth: number) => nodes.map(n => (
    <div key={n.path || n.name}>
      <button className={`tree-row ${activeTabData?.path === n.path && !n.isDir ? "tree-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => n.isDir ? loadDir(n.path) : openFile(n.path)}>
        <span className="tree-icon">{n.isDir ? (expanded[n.path] ? "▾" : "▸") : "•"}</span>
        {n.name}
        {!n.isDir && bookmarks.includes(n.path) && <span className="bm-star">★</span>}
      </button>
      {expanded[n.path]?.map(c => renderTree([c], depth + 1))}
    </div>
  ));

  const symTree = useMemo(() => buildSymTree(syms), [syms]);
  const filteredSymTree = useMemo(() => {
    if (!outlineFilter.trim()) return symTree;
    const q = outlineFilter.toLowerCase();
    const filterNodes = (nodes: SymNode[]): SymNode[] => {
      const result: SymNode[] = [];
      for (const n of nodes) {
        const children = filterNodes(n.children);
        if (n.sym.name.toLowerCase().includes(q) || children.length > 0) {
          result.push({ ...n, children });
        }
      }
      return result;
    };
    return filterNodes(symTree);
  }, [symTree, outlineFilter]);
  
  // Auto-expand all outline nodes when a new file is loaded
  useEffect(() => {
    const all = new Set<string>();
    const walk = (nodes: SymNode[]) => { for (const n of nodes) { all.add(`${n.sym.path}:${n.sym.startLine}:${n.sym.name}`); walk(n.children); } };
    walk(symTree);
    setOutlineOpen(all);
  }, [symTree]);
  
  const codeLines = useMemo(() => {
    if (!doc) return [];
    return doc.content.split("\n").map(line => ({ raw: line, tokens: hl(line, doc.language) }));
  }, [doc]);
  // Virtual scrolling: only render lines near the viewport for large files
  const isLargeFile = codeLines.length > 300;
  const visibleRange = useMemo(() => {
    if (!isLargeFile) return { start: 0, end: codeLines.length };
    const start = Math.max(0, Math.floor(scrollTop / codeLineH) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / codeLineH) + OVERSCAN * 2;
    const end = Math.min(codeLines.length, start + visibleCount);
    return { start, end };
  }, [isLargeFile, scrollTop, viewportH, codeLines.length, codeLineH]);

  const onCodeScroll = useCallback((e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight || 600);
  }, []);
    // Scroll to jump target when doc changes
  useEffect(() => {
    console.log("[scrollEffect] jumpTarget:", jumpTarget, "doc:", !!doc, "activePath:", activeTabData?.path);
    if (!jumpTarget || !doc || !codeRef.current) return;
    if (jumpTarget.path !== activeTabData?.path) { console.log("[scrollEffect] path mismatch"); return; }
    const timer = setTimeout(() => {
      const codeEl = codeRef.current;
      if (!codeEl) return;
      if (codeLines.length > 300) {
        // Virtual scrolling: compute offset directly since the line may not be in the DOM
        codeEl.scrollTop = Math.max(0, (jumpTarget.line - 1) * codeLineH - codeEl.clientHeight / 2);
      } else {
        const allLines = codeEl.querySelectorAll(".code-line");
        if (jumpTarget.line <= allLines.length) {
          const lineEl = allLines[jumpTarget.line - 1];
          if (lineEl) {
            lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [doc, jumpTarget, activeTabData, codeLines, codeLineH]);
  const goMatch = useCallback((dir: number) => {
    if (matchLines.length === 0) return;
    let next = matchIdx + dir;
    if (next < 0) next = matchLines.length - 1;
    if (next >= matchLines.length) next = 0;
    setMatchIdx(next);
    // Scroll to the matching line
    const targetLine = matchLines[next];
    const codeEl = codeRef.current;
    if (codeEl) {
      if (isLargeFile) {
        codeEl.scrollTop = Math.max(0, targetLine * codeLineH - codeEl.clientHeight / 2);
      } else {
        const lineEl = codeEl.querySelector(`.code-line:nth-child(${targetLine + 1})`);
        if (lineEl) lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [matchIdx, matchLines, isLargeFile, codeLineH]);

  return (
    <div className={`app ${focus ? "focus" : ""}`}>
      <header className="hdr">
        <span className="logo">LR</span>
        <span />
        <button className="btn-focus" onClick={() => setFocus(!focus)}>{t("focus")}</button>
        <button className="btn-lang" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>{lang === "zh" ? "EN" : "中文"}</button>
        <button className="btn-open" onClick={openFolder}>{t("open")}</button>
      </header>
      {err && <div className="err-bar">⚠ {err}</div>}

      {quickOpen && (
        <div className="qo-overlay" onClick={() => setQuickOpen(false)}>
          <div className="qo-modal" onClick={e => e.stopPropagation()}>
            <input ref={quickRef} className="qo-input" value={quickQ}
              onChange={e => setQuickQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === "ArrowDown") { e.preventDefault(); setQuickIdx(i => Math.min(i+1, quickResults.length-1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setQuickIdx(i => Math.max(i-1, 0)); }
                if (e.key === "Enter" && quickResults[quickIdx]) { setQuickOpen(false); openFile(quickResults[quickIdx]); }
              }}
              placeholder={t("quick")} spellCheck={false} />
            <div className="qo-list">
              {quickResults.map((p, i) => (
                <button key={p} className={`qo-item ${i === quickIdx ? "on" : ""}`}
                  onClick={() => { setQuickOpen(false); openFile(p); }}
                  onMouseEnter={() => setQuickIdx(i)}>{p}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      <main className="layout">
        {!focus && (
          <aside className="left" style={{ width: leftWidth, minWidth: 160, maxWidth: 500 }}>
            <div className="side-top">
              <button className="ws-switcher" onClick={() => setWsMenuOpen(v => !v)} title="切换工作区">
                <span className="lr-logo">LR</span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <button className="icon-btn" onClick={() => setSearchModalOpen(true)} title="全局搜索">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </button>
            </div>
            {wsMenuOpen && (
              <>
                <div className="ws-menu-overlay" onClick={() => setWsMenuOpen(false)} />
                <div className="ws-menu">
                  {wsList.map(w => (
                    <div key={w.root} className={`ws-menu-row ${ws?.root === w.root ? "on" : ""}`}>
                      <button className="ws-menu-item" onClick={() => { setWsMenuOpen(false); openWorkspace(w.root); }}>{w.name}</button>
                      <button className="ws-menu-remove" title="移除" onClick={(e) => { e.stopPropagation(); removeWorkspace(w.root); }}>×</button>
                    </div>
                  ))}
                  <div className="ws-menu-divider" />
                  <button className="ws-menu-item" onClick={() => { setWsMenuOpen(false); openFolder(); }}>打开文件夹…</button>
                </div>
              </>
            )}
              <div className="side-section-title">文件</div>
              <div className="folder-list">
                {wsList.map(w => {
                  const active = normPath(ws?.root) === normPath(w.root);
                  return (
                    <div key={w.root} className={`folder-item ${active ? "on" : ""}`}>
                      <button className="folder-row" onClick={() => openWorkspace(w.root)} title={w.root}>
                        <svg className="folder-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        <span>{w.name}</span>
                      </button>
                      {active && expanded[""] && (
                        <div className="folder-files">
                          {expanded[""].map(c => renderTree([c], 0))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {wsList.length === 0 && (
                  <div className="muted" style={{ padding: "8px 12px", fontSize: 12.5 }}>点上方"打开文件夹"导入</div>
                )}
              </div>
          </aside>
        )}

        <div className={`resize-handle resize-left ${isResizing === "left" ? "active" : ""}`}
          onMouseDown={() => setIsResizing("left")} />
        <section className="center">
          {doc ? (
            <>
              {/* Tab bar */}
              {tabs.length > 0 && (
                <div className="tab-bar">
                  {tabs.map((tb, i) => (
                    <div key={tb.path} className={`tab-item ${i === activeTab ? "on" : ""}`}
                      onClick={() => switchTab(i)}>
                      <span>{tb.name}</span>
                      <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(i); }}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="doc-hdr">
                <span>{activeTabData?.path}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <button className="btn-mini" onClick={() => { const p = activeTabData?.path; if (p) toggleBm(p); }}>{isBm ? "★" : "☆"}</button>
                  <span className="lang-tag">{doc.language}</span>
                </div>
              </div>
              {fileSearchVisible && (
                <div className="file-search-bar">
                  <input ref={fileSearchRef} value={fileSearch} placeholder={t("fileSearch")}
                    onChange={e => setFileSearch(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Escape") { setFileSearchVisible(false); setFileSearch(""); setMatchIdx(0); }
                      if (e.key === "Enter") { e.shiftKey ? goMatch(-1) : goMatch(1); }
                    }} />
                  <span className="muted">{matchLines.length > 0 ? `${matchIdx + 1}/${matchLines.length}` : "0"}</span>
                  <button className="btn-mini" onClick={() => goMatch(-1)} title="Shift+Enter">↑</button>
                  <button className="btn-mini" onClick={() => goMatch(1)} title="Enter">↓</button>
                  <button className="btn-mini" onClick={() => { setFileSearchVisible(false); setFileSearch(""); setMatchIdx(0); }}>✕</button>
                </div>
              )}
              <pre ref={codeRef} className="code" onScroll={onCodeScroll} style={{ fontSize: `${codeFontSize}px`, "--code-line-h": `${codeLineH}px` } as React.CSSProperties}>
                {isLargeFile && visibleRange.start > 0 && <div style={{ height: visibleRange.start * codeLineH }} />}
                {codeLines.slice(visibleRange.start, visibleRange.end).map((line, idx) => {
                  const i = visibleRange.start + idx;
                  if (hiddenLines.has(i)) return null;
                  const isFoldable = foldInfo.foldable.has(i);
                  const isFolded = foldedLines.has(i);
                  const lineClasses = [
                    "code-line",
                    searchMatches.has(i) ? "search-match" : "",
                    matchLines[matchIdx] === i ? "search-current" : "",
                    jumpTarget && jumpTarget.path === activeTabData?.path && jumpTarget.line === i + 1 ? "jump-target" : "",
                    currentLine === i + 1 ? "current-line" : "",
                  ].filter(Boolean).join(" ");
                  const renderToken = (tk: { text: string; cls: string }, j: number) => {
                    if (highlightWord && tk.text.includes(highlightWord)) {
                      const parts = tk.text.split(highlightWord);
                      return (
                        <span key={j} className={tk.cls || undefined}>
                          {parts.map((part, pi) => (
                            <span key={pi}>
                              {part}
                              {pi < parts.length - 1 && <span className="sym-hl">{highlightWord}</span>}
                            </span>
                          ))}
                        </span>
                      );
                    }
                    return tk.cls ? <span key={j} className={tk.cls}>{tk.text}</span> : <span key={j}>{tk.text}</span>;
                  };
                  // IDEA fold: truncate line at the fold-opening bracket, show … placeholder
                  let foldBracketPos = -1;
                  let foldBracketChar = "";
                  
                  if (isFolded && isFoldable) {
                    let d = 0, inStr: string | null = null;
                    for (let j = 0; j < line.raw.length; j++) {
                      const ch = line.raw[j];
                      if (inStr) { if (ch === inStr && line.raw[j-1] !== "\\") inStr = null; }
                      else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
                      else if (ch === "#") break;
                      else if (ch === "(" || ch === "[" || ch === "{") { d++; foldBracketPos = j; foldBracketChar = ch; }
                      else if (ch === ")" || ch === "]" || ch === "}") d--;
                    }
                  }
                  const placeholder = foldBracketChar === "{" ? "{...}" : foldBracketChar === "(" ? "(...)" : foldBracketChar === "[" ? "[...]" : "...";
                  // Filter tokens: keep only text before the fold bracket
                  let charCursor = 0;
                  const visibleTokens: { text: string; cls: string }[] = [];
                  if (isFolded && isFoldable && foldBracketPos >= 0) {
                    for (const tk of line.tokens) {
                      const tkStart = charCursor;
                      const tkEnd = charCursor + tk.text.length;
                      charCursor = tkEnd;
                      if (tkEnd <= foldBracketPos) { visibleTokens.push(tk); }
                      else if (tkStart < foldBracketPos) {
                        visibleTokens.push({ text: tk.text.slice(0, foldBracketPos - tkStart), cls: tk.cls });
                        break;
                      }
                    }
                  }
                  const renderVisible = (tk: { text: string; cls: string }, j: number) => {
                    if (highlightWord && tk.text.includes(highlightWord)) {
                      const parts = tk.text.split(highlightWord);
                      return (
                        <span key={j} className={tk.cls || undefined}>
                          {parts.map((part, pi) => (
                            <span key={pi}>
                              {part}
                              {pi < parts.length - 1 && <span className="sym-hl">{highlightWord}</span>}
                            </span>
                          ))}
                        </span>
                      );
                    }
                    return tk.cls ? <span key={j} className={tk.cls}>{tk.text}</span> : <span key={j}>{tk.text}</span>;
                  };
                  return (
                    <div key={i} className={lineClasses}
                      onClick={(e) => handleCodeClick(e, i)}>
                      <span className="line-num">{i+1}</span>
                      <span className={`fold-gutter ${isFoldable ? "foldable" : ""} ${isFolded ? "folded" : ""}`}
                        onClick={(e) => { if (isFoldable) { e.stopPropagation(); toggleFold(i); } }}>
                        {isFoldable ? (isFolded ? "▸" : "▾") : ""}
                      </span>
                      <span className="code-text">
                        {(isFolded && isFoldable && foldBracketPos >= 0 ? visibleTokens : line.tokens).map(isFolded && isFoldable ? renderVisible : renderToken)}
                        {isFolded && isFoldable && foldBracketPos >= 0 && (
                          <span className="fold-placeholder"
                            onClick={(e) => { e.stopPropagation(); toggleFold(i); }}
                            title="Click to expand">{placeholder}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
                {isLargeFile && visibleRange.end < codeLines.length && <div style={{ height: (codeLines.length - visibleRange.end) * codeLineH }} />}
              </pre>
            </>
          ) : <div className="no-file">{t("noFile")}</div>}
        </section>

        <div className={`resize-handle resize-right ${isResizing === "right" ? "active" : ""}`}
          onMouseDown={() => setIsResizing("right")} />
        {!focus && (
          <aside className="right" style={{ width: rightWidth, minWidth: 160, maxWidth: 500 }}>
            <div className="panel">
              <h4>{t("outline")}</h4>
              <input className="outline-filter" value={outlineFilter} placeholder="filter symbols…"
                onChange={e => setOutlineFilter(e.target.value)} />
              {syms.length===0 ? <span className="muted">{t("noSyms")}</span> :
                filteredSymTree.map(n => renderOutlineSym(n, 0))}
              {syms.length>0 && <button className="find-refs-btn" onClick={() => syms[0] && findRefs(syms[0].name)}>{t("findRefs")} →</button>}
            </div>
            {refs.length > 0 && (
              <div className="panel">
                <h4>{t("refsFor")}: {refTarget}</h4>
                {refs.map((r,i) => (
                  <div key={i} className="sym-row" onClick={() => openFile(r.path, r.startLine)}>
                    <span className="kind">{r.kind}</span>{r.name}<br/>
                    <span className="muted" style={{fontSize:11}}>{r.path}:{r.startLine}</span>
                  </div>
                ))}
              </div>
            )}
            {defs.length > 0 && (
              <div className="panel">
                <h4>{t("defs")}</h4>
                {defs.map((d,i) => (
                  <div key={i} className="sym-row" onClick={() => openFile(d.path, d.startLine)}>
                    <span className="kind">{d.kind}</span>{d.name}<br/>
                    <span className="muted" style={{fontSize:11}}>{d.path}:{d.startLine}</span>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
      </main>

      {/* Global search modal */}
      {searchModalOpen && (
        <div className="qo-overlay" onClick={() => setSearchModalOpen(false)}>
          <div className="qo-modal" onClick={e => e.stopPropagation()}>
            <input className="qo-input" autoFocus value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && results.length > 0 && results[0].matches.length > 0) { setSearchModalOpen(false); openFile(results[0].path, results[0].matches[0].line); } }}
              placeholder="全局搜索…" spellCheck={false} />
            <div className="qo-list">
              {results.length === 0 ? (
                <div className="ref-popup-empty">{searchQ.trim() ? "无结果" : "输入关键字搜索整个工作区"}</div>
              ) : results.map(r => (
                <div key={r.path} className="sm-file">
                  <div className="sm-file-name">{r.name} <span className="muted">{r.path}</span></div>
                  {r.matches.map((m, i) => (
                    <button key={i} className="sm-line" onClick={() => { setSearchModalOpen(false); openFile(r.path, m.line); }}>
                      <span className="sm-linenum">{m.line}</span>{m.text.trim()}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Symbol fuzzy lookup modal - IDEA style Ctrl+Shift+N */}
      {symOpen && (
        <div className="qo-overlay" onClick={() => setSymOpen(false)}>
          <div className="qo-modal" onClick={e => e.stopPropagation()}>
            <input ref={symRef} className="qo-input" value={symQ}
              onChange={e => setSymQ(e.target.value)}
              onKeyDown={e => {
                if (e.key === "ArrowDown") { e.preventDefault(); setSymIdx(i => Math.min(i+1, symResults.length-1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setSymIdx(i => Math.max(i-1, 0)); }
                if (e.key === "Enter" && symResults[symIdx]) {
                  const tg = symResults[symIdx];
                  setSymOpen(false); openFile(tg.path, tg.startLine);
                }
              }}
              placeholder="Search symbols: function, class, method…" spellCheck={false} />
            <div className="qo-list">
              {symResults.length === 0 ? (
                <div className="ref-popup-empty">No symbols found</div>
              ) : symResults.map((tg, i) => (
                <button key={`${tg.path}:${tg.startLine}:${i}`} className={`qo-item ${i === symIdx ? "on" : ""}`}
                  onClick={() => { setSymOpen(false); openFile(tg.path, tg.startLine); }}
                  onMouseEnter={() => setSymIdx(i)}>
                  <span className="kind">{tg.kind}</span> {tg.name}
                  <span className="muted" style={{fontSize:10, marginLeft:8}}>{tg.path}:{tg.startLine}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Reference/Definition popup - IDEA style */}
      {refPopup && (
        <>
          <div className="ref-popup-overlay" onClick={() => setRefPopup(null)} />
          <div className="ref-popup" style={{ left: refPopup.x, top: refPopup.y + 20 }}>
            <div className="ref-popup-header">
              <span className="ref-popup-name">{refPopup.name}</span>
              <span className="ref-popup-count">{refPopup.targets.length}</span>
              <button className="ref-popup-close" onClick={() => setRefPopup(null)}>✕</button>
            </div>
            <div className="ref-popup-list">
              {refPopup.targets.length === 0 ? (
                <div className="ref-popup-empty">{t("noRefsFound")}</div>
              ) : refPopup.targets.map((tg, i) => (
                <button key={i} className="ref-popup-item"
                  onClick={() => { setRefPopup(null); openFile(tg.path, tg.startLine); }}>
                  <span className="kind">{tg.kind}</span>
                  <span className="ref-popup-path">{tg.path}</span>
                  <span className="ref-popup-line">:{tg.startLine}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <footer className="stbar">
        <span>{status}</span>
        <span className="muted">Ln {cursor.line}, Col {cursor.col}</span>
        <span className="muted" style={{ marginLeft: "auto" }}>{Math.round(codeFontSize / 13 * 100)}%</span>
        <span className="muted">Ctrl+滚轮缩放 · Ctrl+P File · Ctrl+Shift+N Symbol · Ctrl+F Find</span>
      </footer>
    </div>
  );
}












































