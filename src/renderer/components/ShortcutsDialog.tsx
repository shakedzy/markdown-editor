import { useEffect } from 'react';

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

const isMac = navigator.platform.toLowerCase().includes('mac');
const Mod = isMac ? '⌘' : 'Ctrl';
const Shift = isMac ? '⇧' : 'Shift';

const SECTIONS: Section[] = [
  {
    title: 'File',
    items: [
      { keys: `${Mod}+N`, desc: 'New' },
      { keys: `${Mod}+O`, desc: 'Open' },
      { keys: `${Mod}+S`, desc: 'Save' },
      { keys: `${Mod}+${Shift}+S`, desc: 'Save As' },
    ],
  },
  {
    title: 'Editing',
    items: [
      { keys: `${Mod}+B`, desc: 'Bold (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+I`, desc: 'Italic (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+U`, desc: 'Underline (wrap selection — marker configurable in Settings)' },
      { keys: `${Mod}+Z`, desc: 'Undo' },
      { keys: `${Mod}+${Shift}+Z`, desc: 'Redo' },
      { keys: `${Mod}+F`, desc: 'Find / Replace' },
      { keys: 'F3', desc: 'Find next' },
      { keys: `${Shift}+F3`, desc: 'Find previous' },
      {
        keys: 'Enter',
        desc: 'Continue list (after `- `, `* `, or `1. `); press again on an empty list item to exit',
      },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: `${Mod}+\\`, desc: 'Toggle Split / Tabs' },
      { keys: `${Mod}+${Shift}+T`, desc: 'Toggle Table of Contents (TOC)' },
      { keys: `${Mod}+${Shift}+G`, desc: 'Toggle GH Ext (GitHub extensions)' },
      { keys: `${Mod}+R`, desc: 'Reload window' },
      { keys: `${Mod}+=`, desc: 'Zoom in' },
      { keys: `${Mod}+-`, desc: 'Zoom out' },
      { keys: `${Mod}+0`, desc: 'Reset zoom' },
      { keys: `Ctrl+${Mod}+F`, desc: 'Toggle full screen (macOS)' },
      { keys: 'F11', desc: 'Toggle full screen (Windows / Linux)' },
    ],
  },
  {
    title: 'Help',
    items: [
      { keys: '?', desc: 'Show this dialog (toolbar button)' },
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
