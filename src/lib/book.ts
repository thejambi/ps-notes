/**
 * The book-writing feature, ported faithfully from the original P.S. Notes:
 *
 * - A folder is a *book* when it contains `title.txt` starting with `---`
 *   (a small metadata block: title / author lines).
 * - Subfolders of the book root are *chapters*; the notes inside are
 *   *scenes*, compiled in filename order.
 * - Leaving a chapter compiles it: scenes are joined, HTML comments
 *   (<!-- writer's notes -->) are stripped, the first scene heading is
 *   dropped and later ones become scene separators, and the result is
 *   saved as "Chapter NN" in the book root.
 * - Compiling the book turns title + chapters into an .epub (pure JS —
 *   no pandoc needed), with cover.jpg as the cover when present.
 */
import JSZip from "jszip";
import { exists, readFile, readTextFile, writeFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { baseName, pathJoin } from "./paths";
import { listDir, sortNotes, type NoteInfo } from "./notes";

export const BOOK_MAGIC_FILENAME = "title.txt";
export const SCENE_SEPARATOR = "÷÷÷§÷÷÷";

/** Does this listing's folder look like a book root? (has a title.txt starting with ---) */
export async function detectBookRoot(dir: string, noteTitles: string[]): Promise<boolean> {
	if (!noteTitles.includes("title")) return false;
	try {
		const text = await readTextFile(pathJoin(dir, BOOK_MAGIC_FILENAME));
		return text.startsWith("---");
	} catch {
		return false;
	}
}

function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "");
}

/** "01 - The Beginning" -> "Chapter 01"; "# Foo" -> "Foo"; otherwise as-is. */
export function chapterTitleFor(folderName: string): string {
	let title = folderName;
	if (title.startsWith("#")) title = title.replace(/#/g, "").trim();
	if (title.includes("-")) {
		const num = title.slice(0, title.indexOf("-")).trim();
		title = "Chapter " + num;
	}
	return title;
}

/**
 * Compile a chapter folder's scenes into one markdown text titled
 * "# <Chapter Title>", with scene headings converted to separators.
 */
export async function compileChapterText(chapterDir: string): Promise<{ title: string; text: string }> {
	const listing = await listDir(chapterDir);
	const scenes = sortNotes(listing.notes, false); // filename order

	let body = "";
	for (const scene of scenes) {
		let text = "";
		try {
			text = await readTextFile(scene.path);
		} catch {
			continue;
		}
		body += stripHtmlComments(text).trim() + "\n\n";
	}

	const title = chapterTitleFor(baseName(chapterDir));
	let compiled = ("# " + title + "\n" + body).trim().replace(/\n# /g, "\n## ");

	// Drop the first scene heading; turn the rest into scene separators
	let first = true;
	let idx: number;
	while ((idx = compiled.indexOf("\n## ")) !== -1) {
		const end = compiled.indexOf("\n", idx + 1);
		const lineEnd = end === -1 ? compiled.length : end;
		const replacement = first ? "" : "\n\n" + SCENE_SEPARATOR + "\n";
		compiled = compiled.slice(0, idx) + replacement + compiled.slice(lineEnd);
		first = false;
	}
	return { title, text: compiled };
}

/** Save a compiled chapter into the book root (overwrites the previous compile). */
export async function saveCompiledChapter(bookRoot: string, title: string, text: string, ext: string): Promise<void> {
	await invoke("save_note", { path: pathJoin(bookRoot, title + ext), contents: text });
}

/* ---------------- ePub generation (pure JS, replaces pandoc) ---------------- */

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown -> XHTML for prose: bold, italics, code. */
function inlineMd(s: string): string {
	return esc(s)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/_([^_]+)_/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Tiny prose-focused markdown -> valid XHTML (headings, paragraphs, quotes, separators). */
export function proseMdToXhtml(md: string): string {
	const blocks = md.split(/\n{2,}/);
	let out = "";
	for (const block of blocks) {
		const b = block.trim();
		if (b === "") continue;
		if (b === SCENE_SEPARATOR || b === "* * *" || b === "***" || b === "---") {
			out += `<p class="scene-sep">* * *</p>\n`;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(b);
		if (heading && !b.includes("\n")) {
			const level = Math.min(heading[1].length, 6);
			out += `<h${level}>${inlineMd(heading[2])}</h${level}>\n`;
			continue;
		}
		if (b.startsWith(">")) {
			const quote = b
				.split("\n")
				.map((l) => l.replace(/^>\s?/, ""))
				.join("\n");
			out += `<blockquote>${proseMdToXhtml(quote)}</blockquote>\n`;
			continue;
		}
		out += `<p>${b.split("\n").map(inlineMd).join("<br />")}</p>\n`;
	}
	return out;
}

function xhtmlDoc(title: string, bodyHtml: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${bodyHtml}</body>
</html>
`;
}

const EPUB_CSS = `body { font-family: serif; line-height: 1.5; margin: 1em; }
h1 { text-align: center; margin: 2em 0 1.5em; }
p { text-indent: 1.4em; margin: 0; }
h1 + p, p.scene-sep + p, blockquote + p { text-indent: 0; }
p.scene-sep { text-align: center; text-indent: 0; margin: 1.2em 0; }
.titlepage { text-align: center; margin-top: 30%; }
.titlepage h1 { margin-bottom: 0.3em; }
.titlepage .author { font-size: 1.1em; }
`;

interface BookMeta {
	title: string;
	author: string;
}

/** Parse the simple ----fenced metadata block from title.txt. */
export function parseBookMeta(titleFileText: string, fallbackTitle: string): BookMeta {
	const meta: BookMeta = { title: fallbackTitle, author: "" };
	const m = /^---\s*\n([\s\S]*?)(\n---|$)/.exec(titleFileText);
	if (m) {
		for (const line of m[1].split("\n")) {
			const kv = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
			if (!kv) continue;
			const val = kv[2].trim().replace(/^['"]|['"]$/g, "");
			if (kv[1].toLowerCase() === "title") meta.title = val;
			if (kv[1].toLowerCase() === "author") meta.author = val;
		}
	}
	return meta;
}

export interface EpubResult {
	path: string;
	chapters: number;
}

/**
 * Build <BookName>.epub in the book root from the compiled chapter files
 * (every note except title.txt, in filename order — same as the original).
 */
export async function compileEpub(bookRoot: string): Promise<EpubResult> {
	const listing = await listDir(bookRoot);
	const chapters: NoteInfo[] = sortNotes(
		listing.notes.filter((n) => n.title !== "title"),
		false,
	);
	if (chapters.length === 0) throw new Error("No compiled chapters found in the book folder.");

	let titleText = "";
	try {
		titleText = await readTextFile(pathJoin(bookRoot, BOOK_MAGIC_FILENAME));
	} catch {
		// tolerated; fall back to folder name
	}
	const meta = parseBookMeta(titleText, baseName(bookRoot));

	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
	zip.file(
		"META-INF/container.xml",
		`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
	);

	// Cover (optional)
	let hasCover = false;
	const coverPath = pathJoin(bookRoot, "cover.jpg");
	if (await exists(coverPath)) {
		const img = await readFile(coverPath);
		zip.file("OEBPS/cover.jpg", img);
		zip.file(
			"OEBPS/cover.xhtml",
			xhtmlDoc(meta.title, `<div style="text-align:center"><img src="cover.jpg" alt="Cover" style="max-width:100%"/></div>\n`),
		);
		hasCover = true;
	}

	zip.file("OEBPS/style.css", EPUB_CSS);
	zip.file(
		"OEBPS/titlepage.xhtml",
		xhtmlDoc(
			meta.title,
			`<div class="titlepage"><h1>${esc(meta.title)}</h1>${meta.author ? `<p class="author">${esc(meta.author)}</p>` : ""}</div>\n`,
		),
	);

	const items: { id: string; href: string; title: string }[] = [];
	for (let i = 0; i < chapters.length; i++) {
		const md = await readTextFile(chapters[i].path);
		const href = `chapter-${String(i + 1).padStart(3, "0")}.xhtml`;
		zip.file(`OEBPS/${href}`, xhtmlDoc(chapters[i].title, proseMdToXhtml(md)));
		items.push({ id: `ch${i + 1}`, href, title: chapters[i].title });
	}

	const uuid = crypto.randomUUID();
	const navList = items.map((it) => `<li><a href="${it.href}">${esc(it.title)}</a></li>`).join("\n      ");
	zip.file(
		"OEBPS/nav.xhtml",
		`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>Contents</h1>
    <ol>
      <li><a href="titlepage.xhtml">${esc(meta.title)}</a></li>
      ${navList}
    </ol>
  </nav>
</body>
</html>
`,
	);

	const manifest = [
		hasCover ? `<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>` : "",
		hasCover ? `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>` : "",
		`<item id="css" href="style.css" media-type="text/css"/>`,
		`<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`,
		`<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
		...items.map((it) => `<item id="${it.id}" href="${it.href}" media-type="application/xhtml+xml"/>`),
	]
		.filter(Boolean)
		.join("\n    ");
	const spine = [
		hasCover ? `<itemref idref="cover"/>` : "",
		`<itemref idref="titlepage"/>`,
		...items.map((it) => `<itemref idref="${it.id}"/>`),
	]
		.filter(Boolean)
		.join("\n    ");

	zip.file(
		"OEBPS/content.opf",
		`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${esc(meta.title)}</dc:title>
    ${meta.author ? `<dc:creator>${esc(meta.author)}</dc:creator>` : ""}
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>
`,
	);

	const bytes = await zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip" });
	const outPath = pathJoin(bookRoot, `${meta.title}.epub`);
	await writeFile(outPath, bytes);
	return { path: outPath, chapters: chapters.length };
}
