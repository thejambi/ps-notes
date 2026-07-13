# P.S. Notes.

**Notes, plain and simple.** A fast, keyboard-driven note-taking and writing app for macOS, Windows, and Linux.

Your notes are ordinary `.md` and `.txt` files in folders you choose. No database, no index files, no lock-in — the same folder works simultaneously with iA Writer, Notational Velocity, 1Writer (via Dropbox), or anything else that reads plain text. P.S. Notes is inspired by Notational Velocity and iA Writer, and is the cross-platform successor to the original [GTK/Vala P.S. Notes](https://github.com/thejambi/psnotes) for Linux.

Built with [Tauri 2](https://tauri.app), Svelte 5, and CodeMirror 6. The installers are a few megabytes.

## How it works

- **The first line of a note is its title is its filename.** Rename by editing the first line; the file follows.
- **Search or create.** One box filters titles instantly and full-note text a beat later. If nothing matches, press Enter to create a note with that title.
- **Autosave.** Notes save ~0.8s after you pause typing, and always on note switch, window blur, close, and quit. Saves are atomic (temp file + rename), so a crash can't truncate a note.
- **Notebooks & folders.** Remember multiple notes folders and switch via the Open menu; subfolders appear in the list with a breadcrumb trail.
- **Plays nicely with sync.** The open folder is watched — edits arriving from Dropbox/another device refresh the list and reload the open note if you have no unsaved changes.
- **Write mode** hides everything but your text, with the column width pinned to the pixel so nothing rewraps.
- Emptied notes go to the system trash. The Archive button files the current note into an `Archive/` subfolder.

Open **Aa → Keyboard shortcuts** in-app for the full shortcut list.

## Development setup

Prerequisites:

1. **Node.js** 20+ (`node --version`)
2. **Rust** (stable) — install via [rustup](https://rustup.rs):
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
3. Platform extras:
   - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
   - **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and WebView2 (preinstalled on Windows 11)
   - **Linux:** WebKitGTK and friends:
     ```sh
     sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
       build-essential curl wget file libssl-dev
     ```

Then:

```sh
npm install
npm run tauri dev     # run the app with hot reload
npm run check         # typecheck the frontend (svelte-check)
cd src-tauri && cargo check   # typecheck the Rust side
```

The first `tauri dev` compiles all Rust dependencies and takes a few minutes; subsequent runs are seconds. Frontend changes hot-reload in place; Rust/config changes rebuild and relaunch the app automatically.

## Building installers locally

```sh
npm run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:

| Platform | Output |
|---|---|
| macOS | `macos/P.S. Notes.app` and `dmg/P.S. Notes_<version>_<arch>.dmg` |
| Windows | `nsis/*.exe` (installer) and `msi/*.msi` |
| Linux | `deb/*.deb` and `appimage/*.AppImage` |

Each platform can only build its own installers — build the dmg on a Mac, the exe on Windows. For everything at once, use CI (below).

A locally built app runs without complaint on the machine that built it. Distributing to *other* machines unsigned means Gatekeeper (macOS: right-click → Open) or SmartScreen (Windows: More info → Run anyway) warnings; the proper fixes are an Apple Developer ID + notarization and a Windows code-signing certificate.

## CI builds (all platforms at once)

`.github/workflows/build.yml` builds macOS (universal), Windows, and Linux on GitHub Actions:

- **Tag a release:** `git tag v0.2.0 && git push origin v0.2.0`
- **Or run manually:** GitHub → Actions → Build → Run workflow

Download installers from the run's **Artifacts** section. The macOS CI artifact is unsigned and will be quarantined by Gatekeeper; prefer a local build for Mac testing.

To bump the app version, update `version` in both `package.json` and `src-tauri/tauri.conf.json`.

## Project layout

```
src/                        # Frontend (SvelteKit + Svelte 5)
  routes/+page.svelte       # Layout composition, keyboard shortcuts, editor mount
  lib/app.svelte.ts         # Shared reactive state + all actions
  lib/editor.ts             # CodeMirror 6 setup, live markdown styling, md commands
  lib/notes.ts              # File model: listing, titles, archive, search
  lib/settings.ts           # Persisted preferences (store plugin)
  lib/components/           # Toolbar (titlebar), Sidebar, Overlays
src-tauri/                  # Backend (Rust)
  src/lib.rs                # Commands: save_note (atomic), list_notes,
                            #   search_notes, move_to_trash, really_quit
  tauri.conf.json           # Window config (macOS overlay titlebar), bundling
  tauri.windows.conf.json   # Windows override: no native decorations
  capabilities/default.json # Permission grants for plugins
```

Almost all logic is TypeScript; the Rust side is a thin set of filesystem commands kept for speed (single-IPC folder listing and full-text search) and safety (atomic saves, flush-before-quit).

## License

GPL-3.0, same as the original P.S. Notes.
