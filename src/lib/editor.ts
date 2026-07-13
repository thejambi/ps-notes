import { EditorState, EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
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
	{ tag: tags.url, color: "var(--fg-faint)" },
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
		const map = (pos: number) =>
			pos <= line.from ? pos : Math.max(line.from, Math.min(pos + diff, view.state.doc.length + diff));
		return {
			changes: { from: line.from, to: line.from + old.length, insert },
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

const mdKeymap = [
	{ key: "Mod-b", run: (v: EditorView) => toggleSurround(v, "**") },
	{ key: "Mod-i", run: (v: EditorView) => toggleSurround(v, "*") },
	{ key: "Mod-k", run: (v: EditorView) => toggleSurroundWith(v, "<!-- ", " -->") },
	...[1, 2, 3, 4, 5, 6].map((n) => ({
		key: `Mod-${n}`,
		run: (v: EditorView) => setHeading(v, n),
	})),
	{ key: "Mod-\\", run: (v: EditorView) => adjustHeading(v, 1) },
	{ key: "Mod-Shift-\\", run: (v: EditorView) => adjustHeading(v, -1) },
];

export function buildExtensions(onDocChanged: () => void): Extension[] {
	return [
		history(),
		markdown({ base: markdownLanguage }),
		syntaxHighlighting(mdHighlight),
		EditorView.lineWrapping,
		cmTheme,
		placeholder("Start writing. The first line becomes the note's title…"),
		keymap.of([...mdKeymap, ...defaultKeymap, ...historyKeymap]),
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
