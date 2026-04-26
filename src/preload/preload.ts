import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  IpcChannels,
  FileResult,
  SaveArgs,
  SaveAsArgs,
  SaveResult,
} from '../shared/types';

type MenuAction =
  | 'newFile'
  | 'openFile'
  | 'save'
  | 'saveAs'
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
  | 'formatStrike';

const api = {
  platform: process.platform,
  openFile: (): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileOpen),
  saveFile: (args: SaveArgs): Promise<SaveResult> =>
    ipcRenderer.invoke(IpcChannels.FileSave, args),
  saveFileAs: (args: SaveAsArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileSaveAs, args),
  onOpenFromOS: (cb: (file: FileResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: FileResult) => cb(payload);
    ipcRenderer.on(IpcChannels.FileFromOS, listener);
    return () => ipcRenderer.off(IpcChannels.FileFromOS, listener);
  },
  onMenuAction: (cb: (action: MenuAction) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: MenuAction) => cb(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.off('menu:action', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
