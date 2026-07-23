// Builds a self-contained HTML document from the live preview and hands it to
// the main process to render as a PDF. Capturing the already-rendered preview
// DOM means mermaid diagrams, KaTeX math, and syntax highlighting come along for
// free — the PDF matches what's on screen.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Concatenate every same-origin stylesheet the app has loaded (app.css,
// preview.css, hljs-theme.css, katex.min.css). Cross-origin sheets throw on
// `cssRules` access and are skipped.
function collectStyles(): string {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) css += rule.cssText + '\n';
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

function suggestedName(filePath: string | null): string {
  const base = filePath ? (filePath.split(/[\\/]/).pop() ?? 'Untitled') : 'Untitled';
  return base.replace(/\.(md|markdown|mdown|mkd)$/i, '') + '.pdf';
}

/**
 * Assemble the export document from the rendered preview markup and export it as
 * a PDF via the main process. Returns the saved path, or null if cancelled.
 */
export function exportPreviewToPdf(
  previewHtml: string,
  filePath: string | null,
): Promise<{ path: string } | null> {
  const title = filePath ? (filePath.split(/[\\/]/).pop() ?? 'Untitled') : 'Untitled';
  const doc = `<!doctype html>
<html class="light" lang="en">
<head>
<meta charset="utf-8" />
<base href="${escapeHtml(document.baseURI)}" />
<title>${escapeHtml(title)}</title>
<style>
${collectStyles()}
${PRINT_OVERRIDES}
</style>
</head>
<body>
<div class="preview">${previewHtml}</div>
</body>
</html>`;

  return window.api.exportPdf({ html: doc, suggestedName: suggestedName(filePath) });
}
