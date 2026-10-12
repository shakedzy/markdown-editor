import {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FolderListing } from '../../shared/types';
import { TreeRow, foldersLeadingTo, visibleRows } from '../folderTree';
import { pathKey } from '../pathKey';

interface Props {
  /** The open folder; null shows how to open one. */
  folder: FolderListing | null;
  /** The window's document, highlighted when it is in the folder. */
  currentPath: string | null;
  /** Kept mounted while hidden, so expanded folders and the scroll position survive. */
  hidden: boolean;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onCloseFolder: () => void;
  onOpenFile: (path: string) => void;
}

function FilesPanel({ folder, hidden, onOpenFolder, ...rest }: Props): JSX.Element {
  if (!folder) {
    return (
      <aside className="files-panel" aria-label="Files" hidden={hidden}>
        <div className="files-header">
          <span className="files-title">Files</span>
        </div>
        <div className="files-empty">
          <p>Open a folder to browse its Markdown files.</p>
          <button type="button" className="files-open-button" onClick={onOpenFolder}>
            Open Folder…
          </button>
        </div>
      </aside>
    );
  }
  // Another folder starts over, all collapsed.
  return <FolderView key={folder.root} folder={folder} hidden={hidden} {...rest} />;
}

export default memo(FilesPanel);

function FolderView({
  folder,
  currentPath,
  hidden,
  onRefresh,
  onCloseFolder,
  onOpenFile,
}: Omit<Props, 'folder' | 'onOpenFolder'> & { folder: FolderListing }): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // The row keyboard focus is on, or was last on.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleRows(folder.entries, expanded), [folder.entries, expanded]);
  // Each file row's key, worked out once per listing rather than per render.
  const rowKeys = useMemo(
    () => rows.map(({ entry }) => (entry.kind === 'file' ? pathKey(entry.path) : null)),
    [rows],
  );
  const currentKey = currentPath === null ? null : pathKey(currentPath);

  // Reveal the open document: expand the folders it is in, once per document,
  // so a folder the user collapses afterwards stays collapsed on refreshes.
  const revealedRef = useRef<string | null>(null);
  const scrollPendingRef = useRef(false);
  const [revealCount, setRevealCount] = useState(0);
  useEffect(() => {
    if (currentKey !== null && revealedRef.current === currentKey) return;
    const folders =
      currentKey === null ? null : foldersLeadingTo(folder.entries, currentKey, pathKey);
    // Untitled, outside this folder, or not listed yet (e.g. just saved into
    // it): revealed once it is listed, or when the user comes back to it.
    if (!folders) {
      revealedRef.current = null;
      return;
    }
    revealedRef.current = currentKey;
    scrollPendingRef.current = true;
    setRevealCount((n) => n + 1);
    setExpanded((prev) =>
      folders.every((f) => prev.has(f)) ? prev : new Set([...prev, ...folders]),
    );
  }, [currentKey, folder.entries]);

  // A hidden panel can't scroll; it catches up once shown.
  useLayoutEffect(() => {
    if (!scrollPendingRef.current || hidden) return;
    scrollPendingRef.current = false;
    treeRef.current?.querySelector('.files-row.current')?.scrollIntoView({ block: 'nearest' });
  }, [revealCount, hidden]);

  const currentIndex = currentKey === null ? -1 : rowKeys.indexOf(currentKey);

  // One row is in the Tab order: the last focused, else the open document, else the first.
  const tabStop = (
    rows.find((r) => r.entry.path === focusedPath) ??
    rows[currentIndex] ??
    rows[0]
  )?.entry.path;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const focusRow = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    treeRef.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
  };

  const activate = ({ entry }: TreeRow) => {
    if (entry.kind === 'folder') toggle(entry.path);
    else onOpenFile(entry.path);
  };

  // Stable, reading the latest rows, so a focus move re-renders only the
  // rows whose tab stop changes.
  const latestRef = useRef({ rows, activate });
  latestRef.current = { rows, activate };
  const onRowClick = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const { rows: shown, activate: open } = latestRef.current;
    const row = shown[Number(e.currentTarget.dataset.index)];
    if (row) open(row);
  }, []);
  const onRowFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>) => setFocusedPath(e.currentTarget.dataset.path ?? null),
    [],
  );

  // The WAI-ARIA tree view keys.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const index = Number((e.target as HTMLElement).dataset.index);
    const row = rows[index];
    if (!row) return;
    const { entry } = row;
    const open = entry.kind === 'folder' && expanded.has(entry.path);
    switch (e.key) {
      case 'ArrowDown':
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        focusRow(index - 1);
        break;
      case 'Home':
        focusRow(0);
        break;
      case 'End':
        focusRow(rows.length - 1);
        break;
      case 'ArrowRight':
        if (open) focusRow(index + 1);
        else if (entry.kind === 'folder') toggle(entry.path);
        break;
      case 'ArrowLeft':
        if (open) toggle(entry.path);
        else if (row.parent !== null) focusRow(rows.findIndex((r) => r.entry.path === row.parent));
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <aside className="files-panel" aria-label="Files" hidden={hidden}>
      <div className="files-header">
        <span className="files-title" title={folder.root}>
          {folder.name}
        </span>
        <button
          type="button"
          className="files-header-button"
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
            <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
          </svg>
        </button>
        <button
          type="button"
          className="files-header-button"
          onClick={onCloseFolder}
          title="Close folder"
          aria-label="Close folder"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
          </svg>
        </button>
      </div>
      {folder.error ? (
        <p className="files-note">{folder.error}</p>
      ) : rows.length === 0 ? (
        <p className="files-note">No Markdown files in this folder.</p>
      ) : (
        <div
          ref={treeRef}
          className="files-tree"
          role="tree"
          aria-label={folder.name}
          onKeyDown={onKeyDown}
        >
          {rows.map((row, index) => (
            <FileRow
              key={row.entry.path}
              row={row}
              index={index}
              open={row.entry.kind === 'folder' && expanded.has(row.entry.path)}
              current={index === currentIndex}
              tabStop={row.entry.path === tabStop}
              onClick={onRowClick}
              onFocus={onRowFocus}
            />
          ))}
        </div>
      )}
      {folder.truncated && (
        <p className="files-note">
          This folder is too large to list in full; some files aren’t shown.
        </p>
      )}
    </aside>
  );
}

interface FileRowProps {
  row: TreeRow;
  index: number;
  /** A folder that is expanded. */
  open: boolean;
  /** The window's document. */
  current: boolean;
  /** The row in the Tab order. */
  tabStop: boolean;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
  onFocus: (e: FocusEvent<HTMLDivElement>) => void;
}

const FileRow = memo(function FileRow({
  row,
  index,
  open,
  current,
  tabStop,
  onClick,
  onFocus,
}: FileRowProps): JSX.Element {
  const { entry } = row;
  const folderRow = entry.kind === 'folder';
  return (
    <div
      role="treeitem"
      className={`files-row${current ? ' current' : ''}`}
      style={{ '--level': row.level } as CSSProperties}
      aria-level={row.level}
      aria-posinset={row.position}
      aria-setsize={row.siblings}
      aria-expanded={folderRow ? open : undefined}
      aria-selected={folderRow ? undefined : current}
      tabIndex={tabStop ? 0 : -1}
      data-index={index}
      data-path={entry.path}
      title={entry.name}
      onClick={onClick}
      onFocus={onFocus}
    >
      <span className="files-chevron" aria-hidden="true">
        {folderRow && (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        )}
      </span>
      <svg
        className="files-icon"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        fill="currentColor"
      >
        <path d={folderRow ? FOLDER_ICON : FILE_ICON} />
      </svg>
      <span className="files-name">{entry.name}</span>
    </div>
  );
});

const FOLDER_ICON =
  'M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75ZM1.5 2.75a.25.25 0 0 1 .25-.25H5a.25.25 0 0 1 .2.1l.9 1.2c.33.44.85.7 1.4.7h6.75a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25V2.75Z';
const FILE_ICON =
  'M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z';
