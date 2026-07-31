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
import { PDFDocument, StandardFonts, degrees, rgb } from "./vendor/pdf-lib.mjs";

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
  pages: [],            // { sid, idx, rot }         — the edit list; rot is absolute (0/90/180/270)
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
  pages: Doc.pages.map(p => ({ ...p })),
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
  Doc.pages = s.pages.map(p => ({ ...p }));
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
  for (let i = 0; i < src.doc.numPages; i++) out.push({ sid: src.id, idx: i, rot: rotFrom?.[i] ?? 0 });
  return out;
}
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

/* ---------------- outline ---------------- */
async function loadOutline(src) {
  Doc.outline = [];
  try {
    const raw = await src.doc.getOutline();
    if (!raw) return;
    const walk = async (items, depth) => {
      for (const it of items) {
        let idx = null;
        try {
          const dest = typeof it.dest === "string" ? await src.doc.getDestination(it.dest) : it.dest;
          if (dest?.[0]) idx = await src.doc.getPageIndex(dest[0]);
        } catch { /* unresolvable destination — still show the title */ }
        Doc.outline.push({ title: it.title, sid: src.id, idx, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(raw, 0);
  } catch { /* no outline */ }
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
    drawOverlay(el, i, vp);
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
    drawOverlay(el, i, vp);
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
  Doc.pages.forEach((p, i) => { out.push(p); if (list.includes(i)) out.push({ ...p }); });
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

  await applyEffects(out, list);

  const m = Doc.meta;
  if (m.title) out.setTitle(m.title);
  if (m.author) out.setAuthor(m.author);
  if (m.subject) out.setSubject(m.subject);
  if (m.keywords) out.setKeywords(m.keywords.split(/\s*,\s*/).filter(Boolean));
  out.setProducer("Kiln");
  out.setModificationDate(new Date());
  return out.save();
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
function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

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
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    items.push({ str: it.str, at: text.length, tr: it.transform, w: it.width, h: it.height });
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

/* Every match stays highlighted while the search is live — the box comes from
   the text run's own transform, so it lands on the glyphs at any zoom. */
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
  host.innerHTML = list.filter(h => h.box).map(h => {
    const [x, y] = vp.convertToViewportPoint(h.box.x, h.box.y);
    return `<div class="hitmark${h.k === hitI ? " on" : ""}" data-k="${h.k}"
      style="left:${x}px;top:${y - h.box.h * scale}px;width:${Math.max(6, h.box.w * scale)}px;height:${h.box.h * scale * 1.25}px"></div>`;
  }).join("");
}
const repaintHits = () => Doc.pages.forEach((_, i) => paintHits(i));

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
  const items = (Doc.outline || []).filter(o => o.title);
  if (!items.length) { host.innerHTML = `<div class="empty">This document has no bookmarks.</div>`; return; }
  host.innerHTML = items.map((o, k) => {
    const slot = o.idx === null ? -1 : Doc.pages.findIndex(p => p.sid === o.sid && p.idx === o.idx);
    return `<button class="obm" data-o="${k}" data-slot="${slot}" style="padding-left:${8 + o.depth * 12}px">
      <span class="ot">${esc(o.title)}</span>${slot >= 0 ? `<span class="op num">${slot + 1}</span>` : ""}</button>`;
  }).join("");
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
function renderTools() {
  const e = Doc.effects;
  const onOff = v => v ? "on" : "";
  $("pTools").innerHTML =
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
    ["Close document", "close"],
  ],
  mEdit: [
    ["Undo", "undo", "⌘Z", "mUndo"], ["Redo", "redo", "⇧⌘Z", "mRedo"], null,
    ["Select all pages", "selAll", "⌘A"], ["Deselect", "selNone", "⌘D"], null,
    ["Delete selected pages", "del", "⌫"], ["Duplicate selected pages", "dup", "⌘J"],
  ],
  mDoc: [
    ["Rotate right", "rotR", "⌘]"], ["Rotate left", "rotL", "⌘["], null,
    ["Move selection up", "moveUp"], ["Move selection down", "moveDown"], null,
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

  // viewer page click selects that page
  $("pages").addEventListener("click", e => {
    const pg = e.target.closest(".pg");
    if (pg) selectPage(+pg.dataset.i, e);
  });

  // outline + history + search result lists
  $("outline").addEventListener("click", e => {
    const b = e.target.closest(".obm");
    if (b && +b.dataset.slot >= 0) setCurrent(+b.dataset.slot + 1, true);
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
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); act("del"); return; }
    if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); act("next"); return; }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); act("prev"); return; }
    if (e.key === "Tab") { e.preventDefault(); act("panels"); return; }
    if (e.key === "Escape") { Doc.sel.clear(); renderSelection(); }
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
  const out = { pages: doc.numPages, rotations: [], text: [], info: (await doc.getMetadata()).info };
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    out.rotations.push(p.rotate);
    out.text.push((await p.getTextContent()).items.map(x => x.str).join(" "));
  }
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
  ready: () => !pending.size && !draining,
};
