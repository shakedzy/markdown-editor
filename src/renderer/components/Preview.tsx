import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { renderMarkdown } from '../markdown/render';
import { MIN_MATCH_LEN, normalizeForMatch } from '../markdown/locate';

interface Props {
  source: string;
  ghMode: boolean;
  basePath: string | null;
}

export interface PreviewHandle {
  scrollToSlug(slug: string): void;
  scrollToHeading(index: number): void;
  headingIndexAtCoords(x: number, y: number): number;
  textAtCoords(x: number, y: number): string;
  revealText(opts: { snippet: string; headingIndex: number }): void;
  openSearch(): void;
  element(): HTMLDivElement | null;
}

type Mermaid = typeof import('mermaid').default;
let mermaidPromise: Promise<Mermaid> | null = null;

// Custom-highlight registry keys. The preview is read-only rendered HTML, so
// search highlights text ranges via the CSS Custom Highlight API rather than
// mutating the DOM (which would fight the markdown re-render and mermaid).
const HL_ALL = 'preview-search';
const HL_ACTIVE = 'preview-search-active';

function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const M = mod.default;
      const isDark = document.documentElement.classList.contains('dark');
      M.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
      });
      return M;
    });
  }
  return mermaidPromise;
}

const Preview = forwardRef<PreviewHandle, Props>(function Preview(
  { source, ghMode, basePath },
  ref,
) {
  const [debounced, setDebounced] = useState(source);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const renderEpochRef = useRef(0);

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

  useImperativeHandle(ref, () => ({
    scrollToSlug(slug: string) {
      const host = hostRef.current;
      if (!host) return;
      const escaped = (window.CSS?.escape ?? ((s: string) => s))(slug);
      const el = host.querySelector<HTMLElement>(`#${escaped}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    scrollToHeading(index: number) {
      requestAnimationFrame(() => {
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
  }));

  useEffect(() => {
    if (!hostRef.current) return;
    const blocks = Array.from(
      hostRef.current.querySelectorAll<HTMLElement>('pre code.language-mermaid'),
    );
    if (blocks.length === 0) return;

    const epoch = ++renderEpochRef.current;
    let cancelled = false;

    void (async () => {
      let M: Mermaid;
      try {
        M = await getMermaid();
      } catch (err) {
        console.error('Failed to load mermaid:', err);
        return;
      }
      for (let i = 0; i < blocks.length; i++) {
        if (cancelled || epoch !== renderEpochRef.current) return;
        const block = blocks[i]!;
        const code = block.textContent ?? '';
        const id = `mermaid-${epoch}-${i}`;
        try {
          const { svg } = await M.render(id, code);
          if (cancelled || epoch !== renderEpochRef.current) return;
          const wrapper = document.createElement('div');
          wrapper.className = 'mermaid-rendered';
          wrapper.innerHTML = svg;
          block.closest('pre')?.replaceWith(wrapper);
        } catch (err) {
          if (cancelled || epoch !== renderEpochRef.current) return;
          const errBox = document.createElement('div');
          errBox.className = 'mermaid-error';
          errBox.textContent = `Mermaid error: ${(err as Error).message ?? String(err)}`;
          block.closest('pre')?.replaceWith(errBox);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [html]);

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
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
});

export default Preview;
