export const IpcChannels = {
  FileOpen: 'file:open',
  FileRead: 'file:read',
  FileSave: 'file:save',
  FileSaveAs: 'file:saveAs',
  FileFromOS: 'file:fromOS',
  PdfExport: 'pdf:export',
  FolderOpen: 'folder:open',
  FolderReopen: 'folder:reopen',
  FolderChanged: 'folder:changed',
  ReplaceMisspelling: 'spellcheck:replace',
  DirtySet: 'dirty:set',
  QuitConfirm: 'quit:confirm',
  WindowNew: 'window:new',
  WindowOpen: 'window:open',
} as const;

export interface FileResult {
  path: string;
  content: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface FolderResult {
  root: string;
  tree: FileNode[];
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
}

export interface ExportPdfArgs {
  /** A fully self-contained HTML document (styles inlined) to render as the PDF. */
  html: string;
  suggestedName?: string;
}
