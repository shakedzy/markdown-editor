<p align="center">
  <img src="./assets/banner.svg" alt="MDitor" width="820" />
</p>

# MDitor

<p>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64-111?style=flat-square">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-x86__64-111?style=flat-square">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-111?style=flat-square">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-32-2B2E3A?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-111?style=flat-square">
</p>

A cross-platform desktop **markdown viewer & editor** with a side-by-side or tabbed live preview, an optional table-of-contents (TOC) panel, OS-native spell checking, Word-like formatting shortcuts, GitHub Flavored Markdown, and code syntax highlighting.

Runs on **macOS (Apple Silicon)**, **Windows (x64)**, and **Linux (x64)**.

## Features

- **Two views, one shortcut.** Edit and preview side-by-side or as switchable tabs (`Cmd/Ctrl+\`). Drag the divider to resize the split.
- **TOC panel.** Left-side table-of-contents built from `#` (ATX) and Setext headings — click to jump in both editor and preview (`Cmd/Ctrl+Shift+T`). Shown by default.
- **Native spell-check.** Uses your OS's dictionary via Electron's built-in spell checker (macOS, Windows, and Linux). Right-click misspelled words for suggestions and to add to your personal dictionary.
- **Word-like shortcuts.** `Cmd/Ctrl+B` wraps in `**bold**`, `Cmd/Ctrl+I` wraps in `_italic_`, `Cmd/Ctrl+U` wraps in `<ins>underline</ins>`. With no selection, the markers are inserted with the cursor placed between them. The exact markers are configurable in Settings.
- **Smart lists.** Press Enter on a `-`, `*`, `+`, or `1.` line to continue the list. Double-Enter exits the list.
- **Find / Replace.** `Cmd/Ctrl+F` opens CodeMirror's search & replace panel.
- **Export to PDF.** `Cmd/Ctrl+Shift+E` (or File → Export to PDF…) renders the current preview — math, Mermaid diagrams, syntax highlighting, and images included — to a PDF.
- **Settings.** `Cmd/Ctrl+,` opens a settings dialog: theme (auto/light/dark), formatting markers, default view (split/tabs), GitHub extensions on by default, and welcome-on-launch.
- **Light & dark themes.** Auto-follows the OS appearance by default; editor, preview, Mermaid, and code highlighting all switch together.
- **Always on:** GFM (tables, task lists, strikethrough `~~double~~`, autolinks), inline & display math (`$x^2$` / `$$ … $$`, via KaTeX), and Mermaid diagrams in ` ```mermaid ` fenced blocks.
- **GH toggle for GitHub-only extensions** (`Cmd/Ctrl+Shift+G`, on by default): alerts (`> [!NOTE]`/`[!TIP]`/`[!IMPORTANT]`/`[!WARNING]`/`[!CAUTION]`), footnotes (`[^1]`), single-tilde strikethrough (`~text~`), and emoji shortcodes (`:rocket:`).
- **Syntax-highlighted code blocks.** Powered by [highlight.js](https://highlightjs.org/) with the GitHub theme.
- **Local images & assets.** Relative image/asset paths in a document are served through a custom `mditor://` protocol so they render in the preview. HTML is sanitized with DOMPurify.
- **`.md` file association.** MDitor registers as a recommended app for `.md` files on all three OSes. Open/Save dialogs also accept `.markdown`, `.mdown`, and `.mkd`.
- **Multi-window, single instance.** A single process owns all windows; opening a `.md` from the OS opens it in a new window, while launching MDitor again with no file focuses the existing window.

## Install

Pre-built binaries are attached to each [GitHub Release](../../releases). Pick the right one for your OS:

| OS | Architecture | File |
|----|--------------|------|
| macOS | Apple Silicon | `MDitor-<version>-arm64.dmg` |
| Windows | x64 | `MDitor Setup <version>.exe` |
| Linux | x64 | `MDitor-<version>.AppImage` (portable), `mditor_<version>_amd64.deb`, `mditor-<version>.x86_64.rpm` |

### macOS — first launch

The macOS DMG ships **unsigned** in the current release line. Gatekeeper will refuse to open it on the first launch. To bypass:

```sh
xattr -cr /Applications/MDitor.app
```

(Or right-click the app in Finder → Open → Open.)

### Linux

- **AppImage:** `chmod +x MDitor-<version>.AppImage && ./MDitor-<version>.AppImage`
- **deb:** `sudo apt install ./mditor_<version>_amd64.deb`
- **rpm:** `sudo dnf install ./mditor-<version>.x86_64.rpm`

### Windows

Run the NSIS installer (`MDitor Setup <version>.exe`). The installer registers the app for `.md` files and creates Start Menu and desktop shortcuts.

## Default file handler

After install, right-click any `.md` file → **Open With** → MDitor. Set as default to make double-clicking `.md` files launch MDitor.

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| New | `Cmd/Ctrl+N` |
| Open | `Cmd/Ctrl+O` |
| Save | `Cmd/Ctrl+S` |
| Save As | `Cmd/Ctrl+Shift+S` |
| Export to PDF | `Cmd/Ctrl+Shift+E` |
| Find / Replace | `Cmd/Ctrl+F` |
| Settings | `Cmd/Ctrl+,` |
| Bold | `Cmd/Ctrl+B` |
| Italic | `Cmd/Ctrl+I` |
| Underline | `Cmd/Ctrl+U` |
| Strikethrough | Format menu (no default accelerator) |
| Toggle Split / Tabs | `Cmd/Ctrl+\` |
| Toggle TOC Panel | `Cmd/Ctrl+Shift+T` |
| Toggle GitHub Extensions (GH) | `Cmd/Ctrl+Shift+G` |
| Keyboard Shortcuts dialog | `?` (or Help menu) |

## Development

Requires **Node.js 20+** and npm. On first checkout:

```sh
npm install
npm run dev       # starts Vite + Electron
```

Icon files are committed under `build/`. Only re-run `npm run icons` after changing the source SVGs in `assets/` (`.icns` is regenerated on macOS only).

`npm run dev` launches the Vite dev server on port 5173 (renderer HMR) and an Electron window pointed at it; the main and preload processes are compiled once with `tsc`/`esbuild` before Electron starts. The app opens a sample document so you can verify the editor, preview, ToC, and spell-check immediately.

### Available scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server (renderer HMR) + compiled main/preload + Electron |
| `npm run build` | Compile renderer, main, and preload to `dist-renderer/` and `dist-main/` |
| `npm run pack` | `npm run build` then `electron-builder --dir` (unpacked app, no installer) |
| `npm run dist` | `npm run build` then `electron-builder` for the host OS |
| `npm run dist:mac` | `npm run build` then `electron-builder --mac --arm64` |
| `npm run dist:win` | `npm run build` then `electron-builder --win --x64` |
| `npm run dist:linux` | `npm run build` then `electron-builder --linux --x64` |
| `npm run icons` | Regenerate app + file icons from `assets/icon.svg` and `assets/file-icon.svg` into `build/` (`.icns` generated on macOS only) |
| `npm run check-version` | `node scripts/check-version.mjs <version>` — used by CI |
| `npm run typecheck` | TypeScript no-emit check on main+preload and renderer |

The composite scripts above also expose their individual steps: `dev:renderer`, `dev:electron`, `build:renderer`, `build:main`, and `build:preload`.

### Project layout

```
src/
  main/         # Electron main process (windows, menu, IPC, spellcheck, mditor:// protocol)
  preload/      # contextBridge surface exposed as window.api
  shared/       # IPC channel names + payload types
  renderer/     # React app (CodeMirror editor, marked preview, ToC, dialogs, toolbar)
build/          # committed app/file icons + macOS entitlements (regenerate with `npm run icons`)
assets/         # source SVGs for the icons
scripts/        # check-version + icon generator
electron-builder.yml   # packaging / file-association config
vite.config.ts         # renderer dev server + build
.github/workflows/release.yml
```

The renderer is sandboxed with `contextIsolation: true` and `sandbox: true`. All file I/O goes through the preload bridge — the renderer never touches `fs` directly.

## Releasing

1. Bump the `"version"` field in `package.json` (e.g. `0.1.0` → `0.2.0`) and commit.
2. Push to `main`.
3. Open the GitHub Actions tab → **Release** workflow → **Run workflow**.
4. Enter the same version in the `version` input. The workflow:
   - Validates the input matches `package.json` (fails fast on mismatch).
   - Builds the macOS DMG, Windows NSIS installer, and Linux AppImage/deb/rpm in parallel.
   - Uploads each artifact to **JFrog Fly** under `mditor/<version>/<filename>`.
   - Creates a **draft** GitHub release with all artifacts attached, ready for review.

The draft release is intentionally not published automatically — review the artifacts, edit the notes, then publish from the GitHub UI when ready.

## License

[MIT](LICENSE)
