import { Menu, BrowserWindow, app, shell, webContents } from 'electron';
import { IpcChannels, MenuAction, MenuActionMessage, MenuToggles } from '../shared/types';
import { clearRecent, getRecentEntries } from './recent';

export type { MenuAction };

/** The actions that carry no payload, which may be sent without one. */
type PlainMenuAction = Extract<MenuActionMessage, [MenuAction, undefined]>[0];

/** Send `win` a menu action, with the payload that action carries (if any). */
export function sendMenuAction(
  win: BrowserWindow,
  ...message: MenuActionMessage | [action: PlainMenuAction]
): void {
  if (!win.isDestroyed()) win.webContents.send(IpcChannels.MenuAction, ...message);
}

export interface AppMenuHooks {
  getFocused: () => BrowserWindow | null;
  /** A File > Open Recent entry was chosen. */
  openRecent: (filePath: string) => void;
}

let hooks: AppMenuHooks | null = null;

/** Install the application menu. Call once at startup. */
export function initAppMenu(appHooks: AppMenuHooks): void {
  hooks = appHooks;
  rebuildMenu();
}

/**
 * Rebuild the application menu from the current state of everything it
 * shows (e.g. the recent files). Call it whenever any of that changes.
 */
export function rebuildMenu(): void {
  if (hooks) Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(hooks)));
}

let vimKeys = false;

/**
 * Whether the focused window's editor has Vim keys on. On Windows and Linux
 * menu shortcuts take keys before the page sees them, and Vim's redo
 * (Ctrl+R) would reload the window instead, so Reload gives up its shortcut.
 */
export function setVimKeys(on: boolean): void {
  if (process.platform === 'darwin' || on === vimKeys) return;
  vimKeys = on;
  rebuildMenu();
}

let toggles: MenuToggles | null = null;

/** Show the focused window's on/off states as checkmarks (null: it reported none). */
export function setMenuToggles(next: MenuToggles | null): void {
  toggles = next;
  rebuildMenu();
}

/** A window's report of its toggles, from untrusted input: anything but `true` is off. */
export function parseMenuToggles(value: unknown): MenuToggles {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof MenuToggles, unknown>
  >;
  return {
    autoSave: v.autoSave === true,
    filesPanel: v.filesPanel === true,
    toc: v.toc === true,
    gh: v.gh === true,
    scrollSync: v.scrollSync === true,
    focusMode: v.focusMode === true,
    typewriter: v.typewriter === true,
    welcomeOnLaunch: v.welcomeOnLaunch === true,
    viewMode: v.viewMode === 'tabs' ? 'tabs' : 'split',
  };
}

function recentSubmenu(
  openRecent: (filePath: string) => void,
): Electron.MenuItemConstructorOptions[] {
  const entries = getRecentEntries();
  if (entries.length === 0) return [{ label: 'No Recent Files', enabled: false }];
  return [
    ...entries.map(({ path, label }) => ({
      // Windows and Linux read "&" as a mnemonic marker.
      label: process.platform === 'darwin' ? label : label.replace(/&/g, '&&'),
      click: () => openRecent(path),
    })),
    { type: 'separator' },
    { label: 'Clear Menu', click: () => clearRecent() },
  ];
}

function buildTemplate({
  getFocused,
  openRecent,
}: AppMenuHooks): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';

  const send = (action: PlainMenuAction) => () => {
    const win = getFocused();
    if (win) sendMenuAction(win, action);
  };

  // The editor keeps its own undo history. The native undo reaches it as an
  // input event, but the native redo never does: the editor cancels the
  // native undo, so Chromium's redo stack stays empty. So the window runs
  // both itself (natively in its other text fields), and anything else in
  // focus (DevTools, a dialog sheet's text field) gets the native command.
  const history = (action: 'undo' | 'redo') => () => {
    const win = getFocused();
    const contents = webContents.getFocusedWebContents();
    if (win && contents?.id === win.webContents.id) sendMenuAction(win, action);
    else if (isMac) Menu.sendActionToFirstResponder(`${action}:`);
    else contents?.[action]();
  };

  // An on/off item, checked as the focused window last reported. Electron
  // flips the checkmark on a click by itself; the rebuild puts the reported
  // state back until the window reports what it did.
  const on = toggles ?? parseMenuToggles(null);
  const toggle = (
    label: string,
    checked: boolean,
    action: PlainMenuAction,
    accelerator?: string,
  ): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'checkbox',
    checked,
    accelerator,
    click: () => {
      send(action)();
      rebuildMenu();
    },
  });

  // Browser-style zoom keys besides the visible Cmd/Ctrl+= / - / 0 items:
  // Cmd/Ctrl+Plus (Shift+= on US layouts) and the numeric keypad. The items
  // are hidden; their accelerators still fire.
  const zoomAliases = (
    [
      ['Zoom In', 'CmdOrCtrl+Plus', 'zoomIn'],
      ['Zoom In', 'CmdOrCtrl+numadd', 'zoomIn'],
      ['Zoom Out', 'CmdOrCtrl+numsub', 'zoomOut'],
      ['Actual Size', 'CmdOrCtrl+num0', 'zoomReset'],
    ] as const
  ).map(
    ([label, accelerator, action]): Electron.MenuItemConstructorOptions => ({
      label,
      accelerator,
      click: send(action),
      visible: false,
      acceleratorWorksWhenHidden: true,
    }),
  );

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
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: send('openFolder'),
        },
        { label: 'Open Recent', submenu: recentSubmenu(openRecent) },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: send('saveAs'),
        },
        toggle('Auto-save', on.autoSave, 'toggleAutoSave', 'CmdOrCtrl+Shift+A'),
        { type: 'separator' },
        {
          label: 'Export to PDF…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: send('exportPdf'),
        },
        {
          label: 'Export to HTML…',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: send('exportHtml'),
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
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: history('undo') },
        {
          label: 'Redo',
          // The keys of Electron's own Redo item.
          accelerator: process.platform === 'win32' ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z',
          click: history('redo'),
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        {
          label: 'Copy as Rich Text',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: send('copyRichText'),
        },
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
        {
          label: 'Strikethrough',
          accelerator: 'CmdOrCtrl+Shift+X',
          click: send('formatStrike'),
        },
        { type: 'separator' },
        { label: 'Insert Table', click: send('insertTable') },
        {
          label: 'Format Table',
          accelerator: 'CmdOrCtrl+Alt+T',
          click: send('formatTable'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        // Unchecked is the Tabs view.
        toggle('Split View', on.viewMode === 'split', 'toggleViewMode', 'CmdOrCtrl+\\'),
        toggle('Table of Contents (TOC)', on.toc, 'toggleToc', 'CmdOrCtrl+Shift+T'),
        toggle('Files Panel', on.filesPanel, 'toggleFiles', 'CmdOrCtrl+Shift+F'),
        toggle('GH Ext (GitHub Extensions)', on.gh, 'toggleGh', 'CmdOrCtrl+Shift+G'),
        { type: 'separator' },
        toggle('Sync Scrolling', on.scrollSync, 'toggleScrollSync'),
        toggle('Focus Mode', on.focusMode, 'toggleFocusMode', 'CmdOrCtrl+Shift+Enter'),
        toggle('Typewriter Mode', on.typewriter, 'toggleTypewriter'),
        { type: 'separator' },
        toggle('Show Welcome on Launch', on.welcomeOnLaunch, 'toggleWelcomeOnLaunch'),
        { type: 'separator' },
        vimKeys
          ? { label: 'Reload', click: () => getFocused()?.webContents.reload() }
          : { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: send('zoomReset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        ...zoomAliases,
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

  return template;
}
