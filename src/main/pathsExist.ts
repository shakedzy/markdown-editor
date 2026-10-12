import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_PATH_CHECKS } from '../shared/types';

const MAX_PATH_LENGTH = 4096;

/**
 * Whether each of `paths`, relative to `dir`, names an existing file or
 * folder, for lint's broken-link warnings. Answers are booleans only, and
 * false only when a path was checked and nothing is there: one that isn't
 * relative, or can't be looked at (permissions, a drive that's gone), is
 * answered true so it isn't reported. Null when `paths` isn't a list of
 * at most MAX_PATH_CHECKS.
 */
export async function pathsExist(dir: string, paths: unknown): Promise<boolean[] | null> {
  if (!Array.isArray(paths) || paths.length > MAX_PATH_CHECKS) return null;
  return Promise.all(paths.map((p) => exists(dir, p)));
}

async function exists(dir: string, relative: unknown): Promise<boolean> {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.length > MAX_PATH_LENGTH ||
    relative.includes('\0') ||
    // Absolute, or (Windows) on another drive or from the drive's root.
    path.parse(relative).root
  ) {
    return true;
  }
  try {
    await fs.stat(path.resolve(dir, relative));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}
