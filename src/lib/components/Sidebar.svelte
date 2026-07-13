<script lang="ts">
	import { app, refs, RENDER_CHUNK, openNote, newNote, goUp, enterFolder, inChapter } from "$lib/app.svelte";

	const visibleFolders = $derived.by(() => {
		const q = app.filterText.trim().toLowerCase();
		if (!q) return app.listing.folders;
		return app.listing.folders.filter((f) => f.toLowerCase().includes(q));
	});

	function onFilterKeydown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			const q = app.filterText.trim();
			if (app.displayNotes.length > 0) {
				void openNote(app.displayNotes[0]);
			} else if (q !== "" && app.curDir) {
				// No match: create a note titled with the search text (NV style)
				app.filterText = "";
				void newNote(q);
			}
		} else if (e.key === "ArrowDown" && app.displayNotes.length > 0) {
			e.preventDefault();
			void openNote(app.displayNotes[0]);
		}
	}

	// Render more rows as the list is scrolled toward the bottom
	function onListScroll(e: Event): void {
		if (app.renderLimit >= app.displayNotes.length) return;
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) {
			app.renderLimit += RENDER_CHUNK;
		}
	}
</script>

<aside class="sidebar" style="width: {app.settings.paneWidth}px">
	<input
		class="filter"
		type="search"
		placeholder="Search or create…"
		bind:this={refs.filterInput}
		bind:value={app.filterText}
		onkeydown={onFilterKeydown}
	/>
	<div class="note-list" onscroll={onListScroll}>
		{#if app.curDir && app.rootDir && app.curDir !== app.rootDir}
			<button
				class="row folder up"
				title={inChapter() ? "Back to book (compiles this chapter)" : "Up"}
				onclick={() => void goUp()}>{inChapter() ? "# …" : "…"}</button
			>
		{/if}
		{#each visibleFolders as f (f)}
			<button class="row folder" onclick={() => void enterFolder(f)}
				><span class="folder-mark">{app.curDir === app.bookRoot ? "#" : "/"}</span>{f}</button
			>
		{/each}
		{#each app.displayNotes.slice(0, app.renderLimit) as n (n.path)}
			<button
				class="row note"
				class:selected={n.path === app.selectedPath}
				data-path={n.path}
				onclick={() => void openNote(n)}
			>
				{n.title}<span class="ext-tag">{n.ext === ".md" ? "" : n.ext}</span>
			</button>
		{/each}
		{#if app.displayNotes.length > app.renderLimit}
			<div class="empty-hint">…{app.displayNotes.length - app.renderLimit} more</div>
		{/if}
		{#if app.curDir && visibleFolders.length === 0 && app.displayNotes.length === 0}
			<div class="empty-hint">
				{app.filterText
					? "No matches. Press Enter to create “" + app.filterText.trim() + "”."
					: "No notes yet. Just start typing."}
			</div>
		{/if}
	</div>
</aside>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		flex: none;
		min-width: 150px;
		background: var(--bg-panel);
		border-right: 1px solid var(--border);
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
</style>
