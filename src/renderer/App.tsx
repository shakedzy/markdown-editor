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
const INITIAL_DOC = INITIAL_SETTINGS.showWelcomeOnLaunch ? welcomeContent : '';

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
  const lastRightClickedPaneRef = useRef<'editor' | 'preview' | null>(null);

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

  const onNew = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setBuffer('');
    setSavedContent('');
    setFilePath(null);
    editorRef.current?.setContent('');
    editorRef.current?.focus();
  }, [dirty]);

  const onOpen = useCallback(async () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    const result = await window.api.openFile();
    if (!result) return;
    setBuffer(result.content);
    setSavedContent(result.content);
    setFilePath(result.path);
    editorRef.current?.setContent(result.content);
    editorRef.current?.focus();
  }, [dirty]);

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

  const onToggleViewMode = useCallback(() => {
    setViewMode((m) => (m === 'split' ? 'tabs' : 'split'));
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
    const view = editorRef.current?.view();
    if (!view) return;
    view.focus();
    openSearchPanel(view);
  }, []);

  const onTakeMeThere = useCallback(() => {
    const pane = lastRightClickedPaneRef.current;
    if (pane === 'editor') {
      const line = editorRef.current?.currentLine() ?? 1;
      let idx = 0;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.line <= line) idx = i;
        else break;
      }
      previewRef.current?.scrollToHeading(idx);
      if (viewMode === 'tabs') setActiveTab('preview');
    } else if (pane === 'preview') {
      const idx = previewRef.current?.currentHeadingIndex() ?? 0;
      const h = headings[idx];
      if (h) editorRef.current?.scrollToLine(h.line);
      if (viewMode === 'tabs') setActiveTab('editor');
    }
  }, [headings, viewMode]);

  const recordRightClick = useCallback((pane: 'editor' | 'preview') => {
    return (e: React.MouseEvent) => {
      if (e.button === 2) lastRightClickedPaneRef.current = pane;
    };
  }, []);

  useEffect(() => {
    const off = window.api.onMenuAction((action) => {
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
          onTakeMeThere();
          break;
      }
    });
    return off;
  }, [
    onNew,
    onOpen,
    onSave,
    onSaveAs,
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
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
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
            <div
              className="workspace-pane workspace-editor"
              onMouseDown={recordRightClick('editor')}
            >
              <Editor ref={editorRef} initialDoc={INITIAL_DOC} onChange={setBuffer} />
            </div>
            <div
              className="workspace-divider"
              onMouseDown={startDrag}
              role="separator"
              aria-orientation="vertical"
            />
            <div
              className="workspace-pane workspace-preview"
              onMouseDown={recordRightClick('preview')}
            >
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
