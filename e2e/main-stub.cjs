// Loaded into the Electron main process (with --require) before MDitor's own code.
// Replaces native dialogs and OS side effects (opening URLs/files, the system
// clipboard, macOS recent documents, context-menu popups) with scriptable,
// recorded fakes, so tests never touch the real system and never block on a
// modal. Tests drive it through globalThis.__e2e via app.evaluate() — see the
// stub()/calls() helpers in harness.mjs.
const fs = require('fs');
const path = require('path');
const { dialog, shell, clipboard, app, BrowserWindow, Menu, ipcMain } = require('electron');

const state = (globalThis.__e2e = {
  calls: [],
  open: null, // string | string[] (queue) | null = cancel
  folder: null, // string | null = cancel
  save: null, // string | string[] (queue) | null = cancel
  messageBox: [], // queue of button indexes
  messageBoxDefault: null, // fallback index (null = the dialog's cancelId, else 0)
  messageBoxDelayMs: 0, // answer message boxes only after this long (a person reading the prompt)
  clipboard: null, // last clipboard.write payload
  fsRules: [], // see "fs fault injection" below
});
if (process.env.E2E_CONFIG) Object.assign(state, JSON.parse(fs.readFileSync(process.env.E2E_CONFIG, 'utf8')));

const optsOf = (args) => args.find((a) => a && typeof a === 'object' && !(a instanceof BrowserWindow)) || {};
const take = (v) => (Array.isArray(v) ? v.shift() ?? null : v);
const answer = (o) => (state.messageBox.length ? state.messageBox.shift() : state.messageBoxDefault ?? o.cancelId ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- native dialogs
dialog.showOpenDialog = async (...args) => {
  const o = optsOf(args);
  const dir = (o.properties || []).includes('openDirectory');
  state.calls.push({ type: dir ? 'openFolder' : 'open', title: o.title, filters: o.filters });
  const v = dir ? take(state.folder) : take(state.open);
  return v ? { canceled: false, filePaths: [v] } : { canceled: true, filePaths: [] };
};
dialog.showSaveDialog = async (...args) => {
  const o = optsOf(args);
  state.calls.push({ type: 'save', title: o.title, defaultPath: o.defaultPath, filters: o.filters });
  if (state.saveThrows) throw new Error(state.saveThrows);
  const v = take(state.save);
  return v ? { canceled: false, filePath: v } : { canceled: true, filePath: '' };
};
dialog.showMessageBox = async (...args) => {
  const o = optsOf(args);
  const call = { type: 'messageBox', message: o.message, detail: o.detail, buttons: o.buttons, t: Date.now() };
  state.calls.push(call);
  if (state.messageBoxDelayMs) await sleep(state.messageBoxDelayMs);
  call.response = answer(o);
  return { response: call.response, checkboxChecked: false };
};
dialog.showMessageBoxSync = (...args) => {
  const o = optsOf(args);
  const response = answer(o);
  state.calls.push({ type: 'messageBoxSync', message: o.message, buttons: o.buttons, response, t: Date.now() });
  return response;
};
dialog.showErrorBox = (title, content) => void state.calls.push({ type: 'errorBox', title, content });

// ---- OS side effects
shell.openExternal = async (url) => void state.calls.push({ type: 'openExternal', url });
shell.openPath = async (p) => (state.calls.push({ type: 'openPath', path: p }), '');
shell.showItemInFolder = (p) => void state.calls.push({ type: 'showItemInFolder', path: p });
clipboard.write = (data) => {
  state.clipboard = data;
  state.calls.push({ type: 'clipboardWrite', data });
};
app.addRecentDocument = (p) => void state.calls.push({ type: 'addRecentDocument', path: p });
app.clearRecentDocuments = () => void state.calls.push({ type: 'clearRecentDocuments' });
// A native context menu (e.g. the spell-check menu) is modal under automation and
// would block window close / quit forever; record it instead.
Menu.prototype.popup = function () {
  state.calls.push({ type: 'contextMenu', items: this.items.map((i) => i.label || i.role) });
};

// ---- determinism: windows that end up behind other windows (or hidden) keep
// full-speed timers/rAF and a "visible" Page Visibility state.
app.on('web-contents-created', (_e, wc) => wc.setBackgroundThrottling(false));

// ---- fs fault injection: delay or fail main-process fs.promises.writeFile/readFile
// for paths containing `match`. Rules: { op: 'write'|'read', match, ms?, fail?: 'ENOSPC', once? }.
// Every call is logged in globalThis.__fsLog ({ op, path, t, done?, delayed? }).
globalThis.__fsLog = [];
function wrapFs(name, op) {
  const orig = fs.promises[name];
  fs.promises[name] = async function (p, ...rest) {
    const ps = String(p);
    const entry = { op, path: ps, t: Date.now() };
    globalThis.__fsLog.push(entry);
    const rule = state.fsRules.find((r) => r.op === op && ps.includes(r.match));
    if (rule) {
      if (rule.once) state.fsRules.splice(state.fsRules.indexOf(rule), 1);
      if (rule.ms) await sleep(rule.ms);
      entry.delayed = rule.ms || 0;
      if (rule.fail) {
        const err = new Error(`${rule.fail}: injected failure, ${op} '${ps}'`);
        err.code = rule.fail;
        throw err;
      }
    }
    const out = await orig.call(this, p, ...rest);
    entry.done = Date.now();
    return out;
  };
}
wrapFs('writeFile', 'write');
wrapFs('readFile', 'read');

// ---- introspection
// Main's own module instances, e.g. globalThis.__mainModule('watcher').getDocumentPath(win).
const MAIN_DIR = path.resolve(__dirname, '..', 'dist-main', 'main');
globalThis.__mainModule = (name) => require(path.join(MAIN_DIR, `${name}.js`));
// For code inside app.evaluate() that needs Node modules.
globalThis.__require = require;
// Renderer -> main messages that matter for the dirty/recovery/quit protocol, per window.
globalThis.__ipcLog = [];
for (const ch of ['dirty:set', 'recovery:save', 'quit:confirm', 'window:close']) {
  ipcMain.on(ch, (e, a) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    globalThis.__ipcLog.push({
      ch,
      id: w ? w.id : null,
      t: Date.now(),
      v: ch === 'dirty:set' ? Boolean(a) : ch === 'recovery:save' ? (a ? 'snap' : null) : a,
    });
  });
}
