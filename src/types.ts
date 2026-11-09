export interface Workspace {
  id: string;
  root: string;
  name: string;
  indexedFiles: number;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
}

export interface HighlightSpan {
  start: number;
  end: number;
  kind: string;
}

export interface FileDocument {
  path: string;
  name: string;
  language: string;
  content: string;
  highlights: HighlightSpan[];
  size: number;
  truncated: boolean;
}

export interface Symbol {
  path: string;
  name: string;
  kind: string;
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  maxResults?: number;
  pathFilter?: string;
}

export interface SearchMatch {
  line: number;
  start: number;
  end: number;
  text: string;
}

export interface SearchResult {
  path: string;
  name: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
  filesSearched: number;
}

export interface NavigationTarget {
  path: string;
  name: string;
  kind: string;
  start: number;
  end: number;
  startLine: number;
  startColumn: number;
}

export interface IndexProgress {
  workspaceId: string;
  phase: string;
  indexedFiles: number;
}
