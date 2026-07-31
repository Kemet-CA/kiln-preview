/* ============================================================
   Kiln PDF editor — engine
   Two libraries, clear division of labour:
     pdf.js   reads and rasterises  (viewer, thumbnails, text, outline)
     pdf-lib  writes                (export, merge, blank pages, watermark)
   A document is a *page list* pointing into one or more source files.
   Nothing is destroyed until you export, and export rebuilds from the
   original bytes — so quality never degrades through an edit session.
   ============================================================ */
import * as pdfjs from "./vendor/pdf.mjs";
const { TextLayer, setLayerDimensions } = pdfjs;
import {
  PDFDocument, StandardFonts, BlendMode, PDFName, PDFString, PDFHexString, degrees, rgb,
} from "./vendor/pdf-lib.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
const STD_FONTS = new URL("./vendor/standard_fonts/", import.meta.url).href;

const PT = 96 / 72;                    // 1 PDF point in CSS pixels at 100%
const DPR = Math.min(devicePixelRatio || 1, 2);
const ZOOMS = [.25, .33, .5, .67, .75, 1, 1.25, 1.5, 2, 3, 4];

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
  setTimeout(() => { t.style.opacity = "0"; t.style.transform = "translateX(10px)"; }, 2400);
  setTimeout(() => t.remove(), 2750);
  return t;
}
function download(bytes, name, type = "application/pdf") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- document model ---------------- */
const Doc = {
  open: false,
  name: "",
  size: 0,
  ver: "",
  sources: [],          // { id, name, bytes, doc }  — bytes kept for pdf-lib, doc is the pdf.js proxy
  pages: [],            // { sid, idx, rot, ann[] }  — the edit list; rot is absolute (0/90/180/270)
  bookmarks: [],        // { title, page, depth }    — read from the file, editable, written on export
  sel: new Set(),
  cur: 1,
  zoom: 1,
  fit: "width",         // "width" | "page" | null
  meta: { title: "", author: "", subject: "", keywords: "" },
  effects: {
    watermark: { on: false, text: "DRAFT", size: 60, angle: 45, opacity: .18, color: "#e2622a" },
    numbers:   { on: false, format: "n of N", pos: "bottom-center", size: 10, start: 1, skipFirst: false },
  },
};
const Hist = { steps: [], i: -1 };
const source = sid => Doc.sources.find(s => s.id === sid);
const pageKey = p => `${p.sid}:${p.idx}:${p.rot}`;
let nextSid = 1;

/* ---------------- history ---------------- */
const snapshot = () => ({
  pages: Doc.pages.map(clonePage),
  bookmarks: Doc.bookmarks.map(b => ({ ...b })),
  meta: { ...Doc.meta },
  effects: JSON.parse(JSON.stringify(Doc.effects)),
});
function commit(label) {
  Hist.steps = Hist.steps.slice(0, Hist.i + 1);
  Hist.steps.push({ label, state: snapshot() });
  if (Hist.steps.length > 60) Hist.steps.shift();
  Hist.i = Hist.steps.length - 1;
  renderHistory();
}
function restore(i) {
  if (i < 0 || i >= Hist.steps.length) return;
  Hist.i = i;
  const s = Hist.steps[i].state;
  Doc.pages = s.pages.map(clonePage);
  Doc.bookmarks = s.bookmarks.map(b => ({ ...b }));
  Doc.meta = { ...s.meta };
  Doc.effects = JSON.parse(JSON.stringify(s.effects));
  Doc.sel.clear();
  Doc.cur = clamp(Doc.cur, 1, Math.max(1, Doc.pages.length));
  renderAll();
}
const undo = () => { if (Hist.i > 0) restore(Hist.i - 1); };
const redo = () => { if (Hist.i < Hist.steps.length - 1) restore(Hist.i + 1); };

/* ---------------- loading ---------------- */
async function addSource(bytes, name) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const task = pdfjs.getDocument({
    data: u8.slice(),                 // pdf.js transfers its buffer to the worker — hand it a copy
    standardFontDataUrl: STD_FONTS,
    isEvalSupported: false,
  });
  task.onPassword = (cb, reason) => {
    const pw = prompt(reason === 1 ? "This PDF is password protected. Password:" : "Wrong password. Try again:");
    if (pw === null) task.destroy(); else cb(pw);
  };
  const doc = await task.promise;
  const src = { id: nextSid++, name, bytes: u8, doc, task };
  Doc.sources.push(src);
  return src;
}
function pagesOf(src, rotFrom) {
  const out = [];
  for (let i = 0; i < src.doc.numPages; i++) out.push({ sid: src.id, idx: i, rot: rotFrom?.[i] ?? 0, ann: [] });
  return out;
}
/* pages are copied a lot — by history, by duplicate — and annotations must not
   be shared between the copies, or editing one would edit the other */
const clonePage = p => ({ ...p, ann: (p.ann || []).map(a => ({ ...a, quads: a.quads?.map(q => ({ ...q })), pts: a.pts?.map(pt => [...pt]) })) });
/* A history snapshot keeps annotation ids — undo has to restore the same marks.
   A *duplicated page* must not: two copies sharing an id means deleting one
   deletes the other, since annotations are addressed by id alone. */
const forkPage = p => { const c = clonePage(p); c.ann.forEach(a => { a.id = annSeq++; }); return c; };
async function baseRotations(src) {
  const rots = [];
  for (let i = 1; i <= src.doc.numPages; i++) rots.push(((await src.doc.getPage(i)).rotate % 360 + 360) % 360);
  return rots;
}

async function openBytes(bytes, name) {
  status("Opening…");
  resetDoc();
  const src = await addSource(bytes, name);
  Doc.pages = pagesOf(src, await baseRotations(src));
  Doc.open = true;
  Doc.name = name;
  Doc.size = src.bytes.byteLength;
  Doc.cur = 1;
  const info = await src.doc.getMetadata().catch(() => null);
  Doc.ver = info?.info?.PDFFormatVersion || "1.7";
  Doc.meta = {
    title: info?.info?.Title || "", author: info?.info?.Author || "",
    subject: info?.info?.Subject || "", keywords: info?.info?.Keywords || "",
  };
  $("dz").hidden = true;
  Hist.steps = []; Hist.i = -1;
  commit("Open");
  await loadOutline(src);
  renderAll();
  if (Doc.fit) await applyFit();
  status("Ready");
  toast(`${esc(name)} — ${plural(Doc.pages.length, "page")}`);
}
function resetDoc() {
  Doc.sources.forEach(s => s.task.destroy());   // releases the worker copy of the file
  Doc.sources = []; Doc.pages = []; Doc.sel.clear();
  thumbCache.clear(); textCache.clear();
  Doc.outline = [];
}
async function openFile(file) {
  if (!file) return;
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name))
    return toast("That is not a PDF", "bad");
  try { await openBytes(new Uint8Array(await file.arrayBuffer()), file.name); }
  catch (e) { status("Failed"); toast("Could not open: " + (e?.message || e), "bad"); }
}

/* sample document — built here with pdf-lib, so it is a real file, not a picture of one */
async function sampleBytes() {
  const d = await PDFDocument.create();
  const reg = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  const ember = rgb(.886, .384, .165), ink = rgb(.13, .11, .1), grey = rgb(.45, .42, .4);
  const body = [
    "Every page you see is rendered by pdf.js from the real file.",
    "Rotate, delete, duplicate and reorder pages in the Pages panel;",
    "drag a thumbnail to move it. Nothing is rewritten until you export.",
    "Export rebuilds the document with pdf-lib from the original bytes,",
    "so pages keep their vectors, fonts and full resolution.",
  ];
  for (let i = 0; i < 6; i++) {
    const p = d.addPage([595.28, 841.89]);           // A4
    p.drawRectangle({ x: 0, y: 781, width: 595.28, height: 61, color: ember, opacity: i ? .12 : 1 });
    p.drawText(i ? `Section ${i}` : "Kiln", {
      x: 48, y: 802, size: i ? 20 : 28, font: bold, color: i ? ink : rgb(1, .97, .93),
    });
    if (!i) p.drawText("Sample document", { x: 48, y: 742, size: 15, font: reg, color: grey });
    body.forEach((line, n) => p.drawText(line, { x: 48, y: 690 - n * 22, size: 11.5, font: reg, color: ink }));
    p.drawText(`Page ${i + 1} of 6`, { x: 48, y: 44, size: 9, font: reg, color: grey });
    p.drawLine({ start: { x: 48, y: 60 }, end: { x: 547, y: 60 }, thickness: .7, color: rgb(.8, .77, .74) });
    for (let b = 0; b < 3; b++)
      p.drawRectangle({ x: 48 + b * 172, y: 300, width: 152, height: 152, color: [ember, rgb(.42, .55, .77), rgb(.5, .66, .54)][b], opacity: .85 });
  }
  d.setTitle("Kiln sample document"); d.setAuthor("Kiln"); d.setProducer("Kiln");
  return d.save();
}

/* ---------------- bookmarks ----------------
   Read out of the file as a flat list carrying its nesting depth, edited here,
   and written back as a real outline tree on export. Before this existed the
   editor quietly dropped a document's bookmarks the moment you exported. */
async function loadOutline(src) {
  Doc.bookmarks = [];
  try {
    const raw = await src.doc.getOutline();
    if (!raw) return;
    const walk = async (items, depth) => {
      for (const it of items) {
        let idx = null;
        try {
          const dest = typeof it.dest === "string" ? await src.doc.getDestination(it.dest) : it.dest;
          if (dest?.[0]) idx = await src.doc.getPageIndex(dest[0]);
        } catch { /* unresolvable destination — still keep the title */ }
        const page = idx === null ? -1 : Doc.pages.findIndex(p => p.sid === src.id && p.idx === idx);
        if (it.title) Doc.bookmarks.push({ title: it.title, page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(raw, 0);
  } catch { /* no outline */ }
}
function addBookmark() {
  if (!Doc.open) return toast("Open a document first", "warn");
  const title = prompt("Bookmark title", `Page ${Doc.cur}`);
  if (title === null || !title.trim()) return;
  const at = Doc.bookmarks.findIndex(b => b.page > Doc.cur - 1);
  const item = { title: title.trim(), page: Doc.cur - 1, depth: 0 };
  at === -1 ? Doc.bookmarks.push(item) : Doc.bookmarks.splice(at, 0, item);
  commit("Add bookmark");
  renderOutline();
  toast("Bookmark added");
}
function renameBookmark(i) {
  const b = Doc.bookmarks[i];
  if (!b) return;
  const title = prompt("Bookmark title", b.title);
  if (title === null || !title.trim()) return;
  b.title = title.trim();
  commit("Rename bookmark");
  renderOutline();
}
function deleteBookmark(i) {
  if (!Doc.bookmarks[i]) return;
  Doc.bookmarks.splice(i, 1);
  commit("Delete bookmark");
  renderOutline();
}

/* ---------------- rendering: viewer ---------------- */
const viewerScale = () => Doc.zoom * PT;
let renderToken = 0;

async function viewportFor(p, scale) {
  const page = await source(p.sid).doc.getPage(p.idx + 1);
  return { page, vp: page.getViewport({ scale, rotation: p.rot }) };
}

function buildViewer() {
  const host = $("pages");
  host.innerHTML = "";
  Doc.pages.forEach((p, i) => {
    const el = document.createElement("div");
    el.className = "pg" + (Doc.sel.has(i) ? " sel" : "");
    el.dataset.i = i;
    el.innerHTML = `<canvas></canvas><div class="hitl"></div><div class="textLayer"></div>` +
      `<svg class="annl" xmlns="http://www.w3.org/2000/svg"></svg>` +
      `<div class="pgov"></div><div class="pglab num">${i + 1}</div>`;
    host.appendChild(el);
  });
  sizePages();
  observeViewer();
}

/* Give every page its box before any pixels exist, so the scrollbar is
   right immediately and lazy rendering has something to observe. */
async function sizePages() {
  const scale = viewerScale();
  const els = [...$("pages").children];
  for (let i = 0; i < Doc.pages.length; i++) {
    const p = Doc.pages[i], el = els[i];
    if (!el) continue;
    const { vp } = await viewportFor(p, scale);
    const c = el.querySelector("canvas");
    c.style.width = vp.width + "px";
    c.style.height = vp.height + "px";
    el.style.width = vp.width + "px";
    el.dataset.w = vp.width; el.dataset.h = vp.height;
    el.__vp = vp;                       // annotations convert screen ↔ page through this
    drawOverlay(el, i, vp);
    paintAnnots(i);
  }
}

let io;
function observeViewer() {
  io?.disconnect();
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      if (e.isIntersecting) renderViewerPage(i);
      else if (Doc.pages.length > 24) freePage(e.target);   // long documents: reclaim offscreen bitmaps
    }
    // while a jump-to-page scroll is still animating, the pages sliding past
    // must not steal the current page back from where we were sent
    const vis = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (vis && performance.now() > navUntil) setCurrent(+vis.target.dataset.i + 1, false);
  }, { root: $("vp"), rootMargin: "400px 0px", threshold: [0, .25, .6] });
  [...$("pages").children].forEach(el => io.observe(el));
}
function freePage(el) {
  const c = el.querySelector("canvas");
  if (!c.dataset.key) return;
  c.width = c.height = 0; delete c.dataset.key;
}

const pending = new Map();
async function renderViewerPage(i) {
  const p = Doc.pages[i], el = $("pages").children[i];
  if (!p || !el) return;
  const c = el.querySelector("canvas");
  const scale = viewerScale();
  const key = pageKey(p) + ":" + scale.toFixed(3);
  if (c.dataset.key === key || pending.get(i) === key) return;
  pending.set(i, key);
  const token = renderToken;
  try {
    const { page, vp } = await viewportFor(p, scale);
    if (token !== renderToken) return;
    const dvp = page.getViewport({ scale: scale * DPR, rotation: p.rot });
    c.width = Math.round(dvp.width); c.height = Math.round(dvp.height);
    c.style.width = vp.width + "px"; c.style.height = vp.height + "px";
    const task = page.render({ canvas: c, canvasContext: c.getContext("2d", { alpha: false }), viewport: dvp });
    await task.promise;
    if (token !== renderToken) return;
    c.dataset.key = key;
    el.__vp = vp;
    drawOverlay(el, i, vp);
    paintAnnots(i);
    await buildTextLayer(el, page, vp, token);
    paintHits(i);
  } catch (e) {
    if (e?.name !== "RenderingCancelledException") console.warn("render", i, e);
  } finally {
    if (pending.get(i) === key) pending.delete(i);
  }
}

/* Real, selectable text sits over the rendered page: pdf.js positions one
   transparent span per text run, so you can select and copy exactly what the
   document says. Built by the library, not by hand — glyph transforms, rotated
   runs and right-to-left text are its problem, not ours. */
async function buildTextLayer(el, page, vp, token) {
  const host = el.querySelector(".textLayer");
  if (!host) return;
  host.__layer?.cancel();
  host.textContent = "";
  // pdf.js sizes the layer from these custom properties; the viewer sets them too
  host.style.setProperty("--total-scale-factor", String(viewerScale()));
  host.style.setProperty("--scale-round-x", "1px");
  host.style.setProperty("--scale-round-y", "1px");
  setLayerDimensions(host, vp);
  const layer = new TextLayer({ textContentSource: page.streamTextContent(), container: host, viewport: vp });
  host.__layer = layer;
  await layer.render();
  if (token !== renderToken) { layer.cancel(); host.textContent = ""; }
}

/* watermark + page numbers are previewed as an overlay and only written
   into real page content at export — so toggling them costs nothing. */
function drawOverlay(el, i, vp) {
  const ov = el.querySelector(".pgov");
  if (!ov) return;
  const scale = viewerScale();                    // css pixels per PDF point
  ov.style.width = vp.width + "px";
  ov.style.height = vp.height + "px";
  const e = Doc.effects;
  let html = "";
  if (e.watermark.on && e.watermark.text) {
    html += `<span class="wm" style="font-size:${e.watermark.size * scale}px;color:${esc(e.watermark.color)};
      opacity:${e.watermark.opacity};transform:translate(-50%,-50%) rotate(${-e.watermark.angle}deg)">${esc(e.watermark.text)}</span>`;
  }
  if (e.numbers.on) {
    const n = pageNumberFor(i);
    if (n !== null) html += `<span class="pn ${e.numbers.pos}" style="font-size:${e.numbers.size * scale}px">${esc(n)}</span>`;
  }
  ov.innerHTML = html;
}
function pageNumberFor(i) {
  const e = Doc.effects.numbers;
  if (e.skipFirst && i === 0) return null;
  const n = e.start + i - (e.skipFirst ? 1 : 0);
  const total = Doc.pages.length - (e.skipFirst ? 1 : 0) + e.start - 1;
  return e.format === "n of N" ? `${n} of ${total}` : e.format === "Page n" ? `Page ${n}` : String(n);
}

function repaint() {
  renderToken++;
  pending.clear();
  [...$("pages").children].forEach(el => { const c = el.querySelector("canvas"); delete c.dataset.key; });
  sizePages().then(() => {
    [...$("pages").children].forEach((el, i) => {
      const r = el.getBoundingClientRect(), vr = $("vp").getBoundingClientRect();
      if (r.bottom > vr.top - 400 && r.top < vr.bottom + 400) renderViewerPage(i);
    });
  });
}

/* ---------------- rendering: thumbnails ---------------- */
const thumbCache = new Map();   // pageKey -> dataURL
const THUMB_W = 150;

function buildThumbs() {
  const host = $("thumbs");
  if (!Doc.pages.length) { host.innerHTML = `<div class="empty">No document open.</div>`; return; }
  host.innerHTML = Doc.pages.map((p, i) => {
    const cached = thumbCache.get(pageKey(p));
    return `<div class="th${Doc.sel.has(i) ? " sel" : ""}${Doc.cur === i + 1 ? " cur" : ""}" data-i="${i}" draggable="true">
      <div class="th-c">${cached ? `<img src="${cached}" alt="">` : ""}</div>
      <div class="th-n num">${i + 1}</div></div>`;
  }).join("");
  queueThumbs();
}
let thumbQueue = [];
function queueThumbs() {
  thumbQueue = Doc.pages.map((p, i) => i).filter(i => !thumbCache.has(pageKey(Doc.pages[i])));
  drainThumbs();
}
let draining = false;
async function drainThumbs() {
  if (draining) return;
  draining = true;
  while (thumbQueue.length) {
    const i = thumbQueue.shift();
    const p = Doc.pages[i];
    if (!p) continue;
    const key = pageKey(p);
    if (!thumbCache.has(key)) {
      try {
        const page = await source(p.sid).doc.getPage(p.idx + 1);
        const v1 = page.getViewport({ scale: 1, rotation: p.rot });
        const vp = page.getViewport({ scale: (THUMB_W * DPR) / v1.width, rotation: p.rot });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvas: c, canvasContext: c.getContext("2d", { alpha: false }), viewport: vp }).promise;
        thumbCache.set(key, c.toDataURL("image/webp", .8));
      } catch { thumbCache.set(key, ""); }
    }
    const slot = $("thumbs").querySelector(`.th[data-i="${i}"] .th-c`);
    if (slot && thumbCache.get(key)) slot.innerHTML = `<img src="${thumbCache.get(key)}" alt="">`;
  }
  draining = false;
}

/* ---------------- selection ---------------- */
let anchor = 0;
function selectPage(i, ev = {}) {
  if (ev.shiftKey) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    Doc.sel.clear();
    for (let k = a; k <= b; k++) Doc.sel.add(k);
  } else if (ev.metaKey || ev.ctrlKey) {
    Doc.sel.has(i) ? Doc.sel.delete(i) : Doc.sel.add(i);
    anchor = i;
  } else {
    Doc.sel.clear(); Doc.sel.add(i); anchor = i;
  }
  setCurrent(i + 1, true);
  renderSelection();
}
const selected = () => Doc.sel.size ? [...Doc.sel].sort((a, b) => a - b) : [];
const target = () => Doc.sel.size ? selected() : Doc.pages.map((_, i) => i);
function renderSelection() {
  [...$("thumbs").children].forEach((el, i) => {
    el.classList.toggle("sel", Doc.sel.has(i));
    el.classList.toggle("cur", Doc.cur === i + 1);
  });
  [...$("pages").children].forEach((el, i) => el.classList.toggle("sel", Doc.sel.has(i)));
  syncStatus();
  renderProps();
}
let navUntil = 0;
function setCurrent(n, scroll) {
  Doc.cur = clamp(n, 1, Math.max(1, Doc.pages.length));
  if (scroll) navUntil = performance.now() + 700;
  $("pgNum").value = Doc.cur;
  if (scroll) $("pages").children[Doc.cur - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  [...$("thumbs").children].forEach((el, i) => el.classList.toggle("cur", Doc.cur === i + 1));
  if (scroll) $("thumbs").children[Doc.cur - 1]?.scrollIntoView({ block: "nearest" });
  // patch the two rows that follow the current page, rather than rebuilding the
  // panel on every scroll tick and stealing focus from the metadata fields
  const cur = $("kvCur"), rot = $("kvRot"), p = Doc.pages[Doc.cur - 1];
  if (cur) cur.textContent = Doc.open ? `${Doc.cur} of ${Doc.pages.length}` : "—";
  if (rot) rot.textContent = p ? p.rot + "°" : "—";
  syncStatus();
}

/* ---------------- page operations ---------------- */
function rotatePages(list, delta) {
  if (!Doc.pages.length) return;
  list.forEach(i => { const p = Doc.pages[i]; if (p) p.rot = ((p.rot + delta) % 360 + 360) % 360; });
  commit(delta > 0 ? "Rotate right" : "Rotate left");
  renderAll();
  if (Doc.fit) applyFit();     // a turned page is a different shape — fit it again
}
function deletePages(list) {
  if (!list.length) return toast("Select pages first", "warn");
  if (list.length >= Doc.pages.length) return toast("A document needs at least one page", "warn");
  const keep = Doc.pages.filter((_, i) => !list.includes(i));
  Doc.pages = keep;
  Doc.sel.clear();
  commit("Delete pages");
  renderAll();
  toast(`${plural(list.length, "page")} deleted`);
}
function duplicatePages(list) {
  if (!list.length) return toast("Select pages first", "warn");
  const out = [];
  Doc.pages.forEach((p, i) => { out.push(p); if (list.includes(i)) out.push(forkPage(p)); });
  Doc.pages = out;
  Doc.sel.clear();
  commit("Duplicate pages");
  renderAll();
  toast(`${plural(list.length, "page")} duplicated`);
}
function movePages(list, to) {
  const moving = list.map(i => Doc.pages[i]).filter(Boolean);
  if (!moving.length) return;
  const rest = Doc.pages.filter((_, i) => !list.includes(i));
  const before = list.filter(i => i < to).length;
  const at = clamp(to - before, 0, rest.length);
  Doc.pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  Doc.sel = new Set(moving.map((_, k) => at + k));
  commit("Reorder pages");
  renderAll();
}
async function insertBlank() {
  const ref = Doc.pages[Doc.cur - 1];
  let w = 595.28, h = 841.89;
  if (ref) {
    const { vp } = await viewportFor(ref, 1);
    w = vp.width; h = vp.height;
  }
  const d = await PDFDocument.create();
  d.addPage([w, h]);
  const src = await addSource(await d.save(), "Blank page");
  Doc.pages.splice(Doc.cur, 0, { sid: src.id, idx: 0, rot: 0 });
  commit("Insert blank page");
  renderAll();
  setCurrent(Doc.cur + 1, true);
  toast("Blank page inserted");
}
async function insertFiles(files) {
  let added = 0;
  for (const f of files) {
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") { toast(`${f.name} is not a PDF`, "warn"); continue; }
    try {
      const src = await addSource(new Uint8Array(await f.arrayBuffer()), f.name);
      const pages = pagesOf(src, await baseRotations(src));
      Doc.pages.splice(Doc.cur, 0, ...pages);
      added += pages.length;
      Doc.cur += pages.length;
    } catch (e) { toast(`Could not read ${f.name}`, "bad"); }
  }
  if (!added) return;
  commit("Insert pages");
  renderAll();
  toast(`${plural(added, "page")} inserted`);
}

/* ---------------- build & export (pdf-lib) ---------------- */
async function buildPdf(list = Doc.pages.map((_, i) => i)) {
  const out = await PDFDocument.create();
  const wanted = list.map(i => Doc.pages[i]).filter(Boolean);

  // one copyPages call per source, occurrence-aligned so duplicates stay independent
  const bySrc = new Map();
  wanted.forEach((p, slot) => {
    if (!bySrc.has(p.sid)) bySrc.set(p.sid, []);
    bySrc.get(p.sid).push({ slot, idx: p.idx });
  });
  const slots = new Array(wanted.length);
  for (const [sid, occ] of bySrc) {
    const lib = await PDFDocument.load(source(sid).bytes, { ignoreEncryption: true });
    const copies = await out.copyPages(lib, occ.map(o => o.idx));
    occ.forEach((o, k) => { slots[o.slot] = copies[k]; });
  }
  slots.forEach((page, k) => { page.setRotation(degrees(wanted[k].rot)); out.addPage(page); });

  await drawAnnots(out, wanted);
  await applyEffects(out, list);
  writeOutline(out, list);

  const m = Doc.meta;
  if (m.title) out.setTitle(m.title);
  if (m.author) out.setAuthor(m.author);
  if (m.subject) out.setSubject(m.subject);
  if (m.keywords) out.setKeywords(m.keywords.split(/\s*,\s*/).filter(Boolean));
  out.setProducer("Kiln");
  out.setModificationDate(new Date());
  return out.save();
}

/* Annotations are drawn into the page itself, so they look identical in every
   viewer — no reliance on the reader generating appearance streams. Notes have
   no visual of their own, so they also become a real /Text annotation carrying
   the comment, which is what a sticky note actually is. */
async function drawAnnots(out, wanted) {
  if (!wanted.some(p => p.ann?.length)) return;
  const font = await out.embedFont(StandardFonts.Helvetica);
  const pages = out.getPages();
  wanted.forEach((p, k) => {
    const page = pages[k];
    for (const a of p.ann || []) {
      const color = hexToRgb(a.color);
      if (a.t === "highlight")
        for (const q of a.quads)
          page.drawRectangle({
            x: q.x, y: q.y, width: q.w, height: q.h, color,
            opacity: .38, blendMode: BlendMode.Multiply,
          });
      else if (a.t === "box")
        page.drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, borderColor: color, borderWidth: a.sw });
      else if (a.t === "draw")
        for (let n = 1; n < a.pts.length; n++)
          page.drawLine({
            start: { x: a.pts[n - 1][0], y: a.pts[n - 1][1] },
            end: { x: a.pts[n][0], y: a.pts[n][1] },
            thickness: a.sw, color,
          });
      else if (a.t === "text")
        page.drawText(a.text, { x: a.x, y: a.y - a.size, size: a.size, font, color });
      else if (a.t === "note") {
        const s = 15;
        page.drawRectangle({ x: a.x - s / 2, y: a.y - s / 2, width: s, height: s, color, opacity: .95 });
        const [r, g, b] = hexToArr(a.color);
        page.node.addAnnot(out.context.register(out.context.obj({
          Type: "Annot", Subtype: "Text", Name: "Comment", F: 4,
          Rect: [a.x - s / 2, a.y - s / 2, a.x + s / 2, a.y + s / 2],
          Contents: PDFHexString.fromText(a.text),
          T: PDFHexString.fromText("Kiln"), C: [r, g, b],
        })));
      }
    }
  });
}

/* Bookmarks back into the file as a real outline tree. Without this, exporting
   silently threw away every bookmark the document arrived with. */
function writeOutline(out, list) {
  const items = Doc.bookmarks
    .map(b => ({ ...b, slot: list.indexOf(b.page) }))     // where the page ended up in this export
    .filter(b => b.slot >= 0);
  if (!items.length) return;
  const ctx = out.context, pages = out.getPages();
  const refs = items.map(b => ctx.register(ctx.obj({
    Title: PDFHexString.fromText(b.title),
    Dest: [pages[b.slot].ref, PDFName.of("XYZ"), null, null, null],
  })));

  // rebuild the nesting from the depth sequence, then link each level's siblings
  const nodes = items.map((b, i) => ({ ...b, ref: refs[i], kids: [] }));
  const roots = [], stack = [];
  nodes.forEach(n => {
    while (stack.length && stack[stack.length - 1].depth >= n.depth) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : roots).push(n);
    stack.push(n);
  });
  const link = (kids, parentRef) => {
    kids.forEach((n, i) => {
      const d = ctx.lookup(n.ref);
      d.set(PDFName.of("Parent"), parentRef);
      if (i) d.set(PDFName.of("Prev"), kids[i - 1].ref);
      if (i < kids.length - 1) d.set(PDFName.of("Next"), kids[i + 1].ref);
      if (n.kids.length) {
        d.set(PDFName.of("First"), n.kids[0].ref);
        d.set(PDFName.of("Last"), n.kids[n.kids.length - 1].ref);
        d.set(PDFName.of("Count"), ctx.obj(n.kids.length));
        link(n.kids, n.ref);
      }
    });
  };
  const rootRef = ctx.register(ctx.obj({
    Type: "Outlines", First: roots[0].ref, Last: roots[roots.length - 1].ref, Count: roots.length,
  }));
  link(roots, rootRef);
  out.catalog.set(PDFName.of("Outlines"), rootRef);
  out.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

async function applyEffects(out, list) {
  const e = Doc.effects;
  if (!e.watermark.on && !e.numbers.on) return;
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const pages = out.getPages();
  pages.forEach((page, k) => {
    const { width: W, height: H } = page.getSize();
    if (e.watermark.on && e.watermark.text) {
      const size = e.watermark.size, th = (e.watermark.angle * Math.PI) / 180;
      const w = bold.widthOfTextAtSize(e.watermark.text, size), h = bold.heightAtSize(size);
      page.drawText(e.watermark.text, {
        // pdf-lib rotates about the text origin, so offset the origin by the
        // rotated half-extent to land the middle of the string on the middle of the page
        x: W / 2 - (w / 2) * Math.cos(th) + (h / 3) * Math.sin(th),
        y: H / 2 - (w / 2) * Math.sin(th) - (h / 3) * Math.cos(th),
        size, font: bold, color: hexToRgb(e.watermark.color),
        opacity: e.watermark.opacity, rotate: degrees(e.watermark.angle),
      });
    }
    if (e.numbers.on) {
      const label = pageNumberFor(list[k] ?? k);
      if (label === null) return;
      const size = e.numbers.size, w = font.widthOfTextAtSize(label, size);
      const [vpos, hpos] = e.numbers.pos.split("-");
      const x = hpos === "left" ? 42 : hpos === "right" ? W - 42 - w : W / 2 - w / 2;
      const y = vpos === "top" ? H - 34 : 28;
      page.drawText(label, { x, y, size, font, color: rgb(.35, .33, .32) });
    }
  });
}
function hexToArr(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const hexToRgb = hex => rgb(...hexToArr(hex));

const stem = () => (Doc.name || "document").replace(/\.pdf$/i, "");
async function exportAll() {
  if (!Doc.open) return toast("Open a document first", "warn");
  status("Exporting…");
  const t = toast("Building PDF…");
  try {
    const bytes = await buildPdf();
    download(bytes, `${stem()}-kiln.pdf`);
    toast(`Exported ${plural(Doc.pages.length, "page")} · ${fmtB(bytes.byteLength)}`);
  } catch (e) { toast("Export failed: " + (e?.message || e), "bad"); }
  finally { t.remove(); status("Ready"); }
}
async function exportSelection() {
  const list = selected();
  if (!list.length) return toast("Select pages first", "warn");
  const bytes = await buildPdf(list);
  download(bytes, `${stem()}-pages-${list[0] + 1}${list.length > 1 ? "-" + (list[list.length - 1] + 1) : ""}.pdf`);
  toast(`Extracted ${plural(list.length, "page")}`);
}
async function splitAll() {
  if (!Doc.open) return toast("Open a document first", "warn");
  const n = Doc.pages.length;
  if (n > 30 && !confirm(`This downloads ${n} separate files. Continue?`)) return;
  status("Splitting…");
  for (let i = 0; i < n; i++) {
    download(await buildPdf([i]), `${stem()}-${String(i + 1).padStart(3, "0")}.pdf`);
    await new Promise(r => setTimeout(r, 90));       // let the browser keep up with the downloads
  }
  status("Ready");
  toast(`Split into ${plural(n, "file")}`);
}
async function printDoc() {
  if (!Doc.open) return toast("Open a document first", "warn");
  status("Preparing…");
  const url = URL.createObjectURL(new Blob([await buildPdf()], { type: "application/pdf" }));
  const w = open(url, "_blank");
  if (!w) toast("Allow pop-ups to print this document", "warn");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  status("Ready");
}
async function exportText() {
  if (!Doc.open) return toast("Open a document first", "warn");
  const out = [];
  for (let i = 0; i < Doc.pages.length; i++) {
    out.push(`--- Page ${i + 1} ---`, (await textOf(i)).text, "");
  }
  download(new TextEncoder().encode(out.join("\n")), `${stem()}.txt`, "text/plain");
  toast("Text extracted");
}

/* ---------------- text + search ---------------- */
const textCache = new Map();     // "sid:idx" -> { text, items }
async function textOf(i) {
  const p = Doc.pages[i];
  if (!p) return { text: "", items: [] };
  const key = `${p.sid}:${p.idx}`;
  if (textCache.has(key)) return textCache.get(key);
  const page = await source(p.sid).doc.getPage(p.idx + 1);
  const tc = await page.getTextContent();
  const items = [];
  let text = "";
  let span = 0;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    // The text layer renders a <span> per item that has glyphs and a <br> for the
    // empty end-of-line items, so only the former get a span index. Getting this
    // wrong silently shifts every highlight onto a neighbouring line.
    items.push({
      i: it.str.length ? span++ : -1,
      str: it.str, at: text.length, tr: it.transform, w: it.width, h: it.height,
    });
    text += it.str + (it.hasEOL ? "\n" : "");
  }
  const v = { text, items };
  textCache.set(key, v);
  return v;
}

let hits = [], hitI = -1, hitsByPage = new Map();
async function runSearch(q) {
  hits = []; hitI = -1; hitsByPage = new Map();
  if (!Doc.open || !q || q.length < 2) { renderHits(q); repaintHits(); return; }
  status("Searching…");
  const needle = q.toLowerCase();
  for (let i = 0; i < Doc.pages.length; i++) {
    const { text, items } = await textOf(i);
    const hay = text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1 && hits.length < 500) {
      const it = items.find(x => at >= x.at && at < x.at + x.str.length);
      hits.push({
        page: i, at,
        context: text.slice(Math.max(0, at - 34), at + q.length + 34).replace(/\s+/g, " ").trim(),
        item: it ? it.i : -1, off: it ? at - it.at : 0, len: q.length,
        box: it ? boxFor(it, at - it.at, q.length) : null,
      });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  hits.forEach((h, k) => {
    if (!hitsByPage.has(h.page)) hitsByPage.set(h.page, []);
    hitsByPage.get(h.page).push({ ...h, k });
  });
  status("Ready");
  renderHits(q);
  repaintHits();
  if (hits.length) gotoHit(0);
}
/* text-space rectangle for a substring, in unscaled page units */
function boxFor(it, start, len) {
  const [a, b, , , e, f] = it.tr;
  const per = it.str.length ? it.w / it.str.length : 0;
  return { x: e + per * start * (a >= 0 ? 1 : -1), y: f, w: per * len, h: it.h || 10, rot: Math.atan2(b, a) };
}
function renderHits(q) {
  const host = $("pSearch");
  if (!q) { host.innerHTML = `<div class="empty">Type in the search box to find text across every page.</div>`; return; }
  if (!hits.length) { host.innerHTML = `<div class="empty">No matches for “${esc(q)}”.</div>`; return; }
  host.innerHTML = `<div class="hcount">${plural(hits.length, "match")}${hits.length === 500 ? "+" : ""}</div>` +
    hits.map((h, k) => `<button class="hit${k === hitI ? " on" : ""}" data-h="${k}">
      <span class="hp num">p${h.page + 1}</span><span class="hx">${esc(h.context)}</span></button>`).join("");
  $("searchCount").textContent = hits.length ? `${hitI + 1}/${hits.length}` : "0";
}
function gotoHit(k) {
  if (!hits.length) return;
  hitI = (k + hits.length) % hits.length;
  const h = hits[hitI];
  setCurrent(h.page + 1, true);
  markCurrentHit();
  [...$("pSearch").querySelectorAll(".hit")].forEach((b, i) => b.classList.toggle("on", i === hitI));
  $("searchCount").textContent = `${hitI + 1}/${hits.length}`;
  $("pSearch").querySelector(`.hit[data-h="${hitI}"]`)?.scrollIntoView({ block: "nearest" });
  document.querySelector(`.hitmark[data-k="${hitI}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
}
const markCurrentHit = () =>
  document.querySelectorAll(".hitmark").forEach(m => m.classList.toggle("on", +m.dataset.k === hitI));

/* Every match stays highlighted while the search is live. The rectangle is
   measured off the text layer with a DOM Range — the browser knows exactly
   where those glyphs are, so highlights land on the word rather than near it.
   The transform-derived box is the fallback for a page not yet rendered. */
function rangeRects(spans, h, pageRect) {
  if (h.item < 0) return [];
  const node = spans[h.item]?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return [];
  const a = Math.min(h.off, node.length), b = Math.min(h.off + h.len, node.length);
  if (b <= a) return [];
  const r = document.createRange();
  r.setStart(node, a); r.setEnd(node, b);
  return [...r.getClientRects()]
    .filter(x => x.width > 0.5 && x.height > 0.5)
    .map(x => ({ x: x.left - pageRect.left, y: x.top - pageRect.top, w: x.width, h: x.height }));
}
async function paintHits(i) {
  const el = $("pages").children[i], list = hitsByPage.get(i);
  const host = el?.querySelector(".hitl");
  if (!host) return;
  host.textContent = "";
  if (!list?.length) return;
  const scale = viewerScale();
  const { vp } = await viewportFor(Doc.pages[i], scale);
  host.style.width = vp.width + "px";
  host.style.height = vp.height + "px";
  const spans = [...el.querySelectorAll(".textLayer span:not(.markedContent)")];
  const pageRect = el.getBoundingClientRect();
  const box = (h, r) => `<div class="hitmark${h.k === hitI ? " on" : ""}" data-k="${h.k}"
    style="left:${r.x}px;top:${r.y}px;width:${Math.max(5, r.w)}px;height:${r.h}px"></div>`;
  host.innerHTML = list.map(h => {
    const rects = rangeRects(spans, h, pageRect);
    if (rects.length) return rects.map(r => box(h, r)).join("");
    if (!h.box) return "";
    const [x, y] = vp.convertToViewportPoint(h.box.x, h.box.y);
    return box(h, { x, y: y - h.box.h * scale, w: h.box.w * scale, h: h.box.h * scale * 1.25 });
  }).join("");
}
const repaintHits = () => Doc.pages.forEach((_, i) => paintHits(i));

/* ---------------- annotations ----------------
   Everything is stored in PDF user space (points, unrotated page), so a mark
   stays on its word at any zoom, survives rotation, and needs no conversion at
   export. Screen ↔ page conversion is pdf.js's viewport, cached per page. */
const ANN = { tool: "hand", color: "#e2622a", size: 14, width: 2, sel: null };
let annSeq = 1;
const DRAW_TOOLS = ["draw", "box", "note", "text"];
const annPage = i => Doc.pages[i];

function setAnnTool(t) {
  ANN.tool = t;
  document.body.classList.toggle("drawing", DRAW_TOOLS.includes(t));
  document.body.classList.toggle("marking", t !== "hand");
  document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
  $("sbTool").textContent = { hand: "Hand", highlight: "Highlight", note: "Note", draw: "Draw", box: "Box", text: "Text" }[t] || t;
}
function addAnn(i, a) {
  const p = annPage(i);
  if (!p) return;
  (p.ann ||= []).push({ id: annSeq++, ...a });
  commit(`Add ${a.t}`);
  paintAnnots(i);
  renderAnnList();
}
function deleteAnn(id) {
  for (let i = 0; i < Doc.pages.length; i++) {
    const p = Doc.pages[i], k = (p.ann || []).findIndex(a => a.id === id);
    if (k >= 0) {
      p.ann.splice(k, 1);
      if (ANN.sel === id) ANN.sel = null;
      commit("Delete annotation");
      paintAnnots(i);
      renderAnnList();
      return;
    }
  }
}
const allAnnots = () => Doc.pages.flatMap((p, i) => (p.ann || []).map(a => ({ ...a, page: i })));

/* screen point → PDF point, using the viewport cached on the page element */
function pdfPointAt(el, clientX, clientY) {
  const vp = el.__vp;
  if (!vp) return null;
  const r = el.getBoundingClientRect();
  return vp.convertToPdfPoint(clientX - r.left, clientY - r.top);
}

async function paintAnnots(i) {
  const el = $("pages").children[i], p = Doc.pages[i];
  const host = el?.querySelector(".annl");
  if (!host || !p) return;
  const list = p.ann || [];
  if (!list.length && !host.childElementCount) return;
  const vp = el.__vp || (await viewportFor(p, viewerScale())).vp;
  host.setAttribute("width", vp.width);
  host.setAttribute("height", vp.height);
  host.style.width = vp.width + "px";
  host.style.height = vp.height + "px";
  const V = (x, y) => vp.convertToViewportPoint(x, y);
  const box = (x, y, w, h) => {                       // rect in page space → rect on screen
    const [x1, y1] = V(x, y), [x2, y2] = V(x + w, y + h);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  };
  const scale = viewerScale();
  host.innerHTML = list.map(a => {
    const on = a.id === ANN.sel ? " sel" : "";
    if (a.t === "highlight")
      return (a.quads || []).map(q => {
        const r = box(q.x, q.y, q.w, q.h);
        return `<rect class="ah${on}" data-id="${a.id}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${esc(a.color)}"/>`;
      }).join("");
    if (a.t === "box") {
      const r = box(a.x, a.y, a.w, a.h);
      return `<rect class="ab${on}" data-id="${a.id}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"
        fill="none" stroke="${esc(a.color)}" stroke-width="${a.sw * scale}"/>`;
    }
    if (a.t === "draw")
      return `<polyline class="ai${on}" data-id="${a.id}" fill="none" stroke="${esc(a.color)}"
        stroke-width="${a.sw * scale}" stroke-linecap="round" stroke-linejoin="round"
        points="${a.pts.map(([x, y]) => V(x, y).map(n => n.toFixed(1)).join(",")).join(" ")}"/>`;
    if (a.t === "text") {
      const [x, y] = V(a.x, a.y);
      return `<text class="at${on}" data-id="${a.id}" x="${x}" y="${y}" fill="${esc(a.color)}"
        font-size="${a.size * scale}" font-family="Helvetica, sans-serif">${esc(a.text)}</text>`;
    }
    if (a.t === "note") {
      const [x, y] = V(a.x, a.y), s = 15;
      return `<g class="an${on}" data-id="${a.id}" transform="translate(${x - s / 2},${y - s / 2})">
        <rect width="${s}" height="${s}" rx="3" fill="${esc(a.color)}"/>
        <path d="M3.5 5h8M3.5 8h6" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>
        <title>${esc(a.text)}</title></g>`;
    }
    return "";
  }).join("");
}
const repaintAnnots = () => Doc.pages.forEach((_, i) => paintAnnots(i));

/* highlight comes from a real text selection, so it lands on the glyphs */
function highlightSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed) return toast("Select some text first", "warn");
  const byPage = new Map();
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".pg");
    if (!el) continue;
    const i = +el.dataset.i;
    const a = pdfPointAt(el, r.left, r.top), b = pdfPointAt(el, r.right, r.bottom);
    if (!a || !b) continue;
    if (!byPage.has(i)) byPage.set(i, []);
    byPage.get(i).push({
      x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
      w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
    });
  }
  if (!byPage.size) return toast("Select some text first", "warn");
  for (const [i, quads] of byPage) addAnn(i, { t: "highlight", quads, color: ANN.color });
  sel.removeAllRanges();
  toast(`Highlighted on ${plural(byPage.size, "page")}`);
}

/* ---------------- collapsible panels ----------------
   Every side panel is an accordion. What is open, and whether a whole pane is
   folded away, is remembered per browser — the app comes back how you left it. */
const PANELS_KEY = "kiln-pdf-panels";
const panels = (() => { try { return JSON.parse(localStorage.getItem(PANELS_KEY)) || {}; } catch { return {}; } })();
const savePanels = () => { try { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); } catch { /* private mode */ } };
const shutBy = (id, dflt = false) => panels[id] ?? dflt;
const CHEV = `<svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="m6 9 6 6 6-6"/></svg>`;

/* one collapsible section of a panel */
function sec(id, title, body, { dflt = false, count = null, grow = false } = {}) {
  const shut = shutBy(id, dflt);
  // the badge stays in the DOM even when empty, so a toggle can fill it later
  return `<div class="sec${grow ? " grow" : ""}${shut ? " shut" : ""}" data-sec="${id}">
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
function foldPane(side, force) {
  const cls = "fold" + side;
  const on = force ?? !document.body.classList.contains(cls);
  document.body.classList.toggle(cls, on);
  panels[cls] = on; savePanels();
  if (Doc.fit) applyFit(); else repaint();
}
/* markup carries the default; a remembered choice wins */
function applyPanelState() {
  document.querySelectorAll(".sec[data-sec]").forEach(el => {
    const shut = shutBy(el.dataset.sec, el.classList.contains("shut"));
    el.classList.toggle("shut", shut);
    el.querySelector("[data-sec-h]")?.setAttribute("aria-expanded", String(!shut));
  });
  ["L", "R"].forEach(s => document.body.classList.toggle("fold" + s, !!panels["fold" + s]));
}

/* ---------------- panels ---------------- */
function renderHistory() {
  $("pHist").innerHTML = Hist.steps.map((s, i) =>
    `<button class="hstep${i === Hist.i ? " cur" : ""}${i > Hist.i ? " fut" : ""}" data-hi="${i}">${esc(s.label)}</button>`
  ).join("") || `<div class="empty">No history yet.</div>`;
}
function renderOutline() {
  const host = $("outline");
  const add = `<button class="rowbtn" data-act="bmAdd">+ Bookmark this page</button>`;
  if (!Doc.bookmarks.length) {
    host.innerHTML = `<div class="empty">No bookmarks yet.</div>${Doc.open ? add : ""}`;
    return;
  }
  host.innerHTML = Doc.bookmarks.map((b, k) =>
    `<div class="obm" style="padding-left:${8 + b.depth * 12}px">
      <button class="ot" data-bm="${k}" title="Go to page ${b.page + 1}">${esc(b.title)}</button>
      ${b.page >= 0 ? `<span class="op num">${b.page + 1}</span>` : ""}
      <button class="rowx" data-bm-ren="${k}" title="Rename">✎</button>
      <button class="rowx" data-bm-del="${k}" title="Delete">×</button>
    </div>`).join("") + add;
}
function renderProps() {
  const p = Doc.pages[Doc.cur - 1];
  const rows = [
    ["File", Doc.name || "—"],
    ["Pages", Doc.pages.length || "—"],
    ["Selected", Doc.sel.size],
    ["Size", Doc.open ? fmtB(Doc.size) : "—"],
    ["PDF version", Doc.ver || "—"],
    ["Sources", Doc.sources.length || "—"],
    ["Current page", Doc.open ? `${Doc.cur} of ${Doc.pages.length}` : "—", "kvCur"],
    ["Rotation", p ? p.rot + "°" : "—", "kvRot"],
  ];
  $("pInfo").innerHTML =
    sec("info", "Document", rows.map(([k, v, id]) =>
      `<div class="kv"><span>${k}</span><b${id ? ` id="${id}"` : ""}>${esc(v)}</b></div>`).join("")) +
    sec("meta", "Metadata — written on export",
      ["title", "author", "subject", "keywords"].map(f =>
        `<label class="fld"><span>${f[0].toUpperCase() + f.slice(1)}</span>
          <input class="txtin" data-meta="${f}" value="${esc(Doc.meta[f] || "")}" placeholder="—"></label>`).join(""));
  if (p) sizeRow(p);
}
/* page size needs an async page load, so it lands after the rest of the panel */
let sizeToken = 0;
async function sizeRow(p) {
  const token = ++sizeToken;
  const { vp } = await viewportFor(p, 1);
  if (token !== sizeToken) return;
  $("pInfo").querySelector(".kv.pgsize")?.remove();
  const row = document.createElement("div");
  row.className = "kv pgsize";
  row.innerHTML = `<span>Page size</span><b>${Math.round(vp.width)} × ${Math.round(vp.height)} pt</b>`;
  $("pInfo").querySelectorAll(".kv")[7]?.after(row);
}
function annListHtml() {
  const list = allAnnots();
  if (!list.length)
    return `<div class="note">Nothing yet. Pick Highlight, Note, Draw, Box or Text in the toolbar,
      then work on the page — everything you add is written into the exported file.</div>`;
  return list.map(a => `<div class="arow${a.id === ANN.sel ? " sel" : ""}">
    <button class="aj" data-ann="${a.id}" data-page="${a.page}">
      <span class="adot" style="background:${esc(a.color)}"></span>
      <span class="aty">${a.t}</span>
      <span class="atx">${esc(a.text || "")}</span>
      <span class="op num">p${a.page + 1}</span>
    </button>
    <button class="rowx" data-ann-del="${a.id}" title="Delete">×</button></div>`).join("");
}
function renderAnnList() {
  const host = $("annList");
  if (host) host.innerHTML = annListHtml();
  const badge = $("panels").querySelector('[data-sec="ann"] .sec-n');
  if (badge) badge.textContent = allAnnots().length || "";
}
function renderTools() {
  const e = Doc.effects;
  const onOff = v => v ? "on" : "";
  $("pTools").innerHTML =
    sec("ann", "Annotations", `<div id="annList">${annListHtml()}</div>`,
      { count: allAnnots().length || "" }) +
    sec("wm", "Watermark", `
      <label class="chk"><input type="checkbox" data-fx="watermark.on"${e.watermark.on ? " checked" : ""}> Apply watermark</label>
      <label class="fld"><span>Text</span><input class="txtin" data-fx="watermark.text" value="${esc(e.watermark.text)}"></label>
      <label class="fld"><span>Size</span><input type="range" min="10" max="160" step="2" data-fx="watermark.size" value="${e.watermark.size}"><b class="num">${e.watermark.size}pt</b></label>
      <label class="fld"><span>Angle</span><input type="range" min="-90" max="90" step="5" data-fx="watermark.angle" value="${e.watermark.angle}"><b class="num">${e.watermark.angle}°</b></label>
      <label class="fld"><span>Opacity</span><input type="range" min="2" max="100" step="2" data-fx="watermark.opacity" value="${Math.round(e.watermark.opacity * 100)}"><b class="num">${Math.round(e.watermark.opacity * 100)}%</b></label>
      <label class="fld"><span>Colour</span><input type="color" class="obcolor" data-fx="watermark.color" value="${e.watermark.color}"></label>`,
      { count: onOff(e.watermark.on) }) +
    sec("pn", "Page numbers", `
      <label class="chk"><input type="checkbox" data-fx="numbers.on"${e.numbers.on ? " checked" : ""}> Stamp page numbers</label>
      <label class="fld"><span>Format</span><select class="obsel" data-fx="numbers.format">
        ${["n", "Page n", "n of N"].map(f => `<option${e.numbers.format === f ? " selected" : ""}>${f}</option>`).join("")}</select></label>
      <label class="fld"><span>Position</span><select class="obsel" data-fx="numbers.pos">
        ${["bottom-center", "bottom-right", "bottom-left", "top-center", "top-right"].map(f => `<option${e.numbers.pos === f ? " selected" : ""}>${f}</option>`).join("")}</select></label>
      <label class="fld"><span>Start at</span><input class="txtin num" style="width:56px" type="number" min="1" data-fx="numbers.start" value="${e.numbers.start}"></label>
      <label class="chk"><input type="checkbox" data-fx="numbers.skipFirst"${e.numbers.skipFirst ? " checked" : ""}> Skip the first page</label>`,
      { count: onOff(e.numbers.on) }) +
    sec("api", "Needs the API",
      `<div class="note">Compression, password protection and unlocking rewrite the file with ghostscript
       and qpdf. They arrive with the PDF API (milestone M6); everything above runs entirely in this
       browser.</div>`, { dflt: true });
}

/* ---------------- status bar + full render ---------------- */
const status = s => { $("sbStatus").textContent = s; };
function syncStatus() {
  $("sbPages").textContent = Doc.pages.length || "—";
  $("sbSel").textContent = Doc.sel.size;
  $("sbSize").textContent = Doc.open ? fmtB(Doc.size) : "—";
  $("sbVer").textContent = Doc.ver || "—";
  $("pgTotal").textContent = Doc.pages.length;
  $("pgN").textContent = Doc.pages.length;
  $("zoomV").textContent = Math.round(Doc.zoom * 100) + "%";
  $("mUndo").setAttribute("aria-disabled", String(Hist.i <= 0));
  $("mRedo").setAttribute("aria-disabled", String(Hist.i >= Hist.steps.length - 1));
}
function renderAll() {
  buildViewer();
  buildThumbs();
  renderOutline();
  renderProps();
  renderTools();
  renderHistory();
  renderSelection();
  syncStatus();
}

/* ---------------- zoom ---------------- */
async function applyFit() {
  if (!Doc.fit || !Doc.pages.length) return;
  const p = Doc.pages[Doc.cur - 1] || Doc.pages[0];
  const { vp } = await viewportFor(p, 1);
  const box = $("vp").getBoundingClientRect();
  const z = Doc.fit === "width"
    ? (box.width - 68) / (vp.width * PT)
    : Math.min((box.width - 68) / (vp.width * PT), (box.height - 48) / (vp.height * PT));
  Doc.zoom = clamp(z, .1, 6);
  syncStatus();
  repaint();
}
function setZoom(z, keepFit = false) {
  if (!keepFit) Doc.fit = null;
  Doc.zoom = clamp(z, .1, 6);
  syncStatus();
  repaint();
}
const zoomStep = dir => {
  const z = Doc.zoom;
  const next = dir > 0 ? ZOOMS.find(v => v > z + .001) : [...ZOOMS].reverse().find(v => v < z - .001);
  setZoom(next ?? clamp(z * (dir > 0 ? 1.25 : .8), .1, 6));
};

/* ---------------- menus ---------------- */
const MENUS = {
  mFile: [
    ["Open PDF…", "open", "⌘O"], ["Load sample document", "sample"], null,
    ["Insert pages from PDF…", "insert"], ["Insert blank page", "blank"], null,
    ["Export PDF…", "export", "⌘E"], ["Export selected pages…", "exportSel"],
    ["Split into single pages…", "split"], ["Extract all text…", "exportTxt"], null,
    ["Print…", "print", "⌘P"], ["Close document", "close"],
  ],
  mEdit: [
    ["Undo", "undo", "⌘Z", "mUndo"], ["Redo", "redo", "⇧⌘Z", "mRedo"], null,
    ["Select all pages", "selAll", "⌘A"], ["Deselect", "selNone", "⌘D"], null,
    ["Delete selected pages", "del", "⌫"], ["Duplicate selected pages", "dup", "⌘J"],
  ],
  mDoc: [
    ["Rotate right", "rotR", "⌘]"], ["Rotate left", "rotL", "⌘["], null,
    ["Move selection up", "moveUp"], ["Move selection down", "moveDown"], null,
    ["Highlight selected text", "annHi", "⌘⇧H"], ["Add a note", "annNote"], ["Draw", "annDraw"],
    ["Bookmark this page", "bmAdd", "⌘B"], null,
    ["Watermark…", "toolsWm"], ["Page numbers…", "toolsPn"], ["Metadata…", "toolsMeta"],
  ],
  mView: [
    ["Zoom in", "zin", "⌘+"], ["Zoom out", "zout", "⌘−"], ["Actual size", "z100", "⌘1"],
    ["Fit width", "fitW", "⌘2"], ["Fit page", "fitP", "⌘3"], null,
    ["Next page", "next", "→"], ["Previous page", "prev", "←"], null,
    ["Toggle panels", "panels", "⇥"],
  ],
};
function buildMenus() {
  for (const [id, items] of Object.entries(MENUS)) {
    $(id).innerHTML = items.map(it => it === null ? `<div class="msep"></div>`
      : `<button class="mi" data-act="${it[1]}"${it[3] ? ` id="${it[3]}"` : ""}>${esc(it[0])}${it[2] ? `<span class="sc">${it[2]}</span>` : ""}</button>`).join("");
  }
}

/* ---------------- actions ---------------- */
const ACT = {
  open: () => $("fileMain").click(),
  sample: async () => { try { await openBytes(await sampleBytes(), "kiln-sample.pdf"); } catch (e) { toast("Sample failed: " + e.message, "bad"); } },
  insert: () => $("fileAdd").click(),
  blank: () => Doc.open && insertBlank(),
  export: exportAll,
  exportSel: exportSelection,
  split: splitAll,
  exportTxt: exportText,
  print: printDoc,
  bmAdd: addBookmark,
  annHi: highlightSelection,
  annNote: () => setAnnTool("note"),
  annDraw: () => setAnnTool("draw"),
  close: () => { resetDoc(); Doc.open = false; Doc.name = ""; Hist.steps = []; Hist.i = -1; $("dz").hidden = false; renderAll(); status("Ready"); },
  undo, redo,
  selAll: () => { Doc.pages.forEach((_, i) => Doc.sel.add(i)); renderSelection(); },
  selNone: () => { Doc.sel.clear(); renderSelection(); },
  del: () => deletePages(selected()),
  dup: () => duplicatePages(selected()),
  rotR: () => rotatePages(target(), 90),
  rotL: () => rotatePages(target(), -90),
  moveUp: () => { const l = selected(); if (l.length) movePages(l, Math.max(0, l[0] - 1)); },
  moveDown: () => { const l = selected(); if (l.length) movePages(l, Math.min(Doc.pages.length, l[l.length - 1] + 2)); },
  toolsWm: () => { showPanel("pTools"); focusFx("watermark.on"); },
  toolsPn: () => { showPanel("pTools"); focusFx("numbers.on"); },
  toolsMeta: () => { showPanel("pInfo"); $("panels").querySelector('[data-meta="title"]')?.focus(); },
  zin: () => zoomStep(1), zout: () => zoomStep(-1),
  z100: () => setZoom(1), fitW: () => { Doc.fit = "width"; applyFit(); }, fitP: () => { Doc.fit = "page"; applyFit(); },
  next: () => setCurrent(Doc.cur + 1, true), prev: () => setCurrent(Doc.cur - 1, true),
  panels: () => document.body.classList.toggle("nopanels"),
};
const act = k => ACT[k]?.();
function showPanel(id) {
  document.querySelectorAll(".ptab").forEach(t => t.classList.toggle("on", t.dataset.pt === id));
  document.querySelectorAll(".pbody").forEach(b => b.classList.toggle("on", b.id === id));
}
function focusFx(path) {
  const el = $("panels").querySelector(`[data-fx="${path}"]`);
  if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); }
  el?.focus();
}

/* ---------------- wiring ---------------- */
function wire() {
  buildMenus();

  // menu bar open/close
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
    if (mi?.dataset.act) { act(mi.dataset.act); }
    if (!e.target.closest("[data-menu]") || mi) document.querySelectorAll("[data-menu]").forEach(x => x.classList.remove("open"));
    const tb = e.target.closest("[data-act]:not(.mi)");
    if (tb) act(tb.dataset.act);
  });

  // panel tabs, collapsible sections, folding a whole pane away
  document.querySelectorAll(".ptab").forEach(t => t.addEventListener("click", () => showPanel(t.dataset.pt)));
  document.addEventListener("click", e => {
    const h = e.target.closest("[data-sec-h]");            // delegated: panels re-render constantly
    if (h) toggleSec(h.closest(".sec"));
    const f = e.target.closest("[data-fold]");
    if (f) foldPane(f.dataset.fold);
  });

  // drop zone + file inputs
  const dz = $("dz");
  // the whole zone opens the picker, except where a button already owns the click
  dz.addEventListener("click", e => { if (!e.target.closest("button")) $("fileMain").click(); });
  dz.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") $("fileMain").click(); });
  $("fileMain").addEventListener("change", e => { openFile(e.target.files[0]); e.target.value = ""; });
  $("fileAdd").addEventListener("change", e => { insertFiles([...e.target.files]); e.target.value = ""; });
  ["dragenter", "dragover"].forEach(ev => $("stage").addEventListener(ev, e => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => $("stage").addEventListener(ev, () => dz.classList.remove("over")));
  $("stage").addEventListener("drop", e => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    Doc.open ? insertFiles(files) : openFile(files[0]);
  });

  // thumbnails: select, jump, drag to reorder
  const thumbs = $("thumbs");
  thumbs.addEventListener("click", e => {
    const th = e.target.closest(".th");
    if (th) selectPage(+th.dataset.i, e);
  });
  thumbs.addEventListener("dblclick", e => {
    const th = e.target.closest(".th");
    if (th) setCurrent(+th.dataset.i + 1, true);
  });
  let dragFrom = null;
  thumbs.addEventListener("dragstart", e => {
    const th = e.target.closest(".th");
    if (!th) return;
    dragFrom = +th.dataset.i;
    if (!Doc.sel.has(dragFrom)) { Doc.sel.clear(); Doc.sel.add(dragFrom); renderSelection(); }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(dragFrom));
  });
  thumbs.addEventListener("dragover", e => {
    e.preventDefault();
    const th = e.target.closest(".th");
    thumbs.querySelectorAll(".th").forEach(x => x.classList.remove("drop-b", "drop-a"));
    if (!th) return;
    const r = th.getBoundingClientRect();
    th.classList.add(e.clientY < r.top + r.height / 2 ? "drop-b" : "drop-a");
  });
  thumbs.addEventListener("drop", e => {
    e.preventDefault();
    const th = e.target.closest(".th");
    thumbs.querySelectorAll(".th").forEach(x => x.classList.remove("drop-b", "drop-a"));
    if (!th || dragFrom === null) return;
    const r = th.getBoundingClientRect();
    const to = +th.dataset.i + (e.clientY < r.top + r.height / 2 ? 0 : 1);
    movePages(selected().length ? selected() : [dragFrom], to);
    dragFrom = null;
  });

  // viewer page click selects that page (not while an annotation tool is armed)
  $("pages").addEventListener("click", e => {
    const pg = e.target.closest(".pg");
    if (pg && ANN.tool === "hand") selectPage(+pg.dataset.i, e);
  });

  // annotation tools
  document.querySelectorAll("[data-tool]").forEach(b => b.addEventListener("click", () => {
    setAnnTool(b.dataset.tool);
    if (b.dataset.tool === "highlight" && !getSelection().isCollapsed) highlightSelection();
  }));
  $("annColor").addEventListener("input", e => { ANN.color = e.target.value; });
  document.addEventListener("mouseup", () => {
    if (ANN.tool === "highlight" && !getSelection().isCollapsed) setTimeout(highlightSelection, 0);
  });
  $("pages").addEventListener("pointerdown", e => {
    if (!DRAW_TOOLS.includes(ANN.tool) || e.button !== 0) return;
    const el = e.target.closest(".pg");
    const start = el && pdfPointAt(el, e.clientX, e.clientY);
    if (!start) return;
    e.preventDefault();
    const i = +el.dataset.i;

    if (ANN.tool === "note" || ANN.tool === "text") {
      const what = ANN.tool === "note" ? "Note text" : "Text to place on the page";
      const text = prompt(what, "");
      if (text?.trim()) {
        addAnn(i, ANN.tool === "note"
          ? { t: "note", x: start[0], y: start[1], text: text.trim(), color: ANN.color }
          : { t: "text", x: start[0], y: start[1], text: text.trim(), size: ANN.size, color: ANN.color });
      }
      setAnnTool("hand");
      return;
    }

    // draw + box: live preview straight into the page's own annotation list
    const draft = ANN.tool === "draw"
      ? { id: 0, t: "draw", pts: [start], sw: ANN.width, color: ANN.color }
      : { id: 0, t: "box", x: start[0], y: start[1], w: 0, h: 0, sw: ANN.width, color: ANN.color };
    const p = Doc.pages[i];
    (p.ann ||= []).push(draft);
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      const q = pdfPointAt(el, ev.clientX, ev.clientY);
      if (!q) return;
      if (draft.t === "draw") draft.pts.push(q);
      else { draft.w = q[0] - draft.x; draft.h = q[1] - draft.y; }
      paintAnnots(i);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      p.ann.pop();
      const big = draft.t === "draw" ? draft.pts.length > 2 : Math.abs(draft.w) > 3 && Math.abs(draft.h) > 3;
      if (big) {
        if (draft.t === "box") {                      // normalise so width/height are positive
          if (draft.w < 0) { draft.x += draft.w; draft.w = -draft.w; }
          if (draft.h < 0) { draft.y += draft.h; draft.h = -draft.h; }
        }
        delete draft.id;
        addAnn(i, draft);
      } else paintAnnots(i);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
  // clicking a note or mark selects it in the list
  $("pages").addEventListener("click", e => {
    const t = e.target.closest("[data-id]");
    if (!t) return;
    ANN.sel = +t.dataset.id;
    repaintAnnots();
    renderAnnList();
    showPanel("pTools");
  });

  // bookmarks: jump, rename, delete
  $("outline").addEventListener("click", e => {
    const go = e.target.closest("[data-bm]"), ren = e.target.closest("[data-bm-ren]"), del = e.target.closest("[data-bm-del]");
    if (ren) return renameBookmark(+ren.dataset.bmRen);
    if (del) return deleteBookmark(+del.dataset.bmDel);
    if (go) {
      const p = Doc.bookmarks[+go.dataset.bm]?.page;
      if (p >= 0) setCurrent(p + 1, true); else toast("That bookmark has no page", "warn");
    }
  });
  // annotation list: jump to one, or delete it
  $("panels").addEventListener("click", e => {
    const del = e.target.closest("[data-ann-del]"), go = e.target.closest("[data-ann]");
    if (del) return deleteAnn(+del.dataset.annDel);
    if (go) {
      ANN.sel = +go.dataset.ann;
      setCurrent(+go.dataset.page + 1, true);
      repaintAnnots();
      renderAnnList();
    }
  });
  $("pHist").addEventListener("click", e => {
    const b = e.target.closest(".hstep");
    if (b) restore(+b.dataset.hi);
  });
  $("pSearch").addEventListener("click", e => {
    const b = e.target.closest(".hit");
    if (b) gotoHit(+b.dataset.h);
  });

  // page number + zoom controls
  $("pgNum").addEventListener("change", () => setCurrent(parseInt($("pgNum").value) || 1, true));
  $("vp").addEventListener("wheel", e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(Doc.zoom * (e.deltaY < 0 ? 1.1 : .9));
  }, { passive: false });

  // search box
  let searchT;
  $("search").addEventListener("input", e => {
    clearTimeout(searchT);
    const q = e.target.value.trim();
    searchT = setTimeout(() => { showPanel("pSearch"); runSearch(q); }, 260);
  });
  $("search").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); hits.length ? gotoHit(hitI + (e.shiftKey ? -1 : 1)) : runSearch(e.target.value.trim()); }
    if (e.key === "Escape") { e.target.value = ""; hits = []; renderHits(""); }
  });

  // tool + metadata fields (delegated — panels are re-rendered often)
  $("panels").addEventListener("input", e => {
    const fx = e.target.dataset.fx, meta = e.target.dataset.meta;
    if (fx) applyFx(fx, e.target, false);
    if (meta) Doc.meta[meta] = e.target.value;
  });
  $("panels").addEventListener("change", e => {
    const fx = e.target.dataset.fx, meta = e.target.dataset.meta;
    if (fx) applyFx(fx, e.target, true);
    if (meta) commit("Metadata");
  });

  // keyboard
  addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const M = e.metaKey || e.ctrlKey;
    if (M && e.key.toLowerCase() === "f") { e.preventDefault(); $("search").focus(); $("search").select(); return; }
    if (typing) return;
    if (M && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (M && e.key.toLowerCase() === "o") { e.preventDefault(); act("open"); return; }
    if (M && e.key.toLowerCase() === "e") { e.preventDefault(); act("export"); return; }
    if (M && e.key.toLowerCase() === "a") { e.preventDefault(); act("selAll"); return; }
    if (M && e.key.toLowerCase() === "d") { e.preventDefault(); act("selNone"); return; }
    if (M && e.key.toLowerCase() === "j") { e.preventDefault(); act("dup"); return; }
    if (M && (e.key === "=" || e.key === "+")) { e.preventDefault(); act("zin"); return; }
    if (M && e.key === "-") { e.preventDefault(); act("zout"); return; }
    if (M && e.key === "1") { e.preventDefault(); act("z100"); return; }
    if (M && e.key === "2") { e.preventDefault(); act("fitW"); return; }
    if (M && e.key === "3") { e.preventDefault(); act("fitP"); return; }
    if (M && e.key === "]") { e.preventDefault(); act("rotR"); return; }
    if (M && e.key === "[") { e.preventDefault(); act("rotL"); return; }
    if (M && e.key.toLowerCase() === "p") { e.preventDefault(); act("print"); return; }
    if (M && e.key.toLowerCase() === "b") { e.preventDefault(); act("bmAdd"); return; }
    if (M && e.shiftKey && e.key.toLowerCase() === "h") { e.preventDefault(); highlightSelection(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // an armed annotation takes the keystroke; otherwise it means the pages
      ANN.sel ? deleteAnn(ANN.sel) : act("del");
      return;
    }
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); act("next"); return; }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); act("prev"); return; }
    if (e.key === "Tab") { e.preventDefault(); act("panels"); return; }
    if (e.key === "Escape") {
      if (ANN.tool !== "hand" || ANN.sel) { setAnnTool("hand"); ANN.sel = null; repaintAnnots(); renderAnnList(); return; }
      Doc.sel.clear(); renderSelection();
    }
  });

  // panel splitter
  const split = $("splitL");
  split.addEventListener("pointerdown", e => {
    split.setPointerCapture(e.pointerId);
    const move = ev => {
      const w = clamp(ev.clientX - $("app").getBoundingClientRect().left - 44, 130, 420);
      document.body.style.setProperty("--lw", w + "px");
    };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); repaint(); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });

  addEventListener("resize", () => { if (Doc.fit) applyFit(); });
  renderAll();
  applyPanelState();
  status("Ready");
}

function applyFx(path, input, isChange) {
  const [group, key] = path.split(".");
  let v = input.type === "checkbox" ? input.checked
    : input.type === "range" || input.type === "number" ? Number(input.value) : input.value;
  if (key === "opacity") v = v / 100;
  Doc.effects[group][key] = v;
  // live preview only redraws overlays — no page re-rasterising
  [...$("pages").children].forEach(async (el, i) => {
    const { vp } = await viewportFor(Doc.pages[i], viewerScale());
    drawOverlay(el, i, vp);
  });
  const b = input.parentElement.querySelector("b");
  if (b) b.textContent = key === "opacity" ? Math.round(v * 100) + "%" : key === "angle" ? v + "°" : v + "pt";
  // the section header says "on" even when the section is collapsed
  const badge = $("panels").querySelector(`[data-sec="${group === "watermark" ? "wm" : "pn"}"] .sec-n`);
  if (badge) badge.textContent = Doc.effects[group].on ? "on" : "";
  if (isChange) commit(group === "watermark" ? "Watermark" : "Page numbers");
}

wire();

/* Read a PDF back with pdf.js — what the tests assert against, and a handy
   console tool for checking what actually landed in an exported file. */
async function inspect(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes).slice(), standardFontDataUrl: STD_FONTS, isEvalSupported: false,
  });
  const doc = await task.promise;
  const out = {
    pages: doc.numPages, rotations: [], text: [], annots: [], outline: [],
    info: (await doc.getMetadata()).info,
  };
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    out.rotations.push(p.rotate);
    out.text.push((await p.getTextContent()).items.map(x => x.str).join(" "));
    for (const a of await p.getAnnotations())
      out.annots.push({ page: i - 1, subtype: a.subtype, contents: a.contentsObj?.str ?? a.contents ?? "" });
  }
  const walk = (items, depth) => items.forEach(it => {
    out.outline.push({ title: it.title, depth });
    if (it.items?.length) walk(it.items, depth + 1);
  });
  walk((await doc.getOutline()) || [], 0);
  await task.destroy();
  return out;
}

/* test + console handle — the app is a module, so nothing leaks to globals by accident */
window.Kiln = {
  inspect,
  Doc, Hist, act, openBytes, sampleBytes, buildPdf, movePages, rotatePages,
  deletePages, duplicatePages, runSearch, hits: () => hits, setZoom, setCurrent,
  selectPage, textOf, exportAll, thumbCache, pageKey,
  panels, toggleSec, foldPane,
  ANN, setAnnTool, addAnn, deleteAnn, allAnnots, highlightSelection,
  addBookmark, deleteBookmark, printDoc,
  ready: () => !pending.size && !draining,
};
