export const IpcChannels = {
  FileOpen: 'file:open',
  FileSave: 'file:save',
  FileSaveAs: 'file:saveAs',
  FileFromOS: 'file:fromOS',
  PdfExport: 'pdf:export',
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
