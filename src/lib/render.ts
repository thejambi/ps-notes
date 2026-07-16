/**
 * Markdown -> HTML for the in-app rendered view. Prose-focused:
 * headings, nested lists, blockquotes, rules, bold/italic/code, links
 * (intercepted by the view component), plus P.S. Notes' own #tags and
 * [[wiki links]] rendered as clickable search chips.
 */

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(s: string): string {
	const stash: string[] = [];
	const keep = (html: string) => {
		stash.push(html);
		return `\x00${stash.length - 1}\x00`;
	};
	let out = escapeHtml(s);
	out = out.replace(/\[\[([^\[\]\n]+)\]\]/g, (_, t: string) =>
		keep(`<span class="pv-wiki" data-search="${escapeHtml(t.trim())}">${escapeHtml(t)}</span>`),
	);
	out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) =>
		keep(`<a href="${u}">${t}</a>`),
	);
	out = out.replace(/https?:\/\/[^\s<>()"']*[^\s<>()"'.,;:!?]/g, (u) => keep(`<a href="${u}">${u}</a>`));
	out = out.replace(/(^|\s)(#[A-Za-z][A-Za-z0-9_-]*)/g, (_, pre: string, tag: string) =>
		pre + keep(`<span class="pv-tag" data-search="${tag}">${tag}</span>`),
	);
	out = out
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
	return out.replace(/\x00(\d+)\x00/g, (_, i: string) => stash[+i]);
}

interface ListItem {
	depth: number;
	ordered: boolean;
	text: string;
}

function renderList(items: ListItem[]): string {
	let html = "";
	const stack: string[] = [];
	for (const it of items) {
		while (stack.length - 1 < it.depth) {
			const tag = it.ordered ? "ol" : "ul";
			html += `<${tag}>`;
			stack.push(tag);
		}
		while (stack.length - 1 > it.depth) html += `</${stack.pop()}>`;
		html += `<li>${inlineMd(it.text)}</li>`;
	}
	while (stack.length > 0) html += `</${stack.pop()}>`;
	return html + "\n";
}

const LI_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function mdToHtml(md: string): string {
	const lines = md.split("\n");
	let html = "";
	let i = 0;
	let para: string[] = [];
	const flushPara = () => {
		if (para.length > 0) {
			html += `<p>${para.map(inlineMd).join("<br/>")}</p>\n`;
			para = [];
		}
	};
	while (i < lines.length) {
		const line = lines[i];
		const t = line.trim();
		if (t === "") {
			flushPara();
			i++;
			continue;
		}
		if (t.startsWith("```")) {
			// Fenced code block: verbatim, whitespace preserved exactly
			flushPara();
			i++;
			const code: string[] = [];
			while (i < lines.length && !lines[i].trim().startsWith("```")) {
				code.push(lines[i]);
				i++;
			}
			i++; // skip the closing fence
			html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>\n`;
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(t);
		if (h) {
			flushPara();
			const level = h[1].length;
			html += `<h${level}>${inlineMd(h[2])}</h${level}>\n`;
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
			flushPara();
			html += "<hr/>\n";
			i++;
			continue;
		}
		if (t.startsWith(">")) {
			flushPara();
			const quote: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith(">")) {
				quote.push(lines[i].trim().replace(/^>\s?/, ""));
				i++;
			}
			html += `<blockquote>\n${mdToHtml(quote.join("\n"))}</blockquote>\n`;
			continue;
		}
		if (LI_RE.test(line)) {
			flushPara();
			const items: ListItem[] = [];
			let m: RegExpExecArray | null;
			while (i < lines.length && (m = LI_RE.exec(lines[i]))) {
				const indent = m[1].replace(/\t/g, "  ").length;
				items.push({ depth: Math.floor(indent / 2), ordered: /^\d/.test(m[2]), text: m[3] });
				i++;
			}
			html += renderList(items);
			continue;
		}
		para.push(t);
		i++;
	}
	flushPara();
	return html;
}
