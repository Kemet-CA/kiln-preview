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
  PageBreak, BorderStyle, PageOrientation, LineRuleType, convertInchesToTwip,
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
  syncRibbon();
  measureRibbon();
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
  renderRibbonStats();
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

/* ---------------- formatting (Edit mode) ----------------
   contenteditable + execCommand. Deprecated, universally supported, and the
   right size of tool for an app with no framework. Everything that execCommand
   cannot do — block spacing, indents, tables, shapes, page setup — is done by
   walking the selection and setting styles directly. */
const FONTS = ["Calibri", "Cambria", "Georgia", "Garamond", "Times New Roman", "Arial",
  "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Courier New", "Consolas", "Impact"];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
const STYLES = [
  ["p", "Body"], ["h1", "Title"], ["h2", "Heading 1"], ["h3", "Heading 2"],
  ["h4", "Heading 3"], ["blockquote", "Quote"], ["pre", "Code"],
];
const SYMBOLS = ["©", "®", "™", "§", "¶", "†", "‡", "•", "–", "—", "…", "‰", "°", "±", "×", "÷",
  "≤", "≥", "≠", "≈", "√", "∞", "µ", "α", "β", "π", "Ω", "€", "£", "¥", "¢", "→"];

const editing = () => {
  if (Doc.mode !== "edit") { toast("Switch to Edit to change the document", "warn"); return false; }
  return true;
};
function cmd(name, value = null) {
  if (!editing()) return;
  editor().focus();
  document.execCommand("styleWithCSS", false, true);   // spans with CSS, not <font> tags
  document.execCommand(name, false, value);
  onEdited();
}
function setBlock(tag) {
  if (!editing()) return;
  editor().focus();
  document.execCommand("formatBlock", false, tag === "p" ? "P" : tag.toUpperCase());
  onEdited();
}
function addLink() {
  if (!editing()) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return toast("Select the words to link first", "warn");
  const url = prompt("Link to", "https://");
  if (url) cmd("createLink", url);
}

/* every block element the selection touches — the unit for spacing, indents,
   shading and borders, none of which execCommand can do */
function selectedBlocks() {
  const ed = editor();
  const sel = getSelection();
  if (!sel?.rangeCount || !ed.contains(sel.anchorNode)) return [];
  const range = sel.getRangeAt(0);
  const blockOf = n => {
    let e = n.nodeType === Node.TEXT_NODE ? n.parentElement : n;
    while (e && e !== ed && !/^(P|H1|H2|H3|H4|H5|H6|LI|BLOCKQUOTE|PRE|TD|TH|DIV)$/.test(e.tagName)) e = e.parentElement;
    return e && e !== ed ? e : null;
  };
  const all = [...ed.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td,th,div")]
    .filter(b => range.intersectsNode(b) && !b.querySelector("p,h1,h2,h3,h4,li"));
  if (all.length) return all;
  const one = blockOf(range.startContainer);
  return one ? [one] : [];
}
function styleBlocks(fn, label) {
  if (!editing()) return;
  const blocks = selectedBlocks();
  if (!blocks.length) return toast("Put the cursor in a paragraph first", "warn");
  blocks.forEach(fn);
  onEdited();
  if (label) toast(label);
}
const px = v => parseFloat(v) || 0;

/* font size needs the legacy trick: execCommand only speaks sizes 1–7, so tag
   the selection with 7 and swap those nodes for a real CSS size */
function setFontSize(pt) {
  if (!editing()) return;
  editor().focus();
  // styleWithCSS must be OFF here: with it on, fontSize emits keywords like
  // "xxx-large" instead of the <font size=7> tags this swap depends on
  document.execCommand("styleWithCSS", false, false);
  document.execCommand("fontSize", false, "7");
  editor().querySelectorAll('font[size="7"]').forEach(f => {
    const span = document.createElement("span");
    span.style.fontSize = pt + "pt";
    span.innerHTML = f.innerHTML;
    f.replaceWith(span);
  });
  document.execCommand("styleWithCSS", false, true);
  onEdited();
}
function bumpFontSize(dir) {
  const cur = currentSizePt() || 11;
  const i = SIZES.findIndex(s => s >= cur);
  const next = dir > 0 ? SIZES[Math.min(SIZES.length - 1, (i < 0 ? SIZES.length - 1 : i) + 1)]
                       : SIZES[Math.max(0, (i < 0 ? 0 : i) - 1)];
  setFontSize(next);
  $("sizeSel").value = String(next);
}
function currentSizePt() {
  const sel = getSelection();
  const node = sel?.anchorNode;
  if (!node) return null;
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el || !editor().contains(el)) return null;
  return Math.round(parseFloat(getComputedStyle(el).fontSize) * 0.75);   // px → pt
}

/* format painter: remember the inline style of the selection, then paint it on */
let painter = null;
function formatPainter() {
  if (!editing()) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed) {
    if (!painter) return toast("Select formatted text first, then click Format", "warn");
    return;
  }
  const el = (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode);
  const cs = getComputedStyle(el);
  painter = {
    fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle, color: cs.color, backgroundColor: cs.backgroundColor,
    textDecorationLine: cs.textDecorationLine,
  };
  document.querySelector('[data-act="formatPainter"]')?.classList.add("on");
  toast("Formatting copied — select the text to paint it onto");
}
function applyPainter() {
  const sel = getSelection();
  if (!painter || !sel || sel.isCollapsed || !editor().contains(sel.anchorNode)) return;
  const span = document.createElement("span");
  Object.assign(span.style, painter);
  if (span.style.backgroundColor === "rgba(0, 0, 0, 0)") span.style.backgroundColor = "";
  try { sel.getRangeAt(0).surroundContents(span); } catch { return; }
  painter = null;
  document.querySelector('[data-act="formatPainter"]')?.classList.remove("on");
  onEdited();
}

function onEdited() {
  Doc.dirty = true; window.KilnProject?.touch();
  Doc.html = editor().innerHTML;
  syncStats();
  renderOutline();
  syncRibbon();
}
function syncRibbon() {
  const on = Doc.mode === "edit";
  document.body.classList.toggle("reading", !on);
  if (!on) { document.querySelectorAll("[data-fmt]").forEach(b => b.classList.remove("on")); return; }
  for (const b of document.querySelectorAll("[data-fmt]")) {
    try { b.classList.toggle("on", document.queryCommandState(b.dataset.fmt)); } catch { /* not a state command */ }
  }
  const block = (document.queryCommandValue("formatBlock") || "p").toLowerCase();
  document.querySelectorAll(".sgal").forEach(b => b.classList.toggle("on", b.dataset.style === block));
  const sel = getSelection();
  const el = sel?.anchorNode
    ? (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode) : null;
  if (el && editor().contains(el)) {
    const fam = getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "");
    if (FONTS.includes(fam)) $("fontSel").value = fam;
    const pt = currentSizePt();
    if (pt && SIZES.includes(pt)) $("sizeSel").value = String(pt);
    const lh = getComputedStyle(selectedBlocks()[0] || el).lineHeight;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const ratio = lh === "normal" ? 1 : +(parseFloat(lh) / fs).toFixed(2);
    const opt = [...$("lineSel").options].find(o => Math.abs(+o.value - ratio) < .08);
    if (opt) $("lineSel").value = opt.value;
  }
}

/* ---------------- tables ---------------- */
function insertTable(rows, cols) {
  if (!editing()) return;
  const cell = "<td><p><br></p></td>";
  const head = `<tr>${`<th><p><br></p></th>`.repeat(cols)}</tr>`;
  const body = `<tr>${cell.repeat(cols)}</tr>`.repeat(Math.max(0, rows - 1));
  editor().focus();
  document.execCommand("insertHTML", false, `<table><tbody>${head}${body}</tbody></table><p><br></p>`);
  onEdited();
  toast(`${rows} × ${cols} table inserted`);
}
function currentCell() {
  const sel = getSelection();
  let n = sel?.anchorNode;
  n = n?.nodeType === Node.TEXT_NODE ? n.parentElement : n;
  while (n && n !== editor() && !/^(TD|TH)$/.test(n.tagName)) n = n.parentElement;
  return n && /^(TD|TH)$/.test(n.tagName) ? n : null;
}
function tableOp(op) {
  if (!editing()) return;
  const cell = currentCell();
  if (!cell) return toast("Put the cursor inside a table first", "warn");
  const row = cell.parentElement, table = row.closest("table");
  const idx = [...row.children].indexOf(cell);
  const blank = tag => { const c = document.createElement(tag); c.innerHTML = "<p><br></p>"; return c; };
  if (op === "rowAbove" || op === "rowBelow") {
    const tr = document.createElement("tr");
    [...row.children].forEach(c => tr.appendChild(blank(c.tagName === "TH" ? "td" : "td")));
    row.parentElement.insertBefore(tr, op === "rowAbove" ? row : row.nextSibling);
  } else if (op === "delRow") {
    if (table.querySelectorAll("tr").length <= 1) return toast("A table needs a row", "warn");
    row.remove();
  } else if (op === "colBefore" || op === "colAfter") {
    for (const tr of table.querySelectorAll("tr")) {
      const ref = tr.children[idx];
      const c = blank(tr.querySelector("th") ? (ref?.tagName === "TH" ? "th" : "td") : "td");
      tr.insertBefore(c, op === "colBefore" ? ref : ref?.nextSibling);
    }
  } else if (op === "delCol") {
    if (row.children.length <= 1) return toast("A table needs a column", "warn");
    for (const tr of table.querySelectorAll("tr")) tr.children[idx]?.remove();
  }
  onEdited();
}

/* ---------------- insert ---------------- */
function insertHtml(html) {
  if (!editing()) return;
  editor().focus();
  document.execCommand("insertHTML", false, html);
  onEdited();
}
function insertImage() {
  if (!editing()) return;
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => insertHtml(`<p><img src="${r.result}" alt="${esc(f.name)}"></p>`);
    r.readAsDataURL(f);
  };
  inp.click();
}
const SHAPES = {
  rect: '<rect x="2" y="2" width="216" height="96" fill="COL" stroke="STK" stroke-width="2"/>',
  round: '<rect x="2" y="2" width="216" height="96" rx="14" fill="COL" stroke="STK" stroke-width="2"/>',
  ellipse: '<ellipse cx="110" cy="50" rx="108" ry="48" fill="COL" stroke="STK" stroke-width="2"/>',
  triangle: '<polygon points="110,3 218,97 2,97" fill="COL" stroke="STK" stroke-width="2"/>',
  line: '<line x1="4" y1="50" x2="216" y2="50" stroke="STK" stroke-width="3"/>',
  arrow: '<line x1="4" y1="50" x2="196" y2="50" stroke="STK" stroke-width="3"/><polygon points="216,50 190,38 190,62" fill="STK"/>',
  star: '<polygon points="110,6 121.2,36.6 153.7,37.8 128.1,57.9 137,89.2 110,71 83,89.2 91.9,57.9 66.3,37.8 98.8,36.6" fill="COL" stroke="STK" stroke-width="2"/>',
};
function insertShape(kind) {
  const fill = $("foreColor").value + "33", stroke = $("foreColor").value;
  const body = (SHAPES[kind] || SHAPES.rect).replaceAll("COL", fill).replaceAll("STK", stroke);
  insertHtml(`<p class="kshape"><svg xmlns="http://www.w3.org/2000/svg" width="220" height="100" viewBox="0 0 220 100">${body}</svg></p><p><br></p>`);
}
const insertTextBox = () => insertHtml(`<div class="ktb"><p>Type in this text box…</p></div><p><br></p>`);
const insertPageBreak = () => insertHtml(`<hr class="kpagebreak"><p><br></p>`);
const insertRule = () => insertHtml(`<hr><p><br></p>`);
const insertDate = () => insertHtml(new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
function addComment() {
  if (!editing()) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return toast("Select the text to comment on", "warn");
  const note = prompt("Comment");
  if (!note) return;
  const span = document.createElement("span");
  span.className = "kcomment";
  span.title = note;
  span.dataset.comment = note;
  try { sel.getRangeAt(0).surroundContents(span); } catch { return toast("Select text inside one paragraph", "warn"); }
  onEdited();
  toast("Comment added — it exports as highlighted text");
}
function clearComments() {
  if (!editing()) return;
  editor().querySelectorAll(".kcomment").forEach(s => s.replaceWith(...s.childNodes));
  onEdited();
}

/* ---------------- find & replace ---------------- */
const Find = { q: "", hits: [], i: -1 };
function clearMarks() {
  for (const m of [...editor().querySelectorAll("mark.kfind")]) {
    const t = document.createTextNode(m.textContent);
    m.replaceWith(t);
  }
  editor().normalize();
}
function runFind(scroll = true) {
  if (Doc.mode !== "edit") { toast("Find works in Edit mode", "warn"); return; }
  clearMarks();
  Find.q = $("findIn").value;
  Find.hits = []; Find.i = -1;
  if (!Find.q) { $("findCount").textContent = "0"; return; }
  const cs = $("findCase").checked;
  const needle = cs ? Find.q : Find.q.toLowerCase();
  const walker = document.createTreeWalker(editor(), NodeFilter.SHOW_TEXT);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    const hay = cs ? n.nodeValue : n.nodeValue.toLowerCase();
    let at = hay.indexOf(needle);
    const spots = [];
    while (at !== -1) { spots.push(at); at = hay.indexOf(needle, at + needle.length); }
    if (spots.length) targets.push({ node: n, spots });
  }
  // wrap back-to-front so earlier offsets stay valid
  for (const t of targets.reverse()) {
    for (const at of [...t.spots].reverse()) {
      const r = document.createRange();
      r.setStart(t.node, at);
      r.setEnd(t.node, at + Find.q.length);
      const mark = document.createElement("mark");
      mark.className = "kfind";
      r.surroundContents(mark);
    }
  }
  Find.hits = [...editor().querySelectorAll("mark.kfind")];
  $("findCount").textContent = Find.hits.length ? `1/${Find.hits.length}` : "0";
  if (Find.hits.length && scroll) gotoHit(0);
}
function gotoHit(k) {
  if (!Find.hits.length) return;
  Find.i = (k + Find.hits.length) % Find.hits.length;
  Find.hits.forEach((m, i) => m.classList.toggle("cur", i === Find.i));
  Find.hits[Find.i].scrollIntoView({ behavior: "smooth", block: "center" });
  $("findCount").textContent = `${Find.i + 1}/${Find.hits.length}`;
}
function replaceOne() {
  if (!editing()) return;
  if (!Find.hits.length) return runFind();
  const m = Find.hits[Math.max(0, Find.i)];
  if (!m) return;
  m.replaceWith(document.createTextNode($("replIn").value));
  editor().normalize();
  Doc.html = editor().innerHTML;
  Doc.dirty = true; window.KilnProject?.touch();
  runFind(false);
  if (Find.hits.length) gotoHit(Math.max(0, Find.i));
  syncStats();
}
function replaceAll() {
  if (!editing()) return;
  if (!Find.q) runFind(false);
  const n = Find.hits.length;
  if (!n) return toast("Nothing to replace", "warn");
  Find.hits.forEach(m => m.replaceWith(document.createTextNode($("replIn").value)));
  editor().normalize();
  onEdited();
  Find.hits = []; Find.i = -1;
  $("findCount").textContent = "0";
  toast(`Replaced ${plural(n, "match")}`);
}
function toggleFind(force) {
  const bar = $("findbar");
  const show = force ?? bar.hidden;
  bar.hidden = !show;
  if (show) { $("findIn").focus(); $("findIn").select(); } else clearMarks();
}

/* ---------------- page layout ---------------- */
const PAGE_SIZES = { a4: [816, 1056], letter: [816, 1056], legal: [816, 1344], a5: [560, 794] };
const MARGINS = { normal: 96, narrow: 48, moderate: 72, wide: 144 };
const Page = { size: "a4", orient: "portrait", margin: "normal", cols: 1 };
function applyPage() {
  const [w, h] = PAGE_SIZES[Page.size] || PAGE_SIZES.a4;
  const land = Page.orient === "landscape";
  const m = MARGINS[Page.margin] ?? 96;
  const ed = editor();
  ed.style.width = (land ? h : w) + "px";
  ed.style.minHeight = (land ? w : h) + "px";
  ed.style.padding = `${m}px ${m}px ${m + 24}px`;
  ed.style.columnCount = Page.cols > 1 ? Page.cols : "";
  ed.style.columnGap = Page.cols > 1 ? "36px" : "";
  Doc.page = { ...Page };
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

/* "rgb(34, 34, 34)" / "#222" → "222222"; empty for transparent or unset */
function toHex(v) {
  if (!v || v === "transparent" || v === "inherit") return null;
  const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map(n => Math.round(+n).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!h) return null;
  const s = h[1];
  return (s.length === 3 ? s.split("").map(c => c + c).join("") : s).toUpperCase();
}
/* an inline <svg> shape has to become a raster image to live in a .docx */
async function svgToPng(svg) {
  const xml = new XMLSerializer().serializeToString(svg);
  const w = svg.viewBox?.baseVal?.width || svg.width?.baseVal?.value || 220;
  const h = svg.viewBox?.baseVal?.height || svg.height?.baseVal?.value || 100;
  const img = new Image();
  const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(xml)));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const c = document.createElement("canvas");
  c.width = w * 2; c.height = h * 2;
  const ctx = c.getContext("2d");
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: c.toDataURL("image/png"), w, h };
}
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
  if (tag === "MARK" || node.classList?.contains("kcomment")) f.shading = { fill: "FFF3BF" };
  const st = node.style;                       // execCommand writes spans with styles
  if (st) {
    if (/^(bold|[6-9]00)$/.test(st.fontWeight)) f.bold = true;
    if (st.fontStyle === "italic") f.italics = true;
    if (st.textDecoration?.includes("underline") || st.textDecorationLine?.includes("underline")) f.underline = {};
    if (st.textDecoration?.includes("line-through") || st.textDecorationLine?.includes("line-through")) f.strike = true;
    if (st.fontFamily) f.font = st.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    if (st.fontSize) {
      const pt = st.fontSize.endsWith("pt") ? parseFloat(st.fontSize) : parseFloat(st.fontSize) * 0.75;
      if (pt) f.size = Math.round(pt * 2);            // docx counts half-points
    }
    const hex = toHex(st.color);
    if (hex) f.color = hex;
    const bg = toHex(st.backgroundColor);
    if (bg) f.shading = { fill: bg };
  }
  if (tag === "A" && node.getAttribute("href")) {
    const kids = [...node.childNodes].flatMap(n => runsOf(n, { ...f, style: "Hyperlink" }));
    return kids.length ? [new ExternalHyperlink({ children: kids, link: node.getAttribute("href") })] : [];
  }
  return [...node.childNodes].flatMap(n => runsOf(n, f));
}
const HEADINGS = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
  H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6 };

/* indents, spacing, line height, shading and borders set on a block in the
   editor become the paragraph's own properties in the file */
const TWIP_PER_PX = 15;                      // 1px ≈ 0.75pt ≈ 15 twips
function paraProps(el) {
  const st = el.style || {};
  const p = {};
  const left = parseFloat(st.marginLeft) || 0;
  if (left) p.indent = { left: Math.round(left * TWIP_PER_PX) };
  const before = parseFloat(st.marginTop) || 0, after = parseFloat(st.marginBottom) || 0;
  const lh = parseFloat(st.lineHeight) || 0;
  if (before || after || lh) {
    p.spacing = {};
    if (before) p.spacing.before = Math.round(before * TWIP_PER_PX);
    if (after) p.spacing.after = Math.round(after * TWIP_PER_PX);
    // CSS line-height is a multiplier; Word counts 240 twips per single line
    if (lh) { p.spacing.line = Math.round(lh * 240); p.spacing.lineRule = LineRuleType.AUTO; }
  }
  const fill = toHex(st.backgroundColor);
  if (fill) p.shading = { fill };
  if (st.border && st.border !== "none") {
    const edge = { style: BorderStyle.SINGLE, size: 6, color: toHex(st.borderColor) || "8A8378" };
    p.border = { top: edge, bottom: edge, left: edge, right: edge };
  }
  return p;
}

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
      out.push(new Paragraph({ heading: HEADINGS[tag], alignment: alignmentOf(el), ...paraProps(el), children: runsOf(el) }));
    } else if (el.classList?.contains("ktb")) {
      // a text box is a one-cell bordered table — the closest thing .docx has
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: [new TableCell({ children: blocksOf(el, depth) })] })],
      }));
    } else if (tag === "P" || tag === "DIV") {
      const kids = runsOf(el);
      out.push(new Paragraph({ alignment: alignmentOf(el), ...paraProps(el), children: kids.length ? kids : [new TextRun("")] }));
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
      if (r) out.push(new Paragraph({ children: [r], alignment: alignmentOf(el) }));
    } else if (tag === "HR") {
      out.push(el.classList.contains("kpagebreak")
        ? new Paragraph({ children: [new PageBreak()] })
        : new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "C9C4BD" } } }));
    } else {
      const kids = runsOf(el);
      if (kids.length) out.push(new Paragraph({ children: kids }));
    }
  }
  return out;
}

const PAGE_TWIPS = { a4: [11906, 16838], letter: [12240, 15840], legal: [12240, 20160], a5: [8391, 11906] };
async function buildDocx() {
  const src = document.createElement("div");
  src.innerHTML = Doc.mode === "edit" ? editor().innerHTML : Doc.html;
  document.body.appendChild(src);            // images need layout for their natural size
  src.style.cssText = "position:fixed;left:-9999px;top:0;width:816px";
  // shapes are inline SVG on screen; a .docx needs raster, so convert first
  for (const svg of [...src.querySelectorAll("svg")]) {
    try {
      const { dataUrl, w, h } = await svgToPng(svg);
      const img = document.createElement("img");
      img.src = dataUrl; img.width = w; img.height = h;
      await new Promise(r => { img.onload = r; img.onerror = r; });
      svg.replaceWith(img);
    } catch { svg.remove(); }
  }
  const children = blocksOf(src);
  src.remove();

  const page = Doc.page || Page;
  const [pw, ph] = PAGE_TWIPS[page.size] || PAGE_TWIPS.a4;
  const land = page.orient === "landscape";
  const marginIn = { normal: 1, narrow: .5, moderate: .75, wide: 1.5 }[page.margin] ?? 1;
  const m = convertInchesToTwip(marginIn);
  const sectionProps = {
    page: {
      size: { width: land ? ph : pw, height: land ? pw : ph,
              orientation: land ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
      margin: { top: m, bottom: m, left: m, right: m },
    },
    ...(page.cols > 1 ? { column: { count: page.cols, space: 708 } } : {}),
  };
  const doc = new Document({
    creator: "Kiln",
    title: stem(),
    numbering: {
      config: [{
        reference: "kiln-ol",
        levels: [0, 1, 2].map(level => ({ level, format: "decimal", text: `%${level + 1}.`, alignment: AlignmentType.LEFT })),
      }],
    },
    sections: [{ properties: sectionProps, children: children.length ? children : [new Paragraph("")] }],
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
    ["Save project", "saveProject", "⌘S"], ["Save a copy to disk…", "downloadProject"], null,
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
  saveProject: () => window.KilnProject?.save(),
  downloadProject: () => window.KilnProject?.download(),
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
  link: addLink, unlink: () => cmd("unlink"), clearFormat: () => cmd("removeFormat"),
  bold: () => cmd("bold"), italic: () => cmd("italic"), underline: () => cmd("underline"),
  ul: () => cmd("insertUnorderedList"), ol: () => cmd("insertOrderedList"),
  blockP: () => setBlock("p"), blockH1: () => setBlock("h1"), blockH2: () => setBlock("h2"),
  blockH3: () => setBlock("h3"), blockQuote: () => setBlock("blockquote"),
  modeView: () => setMode("view"), modeEdit: () => setMode("edit"),
  zin: () => setZoom(Doc.zoom + .1), zout: () => setZoom(Doc.zoom - .1), z100: () => setZoom(1),
  panels: () => { foldPane("L"); foldPane("R"); },

  /* clipboard */
  cut: () => { if (editing()) { editor().focus(); document.execCommand("cut"); onEdited(); } },
  copy: () => { if (Doc.mode === "edit") { editor().focus(); document.execCommand("copy"); toast("Copied"); } },
  paste: async () => {
    if (!editing()) return;
    editor().focus();
    try {
      const text = await navigator.clipboard.readText();
      if (text) { document.execCommand("insertText", false, text); onEdited(); return; }
    } catch { /* the browser guards the clipboard unless the user allows it */ }
    toast("Press ⌘V to paste — browsers only allow that from the keyboard", "warn");
  },
  formatPainter,

  /* font */
  fontGrow: () => bumpFontSize(1), fontShrink: () => bumpFontSize(-1),

  /* paragraph */
  indent: () => styleBlocks(b => { b.style.marginLeft = (px(b.style.marginLeft) + 36) + "px"; }),
  outdent: () => styleBlocks(b => { b.style.marginLeft = Math.max(0, px(b.style.marginLeft) - 36) + "px"; }),
  spacingBefore: () => styleBlocks(b => { b.style.marginTop = (px(b.style.marginTop) + 6) + "px"; }),
  spacingAfter: () => styleBlocks(b => { b.style.marginBottom = (px(b.style.marginBottom) + 6) + "px"; }),
  spacingReset: () => styleBlocks(b => { b.style.marginTop = b.style.marginBottom = b.style.marginLeft = ""; }, "Spacing reset"),
  paraBorder: () => styleBlocks(b => {
    b.style.border = b.style.border ? "" : "1px solid #8a8378";
    b.style.padding = b.style.border ? "8px 10px" : "";
  }),
  pageBorder: () => {
    const ed = editor();
    ed.style.outline = ed.style.outline ? "" : "2px solid #8a8378";
    ed.style.outlineOffset = ed.style.outline ? "-28px" : "";
    Doc.dirty = true; window.KilnProject?.touch();
    toast(ed.style.outline ? "Page border on" : "Page border off");
  },

  /* insert */
  image: insertImage, textBox: insertTextBox, pageBreak: insertPageBreak,
  hr: insertRule, dateNow: insertDate, comment: addComment, clearComments,
  rowAbove: () => tableOp("rowAbove"), rowBelow: () => tableOp("rowBelow"), delRow: () => tableOp("delRow"),
  colBefore: () => tableOp("colBefore"), colAfter: () => tableOp("colAfter"), delCol: () => tableOp("delCol"),

  /* review */
  find: () => toggleFind(true), findClose: () => toggleFind(false),
  findNext: () => gotoHit(Find.i + 1), findPrev: () => gotoHit(Find.i - 1),
  replaceOne, replaceAll,
  spellToggle: () => {
    const on = editor().spellcheck = !editor().spellcheck;
    $("spellBtn").textContent = `Spell check: ${on ? "on" : "off"}`;
    editor().blur(); editor().focus();
  },
};
const act = k => ACT[k]?.();

/* ---------------- ribbon construction ---------------- */
function buildRibbon() {
  $("fontSel").innerHTML = FONTS.map(f =>
    `<option value="${f}" style="font-family:'${f}'">${f}</option>`).join("");
  $("sizeSel").innerHTML = SIZES.map(s => `<option value="${s}">${s}</option>`).join("");
  $("sizeSel").value = "11";
  $("styleRow").innerHTML = STYLES.map(([tag, name]) =>
    `<button class="sgal" data-style="${tag}">${name}</button>`).join("");
  // table size picker
  const g = $("tgrid");
  g.innerHTML = Array.from({ length: 80 }, (_, k) =>
    `<i data-r="${Math.floor(k / 10) + 1}" data-c="${(k % 10) + 1}"></i>`).join("");
  g.addEventListener("mouseover", e => {
    const c = e.target.closest("i");
    if (!c) return;
    const R = +c.dataset.r, C = +c.dataset.c;
    [...g.children].forEach(x => x.classList.toggle("on", +x.dataset.r <= R && +x.dataset.c <= C));
    $("tglab").textContent = `${R} × ${C} table`;
  });
  g.addEventListener("click", e => {
    const c = e.target.closest("i");
    if (!c) return;
    insertTable(+c.dataset.r, +c.dataset.c);
    $("tablePop").classList.remove("on");
  });
  $("symgrid").innerHTML = SYMBOLS.map(s => `<button data-sym="${s}">${s}</button>`).join("");
  $("symgrid").addEventListener("click", e => {
    const b = e.target.closest("[data-sym]");
    if (b) { insertHtml(b.dataset.sym); $("symPop").classList.remove("on"); }
  });
  applyPage();
  measureRibbon();
}
/* the find bar hangs below the ribbon, whose height depends on the active tab */
function measureRibbon() {
  document.body.style.setProperty("--ribbonH", $("ribbon").offsetHeight + "px");
}
function renderRibbonStats() {
  const t = textOf();
  $("rstats").innerHTML = [
    ["Words", words(t)], ["Characters", t.length],
    ["Paragraphs", liveRoot()?.querySelectorAll("p,h1,h2,h3,h4,li").length || 0],
    ["Reading time", Math.max(1, Math.round(words(t) / 220)) + " min"],
  ].map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join("");
}

/* ---------------- render + wiring ---------------- */
function renderAll() {
  renderRibbonStats();
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

  /* ---- ribbon ---- */
  buildRibbon();
  document.querySelectorAll(".rtab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".rtab").forEach(x => x.classList.toggle("on", x === t));
    document.querySelectorAll(".rpanel").forEach(p => p.classList.toggle("on", p.id === t.dataset.rtab));
    measureRibbon();
  }));
  $("fontSel").addEventListener("change", e => cmd("fontName", e.target.value));
  $("sizeSel").addEventListener("change", e => setFontSize(+e.target.value));
  $("lineSel").addEventListener("change", e => styleBlocks(b => { b.style.lineHeight = e.target.value; }));
  $("foreColor").addEventListener("input", e => {
    e.target.parentElement.querySelector("i").style.background = e.target.value;
    cmd("foreColor", e.target.value);
  });
  $("backColor").addEventListener("input", e => {
    e.target.parentElement.querySelector("i").style.background = e.target.value;
    cmd("hiliteColor", e.target.value);
  });
  $("shadeColor").addEventListener("input", e => {
    e.target.parentElement.querySelector("i").style.background = e.target.value;
    styleBlocks(b => { b.style.backgroundColor = e.target.value; });
  });
  // pop-outs: table grid, shapes, symbols
  document.addEventListener("click", e => {
    const trigger = e.target.closest("[data-pop]");
    document.querySelectorAll(".pop").forEach(p => {
      if (!trigger || p.id !== trigger.dataset.pop) p.classList.remove("on");
    });
    if (trigger) { e.stopPropagation(); $(trigger.dataset.pop).classList.toggle("on"); }
    const shape = e.target.closest("[data-shape]");
    if (shape) insertShape(shape.dataset.shape);
    const style = e.target.closest(".sgal");
    if (style) setBlock(style.dataset.style);
  });
  // page layout
  const layout = () => { Page.size = $("pageSize").value; Page.orient = $("pageOrient").value;
    Page.margin = $("pageMargin").value; Page.cols = +$("pageCols").value; applyPage(); Doc.dirty = true; window.KilnProject?.touch(); };
  ["pageSize", "pageOrient", "pageMargin", "pageCols"].forEach(id => $(id).addEventListener("change", layout));
  // find & replace
  $("findIn").addEventListener("input", () => runFind());
  $("findCase").addEventListener("change", () => runFind());
  $("findIn").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? gotoHit(Find.i - 1) : gotoHit(Find.i + 1); }
    if (e.key === "Escape") toggleFind(false);
  });
  $("replIn").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); replaceOne(); } });

  const dz = $("dz");
  dz.addEventListener("click", e => { if (!e.target.closest("button")) $("fileMain").click(); });
  dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") $("fileMain").click(); });
  $("fileMain").addEventListener("change", e => { openFile(e.target.files[0]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach(ev => $("stage").addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => $("stage").addEventListener(ev, () => dz.classList.remove("over")));
  $("stage").addEventListener("drop", e => { e.preventDefault(); openFile(e.dataTransfer.files[0]); });

  editor().addEventListener("input", onEdited);
  editor().addEventListener("keyup", syncRibbon);
  editor().addEventListener("mouseup", () => { applyPainter(); syncRibbon(); });
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
    if (k === "f") { e.preventDefault(); toggleFind(true); }
    else if (k === "o") { e.preventDefault(); act("open"); }
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
  Doc, Page, act, setMode, openBytes, sampleBytes, buildDocx, blocksOf, exportDocx,
  cmd, setBlock, textOf, words, headings, setZoom, panels, toggleSec, foldPane,
  insertTable, tableOp, insertShape, insertTextBox, setFontSize, styleBlocks,
  selectedBlocks, runFind, replaceOne, replaceAll, toggleFind, Find, applyPage,
  html: () => (Doc.mode === "edit" ? editor().innerHTML : Doc.html),
};

/* ---------------- the project system ----------------
   Two things are worth keeping and they are not the same thing: the editable
   content, which is HTML the editor owns, and the original .docx, which is
   what Read mode goes back to and what an export rebuilds from. The first is
   the document, the second is an asset, and losing either one loses something
   the other cannot replace. */
window.KilnProject?.register({
  kind: "docs", schema: 1, newName: "Untitled document",
  async snapshot() {
    Doc.uid ||= "doc_" + Math.random().toString(36).slice(2, 10);
    const assets = Doc.bytes
      ? [{ id: Doc.uid, name: Doc.name || "original.docx", size: Doc.bytes.byteLength,
           type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           blob: new Blob([Doc.bytes.slice()]) }]
      : [];
    return {
      doc: {
        name: Doc.name, mode: Doc.mode, zoom: Doc.zoom,
        html: Doc.mode === "edit" ? editor().innerHTML : Doc.html,
        original: assets.length ? Doc.uid : null,
        page: { ...Page },
      },
      assets, history: null,
    };
  },
  async restore(doc, assets) {
    const blob = doc.original ? assets.get(doc.original) : null;
    Doc.bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    Doc.uid = doc.original || null;
    Doc.name = doc.name || "Untitled.docx";
    Doc.size = Doc.bytes ? Doc.bytes.byteLength : 0;
    Doc.html = doc.html || "";
    Doc.open = true;
    Doc.dirty = false;
    Doc.messages = [];
    Object.assign(Page, doc.page || {});
    $("dz").hidden = true;
    await setMode(doc.mode === "view" && Doc.bytes ? "view" : "edit");
    applyPage();
    renderAll();
  },
  reset() { blankDocument(); },
});
