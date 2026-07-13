<script lang="ts">
	import { onMount } from "svelte";
	import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
	import { exists, readTextFile, rename, watch, writeTextFile, type UnwatchFn } from "@tauri-apps/plugin-fs";
	import { revealItemInDir } from "@tauri-apps/plugin-opener";
	import { getCurrentWindow } from "@tauri-apps/api/window";
	import type { EditorView } from "@codemirror/view";
	import type { Extension } from "@codemirror/state";

	import { baseName, parentDir, pathJoin, isWithin } from "$lib/paths";
	import { initSettings, persist, DEFAULT_FONT_SIZE, type Settings } from "$lib/settings";
	import {
		listDir,
		sortNotes,
		titleFromText,
		timestampTitle,
		uniquePath,
		trashNote,
		archiveNote,
		noteContains,
		type DirListing,
		type NoteInfo,
	} from "$lib/notes";
	import { buildExtensions, createEditor, setDocument, countWords } from "$lib/editor";

	const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
	const mod = isMac ? "⌘" : "Ctrl+";

	// --- Reactive state ---
	let settings = $state<Settings>({
		notebooks: [],
		lastDir: null,
		lastRoot: null,
		fontSize: DEFAULT_FONT_SIZE,
		sortByModified: true,
		defaultExt: ".md",
		showWordCount: true,
		paneWidth: 230,
	});
	let ready = $state(false);
	let rootDir = $state<string | null>(null);
	let curDir = $state<string | null>(null);
	let listing = $state<DirListing>({ folders: [], notes: [] });
	let filterText = $state("");
	let displayNotes = $state<NoteInfo[]>([]);
	let selectedPath = $state<string | null>(null);
	let wordCount = $state(0);
	let writeMode = $state(false);
	let openMenuShown = $state(false);
	let settingsMenuShown = $state(false);
	let modal = $state<"shortcuts" | "about" | null>(null);

	// --- Non-reactive editor / save machinery ---
	let editorParent: HTMLElement;
	let filterInput: HTMLInputElement;
	let view: EditorView;
	let extensions: Extension[];
	let cur: { path: string | null; title: string; ext: string } = { path: null, title: "", ext: ".md" };
	let dirty = false;
	let isOpening = false;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let unwatch: UnwatchFn | null = null;

	const SAVE_DELAY_MS = 800; // save during a natural typing breather

	const visibleFolders = $derived.by(() => {
		const q = filterText.trim().toLowerCase();
		if (!q) return listing.folders;
		return listing.folders.filter((f) => f.toLowerCase().includes(q));
	});

	const crumbs = $derived.by(() => {
		if (!curDir || !rootDir) return [];
		const parts: { label: string; path: string }[] = [{ label: baseName(rootDir), path: rootDir }];
		if (curDir !== rootDir && isWithin(rootDir, curDir)) {
			const rel = curDir.slice(rootDir.length).split(/[\\/]/).filter((p) => p !== "");
			let acc = rootDir;
			for (const seg of rel) {
				acc = pathJoin(acc, seg);
				parts.push({ label: seg, path: acc });
			}
		}
		return parts;
	});

	// Filter notes: title matches first, then full-text matches
	let searchGen = 0;
	$effect(() => {
		const q = filterText.trim().toLowerCase();
		const notes = sortNotes(listing.notes, settings.sortByModified);
		const gen = ++searchGen;
		if (!q) {
			displayNotes = notes;
			return;
		}
		const titleMatches = notes.filter((n) => n.title.toLowerCase().includes(q));
		displayNotes = titleMatches;
		void (async () => {
			const matched = new Set(titleMatches.map((n) => n.path));
			const bodyMatches: NoteInfo[] = [];
			for (const n of notes) {
				if (matched.has(n.path)) continue;
				if (await noteContains(n, q)) bodyMatches.push(n);
			}
			if (gen === searchGen && bodyMatches.length > 0) {
				displayNotes = [...titleMatches, ...bodyMatches];
			}
		})();
	});

	// --- Saving (one atomic operation: derive title -> rename if needed -> write) ---

	function onDocChanged() {
		wordCount = countWords(view.state.doc.toString());
		if (isOpening) return;
		dirty = true;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			void saveNow();
		}, SAVE_DELAY_MS);
	}

	async function saveNow(): Promise<void> {
		if (!curDir || !dirty) return;
		dirty = false;
		const text = view.state.doc.toString();

		if (cur.path === null) {
			if (text.trim() === "") return;
			const title = titleFromText(text) || timestampTitle();
			const path = await uniquePath(curDir, title, settings.defaultExt);
			await writeTextFile(path, text);
			const name = baseName(path);
			cur = { path, title: name.slice(0, name.length - settings.defaultExt.length), ext: settings.defaultExt };
			selectedPath = path;
			await refreshList();
			return;
		}

		if (text.trim() === "") {
			// Emptied out: move the file to trash
			const gone = cur.path;
			cur = { path: null, title: "", ext: settings.defaultExt };
			selectedPath = null;
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
			const newPath = pathJoin(curDir, newTitle + cur.ext);
			if (!(await exists(newPath))) {
				try {
					await rename(path, newPath);
					path = newPath;
					cur = { ...cur, path: newPath, title: newTitle };
					selectedPath = newPath;
				} catch (e) {
					console.error("rename failed, keeping old filename", e);
				}
			}
			await writeTextFile(path, text);
			await refreshList();
			return;
		}

		await writeTextFile(path, text);
	}

	async function flushSave(): Promise<void> {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		if (dirty) await saveNow();
	}

	// --- Notes / folders ---

	async function refreshList(): Promise<void> {
		if (!curDir) return;
		try {
			listing = await listDir(curDir);
		} catch (e) {
			console.error("could not list folder", e);
			listing = { folders: [], notes: [] };
		}
	}

	async function openNote(n: NoteInfo): Promise<void> {
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
		selectedPath = n.path;
		setDocument(view, extensions, text);
		wordCount = countWords(text);
		dirty = false;
		isOpening = false;
		view.focus();
	}

	async function newNote(seedTitle = ""): Promise<void> {
		await flushSave();
		isOpening = true;
		cur = { path: null, title: "", ext: settings.defaultExt };
		selectedPath = null;
		setDocument(view, extensions, seedTitle ? seedTitle + "\n\n" : "");
		wordCount = countWords(seedTitle);
		dirty = false;
		isOpening = false;
		if (seedTitle) {
			view.dispatch({ selection: { anchor: view.state.doc.length } });
			dirty = true; // make sure the seeded title gets saved as a file
			void saveNow();
		}
		view.focus();
	}

	async function archiveCurrent(): Promise<void> {
		if (!cur.path || !curDir) return;
		await flushSave();
		const path = cur.path;
		try {
			await archiveNote(path, curDir);
		} catch (e) {
			console.error("archive failed", e);
			return;
		}
		await newNote();
		await refreshList();
	}

	function isNotebook(dir: string): boolean {
		return settings.notebooks.includes(dir);
	}

	async function setNotesDir(dir: string, asRoot: boolean): Promise<void> {
		await flushSave();
		curDir = dir;
		if (asRoot || isNotebook(dir)) {
			rootDir = dir;
			rememberNotebook(dir);
		}
		settings.lastDir = dir;
		settings.lastRoot = rootDir;
		persist("lastDir", dir);
		persist("lastRoot", rootDir);
		filterText = "";
		await newNote();
		await refreshList();
		await watchDir(dir);
	}

	async function chooseFolder(): Promise<void> {
		closeMenus();
		const dir = await openFolderDialog({ directory: true, title: "Choose Notes Folder" });
		if (typeof dir === "string" && dir) {
			await setNotesDir(dir, true);
		}
	}

	function rememberNotebook(dir: string): void {
		if (!settings.notebooks.includes(dir)) {
			settings.notebooks = [...settings.notebooks, dir];
			persist("notebooks", $state.snapshot(settings.notebooks));
		}
	}

	function forgetCurrentNotebook(): void {
		closeMenus();
		if (!rootDir) return;
		settings.notebooks = settings.notebooks.filter((n) => n !== rootDir);
		persist("notebooks", $state.snapshot(settings.notebooks));
	}

	async function goUp(): Promise<void> {
		if (!curDir || !rootDir || curDir === rootDir) return;
		const parent = parentDir(curDir);
		await setNotesDir(parent, parent === rootDir);
	}

	async function enterFolder(name: string): Promise<void> {
		if (!curDir) return;
		await setNotesDir(pathJoin(curDir, name), false);
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
		try {
			const text = await readTextFile(cur.path);
			if (text !== view.state.doc.toString()) {
				const sel = Math.min(view.state.selection.main.head, text.length);
				isOpening = true;
				setDocument(view, extensions, text);
				view.dispatch({ selection: { anchor: sel } });
				wordCount = countWords(text);
				isOpening = false;
			}
		} catch {
			// File disappeared (deleted or renamed externally)
			if (view.state.doc.toString().trim() !== "") {
				cur = { path: null, title: "", ext: cur.ext };
				selectedPath = null;
			} else {
				await newNote();
			}
		}
	}

	// --- Fonts, write mode, shortcuts ---

	function bumpFont(delta: number): void {
		const size = settings.fontSize + delta;
		if (size < 8 || size > 42) return;
		settings.fontSize = size;
		persist("fontSize", size);
	}

	function resetFont(): void {
		settings.fontSize = DEFAULT_FONT_SIZE;
		persist("fontSize", DEFAULT_FONT_SIZE);
	}

	function toggleWriteMode(): void {
		writeMode = !writeMode;
		view?.focus();
	}

	function closeMenus(): void {
		openMenuShown = false;
		settingsMenuShown = false;
	}

	function onWindowMousedown(e: MouseEvent): void {
		const el = e.target as Element | null;
		if (!el?.closest(".menu-wrap")) closeMenus();
	}

	function onKeydown(e: KeyboardEvent): void {
		const modKey = isMac ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();

		if (e.key === "Escape") {
			if (modal) {
				modal = null;
			} else if (openMenuShown || settingsMenuShown) {
				closeMenus();
			} else if (writeMode) {
				writeMode = false;
			} else if (document.activeElement === filterInput) {
				if (filterText !== "") filterText = "";
				else view.focus();
			} else {
				filterInput?.focus();
				filterInput?.select();
			}
			e.preventDefault();
			return;
		}

		if (!modKey) return;

		if (e.shiftKey) {
			if (key === "w") {
				e.preventDefault();
				toggleWriteMode();
			}
			return;
		}

		switch (key) {
			case "n":
				e.preventDefault();
				void newNote();
				break;
			case "o":
				e.preventDefault();
				void chooseFolder();
				break;
			case "f":
				e.preventDefault();
				filterInput?.focus();
				filterInput?.select();
				break;
			case "s":
				e.preventDefault();
				void flushSave();
				break;
			case "w":
				// Cmd+W closes the window on macOS; Ctrl+W toggles write mode elsewhere
				if (!isMac) {
					e.preventDefault();
					toggleWriteMode();
				}
				break;
			case "=":
			case "+":
				e.preventDefault();
				bumpFont(1);
				break;
			case "-":
				e.preventDefault();
				bumpFont(-1);
				break;
			case "0":
				e.preventDefault();
				resetFont();
				break;
		}
	}

	function onFilterKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			const q = filterText.trim();
			if (displayNotes.length > 0) {
				void openNote(displayNotes[0]);
			} else if (q !== "" && curDir) {
				// No match: create a note titled with the search text (NV style)
				filterText = "";
				void newNote(q);
			}
		} else if (e.key === "ArrowDown" && displayNotes.length > 0) {
			e.preventDefault();
			void openNote(displayNotes[0]);
		}
	}

	// --- Pane divider drag ---
	function startPaneDrag(e: MouseEvent): void {
		e.preventDefault();
		const onMove = (ev: MouseEvent) => {
			settings.paneWidth = Math.min(480, Math.max(150, ev.clientX));
		};
		const onUp = () => {
			persist("paneWidth", settings.paneWidth);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}

	// --- Startup ---

	onMount(() => {
		let unlistenClose: (() => void) | undefined;

		void (async () => {
			settings = { ...settings, ...(await initSettings()) };
			extensions = buildExtensions(onDocChanged);
			view = createEditor(editorParent, extensions);

			if (settings.lastDir && (await exists(settings.lastDir))) {
				rootDir =
					settings.lastRoot && isWithin(settings.lastRoot, settings.lastDir)
						? settings.lastRoot
						: settings.lastDir;
				curDir = settings.lastDir;
				await refreshList();
				await watchDir(curDir);
			}
			ready = true;
			view.focus();

			const appWindow = getCurrentWindow();
			unlistenClose = await appWindow.onCloseRequested(async (event) => {
				if (dirty || saveTimer) {
					event.preventDefault();
					await flushSave();
					void appWindow.destroy();
				}
			});
		})();

		const flushOnBlur = () => void flushSave();
		window.addEventListener("blur", flushOnBlur);

		return () => {
			window.removeEventListener("blur", flushOnBlur);
			unlistenClose?.();
			if (unwatch) unwatch();
			view?.destroy();
		};
	});

	const shortcutRows: [string, string][] = [
		[`${mod}N`, "New note"],
		[`${mod}F or Esc`, "Jump to filter / search box"],
		["Esc", "Clear filter / exit write mode"],
		["Enter (in filter)", "Open top match, or create note with that title"],
		[isMac ? "⌘⇧W" : "Ctrl+W", "Toggle write mode"],
		[`${mod}O`, "Choose notes folder"],
		[`${mod}=  /  ${mod}-  /  ${mod}0`, "Font size bigger / smaller / reset"],
		[`${mod}A then Delete`, "Delete current note (emptied notes go to trash)"],
		[`${mod}B  /  ${mod}I`, "Bold / italics"],
		[`${mod}1–6`, "Set heading level"],
		[`${mod}\\  /  ${isMac ? "⌘⇧\\" : "Ctrl+Shift+\\"}`, "Increase / decrease heading level"],
		[`${mod}K`, "Toggle HTML comment around selection"],
	];
</script>

<svelte:window onkeydown={onKeydown} onmousedown={onWindowMousedown} />

<main class="app" class:write-mode={writeMode}>
	<div class="toolbar">
		<div class="toolbar-group">
			<div class="menu-wrap">
				<button
					class="tb-btn"
					title="Change notes folder ({mod}O)"
					onclick={() => {
						settingsMenuShown = false;
						openMenuShown = !openMenuShown;
					}}>Open ▾</button
				>
				{#if openMenuShown}
					<div class="menu">
						<button class="menu-item" onclick={chooseFolder}>Choose notes folder…</button>
						{#if settings.notebooks.length > 0}
							<div class="menu-sep"></div>
							{#each settings.notebooks as nb (nb)}
								<button
									class="menu-item notebook"
									class:current={nb === rootDir}
									onclick={() => {
										closeMenus();
										void setNotesDir(nb, true);
									}}
								>
									<span class="nb-name">{baseName(nb)}</span>
									<span class="nb-path">{nb}</span>
								</button>
							{/each}
						{/if}
						{#if curDir}
							<div class="menu-sep"></div>
							<button class="menu-item" onclick={forgetCurrentNotebook}>Forget current notebook</button>
							<button
								class="menu-item"
								onclick={() => {
									closeMenus();
									if (curDir) void revealItemInDir(curDir);
								}}>Show notebook files</button
							>
						{/if}
					</div>
				{/if}
			</div>
			<button class="tb-btn" title="New note ({mod}N)" onclick={() => void newNote()} disabled={!curDir}>New</button>
			<button class="tb-btn" title="Archive note" onclick={() => void archiveCurrent()} disabled={!selectedPath}
				>Archive</button
			>
		</div>

		<div class="crumbs">
			{#each crumbs as c, i (c.path)}
				{#if i > 0}<span class="crumb-sep">/</span>{/if}
				<button
					class="crumb"
					class:here={c.path === curDir}
					onclick={() => void setNotesDir(c.path, c.path === rootDir)}>{c.label}</button
				>
			{/each}
		</div>

		<div class="toolbar-group">
			{#if settings.showWordCount}
				<span class="word-count">{wordCount} {wordCount === 1 ? "word" : "words"}</span>
			{/if}
			<div class="menu-wrap">
				<button
					class="tb-btn"
					title="Settings"
					onclick={() => {
						openMenuShown = false;
						settingsMenuShown = !settingsMenuShown;
					}}>Aa ▾</button
				>
				{#if settingsMenuShown}
					<div class="menu menu-right">
						<button
							class="menu-item check"
							onclick={() => {
								settings.sortByModified = !settings.sortByModified;
								persist("sortByModified", settings.sortByModified);
							}}>{settings.sortByModified ? "✓" : " "} Sort by recently modified</button
						>
						<button
							class="menu-item check"
							onclick={() => {
								settings.showWordCount = !settings.showWordCount;
								persist("showWordCount", settings.showWordCount);
							}}>{settings.showWordCount ? "✓" : " "} Show word count</button
						>
						<button class="menu-item check" onclick={toggleWriteMode}
							>{writeMode ? "✓" : " "} Write mode</button
						>
						<div class="menu-sep"></div>
						<div class="menu-label">New notes are saved as</div>
						<button
							class="menu-item check"
							onclick={() => {
								settings.defaultExt = ".md";
								persist("defaultExt", ".md");
							}}>{settings.defaultExt === ".md" ? "✓" : " "} Markdown (.md)</button
						>
						<button
							class="menu-item check"
							onclick={() => {
								settings.defaultExt = ".txt";
								persist("defaultExt", ".txt");
							}}>{settings.defaultExt === ".txt" ? "✓" : " "} Plain text (.txt)</button
						>
						<div class="menu-sep"></div>
						<div class="font-row">
							<span class="menu-label">Font size</span>
							<button class="tb-btn" onclick={() => bumpFont(-1)}>−</button>
							<button class="tb-btn" onclick={resetFont}>{settings.fontSize}</button>
							<button class="tb-btn" onclick={() => bumpFont(1)}>+</button>
						</div>
						<div class="menu-sep"></div>
						<button
							class="menu-item"
							onclick={() => {
								closeMenus();
								modal = "shortcuts";
							}}>Keyboard shortcuts</button
						>
						<button
							class="menu-item"
							onclick={() => {
								closeMenus();
								modal = "about";
							}}>About P.S. Notes.</button
						>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<div class="body">
		<aside class="sidebar" style="width: {settings.paneWidth}px">
			<input
				class="filter"
				type="search"
				placeholder="Search or create…"
				bind:this={filterInput}
				bind:value={filterText}
				onkeydown={onFilterKeydown}
			/>
			<div class="note-list">
				{#if curDir && rootDir && curDir !== rootDir}
					<button class="row folder up" onclick={() => void goUp()}>…</button>
				{/if}
				{#each visibleFolders as f (f)}
					<button class="row folder" onclick={() => void enterFolder(f)}
						><span class="folder-mark">/</span>{f}</button
					>
				{/each}
				{#each displayNotes as n (n.path)}
					<button class="row note" class:selected={n.path === selectedPath} onclick={() => void openNote(n)}>
						{n.title}<span class="ext-tag">{n.ext === ".md" ? "" : n.ext}</span>
					</button>
				{/each}
				{#if curDir && visibleFolders.length === 0 && displayNotes.length === 0}
					<div class="empty-hint">
						{filterText
							? "No matches. Press Enter to create “" + filterText.trim() + "”."
							: "No notes yet. Just start typing."}
					</div>
				{/if}
			</div>
		</aside>

		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div class="divider" role="separator" aria-orientation="vertical" onmousedown={startPaneDrag}></div>

		<div class="editor-wrap" style="font-size: {settings.fontSize}px" bind:this={editorParent}></div>
	</div>

	{#if ready && !curDir}
		<div class="welcome">
			<div class="welcome-box">
				<h1>P.S. Notes.</h1>
				<p>Notes, plain and simple. Your notes are ordinary .md and .txt files in a folder you choose.</p>
				<button class="big-btn" onclick={chooseFolder}>Choose Notes Folder…</button>
			</div>
		</div>
	{/if}

	{#if modal}
		<div
			class="modal-backdrop"
			role="presentation"
			onclick={(e) => {
				if (e.target === e.currentTarget) modal = null;
			}}
		>
			<div class="modal">
				{#if modal === "shortcuts"}
					<h2>Keyboard Shortcuts</h2>
					<table>
						<tbody>
							{#each shortcutRows as [keys, what] (keys)}
								<tr><td class="keys">{keys}</td><td>{what}</td></tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<h2>P.S. Notes.</h2>
					<p>Notes, plain and simple.</p>
					<p>Your notes live as plain text files in your own folders — portable to any app, on any device.</p>
					<p class="dim">by Zach Burnham</p>
				{/if}
				<button class="tb-btn" onclick={() => (modal = null)}>Close</button>
			</div>
		</div>
	{/if}
</main>

<style>
	:global(:root) {
		--bg: #fdfdfc;
		--bg-panel: #f4f3f1;
		--fg: #22221f;
		--fg-dim: #6f6e68;
		--fg-faint: #b3b1a9;
		--accent: #2a7ae2;
		--border: #e2e0db;
		--sel: #cfe3fb;
		--hover: #ebeae6;
		--font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--bg: #1e1e1c;
			--bg-panel: #262624;
			--fg: #e8e6e1;
			--fg-dim: #a3a19a;
			--fg-faint: #62615c;
			--accent: #6aa5ee;
			--border: #383734;
			--sel: #2d4a6d;
			--hover: #32312e;
		}
	}

	:global(html),
	:global(body) {
		margin: 0;
		height: 100%;
		overflow: hidden;
		background: var(--bg);
		color: var(--fg);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
	}

	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	/* --- Toolbar --- */
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-panel);
		user-select: none;
		flex: none;
	}
	.toolbar-group {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.tb-btn {
		font: inherit;
		font-size: 13px;
		color: var(--fg);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
	}
	.tb-btn:hover:not(:disabled) {
		background: var(--hover);
	}
	.tb-btn:disabled {
		color: var(--fg-faint);
		cursor: default;
	}
	.word-count {
		font-size: 12px;
		color: var(--fg-dim);
		font-variant-numeric: tabular-nums;
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 2px;
		overflow: hidden;
		white-space: nowrap;
		font-size: 12px;
		color: var(--fg-dim);
	}
	.crumb {
		font: inherit;
		color: var(--fg-dim);
		background: none;
		border: none;
		border-radius: 4px;
		padding: 2px 6px;
		cursor: pointer;
	}
	.crumb:hover {
		background: var(--hover);
	}
	.crumb.here {
		color: var(--fg);
		font-weight: 600;
	}
	.crumb-sep {
		color: var(--fg-faint);
	}

	/* --- Menus --- */
	.menu-wrap {
		position: relative;
	}
	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 50;
		min-width: 230px;
		max-width: 340px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
		padding: 4px;
	}
	.menu-right {
		left: auto;
		right: 0;
	}
	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		font: inherit;
		font-size: 13px;
		color: var(--fg);
		background: none;
		border: none;
		border-radius: 5px;
		padding: 6px 10px;
		cursor: pointer;
	}
	.menu-item:hover {
		background: var(--hover);
	}
	.menu-item.notebook .nb-name {
		display: block;
		font-weight: 600;
	}
	.menu-item.notebook.current .nb-name {
		color: var(--accent);
	}
	.menu-item.notebook .nb-path {
		display: block;
		font-size: 11px;
		color: var(--fg-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.menu-sep {
		height: 1px;
		background: var(--border);
		margin: 4px 6px;
	}
	.menu-label {
		font-size: 11px;
		color: var(--fg-dim);
		padding: 4px 10px 2px;
	}
	.font-row {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px;
	}
	.font-row .menu-label {
		flex: 1;
		padding: 0 4px;
	}

	/* --- Body / panes --- */
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}
	.sidebar {
		display: flex;
		flex-direction: column;
		flex: none;
		min-width: 150px;
		background: var(--bg-panel);
		border-right: 1px solid var(--border);
	}
	.write-mode .sidebar,
	.write-mode .divider,
	.write-mode .toolbar {
		display: none;
	}
	.write-mode .editor-wrap {
		--editor-max-width: 42em;
	}

	.filter {
		font: inherit;
		font-size: 13px;
		color: var(--fg);
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		margin: 8px;
		padding: 6px 9px;
		outline: none;
	}
	.filter:focus {
		border-color: var(--accent);
	}

	.note-list {
		flex: 1;
		overflow-y: auto;
		padding: 0 4px 8px;
	}
	.row {
		display: block;
		width: 100%;
		text-align: left;
		font: inherit;
		font-size: 13px;
		color: var(--fg);
		background: none;
		border: none;
		border-radius: 5px;
		padding: 5px 9px;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.row:hover {
		background: var(--hover);
	}
	.row.selected {
		background: var(--sel);
	}
	.row.folder {
		color: var(--fg-dim);
		font-style: italic;
	}
	.folder-mark {
		color: var(--fg-faint);
		margin-right: 6px;
		font-style: normal;
	}
	.ext-tag {
		color: var(--fg-faint);
		font-size: 11px;
		margin-left: 6px;
	}
	.empty-hint {
		color: var(--fg-dim);
		font-size: 12px;
		padding: 12px 10px;
		line-height: 1.5;
	}

	.divider {
		flex: none;
		width: 7px;
		margin-left: -4px;
		cursor: col-resize;
		z-index: 10;
	}

	.editor-wrap {
		flex: 1;
		min-width: 0;
		height: 100%;
		overflow: hidden;
	}
	.editor-wrap :global(.cm-editor) {
		height: 100%;
	}

	/* --- Welcome & modals --- */
	.welcome {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--bg);
	}
	.welcome-box {
		text-align: center;
		max-width: 26em;
		padding: 24px;
	}
	.welcome-box h1 {
		font-weight: 700;
	}
	.welcome-box p {
		color: var(--fg-dim);
		line-height: 1.5;
	}
	.big-btn {
		font: inherit;
		font-size: 15px;
		color: #fff;
		background: var(--accent);
		border: none;
		border-radius: 8px;
		padding: 10px 18px;
		cursor: pointer;
		margin-top: 8px;
	}

	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.35);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.modal {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 20px 24px;
		max-width: 30em;
		max-height: 80vh;
		overflow-y: auto;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
	}
	.modal h2 {
		margin-top: 0;
	}
	.modal table {
		border-collapse: collapse;
		font-size: 13px;
		margin-bottom: 14px;
	}
	.modal td {
		padding: 3px 14px 3px 0;
		vertical-align: top;
	}
	.modal .keys {
		font-family: var(--font-mono);
		white-space: nowrap;
		color: var(--fg-dim);
	}
	.modal .dim {
		color: var(--fg-dim);
	}
</style>
