import { useCallback, useEffect, useState } from "react";
import { backend } from "../lib/bridge";
import type { TreeNode } from "../types";

interface TreeItemProps {
  workspaceId: string;
  node: TreeNode;
  activePath: string | null;
  onSelect: (node: TreeNode) => void;
  depth: number;
}

function TreeItem({ workspaceId, node, activePath, onSelect, depth }: TreeItemProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!node.isDir || children.length > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      setChildren(await backend.fileTree(workspaceId, node.path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [children.length, loading, node.isDir, node.path, workspaceId]);

  useEffect(() => {
    if (expanded && node.isDir) void load();
  }, [expanded, load, node.isDir]);

  return (
    <div className="tree-item">
      <button
        className={`tree-row ${activePath === node.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (node.isDir) setExpanded((value) => !value);
          else onSelect(node);
        }}
        title={node.path}
      >
        <span className="tree-icon">{node.isDir ? (expanded ? "▾" : "▸") : fileIcon(node.name)}</span>
        <span className="tree-label">{node.name}</span>
      </button>
      {expanded && node.isDir ? (
        <div>
          {error ? <div className="tree-error">{error}</div> : null}
          {children.map((child) => (
            <TreeItem
              key={child.path}
              workspaceId={workspaceId}
              node={child}
              activePath={activePath}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function fileIcon(name: string): string {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(name)) return "JS";
  if (/\.py$/i.test(name)) return "PY";
  if (/\.java$/i.test(name)) return "JV";
  if (/\.(md|markdown)$/i.test(name)) return "MD";
  if (/\.(json|yml|yaml|toml)$/i.test(name)) return "CF";
  return "•";
}

interface FileTreeProps {
  workspaceId: string | null;
  nodes: TreeNode[];
  activePath: string | null;
  onSelect: (node: TreeNode) => void;
}

export function FileTree({ workspaceId, nodes, activePath, onSelect }: FileTreeProps) {
  if (!workspaceId) return <div className="empty-note">Open a folder to browse files.</div>;
  return (
    <div className="file-tree">
      {nodes.map((node) => (
        <TreeItem
          key={node.path}
          workspaceId={workspaceId}
          node={node}
          activePath={activePath}
          onSelect={onSelect}
          depth={0}
        />
      ))}
    </div>
  );
}
