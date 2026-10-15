import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import Toolbar, { AutoSaveStatus } from './components/Toolbar';
import Editor, { EditorHandle, SelectionInfo } from './components/Editor';
import Preview, { PreviewHandle } from './components/Preview';
import Toc from './components/Toc';
import FilesPanel from './components/FilesPanel';
import ShortcutsDialog from './components/ShortcutsDialog';
import SettingsDialog from './components/SettingsDialog';
import StatusBar, { StatusBarHandle, flashStatus } from './components/StatusBar';
import Banner, { BannerNotice } from './components/Banner';
import FocusExit from './components/FocusExit';
import LintStatus from './components/LintStatus';
import { extractHeadings, Heading } from './markdown/headings';
import { buildLanguageExtensions } from './editor/extensions';
import { setFormatMarkers } from './editor/shortcuts';
import type { VimCommand } from './editor/vim';
import type { LintCounts } from './editor/lint';
import { editorClaimsEscape } from './editor/focusMode';
import { Settings, loadSettings, onSettingsSaved, saveSettings, applyTheme } from './settings';
import { exportPreviewToHtml, exportPreviewToPdf } from './export';
import { copyPreviewAsRichText } from './richText';
import { sameZoom, setWindowZoom, useZoom } from './zoom';
import { isDefaultPreviewFont, normalizePreviewFont, stepPreviewFont } from './previewFont';
import { useScrollSync } from './useScrollSync';
import { useAutoSave } from './useAutoSave';
import { useCrashRecovery } from './useCrashRecovery';
import { useImagePaste } from './useImagePaste';
import { useLatest } from './useLatest';
import { classifyLink, headingIndexForFragment } from './links';
import { pathKey } from './pathKey';
import { shortcut } from './platform';
import { displayName, fileName } from './fileName';
import welcomeContent from './welcome.md?raw';
import type { FileResult, FolderListing, MenuAction, RecoveredDocument } from '../shared/types';

// Why auto-save, though on, is waiting for the user before it writes again.
type AutoSaveHold = Extract<AutoSaveStatus, 'conflict' | 'failed' | 'recovered'>;

// Menu commands that change the layout focus mode covers up, or (Take me
// there) reveal a pane it hides: they leave focus mode, so what they did shows.
const FOCUS_LEAVING_ACTIONS: ReadonlySet<MenuAction> = new Set<MenuAction>([
  'toggleViewMode',
  'toggleToc',
  'toggleFiles',
  'takeMeThere',
]);

const INITIAL_SETTINGS = loadSettings();
// Links are resolved as Windows paths there.
const WINDOWS = window.api.platform === 'win32';

// Windows opened via New/Open carry `?blank=1` so they start empty instead of
// showing the welcome document.
const START_BLANK = new URLSearchParams(window.location.search).has('blank');
const INITIAL_DOC =
  INITIAL_SETTINGS.showWelcomeOnLaunch && !START_BLANK ? welcomeContent : '';

// The TOC follows edits once typing pauses: walking a large document's syntax
// tree on every keystroke would slow typing down.
const TOC_DELAY_MS = 200;

// A text field other than the editor's text (a search box, a Settings field,
// the editor's Find panel), where Edit > Undo / Redo keep the browser's own
// history rather than the document's.
function isOtherTextField(el: Element | null, editor: EditorHandle | null): boolean {
  const field =
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable);
  return field && !editor?.view()?.contentDOM.contains(el);
}

setFormatMarkers({
  bold: INITIAL_SETTINGS.boldMarker,
  italic: INITIAL_SETTINGS.italicMarker,
  strike: INITIAL_SETTINGS.strikethroughMarker,
  underline: INITIAL_SETTINGS.underlineMarker,
});

applyTheme(INITIAL_SETTINGS.theme);

// Restore the saved zoom before React's first render so the UI doesn't paint
// at 100% first.
const INITIAL_ZOOM = setWindowZoom(INITIAL_SETTINGS.zoomFactor);

export default function App(): JSX.Element {
  const editorRef = useRef<EditorHandle>(null);
  const previewRef = useRef<PreviewHandle>(null);
  const statusBarRef = useRef<StatusBarHandle>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const [buffer, setBuffer] = useState(INITIAL_DOC);
  const [savedContent, setSavedContent] = useState(INITIAL_DOC);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'split' | 'tabs'>(INITIAL_SETTINGS.defaultView);
  const [activeTab, setActiveTab] = useState<'editor' | 'preview'>('editor');
  const [tocVisible, setTocVisible] = useState(true);
  // Only the editor on screen; a layer over the layout above, which it
  // leaves as it was for when focus mode ends.
  const [focusMode, setFocusMode] = useState(false);
  const [filesVisible, setFilesVisible] = useState(false);
  // The folder the Files panel shows; main keeps it per window.
  const [folder, setFolder] = useState<FolderListing | null>(null);
  const [ghMode, setGhMode] = useState(INITIAL_SETTINGS.ghOnByDefault);
  const [leftFraction, setLeftFraction] = useState(0.5);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(INITIAL_SETTINGS);
  const [banner, setBanner] = useState<BannerNotice | null>(null);
  // The file was deleted or moved away on disk: the buffer counts as unsaved
  // until it is written back (or the file reappears).
  const [fileMissing, setFileMissing] = useState(false);
  // Per window; every document opened or created starts with the default.
  const [autoSave, setAutoSave] = useState(INITIAL_SETTINGS.autoSaveOnOpen);
  const [autoSaveHold, setAutoSaveHold] = useState<AutoSaveHold | null>(null);
  // While recovered work's conflict with the file is open, the text the work
  // was made against. Crash-recovery copies keep it as their base (not the
  // file's newer text), so a reload or another crash before the user picks a
  // version still finds the conflict.
  const [recoveryBase, setRecoveryBase] = useState<string | null>(null);
  const autoSaveOnOpenRef = useLatest(settings.autoSaveOnOpen);
  // Bumped whenever another document takes the window's place (or Save As
  // moves this one), so the result of a save started before is ignored.
  const docGenRef = useRef(0);

  const dirty = buffer !== savedContent || fileMissing;
  const autoSaveStatus: AutoSaveStatus = !autoSave
    ? 'off'
    : filePath === null
      ? 'untitled'
      : fileMissing
        ? 'missing'
        : (autoSaveHold ?? 'on');

  // A disk conflict waiting for the user to pick a version. Its banner is the
  // only place to do that, so it comes back when a notice that replaced it
  // is cleared.
  const conflictNoticeRef = useRef<BannerNotice | null>(null);

  // One banner at a time; a feature replaces or clears only its own (by source).
  const showBanner = useCallback((notice: BannerNotice) => setBanner(notice), []);
  const clearBanner = useCallback(
    (...sources: string[]) =>
      setBanner((b) => {
        if (!b || !sources.includes(b.source)) return b;
        const conflict = conflictNoticeRef.current;
        return conflict !== b ? conflict : null;
      }),
    [],
  );

  const basePath = useMemo(() => {
    if (!filePath) return null;
    const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    return lastSep >= 0 ? filePath.slice(0, lastSep) : null;
  }, [filePath]);

  // The text the TOC lists. A document that takes the window's place shows
  // its TOC right away (see showDocument).
  const [tocDoc, setTocDoc] = useState(INITIAL_DOC);
  useEffect(() => {
    const id = window.setTimeout(() => setTocDoc(buffer), TOC_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [buffer]);

  const headings = useMemo<Heading[]>(() => {
    // The editor keeps its syntax tree up to date as the text changes; only
    // text it doesn't hold (before it mounts) needs a parse of its own.
    const view = editorRef.current?.view();
    const state =
      view && view.state.doc.toString() === tocDoc
        ? view.state
        : EditorState.create({ doc: tocDoc, extensions: buildLanguageExtensions() });
    return extractHeadings(state);
  }, [tocDoc]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${displayName(filePath)} — MDitor`;
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

  // Settings changed in another window apply here too (and aren't later
  // overwritten by this window's older copy).
  useEffect(() => onSettingsSaved(setSettings), []);

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
  const reuseInfoRef = useLatest({ buffer, savedContent, filePath });

  // Reuse the current window only when it holds nothing worth preserving: no
  // file open, no unsaved changes, and either empty or the untouched welcome
  // doc. Otherwise spawn a new window.
  const canReuseCurrentWindow = useCallback(() => {
    const info = reuseInfoRef.current;
    if (info.filePath !== null) return false;
    if (info.buffer !== info.savedContent) return false;
    return info.buffer.trim() === '' || info.buffer === welcomeContent;
  }, []);

  // Another document is taking the window's place: auto-save starts over from
  // the default, and saves still in flight for the old one no longer count.
  const beginDocument = useCallback((hold: AutoSaveHold | null = null) => {
    docGenRef.current++;
    conflictNoticeRef.current = null;
    setRecoveryBase(null);
    setAutoSave(autoSaveOnOpenRef.current);
    setAutoSaveHold(hold);
  }, []);

  // Make `content` this window's document in place of the current one (a file
  // opened, a new document, recovered work). Notices about the previous
  // document no longer apply.
  const showDocument = useCallback(
    ({
      path,
      content,
      saved = content,
      missing = false,
      hold = null,
    }: {
      path: string | null;
      content: string;
      /** What the file holds, when `content` is unsaved work. */
      saved?: string;
      missing?: boolean;
      hold?: AutoSaveHold | null;
    }) => {
      beginDocument(hold);
      setBuffer(content);
      setSavedContent(saved);
      setFilePath(path);
      setFileMissing(missing);
      setBanner(null);
      setTocDoc(content);
      editorRef.current?.replaceDocument(content);
      // Both panes start at the top of the new document.
      previewRef.current?.element()?.scrollTo({ top: 0 });
      editorRef.current?.focus();
    },
    [beginDocument],
  );

  // Show a file read from disk as this window's document.
  const loadDocument = useCallback(
    (file: FileResult) => showDocument({ path: file.path, content: file.content }),
    [showDocument],
  );

  const onNew = useCallback(() => {
    if (canReuseCurrentWindow()) {
      showDocument({ path: null, content: '' });
      return;
    }
    window.api.newWindow();
  }, [canReuseCurrentWindow, showDocument]);

  // While main opens a file that is to replace the document, typing would be
  // lost when it does, so the editor takes none. Counted: opens can overlap.
  const editLocksRef = useRef(0);
  const lockEditing = useCallback(() => {
    if (editLocksRef.current++ === 0) editorRef.current?.setReadOnly(true);
  }, []);
  const unlockEditing = useCallback(() => {
    if (--editLocksRef.current === 0) editorRef.current?.setReadOnly(false);
  }, []);

  const onOpen = useCallback(async () => {
    const inThisWindow = canReuseCurrentWindow();
    if (inThisWindow) lockEditing();
    try {
      if (inThisWindow) {
        const result = await window.api.openFile();
        if (result) loadDocument(result);
      } else {
        await window.api.openInNewWindow();
      }
    } catch (err) {
      showBanner({
        source: 'open',
        kind: 'error',
        message: `Couldn’t open the file: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('open'),
      });
    } finally {
      if (inThisWindow) unlockEditing();
    }
  }, [canReuseCurrentWindow, loadDocument, lockEditing, unlockEditing, showBanner, clearBanner]);

  // Open a file by path (Open Recent, and any other UI that names a file):
  // here when this window holds nothing worth keeping, else in a new window.
  // Main focuses the window that already shows it instead. `inThisWindow`
  // overrides the choice (several files dropped at once: only the first may
  // take this window's place).
  const reportOpenError = useCallback(
    (path: string, err: unknown) => {
      showBanner({
        source: 'open',
        kind: 'error',
        message: `Couldn’t open ${fileName(path)}: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('open'),
      });
    },
    [showBanner, clearBanner],
  );

  const openPath = useCallback(
    async (path: string, inThisWindow = canReuseCurrentWindow()) => {
      if (inThisWindow) lockEditing();
      try {
        const file = await window.api.openPath({ path, inThisWindow });
        if (file) loadDocument(file);
      } catch (err) {
        reportOpenError(path, err);
      } finally {
        if (inThisWindow) unlockEditing();
      }
    },
    [canReuseCurrentWindow, loadDocument, reportOpenError, lockEditing, unlockEditing],
  );

  // The file now matches the buffer, so notices about it changing, vanishing,
  // failing to save or not existing yet are moot, and a paused auto-save can
  // carry on.
  const markSaved = useCallback(
    (path: string, content: string) => {
      setFilePath(path);
      setSavedContent(content);
      setFileMissing(false);
      setAutoSaveHold(null);
      setRecoveryBase(null);
      conflictNoticeRef.current = null;
      clearBanner('disk', 'save', 'autosave', 'recovery', 'imageUntitled');
    },
    [clearBanner],
  );

  const reportSaveError = useCallback(
    (err: unknown) => {
      showBanner({
        source: 'save',
        kind: 'error',
        message: `Couldn’t save: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('save'),
      });
    },
    [showBanner, clearBanner],
  );

  // Resolves false when the user cancels or the write fails (shown in a banner),
  // when the file changed on disk first (shown as a conflict), or when another
  // document took the window's place meanwhile.
  const onSave = useCallback(async (): Promise<boolean> => {
    const content = editorRef.current?.getContent() ?? buffer;
    const gen = docGenRef.current;
    try {
      if (!filePath) {
        const result = await window.api.saveFileAs({ content });
        if (!result || gen !== docGenRef.current) return false;
        markSaved(result.path, content);
        return true;
      }
      const result = await window.api.saveFile({ path: filePath, content });
      if (gen !== docGenRef.current || result.conflict) return false;
      markSaved(filePath, content);
      return true;
    } catch (err) {
      if (gen === docGenRef.current) reportSaveError(err);
      return false;
    }
  }, [buffer, filePath, markSaved, reportSaveError]);

  const onSaveAs = useCallback(async () => {
    const content = editorRef.current?.getContent() ?? buffer;
    const suggested = filePath ? fileName(filePath) : 'Untitled.md';
    const gen = docGenRef.current;
    try {
      const result = await window.api.saveFileAs({ content, suggestedName: suggested });
      if (!result || gen !== docGenRef.current) return;
      // The document lives in the new file now; a save still in flight for
      // the old one mustn't point the window back there.
      docGenRef.current++;
      markSaved(result.path, content);
    } catch (err) {
      if (gen === docGenRef.current) reportSaveError(err);
    }
  }, [buffer, filePath, markSaved, reportSaveError]);

  const onSaveAndQuit = useCallback(async () => {
    if (await onSave()) window.api.confirmQuit();
  }, [onSave]);

  // Vim's :w / :q family. Closing goes through main's close flow, so :q asks
  // about unsaved changes like the close button. After a save went through
  // there's nothing to ask about, though main may not have heard yet that
  // the document is clean.
  const onVimCommand = useCallback(
    async (command: VimCommand) => {
      if (command === 'write') {
        await onSave();
      } else if (command === 'quit' || command === 'forceQuit') {
        window.api.closeWindow(command === 'forceQuit');
      } else if (command === 'exit' && !dirty) {
        window.api.closeWindow();
      } else if (await onSave()) {
        window.api.closeWindow(true);
      }
    },
    [dirty, onSave],
  );

  const onAutoSaveError = useCallback(
    (err: unknown, retry: () => void) => {
      // Paused until the user acts, rather than failing (and re-raising the
      // banner) on every pause in typing.
      setAutoSaveHold('failed');
      showBanner({
        source: 'autosave',
        kind: 'error',
        message: `Auto-save failed: ${errorMessage(err)}`,
        actions: [
          { label: 'Retry', primary: true, onClick: retry },
          {
            label: 'Turn off auto-save',
            onClick: () => {
              setAutoSave(false);
              setAutoSaveHold(null);
              clearBanner('autosave');
            },
          },
        ],
      });
    },
    [showBanner, clearBanner],
  );

  const flushAutoSave = useAutoSave({
    active: autoSaveStatus === 'on',
    buffer,
    savedContent,
    filePath,
    docGen: docGenRef,
    onSaved: markSaved,
    onError: onAutoSaveError,
  });

  // Latest document state for navigateToFile, which stays stable so the Files
  // panel doesn't re-render on every keystroke.
  const navInfoRef = useLatest({ dirty, autoSaveOn: autoSaveStatus === 'on', onSave });
  const navigatingRef = useRef(false);

  // Show the Markdown file at `path` in this window in place of the current
  // document (Files panel; links between documents). Unsaved changes are
  // saved first when auto-save is on, else the user chooses. A window that
  // already shows the file is brought forward instead. Resolves whether this
  // window now shows the file.
  const navigateToFile = useCallback(
    async (path: string): Promise<boolean> => {
      // One at a time: main makes each file it reads this window's document,
      // so overlapping loads could leave main and the editor disagreeing.
      if (navigatingRef.current) return false;
      navigatingRef.current = true;
      // From here, edits would miss the save below or be lost to the new file.
      lockEditing();
      try {
        if (await window.api.focusFileWindow(path)) {
          editorRef.current?.focus();
          return false;
        }
        // Settled before main reads the new file: from then on it refuses to
        // save to the old one.
        const { dirty: unsaved, autoSaveOn, onSave: save } = navInfoRef.current;
        if (unsaved) {
          if (autoSaveOn) {
            if (!(await flushAutoSave())) return false;
          } else {
            const choice = await window.api.confirmDiscard();
            if (choice === 'cancel' || (choice === 'save' && !(await save()))) return false;
          }
        }
        const file = await window.api.openPath({ path, inThisWindow: true });
        if (!file) return false;
        loadDocument(file);
        return true;
      } catch (err) {
        reportOpenError(path, err);
        return false;
      } finally {
        navigatingRef.current = false;
        unlockEditing();
      }
    },
    [flushAutoSave, loadDocument, reportOpenError, lockEditing, unlockEditing],
  );

  const onOpenFolder = useCallback(async () => {
    try {
      const listing = await window.api.openFolder();
      if (!listing) return;
      setFolder(listing);
      setFilesVisible(true);
      // Focus mode hides the Files panel; a canceled dialog leaves it on.
      setFocusMode(false);
      clearBanner('folder');
    } catch (err) {
      showBanner({
        source: 'folder',
        kind: 'error',
        message: `Couldn’t open the folder: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('folder'),
      });
    }
  }, [showBanner, clearBanner]);

  // A listing for a folder the panel no longer shows (closed or replaced
  // meanwhile) is stale.
  const applyListing = useCallback((listing: FolderListing | null) => {
    setFolder((f) => (listing === null ? null : f?.root === listing.root ? listing : f));
  }, []);

  const onRefreshFolder = useCallback(async () => {
    try {
      applyListing(await window.api.listFolder());
    } catch (err) {
      console.warn('Could not list the folder:', err);
    }
  }, [applyListing]);

  const onCloseFolder = useCallback(() => {
    window.api.closeFolder();
    setFolder(null);
  }, []);

  const onToggleFiles = useCallback(() => setFilesVisible((v) => !v), []);

  const onToggleAutoSave = useCallback(() => {
    setAutoSave((on) => !on);
    // Toggling is a fresh go-ahead, except that a disk conflict is still
    // the user's to settle (Reload, Keep my version, or Save).
    setAutoSaveHold((h) => (h === 'conflict' ? h : null));
    clearBanner('autosave');
  }, [clearBanner]);

  const reportExportError = useCallback(
    (action: string, err: unknown) => {
      showBanner({
        source: 'export',
        kind: 'error',
        message: `Couldn’t ${action}: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('export'),
      });
    },
    [showBanner, clearBanner],
  );

  const onExportPdf = useCallback(async () => {
    const host = previewRef.current?.element();
    if (!host?.innerHTML.trim()) return;
    try {
      const result = await exportPreviewToPdf(host, filePath);
      if (!result) return;
      clearBanner('export');
      flashStatus(`Exported to ${fileName(result.path)}`);
    } catch (err) {
      reportExportError('export to PDF', err);
    }
  }, [filePath, clearBanner, reportExportError]);

  const onExportHtml = useCallback(async () => {
    const host = previewRef.current?.element();
    if (!host?.innerHTML.trim()) return;
    try {
      const result = await exportPreviewToHtml(host, filePath);
      if (!result) return;
      clearBanner('export');
      flashStatus(`Exported to ${fileName(result.path)}`);
    } catch (err) {
      reportExportError('export to HTML', err);
    }
  }, [filePath, clearBanner, reportExportError]);

  const onCopyRichText = useCallback(async () => {
    const host = previewRef.current?.element();
    if (!host) return;
    try {
      const copied = await copyPreviewAsRichText(host, editorRef.current?.getContent() ?? '');
      clearBanner('export');
      flashStatus(copied ? 'Copied as rich text' : 'Nothing to copy');
    } catch (err) {
      reportExportError('copy as rich text', err);
    }
  }, [clearBanner, reportExportError]);

  const onInsertFiles = useImagePaste({
    filePath,
    imageFolder: settings.imageFolder,
    docGen: docGenRef,
    openPath,
    // Its own source, so that saving clears it but not an error about adding images.
    onUntitled: () =>
      showBanner({
        source: 'imageUntitled',
        kind: 'info',
        message: 'Save this document first so pasted images have a folder to go in.',
        actions: [
          {
            label: 'Save As…',
            primary: true,
            onClick: () => {
              clearBanner('imageUntitled');
              void onSaveAs();
            },
          },
        ],
        onDismiss: () => clearBanner('imageUntitled'),
      }),
    onError: (err) =>
      showBanner({
        source: 'image',
        kind: 'error',
        message: `Couldn’t add the image: ${errorMessage(err)}`,
        onDismiss: () => clearBanner('image'),
      }),
    onAdded: () => clearBanner('image', 'imageUntitled'),
  });

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

  const onToggleScrollSync = useCallback(() => {
    const on = !settings.scrollSync;
    setSettings((s) => ({ ...s, scrollSync: on }));
    flashStatus(on ? 'Sync scrolling on' : 'Sync scrolling off');
  }, [settings.scrollSync]);

  const onToggleWelcomeOnLaunch = useCallback(() => {
    const on = !settings.showWelcomeOnLaunch;
    setSettings((s) => ({ ...s, showWelcomeOnLaunch: on }));
    flashStatus(on ? 'Welcome document shows on launch' : 'Welcome document won’t show on launch');
  }, [settings.showWelcomeOnLaunch]);

  const onToggleFocusMode = useCallback(() => setFocusMode((on) => !on), []);

  const onToggleTypewriter = useCallback(() => {
    const on = !settings.typewriterMode;
    setSettings((s) => ({ ...s, typewriterMode: on }));
    flashStatus(on ? 'Typewriter mode on' : 'Typewriter mode off');
  }, [settings.typewriterMode]);

  const scrollSync = useScrollSync(
    editorRef,
    previewRef,
    settings.scrollSync && viewMode === 'split' && !focusMode,
    focusMode ? 'editor' : viewMode === 'tabs' ? activeTab : null,
  );
  const { hold: holdScrollSync } = scrollSync;

  const onSelectHeading = useCallback(
    (h: Heading, index: number) => {
      // Each pane brings the heading to its top on its own.
      holdScrollSync();
      editorRef.current?.scrollToLine(h.line);
      previewRef.current?.scrollToHeading(index);
    },
    [holdScrollSync],
  );

  // Latest document state for following links, which stays stable so the
  // editor and preview don't get a new handler on every keystroke.
  const linkInfoRef = useLatest({ filePath, headings });

  // Follow a link clicked in the preview, or Cmd/Ctrl-clicked in the editor.
  const followLink = useCallback(
    async (href: string, from: 'editor' | 'preview') => {
      const { filePath: current, headings: shown } = linkInfoRef.current;
      let target = classifyLink(href, current, WINDOWS);
      // A link to this very document is one to a place in it.
      if (
        target.kind === 'document' &&
        current !== null &&
        pathKey(target.path) === pathKey(current)
      ) {
        target = { kind: 'anchor', fragment: target.fragment };
      }
      switch (target.kind) {
        case 'anchor': {
          const { fragment } = target;
          // A click in the preview scrolls it, and scroll sync brings the
          // editor along; from the editor, both panes go to the heading.
          const index = from === 'editor' && fragment ? headingIndexForFragment(shown, fragment) : -1;
          if (index >= 0) {
            onSelectHeading(shown[index]!, index);
            return;
          }
          if (from === 'editor') {
            holdScrollSync();
            if (!fragment) editorRef.current?.scrollToLine(1);
          }
          if (!previewRef.current?.scrollToAnchor(fragment)) {
            flashStatus(`No “#${fragment}” in this document`);
          }
          return;
        }
        case 'external':
          if (!(await window.api.openExternal(target.url))) flashStatus('Can’t open this link');
          return;
        case 'document': {
          const { path, fragment } = target;
          if (!(await navigateToFile(path)) || !fragment) return;
          // The new document is in the editor already; the preview scrolls
          // once it has rendered it.
          const view = editorRef.current?.view();
          if (!view) return;
          const headingsThere = extractHeadings(view.state);
          const index = headingIndexForFragment(headingsThere, fragment);
          if (index < 0) {
            flashStatus(`No heading “#${fragment}” in ${fileName(path)}`);
            return;
          }
          holdScrollSync();
          editorRef.current?.scrollToLine(headingsThere[index]!.line);
          previewRef.current?.scrollToHeading(index, view.state.doc.toString());
          return;
        }
        case 'file':
          try {
            const result = await window.api.openLinkedFile({
              documentPath: current,
              target: target.target,
            });
            if (result === 'revealed') {
              flashStatus(`Showing ${fileName(target.target)} in its folder`);
            }
          } catch (err) {
            reportOpenError(target.target, err);
          }
          return;
        case 'untitled':
          flashStatus('Save the document first: its links are relative to its folder');
          return;
        case 'unsupported':
          flashStatus('Can’t open this link');
      }
    },
    [onSelectHeading, holdScrollSync, navigateToFile, reportOpenError],
  );
  const onEditorLink = useCallback((href: string) => void followLink(href, 'editor'), [followLink]);
  const onPreviewLink = useCallback((href: string) => void followLink(href, 'preview'), [followLink]);

  // Link completion lists the folders next to the document; an untitled one has none.
  const listLinkDirectory = useMemo(
    () =>
      filePath === null
        ? undefined
        : (dir: string) => window.api.listLinkDirectory({ documentPath: filePath, dir }),
    [filePath],
  );

  const onToggleTask = useCallback(
    (index: number, total: number, checked: boolean) =>
      editorRef.current?.setTaskChecked(index, total, checked) ?? false,
    [],
  );

  // Cursor moves go straight to the status bar rather than through App state,
  // so they don't re-render the whole window.
  const onSelectionChange = useCallback(
    (info: SelectionInfo) => statusBarRef.current?.setSelection(info),
    [],
  );

  const [lintCounts, setLintCounts] = useState<LintCounts>({ warnings: 0, infos: 0 });
  const onLintChange = useCallback(
    (counts: LintCounts) =>
      setLintCounts((c) =>
        c.warnings === counts.warnings && c.infos === counts.infos ? c : counts,
      ),
    [],
  );

  const onToggleLintPanel = useCallback(() => {
    // The list sits under the editor, which the Preview tab hides.
    if (viewMode === 'tabs' && activeTab === 'preview') {
      setActiveTab('editor');
      requestAnimationFrame(() => editorRef.current?.toggleLintPanel(true));
    } else {
      editorRef.current?.toggleLintPanel();
    }
  }, [viewMode, activeTab]);

  const persistZoom = useCallback(
    (zoomFactor: number) =>
      setSettings((s) => (sameZoom(s.zoomFactor, zoomFactor) ? s : { ...s, zoomFactor })),
    [],
  );
  const { zoom, zoomIn, zoomOut, zoomReset } = useZoom(INITIAL_ZOOM, persistZoom);

  const previewFontScale = normalizePreviewFont(settings.previewFontScale);
  const setPreviewFont = useCallback(
    (next: (current: number) => number) =>
      setSettings((s) => {
        const scale = next(normalizePreviewFont(s.previewFontScale));
        return scale === s.previewFontScale ? s : { ...s, previewFontScale: scale };
      }),
    [],
  );
  const previewFontBigger = useCallback(() => setPreviewFont((f) => stepPreviewFont(f, 1)), [setPreviewFont]);
  const previewFontSmaller = useCallback(() => setPreviewFont((f) => stepPreviewFont(f, -1)), [setPreviewFont]);
  const previewFontReset = useCallback(() => setPreviewFont(() => 1), [setPreviewFont]);
  const previewFontControls = (
    <PreviewFontControls
      scale={previewFontScale}
      onBigger={previewFontBigger}
      onSmaller={previewFontSmaller}
      onReset={previewFontReset}
    />
  );

  const onShowShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const onCloseShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const onShowSettings = useCallback(() => setSettingsOpen(true), []);
  const onCloseSettings = useCallback(() => setSettingsOpen(false), []);

  const onFind = useCallback(() => {
    // The preview is read-only, so when it's the visible pane route Find to the
    // preview's own text search instead of the editor's search panel.
    if (viewMode === 'tabs' && activeTab === 'preview' && !focusMode) {
      previewRef.current?.openSearch();
      return;
    }
    const view = editorRef.current?.view();
    if (!view) return;
    view.focus();
    openSearchPanel(view);
  }, [viewMode, activeTab, focusMode]);

  const onTakeMeThere = useCallback(
    (coords?: { x: number; y: number }) => {
      if (!coords) return;
      // The target pane is scrolled to the match; the clicked one stays put.
      holdScrollSync();
      const { x, y } = coords;
      const within = (el: HTMLElement | null | undefined): boolean => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        // A display:none pane (tabs mode) has a zero rect, so this never
        // matches the hidden pane.
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };

      if (within(editorRef.current?.view()?.dom)) {
        const ctx = editorRef.current?.contextAtCoords(x, y) ?? {
          line: 1,
          text: '',
          before: '',
          after: '',
        };
        let idx = 0;
        for (let i = 0; i < headings.length; i++) {
          if (headings[i]!.line <= ctx.line) idx = i;
          else break;
        }
        previewRef.current?.revealText({
          before: ctx.before,
          after: ctx.after,
          line: ctx.line,
          snippet: ctx.text,
          headingIndex: idx,
        });
        if (viewMode === 'tabs') setActiveTab('preview');
      } else if (within(previewRef.current?.element())) {
        const idx = previewRef.current?.headingIndexAtCoords(x, y) ?? 0;
        const ctx = previewRef.current?.contextAtCoords(x, y);
        const headingLine = headings[idx]?.line ?? 1;
        editorRef.current?.revealSource({
          before: ctx?.before ?? '',
          after: ctx?.after ?? '',
          snippet: ctx?.snippet ?? '',
          nearLine: ctx?.line ?? headingLine,
          fallbackLine: headingLine,
        });
        if (viewMode === 'tabs') setActiveTab('editor');
      }
    },
    [headings, viewMode, holdScrollSync],
  );

  useEffect(() => {
    const off = window.api.onMenuAction((action, payload) => {
      if (FOCUS_LEAVING_ACTIONS.has(action)) setFocusMode(false);
      switch (action) {
        case 'newFile':
          void onNew();
          break;
        case 'openFile':
          void onOpen();
          break;
        case 'openRecent':
          void openPath(payload.path);
          break;
        case 'openFolder':
          void onOpenFolder();
          break;
        case 'toggleFiles':
          onToggleFiles();
          break;
        case 'save':
          void onSave();
          break;
        case 'saveAs':
          void onSaveAs();
          break;
        case 'toggleAutoSave':
          onToggleAutoSave();
          break;
        case 'exportPdf':
          void onExportPdf();
          break;
        case 'exportHtml':
          void onExportHtml();
          break;
        case 'copyRichText':
          void onCopyRichText();
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
        case 'toggleScrollSync':
          onToggleScrollSync();
          break;
        case 'toggleFocusMode':
          onToggleFocusMode();
          break;
        case 'toggleTypewriter':
          onToggleTypewriter();
          break;
        case 'undo':
        case 'redo':
          if (isOtherTextField(document.activeElement, editorRef.current)) {
            document.execCommand(action);
          } else {
            editorRef.current?.[action]();
          }
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
        case 'insertTable':
          // It also declines while a document on its way locks editing.
          if (editorRef.current?.insertTable() === false && editLocksRef.current === 0) {
            flashStatus('Can’t insert a table inside an unclosed code block');
          }
          break;
        case 'formatTable':
          if (!editorRef.current?.formatTable()) flashStatus('No table at the cursor');
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
        case 'toggleWelcomeOnLaunch':
          onToggleWelcomeOnLaunch();
          break;
        case 'zoomIn':
          zoomIn();
          break;
        case 'zoomOut':
          zoomOut();
          break;
        case 'zoomReset':
          zoomReset();
          break;
        case 'previewFontBigger':
          previewFontBigger();
          break;
        case 'previewFontSmaller':
          previewFontSmaller();
          break;
        case 'previewFontReset':
          previewFontReset();
          break;
        case 'takeMeThere':
          onTakeMeThere(payload);
          break;
        default: {
          // Every MenuAction must be handled above.
          const unhandled: never = action;
          console.warn('Unhandled menu action:', unhandled);
        }
      }
    });
    return off;
  }, [
    onNew,
    onOpen,
    openPath,
    onOpenFolder,
    onToggleFiles,
    onSave,
    onSaveAs,
    onExportPdf,
    onExportHtml,
    onCopyRichText,
    onSaveAndQuit,
    onToggleAutoSave,
    onToggleToc,
    onToggleViewMode,
    onToggleGh,
    onToggleScrollSync,
    onToggleFocusMode,
    onToggleTypewriter,
    onFind,
    onShowShortcuts,
    onShowSettings,
    onToggleWelcomeOnLaunch,
    onTakeMeThere,
    zoomIn,
    zoomOut,
    zoomReset,
    previewFontBigger,
    previewFontSmaller,
    previewFontReset,
  ]);

  useEffect(() => window.api.onOpenFromOS(loadDocument), [loadDocument]);

  // Main relists the folder as its files change.
  useEffect(() => window.api.onFolderChange(applyListing), [applyListing]);

  // A folder this window had open survives a reload of the page.
  useEffect(() => {
    let cancelled = false;
    void window.api.listFolder().then(
      (listing) => {
        if (cancelled || !listing) return;
        setFolder((f) => f ?? listing);
        setFilesVisible(true);
      },
      (err) => console.warn('Could not list the folder:', err),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Tell main which file this window shows so it watches it for outside
  // changes. The untitled state a window starts in isn't reported: main
  // already resets on page load, and a late report could race the file main
  // is delivering to a new window.
  const reportedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (filePath === reportedPathRef.current) return;
    reportedPathRef.current = filePath;
    window.api.watchFile(filePath);
  }, [filePath]);

  // Latest state for the disk-change listener, which subscribes once.
  const diskInfoRef = useLatest({ filePath, savedContent, onSave, onSaveAs });

  // Either answer to a disk conflict lets auto-save carry on.
  const settleConflict = useCallback(() => {
    conflictNoticeRef.current = null;
    setRecoveryBase(null);
    setAutoSaveHold((h) => (h === 'conflict' ? null : h));
    clearBanner('disk');
  }, [clearBanner]);

  const takeDiskVersion = useCallback(
    (content: string) => {
      editorRef.current?.applyExternalContent(content);
      setSavedContent(content);
      settleConflict();
    },
    [settleConflict],
  );

  // Until the user picks a version, auto-save mustn't decide for them.
  const raiseConflict = useCallback(
    (notice: BannerNotice) => {
      setAutoSaveHold('conflict');
      conflictNoticeRef.current = notice;
      showBanner(notice);
    },
    [showBanner],
  );

  useEffect(() => {
    return window.api.onDiskChange((change) => {
      const { filePath: current, savedContent: saved } = diskInfoRef.current;
      const editor = editorRef.current;
      if (change.path !== current || !editor) return;
      const name = fileName(change.path);

      if (change.kind === 'deleted') {
        setFileMissing(true);
        // Nothing on disk to reload any more.
        conflictNoticeRef.current = null;
        showBanner({
          source: 'disk',
          kind: 'warning',
          message: `${name} was deleted or moved.`,
          actions: [
            { label: 'Save', primary: true, onClick: () => void diskInfoRef.current.onSave() },
            { label: 'Dismiss', onClick: () => clearBanner('disk') },
          ],
        });
        return;
      }

      setFileMissing(false);
      const reload = () => takeDiskVersion(change.content);
      // Take the disk version silently when there's nothing of the user's to
      // lose: the buffer has no unsaved edits, or already matches the file.
      const text = editor.getContent();
      if (text === saved || text === change.content) {
        reload();
        return;
      }
      raiseConflict({
        source: 'disk',
        kind: 'warning',
        message: `${name} changed on disk.`,
        actions: [
          { label: 'Reload', primary: true, onClick: reload },
          // Main already counts this disk content as seen, so it isn't
          // reported again; the next save overwrites it.
          { label: 'Keep my version', onClick: settleConflict },
        ],
      });
    });
  }, [showBanner, clearBanner, settleConflict, takeDiskVersion, raiseConflict]);

  // Unsaved work main kept for this window (from a crashed session, or from
  // before the page reloaded) becomes the document again, still unsaved.
  const restoreRecovered = useCallback(
    (doc: RecoveredDocument) => {
      // A window that meanwhile got a document of its own keeps it.
      if (!canReuseCurrentWindow()) return;
      const disk = doc.diskContent;
      // There but unreadable isn't missing: Save won't write over it.
      const unreadable = doc.diskUnreadable;
      const missing = doc.path !== null && disk === null && unreadable === undefined;
      const saved = disk ?? '';
      const unsaved = missing || unreadable !== undefined || doc.content !== saved;
      // The file was changed elsewhere after these edits were made: saving
      // them as they are would undo that, so the user picks a version first.
      const changedSince = unsaved && disk !== null && doc.base !== undefined && disk !== doc.base;
      // Otherwise auto-save waits until the user has saved the recovered text once.
      showDocument({
        path: doc.path,
        content: doc.content,
        saved,
        missing,
        hold: changedSince ? 'conflict' : unsaved ? 'recovered' : null,
      });
      if (!unsaved) return;
      if (changedSince) {
        // After showDocument, which clears it.
        setRecoveryBase(doc.base!);
        const name = displayName(doc.path);
        raiseConflict({
          source: 'disk',
          kind: 'warning',
          message: `Recovered unsaved changes, but ${name} changed on disk after they were made.`,
          actions: [
            { label: 'Keep recovered', primary: true, onClick: settleConflict },
            { label: 'Use disk version', onClick: () => takeDiskVersion(disk) },
          ],
        });
        return;
      }
      const recovered = doc.afterCrash
        ? 'Recovered unsaved changes from a previous session'
        : 'Recovered unsaved changes';
      if (unreadable !== undefined) {
        showBanner({
          source: 'recovery',
          kind: 'warning',
          message: `${recovered}, but ${displayName(doc.path)} can’t be read: ${unreadable.replace(/\.$/, '')}. Use Save As to keep them.`,
          actions: [
            {
              label: 'Save As…',
              primary: true,
              onClick: () => void diskInfoRef.current.onSaveAs(),
            },
          ],
          onDismiss: () => clearBanner('recovery'),
        });
        return;
      }
      showBanner({
        source: 'recovery',
        // Not 'info': auto-save is paused until it's saved, so it stays in focus mode.
        kind: 'warning',
        message: `${recovered}.`,
        actions: [
          { label: 'Save', primary: true, onClick: () => void diskInfoRef.current.onSave() },
        ],
        onDismiss: () => clearBanner('recovery'),
      });
    },
    [
      canReuseCurrentWindow,
      showDocument,
      showBanner,
      clearBanner,
      settleConflict,
      takeDiskVersion,
      raiseConflict,
    ],
  );

  useCrashRecovery(
    { buffer, savedContent: recoveryBase ?? savedContent, filePath, dirty },
    restoreRecovered,
  );

  // A recovered document that became clean some other way (undone back to the
  // file's text, or the file now holds the same) has nothing left to save.
  useEffect(() => {
    if (dirty) return;
    setAutoSaveHold((h) => (h === 'recovered' ? null : h));
    clearBanner('recovery');
  }, [dirty, clearBanner]);

  useEffect(() => {
    window.api.setDirty(dirty, autoSaveStatus === 'on');
  }, [dirty, autoSaveStatus]);

  useEffect(() => {
    window.api.setVimMode(settings.vimMode);
  }, [settings.vimMode]);

  // The menu's checkmarks show the focused window's toggles.
  useEffect(() => {
    window.api.setMenuToggles({
      autoSave,
      filesPanel: filesVisible,
      toc: tocVisible,
      gh: ghMode,
      scrollSync: settings.scrollSync,
      focusMode,
      typewriter: settings.typewriterMode,
      welcomeOnLaunch: settings.showWelcomeOnLaunch,
      viewMode,
    });
  }, [
    autoSave,
    filesVisible,
    tocVisible,
    ghMode,
    settings.scrollSync,
    focusMode,
    settings.typewriterMode,
    settings.showWelcomeOnLaunch,
    viewMode,
  ]);

  // Entering focus mode hands the keyboard to the editor (it may have been
  // the hidden tab); leaving it for the Preview tab takes the keyboard back.
  const focusModeShownRef = useRef(focusMode);
  useEffect(() => {
    if (focusModeShownRef.current === focusMode) return;
    focusModeShownRef.current = focusMode;
    if (focusMode) editorRef.current?.focus();
    else if (viewMode === 'tabs' && activeTab === 'preview') {
      editorRef.current?.view()?.contentDOM.blur();
    }
  }, [focusMode, viewMode, activeTab]);

  // Escape leaves focus mode when nothing else wants it: not what the editor
  // used it for (closing search or completions, collapsing a selection), not
  // a dialog, and never with Vim keys, whose Normal mode it is.
  useEffect(() => {
    if (!focusMode || settings.vimMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // The flags as well as the page: a dialog closing on this same key may
      // already be gone from it.
      if (shortcutsOpen || settingsOpen || document.querySelector('[aria-modal="true"]')) return;
      const view = editorRef.current?.view();
      if (view && editorClaimsEscape(view.state)) return;
      e.preventDefault();
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, settings.vimMode, shortcutsOpen, settingsOpen]);

  // Fractions of what the divider leaves, so the panes never overflow the window.
  const workspaceStyle: CSSProperties =
    viewMode === 'split'
      ? {
          gridTemplateColumns: `minmax(0, ${leftFraction}fr) 6px minmax(0, ${1 - leftFraction}fr)`,
        }
      : {};

  return (
    <div className={`app ${tocVisible ? 'with-toc' : ''} ${focusMode ? 'focus-mode' : ''}`}>
      <Toolbar
        filePath={filePath}
        dirty={dirty}
        autoSaveStatus={autoSaveStatus}
        viewMode={viewMode}
        filesVisible={filesVisible}
        tocVisible={tocVisible}
        ghMode={ghMode}
        onNew={onNew}
        onOpen={() => void onOpen()}
        onSave={() => void onSave()}
        onSaveAs={() => void onSaveAs()}
        onToggleAutoSave={onToggleAutoSave}
        onToggleViewMode={onToggleViewMode}
        onToggleFiles={onToggleFiles}
        onToggleToc={onToggleToc}
        onToggleGh={onToggleGh}
        onShowShortcuts={onShowShortcuts}
        onShowSettings={onShowSettings}
      />
      {banner && <Banner key={banner.source} {...banner} />}
      <div className="main">
        {/* One column, Files above the TOC, so the panes keep their width. */}
        <div className="sidebar" hidden={!filesVisible && !tocVisible}>
          {(filesVisible || folder) && (
            <FilesPanel
              folder={folder}
              currentPath={filePath}
              hidden={!filesVisible}
              onOpenFolder={onOpenFolder}
              onRefresh={onRefreshFolder}
              onCloseFolder={onCloseFolder}
              onOpenFile={navigateToFile}
            />
          )}
          {tocVisible && <Toc headings={headings} onSelect={onSelectHeading} />}
        </div>
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
              {activeTab === 'preview' && (
                <div className="tab-strip-actions">{previewFontControls}</div>
              )}
            </div>
          )}
          <div
            ref={workspaceRef}
            className={`workspace mode-${viewMode} active-${activeTab}`}
            style={workspaceStyle}
          >
            <div className="workspace-pane workspace-editor">
              {viewMode === 'split' && (
                <PaneHeader
                  label="Editor"
                  onOpenInTab={() => onPopToTab('editor')}
                  scrollSync={settings.scrollSync}
                  onToggleScrollSync={onToggleScrollSync}
                />
              )}
              <Editor
                ref={editorRef}
                initialDoc={INITIAL_DOC}
                onChange={setBuffer}
                onSelectionChange={onSelectionChange}
                onInsertFiles={onInsertFiles}
                vimMode={settings.vimMode}
                onVimCommand={onVimCommand}
                focusMode={focusMode}
                typewriterMode={settings.typewriterMode}
                lintEnabled={settings.lintEnabled}
                documentPath={filePath}
                onLintChange={onLintChange}
                onFollowLink={onEditorLink}
                listLinkDirectory={listLinkDirectory}
                onScrollIntoView={scrollSync.onEditorScrollIntoView}
              />
            </div>
            <div
              className="workspace-divider"
              onMouseDown={startDrag}
              role="separator"
              aria-orientation="vertical"
            />
            <div className="workspace-pane workspace-preview">
              {viewMode === 'split' && (
                <PaneHeader
                  label="Preview"
                  onOpenInTab={() => onPopToTab('preview')}
                  scrollSync={settings.scrollSync}
                  onToggleScrollSync={onToggleScrollSync}
                >
                  {previewFontControls}
                </PaneHeader>
              )}
              <Preview
                ref={previewRef}
                source={buffer}
                ghMode={ghMode}
                basePath={basePath}
                fontScale={previewFontScale}
                onToggleTask={onToggleTask}
                onLayoutChange={scrollSync.onPreviewLayout}
                onFollowLink={onPreviewLink}
              />
            </div>
          </div>
        </div>
        {/* In here, below a banner that focus mode still shows. */}
        {focusMode && (
          <FocusExit onExit={() => setFocusMode(false)} escapeExits={!settings.vimMode} />
        )}
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={onCloseShortcuts} />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={onCloseSettings}
      />
      <StatusBar ref={statusBarRef} doc={buffer} zoomFactor={zoom} onResetZoom={zoomReset}>
        <LintStatus counts={lintCounts} onClick={onToggleLintPanel} />
      </StatusBar>
    </div>
  );
}

function PaneHeader({
  label,
  onOpenInTab,
  scrollSync,
  onToggleScrollSync,
  children,
}: {
  label: string;
  onOpenInTab: () => void;
  scrollSync: boolean;
  onToggleScrollSync: () => void;
  /** Pane-specific buttons, before the shared ones. */
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="pane-header">
      <span className="pane-header-label">{label}</span>
      <div className="pane-header-actions">
        {children}
        <button
          type="button"
          className={`pane-sync ${scrollSync ? 'active' : ''}`}
          onClick={onToggleScrollSync}
          aria-pressed={scrollSync}
          title="Sync scrolling"
          aria-label="Sync scrolling"
        >
          {/* Two panes' scroll arrows, moving together. */}
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4.5 2.5v11M2.5 4.5l2-2 2 2M2.5 11.5l2 2 2-2" />
            <path d="M11.5 2.5v11M9.5 4.5l2-2 2 2M9.5 11.5l2 2 2-2" />
          </svg>
        </button>
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
    </div>
  );
}

/** Smaller / Bigger buttons for the preview's text, with its size when it isn't 100% (click to reset). */
function PreviewFontControls({
  scale,
  onBigger,
  onSmaller,
  onReset,
}: {
  scale: number;
  onBigger: () => void;
  onSmaller: () => void;
  onReset: () => void;
}): JSX.Element {
  const percent = `${Math.round(scale * 100)}%`;
  return (
    <div className="preview-font" role="group" aria-label="Preview text size">
      <button
        type="button"
        className="preview-font-btn"
        onClick={onSmaller}
        title={`Smaller preview text (${shortcut('Mod+Alt+-')})`}
        aria-label="Smaller preview text"
      >
        A<span className="preview-font-sign">−</span>
      </button>
      {!isDefaultPreviewFont(scale) && (
        <button
          type="button"
          className="preview-font-size"
          onClick={onReset}
          title={`Preview text ${percent}. Click to reset to 100% (${shortcut('Mod+Alt+0')})`}
        >
          {percent}
        </button>
      )}
      <button
        type="button"
        className="preview-font-btn preview-font-bigger"
        onClick={onBigger}
        title={`Bigger preview text (${shortcut('Mod+Alt+=')})`}
        aria-label="Bigger preview text"
      >
        A<span className="preview-font-sign">+</span>
      </button>
    </div>
  );
}

// Errors thrown by main-process handlers arrive wrapped as
// "Error invoking remote method '<channel>': Error: <message>".
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
