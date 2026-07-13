import { exists, mkdir, rename } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { baseName, pathJoin } from "./paths";

export interface NoteInfo {
	title: string;
	path: string;
	ext: string;
	mtime: number;
}

export interface DirListing {
	folders: string[];
	notes: NoteInfo[];
}

/** Extensions treated as notes. Both .md and .txt notes are always listed together. */
export const NOTE_EXTS = [".md", ".txt", ".markdown", ".text"];

export function extOf(name: string): string | null {
	const i = name.lastIndexOf(".");
	if (i <= 0) return null;
	const ext = name.slice(i).toLowerCase();
	return NOTE_EXTS.includes(ext) ? ext : null;
}

interface FsEntry {
	name: string;
	isDir: boolean;
	mtimeMs: number;
}

/** One IPC round-trip for the whole folder (names + mtimes come from Rust). */
export async function listDir(dir: string): Promise<DirListing> {
	const entries = await invoke<FsEntry[]>("list_notes", { dir });
	const folders: string[] = [];
	const notes: NoteInfo[] = [];
	for (const e of entries) {
		if (e.isDir) {
			folders.push(e.name);
			continue;
		}
		const ext = extOf(e.name);
		if (!ext) continue;
		notes.push({
			title: e.name.slice(0, e.name.length - ext.length),
			path: pathJoin(dir, e.name),
			ext,
			mtime: e.mtimeMs,
		});
	}
	folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	return { folders, notes };
}

export function sortNotes(notes: NoteInfo[], byModified: boolean): NoteInfo[] {
	const sorted = [...notes];
	if (byModified) {
		sorted.sort((a, b) => b.mtime - a.mtime);
	} else {
		sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
	}
	return sorted;
}

/** Derive a note title (= filename without extension) from the note text's first line. */
export function titleFromText(text: string): string {
	let title = (text.split("\n", 1)[0] ?? "").trim();
	while (title.startsWith("#")) title = title.slice(1);
	title = title.trim();
	if (title === "---") title = "";
	// Strip characters that are invalid in filenames on any supported OS
	title = title.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
	if (title.length > 150) title = title.slice(0, 150).trim();
	return title;
}

export function timestampTitle(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

/** First free path for `title` in `dir`, appending " 2", " 3", ... on collision. */
export async function uniquePath(dir: string, title: string, ext: string): Promise<string> {
	let candidate = pathJoin(dir, title + ext);
	let n = 2;
	while (await exists(candidate)) {
		candidate = pathJoin(dir, `${title} ${n}${ext}`);
		n++;
	}
	return candidate;
}

export async function trashNote(path: string): Promise<void> {
	await invoke("move_to_trash", { path });
}

/** Crash-safe save: Rust writes a temp file, fsyncs, then renames over the target. */
export async function saveNoteFile(path: string, contents: string): Promise<void> {
	await invoke("save_note", { path, contents });
}

export const ARCHIVE_DIR_NAME = "Archive";

/** Move a note into the notebook's Archive subfolder. */
export async function archiveNote(path: string, dir: string): Promise<void> {
	const archiveDir = pathJoin(dir, ARCHIVE_DIR_NAME);
	if (!(await exists(archiveDir))) await mkdir(archiveDir);
	const name = baseName(path);
	let target = pathJoin(archiveDir, name);
	if (await exists(target)) {
		const ext = extOf(name) ?? "";
		const stem = name.slice(0, name.length - ext.length);
		target = await uniquePath(archiveDir, stem + " (archived)", ext);
	}
	await rename(path, target);
}

/** Full-text search runs in Rust: one IPC call, returns matching file paths. */
export async function searchNoteContents(dir: string, query: string): Promise<Set<string>> {
	const paths = await invoke<string[]>("search_notes", { dir, query, exts: NOTE_EXTS });
	return new Set(paths);
}
