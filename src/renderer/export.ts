// Exports of the live preview. Capturing the already-rendered preview DOM
// means mermaid diagrams, KaTeX math, and syntax highlighting come along for
// free — the output matches what's on screen. The PDF and the HTML file share
// one document template (exportHtml.ts) and embed their fonts: the PDF is
// printed by the main process with the app's styles as they are, its window
// loading local images from the files, while the HTML file keeps only the
// document's styles and embeds its local images too, so it opens anywhere on
// its own.

import {
  absolutizeCssUrls,
  buildExportDocument,
  cssUrls,
  documentName,
  exportFileName,
  isDocumentSelector,
  isExportableCss,
  isLocalMediaUrl,
  localFileUrl,
  preferWoff2Sources,
  reachesOtherHost,
  replaceCssUrls,
  splitTopLevel,
  styleElementText,
} from './exportHtml';
import { displayName } from './fileName';
import { diagramDrawing, renderMermaid } from './mermaid';

/**
 * The rules of every same-origin stylesheet the app has loaded (app.css,
 * preview.css, hljs-theme.css, katex.min.css), with the URL each sheet's
 * relative url()s resolve against. Those are the sheets in <head>: a <style>
 * in the preview is the document's own, untrusted, and travels in its
 * markup. Cross-origin sheets throw on `cssRules` access and are skipped.
 */
export function appStyleSheets(): { rules: CSSRule[]; base: string }[] {
  const sheets: { rules: CSSRule[]; base: string }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (!sheet.ownerNode || !document.head.contains(sheet.ownerNode)) continue;
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (rules) sheets.push({ rules: Array.from(rules), base: sheet.href ?? document.baseURI });
  }
  return sheets;
}

// The app's CSS as text. `serialize` can drop a rule (by returning '') or
// rewrite it. URLs are made absolute: the rules move into a document that
// lives elsewhere, and a bundled sheet's font URLs are relative to the sheet.
function collectStyles(serialize: (rule: CSSRule) => string = (rule) => rule.cssText): string {
  let css = '';
  for (const { rules, base } of appStyleSheets()) {
    let text = '';
    for (const rule of rules) {
      const serialized = serialize(rule);
      if (serialized) text += serialized + '\n';
    }
    css += absolutizeCssUrls(text, base);
  }
  return css;
}

// Overrides applied on top of the app styles so the document paginates cleanly:
// force a light, white page, let the scroll container flow to full height, wrap
// long code lines, and keep blocks from splitting awkwardly across pages.
const PRINT_OVERRIDES = `
html, body { height: auto !important; overflow: visible !important; margin: 0; padding: 0; background: #ffffff !important; }
.preview { flex: none !important; height: auto !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; }
.preview pre { white-space: pre-wrap; word-wrap: break-word; }
.preview pre, .preview table, .preview img, .preview blockquote, .preview .mermaid-rendered, .preview .katex-display { break-inside: avoid; }
.preview h1, .preview h2, .preview h3, .preview h4, .preview h5, .preview h6 { break-after: avoid; }
`;

// The standalone page: a centered, readable column on the light theme.
const STANDALONE_OVERRIDES = `
html, body { margin: 0; padding: 0; background: var(--color-bg); color: var(--color-text); }
body { font-size: 16px; }
.preview { max-width: 860px; margin: 0 auto; padding: 40px 24px 64px; overflow: visible; }
.preview input.task-list-item-checkbox { cursor: default; }
`;

// KaTeX's fonts are only worth embedding when there is math to set.
function isUnusedFont(rule: CSSRule, math: boolean): boolean {
  return (
    rule instanceof CSSFontFaceRule &&
    !math &&
    /katex/i.test(rule.style.getPropertyValue('font-family'))
  );
}

// The CSS the PDF keeps: all of the app's.
function printRule(rule: CSSRule, math: boolean): string {
  return isUnusedFont(rule, math) ? '' : rule.cssText;
}

// The CSS a standalone document keeps (see isDocumentSelector). Grouping rules
// keep just their document rules; animations only serve the app chrome and
// the TOC's heading flash.
function standaloneRule(rule: CSSRule, math: boolean): string {
  if (rule instanceof CSSStyleRule) {
    return isDocumentSelector(rule.selectorText, { math }) ? rule.cssText : '';
  }
  if (isUnusedFont(rule, math)) return '';
  if (rule instanceof CSSKeyframesRule) return '';
  if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
    const inner = Array.from(rule.cssRules)
      .map((r) => standaloneRule(r, math))
      .filter(Boolean)
      .join('\n');
    const kind = rule instanceof CSSMediaRule ? 'media' : 'supports';
    return inner ? `@${kind} ${rule.conditionText} {\n${inner}\n}` : '';
  }
  return rule.cssText;
}

/**
 * Strip what only makes sense inside the editor from detached preview
 * content: the front matter block, the TOC / "take me there" flash
 * highlights, and scroll-sync line markers. Checkbox state is written to the
 * `checked` attribute, since serializing keeps attributes, not live state.
 * A <template> goes whole: the preview never shows it, and its content, a
 * fragment of its own, is out of reach of querySelectorAll and so of the
 * export's sanitizing.
 */
export function cleanExportContent(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('.frontmatter, template'))) el.remove();
  for (const el of Array.from(root.querySelectorAll('.heading-flash, .text-flash'))) {
    el.classList.remove('heading-flash', 'text-flash');
    if (el.classList.length === 0) el.removeAttribute('class');
  }
  for (const el of Array.from(root.querySelectorAll('[data-line]'))) el.removeAttribute('data-line');
  for (const box of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    box.toggleAttribute('checked', box.checked);
  }
}

// Whether nothing from `el` up to (not including) `ancestor` is display: none.
function isDisplayedWithin(el: Element, ancestor: Element): boolean {
  for (let node: Element | null = el; node && node !== ancestor; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

// Whether the preview shows `el`, or would once the closed <details> it is in
// is opened. An image that loaded but takes up no space is hidden too. Best
// effort: media made invisible some other way (opacity: 0, placed off-screen,
// a pixel in size) counts as shown.
function isShown(el: Element): boolean {
  if (getComputedStyle(el).visibility !== 'visible') return false;
  const rects = Array.from(el.getClientRects());
  if (rects.length > 0) {
    const loaded = el instanceof HTMLImageElement && el.naturalWidth > 0;
    return !loaded || rects.some((r) => r.width > 0 && r.height > 0);
  }
  const details = el.parentElement?.closest('details:not([open])');
  if (!details || !isDisplayedWithin(el, details)) return false;
  return isShown(details);
}

/**
 * Run `measure` with the preview laid out. Its pane is display: none in Tabs
 * view on the Editor tab and in focus mode, where nothing in it has a box to
 * measure; it is then laid out off-screen for the moment, at the workspace's
 * size. Shown and hidden again in one task, it never paints, and no resize
 * or intersection observer sees it.
 */
function withPreviewLaidOut<T>(host: HTMLElement, measure: () => T): T {
  const pane = host.closest<HTMLElement>('.workspace-preview');
  const workspace = pane?.parentElement;
  if (host.getClientRects().length > 0 || !pane || !workspace) return measure();
  const saved = pane.getAttribute('style');
  const { width, height } = workspace.getBoundingClientRect();
  pane.setAttribute(
    'style',
    `${saved ?? ''}; display: flex; position: fixed; top: 0; left: -100000px;` +
      ` width: ${width || innerWidth}px; height: ${height || innerHeight}px;`,
  );
  try {
    return measure();
  } finally {
    if (saved === null) pane.removeAttribute('style');
    else pane.setAttribute('style', saved);
  }
}

const MEDIA_ELEMENTS = 'img, video, audio';

// Remove from `copies` (copies of the preview's media `live`, in the same
// order) the ones the preview doesn't show, so an export never carries a
// file the user hasn't seen.
function dropHiddenMedia(
  host: HTMLElement,
  live: readonly Element[],
  copies: ArrayLike<Element>,
): void {
  const hidden = withPreviewLaidOut(host, () => live.map((el) => !isShown(el)));
  hidden.forEach((isHidden, i) => {
    if (isHidden) copies[i]?.remove();
  });
}

/** A detached, cleaned copy of the rendered preview, without the media it hides. */
export function clonePreview(host: HTMLElement): HTMLElement {
  const root = host.cloneNode(true) as HTMLElement;
  // The copy matches the preview element for element.
  const live = Array.from(host.querySelectorAll(MEDIA_ELEMENTS));
  dropHiddenMedia(host, live, root.querySelectorAll(MEDIA_ELEMENTS));
  cleanExportContent(root);
  return root;
}

/**
 * A copy of what `range`, a selection in the preview `host`, takes in,
 * without the media the preview hides.
 */
export function cloneRangeContents(range: Range, host: HTMLElement): DocumentFragment {
  const content = range.cloneContents();
  // The copy has the media the range takes in, wholly or in part, in order;
  // not one the whole range is inside.
  const common = range.commonAncestorContainer;
  const live = Array.from(host.querySelectorAll(MEDIA_ELEMENTS)).filter(
    (el) => range.intersectsNode(el) && !el.contains(common),
  );
  dropHiddenMedia(host, live, content.querySelectorAll(MEDIA_ELEMENTS));
  return content;
}

function readAsset(url: string): Promise<string | null> {
  return window.api.readAssetDataUrl(url).catch(() => null);
}

const MEDIA_ATTRIBUTES = [
  ['img', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['source', 'src'],
] as const;

/**
 * Embed the document's local images and media (mditor:// URLs, which only
 * resolve inside the app) as data: URIs. A file that can't be embedded (too
 * large, unreadable) gets its file: URL instead, or none on a network share.
 * Web URLs are left alone.
 */
export async function embedLocalMedia(root: HTMLElement): Promise<void> {
  const reads = new Map<string, Promise<string | null>>();
  const updates: Promise<void>[] = [];
  for (const [tag, attr] of MEDIA_ATTRIBUTES) {
    for (const el of Array.from(root.querySelectorAll(`${tag}[${attr}]`))) {
      const url = el.getAttribute(attr) ?? '';
      if (!isLocalMediaUrl(url)) continue;
      let read = reads.get(url);
      if (!read) {
        read = readAsset(url);
        reads.set(url, read);
      }
      updates.push(
        read.then((data) => {
          const embedded = data ?? localFileUrl(url);
          if (embedded === null) el.removeAttribute(attr);
          else el.setAttribute(attr, embedded);
        }),
      );
    }
  }
  await Promise.all(updates);
}

// Attributes holding a URL that a page loads, or follows on a click.
const URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'xlink:href',
  'poster',
  'background',
  'action',
  'formaction',
]);

// Remove the declarations in `style` an export doesn't keep: custom
// properties, which only var() reads, and values isExportableCss rejects. A
// longhand reads '' when its shorthand holds a var() or names a system font
// (`font: caption`), and only cssText, which writes that shorthand out as
// given, tells which. When that text fails the check (a var() is in it),
// those longhands go, and with them the shorthand. Otherwise the text is read
// back in, which drops the longhands it writes alone and empty (those of a
// shorthand it can't write whole).
function dropUnexportableDeclarations(style: CSSStyleDeclaration): void {
  const unread: string[] = [];
  // Names first (removing shifts the rest); some blocks, like @position-try's,
  // can't be iterated but have item().
  for (const name of Array.from({ length: style.length }, (_, i) => style.item(i))) {
    const value = style.getPropertyValue(name);
    if (name.startsWith('--') || !isExportableCss(value)) style.removeProperty(name);
    else if (!value) unread.push(name);
  }
  if (unread.length === 0) return;
  // Shorthands only read back whole: check them one declaration at a time.
  style.cssText = splitTopLevel(style.cssText, ';').filter(isExportableCss).join(';');
}

// The same for the rules in `list`, nested ones too; a rule with no
// declarations of its own (@property, @counter-style…) goes whole. A
// namespace's URL is only its name.
function dropUnexportableRules(list: CSSStyleSheet | CSSGroupingRule): void {
  for (let i = list.cssRules.length - 1; i >= 0; i--) {
    const rule = list.cssRules[i];
    const style = 'style' in rule && rule.style instanceof CSSStyleDeclaration ? rule.style : null;
    const hasRules = 'cssRules' in rule;
    if (style) dropUnexportableDeclarations(style);
    // @keyframes too: all its rules are keyframes, which have declarations.
    if (hasRules) dropUnexportableRules(rule as CSSGroupingRule);
    const isLeaf = !style && !hasRules && !(rule instanceof CSSNamespaceRule);
    if (isLeaf && !isExportableCss(rule.cssText)) list.deleteRule(i);
  }
}

// A document <style> rewritten as the browser parses it, without what an
// export doesn't keep. Only what was parsed, and so checked, is written back:
// the sheet is built on its own, which loads nothing and drops @import.
function rewriteSheet(style: Element): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(style.textContent ?? '');
  dropUnexportableRules(sheet);
  const css = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  style.textContent = styleElementText(css);
}

/**
 * Remove from an export every reference to a file on another computer (see
 * reachesOtherHost). The preview never loads one: main refuses to. But an
 * export is opened from disk, or pasted, where nothing stops it, and on
 * Windows loading one signs in to that computer. Links and media lose the
 * URL. The document's CSS (style elements and attributes, SVG presentation
 * attributes) loses its custom properties, var()s and every url() but data:,
 * https: and #fragment ones (see isExportableCss).
 */
export function dropNetworkReferences(root: HTMLElement): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const { name, value } of Array.from(el.attributes)) {
      const attr = name.toLowerCase();
      // srcset: the candidates' URLs (a comma inside one only splits it further).
      const urls =
        attr === 'srcset' ? value.split(/[\s,]+/) : URL_ATTRIBUTES.has(attr) ? [value] : null;
      // An SVG element's other attributes may be CSS: a presentation
      // attribute (fill, mask, filter, marker-end…) takes a url(), which
      // needs a "(". An HTML element's (alt, title…) are only text.
      const drop = urls
        ? urls.some(reachesOtherHost)
        : el instanceof SVGElement &&
          attr !== 'style' &&
          value.includes('(') &&
          !isExportableCss(value);
      if (drop) el.removeAttribute(name);
    }
    // Written back as parsed, as a <style> is.
    if (el.hasAttribute('style')) {
      const inline = (el as Partial<ElementCSSInlineStyle>).style;
      if (inline) dropUnexportableDeclarations(inline);
      if (inline?.cssText) el.setAttribute('style', inline.cssText);
      else el.removeAttribute('style');
    }
  }
  for (const style of Array.from(root.querySelectorAll('style'))) rewriteSheet(style);
}

/**
 * Draw the diagrams the preview shows in the dark theme again in the light
 * one, which the export's page is. `root` is a copy of `host`. A diagram that
 * fails to redraw keeps its dark drawing.
 */
async function lightDiagrams(host: HTMLElement, root: HTMLElement): Promise<void> {
  const copies = root.querySelectorAll('.mermaid-rendered');
  const redraws = Array.from(host.querySelectorAll('.mermaid-rendered'), async (el, i) => {
    const drawing = diagramDrawing(el);
    const copy = copies[i];
    if (!drawing || drawing.theme === 'default' || !copy) return;
    const svg = await renderMermaid(drawing.code, 'default').catch(() => null);
    if (svg !== null) copy.innerHTML = svg;
  });
  await Promise.all(redraws);
}

// Swap the stylesheet's font (and any other) URLs for data: URIs. A URL the
// main process won't serve stays as it is; the browser then falls back to
// the next font in the stack. The app's styles never name the user's files.
async function embedCssAssets(css: string): Promise<string> {
  const urls = cssUrls(css).filter((url) => !isLocalMediaUrl(url));
  const data = await Promise.all(urls.map(readAsset));
  const embedded = new Map<string, string>();
  urls.forEach((url, i) => {
    const uri = data[i];
    if (uri) embedded.set(url, uri);
  });
  return replaceCssUrls(css, embedded);
}

/**
 * Point the copy's local media at `origin`, a mditor: host made up for one
 * export, rather than the preview's (main serves every host the same). The
 * PDF page may load media from that host alone, so the document's own CSS
 * can't have it load a file the preview never showed, such as a background
 * only the export page's structure matches.
 */
function moveLocalMedia(root: HTMLElement, origin: string): void {
  for (const [tag, attr] of MEDIA_ATTRIBUTES) {
    for (const el of Array.from(root.querySelectorAll(`${tag}[${attr}]`))) {
      const url = el.getAttribute(attr) ?? '';
      if (isLocalMediaUrl(url)) el.setAttribute(attr, url.replace(/^mditor:\/\/[^/]*/i, origin));
    }
  }
}

/**
 * Export the rendered preview as a PDF via the main process: the app's
 * styles as they are, with fonts embedded. Local images aren't: the PDF
 * window loads them from the files, so a document full of photos isn't
 * copied around as one huge string. Returns the saved path, or null if
 * cancelled.
 */
export async function exportPreviewToPdf(
  host: HTMLElement,
  filePath: string | null,
): Promise<{ path: string } | null> {
  const content = clonePreview(host);
  const media = `mditor://pdf-${crypto.randomUUID()}`;
  moveLocalMedia(content, media);
  const math = content.querySelector('.katex') !== null;
  const [css] = await Promise.all([
    embedCssAssets(preferWoff2Sources(collectStyles((rule) => printRule(rule, math)))),
    lightDiagrams(host, content),
  ]);
  // Its links become the PDF's, followed from wherever it is read.
  dropNetworkReferences(content);
  const html = buildExportDocument({
    title: displayName(filePath),
    css: css + PRINT_OVERRIDES,
    body: content.innerHTML,
    policy: `img-src data: https: ${media}; media-src data: ${media}`,
  });
  return window.api.exportPdf({ html, suggestedName: exportFileName(filePath, 'pdf') });
}

/**
 * Save the rendered preview as a self-contained HTML file: the document's
 * styles in the light theme, KaTeX fonts (woff2 only, and only when there is
 * math) and local images embedded. Returns the saved path, or null if
 * cancelled.
 */
export async function exportPreviewToHtml(
  host: HTMLElement,
  filePath: string | null,
): Promise<{ path: string } | null> {
  const content = clonePreview(host);
  // Read-only in the export: there's no source to write a click back to.
  for (const box of Array.from(content.querySelectorAll('input.task-list-item-checkbox'))) {
    box.setAttribute('disabled', '');
  }
  const math = content.querySelector('.katex') !== null;
  const [css] = await Promise.all([
    embedCssAssets(preferWoff2Sources(collectStyles((rule) => standaloneRule(rule, math)))),
    embedLocalMedia(content),
    lightDiagrams(host, content),
  ]);
  dropNetworkReferences(content);
  const html = buildExportDocument({
    title: documentName(filePath),
    css: css + STANDALONE_OVERRIDES,
    body: content.innerHTML,
  });
  return window.api.exportHtml({ html, suggestedName: exportFileName(filePath, 'html') });
}
