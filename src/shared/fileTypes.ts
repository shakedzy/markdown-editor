// The file types the app opens as documents, for main and the renderer alike.

/** Extensions of Markdown files (lowercase, no dot), as offered in Open and Save dialogs. */
export const MARKDOWN_EXTENSIONS = ['md', 'markdown', 'mdown', 'mkd'] as const;

const MARKDOWN_PATH = new RegExp(`\\.(?:${MARKDOWN_EXTENSIONS.join('|')})$`, 'i');

/** Whether the file name or path `p` has a Markdown extension. */
export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_PATH.test(p);
}

/** `name` without its Markdown extension ("notes" for notes.md). */
export function stripMarkdownExtension(name: string): string {
  return name.replace(MARKDOWN_PATH, '');
}
