import { Menu, BrowserWindow, app } from 'electron';

export function configureSpellcheck(win: BrowserWindow): void {
  if (process.platform !== 'darwin') {
    try {
      win.webContents.session.setSpellCheckerLanguages(['en-US']);
    } catch (err) {
      console.warn('Failed to set spell checker languages:', err);
    }
  }

  win.webContents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      template.push({ type: 'separator' });
      template.push({
        label: 'Add to dictionary',
        click: () =>
          win.webContents.session.addWordToSpellCheckerDictionary(
            params.misspelledWord,
          ),
      });
      template.push({ type: 'separator' });
    } else if (params.misspelledWord) {
      template.push({ label: 'No suggestions', enabled: false });
      template.push({ type: 'separator' });
    }

    if (params.editFlags.canUndo) template.push({ role: 'undo' });
    if (params.editFlags.canRedo) template.push({ role: 'redo' });
    if (template.length > 0) template.push({ type: 'separator' });
    if (params.editFlags.canCut) template.push({ role: 'cut' });
    if (params.editFlags.canCopy) template.push({ role: 'copy' });
    if (params.editFlags.canPaste) template.push({ role: 'paste' });
    if (params.editFlags.canSelectAll) {
      template.push({ type: 'separator' });
      template.push({ role: 'selectAll' });
    }

    template.push({ type: 'separator' });
    template.push({
      label: 'Take me there in the other pane',
      click: () => win.webContents.send('menu:action', 'takeMeThere'),
    });

    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  app.commandLine.appendSwitch('enable-spell-checking');
}
