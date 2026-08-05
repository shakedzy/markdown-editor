import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  FileResult,
  FolderResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
  ExportPdfArgs,
} from '../shared/types';

type MenuAction =
  | 'newFile'
  | 'openFile'
  | 'openFolder'
  | 'toggleFileTree'
  | 'save'
  | 'saveAs'
  | 'saveAndQuit'
  | 'toggleToc'
  | 'toggleViewMode'
  | 'toggleGh'
  | 'formatBold'
  | 'formatItalic'
  | 'formatUnderline'
  | 'find'
  | 'showShortcuts'
  | 'showSettings'
  | 'toggleWelcomeOnLaunch'
  | 'takeMeThere'
  | 'formatStrike'
  | 'exportPdf';

const api = {
  platform: process.platform,
  openFile: (): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileOpen),
  readFile: (path: string): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileRead, path),
  openFolder: (showHidden: boolean): Promise<FolderResult | null> =>
    ipcRenderer.invoke(IpcChannels.FolderOpen, showHidden),
  reopenFolder: (path: string, showHidden: boolean): Promise<FolderResult | null> =>
    ipcRenderer.invoke(IpcChannels.FolderReopen, path, showHidden),
  onFolderChanged: (cb: (folder: FolderResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: FolderResult) => cb(payload);
    ipcRenderer.on(IpcChannels.FolderChanged, listener);
    return () => ipcRenderer.off(IpcChannels.FolderChanged, listener);
  },
  saveFile: (args: SaveArgs): Promise<SaveResult> =>
    ipcRenderer.invoke(IpcChannels.FileSave, args),
  saveFileAs: (args: SaveAsArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileSaveAs, args),
  exportPdf: (args: ExportPdfArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.PdfExport, args),
  newWindow: (): void => {
    ipcRenderer.send(IpcChannels.WindowNew);
  },
  openInNewWindow: (): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.WindowOpen),
  setDirty: (dirty: boolean): void => {
    ipcRenderer.send(IpcChannels.DirtySet, dirty);
  },
  confirmQuit: (): void => {
    ipcRenderer.send(IpcChannels.QuitConfirm);
  },
  onOpenFromOS: (cb: (file: FileResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: FileResult) => cb(payload);
    ipcRenderer.on(IpcChannels.FileFromOS, listener);
    return () => ipcRenderer.off(IpcChannels.FileFromOS, listener);
  },
  onMenuAction: (
    cb: (action: MenuAction, payload?: { x: number; y: number }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      action: MenuAction,
      payload?: { x: number; y: number },
    ) => cb(action, payload);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.off('menu:action', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
