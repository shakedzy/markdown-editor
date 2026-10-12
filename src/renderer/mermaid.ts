// Mermaid diagrams, for the preview and the exports. Mermaid is loaded on
// first use, and its theme is set for all of it at once, so renders run one at
// a time, each in the theme it asks for: the app's in the preview, light in
// the exports.

type Mermaid = typeof import('mermaid').default;

export type MermaidTheme = 'default' | 'dark';

let mermaidPromise: Promise<Mermaid> | null = null;
let initializedTheme: MermaidTheme | null = null;
let queue: Promise<unknown> = Promise.resolve();
// Mermaid removes any element that has the id it renders under, which could
// be a diagram still in the preview, so ids are never reused.
let lastId = 0;

export function loadMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((mod) => mod.default);
  return mermaidPromise;
}

/** The theme diagrams are drawn in to match the app's. */
export function appMermaidTheme(): MermaidTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

/** `code` drawn as SVG markup in `theme`; rejects with mermaid's error. */
export function renderMermaid(code: string, theme: MermaidTheme): Promise<string> {
  const run = queue.then(async () => {
    const M = await loadMermaid();
    if (initializedTheme !== theme) {
      M.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
      initializedTheme = theme;
    }
    const { svg } = await M.render(`mermaid-${++lastId}`, code);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

// What each diagram element in the preview was drawn from.
const drawings = new WeakMap<Element, { code: string; theme: MermaidTheme }>();

/** The preview's element for a diagram drawn from `code` in `theme`. */
export function diagramElement(svg: string, code: string, theme: MermaidTheme): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'mermaid-rendered';
  wrapper.innerHTML = svg;
  drawings.set(wrapper, { code, theme });
  return wrapper;
}

/** The source and theme of a diagram element made by diagramElement. */
export function diagramDrawing(el: Element): { code: string; theme: MermaidTheme } | undefined {
  return drawings.get(el);
}
