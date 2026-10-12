import { Marked, Tokens } from 'marked';
import type { MarkedExtension, MaybePromise, Token } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedAlert from 'marked-alert';
import markedFootnote from 'marked-footnote';
import { markedEmoji } from 'marked-emoji';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import GithubSlugger from 'github-slugger';
import { escapeHtml } from '../exportHtml';
import { decodeLinkPath } from '../links';
import { buildEmojiMap } from './emoji';
import { renderFrontMatter, splitFrontMatter } from './frontmatter';
import { sourceLines, tagFirstElement } from './sourceLines';

export interface RenderOptions {
  ghMode: boolean;
  basePath?: string | null;
}

const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|mditor):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const ABSOLUTE_URL = /^[a-z][a-z0-9+.\-]*:/i;

// "//host/x.png" takes the page's scheme. On a file: page (packaged builds,
// the PDF export) that is file://host/x.png, which Windows reads from the
// network share \\host and signs in to. GitHub serves it over https:, and
// so does the preview. Other paths that start with two slashes or
// backslashes (\\host\share\x.png, /\host/x.png) are network paths, which
// become mditor: URLs like any absolute path, and main won't read them.
const PROTOCOL_RELATIVE = /^\/\//;

// The document's folder, for the render in progress (sanitizing doesn't
// wait on anything, so no other render can start in between).
let mediaBase: string | null | undefined;

// The preview's own sanitizer, so its hooks aren't shared (or re-added on
// every render). DOMPurify drops ids that shadow a `document` property
// (`links`, `title`, `images`...); headings can't clobber those, and links
// and the exports need their ids. Every src and poster of an image or media
// element, a markdown image's or raw HTML's (in any order, quoted or not,
// with entities), is resolved against the document's folder as parsed.
const purify = DOMPurify(window);
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'id' && /^H[1-6]$/.test(node.nodeName)) data.forceKeepAttr = true;
  if (
    (data.attrName === 'src' || data.attrName === 'poster') &&
    /^(?:IMG|VIDEO|AUDIO|SOURCE)$/.test(node.nodeName)
  ) {
    data.attrValue = resolveAsset(mediaBase, asParsedUrl(data.attrValue));
  }
});

// A URL attribute's value as the browser reads it: without the spaces and
// control characters around it, or any tab or newline.
function asParsedUrl(value: string): string {
  return value.replace(/^[\0-\x20]+|[\0-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
}

function resolveAsset(basePath: string | null | undefined, src: string): string {
  if (!src) return src;
  if (PROTOCOL_RELATIVE.test(src)) return `https:${src}`;
  if (ABSOLUTE_URL.test(src)) return src;
  if (src.startsWith('#')) return src;

  // The path's %-escapes name characters ("my%20file.png" is "my file.png"),
  // as in a browser or on GitHub; a query or fragment after it is kept.
  const pathEnd = src.search(/[?#]|$/);
  const relNorm = decodeLinkPath(src.slice(0, pathEnd)).replace(/\\/g, '/');
  // An absolute path names its file in a document with no folder yet too.
  const isAbsPath = relNorm.startsWith('/') || /^[a-z]:/i.test(relNorm);
  if (!basePath && !isAbsPath) return src;
  const baseNorm = (basePath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

  let absPath: string;
  if (isAbsPath) {
    absPath = relNorm;
  } else {
    const segs = baseNorm.split('/').filter((s) => s !== '');
    const relSegs = relNorm.split('/');
    for (const seg of relSegs) {
      if (seg === '..') segs.pop();
      else if (seg !== '.' && seg !== '') segs.push(seg);
    }
    const isUnixAbs = baseNorm.startsWith('/');
    absPath = (isUnixAbs ? '/' : '') + segs.join('/');
  }

  // A ? or # in a file or folder name is part of the path, not a query or
  // fragment; main decodes the path once.
  const encoded =
    encodeURI(absPath).replace(/[?#]/g, encodeURIComponent) + encodeURI(src.slice(pathEnd));
  return `mditor://local${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/**
 * marked 14's `walkTokens` grows its result with `values.concat(...)` for
 * every token, which is quadratic in the token count: with the extensions
 * below hooking it, a 1 MB document blocked the preview for half a minute.
 * This is the same walk, in the same order, collected into one array.
 */
function walkTokensLinearly(m: Marked): void {
  m.walkTokens = (tokens, callback) => {
    const values: MaybePromise[] = [];
    const walk = (list: readonly Token[]): void => {
      for (const token of list) {
        const ret = callback.call(m, token);
        if (Array.isArray(ret)) values.push(...ret);
        else values.push(ret);
        if (token.type === 'table') {
          const table = token as Tokens.Table;
          for (const cell of table.header) walk(cell.tokens);
          for (const row of table.rows) for (const cell of row) walk(cell.tokens);
        } else if (token.type === 'list') {
          walk((token as Tokens.List).items);
        } else {
          const generic = token as Tokens.Generic;
          const childTokens = m.defaults.extensions?.childTokens?.[generic.type];
          if (childTokens) {
            for (const key of childTokens) walk(generic[key].flat(Infinity));
          } else if (generic.tokens) {
            walk(generic.tokens);
          }
        }
      }
    };
    walk(tokens);
    return values;
  };
}

/**
 * Before each run of plain text, marked asks every inline extension where
 * its next token starts, passing the rest of the paragraph. marked-emoji
 * runs its regex of 1,900 names over all of it, to the paragraph's end when
 * no emoji follows, so a long paragraph of lines (a pasted log, hard-wrapped
 * prose) took quadratic time: a 300 KB log froze the window for 20 s. This
 * searches a short way ahead instead. With no emoji there, the text run ends
 * where marked would end it anyway, or else before a plain word, and the next
 * run searches on from there.
 */
const EMOJI_WINDOW = 512;

// The characters of an e-mail address's name, as marked's GFM text rule has them.
const NAME_CHARS = "a-zA-Z0-9.!#$%&'*+/=?_`{|}~-";

// Where marked's GFM text rule ends a run of text that gets that far: before
// \ < [ ! * _ ` or ~, before http://, https://, ftp:// or www., and before an
// address's name and @ that follow a character no name has. Clipping the run
// just past such a stop gives the same token: the rule still sees all of the
// stop, and an extension that clips the run sooner (marked-katex can, even
// inside a URL) clips it the same way without us. Tab- or comma-separated
// lines and JSON lines have these stops but no plain word. A ` or ~ counts
// only right after some other character: a run that starts with them reads
// on through them.
const STOP = new RegExp(
  `[\\\\<[]|(?:https?|ftp)://|((?<=[^\`~])[\`~]|[!*_]|www\\.)|(?<=[^:${NAME_CHARS}])[${NAME_CHARS}]+@`,
  'g',
);
const NAME_RUN = new RegExp(`[${NAME_CHARS}]*`, 'y');

/**
 * The first stop in `text`. The rule's address check reads on through name
 * characters to an @, so a stop isn't inside a name that an @ follows (or
 * that runs on past `text`), or just after a colon (http:).
 */
function firstStop(text: string): RegExpExecArray | null {
  STOP.lastIndex = 0;
  let stop: RegExpExecArray | null;
  while ((stop = STOP.exec(text))) {
    if (stop[1] === undefined) return stop;
    NAME_RUN.lastIndex = stop.index;
    NAME_RUN.exec(text);
    const next = text[NAME_RUN.lastIndex];
    if (next !== undefined && next !== '@') return stop;
    // Nor is any stop further on in that name.
    STOP.lastIndex = NAME_RUN.lastIndex;
  }
  return null;
}

/** Where to clip a run of text that ends at `stop`: just past it. */
function pastStop(stop: RegExpExecArray): number {
  return stop.index + stop[0].length;
}

// A word of letters or digits between spaces or line breaks. Ending a text
// run just before one changes no token: nothing marked or the extensions
// read (an entity, URL, e-mail address, emoji name or math) spans the space,
// and no tokenizer starts on the word unless the run would have ended there
// anyway. Both runs are text, which marked joins into one token.
const PLAIN_WORD = /[ \n][\p{L}\p{N}]+[ \n]/u;

function boundEmojiStart(ext: MarkedExtension): MarkedExtension {
  for (const e of ext.extensions ?? []) {
    if (!('start' in e) || !e.start) continue;
    const start = e.start;
    e.start = function (src) {
      if (src.length <= EMOJI_WINDOW) return start.call(this, src);
      // Emoji names have no colons or spaces, so the first `:name:` in the
      // head is the first in the paragraph, and one that runs past the head
      // starts after any plain word in it. No emoji is over 42 characters or
      // starts inside a stop, so one that starts before a stop ends within
      // half a window of it.
      const head = src.slice(0, EMOJI_WINDOW);
      const found = start.call(this, head);
      if (found !== undefined) return found;
      const stop = firstStop(head);
      if (stop && stop.index < EMOJI_WINDOW / 2) return pastStop(stop);
      const word = PLAIN_WORD.exec(head.slice(EMOJI_WINDOW / 2));
      if (word) return EMOJI_WINDOW / 2 + word.index + 1;
      // A long run of text: search a few windows on for where it ends (not
      // all the way, which costs more than the full search when it doesn't).
      const end = firstStop(src.slice(0, 8 * EMOJI_WINDOW));
      if (!end) return start.call(this, src);
      return start.call(this, src.slice(0, end.index + EMOJI_WINDOW / 2)) ?? pastStop(end);
    };
  }
  return ext;
}

function buildMarked(opts: RenderOptions): Marked {
  const slugger = new GithubSlugger();

  const m = new Marked(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        if (lang === 'mermaid') return code;
        const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
        try {
          return hljs.highlight(code, { language, ignoreIllegals: true }).value;
        } catch {
          return code;
        }
      },
    }),
  );

  m.setOptions({ gfm: true, breaks: false, async: false });
  walkTokensLinearly(m);

  m.use(markedKatex({ throwOnError: false, nonStandard: false }));

  if (opts.ghMode) {
    m.use(markedAlert());
    m.use(markedFootnote());
    m.use(
      boundEmojiStart(
        markedEmoji({
          emojis: buildEmojiMap(),
          renderer: (token) => (token as { emoji: string }).emoji,
        }),
      ),
    );
  }

  m.use({
    renderer: {
      heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Heading): string {
        const inner = this.parser.parseInline(token.tokens as Tokens.Generic[]);
        const id = slugger.slug(token.text);
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      // marked's tokenizer has already escaped link titles and image alt
      // text (keeping entities as written); escaping them again would show
      // "&amp;" in tooltips and alt text.
      link(this: unknown, token: Tokens.Link): string {
        const href = token.href;
        const title = token.title ? ` title="${token.title}"` : '';
        const isExternal = /^https?:\/\//i.test(href);
        const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
        const text = (this as { parser: { parseInline: (t: Tokens.Generic[]) => string } }).parser.parseInline(token.tokens as Tokens.Generic[]);
        return `<a href="${escapeHtml(href)}"${title}${attrs}>${text}</a>`;
      },
      // Enabled (marked defaults to `disabled`) so task checkboxes can be
      // toggled from the preview; the class lets the preview tell them apart
      // from any raw-HTML inputs in the document.
      checkbox({ checked }: Tokens.Checkbox): string {
        return `<input type="checkbox" class="task-list-item-checkbox"${checked ? ' checked=""' : ''}>`;
      },
      // The sanitizer resolves its src, as it does raw HTML's.
      image(token: Tokens.Image): string {
        const alt = token.text || '';
        const title = token.title ? ` title="${token.title}"` : '';
        return `<img src="${escapeHtml(token.href)}" alt="${alt}"${title} />`;
      },
    },
  });

  return m;
}

export function renderMarkdown(src: string, opts: RenderOptions): string {
  const m = buildMarked(opts);
  const { data, body, bodyLineOffset } = splitFrontMatter(src);
  // Blocks carry their source line (`data-line`) for scroll sync.
  m.use(sourceLines(body, bodyLineOffset));
  const frontMatter = data === null ? '' : tagFirstElement(renderFrontMatter(data), 1);
  const raw = frontMatter + (m.parse(body) as string);
  mediaBase = opts.basePath;
  try {
    return purify.sanitize(raw, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
      ADD_TAGS: ['u'],
      ADD_ATTR: ['id', 'class', 'target', 'rel', 'aria-hidden', 'role', 'align'],
      ALLOWED_URI_REGEXP,
    });
  } finally {
    mediaBase = undefined;
  }
}
