import { invoke } from "@tauri-apps/api/core";
import type {
  FileDocument,
  HighlightSpan,
  NavigationTarget,
  SearchOptions,
  SearchResponse,
  Symbol,
  TreeNode,
  Workspace,
} from "../types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("The native workspace backend is only available in the desktop app.");
  }
  return invoke<T>(command, args);
}

export const backend = {
  openWorkspace: (root: string) => call<Workspace>("workspace_open", { root }),
  fileTree: (workspaceId: string, path?: string) =>
    call<TreeNode[]>("file_tree", { workspaceId, path }),
  readFile: (workspaceId: string, path: string) =>
    call<FileDocument>("file_read", { workspaceId, path }),
  highlight: (workspaceId: string, path: string) =>
    call<HighlightSpan[]>("highlight", { workspaceId, path }),
  outline: (workspaceId: string, path: string) =>
    call<Symbol[]>("outline", { workspaceId, path }),
  search: (
    workspaceId: string,
    query: string,
    options: SearchOptions,
  ) =>
    call<SearchResponse>("search", {
      workspaceId,
      query,
      options,
    }),
  resolveDefinition: (workspaceId: string, path: string, start: number, end?: number) =>
    call<NavigationTarget[]>("resolve_definition", {
      workspaceId,
      path,
      start,
      end,
    }),
};
