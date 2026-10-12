import { Annotation, Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, ViewUpdate, dropCursor } from '@codemirror/view';

/**
 * Turns files pasted or dropped into the editor into the Markdown to insert
 * for them (null: nothing to insert). It may take a moment (files are
 * written to disk); the editor stays usable meanwhile.
 */
export type FileInserter = (files: File[], via: 'paste' | 'drop') => Promise<string | null>;

/**
 * Whether a paste should add the clipboard's images rather than its text.
 * Office and web pages put a picture of the copied text next to the text
 * itself (with a rich-text version); there the text wins. A screenshot, a
 * copied image, or an image file copied in the file manager (which comes
 * with its name as text, but no rich text) is pasted as an image.
 */
export function pastesImages(
  fileTypes: readonly string[],
  types: readonly string[],
  getData: (type: string) => string,
): boolean {
  if (!fileTypes.some((t) => t.startsWith('image/'))) return false;
  if (!/\S/.test(getData('text/plain'))) return true;
  if (types.includes('text/rtf')) return false;
  const html = types.includes('text/html') ? getData('text/html') : '';
  return !htmlHasText(html);
}

/** Whether `html` has any visible text (an `<img>`'s alt doesn't count). */
export function htmlHasText(html: string): boolean {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ');
  return /[^\s ]/.test(text);
}

/** Alt text for an image: a file name without its extension, escaped for `![…]`. */
export function imageAlt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = (dot > 0 ? fileName.slice(0, dot) : fileName).replace(/\s+/g, ' ').trim();
  return (stem || 'image').replace(/[[\]\\]/g, '\\$&');
}

/**
 * Link text showing `fileName` as is: characters that would start Markdown
 * formatting (or math) are escaped. Underscores only need it at word edges.
 */
export function linkText(fileName: string): string {
  return fileName
    .replace(/\s+/g, ' ')
    .replace(/[\\`*[\]<>~$&]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\$&');
}

interface Target {
  from: number;
  to: number;
}

// Marks the transactions that insert a finished paste or drop.
const ownInsertion = Annotation.define<true>();

class FileInsertion {
  // Where each insertion still waiting for its Markdown goes, kept in step
  // with edits made in the meantime.
  private readonly pending = new Set<Target>();
  // Insertions land in the order they were pasted or dropped, however long
  // each one takes.
  private queue: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    private readonly view: EditorView,
    private readonly getInserter: () => FileInserter | undefined,
  ) {
    view.dom.addEventListener('drop', this.onOuterDrop);
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged || this.pending.size === 0) return;
    for (const tr of update.transactions) {
      // Text typed at a caret paste lands after the image, but an earlier
      // paste at the same spot lands before it. Text typed at the edges of a
      // replaced selection is kept.
      const typed = !tr.annotation(ownInsertion);
      for (const target of this.pending) {
        const caret = target.from === target.to;
        target.from = tr.changes.mapPos(target.from, caret && typed ? -1 : 1);
        target.to = Math.max(target.from, tr.changes.mapPos(target.to, -1));
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.view.dom.removeEventListener('drop', this.onOuterDrop);
  }

  paste(event: ClipboardEvent): boolean {
    const data = event.clipboardData;
    if (!data || this.view.state.readOnly) return false;
    const files = Array.from(data.files);
    if (!pastesImages(files.map((f) => f.type), data.types, (t) => data.getData(t))) return false;
    const { from, to } = this.view.state.selection.main;
    this.insert(files, 'paste', { from, to });
    return true;
  }

  // Every file drop is handled here, so CodeMirror never inserts a dropped
  // file's raw contents.
  drop(event: DragEvent): boolean {
    const files = event.dataTransfer?.files;
    if (!files?.length || this.view.state.readOnly) return false;
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    this.insert(Array.from(files), 'drop', { from: pos, to: pos });
    return true;
  }

  // CodeMirror only listens on the content; drops on the gutter land here.
  private readonly onOuterDrop = (event: DragEvent): void => {
    if (event.defaultPrevented || this.view.contentDOM.contains(event.target as Node)) return;
    if (this.drop(event)) event.preventDefault();
  };

  private insert(files: File[], via: 'paste' | 'drop', target: Target): void {
    const inserter = this.getInserter();
    if (!inserter) return;
    this.pending.add(target);
    const report = (err: unknown) => console.error('Couldn’t insert files:', err);
    const markdown = inserter(files, via).catch((err: unknown) => {
      report(err);
      return null;
    });
    this.queue = this.queue
      .then(() => markdown)
      .then((text) => {
        this.pending.delete(target);
        if (text && !this.destroyed) this.apply(text, via, target);
      })
      .catch(report);
  }

  private apply(text: string, via: 'paste' | 'drop', { from, to }: Target): void {
    const { view } = this;
    const { main } = view.state.selection;
    // The caret follows the new text, unless it was moved away meanwhile.
    const moveCaret = via === 'drop' || (main.from === from && main.to === to);
    view.dispatch({
      changes: { from, to, insert: text },
      selection: moveCaret ? { anchor: from + text.length } : undefined,
      scrollIntoView: moveCaret,
      userEvent: via === 'paste' ? 'input.paste' : 'input.drop',
      annotations: ownInsertion.of(true),
    });
    if (via === 'drop') view.focus();
  }
}

/**
 * Pasting images and dropping files into the editor. CodeMirror would paste
 * nothing for an image and insert a dropped file's raw contents; instead the
 * files go to `getInserter()`, and the Markdown it returns is inserted where
 * they were pasted (replacing the selection) or dropped. Plain text pastes
 * and drops work as before. Also draws a caret where a drag would drop.
 */
export function fileInsertion(getInserter: () => FileInserter | undefined): Extension {
  const plugin = ViewPlugin.define((view) => new FileInsertion(view, getInserter), {
    eventHandlers: {
      paste(event) {
        return this.paste(event);
      },
      drop(event) {
        return this.drop(event);
      },
    },
  });
  return [dropCursor(), plugin];
}
