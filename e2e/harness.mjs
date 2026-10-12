// Shared helpers for driving MDitor end-to-end with Playwright's Electron support.
//
// Every launch gets its own --user-data-dir (settings, recent.json, recovery/), so
// apps never share state with each other or with your real MDitor profile, and
// main-stub.cjs fakes native dialogs / shell / clipboard / recent documents.
// The renderer is served by the Vite dev server on :5173 (run.mjs starts it).
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const E2E = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.dirname(E2E);
/** Path of the Electron binary (the `electron` package exports it). */
export const ELECTRON = createRequire(import.meta.url)('electron');
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
export const OUTPUT = path.join(E2E, '.output');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- temp dirs

// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and the
// app reports real paths.
const TMP_ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mditor-e2e-'));

/** A fresh empty directory, removed when the test process exits (unless E2E_KEEP=1). */
export function tmpDir(prefix = 'tmp') {
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}

/** Write `files` ({ 'rel/path.md': string | Buffer }) under a new temp dir; returns the dir. */
export function fixture(files, prefix = 'fx') {
  const dir = tmpDir(prefix);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// ---------------------------------------------------------------- app lifecycle

const live = new Set();

function killTree(proc) {
  try {
    proc.kill('SIGKILL');
  } catch {}
}

process.on('exit', () => {
  for (const app of live) {
    try {
      killTree(app.process());
    } catch {}
  }
  if (!process.env.E2E_KEEP) fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

/** `p`, or a rejection after `ms` (the timer never keeps the process alive). */
export function withTimeout(p, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Launch MDitor (compiled main from dist-main + the renderer from the Vite server).
 *
 * opts.userDataDir  reuse a profile (crash recovery, recent files across launches)
 * opts.config       pre-seed the main-process stub state before app code runs (needed
 *                   for dialogs shown at startup, e.g. { messageBox: [0] } or { fsRules: [...] })
 * opts.settings     merged into the renderer's localStorage settings, then the page reloads once
 * opts.env          extra environment variables
 *
 * Returns { app, win, userDataDir }. Always pair with close(app) (or use withApp).
 */
export async function launch(opts = {}) {
  const userDataDir = opts.userDataDir ?? tmpDir('profile');
  for (let attempt = 1; ; attempt++) {
    let app;
    try {
      const env = { ...process.env, ...opts.env };
      delete env.ELECTRON_RUN_AS_NODE;
      if (opts.config) {
        const cfg = path.join(tmpDir('cfg'), 'config.json');
        fs.writeFileSync(cfg, JSON.stringify(opts.config));
        env.E2E_CONFIG = cfg;
      }
      const launching = _electron.launch({
        executablePath: ELECTRON,
        args: [
          '--require',
          path.join(E2E, 'main-stub.cjs'),
          path.join(REPO, 'dist-main', 'main', 'main.js'),
          `--user-data-dir=${userDataDir}`,
        ],
        cwd: REPO,
        env,
        timeout: 30_000,
      });
      app = await withTimeout(launching, 40_000, 'electron launch');
      live.add(app);
      app.process().once('exit', () => live.delete(app));
      const win = await withTimeout(app.firstWindow(), 30_000, 'first window');
      await win.waitForSelector('.cm-editor', { timeout: 30_000 });
      if (opts.settings) {
        await win.evaluate((s) => {
          const cur = JSON.parse(localStorage.getItem('mditor.settings') || '{}');
          localStorage.setItem('mditor.settings', JSON.stringify({ ...cur, ...s }));
        }, opts.settings);
        await win.reload();
        await win.waitForSelector('.cm-editor', { timeout: 30_000 });
      }
      return { app, win, userDataDir };
    } catch (err) {
      // A launch that never shows a window is killed and retried once.
      if (app) await close(app);
      if (attempt >= 2) throw err;
    }
  }
}

/**
 * Close the app: answer any remaining prompt with "Don't Save", quit, and SIGKILL the
 * process if it does not exit in time. Safe to call twice or on an exited app.
 */
export async function close(app) {
  if (!app) return;
  let proc;
  try {
    proc = app.process();
  } catch {
    return;
  }
  const exited = () => proc.exitCode !== null || proc.signalCode !== null;
  if (!exited()) {
    try {
      await withTimeout(
        app.evaluate(() => Object.assign(globalThis.__e2e, { messageBox: [], messageBoxDefault: 1, messageBoxDelayMs: 0 })),
        2_000,
        'reset prompts',
      );
    } catch {}
    try {
      await withTimeout(app.close(), 8_000, 'app.close');
    } catch {
      killTree(proc);
    }
  }
  if (!exited()) await withTimeout(new Promise((r) => proc.once('exit', r)), 5_000, 'exit').catch(() => killTree(proc));
  live.delete(app);
}

/** Close every app this process launched (use in an after() hook as a safety net). */
export async function closeAll() {
  await Promise.all([...live].map((app) => close(app)));
}

/** Launch, run fn({ app, win, userDataDir }), and always close the app. */
export async function withApp(opts, fn) {
  const ctx = await launch(opts);
  try {
    return await fn(ctx);
  } finally {
    await close(ctx.app);
  }
}

/** A promise that resolves when the app's process exits. */
export const exitOf = (app) => {
  const p = app.process();
  return new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once('exit', () => r())));
};

// ---------------------------------------------------------------- main-process stub

/** Merge into the main-process stub state, e.g. { open: '/path/a.md', messageBox: [1] }. */
export const stub = (app, patch) => app.evaluate((_e, p) => Object.assign(globalThis.__e2e, p), patch);

/** Recorded dialog / shell / clipboard / recent-document calls (optionally clearing them). */
export const calls = (app, clear = false) =>
  app.evaluate((_e, c) => {
    const out = globalThis.__e2e.calls.slice();
    if (c) globalThis.__e2e.calls.length = 0;
    return out;
  }, clear);

/** Message-box prompts recorded since the last clear (messages only). */
export const prompts = async (app, clear = false) =>
  (await calls(app, clear)).filter((c) => c.type === 'messageBox' || c.type === 'messageBoxSync').map((c) => c.message);

/** Replace the fs fault-injection rules (see main-stub.cjs). */
export const setFsRules = (app, rules) => app.evaluate((_e, r) => void (globalThis.__e2e.fsRules = r), rules);

/** Main-process fs.promises writeFile/readFile log entries whose path contains `match`. */
export const fsLog = (app, match = '') =>
  app.evaluate((_e, m) => globalThis.__fsLog.filter((x) => x.path.includes(m)).map((x) => ({ ...x })), match);

/** Renderer -> main dirty/recovery/quit/close messages (see main-stub.cjs). */
export const ipcLog = (app, clear = false) =>
  app.evaluate((_e, c) => {
    const out = globalThis.__ipcLog.slice();
    if (c) globalThis.__ipcLog.length = 0;
    return out;
  }, clear);

/** The text the clipboard was last written with through clipboard.write ({ text, html, ... }). */
export const clipboardPayload = (app) => app.evaluate(() => globalThis.__e2e.clipboard);

// ---------------------------------------------------------------- windows & menu

/** Send a MenuAction to the window hosting `page` (what a menu click / accelerator does). */
export async function menu(app, page, action, payload) {
  const bw = await app.browserWindow(page);
  await bw.evaluate((w, [a, p]) => w.webContents.send('menu:action', a, p), [action, payload]);
}

/** Click an application-menu item by its label path, e.g. clickMenu(app, page, ['View', 'Reload']). */
export async function clickMenu(app, page, labels) {
  const id = await winId(app, page);
  await app.evaluate(({ BrowserWindow, Menu }, [id, ls]) => {
    const w = BrowserWindow.fromId(id);
    let items = Menu.getApplicationMenu().items;
    let item;
    for (const l of ls) {
      item = items.find((i) => i.label === l || i.role === l);
      if (!item) throw new Error(`menu item not found: ${ls.join(' > ')}`);
      items = item.submenu?.items ?? [];
    }
    item.click(undefined, w, w.webContents);
  }, [id, labels]);
}

/** All open MDitor pages, waiting until there are at least `n`. */
export async function windows(app, n = 1, timeout = 15_000) {
  await waitFor(() => app.windows().length >= n, { timeout, message: `${n} window(s)` });
  return app.windows();
}

/** BrowserWindow id of the window hosting `page`. */
export const winId = async (app, page) => (await app.browserWindow(page)).evaluate((w) => w.id);

/** Close the window hosting `page` like its close button does (may prompt). */
export async function closeWindow(app, page) {
  const bw = await app.browserWindow(page);
  await bw.evaluate((w) => w.close());
}

/** Fire the renderer's window blur (what auto-save / crash recovery listen to) without relying on OS focus. */
export const blurWindow = (page) => page.evaluate(() => window.dispatchEvent(new Event('blur')));

/** The first page (window) for which `pred(page)` resolves truthy. */
export async function findPage(app, pred, { timeout = 10_000, message = 'window' } = {}) {
  return waitFor(
    async () => {
      for (const p of app.windows()) {
        try {
          if (await pred(p)) return p;
        } catch {}
      }
      return null;
    },
    { timeout, interval: 100, message },
  );
}

export const title = (page) => page.evaluate(() => document.title);

/**
 * Open `file` through the stubbed Open dialog (File > Open) and return the page that
 * shows it — the same window, or a new one when the current window has edits.
 */
export async function openFile(app, page, file) {
  await stub(app, { open: file });
  await menu(app, page, 'openFile');
  const base = path.basename(file);
  return findPage(app, async (p) => (await title(p)).includes(base) && (await p.$('.cm-content')), {
    message: `a window showing ${base}`,
  });
}

// ---------------------------------------------------------------- editor

const VIEW = "document.querySelector('.cm-content').cmTile.view";

/** The editor's document text. */
export const getDoc = (page) => page.evaluate(`${VIEW}.state.doc.toString()`);

/** Replace the whole document as a user edit would (undoable, marks dirty). */
export const setDoc = (page, text) =>
  page.evaluate((t) => {
    const v = document.querySelector('.cm-content').cmTile.view;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t }, userEvent: 'input' });
  }, text);

/** Insert text at the end of the document as a user edit. */
export const appendDoc = (page, text) =>
  page.evaluate((t) => {
    const v = document.querySelector('.cm-content').cmTile.view;
    v.dispatch({ changes: { from: v.state.doc.length, insert: t }, userEvent: 'input' });
  }, text);

/** Put the cursor (or a selection) at document offsets and focus the editor. */
export const select = (page, anchor, head = anchor) =>
  page.evaluate(
    ([a, h]) => {
      const v = document.querySelector('.cm-content').cmTile.view;
      v.focus();
      v.dispatch({ selection: { anchor: a, head: h } });
    },
    [anchor, head],
  );

/** The main selection as { anchor, head }. */
export const selection = (page) =>
  page.evaluate(`(() => { const s = ${VIEW}.state.selection.main; return { anchor: s.anchor, head: s.head }; })()`);

/** The text of the main selection. */
export const selectedText = (page) =>
  page.evaluate(`(() => { const v = ${VIEW}; const s = v.state.selection.main; return v.state.sliceDoc(s.from, s.to); })()`);

/** Offset of the `nth` (0-based) occurrence of `needle` in the doc, plus `delta`. */
export async function posOf(page, needle, delta = 0, nth = 0) {
  const d = await getDoc(page);
  let i = -1;
  for (let k = 0; k <= nth; k++) i = d.indexOf(needle, i + 1);
  if (i < 0) throw new Error(`not found in document: ${JSON.stringify(needle)}`);
  return i + delta;
}

/** Put the caret at the end of the doc and type `text` with the keyboard. */
export async function typeAtEnd(page, text) {
  await select(page, (await getDoc(page)).length);
  await page.keyboard.type(text);
}

// ---------------------------------------------------------------- UI bits

/** The info banner under the toolbar, or null. */
export const bannerInfo = (page) =>
  page.evaluate(() => {
    const b = document.querySelector('.banner');
    if (!b) return null;
    return {
      cls: b.className,
      text: b.querySelector('.banner-message')?.textContent ?? '',
      buttons: [...b.querySelectorAll('.banner-button')].map((x) => x.textContent),
      hasClose: !!b.querySelector('.banner-close'),
    };
  });

/** Click the banner button labelled `label`; false if there is none. */
export const clickBanner = (page, label) =>
  page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.banner .banner-button')].find((x) => x.textContent === l);
    btn?.click();
    return !!btn;
  }, label);

/** The status bar's transient flash message ('' if none). */
export const flashText = (page) =>
  page.evaluate(() => document.querySelector('.status-bar-flash-message')?.textContent ?? '');

// ---------------------------------------------------------------- waiting

/** Poll `fn` until it returns truthy (and return that value), or throw after `timeout` ms. */
export async function waitFor(fn, { timeout = 5_000, interval = 50, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `Timed out after ${timeout} ms waiting for ${message} (last value: ${JSON.stringify(last)}${lastErr ? `, last error: ${lastErr.message}` : ''})`,
  );
}

/** Like waitFor, but returns false instead of throwing. */
export async function poll(fn, { timeout = 3_000, interval = 50 } = {}) {
  try {
    return await waitFor(fn, { timeout, interval });
  } catch {
    return false;
  }
}

/** True if `fn` stays falsy for the whole `ms` (to assert something does NOT happen). */
export async function never(fn, ms = 1_000, interval = 50) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return false;
    } catch {}
    await sleep(interval);
  }
  return true;
}

// ---------------------------------------------------------------- assertions & debugging

/**
 * Soft checks for scenarios that verify many independent things in one launch:
 *   const check = soft();
 *   check('title shows the file', t.includes('a.md'), t);
 *   ...
 *   check.done(); // throws one AssertionError listing every failed check
 */
export function soft() {
  const failed = [];
  const check = (name, ok, evidence) => {
    if (!ok) failed.push(evidence === undefined ? name : `${name} -- ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`);
    return !!ok;
  };
  check.done = () => {
    if (failed.length) assert.fail(`${failed.length} check(s) failed:\n  - ${failed.join('\n  - ')}`);
  };
  return check;
}

/** Save a screenshot of `page` to e2e/.output/<name>.png (for debugging; returns the path). */
export async function shot(page, name) {
  const p = path.join(OUTPUT, `${name}.png`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  await page.screenshot({ path: p });
  return p;
}
