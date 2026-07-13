/**
 * Shared application state (Svelte 5 rune module) and all actions that
 * operate on it: saving, opening, folders, notebooks, watching, menus.
 * UI components import `app` and the action functions directly.
 */
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { exists, readTextFile, rename, watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

import { baseName, parentDir, pathJoin, isWithin } from "./paths";
import { initSettings, persist, DEFAULT_FONT_SIZE, type Settings } from "./settings";
import {
	listDir,
	titleFromText,
	timestampTitle,
	uniquePath,
	trashNote,
	archiveNote,
	saveNoteFile,
	type DirListing,
	type NoteInfo,
} from "./notes";
import { buildExtensions, createEditor, setDocument, countWords } from "./editor";
import { detectBookRoot, compileChapterText, saveCompiledChapter, compileEpub } from "./book";

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
export const isWindows = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
export const modKeyLabel = isMac ? "⌘" : "Ctrl+";
export const RENDER_CHUNK = 300; // list rows rendered per batch; scrolling to the bottom loads more
const SAVE_DELAY_MS = 800; // save during a natural typing breather

export const app = $state({
	settings: {
		notebooks: [],
		lastDir: null,
		lastRoot: null,
		fontSize: DEFAULT_FONT_SIZE,
		sortByModified: true,
		defaultExt: ".md",
		showWordCount: true,
		paneWidth: 230,
		theme: "system",
	} as Settings,
	ready: false,
	rootDir: null as string | null,
	curDir: null as string | null,
	listing: { folders: [], notes: [] } as DirListing,
	filterText: "",
	displayNotes: [] as NoteInfo[],
	renderLimit: RENDER_CHUNK,
	selectedPath: null as string | null,
	wordCount: 0,
	writeMode: false,
	// Editor width in px, frozen at the moment write mode turns on, so the text
	// column (and therefore line wrapping) stays pixel-identical with no sidebar.
	writeModeWidth: null as number | null,
	openMenuShown: false,
	settingsMenuShown: false,
	modal: null as "shortcuts" | "about" | null,
	// Book mode: set when a visited folder contains a title.txt starting with ---
	bookRoot: null as string | null,
	toast: "",
});

// --- Non-reactive editor / save machinery ---
let editorParent: HTMLElement | undefined;
let view: EditorView;
let extensions: Extension[];
let cur: { path: string | null; title: string; ext: string } = { path: null, title: "", ext: ".md" };
let dirty = false;
let isOpening = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let unwatch: UnwatchFn | null = null;

/** DOM elements that other components need to reach (focus targets). */
export const refs = { filterInput: null as HTMLInputElement | null };

export function focusEditor(): void {
	view?.focus();
}

export function focusFilter(): void {
	refs.filterInput?.focus();
	refs.filterInput?.select();
}

export function isFilterFocused(): boolean {
	return document.activeElement === refs.filterInput;
}

// --- Saving (one atomic operation: derive title -> rename if needed -> write) ---

function onDocChanged(): void {
	app.wordCount = countWords(view.state.doc.toString());
	if (isOpening) return;
	dirty = true;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		void saveNow();
	}, SAVE_DELAY_MS);
}

async function saveNow(): Promise<void> {
	if (!app.curDir || !dirty) return;
	dirty = false;
	const text = view.state.doc.toString();

	if (cur.path === null) {
		if (text.trim() === "") return;
		const title = titleFromText(text) || timestampTitle();
		const path = await uniquePath(app.curDir, title, app.settings.defaultExt);
		await saveNoteFile(path, text);
		const name = baseName(path);
		cur = {
			path,
			title: name.slice(0, name.length - app.settings.defaultExt.length),
			ext: app.settings.defaultExt,
		};
		app.selectedPath = path;
		await refreshList();
		return;
	}

	if (text.trim() === "") {
		// Emptied out: move the file to trash
		const gone = cur.path;
		cur = { path: null, title: "", ext: app.settings.defaultExt };
		app.selectedPath = null;
		try {
			await trashNote(gone);
		} catch (e) {
			console.error("trash failed", e);
		}
		await refreshList();
		return;
	}

	let path = cur.path;
	const newTitle = titleFromText(text);
	if (newTitle !== "" && newTitle !== cur.title) {
		// First line changed: rename as part of the same save (keeps existing extension)
		const newPath = pathJoin(app.curDir, newTitle + cur.ext);
		if (!(await exists(newPath))) {
			try {
				await rename(path, newPath);
				path = newPath;
				cur = { ...cur, path: newPath, title: newTitle };
				app.selectedPath = newPath;
			} catch (e) {
				console.error("rename failed, keeping old filename", e);
			}
		}
		await saveNoteFile(path, text);
		await refreshList();
		return;
	}

	await saveNoteFile(path, text);
}

export async function flushSave(): Promise<void> {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	if (dirty) await saveNow();
}

// --- Notes / folders ---

export async function refreshList(): Promise<void> {
	const dir = app.curDir;
	if (!dir) return;
	try {
		app.listing = await listDir(dir);
	} catch (e) {
		console.error("could not list folder", e);
		app.listing = { folders: [], notes: [] };
	}
	// Book detection: this folder is a book root if title.txt starts with ---
	if (await detectBookRoot(dir, app.listing.notes.map((n) => n.title))) {
		app.bookRoot = dir;
	} else if (app.bookRoot === dir) {
		app.bookRoot = null;
	}
}

/** Is `dir` a chapter folder (direct child of the current book root)? */
export function isChapterDir(dir: string): boolean {
	return app.bookRoot !== null && dir !== app.bookRoot && parentDir(dir) === app.bookRoot;
}

/** Is the current folder a chapter of a book? */
export function inChapter(): boolean {
	return app.curDir !== null && isChapterDir(app.curDir);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string): void {
	app.toast = msg;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (app.toast = ""), 4000);
}

/** Compile the chapter being left into "Chapter NN" in the book root. */
async function compileLeftChapter(chapterDir: string): Promise<void> {
	const bookRoot = app.bookRoot;
	if (!bookRoot) return;
	try {
		const { title, text } = await compileChapterText(chapterDir);
		await saveCompiledChapter(bookRoot, title, text, app.settings.defaultExt);
		showToast(`Compiled ${title}`);
	} catch (e) {
		console.error("chapter compile failed", e);
	}
}

/** Compile the whole book (title + compiled chapters) into an ePub. */
export async function compileBook(): Promise<void> {
	if (!app.curDir || app.curDir !== app.bookRoot) return;
	await flushSave();
	try {
		const res = await compileEpub(app.curDir);
		showToast(`ePub compiled — ${res.chapters} chapters`);
		void revealItemInDir(res.path);
		await refreshList();
	} catch (e) {
		showToast(e instanceof Error ? e.message : String(e));
	}
}

export async function openNote(n: NoteInfo): Promise<void> {
	if (n.path === cur.path) return;
	await flushSave();
	isOpening = true;
	let text = "";
	try {
		text = await readTextFile(n.path);
	} catch (e) {
		console.error("could not read note", e);
	}
	cur = { path: n.path, title: n.title, ext: n.ext };
	app.selectedPath = n.path;
	setDocument(view, extensions, text);
	app.wordCount = countWords(text);
	dirty = false;
	isOpening = false;
	view.focus();
}

export async function newNote(seedTitle = ""): Promise<void> {
	await flushSave();
	isOpening = true;
	cur = { path: null, title: "", ext: app.settings.defaultExt };
	app.selectedPath = null;
	setDocument(view, extensions, seedTitle ? seedTitle + "\n\n" : "");
	app.wordCount = countWords(seedTitle);
	dirty = false;
	isOpening = false;
	if (seedTitle) {
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		dirty = true; // make sure the seeded title gets saved as a file
		void saveNow();
	}
	view.focus();
}

export async function archiveCurrent(): Promise<void> {
	if (!cur.path || !app.curDir) return;
	await flushSave();
	const path = cur.path;
	try {
		await archiveNote(path, app.curDir);
	} catch (e) {
		console.error("archive failed", e);
		return;
	}
	await newNote();
	await refreshList();
}

function isNotebook(dir: string): boolean {
	return app.settings.notebooks.includes(dir);
}

export async function setNotesDir(dir: string, asRoot: boolean): Promise<void> {
	await flushSave();
	// Leaving a chapter compiles it into the book root (original behavior)
	if (app.curDir && dir !== app.curDir && isChapterDir(app.curDir)) {
		await compileLeftChapter(app.curDir);
	}
	app.curDir = dir;
	if (asRoot || isNotebook(dir)) {
		app.rootDir = dir;
		rememberNotebook(dir);
	}
	app.settings.lastDir = dir;
	app.settings.lastRoot = app.rootDir;
	persist("lastDir", dir);
	persist("lastRoot", app.rootDir);
	app.filterText = "";
	await newNote();
	await refreshList();
	await watchDir(dir);
}

export async function chooseFolder(): Promise<void> {
	closeMenus();
	const dir = await openFolderDialog({ directory: true, title: "Choose Notes Folder" });
	if (typeof dir === "string" && dir) {
		await setNotesDir(dir, true);
	}
}

function rememberNotebook(dir: string): void {
	if (!app.settings.notebooks.includes(dir)) {
		app.settings.notebooks = [...app.settings.notebooks, dir];
		persist("notebooks", $state.snapshot(app.settings.notebooks));
	}
}

export function forgetCurrentNotebook(): void {
	closeMenus();
	if (!app.rootDir) return;
	app.settings.notebooks = app.settings.notebooks.filter((n) => n !== app.rootDir);
	persist("notebooks", $state.snapshot(app.settings.notebooks));
}

export async function goUp(): Promise<void> {
	if (!app.curDir || !app.rootDir || app.curDir === app.rootDir) return;
	const parent = parentDir(app.curDir);
	await setNotesDir(parent, parent === app.rootDir);
}

export async function enterFolder(name: string): Promise<void> {
	if (!app.curDir) return;
	await setNotesDir(pathJoin(app.curDir, name), false);
}

// --- External changes (Dropbox, other apps) ---

async function watchDir(dir: string): Promise<void> {
	if (unwatch) {
		unwatch();
		unwatch = null;
	}
	try {
		unwatch = await watch(dir, () => void onExternalChange(), { delayMs: 600 });
	} catch (e) {
		console.error("could not watch folder", e);
	}
}

async function onExternalChange(): Promise<void> {
	await refreshList();
	// Reload the open note if it changed on disk and we have no unsaved edits
	if (!cur.path || dirty || saveTimer) return;
	const readPath = cur.path;
	try {
		const text = await readTextFile(readPath);
		// Re-check after the read: the user may have typed or switched notes
		// while the disk read was in flight — never clobber live keystrokes.
		if (cur.path !== readPath || dirty || saveTimer) return;
		if (text !== view.state.doc.toString()) {
			const sel = Math.min(view.state.selection.main.head, text.length);
			isOpening = true;
			setDocument(view, extensions, text);
			view.dispatch({ selection: { anchor: sel } });
			app.wordCount = countWords(text);
			isOpening = false;
		}
	} catch {
		// File disappeared (deleted or renamed externally)
		if (view.state.doc.toString().trim() !== "") {
			cur = { path: null, title: "", ext: cur.ext };
			app.selectedPath = null;
		} else {
			await newNote();
		}
	}
}

// --- Context menus (native, via Tauri menu API) ---

export async function archiveFromList(n: NoteInfo): Promise<void> {
	if (!app.curDir) return;
	if (cur.path === n.path) {
		await archiveCurrent();
		return;
	}
	try {
		await archiveNote(n.path, app.curDir);
	} catch (e) {
		console.error("archive failed", e);
	}
	await refreshList();
}

export async function trashFromList(n: NoteInfo): Promise<void> {
	try {
		await trashNote(n.path);
	} catch (e) {
		console.error("trash failed", e);
		return;
	}
	if (cur.path === n.path) {
		// The open note's file is gone; discard editor state without saving
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		dirty = false;
		isOpening = true;
		cur = { path: null, title: "", ext: app.settings.defaultExt };
		app.selectedPath = null;
		setDocument(view, extensions, "");
		app.wordCount = 0;
		isOpening = false;
	}
	await refreshList();
}

export async function showEditContextMenu(): Promise<void> {
	const items = await Promise.all([
		PredefinedMenuItem.new({ item: "Cut" }),
		PredefinedMenuItem.new({ item: "Copy" }),
		PredefinedMenuItem.new({ item: "Paste" }),
		PredefinedMenuItem.new({ item: "Separator" }),
		PredefinedMenuItem.new({ item: "SelectAll" }),
	]);
	const menu = await Menu.new({ items });
	await menu.popup();
}

export async function showNoteContextMenu(n: NoteInfo): Promise<void> {
	const menu = await Menu.new({
		items: [
			{ id: "open", text: "Open", action: () => void openNote(n) },
			{
				id: "reveal",
				text: isMac ? "Reveal in Finder" : "Show in File Manager",
				action: () => void revealItemInDir(n.path),
			},
			{ id: "archive", text: "Archive", action: () => void archiveFromList(n) },
			await PredefinedMenuItem.new({ item: "Separator" }),
			{ id: "trash", text: "Move to Trash", action: () => void trashFromList(n) },
		],
	});
	await menu.popup();
}

// --- Fonts, write mode, menus ---

export function bumpFont(delta: number): void {
	const size = app.settings.fontSize + delta;
	if (size < 8 || size > 42) return;
	app.settings.fontSize = size;
	persist("fontSize", size);
}

export function resetFont(): void {
	app.settings.fontSize = DEFAULT_FONT_SIZE;
	persist("fontSize", DEFAULT_FONT_SIZE);
}

export function setWriteMode(on: boolean): void {
	if (on && !app.writeMode) {
		// Measure the scroller's inner width (excludes any classic scrollbar)
		// so the pinned column matches the pre-toggle text width exactly.
		app.writeModeWidth = view?.scrollDOM.clientWidth ?? editorParent?.clientWidth ?? null;
	}
	app.writeMode = on;
	if (!on) app.writeModeWidth = null;
	view?.focus();
}

export function toggleWriteMode(): void {
	setWriteMode(!app.writeMode);
}

export function closeMenus(): void {
	app.openMenuShown = false;
	app.settingsMenuShown = false;
}

// --- Startup / teardown ---

/** Mount the editor and restore the last session. Returns a cleanup function. */
export function initApp(editorParentEl: HTMLElement): () => void {
	editorParent = editorParentEl;
	let unlistenClose: (() => void) | undefined;
	let unlistenExit: (() => void) | undefined;

	void (async () => {
		app.settings = { ...app.settings, ...(await initSettings()) };
		extensions = buildExtensions(onDocChanged);
		view = createEditor(editorParentEl, extensions);

		if (app.settings.lastDir && (await exists(app.settings.lastDir))) {
			app.rootDir =
				app.settings.lastRoot && isWithin(app.settings.lastRoot, app.settings.lastDir)
					? app.settings.lastRoot
					: app.settings.lastDir;
			app.curDir = app.settings.lastDir;
			await refreshList();
			await watchDir(app.curDir);
		}
		app.ready = true;
		view.focus();

		const appWindow = getCurrentWindow();
		unlistenClose = await appWindow.onCloseRequested(async (event) => {
			if (dirty || saveTimer) {
				event.preventDefault();
				await flushSave();
				void appWindow.destroy();
			}
		});

		// Cmd+Q / app quit: Rust holds the exit until we flush and confirm
		unlistenExit = await listen("app-exit-requested", async () => {
			await flushSave();
			await invoke("really_quit");
		});
	})();

	const flushOnBlur = () => void flushSave();
	window.addEventListener("blur", flushOnBlur);

	return () => {
		window.removeEventListener("blur", flushOnBlur);
		unlistenClose?.();
		unlistenExit?.();
		if (unwatch) unwatch();
		view?.destroy();
	};
}
