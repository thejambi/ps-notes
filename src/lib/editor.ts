import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	MatchDecorator,
	ViewPlugin,
	keymap,
	placeholder,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/* Live markdown styling: headings scale up, bold is bold, syntax marks dim.
   The document itself stays untouched plain text. */
const mdHighlight = HighlightStyle.define([
	{ tag: tags.heading1, fontSize: "1.55em", fontWeight: "700" },
	{ tag: tags.heading2, fontSize: "1.35em", fontWeight: "700" },
	{ tag: tags.heading3, fontSize: "1.2em", fontWeight: "700" },
	{ tag: tags.heading4, fontSize: "1.08em", fontWeight: "700" },
	{ tag: tags.heading5, fontWeight: "700" },
	{ tag: tags.heading6, fontWeight: "700", color: "var(--fg-dim)" },
	{ tag: tags.strong, fontWeight: "700" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
	{ tag: tags.quote, color: "var(--fg-dim)", fontStyle: "italic" },
	{ tag: tags.link, color: "var(--accent)" },
	// Same accent as .cm-clickable-url so URLs never flip color depending
	// on how the markdown parser tokenized them in a given context
	{ tag: tags.url, color: "var(--accent)" },
	{ tag: tags.processingInstruction, color: "var(--fg-faint)" },
	{ tag: tags.comment, color: "var(--fg-faint)" },
	{ tag: tags.contentSeparator, color: "var(--fg-faint)" },
	{ tag: tags.list, color: "inherit" },
]);

const cmTheme = EditorView.theme({
	"&": {
		height: "100%",
		fontSize: "inherit",
		backgroundColor: "transparent",
		color: "var(--fg)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		fontFamily: "inherit",
		lineHeight: "1.6",
	},
	".cm-content": {
		padding: "18px 0 45vh 0",
		caretColor: "var(--accent)",
		maxWidth: "var(--editor-max-width, none)",
		margin: "0 auto",
	},
	".cm-line": { padding: "0 24px" },
	".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
		backgroundColor: "var(--sel) !important",
	},
	".cm-placeholder": { color: "var(--fg-faint)" },
	".cm-clickable-url": {
		color: "var(--accent)",
		textDecoration: "underline",
		textUnderlineOffset: "2px",
		textDecorationColor: "var(--fg-faint)",
	},
	".cm-title-line": { fontWeight: "700" },
	".cm-tag": { color: "var(--accent)", fontWeight: "500" },
	".cm-wikilink": {
		color: "var(--accent)",
		textDecoration: "underline dotted",
		textUnderlineOffset: "2px",
	},
	"&.cm-mod-down .cm-clickable-url, &.cm-mod-down .cm-tag, &.cm-mod-down .cm-wikilink": {
		cursor: "pointer",
	},
});

/* --- Markdown editing commands (ported from NoteEditor.vala) --- */

/** Wrap the selection in `marker` (e.g. ** or *), or unwrap if already wrapped. */
export function toggleSurround(view: EditorView, marker: string): boolean {
	return toggleSurroundWith(view, marker, marker);
}

/** Wrap the selection in open/close pair (e.g. HTML comment), or unwrap. */
export function toggleSurroundWith(view: EditorView, open: string, close: string): boolean {
	const tr = view.state.changeByRange((range) => {
		const { from, to } = range;
		const doc = view.state.doc;
		const before = doc.sliceString(Math.max(0, from - open.length), from);
		const after = doc.sliceString(to, Math.min(doc.length, to + close.length));
		if (before === open && after === close) {
			return {
				changes: [
					{ from: from - open.length, to: from, insert: "" },
					{ from: to, to: to + close.length, insert: "" },
				],
				range: EditorSelection.range(from - open.length, to - open.length),
			};
		}
		return {
			changes: [
				{ from, insert: open },
				{ from: to, insert: close },
			],
			range: EditorSelection.range(from + open.length, to + open.length),
		};
	});
	view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
	return true;
}

/** Set the current line's markdown heading level (0 removes the heading). */
export function setHeading(view: EditorView, level: number): boolean {
	const tr = view.state.changeByRange((range) => {
		const line = view.state.doc.lineAt(range.head);
		const match = /^(#{0,6})[ \t]*/.exec(line.text) ?? ["", ""];
		const old = match[0];
		const insert = level > 0 ? "#".repeat(level) + " " : "";
		const diff = insert.length - old.length;
		const boundary = line.from + old.length;
		// Cursors within the old marks land right after the new ones, ready
		// to type the heading text; cursors in the text keep their spot.
		const map = (pos: number) =>
			pos < line.from ? pos : pos <= boundary ? line.from + insert.length : pos + diff;
		return {
			changes: { from: line.from, to: boundary, insert },
			range: EditorSelection.range(map(range.anchor), map(range.head)),
		};
	});
	view.dispatch(tr, { userEvent: "input" });
	return true;
}

/** Bump the current line's heading level up or down, clamped to 0..6. */
export function adjustHeading(view: EditorView, delta: number): boolean {
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	const current = (/^(#{0,6})/.exec(line.text) ?? ["", ""])[1].length;
	const level = Math.min(6, Math.max(0, current + delta));
	return setHeading(view, level);
}

/* --- Line-prefix commands: lists, tasks, blockquote --- */

const BULLET_RE = /^(\s*)([-*+])\s+/;
const ORDERED_RE = /^(\s*)(\d+[.)])\s+/;
const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s+/;
const QUOTE_RE = /^(\s*)>\s?/;

/** Every line touched by the selection (deduped, in order). */
function selectedLines(state: EditorState) {
	const lines = [];
	const seen = new Set<number>();
	for (const range of state.selection.ranges) {
		const last = state.doc.lineAt(range.to).number;
		for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
			if (!seen.has(n)) {
				seen.add(n);
				lines.push(state.doc.line(n));
			}
		}
	}
	return lines;
}

interface PrefixChange {
	from: number;
	to: number;
	insert: string;
}

/** Dispatch per-line prefix edits with intuitive cursor mapping: a cursor
    inside a changed prefix lands right after the new prefix (so toggling a
    bullet on an empty line leaves you ready to type), and a cursor in the
    body keeps its place in the text. */
function dispatchPrefixChanges(view: EditorView, changes: PrefixChange[]): boolean {
	if (changes.length === 0) return false;
	const mapPos = (pos: number): number => {
		let delta = 0;
		for (const c of changes) {
			if (pos < c.from) break;
			if (pos <= c.to) return c.from + delta + c.insert.length;
			delta += c.insert.length - (c.to - c.from);
		}
		return pos + delta;
	};
	const sel = EditorSelection.create(
		view.state.selection.ranges.map((r) => EditorSelection.range(mapPos(r.anchor), mapPos(r.head))),
		view.state.selection.mainIndex,
	);
	view.dispatch({ changes, selection: sel, userEvent: "input", scrollIntoView: true });
	return true;
}

/** The marker-prefix region of a line: [after indent, after marker). */
function markerRegion(l: { from: number; text: string }): { from: number; to: number; indent: string } {
	const m = TASK_RE.exec(l.text) ?? BULLET_RE.exec(l.text) ?? ORDERED_RE.exec(l.text);
	const indent = m ? m[1] : (/^\s*/.exec(l.text)?.[0] ?? "");
	return { from: l.from + indent.length, to: l.from + (m ? m[0].length : indent.length), indent };
}

export function toggleList(view: EditorView, kind: "bullet" | "ordered" | "task"): boolean {
	const lines = selectedLines(view.state);
	if (lines.length === 0) return false;
	const has = (t: string) =>
		kind === "bullet"
			? BULLET_RE.test(t) && !TASK_RE.test(t)
			: kind === "ordered"
				? ORDERED_RE.test(t)
				: TASK_RE.test(t);
	const allHave = lines.every((l) => has(l.text));
	let n = 1;
	const changes = lines.map((l) => {
		const region = markerRegion(l);
		let marker: string;
		if (allHave) marker = "";
		else if (kind === "bullet") marker = "- ";
		else if (kind === "ordered") marker = `${n++}. `;
		else marker = "- [ ] ";
		return { from: region.from, to: region.to, insert: marker };
	});
	return dispatchPrefixChanges(view, changes);
}

export function toggleBlockquote(view: EditorView): boolean {
	const lines = selectedLines(view.state);
	if (lines.length === 0) return false;
	const allQuoted = lines.every((l) => QUOTE_RE.test(l.text));
	const changes = lines.map((l) => {
		const q = QUOTE_RE.exec(l.text);
		const indent = q ? q[1] : (/^\s*/.exec(l.text)?.[0] ?? "");
		const from = l.from + indent.length;
		if (allQuoted) return { from, to: l.from + (q?.[0].length ?? indent.length), insert: "" };
		return { from, to: from, insert: "> " };
	});
	return dispatchPrefixChanges(view, changes);
}

/** Toggle [ ] / [x] on task lines; turn plain lines into unchecked tasks. */
export function toggleTaskDone(view: EditorView): boolean {
	const lines = selectedLines(view.state);
	if (lines.length === 0) return false;
	const changes = lines.map((l) => {
		const m = TASK_RE.exec(l.text);
		if (m) {
			// Flip just the checkbox character; nothing else moves
			const done = m[3].toLowerCase() === "x";
			const boxAt = l.from + l.text.indexOf("[", m[1].length + m[2].length) + 1;
			return { from: boxAt, to: boxAt + 1, insert: done ? " " : "x" };
		}
		const region = markerRegion(l);
		return { from: region.from, to: region.to, insert: "- [ ] " };
	});
	return dispatchPrefixChanges(view, changes);
}

/* --- Links and code --- */

/** [selection]() with the cursor in the parens; a selected URL becomes the target. */
export function insertLink(view: EditorView): boolean {
	const tr = view.state.changeByRange((range) => {
		const sel = view.state.sliceDoc(range.from, range.to).trim();
		if (/^https?:\/\/\S+$/.test(sel)) {
			return {
				changes: { from: range.from, to: range.to, insert: `[](${sel})` },
				range: EditorSelection.cursor(range.from + 1),
			};
		}
		return {
			changes: { from: range.from, to: range.to, insert: `[${sel}]()` },
			range: EditorSelection.cursor(range.from + sel.length + 3),
		};
	});
	view.dispatch(tr, { userEvent: "input", scrollIntoView: true });
	return true;
}

/** Wrap the selected lines in a ``` fence (or open an empty one). */
export function insertCodeBlock(view: EditorView): boolean {
	const { state } = view;
	const sel = state.selection.main;
	const first = state.doc.lineAt(sel.from);
	const last = state.doc.lineAt(sel.to);
	const body = state.sliceDoc(first.from, last.to);
	view.dispatch({
		changes: { from: first.from, to: last.to, insert: "```\n" + body + "\n```" },
		selection: EditorSelection.cursor(first.from + 4 + body.length),
		userEvent: "input",
		scrollIntoView: true,
	});
	view.focus();
	return true;
}

/* --- Date / time inserts (OneNote-style chords) --- */

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtTime = (d: Date) => `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}${d.getHours() < 12 ? "am" : "pm"}`;

/** Insert `fmt(now)` plus a trailing space at the cursor (replaces any
    selection), leaving the cursor after the space. */
function makeInserter(fmt: (d: Date) => string) {
	return (view: EditorView): boolean => {
		view.dispatch(view.state.replaceSelection(fmt(new Date()) + " "), {
			scrollIntoView: true,
			userEvent: "input",
		});
		view.focus();
		return true;
	};
}

export const insertDate = makeInserter(fmtDate);
export const insertTime = makeInserter(fmtTime);
export const insertDateTime = makeInserter((d) => `${fmtDate(d)} ${fmtTime(d)}`);

const mdKeymap = [
	{ mac: "Cmd-Shift-d", win: "Alt-Shift-d", linux: "Alt-Shift-d", run: insertDate },
	{ mac: "Cmd-Shift-t", win: "Alt-Shift-t", linux: "Alt-Shift-t", run: insertTime },
	{ mac: "Cmd-Shift-f", win: "Alt-Shift-f", linux: "Alt-Shift-f", run: insertDateTime },
	{ key: "Mod-b", run: (v: EditorView) => toggleSurround(v, "**") },
	{ key: "Mod-i", run: (v: EditorView) => toggleSurround(v, "*") },
	{ key: "Mod-Alt-u", run: (v: EditorView) => toggleSurround(v, "~~") },
	// Mod-K is "add link" nearly everywhere; comments move to the editor-
	// standard Mod-/ (VS Code, Sublime, JetBrains).
	{ key: "Mod-k", run: insertLink },
	{ key: "Mod-Shift-k", run: (v: EditorView) => toggleSurroundWith(v, "[[", "]]") },
	{ key: "Mod-/", run: (v: EditorView) => toggleSurroundWith(v, "<!-- ", " -->") },
	{ key: "Mod-j", run: (v: EditorView) => toggleSurround(v, "`") },
	{ key: "Mod-Shift-j", run: insertCodeBlock },
	{ key: "Mod-l", run: (v: EditorView) => toggleList(v, "bullet") },
	{ key: "Mod-Shift-l", run: (v: EditorView) => toggleList(v, "ordered") },
	{ key: "Mod-Alt-l", run: (v: EditorView) => toggleList(v, "task") },
	{ key: "Mod-Alt-x", run: toggleTaskDone },
	{ key: "Mod-Shift-.", run: toggleBlockquote },
	{ key: "Mod->", run: toggleBlockquote },
	...[1, 2, 3, 4, 5, 6].map((n) => ({
		key: `Mod-${n}`,
		run: (v: EditorView) => setHeading(v, n),
	})),
	{ key: "Mod-\\", run: (v: EditorView) => adjustHeading(v, 1) },
	{ key: "Mod-Shift-\\", run: (v: EditorView) => adjustHeading(v, -1) },
];

/* --- Tab / indent behavior --- */

const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s/;

/** Tab indents list items and multi-line selections; elsewhere it inserts
    a tab character. Never moves focus out of the editor. */
function smartTab(view: EditorView): boolean {
	const { state } = view;
	const sel = state.selection.main;
	const line = state.doc.lineAt(sel.head);
	if (!sel.empty || LIST_ITEM_RE.test(line.text)) {
		return indentMore(view);
	}
	view.dispatch(state.replaceSelection(state.facet(indentUnit)), {
		scrollIntoView: true,
		userEvent: "input",
	});
	return true;
}

const indentKeymap = [
	{ key: "Tab", run: smartTab, shift: indentLess },
	{ key: "Mod-]", run: indentMore },
	{ key: "Mod-[", run: indentLess },
];

/* --- Clickable URLs (Cmd/Ctrl+click to open; plain click just edits) --- */

const isMacUA = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
// URLs end on a non-punctuation char so a trailing "." or ")" isn't swallowed
const URL_REGEX = /https?:\/\/[^\s<>()"']*[^\s<>()"'.,;:!?]/g;

const urlMatcher = new MatchDecorator({
	regexp: URL_REGEX,
	decoration: Decoration.mark({
		class: "cm-clickable-url",
		attributes: { title: (isMacUA ? "⌘" : "Ctrl+") + "click to open" },
	}),
});

const urlHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = urlMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.decorations = urlMatcher.updateDeco(update, this.decorations);
		}
	},
	{ decorations: (v) => v.decorations },
);

/* --- Tags: #likeThis, Cmd/Ctrl+click to search for the tag --- */

// A letter must follow the # (so "# Heading" and "## marks" never match),
// and the # must start the line or follow whitespace (so URL #fragments don't).
const TAG_REGEX = /(?<=^|\s)#[A-Za-z][A-Za-z0-9_-]*/g;

const tagMatcher = new MatchDecorator({
	regexp: TAG_REGEX,
	decoration: Decoration.mark({
		class: "cm-tag",
		attributes: { title: (isMacUA ? "⌘" : "Ctrl+") + "click to search this tag" },
	}),
});

const tagHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = tagMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.decorations = tagMatcher.updateDeco(update, this.decorations);
		}
	},
	{ decorations: (v) => v.decorations },
);

/* --- Wiki links: [[another page title]], Cmd/Ctrl+click to search it --- */

const WIKILINK_REGEX = /\[\[[^\[\]\n]+\]\]/g;

const wikiMatcher = new MatchDecorator({
	regexp: WIKILINK_REGEX,
	decoration: Decoration.mark({
		class: "cm-wikilink",
		attributes: { title: (isMacUA ? "⌘" : "Ctrl+") + "click to search this title" },
	}),
});

const wikiHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = wikiMatcher.createDeco(view);
		}
		update(update: ViewUpdate) {
			this.decorations = wikiMatcher.updateDeco(update, this.decorations);
		}
	},
	{ decorations: (v) => v.decorations },
);

/* Show the pointer hand over clickables while the mod key is held */
const modKeyCursor = ViewPlugin.fromClass(
	class {
		private setDown: (e: KeyboardEvent) => void;
		private setUp: (e: KeyboardEvent) => void;
		private clear: () => void;
		constructor(view: EditorView) {
			const modKey = isMacUA ? "Meta" : "Control";
			this.setDown = (e) => {
				if (e.key === modKey) view.dom.classList.add("cm-mod-down");
			};
			this.setUp = (e) => {
				if (e.key === modKey) view.dom.classList.remove("cm-mod-down");
			};
			this.clear = () => view.dom.classList.remove("cm-mod-down");
			window.addEventListener("keydown", this.setDown);
			window.addEventListener("keyup", this.setUp);
			window.addEventListener("blur", this.clear);
		}
		destroy() {
			window.removeEventListener("keydown", this.setDown);
			window.removeEventListener("keyup", this.setUp);
			window.removeEventListener("blur", this.clear);
		}
	},
);

function matchAt(lineText: string, lineFrom: number, pos: number, regex: RegExp): string | null {
	const re = new RegExp(regex.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(lineText))) {
		const from = lineFrom + m.index;
		if (pos >= from && pos <= from + m[0].length) return m[0];
	}
	return null;
}

function makeClickHandler(onTagClick?: (tag: string) => void) {
	return EditorView.domEventHandlers({
		mousedown(e, view) {
			const mod = isMacUA ? e.metaKey : e.ctrlKey;
			if (!mod || e.button !== 0) return false;
			const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
			if (pos == null) return false;
			const line = view.state.doc.lineAt(pos);
			const url = matchAt(line.text, line.from, pos, URL_REGEX);
			if (url) {
				e.preventDefault();
				void openUrl(url);
				return true;
			}
			if (onTagClick) {
				const wiki = matchAt(line.text, line.from, pos, WIKILINK_REGEX);
				if (wiki) {
					e.preventDefault();
					onTagClick(wiki.slice(2, -2).trim());
					return true;
				}
				const tag = matchAt(line.text, line.from, pos, TAG_REGEX);
				if (tag) {
					e.preventDefault();
					onTagClick(tag);
					return true;
				}
			}
			return false;
		},
	});
}

/* --- Bold first line (the note's title) --- */

function firstLineDeco(view: EditorView): DecorationSet {
	return Decoration.set([Decoration.line({ class: "cm-title-line" }).range(view.state.doc.line(1).from)]);
}

const titleLineHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = firstLineDeco(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged) this.decorations = firstLineDeco(update.view);
		}
	},
	{ decorations: (v) => v.decorations },
);

export function buildExtensions(onDocChanged: () => void, onTagClick?: (tag: string) => void): Extension[] {
	return [
		history(),
		markdown({ base: markdownLanguage }),
		syntaxHighlighting(mdHighlight),
		EditorView.lineWrapping,
		cmTheme,
		indentUnit.of("\t"),
		urlHighlighter,
		tagHighlighter,
		wikiHighlighter,
		modKeyCursor,
		makeClickHandler(onTagClick),
		titleLineHighlighter,
		placeholder("Start writing. The first line becomes the note's title…"),
		keymap.of([...indentKeymap, ...mdKeymap, ...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) onDocChanged();
		}),
	];
}

export function createEditor(parent: HTMLElement, extensions: Extension[]): EditorView {
	return new EditorView({
		state: EditorState.create({ doc: "", extensions }),
		parent,
	});
}

/** Replace the document and reset undo history (used when switching notes). */
export function setDocument(view: EditorView, extensions: Extension[], text: string): void {
	view.setState(EditorState.create({ doc: text, extensions }));
}

export function countWords(text: string): number {
	const words = text.match(/\S+/g);
	return words ? words.length : 0;
}
