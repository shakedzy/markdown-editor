export const IS_MAC = window.api.platform === 'darwin';

const MAC_KEYS: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Enter: '↩' };

/**
 * A shortcut written as "Mod+Shift+M", labelled the platform's way: "⌘⇧M" on
 * macOS, "Ctrl+Shift+M" elsewhere.
 */
export function shortcut(keys: string): string {
  const parts = keys.split('+');
  return IS_MAC
    ? parts.map((key) => MAC_KEYS[key] ?? key).join('')
    : parts.map((key) => (key === 'Mod' ? 'Ctrl' : key)).join('+');
}
