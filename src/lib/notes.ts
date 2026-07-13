import { exists, mkdir, readDir, readTextFile, rename, stat } from "@tauri-apps/plugin-fs";
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

export async function listDir(dir: string): Promise<DirListing> {
	const entries = await readDir(dir);
	const folders: string[] = [];
	const notes: NoteInfo[] = [];
	await Promise.all(
		entries.map(async (e) => {
			if (e.name.startsWith(".")) return;
			if (e.isDirectory) {
				folders.push(e.name);
				return;
			}
			if (!e.isFile) return;
			const ext = extOf(e.name);
			if (!ext) return;
			const path = pathJoin(dir, e.name);
			let mtime = 0;
			try {
				const info = await stat(path);
				mtime = info.mtime ? new Date(info.mtime).getTime() : 0;
			} catch {
				// unreadable file; list it anyway
			}
			notes.push({ title: e.name.slice(0, e.name.length - ext.length), path, ext, mtime });
		}),
	);
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

/* --- Full-text search with a small mtime-validated cache --- */

const contentCache = new Map<string, { mtime: number; text: string }>();

export async function noteContains(note: NoteInfo, lowerQuery: string): Promise<boolean> {
	let cached = contentCache.get(note.path);
	if (!cached || cached.mtime !== note.mtime) {
		try {
			cached = { mtime: note.mtime, text: (await readTextFile(note.path)).toLowerCase() };
		} catch {
			return false;
		}
		contentCache.set(note.path, cached);
	}
	return cached.text.includes(lowerQuery);
}
