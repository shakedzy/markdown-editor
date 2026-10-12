import { MutableRefObject, useCallback, useEffect } from 'react';
import { MAX_IMPORT_BYTES } from '../shared/types';
import type { ImportedAsset, IncomingAsset } from '../shared/types';
import { isMarkdownPath } from '../shared/fileTypes';
import { FileInserter, imageAlt, linkText } from './editor/imagePaste';
import { flashStatus } from './components/StatusBar';
import { useLatest } from './useLatest';
import { fileName } from './fileName';

const NOTHING_TO_ADD = 'Only images and files inside the document’s folder can be added';

export interface ImagePasteOptions {
  /** The document's file; null while untitled, when there's no folder to add files to. */
  filePath: string | null;
  /** The images folder setting, relative to the document. */
  imageFolder: string;
  /** Bumped (synchronously) whenever another document takes the window's place. */
  docGen: MutableRefObject<number>;
  /** Open a Markdown file: here or in a new window by default, or as `inThisWindow` says. */
  openPath: (path: string, inThisWindow?: boolean) => Promise<void>;
  /** Images were pasted or dropped while the document is untitled; nothing was saved. */
  onUntitled: () => void;
  /** Saving or linking the files failed. */
  onError: (err: unknown) => void;
  /** Files were added to the document. */
  onAdded: () => void;
}

interface Incoming {
  file: File;
  /** Where it is on disk; null for data another app offered (e.g. a screenshot). */
  path: string | null;
}

function incoming(files: File[]): Incoming[] {
  return files.map((file) => ({ file, path: window.api.pathForFile(file) || null }));
}

function markdownPaths(items: Incoming[]): string[] {
  return items.flatMap(({ path }) => (path !== null && isMarkdownPath(path) ? [path] : []));
}

async function toAsset({ file, path }: Incoming, via: 'paste' | 'drop'): Promise<IncomingAsset> {
  if (path !== null) return { path };
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`The image is too large (over ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`);
  }
  const data = new Uint8Array(await file.arrayBuffer());
  // A pasted image's name ("image.png") is made up; main gives it a dated one.
  return via === 'paste' ? { data, type: file.type } : { data, type: file.type, name: file.name };
}

function markdownFor(asset: ImportedAsset, { file, path }: Incoming, via: 'paste' | 'drop'): string {
  const name = path !== null ? fileName(path) : file.name;
  if (!asset.image) return `[${linkText(name)}](${asset.href})`;
  const alt = via === 'paste' && path === null ? 'image' : imageAlt(name);
  return `![${alt}](${asset.href})`;
}

/**
 * Pasted and dropped files. Returns the editor's FileInserter: images are
 * saved into the images folder (or linked, when already inside the
 * document's folder, as other files are), and dropped Markdown files open.
 * Also takes file drops anywhere else in the window, so Markdown files
 * dropped there open too and no drop navigates the window to the file.
 */
export function useImagePaste(options: ImagePasteOptions): FileInserter {
  const latest = useLatest(options);

  const openMarkdown = useCallback((paths: string[]) => {
    void (async () => {
      // Only the first may take this window's place; the rest get their own.
      for (const [i, path] of paths.entries()) {
        await latest.current.openPath(path, i === 0 ? undefined : false);
      }
    })();
  }, []);

  useEffect(() => {
    const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') === true;
    const onDragOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // Accepting the drag everywhere is what makes a drop outside the editor
      // reach onDrop.
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      // Already handled by the editor.
      if (e.defaultPrevented || !carriesFiles(e)) return;
      e.preventDefault();
      const paths = markdownPaths(incoming(Array.from(e.dataTransfer!.files)));
      if (paths.length) openMarkdown(paths);
      else flashStatus('Drop images into the editor to add them');
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [openMarkdown]);

  return useCallback<FileInserter>(
    async (files, via) => {
      const items = incoming(files);
      if (via === 'drop') {
        const paths = markdownPaths(items);
        if (paths.length) {
          openMarkdown(paths);
          return null;
        }
      }
      // Data with no file behind it can only be an image to save; a file on
      // disk may also be linked.
      const wanted = items.filter((i) => i.path !== null || i.file.type.startsWith('image/'));
      const { filePath, imageFolder, docGen } = latest.current;
      if (filePath === null && wanted.some((i) => i.file.type.startsWith('image/'))) {
        latest.current.onUntitled();
        return null;
      }
      if (filePath === null || wanted.length === 0) {
        flashStatus(NOTHING_TO_ADD);
        return null;
      }

      const gen = docGen.current;
      try {
        const assets = await Promise.all(wanted.map((i) => toAsset(i, via)));
        const results = await window.api.importAssets({
          documentPath: filePath,
          folder: imageFolder,
          assets,
        });
        // The files are in place, but the document they were meant for is gone.
        if (gen !== docGen.current) return null;
        const markdown = results.flatMap((r, i) => (r ? [markdownFor(r, wanted[i]!, via)] : []));
        if (markdown.length === 0) {
          flashStatus(NOTHING_TO_ADD);
          return null;
        }
        latest.current.onAdded();
        return markdown.join('\n');
      } catch (err) {
        if (gen === docGen.current) latest.current.onError(err);
        return null;
      }
    },
    [openMarkdown],
  );
}
