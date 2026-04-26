import { useEffect } from 'react';
import { Settings } from '../settings';

interface Props {
  open: boolean;
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

interface Option<T extends string> {
  value: T;
  label: string;
}

function RadioGroup<T extends string>(props: {
  name: string;
  value: T;
  options: ReadonlyArray<Option<T>>;
  onChange: (v: T) => void;
}): JSX.Element {
  const { name, value, options, onChange } = props;
  return (
    <div className="settings-radios">
      {options.map((opt) => (
        <label key={opt.value} className="settings-radio">
          <input
            type="radio"
            name={name}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
          />
          <code>{opt.label}</code>
        </label>
      ))}
    </div>
  );
}

export default function SettingsDialog({ open, settings, onChange, onClose }: Props): JSX.Element | null {
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

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog-header">
          <h2>Settings</h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="dialog-body">
          <section className="settings-section">
            <h3>Formatting markers</h3>
            <p className="settings-hint">
              All variants — <code>**</code>/<code>__</code>, <code>*</code>/
              <code>_</code>, <code>~</code>/<code>~~</code> — render correctly
              when typed manually. This setting only chooses which marker is
              inserted by <kbd>⌘B</kbd> / <kbd>⌘I</kbd> / <kbd>⌘U</kbd> and{' '}
              <em>Format → Strikethrough</em>. Changes apply immediately.
            </p>

            <div className="settings-row">
              <span className="settings-label">Bold</span>
              <RadioGroup
                name="boldMarker"
                value={settings.boldMarker}
                options={[
                  { value: '**', label: '**bold**' },
                  { value: '__', label: '__bold__' },
                ]}
                onChange={(v) => update('boldMarker', v)}
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">Italic</span>
              <RadioGroup
                name="italicMarker"
                value={settings.italicMarker}
                options={[
                  { value: '*', label: '*italic*' },
                  { value: '_', label: '_italic_' },
                ]}
                onChange={(v) => update('italicMarker', v)}
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">Strikethrough</span>
              <RadioGroup
                name="strikethroughMarker"
                value={settings.strikethroughMarker}
                options={[
                  { value: '~~', label: '~~strike~~' },
                  { value: '~', label: '~strike~' },
                ]}
                onChange={(v) => update('strikethroughMarker', v)}
              />
            </div>

            <div className="settings-row">
              <span className="settings-label">Underline</span>
              <RadioGroup
                name="underlineMarker"
                value={settings.underlineMarker}
                options={[
                  { value: 'ins', label: '<ins>…</ins>' },
                  { value: 'u', label: '<u>…</u>' },
                ]}
                onChange={(v) => update('underlineMarker', v)}
              />
            </div>

            <p className="settings-hint settings-warn">
              Notes: <code>~strike~</code> only renders with GH Ext on (it's a
              GitHub extension, not standard GFM). GitHub's renderer{' '}
              <strong>strips <code>&lt;u&gt;</code></strong>; pick{' '}
              <code>&lt;ins&gt;</code> for github.com compatibility (both
              display identically in MDitor).
            </p>
          </section>

          <section className="settings-section">
            <h3>Appearance</h3>
            <p className="settings-hint">Applies immediately.</p>

            <div className="settings-row">
              <span className="settings-label">Theme</span>
              <RadioGroup
                name="theme"
                value={settings.theme}
                options={[
                  { value: 'auto', label: 'Auto (OS)' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
                onChange={(v) => update('theme', v)}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>Startup defaults</h3>
            <p className="settings-hint">Applied on the next app launch.</p>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.showWelcomeOnLaunch}
                onChange={(e) => update('showWelcomeOnLaunch', e.target.checked)}
              />
              <span>Show welcome doc on startup</span>
            </label>

            <div className="settings-row">
              <span className="settings-label">Default view</span>
              <RadioGroup
                name="defaultView"
                value={settings.defaultView}
                options={[
                  { value: 'split', label: 'Split' },
                  { value: 'tabs', label: 'Tabs' },
                ]}
                onChange={(v) => update('defaultView', v)}
              />
            </div>

            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={settings.ghOnByDefault}
                onChange={(e) => update('ghOnByDefault', e.target.checked)}
              />
              <span>Enable GH Ext by default</span>
            </label>
          </section>
        </div>
      </div>
    </div>
  );
}
