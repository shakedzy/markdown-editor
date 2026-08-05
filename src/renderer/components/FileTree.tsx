import { useState } from 'react';
import type { FileNode, FolderResult } from '../../shared/types';

interface Props {
  folder: FolderResult;
  activePath: string | null;
  onSelect: (path: string) => void;
  showHidden: boolean;
  onToggleShowHidden: () => void;
}

function rootName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function DirNode({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const pad = 8 + depth * 12;
  return (
    <li className="filetree-item">
      <button
        type="button"
        className="filetree-dir"
        style={{ paddingLeft: pad }}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="filetree-caret">{open ? '▾' : '▸'}</span>
        {node.name}
      </button>
      {open && node.children && (
        <ul className="filetree-list">
          {node.children.map((child) => (
            <Node
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Node({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
}): JSX.Element {
  if (node.type === 'dir') {
    return (
      <DirNode node={node} depth={depth} activePath={activePath} onSelect={onSelect} />
    );
  }
  const pad = 8 + depth * 12 + 14;
  return (
    <li className="filetree-item">
      <button
        type="button"
        className={`filetree-file ${activePath === node.path ? 'active' : ''}`}
        style={{ paddingLeft: pad }}
        onClick={() => onSelect(node.path)}
        title={node.path}
      >
        {node.name}
      </button>
    </li>
  );
}

export default function FileTree({
  folder,
  activePath,
  onSelect,
  showHidden,
  onToggleShowHidden,
}: Props): JSX.Element {
  return (
    <aside className="filetree">
      <div className="filetree-header">
        <span className="filetree-header-name" title={folder.root}>
          {rootName(folder.root)}
        </span>
        <button
          type="button"
          className={`filetree-hidden-toggle ${showHidden ? 'active' : ''}`}
          onClick={onToggleShowHidden}
          title={showHidden ? 'Hide hidden files' : 'Show hidden files (e.g. .claude)'}
        >
          Hidden
        </button>
      </div>
      {folder.tree.length === 0 ? (
        <div className="filetree-empty-msg">No markdown files found.</div>
      ) : (
        <ul className="filetree-list">
          {folder.tree.map((node) => (
            <Node
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
