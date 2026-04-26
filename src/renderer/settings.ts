export type Theme = 'light' | 'dark' | 'auto';

export interface Settings {
  boldMarker: '**' | '__';
  italicMarker: '_' | '*';
  strikethroughMarker: '~' | '~~';
  underlineMarker: 'ins' | 'u';

  showWelcomeOnLaunch: boolean;
  defaultView: 'split' | 'tabs';
  ghOnByDefault: boolean;
  theme: Theme;

  _v: number;
}

const CURRENT_VERSION = 2;

export const DEFAULT_SETTINGS: Settings = {
  boldMarker: '**',
  italicMarker: '_',
  strikethroughMarker: '~~',
  underlineMarker: 'ins',
  showWelcomeOnLaunch: true,
  defaultView: 'split',
  ghOnByDefault: true,
  theme: 'auto',
  _v: CURRENT_VERSION,
};

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'auto') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.classList.toggle('light', resolved === 'light');
  document.documentElement.dataset.themeChoice = theme;
}

const SETTINGS_KEY = 'mditor.settings';
const LEGACY_WELCOME_KEY = 'mditor.showWelcomeOnLaunch';

export function loadSettings(): Settings {
  let settings: Settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const stored = parsed as Partial<Settings> & { _v?: number };
        const oldVersion = stored._v ?? 1;
        settings = { ...settings, ...stored };

        if (oldVersion < 2) {
          // v2: strikethrough default flipped from ~ to ~~
          settings.strikethroughMarker = DEFAULT_SETTINGS.strikethroughMarker;
        }

        settings._v = CURRENT_VERSION;
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_WELCOME_KEY);
      if (legacy !== null) {
        settings.showWelcomeOnLaunch = legacy !== 'false';
      }
    }
  } catch {
    // ignore corrupt storage; fall back to defaults
  }
  return settings;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, _v: CURRENT_VERSION }));
  localStorage.removeItem(LEGACY_WELCOME_KEY);
}
