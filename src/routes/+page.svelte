<script lang="ts">
	import { onMount } from "svelte";
	import { openUrl } from "@tauri-apps/plugin-opener";
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
		setViewMode,
		toggleViewMode,
		searchFor,
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
			} else if (app.viewMode) {
				setViewMode(false);
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
			} else if (key === "v") {
				e.preventDefault();
				toggleViewMode();
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

		<div class="editor-wrap" style={editorStyle}>
			<div class="cm-host" class:hidden={app.viewMode} bind:this={editorParent}></div>
			{#if app.viewMode}
				<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
				<div
					class="preview"
					onclick={(e) => {
						const el = e.target as Element | null;
						const a = el?.closest("a");
						if (a) {
							e.preventDefault();
							void openUrl(a.getAttribute("href") ?? "");
							return;
						}
						const chip = el?.closest("[data-search]") as HTMLElement | null;
						if (chip?.dataset.search) {
							setViewMode(false);
							searchFor(chip.dataset.search);
						}
					}}
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -->
					{@html app.viewHtml}
				</div>
			{/if}
		</div>
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
	.cm-host {
		height: 100%;
	}
	.cm-host.hidden {
		display: none;
	}
	.editor-wrap :global(.cm-editor) {
		height: 100%;
	}

	/* --- Rendered markdown view --- */
	.preview {
		height: 100%;
		overflow-y: auto;
		padding: 18px 24px 45vh;
		line-height: 1.6;
		max-width: var(--editor-max-width, none);
		margin: 0 auto;
		box-sizing: border-box;
	}
	.preview :global(h1) {
		font-size: 1.55em;
		margin: 0.6em 0 0.4em;
	}
	.preview :global(h2) {
		font-size: 1.35em;
		margin: 0.8em 0 0.4em;
	}
	.preview :global(h3) {
		font-size: 1.2em;
		margin: 0.8em 0 0.4em;
	}
	.preview :global(h4),
	.preview :global(h5),
	.preview :global(h6) {
		font-size: 1.05em;
		margin: 0.8em 0 0.4em;
	}
	.preview :global(p) {
		margin: 0 0 0.8em;
	}
	.preview :global(ul),
	.preview :global(ol) {
		margin: 0 0 0.8em;
		padding-left: 1.7em;
	}
	.preview :global(blockquote) {
		margin: 0 0 0.8em;
		padding: 0.1em 0 0.1em 1em;
		border-left: 3px solid var(--border);
		color: var(--fg-dim);
	}
	.preview :global(code) {
		font-family: var(--font-mono);
		font-size: 0.88em;
		background: var(--bg-panel);
		padding: 0 4px;
		border-radius: 3px;
	}
	.preview :global(pre) {
		background: var(--bg-panel);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px 14px;
		margin: 0 0 0.8em;
		overflow-x: auto;
		line-height: 1.45;
	}
	.preview :global(pre code) {
		background: none;
		border: none;
		padding: 0;
		font-size: 0.85em;
		white-space: pre;
	}
	.preview :global(table) {
		border-collapse: collapse;
		margin: 0 0 0.8em;
	}
	.preview :global(th),
	.preview :global(td) {
		border: 1px solid var(--border);
		padding: 4px 10px;
	}
	.preview :global(th) {
		background: var(--bg-panel);
	}
	.preview :global(input[type="checkbox"]) {
		margin-right: 6px;
		accent-color: var(--accent);
	}
	.preview :global(del) {
		color: var(--fg-dim);
	}
	.preview :global(img) {
		max-width: 100%;
	}
	.preview :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.2em 0;
	}
	.preview :global(a) {
		color: var(--accent);
		cursor: pointer;
	}
	.preview :global(.pv-tag),
	.preview :global(.pv-wiki) {
		color: var(--accent);
		cursor: pointer;
	}
	.preview :global(.pv-wiki) {
		text-decoration: underline dotted;
		text-underline-offset: 2px;
	}
</style>
