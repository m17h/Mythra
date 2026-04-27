import type { WorkspaceNode } from '@shared/types';

interface FileTreeProps {
  nodes: WorkspaceNode[];
  depth?: number;
  activePath?: string;
  onOpen: (path: string) => void;
}

export function FileTree({ nodes, depth = 0, activePath, onOpen }: FileTreeProps) {
  return (
    <div className="tree">
      {nodes.map((node) => (
        <div key={node.path} className="tree__branch">
          <button
            className={`tree__node ${node.type === 'directory' ? 'is-directory' : ''} ${
              activePath === node.path ? 'is-active' : ''
            }`}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            onClick={() => {
              if (node.type === 'file') {
                onOpen(node.path);
              }
            }}
            type="button"
          >
            <span className="tree__glyph">{node.type === 'directory' ? '▣' : '■'}</span>
            <span>{node.name}</span>
          </button>
          {node.type === 'directory' && node.children && node.children.length > 0 ? (
            <FileTree nodes={node.children} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
          ) : null}
        </div>
      ))}
    </div>
  );
}
