/* ============================================================
   Kiln Documents — engine
   Three libraries, clear division of labour:
     docx-preview  renders a .docx faithfully   (Read mode, print)
     mammoth       .docx → semantic HTML        (Edit mode)
     docx          writes a .docx from a model  (Export)
   Read mode shows the file as Word laid it out. Edit mode works on the
   document's *content* and rebuilds a clean file on export — which is why the
   Export panel says plainly what a rebuild does not carry over.
   ============================================================ */
import { renderAsync } from "./vendor/docx-preview.mjs";
import mammoth from "./vendor/mammoth.mjs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ExternalHyperlink, ImageRun, Table, TableRow, TableCell, WidthType,
} from "./vendor/docx.mjs";

/* ---------------- tiny helpers ---------------- */
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtB = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = "toast";
  const tint = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" }[kind] || "var(--ok)";
  t.innerHTML = `<span class="dot" style="background:${tint}"></span>${esc(msg)}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(10px)"; }, 2600);
  setTimeout(() => t.remove(), 2950);
  return t;
}
function download(blobOrBytes, name, type = "application/octet-stream") {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const status = s => { $("sbStatus").textContent = s; };

/* ---------------- document state ---------------- */
const Doc = {
  open: false,
  name: "",
  size: 0,
  bytes: null,        // the original .docx, kept so Read mode can always go back to it
  html: "",           // editable content (mammoth)
  mode: "view",       // "view" | "edit"
  zoom: 1,
  dirty: false,
  messages: [],       // what mammoth could not carry into the editor
};

const editor = () => $("editor");
const paper = () => $("paper");

/* ---------------- opening ---------------- */
async function openBytes(bytes, name) {
  status("Opening…");
  Doc.bytes = bytes;
  Doc.name = name;
  Doc.size = bytes.byteLength;
  Doc.open = true;
  Doc.dirty = false;
  $("dz").hidden = true;
  try {
    const res = await mammoth.convertToHtml({ arrayBuffer: bytes.slice(0) });
    Doc.html = res.value || "<p></p>";
    Doc.messages = (res.messages || []).map(m => m.message);
  } catch (e) {
    Doc.html = "<p></p>";
    Doc.messages = ["This file's content could not be converted for editing: " + (e?.message || e)];
  }
  await setMode("view");
  renderAll();
  status("Ready");
  toast(`${name} — ${plural(words(textOf()), "word")}`);
}
async function openFile(file) {
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) {
    return toast(/\.doc$/i.test(file.name)
      ? "Old .doc files aren't supported — save it as .docx in Word first"
      : "That is not a .docx file", "bad");
  }
  try { await openBytes(await file.arrayBuffer(), file.name); }
  catch (e) { status("Failed"); toast("Could not open: " + (e?.message || e), "bad"); }
}

/* a real .docx, built here, so the sample is a file rather than a picture of one */
async function sampleBytes() {
  const doc = new Document({
    creator: "Kiln", title: "Kiln sample document",
    numbering: { config: [{ reference: "kiln-ol", levels: [{ level: 0, format: "decimal", text: "%1.", alignment: AlignmentType.LEFT }] }] },
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: "Kiln Documents", heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: "A Word document, opened and edited in your browser.", italics: true, color: "6B625A" })] }),
        new Paragraph({ text: "How it works", heading: HeadingLevel.HEADING_2 }),
        new Paragraph("Read mode renders this file the way Word laid it out, using docx-preview. Nothing is uploaded and nothing is changed."),
        new Paragraph({
          children: [
            new TextRun("Edit mode converts the content to editable text — you can make it "),
            new TextRun({ text: "bold", bold: true }), new TextRun(", "),
            new TextRun({ text: "italic", italics: true }), new TextRun(", "),
            new TextRun({ text: "underlined", underline: {} }),
            new TextRun(", add headings and lists, then export a clean .docx."),
          ],
        }),
        new Paragraph({ text: "What you can do here", heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: "Read any .docx exactly as Word laid it out", bullet: { level: 0 } }),
        new Paragraph({ text: "Print it, or save it as a PDF through the print dialog", bullet: { level: 0 } }),
        new Paragraph({ text: "Edit the text and formatting, then export .docx, HTML or plain text", bullet: { level: 0 } }),
        new Paragraph({ text: "Steps to try", heading: HeadingLevel.HEADING_2 }),
        new Paragraph({ text: "Switch to Edit at the top left", numbering: { reference: "kiln-ol", level: 0 } }),
        new Paragraph({ text: "Change a heading, or make some words bold", numbering: { reference: "kiln-ol", level: 0 } }),
        new Paragraph({ text: "Press Export to download the result as a Word file", numbering: { reference: "kiln-ol", level: 0 } }),
        new Paragraph({ text: "A table", heading: HeadingLevel.HEADING_2 }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: ["Workspace", "Runs in", "Status"].map(t => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) }),
            new TableRow({ children: ["Image", "Browser", "Shipped"].map(t => new TableCell({ children: [new Paragraph(t)] })) }),
            new TableRow({ children: ["PDF", "Browser", "Shipped"].map(t => new TableCell({ children: [new Paragraph(t)] })) }),
            new TableRow({ children: ["Documents", "Browser", "This one"].map(t => new TableCell({ children: [new Paragraph(t)] })) }),
          ],
        }),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  return blob.arrayBuffer();
}
async function blankDocument() {
  Doc.bytes = null;
  Doc.name = "Untitled.docx";
  Doc.size = 0;
  Doc.open = true;
  Doc.dirty = false;
  Doc.messages = [];
  Doc.html = "<h1>Untitled</h1><p></p>";
  $("dz").hidden = true;
  await setMode("edit");
  renderAll();
  editor().focus();
}

/* ---------------- modes ---------------- */
async function setMode(mode) {
  if (mode === "view" && !Doc.bytes) {
    // a document started from scratch has no original file to render
    if (Doc.open) toast("This document has no Word file yet — export one first", "warn");
    mode = "edit";
  }
  Doc.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach(b => b.classList.toggle("on", b.dataset.mode === mode));
  $("sbMode").textContent = mode === "view" ? "Read" : "Edit";
  paper().hidden = mode !== "view";
  editor().hidden = mode !== "edit";
  if (mode === "view") {
    status("Rendering…");
    paper().innerHTML = "";
    try {
      await renderAsync(Doc.bytes.slice(0), paper(), null, {
        className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false,
        breakPages: true, experimental: true, useBase64URL: true,
      });
    } catch (e) {
      paper().innerHTML = `<div style="padding:40px;color:#a33">This file could not be rendered: ${esc(e?.message || e)}</div>`;
    }
    status("Ready");
  } else {
    editor().innerHTML = Doc.html;
  }
  applyZoom();
  renderOutline();
  syncStats();
}

/* ---------------- content, outline, stats ---------------- */
const liveRoot = () => Doc.mode === "edit" ? editor() : paper();
const textOf = () => (liveRoot()?.innerText || "").trim();
const words = t => t ? (t.match(/\S+/g) || []).length : 0;

function syncStats() {
  const t = textOf();
  $("sbWords").textContent = words(t);
  $("sbChars").textContent = t.length;
  $("sbFile").textContent = Doc.name || "—";
  renderInfo();
}
/* Edit mode has real <h1>…<h4>. Read mode is docx-preview's output, where a
   Word heading is a <p class="docx_heading2"> — same outline, different markup. */
function headings() {
  const root = liveRoot();
  if (!root) return [];
  return [...root.querySelectorAll("h1,h2,h3,h4,p[class*=docx_heading]")]
    .filter(h => h.textContent.trim())
    .map((h, i) => {
      const m = /heading(\d)/i.exec(h.className) || /^H(\d)$/.exec(h.tagName);
      return { i, level: m ? +m[1] : 1, text: h.textContent.trim(), el: h };
    });
}
let headingEls = [];
function renderOutline() {
  const list = headings();
  headingEls = list.map(h => h.el);
  $("outN").textContent = list.length;
  $("outline").innerHTML = list.length
    ? list.map(h => `<button class="onav" data-h="${h.i}" style="padding-left:${8 + (h.level - 1) * 11}px">
        <span class="lv">H${h.level}</span><span class="tt">${esc(h.text)}</span></button>`).join("")
    : `<div class="empty">${Doc.open ? "This document has no headings." : "No document open."}</div>`;
}

/* ---------------- formatting (Edit mode) ---------------- */
function cmd(name, value = null) {
  if (Doc.mode !== "edit") return toast("Switch to Edit first", "warn");
  editor().focus();
  document.execCommand(name, false, value);
  onEdited();
}
function setBlock(tag) {
  if (Doc.mode !== "edit") return toast("Switch to Edit first", "warn");
  editor().focus();
  document.execCommand("formatBlock", false, tag === "p" ? "P" : tag.toUpperCase());
  onEdited();
}
function addLink() {
  if (Doc.mode !== "edit") return toast("Switch to Edit first", "warn");
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return toast("Select the words to link first", "warn");
  const url = prompt("Link to", "https://");
  if (!url) return;
  cmd("createLink", url);
}
function onEdited() {
  Doc.dirty = true;
  Doc.html = editor().innerHTML;
  syncStats();
  renderOutline();
  syncFormatButtons();
}
function syncFormatButtons() {
  if (Doc.mode !== "edit") {
    document.querySelectorAll("[data-fmt]").forEach(b => b.classList.remove("on"));
    return;
  }
  for (const b of document.querySelectorAll("[data-fmt]")) {
    try { b.classList.toggle("on", document.queryCommandState(b.dataset.fmt)); } catch { /* not a state command */ }
  }
  const block = document.queryCommandValue("formatBlock")?.toLowerCase() || "p";
  const sel = $("blockSel");
  sel.value = [...sel.options].some(o => o.value === block) ? block : "p";
}

/* ---------------- zoom ---------------- */
function applyZoom() {
  for (const el of [paper(), editor()]) el.style.zoom = Doc.zoom;
  $("zoomV").textContent = Math.round(Doc.zoom * 100) + "%";
}
const setZoom = z => { Doc.zoom = clamp(z, .5, 2.5); applyZoom(); };

/* ---------------- export ----------------
   Read mode prints/exports the original file's own rendering. Edit mode
   rebuilds a document from the edited content — clean, but a rebuild, which
   is why the panel spells out what a rebuild leaves behind. */
const stem = () => (Doc.name || "document").replace(/\.docx$/i, "");

function alignmentOf(el) {
  const a = (el.style?.textAlign || getComputedStyle(el).textAlign || "").toLowerCase();
  return a === "center" ? AlignmentType.CENTER : a === "right" ? AlignmentType.RIGHT
    : a === "justify" ? AlignmentType.JUSTIFIED : undefined;
}
function imageRun(img) {
  const m = /^data:(image\/([a-z+]+));base64,(.*)$/i.exec(img.src || "");
  if (!m) return null;
  const bin = atob(m[3]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const w = img.naturalWidth || 400, h = img.naturalHeight || 300;
  const scale = Math.min(1, 460 / w);
  const type = { jpeg: "jpg", "svg+xml": "svg" }[m[2].toLowerCase()] || m[2].toLowerCase();
  try {
    return new ImageRun({ data, type, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } });
  } catch { return null; }
}
/* inline nodes → docx runs, carrying formatting down the tree */
function runsOf(node, fmt = {}) {
  if (node.nodeType === Node.TEXT_NODE)
    return node.nodeValue ? [new TextRun({ text: node.nodeValue, ...fmt })] : [];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const tag = node.tagName;
  if (tag === "BR") return [new TextRun({ text: "", break: 1 })];
  if (tag === "IMG") { const r = imageRun(node); return r ? [r] : []; }
  const f = { ...fmt };
  if (tag === "B" || tag === "STRONG") f.bold = true;
  if (tag === "I" || tag === "EM") f.italics = true;
  if (tag === "U" || tag === "INS") f.underline = {};
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") f.strike = true;
  if (tag === "SUP") f.superScript = true;
  if (tag === "SUB") f.subScript = true;
  const st = node.style;                       // execCommand often writes spans with styles
  if (st) {
    if (/^(bold|[6-9]00)$/.test(st.fontWeight)) f.bold = true;
    if (st.fontStyle === "italic") f.italics = true;
    if (st.textDecoration?.includes("underline") || st.textDecorationLine?.includes("underline")) f.underline = {};
    if (st.textDecoration?.includes("line-through") || st.textDecorationLine?.includes("line-through")) f.strike = true;
  }
  if (tag === "A" && node.getAttribute("href")) {
    const kids = [...node.childNodes].flatMap(n => runsOf(n, { ...f, style: "Hyperlink" }));
    return kids.length ? [new ExternalHyperlink({ children: kids, link: node.getAttribute("href") })] : [];
  }
  return [...node.childNodes].flatMap(n => runsOf(n, f));
}
const HEADINGS = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
  H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };

function blocksOf(node, depth = 0) {
  const out = [];
  for (const el of node.childNodes) {
    if (el.nodeType === Node.TEXT_NODE) {
      if (el.nodeValue.trim()) out.push(new Paragraph({ children: [new TextRun(el.nodeValue.trim())] }));
      continue;
    }
    if (el.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = el.tagName;
    if (HEADINGS[tag]) {
      out.push(new Paragraph({ heading: HEADINGS[tag], alignment: alignmentOf(el), children: runsOf(el) }));
    } else if (tag === "P" || tag === "DIV") {
      const kids = runsOf(el);
      out.push(new Paragraph({ alignment: alignmentOf(el), children: kids.length ? kids : [new TextRun("")] }));
    } else if (tag === "UL" || tag === "OL") {
      const ordered = tag === "OL";
      for (const li of el.children) {
        if (li.tagName !== "LI") continue;
        const nested = [...li.children].filter(c => c.tagName === "UL" || c.tagName === "OL");
        const own = [...li.childNodes].filter(n => !(n.nodeType === 1 && (n.tagName === "UL" || n.tagName === "OL")));
        out.push(new Paragraph({
          children: own.flatMap(n => runsOf(n)),
          ...(ordered ? { numbering: { reference: "kiln-ol", level: Math.min(depth, 2) } }
                      : { bullet: { level: Math.min(depth, 2) } }),
        }));
        for (const n of nested) out.push(...blocksOf({ childNodes: [n] }, depth + 1));
      }
    } else if (tag === "BLOCKQUOTE") {
      out.push(new Paragraph({ children: runsOf(el), indent: { left: 720 } }));
    } else if (tag === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map(tr => new TableRow({
        children: [...tr.children].filter(c => /^(TD|TH)$/.test(c.tagName)).map(td => {
          const inner = blocksOf(td, depth);
          return new TableCell({ children: inner.length ? inner : [new Paragraph("")] });
        }),
      }));
      if (rows.length) out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    } else if (tag === "IMG") {
      const r = imageRun(el);
      if (r) out.push(new Paragraph({ children: [r] }));
    } else if (tag === "HR") {
      out.push(new Paragraph({ text: "" }));
    } else {
      const kids = runsOf(el);
      if (kids.length) out.push(new Paragraph({ children: kids }));
    }
  }
  return out;
}

async function buildDocx() {
  const src = document.createElement("div");
  src.innerHTML = Doc.mode === "edit" ? editor().innerHTML : Doc.html;
  document.body.appendChild(src);            // images need layout for their natural size
  src.style.cssText = "position:fixed;left:-9999px;top:0;width:816px";
  const children = blocksOf(src);
  src.remove();
  const doc = new Document({
    creator: "Kiln",
    title: stem(),
    numbering: {
      config: [{
        reference: "kiln-ol",
        levels: [0, 1, 2].map(level => ({ level, format: "decimal", text: `%${level + 1}.`, alignment: AlignmentType.LEFT })),
      }],
    },
    sections: [{ properties: {}, children: children.length ? children : [new Paragraph("")] }],
  });
  return Packer.toBlob(doc);
}

async function exportDocx() {
  if (!Doc.open) return toast("Open a document first", "warn");
  status("Building…");
  try {
    const blob = await buildDocx();
    download(blob, `${stem()}-kiln.docx`);
    Doc.dirty = false;
    toast(`Exported ${stem()}-kiln.docx · ${fmtB(blob.size)}`);
  } catch (e) { toast("Export failed: " + (e?.message || e), "bad"); }
  finally { status("Ready"); }
}
function exportHtml() {
  if (!Doc.open) return toast("Open a document first", "warn");
  const html = `<!doctype html>\n<meta charset="utf-8">\n<title>${esc(stem())}</title>\n` +
    `<style>body{font:16px/1.6 Georgia,serif;max-width:46em;margin:3em auto;padding:0 1em}` +
    `table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 9px}img{max-width:100%}</style>\n` +
    (Doc.mode === "edit" ? editor().innerHTML : Doc.html);
  download(new TextEncoder().encode(html), `${stem()}.html`, "text/html");
  toast("HTML exported");
}
function exportText() {
  if (!Doc.open) return toast("Open a document first", "warn");
  download(new TextEncoder().encode(textOf()), `${stem()}.txt`, "text/plain");
  toast("Text exported");
}
function printDoc() {
  if (!Doc.open) return toast("Open a document first", "warn");
  print();
}
function saveOriginal() {
  if (!Doc.bytes) return toast("This document has no original file", "warn");
  download(new Blob([Doc.bytes]), Doc.name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}

/* ---------------- panels ---------------- */
const PANELS_KEY = "kiln-documents-panels";
const panels = (() => { try { return JSON.parse(localStorage.getItem(PANELS_KEY)) || {}; } catch { return {}; } })();
const savePanels = () => { try { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); } catch { /* private mode */ } };
const CHEV = `<svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg>`;
function sec(id, title, body, { dflt = false, count = null } = {}) {
  const shut = panels[id] ?? dflt;
  return `<div class="sec${shut ? " shut" : ""}" data-sec="${id}">
    <button class="sec-h" data-sec-h aria-expanded="${!shut}">${CHEV}${esc(title)}
      ${count === null ? "" : `<span class="sec-n num">${esc(count)}</span>`}</button>
    <div class="sec-b">${body}</div></div>`;
}
function toggleSec(el) {
  const shut = !el.classList.contains("shut");
  el.classList.toggle("shut", shut);
  el.querySelector("[data-sec-h]")?.setAttribute("aria-expanded", String(!shut));
  if (el.dataset.sec) { panels[el.dataset.sec] = shut; savePanels(); }
}
function foldPane(side) {
  const cls = "fold" + side;
  const on = !document.body.classList.contains(cls);
  document.body.classList.toggle(cls, on);
  panels[cls] = on; savePanels();
}
function applyPanelState() {
  document.querySelectorAll(".sec[data-sec]").forEach(el => {
    const shut = panels[el.dataset.sec] ?? el.classList.contains("shut");
    el.classList.toggle("shut", shut);
    el.querySelector("[data-sec-h]")?.setAttribute("aria-expanded", String(!shut));
  });
  ["L", "R"].forEach(s => document.body.classList.toggle("fold" + s, !!panels["fold" + s]));
}

function renderInfo() {
  const t = textOf();
  const rows = [
    ["File", Doc.name || "—"],
    ["Size", Doc.size ? fmtB(Doc.size) : "—"],
    ["Words", words(t)],
    ["Characters", t.length],
    ["Paragraphs", liveRoot()?.querySelectorAll("p,h1,h2,h3,h4,li").length || 0],
    ["Headings", headings().length],
    ["Tables", liveRoot()?.querySelectorAll("table").length || 0],
    ["Images", liveRoot()?.querySelectorAll("img").length || 0],
    ["Unsaved edits", Doc.dirty ? "yes" : "no"],
  ];
  $("pInfo").innerHTML =
    sec("info", "Document", rows.map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>`).join("")) +
    sec("conv", "Conversion notes", Doc.messages.length
      ? `<div class="note">${Doc.messages.slice(0, 8).map(esc).join("<br>")}</div>`
      : `<div class="note">Nothing was dropped converting this file for editing.</div>`,
      { dflt: true, count: Doc.messages.length || null });
}
function renderExportPanel() {
  $("pExport").innerHTML =
    sec("exp", "Export", `
      <button class="rowbtn" data-act="exportDocx">Word document (.docx)</button>
      <button class="rowbtn" data-act="print">Print · Save as PDF</button>
      <button class="rowbtn" data-act="exportHtml">Web page (.html)</button>
      <button class="rowbtn" data-act="exportText">Plain text (.txt)</button>
      <button class="rowbtn" data-act="saveOriginal">The original file, untouched</button>`) +
    sec("hon", "What a rebuild carries", `
      <div class="note">
        <b>Read mode</b> shows the file exactly as Word laid it out, and printing prints that —
        so reading and printing never lose anything.<br><br>
        <b>Export .docx</b> rebuilds the file from the edited content. It keeps text, headings,
        bold/italic/underline, lists, tables, links and images. It does <b>not</b> carry over
        tracked changes, comments, footnotes, headers and footers, page numbering, custom styles
        or embedded charts — those live in parts of the file this editor does not model.<br><br>
        If a document has any of that, keep the original: export a copy and compare, rather than
        replacing your only version.
      </div>`);
}

/* ---------------- menus + actions ---------------- */
const MENUS = {
  mFile: [
    ["Open .docx…", "open", "⌘O"], ["Sample document", "sample"], ["Start writing", "blank"], null,
    ["Export .docx…", "exportDocx", "⌘E"], ["Export HTML…", "exportHtml"], ["Export plain text…", "exportText"],
    ["Download the original", "saveOriginal"], null,
    ["Print · Save as PDF", "print", "⌘P"], ["Close document", "close"],
  ],
  mEdit: [
    ["Undo", "undo", "⌘Z"], ["Redo", "redo", "⇧⌘Z"], null,
    ["Select all", "selectAll", "⌘A"], ["Add a link…", "link", "⌘K"], null,
    ["Clear formatting", "clearFormat"],
  ],
  mFormat: [
    ["Body text", "blockP"], ["Heading 1", "blockH1"], ["Heading 2", "blockH2"], ["Heading 3", "blockH3"],
    ["Quote", "blockQuote"], null,
    ["Bold", "bold", "⌘B"], ["Italic", "italic", "⌘I"], ["Underline", "underline", "⌘U"], null,
    ["Bulleted list", "ul"], ["Numbered list", "ol"],
  ],
  mView: [
    ["Read mode", "modeView"], ["Edit mode", "modeEdit"], null,
    ["Zoom in", "zin", "⌘+"], ["Zoom out", "zout", "⌘−"], ["Actual size", "z100", "⌘1"], null,
    ["Toggle panels", "panels", "⇥"],
  ],
};
function buildMenus() {
  for (const [id, items] of Object.entries(MENUS)) {
    $(id).innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi" data-act="${it[1]}">${esc(it[0])}${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
}
const ACT = {
  open: () => $("fileMain").click(),
  sample: async () => { try { await openBytes(await sampleBytes(), "kiln-sample.docx"); } catch (e) { toast("Sample failed: " + e.message, "bad"); } },
  blank: blankDocument,
  close: () => {
    if (Doc.dirty && !confirm("This document has unsaved edits. Close it anyway?")) return;
    Doc.open = false; Doc.bytes = null; Doc.html = ""; Doc.name = ""; Doc.size = 0; Doc.dirty = false; Doc.messages = [];
    paper().innerHTML = ""; editor().innerHTML = "";
    paper().hidden = editor().hidden = true;
    $("dz").hidden = false;
    renderAll();
  },
  exportDocx, exportHtml, exportText, saveOriginal, print: printDoc,
  undo: () => cmd("undo"), redo: () => cmd("redo"),
  selectAll: () => { if (Doc.mode === "edit") { editor().focus(); document.execCommand("selectAll"); } },
  link: addLink, clearFormat: () => cmd("removeFormat"),
  bold: () => cmd("bold"), italic: () => cmd("italic"), underline: () => cmd("underline"),
  ul: () => cmd("insertUnorderedList"), ol: () => cmd("insertOrderedList"),
  blockP: () => setBlock("p"), blockH1: () => setBlock("h1"), blockH2: () => setBlock("h2"),
  blockH3: () => setBlock("h3"), blockQuote: () => setBlock("blockquote"),
  modeView: () => setMode("view"), modeEdit: () => setMode("edit"),
  zin: () => setZoom(Doc.zoom + .1), zout: () => setZoom(Doc.zoom - .1), z100: () => setZoom(1),
  panels: () => { foldPane("L"); foldPane("R"); },
};
const act = k => ACT[k]?.();

/* ---------------- render + wiring ---------------- */
function renderAll() {
  renderOutline();
  renderInfo();
  renderExportPanel();
  syncStats();
  applyPanelState();
}
function showPanel(id) {
  document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t.dataset.pt === id));
  document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === id));
}

function wire() {
  buildMenus();

  document.querySelectorAll("[data-menu]").forEach(m => {
    m.querySelector(".menu-t").addEventListener("click", e => {
      e.stopPropagation();
      const was = m.classList.contains("open");
      document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
      m.classList.toggle("open", !was);
    });
  });
  document.addEventListener("click", e => {
    const mi = e.target.closest(".mi");
    if (mi?.dataset.act) act(mi.dataset.act);
    if (!e.target.closest("[data-menu]") || mi) document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
    const tb = e.target.closest("[data-act]:not(.mi)");
    if (tb) act(tb.dataset.act);
    const fmt = e.target.closest("[data-fmt]");
    if (fmt) cmd(fmt.dataset.fmt);
    const h = e.target.closest("[data-sec-h]");
    if (h) toggleSec(h.closest(".sec"));
    const f = e.target.closest("[data-fold]");
    if (f) foldPane(f.dataset.fold);
    const nav = e.target.closest("[data-h]");
    if (nav) headingEls[+nav.dataset.h]?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll(".ptab").forEach(t => t.addEventListener("click", () => showPanel(t.dataset.pt)));
  document.querySelectorAll("#modeSeg button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("blockSel").addEventListener("change", e => setBlock(e.target.value));

  const dz = $("dz");
  dz.addEventListener("click", e => { if (!e.target.closest("button")) $("fileMain").click(); });
  dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") $("fileMain").click(); });
  $("fileMain").addEventListener("change", e => { openFile(e.target.files[0]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach(ev => $("stage").addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => $("stage").addEventListener(ev, () => dz.classList.remove("over")));
  $("stage").addEventListener("drop", e => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });

  editor().addEventListener("input", onEdited);
  editor().addEventListener("keyup", syncFormatButtons);
  editor().addEventListener("mouseup", syncFormatButtons);
  // paste as text keeps Word's inline styles out of the editor
  editor().addEventListener("paste", e => {
    const html = e.clipboardData?.getData("text/html");
    if (!html) return;
    e.preventDefault();
    const clean = document.createElement("div");
    clean.innerHTML = html;
    clean.querySelectorAll("script,style,meta,link").forEach(n => n.remove());
    clean.querySelectorAll("*").forEach(n => { n.removeAttribute("class"); n.removeAttribute("id"); });
    document.execCommand("insertHTML", false, clean.innerHTML);
    onEdited();
  });

  addEventListener("keydown", e => {
    const M = e.metaKey || e.ctrlKey;
    if (!M) return;
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); act("open"); }
    else if (k === "e") { e.preventDefault(); act("exportDocx"); }
    else if (k === "p") { e.preventDefault(); act("print"); }
    else if (k === "k") { e.preventDefault(); act("link"); }
    else if (k === "1") { e.preventDefault(); act("z100"); }
    else if (e.key === "=" || e.key === "+") { e.preventDefault(); act("zin"); }
    else if (e.key === "-") { e.preventDefault(); act("zout"); }
  });

  const split = $("splitL");
  split.addEventListener("pointerdown", e => {
    split.setPointerCapture(e.pointerId);
    const move = ev => document.body.style.setProperty("--lw",
      clamp(ev.clientX, 140, 420) + "px");
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });

  addEventListener("beforeunload", e => {
    if (Doc.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  renderAll();
  status("Ready");
}
wire();

/* test + console handle */
window.Kiln = {
  Doc, act, setMode, openBytes, sampleBytes, buildDocx, blocksOf, exportDocx,
  cmd, setBlock, textOf, words, headings, setZoom, panels, toggleSec, foldPane,
  html: () => (Doc.mode === "edit" ? editor().innerHTML : Doc.html),
};
