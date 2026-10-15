import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, closeAll, fixture, openFile, menu, posOf, selection, waitFor } from '../harness.mjs';

after(closeAll);

const WORDS =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november ' +
  'oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';
const DOC = `# Title

Intro paragraph with many words ${WORDS} and **bold marker** text continuing on.

Some *Columns* here; \`shell_blocks\` uses fenced \` \`\`\`bash \` blocks. *Rows* are sandbox; the \`fallback-*\` rows and \`resolver-*\` rows.
`;

/** Viewport coordinates of the middle of `word` in the preview. */
const previewWordCoords = (page, word) =>
  page.evaluate((w) => {
    const host = document.querySelector('.preview');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(w);
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.setStart(n, i + Math.floor(w.length / 2));
      r.setEnd(n, i + Math.floor(w.length / 2) + 1);
      const rect = r.getBoundingClientRect();
      return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) };
    }
    throw new Error(`not in preview: ${w}`);
  }, word);

test('code span with a backtick run inside keeps later emphasis intact', async () => {
  const dir = fixture({ 'a.md': DOC });
  await withApp({}, async ({ app, win }) => {
    const page = await openFile(app, win, `${dir}/a.md`);
    const ems = await waitFor(() =>
      page.evaluate(() => [...document.querySelectorAll('.preview p em')].map((e) => e.textContent)),
    );
    assert.deepEqual(ems, ['Columns', 'Rows']);
    const codes = await page.evaluate(() => [...document.querySelectorAll('.preview p code')].map((e) => e.textContent));
    assert.deepEqual(codes, ['shell_blocks', '```bash', 'fallback-*', 'resolver-*']);
  });
});

test('Take me there: preview to the exact spot in the editor', async () => {
  const dir = fixture({ 'a.md': DOC });
  await withApp({}, async ({ app, win }) => {
    const page = await openFile(app, win, `${dir}/a.md`);
    await waitFor(() => page.evaluate(() => document.querySelector('.preview')?.textContent.includes('quebec')));
    const coords = await previewWordCoords(page, 'quebec');
    await menu(app, page, 'takeMeThere', coords);
    const start = await posOf(page, 'quebec');
    await waitFor(async () => {
      const s = await selection(page);
      return s.anchor === s.head && s.anchor > start && s.anchor < start + 'quebec'.length;
    }, { message: 'caret inside "quebec"' });
    const flashed = await page.evaluate(() => document.querySelector('.cm-flash')?.textContent);
    assert.equal(flashed, 'quebec');
  });
});

test('Take me there: editor to the exact word in the preview', async () => {
  const dir = fixture({ 'a.md': DOC });
  await withApp({}, async ({ app, win }) => {
    const page = await openFile(app, win, `${dir}/a.md`);
    const pos = (await posOf(page, 'romeo')) + 2;
    const coords = await page.evaluate((p) => {
      const v = document.querySelector('.cm-content').cmTile.view;
      const c = v.coordsAtPos(p);
      return { x: Math.round(c.left + 1), y: Math.round((c.top + c.bottom) / 2) };
    }, pos);
    await menu(app, page, 'takeMeThere', coords);
    const hit = await waitFor(() =>
      page.evaluate(() => {
        const h = CSS.highlights.get('preview-target');
        return h ? [...h][0].toString() : null;
      }),
    );
    assert.equal(hit, 'romeo');
  });
});

test('preview text size: buttons and menu commands', async () => {
  const dir = fixture({ 'a.md': DOC });
  await withApp({}, async ({ app, win }) => {
    const page = await openFile(app, win, `${dir}/a.md`);
    const size = () => page.evaluate(() => document.querySelector('.preview').style.fontSize);
    assert.equal(await size(), '');
    await page.click('.preview-font-bigger');
    await waitFor(async () => (await size()) === '110%', { message: '110%' });
    await menu(app, page, 'previewFontBigger');
    await waitFor(async () => (await size()) === '125%', { message: '125%' });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mditor.settings')).previewFontScale);
    assert.equal(stored, 1.25);
    // The editor keeps its size.
    const editorSize = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize);
    await menu(app, page, 'previewFontSmaller');
    await menu(app, page, 'previewFontSmaller');
    await menu(app, page, 'previewFontSmaller');
    await waitFor(async () => (await size()) === '90%', { message: '90%' });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize),
      editorSize,
    );
    await page.click('.preview-font-size');
    await waitFor(async () => (await size()) === '', { message: 'reset' });
  });
});
