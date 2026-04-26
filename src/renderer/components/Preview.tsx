import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { renderMarkdown } from '../markdown/render';

interface Props {
  source: string;
  ghMode: boolean;
  basePath: string | null;
}

export interface PreviewHandle {
  scrollToSlug(slug: string): void;
  scrollToHeading(index: number): void;
  currentHeadingIndex(): number;
  element(): HTMLDivElement | null;
}

type Mermaid = typeof import('mermaid').default;
let mermaidPromise: Promise<Mermaid> | null = null;

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

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(source), 80);
    return () => window.clearTimeout(handle);
  }, [source]);

  const html = useMemo(
    () => renderMarkdown(debounced, { ghMode, basePath }),
    [debounced, ghMode, basePath],
  );

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
    currentHeadingIndex() {
      const host = hostRef.current;
      if (!host) return 0;
      const headings = host.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
      if (headings.length === 0) return 0;
      const hostTop = host.getBoundingClientRect().top;
      let result = 0;
      for (let i = 0; i < headings.length; i++) {
        const r = headings[i]!.getBoundingClientRect();
        if (r.top <= hostTop + 24) result = i;
        else break;
      }
      return result;
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

  return (
    <div
      ref={hostRef}
      className="preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default Preview;
