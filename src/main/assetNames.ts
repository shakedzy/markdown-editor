import type { PlatformPath } from 'node:path';
import { CASE_INSENSITIVE_FS, pathKey } from './recentList';

// Pure helpers behind pasting and dropping images into a document (no
// Electron or filesystem access).

/** Image formats the preview can show, by extension. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

const EXTENSION_FOR_TYPE: Readonly<Record<string, string>> = {
  'image/apng': 'apng',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

// Characters Windows forbids in file names, plus `#`, which would cut a link
// to the file short (it starts a URL fragment).
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*#]/g;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_STEM_LENGTH = 100;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The extension to save image data of MIME type `type` with; null for formats the preview can't show. */
export function imageExtension(type: string): string | null {
  return EXTENSION_FOR_TYPE[type.toLowerCase()] ?? null;
}

export function isImageName(name: string): boolean {
  return extensionOf(name) in IMAGE_TYPES;
}

/**
 * The images folder setting (free text) as a '/'-separated path relative to
 * the document ('' for the document's own folder), or null if it would point
 * outside that folder (a `..` segment, a drive `C:` or a home `~` path) or
 * can't be created everywhere or linked to (characters Windows rejects, `#`).
 * Whitespace and leading or trailing slashes are dropped, so " /assets/ "
 * means "assets".
 */
export function normalizeAssetFolder(setting: string): string | null {
  const segments = setting
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.');
  if (segments[0] === '~') return null;
  for (const s of segments) {
    if (s === '..' || /[\u0000-\u001f\u007f<>:"|?*#]/.test(s)) return null;
  }
  return segments.join('/');
}

/** "image-20261011-142305.png": the name a pasted image is saved under. */
export function pastedImageName(extension: string, when: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`;
  const time = `${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
  return `image-${date}-${time}.${extension}`;
}

/**
 * `name` made safe to create on any platform and to link to: no directory
 * part, no characters Windows rejects, no leading dot (hidden) or trailing
 * dots and spaces (Windows drops them), no device names, and a stem of
 * reasonable length. With `extension`, the name gets that extension unless
 * it already has one of the same image type (".jpeg" for "jpg").
 */
export function safeFileName(name: string, extension?: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base.normalize('NFC').replace(UNSAFE_NAME_CHARS, '-').replace(/\s+/g, ' ');
  const dot = clean.lastIndexOf('.');
  let stem = dot > 0 ? clean.slice(0, dot) : clean;
  let ext = dot > 0 ? clean.slice(dot + 1) : '';
  if (extension && IMAGE_TYPES[ext.toLowerCase()] !== IMAGE_TYPES[extension]) {
    // Not the right extension, so it was part of the name ("v1.2" → "v1.2.png").
    if (ext) stem = `${stem}.${ext}`;
    ext = extension;
  }
  stem = stem
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_STEM_LENGTH)
    .replace(/[\s.]+$/, '');
  if (!stem) stem = 'image';
  if (RESERVED_WINDOWS_NAME.test(stem.split('.')[0]!)) stem = `_${stem}`;
  ext = ext.replace(/[\s.]+$/, '');
  return ext ? `${stem}.${ext}` : stem;
}

/** The `n`th alternative to a taken file name: "shot.png" → "shot-1.png". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

/**
 * Where `file` is inside `dir` (at any depth), as a '/'-separated relative
 * path; null if it is outside. On a case-insensitive filesystem the folder
 * may be spelled differently in the two paths; the result keeps the file's
 * own spelling of the names below it.
 */
export function relativeInside(
  dir: string,
  file: string,
  p: PlatformPath,
  caseInsensitive = CASE_INSENSITIVE_FS,
): string | null {
  const below = (from: string, to: string): string[] | null => {
    const rel = p.relative(from, to);
    if (!rel || p.isAbsolute(rel)) return null;
    const segments = rel.split(p.sep);
    return segments[0] === '..' ? null : segments;
  };
  const segments = below(dir, file);
  if (segments) return segments.join('/');
  if (!caseInsensitive) return null;
  const folded = below(pathKey(dir, true), pathKey(file, true));
  if (!folded) return null;
  return p.normalize(file).split(p.sep).slice(-folded.length).join('/');
}

/**
 * A relative '/'-separated path as a Markdown link destination. The preview
 * and GitHub decode %-escapes and end the path at a `?` or `#`, so a `%`,
 * `?` or `#` in a name is %-encoded ("50%20off.png" is "50%2520off.png").
 * Paths with spaces, parentheses or other characters a bare destination
 * can't hold are wrapped in <…>. Null for a path no destination can hold (a
 * line break).
 */
export function markdownDestination(relPath: string): string | null {
  if (/[\r\n]/.test(relPath)) return null;
  const encoded = relPath.replace(/[%?#]/g, encodeURIComponent);
  if (/^[^\s\u0000-\u001f\u007f()<>\\]+$/.test(encoded)) return encoded;
  return `<${encoded.replace(/[<>\\]/g, '\\$&')}>`;
}
