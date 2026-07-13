<script lang="ts">
	import { onMount } from "svelte";
	import Toolbar from "$lib/components/Toolbar.svelte";
	import Sidebar from "$lib/components/Sidebar.svelte";
	import Overlays from "$lib/components/Overlays.svelte";
	import { persist } from "$lib/settings";
	import { sortNotes, searchNoteContents } from "$lib/notes";
	import {
		app,
		refs,
		isMac,
		RENDER_CHUNK,
		initApp,
		flushSave,
		newNote,
		chooseFolder,
		openNote,
		focusEditor,
		focusFilter,
		isFilterFocused,
		closeMenus,
		setWriteMode,
		toggleWriteMode,
		bumpFont,
		resetFont,
		showEditContextMenu,
		showNoteContextMenu,
	} from "$lib/app.svelte";

	let editorParent: HTMLElement;

	onMount(() => initApp(editorParent));

	const editorStyle = $derived(
		`font-size: ${app.settings.fontSize}px;` +
			(app.writeMode && app.writeModeWidth !== null ? ` --editor-max-width: ${app.writeModeWidth}px;` : ""),
	);

	// Apply the theme choice; "system" defers to prefers-color-scheme
	$effect(() => {
		if (app.settings.theme === "system") {
			delete document.documentElement.dataset.theme;
		} else {
			document.documentElement.dataset.theme = app.settings.theme;
		}
	});

	// Filter notes: title matches show instantly; full-text matches (searched
	// in Rust) are appended after a short debounce.
	const SEARCH_DEBOUNCE_MS = 250;
	let searchGen = 0;
	$effect(() => {
		const q = app.filterText.trim().toLowerCase();
		const notes = sortNotes(app.listing.notes, app.settings.sortByModified);
		const gen = ++searchGen;
		app.renderLimit = RENDER_CHUNK;
		if (!q) {
			app.displayNotes = notes;
			return;
		}
		const titleMatches = notes.filter((n) => n.title.toLowerCase().includes(q));
		app.displayNotes = titleMatches;
		const dir = app.curDir;
		if (!dir || q.length < 2) return;
		const timer = setTimeout(async () => {
			try {
				const hits = await searchNoteContents(dir, q);
				if (gen !== searchGen) return;
				const titleSet = new Set(titleMatches.map((n) => n.path));
				const bodyMatches = notes.filter((n) => hits.has(n.path) && !titleSet.has(n.path));
				if (bodyMatches.length > 0) {
					app.displayNotes = [...titleMatches, ...bodyMatches];
				}
			} catch (e) {
				console.error("content search failed", e);
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	function onWindowMousedown(e: MouseEvent): void {
		const el = e.target as Element | null;
		if (!el?.closest(".menu-wrap")) closeMenus();
	}

	function onContextMenu(e: MouseEvent): void {
		e.preventDefault(); // never show the webview's browser menu
		const el = e.target as Element | null;
		const row = el?.closest(".row.note") as HTMLElement | null;
		if (row?.dataset.path) {
			const n = app.displayNotes.find((x) => x.path === row.dataset.path);
			if (n) void showNoteContextMenu(n);
			return;
		}
		if (el?.closest(".cm-editor") || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			void showEditContextMenu();
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		const modKey = isMac ? e.metaKey : e.ctrlKey;
		const key = e.key.toLowerCase();

		if (e.key === "Escape") {
			if (app.modal) {
				app.modal = null;
			} else if (app.openMenuShown || app.settingsMenuShown) {
				closeMenus();
			} else if (app.writeMode) {
				setWriteMode(false);
			} else if (isFilterFocused()) {
				if (app.filterText !== "") app.filterText = "";
				else focusEditor();
			} else {
				focusFilter();
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
				focusFilter();
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

	// --- Pane divider drag ---
	function startPaneDrag(e: MouseEvent): void {
		e.preventDefault();
		const onMove = (ev: MouseEvent) => {
			app.settings.paneWidth = Math.min(480, Math.max(150, ev.clientX));
		};
		const onUp = () => {
			persist("paneWidth", app.settings.paneWidth);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	}
</script>

<svelte:window onkeydown={onKeydown} onmousedown={onWindowMousedown} oncontextmenu={onContextMenu} />

<main class="app" class:write-mode={app.writeMode}>
	{#if !app.writeMode}
		<Toolbar />
	{/if}

	<div class="body">
		{#if !app.writeMode}
			<Sidebar />
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="divider" role="separator" aria-orientation="vertical" onmousedown={startPaneDrag}></div>
		{/if}

		<div class="editor-wrap" style={editorStyle} bind:this={editorParent}></div>
	</div>

	<Overlays />
</main>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
	}

	.body {
		display: flex;
		flex: 1;
		min-height: 0;
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
</style>
