import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  IncomingAsset,
  ImportAssetsArgs,
  ImportedAsset,
  MAX_IMPORT_BYTES,
} from '../shared/types';
import { getDocumentPath } from './watcher';
import {
  imageExtension,
  isImageName,
  markdownDestination,
  normalizeAssetFolder,
  numberedName,
  pastedImageName,
  relativeInside,
  safeFileName,
} from './assetNames';

const MAX_ASSETS = 100;
// Gives up on a name after this many numbered alternatives are taken.
const MAX_NAME_TRIES = 1000;

function parseAsset(value: unknown): IncomingAsset | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path === 'string') {
    return path.isAbsolute(v.path) ? { path: path.resolve(v.path) } : null;
  }
  if (!(v.data instanceof Uint8Array) || typeof v.type !== 'string') return null;
  if (v.name !== undefined && typeof v.name !== 'string') return null;
  return { data: v.data, type: v.type, name: v.name };
}

function parseArgs(value: unknown): ImportAssetsArgs {
  const v = (value ?? {}) as Record<string, unknown>;
  const assets = Array.isArray(v.assets) ? v.assets.map(parseAsset) : [];
  if (
    typeof v.documentPath !== 'string' ||
    typeof v.folder !== 'string' ||
    assets.length === 0 ||
    assets.length > MAX_ASSETS ||
    assets.some((a) => a === null)
  ) {
    throw new Error('Invalid request.');
  }
  return { documentPath: v.documentPath, folder: v.folder, assets: assets as IncomingAsset[] };
}

/**
 * Create a file named `name` in `dir` with `create` (which must fail with
 * EEXIST rather than overwrite), or the first free numbered alternative.
 * Returns the name used.
 */
async function createUnique(
  dir: string,
  name: string,
  create: (target: string) => Promise<void>,
): Promise<string> {
  for (let n = 0; n < MAX_NAME_TRIES; n++) {
    const candidate = n === 0 ? name : numberedName(name, n);
    const target = path.join(dir, candidate);
    try {
      await create(target);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Exclusive creation means anything there now is a partial file of ours.
      await fs.unlink(target).catch(() => undefined);
      throw err;
    }
  }
  throw new Error(`Too many files are already named like ${name}.`);
}

/**
 * Put pasted or dropped files into the document open in `win`, returning
 * what to link to for each (null for one that can't be added). Files already
 * inside the document's folder are linked where they are. Other images are
 * copied, and image data is saved, into the images folder; nothing is ever
 * overwritten. Everything is resolved against the document path main tracks
 * for the window: the renderer only names the setting, which is checked to
 * stay inside the document's folder.
 */
export async function importAssets(
  win: BrowserWindow,
  value: unknown,
): Promise<(ImportedAsset | null)[]> {
  const args = parseArgs(value);
  const docPath = getDocumentPath(win);
  if (!docPath || args.documentPath !== docPath) {
    throw new Error('That file is not the document open in this window.');
  }
  const folder = normalizeAssetFolder(args.folder);
  if (folder === null) {
    throw new Error(
      `The images folder “${args.folder.trim()}” in Settings must be a folder inside the document’s folder.`,
    );
  }
  const docDir = path.dirname(docPath);
  // Its folder may have been deleted or moved along with the file; don't
  // bring it back just to hold an image.
  const realDocDir = await fs.realpath(docDir).catch(() => {
    throw new Error('The document’s folder no longer exists.');
  });
  const targetDir = folder ? path.join(docDir, ...folder.split('/')) : docDir;
  let targetReady = false;
  const saveNew = async (name: string, create: (target: string) => Promise<void>) => {
    if (!targetReady) await fs.mkdir(targetDir, { recursive: true });
    targetReady = true;
    const saved = await createUnique(targetDir, name, create);
    return markdownDestination(folder ? `${folder}/${saved}` : saved);
  };

  const results: (ImportedAsset | null)[] = [];
  for (const asset of args.assets) {
    if ('path' in asset) {
      const source = asset.path;
      // A folder, or a file that is gone by now, has nothing to add.
      const stat = await fs.stat(source).catch(() => null);
      if (!stat?.isFile()) {
        results.push(null);
        continue;
      }
      const image = isImageName(source);
      // Compared by real paths too, so a document opened through a symlinked
      // folder still counts files dropped from the real one as inside it.
      const realSource = await fs
        .realpath(path.dirname(source))
        .then((dir) => path.join(dir, path.basename(source)), () => source);
      const inside =
        relativeInside(docDir, source, path) ?? relativeInside(realDocDir, realSource, path);
      let href: string | null = null;
      if (inside !== null) {
        href = markdownDestination(inside);
      } else if (image) {
        href = await saveNew(safeFileName(path.basename(source)), (target) =>
          fs.copyFile(source, target, constants.COPYFILE_EXCL),
        );
      }
      results.push(href === null ? null : { href, image });
      continue;
    }

    const extension = imageExtension(asset.type);
    if (!extension) {
      results.push(null);
      continue;
    }
    if (asset.data.byteLength > MAX_IMPORT_BYTES) {
      throw new Error(`The image is too large (over ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`);
    }
    const name =
      asset.name === undefined
        ? pastedImageName(extension, new Date())
        : safeFileName(asset.name, extension);
    const href = await saveNew(name, (target) =>
      fs.writeFile(target, asset.data, { flag: 'wx' }),
    );
    results.push(href === null ? null : { href, image: true });
  }
  return results;
}
