<script lang="ts">
	import { revealItemInDir } from "@tauri-apps/plugin-opener";
	import { baseName, pathJoin, isWithin } from "$lib/paths";
	import { persist } from "$lib/settings";
	import {
		app,
		modKeyLabel,
		chooseFolder,
		setNotesDir,
		forgetCurrentNotebook,
		closeMenus,
		newNote,
		archiveCurrent,
		toggleWriteMode,
		bumpFont,
		resetFont,
	} from "$lib/app.svelte";

	const crumbs = $derived.by(() => {
		if (!app.curDir || !app.rootDir) return [];
		const parts: { label: string; path: string }[] = [{ label: baseName(app.rootDir), path: app.rootDir }];
		if (app.curDir !== app.rootDir && isWithin(app.rootDir, app.curDir)) {
			const rel = app.curDir
				.slice(app.rootDir.length)
				.split(/[\\/]/)
				.filter((p) => p !== "");
			let acc = app.rootDir;
			for (const seg of rel) {
				acc = pathJoin(acc, seg);
				parts.push({ label: seg, path: acc });
			}
		}
		return parts;
	});
</script>

<div class="toolbar">
	<div class="toolbar-group">
		<div class="menu-wrap">
			<button
				class="tb-btn"
				title="Change notes folder ({modKeyLabel}O)"
				onclick={() => {
					app.settingsMenuShown = false;
					app.openMenuShown = !app.openMenuShown;
				}}>Open ▾</button
			>
			{#if app.openMenuShown}
				<div class="menu">
					<button class="menu-item" onclick={chooseFolder}>Choose notes folder…</button>
					{#if app.settings.notebooks.length > 0}
						<div class="menu-sep"></div>
						{#each app.settings.notebooks as nb (nb)}
							<button
								class="menu-item notebook"
								class:current={nb === app.rootDir}
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
					{#if app.curDir}
						<div class="menu-sep"></div>
						<button class="menu-item" onclick={forgetCurrentNotebook}>Forget current notebook</button>
						<button
							class="menu-item"
							onclick={() => {
								closeMenus();
								if (app.curDir) void revealItemInDir(app.curDir);
							}}>Show notebook files</button
						>
					{/if}
				</div>
			{/if}
		</div>
		<button class="tb-btn" title="New note ({modKeyLabel}N)" onclick={() => void newNote()} disabled={!app.curDir}
			>New</button
		>
		<button class="tb-btn" title="Archive note" onclick={() => void archiveCurrent()} disabled={!app.selectedPath}
			>Archive</button
		>
	</div>

	<div class="crumbs">
		{#each crumbs as c, i (c.path)}
			{#if i > 0}<span class="crumb-sep">/</span>{/if}
			<button
				class="crumb"
				class:here={c.path === app.curDir}
				onclick={() => void setNotesDir(c.path, c.path === app.rootDir)}>{c.label}</button
			>
		{/each}
	</div>

	<div class="toolbar-group">
		{#if app.settings.showWordCount}
			<span class="word-count">{app.wordCount} {app.wordCount === 1 ? "word" : "words"}</span>
		{/if}
		<div class="menu-wrap">
			<button
				class="tb-btn"
				title="Settings"
				onclick={() => {
					app.openMenuShown = false;
					app.settingsMenuShown = !app.settingsMenuShown;
				}}>Aa ▾</button
			>
			{#if app.settingsMenuShown}
				<div class="menu menu-right">
					<button
						class="menu-item check"
						onclick={() => {
							app.settings.sortByModified = !app.settings.sortByModified;
							persist("sortByModified", app.settings.sortByModified);
						}}>{app.settings.sortByModified ? "✓" : " "} Sort by recently modified</button
					>
					<button
						class="menu-item check"
						onclick={() => {
							app.settings.showWordCount = !app.settings.showWordCount;
							persist("showWordCount", app.settings.showWordCount);
						}}>{app.settings.showWordCount ? "✓" : " "} Show word count</button
					>
					<button class="menu-item check" onclick={toggleWriteMode}>{app.writeMode ? "✓" : " "} Write mode</button>
					<div class="menu-sep"></div>
					<div class="menu-label">Appearance</div>
					{#each ["system", "light", "dark"] as const as t (t)}
						<button
							class="menu-item check"
							onclick={() => {
								app.settings.theme = t;
								persist("theme", t);
							}}>{app.settings.theme === t ? "✓" : " "} {t[0].toUpperCase() + t.slice(1)}</button
						>
					{/each}
					<div class="menu-sep"></div>
					<div class="menu-label">New notes are saved as</div>
					<button
						class="menu-item check"
						onclick={() => {
							app.settings.defaultExt = ".md";
							persist("defaultExt", ".md");
						}}>{app.settings.defaultExt === ".md" ? "✓" : " "} Markdown (.md)</button
					>
					<button
						class="menu-item check"
						onclick={() => {
							app.settings.defaultExt = ".txt";
							persist("defaultExt", ".txt");
						}}>{app.settings.defaultExt === ".txt" ? "✓" : " "} Plain text (.txt)</button
					>
					<div class="menu-sep"></div>
					<div class="font-row">
						<span class="menu-label">Font size</span>
						<button class="tb-btn" onclick={() => bumpFont(-1)}>−</button>
						<button class="tb-btn" onclick={resetFont}>{app.settings.fontSize}</button>
						<button class="tb-btn" onclick={() => bumpFont(1)}>+</button>
					</div>
					<div class="menu-sep"></div>
					<button
						class="menu-item"
						onclick={() => {
							closeMenus();
							app.modal = "shortcuts";
						}}>Keyboard shortcuts</button
					>
					<button
						class="menu-item"
						onclick={() => {
							closeMenus();
							app.modal = "about";
						}}>About P.S. Notes.</button
					>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
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
</style>
