import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { renderMarkdown } from '../markdown/render';
import { MIN_MATCH_LEN, normalizeForMatch } from '../markdown/locate';
import { SourceAnchor, increasingAnchors } from '../scrollSync';
import { stripUserContent } from '../links';
import {
  MermaidTheme,
  appMermaidTheme,
  diagramElement,
  loadMermaid,
  renderMermaid,
} from '../mermaid';
import { useLatest } from '../useLatest';

interface Props {
  source: string;
  ghMode: boolean;
  basePath: string | null;
  /**
   * A task checkbox was clicked: `index` of `total` task checkboxes, and the
   * state it should now have. Return false to reject the click.
   */
  onToggleTask?: (index: number, total: number, checked: boolean) => boolean;
  /**
   * Blocks may have moved: the preview re-rendered, a diagram or image
   * finished, or a <details> opened or closed.
   */
  onLayoutChange?: () => void;
  /** A link was clicked; gets its href. Links never navigate the page (it is the whole app). */
  onFollowLink?: (href: string) => void;
}

export interface PreviewHandle {
  scrollToSlug(slug: string): void;
  /**
   * Scroll the `index`-th heading into view. With `forSource`, the heading
   * of that document: if the preview hasn't rendered it yet (it just
   * replaced another), the scroll waits until it has.
   */
  scrollToHeading(index: number, forSource?: string): void;
  /**
   * Scroll to the element a link's #fragment names (a heading, a footnote, an
   * HTML id or <a name>; '' is the top); false if there is none.
   */
  scrollToAnchor(fragment: string): boolean;
  headingIndexAtCoords(x: number, y: number): number;
  textAtCoords(x: number, y: number): string;
  revealText(opts: { snippet: string; headingIndex: number }): void;
  openSearch(): void;
  element(): HTMLDivElement | null;
  /**
   * The rendered blocks' source lines and offsets in the scrolled content,
   * strictly increasing in both; measured once per layout.
   */
  sourceAnchors(): readonly SourceAnchor[];
}

// Custom-highlight registry keys. The preview is read-only rendered HTML, so
// search highlights text ranges via the CSS Custom Highlight API rather than
// mutating the DOM (which would fight the markdown re-render and mermaid).
const HL_ALL = 'preview-search';
const HL_ACTIVE = 'preview-search-active';

const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { source, ghMode, basePath, onToggleTask, onLayoutChange, onFollowLink },
  ref,
) {
  const [debounced, setDebounced] = useState(source);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const renderEpochRef = useRef(0);

  const onLayoutChangeRef = useLatest(onLayoutChange);
  // Bumped whenever blocks may have moved, which makes the scroll-sync anchors
  // measured before stale.
  const layoutRef = useRef(0);
  const anchorsRef = useRef<{ key: string; anchors: readonly SourceAnchor[] } | null>(null);
  const layoutChanged = useCallback(() => {
    layoutRef.current++;
    onLayoutChangeRef.current?.();
  }, []);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(source), 80);
    return () => window.clearTimeout(handle);
  }, [source]);

  const html = useMemo(
    () => renderMarkdown(debounced, { ghMode, basePath }),
    [debounced, ghMode, basePath],
  );

  const clearHighlights = useCallback(() => {
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_ACTIVE);
    rangesRef.current = [];
  }, []);

  const scrollRangeIntoView = useCallback((range: Range) => {
    const host = hostRef.current;
    if (!host) return;
    openDetailsAround(range.startContainer, host);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const hostRect = host.getBoundingClientRect();
    const offset = rect.top - hostRect.top + host.scrollTop;
    const target = offset - host.clientHeight / 2 + rect.height / 2;
    host.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, []);

  // Recompute matches whenever the query, the rendered content, or the open
  // state changes. Runs on `html` too so results track edits made in split view.
  useEffect(() => {
    clearHighlights();
    const host = hostRef.current;
    const needle = query.toLowerCase();
    if (!searchOpen || !host || needle.length === 0) {
      setMatchCount(0);
      setActiveIndex(0);
      activeIndexRef.current = 0;
      return;
    }

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue ?? '';
      if (text) {
        const hay = text.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + needle.length);
          ranges.push(range);
          idx = hay.indexOf(needle, idx + needle.length);
        }
      }
      node = walker.nextNode();
    }

    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    setActiveIndex(0);
    activeIndexRef.current = 0;
    if (ranges.length > 0) {
      CSS.highlights.set(HL_ALL, new Highlight(...ranges));
      CSS.highlights.set(HL_ACTIVE, new Highlight(ranges[0]!));
      scrollRangeIntoView(ranges[0]!);
    }
  }, [query, html, searchOpen, clearHighlights, scrollRangeIntoView]);

  // Clear highlights when the component unmounts.
  useEffect(() => clearHighlights, [clearHighlights]);

  const go = useCallback(
    (delta: number) => {
      const ranges = rangesRef.current;
      const n = ranges.length;
      if (n === 0) return;
      const next = (activeIndexRef.current + delta + n) % n;
      activeIndexRef.current = next;
      setActiveIndex(next);
      CSS.highlights.set(HL_ACTIVE, new Highlight(ranges[next]!));
      scrollRangeIntoView(ranges[next]!);
    },
    [scrollRangeIntoView],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  // Clicking a task checkbox writes the change back to the source; the
  // re-render then reflects it. The browser has already flipped the box by the
  // time this runs, so `checked` is the new state. If the click can't be
  // applied, preventDefault() reverts the box.
  const onHostClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const box = e.target;
      if (
        !(box instanceof HTMLInputElement) ||
        !box.classList.contains('task-list-item-checkbox')
      ) {
        // Links (SVG ones and image-map areas included) are followed by the app
        // instead of navigating the page. One whose href the sanitizer dropped
        // does nothing.
        const link = box instanceof Element ? box.closest('a, area') : null;
        const href = link?.getAttribute('href') ?? link?.getAttributeNS(XLINK_NS, 'href');
        if (href != null) {
          e.preventDefault();
          onFollowLink?.(href);
        }
        return;
      }
      const host = hostRef.current;
      const boxes = host
        ? Array.from(host.querySelectorAll('input.task-list-item-checkbox'))
        : [];
      const index = boxes.indexOf(box);
      // The preview trails the source by the render debounce; ignore clicks
      // until it catches up so indices refer to the same document.
      const applied =
        debounced === source &&
        index >= 0 &&
        (onToggleTask?.(index, boxes.length, box.checked) ?? false);
      if (!applied) e.preventDefault();
    },
    [debounced, source, onToggleTask, onFollowLink],
  );

  // A scroll meant for a document the preview hasn't rendered yet, and the
  // source last rendered, which a scroll's document is checked against.
  const pendingScrollRef = useRef<{ source: string; scroll: () => void } | null>(null);
  const renderedRef = useLatest(debounced);

  useImperativeHandle(ref, () => ({
    scrollToSlug(slug: string) {
      const host = hostRef.current;
      if (!host) return;
      const escaped = (window.CSS?.escape ?? ((s: string) => s))(slug);
      const el = host.querySelector<HTMLElement>(`#${escaped}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    scrollToHeading(index: number, forSource?: string) {
      const scroll = () => requestAnimationFrame(() => {
        const host = hostRef.current;
        if (!host) return;
        const headings = host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
        const target = headings[index];
        if (!target) return;
        const hostRect = host.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const offsetWithinHost = targetRect.top - hostRect.top + host.scrollTop;
        host.scrollTo({ top: Math.max(0, offsetWithinHost - 8), behavior: 'smooth' });

        target.classList.remove('heading-flash');
        void target.offsetHeight;
        target.classList.add('heading-flash');
        target.addEventListener(
          'animationend',
          () => target.classList.remove('heading-flash'),
          { once: true },
        );
      });
      if (forSource !== undefined && forSource !== renderedRef.current) {
        pendingScrollRef.current = { source: forSource, scroll };
        return;
      }
      pendingScrollRef.current = null;
      scroll();
    },
    scrollToAnchor(fragment: string) {
      const host = hostRef.current;
      if (!host) return false;
      if (fragment === '') {
        host.scrollTo({ top: 0, behavior: 'smooth' });
        return true;
      }
      const target = anchorTarget(host, fragment);
      if (!target) return false;
      const offset =
        target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      host.scrollTo({ top: Math.max(0, offset - 8), behavior: 'smooth' });
      const flash = /^H[1-6]$/.test(target.tagName) ? 'heading-flash' : 'text-flash';
      target.classList.remove(flash);
      void target.offsetHeight;
      target.classList.add(flash);
      target.addEventListener('animationend', () => target.classList.remove(flash), {
        once: true,
      });
      return true;
    },
    headingIndexAtCoords(_x: number, y: number) {
      const host = hostRef.current;
      if (!host) return 0;
      const headings = host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
      if (headings.length === 0) return 0;
      // The section the click falls in: the last heading whose top is at or
      // above the click point.
      let result = 0;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i]!.getBoundingClientRect().top <= y) result = i;
        else break;
      }
      return result;
    },
    textAtCoords(x: number, y: number) {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) return document.elementFromPoint(x, y)?.textContent ?? '';
      const node = range.startContainer;
      const text = node.textContent ?? '';
      // Inside a code block the whole block is one text node; narrow to the
      // single line the click landed on.
      if (node.nodeType === Node.TEXT_NODE && text.includes('\n')) {
        const off = range.startOffset;
        const start = text.lastIndexOf('\n', off - 1) + 1;
        let end = text.indexOf('\n', off);
        if (end < 0) end = text.length;
        return text.slice(start, end);
      }
      return text;
    },
    revealText({ snippet, headingIndex }) {
      requestAnimationFrame(() => {
        const host = hostRef.current;
        if (!host) return;
        const headings = host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
        const anchor = headings[headingIndex] ?? null;
        const target = normalizeForMatch(snippet);

        // Find the element whose text matches the clicked source line. Match on
        // element textContent (not text nodes): inline formatting like
        // **bold**/`code`/links splits a line across several text nodes, so no
        // single text node holds the whole line. Pick the innermost matching
        // element, preferring one at or after the section heading so earlier
        // duplicates don't win.
        let el: HTMLElement | null = null;
        if (target.length >= MIN_MATCH_LEN) {
          const matches = (node: Element): boolean =>
            normalizeForMatch(node.textContent ?? '').includes(target);
          let firstMatch: HTMLElement | null = null;
          for (const candidate of host.querySelectorAll<HTMLElement>('*')) {
            if (!matches(candidate)) continue;
            // Innermost: skip if a descendant element also contains the line.
            if (
              Array.from(candidate.children).some((child) => matches(child))
            ) {
              continue;
            }
            if (!firstMatch) firstMatch = candidate;
            const afterAnchor =
              !anchor ||
              (anchor.compareDocumentPosition(candidate) &
                Node.DOCUMENT_POSITION_FOLLOWING) !==
                0;
            if (afterAnchor) {
              el = candidate;
              break;
            }
          }
          if (!el) el = firstMatch;
        }
        if (!el) el = anchor;
        if (!el) return;

        const hostRect = host.getBoundingClientRect();
        const targetRect = el.getBoundingClientRect();
        const offsetWithinHost = targetRect.top - hostRect.top + host.scrollTop;
        host.scrollTo({ top: Math.max(0, offsetWithinHost - 8), behavior: 'smooth' });

        el.classList.remove('text-flash');
        void el.offsetHeight;
        el.classList.add('text-flash');
        el.addEventListener(
          'animationend',
          () => el?.classList.remove('text-flash'),
          { once: true },
        );
      });
    },
    openSearch() {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    element() {
      return hostRef.current;
    },
    sourceAnchors() {
      const host = hostRef.current;
      if (!host) return [];
      // Reflow (a resized pane, fonts arriving late) moves blocks too.
      const key = `${layoutRef.current}:${host.clientWidth}:${host.scrollHeight}`;
      if (anchorsRef.current?.key !== key) {
        anchorsRef.current = { key, anchors: measureAnchors(host) };
      }
      return anchorsRef.current.anchors;
    },
  }));

  // The front matter block comes back open on every re-render; remember that
  // the user collapsed it so typing doesn't keep expanding it.
  const frontMatterOpenRef = useRef(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onToggle = (e: Event) => {
      const el = e.target;
      if (el instanceof HTMLDetailsElement && el.classList.contains('frontmatter')) {
        frontMatterOpenRef.current = el.open;
      }
    };
    // `toggle` doesn't bubble.
    host.addEventListener('toggle', onToggle, true);
    return () => host.removeEventListener('toggle', onToggle, true);
  }, []);

  useLayoutEffect(() => {
    if (frontMatterOpenRef.current) return;
    hostRef.current?.querySelector('details.frontmatter')?.removeAttribute('open');
  }, [html]);

  useEffect(() => layoutChanged(), [html, layoutChanged]);

  // A waiting scroll runs once the preview has caught up with its source, if
  // that is the document it was meant for (not one typed since).
  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || debounced !== source) return;
    pendingScrollRef.current = null;
    if (pending.source === debounced) pending.scroll();
  }, [html, debounced, source]);

  // The natural sizes of the last render's images, by URL. A re-render gives
  // an image that has to load again (one dropped from the memory cache) its
  // size until it arrives, so the content below it doesn't collapse and then
  // jump back.
  const imageSizesRef = useRef(new Map<string, [number, number]>());
  // The attributes each image's stand-in added, to take off once it loads.
  const standInsRef = useRef(new WeakMap<HTMLImageElement, string[]>());

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const previous = imageSizesRef.current;
    const sizes = new Map<string, [number, number]>();
    imageSizesRef.current = sizes;
    for (const img of host.querySelectorAll('img')) {
      const size = previous.get(img.src);
      if (!size) continue;
      sizes.set(img.src, size);
      if (img.complete) continue;
      const [width, height] = size;
      const ownWidth = img.hasAttribute('width');
      const ownHeight = img.hasAttribute('height');
      if (!ownWidth && !ownHeight) {
        img.width = width;
        img.height = height;
        standInsRef.current.set(img, ['width', 'height']);
      } else if (ownWidth !== ownHeight && !img.hasAttribute('style')) {
        // The author's width or height alone gives no shape until the image
        // loads. (The preview's `height: auto` overrides a height, so then
        // the width is the image's own too.)
        img.style.aspectRatio = `${width} / ${height}`;
        if (ownWidth) {
          standInsRef.current.set(img, ['style']);
        } else {
          img.width = width;
          standInsRef.current.set(img, ['style', 'width']);
        }
      }
    }
  }, [html]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onImage = (e: Event) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      // Loaded (or failed), it lays out by its own size again.
      for (const name of standInsRef.current.get(img) ?? []) img.removeAttribute(name);
      standInsRef.current.delete(img);
      if (e.type === 'load' && img.naturalWidth > 0 && img.naturalHeight > 0) {
        imageSizesRef.current.set(img.src, [img.naturalWidth, img.naturalHeight]);
      }
      layoutChanged();
    };
    // None of these bubble.
    host.addEventListener('load', onImage, true);
    host.addEventListener('error', onImage, true);
    host.addEventListener('toggle', layoutChanged, true);
    return () => {
      host.removeEventListener('load', onImage, true);
      host.removeEventListener('error', onImage, true);
      host.removeEventListener('toggle', layoutChanged, true);
    };
  }, [layoutChanged]);

  // The last render's diagrams, by theme and source. A re-render puts them
  // back before the preview is laid out, so what's below a diagram doesn't
  // move while its code block waits to be drawn again.
  const drawingsRef = useRef(new Map<string, Drawing>());

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = appMermaidTheme();
    const previous = drawingsRef.current;
    const drawings = new Map<string, Drawing>();
    drawingsRef.current = drawings;
    const pending: { block: HTMLElement; code: string; key: string }[] = [];
    for (const block of host.querySelectorAll<HTMLElement>('pre code.language-mermaid')) {
      const code = block.textContent ?? '';
      const key = `${theme}\n${code}`;
      const drawing = previous.get(key);
      if (drawing) {
        drawings.set(key, drawing);
        replaceCodeBlock(block, drawingElement(drawing, code, theme));
      } else {
        pending.push({ block, code, key });
      }
    }
    if (pending.length === 0) return;

    const epoch = ++renderEpochRef.current;
    let cancelled = false;

    void (async () => {
      try {
        await loadMermaid();
      } catch (err) {
        console.error('Failed to load mermaid:', err);
        return;
      }
      for (const { block, code, key } of pending) {
        if (cancelled || epoch !== renderEpochRef.current) return;
        let drawing: Drawing;
        try {
          drawing = { svg: await renderMermaid(code, theme) };
        } catch (err) {
          drawing = { error: (err as Error).message ?? String(err) };
        }
        if (cancelled || epoch !== renderEpochRef.current) return;
        drawings.set(key, drawing);
        replaceCodeBlock(block, drawingElement(drawing, code, theme));
        layoutChanged();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html, layoutChanged]);

  const countLabel = query
    ? matchCount > 0
      ? `${activeIndex + 1}/${matchCount}`
      : '0/0'
    : '';

  return (
    <div className="preview-container">
      {searchOpen && (
        <div className="preview-search" role="search">
          <input
            ref={searchInputRef}
            type="text"
            className="preview-search-input"
            placeholder="Search preview"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                go(e.shiftKey ? -1 : 1);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <span className="preview-search-count">{countLabel}</span>
          <button
            type="button"
            className="preview-search-btn"
            onClick={() => go(-1)}
            disabled={matchCount === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            ‹
          </button>
          <button
            type="button"
            className="preview-search-btn"
            onClick={() => go(1)}
            disabled={matchCount === 0}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            ›
          </button>
          <button
            type="button"
            className="preview-search-btn"
            onClick={closeSearch}
            title="Close (Esc)"
            aria-label="Close search"
          >
            ✕
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className="preview"
        onClick={onHostClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * The element a link's #fragment names: by id (headings, footnotes) or, as
 * in older HTML, an <a name>. GitHub's "user-content-" prefix and other
 * letter cases are tried too.
 */
function anchorTarget(host: HTMLElement, fragment: string): HTMLElement | null {
  const named = host.querySelectorAll<HTMLElement>('[id], a[name]');
  const slug = stripUserContent(fragment);
  for (const wanted of [fragment, slug, slug.toLowerCase()]) {
    for (const el of named) {
      if (el.id === wanted || (el.tagName === 'A' && el.getAttribute('name') === wanted)) return el;
    }
  }
  return null;
}

// A diagram, or the error mermaid gave for its code.
type Drawing = { svg: string } | { error: string };

function drawingElement(drawing: Drawing, code: string, theme: MermaidTheme): HTMLElement {
  if ('svg' in drawing) return diagramElement(drawing.svg, code, theme);
  const errBox = document.createElement('div');
  errBox.className = 'mermaid-error';
  errBox.textContent = `Mermaid error: ${drawing.error}`;
  return errBox;
}

/**
 * Open the collapsed <details> (the front matter block, say) that hide `node`,
 * as the browser's find does, so a match there can be shown.
 */
function openDetailsAround(node: Node, host: HTMLElement): void {
  for (let el = node.parentElement; el && el !== host; el = el.parentElement) {
    if (
      el instanceof HTMLDetailsElement &&
      !el.open &&
      !el.querySelector(':scope > summary')?.contains(node)
    ) {
      el.open = true;
    }
  }
}

/** Swap a code block (given its <code>) for `el`, keeping the block's source line. */
function replaceCodeBlock(code: HTMLElement, el: HTMLElement): void {
  const pre = code.closest('pre');
  if (!pre) return;
  if (pre.dataset.line) el.dataset.line = pre.dataset.line;
  pre.replaceWith(el);
}

/** Each block tagged with its source line, and where it sits in `host`'s scrolled content. */
function measureAnchors(host: HTMLElement): SourceAnchor[] {
  const origin = host.getBoundingClientRect().top + host.clientTop - host.scrollTop;
  const anchors: SourceAnchor[] = [];
  for (const el of host.querySelectorAll<HTMLElement>('[data-line]')) {
    // Blocks inside a closed <details> have no box.
    const box = el.getClientRects()[0];
    if (box) anchors.push({ line: Number(el.dataset.line), top: box.top - origin });
  }
  return increasingAnchors(anchors);
}

export default Preview;
