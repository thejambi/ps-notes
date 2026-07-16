/**
 * Markdown -> HTML for the in-app rendered view, powered by marked
 * (CommonMark + GFM: tables, task lists, strikethrough, the works).
 *
 * Two P.S. Notes extensions render #tags and [[wiki links]] as clickable
 * search chips, and raw HTML in notes is escaped rather than injected —
 * the output goes into {@html} inside a privileged webview, so note
 * content must never become live markup.
 */
import { Marked, type Tokens, type TokenizerAndRendererExtension } from "marked";

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const wikiLinkExt: TokenizerAndRendererExtension = {
	name: "wikilink",
	level: "inline",
	start(src: string) {
		return src.indexOf("[[");
	},
	tokenizer(src: string) {
		const m = /^\[\[([^\[\]\n]+)\]\]/.exec(src);
		if (!m) return undefined;
		return { type: "wikilink", raw: m[0], search: m[1].trim() };
	},
	renderer(token) {
		return `<span class="pv-wiki" data-search="${esc(token.search)}">${esc(token.search)}</span>`;
	},
};

const noteTagExt: TokenizerAndRendererExtension = {
	name: "notetag",
	level: "inline",
	start(src: string) {
		return src.search(/#[A-Za-z]/);
	},
	tokenizer(src: string, tokens) {
		const m = /^#[A-Za-z][A-Za-z0-9_-]*/.exec(src);
		if (!m) return undefined;
		// Only at start or after whitespace (never mid-word)
		const prev = tokens[tokens.length - 1];
		if (prev && typeof prev.raw === "string" && prev.raw !== "" && !/\s$/.test(prev.raw)) {
			return undefined;
		}
		return { type: "notetag", raw: m[0], search: m[0] };
	},
	renderer(token) {
		return `<span class="pv-tag" data-search="${esc(token.search)}">${esc(token.search)}</span>`;
	},
};

const md = new Marked({ gfm: true, breaks: true });

md.use({
	renderer: {
		// Show raw HTML literally instead of injecting it
		html(token: Tokens.HTML | Tokens.Tag): string {
			return esc(token.raw);
		},
	},
	extensions: [wikiLinkExt, noteTagExt],
});

export function mdToHtml(src: string): string {
	return md.parse(src) as string;
}
