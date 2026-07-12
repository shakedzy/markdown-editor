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
  | 'formatStrike';

const api = {
  platform: process.platform,
  openFile: (): Promise<FileResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileOpen),
  saveFile: (args: SaveArgs): Promise<SaveResult> =>
    ipcRenderer.invoke(IpcChannels.FileSave, args),
  saveFileAs: (args: SaveAsArgs): Promise<SaveResult | null> =>
    ipcRenderer.invoke(IpcChannels.FileSaveAs, args),
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
