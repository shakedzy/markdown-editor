import { contextBridge, ipcRenderer, IpcRendererEvent, webFrame, webUtils } from 'electron';
import {
  IpcChannels,
  FileResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
  ExportPdfArgs,
  ExportHtmlArgs,
  RichClipboard,
  MenuActionMessage,
  MenuToggles,
  DiskChange,
  OpenPathArgs,
  RecoverySnapshot,
  RecoveredDocument,
  ImportAssetsArgs,
  ImportedAsset,
  PathsExistArgs,
  LinkFileArgs,
  LinkFileResult,
  LinkDirectoryArgs,
  LinkDirEntry,
  DiscardChoice,
  FolderListing,
} from '../shared/types';

// Files main opened for this window to show. Main sends one as soon as the
// page has loaded, which can be before the page has subscribed (a page
// reloaded after a crash loads from cache and mounts later), so each is kept
// until a subscriber takes it.
const openFromOSListeners = new Set<(file: FileResult) => void>();
const unclaimedFiles: FileResult[] = [];

function handOverFiles(): void {
  if (openFromOSListeners.size === 0) return;
  for (const file of unclaimedFiles.splice(0)) {
    for (const cb of openFromOSListeners) cb(file);
  }
}

ipcRenderer.on(IpcChannels.FileFromOS, (_e: IpcRendererEvent, file: FileResult) => {
  unclaimedFiles.push(file);
  handOverFiles();
});

const api = {
  platform: process.platform,
  openFile: (): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileOpen),
  saveFile: (args: SaveArgs): Promise<SaveResult> =>
    ipcRenderer.invoke(IpcChannels.FileSave, args),
  saveFileAs: (args: SaveAsArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileSaveAs, args),
  exportPdf: (args: ExportPdfArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.PdfExport, args),
  /** Ask where to save a standalone HTML export and write it there (null: cancelled). */
  exportHtml: (args: ExportHtmlArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.HtmlExport, args),
  /**
   * A document image/media file (mditor:// URL) or one of the app's bundled
   * assets as a data: URL, for embedding in an export; null if it isn't one
   * of those, or is too large.
   */
  readAssetDataUrl: (url: string): Promise<string | null> =>
    ipcRenderer.invoke(IpcChannels.AssetDataUrl, url),
  writeClipboard: (content: RichClipboard): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ClipboardWrite, content),
  /**
   * Add pasted or dropped files to the document: copied into its images
   * folder, or linked where they are when already inside its folder.
   * Resolves what to link to for each (null: that one can't be added).
   */
  importAssets: (args: ImportAssetsArgs): Promise<(ImportedAsset | null)[]> =>
    ipcRenderer.invoke(IpcChannels.AssetImport, args),
  /** Where a pasted or dropped file is on disk; '' when it isn't a file on disk. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  /**
   * Whether each path, relative to the document's folder, exists; false
   * only when it was checked and nothing is there. Null when
   * `documentPath` isn't this window's document.
   */
  pathsExist: (args: PathsExistArgs): Promise<boolean[] | null> =>
    ipcRenderer.invoke(IpcChannels.PathsExist, args),
  /** Open a web (http, https) or mail link in the browser or mail app; resolves false for any other URL. */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.LinkOpenExternal, url),
  /**
   * Follow a link to a local file or folder: documents and media open in
   * their default app, anything else is shown in its folder. Rejects when
   * nothing is there.
   */
  openLinkedFile: (args: LinkFileArgs): Promise<LinkFileResult> =>
    ipcRenderer.invoke(IpcChannels.LinkOpenFile, args),
  /** The folders, Markdown files and images in a folder relative to the document (null: can't list it). */
  listLinkDirectory: (args: LinkDirectoryArgs): Promise<LinkDirEntry[] | null> =>
    ipcRenderer.invoke(IpcChannels.LinkListDirectory, args),
  newWindow: (): void => {
    ipcRenderer.send(IpcChannels.WindowNew);
  },
  openInNewWindow: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WindowOpen),
  /**
   * Open a Markdown file by path. A window that already shows it is focused
   * instead (resolves null). Otherwise it loads into this window when
   * `inThisWindow` (resolves the file to show) or opens in a new one.
   */
  openPath: (args: OpenPathArgs): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileOpenPath, args),
  /** Bring forward the window showing `path`, if any (this one included); resolves whether one did. */
  focusFileWindow: (path: string): Promise<boolean> =>
    ipcRenderer.invoke(IpcChannels.FileFocusWindow, path),
  /** Ask whether to save the document's unsaved changes before another file replaces it. */
  confirmDiscard: (): Promise<DiscardChoice> =>
    ipcRenderer.invoke(IpcChannels.FileConfirmDiscard),
  /** Ask the user for a folder to show in the Files panel (null: cancelled). */
  openFolder: (): Promise<FolderListing | null> =>
    ipcRenderer.invoke(IpcChannels.FolderOpen),
  /** The Files panel's folder, listed afresh (null: this window has none open). */
  listFolder: (): Promise<FolderListing | null> =>
    ipcRenderer.invoke(IpcChannels.FolderList),
  closeFolder: (): void => {
    ipcRenderer.send(IpcChannels.FolderClose);
  },
  /** The open folder's files changed on disk; `cb` gets the new listing. */
  onFolderChange: (cb: (listing: FolderListing) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, listing: FolderListing) => cb(listing);
    ipcRenderer.on(IpcChannels.FolderChanged, listener);
    return () => ipcRenderer.off(IpcChannels.FolderChanged, listener);
  },
  /**
   * Report unsaved changes. With `autoSave` (auto-save is on and saving this
   * document), closing the window saves them instead of asking.
   */
  setDirty: (dirty: boolean, autoSave = false): void => {
    ipcRenderer.send(IpcChannels.DirtySet, dirty, autoSave);
  },
  /** Report whether the editor has Vim keys on, so menu shortcuts leave Vim's Ctrl keys alone. */
  setVimMode: (on: boolean): void => {
    ipcRenderer.send(IpcChannels.VimModeSet, on);
  },
  /** Report this window's on/off states for the menu's checkmarks. */
  setMenuToggles: (toggles: MenuToggles): void => {
    ipcRenderer.send(IpcChannels.MenuTogglesSet, toggles);
  },
  /**
   * Close this window as its close button would (unsaved changes are asked
   * about), or with `force` without asking: they are saved or to be discarded.
   */
  closeWindow: (force = false): void => {
    ipcRenderer.send(IpcChannels.WindowClose, force);
  },
  /** Keep a copy of the unsaved document for crash recovery (null: nothing unsaved any more). */
  saveRecovery: (snapshot: RecoverySnapshot | null): void => {
    ipcRenderer.send(IpcChannels.RecoverySave, snapshot);
  },
  /** Unsaved work this window should restore on startup (after a crash or a reload), if any. */
  getRecovery: (): Promise<RecoveredDocument | null> =>
    ipcRenderer.invoke(IpcChannels.RecoveryGet),
  confirmQuit: (): void => {
    ipcRenderer.send(IpcChannels.QuitConfirm);
  },
  getZoomFactor: (): number => webFrame.getZoomFactor(),
  setZoomFactor: (factor: number): void => {
    if (Number.isFinite(factor) && factor > 0) webFrame.setZoomFactor(factor);
  },
  /** A file main opened for this window (one sent before subscribing is handed over too). */
  onOpenFromOS: (cb: (file: FileResult) => void): (() => void) => {
    openFromOSListeners.add(cb);
    // In a later task, so a subscription undone at once (React's StrictMode
    // mounts twice) doesn't take them.
    if (unclaimedFiles.length > 0) setTimeout(handOverFiles);
    return () => {
      openFromOSListeners.delete(cb);
    };
  },
  /** Report the file this window shows (null: untitled) so main watches it for outside changes. */
  watchFile: (path: string | null): void => {
    ipcRenderer.send(IpcChannels.FileWatch, path);
  },
  onDiskChange: (cb: (change: DiskChange) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, change: DiskChange) => cb(change);
    ipcRenderer.on(IpcChannels.FileChanged, listener);
    return () => ipcRenderer.off(IpcChannels.FileChanged, listener);
  },
  onMenuAction: (cb: (...message: MenuActionMessage) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ...message: MenuActionMessage) => cb(...message);
    ipcRenderer.on(IpcChannels.MenuAction, listener);
    return () => ipcRenderer.off(IpcChannels.MenuAction, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
