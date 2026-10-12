import { Compartment, Extension, Facet, Prec } from '@codemirror/state';
import { EditorView, ViewPlugin, drawSelection } from '@codemirror/view';
import { closeCompletion } from '@codemirror/autocomplete';
import { CodeMirror, CodeMirrorV, ExFn, Vim, getCM, vim } from '@replit/codemirror-vim';

/**
 * Vim's file commands, for the app to carry out:
 * - `write`: :w, saves like Cmd/Ctrl+S.
 * - `quit`: :q, closes the window; unsaved changes are asked about as usual.
 * - `forceQuit`: :q!, closes the window and discards unsaved changes.
 * - `writeQuit`: :wq, saves, then closes once the save went through.
 * - `exit`: :x, like :wq, but a document without unsaved changes isn't written.
 */
export type VimCommand = 'write' | 'quit' | 'forceQuit' | 'writeQuit' | 'exit';

type VimCommandHandler = (command: VimCommand) => void;

const commandHandler = Facet.define<VimCommandHandler, VimCommandHandler | undefined>({
  combine: (handlers) => handlers[0],
});

// Shown in Vim's command line the way Vim shows its own errors.
function notify(cm: CodeMirrorV, message: string): void {
  const el = document.createElement('div');
  el.className = 'cm-vim-message';
  el.textContent = message;
  cm.openNotification(el, { bottom: true, duration: 15000 });
}

// Vim's ex commands are global, so each one finds the app's handler through
// the editor it was typed in. `:q!` arrives as command `q` with argString
// "!". Anything else after the name would be a file name, which only Save
// As (or Open) supplies here.
function exCommand(command: VimCommand, forced: VimCommand = command): ExFn {
  return (cm, params) => {
    const rest = params.argString ?? '';
    const force = rest.startsWith('!');
    const extra = (force ? rest.slice(1) : rest).trim();
    if (extra) {
      notify(
        cm,
        command === 'quit'
          ? `Trailing characters: ${extra}`
          : 'To save under another name, use File > Save As…',
      );
      return;
    }
    (cm.cm6 as EditorView).state.facet(commandHandler)?.(force ? forced : command);
  };
}

Vim.defineEx('write', 'w', exCommand('write'));
Vim.defineEx('wq', 'wq', exCommand('writeQuit'));
Vim.defineEx('xit', 'x', exCommand('exit'));
Vim.defineEx('quit', 'q', exCommand('quit', 'forceQuit'));

/** Vim keys are on and in Normal or Visual mode, where typing runs commands instead of inserting text. */
export function vimNormalMode(view: EditorView): boolean {
  const state = getCM(view)?.state.vim;
  return !!state && !state.insertMode;
}

// Vim leaves keys it has no use for to the editor's other bindings, which
// in Normal and Visual mode must not edit the text: Tab and Enter would
// indent, continue a list or move between table cells (Enter would also
// replace a Visual selection), and macOS's Emacs-style Ctrl keys delete or
// transpose (Ctrl-K, Ctrl-H, Ctrl-T). Shortcuts on the platform's command
// key, and Alt chords, still work.
const normalModeKeys = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.isComposing || event.metaKey || event.altKey || !vimNormalMode(view)) return false;
    const swallow = event.ctrlKey ? CodeMirror.isMac : event.key === 'Tab' || event.key === 'Enter';
    if (swallow) event.preventDefault();
    return swallow;
  },
});

// Vim sees Escape before an open completion popup does, so the popup would
// outlive Insert mode and go on taking keys Normal mode needs (arrows,
// Enter). It closes when Insert mode ends.
const closeCompletionInNormalMode = ViewPlugin.fromClass(
  class {
    private readonly cm: CodeMirror | null;
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      // Vim's own plugin comes first in vimExtension, so it already exists.
      this.cm = getCM(view);
      this.cm?.on('vim-mode-change', this.onModeChange);
    }

    private readonly onModeChange = (e: { mode: string }) => {
      // Mode changes can be signalled mid-update, where dispatching isn't allowed.
      if (e.mode === 'normal') {
        queueMicrotask(() => {
          if (!this.destroyed) closeCompletion(this.view);
        });
      }
    };

    destroy() {
      this.destroyed = true;
      this.cm?.off('vim-mode-change', this.onModeChange);
    }
  },
);

// Vim hides the native selection in favor of its block cursor, so Visual
// mode needs the selection drawn by the editor.
const vimExtension: Extension = [
  vim({ status: true }),
  drawSelection(),
  normalModeKeys,
  closeCompletionInNormalMode,
];

const vimCompartment = new Compartment();

/**
 * Vim keybindings, `enabled` to start with (switch them with
 * setVimKeybindings), and where their file commands go. Vim must see each
 * key before every other binding, so this sits at the highest precedence;
 * put it first in the editor's extensions.
 */
export function vimKeybindings(enabled: boolean, onCommand: VimCommandHandler): Extension {
  return [
    Prec.highest(vimCompartment.of(enabled ? vimExtension : [])),
    commandHandler.of(onCommand),
  ];
}

/** Turn Vim keybindings on or off in a running editor. */
export function setVimKeybindings(view: EditorView, enabled: boolean): void {
  if ((vimCompartment.get(view.state) === vimExtension) === enabled) return;
  view.dispatch({ effects: vimCompartment.reconfigure(enabled ? vimExtension : []) });
}
