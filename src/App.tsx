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
interface GitBranch { name: string; fullName: string; kind: string; isCurrent: boolean; }
interface GitCommit { hash: string; shortHash: string; subject: string; body: string; authorName: string; authorEmail: string; timestamp: number; refs: string; parents: string[]; }
interface GitFileChange { path: string; status: string; }
interface GitCommitDetail { commit: GitCommit; files: GitFileChange[]; }
interface NavHistoryEntry { path: string; line: number; }

function groupChangedFiles(files: GitFileChange[]) {
  const groups = new Map<string, GitFileChange[]>();
  for (const file of files) {
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
    const list = groups.get(dir) || [];
    list.push(file);
    groups.set(dir, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

interface GitGraphEdge { from: number; to: number; }
interface GitGraphRow { lane: number; edges: GitGraphEdge[]; verticals: number[]; }

function computeGitGraph(commits: GitCommit[]): { rows: GitGraphRow[]; maxLane: number } {
  const heads: Array<{ hash: string; lane: number }> = [];
  const rows: GitGraphRow[] = [];
  let maxLane = 0;
  const smallestFree = () => {
    const used = new Set(heads.map(h => h.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    return lane;
  };

  for (const commit of commits) {
    const consumed = heads.find(h => h.hash === commit.hash);
    const lane = consumed ? consumed.lane : smallestFree();
    if (consumed) heads.splice(heads.indexOf(consumed), 1);

    const edges: GitGraphEdge[] = [];
    commit.parents.forEach((parent, index) => {
      const existing = heads.find(h => h.hash === parent);
      if (existing) {
        edges.push({ from: lane, to: existing.lane });
        maxLane = Math.max(maxLane, existing.lane);
        return;
      }
      const nextLane = index === 0 ? lane : smallestFree();
      heads.push({ hash: parent, lane: nextLane });
      edges.push({ from: lane, to: nextLane });
      maxLane = Math.max(maxLane, nextLane);
    });

    const verticals = [...new Set([lane, ...heads.map(h => h.lane)])];
    maxLane = Math.max(maxLane, ...verticals);
    rows.push({ lane, edges, verticals });
  }
  return { rows, maxLane };
}

function gitRefBadges(refs: string) {
  return refs.split(",").map(v => v.trim()).filter(Boolean).map(v => v.replace(/^HEAD\s*->\s*/, ""));
}
interface SRes { results: { path: string; name: string; matches: { line: number; text: string }[] }[]; truncated: boolean; filesSearched: number; }
interface Tab { path: string; name: string; lang: string; }

interface Prefs {
  lineSpacing: number;
  codeFont: "default" | "consolas" | "jetbrains";
  lspEnabled: boolean;
}

const DEFAULT_PREFS: Prefs = {
  lspEnabled: true,
  lineSpacing: 1.7,
  codeFont: "default",
};

const CODE_FONT_STACKS: Record<Prefs["codeFont"], string> = {
  default: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, "Microsoft YaHei", monospace',
  consolas: 'Consolas, "Cascadia Mono", "Courier New", monospace',
  jetbrains: '"JetBrains Mono", "Fira Code", "Source Code Pro", Consolas, monospace',
};

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem("lr-prefs") ?? "{}");
    return { ...DEFAULT_PREFS, ...raw };
  } catch { return { ...DEFAULT_PREFS }; }
}

type Lang = "zh" | "en";
const L: Record<Lang, Record<string,string>> = {
  zh: { workspaces:"工作区",open:"打开文件夹",files:"文件",search:"搜索",noWs:"未打开",outline:"大纲",refs:"引用",defs:"定义",noFile:"未选择文件",noSyms:"无符号",focus:"专注",findRefs:"查找引用",quick:"快速打开文件…",refsFor:"引用",status:"就绪",fileSearch:"文件内搜索…",close:"关闭",goDef:"跳转",popupRefs:"引用处",popupDefs:"定义",noRefsFound:"无引用" },
  en: { workspaces:"Workspaces",open:"Open Folder",files:"Files",search:"Search",noWs:"No workspace",outline:"Outline",refs:"Refs",defs:"Defs",noFile:"No file",noSyms:"No symbols",focus:"Focus",findRefs:"Find Refs",quick:"Quick open file…",refsFor:"Refs",status:"Ready",fileSearch:"Search in file…",close:"Close",goDef:"Go",popupRefs:"Usages",popupDefs:"Definitions",noRefsFound:"No usages" }
};

// ── Unified diff parsing + GitHub-style rendering ──
interface DiffLine { type: "add" | "del" | "ctx"; content: string; oldNo: number | null; newNo: number | null; }
interface DiffHunk { header: string; lines: DiffLine[]; }
interface ParsedDiff { hunks: DiffHunk[]; additions: number; deletions: number; binary: boolean; }

function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const hunks: DiffHunk[] = [];
  let additions = 0, deletions = 0, binary = false;
  let cur: DiffHunk | null = null;
  let oldNo = 0, newNo = 0;
  for (const raw of lines) {
    if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) { binary = true; continue; }
    if (raw.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      oldNo = m ? parseInt(m[1]) : 1;
      newNo = m ? parseInt(m[2]) : 1;
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") ||
        raw.startsWith("+++ ") || raw.startsWith("new file") || raw.startsWith("deleted file") ||
        raw.startsWith("rename ") || raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) { additions++; cur.lines.push({ type: "add", content: raw.slice(1), oldNo: null, newNo: newNo++ }); }
    else if (raw.startsWith("-")) { deletions++; cur.lines.push({ type: "del", content: raw.slice(1), oldNo: oldNo++, newNo: null }); }
    else { cur.lines.push({ type: "ctx", content: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ }); }
  }
  return { hunks, additions, deletions, binary };
}

interface WdMark { start: number; end: number; type: "del" | "add"; }

function tokenizeWords(text: string): { t: string; start: number; end: number }[] {
  const re = /[A-Za-z0-9_$]+|\s+|./g;
  const out: { t: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function lcsUnmatched(a: string[], b: string[]): { aOnly: boolean[]; bOnly: boolean[] } {
  const n = a.length, m = b.length;
  const aOnly = Array(n).fill(true), bOnly = Array(m).fill(true);
  if (n * m > 40000) return { aOnly, bOnly };
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aOnly[i] = false; bOnly[j] = false; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { aOnly, bOnly };
}

// Word-level diff between a removed/added line pair -> char-range marks.
function wordDiffPair(oldText: string, newText: string): { del: WdMark[]; add: WdMark[] } {
  const A = tokenizeWords(oldText), B = tokenizeWords(newText);
  if (A.length + B.length > 400) return { del: [], add: [] };
  const { aOnly, bOnly } = lcsUnmatched(A.map(x => x.t), B.map(x => x.t));
  const del: WdMark[] = [], add: WdMark[] = [];
  A.forEach((tok, i) => { if (aOnly[i] && tok.t.trim()) del.push({ start: tok.start, end: tok.end, type: "del" }); });
  B.forEach((tok, j) => { if (bOnly[j] && tok.t.trim()) add.push({ start: tok.start, end: tok.end, type: "add" }); });
  return { del, add };
}

// Pair each removed-line run with the following added-line run and mark both.
function hunkWordMarks(lines: DiffLine[]): Map<number, WdMark[]> {
  const out = new Map<number, WdMark[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "del") { i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].type === "del") j++;
    const delEnd = j;
    let addStart = j;
    while (addStart < lines.length && lines[addStart].type === "add") addStart++;
    const pairs = Math.min(delEnd - i, addStart - j);
    for (let k = 0; k < pairs; k++) {
      const d = lines[i + k], a = lines[j + k];
      if (!d || !a || !d.content.trim() || !a.content.trim()) continue;
      const wd = wordDiffPair(d.content, a.content);
      if (wd.del.length) out.set(i + k, wd.del);
      if (wd.add.length) out.set(addStart + k, wd.add);
    }
    i = addStart;
  }
  return out;
}

// Render one diff line: syntax tokens from hl(), overlaid with word-diff marks.
function renderMarkedLine(content: string, lang: string, marks?: WdMark[]): React.ReactNode {
  const tokens = hl(content, lang);
  if (!marks || marks.length === 0) {
    return tokens.map((tk, i) => tk.cls ? <span key={i} className={tk.cls}>{tk.text}</span> : <span key={i}>{tk.text}</span>);
  }
  const markOf: string[] = new Array(content.length).fill("");
  for (const m of marks) {
    for (let p = m.start; p < Math.min(m.end, content.length); p++) markOf[p] = m.type;
  }
  const out: React.ReactNode[] = [];
  let key = 0;
  for (const tk of tokens) {
    let segStart = 0;
    for (let p = 1; p <= tk.text.length; p++) {
      const prev = markOf[segStart];
      if (p === tk.text.length || markOf[p] !== prev) {
        const seg = tk.text.slice(segStart, p);
        const cls = (tk.cls ? tk.cls + " " : "") + (prev ? `wd-${prev}` : "");
        out.push(<span key={key++} className={cls.trim() || undefined}>{seg}</span>);
        segStart = p;
      }
    }
  }
  return out;
}

function langOfPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "tsx", mjs: "javascript", cjs: "javascript",
    py: "python", pyi: "python", java: "java", rs: "rust", go: "go", c: "c", h: "c",
    cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", cs: "csharp",
    json: "json", css: "css", scss: "css", less: "css", html: "html", htm: "html",
    xml: "xml", svg: "xml", vue: "vue", svelte: "svelte", sql: "sql", rb: "ruby",
    php: "php", kt: "kotlin", kts: "kotlin", swift: "swift", yml: "yaml", yaml: "yaml",
    toml: "toml", sh: "shell", bash: "shell", zsh: "shell", lua: "lua", md: "markdown",
  };
  return map[ext] ?? "text";
}

const KW: Record<string, string[]> = {
  rust: ["fn","let","mut","const","pub","struct","enum","impl","trait","use","mod","match","if","else","for","while","loop","return","self","Self","crate","super","where","async","await","move","ref","dyn","unsafe","as","in","break","continue","true","false","static","type","box","union"],
  go: ["func","var","const","type","struct","interface","map","chan","go","defer","if","else","for","range","return","package","import","switch","case","default","break","continue","fallthrough","select","goto","nil","true","false","iota","make","new","append","len","cap","panic","recover"],
  c: ["int","char","float","double","void","long","short","unsigned","signed","struct","union","enum","typedef","static","extern","const","volatile","register","auto","return","if","else","for","while","do","switch","case","default","break","continue","goto","sizeof","include","define","ifndef","endif","pragma"],
  cpp: ["int","char","float","double","void","long","short","unsigned","signed","struct","union","enum","typedef","static","extern","const","constexpr","return","if","else","for","while","do","switch","case","default","break","continue","goto","sizeof","class","public","private","protected","virtual","override","final","template","typename","namespace","using","new","delete","this","try","catch","throw","operator","friend","inline","explicit","bool","true","false","nullptr","noexcept","auto","include","define","ifndef","endif","pragma"],
  csharp: ["using","namespace","class","public","private","protected","internal","static","readonly","const","void","int","string","bool","var","new","return","if","else","for","foreach","while","do","switch","case","default","break","continue","try","catch","finally","throw","this","base","null","true","false","async","await","override","virtual","interface","enum","struct","partial","sealed","get","set","value","is","as","in","out","ref","params","yield","lock","using"],
  json: ["true","false","null"],
  css: ["important","media","supports","keyframes","import","charset","font-face","page","layer","container","root","apply","theme","utility","variant","property"],
  sql: ["select","from","where","insert","into","values","update","set","delete","create","table","join","left","right","inner","outer","full","cross","on","group","by","order","limit","offset","having","as","and","or","not","null","is","primary","key","foreign","references","index","view","alter","drop","distinct","union","all","case","when","then","else","end","like","in","exists","between","asc","desc","begin","commit","rollback"],
  ruby: ["def","end","class","module","if","elsif","else","unless","while","until","for","do","begin","rescue","ensure","raise","yield","return","self","nil","true","false","require","require_relative","attr_accessor","attr_reader","attr_writer","then","case","when","and","or","not","super","puts","lambda","proc","__method__"],
  php: ["function","class","public","private","protected","static","return","if","else","elseif","foreach","for","while","do","switch","case","default","break","continue","new","echo","print","require","include","require_once","include_once","namespace","use","extends","implements","interface","trait","try","catch","finally","throw","null","true","false","as","instanceof","global","const","abstract","final","fn","match","enum","readonly"],
  kotlin: ["fun","val","var","class","object","interface","data","sealed","enum","companion","if","else","for","while","when","return","is","in","as","null","true","false","this","super","try","catch","finally","throw","import","package","private","public","internal","protected","override","open","abstract","suspend","lateinit","by","get","set","init","constructor","typealias","inline","reified","operator","vararg"],
  swift: ["func","let","var","class","struct","enum","protocol","extension","if","else","guard","for","while","repeat","switch","case","default","return","in","is","as","nil","true","false","self","Self","super","try","catch","throw","throws","import","public","private","internal","fileprivate","open","override","init","deinit","static","class","lazy","weak","unowned","where","associatedtype","typealias","some","any","async","await"],
  yaml: ["true","false","null","yes","no","on","off"],
  toml: ["true","false"],
  shell: ["if","then","else","elif","fi","for","while","until","do","done","case","esac","function","return","in","select","time","export","local","readonly","declare","exit","echo","source","alias","unset","shift","trap","eval","exec","set","cd","pushd","popd","jobs","bg","fg","wait","kill"],
  lua: ["function","local","if","then","else","elseif","end","for","while","do","return","break","repeat","until","and","or","not","nil","true","false","in","self","goto"],
  typescript: ["const","let","var","function","return","if","else","for","while","class","interface","type","enum","import","export","from","extends","implements","public","private","protected","static","async","await","new","this","super","try","catch","finally","throw","typeof","instanceof","in","of","default","switch","case","break","continue","do","yield","readonly","abstract","declare","namespace","as","is","keyof"],
  javascript: ["const","let","var","function","return","if","else","for","while","class","import","export","from","extends","async","await","new","this","super","try","catch","finally","throw","typeof","instanceof","in","of","default","switch","case","break","continue","do","yield"],
  python: ["def","class","return","if","elif","else","for","while","import","from","as","with","try","except","finally","raise","lambda","yield","pass","break","continue","global","in","is","not","and","or","async","await","self","None","True","False"],
  java: ["public","private","protected","static","final","abstract","class","interface","enum","extends","implements","import","package","return","if","else","for","while","do","switch","case","break","continue","try","catch","finally","throw","throws","new","this","super","void","int","long","double","float","boolean","null","true","false","synchronized","instanceof"],
};

let _inMultiLine = false;
let _inBlockComment = false;
const OVERSCAN = 20; // extra lines rendered above/below viewport

// Languages whose line comments start with # / // / --
const HASH_LANGS = new Set(["python", "ruby", "shell", "yaml", "toml"]);
const SLASH_LANGS = new Set(["typescript", "javascript", "tsx", "java", "rust", "go", "c", "cpp", "csharp", "php", "kotlin", "swift", "css", "scss", "less"]);
const MARKUP_LANGS = new Set(["html", "xml", "vue", "svelte"]);

function hl(line: string, lang: string): { text: string; cls: string }[] {
  const r: { text: string; cls: string }[] = [];
  const kws = KW[lang === "tsx" ? "typescript" : lang] || [];
  const trimmed = line.trimStart();
  const isHash = HASH_LANGS.has(lang);
  const isSlash = SLASH_LANGS.has(lang);
  const isLua = lang === "lua";

  // Markdown: headings, quotes, fences, inline code/bold
  if (lang === "markdown") {
    if (/^#{1,6}\s/.test(trimmed)) { r.push({ text: line, cls: "hl-type" }); return r; }
    if (trimmed.startsWith(">")) { r.push({ text: line, cls: "hl-cmt" }); return r; }
    if (/^(```|~~~)/.test(trimmed)) { r.push({ text: line, cls: "hl-str" }); return r; }
    const md = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*]+\*)|(\s+)|(.)/g;
    let mm: RegExpExecArray | null;
    while ((mm = md.exec(line)) !== null) {
      if (mm[1]) r.push({ text: mm[1], cls: "hl-kw" });
      else if (mm[2]) r.push({ text: mm[2], cls: "hl-str" });
      else if (mm[3]) r.push({ text: mm[3], cls: "hl-cmt" });
      else r.push({ text: mm[0], cls: "" });
    }
    return r;
  }

  // Markup: tag names, attributes, strings
  if (MARKUP_LANGS.has(lang)) {
    const tag = /(<\/?)|([A-Za-z_][\w:.-]*)(?==)|(\/?>)|("[^"]*"|'[^']*')|(\s+)|(.)/g;
    let tm: RegExpExecArray | null;
    let inTag = false;
    while ((tm = tag.exec(line)) !== null) {
      if (tm[1]) { inTag = true; r.push({ text: tm[1], cls: "" }); }
      else if (tm[2] && inTag) r.push({ text: tm[2], cls: "hl-type" });
      else if (tm[3]) { inTag = false; r.push({ text: tm[3], cls: "" }); }
      else if (tm[4] && inTag) r.push({ text: tm[4], cls: "hl-str" });
      else r.push({ text: tm[0], cls: "" });
    }
    return r;
  }
  
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

  // Block comment tracking (/* ... */ spanning lines, e.g. JSDoc / docblocks)
  if (_inBlockComment) {
    const end = line.indexOf("*/");
    if (end >= 0) {
      _inBlockComment = false;
      const commentPart = line.slice(0, end + 2);
      const rest = line.slice(end + 2);
      return [{ text: commentPart, cls: "hl-cmt" }, ...hl(rest, lang)];
    }
    r.push({ text: line, cls: "hl-cmt" });
    return r;
  }

  // Whole-line comment (# // or lua --)
  if ((isHash && trimmed.startsWith("#")) || (isSlash && trimmed.startsWith("//")) || (isLua && trimmed.startsWith("--"))) {
    r.push({ text: line, cls: "hl-cmt" });
    return r;
  }
  
  // Find first comment start (# // /*) outside strings
  let commentStart = -1;
  let blockStart = -1;
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) { if (ch === inStr && line[i-1] !== "\\") inStr = null; }
    else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (isHash && ch === "#") { commentStart = i; break; }
    else if (isLua && ch === "-" && line[i+1] === "-") { commentStart = i; break; }
    else if (isSlash && ch === "/" && line[i+1] === "/") { commentStart = i; break; }
    else if (isSlash && ch === "/" && line[i+1] === "*") { blockStart = i; break; }
  }
  
  // Block comment starts on this line
  if (blockStart >= 0 && commentStart < 0) {
    const end = line.indexOf("*/", blockStart + 2);
    const before = line.slice(0, blockStart);
    if (end >= 0) {
      // Single-line block comment: /* ... */
      const comment = line.slice(blockStart, end + 2);
      const after = line.slice(end + 2);
      return [...hl(before, lang), { text: comment, cls: "hl-cmt" }, ...hl(after, lang)];
    }
    _inBlockComment = true;
    const comment = line.slice(blockStart);
    return [...hl(before, lang), { text: comment, cls: "hl-cmt" }];
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exact identifier-boundary matching: highlights whole words only (IDEA-like occurrence marking).
function exactIdentifierRegex(word: string): RegExp | null {
  if (!word) return null;
  try {
    return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(word)}(?![A-Za-z0-9_$])`, "g");
  } catch {
    return null;
  }
}

function normPath(p?: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
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
function dedupeWorkspaces(list: Array<{root:string;name:string}>): Array<{root:string;name:string}> {
  const seen = new Set<string>();
  return (list || []).filter(w => {
    const key = normPath(w.root);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function DiffView({ diffText, path, onOpenFile }: { diffText: string; path: string; onOpenFile?: (line: number) => void }) {
  const parsed = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const marksByHunk = useMemo(
    () => parsed.hunks.map(h => hunkWordMarks(h.lines)),
    [parsed]
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [hunkIdx, setHunkIdx] = useState(0);
  const hunkCount = parsed.hunks.length;

  useEffect(() => { setHunkIdx(0); }, [diffText]);

  const jumpHunk = useCallback((dir: number) => {
    if (hunkCount === 0) return;
    setHunkIdx(prev => {
      const next = (prev + dir + hunkCount) % hunkCount;
      containerRef.current?.querySelector<HTMLElement>(`[data-hunk="${next}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return next;
    });
  }, [hunkCount]);

  // Alt+Up / Alt+Down: walk hunks while the diff is on screen (IDEA style)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowDown") { e.preventDefault(); jumpHunk(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); jumpHunk(-1); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [jumpHunk]);

  if (parsed.binary) {
    return <div className="ref-popup-empty">二进制文件，无法显示差异</div>;
  }

  const firstNewLine = parsed.hunks[0]?.lines.find(l => l.newNo !== null)?.newNo ?? 1;

  return (
    <div className="dv">
      <div className="dv-file-bar">
        <span className="dv-file-path" title={path}>{path}</span>
        <span className="dv-stats">
          <b className="dv-add">+{parsed.additions}</b>
          <b className="dv-del">-{parsed.deletions}</b>
        </span>
        {hunkCount > 1 && (
          <span className="dv-hunk-nav">
            <button title="上一处修改 (Alt+↑)" onClick={() => jumpHunk(-1)}>▲</button>
            <span>{hunkIdx + 1}/{hunkCount}</span>
            <button title="下一处修改 (Alt+↓)" onClick={() => jumpHunk(1)}>▼</button>
          </span>
        )}
        {onOpenFile && (
          <button className="dv-open" title="在阅读视图中打开" onClick={() => onOpenFile(firstNewLine)}>打开文件</button>
        )}
      </div>
      <div className="dv-body" ref={containerRef}>
        {parsed.hunks.length === 0 && <div className="ref-popup-empty">无差异</div>}
        {parsed.hunks.map((hunk, hi) => (
          <div key={hi} data-hunk={hi}>
            <button className="dv-hunk" title="跳转到此处" onClick={() => { setHunkIdx(hi); onOpenFile?.(hunk.lines.find(l => l.newNo !== null)?.newNo ?? 1); }}>
              {hunk.header}
            </button>
            {hunk.lines.map((line, li) => (
              <div key={li} className={`dv-line dv-${line.type}`}>
                <span className="dv-no">{line.oldNo ?? ""}</span>
                <span className="dv-no">{line.newNo ?? ""}</span>
                <span className="dv-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
                <span className="dv-code">
                  {renderMarkedLine(line.content, langOfPath(path), marksByHunk[hi].get(li))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
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
  const [occurrenceIdx, setOccurrenceIdx] = useState(0);
  const [goLineOpen, setGoLineOpen] = useState(false);
  const [goLineVal, setGoLineVal] = useState("");
  const [matchLines, setMatchLines] = useState<number[]>([]);
  const codeRef = useRef<HTMLPreElement>(null);
  const lastJumpKeyRef = useRef("");
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("lr-theme") === "dark");
  const [gitOpen, setGitOpen] = useState(false);
  const [gitError, setGitError] = useState("");
  const [gitTab, setGitTab] = useState<"history" | "working">("history");
  const [workingFiles, setWorkingFiles] = useState<GitFileChange[]>([]);
  const [workingSel, setWorkingSel] = useState("");
  const [workingDiff, setWorkingDiff] = useState("");
  const [workingLoading, setWorkingLoading] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitDetailLoading, setGitDetailLoading] = useState(false);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitBranches, setGitBranches] = useState<GitBranch[]>([]);
  const [gitBranch, setGitBranch] = useState("");
  const [gitAllBranches, setGitAllBranches] = useState(false);
  const [gitQuery, setGitQuery] = useState("");
  const [gitAuthor, setGitAuthor] = useState("");
  const [gitDateRange, setGitDateRange] = useState("all");
  const [gitPath, setGitPath] = useState("");
  const [gitSelected, setGitSelected] = useState("");
  const [gitDetail, setGitDetail] = useState<GitCommitDetail | null>(null);
  const [gitFile, setGitFile] = useState("");
  const [gitDiff, setGitDiff] = useState("");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [frOpen, setFrOpen] = useState(false);
  const [frFind, setFrFind] = useState("");
  const [frReplace, setFrReplace] = useState("");
  const [frCase, setFrCase] = useState(false);
  const [outlineVisible, setOutlineVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [topSearch, setTopSearch] = useState("");
  const [topResults, setTopResults] = useState<string[]>([]);
  const [topSearchOpen, setTopSearchOpen] = useState(false);
  const [outlineGroupOpen, setOutlineGroupOpen] = useState<Set<string>>(new Set(["imports", "classes", "functions", "constants", "types"]));
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<SRes["results"]>([]);
  const [focus, setFocus] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wsList, setWsList] = useState<Array<{root:string;name:string}>>(() => { try { return dedupeWorkspaces(JSON.parse(localStorage.getItem("lr-ws-list") ?? "[]")); } catch { return []; } });
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
  const [prefs, setPrefs] = useState<Prefs>(readPrefs);
  const [lspCmds, setLspCmds] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("lr-lsp-cmds") ?? "{}"); } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem("lr-lsp-cmds", JSON.stringify(lspCmds)); }, [lspCmds]);
  const setPref = useCallback(<K extends keyof Prefs>(key: K, value: Prefs[K]) => setPrefs(prev => ({ ...prev, [key]: value })), []);
  const codeLineH = Math.round(codeFontSize * prefs.lineSpacing);
  const editLines = useMemo(() => {
    if (!doc) return [];
    return editContent.split("\n").map(line => ({ tokens: hl(line, doc.language) }));
  }, [editContent, doc]);
  const editHlRef = useRef<HTMLPreElement>(null);
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
  // Latest expanded-dirs snapshot for the debounced files_changed reloader
  const expandedRef = useRef<Record<string, N[]>>({});
  expandedRef.current = expanded;
  const reloadTimerRef = useRef<number | null>(null);
  const [navHistory, setNavHistory] = useState<NavHistoryEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const navHistoryRef = useRef<NavHistoryEntry[]>([]);
  const navIndexRef = useRef(-1);
  const navigatingRef = useRef(false);
  const gitFilterInit = useRef(false);

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
      if (e.key === "Escape") { setQuickOpen(false); setFileSearchVisible(false); setFileSearch(""); setMatchIdx(0); setRefPopup(null); setSymOpen(false); setSearchModalOpen(false); setGitOpen(false); setSettingsOpen(false); setTopSearchOpen(false); setGoLineOpen(false); }
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

  // Toolbar quick search (Ctrl+P style)
  useEffect(() => {
    if (!topSearchOpen || !ws) return;
    const timer = setTimeout(async () => {
      try { setTopResults(await call<string[]>("fuzzy_files", { workspaceId: ws.id, query: topSearch.trim(), limit: 12 })); } catch { setTopResults([]); }
    }, 100);
    return () => clearTimeout(timer);
  }, [topSearch, topSearchOpen, ws]);

  const changeCodeLanguage = useCallback((next: string) => {
    setDoc(prev => prev ? { ...prev, language: next } : prev);
    setTabs(prev => prev.map((tb, i) => i === activeTab ? { ...tb, lang: next } : tb));
  }, [activeTab]);

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
    // Reload expanded dirs, git badges and the active doc after file changes.
    const reloadNow = async () => {
      // Reload every currently expanded directory, not just the workspace root,
      // otherwise newly created files in an open folder never appear.
      const next: Record<string, N[]> = {};
      try { next[""] = await call<N[]>("file_tree", { workspaceId: ws.id }); } catch {}
      for (const dir of Object.keys(expandedRef.current).filter(d => d)) {
        try { next[dir] = await call<N[]>("file_tree", { workspaceId: ws.id, path: dir }); } catch {}
      }
      setExpanded(prev => ({ ...next, ...(Object.keys(prev).length ? {} : prev) }));
      // Keep file-tree git badges in sync with the working tree
      try { setWorkingFiles(await call<GitFileChange[]>("git_working_changes", { workspaceId: ws.id })); } catch { setWorkingFiles([]); }
      if (activeTabRef.current) {
        try {
          const d = await call<Doc>("file_read", { workspaceId: ws.id, path: activeTabRef.current });
          // Same content -> keep the old doc object so the scroll position
          // and derived memos are untouched.
          setDoc(prev => (prev && prev.path === d.path && prev.content === d.content ? prev : d));
        } catch {}
      }
    };
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
      // Watcher events arrive in bursts (builds, LSP, saves); coalesce them.
      unsubs.push(await listen<string>("files_changed", () => {
        if (reloadTimerRef.current !== null) clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = setTimeout(() => { reloadTimerRef.current = null; reloadNow(); }, 600);
      }));
      unsubs.push(await listen<{ indexedFiles: number }>("index_progress", (ev) => {
        if (ev.payload?.indexedFiles !== undefined) {
          setStatus(`${ws.name} · ${ev.payload.indexedFiles} indexed`);
        }
      }));
    };
    setup();
    return () => {
      unsubs.forEach(fn => { try { fn(); } catch {} });
      if (reloadTimerRef.current !== null) clearTimeout(reloadTimerRef.current);
    };
  }, [ws]);


  const openWorkspace = useCallback(async (root: string) => {
    setErr(null);
    try {
      const w = await call<Ws>("workspace_open", { root });
      setWs(w); setTabs([]); setActiveTab(0); setDoc(null); setSyms([]); setResults([]); setSearchQ(""); setRefs([]); setDefs([]);
      setTree([{ name: w.name, path: "", isDir: true }]); setExpanded({});
      try { const ch = await call<N[]>("file_tree", { workspaceId: w.id }); setExpanded({ "": ch }); } catch {}
      try { setWorkingFiles(await call<GitFileChange[]>("git_working_changes", { workspaceId: w.id })); } catch { setWorkingFiles([]); }
      setFoldedLines(new Set()); setHighlightWord(""); setCurrentLine(0); setJumpTarget(null);
      setStatus(`${w.name} · ${w.indexedFiles} indexed`);
      setWsList(prev => {
        const exists = prev.some(x => normPath(x.root) === normPath(root));
        const next = exists ? prev : dedupeWorkspaces([{ root, name: w.name }, ...prev]);
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
  useEffect(() => { localStorage.setItem("lr-prefs", JSON.stringify(prefs)); }, [prefs]);
  
  // Dark mode
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("lr-theme", dark ? "dark" : "light");
  }, [dark]);
  
  
  // Drag-drop folder import
  useEffect(() => {
    let un: (() => void) | undefined;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      getCurrentWebview().onDragDropEvent((ev: any) => {
        if (ev.payload?.type === "drop" && ev.payload.paths?.[0]) {
          openWorkspace(ev.payload.paths[0]);
        }
      }).then(fn => { un = fn; });
    });
    return () => { un?.(); };
  }, [openWorkspace]);
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
          setDoc(d); _inMultiLine = false; _inBlockComment = false;
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
  const gitGraph = useMemo(() => computeGitGraph(gitCommits), [gitCommits]);
  const gitAuthors = useMemo(() => [...new Set(gitCommits.map(c => c.authorName).filter(Boolean))].sort((a,b)=>a.localeCompare(b)), [gitCommits]);
  // IDEA-style "scroll from source": expand the file's parent chain in the
  // lazy tree and scroll the row into view after opening a file.
  const ensureTreeReveal = useCallback(async (path: string) => {
    if (!ws) return;
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    let changed = false;
    const next = { ...expandedRef.current };
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!next[cur]) {
        try { next[cur] = await call<N[]>("file_tree", { workspaceId: ws.id, path: cur }); changed = true; } catch { return; }
      }
    }
    if (changed) setExpanded(next);
    setTimeout(() => {
      document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, 120);
  }, [ws]);

  const openFile = useCallback(async (path: string, targetLine?: number, options?: { fromHistory?: boolean }) => {
    if (!ws) return;
    const sameFile = activeTabData?.path === path;
    const target = targetLine ?? (sameFile ? (currentLine || 1) : 1);
    try {
      setErr(null); setStatus(`Loading...`);
      const d = await call<Doc>("file_read", { workspaceId: ws.id, path });
      setDoc(d); setRefs([]); setDefs([]); setFileSearch(""); setFileSearchVisible(false); setCursor({line:target,col:1}); setCurrentLine(target); _inMultiLine = false; _inBlockComment = false; setEditing(false); if (!sameFile) setHighlightWord(""); setOccurrenceIdx(0);
      const name = path.split("/").pop() || path;
      setTabs(prev => {
        if (prev.some(tb => tb.path === path)) return prev;
        return [...prev, { path, name, lang: d.language }];
      });
      const existingIdx = tabs.findIndex(tb => tb.path === path);
      setActiveTab(existingIdx >= 0 ? existingIdx : tabs.length);
      try { setSyms(await call<Sym[]>("outline", { workspaceId: ws.id, path })); } catch { setSyms([]); }
      setStatus(`${path} · ${d.language}`);
      setJumpTarget({ path, line: target });
      ensureTreeReveal(path).catch(() => {});

      if (!options?.fromHistory) {
        const previous: NavHistoryEntry | undefined = activeTabData?.path
          ? { path: activeTabData.path, line: currentLine || 1 }
          : undefined;
        let stack = [...navHistoryRef.current];
        let index = navIndexRef.current;
        if (index < 0) {
          stack = previous ? [previous] : [];
          index = previous ? 0 : -1;
        } else if (previous && stack[index]?.path === previous.path) {
          stack[index] = previous;
        }
        const top = stack[index];
        if (!top || top.path !== path || top.line !== target) {
          stack = stack.slice(0, index + 1);
          stack.push({ path, line: target });
          index = stack.length - 1;
        }
        if (stack.length > 300) stack = stack.slice(stack.length - 300);
        navHistoryRef.current = stack;
        navIndexRef.current = index;
        setNavHistory(stack);
        setNavIndex(index);
      }
    } catch (e) { const m = String(e); setErr(m); setStatus(`ERR: ${m}`); }
  }, [ws, tabs, activeTabData, currentLine, navHistoryRef, navIndexRef, ensureTreeReveal]);

  const navigateHistory = useCallback(async (direction: "back" | "forward") => {
    const stack = navHistoryRef.current;
    const currentIndex = navIndexRef.current;
    const targetIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1;
    const target = stack[targetIndex];
    if (!target) return;

    // Preserve the exact line that is leaving before moving through history.
    const current = stack[currentIndex];
    if (current && activeTabData?.path === current.path) {
      stack[currentIndex] = { path: current.path, line: currentLine || 1 };
      navHistoryRef.current = stack;
    }

    navigatingRef.current = true;
    navIndexRef.current = targetIndex;
    setNavIndex(targetIndex);
    try {
      await openFile(target.path, target.line, { fromHistory: true });
    } finally {
      setTimeout(() => { navigatingRef.current = false; }, 120);
    }
  }, [activeTabData, currentLine, openFile]);

  // History is workspace-local.
  useEffect(() => {
    navHistoryRef.current = [];
    navIndexRef.current = -1;
    setNavHistory([]);
    setNavIndex(-1);
  }, [ws?.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); navigateHistory("back"); }
      if (e.key === "ArrowRight") { e.preventDefault(); navigateHistory("forward"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigateHistory]);

  const switchTab = useCallback(async (idx: number) => {
    if (!ws || !tabs[idx]) return;
    setActiveTab(idx);
    try {
      const d = await call<Doc>("file_read", { workspaceId: ws.id, path: tabs[idx].path });
      setDoc(d); setEditing(false);
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

  // Tab + navigation keyboard handling (browser-standard muscle memory)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        if (tabs.length === 0) return;
        const next = (activeTab + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        switchTab(next);
      } else if (e.ctrlKey && (e.key === "w" || e.key === "W")) {
        e.preventDefault();
        if (tabs.length > 0) closeTab(activeTab);
      } else if (e.ctrlKey && !e.shiftKey && (e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (activeTabData?.path) { setGoLineOpen(true); setGoLineVal(""); }
      } else if (e.ctrlKey && e.shiftKey && (e.key === "C" || e.key === "c")) {
        e.preventDefault();
        if (activeTabData?.path) {
          navigator.clipboard.writeText(activeTabData.path).then(
            () => setStatus(lang === "zh" ? "已复制路径" : "Path copied"),
            () => {});
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs, activeTab, switchTab, closeTab, activeTabData, lang]);



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
  
  const startEdit = useCallback(() => { if (doc) { setEditContent(doc.content); setEditing(true); } }, [doc]);
  const cancelEdit = useCallback(() => setEditing(false), []);
  const saveEdit = useCallback(async () => {
    if (!ws || !activeTabData?.path || !editing) return;
    try {
      await call("file_write", { workspaceId: ws.id, path: activeTabData.path, content: editContent });
      setEditing(false);
      setStatus(`已保存 ${activeTabData.path}`);
      const d = await call<Doc>("file_read", { workspaceId: ws.id, path: activeTabData.path });
      setDoc(d); _inMultiLine = false; _inBlockComment = false;
      try { setSyms(await call<Sym[]>("outline", { workspaceId: ws.id, path: activeTabData.path })); } catch {}
    } catch (e) { setStatus(`保存失败: ${e}`); }
  }, [ws, activeTabData, editing, editContent]);
  const frMatches = useMemo(() => {
    if (!frOpen || !frFind) return [] as number[];
    const hay = frCase ? editContent : editContent.toLowerCase();
    const needle = frCase ? frFind : frFind.toLowerCase();
    const arr: number[] = [];
    let i = hay.indexOf(needle);
    while (i >= 0) { arr.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
    return arr;
  }, [frOpen, frFind, frCase, editContent]);
  const frSelect = useCallback((idx: number) => {
    const ta = document.querySelector<HTMLTextAreaElement>(".code-edit");
    if (!ta || frMatches.length === 0) return;
    const i = ((idx % frMatches.length) + frMatches.length) % frMatches.length;
    ta.focus();
    ta.setSelectionRange(frMatches[i], frMatches[i] + frFind.length);
  }, [frMatches, frFind]);
  const frReplaceOne = useCallback(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(".code-edit");
    if (!ta || frMatches.length === 0 || !frFind) return;
    const from = ta.selectionEnd;
    let at = frMatches.findIndex(p => p >= from);
    if (at < 0) at = 0;
    const pos = frMatches[at];
    setEditContent(v => v.slice(0, pos) + frReplace + v.slice(pos + frFind.length));
    requestAnimationFrame(() => ta.setSelectionRange(pos, pos + frReplace.length));
  }, [frMatches, frFind, frReplace]);
  const frReplaceAll = useCallback(() => {
    if (!frFind) return;
    const re = new RegExp(frFind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), frCase ? "g" : "gi");
    setEditContent(v => v.replace(re, frReplace));
  }, [frFind, frReplace, frCase]);

  // Ctrl+S save while editing
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (editing && e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveEdit(); }
      if (editing && e.ctrlKey && e.key.toLowerCase() === "h") { e.preventDefault(); setFrOpen(v => !v); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [editing, saveEdit]);
  
  const gitSince = useCallback(() => {
    if (gitDateRange === "all") return "";
    const now = new Date();
    const days = gitDateRange === "today" ? 0 : gitDateRange === "7" ? 7 : gitDateRange === "30" ? 30 : 365;
    const date = new Date(now);
    if (gitDateRange === "today") date.setHours(0, 0, 0, 0); else date.setDate(date.getDate() - days);
    return date.toISOString();
  }, [gitDateRange]);

  const loadCommitDetail = useCallback(async (hash: string, selectFile?: string) => {
    if (!ws || !hash) return;
    setGitDetailLoading(true); setGitError("");
    try {
      const detail = await call<GitCommitDetail>("git_commit_detail", { workspaceId: ws.id, hash });
      setGitDetail(detail); setGitFile(""); setGitDiff("");
      if (selectFile || detail.files.length > 0) {
        const path = selectFile || detail.files[0].path;
        setGitFile(path);
        setGitDiff(await call<string>("git_commit_file_diff", { workspaceId: ws.id, hash, path }));
      }
    } catch (e) { setGitError(String(e)); setGitDetail(null); }
    finally { setGitDetailLoading(false); }
  }, [ws]);

  const loadGitLog = useCallback(async (autoSelect = true) => {
    if (!ws) return;
    setGitLoading(true); setGitError("");
    try {
      const options = {
        query: gitQuery, branch: gitAllBranches ? "" : gitBranch,
        author: gitAuthor, since: gitSince(), until: "", path: gitPath,
        allBranches: gitAllBranches, limit: 300,
      };
      const commits = await call<GitCommit[]>("git_log", { workspaceId: ws.id, options });
      setGitCommits(commits);
      if (autoSelect) {
        const first = commits[0];
        if (first) { setGitSelected(first.hash); await loadCommitDetail(first.hash); }
        else { setGitSelected(""); setGitDetail(null); setGitFile(""); setGitDiff(""); }
      }
    } catch (e) { setGitError(String(e)); setGitCommits([]); setGitDetail(null); }
    finally { setGitLoading(false); }
  }, [ws, gitQuery, gitBranch, gitAllBranches, gitAuthor, gitPath, gitSince, loadCommitDetail]);

  const loadGitBranches = useCallback(async () => {
    if (!ws) return;
    try { setGitBranches(await call<GitBranch[]>("git_branches", { workspaceId: ws.id })); } catch (e) { setGitError(String(e)); }
  }, [ws]);

  const openGit = useCallback(async () => {
    setGitOpen(true); setGitError(""); setGitCommits([]); setGitDetail(null); setGitFile(""); setGitDiff(""); setGitTab("history");
    if (!ws) return;
    await loadGitBranches();
    await loadGitLog(true);
  }, [ws, loadGitBranches, loadGitLog]);

  const showCommitFileDiff = useCallback(async (path: string) => {
    if (!ws || !gitSelected) return;
    setGitFile(path); setGitError("");
    try { setGitDiff(await call<string>("git_commit_file_diff", { workspaceId: ws.id, hash: gitSelected, path })); }
    catch (e) { setGitDiff(String(e)); setGitError(String(e)); }
  }, [ws, gitSelected]);

  const loadWorkingChanges = useCallback(async () => {
    if (!ws) return;
    setWorkingLoading(true); setGitError("");
    try {
      const files = await call<GitFileChange[]>("git_working_changes", { workspaceId: ws.id });
      setWorkingFiles(files);
      setWorkingSel(""); setWorkingDiff("");
      const first = files[0];
      if (first) {
        setWorkingSel(first.path);
        setWorkingDiff(await call<string>("git_working_diff", { workspaceId: ws.id, path: first.path }));
      }
    } catch (e) { setGitError(String(e)); setWorkingFiles([]); }
    finally { setWorkingLoading(false); }
  }, [ws]);

  const openReview = useCallback(() => {
    setGitOpen(true); setGitError(""); setGitTab("working"); loadWorkingChanges();
  }, [loadWorkingChanges]);

  const showWorkingDiff = useCallback(async (path: string) => {
    if (!ws) return;
    setWorkingSel(path); setGitError("");
    try { setWorkingDiff(await call<string>("git_working_diff", { workspaceId: ws.id, path })); }
    catch (e) { setWorkingDiff(String(e)); setGitError(String(e)); }
  }, [ws]);

  useEffect(() => {
    if (!gitOpen) { gitFilterInit.current = false; return; }
    if (!gitFilterInit.current) { gitFilterInit.current = true; return; }
    const timer = setTimeout(() => { loadGitLog(true); }, 320);
    return () => clearTimeout(timer);
  }, [gitOpen, gitQuery, gitBranch, gitAllBranches, gitAuthor, gitDateRange, gitPath, loadGitLog]);

  const dirOf = (p?: string) => (p && p.includes("/")) ? p.slice(0, p.lastIndexOf("/")) : "";
  const baseOf = (p: string) => p.split("/").pop() || p;
  const refreshTreeDir = useCallback(async (dir: string, delayMs = 0) => {
    if (!ws) return;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    const ch = dir ? await call<N[]>("file_tree", { workspaceId: ws.id, path: dir }) : await call<N[]>("file_tree", { workspaceId: ws.id });
    setExpanded(p => ({ ...p, [dir]: ch }));
  }, [ws]);

  const createFile = useCallback(async () => {
    if (!ws || !newFileName.trim()) return;
    const dir = dirOf(activeTabData?.path);
    const path = (dir ? dir + "/" : "") + newFileName.trim();
    try {
      await call("file_create", { workspaceId: ws.id, path, content: "" });
      setNewFileOpen(false); setNewFileName("");
      try { await refreshTreeDir(dir); setTimeout(() => { refreshTreeDir(dir).catch(() => {}); }, 500); } catch {}
      openFile(path);
    } catch (e) { setStatus(String(e)); }
  }, [ws, newFileName, activeTabData, openFile, refreshTreeDir]);
  const deleteFile = useCallback(async (path: string) => {
    if (!ws) return;
    try {
      await call("file_delete", { workspaceId: ws.id, path });
      setTabs(prev => {
        const idx = prev.findIndex(t => t.path === path);
        if (idx >= 0) closeTab(idx);
        return prev;
      });
      {
        const dir = dirOf(path);
        try { await refreshTreeDir(dir); setTimeout(() => { refreshTreeDir(dir).catch(() => {}); }, 500); } catch {}
      }
      setStatus(`已删除 ${path}`);
    } catch (e) { setStatus(String(e)); }
  }, [ws, closeTab, dirOf, refreshTreeDir]);
  const commitRename = useCallback(async () => {
    if (!ws || !renamingPath || !renameVal.trim()) { setRenamingPath(null); return; }
    const dir = dirOf(renamingPath);
    const newPath = (dir ? dir + "/" : "") + renameVal.trim();
    try {
      await call("file_rename", { workspaceId: ws.id, oldPath: renamingPath, newPath });
      setTabs(prev => prev.map(t => t.path === renamingPath ? { ...t, path: newPath, name: baseOf(newPath) } : t));
      {
        const dir = dirOf(newPath);
        try { await refreshTreeDir(dir); setTimeout(() => { refreshTreeDir(dir).catch(() => {}); }, 500); } catch {}
      }
      if (doc?.path === renamingPath) openFile(newPath);
      setStatus(`已重命名 ${renamingPath} → ${newPath}`);
    } catch (e) { setStatus(String(e)); }
    setRenamingPath(null);
  }, [ws, renamingPath, renameVal, doc, openFile, dirOf, refreshTreeDir]);
  
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
    setHighlightWord(word); setOccurrenceIdx(0);

    // LSP server command override for this file's language (empty = auto-detect)
    const lspCommand = (): string | undefined => {
      try {
        const m = JSON.parse(localStorage.getItem("lr-lsp-cmds") ?? "{}");
        const v = m[doc.language];
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
      } catch { return undefined; }
    };

    // Ctrl+Alt+Click: Find Usages (IDEA style) — LSP first, static index fallback
    if (e.ctrlKey && e.altKey) {
      e.preventDefault();
      let targets: NavTarget[] | null = null;
      if (prefs.lspEnabled) {
        try {
          targets = await call<NavTarget[]>("lsp_references", {
            workspaceId: ws.id, path: activeTabData.path, line: lineIdx, column: charIdx,
            command: lspCommand(), name: word,
          });
        } catch { targets = null; }
      }
      if (!targets || targets.length === 0) {
        try {
          targets = await call<NavTarget[]>("find_references", { workspaceId: ws.id, name: word });
        } catch (err) {
          setStatus(lang === "zh" ? `引用查找失败：${err}` : `Find references failed: ${err}`);
          return;
        }
      }
      setRefPopup({ x: e.clientX, y: e.clientY, name: word, targets });
      return;
    }

    // Ctrl+Click / Cmd+Click: Go to Definition (IDEA style) — LSP first, static index fallback
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      let lspTargets: NavTarget[] | null = null;
      if (prefs.lspEnabled) {
        try {
          lspTargets = await call<NavTarget[]>("lsp_definition", {
            workspaceId: ws.id, path: activeTabData.path, line: lineIdx, column: charIdx,
            command: lspCommand(), name: word,
          });
        } catch { lspTargets = null; }
      }
      try {
        const targets = lspTargets && lspTargets.length > 0
          ? lspTargets
          : await call<NavTarget[]>("goto_definition", { workspaceId: ws.id, name: word, currentPath: activeTabData.path });
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
  }, [ws, activeTabData, doc, openFile, getWordAtClick, lang, prefs]);

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

  const toggleOutline = useCallback((key: string) => {
    setOutlineOpen(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  
  const outlineSymbolLabel = (sym: Sym) => {
    if (sym.kind !== "import") return sym.name;
    return sym.name
      .replace(/^import\s+/, "")
      .replace(/\s+from\s+/, " ← ")
      .replace(/^from\s+/, "← ")
      .replace(/^import\s+/, "")
      .slice(0, 160);
  };

  const renderOutlineSym = (node: SymNode, depth: number): React.ReactNode => {
    const s = node.sym;
    const key = `${s.path}:${s.startLine}:${s.name}`;
    const hasChildren = node.children.length > 0;
    const isOpen = outlineOpen.has(key);
    return (
      <div key={key}>
        <div className="sym-row" style={{ paddingLeft: 8 + depth * 14 }}
          onClick={(e) => { if (hasChildren && (e.target as HTMLElement).classList.contains("outline-arrow")) { e.stopPropagation(); toggleOutline(key); } else { openFile(activeTabData?.path || "", s.startLine + 1); setHighlightWord(s.name); setOccurrenceIdx(0); setCurrentLine(s.startLine + 1); } }}
          onContextMenu={(e) => { e.preventDefault(); findRefs(s.name); }}
          title={`${s.kind} · Click: jump · Click arrow: expand/collapse · Right-click: find refs`}>
          <span className={`outline-arrow ${hasChildren ? (isOpen ? "open" : "") : "leaf"}`}>{hasChildren ? (isOpen ? "▾" : "▸") : ""}</span>
          <span className={`sym-dot dot-${s.kind}`} />{outlineSymbolLabel(s)}
          <span className="sym-line">{s.startLine + 1}</span>
        </div>
        {hasChildren && isOpen && node.children.map(c => renderOutlineSym(c, depth + 1))}
      </div>
    );
  };
  
  const renderTree = (nodes: N[], depth: number) => nodes.map(n => {
    const active = doc?.path === n.path;
    if (renamingPath === n.path) {
      return (
        <div key={n.path} className="tree-row renaming" style={{ paddingLeft: 8 + depth * 16 }}>
          <input autoFocus className="rename-input" value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingPath(null); }}
            onBlur={commitRename} spellCheck={false} />
        </div>
      );
    }
    return (
    <div key={n.path || n.name}>
      <button data-path={n.path} className={`tree-row ${activeTabData?.path === n.path && !n.isDir ? "tree-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => n.isDir ? loadDir(n.path) : openFile(n.path)}>
        <span className="tree-icon">{n.isDir ? (expanded[n.path] ? "▾" : "▸") : "•"}</span>
        <span className="tree-name">{n.name}</span>
        {!n.isDir && gitStatusByPath.get(n.path) && (
          <span className={`git-status st-${gitStatusByPath.get(n.path)}`} title="未提交修改">{gitStatusByPath.get(n.path)}</span>
        )}
        {n.isDir && gitDirsWithChanges.has(n.path) && (
          <span className="git-dir-dot" title="包含未提交修改">●</span>
        )}
      </button>
      {active && (
        <div className="row-ops">
          <button className="row-op" title="重命名" onClick={(e) => { e.stopPropagation(); setRenamingPath(n.path); setRenameVal(n.name); }}>✎</button>
          <button className="row-op danger" title="删除" onClick={(e) => { e.stopPropagation(); if (confirm(`删除 ${n.path}?`)) deleteFile(n.path); }}>🗑</button>
        </div>
      )}
      {expanded[n.path]?.map(c => renderTree([c], depth + 1))}
    </div>
  ); });

  const symTree = useMemo(() => buildSymTree(syms), [syms]);

  // File-tree git badges: changed file -> status letter, plus dirs containing changes
  const gitStatusByPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of workingFiles) m.set(f.path, (f.status || "M")[0].toUpperCase());
    return m;
  }, [workingFiles]);
  const gitDirsWithChanges = useMemo(() => {
    const s = new Set<string>();
    for (const p of gitStatusByPath.keys()) {
      const parts = p.split("/");
      parts.pop();
      let cur = "";
      for (const part of parts) { cur = cur ? `${cur}/${part}` : part; s.add(cur); }
    }
    return s;
  }, [gitStatusByPath]);
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

  const outlineGroups = useMemo(() => {
    const pick = (pred: (kind: string) => boolean) => filteredSymTree.filter(n => pred(n.sym.kind));
    const groups = [
      { id: "imports", en: "Imports", zh: "导入", icon: "I", nodes: pick(k => k === "import") },
      { id: "classes", en: "Classes", zh: "类", icon: "C", nodes: pick(k => k === "class" || k === "interface") },
      { id: "functions", en: "Functions", zh: "函数", icon: "ƒ", nodes: pick(k => k === "function" || k === "method") },
      { id: "constants", en: "Constants", zh: "常量", icon: "K", nodes: pick(k => k === "constant" || k === "variable") },
      { id: "types", en: "Types", zh: "类型", icon: "T", nodes: pick(k => k === "type") },
    ];
    return groups.filter(g => g.nodes.length > 0);
  }, [filteredSymTree]);
  
  // Preserve user-expanded symbols when a document reloads after save.

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

  // Exact identifier occurrences of the clicked word in the current file (for count + rendering)
  const highlightOccurrences = useMemo(() => {
    const empty = { count: 0, lines: new Set<number>() };
    if (!doc || !highlightWord) return empty;
    const re = exactIdentifierRegex(highlightWord);
    if (!re) return empty;
    const lines = new Set<number>();
    let count = 0;
    for (let i = 0; i < codeLines.length; i++) {
      const m = codeLines[i].raw.match(re);
      if (m?.length) { count += m.length; lines.add(i + 1); }
    }
    return { count, lines };
  }, [doc, highlightWord, codeLines]);

  // Shared token renderer: exact-boundary highlight of highlightWord inside any token
  const renderToken = useCallback((tk: { text: string; cls: string }, j: number) => {
    const plain = tk.cls ? <span key={j} className={tk.cls}>{tk.text}</span> : <span key={j}>{tk.text}</span>;
    const re = exactIdentifierRegex(highlightWord);
    if (!re) return plain;
    re.lastIndex = 0;
    const pieces: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tk.text)) !== null) {
      if (m.index > last) pieces.push(tk.text.slice(last, m.index));
      pieces.push(<span className="sym-hl" key={`hl-${m.index}`}>{m[0]}</span>);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < tk.text.length) pieces.push(tk.text.slice(last));
    if (pieces.length === 0) return plain;
    return <span key={j} className={tk.cls || undefined}>{pieces}</span>;
  }, [highlightWord]);

  // F3 / Shift+F3: cycle between exact occurrences of the clicked word (IDEA-style)
  const occLines = useMemo(() => [...highlightOccurrences.lines].sort((a, b) => a - b), [highlightOccurrences]);
  const goOccurrence = useCallback((dir: number) => {
    if (occLines.length === 0) return;
    let next = occurrenceIdx + dir;
    if (next < 0) next = occLines.length - 1;
    if (next >= occLines.length) next = 0;
    setOccurrenceIdx(next);
    const targetLine = occLines[next];
    setCurrentLine(targetLine);
    setCursor({ line: targetLine, col: 1 });
    const codeEl = codeRef.current;
    if (codeEl) {
      if (isLargeFile) {
        codeEl.scrollTop = Math.max(0, (targetLine - 1) * codeLineH - codeEl.clientHeight / 2);
      } else {
        const lineEl = codeEl.querySelector(`.code-line:nth-child(${targetLine})`);
        if (lineEl) lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [occLines, occurrenceIdx, isLargeFile, codeLineH]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "F3") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (!highlightWord || occLines.length === 0) return;
      e.preventDefault();
      goOccurrence(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [highlightWord, occLines, goOccurrence]);

  const onCodeScroll = useCallback((e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight || 600);
  }, []);
    // Scroll to jump target when doc changes
  useEffect(() => {
    if (!jumpTarget || !doc || !codeRef.current) return;
    if (jumpTarget.path !== activeTabData?.path) return;
    // Only scroll when the target (file/line) actually changed. Reloads that
    // merely recreate the doc/codeLines objects must NOT yank the viewport.
    const key = `${doc.path}|${jumpTarget.line}`;
    if (lastJumpKeyRef.current === key) return;
    lastJumpKeyRef.current = key;
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
          <aside className="activity-rail">
            <button className="rail-item on" onClick={() => setFocus(false)} title="文件">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
              <span>文件</span>
            </button>
            <button className="rail-item" onClick={() => setSearchModalOpen(true)} title="搜索">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
              <span>搜索</span>
            </button>
            <button className={"rail-item " + (settingsOpen ? "on" : "")} onClick={() => setSettingsOpen(v => !v)} title="设置">
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              <span>设置</span>
            </button>
            {settingsOpen && (
              <>
                <div className="settings-overlay" onClick={() => setSettingsOpen(false)} />
                <div className="settings-panel">
                  <div className="settings-header">
                    <div>
                      <div className="settings-title">设置</div>
                      <div className="settings-subtitle">所有选项都会保存在本机</div>
                    </div>
                    <button className="icon-btn" onClick={() => setSettingsOpen(false)} title="关闭">✕</button>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">通用</div>
                    <div className="settings-row">
                      <div className="settings-label"><span>界面语言</span><small>菜单和状态文案</small></div>
                      <button className="settings-choice" onClick={() => setLang(v => v === "zh" ? "en" : "zh")}>{lang === "zh" ? "中文" : "English"}</button>
                    </div>
                    <div className="settings-row">
                      <div className="settings-label"><span>主题模式</span><small>亮色或暗色界面</small></div>
                      <div className="settings-segment">
                        <button className={!dark ? "on" : ""} onClick={() => setDark(false)}>亮色</button>
                        <button className={dark ? "on" : ""} onClick={() => setDark(true)}>暗色</button>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">代码阅读</div>
                    <div className="settings-row">
                      <div className="settings-label"><span>代码字号</span><small>也可以用 Ctrl + 滚轮调整</small></div>
                      <div className="settings-slider">
                        <input type="range" min="9" max="32" step="1" value={codeFontSize} onChange={e => setCodeFontSize(Number(e.target.value))} />
                        <span>{codeFontSize}px</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-label"><span>行间距</span><small>适合长时间阅读</small></div>
                      <div className="settings-slider">
                        <input type="range" min="1.4" max="2.2" step="0.1" value={prefs.lineSpacing} onChange={e => setPref("lineSpacing", Number(e.target.value))} />
                        <span>{prefs.lineSpacing.toFixed(1)}x</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-label"><span>代码字体</span><small>仅影响代码区域</small></div>
                      <select className="settings-select" value={prefs.codeFont} onChange={e => setPref("codeFont", e.target.value as Prefs["codeFont"])}>
                        <option value="default">默认</option>
                        <option value="consolas">Consolas</option>
                        <option value="jetbrains">JetBrains Mono</option>
                      </select>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">精确跳转 (LSP)</div>
                    <div className="settings-row">
                      <div className="settings-label"><span>语言服务器</span><small>检测到 LSP 时优先使用，失败自动回退到内置解析</small></div>
                      <div className="settings-segment">
                        <button className={!prefs.lspEnabled ? "on" : ""} onClick={() => setPref("lspEnabled", false)}>关闭</button>
                        <button className={prefs.lspEnabled ? "on" : ""} onClick={() => setPref("lspEnabled", true)}>开启</button>
                      </div>
                    </div>
                    {prefs.lspEnabled && (
                      <div className="settings-row">
                        <div className="settings-label"><span>服务器命令</span><small>留空自动检测（rust-analyzer / pyright / gopls / clangd…）</small></div>
                        <div className="lsp-cmd-grid">
                          {([["rust","Rust"],["python","Python"],["go","Go"],["c","C"],["cpp","C++"],["typescript","TypeScript"],["java","Java"]] as [string,string][]).map(([key, label]) => (
                            <label key={key} className="lsp-cmd-row">
                              <span>{label}</span>
                              <input value={lspCmds[key] || ""} placeholder="自动检测" spellCheck={false}
                                onChange={e => setLspCmds(prev => ({ ...prev, [key]: e.target.value }))} />
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                </div>
              </>
            )}
          </aside>
        )}
        {!focus && (
          <aside className="left" style={{ width: leftWidth, minWidth: 160, maxWidth: 500 }}>
            <div className="panel-hdr">
              <button className="panel-open-btn" onClick={openFolder} title="打开文件夹">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                <span>打开文件夹</span>
              </button>
              <button className="icon-btn review-btn" onClick={openReview} title="Review 未提交修改">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
                {workingFiles.length > 0 && <span className="review-badge">{workingFiles.length}</span>}
              </button>
              <button className="icon-btn" onClick={openGit} title="Git 提交历史">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              </button>
            </div>
            <button className="panel-search" onClick={() => { setQuickOpen(true); setQuickQ(""); setQuickResults([]); setQuickIdx(0); }} title="搜索文件">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
              <span>搜索文件…</span>
              <span className="panel-search-key">Ctrl+P</span>
            </button>
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
                      <button className="folder-remove" title={lang === "zh" ? "从列表移除" : "Remove from list"}
                        onClick={(e) => { e.stopPropagation(); removeWorkspace(w.root); }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  );
                })}
                {wsList.length === 0 && (
                  <div className="muted" style={{ padding: "8px 12px", fontSize: 12.5 }}>点上方"打开文件夹"导入</div>
                )}
              </div>
              {ws && expanded[""] && (
                <>
                  <div className="browse-hdr">
                <div className="side-section-title" style={{ marginBottom: 0 }}>浏览</div>
                <button className="icon-btn" title="新建文件" onClick={() => { setNewFileOpen(true); setNewFileName(""); }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
                </button>
              </div>
              {newFileOpen && (
                <div className="new-file-row">
                  <input autoFocus className="rename-input" value={newFileName} placeholder="新文件名…" spellCheck={false}
                    onChange={e => setNewFileName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") createFile(); if (e.key === "Escape") setNewFileOpen(false); }} />
                </div>
              )}
                  <div className="tree">
                    {expanded[""].map(c => renderTree([c], 0))}
                  </div>
                </>
              )}
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
                <div className="tab-actions">
                  <button className="icon-btn" title="新建文件" onClick={() => { setNewFileOpen(true); setNewFileName(""); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                  <div className="toolbar-search">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                    <input
                      value={topSearch}
                      placeholder="搜索代码..."
                      spellCheck={false}
                      onChange={e => { setTopSearch(e.target.value); setTopSearchOpen(true); }}
                      onFocus={() => setTopSearchOpen(true)}
                      onKeyDown={e => {
                        if (e.key === "Escape") setTopSearchOpen(false);
                        if (e.key === "Enter" && topResults[0]) {
                          const path = topResults[0];
                          setTopSearchOpen(false); setTopSearch(""); openFile(path);
                        }
                      }}
                    />
                    <span className="toolbar-key">Ctrl+P</span>
                    {topSearchOpen && topResults.length > 0 && (
                      <div className="toolbar-results">
                        {topResults.map((path, i) => (
                          <button key={path + i} onClick={() => { setTopSearchOpen(false); setTopSearch(""); openFile(path); }}>{path}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="toolbar-divider" />
                  <button className={"icon-btn " + (dark ? "on" : "")} title={dark ? "切换亮色" : "切换暗色"} onClick={() => setDark(v => !v)}>
                    {dark ? "☀" : "☾"}
                  </button>
                  <select className="lang-select" value={doc?.language || "text"} title="代码语言" onChange={e => changeCodeLanguage(e.target.value)}>
                    <option value="text">Text</option>
                    <option value="typescript">TypeScript</option>
                    <option value="javascript">JavaScript</option>
                    <option value="tsx">TSX</option>
                    <option value="python">Python</option>
                    <option value="java">Java</option>
                    <option value="rust">Rust</option>
                    <option value="go">Go</option>
                    <option value="c">C</option>
                    <option value="cpp">C++</option>
                    <option value="csharp">C#</option>
                    <option value="json">JSON</option>
                    <option value="css">CSS</option>
                    <option value="html">HTML</option>
                    <option value="xml">XML</option>
                    <option value="sql">SQL</option>
                    <option value="ruby">Ruby</option>
                    <option value="php">PHP</option>
                    <option value="kotlin">Kotlin</option>
                    <option value="swift">Swift</option>
                    <option value="yaml">YAML</option>
                    <option value="toml">TOML</option>
                    <option value="shell">Shell</option>
                    <option value="lua">Lua</option>
                    <option value="markdown">Markdown</option>
                  </select>
                </div>
              </div>
              )}
              <div className="doc-hdr">
                <span>{activeTabData?.path}{editing && editContent !== doc?.content ? " •未保存" : ""}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {!editing && (
                    <>
                      <button className="btn-mini nav-btn" disabled={navIndex <= 0} onClick={() => navigateHistory("back")} title="Back (Alt+←)">← Back</button>
                      <button className="btn-mini nav-btn" disabled={navIndex < 0 || navIndex >= navHistory.length - 1} onClick={() => navigateHistory("forward")} title="Forward (Alt+→)">Forward →</button>
                    </>
                  )}
                  {!editing && <button className="btn-mini" onClick={startEdit}>编辑</button>}
                  {editing && <button className="btn-mini save" onClick={saveEdit}>保存</button>}
                  {editing && <button className="btn-mini" onClick={cancelEdit}>取消</button>}
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
              {editing ? (
                <div className="editor-wrap" style={{ lineHeight: prefs.lineSpacing, fontFamily: CODE_FONT_STACKS[prefs.codeFont] } as React.CSSProperties}>
                  {frOpen && (
                    <div className="fr-bar">
                      <input className="fr-input" value={frFind} placeholder="查找" spellCheck={false}
                        onChange={e => setFrFind(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") frSelect(0); }} />
                      <input className="fr-input" value={frReplace} placeholder="替换为" spellCheck={false}
                        onChange={e => setFrReplace(e.target.value)} />
                      <button className={"fr-btn case" + (frCase ? " on" : "")} title="区分大小写" onClick={() => setFrCase(v => !v)}>Aa</button>
                      <button className="fr-btn" onClick={() => frSelect(0)}>{frMatches.length}</button>
                      <button className="fr-btn" onClick={() => frReplaceOne()} disabled={frMatches.length === 0}>替换</button>
                      <button className="fr-btn" onClick={frReplaceAll} disabled={frMatches.length === 0}>全部</button>
                      <button className="fr-btn" onClick={() => setFrOpen(false)}>×</button>
                    </div>
                  )}
                  <div className="editor-stack">
                    <pre className="code-edit-hl" ref={editHlRef} aria-hidden="true" style={{ fontSize: `${codeFontSize}px` }}>
                      {editContent.length <= 300000
                        ? editLines.map((l, i) => (
                            <div key={i} className="hl-line">
                              {l.tokens.map((tk, j) => tk.cls ? <span key={j} className={tk.cls}>{tk.text}</span> : <span key={j}>{tk.text}</span>)}
                              {"\n"}
                            </div>
                          ))
                        : editContent}
                    </pre>
                    <textarea
                      className="code-edit"
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      onScroll={e => {
                        const hl = editHlRef.current;
                        if (hl) { hl.scrollTop = e.currentTarget.scrollTop; hl.scrollLeft = e.currentTarget.scrollLeft; }
                      }}
                      onKeyDown={e => {
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const ta = e.currentTarget;
                          const st = ta.selectionStart, en = ta.selectionEnd;
                          setEditContent(v => v.slice(0, st) + "    " + v.slice(en));
                          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = st + 4; });
                        }
                      }}
                      spellCheck={false} wrap="off" autoFocus
                      style={{ fontSize: `${codeFontSize}px` }}
                    />
                  </div>
                </div>
              ) : (
              <pre ref={codeRef} className="code" onScroll={onCodeScroll} style={{ fontSize: `${codeFontSize}px`, lineHeight: prefs.lineSpacing, fontFamily: CODE_FONT_STACKS[prefs.codeFont], "--code-line-h": `${codeLineH}px` } as React.CSSProperties}>
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
                  return (
                    <div key={i} className={lineClasses}
                      onClick={(e) => handleCodeClick(e, i)}>
                      <span className="line-num">{i+1}</span>
                      <span className={`fold-gutter ${isFoldable ? "foldable" : ""} ${isFolded ? "folded" : ""}`}
                        onClick={(e) => { if (isFoldable) { e.stopPropagation(); toggleFold(i); } }}>
                        {isFoldable ? (isFolded ? "▸" : "▾") : ""}
                      </span>
                      <span className="code-text">
                        {(isFolded && isFoldable && foldBracketPos >= 0 ? visibleTokens : line.tokens).map(renderToken)}
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
              )}
            </>
          ) : <div className="no-file">{t("noFile")}</div>}
        </section>

        {!focus && outlineVisible && (
          <>
            <div className={`resize-handle resize-right ${isResizing === "right" ? "active" : ""}`}
              onMouseDown={() => setIsResizing("right")} />
            <aside className="right" style={{ width: rightWidth, minWidth: 160, maxWidth: 500 }}>
            <div className="outline-hdr">
              <div className="outline-title"><span className="outline-ic">▦</span>{t("outline")}</div>
              <button className="icon-btn" onClick={() => setOutlineVisible(false)} title="收起大纲">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
              <input className="outline-filter" value={outlineFilter} placeholder="搜索符号…"
                onChange={e => setOutlineFilter(e.target.value)} />
              {syms.length===0 ? <span className="muted">{t("noSyms")}</span> : outlineGroups.length===0 ? (
                <div className="muted" style={{ padding: "8px 6px" }}>无匹配符号</div>
              ) : outlineGroups.map(group => {
                const open = outlineGroupOpen.has(group.id);
                return (
                  <div key={group.id} className="outline-group">
                    <button className="outline-group-hdr" onClick={() => setOutlineGroupOpen(prev => {
                      const next = new Set(prev);
                      if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
                      return next;
                    })}>
                      <span className={`outline-arrow ${open ? "open" : ""}`}>{open ? "▾" : "▸"}</span>
                      <span className={`outline-group-icon gi-${group.id}`}>{group.icon}</span>
                      <span className="outline-group-name">{lang === "zh" ? `${group.en} ${group.zh}` : group.en}</span>
                      <span className="outline-group-count">{group.nodes.length}</span>
                    </button>
                    {open && <div className="outline-group-body">{group.nodes.map(n => renderOutlineSym(n, 0))}</div>}
                  </div>
                );
              })}
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
          </>
        )}
        {!focus && !outlineVisible && (
          <button className="outline-show" onClick={() => setOutlineVisible(true)} title="展开大纲">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
        )}
      </main>

      {/* Git history log */}
      {gitOpen && (
        <div className="qo-overlay" onClick={() => setGitOpen(false)}>
          <div className="qo-modal git-history-modal" onClick={e => e.stopPropagation()}>
            <div className="git-history-toolbar">
              <div className="git-mode-tabs">
                <button className={gitTab === "history" ? "on" : ""} onClick={() => setGitTab("history")}>History</button>
                <button className={gitTab === "working" ? "on" : ""} onClick={() => { setGitTab("working"); loadWorkingChanges(); }}>未提交</button>
              </div>
              <div className="git-search">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
                <input value={gitQuery} placeholder="Text or hash" spellCheck={false}
                  onChange={e => setGitQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") loadGitLog(true); }} />
              </div>
              <select value={gitAllBranches ? "__ALL__" : gitBranch} onChange={e => {
                if (e.target.value === "__ALL__") { setGitAllBranches(true); setGitBranch(""); }
                else { setGitAllBranches(false); setGitBranch(e.target.value); }
              }} title="Branch">
                <option value="">当前分支</option>
                <option value="__ALL__">所有分支</option>
                {gitBranches.map(b => <option key={b.fullName} value={b.name}>{b.name}</option>)}
              </select>
              <select value={gitAuthor} onChange={e => setGitAuthor(e.target.value)} title="User">
                <option value="">User</option>
                {gitAuthors.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <select value={gitDateRange} onChange={e => setGitDateRange(e.target.value)} title="Date">
                <option value="all">Date</option>
                <option value="today">今天</option>
                <option value="7">最近 7 天</option>
                <option value="30">最近 30 天</option>
                <option value="365">最近一年</option>
              </select>
              <input className="git-path-input" value={gitPath} placeholder="Paths" spellCheck={false}
                onChange={e => setGitPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") loadGitLog(true); }} />
              <button className="icon-btn" title="刷新" onClick={() => { loadGitBranches(); loadGitLog(true); }}>↻</button>
              <button className="ref-popup-close" onClick={() => setGitOpen(false)}>✕</button>
            </div>

            {gitError ? <div className="git-error git-error-banner">{gitError}</div> : null}

            {gitTab === "history" ? (
            <div className="git-history-body">
              <div className="git-history-list">
                {gitLoading ? <div className="ref-popup-empty">加载提交历史…</div>
                : gitCommits.length === 0 ? <div className="ref-popup-empty">无匹配提交</div>
                : gitCommits.map((c, index) => (
                  <button key={c.hash} className={`git-commit ${gitSelected === c.hash ? "on" : ""}`} onClick={() => { setGitSelected(c.hash); loadCommitDetail(c.hash); }}>
                    <svg className="git-graph" aria-hidden="true" viewBox="0 0 56 56" preserveAspectRatio="none" style={{ width: Math.max(14, (gitGraph.maxLane + 1) * 14) }}>
                      {(() => {
                        const row = gitGraph.rows[index];
                        const x = (lane: number) => 7 + lane * 12;
                        const color = (lane: number) => ["#3574F0", "#B052A5", "#299D60", "#D87727", "#E0685C"][lane % 5];
                        return (
                          <>
                            {row.verticals.map(l => <line key={"v-" + l} x1={x(l)} y1="0" x2={x(l)} y2="56" stroke={color(l)} strokeWidth="2" opacity="0.5" />)}
                            {row.edges.map((edge, edgeIndex) => (
                              <path key={"e-" + edgeIndex} d={"M " + x(edge.from) + " 28 C " + x(edge.from) + " 43, " + x(edge.to) + " 40, " + x(edge.to) + " 56"} fill="none" stroke={color(edge.to)} strokeWidth="2" opacity="0.75" />
                            ))}
                            <circle cx={x(row.lane)} cy="28" r="4.5" fill={color(row.lane)} stroke="var(--surface)" strokeWidth="2" />
                          </>
                        );
                      })()}
                    </svg>
                    <span className="git-commit-main">
                      <span className="git-commit-subject">{c.subject}</span>
                      <span className="git-commit-meta">
                        <b>{c.authorName}</b>
                        <span>{new Date(c.timestamp * 1000).toLocaleString()}</span>
                      </span>
                      {gitRefBadges(c.refs).length > 0 && (
                        <span className="git-ref-row">
                          {gitRefBadges(c.refs).map((r, i) => <em key={i}>{r}</em>)}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>

              <div className="git-diff-pane">
                {gitDetail ? (
                  <div className="git-commit-detail">
                    <div className="git-detail-subject">{gitDetail.commit.subject}</div>
                    {gitDetail.commit.body.trim() && <div className="git-detail-body">{gitDetail.commit.body.trim()}</div>}
                    <div className="git-detail-meta">
                      <code>{gitDetail.commit.shortHash}</code>
                      <span>{gitDetail.commit.authorName} &lt;{gitDetail.commit.authorEmail}&gt;</span>
                      <span>{new Date(gitDetail.commit.timestamp * 1000).toLocaleString()}</span>
                    </div>
                    <div className="git-detail-parents">Parents: {gitDetail.commit.parents.join(", ") || "root"}</div>
                  </div>
                ) : <div className="ref-popup-empty">{gitDetailLoading ? "加载提交详情…" : "选择一个提交"}</div>}
                <div className="git-diff-view">
                  {gitDiff
                    ? <DiffView diffText={gitDiff} path={gitFile} onOpenFile={line => gitFile && openFile(gitFile, line)} />
                    : <div className="ref-popup-empty">{gitDetailLoading ? "加载差异…" : "选择变更文件"}</div>}
                </div>
              </div>

              <div className="git-files-pane">
                <div className="git-files-title">本次提交变更</div>
                {gitDetail?.files.length ? groupChangedFiles(gitDetail.files).map(([dir, files]) => (
                  <div key={dir} className="git-file-group">
                    <div className="git-file-dir">{dir === "." ? "根目录" : dir}<span>{files.length}</span></div>
                    {files.map(f => (
                      <button key={f.path} className={`git-file ${gitFile === f.path ? "on" : ""}`} onClick={() => showCommitFileDiff(f.path)}>
                        <span className={`git-status st-${(f.status || "M")[0].toUpperCase()}`}>{(f.status || "M")[0]}</span>
                        <span className="git-file-path">{f.path.split("/").pop()}</span>
                      </button>
                    ))}
                  </div>
                )) : <div className="ref-popup-empty">{gitDetailLoading ? "加载文件…" : "无文件"}</div>}
              </div>
            </div>
            ) : (
            <div className="git-working-body">
              <div className="git-list">
                {workingLoading ? <div className="ref-popup-empty">读取未提交变更…</div>
                : workingFiles.length === 0 ? <div className="ref-popup-empty">没有未提交修改</div>
                : workingFiles.map(f => (
                  <button key={f.path} className={`git-file ${workingSel === f.path ? "on" : ""}`} onClick={() => showWorkingDiff(f.path)}>
                    <span className={`git-status st-${(f.status || "M")[0].toUpperCase()}`}>{(f.status || "M")[0]}</span>
                    <span className="git-file-path">{f.path}</span>
                  </button>
                ))}
              </div>
              <div className="git-diff git-diff-view">
                {workingDiff
                  ? <DiffView diffText={workingDiff} path={workingSel} onOpenFile={line => openFile(workingSel, line)} />
                  : <div className="ref-popup-empty">选择文件查看未提交差异</div>}
              </div>
            </div>
            )}
          </div>
        </div>
      )}

      {/* Go to line (Ctrl+G) */}
      {goLineOpen && (
        <div className="qo-overlay" onClick={() => setGoLineOpen(false)}>
          <div className="qo-modal" onClick={e => e.stopPropagation()}>
            <input autoFocus className="qo-input" value={goLineVal}
              onChange={e => setGoLineVal(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={e => {
                if (e.key === "Escape") setGoLineOpen(false);
                if (e.key === "Enter") {
                  const n = parseInt(goLineVal || "0", 10);
                  if (n >= 1 && activeTabData?.path) { setGoLineOpen(false); openFile(activeTabData.path, n); }
                  else setGoLineOpen(false);
                }
              }}
              placeholder="跳转到行…" spellCheck={false} />
          </div>
        </div>
      )}

      {/* Global search modal */}      {/* Global search modal */}
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
        <div className="status-left">
          <span className="status-dot" />
          <span>{status}</span>
        </div>
        <div className="status-right">
          {activeTabData?.path && (
            <button className="status-copy" title={lang === "zh" ? "复制文件路径 (Ctrl+Shift+C)" : "Copy file path (Ctrl+Shift+C)"}
              onClick={() => { navigator.clipboard.writeText(activeTabData.path).then(() => setStatus(lang === "zh" ? "已复制路径" : "Path copied"), () => {}); }}>
              {activeTabData.path}
            </button>
          )}
          <span>行 {cursor.line}, 列 {cursor.col}</span>
          <span>空格: 4</span>
          <span>UTF-8</span>
          <span>LF</span>
          <span>{doc?.language?.toUpperCase() || "TEXT"}</span>
          <span>{Math.round(codeFontSize / 13 * 100)}%</span>
          {highlightWord && highlightOccurrences.count > 0 && (
            <span title={lang === "zh" ? "当前文件匹配数" : "Occurrences in current file"}>
              {highlightWord} · {highlightOccurrences.count}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
