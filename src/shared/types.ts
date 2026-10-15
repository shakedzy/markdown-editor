export const IpcChannels = {
  FileOpen: 'file:open',
  FileSave: 'file:save',
  FileSaveAs: 'file:saveAs',
  FileFromOS: 'file:fromOS',
  FileOpenPath: 'file:openPath',
  FileWatch: 'file:watch',
  FileChanged: 'file:changed',
  FileConfirmDiscard: 'file:confirmDiscard',
  FileFocusWindow: 'file:focusWindow',
  FolderOpen: 'folder:open',
  FolderList: 'folder:list',
  FolderClose: 'folder:close',
  FolderChanged: 'folder:changed',
  RecoverySave: 'recovery:save',
  RecoveryGet: 'recovery:get',
  PdfExport: 'pdf:export',
  HtmlExport: 'html:export',
  AssetDataUrl: 'asset:dataUrl',
  AssetImport: 'asset:import',
  ClipboardWrite: 'clipboard:write',
  PathsExist: 'paths:exist',
  LinkOpenExternal: 'link:openExternal',
  LinkOpenFile: 'link:openFile',
  LinkListDirectory: 'link:listDirectory',
  ReplaceMisspelling: 'spellcheck:replace',
  DirtySet: 'dirty:set',
  VimModeSet: 'vimMode:set',
  MenuTogglesSet: 'menuToggles:set',
  QuitConfirm: 'quit:confirm',
  WindowNew: 'window:new',
  WindowOpen: 'window:open',
  WindowClose: 'window:close',
  MenuAction: 'menu:action',
} as const;

// Actions the main process sends to a window over IpcChannels.MenuAction
// (application menu items and the editor context menu).
export type MenuAction =
  | 'newFile'
  | 'openFile'
  | 'openRecent'
  | 'openFolder'
  | 'save'
  | 'saveAs'
  | 'saveAndQuit'
  | 'toggleAutoSave'
  | 'toggleToc'
  | 'toggleFiles'
  | 'toggleViewMode'
  | 'toggleGh'
  | 'toggleScrollSync'
  | 'toggleFocusMode'
  | 'toggleTypewriter'
  | 'undo'
  | 'redo'
  | 'formatBold'
  | 'formatItalic'
  | 'formatUnderline'
  | 'formatStrike'
  | 'insertTable'
  | 'formatTable'
  | 'find'
  | 'copyRichText'
  | 'showShortcuts'
  | 'showSettings'
  | 'toggleWelcomeOnLaunch'
  | 'takeMeThere'
  | 'exportPdf'
  | 'exportHtml'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'previewFontBigger'
  | 'previewFontSmaller'
  | 'previewFontReset';

/** A window's on/off states, which the menu shows as checkmarks while it is focused. */
export interface MenuToggles {
  autoSave: boolean;
  filesPanel: boolean;
  toc: boolean;
  gh: boolean;
  scrollSync: boolean;
  focusMode: boolean;
  typewriter: boolean;
  welcomeOnLaunch: boolean;
  viewMode: 'split' | 'tabs';
}

/**
 * The arguments of a `menu:action` message: the action, plus a payload for
 * the actions that carry one. Every member has two elements so a
 * `(action, payload)` callback narrows `payload` by `action`.
 */
export type MenuActionMessage =
  | [action: 'takeMeThere', payload: { x: number; y: number }]
  | [action: 'openRecent', payload: { path: string }]
  | [action: Exclude<MenuAction, 'takeMeThere' | 'openRecent'>, payload: undefined];

export interface FileResult {
  path: string;
  /** Always "\n" line endings; main restores the file's own when saving. */
  content: string;
}

/** The open document's file was changed or removed by something other than this window. */
export type DiskChange =
  | { kind: 'changed'; path: string; content: string }
  | { kind: 'deleted'; path: string };

/**
 * A window's unsaved document, which main keeps on disk while it is dirty so
 * the work survives a crash or a reload of the window.
 */
export interface RecoverySnapshot {
  /** The file the document belongs to; null while untitled. */
  path: string | null;
  content: string;
  /**
   * The text ("\n" line endings) the document was last loaded from or saved
   * to its file, so a restore can tell whether the file changed since.
   * Missing from snapshots of older versions.
   */
  base?: string;
}

/** Unsaved work handed back to a window that starts up (after a crash or reload). */
export interface RecoveredDocument extends RecoverySnapshot {
  /** The file's current text, or null when untitled or the file can't be read (e.g. deleted). */
  diskContent: string | null;
  /**
   * Why the file is there but couldn't be read (e.g. it isn't UTF-8 text any
   * more); absent when it was read or is missing.
   */
  diskUnreadable?: string;
  /** Left behind by a session that didn't close properly, rather than by reloading this window. */
  afterCrash: boolean;
}

export interface OpenPathArgs {
  /** Absolute path of the file to open. */
  path: string;
  /** Load it into the calling window instead of a new one. */
  inThisWindow: boolean;
}

/** The answer to "save your changes before another file replaces this document?" */
export type DiscardChoice = 'save' | 'discard' | 'cancel';

/** A Markdown file, or a folder with Markdown files somewhere below it, in the Files panel. */
export type FolderEntry =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'folder'; name: string; path: string; children: FolderEntry[] };

/** The folder a window's Files panel shows, as main last listed it. */
export interface FolderListing {
  /** Absolute path of the folder. */
  root: string;
  /** What to call it (the root of a drive has no name of its own). */
  name: string;
  /** Its Markdown files and the folders that lead to them, folders first; absolute paths. */
  entries: FolderEntry[];
  /** The folder is too large or too deep to list in full. */
  truncated: boolean;
  /** Why the folder can't be listed (e.g. it was deleted); `entries` is then empty. */
  error?: string;
}

export interface SaveArgs {
  path: string;
  content: string;
}

export interface SaveAsArgs {
  content: string;
  suggestedName?: string;
}

export interface SaveResult {
  path: string;
  /**
   * Nothing was written: the file changed on disk since the window last saw
   * it, and that change was just reported (FileChanged) for the user to pick.
   */
  conflict?: boolean;
}

export interface ExportPdfArgs {
  /** A fully self-contained HTML document (styles inlined) to render as the PDF. */
  html: string;
  suggestedName?: string;
}

export interface ExportHtmlArgs {
  /** The standalone HTML document to write. */
  html: string;
  /** A file name (no directory) to offer in the save dialog. */
  suggestedName?: string;
}

/** Both flavors written to the clipboard by Copy as Rich Text. */
export interface RichClipboard {
  html: string;
  text: string;
}

/** Largest pasted or dropped image that is sent to main as data. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** A file pasted or dropped into the editor, to save next to the document or link to. */
export type IncomingAsset =
  /** A file on disk (dropped, or copied in the file manager). */
  | { path: string }
  /**
   * Image data with no file behind it: a pasted screenshot (no `name`), or
   * a dropped image another app offered only as data.
   */
  | { data: Uint8Array; type: string; name?: string };

export interface ImportAssetsArgs {
  /** The document the renderer is adding to; refused unless it is this window's. */
  documentPath: string;
  /** The images folder setting: where new image files go, relative to the document. */
  folder: string;
  assets: IncomingAsset[];
}

export interface ImportedAsset {
  /** Link destination relative to the document, ready to put in `![](…)` or `[](…)`. */
  href: string;
  /** An image the preview can show (else a file to link to). */
  image: boolean;
}

/** Most paths one pathsExist request may ask about. */
export const MAX_PATH_CHECKS = 500;

/** Lint asks which files the document's relative links point at exist. */
export interface PathsExistArgs {
  /** The document the links are in; refused unless it is this window's. */
  documentPath: string;
  /** Paths relative to the document's folder, already unescaped and decoded. */
  paths: string[];
}

/** Follow a link to a local file or folder. */
export interface LinkFileArgs {
  /** The document the link is in (null: untitled); refused unless it is this window's. */
  documentPath: string | null;
  /** The link's path, unescaped and decoded: relative to the document, or absolute. */
  target: string;
}

/** List a folder named in a link being typed, for link completion. */
export interface LinkDirectoryArgs {
  /** The document being edited; refused unless it is this window's. */
  documentPath: string;
  /** The folder as typed so far, relative to the document ('' for its own folder, "../img/"). */
  dir: string;
}

/** An entry of a folder named in a link being typed: what link completion offers. */
export interface LinkDirEntry {
  name: string;
  isDir: boolean;
}

/**
 * What following a link to a local file did: `opened` it in its default app
 * (documents, images, media), or `revealed` it in its folder (folders, and
 * anything that could run, so a click never launches a program).
 */
export type LinkFileResult = 'opened' | 'revealed';
