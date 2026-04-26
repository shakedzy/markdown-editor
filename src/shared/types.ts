export const IpcChannels = {
  FileOpen: 'file:open',
  FileSave: 'file:save',
  FileSaveAs: 'file:saveAs',
  FileFromOS: 'file:fromOS',
  ReplaceMisspelling: 'spellcheck:replace',
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
