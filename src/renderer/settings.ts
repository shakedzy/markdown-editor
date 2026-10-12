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

  /** Starting state of a window's Auto-save toggle whenever a file is opened or created. */
  autoSaveOnOpen: boolean;
  /** Folder (relative to the document) that pasted/dropped images are saved into; '' = alongside it. */
  imageFolder: string;
  /** Keep editor and preview scroll positions in step in split view. */
  scrollSync: boolean;
  /** Keep the caret line vertically centered while typing. */
  typewriterMode: boolean;
  /** Window zoom factor (1 = 100%), restored on launch. */
  zoomFactor: number;
  vimMode: boolean;
  lintEnabled: boolean;

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
  autoSaveOnOpen: false,
  imageFolder: 'assets',
  scrollSync: true,
  typewriterMode: false,
  zoomFactor: 1,
  vimMode: false,
  lintEnabled: true,
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

/**
 * Calls `cb` with the stored settings whenever another window saves its own.
 * Each window saves its whole copy, so one that missed a change would
 * otherwise write the old value back with its next unrelated change.
 */
export function onSettingsSaved(cb: (s: Settings) => void): () => void {
  const listener = (e: StorageEvent) => {
    if (e.key === SETTINGS_KEY && e.newValue !== null) cb(loadSettings());
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, _v: CURRENT_VERSION }));
  localStorage.removeItem(LEGACY_WELCOME_KEY);
}
