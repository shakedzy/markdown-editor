import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import Toolbar from './components/Toolbar';
import Editor, { EditorHandle } from './components/Editor';
import Preview, { PreviewHandle } from './components/Preview';
import Toc from './components/Toc';
import ShortcutsDialog from './components/ShortcutsDialog';
import SettingsDialog from './components/SettingsDialog';
import { extractHeadings, Heading } from './markdown/headings';
import { buildExtensions } from './editor/extensions';
import { setFormatMarkers } from './editor/shortcuts';
import { Settings, loadSettings, saveSettings, applyTheme } from './settings';
import welcomeContent from './welcome.md?raw';

const INITIAL_SETTINGS = loadSettings();
// Windows opened via New/Open carry `?blank=1` so they start empty instead of
// showing the welcome document.
const START_BLANK = new URLSearchParams(window.location.search).has('blank');
const INITIAL_DOC =
  INITIAL_SETTINGS.showWelcomeOnLaunch && !START_BLANK ? welcomeContent : '';

setFormatMarkers({
  bold: INITIAL_SETTINGS.boldMarker,
  italic: INITIAL_SETTINGS.italicMarker,
  strike: INITIAL_SETTINGS.strikethroughMarker,
  underline: INITIAL_SETTINGS.underlineMarker,
});

applyTheme(INITIAL_SETTINGS.theme);

export default function App(): JSX.Element {
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const [buffer, setBuffer] = useState(INITIAL_DOC);
  const [savedContent, setSavedContent] = useState(INITIAL_DOC);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'tabs'>(INITIAL_SETTINGS.defaultView);
  const [activeTab, setActiveTab] = useState<'editor' | 'preview'>('editor');
  const [tocVisible, setTocVisible] = useState(true);
  const [ghMode, setGhMode] = useState(INITIAL_SETTINGS.ghOnByDefault);
  const [leftFraction, setLeftFraction] = useState(0.5);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(INITIAL_SETTINGS);

  const dirty = buffer !== savedContent;

  const basePath = useMemo(() => {
    if (!filePath) return null;
    const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSep >= 0 ? filePath.slice(0, lastSep) : null;
  }, [filePath]);

  const headings = useMemo<Heading[]>(() => {
    const state = EditorState.create({ doc: buffer, extensions: buildExtensions() });
    return extractHeadings(state);
  }, [buffer]);

  useEffect(() => {
    const base = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled';
    document.title = `${dirty ? '• ' : ''}${base} — MDitor`;
  }, [filePath, dirty]);

  useEffect(() => {
    setFormatMarkers({
      bold: settings.boldMarker,
      italic: settings.italicMarker,
      strike: settings.strikethroughMarker,
      underline: settings.underlineMarker,
    });
    applyTheme(settings.theme);
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (settings.theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('auto');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [settings.theme]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !workspaceRef.current) return;
      const rect = workspaceRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      setLeftFraction(Math.min(0.85, Math.max(0.15, fraction)));
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '?') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[contenteditable="true"], input, textarea')) return;
      e.preventDefault();
      setShortcutsOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startDrag = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // Latest reuse-relevant state, read at the moment New/Open fires so the
  // callbacks can stay stable (no re-subscribing the menu listener per keystroke).
  const reuseInfoRef = useRef({
    buffer,
    savedContent,
    filePath,
    alwaysNewWindow: settings.alwaysNewWindow,
  });
  reuseInfoRef.current = {
    buffer,
    savedContent,
    filePath,
    alwaysNewWindow: settings.alwaysNewWindow,
  };

  // Reuse the current window only when it holds nothing worth preserving: no
  // file open, no unsaved changes, and either empty or the untouched welcome
  // doc. Otherwise (or when the user opts into always-new) spawn a new window.
  const canReuseCurrentWindow = useCallback(() => {
    const info = reuseInfoRef.current;
    if (info.alwaysNewWindow) return false;
    if (info.filePath !== null) return false;
    if (info.buffer !== info.savedContent) return false;
    return info.buffer.trim() === '' || info.buffer === welcomeContent;
  }, []);

  const onNew = useCallback(() => {
    if (canReuseCurrentWindow()) {
      setBuffer('');
      setSavedContent('');
      setFilePath(null);
      editorRef.current?.setContent('');
      editorRef.current?.focus();
      return;
    }
    window.api.newWindow();
  }, [canReuseCurrentWindow]);

  const onOpen = useCallback(async () => {
    if (canReuseCurrentWindow()) {
      const result = await window.api.openFile();
      if (!result) return;
      setBuffer(result.content);
      setSavedContent(result.content);
      setFilePath(result.path);
      editorRef.current?.setContent(result.content);
      editorRef.current?.focus();
      return;
    }
    await window.api.openInNewWindow();
  }, [canReuseCurrentWindow]);

  const onSave = useCallback(async () => {
    const content = editorRef.current?.getContent() ?? buffer;
    if (!filePath) {
      const result = await window.api.saveFileAs({ content });
      if (!result) return;
      setFilePath(result.path);
      setSavedContent(content);
      return;
    }
    await window.api.saveFile({ path: filePath, content });
    setSavedContent(content);
  }, [buffer, filePath]);

  const onSaveAs = useCallback(async () => {
    const content = editorRef.current?.getContent() ?? buffer;
    const suggested = filePath ? filePath.split(/[\\/]/).pop() : 'Untitled.md';
    const result = await window.api.saveFileAs({ content, suggestedName: suggested });
    if (!result) return;
    setFilePath(result.path);
    setSavedContent(content);
  }, [buffer, filePath]);

  const onSaveAndQuit = useCallback(async () => {
    const content = editorRef.current?.getContent() ?? buffer;
    if (!filePath) {
      const result = await window.api.saveFileAs({ content });
      if (!result) return;
      setFilePath(result.path);
      setSavedContent(content);
    } else {
      await window.api.saveFile({ path: filePath, content });
      setSavedContent(content);
    }
    window.api.confirmQuit();
  }, [buffer, filePath]);

  const onToggleViewMode = useCallback(() => {
    setViewMode((m) => (m === 'split' ? 'tabs' : 'split'));
  }, []);

  // From a split pane, jump straight to Tabs view with that pane's tab active.
  const onPopToTab = useCallback((tab: 'editor' | 'preview') => {
    setActiveTab(tab);
    setViewMode('tabs');
  }, []);

  const onToggleToc = useCallback(() => setTocVisible((v) => !v), []);
  const onToggleGh = useCallback(() => setGhMode((g) => !g), []);

  const onSelectHeading = useCallback((h: Heading, index: number) => {
    editorRef.current?.scrollToLine(h.line);
    previewRef.current?.scrollToHeading(index);
  }, []);

  const onShowShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const onCloseShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const onShowSettings = useCallback(() => setSettingsOpen(true), []);
  const onCloseSettings = useCallback(() => setSettingsOpen(false), []);

  const onFind = useCallback(() => {
    // The preview is read-only, so when it's the visible pane route Find to the
    // preview's own text search instead of the editor's search panel.
    if (viewMode === 'tabs' && activeTab === 'preview') {
      previewRef.current?.openSearch();
      return;
    }
    const view = editorRef.current?.view();
    if (!view) return;
    view.focus();
    openSearchPanel(view);
  }, [viewMode, activeTab]);

  const onTakeMeThere = useCallback(
    (coords?: { x: number; y: number }) => {
      if (!coords) return;
      const { x, y } = coords;
      const within = (el: HTMLElement | null | undefined): boolean => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        // A display:none pane (tabs mode) has a zero rect, so this never
        // matches the hidden pane.
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };

      if (within(editorRef.current?.view()?.dom)) {
        const info = editorRef.current?.lineInfoAtCoords(x, y) ?? {
          line: 1,
          text: '',
        };
        let idx = 0;
        for (let i = 0; i < headings.length; i++) {
          if (headings[i]!.line <= info.line) idx = i;
          else break;
        }
        previewRef.current?.revealText({ snippet: info.text, headingIndex: idx });
        if (viewMode === 'tabs') setActiveTab('preview');
      } else if (within(previewRef.current?.element())) {
        const idx = previewRef.current?.headingIndexAtCoords(x, y) ?? 0;
        const snippet = previewRef.current?.textAtCoords(x, y) ?? '';
        const nearLine = headings[idx]?.line ?? 1;
        editorRef.current?.revealSource({ snippet, nearLine, fallbackLine: nearLine });
        if (viewMode === 'tabs') setActiveTab('editor');
      }
    },
    [headings, viewMode],
  );

  useEffect(() => {
    const off = window.api.onMenuAction((action, payload) => {
      switch (action) {
        case 'newFile':
          void onNew();
          break;
        case 'openFile':
          void onOpen();
          break;
        case 'save':
          void onSave();
          break;
        case 'saveAs':
          void onSaveAs();
          break;
        case 'saveAndQuit':
          void onSaveAndQuit();
          break;
        case 'toggleToc':
          onToggleToc();
          break;
        case 'toggleViewMode':
          onToggleViewMode();
          break;
        case 'toggleGh':
          onToggleGh();
          break;
        case 'formatBold':
          editorRef.current?.format('bold');
          break;
        case 'formatItalic':
          editorRef.current?.format('italic');
          break;
        case 'formatUnderline':
          editorRef.current?.format('underline');
          break;
        case 'formatStrike':
          editorRef.current?.format('strike');
          break;
        case 'find':
          onFind();
          break;
        case 'showShortcuts':
          onShowShortcuts();
          break;
        case 'showSettings':
          onShowSettings();
          break;
        case 'takeMeThere':
          onTakeMeThere(payload);
          break;
      }
    });
    return off;
  }, [
    onNew,
    onOpen,
    onSave,
    onSaveAs,
    onSaveAndQuit,
    onToggleToc,
    onToggleViewMode,
    onToggleGh,
    onFind,
    onShowShortcuts,
    onShowSettings,
    onTakeMeThere,
  ]);

  useEffect(() => {
    const off = window.api.onOpenFromOS((file) => {
      setBuffer(file.content);
      setSavedContent(file.content);
      setFilePath(file.path);
      editorRef.current?.setContent(file.content);
      editorRef.current?.focus();
    });
    return off;
  }, []);

  useEffect(() => {
    window.api.setDirty(dirty);
  }, [dirty]);

  const workspaceStyle: CSSProperties =
    viewMode === 'split'
      ? {
          gridTemplateColumns: `${leftFraction * 100}% 6px ${(1 - leftFraction) * 100}%`,
        }
      : {};

  return (
    <div className={`app ${tocVisible ? 'with-toc' : ''}`}>
      <Toolbar
        filePath={filePath}
        dirty={dirty}
        viewMode={viewMode}
        tocVisible={tocVisible}
        ghMode={ghMode}
        onNew={onNew}
        onOpen={() => void onOpen()}
        onSave={() => void onSave()}
        onSaveAs={() => void onSaveAs()}
        onToggleViewMode={onToggleViewMode}
        onToggleToc={onToggleToc}
        onToggleGh={onToggleGh}
        onShowShortcuts={onShowShortcuts}
        onShowSettings={onShowSettings}
      />
      <div className="main">
        {tocVisible && <Toc headings={headings} onSelect={onSelectHeading} />}
        <div className="workspace-container">
          {viewMode === 'tabs' && (
            <div className="tab-strip" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'editor'}
                className={`tab-strip-tab ${activeTab === 'editor' ? 'active' : ''}`}
                onClick={() => setActiveTab('editor')}
              >
                Editor
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'preview'}
                className={`tab-strip-tab ${activeTab === 'preview' ? 'active' : ''}`}
                onClick={() => setActiveTab('preview')}
              >
                Preview
              </button>
            </div>
          )}
          <div
            ref={workspaceRef}
            className={`workspace mode-${viewMode} active-${activeTab}`}
            style={workspaceStyle}
          >
            <div className="workspace-pane workspace-editor">
              {viewMode === 'split' && (
                <PaneHeader label="Editor" onOpenInTab={() => onPopToTab('editor')} />
              )}
              <Editor ref={editorRef} initialDoc={INITIAL_DOC} onChange={setBuffer} />
            </div>
            <div
              className="workspace-divider"
              onMouseDown={startDrag}
              role="separator"
              aria-orientation="vertical"
            />
            <div className="workspace-pane workspace-preview">
              {viewMode === 'split' && (
                <PaneHeader label="Preview" onOpenInTab={() => onPopToTab('preview')} />
              )}
              <Preview
                ref={previewRef}
                source={buffer}
                ghMode={ghMode}
                basePath={basePath}
              />
            </div>
          </div>
        </div>
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={onCloseShortcuts} />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={onCloseSettings}
      />
    </div>
  );
}

function PaneHeader({
  label,
  onOpenInTab,
}: {
  label: string;
  onOpenInTab: () => void;
}): JSX.Element {
  return (
    <div className="pane-header">
      <span className="pane-header-label">{label}</span>
      <button
        type="button"
        className="pane-open-tab"
        onClick={onOpenInTab}
        title={`Open ${label} in Tabs view`}
        aria-label={`Open ${label} in Tabs view`}
      >
        <span className="pane-open-tab-arrow" aria-hidden="true">→</span>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm1.5-.5a.5.5 0 0 0-.5.5V6h10V3.5a.5.5 0 0 0-.5-.5h-9Z" />
        </svg>
      </button>
    </div>
  );
}
