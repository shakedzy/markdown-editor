import { useEffect } from 'react';
import { IS_MAC, shortcut } from '../platform';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string;
  desc: string;
}

interface Section {
  title: string;
  items: Shortcut[];
}

// The list joins keys with "+" on every platform, so each one reads on its own.
const Mod = shortcut('Mod');
const Shift = shortcut('Shift');
const Alt = shortcut('Alt');
const IS_WINDOWS = window.api.platform === 'win32';

// Mirrors the menu's accelerators (src/main/menu.ts) and the editor's own
// keymaps; keep them in step.
const SECTIONS: Section[] = [
  {
    title: 'File',
    items: [
      { keys: `${Mod}+N`, desc: 'New' },
      { keys: `${Mod}+O`, desc: 'Open…' },
      { keys: `${Mod}+${Shift}+O`, desc: 'Open Folder… (Files panel)' },
      { keys: `${Mod}+S`, desc: 'Save' },
      { keys: `${Mod}+${Shift}+S`, desc: 'Save As…' },
      { keys: `${Mod}+${Shift}+A`, desc: 'Turn Auto-save on or off for this window' },
      { keys: `${Mod}+${Shift}+E`, desc: 'Export to PDF…' },
      { keys: `${Mod}+${Shift}+H`, desc: 'Export to HTML…' },
      { keys: `${Mod}+,`, desc: 'Settings' },
    ],
  },
  {
    title: 'Edit',
    items: [
      { keys: `${Mod}+Z`, desc: 'Undo' },
      { keys: IS_WINDOWS ? 'Ctrl+Y' : `${Mod}+${Shift}+Z`, desc: 'Redo' },
      { keys: `${Mod}+${Shift}+C`, desc: 'Copy as Rich Text (the preview, or its selected part)' },
      { keys: `${Mod}+F`, desc: 'Find / Replace (in the Preview tab: search the preview)' },
      { keys: 'F3', desc: 'Find next' },
      { keys: `${Shift}+F3`, desc: 'Find previous' },
    ],
  },
  {
    title: 'Format',
    items: [
      { keys: `${Mod}+B`, desc: 'Bold (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+I`, desc: 'Italic (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+U`, desc: 'Underline (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+${Shift}+X`, desc: 'Strikethrough (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+${Alt}+T`, desc: 'Format Table (line up the table at the cursor)' },
    ],
  },
  {
    title: 'In the editor',
    items: [
      { keys: 'Enter', desc: 'Continue a list; on an empty list item, end the list' },
      { keys: 'Tab', desc: 'In a table: next cell (in the last cell, adds a row)' },
      { keys: `${Shift}+Tab`, desc: 'In a table: previous cell' },
      { keys: 'Enter', desc: 'In a table: new row below (on an empty last row, leave the table)' },
      { keys: `${Mod}+Click`, desc: 'Follow the link under the pointer' },
      {
        keys: 'Ctrl+Space',
        desc: `Suggest link targets inside a link’s (…)${IS_MAC ? ' (⌥` works too)' : ''}`,
      },
      { keys: `${Mod}+${Shift}+M`, desc: 'List the lint warnings (Esc closes the list)' },
      { keys: 'F8', desc: 'Go to the next lint warning' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: `${Mod}+\\`, desc: 'Toggle Split / Tabs' },
      { keys: `${Mod}+${Shift}+T`, desc: 'Toggle Table of Contents (TOC)' },
      { keys: `${Mod}+${Shift}+F`, desc: 'Toggle Files panel' },
      { keys: `${Mod}+${Shift}+G`, desc: 'Toggle GH Ext (GitHub extensions)' },
      { keys: `${Mod}+${Shift}+Enter`, desc: 'Toggle Focus mode (Esc also leaves it, unless Vim keys are on)' },
      {
        keys: `${Mod}+R`,
        desc: IS_MAC ? 'Reload window' : 'Reload window (not while Vim keys are on: Ctrl+R is then Vim’s redo)',
      },
      { keys: `${Mod}+0`, desc: 'Actual size (100%; keypad 0 works too)' },
      { keys: `${Mod}+=`, desc: 'Zoom in (keypad + works too)' },
      { keys: `${Mod}+-`, desc: 'Zoom out (keypad − works too)' },
      IS_MAC
        ? { keys: `Ctrl+${Mod}+F`, desc: 'Toggle full screen' }
        : { keys: 'F11', desc: 'Toggle full screen' },
    ],
  },
  {
    title: 'Help',
    items: [
      { keys: '?', desc: 'Show this dialog (outside the editor; also the toolbar’s ? button)' },
    ],
  },
];

function KeyChips({ keys }: { keys: string }): JSX.Element {
  const parts = keys.split('+').map((k) => k.trim()).filter(Boolean);
  return (
    <>
      {parts.map((k, i) => (
        <span key={i}>
          <kbd>{k}</kbd>
          {i < parts.length - 1 ? ' ' : null}
        </span>
      ))}
    </>
  );
}

export default function ShortcutsDialog({ open, onClose }: Props): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog shortcuts-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog-header">
          <h2>Keyboard Shortcuts</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="dialog-body">
          {SECTIONS.map((section) => (
            <section key={section.title} className="shortcuts-section">
              <h3>{section.title}</h3>
              <table>
                <tbody>
                  {section.items.map((s) => (
                    <tr key={s.keys + s.desc}>
                      <td className="shortcut-keys">
                        <KeyChips keys={s.keys} />
                      </td>
                      <td>{s.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
