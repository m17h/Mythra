import type { WorkspaceNode } from '@shared/types';
import { useMemo, useState } from 'react';

interface FileTreeProps {
  nodes: WorkspaceNode[];
  depth?: number;
  activePath?: string;
  onOpen: (path: string) => void;
  query?: string;
  collapsed?: Set<string>;
  onToggleDirectory?: (path: string) => void;
}

function nodeMatchesQuery(node: WorkspaceNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)) return true;
  return Boolean(node.children?.some((child) => nodeMatchesQuery(child, query)));
}

function FileTreeBranches({
  nodes,
  depth = 0,
  activePath,
  onOpen,
  query = '',
  collapsed = new Set<string>(),
  onToggleDirectory
}: FileTreeProps) {
  const visibleNodes = useMemo(
    () => nodes.filter((node) => nodeMatchesQuery(node, query.trim())),
    [nodes, query]
  );

  if (visibleNodes.length === 0 && depth === 0) {
    return <div className="tree__empty">No matching files.</div>;
  }

  return (
    <div className="tree">
      {visibleNodes.map((node) => {
        const hasChildren = node.type === 'directory' && node.children && node.children.length > 0;
        const forceOpen = query.trim().length > 0;
        const isCollapsed = !forceOpen && collapsed.has(node.path);
        return (
          <div key={node.path} className="tree__branch">
            <button
              className={`tree__node ${node.type === 'directory' ? 'is-directory' : ''} ${
                activePath === node.path ? 'is-active' : ''
              }`}
              style={{ paddingLeft: `${depth * 14 + 10}px` }}
              onClick={() => {
                if (node.type === 'directory') {
                  onToggleDirectory?.(node.path);
                  return;
                }
                onOpen(node.path);
              }}
              title={node.path}
              type="button"
            >
              <span className="tree__glyph">
                {node.type === 'directory' ? (isCollapsed ? '▸' : '▾') : '■'}
              </span>
              <span>{node.name}</span>
            </button>
            {hasChildren && !isCollapsed ? (
              <FileTreeBranches
                nodes={node.children ?? []}
                depth={depth + 1}
                activePath={activePath}
                onOpen={onOpen}
                query={query}
                collapsed={collapsed}
                onToggleDirectory={onToggleDirectory}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function FileTree({ nodes, activePath, onOpen }: FileTreeProps) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleDirectory = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="tree-shell">
      <label className="tree-search">
        <span>Search files</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name or path"
          type="search"
        />
      </label>
      <FileTreeBranches
        nodes={nodes}
        activePath={activePath}
        onOpen={onOpen}
        query={query}
        collapsed={collapsed}
        onToggleDirectory={toggleDirectory}
      />
    </div>
  );
}
