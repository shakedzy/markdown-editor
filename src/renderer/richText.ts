// Copy as Rich Text: the rendered preview, or the part of it that's selected,
// as clean semantic HTML for pasting into mail, docs and chat apps, with the
// markdown source (or the selected text) as the plain-text flavor. Those
// targets drop <style> blocks and classes and can't run KaTeX or mermaid, so
// the formatting that matters is inlined, math becomes its TeX source and
// diagrams become images.

import {
  appStyleSheets,
  cleanExportContent,
  clonePreview,
  cloneRangeContents,
  dropNetworkReferences,
  embedLocalMedia,
} from './export';
import { RICH_TEXT_STYLES, SYNTAX_PROPERTIES, viewBoxSize } from './exportHtml';

// Clipboard HTML carries no encoding of its own; without this, some targets
// read it as Latin-1 and mangle anything beyond ASCII.
const CLIPBOARD_PREFIX = '<meta charset="utf-8">';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

// What a part of a table or list needs around it to still be one.
const STRUCTURE: Partial<Record<string, readonly string[]>> = {
  TABLE: ['THEAD', 'TBODY', 'TFOOT', 'TR'],
  THEAD: ['TR'],
  TBODY: ['TR'],
  TFOOT: ['TR'],
  UL: ['LI'],
  OL: ['LI'],
  DL: ['DT', 'DD'],
};

// Removed from copied elements: targets ignore them, and ids and classes
// only mean something next to the app's stylesheet.
const DROPPED_ATTRIBUTE = /^(?:class|id|role|data-.*|aria-.*)$/i;

// Largest side of a diagram bitmap, in pixels (canvas size limits).
const MAX_BITMAP_SIDE = 8192;

function previewSelection(host: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return host.contains(range.commonAncestorContainer) ? range : null;
}

function atomAt(node: Node, host: HTMLElement): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  const atom =
    el?.closest('.katex-display') ?? el?.closest('.katex') ?? el?.closest('.mermaid-rendered');
  return atom && host.contains(atom) ? atom : null;
}

// Part of a formula or diagram means nothing on its own, so a selection that
// starts or ends inside one takes all of it.
function expandToAtoms(range: Range, host: HTMLElement): Range {
  const expanded = range.cloneRange();
  const start = atomAt(range.startContainer, host);
  if (start) expanded.setStartBefore(start);
  const end = atomAt(range.endContainer, host);
  if (end) expanded.setEndAfter(end);
  return expanded;
}

// The selected content with the ancestors that give it meaning: inline
// formatting (a bold word stays bold), the code block around code, and the
// list, table or quote a selection spans several items, cells or paragraphs
// of. A selection inside one paragraph, item or cell isn't wrapped in it, so
// it pastes inline, as the browser's own copy does. Above the first block
// wrapped, only the table or list it belongs to is added (code in a list item
// pastes without a bullet). A selection inside the front matter stops at its
// table or code block, since the block itself is left out of copies. Media the
// preview hides is left out, as from a copy of the whole document.
function cloneSelection(range: Range, host: HTMLElement): HTMLElement {
  let content: Node = cloneRangeContents(range, host);
  const top = content instanceof DocumentFragment ? Array.from(content.childNodes) : [content];
  const spansBlocks = top.some((n) => n instanceof Element && BLOCK_TAGS.has(n.tagName));
  let block: string | null = null;
  const common = range.commonAncestorContainer;
  for (
    let el = common instanceof Element ? common : common.parentElement;
    el && el !== host && !el.classList.contains('frontmatter');
    el = el.parentElement
  ) {
    if (block !== null) {
      if (!STRUCTURE[el.tagName]?.includes(block)) break;
    } else if (BLOCK_TAGS.has(el.tagName) && el.tagName !== 'PRE' && !spansBlocks) {
      continue;
    }
    const shell = el.cloneNode(false);
    shell.appendChild(content);
    content = shell;
    if (BLOCK_TAGS.has(el.tagName)) block = el.tagName;
  }
  const root = document.createElement('div');
  root.appendChild(content);
  cleanExportContent(root);
  return root;
}

// KaTeX keeps the TeX source in a MathML <annotation>. The preview's
// sanitizer drops that element but keeps its text, which is then the only
// text directly inside <math> (the formula's own text sits in <mi>, <mo>…).
function texSource(math: Element): string | null {
  const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
  const mathml = math.querySelector('math');
  const tex = annotation
    ? annotation.textContent
    : mathml &&
      Array.from(mathml.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('');
  return tex?.trim() || null;
}

// KaTeX output needs KaTeX's fonts and CSS; its TeX source reads fine anywhere.
function mathToTex(root: HTMLElement): void {
  // Display math first: the .katex inside goes with it.
  for (const display of Array.from(root.querySelectorAll('.katex-display'))) {
    const tex = texSource(display);
    if (tex === null) continue;
    const pre = document.createElement('pre');
    pre.appendChild(document.createElement('code')).textContent = tex;
    display.replaceWith(pre);
  }
  for (const math of Array.from(root.querySelectorAll('.katex'))) {
    const tex = texSource(math);
    if (tex === null) continue;
    const code = document.createElement('code');
    code.textContent = tex;
    math.replaceWith(code);
  }
}

function checkboxesToText(root: HTMLElement): void {
  for (const box of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    // A task's box stands in for its bullet, as in the preview.
    if (box.classList.contains('task-list-item-checkbox')) {
      box.closest('li')?.style.setProperty('list-style-type', 'none');
    }
    box.replaceWith(box.checked ? '☑' : '☐');
  }
}

async function svgToPng(
  svg: SVGSVGElement,
  background: string,
): Promise<{ src: string; width: number; height: number } | null> {
  const size = viewBoxSize(svg.getAttribute('viewBox'));
  if (!size) return null;
  // Mermaid sizes the SVG to its container (width="100%"); as an image it
  // needs its own size.
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('width', String(size.width));
  copy.setAttribute('height', String(size.height));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    new XMLSerializer().serializeToString(copy),
  )}`;
  await image.decode();

  const scale = Math.min(2, MAX_BITMAP_SIDE / Math.max(size.width, size.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Throws if the drawing tainted the canvas.
  return { src: canvas.toDataURL('image/png'), ...size };
}

// Diagrams are pasted as PNGs drawn on the background they're shown on in the
// preview, which suits the theme mermaid drew them in. Where that fails the
// SVG stays, for targets that take it.
async function diagramsToImages(root: HTMLElement, host: HTMLElement): Promise<void> {
  const svgs = Array.from(root.querySelectorAll<SVGSVGElement>('.mermaid-rendered > svg'));
  if (svgs.length === 0) return;
  const shown = host.querySelector('.mermaid-rendered');
  const color = shown ? getComputedStyle(shown).backgroundColor : '';
  const background = color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)' ? color : '#ffffff';
  await Promise.all(
    svgs.map(async (svg) => {
      const png = await svgToPng(svg, background).catch(() => null);
      if (!png) return;
      const img = document.createElement('img');
      img.src = png.src;
      img.width = Math.round(png.width);
      img.height = Math.round(png.height);
      img.alt = 'Diagram';
      svg.replaceWith(img);
    }),
  );
}

// Copy the light theme's token colors onto highlighted code. Matching the
// rules against the detached copy picks the light variants whatever the
// app's theme: the dark ones hang off `:root.dark`, which nothing detached is
// under.
function inlineSyntaxColors(root: HTMLElement): void {
  if (!root.querySelector('[class*="hljs"]')) return;
  for (const { rules } of appStyleSheets()) {
    for (const rule of rules) {
      if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes('hljs')) continue;
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(rule.selectorText))) {
        for (const prop of SYNTAX_PROPERTIES) {
          const value = rule.style.getPropertyValue(prop);
          if (value) el.style.setProperty(prop, value);
        }
      }
    }
  }
}

function inlineStyles(root: HTMLElement): void {
  for (const [selector, style] of RICH_TEXT_STYLES) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      el.style.cssText += style;
    }
  }
}

// The text of copied content as the browser lays it out (line breaks between
// blocks, tabs between cells), like its own copy does, but with math as TeX
// and checkboxes as ☐/☑, as in the HTML. innerText needs the content rendered,
// so it's attached off-screen for the moment.
function laidOutText(root: HTMLElement): string {
  root.style.cssText = 'position: fixed; top: 0; left: -100000px; width: 800px;';
  document.body.appendChild(root);
  try {
    return root.innerText;
  } finally {
    root.remove();
    root.removeAttribute('style');
  }
}

function stripAttributes(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('*'))) {
    // An SVG left in place still needs the ids and classes its own <style> targets.
    if (!(el instanceof HTMLElement) || el.closest('svg')) continue;
    for (const { name } of Array.from(el.attributes)) {
      if (DROPPED_ATTRIBUTE.test(name)) el.removeAttribute(name);
    }
  }
}

/**
 * Put the preview on the clipboard as rich text: the selection when there is
 * one inside the preview, otherwise the whole document (with `markdown`, the
 * source, as its plain text). Resolves false when there is nothing to copy.
 */
export async function copyPreviewAsRichText(host: HTMLElement, markdown: string): Promise<boolean> {
  const range = previewSelection(host);
  const root = range ? cloneSelection(expandToAtoms(range, host), host) : clonePreview(host);
  if (!root.textContent?.trim() && !root.querySelector('img, svg, video, audio, hr')) return false;

  mathToTex(root);
  checkboxesToText(root);
  const text = range ? laidOutText(root) : markdown;
  for (const icon of Array.from(root.querySelectorAll('.markdown-alert-title svg'))) icon.remove();
  await Promise.all([diagramsToImages(root, host), embedLocalMedia(root)]);
  dropNetworkReferences(root);
  inlineSyntaxColors(root);
  inlineStyles(root);
  stripAttributes(root);

  await window.api.writeClipboard({ html: CLIPBOARD_PREFIX + root.innerHTML, text });
  return true;
}
