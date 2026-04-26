import { Marked, Tokens } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedAlert from 'marked-alert';
import markedFootnote from 'marked-footnote';
import { markedEmoji } from 'marked-emoji';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import GithubSlugger from 'github-slugger';
import { singleTildeStrikethrough } from './strikethrough';
import { buildEmojiMap } from './emoji';

export interface RenderOptions {
  ghMode: boolean;
  basePath?: string | null;
}

const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|mditor):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const ABSOLUTE_URL = /^[a-z][a-z0-9+.\-]*:|^\/\//i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveAsset(basePath: string | null | undefined, src: string): string {
  if (!src) return src;
  if (ABSOLUTE_URL.test(src)) return src;
  if (src.startsWith('#')) return src;
  if (!basePath) return src;

  const baseNorm = basePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relNorm = src.replace(/\\/g, '/');

  let absPath: string;
  if (relNorm.startsWith('/') || /^[a-z]:/i.test(relNorm)) {
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

  const encoded = encodeURI(absPath);
  return `mditor://local${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

const HTML_ASSET_ATTR =
  /(<(?:img|video|audio|source)\b[^>]*?\s(?:src|poster)\s*=\s*)(["'])([^"']+)\2/gi;

function rewriteRelativeAssetsInHtml(
  html: string,
  basePath: string | null | undefined,
): string {
  if (!basePath) return html;
  return html.replace(HTML_ASSET_ATTR, (match, prefix, quote, src) => {
    if (ABSOLUTE_URL.test(src) || src.startsWith('#') || src.startsWith('mditor:')) {
      return match;
    }
    const resolved = resolveAsset(basePath, src);
    return `${prefix}${quote}${resolved}${quote}`;
  });
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

  m.use(markedKatex({ throwOnError: false, nonStandard: false }));

  if (opts.ghMode) {
    m.use(markedAlert());
    m.use(markedFootnote());
    m.use(
      markedEmoji({
        emojis: buildEmojiMap(),
        renderer: (token) => (token as { emoji: string }).emoji,
      }),
    );
    m.use({ extensions: [singleTildeStrikethrough] });
  }

  m.use({
    renderer: {
      heading(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Heading): string {
        const inner = this.parser.parseInline(token.tokens as Tokens.Generic[]);
        const id = slugger.slug(token.text);
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      link(this: unknown, token: Tokens.Link): string {
        const href = token.href;
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        const isExternal = /^https?:\/\//i.test(href);
        const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
        const text = (this as { parser: { parseInline: (t: Tokens.Generic[]) => string } }).parser.parseInline(token.tokens as Tokens.Generic[]);
        return `<a href="${escapeHtml(href)}"${title}${attrs}>${text}</a>`;
      },
      image(token: Tokens.Image): string {
        const resolved = resolveAsset(opts.basePath, token.href);
        const alt = escapeHtml(token.text || '');
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
        return `<img src="${escapeHtml(resolved)}" alt="${alt}"${title} />`;
      },
    },
  });

  return m;
}

export function renderMarkdown(src: string, opts: RenderOptions): string {
  const m = buildMarked(opts);
  const raw = m.parse(src) as string;
  const rewritten = rewriteRelativeAssetsInHtml(raw, opts.basePath);
  return DOMPurify.sanitize(rewritten, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: ['u'],
    ADD_ATTR: ['id', 'class', 'target', 'rel', 'aria-hidden', 'role', 'align'],
    ALLOWED_URI_REGEXP,
  });
}
