import { Menu, BrowserWindow, app, shell } from 'electron';

export type MenuAction =
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

export function buildAppMenu(getFocused: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin';

  const send = (action: MenuAction) => () => {
    const win = getFocused();
    if (win && !win.isDestroyed()) {
      win.webContents.send('menu:action', action);
    }
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('showSettings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('newFile') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('openFile') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: send('saveAs'),
        },
        ...(isMac
          ? ([] as Electron.MenuItemConstructorOptions[])
          : ([
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Ctrl+,', click: send('showSettings') },
            ] as Electron.MenuItemConstructorOptions[])),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find / Replace…', accelerator: 'CmdOrCtrl+F', click: send('find') },
      ],
    },
    {
      label: 'Format',
      submenu: [
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: send('formatBold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: send('formatItalic') },
        {
          label: 'Underline',
          accelerator: 'CmdOrCtrl+U',
          click: send('formatUnderline'),
        },
        { label: 'Strikethrough', click: send('formatStrike') },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Split / Tabs',
          accelerator: 'CmdOrCtrl+\\',
          click: send('toggleViewMode'),
        },
        {
          label: 'Toggle Table of Contents (TOC)',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: send('toggleToc'),
        },
        {
          label: 'Toggle GH Ext (GitHub Extensions)',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: send('toggleGh'),
        },
        { type: 'separator' },
        {
          label: 'Show Welcome on Launch',
          click: send('toggleWelcomeOnLaunch'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts…',
          click: send('showShortcuts'),
        },
        { type: 'separator' },
        {
          label: 'Project Repository',
          click: () => {
            void shell.openExternal('https://github.com/shakedzy/markdown-editor');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
