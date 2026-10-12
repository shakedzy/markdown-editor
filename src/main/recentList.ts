import type { PlatformPath } from 'node:path';
import { caseInsensitiveFs, pathKey as keyOf } from '../shared/paths';

// Pure helpers behind File > Open Recent (no Electron or filesystem access).

export const MAX_RECENT = 15;

export const CASE_INSENSITIVE_FS = caseInsensitiveFs(process.platform);

/** Identity of a path on this computer's filesystems (see shared/paths). */
export function pathKey(p: string, caseInsensitive = CASE_INSENSITIVE_FS): string {
  return keyOf(p, caseInsensitive);
}

/** Most-recent-first list, deduplicated and capped. */
export function withRecent(
  list: readonly string[],
  filePath: string,
  caseInsensitive = CASE_INSENSITIVE_FS,
): string[] {
  return normalizeRecent([filePath, ...list], caseInsensitive);
}

export function withoutRecent(
  list: readonly string[],
  filePath: string,
  caseInsensitive = CASE_INSENSITIVE_FS,
): string[] {
  const key = pathKey(filePath, caseInsensitive);
  return list.filter((p) => pathKey(p, caseInsensitive) !== key);
}

/** Keep the first occurrence of each path, up to MAX_RECENT. */
export function normalizeRecent(
  list: readonly string[],
  caseInsensitive = CASE_INSENSITIVE_FS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    const key = pathKey(p, caseInsensitive);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length === MAX_RECENT) break;
  }
  return out;
}

// Trailing directory names shown by default; collisions show more.
const DIR_DEPTH = 2;

interface LabelParts {
  name: string;
  /** Leading part shown only with the whole directory: "/", "C:\", "~" + sep, or "~". */
  root: string;
  segments: string[];
  depth: number;
}

/**
 * Menu labels for `paths`: the file name plus its parent directory, with
 * the home directory as "~" and long directories cut to their last few
 * names ("…/notes/2024"). Entries that would read the same show more of
 * their directory until they differ.
 */
export function recentLabels(
  paths: readonly string[],
  home: string,
  p: PlatformPath,
  caseInsensitive = CASE_INSENSITIVE_FS,
): string[] {
  const parts = paths.map((filePath) => splitDir(filePath, home, p, caseInsensitive));
  for (;;) {
    const labels = parts.map((part) => formatLabel(part, p.sep));
    const byLabel = new Map<string, number[]>();
    labels.forEach((label, i) => byLabel.set(label, [...(byLabel.get(label) ?? []), i]));
    let grew = false;
    for (const indices of byLabel.values()) {
      if (indices.length < 2) continue;
      for (const i of indices) {
        const part = parts[i]!;
        if (part.depth < part.segments.length) {
          part.depth++;
          grew = true;
        }
      }
    }
    if (!grew) return labels;
  }
}

function splitDir(
  filePath: string,
  home: string,
  p: PlatformPath,
  caseInsensitive: boolean,
): LabelParts {
  // Windows accepts "/" too; normalize so the home prefix compares equal.
  const normalized = p.normalize(filePath);
  const name = p.basename(normalized);
  const dir = p.dirname(normalized);
  const homeDir = stripTrailingSep(p.normalize(home), p);
  let root: string;
  let rest: string;
  const underHome =
    p.isAbsolute(homeDir) &&
    p.parse(homeDir).root !== homeDir &&
    pathKey(dir.slice(0, homeDir.length), caseInsensitive) === pathKey(homeDir, caseInsensitive);
  if (underHome && dir.length === homeDir.length) {
    root = '~';
    rest = '';
  } else if (underHome && dir[homeDir.length] === p.sep) {
    root = `~${p.sep}`;
    rest = dir.slice(homeDir.length + 1);
  } else {
    root = p.parse(dir).root;
    rest = dir.slice(root.length);
  }
  const segments = rest.split(p.sep).filter(Boolean);
  return { name, root, segments, depth: Math.min(DIR_DEPTH, segments.length) };
}

function formatLabel({ name, root, segments, depth }: LabelParts, sep: string): string {
  const dir =
    depth >= segments.length
      ? root + segments.join(sep)
      : `…${sep}${segments.slice(-depth).join(sep)}`;
  return `${name} — ${dir}`;
}

function stripTrailingSep(dir: string, p: PlatformPath): string {
  return dir.length > p.parse(dir).root.length && dir.endsWith(p.sep) ? dir.slice(0, -1) : dir;
}
